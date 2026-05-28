/**
 * Azure DI usage counter — unit tests (LLD §3 Phase 3 Task 3.12).
 *
 * Exercises the month-boundary CAS reset against a stub model that mimics
 * Mongoose `findOneAndUpdate`'s atomic semantics. Covers:
 *
 *   - First-use seeding (usagePeriodStart == null → reset to 1)
 *   - Same-month increment (`$inc` path)
 *   - Month-rollover CAS reset under concurrent racing increments
 *   - Tenant scoping (cross-tenant docs are not touched)
 *   - Hard-cap pre-call snapshot (`checkUsage`)
 */

import { describe, it, expect } from 'vitest';
import {
  AzureDIUsageCounter,
  currentMonthStartUTC,
  type ConnectorConnectionModelLike,
} from '../services/azure-di-usage-counter.js';
import type { IConnectorConnection } from '@agent-platform/database';

interface FakeDoc extends Partial<IConnectorConnection> {
  _id: string;
  tenantId: string;
  projectId: string;
  status: 'active' | 'expired' | 'revoked';
}

function makeFakeModel(initial: FakeDoc[] = []): ConnectorConnectionModelLike & {
  state(): FakeDoc[];
} {
  const docs = initial.map((d) => ({ ...d }));

  function matches(doc: FakeDoc, filter: Record<string, unknown>): boolean {
    if (filter._id !== undefined && doc._id !== filter._id) return false;
    if (filter.tenantId !== undefined && doc.tenantId !== filter.tenantId) return false;
    if (filter.projectId !== undefined && doc.projectId !== filter.projectId) return false;
    if (filter.status !== undefined && doc.status !== filter.status) return false;
    if (filter.$or !== undefined) {
      const ors = filter.$or as Array<Record<string, unknown>>;
      const hit = ors.some((sub) => {
        if (sub.usagePeriodStart === null && doc.usagePeriodStart == null) return true;
        if (typeof sub.usagePeriodStart === 'object' && sub.usagePeriodStart !== null) {
          const cond = sub.usagePeriodStart as Record<string, unknown>;
          if (cond.$exists === false && doc.usagePeriodStart === undefined) return true;
          if (cond.$lt !== undefined) {
            if (doc.usagePeriodStart === undefined || doc.usagePeriodStart === null) {
              return false;
            }
            return doc.usagePeriodStart.getTime() < (cond.$lt as Date).getTime();
          }
        }
        return false;
      });
      if (!hit) return false;
    }
    return true;
  }

  return {
    state: () => docs.map((d) => ({ ...d })),
    findOne: async (filter) => {
      const hit = docs.find((d) => matches(d, filter as Record<string, unknown>));
      return hit ? ({ ...hit } as IConnectorConnection) : null;
    },
    findOneAndUpdate: async (filter, update) => {
      const idx = docs.findIndex((d) => matches(d, filter as Record<string, unknown>));
      if (idx < 0) return null;
      const doc = docs[idx]!;
      const set = (update as { $set?: Record<string, unknown> }).$set ?? {};
      const inc = (update as { $inc?: Record<string, number> }).$inc ?? {};
      if (set.usageCount !== undefined) doc.usageCount = set.usageCount as number;
      if (set.usagePeriodStart !== undefined) {
        doc.usagePeriodStart = set.usagePeriodStart as Date;
      }
      for (const [field, delta] of Object.entries(inc)) {
        const f = field as keyof FakeDoc;
        const current = typeof doc[f] === 'number' ? (doc[f] as number) : 0;
        (doc as unknown as Record<string, unknown>)[f] = current + delta;
      }
      return { ...doc } as IConnectorConnection;
    },
  };
}

describe('currentMonthStartUTC', () => {
  it('returns the UTC first-of-month at 00:00:00.000', () => {
    const mid = new Date('2026-03-15T10:00:00.000Z');
    const start = currentMonthStartUTC(mid);
    expect(start.toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });
});

describe('AzureDIUsageCounter.checkUsage', () => {
  it('returns the snapshot for an active connection', async () => {
    const model = makeFakeModel([
      {
        _id: 'c-1',
        tenantId: 't-1',
        projectId: 'p-1',
        status: 'active',
        usageCount: 17,
        usagePeriodStart: new Date('2026-05-01T00:00:00.000Z'),
        usageSoftCap: 50,
        usageHardCap: 100,
      },
    ]);
    const counter = new AzureDIUsageCounter({ model, tenantId: 't-1', projectId: 'p-1' });
    const snap = await counter.checkUsage('c-1');
    expect(snap).toEqual({
      usageCount: 17,
      usageSoftCap: 50,
      usageHardCap: 100,
      usagePeriodStart: new Date('2026-05-01T00:00:00.000Z'),
    });
  });

  it('returns null when the connection is missing', async () => {
    const model = makeFakeModel([]);
    const counter = new AzureDIUsageCounter({ model, tenantId: 't-1', projectId: 'p-1' });
    expect(await counter.checkUsage('c-doesnotexist')).toBeNull();
  });

  it('returns null when the connection belongs to a different tenant', async () => {
    const model = makeFakeModel([
      { _id: 'c-1', tenantId: 't-A', projectId: 'p-1', status: 'active', usageCount: 1 },
    ]);
    const counter = new AzureDIUsageCounter({ model, tenantId: 't-B', projectId: 'p-1' });
    expect(await counter.checkUsage('c-1')).toBeNull();
  });

  it('defaults missing usageCount to 0', async () => {
    const model = makeFakeModel([
      { _id: 'c-1', tenantId: 't-1', projectId: 'p-1', status: 'active' },
    ]);
    const counter = new AzureDIUsageCounter({ model, tenantId: 't-1', projectId: 'p-1' });
    const snap = await counter.checkUsage('c-1');
    expect(snap?.usageCount).toBe(0);
    expect(snap?.usageSoftCap).toBeNull();
    expect(snap?.usageHardCap).toBeNull();
  });
});

describe('AzureDIUsageCounter.recordUsage', () => {
  it('first-use seeds usageCount=1 + usagePeriodStart=currentMonthStart', async () => {
    const now = new Date('2026-05-15T12:00:00.000Z');
    const model = makeFakeModel([
      { _id: 'c-1', tenantId: 't-1', projectId: 'p-1', status: 'active' },
    ]);
    const counter = new AzureDIUsageCounter({
      model,
      tenantId: 't-1',
      projectId: 'p-1',
      now: () => now,
    });
    const r = await counter.recordUsage('c-1');
    expect(r.usageCount).toBe(1);
    expect(r.usagePeriodStart.toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });

  it('same-month increment uses $inc (no reset)', async () => {
    const now = new Date('2026-05-15T12:00:00.000Z');
    const model = makeFakeModel([
      {
        _id: 'c-1',
        tenantId: 't-1',
        projectId: 'p-1',
        status: 'active',
        usageCount: 4,
        usagePeriodStart: new Date('2026-05-01T00:00:00.000Z'),
      },
    ]);
    const counter = new AzureDIUsageCounter({
      model,
      tenantId: 't-1',
      projectId: 'p-1',
      now: () => now,
    });
    const r = await counter.recordUsage('c-1');
    expect(r.usageCount).toBe(5);
    expect(r.usagePeriodStart.toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });

  it('month rollover resets to 1 on day 1 of the new month', async () => {
    const now = new Date('2026-06-01T00:30:00.000Z');
    const model = makeFakeModel([
      {
        _id: 'c-1',
        tenantId: 't-1',
        projectId: 'p-1',
        status: 'active',
        usageCount: 42,
        usagePeriodStart: new Date('2026-05-01T00:00:00.000Z'),
      },
    ]);
    const counter = new AzureDIUsageCounter({
      model,
      tenantId: 't-1',
      projectId: 'p-1',
      now: () => now,
    });
    const r = await counter.recordUsage('c-1');
    expect(r.usageCount).toBe(1);
    expect(r.usagePeriodStart.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('two concurrent calls on the rollover day end with usageCount=2 (one reset + one $inc)', async () => {
    const now = new Date('2026-06-01T00:00:01.000Z');
    const model = makeFakeModel([
      {
        _id: 'c-1',
        tenantId: 't-1',
        projectId: 'p-1',
        status: 'active',
        usageCount: 99,
        usagePeriodStart: new Date('2026-05-01T00:00:00.000Z'),
      },
    ]);
    const counter = new AzureDIUsageCounter({
      model,
      tenantId: 't-1',
      projectId: 'p-1',
      now: () => now,
    });
    const [a, b] = await Promise.all([counter.recordUsage('c-1'), counter.recordUsage('c-1')]);
    const finalCount = Math.max(a.usageCount, b.usageCount);
    expect(finalCount).toBe(2);
    const final = (model.state() as Array<{ usageCount?: number }>).find((d) => d);
    expect(final?.usageCount).toBe(2);
  });

  it('throws when the connection is missing or revoked', async () => {
    const model = makeFakeModel([]);
    const counter = new AzureDIUsageCounter({ model, tenantId: 't-1', projectId: 'p-1' });
    await expect(counter.recordUsage('c-doesnotexist')).rejects.toThrow(/missing or revoked/);
  });

  it('does not touch other tenants', async () => {
    const now = new Date('2026-05-15T12:00:00.000Z');
    const model = makeFakeModel([
      { _id: 'c-1', tenantId: 't-A', projectId: 'p-1', status: 'active', usageCount: 5 },
      { _id: 'c-2', tenantId: 't-B', projectId: 'p-1', status: 'active', usageCount: 5 },
    ]);
    const counter = new AzureDIUsageCounter({
      model,
      tenantId: 't-A',
      projectId: 'p-1',
      now: () => now,
    });
    await counter.recordUsage('c-1');
    const docs = model.state();
    expect(docs.find((d) => d._id === 'c-2')?.usageCount).toBe(5);
  });
});
