/**
 * Verification Token Store Port
 *
 * Port interface for persisting verification attempts (OTP codes, OAuth challenges, etc.).
 * Each attempt is tenant-scoped and carries a hashed code for secure verification.
 * Implementations live in the infrastructure layer (Redis in production, in-memory for tests).
 *
 * All operations are tenant-scoped: get and mutate require tenantId to prevent
 * cross-tenant data leakage.
 */

import type { VerificationAttempt } from '../domain/verification-attempt.js';

// =============================================================================
// STORED TYPE
// =============================================================================

/** Verification attempt extended with a hashed code for secure storage. */
export type StoredVerificationAttempt = VerificationAttempt & { readonly codeHash: string };

// =============================================================================
// PORT INTERFACE
// =============================================================================

export interface VerificationTokenStore {
  /** Persist a new verification attempt with its hashed token. */
  create(attempt: StoredVerificationAttempt): Promise<void>;

  /** Retrieve an attempt by tenant and attempt ID. Returns null if not found or expired. */
  get(tenantId: string, attemptId: string): Promise<StoredVerificationAttempt | null>;

  /** Increment the attempt counter for rate-limiting / retry tracking. */
  incrementAttempts(tenantId: string, attemptId: string): Promise<void>;

  /** Mark an attempt as verified (terminal state). */
  markVerified(tenantId: string, attemptId: string): Promise<void>;
}
