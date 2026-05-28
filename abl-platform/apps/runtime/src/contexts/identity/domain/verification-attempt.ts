/**
 * Verification Attempt
 *
 * Tracks the lifecycle of an identity verification attempt (OTP, OAuth, etc.).
 * Each attempt has a bounded number of retries, an expiry window, and a status
 * that transitions through pending -> verified | expired | failed.
 */

import { randomUUID } from 'node:crypto';
import type { VerificationMethod, ChannelArtifactType } from '@agent-platform/shared-auth';

// =============================================================================
// TYPES
// =============================================================================

export type VerificationStatus = 'pending' | 'verified' | 'expired' | 'failed';

export interface VerificationAttempt {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly sessionPrincipalId: string;
  readonly method: VerificationMethod;
  readonly identityValue: string;
  readonly identityType: ChannelArtifactType;
  readonly policySource: string;
  readonly grantScope: string;
  readonly traceId: string;
  status: VerificationStatus;
  attempts: number;
  readonly maxAttempts: number;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default maximum verification attempts before failure. */
const DEFAULT_MAX_ATTEMPTS = 5;

// =============================================================================
// FACTORY & HELPERS
// =============================================================================

export interface CreateVerificationAttemptInput {
  tenantId: string;
  projectId?: string;
  sessionId: string;
  sessionPrincipalId?: string;
  method: VerificationMethod;
  identityValue: string;
  identityType: ChannelArtifactType;
  policySource?: string;
  grantScope?: string;
  traceId?: string;
  expiresAt: Date;
  maxAttempts?: number;
}

/** Create a new verification attempt in pending state with zero attempts. */
export function createVerificationAttempt(
  input: CreateVerificationAttemptInput,
): VerificationAttempt {
  return {
    id: randomUUID(),
    tenantId: input.tenantId,
    projectId: input.projectId ?? '',
    sessionId: input.sessionId,
    sessionPrincipalId: input.sessionPrincipalId ?? input.sessionId,
    method: input.method,
    identityValue: input.identityValue,
    identityType: input.identityType,
    policySource: input.policySource ?? 'verification_attempt',
    grantScope: input.grantScope ?? 'session',
    traceId: input.traceId ?? randomUUID(),
    status: 'pending',
    attempts: 0,
    maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    createdAt: new Date(),
    expiresAt: input.expiresAt,
  };
}

/** Check whether the attempt has passed its expiry time. */
export function isExpired(attempt: VerificationAttempt): boolean {
  return new Date() > attempt.expiresAt;
}

/** Check whether another verification attempt is allowed. */
export function canAttempt(attempt: VerificationAttempt): boolean {
  return (
    attempt.status === 'pending' && attempt.attempts < attempt.maxAttempts && !isExpired(attempt)
  );
}
