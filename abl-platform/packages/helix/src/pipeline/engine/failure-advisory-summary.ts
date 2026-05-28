/**
 * Default failure-advisory summary builder.
 *
 * Pure helper extracted verbatim from `pipeline-engine.ts`. Picks a
 * human-readable default summary for a failure advisory based on the
 * stage, the failure category, the source error text, and the
 * recommended action. No engine state, no I/O. Behavior unchanged.
 */
import {
  isCodexLocalStateFailure,
  isLoginFailure,
  isTransportFailure,
} from './failure-advisory-classify.js';
import type {
  FailureAdvisoryCategory,
  FailureAdvisoryRecommendedAction,
  StageDefinition,
} from '../../types.js';

export function defaultFailureAdvisorySummary(
  stage: StageDefinition,
  failureCategory: FailureAdvisoryCategory,
  sourceError: string,
  recommendedAction: FailureAdvisoryRecommendedAction,
): string {
  if (failureCategory === 'model-error') {
    if (isTransportFailure(sourceError)) {
      return `${stage.name} cannot continue because Codex transport to the model endpoint failed during startup. Retry or resume the stage; if it persists, verify provider or network access.`;
    }

    if (isCodexLocalStateFailure(sourceError)) {
      return `${stage.name} cannot continue because Codex local state is not writable or readable in this environment. Fix CODEX_HOME or local Codex permissions, then resume the session.`;
    }

    if (isLoginFailure(sourceError)) {
      return `${stage.name} cannot continue because Codex is not logged in. Run /login for the configured Codex environment, then resume the session.`;
    }
  }

  if (recommendedAction === 'pause-and-resume') {
    return `${stage.name} is paused and needs operator intervention before HELIX can continue.`;
  }

  return `${stage.name} is blocked and needs recovery guidance before HELIX continues.`;
}
