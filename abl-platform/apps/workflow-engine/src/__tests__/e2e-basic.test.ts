/**
 * E2E Tests — Level 1: Basic (Success Paths)
 *
 * Focus: Happy-path flows verifying data passes correctly between nodes.
 * All tests exercise runWorkflow() end-to-end through the real dispatcher
 * and executors. Only external boundaries (persistence, publisher, fetch,
 * runtimeClient, toolClient) are injected.
 *
 * Node types covered: HTTP, Condition, Transform, Delay, Agent Invocation, Tool Call
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
import type { TransformStep } from '../executors/transform-executor.js';
import type { AgentInvocationStep, RuntimeClient } from '../executors/agent-invocation-executor.js';
import type { ToolCallStep, ToolExecutionClient } from '../executors/tool-call-executor.js';
import type { FunctionStep } from '../executors/function-executor.js';

// ---------------------------------------------------------------------------
// Shared test helpers
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

function makeInput(overrides?: Partial<WorkflowExecutionInput>): WorkflowExecutionInput {
  return {
    workflowId: 'wf-basic',
    workflowName: 'basic-e2e',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    triggerType: 'studio',
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

// ---------------------------------------------------------------------------
// Global mocks for HTTP executor
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
// 1. Single HTTP step — verify completion and output shape
// ===========================================================================

describe('L1: Single node completion', () => {
  it('single HTTP GET completes and stores response body in context', async () => {
    mockFetchJson(200, { orderId: 'ORD-100', status: 'shipped' });

    const step: HttpStep = {
      id: 'fetch-order',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/orders/100',
    };
    const input = makeInput({ steps: [step] });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(input, 'exec-l1-01', deps);

    expect(result.status).toBe('completed');
    const output = result.context.steps['fetch-order'].output as {
      body: { orderId: string; status: string };
    };
    expect(output.body.orderId).toBe('ORD-100');
    expect(output.body.status).toBe('shipped');
  });

  it('single delay step completes with controlFlow metadata', async () => {
    const step: DelayStep = { id: 'wait-5s', type: 'delay', duration: 'PT5S' };
    const input = makeInput({ steps: [step] });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(input, 'exec-l1-02', deps);

    expect(result.status).toBe('completed');
    expect(result.context.steps['wait-5s'].delayMs).toBe(5000);
  });

  it('single transform step stores result in vars', async () => {
    const step: TransformStep = {
      id: 'extract-id',
      type: 'transform',
      config: {
        inputExpression: '{{trigger.payload.userId}}',
        outputVariable: 'currentUser',
      },
    };
    const input = makeInput({
      triggerPayload: { userId: 'U-42' },
      steps: [step],
    });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(input, 'exec-l1-03', deps);

    expect(result.status).toBe('completed');
    expect(result.context.currentUser).toBe('U-42');
  });
});

// ===========================================================================
// 2. HTTP → HTTP: output from step 1 used in step 2 URL
// ===========================================================================

describe('L1: HTTP → HTTP data passing', () => {
  it('second HTTP step resolves expression from first step output', async () => {
    mockFetchSequence([
      { status: 200, body: { customerId: 'CUST-55' } },
      { status: 200, body: { name: 'Acme Corp', tier: 'gold' } },
    ]);

    const step1: HttpStep = {
      id: 'lookup',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/resolve',
    };
    const step2: HttpStep = {
      id: 'details',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/customers/{{steps.lookup.output.body.customerId}}',
    };
    const input = makeInput({ steps: [step1, step2] });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(input, 'exec-l1-04', deps);

    expect(result.status).toBe('completed');

    // Verify the second fetch was called with the resolved customer ID
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[1][0]).toBe('https://api.example.com/customers/CUST-55');

    // Verify both step outputs are in context
    const out2 = result.context.steps['details'].output as { body: { name: string } };
    expect(out2.body.name).toBe('Acme Corp');
  });

  it('POST body resolves expressions from prior step', async () => {
    mockFetchSequence([
      { status: 200, body: { token: 'abc-123', region: 'us-east' } },
      { status: 201, body: { created: true } },
    ]);

    const step1: HttpStep = {
      id: 'auth',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/auth/token',
    };
    const step2: HttpStep = {
      id: 'create',
      type: 'http',
      method: 'POST',
      url: 'https://api.example.com/resources',
      body: '{{steps.auth.output.body.token}}',
    };
    const input = makeInput({ steps: [step1, step2] });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(input, 'exec-l1-05', deps);

    expect(result.status).toBe('completed');
    expect(result.context.steps['create'].status).toBe('completed');
  });
});

// ===========================================================================
// 3. HTTP → Condition (truthy branch)
// ===========================================================================

describe('L1: HTTP → Condition branching (success paths)', () => {
  it('condition evaluates truthy and follows thenSteps', async () => {
    mockFetchSequence([
      { status: 200, body: { eligible: true } },
      { status: 200, body: { discount: 20 } },
    ]);

    const checkStep: HttpStep = {
      id: 'check-eligibility',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/eligibility',
    };
    const condStep: ConditionStep = {
      id: 'is-eligible',
      type: 'condition',
      expression: '{{steps.check-eligibility.output.body.eligible}}',
      thenSteps: ['apply-discount'],
      elseSteps: [],
    };
    const discountStep: HttpStep = {
      id: 'apply-discount',
      type: 'http',
      method: 'POST',
      url: 'https://api.example.com/discount',
    };

    const input = makeInput({ steps: [checkStep, condStep, discountStep] });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(input, 'exec-l1-06', deps);

    expect(result.status).toBe('completed');
    const condOut = result.context.steps['is-eligible'].output as { conditionMet: boolean };
    expect(condOut.conditionMet).toBe(true);
    expect(result.context.steps['apply-discount'].status).toBe('completed');
  });

  it('condition evaluates falsy and follows elseSteps', async () => {
    mockFetchJson(200, { eligible: false });

    const checkStep: HttpStep = {
      id: 'check',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/check',
    };
    const condStep: ConditionStep = {
      id: 'branch',
      type: 'condition',
      expression: '{{steps.check.output.body.eligible}}',
      thenSteps: ['on-yes'],
      elseSteps: ['on-no'],
    };
    const yesDelay: DelayStep = { id: 'on-yes', type: 'delay', duration: 'PT1S' };
    const noDelay: DelayStep = { id: 'on-no', type: 'delay', duration: 'PT2S' };

    const input = makeInput({ steps: [checkStep, condStep, yesDelay, noDelay] });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(input, 'exec-l1-07', deps);

    expect(result.status).toBe('completed');
    // Else branch executed
    expect(result.context.steps['on-no']).toBeDefined();
    expect(result.context.steps['on-no'].status).toBe('completed');
    // Then branch NOT executed
    expect(result.context.steps['on-yes']).toBeUndefined();
  });
});

// ===========================================================================
// 4. HTTP → Transform → HTTP: reshape data between steps
// ===========================================================================

describe('L1: HTTP → Transform → HTTP pipeline', () => {
  it('transform extracts nested field and HTTP step uses it', async () => {
    mockFetchSequence([
      { status: 200, body: { data: { user: { email: 'a@b.com' } } } },
      { status: 200, body: { sent: true } },
    ]);

    const fetchUser: HttpStep = {
      id: 'fetch-user',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/user',
    };
    const extractEmail: TransformStep = {
      id: 'extract-email',
      type: 'transform',
      config: {
        inputExpression: '{{steps.fetch-user.output.body.data.user.email}}',
        outputVariable: 'userEmail',
      },
    };
    const sendNotif: HttpStep = {
      id: 'send-notification',
      type: 'http',
      method: 'POST',
      url: 'https://api.example.com/notify',
      body: '{{context.userEmail}}',
    };

    const input = makeInput({ steps: [fetchUser, extractEmail, sendNotif] });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(input, 'exec-l1-08', deps);

    expect(result.status).toBe('completed');
    expect(result.context.userEmail).toBe('a@b.com');
    expect(result.context.steps['send-notification'].status).toBe('completed');
  });
});

// ===========================================================================
// 5. Trigger payload available across all steps
// ===========================================================================

describe('L1: Trigger payload propagation', () => {
  it('trigger payload is accessible from first to last step', async () => {
    mockFetchSequence([
      { status: 200, body: { ok: true } },
      { status: 200, body: { ok: true } },
      { status: 200, body: { ok: true } },
    ]);

    const steps: HttpStep[] = [
      {
        id: 'step-1',
        type: 'http',
        method: 'GET',
        url: 'https://api.example.com/{{trigger.payload.region}}/item1',
      },
      {
        id: 'step-2',
        type: 'http',
        method: 'GET',
        url: 'https://api.example.com/{{trigger.payload.region}}/item2',
      },
      {
        id: 'step-3',
        type: 'http',
        method: 'GET',
        url: 'https://api.example.com/{{trigger.payload.region}}/item3',
      },
    ];
    const input = makeInput({
      triggerPayload: { region: 'us-west', accountId: 'ACC-7' },
      steps,
    });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(input, 'exec-l1-09', deps);

    expect(result.status).toBe('completed');
    const fetchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(fetchCalls[0][0]).toBe('https://api.example.com/us-west/item1');
    expect(fetchCalls[1][0]).toBe('https://api.example.com/us-west/item2');
    expect(fetchCalls[2][0]).toBe('https://api.example.com/us-west/item3');
  });

  it('trigger metadata is available in context', async () => {
    const step: TransformStep = {
      id: 'read-meta',
      type: 'transform',
      config: {
        inputExpression: '{{trigger.metadata.triggeredBy}}',
        outputVariable: 'initiator',
      },
    };
    const input = makeInput({
      triggerPayload: { action: 'test' },
      triggerMetadata: { triggeredBy: 'admin-user' },
      steps: [step],
    });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(input, 'exec-l1-10', deps);

    expect(result.status).toBe('completed');
    expect(result.context.initiator).toBe('admin-user');
  });
});

// ===========================================================================
// 6. Agent invocation — data passing through agent output
// ===========================================================================

describe('L1: Agent invocation data flow', () => {
  it('agent output is available in subsequent HTTP step URL', async () => {
    const runtimeClient: RuntimeClient = {
      sendMessage: vi.fn().mockResolvedValue({
        sessionId: 'sess-1',
        agentResponse: 'Booking BK-999 confirmed',
        toolResults: [],
      }),
    };

    mockFetchJson(200, { status: 'confirmed' });

    const agentStep: AgentInvocationStep = {
      id: 'book-agent',
      type: 'agent_invocation',
      agentId: 'booking-agent',
      message: 'Book flight for {{trigger.payload.passenger}}',
    };
    const verifyStep: HttpStep = {
      id: 'verify',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/bookings/{{steps.book-agent.output.sessionId}}',
    };

    const input = makeInput({
      triggerPayload: { passenger: 'John Doe' },
      steps: [agentStep, verifyStep],
    });
    const deps = makeDeps(makePersistence(), makePublisher(), { runtimeClient });

    const result = await runWorkflow(input, 'exec-l1-11', deps);

    expect(result.status).toBe('completed');

    // Agent was called with resolved passenger name
    expect(runtimeClient.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Book flight for John Doe' }),
    );

    // HTTP step resolved agent output in URL
    const fetchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(fetchCalls[0][0]).toBe('https://api.example.com/bookings/sess-1');
  });
});

// ===========================================================================
// 7. Tool call — data passing through tool output
// ===========================================================================

describe('L1: Tool call data flow', () => {
  it('tool output is available in subsequent condition', async () => {
    const toolClient: ToolExecutionClient = {
      executeTool: vi.fn().mockResolvedValue({
        success: true,
        status: 'completed',
        output: { score: 95, passed: true },
      }),
    };

    const toolStep: ToolCallStep = {
      id: 'run-check',
      type: 'tool_call',
      toolName: 'quality_check',
      params: { itemId: '{{trigger.payload.itemId}}' },
    };
    const condStep: ConditionStep = {
      id: 'check-pass',
      type: 'condition',
      expression: '{{steps.run-check.output.passed}}',
      thenSteps: [],
      elseSteps: [],
    };

    const input = makeInput({
      triggerPayload: { itemId: 'ITEM-42' },
      steps: [toolStep, condStep],
    });
    const deps = makeDeps(makePersistence(), makePublisher(), { toolClient });

    const result = await runWorkflow(input, 'exec-l1-12', deps);

    expect(result.status).toBe('completed');

    // Tool was called with resolved param
    expect(toolClient.executeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'quality_check',
        params: { itemId: 'ITEM-42' },
      }),
    );

    // Condition read tool output correctly
    const condOut = result.context.steps['check-pass'].output as { conditionMet: boolean };
    expect(condOut.conditionMet).toBe(true);
  });
});

// ===========================================================================
// 8. Multi-node pipeline: HTTP → Transform → Condition → Delay
// ===========================================================================

describe('L1: Multi-node pipeline', () => {
  it('4-step pipeline passes data correctly through each stage', async () => {
    mockFetchJson(200, { temperature: 38.5, unit: 'celsius' });

    const fetchTemp: HttpStep = {
      id: 'read-sensor',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/sensor/temp',
    };
    const extractTemp: TransformStep = {
      id: 'extract-temp',
      type: 'transform',
      config: {
        inputExpression: '{{steps.read-sensor.output.body.temperature}}',
        outputVariable: 'temp',
      },
    };
    const checkHigh: ConditionStep = {
      id: 'is-high',
      type: 'condition',
      expression: '{{context.temp}}',
      thenSteps: ['cooldown'],
      elseSteps: [],
    };
    const cooldown: DelayStep = {
      id: 'cooldown',
      type: 'delay',
      duration: 'PT10S',
    };

    const input = makeInput({ steps: [fetchTemp, extractTemp, checkHigh, cooldown] });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(input, 'exec-l1-13', deps);

    expect(result.status).toBe('completed');
    expect(result.context.temp).toBe(38.5);
    expect(result.context.steps['is-high'].output).toEqual(
      expect.objectContaining({ conditionMet: true }),
    );
    expect(result.context.steps['cooldown'].delayMs).toBe(10000);
  });
});

// ===========================================================================
// 9. Workflow context metadata
// ===========================================================================

describe('L1: Workflow context metadata', () => {
  it('workflow.id, workflow.name, and workflow.executionId are resolvable', async () => {
    const runtimeClient: RuntimeClient = {
      sendMessage: vi.fn().mockResolvedValue({
        sessionId: 'sess-meta',
        agentResponse: 'ok',
        toolResults: [],
      }),
    };

    const agentStep: AgentInvocationStep = {
      id: 'meta-step',
      type: 'agent_invocation',
      agentId: 'info-agent',
      message: 'wf={{workflow.name}} exec={{workflow.executionId}}',
    };

    const input = makeInput({
      workflowName: 'my-pipeline',
      steps: [agentStep],
    });
    const deps = makeDeps(makePersistence(), makePublisher(), { runtimeClient });

    const result = await runWorkflow(input, 'exec-l1-14', deps);

    expect(result.status).toBe('completed');
    expect(runtimeClient.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'wf=my-pipeline exec=exec-l1-14',
      }),
    );
  });

  it('tenant context is passed to agent and tool calls', async () => {
    const runtimeClient: RuntimeClient = {
      sendMessage: vi.fn().mockResolvedValue({
        sessionId: 's1',
        agentResponse: 'ok',
        toolResults: [],
      }),
    };
    const toolClient: ToolExecutionClient = {
      executeTool: vi.fn().mockResolvedValue({ success: true, status: 'completed', output: {} }),
    };

    const agentStep: AgentInvocationStep = {
      id: 'agent-1',
      type: 'agent_invocation',
      agentId: 'a1',
      message: 'hello',
    };
    const toolStep: ToolCallStep = {
      id: 'tool-1',
      type: 'tool_call',
      toolName: 'test_tool',
      params: {},
    };

    const input = makeInput({
      tenantId: 'T-500',
      projectId: 'P-200',
      steps: [agentStep, toolStep],
    });
    const deps = makeDeps(makePersistence(), makePublisher(), { runtimeClient, toolClient });

    const result = await runWorkflow(input, 'exec-l1-15', deps);

    expect(result.status).toBe('completed');
    expect(runtimeClient.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'T-500', projectId: 'P-200' }),
    );
    expect(toolClient.executeTool).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'T-500', projectId: 'P-200' }),
    );
  });

  // INT-1: Full dispatch cycle with function step (context API)
  it('function step produces output via context writes', async () => {
    const fnStep: FunctionStep = {
      id: 'fn-int1',
      type: 'function',
      config: {
        code: `
          const items = context.trigger.payload.items;
          context.filtered = items.filter(i => i > 1);
          context.count = items.length;
        `,
        timeout: 5,
      },
    };

    const persistence = makePersistence();
    const input = makeInput({
      triggerPayload: { items: [1, 2, 3] },
      steps: [fnStep],
    });

    const result = await runWorkflow(input, 'exec-fn-1', makeDeps(persistence, makePublisher()));

    expect(result.status).toBe('completed');
    const calls = (persistence.updateStepStatus as ReturnType<typeof vi.fn>).mock.calls;
    const fnCall = calls.find((c: unknown[]) => c[3] === 'fn-int1' && c[4] === 'completed');
    expect(fnCall).toBeDefined();
    expect(fnCall![5]).toEqual(
      expect.objectContaining({
        stepKey: 'fn-int1',
        context: expect.objectContaining({
          filtered: [2, 3],
          count: 3,
        }),
        stepData: expect.objectContaining({
          output: { filtered: [2, 3], count: 3 },
          consoleLogs: [],
        }),
      }),
    );
  });

  // INT-5: Error propagation (timeout through dispatch to persistence)
  it('function timeout propagates as failed step', async () => {
    const fnStep: FunctionStep = {
      id: 'fn-int5',
      type: 'function',
      config: {
        code: 'while(true) {}',
        timeout: 1,
      },
    };

    const persistence = makePersistence();
    const input = makeInput({ steps: [fnStep] });

    const result = await runWorkflow(input, 'exec-fn-5', makeDeps(persistence, makePublisher()));

    expect(result.status).toBe('failed');
    const calls = (persistence.updateStepStatus as ReturnType<typeof vi.fn>).mock.calls;
    const failCall = calls.find((c: unknown[]) => c[3] === 'fn-int5' && c[4] === 'failed');
    expect(failCall).toBeDefined();
    expect(failCall![5]).toEqual(
      expect.objectContaining({
        stepKey: 'fn-int5',
        stepData: expect.objectContaining({
          error: expect.objectContaining({
            code: 'SCRIPT_ERROR',
            message: expect.stringMatching(/timed out/),
          }),
        }),
      }),
    );
  }, 15000);

  // INT-8: Context writes flow through dispatch
  it('context writes flow through dispatch as step output', async () => {
    const fnStep: FunctionStep = {
      id: 'fn-int8',
      type: 'function',
      config: {
        code: 'context.sum = 2 + 2;',
        timeout: 5,
      },
    };

    const persistence = makePersistence();
    const input = makeInput({ steps: [fnStep] });

    const result = await runWorkflow(input, 'exec-fn-8', makeDeps(persistence, makePublisher()));

    expect(result.status).toBe('completed');
    const calls = (persistence.updateStepStatus as ReturnType<typeof vi.fn>).mock.calls;
    const fnCall = calls.find((c: unknown[]) => c[3] === 'fn-int8' && c[4] === 'completed');
    expect(fnCall).toBeDefined();
    expect(fnCall![5]).toEqual(
      expect.objectContaining({
        stepKey: 'fn-int8',
        stepData: expect.objectContaining({
          output: { sum: 4 },
        }),
      }),
    );
  });
});
