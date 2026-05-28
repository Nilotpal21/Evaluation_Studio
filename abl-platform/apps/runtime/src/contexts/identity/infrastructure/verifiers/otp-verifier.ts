/**
 * OTP Identity Verifier
 *
 * Adapter implementing the IdentityVerifier port for one-time password verification.
 * Uses otplib to generate 6-digit TOTP codes and HMAC-SHA256 to hash codes before storage.
 *
 * Two-step flow:
 *   1. initiate() -> generates OTP code, stores hashed code in VerificationTokenStore,
 *      returns the raw code in challengeData so the orchestration layer can dispatch it
 *      via the appropriate channel adapter (SMS, email, etc.).
 *   2. complete() -> hashes the submitted code, compares against stored hash, enforces
 *      expiry and rate limits.
 *
 * Security: OTP codes are never stored in plaintext. HMAC-SHA256 hashing with a
 * server-side secret ensures stored hashes cannot be reversed without the key.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { generateSecret, generate } from 'otplib';
import type { VerificationMethod } from '@agent-platform/shared-auth';
import { createLogger } from '@abl/compiler/platform';
import type {
  IdentityVerifier,
  VerificationInput,
  VerificationInitResult,
  VerificationProof,
  VerificationResult,
} from '../../domain/identity-verifier.js';
import {
  createVerificationAttempt,
  isExpired,
  canAttempt,
} from '../../domain/verification-attempt.js';
import type { VerificationTokenStore } from '../verification-token-store.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Maximum number of verification attempts per OTP flow. */
const OTP_MAX_ATTEMPTS = 5;

/** OTP expiry window in seconds (10 minutes). */
const OTP_TTL_SECONDS = 600;

const log = createLogger('otp-verifier');

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class OtpVerifier implements IdentityVerifier {
  readonly method: VerificationMethod = 'otp';

  constructor(
    private readonly tokenStore: VerificationTokenStore,
    private readonly hmacSecret: string,
  ) {}

  /**
   * Generate a 6-digit OTP code, hash it, store the attempt, and return the code.
   * The raw code is included in challengeData for the orchestration layer to dispatch.
   */
  async initiate(input: VerificationInput): Promise<VerificationInitResult> {
    const secret = generateSecret();
    const code = await generate({ secret });

    const codeHash = this.hashCode(code);

    const attempt = createVerificationAttempt({
      tenantId: input.tenantId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      sessionPrincipalId: input.sessionPrincipalId,
      method: 'otp',
      identityValue: input.identityValue,
      identityType: input.identityType,
      policySource: input.policySource,
      grantScope: input.grantScope,
      traceId: input.traceId,
      expiresAt: new Date(Date.now() + OTP_TTL_SECONDS * 1000),
      maxAttempts: OTP_MAX_ATTEMPTS,
    });

    await this.tokenStore.create({ ...attempt, codeHash });

    log.info('OTP verification initiated', {
      tenantId: input.tenantId,
      attemptId: attempt.id,
      method: 'otp',
    });

    return {
      success: true,
      attemptId: attempt.id,
      challengeData: {
        userAction: 'enter_otp',
        code,
      },
    };
  }

  /**
   * Verify the submitted OTP code against the stored hash.
   * Enforces expiry, rate limits, and tenant isolation.
   */
  async complete(attemptId: string, proof: VerificationProof): Promise<VerificationResult> {
    const tenantId = (proof.metadata?.tenantId as string) ?? '';
    const stored = await this.tokenStore.get(tenantId, attemptId);

    if (!stored) {
      log.warn('OTP attempt not found', { tenantId, attemptId, method: 'otp' });
      return {
        success: false,
        error: { code: 'OTP_ATTEMPT_NOT_FOUND', message: 'Verification attempt not found' },
      };
    }

    if (isExpired(stored)) {
      log.warn('OTP attempt expired', { tenantId, attemptId, method: 'otp' });
      return {
        success: false,
        error: { code: 'OTP_EXPIRED', message: 'Verification attempt has expired' },
      };
    }

    if (!canAttempt(stored)) {
      log.warn('OTP max attempts exceeded', { tenantId, attemptId, method: 'otp' });
      return {
        success: false,
        error: { code: 'OTP_MAX_ATTEMPTS', message: 'Maximum verification attempts exceeded' },
      };
    }

    await this.tokenStore.incrementAttempts(tenantId, attemptId);

    const submittedHash = this.hashCode(proof.value);
    if (!this.safeCompare(submittedHash, stored.codeHash)) {
      log.warn('OTP code invalid', { tenantId, attemptId, method: 'otp' });
      return {
        success: false,
        error: { code: 'OTP_INVALID', message: 'Invalid OTP code' },
      };
    }

    await this.tokenStore.markVerified(tenantId, attemptId);

    log.info('OTP verification completed', { tenantId, attemptId, method: 'otp' });

    return {
      success: true,
      identityTier: 2,
      verifiedIdentity: stored.identityValue,
    };
  }

  /**
   * OTP is a general-purpose verifier triggered by orchestration, not by metadata.
   * Returns true for any input.
   */
  supports(_input: VerificationInput): boolean {
    return true;
  }

  // ===========================================================================
  // PRIVATE HELPERS
  // ===========================================================================

  /** Hash an OTP code with HMAC-SHA256 using the server secret. */
  private hashCode(code: string): string {
    return createHmac('sha256', this.hmacSecret).update(code).digest('hex');
  }

  /** Timing-safe comparison of two hex-encoded hashes. */
  private safeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false;
    }
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  }
}
