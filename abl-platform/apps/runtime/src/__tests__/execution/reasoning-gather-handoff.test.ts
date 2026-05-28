/**
 * Reasoning Agent Gather, Handoff & Delegate Tests
 *
 * Tests for:
 * - Entity extraction in reasoning mode agents with GATHER fields (LLM-based)
 * - data.values population and dsl_collect event emission
 * - Context data passing during handoff (parent → child)
 * - activeAgent state tracking during handoff
 * - data.values sync from child session back to parent
 * - Delegate context passing and result mapping
 * - Full reasoning agent execution via executeWithTools with mocked LLM
 *
 * Uses a ValidatingMockAnthropicClient to simulate LLM responses for reasoning agents,
 * enabling full execution path testing without a real API key.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import {
  RuntimeExecutor,
  compileToResolvedAgent,
  buildSystemPrompt,
  tryThreadReturn,
  type RuntimeSession,
  type RuntimeState,
} from '../../services/runtime-executor';
import {
  ValidatingValidatingMockAnthropicClient,
  injectValidatingMockClient,
  createTraceCollector,
  filterTraces,
  type CapturedTrace,
} from '../helpers/history-validation';

// =============================================================================
// ABL FIXTURES
// =============================================================================

const REASONING_AGENT_WITH_GATHER = `
AGENT: Sales_Chat

GOAL: "Help users search and book travel packages"

PERSONA: "Friendly travel advisor"

TOOLS:
  search_flights(origin: string, destination: string, date: string) -> {flights: object[], count: number}

GATHER:
  destination:
    prompt: "Where would you like to travel?"
    type: string
    required: true

  travel_date:
    prompt: "When would you like to depart?"
    type: string
    required: true

  num_passengers:
    prompt: "How many passengers?"
    type: number
    required: false
`;

const REASONING_SALES_AGENT = `
AGENT: Sales_Agent

GOAL: "Help users find and book travel deals"

PERSONA: "Expert travel sales agent"

TOOLS:
  search_deals(destination: string, date: string) -> {deals: object[]}

GATHER:
  destination:
    prompt: "Where would you like to go?"
    type: string
    required: true

  departure_date:
    prompt: "When do you want to depart?"
    type: string
    required: true

  budget:
    prompt: "What is your budget?"
    type: string
    required: false
`;

const REASONING_WELCOME_AGENT = `
AGENT: Welcome_Agent

GOAL: "Welcome users and help them get started"

PERSONA: "Friendly greeter"

GATHER:
  user_name:
    prompt: "What is your name?"
    type: string
    required: false
`;

const SUPERVISOR_WITH_HANDOFFS = `
SUPERVISOR: Travel_Supervisor

GOAL: "Route travel requests to specialist agents"

PERSONA: "Professional travel routing assistant"

HANDOFF:
  - TO: Sales_Agent
    WHEN: intent.category == "travel_search"
    EXPERIENCE_MODE: shared_voice_handoff
    CONTEXT:
      pass: [search_context, user_preferences]
      summary: "User looking to book travel"
    RETURN: false

  - TO: Welcome_Agent
    WHEN: intent.category == "greeting"
    EXPERIENCE_MODE: visible_handoff
    CONTEXT:
      pass: [session_context]
      summary: "User greeting"
    RETURN: true

COMPLETE:
  - WHEN: handoff_successful == true
    RESPOND: "Connected you with the right specialist."
`;

const SUPERVISOR_WITH_SILENT_RETURNING_HANDOFF = `
SUPERVISOR: Policy_Supervisor

GOAL: "Collect internal policy advice before answering"

PERSONA: "Customer-facing policy coordinator"

HANDOFF:
  - TO: Internal_Policy_Agent
    WHEN: input contains "policy"
    EXPERIENCE_MODE: silent_delegate
    RETURN: true
`;

const INTERNAL_POLICY_AGENT = `
AGENT: Internal_Policy_Agent

GOAL: "Draft internal policy analysis"

PERSONA: "Internal-only policy specialist"
`;

const AGENT_WITH_DELEGATE = `
AGENT: Booking_Manager

GOAL: "Manage bookings with delegation to fee calculator"

PERSONA: "Booking specialist"

TOOLS:
  get_booking(id: string) -> {booking: object}

GATHER:
  booking_id:
    prompt: "What is your booking reference?"
    type: string
    required: true

  action_type:
    prompt: "What would you like to do?"
    type: string
    required: true

DELEGATE:
  - AGENT: Fee_Calculator
    WHEN: action_type == "modify"
    EXPERIENCE_MODE: silent_delegate
    PURPOSE: "Calculate modification fees"
    INPUT: {booking_id: booking_id, changes: change_details}
    RETURNS: {total_fee: number, breakdown: object[]}
    USE_RESULT: "Show fee breakdown to user"
    TIMEOUT: 10s
    ON_FAILURE: RESPOND "Unable to calculate fees"
`;

const REASONING_FEE_CALCULATOR = `
AGENT: Fee_Calculator

GOAL: "Calculate booking modification fees"

PERSONA: "Fee calculation specialist"

GATHER:
  booking_id:
    prompt: "Which booking?"
    type: string
    required: true
`;

/**
 * Scripted child agent for mixed-mode testing (supervisor -> scripted child).
 */
const SCRIPTED_SALES_AGENT = `
AGENT: Sales_Agent

GOAL: "Help users find travel"

GATHER:
  destination:
    prompt: "Where would you like to go?"
    type: string
    required: true

  departure_date:
    prompt: "When do you want to depart?"
    type: string
    required: true

  budget:
    prompt: "What is your budget?"
    type: string
    required: false

FLOW:
  collect_destination -> collect_date -> done

  collect_destination:
    REASONING: false
    GATHER:
      - destination: required
    THEN: collect_date

  collect_date:
    REASONING: false
    GATHER:
      - departure_date: required
    THEN: done

  done:
    REASONING: false
    RESPOND: "Great, let me search for trips to {{destination}} on {{departure_date}}."
    THEN: COMPLETE
`;

// =============================================================================
// TESTS
// =============================================================================

describe('Reasoning Agent Gather & Data Tab', () => {
  let executor: RuntimeExecutor;
  let mockClient: ValidatingMockAnthropicClient;

  beforeEach(() => {
    executor = new RuntimeExecutor();
    mockClient = injectValidatingMockClient(executor);
  });

  // ===========================================================================
  // 1. Reasoning agent GATHER field extraction
  // ===========================================================================

  describe('Reasoning Agent Entity Extraction', () => {
    test('should create session with GATHER fields in IR for reasoning agent', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_AGENT_WITH_GATHER], 'Sales_Chat'),
      );

      expect(session.agentIR).not.toBeNull();

      expect(session.agentIR?.gather?.fields).toBeDefined();
      expect(session.agentIR?.gather?.fields?.length).toBe(3);

      const fieldNames = session.agentIR?.gather?.fields?.map((f) => f.name) || [];
      expect(fieldNames).toContain('destination');
      expect(fieldNames).toContain('travel_date');
      expect(fieldNames).toContain('num_passengers');
    });

    test('should have initial session context in data.values for reasoning agent', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_AGENT_WITH_GATHER], 'Sales_Chat'),
      );

      expect(session.data.values).toMatchObject({
        _clarification_count: 0,
        session: { channel: 'digital' },
      });
      expect(session.currentFlowStep).toBeUndefined();
    });

    test('should initialize RuntimeState with activeAgent as undefined', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_AGENT_WITH_GATHER], 'Sales_Chat'),
      );

      expect(session.state.activeAgent).toBeUndefined();
    });

    test('GATHER fields should be included in system prompt for reasoning agents', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_AGENT_WITH_GATHER], 'Sales_Chat'),
      );

      const prompt = buildSystemPrompt(session);

      expect(prompt).toContain('destination');
      expect(prompt).toContain('travel_date');
      expect(prompt).toContain('num_passengers');
      expect(prompt).toContain('gather the following information');
    });
  });

  // ===========================================================================
  // 2. LLM-based entity extraction in reasoning agents
  // ===========================================================================

  describe('LLM Entity Extraction in Reasoning Agents', () => {
    test('executeMessage should extract entities via LLM for reasoning agent with GATHER', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_AGENT_WITH_GATHER], 'Sales_Chat'),
      );

      // Configure mock: entity extraction returns destination + date,
      // main LLM call returns a text response
      mockClient.setResponseHandler((systemPrompt, messages, tools) => {
        // Entity extraction call (no tools)
        if (systemPrompt.includes('entity extraction assistant')) {
          return {
            text: '{"destination": "Paris", "travel_date": "2026-03-15"}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [
              { type: 'text', text: '{"destination": "Paris", "travel_date": "2026-03-15"}' },
            ],
          };
        }
        // Main reasoning call (has tools)
        return {
          text: 'Great! I found flights to Paris on March 15th. Let me search for options.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [
            {
              type: 'text',
              text: 'Great! I found flights to Paris on March 15th. Let me search for options.',
            },
          ],
        };
      });

      const traceCollector = createTraceCollector();
      const result = await executor.executeMessage(
        session.id,
        'I want to fly to Paris on March 15th',
        undefined,
        traceCollector.callback,
      );

      // Should have a response
      expect(result.response).toContain('Paris');

      // data.values should be populated with extracted entities
      expect(session.data.values.destination).toBe('Paris');
      expect(session.data.values.travel_date).toBe('2026-03-15');
    });

    test('should emit dsl_collect trace event with reasoning_gather mode', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_AGENT_WITH_GATHER], 'Sales_Chat'),
      );

      mockClient.setEntityExtractionResponse({
        destination: 'Tokyo',
        num_passengers: 2,
      });

      const traceCollector = createTraceCollector();
      await executor.executeMessage(
        session.id,
        'I want to go to Tokyo with 2 people',
        undefined,
        traceCollector.callback,
      );

      const collectTraces = filterTraces(traceCollector.traces, 'dsl_collect');
      expect(collectTraces.length).toBeGreaterThanOrEqual(1);

      const gatherCollect = collectTraces.find((t) => t.data.mode === 'reasoning_gather');
      expect(gatherCollect).toBeDefined();
      expect(gatherCollect!.data.agentName).toBe('Sales_Chat');
      expect(gatherCollect!.data.extracted).toEqual({
        destination: 'Tokyo',
        num_passengers: 2,
      });
    });

    test('should emit entity_extraction trace event from LLM extraction', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_AGENT_WITH_GATHER], 'Sales_Chat'),
      );

      mockClient.setEntityExtractionResponse({
        destination: 'Barcelona',
        travel_date: '2026-06-01',
      });

      const traceCollector = createTraceCollector();
      await executor.executeMessage(
        session.id,
        'Barcelona on June 1st',
        undefined,
        traceCollector.callback,
      );

      const extractionTraces = filterTraces(traceCollector.traces, 'entity_extraction');
      expect(extractionTraces.length).toBeGreaterThanOrEqual(1);

      const llmExtraction = extractionTraces.find((t) => t.data.method === 'llm');
      expect(llmExtraction).toBeDefined();
      expect(llmExtraction!.data.values).toBeDefined();
      expect((llmExtraction!.data.values as Record<string, unknown>).destination).toBe('Barcelona');
    });

    test('should emit llm_call trace events for both extraction and reasoning', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_AGENT_WITH_GATHER], 'Sales_Chat'),
      );

      mockClient.setEntityExtractionResponse({ destination: 'Rome' });

      const traceCollector = createTraceCollector();
      await executor.executeMessage(
        session.id,
        'I want to visit Rome',
        undefined,
        traceCollector.callback,
      );

      const llmTraces = filterTraces(traceCollector.traces, 'llm_call');
      // Should have at least 2 LLM calls: one for entity extraction, one for reasoning
      expect(llmTraces.length).toBeGreaterThanOrEqual(2);

      // One should be for entity extraction
      const extractionCall = llmTraces.find((t) => t.data.purpose === 'entity_extraction');
      expect(extractionCall).toBeDefined();

      // One should be for the main reasoning loop
      const reasoningCall = llmTraces.find(
        (t) => t.data.agent === 'Sales_Chat' && t.data.iteration !== undefined,
      );
      expect(reasoningCall).toBeDefined();
    });

    test('should accumulate entities across multiple messages', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_AGENT_WITH_GATHER], 'Sales_Chat'),
      );

      // First message: extract destination
      mockClient.setEntityExtractionResponse({ destination: 'London' });
      await executor.executeMessage(session.id, 'I want to go to London', undefined, undefined);

      expect(session.data.values.destination).toBe('London');
      expect(session.data.values.travel_date).toBeUndefined();

      // Second message: extract travel_date
      mockClient.setEntityExtractionResponse({ travel_date: '2026-07-20' });
      await executor.executeMessage(session.id, 'on July 20th', undefined, undefined);

      // Both should be in data.values now
      expect(session.data.values.destination).toBe('London');
      expect(session.data.values.travel_date).toBe('2026-07-20');
    });

    test('should not overwrite existing data.values with empty extractions', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_AGENT_WITH_GATHER], 'Sales_Chat'),
      );

      // First: extract destination
      mockClient.setEntityExtractionResponse({ destination: 'Berlin' });
      await executor.executeMessage(session.id, 'Berlin please', undefined, undefined);

      // Second: extraction returns nothing meaningful for destination
      mockClient.setEntityExtractionResponse({});
      await executor.executeMessage(
        session.id,
        'what flights are available?',
        undefined,
        undefined,
      );

      // Original destination should still be there
      expect(session.data.values.destination).toBe('Berlin');
    });

    test('should handle LLM returning tool calls in reasoning loop', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_AGENT_WITH_GATHER], 'Sales_Chat'),
      );

      let callCount = 0;
      mockClient.setResponseHandler((systemPrompt, messages, tools) => {
        // Entity extraction
        if (systemPrompt.includes('entity extraction assistant')) {
          return {
            text: '{"destination": "Madrid", "travel_date": "2026-04-01"}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [
              { type: 'text', text: '{"destination": "Madrid", "travel_date": "2026-04-01"}' },
            ],
          };
        }

        callCount++;
        if (callCount === 1) {
          // First call: LLM wants to use search_flights tool
          return {
            text: 'Let me search for flights to Madrid.',
            toolCalls: [
              {
                id: 'call_1',
                name: 'search_flights',
                input: { origin: 'NYC', destination: 'Madrid', date: '2026-04-01' },
              },
            ],
            stopReason: 'tool_use',
            rawContent: [
              { type: 'text', text: 'Let me search for flights to Madrid.' },
              {
                type: 'tool_use',
                id: 'call_1',
                name: 'search_flights',
                input: { origin: 'NYC', destination: 'Madrid', date: '2026-04-01' },
              },
            ],
          };
        }
        // Second call: LLM responds with final text after tool result
        return {
          text: 'I found 3 flights to Madrid on April 1st.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'I found 3 flights to Madrid on April 1st.' }],
        };
      });

      const traceCollector = createTraceCollector();
      const result = await executor.executeMessage(
        session.id,
        'Search flights to Madrid on April 1st',
        undefined,
        traceCollector.callback,
      );

      // Entity extraction should have populated data.values
      expect(session.data.values.destination).toBe('Madrid');
      expect(session.data.values.travel_date).toBe('2026-04-01');

      // Tool call trace should exist
      const toolTraces = filterTraces(traceCollector.traces, 'tool_call');
      expect(toolTraces.length).toBeGreaterThanOrEqual(1);

      // dsl_collect should have been emitted before the tool loop
      const collectTraces = filterTraces(traceCollector.traces, 'dsl_collect');
      expect(collectTraces.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ===========================================================================
  // 3. Handoff to REASONING child agent with LLM execution
  // ===========================================================================

  describe('Handoff to Reasoning Child Agent', () => {
    test('handleHandoff should set activeAgent when handing off to reasoning child', async () => {
      const supervisorSession = executor.createSessionFromResolved(
        compileToResolvedAgent([SUPERVISOR_WITH_HANDOFFS], 'Travel_Supervisor'),
      );
      executor.registerAgent('Sales_Agent', REASONING_SALES_AGENT);
      supervisorSession.handoffReturnInfo = { Sales_Agent: false, Welcome_Agent: true };
      supervisorSession.conversationHistory.push({
        role: 'user',
        content: 'I want to travel to Paris',
      });

      // Mock LLM for child reasoning agent execution
      mockClient.setResponseHandler((systemPrompt, messages, tools) => {
        if (systemPrompt.includes('entity extraction assistant')) {
          return {
            text: '{"destination": "Paris"}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [{ type: 'text', text: '{"destination": "Paris"}' }],
          };
        }
        return {
          text: 'Welcome! I can help you find deals to Paris.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Welcome! I can help you find deals to Paris.' }],
        };
      });

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
      const traceCollector = createTraceCollector();

      const result = await handleHandoff(
        supervisorSession,
        { target: 'Sales_Agent', context: { user_preferences: 'beach' } },
        undefined,
        traceCollector.callback,
      );

      expect(result.success).toBe(true);

      // activeAgent should be set on parent state
      expect(supervisorSession.state.activeAgent).toBeDefined();
      expect(supervisorSession.state.activeAgent?.name).toBe('Sales_Agent');

      expect(supervisorSession.state.activeAgent?.ir).toBeDefined();

      // The activeAgent IR should have Sales_Agent's GATHER fields
      const activeIR = supervisorSession.state.activeAgent?.ir as {
        gather?: { fields?: Array<{ name: string }> };
      };
      expect(activeIR?.gather?.fields?.length).toBe(3);
      const fieldNames = activeIR?.gather?.fields?.map((f) => f.name) || [];
      expect(fieldNames).toContain('destination');
      expect(fieldNames).toContain('departure_date');
      expect(fieldNames).toContain('budget');
    });

    test('reasoning child should extract entities from user message during handoff', async () => {
      const supervisorSession = executor.createSessionFromResolved(
        compileToResolvedAgent([SUPERVISOR_WITH_HANDOFFS], 'Travel_Supervisor'),
      );
      executor.registerAgent('Sales_Agent', REASONING_SALES_AGENT);
      supervisorSession.handoffReturnInfo = { Sales_Agent: false };
      supervisorSession.conversationHistory.push({
        role: 'user',
        content: 'find flights to Tokyo on May 5th',
      });

      mockClient.setResponseHandler((systemPrompt, messages, tools) => {
        if (systemPrompt.includes('entity extraction assistant')) {
          return {
            text: '{"destination": "Tokyo", "departure_date": "2026-05-05"}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [
              { type: 'text', text: '{"destination": "Tokyo", "departure_date": "2026-05-05"}' },
            ],
          };
        }
        return {
          text: 'Looking for flights to Tokyo on May 5th!',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Looking for flights to Tokyo on May 5th!' }],
        };
      });

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
      const traceCollector = createTraceCollector();

      await handleHandoff(
        supervisorSession,
        { target: 'Sales_Agent', context: {} },
        undefined,
        traceCollector.callback,
      );

      // Active thread (child agent) should have extracted entities
      const activeThread = supervisorSession.threads[supervisorSession.activeThreadIndex];
      expect(activeThread).toBeDefined();
      expect(activeThread.agentName).toBe('Sales_Agent');
      expect(activeThread.data.values.destination).toBe('Tokyo');
      expect(activeThread.data.values.departure_date).toBe('2026-05-05');

      // Session-level data should be synced from active thread
      expect(supervisorSession.data.values.destination).toBe('Tokyo');
      expect(supervisorSession.data.values.departure_date).toBe('2026-05-05');
    });

    test('should emit handoff trace and dsl_collect from reasoning child', async () => {
      const supervisorSession = executor.createSessionFromResolved(
        compileToResolvedAgent([SUPERVISOR_WITH_HANDOFFS], 'Travel_Supervisor'),
      );
      executor.registerAgent('Sales_Agent', REASONING_SALES_AGENT);
      supervisorSession.handoffReturnInfo = { Sales_Agent: false };
      supervisorSession.conversationHistory.push({ role: 'user', content: 'search deals to Bali' });

      mockClient.setResponseHandler((systemPrompt, messages, tools) => {
        if (systemPrompt.includes('entity extraction assistant')) {
          return {
            text: '{"destination": "Bali"}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [{ type: 'text', text: '{"destination": "Bali"}' }],
          };
        }
        return {
          text: 'Searching for Bali deals...',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Searching for Bali deals...' }],
        };
      });

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
      const traceCollector = createTraceCollector();

      await handleHandoff(
        supervisorSession,
        { target: 'Sales_Agent', context: { search_query: 'bali deals' } },
        undefined,
        traceCollector.callback,
      );

      // handoff trace
      const handoffTraces = filterTraces(traceCollector.traces, 'handoff');
      expect(handoffTraces.length).toBeGreaterThanOrEqual(1);
      expect(handoffTraces[0].data.from).toBe('Travel_Supervisor');
      expect(handoffTraces[0].data.to).toBe('Sales_Agent');
      expect(handoffTraces[0].data.experienceMode).toBe('shared_voice_handoff');
      expect(handoffTraces[0].data.visibility).toBe('customer_visible');
      expect(handoffTraces[0].data.suppressChildOutput).toBe(false);
      expect(handoffTraces[0].data.continuity).toEqual({
        kind: 'handoff_transition',
        visibility: 'internal',
      });

      // dsl_collect from reasoning child entity extraction
      const collectTraces = filterTraces(traceCollector.traces, 'dsl_collect');
      expect(collectTraces.length).toBeGreaterThanOrEqual(1);
      const gatherCollect = collectTraces.find((t) => t.data.mode === 'reasoning_gather');
      expect(gatherCollect).toBeDefined();
      expect(gatherCollect!.data.agentName).toBe('Sales_Agent');
    });

    test('silent_delegate handoff keeps child output internal', async () => {
      const supervisorSession = executor.createSessionFromResolved(
        compileToResolvedAgent([SUPERVISOR_WITH_SILENT_RETURNING_HANDOFF], 'Policy_Supervisor'),
      );
      executor.registerAgent('Internal_Policy_Agent', INTERNAL_POLICY_AGENT);
      supervisorSession.handoffReturnInfo = { Internal_Policy_Agent: true };
      supervisorSession.conversationHistory.push({
        role: 'user',
        content: 'check the policy for this order',
      });

      mockClient.setResponseHandler(() => ({
        text: 'Internal policy memo: replacement is allowed after the no-scan window.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [
          {
            type: 'text',
            text: 'Internal policy memo: replacement is allowed after the no-scan window.',
          },
        ],
      }));

      const chunks: string[] = [];
      const traceCollector = createTraceCollector();
      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);

      const result = await handleHandoff(
        supervisorSession,
        { target: 'Internal_Policy_Agent', message: 'check the policy for this order' },
        (chunk: string) => chunks.push(chunk),
        traceCollector.callback,
      );

      expect(result.success).toBe(true);
      expect(result.response).toBe('');
      expect(chunks).toEqual([]);

      const handoffTraces = filterTraces(traceCollector.traces, 'handoff');
      expect(handoffTraces[0].data.experienceMode).toBe('silent_delegate');
      expect(handoffTraces[0].data.visibility).toBe('internal');
      expect(handoffTraces[0].data.suppressChildOutput).toBe(true);

      const internalMessages = supervisorSession.conversationHistory.filter(
        (message) =>
          message.role === 'assistant' &&
          typeof message.content === 'string' &&
          message.content.includes('Internal_Policy_Agent'),
      );
      expect(internalMessages).toHaveLength(1);
      expect(internalMessages[0].metadata?.responseVisibility).toBe('internal');
      expect(internalMessages[0].metadata?.deliveredToUser).toBe(false);
    });

    test('subsequent messages should route to reasoning child and extract entities', async () => {
      const supervisorSession = executor.createSessionFromResolved(
        compileToResolvedAgent([SUPERVISOR_WITH_HANDOFFS], 'Travel_Supervisor'),
      );
      executor.registerAgent('Sales_Agent', REASONING_SALES_AGENT);
      supervisorSession.handoffReturnInfo = { Sales_Agent: false };
      supervisorSession.conversationHistory.push({ role: 'user', content: 'travel search' });

      // Initial handoff - child extracts destination
      mockClient.setResponseHandler((systemPrompt, messages, tools) => {
        if (systemPrompt.includes('entity extraction assistant')) {
          return {
            text: '{}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [{ type: 'text', text: '{}' }],
          };
        }
        return {
          text: 'Where would you like to go?',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Where would you like to go?' }],
        };
      });

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
      await handleHandoff(supervisorSession, { target: 'Sales_Agent' }, undefined, undefined);

      // With thread model, parent thread is completed but session is not complete
      // The active thread is now the child agent thread
      expect(supervisorSession.threads.length).toBeGreaterThan(1);
      expect(supervisorSession.threads[supervisorSession.activeThreadIndex].agentName).toBe(
        'Sales_Agent',
      );

      // Now send a follow-up message through the session (routes to active thread)
      mockClient.setResponseHandler((systemPrompt, messages, tools) => {
        if (systemPrompt.includes('entity extraction assistant')) {
          return {
            text: '{"destination": "Sydney", "departure_date": "2026-08-15"}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [
              { type: 'text', text: '{"destination": "Sydney", "departure_date": "2026-08-15"}' },
            ],
          };
        }
        return {
          text: 'Great choice! Sydney in August is wonderful.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Great choice! Sydney in August is wonderful.' }],
        };
      });

      const traceCollector = createTraceCollector();
      const result = await executor.executeMessage(
        supervisorSession.id,
        'Sydney on August 15th',
        undefined,
        traceCollector.callback,
      );

      // Parent should have synced data.values
      expect(supervisorSession.data.values.destination).toBe('Sydney');
      expect(supervisorSession.data.values.departure_date).toBe('2026-08-15');

      // activeAgent should still be set
      expect(result.stateUpdates?.activeAgent).toBeDefined();
      expect((result.stateUpdates as any).activeAgent.name).toBe('Sales_Agent');

      // stateUpdates should include gatherProgress (API response format)
      expect(result.stateUpdates?.gatherProgress).toBeDefined();
      expect((result.stateUpdates as any).gatherProgress.destination).toBe('Sydney');
    });
  });

  // ===========================================================================
  // 4. Handoff context passing and return behavior
  // ===========================================================================

  describe('Handoff Context & Return Behavior', () => {
    test('should set up handoff return info from supervisor routing rules', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([SUPERVISOR_WITH_HANDOFFS], 'Travel_Supervisor'),
      );

      const supervisorIR = session.agentIR as unknown as {
        routing?: { rules?: Array<{ to: string; return?: boolean }> };
      };
      expect(supervisorIR.routing?.rules).toBeDefined();

      const rules = supervisorIR.routing?.rules || [];
      const salesRule = rules.find((r) => r.to === 'Sales_Agent');
      const welcomeRule = rules.find((r) => r.to === 'Welcome_Agent');

      expect(salesRule).toBeDefined();
      expect(welcomeRule).toBeDefined();
    });

    test('handleHandoff should pass context to child session state', async () => {
      const supervisorSession = executor.createSessionFromResolved(
        compileToResolvedAgent([SUPERVISOR_WITH_HANDOFFS], 'Travel_Supervisor'),
      );
      executor.registerAgent('Sales_Agent', REASONING_SALES_AGENT);
      supervisorSession.handoffReturnInfo = { Sales_Agent: false };
      supervisorSession.conversationHistory.push({ role: 'user', content: 'hello' });

      mockClient.setEntityExtractionResponse({});

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
      await handleHandoff(
        supervisorSession,
        { target: 'Sales_Agent', context: { user_id: 'u123', preferred_destination: 'Tokyo' } },
        undefined,
        undefined,
      );

      // Active thread should have the context data
      const activeThread = supervisorSession.threads[supervisorSession.activeThreadIndex];
      expect(activeThread).toBeDefined();
      expect(activeThread.agentName).toBe('Sales_Agent');
      expect(activeThread.data.values.user_id).toBe('u123');
      expect(activeThread.data.values.preferred_destination).toBe('Tokyo');
      expect(activeThread.data.values.handoff_from).toBe('Travel_Supervisor');
    });

    test('handleHandoff with RETURN: false should mark parent as complete', async () => {
      const supervisorSession = executor.createSessionFromResolved(
        compileToResolvedAgent([SUPERVISOR_WITH_HANDOFFS], 'Travel_Supervisor'),
      );
      executor.registerAgent('Sales_Agent', REASONING_SALES_AGENT);
      supervisorSession.handoffReturnInfo = { Sales_Agent: false, Welcome_Agent: true };
      supervisorSession.conversationHistory.push({ role: 'user', content: 'book flight' });

      mockClient.setEntityExtractionResponse({});

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
      await handleHandoff(supervisorSession, { target: 'Sales_Agent' }, undefined, undefined);

      // Parent thread should be completed, active thread is the child
      expect(supervisorSession.threads[0].status).toBe('completed');
      expect(supervisorSession.threads.length).toBeGreaterThan(1);
      expect(supervisorSession.threads[supervisorSession.activeThreadIndex].agentName).toBe(
        'Sales_Agent',
      );
    });

    test('handleHandoff with RETURN: true should keep parent active', async () => {
      const supervisorSession = executor.createSessionFromResolved(
        compileToResolvedAgent([SUPERVISOR_WITH_HANDOFFS], 'Travel_Supervisor'),
      );
      executor.registerAgent('Welcome_Agent', REASONING_WELCOME_AGENT);
      supervisorSession.handoffReturnInfo = { Sales_Agent: false, Welcome_Agent: true };
      supervisorSession.conversationHistory.push({ role: 'user', content: 'hi' });

      mockClient.setEntityExtractionResponse({});

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
      const traceCollector = createTraceCollector();
      const chunks: string[] = [];
      supervisorSession.channelType = 'slack';
      await handleHandoff(
        supervisorSession,
        { target: 'Welcome_Agent' },
        (chunk: string) => chunks.push(chunk),
        traceCollector.callback,
      );

      // After handoff, new thread should have been created within the same session
      expect(supervisorSession.threads.length).toBeGreaterThanOrEqual(1);
      const handoffTraces = filterTraces(traceCollector.traces, 'handoff');
      expect(handoffTraces[0].data.experienceMode).toBe('visible_handoff');
      expect(handoffTraces[0].data.continuity).toEqual({
        kind: 'handoff_transition',
        visibility: 'customer_visible',
        message: "I'm connecting you with the right specialist now.",
      });
      expect(chunks[0]).toBe("I'm connecting you with the right specialist now.");
    });

    test('handleHandoff should prevent self-handoff', async () => {
      const supervisorSession = executor.createSessionFromResolved(
        compileToResolvedAgent([SUPERVISOR_WITH_HANDOFFS], 'Travel_Supervisor'),
      );

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
      const result = await handleHandoff(
        supervisorSession,
        { target: 'Travel_Supervisor' },
        undefined,
        undefined,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Cannot hand off to yourself');
    });
  });

  // ===========================================================================
  // 5. data.values sync from reasoning child to parent
  // ===========================================================================

  describe('Data Values Sync with Reasoning Child', () => {
    test('executeMessage should route to reasoning child and sync data.values', async () => {
      const supervisorSession = executor.createSessionFromResolved(
        compileToResolvedAgent([SUPERVISOR_WITH_HANDOFFS], 'Travel_Supervisor'),
      );
      executor.registerAgent('Sales_Agent', REASONING_SALES_AGENT);
      supervisorSession.handoffReturnInfo = { Sales_Agent: false };
      supervisorSession.conversationHistory.push({ role: 'user', content: 'travel' });

      mockClient.setEntityExtractionResponse({});

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
      await handleHandoff(supervisorSession, { target: 'Sales_Agent' }, undefined, undefined);

      // Parent thread completed, active thread is child
      expect(supervisorSession.threads[0].status).toBe('completed');
      expect(supervisorSession.threads[supervisorSession.activeThreadIndex].agentName).toBe(
        'Sales_Agent',
      );

      // Now send a message through the session (routes to active thread)
      mockClient.setResponseHandler((systemPrompt, messages, tools) => {
        if (systemPrompt.includes('entity extraction assistant')) {
          return {
            text: '{"destination": "Amsterdam", "departure_date": "2026-09-01"}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [
              {
                type: 'text',
                text: '{"destination": "Amsterdam", "departure_date": "2026-09-01"}',
              },
            ],
          };
        }
        return {
          text: 'Amsterdam is a great choice for September!',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Amsterdam is a great choice for September!' }],
        };
      });

      const result = await executor.executeMessage(
        supervisorSession.id,
        'Amsterdam on September 1st',
        undefined,
        undefined,
      );

      // Parent data.values should be synced from child
      expect(supervisorSession.data.values.destination).toBe('Amsterdam');
      expect(supervisorSession.data.values.departure_date).toBe('2026-09-01');

      // stateUpdates should have gatherProgress (API response format) and activeAgent
      expect(result.stateUpdates).toBeDefined();
      expect((result.stateUpdates as any).gatherProgress?.destination).toBe('Amsterdam');
      expect((result.stateUpdates as any).activeAgent?.name).toBe('Sales_Agent');
    });

    test('activeAgent should persist in parent state across messages', async () => {
      const supervisorSession = executor.createSessionFromResolved(
        compileToResolvedAgent([SUPERVISOR_WITH_HANDOFFS], 'Travel_Supervisor'),
      );
      executor.registerAgent('Sales_Agent', REASONING_SALES_AGENT);
      supervisorSession.handoffReturnInfo = { Sales_Agent: false };
      supervisorSession.conversationHistory.push({ role: 'user', content: 'travel' });

      mockClient.setEntityExtractionResponse({});

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
      await handleHandoff(supervisorSession, { target: 'Sales_Agent' }, undefined, undefined);

      // First message
      mockClient.setEntityExtractionResponse({ destination: 'Dubai' });
      const result1 = await executor.executeMessage(
        supervisorSession.id,
        'Dubai',
        undefined,
        undefined,
      );
      expect((result1.stateUpdates as any).activeAgent?.name).toBe('Sales_Agent');

      // Second message
      mockClient.setEntityExtractionResponse({ departure_date: '2026-12-01' });
      const result2 = await executor.executeMessage(
        supervisorSession.id,
        'December 1st',
        undefined,
        undefined,
      );
      expect((result2.stateUpdates as any).activeAgent?.name).toBe('Sales_Agent');

      // Accumulated data.values
      expect(supervisorSession.data.values.destination).toBe('Dubai');
      expect(supervisorSession.data.values.departure_date).toBe('2026-12-01');
    });
  });

  // ===========================================================================
  // 6. Delegate context passing with reasoning agents
  // ===========================================================================

  describe('Delegate Context & Result Mapping', () => {
    test('should register delegate target agents', () => {
      executor.createSessionFromResolved(
        compileToResolvedAgent([AGENT_WITH_DELEGATE], 'Booking_Manager'),
      );
      executor.registerAgent('Fee_Calculator', REASONING_FEE_CALCULATOR);

      const feeSession = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_FEE_CALCULATOR], 'Fee_Calculator'),
      );
      expect(feeSession.agentIR).not.toBeNull();
      expect(feeSession.agentIR?.gather?.fields?.some((f) => f.name === 'booking_id')).toBe(true);
    });

    test('executeDelegate should pass INPUT context to delegate session', async () => {
      const parentSession = executor.createSessionFromResolved(
        compileToResolvedAgent([AGENT_WITH_DELEGATE], 'Booking_Manager'),
      );
      executor.registerAgent('Fee_Calculator', REASONING_FEE_CALCULATOR);

      parentSession.data.values.booking_id = 'BK-12345';
      parentSession.data.values.change_details = { dates: 'new dates' };
      Object.assign(parentSession.data.values, {
        booking_id: 'BK-12345',
        change_details: { dates: 'new dates' },
      });

      mockClient.setEntityExtractionResponse({});

      const executeDelegate = (executor as any).routing.executeDelegate.bind(
        (executor as any).routing,
      );
      const traceCollector = createTraceCollector();

      const delegateConfig = parentSession.agentIR?.coordination?.delegates?.find(
        (d: any) => d.agent === 'Fee_Calculator',
      );

      await executeDelegate(
        parentSession,
        'Fee_Calculator',
        delegateConfig,
        undefined,
        undefined, // message
        undefined, // onChunk
        traceCollector.callback,
      );

      const delegateStartTraces = filterTraces(traceCollector.traces, 'delegate_start');
      expect(delegateStartTraces.length).toBe(1);
      expect(delegateStartTraces[0].data.from).toBe('Booking_Manager');
      expect(delegateStartTraces[0].data.to).toBe('Fee_Calculator');
      expect(delegateStartTraces[0].data.purpose).toBe('Calculate modification fees');
      expect(delegateStartTraces[0].data.experienceMode).toBe('silent_delegate');
      expect(delegateStartTraces[0].data.visibility).toBe('internal');
      expect(delegateStartTraces[0].data.suppressChildOutput).toBe(true);
    });

    test('executeDelegate should emit delegate_complete trace', async () => {
      const parentSession = executor.createSessionFromResolved(
        compileToResolvedAgent([AGENT_WITH_DELEGATE], 'Booking_Manager'),
      );
      executor.registerAgent('Fee_Calculator', REASONING_FEE_CALCULATOR);
      // data.values already initialized — no-op

      mockClient.setEntityExtractionResponse({});

      const executeDelegate = (executor as any).routing.executeDelegate.bind(
        (executor as any).routing,
      );
      const traceCollector = createTraceCollector();

      const delegateConfig = parentSession.agentIR?.coordination?.delegates?.find(
        (d: any) => d.agent === 'Fee_Calculator',
      );

      await executeDelegate(
        parentSession,
        'Fee_Calculator',
        delegateConfig,
        undefined,
        undefined, // message
        undefined, // onChunk
        traceCollector.callback,
      );

      const completeTraces = filterTraces(traceCollector.traces, 'delegate_complete');
      expect(completeTraces.length).toBe(1);
      expect(completeTraces[0].data.from).toBe('Booking_Manager');
      expect(completeTraces[0].data.to).toBe('Fee_Calculator');
      expect(completeTraces[0].data.experienceMode).toBe('silent_delegate');
      expect(completeTraces[0].data.visibility).toBe('internal');
      expect(completeTraces[0].data.suppressChildOutput).toBe(true);
    });

    test('executeDelegate should store result in parent', async () => {
      const parentSession = executor.createSessionFromResolved(
        compileToResolvedAgent([AGENT_WITH_DELEGATE], 'Booking_Manager'),
      );
      executor.registerAgent('Fee_Calculator', REASONING_FEE_CALCULATOR);
      // data.values already initialized — no-op

      mockClient.setEntityExtractionResponse({});

      const executeDelegate = (executor as any).routing.executeDelegate.bind(
        (executor as any).routing,
      );

      const delegateConfig = parentSession.agentIR?.coordination?.delegates?.find(
        (d: any) => d.agent === 'Fee_Calculator',
      );

      const result = await executeDelegate(
        parentSession,
        'Fee_Calculator',
        delegateConfig,
        undefined,
        undefined,
        undefined,
      );

      expect(result.success).toBe(true);
      // Delegate result is stored in data.values under use_result key (or 'delegate_result' default)
      const useResultKey =
        parentSession.agentIR?.coordination?.delegates?.find(
          (d: any) => d.agent === 'Fee_Calculator',
        )?.use_result || 'delegate_result';
      expect(parentSession.data.values[useResultKey]).toBeDefined();
    });

    test('executeDelegate should handle missing target agent gracefully', async () => {
      const parentSession = executor.createSessionFromResolved(
        compileToResolvedAgent([AGENT_WITH_DELEGATE], 'Booking_Manager'),
      );

      const executeDelegate = (executor as any).routing.executeDelegate.bind(
        (executor as any).routing,
      );

      const result = await executeDelegate(
        parentSession,
        'Nonexistent_Agent',
        undefined,
        undefined,
        undefined,
        undefined,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Agent not found');
    });
  });

  // ===========================================================================
  // 7. RuntimeState activeAgent type structure
  // ===========================================================================

  describe('RuntimeState ActiveAgent Structure', () => {
    test('RuntimeState should support activeAgent field', () => {
      const state: RuntimeState = {
        gatherProgress: {},
        conversationPhase: 'start',
        context: {},
        activeAgent: {
          name: 'Test_Agent',
          mode: 'reasoning',
          ir: { gather: { fields: [{ name: 'test_field' }] } },
        },
      };

      expect(state.activeAgent?.name).toBe('Test_Agent');

      expect(state.activeAgent?.ir).toBeDefined();
    });

    test('RuntimeState activeAgent should be optional', () => {
      const state: RuntimeState = {
        gatherProgress: {},
        conversationPhase: 'start',
        context: {},
      };

      expect(state.activeAgent).toBeUndefined();
    });

    test('activeAgent IR should contain gather fields from reasoning child agent', async () => {
      const supervisorSession = executor.createSessionFromResolved(
        compileToResolvedAgent([SUPERVISOR_WITH_HANDOFFS], 'Travel_Supervisor'),
      );
      executor.registerAgent('Sales_Agent', REASONING_SALES_AGENT);
      supervisorSession.handoffReturnInfo = { Sales_Agent: false };
      supervisorSession.conversationHistory.push({ role: 'user', content: 'search flights' });

      mockClient.setEntityExtractionResponse({});

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
      await handleHandoff(supervisorSession, { target: 'Sales_Agent' }, undefined, undefined);

      const activeIR = supervisorSession.state.activeAgent?.ir as any;
      expect(activeIR).toBeDefined();
      expect(activeIR.metadata?.name).toBe('Sales_Agent');

      expect(activeIR.gather?.fields?.length).toBe(3);
    });
  });

  // ===========================================================================
  // 8. Sequential handoffs - activeAgent updates
  // ===========================================================================

  describe('Sequential Handoffs with ActiveAgent Updates', () => {
    test('activeAgent should update when a RETURN:true child completes before the next handoff', async () => {
      const supervisorSession = executor.createSessionFromResolved(
        compileToResolvedAgent([SUPERVISOR_WITH_HANDOFFS], 'Travel_Supervisor'),
      );
      executor.registerAgent('Welcome_Agent', REASONING_WELCOME_AGENT);
      executor.registerAgent('Sales_Agent', REASONING_SALES_AGENT);
      supervisorSession.handoffReturnInfo = { Welcome_Agent: true, Sales_Agent: false };
      supervisorSession.conversationHistory.push({ role: 'user', content: 'hi' });

      mockClient.setResponseHandler((systemPrompt, _messages, _tools) => {
        if (systemPrompt.includes('entity extraction assistant')) {
          return {
            text: '{}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [{ type: 'text', text: '{}' }],
          };
        }

        return {
          text: 'Welcome! How can I help with your trip?',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Welcome! How can I help with your trip?' }],
        };
      });

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);

      // First handoff to Welcome_Agent (RETURN: true). Explicitly drive the
      // return transition so the second handoff runs from the supervisor again.
      await handleHandoff(supervisorSession, { target: 'Welcome_Agent' }, undefined, undefined);
      expect(tryThreadReturn(supervisorSession, 'Welcome complete')).toBe(true);

      const parentThread = supervisorSession.threads[supervisorSession.activeThreadIndex];
      expect(parentThread.agentName).toBe('Travel_Supervisor');

      // Second handoff to Sales_Agent (RETURN: false)
      supervisorSession.isComplete = false;
      supervisorSession.conversationHistory.push({ role: 'user', content: 'book a flight' });
      await handleHandoff(supervisorSession, { target: 'Sales_Agent' }, undefined, undefined);

      // activeAgent should now be Sales_Agent
      expect(supervisorSession.state.activeAgent?.name).toBe('Sales_Agent');

      const salesIR = supervisorSession.state.activeAgent?.ir as any;
      expect(salesIR.gather?.fields?.length).toBe(3);
      expect(salesIR.gather?.fields?.some((f: any) => f.name === 'destination')).toBe(true);
    });
  });

  // ===========================================================================
  // 9. Handoff chain: child data.values tracking
  // ===========================================================================

  describe('Handoff Stack and Chain', () => {
    test('reasoning child session should track handoff stack', async () => {
      const supervisorSession = executor.createSessionFromResolved(
        compileToResolvedAgent([SUPERVISOR_WITH_HANDOFFS], 'Travel_Supervisor'),
      );
      executor.registerAgent('Sales_Agent', REASONING_SALES_AGENT);
      supervisorSession.handoffReturnInfo = { Sales_Agent: false };
      supervisorSession.conversationHistory.push({ role: 'user', content: 'travel' });

      mockClient.setEntityExtractionResponse({});

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
      await handleHandoff(supervisorSession, { target: 'Sales_Agent' }, undefined, undefined);

      // Active thread should be the child and handoffStack should contain Sales_Agent
      const activeThread = supervisorSession.threads[supervisorSession.activeThreadIndex];
      expect(activeThread).toBeDefined();
      expect(activeThread.agentName).toBe('Sales_Agent');
      expect(activeThread.handoffFrom).toBe('Travel_Supervisor');
      expect(supervisorSession.handoffStack).toContain('Sales_Agent');
    });

    test('reasoning child session should have correct agent IR with gather fields', async () => {
      const supervisorSession = executor.createSessionFromResolved(
        compileToResolvedAgent([SUPERVISOR_WITH_HANDOFFS], 'Travel_Supervisor'),
      );
      executor.registerAgent('Welcome_Agent', REASONING_WELCOME_AGENT);
      supervisorSession.handoffReturnInfo = { Welcome_Agent: true };
      supervisorSession.conversationHistory.push({ role: 'user', content: 'hi' });

      mockClient.setEntityExtractionResponse({});

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
      await handleHandoff(supervisorSession, { target: 'Welcome_Agent' }, undefined, undefined);

      const sessions = (executor as any).sessions as Map<string, RuntimeSession>;
      let welcomeSession: RuntimeSession | undefined;
      for (const [, sess] of sessions) {
        if (sess.agentName === 'Welcome_Agent') {
          welcomeSession = sess;
          break;
        }
      }

      expect(welcomeSession).toBeDefined();
      expect(welcomeSession!.agentIR?.gather?.fields?.some((f) => f.name === 'user_name')).toBe(
        true,
      );
    });
  });

  // ===========================================================================
  // 10. Mixed mode: scripted child with gather sync (regression)
  // ===========================================================================

  describe('Scripted Child Agent Data Collection (Regression)', () => {
    test('scripted child agent created via handoff should be accessible and functional', async () => {
      const supervisorSession = executor.createSessionFromResolved(
        compileToResolvedAgent([SUPERVISOR_WITH_HANDOFFS], 'Travel_Supervisor'),
      );
      executor.registerAgent('Sales_Agent', SCRIPTED_SALES_AGENT);
      supervisorSession.handoffReturnInfo = { Sales_Agent: false };
      supervisorSession.conversationHistory.push({ role: 'user', content: 'find flights' });

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
      const traceCollector = createTraceCollector();

      // Spy on wireLLMClient to verify it is NOT called for scripted children
      const wireLLMClientSpy = vi.spyOn((executor as any).llmWiring, 'wireLLMClient');

      await handleHandoff(
        supervisorSession,
        { target: 'Sales_Agent' },
        undefined,
        traceCollector.callback,
      );

      // Child thread should be created within the session
      const activeThread = supervisorSession.threads[supervisorSession.activeThreadIndex];
      expect(activeThread).toBeDefined();
      expect(activeThread.agentName).toBe('Sales_Agent');

      // Scripted children execute through the flow path, not the reasoning path:
      // currentFlowStep must be set to the child's flow entry point (Req 5.1, 5.2, 5.3)
      expect(supervisorSession.currentFlowStep).toBeDefined();
      expect(supervisorSession.currentFlowStep).toBe('collect_destination');
      // wireLLMClient must NOT be called — flow executor builds its own prompts (Req 3.2)
      expect(wireLLMClientSpy).not.toHaveBeenCalled();
      // The child's IR should still have the scripted gather fields
      expect(activeThread.agentIR?.gather?.fields?.length).toBe(3);
    });

    test('data.values from scripted child should sync to parent via routing', async () => {
      const supervisorSession = executor.createSessionFromResolved(
        compileToResolvedAgent([SUPERVISOR_WITH_HANDOFFS], 'Travel_Supervisor'),
      );
      executor.registerAgent('Sales_Agent', SCRIPTED_SALES_AGENT);
      supervisorSession.handoffReturnInfo = { Sales_Agent: false };
      supervisorSession.conversationHistory.push({ role: 'user', content: 'search' });

      const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
      await handleHandoff(supervisorSession, { target: 'Sales_Agent' }, undefined, undefined);

      // Send destination through session (routes to active child thread)
      await executor.executeMessage(supervisorSession.id, 'Barcelona', undefined, undefined);

      // Send follow-up through same session
      const result = await executor.executeMessage(
        supervisorSession.id,
        '2026-04-10',
        undefined,
        undefined,
      );

      expect(result.stateUpdates).toBeDefined();
    });
  });
});

// =============================================================================
// MULTI-DELEGATE TESTS
// =============================================================================

/**
 * ABL fixtures for multi-delegate scenarios.
 * Trip_Planner delegates to Flight_Finder and Hotel_Finder sequentially.
 */
const MULTI_DELEGATE_PLANNER = `
AGENT: Trip_Planner

GOAL: "Plan complete trips by finding flights and hotels"

PERSONA: "Expert trip planner"

GATHER:
  destination:
    prompt: "Where are you going?"
    type: string
    required: true

  travel_date:
    prompt: "When do you want to travel?"
    type: string
    required: true

DELEGATE:
  - AGENT: Flight_Finder
    WHEN: destination IS SET
    PURPOSE: "Find the best flights to the destination"
    INPUT: {destination: destination, date: travel_date}
    RETURNS: {flight_id: flight_id, flight_price: flight_price}
    USE_RESULT: "flight_quote"
    TIMEOUT: 10s
    ON_FAILURE: RESPOND "Unable to find flights right now"

  - AGENT: Hotel_Finder
    WHEN: destination IS SET
    PURPOSE: "Find hotel accommodations at the destination"
    INPUT: {city: destination, checkin: travel_date}
    RETURNS: {hotel_name: hotel_name, hotel_price: hotel_price}
    USE_RESULT: "hotel_quote"
    TIMEOUT: 10s
    ON_FAILURE: RESPOND "Unable to find hotels right now"
`;

const FLIGHT_FINDER_AGENT = `
AGENT: Flight_Finder

GOAL: "Search for and return the best flight options"

PERSONA: "Flight search specialist"

GATHER:
  destination:
    prompt: "Where to?"
    type: string
    required: true
`;

const HOTEL_FINDER_AGENT = `
AGENT: Hotel_Finder

GOAL: "Search for and return the best hotel options"

PERSONA: "Hotel search specialist"

GATHER:
  city:
    prompt: "Which city?"
    type: string
    required: true
`;

/**
 * Third delegate target for triple-delegate scenarios.
 */
const ACTIVITY_FINDER_AGENT = `
AGENT: Activity_Finder

GOAL: "Find activities and experiences at the destination"

PERSONA: "Activity recommendation specialist"

GATHER:
  location:
    prompt: "Where?"
    type: string
    required: true
`;

/**
 * Agent with three delegates for comprehensive merging tests.
 */
const TRIPLE_DELEGATE_PLANNER = `
AGENT: Full_Planner

GOAL: "Plan complete trips with flights, hotels, and activities"

PERSONA: "Full-service trip planner"

GATHER:
  destination:
    prompt: "Where are you going?"
    type: string
    required: true

  travel_date:
    prompt: "When?"
    type: string
    required: true

DELEGATE:
  - AGENT: Flight_Finder
    WHEN: destination IS SET
    PURPOSE: "Find flights"
    INPUT: {destination: destination, date: travel_date}
    RETURNS: {flight_id: flight_id, flight_price: flight_price}
    USE_RESULT: "flight_quote"
    TIMEOUT: 10s
    ON_FAILURE: CONTINUE

  - AGENT: Hotel_Finder
    WHEN: destination IS SET
    PURPOSE: "Find hotels"
    INPUT: {city: destination, checkin: travel_date}
    RETURNS: {hotel_name: hotel_name, hotel_price: hotel_price}
    USE_RESULT: "hotel_quote"
    TIMEOUT: 10s
    ON_FAILURE: CONTINUE

  - AGENT: Activity_Finder
    WHEN: destination IS SET
    PURPOSE: "Find activities"
    INPUT: {location: destination}
    RETURNS: {activity_name: activity_name, activity_price: activity_price}
    USE_RESULT: "activity_quote"
    TIMEOUT: 10s
    ON_FAILURE: RESPOND "Could not find activities"
`;

describe('Multi-Delegate: Sequential Delegation & Result Merging', () => {
  let executor: RuntimeExecutor;
  let mockClient: ValidatingMockAnthropicClient;

  beforeEach(() => {
    executor = new RuntimeExecutor();
    mockClient = injectValidatingMockClient(executor);
  });

  // ===========================================================================
  // 1. Sequential delegation to two child agents
  // ===========================================================================

  describe('Sequential Two-Agent Delegation', () => {
    test('LLM should delegate to two agents sequentially via delegate_to_* tools', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([MULTI_DELEGATE_PLANNER], 'Trip_Planner'),
      );
      executor.registerAgent('Flight_Finder', FLIGHT_FINDER_AGENT);
      executor.registerAgent('Hotel_Finder', HOTEL_FINDER_AGENT);

      // Pre-populate context so delegates have required input
      session.data.values.destination = 'Paris';
      session.data.values.travel_date = '2026-06-15';
      session.data.values.destination = 'Paris';
      session.data.values.travel_date = '2026-06-15';

      let callIndex = 0;
      mockClient.setResponseHandler((systemPrompt, messages, tools) => {
        callIndex++;

        // Entity extraction calls (no tools) — return empty or simple extraction
        if (systemPrompt.includes('entity extraction assistant')) {
          return {
            text: '{}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [{ type: 'text', text: '{}' }],
          };
        }

        // Check if this is a child agent call (no delegate_to_* in tools)
        const hasDelegateTool = (tools as any[]).some((t) => t.name.startsWith('delegate_to_'));

        if (!hasDelegateTool) {
          // Child agent reasoning call — return a JSON response
          if (systemPrompt.includes('Flight')) {
            return {
              text: '{"flight_id": "FL-123", "flight_price": 450}',
              toolCalls: [],
              stopReason: 'end_turn',
              rawContent: [{ type: 'text', text: '{"flight_id": "FL-123", "flight_price": 450}' }],
            };
          }
          if (systemPrompt.includes('Hotel')) {
            return {
              text: '{"hotel_name": "Le Grand Hotel", "hotel_price": 180}',
              toolCalls: [],
              stopReason: 'end_turn',
              rawContent: [
                { type: 'text', text: '{"hotel_name": "Le Grand Hotel", "hotel_price": 180}' },
              ],
            };
          }
          // Fallback for other child agents
          return {
            text: 'Done.',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [{ type: 'text', text: 'Done.' }],
          };
        }

        // Parent agent reasoning calls with delegate_to_* tools available
        // Count parent calls only (calls with delegate tool)
        const parentCallCount = mockClient.calls.filter((c) =>
          (c.tools as any[]).some((t) => t.name.startsWith('delegate_to_')),
        ).length;

        if (parentCallCount <= 1) {
          // First parent call: delegate to Flight_Finder
          return {
            text: 'Let me find flights for you.',
            toolCalls: [
              {
                id: 'delegate_flight',
                name: 'delegate_to_Flight_Finder',
                input: {},
              },
            ],
            stopReason: 'tool_use',
            rawContent: [
              { type: 'text', text: 'Let me find flights for you.' },
              {
                type: 'tool_use',
                id: 'delegate_flight',
                name: 'delegate_to_Flight_Finder',
                input: {},
              },
            ],
          };
        }

        if (parentCallCount === 2) {
          // Second parent call (after flight result): delegate to Hotel_Finder
          return {
            text: 'Now let me find hotels.',
            toolCalls: [
              {
                id: 'delegate_hotel',
                name: 'delegate_to_Hotel_Finder',
                input: {},
              },
            ],
            stopReason: 'tool_use',
            rawContent: [
              { type: 'text', text: 'Now let me find hotels.' },
              {
                type: 'tool_use',
                id: 'delegate_hotel',
                name: 'delegate_to_Hotel_Finder',
                input: {},
              },
            ],
          };
        }

        // Third parent call: final response merging both results
        return {
          text: 'Your trip to Paris is planned! Flight FL-123 ($450) and Le Grand Hotel ($180/night).',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [
            {
              type: 'text',
              text: 'Your trip to Paris is planned! Flight FL-123 ($450) and Le Grand Hotel ($180/night).',
            },
          ],
        };
      });

      const traceCollector = createTraceCollector();
      const result = await executor.executeMessage(
        session.id,
        'Plan my trip to Paris on June 15th',
        undefined,
        traceCollector.callback,
      );

      // Final response should exist
      expect(result.response).toContain('Paris');

      // Should have 2 delegate_start and 2 delegate_complete traces
      const delegateStarts = filterTraces(traceCollector.traces, 'delegate_start');
      const delegateCompletes = filterTraces(traceCollector.traces, 'delegate_complete');
      const delegatedMessages = filterTraces(traceCollector.traces, 'delegated_message');
      const threadReturns = filterTraces(traceCollector.traces, 'thread_return');
      const userMessages = filterTraces(traceCollector.traces, 'user_message');
      expect(delegateStarts.length).toBe(2);
      expect(delegateCompletes.length).toBe(2);
      expect(delegatedMessages.length).toBe(2);
      expect(threadReturns.length).toBe(2);
      expect(userMessages.length).toBe(1);

      // Verify delegate targets
      expect(delegateStarts[0].data.to).toBe('Flight_Finder');
      expect(delegateStarts[1].data.to).toBe('Hotel_Finder');
      expect(delegateStarts[0].data.targetAgent).toBe('Flight_Finder');
      expect(delegateStarts[0].data.sourceAgent).toBe('Trip_Planner');
      expect(delegateStarts[0].data.childSessionId).toEqual(expect.any(String));
      expect(delegatedMessages[0].data.inputKind).toBe('delegated');
      expect(delegatedMessages[0].data.agentName).toBe('Flight_Finder');
      expect(threadReturns[0].data.toAgent).toBe('Trip_Planner');

      // Both completions should be successful
      expect(delegateCompletes[0].data.success).toBe(true);
      expect(delegateCompletes[1].data.success).toBe(true);
    });

    test('results from both delegates should be merged into parent context', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([MULTI_DELEGATE_PLANNER], 'Trip_Planner'),
      );
      executor.registerAgent('Flight_Finder', FLIGHT_FINDER_AGENT);
      executor.registerAgent('Hotel_Finder', HOTEL_FINDER_AGENT);

      session.data.values.destination = 'Tokyo';
      session.data.values.travel_date = '2026-07-01';
      session.data.values.destination = 'Tokyo';
      session.data.values.travel_date = '2026-07-01';

      mockClient.setResponseHandler((systemPrompt, messages, tools) => {
        // Child agent reasoning calls — children have no tools, detect by system prompt
        const hasDelegateTool = (tools as any[]).some((t) => t.name.startsWith('delegate_to_'));
        if (!hasDelegateTool && systemPrompt.includes('Flight')) {
          return {
            text: '{"flight_id": "TK-789", "flight_price": 850}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [{ type: 'text', text: '{"flight_id": "TK-789", "flight_price": 850}' }],
          };
        }
        if (!hasDelegateTool && systemPrompt.includes('Hotel')) {
          return {
            text: '{"hotel_name": "Tokyo Imperial", "hotel_price": 250}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [
              { type: 'text', text: '{"hotel_name": "Tokyo Imperial", "hotel_price": 250}' },
            ],
          };
        }

        // Entity extraction calls (_extract_entities tool)
        if (tools.length === 1 && (tools[0] as any).name === '_extract_entities') {
          return {
            text: '',
            toolCalls: [{ id: 'extract-1', name: '_extract_entities', input: {} }],
            stopReason: 'tool_use',
            rawContent: [
              { type: 'tool_use', id: 'extract-1', name: '_extract_entities', input: {} },
            ],
          };
        }

        // Parent agent reasoning calls with delegate_to_* tools
        const parentCallCount = mockClient.calls.filter((c) =>
          (c.tools as any[]).some((t) => t.name.startsWith('delegate_to_')),
        ).length;

        if (parentCallCount <= 1) {
          return {
            text: '',
            toolCalls: [{ id: 'df1', name: 'delegate_to_Flight_Finder', input: {} }],
            stopReason: 'tool_use',
            rawContent: [
              {
                type: 'tool_use',
                id: 'df1',
                name: 'delegate_to_Flight_Finder',
                input: {},
              },
            ],
          };
        }
        if (parentCallCount === 2) {
          return {
            text: '',
            toolCalls: [{ id: 'dh1', name: 'delegate_to_Hotel_Finder', input: {} }],
            stopReason: 'tool_use',
            rawContent: [
              {
                type: 'tool_use',
                id: 'dh1',
                name: 'delegate_to_Hotel_Finder',
                input: {},
              },
            ],
          };
        }
        return {
          text: 'Trip planned to Tokyo!',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Trip planned to Tokyo!' }],
        };
      });

      await executor.executeMessage(session.id, 'Plan trip to Tokyo', undefined, undefined);

      // Flight results should be in context (from RETURNS mapping)
      expect(session.data.values.flight_id).toBe('TK-789');
      expect(session.data.values.flight_price).toBe(850);

      // Hotel results should also be in context
      expect(session.data.values.hotel_name).toBe('Tokyo Imperial');
      expect(session.data.values.hotel_price).toBe(250);

      // Both USE_RESULT keys should exist
      expect(session.data.values.flight_quote).toBeDefined();
      expect(session.data.values.hotel_quote).toBeDefined();

      // data.values should also have the mapped RETURNS values
      expect(session.data.values.flight_id).toBe('TK-789');
      expect(session.data.values.hotel_name).toBe('Tokyo Imperial');
    });

    test('second delegate should have access to first delegate results in context', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([MULTI_DELEGATE_PLANNER], 'Trip_Planner'),
      );
      executor.registerAgent('Flight_Finder', FLIGHT_FINDER_AGENT);
      executor.registerAgent('Hotel_Finder', HOTEL_FINDER_AGENT);

      session.data.values.destination = 'London';
      session.data.values.travel_date = '2026-05-20';

      mockClient.setResponseHandler((systemPrompt, messages, tools) => {
        // Child agent reasoning calls — children have no tools, detect by system prompt
        const hasDelegateTool = (tools as any[]).some((t) => t.name.startsWith('delegate_to_'));
        if (!hasDelegateTool && systemPrompt.includes('Flight')) {
          return {
            text: '{"flight_id": "BA-100", "flight_price": 300}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [{ type: 'text', text: '{"flight_id": "BA-100", "flight_price": 300}' }],
          };
        }
        if (!hasDelegateTool && systemPrompt.includes('Hotel')) {
          return {
            text: '{"hotel_name": "The Ritz", "hotel_price": 400}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [{ type: 'text', text: '{"hotel_name": "The Ritz", "hotel_price": 400}' }],
          };
        }

        // Entity extraction calls (_extract_entities tool)
        if (tools.length === 1 && (tools[0] as any).name === '_extract_entities') {
          return {
            text: '',
            toolCalls: [{ id: 'extract-1', name: '_extract_entities', input: {} }],
            stopReason: 'tool_use',
            rawContent: [
              { type: 'tool_use', id: 'extract-1', name: '_extract_entities', input: {} },
            ],
          };
        }

        // Parent agent reasoning calls with delegate_to_* tools
        const parentCallCount = mockClient.calls.filter((c) =>
          (c.tools as any[]).some((t) => t.name.startsWith('delegate_to_')),
        ).length;

        if (parentCallCount <= 1) {
          return {
            text: '',
            toolCalls: [{ id: 'f1', name: 'delegate_to_Flight_Finder', input: {} }],
            stopReason: 'tool_use',
            rawContent: [
              {
                type: 'tool_use',
                id: 'f1',
                name: 'delegate_to_Flight_Finder',
                input: {},
              },
            ],
          };
        }
        if (parentCallCount === 2) {
          return {
            text: '',
            toolCalls: [{ id: 'h1', name: 'delegate_to_Hotel_Finder', input: {} }],
            stopReason: 'tool_use',
            rawContent: [
              {
                type: 'tool_use',
                id: 'h1',
                name: 'delegate_to_Hotel_Finder',
                input: {},
              },
            ],
          };
        }
        return {
          text: 'All booked!',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'All booked!' }],
        };
      });

      await executor.executeMessage(session.id, 'Plan trip to London', undefined, undefined);

      // After first delegate completes, flight results should be in context
      // BEFORE second delegate runs. Verify final context has both:
      expect(session.data.values.flight_id).toBe('BA-100');
      expect(session.data.values.flight_price).toBe(300);
      expect(session.data.values.hotel_name).toBe('The Ritz');
      expect(session.data.values.hotel_price).toBe(400);

      // Flight quote should be stored under USE_RESULT key
      expect(session.data.values.flight_quote).toBeDefined();
      // Hotel quote should also be stored
      expect(session.data.values.hotel_quote).toBeDefined();
    });
  });

  // ===========================================================================
  // 2. Trace events for multi-delegate
  // ===========================================================================

  describe('Multi-Delegate Trace Events', () => {
    test('should emit paired delegate_start/delegate_complete for each delegate', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([MULTI_DELEGATE_PLANNER], 'Trip_Planner'),
      );
      executor.registerAgent('Flight_Finder', FLIGHT_FINDER_AGENT);
      executor.registerAgent('Hotel_Finder', HOTEL_FINDER_AGENT);

      session.data.values.destination = 'Rome';
      session.data.values.travel_date = '2026-09-10';

      mockClient.setResponseHandler((systemPrompt, messages, tools) => {
        if (systemPrompt.includes('entity extraction assistant')) {
          return {
            text: '{}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [{ type: 'text', text: '{}' }],
          };
        }
        const hasDelegateTool = (tools as any[]).some((t) => t.name.startsWith('delegate_to_'));
        if (!hasDelegateTool) {
          if (systemPrompt.includes('Flight')) {
            return {
              text: '{"flight_id": "AZ-55", "flight_price": 200}',
              toolCalls: [],
              stopReason: 'end_turn',
              rawContent: [{ type: 'text', text: '{"flight_id": "AZ-55", "flight_price": 200}' }],
            };
          }
          return {
            text: '{"hotel_name": "Roma Luxe", "hotel_price": 150}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [{ type: 'text', text: '{"hotel_name": "Roma Luxe", "hotel_price": 150}' }],
          };
        }
        const parentCallCount = mockClient.calls.filter((c) =>
          (c.tools as any[]).some((t) => t.name.startsWith('delegate_to_')),
        ).length;
        if (parentCallCount <= 1) {
          return {
            text: '',
            toolCalls: [{ id: 'f1', name: 'delegate_to_Flight_Finder', input: {} }],
            stopReason: 'tool_use',
            rawContent: [
              {
                type: 'tool_use',
                id: 'f1',
                name: 'delegate_to_Flight_Finder',
                input: {},
              },
            ],
          };
        }
        if (parentCallCount === 2) {
          return {
            text: '',
            toolCalls: [{ id: 'h1', name: 'delegate_to_Hotel_Finder', input: {} }],
            stopReason: 'tool_use',
            rawContent: [
              {
                type: 'tool_use',
                id: 'h1',
                name: 'delegate_to_Hotel_Finder',
                input: {},
              },
            ],
          };
        }
        return {
          text: 'Done!',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Done!' }],
        };
      });

      const traceCollector = createTraceCollector();
      await executor.executeMessage(
        session.id,
        'Plan Rome trip',
        undefined,
        traceCollector.callback,
      );

      // Verify paired traces
      const starts = filterTraces(traceCollector.traces, 'delegate_start');
      const completes = filterTraces(traceCollector.traces, 'delegate_complete');
      expect(starts.length).toBe(2);
      expect(completes.length).toBe(2);

      // Flight delegate traces
      expect(starts[0].data.from).toBe('Trip_Planner');
      expect(starts[0].data.to).toBe('Flight_Finder');
      expect(starts[0].data.purpose).toBe('Find the best flights to the destination');
      expect(completes[0].data.to).toBe('Flight_Finder');
      expect(completes[0].data.success).toBe(true);

      // Hotel delegate traces
      expect(starts[1].data.from).toBe('Trip_Planner');
      expect(starts[1].data.to).toBe('Hotel_Finder');
      expect(starts[1].data.purpose).toBe('Find hotel accommodations at the destination');
      expect(completes[1].data.to).toBe('Hotel_Finder');
      expect(completes[1].data.success).toBe(true);

      // Should also have LLM call traces from both child agents
      const llmTraces = filterTraces(traceCollector.traces, 'llm_call');
      expect(llmTraces.length).toBeGreaterThanOrEqual(3); // parent + 2 children minimum
    });

    test('should emit dsl_collect from each reasoning child with GATHER fields', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([MULTI_DELEGATE_PLANNER], 'Trip_Planner'),
      );
      executor.registerAgent('Flight_Finder', FLIGHT_FINDER_AGENT);
      executor.registerAgent('Hotel_Finder', HOTEL_FINDER_AGENT);

      session.data.values.destination = 'Berlin';
      session.data.values.travel_date = '2026-11-05';

      mockClient.setResponseHandler((systemPrompt, messages, tools) => {
        if (systemPrompt.includes('entity extraction assistant')) {
          // Entity extraction calls use a dedicated prompt ("entity extraction assistant"),
          // NOT the agent's system prompt. Detect the child by checking which GATHER
          // fields appear in the extraction prompt (field descriptions).
          if (systemPrompt.includes('"destination"')) {
            return {
              text: '{"destination": "Berlin"}',
              toolCalls: [],
              stopReason: 'end_turn',
              rawContent: [{ type: 'text', text: '{"destination": "Berlin"}' }],
            };
          }
          if (systemPrompt.includes('"city"')) {
            return {
              text: '{"city": "Berlin"}',
              toolCalls: [],
              stopReason: 'end_turn',
              rawContent: [{ type: 'text', text: '{"city": "Berlin"}' }],
            };
          }
          return {
            text: '{}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [{ type: 'text', text: '{}' }],
          };
        }
        const hasDelegateTool = (tools as any[]).some((t) => t.name.startsWith('delegate_to_'));
        if (!hasDelegateTool) {
          return {
            text: '{"result": "ok"}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [{ type: 'text', text: '{"result": "ok"}' }],
          };
        }
        const parentCallCount = mockClient.calls.filter((c) =>
          (c.tools as any[]).some((t) => t.name.startsWith('delegate_to_')),
        ).length;
        if (parentCallCount <= 1) {
          return {
            text: '',
            toolCalls: [{ id: 'f1', name: 'delegate_to_Flight_Finder', input: {} }],
            stopReason: 'tool_use',
            rawContent: [
              {
                type: 'tool_use',
                id: 'f1',
                name: 'delegate_to_Flight_Finder',
                input: {},
              },
            ],
          };
        }
        if (parentCallCount === 2) {
          return {
            text: '',
            toolCalls: [{ id: 'h1', name: 'delegate_to_Hotel_Finder', input: {} }],
            stopReason: 'tool_use',
            rawContent: [
              {
                type: 'tool_use',
                id: 'h1',
                name: 'delegate_to_Hotel_Finder',
                input: {},
              },
            ],
          };
        }
        return {
          text: 'Done!',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Done!' }],
        };
      });

      const traceCollector = createTraceCollector();
      await executor.executeMessage(
        session.id,
        'Plan Berlin trip',
        undefined,
        traceCollector.callback,
      );

      // Both children have GATHER fields, so they should emit dsl_collect
      const collectTraces = filterTraces(traceCollector.traces, 'dsl_collect');
      const reasoningGathers = collectTraces.filter((t) => t.data.mode === 'reasoning_gather');

      // At least one dsl_collect from each child that extracted something
      const flightCollects = reasoningGathers.filter((t) => t.data.agentName === 'Flight_Finder');
      const hotelCollects = reasoningGathers.filter((t) => t.data.agentName === 'Hotel_Finder');
      expect(flightCollects.length).toBeGreaterThanOrEqual(1);
      expect(hotelCollects.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ===========================================================================
  // 3. Partial failure: one delegate fails, other succeeds
  // ===========================================================================

  describe('Multi-Delegate Partial Failure', () => {
    test('first delegate succeeds, second fails — partial results preserved', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([MULTI_DELEGATE_PLANNER], 'Trip_Planner'),
      );
      executor.registerAgent('Flight_Finder', FLIGHT_FINDER_AGENT);
      // Hotel_Finder is NOT registered — will cause "Agent not found" error

      session.data.values.destination = 'Barcelona';
      session.data.values.travel_date = '2026-08-20';

      mockClient.setResponseHandler((systemPrompt, messages, tools) => {
        // Child agent reasoning calls — children have no tools, detect by system prompt
        const hasDelegateTool = (tools as any[]).some((t) => t.name.startsWith('delegate_to_'));
        if (
          !hasDelegateTool &&
          (systemPrompt.includes('Flight') || systemPrompt.includes('Hotel'))
        ) {
          return {
            text: '{"flight_id": "VY-200", "flight_price": 120}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [{ type: 'text', text: '{"flight_id": "VY-200", "flight_price": 120}' }],
          };
        }

        // Entity extraction calls (_extract_entities tool)
        if (tools.length === 1 && (tools[0] as any).name === '_extract_entities') {
          return {
            text: '',
            toolCalls: [{ id: 'extract-1', name: '_extract_entities', input: {} }],
            stopReason: 'tool_use',
            rawContent: [
              { type: 'tool_use', id: 'extract-1', name: '_extract_entities', input: {} },
            ],
          };
        }

        const parentCallCount = mockClient.calls.filter((c) =>
          (c.tools as any[]).some((t) => t.name.startsWith('delegate_to_')),
        ).length;
        if (parentCallCount <= 1) {
          return {
            text: '',
            toolCalls: [{ id: 'f1', name: 'delegate_to_Flight_Finder', input: {} }],
            stopReason: 'tool_use',
            rawContent: [
              {
                type: 'tool_use',
                id: 'f1',
                name: 'delegate_to_Flight_Finder',
                input: {},
              },
            ],
          };
        }
        if (parentCallCount === 2) {
          return {
            text: '',
            toolCalls: [{ id: 'h1', name: 'delegate_to_Hotel_Finder', input: {} }],
            stopReason: 'tool_use',
            rawContent: [
              {
                type: 'tool_use',
                id: 'h1',
                name: 'delegate_to_Hotel_Finder',
                input: {},
              },
            ],
          };
        }
        // After hotel failure, LLM gives final response with partial results
        return {
          text: 'Found flights but hotels unavailable. Flight VY-200 for $120.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [
            { type: 'text', text: 'Found flights but hotels unavailable. Flight VY-200 for $120.' },
          ],
        };
      });

      const traceCollector = createTraceCollector();
      const result = await executor.executeMessage(
        session.id,
        'Plan Barcelona trip',
        undefined,
        traceCollector.callback,
      );

      // Flight results should be preserved in context
      expect(session.data.values.flight_id).toBe('VY-200');
      expect(session.data.values.flight_price).toBe(120);
      expect(session.data.values.flight_quote).toBeDefined();

      // Hotel results should NOT be in context
      expect(session.data.values.hotel_name).toBeUndefined();
      expect(session.data.values.hotel_price).toBeUndefined();

      // Traces: 2 delegate_start, 2 delegate_complete (one success, one failure)
      const starts = filterTraces(traceCollector.traces, 'delegate_start');
      const completes = filterTraces(traceCollector.traces, 'delegate_complete');
      expect(starts.length).toBe(2);
      expect(completes.length).toBe(2);

      // Flight delegate succeeded
      expect(completes[0].data.success).toBe(true);
      expect(completes[0].data.to).toBe('Flight_Finder');

      // Hotel delegate failed
      expect(completes[1].data.success).toBe(false);
      expect(completes[1].data.to).toBe('Hotel_Finder');
    });

    test('ON_FAILURE: respond should add failure message to conversation', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([MULTI_DELEGATE_PLANNER], 'Trip_Planner'),
      );
      executor.registerAgent('Flight_Finder', FLIGHT_FINDER_AGENT);
      // Hotel_Finder missing — ON_FAILURE: RESPOND "Unable to find hotels right now"

      session.data.values.destination = 'Lisbon';
      session.data.values.travel_date = '2026-10-01';

      mockClient.setResponseHandler((systemPrompt, messages, tools) => {
        if (systemPrompt.includes('entity extraction assistant')) {
          return {
            text: '{}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [{ type: 'text', text: '{}' }],
          };
        }
        const hasDelegateTool = (tools as any[]).some((t) => t.name.startsWith('delegate_to_'));
        if (!hasDelegateTool) {
          return {
            text: '{"flight_id": "TP-50", "flight_price": 200}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [{ type: 'text', text: '{"flight_id": "TP-50", "flight_price": 200}' }],
          };
        }
        const parentCallCount = mockClient.calls.filter((c) =>
          (c.tools as any[]).some((t) => t.name.startsWith('delegate_to_')),
        ).length;
        if (parentCallCount <= 1) {
          return {
            text: '',
            toolCalls: [{ id: 'f1', name: 'delegate_to_Flight_Finder', input: {} }],
            stopReason: 'tool_use',
            rawContent: [
              {
                type: 'tool_use',
                id: 'f1',
                name: 'delegate_to_Flight_Finder',
                input: {},
              },
            ],
          };
        }
        if (parentCallCount === 2) {
          return {
            text: '',
            toolCalls: [{ id: 'h1', name: 'delegate_to_Hotel_Finder', input: {} }],
            stopReason: 'tool_use',
            rawContent: [
              {
                type: 'tool_use',
                id: 'h1',
                name: 'delegate_to_Hotel_Finder',
                input: {},
              },
            ],
          };
        }
        return {
          text: 'Flights booked, hotels need manual search.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Flights booked, hotels need manual search.' }],
        };
      });

      await executor.executeMessage(session.id, 'Plan Lisbon trip', undefined, undefined);

      // The ON_FAILURE message should have been added to conversation history
      const failureMsg = session.conversationHistory.find(
        (m) => m.role === 'assistant' && m.content.includes('Unable to find hotels'),
      );
      expect(failureMsg).toBeDefined();
    });
  });

  // ===========================================================================
  // 4. Three-agent delegation
  // ===========================================================================

  describe('Triple-Agent Delegation', () => {
    test('should delegate to three agents sequentially and merge all results', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([TRIPLE_DELEGATE_PLANNER], 'Full_Planner'),
      );
      executor.registerAgent('Flight_Finder', FLIGHT_FINDER_AGENT);
      executor.registerAgent('Hotel_Finder', HOTEL_FINDER_AGENT);
      executor.registerAgent('Activity_Finder', ACTIVITY_FINDER_AGENT);

      session.data.values.destination = 'Barcelona';
      session.data.values.travel_date = '2026-04-15';

      mockClient.setResponseHandler((systemPrompt, messages, tools) => {
        // Child agent reasoning calls — children have no tools, detect by system prompt
        const hasDelegateTool = (tools as any[]).some((t) => t.name.startsWith('delegate_to_'));
        if (!hasDelegateTool && systemPrompt.includes('Flight')) {
          return {
            text: '{"flight_id": "VY-400", "flight_price": 180}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [{ type: 'text', text: '{"flight_id": "VY-400", "flight_price": 180}' }],
          };
        }
        if (!hasDelegateTool && systemPrompt.includes('Hotel')) {
          return {
            text: '{"hotel_name": "Casa Batllo B&B", "hotel_price": 95}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [
              { type: 'text', text: '{"hotel_name": "Casa Batllo B&B", "hotel_price": 95}' },
            ],
          };
        }
        if (
          !hasDelegateTool &&
          (systemPrompt.includes('Activity') || systemPrompt.includes('activity'))
        ) {
          return {
            text: '{"activity_name": "Sagrada Familia Tour", "activity_price": 35}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [
              {
                type: 'text',
                text: '{"activity_name": "Sagrada Familia Tour", "activity_price": 35}',
              },
            ],
          };
        }

        // Entity extraction calls (_extract_entities tool)
        if (tools.length === 1 && (tools[0] as any).name === '_extract_entities') {
          return {
            text: '',
            toolCalls: [{ id: 'extract-1', name: '_extract_entities', input: {} }],
            stopReason: 'tool_use',
            rawContent: [
              { type: 'tool_use', id: 'extract-1', name: '_extract_entities', input: {} },
            ],
          };
        }

        const parentCallCount = mockClient.calls.filter((c) =>
          (c.tools as any[]).some((t) => t.name.startsWith('delegate_to_')),
        ).length;
        if (parentCallCount <= 1) {
          return {
            text: '',
            toolCalls: [{ id: 'f1', name: 'delegate_to_Flight_Finder', input: {} }],
            stopReason: 'tool_use',
            rawContent: [
              {
                type: 'tool_use',
                id: 'f1',
                name: 'delegate_to_Flight_Finder',
                input: {},
              },
            ],
          };
        }
        if (parentCallCount === 2) {
          return {
            text: '',
            toolCalls: [{ id: 'h1', name: 'delegate_to_Hotel_Finder', input: {} }],
            stopReason: 'tool_use',
            rawContent: [
              {
                type: 'tool_use',
                id: 'h1',
                name: 'delegate_to_Hotel_Finder',
                input: {},
              },
            ],
          };
        }
        if (parentCallCount === 3) {
          return {
            text: '',
            toolCalls: [{ id: 'a1', name: 'delegate_to_Activity_Finder', input: {} }],
            stopReason: 'tool_use',
            rawContent: [
              {
                type: 'tool_use',
                id: 'a1',
                name: 'delegate_to_Activity_Finder',
                input: {},
              },
            ],
          };
        }
        return {
          text: 'Complete Barcelona trip: Flight VY-400 ($180), Casa Batllo B&B ($95/night), Sagrada Familia Tour ($35). Total: $310.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Complete Barcelona trip planned!' }],
        };
      });

      const traceCollector = createTraceCollector();
      const result = await executor.executeMessage(
        session.id,
        'Full Barcelona trip plan',
        undefined,
        traceCollector.callback,
      );

      // All three delegate results should be in context
      expect(session.data.values.flight_id).toBe('VY-400');
      expect(session.data.values.flight_price).toBe(180);
      expect(session.data.values.hotel_name).toBe('Casa Batllo B&B');
      expect(session.data.values.hotel_price).toBe(95);
      expect(session.data.values.activity_name).toBe('Sagrada Familia Tour');
      expect(session.data.values.activity_price).toBe(35);

      // All USE_RESULT keys should exist
      expect(session.data.values.flight_quote).toBeDefined();
      expect(session.data.values.hotel_quote).toBeDefined();
      expect(session.data.values.activity_quote).toBeDefined();

      // data.values should have all mapped values
      expect(session.data.values.flight_id).toBe('VY-400');
      expect(session.data.values.hotel_name).toBe('Casa Batllo B&B');
      expect(session.data.values.activity_name).toBe('Sagrada Familia Tour');

      // 3 delegate_start and 3 delegate_complete
      const starts = filterTraces(traceCollector.traces, 'delegate_start');
      const completes = filterTraces(traceCollector.traces, 'delegate_complete');
      expect(starts.length).toBe(3);
      expect(completes.length).toBe(3);
      expect(starts.map((s) => s.data.to)).toEqual([
        'Flight_Finder',
        'Hotel_Finder',
        'Activity_Finder',
      ]);
    });

    test('third delegate failure should not lose first two delegate results', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([TRIPLE_DELEGATE_PLANNER], 'Full_Planner'),
      );
      executor.registerAgent('Flight_Finder', FLIGHT_FINDER_AGENT);
      executor.registerAgent('Hotel_Finder', HOTEL_FINDER_AGENT);
      // Activity_Finder NOT registered — will fail

      session.data.values.destination = 'Madrid';
      session.data.values.travel_date = '2026-03-01';

      mockClient.setResponseHandler((systemPrompt, messages, tools) => {
        // Entity extraction calls (_extract_entities tool) — check first since child prompts also contain agent names
        if (tools.length === 1 && (tools[0] as any).name === '_extract_entities') {
          if (systemPrompt.includes('Flight')) {
            return {
              text: '',
              toolCalls: [
                {
                  id: 'extract-1',
                  name: '_extract_entities',
                  input: { flight_id: 'IB-300', flight_price: 150 },
                },
              ],
              stopReason: 'tool_use',
              rawContent: [
                {
                  type: 'tool_use',
                  id: 'extract-1',
                  name: '_extract_entities',
                  input: { flight_id: 'IB-300', flight_price: 150 },
                },
              ],
            };
          }
          if (systemPrompt.includes('Hotel')) {
            return {
              text: '',
              toolCalls: [
                {
                  id: 'extract-1',
                  name: '_extract_entities',
                  input: { hotel_name: 'Hotel Madrid', hotel_price: 110 },
                },
              ],
              stopReason: 'tool_use',
              rawContent: [
                {
                  type: 'tool_use',
                  id: 'extract-1',
                  name: '_extract_entities',
                  input: { hotel_name: 'Hotel Madrid', hotel_price: 110 },
                },
              ],
            };
          }
          return {
            text: '',
            toolCalls: [{ id: 'extract-1', name: '_extract_entities', input: {} }],
            stopReason: 'tool_use',
            rawContent: [
              { type: 'tool_use', id: 'extract-1', name: '_extract_entities', input: {} },
            ],
          };
        }

        // Child reasoning calls — return JSON text (delegate stores child response text)
        if (
          systemPrompt.includes('Flight') &&
          !tools.some((t: any) => t.name.startsWith('delegate_to_'))
        ) {
          return {
            text: '{"flight_id": "IB-300", "flight_price": 150}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [{ type: 'text', text: '{"flight_id": "IB-300", "flight_price": 150}' }],
          };
        }
        if (
          systemPrompt.includes('Hotel') &&
          !tools.some((t: any) => t.name.startsWith('delegate_to_'))
        ) {
          return {
            text: '{"hotel_name": "Hotel Madrid", "hotel_price": 110}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [
              { type: 'text', text: '{"hotel_name": "Hotel Madrid", "hotel_price": 110}' },
            ],
          };
        }

        const parentCallCount = mockClient.calls.filter((c) =>
          (c.tools as any[]).some((t) => t.name.startsWith('delegate_to_')),
        ).length;
        if (parentCallCount <= 1) {
          return {
            text: '',
            toolCalls: [{ id: 'f1', name: 'delegate_to_Flight_Finder', input: {} }],
            stopReason: 'tool_use',
            rawContent: [
              {
                type: 'tool_use',
                id: 'f1',
                name: 'delegate_to_Flight_Finder',
                input: {},
              },
            ],
          };
        }
        if (parentCallCount === 2) {
          return {
            text: '',
            toolCalls: [{ id: 'h1', name: 'delegate_to_Hotel_Finder', input: {} }],
            stopReason: 'tool_use',
            rawContent: [
              {
                type: 'tool_use',
                id: 'h1',
                name: 'delegate_to_Hotel_Finder',
                input: {},
              },
            ],
          };
        }
        if (parentCallCount === 3) {
          return {
            text: '',
            toolCalls: [{ id: 'a1', name: 'delegate_to_Activity_Finder', input: {} }],
            stopReason: 'tool_use',
            rawContent: [
              {
                type: 'tool_use',
                id: 'a1',
                name: 'delegate_to_Activity_Finder',
                input: {},
              },
            ],
          };
        }
        return {
          text: 'Flights and hotel booked, activities unavailable.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Flights and hotel booked, activities unavailable.' }],
        };
      });

      const traceCollector = createTraceCollector();
      await executor.executeMessage(
        session.id,
        'Full Madrid trip',
        undefined,
        traceCollector.callback,
      );

      // First two delegate results preserved
      expect(session.data.values.flight_id).toBe('IB-300');
      expect(session.data.values.flight_price).toBe(150);
      expect(session.data.values.hotel_name).toBe('Hotel Madrid');
      expect(session.data.values.hotel_price).toBe(110);

      // Third delegate result should NOT exist
      expect(session.data.values.activity_name).toBeUndefined();
      expect(session.data.values.activity_price).toBeUndefined();

      // Trace verification
      const completes = filterTraces(traceCollector.traces, 'delegate_complete');
      expect(completes.length).toBe(3);
      expect(completes[0].data.success).toBe(true);
      expect(completes[1].data.success).toBe(true);
      expect(completes[2].data.success).toBe(false);
    });
  });

  // ===========================================================================
  // 5. INPUT mapping from context with prior delegate results
  // ===========================================================================

  describe('Delegate INPUT Mapping', () => {
    test('executeDelegate should map INPUT fields from parent context', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([MULTI_DELEGATE_PLANNER], 'Trip_Planner'),
      );
      executor.registerAgent('Flight_Finder', FLIGHT_FINDER_AGENT);

      session.data.values.destination = 'Vienna';
      session.data.values.travel_date = '2026-12-20';

      mockClient.setEntityExtractionResponse({});

      const executeDelegate = (executor as any).routing.executeDelegate.bind(
        (executor as any).routing,
      );
      const traceCollector = createTraceCollector();

      const delegateConfig = session.agentIR?.coordination?.delegates?.find(
        (d: any) => d.agent === 'Flight_Finder',
      );

      await executeDelegate(
        session,
        'Flight_Finder',
        delegateConfig,
        undefined, // no override — should use INPUT mapping
        undefined, // message
        undefined, // onChunk
        traceCollector.callback,
      );

      // The delegate_start trace should show the mapped input
      const startTraces = filterTraces(traceCollector.traces, 'delegate_start');
      expect(startTraces.length).toBe(1);
      expect(startTraces[0].data.input).toBeDefined();

      const input = startTraces[0].data.input as Record<string, unknown>;
      expect(input.destination).toBe('Vienna');
      expect(input.date).toBe('2026-12-20');
    });

    test('delegate child session should receive mapped input as context', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([MULTI_DELEGATE_PLANNER], 'Trip_Planner'),
      );
      executor.registerAgent('Hotel_Finder', HOTEL_FINDER_AGENT);

      session.data.values.destination = 'Prague';
      session.data.values.travel_date = '2026-05-10';

      mockClient.setEntityExtractionResponse({});

      const executeDelegate = (executor as any).routing.executeDelegate.bind(
        (executor as any).routing,
      );
      const delegateConfig = session.agentIR?.coordination?.delegates?.find(
        (d: any) => d.agent === 'Hotel_Finder',
      );

      // Track the child session before it gets cleaned up
      let capturedChildContext: Record<string, unknown> | undefined;
      const originalExecuteMessage = executor.executeMessage.bind(executor);
      const executeMessageSpy = vi.fn(
        async (sessionId: string, msg: string, onChunk: any, onTrace: any) => {
          const childSession = (executor as any).sessions.get(sessionId) as RuntimeSession;
          if (childSession?.agentName === 'Hotel_Finder') {
            capturedChildContext = { ...childSession.data.values };
          }
          return originalExecuteMessage(sessionId, msg, onChunk, onTrace);
        },
      );
      (executor as any).executeMessage = executeMessageSpy;

      await executeDelegate(
        session,
        'Hotel_Finder',
        delegateConfig,
        undefined,
        undefined,
        undefined,
      );

      // The child session should have received the mapped input
      expect(capturedChildContext).toBeDefined();
      expect(capturedChildContext!.city).toBe('Prague');
      expect(capturedChildContext!.checkin).toBe('2026-05-10');
      expect(capturedChildContext!.delegate_from).toBe('Trip_Planner');
    });
  });

  // ===========================================================================
  // 6. Delegate result storage in data.values
  // ===========================================================================

  describe('Delegate Result Storage', () => {
    test('each delegate should store result in data.values via use_result key', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([MULTI_DELEGATE_PLANNER], 'Trip_Planner'),
      );
      executor.registerAgent('Flight_Finder', FLIGHT_FINDER_AGENT);
      executor.registerAgent('Hotel_Finder', HOTEL_FINDER_AGENT);

      session.data.values.destination = 'Athens';
      session.data.values.travel_date = '2026-06-01';

      mockClient.setResponseHandler((systemPrompt, messages, tools) => {
        // Child agent reasoning calls — children have no tools, detect by system prompt
        const hasDelegateTool = (tools as any[]).some((t) => t.name.startsWith('delegate_to_'));
        if (!hasDelegateTool && systemPrompt.includes('Flight')) {
          return {
            text: '{"flight_id": "OA-10"}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [{ type: 'text', text: '{"flight_id": "OA-10"}' }],
          };
        }
        if (!hasDelegateTool && systemPrompt.includes('Hotel')) {
          return {
            text: '{"hotel_name": "Acropolis View"}',
            toolCalls: [],
            stopReason: 'end_turn',
            rawContent: [{ type: 'text', text: '{"hotel_name": "Acropolis View"}' }],
          };
        }

        // Entity extraction calls (_extract_entities tool)
        if (tools.length === 1 && (tools[0] as any).name === '_extract_entities') {
          return {
            text: '',
            toolCalls: [{ id: 'extract-1', name: '_extract_entities', input: {} }],
            stopReason: 'tool_use',
            rawContent: [
              { type: 'tool_use', id: 'extract-1', name: '_extract_entities', input: {} },
            ],
          };
        }

        const parentCallCount = mockClient.calls.filter((c) =>
          (c.tools as any[]).some((t) => t.name.startsWith('delegate_to_')),
        ).length;
        if (parentCallCount <= 1) {
          return {
            text: '',
            toolCalls: [{ id: 'f1', name: 'delegate_to_Flight_Finder', input: {} }],
            stopReason: 'tool_use',
            rawContent: [
              {
                type: 'tool_use',
                id: 'f1',
                name: 'delegate_to_Flight_Finder',
                input: {},
              },
            ],
          };
        }
        if (parentCallCount === 2) {
          return {
            text: '',
            toolCalls: [{ id: 'h1', name: 'delegate_to_Hotel_Finder', input: {} }],
            stopReason: 'tool_use',
            rawContent: [
              {
                type: 'tool_use',
                id: 'h1',
                name: 'delegate_to_Hotel_Finder',
                input: {},
              },
            ],
          };
        }
        return {
          text: 'Athens trip ready!',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Athens trip ready!' }],
        };
      });

      await executor.executeMessage(session.id, 'Plan Athens trip', undefined, undefined);

      // Both delegates' results should be stored in data.values via different keys
      expect(session.data.values.flight_quote).toBeDefined();
      expect(session.data.values.hotel_quote).toBeDefined();
      expect(session.data.values.flight_id).toBe('OA-10');
      expect(session.data.values.hotel_name).toBe('Acropolis View');
    });
  });
});

// =============================================================================
// WHEN CONDITION TESTS
// =============================================================================

describe('Delegate WHEN Condition Evaluation', () => {
  let executor: RuntimeExecutor;
  let mockClient: ValidatingMockAnthropicClient;

  beforeEach(() => {
    executor = new RuntimeExecutor();
    mockClient = injectValidatingMockClient(executor);
  });

  test('delegate should execute when WHEN condition is met', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([AGENT_WITH_DELEGATE], 'Booking_Manager'),
    );
    executor.registerAgent('Fee_Calculator', REASONING_FEE_CALCULATOR);

    // Pre-populate context so WHEN condition (action_type == "modify") passes
    session.data.values.action_type = 'modify';
    session.data.values.action_type = 'modify';
    session.data.values.booking_id = 'BK-100';
    session.data.values.booking_id = 'BK-100';
    Object.assign(session.data.values, { action_type: 'modify', booking_id: 'BK-100' });

    mockClient.setEntityExtractionResponse({});

    const handleDelegate = (executor as any).routing.handleDelegate.bind((executor as any).routing);
    const traceCollector = createTraceCollector();

    const result = await handleDelegate(
      session,
      { target: 'Fee_Calculator', input: {} },
      undefined,
      traceCollector.callback,
    );

    expect(result.success).toBe(true);
  });

  test('delegate should be blocked when WHEN condition is NOT met', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([AGENT_WITH_DELEGATE], 'Booking_Manager'),
    );
    executor.registerAgent('Fee_Calculator', REASONING_FEE_CALCULATOR);

    // action_type is NOT "modify" → WHEN condition fails
    session.data.values.action_type = 'cancel';
    session.data.values.action_type = 'cancel';
    Object.assign(session.data.values, { action_type: 'cancel' });

    const handleDelegate = (executor as any).routing.handleDelegate.bind((executor as any).routing);
    const traceCollector = createTraceCollector();

    const result = await handleDelegate(
      session,
      { target: 'Fee_Calculator', input: {} },
      undefined,
      traceCollector.callback,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('WHEN condition not met');
    expect(result.error).toContain('Fee_Calculator');

    // Should emit constraint_check trace
    const constraintTraces = filterTraces(traceCollector.traces, 'constraint_check');
    expect(constraintTraces.length).toBe(1);
    expect(constraintTraces[0].data.constraintType).toBe('delegate_when');
    expect(constraintTraces[0].data.passed).toBe(false);
  });

  test('IS SET should pass when field is populated in context', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([MULTI_DELEGATE_PLANNER], 'Trip_Planner'),
    );
    executor.registerAgent('Flight_Finder', FLIGHT_FINDER_AGENT);

    // Populate destination so "destination IS SET" passes
    session.data.values.destination = 'Paris';
    session.data.values.destination = 'Paris';
    session.data.values.travel_date = '2026-06-15';
    session.data.values.travel_date = '2026-06-15';
    Object.assign(session.data.values, { destination: 'Paris', travel_date: '2026-06-15' });

    mockClient.setEntityExtractionResponse({});

    const handleDelegate = (executor as any).routing.handleDelegate.bind((executor as any).routing);
    const result = await handleDelegate(
      session,
      { target: 'Flight_Finder', input: {} },
      undefined,
      undefined,
    );

    expect(result.success).toBe(true);
  });

  test('IS SET should fail when field is missing from context', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([MULTI_DELEGATE_PLANNER], 'Trip_Planner'),
    );
    executor.registerAgent('Flight_Finder', FLIGHT_FINDER_AGENT);

    // Do NOT set destination → "destination IS SET" fails
    // data.values already initialized -- no-op

    const handleDelegate = (executor as any).routing.handleDelegate.bind((executor as any).routing);
    const traceCollector = createTraceCollector();

    const result = await handleDelegate(
      session,
      { target: 'Flight_Finder', input: {} },
      undefined,
      traceCollector.callback,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('WHEN condition not met');
    expect(result.error).toContain('destination IS SET');
  });
});

// =============================================================================
// HANDOFF CONTEXT PASSING TESTS (PASS + SUMMARY)
// =============================================================================

describe('Handoff Context Passing (PASS + SUMMARY)', () => {
  let executor: RuntimeExecutor;
  let mockClient: ValidatingMockAnthropicClient;

  beforeEach(() => {
    executor = new RuntimeExecutor();
    mockClient = injectValidatingMockClient(executor);
  });

  test('PASS fields should be extracted from parent state to child context', async () => {
    const supervisorSession = executor.createSessionFromResolved(
      compileToResolvedAgent([SUPERVISOR_WITH_HANDOFFS], 'Travel_Supervisor'),
    );
    executor.registerAgent('Sales_Agent', REASONING_SALES_AGENT);
    supervisorSession.handoffReturnInfo = { Sales_Agent: false };
    supervisorSession.conversationHistory.push({ role: 'user', content: 'travel' });

    // Populate parent state with PASS fields (search_context, user_preferences)
    supervisorSession.data.values.search_context = { query: 'flights to Paris' };
    supervisorSession.data.values.user_preferences = { class: 'business' };
    supervisorSession.data.values.unrelated_field = 'should not pass';
    supervisorSession.data.values.collected_destination = 'Paris';
    supervisorSession.data.gatheredKeys.add('search_context');
    supervisorSession.data.gatheredKeys.add('collected_destination');

    mockClient.setEntityExtractionResponse({});

    const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
    await handleHandoff(
      supervisorSession,
      { target: 'Sales_Agent', context: {} },
      undefined,
      undefined,
    );

    // Active thread should have PASS fields
    const activeThread = supervisorSession.threads[supervisorSession.activeThreadIndex];
    expect(activeThread).toBeDefined();
    expect(activeThread.agentName).toBe('Sales_Agent');
    expect(activeThread.data.values.search_context).toEqual({ query: 'flights to Paris' });
    expect(activeThread.data.values.user_preferences).toEqual({ class: 'business' });
    expect(activeThread.data.values.handoff_from).toBe('Travel_Supervisor');
    // unrelated_field propagates via session metadata (non-gather fields flow through
    // extractSessionMetadata for supervisor → specialist handoffs)
    expect(activeThread.data.values.unrelated_field).toBe('should not pass');
    expect(activeThread.data.values.collected_destination).toBeUndefined();
  });

  test('SUMMARY should be interpolated and set as _handoff_summary', async () => {
    const supervisorSession = executor.createSessionFromResolved(
      compileToResolvedAgent([SUPERVISOR_WITH_HANDOFFS], 'Travel_Supervisor'),
    );
    executor.registerAgent('Sales_Agent', REASONING_SALES_AGENT);
    supervisorSession.handoffReturnInfo = { Sales_Agent: false };
    supervisorSession.conversationHistory.push({ role: 'user', content: 'travel' });

    mockClient.setEntityExtractionResponse({});

    const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
    await handleHandoff(
      supervisorSession,
      { target: 'Sales_Agent', context: {} },
      undefined,
      undefined,
    );

    // Active thread should have _handoff_summary
    const activeThread = supervisorSession.threads[supervisorSession.activeThreadIndex];
    expect(activeThread).toBeDefined();
    // The SUPERVISOR_WITH_HANDOFFS has summary: "User looking to book travel" for Sales_Agent
    expect(activeThread.data.values._handoff_summary).toBe('User looking to book travel');
  });

  test('missing PASS fields should be handled gracefully (not crash)', async () => {
    const supervisorSession = executor.createSessionFromResolved(
      compileToResolvedAgent([SUPERVISOR_WITH_HANDOFFS], 'Travel_Supervisor'),
    );
    executor.registerAgent('Sales_Agent', REASONING_SALES_AGENT);
    supervisorSession.handoffReturnInfo = { Sales_Agent: false };
    supervisorSession.conversationHistory.push({ role: 'user', content: 'travel' });

    // Do NOT set search_context or user_preferences → PASS fields are missing
    mockClient.setEntityExtractionResponse({});

    const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
    const result = await handleHandoff(
      supervisorSession,
      { target: 'Sales_Agent', context: {} },
      undefined,
      undefined,
    );

    expect(result.success).toBe(true);

    const activeThread = supervisorSession.threads[supervisorSession.activeThreadIndex];
    expect(activeThread).toBeDefined();
    expect(activeThread.data.values.handoff_from).toBe('Travel_Supervisor');
    // Missing pass fields should just not be in context (not cause error)
    expect(activeThread.data.values.search_context).toBeUndefined();
  });

  test('LLM context should merge with PASS fields (PASS takes precedence)', async () => {
    const supervisorSession = executor.createSessionFromResolved(
      compileToResolvedAgent([SUPERVISOR_WITH_HANDOFFS], 'Travel_Supervisor'),
    );
    executor.registerAgent('Sales_Agent', REASONING_SALES_AGENT);
    supervisorSession.handoffReturnInfo = { Sales_Agent: false };
    supervisorSession.conversationHistory.push({ role: 'user', content: 'travel' });

    // Set PASS field
    supervisorSession.data.values.search_context = { query: 'original' };
    supervisorSession.data.values.user_preferences = { class: 'economy' };

    mockClient.setEntityExtractionResponse({});

    const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
    await handleHandoff(
      supervisorSession,
      // LLM provides context that tries to override PASS fields — but PASS takes precedence now (bug fix)
      {
        target: 'Sales_Agent',
        context: { search_context: { query: 'overridden by LLM' }, extra_llm_field: 'hello' },
      },
      undefined,
      undefined,
    );

    const activeThread = supervisorSession.threads[supervisorSession.activeThreadIndex];
    expect(activeThread).toBeDefined();
    // PASS fields should take precedence over LLM context (bug fix: was reversed before)
    expect(activeThread.data.values.search_context).toEqual({ query: 'original' });
    // PASS field that wasn't overridden should still be present
    expect(activeThread.data.values.user_preferences).toEqual({ class: 'economy' });
    // LLM extra field should be present
    expect(activeThread.data.values.extra_llm_field).toBe('hello');
  });
});

// =============================================================================
// ENTITY VALIDATION TESTS
// =============================================================================

/**
 * Agent with GATHER fields that have validation rules.
 * We set validation directly on the IR after compilation.
 */
const AGENT_WITH_VALIDATED_GATHER = `
AGENT: Validated_Agent

GOAL: "Collect validated user info"

PERSONA: "Helpful assistant"

GATHER:
  email:
    prompt: "What is your email?"
    type: string
    required: true

  age:
    prompt: "How old are you?"
    type: number
    required: true

  plan:
    prompt: "Which plan?"
    type: string
    required: true

  phone:
    prompt: "Phone number?"
    type: string
    required: false
`;

describe('Entity Extraction Validation', () => {
  let executor: RuntimeExecutor;
  let mockClient: ValidatingMockAnthropicClient;

  function createValidatedSession(): RuntimeSession {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([AGENT_WITH_VALIDATED_GATHER], 'Validated_Agent'),
    );

    // Set validation rules directly on the IR since the parser may compile these as 'custom' type
    const fields = session.agentIR!.gather.fields;
    const emailField = fields.find((f) => f.name === 'email');
    if (emailField) {
      emailField.validation = {
        type: 'pattern',
        rule: '^[^@]+@[^@]+\\.[^@]+$',
        error_message: 'Invalid email format',
      };
    }
    const ageField = fields.find((f) => f.name === 'age');
    if (ageField) {
      ageField.validation = {
        type: 'range',
        rule: '1-120',
        error_message: 'Age must be between 1 and 120',
      };
    }
    const planField = fields.find((f) => f.name === 'plan');
    if (planField) {
      planField.validation = {
        type: 'enum',
        rule: 'basic|pro|enterprise',
        error_message: 'Plan must be basic, pro, or enterprise',
      };
    }
    return session;
  }

  beforeEach(() => {
    executor = new RuntimeExecutor();
    mockClient = injectValidatingMockClient(executor);
  });

  test('pattern validation should reject invalid email', async () => {
    const session = createValidatedSession();

    // LLM extracts an invalid email
    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      if (systemPrompt.includes('entity extraction assistant')) {
        return {
          text: '{"email": "not-an-email", "age": 25, "plan": "pro"}',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [
            { type: 'text', text: '{"email": "not-an-email", "age": 25, "plan": "pro"}' },
          ],
        };
      }
      return {
        text: 'I need a valid email address.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'I need a valid email address.' }],
      };
    });

    const traceCollector = createTraceCollector();
    await executor.executeMessage(
      session.id,
      'My email is not-an-email, I am 25, pro plan',
      undefined,
      traceCollector.callback,
    );

    // email should NOT be in data.values (invalid)
    expect(session.data.values.email).toBeUndefined();
    // age and plan SHOULD be stored (valid)
    expect(session.data.values.age).toBe(25);
    expect(session.data.values.plan).toBe('pro');

    // Check entity_extraction trace has validationErrors
    const extractionTraces = filterTraces(traceCollector.traces, 'entity_extraction');
    const llmExtraction = extractionTraces.find((t) => t.data.method === 'llm');
    expect(llmExtraction).toBeDefined();
    expect(llmExtraction!.data.validationErrors).toBeDefined();
    expect((llmExtraction!.data.validationErrors as Record<string, string>).email).toBe(
      'Invalid email format',
    );
  });

  test('range validation should reject out-of-range number', async () => {
    const session = createValidatedSession();

    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      if (systemPrompt.includes('entity extraction assistant')) {
        return {
          text: '{"email": "user@test.com", "age": 200, "plan": "basic"}',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [
            { type: 'text', text: '{"email": "user@test.com", "age": 200, "plan": "basic"}' },
          ],
        };
      }
      return {
        text: 'Please provide a valid age.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Please provide a valid age.' }],
      };
    });

    const traceCollector = createTraceCollector();
    await executor.executeMessage(
      session.id,
      'email user@test.com, age 200, basic plan',
      undefined,
      traceCollector.callback,
    );

    // age should NOT be stored (out of range)
    expect(session.data.values.age).toBeUndefined();
    // email and plan should be stored (valid)
    expect(session.data.values.email).toBe('user@test.com');
    expect(session.data.values.plan).toBe('basic');
  });

  test('enum validation should reject invalid choice', async () => {
    const session = createValidatedSession();

    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      if (systemPrompt.includes('entity extraction assistant')) {
        return {
          text: '{"email": "user@test.com", "age": 30, "plan": "premium"}',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [
            { type: 'text', text: '{"email": "user@test.com", "age": 30, "plan": "premium"}' },
          ],
        };
      }
      return {
        text: 'Please choose basic, pro, or enterprise.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Please choose basic, pro, or enterprise.' }],
      };
    });

    const traceCollector = createTraceCollector();
    await executor.executeMessage(
      session.id,
      'user@test.com, 30, premium plan',
      undefined,
      traceCollector.callback,
    );

    // plan should NOT be stored (not in enum)
    expect(session.data.values.plan).toBeUndefined();
    // email and age should be stored (valid)
    expect(session.data.values.email).toBe('user@test.com');
    expect(session.data.values.age).toBe(30);
  });

  test('all valid values should pass validation', async () => {
    const session = createValidatedSession();

    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      if (systemPrompt.includes('entity extraction assistant')) {
        return {
          text: '{"email": "valid@email.com", "age": 28, "plan": "enterprise"}',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [
            { type: 'text', text: '{"email": "valid@email.com", "age": 28, "plan": "enterprise"}' },
          ],
        };
      }
      return {
        text: 'All info collected!',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'All info collected!' }],
      };
    });

    const traceCollector = createTraceCollector();
    await executor.executeMessage(
      session.id,
      'valid@email.com, 28, enterprise plan',
      undefined,
      traceCollector.callback,
    );

    // All should be stored
    expect(session.data.values.email).toBe('valid@email.com');
    expect(session.data.values.age).toBe(28);
    expect(session.data.values.plan).toBe('enterprise');

    // No validation errors in trace
    const extractionTraces = filterTraces(traceCollector.traces, 'entity_extraction');
    const llmExtraction = extractionTraces.find((t) => t.data.method === 'llm');
    expect(llmExtraction).toBeDefined();
    expect(llmExtraction!.data.validationErrors).toBeUndefined();
  });

  test('validation hints should appear in LLM extraction prompt', async () => {
    const session = createValidatedSession();

    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      if (systemPrompt.includes('entity extraction assistant')) {
        // Capture the system prompt for assertion
        return {
          text: '{}',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: '{}' }],
        };
      }
      return {
        text: 'What info do you need?',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'What info do you need?' }],
      };
    });

    // Use non-trivial input so shouldSkipExtraction doesn't skip extraction
    await executor.executeMessage(session.id, 'my email is test@example.com', undefined, undefined);

    // Check the entity extraction LLM call system prompt
    const extractionCall = mockClient.calls.find((c) =>
      c.systemPrompt.includes('entity extraction assistant'),
    );
    expect(extractionCall).toBeDefined();

    const prompt = extractionCall!.systemPrompt;
    // Should contain validation hints
    expect(prompt).toContain('must match pattern');
    expect(prompt).toContain('valid range: 1-120');
    expect(prompt).toContain('allowed values: basic, pro, enterprise');
  });
});
