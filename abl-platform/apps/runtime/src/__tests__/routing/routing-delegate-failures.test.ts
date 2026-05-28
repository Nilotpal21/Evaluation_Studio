/**
 * RoutingExecutor Delegate Failure Variants
 *
 * Tests delegate safety guards, timeout behavior, ON_FAILURE handling,
 * INPUT/RETURNS mapping, and state restoration after delegate completion.
 *
 * Tests both the public `handleDelegate` method on RoutingExecutor and
 * the exported standalone helper functions (handleDelegateFailure,
 * mapDelegateInput, mapDelegateReturns).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RoutingExecutor } from '../../services/execution/routing-executor.js';
import {
  handleDelegateFailure,
  mapDelegateInput,
  mapDelegateReturns,
} from '../../services/execution/routing-executor.js';
import type {
  RuntimeSession,
  ExecutorContext,
  AgentRegistry,
  RuntimeExecutorConfig,
  DelegateConfigIR,
  ExecutionResult,
} from '../../services/execution/types.js';
import type { LLMWiringService } from '../../services/execution/llm-wiring.js';

// =============================================================================
// TEST HELPERS
// =============================================================================

function createMockSession(overrides?: Partial<RuntimeSession>): RuntimeSession {
  const session: RuntimeSession = {
    id: 'test-session-1',
    agentName: 'ParentAgent',
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
    delegateStack: [],
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    initialized: true,
    storeVersion: 0,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    ...overrides,
  };

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
  const agentRegistry: AgentRegistry = {
    ParentAgent: { dsl: '', ir: { name: 'ParentAgent' } as any },
    ChildAgent: { dsl: '', ir: { name: 'ChildAgent' } as any },
    AgentA: { dsl: '', ir: { name: 'AgentA' } as any },
    AgentB: { dsl: '', ir: { name: 'AgentB' } as any },
    AgentC: { dsl: '', ir: { name: 'AgentC' } as any },
  };

  return {
    executeMessage: vi.fn().mockResolvedValue({
      response: 'delegate result',
      action: { type: 'respond' },
    }),
    wireLLMClient: vi.fn().mockResolvedValue(undefined),
    checkConstraints: vi.fn().mockReturnValue(null),
    handleConstraintViolation: vi.fn(),
    interpolateTemplate: vi.fn((t: string) => t),
    debouncedPersist: vi.fn(),
    markExecuting: vi.fn(),
    unmarkExecuting: vi.fn(),
    cancelPendingPersist: vi.fn(),
    agentRegistry,
    sessions: new Map(),
    config: { timeoutMs: 30000 } as RuntimeExecutorConfig,
    reasoning: {
      execute: vi.fn(),
    },
    ...overrides,
  } as unknown as ExecutorContext;
}

function createMockLLMWiring(): LLMWiringService {
  return {
    wireLLMClient: vi.fn().mockResolvedValue(undefined),
    clearCooldown: vi.fn(),
  } as unknown as LLMWiringService;
}

function makeDelegateConfig(overrides?: Partial<DelegateConfigIR>): DelegateConfigIR {
  return {
    agent: 'ChildAgent',
    when: '',
    purpose: 'test delegation',
    input: {},
    returns: {},
    use_result: 'result',
    on_failure: 'continue',
    ...overrides,
  };
}

// =============================================================================
// 1. WHEN condition false returns error with constraint_check trace
// =============================================================================

describe('handleDelegate — WHEN condition guard', () => {
  let ctx: ExecutorContext;
  let llmWiring: LLMWiringService;
  let executor: RoutingExecutor;

  beforeEach(() => {
    ctx = createMockExecutorContext();
    llmWiring = createMockLLMWiring();
    executor = new RoutingExecutor(ctx, llmWiring);
  });

  it('WHEN condition false returns error with constraint_check trace', async () => {
    const session = createMockSession({
      agentName: 'ParentAgent',
      agentIR: {
        name: 'ParentAgent',
        coordination: {
          delegates: [
            makeDelegateConfig({
              agent: 'ChildAgent',
              when: 'booking_confirmed == true',
            }),
          ],
        },
      } as any,
    });
    // Ensure the condition context has booking_confirmed = false
    session.data.values.booking_confirmed = false;

    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];

    const result = await executor.handleDelegate(
      session,
      { target: 'ChildAgent', input: {} },
      undefined,
      (event) => traceEvents.push(event),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('WHEN condition not met');
    expect(result.error).toContain('ChildAgent');

    // Should have emitted a constraint_check trace
    const constraintTrace = traceEvents.find((e) => e.type === 'constraint_check');
    expect(constraintTrace).toBeDefined();
    expect(constraintTrace!.data.constraintType).toBe('delegate_when');
    expect(constraintTrace!.data.target).toBe('ChildAgent');
    expect(constraintTrace!.data.passed).toBe(false);

    // executeMessage should NOT have been called
    expect(ctx.executeMessage).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 2-4. Self-delegation, cycle detection, depth limit
// =============================================================================

describe('handleDelegate — safety guards', () => {
  let ctx: ExecutorContext;
  let llmWiring: LLMWiringService;
  let executor: RoutingExecutor;

  beforeEach(() => {
    ctx = createMockExecutorContext();
    llmWiring = createMockLLMWiring();
    executor = new RoutingExecutor(ctx, llmWiring);
  });

  it('self-delegation returns error', async () => {
    const session = createMockSession({ agentName: 'ParentAgent' });

    const result = await executor.handleDelegate(session, {
      target: 'ParentAgent',
      input: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Cannot delegate to yourself');
    expect(result.error).toContain('ParentAgent');
    expect(ctx.executeMessage).not.toHaveBeenCalled();
  });

  it('cycle detection (A->B->A) returns error with stack trace', async () => {
    // Simulate AgentB currently executing with AgentA already in the delegate stack
    const session = createMockSession({
      agentName: 'AgentB',
      delegateStack: ['AgentA', 'AgentB'],
    });
    session.threads[0].agentName = 'AgentB';

    const result = await executor.handleDelegate(session, {
      target: 'AgentA',
      input: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Delegate cycle detected');
    expect(result.error).toContain('AgentA');
    // The error should show the full chain
    expect(result.error).toContain('AgentA \u2192 AgentB \u2192 AgentA');
    expect(ctx.executeMessage).not.toHaveBeenCalled();
  });

  it('depth limit exceeded (>10) returns error', async () => {
    const deepStack = Array.from({ length: 10 }, (_, i) => `Agent${i}`);
    const session = createMockSession({
      agentName: 'Agent10',
      delegateStack: deepStack,
    });
    session.threads[0].agentName = 'Agent10';

    const result = await executor.handleDelegate(session, {
      target: 'AgentNew',
      input: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Delegate depth limit reached');
    expect(result.error).toContain('10');
    expect(ctx.executeMessage).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 5. IR-native delegate input/result envelope
// =============================================================================

describe('handleDelegate — IR-native input and child result envelope', () => {
  let ctx: ExecutorContext;
  let llmWiring: LLMWiringService;
  let executor: RoutingExecutor;

  beforeEach(() => {
    ctx = createMockExecutorContext();
    llmWiring = createMockLLMWiring();
    executor = new RoutingExecutor(ctx, llmWiring);
  });

  it('uses top-level typed delegate_to fields as child payload without leaking child chunks', async () => {
    const session = createMockSession({
      agentName: 'ParentAgent',
      agentIR: {
        name: 'ParentAgent',
        coordination: {
          delegates: [makeDelegateConfig({ agent: 'ChildAgent' })],
        },
      } as any,
    });
    const chunks: string[] = [];
    let childValues: Record<string, unknown> | undefined;

    (ctx.executeMessage as any).mockImplementation(
      async (sessionId: string, _message: string, childOnChunk?: (chunk: string) => void) => {
        childValues = { ...(ctx.sessions.get(sessionId) as RuntimeSession).data.values };
        childOnChunk?.('child output must stay silent');
        return { response: 'child done', action: { type: 'respond' } };
      },
    );

    const result = await executor.handleDelegate(
      session,
      {
        target: 'ChildAgent',
        reason: 'fee lookup',
        thought: 'delegate the calculation',
        message: 'Calculate fees',
        destination: 'Paris',
        nights: 3,
      },
      (chunk) => chunks.push(chunk),
    );

    expect(result.success).toBe(true);
    expect(childValues).toMatchObject({
      destination: 'Paris',
      nights: 3,
      delegate_from: 'ParentAgent',
    });
    expect(childValues).not.toHaveProperty('reason');
    expect(childValues).not.toHaveProperty('thought');
    expect(childValues).not.toHaveProperty('message');
    expect(childValues).not.toHaveProperty('target');
    expect(chunks).toEqual([]);
  });

  it('preserves explicit input.input over top-level typed delegate fields', async () => {
    const session = createMockSession({
      agentName: 'ParentAgent',
      agentIR: {
        name: 'ParentAgent',
        coordination: {
          delegates: [makeDelegateConfig({ agent: 'ChildAgent' })],
        },
      } as any,
    });
    let childValues: Record<string, unknown> | undefined;

    (ctx.executeMessage as any).mockImplementation(async (sessionId: string) => {
      childValues = { ...(ctx.sessions.get(sessionId) as RuntimeSession).data.values };
      return { response: 'child done', action: { type: 'respond' } };
    });

    const result = await executor.handleDelegate(session, {
      target: 'ChildAgent',
      message: 'Calculate fees',
      destination: 'Paris',
      input: {
        destination: 'Rome',
        nights: 4,
      },
    });

    expect(result.success).toBe(true);
    expect(childValues).toMatchObject({
      destination: 'Rome',
      nights: 4,
      delegate_from: 'ParentAgent',
    });
  });

  it('falls back to DELEGATE INPUT mapping when no explicit payload is supplied', async () => {
    const session = createMockSession({
      agentName: 'ParentAgent',
      agentIR: {
        name: 'ParentAgent',
        coordination: {
          delegates: [
            makeDelegateConfig({
              agent: 'ChildAgent',
              input: {
                destination: 'destination',
              },
            }),
          ],
        },
      } as any,
    });
    session.data.values.destination = 'Tokyo';
    let childValues: Record<string, unknown> | undefined;

    (ctx.executeMessage as any).mockImplementation(async (sessionId: string) => {
      childValues = { ...(ctx.sessions.get(sessionId) as RuntimeSession).data.values };
      return { response: 'child done', action: { type: 'respond' } };
    });

    const result = await executor.handleDelegate(session, {
      target: 'ChildAgent',
      message: 'Calculate fees',
    });

    expect(result.success).toBe(true);
    expect(childValues).toMatchObject({
      destination: 'Tokyo',
      delegate_from: 'ParentAgent',
    });
  });

  it('maps RETURNS from child data and stateUpdates through the delegate envelope', async () => {
    const session = createMockSession({
      agentName: 'ParentAgent',
      agentIR: {
        name: 'ParentAgent',
        coordination: {
          delegates: [
            makeDelegateConfig({
              agent: 'ChildAgent',
              returns: {
                confirmation_id: 'booking_id',
                'stateUpdates.context.child_status': 'child_status',
              },
              use_result: 'child_result',
            }),
          ],
        },
      } as any,
    });

    (ctx.executeMessage as any).mockImplementation(async (sessionId: string) => {
      const childSession = ctx.sessions.get(sessionId) as RuntimeSession;
      childSession.data.values.confirmation_id = 'DATA-123';
      childSession.data.gatheredKeys.add('confirmation_id');
      return {
        response: 'plain child response',
        action: { type: 'respond' },
        stateUpdates: {
          context: { child_status: 'ready' },
          gatherProgress: { child_status: 'ready' },
        },
      };
    });

    const result = await executor.handleDelegate(session, {
      target: 'ChildAgent',
      message: 'Book it',
    });

    expect(result.success).toBe(true);
    expect(session.data.values.booking_id).toBe('DATA-123');
    expect(session.data.values.child_status).toBe('ready');
    expect(session.data.gatheredKeys.has('booking_id')).toBe(true);
    expect(session.data.gatheredKeys.has('child_status')).toBe(true);
    expect(result.result).toMatchObject({
      response: 'plain child response',
      values: { confirmation_id: 'DATA-123' },
      stateUpdates: { context: { child_status: 'ready' } },
    });
    expect(session.data.values.child_result).toMatchObject({
      response: 'plain child response',
      values: { confirmation_id: 'DATA-123' },
    });
  });
});

// =============================================================================
// 6. Timeout severs shared references to prevent parent corruption
// =============================================================================

describe('handleDelegate — timeout isolation', () => {
  let ctx: ExecutorContext;
  let llmWiring: LLMWiringService;
  let executor: RoutingExecutor;

  beforeEach(() => {
    vi.useFakeTimers();
    ctx = createMockExecutorContext();
    llmWiring = createMockLLMWiring();
    executor = new RoutingExecutor(ctx, llmWiring);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout severs shared references to prevent parent corruption', async () => {
    const session = createMockSession({
      agentName: 'ParentAgent',
      agentIR: {
        name: 'ParentAgent',
        coordination: {
          delegates: [
            makeDelegateConfig({
              agent: 'ChildAgent',
              timeout: '50ms',
              on_failure: 'continue',
            }),
          ],
        },
      } as any,
    });

    // Set some parent data that must survive untouched
    session.data.values.parentField = 'must-survive';

    // Mock executeMessage to never resolve (simulating a long-running delegate)
    (ctx.executeMessage as any).mockImplementation(() => new Promise(() => {}));

    const resultPromise = executor.handleDelegate(session, {
      target: 'ChildAgent',
      input: {},
      message: 'test',
    });

    // Advance past the 50ms timeout
    await vi.advanceTimersByTimeAsync(100);
    const result = await resultPromise;

    expect(result.success).toBe(false);

    // The delegate thread (last in the array) should have severed references
    const delegateThread = session.threads[session.threads.length - 1];
    expect(delegateThread.conversationHistory).toEqual([]);
    expect(delegateThread.data.gatheredKeys.size).toBe(0);
    expect(Object.keys(delegateThread.data.values)).toEqual([]);

    // Parent session should be restored to the parent thread
    // (syncThreadToSession restores from the active thread)
    expect(session.activeThreadIndex).toBe(0);
  });
});

// =============================================================================
// 6-8. ON_FAILURE modes (respond, escalate, continue) via exported helper
// =============================================================================

describe('handleDelegateFailure — ON_FAILURE modes', () => {
  it('ON_FAILURE respond: outputs failure_message and pushes to conversation', () => {
    const session = createMockSession();
    const chunks: string[] = [];
    const config = makeDelegateConfig({
      on_failure: 'respond',
      failure_message: 'Sorry, the booking agent is unavailable.',
    });

    const result = handleDelegateFailure(session, config, 'agent timeout', (chunk) =>
      chunks.push(chunk),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('agent timeout');
    expect(result.result).toBe('Sorry, the booking agent is unavailable.');
    expect(chunks).toContain('Sorry, the booking agent is unavailable.');

    // Should have pushed the failure message to conversation history
    const lastMsg = session.conversationHistory[session.conversationHistory.length - 1];
    expect(lastMsg.role).toBe('assistant');
    expect(lastMsg.content).toBe('Sorry, the booking agent is unavailable.');
  });

  it('ON_FAILURE escalate: sets isEscalated and escalationReason', () => {
    const session = createMockSession();
    const config = makeDelegateConfig({ on_failure: 'escalate' });

    const result = handleDelegateFailure(session, config, 'child agent crashed');

    expect(result.success).toBe(false);
    expect(result.error).toBe('child agent crashed');
    expect(session.isEscalated).toBe(true);
    expect(session.escalationReason).toBe('Delegate failed: child agent crashed');
  });

  it('ON_FAILURE continue: returns error without side effects', () => {
    const session = createMockSession();
    const config = makeDelegateConfig({ on_failure: 'continue' });

    const result = handleDelegateFailure(session, config, 'transient failure');

    expect(result.success).toBe(false);
    expect(result.error).toBe('transient failure');
    // No side effects
    expect(session.isEscalated).toBe(false);
    expect(session.escalationReason).toBeUndefined();
    expect(session.conversationHistory).toHaveLength(0);
  });
});

// =============================================================================
// 9-10. INPUT mapping via exported mapDelegateInput
// =============================================================================

describe('mapDelegateInput — dot-path resolution', () => {
  it('INPUT mapping resolves dot-paths from context', () => {
    const mapping = {
      destination: 'booking.city',
      nights: 'booking.nights',
      guestName: 'user.profile.name',
    };
    const context = {
      booking: { city: 'Paris', nights: 3 },
      user: { profile: { name: 'Alice' } },
    };

    const result = mapDelegateInput(mapping, context);

    expect(result).toEqual({
      destination: 'Paris',
      nights: 3,
      guestName: 'Alice',
    });
  });

  it('INPUT mapping logs warning for undefined paths', () => {
    const mapping = {
      present: 'existing_key',
      missing: 'nonexistent.deep.path',
    };
    const context = { existing_key: 'value' };

    const result = mapDelegateInput(mapping, context);

    // Only the resolved value should be present
    expect(result).toEqual({ present: 'value' });
    // The undefined path should NOT be included in the result
    expect(result).not.toHaveProperty('missing');
  });
});

// =============================================================================
// 11. RETURNS mapping via exported mapDelegateReturns
// =============================================================================

describe('mapDelegateReturns — result field mapping', () => {
  it('RETURNS mapping transforms result fields back to session', () => {
    const session = createMockSession();
    const mapping = {
      confirmation_id: 'booking_id',
      total_cost: 'cost',
    };
    const result: ExecutionResult = {
      response: JSON.stringify({
        confirmation_id: 'BK-12345',
        total_cost: 499.99,
        internal_note: 'should not be mapped',
      }),
      action: { type: 'complete' },
    };

    mapDelegateReturns(mapping, result, session);

    expect(session.data.values.booking_id).toBe('BK-12345');
    expect(session.data.values.cost).toBe(499.99);
    expect(session.data.gatheredKeys.has('booking_id')).toBe(true);
    expect(session.data.gatheredKeys.has('cost')).toBe(true);
    // Unmapped fields should not leak into session
    expect(session.data.values).not.toHaveProperty('internal_note');
  });
});

// =============================================================================
// 12. delegateStack popped after timeout
// =============================================================================

describe('handleDelegate — delegateStack cleanup', () => {
  let ctx: ExecutorContext;
  let llmWiring: LLMWiringService;
  let executor: RoutingExecutor;

  beforeEach(() => {
    vi.useFakeTimers();
    ctx = createMockExecutorContext();
    llmWiring = createMockLLMWiring();
    executor = new RoutingExecutor(ctx, llmWiring);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('delegateStack popped after timeout', async () => {
    const session = createMockSession({
      agentName: 'ParentAgent',
      agentIR: {
        name: 'ParentAgent',
        coordination: {
          delegates: [
            makeDelegateConfig({
              agent: 'ChildAgent',
              timeout: '50ms',
              on_failure: 'continue',
            }),
          ],
        },
      } as any,
    });

    expect(session.delegateStack).toEqual([]);

    // Capture the stack during execution to verify it was pushed
    let stackDuringExecution: string[] = [];
    (ctx.executeMessage as any).mockImplementation(async () => {
      stackDuringExecution = [...session.delegateStack];
      // Never resolve to trigger timeout
      return new Promise(() => {});
    });

    const resultPromise = executor.handleDelegate(session, {
      target: 'ChildAgent',
      input: {},
      message: 'test',
    });

    await vi.advanceTimersByTimeAsync(100);
    const result = await resultPromise;

    // The stack should have contained 'ChildAgent' during execution
    expect(stackDuringExecution).toContain('ChildAgent');

    // After timeout, the stack should be cleaned up
    expect(result.success).toBe(false);
    expect(session.delegateStack).toEqual([]);
  });
});

// =============================================================================
// 13. activeThreadIndex restored to parent after delegate completes
// =============================================================================

describe('handleDelegate — thread index restoration', () => {
  let ctx: ExecutorContext;
  let llmWiring: LLMWiringService;
  let executor: RoutingExecutor;

  beforeEach(() => {
    ctx = createMockExecutorContext();
    llmWiring = createMockLLMWiring();
    executor = new RoutingExecutor(ctx, llmWiring);
  });

  it('activeThreadIndex restored to parent after delegate completes', async () => {
    const session = createMockSession({ agentName: 'ParentAgent' });
    const originalThreadIndex = session.activeThreadIndex;
    expect(originalThreadIndex).toBe(0);

    // Track thread index changes during execution
    let indexDuringExecution: number | undefined;
    (ctx.executeMessage as any).mockImplementation(async () => {
      // During delegate execution, activeThreadIndex should point to the delegate thread
      indexDuringExecution = session.activeThreadIndex;
      return { response: 'child result', action: { type: 'respond' } };
    });

    const result = await executor.handleDelegate(session, {
      target: 'ChildAgent',
      input: {},
      message: 'do something',
    });

    expect(result.success).toBe(true);

    // During execution the index should have been different (pointing to the new delegate thread)
    expect(indexDuringExecution).toBeDefined();
    expect(indexDuringExecution).toBeGreaterThan(originalThreadIndex);

    // After completion, the index should be restored to the original parent thread
    expect(session.activeThreadIndex).toBe(originalThreadIndex);
  });
});
