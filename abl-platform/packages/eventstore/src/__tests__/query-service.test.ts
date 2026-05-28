import { describe, it, expect, beforeEach } from 'vitest';
import { EventQueryService } from '../query/event-query-service.js';
import { MemoryCacheProvider } from '../query/cache-providers.js';
import { MemoryEventStore } from '../stores/memory/memory-event-store.js';
import {
  createTestEvent,
  createSessionEndedEvent,
  createLLMCallEvent,
  TENANT_A,
  PROJECT_A,
  resetEventCounter,
} from './helpers.js';
import type { TimeRange } from '../interfaces/types.js';

describe('EventQueryService', () => {
  let store: MemoryEventStore;
  let cache: MemoryCacheProvider;
  let queryService: EventQueryService;

  const timeRange: TimeRange = {
    from: new Date('2026-02-27T00:00:00Z'),
    to: new Date('2026-02-28T00:00:00Z'),
  };

  beforeEach(() => {
    resetEventCounter();
    store = new MemoryEventStore();
    cache = new MemoryCacheProvider({ maxSize: 100 });
    queryService = new EventQueryService(store, cache, {
      cache: { provider: cache, ttlSeconds: 60 },
    });
  });

  describe('query()', () => {
    it('delegates to reader and returns results', async () => {
      store.write(createTestEvent());
      store.write(createTestEvent());

      const result = await queryService.query({
        tenantId: TENANT_A,
        projectId: PROJECT_A,
        timeRange,
      });

      expect(result.total).toBe(2);
      expect(result.events.length).toBe(2);
    });

    it('caches query results', async () => {
      store.write(createTestEvent());

      // First call - hits store
      const result1 = await queryService.query({
        tenantId: TENANT_A,
        projectId: PROJECT_A,
        timeRange,
      });
      expect(result1.total).toBe(1);

      // Add more events
      store.write(createTestEvent());

      // Second call - should return cached result (still 1)
      const result2 = await queryService.query({
        tenantId: TENANT_A,
        projectId: PROJECT_A,
        timeRange,
      });
      expect(result2.total).toBe(1); // Cached
    });
  });

  describe('query() without cache', () => {
    it('works without a cache provider', async () => {
      const noCacheService = new EventQueryService(store, null);

      store.write(createTestEvent());

      const result = await noCacheService.query({
        tenantId: TENANT_A,
        projectId: PROJECT_A,
        timeRange,
      });

      expect(result.total).toBe(1);
    });
  });

  describe('getEventCounts()', () => {
    it('returns counts grouped by category', async () => {
      store.write(createTestEvent({ category: 'session' }));
      store.write(createTestEvent({ category: 'session' }));
      store.write(createLLMCallEvent());

      const result = await queryService.getEventCounts(TENANT_A, PROJECT_A, timeRange);

      expect(result.counts.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('getSessionMetrics()', () => {
    it('returns session summary metrics', async () => {
      const sessionId = 'sess-metrics-1';
      // A session lifecycle requires both started and ended events
      store.write(createTestEvent({ session_id: sessionId, event_type: 'session.started' }));
      store.write(
        createSessionEndedEvent({
          session_id: sessionId,
          data: {
            reason: 'completed',
            total_duration_ms: 30000,
            total_turns: 5,
            total_llm_calls: 3,
            total_tool_calls: 2,
          },
        }),
      );

      const metrics = await queryService.getSessionMetrics(TENANT_A, PROJECT_A, timeRange);

      expect(metrics.totalSessions).toBe(1);
      expect(metrics.completedSessions).toBe(1);
    });

    it('includes voice session lifecycle events in session summary metrics', async () => {
      const sessionId = 'voice-sess-metrics-1';
      store.write(
        createTestEvent({
          session_id: sessionId,
          event_type: 'voice.session.started',
          category: 'voice',
        }),
      );
      store.write(
        createSessionEndedEvent({
          session_id: sessionId,
          event_type: 'voice.session.ended',
          category: 'voice',
        }),
      );

      const metrics = await queryService.getSessionMetrics(TENANT_A, PROJECT_A, timeRange);

      expect(metrics.totalSessions).toBe(1);
      expect(metrics.completedSessions).toBe(1);
    });
  });
});

describe('MemoryCacheProvider', () => {
  let cache: MemoryCacheProvider;

  beforeEach(() => {
    cache = new MemoryCacheProvider({ maxSize: 3 });
  });

  it('set + get returns value', async () => {
    await cache.set('key1', 'value1', 60);
    const result = await cache.get('key1');
    expect(result).toBe('value1');
  });

  it('returns null for missing keys', async () => {
    const result = await cache.get('nonexistent');
    expect(result).toBeNull();
  });

  it('returns null for expired entries', async () => {
    await cache.set('key1', 'value1', 0); // 0 second TTL
    // Wait briefly for expiry
    await new Promise((resolve) => setTimeout(resolve, 10));
    const result = await cache.get('key1');
    expect(result).toBeNull();
  });

  it('evicts oldest entry when at max size', async () => {
    await cache.set('key1', 'value1', 60);
    await cache.set('key2', 'value2', 60);
    await cache.set('key3', 'value3', 60);
    // At max size (3), adding a new entry evicts key1
    await cache.set('key4', 'value4', 60);

    expect(await cache.get('key1')).toBeNull();
    expect(await cache.get('key4')).toBe('value4');
  });

  it('del removes entry', async () => {
    await cache.set('key1', 'value1', 60);
    await cache.del('key1');
    expect(await cache.get('key1')).toBeNull();
  });

  it('clear removes all entries', () => {
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});
