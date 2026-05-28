/**
 * RBAC Middleware Tests
 *
 * Tests for middleware/rbac.ts which exports:
 * - requireWriteAccess: checks that authenticated user has OWNER, ADMIN, or OPERATOR role
 * - WRITE_ROLES: constant array of write-capable roles
 * - READ_ROLES: constant array of read-capable roles
 *
 * Covers:
 * - Missing tenantContext returns 401
 * - User with OWNER role passes
 * - User with ADMIN role passes
 * - User with OPERATOR role passes
 * - User with VIEWER role gets 403
 * - User with MEMBER role gets 403
 * - Missing tenantContext role gets 403
 * - Role constants are correct
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// IMPORT UNDER TEST
// =============================================================================

import { requireWriteAccess, WRITE_ROLES, READ_ROLES } from '../../middleware/rbac.js';

// =============================================================================
// HELPERS
// =============================================================================

function createMockReq(tenantContext?: { tenantId: string; userId: string; role?: string }) {
  return {
    tenantContext: tenantContext ?? undefined,
    headers: { 'x-request-id': 'test-req-id' },
    method: 'POST',
    originalUrl: '/test',
    params: {},
    query: {},
  } as any;
}

function createMockRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as any;
}

// =============================================================================
// TESTS: WRITE_ROLES and READ_ROLES constants
// =============================================================================

describe('RBAC role constants', () => {
  test('WRITE_ROLES contains OWNER, ADMIN, OPERATOR', () => {
    expect(WRITE_ROLES).toEqual(['OWNER', 'ADMIN', 'OPERATOR']);
  });

  test('READ_ROLES contains OWNER, ADMIN, OPERATOR, VIEWER', () => {
    expect(READ_ROLES).toEqual(['OWNER', 'ADMIN', 'OPERATOR', 'VIEWER']);
  });

  test('WRITE_ROLES is a subset of READ_ROLES', () => {
    for (const role of WRITE_ROLES) {
      expect(READ_ROLES).toContain(role);
    }
  });

  test('WRITE_ROLES is declared as const (type-level readonly)', () => {
    // `as const` provides type-level immutability, not runtime freeze.
    // Verify it has the expected length and values.
    expect(WRITE_ROLES).toHaveLength(3);
    expect(Array.isArray(WRITE_ROLES)).toBe(true);
  });

  test('READ_ROLES is declared as const (type-level readonly)', () => {
    expect(READ_ROLES).toHaveLength(4);
    expect(Array.isArray(READ_ROLES)).toBe(true);
  });
});

// =============================================================================
// TESTS: requireWriteAccess
// =============================================================================

describe('requireWriteAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Missing tenant context
  // -------------------------------------------------------------------------

  test('returns false and sends 401 when tenantContext is missing', async () => {
    const req = createMockReq();
    const res = createMockRes();

    const result = await requireWriteAccess(req, res);

    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          code: 'AUTHENTICATION_REQUIRED',
          message: 'Authentication required',
        }),
      }),
    );
  });

  test('returns false and sends 401 when tenantContext is undefined', async () => {
    const req = createMockReq();
    const res = createMockRes();

    const result = await requireWriteAccess(req, res);

    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  // -------------------------------------------------------------------------
  // Write roles pass
  // -------------------------------------------------------------------------

  test('returns true for OWNER role', async () => {
    const req = createMockReq({ tenantId: 'tenant-1', userId: 'user-1', role: 'OWNER' });
    const res = createMockRes();

    const result = await requireWriteAccess(req, res);

    expect(result).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('returns true for ADMIN role', async () => {
    const req = createMockReq({ tenantId: 'tenant-1', userId: 'user-1', role: 'ADMIN' });
    const res = createMockRes();

    const result = await requireWriteAccess(req, res);

    expect(result).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('returns true for OPERATOR role', async () => {
    const req = createMockReq({ tenantId: 'tenant-1', userId: 'user-1', role: 'OPERATOR' });
    const res = createMockRes();

    const result = await requireWriteAccess(req, res);

    expect(result).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Non-write roles get 403
  // -------------------------------------------------------------------------

  test('returns false and sends 403 for VIEWER role', async () => {
    const req = createMockReq({ tenantId: 'tenant-1', userId: 'user-1', role: 'VIEWER' });
    const res = createMockRes();

    const result = await requireWriteAccess(req, res);

    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          code: 'TENANT_WRITE_ROLE_REQUIRED',
          message: 'Insufficient permissions',
        }),
      }),
    );
  });

  test('returns false and sends 403 for MEMBER role', async () => {
    const req = createMockReq({ tenantId: 'tenant-1', userId: 'user-1', role: 'MEMBER' });
    const res = createMockRes();

    const result = await requireWriteAccess(req, res);

    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('returns false and sends 403 for an unknown role string', async () => {
    const req = createMockReq({ tenantId: 'tenant-1', userId: 'user-1', role: 'CUSTOM_ROLE' });
    const res = createMockRes();

    const result = await requireWriteAccess(req, res);

    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('returns false and sends 403 for sdk_session role', async () => {
    const req = createMockReq({ tenantId: 'tenant-1', userId: 'user-1', role: 'sdk_session' });
    const res = createMockRes();

    const result = await requireWriteAccess(req, res);

    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('returns false and sends 403 for api_key role', async () => {
    const req = createMockReq({ tenantId: 'tenant-1', userId: 'user-1', role: 'api_key' });
    const res = createMockRes();

    const result = await requireWriteAccess(req, res);

    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  // -------------------------------------------------------------------------
  // Missing role
  // -------------------------------------------------------------------------

  test('returns false and sends 403 when role is missing from tenantContext', async () => {
    const req = createMockReq({ tenantId: 'tenant-1', userId: 'user-1' });
    const res = createMockRes();

    const result = await requireWriteAccess(req, res);

    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          code: 'TENANT_WRITE_ROLE_REQUIRED',
          message: 'Insufficient permissions',
        }),
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Correct parameters passed to repo
  // -------------------------------------------------------------------------

  test('uses the role from tenantContext without mutating the request object', async () => {
    const req = createMockReq({ tenantId: 'my-tenant', userId: 'my-user', role: 'ADMIN' });
    const res = createMockRes();

    const result = await requireWriteAccess(req, res);

    expect(result).toBe(true);
    expect(req.tenantContext).toEqual({
      tenantId: 'my-tenant',
      userId: 'my-user',
      role: 'ADMIN',
    });
  });

  // -------------------------------------------------------------------------
  // All write roles pass in a loop
  // -------------------------------------------------------------------------

  test('passes for every role in WRITE_ROLES', async () => {
    for (const role of WRITE_ROLES) {
      vi.clearAllMocks();
      const req = createMockReq({ tenantId: 'tenant-1', userId: 'user-1', role });
      const res = createMockRes();

      const result = await requireWriteAccess(req, res);

      expect(result).toBe(true);
      expect(res.status).not.toHaveBeenCalled();
    }
  });
});
