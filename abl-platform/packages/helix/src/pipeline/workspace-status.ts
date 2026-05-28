import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const TEST_FILE_PATTERN = /(^|\/)__tests__\/.*\.[cm]?[jt]sx?$|(\.|-)(test|spec)\.[cm]?[jt]sx?$/i;
const LOCAL_AGENT_SCRATCH_PREFIXES = ['.claire'];
const TOOL_OWNED_OUT_OF_SCOPE_BASENAMES = new Set([
  'agents.md',
  'AGENTS.md',
  'CLAUDE.md',
  'next-env.d.ts',
]);
const HELIX_SCOPED_TYPECHECK_FILE_PATTERN = /(^|\/)\.helix-typecheck-[^/]+\.(?:json|[cm]?[jt]s)$/i;

export interface WorkspaceFileSnapshot {
  exists: boolean;
  digest: string | null;
}

interface WorkspaceStatusEntry {
  path: string;
  statusCode: string;
}

export async function findModifiedWorkspacePaths(
  workDir: string,
  targets: string[],
): Promise<string[]> {
  return (await findModifiedWorkspaceEntries(workDir, targets)).map((entry) => entry.path);
}

export async function listChangedWorkspacePaths(workDir: string): Promise<string[]> {
  const changedEntries = await findModifiedWorkspaceEntries(workDir, ['.']);
  return changedEntries
    .filter((entry) => !isIgnorableWorkspaceChange(entry))
    .map((entry) => entry.path);
}

export async function isWorkspacePathModified(workDir: string, target: string): Promise<boolean> {
  const modifiedPaths = await findModifiedWorkspacePaths(workDir, [target]);
  return modifiedPaths.includes(target);
}

export function isDeterministicOutOfScopeWorkspacePath(file: string): boolean {
  const normalized = file.trim();
  if (!normalized) {
    return false;
  }

  return (
    isHelixManagedPath(normalized) ||
    LOCAL_AGENT_SCRATCH_PREFIXES.some((prefix) => pathMatchesPrefix(normalized, prefix)) ||
    TOOL_OWNED_OUT_OF_SCOPE_BASENAMES.has(basename(normalized)) ||
    HELIX_SCOPED_TYPECHECK_FILE_PATTERN.test(normalized)
  );
}

export function partitionDeterministicOutOfScopeWorkspacePaths(paths: string[]): {
  ignoredFiles: string[];
  blockingFiles: string[];
} {
  const ignoredFiles: string[] = [];
  const blockingFiles: string[] = [];

  for (const file of dedupe(paths)) {
    if (isDeterministicOutOfScopeWorkspacePath(file)) {
      ignoredFiles.push(file);
    } else {
      blockingFiles.push(file);
    }
  }

  return {
    ignoredFiles,
    blockingFiles,
  };
}

export async function captureWorkspaceFileSnapshot(
  workDir: string,
  target: string,
): Promise<WorkspaceFileSnapshot> {
  try {
    const contents = await readFile(resolveWorkspacePath(workDir, target));
    return {
      exists: true,
      digest: createHash('sha256').update(contents).digest('hex'),
    };
  } catch {
    return {
      exists: false,
      digest: null,
    };
  }
}

export async function hasWorkspacePathChangedSinceSnapshot(
  workDir: string,
  target: string,
  snapshot: WorkspaceFileSnapshot | undefined,
): Promise<boolean> {
  if (snapshot == null) {
    return isWorkspacePathModified(workDir, target);
  }

  const current = await captureWorkspaceFileSnapshot(workDir, target);
  return current.exists !== snapshot.exists || current.digest !== snapshot.digest;
}

export function isTestFilePath(value: string): boolean {
  return TEST_FILE_PATTERN.test(value);
}

export function scopeEntryToWorkspaceTarget(scopeEntry: string): string {
  return looksLikeFilePath(scopeEntry) ? dirname(scopeEntry) : scopeEntry;
}

/**
 * Paths that are always auto-managed by tooling and should never be flagged
 * as out-of-scope during architecture review.
 *
 * - `.helix/`         — HELIX session state (matched as any path segment, so
 *                       nested locations like `packages/helix/.helix/` are
 *                       also ignored when helix runs from a sub-package)
 * - `.apdas/`         — APDAS workspace state (also segment-matched)
 * - `docs/sdlc-logs/` — HELIX SDLC journals
 * - `pnpm-lock.yaml`  — auto-updated by pnpm whenever any package.json changes;
 *                       including a lockfile in every slice manifest is noise.
 */
export function isHelixManagedPath(file: string): boolean {
  return (
    pathHasSegment(file, '.helix') ||
    pathHasSegment(file, '.apdas') ||
    file.startsWith('docs/sdlc-logs/') ||
    file === '.helix-replay-bootstrap.json' ||
    file === 'pnpm-lock.yaml'
  );
}

function pathHasSegment(file: string, segment: string): boolean {
  return file === segment || file.startsWith(`${segment}/`) || file.includes(`/${segment}/`);
}

async function findModifiedWorkspaceEntries(
  workDir: string,
  targets: string[],
): Promise<WorkspaceStatusEntry[]> {
  const dedupedTargets = dedupe(targets);
  if (dedupedTargets.length === 0) {
    return [];
  }

  try {
    const result = await execFileAsync('git', ['status', '--porcelain', '--', ...dedupedTargets], {
      cwd: workDir,
      timeout: 30_000,
      maxBuffer: 5 * 1024 * 1024,
    });
    return expandWorkspaceStatusEntries(workDir, parsePorcelainEntries(result.stdout));
  } catch (err) {
    if (err instanceof Error && 'stdout' in err) {
      const execErr = err as Error & { stdout?: string };
      return expandWorkspaceStatusEntries(workDir, parsePorcelainEntries(execErr.stdout ?? ''));
    }
    return [];
  }
}

async function expandWorkspaceStatusEntries(
  workDir: string,
  entries: WorkspaceStatusEntry[],
): Promise<WorkspaceStatusEntry[]> {
  const expandedEntries = await Promise.all(
    entries.map(async (entry) => expandWorkspaceStatusEntry(workDir, entry)),
  );

  const flattened = expandedEntries.flat();
  const seen = new Set<string>();
  const deduped: WorkspaceStatusEntry[] = [];

  for (const entry of flattened) {
    const key = `${entry.statusCode}:${entry.path}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(entry);
  }

  return deduped;
}

async function expandWorkspaceStatusEntry(
  workDir: string,
  entry: WorkspaceStatusEntry,
): Promise<WorkspaceStatusEntry[]> {
  const normalizedPath = trimTrailingSlash(entry.path.trim());
  if (!normalizedPath) {
    return [];
  }

  if (entry.statusCode !== '??') {
    return [{ ...entry, path: normalizedPath }];
  }

  const resolvedPath = resolveWorkspacePath(workDir, normalizedPath);

  try {
    const info = await stat(resolvedPath);
    if (!info.isDirectory()) {
      return [{ ...entry, path: normalizedPath }];
    }

    const files = await listDirectoryFilesRecursively(resolvedPath);
    if (files.length === 0) {
      return [{ ...entry, path: normalizedPath }];
    }

    return files.map((file) => ({
      ...entry,
      path: relative(workDir, file).replaceAll('\\', '/'),
    }));
  } catch {
    return [{ ...entry, path: normalizedPath }];
  }
}

async function listDirectoryFilesRecursively(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listDirectoryFilesRecursively(absolutePath)));
      continue;
    }

    if (entry.isFile() || entry.isSymbolicLink()) {
      files.push(absolutePath);
    }
  }

  return files;
}

function isIgnorableWorkspaceChange(entry: WorkspaceStatusEntry): boolean {
  return isHelixManagedPath(entry.path) || isLocalAgentScratchPath(entry);
}

function isLocalAgentScratchPath(entry: WorkspaceStatusEntry): boolean {
  return (
    entry.statusCode === '??' &&
    LOCAL_AGENT_SCRATCH_PREFIXES.some((prefix) => pathMatchesPrefix(entry.path, prefix))
  );
}

function parsePorcelainEntries(output: string): WorkspaceStatusEntry[] {
  return output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const statusCode = line.slice(0, 2);
      const rawPath = line.slice(3).trim();
      const renamedPath = rawPath.includes(' -> ') ? rawPath.split(' -> ').at(-1) : rawPath;
      return {
        path: renamedPath?.trim() ?? '',
        statusCode,
      };
    })
    .filter((entry) => Boolean(entry.path));
}

function looksLikeFilePath(value: string): boolean {
  return /\.[a-z0-9]+$/i.test(value);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function resolveWorkspacePath(workDir: string, target: string): string {
  return target.startsWith('/') ? target : join(workDir, target);
}

function pathMatchesPrefix(file: string, prefix: string): boolean {
  return file === prefix || file.startsWith(`${prefix}/`);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
