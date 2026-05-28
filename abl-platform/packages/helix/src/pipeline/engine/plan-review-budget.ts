/**
 * Estimator for the plan-review executor-efficiency budget. Combines
 * parsed slice-plan structure, prior plan-review state, and open-finding
 * count to derive target/exploration turn counts for the reviewer.
 *
 * Extracted verbatim from `pipeline-engine.ts`. Behavior is unchanged.
 */
import type { ExecutorEfficiencyBudget, Session } from '../../types.js';
import { parseStructuredStageOutputResult } from '../stage-output-parsers.js';
import { clamp } from './text-utils.js';

export function estimatePlanReviewEfficiencyBudget(
  session: Session,
  stageOutput?: string,
): ExecutorEfficiencyBudget {
  const parsedPlan = stageOutput
    ? parseStructuredStageOutputResult(stageOutput, 'slice-plan').data
    : null;
  const planSlices = parsedPlan?.slices ?? [];
  const priorApprovedSlices = session.planReviewState?.approvedSlices.length ?? 0;
  const priorSlicesToRevise = session.planReviewState?.slicesToRevise.length ?? 0;
  const sliceCount =
    planSlices.length > 0
      ? planSlices.length
      : Math.max(priorApprovedSlices + priorSlicesToRevise, 1);
  const contestedSlices = Math.max(priorSlicesToRevise, 1);
  const totalFiles = planSlices.reduce((sum, slice) => sum + slice.files.length, 0);
  const totalTests = planSlices.reduce((sum, slice) => sum + slice.tests.length, 0);
  const openFindings = session.findings.filter((finding) => finding.status === 'open').length;
  const rawBudget =
    8 +
    sliceCount * 2 +
    contestedSlices * 3 +
    Math.ceil(totalFiles / 10) +
    Math.ceil(totalTests / 8) +
    Math.ceil(openFindings / 6);
  const targetTurns = clamp(rawBudget, 10, 18);
  const explorationTurns = clamp(Math.ceil(targetTurns * 0.35), 3, Math.max(3, targetTurns - 4));

  return {
    targetTurns,
    explorationTurns,
    summary: [
      `${sliceCount} slice(s) under review`,
      `${contestedSlices} contested slice(s)`,
      `${totalFiles} declared file(s)`,
      `${totalTests} declared test(s)`,
      `${openFindings} open finding(s)`,
    ].join(', '),
  };
}
