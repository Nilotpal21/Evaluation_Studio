import { describe, expect, it } from 'vitest';
import { InMemoryFanOutBarrierStore } from '../in-memory-fan-out-barrier.js';

describe('InMemoryFanOutBarrierStore', () => {
  it('records branch completions idempotently and marks parent ready once', async () => {
    const store = new InMemoryFanOutBarrierStore();
    const barrierId = await store.create({
      parentSessionId: 'session-1',
      parentExecutionId: 'exec-1',
      tenantId: 'tenant-1',
      totalBranches: 2,
      timeoutMs: 60_000,
    });

    const first = await store.completeBranch(barrierId, {
      branchId: 'branch-1',
      branchAgent: 'Billing_Agent',
      status: 'completed',
      response: 'Billing complete',
      completedAt: Date.now(),
    });
    const duplicate = await store.completeBranch(barrierId, {
      branchId: 'branch-1',
      branchAgent: 'Billing_Agent',
      status: 'completed',
      response: 'Billing complete',
      completedAt: Date.now(),
    });
    const second = await store.completeBranch(barrierId, {
      branchId: 'branch-2',
      branchAgent: 'Shipping_Agent',
      status: 'completed',
      response: 'Shipping complete',
      completedAt: Date.now(),
    });

    expect(first).toMatchObject({
      disposition: 'recorded',
      completedCount: 1,
      totalCount: 2,
      parentResumeReady: false,
    });
    expect(duplicate).toMatchObject({
      disposition: 'duplicate',
      completedCount: 1,
      totalCount: 2,
      parentResumeReady: false,
    });
    expect(second).toMatchObject({
      disposition: 'recorded',
      completedCount: 2,
      totalCount: 2,
      allComplete: true,
      parentResumeReady: true,
    });
  });

  it('tracks parent suspension ids and ignores late arrivals after completion', async () => {
    const store = new InMemoryFanOutBarrierStore();
    const barrierId = await store.create({
      parentSessionId: 'session-1',
      parentExecutionId: 'exec-1',
      tenantId: 'tenant-1',
      totalBranches: 1,
      timeoutMs: 60_000,
    });

    await store.setParentSuspension(barrierId, 'parent-suspension-1');
    expect(await store.getParentSuspension(barrierId)).toBe('parent-suspension-1');

    await store.completeBranch(barrierId, {
      branchId: 'branch-1',
      branchAgent: 'Remote_Agent',
      status: 'completed',
      response: 'Done',
      completedAt: Date.now(),
    });

    const late = await store.completeBranch(barrierId, {
      branchId: 'branch-2',
      branchAgent: 'Late_Agent',
      status: 'completed',
      response: 'Too late',
      completedAt: Date.now(),
    });

    expect(late).toMatchObject({
      disposition: 'ignored_late',
      completedCount: 1,
      totalCount: 1,
      parentResumeReady: true,
    });
  });
});
