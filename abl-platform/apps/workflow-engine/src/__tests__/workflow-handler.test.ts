import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildWorkflowContext,
  runWorkflow,
  type WorkflowExecutionInput,
  type WorkflowHandlerDeps,
  type ExecutionPersistence,
  type StatusPublisher,
  type RestateWorkflowCtx,
} from '../handlers/workflow-handler.js';
import type { ConditionStep } from '../executors/condition-executor.js';
import type { DelayStep } from '../executors/delay-executor.js';

vi.mock('@agent-platform/shared-kernel/security', () => ({
  assertUrlSafeForSSRF: vi.fn(),
}));

vi.mock('@agent-platform/shared-kernel/security/safe-fetch', () => ({
  assertUrlSafeForFetch: vi.fn().mockResolvedValue(undefined),
  safeFetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
}));

function makeMockPersistence(): ExecutionPersistence {
  return {
    createExecution: vi.fn().mockResolvedValue(undefined),
    updateStepStatus: vi.fn().mockResolvedValue(undefined),
    updateExecutionStatus: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockPublisher(): StatusPublisher {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockRestateCtx(): RestateWorkflowCtx & { runCalls: string[] } {
  const runCalls: string[] = [];
  // Default awakeable: returns a never-resolving promise (tests that need resolution
  // override this with vi.mocked(restateCtx.awakeable).mockReturnValueOnce(...)).
  const makeNeverResolvingAwakeable = () => {
    const neverPromise = Object.assign(new Promise<unknown>(() => {}), {
      orTimeout: vi.fn((ms: number) => {
        const err = new Error(`Timed out after ${ms}ms`);
        err.name = 'TimeoutError';
        return Object.assign(Promise.reject(err), { orTimeout: vi.fn() });
      }),
    });
    return { id: `test-awakeable-${Math.random().toString(36).slice(2)}`, promise: neverPromise };
  };
  return {
    runCalls,
    run: vi.fn(async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      runCalls.push(name);
      return fn();
    }),
    sleep: vi.fn().mockResolvedValue(undefined),
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
    awakeable: vi.fn().mockImplementation(makeNeverResolvingAwakeable),
  };
}

function makeInput(steps: WorkflowExecutionInput['steps'] = []): WorkflowExecutionInput {
  return {
    workflowId: 'wf-1',
    workflowName: 'test-flow',
    tenantId: 't1',
    projectId: 'p1',
    triggerType: 'webhook',
    triggerPayload: { orderId: 'ORD-123' },
    steps,
  };
}

describe('buildWorkflowContext', () => {
  it('builds context from input and executionId', () => {
    const input = makeInput();
    const ctx = buildWorkflowContext(input, 'exec-42');

    expect(ctx.trigger.type).toBe('webhook');
    expect(ctx.trigger.payload.orderId).toBe('ORD-123');
    expect(ctx.workflow.id).toBe('wf-1');
    expect(ctx.workflow.executionId).toBe('exec-42');
    expect(ctx.tenant.tenantId).toBe('t1');
    expect(ctx.steps).toEqual(
      expect.objectContaining({
        start: expect.objectContaining({
          output: { orderId: 'ORD-123' },
          status: 'completed',
          input: { orderId: 'ORD-123' },
        }),
      }),
    );
    expect(ctx.orderId).toBeUndefined();
  });

  it('does not seed root variables when triggerPayload is undefined', () => {
    const input = {
      ...makeInput(),
      triggerPayload: undefined as unknown as Record<string, unknown>,
    };
    const ctx = buildWorkflowContext(input, 'exec-empty');
    expect(ctx.vars).toBeUndefined();
  });
});

describe('runWorkflow', () => {
  let persistence: ExecutionPersistence;
  let publisher: StatusPublisher;

  beforeEach(() => {
    persistence = makeMockPersistence();
    publisher = makeMockPublisher();
  });

  it('fails a workflow with no steps and returns no-path guidance', async () => {
    const input = makeInput([]);
    const deps: WorkflowHandlerDeps = {
      persistence,
      publisher,
      dispatcherDeps: {},
    };

    const result = await runWorkflow(input, 'exec-1', deps);

    expect(result.status).toBe('failed');
    expect(result.error).toEqual({
      code: 'NO_STEPS',
      message: expect.stringMatching(/no complete Start/i),
    });
    expect(persistence.createExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: 'exec-1',
        tenantId: 't1',
        status: 'failed',
      }),
    );
    expect(persistence.updateExecutionStatus).toHaveBeenCalledWith(
      'exec-1',
      't1',
      'p1',
      'failed',
      expect.objectContaining({
        context: expect.any(Object),
        error: {
          code: 'NO_STEPS',
          message: expect.stringMatching(/no complete Start/i),
        },
      }),
    );
  });

  it('executes sequential steps in order', async () => {
    const delayStep1: DelayStep = {
      id: 'delay-1',
      type: 'delay',
      duration: 'PT5S',
    };

    const delayStep2: DelayStep = {
      id: 'delay-2',
      type: 'delay',
      duration: 'PT10S',
    };

    const input = makeInput([delayStep1, delayStep2]);
    const deps: WorkflowHandlerDeps = {
      persistence,
      publisher,
      dispatcherDeps: {},
    };

    const result = await runWorkflow(input, 'exec-2', deps);

    expect(result.status).toBe('completed');
    expect(result.context.steps['delay-1'].status).toBe('completed');
    expect(result.context.steps['delay-2'].status).toBe('completed');

    // Verify persistence was called for each step.
    // 1 (Start → completed) + 2 user steps × 2 (running + completed)
    // + 2 (End → running, End → completed) = 7
    const updateStepCalls = (persistence.updateStepStatus as ReturnType<typeof vi.fn>).mock.calls;
    expect(updateStepCalls.length).toBe(7);
  });

  it('resolves output mappings only for reached end nodes in DAG workflows', async () => {
    const goodStep: DelayStep & { onSuccessSteps: string[]; name: string } = {
      id: 'good-step',
      name: 'ReachEndTwo',
      type: 'delay',
      duration: 'PT0S',
      onSuccessSteps: ['end-2'],
    };
    const badStep = {
      id: 'bad-step',
      name: 'FailBeforeEndOne',
      type: 'unknown_type_xyz',
      onSuccessSteps: ['end-1'],
    } as unknown as WorkflowExecutionInput['steps'][number];

    const input: WorkflowExecutionInput = {
      ...makeInput([goodStep, badStep]),
      inDegreeMap: {
        'good-step': 0,
        'bad-step': 0,
      },
      outputMappings: [
        { name: 'end0001', expression: '{{trigger.payload.orderId}}' },
        { name: 'end0002', expression: '{{trigger.payload.orderId}}' },
      ],
      outputMappingsByEndNodeId: {
        'end-1': [{ name: 'end0001', expression: '{{trigger.payload.orderId}}' }],
        'end-2': [{ name: 'end0002', expression: '{{trigger.payload.orderId}}' }],
      },
    };
    const deps: WorkflowHandlerDeps = {
      persistence,
      publisher,
      dispatcherDeps: {},
    };

    const result = await runWorkflow(input, 'exec-end-filter', deps);

    expect(result.status).toBe('completed');
    expect(result.output).toEqual({
      _status: 0,
      end0002: 'ORD-123',
    });
    expect(result.context.steps.end?.input).toEqual([
      { name: 'end0002', expression: '{{trigger.payload.orderId}}' },
    ]);
  });

  it('uses flat outputMappings on sequential path where no steps activate end-node IDs', async () => {
    const delayStep: DelayStep = {
      id: 'delay-1',
      type: 'delay',
      duration: 'PT0S',
    };
    const input: WorkflowExecutionInput = {
      ...makeInput([delayStep]),
      // No inDegreeMap → sequential execution path
      outputMappings: [{ name: 'orderId', expression: '{{trigger.payload.orderId}}' }],
      outputMappingsByEndNodeId: {
        'end-1': [{ name: 'orderId', expression: '{{trigger.payload.orderId}}' }],
      },
    };
    const deps: WorkflowHandlerDeps = {
      persistence,
      publisher,
      dispatcherDeps: {},
    };

    const result = await runWorkflow(input, 'exec-seq-fallback', deps);

    expect(result.status).toBe('completed');
    // Sequential path: delay activatedSuccessors do not include end node IDs,
    // so reachedEndNodeIds stays empty → falls back to flat outputMappings.
    expect(result.output).toEqual({ _status: 0, orderId: 'ORD-123' });
  });

  it('selects per-end-node mappings when a condition routes to a specific end node in a DAG', async () => {
    const conditionStep: ConditionStep = {
      id: 'cond-1',
      type: 'condition',
      expression: '{{trigger.payload.orderId}}',
      thenSteps: ['end-then'],
      elseSteps: ['end-else'],
    };
    const input: WorkflowExecutionInput = {
      ...makeInput([conditionStep]),
      inDegreeMap: { 'cond-1': 0 },
      outputMappings: [
        { name: 'thenOut', expression: '{{trigger.payload.orderId}}' },
        { name: 'elseOut', expression: '{{trigger.payload.orderId}}' },
      ],
      outputMappingsByEndNodeId: {
        'end-then': [{ name: 'thenOut', expression: '{{trigger.payload.orderId}}' }],
        'end-else': [{ name: 'elseOut', expression: '{{trigger.payload.orderId}}' }],
      },
    };
    const deps: WorkflowHandlerDeps = {
      persistence,
      publisher,
      dispatcherDeps: {},
    };

    const result = await runWorkflow(input, 'exec-cond-end-map', deps);

    expect(result.status).toBe('completed');
    // orderId is truthy → condition activates 'end-then'; only its mapping appears.
    expect(result.output).toEqual({ _status: 0, thenOut: 'ORD-123' });
    expect(result.output).not.toHaveProperty('elseOut');
  });

  it('follows condition thenSteps branch when expression is truthy', async () => {
    const delayThen: DelayStep = {
      id: 'then-delay',
      type: 'delay',
      duration: 'PT1S',
    };

    const delayElse: DelayStep = {
      id: 'else-delay',
      type: 'delay',
      duration: 'PT2S',
    };

    const conditionStep: ConditionStep = {
      id: 'cond-1',
      type: 'condition',
      expression: '{{trigger.payload.orderId}}',
      thenSteps: ['then-delay'],
      elseSteps: ['else-delay'],
    };

    // All steps must be in the input array (step index lookup)
    const input = makeInput([conditionStep, delayThen, delayElse]);
    const deps: WorkflowHandlerDeps = {
      persistence,
      publisher,
      dispatcherDeps: {},
    };

    const result = await runWorkflow(input, 'exec-branch', deps);

    expect(result.status).toBe('completed');
    // Condition was evaluated
    expect(result.context.steps['cond-1'].status).toBe('completed');
    // Then branch was executed (orderId is truthy)
    expect(result.context.steps['then-delay'].status).toBe('completed');
    // Else branch was NOT executed
    expect(result.context.steps['else-delay']).toBeUndefined();
  });

  it('follows condition elseSteps branch when expression is falsy', async () => {
    const delayThen: DelayStep = {
      id: 'then-delay',
      type: 'delay',
      duration: 'PT1S',
    };

    const delayElse: DelayStep = {
      id: 'else-delay',
      type: 'delay',
      duration: 'PT2S',
    };

    const conditionStep: ConditionStep = {
      id: 'cond-1',
      type: 'condition',
      expression: '{{trigger.payload.nonExistent}}',
      thenSteps: ['then-delay'],
      elseSteps: ['else-delay'],
    };

    const input = makeInput([conditionStep, delayThen, delayElse]);
    const deps: WorkflowHandlerDeps = {
      persistence,
      publisher,
      dispatcherDeps: {},
    };

    const result = await runWorkflow(input, 'exec-else', deps);

    expect(result.status).toBe('completed');
    expect(result.context.steps['cond-1'].status).toBe('completed');
    // Else branch was executed (nonExistent is undefined → falsy)
    expect(result.context.steps['else-delay'].status).toBe('completed');
    // Then branch was NOT executed
    expect(result.context.steps['then-delay']).toBeUndefined();
  });

  it('records delay controlFlow metadata', async () => {
    const delayStep: DelayStep = {
      id: 'delay-1',
      type: 'delay',
      duration: 'PT5S',
    };

    const input = makeInput([delayStep]);
    const deps: WorkflowHandlerDeps = {
      persistence,
      publisher,
      dispatcherDeps: {},
    };

    const result = await runWorkflow(input, 'exec-delay', deps);

    expect(result.status).toBe('completed');
    expect(result.context.steps['delay-1'].delayMs).toBe(5000);
  });

  it('handles step execution failure gracefully', async () => {
    const toolStep = {
      id: 'tool-1',
      type: 'tool_call' as const,
      toolName: 'failing_tool',
      params: {},
    };

    const input = makeInput([toolStep]);
    const deps: WorkflowHandlerDeps = {
      persistence,
      publisher,
      dispatcherDeps: {
        toolClient: {
          executeTool: vi.fn().mockRejectedValue(new Error('Tool failed')),
        },
      },
    };

    const result = await runWorkflow(input, 'exec-3', deps);

    expect(result.status).toBe('failed');
    expect(result.error?.message).toBe('Tool failed');
    expect(result.context.steps['tool-1'].status).toBe('failed');

    // Verify failure was persisted
    expect(persistence.updateExecutionStatus).toHaveBeenCalledWith(
      'exec-3',
      't1',
      'p1',
      'failed',
      expect.objectContaining({
        error: { code: 'WORKFLOW_FAILED', message: 'Tool failed' },
      }),
    );
  });

  it('publishes status events for workflow lifecycle', async () => {
    const input = makeInput([]);
    const deps: WorkflowHandlerDeps = {
      persistence,
      publisher,
      dispatcherDeps: {},
    };

    await runWorkflow(input, 'exec-4', deps);

    const publishCalls = (publisher.publish as ReturnType<typeof vi.fn>).mock.calls;
    const messages = publishCalls.map(([, msg]: [string, string]) => JSON.parse(msg));

    expect(messages).toEqual([
      expect.objectContaining({
        type: 'workflow.failed',
        executionId: 'exec-4',
        error: expect.stringMatching(/no complete Start/i),
      }),
    ]);
  });

  it('publishes step events during execution', async () => {
    const delayStep: DelayStep = {
      id: 'delay-1',
      type: 'delay',
      duration: 'PT5S',
    };

    const input = makeInput([delayStep]);
    const deps: WorkflowHandlerDeps = {
      persistence,
      publisher,
      dispatcherDeps: {},
    };

    await runWorkflow(input, 'exec-5', deps);

    const publishCalls = (publisher.publish as ReturnType<typeof vi.fn>).mock.calls;
    const messages = publishCalls.map(([, msg]: [string, string]) => JSON.parse(msg));

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'step.started',
          stepId: 'delay-1',
        }),
        expect.objectContaining({
          type: 'step.completed',
          stepId: 'delay-1',
        }),
      ]),
    );
  });

  it('uses tenant-scoped pub/sub channels', async () => {
    const input = makeInput([]);
    const deps: WorkflowHandlerDeps = {
      persistence,
      publisher,
      dispatcherDeps: {},
    };

    await runWorkflow(input, 'exec-6', deps);

    const publishCalls = (publisher.publish as ReturnType<typeof vi.fn>).mock.calls;
    const channels = publishCalls.map(([channel]: [string]) => channel);

    for (const channel of channels) {
      expect(channel).toContain('t1');
      expect(channel).toContain('exec-6');
    }
  });
});

describe('C1: ctx.run idempotency wrapping', () => {
  let persistence: ExecutionPersistence;
  let publisher: StatusPublisher;

  beforeEach(() => {
    persistence = makeMockPersistence();
    publisher = makeMockPublisher();
  });

  it('wraps step dispatch in restateCtx.run when restateCtx is provided', async () => {
    const delayStep: DelayStep = {
      id: 'delay-1',
      type: 'delay',
      duration: 'PT5S',
    };
    const input = makeInput([delayStep]);
    const deps: WorkflowHandlerDeps = {
      persistence,
      publisher,
      dispatcherDeps: {},
    };
    const restateCtx = makeMockRestateCtx();

    await runWorkflow(input, 'exec-ctx-run', deps, restateCtx);

    expect(restateCtx.runCalls).toContain('step:delay-1');
  });

  it('does not call ctx.run when restateCtx is not provided', async () => {
    const delayStep: DelayStep = {
      id: 'delay-1',
      type: 'delay',
      duration: 'PT5S',
    };
    const input = makeInput([delayStep]);
    const deps: WorkflowHandlerDeps = {
      persistence,
      publisher,
      dispatcherDeps: {},
    };

    const result = await runWorkflow(input, 'exec-no-ctx', deps);

    // Should still complete successfully without restateCtx
    expect(result.status).toBe('completed');
  });

  it('wraps each step in its own ctx.run call', async () => {
    const step1: DelayStep = { id: 'delay-1', type: 'delay', duration: 'PT1S' };
    const step2: DelayStep = { id: 'delay-2', type: 'delay', duration: 'PT2S' };
    const input = makeInput([step1, step2]);
    const deps: WorkflowHandlerDeps = {
      persistence,
      publisher,
      dispatcherDeps: {},
    };
    const restateCtx = makeMockRestateCtx();

    await runWorkflow(input, 'exec-multi', deps, restateCtx);

    expect(restateCtx.runCalls).toEqual(expect.arrayContaining(['step:delay-1', 'step:delay-2']));
  });
});

describe('C2: step retry with backoff', () => {
  let persistence: ExecutionPersistence;
  let publisher: StatusPublisher;

  beforeEach(() => {
    persistence = makeMockPersistence();
    publisher = makeMockPublisher();
  });

  it('retries a failing step and succeeds on second attempt', async () => {
    const mockToolClient = {
      executeTool: vi
        .fn()
        .mockRejectedValueOnce(new Error('Transient failure'))
        .mockResolvedValueOnce({ success: true, status: 'completed', output: { ok: true } }),
    };

    const toolStep = {
      id: 'tool-retry',
      type: 'tool_call' as const,
      toolName: 'flaky_tool',
      params: {},
      retry: { maxAttempts: 3, delayMs: 100, backoffMultiplier: 2 },
    };

    const input = makeInput([toolStep]);
    const deps: WorkflowHandlerDeps = {
      persistence,
      publisher,
      dispatcherDeps: { toolClient: mockToolClient },
    };

    const result = await runWorkflow(input, 'exec-retry-ok', deps);

    expect(result.status).toBe('completed');
    expect(mockToolClient.executeTool).toHaveBeenCalledTimes(2);
  });

  it('exhausts all retry attempts and fails', async () => {
    const mockToolClient = {
      executeTool: vi.fn().mockRejectedValue(new Error('Persistent failure')),
    };

    const toolStep = {
      id: 'tool-fail',
      type: 'tool_call' as const,
      toolName: 'broken_tool',
      params: {},
      retry: { maxAttempts: 3, delayMs: 50, backoffMultiplier: 2 },
    };

    const input = makeInput([toolStep]);
    const deps: WorkflowHandlerDeps = {
      persistence,
      publisher,
      dispatcherDeps: { toolClient: mockToolClient },
    };

    const result = await runWorkflow(input, 'exec-retry-fail', deps);

    expect(result.status).toBe('failed');
    expect(result.error?.message).toBe('Persistent failure');
    expect(mockToolClient.executeTool).toHaveBeenCalledTimes(3);
  });

  it('uses restateCtx.sleep for retry delays when available', async () => {
    const mockToolClient = {
      executeTool: vi
        .fn()
        .mockRejectedValueOnce(new Error('Transient'))
        .mockResolvedValueOnce({ success: true, status: 'completed', output: {} }),
    };

    const toolStep = {
      id: 'tool-sleep',
      type: 'tool_call' as const,
      toolName: 'flaky_tool',
      params: {},
      retry: { maxAttempts: 2, delayMs: 500 },
    };

    const input = makeInput([toolStep]);
    const restateCtx = makeMockRestateCtx();
    const deps: WorkflowHandlerDeps = {
      persistence,
      publisher,
      dispatcherDeps: { toolClient: mockToolClient },
    };

    await runWorkflow(input, 'exec-retry-sleep', deps, restateCtx);

    expect(restateCtx.sleep).toHaveBeenCalledWith(500);
  });

  it('applies exponential backoff — delay doubles each retry', async () => {
    const mockToolClient = {
      executeTool: vi
        .fn()
        .mockRejectedValueOnce(new Error('Fail 1'))
        .mockRejectedValueOnce(new Error('Fail 2'))
        .mockResolvedValueOnce({ success: true, status: 'completed', output: {} }),
    };

    const toolStep = {
      id: 'tool-backoff',
      type: 'tool_call' as const,
      toolName: 'flaky_tool',
      params: {},
      retry: { maxAttempts: 3, delayMs: 100, backoffMultiplier: 2 },
    };

    const input = makeInput([toolStep]);
    const restateCtx = makeMockRestateCtx();
    const deps: WorkflowHandlerDeps = {
      persistence,
      publisher,
      dispatcherDeps: { toolClient: mockToolClient },
    };

    await runWorkflow(input, 'exec-backoff', deps, restateCtx);

    expect(restateCtx.sleep).toHaveBeenNthCalledWith(1, 100);
    expect(restateCtx.sleep).toHaveBeenNthCalledWith(2, 200);
    expect(restateCtx.sleep).toHaveBeenCalledTimes(2);
  });

  it('names retry attempts uniquely for Restate tracking', async () => {
    const mockToolClient = {
      executeTool: vi
        .fn()
        .mockRejectedValueOnce(new Error('Fail 1'))
        .mockRejectedValueOnce(new Error('Fail 2'))
        .mockResolvedValueOnce({ success: true, status: 'completed', output: {} }),
    };

    const toolStep = {
      id: 'tool-names',
      type: 'tool_call' as const,
      toolName: 'flaky_tool',
      params: {},
      retry: { maxAttempts: 3, delayMs: 10 },
    };

    const input = makeInput([toolStep]);
    const restateCtx = makeMockRestateCtx();
    const deps: WorkflowHandlerDeps = {
      persistence,
      publisher,
      dispatcherDeps: { toolClient: mockToolClient },
    };

    await runWorkflow(input, 'exec-retry-names', deps, restateCtx);

    expect(restateCtx.runCalls).toEqual(
      expect.arrayContaining([
        'step:tool-names:attempt:1',
        'step:tool-names:attempt:2',
        'step:tool-names:attempt:3',
      ]),
    );
  });

  it('does not retry steps without retry config (backward compat)', async () => {
    const mockToolClient = {
      executeTool: vi.fn().mockRejectedValue(new Error('One-shot failure')),
    };

    const toolStep = {
      id: 'tool-no-retry',
      type: 'tool_call' as const,
      toolName: 'strict_tool',
      params: {},
      // No retry config
    };

    const input = makeInput([toolStep]);
    const deps: WorkflowHandlerDeps = {
      persistence,
      publisher,
      dispatcherDeps: { toolClient: mockToolClient },
    };

    const result = await runWorkflow(input, 'exec-no-retry', deps);

    expect(result.status).toBe('failed');
    expect(mockToolClient.executeTool).toHaveBeenCalledTimes(1);
  });

  it('waits for workflow tool callback completion when executionMode is async_wait', async () => {
    const mockToolClient = {
      executeTool: vi.fn().mockResolvedValue({
        success: true,
        status: 'accepted',
        output: {
          executionId: 'child-exec-1',
          status: 'running',
        },
      }),
    };

    const toolStep = {
      id: 'tool-wait',
      type: 'tool_call' as const,
      toolName: 'child_tool',
      params: {},
      executionMode: 'async_wait' as const,
      timeout: 5000,
    };

    const input = makeInput([toolStep]);
    input.triggerMetadata = { userId: 'user-1' };
    const restateCtx = makeMockRestateCtx();
    const callbackPayload = {
      executionId: 'child-exec-1',
      status: 'completed',
      output: { result: 'done' },
    };
    // tool_call async_wait uses ctx.awakeable() — resolve it with callbackPayload
    vi.mocked(restateCtx.awakeable).mockReturnValueOnce({
      id: 'test-tool-awakeable',
      promise: Object.assign(Promise.resolve(callbackPayload), {
        orTimeout: vi.fn().mockResolvedValue(callbackPayload),
      }),
    });

    const deps: WorkflowHandlerDeps = {
      persistence,
      publisher,
      encryptSecret: vi.fn(async (plaintext: string) => `cipher:${plaintext}`),
      decryptSecret: vi.fn(async (ciphertext: string) => ciphertext.replace('cipher:', '')),
      dispatcherDeps: {
        toolClient: mockToolClient,
        callbackUrlBuilder: {
          buildCallbackUrl: (executionId, stepId) =>
            `https://engine.example.com/api/v1/workflows/callbacks/${executionId}/${stepId}`,
        },
      },
    };

    const result = await runWorkflow(input, 'exec-tool-wait', deps, restateCtx);

    expect(result.status).toBe('completed');
    expect(mockToolClient.executeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'child_tool',
        callback: expect.objectContaining({
          url: 'https://engine.example.com/api/v1/workflows/callbacks/exec-tool-wait/tool-wait',
        }),
      }),
    );
    expect(result.context.steps['tool-wait']?.status).toBe('completed');
    expect(result.context.steps['tool-wait']?.output).toEqual({
      executionId: 'child-exec-1',
      status: 'completed',
      output: { result: 'done' },
    });
  });

  it('does not retry non-retryable step types (condition, transform, etc.)', async () => {
    // Condition steps should never retry even if someone adds retry config
    const condStep: ConditionStep = {
      id: 'cond-no-retry',
      type: 'condition',
      expression: '{{trigger.payload.orderId}}',
      thenSteps: [],
    };

    const input = makeInput([condStep]);
    const restateCtx = makeMockRestateCtx();
    const deps: WorkflowHandlerDeps = {
      persistence,
      publisher,
      dispatcherDeps: {},
    };

    await runWorkflow(input, 'exec-cond-no-retry', deps, restateCtx);

    // Should use simple step name (no :attempt: suffix) since maxAttempts=1
    expect(restateCtx.runCalls).toContain('step:cond-no-retry');
    expect(restateCtx.runCalls).not.toEqual(
      expect.arrayContaining([expect.stringContaining(':attempt:')]),
    );
  });

  it('waits for HTTP tool callback completion when async_wait returns completed handoff', async () => {
    const mockToolClient = {
      executeTool: vi.fn().mockResolvedValue({
        success: true,
        status: 'completed',
        output: {
          jobId: 'job-1',
          status: 'queued',
        },
      }),
    };

    const toolStep = {
      id: 'http-tool-wait',
      type: 'tool_call' as const,
      toolName: 'http_post',
      params: {},
      executionMode: 'async_wait' as const,
      callbackConfig: {
        enabled: true,
        location: 'body' as const,
        callbackUrlKey: 'callbackUrl',
        callbackSecretKey: 'callbackSecret',
      },
      timeout: 5000,
    };

    const input = makeInput([toolStep]);
    const restateCtx = makeMockRestateCtx();
    const callbackPayload = {
      executionId: 'job-1',
      status: 'completed',
      output: { delivered: true },
    };
    // tool_call async_wait uses ctx.awakeable() — resolve it with callbackPayload
    vi.mocked(restateCtx.awakeable).mockReturnValueOnce({
      id: 'test-http-tool-awakeable',
      promise: Object.assign(Promise.resolve(callbackPayload), {
        orTimeout: vi.fn().mockResolvedValue(callbackPayload),
      }),
    });

    const deps: WorkflowHandlerDeps = {
      persistence,
      publisher,
      encryptSecret: vi.fn(async (plaintext: string) => `cipher:${plaintext}`),
      decryptSecret: vi.fn(async (ciphertext: string) => ciphertext.replace('cipher:', '')),
      dispatcherDeps: {
        toolClient: mockToolClient,
        callbackUrlBuilder: {
          buildCallbackUrl: (executionId, stepId) =>
            `https://engine.example.com/api/v1/workflows/callbacks/${executionId}/${stepId}`,
        },
      },
    };

    const result = await runWorkflow(input, 'exec-http-tool-wait', deps, restateCtx);

    expect(result.status).toBe('completed');
    expect(result.context.steps['http-tool-wait']?.status).toBe('completed');
    expect(result.context.steps['http-tool-wait']?.output).toEqual({ delivered: true });
    expect(mockToolClient.executeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'http_post',
        executionMode: 'async_wait',
        callback: {
          url: 'https://engine.example.com/api/v1/workflows/callbacks/exec-http-tool-wait/http-tool-wait',
          secret: expect.any(String),
        },
        callbackConfig: {
          enabled: true,
          location: 'body',
          callbackUrlKey: 'callbackUrl',
          callbackSecretKey: 'callbackSecret',
        },
      }),
    );
  });

  describe('callback queue enqueue on completion', () => {
    // Covers workflow-handler.ts line 1362 — the callback-queue add on success.
    it('enqueues a completed callback when callbackQueue and callbackUrl are configured', async () => {
      const callbackAdd = vi.fn().mockResolvedValue({ id: 'queued-1' });
      const input = {
        ...makeInput([{ id: 'callback-delay', type: 'delay', duration: 'PT1S' }]),
        triggerMetadata: {
          callbackUrl: 'https://example.com/hook',
          source: 'external-system',
          sessionId: 'sess-99',
        },
      };
      const deps: WorkflowHandlerDeps = {
        persistence,
        publisher,
        dispatcherDeps: {},
        callbackQueue: { add: callbackAdd },
      };

      const result = await runWorkflow(input, 'exec-cb-ok', deps);

      expect(result.status).toBe('completed');
      expect(callbackAdd).toHaveBeenCalledWith(
        'callback',
        expect.objectContaining({
          executionId: 'exec-cb-ok',
          tenantId: 't1',
          callbackUrl: 'https://example.com/hook',
          source: 'external-system',
          payload: expect.objectContaining({
            status: 'completed',
            executionId: 'exec-cb-ok',
            workflowId: 'wf-1',
            sessionId: 'sess-99',
          }),
        }),
      );
    });

    it('does NOT enqueue a callback when callbackQueue is absent', async () => {
      // Guard: the callbackUrl presence alone should not trigger enqueue.
      const input = {
        ...makeInput([{ id: 'callback-delay', type: 'delay', duration: 'PT1S' }]),
        triggerMetadata: { callbackUrl: 'https://example.com/hook' },
      };
      const deps: WorkflowHandlerDeps = {
        persistence,
        publisher,
        dispatcherDeps: {},
        // callbackQueue intentionally omitted
      };

      const result = await runWorkflow(input, 'exec-cb-missing-queue', deps);
      expect(result.status).toBe('completed');
    });
  });

  describe('callback queue enqueue on failure', () => {
    // Covers workflow-handler.ts line 1426 — the callback-queue add on the
    // non-cancellation failure path.
    it('enqueues a failed callback when a step throws and callbackQueue is configured', async () => {
      const callbackAdd = vi.fn().mockResolvedValue({ id: 'queued-fail' });

      // Force a failure: use a connector_action with no params/connection,
      // then an unknown step type that the dispatcher rejects.
      const badStep = {
        id: 'bad-step',
        type: 'unknown_type_xyz',
      } as unknown as WorkflowExecutionInput['steps'][number];

      const input = {
        ...makeInput([badStep]),
        triggerMetadata: {
          callbackUrl: 'https://example.com/hook-fail',
          source: 'external-system',
        },
      };
      const deps: WorkflowHandlerDeps = {
        persistence,
        publisher,
        dispatcherDeps: {},
        callbackQueue: { add: callbackAdd },
      };

      const result = await runWorkflow(input, 'exec-cb-fail', deps);

      expect(result.status).toBe('failed');
      expect(callbackAdd).toHaveBeenCalledWith(
        'callback',
        expect.objectContaining({
          executionId: 'exec-cb-fail',
          tenantId: 't1',
          callbackUrl: 'https://example.com/hook-fail',
          payload: expect.objectContaining({
            status: 'failed',
            error: expect.objectContaining({ code: 'WORKFLOW_FAILED' }),
          }),
        }),
      );
    });
  });

  describe('async_wait HTTP tool — completed inline enters waiting_callback', () => {
    it('sets step to waiting_callback when HTTP tool returns completed inline before callback arrives', async () => {
      const mockToolClient = {
        executeTool: vi.fn().mockResolvedValue({
          success: true,
          status: 'completed',
          output: { jobId: 'job-inline' },
        }),
      };

      const toolStep = {
        id: 'http-inline-wait',
        type: 'tool_call' as const,
        toolName: 'http_submit',
        params: {},
        executionMode: 'async_wait' as const,
        callbackConfig: {
          enabled: true,
          location: 'body' as const,
          callbackUrlKey: 'callbackUrl',
          callbackSecretKey: 'callbackSecret',
        },
        timeout: 5000,
      };

      const input = makeInput([toolStep]);
      const restateCtx = makeMockRestateCtx();
      const callbackPayload = { status: 'completed', output: { confirmed: true } };

      // tool_call async_wait uses ctx.awakeable() — resolve it with callbackPayload
      vi.mocked(restateCtx.awakeable).mockReturnValueOnce({
        id: 'test-inline-awakeable',
        promise: Object.assign(Promise.resolve(callbackPayload), {
          orTimeout: vi.fn().mockResolvedValue(callbackPayload),
        }),
      });

      const deps: WorkflowHandlerDeps = {
        persistence,
        publisher,
        encryptSecret: vi.fn(async (plaintext: string) => `cipher:${plaintext}`),
        decryptSecret: vi.fn(async (ciphertext: string) => ciphertext.replace('cipher:', '')),
        dispatcherDeps: {
          toolClient: mockToolClient,
          callbackUrlBuilder: {
            buildCallbackUrl: (executionId, stepId) =>
              `https://engine.example.com/api/v1/workflows/callbacks/${executionId}/${stepId}`,
          },
        },
      };

      const result = await runWorkflow(input, 'exec-http-inline', deps, restateCtx);

      expect(result.status).toBe('completed');

      // Intermediate state: step must have entered waiting_callback before callback resolved
      const updateCalls = (persistence.updateStepStatus as ReturnType<typeof vi.fn>).mock.calls;
      const waitingCallbackCall = updateCalls.find((c: unknown[]) => c[4] === 'waiting_callback');
      expect(waitingCallbackCall).toBeDefined();

      // Publisher must have emitted step.waiting_callback event
      const publishCalls = (publisher.publish as ReturnType<typeof vi.fn>).mock.calls;
      const waitingCallbackEvent = publishCalls.find((c: unknown[]) => {
        const msg = typeof c[1] === 'string' ? JSON.parse(c[1]) : c[1];
        return msg?.type === 'step.waiting_callback' && msg?.stepId === 'http-inline-wait';
      });
      expect(waitingCallbackEvent).toBeDefined();

      // Final output comes from the callback payload, not the inline response
      expect(result.context.steps['http-inline-wait']?.status).toBe('completed');
      expect(result.context.steps['http-inline-wait']?.output).toEqual({ confirmed: true });
    });
  });
});
