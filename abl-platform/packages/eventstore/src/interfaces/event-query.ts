/**
 * Event query service interface.
 *
 * Wraps IEventReader with caching (via ICacheProvider) and convenience methods.
 * Provides high-level query operations for Studio UI dashboards.
 */

import type {
  EventQueryParams,
  EventQueryResult,
  EventAggregateParams,
  EventAggregateResult,
  EventCountParams,
  EventCountResult,
  TimeRange,
} from './types.js';

export interface IEventQueryService {
  /**
   * Query raw events (delegates to store with caching).
   */
  query(params: EventQueryParams): Promise<EventQueryResult>;

  /**
   * Aggregate events (delegates to store with caching).
   */
  aggregate(params: EventAggregateParams): Promise<EventAggregateResult>;

  /**
   * Count events (delegates to store with caching).
   */
  count(params: EventCountParams): Promise<EventCountResult>;

  /**
   * Convenience: Get event counts by category for a time range.
   */
  getEventCounts(
    tenantId: string,
    projectId: string,
    timeRange: TimeRange,
  ): Promise<EventCountResult>;

  /**
   * Convenience: Get session metrics (completion rate, avg duration, cost).
   */
  getSessionMetrics(
    tenantId: string,
    projectId: string,
    timeRange: TimeRange,
  ): Promise<{
    totalSessions: number;
    completedSessions: number;
    completionRate: number;
    avgDurationMs: number;
    avgCost: number;
  }>;

  /**
   * Convenience: Get LLM cost breakdown by model.
   */
  getCostBreakdown(
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
  >;
}

/**
 * Cache provider interface (Redis or in-memory).
 */
export interface ICacheProvider {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}
