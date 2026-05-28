/**
 * Query Metrics Tests (RFC-003 Phase 2)
 *
 * Tests for performance metrics tracking, aggregation, and Prometheus export.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { QueryMetricsStore, type QueryMetrics } from '../services/metrics/query-metrics.js';

// =============================================================================
// TEST DATA
// =============================================================================

const createMockMetrics = (overrides?: Partial<QueryMetrics>): QueryMetrics => ({
  correlationId: `corr-${Math.random().toString(36)}`,
  timestamp: Date.now(),
  queryText: 'test query',
  projectKbId: 'kb-1',
  latency: {
    vocabularyResolveMs: 10,
    embeddingMs: 50,
    vectorSearchMs: 100,
    rerankMs: 80,
    totalMs: 240,
  },
  resultsCount: 5,
  topK: 10,
  embeddingProvider: 'voyage',
  rerankProvider: 'voyage',
  rerankFallback: false,
  errors: [],
  cost: {
    embeddingCost: 0.0001,
    rerankCost: 0.0025,
    totalCost: 0.0026,
  },
  ...overrides,
});

// =============================================================================
// TESTS
// =============================================================================

describe('QueryMetricsStore', () => {
  let store: QueryMetricsStore;

  beforeEach(() => {
    store = new QueryMetricsStore();
  });

  // ─── Basic Operations ──────────────────────────────────────────────────────

  describe('Basic Operations', () => {
    test('starts query and generates correlation ID', () => {
      const correlationId = store.startQuery();

      expect(correlationId).toBeDefined();
      expect(correlationId).toMatch(/^qry_/); // qry_ prefix format
      expect(store.getActiveQueryCount()).toBe(1);
    });

    test('records query and removes from active', () => {
      const correlationId = store.startQuery();
      expect(store.getActiveQueryCount()).toBe(1);

      const metrics = createMockMetrics({ correlationId });
      store.recordQuery(metrics);

      expect(store.getActiveQueryCount()).toBe(0);
      expect(store.getQueryByCorrelationId(correlationId)).toEqual(metrics);
    });

    test('tracks multiple active queries', () => {
      const id1 = store.startQuery();
      const id2 = store.startQuery();
      const id3 = store.startQuery();

      expect(store.getActiveQueryCount()).toBe(3);

      store.recordQuery(createMockMetrics({ correlationId: id1 }));
      expect(store.getActiveQueryCount()).toBe(2);

      store.recordQuery(createMockMetrics({ correlationId: id2 }));
      expect(store.getActiveQueryCount()).toBe(1);

      store.recordQuery(createMockMetrics({ correlationId: id3 }));
      expect(store.getActiveQueryCount()).toBe(0);
    });

    test('retrieves recent queries', () => {
      for (let i = 0; i < 5; i++) {
        const correlationId = store.startQuery();
        store.recordQuery(createMockMetrics({ correlationId }));
      }

      const recent = store.getRecentQueries(3);
      expect(recent).toHaveLength(3);
    });

    test('finds query by correlation ID', () => {
      const correlationId = store.startQuery();
      const metrics = createMockMetrics({ correlationId });
      store.recordQuery(metrics);

      const found = store.getQueryByCorrelationId(correlationId);
      expect(found).toEqual(metrics);
    });

    test('returns undefined for non-existent correlation ID', () => {
      const found = store.getQueryByCorrelationId('non-existent');
      expect(found).toBeUndefined();
    });
  });

  // ─── Counters ──────────────────────────────────────────────────────────────

  describe('Counters', () => {
    test('increments total query counter', () => {
      store.startQuery();
      store.startQuery();
      store.startQuery();

      const counters = store.getCounters();
      expect(counters.totalQueries).toBe(3);
    });

    test('tracks successful vs failed queries', () => {
      // Successful query (no unrecoverable errors)
      const id1 = store.startQuery();
      store.recordQuery(createMockMetrics({ correlationId: id1, errors: [] }));

      // Failed query (unrecoverable error)
      const id2 = store.startQuery();
      store.recordQuery(
        createMockMetrics({
          correlationId: id2,
          errors: [{ component: 'vector-search', error: 'Connection failed', recoverable: false }],
        }),
      );

      // Degraded query (recoverable error)
      const id3 = store.startQuery();
      store.recordQuery(
        createMockMetrics({
          correlationId: id3,
          errors: [{ component: 'rerank', error: 'Timeout', recoverable: true }],
        }),
      );

      const counters = store.getCounters();
      expect(counters.successfulQueries).toBe(2);
      expect(counters.failedQueries).toBe(1);
    });

    test('tracks provider usage', () => {
      const id1 = store.startQuery();
      store.recordQuery(createMockMetrics({ correlationId: id1, rerankProvider: 'voyage' }));

      const id2 = store.startQuery();
      store.recordQuery(createMockMetrics({ correlationId: id2, rerankProvider: 'voyage' }));

      const id3 = store.startQuery();
      store.recordQuery(createMockMetrics({ correlationId: id3, rerankProvider: 'cohere' }));

      const counters = store.getCounters();
      expect(counters.providerUsage).toEqual({ voyage: 2, cohere: 1 });
    });

    test('tracks provider failures', () => {
      const id1 = store.startQuery();
      store.recordQuery(
        createMockMetrics({
          correlationId: id1,
          rerankProvider: 'voyage',
          rerankFallback: true,
        }),
      );

      const id2 = store.startQuery();
      store.recordQuery(
        createMockMetrics({
          correlationId: id2,
          rerankProvider: 'voyage',
          rerankFallback: false,
        }),
      );

      const counters = store.getCounters();
      expect(counters.providerFailures).toEqual({ voyage: 1 });
    });

    test('tracks errors by component', () => {
      const id1 = store.startQuery();
      store.recordQuery(
        createMockMetrics({
          correlationId: id1,
          errors: [{ component: 'vocabulary', error: 'Error 1', recoverable: true }],
        }),
      );

      const id2 = store.startQuery();
      store.recordQuery(
        createMockMetrics({
          correlationId: id2,
          errors: [
            { component: 'vocabulary', error: 'Error 2', recoverable: true },
            { component: 'rerank', error: 'Error 3', recoverable: true },
          ],
        }),
      );

      const counters = store.getCounters();
      expect(counters.errorsByComponent).toEqual({ vocabulary: 2, rerank: 1 });
    });
  });

  // ─── Aggregate Metrics ─────────────────────────────────────────────────────

  describe('Aggregate Metrics', () => {
    test('calculates latency percentiles', () => {
      // Create queries with known latencies: 100, 200, 300, 400, 500
      for (let i = 1; i <= 5; i++) {
        const correlationId = store.startQuery();
        store.recordQuery(
          createMockMetrics({
            correlationId,
            latency: {
              vocabularyResolveMs: 0,
              embeddingMs: 0,
              vectorSearchMs: 0,
              rerankMs: 0,
              totalMs: i * 100,
            },
          }),
        );
      }

      const aggregates = store.getAggregateMetrics();

      expect(aggregates.latency.p50).toBe(300); // 50th percentile
      expect(aggregates.latency.p95).toBe(500); // 95th percentile
      expect(aggregates.latency.p99).toBe(500); // 99th percentile
      expect(aggregates.latency.mean).toBe(300); // Average
      expect(aggregates.latency.max).toBe(500); // Max
    });

    test('calculates success rate', () => {
      // 3 successful, 1 failed
      for (let i = 0; i < 3; i++) {
        const correlationId = store.startQuery();
        store.recordQuery(createMockMetrics({ correlationId, errors: [] }));
      }

      const failedId = store.startQuery();
      store.recordQuery(
        createMockMetrics({
          correlationId: failedId,
          errors: [{ component: 'search', error: 'Failed', recoverable: false }],
        }),
      );

      const aggregates = store.getAggregateMetrics();
      expect(aggregates.successRate).toBe(0.75); // 3/4
      expect(aggregates.errorRate).toBe(0.25); // 1/4
    });

    test('calculates queries per second', () => {
      // Add 10 queries
      for (let i = 0; i < 10; i++) {
        const correlationId = store.startQuery();
        store.recordQuery(createMockMetrics({ correlationId }));
      }

      const aggregates = store.getAggregateMetrics();
      // Within 1 minute window, should be 10/60 = 0.166... qps
      expect(aggregates.queriesPerSecond).toBeCloseTo(0.166, 2);
    });

    test('aggregates provider statistics', () => {
      // Voyage: 2 success, 1 failure
      for (let i = 0; i < 2; i++) {
        const id = store.startQuery();
        store.recordQuery(
          createMockMetrics({
            correlationId: id,
            rerankProvider: 'voyage',
            rerankFallback: false,
            latency: { ...createMockMetrics().latency, rerankMs: 100 },
          }),
        );
      }

      const failedId = store.startQuery();
      store.recordQuery(
        createMockMetrics({
          correlationId: failedId,
          rerankProvider: 'voyage',
          rerankFallback: true,
          latency: { ...createMockMetrics().latency, rerankMs: 50 },
        }),
      );

      const aggregates = store.getAggregateMetrics();
      expect(aggregates.providerUsage.voyage).toEqual({
        count: 3,
        successRate: 2 / 3,
        avgLatencyMs: (100 + 100 + 50) / 3,
      });
    });

    test('aggregates costs', () => {
      for (let i = 0; i < 3; i++) {
        const correlationId = store.startQuery();
        store.recordQuery(
          createMockMetrics({
            correlationId,
            cost: {
              embeddingCost: 0.0001,
              rerankCost: 0.001,
              totalCost: 0.0011,
            },
          }),
        );
      }

      const aggregates = store.getAggregateMetrics();
      expect(aggregates.totalCost).toBeCloseTo(0.0033, 4); // 3 * 0.0011
      expect(aggregates.avgCostPerQuery).toBeCloseTo(0.0011, 4);
    });

    test('returns empty aggregates when no queries', () => {
      const aggregates = store.getAggregateMetrics();

      expect(aggregates.totalQueries).toBe(0);
      expect(aggregates.successRate).toBe(1);
      expect(aggregates.errorRate).toBe(0);
      expect(aggregates.totalCost).toBe(0);
    });
  });

  // ─── Prometheus Export ─────────────────────────────────────────────────────

  describe('Prometheus Export', () => {
    test('exports metrics in Prometheus format', () => {
      const id = store.startQuery();
      store.recordQuery(createMockMetrics({ correlationId: id }));

      const prometheus = store.exportPrometheus();

      expect(prometheus).toContain('# HELP search_queries_total');
      expect(prometheus).toContain('# TYPE search_queries_total counter');
      expect(prometheus).toContain('search_queries_total 1');

      expect(prometheus).toContain('# HELP search_latency_milliseconds');
      expect(prometheus).toContain('# TYPE search_latency_milliseconds summary');
      expect(prometheus).toContain('search_latency_milliseconds{quantile="0.5"}');
      expect(prometheus).toContain('search_latency_milliseconds{quantile="0.95"}');
      expect(prometheus).toContain('search_latency_milliseconds{quantile="0.99"}');

      expect(prometheus).toContain('# HELP search_queries_active');
      expect(prometheus).toContain('# TYPE search_queries_active gauge');
      expect(prometheus).toContain('search_queries_active 0');
    });

    test('exports provider metrics', () => {
      const id = store.startQuery();
      store.recordQuery(createMockMetrics({ correlationId: id, rerankProvider: 'voyage' }));

      const prometheus = store.exportPrometheus();

      expect(prometheus).toContain('# HELP search_rerank_provider_total');
      expect(prometheus).toContain('search_rerank_provider_total{provider="voyage"} 1');
    });

    test('exports error metrics by component', () => {
      const id = store.startQuery();
      store.recordQuery(
        createMockMetrics({
          correlationId: id,
          errors: [{ component: 'vocabulary', error: 'Test error', recoverable: true }],
        }),
      );

      const prometheus = store.exportPrometheus();

      expect(prometheus).toContain('# HELP search_errors_total');
      expect(prometheus).toContain('search_errors_total{component="vocabulary"} 1');
    });

    test('exports cost metrics', () => {
      const id = store.startQuery();
      store.recordQuery(
        createMockMetrics({
          correlationId: id,
          cost: { totalCost: 0.005 },
        }),
      );

      const prometheus = store.exportPrometheus();

      expect(prometheus).toContain('# HELP search_cost_usd_total');
      expect(prometheus).toContain('# TYPE search_cost_usd_total counter');
      expect(prometheus).toContain('search_cost_usd_total');
    });
  });
});
