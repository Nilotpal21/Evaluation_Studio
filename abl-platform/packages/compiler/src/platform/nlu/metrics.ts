/**
 * NLU Metrics Collector
 *
 * Tracks NLU predictions for accuracy analysis, latency monitoring,
 * and A/B testing. Provides an in-memory implementation.
 */

import type { NLUMetricsCollector, NLUPredictionEvent, NLUMetrics, NLUTask } from './types.js';

// =============================================================================
// IN-MEMORY METRICS COLLECTOR
// =============================================================================

export class InMemoryMetricsCollector implements NLUMetricsCollector {
  private events: NLUPredictionEvent[] = [];
  private maxEvents: number;

  constructor(maxEvents: number = 10000) {
    this.maxEvents = maxEvents;
  }

  /**
   * Record an NLU prediction event
   */
  recordPrediction(event: NLUPredictionEvent): void {
    this.events.push(event);

    // Evict old events if over limit
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
    }
  }

  /**
   * Get aggregated metrics, optionally filtered by time range
   */
  getMetrics(timeRange?: { from: Date; to: Date }): NLUMetrics {
    let events = this.events;

    if (timeRange) {
      events = events.filter((e) => e.timestamp >= timeRange.from && e.timestamp <= timeRange.to);
    }

    const metrics: NLUMetrics = {
      totalPredictions: events.length,
      byTask: {},
      byModel: {},
      byLanguage: {},
    };

    // Group by task
    const taskGroups = groupBy(events, (e) => e.task);
    for (const [task, taskEvents] of Object.entries(taskGroups)) {
      const fallbackCount = taskEvents.filter((e) => e.layerUsed === 'fallback').length;
      const correctionCount = taskEvents.filter((e) => e.wasCorrect === false).length;

      metrics.byTask[task] = {
        count: taskEvents.length,
        avgConfidence: avg(taskEvents.map((e) => e.confidence)),
        avgLatencyMs: avg(taskEvents.map((e) => e.latencyMs)),
        fallbackRate: taskEvents.length > 0 ? fallbackCount / taskEvents.length : 0,
        correctionRate: taskEvents.length > 0 ? correctionCount / taskEvents.length : 0,
      };
    }

    // Group by model
    const modelGroups = groupBy(events, (e) => e.modelUsed);
    for (const [model, modelEvents] of Object.entries(modelGroups)) {
      const errorCount = modelEvents.filter((e) => e.confidence === 0).length;

      metrics.byModel[model] = {
        count: modelEvents.length,
        avgLatencyMs: avg(modelEvents.map((e) => e.latencyMs)),
        errorRate: modelEvents.length > 0 ? errorCount / modelEvents.length : 0,
      };
    }

    // Group by language
    const langGroups = groupBy(events, (e) => e.language);
    for (const [lang, langEvents] of Object.entries(langGroups)) {
      metrics.byLanguage[lang] = {
        count: langEvents.length,
        avgConfidence: avg(langEvents.map((e) => e.confidence)),
      };
    }

    return metrics;
  }

  /**
   * Mark a previous prediction as correct/incorrect (for accuracy tracking)
   */
  markPrediction(
    sessionId: string,
    task: NLUTask,
    wasCorrect: boolean,
    correctedValue?: unknown,
  ): void {
    // Find the most recent prediction for this session and task
    for (let i = this.events.length - 1; i >= 0; i--) {
      const event = this.events[i];
      if (event.sessionId === sessionId && event.task === task) {
        event.wasCorrect = wasCorrect;
        if (correctedValue !== undefined) {
          event.correctedValue = correctedValue;
        }
        break;
      }
    }
  }

  /**
   * Get raw events (for export/analysis)
   */
  getRawEvents(timeRange?: { from: Date; to: Date }): NLUPredictionEvent[] {
    if (timeRange) {
      return this.events.filter(
        (e) => e.timestamp >= timeRange.from && e.timestamp <= timeRange.to,
      );
    }
    return [...this.events];
  }

  /**
   * Clear all events
   */
  clear(): void {
    this.events = [];
  }
}

// =============================================================================
// HELPERS
// =============================================================================

function groupBy<T>(items: T[], keyFn: (item: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of items) {
    const key = keyFn(item);
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }
  return groups;
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// =============================================================================
// TENANT-SCOPED METRICS
// =============================================================================

/**
 * Wraps per-tenant InMemoryMetricsCollector instances.
 * Provides aggregate metrics across all tenants.
 */
export class TenantScopedMetrics {
  private tenantCollectors = new Map<string, InMemoryMetricsCollector>();
  private maxEvents: number;

  constructor(maxEventsPerTenant: number = 10000) {
    this.maxEvents = maxEventsPerTenant;
  }

  /**
   * Get or create a metrics collector for a tenant.
   */
  getCollectorForTenant(tenantId: string): InMemoryMetricsCollector {
    let collector = this.tenantCollectors.get(tenantId);
    if (!collector) {
      collector = new InMemoryMetricsCollector(this.maxEvents);
      this.tenantCollectors.set(tenantId, collector);
    }
    return collector;
  }

  /**
   * Record a prediction for a specific tenant.
   */
  recordForTenant(tenantId: string, event: NLUPredictionEvent): void {
    this.getCollectorForTenant(tenantId).recordPrediction(event);
  }

  /**
   * Get metrics for a specific tenant.
   */
  getMetricsForTenant(tenantId: string, timeRange?: { from: Date; to: Date }): NLUMetrics {
    const collector = this.tenantCollectors.get(tenantId);
    if (!collector) {
      return { totalPredictions: 0, byTask: {}, byModel: {}, byLanguage: {} };
    }
    return collector.getMetrics(timeRange);
  }

  /**
   * Get aggregate metrics across all tenants.
   */
  getAggregateMetrics(timeRange?: { from: Date; to: Date }): NLUMetrics {
    const aggregate: NLUMetrics = {
      totalPredictions: 0,
      byTask: {},
      byModel: {},
      byLanguage: {},
    };

    for (const collector of this.tenantCollectors.values()) {
      const metrics = collector.getMetrics(timeRange);
      aggregate.totalPredictions += metrics.totalPredictions;

      // Merge byTask
      for (const [task, data] of Object.entries(metrics.byTask)) {
        if (!aggregate.byTask[task]) {
          aggregate.byTask[task] = { ...data };
        } else {
          const existing = aggregate.byTask[task];
          const totalCount = existing.count + data.count;
          existing.avgConfidence =
            (existing.avgConfidence * existing.count + data.avgConfidence * data.count) /
            totalCount;
          existing.avgLatencyMs =
            (existing.avgLatencyMs * existing.count + data.avgLatencyMs * data.count) / totalCount;
          existing.fallbackRate =
            (existing.fallbackRate * existing.count + data.fallbackRate * data.count) / totalCount;
          existing.correctionRate =
            (existing.correctionRate * existing.count + data.correctionRate * data.count) /
            totalCount;
          existing.count = totalCount;
        }
      }

      // Merge byModel
      for (const [model, data] of Object.entries(metrics.byModel)) {
        if (!aggregate.byModel[model]) {
          aggregate.byModel[model] = { ...data };
        } else {
          const existing = aggregate.byModel[model];
          const totalCount = existing.count + data.count;
          existing.avgLatencyMs =
            (existing.avgLatencyMs * existing.count + data.avgLatencyMs * data.count) / totalCount;
          existing.errorRate =
            (existing.errorRate * existing.count + data.errorRate * data.count) / totalCount;
          existing.count = totalCount;
        }
      }

      // Merge byLanguage
      for (const [lang, data] of Object.entries(metrics.byLanguage)) {
        if (!aggregate.byLanguage[lang]) {
          aggregate.byLanguage[lang] = { ...data };
        } else {
          const existing = aggregate.byLanguage[lang];
          const totalCount = existing.count + data.count;
          existing.avgConfidence =
            (existing.avgConfidence * existing.count + data.avgConfidence * data.count) /
            totalCount;
          existing.count = totalCount;
        }
      }
    }

    return aggregate;
  }

  /**
   * Get list of all tracked tenant IDs.
   */
  getTenantIds(): string[] {
    return [...this.tenantCollectors.keys()];
  }

  /**
   * Clear metrics for a specific tenant.
   */
  clearTenant(tenantId: string): void {
    this.tenantCollectors.delete(tenantId);
  }

  /**
   * Clear all tenant metrics.
   */
  clearAll(): void {
    this.tenantCollectors.clear();
  }
}
