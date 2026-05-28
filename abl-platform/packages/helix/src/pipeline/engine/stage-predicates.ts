/**
 * Pure stage / session inspection predicates.
 *
 * Helpers extracted verbatim from `pipeline-engine.ts`. Each predicate
 * inspects stage, session, slice, or error text and returns a boolean
 * / number / short string summary without touching engine state.
 *
 *   - `isBlockingStageResult(result)` — true when a stage result is a
 *     blocking failure (`failed` or `looped`).
 *   - `countPriorBlockingStageFailures(session, stage)` — number of
 *     prior blocking (failed/looped) history entries for this stage,
 *     excluding the current attempt.
 *   - `shouldRetryArchitectureReviewFromEvidence(error)` — true when
 *     the architecture-review error matches the set of
 *     evidence-retryable signatures (efficiency cap / stall / deadline
 *     / timeout).
 *   - `shouldRunDeterministicReplayRegression(session, stage)` — true
 *     when a replay-regression stage has a quality gate and at least
 *     one scoped test file to run deterministically (skipping the
 *     model step).
 *   - `restoreStageDefinitionForRetry(session, stage)` — mutates the
 *     passed-in `stage` to match the pinned `pipelineSnapshot` entry
 *     when the snapshot still matches the stage name + type, so that a
 *     retry operates on an untainted stage definition.
 *   - `describeExitCriterion(slice, criterionType)` — human-readable
 *     PASS / FAIL summary for the specified exit criterion on a slice,
 *     with `(not declared)` fallback.
 *   - `verifyEntryConditions(session, slice)` — checks dependency
 *     slices and typed manifest entry conditions; mutates
 *     `condition.met` in-place and returns a human-readable reason
 *     string when blocked, or `null` when ready.
 *
 * No engine state, no I/O. Behavior unchanged.
 */
import type { Session, Slice, StageDefinition, StageResult } from '../../types.js';
import { buildStageQualityGateScopeEntries } from './quality-gate-helpers.js';

export function isBlockingStageResult(result: StageResult): boolean {
  return result.status === 'failed' || result.status === 'looped';
}

export function countPriorBlockingStageFailures(session: Session, stage: StageDefinition): number {
  const totalFailuresForStage = session.stageHistory.filter(
    (entry) =>
      entry.stageName === stage.name &&
      entry.stageType === stage.type &&
      (entry.status === 'failed' || entry.status === 'looped'),
  ).length;

  return Math.max(0, totalFailuresForStage - 1);
}

export function shouldRetryArchitectureReviewFromEvidence(error: string): boolean {
  return /HELIX efficiency hard cap|stalled after|execution deadline|timed? out/i.test(error);
}

export function shouldRunDeterministicReplayRegression(
  session: Session,
  stage: StageDefinition,
): boolean {
  if (stage.type !== 'regression' || !session.replayContext || !stage.qualityGate) {
    return false;
  }

  return (buildStageQualityGateScopeEntries(session, stage)?.length ?? 0) > 0;
}

export function restoreStageDefinitionForRetry(session: Session, stage: StageDefinition): void {
  const snapshotIndex = session.currentStageIndex;
  const snapshotStage = session.pipelineSnapshot?.stages[snapshotIndex];
  if (!snapshotStage || snapshotStage.name !== stage.name || snapshotStage.type !== stage.type) {
    return;
  }

  const restored = JSON.parse(JSON.stringify(snapshotStage)) as StageDefinition;
  for (const key of Object.keys(stage) as Array<keyof StageDefinition>) {
    delete stage[key];
  }
  Object.assign(stage, restored);
}

export function describeExitCriterion(
  slice: Slice,
  criterionType: Slice['exitCriteria'][number]['type'],
): string {
  const criterion = slice.exitCriteria.find((entry) => entry.type === criterionType);
  if (!criterion) {
    return '(not declared)';
  }

  const status = criterion.passed ? 'PASS' : 'FAIL';
  return criterion.detail ? `${status} — ${criterion.detail}` : status;
}

export function verifyEntryConditions(session: Session, slice: Slice): string | null {
  // Check explicit dependency slices
  const depsComplete = slice.dependencies.every((dep) => {
    const depSlice = session.slices[dep];
    return depSlice && depSlice.status === 'committed';
  });
  if (!depsComplete) {
    return `dependencies not met (slices ${slice.dependencies.map((d) => d + 1).join(', ')})`;
  }

  // Check typed entry conditions from the manifest
  for (const condition of slice.manifest.entryConditions) {
    if (condition.met) continue;

    switch (condition.type) {
      case 'slice-committed': {
        const refIndex = parseInt(condition.reference, 10);
        const refSlice = session.slices[refIndex];
        if (refSlice && refSlice.status === 'committed') {
          condition.met = true;
        } else {
          return `entry condition not met: ${condition.description}`;
        }
        break;
      }
      case 'test-passes':
      case 'file-exists':
      case 'export-available':
        // Deferred — verified by the model during execution
        condition.met = true;
        break;
    }
  }

  return null;
}
