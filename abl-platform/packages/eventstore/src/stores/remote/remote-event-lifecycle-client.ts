/**
 * RemoteEventLifecycleClient - HTTP client implementing IEventLifecycle.
 *
 * Used in 'remote' mode where runtime pods delegate retention and GDPR operations
 * to a standalone event storage service via HTTP API.
 *
 * Flow:
 *   Runtime pod → RemoteEventLifecycleClient → HTTP POST → Event Storage Service → ClickHouse
 */

import type { IEventLifecycle } from '../../interfaces/event-store.js';
import type { PurgeResult } from '../../interfaces/types.js';

export class RemoteEventLifecycleClient implements IEventLifecycle {
  constructor(private baseUrl: string) {}

  async purgeExpired(tenantId: string, olderThan: Date): Promise<PurgeResult> {
    const res = await fetch(`${this.baseUrl}/api/events/retention/purge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantId,
        olderThan: olderThan.toISOString(),
      }),
    });

    if (!res.ok) {
      throw new Error(`Remote purge failed: ${res.status} ${res.statusText}`);
    }

    return res.json() as Promise<PurgeResult>;
  }

  async scrubPII(tenantId: string, olderThan: Date, eventTypes: string[]): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/events/retention/scrub-pii`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantId,
        olderThan: olderThan.toISOString(),
        eventTypes,
      }),
    });

    if (!res.ok) {
      throw new Error(`Remote scrubPII failed: ${res.status} ${res.statusText}`);
    }
  }

  async deleteBySessionIds(tenantId: string, sessionIds: string[]): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/events/gdpr/delete-sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantId,
        sessionIds,
      }),
    });

    if (!res.ok) {
      throw new Error(`Remote deleteBySessionIds failed: ${res.status} ${res.statusText}`);
    }
  }

  async anonymizeActor(tenantId: string, actorId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/events/gdpr/anonymize-actor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantId,
        actorId,
      }),
    });

    if (!res.ok) {
      throw new Error(`Remote anonymizeActor failed: ${res.status} ${res.statusText}`);
    }
  }

  async deleteTenant(tenantId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/events/gdpr/delete-tenant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantId,
      }),
    });

    if (!res.ok) {
      throw new Error(`Remote deleteTenant failed: ${res.status} ${res.statusText}`);
    }
  }
}
