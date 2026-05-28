import type { ModelAssignment, ModelSpec } from '../../types.js';

/**
 * Blocking quality-gate reviews should keep moving even when the primary
 * Claude reviewer is temporarily unavailable (credits / transport).
 */
export function withCodexReviewFallback(primary: ModelSpec): ModelAssignment {
  return {
    primary,
    fallback: {
      engine: 'codex-cli',
      model: 'gpt-5.4',
      effort: 'high',
      maxTurns: primary.maxTurns,
      maxBudgetUsd: primary.maxBudgetUsd,
      permissionMode: 'bypassPermissions',
    },
  };
}
