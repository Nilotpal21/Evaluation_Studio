/**
 * E2E Tests — Level 2: Medium (Positive + Negative Paths)
 *
 * Focus: Error handling, partial failures, missing dependencies,
 * HTTP error codes, step failures mid-workflow, on_failure routing,
 * persistence/publisher event verification.
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
    workflowId: 'wf-medium',
    workflowName: 'medium-e2e',
    tenantId: 'tenant-2',
    projectId: 'project-2',
    triggerType: 'webhook',
    triggerPayload: { orderId: 'ORD-200' },
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
// 1. HTTP step failure → workflow fails
// ===========================================================================

describe('L2: HTTP step failure', () => {
  it('network error fails step and workflow', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ECONNREFUSED'));

    const step: HttpStep = {
      id: 'failing-http',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/unreachable',
    };
    const input = makeInput({ steps: [step] });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(input, 'exec-l2-01', deps);

    expect(result.status).toBe('failed');
    expect(result.context.steps['failing-http'].status).toBe('failed');
    expect(result.context.steps['failing-http'].error).toEqual(
      expect.objectContaining({ message: 'ECONNREFUSED' }),
    );
  });

  it('HTTP 4xx response throws and fails the step', async () => {
    // HTTP executor throws WorkflowStepError on non-2xx responses
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: vi.fn().mockResolvedValue(JSON.stringify({ error: 'Not found' })),
      headers: new Headers({ 'content-type': 'application/json' }),
    });

    const step: HttpStep = {
      id: 'not-found',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/missing',
    };
    const input = makeInput({ steps: [step] });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(input, 'exec-l2-02', deps);

    expect(result.status).toBe('failed');
    expect(result.context.steps['not-found'].status).toBe('failed');
    expect(result.context.steps['not-found'].error).toEqual(
      expect.objectContaining({ code: 'HTTP_ERROR' }),
    );
  });
});

// ===========================================================================
// 2. Partial context preserved on mid-workflow failure
// ===========================================================================

describe('L2: Partial context preservation', () => {
  it('first step output survives when second step fails', async () => {
    mockFetchSequence([{ status: 200, body: { data: 'saved' } }]);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Timeout'));

    const step1: HttpStep = {
      id: 'ok-step',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/ok',
    };
    const step2: HttpStep = {
      id: 'bad-step',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/timeout',
    };
    const input = makeInput({ steps: [step1, step2] });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(input, 'exec-l2-03', deps);

    expect(result.status).toBe('failed');
    expect(result.context.steps['ok-step'].status).toBe('completed');
    expect(result.context.steps['bad-step'].status).toBe('failed');
    const output = result.context.steps['ok-step'].output as { body: { data: string } };
    expect(output.body.data).toBe('saved');
  });

  it('3-step pipeline preserves first 2 when step 3 fails', async () => {
    mockFetchSequence([
      { status: 200, body: { a: 1 } },
      { status: 200, body: { b: 2 } },
    ]);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Step C crashed'),
    );

    const steps: HttpStep[] = [
      { id: 'A', type: 'http', method: 'GET', url: 'https://api.example.com/a' },
      { id: 'B', type: 'http', method: 'GET', url: 'https://api.example.com/b' },
      { id: 'C', type: 'http', method: 'GET', url: 'https://api.example.com/c' },
    ];
    const input = makeInput({ steps });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(input, 'exec-l2-04', deps);

    expect(result.status).toBe('failed');
    expect(result.context.steps['A'].status).toBe('completed');
    expect(result.context.steps['B'].status).toBe('completed');
    expect(result.context.steps['C'].status).toBe('failed');
  });
});

// ===========================================================================
// 3. Missing dependency errors
// ===========================================================================

describe('L2: Missing dependency errors', () => {
  it('agent step without runtimeClient fails clearly', async () => {
    const step: AgentInvocationStep = {
      id: 'no-client',
      type: 'agent_invocation',
      agentId: 'agent-1',
      message: 'hello',
    };
    const input = makeInput({ steps: [step] });
    const deps = makeDeps(makePersistence(), makePublisher(), {});

    const result = await runWorkflow(input, 'exec-l2-05', deps);

    expect(result.status).toBe('failed');
    expect(result.error?.message).toBe('RuntimeClient not configured');
  });

  it('tool step without toolClient fails clearly', async () => {
    const step: ToolCallStep = {
      id: 'no-tool-client',
      type: 'tool_call',
      toolName: 'some_tool',
      params: {},
    };
    const input = makeInput({ steps: [step] });
    const deps = makeDeps(makePersistence(), makePublisher(), {});

    const result = await runWorkflow(input, 'exec-l2-06', deps);

    expect(result.status).toBe('failed');
    expect(result.error?.message).toBe('ToolExecutionClient not configured');
  });
});

// ===========================================================================
// 4. Agent and tool failures propagate
// ===========================================================================

describe('L2: External service failures', () => {
  it('agent throwing error fails workflow with the message', async () => {
    const runtimeClient: RuntimeClient = {
      sendMessage: vi.fn().mockRejectedValue(new Error('Agent unreachable')),
    };
    const step: AgentInvocationStep = {
      id: 'agent-fail',
      type: 'agent_invocation',
      agentId: 'broken-agent',
      message: 'test',
    };
    const input = makeInput({ steps: [step] });
    const deps = makeDeps(makePersistence(), makePublisher(), { runtimeClient });

    const result = await runWorkflow(input, 'exec-l2-07', deps);

    expect(result.status).toBe('failed');
    expect(result.error?.message).toBe('Agent unreachable');
  });

  it('tool returning error still completes (executor decides)', async () => {
    const toolClient: ToolExecutionClient = {
      executeTool: vi.fn().mockResolvedValue({
        success: false,
        status: 'failed',
        error: { code: 'TOOL_ERROR', message: 'Invalid input' },
      }),
    };
    const step: ToolCallStep = {
      id: 'tool-err',
      type: 'tool_call',
      toolName: 'validate',
      params: {},
    };
    const input = makeInput({ steps: [step] });
    const deps = makeDeps(makePersistence(), makePublisher(), { toolClient });

    const result = await runWorkflow(input, 'exec-l2-08', deps);

    // Tool returned a result (not threw), so step completes
    expect(result.status).toBe('completed');
    const output = result.context.steps['tool-err'].output as {
      success: boolean;
      error: { code: string };
    };
    expect(output.success).toBe(false);
    expect(output.error.code).toBe('TOOL_ERROR');
  });

  it('tool throwing exception fails workflow', async () => {
    const toolClient: ToolExecutionClient = {
      executeTool: vi.fn().mockRejectedValue(new Error('Connection reset')),
    };
    const step: ToolCallStep = {
      id: 'tool-crash',
      type: 'tool_call',
      toolName: 'crasher',
      params: {},
    };
    const input = makeInput({ steps: [step] });
    const deps = makeDeps(makePersistence(), makePublisher(), { toolClient });

    const result = await runWorkflow(input, 'exec-l2-09', deps);

    expect(result.status).toBe('failed');
    expect(result.error?.message).toBe('Connection reset');
  });
});

// ===========================================================================
// 5. on_failure routing (step has onFailureSteps)
// ===========================================================================

describe('L2: on_failure routing', () => {
  it('step failure routes to on_failure branch instead of failing workflow', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Service down'));

    const failingStep = {
      id: 'risky',
      type: 'http' as const,
      method: 'GET' as const,
      url: 'https://api.example.com/risky',
      onFailureSteps: ['fallback'],
    };
    const fallbackStep: DelayStep = {
      id: 'fallback',
      type: 'delay',
      duration: 'PT1S',
    };

    const input = makeInput({ steps: [failingStep, fallbackStep] });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(input, 'exec-l2-10', deps);

    // Workflow completes because failure was routed to fallback
    expect(result.status).toBe('completed');
    expect(result.context.steps['risky'].status).toBe('failed');
    expect(result.context.steps['fallback'].status).toBe('completed');
  });

  it('on_failure chain with multiple recovery steps', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Primary failed'),
    );
    mockFetchJson(200, { recovered: true });

    const primaryStep = {
      id: 'primary',
      type: 'http' as const,
      method: 'GET' as const,
      url: 'https://api.example.com/primary',
      onFailureSteps: ['recovery'],
    };
    const recoveryStep: HttpStep = {
      id: 'recovery',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/backup',
    };

    const input = makeInput({ steps: [primaryStep, recoveryStep] });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(input, 'exec-l2-11', deps);

    expect(result.status).toBe('completed');
    expect(result.context.steps['primary'].status).toBe('failed');
    expect(result.context.steps['recovery'].status).toBe('completed');
    const recoveryOut = result.context.steps['recovery'].output as {
      body: { recovered: boolean };
    };
    expect(recoveryOut.body.recovered).toBe(true);
  });
});

// ===========================================================================
// 6. on_success routing
// ===========================================================================

describe('L2: on_success routing', () => {
  it('successful step follows onSuccessSteps instead of sequential order', async () => {
    mockFetchJson(200, { ok: true });

    const step1 = {
      id: 'first',
      type: 'http' as const,
      method: 'GET' as const,
      url: 'https://api.example.com/first',
      onSuccessSteps: ['target'],
    };
    const skippedStep: DelayStep = {
      id: 'skipped',
      type: 'delay',
      duration: 'PT1S',
    };
    const targetStep: DelayStep = {
      id: 'target',
      type: 'delay',
      duration: 'PT2S',
    };

    const input = makeInput({ steps: [step1, skippedStep, targetStep] });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(input, 'exec-l2-12', deps);

    expect(result.status).toBe('completed');
    expect(result.context.steps['first'].status).toBe('completed');
    expect(result.context.steps['target'].status).toBe('completed');
    // Skipped step should NOT have executed
    expect(result.context.steps['skipped']).toBeUndefined();
  });
});

// ===========================================================================
// 7. Publisher event sequence verification
// ===========================================================================

describe('L2: Event sequence verification', () => {
  it('emits correct event sequence for successful 2-step workflow', async () => {
    mockFetchSequence([
      { status: 200, body: { ok: true } },
      { status: 200, body: { ok: true } },
    ]);

    const steps: HttpStep[] = [
      { id: 's1', type: 'http', method: 'GET', url: 'https://api.example.com/1' },
      { id: 's2', type: 'http', method: 'GET', url: 'https://api.example.com/2' },
    ];
    const publisher = makePublisher();
    const input = makeInput({ steps });
    const deps = makeDeps(makePersistence(), publisher);

    await runWorkflow(input, 'exec-l2-13', deps);

    const types = publisher.events.map((e) => e.message.type);
    // Start + End are first-class lifecycle steps: Start fires before
    // workflow.started; End fires after the last user step and before
    // workflow.completed.
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
  });

  it('emits step.failed and workflow.failed on error', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Boom'));

    const step: HttpStep = {
      id: 'boom',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/fail',
    };
    const publisher = makePublisher();
    const input = makeInput({ steps: [step] });
    const deps = makeDeps(makePersistence(), publisher);

    await runWorkflow(input, 'exec-l2-14', deps);

    const types = publisher.events.map((e) => e.message.type);
    // Start completes fine (no inputVariables declared), step fails, workflow
    // fails; the End-phase block is never reached so no step.started(end).
    expect(types).toEqual([
      'step.started', // Start
      'step.completed', // Start
      'workflow.started',
      'step.started', // boom
      'step.failed', // boom
      'workflow.failed',
    ]);
  });

  it('events use tenant-scoped channels', async () => {
    const publisher = makePublisher();
    const input = makeInput({ tenantId: 'T-99', steps: [] });
    const deps = makeDeps(makePersistence(), publisher);

    await runWorkflow(input, 'exec-l2-15', deps);

    for (const event of publisher.events) {
      expect(event.channel).toContain('T-99');
      expect(event.channel).toContain('exec-l2-15');
    }
  });
});

// ===========================================================================
// 8. Persistence tracking verification
// ===========================================================================

describe('L2: Persistence tracking', () => {
  it('createExecution is called with correct initial state', async () => {
    const persistence = makePersistence();
    const step: DelayStep = { id: 'd1', type: 'delay', duration: 'PT1S' };
    const input = makeInput({ steps: [step] });
    const deps = makeDeps(persistence, makePublisher());

    await runWorkflow(input, 'exec-l2-16', deps);

    expect(persistence.createExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: 'exec-l2-16',
        tenantId: 'tenant-2',
        projectId: 'project-2',
        status: 'running',
        // Start and End are now first-class lifecycle steps (pending → running →
        // completed|failed). Both are created as `pending` and transition
        // through updateStepStatus calls, matching every other step.
        steps: [
          { stepId: 'start', name: 'Start', type: 'start', status: 'completed' },
          { stepId: 'd1', name: 'delay', type: 'delay', status: 'pending' },
          { stepId: 'end', name: 'End', type: 'end', status: 'pending' },
        ],
      }),
    );
  });

  it('updateExecutionStatus called with completed on success', async () => {
    const persistence = makePersistence();
    const input = makeInput({
      steps: [{ id: 'success-delay', type: 'delay', duration: 'PT1S' } satisfies DelayStep],
    });
    const deps = makeDeps(persistence, makePublisher());

    await runWorkflow(input, 'exec-l2-17', deps);

    expect(persistence.updateExecutionStatus).toHaveBeenCalledWith(
      'exec-l2-17',
      'tenant-2',
      'project-2',
      'completed',
      expect.objectContaining({ context: expect.any(Object) }),
    );
  });

  it('updateExecutionStatus called with failed and error on failure', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB down'));

    const persistence = makePersistence();
    const step: HttpStep = {
      id: 'fail',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/db',
    };
    const input = makeInput({ steps: [step] });
    const deps = makeDeps(persistence, makePublisher());

    await runWorkflow(input, 'exec-l2-18', deps);

    expect(persistence.updateExecutionStatus).toHaveBeenCalledWith(
      'exec-l2-18',
      'tenant-2',
      'project-2',
      'failed',
      expect.objectContaining({
        error: { code: 'WORKFLOW_FAILED', message: 'DB down' },
      }),
    );
  });
});

// ===========================================================================
// 9. Condition with undefined expression
// ===========================================================================

describe('L2: Condition edge cases', () => {
  it('condition with non-existent path evaluates falsy', async () => {
    mockFetchJson(200, { data: {} });

    const httpStep: HttpStep = {
      id: 'fetch',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/data',
    };
    const condStep: ConditionStep = {
      id: 'check',
      type: 'condition',
      expression: '{{steps.fetch.output.body.data.nonExistentField}}',
      thenSteps: ['yes'],
      elseSteps: ['no'],
    };
    const yesDelay: DelayStep = { id: 'yes', type: 'delay', duration: 'PT1S' };
    const noDelay: DelayStep = { id: 'no', type: 'delay', duration: 'PT2S' };

    const input = makeInput({ steps: [httpStep, condStep, yesDelay, noDelay] });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(input, 'exec-l2-19', deps);

    expect(result.status).toBe('completed');
    const condOut = result.context.steps['check'].output as { conditionMet: boolean };
    expect(condOut.conditionMet).toBe(false);
    // Else branch executed
    expect(result.context.steps['no']).toBeDefined();
    expect(result.context.steps['yes']).toBeUndefined();
  });

  it('chained conditions both evaluated correctly', async () => {
    mockFetchJson(200, { premium: true, score: 0 });

    const httpStep: HttpStep = {
      id: 'data',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/user',
    };
    const cond1: ConditionStep = {
      id: 'is-premium',
      type: 'condition',
      expression: '{{steps.data.output.body.premium}}',
      thenSteps: ['check-score'],
    };
    const cond2: ConditionStep = {
      id: 'check-score',
      type: 'condition',
      expression: '{{steps.data.output.body.score}}',
      thenSteps: ['high-score'],
      elseSteps: ['low-score'],
    };
    const highDelay: DelayStep = { id: 'high-score', type: 'delay', duration: 'PT1S' };
    const lowDelay: DelayStep = { id: 'low-score', type: 'delay', duration: 'PT2S' };

    const input = makeInput({
      steps: [httpStep, cond1, cond2, highDelay, lowDelay],
    });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(input, 'exec-l2-20', deps);

    expect(result.status).toBe('completed');
    // First cond: premium=true → then
    expect(
      (result.context.steps['is-premium'].output as { conditionMet: boolean }).conditionMet,
    ).toBe(true);
    // Second cond: score=0 → falsy → else
    expect(
      (result.context.steps['check-score'].output as { conditionMet: boolean }).conditionMet,
    ).toBe(false);
    expect(result.context.steps['low-score']).toBeDefined();
    expect(result.context.steps['high-score']).toBeUndefined();
  });
});

// ===========================================================================
// 10. Non-Error rejection stringified
// ===========================================================================

describe('L2: Non-Error rejection handling', () => {
  it('string rejection is captured in workflow error', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue('raw string error');

    const step: HttpStep = {
      id: 'str-err',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/fail',
    };
    const input = makeInput({ steps: [step] });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(input, 'exec-l2-21', deps);

    expect(result.status).toBe('failed');
    expect(result.error?.message).toBe('raw string error');
  });
});

// ===========================================================================
// 11. Empty steps array
// ===========================================================================

describe('L2: Edge cases', () => {
  it('empty steps array fails with no-path guidance', async () => {
    const publisher = makePublisher();
    const input = makeInput({ steps: [] });
    const deps = makeDeps(makePersistence(), publisher);

    const result = await runWorkflow(input, 'exec-l2-22', deps);

    expect(result.status).toBe('failed');
    expect(result.error).toEqual({
      code: 'NO_STEPS',
      message: expect.stringMatching(/no complete Start/i),
    });

    const types = publisher.events.map((e) => e.message.type);
    expect(types).toEqual(['workflow.failed']);
  });

  it('persistence error propagates to workflow failure', async () => {
    mockFetchJson(200, { ok: true });

    const persistence = makePersistence();
    // First call is for the synthetic 'start' step — let it succeed.
    // Reject on the second call (the "running" update for the actual step).
    persistence.updateStepStatus = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error('DB write failed'));

    const step: HttpStep = {
      id: 'persist-fail',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/ok',
    };
    const input = makeInput({ steps: [step] });
    const deps = makeDeps(persistence, makePublisher());

    const result = await runWorkflow(input, 'exec-l2-23', deps);

    expect(result.status).toBe('failed');
    expect(result.error?.message).toBe('DB write failed');
  });
});

// ===========================================================================
// 12. Transform with data from failed-recovered path
// ===========================================================================

describe('L2: Data flow through recovery paths', () => {
  it('recovery step output available to subsequent steps', async () => {
    // Primary fails, recovery succeeds, transform reads recovery output
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Primary down'));
    mockFetchJson(200, { backupData: 'recovered-value' });

    const primaryStep = {
      id: 'primary',
      type: 'http' as const,
      method: 'GET' as const,
      url: 'https://api.example.com/primary',
      onFailureSteps: ['backup'],
    };
    const backupStep: HttpStep = {
      id: 'backup',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/backup',
      onSuccessSteps: ['extract'],
    };
    const extractStep: TransformStep = {
      id: 'extract',
      type: 'transform',
      config: {
        inputExpression: '{{steps.backup.output.body.backupData}}',
        outputVariable: 'recoveredValue',
      },
    };

    const input = makeInput({ steps: [primaryStep, backupStep, extractStep] });
    const deps = makeDeps(makePersistence(), makePublisher());

    const result = await runWorkflow(input, 'exec-l2-24', deps);

    expect(result.status).toBe('completed');
    expect(result.context['recoveredValue']).toBe('recovered-value');
  });
});
