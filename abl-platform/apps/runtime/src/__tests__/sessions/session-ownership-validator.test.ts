/**
 * Session Ownership Validator Tests (Sprint 1 — Task 1.5)
 *
 * Tests for the centralized validateSessionOwnership() function that replaces
 * the duplicated soft-check pattern in handleSubscribeSession, handleResumeSession,
 * and the fork handler.
 *
 * Key design change: fail-closed. Missing tenantId on EITHER side = reject.
 * The old pattern used `a && b && a !== b` which silently allowed access when
 * either tenantId was undefined.
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Types matching the implementation target
// ---------------------------------------------------------------------------

interface SessionOwnershipInput {
  clientTenantId?: string;
  clientUserId?: string;
  sessionTenantId?: string;
  sessionOwnerUserId?: string;
}

interface SessionOwnershipResult {
  allowed: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Dynamic import — will fail until implementation exists
// ---------------------------------------------------------------------------

async function getValidateSessionOwnership() {
  try {
    const mod = await import('../../websocket/session-ownership.js');
    return mod.validateSessionOwnership as (input: SessionOwnershipInput) => SessionOwnershipResult;
  } catch {
    throw new Error(
      'validateSessionOwnership is not available from ../websocket/session-ownership.js. ' +
        'Implement Task 1.5 to make these tests pass.',
    );
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validateSessionOwnership', () => {
  // =========================================================================
  // FAIL-CLOSED: Missing tenantId
  // =========================================================================

  describe('fail-closed — missing tenantId', () => {
    it('rejects when client has no tenantId', async () => {
      const validate = await getValidateSessionOwnership();
      const result = validate({
        clientTenantId: undefined,
        clientUserId: 'user-1',
        sessionTenantId: 'tenant-1',
        sessionOwnerUserId: 'user-1',
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toBeDefined();
    });

    it('rejects when client tenantId is empty string', async () => {
      const validate = await getValidateSessionOwnership();
      const result = validate({
        clientTenantId: '',
        clientUserId: 'user-1',
        sessionTenantId: 'tenant-1',
        sessionOwnerUserId: 'user-1',
      });
      expect(result.allowed).toBe(false);
    });

    it('rejects when session has no tenantId (orphaned session)', async () => {
      const validate = await getValidateSessionOwnership();
      const result = validate({
        clientTenantId: 'tenant-1',
        clientUserId: 'user-1',
        sessionTenantId: undefined,
        sessionOwnerUserId: 'user-1',
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toBeDefined();
    });

    it('rejects when both tenantIds are missing', async () => {
      const validate = await getValidateSessionOwnership();
      const result = validate({
        clientTenantId: undefined,
        clientUserId: 'user-1',
        sessionTenantId: undefined,
        sessionOwnerUserId: 'user-1',
      });
      expect(result.allowed).toBe(false);
    });
  });

  // =========================================================================
  // Cross-tenant rejection
  // =========================================================================

  describe('cross-tenant rejection', () => {
    it('rejects when tenantIds differ', async () => {
      const validate = await getValidateSessionOwnership();
      const result = validate({
        clientTenantId: 'tenant-1',
        clientUserId: 'user-1',
        sessionTenantId: 'tenant-2',
        sessionOwnerUserId: 'user-1',
      });
      expect(result.allowed).toBe(false);
    });

    it('uses 404 semantics in rejection reason (does not leak existence)', async () => {
      const validate = await getValidateSessionOwnership();
      const result = validate({
        clientTenantId: 'tenant-1',
        clientUserId: 'user-1',
        sessionTenantId: 'tenant-2',
        sessionOwnerUserId: 'user-1',
      });
      expect(result.allowed).toBe(false);
      // Reason should say "not found", not "wrong tenant" or "forbidden"
      expect(result.reason?.toLowerCase()).toContain('not found');
    });
  });

  // =========================================================================
  // User ownership
  // =========================================================================

  describe('user ownership within same tenant', () => {
    it('rejects when userIds differ (both set)', async () => {
      const validate = await getValidateSessionOwnership();
      const result = validate({
        clientTenantId: 'tenant-1',
        clientUserId: 'user-1',
        sessionTenantId: 'tenant-1',
        sessionOwnerUserId: 'user-2',
      });
      expect(result.allowed).toBe(false);
    });

    it('allows when userIds match', async () => {
      const validate = await getValidateSessionOwnership();
      const result = validate({
        clientTenantId: 'tenant-1',
        clientUserId: 'user-1',
        sessionTenantId: 'tenant-1',
        sessionOwnerUserId: 'user-1',
      });
      expect(result.allowed).toBe(true);
    });

    it('allows same-tenant access when the stored owner user matches', async () => {
      const validate = await getValidateSessionOwnership();
      const result = validate({
        clientTenantId: 'tenant-1',
        clientUserId: 'user-1',
        sessionTenantId: 'tenant-1',
        sessionOwnerUserId: 'user-1',
      });
      expect(result.allowed).toBe(true);
    });

    it('rejects when the client has no user identity, even in the same tenant', async () => {
      const validate = await getValidateSessionOwnership();
      const result = validate({
        clientTenantId: 'tenant-1',
        clientUserId: undefined,
        sessionTenantId: 'tenant-1',
        sessionOwnerUserId: 'user-1',
      });
      expect(result.allowed).toBe(false);
    });

    it('rejects when the session has no owner identity within the same tenant', async () => {
      const validate = await getValidateSessionOwnership();
      const result = validate({
        clientTenantId: 'tenant-1',
        clientUserId: 'user-1',
        sessionTenantId: 'tenant-1',
        sessionOwnerUserId: undefined,
      });
      expect(result.allowed).toBe(false);
      expect(result.reason?.toLowerCase()).toContain('not found');
    });
  });

  // =========================================================================
  // Happy path
  // =========================================================================

  describe('happy path — same tenant, same user', () => {
    it('allows access and returns no reason', async () => {
      const validate = await getValidateSessionOwnership();
      const result = validate({
        clientTenantId: 'tenant-abc',
        clientUserId: 'user-xyz',
        sessionTenantId: 'tenant-abc',
        sessionOwnerUserId: 'user-xyz',
      });
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe('edge cases', () => {
    it('tenantId comparison is case-sensitive', async () => {
      const validate = await getValidateSessionOwnership();
      const result = validate({
        clientTenantId: 'Tenant-1',
        clientUserId: 'user-1',
        sessionTenantId: 'tenant-1',
        sessionOwnerUserId: 'user-1',
      });
      expect(result.allowed).toBe(false);
    });

    it('userId comparison is case-sensitive', async () => {
      const validate = await getValidateSessionOwnership();
      const result = validate({
        clientTenantId: 'tenant-1',
        clientUserId: 'User-1',
        sessionTenantId: 'tenant-1',
        sessionOwnerUserId: 'user-1',
      });
      expect(result.allowed).toBe(false);
    });
  });
});
