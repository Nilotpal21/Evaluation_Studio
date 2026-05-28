import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CommitManager } from '../pipeline/commit-manager.js';
import type { HelixConfig, ProgressReporter, Session, Slice } from '../types.js';

describe('commit-manager', () => {
  let workDir: string | null = null;

  afterEach(async () => {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
      workDir = null;
    }
  });

  it('can auto-commit a slice without invoking the manual checkpoint when approval is not required', async () => {
    workDir = await createGitRepo();
    await writeFile(join(workDir, 'src', 'feature.txt'), 'updated\n', 'utf-8');

    let checkpointCalls = 0;
    const reporter: ProgressReporter = {
      emit(): void {
        // no-op
      },
      async onQuestion(): Promise<string> {
        return 'n/a';
      },
      async onCheckpoint(): Promise<boolean> {
        checkpointCalls += 1;
        return false;
      },
    };

    const manager = new CommitManager({
      config: createConfig(workDir),
      reporter,
      emitProgress(): void {
        // no-op
      },
    });

    const session = createSession();
    const slice = createSlice();

    const commit = await manager.performSliceCommit(session, slice, 0, {
      requireApproval: false,
      checkpointSummary: { autonomy: 'Deferred bulk review' },
    });

    expect(commit).not.toBeNull();
    expect(commit?.message).toContain('[ABLP-321]');
    expect(checkpointCalls).toBe(0);

    const head = execFileSync('git', ['log', '-1', '--pretty=%B'], {
      cwd: workDir,
      encoding: 'utf-8',
    }).trim();
    expect(head).toContain('[ABLP-321]');
    expect(await readFile(join(workDir, 'src', 'feature.txt'), 'utf-8')).toBe('updated\n');
  });

  it('records manual checkpoint wait time for deadline accounting', async () => {
    workDir = await createGitRepo();
    await writeFile(join(workDir, 'src', 'feature.txt'), 'updated\n', 'utf-8');

    const reporter: ProgressReporter = {
      emit(): void {
        // no-op
      },
      async onQuestion(): Promise<string> {
        return 'n/a';
      },
      async onCheckpoint(): Promise<boolean> {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return true;
      },
    };

    const manager = new CommitManager({
      config: createConfig(workDir),
      reporter,
      emitProgress(): void {
        // no-op
      },
    });

    const telemetry: { approvalWaitMs?: number } = {};
    const commit = await manager.performSliceCommit(createSession(), createSlice(), 0, {
      requireApproval: true,
      checkpointTelemetry: telemetry,
    });

    expect(commit).not.toBeNull();
    expect(telemetry.approvalWaitMs).toBeGreaterThanOrEqual(20);
  });

  it('includes detailed slice scope in commit checkpoints', async () => {
    workDir = await createGitRepo();
    await writeFile(join(workDir, 'src', 'feature.txt'), 'updated\n', 'utf-8');

    let checkpointData: unknown;
    const reporter: ProgressReporter = {
      emit(): void {
        // no-op
      },
      async onQuestion(): Promise<string> {
        return 'n/a';
      },
      async onCheckpoint(_message, data): Promise<boolean> {
        checkpointData = data;
        return true;
      },
    };

    const manager = new CommitManager({
      config: createConfig(workDir),
      reporter,
      emitProgress(): void {
        // no-op
      },
    });

    const slice = createSlice();
    slice.exitCriteria = [
      {
        id: 'typecheck',
        type: 'typecheck',
        description: 'Typecheck passes',
        passed: true,
        detail: 'PASS — scoped typecheck succeeded',
      },
    ];

    await manager.performSliceCommit(createSession(), slice, 0, {
      requireApproval: true,
      checkpointSummary: {
        autonomy: 'high risk / low confidence',
        findings: [{ severity: 'high', title: 'Feature seam mismatch', status: 'open' }],
        dependencies: ['Slice 2: Wire consumers'],
      },
    });

    expect(checkpointData).toMatchObject({
      autonomy: 'high risk / low confidence',
      sliceDescription: 'Auto-commit low-risk text file',
      findings: [{ severity: 'high', title: 'Feature seam mismatch', status: 'open' }],
      dependencies: ['Slice 2: Wire consumers'],
      files: ['src/feature.txt'],
      requiredTests: [
        {
          path: 'src/feature.test.txt',
          status: 'passing',
          description: 'Document regression marker',
        },
      ],
      exitCriteriaItems: [
        {
          id: 'typecheck',
          passed: true,
          detail: 'PASS — scoped typecheck succeeded',
        },
      ],
    });
  });

  it('emits explicit progress across checkpoint and commit handoffs', async () => {
    workDir = await createGitRepo();
    await writeFile(join(workDir, 'src', 'feature.txt'), 'updated\n', 'utf-8');

    const progressMessages: string[] = [];
    const reporter: ProgressReporter = {
      emit(): void {
        // no-op
      },
      async onQuestion(): Promise<string> {
        return 'n/a';
      },
      async onCheckpoint(): Promise<boolean> {
        return true;
      },
    };

    const manager = new CommitManager({
      config: createConfig(workDir),
      reporter,
      emitProgress(event): void {
        progressMessages.push(event.message);
      },
    });

    const commit = await manager.performSliceCommit(createSession(), createSlice(), 0, {
      requireApproval: true,
    });

    expect(commit).not.toBeNull();
    expect(progressMessages).toEqual(
      expect.arrayContaining([
        'Commit checkpoint opened for slice 1: Update feature text',
        'Commit checkpoint approved for slice 1',
        'Preparing slice 1 for commit (1 file)',
        'Staging slice 1 files',
        'Creating commit for slice 1',
        expect.stringMatching(/^Committed slice 1 as [0-9a-f]{7}$/),
      ]),
    );
  });

  it('blocks slice commits when out-of-scope files are dirty', async () => {
    workDir = await createGitRepo();
    await writeFile(join(workDir, 'src', 'feature.txt'), 'updated\n', 'utf-8');
    await writeFile(
      join(workDir, 'src', 'unexpected.ts'),
      'export const unexpected = true;\n',
      'utf-8',
    );

    const progressMessages: string[] = [];
    const reporter: ProgressReporter = {
      emit(): void {
        // no-op
      },
      async onQuestion(): Promise<string> {
        return 'n/a';
      },
      async onCheckpoint(): Promise<boolean> {
        return true;
      },
    };

    const manager = new CommitManager({
      config: createConfig(workDir),
      reporter,
      emitProgress(event): void {
        progressMessages.push(event.message);
      },
    });

    const commit = await manager.performSliceCommit(createSession(), createSlice(), 0, {
      requireApproval: false,
    });

    expect(commit).toBeNull();
    expect(
      progressMessages.some((message) =>
        message.includes('Commit blocked: 1 out-of-scope files in working tree'),
      ),
    ).toBe(true);
    const headCount = execFileSync('git', ['rev-list', '--count', 'HEAD'], {
      cwd: workDir,
      encoding: 'utf-8',
    }).trim();
    expect(headCount).toBe('1');
  });

  it('allows dependent files that are part of the slice review scope', async () => {
    workDir = await createGitRepo();
    await writeFile(join(workDir, 'src', 'feature.txt'), 'updated\n', 'utf-8');
    await writeFile(
      join(workDir, 'src', 'dependent.ts'),
      'export const dependent = true;\n',
      'utf-8',
    );

    const reporter: ProgressReporter = {
      emit(): void {
        // no-op
      },
      async onQuestion(): Promise<string> {
        return 'n/a';
      },
      async onCheckpoint(): Promise<boolean> {
        return true;
      },
    };

    const manager = new CommitManager({
      config: createConfig(workDir),
      reporter,
      emitProgress(): void {
        // no-op
      },
    });

    const slice = createSlice();
    slice.impactAnalysis.dependentFiles = ['src/dependent.ts'];

    const commit = await manager.performSliceCommit(createSession(), slice, 0, {
      requireApproval: false,
    });

    expect(commit).not.toBeNull();
    const committedFiles = execFileSync('git', ['show', '--name-only', '--pretty=', 'HEAD'], {
      cwd: workDir,
      encoding: 'utf-8',
    });
    expect(committedFiles).toContain('src/feature.txt');
    expect(committedFiles).toContain('src/dependent.ts');
  });

  it('ignores untracked .claire workspace noise when committing a slice', async () => {
    workDir = await createGitRepo();
    await writeFile(join(workDir, 'src', 'feature.txt'), 'updated\n', 'utf-8');
    await mkdir(join(workDir, '.claire'), { recursive: true });
    await writeFile(join(workDir, '.claire', 'session.json'), '{"scratch":true}\n', 'utf-8');

    const reporter: ProgressReporter = {
      emit(): void {
        // no-op
      },
      async onQuestion(): Promise<string> {
        return 'n/a';
      },
      async onCheckpoint(): Promise<boolean> {
        return true;
      },
    };

    const manager = new CommitManager({
      config: createConfig(workDir),
      reporter,
      emitProgress(): void {
        // no-op
      },
    });

    const commit = await manager.performSliceCommit(createSession(), createSlice(), 0, {
      requireApproval: false,
    });

    expect(commit).not.toBeNull();
    const committedFiles = execFileSync('git', ['show', '--name-only', '--pretty=', 'HEAD'], {
      cwd: workDir,
      encoding: 'utf-8',
    });
    expect(committedFiles).toContain('src/feature.txt');
    expect(committedFiles).not.toContain('.claire/session.json');
  });

  it('ignores out-of-scope instruction docs and generated verifier noise when committing a slice', async () => {
    workDir = await createGitRepo();
    await writeFile(join(workDir, 'src', 'feature.txt'), 'updated\n', 'utf-8');
    await writeFile(join(workDir, 'src', 'agents.md'), '# package learnings\n', 'utf-8');
    await writeFile(
      join(workDir, 'src', 'next-env.d.ts'),
      '/// <reference types="next" />\n',
      'utf-8',
    );
    await writeFile(
      join(workDir, 'src', '.helix-typecheck-session-1234.json'),
      '{"scratch":true}\n',
      'utf-8',
    );

    const reporter: ProgressReporter = {
      emit(): void {
        // no-op
      },
      async onQuestion(): Promise<string> {
        return 'n/a';
      },
      async onCheckpoint(): Promise<boolean> {
        return true;
      },
    };

    const manager = new CommitManager({
      config: createConfig(workDir),
      reporter,
      emitProgress(): void {
        // no-op
      },
    });

    const commit = await manager.performSliceCommit(createSession(), createSlice(), 0, {
      requireApproval: false,
    });

    expect(commit).not.toBeNull();
    const committedFiles = execFileSync('git', ['show', '--name-only', '--pretty=', 'HEAD'], {
      cwd: workDir,
      encoding: 'utf-8',
    });
    expect(committedFiles).toContain('src/feature.txt');
    expect(committedFiles).not.toContain('src/agents.md');
    expect(committedFiles).not.toContain('src/next-env.d.ts');
    expect(committedFiles).not.toContain('src/.helix-typecheck-session-1234.json');
  });

  it('uses workspace reconcile advice to ignore out-of-scope debug files at commit time', async () => {
    workDir = await createGitRepo();
    await writeFile(join(workDir, 'src', 'feature.txt'), 'updated\n', 'utf-8');
    await mkdir(join(workDir, 'tmp'), { recursive: true });
    await writeFile(join(workDir, 'tmp', 'debug.log'), 'temporary scratch\n', 'utf-8');

    const reporter: ProgressReporter = {
      emit(): void {
        // no-op
      },
      async onQuestion(): Promise<string> {
        return 'n/a';
      },
      async onCheckpoint(): Promise<boolean> {
        return true;
      },
    };

    let reconcileCalls = 0;
    const manager = new CommitManager({
      config: createConfig(workDir),
      reporter,
      emitProgress(): void {
        // no-op
      },
      async reconcileOutOfScopeChanges(request) {
        reconcileCalls += 1;
        expect(request.outOfScopeChanges).toEqual(['tmp/debug.log']);
        return {
          summary: 'Ignored transient debug output.',
          ignoredFiles: ['tmp/debug.log'],
          blockingFiles: [],
        };
      },
    });

    const commit = await manager.performSliceCommit(createSession(), createSlice(), 0, {
      requireApproval: false,
      stageName: 'Implementation',
      workspaceReconcileModel: {
        primary: {
          engine: 'claude-code',
          model: 'opus',
        },
      },
    });

    expect(commit).not.toBeNull();
    expect(reconcileCalls).toBe(1);
    const committedFiles = execFileSync('git', ['show', '--name-only', '--pretty=', 'HEAD'], {
      cwd: workDir,
      encoding: 'utf-8',
    });
    expect(committedFiles).toContain('src/feature.txt');
    expect(committedFiles).not.toContain('tmp/debug.log');
  });

  it('ignores baseline-dirty out-of-scope files when staging slice commits', async () => {
    workDir = await createGitRepo();
    await writeFile(join(workDir, 'src', 'feature.txt'), 'updated\n', 'utf-8');
    await writeFile(
      join(workDir, 'src', 'unexpected.ts'),
      'export const unexpected = true;\n',
      'utf-8',
    );

    const reporter: ProgressReporter = {
      emit(): void {
        // no-op
      },
      async onQuestion(): Promise<string> {
        return 'n/a';
      },
      async onCheckpoint(): Promise<boolean> {
        return true;
      },
    };

    const manager = new CommitManager({
      config: createConfig(workDir),
      reporter,
      emitProgress(): void {
        // no-op
      },
    });

    const session = createSession();
    session.verificationBootstrap = {
      version: 1,
      generatedAt: '2026-04-01T00:00:00.000Z',
      trustLevel: 'dirty-worktree',
      scopeEntries: ['src/feature.txt'],
      scopedPackageDirs: [],
      dirtyWorkspaceFiles: ['src/unexpected.ts'],
      cleanedPaths: [],
      builtPackages: [],
      notes: [],
    };

    const commit = await manager.performSliceCommit(session, createSlice(), 0, {
      requireApproval: false,
    });

    expect(commit).not.toBeNull();
    const committedFiles = execFileSync('git', ['show', '--name-only', '--pretty=', 'HEAD'], {
      cwd: workDir,
      encoding: 'utf-8',
    });
    expect(committedFiles).toContain('src/feature.txt');
    expect(committedFiles).not.toContain('src/unexpected.ts');
  });
});

async function createGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'helix-commit-manager-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await mkdir(join(dir, 'node_modules', '.bin'), { recursive: true });
  await writeFile(join(dir, 'src', 'feature.txt'), 'initial\n', 'utf-8');
  await writeFile(join(dir, 'node_modules', '.bin', 'prettier'), '#!/bin/sh\nexit 0\n', 'utf-8');
  await chmod(join(dir, 'node_modules', '.bin', 'prettier'), 0o755);

  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'helix@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'HELIX Test'], { cwd: dir });
  execFileSync('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });

  return dir;
}

function createConfig(workDir: string): HelixConfig {
  return {
    workDir,
    sessionDir: join(workDir, '.helix', 'sessions'),
    journalDir: join(workDir, '.helix', 'journal'),
    defaultModel: {
      engine: 'codex-cli',
      model: 'gpt-5.5',
    },
    codexPath: 'codex',
    claudePath: 'claude',
    maxConcurrentOracles: 1,
    maxSliceRetries: 1,
    autoCommit: false,
    autoApprove: false,
    budgetLimitUsd: 25,
    verbose: false,
  };
}

function createSession(): Session {
  return {
    id: 'session-commit',
    workItem: {
      id: 'work-commit',
      type: 'feature-audit',
      title: 'Commit manager',
      description: 'Commit manager test',
      scope: ['src/feature.txt'],
      jiraKey: 'ABLP-321',
      targetBranch: 'current',
      createdAt: '2026-04-01T00:00:00.000Z',
    },
    pipelineName: 'Holistic Feature Audit',
    pipelineVersion: 'Holistic Feature Audit@123456789abc',
    state: 'committing',
    currentStageIndex: 0,
    currentSliceIndex: 0,
    totalSlices: 1,
    slices: [],
    findings: [],
    decisions: [],
    commits: [],
    journal: [],
    stageHistory: [],
    startedAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
  };
}

function createSlice(): Slice {
  return {
    index: 0,
    title: 'Update feature text',
    description: 'Auto-commit low-risk text file',
    status: 'locked',
    findings: [],
    dependencies: [],
    manifest: {
      entryConditions: [],
      fileContracts: [
        {
          path: 'src/feature.txt',
          action: 'modify',
          reason: 'Low-risk text update',
        },
      ],
      exportContracts: [],
    },
    testLock: {
      requiredTests: [
        {
          testFile: 'src/feature.test.txt',
          description: 'Document regression marker',
          status: 'passing',
          coversFindings: [],
          isNew: false,
        },
      ],
      regressionSuite: [],
      locked: true,
      lockedAt: '2026-04-01T00:00:00.000Z',
    },
    impactAnalysis: {
      directFiles: ['src/feature.txt'],
      dependentFiles: [],
      affectedTests: [],
      riskLevel: 'low',
      notes: 'Bounded text change.',
    },
    legacyPaths: [],
    exitCriteria: [],
  };
}
