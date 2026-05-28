/**
 * MemoryEventStore - in-memory storage for tests.
 *
 * Implements IEventStore using in-memory arrays with:
 * - Simple array filtering (no indexes, not optimized)
 * - Full IEventStore contract implementation
 * - Behavioral equivalence to ClickHouseEventStore
 * - Used in tests and for backend swap verification
 */

import type { IEventStore } from '../../interfaces/event-store.js';
import type {
  EventQueryParams,
  EventQueryResult,
  EventAggregateParams,
  EventAggregateResult,
  EventCountParams,
  EventCountResult,
  PurgeResult,
} from '../../interfaces/types.js';
import type { PlatformEvent } from '../../schema/platform-event.js';

export interface MemoryEventStoreConfig {
  maxSize?: number; // default: 100000
}

export class MemoryEventStore implements IEventStore {
  readonly backendName = 'memory';
  private events: PlatformEvent[] = [];
  private readonly maxSize: number;

  constructor(config?: MemoryEventStoreConfig) {
    this.maxSize = config?.maxSize ?? 100_000;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // IEventWriter Implementation
  // ═══════════════════════════════════════════════════════════════════════════

  write(event: unknown): void {
    const platformEvent = event as PlatformEvent;
    if (this.events.length >= this.maxSize) {
      // Drop oldest event to prevent unbounded growth
      this.events.shift();
    }
    this.events.push(platformEvent);
  }

  writeBatch(events: unknown[]): void {
    events.forEach((event) => this.write(event));
  }

  async flush(): Promise<void> {
    // No-op - already in memory
  }

  async close(): Promise<void> {
    this.events = [];
  }

  get pendingCount(): number {
    return 0; // No buffering - events written immediately
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // IEventReader Implementation
  // ═══════════════════════════════════════════════════════════════════════════

  async query(params: EventQueryParams): Promise<EventQueryResult> {
    const limit = Math.min(params.limit ?? 100, 10_000);
    const offset = params.offset ?? 0;

    // Filter events
    let filtered = this.events.filter((event) => {
      if (event.tenant_id !== params.tenantId) return false;
      if (event.project_id !== params.projectId) return false;
      if (event.timestamp < params.timeRange.from) return false;
      if (event.timestamp > params.timeRange.to) return false;

      if (params.category && event.category !== params.category) return false;

      if (params.eventTypes && !params.eventTypes.includes(event.event_type)) return false;

      if (params.sessionId && event.session_id !== params.sessionId) return false;

      if (params.agentName && event.agent_name !== params.agentName) return false;

      if (params.hasError !== undefined && event.has_error !== params.hasError) return false;

      return true;
    });

    // Sort by timestamp DESC (most recent first)
    filtered.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    const total = filtered.length;
    const paginatedEvents = filtered.slice(offset, offset + limit);

    return {
      events: paginatedEvents,
      total,
      hasMore: offset + paginatedEvents.length < total,
    };
  }

  async aggregate(params: EventAggregateParams): Promise<EventAggregateResult> {
    // Filter events
    let filtered = this.events.filter((event) => {
      if (event.tenant_id !== params.tenantId) return false;
      if (event.project_id !== params.projectId) return false;
      if (event.timestamp < params.timeRange.from) return false;
      if (event.timestamp > params.timeRange.to) return false;

      if (params.filters?.category && event.category !== params.filters.category) return false;

      if (params.filters?.eventTypes && !params.filters.eventTypes.includes(event.event_type)) {
        return false;
      }

      if (params.filters?.hasError !== undefined && event.has_error !== params.filters.hasError) {
        return false;
      }

      return true;
    });

    // Group events
    const groups = new Map<string, PlatformEvent[]>();

    for (const event of filtered) {
      const key = params.groupBy
        .map((field) => {
          switch (field) {
            case 'hour':
              return new Date(event.timestamp).setMinutes(0, 0, 0).toString();
            case 'day':
              return new Date(event.timestamp).toISOString().split('T')[0];
            case 'category':
              return event.category;
            case 'event_type':
              return event.event_type;
            case 'agent_name':
              return event.agent_name ?? '';
            case 'channel':
              return event.channel ?? '';
            case 'data_model': {
              const d =
                typeof event.data === 'object' && event.data !== null
                  ? (event.data as Record<string, unknown>)
                  : {};
              return String(d.model || 'unknown');
            }
            case 'data_provider': {
              const d =
                typeof event.data === 'object' && event.data !== null
                  ? (event.data as Record<string, unknown>)
                  : {};
              return String(d.provider || 'unknown');
            }
            default:
              return '';
          }
        })
        .join('|');

      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(event);
    }

    // Compute metrics for each group
    const buckets: Record<string, unknown>[] = [];

    for (const [key, groupEvents] of groups) {
      const bucket: Record<string, unknown> = {};

      // Add group-by fields (use aliases for JSON-extracted fields)
      const keyParts = key.split('|');
      params.groupBy.forEach((field, i) => {
        const alias =
          field === 'data_model' ? 'model' : field === 'data_provider' ? 'provider' : field;
        bucket[alias] = keyParts[i];
      });

      // Compute metrics
      for (const metric of params.metrics) {
        switch (metric) {
          case 'count':
            bucket.count = groupEvents.length;
            break;
          case 'avg_duration':
            bucket.avg_duration =
              groupEvents.reduce((sum, e) => sum + (e.duration_ms ?? 0), 0) / groupEvents.length;
            break;
          case 'error_rate':
            bucket.error_rate =
              (groupEvents.filter((e) => e.has_error).length / groupEvents.length) * 100;
            break;
          case 'p95_duration':
            const durations = groupEvents.map((e) => e.duration_ms ?? 0).sort((a, b) => a - b);
            const p95Index = Math.floor(durations.length * 0.95);
            bucket.p95_duration = durations[p95Index] ?? 0;
            break;
          case 'sum_tokens':
            if (params.dataField) {
              bucket.sum_tokens = groupEvents.reduce(
                (sum, e) => sum + (Number(e.data[params.dataField!]) || 0),
                0,
              );
            }
            break;
          case 'sum_cost':
            if (params.dataField) {
              bucket.sum_cost = groupEvents.reduce(
                (sum, e) => sum + (Number(e.data[params.dataField!]) || 0),
                0,
              );
            }
            break;
        }
      }

      buckets.push(bucket);
    }

    return { buckets };
  }

  async count(params: EventCountParams): Promise<EventCountResult> {
    // Filter events
    let filtered = this.events.filter((event) => {
      if (event.tenant_id !== params.tenantId) return false;
      if (event.project_id !== params.projectId) return false;
      if (event.timestamp < params.timeRange.from) return false;
      if (event.timestamp > params.timeRange.to) return false;

      if (params.filters?.category && event.category !== params.filters.category) return false;

      if (params.filters?.hasError !== undefined && event.has_error !== params.filters.hasError) {
        return false;
      }

      return true;
    });

    // Group and count
    const counts = new Map<string, { count: number; errorCount: number }>();

    for (const event of filtered) {
      const key = String(
        params.groupBy === 'category'
          ? event.category
          : params.groupBy === 'event_type'
            ? event.event_type
            : params.groupBy === 'agent_name'
              ? (event.agent_name ?? '')
              : params.groupBy === 'channel'
                ? (event.channel ?? '')
                : '',
      );

      if (!counts.has(key)) {
        counts.set(key, { count: 0, errorCount: 0 });
      }

      const stats = counts.get(key)!;
      stats.count++;
      if (event.has_error) stats.errorCount++;
    }

    return {
      counts: Array.from(counts.entries())
        .map(([key, stats]) => ({
          key,
          count: stats.count,
          errorCount: stats.errorCount,
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 100),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // IEventLifecycle Implementation
  // ═══════════════════════════════════════════════════════════════════════════

  async purgeExpired(tenantId: string, olderThan: Date): Promise<PurgeResult> {
    const before = this.events.length;
    this.events = this.events.filter(
      (event) => !(event.tenant_id === tenantId && event.timestamp < olderThan),
    );
    return { deletedEstimate: before - this.events.length };
  }

  async scrubPII(tenantId: string, olderThan: Date, eventTypes: string[]): Promise<void> {
    for (const event of this.events) {
      if (
        event.tenant_id === tenantId &&
        event.timestamp < olderThan &&
        eventTypes.includes(event.event_type)
      ) {
        event.data = { anonymized: true };
        delete event.error_message;
        delete event.error_type;
        delete event.metadata;
      }
    }
  }

  async deleteBySessionIds(tenantId: string, sessionIds: string[]): Promise<void> {
    this.events = this.events.filter(
      (event) =>
        !(
          event.tenant_id === tenantId &&
          event.session_id &&
          sessionIds.includes(event.session_id)
        ),
    );
  }

  async anonymizeActor(tenantId: string, actorId: string): Promise<void> {
    for (const event of this.events) {
      if (event.tenant_id === tenantId && event.actor_id === actorId) {
        event.actor_id = `[ANONYMIZED:${actorId.slice(0, 8)}]`;
      }
    }
  }

  async deleteTenant(tenantId: string): Promise<void> {
    this.events = this.events.filter((event) => event.tenant_id !== tenantId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Test Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Test helper: get all events (bypasses query filtering).
   */
  getAllEvents(): PlatformEvent[] {
    return [...this.events];
  }

  /**
   * Test helper: get event count.
   */
  getEventCount(): number {
    return this.events.length;
  }

  /**
   * Test helper: clear all events.
   */
  clear(): void {
    this.events = [];
  }
}
