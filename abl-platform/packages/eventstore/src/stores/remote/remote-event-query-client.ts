/**
 * RemoteEventQueryClient - HTTP client implementing IEventReader.
 *
 * Used in 'remote' mode where runtime pods delegate queries to a standalone
 * event storage service via HTTP API.
 *
 * Flow:
 *   Runtime pod → RemoteEventQueryClient → HTTP POST → Event Storage Service → ClickHouse
 */

import type { IEventReader } from '../../interfaces/event-store.js';
import type {
  EventQueryParams,
  EventQueryResult,
  EventAggregateParams,
  EventAggregateResult,
  EventCountParams,
  EventCountResult,
} from '../../interfaces/types.js';

export class RemoteEventQueryClient implements IEventReader {
  constructor(private baseUrl: string) {}

  async query(params: EventQueryParams): Promise<EventQueryResult> {
    const res = await fetch(`${this.baseUrl}/api/events/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...params,
        timeRange: {
          from: params.timeRange.from.toISOString(),
          to: params.timeRange.to.toISOString(),
        },
      }),
    });

    if (!res.ok) {
      throw new Error(`Remote query failed: ${res.status} ${res.statusText}`);
    }

    const result = (await res.json()) as EventQueryResult;

    // Deserialize timestamp strings back to Date objects
    result.events = result.events.map((event) => {
      const evt = event as Record<string, unknown>;
      return {
        ...evt,
        timestamp: new Date(evt.timestamp as string),
      };
    });

    return result;
  }

  async aggregate(params: EventAggregateParams): Promise<EventAggregateResult> {
    const res = await fetch(`${this.baseUrl}/api/events/aggregate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...params,
        timeRange: {
          from: params.timeRange.from.toISOString(),
          to: params.timeRange.to.toISOString(),
        },
      }),
    });

    if (!res.ok) {
      throw new Error(`Remote aggregate failed: ${res.status} ${res.statusText}`);
    }

    return res.json() as Promise<EventAggregateResult>;
  }

  async count(params: EventCountParams): Promise<EventCountResult> {
    const res = await fetch(`${this.baseUrl}/api/events/count`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...params,
        timeRange: {
          from: params.timeRange.from.toISOString(),
          to: params.timeRange.to.toISOString(),
        },
      }),
    });

    if (!res.ok) {
      throw new Error(`Remote count failed: ${res.status} ${res.statusText}`);
    }

    return res.json() as Promise<EventCountResult>;
  }
}
