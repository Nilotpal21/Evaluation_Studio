/**
 * Pluggable event storage interface.
 *
 * This is the core abstraction that makes the entire persistence layer swappable.
 * Every component (emitter, query service, retention, GDPR) depends on this interface
 * — never on ClickHouse, MongoDB, or any specific database.
 *
 * Implementations:
 * - ClickHouseEventStore (production)
 * - MemoryEventStore (tests)
 * - RemoteEventQueryClient + RemoteEventLifecycleClient (standalone service mode)
 */

import type {
  EventQueryParams,
  EventQueryResult,
  EventAggregateParams,
  EventAggregateResult,
  EventCountParams,
  EventCountResult,
  PurgeResult,
} from './types.js';

/**
 * Write operations — fire-and-forget, non-blocking
 */
export interface IEventWriter {
  /**
   * Append a single event. Must be non-blocking (fire-and-forget).
   * The event is buffered internally and flushed asynchronously.
   */
  write(event: unknown): void;

  /**
   * Append a batch of events. Must be non-blocking.
   */
  writeBatch(events: unknown[]): void;

  /**
   * Flush any buffered events to storage.
   * Blocks until the buffer is written.
   */
  flush(): Promise<void>;

  /**
   * Graceful shutdown: flush remaining buffer, release connections.
   */
  close(): Promise<void>;

  /**
   * Number of events currently buffered (for monitoring).
   */
  readonly pendingCount: number;
}

/**
 * Read operations — query and aggregation
 */
export interface IEventReader {
  /**
   * Query raw events with filtering + pagination.
   */
  query(params: EventQueryParams): Promise<EventQueryResult>;

  /**
   * Aggregate events (GROUP BY + metrics).
   */
  aggregate(params: EventAggregateParams): Promise<EventAggregateResult>;

  /**
   * Count events grouped by a dimension.
   */
  count(params: EventCountParams): Promise<EventCountResult>;
}

/**
 * Lifecycle operations (retention + GDPR)
 */
export interface IEventLifecycle {
  /**
   * Delete events older than cutoff for a tenant.
   * Used by the retention scheduler for plan-based TTLs.
   */
  purgeExpired(tenantId: string, olderThan: Date): Promise<PurgeResult>;

  /**
   * Anonymize PII in event data for events matching criteria.
   * Replaces `data` field with `{"anonymized": true}` for PII-bearing event types.
   */
  scrubPII(tenantId: string, olderThan: Date, eventTypes: string[]): Promise<void>;

  /**
   * Delete all events for specific sessions (GDPR cascade).
   * Called during session deletion.
   */
  deleteBySessionIds(tenantId: string, sessionIds: string[]): Promise<void>;

  /**
   * Anonymize actor identity across all events (GDPR right-to-erasure).
   * Replaces `actor_id` with '[ANONYMIZED:hash]'.
   */
  anonymizeActor(tenantId: string, actorId: string): Promise<void>;

  /**
   * Delete ALL events for a tenant (tenant offboarding).
   */
  deleteTenant(tenantId: string): Promise<void>;
}

/**
 * Combined: the full store contract.
 * Implementations must satisfy all three sub-interfaces.
 */
export interface IEventStore extends IEventWriter, IEventReader, IEventLifecycle {
  /**
   * Human-readable backend name for logging (e.g. "clickhouse", "postgres", "memory").
   */
  readonly backendName: string;
}
