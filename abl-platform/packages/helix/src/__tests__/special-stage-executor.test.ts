import { beforeEach, describe, expect, it, vi } from 'vitest';

const { ensureVerificationBootstrapMock } = vi.hoisted(() => ({
  ensureVerificationBootstrapMock: vi.fn(),
}));

vi.mock('../pipeline/verification-bootstrap.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pipeline/verification-bootstrap.js')>();
  return {
    ...actual,
    ensureVerificationBootstrap: ensureVerificationBootstrapMock,
  };
});

import { SpecialStageExecutor } from '../pipeline/special-stage-executor.js';

describe('SpecialStageExecutor', () => {
  beforeEach(() => {
    ensureVerificationBootstrapMock.mockReset();
  });

  it('reuses verification bootstrap cache instead of forcing a fresh bootstrap every run', async () => {
    ensureVerificationBootstrapMock.mockResolvedValue({
      version: 1,
      generatedAt: '2026-04-15T00:00:00.000Z',
      trustLevel: 'clean-worktree',
      scopeEntries: ['apps/studio'],
      scopedPackageDirs: ['apps/studio'],
      dirtyWorkspaceFiles: [],
      cleanedPaths: [],
      builtPackages: ['packages/shared-auth'],
      notes: ['Reused cached verification bootstrap state.'],
      typecheckBaseline: {
        criterionType: 'typecheck',
        command: 'pnpm --filter ./apps/studio exec tsc --noEmit',
        passed: true,
        signatures: [],
      },
    });

    const persist = vi.fn().mockResolvedValue(undefined);
    const journal = vi.fn().mockResolvedValue(undefined);

    const executor = new SpecialStageExecutor({
      config: { workDir: '/tmp/helix-replay' } as never,
      reporter: {} as never,
      modelRouter: {} as never,
      sessionManager: { persist } as never,
      emitProgress: vi.fn(),
      journal,
      failStageDueToTimeout: vi.fn() as never,
    });

    const session = {
      workItem: {
        scope: ['apps/studio'],
      },
    } as never;

    const stage = {
      name: 'Verification Bootstrap',
      type: 'bootstrap',
      description: 'Prepare verification substrate',
      model: { primary: { engine: 'codex-cli' } },
      canLoop: false,
      maxLoopIterations: 1,
    } as never;

    const result = await executor.executeVerificationBootstrap(
      session,
      stage,
      Date.now(),
      Date.now() + 60_000,
    );

    expect(ensureVerificationBootstrapMock).toHaveBeenCalledTimes(1);
    expect(ensureVerificationBootstrapMock.mock.calls[0]?.[2]?.force).toBeUndefined();
    expect(persist).toHaveBeenCalledWith(session);
    expect(journal).toHaveBeenCalled();
    expect(result.status).toBe('passed');
  });
});

// ─── INT-8: executeDuelingPlanGeneration dispatch wiring ─────
//
// Verifies that SpecialStageExecutor.executeDuelingPlanGeneration()
// delegates to the free function with the correct arguments and
// wires deps from this.deps.

describe('INT-8: SpecialStageExecutor.executeDuelingPlanGeneration dispatch', () => {
  it('delegates to executeDuelingPlanGeneration with deps wired from constructor', async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const journal = vi.fn().mockResolvedValue(undefined);
    const emitProgress = vi.fn();

    const executor = new SpecialStageExecutor({
      config: {
        workDir: '/tmp/helix-dispatch-test',
        sessionDir: '/tmp/helix-dispatch-test/sessions',
        enableDuelingPlanners: true,
      } as never,
      reporter: {} as never,
      modelRouter: {
        execute: vi.fn().mockResolvedValue({
          output: '',
          model: 'gpt-5.5',
          engine: 'codex-cli',
          turnsUsed: 1,
          durationMs: 100,
          error: 'simulated-error-for-dispatch-test',
        }),
      } as never,
      sessionManager: { persist } as never,
      emitProgress,
      journal,
    });

    const session = {
      id: 'dispatch-test-session',
      workItem: {
        id: 'work-1',
        type: 'feature-audit',
        title: 'Dispatch test',
        description: 'Test dispatch wiring',
        scope: ['src/feature.ts'],
        targetBranch: 'current',
        createdAt: '2026-04-19T00:00:00.000Z',
      },
      findings: [],
      decisions: [],
      slices: [],
      commits: [],
      journal: [],
      stageHistory: [],
      state: 'executing',
      currentStageIndex: 0,
      currentSliceIndex: 0,
      totalSlices: 0,
      pipelineName: 'test',
      pipelineVersion: 'test@1',
      startedAt: '2026-04-19T00:00:00.000Z',
      updatedAt: '2026-04-19T00:00:00.000Z',
      duelingPlanState: undefined,
      costByProvider: undefined,
    } as never;

    const stage = {
      name: 'Plan Generation',
      type: 'plan-generation',
      description: 'Generate plan',
      model: { primary: { engine: 'codex-cli', model: 'gpt-5.5' } },
      canLoop: false,
      maxLoopIterations: 1,
    } as never;

    const startTime = Date.now();
    const result = await executor.executeDuelingPlanGeneration(
      session,
      stage,
      startTime,
      startTime + 18 * 60_000,
    );

    // Both planners fail (mock returns error), so result should be 'failed'
    expect(result.status).toBe('failed');
    // The result confirms executeDuelingPlanGeneration was called (it returns
    // a proper StageResult, not undefined or a passthrough)
    expect(result.stageName).toBe('Plan Generation');
  });
});
