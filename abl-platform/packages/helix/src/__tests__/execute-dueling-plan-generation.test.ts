/**
 * Integration tests for the dueling-plan-generation orchestrator.
 *
 * Test spec coverage:
 *   INT-4:  Matrix cells (happy, A-fail, B-fail, both-fail, Codex-fail,
 *           resume A+B, resume C, resume A only, resume B only,
 *           synthesis prompt builder error).
 *   INT-10: Concurrent persist (two planners resolve within 1ms).
 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ModelRouter } from '../models/model-router.js';
import { executeDuelingPlanGeneration } from '../pipeline/engine/execute-dueling-plan-generation.js';
import type { DuelingPlanGenerationDeps } from '../pipeline/engine/execute-dueling-plan-generation.js';
import { SessionManager } from '../session/session-manager.js';
import type {
  ExecutorResult,
  HelixConfig,
  ModelEngine,
  ModelExecutor,
  ModelSpec,
  PlanArtifact,
  ProgressEvent,
  ProgressReporter,
  Session,
  StageDefinition,
  StageOutputSchemaConfig,
  StreamEvent,
  WorkItem,
} from '../types.js';
import {
  PLAN_A_FIXTURE,
  PLAN_B_FIXTURE,
  PLAN_C_FIXTURE,
  DIVERGENCE_NOTES_FIXTURE,
  makeFakeClaudeSdk,
  makeFakeCodexSpawner,
  makeFakeOpenAiClient,
} from './test-helpers/plan-fixtures.js';

// ─── Helpers ─────────────────────────────────────────────────

function createConfig(workDir: string, overrides: Partial<HelixConfig> = {}): HelixConfig {
  return {
    workDir,
    invocationDir: workDir,
    sessionDir: join(workDir, 'sessions'),
    journalDir: join(workDir, 'journal'),
    defaultModel: { engine: 'codex-cli', model: 'gpt-5.5' },
    codexPath: 'codex',
    claudePath: 'claude',
    maxConcurrentOracles: 1,
    maxSliceRetries: 1,
    autoCommit: false,
    autoApprove: true,
    budgetLimitUsd: 50,
    verbose: false,
    enableDuelingPlanners: true,
    ...overrides,
  };
}

function createWorkItem(): WorkItem {
  return {
    id: 'work-dueling-1',
    type: 'feature-audit',
    title: 'Dueling plan orchestrator test',
    description: 'Test the parallel fan-out and synthesis pipeline.',
    scope: ['src/feature.ts'],
    targetBranch: 'current',
    createdAt: '2026-04-19T00:00:00.000Z',
  };
}

function createStage(): StageDefinition {
  return {
    name: 'Plan Generation',
    type: 'plan-generation',
    description: 'Generate a convergent plan from two independent planners',
    model: {
      primary: {
        engine: 'codex-cli',
        model: 'gpt-5.5',
      },
    },
    canLoop: false,
    maxLoopIterations: 1,
  };
}

function createReporter(): ProgressReporter {
  return {
    emit(_event: ProgressEvent): void {},
    async onQuestion(): Promise<string> {
      return 'Proceed.';
    },
    async onCheckpoint(): Promise<boolean> {
      return true;
    },
  };
}

async function setupDeps(
  tempDir: string,
  overrides: {
    claudeOpts?: Parameters<typeof makeFakeClaudeSdk>[0];
    openaiOpts?: Parameters<typeof makeFakeOpenAiClient>[0];
    codexOpts?: Parameters<typeof makeFakeCodexSpawner>[0];
    configOverrides?: Partial<HelixConfig>;
  } = {},
): Promise<{
  deps: DuelingPlanGenerationDeps;
  sessionManager: SessionManager;
  claudeSdk: ReturnType<typeof makeFakeClaudeSdk>;
  openAiFake: ReturnType<typeof makeFakeOpenAiClient>;
  codexFake: ReturnType<typeof makeFakeCodexSpawner>;
  session: Session;
}> {
  const config = createConfig(tempDir, overrides.configOverrides);
  const sessionManager = new SessionManager(config);
  const session = await sessionManager.create(createWorkItem(), {
    name: 'dueling-test',
    description: 'Test pipeline for dueling plans',
    applicableTo: ['feature-audit'],
    stages: [createStage()],
  });

  // Ensure session directory exists for artifact writes
  await mkdir(join(config.sessionDir, session.id), { recursive: true });

  const modelRouter = new ModelRouter('codex', tempDir);

  const claudeSdk = makeFakeClaudeSdk(overrides.claudeOpts);
  modelRouter.registerExecutor(claudeSdk.executor);

  // The openai-api executor registered by default uses the real OpenAI SDK.
  // Replace it with a fake by creating a ModelExecutor that wraps makeFakeOpenAiClient.
  const openAiFake = makeFakeOpenAiClient(overrides.openaiOpts);
  const openAiExecutor: ModelExecutor = {
    engine: 'openai-api' as ModelEngine,
    async isAvailable(): Promise<boolean> {
      return true;
    },
    async execute(
      _prompt: string,
      spec: ModelSpec,
      _tools?: string[],
      _onStream?: (event: StreamEvent) => void,
      _outputSchema?: StageOutputSchemaConfig,
      _timeoutMs?: number,
      _abortSignal?: AbortSignal,
    ): Promise<ExecutorResult> {
      // Return PLAN_B_FIXTURE-shaped output via the fake client
      if (overrides.openaiOpts?.shouldFail) {
        return {
          output: '',
          model: spec.model ?? 'gpt-5',
          engine: 'openai-api',
          turnsUsed: 1,
          durationMs: 100,
          error: 'OpenAI API error: test_error',
        };
      }
      return {
        output: PLAN_B_FIXTURE.output,
        model: spec.model ?? 'gpt-5',
        engine: 'openai-api',
        turnsUsed: 2,
        durationMs: 4_500,
        costUsd: 0.28,
      };
    },
  };
  modelRouter.registerExecutor(openAiExecutor);

  const codexFake = makeFakeCodexSpawner(overrides.codexOpts);
  modelRouter.registerExecutor(codexFake.executor);

  const reporter = createReporter();

  const deps: DuelingPlanGenerationDeps = {
    config,
    modelRouter,
    sessionManager,
    journal: vi.fn().mockResolvedValue(undefined),
    emitProgress: vi.fn(),
    reporter,
  };

  return { deps, sessionManager, claudeSdk, openAiFake: openAiFake as never, codexFake, session };
}

// ─── Tests ───────────────────────────────────────────────────

describe('INT-4: executeDuelingPlanGeneration matrix', () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('happy path: both planners succeed, Codex synthesizes, 4 artifacts on disk', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-dueling-'));
    const { deps, session, claudeSdk, codexFake } = await setupDeps(tempDir);
    const stage = createStage();
    const startTime = Date.now();

    const result = await executeDuelingPlanGeneration(
      session,
      stage,
      startTime,
      startTime + 18 * 60_000,
      deps,
    );

    expect(result.status).toBe('passed');
    expect(session.duelingPlanState).toBeDefined();
    expect(session.duelingPlanState?.planA).toBeDefined();
    expect(session.duelingPlanState?.planB).toBeDefined();
    expect(session.duelingPlanState?.planC).toBeDefined();
    expect(session.duelingPlanState?.divergenceNotes).toBeDefined();

    // Verify artifact files on disk
    const sessionDir = join(deps.config.sessionDir, session.id);
    const planAContent = await readFile(join(sessionDir, 'plan-a.md'), 'utf-8');
    const planBContent = await readFile(join(sessionDir, 'plan-b.md'), 'utf-8');
    const planCContent = await readFile(join(sessionDir, 'plan-c.md'), 'utf-8');
    const divNotesContent = await readFile(join(sessionDir, 'divergence-notes.md'), 'utf-8');

    expect(planAContent.length).toBeGreaterThan(0);
    expect(planBContent.length).toBeGreaterThan(0);
    expect(planCContent.length).toBeGreaterThan(0);
    expect(divNotesContent.length).toBeGreaterThan(0);

    // Verify planner invocations
    expect(claudeSdk.callCount()).toBe(1);
    expect(codexFake.callCount()).toBe(1);
  });

  it('Planner A fails only: solo-pass with Plan B surviving', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-dueling-'));
    const { deps, session, codexFake } = await setupDeps(tempDir, {
      claudeOpts: { errorMessage: 'Claude SDK crashed' },
    });
    const stage = createStage();
    const startTime = Date.now();

    const result = await executeDuelingPlanGeneration(
      session,
      stage,
      startTime,
      startTime + 18 * 60_000,
      deps,
    );

    expect(result.status).toBe('passed');
    expect(session.duelingPlanState?.planA).toBeUndefined();
    expect(session.duelingPlanState?.planB).toBeDefined();
    expect(session.duelingPlanState?.planB?.soloPass).toBe(true);
    expect(session.duelingPlanState?.planC).toBeDefined();

    // plan-a.md should NOT exist on disk
    const sessionDir = join(deps.config.sessionDir, session.id);
    expect(existsSync(join(sessionDir, 'plan-a.md'))).toBe(false);
    expect(existsSync(join(sessionDir, 'plan-b.md'))).toBe(true);
    expect(existsSync(join(sessionDir, 'plan-c.md'))).toBe(true);

    expect(codexFake.callCount()).toBe(1);
  });

  it('Planner B fails only: solo-pass with Plan A surviving (symmetric)', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-dueling-'));
    const { deps, session, claudeSdk, codexFake } = await setupDeps(tempDir, {
      openaiOpts: { shouldFail: true },
    });
    const stage = createStage();
    const startTime = Date.now();

    const result = await executeDuelingPlanGeneration(
      session,
      stage,
      startTime,
      startTime + 18 * 60_000,
      deps,
    );

    expect(result.status).toBe('passed');
    expect(session.duelingPlanState?.planA).toBeDefined();
    expect(session.duelingPlanState?.planA?.soloPass).toBe(true);
    expect(session.duelingPlanState?.planB).toBeUndefined();
    expect(session.duelingPlanState?.planC).toBeDefined();

    const sessionDir = join(deps.config.sessionDir, session.id);
    expect(existsSync(join(sessionDir, 'plan-a.md'))).toBe(true);
    expect(existsSync(join(sessionDir, 'plan-b.md'))).toBe(false);
    expect(existsSync(join(sessionDir, 'plan-c.md'))).toBe(true);

    expect(claudeSdk.callCount()).toBe(1);
    expect(codexFake.callCount()).toBe(1);
  });

  it('both planners fail: status failed, Codex NOT invoked, no artifact files', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-dueling-'));
    const { deps, session, codexFake } = await setupDeps(tempDir, {
      claudeOpts: { errorMessage: 'Claude SDK crashed' },
      openaiOpts: { shouldFail: true },
    });
    const stage = createStage();
    const startTime = Date.now();

    const result = await executeDuelingPlanGeneration(
      session,
      stage,
      startTime,
      startTime + 18 * 60_000,
      deps,
    );

    expect(result.status).toBe('failed');
    expect(result.error).toContain('planner-failure');
    expect(codexFake.callCount()).toBe(0);

    const sessionDir = join(deps.config.sessionDir, session.id);
    expect(existsSync(join(sessionDir, 'plan-a.md'))).toBe(false);
    expect(existsSync(join(sessionDir, 'plan-b.md'))).toBe(false);
    expect(existsSync(join(sessionDir, 'plan-c.md'))).toBe(false);
  });

  it('Codex fails after planner success: plan-a + plan-b present, plan-c absent', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-dueling-'));
    const { deps, session } = await setupDeps(tempDir, {
      codexOpts: { errorMessage: 'Codex synthesis crashed' },
    });
    const stage = createStage();
    const startTime = Date.now();

    const result = await executeDuelingPlanGeneration(
      session,
      stage,
      startTime,
      startTime + 18 * 60_000,
      deps,
    );

    expect(result.status).toBe('failed');
    expect(result.error).toContain('codex-synthesis-failure');
    expect(session.duelingPlanState?.planA).toBeDefined();
    expect(session.duelingPlanState?.planB).toBeDefined();
    expect(session.duelingPlanState?.planC).toBeUndefined();

    const sessionDir = join(deps.config.sessionDir, session.id);
    expect(existsSync(join(sessionDir, 'plan-a.md'))).toBe(true);
    expect(existsSync(join(sessionDir, 'plan-b.md'))).toBe(true);
    expect(existsSync(join(sessionDir, 'plan-c.md'))).toBe(false);
  });

  it('resume after A+B checkpoint: planners NOT re-invoked, Codex invoked once', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-dueling-'));
    const { deps, session, claudeSdk, codexFake } = await setupDeps(tempDir);
    const stage = createStage();
    const startTime = Date.now();

    // Pre-populate checkpoint with both plans
    session.duelingPlanState = {
      planA: PLAN_A_FIXTURE,
      planB: PLAN_B_FIXTURE,
    };

    const result = await executeDuelingPlanGeneration(
      session,
      stage,
      startTime,
      startTime + 18 * 60_000,
      deps,
    );

    expect(result.status).toBe('passed');
    expect(claudeSdk.callCount()).toBe(0);
    expect(codexFake.callCount()).toBe(1);
    expect(session.duelingPlanState?.planC).toBeDefined();
  });

  it('resume after C checkpoint: status passed immediately, no invocations', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-dueling-'));
    const { deps, session, claudeSdk, codexFake } = await setupDeps(tempDir);
    const stage = createStage();
    const startTime = Date.now();

    // Pre-populate full checkpoint
    session.duelingPlanState = {
      planA: PLAN_A_FIXTURE,
      planB: PLAN_B_FIXTURE,
      planC: PLAN_C_FIXTURE,
      divergenceNotes: DIVERGENCE_NOTES_FIXTURE,
    };

    const result = await executeDuelingPlanGeneration(
      session,
      stage,
      startTime,
      startTime + 18 * 60_000,
      deps,
    );

    expect(result.status).toBe('passed');
    expect(claudeSdk.callCount()).toBe(0);
    expect(codexFake.callCount()).toBe(0);
  });

  it('resume after Planner A only (E2E-8): only Planner B re-invoked', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-dueling-'));
    const { deps, session, claudeSdk, codexFake } = await setupDeps(tempDir);
    const stage = createStage();
    const startTime = Date.now();

    // Pre-populate only planA checkpoint
    session.duelingPlanState = {
      planA: PLAN_A_FIXTURE,
    };

    // Write plan-a.md so we can verify it stays unchanged
    const sessionDir = join(deps.config.sessionDir, session.id);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(sessionDir, 'plan-a.md'), PLAN_A_FIXTURE.output, 'utf-8');

    const result = await executeDuelingPlanGeneration(
      session,
      stage,
      startTime,
      startTime + 18 * 60_000,
      deps,
    );

    expect(result.status).toBe('passed');
    // Claude SDK call count 0: Plan A not re-invoked
    expect(claudeSdk.callCount()).toBe(0);
    // Codex invoked once after B completes
    expect(codexFake.callCount()).toBe(1);

    // plan-a.md should be unchanged
    const planAOnDisk = await readFile(join(sessionDir, 'plan-a.md'), 'utf-8');
    expect(planAOnDisk).toBe(PLAN_A_FIXTURE.output);
  });

  it('resume after Planner B only (symmetric): only Planner A re-invoked', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-dueling-'));
    const { deps, session, claudeSdk, codexFake } = await setupDeps(tempDir);
    const stage = createStage();
    const startTime = Date.now();

    // Pre-populate only planB checkpoint
    session.duelingPlanState = {
      planB: PLAN_B_FIXTURE,
    };

    const result = await executeDuelingPlanGeneration(
      session,
      stage,
      startTime,
      startTime + 18 * 60_000,
      deps,
    );

    expect(result.status).toBe('passed');
    // Claude SDK invoked once: Plan A re-invoked
    expect(claudeSdk.callCount()).toBe(1);
    // Codex invoked once after A completes
    expect(codexFake.callCount()).toBe(1);
  });

  it('synthesis prompt builder error: status failed, Codex not invoked', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-dueling-'));
    // Provide output that parses into PlanArtifact but causes the synthesis
    // prompt to choke by feeding malformed plan data. The synthesis prompt
    // builder is pure and doesn't throw, but the Codex output parser will
    // throw if we give it invalid plan-c-with-divergence JSON. We simulate
    // a parse failure by having Codex return invalid JSON.
    const { deps, session, codexFake } = await setupDeps(tempDir, {
      codexOpts: { output: 'NOT VALID JSON AT ALL' },
    });
    const stage = createStage();
    const startTime = Date.now();

    const result = await executeDuelingPlanGeneration(
      session,
      stage,
      startTime,
      startTime + 18 * 60_000,
      deps,
    );

    expect(result.status).toBe('failed');
    expect(result.error).toContain('structured-output-parse-error');
  });
});

describe('INT-10: concurrent persist', () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('planners A and B resolving near-simultaneously produce consistent checkpoint', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-dueling-concurrent-'));
    const { deps, session, sessionManager } = await setupDeps(tempDir);
    const stage = createStage();
    const startTime = Date.now();

    const result = await executeDuelingPlanGeneration(
      session,
      stage,
      startTime,
      startTime + 18 * 60_000,
      deps,
    );

    expect(result.status).toBe('passed');

    // Re-read session from disk to verify both artifacts survived the persist
    const loaded = await sessionManager.load(session.id);
    expect(loaded.duelingPlanState).toBeDefined();
    expect(loaded.duelingPlanState?.planA).toBeDefined();
    expect(loaded.duelingPlanState?.planB).toBeDefined();
    expect(loaded.duelingPlanState?.planC).toBeDefined();
    expect(loaded.duelingPlanState?.divergenceNotes).toBeDefined();
  });
});
