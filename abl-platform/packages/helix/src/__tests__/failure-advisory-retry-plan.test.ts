import { describe, expect, it } from 'vitest';

import { buildFailureAdvisoryRetryPlan } from '../pipeline/failure-advisory-retry-plan.js';

describe('failure-advisory-retry-plan', () => {
  it('keeps replay synthesis retries on evidence-only mode when the seam is already loaded', () => {
    const plan = buildFailureAdvisoryRetryPlan({
      switchModelRetry: true,
      immediateOnlyRetry: true,
      zeroTurnStartupSwitch: false,
      stableReplayModelSwitch: true,
      retainCurrentSynthesisRetry: false,
      retryInSynthesisMode: true,
      currentReplaySynthesisRetry: true,
      evidenceOnlyRetry: true,
      stableReplayRetry: false,
      stableReplayEvidenceRetry: true,
    });

    expect(plan).toMatchObject({
      retryInSynthesisMode: true,
      initialRestoreStage: true,
      restoreStageBeforeRetryMode: true,
      applyEvidenceOnlyRetryMode: true,
      applyStableReplayRetryMode: true,
      applySwitchModelMode: true,
      applyImmediateOnlyPrompt: true,
      promptMode: 'evidence-only',
    });
  });

  it('keeps zero-turn startup synthesis retries in synthesis mode while still switching models', () => {
    const plan = buildFailureAdvisoryRetryPlan({
      switchModelRetry: true,
      immediateOnlyRetry: false,
      zeroTurnStartupSwitch: true,
      stableReplayModelSwitch: false,
      retainCurrentSynthesisRetry: false,
      retryInSynthesisMode: true,
      currentReplaySynthesisRetry: false,
      evidenceOnlyRetry: false,
      stableReplayRetry: false,
      stableReplayEvidenceRetry: false,
    });

    expect(plan).toMatchObject({
      retryInSynthesisMode: true,
      applySynthesisMode: true,
      applySwitchModelMode: true,
      promptMode: 'synthesis',
    });
  });

  it('keeps non-synthesis retries on the compact evidence-only path when applicable', () => {
    const plan = buildFailureAdvisoryRetryPlan({
      switchModelRetry: false,
      immediateOnlyRetry: true,
      zeroTurnStartupSwitch: false,
      stableReplayModelSwitch: false,
      retainCurrentSynthesisRetry: false,
      retryInSynthesisMode: false,
      currentReplaySynthesisRetry: false,
      evidenceOnlyRetry: true,
      stableReplayRetry: true,
      stableReplayEvidenceRetry: true,
    });

    expect(plan).toMatchObject({
      retryInSynthesisMode: false,
      applyBudgetRecommendation: true,
      applyEvidenceOnlyRetryMode: true,
      applyStableReplayRetryMode: true,
      applyImmediateOnlyPrompt: true,
      promptMode: 'evidence-only',
    });
  });
});
