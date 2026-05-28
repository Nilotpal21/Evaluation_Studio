import { describe, expect, it } from 'vitest';
import {
  classifyBranchCompletionAttempt,
  getBranchResultKey,
  type FanOutBarrier,
} from '../fan-out-barrier.js';

describe('Fan-out barrier contract', () => {
  it('prefers branchId over branchAgent when deriving the branch key', () => {
    expect(
      getBranchResultKey({
        branchId: 'branch-1',
        branchAgent: 'Billing_Agent',
      }),
    ).toBe('branch-1');

    expect(
      getBranchResultKey({
        branchAgent: 'Billing_Agent',
      }),
    ).toBe('Billing_Agent');
  });

  it('treats duplicate terminal completion for the same branch as a no-op', () => {
    const barrier: Pick<FanOutBarrier, 'status' | 'expiresAt'> = {
      status: 'open',
      expiresAt: Date.now() + 60_000,
    };

    const decision = classifyBranchCompletionAttempt({
      barrier,
      existingResults: {
        first: {
          branchId: 'branch-1',
          branchAgent: 'Billing_Agent',
        },
      },
      result: {
        branchId: 'branch-1',
        branchAgent: 'Billing_Agent',
      },
    });

    expect(decision).toEqual({
      branchKey: 'branch-1',
      disposition: 'duplicate',
      shouldRecord: false,
    });
  });

  it('treats callbacks after barrier close or expiry as ignored late arrivals', () => {
    const now = Date.now();

    const closedDecision = classifyBranchCompletionAttempt({
      barrier: {
        status: 'completed',
        expiresAt: now + 30_000,
      },
      existingResults: {},
      result: {
        branchId: 'branch-2',
        branchAgent: 'Support_Agent',
      },
      now,
    });
    expect(closedDecision.disposition).toBe('ignored_late');
    expect(closedDecision.shouldRecord).toBe(false);

    const expiredDecision = classifyBranchCompletionAttempt({
      barrier: {
        status: 'open',
        expiresAt: now - 1,
      },
      existingResults: {},
      result: {
        branchId: 'branch-3',
        branchAgent: 'Returns_Agent',
      },
      now,
    });
    expect(expiredDecision.disposition).toBe('ignored_late');
    expect(expiredDecision.shouldRecord).toBe(false);
  });

  it('accepts fresh branch completions while the barrier is open', () => {
    const decision = classifyBranchCompletionAttempt({
      barrier: {
        status: 'open',
        expiresAt: Date.now() + 60_000,
      },
      existingResults: {},
      result: {
        branchId: 'branch-4',
        branchAgent: 'Orders_Agent',
      },
    });

    expect(decision).toEqual({
      branchKey: 'branch-4',
      disposition: 'recorded',
      shouldRecord: true,
    });
  });
});
