/**
 * Routing Executor — Completion/Handoff Condition Evaluation Tests
 *
 * Tests the checkCompletionConditions and checkHandoffConditions methods
 * on the RoutingExecutor class, plus related helper function behavior
 * (executeComplete, tryThreadReturn) in the context of condition evaluation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must appear before any imports that pull the mocked modules
// ---------------------------------------------------------------------------

const mockEvaluateConditionDual = vi.fn<(expr: string, ctx: Record<string, unknown>) => boolean>();

vi.mock('@abl/compiler', () => ({
  evaluateConditionDual: (...args: unknown[]) =>
    mockEvaluateConditionDual(args[0] as string, args[1] as Record<string, unknown>),
  interpolateMessage: (msg: string) => msg,
  DEFAULT_MESSAGES: { conversation_complete: 'This conversation has been completed.' },
  BUILTIN_FIELD_REFERENCE_VARS: [],
  ESCALATION_FORMAT: {},
  ESCALATION_REASON_MIN_LENGTH: 10,
  ESCALATION_REASON_MAX_LENGTH: 500,
  CompletionDetector: class {
    detect() {
      return null;
    }
    check(
      agentIR: any,
      context: Record<string, unknown>,
      options?: { onCheck?: (info: { condition: string; passed: boolean }) => void },
    ) {
      const conditions = agentIR?.completion?.conditions;
      if (!conditions || conditions.length === 0) {
        return { shouldComplete: false };
      }
      for (const cond of conditions) {
        const passed = mockEvaluateConditionDual(cond.when, context);
        if (options?.onCheck) {
          options.onCheck({ condition: cond.when, passed });
        }
        if (passed) {
          return { shouldComplete: true, matchedCondition: cond };
        }
      }
      return { shouldComplete: false };
    }
  },
  HandoffExecutor: class {
    validate() {
      return { allowed: true, returnExpected: false };
    }
  },
  DelegateExecutor: class {
    validate() {
      return { allowed: true };
    }
    execute() {
      return { delegated: false };
    }
  },
}));

vi.mock('@abl/compiler/platform', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createLogger: () => ({
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };
});

// Stub heavy transitive dependencies that RoutingExecutor imports
vi.mock('@agent-platform/a2a', () => ({
  sendTask: vi.fn(),
  SsrfEndpointValidator: vi.fn(),
  createA2AClient: vi.fn(),
  AgentCardCache: vi.fn(),
}));

vi.mock('@agent-platform/shared/security', () => ({
  assertUrlSafeForSSRF: vi.fn(),
  getDevSSRFOptions: vi.fn(() => ({})),
}));

vi.mock('@agent-platform/execution', () => {
  class MockInProcessExecutionRuntime {}
  class MockCountingSemaphore {
    acquire = vi.fn();
    release = vi.fn();
  }
  return {
    InProcessExecutionRuntime: MockInProcessExecutionRuntime,
    CountingSemaphore: MockCountingSemaphore,
    createChildSession: vi.fn(),
    createChildSessionForFanOut: vi.fn(),
    createExecutionId: vi.fn(() => 'exec-id'),
  };
});

vi.mock('../../services/execution/llm-wiring.js', () => ({
  LLMWiringService: vi.fn(),
}));

vi.mock('../../services/execution/prompt-builder.js', () => ({
  isVoiceChannel: vi.fn(() => false),
}));

vi.mock('../../services/execution/prompt-template-loader.js', () => ({
  promptTemplateLoader: { load: vi.fn() },
}));

vi.mock('../../services/execution/memory-integration.js', () => ({
  executeRecallForAgentEvent: vi.fn(),
}));

vi.mock('../../services/execution/multi-intent-strategy.js', () => ({
  resolveStrategy: vi.fn(),
}));

vi.mock('../../services/execution/intent-queue.js', () => ({
  enqueueIntents: vi.fn(),
  createIntentQueue: vi.fn(),
}));

vi.mock('../../services/guardrails/pipeline-factory.js', () => ({
  createGuardrailPipeline: vi.fn(),
  createLLMEvalFromClient: vi.fn(),
}));

vi.mock('../../services/execution/session-policy.js', () => ({
  getSessionPolicy: vi.fn(() => null),
  getSessionStreamingConfig: vi.fn().mockReturnValue(undefined),
  toStreamingEvalConfig: vi.fn().mockReturnValue(undefined),
  getSessionGuardrailCacheScopeKey: vi.fn().mockReturnValue(undefined),
}));

// ---------------------------------------------------------------------------
// Real imports — after mocks
// ---------------------------------------------------------------------------

import { RoutingExecutor } from '../../services/execution/routing-executor.js';
import { executeComplete } from '../../services/execution/routing-executor.js';
import { tryThreadReturn } from '../../services/execution/types.js';
import type {
  RuntimeSession,
  ExecutorContext,
  RuntimeExecutorConfig,
} from '../../services/execution/types.js';

// =============================================================================
// TEST HELPERS
// =============================================================================

type TraceEvent = { type: string; data: Record<string, unknown> };

function createMockSession(overrides?: Partial<RuntimeSession>): RuntimeSession {
  const session: RuntimeSession = {
    id: 'test-session-1',
    agentName: 'TestAgent',
    agentIR: null,
    compilationOutput: null,
    conversationHistory: [],
    state: {
      gatherProgress: {},
      conversationPhase: 'active',
      context: {},
    },
    data: {
      values: {},
      gatheredKeys: new Set<string>(),
    },
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    initialized: true,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    ...overrides,
  };

  // Ensure at least one thread exists so getActiveThread works
  if (session.threads.length === 0) {
    session.threads = [
      {
        agentName: session.agentName,
        agentIR: session.agentIR,
        conversationHistory: session.conversationHistory,
        state: session.state,
        data: session.data,
        startedAt: Date.now(),
        returnExpected: false,
        status: 'active',
      },
    ];
  }

  return session;
}

function createMockExecutorContext(overrides?: Partial<ExecutorContext>): ExecutorContext {
  return {
    executeMessage: vi.fn(),
    wireLLMClient: vi.fn(),
    checkConstraints: vi.fn(() => null),
    handleConstraintViolation: vi.fn(),
    interpolateTemplate: vi.fn((t: string) => t),
    debouncedPersist: vi.fn(),
    markExecuting: vi.fn(),
    unmarkExecuting: vi.fn(),
    cancelPendingPersist: vi.fn(),
    agentRegistry: {},
    sessions: new Map(),
    config: {} as RuntimeExecutorConfig,
    reasoning: {
      execute: vi.fn(),
    },
    ...overrides,
  } as unknown as ExecutorContext;
}

function createRoutingExecutor(ctxOverrides?: Partial<ExecutorContext>): RoutingExecutor {
  const ctx = createMockExecutorContext(ctxOverrides);
  const llmWiring = {} as any;
  return new RoutingExecutor(ctx, llmWiring);
}

// =============================================================================
// checkCompletionConditions
// =============================================================================

describe('checkCompletionConditions', () => {
  let executor: RoutingExecutor;

  beforeEach(() => {
    mockEvaluateConditionDual.mockReset();
    executor = createRoutingExecutor();
  });

  it('evaluates all conditions and emits completion_check trace for each', () => {
    const session = createMockSession({
      agentIR: {
        completion: {
          conditions: [
            { when: 'city IS SET', respond: 'Done city' },
            { when: 'hotel IS SET', respond: 'Done hotel' },
            { when: 'flights IS SET', respond: 'Done flights' },
          ],
        },
      } as any,
    });
    session.data.values = { city: 'Paris' };

    // All conditions return false so we iterate through all of them
    mockEvaluateConditionDual.mockReturnValue(false);

    const traces: TraceEvent[] = [];
    const result = executor.checkCompletionConditions(session, undefined, (e) => traces.push(e));

    expect(result).toBeNull();
    // Should have been called once per condition
    expect(mockEvaluateConditionDual).toHaveBeenCalledTimes(3);
    // A trace event must be emitted for every condition, even non-matching
    expect(traces).toHaveLength(3);
    expect(traces[0].type).toBe('completion_check');
    expect(traces[0].data.condition).toBe('city IS SET');
    expect(traces[0].data.result).toBe(false);
    expect(traces[1].data.condition).toBe('hotel IS SET');
    expect(traces[2].data.condition).toBe('flights IS SET');
  });

  it('first matching condition triggers auto-complete via executeComplete', () => {
    const session = createMockSession({
      agentIR: {
        completion: {
          conditions: [
            { when: 'city IS SET', respond: 'City collected' },
            { when: 'hotel IS SET', respond: 'Hotel collected' },
          ],
        },
      } as any,
    });
    session.data.values = { city: 'Paris' };

    // First condition matches, second does not
    mockEvaluateConditionDual.mockReturnValueOnce(true).mockReturnValueOnce(false);

    const traces: TraceEvent[] = [];
    const result = executor.checkCompletionConditions(session, undefined, (e) => traces.push(e));

    expect(result).not.toBeNull();
    // Session should be marked complete
    expect(session.isComplete).toBe(true);
    expect(session.state.conversationPhase).toBe('complete');
    // Response should come from the matched condition's respond text
    expect(result!.response).toBe('City collected');
    expect(result!.action.type).toBe('complete');
    // Only the first condition should be evaluated (short-circuit on first match)
    expect(mockEvaluateConditionDual).toHaveBeenCalledTimes(1);
  });

  it('STORE key persists context value on completion', () => {
    const session = createMockSession({
      agentIR: {
        completion: {
          conditions: [{ when: 'done IS SET', respond: 'All done', store: 'booking_data' }],
        },
      } as any,
    });
    session.data.values = { done: true, city: 'London', nights: 2 };

    mockEvaluateConditionDual.mockReturnValue(true);

    const traces: TraceEvent[] = [];
    executor.checkCompletionConditions(session, undefined, (e) => traces.push(e));

    // The stored data should exist under _stored_booking_data
    const stored = session.data.values._stored_booking_data as any;
    expect(stored).toBeDefined();
    expect(stored.key).toBe('booking_data');
    expect(stored.value.city).toBe('London');
    expect(stored.value.nights).toBe(2);
    expect(stored.sessionId).toBe('test-session-1');
    expect(stored.agentName).toBe('TestAgent');

    // A data_stored trace event should have been emitted
    const storeTrace = traces.find((t) => t.type === 'data_stored');
    expect(storeTrace).toBeDefined();
    expect(storeTrace!.data.key).toBe('booking_data');
  });

  it('tryThreadReturn restores parent thread on completion', () => {
    // Set up a session with a parent thread on the stack
    const session = createMockSession({
      agentIR: {
        completion: {
          conditions: [{ when: 'ok IS SET', respond: 'Child done' }],
        },
      } as any,
    });
    session.data.values = { ok: true };

    // Create a parent thread at index 0, child at index 1
    session.threads = [
      {
        agentName: 'ParentAgent',
        agentIR: null,
        conversationHistory: [],
        state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
        data: { values: {}, gatheredKeys: new Set() },
        startedAt: Date.now(),
        returnExpected: false,
        status: 'waiting',
      },
      {
        agentName: 'ChildAgent',
        agentIR: session.agentIR,
        conversationHistory: session.conversationHistory,
        state: session.state,
        data: session.data,
        startedAt: Date.now(),
        returnExpected: true, // expects to return to parent
        status: 'active',
      },
    ];
    session.activeThreadIndex = 1;
    session.threadStack = [0]; // parent index

    mockEvaluateConditionDual.mockReturnValue(true);

    const result = executor.checkCompletionConditions(session);

    expect(result).not.toBeNull();
    // After tryThreadReturn, the parent thread should be active again
    expect(session.activeThreadIndex).toBe(0);
    expect(session.threads[0].status).toBe('active');
    expect(session.threads[1].status).toBe('completed');
    expect(session.threadStack).toHaveLength(0);
  });

  it('no matching conditions returns null', () => {
    const session = createMockSession({
      agentIR: {
        completion: {
          conditions: [
            { when: 'a IS SET', respond: 'a done' },
            { when: 'b IS SET', respond: 'b done' },
          ],
        },
      } as any,
    });
    session.data.values = {};

    mockEvaluateConditionDual.mockReturnValue(false);

    const result = executor.checkCompletionConditions(session);

    expect(result).toBeNull();
    expect(session.isComplete).toBe(false);
    expect(session.state.conversationPhase).toBe('active');
  });

  it('trace includes source, currentStep, nextStep from callContext', () => {
    const session = createMockSession({
      agentIR: {
        completion: {
          conditions: [{ when: 'x IS SET', respond: 'done' }],
        },
      } as any,
      currentFlowStep: 'step_gather',
    });
    session.data.values = {};

    mockEvaluateConditionDual.mockReturnValue(false);

    const traces: TraceEvent[] = [];
    executor.checkCompletionConditions(session, undefined, (e) => traces.push(e), {
      source: 'flow_transition',
      currentStep: 'step_gather',
      nextStep: 'step_confirm',
    });

    expect(traces).toHaveLength(1);
    expect(traces[0].data.source).toBe('flow_transition');
    expect(traces[0].data.currentStep).toBe('step_gather');
    expect(traces[0].data.nextStep).toBe('step_confirm');
    expect(traces[0].data.agent).toBe('TestAgent');
  });
});

// =============================================================================
// checkHandoffConditions
// =============================================================================

describe('checkHandoffConditions', () => {
  let executor: RoutingExecutor;
  let handleHandoffSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockEvaluateConditionDual.mockReset();
    executor = createRoutingExecutor();
    // Spy on the handleHandoff method so we can control its return value
    handleHandoffSpy = vi
      .spyOn(executor, 'handleHandoff')
      .mockResolvedValue({ success: true, response: 'Handed off' });
  });

  it('does not mutate stale handoffReturnInfo while evaluating current IR handoff conditions', async () => {
    const session = createMockSession({
      agentIR: {
        coordination: {
          handoffs: [
            { to: 'AgentA', when: 'x IS SET', return: true },
            { to: 'AgentB', when: 'y IS SET', return: false },
          ],
        },
      } as any,
    });
    // Also set the thread's agentIR to match
    session.threads[0].agentIR = session.agentIR;
    session.data.values = {};

    // Pre-set stale handoffReturnInfo from a prior agent
    session.handoffReturnInfo = { OldAgent: true };

    mockEvaluateConditionDual.mockReturnValue(false);

    await executor.checkHandoffConditions(session);

    // Routing authority should be derived from the current IR without mutating
    // stale control-plane state on the session.
    expect(session.handoffReturnInfo).toEqual({ OldAgent: true });
  });

  it('conditions without WHEN are skipped', async () => {
    const session = createMockSession({
      agentIR: {
        coordination: {
          handoffs: [
            { to: 'AgentA' }, // no when clause
            { to: 'AgentB', when: 'ready IS SET' },
          ],
        },
      } as any,
    });
    session.threads[0].agentIR = session.agentIR;
    session.data.values = {};

    mockEvaluateConditionDual.mockReturnValue(false);

    const traces: TraceEvent[] = [];
    await executor.checkHandoffConditions(session, undefined, (e) => traces.push(e));

    // evaluateConditionDual should only be called for the handoff with WHEN
    expect(mockEvaluateConditionDual).toHaveBeenCalledTimes(1);
    expect(mockEvaluateConditionDual).toHaveBeenCalledWith('ready IS SET', session.data.values);

    // Only one trace for the handoff that has a when condition
    const condTraces = traces.filter((t) => t.type === 'handoff_condition_check');
    expect(condTraces).toHaveLength(1);
    expect(condTraces[0].data.target).toBe('AgentB');
  });

  it('first matching WHEN triggers auto-handoff via handleHandoff', async () => {
    const session = createMockSession({
      agentIR: {
        coordination: {
          handoffs: [
            { to: 'AgentA', when: 'city IS SET' },
            { to: 'AgentB', when: 'hotel IS SET' },
          ],
        },
      } as any,
    });
    session.threads[0].agentIR = session.agentIR;
    session.data.values = { city: 'Paris' };

    // First condition matches, second should not be evaluated
    mockEvaluateConditionDual.mockReturnValueOnce(true).mockReturnValueOnce(false);

    const traces: TraceEvent[] = [];
    const result = await executor.checkHandoffConditions(session, undefined, (e) => traces.push(e));

    expect(result).not.toBeNull();
    expect(result!.action.type).toBe('handoff');
    expect(result!.action.target).toBe('AgentA');

    // handleHandoff should have been called with the correct target
    expect(handleHandoffSpy).toHaveBeenCalledTimes(1);
    expect(handleHandoffSpy).toHaveBeenCalledWith(
      session,
      { target: 'AgentA', context: {}, decisionId: 'exec-id' },
      undefined,
      expect.any(Function),
    );

    // Second condition should not be evaluated since first matched
    expect(mockEvaluateConditionDual).toHaveBeenCalledTimes(1);
  });

  it('PASS fields extracted from context into handoff input', async () => {
    const session = createMockSession({
      agentIR: {
        coordination: {
          handoffs: [
            {
              to: 'BookingAgent',
              when: 'city IS SET',
              context: {
                pass: ['city', 'nights'],
              },
            },
          ],
        },
      } as any,
    });
    session.threads[0].agentIR = session.agentIR;
    session.data.values = {
      city: 'Tokyo',
      nights: 3,
      irrelevant_field: 'should not pass',
    };

    mockEvaluateConditionDual.mockReturnValue(true);

    const traces: TraceEvent[] = [];
    await executor.checkHandoffConditions(session, undefined, (e) => traces.push(e));

    // handleHandoff should receive only the PASS fields in the context
    expect(handleHandoffSpy).toHaveBeenCalledWith(
      session,
      {
        target: 'BookingAgent',
        context: { city: 'Tokyo', nights: 3 },
        decisionId: 'exec-id',
      },
      undefined,
      expect.any(Function),
    );
  });

  it('no matching conditions returns null', async () => {
    const session = createMockSession({
      agentIR: {
        coordination: {
          handoffs: [
            { to: 'AgentA', when: 'a IS SET' },
            { to: 'AgentB', when: 'b IS SET' },
          ],
        },
      } as any,
    });
    session.threads[0].agentIR = session.agentIR;
    session.data.values = {};

    mockEvaluateConditionDual.mockReturnValue(false);

    const result = await executor.checkHandoffConditions(session);

    expect(result).toBeNull();
    expect(handleHandoffSpy).not.toHaveBeenCalled();
  });

  it('trace includes agent, target, condition, result, context', async () => {
    const session = createMockSession({
      agentName: 'OrchestratorAgent',
      agentIR: {
        coordination: {
          handoffs: [{ to: 'PaymentAgent', when: 'amount > 0' }],
        },
      } as any,
    });
    session.threads[0].agentIR = session.agentIR;
    session.threads[0].agentName = 'OrchestratorAgent';
    session.data.values = { amount: 50 };

    mockEvaluateConditionDual.mockReturnValue(false);

    const traces: TraceEvent[] = [];
    await executor.checkHandoffConditions(session, undefined, (e) => traces.push(e));

    const condTraces = traces.filter((t) => t.type === 'handoff_condition_check');
    expect(condTraces).toHaveLength(1);

    const trace = condTraces[0];
    expect(trace.data.agent).toBe('OrchestratorAgent');
    expect(trace.data.target).toBe('PaymentAgent');
    expect(trace.data.condition).toBe('amount > 0');
    expect(trace.data.result).toBe(false);
    expect(trace.data.context).toEqual({ amount: 50 });
  });
});
