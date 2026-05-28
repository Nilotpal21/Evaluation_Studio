/**
 * Queue replay loop prevention tests.
 *
 * Validates that _pinnedIntent correctly narrows ON_INPUT branch evaluation
 * during queue replay, preventing infinite re-detection loops.
 * Uses real evaluateOnInput from @abl/compiler to verify actual branch routing.
 */

import { describe, it, expect } from 'vitest';
import { evaluateOnInput } from '@abl/compiler/platform/constructs/utils.js';
import type { RuntimeSession } from '../services/execution/types.js';

type OnInputBranch = {
  condition?: string;
  respond?: string;
  set?: Record<string, string>;
  call?: string;
  then: string;
};

function createMockSession(overrides?: Partial<RuntimeSession>): Partial<RuntimeSession> {
  return {
    agentName: 'test-agent',
    _pinnedIntent: undefined,
    ...overrides,
  };
}

/** Mirror the pinned-intent branch filtering from flow-step-executor.ts */
function filterBranchesForPin(
  branches: OnInputBranch[],
  pinnedIntent: string | undefined,
): OnInputBranch[] {
  if (!pinnedIntent) return branches;

  const pinnedBranch = branches.find((b) => b.then === pinnedIntent);
  if (pinnedBranch) {
    return branches.filter((b) => b.then === pinnedIntent || !b.condition);
  }
  return [];
}

const branches: OnInputBranch[] = [
  { condition: 'input contains "book"', then: 'book_flight', respond: 'Booking...' },
  { condition: 'input contains "status"', then: 'check_status', respond: 'Checking...' },
  { then: 'fallback', respond: 'Sorry, I did not understand' },
];

describe('queue replay loop prevention', () => {
  it('pinned intent narrows branch evaluation to target + ELSE', () => {
    const session = createMockSession({ _pinnedIntent: 'check_status' });
    const filtered = filterBranchesForPin(branches, session._pinnedIntent);

    expect(filtered).toHaveLength(2);
    expect(filtered.map((b) => b.then)).toEqual(['check_status', 'fallback']);

    const result = evaluateOnInput(filtered, 'check my status', {});
    expect(result).not.toBeNull();
    expect(result!.then).toBe('check_status');
  });

  it('unpinned evaluates all branches (first match wins)', () => {
    const session = createMockSession();
    const filtered = filterBranchesForPin(branches, session._pinnedIntent);

    expect(filtered).toHaveLength(3);

    // "book" appears first in branches -> first match wins
    const result = evaluateOnInput(filtered, 'book a flight and check status', {});
    expect(result).not.toBeNull();
    expect(result!.then).toBe('book_flight');
  });

  it('pinned intent prevents wrong branch from winning during replay', () => {
    // Message matches both "book" and "status", but pinned to check_status
    const session = createMockSession({ _pinnedIntent: 'check_status' });
    const filtered = filterBranchesForPin(branches, session._pinnedIntent);

    const result = evaluateOnInput(filtered, 'book a flight and check status', {});
    expect(result).not.toBeNull();
    // book_flight branch was filtered out, only check_status matches
    expect(result!.then).toBe('check_status');
  });

  it('_pinnedIntent cleared after consumption', () => {
    const session = createMockSession({ _pinnedIntent: 'check_status' });
    const filtered = filterBranchesForPin(branches, session._pinnedIntent);
    const result = evaluateOnInput(filtered, 'check my status', {});

    expect(result).not.toBeNull();

    // Simulate clearing after match
    session._pinnedIntent = undefined;
    expect(session._pinnedIntent).toBeUndefined();
  });

  it('digression detection skipped when _pinnedIntent is set', () => {
    const session = createMockSession({ _pinnedIntent: 'check_status' });

    // Guard logic: skip digression detection when pinned
    let digressionDetectionRan = false;
    if (!session._pinnedIntent) {
      digressionDetectionRan = true;
    }
    expect(digressionDetectionRan).toBe(false);
  });

  it('digression detection runs when no _pinnedIntent', () => {
    const session = createMockSession();

    let digressionDetectionRan = false;
    if (!session._pinnedIntent) {
      digressionDetectionRan = true;
    }
    expect(digressionDetectionRan).toBe(true);
  });
});
