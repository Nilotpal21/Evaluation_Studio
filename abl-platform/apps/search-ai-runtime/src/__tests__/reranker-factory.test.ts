/**
 * Multi-Provider Reranker Factory Tests (RFC-003)
 *
 * Tests for reranker factory with Voyage AI, Cohere, and Jina AI providers.
 * Tests circuit breaker, automatic fallback, and graceful degradation.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// =============================================================================
// MOCKS
// =============================================================================

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock environment variables
const originalEnv = process.env;

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import {
  RerankerFactory,
  VoyageReranker,
  CohereReranker,
  JinaReranker,
  type RerankRequest,
} from '../services/rerank/reranker-factory.js';

// =============================================================================
// TEST DATA
// =============================================================================

const MOCK_REQUEST: RerankRequest = {
  query: 'Python programming tutorial',
  documents: ['Python basics guide', 'JavaScript tutorial', 'Python advanced topics'],
};

const MOCK_VOYAGE_RESPONSE = {
  ok: true,
  status: 200,
  json: async () => ({
    data: [
      { index: 0, relevance_score: 0.95 },
      { index: 2, relevance_score: 0.87 },
      { index: 1, relevance_score: 0.23 },
    ],
  }),
  text: async () => '',
};

const MOCK_COHERE_RESPONSE = {
  ok: true,
  status: 200,
  json: async () => ({
    results: [
      { index: 0, relevance_score: 0.92 },
      { index: 2, relevance_score: 0.85 },
      { index: 1, relevance_score: 0.21 },
    ],
  }),
  text: async () => '',
};

const MOCK_JINA_RESPONSE = {
  ok: true,
  status: 200,
  json: async () => ({
    results: [
      { index: 0, relevance_score: 0.9 },
      { index: 2, relevance_score: 0.82 },
      { index: 1, relevance_score: 0.25 },
    ],
  }),
  text: async () => '',
};

// =============================================================================
// TESTS
// =============================================================================

describe('RerankerFactory (RFC-003)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset environment for each test
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  // ─── Voyage AI Provider ───────────────────────────────────────────────────

  describe('VoyageReranker', () => {
    test('reranks documents successfully', async () => {
      mockFetch.mockResolvedValue(MOCK_VOYAGE_RESPONSE);

      const reranker = new VoyageReranker({ apiKey: 'test-key' });
      const result = await reranker.rerank(MOCK_REQUEST);

      expect(result.provider).toBe('voyage');
      expect(result.results).toHaveLength(3);
      expect(result.results[0].index).toBe(0);
      expect(result.results[0].score).toBe(0.95);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.cost).toBeCloseTo(0.0015); // 3 docs * $0.50 per 1K
    });

    test('uses correct API endpoint and headers', async () => {
      mockFetch.mockResolvedValue(MOCK_VOYAGE_RESPONSE);

      const reranker = new VoyageReranker({ apiKey: 'voyage-key-123' });
      await reranker.rerank(MOCK_REQUEST);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.voyageai.com/v1/rerank',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer voyage-key-123',
            'Content-Type': 'application/json',
          }),
        }),
      );
    });

    test('uses custom model if provided', async () => {
      mockFetch.mockResolvedValue(MOCK_VOYAGE_RESPONSE);

      const reranker = new VoyageReranker({ apiKey: 'test-key', model: 'rerank-lite-1' });
      await reranker.rerank(MOCK_REQUEST);

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.model).toBe('rerank-lite-1');
    });

    test('handles API errors', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Invalid API key',
      });

      const reranker = new VoyageReranker({ apiKey: 'bad-key' });

      await expect(reranker.rerank(MOCK_REQUEST)).rejects.toThrow('Voyage API error [401]');
    });

    test('handles timeout', async () => {
      // Mock AbortError for timeout
      mockFetch.mockImplementation(() => {
        const error: any = new Error('The operation was aborted');
        error.name = 'AbortError';
        return Promise.reject(error);
      });

      const reranker = new VoyageReranker({ apiKey: 'test-key', timeoutMs: 100 });

      await expect(reranker.rerank(MOCK_REQUEST)).rejects.toThrow('timeout');
    });

    test('health check returns ok when API is healthy', async () => {
      mockFetch.mockResolvedValue(MOCK_VOYAGE_RESPONSE);

      const reranker = new VoyageReranker({ apiKey: 'test-key' });
      const health = await reranker.healthCheck();

      expect(health.ok).toBe(true);
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
      expect(health.error).toBeUndefined();
    });

    test('health check returns error when API fails', async () => {
      mockFetch.mockRejectedValue(new Error('Connection refused'));

      const reranker = new VoyageReranker({ apiKey: 'test-key' });
      const health = await reranker.healthCheck();

      expect(health.ok).toBe(false);
      expect(health.error).toContain('Connection refused');
    });
  });

  // ─── Cohere Provider ──────────────────────────────────────────────────────

  describe('CohereReranker', () => {
    test('reranks documents successfully', async () => {
      mockFetch.mockResolvedValue(MOCK_COHERE_RESPONSE);

      const reranker = new CohereReranker({ apiKey: 'test-key' });
      const result = await reranker.rerank(MOCK_REQUEST);

      expect(result.provider).toBe('cohere');
      expect(result.results).toHaveLength(3);
      expect(result.results[0].score).toBe(0.92);
      expect(result.cost).toBeCloseTo(0.006); // 3 docs * $2.00 per 1K
    });

    test('uses correct API endpoint', async () => {
      mockFetch.mockResolvedValue(MOCK_COHERE_RESPONSE);

      const reranker = new CohereReranker({ apiKey: 'cohere-key-456' });
      await reranker.rerank(MOCK_REQUEST);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.cohere.ai/v1/rerank',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer cohere-key-456',
          }),
        }),
      );
    });

    test('defaults to rerank-english-v3.0 model', async () => {
      mockFetch.mockResolvedValue(MOCK_COHERE_RESPONSE);

      const reranker = new CohereReranker({ apiKey: 'test-key' });
      await reranker.rerank(MOCK_REQUEST);

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.model).toBe('rerank-english-v3.0');
    });
  });

  // ─── Jina AI Provider ─────────────────────────────────────────────────────

  describe('JinaReranker', () => {
    test('reranks documents successfully', async () => {
      mockFetch.mockResolvedValue(MOCK_JINA_RESPONSE);

      const reranker = new JinaReranker({ apiKey: 'test-key' });
      const result = await reranker.rerank(MOCK_REQUEST);

      expect(result.provider).toBe('jina');
      expect(result.results).toHaveLength(3);
      expect(result.cost).toBeCloseTo(0.003); // 3 docs * $1.00 per 1K
    });

    test('formats documents as {index, text} objects', async () => {
      mockFetch.mockResolvedValue(MOCK_JINA_RESPONSE);

      const reranker = new JinaReranker({ apiKey: 'test-key' });
      await reranker.rerank(MOCK_REQUEST);

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.documents).toEqual([
        { index: 0, text: 'Python basics guide' },
        { index: 1, text: 'JavaScript tutorial' },
        { index: 2, text: 'Python advanced topics' },
      ]);
    });
  });

  // ─── Factory with Automatic Fallback ──────────────────────────────────────

  describe('RerankerFactory - Automatic Fallback', () => {
    test('uses primary provider (Voyage) when available', async () => {
      process.env.VOYAGE_API_KEY = 'voyage-key';
      process.env.COHERE_API_KEY = 'cohere-key';

      mockFetch.mockResolvedValue(MOCK_VOYAGE_RESPONSE);

      const factory = new RerankerFactory();
      const result = await factory.rerank(MOCK_REQUEST);

      expect(result).not.toBeNull();
      expect(result!.provider).toBe('voyage');
    });

    test('falls back to Cohere when Voyage fails', async () => {
      process.env.VOYAGE_API_KEY = 'voyage-key';
      process.env.COHERE_API_KEY = 'cohere-key';

      // Voyage fails, Cohere succeeds
      mockFetch
        .mockRejectedValueOnce(new Error('Voyage API error'))
        .mockResolvedValueOnce(MOCK_COHERE_RESPONSE);

      const factory = new RerankerFactory();
      const result = await factory.rerank(MOCK_REQUEST);

      expect(result).not.toBeNull();
      expect(result!.provider).toBe('cohere');
    });

    test('falls back to Jina when Voyage and Cohere fail', async () => {
      process.env.VOYAGE_API_KEY = 'voyage-key';
      process.env.COHERE_API_KEY = 'cohere-key';
      process.env.JINA_API_KEY = 'jina-key';

      // Voyage and Cohere fail, Jina succeeds
      mockFetch
        .mockRejectedValueOnce(new Error('Voyage error'))
        .mockRejectedValueOnce(new Error('Cohere error'))
        .mockResolvedValueOnce(MOCK_JINA_RESPONSE);

      const factory = new RerankerFactory();
      const result = await factory.rerank(MOCK_REQUEST);

      expect(result).not.toBeNull();
      expect(result!.provider).toBe('jina');
    });

    test('returns null when all providers fail', async () => {
      process.env.VOYAGE_API_KEY = 'voyage-key';
      process.env.COHERE_API_KEY = 'cohere-key';

      mockFetch.mockRejectedValue(new Error('All APIs down'));

      const factory = new RerankerFactory();
      const result = await factory.rerank(MOCK_REQUEST);

      expect(result).toBeNull(); // Graceful degradation
    });

    test('returns null when no providers configured', async () => {
      // No API keys set
      delete process.env.VOYAGE_API_KEY;
      delete process.env.COHERE_API_KEY;
      delete process.env.JINA_API_KEY;

      const factory = new RerankerFactory();
      const result = await factory.rerank(MOCK_REQUEST);

      expect(result).toBeNull();
      expect(factory.isAvailable()).toBe(false);
    });
  });

  // ─── Circuit Breaker ──────────────────────────────────────────────────────

  describe('RerankerFactory - Circuit Breaker', () => {
    test('opens circuit after 3 consecutive failures', async () => {
      process.env.VOYAGE_API_KEY = 'voyage-key';
      process.env.COHERE_API_KEY = 'cohere-key';

      const factory = new RerankerFactory();

      // First 3 failures - Voyage tries, Cohere succeeds
      for (let i = 0; i < 3; i++) {
        mockFetch
          .mockRejectedValueOnce(new Error('Voyage error'))
          .mockResolvedValueOnce(MOCK_COHERE_RESPONSE);

        const result = await factory.rerank(MOCK_REQUEST);
        expect(result!.provider).toBe('cohere');
      }

      // 4th request - Voyage circuit should be open, skip directly to Cohere
      mockFetch.mockResolvedValueOnce(MOCK_COHERE_RESPONSE);

      const result = await factory.rerank(MOCK_REQUEST);
      expect(result!.provider).toBe('cohere');

      // Voyage should have been called 3 times (before circuit opened)
      // Cohere should have been called 4 times
      const voyageCalls = mockFetch.mock.calls.filter((call) =>
        call[0].includes('voyageai'),
      ).length;
      expect(voyageCalls).toBe(3); // Not 4, because circuit opened
    });

    test('resets circuit on successful request', async () => {
      process.env.VOYAGE_API_KEY = 'voyage-key';

      const factory = new RerankerFactory();

      // 2 failures
      mockFetch.mockRejectedValueOnce(new Error('Error 1'));
      await factory.rerank(MOCK_REQUEST);

      mockFetch.mockRejectedValueOnce(new Error('Error 2'));
      await factory.rerank(MOCK_REQUEST);

      // Success - should reset counter
      mockFetch.mockResolvedValueOnce(MOCK_VOYAGE_RESPONSE);
      const result = await factory.rerank(MOCK_REQUEST);
      expect(result!.provider).toBe('voyage');

      // 2 more failures - circuit should NOT be open yet
      mockFetch.mockRejectedValueOnce(new Error('Error 3'));
      await factory.rerank(MOCK_REQUEST);

      mockFetch.mockRejectedValueOnce(new Error('Error 4'));
      await factory.rerank(MOCK_REQUEST);

      // Voyage should still be tried (circuit not open, counter was reset)
      mockFetch.mockRejectedValueOnce(new Error('Error 5'));
      await factory.rerank(MOCK_REQUEST);

      const voyageCalls = mockFetch.mock.calls.length;
      expect(voyageCalls).toBeGreaterThan(0);
    });
  });

  // ─── Health Checks ────────────────────────────────────────────────────────

  describe('RerankerFactory - Health Checks', () => {
    test('returns status for all providers', async () => {
      process.env.VOYAGE_API_KEY = 'voyage-key';
      process.env.COHERE_API_KEY = 'cohere-key';

      mockFetch
        .mockResolvedValueOnce(MOCK_VOYAGE_RESPONSE) // Voyage health check
        .mockResolvedValueOnce(MOCK_COHERE_RESPONSE); // Cohere health check

      const factory = new RerankerFactory();
      const status = await factory.getStatus();

      expect(status).toHaveLength(2);
      expect(status[0].name).toBe('voyage');
      expect(status[0].healthy).toBe(true);
      expect(status[1].name).toBe('cohere');
      expect(status[1].healthy).toBe(true);
    });

    test('marks unhealthy providers', async () => {
      process.env.VOYAGE_API_KEY = 'voyage-key';
      process.env.COHERE_API_KEY = 'cohere-key';

      mockFetch
        .mockRejectedValueOnce(new Error('Voyage down')) // Voyage health check
        .mockResolvedValueOnce(MOCK_COHERE_RESPONSE); // Cohere health check

      const factory = new RerankerFactory();
      const status = await factory.getStatus();

      expect(status[0].healthy).toBe(false);
      expect(status[0].error).toBeDefined();
      expect(status[1].healthy).toBe(true);
    });

    test('shows circuit breaker status', async () => {
      process.env.VOYAGE_API_KEY = 'voyage-key';

      const factory = new RerankerFactory();

      // Trigger 3 failures to open circuit
      for (let i = 0; i < 3; i++) {
        mockFetch.mockRejectedValueOnce(new Error('Error'));
        await factory.rerank(MOCK_REQUEST);
      }

      mockFetch.mockResolvedValueOnce(MOCK_VOYAGE_RESPONSE); // Health check

      const status = await factory.getStatus();
      expect(status[0].circuitOpen).toBe(true);
    });
  });

  // ─── Cost Tracking ────────────────────────────────────────────────────────

  describe('Cost Tracking', () => {
    test('tracks cost for Voyage (cheapest)', async () => {
      mockFetch.mockResolvedValue(MOCK_VOYAGE_RESPONSE);

      const reranker = new VoyageReranker({ apiKey: 'test-key' });
      const result = await reranker.rerank({
        query: 'test',
        documents: Array(1000).fill('doc'), // 1000 docs
      });

      expect(result.cost).toBeCloseTo(0.5); // $0.50 for 1K docs
    });

    test('tracks cost for Cohere (most expensive)', async () => {
      mockFetch.mockResolvedValue(MOCK_COHERE_RESPONSE);

      const reranker = new CohereReranker({ apiKey: 'test-key' });
      const result = await reranker.rerank({
        query: 'test',
        documents: Array(1000).fill('doc'),
      });

      expect(result.cost).toBeCloseTo(2.0); // $2.00 for 1K docs
    });

    test('tracks cost for Jina (mid-range)', async () => {
      mockFetch.mockResolvedValue(MOCK_JINA_RESPONSE);

      const reranker = new JinaReranker({ apiKey: 'test-key' });
      const result = await reranker.rerank({
        query: 'test',
        documents: Array(1000).fill('doc'),
      });

      expect(result.cost).toBeCloseTo(1.0); // $1.00 for 1K docs
    });
  });

  // ─── Top-N Filtering ──────────────────────────────────────────────────────

  describe('Top-N Filtering', () => {
    test('respects topN parameter', async () => {
      mockFetch.mockResolvedValue(MOCK_VOYAGE_RESPONSE);

      const reranker = new VoyageReranker({ apiKey: 'test-key' });
      await reranker.rerank({
        query: 'test',
        documents: ['doc1', 'doc2', 'doc3', 'doc4', 'doc5'],
        topN: 3,
      });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.top_k).toBe(3);
    });

    test('defaults to all documents if topN not specified', async () => {
      mockFetch.mockResolvedValue(MOCK_VOYAGE_RESPONSE);

      const reranker = new VoyageReranker({ apiKey: 'test-key' });
      const docs = ['doc1', 'doc2', 'doc3'];
      await reranker.rerank({ query: 'test', documents: docs });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.top_k).toBe(3); // Same as documents.length
    });
  });
});
