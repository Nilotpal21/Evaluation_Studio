export interface FailureAdvisoryRetryPlanInput {
  switchModelRetry: boolean;
  immediateOnlyRetry: boolean;
  zeroTurnStartupSwitch: boolean;
  stableReplayModelSwitch: boolean;
  retainCurrentSynthesisRetry: boolean;
  retryInSynthesisMode: boolean;
  currentReplaySynthesisRetry: boolean;
  evidenceOnlyRetry: boolean;
  stableReplayRetry: boolean;
  stableReplayEvidenceRetry: boolean;
}

export interface FailureAdvisoryRetryPlan {
  retryInSynthesisMode: boolean;
  initialRestoreStage: boolean;
  restoreStageBeforeRetryMode: boolean;
  applySynthesisMode: boolean;
  applyBudgetRecommendation: boolean;
  applyEvidenceOnlyRetryMode: boolean;
  applyStableReplayRetryMode: boolean;
  applySwitchModelMode: boolean;
  applyImmediateOnlyPrompt: boolean;
  promptMode: 'synthesis' | 'evidence-only' | 'retry';
}

export function buildFailureAdvisoryRetryPlan(
  input: FailureAdvisoryRetryPlanInput,
): FailureAdvisoryRetryPlan {
  if (input.retryInSynthesisMode) {
    if (input.currentReplaySynthesisRetry) {
      const keepEvidenceOnlyRetry =
        input.evidenceOnlyRetry &&
        (input.stableReplayEvidenceRetry ||
          input.stableReplayRetry ||
          input.stableReplayModelSwitch);
      return {
        retryInSynthesisMode: true,
        initialRestoreStage: input.switchModelRetry && !input.retainCurrentSynthesisRetry,
        restoreStageBeforeRetryMode: input.switchModelRetry,
        applySynthesisMode: false,
        applyBudgetRecommendation: false,
        applyEvidenceOnlyRetryMode: keepEvidenceOnlyRetry,
        applyStableReplayRetryMode:
          (input.switchModelRetry && input.stableReplayModelSwitch) ||
          (keepEvidenceOnlyRetry && input.stableReplayEvidenceRetry) ||
          input.stableReplayRetry,
        applySwitchModelMode: input.switchModelRetry && !input.zeroTurnStartupSwitch,
        applyImmediateOnlyPrompt: input.immediateOnlyRetry,
        promptMode: keepEvidenceOnlyRetry ? 'evidence-only' : 'synthesis',
      };
    }

    return {
      retryInSynthesisMode: true,
      initialRestoreStage: !input.retainCurrentSynthesisRetry,
      restoreStageBeforeRetryMode: false,
      applySynthesisMode: true,
      applyBudgetRecommendation: false,
      applyEvidenceOnlyRetryMode: false,
      applyStableReplayRetryMode: input.stableReplayModelSwitch,
      applySwitchModelMode: input.switchModelRetry,
      applyImmediateOnlyPrompt: input.immediateOnlyRetry,
      promptMode: 'synthesis',
    };
  }

  return {
    retryInSynthesisMode: false,
    initialRestoreStage: !input.retainCurrentSynthesisRetry,
    restoreStageBeforeRetryMode: false,
    applySynthesisMode: false,
    applyBudgetRecommendation: true,
    applyEvidenceOnlyRetryMode: input.evidenceOnlyRetry,
    applyStableReplayRetryMode:
      input.stableReplayModelSwitch ||
      input.stableReplayRetry ||
      (input.evidenceOnlyRetry && input.stableReplayEvidenceRetry),
    applySwitchModelMode: input.switchModelRetry,
    applyImmediateOnlyPrompt: input.immediateOnlyRetry,
    promptMode: input.evidenceOnlyRetry ? 'evidence-only' : 'retry',
  };
}
