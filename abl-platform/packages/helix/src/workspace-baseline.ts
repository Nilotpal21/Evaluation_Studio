import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import type {
  HelixConfig,
  Session,
  WorkspaceBaselineDrift,
  WorkspaceGitSnapshot,
} from './types.js';

const execFileAsync = promisify(execFile);

export async function captureWorkspaceGitSnapshot(
  workDir: string,
): Promise<WorkspaceGitSnapshot | undefined> {
  try {
    const { stdout: shaOut } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: workDir });
    const headSha = shaOut.trim();
    if (!headSha) {
      return undefined;
    }

    let branch: string | undefined;
    try {
      const { stdout: branchOut } = await execFileAsync(
        'git',
        ['symbolic-ref', '--short', 'HEAD'],
        { cwd: workDir },
      );
      branch = branchOut.trim() || undefined;
    } catch {
      branch = undefined;
    }

    return {
      workDir,
      headSha,
      branch,
      capturedAt: new Date().toISOString(),
    };
  } catch {
    return undefined;
  }
}

export async function detectStaleWorkspaceBaseline(
  config: Pick<HelixConfig, 'workDir' | 'invocationDir' | 'workspaceContext'>,
  session: Pick<Session, 'workspaceBaseline' | 'workspaceContext'>,
): Promise<WorkspaceBaselineDrift | null> {
  const baseline = session.workspaceBaseline;
  const invocationDir = config.invocationDir;

  if (
    session.workspaceContext?.mode === 'git-worktree' ||
    config.workspaceContext?.mode === 'git-worktree'
  ) {
    return null;
  }

  if (!baseline?.headSha || !invocationDir) {
    return null;
  }

  if (await isSameWorkspace(invocationDir, config.workDir)) {
    return null;
  }

  const invocationSnapshot = await captureWorkspaceGitSnapshot(invocationDir);
  if (!invocationSnapshot?.headSha || invocationSnapshot.headSha === baseline.headSha) {
    return null;
  }

  const sessionSnapshot = await captureWorkspaceGitSnapshot(config.workDir);
  return {
    baselineWorkDir: baseline.workDir,
    baselineHeadSha: baseline.headSha,
    baselineBranch: baseline.branch,
    invocationWorkDir: invocationSnapshot.workDir,
    invocationHeadSha: invocationSnapshot.headSha,
    invocationBranch: invocationSnapshot.branch,
    sessionWorkDir: config.workDir,
    sessionHeadSha: sessionSnapshot?.headSha,
    detectedAt: new Date().toISOString(),
  };
}

export function formatWorkspaceBaselineDrift(
  drift: WorkspaceBaselineDrift,
  stageName: string,
): string {
  const baselineRef = formatGitRef(drift.baselineHeadSha, drift.baselineBranch);
  const invocationRef = formatGitRef(drift.invocationHeadSha, drift.invocationBranch);
  return [
    `Stale clone baseline before ${stageName}: session workspace was pinned to ${baselineRef} in ${drift.baselineWorkDir},`,
    `but the invoking workspace ${drift.invocationWorkDir} is now at ${invocationRef}.`,
    'Refresh or recreate the clean clone from the current source tip before running regression so HELIX does not attribute upstream drift to this slice.',
  ].join(' ');
}

function formatGitRef(headSha: string, branch?: string): string {
  const shortSha = headSha.slice(0, 10);
  return branch ? `${branch}@${shortSha}` : shortSha;
}

async function isSameWorkspace(left: string, right: string): Promise<boolean> {
  try {
    return (await realpath(left)) === (await realpath(right));
  } catch {
    return resolve(left) === resolve(right);
  }
}
