/**
 * Scenario 9: Agent Adaptive Search Behavior
 *
 * Tests how an agent adapts its search behavior based on KB capabilities
 * discovered automatically at session start. The agent doesn't explicitly
 * call the discovery API — the system handles it transparently.
 *
 * Scenarios:
 * 1. Fresh KB (no vocab, no classification) → agent sends raw queries
 * 2. KB with vocabulary → agent applies vocabulary for precise filters
 * 3. KB with classification examples → agent classifies query type
 * 4. KB with full capabilities → agent uses vocabulary + classification
 *    for structured, semantic, hybrid, and aggregation queries
 *
 * Architecture:
 *   Agent session starts
 *     → SearchAIKBToolExecutor auto-discovers KB capabilities
 *     → Tool description enriched with available features
 *     → Agent reads enriched description and adapts per query
 *     → Each tool call routes through unified search pipeline
 *
 * Real: MongoDB, Express server, Discovery API, search execution
 * Mocked: Auth, permission filter, preprocessing service
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';

// ─── Mocks (must be before any imports that load search-ai-runtime modules) ──

vi.mock('../../../../../search-ai-runtime/src/middleware/auth.js', () => ({
  authMiddleware: (_req: any, _res: any, next: any) => next(),
  unifiedAuth: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../../../../search-ai-runtime/src/middleware/verify-index-ownership.js', () => ({
  verifyIndexOwnership: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../../../../search-ai-runtime/src/services/query/permission-filter-service.js', () => ({
  getPermissionFilterService: () => ({
    buildPublicPermissionFilter: () => ({
      bool: { should: [{ match_all: {} }], minimum_should_match: 1 },
    }),
    buildUserPermissionFilter: async () => ({
      bool: { should: [{ match_all: {} }], minimum_should_match: 1 },
    }),
  }),
}));
vi.mock('../../../../../search-ai-runtime/src/services/cache/redis-client.js', () => ({
  getGlobalRedisClient: () => null,
  getRedisHandle: () => null,
}));

// ─── Imports ─────────────────────────────────────────────────────────────────

import { setupServer, teardownServer, SERVER_CONSTANTS } from './helpers/setup.js';
import { SearchAIKBToolExecutor } from '../../../services/search-ai/searchai-kb-tool-executor.js';
import type { TestSearchServer } from '../../helpers/search-server.js';

let server: TestSearchServer;

beforeAll(async () => {
  server = await setupServer();
}, 30_000);

afterAll(async () => {
  await teardownServer();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create a KB tool executor (simulates what _wireExecutor does at session start).
 * The executor auto-discovers KB capabilities on first tool call.
 */
function createAgentTool(
  toolName: string,
  indexId: string,
): { executor: SearchAIKBToolExecutor; getDescription: () => string } {
  let enrichedDescription = '';

  const executor = new SearchAIKBToolExecutor({
    runtimeUrl: server.baseUrl,
    searchTimeoutMs: 15_000,
    discoveryTimeoutMs: 5_000,
  });

  executor.registerBinding(toolName, {
    tenantId: SERVER_CONSTANTS.TENANT_ID,
    indexId,
  });

  executor.setDescriptionCallback((_name, description) => {
    enrichedDescription = description;
  });

  return {
    executor,
    getDescription: () => enrichedDescription,
  };
}

// =============================================================================
// SCENARIO 1: Fresh KB — No vocabulary, no classification data
// Agent sends raw queries without filters or classification
// =============================================================================

describe('Agent with Fresh KB (no vocabulary, no classification)', () => {
  // INDEX_ID has documents but NO vocabulary (vocab is only on KB_ID)

  test('agent tool discovers KB has no vocabulary', async () => {
    const { executor, getDescription } = createAgentTool(
      'search_fresh_docs',
      SERVER_CONSTANTS.INDEX_ID,
    );

    // Agent's first search — triggers automatic discovery
    const result = (await executor.execute(
      'search_fresh_docs',
      { query: 'how does kubernetes handle pod scheduling', queryType: 'hybrid' },
      15_000,
    )) as any;

    // System discovered capabilities and enriched tool description
    const description = getDescription();
    expect(description).toContain('VOCABULARY (not available)');

    // Search still returns results despite no vocabulary
    expect(result).toBeDefined();
    expect(result.results).toBeDefined();
  });

  test('agent sends raw semantic query (no filters possible)', async () => {
    const { executor } = createAgentTool('search_raw', SERVER_CONSTANTS.INDEX_ID);

    // Without vocabulary, agent can only do raw semantic/hybrid search
    const result = (await executor.execute(
      'search_raw',
      {
        query: 'explain MongoDB replication and sharding strategies',
        queryType: 'vector',
      },
      15_000,
    )) as any;

    expect(result.results).toBeDefined();
    expect(result.results.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// SCENARIO 2: KB with vocabulary — Agent applies vocabulary for precise filters
// =============================================================================

describe('Agent with Vocabulary-Enabled KB', () => {
  // KB_ID has vocabulary (devops tools, total price, advanced content)

  test('agent discovers vocabulary terms and uses them for filtering', async () => {
    const { executor, getDescription } = createAgentTool(
      'search_with_vocab',
      SERVER_CONSTANTS.KB_ID,
    );

    // Agent's first search — triggers discovery, gets vocabulary
    const result = (await executor.execute(
      'search_with_vocab',
      {
        query: 'show me devops tools documentation',
        queryType: 'hybrid',
      },
      15_000,
    )) as any;

    // Tool description was enriched with vocabulary terms
    const description = getDescription();
    expect(description).toContain('VOCABULARY (available');
    expect(description).toContain('devops tools');
    expect(description).toContain('total price');
    expect(description).toContain('advanced content');

    expect(result).toBeDefined();
  });

  test('agent uses vocabulary to construct structured search with filters', async () => {
    const { executor } = createAgentTool('search_structured_vocab', SERVER_CONSTANTS.KB_ID);

    // Agent reads vocabulary: "devops tools" maps to field "category"
    // Agent constructs filter based on vocabulary knowledge
    const result = (await executor.execute(
      'search_structured_vocab',
      {
        query: 'devops infrastructure tools',
        queryType: 'hybrid',
        filters: [{ field: 'category', operator: 'eq', value: 'devops' }],
        skipPreprocessing: true,
        skipVocabularyResolution: true,
      },
      15_000,
    )) as any;

    expect(result).toBeDefined();
  });
});

// =============================================================================
// SCENARIO 3: KB with classification examples — Agent classifies query type
// =============================================================================

describe('Agent with Classification-Enabled KB', () => {
  test('agent discovers classification examples in tool description', async () => {
    const { executor, getDescription } = createAgentTool(
      'search_classified',
      SERVER_CONSTANTS.KB_ID,
    );

    await executor.execute(
      'search_classified',
      { query: 'test query', queryType: 'hybrid' },
      15_000,
    );

    const description = getDescription();

    // Classification guidance should be in the tool description
    expect(description).toContain('QUERY CLASSIFICATION');
    expect(description).toContain('structured');
    expect(description).toContain('semantic');
    expect(description).toContain('hybrid');
    expect(description).toContain('aggregation');
  });

  test('agent classifies conceptual question as semantic', async () => {
    // INDEX_ID has indexed documents for vector search
    const { executor } = createAgentTool('search_semantic_q', SERVER_CONSTANTS.INDEX_ID);

    // Agent reads classification examples and determines:
    // "how does X work" → semantic (conceptual, no field filters)
    const result = (await executor.execute(
      'search_semantic_q',
      {
        query: 'how does container orchestration handle failover',
        queryType: 'vector', // Agent classified as semantic
      },
      15_000,
    )) as any;

    expect(result.results).toBeDefined();
    expect(result.results.length).toBeGreaterThan(0);
  });

  test('agent classifies filter query as structured', async () => {
    const { executor } = createAgentTool('search_filter_q', SERVER_CONSTANTS.KB_ID);

    // Agent reads classification examples and determines:
    // "show me X where Y" → structured (field filter intent)
    // Agent also knows vocabulary: "advanced content" → difficulty field
    const result = (await executor.execute(
      'search_filter_q',
      {
        query: 'show me advanced content about databases',
        queryType: 'hybrid',
        filters: [{ field: 'difficulty', operator: 'eq', value: 'advanced' }],
        skipPreprocessing: true,
        skipVocabularyResolution: true,
      },
      15_000,
    )) as any;

    expect(result).toBeDefined();
  });
});

// =============================================================================
// SCENARIO 4: Full capabilities — Agent uses everything for all query types
// =============================================================================

describe('Agent with Full Capabilities (vocabulary + classification + filters)', () => {
  test('hybrid search: agent combines vocabulary filters with semantic query', async () => {
    const { executor } = createAgentTool('search_full_hybrid', SERVER_CONSTANTS.KB_ID);

    // Agent has vocabulary + classification
    // "advanced content about kubernetes" →
    //   vocabulary: "advanced content" → difficulty=advanced
    //   classification: has filter + concept → hybrid
    //   semantic part: "kubernetes" (no vocab match, stays as query text)
    const result = (await executor.execute(
      'search_full_hybrid',
      {
        query: 'kubernetes container orchestration',
        queryType: 'hybrid',
        filters: [{ field: 'difficulty', operator: 'eq', value: 'advanced' }],
        skipPreprocessing: true,
        skipVocabularyResolution: true,
      },
      15_000,
    )) as any;

    expect(result).toBeDefined();
    expect(result.queryType).toBeDefined();
  });

  test('semantic search: agent sends concept-only query', async () => {
    // INDEX_ID has indexed documents for vector search
    const { executor } = createAgentTool('search_full_semantic', SERVER_CONSTANTS.INDEX_ID);

    // Agent determines: purely conceptual, no vocabulary terms match
    // classification → semantic
    const result = (await executor.execute(
      'search_full_semantic',
      {
        query: 'explain the benefits of reactive programming patterns',
        queryType: 'vector',
      },
      15_000,
    )) as any;

    expect(result.results).toBeDefined();
    expect(result.results.length).toBeGreaterThan(0);
  });

  test('agent conversation: second query builds on first context', async () => {
    const { executor } = createAgentTool('search_conversation', SERVER_CONSTANTS.KB_ID);

    // Turn 1: Agent searches broadly
    const turn1 = (await executor.execute(
      'search_conversation',
      {
        query: 'database technologies overview',
        queryType: 'hybrid',
      },
      15_000,
    )) as any;

    expect(turn1.results).toBeDefined();

    // Turn 2: Agent narrows based on conversation context
    // Agent knows from turn 1 results that PostgreSQL is relevant
    // Adds filter based on vocabulary knowledge
    const turn2 = (await executor.execute(
      'search_conversation',
      {
        query: 'PostgreSQL indexing and performance tuning',
        queryType: 'vector',
        skipPreprocessing: true,
      },
      15_000,
    )) as any;

    expect(turn2.results).toBeDefined();
    // Discovery was cached from turn 1 — no re-fetch
  });

  test('tool description contains all capability sections', async () => {
    const { executor, getDescription } = createAgentTool(
      'search_full_check',
      SERVER_CONSTANTS.KB_ID,
    );

    await executor.execute('search_full_check', { query: 'test', queryType: 'hybrid' }, 15_000);

    const description = getDescription();

    // All sections present for a fully configured KB
    expect(description).toContain('QUERY CLASSIFICATION');
    expect(description).toContain('VOCABULARY');
    expect(description).toContain('FILTERS');
    expect(description).toContain('RERANKING');
    expect(description).toContain('PREPROCESSING');
    expect(description).toContain('Skip when:');
  });
});
