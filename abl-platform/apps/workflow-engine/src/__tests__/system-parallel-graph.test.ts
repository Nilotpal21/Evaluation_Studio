/**
 * Parallel Graph Integration Tests (system tier)
 *
 * Verifies runWorkflow() with inDegreeMap drives the executeDag path:
 * fan-out, fan-in, failure propagation, skip propagation, and selective barriers.
 *
 * These tests use real step executors (transform, condition, http) and mock only
 * external boundaries (persistence, publisher, globalThis.fetch).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  runWorkflow,
  CancellationError,
  type WorkflowExecutionInput,
  type WorkflowHandlerDeps,
  type ExecutionPersistence,
  type StatusPublisher,
  type RestateWorkflowCtx,
  type DurablePromiseHandle,
} from '../handlers/workflow-handler.js';
import type { TransformStep } from '../executors/transform-executor.js';
import type { ConditionStep } from '../executors/condition-executor.js';
import type { HttpStep } from '../executors/http-executor.js';
import type { LoopStep } from '../executors/loop-executor.js';
import type { WorkflowStep } from '../handlers/step-dispatcher.js';

// ---------------------------------------------------------------------------
// Mock external boundaries
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = vi.fn();
});
// Restore fetch after each test — avoid polluting other test files in the suite
import { afterEach } from 'vitest';
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePersistence(): ExecutionPersistence {
  return {
    createExecution: vi.fn(async () => {}),
    updateStepStatus: vi.fn(async () => {}),
    updateExecutionStatus: vi.fn(async () => {}),
  };
}

function makePublisher(): StatusPublisher {
  return { publish: vi.fn(async () => {}) };
}

function makeDeps(): WorkflowHandlerDeps {
  return { persistence: makePersistence(), publisher: makePublisher(), dispatcherDeps: {} };
}

function makeInput(overrides: Partial<WorkflowExecutionInput>): WorkflowExecutionInput {
  return {
    workflowId: 'wf-parallel',
    workflowName: 'parallel-test',
    tenantId: 't1',
    projectId: 'p1',
    triggerType: 'manual',
    triggerPayload: {},
    steps: [],
    ...overrides,
  };
}

function mockFetchOk(body: unknown): void {
  const res = {
    ok: true,
    status: 200,
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    headers: new Headers({ 'content-type': 'application/json' }),
  };
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(res);
}

/**
 * Build a minimal RestateWorkflowCtx where sys:cancel is already signalled.
 * After each non-suspension step, workflow-handler checks `sys:cancel.peek()`.
 * When it resolves `true`, a CancellationError is thrown — execution returns 'cancelled'.
 */
function makeCancelledRestateCtx(): RestateWorkflowCtx {
  const cancelHandle = Object.assign(Promise.resolve(true as unknown), {
    peek: vi.fn().mockResolvedValue(true as unknown),
    resolve: vi.fn().mockResolvedValue(undefined),
    get: vi.fn(() => cancelHandle),
  }) as unknown as DurablePromiseHandle<unknown>;

  return {
    sleep: vi.fn(() => Object.assign(new Promise<void>(() => {}), { orTimeout: vi.fn() })),
    run: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
    promise: vi.fn(() => cancelHandle) as RestateWorkflowCtx['promise'],
  };
}

// ---------------------------------------------------------------------------
// E2E-1: Diamond fan-out/fan-in completes both branches then join
// ---------------------------------------------------------------------------

describe('E2E-1: diamond fan-out/fan-in', () => {
  it('both parallel branches complete and join fires after both', async () => {
    const A: WorkflowStep = {
      id: 'A',
      name: 'A',
      type: 'transform',
      config: { inputExpression: '{{trigger.payload.x}}', outputVariable: 'varA' },
      onSuccessSteps: ['join'],
      canvasRouted: true,
    } as TransformStep & { onSuccessSteps: string[]; canvasRouted: boolean };

    const B: WorkflowStep = {
      id: 'B',
      name: 'B',
      type: 'transform',
      config: { inputExpression: '{{trigger.payload.y}}', outputVariable: 'varB' },
      onSuccessSteps: ['join'],
      canvasRouted: true,
    } as TransformStep & { onSuccessSteps: string[]; canvasRouted: boolean };

    // join has no onSuccessSteps → terminal_no_successors (last step)
    const join: WorkflowStep = {
      id: 'join',
      name: 'join',
      type: 'transform',
      config: { inputExpression: '{{vars.varA}}', outputVariable: 'joined' },
      canvasRouted: true,
    } as TransformStep & { canvasRouted: boolean };

    const result = await runWorkflow(
      makeInput({
        triggerPayload: { x: 10, y: 20 },
        steps: [A, B, join],
        inDegreeMap: { A: 0, B: 0, join: 2 },
      }),
      'exec-par-1',
      makeDeps(),
    );

    expect(result.status).toBe('completed');
    // Transform outputs land directly on ctx root (not ctx.vars)
    expect(result.context['varA']).toBe(10);
    expect(result.context['varB']).toBe(20);
    expect(result.context.steps['A'].status).toBe('completed');
    expect(result.context.steps['B'].status).toBe('completed');
    expect(result.context.steps['join'].status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// E2E-2: Branch failure — failed branch skip-signals successors while sibling continues
// ---------------------------------------------------------------------------

describe('E2E-2: branch failure — sibling path continues to merge', () => {
  it('join dispatches when one branch fails but another branch arrives', async () => {
    // A will fail (fetch throws network error); B succeeds
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Network failure'),
    );
    mockFetchOk({ ok: true });

    const A: WorkflowStep = {
      id: 'A',
      name: 'A',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/a',
      onSuccessSteps: ['join'],
      canvasRouted: true,
    } as HttpStep & { onSuccessSteps: string[]; canvasRouted: boolean };

    const B: WorkflowStep = {
      id: 'B',
      name: 'B',
      type: 'transform',
      config: { inputExpression: '{{trigger.payload.val}}', outputVariable: 'bVal' },
      onSuccessSteps: ['join'],
      canvasRouted: true,
    } as TransformStep & { onSuccessSteps: string[]; canvasRouted: boolean };

    const join: WorkflowStep = {
      id: 'join',
      name: 'join',
      type: 'transform',
      config: { inputExpression: '{{bVal}}', outputVariable: 'result' },
      canvasRouted: true,
    } as TransformStep & { canvasRouted: boolean };

    const result = await runWorkflow(
      makeInput({
        triggerPayload: { val: 42 },
        steps: [A, B, join],
        inDegreeMap: { A: 0, B: 0, join: 2 },
      }),
      'exec-par-2',
      makeDeps(),
    );

    expect(result.status).toBe('completed');
    expect(result.context.steps['A'].status).toBe('failed');
    expect(result.context.steps['B'].status).toBe('completed');
    expect(result.context.steps['join'].status).toBe('completed');
    expect(result.context['result']).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// E2E-3: Skip propagation — condition routes to A only; join fires anyway
// ---------------------------------------------------------------------------

describe('E2E-3: skip propagation — conditional skip satisfies join barrier', () => {
  it('join fires after A completes and B is conditionally skipped', async () => {
    // condition → A (activated), B (skipped) → join (inDegree 2)
    const condition: WorkflowStep = {
      id: 'cond',
      name: 'cond',
      type: 'condition',
      expression: 'true', // always routes to thenSteps
      thenSteps: ['A'],
      elseSteps: ['B'],
    } as unknown as WorkflowStep;

    const A: WorkflowStep = {
      id: 'A',
      name: 'A',
      type: 'transform',
      config: { inputExpression: '{{trigger.payload.val}}', outputVariable: 'aOut' },
      onSuccessSteps: ['join'],
      canvasRouted: true,
    } as TransformStep & { onSuccessSteps: string[]; canvasRouted: boolean };

    const B: WorkflowStep = {
      id: 'B',
      name: 'B',
      type: 'transform',
      config: { inputExpression: '{{trigger.payload.val}}', outputVariable: 'bOut' },
      onSuccessSteps: ['join'],
      canvasRouted: true,
    } as TransformStep & { onSuccessSteps: string[]; canvasRouted: boolean };

    const join: WorkflowStep = {
      id: 'join',
      name: 'join',
      type: 'transform',
      config: { inputExpression: '{{vars.aOut}}', outputVariable: 'joined' },
      canvasRouted: true,
    } as TransformStep & { canvasRouted: boolean };

    const result = await runWorkflow(
      makeInput({
        triggerPayload: { val: 99 },
        steps: [condition, A, B, join],
        inDegreeMap: { cond: 0, A: 1, B: 1, join: 2 },
      }),
      'exec-par-3',
      makeDeps(),
    );

    expect(result.status).toBe('completed');
    expect(result.context.steps['A'].status).toBe('completed');
    expect(result.context.steps['B']).toBeUndefined();
    expect(result.context.steps['join'].status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// E2E-4: Selective barrier — required predecessor skipped → REQUIRED_PREDECESSOR_SKIPPED
// ---------------------------------------------------------------------------

describe('E2E-4: selective barrier — required predecessor skipped fails join', () => {
  it('execution fails with REQUIRED_PREDECESSOR_SKIPPED when required branch skipped', async () => {
    // condition routes to B only, skipping A; join requires A
    // Use a template expression that resolves to boolean false via trigger payload
    const condition: WorkflowStep = {
      id: 'cond',
      name: 'cond',
      type: 'condition',
      expression: '{{trigger.payload.take_a}}',
      thenSteps: ['A'],
      elseSteps: ['B'],
    } as unknown as WorkflowStep;

    const A: WorkflowStep = {
      id: 'A',
      name: 'A',
      type: 'transform',
      config: { inputExpression: '{{trigger.payload.val}}', outputVariable: 'aOut' },
      onSuccessSteps: ['join'],
      canvasRouted: true,
    } as TransformStep & { onSuccessSteps: string[]; canvasRouted: boolean };

    const B: WorkflowStep = {
      id: 'B',
      name: 'B',
      type: 'transform',
      config: { inputExpression: '{{trigger.payload.val}}', outputVariable: 'bOut' },
      onSuccessSteps: ['join'],
      canvasRouted: true,
    } as TransformStep & { onSuccessSteps: string[]; canvasRouted: boolean };

    // join requires A — but A will be skipped
    const join: WorkflowStep = {
      id: 'join',
      name: 'join',
      type: 'transform',
      config: { inputExpression: '{{vars.aOut}}', outputVariable: 'joined' },
      requiredPredecessors: ['A'],
      canvasRouted: true,
    } as TransformStep & { requiredPredecessors: string[]; canvasRouted: boolean };

    const result = await runWorkflow(
      makeInput({
        triggerPayload: { val: 7, take_a: false },
        steps: [condition, A, B, join],
        inDegreeMap: { cond: 0, A: 1, B: 1, join: 2 },
      }),
      'exec-par-4',
      makeDeps(),
    );

    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('was skipped');
    expect(result.context.steps['A']).toBeUndefined();
    // join dispatched (B arrived) but failed inside due to required predecessor check
    expect(result.context.steps['join']?.status).toBe('failed');
    expect(result.context.steps['join']?.error?.code).toBe('REQUIRED_PREDECESSOR_SKIPPED');
  });
});

// ---------------------------------------------------------------------------
// E2E-5: Fan-out cap — step with >MAX_PARALLEL_BRANCHES successors fails
// ---------------------------------------------------------------------------

describe('E2E-5: fan-out cap — too many successors fails the execution', () => {
  it('execution fails with MAX_FAN_OUT_EXCEEDED when a root step has 11 successors', async () => {
    // Create a root step with 11 successors (MAX_PARALLEL_BRANCHES = 10)
    const successorIds = Array.from({ length: 11 }, (_, i) => `s${i}`);
    const fanout: WorkflowStep = {
      id: 'fanout',
      name: 'fanout',
      type: 'transform',
      config: { inputExpression: 'true', outputVariable: 'x' },
      onSuccessSteps: successorIds,
      canvasRouted: true,
    } as TransformStep & { onSuccessSteps: string[]; canvasRouted: boolean };

    const inDegreeMap: Record<string, number> = { fanout: 0 };
    for (const id of successorIds) inDegreeMap[id] = 1;

    const successors: WorkflowStep[] = successorIds.map((id) => ({
      id,
      name: id,
      type: 'transform',
      config: { inputExpression: 'true', outputVariable: id },
      canvasRouted: true,
    })) as unknown as WorkflowStep[];

    const result = await runWorkflow(
      makeInput({
        steps: [fanout, ...successors],
        inDegreeMap,
      }),
      'exec-par-5',
      makeDeps(),
    );

    expect(result.status).toBe('failed');
    expect(result.error?.message).toBe('MAX_FAN_OUT_EXCEEDED');
  });
});

// ---------------------------------------------------------------------------
// E2E-6: Cancellation during parallel execution
// ---------------------------------------------------------------------------

describe('E2E-6: cancellation mid-parallel — execution returns cancelled', () => {
  it('returns cancelled when sys:cancel fires after a parallel branch completes', async () => {
    const A: WorkflowStep = {
      id: 'A',
      name: 'A',
      type: 'transform',
      config: { inputExpression: '{{trigger.payload.val}}', outputVariable: 'aOut' },
      onSuccessSteps: ['join'],
      canvasRouted: true,
    } as TransformStep & { onSuccessSteps: string[]; canvasRouted: boolean };

    const B: WorkflowStep = {
      id: 'B',
      name: 'B',
      type: 'transform',
      config: { inputExpression: '{{trigger.payload.val}}', outputVariable: 'bOut' },
      onSuccessSteps: ['join'],
      canvasRouted: true,
    } as TransformStep & { onSuccessSteps: string[]; canvasRouted: boolean };

    const join: WorkflowStep = {
      id: 'join',
      name: 'join',
      type: 'transform',
      config: { inputExpression: '{{vars.aOut}}', outputVariable: 'joined' },
      canvasRouted: true,
    } as TransformStep & { canvasRouted: boolean };

    const result = await runWorkflow(
      makeInput({
        triggerPayload: { val: 5 },
        steps: [A, B, join],
        inDegreeMap: { A: 0, B: 0, join: 2 },
      }),
      'exec-par-6',
      makeDeps(),
      makeCancelledRestateCtx(),
    );

    expect(result.status).toBe('cancelled');
    // join's barrier was never fully satisfied — it was never dispatched
    expect(result.context.steps['join']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// E2E-7: Optional predecessor skipped — requiredPredecessors: [] (all optional)
// ---------------------------------------------------------------------------

describe('E2E-7: all-optional predecessors — skipped branch still satisfies barrier', () => {
  it('join completes when one branch skipped and requiredPredecessors is explicitly empty', async () => {
    const condition: WorkflowStep = {
      id: 'cond',
      name: 'cond',
      type: 'condition',
      expression: '{{trigger.payload.take_a}}',
      thenSteps: ['A'],
      elseSteps: ['B'],
    } as unknown as WorkflowStep;

    const A: WorkflowStep = {
      id: 'A',
      name: 'A',
      type: 'transform',
      config: { inputExpression: '{{trigger.payload.val}}', outputVariable: 'aOut' },
      onSuccessSteps: ['join'],
      canvasRouted: true,
    } as TransformStep & { onSuccessSteps: string[]; canvasRouted: boolean };

    const B: WorkflowStep = {
      id: 'B',
      name: 'B',
      type: 'transform',
      config: { inputExpression: '{{trigger.payload.val}}', outputVariable: 'bOut' },
      onSuccessSteps: ['join'],
      canvasRouted: true,
    } as TransformStep & { onSuccessSteps: string[]; canvasRouted: boolean };

    // Explicitly empty requiredPredecessors — all optional
    const join: WorkflowStep = {
      id: 'join',
      name: 'join',
      type: 'transform',
      config: { inputExpression: '{{vars.aOut}}', outputVariable: 'joined' },
      requiredPredecessors: [],
      canvasRouted: true,
    } as TransformStep & { requiredPredecessors: string[]; canvasRouted: boolean };

    const result = await runWorkflow(
      makeInput({
        triggerPayload: { val: 3, take_a: true },
        steps: [condition, A, B, join],
        inDegreeMap: { cond: 0, A: 1, B: 1, join: 2 },
      }),
      'exec-par-7',
      makeDeps(),
    );

    expect(result.status).toBe('completed');
    expect(result.context.steps['A'].status).toBe('completed');
    expect(result.context.steps['B']).toBeUndefined();
    expect(result.context.steps['join'].status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// E2E-8: Optional predecessor skipped — requiredPredecessors has required branch
// ---------------------------------------------------------------------------

describe('E2E-8: optional predecessor skipped — required predecessor completes; join runs', () => {
  it('join executes when optional branch skipped but required branch completed', async () => {
    // Condition routes to A only (B is optional for join)
    const condition: WorkflowStep = {
      id: 'cond',
      name: 'cond',
      type: 'condition',
      expression: '{{trigger.payload.take_a}}',
      thenSteps: ['A'],
      elseSteps: ['B'],
    } as unknown as WorkflowStep;

    const A: WorkflowStep = {
      id: 'A',
      name: 'A',
      type: 'transform',
      config: { inputExpression: '{{trigger.payload.val}}', outputVariable: 'aOut' },
      onSuccessSteps: ['join'],
      canvasRouted: true,
    } as TransformStep & { onSuccessSteps: string[]; canvasRouted: boolean };

    const B: WorkflowStep = {
      id: 'B',
      name: 'B',
      type: 'transform',
      config: { inputExpression: '{{trigger.payload.val}}', outputVariable: 'bOut' },
      onSuccessSteps: ['join'],
      canvasRouted: true,
    } as TransformStep & { onSuccessSteps: string[]; canvasRouted: boolean };

    // A is required, B is optional — A completes, B skipped
    const join: WorkflowStep = {
      id: 'join',
      name: 'join',
      type: 'transform',
      config: { inputExpression: '{{vars.aOut}}', outputVariable: 'joined' },
      requiredPredecessors: ['A'],
      canvasRouted: true,
    } as TransformStep & { requiredPredecessors: string[]; canvasRouted: boolean };

    const result = await runWorkflow(
      makeInput({
        triggerPayload: { val: 11, take_a: true },
        steps: [condition, A, B, join],
        inDegreeMap: { cond: 0, A: 1, B: 1, join: 2 },
      }),
      'exec-par-8',
      makeDeps(),
    );

    expect(result.status).toBe('completed');
    expect(result.context.steps['A'].status).toBe('completed');
    expect(result.context.steps['B']).toBeUndefined();
    expect(result.context.steps['join'].status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// E2E-9: Required predecessor skipped — both required; one skipped → REQUIRED_PREDECESSOR_SKIPPED
// ---------------------------------------------------------------------------

describe('E2E-9: both predecessors required; one skipped → join fails', () => {
  it('execution fails with REQUIRED_PREDECESSOR_SKIPPED when a required branch is skipped', async () => {
    // Condition routes to A only; both A and B are required for join
    const condition: WorkflowStep = {
      id: 'cond',
      name: 'cond',
      type: 'condition',
      expression: '{{trigger.payload.take_a}}',
      thenSteps: ['A'],
      elseSteps: ['B'],
    } as unknown as WorkflowStep;

    const A: WorkflowStep = {
      id: 'A',
      name: 'A',
      type: 'transform',
      config: { inputExpression: '{{trigger.payload.val}}', outputVariable: 'aOut' },
      onSuccessSteps: ['join'],
      canvasRouted: true,
    } as TransformStep & { onSuccessSteps: string[]; canvasRouted: boolean };

    const B: WorkflowStep = {
      id: 'B',
      name: 'B',
      type: 'transform',
      config: { inputExpression: '{{trigger.payload.val}}', outputVariable: 'bOut' },
      onSuccessSteps: ['join'],
      canvasRouted: true,
    } as TransformStep & { onSuccessSteps: string[]; canvasRouted: boolean };

    // Both A and B required — B is skipped → join fails
    const join: WorkflowStep = {
      id: 'join',
      name: 'join',
      type: 'transform',
      config: { inputExpression: '{{vars.aOut}}', outputVariable: 'joined' },
      requiredPredecessors: ['A', 'B'],
      canvasRouted: true,
    } as TransformStep & { requiredPredecessors: string[]; canvasRouted: boolean };

    const result = await runWorkflow(
      makeInput({
        triggerPayload: { val: 7, take_a: true },
        steps: [condition, A, B, join],
        inDegreeMap: { cond: 0, A: 1, B: 1, join: 2 },
      }),
      'exec-par-9',
      makeDeps(),
    );

    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('was skipped');
    expect(result.context.steps['B']).toBeUndefined();
    // join dispatched (A arrived) but failed inside due to required predecessor check
    expect(result.context.steps['join']?.status).toBe('failed');
    expect(result.context.steps['join']?.error?.code).toBe('REQUIRED_PREDECESSOR_SKIPPED');
  });
});

// ---------------------------------------------------------------------------
// E2E-10: Loop node on parallel branch — body executes sequentially; join waits
// ---------------------------------------------------------------------------

describe('E2E-10: loop node on parallel branch — join waits for loop completion', () => {
  it('join fires after loop finishes all iterations and parallel transform completes', async () => {
    // loopA iterates over 3 items, running bodyA each time
    const loopA: WorkflowStep = {
      id: 'loopA',
      name: 'loopA',
      type: 'loop',
      config: {
        collection: '{{trigger.payload.items}}',
        itemVariable: 'item',
        body: ['bodyA'],
      },
      onSuccessSteps: ['join'],
      canvasRouted: true,
    } as LoopStep & { onSuccessSteps: string[]; canvasRouted: boolean };

    const bodyA: WorkflowStep = {
      id: 'bodyA',
      name: 'bodyA',
      type: 'transform',
      // Loop variable is accessed as {{item}}, not {{vars.item}} — vars.X is blocked
      config: { inputExpression: '{{item}}', outputVariable: 'lastItem' },
      canvasRouted: false,
    } as TransformStep & { canvasRouted: boolean };

    const B: WorkflowStep = {
      id: 'B',
      name: 'B',
      type: 'transform',
      config: { inputExpression: '{{trigger.payload.extra}}', outputVariable: 'bOut' },
      onSuccessSteps: ['join'],
      canvasRouted: true,
    } as TransformStep & { onSuccessSteps: string[]; canvasRouted: boolean };

    const join: WorkflowStep = {
      id: 'join',
      name: 'join',
      type: 'transform',
      // bOut is written to outer ctx by B; readable as {{bOut}} (direct root access)
      config: { inputExpression: '{{bOut}}', outputVariable: 'result' },
      canvasRouted: true,
    } as TransformStep & { canvasRouted: boolean };

    const result = await runWorkflow(
      makeInput({
        triggerPayload: { items: [1, 2, 3], extra: 99 },
        // bodyA is NOT in inDegreeMap — it's a loop body step, not a DAG node
        steps: [loopA, bodyA, B, join],
        inDegreeMap: { loopA: 0, B: 0, join: 2 },
      }),
      'exec-par-10',
      makeDeps(),
    );

    expect(result.status).toBe('completed');
    // B wrote bOut=99 to outer ctx; proves join fired after both branches settled
    expect(result.context['bOut']).toBe(99);
    // lastItem is scoped to iteration context and does not propagate to outer context
    expect(result.context.steps['loopA'].status).toBe('completed');
    expect(result.context.steps['B'].status).toBe('completed');
    expect(result.context.steps['join'].status).toBe('completed');
  });
});

describe('E2E-11: loop node as fan-in target', () => {
  it('dispatches the loop only after all incoming branches settle', async () => {
    const A: WorkflowStep = {
      id: 'A',
      name: 'A',
      type: 'transform',
      config: { inputExpression: '{{trigger.payload.a}}', outputVariable: 'aOut' },
      onSuccessSteps: ['loopA'],
      canvasRouted: true,
    } as TransformStep & { onSuccessSteps: string[]; canvasRouted: boolean };

    const B: WorkflowStep = {
      id: 'B',
      name: 'B',
      type: 'transform',
      config: { inputExpression: '{{trigger.payload.b}}', outputVariable: 'bOut' },
      onSuccessSteps: ['loopA'],
      canvasRouted: true,
    } as TransformStep & { onSuccessSteps: string[]; canvasRouted: boolean };

    const loopA: WorkflowStep = {
      id: 'loopA',
      name: 'loopA',
      type: 'loop',
      config: {
        collection: '{{trigger.payload.items}}',
        itemVariable: 'item',
      },
      canvasRouted: true,
    } as LoopStep & { canvasRouted: boolean };

    const persistence = makePersistence();
    const result = await runWorkflow(
      makeInput({
        triggerPayload: { a: 1, b: 2, items: [1, 2] },
        steps: [A, B, loopA],
        inDegreeMap: { A: 0, B: 0, loopA: 2 },
      }),
      'exec-par-11',
      { ...makeDeps(), persistence },
    );

    const statusCalls = (persistence.updateStepStatus as ReturnType<typeof vi.fn>).mock.calls;
    const loopRunningIndex = statusCalls.findIndex(
      ([, , , stepId, status]) => stepId === 'loopA' && status === 'running',
    );
    const aCompletedIndex = statusCalls.findIndex(
      ([, , , stepId, status]) => stepId === 'A' && status === 'completed',
    );
    const bCompletedIndex = statusCalls.findIndex(
      ([, , , stepId, status]) => stepId === 'B' && status === 'completed',
    );

    expect(result.status).toBe('completed');
    expect(loopRunningIndex).toBeGreaterThan(aCompletedIndex);
    expect(loopRunningIndex).toBeGreaterThan(bCompletedIndex);
    expect(result.context.steps.loopA.status).toBe('completed');
  });
});
