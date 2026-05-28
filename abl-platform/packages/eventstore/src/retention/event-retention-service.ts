/**
 * EventRetentionService - enforces plan-based retention policies.
 *
 * Delegates to IEventLifecycle for:
 * - purgeExpired: Delete events older than totalRetentionDays
 * - scrubPII: Anonymize PII in events older than piiRetentionDays
 *
 * Called by platform retention scheduler (daily cron).
 */

import type { IEventRetention, RetentionPolicy } from '../interfaces/event-retention.js';
import type { IEventLifecycle } from '../interfaces/event-store.js';
import type { PurgeResult } from '../interfaces/types.js';
import { eventRegistry } from '../schema/event-registry.js';

export class EventRetentionService implements IEventRetention {
  constructor(private lifecycle: IEventLifecycle) {}

  async runRetention(
    tenantId: string,
    policy: RetentionPolicy,
  ): Promise<{ deleted: number; scrubbed: number }> {
    const now = new Date();

    // Calculate cutoff dates
    const purgeCutoff = new Date(
      now.getTime() - policy.events.totalRetentionDays * 24 * 60 * 60 * 1000,
    );
    const piiCutoff = new Date(
      now.getTime() - policy.events.piiRetentionDays * 24 * 60 * 60 * 1000,
    );

    // Purge expired events
    const purgeResult = await this.lifecycle.purgeExpired(tenantId, purgeCutoff);

    // Scrub PII (only if PII retention is shorter than total retention)
    let scrubbed = 0;
    if (policy.events.piiRetentionDays < policy.events.totalRetentionDays) {
      const piiEventTypes = eventRegistry.getPIIEventTypes();
      if (piiEventTypes.length > 0) {
        await this.lifecycle.scrubPII(tenantId, piiCutoff, piiEventTypes);
        scrubbed = piiEventTypes.length; // Estimate (actual count not available)
      }
    }

    return {
      deleted: purgeResult.deletedEstimate,
      scrubbed,
    };
  }

  async purgeExpired(tenantId: string, olderThan: Date): Promise<PurgeResult> {
    return this.lifecycle.purgeExpired(tenantId, olderThan);
  }
}
