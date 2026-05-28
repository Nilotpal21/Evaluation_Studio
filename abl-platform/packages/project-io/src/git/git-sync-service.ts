/**
 * Git Sync Service — orchestrates push/pull using the export/import pipeline
 *
 * Coordinates between the GitProvider, export/import services, and
 * conflict resolution to sync project state with a git repository.
 */

import type { GitProvider } from './git-provider.js';
import type {
  GitFile,
  Committer,
  ChangesSummary,
  ConflictDetail,
  ConflictStrategy,
} from '../types.js';
import { exportProject, type ProjectData } from '../export/project-exporter.js';
import { importProject, type ExistingProjectState } from '../import/project-importer.js';
import { checkConflicts, autoResolveConflicts, type ThreeWayInput } from './conflict-resolver.js';
import {
  GitCircuitBreaker,
  GitCircuitBreakerError,
  type GitCircuitBreakerConfig,
} from './git-circuit-breaker.js';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('git-sync-service');

const ABL_CONTROL_FILE_PATHS = new Set(['project.json', 'abl.lock']);
const LOCKFILE_V2_PATH_SECTIONS = [
  'tools',
  'configs',
  'connections',
  'guardrails',
  'workflows',
  'evals',
  'search',
  'channels',
  'vocabulary',
] as const;

export interface SyncResult {
  success: boolean;
  commitSha: string | null;
  changes: ChangesSummary;
  conflicts: ConflictDetail[];
  error?: { code: string; message: string };
}

export interface PushOptions {
  projectData?: ProjectData;
  projectFiles?: Map<string, string>;
  userId: string;
  tenantId: string;
  branch: string;
  commitMessage: string;
  committer: Committer;
  lastSyncCommit: string | null;
  createPR?: { title: string; description: string; targetBranch: string };
  /** Conflict resolution strategy. Default: 'manual' (return conflicts to caller). */
  conflictStrategy?: ConflictStrategy;
  /** Repository subdirectory used for project files. Defaults to repository root. */
  syncPath?: string;
}

export interface PullOptions {
  projectId: string;
  userId: string;
  tenantId: string;
  branch: string;
  existingState: ExistingProjectState;
  lastSyncCommit: string | null;
  /** Repository subdirectory used for project files. Defaults to repository root. */
  syncPath?: string;
}

export interface PullProjectFilesResult {
  branch: string;
  commitSha: string | null;
  files: Map<string, string>;
}

function normalizeSyncPath(syncPath: string | null | undefined): string {
  const raw = (syncPath ?? '/').trim();
  if (!raw || raw === '/') {
    return '/';
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new Error('Invalid syncPath: malformed encoding');
  }

  const withoutEdgeSlashes = decoded.replace(/^\/+|\/+$/g, '');
  if (!withoutEdgeSlashes || withoutEdgeSlashes.includes('//')) {
    throw new Error('Invalid syncPath: must be a relative repository directory');
  }

  const segments = withoutEdgeSlashes.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Invalid syncPath: traversal segments are not allowed');
  }

  return segments.length > 0 ? segments.join('/') : '/';
}

function toProviderSyncPath(syncPath: string): string | undefined {
  return syncPath === '/' ? undefined : syncPath;
}

function normalizeProjectPath(path: string): string {
  return path.replace(/^\/+/, '');
}

function toRepositoryProjectPath(path: string, syncPath: string): string {
  const canonicalPath = normalizeProjectPath(path);
  if (syncPath === '/') {
    return canonicalPath;
  }
  return `${syncPath}/${canonicalPath}`;
}

function toCanonicalProjectPath(path: string, syncPath: string): string {
  const repositoryPath = normalizeProjectPath(path);
  if (syncPath === '/') {
    return repositoryPath;
  }
  const prefix = `${syncPath}/`;
  return repositoryPath.startsWith(prefix) ? repositoryPath.slice(prefix.length) : repositoryPath;
}

function isRepositoryPathWithinSyncPath(path: string, syncPath: string): boolean {
  if (syncPath === '/') {
    return true;
  }
  const repositoryPath = normalizeProjectPath(path);
  return repositoryPath.startsWith(`${syncPath}/`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonRecord(content: string | undefined): Record<string, unknown> | null {
  if (!content) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(content);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function addManifestPathRecords(managedPaths: Set<string>, section: unknown, field: 'path'): void {
  if (!isRecord(section)) {
    return;
  }

  for (const entry of Object.values(section)) {
    if (isRecord(entry) && typeof entry[field] === 'string') {
      managedPaths.add(normalizeProjectPath(entry[field]));
    }
  }
}

function collectManagedPathsFromRemoteMetadata(remoteByPath: Map<string, string>): Set<string> {
  const managedPaths = new Set<string>(ABL_CONTROL_FILE_PATHS);
  const manifest = parseJsonRecord(remoteByPath.get('project.json'));
  if (manifest) {
    addManifestPathRecords(managedPaths, manifest.agents, 'path');
    addManifestPathRecords(managedPaths, manifest.tools, 'path');
    addManifestPathRecords(managedPaths, manifest.behavior_profiles, 'path');
  }

  const lockfile = parseJsonRecord(remoteByPath.get('abl.lock'));
  if (lockfile?.lockfile_version === '2.0') {
    for (const sectionName of LOCKFILE_V2_PATH_SECTIONS) {
      const section = lockfile[sectionName];
      if (!isRecord(section)) {
        continue;
      }
      for (const path of Object.keys(section)) {
        managedPaths.add(normalizeProjectPath(path));
      }
    }
  }

  return managedPaths;
}

async function fetchBaseContent(
  provider: GitProvider,
  lastSyncCommit: string,
  path: string,
  syncPath: string,
  baseContentCache: Map<string, string | null>,
): Promise<string | null> {
  if (baseContentCache.has(path)) {
    return baseContentCache.get(path) ?? null;
  }

  let baseContent: string | null = null;
  try {
    const baseFile = await provider.getFile(
      lastSyncCommit,
      toRepositoryProjectPath(path, syncPath),
    );
    baseContent = baseFile?.content ?? null;
  } catch (error) {
    log.warn('Failed to fetch base content at lastSyncCommit — falling back to two-way', {
      path,
      lastSyncCommit,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  baseContentCache.set(path, baseContent);
  return baseContent;
}

export class GitSyncService {
  private readonly breaker: GitCircuitBreaker;

  constructor(
    private readonly provider: GitProvider,
    circuitBreakerConfig?: Partial<GitCircuitBreakerConfig>,
  ) {
    this.breaker = new GitCircuitBreaker(circuitBreakerConfig);
  }

  /**
   * Push local project state to the git repository.
   */
  async push(options: PushOptions): Promise<SyncResult> {
    const {
      projectData,
      projectFiles,
      userId,
      tenantId,
      branch,
      commitMessage,
      committer,
      lastSyncCommit,
      createPR,
    } = options;
    const syncPath = normalizeSyncPath(options.syncPath);

    let exportedFiles: Map<string, string>;
    if (projectFiles) {
      exportedFiles = new Map(projectFiles);
    } else {
      if (!projectData) {
        throw new Error('Git sync push requires projectData or projectFiles');
      }

      // Git sync always uses 'yaml' dslFormat for deterministic file paths —
      // remote repositories expect a stable canonical format regardless of the
      // agent's source DSL dialect.
      const exportResult = exportProject(projectData, {
        projectId: 'sync',
        userId,
        tenantId,
        format: 'folder',
        dslFormat: 'yaml',
      });

      if (!exportResult.success) {
        return {
          success: false,
          commitSha: null,
          changes: { added: [], modified: [], deleted: [] },
          conflicts: [],
          error: exportResult.error,
        };
      }

      exportedFiles = exportResult.files;
    }

    // Get current remote state for conflict detection
    let remoteFiles: GitFile[] = [];
    try {
      const pullResult = await this.breaker.execute(() =>
        this.provider.pullProject(branch, toProviderSyncPath(syncPath)),
      );
      remoteFiles = pullResult.files
        .filter((file) => isRepositoryPathWithinSyncPath(file.path, syncPath))
        .map((file) => ({
          ...file,
          path: toCanonicalProjectPath(file.path, syncPath),
        }));
    } catch (error) {
      if (error instanceof GitCircuitBreakerError) {
        throw error;
      }
      log.warn('Failed to pull remote files — repository may be empty, proceeding with push', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Conflict detection if we have a last sync point
    if (lastSyncCommit && remoteFiles.length > 0) {
      const remoteMap = new Map(remoteFiles.map((f) => [f.path, f.content]));
      const threeWayInputs: ThreeWayInput[] = [];
      const deletionConflictFiles = new Set<string>();

      // Fetch base content at last sync commit for true three-way merge.
      // Without the base, every difference between local and remote is treated as a
      // conflict because checkConflict cannot determine which side changed.
      const baseContentCache = new Map<string, string | null>();
      for (const [path, localContent] of exportedFiles) {
        const remoteContent = remoteMap.get(path);
        if (remoteContent !== undefined && remoteContent !== localContent) {
          const baseContent = await fetchBaseContent(
            this.provider,
            lastSyncCommit,
            path,
            syncPath,
            baseContentCache,
          );

          threeWayInputs.push({
            file: path,
            agentName: extractAgentNameFromPath(path),
            base: baseContent,
            ours: localContent,
            theirs: remoteContent,
          });
        }
      }

      const remoteManagedPaths = collectManagedPathsFromRemoteMetadata(remoteMap);
      const deletedManagedPaths = [...remoteMap.keys()].filter(
        (path) => !exportedFiles.has(path) && remoteManagedPaths.has(path),
      );
      for (const path of deletedManagedPaths) {
        const remoteContent = remoteMap.get(path);
        if (remoteContent === undefined) {
          continue;
        }
        const baseContent = await fetchBaseContent(
          this.provider,
          lastSyncCommit,
          path,
          syncPath,
          baseContentCache,
        );
        if (baseContent !== remoteContent) {
          threeWayInputs.push({
            file: path,
            agentName: extractAgentNameFromPath(path),
            base: baseContent,
            ours: '',
            theirs: remoteContent,
          });
          deletionConflictFiles.add(path);
        }
      }

      if (threeWayInputs.length > 0) {
        const { resolved: autoResolved, conflicts } = checkConflicts(threeWayInputs);
        if (conflicts.length > 0) {
          const strategy = options.conflictStrategy ?? 'manual';
          if (strategy === 'manual') {
            return {
              success: false,
              commitSha: null,
              changes: { added: [], modified: [], deleted: [] },
              conflicts,
              error: {
                code: 'SYNC_CONFLICT',
                message: `${conflicts.length} file(s) have conflicts that must be resolved`,
              },
            };
          }

          // Auto-resolve using configured strategy
          const resolutions = autoResolveConflicts(conflicts, strategy);
          log.info('Auto-resolved push conflicts', {
            strategy,
            count: resolutions.length,
            files: resolutions.map((r) => r.file),
          });

          for (const resolution of resolutions) {
            if (deletionConflictFiles.has(resolution.file) && resolution.resolution === 'local') {
              exportedFiles.delete(resolution.file);
              continue;
            }
            if (resolution.mergedContent !== undefined) {
              exportedFiles.set(resolution.file, resolution.mergedContent);
            }
          }
        }

        // Apply auto-resolved files from three-way merge (accept_theirs / keep_ours)
        for (const res of autoResolved) {
          exportedFiles.set(res.file, res.content);
        }
      }
    }

    // Push files
    const gitFiles: GitFile[] = [];
    for (const [path, content] of exportedFiles) {
      gitFiles.push({ path: toRepositoryProjectPath(path, syncPath), content });
    }
    const remoteByPath = new Map(remoteFiles.map((f) => [f.path, f.content]));
    const remoteManagedPaths = collectManagedPathsFromRemoteMetadata(remoteByPath);
    const localPathSet = new Set(exportedFiles.keys());
    const deletedPaths = [...remoteByPath.keys()].filter(
      (p) => !localPathSet.has(p) && remoteManagedPaths.has(p),
    );
    const deletedRepositoryPaths = deletedPaths.map((path) =>
      toRepositoryProjectPath(path, syncPath),
    );

    let targetBranch = branch;
    let prBranchCreated: string | null = null;
    if (createPR) {
      const prBranch = `abl-sync/${Date.now()}`;
      await this.breaker.execute(() => this.provider.createBranch(prBranch, branch));
      prBranchCreated = prBranch;
      targetBranch = prBranch;
    }

    try {
      const pushResult = await this.breaker.execute(() =>
        deletedRepositoryPaths.length > 0
          ? this.provider.pushFiles(targetBranch, gitFiles, commitMessage, committer, {
              deletedPaths: deletedRepositoryPaths,
            })
          : this.provider.pushFiles(targetBranch, gitFiles, commitMessage, committer),
      );

      if (createPR) {
        await this.breaker.execute(() =>
          this.provider.createPullRequest({
            title: createPR.title,
            description: createPR.description,
            sourceBranch: targetBranch,
            targetBranch: createPR.targetBranch,
          }),
        );
      }

      // Compute changes summary — compare content to avoid false "modified" entries
      const changes: ChangesSummary = {
        added: [...localPathSet].filter((p) => !remoteByPath.has(p)),
        modified: [...localPathSet].filter((p) => {
          const remoteContent = remoteByPath.get(p);
          return remoteContent !== undefined && remoteContent !== exportedFiles.get(p);
        }),
        deleted: deletedPaths,
      };

      return {
        success: true,
        commitSha: pushResult.commitSha,
        changes,
        conflicts: [],
      };
    } catch (error) {
      if (prBranchCreated) {
        // GitProvider interface does not expose deleteBranch — log for operator cleanup
        log.warn('PR branch may be orphaned after push/PR creation failure', {
          branch: prBranchCreated,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  /**
   * Pull remote files into a canonical path -> content map without applying them.
   */
  async pullProjectFiles(branch: string, syncPath = '/'): Promise<PullProjectFilesResult> {
    const normalizedSyncPath = normalizeSyncPath(syncPath);
    const pullResult = await this.breaker.execute(() =>
      this.provider.pullProject(branch, toProviderSyncPath(normalizedSyncPath)),
    );
    const files = new Map<string, string>();
    const prefix = normalizedSyncPath === '/' ? null : `${normalizedSyncPath}/`;

    for (const file of pullResult.files) {
      const repositoryPath = normalizeProjectPath(file.path);
      if (prefix && !repositoryPath.startsWith(prefix)) {
        continue;
      }
      files.set(toCanonicalProjectPath(file.path, normalizedSyncPath), file.content);
    }

    return {
      branch: pullResult.branch,
      commitSha: pullResult.commitSha,
      files,
    };
  }

  /**
   * Pull remote state into the local project.
   */
  async pull(
    options: PullOptions,
  ): Promise<SyncResult & { preview?: ReturnType<typeof importProject> }> {
    const { projectId, userId, tenantId, branch, existingState } = options;

    const pullResult = await this.pullProjectFiles(branch, options.syncPath);

    // Run import pipeline
    const importResult = importProject(pullResult.files, existingState, {
      projectId,
      userId,
      tenantId,
      files: pullResult.files,
    });

    const changes: ChangesSummary = {
      added: [
        ...importResult.preview.changes.agents.added,
        ...importResult.preview.changes.locales.added,
      ],
      modified: [
        ...importResult.preview.changes.agents.modified.map((m) => m.name),
        ...importResult.preview.changes.locales.modified,
      ],
      deleted: [
        ...importResult.preview.changes.agents.removed,
        ...importResult.preview.changes.locales.removed,
      ],
    };

    return {
      success: importResult.success,
      commitSha: pullResult.commitSha,
      changes,
      conflicts: [],
      preview: importResult,
      error: importResult.error,
    };
  }
}

/**
 * Extract a human-readable name from an export file path.
 *
 * Strips known directory prefixes and file extensions so the result
 * can be used as an agent/tool identifier in conflict reports and
 * dependency validation.
 */
export function extractAgentNameFromPath(path: string): string {
  // Try agent pattern first
  const agentMatch = path.match(/^agents\/(.+)\.agent\.(?:abl|yaml)$/);
  if (agentMatch) return agentMatch[1];

  // Try tool pattern
  const toolMatch = path.match(/^tools\/(.+)\.tools\.abl$/);
  if (toolMatch) return toolMatch[1];

  // Fallback: strip known directory prefix + extension
  const stripped = path
    .replace(
      /^(?:agents|tools|config|connections|guardrails|workflows|evals|search|channels|vocabulary)\//,
      '',
    )
    .replace(/\.(?:agent\.(?:abl|yaml)|tools\.abl|json)$/, '');
  return stripped || path;
}
