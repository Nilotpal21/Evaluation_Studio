/**
 * Routing Executor — Fan-Out Partial Failure & Cleanup Path Tests
 *
 * Tests the handleFanOut() method and exported helpers for:
 * - Concurrent guard (prevent overlapping fan-out from same session)
 * - Guard release in finally (even on error)
 * - All-invalid task abort trace
 * - Tool task execution errors
 * - Agent task timeout with severed refs
 * - Child thread pruning in finally block
 * - Parent activeThreadIndex re-resolution (object ref & name-based fallback)
 * - Result storage (_last_fan_out and _fan_out_result_{target})
 * - Deduplication merging intent strings
 * - Task routing (tool vs agent)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  RoutingExecutor,
  deduplicateFanOutTasks,
} from '../../services/execution/routing-executor.js';
import type {
  RuntimeSession,
  FanOutTask,
  ExecutorContext,
  AgentRegistryEntry,
  RuntimeExecutorConfig,
} from '../../services/execution/types.js';
import { getActiveThread, createThread } from '../../services/execution/types.js';

// Mock memory-integration to avoid DB/import issues
vi.mock('../../services/execution/memory-integration.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    initializeActivatedAgentMemory: vi.fn().mockResolvedValue(undefined),
    executeRecallForAgentEvent: vi.fn().mockResolvedValue(undefined),
  };
});

// Mock prompt-builder
vi.mock('../../services/execution/prompt-builder.js', () => ({
  isVoiceChannel: vi.fn().mockReturnValue(false),
}));

// Mock prompt-template-loader
vi.mock('../../services/execution/prompt-template-loader.js', () => ({
  promptTemplateLoader: {
    load: vi.fn().mockReturnValue(''),
  },
}));

// Mock value-resolution
vi.mock('../../services/execution/value-resolution.js', () => ({
  interpolateTemplate: vi.fn((tpl: string) => tpl),
  interpolateVoiceConfig: vi.fn(),
  interpolateRichContent: vi.fn(),
  resolveValuePath: vi.fn(),
}));

// Mock session-policy
vi.mock('../../services/execution/session-policy.js', () => ({
  getSessionPolicy: vi.fn().mockReturnValue(null),
  getSessionStreamingConfig: vi.fn().mockReturnValue(undefined),
  toStreamingEvalConfig: vi.fn().mockReturnValue(undefined),
  getSessionGuardrailCacheScopeKey: vi.fn().mockReturnValue(undefined),
}));

// Mock guardrails pipeline-factory
vi.mock('../../guardrails/pipeline-factory.js', () => ({
  createGuardrailPipeline: vi.fn(),
  createLLMEvalFromClient: vi.fn(),
}));

// Mock multi-intent-strategy
vi.mock('../../services/execution/multi-intent-strategy.js', () => ({
  resolveStrategy: vi.fn(),
}));

// Mock intent-queue
vi.mock('../../services/execution/intent-queue.js', () => ({
  enqueueIntents: vi.fn(),
  createIntentQueue: vi.fn(),
}));

// Mock @agent-platform/a2a
vi.mock('@agent-platform/a2a', () => ({
  sendTask: vi.fn(),
  SsrfEndpointValidator: class {},
  createA2AClient: vi.fn(),
  AgentCardCache: vi.fn(),
}));

// Mock @agent-platform/shared/security
vi.mock('@agent-platform/shared/security', () => ({
  assertUrlSafeForSSRF: vi.fn(),
  getDevSSRFOptions: vi.fn(),
}));

// =============================================================================
// TEST HELPERS
// =============================================================================

function createMockSession(overrides?: Partial<RuntimeSession>): RuntimeSession {
  const session: RuntimeSession = {
    id: 'test-session-1',
    agentName: 'SupervisorAgent',
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
    createdAt: new Date(),
    lastActivityAt: new Date(),
    storeVersion: 0,
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

function createMockConfig(overrides?: Partial<RuntimeExecutorConfig>): RuntimeExecutorConfig {
  return {
    timeoutMs: 5000,
    maxConcurrentFanOutCalls: 10,
    ...overrides,
  };
}

function createMockAgentRegistry(
  agents: Record<string, Partial<AgentRegistryEntry>>,
): Record<string, AgentRegistryEntry> {
  const registry: Record<string, AgentRegistryEntry> = {};
  for (const [name, entry] of Object.entries(agents)) {
    registry[name] = {
      dsl: '',
      ir: { name, type: 'reasoning' } as any,
      ...entry,
    };
  }
  return registry;
}

function createMockExecutorContext(overrides?: Partial<ExecutorContext>): ExecutorContext {
  return {
    executeMessage: vi
      .fn()
      .mockResolvedValue({ response: 'child response', action: { type: 'respond' } }),
    wireLLMClient: vi.fn().mockResolvedValue(undefined),
    checkConstraints: vi.fn().mockReturnValue(null),
    handleConstraintViolation: vi.fn(),
    interpolateTemplate: vi.fn((tpl: string) => tpl),
    debouncedPersist: vi.fn(),
    markExecuting: vi.fn(),
    unmarkExecuting: vi.fn(),
    cancelPendingPersist: vi.fn(),
    agentRegistry: createMockAgentRegistry({
      FlightAgent: {},
      HotelAgent: {},
    }),
    sessions: new Map(),
    config: createMockConfig(),
    reasoning: {
      execute: vi
        .fn()
        .mockResolvedValue({ response: 'reasoning result', action: { type: 'respond' } }),
    },
    ...overrides,
  };
}

function createMockLLMWiring() {
  return {
    wireLLMClient: vi.fn().mockResolvedValue(undefined),
    wireToolExecutor: vi.fn(),
    clearCooldown: vi.fn(),
    ensureSessionLLMClient: vi.fn().mockResolvedValue(undefined),
  } as any;
}

// =============================================================================
// TESTS
// =============================================================================

describe('handleFanOut — partial failure and cleanup paths', () => {
  let ctx: ExecutorContext;
  let llmWiring: ReturnType<typeof createMockLLMWiring>;
  let executor: RoutingExecutor;

  beforeEach(() => {
    ctx = createMockExecutorContext();
    llmWiring = createMockLLMWiring();
    executor = new RoutingExecutor(ctx, llmWiring);
  });

  // -------------------------------------------------------------------------
  // 1. Concurrent guard prevents overlapping fan-out from same session
  // -------------------------------------------------------------------------
  it('concurrent guard prevents overlapping fan-out from same session', async () => {
    const session = createMockSession();

    // Access the private _activeFanOutSessions set and pre-add the session
    const activeSessions = (executor as any)._activeFanOutSessions as Set<string>;
    activeSessions.add(session.id);

    const result = await executor.handleFanOut(session, {
      tasks: [{ target: 'FlightAgent', intent: 'find flights' }],
    });

    expect(result.success).toBe(false);
    expect(result.failedCount).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].target).toBe('_guard');
    expect(result.results[0].status).toBe('error');
    expect(result.results[0].error).toContain('Fan-out already in progress');
  });

  // -------------------------------------------------------------------------
  // 2. Concurrent guard released in finally even on error
  // -------------------------------------------------------------------------
  it('concurrent guard released in finally even on error', async () => {
    const session = createMockSession();

    // Make executeMessage throw to force the error path
    (ctx.executeMessage as any).mockRejectedValue(new Error('execution blew up'));

    const activeSessions = (executor as any)._activeFanOutSessions as Set<string>;

    // Verify session is NOT in the set before call
    expect(activeSessions.has(session.id)).toBe(false);

    // Execute fan-out with agent tasks (which will error)
    await executor.handleFanOut(session, {
      tasks: [{ target: 'FlightAgent', intent: 'find flights' }],
    });

    // After handleFanOut completes (even with errors), the guard must be released
    expect(activeSessions.has(session.id)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 3. All-invalid tasks emit abort trace and return early
  // -------------------------------------------------------------------------
  it('all-invalid tasks emit abort trace and return early', async () => {
    const session = createMockSession();
    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];

    // Use targets that are NOT in the agent registry and NOT tool type
    const result = await executor.handleFanOut(
      session,
      {
        tasks: [
          { target: 'NonExistentAgent1', intent: 'do something' },
          { target: 'NonExistentAgent2', intent: 'do other thing' },
        ],
      },
      undefined,
      (event) => traceEvents.push(event),
    );

    expect(result.success).toBe(false);
    // Both targets should have error results
    expect(result.results.length).toBe(2);
    expect(result.results.every((r) => r.status === 'error')).toBe(true);
    expect(result.results[0].error).toContain('Agent not found');

    // Should emit a fan_out_start trace with abortReason
    const startTrace = traceEvents.find((e) => e.type === 'fan_out_start');
    expect(startTrace).toBeDefined();
    expect(startTrace!.data.abortReason).toBe('all_tasks_invalid');
    expect(startTrace!.data.taskCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 4. Tool task execution error produces per-task error in results
  // -------------------------------------------------------------------------
  it('tool task execution error produces per-task error in results', async () => {
    const session = createMockSession();

    // Provide a toolExecutor that throws
    session.toolExecutor = {
      execute: vi.fn().mockRejectedValue(new Error('tool connection refused')),
    } as any;

    const result = await executor.handleFanOut(session, {
      tasks: [
        { target: 'lookup_flight', intent: 'find flights', type: 'tool', params: { dest: 'NYC' } },
      ],
    });

    // The fan-out should still complete (partial failure)
    expect(result.results).toHaveLength(1);
    expect(result.results[0].target).toBe('lookup_flight');
    expect(result.results[0].status).toBe('error');
    expect(result.results[0].error).toBe('tool connection refused');
  });

  // -------------------------------------------------------------------------
  // 5. Agent task timeout produces per-task error with severed refs
  // -------------------------------------------------------------------------
  it('agent task timeout produces per-task error with severed refs', async () => {
    // Use a very short timeout so the AbortController fires quickly
    const shortTimeoutCtx = createMockExecutorContext({
      config: createMockConfig({ timeoutMs: 50 }),
    });

    // Make executeMessage hang forever (never resolve)
    (shortTimeoutCtx.executeMessage as any).mockImplementation(
      () => new Promise(() => {}), // never resolves
    );

    const shortExecutor = new RoutingExecutor(shortTimeoutCtx, llmWiring);
    const session = createMockSession();

    const result = await shortExecutor.handleFanOut(session, {
      tasks: [{ target: 'FlightAgent', intent: 'find flights' }],
    });

    // The timed-out task should appear as an error
    const flightResult = result.results.find((r) => r.target === 'FlightAgent');
    expect(flightResult).toBeDefined();
    expect(flightResult!.status).toBe('error');
    expect(flightResult!.error).toContain('timed out');
  });

  // -------------------------------------------------------------------------
  // 6. Child threads pruned from session.threads in finally block
  // -------------------------------------------------------------------------
  it('child threads pruned from session.threads in finally block', async () => {
    const session = createMockSession();

    // Record the initial thread count (just the parent)
    const initialThreadCount = session.threads.length;
    expect(initialThreadCount).toBe(1);

    await executor.handleFanOut(session, {
      tasks: [
        { target: 'FlightAgent', intent: 'find flights' },
        { target: 'HotelAgent', intent: 'find hotels' },
      ],
    });

    // After fan-out, child threads should be pruned
    // Only the original parent thread should remain
    expect(session.threads.length).toBe(1);
    expect(session.threads[0].agentName).toBe('SupervisorAgent');
  });

  // -------------------------------------------------------------------------
  // 7. Parent activeThreadIndex re-resolved via object reference
  // -------------------------------------------------------------------------
  it('parent activeThreadIndex re-resolved via object reference', async () => {
    const session = createMockSession();

    // Start with activeThreadIndex = 0
    session.activeThreadIndex = 0;

    await executor.handleFanOut(session, {
      tasks: [{ target: 'FlightAgent', intent: 'find flights' }],
    });

    // After pruning, activeThreadIndex should point to the parent thread
    // The parent thread reference is used to re-resolve the index
    expect(session.activeThreadIndex).toBe(0);
    expect(session.threads[session.activeThreadIndex].agentName).toBe('SupervisorAgent');
  });

  // -------------------------------------------------------------------------
  // 8. Parent activeThreadIndex fallback to name-based lookup
  // -------------------------------------------------------------------------
  it('parent activeThreadIndex fallback to name-based lookup', async () => {
    const session = createMockSession();

    // Create a session with multiple pre-existing threads
    // Add a second parent-level thread before the one that will be active
    const secondThread = {
      agentName: 'OtherAgent',
      agentIR: null,
      conversationHistory: [],
      state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
      data: { values: {}, gatheredKeys: new Set<string>() },
      startedAt: Date.now(),
      returnExpected: false,
      status: 'active' as const,
    };
    session.threads.push(secondThread);
    session.activeThreadIndex = 0;

    await executor.handleFanOut(session, {
      tasks: [{ target: 'FlightAgent', intent: 'find flights' }],
    });

    // After cleanup, the parent thread should still be found
    const parentThread = session.threads.find((t) => t.agentName === 'SupervisorAgent');
    expect(parentThread).toBeDefined();
    expect(session.activeThreadIndex).toBe(
      session.threads.findIndex((t) => t.agentName === 'SupervisorAgent'),
    );
  });

  // -------------------------------------------------------------------------
  // 9. Result stored in _last_fan_out and _fan_out_result_{target}
  // -------------------------------------------------------------------------
  it('result stored in _last_fan_out and _fan_out_result_{target}', async () => {
    const session = createMockSession();

    // Make one agent succeed and have the other agent not exist (to produce error)
    const customCtx = createMockExecutorContext({
      agentRegistry: createMockAgentRegistry({
        FlightAgent: {},
      }),
    });
    (customCtx.executeMessage as any).mockResolvedValue({
      response: 'Found 3 flights to Paris',
      action: { type: 'respond' },
    });

    const customExecutor = new RoutingExecutor(customCtx, llmWiring);

    await customExecutor.handleFanOut(session, {
      tasks: [
        { target: 'FlightAgent', intent: 'find flights' },
        { target: 'MissingAgent', intent: 'do something' },
      ],
    });

    const currentThread = getActiveThread(session);

    // Check _last_fan_out
    const lastFanOut = currentThread.data.values._last_fan_out as any;
    expect(lastFanOut).toBeDefined();
    expect(lastFanOut.timestamp).toBeGreaterThan(0);
    expect(lastFanOut.results).toBeInstanceOf(Array);

    // Check per-target results
    // MissingAgent should have an error result stored
    const missingResult = currentThread.data.values._fan_out_result_MissingAgent;
    expect(missingResult).toBeDefined();
    expect(typeof missingResult).toBe('string');
    expect(missingResult as string).toContain('Agent not found');
  });

  // -------------------------------------------------------------------------
  // 10. Deduplication merges intent strings with semicolon separator
  // -------------------------------------------------------------------------
  it('deduplication merges intent strings with semicolon separator', () => {
    const tasks: FanOutTask[] = [
      { target: 'FlightAgent', intent: 'find flights', type: 'agent' },
      { target: 'FlightAgent', intent: 'check prices', type: 'agent' },
      { target: 'HotelAgent', intent: 'find hotels', type: 'agent' },
    ];

    const deduped = deduplicateFanOutTasks(tasks);

    expect(deduped).toHaveLength(2);

    const flightTask = deduped.find((t) => t.target === 'FlightAgent');
    expect(flightTask).toBeDefined();
    expect(flightTask!.intent).toBe('find flights; check prices');

    const hotelTask = deduped.find((t) => t.target === 'HotelAgent');
    expect(hotelTask).toBeDefined();
    expect(hotelTask!.intent).toBe('find hotels');
  });

  // -------------------------------------------------------------------------
  // 11. Tool tasks routed to toolExecutor, agent tasks to executionRuntime
  // -------------------------------------------------------------------------
  it('tool tasks routed to toolExecutor, agent tasks to executionRuntime', async () => {
    const session = createMockSession();

    const toolExecuteSpy = vi.fn().mockResolvedValue('tool result data');
    session.toolExecutor = { execute: toolExecuteSpy } as any;

    // ctx.executeMessage is already mocked for agent execution
    const executeMessageSpy = ctx.executeMessage as ReturnType<typeof vi.fn>;

    const result = await executor.handleFanOut(session, {
      tasks: [
        { target: 'lookup_price', intent: 'get price', type: 'tool', params: { item: 'widget' } },
        { target: 'FlightAgent', intent: 'find flights', type: 'agent' },
      ],
    });

    // Tool task should have been routed to toolExecutor
    expect(toolExecuteSpy).toHaveBeenCalledWith(
      'lookup_price',
      { item: 'widget' },
      expect.any(Number),
    );

    // Agent task should have been routed through executeMessage (via executionRuntime)
    expect(executeMessageSpy).toHaveBeenCalled();

    // Both results should be present
    expect(result.results.length).toBe(2);

    const toolResult = result.results.find((r) => r.target === 'lookup_price');
    expect(toolResult).toBeDefined();
    expect(toolResult!.status).toBe('completed');

    const agentResult = result.results.find((r) => r.target === 'FlightAgent');
    expect(agentResult).toBeDefined();
  });
});
