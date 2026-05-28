/**
 * Permission Guard Middleware Tests
 *
 * Tests the project/environment scope enforcement middleware.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import {
  requirePermission,
  requireAllPermissions,
  requireAnyPermission,
  requireProjectScope,
  requireEnvironmentScope,
  requireAuthType,
  requirePlatformAdmin,
  requirePlatformAdminIp,
  isIpAllowed,
} from '../middleware/permission-guard.js';
import type { TenantContextData } from '../types/index.js';

function createReq(
  tenantContext?: Partial<TenantContextData>,
  params?: Record<string, string>,
  query?: Record<string, string>,
): Request {
  return {
    tenantContext: tenantContext
      ? ({
          tenantId: 'tenant1',
          userId: 'user1',
          role: 'ADMIN',
          permissions: ['project:read', 'agent:execute'],
          authType: 'user',
          isSuperAdmin: false,
          ...tenantContext,
        } as TenantContextData)
      : undefined,
    params: params ?? {},
    query: query ?? {},
    body: {},
    headers: {},
  } as unknown as Request;
}

function createRes(): Response & { _status: number; _json: unknown } {
  const res = {
    _status: 200,
    _json: null,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(data: unknown) {
      res._json = data;
      return res;
    },
  } as unknown as Response & { _status: number; _json: unknown };
  return res;
}

describe('requireProjectScope', () => {
  it('should pass when no projectScope restriction', () => {
    const guard = requireProjectScope();
    const req = createReq({ projectScope: undefined }, { projectId: 'proj1' });
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('should pass when empty projectScope array', () => {
    const guard = requireProjectScope();
    const req = createReq({ projectScope: [] }, { projectId: 'proj1' });
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('should pass when project is in scope', () => {
    const guard = requireProjectScope();
    const req = createReq({ projectScope: ['proj1', 'proj2'] }, { projectId: 'proj1' });
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('should reject when project is not in scope', () => {
    const guard = requireProjectScope();
    const req = createReq({ projectScope: ['proj1'] }, { projectId: 'proj99' });
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    expect(res._status).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('should pass when no project in request', () => {
    const guard = requireProjectScope();
    const req = createReq({ projectScope: ['proj1'] });
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('should enforce scope even for super-admin', () => {
    const guard = requireProjectScope();
    const req = createReq({ isSuperAdmin: true, projectScope: ['proj1'] }, { projectId: 'proj99' });
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    // Super-admin manages platform config, not tenant data — scope is enforced
    expect(res._status).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('should use custom param name', () => {
    const guard = requireProjectScope('pid');
    const req = createReq({ projectScope: ['proj1'] }, { pid: 'proj1' });
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('should reject when no tenantContext', () => {
    const guard = requireProjectScope();
    const req = createReq(undefined, { projectId: 'proj1' });
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should read projectId from query when not in params', () => {
    const guard = requireProjectScope();
    const req = createReq({ projectScope: ['proj1'] }, {}, { projectId: 'proj1' });
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('should reject projectId from query when not in scope', () => {
    const guard = requireProjectScope();
    const req = createReq({ projectScope: ['proj1'] }, {}, { projectId: 'proj99' });
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    expect(res._status).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requireEnvironmentScope', () => {
  it('should pass when no environmentScope restriction', () => {
    const guard = requireEnvironmentScope();
    const req = createReq({}, { environment: 'production' });
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('should reject when environment is not in scope', () => {
    const guard = requireEnvironmentScope();
    const req = createReq({ environmentScope: ['staging'] }, { environment: 'production' });
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    expect(res._status).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('should pass when environment is in scope', () => {
    const guard = requireEnvironmentScope();
    const req = createReq(
      { environmentScope: ['staging', 'production'] },
      { environment: 'production' },
    );
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('should reject when no tenantContext', () => {
    const guard = requireEnvironmentScope();
    const req = createReq(undefined, { environment: 'production' });
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should pass when empty environmentScope array', () => {
    const guard = requireEnvironmentScope();
    const req = createReq({ environmentScope: [] }, { environment: 'production' });
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('should pass when no environment in request', () => {
    const guard = requireEnvironmentScope();
    const req = createReq({ environmentScope: ['staging'] });
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('should read environment from query when not in params', () => {
    const guard = requireEnvironmentScope();
    const req = createReq({ environmentScope: ['staging'] }, {}, { environment: 'staging' });
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('should read environment from body when not in params or query', () => {
    const guard = requireEnvironmentScope();
    const req = {
      tenantContext: {
        tenantId: 'tenant1',
        userId: 'user1',
        role: 'ADMIN',
        permissions: [],
        authType: 'user',
        isSuperAdmin: false,
        environmentScope: ['production'],
      } as TenantContextData,
      params: {},
      query: {},
      body: { environment: 'production' },
      headers: {},
    } as unknown as Request;
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('should reject environment from body when not in scope', () => {
    const guard = requireEnvironmentScope();
    const req = {
      tenantContext: {
        tenantId: 'tenant1',
        userId: 'user1',
        role: 'ADMIN',
        permissions: [],
        authType: 'user',
        isSuperAdmin: false,
        environmentScope: ['staging'],
      } as TenantContextData,
      params: {},
      query: {},
      body: { environment: 'production' },
      headers: {},
    } as unknown as Request;
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    expect(res._status).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('should use custom param name', () => {
    const guard = requireEnvironmentScope('env');
    const req = createReq({ environmentScope: ['staging'] }, { env: 'staging' });
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('requirePermission', () => {
  it('should pass when user has required permission', () => {
    const guard = requirePermission('project:read');
    const req = createReq({ permissions: ['project:read', 'agent:execute'] });
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('should reject super-admin without required permission', () => {
    const guard = requirePermission('tenant:delete');
    const req = createReq({ isSuperAdmin: true, permissions: [] });
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    // Super-admin manages platform config, not tenant data — no permission bypass
    expect(res._status).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject without required permission', () => {
    const guard = requirePermission('tenant:delete');
    const req = createReq({ permissions: ['project:read'] });
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    expect(res._status).toBe(403);
  });

  it('should reject when no tenantContext', () => {
    const guard = requirePermission('project:read');
    const req = createReq(undefined);
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    expect(res._status).toBe(401);
  });
});

describe('requireAllPermissions', () => {
  it('should pass when user has all required permissions', () => {
    const guard = requireAllPermissions(['project:read', 'agent:execute']);
    const req = createReq({ permissions: ['project:read', 'agent:execute', 'tenant:read'] });
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('should reject when user is missing one required permission', () => {
    const guard = requireAllPermissions(['project:read', 'tenant:delete']);
    const req = createReq({ permissions: ['project:read'] });
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    expect(res._status).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject when no tenantContext', () => {
    const guard = requireAllPermissions(['project:read']);
    const req = createReq(undefined);
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requireAnyPermission', () => {
  it('should pass when user has at least one required permission', () => {
    const guard = requireAnyPermission(['tenant:delete', 'project:read']);
    const req = createReq({ permissions: ['project:read'] });
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('should reject when user has none of the required permissions', () => {
    const guard = requireAnyPermission(['tenant:delete', 'tenant:create']);
    const req = createReq({ permissions: ['project:read'] });
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    expect(res._status).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject when no tenantContext', () => {
    const guard = requireAnyPermission(['project:read']);
    const req = createReq(undefined);
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requireAuthType', () => {
  it('should pass for matching auth type', () => {
    const guard = requireAuthType('user');
    const req = createReq({ authType: 'user' });
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('should reject for non-matching auth type', () => {
    const guard = requireAuthType('user');
    const req = createReq({ authType: 'api_key' });
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    expect(res._status).toBe(403);
  });

  it('should accept multiple auth types', () => {
    const guard = requireAuthType('user', 'api_key');
    const req = createReq({ authType: 'api_key' });
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('should reject when no tenantContext', () => {
    const guard = requireAuthType('user');
    const req = createReq(undefined);
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requirePlatformAdmin', () => {
  it('should pass for super-admin', () => {
    const guard = requirePlatformAdmin();
    const req = createReq({ isSuperAdmin: true });
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('should reject non-super-admin', () => {
    const guard = requirePlatformAdmin();
    const req = createReq({ isSuperAdmin: false });
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    expect(res._status).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject when no tenantContext', () => {
    const guard = requirePlatformAdmin();
    const req = createReq(undefined);
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});

// =============================================================================
// IP ALLOWLISTING
// =============================================================================

describe('isIpAllowed', () => {
  it('should allow any IP when list is empty', () => {
    expect(isIpAllowed('192.168.1.1', [])).toBe(true);
  });

  it('should allow exact IP match', () => {
    expect(isIpAllowed('10.0.0.1', ['10.0.0.1'])).toBe(true);
  });

  it('should reject non-matching IP', () => {
    expect(isIpAllowed('10.0.0.2', ['10.0.0.1'])).toBe(false);
  });

  it('should handle multiple entries', () => {
    const list = ['10.0.0.1', '192.168.1.100'];
    expect(isIpAllowed('192.168.1.100', list)).toBe(true);
    expect(isIpAllowed('172.16.0.1', list)).toBe(false);
  });

  it('should match CIDR /24', () => {
    expect(isIpAllowed('10.0.1.55', ['10.0.1.0/24'])).toBe(true);
    expect(isIpAllowed('10.0.2.55', ['10.0.1.0/24'])).toBe(false);
  });

  it('should match CIDR /16', () => {
    expect(isIpAllowed('172.16.5.99', ['172.16.0.0/16'])).toBe(true);
    expect(isIpAllowed('172.17.0.1', ['172.16.0.0/16'])).toBe(false);
  });

  it('should match CIDR /32 (single host)', () => {
    expect(isIpAllowed('10.0.0.5', ['10.0.0.5/32'])).toBe(true);
    expect(isIpAllowed('10.0.0.6', ['10.0.0.5/32'])).toBe(false);
  });

  it('should strip IPv6-mapped IPv4 prefix', () => {
    expect(isIpAllowed('::ffff:10.0.0.1', ['10.0.0.1'])).toBe(true);
    expect(isIpAllowed('::ffff:10.0.0.1', ['10.0.1.0/24'])).toBe(false);
  });

  it('should mix plain IPs and CIDR ranges', () => {
    const list = ['10.0.0.1', '192.168.0.0/16'];
    expect(isIpAllowed('10.0.0.1', list)).toBe(true);
    expect(isIpAllowed('192.168.99.1', list)).toBe(true);
    expect(isIpAllowed('172.16.0.1', list)).toBe(false);
  });
});

describe('requirePlatformAdminIp', () => {
  function createIpReq(ip: string, headers?: Record<string, string>): Request {
    return {
      tenantContext: { tenantId: 't1', userId: 'u1', isSuperAdmin: true } as TenantContextData,
      ip,
      headers: headers ?? {},
      params: {},
      query: {},
      body: {},
    } as unknown as Request;
  }

  it('should pass when allowlist is empty', () => {
    const guard = requirePlatformAdminIp(() => []);
    const req = createIpReq('1.2.3.4');
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('should pass when IP is in allowlist', () => {
    const guard = requirePlatformAdminIp(() => ['10.0.0.1', '10.0.0.2']);
    const req = createIpReq('10.0.0.2');
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('should reject when IP is not in allowlist', () => {
    const guard = requirePlatformAdminIp(() => ['10.0.0.1']);
    const req = createIpReq('10.0.0.99');
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    expect(res._status).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('should prefer x-forwarded-for over req.ip', () => {
    const guard = requirePlatformAdminIp(() => ['10.0.0.1']);
    const req = createIpReq('192.168.1.1', { 'x-forwarded-for': '10.0.0.1, 192.168.1.1' });
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('should support CIDR ranges', () => {
    const guard = requirePlatformAdminIp(() => ['10.0.0.0/8']);
    const req = createIpReq('10.255.255.255');
    const res = createRes();
    const next = vi.fn();

    guard(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
