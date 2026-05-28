import { describe, expect, it } from 'vitest';

import { defaultFailureAdvisoryAction } from '../pipeline/engine/failure-advisory-actions.js';
import {
  isCreditBalanceFailure,
  isInactivityStallFailure,
} from '../pipeline/engine/failure-advisory-classify.js';
import type { StageDefinition } from '../types.js';

const stage: Pick<StageDefinition, 'type' | 'name'> = {
  type: 'implementation',
  name: 'Implementation',
};

describe('isCreditBalanceFailure', () => {
  it('matches Anthropic credit-balance error message', () => {
    expect(
      isCreditBalanceFailure(
        'Anthropic API error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}',
      ),
    ).toBe(true);
  });

  it('matches OpenAI insufficient_quota', () => {
    expect(isCreditBalanceFailure('OpenAI error: insufficient_quota')).toBe(true);
  });

  it('matches generic billing/payment-required wording', () => {
    expect(isCreditBalanceFailure('billing required')).toBe(true);
    expect(isCreditBalanceFailure('payment required')).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isCreditBalanceFailure('exceeded maxTurns (50)')).toBe(false);
    expect(isCreditBalanceFailure('Connection refused')).toBe(false);
  });
});

describe('isInactivityStallFailure', () => {
  it('matches Codex inactivity-stall message format', () => {
    expect(
      isInactivityStallFailure(
        'Codex stalled after 944s of inactivity (1376s total elapsed, 9 turns)',
      ),
    ).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isInactivityStallFailure('exceeded maxTurns (50)')).toBe(false);
    expect(isInactivityStallFailure('Anthropic credit balance is too low')).toBe(false);
  });
});

describe('defaultFailureAdvisoryAction error-class routing', () => {
  it('pauses immediately on credit-balance error (no retry burn)', () => {
    const result = defaultFailureAdvisoryAction(
      stage as StageDefinition,
      'model-error',
      'Your credit balance is too low to access the Anthropic API.',
      0,
    );
    expect(result).toBe('pause-and-resume');
  });

  it('still pauses on credit-balance error even before MAX_RETRIES', () => {
    // priorRetryCount=0 — verifies the credit check fires BEFORE the
    // retry-budget check, so the first occurrence pauses immediately.
    const result = defaultFailureAdvisoryAction(
      stage as StageDefinition,
      'model-error',
      'insufficient_quota',
      0,
    );
    expect(result).toBe('pause-and-resume');
  });

  it('switches model on Codex inactivity stall', () => {
    const result = defaultFailureAdvisoryAction(
      stage as StageDefinition,
      'model-error',
      'Codex stalled after 944s of inactivity (1376s total elapsed, 9 turns)',
      0,
    );
    expect(result).toBe('switch-model');
  });

  it('still retries on plain maxTurns errors (preserves pre-existing behavior)', () => {
    const result = defaultFailureAdvisoryAction(
      stage as StageDefinition,
      'model-error',
      'Anthropic API exceeded maxTurns (50) before returning a final response',
      0,
    );
    expect(result).toBe('retry-stage');
  });
});
