/**
 * Failure-advisory retry-decision predicates.
 *
 * Pure helpers extracted verbatim from `pipeline-engine.ts`. Each predicate
 * inspects the stage configuration, session replay context, and optional
 * failure-advisory evidence to decide whether a specific retry mode should
 * fire.
 *
 *   - `shouldUseFailureAdvisoryEvidenceOnlyRetry(stage, advisory, session)`
 *     — evidence-only retry fires for analysis stages with a replay seam
 *     when the advisory category is `model-error` or `timeout` and the
 *     advisory evidence matches a zero-tool-use / cold-start pattern.
 *   - `isReplaySynthesisRetryStage(sessionStage, session)` — detects a
 *     stage that has already been rewound into claude-api/claude-code synthesis
 *     posture with tool use disabled and a non-empty replay seam.
 *   - `shouldUseFailureAdvisoryStableReplayRetry(stage, advisory, session)`
 *     — stable replay retry fires for codex-cli plan-generation stages
 *     with broad replay evidence when the advisory matches a
 *     startup-hang / zero-tool-use pattern.
 *   - `shouldUseFailureAdvisoryStableReplayEvidenceRetry(stage, advisory,
 *     session)` — stable replay evidence-only retry fires for analysis
 *     stages with broad replay evidence when the advisory matches the
 *     same startup-hang / zero-tool-use pattern.
 *   - `shouldRetainCurrentSynthesisRetry(stage, advisory, session)` —
 *     retains the current claude-api / claude-code synthesis posture on retry for
 *     analysis / plan-generation stages with a replay seam when the
 *     advisory matches the same startup-hang / zero-tool-use pattern.
 *
 * No engine state, no I/O. Behavior unchanged.
 */
import type { FailureAdvisoryRecord, Session, StageDefinition } from '../../types.js';

export function shouldUseFailureAdvisoryEvidenceOnlyRetry(
  stage: StageDefinition,
  advisory: FailureAdvisoryRecord,
  session: Session,
): boolean {
  if (!['deep-scan', 'reproduce', 'root-cause'].includes(stage.type)) {
    return false;
  }

  if ((session.replayContext?.changedFiles?.length ?? 0) === 0) {
    return false;
  }

  if (!['model-error', 'timeout'].includes(advisory.failureCategory)) {
    return false;
  }

  const replayEvidenceSummary = [
    advisory.summary,
    advisory.suspectedCause,
    advisory.sourceError,
    advisory.promptGuidance ?? '',
  ].join('\n');

  return /\b(zero turns|zero tool use|zero tool-use|zero tool calls|zero shell commands|zero output|zero work was completed|stalled at startup|cold-start hang|internal reasoning loop|never issued a single tool call|tooluse\s*=\s*0|shellcommands\s*=\s*0)\b/i.test(
    replayEvidenceSummary,
  );
}

export function isReplaySynthesisRetryStage(
  sessionStage: StageDefinition,
  session: Session,
): boolean {
  return (
    ['deep-scan', 'reproduce', 'root-cause', 'oracle-analysis', 'plan-generation'].includes(
      sessionStage.type,
    ) &&
    (session.replayContext?.changedFiles?.length ?? 0) > 0 &&
    ['claude-code', 'claude-api'].includes(sessionStage.model.primary.engine) &&
    (sessionStage.tools?.length ?? 0) === 0
  );
}

export function shouldUseFailureAdvisoryStableReplayRetry(
  stage: StageDefinition,
  advisory: FailureAdvisoryRecord,
  session: Session,
): boolean {
  if (stage.type !== 'plan-generation') {
    return false;
  }

  const replayChangedFiles = session.replayContext?.changedFiles?.length ?? 0;
  const broadReplay =
    replayChangedFiles >= 6 ||
    (session.replayContext?.tags ?? []).some((tag) =>
      ['service-extraction', 'rbac', 'route-migration'].includes(tag),
    );
  if (!broadReplay) {
    return false;
  }

  if (stage.model.primary.engine !== 'codex-cli') {
    return false;
  }

  const retrySummary = [
    advisory.summary,
    advisory.suspectedCause,
    advisory.sourceError,
    advisory.promptGuidance ?? '',
  ].join('\n');

  return /\b(cold-start hang|stalled at startup|zero tool use|zero tool-use|zero tool calls|zero shell commands|zero output|zero work was completed|never issued a single tool call|produced no output before the inactivity timeout|startup hang|tooluse\s*=\s*0|shellcommands\s*=\s*0)\b/i.test(
    retrySummary,
  );
}

export function shouldUseFailureAdvisoryStableReplayEvidenceRetry(
  stage: StageDefinition,
  advisory: FailureAdvisoryRecord,
  session: Session,
): boolean {
  if (!['deep-scan', 'reproduce', 'root-cause'].includes(stage.type)) {
    return false;
  }

  const replayChangedFiles = session.replayContext?.changedFiles?.length ?? 0;
  const broadReplay =
    replayChangedFiles >= 6 ||
    (session.replayContext?.tags ?? []).some((tag) =>
      ['service-extraction', 'rbac', 'route-migration'].includes(tag),
    );
  if (!broadReplay) {
    return false;
  }

  const retrySummary = [
    advisory.summary,
    advisory.suspectedCause,
    advisory.sourceError,
    advisory.promptGuidance ?? '',
  ].join('\n');

  return /\b(cold-start hang|stalled at startup|zero tool use|zero tool-use|zero tool calls|zero shell commands|zero output|zero work was completed|never issued a single tool call|produced no output before the inactivity timeout|startup hang|tooluse\s*=\s*0|shellcommands\s*=\s*0)\b/i.test(
    retrySummary,
  );
}

export function shouldRetainCurrentSynthesisRetry(
  stage: StageDefinition,
  advisory: FailureAdvisoryRecord,
  session: Session,
): boolean {
  if (
    !['deep-scan', 'reproduce', 'root-cause', 'oracle-analysis', 'plan-generation'].includes(
      stage.type,
    )
  ) {
    return false;
  }

  if ((session.replayContext?.changedFiles?.length ?? 0) === 0) {
    return false;
  }

  if (
    !['claude-code', 'claude-api'].includes(stage.model.primary.engine) ||
    (stage.tools?.length ?? 0) > 0
  ) {
    return false;
  }

  const retrySummary = [
    advisory.summary,
    advisory.suspectedCause,
    advisory.sourceError,
    advisory.promptGuidance ?? '',
  ].join('\n');

  return /\b(cold-start hang|stalled at startup|zero tool use|zero tool-use|zero tool calls|zero shell commands|zero output|zero work was completed|never issued a single tool call|produced no output before the inactivity timeout|startup hang|tooluse\s*=\s*0|shellcommands\s*=\s*0)\b/i.test(
    retrySummary,
  );
}
