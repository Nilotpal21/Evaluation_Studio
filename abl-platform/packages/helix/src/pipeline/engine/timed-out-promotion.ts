/**
 * Timed-out stage promotion helpers.
 *
 * Pure helpers extracted verbatim from `pipeline-engine.ts`:
 *
 *   - `recoverPromotableTimedOutDeepScanCheckpoint(session, stage, result)` —
 *     when a Deep Scan stage result timed out but carries structurally valid
 *     output (or findings/decisions), promotes the result in-place to
 *     `passed`, dedupes findings/decisions on the session and the result,
 *     clears any pending failure advisory, and returns a human-readable
 *     promotion label (or `null` when promotion is not applicable).
 *   - `canPromoteTimedOutDeepScan(stage, output, findings, decisions)` — gate
 *     predicate: true when the stage is the named Deep Scan stage and either
 *     produced findings/decisions or emitted a parseable `analysis-report`.
 *   - `canPromoteTimedOutReproduction(stage, reproductionOutput)` — gate
 *     predicate + type guard: true when the stage is the named Reproduce stage
 *     and `parseReproductionOutput` returned a non-null structured payload.
 *
 * No engine state, no I/O. Behavior unchanged.
 */
import type { Decision, Finding, Session, StageDefinition, StageResult } from '../../types.js';
import { clearPendingFailureAdvisory } from '../control-plane-state.js';
import { isTimeoutError } from '../stage-execution-shared.js';
import {
  parseReproductionOutput,
  parseStructuredStageOutputResult,
} from '../stage-output-parsers.js';
import { dedupeDecisions, dedupeFindings } from './dedupe.js';

export const TIMED_OUT_STAGE_PROMOTION_LABEL = 'promoted timed-out output';

export function recoverPromotableTimedOutDeepScanCheckpoint(
  session: Session,
  stage: StageDefinition,
  result: StageResult,
): string | null {
  if (result.timeoutEvents == null && (!result.error || !isTimeoutError(result.error))) {
    return null;
  }

  if (!canPromoteTimedOutDeepScan(stage, result.output, result.findings, result.decisions)) {
    return null;
  }

  const dedupedSessionFindings = dedupeFindings(session.findings);
  const dedupedSessionDecisions = dedupeDecisions(session.decisions);
  const removedFindings = session.findings.length - dedupedSessionFindings.length;
  const removedDecisions = session.decisions.length - dedupedSessionDecisions.length;

  session.findings = dedupedSessionFindings;
  session.decisions = dedupedSessionDecisions;
  result.findings = dedupeFindings(result.findings);
  result.decisions = dedupeDecisions(result.decisions);
  result.status = 'passed';
  result.error = undefined;
  clearPendingFailureAdvisory(session);
  session.error = undefined;

  const dedupeParts: string[] = [];
  if (removedFindings > 0) {
    dedupeParts.push(`deduped ${removedFindings} finding${removedFindings === 1 ? '' : 's'}`);
  }
  if (removedDecisions > 0) {
    dedupeParts.push(`deduped ${removedDecisions} decision${removedDecisions === 1 ? '' : 's'}`);
  }

  return dedupeParts.length > 0
    ? `${stage.name} (${TIMED_OUT_STAGE_PROMOTION_LABEL}; ${dedupeParts.join(', ')})`
    : `${stage.name} (${TIMED_OUT_STAGE_PROMOTION_LABEL})`;
}

export function canPromoteTimedOutDeepScan(
  stage: StageDefinition,
  output: string,
  findings: Finding[],
  decisions: Decision[],
): boolean {
  if (stage.type !== 'deep-scan' || stage.name !== 'Deep Scan') {
    return false;
  }

  if (findings.length > 0 || decisions.length > 0) {
    return true;
  }

  if (!output.trim()) {
    return false;
  }

  return parseStructuredStageOutputResult(output, 'analysis-report').data != null;
}

export function canPromoteTimedOutReproduction(
  stage: StageDefinition,
  reproductionOutput: ReturnType<typeof parseReproductionOutput>,
): reproductionOutput is NonNullable<ReturnType<typeof parseReproductionOutput>> {
  return stage.type === 'reproduce' && stage.name === 'Reproduce' && reproductionOutput != null;
}
