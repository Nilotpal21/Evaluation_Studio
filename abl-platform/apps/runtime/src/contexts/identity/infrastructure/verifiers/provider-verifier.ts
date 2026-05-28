/**
 * Provider Identity Verifier
 *
 * Adapter implementing the IdentityVerifier port for channel-provider-verified artifacts.
 * When the channel provider has already verified the identity (e.g., WhatsApp verifies
 * phone numbers), the artifact itself IS the proof. No challenge/response flow needed.
 *
 * Single-step: initiate() checks metadata.providerVerified; complete() is a no-op.
 */

import type { VerificationMethod } from '@agent-platform/shared-auth';
import type {
  IdentityVerifier,
  VerificationInput,
  VerificationInitResult,
  VerificationProof,
  VerificationResult,
} from '../../domain/identity-verifier.js';
import { resolveProviderVerification } from '../../../../services/identity/provider-verification-policy.js';

export class ProviderVerifier implements IdentityVerifier {
  readonly method: VerificationMethod = 'provider';

  async initiate(input: VerificationInput): Promise<VerificationInitResult> {
    if (input.metadata?.providerVerified === true) {
      return { success: true };
    }
    return {
      success: false,
      error: {
        code: 'PROVIDER_NOT_VERIFIED',
        message: 'Artifact was not verified by the channel provider',
      },
    };
  }

  /**
   * No-op — provider verification is completed in initiate().
   * Defaults to tier 1, but trusted callers may carry a stronger provider
   * policy in proof.metadata.providerVerificationStrength.
   */
  async complete(_attemptId: string, proof: VerificationProof): Promise<VerificationResult> {
    const providerVerification = resolveProviderVerification({
      providerVerified: true,
      metadata: proof.metadata,
    });
    return { success: true, identityTier: providerVerification.identityTier };
  }

  supports(input: VerificationInput): boolean {
    return input.metadata != null && typeof input.metadata.providerVerified === 'boolean';
  }
}
