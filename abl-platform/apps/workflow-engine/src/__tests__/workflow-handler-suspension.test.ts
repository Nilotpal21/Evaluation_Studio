import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dispatchStep to isolate suspension logic from actual executors
vi.mock('../handlers/step-dispatcher.js', () => ({
  dispatchStep: vi.fn(),
  resolveStepInput: vi.fn().mockReturnValue(undefined),
}));

// Mock the DNS-pinning safeFetch path so webhook tests with synthetic
// hostnames (e.g. http://target.example.com) don't hit real DNS.
vi.mock('@agent-platform/shared-kernel/security/safe-fetch', () => ({
  assertUrlSafeForFetch: vi.fn().mockResolvedValue(undefined),
  safeFetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
}));

import {
  runWorkflow,
  CancellationError,
  TimeoutError,
  type WorkflowExecutionInput,
  type WorkflowHandlerDeps,
  type ExecutionPersistence,
  type StatusPublisher,
  type RestateWorkflowCtx,
  type RestatePromiseHandle,
  type DurablePromiseHandle,
} from '../handlers/workflow-handler.js';
import { dispatchStep } from '../handlers/step-dispatcher.js';
import type { StepDispatchResult } from '../handlers/step-dispatcher.js';
import type { DelayStep } from '../executors/delay-executor.js';
import type { ApprovalStep, ApprovalRequest } from '../executors/approval-executor.js';
import type { AsyncWebhookStep, AsyncWebhookRequest } from '../executors/async-webhook-executor.js';

const mockDispatch = dispatchStep as unknown as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePersistence(): ExecutionPersistence {
  return {
    createExecution: vi.fn().mockResolvedValue(undefined),
    updateStepStatus: vi.fn().mockResolvedValue(undefined),
    updateExecutionStatus: vi.fn().mockResolvedValue(undefined),
  };
}

function makePublisher(): StatusPublisher {
  return { publish: vi.fn().mockResolvedValue(undefined) };
}

function makeInput(
  steps: WorkflowExecutionInput['steps'] = [],
  overrides: Partial<WorkflowExecutionInput> = {},
): WorkflowExecutionInput {
  return {
    workflowId: 'wf-1',
    workflowName: 'test-flow',
    tenantId: 't1',
    projectId: 'p1',
    triggerType: 'webhook',
    triggerPayload: { orderId: 'ORD-123' },
    steps,
    ...overrides,
  };
}

/** Create a RestatePromiseHandle (supports .orTimeout()) from a base promise.
 *  `settles` controls whether the base promise eventually resolves.
 *  For never-resolving promises, orTimeout fires immediately (test-friendly). */
function makeRestatePromise<T>(base: Promise<T>, settles = true): RestatePromiseHandle<T> {
  const handle = Object.assign(base, {
    orTimeout: vi.fn((millis: number) => {
      if (!settles) {
        // Base never resolves — fire timeout immediately for tests
        const err = new Error(`Timed out after ${millis}ms`);
        err.name = 'TimeoutError';
        return makeRestatePromise(Promise.reject(err), false);
      }
      // Base resolves — race against a real timer (base should win)
      const timeoutP = new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          const e = new Error(`Timed out after ${millis}ms`);
          e.name = 'TimeoutError';
          reject(e);
        }, millis);
      });
      return makeRestatePromise(Promise.race([base, timeoutP]));
    }),
  }) as RestatePromiseHandle<T>;
  return handle;
}

/** DurablePromiseHandle that resolves to `value`; peek resolves to `peekValue`. */
function makeDurablePromise<T>(value: T, peekValue?: T): DurablePromiseHandle<T> {
  const base = Promise.resolve(value);
  return Object.assign(base, {
    peek: vi.fn().mockResolvedValue(peekValue),
    resolve: vi.fn().mockResolvedValue(undefined),
    get: vi.fn(() => makeRestatePromise(Promise.resolve(value))),
  }) as DurablePromiseHandle<T>;
}

/** DurablePromiseHandle that never resolves (for timeout tests). */
function makeNeverPromise<T>(peekValue?: T): DurablePromiseHandle<T> {
  const base = new Promise<T>(() => {});
  return Object.assign(base, {
    peek: vi.fn().mockResolvedValue(peekValue),
    resolve: vi.fn().mockResolvedValue(undefined),
    get: vi.fn(() => makeRestatePromise(new Promise<T>(() => {}), false)),
  }) as DurablePromiseHandle<T>;
}

/** Create a mock RestateWorkflowCtx with optional promise map and awakeable queue. */
function createRestateCtx(opts?: {
  promises?: Record<string, DurablePromiseHandle<unknown>>;
  /** Sequential values that awakeable() calls resolve with. Omitted → never resolves (timeout). */
  awakeableResults?: unknown[];
  sleepImpl?: (...args: unknown[]) => Promise<void>;
}): RestateWorkflowCtx {
  const promises = opts?.promises ?? {};
  const defaultCancel = makeDurablePromise<unknown>(undefined, undefined);
  const awakeableQueue = [...(opts?.awakeableResults ?? [])];
  let awakeableIdCounter = 0;

  const sleepFn = opts?.sleepImpl
    ? vi.fn((...args: unknown[]) => {
        const result = opts.sleepImpl!(...args);
        return makeRestatePromise(result);
      })
    : vi.fn(() => makeRestatePromise(Promise.resolve()));

  return {
    sleep: sleepFn,
    run: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
    promise: vi.fn().mockImplementation((name: string) => {
      if (name in promises) return promises[name];
      if (name === 'sys:cancel') return defaultCancel;
      return makeDurablePromise(undefined, undefined);
    }),
    awakeable: vi.fn(() => {
      const id = `test-awakeable-${awakeableIdCounter++}`;
      const value = awakeableQueue.shift();
      const promise =
        value === undefined
          ? makeRestatePromise(new Promise<unknown>(() => {}), false) // never resolves → timeout
          : makeRestatePromise(Promise.resolve(value));
      return { id, promise };
    }),
  } as RestateWorkflowCtx;
}

/** Extract step status transitions from persistence mock. */
function stepStatuses(persistence: ExecutionPersistence, stepId: string): string[] {
  return (persistence.updateStepStatus as ReturnType<typeof vi.fn>).mock.calls
    .filter(([, , , sid]: unknown[]) => sid === stepId)
    .map(([, , , , status]: unknown[]) => status as string);
}

/** Extract published messages from publisher mock. */
function publishedMessages(publisher: StatusPublisher): Array<Record<string, unknown>> {
  return (publisher.publish as ReturnType<typeof vi.fn>).mock.calls.map(
    ([, msg]: [string, string]) => JSON.parse(msg),
  );
}

// ---------------------------------------------------------------------------
// Reusable fixtures
// ---------------------------------------------------------------------------

const delayStep: DelayStep = { id: 'delay-1', type: 'delay', duration: 'PT5S' };

const approvalStep: ApprovalStep = {
  id: 'approval-1',
  type: 'approval',
  approvers: ['user@example.com'],
  message: 'Please approve',
};

const webhookStep: AsyncWebhookStep = {
  id: 'webhook-1',
  type: 'async_webhook',
  url: 'https://external.api/hook',
  method: 'POST',
  body: { ref: '{{trigger.payload.orderId}}' },
};

const delayResult: StepDispatchResult = { type: 'delay', output: null, delayMs: 5000 };

const approvalRequest: ApprovalRequest = {
  approvalId: 'apr-1',
  executionId: 'exec-a',
  stepId: 'approval-1',
  message: 'Please approve',
  approvers: ['user@example.com'],
  tenantId: 't1',
  projectId: 'p1',
  timeoutMs: 72 * 3600 * 1000,
  onTimeout: 'reject',
};

const approvalResult: StepDispatchResult = {
  type: 'approval',
  output: null,
  approvalRequest,
};

const webhookRequest: AsyncWebhookRequest = {
  url: 'https://external.api/hook',
  method: 'POST',
  headers: {},
  body: { ref: 'ORD-123' },
  callbackId: 'cb-1',
};

const webhookResult: StepDispatchResult = {
  type: 'async_webhook',
  output: null,
  webhookRequest,
};

const nonSuspensionResult: StepDispatchResult = { type: 'http', output: { data: 'ok' } };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('workflow-handler suspension (Restate ctx)', () => {
  beforeEach(() => {
    // mockReset clears the once queue (mockResolvedValueOnce etc.)
    // which vi.clearAllMocks does NOT do — stale values shift subsequent tests
    mockDispatch.mockReset();
  });

  describe('delay steps', () => {
    it('sleeps via restateCtx.sleep and marks step completed', async () => {
      mockDispatch.mockResolvedValueOnce(delayResult);
      const restateCtx = createRestateCtx();
      const deps: WorkflowHandlerDeps = {
        persistence: makePersistence(),
        publisher: makePublisher(),
        dispatcherDeps: {},
      };

      const result = await runWorkflow(makeInput([delayStep]), 'exec-d1', deps, restateCtx);

      expect(result.status).toBe('completed');
      expect(restateCtx.sleep).toHaveBeenCalledWith(5000);
      expect(stepStatuses(deps.persistence, 'delay-1')).toEqual([
        'running',
        'waiting_delay',
        'completed',
      ]);
    });

    it('cancellation during delay sleep throws CancellationError', async () => {
      mockDispatch.mockResolvedValueOnce(delayResult);
      const restateCtx = createRestateCtx({
        promises: { 'sys:cancel': makeDurablePromise<unknown>(true, true) },
        sleepImpl: () => new Promise(() => {}), // sleep never resolves
      });
      const deps: WorkflowHandlerDeps = {
        persistence: makePersistence(),
        publisher: makePublisher(),
        dispatcherDeps: {},
      };

      const result = await runWorkflow(makeInput([delayStep]), 'exec-d2', deps, restateCtx);

      expect(result.status).toBe('cancelled');
      expect(result.error?.code).toBe('WORKFLOW_CANCELLED');
      expect(stepStatuses(deps.persistence, 'delay-1')).toEqual(['running', 'waiting_delay']);
    });

    it('records controlFlow without restateCtx (backwards compat)', async () => {
      mockDispatch.mockResolvedValueOnce(delayResult);
      const deps: WorkflowHandlerDeps = {
        persistence: makePersistence(),
        publisher: makePublisher(),
        dispatcherDeps: {},
      };

      const result = await runWorkflow(makeInput([delayStep]), 'exec-d3', deps);

      expect(result.status).toBe('completed');
      expect(result.context.steps['delay-1'].delayMs).toBe(5000);
      expect(stepStatuses(deps.persistence, 'delay-1')).toEqual(['running', 'completed']);
    });
  });

  describe('approval steps', () => {
    it('waits for approval and continues on accept', async () => {
      const decision = { approved: true, decidedBy: 'admin@co.com' };
      mockDispatch.mockResolvedValueOnce(approvalResult);
      const restateCtx = createRestateCtx({ awakeableResults: [decision] });
      const deps: WorkflowHandlerDeps = {
        persistence: makePersistence(),
        publisher: makePublisher(),
        dispatcherDeps: {},
      };

      const result = await runWorkflow(makeInput([approvalStep]), 'exec-a1', deps, restateCtx);

      expect(result.status).toBe('completed');
      const output = result.context.steps['approval-1'].output as Record<string, unknown>;
      expect(output.approvalDecision).toEqual(decision);
      expect(stepStatuses(deps.persistence, 'approval-1')).toEqual([
        'running',
        'waiting_approval',
        'approved',
        'completed',
      ]);
      expect(publishedMessages(deps.publisher)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'step.waiting_approval', stepId: 'approval-1' }),
        ]),
      );
    });

    it('marks only the approved human edge in pathState after approval', async () => {
      const decision = { approved: true, decidedBy: 'admin@co.com' };
      const approvalWithRouting = {
        ...approvalStep,
        onSuccessSteps: ['delay-1'],
        onRejectSteps: ['delay-1'],
        canvasRouted: true,
      } as WorkflowExecutionInput['steps'][number];
      mockDispatch.mockResolvedValueOnce(approvalResult).mockResolvedValueOnce(delayResult);
      const restateCtx = createRestateCtx({ awakeableResults: [decision] });
      const deps: WorkflowHandlerDeps = {
        persistence: makePersistence(),
        publisher: makePublisher(),
        dispatcherDeps: {},
      };

      await runWorkflow(
        makeInput([approvalWithRouting, delayStep], {
          edgeMap: {
            'approval-1': [
              {
                edgeId: 'edge-approval-approved',
                sourceHandle: 'on_approve',
                target: 'delay-1',
              },
              {
                edgeId: 'edge-approval-rejected',
                sourceHandle: 'on_reject',
                target: 'delay-1',
              },
            ],
          },
        }),
        'exec-a1-path',
        deps,
        restateCtx,
      );

      const delayCompletedEvent = publishedMessages(deps.publisher).find(
        (message) => message.type === 'step.completed' && message.stepId === 'delay-1',
      );
      expect(delayCompletedEvent?.pathState).toMatchObject({
        'edge-approval-approved': 'completed',
      });
      expect(
        (delayCompletedEvent?.pathState as Record<string, unknown> | undefined)?.[
          'edge-approval-rejected'
        ],
      ).toBeUndefined();
    });

    it('returns rejected status when approval is rejected', async () => {
      const decision = { approved: false, decidedBy: 'boss@co.com', reason: 'Budget exceeded' };
      mockDispatch.mockResolvedValueOnce(approvalResult);
      const restateCtx = createRestateCtx({ awakeableResults: [decision] });
      const deps: WorkflowHandlerDeps = {
        persistence: makePersistence(),
        publisher: makePublisher(),
        dispatcherDeps: {},
      };

      const result = await runWorkflow(makeInput([approvalStep]), 'exec-a2', deps, restateCtx);

      expect(result.status).toBe('rejected');
      expect(result.error?.code).toBe('APPROVAL_REJECTED');
      expect(result.error?.message).toContain('boss@co.com');
      expect(result.error?.message).toContain('Budget exceeded');
      expect(stepStatuses(deps.persistence, 'approval-1')).toEqual([
        'running',
        'waiting_approval',
        'rejected',
      ]);
    });

    it('times out and auto-rejects by default', async () => {
      mockDispatch.mockResolvedValueOnce(approvalResult);
      const restateCtx = createRestateCtx({ awakeableResults: [] }); // empty → never resolves → timeout
      const deps: WorkflowHandlerDeps = {
        persistence: makePersistence(),
        publisher: makePublisher(),
        dispatcherDeps: {},
      };

      const result = await runWorkflow(makeInput([approvalStep]), 'exec-a3', deps, restateCtx);

      expect(result.status).toBe('rejected');
      expect(result.error?.code).toBe('APPROVAL_REJECTED');
      const output = result.context.steps['approval-1'].output as Record<string, unknown>;
      const dec = output.approvalDecision as Record<string, unknown>;
      expect(dec.decidedBy).toBe('system:timeout');
      expect(dec.approved).toBe(false);
    });

    it('times out and auto-approves when onTimeout is approve', async () => {
      const autoApproveStep: ApprovalStep = {
        ...approvalStep,
        id: 'approval-2',
        onTimeout: 'approve',
      };
      const autoApproveResult: StepDispatchResult = {
        type: 'approval',
        output: null,
        approvalRequest: { ...approvalRequest, stepId: 'approval-2', onTimeout: 'approve' },
      };
      mockDispatch.mockResolvedValueOnce(autoApproveResult);
      const restateCtx = createRestateCtx({ awakeableResults: [] }); // empty → never resolves → timeout
      const deps: WorkflowHandlerDeps = {
        persistence: makePersistence(),
        publisher: makePublisher(),
        dispatcherDeps: {},
      };

      const result = await runWorkflow(makeInput([autoApproveStep]), 'exec-a4', deps, restateCtx);

      expect(result.status).toBe('completed');
      const output = result.context.steps['approval-2'].output as Record<string, unknown>;
      const dec = output.approvalDecision as Record<string, unknown>;
      expect(dec.decidedBy).toBe('system:timeout');
      expect(dec.approved).toBe(true);
    });
  });

  describe('webhook steps', () => {
    it('dispatches HTTP via ctx.run and waits for callback', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      const callbackPayload = { status: 'done', result: 42 };
      mockDispatch.mockResolvedValueOnce(webhookResult);
      const restateCtx = createRestateCtx({ awakeableResults: [callbackPayload] });
      const deps: WorkflowHandlerDeps = {
        persistence: makePersistence(),
        publisher: makePublisher(),
        dispatcherDeps: {},
      };

      const result = await runWorkflow(makeInput([webhookStep]), 'exec-w1', deps, restateCtx);

      expect(result.status).toBe('completed');
      expect(restateCtx.run).toHaveBeenCalledWith('send-webhook:webhook-1', expect.any(Function));
      const output = result.context.steps['webhook-1'].output as Record<string, unknown>;
      expect(output.callbackPayload).toEqual(callbackPayload);
      expect(stepStatuses(deps.persistence, 'webhook-1')).toEqual([
        'running',
        'waiting_callback',
        'completed',
      ]);
      expect(publishedMessages(deps.publisher)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'step.waiting_callback', stepId: 'webhook-1' }),
        ]),
      );

      globalThis.fetch = originalFetch;
    });

    it('retries the outbound fetch on failure using separate ctx.run names', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi
        .fn()
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({ ok: true, status: 200 });

      const retryWebhookStep: AsyncWebhookStep = {
        id: 'webhook-retry',
        type: 'async_webhook',
        url: 'https://external.api/hook',
        method: 'POST',
        body: {},
        retry: { maxAttempts: 2, delayMs: 100 },
      };
      const retryWebhookRequest: AsyncWebhookRequest = {
        url: 'https://external.api/hook',
        method: 'POST',
        headers: {},
        body: {},
        callbackId: 'cb-retry',
      };
      mockDispatch.mockResolvedValueOnce({
        type: 'async_webhook',
        output: null,
        webhookRequest: retryWebhookRequest,
      });
      const callbackPayload = { status: 'done' };
      const restateCtx = createRestateCtx({ awakeableResults: [callbackPayload] });
      const deps: WorkflowHandlerDeps = {
        persistence: makePersistence(),
        publisher: makePublisher(),
        dispatcherDeps: {},
      };

      const result = await runWorkflow(
        makeInput([retryWebhookStep]),
        'exec-w-retry',
        deps,
        restateCtx,
      );

      expect(result.status).toBe('completed');
      // Each attempt uses a unique ctx.run name
      expect(restateCtx.run).toHaveBeenCalledWith(
        'send-webhook:webhook-retry:attempt:1',
        expect.any(Function),
      );
      expect(restateCtx.run).toHaveBeenCalledWith(
        'send-webhook:webhook-retry:attempt:2',
        expect.any(Function),
      );
      // Sleep between attempts
      expect(restateCtx.sleep).toHaveBeenCalledWith(100);
      // fetch retried twice
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);

      globalThis.fetch = originalFetch;
    });

    it('throws after exhausting all webhook retry attempts', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Always fails'));

      const retryWebhookStep: AsyncWebhookStep = {
        id: 'webhook-fail',
        type: 'async_webhook',
        url: 'https://external.api/hook',
        method: 'POST',
        body: {},
        retry: { maxAttempts: 2, delayMs: 50 },
      };
      const retryWebhookRequest: AsyncWebhookRequest = {
        url: 'https://external.api/hook',
        method: 'POST',
        headers: {},
        body: {},
        callbackId: 'cb-fail',
      };
      mockDispatch.mockResolvedValueOnce({
        type: 'async_webhook',
        output: null,
        webhookRequest: retryWebhookRequest,
      });
      const restateCtx = createRestateCtx();
      const deps: WorkflowHandlerDeps = {
        persistence: makePersistence(),
        publisher: makePublisher(),
        dispatcherDeps: {},
      };

      const result = await runWorkflow(
        makeInput([retryWebhookStep]),
        'exec-w-fail',
        deps,
        restateCtx,
      );

      expect(result.status).toBe('failed');
      expect(result.error?.message).toContain('Always fails');

      globalThis.fetch = originalFetch;
    });
  });

  describe('cancellation', () => {
    it('detects cancellation between non-suspension steps', async () => {
      const step1: DelayStep = { id: 'step-1', type: 'delay', duration: 'PT1S' };
      const step2: DelayStep = { id: 'step-2', type: 'delay', duration: 'PT1S' };
      mockDispatch
        .mockResolvedValueOnce(nonSuspensionResult)
        .mockResolvedValueOnce(nonSuspensionResult);
      const restateCtx = createRestateCtx({
        promises: { 'sys:cancel': makeDurablePromise<unknown>(true, true) },
      });
      const deps: WorkflowHandlerDeps = {
        persistence: makePersistence(),
        publisher: makePublisher(),
        dispatcherDeps: {},
      };

      const result = await runWorkflow(makeInput([step1, step2]), 'exec-c1', deps, restateCtx);

      expect(result.status).toBe('cancelled');
      expect(result.error?.code).toBe('WORKFLOW_CANCELLED');
      expect(result.context.steps['step-1'].status).toBe('completed');
      expect(result.context.steps['step-2']).toBeUndefined();
    });

    it('does not check cancellation without restateCtx', async () => {
      const step1: DelayStep = { id: 'step-1', type: 'delay', duration: 'PT1S' };
      const step2: DelayStep = { id: 'step-2', type: 'delay', duration: 'PT1S' };
      mockDispatch
        .mockResolvedValueOnce({ ...nonSuspensionResult })
        .mockResolvedValueOnce({ ...nonSuspensionResult });
      const deps: WorkflowHandlerDeps = {
        persistence: makePersistence(),
        publisher: makePublisher(),
        dispatcherDeps: {},
      };

      const result = await runWorkflow(makeInput([step1, step2]), 'exec-c2', deps);

      expect(result.status).toBe('completed');
      expect(result.context.steps['step-1'].status).toBe('completed');
      expect(result.context.steps['step-2'].status).toBe('completed');
    });

    it('persists context on failure', async () => {
      mockDispatch.mockRejectedValueOnce(new Error('Step exploded'));
      const deps: WorkflowHandlerDeps = {
        persistence: makePersistence(),
        publisher: makePublisher(),
        dispatcherDeps: {},
      };

      const result = await runWorkflow(makeInput([delayStep]), 'exec-c3', deps);

      expect(result.status).toBe('failed');
      expect(result.error?.code).toBe('WORKFLOW_FAILED');
      const execCalls = (deps.persistence.updateExecutionStatus as ReturnType<typeof vi.fn>).mock
        .calls;
      const failCall = execCalls.find(([, , , status]: unknown[]) => status === 'failed');
      expect(failCall).toBeDefined();
      expect(failCall![4]).toHaveProperty('context');
      expect(failCall![4]).toHaveProperty('error');
    });
  });

  describe('awakeable + promise namespacing', () => {
    it('approval uses ctx.awakeable and cancel uses ctx.promise(sys:cancel)', async () => {
      const decision = { approved: true, decidedBy: 'admin' };
      mockDispatch.mockResolvedValueOnce(approvalResult);
      const restateCtx = createRestateCtx({ awakeableResults: [decision] });
      const deps: WorkflowHandlerDeps = {
        persistence: makePersistence(),
        publisher: makePublisher(),
        dispatcherDeps: {},
      };

      await runWorkflow(makeInput([approvalStep]), 'exec-ns', deps, restateCtx);

      // Approval now uses ctx.awakeable(), not ctx.promise()
      expect(restateCtx.awakeable).toHaveBeenCalledTimes(1);

      // sys:cancel still uses ctx.promise() — must have sys: prefix
      const promiseNames = (restateCtx.promise as ReturnType<typeof vi.fn>).mock.calls.map(
        ([name]: [string]) => name,
      );
      for (const name of promiseNames) {
        expect(name).toMatch(/^sys:/);
      }
      expect(promiseNames).toContain('sys:cancel');
    });
  });

  describe('error classes', () => {
    it('CancellationError has correct name and message', () => {
      const err = new CancellationError();
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(CancellationError);
      expect(err.name).toBe('CancellationError');
      expect(err.message).toBe('Workflow cancelled');
    });

    it('TimeoutError has correct name, message, and durationMs', () => {
      const err = new TimeoutError(30000);
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(TimeoutError);
      expect(err.name).toBe('TimeoutError');
      expect(err.message).toBe('Timed out after 30000ms');
      expect(err.durationMs).toBe(30000);
    });
  });
});
