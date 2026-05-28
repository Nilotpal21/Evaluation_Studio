/**
 * Event retention service interface.
 *
 * Enforces plan-based retention policies by delegating to IEventLifecycle.
 * Called by the platform retention scheduler (daily cron).
 */

import type { PurgeResult } from './types.js';

export interface RetentionPolicy {
  events: {
    totalRetentionDays: number; // DELETE events older than this
    piiRetentionDays: number; // ANONYMIZE PII in events older than this
  };
}

export interface IEventRetention {
  /**
   * Run retention for a tenant based on their plan policy.
   * Purges events older than totalRetentionDays, scrubs PII older than piiRetentionDays.
   */
  runRetention(
    tenantId: string,
    policy: RetentionPolicy,
  ): Promise<{ deleted: number; scrubbed: number }>;

  /**
   * Purge expired events for a tenant (manual trigger).
   */
  purgeExpired(tenantId: string, olderThan: Date): Promise<PurgeResult>;
}
