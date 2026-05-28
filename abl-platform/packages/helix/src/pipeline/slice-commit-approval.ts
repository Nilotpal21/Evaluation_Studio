import type { ExitCriterion } from '../types.js';

export interface SliceCommitApprovalInput {
  baselineRequireApproval: boolean;
  isReplayMode: boolean;
  testLockLocked: boolean;
  exitCriteria: Array<Pick<ExitCriterion, 'type' | 'passed'>>;
}

export function shouldRequireSliceCommitApproval(input: SliceCommitApprovalInput): boolean {
  if (!input.isReplayMode || !input.testLockLocked) {
    return input.baselineRequireApproval;
  }

  const allExitCriteriaPassed =
    input.exitCriteria.length > 0 && input.exitCriteria.every((criterion) => criterion.passed);
  const architectureReviewed = input.exitCriteria.some(
    (criterion) => criterion.type === 'architecture-reviewed' && criterion.passed,
  );

  if (allExitCriteriaPassed && architectureReviewed) {
    return false;
  }

  return input.baselineRequireApproval;
}
