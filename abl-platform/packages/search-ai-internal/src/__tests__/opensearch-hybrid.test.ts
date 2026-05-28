/**
 * OpenSearch Hybrid Search Tests (RFC-003)
 *
 * Tests for hybrid search implementation combining vector similarity
 * and BM25 keyword matching with RRF/RSF score fusion.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Client } from '@opensearch-project/opensearch';

// =============================================================================
// MOCKS
// =============================================================================

// Mock OpenSearch client - must be before imports
const mockSearch = vi.fn();
const mockInfo = vi.fn();
const mockClient = {
  search: mockSearch,
  info: mockInfo,
};

vi.mock('@opensearch-project/opensearch', () => {
  // Create a mock constructor that returns mockClient
  class MockClient {
    search = mockSearch;
    info = mockInfo;
  }
  return {
    Client: MockClient,
  };
});

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import { OpenSearchVectorStore } from '../vector-store/opensearch.js';
import type { HybridSearchParams } from '../vector-store/interface.js';

// =============================================================================
// TEST DATA
// =============================================================================

const MOCK_VECTOR = Array(1024).fill(0.1);

const MOCK_OPENSEARCH_CONFIG = {
  url: 'http://localhost:9200',
  apiKey: 'test-key',
};

const MOCK_HYBRID_RESPONSE_RRF = {
  body: {
    hits: {
      hits: [
        {
          _id: 'doc1',
          _score: 0.95,
          _source: {
            vector: MOCK_VECTOR,
            content: 'Python programming tutorial for beginners',
            metadata: { title: 'Python Basics', category: 'tutorial' },
          },
        },
        {
          _id: 'doc2',
          _score: 0.87,
          _source: {
            vector: MOCK_VECTOR,
            content: 'Advanced Python data science guide',
            metadata: { title: 'Python DS', category: 'advanced' },
          },
        },
        {
          _id: 'doc3',
          _score: 0.72,
          _source: {
            vector: MOCK_VECTOR,
            content: 'JavaScript web development basics',
            metadata: { title: 'JS Basics', category: 'tutorial' },
          },
        },
      ],
    },
  },
};

const MOCK_VECTOR_RESPONSE = {
  body: {
    hits: {
      hits: [
        {
          _id: 'doc1',
          _score: 0.92,
          _source: {
            vector: MOCK_VECTOR,
            content: 'Python programming tutorial',
            metadata: { title: 'Python Basics' },
          },
        },
        {
          _id: 'doc2',
          _score: 0.85,
          _source: {
            vector: MOCK_VECTOR,
            content: 'Python data science',
            metadata: { title: 'Python DS' },
          },
        },
      ],
    },
  },
};

const MOCK_BM25_RESPONSE = {
  body: {
    hits: {
      hits: [
        {
          _id: 'doc1',
          _score: 12.5,
          _source: {
            content: 'Python programming tutorial',
            metadata: { title: 'Python Basics' },
          },
        },
        {
          _id: 'doc3',
          _score: 8.3,
          _source: {
            content: 'Python guide for developers',
            metadata: { title: 'Python Guide' },
          },
        },
      ],
    },
  },
};

// =============================================================================
// TESTS
// =============================================================================

describe('OpenSearchVectorStore - Hybrid Search (RFC-003)', () => {
  let store: OpenSearchVectorStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new OpenSearchVectorStore(MOCK_OPENSEARCH_CONFIG);

    // Default: OpenSearch 2.11.0 (supports native hybrid)
    mockInfo.mockResolvedValue({
      body: {
        version: {
          number: '2.11.0',
        },
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── Native RRF Hybrid Search ─────────────────────────────────────────────

  describe('RRF (Reciprocal Rank Fusion) - Native OpenSearch', () => {
    test('executes native hybrid query with RRF fusion', async () => {
      mockSearch.mockResolvedValue(MOCK_HYBRID_RESPONSE_RRF);

      const params: HybridSearchParams = {
        vector: MOCK_VECTOR,
        queryText: 'Python programming',
        topK: 10,
        fusion: {
          method: 'rrf',
          rankConstant: 60,
        },
      };

      const results = await store.hybridSearch('test-index', params);

      // Verify native hybrid query was called
      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          index: 'test-index',
          body: expect.objectContaining({
            query: expect.objectContaining({
              hybrid: expect.objectContaining({
                queries: expect.arrayContaining([
                  expect.objectContaining({ knn: expect.any(Object) }),
                  expect.objectContaining({ multi_match: expect.any(Object) }),
                ]),
              }),
            }),
            rank: {
              rrf: {
                window_size: 20, // topK * 2
                rank_constant: 60,
              },
            },
          }),
        }),
      );

      // Verify results
      expect(results).toHaveLength(3);
      expect(results[0].id).toBe('doc1');
      expect(results[0].score).toBe(0.95);
      expect(results[0].content).toContain('Python');
    });

    test('uses default rank constant if not specified', async () => {
      mockSearch.mockResolvedValue(MOCK_HYBRID_RESPONSE_RRF);

      const params: HybridSearchParams = {
        vector: MOCK_VECTOR,
        queryText: 'Python',
        topK: 10,
        fusion: {
          method: 'rrf',
          // rankConstant not specified, should default to 60
        },
      };

      await store.hybridSearch('test-index', params);

      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            rank: {
              rrf: {
                window_size: 20,
                rank_constant: 60, // ← Default
              },
            },
          }),
        }),
      );
    });

    test('applies metadata filters to hybrid query', async () => {
      mockSearch.mockResolvedValue(MOCK_HYBRID_RESPONSE_RRF);

      const params: HybridSearchParams = {
        vector: MOCK_VECTOR,
        queryText: 'Python',
        topK: 10,
        filters: [{ field: 'category', operator: 'eq', value: 'tutorial' }],
        fusion: { method: 'rrf' },
      };

      await store.hybridSearch('test-index', params);

      const callArgs = mockSearch.mock.calls[0][0];
      const queries = callArgs.body.query.hybrid.queries;

      // Should have 3 queries: knn, multi_match, and filter
      expect(queries).toHaveLength(3);
      expect(queries[2]).toHaveProperty('bool');
    });

    test('boosts title field higher than content', async () => {
      mockSearch.mockResolvedValue(MOCK_HYBRID_RESPONSE_RRF);

      const params: HybridSearchParams = {
        vector: MOCK_VECTOR,
        queryText: 'Python',
        topK: 10,
        fusion: { method: 'rrf' },
      };

      await store.hybridSearch('test-index', params);

      const callArgs = mockSearch.mock.calls[0][0];
      const multiMatch = callArgs.body.query.hybrid.queries[1].multi_match;

      // Title should be boosted higher (^3) than content (^2)
      expect(multiMatch.fields).toContain('metadata.title^3');
      expect(multiMatch.fields).toContain('content^2');
    });

    test('respects includeMetadata and includeVectors params', async () => {
      mockSearch.mockResolvedValue(MOCK_HYBRID_RESPONSE_RRF);

      const paramsWithMeta: HybridSearchParams = {
        vector: MOCK_VECTOR,
        queryText: 'test',
        topK: 5,
        includeMetadata: true,
        includeVectors: true,
        fusion: { method: 'rrf' },
      };

      const results = await store.hybridSearch('test-index', paramsWithMeta);

      expect(results[0].metadata).toBeDefined();
      expect(results[0].vector).toBeDefined();

      // Test with metadata disabled
      const paramsNoMeta: HybridSearchParams = {
        vector: MOCK_VECTOR,
        queryText: 'test',
        topK: 5,
        includeMetadata: false,
        includeVectors: false,
        fusion: { method: 'rrf' },
      };

      const resultsNoMeta = await store.hybridSearch('test-index', paramsNoMeta);

      expect(resultsNoMeta[0].metadata).toBeUndefined();
      expect(resultsNoMeta[0].vector).toBeUndefined();
    });
  });

  // ─── RSF (Relative Score Fusion) - Client-Side ───────────────────────────

  describe('RSF (Relative Score Fusion) - Client-Side', () => {
    test('executes client-side RSF with vector + BM25 queries', async () => {
      mockSearch
        .mockResolvedValueOnce(MOCK_VECTOR_RESPONSE) // Vector search
        .mockResolvedValueOnce(MOCK_BM25_RESPONSE); // BM25 search

      const params: HybridSearchParams = {
        vector: MOCK_VECTOR,
        queryText: 'Python programming',
        topK: 10,
        fusion: {
          method: 'rsf',
          alpha: 0.7, // 70% vector, 30% keyword
        },
      };

      const results = await store.hybridSearch('test-index', params);

      // Should have called search twice (vector + BM25)
      expect(mockSearch).toHaveBeenCalledTimes(2);

      // Results should be fused and sorted by combined score
      expect(results).toBeDefined();
      expect(results.length).toBeGreaterThan(0);
    });

    test('uses default alpha of 0.7 if not specified', async () => {
      mockSearch
        .mockResolvedValueOnce(MOCK_VECTOR_RESPONSE)
        .mockResolvedValueOnce(MOCK_BM25_RESPONSE);

      const params: HybridSearchParams = {
        vector: MOCK_VECTOR,
        queryText: 'Python',
        topK: 10,
        fusion: {
          method: 'rsf',
          // alpha not specified, should default to 0.7
        },
      };

      const results = await store.hybridSearch('test-index', params);

      // Should still work with default alpha
      expect(results).toBeDefined();
    });

    test('normalizes scores correctly', async () => {
      // Vector results with scores [0.92, 0.85]
      // BM25 results with scores [12.5, 8.3]
      mockSearch
        .mockResolvedValueOnce(MOCK_VECTOR_RESPONSE)
        .mockResolvedValueOnce(MOCK_BM25_RESPONSE);

      const params: HybridSearchParams = {
        vector: MOCK_VECTOR,
        queryText: 'Python',
        topK: 10,
        fusion: {
          method: 'rsf',
          alpha: 0.7,
        },
      };

      const results = await store.hybridSearch('test-index', params);

      // Scores should be normalized and fused
      expect(results[0].score).toBeGreaterThan(0);
      expect(results[0].score).toBeLessThanOrEqual(1);
    });

    test('handles documents that appear in only one result set', async () => {
      mockSearch
        .mockResolvedValueOnce(MOCK_VECTOR_RESPONSE) // Has doc1, doc2
        .mockResolvedValueOnce(MOCK_BM25_RESPONSE); // Has doc1, doc3

      const params: HybridSearchParams = {
        vector: MOCK_VECTOR,
        queryText: 'Python',
        topK: 10,
        fusion: {
          method: 'rsf',
          alpha: 0.7,
        },
      };

      const results = await store.hybridSearch('test-index', params);

      // Should handle doc2 (only in vector) and doc3 (only in BM25)
      expect(results).toBeDefined();
      expect(results.length).toBeGreaterThan(0);
    });
  });

  // ─── Version Detection & Fallback ─────────────────────────────────────────

  describe('Version Detection & Fallback', () => {
    test('uses native RRF for OpenSearch 2.11+', async () => {
      mockInfo.mockResolvedValue({
        body: { version: { number: '2.11.0' } },
      });
      mockSearch.mockResolvedValue(MOCK_HYBRID_RESPONSE_RRF);

      const params: HybridSearchParams = {
        vector: MOCK_VECTOR,
        queryText: 'test',
        topK: 10,
        fusion: { method: 'rrf' },
      };

      await store.hybridSearch('test-index', params);

      // Should call search once (native hybrid)
      expect(mockSearch).toHaveBeenCalledTimes(1);

      // Should use hybrid query structure
      const callArgs = mockSearch.mock.calls[0][0];
      expect(callArgs.body.query).toHaveProperty('hybrid');
    });

    test('falls back to client-side RSF for OpenSearch < 2.11', async () => {
      mockInfo.mockResolvedValue({
        body: { version: { number: '2.10.0' } }, // ← Old version
      });
      mockSearch
        .mockResolvedValueOnce(MOCK_VECTOR_RESPONSE)
        .mockResolvedValueOnce(MOCK_BM25_RESPONSE);

      const params: HybridSearchParams = {
        vector: MOCK_VECTOR,
        queryText: 'test',
        topK: 10,
        fusion: { method: 'rrf' }, // Requested RRF
      };

      await store.hybridSearch('test-index', params);

      // Should call search twice (fallback to client-side)
      expect(mockSearch).toHaveBeenCalledTimes(2);
    });

    test('handles version check failure gracefully', async () => {
      mockInfo.mockRejectedValue(new Error('Connection refused'));
      mockSearch
        .mockResolvedValueOnce(MOCK_VECTOR_RESPONSE)
        .mockResolvedValueOnce(MOCK_BM25_RESPONSE);

      const params: HybridSearchParams = {
        vector: MOCK_VECTOR,
        queryText: 'test',
        topK: 10,
        fusion: { method: 'rrf' },
      };

      // Should not throw
      await expect(store.hybridSearch('test-index', params)).resolves.toBeDefined();

      // Should fall back to client-side (2 searches)
      expect(mockSearch).toHaveBeenCalledTimes(2);
    });
  });

  // ─── Default Fusion Method ────────────────────────────────────────────────

  describe('Default Fusion Method', () => {
    test('defaults to RRF when fusion not specified', async () => {
      mockSearch.mockResolvedValue(MOCK_HYBRID_RESPONSE_RRF);

      const params: HybridSearchParams = {
        vector: MOCK_VECTOR,
        queryText: 'test',
        topK: 10,
        // fusion not specified, should default to RRF
      };

      await store.hybridSearch('test-index', params);

      // Should use native RRF (1 call)
      expect(mockSearch).toHaveBeenCalledTimes(1);

      const callArgs = mockSearch.mock.calls[0][0];
      expect(callArgs.body.query).toHaveProperty('hybrid');
      expect(callArgs.body.rank).toHaveProperty('rrf');
    });
  });

  // ─── Error Handling ───────────────────────────────────────────────────────

  describe('Error Handling', () => {
    test('throws error on search failure', async () => {
      mockSearch.mockRejectedValue(new Error('OpenSearch unavailable'));

      const params: HybridSearchParams = {
        vector: MOCK_VECTOR,
        queryText: 'test',
        topK: 10,
        fusion: { method: 'rrf' },
      };

      await expect(store.hybridSearch('test-index', params)).rejects.toThrow(
        'OpenSearch unavailable',
      );
    });

    test('handles empty results gracefully', async () => {
      mockSearch.mockResolvedValue({
        body: {
          hits: {
            hits: [],
          },
        },
      });

      const params: HybridSearchParams = {
        vector: MOCK_VECTOR,
        queryText: 'nonexistent query',
        topK: 10,
        fusion: { method: 'rrf' },
      };

      const results = await store.hybridSearch('test-index', params);

      expect(results).toEqual([]);
    });
  });

  // ─── Integration Scenarios ────────────────────────────────────────────────

  describe('Integration Scenarios', () => {
    test('scenario: code search with keyword boost', async () => {
      mockSearch.mockResolvedValue(MOCK_HYBRID_RESPONSE_RRF);

      const params: HybridSearchParams = {
        vector: MOCK_VECTOR,
        queryText: 'Python async await tutorial',
        topK: 10,
        filters: [{ field: 'language', operator: 'eq', value: 'python' }],
        fusion: {
          method: 'rsf',
          alpha: 0.5, // 50/50 vector and keyword for code search
        },
      };

      mockSearch
        .mockResolvedValueOnce(MOCK_VECTOR_RESPONSE)
        .mockResolvedValueOnce(MOCK_BM25_RESPONSE);

      const results = await store.hybridSearch('code-index', params);

      expect(results).toBeDefined();
      expect(mockSearch).toHaveBeenCalledTimes(2);
    });

    test('scenario: documentation search with high semantic weight', async () => {
      mockSearch.mockResolvedValue(MOCK_HYBRID_RESPONSE_RRF);

      const params: HybridSearchParams = {
        vector: MOCK_VECTOR,
        queryText: 'How to configure environment variables?',
        topK: 10,
        fusion: {
          method: 'rsf',
          alpha: 0.9, // 90% semantic for natural language questions
        },
      };

      mockSearch
        .mockResolvedValueOnce(MOCK_VECTOR_RESPONSE)
        .mockResolvedValueOnce(MOCK_BM25_RESPONSE);

      const results = await store.hybridSearch('docs-index', params);

      expect(results).toBeDefined();
    });
  });
});
