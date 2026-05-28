/**
 * Failure-advisory output normalization + budget reconciliation.
 *
 * Pure helpers extracted verbatim from `pipeline-engine.ts`. Each reads
 * only its arguments and returns a new object (or mutates the supplied
 * `stage` in the case of `applyFailureAdvisoryBudgetRecommendation`).
 *
 *   - `normalizeFailureAdvisoryOutput(session, output, failureCategory,
 *     priorRetryCount, sourceError, result, currentBudget?, stage?)` —
 *     canonicalizes a parsed failure-advisory stage output: promotes
 *     the recommended action through synthesis / switch-model /
 *     pause-and-resume rules, resolves prompt guidance and operator
 *     actions, and reconciles the budget recommendation against the
 *     current budget.
 *   - `normalizeFailureAdvisoryBudgetRecommendation(recommendation,
 *     recommendedAction, currentBudget?)` — clamps a raw budget
 *     recommendation against the current budget or returns `null` when
 *     the recommendation is inapplicable or a no-op.
 *   - `applyFailureAdvisoryBudgetRecommendation(stage, advisory)` —
 *     mutates the supplied stage's model specs (primary / fallback /
 *     layered) to carry the advisory's budget recommendation.
 *   - `buildFailureAdvisoryCheckpointData(advisory)` — projects the
 *     advisory record into a plain `Record<string, unknown>` shape for
 *     checkpoint persistence.
 *
 * No engine state, no I/O. Behavior unchanged.
 */
import type {
  ExecutorEfficiencyBudget,
  FailureAdvisoryCategory,
  FailureAdvisoryRecord,
  FailureAdvisoryStageOutput,
  ModelSpec,
  Session,
  StageDefinition,
  StageResult,
} from '../../types.js';
import { mergeExecutorEfficiencyBudget } from '../execution-envelope.js';
import {
  MAX_FAILURE_ADVISORY_RETRIES,
  defaultFailureAdvisoryOperatorActions,
  defaultFailureAdvisoryPromptGuidance,
  maybePromoteFailureAdvisoryAction,
  selectFailureAdvisoryPromptGuidance,
} from './failure-advisory-actions.js';
import { shouldPreferFailureAdvisorySynthesis } from './failure-advisory-evidence.js';
import { isZeroTurnStartupFailureText } from './failure-advisory-detection.js';
import { clampNumber } from './text-utils.js';

export function normalizeFailureAdvisoryOutput(
  session: Session,
  output: FailureAdvisoryStageOutput,
  failureCategory: FailureAdvisoryCategory,
  priorRetryCount: number,
  sourceError: string,
  result: StageResult,
  currentBudget?: ExecutorEfficiencyBudget,
  stage?: StageDefinition,
): FailureAdvisoryStageOutput {
  let recommendedAction = output.recommendedAction;
  const startupRecoveryShouldSwitchModel =
    !!stage &&
    ['deep-scan', 'reproduce', 'root-cause', 'oracle-analysis', 'plan-generation'].includes(
      stage.type,
    ) &&
    isZeroTurnStartupFailureText(output.summary, output.suspectedCause, sourceError);
  if (recommendedAction === 'retry-stage' && shouldPreferFailureAdvisorySynthesis(stage, result)) {
    recommendedAction = 'synthesize-stage';
  }
  if (startupRecoveryShouldSwitchModel && recommendedAction === 'retry-stage') {
    recommendedAction = 'switch-model';
  }
  if (
    ['retry-stage', 'synthesize-stage', 'switch-model', 'continue-immediate-only'].includes(
      recommendedAction,
    ) &&
    priorRetryCount >= MAX_FAILURE_ADVISORY_RETRIES
  ) {
    recommendedAction = 'pause-and-resume';
  }

  const defaultPromptGuidance =
    recommendedAction === 'retry-stage' ||
    recommendedAction === 'synthesize-stage' ||
    recommendedAction === 'switch-model' ||
    recommendedAction === 'continue-immediate-only'
      ? defaultFailureAdvisoryPromptGuidance(failureCategory, sourceError, stage, recommendedAction)
      : null;

  const promptGuidance =
    recommendedAction === 'retry-stage' ||
    recommendedAction === 'synthesize-stage' ||
    recommendedAction === 'switch-model' ||
    recommendedAction === 'continue-immediate-only'
      ? selectFailureAdvisoryPromptGuidance(
          stage,
          failureCategory,
          sourceError,
          output.promptGuidance?.trim() ?? null,
          defaultPromptGuidance,
        )
      : null;

  const operatorActions =
    output.operatorActions.length > 0
      ? [...output.operatorActions]
      : defaultFailureAdvisoryOperatorActions(failureCategory, sourceError);

  if (recommendedAction === 'pause-and-resume' && priorRetryCount >= MAX_FAILURE_ADVISORY_RETRIES) {
    operatorActions.unshift(
      'This failure signature has already been retried once; inspect the workspace or failing command before resuming.',
    );
  }

  recommendedAction = maybePromoteFailureAdvisoryAction(
    session,
    stage,
    result,
    recommendedAction,
    output.summary,
    output.suspectedCause,
    sourceError,
  );

  return {
    summary: output.summary.trim(),
    suspectedCause: output.suspectedCause.trim() || sourceError,
    recommendedAction,
    promptGuidance,
    operatorActions,
    budgetRecommendation: normalizeFailureAdvisoryBudgetRecommendation(
      output.budgetRecommendation,
      recommendedAction,
      currentBudget,
    ),
  };
}

export function normalizeFailureAdvisoryBudgetRecommendation(
  recommendation: FailureAdvisoryStageOutput['budgetRecommendation'],
  recommendedAction: FailureAdvisoryRecord['recommendedAction'],
  currentBudget?: ExecutorEfficiencyBudget,
): FailureAdvisoryStageOutput['budgetRecommendation'] {
  if (!recommendation || recommendedAction !== 'retry-stage' || !currentBudget) {
    return null;
  }

  const targetTurns = clampNumber(
    recommendation.targetTurns ?? currentBudget.targetTurns,
    currentBudget.targetTurns,
    currentBudget.targetTurns + Math.max(8, Math.ceil(currentBudget.targetTurns * 0.5)),
  );
  const explorationTurns = clampNumber(
    recommendation.explorationTurns ?? currentBudget.explorationTurns,
    currentBudget.explorationTurns,
    Math.max(currentBudget.explorationTurns, targetTurns - 1),
  );
  const shellWarnFloor =
    recommendation.shellWarnFloor != null || currentBudget.shellWarnFloor != null
      ? clampNumber(
          recommendation.shellWarnFloor ?? currentBudget.shellWarnFloor ?? targetTurns,
          currentBudget.shellWarnFloor ?? 1,
          targetTurns + 8,
        )
      : undefined;
  const shellAbortFloor =
    recommendation.shellAbortFloor != null || currentBudget.shellAbortFloor != null
      ? clampNumber(
          recommendation.shellAbortFloor ?? currentBudget.shellAbortFloor ?? targetTurns,
          currentBudget.shellAbortFloor ?? 1,
          targetTurns + Math.max(10, explorationTurns + 6),
        )
      : undefined;

  const unchanged =
    targetTurns === currentBudget.targetTurns &&
    explorationTurns === currentBudget.explorationTurns &&
    shellWarnFloor === currentBudget.shellWarnFloor &&
    shellAbortFloor === currentBudget.shellAbortFloor;

  if (unchanged) {
    return null;
  }

  return {
    rationale: recommendation.rationale.trim(),
    targetTurns,
    explorationTurns,
    ...(shellWarnFloor != null ? { shellWarnFloor } : {}),
    ...(shellAbortFloor != null ? { shellAbortFloor } : {}),
  };
}

export function applyFailureAdvisoryBudgetRecommendation(
  stage: StageDefinition,
  advisory: FailureAdvisoryRecord,
): void {
  const recommendation = advisory.budgetRecommendation;
  if (!recommendation) {
    return;
  }

  const applyToSpec = (spec: ModelSpec): ModelSpec => ({
    ...spec,
    efficiencyBudget: spec.efficiencyBudget
      ? mergeExecutorEfficiencyBudget(spec.efficiencyBudget, recommendation)
      : {
          targetTurns: recommendation.targetTurns ?? 1,
          explorationTurns: recommendation.explorationTurns ?? 1,
          ...(recommendation.shellWarnFloor != null
            ? { shellWarnFloor: recommendation.shellWarnFloor }
            : {}),
          ...(recommendation.shellAbortFloor != null
            ? { shellAbortFloor: recommendation.shellAbortFloor }
            : {}),
          summary: recommendation.rationale,
        },
  });

  stage.model = {
    ...stage.model,
    primary: applyToSpec(stage.model.primary),
    ...(stage.model.fallback ? { fallback: applyToSpec(stage.model.fallback) } : {}),
    ...(stage.model.layered
      ? { layered: stage.model.layered.map((spec) => applyToSpec(spec)) }
      : {}),
  };
}

export function buildFailureAdvisoryCheckpointData(
  advisory: FailureAdvisoryRecord,
): Record<string, unknown> {
  return {
    stageName: advisory.stageName,
    failureCategory: advisory.failureCategory,
    failureSignature: advisory.failureSignature,
    summary: advisory.summary,
    suspectedCause: advisory.suspectedCause,
    recommendedAction: advisory.recommendedAction,
    promptGuidance: advisory.promptGuidance,
    operatorActions: advisory.operatorActions,
    budgetRecommendation: advisory.budgetRecommendation,
    evidenceDigest: advisory.evidenceDigest,
    sourceError: advisory.sourceError,
    retryCount: advisory.retryCount,
  };
}
