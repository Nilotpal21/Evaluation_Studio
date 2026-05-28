/**
 * Identity Tier Logic
 *
 * Defines promotion rules between identity tiers and maps verification
 * methods to their corresponding tier levels.
 *
 * Tier 0 = anonymous, Tier 1 = recognized (channel artifact), Tier 2 = verified (cryptographic proof).
 */

import type { IdentityTier, VerificationMethod } from '@agent-platform/shared-auth';

export type { IdentityTier };

/**
 * Whether the current tier can be promoted to the target tier.
 * Promotion is strictly upward: 0->1, 0->2, 1->2.
 * Same-tier and downgrade are not allowed.
 */
export function canPromoteTo(current: IdentityTier, target: IdentityTier): boolean {
  return target > current;
}

/** Map from verification method to the identity tier it grants. */
const VERIFICATION_TIER_MAP: Record<VerificationMethod, IdentityTier> = {
  none: 0,
  cookie: 1,
  caller_id: 1,
  provider: 1,
  webhook: 1,
  hmac: 2,
  otp: 2,
  oauth: 2,
  email_link: 2,
  server_secret: 2,
};

/**
 * Determine which identity tier a verification method grants.
 * Provider-level verification defaults to tier 1 unless explicitly overridden.
 */
export function tierFromVerification(method: VerificationMethod): IdentityTier {
  return VERIFICATION_TIER_MAP[method];
}
