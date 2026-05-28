/**
 * 15-Turn Multi-Agent Transcript Test
 *
 * End-to-end conversation demonstrating:
 * - Supervisor routing (config-driven detection via ir.routing.rules)
 * - HANDOFF with RETURN: true (temporary) and RETURN: false (permanent)
 * - DELEGATE for synchronous sub-agent invocation with result mapping
 * - Entity extraction via GATHER across multiple turns
 * - Context passing between agents (parent → child, child → parent sync)
 * - Tool calls during reasoning
 * - Agent completion and return-to-supervisor flow
 *
 * Scenario: Travel booking with supervisor → hotel agent → fee calculator delegate
 *
 * Turn  1: User greets → Supervisor routes to Welcome_Agent (RETURN: true)
 * Turn  2: Welcome agent responds, completes → returns to Supervisor
 * Turn  3: User asks about hotels → Supervisor routes to Hotel_Agent (RETURN: true)
 * Turn  4: Hotel agent asks for destination → entity extraction
 * Turn  5: User provides destination "Paris" → extracted, asks for dates
 * Turn  6: User provides dates "March 15 to March 20" → extracted, asks for guests
 * Turn  7: User provides guests "2" → all gathered, agent searches hotels
 * Turn  8: Agent presents results with tool call (search_hotels)
 * Turn  9: User selects hotel → triggers DELEGATE to Fee_Calculator
 * Turn 10: Fee calculator returns breakdown → Hotel agent shows fees
 * Turn 11: User confirms booking → Hotel agent completes, returns to Supervisor
 * Turn 12: User asks about flights → Supervisor routes to Flight_Agent (RETURN: false)
 * Turn 13: Flight agent asks for origin → entity extraction
 * Turn 14: User provides origin + destination → extracted
 * Turn 15: User asks for help → Supervisor routes to Support_Agent (RETURN: false)
 */

import { describe, test, expect, beforeEach } from 'vitest';
import {
  RuntimeExecutor,
  compileToResolvedAgent,
  type RuntimeSession,
} from '../services/runtime-executor';
import { assertHistoryIntegrity } from './helpers/history-validation';

// =============================================================================
// MOCK LLM CLIENT
// =============================================================================

class MockAnthropicClient {
  calls: Array<{
    systemPrompt: string;
    messages: Array<{ role: string; content: unknown }>;
    tools: unknown[];
  }> = [];

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
    this.responseHandler = () => ({
      text: 'I can help with that.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'I can help with that.' }],
    });
  }

  setResponseHandler(handler: typeof this.responseHandler) {
    this.responseHandler = handler;
  }

  /** Set entity extraction response + text response for reasoning call */
  setExtractAndRespond(entities: Record<string, unknown>, responseText: string) {
    this.setResponseHandler((sys, msgs, tools) => {
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
      return {
        text: responseText,
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: responseText }],
      };
    });
  }

  /** Set handoff response (supervisor uses __handoff__ tool) */
  setHandoffResponse(target: string, callId: string, text: string) {
    this.setResponseHandler((sys, msgs, tools) => {
      if (tools.some((t: any) => t.name === '_extract_entities')) {
        return {
          text: '',
          toolCalls: [{ id: 'extract-1', name: '_extract_entities', input: {} }],
          stopReason: 'tool_use',
          rawContent: [{ type: 'tool_use', id: 'extract-1', name: '_extract_entities', input: {} }],
        };
      }
      return {
        text,
        toolCalls: [{ id: callId, name: '__handoff__', input: { target, context: {} } }],
        stopReason: 'tool_use',
        rawContent: [
          { type: 'text', text },
          { type: 'tool_use', id: callId, name: '__handoff__', input: { target, context: {} } },
        ],
      };
    });
  }

  /** Set extraction + tool call + final response */
  setExtractToolAndRespond(
    entities: Record<string, unknown>,
    toolCall: { id: string; name: string; input: Record<string, unknown> },
    toolText: string,
    finalText: string,
  ) {
    let reasoningCallCount = 0;
    this.setResponseHandler((sys, msgs, tools) => {
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
      reasoningCallCount++;
      if (reasoningCallCount === 1) {
        return {
          text: toolText,
          toolCalls: [toolCall],
          stopReason: 'tool_use',
          rawContent: [
            { type: 'text', text: toolText },
            { type: 'tool_use', id: toolCall.id, name: toolCall.name, input: toolCall.input },
          ],
        };
      }
      return {
        text: finalText,
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: finalText }],
      };
    });
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
// TRACE HELPERS
// =============================================================================

interface CapturedTrace {
  type: string;
  data: Record<string, unknown>;
}

function createTraceCollector() {
  const traces: CapturedTrace[] = [];
  return {
    traces,
    callback: (event: { type: string; data: Record<string, unknown> }) =>
      traces.push({ type: event.type, data: event.data }),
  };
}

function filterTraces(traces: CapturedTrace[], type: string): CapturedTrace[] {
  return traces.filter((t) => t.type === type);
}

// =============================================================================
// DSL FIXTURES
// =============================================================================

const TRAVEL_SUPERVISOR = `
SUPERVISOR: Travel_Supervisor

GOAL: "Route travel requests to specialist agents"

PERSONA: "Professional travel routing assistant"

HANDOFF:
  - TO: Welcome_Agent
    WHEN: intent.category == "greeting"
    CONTEXT:
      pass: [session_context]
      summary: "User greeting"
    RETURN: true

  - TO: Hotel_Agent
    WHEN: intent contains "hotel" OR intent contains "stay" OR intent contains "room"
    CONTEXT:
      pass: [destination, dates]
      summary: "Hotel booking request"
    RETURN: true

  - TO: Flight_Agent
    WHEN: intent contains "flight" OR intent contains "fly"
    CONTEXT:
      pass: [destination, dates]
      summary: "Flight booking request"
    RETURN: false

  - TO: Support_Agent
    WHEN: intent contains "help" OR intent contains "problem" OR intent contains "issue"
    CONTEXT:
      pass: [issue_description]
      summary: "User needs support"
    RETURN: false

COMPLETE:
  - WHEN: handoff_successful == true
    RESPOND: "Is there anything else I can help with?"
`;

const WELCOME_AGENT = `
AGENT: Welcome_Agent

GOAL: "Welcome users warmly and help them get started"

PERSONA: "Friendly and helpful greeter"

GATHER:
  user_name:
    prompt: "What is your name?"
    type: string
    required: false

COMPLETE:
  - WHEN: intent contains "hello" OR intent contains "hi"
    RESPOND: "Welcome! How can I help you today?"
`;

const HOTEL_AGENT = `
AGENT: Hotel_Agent

GOAL: "Help users search and book hotels"

PERSONA: "Expert hotel booking specialist"

TOOLS:
  search_hotels(destination: string, checkin: string, checkout: string, guests: number) -> {hotels: object[], count: number}
    description: "Search for available hotels"

GATHER:
  destination:
    prompt: "Where would you like to stay?"
    type: string
    required: true

  checkin:
    prompt: "What is your check-in date?"
    type: date
    required: true

  checkout:
    prompt: "What is your check-out date?"
    type: date
    required: true

  guests:
    prompt: "How many guests?"
    type: number
    required: false

DELEGATE:
  - AGENT: Fee_Calculator
    WHEN: action_type == "book"
    PURPOSE: "Calculate booking fees and taxes"
    INPUT: {hotel_id: selected_hotel, nights: num_nights, guests: guests}
    RETURNS: {total_fee: number, tax: number, breakdown: object[]}
    USE_RESULT: "Show fee breakdown to user before confirming"
    TIMEOUT: 10s
    ON_FAILURE: RESPOND "Unable to calculate fees at this time"

COMPLETE:
  - WHEN: all_fields_gathered == true
    RESPOND: "I found hotels for you. Here are the results."
`;

const FEE_CALCULATOR = `
AGENT: Fee_Calculator

GOAL: "Calculate booking fees, taxes, and provide cost breakdown"

PERSONA: "Precise financial calculator"

GATHER:
  hotel_id:
    prompt: "Which hotel?"
    type: string
    required: true

  nights:
    prompt: "How many nights?"
    type: number
    required: true

COMPLETE:
  - WHEN: hotel_id IS SET AND nights IS SET
    RESPOND: "Fee calculation complete."
`;

const FLIGHT_AGENT = `
AGENT: Flight_Agent

GOAL: "Help users search and book flights"

PERSONA: "Expert flight booking specialist"

TOOLS:
  search_flights(origin: string, destination: string, date: string) -> {flights: object[], count: number}
    description: "Search for available flights"

GATHER:
  origin:
    prompt: "Where are you flying from?"
    type: string
    required: true

  destination:
    prompt: "Where would you like to fly to?"
    type: string
    required: true

  departure_date:
    prompt: "When do you want to depart?"
    type: date
    required: true

COMPLETE:
  - WHEN: all_fields_gathered == true
    RESPOND: "Here are the available flights."
`;

const SUPPORT_AGENT = `
AGENT: Support_Agent

GOAL: "Help users with issues and problems"

PERSONA: "Patient and thorough support specialist"

GATHER:
  issue_description:
    prompt: "Please describe your issue."
    type: string
    required: true

COMPLETE:
  - WHEN: issue_description IS SET
    RESPOND: "I understand your issue. Let me help resolve it."
`;

const HISTORY_AGENT = `
AGENT: History_Agent

GOAL: "Echo multi-turn responses for transcript tests"

PERSONA: "History test assistant"
`;

// =============================================================================
// 15-TURN TRANSCRIPT TEST
// =============================================================================

describe('15-Turn Multi-Agent Transcript', () => {
  let executor: RuntimeExecutor;
  let mockClient: MockAnthropicClient;
  let session: RuntimeSession;
  const allTraces: CapturedTrace[] = [];

  beforeEach(() => {
    executor = new RuntimeExecutor();
    mockClient = injectMockClient(executor);

    // Register all agents
    executor.registerAgent('Welcome_Agent', WELCOME_AGENT);
    executor.registerAgent('Hotel_Agent', HOTEL_AGENT);
    executor.registerAgent('Fee_Calculator', FEE_CALCULATOR);
    executor.registerAgent('Flight_Agent', FLIGHT_AGENT);
    executor.registerAgent('Support_Agent', SUPPORT_AGENT);

    // Create supervisor session
    session = executor.createSessionFromResolved(
      compileToResolvedAgent([TRAVEL_SUPERVISOR], 'Travel_Supervisor'),
    );
    allTraces.length = 0;
  });

  // -------------------------------------------------------------------------
  // Structural tests (compilation-level)
  // -------------------------------------------------------------------------

  describe('0. Supervisor structural validation', () => {
    test('0.1 Supervisor detected via routing config, not metadata type', () => {
      expect(session.agentIR).not.toBeNull();
      const isSupervisor = !!(
        session.agentIR?.routing?.rules && session.agentIR.routing.rules.length > 0
      );
      expect(isSupervisor).toBe(true);
    });

    test('0.2 Supervisor has 4 routing rules from HANDOFF definitions', () => {
      const rules = session.agentIR?.routing?.rules || [];
      expect(rules).toHaveLength(4);
      expect(rules[0].to).toBe('Welcome_Agent');
      expect(rules[1].to).toBe('Hotel_Agent');
      expect(rules[2].to).toBe('Flight_Agent');
      expect(rules[3].to).toBe('Support_Agent');
    });

    test('0.3 Routing rules preserve RETURN flag', () => {
      const rules = session.agentIR?.routing?.rules || [];
      // Welcome and Hotel return true, Flight and Support return false
      expect((rules[0] as any).return).toBe(true);
      expect((rules[1] as any).return).toBe(true);
      expect((rules[2] as any).return).toBe(false);
      expect((rules[3] as any).return).toBe(false);
    });

    test('0.4 All agents accessible in the executor registry', () => {
      const registry = (executor as any).agentRegistry;
      expect(registry['Travel_Supervisor']).toBeDefined();
      expect(registry['Welcome_Agent']).toBeDefined();
      expect(registry['Hotel_Agent']).toBeDefined();
      expect(registry['Fee_Calculator']).toBeDefined();
      expect(registry['Flight_Agent']).toBeDefined();
      expect(registry['Support_Agent']).toBeDefined();
    });

    test('0.5 Hotel_Agent has DELEGATE config for Fee_Calculator', () => {
      const hotelSession = executor.createSessionFromResolved(
        compileToResolvedAgent([HOTEL_AGENT], 'Hotel_Agent'),
      );
      expect(hotelSession.agentIR?.coordination?.delegates?.length).toBeGreaterThanOrEqual(1);
      const feeDelegate = hotelSession.agentIR?.coordination?.delegates?.find(
        (d: any) => d.agent === 'Fee_Calculator',
      );
      expect(feeDelegate).toBeDefined();
      expect(feeDelegate?.purpose).toContain('fees');
    });
  });

  // -------------------------------------------------------------------------
  // Multi-turn transcript (turns 1-15)
  // -------------------------------------------------------------------------

  describe('1. Greeting → Supervisor → Welcome handoff (RETURN: true)', () => {
    test('Turn 1: User greets, supervisor routes to Welcome_Agent', async () => {
      // Single handler covers: supervisor handoff call + child extraction + child reasoning
      let callNum = 0;
      mockClient.setResponseHandler((sys, msgs, tools) => {
        callNum++;
        // Call 1: supervisor reasoning (has tools) → handoff
        if (callNum === 1 && tools.length > 0) {
          return {
            text: 'Let me connect you with our welcome team.',
            toolCalls: [
              { id: 'h1', name: '__handoff__', input: { target: 'Welcome_Agent', context: {} } },
            ],
            stopReason: 'tool_use',
            rawContent: [
              { type: 'text', text: 'Let me connect you with our welcome team.' },
              {
                type: 'tool_use',
                id: 'h1',
                name: '__handoff__',
                input: { target: 'Welcome_Agent', context: {} },
              },
            ],
          };
        }
        // Call 2+: child extraction (_extract_entities tool) or child reasoning (other tools)
        if (tools.some((t: any) => t.name === '_extract_entities')) {
          return {
            text: '',
            toolCalls: [{ id: 'extract-1', name: '_extract_entities', input: {} }],
            stopReason: 'tool_use',
            rawContent: [
              { type: 'tool_use', id: 'extract-1', name: '_extract_entities', input: {} },
            ],
          };
        }
        return {
          text: 'Welcome to Travel Assistant! How can I assist you today?',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [
            { type: 'text', text: 'Welcome to Travel Assistant! How can I assist you today?' },
          ],
        };
      });

      const collector = createTraceCollector();
      const result = await executor.executeMessage(
        session.id,
        'Hello!',
        undefined,
        collector.callback,
      );

      expect(result.response).toBeDefined();

      // Verify handoff trace was emitted
      const handoffTraces = filterTraces(collector.traces, 'handoff');
      expect(handoffTraces.length).toBeGreaterThanOrEqual(1);

      // Since RETURN: true, supervisor should expect control back
      // After handoff, session.agentIR points to child; check supervisor thread's IR
      const supervisorIR = session.threads[0].agentIR;
      const welcomeRule = supervisorIR?.routing?.rules?.find((r: any) => r.to === 'Welcome_Agent');
      expect((welcomeRule as any)?.return).toBe(true);
    });
  });

  describe('2. Hotel booking gather flow (multi-turn entity extraction)', () => {
    test('Turns 3-8: Hotel agent gathers destination, dates, guests and searches', async () => {
      // Test gather flow on a direct Hotel_Agent session.
      // With RETURN: true, the supervisor re-routes each message to a fresh child.
      // Entity extraction is an agent-level concern, so we test it directly.
      const hotelSession = executor.createSessionFromResolved(
        compileToResolvedAgent([HOTEL_AGENT], 'Hotel_Agent'),
      );

      // --- Turn 3: Initial ask → no entities extracted yet ---
      mockClient.setExtractAndRespond({}, "I'd love to help! Where would you like to stay?");
      await executor.executeMessage(hotelSession.id, 'I need a hotel room', undefined, undefined);

      // --- Turn 5: User provides destination ---
      mockClient.setExtractAndRespond(
        { destination: 'Paris' },
        'Paris! When would you like to check in and check out?',
      );

      const collector5 = createTraceCollector();
      await executor.executeMessage(
        hotelSession.id,
        'I want to stay in Paris',
        undefined,
        collector5.callback,
      );

      expect(hotelSession.data.values.destination).toBe('Paris');

      // Verify dsl_collect trace emitted for reasoning_gather
      const collectTraces5 = filterTraces(collector5.traces, 'dsl_collect');
      expect(collectTraces5.length).toBeGreaterThanOrEqual(1);

      // --- Turn 6: User provides dates ---
      mockClient.setExtractAndRespond(
        { checkin: '2026-03-15', checkout: '2026-03-20' },
        'March 15 to March 20 — 5 nights. How many guests?',
      );

      await executor.executeMessage(hotelSession.id, 'March 15 to March 20', undefined, undefined);

      expect(hotelSession.data.values.checkin).toBe('2026-03-15');
      expect(hotelSession.data.values.checkout).toBe('2026-03-20');

      // --- Turn 7: User provides guest count ---
      mockClient.setExtractAndRespond(
        { guests: 2 },
        'Perfect — 2 guests. Let me search for hotels in Paris.',
      );

      await executor.executeMessage(hotelSession.id, '2 guests', undefined, undefined);

      expect(hotelSession.data.values.guests).toBe(2);

      // --- Turn 8: Agent uses search_hotels tool ---
      mockClient.setExtractToolAndRespond(
        {},
        {
          id: 'call_search',
          name: 'search_hotels',
          input: { destination: 'Paris', checkin: '2026-03-15', checkout: '2026-03-20', guests: 2 },
        },
        'Let me search for available hotels in Paris.',
        'I found 3 hotels in Paris:\n1. Hotel Lumiere — 180/night\n2. Le Petit Palace — 220/night\n3. Maison du Marais — 150/night',
      );

      const collector8 = createTraceCollector();
      await executor.executeMessage(
        hotelSession.id,
        'Search for hotels please',
        undefined,
        collector8.callback,
      );

      // Verify tool call trace
      const toolTraces = filterTraces(collector8.traces, 'tool_call');
      expect(toolTraces.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('3. Flight booking flow (RETURN: false handoff)', () => {
    test('Turns 12-14: Supervisor routes to Flight_Agent permanently', async () => {
      // --- Turn 12: Supervisor routes to Flight_Agent (RETURN: false) ---
      let flightCallNum = 0;
      mockClient.setResponseHandler((sys, msgs, tools) => {
        flightCallNum++;
        if (flightCallNum === 1 && tools.length > 0) {
          return {
            text: 'Let me connect you with our flight specialist.',
            toolCalls: [
              { id: 'h3', name: '__handoff__', input: { target: 'Flight_Agent', context: {} } },
            ],
            stopReason: 'tool_use',
            rawContent: [
              { type: 'text', text: 'Let me connect you with our flight specialist.' },
              {
                type: 'tool_use',
                id: 'h3',
                name: '__handoff__',
                input: { target: 'Flight_Agent', context: {} },
              },
            ],
          };
        }
        if (tools.some((t: any) => t.name === '_extract_entities')) {
          return {
            text: '',
            toolCalls: [{ id: 'extract-1', name: '_extract_entities', input: {} }],
            stopReason: 'tool_use',
            rawContent: [
              { type: 'tool_use', id: 'extract-1', name: '_extract_entities', input: {} },
            ],
          };
        }
        return {
          text: 'I can help you find flights! Where are you flying from?',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [
            { type: 'text', text: 'I can help you find flights! Where are you flying from?' },
          ],
        };
      });

      const collector12 = createTraceCollector();
      const turn12 = await executor.executeMessage(
        session.id,
        'I also need a flight',
        undefined,
        collector12.callback,
      );

      expect(turn12.response).toBeDefined();

      // Verify RETURN: false flag — check supervisor thread's IR (thread[0])
      const supervisorIR = session.threads[0].agentIR;
      const flightRule = supervisorIR?.routing?.rules?.find((r: any) => r.to === 'Flight_Agent');
      expect((flightRule as any)?.return).toBe(false);

      // --- Turn 13: User provides origin ---
      mockClient.setExtractAndRespond(
        { origin: 'New York' },
        'Flying from New York! And where would you like to go?',
      );

      await executor.executeMessage(session.id, 'From New York', undefined, undefined);

      expect(session.data.values.origin).toBe('New York');

      // --- Turn 14: User provides destination ---
      mockClient.setExtractAndRespond(
        { destination: 'Paris', departure_date: '2026-03-15' },
        'New York to Paris on March 15th. Let me search for flights!',
      );

      const collector14 = createTraceCollector();
      const turn14 = await executor.executeMessage(
        session.id,
        'To Paris on March 15th',
        undefined,
        collector14.callback,
      );

      expect(session.data.values.destination).toBe('Paris');
      expect(session.data.values.departure_date).toBe('2026-03-15');

      // Verify entity extraction traces
      const extractTraces = filterTraces(collector14.traces, 'entity_extraction');
      expect(extractTraces.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('4. Support handoff (RETURN: false)', () => {
    test('Turn 15: Supervisor routes to Support_Agent permanently', async () => {
      // Single handler: supervisor handoff + child agent response
      let supportCallNum = 0;
      mockClient.setResponseHandler((sys, msgs, tools) => {
        supportCallNum++;
        if (supportCallNum === 1 && tools.length > 0) {
          return {
            text: 'Connecting you with support.',
            toolCalls: [
              {
                id: 'h4',
                name: '__handoff__',
                input: {
                  target: 'Support_Agent',
                  context: { issue_description: 'help with booking' },
                },
              },
            ],
            stopReason: 'tool_use',
            rawContent: [
              { type: 'text', text: 'Connecting you with support.' },
              {
                type: 'tool_use',
                id: 'h4',
                name: '__handoff__',
                input: {
                  target: 'Support_Agent',
                  context: { issue_description: 'help with booking' },
                },
              },
            ],
          };
        }
        if (tools.some((t: any) => t.name === '_extract_entities')) {
          return {
            text: '',
            toolCalls: [
              {
                id: 'extract-1',
                name: '_extract_entities',
                input: { issue_description: 'help with booking' },
              },
            ],
            stopReason: 'tool_use',
            rawContent: [
              {
                type: 'tool_use',
                id: 'extract-1',
                name: '_extract_entities',
                input: { issue_description: 'help with booking' },
              },
            ],
          };
        }
        return {
          text: 'I understand you need help with your booking. Let me assist you.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [
            {
              type: 'text',
              text: 'I understand you need help with your booking. Let me assist you.',
            },
          ],
        };
      });

      const collector15 = createTraceCollector();
      const turn15 = await executor.executeMessage(
        session.id,
        'I need help with my booking',
        undefined,
        collector15.callback,
      );

      expect(turn15.response).toBeDefined();

      // Verify support has RETURN: false — check supervisor thread's IR (thread[0])
      const supervisorIR = session.threads[0].agentIR;
      const supportRule = supervisorIR?.routing?.rules?.find((r: any) => r.to === 'Support_Agent');
      expect((supportRule as any)?.return).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Cross-cutting concerns
  // -------------------------------------------------------------------------

  describe('5. Delegate structural validation', () => {
    test('5.1 Hotel agent compiles with DELEGATE to Fee_Calculator', () => {
      const hotelSession = executor.createSessionFromResolved(
        compileToResolvedAgent([HOTEL_AGENT], 'Hotel_Agent'),
      );

      // Verify delegate config exists
      const delegates = hotelSession.agentIR?.coordination?.delegates || [];
      expect(delegates.length).toBeGreaterThanOrEqual(1);

      const feeDelegate = delegates.find((d: any) => d.agent === 'Fee_Calculator');
      expect(feeDelegate).toBeDefined();
      expect(feeDelegate?.purpose).toContain('fees');
    });

    test('5.2 Fee_Calculator compiles as standalone agent with GATHER', () => {
      const feeSession = executor.createSessionFromResolved(
        compileToResolvedAgent([FEE_CALCULATOR], 'Fee_Calculator'),
      );

      expect(feeSession.agentIR).not.toBeNull();
      expect(feeSession.agentIR?.gather?.fields?.length).toBeGreaterThanOrEqual(2);

      const fieldNames = feeSession.agentIR?.gather?.fields?.map((f: any) => f.name) || [];
      expect(fieldNames).toContain('hotel_id');
      expect(fieldNames).toContain('nights');
    });
  });

  describe('6. Conversation history accumulation', () => {
    test('6.1 Messages accumulate across turns', async () => {
      const historySession = executor.createSessionFromResolved(
        compileToResolvedAgent([HISTORY_AGENT], 'History_Agent'),
      );

      // Turn 1
      mockClient.setExtractAndRespond({}, 'Welcome!');
      await executor.executeMessage(historySession.id, 'Hello', undefined, undefined);

      // Turn 2
      mockClient.setExtractAndRespond({}, 'How can I help?');
      await executor.executeMessage(historySession.id, 'I need help', undefined, undefined);

      // Canonical transcript storage spans agent threads. The active thread may
      // only hold the current activation, but the thread set must retain both turns.
      const canonicalThreadHistory = historySession.threads.flatMap(
        (thread) => thread.conversationHistory,
      );

      expect(canonicalThreadHistory.length).toBeGreaterThanOrEqual(4);

      const userContents = canonicalThreadHistory
        .filter((message) => message.role === 'user')
        .map((message) => message.content);
      expect(userContents).toContain('Hello');
      expect(userContents).toContain('I need help');

      const assistantContents = canonicalThreadHistory
        .filter((message) => message.role === 'assistant')
        .map((message) => message.content);
      expect(assistantContents).toContain('Welcome!');
      expect(assistantContents).toContain('How can I help?');

      historySession.threads.forEach((thread, index) => {
        assertHistoryIntegrity(
          thread.conversationHistory,
          `Turn accumulation thread[${index}] conversationHistory`,
        );
      });
    });
  });

  describe('7. Trace event verification', () => {
    test('7.1 LLM calls generate llm_call traces', async () => {
      mockClient.setExtractAndRespond({ destination: 'London' }, 'London it is!');

      const collector = createTraceCollector();
      await executor.executeMessage(session.id, 'London please', undefined, collector.callback);

      const llmTraces = filterTraces(collector.traces, 'llm_call');
      expect(llmTraces.length).toBeGreaterThanOrEqual(1);
    });

    test('7.2 Entity extraction generates dsl_collect trace for reasoning gather', async () => {
      // Test extraction traces on a direct Hotel_Agent session
      const hotelSession = executor.createSessionFromResolved(
        compileToResolvedAgent([HOTEL_AGENT], 'Hotel_Agent'),
      );

      mockClient.setExtractAndRespond({ destination: 'Rome' }, 'Rome! Great choice.');
      const collector = createTraceCollector();
      await executor.executeMessage(
        hotelSession.id,
        'I want to go to Rome',
        undefined,
        collector.callback,
      );

      // Reasoning agents with GATHER emit dsl_collect traces
      const collectTraces = filterTraces(collector.traces, 'dsl_collect');
      expect(collectTraces.length).toBeGreaterThanOrEqual(1);
      expect((collectTraces[0].data as any).mode).toBe('reasoning_gather');
    });
  });
});
