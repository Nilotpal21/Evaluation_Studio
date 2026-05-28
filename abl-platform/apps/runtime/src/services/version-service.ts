/**
 * Version Service
 *
 * Handles agent version lifecycle: compile DSL at version creation time,
 * cache compiled IR, and manage version status transitions.
 *
 * All methods require tenantId for cross-tenant isolation — ownership is
 * verified by joining ProjectAgent through Project.tenantId.
 */

import { createHash } from 'crypto';
import { AppError, ErrorCodes } from '@agent-platform/shared-kernel';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '@abl/compiler';
import type { CompilationError, CompilationOutput } from '@abl/compiler';
import { createLogger } from '@abl/compiler/platform';
import type { ProjectToolType } from '@agent-platform/database/models';
import { computeToolRuntimeMetadataHash } from '@agent-platform/shared/tools';
import {
  findProjectAgentForProject,
  findAgentVersion,
  findLatestAgentVersion,
  listAgentVersions,
  countAgentVersions,
  createAgentVersion,
  getAllAgentVersionNumbers,
  promoteAgentVersion,
  updateProjectAgentActiveVersions,
} from '../repos/project-repo.js';
import { getSessionService } from './session/session-service.js';
import { parseBehaviorProfileDocumentsFromConfigVariables } from './behavior-profile-documents.js';
import { resolveLibraryRef } from './agent-compile/library-ref-resolver.js';
import { getPromptLibraryService } from './prompt-library/prompt-library-service.js';

const log = createLogger('version-service');

// =============================================================================
// TYPES
// =============================================================================

export interface CreateVersionParams {
  projectId: string;
  agentName: string;
  dslContent: string;
  version: string;
  createdBy: string;
  tenantId: string;
  changelog?: string;
  /** Peer agent DSL strings for batch compilation (supervisors need sibling agents). */
  peerDsls?: string[];
  /** Optional prompt library reference to resolve into the system prompt at compile time. */
  libraryRef?: { promptId: string; versionId: string };
}

export interface CreateVersionResult {
  versionId: string;
  version: string;
  sourceHash: string;
  deduplicated?: boolean;
  toolSnapshotRefresh?: {
    attempted: boolean;
    matchedCount: number;
    modifiedCount: number;
    refreshed: boolean;
  };
  compileErrors?: string[];
  toolSnapshot?: Array<{
    name: string;
    projectToolId: string;
    sourceHash: string;
    runtimeMetadataHash: string;
    toolType: ProjectToolType;
    description: string | null;
    dslContent: string;
  }> | null;
  warnings?: string[];
}

export interface PromoteVersionParams {
  projectId: string;
  agentName: string;
  version: string;
  targetStatus: string;
  promotedBy: string;
  tenantId: string;
}

export interface ListVersionsParams {
  projectId: string;
  agentName: string;
  tenantId: string;
  limit?: number;
  offset?: number;
}

const VALID_STATUSES = ['draft', 'testing', 'staged', 'active', 'deprecated'] as const;
type VersionStatus = (typeof VALID_STATUSES)[number];

const VALID_STATUS_TRANSITIONS: Record<string, string[]> = {
  draft: ['testing', 'staged'],
  testing: ['staged', 'draft'],
  staged: ['active', 'draft'],
  active: ['deprecated'],
  deprecated: [],
};

const MAX_DSL_SIZE = 512 * 1024; // 512 KB
const MAX_CHANGELOG_SIZE = 10_000; // 10 KB
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const MAX_DUPLICATE_KEY_RETRIES = 3;

// =============================================================================
// HELPERS
// =============================================================================

/** Safely parse a JSON string with a fallback value. */
export function safeParseJSON<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function formatCompilationError(error: CompilationError): string {
  return `${error.type ?? 'compilation'}: ${error.message} (agent: ${error.agent ?? 'unknown'})`;
}

function formatPeerDslParseErrors(
  peerIndex: number,
  parseResult: {
    document?: { name?: string } | null;
    errors: Array<{ message: string }>;
  },
): string[] {
  const peerLabel = parseResult.document?.name || `peer ${peerIndex + 1}`;
  const prefix = `Peer DSL parse failed for ${peerLabel}`;
  if (parseResult.errors.length === 0) {
    return [`${prefix}: parser did not produce a document`];
  }
  return parseResult.errors.map((error) => `${prefix}: ${error.message}`);
}

function isTargetAgentCompilationError(error: CompilationError, agentName: string): boolean {
  return error.agent === agentName;
}

function computeToolSourceHash(dslContent: string): string {
  return createHash('sha256').update(dslContent).digest('hex');
}

interface VersionPromptLibraryHashInput {
  promptId: string;
  versionId: string;
  resolvedHash?: string;
}

function buildPromptLibraryHashInput(
  ref: VersionPromptLibraryHashInput | null | undefined,
): string | null {
  if (!ref) {
    return null;
  }

  return ['prompt_library', ref.promptId, ref.versionId, ref.resolvedHash ?? ''].join(':');
}

// =============================================================================
// DEPENDENCY INJECTION SEAMS (createVersion only)
// =============================================================================

interface VersionToolSnapshotDoc {
  _id: string;
  name: string;
  sourceHash?: string | null;
  toolType: ProjectToolType;
  description?: string | null;
  dslContent: string;
  variableNamespaceIds?: string[];
}

interface VersionToolResolutionError {
  code: string;
  message: string;
  location?: string;
}

interface VersionToolResolutionResult {
  resolvedByAgent: Map<string, import('@abl/compiler').ToolDefinition[]>;
  errors: VersionToolResolutionError[];
}

interface VersionToolResolutionInput {
  tenantId: string;
  projectId: string;
  toolsByAgent: Map<string, string[]>;
}

type VersionPromptLibraryDocument = import('@abl/core').AgentBasedDocument & {
  systemPrompt?: string | null;
  systemPromptLibraryRef?: VersionPromptLibraryHashInput | null;
};

/**
 * Injectable seams for `createVersion()` so it can be unit-tested without
 * mocking `@agent-platform/database/models`. Other methods on VersionService
 * still use direct imports; scope is intentionally narrow.
 */
export interface VersionServiceDeps {
  findProjectAgentForProject: typeof findProjectAgentForProject;
  loadProjectConfigVariables: (
    projectId: string,
    tenantId: string,
  ) => Promise<Record<string, string>>;
  findLatestAgentVersion: typeof findLatestAgentVersion;
  cacheAgentIR: (ir: import('@abl/compiler').AgentIR) => Promise<void>;
  createAgentVersion: typeof createAgentVersion;
  resolvePromptLibraryRefForVersion?: (
    document: VersionPromptLibraryDocument,
    tenantId: string,
    projectId: string,
  ) => Promise<void>;
  resolveToolImplementationsForVersion?: (
    input: VersionToolResolutionInput,
  ) => Promise<VersionToolResolutionResult>;
  findProjectToolsForVersionSnapshot?: (
    tenantId: string,
    projectId: string,
    toolNames: string[],
  ) => Promise<VersionToolSnapshotDoc[]>;
  updateAgentVersionToolSnapshot?: typeof defaultUpdateAgentVersionToolSnapshot;
}

async function defaultResolveToolImplementationsForVersion(
  input: VersionToolResolutionInput,
): Promise<VersionToolResolutionResult> {
  const { resolveToolImplementations } = await import('@agent-platform/shared/tools/resolve');
  const { buildModuleToolResolver } =
    await import('@agent-platform/shared/tools/resolve-module-tool');
  const { findMcpServerConfigsRaw } = await import('@agent-platform/shared/repos');
  const { buildConnectorToolResolver } = await import('./connector-registry-singleton.js');
  const resolved = await resolveToolImplementations(input, {
    mcpServerConfigRawLoader: (tid, pid) => findMcpServerConfigsRaw(tid, pid),
    connectorToolResolver: buildConnectorToolResolver(),
    moduleToolResolver: buildModuleToolResolver(input.tenantId, input.projectId),
  });

  return {
    resolvedByAgent: resolved.resolvedByAgent as Map<
      string,
      import('@abl/compiler').ToolDefinition[]
    >,
    errors: resolved.errors,
  };
}

async function defaultFindProjectToolsForVersionSnapshot(
  tenantId: string,
  projectId: string,
  toolNames: string[],
): Promise<VersionToolSnapshotDoc[]> {
  const { ProjectTool } = await import('@agent-platform/database/models');
  const docs = await ProjectTool.find({
    tenantId,
    projectId,
    name: { $in: toolNames },
  }).lean();
  return docs.map((doc) => ({
    _id: String(doc._id),
    name: doc.name,
    sourceHash: doc.sourceHash,
    toolType: doc.toolType,
    description: doc.description ?? null,
    dslContent: doc.dslContent,
    variableNamespaceIds: Array.isArray((doc as any).variableNamespaceIds)
      ? (doc as any).variableNamespaceIds.map(String)
      : [],
  }));
}

async function defaultUpdateAgentVersionToolSnapshot(
  versionId: string,
  agentId: string,
  toolSnapshot: Array<{
    name: string;
    projectToolId: string;
    sourceHash: string;
    runtimeMetadataHash?: string;
    toolType: ProjectToolType;
    description: string | null;
    dslContent: string;
  }> | null,
): Promise<{ matchedCount: number; modifiedCount: number }> {
  const { AgentVersion } = await import('@agent-platform/database/models');
  const result = await AgentVersion.updateOne(
    { _id: versionId, agentId },
    { $set: { toolSnapshot: toolSnapshot ?? null } },
  );
  return { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount };
}

function formatToolResolutionError(error: VersionToolResolutionError): string {
  return `${error.code}: ${error.message}`;
}

const DEFAULT_DEPS: VersionServiceDeps = {
  findProjectAgentForProject,
  loadProjectConfigVariables: async (projectId, tenantId) => {
    const out: Record<string, string> = {};
    const { ProjectConfigVariable } = await import('@agent-platform/database/models');
    const docs = await ProjectConfigVariable.find(
      { projectId, tenantId },
      { key: 1, value: 1 },
    ).lean();
    for (const doc of docs) {
      out[(doc as any).key] = (doc as any).value;
    }
    return out;
  },
  findLatestAgentVersion,
  cacheAgentIR: async (ir) => {
    await getSessionService().cacheAgentIR(ir);
  },
  createAgentVersion,
  updateAgentVersionToolSnapshot: defaultUpdateAgentVersionToolSnapshot,
  resolvePromptLibraryRefForVersion: async (document, tenantId, projectId) => {
    await resolveLibraryRef(document, tenantId, projectId);
  },
};

// =============================================================================
// VERSION SERVICE
// =============================================================================

export class VersionService {
  constructor(private readonly deps: VersionServiceDeps = DEFAULT_DEPS) {}

  // ---------------------------------------------------------------------------
  // TENANT-SCOPED PROJECT AGENT LOOKUP
  // ---------------------------------------------------------------------------

  /**
   * Find a ProjectAgent by name, verifying the project belongs to the given tenant.
   * Returns null if the project doesn't belong to the tenant or the agent doesn't exist.
   */
  private async findAgentWithTenantGuard(projectId: string, agentName: string, tenantId: string) {
    const agent = await this.deps.findProjectAgentForProject(projectId, agentName, tenantId, {
      includeTenantId: true,
    });
    if (!agent) return null;
    return agent;
  }

  // ---------------------------------------------------------------------------
  // INPUT VALIDATION
  // ---------------------------------------------------------------------------

  static validateDslContent(dslContent: string): string | null {
    if (typeof dslContent !== 'string') return 'dslContent must be a string';
    if (dslContent.length === 0) return 'dslContent must not be empty';
    if (dslContent.length > MAX_DSL_SIZE)
      return `dslContent exceeds maximum size of ${MAX_DSL_SIZE} bytes`;
    return null;
  }

  static validateChangelog(changelog: unknown): string | null {
    if (changelog === undefined || changelog === null) return null;
    if (typeof changelog !== 'string') return 'changelog must be a string';
    if (changelog.length > MAX_CHANGELOG_SIZE)
      return `changelog exceeds maximum size of ${MAX_CHANGELOG_SIZE} characters`;
    return null;
  }

  static isValidStatus(status: unknown): status is VersionStatus {
    return typeof status === 'string' && VALID_STATUSES.includes(status as VersionStatus);
  }

  // ---------------------------------------------------------------------------
  // CREATE VERSION
  // ---------------------------------------------------------------------------

  /**
   * Compile DSL and create a new agent version.
   * Returns compile errors (without persisting) if DSL is invalid.
   * Handles concurrent create via retry on unique constraint violation.
   */
  async createVersion(params: CreateVersionParams): Promise<CreateVersionResult> {
    const { projectId, agentName, dslContent, version, createdBy, tenantId, changelog } = params;

    // Input validation
    const dslError = VersionService.validateDslContent(dslContent);
    if (dslError) throw new AppError(dslError, { ...ErrorCodes.BAD_REQUEST });
    const changelogError = VersionService.validateChangelog(changelog);
    if (changelogError) throw new AppError(changelogError, { ...ErrorCodes.BAD_REQUEST });

    // Load project config variables for compile-time {{config.KEY}} resolution
    let configVariables: Record<string, string> = {};
    try {
      configVariables = await this.deps.loadProjectConfigVariables(projectId, tenantId);
    } catch (err) {
      log.warn('Failed to load config variables for compilation', {
        projectId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Find agent with tenant guard
    const agent = await this.findAgentWithTenantGuard(projectId, agentName, tenantId);
    if (!agent) {
      throw new AppError(`Agent '${agentName}' not found in project`, { ...ErrorCodes.NOT_FOUND });
    }
    const agentId = (agent as any).id ?? (agent as any)._id;

    // Parse DSL — fail fast on invalid DSL before compilation
    const parseResult = parseAgentBasedABL(dslContent);
    if (!parseResult.document || parseResult.errors.length > 0) {
      const errors = parseResult.errors.map((e: { message: string }) => e.message);
      log.warn('DSL parse failed', { projectId, agentName, errorCount: errors.length });
      return { versionId: '', version, sourceHash: '', compileErrors: errors };
    }

    // Warnings accumulated from compilation
    const warnings: string[] = [];

    const compilerOptions: Record<string, unknown> = {};
    if (Object.keys(configVariables).length > 0) {
      compilerOptions.config_variables = configVariables;
    }

    // Inject prompt library reference into document before compilation
    if (params.libraryRef) {
      (
        parseResult.document as unknown as { systemPromptLibraryRef?: unknown }
      ).systemPromptLibraryRef = { ...params.libraryRef };
    }
    const resolvePromptLibraryRef =
      this.deps.resolvePromptLibraryRefForVersion ??
      DEFAULT_DEPS.resolvePromptLibraryRefForVersion ??
      (async (
        document: VersionPromptLibraryDocument,
        currentTenantId: string,
        currentProjectId: string,
      ) => {
        await resolveLibraryRef(document, currentTenantId, currentProjectId);
      });
    await resolvePromptLibraryRef(
      parseResult.document as VersionPromptLibraryDocument,
      tenantId,
      projectId,
    );

    // Compile to IR — include peer documents for batch compilation (supervisor validation)
    const allDocuments: import('@abl/core').AgentBasedDocument[] = [parseResult.document];
    if (params.peerDsls?.length) {
      for (const [peerIndex, peerDsl] of params.peerDsls.entries()) {
        const peerResult = parseAgentBasedABL(peerDsl);
        if (!peerResult.document || peerResult.errors.length > 0) {
          const errors = formatPeerDslParseErrors(peerIndex, peerResult);
          log.warn('Peer DSL parse failed', {
            projectId,
            agentName,
            peerIndex,
            errorCount: errors.length,
          });
          return { versionId: '', version, sourceHash: '', compileErrors: errors };
        }
        allDocuments.push(peerResult.document);
      }
    }
    const profileDocuments = parseBehaviorProfileDocumentsFromConfigVariables(configVariables);
    if (profileDocuments.errors.length > 0) {
      log.warn('Behavior profile config parse failed during version compilation', {
        projectId,
        agentName,
        errors: profileDocuments.errors,
      });
    }
    allDocuments.push(...profileDocuments.documents);

    // Resolve project tool implementations for every document participating in
    // the version compile. Peer agents can be cached and deployed from this
    // output, so missing authored tools must fail here instead of surfacing only
    // after a handoff/runtime execution path reaches the peer.
    if (projectId && tenantId) {
      try {
        const toolsByAgent = new Map<string, string[]>();
        for (const document of allDocuments) {
          const toolNames = (document.tools ?? [])
            .map((t: { name: string }) => t.name)
            .filter(Boolean);
          if (toolNames.length > 0) {
            toolsByAgent.set(document.name, toolNames);
          }
        }

        if (toolsByAgent.size > 0) {
          const resolver =
            this.deps.resolveToolImplementationsForVersion ??
            defaultResolveToolImplementationsForVersion;
          const resolved = await resolver({
            tenantId,
            projectId,
            toolsByAgent,
          });

          if (resolved.errors.length > 0) {
            const errors = resolved.errors.map(formatToolResolutionError);
            log.warn('Project tool resolution produced blocking errors', {
              projectId,
              agentName,
              errorCount: errors.length,
            });
            return { versionId: '', version, sourceHash: '', compileErrors: errors };
          }

          compilerOptions.resolvedToolImplementations = resolved.resolvedByAgent;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn('Tool resolution failed before version compile', {
          projectId,
          agentName,
          error: message,
        });
        return {
          versionId: '',
          version,
          sourceHash: '',
          compileErrors: [`Tool resolution failed: ${message}`],
        };
      }
    }

    let compilationOutput: CompilationOutput;
    try {
      compilationOutput = compileABLtoIR(
        allDocuments,
        Object.keys(compilerOptions).length > 0 ? compilerOptions : undefined,
      );
    } catch (err) {
      log.warn('DSL compile failed', {
        projectId,
        agentName,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        versionId: '',
        version,
        sourceHash: '',
        compileErrors: [err instanceof Error ? err.message : String(err)],
      };
    }

    const compilationErrors = compilationOutput.compilation_errors ?? [];
    if (compilationErrors.length > 0) {
      const errors = compilationErrors.map(formatCompilationError);
      const targetErrorCount = compilationErrors.filter((error) =>
        isTargetAgentCompilationError(error, agentName),
      ).length;
      log.warn('DSL compile produced blocking errors', {
        projectId,
        agentName,
        errorCount: errors.length,
        targetErrorCount,
      });
      return {
        versionId: '',
        version,
        sourceHash: '',
        compileErrors: errors,
      };
    }

    // Propagate resolved libraryRef metadata into the target agent's compiled IR
    if (params.libraryRef) {
      const libRef = (
        parseResult.document as unknown as {
          systemPromptLibraryRef?: { promptId: string; versionId: string; resolvedHash?: string };
        }
      ).systemPromptLibraryRef;
      const targetIR = compilationOutput.agents[agentName];
      if (targetIR?.identity?.system_prompt && libRef?.resolvedHash) {
        targetIR.identity.system_prompt.libraryRef = {
          promptId: libRef.promptId,
          versionId: libRef.versionId,
          resolvedHash: libRef.resolvedHash,
        };
      }
    }

    // Build tool snapshot from project tools
    let toolSnapshot: CreateVersionResult['toolSnapshot'] = null;
    if (projectId && tenantId) {
      try {
        const toolNames = new Set(
          Object.values(compilationOutput.agents).flatMap((ir: any) =>
            (ir.tools || []).map((t: any) => t.name),
          ),
        );

        if (toolNames.size > 0) {
          const findProjectTools =
            this.deps.findProjectToolsForVersionSnapshot ??
            defaultFindProjectToolsForVersionSnapshot;
          const projectTools = await findProjectTools(tenantId, projectId, [...toolNames]);

          toolSnapshot = projectTools.map((pt) => {
            const sourceHash = computeToolSourceHash(pt.dslContent);
            if (pt.sourceHash && pt.sourceHash !== sourceHash) {
              warnings.push(
                `W_TOOL_SOURCE_HASH_STALE: Tool '${pt.name}' sourceHash was stale; version hash used current DSL content.`,
              );
            }

            return {
              name: pt.name,
              projectToolId: String(pt._id),
              sourceHash,
              runtimeMetadataHash: computeToolRuntimeMetadataHash(pt),
              toolType: pt.toolType,
              description: pt.description ?? null,
              dslContent: pt.dslContent,
            };
          });
        }
      } catch (err) {
        log.warn('Failed to build tool snapshot', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Compute sourceHash from DSL + config vars + project tool sourceHashes.
    // Including tool hashes ensures that when project tools are updated
    // (e.g., endpoint changes from resolved URL to {{env.X}} template),
    // a new version is created instead of deduplicating against a stale one.
    let hashInput = dslContent;
    if (Object.keys(configVariables).length > 0) {
      hashInput += '\0' + JSON.stringify(configVariables, Object.keys(configVariables).sort());
    }
    if (toolSnapshot && toolSnapshot.length > 0) {
      const sortedHashes = toolSnapshot
        .map((t) => `${t.name}:${t.sourceHash}:${t.runtimeMetadataHash}`)
        .sort()
        .join(',');
      hashInput += '\0tools:' + sortedHashes;
    }
    const promptLibraryHashInput = buildPromptLibraryHashInput(
      (
        parseResult.document as unknown as {
          systemPromptLibraryRef?: VersionPromptLibraryHashInput | null;
        }
      ).systemPromptLibraryRef,
    );
    if (promptLibraryHashInput) {
      hashInput += '\0' + promptLibraryHashInput;
    }
    const sourceHash = createHash('sha256').update(hashInput).digest('hex').substring(0, 16);

    // Dedup: skip if latest version has same sourceHash
    const latestVersion = await this.deps.findLatestAgentVersion(agentId);
    if (latestVersion && (latestVersion as any).sourceHash === sourceHash) {
      log.info('Version dedup — same sourceHash as latest', { projectId, agentName, sourceHash });
      let toolSnapshotRefresh: CreateVersionResult['toolSnapshotRefresh'];
      if (toolSnapshot !== null) {
        try {
          const latestVersionId = String((latestVersion as any).id ?? (latestVersion as any)._id);
          const updateToolSnapshot =
            this.deps.updateAgentVersionToolSnapshot ?? defaultUpdateAgentVersionToolSnapshot;
          const refreshResult = await updateToolSnapshot(latestVersionId, agentId, toolSnapshot);
          if (refreshResult.matchedCount !== 1) {
            throw new AppError(
              'Deduplicated version snapshot refresh did not match the latest version.',
              { ...ErrorCodes.INTERNAL_ERROR, code: 'VERSION_SNAPSHOT_REFRESH_MISSED' },
            );
          }
          toolSnapshotRefresh = {
            attempted: true,
            matchedCount: refreshResult.matchedCount,
            modifiedCount: refreshResult.modifiedCount,
            refreshed: refreshResult.modifiedCount > 0,
          };
        } catch (err) {
          log.error('Failed to refresh deduplicated version tool snapshot', {
            projectId,
            agentName,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      }
      return {
        versionId: (latestVersion as any).id ?? (latestVersion as any)._id,
        version: (latestVersion as any).version,
        sourceHash,
        deduplicated: true,
        toolSnapshotRefresh,
        toolSnapshot,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    }

    // Cache IR in SessionService
    const irJson = JSON.stringify(compilationOutput);
    for (const name of Object.keys(compilationOutput.agents)) {
      const agentIR = compilationOutput.agents[name];
      if (agentIR) {
        await this.deps.cacheAgentIR(agentIR);
      }
    }

    // Create version record — retry on unique constraint collision (max MAX_DUPLICATE_KEY_RETRIES)
    let currentVersion = version;
    for (let attempt = 0; attempt < MAX_DUPLICATE_KEY_RETRIES; attempt++) {
      try {
        const record = await this.deps.createAgentVersion({
          agentId,
          version: currentVersion,
          status: 'draft',
          dslContent,
          irContent: irJson,
          sourceHash,
          changelog: changelog ?? undefined,
          createdBy,
          toolSnapshot: toolSnapshot ?? undefined,
        });

        const recordId = (record as any).id ?? (record as any)._id;
        if (attempt > 0) {
          log.info('Version created (retry)', {
            projectId,
            agentName,
            version: currentVersion,
            versionId: recordId,
            attempt,
          });
        } else {
          log.info('Version created', {
            projectId,
            agentName,
            version: currentVersion,
            versionId: recordId,
            sourceHash,
          });
        }
        // Non-fatal: increment usageCount after version persisted
        if (params.libraryRef) {
          getPromptLibraryService()
            .incrementUsageCount(params.libraryRef.promptId, tenantId ?? '')
            .catch((incrementErr) => {
              log.warn('Failed to increment prompt library usage count', {
                promptId: params.libraryRef!.promptId,
                error: incrementErr instanceof Error ? incrementErr.message : String(incrementErr),
              });
            });
        }

        return {
          versionId: recordId,
          version: currentVersion,
          sourceHash,
          toolSnapshot,
          warnings: warnings.length > 0 ? warnings : undefined,
        };
      } catch (err: any) {
        if (err?.code === 11000 && attempt < MAX_DUPLICATE_KEY_RETRIES - 1) {
          log.warn('Version create collision, retrying', {
            projectId,
            agentName,
            version: currentVersion,
            attempt,
          });
          currentVersion = await this.nextVersion(projectId, agentName, tenantId);
          continue;
        }
        throw err;
      }
    }
    throw new AppError('Version creation failed after maximum retries', {
      ...ErrorCodes.INTERNAL_ERROR,
    });
  }

  // ---------------------------------------------------------------------------
  // LIST VERSIONS
  // ---------------------------------------------------------------------------

  /**
   * List versions for an agent with pagination, ordered by createdAt desc.
   */
  async listVersions(params: ListVersionsParams) {
    const { projectId, agentName, tenantId } = params;
    const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
    const offset = Math.max(params.offset ?? 0, 0);

    const agent = await this.findAgentWithTenantGuard(projectId, agentName, tenantId);
    if (!agent) return { versions: [], total: 0 };

    const agentId = (agent as any).id ?? (agent as any)._id;
    const [versions, total] = await Promise.all([
      listAgentVersions(agentId, { skip: offset, take: limit }),
      countAgentVersions(agentId),
    ]);

    return { versions, total };
  }

  // ---------------------------------------------------------------------------
  // GET VERSION
  // ---------------------------------------------------------------------------

  /**
   * Get a specific version by composite key, with tenant guard.
   */
  async getVersion(projectId: string, agentName: string, version: string, tenantId: string) {
    const agent = await this.findAgentWithTenantGuard(projectId, agentName, tenantId);
    if (!agent) return null;

    const agentId = (agent as any).id ?? (agent as any)._id;
    return findAgentVersion(agentId, version);
  }

  // ---------------------------------------------------------------------------
  // NEXT VERSION
  // ---------------------------------------------------------------------------

  /**
   * Auto-increment semver patch: 0.1.0 → 0.1.1.
   * Returns "0.1.0" if no versions exist.
   * Finds the highest version by fetching all and parsing semver (avoids clock-skew issues).
   */
  async nextVersion(projectId: string, agentName: string, tenantId: string): Promise<string> {
    const agent = await this.findAgentWithTenantGuard(projectId, agentName, tenantId);
    if (!agent) return '0.1.0';

    const agentId = (agent as any).id ?? (agent as any)._id;
    const versionStrings = await getAllAgentVersionNumbers(agentId);
    if (versionStrings.length === 0) return '0.1.0';

    // Find highest semver by numeric comparison
    let highest: [number, number, number] | null = null;
    for (const ver of versionStrings) {
      const parts = ver.split('.').map(Number);
      if (parts.length !== 3 || parts.some(isNaN)) continue;
      const tuple = parts as unknown as [number, number, number];
      if (
        !highest ||
        tuple[0] > highest[0] ||
        (tuple[0] === highest[0] && tuple[1] > highest[1]) ||
        (tuple[0] === highest[0] && tuple[1] === highest[1] && tuple[2] > highest[2])
      ) {
        highest = tuple;
      }
    }

    if (!highest) return '0.1.0';
    return `${highest[0]}.${highest[1]}.${highest[2] + 1}`;
  }

  // ---------------------------------------------------------------------------
  // PROMOTE VERSION
  // ---------------------------------------------------------------------------

  /**
   * Promote a version to a new status with transition validation and optimistic locking.
   * When a version reaches 'active', updates the ProjectAgent.activeVersions map.
   * Returns the previous status for audit logging.
   */
  async promoteVersion(params: PromoteVersionParams) {
    const { projectId, agentName, version, targetStatus, promotedBy, tenantId } = params;

    if (!VersionService.isValidStatus(targetStatus)) {
      throw new AppError(`Invalid target status '${targetStatus}'`, { ...ErrorCodes.BAD_REQUEST });
    }

    const agent = await this.findAgentWithTenantGuard(projectId, agentName, tenantId);
    if (!agent) throw new AppError(`Agent '${agentName}' not found`, { ...ErrorCodes.NOT_FOUND });

    const agentId = (agent as any).id ?? (agent as any)._id;
    const record = await findAgentVersion(agentId, version);
    if (!record) throw new AppError(`Version '${version}' not found`, { ...ErrorCodes.NOT_FOUND });

    const recordId = (record as any).id ?? (record as any)._id;
    const recordStatus = (record as any).status as string;

    const allowed = VALID_STATUS_TRANSITIONS[recordStatus];
    if (!allowed || !allowed.includes(targetStatus)) {
      throw new AppError(`Cannot transition from '${recordStatus}' to '${targetStatus}'`, {
        ...ErrorCodes.BAD_REQUEST,
      });
    }

    const previousStatus = recordStatus;

    // Optimistic locking: only update if status hasn't changed since we read it
    const updated = await promoteAgentVersion({
      id: recordId,
      currentStatus: previousStatus,
      newStatus: targetStatus,
      promotedBy,
    });

    if (updated.count === 0) {
      throw new AppError(
        `Concurrent modification: version '${version}' status changed since read`,
        { ...ErrorCodes.UNPROCESSABLE_ENTITY },
      );
    }

    // Sync activeVersions when a version reaches 'active'
    if (targetStatus === 'active') {
      try {
        // activeVersions may be a JSON string or object — normalize
        const rawVersions = (agent as any).activeVersions;
        const currentVersions: Record<string, string> =
          typeof rawVersions === 'string'
            ? safeParseJSON<Record<string, string>>(rawVersions, {})
            : (rawVersions ?? {});
        // Use 'default' environment — callers can specify environment via Deployment layer later
        currentVersions['default'] = version;
        await updateProjectAgentActiveVersions(agentId, currentVersions, tenantId, projectId);
      } catch (syncErr) {
        // Non-fatal: log but don't fail the promotion
        log.warn('Failed to sync activeVersions', {
          projectId,
          agentName,
          version,
          error: syncErr instanceof Error ? syncErr.message : String(syncErr),
        });
      }
    }

    log.info('Version promoted', {
      projectId,
      agentName,
      version,
      from: previousStatus,
      to: targetStatus,
      promotedBy,
    });

    // Re-fetch the record to return full data (promoteAgentVersion doesn't return the record)
    const result = await findAgentVersion(agentId, version);

    return { ...result!, previousStatus };
  }

  // ---------------------------------------------------------------------------
  // DIFF VERSIONS
  // ---------------------------------------------------------------------------

  /**
   * Return DSL content + metadata for two versions (for client-side diffing).
   */
  async diffVersions(
    projectId: string,
    agentName: string,
    versionA: string,
    versionB: string,
    tenantId: string,
  ) {
    const agent = await this.findAgentWithTenantGuard(projectId, agentName, tenantId);
    if (!agent) throw new AppError(`Agent '${agentName}' not found`, { ...ErrorCodes.NOT_FOUND });

    const agentId = (agent as any).id ?? (agent as any)._id;
    const [a, b] = await Promise.all([
      findAgentVersion(agentId, versionA),
      findAgentVersion(agentId, versionB),
    ]);

    if (!a) throw new AppError(`Version '${versionA}' not found`, { ...ErrorCodes.NOT_FOUND });
    if (!b) throw new AppError(`Version '${versionB}' not found`, { ...ErrorCodes.NOT_FOUND });

    return { a, b };
  }
}

// =============================================================================
// SINGLETON FACTORY
// =============================================================================

let instance: VersionService | null = null;

export function getVersionService(): VersionService {
  if (!instance) {
    instance = new VersionService();
  }
  return instance;
}

export function resetVersionService(): void {
  instance = null;
}
