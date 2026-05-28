/**
 * Batched Reranker Factory Tests (RFC-003 Phase 2.3)
 *
 * Tests configuration, statistics, and lifecycle management.
 * Note: Full end-to-end tests require API keys and are covered in integration tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BatchedRerankerFactory } from '../batched-reranker-factory.js';
import type { CallerContext } from '../batch-types.js';

describe('BatchedRerankerFactory', () => {
  let factory: BatchedRerankerFactory;
  const mockCallerContext: CallerContext = {
    identityTier: 'user',
    channel: 'web',
    initiatedById: 'user-123',
  };

  beforeEach(() => {
    // Create factory without API keys (tests configuration and lifecycle)
    factory = new BatchedRerankerFactory({
      enabled: true,
      maxBatchSize: 3,
      maxWaitMs: 50,
      deduplicate: true,
      deduplicationTTL: 5000,
      cacheMaxSize: 100,
      queueCleanupIntervalMs: 60000,
      maxRequestAgeMs: 5000,
    });
  });

  afterEach(async () => {
    if (factory) {
      await factory.shutdown();
    }
  });

  describe('Configuration', () => {
    it('should initialize with default configuration', () => {
      const defaultFactory = new BatchedRerankerFactory();
      expect(defaultFactory.isAvailable()).toBe(false); // No API keys

      const stats = defaultFactory.getBatchStats();
      expect(stats.totalRequests).toBe(0);
      expect(stats.batchCount).toBe(0);

      defaultFactory.shutdown();
    });

    it('should respect custom configuration', () => {
      const customFactory = new BatchedRerankerFactory({
        enabled: false,
        maxBatchSize: 50,
        maxWaitMs: 100,
        deduplicate: false,
        deduplicationTTL: 10000,
        cacheMaxSize: 500,
        queueCleanupIntervalMs: 30000,
        maxRequestAgeMs: 3000,
      });

      expect(customFactory.isAvailable()).toBe(false);
      customFactory.shutdown();
    });
  });

  describe('Statistics', () => {
    it('should return initial statistics', () => {
      const stats = factory.getBatchStats();

      expect(stats).toMatchObject({
        totalRequests: 0,
        batchedRequests: 0,
        batchCount: 0,
        avgBatchSize: 0,
        batchUtilization: 0,
        cacheHits: 0,
        cacheMisses: 0,
        cacheHitRate: 0,
        avgBatchWaitMs: 0,
        avgBatchExecutionMs: 0,
        avgTotalLatencyMs: 0,
        activeQueues: 0,
        totalQueuedRequests: 0,
        stalledRequests: 0,
        estimatedAPICalls: 0,
        actualAPICalls: 0,
        callReduction: 0,
      });
    });

    it('should track call reduction ratio', () => {
      const stats = factory.getBatchStats();

      // Initially no reduction (no calls)
      expect(stats.callReduction).toBe(0);

      // Formula: 1 - (actualAPICalls / estimatedAPICalls)
      // With batching: estimatedAPICalls > actualAPICalls → positive reduction
    });
  });

  describe('Lifecycle Management', () => {
    it('should handle shutdown gracefully', async () => {
      await expect(factory.shutdown()).resolves.not.toThrow();
    });

    it('should flush batches on shutdown', async () => {
      await factory.shutdown();

      const stats = factory.getBatchStats();
      expect(stats.activeQueues).toBe(0);
      expect(stats.totalQueuedRequests).toBe(0);
    });

    it('should flush batches on demand', async () => {
      await expect(factory.flushBatches()).resolves.not.toThrow();
    });

    it('should allow multiple shutdown calls', async () => {
      await factory.shutdown();
      await expect(factory.shutdown()).resolves.not.toThrow();
    });
  });

  describe('Provider Availability', () => {
    it('should report unavailable when no API keys', () => {
      expect(factory.isAvailable()).toBe(false);
    });

    it('should return null when reranking with no providers', async () => {
      const request = {
        query: 'test',
        documents: ['doc1', 'doc2'],
      };

      const result = await factory.rerank('tenant-a', 'index-1', request, mockCallerContext);
      expect(result).toBeNull();
    });
  });

  describe('Batching Disabled Mode', () => {
    it('should use direct reranking when batching disabled', async () => {
      const directFactory = new BatchedRerankerFactory({
        enabled: false,
        maxBatchSize: 100,
        maxWaitMs: 50,
        deduplicate: false,
        deduplicationTTL: 5000,
        cacheMaxSize: 100,
        queueCleanupIntervalMs: 60000,
        maxRequestAgeMs: 5000,
      });

      const request = {
        query: 'test',
        documents: ['doc1', 'doc2'],
      };

      // Should call direct reranker (which returns null without API keys)
      const result = await directFactory.rerank('tenant-a', 'index-1', request, mockCallerContext);
      expect(result).toBeNull();

      await directFactory.shutdown();
    });
  });
});
