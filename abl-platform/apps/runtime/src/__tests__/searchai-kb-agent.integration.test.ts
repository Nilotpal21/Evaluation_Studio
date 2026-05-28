/**
 * SearchAI KB Agent End-to-End Integration Test
 *
 * Full agent lifecycle: ABL DSL → compile → RuntimeExecutor session →
 * MockLLM drives tool calls → SearchAIKBToolExecutor → auto-discovery →
 * real Express server with MongoDB + VectorStore → results back to agent
 *
 * Architecture:
 *   RuntimeExecutor.createSessionFromResolved()
 *     → compileToResolvedAgent(DSL)
 *     → MockAnthropicClient (scripted tool calls + synthesis)
 *       → SearchAIKBToolExecutor.execute()
 *         → auto-discover KB capabilities (real /discover endpoint)
 *         → SearchAIClient.unifiedSearch() → real Express server
 *           → Real MongoDB (MongoMemoryServer) + InMemoryVectorStore
 *
 * Real: MongoDB, vector store, chunking, embeddings, HTTP routes, discovery
 * Mocked: LLM responses (scripted tool calls + synthesis), auth middleware
 *
 * Run with: npx vitest run --config vitest.integration.config.ts src/__tests__/searchai-kb-agent.integration.test.ts
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
  getRedisHandle: () => null,
}));

// =============================================================================
// IMPORTS
// =============================================================================

import { RuntimeExecutor, compileToResolvedAgent } from '../services/runtime-executor.js';
import { SearchAIKBToolExecutor } from '../services/search-ai/searchai-kb-tool-executor.js';
import { MockToolExecutor } from './fixtures/mock-tool-executor.js';
import {
  startTestSearchServer,
  stopTestSearchServer,
  INDEX_ID,
  KB_ID,
  TENANT_ID,
  type TestSearchServer,
} from './helpers/search-server.js';

// =============================================================================
// MOCK LLM CLIENT
// =============================================================================

class MockAnthropicClient {
  calls: Array<{
    systemPrompt: string;
    messages: Array<{ role: string; content: unknown }>;
    tools: unknown[];
  }> = [];

  private responseQueue: Array<
    (
      systemPrompt: string,
      messages: Array<{ role: string; content: unknown }>,
      tools: unknown[],
    ) => {
      text: string;
      toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
      stopReason: string;
      rawContent: Array<{ type: string; [key: string]: unknown }>;
    }
  > = [];

  private defaultHandler = () => ({
    text: 'I can help you with that.',
    toolCalls: [] as any[],
    stopReason: 'end_turn',
    rawContent: [{ type: 'text', text: 'I can help you with that.' }],
  });

  queueResponse(handler: typeof this.defaultHandler): void {
    this.responseQueue.push(handler);
  }

  async chatWithToolUse(
    systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: unknown[],
  ) {
    this.calls.push({ systemPrompt, messages, tools });
    const handler = this.responseQueue.shift() ?? this.defaultHandler;
    return handler(systemPrompt, messages, tools);
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
  (executor as any).llmWiring.wireLLMClient = async (session: any) => {
    session.llmClient = mock;
  };
  (executor as any).llmWiring.ensureSessionLLMClient = async (session: any) => {
    if (!session.llmClient) {
      session.llmClient = mock;
    }
  };
  return mock;
}

/**
 * Wire SearchAI KB tool executor - mirrors what _wireExecutor() does
 * when it detects tool_type: 'searchai' in the session's tool list.
 */
function wireKBToolExecutor(executor: RuntimeExecutor, baseUrl: string): void {
  (executor as any).llmWiring.wireToolExecutor = (session: any) => {
    const kbExecutor = new SearchAIKBToolExecutor({
      runtimeUrl: baseUrl,
      searchTimeoutMs: 15_000,
      discoveryTimeoutMs: 5_000,
    });

    // Register KB tools with their index bindings
    kbExecutor.registerBinding('search_kb_products', {
      tenantId: TENANT_ID,
      indexId: INDEX_ID,
    });

    kbExecutor.registerBinding('search_kb_vocabulary', {
      tenantId: TENANT_ID,
      indexId: KB_ID,
    });

    // Enrich tool description when discovery completes
    kbExecutor.setDescriptionCallback((toolName, description) => {
      if (session._effectiveConfig?.tools) {
        const tool = session._effectiveConfig.tools.find((t: any) => t.name === toolName);
        if (tool) tool.description = description;
      }
    });

    // Composite executor: KB tools → kbExecutor, everything else → MockToolExecutor
    const fallback = new MockToolExecutor();
    session.toolExecutor = {
      execute: async (name: string, params: Record<string, unknown>, timeout: number) => {
        if (name.startsWith('search_kb_')) {
          return kbExecutor.execute(name, params, timeout);
        }
        return fallback.execute(name, params, timeout);
      },
      executeParallel: async (calls: any[], timeout: number) => {
        return Promise.all(
          calls.map(async (c: any) => {
            try {
              const result = c.name.startsWith('search_kb_')
                ? await kbExecutor.execute(c.name, c.params, timeout)
                : await fallback.execute(c.name, c.params, timeout);
              return { name: c.name, result };
            } catch (err: any) {
              return { name: c.name, error: err.message };
            }
          }),
        );
      },
    };
  };
}

// =============================================================================
// AGENT DSL DEFINITIONS
// =============================================================================

/**
 * Agent that uses a SearchAI KB tool for product documentation search.
 * This is what a developer writes in their ABL file.
 */
const KB_SEARCH_AGENT_DSL = `
AGENT: Product_Search

GOAL: "Search the product documentation knowledge base to answer technical questions"

TOOLS:
  search_kb_products(query: string, queryType?: string, filters?: object[], rerank?: boolean, skipPreprocessing?: boolean) -> {results: object[], totalCount: number, queryType: string}

INSTRUCTIONS: |
  1. When the user asks a technical question, search the product knowledge base
  2. Read the tool description for vocabulary terms and classification guidance
  3. If the question mentions specific domains (devops, database, frontend), apply vocabulary filters
  4. For conceptual questions, use semantic search (queryType: vector)
  5. For field-specific queries, use hybrid search with filters
  6. Always cite the source documents in your response
`;

/**
 * Agent with multiple KB tools for cross-KB search.
 */
const MULTI_KB_AGENT_DSL = `
AGENT: Multi_KB_Search

GOAL: "Search across multiple knowledge bases to find comprehensive answers"

TOOLS:
  search_kb_products(query: string, queryType?: string) -> {results: object[], totalCount: number}
  search_kb_vocabulary(query: string, queryType?: string) -> {results: object[], totalCount: number}

INSTRUCTIONS: |
  1. Determine which knowledge base is most relevant to the user's question
  2. Search the appropriate KB, or search both in parallel for broad questions
  3. Combine and synthesize results from multiple KBs
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
// 1. SINGLE KB AGENT — Product Search
// =============================================================================

describe('Product Search Agent (Single KB)', () => {
  let executor: RuntimeExecutor;
  let mockClient: MockAnthropicClient;

  beforeEach(() => {
    executor = new RuntimeExecutor();
    mockClient = injectMockClient(executor);
    wireKBToolExecutor(executor, searchServer.baseUrl);
  });

  test('agent calls KB tool and gets search results', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([KB_SEARCH_AGENT_DSL], 'Product_Search'),
    );

    // Turn 1: LLM calls search tool
    mockClient.queueResponse(() => ({
      text: '',
      toolCalls: [
        {
          id: 'call_1',
          name: 'search_kb_products',
          input: {
            query: 'kubernetes container orchestration pods',
            queryType: 'hybrid',
            skipPreprocessing: true,
          },
        },
      ],
      stopReason: 'tool_use',
      rawContent: [
        {
          type: 'tool_use',
          id: 'call_1',
          name: 'search_kb_products',
          input: {
            query: 'kubernetes container orchestration pods',
            queryType: 'hybrid',
            skipPreprocessing: true,
          },
        },
      ],
    }));

    // Turn 2: LLM synthesizes answer from results
    mockClient.queueResponse(() => ({
      text: 'Based on the product documentation, Kubernetes uses Pods as the smallest deployable units for container orchestration.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [
        {
          type: 'text',
          text: 'Based on the product documentation, Kubernetes uses Pods as the smallest deployable units for container orchestration.',
        },
      ],
    }));

    const chunks: string[] = [];
    await executor.executeMessage(
      session.id,
      'How does Kubernetes handle container orchestration?',
      (chunk: string) => chunks.push(chunk),
    );

    // LLM was called twice (tool call + synthesis)
    expect(mockClient.calls.length).toBe(2);

    // First call had the search tool available
    const firstCall = mockClient.calls[0];
    expect(firstCall.tools.length).toBeGreaterThan(0);
    const toolNames = (firstCall.tools as any[]).map((t: any) => t.name);
    expect(toolNames).toContain('search_kb_products');

    // Response was synthesized
    const fullResponse = chunks.join('');
    expect(fullResponse).toContain('Kubernetes');
  });

  test('agent uses semantic search for conceptual questions', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([KB_SEARCH_AGENT_DSL], 'Product_Search'),
    );

    mockClient.queueResponse(() => ({
      text: '',
      toolCalls: [
        {
          id: 'call_1',
          name: 'search_kb_products',
          input: {
            query: 'explain reactive programming patterns and state management',
            queryType: 'vector',
          },
        },
      ],
      stopReason: 'tool_use',
      rawContent: [
        {
          type: 'tool_use',
          id: 'call_1',
          name: 'search_kb_products',
          input: {
            query: 'explain reactive programming patterns and state management',
            queryType: 'vector',
          },
        },
      ],
    }));

    mockClient.queueResponse(() => ({
      text: 'React uses a component-based approach with hooks for state management.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [
        {
          type: 'text',
          text: 'React uses a component-based approach with hooks for state management.',
        },
      ],
    }));
    mockClient.queueResponse(() => ({
      text: 'React uses a component-based approach with hooks for state management.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [
        {
          type: 'text',
          text: 'React uses a component-based approach with hooks for state management.',
        },
      ],
    }));

    const chunks: string[] = [];
    await executor.executeMessage(
      session.id,
      'How does React handle state management?',
      (chunk: string) => chunks.push(chunk),
    );

    expect(mockClient.calls.length).toBeGreaterThanOrEqual(2);
    expect(chunks.join('')).toContain('React');
  });

  test('multi-turn conversation preserves context', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([KB_SEARCH_AGENT_DSL], 'Product_Search'),
    );

    // Turn 1
    mockClient.queueResponse(() => ({
      text: '',
      toolCalls: [
        {
          id: 'call_1',
          name: 'search_kb_products',
          input: { query: 'database technologies', queryType: 'hybrid' },
        },
      ],
      stopReason: 'tool_use',
      rawContent: [
        {
          type: 'tool_use',
          id: 'call_1',
          name: 'search_kb_products',
          input: { query: 'database technologies', queryType: 'hybrid' },
        },
      ],
    }));
    mockClient.queueResponse(() => ({
      text: 'We have documentation for PostgreSQL and MongoDB.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'We have documentation for PostgreSQL and MongoDB.' }],
    }));

    await executor.executeMessage(session.id, 'What database docs do we have?', () => {});
    expect(mockClient.calls.length).toBe(2);

    // Turn 2 - builds on context
    mockClient.queueResponse(() => ({
      text: '',
      toolCalls: [
        {
          id: 'call_2',
          name: 'search_kb_products',
          input: {
            query: 'PostgreSQL indexing B-tree',
            queryType: 'vector',
            skipPreprocessing: true,
          },
        },
      ],
      stopReason: 'tool_use',
      rawContent: [
        {
          type: 'tool_use',
          id: 'call_2',
          name: 'search_kb_products',
          input: {
            query: 'PostgreSQL indexing B-tree',
            queryType: 'vector',
            skipPreprocessing: true,
          },
        },
      ],
    }));
    mockClient.queueResponse(() => ({
      text: 'PostgreSQL supports multiple index types including B-tree, Hash, GiST, and GIN.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [
        {
          type: 'text',
          text: 'PostgreSQL supports multiple index types including B-tree, Hash, GiST, and GIN.',
        },
      ],
    }));

    const callsBeforeTurn2 = mockClient.calls.length;
    await executor.executeMessage(session.id, 'Tell me about PostgreSQL indexing', () => {});

    // Search runtime discovery can introduce an extra planning call before synthesis.
    expect(mockClient.calls.length - callsBeforeTurn2).toBeGreaterThanOrEqual(2);

    // Turn 2 has conversation history from turn 1
    const turn2Messages = mockClient.calls[callsBeforeTurn2].messages;
    expect(turn2Messages.length).toBeGreaterThan(1);
  });
});

// =============================================================================
// 2. MULTI-KB AGENT — Cross-KB Search
// =============================================================================

describe('Multi-KB Search Agent', () => {
  let executor: RuntimeExecutor;
  let mockClient: MockAnthropicClient;

  beforeEach(() => {
    executor = new RuntimeExecutor();
    mockClient = injectMockClient(executor);
    wireKBToolExecutor(executor, searchServer.baseUrl);
  });

  test('agent sees multiple KB tools', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([MULTI_KB_AGENT_DSL], 'Multi_KB_Search'),
    );

    mockClient.queueResponse(() => ({
      text: 'I can search across both knowledge bases for you.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'I can search across both knowledge bases for you.' }],
    }));

    await executor.executeMessage(session.id, 'hello', () => {});

    const toolNames = (mockClient.calls[0].tools as any[]).map((t: any) => t.name);
    expect(toolNames).toContain('search_kb_products');
    expect(toolNames).toContain('search_kb_vocabulary');
  });

  test('agent searches specific KB based on question', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([MULTI_KB_AGENT_DSL], 'Multi_KB_Search'),
    );

    // LLM chooses the products KB for this question
    mockClient.queueResponse(() => ({
      text: '',
      toolCalls: [
        {
          id: 'call_1',
          name: 'search_kb_products',
          input: { query: 'kubernetes deployment strategies', queryType: 'hybrid' },
        },
      ],
      stopReason: 'tool_use',
      rawContent: [
        {
          type: 'tool_use',
          id: 'call_1',
          name: 'search_kb_products',
          input: { query: 'kubernetes deployment strategies', queryType: 'hybrid' },
        },
      ],
    }));

    mockClient.queueResponse(() => ({
      text: 'Kubernetes supports rolling updates, blue-green, and canary deployment strategies.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [
        {
          type: 'text',
          text: 'Kubernetes supports rolling updates, blue-green, and canary deployment strategies.',
        },
      ],
    }));
    mockClient.queueResponse(() => ({
      text: 'Kubernetes supports rolling updates, blue-green, and canary deployment strategies.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [
        {
          type: 'text',
          text: 'Kubernetes supports rolling updates, blue-green, and canary deployment strategies.',
        },
      ],
    }));

    const chunks: string[] = [];
    await executor.executeMessage(session.id, 'How do I deploy with Kubernetes?', (chunk: string) =>
      chunks.push(chunk),
    );

    expect(mockClient.calls.length).toBeGreaterThanOrEqual(2);
    expect(chunks.join('')).toContain('Kubernetes');
  });
});
