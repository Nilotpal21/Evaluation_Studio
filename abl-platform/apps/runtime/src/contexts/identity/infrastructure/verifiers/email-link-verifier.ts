/**
 * Email Link (Magic Link) Identity Verifier
 *
 * Adapter implementing the IdentityVerifier port for email-based magic link verification.
 * Uses HMAC-SHA256 to hash tokens before storage — the raw token is NEVER persisted.
 *
 * Flow:
 *   initiate() -> generates a random 32-byte token, HMAC-hashes it, stores the hash
 *                 in the VerificationTokenStore as codeHash, returns the raw token in
 *                 challengeData so the orchestration layer can embed it in an email link.
 *   complete() -> loads the attempt, hashes the submitted proof token, compares with
 *                 the stored codeHash. Marks verified on match.
 *   supports() -> returns true for any input (email link is triggered by orchestration,
 *                 not by metadata inspection).
 */

import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import type { VerificationMethod } from '@agent-platform/shared-auth';
import { createLogger } from '@abl/compiler/platform';
import type {
  IdentityVerifier,
  VerificationInput,
  VerificationInitResult,
  VerificationProof,
  VerificationResult,
} from '../../domain/identity-verifier.js';
import { createVerificationAttempt, isExpired } from '../../domain/verification-attempt.js';
import type { VerificationTokenStore } from '../verification-token-store.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Token byte length — 32 bytes = 64 hex characters. */
const TOKEN_BYTE_LENGTH = 32;

/** Token TTL in milliseconds (1 hour). */
const TOKEN_TTL_MS = 3_600_000;

const log = createLogger('email-link-verifier');

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class EmailLinkVerifier implements IdentityVerifier {
  readonly method: VerificationMethod = 'email_link';

  constructor(
    private readonly signingKey: string,
    private readonly tokenStore: VerificationTokenStore,
  ) {}

  async initiate(input: VerificationInput): Promise<VerificationInitResult> {
    const rawToken = randomBytes(TOKEN_BYTE_LENGTH).toString('hex');
    const codeHash = this.hmacHash(rawToken);

    const attempt = createVerificationAttempt({
      tenantId: input.tenantId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      sessionPrincipalId: input.sessionPrincipalId,
      method: 'email_link',
      identityValue: input.identityValue,
      identityType: input.identityType,
      policySource: input.policySource,
      grantScope: input.grantScope,
      traceId: input.traceId,
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
    });

    await this.tokenStore.create({ ...attempt, codeHash });

    log.info('Email link verification initiated', {
      tenantId: input.tenantId,
      attemptId: attempt.id,
      method: 'email_link',
    });

    return {
      success: true,
      attemptId: attempt.id,
      challengeData: {
        userAction: 'check_email',
        token: rawToken,
      },
    };
  }

  async complete(attemptId: string, proof: VerificationProof): Promise<VerificationResult> {
    const tenantId = (proof.metadata?.tenantId as string) ?? '';
    const attempt = await this.tokenStore.get(tenantId, attemptId);

    if (!attempt) {
      log.warn('Email link attempt not found', { tenantId, attemptId, method: 'email_link' });
      return {
        success: false,
        error: { code: 'ATTEMPT_NOT_FOUND', message: 'Verification attempt not found' },
      };
    }

    if (attempt.status === 'verified') {
      log.warn('Email link already verified', { tenantId, attemptId, method: 'email_link' });
      return {
        success: false,
        error: { code: 'ALREADY_VERIFIED', message: 'Token has already been used' },
      };
    }

    if (isExpired(attempt)) {
      log.warn('Email link token expired', { tenantId, attemptId, method: 'email_link' });
      return {
        success: false,
        error: { code: 'TOKEN_EXPIRED', message: 'Verification token has expired' },
      };
    }

    const submittedHash = this.hmacHash(proof.value);
    const storedBuf = Buffer.from(attempt.codeHash, 'hex');
    const submittedBuf = Buffer.from(submittedHash, 'hex');

    if (storedBuf.length !== submittedBuf.length || !timingSafeEqual(storedBuf, submittedBuf)) {
      await this.tokenStore.incrementAttempts(tenantId, attemptId);
      log.warn('Email link token mismatch', { tenantId, attemptId, method: 'email_link' });
      return {
        success: false,
        error: { code: 'TOKEN_MISMATCH', message: 'Submitted token does not match' },
      };
    }

    await this.tokenStore.markVerified(tenantId, attemptId);

    log.info('Email link verification completed', { tenantId, attemptId, method: 'email_link' });

    return {
      success: true,
      identityTier: 2,
      verifiedIdentity: attempt.identityValue,
    };
  }

  supports(_input: VerificationInput): boolean {
    return true;
  }

  /** Compute HMAC-SHA256 hash of a value using the signing key. */
  private hmacHash(value: string): string {
    return createHmac('sha256', this.signingKey).update(value).digest('hex');
  }
}
