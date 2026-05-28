/**
 * Session Ownership Validator (Sprint 1 — Task 1.5)
 *
 * Centralized, fail-closed validation for session access.
 * Replaces the duplicated soft-check pattern (`a && b && a !== b`)
 * in handleSubscribeSession, handleResumeSession, and the fork handler.
 *
 * Key design: missing tenantId on EITHER side = reject.
 * Cross-tenant rejections use 404 semantics to avoid leaking existence.
 */

// ─── Types ────────────────────────────────────────────────────────────────

export interface SessionOwnershipInput {
  clientTenantId?: string;
  clientUserId?: string;
  sessionTenantId?: string;
  sessionOwnerUserId?: string;
}

export interface SessionOwnershipResult {
  allowed: boolean;
  concealAsNotFound?: boolean;
  reasonCode?: string;
  reason?: string;
  statusCode?: 401 | 403 | 404;
}

// ─── Validator ────────────────────────────────────────────────────────────

/**
 * Validate that a client is allowed to access a session.
 *
 * Rules (fail-closed):
 * 1. Both client and session MUST have a non-empty tenantId → reject otherwise
 * 2. tenantIds must match exactly (case-sensitive) → reject with "not found" semantics
 * 3. The client MUST carry a user identity → reject otherwise
 * 4. The session MUST resolve to an owner user identity → reject otherwise
 * 5. The client and session owner must match exactly
 */
export function validateSessionOwnership(input: SessionOwnershipInput): SessionOwnershipResult {
  const { clientTenantId, clientUserId, sessionTenantId, sessionOwnerUserId } = input;

  // 1. Fail-closed: require tenantId on both sides
  if (!clientTenantId) {
    return {
      allowed: false,
      reasonCode: 'CLIENT_TENANT_CONTEXT_REQUIRED',
      reason: 'Client tenant context is required',
      concealAsNotFound: false,
      statusCode: 403,
    };
  }
  if (!sessionTenantId) {
    return {
      allowed: false,
      reasonCode: 'SESSION_TENANT_CONTEXT_MISSING',
      reason: 'Session has no tenant context (orphaned)',
      concealAsNotFound: false,
      statusCode: 403,
    };
  }

  // 2. Cross-tenant check — 404 semantics (don't leak existence)
  if (clientTenantId !== sessionTenantId) {
    return {
      allowed: false,
      reasonCode: 'SESSION_TENANT_MISMATCH',
      reason: 'Session not found',
      concealAsNotFound: true,
      statusCode: 404,
    };
  }

  if (!clientUserId) {
    return {
      allowed: false,
      reasonCode: 'CLIENT_USER_CONTEXT_REQUIRED',
      reason: 'Authentication required',
      concealAsNotFound: false,
      statusCode: 401,
    };
  }

  if (!sessionOwnerUserId) {
    return {
      allowed: false,
      reasonCode: 'SESSION_OWNER_CONTEXT_MISSING',
      reason: 'Session not found',
      concealAsNotFound: true,
      statusCode: 404,
    };
  }

  if (clientUserId !== sessionOwnerUserId) {
    return {
      allowed: false,
      reasonCode: 'SESSION_USER_MISMATCH',
      reason: 'Session not found',
      concealAsNotFound: true,
      statusCode: 404,
    };
  }

  return { allowed: true };
}
