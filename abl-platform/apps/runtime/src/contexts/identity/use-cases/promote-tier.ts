/**
 * Promote Tier Use Case
 *
 * Pure domain logic for identity tier promotion. Validates whether the
 * verification method yields a higher tier than the current one using
 * canPromoteTo() and tierFromVerification() from the identity-tier domain.
 */

import type { IdentityTier, VerificationMethod } from '@agent-platform/shared-auth';
import { canPromoteTo, tierFromVerification } from '../domain/identity-tier.js';

// =============================================================================
// INPUT / RESULT TYPES
// =============================================================================

export interface PromoteTierInput {
  readonly currentTier: IdentityTier;
  readonly verificationMethod: VerificationMethod;
  /** Optional explicit tier classification when a verifier/policy resolves stronger trust. */
  readonly resolvedTier?: IdentityTier;
}

export type PromoteTierResult =
  | {
      success: true;
      newTier: IdentityTier;
      verificationMethod: VerificationMethod;
    }
  | {
      success: false;
      error: { code: string; message: string };
    };

// =============================================================================
// USE CASE
// =============================================================================

export class PromoteTier {
  execute(input: PromoteTierInput): PromoteTierResult {
    const baselineTier = tierFromVerification(input.verificationMethod);
    const targetTier = Math.max(baselineTier, input.resolvedTier ?? baselineTier) as IdentityTier;

    if (!canPromoteTo(input.currentTier, targetTier)) {
      return {
        success: false,
        error: {
          code: 'TIER_NOT_PROMOTED',
          message: `Cannot promote from tier ${input.currentTier} to tier ${targetTier} via ${input.verificationMethod}`,
        },
      };
    }

    return {
      success: true,
      newTier: targetTier,
      verificationMethod: input.verificationMethod,
    };
  }
}
