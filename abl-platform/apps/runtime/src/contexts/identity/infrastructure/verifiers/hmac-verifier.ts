/**
 * HMAC Identity Verifier
 *
 * Adapter implementing the IdentityVerifier port for HMAC-based identity verification.
 * Wraps the existing verifyHMAC function from artifact-hasher.ts — does not duplicate logic.
 *
 * HMAC verification is single-step: initiate() performs the check immediately using
 * the hmac + timestamp provided in metadata. complete() is a no-op since there is
 * no challenge/response flow.
 */

import type { VerificationMethod } from '@agent-platform/shared-auth';
import type {
  IdentityVerifier,
  VerificationInput,
  VerificationInitResult,
  VerificationProof,
  VerificationResult,
} from '../../domain/identity-verifier.js';
import { verifyHMAC } from '../../../../services/identity/artifact-hasher.js';

export class HmacVerifier implements IdentityVerifier {
  readonly method: VerificationMethod = 'hmac';

  constructor(private readonly secretKey: string) {}

  /**
   * Perform HMAC verification immediately.
   * Expects metadata to contain { hmac: string, timestamp: number }.
   */
  async initiate(input: VerificationInput): Promise<VerificationInitResult> {
    const { metadata, identityValue } = input;

    if (!metadata || typeof metadata.hmac !== 'string' || typeof metadata.timestamp !== 'number') {
      return {
        success: false,
        error: {
          code: 'HMAC_MISSING_METADATA',
          message: 'HMAC verification requires metadata with hmac (string) and timestamp (number)',
        },
      };
    }

    const result = verifyHMAC(
      {
        userId: identityValue,
        hmac: metadata.hmac,
        timestamp: metadata.timestamp,
      },
      this.secretKey,
    );

    return {
      success: result.success,
      error: result.error,
    };
  }

  /**
   * No-op for HMAC — verification is completed in initiate().
   * Returns success with tier 2 (HMAC is a strong verification method).
   */
  async complete(_attemptId: string, _proof: VerificationProof): Promise<VerificationResult> {
    return {
      success: true,
      identityTier: 2,
    };
  }

  /**
   * Returns true when the input carries HMAC-relevant metadata (hmac + timestamp).
   */
  supports(input: VerificationInput): boolean {
    const { metadata } = input;
    return (
      metadata != null &&
      typeof metadata.hmac === 'string' &&
      typeof metadata.timestamp === 'number'
    );
  }
}
