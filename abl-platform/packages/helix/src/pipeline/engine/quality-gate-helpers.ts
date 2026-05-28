/**
 * Pure quality-gate shape / scope helpers.
 *
 * Helpers extracted verbatim from `pipeline-engine.ts`. Each reads
 * only its arguments and returns either a derived quality-gate config,
 * a scope-entry list, or a boolean decision.
 *
 *   - `buildEffectiveQualityGate(session, stage, gate)` — derives the
 *     effective quality gate for a stage, optionally stripping the
 *     `pnpm test:report` command for scoped regression runs and
 *     skipping model review for already-approved implementation slices.
 *   - `buildStageQualityGateScopeEntries(session, stage)` — returns the
 *     deduplicated set of test-file scope entries for a regression
 *     stage, falling back to replay-changed test files when no slice
 *     evidence is available.
 *   - `shouldUseScopedRegressionQualityGate(session, stage, gate)` —
 *     true when a regression stage ran `pnpm test:report` and has at
 *     least one scope entry to feed instead.
 *   - `shouldSkipImplementationStageModelReview(session, stage, gate)`
 *     — true when the current slice has all exit criteria met and the
 *     architecture-reviewed criterion already passed, so re-running
 *     model review on the implementation stage is redundant.
 *
 * No engine state, no I/O. Behavior unchanged.
 */
import type { QualityGateConfig, Session, StageDefinition } from '../../types.js';
import { allExitCriteriaMet } from '../slice-view.js';
import { isTestFilePath } from '../workspace-status.js';
import { dedupeStrings } from './text-utils.js';

export function buildEffectiveQualityGate(
  session: Session,
  stage: StageDefinition,
  gate: QualityGateConfig,
): QualityGateConfig {
  let checks = gate.checks;

  if (shouldUseScopedRegressionQualityGate(session, stage, gate)) {
    checks = checks.map((check) =>
      check.type === 'test' && check.command?.trim() === 'pnpm test:report'
        ? { ...check, command: undefined }
        : check,
    );
  }

  if (shouldSkipImplementationStageModelReview(session, stage, gate)) {
    checks = checks.filter((check) => check.type !== 'model-review');
  }

  if (checks === gate.checks) {
    return gate;
  }

  return {
    ...gate,
    checks,
  };
}

export function buildStageQualityGateScopeEntries(
  session: Session,
  stage: StageDefinition,
): string[] | undefined {
  if (stage.type !== 'regression') {
    return undefined;
  }

  const scopedTests = dedupeStrings(
    session.slices.flatMap((slice) => [
      ...slice.testLock.requiredTests.map((test) => test.testFile),
      ...slice.testLock.regressionSuite,
      ...slice.impactAnalysis.affectedTests.filter(isTestFilePath),
    ]),
  ).filter(isTestFilePath);

  if (scopedTests.length > 0) {
    return scopedTests;
  }

  const replayScopedTests = dedupeStrings(
    (session.replayContext?.changedFiles ?? []).filter(isTestFilePath),
  );
  return replayScopedTests.length > 0 ? replayScopedTests : undefined;
}

export function shouldUseScopedRegressionQualityGate(
  session: Session,
  stage: StageDefinition,
  gate: QualityGateConfig,
): boolean {
  if (stage.type !== 'regression') {
    return false;
  }

  if (
    !gate.checks.some(
      (check) => check.type === 'test' && check.command?.trim() === 'pnpm test:report',
    )
  ) {
    return false;
  }

  return (buildStageQualityGateScopeEntries(session, stage)?.length ?? 0) > 0;
}

export function shouldSkipImplementationStageModelReview(
  session: Session,
  stage: StageDefinition,
  gate: QualityGateConfig,
): boolean {
  if (stage.type !== 'implementation') {
    return false;
  }

  if (!gate.checks.some((check) => check.type === 'model-review')) {
    return false;
  }

  const sliceIndex = session.currentSliceIndex ?? 0;
  const slice = session.slices[sliceIndex];
  if (!slice || !allExitCriteriaMet(slice)) {
    return false;
  }

  const architectureReviewed = slice.exitCriteria.find(
    (criterion) => criterion.type === 'architecture-reviewed',
  );

  return architectureReviewed?.passed === true;
}
