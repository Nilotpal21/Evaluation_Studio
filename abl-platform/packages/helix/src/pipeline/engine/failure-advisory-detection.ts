/**
 * Failure-advisory detection predicates.
 *
 * Pure helpers extracted verbatim from `pipeline-engine.ts`:
 *
 *   - `isZeroTurnStartupFailureAdvisory(advisory)` — predicate on an
 *     existing advisory record.
 *   - `isZeroTurnStartupFailureText(...parts)` — shared regex over raw
 *     summary/suspected-cause/source-error strings.
 *   - `shouldUseFailureAdvisoryStableReplayModelSwitch(stage, session)` —
 *     stable-replay model-switch eligibility.
 *   - `shouldUseFailureAdvisorySwitchModelSynthesis(stage)` — switch-model
 *     synthesis eligibility by stage type.
 *
 * No engine state, no I/O. Behavior unchanged.
 */
import type { FailureAdvisoryRecord, Session, StageDefinition } from '../../types.js';

export function isZeroTurnStartupFailureText(...parts: Array<string | undefined>): boolean {
  return /\b(zero-turn|without producing a model turn|startup overhead|plugin sync|cloudflare|zero tool calls|zero tool use|zero tool-use|zero shell commands|zero output|0 turns|stalled at startup|produced no output before the inactivity timeout|tooluse=0|shellcommands=0|output=0|turns=0)\b/i.test(
    parts.filter(Boolean).join(' '),
  );
}

export function isZeroTurnStartupFailureAdvisory(advisory: FailureAdvisoryRecord): boolean {
  return isZeroTurnStartupFailureText(advisory.summary, advisory.suspectedCause);
}

export function shouldUseFailureAdvisoryStableReplayModelSwitch(
  stage: StageDefinition,
  session: Session,
): boolean {
  return (
    (session.replayContext?.changedFiles?.length ?? 0) > 0 &&
    ['deep-scan', 'reproduce', 'root-cause', 'oracle-analysis', 'plan-generation'].includes(
      stage.type,
    )
  );
}

export function shouldUseFailureAdvisorySwitchModelSynthesis(stage: StageDefinition): boolean {
  return ['deep-scan', 'reproduce', 'root-cause', 'oracle-analysis', 'plan-generation'].includes(
    stage.type,
  );
}
