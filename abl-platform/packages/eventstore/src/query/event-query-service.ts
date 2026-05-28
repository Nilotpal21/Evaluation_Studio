/**
 * EventQueryService - wraps IEventReader with caching and convenience methods.
 *
 * Features:
 * - Caches query results via ICacheProvider (60s TTL)
 * - Tenant-included cache keys (no cross-tenant leakage)
 * - Convenience methods for common dashboard queries
 * - Delegates to IEventReader for actual queries
 */

import { createHash } from 'crypto';
import type { IEventQueryService, ICacheProvider } from '../interfaces/event-query.js';
import type { IEventReader } from '../interfaces/event-store.js';
import type {
  EventQueryParams,
  EventQueryResult,
  EventAggregateParams,
  EventAggregateResult,
  EventCountParams,
  EventCountResult,
  TimeRange,
} from '../interfaces/types.js';

const SESSION_STARTED_EVENT_TYPES = ['session.started', 'voice.session.started'];
const SESSION_ENDED_EVENT_TYPES = ['session.ended', 'voice.session.ended'];

export interface EventQueryServiceConfig {
  cache?: {
    provider: ICacheProvider;
    ttlSeconds?: number; // default: 60
  };
}

export class EventQueryService implements IEventQueryService {
  private readonly cacheTTL: number;

  constructor(
    private reader: IEventReader,
    private cacheProvider: ICacheProvider | null,
    config?: EventQueryServiceConfig,
  ) {
    this.cacheTTL = config?.cache?.ttlSeconds ?? 60;
  }

  async query(params: EventQueryParams): Promise<EventQueryResult> {
    // Check cache
    const cacheKey = this.getCacheKey('query', params);
    if (this.cacheProvider) {
      const cached = await this.cacheProvider.get(cacheKey);
      if (cached) {
        return JSON.parse(cached) as EventQueryResult;
      }
    }

    // Query store
    const result = await this.reader.query(params);

    // Cache result
    if (this.cacheProvider) {
      await this.cacheProvider.set(cacheKey, JSON.stringify(result), this.cacheTTL);
    }

    return result;
  }

  async aggregate(params: EventAggregateParams): Promise<EventAggregateResult> {
    // Check cache
    const cacheKey = this.getCacheKey('aggregate', params);
    if (this.cacheProvider) {
      const cached = await this.cacheProvider.get(cacheKey);
      if (cached) {
        return JSON.parse(cached) as EventAggregateResult;
      }
    }

    // Query store
    const result = await this.reader.aggregate(params);

    // Cache result
    if (this.cacheProvider) {
      await this.cacheProvider.set(cacheKey, JSON.stringify(result), this.cacheTTL);
    }

    return result;
  }

  async count(params: EventCountParams): Promise<EventCountResult> {
    // Check cache
    const cacheKey = this.getCacheKey('count', params);
    if (this.cacheProvider) {
      const cached = await this.cacheProvider.get(cacheKey);
      if (cached) {
        return JSON.parse(cached) as EventCountResult;
      }
    }

    // Query store
    const result = await this.reader.count(params);

    // Cache result
    if (this.cacheProvider) {
      await this.cacheProvider.set(cacheKey, JSON.stringify(result), this.cacheTTL);
    }

    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Convenience Methods
  // ═══════════════════════════════════════════════════════════════════════════

  async getEventCounts(
    tenantId: string,
    projectId: string,
    timeRange: TimeRange,
  ): Promise<EventCountResult> {
    return this.count({
      tenantId,
      projectId,
      timeRange,
      groupBy: 'category',
    });
  }

  async getSessionMetrics(
    tenantId: string,
    projectId: string,
    timeRange: TimeRange,
  ): Promise<{
    totalSessions: number;
    completedSessions: number;
    completionRate: number;
    avgDurationMs: number;
    avgCost: number;
  }> {
    // Count session lifecycle events using the same vocabulary as analytics session explorers.
    const startedResult = await this.aggregate({
      tenantId,
      projectId,
      timeRange,
      groupBy: [],
      metrics: ['count'],
      filters: {
        eventTypes: SESSION_STARTED_EVENT_TYPES,
      },
    });

    // Count completed sessions and get duration/cost from session end events (if available).
    const endedResult = await this.aggregate({
      tenantId,
      projectId,
      timeRange,
      groupBy: [],
      metrics: ['count', 'avg_duration'],
      filters: {
        eventTypes: SESSION_ENDED_EVENT_TYPES,
      },
    });

    const startedBucket = startedResult.buckets[0] || {};
    const endedBucket = endedResult.buckets[0] || {};

    const totalSessions = Number(startedBucket.count) || 0;
    const completedSessions = Number(endedBucket.count) || 0;
    const completionRate = totalSessions > 0 ? (completedSessions / totalSessions) * 100 : 0;
    const avgDurationMs = Number(endedBucket.avg_duration) || 0;

    return {
      totalSessions,
      completedSessions,
      completionRate,
      avgDurationMs,
      avgCost: 0, // Cost not yet tracked per-session
    };
  }

  async getCostBreakdown(
    tenantId: string,
    projectId: string,
    timeRange: TimeRange,
  ): Promise<
    Array<{
      model: string;
      provider: string;
      callCount: number;
      totalTokens: number;
      totalCost: number;
    }>
  > {
    const result = await this.aggregate({
      tenantId,
      projectId,
      timeRange,
      groupBy: ['data_model', 'data_provider'],
      metrics: ['count', 'sum_tokens', 'sum_cost'],
      filters: {
        eventTypes: ['llm.call.completed'],
      },
      dataField: 'total_tokens', // For sum_tokens metric
    });

    return result.buckets.map((bucket) => ({
      model: String(bucket.model || 'unknown'),
      provider: String(bucket.provider || 'unknown'),
      callCount: Number(bucket.count) || 0,
      totalTokens: Number(bucket.sum_tokens) || 0,
      totalCost: Number(bucket.sum_cost) || 0,
    }));
  }

  /**
   * Generate cache key with tenant isolation.
   */
  private getCacheKey(operation: string, params: unknown): string {
    const hash = createHash('sha256')
      .update(JSON.stringify({ operation, params }))
      .digest('hex')
      .slice(0, 16);

    // Extract tenant ID for isolation
    const tenantId =
      typeof params === 'object' && params !== null && 'tenantId' in params
        ? String((params as { tenantId: string }).tenantId)
        : 'unknown';

    return `eventstore:${tenantId}:${operation}:${hash}`;
  }
}
