/**
 * Azure DI usage counter — month-boundary CAS reset + atomic `$inc`.
 *
 * LLD §3 Phase 3 Task 3.12. Two-step pattern:
 *
 * 1. Try to CAS the doc into "first usage in this month": match on
 *    `usagePeriodStart === null` OR `usagePeriodStart < currentMonthStart`
 *    and `$set: { usageCount: 1, usagePeriodStart: currentMonthStart }`.
 *    Exactly one caller wins the race and resets the counter; others fall
 *    through to step 2.
 *
 * 2. Loser path: `$inc: { usageCount: 1 }` against the now-current-month doc.
 *    Tenant-scoped so cross-tenant requests can't corrupt each other.
 *
 * The pattern is correct under concurrent extractions on day 1 of a new
 * month: only one CAS matches the stale `usagePeriodStart`; subsequent
 * concurrent writes increment a doc that's already been reset, so the
 * final `usageCount` equals the number of successful extractions.
 *
 * The exported `checkUsage` is a read-only helper that powers the pre-call
 * hard-cap check (no DB write).
 */

import type { IConnectorConnection } from '@agent-platform/database';
import { recordAzureDICapUsage } from '../observability/extraction-metrics.js';

/** Lift current-month-start to a stable Date — handy for testing via injection. */
export function currentMonthStartUTC(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Minimal Mongoose-shaped facade — avoids tight coupling on the model itself. */
export interface ConnectorConnectionModelLike {
  findOne(filter: Record<string, unknown>): Promise<IConnectorConnection | null>;
  findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<IConnectorConnection | null>;
}

/** Snapshot returned to the Azure DI piece for the pre-call hard-cap check. */
export interface AzureDIUsageSnapshot {
  usageCount: number;
  usageSoftCap: number | null;
  usageHardCap: number | null;
  usagePeriodStart: Date | null;
}

/** Returned by `recordUsage` after the increment lands. */
export interface AzureDIUsageIncrement {
  usageCount: number;
  usagePeriodStart: Date;
}

export interface AzureDIUsageCounterDeps {
  model: ConnectorConnectionModelLike;
  tenantId: string;
  projectId: string;
  now?: () => Date;
}

export class AzureDIUsageCounter {
  constructor(private readonly deps: AzureDIUsageCounterDeps) {}

  /**
   * Read the current usage snapshot for a `ConnectorConnection`. Returns `null`
   * when the connection is missing — the Azure DI piece treats this as "no
   * hard cap" (the connection guard upstream blocks runs against deleted
   * connections; this snapshot is informational).
   */
  async checkUsage(connectionId: string): Promise<AzureDIUsageSnapshot | null> {
    const doc = await this.deps.model.findOne({
      _id: connectionId,
      tenantId: this.deps.tenantId,
      projectId: this.deps.projectId,
      status: 'active',
    });
    if (!doc) return null;
    return {
      usageCount: typeof doc.usageCount === 'number' ? doc.usageCount : 0,
      usageSoftCap:
        typeof doc.usageSoftCap === 'number' || doc.usageSoftCap === null
          ? (doc.usageSoftCap ?? null)
          : null,
      usageHardCap:
        typeof doc.usageHardCap === 'number' || doc.usageHardCap === null
          ? (doc.usageHardCap ?? null)
          : null,
      usagePeriodStart: doc.usagePeriodStart ?? null,
    };
  }

  /**
   * Month-boundary CAS reset + `$inc`. Returns the post-increment snapshot.
   *
   * Throws when the connection is missing or has been revoked.
   */
  async recordUsage(connectionId: string): Promise<AzureDIUsageIncrement> {
    const currentMonthStart = currentMonthStartUTC(this.deps.now?.());

    // Step 1: CAS reset on month rollover or first use.
    const reset = await this.deps.model.findOneAndUpdate(
      {
        _id: connectionId,
        tenantId: this.deps.tenantId,
        projectId: this.deps.projectId,
        status: 'active',
        $or: [
          { usagePeriodStart: null },
          { usagePeriodStart: { $exists: false } },
          { usagePeriodStart: { $lt: currentMonthStart } },
        ],
      },
      { $set: { usageCount: 1, usagePeriodStart: currentMonthStart } },
      { new: true },
    );
    if (reset) {
      this.emitCapMetric(connectionId, reset.usageCount ?? 1, reset);
      return {
        usageCount: reset.usageCount ?? 1,
        usagePeriodStart: reset.usagePeriodStart ?? currentMonthStart,
      };
    }

    // Step 2: loser path — `$inc` against the now-current-month doc.
    const incremented = await this.deps.model.findOneAndUpdate(
      {
        _id: connectionId,
        tenantId: this.deps.tenantId,
        projectId: this.deps.projectId,
        status: 'active',
      },
      { $inc: { usageCount: 1 } },
      { new: true },
    );
    if (!incremented) {
      throw new Error(
        `Azure DI usage increment failed: connection ${connectionId} missing or revoked`,
      );
    }
    this.emitCapMetric(connectionId, incremented.usageCount ?? 0, incremented);
    return {
      usageCount: incremented.usageCount ?? 0,
      usagePeriodStart: incremented.usagePeriodStart ?? currentMonthStart,
    };
  }

  private emitCapMetric(connectionId: string, usageCount: number, doc: IConnectorConnection): void {
    const usageSoftCap =
      typeof doc.usageSoftCap === 'number' || doc.usageSoftCap === null
        ? (doc.usageSoftCap ?? null)
        : null;
    const usageHardCap =
      typeof doc.usageHardCap === 'number' || doc.usageHardCap === null
        ? (doc.usageHardCap ?? null)
        : null;
    recordAzureDICapUsage({
      connectionId,
      tenant: this.deps.tenantId,
      project: this.deps.projectId,
      usageCount,
      usageSoftCap,
      usageHardCap,
    });
  }
}
