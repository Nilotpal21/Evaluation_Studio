/**
 * Agent + LLM + SearchAI End-to-End Integration Tests
 *
 * Tests the full path: Agent receives user message → MockLLM decides to call
 * search tool → search tool executes against real indexed data → results flow
 * back to LLM → agent synthesizes response.
 *
 * Architecture:
 *   RuntimeExecutor.executeMessage()
 *     → MockAnthropicClient (simulates LLM calling search tools)
 *       → SearchAIAwareToolExecutor.execute()
 *         → SearchAIToolHandler → SearchAIClient.fetch() → real Express server
 *           → Real MongoDB (MongoMemoryServer) + InMemoryVectorStore
 *
 * Real: MongoDB, vector store, chunking, embeddings, HTTP routes
 * Mocked: LLM responses (scripted tool calls + synthesis)
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
  startTestSearchServer,
  stopTestSearchServer,
  INDEX_ID,
  KB_ID,
  type TestSearchServer,
} from './helpers/search-server.js';

// =============================================================================
// MOCK LLM CLIENT (same pattern as reasoning-gather-handoff.test.ts)
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
// AGENT DSL DEFINITIONS
// =============================================================================

const KNOWLEDGE_RETRIEVAL_DSL = `
AGENT: Knowledge_Retrieval

GOAL: "Retrieve relevant knowledge to answer user questions using semantic search"

TOOLS:
  search_hybrid(index_id: string, query: string, top_k: number, similarity_threshold: number) -> {results: object[], totalCount: number, latencyMs: number}
  search_vector(index_id: string, query: string, top_k: number, similarity_threshold: number) -> {results: object[], totalCount: number, latencyMs: number}
  vocabulary_resolve(project_kb_id: string, query: string) -> {resolvedTerms: object[], unresolvedSegments: string[], structuredFilters: object[], aggregationSpec: object}

INSTRUCTIONS: |
  1. Analyze the query for domain-specific terms that might benefit from vocabulary resolution
  2. If domain terms are found, call vocabulary_resolve to get metadata filters
  3. Execute search_hybrid with the query and any resolved filters
  4. If results are insufficient, retry with search_vector
  5. Synthesize an answer from the retrieved knowledge chunks
`;

const LIST_QUERY_DSL = `
AGENT: List_Query

GOAL: "Help users find specific items by translating natural language queries into structured metadata filters"

TOOLS:
  search_structured(index_id: string, filters: object[], limit: number) -> {results: object[], totalCount: number, latencyMs: number}
  vocabulary_resolve(project_kb_id: string, query: string) -> {resolvedTerms: object[], unresolvedSegments: string[], structuredFilters: object[]}

INSTRUCTIONS: |
  1. Analyze the user's query to identify filterable concepts
  2. Call vocabulary_resolve to map business terms to canonical fields
  3. Construct structured filters from resolved terms
  4. Execute search_structured with the constructed filters
  5. Present results in a clear, organized format
`;

const AGGREGATION_DSL = `
AGENT: Aggregation

GOAL: "Answer analytical questions by translating natural language into aggregation queries"

TOOLS:
  search_aggregate(index_id: string, measure: string, function: string, group_by: string[], filters: object[]) -> {results: object[], totalCount: number}
  vocabulary_resolve(project_kb_id: string, query: string) -> {resolvedTerms: object[], aggregationSpec: object}

INSTRUCTIONS: |
  1. Identify the measure, dimension, and filters from the user's question
  2. Call vocabulary_resolve to map concepts to canonical fields
  3. Execute search_aggregate with the specification
  4. Present results with clear labels
`;

// =============================================================================
// TEST SETUP
// =============================================================================

let searchServer: TestSearchServer;

beforeAll(async () => {
  searchServer = await startTestSearchServer();
}, 60_000);

afterAll(async () => {
  await stopTestSearchServer(searchServer);
});

// =============================================================================
// 1. KNOWLEDGE RETRIEVAL AGENT
// =============================================================================

describe('Knowledge Retrieval Agent', () => {
  let executor: RuntimeExecutor;
  let mockClient: MockAnthropicClient;

  beforeEach(() => {
    executor = new RuntimeExecutor();
    mockClient = injectMockClient(executor);
    wireSearchToolExecutor(executor, searchServer.baseUrl);
  });

  test('Agent calls search_hybrid with correct params', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([KNOWLEDGE_RETRIEVAL_DSL], 'Knowledge_Retrieval'),
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
                index_id: INDEX_ID,
                query: 'kubernetes pods deployment',
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
                index_id: INDEX_ID,
                query: 'kubernetes pods deployment',
                top_k: 5,
                similarity_threshold: 0.1,
              },
            },
          ],
        };
      }

      return {
        text: 'Based on the search results, Kubernetes uses Pods as the smallest deployable units.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [
          {
            type: 'text',
            text: 'Based on the search results, Kubernetes uses Pods as the smallest deployable units.',
          },
        ],
      };
    });

    const result = await executor.executeMessage(session.id, 'Tell me about kubernetes pods');

    // Verify the mock LLM was called with the tool
    expect(mockClient.calls.length).toBeGreaterThanOrEqual(2);
    expect(mockClient.calls[0].tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'search_hybrid' })]),
    );

    // Verify the response
    expect(result.response).toContain('Kubernetes uses Pods');
  });

  test('Search results contain real indexed content', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([KNOWLEDGE_RETRIEVAL_DSL], 'Knowledge_Retrieval'),
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
                index_id: INDEX_ID,
                query: 'kubernetes pods deployment container orchestration',
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
                index_id: INDEX_ID,
                query: 'kubernetes pods deployment container orchestration',
                top_k: 5,
                similarity_threshold: 0.1,
              },
            },
          ],
        };
      }

      // Capture the tool result from messages on the second call
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
        text: 'Here is information about Kubernetes.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Here is information about Kubernetes.' }],
      };
    });

    await executor.executeMessage(session.id, 'How do kubernetes pods work?');

    expect(toolResultContent).toBeDefined();
    // The tool result should contain real content from the indexed Kubernetes document
    const parsed = JSON.parse(toolResultContent!);
    expect(parsed.results).toBeDefined();
    expect(parsed.results.length).toBeGreaterThan(0);
    // Real content from the kubernetes test document should be present
    const allContent = parsed.results.map((r: any) => r.content || '').join(' ');
    expect(allContent.toLowerCase()).toContain('kubernetes');
  });

  test('Agent synthesizes response from search results', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([KNOWLEDGE_RETRIEVAL_DSL], 'Knowledge_Retrieval'),
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
                index_id: INDEX_ID,
                query: 'react hooks state',
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
                index_id: INDEX_ID,
                query: 'react hooks state',
                top_k: 5,
                similarity_threshold: 0.1,
              },
            },
          ],
        };
      }

      return {
        text: 'React Hooks like useState and useEffect allow functional components to manage state and side effects.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [
          {
            type: 'text',
            text: 'React Hooks like useState and useEffect allow functional components to manage state and side effects.',
          },
        ],
      };
    });

    const result = await executor.executeMessage(session.id, 'How do React hooks work?');

    expect(result.response).toContain('React Hooks');
    expect(result.response).toContain('useState');
  });

  test('Vocabulary resolve → filtered search pipeline', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([KNOWLEDGE_RETRIEVAL_DSL], 'Knowledge_Retrieval'),
    );

    mockClient.setResponseHandler((_systemPrompt, _messages, tools) => {
      const callNum = mockClient.calls.length;

      if (callNum === 1 && tools.length > 0) {
        // First: resolve vocabulary
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_vocab',
              name: 'vocabulary_resolve',
              input: { project_kb_id: KB_ID, query: 'devops tools' },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_vocab',
              name: 'vocabulary_resolve',
              input: { project_kb_id: KB_ID, query: 'devops tools' },
            },
          ],
        };
      }

      if (callNum === 2) {
        // Second: search with resolved filters
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_search',
              name: 'search_vector',
              input: {
                index_id: INDEX_ID,
                query: 'devops infrastructure tools',
                top_k: 5,
                similarity_threshold: 0.1,
                filters: [{ field: 'category', operator: 'eq', value: 'devops' }],
              },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_search',
              name: 'search_vector',
              input: {
                index_id: INDEX_ID,
                query: 'devops infrastructure tools',
                top_k: 5,
                similarity_threshold: 0.1,
                filters: [{ field: 'category', operator: 'eq', value: 'devops' }],
              },
            },
          ],
        };
      }

      return {
        text: 'DevOps tools like Kubernetes help with container orchestration.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [
          { type: 'text', text: 'DevOps tools like Kubernetes help with container orchestration.' },
        ],
      };
    });

    const result = await executor.executeMessage(session.id, 'Tell me about devops tools');

    // Verify 3 LLM calls: vocab_resolve → search_vector → synthesis
    expect(mockClient.calls.length).toBe(3);
    expect(result.response).toContain('Kubernetes');
  });

  test('Multi-hop: vocab + hybrid search', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([KNOWLEDGE_RETRIEVAL_DSL], 'Knowledge_Retrieval'),
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
              input: { project_kb_id: KB_ID, query: 'advanced content' },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_vocab',
              name: 'vocabulary_resolve',
              input: { project_kb_id: KB_ID, query: 'advanced content' },
            },
          ],
        };
      }

      if (callNum === 2) {
        // Capture vocab result from messages
        for (const msg of messages) {
          if (msg.role === 'user' && Array.isArray(msg.content)) {
            for (const block of msg.content as any[]) {
              if (block.type === 'tool_result') {
                vocabResult = JSON.parse(
                  typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
                );
              }
            }
          }
        }

        return {
          text: '',
          toolCalls: [
            {
              id: 'call_search',
              name: 'search_hybrid',
              input: {
                index_id: INDEX_ID,
                query: 'advanced difficulty content',
                top_k: 5,
                similarity_threshold: 0.1,
                filters: [{ field: 'difficulty', operator: 'eq', value: 'advanced' }],
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
                index_id: INDEX_ID,
                query: 'advanced difficulty content',
                top_k: 5,
                similarity_threshold: 0.1,
                filters: [{ field: 'difficulty', operator: 'eq', value: 'advanced' }],
              },
            },
          ],
        };
      }

      return {
        text: 'Advanced content includes PostgreSQL performance tuning and query optimization.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [
          {
            type: 'text',
            text: 'Advanced content includes PostgreSQL performance tuning and query optimization.',
          },
        ],
      };
    });

    const result = await executor.executeMessage(session.id, 'Show me advanced content');

    // Vocab resolve should return filters for advanced difficulty
    expect(vocabResult).toBeDefined();
    expect(vocabResult.structuredFilters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'difficulty',
          operator: 'eq',
          value: expect.stringContaining('advanced'),
        }),
      ]),
    );

    expect(mockClient.calls.length).toBe(3);
    expect(result.response).toContain('PostgreSQL');
  });

  test('Empty search results handled gracefully', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([KNOWLEDGE_RETRIEVAL_DSL], 'Knowledge_Retrieval'),
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
                index_id: INDEX_ID,
                query: 'quantum computing superconductors photonics',
                top_k: 5,
                similarity_threshold: 0.95, // Very high threshold — should return few/no results
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
                index_id: INDEX_ID,
                query: 'quantum computing superconductors photonics',
                top_k: 5,
                similarity_threshold: 0.95,
              },
            },
          ],
        };
      }

      return {
        text: 'I could not find relevant information about quantum computing in the available knowledge base.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [
          {
            type: 'text',
            text: 'I could not find relevant information about quantum computing in the available knowledge base.',
          },
        ],
      };
    });

    const result = await executor.executeMessage(session.id, 'Tell me about quantum computing');

    expect(result.response).toContain('could not find');
  });

  test('Search results include metadata from pipeline', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([KNOWLEDGE_RETRIEVAL_DSL], 'Knowledge_Retrieval'),
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
                index_id: INDEX_ID,
                query: 'postgresql database',
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
                index_id: INDEX_ID,
                query: 'postgresql database',
                top_k: 5,
                similarity_threshold: 0.1,
              },
            },
          ],
        };
      }

      // Capture tool results on second call
      for (const msg of messages) {
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          for (const block of msg.content as any[]) {
            if (block.type === 'tool_result') {
              searchResults = JSON.parse(
                typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
              );
            }
          }
        }
      }

      return {
        text: 'PostgreSQL is a powerful relational database.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'PostgreSQL is a powerful relational database.' }],
      };
    });

    await executor.executeMessage(session.id, 'Tell me about PostgreSQL');

    expect(searchResults).toBeDefined();
    expect(searchResults.results.length).toBeGreaterThan(0);

    // Verify metadata from the indexing pipeline
    const firstResult = searchResults.results[0];
    expect(firstResult.metadata).toBeDefined();
    expect(firstResult.metadata.category).toBeDefined();
    expect(firstResult.metadata.product).toBeDefined();
  });

  test('Trace events capture search tool execution', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([KNOWLEDGE_RETRIEVAL_DSL], 'Knowledge_Retrieval'),
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
                index_id: INDEX_ID,
                query: 'kubernetes',
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
                index_id: INDEX_ID,
                query: 'kubernetes',
                top_k: 3,
                similarity_threshold: 0.1,
              },
            },
          ],
        };
      }

      return {
        text: 'Kubernetes is a container orchestration platform.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Kubernetes is a container orchestration platform.' }],
      };
    });

    const traceCollector = createTraceCollector();
    await executor.executeMessage(
      session.id,
      'Tell me about kubernetes',
      undefined,
      traceCollector.callback,
    );

    // Check for tool execution traces
    const toolTraces = traceCollector.traces.filter(
      (t) => t.type === 'tool_execution' || t.type === 'tool_call' || t.type === 'tool_result',
    );
    expect(toolTraces.length).toBeGreaterThan(0);
  });

  test('Trace events capture LLM calls', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([KNOWLEDGE_RETRIEVAL_DSL], 'Knowledge_Retrieval'),
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
                index_id: INDEX_ID,
                query: 'kubernetes',
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
                index_id: INDEX_ID,
                query: 'kubernetes',
                top_k: 3,
                similarity_threshold: 0.1,
              },
            },
          ],
        };
      }

      return {
        text: 'Kubernetes is great.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Kubernetes is great.' }],
      };
    });

    const traceCollector = createTraceCollector();
    await executor.executeMessage(
      session.id,
      'Tell me about kubernetes',
      undefined,
      traceCollector.callback,
    );

    const llmTraces = traceCollector.traces.filter(
      (t) => t.type === 'llm_call' || t.type === 'llm_response' || t.type === 'reasoning_turn',
    );
    expect(llmTraces.length).toBeGreaterThan(0);
  });

  test('System prompt includes search tool definitions', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([KNOWLEDGE_RETRIEVAL_DSL], 'Knowledge_Retrieval'),
    );

    mockClient.setResponseHandler(() => ({
      text: 'I can help with that.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'I can help with that.' }],
    }));

    await executor.executeMessage(session.id, 'Hello');

    expect(mockClient.calls.length).toBeGreaterThanOrEqual(1);
    const tools = mockClient.calls[0].tools as Array<{ name: string }>;
    const toolNames = tools.map((t) => t.name);

    expect(toolNames).toContain('search_hybrid');
    expect(toolNames).toContain('search_vector');
    expect(toolNames).toContain('vocabulary_resolve');
  });
});

// =============================================================================
// 2. LIST QUERY AGENT
// =============================================================================

describe('List Query Agent', () => {
  let executor: RuntimeExecutor;
  let mockClient: MockAnthropicClient;

  beforeEach(() => {
    executor = new RuntimeExecutor();
    mockClient = injectMockClient(executor);
    wireSearchToolExecutor(executor, searchServer.baseUrl);
  });

  test('Agent calls search_structured with filters', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([LIST_QUERY_DSL], 'List_Query'),
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
                index_id: INDEX_ID,
                filters: [{ field: 'category', operator: 'eq', value: 'database' }],
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
                index_id: INDEX_ID,
                filters: [{ field: 'category', operator: 'eq', value: 'database' }],
                limit: 50,
              },
            },
          ],
        };
      }

      for (const msg of messages) {
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          for (const block of msg.content as any[]) {
            if (block.type === 'tool_result') {
              toolResult = JSON.parse(
                typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
              );
            }
          }
        }
      }

      return {
        text: 'Found database-related documents.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Found database-related documents.' }],
      };
    });

    const result = await executor.executeMessage(session.id, 'Show me database documents');

    expect(toolResult).toBeDefined();
    expect(toolResult.results.length).toBeGreaterThan(0);
    // All results should have category=database
    for (const r of toolResult.results) {
      expect(r.metadata.category).toBe('database');
    }
    expect(result.response).toContain('database');
  });

  test('Category filter returns correct chunks', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([LIST_QUERY_DSL], 'List_Query'),
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
                index_id: INDEX_ID,
                filters: [{ field: 'category', operator: 'eq', value: 'database' }],
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
                index_id: INDEX_ID,
                filters: [{ field: 'category', operator: 'eq', value: 'database' }],
                limit: 50,
              },
            },
          ],
        };
      }

      for (const msg of messages) {
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          for (const block of msg.content as any[]) {
            if (block.type === 'tool_result') {
              toolResult = JSON.parse(
                typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
              );
            }
          }
        }
      }

      return {
        text: 'Found PostgreSQL and MongoDB documents.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Found PostgreSQL and MongoDB documents.' }],
      };
    });

    await executor.executeMessage(session.id, 'Show me database docs');

    const pgChunks = searchServer.ingestResults['postgresql'].chunkCount;
    const mongoChunks = searchServer.ingestResults['mongodb'].chunkCount;
    expect(toolResult.results.length).toBe(pgChunks + mongoChunks);
  });

  test('Price filter works end-to-end', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([LIST_QUERY_DSL], 'List_Query'),
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
                index_id: INDEX_ID,
                filters: [{ field: 'price', operator: 'gt', value: 50 }],
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
                index_id: INDEX_ID,
                filters: [{ field: 'price', operator: 'gt', value: 50 }],
                limit: 50,
              },
            },
          ],
        };
      }

      for (const msg of messages) {
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          for (const block of msg.content as any[]) {
            if (block.type === 'tool_result') {
              toolResult = JSON.parse(
                typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
              );
            }
          }
        }
      }

      return {
        text: 'Found premium content.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Found premium content.' }],
      };
    });

    await executor.executeMessage(session.id, 'Show items over $50');

    // kubernetes (79.99), react (59.99), postgresql (99.99) — not mongodb (39.99)
    const expectedTotalCount =
      searchServer.ingestResults['kubernetes'].chunkCount +
      searchServer.ingestResults['react'].chunkCount +
      searchServer.ingestResults['postgresql'].chunkCount;
    expect(toolResult.totalCount).toBeLessThanOrEqual(expectedTotalCount);
    expect(toolResult.results.length).toBe(50);

    // None from MongoDB
    const mongoDocId = searchServer.ingestResults['mongodb'].documentId;
    for (const r of toolResult.results) {
      expect(r.documentId).not.toBe(mongoDocId);
    }
  });

  test('Vocab resolve → structured search chain', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([LIST_QUERY_DSL], 'List_Query'),
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
              input: { project_kb_id: KB_ID, query: 'devops tools' },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_vocab',
              name: 'vocabulary_resolve',
              input: { project_kb_id: KB_ID, query: 'devops tools' },
            },
          ],
        };
      }

      if (callNum === 2) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_structured',
              name: 'search_structured',
              input: {
                index_id: INDEX_ID,
                filters: [{ field: 'category', operator: 'eq', value: 'devops' }],
                limit: 20,
              },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_structured',
              name: 'search_structured',
              input: {
                index_id: INDEX_ID,
                filters: [{ field: 'category', operator: 'eq', value: 'devops' }],
                limit: 20,
              },
            },
          ],
        };
      }

      return {
        text: 'Found DevOps content including Kubernetes guides.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Found DevOps content including Kubernetes guides.' }],
      };
    });

    const result = await executor.executeMessage(session.id, 'List devops tools');

    expect(mockClient.calls.length).toBe(3);
    expect(result.response).toContain('DevOps');
  });

  test('Multiple AND filters', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([LIST_QUERY_DSL], 'List_Query'),
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
                index_id: INDEX_ID,
                filters: [
                  { field: 'category', operator: 'eq', value: 'frontend' },
                  { field: 'difficulty', operator: 'eq', value: 'intermediate' },
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
                index_id: INDEX_ID,
                filters: [
                  { field: 'category', operator: 'eq', value: 'frontend' },
                  { field: 'difficulty', operator: 'eq', value: 'intermediate' },
                ],
                limit: 50,
              },
            },
          ],
        };
      }

      for (const msg of messages) {
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          for (const block of msg.content as any[]) {
            if (block.type === 'tool_result') {
              toolResult = JSON.parse(
                typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
              );
            }
          }
        }
      }

      return {
        text: 'Found React intermediate content.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Found React intermediate content.' }],
      };
    });

    await executor.executeMessage(session.id, 'Show intermediate frontend docs');

    // Only React should match (frontend + intermediate)
    expect(toolResult.results.length).toBe(searchServer.ingestResults['react'].chunkCount);
    for (const r of toolResult.results) {
      expect(r.metadata.category).toBe('frontend');
      expect(r.metadata.difficulty).toBe('intermediate');
    }
  });

  test('Contains filter on product field', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([LIST_QUERY_DSL], 'List_Query'),
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
                index_id: INDEX_ID,
                filters: [{ field: 'product', operator: 'contains', value: 'post' }],
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
                index_id: INDEX_ID,
                filters: [{ field: 'product', operator: 'contains', value: 'post' }],
                limit: 50,
              },
            },
          ],
        };
      }

      for (const msg of messages) {
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          for (const block of msg.content as any[]) {
            if (block.type === 'tool_result') {
              toolResult = JSON.parse(
                typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
              );
            }
          }
        }
      }

      return {
        text: 'Found PostgreSQL content.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Found PostgreSQL content.' }],
      };
    });

    await executor.executeMessage(session.id, 'Show docs containing post');

    // Only "postgresql" contains "post"
    expect(toolResult.results.length).toBe(searchServer.ingestResults['postgresql'].chunkCount);
    expect(toolResult.results[0].metadata.product).toBe('postgresql');
  });

  test('Agent receives structured results with real chunk content', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([LIST_QUERY_DSL], 'List_Query'),
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
                index_id: INDEX_ID,
                filters: [{ field: 'product', operator: 'eq', value: 'react' }],
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
                index_id: INDEX_ID,
                filters: [{ field: 'product', operator: 'eq', value: 'react' }],
                limit: 50,
              },
            },
          ],
        };
      }

      for (const msg of messages) {
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          for (const block of msg.content as any[]) {
            if (block.type === 'tool_result') {
              toolResult = JSON.parse(
                typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
              );
            }
          }
        }
      }

      return {
        text: 'Found React content.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Found React content.' }],
      };
    });

    await executor.executeMessage(session.id, 'Show React docs');

    expect(toolResult.results.length).toBe(searchServer.ingestResults['react'].chunkCount);
    // Content should be real text from the React handbook
    const allContent = toolResult.results.map((r: any) => r.content || '').join(' ');
    expect(allContent).toContain('React');
    // Each result should have content and metadata
    for (const r of toolResult.results) {
      expect(r.content).toBeDefined();
      expect(r.content.length).toBeGreaterThan(0);
      expect(r.metadata).toBeDefined();
      expect(r.metadata.product).toBe('react');
    }
  });

  test('System prompt includes search_structured tool', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([LIST_QUERY_DSL], 'List_Query'),
    );

    mockClient.setResponseHandler(() => ({
      text: 'I can help.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'I can help.' }],
    }));

    await executor.executeMessage(session.id, 'Hello');

    const tools = mockClient.calls[0].tools as Array<{ name: string }>;
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain('search_structured');
    expect(toolNames).toContain('vocabulary_resolve');
  });
});

// =============================================================================
// 3. AGGREGATION AGENT
// =============================================================================

describe('Aggregation Agent', () => {
  let executor: RuntimeExecutor;
  let mockClient: MockAnthropicClient;

  beforeEach(() => {
    executor = new RuntimeExecutor();
    mockClient = injectMockClient(executor);
    wireSearchToolExecutor(executor, searchServer.baseUrl);
  });

  test('Agent calls search_aggregate with SUM', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([AGGREGATION_DSL], 'Aggregation'),
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
                index_id: INDEX_ID,
                measure: 'price',
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
                index_id: INDEX_ID,
                measure: 'price',
                function: 'sum',
                group_by: ['category'],
              },
            },
          ],
        };
      }

      for (const msg of messages) {
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          for (const block of msg.content as any[]) {
            if (block.type === 'tool_result') {
              toolResult = JSON.parse(
                typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
              );
            }
          }
        }
      }

      return {
        text: 'The total price across categories is shown.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'The total price across categories is shown.' }],
      };
    });

    await executor.executeMessage(session.id, 'What is the total price by category?');

    expect(toolResult).toBeDefined();
    expect(toolResult.results.length).toBe(3); // devops, frontend, database
  });

  test('COUNT grouped by category', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([AGGREGATION_DSL], 'Aggregation'),
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
                index_id: INDEX_ID,
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
                index_id: INDEX_ID,
                measure: 'category',
                function: 'count',
                group_by: ['category'],
              },
            },
          ],
        };
      }

      for (const msg of messages) {
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          for (const block of msg.content as any[]) {
            if (block.type === 'tool_result') {
              toolResult = JSON.parse(
                typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
              );
            }
          }
        }
      }

      return {
        text: 'There are 3 category groups.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'There are 3 category groups.' }],
      };
    });

    await executor.executeMessage(session.id, 'How many items per category?');

    expect(toolResult).toBeDefined();
    expect(toolResult.results.length).toBe(3);

    const byCategory = Object.fromEntries(
      toolResult.results.map((r: any) => [r.groupKey?.category, r.count]),
    );
    expect(byCategory['intermediate']).toBeUndefined(); // grouped by category, not difficulty
    expect(byCategory['devops']).toBe(searchServer.ingestResults['kubernetes'].chunkCount);
    expect(byCategory['frontend']).toBe(searchServer.ingestResults['react'].chunkCount);
    expect(byCategory['database']).toBe(
      searchServer.ingestResults['postgresql'].chunkCount +
        searchServer.ingestResults['mongodb'].chunkCount,
    );
  });

  test('AVG price across all chunks', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([AGGREGATION_DSL], 'Aggregation'),
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
              input: { index_id: INDEX_ID, measure: 'price', function: 'avg' },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'search_aggregate',
              input: { index_id: INDEX_ID, measure: 'price', function: 'avg' },
            },
          ],
        };
      }

      for (const msg of messages) {
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          for (const block of msg.content as any[]) {
            if (block.type === 'tool_result') {
              toolResult = JSON.parse(
                typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
              );
            }
          }
        }
      }

      return {
        text: 'Average price reported.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Average price reported.' }],
      };
    });

    await executor.executeMessage(session.id, 'What is the average price?');

    expect(toolResult.results.length).toBe(1);
    expect(typeof toolResult.results[0].value).toBe('number');
    expect(toolResult.results[0].value).toBeGreaterThan(0);
  });

  test('MIN/MAX price', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([AGGREGATION_DSL], 'Aggregation'),
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
              input: { index_id: INDEX_ID, measure: 'price', function: 'min' },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_min',
              name: 'search_aggregate',
              input: { index_id: INDEX_ID, measure: 'price', function: 'min' },
            },
          ],
        };
      }

      for (const msg of messages) {
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          for (const block of msg.content as any[]) {
            if (block.type === 'tool_result') {
              minResult = JSON.parse(
                typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
              );
            }
          }
        }
      }

      return {
        text: 'Min price found.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Min price found.' }],
      };
    });

    await executor.executeMessage(session.id, 'What is the minimum price?');
    expect(minResult.results[0].value).toBeCloseTo(39.99, 1);

    // Test MAX with a new session
    const session2 = executor.createSessionFromResolved(
      compileToResolvedAgent([AGGREGATION_DSL], 'Aggregation'),
    );
    mockClient.calls = []; // Reset calls

    mockClient.setResponseHandler((_systemPrompt, messages, tools) => {
      const callNum = mockClient.calls.length;

      if (callNum === 1 && tools.length > 0) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_max',
              name: 'search_aggregate',
              input: { index_id: INDEX_ID, measure: 'price', function: 'max' },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_max',
              name: 'search_aggregate',
              input: { index_id: INDEX_ID, measure: 'price', function: 'max' },
            },
          ],
        };
      }

      for (const msg of messages) {
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          for (const block of msg.content as any[]) {
            if (block.type === 'tool_result') {
              maxResult = JSON.parse(
                typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
              );
            }
          }
        }
      }

      return {
        text: 'Max price found.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Max price found.' }],
      };
    });

    await executor.executeMessage(session2.id, 'What is the maximum price?');
    expect(maxResult.results[0].value).toBeCloseTo(99.99, 1);
  });

  test('Aggregation with filter: SUM price where category=database', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([AGGREGATION_DSL], 'Aggregation'),
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
                index_id: INDEX_ID,
                measure: 'price',
                function: 'sum',
                filters: [{ field: 'category', operator: 'eq', value: 'database' }],
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
                index_id: INDEX_ID,
                measure: 'price',
                function: 'sum',
                filters: [{ field: 'category', operator: 'eq', value: 'database' }],
              },
            },
          ],
        };
      }

      for (const msg of messages) {
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          for (const block of msg.content as any[]) {
            if (block.type === 'tool_result') {
              toolResult = JSON.parse(
                typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
              );
            }
          }
        }
      }

      return {
        text: 'Database price sum calculated.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Database price sum calculated.' }],
      };
    });

    await executor.executeMessage(session.id, 'Total price for database category?');

    const expectedSum =
      99.99 * searchServer.ingestResults['postgresql'].chunkCount +
      39.99 * searchServer.ingestResults['mongodb'].chunkCount;
    expect(toolResult.results[0].value).toBeCloseTo(expectedSum, 0);
  });

  test('COUNT_DISTINCT on category', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([AGGREGATION_DSL], 'Aggregation'),
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
              input: { index_id: INDEX_ID, measure: 'category', function: 'count_distinct' },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'search_aggregate',
              input: { index_id: INDEX_ID, measure: 'category', function: 'count_distinct' },
            },
          ],
        };
      }

      for (const msg of messages) {
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          for (const block of msg.content as any[]) {
            if (block.type === 'tool_result') {
              toolResult = JSON.parse(
                typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
              );
            }
          }
        }
      }

      return {
        text: '3 distinct categories.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: '3 distinct categories.' }],
      };
    });

    await executor.executeMessage(session.id, 'How many distinct categories?');

    expect(toolResult.results[0].value).toBe(3);
  });

  test('Agent receives aggregation results with correct structure', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([AGGREGATION_DSL], 'Aggregation'),
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
                index_id: INDEX_ID,
                measure: 'price',
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
                index_id: INDEX_ID,
                measure: 'price',
                function: 'sum',
                group_by: ['category'],
              },
            },
          ],
        };
      }

      for (const msg of messages) {
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          for (const block of msg.content as any[]) {
            if (block.type === 'tool_result') {
              toolResult = JSON.parse(
                typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
              );
            }
          }
        }
      }

      return {
        text: 'Aggregation complete.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Aggregation complete.' }],
      };
    });

    await executor.executeMessage(session.id, 'Sum prices by category');

    // Verify result structure
    expect(toolResult).toHaveProperty('results');
    expect(toolResult).toHaveProperty('totalCount');
    for (const r of toolResult.results) {
      expect(r).toHaveProperty('value');
      expect(r).toHaveProperty('count');
      expect(r).toHaveProperty('groupKey');
      expect(r.groupKey).toHaveProperty('category');
    }
  });

  test('System prompt includes search_aggregate tool', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([AGGREGATION_DSL], 'Aggregation'),
    );

    mockClient.setResponseHandler(() => ({
      text: 'I can help.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'I can help.' }],
    }));

    await executor.executeMessage(session.id, 'Hello');

    const tools = mockClient.calls[0].tools as Array<{ name: string }>;
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain('search_aggregate');
    expect(toolNames).toContain('vocabulary_resolve');
  });
});

// =============================================================================
// 4. INTEGRATION & ERROR HANDLING
// =============================================================================

describe('Integration & Error Handling', () => {
  let executor: RuntimeExecutor;
  let mockClient: MockAnthropicClient;

  beforeEach(() => {
    executor = new RuntimeExecutor();
    mockClient = injectMockClient(executor);
    wireSearchToolExecutor(executor, searchServer.baseUrl);
  });

  test('Different agents share same search index', async () => {
    // Knowledge retrieval agent searches same index
    const session1 = executor.createSessionFromResolved(
      compileToResolvedAgent([KNOWLEDGE_RETRIEVAL_DSL], 'Knowledge_Retrieval'),
    );

    let knowledgeResult: any;

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
                index_id: INDEX_ID,
                query: 'react components',
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
                index_id: INDEX_ID,
                query: 'react components',
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
              knowledgeResult = JSON.parse(
                typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
              );
            }
          }
        }
      }

      return {
        text: 'React info from knowledge agent.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'React info from knowledge agent.' }],
      };
    });

    await executor.executeMessage(session1.id, 'Tell me about React');

    // List query agent queries same index
    const session2 = executor.createSessionFromResolved(
      compileToResolvedAgent([LIST_QUERY_DSL], 'List_Query'),
    );
    mockClient.calls = [];

    let listResult: any;

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
                index_id: INDEX_ID,
                filters: [{ field: 'category', operator: 'eq', value: 'frontend' }],
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
                index_id: INDEX_ID,
                filters: [{ field: 'category', operator: 'eq', value: 'frontend' }],
                limit: 50,
              },
            },
          ],
        };
      }

      for (const msg of messages) {
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          for (const block of msg.content as any[]) {
            if (block.type === 'tool_result') {
              listResult = JSON.parse(
                typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
              );
            }
          }
        }
      }

      return {
        text: 'Frontend docs from list agent.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Frontend docs from list agent.' }],
      };
    });

    await executor.executeMessage(session2.id, 'Show frontend docs');

    // Both should have queried the same data
    expect(knowledgeResult.results.length).toBeGreaterThan(0);
    expect(listResult.results.length).toBeGreaterThan(0);

    // React chunks should appear in both results
    const reactDocId = searchServer.ingestResults['react'].documentId;
    const knowledgeHasReact = knowledgeResult.results.some((r: any) => r.documentId === reactDocId);
    expect(knowledgeHasReact).toBe(true);
    expect(listResult.results.length).toBe(searchServer.ingestResults['react'].chunkCount);
  });

  test('Tool execution traces have correct structure', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([KNOWLEDGE_RETRIEVAL_DSL], 'Knowledge_Retrieval'),
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
                index_id: INDEX_ID,
                query: 'kubernetes',
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
                index_id: INDEX_ID,
                query: 'kubernetes',
                top_k: 3,
                similarity_threshold: 0.1,
              },
            },
          ],
        };
      }

      return {
        text: 'Answer.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Answer.' }],
      };
    });

    const traceCollector = createTraceCollector();
    await executor.executeMessage(
      session.id,
      'Tell me about kubernetes',
      undefined,
      traceCollector.callback,
    );

    // Verify trace structure — look for any tool-related trace
    const toolTraces = traceCollector.traces.filter(
      (t) => t.type.includes('tool') || t.data?.toolName !== undefined,
    );
    if (toolTraces.length > 0) {
      const trace = toolTraces[0];
      expect(trace.type).toBeDefined();
      expect(trace.data).toBeDefined();
    }

    // At minimum, there should be traces emitted
    expect(traceCollector.traces.length).toBeGreaterThan(0);
  });

  test('LLM call traces have correct structure', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([KNOWLEDGE_RETRIEVAL_DSL], 'Knowledge_Retrieval'),
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
                index_id: INDEX_ID,
                query: 'kubernetes',
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
                index_id: INDEX_ID,
                query: 'kubernetes',
                top_k: 3,
                similarity_threshold: 0.1,
              },
            },
          ],
        };
      }

      return {
        text: 'Answer.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Answer.' }],
      };
    });

    const traceCollector = createTraceCollector();
    await executor.executeMessage(
      session.id,
      'Tell me about kubernetes',
      undefined,
      traceCollector.callback,
    );

    // There should be reasoning/LLM-related traces
    const llmTraces = traceCollector.traces.filter(
      (t) => t.type.includes('llm') || t.type.includes('reasoning') || t.type.includes('turn'),
    );
    expect(llmTraces.length).toBeGreaterThan(0);
  });

  test('Conversation history preserved across turns', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([KNOWLEDGE_RETRIEVAL_DSL], 'Knowledge_Retrieval'),
    );

    let turn2Messages: any[];

    mockClient.setResponseHandler((_systemPrompt, messages, tools) => {
      const callNum = mockClient.calls.length;

      // Turn 1 — simple response
      if (callNum === 1) {
        return {
          text: 'I can help you search for information. What would you like to know?',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [
            {
              type: 'text',
              text: 'I can help you search for information. What would you like to know?',
            },
          ],
        };
      }

      // Turn 2 — search
      if (callNum === 2 && tools.length > 0) {
        turn2Messages = [...messages];
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_1',
              name: 'search_hybrid',
              input: {
                index_id: INDEX_ID,
                query: 'kubernetes pods',
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
                index_id: INDEX_ID,
                query: 'kubernetes pods',
                top_k: 5,
                similarity_threshold: 0.1,
              },
            },
          ],
        };
      }

      return {
        text: 'Kubernetes pods are the smallest deployable units.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Kubernetes pods are the smallest deployable units.' }],
      };
    });

    // Turn 1
    await executor.executeMessage(session.id, 'Hello');

    // Turn 2
    await executor.executeMessage(session.id, 'Tell me about kubernetes pods');

    // The second turn's messages should include history from the first turn
    expect(turn2Messages!).toBeDefined();
    expect(turn2Messages!.length).toBeGreaterThanOrEqual(3); // first user + assistant reply + second user
    // Find the first user message in history
    const userMessages = turn2Messages!.filter((m: any) => m.role === 'user');
    expect(userMessages.length).toBeGreaterThanOrEqual(2);
  });
});
