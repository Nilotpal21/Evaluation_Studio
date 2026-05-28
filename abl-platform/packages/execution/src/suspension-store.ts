/**
 * SuspensionStore — persistence interface for SuspendedExecution records.
 *
 * Implementation uses MongoDB for durability. All queries include tenantId
 * for tenant isolation (platform invariant #1).
 */

import type { SuspendedExecution } from './suspension.js';

export interface SuspensionStore {
  /** Create a new suspension record */
  create(suspension: SuspendedExecution): Promise<void>;

  /** Load a suspension by ID */
  load(suspensionId: string): Promise<SuspendedExecution | null>;

  /** Load by tenantId + suspensionId (for tenant isolation) */
  loadScoped(tenantId: string, suspensionId: string): Promise<SuspendedExecution | null>;

  /** Load by callbackId (fallback when Redis entry evicted). Security relies on callbackId being unguessable (UUID) + HMAC verification. */
  loadByCallbackId(callbackId: string): Promise<SuspendedExecution | null>;

  /**
   * Atomically claim a suspension for resume.
   * Transitions status from 'suspended' to 'resuming'.
   * Returns false if already claimed by another pod.
   * Uses MongoDB findOneAndUpdate with status check.
   */
  claimForResume(suspensionId: string): Promise<boolean>;

  /** Release a claim (if resume fails transiently, allow retry) */
  releaseClaim(suspensionId: string): Promise<void>;

  /** Mark as completed */
  complete(suspensionId: string): Promise<void>;

  /** Mark as failed with error details */
  fail(suspensionId: string, error: { code: string; message: string }): Promise<void>;

  /** Mark as expired (called by timeout worker) */
  expire(suspensionId: string): Promise<void>;

  /** Cancel a suspension */
  cancel(suspensionId: string): Promise<void>;

  /** Find all suspensions for a given barrier (for fan-out join) */
  findByBarrier(barrierId: string): Promise<SuspendedExecution[]>;

  /** Find expired suspensions (for timeout worker) */
  findExpired(limit: number): Promise<SuspendedExecution[]>;

  /** Find suspensions for a session (for session cleanup) */
  findBySession(sessionId: string): Promise<SuspendedExecution[]>;

  /**
   * List suspensions with filters (for admin API).
   * All queries are scoped by tenantId.
   */
  list(params: {
    tenantId: string;
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<SuspendedExecution[]>;
}
