import { describe, expect, it } from 'vitest';

import { shouldRequireSliceCommitApproval } from '../pipeline/slice-commit-approval.js';
import type { ExitCriterion } from '../types.js';

function makeCriterion(
  overrides: Partial<Pick<ExitCriterion, 'type' | 'passed'>> = {},
): Pick<ExitCriterion, 'type' | 'passed'> {
  return {
    type: 'typecheck',
    passed: true,
    ...overrides,
  };
}

describe('slice-commit-approval', () => {
  it('keeps the baseline approval policy outside replay mode', () => {
    expect(
      shouldRequireSliceCommitApproval({
        baselineRequireApproval: true,
        isReplayMode: false,
        testLockLocked: true,
        exitCriteria: [makeCriterion(), makeCriterion({ type: 'architecture-reviewed' })],
      }),
    ).toBe(true);
  });

  it('auto-continues replay commits once proof is green and architecture review passed', () => {
    expect(
      shouldRequireSliceCommitApproval({
        baselineRequireApproval: true,
        isReplayMode: true,
        testLockLocked: true,
        exitCriteria: [
          makeCriterion({ type: 'typecheck' }),
          makeCriterion({ type: 'lint' }),
          makeCriterion({ type: 'test-lock' }),
          makeCriterion({ type: 'impact-reviewed' }),
          makeCriterion({ type: 'exports-wired' }),
          makeCriterion({ type: 'architecture-reviewed' }),
        ],
      }),
    ).toBe(false);
  });

  it('still requires approval when replay proof is incomplete or architecture review has not passed', () => {
    expect(
      shouldRequireSliceCommitApproval({
        baselineRequireApproval: true,
        isReplayMode: true,
        testLockLocked: true,
        exitCriteria: [
          makeCriterion({ type: 'typecheck' }),
          makeCriterion({ type: 'architecture-reviewed', passed: false }),
        ],
      }),
    ).toBe(true);

    expect(
      shouldRequireSliceCommitApproval({
        baselineRequireApproval: true,
        isReplayMode: true,
        testLockLocked: false,
        exitCriteria: [
          makeCriterion({ type: 'typecheck' }),
          makeCriterion({ type: 'architecture-reviewed' }),
        ],
      }),
    ).toBe(true);
  });
});
