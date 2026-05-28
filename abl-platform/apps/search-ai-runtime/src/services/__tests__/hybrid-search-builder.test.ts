import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HybridSearchBuilder } from '../hybrid-search/hybrid-search-builder.js';
import type {
  DynamicVocabularyResolver,
  DynamicResolutionResult,
} from '../vocabulary/dynamic-vocabulary-resolver.js';
import type { EmbeddingProvider } from '@agent-platform/search-ai-internal/embedding';

// ─── Mock Setup ──────────────────────────────────────────────────────────

const createMockVocabularyResolver = (): DynamicVocabularyResolver =>
  ({
    resolve: vi.fn(),
    clearCache: vi.fn(),
    getCacheStats: vi.fn(),
  }) as any;

const createMockEmbeddingProvider = (): EmbeddingProvider => ({
  name: 'mock-provider',
  modelId: 'mock-model',
  dimensions: 1024,
  maxBatchSize: 32,
  embed: vi.fn().mockResolvedValue(new Array(1024).fill(0.5)),
  embedBatch: vi.fn(),
  estimateTokens: vi.fn(),
  healthCheck: vi.fn(),
});

// ─── Test Data ───────────────────────────────────────────────────────────

const mockFilterResolution: DynamicResolutionResult = {
  term: 'high priority',
  resolvedAs: 'filter',
  confidence: 0.95,
  reasoning: 'Filter by priority',
  filter: [
    {
      field: 'priority',
      operator: 'equals',
      value: 'high',
    },
  ],
};

const mockDisplayResolution: DynamicResolutionResult = {
  term: 'summary',
  resolvedAs: 'display',
  confidence: 0.9,
  reasoning: 'Display summary field',
  display: {
    fields: ['summary', 'description'],
  },
};

const mockAggregateResolution: DynamicResolutionResult = {
  term: 'count by status',
  resolvedAs: 'aggregate',
  confidence: 0.85,
  reasoning: 'Aggregate by status',
  aggregate: {
    metric: 'count',
    field: 'status',
    groupBy: ['status'],
    includeFields: ['priority'],
  },
};

// ─── Tests ───────────────────────────────────────────────────────────────

describe('HybridSearchBuilder', () => {
  let builder: HybridSearchBuilder;
  let mockResolver: DynamicVocabularyResolver;
  let mockEmbedding: EmbeddingProvider;

  beforeEach(() => {
    mockResolver = createMockVocabularyResolver();
    mockEmbedding = createMockEmbeddingProvider();
    builder = new HybridSearchBuilder(mockResolver, mockEmbedding);
  });

  describe('constructor', () => {
    it('initializes with vocabulary resolver and embedding provider', () => {
      expect(builder).toBeDefined();
    });
  });

  describe('buildQuery - structured', () => {
    it('builds structured query with filters only', async () => {
      vi.mocked(mockResolver.resolve).mockResolvedValue({
        originalQuery: 'high priority bugs',
        resolutions: [mockFilterResolution],
        unresolvedSegments: ['bugs'],
      });

      const result = await builder.buildQuery({
        query: 'high priority bugs',
        queryType: 'structured',
        projectKbId: 'kb_123',
        tenantId: 'tenant_456',
        limit: 20,
        offset: 0,
      });

      expect(result.query.bool.filter).toBeDefined();
      // +1 for appId pre-filter (KB isolation)
      expect(result.query.bool.filter).toHaveLength(2);
      expect(result.query.bool.filter).toContainEqual({
        term: {
          'metadata.canonical.priority': 'high',
        },
      });
      expect(result.query.bool.filter).toContainEqual({
        term: { 'metadata.sys.appId': 'kb_123' },
      });
      expect(result.size).toBe(20);
      expect(result.from).toBe(0);
    });

    it('includes display fields in _source', async () => {
      vi.mocked(mockResolver.resolve).mockResolvedValue({
        originalQuery: 'show summary',
        resolutions: [mockDisplayResolution],
        unresolvedSegments: [],
      });

      const result = await builder.buildQuery({
        query: 'show summary',
        queryType: 'structured',
        projectKbId: 'kb_123',
        tenantId: 'tenant_456',
      });

      expect(result._source).toContain('metadata.summary');
      expect(result._source).toContain('metadata.description');
    });
  });

  describe('buildQuery - semantic', () => {
    it('builds semantic query with pure k-NN', async () => {
      vi.mocked(mockResolver.resolve).mockResolvedValue({
        originalQuery: 'login issues',
        resolutions: [],
        unresolvedSegments: ['login issues'],
      });

      const result = await builder.buildQuery({
        query: 'login issues',
        queryType: 'semantic',
        projectKbId: 'kb_123',
        tenantId: 'tenant_456',
        limit: 50,
      });

      expect(mockEmbedding.embed).toHaveBeenCalledWith('login issues');
      // Pure kNN vector search — no BM25, no bool wrapper
      expect(result.query.knn).toBeDefined();
      expect(result.query.knn.vector.vector).toHaveLength(1024);
      // k is over-fetched for HNSW exploration: Math.max(limit * 5, 200)
      expect(result.query.knn.vector.k).toBe(250);
      expect(result.size).toBe(50);
    });

    it('uses original query even when fully resolved to structured terms', async () => {
      vi.mocked(mockResolver.resolve).mockResolvedValue({
        originalQuery: 'high priority',
        resolutions: [mockFilterResolution],
        unresolvedSegments: [],
      });

      const result = await builder.buildQuery({
        query: 'high priority',
        queryType: 'semantic',
        projectKbId: 'kb_123',
        tenantId: 'tenant_456',
      });

      // Still uses original query for semantic search (better than empty query)
      expect(mockEmbedding.embed).toHaveBeenCalledWith('high priority');
      expect(result.query.knn).toBeDefined();
    });
  });

  describe('buildQuery - hybrid', () => {
    it('builds hybrid query with client-side RRF', async () => {
      vi.mocked(mockResolver.resolve).mockResolvedValue({
        originalQuery: 'high priority login issues',
        resolutions: [mockFilterResolution],
        unresolvedSegments: ['login issues'],
      });

      const result = await builder.buildQuery({
        query: 'high priority login issues',
        queryType: 'hybrid',
        projectKbId: 'kb_123',
        tenantId: 'tenant_456',
        limit: 20,
      });

      // Uses full original query for embedding (better relevance)
      expect(mockEmbedding.embed).toHaveBeenCalledWith('high priority login issues');
      // Client-side RRF: separate kNN and BM25 queries
      expect(result._clientSideRRF).toBe(true);
      expect(result._knnQuery).toBeDefined();
      expect(result._bm25Query).toBeDefined();
      // kNN sub-query uses Faiss native filter inside knn clause.
      // Hybrid search intentionally keeps k lower than semantic-only search:
      // Math.max(limit * 2, 100) balances HNSW traversal cost with RRF recall.
      expect(result._knnQuery.query.knn).toBeDefined();
      expect(result._knnQuery.query.knn.vector.k).toBe(100);

      // +1 for appId pre-filter (KB isolation)
      expect(result._knnQuery.query.knn.vector.filter.bool.filter).toHaveLength(2);
      expect(result._knnQuery.query.knn.vector.filter.bool.filter).toContainEqual({
        term: {
          'metadata.canonical.priority': 'high',
        },
      });
      expect(result._knnQuery.query.knn.vector.filter.bool.filter).toContainEqual({
        term: { 'metadata.sys.appId': 'kb_123' },
      });
      // BM25 sub-query has multi_match + filter
      expect(result._bm25Query.query.bool.must[0].multi_match).toBeDefined();
      // +1 for appId pre-filter (KB isolation)
      expect(result._bm25Query.query.bool.filter).toHaveLength(2);
      expect(result.size).toBe(20);
    });

    it('includes display fields in hybrid sub-queries', async () => {
      vi.mocked(mockResolver.resolve).mockResolvedValue({
        originalQuery: 'show summary of login issues',
        resolutions: [mockDisplayResolution],
        unresolvedSegments: ['login issues'],
      });

      const result = await builder.buildQuery({
        query: 'show summary of login issues',
        queryType: 'hybrid',
        projectKbId: 'kb_123',
        tenantId: 'tenant_456',
      });

      // Display fields are on sub-queries, not the top-level result
      expect(result._knnQuery._source).toContain('metadata.summary');
      expect(result._knnQuery._source).toContain('metadata.description');
      expect(result._bm25Query._source).toContain('metadata.summary');
      expect(result._bm25Query._source).toContain('metadata.description');
    });
  });

  describe('buildQuery - aggregation', () => {
    it('builds aggregation query with groupBy', async () => {
      vi.mocked(mockResolver.resolve).mockResolvedValue({
        originalQuery: 'count by status',
        resolutions: [mockAggregateResolution],
        unresolvedSegments: [],
      });

      const result = await builder.buildQuery({
        query: 'count by status',
        queryType: 'aggregation',
        projectKbId: 'kb_123',
        tenantId: 'tenant_456',
      });

      expect(result.aggs).toBeDefined();
      expect(result.aggs.by_status).toBeDefined();
      expect(result.aggs.by_status.terms.field).toBe('metadata.canonical.status');
      expect(result.size).toBe(0); // No documents, only aggregations
    });

    it('builds aggregation query with sum metric', async () => {
      const sumResolution: DynamicResolutionResult = {
        term: 'sum of story points',
        resolvedAs: 'aggregate',
        confidence: 0.9,
        reasoning: 'Sum story points',
        aggregate: {
          metric: 'sum',
          field: 'story_points',
          groupBy: ['status'],
          includeFields: [],
        },
      };

      vi.mocked(mockResolver.resolve).mockResolvedValue({
        originalQuery: 'sum of story points',
        resolutions: [sumResolution],
        unresolvedSegments: [],
      });

      const result = await builder.buildQuery({
        query: 'sum of story points',
        queryType: 'aggregation',
        projectKbId: 'kb_123',
        tenantId: 'tenant_456',
      });

      expect(result.aggs.by_status.aggs.metric_value).toBeDefined();
      expect(result.aggs.by_status.aggs.metric_value.sum).toBeDefined();
    });

    it('includes context fields in aggregation', async () => {
      vi.mocked(mockResolver.resolve).mockResolvedValue({
        originalQuery: 'count by status',
        resolutions: [mockAggregateResolution],
        unresolvedSegments: [],
      });

      const result = await builder.buildQuery({
        query: 'count by status',
        queryType: 'aggregation',
        projectKbId: 'kb_123',
        tenantId: 'tenant_456',
      });

      expect(result.aggs.by_status.aggs.context).toBeDefined();
      expect(result.aggs.by_status.aggs.context.top_hits._source).toContain('metadata.priority');
    });

    it('returns simple count query when no aggregation field found', async () => {
      vi.mocked(mockResolver.resolve).mockResolvedValue({
        originalQuery: 'high priority',
        resolutions: [mockFilterResolution],
        unresolvedSegments: [],
      });

      const result = await builder.buildQuery({
        query: 'high priority',
        queryType: 'aggregation',
        projectKbId: 'kb_123',
        tenantId: 'tenant_456',
      });

      // Falls back to a simple document count query (size: 0) with filters
      expect(result.size).toBe(0);
      expect(result.query.bool).toBeDefined();
    });
  });

  describe('original query preservation', () => {
    it('uses full original query for semantic search', async () => {
      vi.mocked(mockResolver.resolve).mockResolvedValue({
        originalQuery: 'high priority login issues',
        resolutions: [mockFilterResolution],
        unresolvedSegments: ['login issues'],
      });

      const result = await builder.buildQuery({
        query: 'high priority login issues',
        queryType: 'semantic',
        projectKbId: 'kb_123',
        tenantId: 'tenant_456',
      });

      // Semantic query should use FULL original query for better relevance
      expect(mockEmbedding.embed).toHaveBeenCalledWith('high priority login issues');
    });

    it('uses full original query even with extra spaces', async () => {
      const multiTermResolution: DynamicResolutionResult = {
        term: 'high',
        resolvedAs: 'filter',
        confidence: 0.95,
        reasoning: 'Filter by priority',
        filter: [
          {
            field: 'priority',
            operator: 'equals',
            value: 'high',
          },
        ],
      };

      vi.mocked(mockResolver.resolve).mockResolvedValue({
        originalQuery: 'high , , priority  login   issues',
        resolutions: [multiTermResolution],
        unresolvedSegments: ['priority login issues'],
      });

      const result = await builder.buildQuery({
        query: 'high , , priority  login   issues',
        queryType: 'semantic',
        projectKbId: 'kb_123',
        tenantId: 'tenant_456',
      });

      // Uses full original query as-is for maximum relevance
      expect(mockEmbedding.embed).toHaveBeenCalledWith('high , , priority  login   issues');
    });
  });

  describe('buildFilterClauses', () => {
    it('builds equals filter', async () => {
      const equalsResolution: DynamicResolutionResult = {
        term: 'status open',
        resolvedAs: 'filter',
        confidence: 0.95,
        reasoning: 'Filter by status',
        filter: [
          {
            field: 'status',
            operator: 'equals',
            value: 'open',
          },
        ],
      };

      vi.mocked(mockResolver.resolve).mockResolvedValue({
        originalQuery: 'status open',
        resolutions: [equalsResolution],
        unresolvedSegments: [],
      });

      const result = await builder.buildQuery({
        query: 'status open',
        queryType: 'structured',
        projectKbId: 'kb_123',
        tenantId: 'tenant_456',
      });

      expect(result.query.bool.filter[0]).toEqual({
        term: {
          'metadata.canonical.status': 'open',
        },
      });
    });

    it('builds contains filter', async () => {
      const containsResolution: DynamicResolutionResult = {
        term: 'summary contains login',
        resolvedAs: 'filter',
        confidence: 0.9,
        reasoning: 'Filter by summary containing text',
        filter: [
          {
            field: 'summary',
            operator: 'contains',
            value: 'login',
          },
        ],
      };

      vi.mocked(mockResolver.resolve).mockResolvedValue({
        originalQuery: 'summary contains login',
        resolutions: [containsResolution],
        unresolvedSegments: [],
      });

      const result = await builder.buildQuery({
        query: 'summary contains login',
        queryType: 'structured',
        projectKbId: 'kb_123',
        tenantId: 'tenant_456',
      });

      expect(result.query.bool.filter[0]).toEqual({
        wildcard: {
          'metadata.summary.keyword': {
            value: '*login*',
            case_insensitive: true,
          },
        },
      });
    });

    it('builds in filter', async () => {
      const inResolution: DynamicResolutionResult = {
        term: 'priority in high critical',
        resolvedAs: 'filter',
        confidence: 0.9,
        reasoning: 'Filter by multiple priorities',
        filter: [
          {
            field: 'priority',
            operator: 'in',
            value: ['high', 'critical'],
          },
        ],
      };

      vi.mocked(mockResolver.resolve).mockResolvedValue({
        originalQuery: 'priority in high critical',
        resolutions: [inResolution],
        unresolvedSegments: [],
      });

      const result = await builder.buildQuery({
        query: 'priority in high critical',
        queryType: 'structured',
        projectKbId: 'kb_123',
        tenantId: 'tenant_456',
      });

      expect(result.query.bool.filter[0]).toEqual({
        terms: {
          'metadata.canonical.priority': ['high', 'critical'],
        },
      });
    });

    it('builds greater than filter', async () => {
      const gtResolution: DynamicResolutionResult = {
        term: 'story points > 5',
        resolvedAs: 'filter',
        confidence: 0.9,
        reasoning: 'Filter by story points',
        filter: [
          {
            field: 'story_points',
            operator: 'gt',
            value: 5,
          },
        ],
      };

      vi.mocked(mockResolver.resolve).mockResolvedValue({
        originalQuery: 'story points > 5',
        resolutions: [gtResolution],
        unresolvedSegments: [],
      });

      const result = await builder.buildQuery({
        query: 'story points > 5',
        queryType: 'structured',
        projectKbId: 'kb_123',
        tenantId: 'tenant_456',
      });

      expect(result.query.bool.filter[0]).toEqual({
        range: {
          'metadata.canonical.story_points': { gt: 5 },
        },
      });
    });

    it('builds less than filter', async () => {
      const ltResolution: DynamicResolutionResult = {
        term: 'story points < 10',
        resolvedAs: 'filter',
        confidence: 0.9,
        reasoning: 'Filter by story points',
        filter: [
          {
            field: 'story_points',
            operator: 'lt',
            value: 10,
          },
        ],
      };

      vi.mocked(mockResolver.resolve).mockResolvedValue({
        originalQuery: 'story points < 10',
        resolutions: [ltResolution],
        unresolvedSegments: [],
      });

      const result = await builder.buildQuery({
        query: 'story points < 10',
        queryType: 'structured',
        projectKbId: 'kb_123',
        tenantId: 'tenant_456',
      });

      expect(result.query.bool.filter[0]).toEqual({
        range: {
          'metadata.canonical.story_points': { lt: 10 },
        },
      });
    });

    it('handles multiple filter conditions', async () => {
      const multiFilterResolution: DynamicResolutionResult = {
        term: 'high priority open status',
        resolvedAs: 'filter',
        confidence: 0.95,
        reasoning: 'Filter by priority and status',
        filter: [
          {
            field: 'priority',
            operator: 'equals',
            value: 'high',
          },
          {
            field: 'status',
            operator: 'equals',
            value: 'open',
          },
        ],
      };

      vi.mocked(mockResolver.resolve).mockResolvedValue({
        originalQuery: 'high priority open status',
        resolutions: [multiFilterResolution],
        unresolvedSegments: [],
      });

      const result = await builder.buildQuery({
        query: 'high priority open status',
        queryType: 'structured',
        projectKbId: 'kb_123',
        tenantId: 'tenant_456',
      });

      // 2 vocab filters + 1 appId pre-filter
      expect(result.query.bool.filter).toHaveLength(3);
    });
  });

  describe('extractAggregationMetric', () => {
    it('builds metric-only aggregations without grouping by the measure field', async () => {
      const sumResolution: DynamicResolutionResult = {
        term: 'sum of story points',
        resolvedAs: 'aggregate',
        confidence: 0.9,
        reasoning: 'Sum story points',
        aggregate: {
          metric: 'sum',
          field: 'story_points',
          groupBy: [],
          includeFields: [],
        },
      };

      vi.mocked(mockResolver.resolve).mockResolvedValue({
        originalQuery: 'sum of story points',
        resolutions: [sumResolution],
        unresolvedSegments: [],
      });

      const result = await builder.buildQuery({
        query: 'sum of story points',
        queryType: 'aggregation',
        projectKbId: 'kb_123',
        tenantId: 'tenant_456',
      });

      expect(result.aggs.total_value.sum).toEqual({
        field: 'metadata.story_points',
      });
      expect(result.aggs.by_story_points).toBeUndefined();
    });

    it('names grouped aggregations after the grouping field', async () => {
      const sumResolution: DynamicResolutionResult = {
        term: 'sum of story points by status',
        resolvedAs: 'aggregate',
        confidence: 0.9,
        reasoning: 'Sum story points grouped by status',
        aggregate: {
          metric: 'sum',
          field: 'story_points',
          groupBy: ['status'],
          includeFields: [],
        },
      };

      vi.mocked(mockResolver.resolve).mockResolvedValue({
        originalQuery: 'sum of story points by status',
        resolutions: [sumResolution],
        unresolvedSegments: [],
      });

      const result = await builder.buildQuery({
        query: 'sum of story points by status',
        queryType: 'aggregation',
        projectKbId: 'kb_123',
        tenantId: 'tenant_456',
      });

      expect(result.aggs.by_status.terms.field).toBe('metadata.canonical.status');
      expect(result.aggs.by_status.aggs.metric_value.sum).toEqual({
        field: 'metadata.story_points',
      });
      expect(result.aggs.by_story_points).toBeUndefined();
    });

    it('maps count_distinct to the OpenSearch cardinality aggregation', async () => {
      const distinctResolution: DynamicResolutionResult = {
        term: 'distinct story points',
        resolvedAs: 'aggregate',
        confidence: 0.9,
        reasoning: 'Count distinct story points',
        aggregate: {
          metric: 'count_distinct',
          field: 'story_points',
          groupBy: [],
          includeFields: [],
        },
      };

      vi.mocked(mockResolver.resolve).mockResolvedValue({
        originalQuery: 'distinct story points',
        resolutions: [distinctResolution],
        unresolvedSegments: [],
      });

      const result = await builder.buildQuery({
        query: 'distinct story points',
        queryType: 'aggregation',
        projectKbId: 'kb_123',
        tenantId: 'tenant_456',
      });

      expect(result.aggs.total_value.cardinality).toEqual({
        field: 'metadata.story_points',
      });
    });

    it('detects sum metric', async () => {
      const sumResolution: DynamicResolutionResult = {
        term: 'sum of story points',
        resolvedAs: 'aggregate',
        confidence: 0.9,
        reasoning: 'Sum story points',
        aggregate: {
          metric: 'sum',
          field: 'story_points',
          groupBy: ['status'],
          includeFields: [],
        },
      };

      vi.mocked(mockResolver.resolve).mockResolvedValue({
        originalQuery: 'sum of story points',
        resolutions: [sumResolution],
        unresolvedSegments: [],
      });

      const result = await builder.buildQuery({
        query: 'sum of story points',
        queryType: 'aggregation',
        projectKbId: 'kb_123',
        tenantId: 'tenant_456',
      });

      expect(result.aggs.by_status.aggs.metric_value.sum).toBeDefined();
    });

    it('detects avg metric', async () => {
      const avgResolution: DynamicResolutionResult = {
        term: 'average story points',
        resolvedAs: 'aggregate',
        confidence: 0.9,
        reasoning: 'Average story points',
        aggregate: {
          metric: 'avg',
          field: 'story_points',
          groupBy: ['status'],
          includeFields: [],
        },
      };

      vi.mocked(mockResolver.resolve).mockResolvedValue({
        originalQuery: 'average story points',
        resolutions: [avgResolution],
        unresolvedSegments: [],
      });

      const result = await builder.buildQuery({
        query: 'average story points',
        queryType: 'aggregation',
        projectKbId: 'kb_123',
        tenantId: 'tenant_456',
      });

      expect(result.aggs.by_status.aggs.metric_value.avg).toBeDefined();
    });

    it('detects min metric', async () => {
      const minResolution: DynamicResolutionResult = {
        term: 'minimum story points',
        resolvedAs: 'aggregate',
        confidence: 0.9,
        reasoning: 'Minimum story points',
        aggregate: {
          metric: 'min',
          field: 'story_points',
          groupBy: ['status'],
          includeFields: [],
        },
      };

      vi.mocked(mockResolver.resolve).mockResolvedValue({
        originalQuery: 'minimum story points',
        resolutions: [minResolution],
        unresolvedSegments: [],
      });

      const result = await builder.buildQuery({
        query: 'minimum story points',
        queryType: 'aggregation',
        projectKbId: 'kb_123',
        tenantId: 'tenant_456',
      });

      expect(result.aggs.by_status.aggs.metric_value.min).toBeDefined();
    });

    it('detects max metric', async () => {
      const maxResolution: DynamicResolutionResult = {
        term: 'maximum story points',
        resolvedAs: 'aggregate',
        confidence: 0.9,
        reasoning: 'Maximum story points',
        aggregate: {
          metric: 'max',
          field: 'story_points',
          groupBy: ['status'],
          includeFields: [],
        },
      };

      vi.mocked(mockResolver.resolve).mockResolvedValue({
        originalQuery: 'maximum story points',
        resolutions: [maxResolution],
        unresolvedSegments: [],
      });

      const result = await builder.buildQuery({
        query: 'maximum story points',
        queryType: 'aggregation',
        projectKbId: 'kb_123',
        tenantId: 'tenant_456',
      });

      expect(result.aggs.by_status.aggs.metric_value.max).toBeDefined();
    });

    it('defaults to count metric', async () => {
      vi.mocked(mockResolver.resolve).mockResolvedValue({
        originalQuery: 'count by status',
        resolutions: [mockAggregateResolution],
        unresolvedSegments: [],
      });

      const result = await builder.buildQuery({
        query: 'count by status',
        queryType: 'aggregation',
        projectKbId: 'kb_123',
        tenantId: 'tenant_456',
      });

      // Count metric doesn't have metric_value sub-aggregation
      expect(result.aggs.by_status.aggs?.metric_value).toBeUndefined();
    });
  });

  describe('query defaults', () => {
    it('uses default limit of 20', async () => {
      vi.mocked(mockResolver.resolve).mockResolvedValue({
        originalQuery: 'login issues',
        resolutions: [],
        unresolvedSegments: ['login issues'],
      });

      const result = await builder.buildQuery({
        query: 'login issues',
        queryType: 'semantic',
        projectKbId: 'kb_123',
        tenantId: 'tenant_456',
      });

      expect(result.size).toBe(20);
    });

    it('uses default offset of 0', async () => {
      vi.mocked(mockResolver.resolve).mockResolvedValue({
        originalQuery: 'login issues',
        resolutions: [],
        unresolvedSegments: ['login issues'],
      });

      const result = await builder.buildQuery({
        query: 'login issues',
        queryType: 'semantic',
        projectKbId: 'kb_123',
        tenantId: 'tenant_456',
      });

      expect(result.from).toBe(0);
    });
  });

  describe('error handling', () => {
    it('throws error for unknown query type', async () => {
      vi.mocked(mockResolver.resolve).mockResolvedValue({
        originalQuery: 'test query',
        resolutions: [],
        unresolvedSegments: [],
      });

      await expect(
        builder.buildQuery({
          query: 'test query',
          queryType: 'unknown' as any,
          projectKbId: 'kb_123',
          tenantId: 'tenant_456',
        }),
      ).rejects.toThrow('Unknown query type: unknown');
    });
  });

  describe('buildQueryFromResolution', () => {
    it('builds structured query from pre-resolved vocab without calling resolver', async () => {
      const vocabResult = {
        originalQuery: 'high priority bugs',
        resolutions: [mockFilterResolution],
      };

      const result = await builder.buildQueryFromResolution(vocabResult, 'structured', {
        projectKbId: 'kb_123',
        tenantId: 'tenant_456',
      });

      // Should NOT call the vocabulary resolver (pre-resolved)
      expect(mockResolver.resolve).not.toHaveBeenCalled();
      // Should build proper structured query with BM25 + filters
      expect(result.query.bool.must).toBeDefined();
      // +1 for appId pre-filter (KB isolation)
      expect(result.query.bool.filter).toHaveLength(2);
      expect(result.query.bool.filter).toContainEqual({
        term: { 'metadata.canonical.priority': 'high' },
      });
      expect(result.query.bool.filter).toContainEqual({
        term: { 'metadata.sys.appId': 'kb_123' },
      });
    });

    it('builds semantic query from pre-resolved vocab', async () => {
      const vocabResult = {
        originalQuery: 'login authentication issues',
        resolutions: [],
      };

      const result = await builder.buildQueryFromResolution(vocabResult, 'semantic');

      expect(mockResolver.resolve).not.toHaveBeenCalled();
      expect(mockEmbedding.embed).toHaveBeenCalledWith('login authentication issues');
      // Pure kNN — no bool wrapper
      expect(result.query.knn).toBeDefined();
    });

    it('builds hybrid query from pre-resolved vocab', async () => {
      const vocabResult = {
        originalQuery: 'high priority login issues',
        resolutions: [mockFilterResolution],
      };

      const result = await builder.buildQueryFromResolution(vocabResult, 'hybrid', {
        projectKbId: 'kb_123',
        tenantId: 'tenant_456',
      });

      expect(mockResolver.resolve).not.toHaveBeenCalled();
      expect(mockEmbedding.embed).toHaveBeenCalledWith('high priority login issues');
      // Client-side RRF with separate sub-queries
      expect(result._clientSideRRF).toBe(true);
      // kNN sub-query uses Faiss native filter inside the knn clause (not bool.must wrapper)
      expect(result._knnQuery.query.knn).toBeDefined();
      // +1 for appId pre-filter (KB isolation)
      expect(result._knnQuery.query.knn.vector.filter.bool.filter).toHaveLength(2);
    });

    it('builds aggregation query from pre-resolved vocab', async () => {
      const vocabResult = {
        originalQuery: 'count by status',
        resolutions: [mockAggregateResolution],
      };

      const result = await builder.buildQueryFromResolution(vocabResult, 'aggregation');

      expect(mockResolver.resolve).not.toHaveBeenCalled();
      expect(result.aggs).toBeDefined();
      expect(result.size).toBe(0);
    });

    it('passes limit and offset options', async () => {
      const vocabResult = {
        originalQuery: 'test query',
        resolutions: [],
      };

      const result = await builder.buildQueryFromResolution(vocabResult, 'semantic', {
        limit: 10,
        offset: 5,
      });

      expect(result.size).toBe(10);
      expect(result.from).toBe(5);
    });
  });
});
