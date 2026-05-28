/**
 * E2E Tests — Level 3: Advanced (Complex Flows)
 *
 * Focus: Loops with body steps, retries with exponential backoff,
 * mixed step type pipelines, deep expression resolution, multi-branch
 * condition chains, context accumulation across branches, Restate ctx
 * integration, concurrent data flows, and complex recovery patterns.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  runWorkflow,
  type WorkflowExecutionInput,
  type WorkflowHandlerDeps,
  type ExecutionPersistence,
  type StatusPublisher,
  type RestateWorkflowCtx,
  type RestatePromiseHandle,
} from '../handlers/workflow-handler.js';
import type { StepDispatcherDeps } from '../handlers/step-dispatcher.js';
import type { HttpStep } from '../executors/http-executor.js';
import type { ConditionStep } from '../executors/condition-executor.js';
import type { DelayStep } from '../executors/delay-executor.js';
import type { TransformStep } from '../executors/transform-executor.js';
import type { LoopStep } from '../executors/loop-executor.js';
import type { FunctionStep } from '../executors/function-executor.js';
import type { AgentInvocationStep, RuntimeClient } from '../executors/agent-invocation-executor.js';
import type { ToolCallStep, ToolExecutionClient } from '../executors/tool-call-executor.js';
import type { ParallelStep } from '../executors/parallel-executor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TrackingPublisher extends StatusPublisher {
  events: Array<{ channel: string; message: Record<string, unknown> }>;
}

function makePersistence(): ExecutionPersistence {
  return {
    createExecution: vi.fn().mockResolvedValue(undefined),
    updateStepStatus: vi.fn().mockResolvedValue(undefined),
    updateExecutionStatus: vi.fn().mockResolvedValue(undefined),
  };
}

function makePublisher(): TrackingPublisher {
  const events: TrackingPublisher['events'] = [];
  return {
    events,
    publish: vi.fn(async (channel: string, message: string) => {
      events.push({ channel, message: JSON.parse(message) });
    }),
  };
}

function makeInput(overrides?: Partial<WorkflowExecutionInput>): WorkflowExecutionInput {
  return {
    workflowId: 'wf-advanced',
    workflowName: 'advanced-e2e',
    tenantId: 'tenant-3',
    projectId: 'project-3',
    triggerType: 'webhook',
    triggerPayload: {},
    steps: [],
    ...overrides,
  };
}

function makeDeps(
  persistence: ExecutionPersistence,
  publisher: StatusPublisher,
  dispatcherDeps: StepDispatcherDeps = {},
): WorkflowHandlerDeps {
  return { persistence, publisher, dispatcherDeps };
}

function mockFetchJson(status: number, body: unknown): void {
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    headers: new Headers({ 'content-type': 'application/json' }),
  });
}

function mockFetchSequence(responses: Array<{ status: number; body: unknown }>): void {
  const mock = globalThis.fetch as ReturnType<typeof vi.fn>;
  for (const r of responses) {
    mock.mockResolvedValueOnce({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: vi.fn().mockResolvedValue(JSON.stringify(r.body)),
      headers: new Headers({ 'content-type': 'application/json' }),
    });
  }
}

function makeMockRestateCtx(): RestateWorkflowCtx & { runCalls: string[]; sleepCalls: number[] } {
  const runCalls: string[] = [];
  const sleepCalls: number[] = [];
  return {
    runCalls,
    sleepCalls,
    run: vi.fn(async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      runCalls.push(name);
      return fn();
    }),
    sleep: vi.fn(async (duration: number) => {
      sleepCalls.push(duration);
    }) as unknown as (duration: number) => RestatePromiseHandle<void>,
    promise: vi.fn().mockReturnValue({
      then: vi.fn(),
      catch: vi.fn(),
      finally: vi.fn(),
      peek: vi.fn().mockResolvedValue(undefined),
      resolve: vi.fn().mockResolvedValue(undefined),
      // get() returns a never-resolving promise so raceCancel's cancel signal
      // never fires in non-cancel tests — the main work always wins the race.
      get: vi.fn().mockReturnValue(new Promise(() => {})),
      [Symbol.toStringTag]: 'Promise',
    }),
  };
}

// ---------------------------------------------------------------------------
// Global mocks
// ---------------------------------------------------------------------------

vi.mock('@agent-platform/shared-kernel/security', () => ({
  assertUrlSafeForSSRF: vi.fn(),
}));

vi.mock('@agent-platform/shared-kernel/security/safe-fetch', () => ({
  assertUrlSafeForFetch: vi.fn().mockResolvedValue(undefined),
  safeFetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
}));

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ===========================================================================
// 1. Loop step — iterates over collection and sets vars per item
// ===========================================================================

describe('L3: Loop step execution', () => {
  it('includes end-target success edges in backend pathState', async () => {
    const delayStep: DelayStep = { id: 'delay-to-end', type: 'delay', duration: 'PT0.01S' };
    const input = makeInput({
      steps: [delayStep],
      edgeMap: {
        'delay-to-end': [
          {
            edgeId: 'edge-delay-end',
            sourceHandle: 'on_success',
            target: 'end-node',
            targetRuntimeId: 'end',
          },
        ],
        'never-ran': [
          {
            edgeId: 'edge-never-ran-end',
            sourceHandle: 'on_success',
            target: 'end-node',
            targetRuntimeId: 'end',
          },
        ],
      },
    });
    const publisher = makePublisher();
    const deps = makeDeps(makePersistence(), publisher);

    const result = await runWorkflow(input, 'exec-l3-end-pathstate', deps);

    expect(result.status).toBe('completed');
    const endCompletedEvent = publisher.events.find(
      (event) => event.message.type === 'step.completed' && event.message.stepId === 'end',
    );
    expect(endCompletedEvent?.message.pathState).toMatchObject({
      'edge-delay-end': 'completed',
    });
    expect(
      (endCompletedEvent?.message.pathState as Record<string, unknown> | undefined)?.[
        'edge-never-ran-end'
      ],
    ).toBeUndefined();
  });

  it('loop iterates over trigger payload array and sets item vars', async () => {
    const loopStep: LoopStep = {
      id: 'process-items',
      type: 'loop',
      config: {
        collection: '{{trigger.payload.items}}',
        itemVariable: 'currentItem',
      },
    };

    const input = makeInput({
      triggerPayload: { items: ['apple', 'banana', 'cherry'] },
      steps: [loopStep],
    });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(input, 'exec-l3-01', deps);

    expect(result.status).toBe('completed');
    const loopOut = result.context.steps['process-items'].output as {
      iterations: number;
    };
    expect(loopOut.iterations).toBe(3);
    expect(result.context.steps['process-items'].input).toMatchObject({
      collection: ['apple', 'banana', 'cherry'],
    });
    expect((result.context as Record<string, unknown>)['currentItem']).toBeUndefined();
    expect((result.context as Record<string, unknown>)['currentItem_index']).toBeUndefined();
    expect((result.context as Record<string, unknown>)['currentItem_count']).toBeUndefined();
  });

  it('loop with body steps executes body for each item', async () => {
    // Each iteration calls HTTP with the current item.
    mockFetchSequence([
      { status: 200, body: { processed: 'item-A' } },
      { status: 200, body: { processed: 'item-B' } },
    ]);

    const loopStep: LoopStep = {
      id: 'iterate',
      type: 'loop',
      config: {
        collection: '{{trigger.payload.tasks}}',
        itemVariable: 'task',
        outputField: 'results',
        body: ['process-task'],
        bodyOutputMappings: [
          { name: 'processed', expression: '{{context.steps.process-task.output.body.processed}}' },
          { name: 'sourceItem', expression: '{{context.task}}' },
        ],
        bodyEndStep: { id: 'loop-end', name: 'LoopEnd' },
      },
    };
    const processStep: HttpStep = {
      id: 'process-task',
      type: 'http',
      method: 'POST',
      url: 'https://api.example.com/process',
      body: '{{vars.task}}',
    };

    const input = makeInput({
      triggerPayload: { tasks: ['item-A', 'item-B'] },
      steps: [loopStep, processStep],
      edgeMap: {
        'loop-start': [
          {
            edgeId: 'edge-loop-start-process',
            sourceHandle: 'loop_body',
            target: 'process-task',
            sourceNodeType: 'loop_start',
            loopId: 'iterate',
          },
        ],
      },
    });
    const persistence = makePersistence();
    const publisher = makePublisher();
    const deps = makeDeps(persistence, publisher);

    const result = await runWorkflow(input, 'exec-l3-02', deps);

    expect(result.status).toBe('completed');
    const loopOut = result.context.steps['iterate'].output as {
      iterations: number;
      iterationOutputs: Array<{
        index: number;
        currentItem: unknown;
        output: Record<string, unknown> | null;
      }>;
      results?: Array<Record<string, unknown> | null>;
    };
    expect(loopOut.iterations).toBe(2);
    expect(result.context.steps['iterate'].input).toMatchObject({
      collection: ['item-A', 'item-B'],
    });
    expect(loopOut.iterationOutputs).toMatchObject([
      {
        index: 0,
        currentItem: 'item-A',
        output: { processed: 'item-A', sourceItem: 'item-A' },
      },
      {
        index: 1,
        currentItem: 'item-B',
        output: { processed: 'item-B', sourceItem: 'item-B' },
      },
    ]);
    expect(loopOut.results).toEqual([
      { processed: 'item-A', sourceItem: 'item-A' },
      { processed: 'item-B', sourceItem: 'item-B' },
    ]);
    const loopProgressUpdates = (
      persistence.updateStepStatus as ReturnType<typeof vi.fn>
    ).mock.calls.filter(
      ([, , , stepId, status, data]) =>
        stepId === 'iterate' &&
        status === 'running' &&
        Boolean(
          (
            data as
              | { stepData?: { output?: { iterationOutputs?: Array<Record<string, unknown>> } } }
              | undefined
          )?.stepData?.output?.iterationOutputs,
        ),
    );
    expect(loopProgressUpdates.length).toBeGreaterThan(0);
    expect(
      (
        loopProgressUpdates[0]?.[5] as {
          stepData?: { output?: { iterationOutputs?: Array<{ currentItem?: unknown }> } };
        }
      )?.stepData?.output?.iterationOutputs?.[0]?.currentItem,
    ).toBe('item-A');
    const persistedExecutionMetrics = (
      loopProgressUpdates.at(-1)?.[5] as {
        stepData?: {
          loopContext?: Array<{
            currentIndex?: number;
            currentItem?: unknown;
            steps?: Record<string, { stepId?: string; input?: unknown; output?: unknown }>;
          }>;
        };
      }
    ).stepData?.loopContext?.[0];
    expect(persistedExecutionMetrics).toMatchObject({ currentIndex: 0, currentItem: 'item-A' });
    expect(persistedExecutionMetrics?.steps?.['process-task']?.stepId).toBe('process-task');
    expect(persistedExecutionMetrics?.steps?.['process-task']?.input).toBeUndefined();
    expect(persistedExecutionMetrics?.steps?.['process-task']?.output).toBeUndefined();
    const loopProgressEvents = publisher.events.filter(
      (event) =>
        (event.message.type === 'step.started' || event.message.type === 'step.completed') &&
        event.message.stepId === 'iterate' &&
        (event.message.stepData as { output?: { iterationOutputs?: unknown[] } } | undefined)
          ?.output?.iterationOutputs,
    );
    expect(loopProgressEvents.length).toBeGreaterThan(0);
    const debugEvent = [...loopProgressEvents].reverse().find(
      (event) =>
        (
          event.message.stepData as
            | {
                loopContext?: Array<{
                  steps?: Record<string, { output?: unknown }>;
                }>;
              }
            | undefined
        )?.loopContext?.[0]?.steps?.['process-task']?.output !== undefined,
    );
    expect(debugEvent?.message.type).toBe('step.completed');
    const debugIteration = (
      debugEvent?.message.stepData as
        | {
            loopContext?: Array<{
              currentIndex?: number;
              currentItem?: unknown;
              steps?: Record<
                string,
                { stepId?: string; input?: unknown; output?: unknown; metrics?: unknown }
              >;
            }>;
          }
        | undefined
    )?.loopContext?.[0];
    expect(debugIteration).toMatchObject({ currentIndex: 0, currentItem: 'item-A' });
    expect(debugIteration?.steps?.['process-task']?.stepId).toBe('process-task');
    expect(debugIteration?.steps?.['process-task']?.output).toEqual({
      statusCode: 200,
      body: { processed: 'item-A' },
      headers: { 'content-type': 'application/json' },
    });
    expect(debugEvent?.message.iterationPathState).toMatchObject({
      iterate: {
        '0': {
          'edge-loop-start-process': 'completed',
        },
      },
    });
    const resultExecutionMetrics = (
      result.context.steps.iterate as {
        loopContext?: Array<{
          steps?: Record<string, { input?: unknown; output?: unknown }>;
        }>;
      }
    ).loopContext?.[0];
    expect(resultExecutionMetrics?.steps?.['process-task']?.input).toBeUndefined();
    expect(resultExecutionMetrics?.steps?.['process-task']?.output).toBeUndefined();
    expect(result.context.steps['process-task']).toBeUndefined();
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('loop outputField can assign iteration mapped outputs to a context variable', async () => {
    mockFetchSequence([
      { status: 200, body: { processed: 'item-A' } },
      { status: 200, body: { processed: 'item-B' } },
    ]);

    const loopStep: LoopStep = {
      id: 'iterate',
      type: 'loop',
      config: {
        collection: '{{trigger.payload.tasks}}',
        itemVariable: 'task',
        outputField: 'context.loopResults',
        body: ['process-task'],
        bodyOutputMappings: [
          { name: 'processed', expression: '{{context.steps.process-task.output.body.processed}}' },
        ],
        bodyEndStep: { id: 'loop-end', name: 'LoopEnd' },
      },
    };
    const processStep: HttpStep = {
      id: 'process-task',
      type: 'http',
      method: 'POST',
      url: 'https://api.example.com/process',
      body: '{{context.task}}',
    };

    const input = makeInput({
      triggerPayload: { tasks: ['item-A', 'item-B'] },
      steps: [loopStep, processStep],
    });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(input, 'exec-l3-loop-output-var', deps);
    const loopOut = result.context.steps.iterate.output as {
      iterationOutputs: unknown[];
      loopResults?: unknown;
    };

    expect(result.status).toBe('completed');
    expect(loopOut.loopResults).toBeUndefined();
    expect(loopOut.iterationOutputs).toHaveLength(2);
    expect((result.context as Record<string, unknown>).loopResults).toEqual([
      { processed: 'item-A' },
      { processed: 'item-B' },
    ]);
    expect(
      (result.context.steps.start as { output?: { loopResults?: unknown } }).output?.loopResults,
    ).toBeUndefined();
  });

  it('marks the loop failed when outputField targets immutable context.steps', async () => {
    const loopStep: LoopStep = {
      id: 'iterate',
      type: 'loop',
      config: {
        collection: '{{trigger.payload.items}}',
        itemVariable: 'item',
        mode: 'parallel',
        concurrencyLimit: 4,
        outputField: 'context.steps',
        body: ['delay-body'],
        bodyInDegreeMap: { 'delay-body': 0 },
      },
    };
    const delayStep: DelayStep = { id: 'delay-body', type: 'delay', duration: 'PT0.01S' };

    const input = makeInput({
      triggerPayload: { items: [1, 2, 3] },
      steps: [loopStep, delayStep],
    });
    const publisher = makePublisher();
    const deps = makeDeps(makePersistence(), publisher);

    const result = await runWorkflow(input, 'exec-l3-loop-outputfield-immutable-steps', deps);

    expect(result.status).toBe('failed');
    expect(result.error?.message).toBe('Cannot write immutable context property: steps');
    expect(result.context.steps.iterate.status).toBe('failed');
    expect(result.context.steps.iterate.error?.message).toBe(
      'Cannot write immutable context property: steps',
    );
    expect(result.context.steps['delay-body']).toBeUndefined();
    expect(publisher.events.some((event) => event.message.type === 'workflow.failed')).toBe(true);
  });

  it('routes a loop outputField failure through onFailureSteps', async () => {
    const loopStep: LoopStep = {
      id: 'iterate',
      type: 'loop',
      onFailureSteps: ['recover'],
      config: {
        collection: '{{trigger.payload.items}}',
        itemVariable: 'item',
        mode: 'parallel',
        concurrencyLimit: 4,
        outputField: 'context.steps',
        body: ['delay-body'],
        bodyInDegreeMap: { 'delay-body': 0 },
      },
    };
    const delayStep: DelayStep = { id: 'delay-body', type: 'delay', duration: 'PT0.01S' };
    const recoveryStep: DelayStep = { id: 'recover', type: 'delay', duration: 'PT0.01S' };

    const input = makeInput({
      triggerPayload: { items: [1, 2, 3] },
      steps: [loopStep, delayStep, recoveryStep],
      edgeMap: {
        iterate: [
          {
            edgeId: 'edge-loop-complete-recover',
            sourceHandle: 'on_complete',
            sourceNodeType: 'loop',
            target: 'recover',
          },
          {
            edgeId: 'edge-loop-failure-recover',
            sourceHandle: 'on_failure',
            sourceNodeType: 'loop',
            target: 'recover',
          },
        ],
      },
    });
    const publisher = makePublisher();
    const deps = makeDeps(makePersistence(), publisher);

    const result = await runWorkflow(input, 'exec-l3-loop-outputfield-failure-route', deps);

    expect(result.status).toBe('completed');
    expect(result.context.steps.iterate.status).toBe('failed');
    expect(result.context.steps.iterate.error?.message).toBe(
      'Cannot write immutable context property: steps',
    );
    expect(result.context.steps.recover.status).toBe('completed');
    expect(result.context.steps['delay-body']).toBeUndefined();
    expect(
      publisher.events.some(
        (event) => event.message.type === 'step.failed' && event.message.stepId === 'iterate',
      ),
    ).toBe(true);
    const recoveryCompletedEvent = publisher.events.find(
      (event) => event.message.type === 'step.completed' && event.message.stepId === 'recover',
    );
    expect(recoveryCompletedEvent?.message.pathState).toMatchObject({
      'edge-loop-failure-recover': 'completed',
    });
    expect(
      (recoveryCompletedEvent?.message.pathState as Record<string, unknown> | undefined)?.[
        'edge-loop-complete-recover'
      ],
    ).toBeUndefined();
    expect(publisher.events.some((event) => event.message.type === 'workflow.failed')).toBe(false);
  });

  it('loop body nodes can read prior body step output from iteration context.steps', async () => {
    mockFetchSequence([
      { status: 200, body: { processed: 'item-A' } },
      { status: 200, body: { accepted: true } },
    ]);

    const loopStep: LoopStep = {
      id: 'iterate',
      type: 'loop',
      config: {
        collection: '{{trigger.payload.tasks}}',
        itemVariable: 'task',
        body: ['process-task', 'send-task'],
      },
    };
    const processStep: HttpStep = {
      id: 'process-task',
      type: 'http',
      method: 'POST',
      url: 'https://api.example.com/process',
      body: '{{vars.task}}',
    };
    const sendStep: HttpStep = {
      id: 'send-task',
      type: 'http',
      method: 'POST',
      url: 'https://api.example.com/send',
      body: '{{context.steps.process-task.output.body.processed}}',
    };

    const input = makeInput({
      triggerPayload: { tasks: ['item-A'] },
      steps: [loopStep, processStep, sendStep],
    });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(input, 'exec-l3-loop-current-context-steps-read', deps);

    expect(result.status).toBe('completed');
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[1]?.[1]).toMatchObject({
      body: 'item-A',
    });
    expect(result.context.steps.iterate.loopContext?.[0]?.steps['send-task']?.status).toBe(
      'completed',
    );
    expect(
      result.context.steps.iterate.loopContext?.[0]?.steps['process-task']?.output,
    ).toBeUndefined();
  });

  it('loop body steps refresh parent step outputs completed after the iteration starts', async () => {
    mockFetchSequence([
      { status: 200, body: { token: 'parent-token' } },
      { status: 200, body: { accepted: true } },
    ]);
    const restateCtx = makeMockRestateCtx();
    restateCtx.sleep = vi.fn((async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }) as unknown as (duration: number) => RestatePromiseHandle<void>);

    const loopStep: LoopStep = {
      id: 'iterate',
      type: 'loop',
      config: {
        collection: '{{trigger.payload.items}}',
        itemVariable: 'item',
        body: ['delay-body', 'send-task'],
        bodyInDegreeMap: { 'delay-body': 0, 'send-task': 1 },
      },
    };
    const parentApi: HttpStep = {
      id: 'parent-api',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/token',
    };
    const delayStep: DelayStep = { id: 'delay-body', type: 'delay', duration: 'PT0.01S' };
    const sendStep: HttpStep = {
      id: 'send-task',
      type: 'http',
      method: 'POST',
      url: 'https://api.example.com/send',
      body: '{{context.steps.parent-api.output.body.token}}',
    };
    delayStep.onSuccessSteps = ['send-task'];

    const input = makeInput({
      triggerPayload: { items: [1] },
      steps: [loopStep, parentApi, delayStep, sendStep],
      inDegreeMap: { iterate: 0, 'parent-api': 0, 'delay-body': 0, 'send-task': 1 },
    });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(
      input,
      'exec-l3-loop-refreshes-parent-steps',
      deps,
      restateCtx,
    );

    expect(result.status).toBe('completed');
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[1]?.[1]).toMatchObject({
      body: 'parent-token',
    });
    expect(result.context.steps.iterate.loopContext?.[0]?.steps['send-task']?.status).toBe(
      'completed',
    );
    expect(result.context.steps['send-task']).toBeUndefined();
  });

  it('loop body function writes update only parent vars and start input', async () => {
    const loopStep: LoopStep = {
      id: 'iterate',
      type: 'loop',
      config: {
        collection: '{{trigger.payload.items}}',
        itemVariable: 'item',
        outputField: 'context.loopResults',
        body: ['write-local'],
        bodyOutputMappings: [{ name: 'value', expression: '{{context.scratch}}' }],
        bodyEndStep: { id: 'loop-end', name: 'LoopEnd' },
      },
    };
    const functionStep: FunctionStep = {
      id: 'write-local',
      type: 'function',
      config: {
        code: 'context.scratch = context.item;',
      },
    };

    const input = makeInput({
      triggerPayload: { items: [1, 2] },
      steps: [loopStep, functionStep],
    });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(input, 'exec-l3-loop-parent-context-isolation', deps);

    expect(result.status).toBe('completed');
    expect((result.context as Record<string, unknown>).scratch).toBe(2);
    expect((result.context as Record<string, unknown>).loopResults).toEqual([
      { value: 1 },
      { value: 2 },
    ]);
    expect(result.context.steps['write-local']).toBeUndefined();
    expect(result.context.steps.iterate.loopContext).toHaveLength(2);
    expect(result.context.steps.iterate.loopContext?.[0]).toMatchObject({
      currentIndex: 0,
      currentItem: 1,
      steps: { 'write-local': { status: 'completed' } },
    });
  });

  it('loop body function can write parent vars and start input directly', async () => {
    const loopStep: LoopStep = {
      id: 'iterate',
      type: 'loop',
      config: {
        collection: '{{trigger.payload.items}}',
        itemVariable: 'item',
        body: ['write-local'],
      },
    };
    const functionStep: FunctionStep = {
      id: 'write-local',
      type: 'function',
      config: {
        code: `
          context.loopVar = context.item;
        `,
      },
    };

    const input = makeInput({
      triggerPayload: { items: [1, 2] },
      steps: [loopStep, functionStep],
    });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(input, 'exec-l3-loop-function-direct-parent-writes', deps);

    expect(result.status).toBe('completed');
    expect((result.context as Record<string, unknown>).loopVar).toBe(2);
    expect(result.context.steps['write-local']).toBeUndefined();
  });

  it('parallel loop starts body iterations concurrently', async () => {
    let activeSleeps = 0;
    let maxActiveSleeps = 0;
    const restateCtx = makeMockRestateCtx();
    restateCtx.sleep = vi.fn((async () => {
      activeSleeps++;
      maxActiveSleeps = Math.max(maxActiveSleeps, activeSleeps);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeSleeps--;
    }) as unknown as (duration: number) => RestatePromiseHandle<void>);

    const loopStep: LoopStep = {
      id: 'parallel-loop',
      type: 'loop',
      config: {
        collection: '{{trigger.payload.items}}',
        itemVariable: 'item',
        mode: 'parallel',
        concurrencyLimit: 3,
        outputField: 'results',
        body: ['delay-body'],
        bodyInDegreeMap: { 'delay-body': 0 },
      },
    };
    const delayStep: DelayStep = { id: 'delay-body', type: 'delay', duration: 'PT0.01S' };

    const input = makeInput({
      triggerPayload: { items: [1, 2, 3] },
      steps: [loopStep, delayStep],
    });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(input, 'exec-l3-parallel-loop', deps, restateCtx);

    expect(result.status).toBe('completed');
    expect(maxActiveSleeps).toBe(3);
    const loopOut = result.context.steps['parallel-loop'].output as {
      iterationOutputs: Array<{
        index: number;
        currentItem: unknown;
        output: Record<string, unknown> | null;
      }>;
      results?: Array<Record<string, unknown> | null>;
    };
    expect(loopOut.iterationOutputs).toMatchObject([
      { index: 0, currentItem: 1, output: null },
      { index: 1, currentItem: 2, output: null },
      { index: 2, currentItem: 3, output: null },
    ]);
    expect(loopOut.results).toEqual([null, null, null]);
    expect(result.context.steps['delay-body']).toBeUndefined();
  });

  it('parallel loop staggers iteration starts within each concurrency batch', async () => {
    const restateCtx = makeMockRestateCtx();

    const loopStep: LoopStep = {
      id: 'parallel-loop',
      type: 'loop',
      config: {
        collection: '{{trigger.payload.items}}',
        itemVariable: 'item',
        mode: 'parallel',
        concurrencyLimit: 3,
        stagger: 25,
        body: ['delay-body'],
        bodyInDegreeMap: { 'delay-body': 0 },
      },
    };
    const delayStep: DelayStep = { id: 'delay-body', type: 'delay', duration: 'PT0.01S' };

    const input = makeInput({
      triggerPayload: { items: [1, 2, 3] },
      steps: [loopStep, delayStep],
    });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(input, 'exec-l3-parallel-loop-stagger', deps, restateCtx);

    expect(result.status).toBe('completed');
    expect(restateCtx.sleepCalls).toEqual(expect.arrayContaining([25, 50, 10, 10, 10]));
  });

  it('loop body branches start concurrently and a merged failure fails the loop node', async () => {
    mockFetchJson(404, { error: 'missing' });
    let activeSleeps = 0;
    let maxActiveSleeps = 0;
    const restateCtx = makeMockRestateCtx();
    restateCtx.sleep = vi.fn((async () => {
      activeSleeps++;
      maxActiveSleeps = Math.max(maxActiveSleeps, activeSleeps);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeSleeps--;
    }) as unknown as (duration: number) => RestatePromiseHandle<void>);

    const loopStep: LoopStep = {
      id: 'iterate',
      type: 'loop',
      config: {
        collection: '{{trigger.payload.items}}',
        itemVariable: 'item',
        onError: 'terminate',
        body: ['delay-2', 'delay-3', 'api-2'],
        bodyInDegreeMap: { 'delay-2': 0, 'delay-3': 0, 'api-2': 2 },
      },
    };
    const delay2: DelayStep = { id: 'delay-2', type: 'delay', duration: 'PT0.01S' };
    const delay3: DelayStep = { id: 'delay-3', type: 'delay', duration: 'PT0.01S' };
    const api2: HttpStep = {
      id: 'api-2',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/missing',
    };
    delay2.onSuccessSteps = ['api-2'];
    delay3.onSuccessSteps = ['api-2'];

    const input = makeInput({
      triggerPayload: { items: [1] },
      steps: [loopStep, delay2, delay3, api2],
    });
    const publisher = makePublisher();
    const deps = makeDeps(makePersistence(), publisher);

    const result = await runWorkflow(input, 'exec-l3-loop-body-merge-failure', deps, restateCtx);

    expect(result.status).toBe('failed');
    expect(maxActiveSleeps).toBe(2);
    expect(result.context.steps.iterate.status).toBe('failed');
    const loopContext = result.context.steps.iterate.loopContext as Array<{
      steps: Record<string, { status: string }>;
    }>;
    expect(loopContext[0]?.steps['delay-2']?.status).toBe('completed');
    expect(loopContext[0]?.steps['delay-3']?.status).toBe('completed');
    expect(loopContext[0]?.steps['api-2']?.status).toBe('failed');
    expect(result.context.steps['delay-2']).toBeUndefined();
    expect(result.context.steps['delay-3']).toBeUndefined();
    expect(result.context.steps['api-2']).toBeUndefined();
    expect(
      publisher.events.some(
        (event) => event.message.type === 'step.failed' && event.message.stepId === 'iterate',
      ),
    ).toBe(true);
  });

  it('loop body merge continues through sibling path when one predecessor branch fails', async () => {
    mockFetchJson(404, { error: 'missing' });

    const loopStep: LoopStep = {
      id: 'iterate',
      type: 'loop',
      config: {
        collection: '{{trigger.payload.items}}',
        itemVariable: 'item',
        onError: 'continue',
        body: ['delay-ok', 'api-fail', 'after-merge'],
        bodyInDegreeMap: { 'delay-ok': 0, 'api-fail': 0, 'after-merge': 2 },
      },
    };
    const delayOk: DelayStep = { id: 'delay-ok', type: 'delay', duration: 'PT0.01S' };
    const apiFail: HttpStep = {
      id: 'api-fail',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/missing',
    };
    const afterMerge: DelayStep = { id: 'after-merge', type: 'delay', duration: 'PT0.01S' };
    delayOk.onSuccessSteps = ['after-merge'];
    apiFail.onSuccessSteps = ['after-merge'];

    const input = makeInput({
      triggerPayload: { items: [1] },
      steps: [loopStep, delayOk, apiFail, afterMerge],
    });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(input, 'exec-l3-loop-body-merge-nonfatal-branch', deps);

    expect(result.status).toBe('completed');
    expect(result.context.steps.iterate.status).toBe('completed');
    const loopContext = result.context.steps.iterate.loopContext as Array<{
      steps: Record<string, { status: string }>;
    }>;
    expect(loopContext[0]?.steps['delay-ok']?.status).toBe('completed');
    expect(loopContext[0]?.steps['api-fail']?.status).toBe('failed');
    expect(loopContext[0]?.steps['after-merge']?.status).toBe('completed');
    expect(result.context.steps['delay-ok']).toBeUndefined();
    expect(result.context.steps['api-fail']).toBeUndefined();
    expect(result.context.steps['after-merge']).toBeUndefined();
  });

  it('loop onError continue records failed body iterations and continues remaining items', async () => {
    mockFetchJson(404, { error: 'missing' });

    const loopStep: LoopStep = {
      id: 'iterate',
      type: 'loop',
      config: {
        collection: '{{trigger.payload.items}}',
        itemVariable: 'item',
        onError: 'continue',
        outputField: 'context.results',
        body: ['api-2'],
        bodyInDegreeMap: { 'api-2': 0 },
      },
    };
    const api2: HttpStep = {
      id: 'api-2',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/missing',
    };

    const input = makeInput({
      triggerPayload: { items: [1, 2, 3] },
      steps: [loopStep, api2],
    });
    const publisher = makePublisher();
    const deps = makeDeps(makePersistence(), publisher);

    const result = await runWorkflow(input, 'exec-l3-loop-body-continue-failure', deps);

    expect(result.status).toBe('completed');
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    expect(result.context.steps.iterate.status).toBe('completed');
    expect((result.context as Record<string, unknown>).results).toEqual([null, null, null]);
    const loopOut = result.context.steps.iterate.output as {
      iterationOutputs: Array<{ index: number; currentItem: unknown; output: null }>;
    };
    expect(loopOut.iterationOutputs).toMatchObject([
      { index: 0, currentItem: 1, output: null },
      { index: 1, currentItem: 2, output: null },
      { index: 2, currentItem: 3, output: null },
    ]);
    const loopContext = result.context.steps.iterate.loopContext as Array<{
      steps: Record<string, { status: string }>;
    }>;
    expect(loopContext).toHaveLength(3);
    expect(loopContext.every((iteration) => iteration.steps['api-2']?.status === 'failed')).toBe(
      true,
    );
    expect(
      publisher.events.some(
        (event) => event.message.type === 'step.failed' && event.message.stepId === 'iterate',
      ),
    ).toBe(false);
  });

  it('loop onError continue promotes partial mapped output when a body step fails after earlier data resolved', async () => {
    mockFetchSequence([
      { status: 200, body: { galeEnv: 'AWS' } },
      { status: 429, body: { error: 'rate limited' } },
      { status: 200, body: { galeEnv: 'AWS' } },
      { status: 429, body: { error: 'rate limited' } },
      { status: 200, body: { galeEnv: 'AWS' } },
      { status: 429, body: { error: 'rate limited' } },
    ]);

    const loopStep: LoopStep = {
      id: 'iterate',
      type: 'loop',
      config: {
        collection: '{{trigger.payload.items}}',
        itemVariable: 'item',
        onError: 'continue',
        outputField: 'context.results',
        body: ['api-2', 'api-3'],
        bodyOutputMappings: [
          {
            name: 'env',
            expression: '{{context.steps.api-2.output.body.galeEnv}}',
            type: 'string',
          },
          { name: 'webhook', expression: '{{context.steps.api-3.output.body}}', type: 'json' },
        ],
      },
    };
    const api2: HttpStep = {
      id: 'api-2',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/env',
    };
    const api3: HttpStep = {
      id: 'api-3',
      type: 'http',
      method: 'POST',
      url: 'https://api.example.com/webhook',
    };

    const input = makeInput({
      triggerPayload: { items: [1, 2, 3] },
      steps: [loopStep, api2, api3],
    });

    const result = await runWorkflow(
      input,
      'exec-l3-loop-body-continue-partial-output',
      makeDeps(makePersistence(), makePublisher()),
    );

    expect(result.status).toBe('completed');
    expect((result.context as { results?: unknown }).results).toEqual([
      { env: 'AWS', webhook: null },
      { env: 'AWS', webhook: null },
      { env: 'AWS', webhook: null },
    ]);
    const loopOut = result.context.steps.iterate.output as {
      iterationOutputs: Array<{
        index: number;
        currentItem: unknown;
        output: Record<string, unknown> | null;
      }>;
    };
    expect(loopOut.iterationOutputs).toMatchObject([
      { index: 0, currentItem: 1, output: { env: 'AWS', webhook: null } },
      { index: 1, currentItem: 2, output: { env: 'AWS', webhook: null } },
      { index: 2, currentItem: 3, output: { env: 'AWS', webhook: null } },
    ]);
  });

  it('loop output variable stays clean while iteration output explains mapping type mismatch', async () => {
    const loopStep: LoopStep = {
      id: 'iterate',
      type: 'loop',
      config: {
        collection: '{{trigger.payload.items}}',
        itemVariable: 'item',
        onError: 'continue',
        outputField: 'context.results',
        body: ['noop'],
        bodyOutputMappings: [{ name: 'value', expression: '{{context.item}}', type: 'number' }],
      },
    };
    const noopStep: FunctionStep = {
      id: 'noop',
      type: 'function',
      config: { code: '' },
    };

    const input = makeInput({
      triggerPayload: { items: [1, 'bad', 3] },
      steps: [loopStep, noopStep],
    });

    const result = await runWorkflow(
      input,
      'exec-l3-loop-output-type-mismatch',
      makeDeps(makePersistence(), makePublisher()),
    );

    expect(result.status).toBe('completed');
    expect((result.context as { results?: unknown }).results).toEqual([
      { value: 1 },
      null,
      { value: 3 },
    ]);

    const loopOut = result.context.steps.iterate.output as {
      iterationOutputs: Array<{
        index: number;
        currentItem: unknown;
        output: Record<string, unknown> | null;
        mappingErrors?: Array<{
          name: string;
          expression: string;
          expected?: string;
          got?: string;
          error: string;
        }>;
      }>;
    };
    expect(loopOut.iterationOutputs[1]).toMatchObject({
      index: 1,
      currentItem: 'bad',
      output: null,
      mappingErrors: [
        {
          name: 'value',
          expression: '{{context.item}}',
          expected: 'number',
          got: 'string',
          error: 'Output mapping "value" type mismatch: expected number, got string',
        },
      ],
    });
    expect((result.context as { results?: unknown }).results).toEqual([
      { value: 1 },
      null,
      { value: 3 },
    ]);
  });

  it('loop with empty collection does not iterate body steps', async () => {
    const loopStep: LoopStep = {
      id: 'empty-loop',
      type: 'loop',
      config: {
        collection: '{{trigger.payload.items}}',
        itemVariable: 'item',
        body: ['body-step'],
      },
    };
    const bodyStep: DelayStep = { id: 'body-step', type: 'delay', duration: 'PT1S' };

    const input = makeInput({
      triggerPayload: { items: [] },
      steps: [loopStep, bodyStep],
    });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(input, 'exec-l3-03', deps);

    expect(result.status).toBe('completed');
    // Loop output records 0 iterations
    const loopOut = result.context.steps['empty-loop'].output as { iterations: number };
    expect(loopOut.iterations).toBe(0);
    expect(result.context.steps['body-step']).toBeUndefined();
  });

  it('loop with non-array collection fails clearly', async () => {
    const loopStep: LoopStep = {
      id: 'bad-loop',
      type: 'loop',
      config: {
        collection: '{{trigger.payload.notAnArray}}',
        itemVariable: 'item',
      },
    };

    const input = makeInput({
      triggerPayload: { notAnArray: 'just a string' },
      steps: [loopStep],
    });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(input, 'exec-l3-04', deps);

    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('did not resolve to an array');
  });
});

// ===========================================================================
// 2. Retry with exponential backoff
// ===========================================================================

describe('L3: Retry with backoff', () => {
  it('retries a failing tool step and succeeds on second attempt', async () => {
    const toolClient: ToolExecutionClient = {
      executeTool: vi
        .fn()
        .mockRejectedValueOnce(new Error('Transient failure'))
        .mockResolvedValueOnce({
          success: true,
          status: 'completed',
          output: { recovered: true },
        }),
    };

    const step: ToolCallStep = {
      id: 'flaky-tool',
      type: 'tool_call',
      toolName: 'unstable_service',
      params: {},
      retry: { maxAttempts: 3, delayMs: 100, backoffMultiplier: 2 },
    };

    const input = makeInput({ steps: [step] });
    const deps = makeDeps(makePersistence(), makePublisher(), { toolClient });

    const result = await runWorkflow(input, 'exec-l3-05', deps);

    expect(result.status).toBe('completed');
    expect(toolClient.executeTool).toHaveBeenCalledTimes(2);
  });

  it('exhausts all retry attempts and fails', async () => {
    const toolClient: ToolExecutionClient = {
      executeTool: vi.fn().mockRejectedValue(new Error('Persistent failure')),
    };

    const step: ToolCallStep = {
      id: 'broken-tool',
      type: 'tool_call',
      toolName: 'dead_service',
      params: {},
      retry: { maxAttempts: 3, delayMs: 50, backoffMultiplier: 2 },
    };

    const input = makeInput({ steps: [step] });
    const deps = makeDeps(makePersistence(), makePublisher(), { toolClient });

    const result = await runWorkflow(input, 'exec-l3-06', deps);

    expect(result.status).toBe('failed');
    expect(toolClient.executeTool).toHaveBeenCalledTimes(3);
    expect(result.error?.message).toBe('Persistent failure');
  });

  it('uses exponential backoff delays via restateCtx.sleep', async () => {
    const toolClient: ToolExecutionClient = {
      executeTool: vi
        .fn()
        .mockRejectedValueOnce(new Error('Fail 1'))
        .mockRejectedValueOnce(new Error('Fail 2'))
        .mockResolvedValueOnce({ success: true, status: 'completed', output: {} }),
    };

    const step: ToolCallStep = {
      id: 'backoff-tool',
      type: 'tool_call',
      toolName: 'flaky',
      params: {},
      retry: { maxAttempts: 3, delayMs: 100, backoffMultiplier: 2 },
    };

    const input = makeInput({ steps: [step] });
    const restateCtx = makeMockRestateCtx();
    const deps = makeDeps(makePersistence(), makePublisher(), { toolClient });

    const result = await runWorkflow(input, 'exec-l3-07', deps, restateCtx);

    expect(result.status).toBe('completed');
    expect(restateCtx.sleepCalls).toContain(100); // First retry delay
    expect(restateCtx.sleepCalls).toContain(200); // Second retry delay (100 * 2)
  });

  it('step without retry config fails immediately on first error', async () => {
    const toolClient: ToolExecutionClient = {
      executeTool: vi.fn().mockRejectedValue(new Error('One shot')),
    };

    const step: ToolCallStep = {
      id: 'no-retry',
      type: 'tool_call',
      toolName: 'strict',
      params: {},
      // No retry config
    };

    const input = makeInput({ steps: [step] });
    const deps = makeDeps(makePersistence(), makePublisher(), { toolClient });

    const result = await runWorkflow(input, 'exec-l3-08', deps);

    expect(result.status).toBe('failed');
    expect(toolClient.executeTool).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// 3. Restate ctx.run wrapping
// ===========================================================================

describe('L3: Restate ctx.run idempotency', () => {
  it('wraps each step dispatch in ctx.run', async () => {
    const step1: DelayStep = { id: 'delay-a', type: 'delay', duration: 'PT1S' };
    const step2: DelayStep = { id: 'delay-b', type: 'delay', duration: 'PT2S' };

    const input = makeInput({ steps: [step1, step2] });
    const restateCtx = makeMockRestateCtx();
    const deps = makeDeps(makePersistence(), makePublisher());

    await runWorkflow(input, 'exec-l3-09', deps, restateCtx);

    expect(restateCtx.runCalls).toContain('step:delay-a');
    expect(restateCtx.runCalls).toContain('step:delay-b');
  });

  it('uses ctx.sleep for delay steps', async () => {
    const step: DelayStep = { id: 'wait', type: 'delay', duration: 'PT30S' };

    const input = makeInput({ steps: [step] });
    const restateCtx = makeMockRestateCtx();
    const deps = makeDeps(makePersistence(), makePublisher());

    await runWorkflow(input, 'exec-l3-10', deps, restateCtx);

    expect(restateCtx.sleepCalls).toContain(30000);
  });

  it('retry attempts get unique names for Restate tracking', async () => {
    const toolClient: ToolExecutionClient = {
      executeTool: vi
        .fn()
        .mockRejectedValueOnce(new Error('Fail'))
        .mockResolvedValueOnce({ success: true, status: 'completed', output: {} }),
    };

    const step: ToolCallStep = {
      id: 'tracked-retry',
      type: 'tool_call',
      toolName: 'flaky',
      params: {},
      retry: { maxAttempts: 2, delayMs: 10 },
    };

    const input = makeInput({ steps: [step] });
    const restateCtx = makeMockRestateCtx();
    const deps = makeDeps(makePersistence(), makePublisher(), { toolClient });

    await runWorkflow(input, 'exec-l3-11', deps, restateCtx);

    expect(restateCtx.runCalls).toContain('step:tracked-retry:attempt:1');
    expect(restateCtx.runCalls).toContain('step:tracked-retry:attempt:2');
  });
});

// ===========================================================================
// 4. Mixed step type pipeline with deep expression resolution
// ===========================================================================

describe('L3: Complex mixed pipelines', () => {
  it('HTTP → Transform → Agent → Condition → Tool: 5-step pipeline', async () => {
    // Step 1: HTTP returns order data
    mockFetchJson(200, { order: { id: 'O-1', amount: 500, priority: 'high' } });

    // Step 3: Agent response
    const runtimeClient: RuntimeClient = {
      sendMessage: vi.fn().mockResolvedValue({
        sessionId: 'sess-pipeline',
        agentResponse: 'Approved for processing',
        toolResults: [],
      }),
    };

    // Step 5: Tool processes the order
    const toolClient: ToolExecutionClient = {
      executeTool: vi.fn().mockResolvedValue({
        success: true,
        status: 'completed',
        output: { processedId: 'PROC-O-1' },
      }),
    };

    const fetchOrder: HttpStep = {
      id: 'fetch-order',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/orders/O-1',
    };
    const extractAmount: TransformStep = {
      id: 'extract-amount',
      type: 'transform',
      config: {
        inputExpression: '{{steps.fetch-order.output.body.order.amount}}',
        outputVariable: 'orderAmount',
      },
    };
    const reviewAgent: AgentInvocationStep = {
      id: 'review',
      type: 'agent_invocation',
      agentId: 'review-agent',
      message:
        'Review order {{steps.fetch-order.output.body.order.id}} amount={{context.orderAmount}}',
    };
    const checkApproval: ConditionStep = {
      id: 'check-approval',
      type: 'condition',
      expression: '{{steps.review.output.agentResponse}}',
      thenSteps: ['process'],
    };
    const processTool: ToolCallStep = {
      id: 'process',
      type: 'tool_call',
      toolName: 'order_processor',
      params: { orderId: '{{steps.fetch-order.output.body.order.id}}' },
    };

    const input = makeInput({
      steps: [fetchOrder, extractAmount, reviewAgent, checkApproval, processTool],
    });
    const deps = makeDeps(makePersistence(), makePublisher(), { runtimeClient, toolClient });

    const result = await runWorkflow(input, 'exec-l3-12', deps);

    expect(result.status).toBe('completed');

    // Verify data flow through all steps
    expect((result.context as Record<string, unknown>)['orderAmount']).toBe(500);
    expect(runtimeClient.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Review order O-1 amount=500',
      }),
    );
    expect(toolClient.executeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { orderId: 'O-1' },
      }),
    );

    // All 5 steps completed
    expect(result.context.steps['fetch-order'].status).toBe('completed');
    expect(result.context.steps['extract-amount'].status).toBe('completed');
    expect(result.context.steps['review'].status).toBe('completed');
    expect(result.context.steps['check-approval'].status).toBe('completed');
    expect(result.context.steps['process'].status).toBe('completed');
  });

  it('deep nested expression resolution across 3 steps', async () => {
    mockFetchSequence([
      { status: 200, body: { level1: { level2: { level3: { value: 'deep-data' } } } } },
      { status: 200, body: { confirmed: true } },
    ]);

    const step1: HttpStep = {
      id: 'deep-fetch',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/deep',
    };
    const step2: TransformStep = {
      id: 'deep-extract',
      type: 'transform',
      config: {
        inputExpression: '{{steps.deep-fetch.output.body.level1.level2.level3.value}}',
        outputVariable: 'deepValue',
      },
    };
    const step3: HttpStep = {
      id: 'use-deep',
      type: 'http',
      method: 'POST',
      url: 'https://api.example.com/confirm',
      body: '{{context.deepValue}}',
    };

    const input = makeInput({ steps: [step1, step2, step3] });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(input, 'exec-l3-13', deps);

    expect(result.status).toBe('completed');
    expect((result.context as Record<string, unknown>)['deepValue']).toBe('deep-data');
  });
});

// ===========================================================================
// 5. Complex on_failure + on_success routing chains
// ===========================================================================

describe('L3: Complex routing chains', () => {
  it('primary fails → recovery succeeds → routes to final via onSuccessSteps', async () => {
    // Primary HTTP fails, recovery HTTP succeeds, then routes to final delay
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Primary down'));
    mockFetchJson(200, { backup: true });

    const primary = {
      id: 'primary',
      type: 'http' as const,
      method: 'GET' as const,
      url: 'https://api.example.com/main',
      onFailureSteps: ['recovery'],
    };
    const recovery = {
      id: 'recovery',
      type: 'http' as const,
      method: 'GET' as const,
      url: 'https://api.example.com/backup',
      onSuccessSteps: ['final'],
    };
    const skipped: DelayStep = { id: 'skipped', type: 'delay', duration: 'PT1S' };
    const final: DelayStep = { id: 'final', type: 'delay', duration: 'PT2S' };

    const input = makeInput({ steps: [primary, recovery, skipped, final] });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(input, 'exec-l3-14', deps);

    expect(result.status).toBe('completed');
    expect(result.context.steps['primary'].status).toBe('failed');
    expect(result.context.steps['recovery'].status).toBe('completed');
    expect(result.context.steps['final'].status).toBe('completed');
    expect(result.context.steps['skipped']).toBeUndefined();
  });

  it('double failure: primary fails, recovery fails, workflow fails', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('Primary down'))
      .mockRejectedValueOnce(new Error('Recovery also down'));

    const primary = {
      id: 'primary',
      type: 'http' as const,
      method: 'GET' as const,
      url: 'https://api.example.com/main',
      onFailureSteps: ['recovery'],
    };
    const recovery: HttpStep = {
      id: 'recovery',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/backup',
    };

    const input = makeInput({ steps: [primary, recovery] });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(input, 'exec-l3-15', deps);

    expect(result.status).toBe('failed');
    expect(result.context.steps['primary'].status).toBe('failed');
    expect(result.context.steps['recovery'].status).toBe('failed');
    expect(result.error?.message).toBe('Recovery also down');
  });

  it('condition routes to on_failure handler after HTTP 4xx', async () => {
    // HTTP returns 4xx (which throws), routed to fallback
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: vi.fn().mockResolvedValue(JSON.stringify({ error: 'Server error' })),
      headers: new Headers(),
    });

    const riskyHttp = {
      id: 'risky',
      type: 'http' as const,
      method: 'GET' as const,
      url: 'https://api.example.com/unstable',
      onFailureSteps: ['error-handler'],
    };
    const errorHandler: TransformStep = {
      id: 'error-handler',
      type: 'transform',
      config: {
        inputExpression: '{{steps.risky.error.message}}',
        outputVariable: 'errorMessage',
      },
    };

    const input = makeInput({ steps: [riskyHttp, errorHandler] });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(input, 'exec-l3-16', deps);

    expect(result.status).toBe('completed');
    expect(result.context.steps['risky'].status).toBe('failed');
    expect(result.context.steps['error-handler'].status).toBe('completed');
    // Error info captured in root context by the transform step
    expect((result.context as Record<string, unknown>)['errorMessage']).toContain('HTTP 500');
  });
});

// ===========================================================================
// 6. Context accumulation across many steps
// ===========================================================================

describe('L3: Context accumulation', () => {
  it('5 sequential HTTP steps all accumulate in context', async () => {
    const responses = [
      { status: 200, body: { n: 1 } },
      { status: 200, body: { n: 2 } },
      { status: 200, body: { n: 3 } },
      { status: 200, body: { n: 4 } },
      { status: 200, body: { n: 5 } },
    ];
    mockFetchSequence(responses);

    const steps: HttpStep[] = responses.map((_, i) => ({
      id: `step-${i + 1}`,
      type: 'http' as const,
      method: 'GET' as const,
      url: `https://api.example.com/${i + 1}`,
    }));

    const input = makeInput({ steps });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(input, 'exec-l3-17', deps);

    expect(result.status).toBe('completed');
    // 1 (start) + 5 HTTP steps + 1 (end) = 7
    expect(Object.keys(result.context.steps)).toHaveLength(7);
    for (let i = 1; i <= 5; i++) {
      const out = result.context.steps[`step-${i}`].output as { body: { n: number } };
      expect(out.body.n).toBe(i);
    }
  });

  it('multiple transforms accumulate vars independently', async () => {
    const steps: TransformStep[] = [
      {
        id: 't1',
        type: 'transform',
        config: { inputExpression: '{{trigger.payload.a}}', outputVariable: 'varA' },
      },
      {
        id: 't2',
        type: 'transform',
        config: { inputExpression: '{{trigger.payload.b}}', outputVariable: 'varB' },
      },
      {
        id: 't3',
        type: 'transform',
        config: { inputExpression: '{{trigger.payload.c}}', outputVariable: 'varC' },
      },
    ];

    const input = makeInput({
      triggerPayload: { a: 'alpha', b: 'beta', c: 'gamma' },
      steps,
    });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(input, 'exec-l3-18', deps);

    expect(result.status).toBe('completed');
    // Transforms write to root context, not ctx.vars.
    // Use toMatchObject so extra root keys don't break the assertion.
    expect(result.context as Record<string, unknown>).toMatchObject({
      varA: 'alpha',
      varB: 'beta',
      varC: 'gamma',
    });
  });

  it('later transform can reference earlier transform vars', async () => {
    const steps: TransformStep[] = [
      {
        id: 't1',
        type: 'transform',
        config: { inputExpression: '{{trigger.payload.name}}', outputVariable: 'userName' },
      },
      {
        id: 't2',
        type: 'transform',
        config: { inputExpression: '{{context.userName}}', outputVariable: 'copied' },
      },
    ];

    const input = makeInput({
      triggerPayload: { name: 'Alice' },
      steps,
    });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(input, 'exec-l3-19', deps);

    expect(result.status).toBe('completed');
    expect((result.context as Record<string, unknown>)['userName']).toBe('Alice');
    expect((result.context as Record<string, unknown>)['copied']).toBe('Alice');
  });
});

// ===========================================================================
// 7. Loop + Condition + on_failure combined
// ===========================================================================

describe('L3: Loop with condition and failure handling', () => {
  it('loop body contains condition that routes per item', async () => {
    // 3 items: all truthy (-5 is truthy in JS), so all 3 go to HTTP log.
    const items = [10, -5, 20];
    mockFetchSequence([
      { status: 200, body: { logged: 10 } },
      { status: 200, body: { logged: -5 } },
      { status: 200, body: { logged: 20 } },
    ]);

    const loopStep: LoopStep = {
      id: 'iterate',
      type: 'loop',
      config: {
        collection: '{{trigger.payload.values}}',
        itemVariable: 'val',
        body: ['check-positive'],
      },
    };
    const checkPositive: ConditionStep = {
      id: 'check-positive',
      type: 'condition',
      expression: '{{context.val}}',
      thenSteps: ['log-it'],
      elseSteps: [],
    };
    const logStep: HttpStep = {
      id: 'log-it',
      type: 'http',
      method: 'POST',
      url: 'https://api.example.com/log',
      body: '{{context.val}}',
    };

    const input = makeInput({
      triggerPayload: { values: items },
      steps: [loopStep, checkPositive, logStep],
    });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(input, 'exec-l3-20', deps);

    expect(result.status).toBe('completed');
    const loopOut = result.context.steps['iterate'].output as {
      iterationOutputs: Array<{
        index: number;
        currentItem: unknown;
        output: Record<string, unknown> | null;
      }>;
    };
    expect(loopOut.iterationOutputs).toHaveLength(3);
    expect(loopOut.iterationOutputs[0]).toMatchObject({
      index: 0,
      currentItem: 10,
      output: null,
    });
    expect(result.context.steps['check-positive']).toBeUndefined();
    expect(result.context.steps['log-it']).toBeUndefined();
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });
});

// ===========================================================================
// 8. Workflow event ordering with complex flows
// ===========================================================================

describe('L3: Event ordering in complex flows', () => {
  it('condition branch produces correct event sequence', async () => {
    mockFetchJson(200, { flag: true });

    const httpStep: HttpStep = {
      id: 'fetch',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/flag',
    };
    const condStep: ConditionStep = {
      id: 'check',
      type: 'condition',
      expression: '{{steps.fetch.output.body.flag}}',
      thenSteps: ['then-delay'],
    };
    const thenDelay: DelayStep = { id: 'then-delay', type: 'delay', duration: 'PT1S' };

    const publisher = makePublisher();
    const input = makeInput({ steps: [httpStep, condStep, thenDelay] });
    const deps = makeDeps(makePersistence(), publisher);

    await runWorkflow(input, 'exec-l3-21', deps);

    const types = publisher.events.map((e) => e.message.type);
    // Start + End are first-class lifecycle steps — each emits step.started
    // + step.completed around the user steps.
    expect(types).toEqual([
      'step.started', // Start
      'step.completed', // Start
      'workflow.started',
      'step.started', // fetch
      'step.completed', // fetch
      'step.started', // check
      'step.completed', // check (condition)
      'step.started', // then-delay
      'step.completed', // then-delay
      'step.started', // End
      'step.completed', // End
      'workflow.completed',
    ]);
  });

  it('on_failure routing produces correct event sequence', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Down'));

    const failStep = {
      id: 'fail',
      type: 'http' as const,
      method: 'GET' as const,
      url: 'https://api.example.com/fail',
      onFailureSteps: ['recover'],
    };
    const recoverStep: DelayStep = { id: 'recover', type: 'delay', duration: 'PT1S' };

    const publisher = makePublisher();
    const input = makeInput({ steps: [failStep, recoverStep] });
    const deps = makeDeps(makePersistence(), publisher);

    await runWorkflow(input, 'exec-l3-22', deps);

    const types = publisher.events.map((e) => e.message.type);
    // Start + End are first-class lifecycle steps.
    expect(types).toEqual([
      'step.started', // Start
      'step.completed', // Start
      'workflow.started',
      'step.started', // fail
      'step.failed', // fail (routed to recovery)
      'step.started', // recover
      'step.completed', // recover
      'step.started', // End
      'step.completed', // End
      'workflow.completed',
    ]);
  });
});

// ===========================================================================
// 9. Large trigger payload with complex objects
// ===========================================================================

describe('L3: Complex trigger payloads', () => {
  it('nested objects in trigger payload accessible across steps', async () => {
    const runtimeClient: RuntimeClient = {
      sendMessage: vi.fn().mockResolvedValue({
        sessionId: 'sess-complex',
        agentResponse: 'Processed',
        toolResults: [],
      }),
    };

    const step1: TransformStep = {
      id: 'get-address',
      type: 'transform',
      config: {
        inputExpression: '{{trigger.payload.customer.address.city}}',
        outputVariable: 'city',
      },
    };
    const step2: AgentInvocationStep = {
      id: 'process',
      type: 'agent_invocation',
      agentId: 'shipping-agent',
      message: 'Ship to {{context.city}} for {{trigger.payload.customer.name}}',
    };

    const input = makeInput({
      triggerPayload: {
        customer: {
          name: 'Jane Smith',
          address: { city: 'Portland', state: 'OR', zip: '97201' },
        },
        items: [{ sku: 'A1', qty: 2 }],
      },
      steps: [step1, step2],
    });
    const deps = makeDeps(makePersistence(), makePublisher(), { runtimeClient });

    const result = await runWorkflow(input, 'exec-l3-23', deps);

    expect(result.status).toBe('completed');
    expect((result.context as Record<string, unknown>)['city']).toBe('Portland');
    expect(runtimeClient.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Ship to Portland for Jane Smith',
      }),
    );
  });
});

// ===========================================================================
// 10. Multiple condition branches with shared recovery
// ===========================================================================

describe('L3: Multi-branch condition with recovery', () => {
  it('condition with then/else both leading to different HTTP calls', async () => {
    mockFetchSequence([
      { status: 200, body: { userType: 'premium' } },
      { status: 200, body: { discount: 30 } },
    ]);

    const checkUser: HttpStep = {
      id: 'check-user',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/user/type',
    };
    const routeStep: ConditionStep = {
      id: 'route',
      type: 'condition',
      expression: '{{steps.check-user.output.body.userType}}',
      thenSteps: ['premium-action'],
      elseSteps: ['standard-action'],
    };
    const premiumAction: HttpStep = {
      id: 'premium-action',
      type: 'http',
      method: 'POST',
      url: 'https://api.example.com/premium/discount',
    };
    const standardDelay: DelayStep = {
      id: 'standard-action',
      type: 'delay',
      duration: 'PT5S',
    };

    const input = makeInput({
      steps: [checkUser, routeStep, premiumAction, standardDelay],
    });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(input, 'exec-l3-24', deps);

    expect(result.status).toBe('completed');
    // Premium path taken (userType is truthy)
    expect(result.context.steps['premium-action'].status).toBe('completed');
    expect(result.context.steps['standard-action']).toBeUndefined();
  });
});

// ===========================================================================
// Parallel step at the runWorkflow level — exercises the handler's built-in
// branchRunner (which re-enters the step dispatcher for each branch's sub-steps)
// and the propagation of parallel output into the workflow context.
// ===========================================================================

describe('L3: Parallel step end-to-end', () => {
  it('completes with allSucceeded=true when all branches resolve via the built-in branchRunner', async () => {
    // Branch step IDs reference real transforms in input.steps — the handler's
    // branchRunner looks them up in the internal stepIndex and dispatches them.
    const branchA: TransformStep = {
      id: 'branch-a-transform',
      type: 'transform',
      config: { inputExpression: 'A', outputVariable: 'ranA' },
    };
    const branchB: TransformStep = {
      id: 'branch-b-transform',
      type: 'transform',
      config: { inputExpression: 'B', outputVariable: 'ranB' },
    };
    const parallel: ParallelStep = {
      id: 'fan-out',
      type: 'parallel',
      failureStrategy: 'wait_all',
      branches: [
        { name: 'a', steps: ['branch-a-transform'] },
        { name: 'b', steps: ['branch-b-transform'] },
      ],
    };

    const deps = makeDeps(makePersistence(), makePublisher());
    const result = await runWorkflow(
      makeInput({ steps: [parallel, branchA, branchB] }),
      'exec-par-1',
      deps,
    );

    expect(result.status).toBe('completed');
    const output = result.context.steps['fan-out'].output as {
      branches: Array<{ name: string; status: string }>;
      allSucceeded: boolean;
    };
    expect(output.allSucceeded).toBe(true);
    expect(output.branches.map((b) => b.name).sort()).toEqual(['a', 'b']);
    expect(output.branches.every((b) => b.status === 'completed')).toBe(true);
  });

  it('fail_fast surfaces a branch-step throw as a workflow failure with _status: 1', async () => {
    // The failing sub-step is an HTTP call whose fetch rejects. When the
    // parallel step's fail_fast strategy propagates that throw, the workflow
    // catch branch must mark the execution failed and populate the _status
    // convention.
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('remote unavailable'),
    );

    const okBranchStep: TransformStep = {
      id: 'branch-ok',
      type: 'transform',
      config: { inputExpression: 'ok', outputVariable: 'ranOk' },
    };
    const failingBranchStep: HttpStep = {
      id: 'branch-http-fail',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/down',
    };
    const parallel: ParallelStep = {
      id: 'fan-out',
      type: 'parallel',
      failureStrategy: 'fail_fast',
      branches: [
        { name: 'ok', steps: ['branch-ok'] },
        { name: 'broken', steps: ['branch-http-fail'] },
      ],
    };

    const deps = makeDeps(makePersistence(), makePublisher());
    const result = await runWorkflow(
      makeInput({ steps: [parallel, okBranchStep, failingBranchStep] }),
      'exec-par-2',
      deps,
    );

    expect(result.status).toBe('failed');
    expect(result.output?._status).toBe(1);
    expect(typeof result.output?._reason).toBe('string');
    expect(result.output?._reason as string).toMatch(/remote unavailable|http/i);
  });

  it('parallel step output is reachable from downstream steps via {{steps.<id>.output}}', async () => {
    // Regression guard for the context.steps wiring — parallel output must
    // land under `steps[parallel.id].output` so downstream steps can reach it.
    const noopA: TransformStep = {
      id: 'noop-a',
      type: 'transform',
      config: { inputExpression: 'a', outputVariable: 'a' },
    };
    const noopB: TransformStep = {
      id: 'noop-b',
      type: 'transform',
      config: { inputExpression: 'b', outputVariable: 'b' },
    };
    const parallel: ParallelStep = {
      id: 'fan-out',
      type: 'parallel',
      failureStrategy: 'wait_all',
      branches: [
        { name: 'a', steps: ['noop-a'] },
        { name: 'b', steps: ['noop-b'] },
      ],
    };
    const capture: TransformStep = {
      id: 'capture',
      type: 'transform',
      config: {
        inputExpression: '{{steps.fan-out.output.allSucceeded}}',
        outputVariable: 'didAllSucceed',
      },
    };

    const deps = makeDeps(makePersistence(), makePublisher());
    const result = await runWorkflow(
      makeInput({ steps: [parallel, capture, noopA, noopB] }),
      'exec-par-3',
      deps,
    );

    expect(result.status).toBe('completed');
    expect((result.context as Record<string, unknown>).didAllSucceed).toBe(true);
  });
});
