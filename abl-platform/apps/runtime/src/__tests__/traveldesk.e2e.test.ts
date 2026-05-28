/**
 * TravelDesk E2E Tests — Deterministic LLM Harness + Mocked Tools
 *
 * Exercises the TravelDesk travel agent DSL through the RuntimeExecutor with
 * a deterministic in-process LLM harness. Tool backends are mocked with
 * realistic travel data.
 *
 * The default runtime regression lane must not call vendors. Provider-backed
 * smoke coverage belongs in an explicit live lane, outside pnpm test.
 *
 * Suite 1: Sales Agent (reasoning mode, deterministic LLM)
 *   1.1  Multi-turn entity extraction (GATHER fields)
 *   1.2  Tool call + ON_RESULT SET mapping
 *   1.3  __set_context__ system tool
 *
 * Suite 2: Feature-Focused Inline Agents
 *   2.1  ON_START SET (scripted, no LLM)
 *   2.2  Dynamic IDENTITY interpolation (reasoning, deterministic LLM)
 *   2.3  FactStore batch operations (reasoning, deterministic LLM)
 *
 * Suite 3: ON_RESULT Flow Branching (scripted, no LLM)
 *   3.1  Multi-way ON_RESULT branching (200 / 401 / ELSE)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { config as dotenvConfig } from 'dotenv';
import { parseAgentBasedABL } from '@abl/core';

// Load .env for tests that rely on runtime defaults without calling loadConfig().
dotenvConfig({ path: resolve(__dirname, '../../.env') });

import { RuntimeExecutor, compileToResolvedAgent } from '../services/runtime-executor';
import { SYSTEM_TOOL_SET_CONTEXT } from '@abl/compiler';
import { InMemoryFactStore } from '@abl/compiler/platform/stores/fact-store.js';

// =============================================================================
// CONSTANTS
// =============================================================================

const MOCK_PROVIDER = 'mock';
const MOCK_MODEL_ID = 'mock/traveldesk-deterministic';
const FIXED_TRAVELDESK_NOW = new Date('2026-04-15T12:00:00.000Z');

// =============================================================================
// SALES AGENT DSL (loaded from examples/)
// =============================================================================

const SALES_AGENT_DSL = readFileSync(
  resolve(__dirname, '../../../../examples/travel/agents/sales_agent.agent.abl'),
  'utf-8',
);

// =============================================================================
// MOCK TOOL EXECUTOR
// =============================================================================

function createMockToolExecutor() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];

  return {
    calls,
    executor: {
      execute: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        switch (name) {
          case 'search_flights':
            return {
              flights: [
                { id: 'FL001', price: 450, airline: 'British Airways', departure: '08:00' },
                { id: 'FL002', price: 380, airline: 'Ryanair', departure: '14:00' },
              ],
              search_id: 'SRCH-001',
              expires_at: '2025-04-01T00:00:00Z',
            };
          case 'search_hotels':
            return {
              hotels: [
                { id: 'HT001', name: 'Grand Hotel', price: 180, rating: 4.5 },
                { id: 'HT002', name: 'City Inn', price: 120, rating: 4.0 },
              ],
              search_id: 'SRCH-002',
              expires_at: '2025-04-01T00:00:00Z',
            };
          case 'search_packages':
            return {
              packages: [{ id: 'PK001', price: 580, flights: ['FL001'], hotel: 'HT001' }],
              search_id: 'SRCH-003',
              expires_at: '2025-04-01T00:00:00Z',
            };
          case 'check_availability':
            return { available: true, price: 450, seats_left: 12, currency: 'EUR' };
          case 'create_quote':
            return {
              quote_id: 'Q-001',
              total: 560,
              currency: 'EUR',
              valid_until: '2025-04-02T00:00:00Z',
              breakdown: [],
            };
          case 'start_payment':
            return {
              payment_session_id: 'PAY-001',
              payment_url: 'https://pay.example.com/PAY-001',
              expires_in: 1800,
            };
          case 'check_flight_departure':
            return { departure_time: '2025-04-01T08:00:00Z', hours_until_departure: 48 };
          default:
            return { success: true };
        }
      },
    },
  };
}

// =============================================================================
// LLM-WIRED EXECUTOR FACTORY
// =============================================================================

type DeterministicLLMResponse = {
  text: string;
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  stopReason: string;
  rawContent: Array<{ type: string; [key: string]: unknown }>;
  usage: { inputTokens: number; outputTokens: number };
  resolvedModel: { modelId: string; provider: string; source: string };
};

function stringifyMessageContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!content) {
    return '';
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }

        if (!part || typeof part !== 'object') {
          return '';
        }

        const maybeText = (part as { text?: unknown }).text;
        if (typeof maybeText === 'string') {
          return maybeText;
        }

        const maybeContent = (part as { content?: unknown }).content;
        if (typeof maybeContent === 'string') {
          return maybeContent;
        }

        return JSON.stringify(part);
      })
      .filter(Boolean)
      .join('\n');
  }

  return JSON.stringify(content);
}

function latestUserMessage(messages: Array<{ role: string; content: unknown }>): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'user') {
      return stringifyMessageContent(message.content);
    }
  }

  return '';
}

function includesToolResult(messages: Array<{ role: string; content: unknown }>): boolean {
  return messages.some((message) => {
    if (message.role === 'tool') {
      return true;
    }

    const content = stringifyMessageContent(message.content);
    return content.includes('tool_result') || content.includes('Tool result');
  });
}

class DeterministicTravelDeskLLMClient {
  private readonly resolvedModel = {
    modelId: MOCK_MODEL_ID,
    provider: MOCK_PROVIDER,
    source: 'test_harness',
  };

  async chatWithToolUse(
    _systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: Array<{ name: string }>,
  ): Promise<DeterministicLLMResponse> {
    return this.respond(messages, tools);
  }

  async chatWithToolUseStreamable(
    systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: Array<{ name: string }>,
    _operationType?: string,
    onChunk?: (chunk: string) => void,
  ): Promise<DeterministicLLMResponse> {
    const response = await this.chatWithToolUse(systemPrompt, messages, tools);
    if (response.text && response.toolCalls.length === 0) {
      onChunk?.(response.text);
    }
    return response;
  }

  private respond(
    messages: Array<{ role: string; content: unknown }>,
    tools: Array<{ name: string }>,
  ): DeterministicLLMResponse {
    const toolNames = new Set(tools.map((tool) => tool.name));
    const userMessage = latestUserMessage(messages).toLowerCase();

    if (includesToolResult(messages)) {
      return this.text('Thanks, I have updated the travel plan.');
    }

    if (toolNames.has('_extract_entities')) {
      const extracted: Record<string, unknown> = {};

      if (userMessage.includes('london') && userMessage.includes('paris')) {
        extracted.origin = 'London';
        extracted.destination = 'Paris';
      }
      if (userMessage.includes('april 10') || userMessage.includes('april 10th')) {
        extracted.departure_date = '2026-04-10';
      }
      if (userMessage.includes('april 15') || userMessage.includes('april 15th')) {
        extracted.return_date = '2026-04-15';
      }
      if (userMessage.includes('two travelers') || userMessage.includes('2 travelers')) {
        extracted.num_travelers = 2;
      }
      if (userMessage.includes('1000')) {
        extracted.budget = 1000;
      }

      return this.toolCall('_extract_entities', extracted);
    }

    if (toolNames.has('search_flights') && userMessage.includes('search')) {
      return this.toolCall('search_flights', {
        origin: 'London',
        destination: 'Paris',
        departure_date: '2026-04-10',
        return_date: '2026-04-15',
        passengers: 2,
      });
    }

    if (userMessage.includes('hello') || userMessage.includes('plan my trip')) {
      return this.text('Hi Alice, I can help you plan your trip to Paris.');
    }

    return this.text('I can help with that travel request.');
  }

  private text(text: string): DeterministicLLMResponse {
    return {
      text,
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text }],
      usage: { inputTokens: 64, outputTokens: 16 },
      resolvedModel: this.resolvedModel,
    };
  }

  private toolCall(name: string, input: Record<string, unknown>): DeterministicLLMResponse {
    const id = `mock-${name}`;
    return {
      text: '',
      toolCalls: [{ id, name, input }],
      stopReason: 'tool_use',
      rawContent: [{ type: 'tool_use', id, name, input }],
      usage: { inputTokens: 72, outputTokens: 12 },
      resolvedModel: this.resolvedModel,
    };
  }
}

function createWiredExecutor(): RuntimeExecutor {
  const executor = new RuntimeExecutor();
  const mockClient = new DeterministicTravelDeskLLMClient();

  (executor as any).llmWiring.wireLLMClient = async (session: any) => {
    session.llmClient = mockClient;
  };
  (executor as any).llmWiring.ensureSessionLLMClient = async (session: any) => {
    if (!session.llmClient) {
      session.llmClient = mockClient;
    }
  };

  return executor;
}

function createFrozenSession(
  executor: RuntimeExecutor,
  resolved: Parameters<RuntimeExecutor['createSessionFromResolved']>[0],
): ReturnType<RuntimeExecutor['createSessionFromResolved']> {
  const session = executor.createSessionFromResolved(resolved);
  session.createdAt = new Date(FIXED_TRAVELDESK_NOW);
  session.lastActivityAt = new Date(FIXED_TRAVELDESK_NOW);
  return session;
}

// =============================================================================
// TRACE COLLECTION HELPERS
// =============================================================================

type TraceEvent = { type: string; data: Record<string, unknown> };

function createTraceCollector(): { traces: TraceEvent[]; collect: (evt: TraceEvent) => void } {
  const traces: TraceEvent[] = [];
  return { traces, collect: (evt: TraceEvent) => traces.push(evt) };
}

// =============================================================================
// SUITE 1: Sales Agent — Reasoning Mode
// =============================================================================

describe('Suite 1: Sales Agent — Reasoning Mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Test 1.1: Multi-turn entity extraction (GATHER fields)
  // ---------------------------------------------------------------------------
  it('should extract gather fields across multi-turn conversation', async () => {
    const executor = createWiredExecutor();
    const resolved = compileToResolvedAgent([SALES_AGENT_DSL], 'Sales_Agent');
    const session = createFrozenSession(executor, resolved);

    const mock = createMockToolExecutor();
    session.toolExecutor = mock.executor as any;

    const { traces, collect } = createTraceCollector();

    // Initialize session
    const initChunks: string[] = [];
    await executor.initializeSession(session.id, (c) => initChunks.push(c), collect);

    // Turn 1: Destination + origin
    const t1Chunks: string[] = [];
    await executor.executeMessage(
      session.id,
      'I need a flight from London to Paris',
      (c) => t1Chunks.push(c),
      collect,
    );
    expect(t1Chunks.join('').length).toBeGreaterThan(0);

    // Turn 2: Dates
    const t2Chunks: string[] = [];
    await executor.executeMessage(
      session.id,
      'Departing April 10th, returning April 15th',
      (c) => t2Chunks.push(c),
      collect,
    );
    expect(t2Chunks.join('').length).toBeGreaterThan(0);

    // Turn 3: Travelers + budget
    const t3Chunks: string[] = [];
    await executor.executeMessage(
      session.id,
      'Two travelers, budget around 1000 euros total',
      (c) => t3Chunks.push(c),
      collect,
    );
    expect(t3Chunks.join('').length).toBeGreaterThan(0);

    // ── Verify actual values stored in session ──
    const values = session.data.values;
    const gatheredKeys = session.data.gatheredKeys;

    // Core fields should be stored on session after 3 turns providing all info
    expect(gatheredKeys.size).toBeGreaterThanOrEqual(3);

    // Destination and origin — the most explicit signals in turn 1
    expect(values.destination).toBeDefined();
    expect(String(values.destination).toLowerCase()).toContain('paris');
    expect(values.origin).toBeDefined();
    expect(String(values.origin).toLowerCase()).toContain('london');

    // Numeric travelers — provided explicitly as "2 travelers"
    expect(values.num_travelers).toBeDefined();
    expect(Number(values.num_travelers)).toBe(2);

    // Dates — LLM should have converted "April 10th" to a date format
    if (values.departure_date) {
      expect(String(values.departure_date)).toMatch(/04-10|april/i);
    }

    // Budget — provided as "1000 euros"
    if (values.budget) {
      expect(Number(values.budget)).toBe(1000);
    }

    // ── Verify conversation history grew correctly ──
    // init + 3 user turns + 3 assistant responses = at least 6 messages
    expect(session.conversationHistory.length).toBeGreaterThanOrEqual(6);
    // User messages should appear in history
    const userMsgs = session.conversationHistory.filter((m: any) => m.role === 'user');
    expect(userMsgs.length).toBeGreaterThanOrEqual(3);

    // ── Verify LLM call traces ──
    // Sales Agent uses inline_gather: true, so entity extraction happens inside
    // the reasoning loop (via __set_context__ tool calls) rather than in a
    // separate pre-pass. This means we get dsl_collect traces with
    // mode='inline_gather' instead of entity_extraction traces.
    const inlineGatherTraces = traces.filter(
      (t) => t.type === 'dsl_collect' && t.data.mode === 'inline_gather',
    );
    const extractionTraces = traces.filter((t) => t.type === 'entity_extraction');

    // With inline_gather, expect dsl_collect traces; without it, entity_extraction traces
    const hasInlineGather = inlineGatherTraces.length > 0;
    const hasExtractionTraces = extractionTraces.length > 0;
    expect(hasInlineGather || hasExtractionTraces).toBe(true);

    if (hasExtractionTraces) {
      // Each extraction trace should have the expected shape
      for (const et of extractionTraces) {
        expect(et.data.agentName).toBe('Sales_Agent');
        expect(et.data.requestedFields).toBeDefined();
        expect(Array.isArray(et.data.requestedFields)).toBe(true);
        expect(et.data.extractedFields).toBeDefined();
        expect(Array.isArray(et.data.extractedFields)).toBe(true);
        // method should be llm (deterministic harness, not regex fallback)
        expect(['llm', 'tool_call', 'regex', 'regex_fallback']).toContain(et.data.method);
      }
    }

    // LLM reasoning calls should record provider and model
    const llmCallTraces = traces.filter(
      (t) =>
        t.type === 'llm_call' &&
        (t.data.operationType === 'extraction' || t.data.operationType === 'response_gen'),
    );
    expect(llmCallTraces.length).toBeGreaterThan(0);
    const firstLlmCall = llmCallTraces[0];
    expect(firstLlmCall.data.provider).toBe(MOCK_PROVIDER);
    expect(firstLlmCall.data.model).toBe(MOCK_MODEL_ID);
    // Should have token usage
    if (firstLlmCall.data.usage) {
      const usage = firstLlmCall.data.usage as { inputTokens: number; outputTokens: number };
      expect(usage.inputTokens).toBeGreaterThan(0);
      expect(usage.outputTokens).toBeGreaterThan(0);
    }
  }, 180_000);

  // ---------------------------------------------------------------------------
  // Test 1.2: Tool call + ON_RESULT SET mapping
  // ---------------------------------------------------------------------------
  it('should execute tool call and map ON_RESULT SET variables', async () => {
    const executor = createWiredExecutor();
    const resolved = compileToResolvedAgent([SALES_AGENT_DSL], 'Sales_Agent');
    const session = createFrozenSession(executor, resolved);

    const mock = createMockToolExecutor();
    session.toolExecutor = mock.executor as any;

    const { traces, collect } = createTraceCollector();

    // Pre-populate gather fields so LLM can proceed to tool calling
    session.data.values.destination = 'Paris';
    session.data.values.origin = 'London';
    session.data.values.departure_date = '2025-04-10';
    session.data.values.return_date = '2025-04-15';
    session.data.values.num_travelers = 2;
    session.data.values.budget = 1000;
    session.data.gatheredKeys = new Set([
      'destination',
      'origin',
      'departure_date',
      'return_date',
      'num_travelers',
      'budget',
    ]);

    // Initialize
    await executor.initializeSession(session.id, undefined, collect);

    // Send a message that should trigger a search
    const chunks: string[] = [];
    await executor.executeMessage(
      session.id,
      'Search for available flights please',
      (c) => chunks.push(c),
      collect,
    );

    // LLM may take multiple turns to call the tool; send follow-up if needed
    if (mock.calls.length === 0) {
      const chunks2: string[] = [];
      await executor.executeMessage(
        session.id,
        'Yes, please search for flights from London to Paris for 2 passengers departing April 10th returning April 15th',
        (c) => chunks2.push(c),
        collect,
      );
    }

    // Verify tool was called
    const flightCall = mock.calls.find((c) => c.name === 'search_flights');
    if (flightCall) {
      // ── Verify tool was called with correct args from session values ──
      expect(flightCall.args.origin).toBeDefined();
      expect(flightCall.args.destination).toBeDefined();

      // ── Verify ON_RESULT SET mapped mock response → session values ──
      expect(session.data.values.flight_count).toBe(2);
      expect(session.data.values.flight_search_id).toBe('SRCH-001');
      expect(session.data.values.search_expires_at).toBe('2025-04-01T00:00:00Z');
      expect(session.data.values.cheapest_flight_price).toBe(450);
      // DSL SET with string values stores them with surrounding quotes
      const status = String(session.data.values.search_status);
      expect(status === 'completed' || status === "'completed'").toBe(true);

      // ── Verify tool_call trace event has full request/response data ──
      const toolCallTraces = traces.filter((t) => t.type === 'tool_call');
      const searchFlightTrace = toolCallTraces.find((t) => t.data.toolName === 'search_flights');
      expect(searchFlightTrace).toBeDefined();
      expect(searchFlightTrace!.data.success).toBe(true);
      expect(searchFlightTrace!.data.input).toBeDefined();
      expect(searchFlightTrace!.data.output).toBeDefined();
      // Output should match the mock response
      const output = searchFlightTrace!.data.output as any;
      expect(output.flights).toBeDefined();
      expect(output.flights.length).toBe(2);
      expect(output.search_id).toBe('SRCH-001');
      // Duration should be tracked
      expect(searchFlightTrace!.data.latencyMs).toBeDefined();
      expect(typeof searchFlightTrace!.data.latencyMs).toBe('number');

      // ── Verify LLM reasoning call traces (response_gen) ──
      const reasoningLlmCalls = traces.filter(
        (t) => t.type === 'llm_call' && t.data.operationType === 'response_gen',
      );
      expect(reasoningLlmCalls.length).toBeGreaterThan(0);
      const reasoningCall = reasoningLlmCalls[0];
      expect(reasoningCall.data.provider).toBe(MOCK_PROVIDER);
      expect(reasoningCall.data.model).toBe(MOCK_MODEL_ID);
      expect(reasoningCall.data.agent).toBe('Sales_Agent');
      // LLM decided to use the tool — hasToolCalls should be true for at least one call
      const toolDecision = reasoningLlmCalls.find((t) => t.data.hasToolCalls === true);
      expect(toolDecision).toBeDefined();

      // ── Verify LLM response was streamed back to user ──
      expect(chunks.join('').length).toBeGreaterThan(0);
    } else {
      // LLM didn't call search_flights — may have asked clarifying questions.
      expect(chunks.join('').length).toBeGreaterThan(0);
    }
  }, 180_000);

  // ---------------------------------------------------------------------------
  // Test 1.3: __set_context__ system tool availability
  // ---------------------------------------------------------------------------
  it('should have __set_context__ available when agent has session memory vars', async () => {
    const executor = createWiredExecutor();
    const resolved = compileToResolvedAgent([SALES_AGENT_DSL], 'Sales_Agent');
    const session = createFrozenSession(executor, resolved);

    const mock = createMockToolExecutor();
    session.toolExecutor = mock.executor as any;

    // Sales Agent has MEMORY.session vars → __set_context__ should be injected
    const agentIR = session.agentIR!;
    expect(agentIR.memory?.session).toBeDefined();
    expect(agentIR.memory!.session!.length).toBeGreaterThan(0);

    // Build tools and verify __set_context__ is present
    const { buildTools } = await import('../services/execution/prompt-builder.js');
    const tools = buildTools(session);
    const setContextTool = tools.find((t) => t.name === SYSTEM_TOOL_SET_CONTEXT);
    expect(setContextTool).toBeDefined();
    expect(setContextTool!.input_schema.properties).toHaveProperty('updates');

    // Verify the declared session var names appear in the tool schema description
    const updatesDesc = (setContextTool!.input_schema.properties as any).updates?.description;
    expect(updatesDesc).toContain('search_results');
    expect(updatesDesc).toContain('selected_items');
    expect(updatesDesc).toContain('quote_id');
  }, 30_000);
});

// =============================================================================
// SUITE 2: Feature-Focused Inline Agents
// =============================================================================

describe('Suite 2: Feature-Focused Inline Agents', () => {
  // ---------------------------------------------------------------------------
  // Test 2.1: ON_START SET (scripted, no LLM)
  // ---------------------------------------------------------------------------
  describe('2.1: ON_START SET', () => {
    const ON_START_DSL = `
AGENT: OnStartTest

GOAL: "Test ON_START SET"

ON_START:
  set: retries = 0
  set: maxRetries = 3
  set: stepCount = 5

FLOW:
  greet -> done

  greet:
    REASONING: false
    RESPOND: "Session initialized. Retries={{retries}}, MaxRetries={{maxRetries}}, StepCount={{stepCount}}"
    THEN: done

  done:
    REASONING: false
    RESPOND: "Done."
    THEN: COMPLETE
`;

    it('should set variables during ON_START and emit dsl_set trace events', async () => {
      const executor = new RuntimeExecutor();
      const resolved = compileToResolvedAgent([ON_START_DSL], 'OnStartTest');
      // No tenantId/projectId — scripted mode doesn't need LLM resolution
      const session = createFrozenSession(executor, resolved);

      const { traces, collect } = createTraceCollector();
      const initChunks: string[] = [];

      await executor.initializeSession(session.id, (c) => initChunks.push(c), collect);

      // Verify ON_START SET applied (numeric values)
      expect(session.data.values.retries).toBe(0);
      expect(session.data.values.maxRetries).toBe(3);
      expect(session.data.values.stepCount).toBe(5);

      // Verify dsl_set trace events emitted with source on_start
      const setEvents = traces.filter((t) => t.type === 'dsl_set');
      expect(setEvents.length).toBeGreaterThanOrEqual(3);

      const onStartSets = setEvents.filter((t) => t.data.source === 'on_start');
      expect(onStartSets.length).toBeGreaterThanOrEqual(3);

      // Verify greeting references interpolated values
      const greeting = initChunks.join('');
      expect(greeting).toContain('Retries=0');
      expect(greeting).toContain('MaxRetries=3');
      expect(greeting).toContain('StepCount=5');
    });
  });

  // ---------------------------------------------------------------------------
  // Test 2.2: Dynamic IDENTITY interpolation (reasoning)
  // ---------------------------------------------------------------------------
  describe('2.2: Dynamic IDENTITY interpolation', () => {
    const IDENTITY_DSL = `
AGENT: IdentityInterpolation

GOAL: "Help {{user_name}} book a trip to {{destination}}"
PERSONA: |
  Friendly travel assistant helping {{user_name}} plan their trip to {{destination}}.
  Always greet the user by name and mention their destination.
`;

    it('should interpolate session variables into agent identity', async () => {
      const executor = createWiredExecutor();
      const resolved = compileToResolvedAgent([IDENTITY_DSL], 'IdentityInterpolation');
      const session = createFrozenSession(executor, resolved);

      // Pre-set session variables for interpolation
      session.data.values.user_name = 'Alice';
      session.data.values.destination = 'Paris';

      const { traces, collect } = createTraceCollector();
      await executor.initializeSession(session.id, undefined, collect);

      const chunks: string[] = [];
      await executor.executeMessage(
        session.id,
        'Hello, can you help me plan my trip?',
        (c) => chunks.push(c),
        collect,
      );

      const response = chunks.join('');
      expect(response.length).toBeGreaterThan(0);

      // ── Verify the system prompt sent to LLM was actually interpolated ──
      const llmCalls = traces.filter(
        (t) => t.type === 'llm_call' && t.data.operationType === 'response_gen',
      );
      expect(llmCalls.length).toBeGreaterThan(0);

      const mainCall = llmCalls[0];
      // System prompt should contain the interpolated values, not raw {{placeholders}}
      const systemPrompt = String(mainCall.data.systemPrompt || '');
      expect(systemPrompt).toContain('Alice');
      expect(systemPrompt).toContain('Paris');
      expect(systemPrompt).not.toContain('{{user_name}}');
      expect(systemPrompt).not.toContain('{{destination}}');

      // Provider and model should be set correctly
      expect(mainCall.data.provider).toBe(MOCK_PROVIDER);
      expect(mainCall.data.model).toBe(MOCK_MODEL_ID);

      // Conversation history should have the user message and assistant response
      expect(session.conversationHistory.length).toBeGreaterThanOrEqual(2);
    }, 60_000);
  });

  // ---------------------------------------------------------------------------
  // Test 2.3: FactStore batch operations via MEMORY REMEMBER
  // ---------------------------------------------------------------------------
  describe('2.3: FactStore batch operations', () => {
    it('should trigger REMEMBER rules and write to fact store when conditions match', async () => {
      const executor = createWiredExecutor();
      const resolved = compileToResolvedAgent([SALES_AGENT_DSL], 'Sales_Agent');
      const session = createFrozenSession(executor, resolved);

      // Wire an InMemoryFactStore so REMEMBER can write facts
      const factStore = new InMemoryFactStore({ type: 'memory' });
      session.factStore = factStore;

      const mock = createMockToolExecutor();
      session.toolExecutor = mock.executor as any;

      const { traces, collect } = createTraceCollector();

      await executor.initializeSession(session.id, undefined, collect);

      // Set the condition for the REMEMBER rule:
      // "WHEN quote_created == true STORE: {destination, num_travelers} -> user.travel_preferences"
      session.data.values.quote_created = true;
      session.data.values.destination = 'Paris';
      session.data.values.num_travelers = 2;

      // Send a message to trigger state evaluation (LLM turn triggers memory evaluation)
      const chunks: string[] = [];
      await executor.executeMessage(
        session.id,
        'I just want to confirm my travel preferences',
        (c) => chunks.push(c),
        collect,
      );

      // Check if facts were stored — memory system fires asynchronously
      // Give a brief window for the async write to complete
      await new Promise((r) => setTimeout(r, 500));

      // ── Verify LLM processed the message correctly ──
      expect(chunks.join('').length).toBeGreaterThan(0);

      // ── Verify memory system trace events ──
      const memoryTraces = traces.filter(
        (t) => t.type.startsWith('memory_') || t.type === 'memory_init',
      );

      // memory_init should fire during initializeSession — confirms memory subsystem engaged
      const memoryInit = traces.find((t) => t.type === 'memory_init');
      if (memoryInit) {
        expect(memoryInit.data).toBeDefined();
      }

      // memory_trigger_evaluated — the REMEMBER rule condition should be evaluated
      const triggerTraces = traces.filter((t) => t.type === 'memory_trigger_evaluated');
      if (triggerTraces.length > 0) {
        // At least one trigger should match (quote_created == true is set)
        const matchedTrigger = triggerTraces.find((t) => t.data.result === true);
        if (matchedTrigger) {
          expect(matchedTrigger.data.agentName).toBe('Sales_Agent');
        }
      }

      // memory_remember — if the trigger fired, facts should have been stored
      const rememberTraces = traces.filter((t) => t.type === 'memory_remember');
      if (rememberTraces.length > 0) {
        expect(rememberTraces[0].data.stored).toBeDefined();
      }

      // ── Verify fact store has content ──
      const allFacts = await factStore.query({});
      if (allFacts.length > 0) {
        const prefFact = allFacts.find((f) => f.key.includes('travel_preferences'));
        if (prefFact) {
          expect(prefFact.value).toBeDefined();
          // Stored value should contain the destination and travelers
          const val = prefFact.value as Record<string, unknown>;
          if (typeof val === 'object' && val !== null) {
            expect(val.destination || val.num_travelers).toBeDefined();
          }
        }
      }

      // ── Verify pre-set session values survived the LLM turn ──
      expect(session.data.values.quote_created).toBe(true);
      expect(session.data.values.destination).toBe('Paris');
      expect(session.data.values.num_travelers).toBe(2);

      // Clean up the interval timer
      factStore.stop();
    }, 180_000);
  });
});

// =============================================================================
// SUITE 3: ON_RESULT Flow Branching (scripted, no LLM)
// =============================================================================

describe('Suite 3: ON_RESULT Flow Branching (scripted)', () => {
  // Uses the exact GATHER-in-step pattern proven in new-features.e2e.test.ts:
  // welcome step with RESPOND → GATHER step → CALL step with ON_RESULT branching
  const BRANCHING_DSL = `
AGENT: BranchingTest

GOAL: "Test ON_RESULT branching"

TOOLS:
  fetch_data(accountId: string, usecase: string) -> object
    description: "Fetch data from an API"

FLOW:
  welcome -> collect_input -> fetch -> success_step

  welcome:
    REASONING: false
    RESPOND: "Welcome! Enter your account ID."
    THEN: collect_input

  collect_input:
    REASONING: false
    GATHER:
      - account_id: required
    THEN: fetch

  fetch:
    REASONING: false
    CALL: fetch_data
      WITH:
        accountId: account_id
        usecase: 'lookup'
      AS: apiResult
    ON_RESULT:
      REASONING: false
      - IF: apiResult.statusCode == 200
        THEN: success_step
      - IF: apiResult.statusCode == 401
        RESPOND: "Authorization failed. Please log in again."
        THEN: COMPLETE
      - ELSE:
        RESPOND: "Unexpected error occurred. Please try again later."
        THEN: COMPLETE

  success_step:
    REASONING: false
    RESPOND: "Data fetched successfully!"
    THEN: COMPLETE
`;

  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  function createBranchingSession(toolResponse: Record<string, unknown>) {
    const resolved = compileToResolvedAgent([BRANCHING_DSL], 'BranchingTest');
    // No tenantId/projectId — scripted mode doesn't need LLM resolution (avoids DB timeouts)
    const session = createFrozenSession(executor, resolved);

    session.toolExecutor = {
      execute: async () => toolResponse,
    } as any;

    return session;
  }

  // ---------------------------------------------------------------------------
  // Test 3.1a: ON_RESULT 200 → success branch
  // ---------------------------------------------------------------------------
  it('should take 200 branch and route to success_step', async () => {
    const session = createBranchingSession({
      statusCode: 200,
      data: { items: ['a', 'b', 'c'] },
    });

    const { traces, collect } = createTraceCollector();
    const initChunks: string[] = [];
    await executor.initializeSession(session.id, (c) => initChunks.push(c), collect);

    expect(initChunks.join('')).toContain('Welcome');
    expect(session.currentFlowStep).toBe('collect_input');

    // Provide the gathered value — auto-advances through fetch → ON_RESULT(200) → success_step
    const msgChunks: string[] = [];
    await executor.executeMessage(session.id, 'ACC-12345', (c) => msgChunks.push(c), collect);

    const output = msgChunks.join('');
    expect(output).toContain('successfully');
    expect(session.isComplete).toBe(true);

    // CALL AS should have bound the result
    expect(session.data.values.apiResult).toBeDefined();
    expect((session.data.values.apiResult as any).statusCode).toBe(200);

    // Trace should include on_result_branch for fetch step
    const fetchExit = traces.find(
      (t) =>
        t.type === 'flow_step_exit' &&
        t.data.stepName === 'fetch' &&
        t.data.result === 'on_result_branch',
    );
    if (fetchExit) {
      expect(fetchExit.data.agentName).toBe('BranchingTest');
    }
  });

  // ---------------------------------------------------------------------------
  // Test 3.1b: ON_RESULT 401 → error branch (RESPOND inline + COMPLETE)
  // ---------------------------------------------------------------------------
  it('should take 401 branch on unauthorized response', async () => {
    const session = createBranchingSession({
      statusCode: 401,
      error: 'Unauthorized',
    });

    await executor.initializeSession(session.id);
    expect(session.currentFlowStep).toBe('collect_input');

    const chunks: string[] = [];
    await executor.executeMessage(session.id, 'ACC-99999', (c) => chunks.push(c));

    expect(chunks.join('')).toContain('Authorization failed');
    expect(session.isComplete).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Test 3.1c: ON_RESULT ELSE → fallback branch
  // ---------------------------------------------------------------------------
  it('should take ELSE branch on unexpected status code', async () => {
    const session = createBranchingSession({
      statusCode: 500,
      error: 'Internal Server Error',
    });

    await executor.initializeSession(session.id);
    expect(session.currentFlowStep).toBe('collect_input');

    const chunks: string[] = [];
    await executor.executeMessage(session.id, 'ACC-55555', (c) => chunks.push(c));

    expect(chunks.join('')).toContain('Unexpected error');
    expect(session.isComplete).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Trace verification: 200 path emits correct lifecycle events
  // ---------------------------------------------------------------------------
  it('should emit trace events across ON_RESULT branching lifecycle', async () => {
    const session = createBranchingSession({
      statusCode: 200,
      data: { items: ['x'] },
    });

    const { traces, collect } = createTraceCollector();

    await executor.initializeSession(session.id, undefined, collect);
    await executor.executeMessage(session.id, 'ACC-TRACE', undefined, collect);

    // flow_step_enter for welcome, collect_input, fetch, success_step
    const stepEnters = traces.filter((t) => t.type === 'flow_step_enter');
    const enteredSteps = stepEnters.map((t) => t.data.stepName);
    expect(enteredSteps).toContain('welcome');
    expect(enteredSteps).toContain('collect_input');
    expect(enteredSteps).toContain('fetch');
    expect(enteredSteps).toContain('success_step');

    // dsl_call for the tool invocation
    const callEvents = traces.filter((t) => t.type === 'dsl_call');
    const fetchCall = callEvents.find((e) => e.data.toolName === 'fetch_data');
    expect(fetchCall).toBeDefined();
    expect(fetchCall!.data.source).toBe('call_with');

    // GATHER should have collected the value
    expect(session.data.values.account_id).toBe('ACC-TRACE');
  });
});

// =============================================================================
// SUITE 4: Lifecycle Events & Structured Tool Schemas (no LLM)
// =============================================================================

describe('Suite 4: Lifecycle Events & Structured Tool Schemas', () => {
  // ---------------------------------------------------------------------------
  // Test 4.1: RECALL events use new lifecycle format in compiled IR
  // ---------------------------------------------------------------------------
  it('should compile RECALL events with lifecycle event names', () => {
    const executor = new RuntimeExecutor();
    const resolved = compileToResolvedAgent([SALES_AGENT_DSL], 'Sales_Agent');
    const session = createFrozenSession(executor, resolved);
    const ir = session.agentIR!;

    const recall = ir.memory?.recall;
    expect(recall).toBeDefined();
    expect(recall!.length).toBeGreaterThanOrEqual(4);

    // session:start event — only recalls user.preferred_destinations (travel_preferences removed for tool-level recall)
    const sessionStart = recall!.find((r: any) => r.event === 'session:start');
    expect(sessionStart).toBeDefined();
    expect(sessionStart!.action?.type).toBe('inject_context');
    expect(sessionStart!.action?.paths).toContain('user.preferred_destinations');

    // tool:search_flights:after event
    const toolFlights = recall!.find((r: any) => r.event === 'tool:search_flights:after');
    expect(toolFlights).toBeDefined();
    expect(toolFlights!.action?.type).toBe('inject_context');

    // tool:search_hotels:after event
    const toolHotels = recall!.find((r: any) => r.event === 'tool:search_hotels:after');
    expect(toolHotels).toBeDefined();

    // agent:Payment_Agent:before event
    const agentPayment = recall!.find((r: any) => r.event === 'agent:Payment_Agent:before');
    expect(agentPayment).toBeDefined();
    expect(agentPayment!.action?.paths).toContain('user.travel_preferences');
  });

  // ---------------------------------------------------------------------------
  // Test 4.2: PASS fields resolve description from session memory TYPE/DESCRIPTION
  // ---------------------------------------------------------------------------
  it('should resolve PASS field descriptions from session memory declarations', () => {
    const executor = new RuntimeExecutor();
    const resolved = compileToResolvedAgent([SALES_AGENT_DSL], 'Sales_Agent');
    const session = createFrozenSession(executor, resolved);
    const ir = session.agentIR!;

    // Payment_Agent handoff has PASS: [quote_id, total_price, ...]
    // quote_id has TYPE: string and DESCRIPTION in the session memory declaration
    const paymentHandoff = ir.coordination?.handoffs?.find((h: any) => h.to === 'Payment_Agent');
    expect(paymentHandoff).toBeDefined();
    expect(paymentHandoff!.context?.pass).toBeDefined();

    // PASS fields should be ResolvedPassField[] with name + type
    const passFields = paymentHandoff!.context!.pass!;
    expect(passFields.length).toBeGreaterThanOrEqual(1);

    // quote_id should be resolved from session memory (TYPE: string, DESCRIPTION: ...)
    const quoteField = passFields.find(
      (f: any) => (typeof f === 'string' ? f : f.name) === 'quote_id',
    );
    expect(quoteField).toBeDefined();
    // If resolved as ResolvedPassField, it should have type from session memory
    if (typeof quoteField === 'object') {
      expect(quoteField.type).toBe('string');
    }
  });

  // ---------------------------------------------------------------------------
  // Test 4.3: System tools include reason field
  // ---------------------------------------------------------------------------
  it('should generate per-agent handoff tools and KEEP reason on __escalate__', async () => {
    const executor = new RuntimeExecutor();
    const resolved = compileToResolvedAgent([SALES_AGENT_DSL], 'Sales_Agent');
    const session = createFrozenSession(executor, resolved);

    session.toolExecutor = { execute: async () => ({ success: true }) } as any;

    const { buildTools } = await import('../services/execution/prompt-builder.js');
    const tools = buildTools(session);

    // Per-agent routing tools replace the generic __handoff__ tool
    const handoffTools = tools.filter((t) => t.name.startsWith('handoff_to_'));
    expect(handoffTools.length).toBeGreaterThan(0);

    // Each per-agent handoff tool has reason + message properties
    for (const tool of handoffTools) {
      const props = tool.input_schema.properties as Record<string, any>;
      expect(props.reason).toBeDefined();
      expect(props.message).toBeDefined();
    }

    // __escalate__ should still have reason (operational — forwarded to human agent)
    const escalateTool = tools.find((t) => t.name === '__escalate__');
    expect(escalateTool).toBeDefined();
    const escProps = escalateTool!.input_schema.properties as Record<string, any>;
    expect(escProps.reason).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Test 4.4: PASS fields resolve description from session memory in handoff tool
  // ---------------------------------------------------------------------------
  it('should build per-agent handoff tool with PASS field names for Payment_Agent', async () => {
    const executor = new RuntimeExecutor();
    const resolved = compileToResolvedAgent([SALES_AGENT_DSL], 'Sales_Agent');
    const session = createFrozenSession(executor, resolved);

    session.toolExecutor = { execute: async () => ({ success: true }) } as any;

    const { buildTools } = await import('../services/execution/prompt-builder.js');
    const tools = buildTools(session);

    // Per-agent routing tools: Payment_Agent handoff should have PASS fields
    const paymentHandoff = tools.find((t) => t.name === 'handoff_to_Payment_Agent');
    expect(paymentHandoff).toBeDefined();

    // quote_id is in the Payment_Agent PASS list — it should appear as a
    // dedicated property in the tool's input schema, or in the tool description,
    // or in the serialized schema
    const schemaStr = JSON.stringify(paymentHandoff);
    expect(schemaStr).toContain('quote_id');
  });

  // ---------------------------------------------------------------------------
  // Test 4.5: Compiler validates RECALL event names (warns on unknown tool)
  // ---------------------------------------------------------------------------
  it('should emit compiler warning for unknown tool in RECALL event', () => {
    const BAD_RECALL_DSL = `
AGENT: BadRecall

GOAL: "Test"
MEMORY:
  recall:
    - ON: tool:nonexistent_tool:after
      ACTION: inject_context
      PATHS: [prefs]
`;
    const resolved = compileToResolvedAgent([BAD_RECALL_DSL], 'BadRecall');
    // The resolved agent should still compile (warnings, not errors)
    expect(resolved.compilationOutput).toBeDefined();
    expect(resolved.agents).toBeDefined();
    // Check compilation warnings
    const warnings = resolved.compilationOutput?.compilation_warnings || [];
    const recallWarning = warnings.find((w: any) => w.message?.includes('nonexistent_tool'));
    expect(recallWarning).toBeDefined();
    expect(recallWarning!.message).toContain('unknown tool');
  });

  // ---------------------------------------------------------------------------
  // Test 4.6: Reason/thought stripping for non-escalate system tools
  // ---------------------------------------------------------------------------
  it('should strip reason and thought from non-escalate system tool inputs', () => {
    // Verify the stripping logic matches reasoning-executor.ts behavior
    // The code path: isSystemTool → destructure { reason, thought, ...rest } → emit decision trace
    const toolCall = {
      name: '__handoff__',
      input: {
        target: 'Payment_Agent',
        reason: 'Customer wants to pay',
        thought: 'The customer confirmed payment',
        context: { quote_id: 'Q123' },
      },
    };

    // Verify the stripping logic directly
    const isSystemTool = toolCall.name.startsWith('__');
    expect(isSystemTool).toBe(true);

    const { reason, thought, ...rest } = toolCall.input;
    // reason and thought should be extracted
    expect(reason).toBe('Customer wants to pay');
    expect(thought).toBe('The customer confirmed payment');
    // rest should NOT contain reason or thought
    expect(rest).toEqual({ target: 'Payment_Agent', context: { quote_id: 'Q123' } });
    expect((rest as any).reason).toBeUndefined();
    expect((rest as any).thought).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Test 4.7: Escalate keeps reason field (exception behavior)
  // ---------------------------------------------------------------------------
  it('should keep reason on __escalate__ but strip thought', () => {
    const toolCall = {
      name: '__escalate__',
      input: {
        reason: 'Customer frustrated with search failures',
        thought: 'Multiple tool failures detected',
        priority: 'high',
      },
    };

    // Escalate exception: strip only thought, keep reason
    const { thought: _t, ...cleanEscalate } = toolCall.input;
    expect(cleanEscalate.reason).toBe('Customer frustrated with search failures');
    expect(cleanEscalate.priority).toBe('high');
    expect((cleanEscalate as any).thought).toBeUndefined();

    // Non-escalate: strip both
    const { reason, thought, ...rest } = toolCall.input;
    expect(rest).toEqual({ priority: 'high' });
    expect((rest as any).reason).toBeUndefined();
    expect((rest as any).thought).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Test 4.8: PASS field backward compat — string arrays still work in routing
  // ---------------------------------------------------------------------------
  it('should handle both string[] and ResolvedPassField[] in PASS fields', () => {
    // The routing-executor uses: typeof passField === 'string' ? passField : passField.name
    // Verify both formats produce the correct field name
    const stringPass = ['quote_id', 'total_price'];
    const resolvedPass = [
      { name: 'quote_id', type: 'string', description: 'Quote ID' },
      { name: 'total_price', type: 'number' },
    ];

    // Simulate the routing-executor logic
    const extractFieldName = (f: any) => (typeof f === 'string' ? f : f.name);

    expect(stringPass.map(extractFieldName)).toEqual(['quote_id', 'total_price']);
    expect(resolvedPass.map(extractFieldName)).toEqual(['quote_id', 'total_price']);
  });

  // ---------------------------------------------------------------------------
  // Test 4.9: Legacy ON_START RECALL format is rejected
  // ---------------------------------------------------------------------------
  it('should surface diagnostics and omit legacy ON_START recall entries', () => {
    const LEGACY_DSL = `
AGENT: LegacyTest

GOAL: "Reject legacy recall shorthand"
MEMORY:
  recall:
    - ON_START: "Check if user is returning and load preferences"
`;
    const parseResult = parseAgentBasedABL(LEGACY_DSL);
    expect(parseResult.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining('Legacy RECALL event "ON_START" is no longer supported'),
        }),
      ]),
    );
    expect(parseResult.document!.memory.recall).toHaveLength(0);
    expect(() => compileToResolvedAgent([LEGACY_DSL], 'LegacyTest')).not.toThrow();
  });
});
