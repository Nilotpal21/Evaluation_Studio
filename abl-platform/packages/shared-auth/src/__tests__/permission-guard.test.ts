import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import type { TenantContextData } from '../types/index.js';
import {
  requirePermission,
  requireAllPermissions,
  requireAnyPermission,
  requireProjectScope,
  requireEnvironmentScope,
  requireAuthType,
  requirePlatformAdmin,
  isIpAllowed,
  requirePlatformAdminIp,
} from '../middleware/permission-guard.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTenantContext(overrides: Partial<TenantContextData> = {}): TenantContextData {
  return {
    tenantId: 'tenant-1',
    userId: 'user-1',
    role: 'ADMIN',
    permissions: [],
    authType: 'user',
    isSuperAdmin: false,
    ...overrides,
  };
}

function createMocks(tenantContext?: TenantContextData) {
  const reportAccessDenied = vi.fn();
  const req = {
    tenantContext,
    params: {} as Record<string, string>,
    query: {} as Record<string, string>,
    body: {} as Record<string, unknown>,
    headers: {} as Record<string, string>,
    ip: '127.0.0.1',
    reportAccessDenied,
  } as unknown as Request;

  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;

  const next = vi.fn() as NextFunction;

  return { req, res, next };
}

// ---------------------------------------------------------------------------
// requirePermission
// ---------------------------------------------------------------------------

describe('requirePermission', () => {
  it('returns 401 when no tenantContext', () => {
    const { req, res, next } = createMocks(undefined);
    requirePermission('agent:read')(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(req.reportAccessDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        layer: 'permission_guard',
        scope: 'auth',
        reasonCode: 'AUTHENTICATION_REQUIRED',
        requiredPermission: 'agent:read',
      }),
    );
  });

  it('calls next when permission is present', () => {
    const { req, res, next } = createMocks(
      makeTenantContext({ permissions: ['agent:read', 'agent:write'] }),
    );
    requirePermission('agent:read')(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 403 when permission is absent', () => {
    const { req, res, next } = createMocks(makeTenantContext({ permissions: ['agent:read'] }));
    requirePermission('agent:delete')(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
    expect(req.reportAccessDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        layer: 'permission_guard',
        scope: 'rbac',
        reasonCode: 'PERMISSION_REQUIRED',
        requiredPermission: 'agent:delete',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// requireAllPermissions
// ---------------------------------------------------------------------------

describe('requireAllPermissions', () => {
  it('calls next when all permissions present', () => {
    const { req, res, next } = createMocks(
      makeTenantContext({
        permissions: ['agent:read', 'agent:write', 'agent:delete'],
      }),
    );
    requireAllPermissions(['agent:read', 'agent:write'])(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('returns 403 when one permission missing', () => {
    const { req, res, next } = createMocks(makeTenantContext({ permissions: ['agent:read'] }));
    requireAllPermissions(['agent:read', 'agent:delete'])(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
    expect(req.reportAccessDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        layer: 'permission_guard',
        scope: 'rbac',
        reasonCode: 'PERMISSION_REQUIRED',
        requiredPermission: ['agent:read', 'agent:delete'],
      }),
    );
  });

  it('calls next when empty array required', () => {
    const { req, res, next } = createMocks(makeTenantContext());
    requireAllPermissions([])(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('returns 401 when no tenantContext', () => {
    const { req, res, next } = createMocks(undefined);
    requireAllPermissions(['agent:read'])(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

// ---------------------------------------------------------------------------
// requireAnyPermission
// ---------------------------------------------------------------------------

describe('requireAnyPermission', () => {
  it('calls next when one permission is present', () => {
    const { req, res, next } = createMocks(makeTenantContext({ permissions: ['agent:read'] }));
    requireAnyPermission(['agent:read', 'agent:delete'])(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('returns 403 when none present', () => {
    const { req, res, next } = createMocks(makeTenantContext({ permissions: ['project:read'] }));
    requireAnyPermission(['agent:read', 'agent:delete'])(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
    expect(req.reportAccessDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        layer: 'permission_guard',
        scope: 'rbac',
        reasonCode: 'PERMISSION_REQUIRED',
        requiredPermission: ['agent:read', 'agent:delete'],
      }),
    );
  });

  it('returns 401 when no tenantContext', () => {
    const { req, res, next } = createMocks(undefined);
    requireAnyPermission(['agent:read'])(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

// ---------------------------------------------------------------------------
// requireProjectScope
// ---------------------------------------------------------------------------

describe('requireProjectScope', () => {
  it('calls next when no projectScope on context', () => {
    const { req, res, next } = createMocks(makeTenantContext());
    (req as any).params = { projectId: 'proj-1' };
    requireProjectScope()(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('calls next when projectId is in scope', () => {
    const { req, res, next } = createMocks(
      makeTenantContext({ projectScope: ['proj-1', 'proj-2'] }),
    );
    (req as any).params = { projectId: 'proj-1' };
    requireProjectScope()(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('returns 403 when projectId not in scope', () => {
    const { req, res, next } = createMocks(makeTenantContext({ projectScope: ['proj-1'] }));
    (req as any).params = { projectId: 'proj-99' };
    requireProjectScope()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
    expect(req.reportAccessDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        layer: 'project_scope',
        scope: 'project',
        reasonCode: 'PROJECT_SCOPE_MISMATCH',
        concealAsNotFound: false,
        resourceId: 'proj-99',
      }),
    );
  });

  it('returns 404 with denial reporting when concealment is enabled', () => {
    const { req, res, next } = createMocks(makeTenantContext({ projectScope: ['proj-1'] }));
    (req as any).params = { projectId: 'proj-99' };
    requireProjectScope('projectId', { concealOutOfScope: true })(req, res, next);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
    expect(req.reportAccessDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        layer: 'project_scope',
        scope: 'project',
        reasonCode: 'PROJECT_SCOPE_MISMATCH',
        concealAsNotFound: true,
        statusCode: 404,
        resourceId: 'proj-99',
      }),
    );
  });

  it('calls next when no projectId in request (route not project-specific)', () => {
    const { req, res, next } = createMocks(makeTenantContext({ projectScope: ['proj-1'] }));
    requireProjectScope()(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('uses custom paramName', () => {
    const { req, res, next } = createMocks(makeTenantContext({ projectScope: ['proj-1'] }));
    (req as any).params = { pid: 'proj-1' };
    requireProjectScope('pid')(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('returns 401 when no tenantContext', () => {
    const { req, res, next } = createMocks(undefined);
    requireProjectScope()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

// ---------------------------------------------------------------------------
// requireEnvironmentScope
// ---------------------------------------------------------------------------

describe('requireEnvironmentScope', () => {
  it('calls next when no environmentScope on context', () => {
    const { req, res, next } = createMocks(makeTenantContext());
    (req as any).params = { environment: 'production' };
    requireEnvironmentScope()(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('calls next when environment is in scope (via params)', () => {
    const { req, res, next } = createMocks(
      makeTenantContext({ environmentScope: ['production', 'staging'] }),
    );
    (req as any).params = { environment: 'production' };
    requireEnvironmentScope()(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('returns 403 when environment not in scope', () => {
    const { req, res, next } = createMocks(makeTenantContext({ environmentScope: ['staging'] }));
    (req as any).params = { environment: 'production' };
    requireEnvironmentScope()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(req.reportAccessDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        layer: 'environment_scope',
        scope: 'project',
        reasonCode: 'ENVIRONMENT_SCOPE_MISMATCH',
        resourceId: 'production',
      }),
    );
  });

  it('calls next when no environment in request', () => {
    const { req, res, next } = createMocks(makeTenantContext({ environmentScope: ['staging'] }));
    requireEnvironmentScope()(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('reads from query if not in params', () => {
    const { req, res, next } = createMocks(makeTenantContext({ environmentScope: ['production'] }));
    (req as any).query = { environment: 'production' };
    requireEnvironmentScope()(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('reads from body if not in params or query', () => {
    const { req, res, next } = createMocks(makeTenantContext({ environmentScope: ['production'] }));
    (req as any).body = { environment: 'production' };
    requireEnvironmentScope()(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('returns 401 when no tenantContext', () => {
    const { req, res, next } = createMocks(undefined);
    requireEnvironmentScope()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

// ---------------------------------------------------------------------------
// requireAuthType
// ---------------------------------------------------------------------------

describe('requireAuthType', () => {
  it('calls next when authType matches', () => {
    const { req, res, next } = createMocks(makeTenantContext({ authType: 'user' }));
    requireAuthType('user')(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('returns 403 when authType does not match', () => {
    const { req, res, next } = createMocks(makeTenantContext({ authType: 'api_key' }));
    requireAuthType('user')(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(req.reportAccessDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        layer: 'auth_type',
        scope: 'rbac',
        reasonCode: 'AUTH_TYPE_REQUIRED',
      }),
    );
  });

  it('accepts multiple authTypes', () => {
    const { req, res, next } = createMocks(makeTenantContext({ authType: 'api_key' }));
    requireAuthType('user', 'api_key')(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('returns 401 when no tenantContext', () => {
    const { req, res, next } = createMocks(undefined);
    requireAuthType('user')(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

// ---------------------------------------------------------------------------
// requirePlatformAdmin
// ---------------------------------------------------------------------------

describe('requirePlatformAdmin', () => {
  it('calls next when isSuperAdmin is true', () => {
    const { req, res, next } = createMocks(makeTenantContext({ isSuperAdmin: true }));
    requirePlatformAdmin()(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('returns 403 when isSuperAdmin is false', () => {
    const { req, res, next } = createMocks(makeTenantContext({ isSuperAdmin: false }));
    requirePlatformAdmin()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(req.reportAccessDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        layer: 'platform_admin',
        scope: 'rbac',
        reasonCode: 'PLATFORM_ADMIN_REQUIRED',
      }),
    );
  });

  it('returns 401 when no tenantContext', () => {
    const { req, res, next } = createMocks(undefined);
    requirePlatformAdmin()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

// ---------------------------------------------------------------------------
// isIpAllowed
// ---------------------------------------------------------------------------

describe('isIpAllowed', () => {
  it('returns true when allowlist is empty', () => {
    expect(isIpAllowed('10.0.0.1', [])).toBe(true);
  });

  it('returns true on exact match', () => {
    expect(isIpAllowed('10.0.0.1', ['10.0.0.1'])).toBe(true);
  });

  it('returns false on mismatch', () => {
    expect(isIpAllowed('10.0.0.2', ['10.0.0.1'])).toBe(false);
  });

  it('matches /24 CIDR range', () => {
    expect(isIpAllowed('10.0.0.123', ['10.0.0.0/24'])).toBe(true);
    expect(isIpAllowed('10.0.1.1', ['10.0.0.0/24'])).toBe(false);
  });

  it('matches /16 CIDR range', () => {
    expect(isIpAllowed('10.0.99.1', ['10.0.0.0/16'])).toBe(true);
    expect(isIpAllowed('10.1.0.1', ['10.0.0.0/16'])).toBe(false);
  });

  it('matches /8 CIDR range', () => {
    expect(isIpAllowed('10.99.99.99', ['10.0.0.0/8'])).toBe(true);
    expect(isIpAllowed('11.0.0.1', ['10.0.0.0/8'])).toBe(false);
  });

  it('matches /32 CIDR (single host)', () => {
    expect(isIpAllowed('10.0.0.1', ['10.0.0.1/32'])).toBe(true);
    expect(isIpAllowed('10.0.0.2', ['10.0.0.1/32'])).toBe(false);
  });

  it('strips IPv6-mapped IPv4 prefix', () => {
    expect(isIpAllowed('::ffff:10.0.0.1', ['10.0.0.1'])).toBe(true);
    expect(isIpAllowed('::ffff:10.0.0.1', ['10.0.0.0/24'])).toBe(true);
  });

  it('returns false for invalid CIDR', () => {
    expect(isIpAllowed('10.0.0.1', ['not-a-cidr'])).toBe(false);
    expect(isIpAllowed('10.0.0.1', ['10.0.0.0/33'])).toBe(false);
  });

  it('returns false for CIDR with negative prefix', () => {
    expect(isIpAllowed('10.0.0.1', ['10.0.0.0/-1'])).toBe(false);
  });

  it('returns false when client IP has octet > 255', () => {
    expect(isIpAllowed('256.1.1.1', ['256.0.0.0/8'])).toBe(false);
  });

  it('returns false when client IP has only 3 octets', () => {
    expect(isIpAllowed('1.2.3', ['1.2.3.0/24'])).toBe(false);
  });

  it('matches /0 CIDR range (all IPs)', () => {
    expect(isIpAllowed('192.168.1.1', ['0.0.0.0/0'])).toBe(true);
    expect(isIpAllowed('10.0.0.1', ['0.0.0.0/0'])).toBe(true);
  });

  it('returns false for CIDR with invalid IP base', () => {
    expect(isIpAllowed('10.0.0.1', ['999.0.0.0/8'])).toBe(false);
  });

  it('returns false for CIDR with non-numeric prefix (NaN)', () => {
    expect(isIpAllowed('10.0.0.1', ['10.0.0.0/abc'])).toBe(false);
  });

  it('returns false for CIDR with multiple slashes', () => {
    expect(isIpAllowed('10.0.0.1', ['10.0.0.0/24/8'])).toBe(false);
  });

  it('returns false when client IP is invalid against CIDR entry', () => {
    expect(isIpAllowed('not-an-ip', ['10.0.0.0/24'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// requirePlatformAdminIp
// ---------------------------------------------------------------------------

describe('requirePlatformAdminIp', () => {
  it('calls next when IP is in allowlist', () => {
    const { req, res, next } = createMocks(makeTenantContext());
    (req as any).ip = '10.0.0.1';
    requirePlatformAdminIp(() => ['10.0.0.1'])(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('returns 403 when IP not in allowlist', () => {
    const { req, res, next } = createMocks(makeTenantContext());
    (req as any).ip = '10.0.0.2';
    requirePlatformAdminIp(() => ['10.0.0.1'])(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(req.reportAccessDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        layer: 'platform_admin_ip',
        scope: 'rbac',
        reasonCode: 'PLATFORM_ADMIN_IP_NOT_ALLOWED',
        metadata: { clientIp: '10.0.0.2' },
      }),
    );
  });

  it('calls next when allowlist is empty (no restriction)', () => {
    const { req, res, next } = createMocks(makeTenantContext());
    requirePlatformAdminIp(() => [])(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('reads IP from x-forwarded-for header', () => {
    const { req, res, next } = createMocks(makeTenantContext());
    (req as any).headers = { 'x-forwarded-for': '10.0.0.1, 192.168.1.1' };
    requirePlatformAdminIp(() => ['10.0.0.1'])(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('rejects when x-forwarded-for first IP is not allowed', () => {
    const { req, res, next } = createMocks(makeTenantContext());
    (req as any).headers = { 'x-forwarded-for': '192.168.1.1, 10.0.0.1' };
    requirePlatformAdminIp(() => ['10.0.0.1'])(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('falls back to req.ip when x-forwarded-for is absent', () => {
    const { req, res, next } = createMocks(makeTenantContext());
    (req as any).ip = '10.0.0.1';
    (req as any).headers = {};
    requirePlatformAdminIp(() => ['10.0.0.1'])(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('uses empty string when neither x-forwarded-for nor req.ip is set', () => {
    const { req, res, next } = createMocks(makeTenantContext());
    (req as any).ip = undefined;
    (req as any).headers = {};
    requirePlatformAdminIp(() => ['10.0.0.1'])(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('reads projectId from query when not in params', () => {
    const { req, res, next } = createMocks(makeTenantContext({ projectScope: ['proj-1'] }));
    (req as any).query = { projectId: 'proj-1' };
    requireProjectScope()(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
