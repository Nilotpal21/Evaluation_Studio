/**
 * Query Performance Metrics Service (RFC-003 Phase 2)
 *
 * Tracks and exports performance metrics for query pipeline:
 * - Latency histograms (p50, p95, p99)
 * - Throughput counters
 * - Provider usage tracking
 * - Error rates
 * - Cache effectiveness
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface QueryMetrics {
  correlationId: string;
  timestamp: number;
  queryText: string;
  projectKbId?: string;

  // Latency breakdown (milliseconds)
  latency: {
    preprocessingMs?: number; // Phase 3: Multilingual preprocessing
    vocabularyResolveMs: number;
    embeddingMs: number;
    vectorSearchMs: number;
    rerankMs: number;
    totalMs: number;
  };

  // Results
  resultsCount: number;
  topK: number;

  // Provider usage
  embeddingProvider?: string;
  rerankProvider?: string;
  rerankFallback?: boolean;

  // Preprocessing (Phase 3)
  detectedLanguage?: string; // ISO 639-1 code (en, es, fr, etc.)
  preprocessingApplied?: boolean; // Whether spell/synonym/entity stages ran

  // Errors
  errors: Array<{
    component: string;
    error: string;
    recoverable: boolean;
  }>;

  // Cost (optional)
  cost?: {
    embeddingCost?: number;
    rerankCost?: number;
    totalCost?: number;
  };
}

export interface AggregateMetrics {
  // Throughput
  totalQueries: number;
  queriesPerSecond: number;

  // Latency percentiles
  latency: {
    p50: number;
    p95: number;
    p99: number;
    mean: number;
    max: number;
  };

  // Success rate
  successRate: number;
  errorRate: number;

  // Provider stats
  providerUsage: {
    [provider: string]: {
      count: number;
      successRate: number;
      avgLatencyMs: number;
    };
  };

  // Cost
  totalCost: number;
  avgCostPerQuery: number;

  // Time window
  windowStartMs: number;
  windowEndMs: number;
}

// ─── Metrics Store ──────────────────────────────────────────────────────────

export class QueryMetricsStore {
  private metrics: QueryMetrics[] = [];
  private readonly maxMetrics = 10000; // Keep last 10K queries
  private readonly windowMs = 60000; // 1 minute window for aggregates

  // Prometheus-style counters
  private counters = {
    totalQueries: 0,
    successfulQueries: 0,
    failedQueries: 0,
    providerUsage: new Map<string, number>(),
    providerFailures: new Map<string, number>(),
    errorsByComponent: new Map<string, number>(),
  };

  // Active queries (for concurrency tracking)
  private activeQueries = new Set<string>();

  /**
   * Start tracking a new query. Returns correlation ID.
   */
  startQuery(): string {
    const correlationId = `qry_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    this.activeQueries.add(correlationId);
    this.counters.totalQueries++;
    return correlationId;
  }

  /**
   * Record completed query metrics.
   */
  recordQuery(metrics: QueryMetrics): void {
    this.activeQueries.delete(metrics.correlationId);

    // Add to metrics history
    this.metrics.push(metrics);

    // Evict old metrics if over limit
    if (this.metrics.length > this.maxMetrics) {
      this.metrics = this.metrics.slice(-this.maxMetrics);
    }

    // Update counters
    if (metrics.errors.some((e) => !e.recoverable)) {
      this.counters.failedQueries++;
    } else {
      this.counters.successfulQueries++;
    }

    // Track provider usage
    if (metrics.rerankProvider) {
      const current = this.counters.providerUsage.get(metrics.rerankProvider) ?? 0;
      this.counters.providerUsage.set(metrics.rerankProvider, current + 1);

      if (metrics.rerankFallback) {
        const failures = this.counters.providerFailures.get(metrics.rerankProvider) ?? 0;
        this.counters.providerFailures.set(metrics.rerankProvider, failures + 1);
      }
    }

    // Track errors by component
    for (const error of metrics.errors) {
      const count = this.counters.errorsByComponent.get(error.component) ?? 0;
      this.counters.errorsByComponent.set(error.component, count + 1);
    }
  }

  /**
   * Get aggregate metrics for the current time window.
   */
  getAggregateMetrics(): AggregateMetrics {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    // Filter metrics in window
    const windowMetrics = this.metrics.filter((m) => m.timestamp >= windowStart);

    if (windowMetrics.length === 0) {
      return this.emptyAggregates(windowStart, now);
    }

    // Calculate latency percentiles
    const latencies = windowMetrics.map((m) => m.latency.totalMs).sort((a, b) => a - b);
    const p50 = this.percentile(latencies, 0.5);
    const p95 = this.percentile(latencies, 0.95);
    const p99 = this.percentile(latencies, 0.99);
    const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const max = latencies[latencies.length - 1];

    // Calculate success/error rates
    const successful = windowMetrics.filter((m) => !m.errors.some((e) => !e.recoverable)).length;
    const successRate = successful / windowMetrics.length;

    // Provider stats
    const providerUsage: AggregateMetrics['providerUsage'] = {};
    const providerMetrics = new Map<string, QueryMetrics[]>();

    for (const metric of windowMetrics) {
      if (metric.rerankProvider) {
        if (!providerMetrics.has(metric.rerankProvider)) {
          providerMetrics.set(metric.rerankProvider, []);
        }
        providerMetrics.get(metric.rerankProvider)!.push(metric);
      }
    }

    for (const [provider, metrics] of providerMetrics.entries()) {
      const successCount = metrics.filter((m) => !m.rerankFallback).length;
      const avgLatency = metrics.reduce((sum, m) => sum + m.latency.rerankMs, 0) / metrics.length;

      providerUsage[provider] = {
        count: metrics.length,
        successRate: successCount / metrics.length,
        avgLatencyMs: avgLatency,
      };
    }

    // Cost aggregation
    const totalCost = windowMetrics.reduce((sum, m) => sum + (m.cost?.totalCost ?? 0), 0);
    const avgCostPerQuery = totalCost / windowMetrics.length;

    return {
      totalQueries: windowMetrics.length,
      queriesPerSecond: windowMetrics.length / (this.windowMs / 1000),
      latency: { p50, p95, p99, mean, max },
      successRate,
      errorRate: 1 - successRate,
      providerUsage,
      totalCost,
      avgCostPerQuery,
      windowStartMs: windowStart,
      windowEndMs: now,
    };
  }

  /**
   * Get current active query count.
   */
  getActiveQueryCount(): number {
    return this.activeQueries.size;
  }

  /**
   * Get all-time counters (for Prometheus export).
   */
  getCounters() {
    return {
      totalQueries: this.counters.totalQueries,
      successfulQueries: this.counters.successfulQueries,
      failedQueries: this.counters.failedQueries,
      providerUsage: Object.fromEntries(this.counters.providerUsage),
      providerFailures: Object.fromEntries(this.counters.providerFailures),
      errorsByComponent: Object.fromEntries(this.counters.errorsByComponent),
      activeQueries: this.activeQueries.size,
    };
  }

  /**
   * Export metrics in Prometheus format.
   */
  exportPrometheus(): string {
    const lines: string[] = [];
    const aggregates = this.getAggregateMetrics();
    const counters = this.getCounters();

    // Total queries counter
    lines.push('# HELP search_queries_total Total number of search queries');
    lines.push('# TYPE search_queries_total counter');
    lines.push(`search_queries_total ${counters.totalQueries}`);
    lines.push('');

    // Success/failure counters
    lines.push('# HELP search_queries_success_total Successful search queries');
    lines.push('# TYPE search_queries_success_total counter');
    lines.push(`search_queries_success_total ${counters.successfulQueries}`);
    lines.push('');

    lines.push('# HELP search_queries_failed_total Failed search queries');
    lines.push('# TYPE search_queries_failed_total counter');
    lines.push(`search_queries_failed_total ${counters.failedQueries}`);
    lines.push('');

    // Active queries gauge
    lines.push('# HELP search_queries_active Currently active queries');
    lines.push('# TYPE search_queries_active gauge');
    lines.push(`search_queries_active ${counters.activeQueries}`);
    lines.push('');

    // Latency histogram
    lines.push('# HELP search_latency_milliseconds Query latency in milliseconds');
    lines.push('# TYPE search_latency_milliseconds summary');
    lines.push(`search_latency_milliseconds{quantile="0.5"} ${aggregates.latency.p50}`);
    lines.push(`search_latency_milliseconds{quantile="0.95"} ${aggregates.latency.p95}`);
    lines.push(`search_latency_milliseconds{quantile="0.99"} ${aggregates.latency.p99}`);
    lines.push(
      `search_latency_milliseconds_sum ${aggregates.latency.mean * aggregates.totalQueries}`,
    );
    lines.push(`search_latency_milliseconds_count ${aggregates.totalQueries}`);
    lines.push('');

    // Provider usage counters
    lines.push('# HELP search_rerank_provider_total Reranker provider usage count');
    lines.push('# TYPE search_rerank_provider_total counter');
    for (const [provider, count] of Object.entries(counters.providerUsage)) {
      lines.push(`search_rerank_provider_total{provider="${provider}"} ${count}`);
    }
    lines.push('');

    // Provider failures
    lines.push('# HELP search_rerank_provider_failures_total Reranker provider failures');
    lines.push('# TYPE search_rerank_provider_failures_total counter');
    for (const [provider, count] of Object.entries(counters.providerFailures)) {
      lines.push(`search_rerank_provider_failures_total{provider="${provider}"} ${count}`);
    }
    lines.push('');

    // Error counters by component
    lines.push('# HELP search_errors_total Errors by component');
    lines.push('# TYPE search_errors_total counter');
    for (const [component, count] of Object.entries(counters.errorsByComponent)) {
      lines.push(`search_errors_total{component="${component}"} ${count}`);
    }
    lines.push('');

    // Cost metrics
    lines.push('# HELP search_cost_usd_total Total cost in USD');
    lines.push('# TYPE search_cost_usd_total counter');
    lines.push(`search_cost_usd_total ${aggregates.totalCost}`);
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Get recent query history (for debugging).
   */
  getRecentQueries(limit = 100): QueryMetrics[] {
    return this.metrics.slice(-limit);
  }

  /**
   * Find queries by correlation ID.
   */
  getQueryByCorrelationId(correlationId: string): QueryMetrics | undefined {
    return this.metrics.find((m) => m.correlationId === correlationId);
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  private percentile(sorted: number[], p: number): number {
    const index = Math.ceil(sorted.length * p) - 1;
    return sorted[Math.max(0, index)];
  }

  private emptyAggregates(windowStart: number, windowEnd: number): AggregateMetrics {
    return {
      totalQueries: 0,
      queriesPerSecond: 0,
      latency: { p50: 0, p95: 0, p99: 0, mean: 0, max: 0 },
      successRate: 1,
      errorRate: 0,
      providerUsage: {},
      totalCost: 0,
      avgCostPerQuery: 0,
      windowStartMs: windowStart,
      windowEndMs: windowEnd,
    };
  }
}

// ─── Singleton Instance ─────────────────────────────────────────────────────

export const queryMetricsStore = new QueryMetricsStore();
