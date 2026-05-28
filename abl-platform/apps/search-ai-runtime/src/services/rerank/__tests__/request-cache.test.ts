/**
 * Request Cache Tests (RFC-003 Phase 2.3)
 *
 * Tests tenant-scoped caching with TTL, collision detection, and cleanup.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RequestCache } from '../request-cache.js';
import type { RerankResponse } from '../reranker-factory.js';

describe('RequestCache', () => {
  let cache: RequestCache;
  const mockResponse: RerankResponse = {
    results: [{ index: 0, score: 0.95 }],
    provider: 'voyage',
    model: 'rerank-1',
    latencyMs: 50,
    cost: 0.01,
  };

  beforeEach(() => {
    cache = new RequestCache({
      deduplicationTTL: 5000,
      cacheMaxSize: 100,
    });
  });

  describe('Tenant Isolation', () => {
    it('should isolate cache entries by tenant', () => {
      const query = 'test query';
      const documents = ['doc1', 'doc2'];

      // Store for tenant A
      cache.set('tenant-a', 'index-1', query, documents, mockResponse);

      // Should not retrieve for tenant B (same index, query, docs)
      const resultB = cache.get('tenant-b', 'index-1', query, documents);
      expect(resultB).toBeNull();

      // Should retrieve for tenant A
      const resultA = cache.get('tenant-a', 'index-1', query, documents);
      expect(resultA).toEqual(mockResponse);
    });

    it('should isolate cache entries by index', () => {
      const query = 'test query';
      const documents = ['doc1', 'doc2'];

      // Store for index-1
      cache.set('tenant-a', 'index-1', query, documents, mockResponse);

      // Should not retrieve for index-2 (same tenant, query, docs)
      const resultIndex2 = cache.get('tenant-a', 'index-2', query, documents);
      expect(resultIndex2).toBeNull();

      // Should retrieve for index-1
      const resultIndex1 = cache.get('tenant-a', 'index-1', query, documents);
      expect(resultIndex1).toEqual(mockResponse);
    });

    it('should detect and handle cache key collisions', () => {
      const query = 'test query';
      const documents = ['doc1', 'doc2'];

      // Store for tenant A
      cache.set('tenant-a', 'index-1', query, documents, mockResponse);

      // Manually corrupt entry to simulate collision (defense in depth test)
      const corruptedEntry = {
        response: mockResponse,
        timestamp: Date.now(),
        hitCount: 0,
        tenantId: 'tenant-b', // Wrong tenant!
        indexId: 'index-1',
      };

      // Use internal cache access (normally private, but we need to test defense)
      (cache as any).cache.set(
        (cache as any).computeKey('tenant-a', 'index-1', query, documents),
        corruptedEntry,
      );

      // Should detect collision and return null
      const result = cache.get('tenant-a', 'index-1', query, documents);
      expect(result).toBeNull();

      // Should have incremented miss counter
      const stats = cache.getStats();
      expect(stats.misses).toBeGreaterThan(0);
    });
  });

  describe('Cache Operations', () => {
    it('should return cached response on hit', () => {
      const query = 'test query';
      const documents = ['doc1', 'doc2', 'doc3'];

      cache.set('tenant-a', 'index-1', query, documents, mockResponse);

      const result = cache.get('tenant-a', 'index-1', query, documents);
      expect(result).toEqual(mockResponse);

      const stats = cache.getStats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(0);
    });

    it('should return null on miss', () => {
      const result = cache.get('tenant-a', 'index-1', 'nonexistent query', ['doc1']);
      expect(result).toBeNull();

      const stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(1);
    });

    it('should handle different queries for same documents', () => {
      const documents = ['doc1', 'doc2'];
      const response1 = { ...mockResponse, latencyMs: 50 };
      const response2 = { ...mockResponse, latencyMs: 60 };

      cache.set('tenant-a', 'index-1', 'query1', documents, response1);
      cache.set('tenant-a', 'index-1', 'query2', documents, response2);

      const result1 = cache.get('tenant-a', 'index-1', 'query1', documents);
      const result2 = cache.get('tenant-a', 'index-1', 'query2', documents);

      expect(result1?.latencyMs).toBe(50);
      expect(result2?.latencyMs).toBe(60);
    });

    it('should normalize document order for cache key', () => {
      const query = 'test query';
      const docsA = ['doc1', 'doc2', 'doc3'];
      const docsB = ['doc3', 'doc1', 'doc2']; // Different order

      cache.set('tenant-a', 'index-1', query, docsA, mockResponse);

      // Should hit cache even with different order (sorted internally)
      const result = cache.get('tenant-a', 'index-1', query, docsB);
      expect(result).toEqual(mockResponse);
    });
  });

  describe('TTL and Expiration', () => {
    it('should expire entries after TTL', () => {
      vi.useFakeTimers();

      const shortTTLCache = new RequestCache({
        deduplicationTTL: 1000, // 1 second
        cacheMaxSize: 100,
      });

      const query = 'test query';
      const documents = ['doc1', 'doc2'];

      shortTTLCache.set('tenant-a', 'index-1', query, documents, mockResponse);

      // Should hit immediately
      let result = shortTTLCache.get('tenant-a', 'index-1', query, documents);
      expect(result).toEqual(mockResponse);

      // Advance time past TTL
      vi.advanceTimersByTime(1001);

      // Should miss after expiration
      result = shortTTLCache.get('tenant-a', 'index-1', query, documents);
      expect(result).toBeNull();

      vi.useRealTimers();
    });

    it('should cleanup expired entries', () => {
      vi.useFakeTimers();

      const shortTTLCache = new RequestCache({
        deduplicationTTL: 1000,
        cacheMaxSize: 100,
      });

      // Add multiple entries
      for (let i = 0; i < 5; i++) {
        shortTTLCache.set('tenant-a', 'index-1', `query-${i}`, ['doc1'], mockResponse);
      }

      expect(shortTTLCache.getStats().size).toBe(5);

      // Advance time to expire all
      vi.advanceTimersByTime(1001);

      // Cleanup
      shortTTLCache.cleanup();

      expect(shortTTLCache.getStats().size).toBe(0);

      vi.useRealTimers();
    });
  });

  describe('Size Limits and Eviction', () => {
    it('should enforce max size with LRU eviction', () => {
      const smallCache = new RequestCache({
        deduplicationTTL: 5000,
        cacheMaxSize: 3,
      });

      // Add 4 entries (exceeds max size)
      smallCache.set('tenant-a', 'index-1', 'query-1', ['doc1'], mockResponse);
      smallCache.set('tenant-a', 'index-1', 'query-2', ['doc1'], mockResponse);
      smallCache.set('tenant-a', 'index-1', 'query-3', ['doc1'], mockResponse);
      smallCache.set('tenant-a', 'index-1', 'query-4', ['doc1'], mockResponse);

      // Should only have 3 entries
      expect(smallCache.getStats().size).toBe(3);

      // Oldest entry should have been evicted
      const result = smallCache.get('tenant-a', 'index-1', 'query-1', ['doc1']);
      expect(result).toBeNull();
    });
  });

  describe('Tenant Management', () => {
    it('should clear entries for specific tenant', () => {
      cache.set('tenant-a', 'index-1', 'query-1', ['doc1'], mockResponse);
      cache.set('tenant-b', 'index-1', 'query-2', ['doc1'], mockResponse);
      cache.set('tenant-a', 'index-2', 'query-3', ['doc1'], mockResponse);

      expect(cache.getStats().size).toBe(3);

      cache.clearTenant('tenant-a');

      expect(cache.getStats().size).toBe(1);

      // Tenant B should still exist
      const resultB = cache.get('tenant-b', 'index-1', 'query-2', ['doc1']);
      expect(resultB).toEqual(mockResponse);

      // Tenant A should be cleared
      const resultA1 = cache.get('tenant-a', 'index-1', 'query-1', ['doc1']);
      const resultA2 = cache.get('tenant-a', 'index-2', 'query-3', ['doc1']);
      expect(resultA1).toBeNull();
      expect(resultA2).toBeNull();
    });

    it('should clear all entries', () => {
      cache.set('tenant-a', 'index-1', 'query-1', ['doc1'], mockResponse);
      cache.set('tenant-b', 'index-1', 'query-2', ['doc1'], mockResponse);

      expect(cache.getStats().size).toBe(2);

      cache.clear();

      expect(cache.getStats().size).toBe(0);
      expect(cache.getStats().hits).toBe(0);
      expect(cache.getStats().misses).toBe(0);
    });
  });

  describe('Statistics', () => {
    it('should track hit count per entry', () => {
      const query = 'test query';
      const documents = ['doc1', 'doc2'];

      cache.set('tenant-a', 'index-1', query, documents, mockResponse);

      // Hit multiple times
      cache.get('tenant-a', 'index-1', query, documents);
      cache.get('tenant-a', 'index-1', query, documents);
      cache.get('tenant-a', 'index-1', query, documents);

      const stats = cache.getStats();
      expect(stats.hits).toBe(3);
    });

    it('should calculate hit rate correctly', () => {
      const query = 'test query';
      const documents = ['doc1', 'doc2'];

      cache.set('tenant-a', 'index-1', query, documents, mockResponse);

      // 3 hits, 2 misses
      cache.get('tenant-a', 'index-1', query, documents);
      cache.get('tenant-a', 'index-1', query, documents);
      cache.get('tenant-a', 'index-1', query, documents);
      cache.get('tenant-a', 'index-1', 'other-query', documents);
      cache.get('tenant-a', 'index-1', 'another-query', documents);

      const stats = cache.getStats();
      expect(stats.hits).toBe(3);
      expect(stats.misses).toBe(2);
      expect(stats.hitRate).toBeCloseTo(0.6, 2); // 3/5 = 0.6
    });

    it('should handle zero hit rate', () => {
      const stats = cache.getStats();
      expect(stats.hitRate).toBe(0);
    });
  });
});
