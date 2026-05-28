import { describe, it, expect, vi } from 'vitest';
import {
  executeDag,
  getDagSkippedStepIds,
  WorkflowTerminatedError,
  type StepOutcome,
  type DagExecutorParams,
} from '../executors/dag-executor.js';
import type { WorkflowStep } from '../handlers/step-dispatcher.js';
import type { WorkflowContextData } from '../context/expression-resolver.js';
import { WorkflowStepError } from '../errors/step-errors.js';

// Minimal WorkflowStep for testing — only fields dag-executor reads.
function makeStep(
  id: string,
  onSuccessSteps: string[] = [],
  requiredPredecessors?: string[],
): WorkflowStep {
  return {
    id,
    name: id,
    type: 'http',
    method: 'GET',
    url: 'http://test',
    onSuccessSteps,
    ...(requiredPredecessors !== undefined ? { requiredPredecessors } : {}),
  } as unknown as WorkflowStep;
}

function makeCtx(): WorkflowContextData {
  return {
    trigger: { type: 'manual', payload: {} },
    workflow: { id: 'wf1', name: 'test', executionId: 'exec1' },
    tenant: { tenantId: 't1', projectId: 'p1' },
    steps: {},
    vars: {},
  };
}

// Build params with a fully-specified inDegreeMap.
function makeParams(
  steps: WorkflowStep[],
  inDegreeMap: Record<string, number>,
  rootStepIds: string[],
  executeStep: DagExecutorParams['executeStep'],
  ctx: WorkflowContextData,
): DagExecutorParams {
  return {
    stepIndex: new Map(steps.map((s) => [s.id, s])),
    inDegreeMap,
    rootStepIds,
    executeStep,
    ctx,
  };
}

// INT-3: barrier waits for N predecessors (diamond — join only fires after both A and B)
describe('INT-3: barrier waits for all predecessors before dispatching join', () => {
  it('join runs after A and B both complete', async () => {
    const dispatched: string[] = [];
    // A → join, B → join (inDegree = 2)
    const a = makeStep('a', ['join']);
    const b = makeStep('b', ['join']);
    const join = makeStep('join', []);

    const ctx = makeCtx();
    const executeStep = vi.fn(async (step: WorkflowStep): Promise<StepOutcome> => {
      dispatched.push(step.id);
      return { status: 'completed', activatedSuccessors: step.onSuccessSteps ?? [] };
    });

    const params = makeParams([a, b, join], { a: 0, b: 0, join: 2 }, ['a', 'b'], executeStep, ctx);

    await executeDag(params);

    // join must appear after both a and b
    expect(dispatched).toContain('join');
    expect(dispatched.indexOf('join')).toBeGreaterThan(dispatched.indexOf('a'));
    expect(dispatched.indexOf('join')).toBeGreaterThan(dispatched.indexOf('b'));
  });
});

// INT-4: single-predecessor failure — A fails, join is skip-cascaded (not dispatched)
// With OR-join semantics, a failed step notifies its successors with no activated
// successors (equivalent to skip). join has in-degree 1 → all predecessors skipped →
// skip-cascade fires; join is never dispatched. The DAG continues because
// ordinary branch failures are nonfatal.
describe('INT-4: failed step skip-cascades to sole successor', () => {
  it('does not throw and join is never dispatched when A is the only predecessor and fails', async () => {
    const dispatched: string[] = [];
    const a = makeStep('a', ['join']);
    const join = makeStep('join', []);

    const ctx = makeCtx();
    const executeStep = vi.fn(async (step: WorkflowStep): Promise<StepOutcome> => {
      dispatched.push(step.id);
      if (step.id === 'a') return { status: 'failed' };
      return { status: 'completed', activatedSuccessors: [] };
    });

    const params = makeParams([a, join], { a: 0, join: 1 }, ['a'], executeStep, ctx);

    await executeDag(params);
    expect(dispatched).not.toContain('join');
    expect(ctx.steps.join).toBeUndefined();
    expect(getDagSkippedStepIds(ctx).has('join')).toBe(true);
  });
});

// INT-9: OR-join — one parallel branch fails, other completes → join still fires
// Mirrors processai SimpleMerge: convergence node executes when at least one
// predecessor arrived, even if another path failed with no failure routing.
describe('INT-9: failed branch allows join when another branch arrived (in-degree 2)', () => {
  it('dispatches join when A fails and B completes without failing the DAG', async () => {
    const dispatched: string[] = [];
    const a = makeStep('a', ['join']);
    const b = makeStep('b', ['join']);
    const join = makeStep('join', []);

    const ctx = makeCtx();
    const executeStep = vi.fn(async (step: WorkflowStep): Promise<StepOutcome> => {
      dispatched.push(step.id);
      if (step.id === 'a') return { status: 'failed' };
      return { status: 'completed', activatedSuccessors: step.onSuccessSteps ?? [] };
    });

    const params = makeParams([a, b, join], { a: 0, b: 0, join: 2 }, ['a', 'b'], executeStep, ctx);

    await executeDag(params);
    // join was dispatched because B arrived (at least one predecessor arrived)
    expect(dispatched).toContain('join');
  });
});

// INT-5: fan-out cap — step with more than MAX_PARALLEL_BRANCHES successors throws
describe('INT-5: fan-out cap exceeded', () => {
  it('throws MAX_FAN_OUT_EXCEEDED when a step has too many successors', async () => {
    // Create 11 successors (MAX_PARALLEL_BRANCHES = 10)
    const successorIds = Array.from({ length: 11 }, (_, i) => `s${i}`);
    const fanout = makeStep('fanout', successorIds);
    const successors = successorIds.map((id) => makeStep(id, []));

    const inDegreeMap: Record<string, number> = { fanout: 0 };
    for (const id of successorIds) inDegreeMap[id] = 1;

    const ctx = makeCtx();
    const executeStep = vi.fn(async (step: WorkflowStep): Promise<StepOutcome> => {
      return { status: 'completed', activatedSuccessors: step.onSuccessSteps ?? [] };
    });

    const params = makeParams([fanout, ...successors], inDegreeMap, ['fanout'], executeStep, ctx);

    await expect(executeDag(params)).rejects.toThrow('MAX_FAN_OUT_EXCEEDED');
  });
});

// INT-6: skip propagation — one branch skipped, join still fires (both branches count toward barrier)
describe('INT-6: join fires when one branch is conditionally skipped', () => {
  it('join is dispatched when A completes and B is skipped (condition routing)', async () => {
    const dispatched: string[] = [];
    // condition → A (activated), condition skips B; both A and B → join
    const condition = makeStep('condition', ['a', 'b']); // all possible successors
    const a = makeStep('a', ['join']);
    const b = makeStep('b', ['join']);
    const join = makeStep('join', []);

    const ctx = makeCtx();
    const executeStep = vi.fn(async (step: WorkflowStep): Promise<StepOutcome> => {
      dispatched.push(step.id);
      if (step.id === 'condition') {
        // Only activate A — B is skipped (condition branch not taken)
        return { status: 'completed', activatedSuccessors: ['a'] };
      }
      return { status: 'completed', activatedSuccessors: step.onSuccessSteps ?? [] };
    });

    // condition: 0, a: 1 (from condition), b: 1 (from condition), join: 2 (from a+b)
    const params = makeParams(
      [condition, a, b, join],
      { condition: 0, a: 1, b: 1, join: 2 },
      ['condition'],
      executeStep,
      ctx,
    );

    await executeDag(params);

    // join must fire even though B was skipped
    expect(dispatched).toContain('join');
    expect(dispatched).not.toContain('b'); // B was not dispatched (skipped)
  });
});

// INT-7: selective barrier — optional predecessor skipped → join still starts
describe('INT-7: selective barrier — optional predecessor skipped → join starts', () => {
  it('join dispatched when optional predecessor B is skipped', async () => {
    const dispatched: string[] = [];
    // condition activates A, skips B; join requires only A (B is optional)
    const condition = makeStep('condition', ['a', 'b']);
    const a = makeStep('a', ['join']);
    const b = makeStep('b', ['join']);
    // join requires A only — B is optional
    const join = makeStep('join', [], ['a']);

    const ctx = makeCtx();
    const executeStep = vi.fn(async (step: WorkflowStep): Promise<StepOutcome> => {
      dispatched.push(step.id);
      if (step.id === 'condition') {
        return { status: 'completed', activatedSuccessors: ['a'] };
      }
      return { status: 'completed', activatedSuccessors: step.onSuccessSteps ?? [] };
    });

    const params = makeParams(
      [condition, a, b, join],
      { condition: 0, a: 1, b: 1, join: 2 },
      ['condition'],
      executeStep,
      ctx,
    );

    await executeDag(params);

    // join must fire since its required predecessor A completed
    expect(dispatched).toContain('join');
  });
});

// INT-8: requiredPredecessors is enforced by workflow-handler (executeStepWithSuspension),
// NOT by dag-executor. At the dag-executor layer the mock does not enforce it, so join
// still fires (B arrived). requiredPredecessors enforcement is covered in system-parallel-graph.test.ts.
describe('INT-8: dag-executor dispatches join when B arrives, regardless of requiredPredecessors', () => {
  it('join is dispatched when B arrives (requiredPredecessors enforcement is in workflow-handler)', async () => {
    const dispatched: string[] = [];
    // condition activates B, skips A; join has requiredPredecessors: ['a']
    const condition = makeStep('condition', ['a', 'b']);
    const a = makeStep('a', ['join']);
    const b = makeStep('b', ['join']);
    const join = makeStep('join', [], ['a']);

    const ctx = makeCtx();
    const executeStep = vi.fn(async (step: WorkflowStep): Promise<StepOutcome> => {
      dispatched.push(step.id);
      if (step.id === 'condition') {
        return { status: 'completed', activatedSuccessors: ['b'] };
      }
      return { status: 'completed', activatedSuccessors: step.onSuccessSteps ?? [] };
    });

    const params = makeParams(
      [condition, a, b, join],
      { condition: 0, a: 1, b: 1, join: 2 },
      ['condition'],
      executeStep,
      ctx,
    );

    // dag-executor itself does not enforce requiredPredecessors — join fires because B arrived.
    await executeDag(params);
    expect(dispatched).toContain('join');
    expect(dispatched).not.toContain('a'); // A was skipped (condition branch not taken)
  });
});

// Sequential fallback — empty inDegreeMap → steps run in order
describe('Sequential fallback: empty inDegreeMap dispatches first root only', () => {
  it('dispatches steps sequentially when inDegreeMap is empty', async () => {
    const dispatched: string[] = [];
    const a = makeStep('a', ['b']);
    const b = makeStep('b', []);

    const ctx = makeCtx();
    const executeStep = vi.fn(async (step: WorkflowStep): Promise<StepOutcome> => {
      dispatched.push(step.id);
      return { status: 'completed', activatedSuccessors: step.onSuccessSteps ?? [] };
    });

    const params: DagExecutorParams = {
      stepIndex: new Map([
        ['a', a],
        ['b', b],
      ]),
      inDegreeMap: {}, // empty — triggers sequential fallback
      rootStepIds: ['a'],
      executeStep,
      ctx,
    };

    await executeDag(params);

    expect(dispatched).toEqual(['a', 'b']);
  });
});

// workflow_terminated outcome bubbles WorkflowTerminatedError
describe('workflow_terminated outcome', () => {
  it('throws WorkflowTerminatedError with result payload', async () => {
    const a = makeStep('a', []);
    const ctx = makeCtx();
    const terminationResult = { status: 'rejected', reason: 'user cancelled' };

    const executeStep = vi.fn(async (): Promise<StepOutcome> => {
      return { status: 'workflow_terminated', result: terminationResult };
    });

    const params = makeParams([a], { a: 0 }, ['a'], executeStep, ctx);

    const err = await executeDag(params).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowTerminatedError);
    expect((err as WorkflowTerminatedError).result).toBe(terminationResult);
  });
});
