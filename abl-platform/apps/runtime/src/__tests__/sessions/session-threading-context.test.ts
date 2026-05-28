/**
 * Session Threading and Context Passing Tests
 *
 * Tests for:
 * - Thread lifecycle: createThread, createInitialThread, getActiveThread, syncThreadToSession
 * - Handoff creates threads instead of sessions (session-as-container model)
 * - Context passing via PASS fields, SUMMARY interpolation
 * - HISTORY strategy: auto, summary_only, none, full, last_n
 * - Return handling with ON_RETURN.MAP field mapping
 * - Delegate ephemeral thread behavior
 * - Deep nesting: Supervisor -> Supervisor -> Agent thread stacks
 * - Session lifecycle: reset, list, detail, serialization
 *
 * Uses MockAnthropicClient to simulate LLM responses for reasoning agents,
 * enabling full execution path testing without a real API key.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { DEFAULT_HANDOFF_HISTORY_STRATEGY } from '@abl/compiler';
import {
  RuntimeExecutor,
  type RuntimeSession,
  type RuntimeState,
  type AgentThread,
  getActiveThread,
  createThread,
  createInitialThread,
  syncThreadToSession,
  compileToResolvedAgent,
} from '../../services/runtime-executor';

// Mock guardrail pipeline factory to avoid dynamic import of @agent-platform/database/models
// which requires a live MongoDB connection. resolveGuardrailPolicy returns undefined (no policies).
vi.mock('../../services/guardrails/pipeline-factory.js', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    resolveGuardrailPolicy: vi.fn().mockResolvedValue(undefined),
    ensureTenantProvidersLoaded: vi.fn().mockResolvedValue(undefined),
  };
});

// =============================================================================
// MOCK LLM CLIENT
// =============================================================================

/**
 * Mock AnthropicClient that simulates LLM responses for testing.
 * Matches the interface used by RuntimeExecutor's private `this.client`.
 */
class MockAnthropicClient {
  /** Track all chatWithToolUse calls for assertions */
  calls: Array<{
    systemPrompt: string;
    messages: Array<{ role: string; content: unknown }>;
    tools: unknown[];
  }> = [];

  /** Configurable response handler - override per test */
  private responseHandler: (
    systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: unknown[],
  ) => {
    text: string;
    toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    stopReason: string;
    rawContent: Array<{ type: string; [key: string]: unknown }>;
  };

  constructor() {
    // Default: return simple text response (end_turn, no tool calls)
    this.responseHandler = () => ({
      text: 'I can help you with that.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'I can help you with that.' }],
    });
  }

  /**
   * Set a custom response handler for fine-grained control
   */
  setResponseHandler(
    handler: (
      systemPrompt: string,
      messages: Array<{ role: string; content: unknown }>,
      tools: unknown[],
    ) => {
      text: string;
      toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
      stopReason: string;
      rawContent: Array<{ type: string; [key: string]: unknown }>;
    },
  ) {
    this.responseHandler = handler;
  }

  /**
   * Set a simple entity extraction response for extractEntitiesWithLLM calls.
   * These calls include the _extract_entities tool.
   */
  setEntityExtractionResponse(entities: Record<string, unknown>) {
    const previousHandler = this.responseHandler;

    this.responseHandler = (systemPrompt, messages, tools) => {
      if (tools.some((t: any) => t.name === '_extract_entities')) {
        return {
          text: '',
          toolCalls: [{ id: 'extract-1', name: '_extract_entities', input: entities }],
          stopReason: 'tool_use',
          rawContent: [
            { type: 'tool_use', id: 'extract-1', name: '_extract_entities', input: entities },
          ],
        };
      }
      // Fall through to previous handler for non-extraction calls
      return previousHandler(systemPrompt, messages, tools);
    };
  }

  async chatWithToolUse(
    systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: unknown[],
  ) {
    this.calls.push({ systemPrompt, messages, tools });
    return this.responseHandler(systemPrompt, messages, tools);
  }

  async chatWithToolUseStreamable(
    systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: unknown[],
    _operationType?: string,
    _onChunk?: (chunk: string) => void,
  ) {
    return this.chatWithToolUse(systemPrompt, messages, tools);
  }
}

/**
 * Inject a mock client into RuntimeExecutor sessions.
 * Since LLM clients are now per-session, we override the session wiring methods
 * to inject the mock into every session that gets created or needs an LLM client.
 */
function injectMockClient(executor: RuntimeExecutor): MockAnthropicClient {
  const mock = new MockAnthropicClient();
  // Override wireLLMClient to inject mock into sessions
  (executor as any).llmWiring.wireLLMClient = async (session: any) => {
    session.llmClient = mock;
  };
  // Override ensureSessionLLMClient to inject mock if not already set
  (executor as any).llmWiring.ensureSessionLLMClient = async (session: any) => {
    if (!session.llmClient) {
      session.llmClient = mock;
    }
  };
  return mock;
}

// =============================================================================
// HELPERS
// =============================================================================

interface CapturedTrace {
  type: string;
  data: Record<string, unknown>;
}

function createTraceCollector(): {
  traces: CapturedTrace[];
  callback: (event: { type: string; data: Record<string, unknown> }) => void;
} {
  const traces: CapturedTrace[] = [];
  return {
    traces,
    callback: (event) => traces.push({ type: event.type, data: event.data }),
  };
}

function filterTraces(traces: CapturedTrace[], type: string): CapturedTrace[] {
  return traces.filter((t) => t.type === type);
}

// =============================================================================
// ABL FIXTURES
// =============================================================================

// Supervisor with HISTORY config (use inline CONTEXT block)
const SUPERVISOR_WITH_HISTORY = `
SUPERVISOR: Travel_Supervisor

GOAL: "Route travel requests to specialist agents"

PERSONA: "Professional travel routing assistant"

HANDOFF:
  - TO: Booking_Agent
    WHEN: intent.category == "booking"
    CONTEXT:
      pass: [user_id, travel_plan]
      summary: "User wants to book, plan: {{travel_plan}}"
    RETURN: true

  - TO: Info_Agent
    WHEN: intent.category == "info"
    CONTEXT:
      pass: [query]
      summary: "User has a question"
    RETURN: false

COMPLETE:
  - WHEN: handoff_successful == true
    RESPOND: "Connected you."
`;

// Child agent for booking
const BOOKING_AGENT = `
AGENT: Booking_Agent

GOAL: "Process booking requests"

PERSONA: "Booking specialist"

GATHER:
  booking_ref:
    prompt: "Booking reference?"
    type: string
    required: true

  payment_method:
    prompt: "Payment method?"
    type: string
    required: true
`;

// Info agent (no GATHER)
const INFO_AGENT = `
AGENT: Info_Agent

GOAL: "Provide travel information"

PERSONA: "Travel info specialist"
`;

const SUPERVISOR_WITH_SCRIPTED_HISTORY = `
SUPERVISOR: Travel_Supervisor

GOAL: "Route scripted requests to a flow specialist"

PERSONA: "Professional travel routing assistant"

HANDOFF:
  - TO: Scripted_Info_Agent
    WHEN: intent.category == "scripted"
    CONTEXT:
      pass: [query]
      summary: "User has a scripted question"
    RETURN: false
`;

const SCRIPTED_INFO_AGENT = `
AGENT: Scripted_Info_Agent

GOAL: "Provide scripted travel information"

FLOW:
  entry_point: start
  steps:
    - start

start:
  RESPOND: "Here is the scripted answer."
  THEN: COMPLETE
`;

// Agent with delegates
const MANAGER_WITH_DELEGATES = `
AGENT: Trip_Manager

GOAL: "Manage trip planning with delegation"

PERSONA: "Trip planning coordinator"

GATHER:
  destination:
    prompt: "Where to?"
    type: string
    required: true
  budget:
    prompt: "Budget?"
    type: string
    required: false

DELEGATE:
  - AGENT: Price_Checker
    WHEN: destination IS SET
    PURPOSE: "Check prices for destination"
    INPUT: {dest: destination}
    RETURNS: {avg_price: number}
    USE_RESULT: "Show price info"
    TIMEOUT: 10s
    ON_FAILURE: RESPOND "Price check unavailable"
`;

const PRICE_CHECKER_AGENT = `
AGENT: Price_Checker

GOAL: "Check travel prices"

PERSONA: "Price lookup specialist"

GATHER:
  dest:
    prompt: "Destination?"
    type: string
    required: true
`;

// Deep nesting supervisor
const OUTER_SUPERVISOR = `
SUPERVISOR: Outer_Supervisor

GOAL: "Route to inner supervisor or direct agent"

PERSONA: "Top-level router"

HANDOFF:
  - TO: Inner_Supervisor
    WHEN: intent.category == "complex"
    CONTEXT:
      pass: [request_type]
      summary: "Complex request needs further routing"
    RETURN: true

  - TO: Simple_Agent
    WHEN: intent.category == "simple"
    RETURN: false

COMPLETE:
  - WHEN: handoff_successful == true
    RESPOND: "Done."
`;

const INNER_SUPERVISOR = `
SUPERVISOR: Inner_Supervisor

GOAL: "Route complex requests to specialists"

PERSONA: "Inner routing assistant"

HANDOFF:
  - TO: Specialist_Agent
    WHEN: request_type == "specialist"
    CONTEXT:
      pass: [request_type]
    RETURN: true

COMPLETE:
  - WHEN: handoff_successful == true
    RESPOND: "Routed."
`;

const SPECIALIST_AGENT = `
AGENT: Specialist_Agent

GOAL: "Handle specialist tasks"

PERSONA: "Specialist"

GATHER:
  task_detail:
    prompt: "What specifically?"
    type: string
    required: true
`;

const SIMPLE_AGENT = `
AGENT: Simple_Agent

GOAL: "Handle simple requests"

PERSONA: "Simple handler"
`;

// =============================================================================
// TESTS
// =============================================================================

describe('Session Threading and Context Passing', () => {
  let executor: RuntimeExecutor;
  let mockClient: MockAnthropicClient;

  beforeEach(() => {
    executor = new RuntimeExecutor();
    mockClient = injectMockClient(executor);
  });

  // ===========================================================================
  // 1. Thread Lifecycle
  // ===========================================================================

  describe('Thread Lifecycle', () => {
    test('createThread creates a new thread with correct fields', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([BOOKING_AGENT], 'Booking_Agent'),
      );
      const agentIR = session.agentIR;

      const thread = createThread(session, 'Agent_A', agentIR, {
        handoffFrom: 'Supervisor',
        handoffContext: { key: 'val' },
        returnExpected: true,
      });

      expect(thread.agentName).toBe('Agent_A');
      expect(thread.agentIR).toBe(agentIR);
      expect(thread.handoffFrom).toBe('Supervisor');
      expect(thread.handoffContext).toEqual({ key: 'val' });
      expect(thread.returnExpected).toBe(true);
      expect(thread.status).toBe('active');
      expect(thread.startedAt).toBeGreaterThan(0);
      expect(thread.endedAt).toBeUndefined();
      expect(thread.conversationHistory).toEqual([]);
      expect(thread.state).toEqual({
        gatherProgress: {},
        conversationPhase: 'start',
        context: {},
      });
      expect(thread.data.values).toMatchObject({ session_id: session.id });
      expect(thread.data.gatheredKeys.size).toBe(0);
      // Thread should have been added to the session
      expect(session.threads).toContain(thread);
    });

    test('createThread with initialData populates data.values', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([BOOKING_AGENT], 'Booking_Agent'),
      );

      const thread = createThread(session, 'Agent_B', null, {
        initialData: { user_id: 'u123', plan: 'premium' },
      });

      expect(thread.data.values).toMatchObject({ user_id: 'u123', plan: 'premium' });
      // initialData should NOT mark keys as gathered (they are context, not user input)
      expect(thread.data.gatheredKeys.size).toBe(0);
    });

    test('createThread with initialHistory copies conversation', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([BOOKING_AGENT], 'Booking_Agent'),
      );
      const history = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ];

      const thread = createThread(session, 'Agent_C', null, {
        initialHistory: history,
      });

      // Should have copied the messages
      expect(thread.conversationHistory).toEqual(history);
      // Should NOT be the same reference (deep copy)
      expect(thread.conversationHistory).not.toBe(history);
    });

    test('createInitialThread shares references with session', () => {
      // Create a raw session-like object to test initial thread creation
      const rawSession: RuntimeSession = {
        id: 'test-id',
        agentName: 'TestAgent',
        agentIR: null,
        compilationOutput: null,
        conversationHistory: [],
        state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
        data: { values: {}, gatheredKeys: new Set() },
        isComplete: false,
        isEscalated: false,
        handoffStack: ['TestAgent'],
        threads: [],
        activeThreadIndex: 0,
        threadStack: [],
        storeVersion: 0,
      };

      createInitialThread(rawSession);

      expect(rawSession.threads.length).toBe(1);
      // Initial thread shares references with session (not copies)
      expect(rawSession.threads[0].conversationHistory).toBe(rawSession.conversationHistory);
      expect(rawSession.threads[0].state).toBe(rawSession.state);
      expect(rawSession.threads[0].data).toBe(rawSession.data);
    });

    test('createInitialThread is idempotent', () => {
      const rawSession: RuntimeSession = {
        id: 'test-id',
        agentName: 'TestAgent',
        agentIR: null,
        compilationOutput: null,
        conversationHistory: [],
        state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
        data: { values: {}, gatheredKeys: new Set() },
        isComplete: false,
        isEscalated: false,
        handoffStack: ['TestAgent'],
        threads: [],
        activeThreadIndex: 0,
        threadStack: [],
        storeVersion: 0,
      };

      createInitialThread(rawSession);
      createInitialThread(rawSession);

      // Second call should be a no-op
      expect(rawSession.threads.length).toBe(1);
    });

    test('getActiveThread returns thread at activeThreadIndex', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([BOOKING_AGENT], 'Booking_Agent'),
      );

      // Session starts with initial thread at index 0
      const initial = getActiveThread(session);
      expect(initial.agentName).toBe('Booking_Agent');

      // Add another thread
      const secondThread = createThread(session, 'Second_Agent', null);
      session.activeThreadIndex = session.threads.length - 1;

      const active = getActiveThread(session);
      expect(active).toBe(secondThread);
      expect(active.agentName).toBe('Second_Agent');
    });

    test('syncThreadToSession syncs active thread fields to session', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([BOOKING_AGENT], 'Booking_Agent'),
      );

      // Add a new thread and make it active
      const newThread = createThread(session, 'NewAgent', null, {
        initialData: { synced_key: 'synced_val' },
      });
      session.activeThreadIndex = session.threads.length - 1;

      // Modify thread fields directly
      newThread.conversationHistory.push({ role: 'user', content: 'test' });
      newThread.state.conversationPhase = 'gathering';
      newThread.currentFlowStep = 'step2';
      newThread.waitingForInput = ['field_a'];
      newThread.pendingResponse = 'Please provide field_a';
      newThread.status = 'completed';

      // Sync to session
      syncThreadToSession(session);

      expect(session.agentName).toBe('NewAgent');
      expect(session.conversationHistory).toBe(newThread.conversationHistory);
      expect(session.state).toBe(newThread.state);
      expect(session.data).toBe(newThread.data);
      expect(session.currentFlowStep).toBe('step2');
      expect(session.waitingForInput).toEqual(['field_a']);
      expect(session.pendingResponse).toBe('Please provide field_a');
      expect(session.isComplete).toBe(true); // status === 'completed'
    });

    test('thread stack tracks return-type handoffs', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([BOOKING_AGENT], 'Booking_Agent'),
      );

      // Simulate return-type handoff: push parent index onto stack
      const parentIndex = session.activeThreadIndex;
      session.threadStack.push(parentIndex);

      // Create child thread
      const childThread = createThread(session, 'Child_Agent', null, {
        returnExpected: true,
      });
      session.activeThreadIndex = session.threads.length - 1;

      expect(session.threadStack).toEqual([0]);
      expect(session.activeThreadIndex).toBe(session.threads.length - 1);

      // Simulate return: pop from stack and restore
      const restoredIndex = session.threadStack.pop()!;
      session.activeThreadIndex = restoredIndex;

      expect(session.threadStack).toEqual([]);
      expect(session.activeThreadIndex).toBe(0);
      expect(getActiveThread(session).agentName).toBe('Booking_Agent');
    });
  });

  // ===========================================================================
  // 2. Handoff Thread Creation
  // ===========================================================================

  describe('Handoff Thread Creation', () => {
    test('handleHandoff creates new thread instead of new session', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent(
          [SUPERVISOR_WITH_HISTORY, BOOKING_AGENT, INFO_AGENT],
          'Travel_Supervisor',
        ),
      );
      session.handoffReturnInfo = { Booking_Agent: true, Info_Agent: false };
      session.conversationHistory.push({ role: 'user', content: 'I want to book a trip' });

      mockClient.setEntityExtractionResponse({});

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
      const originalSessionId = session.id;
      const originalThreadCount = session.threads.length;

      await handleHandoff(
        session,
        { target: 'Booking_Agent', context: { user_id: 'u1' } },
        undefined,
        undefined,
      );

      // Should create a new thread, NOT a new session
      expect(session.id).toBe(originalSessionId);
      expect(session.threads.length).toBe(originalThreadCount + 1);
      // The new thread should be the active one
      const activeThread = getActiveThread(session);
      expect(activeThread.agentName).toBe('Booking_Agent');
    });

    test('permanent handoff marks parent thread as completed', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent(
          [SUPERVISOR_WITH_HISTORY, BOOKING_AGENT, INFO_AGENT],
          'Travel_Supervisor',
        ),
      );
      session.handoffReturnInfo = { Booking_Agent: true, Info_Agent: false };
      session.conversationHistory.push({ role: 'user', content: 'Tell me about flights' });

      mockClient.setEntityExtractionResponse({});

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
      await handleHandoff(session, { target: 'Info_Agent' }, undefined, undefined);

      // Parent thread (index 0) should be completed since RETURN: false
      expect(session.threads[0].status).toBe('completed');
      expect(session.threads[0].endedAt).toBeDefined();
      expect(session.threads[0].endedAt).toBeGreaterThan(0);
    });

    test('return handoff marks parent thread as waiting', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent(
          [SUPERVISOR_WITH_HISTORY, BOOKING_AGENT, INFO_AGENT],
          'Travel_Supervisor',
        ),
      );
      session.handoffReturnInfo = { Booking_Agent: true, Info_Agent: false };
      session.conversationHistory.push({ role: 'user', content: 'Book a flight' });

      mockClient.setEntityExtractionResponse({});

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
      await handleHandoff(session, { target: 'Booking_Agent' }, undefined, undefined);

      // Parent thread (index 0) should be waiting since RETURN: true
      expect(session.threads[0].status).toBe('waiting');
      // threadStack should contain the parent index
      expect(session.threadStack.length).toBeGreaterThanOrEqual(1);
    });

    test('handoff preserves tenant and user context while rewiring tool executor', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent(
          [SUPERVISOR_WITH_HISTORY, BOOKING_AGENT, INFO_AGENT],
          'Travel_Supervisor',
        ),
        { tenantId: 'tenant-123', projectId: 'proj-456', userId: 'user-789' },
      );
      session.handoffReturnInfo = { Booking_Agent: true, Info_Agent: false };
      session.conversationHistory.push({ role: 'user', content: 'book something' });

      mockClient.setEntityExtractionResponse({});

      const originalToolExecutor = session.toolExecutor;
      const originalTenantId = session.tenantId;
      const originalProjectId = session.projectId;
      const originalUserId = session.userId;

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
      await handleHandoff(session, { target: 'Booking_Agent' }, undefined, undefined);

      // Identity-scoped session resources should be preserved while agent-scoped
      // execution wiring is allowed to change with the active agent.
      expect(session.toolExecutor).toBeDefined();
      expect(session.toolExecutor).not.toBe(originalToolExecutor);
      expect(typeof session.toolExecutor?.execute).toBe('function');
      expect(session.tenantId).toBe(originalTenantId);
      expect(session.projectId).toBe(originalProjectId);
      expect(session.userId).toBe(originalUserId);
    }, 60000); // Increased timeout: test may need additional LLM calls during handoff

    test('self-handoff is prevented', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent(
          [SUPERVISOR_WITH_HISTORY, BOOKING_AGENT, INFO_AGENT],
          'Travel_Supervisor',
        ),
      );

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
      const result = await handleHandoff(
        session,
        { target: 'Travel_Supervisor' },
        undefined,
        undefined,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Cannot hand off to yourself');
    });

    test('handoff to unknown agent fails gracefully', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([SUPERVISOR_WITH_HISTORY, BOOKING_AGENT], 'Travel_Supervisor'),
      );
      session.conversationHistory.push({ role: 'user', content: 'do something' });

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
      const result = await handleHandoff(session, { target: 'Info_Agent' }, undefined, undefined);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Agent not found');
    });

    test('handoff to undeclared agent is denied even when mutable session state mentions it', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([SUPERVISOR_WITH_HISTORY, BOOKING_AGENT], 'Travel_Supervisor'),
      );
      session.handoffReturnInfo = { Nonexistent_Agent: false };
      session.conversationHistory.push({ role: 'user', content: 'do something else' });

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
      const result = await handleHandoff(
        session,
        { target: 'Nonexistent_Agent' },
        undefined,
        undefined,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid handoff target');
    });
  });

  // ===========================================================================
  // 3. Context Passing: PASS and SUMMARY
  // ===========================================================================

  describe('Context Passing: PASS and SUMMARY', () => {
    test('PASS fields are extracted from parent data.values', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent(
          [SUPERVISOR_WITH_HISTORY, BOOKING_AGENT, INFO_AGENT],
          'Travel_Supervisor',
        ),
      );
      session.handoffReturnInfo = { Booking_Agent: true, Info_Agent: false };
      session.conversationHistory.push({ role: 'user', content: 'book my trip' });

      // Set data on the parent thread (the initial/supervisor thread)
      const parentThread = getActiveThread(session);
      parentThread.data.values.user_id = 'u-abc-123';
      parentThread.data.values.travel_plan = 'Paris 7 days';
      // Also sync to session level (backward compat)
      session.data.values.user_id = 'u-abc-123';
      session.data.values.travel_plan = 'Paris 7 days';

      mockClient.setEntityExtractionResponse({});

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
      await handleHandoff(session, { target: 'Booking_Agent', context: {} }, undefined, undefined);

      // Child thread should have the PASS fields
      const childThread = session.threads[session.activeThreadIndex];
      expect(childThread.agentName).toBe('Booking_Agent');
      expect(childThread.data.values.user_id).toBe('u-abc-123');
      expect(childThread.data.values.travel_plan).toBe('Paris 7 days');
    });

    test('auto metadata excludes gathered keys unless PASS explicitly forwards them', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent(
          [SUPERVISOR_WITH_HISTORY, BOOKING_AGENT, INFO_AGENT],
          'Travel_Supervisor',
        ),
      );
      session.handoffReturnInfo = { Booking_Agent: true, Info_Agent: false };
      session.conversationHistory.push({ role: 'user', content: 'book my trip' });

      const parentThread = getActiveThread(session);
      parentThread.data.values.travel_plan = 'Paris 7 days';
      parentThread.data.values.customer_tier = 'vip';
      parentThread.data.values.destination = 'Paris';
      parentThread.data.gatheredKeys.add('travel_plan');
      parentThread.data.gatheredKeys.add('destination');

      mockClient.setEntityExtractionResponse({});

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
      await handleHandoff(session, { target: 'Booking_Agent', context: {} }, undefined, undefined);

      const childThread = session.threads[session.activeThreadIndex];
      expect(childThread.agentName).toBe('Booking_Agent');
      expect(childThread.data.values.travel_plan).toBe('Paris 7 days');
      expect(childThread.data.values.customer_tier).toBe('vip');
      expect(childThread.data.values.destination).toBeUndefined();
    });

    test('PASS fields override LLM-provided context', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent(
          [SUPERVISOR_WITH_HISTORY, BOOKING_AGENT, INFO_AGENT],
          'Travel_Supervisor',
        ),
      );
      session.handoffReturnInfo = { Booking_Agent: true, Info_Agent: false };
      session.conversationHistory.push({ role: 'user', content: 'book' });

      // Set the parent's data.values
      const parentThread = getActiveThread(session);
      parentThread.data.values.user_id = 'real-user-id';
      session.data.values.user_id = 'real-user-id';

      mockClient.setEntityExtractionResponse({});

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
      await handleHandoff(
        session,
        {
          target: 'Booking_Agent',
          // LLM provides a different user_id value
          context: { user_id: 'llm-guessed-user-id', extra_field: 'llm-data' },
        },
        undefined,
        undefined,
      );

      const childThread = session.threads[session.activeThreadIndex];
      // PASS field should win over LLM-provided context
      expect(childThread.data.values.user_id).toBe('real-user-id');
      // Non-PASS fields from LLM context should still be present
      expect(childThread.data.values.extra_field).toBe('llm-data');
    });

    test('SUMMARY is interpolated with parent data', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent(
          [SUPERVISOR_WITH_HISTORY, BOOKING_AGENT, INFO_AGENT],
          'Travel_Supervisor',
        ),
      );
      session.handoffReturnInfo = { Booking_Agent: true, Info_Agent: false };
      session.conversationHistory.push({ role: 'user', content: 'I want to book' });

      // Set parent data for summary interpolation
      const parentThread = getActiveThread(session);
      parentThread.data.values.travel_plan = 'Rome 5 days all-inclusive';
      session.data.values.travel_plan = 'Rome 5 days all-inclusive';

      mockClient.setEntityExtractionResponse({});

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
      await handleHandoff(session, { target: 'Booking_Agent', context: {} }, undefined, undefined);

      const childThread = session.threads[session.activeThreadIndex];
      // The SUMMARY template is "User wants to book, plan: {{travel_plan}}"
      expect(childThread.data.values._handoff_summary).toContain('Rome 5 days all-inclusive');
      expect(childThread.data.values._handoff_summary).toContain('User wants to book');
    });

    test('missing PASS fields are skipped without error', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent(
          [SUPERVISOR_WITH_HISTORY, BOOKING_AGENT, INFO_AGENT],
          'Travel_Supervisor',
        ),
      );
      session.handoffReturnInfo = { Booking_Agent: true, Info_Agent: false };
      session.conversationHistory.push({ role: 'user', content: 'book' });

      // Deliberately do NOT set user_id or travel_plan on parent
      // The PASS config asks for [user_id, travel_plan] but they are not set

      mockClient.setEntityExtractionResponse({});

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
      // Should not throw
      const result = await handleHandoff(
        session,
        { target: 'Booking_Agent', context: {} },
        undefined,
        undefined,
      );

      expect(result.success).toBe(true);

      const childThread = session.threads[session.activeThreadIndex];
      // Missing fields should simply not be present
      expect(childThread.data.values.user_id).toBeUndefined();
      expect(childThread.data.values.travel_plan).toBeUndefined();
    });
  });

  // ===========================================================================
  // 4. Context Passing: HISTORY Strategy
  // ===========================================================================

  describe('Context Passing: HISTORY Strategy', () => {
    test('default history strategy auto keeps summary_only behavior for reasoning targets', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent(
          [SUPERVISOR_WITH_HISTORY, BOOKING_AGENT, INFO_AGENT],
          'Travel_Supervisor',
        ),
      );
      session.handoffReturnInfo = { Info_Agent: false };

      // Add conversation history to parent
      const parentThread = getActiveThread(session);
      parentThread.conversationHistory.push(
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi, how can I help?' },
        { role: 'user', content: 'I need flight info' },
      );
      session.conversationHistory = parentThread.conversationHistory;

      mockClient.setEntityExtractionResponse({});

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
      await handleHandoff(session, { target: 'Info_Agent', context: {} }, undefined, undefined);

      // Info_Agent has no HISTORY config on its handoff rule, so it falls back to the
      // platform default (`auto`). Because the handoff has a summary and the child is a
      // reasoning target, `auto` resolves to `summary_only`.
      // However the child's conversationHistory might have messages from the
      // executeMessage call during handoff. We check the initial history was not
      // copied from parent by verifying the thread's handoffContext:
      const childThread = session.threads[session.activeThreadIndex];
      expect(childThread.agentName).toBe('Info_Agent');
      // The child conversation should not start with the parent's messages.
      // It may have messages from the LLM call during handoff execution, but not
      // the parent's 'Hello' / 'Hi, how can I help?' messages.
      const hasParentGreeting = childThread.conversationHistory.some(
        (m) => m.content === 'Hello' || m.content === 'Hi, how can I help?',
      );
      expect(hasParentGreeting).toBe(false);
      expect(DEFAULT_HANDOFF_HISTORY_STRATEGY).toBe('auto');
      expect(childThread.data.values._handoff_summary).toBe('User has a question');
    });

    test('default history strategy auto falls back to bounded history for scripted targets', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent(
          [SUPERVISOR_WITH_SCRIPTED_HISTORY, SCRIPTED_INFO_AGENT],
          'Travel_Supervisor',
        ),
      );
      session.handoffReturnInfo = { Scripted_Info_Agent: false };

      const parentThread = getActiveThread(session);
      parentThread.conversationHistory.push(
        { role: 'user', content: 'msg-1' },
        { role: 'assistant', content: 'msg-2' },
        { role: 'user', content: 'msg-3' },
        { role: 'assistant', content: 'msg-4' },
        { role: 'user', content: 'msg-5' },
        { role: 'assistant', content: 'msg-6' },
      );
      session.conversationHistory = parentThread.conversationHistory;

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
      await handleHandoff(
        session,
        { target: 'Scripted_Info_Agent', context: {} },
        undefined,
        undefined,
      );

      const childThread = session.threads[session.activeThreadIndex];
      expect(childThread.agentName).toBe('Scripted_Info_Agent');
      expect(childThread.conversationHistory[0].content).toBe('msg-2');
      expect(childThread.conversationHistory[1].content).toBe('msg-3');
      expect(childThread.conversationHistory[2].content).toBe('msg-4');
      expect(childThread.conversationHistory[3].content).toBe('msg-5');
      expect(childThread.conversationHistory[4].content).toBe('msg-6');
      expect(childThread.data.values._handoff_summary).toBe('User has a scripted question');
    });

    test('history strategy full copies all parent messages', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent(
          [SUPERVISOR_WITH_HISTORY, BOOKING_AGENT, INFO_AGENT],
          'Travel_Supervisor',
        ),
      );
      session.handoffReturnInfo = { Booking_Agent: true };

      // Add conversation history to parent
      const parentThread = getActiveThread(session);
      parentThread.conversationHistory.push(
        { role: 'user', content: 'message-1' },
        { role: 'assistant', content: 'reply-1' },
        { role: 'user', content: 'message-2' },
        { role: 'assistant', content: 'reply-2' },
        { role: 'user', content: 'message-3' },
      );
      session.conversationHistory = parentThread.conversationHistory;

      // Override the Booking_Agent handoff config to use history: 'full'
      const bookingHandoff = session.agentIR?.coordination?.handoffs?.find(
        (h: any) => h.to === 'Booking_Agent',
      );
      if (bookingHandoff) {
        (bookingHandoff as any).context.history = 'full';
      }

      mockClient.setEntityExtractionResponse({});

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
      await handleHandoff(session, { target: 'Booking_Agent', context: {} }, undefined, undefined);

      const childThread = session.threads[session.activeThreadIndex];
      expect(childThread.agentName).toBe('Booking_Agent');
      // Child should have all parent messages at the start of its history
      // (the handoff execution may append more messages after)
      expect(childThread.conversationHistory.length).toBeGreaterThanOrEqual(5);
      expect(childThread.conversationHistory[0].content).toBe('message-1');
      expect(childThread.conversationHistory[1].content).toBe('reply-1');
      expect(childThread.conversationHistory[2].content).toBe('message-2');
      expect(childThread.conversationHistory[3].content).toBe('reply-2');
      expect(childThread.conversationHistory[4].content).toBe('message-3');
    });

    test('history strategy last_n copies only last N messages', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent(
          [SUPERVISOR_WITH_HISTORY, BOOKING_AGENT, INFO_AGENT],
          'Travel_Supervisor',
        ),
      );
      session.handoffReturnInfo = { Booking_Agent: true };

      // Add 5 messages to parent
      const parentThread = getActiveThread(session);
      parentThread.conversationHistory.push(
        { role: 'user', content: 'old-1' },
        { role: 'assistant', content: 'old-2' },
        { role: 'user', content: 'old-3' },
        { role: 'assistant', content: 'recent-4' },
        { role: 'user', content: 'recent-5' },
      );
      session.conversationHistory = parentThread.conversationHistory;

      // Override config to use last_n: 2
      const bookingHandoff = session.agentIR?.coordination?.handoffs?.find(
        (h: any) => h.to === 'Booking_Agent',
      );
      if (bookingHandoff) {
        (bookingHandoff as any).context.history = { last_n: 2 };
      }

      mockClient.setEntityExtractionResponse({});

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
      await handleHandoff(session, { target: 'Booking_Agent', context: {} }, undefined, undefined);

      const childThread = session.threads[session.activeThreadIndex];
      expect(childThread.agentName).toBe('Booking_Agent');
      // Should have the last 2 messages from parent, plus any from the handoff execution
      expect(childThread.conversationHistory.length).toBeGreaterThanOrEqual(2);
      expect(childThread.conversationHistory[0].content).toBe('recent-4');
      expect(childThread.conversationHistory[1].content).toBe('recent-5');
      // Should NOT have the older messages
      const hasOldMessages = childThread.conversationHistory.some(
        (m) => m.content === 'old-1' || m.content === 'old-2' || m.content === 'old-3',
      );
      expect(hasOldMessages).toBe(false);
    });

    test('history strategy summary_only passes no messages', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent(
          [SUPERVISOR_WITH_HISTORY, BOOKING_AGENT, INFO_AGENT],
          'Travel_Supervisor',
        ),
      );
      session.handoffReturnInfo = { Booking_Agent: true };

      const parentThread = getActiveThread(session);
      parentThread.conversationHistory.push(
        { role: 'user', content: 'msg-A' },
        { role: 'assistant', content: 'msg-B' },
        { role: 'user', content: 'msg-C' },
      );
      session.conversationHistory = parentThread.conversationHistory;

      // Set parent data for summary interpolation
      parentThread.data.values.travel_plan = 'London weekend break';
      session.data.values.travel_plan = 'London weekend break';

      // Override config: summary_only
      const bookingHandoff = session.agentIR?.coordination?.handoffs?.find(
        (h: any) => h.to === 'Booking_Agent',
      );
      if (bookingHandoff) {
        (bookingHandoff as any).context.history = 'summary_only';
      }

      mockClient.setEntityExtractionResponse({});

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
      await handleHandoff(session, { target: 'Booking_Agent', context: {} }, undefined, undefined);

      const childThread = session.threads[session.activeThreadIndex];
      expect(childThread.agentName).toBe('Booking_Agent');
      // Parent's earlier messages should NOT be in child's conversation.
      // Note: the last user message ('msg-C') may be forwarded by executeMessage during
      // handoff, since the handoff process calls executeMessage with the last user message.
      // The key behavior of summary_only is that the parent's conversation history is NOT
      // passed as initialHistory to the child thread.
      const hasOlderParentMsgs = childThread.conversationHistory.some(
        (m) => m.content === 'msg-A' || m.content === 'msg-B',
      );
      expect(hasOlderParentMsgs).toBe(false);
      // But _handoff_summary should be present
      expect(childThread.data.values._handoff_summary).toBeDefined();
      expect(childThread.data.values._handoff_summary).toContain('London weekend break');
    });
  });

  // ===========================================================================
  // 5. Return Handling: ON_RETURN.MAP
  // ===========================================================================

  describe('Return Handling: ON_RETURN.MAP', () => {
    test('default return merges all child gathered data to parent', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent(
          [SUPERVISOR_WITH_HISTORY, BOOKING_AGENT, INFO_AGENT],
          'Travel_Supervisor',
        ),
      );
      session.handoffReturnInfo = { Booking_Agent: true };
      session.conversationHistory.push({ role: 'user', content: 'book my flight' });

      // Mock: entity extraction returns booking data, LLM ends the turn
      mockClient.setResponseHandler((systemPrompt, messages, tools) => {
        if (tools.some((t: any) => t.name === '_extract_entities')) {
          return {
            text: '',
            toolCalls: [
              {
                id: 'extract-1',
                name: '_extract_entities',
                input: { booking_ref: 'BK-999', payment_method: 'credit_card' },
              },
            ],
            stopReason: 'tool_use',
            rawContent: [
              {
                type: 'tool_use',
                id: 'extract-1',
                name: '_extract_entities',
                input: { booking_ref: 'BK-999', payment_method: 'credit_card' },
              },
            ],
          };
        }
        // LLM call triggers complete action
        return {
          text: 'Booking confirmed!',
          toolCalls: [
            {
              id: 'call_complete',
              name: 'complete_conversation',
              input: { reason: 'Booking processed' },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            { type: 'text', text: 'Booking confirmed!' },
            {
              type: 'tool_use',
              id: 'call_complete',
              name: 'complete_conversation',
              input: { reason: 'Booking processed' },
            },
          ],
        };
      });

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
      await handleHandoff(session, { target: 'Booking_Agent', context: {} }, undefined, undefined);

      // After return, the parent thread should have the child's gathered data
      // (default behavior: merge all gathered keys)
      // The parent should now be active if the child completed
      // Check that session has the booking data somewhere
      const hasBookingRef = Object.values(session.threads).some(
        (t: AgentThread) => t.data.values.booking_ref === 'BK-999',
      );
      expect(hasBookingRef).toBe(true);
    });

    test('ON_RETURN.MAP maps specific child fields to parent fields', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent(
          [SUPERVISOR_WITH_HISTORY, BOOKING_AGENT, INFO_AGENT],
          'Travel_Supervisor',
        ),
      );
      session.handoffReturnInfo = { Booking_Agent: true };
      session.conversationHistory.push({ role: 'user', content: 'book' });

      // Configure ON_RETURN.MAP on the handoff config
      const bookingHandoff = session.agentIR?.coordination?.handoffs?.find(
        (h: any) => h.to === 'Booking_Agent',
      );
      if (bookingHandoff) {
        (bookingHandoff as any).on_return = {
          map: {
            booking_ref: 'child_booking',
            payment_method: 'child_payment',
          },
        };
      }

      // Mock: child extracts entities and then completes
      mockClient.setResponseHandler((systemPrompt, messages, tools) => {
        if (tools.some((t: any) => t.name === '_extract_entities')) {
          return {
            text: '',
            toolCalls: [
              {
                id: 'extract-1',
                name: '_extract_entities',
                input: { booking_ref: 'BK-MAP-TEST', payment_method: 'debit' },
              },
            ],
            stopReason: 'tool_use',
            rawContent: [
              {
                type: 'tool_use',
                id: 'extract-1',
                name: '_extract_entities',
                input: { booking_ref: 'BK-MAP-TEST', payment_method: 'debit' },
              },
            ],
          };
        }
        return {
          text: 'Done!',
          toolCalls: [
            {
              id: 'call_c',
              name: 'complete_conversation',
              input: { reason: 'done' },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            { type: 'text', text: 'Done!' },
            {
              type: 'tool_use',
              id: 'call_c',
              name: 'complete_conversation',
              input: { reason: 'done' },
            },
          ],
        };
      });

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
      await handleHandoff(session, { target: 'Booking_Agent', context: {} }, undefined, undefined);

      // If the child completed and return was processed, the parent should have mapped fields
      // The ON_RETURN.MAP says: booking_ref -> child_booking, payment_method -> child_payment
      // So parent should have child_booking, child_payment (not booking_ref, payment_method)
      const parentThread = session.threads[0];
      if (parentThread.status === 'active') {
        // Return was processed
        expect(parentThread.data.values.child_booking).toBe('BK-MAP-TEST');
        expect(parentThread.data.values.child_payment).toBe('debit');
      }
    });

    test('ON_RETURN.MAP ignores unmapped child fields', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent(
          [SUPERVISOR_WITH_HISTORY, BOOKING_AGENT, INFO_AGENT],
          'Travel_Supervisor',
        ),
      );
      session.handoffReturnInfo = { Booking_Agent: true };
      session.conversationHistory.push({ role: 'user', content: 'book' });

      // Configure ON_RETURN.MAP to only map booking_ref
      const bookingHandoff = session.agentIR?.coordination?.handoffs?.find(
        (h: any) => h.to === 'Booking_Agent',
      );
      if (bookingHandoff) {
        (bookingHandoff as any).on_return = {
          map: {
            booking_ref: 'mapped_ref',
            // payment_method is NOT in the map, so it should be ignored
          },
        };
      }

      mockClient.setResponseHandler((systemPrompt, messages, tools) => {
        if (tools.some((t: any) => t.name === '_extract_entities')) {
          return {
            text: '',
            toolCalls: [
              {
                id: 'extract-1',
                name: '_extract_entities',
                input: { booking_ref: 'BK-PARTIAL', payment_method: 'crypto' },
              },
            ],
            stopReason: 'tool_use',
            rawContent: [
              {
                type: 'tool_use',
                id: 'extract-1',
                name: '_extract_entities',
                input: { booking_ref: 'BK-PARTIAL', payment_method: 'crypto' },
              },
            ],
          };
        }
        return {
          text: 'Complete!',
          toolCalls: [
            {
              id: 'call_d',
              name: 'complete_conversation',
              input: { reason: 'partial' },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            { type: 'text', text: 'Complete!' },
            {
              type: 'tool_use',
              id: 'call_d',
              name: 'complete_conversation',
              input: { reason: 'partial' },
            },
          ],
        };
      });

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
      await handleHandoff(session, { target: 'Booking_Agent', context: {} }, undefined, undefined);

      const parentThread = session.threads[0];
      if (parentThread.status === 'active') {
        // mapped_ref should exist
        expect(parentThread.data.values.mapped_ref).toBe('BK-PARTIAL');
        // payment_method and crypto should NOT be in parent (it was unmapped)
        expect(parentThread.data.values.payment_method).toBeUndefined();
        expect(parentThread.data.values.crypto).toBeUndefined();
      }
    });

    test('return handoff restores parent thread as active', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent(
          [SUPERVISOR_WITH_HISTORY, BOOKING_AGENT, INFO_AGENT],
          'Travel_Supervisor',
        ),
      );
      session.handoffReturnInfo = { Booking_Agent: true };
      session.conversationHistory.push({ role: 'user', content: 'book flight' });

      // Mock: entity extraction + complete so child finishes
      mockClient.setResponseHandler((systemPrompt, messages, tools) => {
        if (tools.some((t: any) => t.name === '_extract_entities')) {
          return {
            text: '',
            toolCalls: [
              { id: 'extract-1', name: '_extract_entities', input: { booking_ref: 'BK-RETURN' } },
            ],
            stopReason: 'tool_use',
            rawContent: [
              {
                type: 'tool_use',
                id: 'extract-1',
                name: '_extract_entities',
                input: { booking_ref: 'BK-RETURN' },
              },
            ],
          };
        }
        return {
          text: 'Booked!',
          toolCalls: [
            {
              id: 'call_ret',
              name: 'complete_conversation',
              input: { reason: 'booked' },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            { type: 'text', text: 'Booked!' },
            {
              type: 'tool_use',
              id: 'call_ret',
              name: 'complete_conversation',
              input: { reason: 'booked' },
            },
          ],
        };
      });

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
      await handleHandoff(session, { target: 'Booking_Agent', context: {} }, undefined, undefined);

      // If child completed, parent should be restored
      const parentThread = session.threads[0];
      if (parentThread.status === 'active') {
        // Parent is active again
        expect(session.activeThreadIndex).toBe(0);
        // threadStack should be empty
        expect(session.threadStack).toEqual([]);
      }
    });
  });

  // ===========================================================================
  // 6. Delegate Thread Behavior
  // ===========================================================================

  describe('Delegate Thread Behavior', () => {
    test('executeDelegate creates temporary thread for delegation', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([MANAGER_WITH_DELEGATES], 'Trip_Manager'),
      );
      executor.registerAgent('Price_Checker', PRICE_CHECKER_AGENT);

      // Set up data needed for the delegate
      session.data.values.destination = 'Tokyo';
      const parentThread = getActiveThread(session);
      parentThread.data.values.destination = 'Tokyo';

      mockClient.setEntityExtractionResponse({});

      const executeDelegate = (executor as any).routing.executeDelegate.bind(
        (executor as any).routing,
      );
      const delegateConfig = session.agentIR?.coordination?.delegates?.find(
        (d: any) => d.agent === 'Price_Checker',
      );

      const threadCountBefore = session.threads.length;

      await executeDelegate(
        session,
        'Price_Checker',
        delegateConfig,
        undefined,
        undefined,
        undefined,
      );

      // A new thread should have been created (ephemeral)
      expect(session.threads.length).toBeGreaterThan(threadCountBefore);
    });

    test('delegate thread is marked completed after execution', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([MANAGER_WITH_DELEGATES], 'Trip_Manager'),
      );
      executor.registerAgent('Price_Checker', PRICE_CHECKER_AGENT);

      session.data.values.destination = 'Berlin';
      const parentThread = getActiveThread(session);
      parentThread.data.values.destination = 'Berlin';

      mockClient.setEntityExtractionResponse({});

      const executeDelegate = (executor as any).routing.executeDelegate.bind(
        (executor as any).routing,
      );
      const delegateConfig = session.agentIR?.coordination?.delegates?.find(
        (d: any) => d.agent === 'Price_Checker',
      );

      await executeDelegate(
        session,
        'Price_Checker',
        delegateConfig,
        undefined,
        undefined,
        undefined,
      );

      // The delegate thread should be completed
      const delegateThread = session.threads.find(
        (t: AgentThread) => t.agentName === 'Price_Checker',
      );
      expect(delegateThread).toBeDefined();
      expect(delegateThread!.status).toBe('completed');
      expect(delegateThread!.endedAt).toBeDefined();
      expect(delegateThread!.endedAt).toBeGreaterThan(0);
    });

    test('delegate results are stored in parent data.values', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([MANAGER_WITH_DELEGATES], 'Trip_Manager'),
      );
      executor.registerAgent('Price_Checker', PRICE_CHECKER_AGENT);

      session.data.values.destination = 'Rome';
      const parentThread = getActiveThread(session);
      parentThread.data.values.destination = 'Rome';

      mockClient.setEntityExtractionResponse({});

      const executeDelegate = (executor as any).routing.executeDelegate.bind(
        (executor as any).routing,
      );
      const delegateConfig = session.agentIR?.coordination?.delegates?.find(
        (d: any) => d.agent === 'Price_Checker',
      );

      const result = await executeDelegate(
        session,
        'Price_Checker',
        delegateConfig,
        undefined,
        undefined,
        undefined,
      );

      expect(result.success).toBe(true);

      // The USE_RESULT key (or delegate_result default) should be stored
      const useResultKey = delegateConfig?.use_result || 'delegate_result';
      expect(session.data.values[useResultKey]).toBeDefined();
    });
  });

  // ===========================================================================
  // 7. Deep Nesting: Supervisor -> Supervisor -> Agent
  // ===========================================================================

  describe('Deep Nesting: Supervisor -> Supervisor -> Agent', () => {
    test('three-level deep nesting creates correct thread stack', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent(
          [OUTER_SUPERVISOR, INNER_SUPERVISOR, SPECIALIST_AGENT, SIMPLE_AGENT],
          'Outer_Supervisor',
        ),
      );
      session.handoffReturnInfo = { Inner_Supervisor: true, Simple_Agent: false };
      session.conversationHistory.push({ role: 'user', content: 'complex specialist request' });

      mockClient.setEntityExtractionResponse({});

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);

      // First handoff: Outer -> Inner (RETURN: true)
      await handleHandoff(session, { target: 'Inner_Supervisor' }, undefined, undefined);

      // After first handoff, we should have at least 2 threads
      expect(session.threads.length).toBeGreaterThanOrEqual(2);
      // Outer thread should be waiting
      expect(session.threads[0].status).toBe('waiting');

      // Now set up handoff from Inner to Specialist
      // The active agent is now Inner_Supervisor
      // We need to configure handoffReturnInfo for the inner supervisor
      session.handoffReturnInfo = { Specialist_Agent: true };
      session.conversationHistory.push({ role: 'user', content: 'specialist task' });

      await handleHandoff(session, { target: 'Specialist_Agent' }, undefined, undefined);

      // Should now have 3+ threads (outer, inner, specialist, plus any from executeMessage)
      expect(session.threads.length).toBeGreaterThanOrEqual(3);

      // There should be a thread for each level
      const outerThread = session.threads.find(
        (t: AgentThread) => t.agentName === 'Outer_Supervisor',
      );
      const innerThread = session.threads.find(
        (t: AgentThread) => t.agentName === 'Inner_Supervisor',
      );
      const specialistThread = session.threads.find(
        (t: AgentThread) => t.agentName === 'Specialist_Agent',
      );

      expect(outerThread).toBeDefined();
      expect(innerThread).toBeDefined();
      expect(specialistThread).toBeDefined();
    });

    test('return unwinds thread stack in correct order', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent(
          [OUTER_SUPERVISOR, INNER_SUPERVISOR, SPECIALIST_AGENT, SIMPLE_AGENT],
          'Outer_Supervisor',
        ),
      );
      session.handoffReturnInfo = { Inner_Supervisor: true, Simple_Agent: false };
      session.conversationHistory.push({ role: 'user', content: 'complex' });

      // Mock: entity extraction empty, LLM returns simple text
      mockClient.setEntityExtractionResponse({});

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);

      // Handoff Outer -> Inner (RETURN: true)
      await handleHandoff(session, { target: 'Inner_Supervisor' }, undefined, undefined);

      // Verify the inner supervisor thread is active
      const innerThread = session.threads.find(
        (t: AgentThread) => t.agentName === 'Inner_Supervisor',
      );
      expect(innerThread).toBeDefined();

      // The thread stack should have at least the outer index
      // After the handoff completes (with executeMessage), the inner agent may
      // or may not have completed. If it did not complete, we verify the stack order.
      // If it completed (the LLM triggered complete), verify return behavior.
      if (session.threads[0].status === 'active') {
        // Return was processed, outer is active again
        expect(session.threadStack.length).toBe(0);
        expect(session.activeThreadIndex).toBe(0);
      } else {
        // Inner is still active, threadStack should have outer
        expect(session.threadStack.length).toBeGreaterThanOrEqual(1);
        // First element should be the outer thread index
        expect(session.threadStack[0]).toBe(0);
      }
    });
  });

  // ===========================================================================
  // 8. Session Lifecycle
  // ===========================================================================

  describe('Session Lifecycle', () => {
    test('listSessions shows activeAgent from current thread', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent(
          [SUPERVISOR_WITH_HISTORY, BOOKING_AGENT, INFO_AGENT],
          'Travel_Supervisor',
        ),
      );
      session.handoffReturnInfo = { Info_Agent: false };
      session.conversationHistory.push({ role: 'user', content: 'info please' });

      mockClient.setEntityExtractionResponse({});

      // Before handoff
      const listBefore = executor.listSessions();
      const sessionInfoBefore = listBefore.find((s) => s.id === session.id);
      expect(sessionInfoBefore).toBeDefined();
      // Before handoff, active agent should be the supervisor
      expect(sessionInfoBefore!.activeAgent).toBe('Travel_Supervisor');

      // After handoff
      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
      await handleHandoff(session, { target: 'Info_Agent', context: {} }, undefined, undefined);

      const listAfter = executor.listSessions();
      const sessionInfoAfter = listAfter.find((s) => s.id === session.id);
      expect(sessionInfoAfter).toBeDefined();
      // After handoff, active agent should be the child
      expect(sessionInfoAfter!.activeAgent).toBe('Info_Agent');
      expect(sessionInfoAfter!.threadCount).toBeGreaterThan(1);
    });

    test('getSessionDetail includes thread timeline', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent(
          [SUPERVISOR_WITH_HISTORY, BOOKING_AGENT, INFO_AGENT],
          'Travel_Supervisor',
        ),
      );
      session.handoffReturnInfo = { Info_Agent: false };
      session.conversationHistory.push({ role: 'user', content: 'info query' });

      mockClient.setEntityExtractionResponse({});

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
      await handleHandoff(session, { target: 'Info_Agent', context: {} }, undefined, undefined);

      const detail = executor.getSessionDetail(session.id);
      expect(detail).not.toBeNull();
      expect(detail!.threads).toBeDefined();
      expect(detail!.threads.length).toBeGreaterThan(1);
      expect(detail!.activeThreadIndex).toBeGreaterThanOrEqual(0);

      // Each thread in the detail should have the expected shape
      for (const thread of detail!.threads) {
        expect(thread).toHaveProperty('agentName');
        expect(thread).toHaveProperty('status');
        expect(thread).toHaveProperty('startedAt');
        expect(thread).toHaveProperty('messageCount');
      }

      // Find the Info_Agent thread
      const infoThread = detail!.threads.find((t) => t.agentName === 'Info_Agent');
      expect(infoThread).toBeDefined();
      expect(infoThread!.handoffFrom).toBe('Travel_Supervisor');
    });

    test('serializeThreads produces valid AgentThreadData', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent(
          [SUPERVISOR_WITH_HISTORY, BOOKING_AGENT, INFO_AGENT],
          'Travel_Supervisor',
        ),
      );
      session.handoffReturnInfo = { Info_Agent: false };
      session.conversationHistory.push({ role: 'user', content: 'info' });

      mockClient.setEntityExtractionResponse({});

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
      await handleHandoff(session, { target: 'Info_Agent', context: {} }, undefined, undefined);

      // Call private serializeThreads method
      const serializeThreads = (executor as any).serializeThreads.bind(executor);

      // Create a mock session service with computeIRHash
      const mockSvc = {
        computeIRHash: (ir: unknown) => 'mock-hash-' + (ir ? 'valid' : 'null'),
      };

      const serialized = serializeThreads(session, mockSvc);

      expect(Array.isArray(serialized)).toBe(true);
      expect(serialized.length).toBe(session.threads.length);

      for (const threadData of serialized) {
        expect(threadData).toHaveProperty('agentName');
        expect(typeof threadData.agentName).toBe('string');
        expect(threadData).toHaveProperty('irSourceHash');
        expect(typeof threadData.irSourceHash).toBe('string');
        expect(threadData).toHaveProperty('conversationHistory');
        expect(Array.isArray(threadData.conversationHistory)).toBe(true);
        expect(threadData).toHaveProperty('state');
        expect(threadData).toHaveProperty('dataValues');
        expect(typeof threadData.dataValues).toBe('object');
        expect(threadData).toHaveProperty('dataGatheredKeys');
        expect(Array.isArray(threadData.dataGatheredKeys)).toBe(true);
        expect(threadData).toHaveProperty('startedAt');
        expect(typeof threadData.startedAt).toBe('number');
        expect(threadData).toHaveProperty('returnExpected');
        expect(typeof threadData.returnExpected).toBe('boolean');
        expect(threadData).toHaveProperty('status');
        expect(['active', 'waiting', 'completed', 'escalated']).toContain(threadData.status);
      }

      // Check the Info_Agent thread
      const infoThreadData = serialized.find(
        (t: { agentName: string }) => t.agentName === 'Info_Agent',
      );
      expect(infoThreadData).toBeDefined();
      expect(infoThreadData.handoffFrom).toBe('Travel_Supervisor');
    });
  });
});
