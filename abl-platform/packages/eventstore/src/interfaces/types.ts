/**
 * Shared types for event queries and results.
 * These are backend-agnostic - no ClickHouse, MongoDB, or any DB-specific types.
 */

export interface TimeRange {
  from: Date;
  to: Date;
}

export type EventCategory =
  | 'billing'
  | 'session'
  | 'message'
  | 'attachment'
  | 'llm'
  | 'tool'
  | 'agent'
  | 'gather'
  | 'flow'
  | 'channel'
  | 'deployment'
  | 'search'
  | 'voice'
  | 'audit'
  | 'evaluation'
  | 'feedback'
  | 'system';

/** Query parameters for retrieving raw events */
export interface EventQueryParams {
  tenantId: string;
  projectId: string;
  timeRange: TimeRange;
  category?: EventCategory;
  eventTypes?: string[];
  sessionId?: string;
  agentName?: string;
  hasError?: boolean;
  limit?: number; // default 100, max 10000
  offset?: number;
}

export interface EventQueryResult {
  events: unknown[]; // Will be typed as PlatformEvent[] in implementation
  total: number;
  hasMore: boolean;
}

/** Aggregation parameters for GROUP BY queries */
export interface EventAggregateParams {
  tenantId: string;
  projectId: string;
  timeRange: TimeRange;
  groupBy: (
    | 'category'
    | 'event_type'
    | 'agent_name'
    | 'channel'
    | 'hour'
    | 'day'
    | 'data_model'
    | 'data_provider'
  )[];
  metrics: ('count' | 'avg_duration' | 'error_rate' | 'p95_duration' | 'sum_tokens' | 'sum_cost')[];
  filters?: {
    category?: EventCategory;
    eventTypes?: string[];
    hasError?: boolean;
  };
  /** Optional: extract a numeric field from data JSON for aggregation */
  dataField?: string;
}

export interface EventAggregateResult {
  buckets: Record<string, unknown>[];
}

/** Count parameters - simplified aggregation */
export interface EventCountParams {
  tenantId: string;
  projectId: string;
  timeRange: TimeRange;
  groupBy: 'category' | 'event_type' | 'agent_name' | 'channel';
  filters?: {
    category?: EventCategory;
    hasError?: boolean;
  };
}

export interface EventCountResult {
  counts: Array<{ key: string; count: number; errorCount: number }>;
}

/** Purge result from retention operations */
export interface PurgeResult {
  /** Estimated rows affected. -1 if backend doesn't support exact counts. */
  deletedEstimate: number;
}
