import { execFile } from 'node:child_process';
import { access, copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import { readJsonFileWithBackup, writeFileAtomic } from './io/atomic-file.js';
import type { SessionState, WorkspaceExecutionContext } from './types.js';

const execFileAsync = promisify(execFile);
const MAX_WORKTREE_NAME_ATTEMPTS = 20;
const WORKTREE_STATE_DIR = '.helix';
const WORKTREE_RECORDS_DIR = 'worktrees';

export type WorktreeLaunchCommand = 'audit' | 'fix' | 'canary';

export interface WorktreeLaunchRecord {
  sessionId: string;
  title: string;
  command: WorktreeLaunchCommand;
  sourceWorkDir: string;
  worktreeDir: string;
  sessionDir: string;
  journalDir: string;
  createdAt: string;
  updatedAt: string;
  baseHeadSha?: string;
  baseBranch?: string;
  requestedPath?: string;
  autoCreated: boolean;
  bootstrapCommand?: string;
  finalState?: SessionState;
  finalHeadSha?: string;
  finalizedAt?: string;
}

export interface PreparedWorktreeExecution {
  sourceWorkDir: string;
  workDir: string;
  syncedPaths: string[];
  workspaceContext: WorkspaceExecutionContext;
}

interface PrepareWorktreeExecutionOptions {
  label: string;
  requestedPath?: string;
  bootstrapInstall?: boolean;
  sourceRelativeFiles?: string[];
  /**
   * Optional git ref (branch, tag, sha, remote-tracking ref) to pin the new
   * worktree to. When omitted, the worktree starts at the source repo's
   * current HEAD (existing behavior). When provided, the ref is resolved to
   * a SHA via `git rev-parse` and the worktree is detached at that commit —
   * lets `helix review-branch <branch>` audit a remote PR branch without
   * forcing the operator to checkout that branch in the source repo.
   */
  headRef?: string;
}

interface GitIdentity {
  headSha: string;
  branch?: string;
}

export async function prepareWorktreeExecution(
  sourceWorkDirInput: string,
  options: PrepareWorktreeExecutionOptions,
): Promise<PreparedWorktreeExecution> {
  const sourceWorkDir = await resolveGitTopLevel(sourceWorkDirInput);
  const baseIdentity = await captureGitIdentity(sourceWorkDir);
  const requestedPath = normalizeRequestedPath(options.requestedPath);
  const worktreeDir =
    requestedPath == null
      ? await suggestUniqueWorktreePath(sourceWorkDir, options.label)
      : resolve(sourceWorkDir, requestedPath);

  ensureExternalWorktreePath(sourceWorkDir, worktreeDir);
  await ensurePathAvailable(worktreeDir);

  // Resolve the optional headRef to a SHA so the worktree is pinned to a
  // stable commit even if the underlying ref moves. Falls back to the
  // source repo's current HEAD when no headRef is supplied.
  const targetSha = options.headRef
    ? await resolveRefToSha(sourceWorkDir, options.headRef)
    : baseIdentity.headSha;
  const targetBranch = options.headRef ?? baseIdentity.branch;

  try {
    await execFileAsync('git', ['worktree', 'add', '--detach', worktreeDir, targetSha], {
      cwd: sourceWorkDir,
    });
  } catch (error) {
    throw new Error(`Failed to create git worktree at ${worktreeDir}: ${formatExecFailure(error)}`);
  }

  const bootstrapCommand =
    options.bootstrapInstall === false ? undefined : await maybeBootstrapWorktree(worktreeDir);
  const syncedPaths = await syncSourceRelativeFiles(
    sourceWorkDir,
    worktreeDir,
    options.sourceRelativeFiles ?? [],
  );

  return {
    sourceWorkDir,
    workDir: worktreeDir,
    syncedPaths,
    workspaceContext: {
      mode: 'git-worktree',
      sourceWorkDir,
      worktreeDir,
      baseHeadSha: targetSha,
      baseBranch: targetBranch,
      requestedPath,
      autoCreated: requestedPath == null,
      bootstrapCommand,
      createdAt: new Date().toISOString(),
    },
  };
}

async function resolveRefToSha(workDir: string, ref: string): Promise<string> {
  if (!/^[A-Za-z0-9._/~^@{}-]+$/.test(ref)) {
    throw new Error(`Refusing to resolve unsafe ref "${ref}"`);
  }
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
      cwd: workDir,
    });
    return stdout.trim();
  } catch (error) {
    throw new Error(`Failed to resolve git ref "${ref}": ${formatExecFailure(error)}`);
  }
}

async function syncSourceRelativeFiles(
  sourceWorkDir: string,
  worktreeDir: string,
  sourceRelativeFiles: string[],
): Promise<string[]> {
  const syncedPaths: string[] = [];
  const seen = new Set<string>();

  for (const candidate of sourceRelativeFiles) {
    const relativePath = normalizeSourceRelativeFile(sourceWorkDir, candidate);
    if (!relativePath || seen.has(relativePath)) {
      continue;
    }
    seen.add(relativePath);

    const sourcePath = resolve(sourceWorkDir, relativePath);
    const targetPath = resolve(worktreeDir, relativePath);

    if (await pathExists(targetPath)) {
      continue;
    }

    const sourceStat = await statIfExists(sourcePath);
    if (!sourceStat?.isFile()) {
      continue;
    }

    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    syncedPaths.push(relativePath);
  }

  return syncedPaths;
}

export async function loadWorktreeLaunchRecord(
  sourceWorkDir: string,
  sessionId: string,
): Promise<WorktreeLaunchRecord | null> {
  const recordPath = buildWorktreeRecordPath(sourceWorkDir, sessionId);

  try {
    const loaded = await readJsonFileWithBackup<WorktreeLaunchRecord>(recordPath);
    return loaded.value;
  } catch {
    return null;
  }
}

export async function listWorktreeLaunchRecords(
  sourceWorkDir: string,
): Promise<WorktreeLaunchRecord[]> {
  const recordsDir = buildWorktreeRecordsDir(sourceWorkDir);
  let entries: string[] = [];

  try {
    entries = await readdir(recordsDir);
  } catch {
    return [];
  }

  const records: WorktreeLaunchRecord[] = [];

  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      continue;
    }

    try {
      const loaded = await readJsonFileWithBackup<WorktreeLaunchRecord>(join(recordsDir, entry));
      records.push(loaded.value);
    } catch {
      // Skip corrupted launch records.
    }
  }

  return records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function writeWorktreeLaunchRecord(record: WorktreeLaunchRecord): Promise<void> {
  const nextRecord: WorktreeLaunchRecord = {
    ...record,
    updatedAt: new Date().toISOString(),
  };
  const recordPath = buildWorktreeRecordPath(record.sourceWorkDir, record.sessionId);
  await writeFileAtomic(recordPath, JSON.stringify(nextRecord, null, 2), { backup: true });
}

export async function updateWorktreeLaunchRecord(
  sourceWorkDir: string,
  sessionId: string,
  updates: Partial<WorktreeLaunchRecord>,
): Promise<void> {
  const existing = await loadWorktreeLaunchRecord(sourceWorkDir, sessionId);
  if (!existing) {
    return;
  }

  await writeWorktreeLaunchRecord({
    ...existing,
    ...updates,
  });
}

async function resolveGitTopLevel(workDir: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd: workDir,
    });
    const topLevel = stdout.trim();
    if (!topLevel) {
      throw new Error('git rev-parse returned an empty repository root');
    }
    return topLevel;
  } catch (error) {
    throw new Error(`HELIX worktree mode requires a git repository: ${formatExecFailure(error)}`);
  }
}

async function captureGitIdentity(workDir: string): Promise<GitIdentity> {
  const { stdout: headOut } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: workDir });
  const headSha = headOut.trim();
  if (!headSha) {
    throw new Error(`Unable to resolve HEAD for worktree source: ${workDir}`);
  }

  let branch: string | undefined;
  try {
    const { stdout: branchOut } = await execFileAsync('git', ['symbolic-ref', '--short', 'HEAD'], {
      cwd: workDir,
    });
    branch = branchOut.trim() || undefined;
  } catch {
    branch = undefined;
  }

  return {
    headSha,
    branch,
  };
}

async function maybeBootstrapWorktree(worktreeDir: string): Promise<string | undefined> {
  if (!(await pathExists(join(worktreeDir, 'pnpm-lock.yaml')))) {
    return undefined;
  }

  const bootstrapCommand = 'pnpm install --frozen-lockfile';
  try {
    await execFileAsync('pnpm', ['install', '--frozen-lockfile'], {
      cwd: worktreeDir,
    });
    return bootstrapCommand;
  } catch (error) {
    throw new Error(
      `Created worktree at ${worktreeDir}, but bootstrap failed (${bootstrapCommand}): ${formatExecFailure(error)}`,
    );
  }
}

async function statIfExists(targetPath: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(targetPath);
  } catch {
    return null;
  }
}

async function suggestUniqueWorktreePath(sourceWorkDir: string, label: string): Promise<string> {
  const repoName = basename(sourceWorkDir);
  const slug = slugify(label) || 'session';
  const trimmedSlug = slug.slice(0, 28);

  for (let attempt = 0; attempt < MAX_WORKTREE_NAME_ATTEMPTS; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-${attempt + 1}`;
    const candidate = join(dirname(sourceWorkDir), `${repoName}-wt-${trimmedSlug}${suffix}`);
    if (!(await pathExists(candidate))) {
      return candidate;
    }
  }

  return join(dirname(sourceWorkDir), `${repoName}-wt-${trimmedSlug}-${Date.now().toString(36)}`);
}

function normalizeRequestedPath(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeSourceRelativeFile(
  sourceWorkDir: string,
  candidate: string | undefined,
): string | undefined {
  const normalized = candidate?.trim();
  if (!normalized) {
    return undefined;
  }

  const absolutePath = resolve(sourceWorkDir, normalized);
  const relativePath = relative(sourceWorkDir, absolutePath);
  const outsideSource =
    relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath);

  return outsideSource ? undefined : relativePath;
}

function ensureExternalWorktreePath(sourceWorkDir: string, worktreeDir: string): void {
  const relativePath = relative(sourceWorkDir, worktreeDir);
  const isInsideSource =
    relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));

  if (isInsideSource) {
    throw new Error(
      `Worktree path must live outside the source workspace. Received: ${worktreeDir}`,
    );
  }
}

async function ensurePathAvailable(targetPath: string): Promise<void> {
  try {
    const entries = await readdir(targetPath);
    if (entries.length > 0) {
      throw new Error(`Worktree path already exists and is not empty: ${targetPath}`);
    }
  } catch (error) {
    if (isNotFoundError(error)) {
      return;
    }

    if (isNotDirectoryError(error)) {
      throw new Error(`Worktree path already exists and is not a directory: ${targetPath}`);
    }

    throw error;
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function buildWorktreeRecordsDir(sourceWorkDir: string): string {
  return join(sourceWorkDir, WORKTREE_STATE_DIR, WORKTREE_RECORDS_DIR);
}

function buildWorktreeRecordPath(sourceWorkDir: string, sessionId: string): string {
  return join(buildWorktreeRecordsDir(sourceWorkDir), `${sessionId}.json`);
}

function formatExecFailure(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }

  if (error instanceof Error) {
    const execError = error as Error & { stderr?: string; stdout?: string };
    const details = execError.stderr?.trim() || execError.stdout?.trim() || execError.message;
    return details.trim();
  }

  return String(error);
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error != null && 'code' in error && error.code === 'ENOENT';
}

function isNotDirectoryError(error: unknown): boolean {
  return typeof error === 'object' && error != null && 'code' in error && error.code === 'ENOTDIR';
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
