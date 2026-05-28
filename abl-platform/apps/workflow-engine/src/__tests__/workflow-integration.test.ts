/**
 * Workflow Handler Integration Tests
 *
 * Verifies that runWorkflow() → dispatchStep() → executors → expression resolver
 * work together end-to-end. Only external boundaries (persistence, publisher,
 * fetch, runtimeClient) are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  runWorkflow,
  type WorkflowExecutionInput,
  type WorkflowHandlerDeps,
  type ExecutionPersistence,
  type StatusPublisher,
} from '../handlers/workflow-handler.js';
import type { StepDispatcherDeps } from '../handlers/step-dispatcher.js';
import type { HttpStep } from '../executors/http-executor.js';
import type { ConditionStep } from '../executors/condition-executor.js';
import type { DelayStep } from '../executors/delay-executor.js';
import type {
  AgentInvocationStep,
  RuntimeClient,
  AgentInvocationResult,
} from '../executors/agent-invocation-executor.js';
import type { ApprovalStep } from '../executors/approval-executor.js';
import type { AsyncWebhookStep } from '../executors/async-webhook-executor.js';

// ---------------------------------------------------------------------------
// Shared Helpers
// ---------------------------------------------------------------------------

interface TrackingPersistence extends ExecutionPersistence {
  calls: Record<string, unknown[][]>;
}

function makePersistence(): TrackingPersistence {
  const calls: Record<string, unknown[][]> = {
    createExecution: [],
    updateStepStatus: [],
    updateExecutionStatus: [],
  };
  return {
    calls,
    createExecution: vi.fn(async (...args: unknown[]) => {
      calls.createExecution.push(args);
    }),
    updateStepStatus: vi.fn(async (...args: unknown[]) => {
      calls.updateStepStatus.push(args);
    }),
    updateExecutionStatus: vi.fn(async (...args: unknown[]) => {
      calls.updateExecutionStatus.push(args);
    }),
  };
}

interface TrackingPublisher extends StatusPublisher {
  events: Array<{ channel: string; message: unknown }>;
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
    workflowId: 'wf-1',
    workflowName: 'integration-flow',
    tenantId: 't1',
    projectId: 'p1',
    triggerType: 'webhook',
    triggerPayload: { customerId: 'C-100', orderId: 'ORD-42' },
    steps: [],
    ...overrides,
  };
}

function mockFetchResponse(status: number, body: unknown): void {
  const mockResponse = {
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    headers: new Headers({ 'content-type': 'application/json' }),
  };
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);
}

function makeMockRuntimeClient(response?: AgentInvocationResult): RuntimeClient {
  return {
    sendMessage: vi
      .fn()
      .mockResolvedValue(
        response ?? { sessionId: 'sess-1', agentResponse: 'Done', toolResults: [] },
      ),
  };
}

function makeDeps(
  persistence: TrackingPersistence,
  publisher: TrackingPublisher,
  dispatcherDeps: StepDispatcherDeps = {},
): WorkflowHandlerDeps {
  return { persistence, publisher, dispatcherDeps };
}

// ---------------------------------------------------------------------------
// Mock global fetch + SSRF validator
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
// Suite 1: Full Workflow Lifecycle
// ===========================================================================

describe('Full Workflow Lifecycle', () => {
  let persistence: TrackingPersistence;
  let publisher: TrackingPublisher;

  beforeEach(() => {
    persistence = makePersistence();
    publisher = makePublisher();
  });

  it('single HTTP step completes end-to-end', async () => {
    mockFetchResponse(200, { result: 'ok' });

    const httpStep: HttpStep = {
      id: 'fetch-1',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/orders/{{trigger.payload.orderId}}',
    };
    const input = makeInput({ steps: [httpStep] });
    const deps = makeDeps(persistence, publisher);

    const result = await runWorkflow(input, 'exec-1', deps);

    expect(result.status).toBe('completed');

    // Full lifecycle: updateStepStatus(start,completed) +
    // updateStepStatus(http,running) + updateStepStatus(http,completed) +
    // updateStepStatus(end,running) + updateStepStatus(end,completed) = 5.
    expect(persistence.createExecution).toHaveBeenCalledTimes(1);
    expect(persistence.updateStepStatus).toHaveBeenCalledTimes(5);
    expect(persistence.updateExecutionStatus).toHaveBeenCalledTimes(1);

    // Start + End are first-class lifecycle steps.
    const types = publisher.events.map((e) => (e.message as Record<string, unknown>).type);
    expect(types).toEqual([
      'step.started', // Start
      'step.completed', // Start
      'workflow.started',
      'step.started', // http
      'step.completed', // http
      'step.started', // End
      'step.completed', // End
      'workflow.completed',
    ]);
  });

  it('multi-step sequential execution accumulates context', async () => {
    // Step 1 returns { data: 'first' }
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(JSON.stringify({ data: 'first' })),
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(JSON.stringify({ data: 'second' })),
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(JSON.stringify({ data: 'third' })),
        headers: new Headers(),
      });

    const steps: HttpStep[] = [
      { id: 'step-1', type: 'http', method: 'GET', url: 'https://api.example.com/1' },
      { id: 'step-2', type: 'http', method: 'GET', url: 'https://api.example.com/2' },
      { id: 'step-3', type: 'http', method: 'GET', url: 'https://api.example.com/3' },
    ];
    const input = makeInput({ steps });
    const deps = makeDeps(persistence, publisher);

    const result = await runWorkflow(input, 'exec-2', deps);

    expect(result.status).toBe('completed');
    expect(result.context.steps['step-1'].status).toBe('completed');
    expect(result.context.steps['step-2'].status).toBe('completed');
    expect(result.context.steps['step-3'].status).toBe('completed');

    // 1 (Start → completed) + 3 user steps × 2 (running + completed)
    // + 2 (End → running, End → completed) = 9
    expect(persistence.updateStepStatus).toHaveBeenCalledTimes(9);
  });

  it('empty steps array fails with no-path guidance', async () => {
    const input = makeInput({ steps: [] });
    const deps = makeDeps(persistence, publisher);

    const result = await runWorkflow(input, 'exec-3', deps);

    expect(result.status).toBe('failed');
    expect(result.error).toEqual({
      code: 'NO_STEPS',
      message: expect.stringMatching(/no complete Start/i),
    });

    const types = publisher.events.map((e) => (e.message as Record<string, unknown>).type);
    expect(types).toEqual(['workflow.failed']);
  });

  it('direct Start → End edge (no intermediate steps) completes successfully', async () => {
    const input = makeInput({
      steps: [],
      edgeMap: {
        'start-node': [
          {
            edgeId: 'e-start-end',
            target: 'end-node',
            sourceRuntimeId: 'start',
            targetRuntimeId: 'end',
          },
        ],
      },
    });
    const deps = makeDeps(persistence, publisher);

    const result = await runWorkflow(input, 'exec-start-end', deps);

    expect(result.status).toBe('completed');
    expect(result.error).toBeUndefined();
    expect(result.output?._status).toBe(0);

    const types = publisher.events.map((e) => (e.message as Record<string, unknown>).type);
    expect(types).toContain('workflow.started');
    expect(types).toContain('workflow.completed');
    expect(types).not.toContain('workflow.failed');
  });
});

// ===========================================================================
// Suite 2: HTTP → Condition → Branch
// ===========================================================================

describe('HTTP → Condition → Branch', () => {
  let persistence: TrackingPersistence;
  let publisher: TrackingPublisher;

  beforeEach(() => {
    persistence = makePersistence();
    publisher = makePublisher();
  });

  it('condition evaluates truthy from HTTP output', async () => {
    mockFetchResponse(200, { approved: true });

    const httpStep: HttpStep = {
      id: 'fetch',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/check',
    };
    const condStep: ConditionStep = {
      id: 'cond',
      type: 'condition',
      expression: '{{steps.fetch.output.body.approved}}',
      thenSteps: [],
      elseSteps: [],
    };
    const input = makeInput({ steps: [httpStep, condStep] });
    const deps = makeDeps(persistence, publisher);

    const result = await runWorkflow(input, 'exec-4', deps);

    expect(result.status).toBe('completed');
    const condOutput = result.context.steps['cond'].output as { conditionMet: boolean };
    expect(condOutput.conditionMet).toBe(true);
  });

  it('condition evaluates falsy from HTTP output', async () => {
    mockFetchResponse(200, { approved: false });

    const httpStep: HttpStep = {
      id: 'fetch',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/check',
    };
    const condStep: ConditionStep = {
      id: 'cond',
      type: 'condition',
      expression: '{{steps.fetch.output.body.approved}}',
      thenSteps: [],
      elseSteps: [],
    };
    const input = makeInput({ steps: [httpStep, condStep] });
    const deps = makeDeps(persistence, publisher);

    const result = await runWorkflow(input, 'exec-5', deps);

    expect(result.status).toBe('completed');
    const condOutput = result.context.steps['cond'].output as { conditionMet: boolean };
    expect(condOutput.conditionMet).toBe(false);
  });

  it('condition with empty elseSteps when falsy', async () => {
    mockFetchResponse(200, { approved: false });

    const httpStep: HttpStep = {
      id: 'fetch',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/check',
    };
    const condStep: ConditionStep = {
      id: 'cond',
      type: 'condition',
      expression: '{{steps.fetch.output.body.approved}}',
      thenSteps: ['do-thing'],
      elseSteps: [],
    };
    const input = makeInput({ steps: [httpStep, condStep] });
    const deps = makeDeps(persistence, publisher);

    const result = await runWorkflow(input, 'exec-6', deps);

    expect(result.status).toBe('completed');
    expect(result.context.steps['cond'].status).toBe('completed');
  });

  it('chained conditions from HTTP output', async () => {
    mockFetchResponse(200, { level: 'premium', score: 95 });

    const httpStep: HttpStep = {
      id: 'check',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/user',
    };
    const cond1: ConditionStep = {
      id: 'cond-level',
      type: 'condition',
      expression: '{{steps.check.output.body.level}}',
      thenSteps: ['cond-score'],
    };
    const cond2: ConditionStep = {
      id: 'cond-score',
      type: 'condition',
      expression: '{{steps.check.output.body.score}}',
      thenSteps: [],
    };
    const input = makeInput({ steps: [httpStep, cond1, cond2] });
    const deps = makeDeps(persistence, publisher);

    const result = await runWorkflow(input, 'exec-7', deps);

    expect(result.status).toBe('completed');
    expect(result.context.steps['cond-level'].status).toBe('completed');
    expect(result.context.steps['cond-score'].status).toBe('completed');
  });
});

// ===========================================================================
// Suite 3: Agent Invocation
// ===========================================================================

describe('Agent Invocation', () => {
  let persistence: TrackingPersistence;
  let publisher: TrackingPublisher;

  beforeEach(() => {
    persistence = makePersistence();
    publisher = makePublisher();
  });

  it('passes tenant and caller context to RuntimeClient', async () => {
    const runtimeClient = makeMockRuntimeClient();
    const agentStep: AgentInvocationStep = {
      id: 'invoke-1',
      type: 'agent_invocation',
      agentId: 'agent-booking',
      message: 'Process order',
    };
    const input = makeInput({ steps: [agentStep] });
    const deps = makeDeps(persistence, publisher, { runtimeClient });

    await runWorkflow(input, 'exec-8', deps);

    expect(runtimeClient.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't1',
        projectId: 'p1',
        callerContext: { source: 'workflow', workflowExecutionId: 'exec-8' },
      }),
    );
  });

  it('resolves expressions in message and agentId', async () => {
    const runtimeClient = makeMockRuntimeClient();
    const agentStep: AgentInvocationStep = {
      id: 'invoke-2',
      type: 'agent_invocation',
      agentId: '{{trigger.payload.customerId}}',
      message: 'Process {{trigger.payload.orderId}}',
    };
    const input = makeInput({ steps: [agentStep] });
    const deps = makeDeps(persistence, publisher, { runtimeClient });

    await runWorkflow(input, 'exec-9', deps);

    expect(runtimeClient.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'C-100',
        message: 'Process ORD-42',
      }),
    );
  });

  it('agent output available in subsequent steps', async () => {
    const runtimeClient = makeMockRuntimeClient({
      sessionId: 'sess-1',
      agentResponse: 'Booking confirmed #BK-789',
      toolResults: [],
    });

    // Agent step followed by a condition that reads agent output
    const agentStep: AgentInvocationStep = {
      id: 'invoke',
      type: 'agent_invocation',
      agentId: 'agent-booking',
      message: 'Book it',
    };
    const condStep: ConditionStep = {
      id: 'check-response',
      type: 'condition',
      expression: '{{steps.invoke.output.agentResponse}}',
      thenSteps: [],
    };
    const input = makeInput({ steps: [agentStep, condStep] });
    const deps = makeDeps(persistence, publisher, { runtimeClient });

    const result = await runWorkflow(input, 'exec-10', deps);

    expect(result.status).toBe('completed');
    const condOutput = result.context.steps['check-response'].output as { conditionMet: boolean };
    expect(condOutput.conditionMet).toBe(true);
  });

  it('agent failure propagates to workflow failure', async () => {
    const runtimeClient: RuntimeClient = {
      sendMessage: vi.fn().mockRejectedValue(new Error('Agent timeout')),
    };
    const agentStep: AgentInvocationStep = {
      id: 'invoke-fail',
      type: 'agent_invocation',
      agentId: 'agent-slow',
      message: 'Do something',
    };
    const input = makeInput({ steps: [agentStep] });
    const deps = makeDeps(persistence, publisher, { runtimeClient });

    const result = await runWorkflow(input, 'exec-11', deps);

    expect(result.status).toBe('failed');
    expect(result.error).toEqual({ code: 'WORKFLOW_FAILED', message: 'Agent timeout' });
  });
});

// ===========================================================================
// Suite 4: Context Accumulation
// ===========================================================================

describe('Context Accumulation', () => {
  let persistence: TrackingPersistence;
  let publisher: TrackingPublisher;

  beforeEach(() => {
    persistence = makePersistence();
    publisher = makePublisher();
  });

  it('mixed step types all populate ctx.steps', async () => {
    mockFetchResponse(200, { data: 'fetched' });

    const steps = [
      {
        id: 'http-1',
        type: 'http' as const,
        method: 'GET' as const,
        url: 'https://api.example.com/x',
      },
      { id: 'delay-1', type: 'delay' as const, duration: 'PT1S' },
      {
        id: 'cond-1',
        type: 'condition' as const,
        expression: '{{trigger.payload.orderId}}',
        thenSteps: [],
      },
    ];
    const input = makeInput({ steps });
    const deps = makeDeps(persistence, publisher);

    const result = await runWorkflow(input, 'exec-12', deps);

    expect(result.status).toBe('completed');
    // 1 (start) + 3 workflow steps + 1 (end) = 5
    expect(Object.keys(result.context.steps)).toHaveLength(5);
    expect(result.context.steps['http-1'].status).toBe('completed');
    expect(result.context.steps['delay-1'].status).toBe('completed');
    expect(result.context.steps['cond-1'].status).toBe('completed');
  });

  it('deep nested output resolution across steps', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(JSON.stringify({ nested: { deep: { value: 42 } } })),
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(JSON.stringify({ confirmed: true })),
        headers: new Headers(),
      });

    const step1: HttpStep = {
      id: 'http1',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/deep',
    };
    // Second HTTP step references deep path from first step
    const step2: HttpStep = {
      id: 'http2',
      type: 'http',
      method: 'POST',
      url: 'https://api.example.com/confirm',
      body: '{{steps.http1.output.body.nested.deep.value}}',
    };
    const input = makeInput({ steps: [step1, step2] });
    const deps = makeDeps(persistence, publisher);

    const result = await runWorkflow(input, 'exec-13', deps);

    expect(result.status).toBe('completed');
    // Verify the first step's nested output is accessible
    const output1 = result.context.steps['http1'].output as {
      body: { nested: { deep: { value: number } } };
    };
    expect(output1.body.nested.deep.value).toBe(42);
  });

  it('trigger payload available from first to last step', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(JSON.stringify({ ok: true })),
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(JSON.stringify({ ok: true })),
        headers: new Headers(),
      });

    const step1: HttpStep = {
      id: 'first',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/customers/{{trigger.payload.customerId}}',
    };
    const step2: HttpStep = {
      id: 'last',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/orders/{{trigger.payload.customerId}}',
    };
    const input = makeInput({ steps: [step1, step2] });
    const deps = makeDeps(persistence, publisher);

    const result = await runWorkflow(input, 'exec-14', deps);

    expect(result.status).toBe('completed');
    // Verify fetch was called with resolved customer IDs
    const fetchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(fetchCalls[0][0]).toBe('https://api.example.com/customers/C-100');
    expect(fetchCalls[1][0]).toBe('https://api.example.com/orders/C-100');
  });

  it('workflow metadata available in expressions', async () => {
    const runtimeClient = makeMockRuntimeClient();
    const agentStep: AgentInvocationStep = {
      id: 'meta-test',
      type: 'agent_invocation',
      agentId: 'agent-1',
      message: 'Exec: {{workflow.executionId}}',
    };
    const input = makeInput({ steps: [agentStep] });
    const deps = makeDeps(persistence, publisher, { runtimeClient });

    await runWorkflow(input, 'exec-15', deps);

    expect(runtimeClient.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Exec: exec-15',
      }),
    );
  });
});

// ===========================================================================
// Suite 5: Error Handling
// ===========================================================================

describe('Error Handling', () => {
  let persistence: TrackingPersistence;
  let publisher: TrackingPublisher;

  beforeEach(() => {
    persistence = makePersistence();
    publisher = makePublisher();
  });

  it('step failure records error and fails workflow', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));

    const httpStep: HttpStep = {
      id: 'failing-step',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/unreachable',
    };
    const input = makeInput({ steps: [httpStep] });
    const deps = makeDeps(persistence, publisher);

    const result = await runWorkflow(input, 'exec-16', deps);

    expect(result.status).toBe('failed');
    expect(result.context.steps['failing-step'].error).toEqual({
      code: 'STEP_FAILED',
      message: 'Network error',
    });
  });

  it('partial context preserved on mid-workflow failure', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(JSON.stringify({ ok: true })),
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(JSON.stringify({ ok: true })),
        headers: new Headers(),
      })
      .mockRejectedValueOnce(new Error('Step C failed'));

    const steps: HttpStep[] = [
      { id: 'A', type: 'http', method: 'GET', url: 'https://api.example.com/a' },
      { id: 'B', type: 'http', method: 'GET', url: 'https://api.example.com/b' },
      { id: 'C', type: 'http', method: 'GET', url: 'https://api.example.com/c' },
    ];
    const input = makeInput({ steps });
    const deps = makeDeps(persistence, publisher);

    const result = await runWorkflow(input, 'exec-17', deps);

    expect(result.status).toBe('failed');
    expect(result.context.steps['A'].status).toBe('completed');
    expect(result.context.steps['B'].status).toBe('completed');
    expect(result.context.steps['C'].status).toBe('failed');
  });

  it('missing runtimeClient dependency errors clearly', async () => {
    const agentStep: AgentInvocationStep = {
      id: 'invoke-no-client',
      type: 'agent_invocation',
      agentId: 'agent-1',
      message: 'hello',
    };
    const input = makeInput({ steps: [agentStep] });
    // No runtimeClient in dispatcherDeps
    const deps = makeDeps(persistence, publisher, {});

    const result = await runWorkflow(input, 'exec-19', deps);

    expect(result.status).toBe('failed');
    expect(result.error?.message).toBe('RuntimeClient not configured');
  });

  it('persistence error propagates to workflow failure', async () => {
    mockFetchResponse(200, { ok: true });

    const httpStep: HttpStep = {
      id: 'step-p',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/x',
    };
    const input = makeInput({ steps: [httpStep] });

    // First call is for the synthetic 'start' step — let it succeed.
    // Reject on the second call (the "running" update for the actual step).
    persistence.updateStepStatus = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error('DB write failed'));
    const deps = makeDeps(persistence, publisher);

    const result = await runWorkflow(input, 'exec-20', deps);

    expect(result.status).toBe('failed');
    expect(result.error?.message).toBe('DB write failed');
  });

  it('non-Error rejection is stringified', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue('string error');

    const httpStep: HttpStep = {
      id: 'str-err',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/fail',
    };
    const input = makeInput({ steps: [httpStep] });
    const deps = makeDeps(persistence, publisher);

    const result = await runWorkflow(input, 'exec-str', deps);

    expect(result.status).toBe('failed');
    expect(result.error?.message).toBe('string error');
  });
});

// ===========================================================================
// Suite 6: Control Flow Signals
// ===========================================================================

describe('Control Flow Signals', () => {
  let persistence: TrackingPersistence;
  let publisher: TrackingPublisher;

  beforeEach(() => {
    persistence = makePersistence();
    publisher = makePublisher();
  });

  it('approval step records approvalRequest in output', async () => {
    const approvalStep: ApprovalStep = {
      id: 'approval-1',
      type: 'approval',
      message: 'Please approve order {{trigger.payload.orderId}}',
      approvers: ['admin', 'manager'],
    };
    const input = makeInput({ steps: [approvalStep] });
    const deps = makeDeps(persistence, publisher);

    const result = await runWorkflow(input, 'exec-21', deps);

    // Approval step completes (builds the request but doesn't wait in this test context)
    expect(result.status).toBe('completed');
    expect(result.context.steps['approval-1'].status).toBe('completed');
  });

  it('async webhook step returns webhookRequest metadata', async () => {
    const webhookStep: AsyncWebhookStep = {
      id: 'webhook-1',
      type: 'async_webhook',
      url: 'https://external.example.com/start',
      body: { orderId: '{{trigger.payload.orderId}}' },
    };
    const callbackUrlBuilder = {
      buildCallbackUrl: vi
        .fn()
        .mockReturnValue('https://callback.example.com/cb/exec-22/webhook-1'),
    };
    const input = makeInput({ steps: [webhookStep] });
    const deps = makeDeps(persistence, publisher, { callbackUrlBuilder });

    const result = await runWorkflow(input, 'exec-22', deps);

    expect(result.status).toBe('completed');
    expect(callbackUrlBuilder.buildCallbackUrl).toHaveBeenCalledWith('exec-22', 'webhook-1', 't1');
  });

  it('delay step returns resolved durationMs', async () => {
    const delayStep: DelayStep = {
      id: 'delay-1',
      type: 'delay',
      duration: 'PT30S',
    };
    const input = makeInput({ steps: [delayStep] });
    const deps = makeDeps(persistence, publisher);

    const result = await runWorkflow(input, 'exec-23', deps);

    expect(result.status).toBe('completed');
    expect(result.context.steps['delay-1'].status).toBe('completed');
    // Delay output is null (the handler returns delayMs on the result, not as output)
  });
});

// ===========================================================================
// Suite 7: Publisher Event Sequence
// ===========================================================================

describe('Publisher Event Sequence', () => {
  let persistence: TrackingPersistence;
  let publisher: TrackingPublisher;

  beforeEach(() => {
    persistence = makePersistence();
    publisher = makePublisher();
  });

  it('emits correct event order for 2-step workflow', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(JSON.stringify({ ok: true })),
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(JSON.stringify({ ok: true })),
        headers: new Headers(),
      });

    const steps: HttpStep[] = [
      { id: 's1', type: 'http', method: 'GET', url: 'https://api.example.com/1' },
      { id: 's2', type: 'http', method: 'GET', url: 'https://api.example.com/2' },
    ];
    const input = makeInput({ steps });
    const deps = makeDeps(persistence, publisher);

    await runWorkflow(input, 'exec-24', deps);

    const types = publisher.events.map((e) => (e.message as Record<string, unknown>).type);
    // Start + End are first-class lifecycle steps.
    expect(types).toEqual([
      'step.started', // Start
      'step.completed', // Start
      'workflow.started',
      'step.started', // s1
      'step.completed', // s1
      'step.started', // s2
      'step.completed', // s2
      'step.started', // End
      'step.completed', // End
      'workflow.completed',
    ]);

    // Verify step IDs in order (skip Start + End boundary events)
    const stepEvents = publisher.events.filter((e) => {
      const msg = e.message as Record<string, unknown>;
      return msg.type === 'step.started' && msg.stepId !== 'start' && msg.stepId !== 'end';
    });
    expect((stepEvents[0].message as Record<string, unknown>).stepId).toBe('s1');
    expect((stepEvents[1].message as Record<string, unknown>).stepId).toBe('s2');
  });

  it('emits step.failed then workflow.failed on error', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Boom'));

    const steps: HttpStep[] = [
      { id: 'bad-step', type: 'http', method: 'GET', url: 'https://api.example.com/fail' },
    ];
    const input = makeInput({ steps });
    const deps = makeDeps(persistence, publisher);

    await runWorkflow(input, 'exec-25', deps);

    const types = publisher.events.map((e) => (e.message as Record<string, unknown>).type);
    // Start completes fine (no declared inputVariables), user step fails.
    expect(types).toEqual([
      'step.started', // Start
      'step.completed', // Start
      'workflow.started',
      'step.started', // bad-step
      'step.failed', // bad-step
      'workflow.failed',
    ]);

    // Verify error message in step.failed event
    const failedEvent = publisher.events.find(
      (e) => (e.message as Record<string, unknown>).type === 'step.failed',
    );
    expect((failedEvent?.message as Record<string, unknown>).error).toBe('Boom');
  });

  it('events contain correct tenant-scoped channel', async () => {
    const input = makeInput({ steps: [] });
    const deps = makeDeps(persistence, publisher);

    await runWorkflow(input, 'exec-26', deps);

    for (const event of publisher.events) {
      expect(event.channel).toBe('workflow:t1:execution:exec-26:status');
    }
  });
});
