/**
 * NLU Result Cache Tests
 *
 * Tests in-memory caching with TTL, eviction, tenant isolation,
 * task-specific TTLs, and stats tracking.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { NLUResultCache } from '../../platform/nlu/enterprise/nlu-cache.js';
import type { NLUContext, NLUTask } from '../../platform/nlu/types.js';

// =============================================================================
// HELPERS
// =============================================================================

function makeCtx(overrides?: Partial<NLUContext>): NLUContext {
  return {
    userMessage: 'I want to book a flight',
    conversationHistory: [],
    turnNumber: 1,
    conversationPhase: 'collecting',
    agentGoal: 'Book a flight',
    collectedData: {},
    ...overrides,
  };
}

function makeCache(opts?: {
  enabled?: boolean;
  ttlMs?: number;
  intentTtlMs?: number;
  entityTtlMs?: number;
  tenantId?: string;
  maxEntries?: number;
}) {
  return new NLUResultCache(
    {
      enabled: opts?.enabled ?? true,
      ttlMs: opts?.ttlMs ?? 60_000,
      intentTtlMs: opts?.intentTtlMs ?? 120_000,
      entityTtlMs: opts?.entityTtlMs ?? 30_000,
    },
    {
      tenantId: opts?.tenantId ?? 'tenant-1',
      maxEntries: opts?.maxEntries,
    },
  );
}

// =============================================================================
// TESTS
// =============================================================================

describe('NLUResultCache', () => {
  let nowSpy: ReturnType<typeof vi.spyOn>;
  let currentTime: number;

  beforeEach(() => {
    currentTime = 1000000;
    nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => currentTime);
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  // =========================================================================
  // DISABLED MODE
  // =========================================================================

  describe('disabled mode', () => {
    test('checkCache returns null when disabled', async () => {
      const cache = makeCache({ enabled: false });
      await cache.storeCache(makeCtx(), 'intent_detection', { intent: 'book' });
      const result = await cache.checkCache(makeCtx(), 'intent_detection');
      expect(result).toBeNull();
    });

    test('storeCache is a no-op when disabled', async () => {
      const cache = makeCache({ enabled: false });
      await cache.storeCache(makeCtx(), 'intent_detection', { intent: 'book' });
      expect(cache.getStats().totalEntries).toBe(0);
    });
  });

  // =========================================================================
  // CACHE HIT/MISS
  // =========================================================================

  describe('cache hit/miss', () => {
    test('store then retrieve returns same result', async () => {
      const cache = makeCache();
      const ctx = makeCtx();
      const data = { intent: 'book_flight', confidence: 0.95 };

      await cache.storeCache(ctx, 'intent_detection', data);
      const result = await cache.checkCache(ctx, 'intent_detection');
      expect(result).toEqual(data);
    });

    test('miss returns null and increments miss count', async () => {
      const cache = makeCache();
      const result = await cache.checkCache(makeCtx(), 'intent_detection');
      expect(result).toBeNull();
      expect(cache.getStats().misses).toBe(1);
    });

    test('hit increments hit count', async () => {
      const cache = makeCache();
      const ctx = makeCtx();
      await cache.storeCache(ctx, 'intent_detection', { intent: 'book' });
      await cache.checkCache(ctx, 'intent_detection');
      expect(cache.getStats().hits).toBe(1);
    });
  });

  // =========================================================================
  // TTL EXPIRY
  // =========================================================================

  describe('TTL expiry', () => {
    test('entry expires after TTL', async () => {
      const cache = makeCache({ ttlMs: 5000 });
      const ctx = makeCtx();
      await cache.storeCache(ctx, 'digression_detection', { detected: false });

      // Advance time past TTL
      currentTime += 5001;
      const result = await cache.checkCache(ctx, 'digression_detection');
      expect(result).toBeNull();
    });

    test('entry is accessible before TTL expires', async () => {
      const cache = makeCache({ ttlMs: 5000 });
      const ctx = makeCtx();
      await cache.storeCache(ctx, 'digression_detection', { detected: false });

      currentTime += 4999;
      const result = await cache.checkCache(ctx, 'digression_detection');
      expect(result).toEqual({ detected: false });
    });
  });

  // =========================================================================
  // CORRECTION DETECTION EXCLUSION
  // =========================================================================

  describe('correction detection exclusion', () => {
    test('storeCache with correction_detection does not store', async () => {
      const cache = makeCache();
      const ctx = makeCtx();
      await cache.storeCache(ctx, 'correction_detection', { detected: true });
      expect(cache.getStats().totalEntries).toBe(0);
    });
  });

  // =========================================================================
  // TASK-SPECIFIC TTL
  // =========================================================================

  describe('task-specific TTL', () => {
    test('intent_detection uses intentTtlMs', async () => {
      const cache = makeCache({ intentTtlMs: 10_000, ttlMs: 1000 });
      const ctx = makeCtx();
      await cache.storeCache(ctx, 'intent_detection', { intent: 'book' });

      // Past the general TTL but within intentTtlMs
      currentTime += 5000;
      const result = await cache.checkCache(ctx, 'intent_detection');
      expect(result).toEqual({ intent: 'book' });
    });

    test('sub_intent_detection uses intentTtlMs', async () => {
      const cache = makeCache({ intentTtlMs: 10_000, ttlMs: 1000 });
      const ctx = makeCtx();
      await cache.storeCache(ctx, 'sub_intent_detection', { subIntent: 'one_way' });

      currentTime += 5000;
      const result = await cache.checkCache(ctx, 'sub_intent_detection');
      expect(result).toEqual({ subIntent: 'one_way' });
    });

    test('category_classification uses intentTtlMs', async () => {
      const cache = makeCache({ intentTtlMs: 10_000, ttlMs: 1000 });
      const ctx = makeCtx();
      await cache.storeCache(ctx, 'category_classification', { category: 'travel' });

      currentTime += 5000;
      const result = await cache.checkCache(ctx, 'category_classification');
      expect(result).toEqual({ category: 'travel' });
    });

    test('entity_extraction uses entityTtlMs', async () => {
      const cache = makeCache({ entityTtlMs: 3000, ttlMs: 60_000 });
      const ctx = makeCtx();
      await cache.storeCache(ctx, 'entity_extraction', { values: { city: 'NYC' } });

      // Past entityTtlMs
      currentTime += 3001;
      const result = await cache.checkCache(ctx, 'entity_extraction');
      expect(result).toBeNull();
    });

    test('other tasks use default ttlMs', async () => {
      const cache = makeCache({ ttlMs: 2000, intentTtlMs: 60_000, entityTtlMs: 60_000 });
      const ctx = makeCtx();
      await cache.storeCache(ctx, 'language_detection', { primary: 'en' });

      currentTime += 2001;
      const result = await cache.checkCache(ctx, 'language_detection');
      expect(result).toBeNull();
    });
  });

  // =========================================================================
  // EVICTION
  // =========================================================================

  describe('eviction', () => {
    test('evicts 20% oldest entries when exceeding maxEntries', async () => {
      const cache = makeCache({ maxEntries: 5 });

      // Store 5 entries with ascending timestamps
      for (let i = 0; i < 5; i++) {
        currentTime += 100;
        const ctx = makeCtx({ userMessage: `msg-${i}` });
        await cache.storeCache(ctx, 'intent_detection', { intent: `intent-${i}` });
      }
      expect(cache.getStats().totalEntries).toBe(5);

      // Store 6th entry — should trigger eviction of 20% (1 entry)
      currentTime += 100;
      const ctx = makeCtx({ userMessage: 'msg-5' });
      await cache.storeCache(ctx, 'intent_detection', { intent: 'intent-5' });

      // 6 entries - 20% of 6 = ceil(1.2) = 2 evicted = 4 remaining
      expect(cache.getStats().totalEntries).toBe(4);
    });
  });

  // =========================================================================
  // TENANT ISOLATION
  // =========================================================================

  describe('tenant isolation', () => {
    test('invalidateForTenant removes only that tenant entries', async () => {
      const cache = makeCache({ tenantId: 'tenant-A' });
      const ctx = makeCtx();
      await cache.storeCache(ctx, 'intent_detection', { intent: 'book' });

      // Create another cache with different tenant but store entries manually via same cache
      // The cache keys are prefixed with tenantId, so invalidateForTenant('tenant-B') should do nothing
      cache.invalidateForTenant('tenant-B');
      expect(cache.getStats().totalEntries).toBe(1);

      cache.invalidateForTenant('tenant-A');
      expect(cache.getStats().totalEntries).toBe(0);
    });

    test('invalidateAll clears everything', async () => {
      const cache = makeCache();
      const ctx = makeCtx();
      await cache.storeCache(ctx, 'intent_detection', { intent: 'book' });
      await cache.storeCache(makeCtx({ userMessage: 'different' }), 'entity_extraction', {
        values: {},
      });

      cache.invalidateAll();
      expect(cache.getStats().totalEntries).toBe(0);
    });
  });

  // =========================================================================
  // STATS
  // =========================================================================

  describe('stats', () => {
    test('getStats returns accurate hits, misses, hitRate, totalEntries', async () => {
      const cache = makeCache();
      const ctx = makeCtx();

      // 1 miss
      await cache.checkCache(ctx, 'intent_detection');
      // Store + 1 hit
      await cache.storeCache(ctx, 'intent_detection', { intent: 'book' });
      await cache.checkCache(ctx, 'intent_detection');

      const stats = cache.getStats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBe(0.5);
      expect(stats.totalEntries).toBe(1);
    });

    test('getStats returns a copy (not a reference)', () => {
      const cache = makeCache();
      const stats1 = cache.getStats();
      const stats2 = cache.getStats();
      expect(stats1).not.toBe(stats2);
      expect(stats1).toEqual(stats2);
    });
  });
});
