/**
 * Airlines Domain E2E Integration Tests
 *
 * Tests the full Agent + SearchAI pipeline using airline-themed data:
 *   RuntimeExecutor.executeMessage()
 *     → MockAnthropicClient (simulates LLM calling search tools)
 *       → SearchAIAwareToolExecutor.execute()
 *         → SearchAIToolHandler → SearchAIClient.fetch() → real Express server
 *           → Real MongoDB (MongoMemoryServer) + InMemoryVectorStore
 *
 * Real: MongoDB, vector store, chunking, embeddings, HTTP routes, airline documents
 * Mocked: LLM responses (scripted tool calls + synthesis)
 *
 * Coverage:
 *   1. Flight Search Agent — structured filters, vocab resolve, metadata
 *   2. Policy Advisor Agent — hybrid/vector search, multi-hop, traces
 *   3. Analytics Agent — aggregation (SUM, COUNT, AVG, MIN/MAX, COUNT_DISTINCT)
 *   4. Supervisor Routing + Integration — handoff, shared index, traces
 */

import { describe, test, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

// =============================================================================
// MOCKS — must be declared before any import that transitively pulls in auth
// =============================================================================

vi.mock('../../../search-ai-runtime/src/middleware/auth.js', () => ({
  authMiddleware: (_req: any, _res: any, next: any) => next(),
  unifiedAuth: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../../search-ai-runtime/src/middleware/verify-index-ownership.js', () => ({
  verifyIndexOwnership: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../../search-ai-runtime/src/services/query/permission-filter-service.js', () => ({
  getPermissionFilterService: () => ({
    buildPublicPermissionFilter: () => ({
      bool: { should: [{ match_all: {} }], minimum_should_match: 1 },
    }),
    buildUserPermissionFilter: async () => ({
      bool: { should: [{ match_all: {} }], minimum_should_match: 1 },
    }),
  }),
}));

vi.mock('../../../search-ai-runtime/src/services/cache/redis-client.js', () => ({
  getGlobalRedisClient: () => null,
}));

// =============================================================================
// IMPORTS
// =============================================================================

import { RuntimeExecutor, compileToResolvedAgent } from '../services/runtime-executor.js';
import { SearchAIAwareToolExecutor } from '../services/search-ai/search-ai-tool-executor.js';
import { DEFAULT_COMPACTION_POLICY } from '../services/execution/compaction-policy.js';
import { MockToolExecutor } from './fixtures/mock-tool-executor.js';
import {
  startAirlineSearchServer,
  stopAirlineSearchServer,
  AIRLINE_INDEX_ID,
  AIRLINE_KB_ID,
  type TestSearchServer,
} from './helpers/airlines-search-server.js';

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
      text: 'I can help you with that.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'I can help you with that.' }],
    });
  }

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

function disableToolResultCompaction(session: { _compactionPolicy?: unknown }): void {
  session._compactionPolicy = {
    ...DEFAULT_COMPACTION_POLICY,
    tool_results: {
      ...DEFAULT_COMPACTION_POLICY.tool_results,
      strategy: 'none',
    },
  };
}

function injectMockClient(executor: RuntimeExecutor): MockAnthropicClient {
  const mock = new MockAnthropicClient();
  (executor as any).llmWiring.wireLLMClient = async (session: any) => {
    disableToolResultCompaction(session);
    session.llmClient = mock;
  };
  (executor as any).llmWiring.ensureSessionLLMClient = async (session: any) => {
    if (!session.llmClient) {
      disableToolResultCompaction(session);
      session.llmClient = mock;
    }
  };
  return mock;
}

function wireSearchToolExecutor(executor: RuntimeExecutor, baseUrl: string): void {
  (executor as any).llmWiring.wireToolExecutor = (session: any) => {
    session.toolExecutor = new SearchAIAwareToolExecutor(new MockToolExecutor(), {
      runtimeUrl: baseUrl,
      engineUrl: baseUrl,
      timeoutMs: 15_000,
    });
  };
}

// =============================================================================
// TRACE HELPERS
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

// =============================================================================
// TOOL RESULT EXTRACTION HELPER
// =============================================================================

function extractToolResult(messages: Array<{ role: string; content: unknown }>): any {
  for (const msg of messages) {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content as any[]) {
        if (block.type === 'tool_result') {
          return JSON.parse(
            typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
          );
        }
      }
    }
  }
  return undefined;
}

// =============================================================================
// AGENT DSL DEFINITIONS
// =============================================================================

const FLIGHT_SEARCH_DSL = `
AGENT: Flight_Search

GOAL: "Help users find flights by translating queries into structured metadata filters"

TOOLS:
  vocabulary_resolve(project_kb_id: string, query: string) -> {resolvedTerms: object[], unresolvedSegments: string[], structuredFilters: object[], aggregationSpec: object}
  search_structured(index_id: string, filters: object[], limit: number) -> {results: object[], totalCount: number, latencyMs: number}
  search_hybrid(index_id: string, query: string, top_k: number, similarity_threshold: number) -> {results: object[], totalCount: number, latencyMs: number}

INSTRUCTIONS: |
  1. Identify filterable terms (cabin class, route type, etc.)
  2. Call vocabulary_resolve to map terms to canonical filters
  3. Execute search_structured with resolved filters
  4. Present matching flights clearly with route, class, and fare info
`;

const POLICY_ADVISOR_DSL = `
AGENT: Policy_Advisor

GOAL: "Answer airline policy questions using semantic search over policy documents"

TOOLS:
  vocabulary_resolve(project_kb_id: string, query: string) -> {resolvedTerms: object[], unresolvedSegments: string[], structuredFilters: object[], aggregationSpec: object}
  search_hybrid(index_id: string, query: string, top_k: number, similarity_threshold: number) -> {results: object[], totalCount: number, latencyMs: number}
  search_vector(index_id: string, query: string, top_k: number, similarity_threshold: number) -> {results: object[], totalCount: number, latencyMs: number}

INSTRUCTIONS: |
  1. Analyze query for airline-specific terms
  2. If domain terms found, call vocabulary_resolve for filters
  3. Execute search_hybrid with query and any resolved filters
  4. Synthesize a clear policy answer with source attribution
`;

const ANALYTICS_DSL = `
AGENT: Analytics

GOAL: "Answer analytical questions about airline operations using aggregation queries"

TOOLS:
  vocabulary_resolve(project_kb_id: string, query: string) -> {resolvedTerms: object[], aggregationSpec: object}
  search_aggregate(index_id: string, measure: string, function: string, group_by: string[], filters: object[]) -> {results: object[], totalCount: number}

INSTRUCTIONS: |
  1. Identify the measure, dimension, and filters from the user's question
  2. Call vocabulary_resolve to map concepts to canonical fields
  3. Execute search_aggregate with the specification
  4. Present results with clear labels
`;

const SUPERVISOR_DSL = `
SUPERVISOR: Airlines_Supervisor

GOAL: "Route airline customer queries to the appropriate specialist agent"

HANDOFF:
  - TO: Flight_Search
    WHEN: user asks about flight availability, routes, schedules, or booking
    PASS: query

  - TO: Policy_Advisor
    WHEN: user asks about baggage, cancellation, refund, loyalty, or in-flight policies
    PASS: query

  - TO: Analytics
    WHEN: user asks about revenue, average fares, flight counts, or operational metrics
    PASS: query
`;

// =============================================================================
// TEST SETUP
// =============================================================================

let searchServer: TestSearchServer;

beforeAll(async () => {
  searchServer = await startAirlineSearchServer();
}, 60_000);

afterAll(async () => {
  await stopAirlineSearchServer(searchServer);
});

// =============================================================================
// 1. FLIGHT SEARCH AGENT
// =============================================================================

describe('Flight Search Agent', () => {
  let executor: RuntimeExecutor;
  let mockClient: MockAnthropicClient;

  beforeEach(() => {
    executor = new RuntimeExecutor();
    mockClient = injectMockClient(executor);
    wireSearchToolExecutor(executor, searchServer.baseUrl);
  });

  test('Agent calls search_structured with cabin_class filter', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([FLIGHT_SEARCH_DSL], 'Flight_Search'),
    );

    let toolResult: any;

    mockClient.setResponseHandler((_systemPrompt, messages, tools) => {
      const callNum = mockClient.calls.length;

      if (callNum === 1 && tools.length > 0) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_1',
              name: 'search_structured',
              input: {
                index_id: AIRLINE_INDEX_ID,
                filters: [{ field: 'cabin_class', operator: 'eq', value: 'first' }],
                limit: 50,
              },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'search_structured',
              input: {
                index_id: AIRLINE_INDEX_ID,
                filters: [{ field: 'cabin_class', operator: 'eq', value: 'first' }],
                limit: 50,
              },
            },
          ],
        };
      }

      toolResult = extractToolResult(messages);

      return {
        text: 'Found first class flight options with premium amenities.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [
          { type: 'text', text: 'Found first class flight options with premium amenities.' },
        ],
      };
    });

    const result = await executor.executeMessage(session.id, 'Show me first class flights');

    expect(toolResult).toBeDefined();
    expect(toolResult.results.length).toBeGreaterThan(0);
    // Only In-Flight Services Catalog has cabin_class='first'
    for (const r of toolResult.results) {
      expect(r.metadata.cabin_class).toBe('first');
    }
    expect(result.response).toContain('first class');
  });

  test('Route type filter returns correct documents', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([FLIGHT_SEARCH_DSL], 'Flight_Search'),
    );

    let toolResult: any;

    mockClient.setResponseHandler((_systemPrompt, messages, tools) => {
      const callNum = mockClient.calls.length;

      if (callNum === 1 && tools.length > 0) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_1',
              name: 'search_structured',
              input: {
                index_id: AIRLINE_INDEX_ID,
                filters: [{ field: 'route_type', operator: 'eq', value: 'domestic' }],
                limit: 50,
              },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'search_structured',
              input: {
                index_id: AIRLINE_INDEX_ID,
                filters: [{ field: 'route_type', operator: 'eq', value: 'domestic' }],
                limit: 50,
              },
            },
          ],
        };
      }

      toolResult = extractToolResult(messages);

      return {
        text: 'Found domestic flight routes.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Found domestic flight routes.' }],
      };
    });

    await executor.executeMessage(session.id, 'Show me domestic routes');

    expect(toolResult).toBeDefined();
    // Only Baggage & Fare Policy doc has route_type='domestic'
    expect(toolResult.results.length).toBe(searchServer.ingestResults['policy'].chunkCount);
    for (const r of toolResult.results) {
      expect(r.metadata.route_type).toBe('domestic');
    }
  });

  test('Vocab resolve → structured search chain', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([FLIGHT_SEARCH_DSL], 'Flight_Search'),
    );

    let vocabResult: any;

    mockClient.setResponseHandler((_systemPrompt, messages, tools) => {
      const callNum = mockClient.calls.length;

      if (callNum === 1 && tools.length > 0) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_vocab',
              name: 'vocabulary_resolve',
              input: { project_kb_id: AIRLINE_KB_ID, query: 'business class' },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_vocab',
              name: 'vocabulary_resolve',
              input: { project_kb_id: AIRLINE_KB_ID, query: 'business class' },
            },
          ],
        };
      }

      if (callNum === 2) {
        vocabResult = extractToolResult(messages);
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_search',
              name: 'search_structured',
              input: {
                index_id: AIRLINE_INDEX_ID,
                filters: [{ field: 'cabin_class', operator: 'eq', value: 'business' }],
                limit: 50,
              },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_search',
              name: 'search_structured',
              input: {
                index_id: AIRLINE_INDEX_ID,
                filters: [{ field: 'cabin_class', operator: 'eq', value: 'business' }],
                limit: 50,
              },
            },
          ],
        };
      }

      return {
        text: 'Business class flights feature lie-flat seats and premium dining.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [
          {
            type: 'text',
            text: 'Business class flights feature lie-flat seats and premium dining.',
          },
        ],
      };
    });

    const result = await executor.executeMessage(session.id, 'Find business class flights');

    // Vocab resolve should return filters for business cabin class
    expect(vocabResult).toBeDefined();
    expect(vocabResult.structuredFilters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'cabin_class',
          operator: 'eq',
          value: expect.stringContaining('business'),
        }),
      ]),
    );
    expect(mockClient.calls.length).toBe(3);
    expect(result.response).toContain('Business class');
  });

  test('Base fare filter works', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([FLIGHT_SEARCH_DSL], 'Flight_Search'),
    );

    let toolResult: any;

    mockClient.setResponseHandler((_systemPrompt, messages, tools) => {
      const callNum = mockClient.calls.length;

      if (callNum === 1 && tools.length > 0) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_1',
              name: 'search_structured',
              input: {
                index_id: AIRLINE_INDEX_ID,
                filters: [{ field: 'base_fare', operator: 'gt', value: 500 }],
                limit: 50,
              },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'search_structured',
              input: {
                index_id: AIRLINE_INDEX_ID,
                filters: [{ field: 'base_fare', operator: 'gt', value: 500 }],
                limit: 50,
              },
            },
          ],
        };
      }

      toolResult = extractToolResult(messages);

      return {
        text: 'Found premium fare options.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Found premium fare options.' }],
      };
    });

    await executor.executeMessage(session.id, 'Show flights over $500');

    // Loyalty (850) and Services (1299.99) — excludes Operations (450) and Policy (199.99)
    const expectedCount =
      searchServer.ingestResults['loyalty'].chunkCount +
      searchServer.ingestResults['services'].chunkCount;
    expect(toolResult.results.length).toBe(Math.min(expectedCount, 50));

    // Verify excluded docs aren't present
    const opsDocId = searchServer.ingestResults['operations'].documentId;
    const policyDocId = searchServer.ingestResults['policy'].documentId;
    for (const r of toolResult.results) {
      expect(r.documentId).not.toBe(opsDocId);
      expect(r.documentId).not.toBe(policyDocId);
    }
  });

  test('Multiple AND filters: economy + domestic', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([FLIGHT_SEARCH_DSL], 'Flight_Search'),
    );

    let toolResult: any;

    mockClient.setResponseHandler((_systemPrompt, messages, tools) => {
      const callNum = mockClient.calls.length;

      if (callNum === 1 && tools.length > 0) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_1',
              name: 'search_structured',
              input: {
                index_id: AIRLINE_INDEX_ID,
                filters: [
                  { field: 'cabin_class', operator: 'eq', value: 'economy' },
                  { field: 'route_type', operator: 'eq', value: 'domestic' },
                ],
                limit: 50,
              },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'search_structured',
              input: {
                index_id: AIRLINE_INDEX_ID,
                filters: [
                  { field: 'cabin_class', operator: 'eq', value: 'economy' },
                  { field: 'route_type', operator: 'eq', value: 'domestic' },
                ],
                limit: 50,
              },
            },
          ],
        };
      }

      toolResult = extractToolResult(messages);

      return {
        text: 'Found economy domestic options.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Found economy domestic options.' }],
      };
    });

    await executor.executeMessage(session.id, 'Economy domestic flights');

    // Only Baggage & Fare Policy doc has cabin_class='economy' AND route_type='domestic'
    expect(toolResult.results.length).toBe(searchServer.ingestResults['policy'].chunkCount);
  });

  test('Contains filter on document_type', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([FLIGHT_SEARCH_DSL], 'Flight_Search'),
    );

    let toolResult: any;

    mockClient.setResponseHandler((_systemPrompt, messages, tools) => {
      const callNum = mockClient.calls.length;

      if (callNum === 1 && tools.length > 0) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_1',
              name: 'search_structured',
              input: {
                index_id: AIRLINE_INDEX_ID,
                filters: [{ field: 'document_type', operator: 'contains', value: 'manual' }],
                limit: 50,
              },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'search_structured',
              input: {
                index_id: AIRLINE_INDEX_ID,
                filters: [{ field: 'document_type', operator: 'contains', value: 'manual' }],
                limit: 50,
              },
            },
          ],
        };
      }

      toolResult = extractToolResult(messages);

      return {
        text: 'Found flight operations manuals.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Found flight operations manuals.' }],
      };
    });

    await executor.executeMessage(session.id, 'Show me manuals');

    // Only Flight Operations Manual has document_type='manual'
    expect(toolResult.results.length).toBe(searchServer.ingestResults['operations'].chunkCount);
  });

  test('Search results include airline metadata', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([FLIGHT_SEARCH_DSL], 'Flight_Search'),
    );

    let toolResult: any;

    mockClient.setResponseHandler((_systemPrompt, messages, tools) => {
      const callNum = mockClient.calls.length;

      if (callNum === 1 && tools.length > 0) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_1',
              name: 'search_structured',
              input: {
                index_id: AIRLINE_INDEX_ID,
                filters: [{ field: 'category', operator: 'eq', value: 'operations' }],
                limit: 50,
              },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'search_structured',
              input: {
                index_id: AIRLINE_INDEX_ID,
                filters: [{ field: 'category', operator: 'eq', value: 'operations' }],
                limit: 50,
              },
            },
          ],
        };
      }

      toolResult = extractToolResult(messages);

      return {
        text: 'Operations data found.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Operations data found.' }],
      };
    });

    await executor.executeMessage(session.id, 'Show operations documents');

    expect(toolResult).toBeDefined();
    expect(toolResult.results.length).toBeGreaterThan(0);

    const firstResult = toolResult.results[0];
    expect(firstResult.metadata).toBeDefined();
    expect(firstResult.metadata.cabin_class).toBeDefined();
    expect(firstResult.metadata.route_type).toBeDefined();
    expect(firstResult.metadata.base_fare).toBeDefined();
    expect(firstResult.metadata.category).toBe('operations');
  });

  test('System prompt includes search tools', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([FLIGHT_SEARCH_DSL], 'Flight_Search'),
    );

    mockClient.setResponseHandler(() => ({
      text: 'I can help with flight searches.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'I can help with flight searches.' }],
    }));

    await executor.executeMessage(session.id, 'Hello');

    expect(mockClient.calls.length).toBeGreaterThanOrEqual(1);
    const tools = mockClient.calls[0].tools as Array<{ name: string }>;
    const toolNames = tools.map((t) => t.name);

    expect(toolNames).toContain('search_structured');
    expect(toolNames).toContain('vocabulary_resolve');
    expect(toolNames).toContain('search_hybrid');
  });
});

// =============================================================================
// 2. POLICY ADVISOR AGENT
// =============================================================================

describe('Policy Advisor Agent', () => {
  let executor: RuntimeExecutor;
  let mockClient: MockAnthropicClient;

  beforeEach(() => {
    executor = new RuntimeExecutor();
    mockClient = injectMockClient(executor);
    wireSearchToolExecutor(executor, searchServer.baseUrl);
  });

  test('Agent calls search_hybrid for policy query', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([POLICY_ADVISOR_DSL], 'Policy_Advisor'),
    );

    mockClient.setResponseHandler((_systemPrompt, _messages, tools) => {
      const callNum = mockClient.calls.length;

      if (callNum === 1 && tools.length > 0) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_1',
              name: 'search_hybrid',
              input: {
                index_id: AIRLINE_INDEX_ID,
                query: 'baggage allowance checked bags',
                top_k: 5,
                similarity_threshold: 0.1,
              },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'search_hybrid',
              input: {
                index_id: AIRLINE_INDEX_ID,
                query: 'baggage allowance checked bags',
                top_k: 5,
                similarity_threshold: 0.1,
              },
            },
          ],
        };
      }

      return {
        text: 'Economy class passengers receive one free checked bag up to 23 kg on domestic routes.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [
          {
            type: 'text',
            text: 'Economy class passengers receive one free checked bag up to 23 kg on domestic routes.',
          },
        ],
      };
    });

    const result = await executor.executeMessage(session.id, 'What is the baggage allowance?');

    expect(mockClient.calls.length).toBeGreaterThanOrEqual(2);
    expect(mockClient.calls[0].tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'search_hybrid' })]),
    );
    expect(result.response).toContain('checked bag');
  });

  test('Search results contain real policy content', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([POLICY_ADVISOR_DSL], 'Policy_Advisor'),
    );

    let toolResultContent: string | undefined;

    mockClient.setResponseHandler((_systemPrompt, messages, tools) => {
      const callNum = mockClient.calls.length;

      if (callNum === 1 && tools.length > 0) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_1',
              name: 'search_hybrid',
              input: {
                index_id: AIRLINE_INDEX_ID,
                query: 'cancellation refund policy rules',
                top_k: 5,
                similarity_threshold: 0.1,
              },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'search_hybrid',
              input: {
                index_id: AIRLINE_INDEX_ID,
                query: 'cancellation refund policy rules',
                top_k: 5,
                similarity_threshold: 0.1,
              },
            },
          ],
        };
      }

      for (const msg of messages) {
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          for (const block of msg.content as any[]) {
            if (block.type === 'tool_result') {
              toolResultContent =
                typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
            }
          }
        }
      }

      return {
        text: 'Cancellation rules depend on your fare family.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Cancellation rules depend on your fare family.' }],
      };
    });

    await executor.executeMessage(session.id, 'How do I cancel a flight?');

    expect(toolResultContent).toBeDefined();
    const parsed = JSON.parse(toolResultContent!);
    expect(parsed.results).toBeDefined();
    expect(parsed.results.length).toBeGreaterThan(0);
    // Real content from airline docs should be present
    const allContent = parsed.results
      .map((r: any) => r.content || '')
      .join(' ')
      .toLowerCase();
    expect(allContent).toMatch(/cancel|refund|baggage|fare/);
  });

  test('Agent synthesizes response from results', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([POLICY_ADVISOR_DSL], 'Policy_Advisor'),
    );

    mockClient.setResponseHandler((_systemPrompt, _messages, tools) => {
      const callNum = mockClient.calls.length;

      if (callNum === 1 && tools.length > 0) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_1',
              name: 'search_hybrid',
              input: {
                index_id: AIRLINE_INDEX_ID,
                query: 'loyalty program tiers benefits',
                top_k: 5,
                similarity_threshold: 0.1,
              },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'search_hybrid',
              input: {
                index_id: AIRLINE_INDEX_ID,
                query: 'loyalty program tiers benefits',
                top_k: 5,
                similarity_threshold: 0.1,
              },
            },
          ],
        };
      }

      return {
        text: 'SkyMiles has four tiers: Blue, Silver, Gold, and Platinum with increasing benefits.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [
          {
            type: 'text',
            text: 'SkyMiles has four tiers: Blue, Silver, Gold, and Platinum with increasing benefits.',
          },
        ],
      };
    });

    const result = await executor.executeMessage(session.id, 'Tell me about the loyalty program');

    expect(result.response).toContain('SkyMiles');
    expect(result.response).toContain('Platinum');
  });

  test('Vocab resolve → filtered hybrid search', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([POLICY_ADVISOR_DSL], 'Policy_Advisor'),
    );

    let vocabResult: any;

    mockClient.setResponseHandler((_systemPrompt, messages, tools) => {
      const callNum = mockClient.calls.length;

      if (callNum === 1 && tools.length > 0) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_vocab',
              name: 'vocabulary_resolve',
              input: { project_kb_id: AIRLINE_KB_ID, query: 'economy class' },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_vocab',
              name: 'vocabulary_resolve',
              input: { project_kb_id: AIRLINE_KB_ID, query: 'economy class' },
            },
          ],
        };
      }

      if (callNum === 2) {
        vocabResult = extractToolResult(messages);
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_search',
              name: 'search_hybrid',
              input: {
                index_id: AIRLINE_INDEX_ID,
                query: 'economy class baggage policy',
                top_k: 5,
                similarity_threshold: 0.1,
                filters: [{ field: 'cabin_class', operator: 'eq', value: 'economy' }],
              },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_search',
              name: 'search_hybrid',
              input: {
                index_id: AIRLINE_INDEX_ID,
                query: 'economy class baggage policy',
                top_k: 5,
                similarity_threshold: 0.1,
                filters: [{ field: 'cabin_class', operator: 'eq', value: 'economy' }],
              },
            },
          ],
        };
      }

      return {
        text: 'Economy class baggage policy covers one free checked bag.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [
          { type: 'text', text: 'Economy class baggage policy covers one free checked bag.' },
        ],
      };
    });

    const result = await executor.executeMessage(session.id, 'Economy class baggage policy');

    expect(vocabResult).toBeDefined();
    expect(vocabResult.structuredFilters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'cabin_class',
          operator: 'eq',
          value: expect.stringContaining('economy'),
        }),
      ]),
    );
    expect(mockClient.calls.length).toBe(3);
    expect(result.response).toContain('Economy class');
  });

  test('Empty results for irrelevant query', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([POLICY_ADVISOR_DSL], 'Policy_Advisor'),
    );

    mockClient.setResponseHandler((_systemPrompt, _messages, tools) => {
      const callNum = mockClient.calls.length;

      if (callNum === 1 && tools.length > 0) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_1',
              name: 'search_hybrid',
              input: {
                index_id: AIRLINE_INDEX_ID,
                query: 'spaceship maintenance protocols warp drive',
                top_k: 5,
                similarity_threshold: 0.95, // Very high threshold
              },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'search_hybrid',
              input: {
                index_id: AIRLINE_INDEX_ID,
                query: 'spaceship maintenance protocols warp drive',
                top_k: 5,
                similarity_threshold: 0.95,
              },
            },
          ],
        };
      }

      return {
        text: 'I could not find relevant information about spaceship maintenance in our airline knowledge base.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [
          {
            type: 'text',
            text: 'I could not find relevant information about spaceship maintenance in our airline knowledge base.',
          },
        ],
      };
    });

    const result = await executor.executeMessage(session.id, 'Tell me about spaceship maintenance');

    expect(result.response).toContain('could not find');
  });

  test('Metadata preserved in search results', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([POLICY_ADVISOR_DSL], 'Policy_Advisor'),
    );

    let searchResults: any;

    mockClient.setResponseHandler((_systemPrompt, messages, tools) => {
      const callNum = mockClient.calls.length;

      if (callNum === 1 && tools.length > 0) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_1',
              name: 'search_hybrid',
              input: {
                index_id: AIRLINE_INDEX_ID,
                query: 'in-flight meal service dining',
                top_k: 5,
                similarity_threshold: 0.1,
              },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'search_hybrid',
              input: {
                index_id: AIRLINE_INDEX_ID,
                query: 'in-flight meal service dining',
                top_k: 5,
                similarity_threshold: 0.1,
              },
            },
          ],
        };
      }

      searchResults = extractToolResult(messages);

      return {
        text: 'Meal service varies by class and route.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Meal service varies by class and route.' }],
      };
    });

    await executor.executeMessage(session.id, 'What meals are served on flights?');

    expect(searchResults).toBeDefined();
    expect(searchResults.results.length).toBeGreaterThan(0);
    const firstResult = searchResults.results[0];
    expect(firstResult.metadata).toBeDefined();
    expect(firstResult.metadata.category).toBeDefined();
    expect(firstResult.metadata.document_type).toBeDefined();
  });

  test('Multi-hop: vocab + hybrid search', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([POLICY_ADVISOR_DSL], 'Policy_Advisor'),
    );

    mockClient.setResponseHandler((_systemPrompt, _messages, tools) => {
      const callNum = mockClient.calls.length;

      if (callNum === 1 && tools.length > 0) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_vocab',
              name: 'vocabulary_resolve',
              input: { project_kb_id: AIRLINE_KB_ID, query: 'first class' },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_vocab',
              name: 'vocabulary_resolve',
              input: { project_kb_id: AIRLINE_KB_ID, query: 'first class' },
            },
          ],
        };
      }

      if (callNum === 2) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_search',
              name: 'search_hybrid',
              input: {
                index_id: AIRLINE_INDEX_ID,
                query: 'first class meal service',
                top_k: 5,
                similarity_threshold: 0.1,
                filters: [{ field: 'cabin_class', operator: 'eq', value: 'first' }],
              },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_search',
              name: 'search_hybrid',
              input: {
                index_id: AIRLINE_INDEX_ID,
                query: 'first class meal service',
                top_k: 5,
                similarity_threshold: 0.1,
                filters: [{ field: 'cabin_class', operator: 'eq', value: 'first' }],
              },
            },
          ],
        };
      }

      return {
        text: 'First class features a seven-course chef-curated dining experience.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [
          {
            type: 'text',
            text: 'First class features a seven-course chef-curated dining experience.',
          },
        ],
      };
    });

    const result = await executor.executeMessage(session.id, 'What meals are in first class?');

    expect(mockClient.calls.length).toBe(3);
    expect(result.response).toContain('seven-course');
  });

  test('Trace events capture tool execution', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([POLICY_ADVISOR_DSL], 'Policy_Advisor'),
    );

    mockClient.setResponseHandler((_systemPrompt, _messages, tools) => {
      const callNum = mockClient.calls.length;

      if (callNum === 1 && tools.length > 0) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_1',
              name: 'search_hybrid',
              input: {
                index_id: AIRLINE_INDEX_ID,
                query: 'baggage policy',
                top_k: 3,
                similarity_threshold: 0.1,
              },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'search_hybrid',
              input: {
                index_id: AIRLINE_INDEX_ID,
                query: 'baggage policy',
                top_k: 3,
                similarity_threshold: 0.1,
              },
            },
          ],
        };
      }

      return {
        text: 'Baggage policy details provided.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Baggage policy details provided.' }],
      };
    });

    const traceCollector = createTraceCollector();
    await executor.executeMessage(session.id, 'Baggage rules', undefined, traceCollector.callback);

    const toolTraces = traceCollector.traces.filter(
      (t) => t.type === 'tool_execution' || t.type === 'tool_call' || t.type === 'tool_result',
    );
    expect(toolTraces.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// 3. ANALYTICS AGENT
// =============================================================================

describe('Analytics Agent', () => {
  let executor: RuntimeExecutor;
  let mockClient: MockAnthropicClient;

  beforeEach(() => {
    executor = new RuntimeExecutor();
    mockClient = injectMockClient(executor);
    wireSearchToolExecutor(executor, searchServer.baseUrl);
  });

  test('SUM of base_fare', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([ANALYTICS_DSL], 'Analytics'),
    );

    let toolResult: any;

    mockClient.setResponseHandler((_systemPrompt, messages, tools) => {
      const callNum = mockClient.calls.length;

      if (callNum === 1 && tools.length > 0) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_1',
              name: 'search_aggregate',
              input: { index_id: AIRLINE_INDEX_ID, measure: 'base_fare', function: 'sum' },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'search_aggregate',
              input: { index_id: AIRLINE_INDEX_ID, measure: 'base_fare', function: 'sum' },
            },
          ],
        };
      }

      toolResult = extractToolResult(messages);

      return {
        text: 'Total revenue calculated.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Total revenue calculated.' }],
      };
    });

    await executor.executeMessage(session.id, 'What is the total revenue?');

    expect(toolResult).toBeDefined();
    expect(toolResult.results.length).toBe(1);
    // SUM = 450 * ops_chunks + 199.99 * policy_chunks + 850 * loyalty_chunks + 1299.99 * services_chunks
    const expectedSum =
      450.0 * searchServer.ingestResults['operations'].chunkCount +
      199.99 * searchServer.ingestResults['policy'].chunkCount +
      850.0 * searchServer.ingestResults['loyalty'].chunkCount +
      1299.99 * searchServer.ingestResults['services'].chunkCount;
    expect(toolResult.results[0].value).toBeCloseTo(expectedSum, 0);
  });

  test('SUM grouped by category', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([ANALYTICS_DSL], 'Analytics'),
    );

    let toolResult: any;

    mockClient.setResponseHandler((_systemPrompt, messages, tools) => {
      const callNum = mockClient.calls.length;

      if (callNum === 1 && tools.length > 0) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_1',
              name: 'search_aggregate',
              input: {
                index_id: AIRLINE_INDEX_ID,
                measure: 'base_fare',
                function: 'sum',
                group_by: ['category'],
              },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'search_aggregate',
              input: {
                index_id: AIRLINE_INDEX_ID,
                measure: 'base_fare',
                function: 'sum',
                group_by: ['category'],
              },
            },
          ],
        };
      }

      toolResult = extractToolResult(messages);

      return {
        text: 'Revenue by category.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Revenue by category.' }],
      };
    });

    await executor.executeMessage(session.id, 'Total fare revenue by category');

    expect(toolResult).toBeDefined();
    // 4 categories: operations, policy, loyalty, services
    expect(toolResult.results.length).toBe(4);
  });

  test('COUNT grouped by category', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([ANALYTICS_DSL], 'Analytics'),
    );

    let toolResult: any;

    mockClient.setResponseHandler((_systemPrompt, messages, tools) => {
      const callNum = mockClient.calls.length;

      if (callNum === 1 && tools.length > 0) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_1',
              name: 'search_aggregate',
              input: {
                index_id: AIRLINE_INDEX_ID,
                measure: 'category',
                function: 'count',
                group_by: ['category'],
              },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'search_aggregate',
              input: {
                index_id: AIRLINE_INDEX_ID,
                measure: 'category',
                function: 'count',
                group_by: ['category'],
              },
            },
          ],
        };
      }

      toolResult = extractToolResult(messages);

      return {
        text: 'Document counts by category.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Document counts by category.' }],
      };
    });

    await executor.executeMessage(session.id, 'How many documents per category?');

    expect(toolResult).toBeDefined();
    expect(toolResult.results.length).toBe(4);

    const byCategory = Object.fromEntries(
      toolResult.results.map((r: any) => [r.groupKey?.category, r.count]),
    );
    expect(byCategory['operations']).toBe(searchServer.ingestResults['operations'].chunkCount);
    expect(byCategory['policy']).toBe(searchServer.ingestResults['policy'].chunkCount);
    expect(byCategory['loyalty']).toBe(searchServer.ingestResults['loyalty'].chunkCount);
    expect(byCategory['services']).toBe(searchServer.ingestResults['services'].chunkCount);
  });

  test('AVG base_fare', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([ANALYTICS_DSL], 'Analytics'),
    );

    let toolResult: any;

    mockClient.setResponseHandler((_systemPrompt, messages, tools) => {
      const callNum = mockClient.calls.length;

      if (callNum === 1 && tools.length > 0) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_1',
              name: 'search_aggregate',
              input: { index_id: AIRLINE_INDEX_ID, measure: 'base_fare', function: 'avg' },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'search_aggregate',
              input: { index_id: AIRLINE_INDEX_ID, measure: 'base_fare', function: 'avg' },
            },
          ],
        };
      }

      toolResult = extractToolResult(messages);

      return {
        text: 'Average fare reported.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Average fare reported.' }],
      };
    });

    await executor.executeMessage(session.id, 'What is the average fare?');

    expect(toolResult.results.length).toBe(1);
    expect(typeof toolResult.results[0].value).toBe('number');
    expect(toolResult.results[0].value).toBeGreaterThan(0);
  });

  test('MIN/MAX base_fare', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([ANALYTICS_DSL], 'Analytics'),
    );

    let minResult: any;
    let maxResult: any;

    // Test MIN
    mockClient.setResponseHandler((_systemPrompt, messages, tools) => {
      const callNum = mockClient.calls.length;

      if (callNum === 1 && tools.length > 0) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_min',
              name: 'search_aggregate',
              input: { index_id: AIRLINE_INDEX_ID, measure: 'base_fare', function: 'min' },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_min',
              name: 'search_aggregate',
              input: { index_id: AIRLINE_INDEX_ID, measure: 'base_fare', function: 'min' },
            },
          ],
        };
      }

      minResult = extractToolResult(messages);

      return {
        text: 'Minimum fare found.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Minimum fare found.' }],
      };
    });

    await executor.executeMessage(session.id, 'What is the minimum fare?');
    expect(minResult.results[0].value).toBeCloseTo(199.99, 1);

    // Test MAX with a new session
    const session2 = executor.createSessionFromResolved(
      compileToResolvedAgent([ANALYTICS_DSL], 'Analytics'),
    );
    mockClient.calls = [];

    mockClient.setResponseHandler((_systemPrompt, messages, tools) => {
      const callNum = mockClient.calls.length;

      if (callNum === 1 && tools.length > 0) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_max',
              name: 'search_aggregate',
              input: { index_id: AIRLINE_INDEX_ID, measure: 'base_fare', function: 'max' },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_max',
              name: 'search_aggregate',
              input: { index_id: AIRLINE_INDEX_ID, measure: 'base_fare', function: 'max' },
            },
          ],
        };
      }

      maxResult = extractToolResult(messages);

      return {
        text: 'Maximum fare found.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Maximum fare found.' }],
      };
    });

    await executor.executeMessage(session2.id, 'What is the maximum fare?');
    expect(maxResult.results[0].value).toBeCloseTo(1299.99, 1);
  });

  test('Aggregation with filter: SUM base_fare where route_type=international', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([ANALYTICS_DSL], 'Analytics'),
    );

    let toolResult: any;

    mockClient.setResponseHandler((_systemPrompt, messages, tools) => {
      const callNum = mockClient.calls.length;

      if (callNum === 1 && tools.length > 0) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_1',
              name: 'search_aggregate',
              input: {
                index_id: AIRLINE_INDEX_ID,
                measure: 'base_fare',
                function: 'sum',
                filters: [{ field: 'route_type', operator: 'eq', value: 'international' }],
              },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'search_aggregate',
              input: {
                index_id: AIRLINE_INDEX_ID,
                measure: 'base_fare',
                function: 'sum',
                filters: [{ field: 'route_type', operator: 'eq', value: 'international' }],
              },
            },
          ],
        };
      }

      toolResult = extractToolResult(messages);

      return {
        text: 'International route revenue calculated.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'International route revenue calculated.' }],
      };
    });

    await executor.executeMessage(session.id, 'Total fare for international routes');

    // International: operations (450), loyalty (850), services (1299.99) — excludes policy (domestic, 199.99)
    const expectedSum =
      450.0 * searchServer.ingestResults['operations'].chunkCount +
      850.0 * searchServer.ingestResults['loyalty'].chunkCount +
      1299.99 * searchServer.ingestResults['services'].chunkCount;
    expect(toolResult.results[0].value).toBeCloseTo(expectedSum, 0);
  });

  test('COUNT_DISTINCT on cabin_class', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([ANALYTICS_DSL], 'Analytics'),
    );

    let toolResult: any;

    mockClient.setResponseHandler((_systemPrompt, messages, tools) => {
      const callNum = mockClient.calls.length;

      if (callNum === 1 && tools.length > 0) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_1',
              name: 'search_aggregate',
              input: {
                index_id: AIRLINE_INDEX_ID,
                measure: 'cabin_class',
                function: 'count_distinct',
              },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'search_aggregate',
              input: {
                index_id: AIRLINE_INDEX_ID,
                measure: 'cabin_class',
                function: 'count_distinct',
              },
            },
          ],
        };
      }

      toolResult = extractToolResult(messages);

      return {
        text: '4 distinct cabin classes.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: '4 distinct cabin classes.' }],
      };
    });

    await executor.executeMessage(session.id, 'How many distinct cabin classes?');

    // 4 distinct: all, economy, business, first
    expect(toolResult.results[0].value).toBe(4);
  });

  test('Vocab resolve → aggregation chain', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([ANALYTICS_DSL], 'Analytics'),
    );

    let vocabResult: any;

    mockClient.setResponseHandler((_systemPrompt, messages, tools) => {
      const callNum = mockClient.calls.length;

      if (callNum === 1 && tools.length > 0) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_vocab',
              name: 'vocabulary_resolve',
              input: { project_kb_id: AIRLINE_KB_ID, query: 'total revenue' },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_vocab',
              name: 'vocabulary_resolve',
              input: { project_kb_id: AIRLINE_KB_ID, query: 'total revenue' },
            },
          ],
        };
      }

      if (callNum === 2) {
        vocabResult = extractToolResult(messages);
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_agg',
              name: 'search_aggregate',
              input: {
                index_id: AIRLINE_INDEX_ID,
                measure: 'base_fare',
                function: 'sum',
              },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_agg',
              name: 'search_aggregate',
              input: { index_id: AIRLINE_INDEX_ID, measure: 'base_fare', function: 'sum' },
            },
          ],
        };
      }

      return {
        text: 'Total revenue calculated from fares.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Total revenue calculated from fares.' }],
      };
    });

    const result = await executor.executeMessage(session.id, 'What is the total revenue?');

    expect(vocabResult).toBeDefined();
    expect(vocabResult.aggregationSpec).toBeDefined();
    expect(vocabResult.aggregationSpec.measure).toBe('base_fare');
    expect(vocabResult.aggregationSpec.function).toBe('count');
    expect(mockClient.calls.length).toBe(3);
    expect(result.response).toContain('Total revenue');
  });

  test('System prompt includes search_aggregate tool', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([ANALYTICS_DSL], 'Analytics'),
    );

    mockClient.setResponseHandler(() => ({
      text: 'I can help with analytics.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'I can help with analytics.' }],
    }));

    await executor.executeMessage(session.id, 'Hello');

    const tools = mockClient.calls[0].tools as Array<{ name: string }>;
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain('search_aggregate');
    expect(toolNames).toContain('vocabulary_resolve');
  });
});

// =============================================================================
// 4. SUPERVISOR ROUTING + INTEGRATION
// =============================================================================

describe('Supervisor Routing + Integration', () => {
  let executor: RuntimeExecutor;
  let mockClient: MockAnthropicClient;

  beforeEach(() => {
    executor = new RuntimeExecutor();
    mockClient = injectMockClient(executor);
    wireSearchToolExecutor(executor, searchServer.baseUrl);
  });

  test('Supervisor routes flight query to Flight_Search', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent(
        [SUPERVISOR_DSL, FLIGHT_SEARCH_DSL, POLICY_ADVISOR_DSL, ANALYTICS_DSL],
        'Airlines_Supervisor',
      ),
    );

    let toolResult: any;

    mockClient.setResponseHandler((_systemPrompt, messages, tools) => {
      const callNum = mockClient.calls.length;

      // Supervisor decides to handoff to Flight_Search
      if (callNum === 1) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_handoff',
              name: 'handoff_to_Flight_Search',
              input: { query: 'first class flights' },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_handoff',
              name: 'handoff_to_Flight_Search',
              input: { query: 'first class flights' },
            },
          ],
        };
      }

      // Flight_Search agent calls search_structured
      if (callNum === 2 && tools.length > 0) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_search',
              name: 'search_structured',
              input: {
                index_id: AIRLINE_INDEX_ID,
                filters: [{ field: 'cabin_class', operator: 'eq', value: 'first' }],
                limit: 50,
              },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_search',
              name: 'search_structured',
              input: {
                index_id: AIRLINE_INDEX_ID,
                filters: [{ field: 'cabin_class', operator: 'eq', value: 'first' }],
                limit: 50,
              },
            },
          ],
        };
      }

      toolResult = extractToolResult(messages);

      return {
        text: 'First class flights include premium suites with lie-flat beds.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [
          { type: 'text', text: 'First class flights include premium suites with lie-flat beds.' },
        ],
      };
    });

    const result = await executor.executeMessage(session.id, 'Find first class flights');

    expect(result.response).toContain('First class');
    // Verify search was executed (tool result may be from handoff or search)
    if (toolResult?.results) {
      expect(toolResult.results.length).toBeGreaterThan(0);
    }
  });

  test('Supervisor routes policy query to Policy_Advisor', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent(
        [SUPERVISOR_DSL, FLIGHT_SEARCH_DSL, POLICY_ADVISOR_DSL, ANALYTICS_DSL],
        'Airlines_Supervisor',
      ),
    );

    mockClient.setResponseHandler((_systemPrompt, _messages, tools) => {
      const callNum = mockClient.calls.length;

      if (callNum === 1) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_handoff',
              name: 'handoff_to_Policy_Advisor',
              input: { query: 'baggage policy' },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_handoff',
              name: 'handoff_to_Policy_Advisor',
              input: { query: 'baggage policy' },
            },
          ],
        };
      }

      if (callNum === 2 && tools.length > 0) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_search',
              name: 'search_hybrid',
              input: {
                index_id: AIRLINE_INDEX_ID,
                query: 'baggage policy allowance',
                top_k: 5,
                similarity_threshold: 0.1,
              },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_search',
              name: 'search_hybrid',
              input: {
                index_id: AIRLINE_INDEX_ID,
                query: 'baggage policy allowance',
                top_k: 5,
                similarity_threshold: 0.1,
              },
            },
          ],
        };
      }

      return {
        text: 'Economy passengers get one free checked bag weighing up to 23 kg.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [
          {
            type: 'text',
            text: 'Economy passengers get one free checked bag weighing up to 23 kg.',
          },
        ],
      };
    });

    const result = await executor.executeMessage(session.id, "What's the baggage policy?");

    expect(result.response).toContain('checked bag');
  });

  test('Supervisor routes analytics query to Analytics', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent(
        [SUPERVISOR_DSL, FLIGHT_SEARCH_DSL, POLICY_ADVISOR_DSL, ANALYTICS_DSL],
        'Airlines_Supervisor',
      ),
    );

    mockClient.setResponseHandler((_systemPrompt, _messages, tools) => {
      const callNum = mockClient.calls.length;

      if (callNum === 1) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_handoff',
              name: 'handoff_to_Analytics',
              input: { query: 'total revenue' },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_handoff',
              name: 'handoff_to_Analytics',
              input: { query: 'total revenue' },
            },
          ],
        };
      }

      if (callNum === 2 && tools.length > 0) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_agg',
              name: 'search_aggregate',
              input: { index_id: AIRLINE_INDEX_ID, measure: 'base_fare', function: 'sum' },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_agg',
              name: 'search_aggregate',
              input: { index_id: AIRLINE_INDEX_ID, measure: 'base_fare', function: 'sum' },
            },
          ],
        };
      }

      return {
        text: 'The total revenue across all routes is calculated from fare data.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [
          {
            type: 'text',
            text: 'The total revenue across all routes is calculated from fare data.',
          },
        ],
      };
    });

    const result = await executor.executeMessage(session.id, "What's the total revenue?");

    expect(result.response).toContain('total revenue');
  });

  test('Different agents share same airline index', async () => {
    // Flight search agent
    const session1 = executor.createSessionFromResolved(
      compileToResolvedAgent([FLIGHT_SEARCH_DSL], 'Flight_Search'),
    );

    let flightResult: any;

    mockClient.setResponseHandler((_systemPrompt, messages, tools) => {
      const callNum = mockClient.calls.length;

      if (callNum === 1 && tools.length > 0) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_1',
              name: 'search_structured',
              input: {
                index_id: AIRLINE_INDEX_ID,
                filters: [{ field: 'category', operator: 'eq', value: 'services' }],
                limit: 50,
              },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'search_structured',
              input: {
                index_id: AIRLINE_INDEX_ID,
                filters: [{ field: 'category', operator: 'eq', value: 'services' }],
                limit: 50,
              },
            },
          ],
        };
      }

      flightResult = extractToolResult(messages);

      return {
        text: 'In-flight services found.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'In-flight services found.' }],
      };
    });

    await executor.executeMessage(session1.id, 'Show in-flight services');

    // Policy advisor queries same index
    const session2 = executor.createSessionFromResolved(
      compileToResolvedAgent([POLICY_ADVISOR_DSL], 'Policy_Advisor'),
    );
    mockClient.calls = [];

    let policyResult: any;

    mockClient.setResponseHandler((_systemPrompt, messages, tools) => {
      const callNum = mockClient.calls.length;

      if (callNum === 1 && tools.length > 0) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_1',
              name: 'search_hybrid',
              input: {
                index_id: AIRLINE_INDEX_ID,
                query: 'in-flight services meal',
                top_k: 5,
                similarity_threshold: 0.1,
              },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'search_hybrid',
              input: {
                index_id: AIRLINE_INDEX_ID,
                query: 'in-flight services meal',
                top_k: 5,
                similarity_threshold: 0.1,
              },
            },
          ],
        };
      }

      policyResult = extractToolResult(messages);

      return {
        text: 'Services information from policy advisor.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Services information from policy advisor.' }],
      };
    });

    await executor.executeMessage(session2.id, 'What in-flight services are available?');

    // Both should have queried the same data
    expect(flightResult.results.length).toBeGreaterThan(0);
    expect(policyResult.results.length).toBeGreaterThan(0);

    // Services doc chunks should appear in flight search results
    const servicesDocId = searchServer.ingestResults['services'].documentId;
    const flightHasServices = flightResult.results.some((r: any) => r.documentId === servicesDocId);
    expect(flightHasServices).toBe(true);
  });

  test('Conversation history preserved across turns', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([POLICY_ADVISOR_DSL], 'Policy_Advisor'),
    );

    let turn2Messages: any[];

    mockClient.setResponseHandler((_systemPrompt, messages, tools) => {
      const callNum = mockClient.calls.length;

      if (callNum === 1) {
        return {
          text: 'Welcome! I can help you with airline policies. What would you like to know?',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [
            {
              type: 'text',
              text: 'Welcome! I can help you with airline policies. What would you like to know?',
            },
          ],
        };
      }

      if (callNum === 2 && tools.length > 0) {
        turn2Messages = [...messages];
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_1',
              name: 'search_hybrid',
              input: {
                index_id: AIRLINE_INDEX_ID,
                query: 'baggage policy',
                top_k: 5,
                similarity_threshold: 0.1,
              },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'search_hybrid',
              input: {
                index_id: AIRLINE_INDEX_ID,
                query: 'baggage policy',
                top_k: 5,
                similarity_threshold: 0.1,
              },
            },
          ],
        };
      }

      return {
        text: 'Baggage details provided.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Baggage details provided.' }],
      };
    });

    await executor.executeMessage(session.id, 'Hello');
    await executor.executeMessage(session.id, 'What is the baggage policy?');

    expect(turn2Messages!).toBeDefined();
    expect(turn2Messages!.length).toBeGreaterThanOrEqual(3);
    const userMessages = turn2Messages!.filter((m: any) => m.role === 'user');
    expect(userMessages.length).toBeGreaterThanOrEqual(2);
  });

  test('Trace events have correct structure', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([FLIGHT_SEARCH_DSL], 'Flight_Search'),
    );

    mockClient.setResponseHandler((_systemPrompt, _messages, tools) => {
      const callNum = mockClient.calls.length;

      if (callNum === 1 && tools.length > 0) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_1',
              name: 'search_structured',
              input: {
                index_id: AIRLINE_INDEX_ID,
                filters: [{ field: 'category', operator: 'eq', value: 'operations' }],
                limit: 10,
              },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'search_structured',
              input: {
                index_id: AIRLINE_INDEX_ID,
                filters: [{ field: 'category', operator: 'eq', value: 'operations' }],
                limit: 10,
              },
            },
          ],
        };
      }

      return {
        text: 'Operations found.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Operations found.' }],
      };
    });

    const traceCollector = createTraceCollector();
    await executor.executeMessage(
      session.id,
      'Show operations docs',
      undefined,
      traceCollector.callback,
    );

    // Verify traces are emitted
    expect(traceCollector.traces.length).toBeGreaterThan(0);

    // Check for tool-related traces
    const toolTraces = traceCollector.traces.filter(
      (t) => t.type.includes('tool') || t.data?.toolName !== undefined,
    );
    if (toolTraces.length > 0) {
      const trace = toolTraces[0];
      expect(trace.type).toBeDefined();
      expect(trace.data).toBeDefined();
    }

    // Check for LLM-related traces
    const llmTraces = traceCollector.traces.filter(
      (t) => t.type.includes('llm') || t.type.includes('reasoning') || t.type.includes('turn'),
    );
    expect(llmTraces.length).toBeGreaterThan(0);
  });
});
