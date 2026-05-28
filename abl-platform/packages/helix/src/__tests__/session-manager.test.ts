import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { bugFixPipeline } from '../pipeline/templates/index.js';
import { buildDefaultEmbeddingProviderConfig } from '../runtime-config.js';
import { SessionManager } from '../session/session-manager.js';
import { writeWorktreeLaunchRecord } from '../worktree-manager.js';
import type {
  BootstrapMeta,
  HelixConfig,
  PlanArtifact,
  Slice,
  WorkItem,
  WorkspaceExecutionContext,
} from '../types.js';
import {
  PLAN_A_FIXTURE,
  PLAN_B_FIXTURE,
  PLAN_C_FIXTURE,
  DIVERGENCE_NOTES_FIXTURE,
} from './test-helpers/plan-fixtures.js';

describe('session-manager', () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('snapshots the pipeline template and version into persisted sessions', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-session-manager-'));
    const manager = new SessionManager(createConfig(tempDir));

    const session = await manager.create(createWorkItem(), bugFixPipeline);
    const raw = await readFile(join(tempDir, 'sessions', session.id, 'session.json'), 'utf-8');
    const persisted = JSON.parse(raw) as {
      pipelineName: string;
      pipelineVersion: string;
      pipelineSnapshot: unknown;
    };

    expect(session.pipelineName).toBe(bugFixPipeline.name);
    expect(session.pipelineVersion).toMatch(new RegExp(`^${bugFixPipeline.name}@`));
    expect(session.pipelineSnapshot).toEqual(bugFixPipeline);
    expect(persisted.pipelineName).toBe(bugFixPipeline.name);
    expect(persisted.pipelineVersion).toBe(session.pipelineVersion);
    expect(persisted.pipelineSnapshot).toEqual(bugFixPipeline);
  });

  it('captures the git baseline for sessions created in a repository workspace', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-session-manager-'));
    const repoDir = join(tempDir, 'repo');
    await createGitRepo(repoDir);
    const manager = new SessionManager(createConfig(repoDir));

    const session = await manager.create(createWorkItem(), bugFixPipeline);
    const raw = await readFile(join(repoDir, 'sessions', session.id, 'session.json'), 'utf-8');
    const persisted = JSON.parse(raw) as {
      workspaceBaseline?: { workDir: string; headSha?: string; branch?: string };
    };

    expect(session.workspaceBaseline).toMatchObject({
      workDir: repoDir,
      headSha: getHeadSha(repoDir),
    });
    expect(persisted.workspaceBaseline).toMatchObject({
      workDir: repoDir,
      headSha: getHeadSha(repoDir),
    });
  });

  it('persists the workspace execution context alongside the session metadata', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-session-manager-'));
    const repoDir = join(tempDir, 'repo');
    await createGitRepo(repoDir);
    const manager = new SessionManager(
      createConfig(repoDir, {
        workspaceContext: {
          mode: 'git-worktree',
          sourceWorkDir: repoDir,
          worktreeDir: join(tempDir, 'repo-wt'),
          baseHeadSha: getHeadSha(repoDir),
          autoCreated: true,
        },
      }),
    );

    const session = await manager.create(createWorkItem(), bugFixPipeline);
    const raw = await readFile(join(repoDir, 'sessions', session.id, 'session.json'), 'utf-8');
    const persisted = JSON.parse(raw) as {
      workspaceContext?: WorkspaceExecutionContext;
    };

    expect(session.workspaceContext).toMatchObject({
      mode: 'git-worktree',
      sourceWorkDir: repoDir,
    });
    expect(persisted.workspaceContext).toMatchObject({
      mode: 'git-worktree',
      sourceWorkDir: repoDir,
    });
  });

  it('persists bootstrap metadata and embedding shard paths for enabled embeddings', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-session-manager-'));
    const embeddingProvider = buildDefaultEmbeddingProviderConfig({
      workDir: tempDir,
      enabled: true,
    });
    const manager = new SessionManager(createConfig(tempDir, { embeddingProvider }));
    const bootstrapMeta: BootstrapMeta = {
      jiraKey: 'ABLP-778',
      jiraFetchSuccess: true,
      jiraFetchLatencyMs: 42,
      scopeInferenceMethod: 'deterministic',
      inferredScope: ['packages/helix'],
    };

    const session = await manager.create(createWorkItem(), bugFixPipeline, { bootstrapMeta });
    const raw = await readFile(join(tempDir, 'sessions', session.id, 'session.json'), 'utf-8');
    const persisted = JSON.parse(raw) as {
      bootstrapMeta?: BootstrapMeta;
      embeddingShardPaths?: {
        basePath: string;
        findingsShardPath: string;
        decisionsShardPath: string;
        consolidatedFindingsPath: string;
        consolidatedDecisionsPath: string;
      };
    };

    expect(session.bootstrapMeta).toEqual(bootstrapMeta);
    expect(session.embeddingShardPaths).toMatchObject({
      modelKey: 'bge-m3-1024',
      basePath: join(tempDir, '.helix/cache/embeddings/bge-m3-1024'),
      findingsShardPath: join(
        tempDir,
        '.helix/cache/embeddings/bge-m3-1024/findings',
        `${session.id}.jsonl`,
      ),
      decisionsShardPath: join(
        tempDir,
        '.helix/cache/embeddings/bge-m3-1024/decisions',
        `${session.id}.jsonl`,
      ),
      consolidatedFindingsPath: join(tempDir, '.helix/cache/embeddings/bge-m3-1024/findings.jsonl'),
      consolidatedDecisionsPath: join(
        tempDir,
        '.helix/cache/embeddings/bge-m3-1024/decisions.jsonl',
      ),
    });
    expect(persisted.bootstrapMeta).toEqual(bootstrapMeta);
    expect(persisted.embeddingShardPaths).toEqual(session.embeddingShardPaths);

    await expect(manager.load(session.id)).resolves.toMatchObject({
      bootstrapMeta,
      embeddingShardPaths: session.embeddingShardPaths,
    });
  });

  it('keeps bootstrap and embedding shard fields absent when embeddings are disabled', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-session-manager-'));
    const manager = new SessionManager(createConfig(tempDir));

    const session = await manager.create(createWorkItem(), bugFixPipeline);
    const raw = await readFile(join(tempDir, 'sessions', session.id, 'session.json'), 'utf-8');
    const persisted = JSON.parse(raw) as Record<string, unknown>;

    expect(session.bootstrapMeta).toBeUndefined();
    expect(session.embeddingShardPaths).toBeUndefined();
    expect(persisted).not.toHaveProperty('bootstrapMeta');
    expect(persisted).not.toHaveProperty('embeddingShardPaths');

    const loaded = await manager.load(session.id);
    expect(loaded.bootstrapMeta).toBeUndefined();
    expect(loaded.embeddingShardPaths).toBeUndefined();
  });

  it('persists bootstrap metadata without shard paths when embeddings are disabled', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-session-manager-'));
    const manager = new SessionManager(createConfig(tempDir));
    const bootstrapMeta: BootstrapMeta = {
      jiraKey: 'ABLP-778',
      jiraFetchSuccess: false,
      jiraFetchLatencyMs: 12,
      scopeInferenceMethod: 'empty',
      inferredScope: [],
      fallbackReason: 'not-found',
    };

    const session = await manager.create(createWorkItem(), bugFixPipeline, { bootstrapMeta });
    const raw = await readFile(join(tempDir, 'sessions', session.id, 'session.json'), 'utf-8');
    const persisted = JSON.parse(raw) as {
      bootstrapMeta?: BootstrapMeta;
      embeddingShardPaths?: unknown;
    };

    expect(session.bootstrapMeta).toEqual(bootstrapMeta);
    expect(session.embeddingShardPaths).toBeUndefined();
    expect(persisted.bootstrapMeta).toEqual(bootstrapMeta);
    expect(persisted).not.toHaveProperty('embeddingShardPaths');

    const loaded = await manager.load(session.id);
    expect(loaded).toMatchObject({ bootstrapMeta });
    expect(loaded.embeddingShardPaths).toBeUndefined();
  });

  it('loads and lists sessions stored in detached worktrees from source launch records', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-session-manager-'));
    const sourceDir = join(tempDir, 'repo');
    const worktreeDir = join(tempDir, 'repo-wt');
    await createGitRepo(sourceDir);
    await createGitRepo(worktreeDir);

    const worktreeConfig = createConfig(worktreeDir, {
      sessionDir: join(worktreeDir, '.helix', 'sessions'),
      journalDir: join(worktreeDir, 'docs', 'sdlc-logs'),
      workspaceContext: {
        mode: 'git-worktree',
        sourceWorkDir: sourceDir,
        worktreeDir,
        baseHeadSha: getHeadSha(sourceDir),
        autoCreated: true,
      },
    });
    const worktreeManager = new SessionManager(worktreeConfig);
    const session = await worktreeManager.create(createWorkItem(), bugFixPipeline);

    await writeWorktreeLaunchRecord({
      sessionId: session.id,
      title: session.workItem.title,
      command: 'fix',
      sourceWorkDir: sourceDir,
      worktreeDir,
      sessionDir: worktreeConfig.sessionDir,
      journalDir: worktreeConfig.journalDir,
      createdAt: session.startedAt,
      updatedAt: session.updatedAt,
      baseHeadSha: getHeadSha(sourceDir),
      autoCreated: true,
    });

    const sourceManager = new SessionManager(
      createConfig(sourceDir, {
        sessionDir: join(sourceDir, '.helix', 'sessions'),
        journalDir: join(sourceDir, 'docs', 'sdlc-logs'),
      }),
    );

    await expect(sourceManager.load(session.id)).resolves.toMatchObject({
      id: session.id,
      workspaceContext: {
        mode: 'git-worktree',
        sourceWorkDir: sourceDir,
        worktreeDir,
      },
    });
    await expect(sourceManager.list()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: session.id,
          title: session.workItem.title,
        }),
      ]),
    );
  });

  it('recovers from a truncated session.json using the backup copy', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-session-manager-'));
    const manager = new SessionManager(createConfig(tempDir));

    const session = await manager.create(createWorkItem(), bugFixPipeline);
    const sessionFile = join(tempDir, 'sessions', session.id, 'session.json');
    const backupFile = `${sessionFile}.bak`;

    expect(JSON.parse(await readFile(backupFile, 'utf-8'))).toMatchObject({
      id: session.id,
      workItem: { title: session.workItem.title },
    });

    await writeFile(sessionFile, '', 'utf-8');

    const recovered = await manager.load(session.id);
    const healedPrimary = JSON.parse(await readFile(sessionFile, 'utf-8')) as {
      id: string;
      workItem: { title: string };
    };

    expect(recovered.id).toBe(session.id);
    expect(healedPrimary).toMatchObject({
      id: session.id,
      workItem: { title: session.workItem.title },
    });
  });

  it('persists heartbeat metadata for long-running live sessions', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-session-manager-'));
    const manager = new SessionManager(createConfig(tempDir));

    const session = await manager.create(createWorkItem(), bugFixPipeline);
    const firstUpdatedAt = session.updatedAt;

    await manager.persistHeartbeat(session, {
      at: '2026-04-06T09:14:55.000Z',
      eventType: 'stage-progress',
      stage: 'Deep Scan',
      message: 'Heartbeat: still reading runtime routing files',
    });

    const raw = await readFile(join(tempDir, 'sessions', session.id, 'session.json'), 'utf-8');
    const persisted = JSON.parse(raw) as {
      updatedAt: string;
      heartbeat?: {
        at: string;
        eventType: string;
        stage?: string;
        message: string;
      };
    };

    expect(persisted.heartbeat).toMatchObject({
      at: '2026-04-06T09:14:55.000Z',
      eventType: 'stage-progress',
      stage: 'Deep Scan',
      message: 'Heartbeat: still reading runtime routing files',
    });
    expect(persisted.updatedAt >= firstUpdatedAt).toBe(true);
  });

  it('initializes failure advisory state for new and legacy sessions', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-session-manager-'));
    const manager = new SessionManager(createConfig(tempDir));

    const session = await manager.create(createWorkItem(), bugFixPipeline);
    expect(session.failureAdvisories).toEqual([]);
    expect(session.pendingFailureAdvisory).toBeUndefined();

    const sessionFile = join(tempDir, 'sessions', session.id, 'session.json');
    const persisted = JSON.parse(await readFile(sessionFile, 'utf-8')) as Record<string, unknown>;
    delete persisted['failureAdvisories'];
    delete persisted['pendingFailureAdvisory'];
    await writeFile(sessionFile, JSON.stringify(persisted, null, 2), 'utf-8');

    const loaded = await manager.load(session.id);
    expect(loaded.failureAdvisories).toEqual([]);
    expect(loaded.pendingFailureAdvisory).toBeUndefined();
  });

  it('persists slice proof packets as derived control-plane state', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-session-manager-'));
    const manager = new SessionManager(createConfig(tempDir));

    const session = await manager.create(createWorkItem(), bugFixPipeline);
    await manager.addFinding(session, {
      id: 'finding-proof',
      category: 'bug',
      severity: 'high',
      status: 'open',
      title: 'Proof packet finding',
      description: 'Ensure proof packets persist with slice state.',
      files: [{ path: 'packages/helix/src/pipeline/proof-packets.ts' }],
      discoveredBy: 'Deep Scan',
      createdAt: '2026-04-06T09:00:00.000Z',
      updatedAt: '2026-04-06T09:00:00.000Z',
    });

    const slices: Slice[] = [
      {
        index: 0,
        title: 'Persist slice proof packets',
        description: 'Capture durable proof for an implemented slice.',
        status: 'locked',
        findings: ['finding-proof'],
        dependencies: [],
        manifest: {
          entryConditions: [],
          fileContracts: [
            {
              path: 'packages/helix/src/pipeline/proof-packets.ts',
              action: 'create',
              reason: 'Build a durable proof artifact for slices.',
            },
          ],
          exportContracts: [],
        },
        testLock: {
          requiredTests: [
            {
              testFile: 'packages/helix/src/__tests__/session-manager.test.ts',
              description: 'Proof packets persist with the session',
              status: 'passing',
              coversFindings: ['finding-proof'],
              isNew: true,
            },
          ],
          regressionSuite: ['packages/helix/src/__tests__/control-plane-service.test.ts'],
          locked: true,
          lockedAt: '2026-04-06T09:05:00.000Z',
        },
        impactAnalysis: {
          directFiles: ['packages/helix/src/pipeline/proof-packets.ts'],
          dependentFiles: ['packages/helix/src/session/session-manager.ts'],
          affectedTests: [
            'packages/helix/src/__tests__/session-manager.test.ts',
            'packages/helix/src/__tests__/control-plane-service.test.ts',
          ],
          riskLevel: 'medium',
          notes: 'Proof packets must stay aligned with persisted slice state.',
        },
        legacyPaths: [],
        exitCriteria: [
          {
            id: 'typecheck',
            type: 'typecheck',
            description: 'TypeScript compiles',
            passed: true,
            detail: 'PASS — proof packet types compile cleanly.',
          },
        ],
        implementationCheckpoint: {
          output: 'Implemented proof packet generation and persistence.',
          diffHash: 'impl-diff-hash',
          capturedAt: '2026-04-06T09:04:00.000Z',
        },
        verificationCheckpoint: {
          diffHash: 'verify-diff-hash',
          capturedAt: '2026-04-06T09:05:00.000Z',
          criteria: [
            {
              criterionId: 'typecheck',
              criterionType: 'typecheck',
              detail: 'PASS — proof packet types compile cleanly.',
              capturedAt: '2026-04-06T09:05:00.000Z',
            },
          ],
        },
      },
    ];

    await manager.setSlices(session, slices);

    const raw = await readFile(join(tempDir, 'sessions', session.id, 'session.json'), 'utf-8');
    const persisted = JSON.parse(raw) as {
      slices: Array<{
        proofPacket?: {
          sliceNumber: number;
          manifestHash: string;
          proofHash: string;
          findingIds: string[];
          artifacts: {
            implementationDiffHash?: string;
            verificationDiffHash?: string;
          };
          files: {
            requiredTests: string[];
            regressionSuite: string[];
          };
          criteria: Array<{
            criterionId: string;
            passed: boolean;
            cached: boolean;
          }>;
        };
      }>;
    };

    expect(persisted.slices[0]?.proofPacket).toMatchObject({
      sliceNumber: 1,
      findingIds: ['finding-proof'],
      manifestHash: expect.any(String),
      proofHash: expect.any(String),
      artifacts: {
        implementationDiffHash: 'impl-diff-hash',
        verificationDiffHash: 'verify-diff-hash',
      },
      files: {
        requiredTests: ['packages/helix/src/__tests__/session-manager.test.ts'],
        regressionSuite: ['packages/helix/src/__tests__/control-plane-service.test.ts'],
      },
      criteria: [
        expect.objectContaining({
          criterionId: 'typecheck',
          passed: true,
          cached: true,
        }),
      ],
    });
  });
});

// ── UT-7: PlanArtifact JSON round-trip ──────────────────────────

describe('UT-7: PlanArtifact JSON round-trip through SessionManager', () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('persists and reloads duelingPlanState with full PlanArtifact fidelity', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-session-plan-'));
    const manager = new SessionManager(createConfig(tempDir));

    const session = await manager.create(createWorkItem(), bugFixPipeline);

    const planA: PlanArtifact = {
      output: '# Plan A\n\nOpenAI-generated plan for the bug fix.',
      costUsd: 0.42,
      engine: 'openai-api',
      model: 'gpt-5',
      capturedAt: '2026-04-19T10:00:00.000Z',
      durationMs: 12_500,
      turnsUsed: 3,
    };

    const planB: PlanArtifact = {
      output: '# Plan B\n\nClaude-generated plan for the bug fix.',
      costUsd: 0.38,
      engine: 'claude-code',
      model: 'opus',
      capturedAt: '2026-04-19T10:00:05.000Z',
      durationMs: 9_800,
      turnsUsed: 2,
      soloPass: false,
    };

    const planC: PlanArtifact = {
      output: '# Plan C\n\nCodex-reconciled plan (solo pass).',
      costUsd: 0.15,
      engine: 'codex-cli',
      model: 'gpt-5.5',
      capturedAt: '2026-04-19T10:00:12.000Z',
      durationMs: 6_400,
      turnsUsed: 1,
      soloPass: true,
    };

    session.duelingPlanState = {
      planA,
      planB,
      planC,
      divergenceNotes: 'Plan A prefers extract-first; Plan B prefers inline fix.',
    };

    await manager.persist(session);

    const loaded = await manager.load(session.id);

    expect(loaded.duelingPlanState).toBeDefined();
    expect(loaded.duelingPlanState?.planA).toEqual(planA);
    expect(loaded.duelingPlanState?.planB).toEqual(planB);
    expect(loaded.duelingPlanState?.planC).toEqual(planC);
    expect(loaded.duelingPlanState?.divergenceNotes).toBe(
      'Plan A prefers extract-first; Plan B prefers inline fix.',
    );
  });

  it('preserves optional soloPass: undefined when not set on PlanArtifact', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-session-plan-'));
    const manager = new SessionManager(createConfig(tempDir));

    const session = await manager.create(createWorkItem(), bugFixPipeline);

    const planA: PlanArtifact = {
      output: '# Solo plan without soloPass field',
      engine: 'openai-api',
      model: 'gpt-5',
      capturedAt: '2026-04-19T10:00:00.000Z',
      durationMs: 5_000,
      turnsUsed: 1,
    };

    session.duelingPlanState = { planA };
    await manager.persist(session);

    const loaded = await manager.load(session.id);

    expect(loaded.duelingPlanState?.planA).toBeDefined();
    expect(loaded.duelingPlanState?.planA?.engine).toBe('openai-api');
    // soloPass was not set, so it should not be defined after round-trip
    expect(loaded.duelingPlanState?.planA?.soloPass).toBeUndefined();
    // planB / planC were not set
    expect(loaded.duelingPlanState?.planB).toBeUndefined();
    expect(loaded.duelingPlanState?.planC).toBeUndefined();
  });

  it('UT-7 Phase 2: round-trips duelingPlanState with Phase 2 fixture constants', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-session-plan-'));
    const manager = new SessionManager(createConfig(tempDir));
    const session = await manager.create(createWorkItem(), bugFixPipeline);

    session.duelingPlanState = {
      planA: PLAN_A_FIXTURE,
      planB: PLAN_B_FIXTURE,
      planC: PLAN_C_FIXTURE,
      divergenceNotes: DIVERGENCE_NOTES_FIXTURE,
    };

    await manager.persist(session);
    const loaded = await manager.load(session.id);

    expect(loaded.duelingPlanState).toBeDefined();
    expect(loaded.duelingPlanState?.planA).toEqual(PLAN_A_FIXTURE);
    expect(loaded.duelingPlanState?.planB).toEqual(PLAN_B_FIXTURE);
    expect(loaded.duelingPlanState?.planC).toEqual(PLAN_C_FIXTURE);
    expect(loaded.duelingPlanState?.divergenceNotes).toBe(DIVERGENCE_NOTES_FIXTURE);

    // Verify engine types match fixture expectations
    expect(loaded.duelingPlanState?.planA?.engine).toBe('claude-code');
    expect(loaded.duelingPlanState?.planB?.engine).toBe('openai-api');
    expect(loaded.duelingPlanState?.planC?.engine).toBe('codex-cli');
  });

  it('round-trips costByProvider alongside duelingPlanState', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-session-plan-'));
    const manager = new SessionManager(createConfig(tempDir));

    const session = await manager.create(createWorkItem(), bugFixPipeline);

    session.costByProvider = {
      'openai-api:gpt-5': { totalUsd: 0.42, callCount: 1 },
      'claude-code:opus': { totalUsd: 0.38, callCount: 1 },
    };

    session.duelingPlanState = {
      planA: {
        output: '# Plan A',
        costUsd: 0.42,
        engine: 'openai-api',
        model: 'gpt-5',
        capturedAt: '2026-04-19T10:00:00.000Z',
        durationMs: 10_000,
        turnsUsed: 2,
      },
    };

    await manager.persist(session);
    const loaded = await manager.load(session.id);

    expect(loaded.costByProvider?.['openai-api:gpt-5']).toEqual({
      totalUsd: 0.42,
      callCount: 1,
    });
    expect(loaded.costByProvider?.['claude-code:opus']).toEqual({
      totalUsd: 0.38,
      callCount: 1,
    });
    expect(loaded.duelingPlanState?.planA?.costUsd).toBe(0.42);
  });
});

function createConfig(workDir: string, overrides: Partial<HelixConfig> = {}): HelixConfig {
  return {
    workDir,
    sessionDir: join(workDir, 'sessions'),
    journalDir: join(workDir, 'journals'),
    defaultModel: {
      engine: 'codex-cli',
      model: 'gpt-5.5',
      effort: 'medium',
      maxTurns: 20,
    },
    codexPath: 'codex',
    claudePath: 'claude',
    maxConcurrentOracles: 2,
    maxSliceRetries: 2,
    autoCommit: false,
    autoApprove: true,
    budgetLimitUsd: 25,
    verbose: false,
    ...overrides,
  };
}

function createWorkItem(): WorkItem {
  return {
    id: 'work-1',
    type: 'bug-fix',
    title: 'Persist pipeline snapshots',
    description: 'Make resume durable against template changes',
    scope: ['packages/helix'],
    targetBranch: 'current',
    createdAt: '2026-04-03T00:00:00.000Z',
  };
}

async function createGitRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'README.md'), '# session baseline test\n', 'utf-8');

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
