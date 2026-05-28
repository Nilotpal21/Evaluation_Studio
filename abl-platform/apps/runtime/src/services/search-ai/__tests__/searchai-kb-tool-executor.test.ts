import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SearchAIKBToolExecutor } from '../searchai-kb-tool-executor.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const discoveryManifest = {
  kb: { name: 'Test KB', documentCount: 100, lastUpdated: new Date().toISOString() },
  searchEndpoint: { url: '/api/search/idx_1/query', method: 'POST' },
  capabilities: {
    queryClassification: { available: true, description: 'Classify queries.' },
    vocabulary: {
      available: true,
      description: 'Terms available.',
      terms: [
        {
          term: 'priority',
          aliases: ['pri'],
          field: 'issue_priority',
          values: ['P0', 'P1', 'P2'],
          canFilter: true,
          usage:
            'Map "high priority" to filter { field: "issue_priority", operator: "in", value: ["P0","P1"] }',
        },
        {
          term: 'status',
          aliases: [],
          field: 'issue_status',
          values: ['open', 'closed'],
          canFilter: true,
          usage:
            'Map "open" to filter { field: "issue_status", operator: "equals", value: "open" }',
        },
      ],
    },
    filters: {
      available: true,
      description: 'Filters.',
      fields: [
        { name: 'issue_priority', type: 'string', values: ['P0', 'P1', 'P2', 'P3'] },
        { name: 'issue_status', type: 'string', values: ['open', 'closed'] },
      ],
      operators: ['equals', 'in', 'contains'],
    },
    reranking: { available: true, description: 'Rerank.' },
    preprocessing: { available: true, description: 'Preprocess.' },
  },
  _meta: { version: 'v1', generatedAt: new Date().toISOString(), ttlSeconds: 300 },
};

const searchResult = {
  queryId: 'qry_123',
  queryType: 'hybrid',
  results: [
    { documentId: 'doc1', chunkId: 'c1', score: 0.92, content: 'Test content', metadata: {} },
  ],
  totalCount: 1,
  latency: { totalMs: 50 },
};

describe('SearchAIKBToolExecutor', () => {
  let executor: SearchAIKBToolExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = new SearchAIKBToolExecutor({
      runtimeUrl: 'http://localhost:3114',
      authToken: 'test-jwt-token',
    });
    executor.registerBinding('search_products', {
      tenantId: 'tenant_1',
      indexId: 'idx_products',
    });
  });

  // ─── No Discovery During Execute (Latency Optimization) ──────────────
  // Discovery is NOT called during execute() — it was already fetched at session
  // start via triggerEagerDiscovery(). Only the search call is made.

  it('calls only search (no discovery) during execute', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => searchResult,
    });

    const result = await executor.execute('search_products', { query: 'test' }, 30000);

    // Only search was called — no discovery
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:3114/api/search/idx_products/query');
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer test-jwt-token');

    // Result formatted — lean output (title + content only, no documentId)
    expect((result as any).results).toHaveLength(1);
    expect((result as any).results[0].content).toBe('Test content');
    // Search latency included for debug visibility
    expect((result as any)._searchLatencyMs).toBeTypeOf('number');
  });

  it('triggerEagerDiscovery fetches discovery and caches it', async () => {
    const descCallback = vi.fn();
    executor.setDescriptionCallback(descCallback);

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => discoveryManifest,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ queryType: 'hybrid', results: [], totalCount: 0 }),
      });

    await executor.triggerEagerDiscovery('search_products');

    // Discovery + warmup search were called
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0][0]).toBe(
      'http://localhost:3114/api/search/idx_products/discover',
    );
    expect(mockFetch.mock.calls[1][0]).toBe('http://localhost:3114/api/search/idx_products/query');
    expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toMatchObject({
      query: '_warmup',
      queryType: 'hybrid',
      skipPreprocessing: true,
      skipVocabularyResolution: true,
      topK: 1,
    });

    // Description callback fired
    expect(descCallback).toHaveBeenCalledWith(
      'search_products',
      expect.stringContaining('Test KB'),
      'filtered',
    );
  });

  it('forwards query parameters to unified endpoint', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => searchResult });

    await executor.execute(
      'search_products',
      {
        query: 'high priority bugs',
        queryType: 'hybrid',
        filters: [{ field: 'priority', operator: 'equals', value: 'high' }],
        rerank: true,
        skipPreprocessing: true,
        topK: 10,
      },
      30000,
    );

    const searchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(searchBody.query).toBe('high priority bugs');
    expect(searchBody.queryType).toBe('hybrid');
    expect(searchBody.filters).toHaveLength(1);
    expect(searchBody.rerank).toBe(true);
    expect(searchBody.skipPreprocessing).toBe(true);
    expect(searchBody.topK).toBe(10);
  });

  it('uses nested discovery topK when execute omits topK', async () => {
    const nestedTopKManifest = {
      ...discoveryManifest,
      kb: {
        ...discoveryManifest.kb,
        searchDefaults: {
          topK: 7,
        },
      },
    };

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => nestedTopKManifest,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ queryType: 'hybrid', results: [], totalCount: 0 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => searchResult,
      });

    await executor.triggerEagerDiscovery('search_products');
    await executor.execute('search_products', { query: 'test' }, 30000);

    const searchBody = JSON.parse(mockFetch.mock.calls[2][1].body);
    expect(searchBody.topK).toBe(7);
  });

  it('throws on missing binding', async () => {
    await expect(executor.execute('unknown_tool', { query: 'test' }, 30000)).rejects.toThrow(
      'no registered binding',
    );
  });

  it('throws on missing query parameter', async () => {
    await expect(executor.execute('search_products', {}, 30000)).rejects.toThrow(
      'requires a "query" parameter',
    );
  });

  it('formats aggregation results', async () => {
    const aggResult = {
      queryType: 'aggregation',
      results: [],
      aggregations: [
        { groupKey: { status: 'open' }, value: 42, count: 42 },
        { groupKey: { status: 'closed' }, value: 18, count: 18 },
      ],
      totalCount: 2,
    };

    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => aggResult });

    const result = (await executor.execute(
      'search_products',
      { query: 'count by status', queryType: 'aggregation' },
      30000,
    )) as any;

    expect(result.queryType).toBe('aggregation');
    expect(result.aggregations).toHaveLength(2);
    expect(result.aggregations[0].groupKey.status).toBe('open');
  });

  it('handles JSON-stringified aggregation parameter from LLM', async () => {
    const aggResult = {
      queryType: 'aggregation',
      results: [],
      aggregations: [
        { groupKey: { custom_string_1: 'brown' }, value: 5, count: 5 },
        { groupKey: { custom_string_1: 'blue' }, value: 3, count: 3 },
      ],
      totalCount: 2,
    };

    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => aggResult });

    // LLM sends aggregation as JSON string instead of parsed object
    const result = (await executor.execute(
      'search_products',
      {
        query: 'brown color shirts',
        queryType: 'aggregation',
        aggregation: '{"field": "custom_string_1", "function": "count"}',
      },
      30000,
    )) as any;

    // Verify the aggregation was parsed and sent correctly
    const searchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(searchBody.aggregation).toEqual({ field: 'custom_string_1', function: 'count' });

    // Verify result formatting
    expect(result.queryType).toBe('aggregation');
    expect(result.aggregations).toHaveLength(2);
  });

  it('accepts snake_case parameters', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => searchResult });

    await executor.execute(
      'search_products',
      {
        query: 'test',
        query_type: 'semantic',
        top_k: 5,
        skip_preprocessing: true,
      },
      30000,
    );

    const searchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(searchBody.queryType).toBe('semantic');
    expect(searchBody.topK).toBe(5);
    expect(searchBody.skipPreprocessing).toBe(true);
  });

  // ─── Result Trimming Tests ────────────────────────────────────────────

  describe('result trimming for token budget', () => {
    it('caps results to top 10 and truncates long content', async () => {
      // Create 15 results with long content
      const bigSearchResult = {
        queryType: 'hybrid',
        results: Array.from({ length: 15 }, (_, i) => ({
          documentId: `doc${i}`,
          score: 0.9 - i * 0.01,
          content: 'A'.repeat(1000), // 1000 chars each
          metadata: { canonical: { title: `Doc ${i}`, source_type: 'pdf' } },
        })),
        totalCount: 15,
      };

      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => bigSearchResult });

      const result = (await executor.execute('search_products', { query: 'test' }, 30000)) as any;

      // Capped to 10 results
      expect(result.results).toHaveLength(10);
      // Content is NOT truncated — full content preserved
      expect(result.results[0].content.length).toBe(1000);
      // totalCount still reflects the real count
      expect(result.totalCount).toBe(15);
    });

    it('only returns title and content — no metadata, score, documentId', async () => {
      const metadataHeavyResult = {
        queryType: 'hybrid',
        results: [
          {
            documentId: 'doc1',
            score: 0.9,
            content: 'test content here',
            metadata: {
              canonical: { title: 'My Doc', source_type: 'pdf', language: 'en' },
              complementaryanalogous: ['a', 'b', 'c'],
              vector: [0.1, 0.2, 0.3],
            },
          },
        ],
        totalCount: 1,
      };

      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => metadataHeavyResult });

      const result = (await executor.execute('search_products', { query: 'test' }, 30000)) as any;

      const r = result.results[0];
      // Only title and content survive
      expect(r.title).toBe('My Doc');
      expect(r.content).toBe('test content here');
      // These should NOT be in the output — saves tokens for synthesis LLM
      expect(r.documentId).toBeUndefined();
      expect(r.score).toBeUndefined();
      expect(r.metadata).toBeUndefined();
      expect(r.source).toBeUndefined();
      expect(r.sourceType).toBeUndefined();
      // Search latency in output for debug
      expect(result._searchLatencyMs).toBeTypeOf('number');
    });
  });

  // ─── Latency Optimization Tests ─────────────────────────────────────────

  describe('no enrichment LLM call (latency optimization)', () => {
    it('never calls LLM for enrichment even with conversation context', async () => {
      const mockLLM = vi.fn();

      executor.setLLMChat(mockLLM); // no-op
      executor.setConversationContext([
        { role: 'user', content: 'show me P0 bugs for search team' },
        { role: 'assistant', content: 'Here are the P0 bugs...' },
        { role: 'user', content: 'which are open?' },
      ]); // no-op

      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => searchResult });

      await executor.execute('search_products', { query: 'which are open?' }, 30000);

      // LLM was NOT called — enrichment is removed
      expect(mockLLM).not.toHaveBeenCalled();

      // Search used original query directly (no LLM rewriting)
      const searchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(searchBody.query).toBe('which are open?');
      // Both preprocessing flags default to true in agent flow
      expect(searchBody.skipPreprocessing).toBe(true);
      expect(searchBody.skipVocabularyResolution).toBe(true);
    });

    it('passes through filters from agent LLM without enrichment', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => searchResult });

      await executor.execute(
        'search_products',
        {
          query: 'open P0 bugs',
          filters: [{ field: 'issue_status', operator: 'equals', value: 'open' }],
        },
        30000,
      );

      // Filters passed through directly from agent LLM decision
      const searchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(searchBody.filters).toHaveLength(1);
      expect(searchBody.filters[0].field).toBe('issue_status');
    });

    it('defaults queryType to hybrid when not specified', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => searchResult });

      await executor.execute('search_products', { query: 'test' }, 30000);

      const searchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(searchBody.queryType).toBe('hybrid');
    });
  });

  // Result summarization tests moved to tool-result-compressor.test.ts
  // (summarization now handled by reasoning executor's CompactionPolicy)
});
