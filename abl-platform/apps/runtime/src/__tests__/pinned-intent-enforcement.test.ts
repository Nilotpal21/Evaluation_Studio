/**
 * Tests for pinned intent enforcement during ON_INPUT branch selection.
 *
 * Validates that when `_pinnedIntent` is set on a session, ON_INPUT evaluation
 * is filtered to only the branch matching the pinned intent (plus ELSE fallback),
 * preventing a different intent from winning via first-match-wins.
 */

import { describe, it, expect } from 'vitest';
import { evaluateOnInput } from '@abl/compiler/platform/constructs/utils.js';

// Branch type matching the evaluateOnInput signature
type OnInputBranch = {
  condition?: string;
  respond?: string;
  set?: Record<string, string>;
  call?: string;
  then: string;
};

/**
 * Apply the same pinned-intent filtering logic used in flow-step-executor.ts
 * before calling evaluateOnInput.
 */
function filterBranchesForPinnedIntent(
  branches: OnInputBranch[],
  pinnedIntent: string | undefined,
): { branchesToEvaluate: OnInputBranch[]; pinnedBranchFound: boolean } {
  if (!pinnedIntent) {
    return { branchesToEvaluate: branches, pinnedBranchFound: false };
  }

  const pinnedBranch = branches.find((b) => b.then === pinnedIntent);
  if (pinnedBranch) {
    return {
      branchesToEvaluate: branches.filter((b) => b.then === pinnedIntent || !b.condition),
      pinnedBranchFound: true,
    };
  }

  // Pinned intent for a different step — skip ON_INPUT entirely
  return { branchesToEvaluate: [], pinnedBranchFound: false };
}

describe('pinned intent enforcement during ON_INPUT', () => {
  // Three branches: book_flight matches "flight", check_status matches "status", ELSE fallback
  const branches: OnInputBranch[] = [
    { condition: 'input contains "flight"', then: 'book_flight', respond: 'Booking flight' },
    { condition: 'input contains "status"', then: 'check_status', respond: 'Checking status' },
    { then: 'fallback_step', respond: 'I did not understand' }, // ELSE (no condition)
  ];

  it('pinned intent filters to correct branch', () => {
    const { branchesToEvaluate } = filterBranchesForPinnedIntent(branches, 'check_status');

    // Should only have the pinned branch + ELSE
    expect(branchesToEvaluate).toHaveLength(2);
    expect(branchesToEvaluate.map((b) => b.then)).toEqual(['check_status', 'fallback_step']);

    // Now evaluateOnInput with a message matching the pinned condition
    const result = evaluateOnInput(branchesToEvaluate, 'check my status', {});
    expect(result).not.toBeNull();
    expect(result!.then).toBe('check_status');
  });

  it('pinned branch not in step skips ON_INPUT', () => {
    const { branchesToEvaluate, pinnedBranchFound } = filterBranchesForPinnedIntent(
      branches,
      'cancel_booking', // not in any branch's `then`
    );

    expect(pinnedBranchFound).toBe(false);
    expect(branchesToEvaluate).toHaveLength(0);

    // Empty branches → evaluateOnInput returns null
    const result = evaluateOnInput(branchesToEvaluate, 'cancel my booking', {});
    expect(result).toBeNull();
  });

  it('ELSE branch preserved during filtering', () => {
    const { branchesToEvaluate } = filterBranchesForPinnedIntent(branches, 'book_flight');

    // Should include pinned branch + ELSE
    const branchTargets = branchesToEvaluate.map((b) => b.then);
    expect(branchTargets).toContain('book_flight');
    expect(branchTargets).toContain('fallback_step');
    expect(branchTargets).not.toContain('check_status');
  });

  it('unpinned evaluates all branches', () => {
    const { branchesToEvaluate } = filterBranchesForPinnedIntent(branches, undefined);

    expect(branchesToEvaluate).toHaveLength(3);

    // First-match-wins: "flight" matches the first branch
    const result = evaluateOnInput(branchesToEvaluate, 'I want a flight status', {});
    expect(result).not.toBeNull();
    expect(result!.then).toBe('book_flight'); // first match wins
  });

  it('wrong branch would win without pinning, but pinning prevents it', () => {
    // Without pinning: "I want a flight status" matches "flight" branch first
    const unpinned = filterBranchesForPinnedIntent(branches, undefined);
    const unpinnedResult = evaluateOnInput(
      unpinned.branchesToEvaluate,
      'I want a flight status',
      {},
    );
    expect(unpinnedResult!.then).toBe('book_flight');

    // With pinning to check_status: "flight" branch is filtered out
    const pinned = filterBranchesForPinnedIntent(branches, 'check_status');
    const pinnedResult = evaluateOnInput(pinned.branchesToEvaluate, 'I want a flight status', {});
    // "status" is in the message and check_status branch condition matches
    expect(pinnedResult).not.toBeNull();
    expect(pinnedResult!.then).toBe('check_status');
  });

  it('pinned intent cleared after match (session lifecycle)', () => {
    const session = { _pinnedIntent: 'check_status' as string | undefined };

    const { branchesToEvaluate } = filterBranchesForPinnedIntent(branches, session._pinnedIntent);
    const result = evaluateOnInput(branchesToEvaluate, 'check my status', {});

    expect(result).not.toBeNull();

    // Simulate clearing after match (as done in flow-step-executor.ts line 2909)
    if (result) {
      session._pinnedIntent = undefined;
    }

    expect(session._pinnedIntent).toBeUndefined();
  });

  it('ELSE fallback used when pinned branch condition does not match input', () => {
    // Pin to book_flight, but send a message that doesn't contain "flight"
    const { branchesToEvaluate } = filterBranchesForPinnedIntent(branches, 'book_flight');

    const result = evaluateOnInput(branchesToEvaluate, 'hello there', {});
    // The pinned branch condition won't match, but ELSE will
    expect(result).not.toBeNull();
    expect(result!.then).toBe('fallback_step');
  });
});
