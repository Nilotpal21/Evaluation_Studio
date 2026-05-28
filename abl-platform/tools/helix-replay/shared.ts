import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { exec, execFile } from 'node:child_process';
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import type {
  ReplayComparison,
  ReplayRunRecord,
  ReplayScenario,
  ReplaySessionSummary,
} from './types.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const REPLAY_BOOTSTRAP_MARKER = '.helix-replay-bootstrap.json';
const ACTIVE_REPLAY_MARKER = 'replay-active.json';

interface ReplayActiveProcessRecord {
  pid: number;
  scenarioId: string;
  startedAt: string;
}

export async function readScenario(scenarioPath: string): Promise<ReplayScenario> {
  const content = await readFile(resolve(scenarioPath), 'utf8');
  const scenario = JSON.parse(content) as ReplayScenario;

  if (scenario.version !== 1) {
    throw new Error(`Unsupported replay scenario version in ${scenarioPath}`);
  }
  if (!scenario.id || !scenario.jiraKey || !scenario.targetCommit || !scenario.baseCommit) {
    throw new Error(`Replay scenario ${scenarioPath} is missing required fields`);
  }

  return scenario;
}

export async function resolveScenarioGitRefs(
  sourceRepo: string,
  scenario: ReplayScenario,
): Promise<ReplayScenario> {
  const baseCommit = await resolveCommitSha(sourceRepo, scenario.baseCommit, 'baseCommit');
  const targetCommit = await resolveCommitSha(sourceRepo, scenario.targetCommit, 'targetCommit');

  try {
    await execFileAsync('git', ['merge-base', '--is-ancestor', baseCommit, targetCommit], {
      cwd: sourceRepo,
    });
  } catch {
    throw new Error(
      `Replay scenario ${scenario.id} has an invalid commit range: ${baseCommit.slice(0, 10)} is not an ancestor of ${targetCommit.slice(0, 10)}`,
    );
  }

  return {
    ...scenario,
    baseCommit,
    targetCommit,
  };
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export function buildRunId(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function defaultReplayWorktreeDir(
  sourceRepo: string,
  scenarioId: string,
  runId: string,
): string {
  const repoName = basename(sourceRepo);
  void runId;
  return join(tmpdir(), `${repoName}-replay-${scenarioId}-working`);
}

export async function createDetachedWorktree(
  sourceRepo: string,
  worktreeDir: string,
  baseCommit: string,
): Promise<void> {
  await execFileAsync('git', ['clone', '--shared', '--no-checkout', sourceRepo, worktreeDir], {
    cwd: dirname(worktreeDir),
  });
  await execFileAsync(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-C',
      worktreeDir,
      'checkout',
      '--force',
      '--detach',
      baseCommit,
    ],
    { cwd: worktreeDir },
  );
}

export async function prepareDetachedWorktree(
  sourceRepo: string,
  worktreeDir: string,
  baseCommit: string,
): Promise<void> {
  if (await hasReusableReplayClone(worktreeDir)) {
    await execFileAsync(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-C',
        worktreeDir,
        'checkout',
        '--force',
        '--detach',
        baseCommit,
      ],
      { cwd: sourceRepo },
    );
    await execFileAsync(
      'git',
      ['-c', 'core.hooksPath=/dev/null', '-C', worktreeDir, 'reset', '--hard', baseCommit],
      { cwd: sourceRepo },
    );
    await execFileAsync(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-C',
        worktreeDir,
        'clean',
        '-fdx',
        '-e',
        'node_modules',
        '-e',
        REPLAY_BOOTSTRAP_MARKER,
        '-e',
        '.helix/cache',
        '-e',
        '.helix/cache/**',
      ],
      { cwd: sourceRepo },
    );
    return;
  }

  await rm(worktreeDir, { recursive: true, force: true });
  await createDetachedWorktree(sourceRepo, worktreeDir, baseCommit);
}

async function hasReusableReplayClone(worktreeDir: string): Promise<boolean> {
  try {
    await access(join(worktreeDir, '.git'));
    return true;
  } catch {
    return false;
  }
}

export async function removeWorktree(sourceRepo: string, worktreeDir: string): Promise<void> {
  void sourceRepo;
  await rm(worktreeDir, { recursive: true, force: true });
}

export async function bootstrapWorktree(worktreeDir: string): Promise<void> {
  const markerPath = join(worktreeDir, REPLAY_BOOTSTRAP_MARKER);
  const lockHash = await hashFile(join(worktreeDir, 'pnpm-lock.yaml'));
  const nodeModulesPath = join(worktreeDir, 'node_modules');
  if (await hasReusableBootstrap(nodeModulesPath, markerPath, lockHash)) {
    return;
  }

  await execFileAsync('pnpm', ['install', '--frozen-lockfile'], {
    cwd: worktreeDir,
  });
  await writeJson(markerPath, {
    lockHash,
    bootstrappedAt: new Date().toISOString(),
  });
}

export async function stopExistingReplayProcess(worktreeDir: string): Promise<void> {
  const markerPath = getActiveReplayMarkerPath(worktreeDir);
  let record: ReplayActiveProcessRecord | undefined;

  try {
    record = JSON.parse(await readFile(markerPath, 'utf8')) as ReplayActiveProcessRecord;
  } catch {
    return;
  }

  if (!record || typeof record.pid !== 'number' || record.pid <= 0) {
    await rm(markerPath, { force: true });
    return;
  }

  if (isProcessAlive(record.pid)) {
    await terminateProcessTree(record.pid);
  }

  await rm(markerPath, { force: true });
}

export async function writeActiveReplayProcess(
  worktreeDir: string,
  record: ReplayActiveProcessRecord,
): Promise<void> {
  const markerPath = getActiveReplayMarkerPath(worktreeDir);
  await mkdir(dirname(markerPath), { recursive: true });
  await writeJson(markerPath, record);
}

export async function clearActiveReplayProcess(worktreeDir: string, pid?: number): Promise<void> {
  const markerPath = getActiveReplayMarkerPath(worktreeDir);
  if (pid == null) {
    await rm(markerPath, { force: true });
    return;
  }

  try {
    const record = JSON.parse(await readFile(markerPath, 'utf8')) as ReplayActiveProcessRecord;
    if (record.pid !== pid) {
      return;
    }
  } catch {
    return;
  }

  await rm(markerPath, { force: true });
}

export async function ensureHelixBuild(sourceRepo: string): Promise<void> {
  await execFileAsync('pnpm', ['--filter', '@agent-platform/helix', 'build'], {
    cwd: sourceRepo,
  });
}

export async function checkReplayModelEndpointReachability(
  host = 'api.openai.com',
): Promise<string | undefined> {
  try {
    await lookup(host);
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Replay blocked before HELIX launch: cannot resolve ${host} from this environment (${message}). Restore network or DNS access, then rerun the scenario.`;
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8');
}

export async function writeText(path: string, value: string): Promise<void> {
  await writeFile(path, value, 'utf8');
}

export async function findLatestSessionSummary(
  worktreeDir: string,
): Promise<ReplaySessionSummary | undefined> {
  const sessionDir = join(worktreeDir, '.helix', 'sessions');
  let entries: string[] = [];
  try {
    entries = await readdir(sessionDir);
  } catch {
    return undefined;
  }

  let latestSummary: ReplaySessionSummary | undefined;
  let latestUpdatedAt = '';

  for (const entry of entries) {
    const sessionPath = join(sessionDir, entry, 'session.json');
    try {
      const raw = await readFile(sessionPath, 'utf8');
      const session = JSON.parse(raw) as {
        id: string;
        state: string;
        pipelineName: string;
        currentStageIndex: number;
        currentSliceIndex: number;
        totalSlices: number;
        findings: unknown[];
        decisions: unknown[];
        commits: unknown[];
        updatedAt: string;
        error?: string;
      };
      if (session.updatedAt > latestUpdatedAt) {
        latestUpdatedAt = session.updatedAt;
        latestSummary = {
          id: session.id,
          state: session.state,
          pipelineName: session.pipelineName,
          currentStageIndex: session.currentStageIndex,
          currentSliceIndex: session.currentSliceIndex,
          totalSlices: session.totalSlices,
          commits: Array.isArray(session.commits) ? session.commits.length : 0,
          findings: Array.isArray(session.findings) ? session.findings.length : 0,
          decisions: Array.isArray(session.decisions) ? session.decisions.length : 0,
          updatedAt: session.updatedAt,
          error: session.error,
        };
      }
    } catch {
      // ignore unreadable sessions
    }
  }

  return latestSummary;
}

export async function computeComparison(
  sourceRepo: string,
  worktreeDir: string,
  scenario: ReplayScenario,
): Promise<ReplayComparison> {
  const targetChangedFiles = await listFilesForTargetCommit(sourceRepo, scenario.targetCommit);
  const actualChangedFiles = await listFilesForWorkingTree(worktreeDir, scenario.baseCommit);
  const commonFiles = targetChangedFiles.filter((file) => actualChangedFiles.includes(file));
  const targetPatchId = await computePatchId(
    `git -C ${shellQuote(sourceRepo)} diff ${shellQuote(scenario.baseCommit)} ${shellQuote(scenario.targetCommit)}`,
  );
  const actualPatchId = await computePatchId(
    `git -C ${shellQuote(worktreeDir)} diff ${shellQuote(scenario.baseCommit)}`,
  );

  return {
    targetPatchId,
    actualPatchId,
    exactPatchMatch:
      targetPatchId != null && actualPatchId != null && targetPatchId === actualPatchId,
    targetChangedFiles,
    actualChangedFiles,
    commonFiles,
    filePrecision: ratio(commonFiles.length, actualChangedFiles.length),
    fileRecall: ratio(commonFiles.length, targetChangedFiles.length),
    fileJaccard: ratio(
      commonFiles.length,
      new Set([...targetChangedFiles, ...actualChangedFiles]).size,
    ),
  };
}

async function listFilesForTargetCommit(
  sourceRepo: string,
  targetCommit: string,
): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'git',
    ['diff-tree', '--no-commit-id', '--name-only', '-r', targetCommit],
    {
      cwd: sourceRepo,
    },
  );
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

async function resolveCommitSha(
  sourceRepo: string,
  value: string,
  field: 'baseCommit' | 'targetCommit',
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', `${value}^{commit}`], {
      cwd: sourceRepo,
    });
    const sha = stdout.trim();
    if (!sha) {
      throw new Error('empty sha');
    }
    return sha;
  } catch {
    throw new Error(`Replay scenario ${field} does not resolve to a valid commit: ${value}`);
  }
}

async function listFilesForWorkingTree(worktreeDir: string, baseCommit: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['diff', '--name-only', baseCommit], {
    cwd: worktreeDir,
  });
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

async function computePatchId(diffCommand: string): Promise<string | null> {
  const { stdout } = await execAsync(`${diffCommand} | git patch-id --stable`);
  const firstToken = stdout.trim().split(/\s+/)[0];
  return firstToken || null;
}

export function summarizeRun(record: ReplayRunRecord): string {
  if (record.preflightError) {
    return `preflight-blocked exitCode=${record.exitCode ?? 'none'} reason=${record.preflightError}`;
  }
  const sessionBits = record.session
    ? `session=${record.session.id} state=${record.session.state} stage=${record.session.currentStageIndex} slice=${record.session.currentSliceIndex + 1}/${Math.max(record.session.totalSlices, 1)} commits=${record.session.commits}`
    : 'session=none';
  const compareBits = `exactPatchMatch=${record.comparison.exactPatchMatch} files=${record.comparison.commonFiles.length}/${record.comparison.targetChangedFiles.length} recall=${record.comparison.fileRecall.toFixed(2)} precision=${record.comparison.filePrecision.toFixed(2)}`;
  return `${sessionBits} ${compareBits}`;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }
  return numerator / denominator;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function hasReusableBootstrap(
  nodeModulesPath: string,
  markerPath: string,
  lockHash: string,
): Promise<boolean> {
  try {
    await access(nodeModulesPath);
  } catch {
    return false;
  }

  try {
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as { lockHash?: string };
    return marker.lockHash === lockHash;
  } catch {
    return false;
  }
}

function getActiveReplayMarkerPath(worktreeDir: string): string {
  return join(worktreeDir, '.helix', ACTIVE_REPLAY_MARKER);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminateProcessTree(pid: number): Promise<void> {
  const descendants = await collectDescendantPids(pid);
  for (const childPid of descendants.slice().reverse()) {
    try {
      process.kill(childPid, 'SIGTERM');
    } catch {
      // Ignore already-exited descendants.
    }
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Ignore already-exited process.
  }

  await delay(1_000);

  if (isProcessAlive(pid)) {
    const remainingDescendants = await collectDescendantPids(pid);
    for (const childPid of remainingDescendants.slice().reverse()) {
      try {
        process.kill(childPid, 'SIGKILL');
      } catch {
        // Ignore already-exited descendants.
      }
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Ignore already-exited process.
    }
  }
}

async function collectDescendantPids(pid: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-P', String(pid)]);
    const directChildren = stdout
      .split('\n')
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((value) => Number.isFinite(value));
    const nestedChildren = await Promise.all(
      directChildren.map((childPid) => collectDescendantPids(childPid)),
    );
    return [...directChildren, ...nestedChildren.flat()];
  } catch {
    return [];
  }
}

async function hashFile(path: string): Promise<string> {
  const content = await readFile(path);
  return createHash('sha256').update(content).digest('hex');
}
