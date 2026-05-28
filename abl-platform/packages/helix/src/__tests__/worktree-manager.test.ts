import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  listWorktreeLaunchRecords,
  loadWorktreeLaunchRecord,
  prepareWorktreeExecution,
  writeWorktreeLaunchRecord,
} from '../worktree-manager.js';

describe('worktree-manager', () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('creates detached git worktrees and persists launch records in the source repo', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-worktree-manager-'));
    const repoDir = join(tempDir, 'repo');
    await createGitRepo(repoDir);

    const prepared = await prepareWorktreeExecution(repoDir, {
      label: 'Slice 8 parity work',
      bootstrapInstall: false,
    });

    expect(await realpath(prepared.sourceWorkDir)).toBe(await realpath(repoDir));
    expect(basename(prepared.workDir)).toContain('repo-wt-slice-8-parity-work');
    expect(prepared.workspaceContext.mode).toBe('git-worktree');
    expect(prepared.workspaceContext.baseHeadSha).toBe(getHeadSha(repoDir));
    expect(getHeadSha(prepared.workDir)).toBe(getHeadSha(repoDir));
    expect(
      execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: prepared.workDir,
        encoding: 'utf-8',
      }).trim(),
    ).toBe('HEAD');

    await writeWorktreeLaunchRecord({
      sessionId: 'session-1',
      title: 'Slice 8 parity work',
      command: 'audit',
      sourceWorkDir: prepared.sourceWorkDir,
      worktreeDir: prepared.workDir,
      sessionDir: join(prepared.workDir, '.helix', 'sessions'),
      journalDir: join(prepared.workDir, 'docs', 'sdlc-logs'),
      createdAt: '2026-04-06T00:00:00.000Z',
      updatedAt: '2026-04-06T00:00:00.000Z',
      baseHeadSha: prepared.workspaceContext.baseHeadSha,
      baseBranch: prepared.workspaceContext.baseBranch,
      autoCreated: prepared.workspaceContext.autoCreated ?? true,
    });

    const loaded = await loadWorktreeLaunchRecord(prepared.sourceWorkDir, 'session-1');
    const listed = await listWorktreeLaunchRecords(prepared.sourceWorkDir);

    expect(loaded).toMatchObject({
      sessionId: 'session-1',
      worktreeDir: prepared.workDir,
      sourceWorkDir: prepared.sourceWorkDir,
    });
    expect(listed).toEqual([
      expect.objectContaining({
        sessionId: 'session-1',
        worktreeDir: prepared.workDir,
      }),
    ]);
  });

  it('copies requested source-only spec files into detached worktrees when they are absent from HEAD', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-worktree-manager-'));
    const repoDir = join(tempDir, 'repo');
    await createGitRepo(repoDir);

    const relativeSpecPath = 'docs/features/bruce-feedback.md';
    await mkdir(join(repoDir, 'docs', 'features'), { recursive: true });
    await writeFile(
      join(repoDir, relativeSpecPath),
      '# Bruce feedback spec\n\nUncommitted source-only notes.\n',
      'utf-8',
    );

    expect(
      execFileSync('git', ['status', '--short', '--', relativeSpecPath], {
        cwd: repoDir,
        encoding: 'utf-8',
      }).trim(),
    ).toBe(`?? ${relativeSpecPath}`);

    const prepared = await prepareWorktreeExecution(repoDir, {
      label: 'Bruce feedback interactive audit',
      bootstrapInstall: false,
      sourceRelativeFiles: [relativeSpecPath],
    });

    expect(prepared.syncedPaths).toEqual([relativeSpecPath]);
    expect(await readFile(join(prepared.workDir, relativeSpecPath), 'utf-8')).toBe(
      '# Bruce feedback spec\n\nUncommitted source-only notes.\n',
    );
  });
  it('pins the worktree to a specific git ref via headRef option', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-worktree-manager-headref-'));
    const repoDir = join(tempDir, 'repo');
    await createGitRepo(repoDir);

    // Default branch SHA
    const defaultSha = getHeadSha(repoDir);

    // Create a feature branch with an additional commit
    execFileSync('git', ['checkout', '-b', 'feature/x'], { cwd: repoDir });
    await writeFile(join(repoDir, 'feature.md'), 'feature work\n', 'utf-8');
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'feature commit'], { cwd: repoDir });
    const featureSha = getHeadSha(repoDir);
    expect(featureSha).not.toBe(defaultSha);

    // Switch back to main so the source repo HEAD is the older commit
    execFileSync('git', ['checkout', '-'], { cwd: repoDir });
    expect(getHeadSha(repoDir)).toBe(defaultSha);

    // Worktree pinned to feature branch even though source is on main
    const prepared = await prepareWorktreeExecution(repoDir, {
      label: 'feature audit',
      bootstrapInstall: false,
      headRef: 'feature/x',
    });

    expect(prepared.workspaceContext.baseHeadSha).toBe(featureSha);
    expect(getHeadSha(prepared.workDir)).toBe(featureSha);
    expect(prepared.workspaceContext.baseBranch).toBe('feature/x');
    // The feature commit's file should exist in the worktree
    const featureContent = await readFile(join(prepared.workDir, 'feature.md'), 'utf-8');
    expect(featureContent).toBe('feature work\n');
  });

  it('rejects unsafe headRef values to prevent shell injection', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-worktree-manager-unsafe-'));
    const repoDir = join(tempDir, 'repo');
    await createGitRepo(repoDir);

    await expect(
      prepareWorktreeExecution(repoDir, {
        label: 'malicious',
        bootstrapInstall: false,
        headRef: 'main; rm -rf /',
      }),
    ).rejects.toThrow(/unsafe ref/i);
  });
});

async function createGitRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'README.md'), '# helix worktree manager test\n', 'utf-8');

  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'helix@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'HELIX Test'], { cwd: dir });
  execFileSync('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });
}

function getHeadSha(dir: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).trim();
}
