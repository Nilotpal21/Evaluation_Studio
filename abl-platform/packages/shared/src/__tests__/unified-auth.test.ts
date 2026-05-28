/**
 * Unified Auth Middleware Tests
 *
 * Tests the three auth flows (JWT, SDK Session, API Key)
 * and the requireAuth guard.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { PLATFORM_ACCESS_TOKEN_AUDIENCE, PLATFORM_JWT_ISSUER } from '@agent-platform/shared-auth';
import { createUnifiedAuthMiddleware, requireAuth } from '../middleware/unified-auth.js';
import type { UnifiedAuthConfig, AuthEvent } from '../middleware/unified-auth.js';

const PLATFORM_JWT_OPTS = {
  issuer: PLATFORM_JWT_ISSUER,
  audience: PLATFORM_ACCESS_TOKEN_AUDIENCE,
} as const;

// =============================================================================
// HELPERS
// =============================================================================

function createMockReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    query: {},
    ip: '127.0.0.1',
    ...overrides,
  } as unknown as Request;
}

function createMockRes(): Response & { _status: number; _json: unknown } {
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

function createConfig(overrides: Partial<UnifiedAuthConfig> = {}): UnifiedAuthConfig {
  return {
    getJwtSecret: () => 'test-secret',
    getUserById: vi.fn().mockResolvedValue({ id: 'user1', email: 'user@test.com', name: 'Test' }),
    resolveTenantMembership: vi.fn().mockResolvedValue({ role: 'ADMIN', customRoleId: null }),
    resolveDefaultTenant: vi
      .fn()
      .mockResolvedValue({ tenantId: 'tenant1', role: 'ADMIN', customRoleId: null }),
    resolvePermissions: vi.fn().mockResolvedValue(['project:read', 'agent:execute']),
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('createUnifiedAuthMiddleware', () => {
  let next: NextFunction;

  beforeEach(() => {
    next = vi.fn();
  });

  describe('No auth header', () => {
    it('should pass through when no auth headers present', async () => {
      const config = createConfig();
      const middleware = createUnifiedAuthMiddleware(config);
      const req = createMockReq();
      const res = createMockRes();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(req.tenantContext).toBeUndefined();
    });
  });

  describe('SDK Session Token flow', () => {
    it('should reject when verifySDKSessionToken returns null', async () => {
      const config = createConfig({
        verifySDKSessionToken: vi.fn().mockReturnValue(null),
      });
      const middleware = createUnifiedAuthMiddleware(config);
      const req = createMockReq({ headers: { 'x-sdk-token': 'bad-token' } });
      const res = createMockRes();

      await middleware(req, res, next);

      expect(res._status).toBe(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('should set tenantContext for valid SDK session token', async () => {
      const config = createConfig({
        verifySDKSessionToken: vi.fn().mockReturnValue({
          type: 'sdk_session',
          tenantId: 'tenant1',
          projectId: 'proj1',
          channelId: 'chan1',
          sessionPrincipal: 'sp-1',
          permissions: ['session:send_message'],
        }),
      });
      const middleware = createUnifiedAuthMiddleware(config);
      const req = createMockReq({ headers: { 'x-sdk-token': 'valid-token' } });
      const res = createMockRes();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(req.tenantContext).toBeDefined();
      expect(req.tenantContext!.authType).toBe('sdk_session');
      expect(req.tenantContext!.tenantId).toBe('tenant1');
      expect(req.tenantContext!.channelId).toBe('chan1');
      expect(req.tenantContext!.isSuperAdmin).toBe(false);
    });
  });

  describe('API Key flow', () => {
    it('should reject invalid API key', async () => {
      const config = createConfig({
        resolveApiKey: vi.fn().mockResolvedValue(null),
      });
      const middleware = createUnifiedAuthMiddleware(config);
      const req = createMockReq({
        headers: { authorization: 'Bearer abl_test123' },
      });
      const res = createMockRes();

      await middleware(req, res, next);

      expect(res._status).toBe(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('should set tenantContext for valid API key', async () => {
      const config = createConfig({
        resolveApiKey: vi.fn().mockResolvedValue({
          tenantId: 'tenant2',
          apiKeyId: 'key1',
          clientId: 'client1',
          createdBy: 'user2',
          scopes: ['agent:execute', 'session:create'],
          projectIds: ['proj1'],
          environments: ['production'],
        }),
      });
      const middleware = createUnifiedAuthMiddleware(config);
      const req = createMockReq({
        headers: { authorization: 'Bearer abl_test123' },
      });
      const res = createMockRes();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(req.tenantContext!.authType).toBe('api_key');
      expect(req.tenantContext!.tenantId).toBe('tenant2');
      expect(req.tenantContext!.apiKeyId).toBe('key1');
      expect(req.tenantContext!.projectScope).toEqual(['proj1']);
      expect(req.tenantContext!.environmentScope).toEqual(['production']);
    });
  });

  describe('JWT flow', () => {
    it('should reject invalid JWT', async () => {
      const config = createConfig();
      const middleware = createUnifiedAuthMiddleware(config);
      const req = createMockReq({
        headers: { authorization: 'Bearer not-a-valid-jwt' },
      });
      const res = createMockRes();

      await middleware(req, res, next);

      expect(res._status).toBe(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('should reject when user not found', async () => {
      // Create a real JWT for testing
      const jwt = await import('jsonwebtoken');
      const token = jwt.default.sign(
        { sub: 'nonexistent', email: 'a@b.com', type: 'access' },
        'test-secret',
        PLATFORM_JWT_OPTS,
      );

      const config = createConfig({
        getUserById: vi.fn().mockResolvedValue(null),
      });
      const middleware = createUnifiedAuthMiddleware(config);
      const req = createMockReq({
        headers: { authorization: `Bearer ${token}` },
      });
      const res = createMockRes();

      await middleware(req, res, next);

      expect(res._status).toBe(401);
    });

    it('should set tenantContext for valid JWT with default tenant', async () => {
      const jwt = await import('jsonwebtoken');
      const token = jwt.default.sign(
        { sub: 'user1', email: 'a@b.com', type: 'access' },
        'test-secret',
        PLATFORM_JWT_OPTS,
      );

      const config = createConfig();
      const middleware = createUnifiedAuthMiddleware(config);
      const req = createMockReq({
        headers: { authorization: `Bearer ${token}` },
      });
      const res = createMockRes();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(req.user).toBeDefined();
      expect(req.tenantContext!.authType).toBe('user');
      expect(req.tenantContext!.tenantId).toBe('tenant1');
      expect(req.tenantContext!.permissions).toEqual(['project:read', 'agent:execute']);
    });

    it('should ignore X-Tenant-Id header and use default tenant instead', async () => {
      const jwt = await import('jsonwebtoken');
      // JWT has no tenantId claim
      const token = jwt.default.sign(
        { sub: 'user1', email: 'a@b.com', type: 'access' },
        'test-secret',
        PLATFORM_JWT_OPTS,
      );

      const config = createConfig({
        resolveDefaultTenant: vi
          .fn()
          .mockResolvedValue({ tenantId: 'default-tenant', role: 'ADMIN', customRoleId: null }),
      });
      const middleware = createUnifiedAuthMiddleware(config);
      const req = createMockReq({
        headers: {
          authorization: `Bearer ${token}`,
          'x-tenant-id': 'attacker-tenant',
        },
      });
      const res = createMockRes();

      await middleware(req, res, next);

      // Should NOT call resolveTenantMembership with the header value
      expect(config.resolveTenantMembership).not.toHaveBeenCalledWith('user1', 'attacker-tenant');
      // Should resolve default tenant instead
      expect(config.resolveDefaultTenant).toHaveBeenCalledWith('user1');
      expect(next).toHaveBeenCalledTimes(1);
      expect(req.tenantContext!.tenantId).toBe('default-tenant');
    });
  });

  describe('Auth events', () => {
    it('should emit auth events on success and failure', async () => {
      const events: AuthEvent[] = [];
      const config = createConfig({
        onAuthEvent: (event) => events.push(event),
        resolveApiKey: vi.fn().mockResolvedValue(null),
      });
      const middleware = createUnifiedAuthMiddleware(config);

      // Failure case
      const req1 = createMockReq({ headers: { authorization: 'Bearer abl_bad' } });
      const res1 = createMockRes();
      await middleware(req1, res1, vi.fn());

      expect(events).toHaveLength(1);
      expect(events[0].outcome).toBe('failure');
      expect(events[0].authType).toBe('api_key');

      // Success case
      const jwt = await import('jsonwebtoken');
      const token = jwt.default.sign(
        { sub: 'user1', email: 'a@b.com', type: 'access' },
        'test-secret',
        PLATFORM_JWT_OPTS,
      );
      const req2 = createMockReq({ headers: { authorization: `Bearer ${token}` } });
      const res2 = createMockRes();
      await middleware(req2, res2, vi.fn());

      expect(events).toHaveLength(2);
      expect(events[1].outcome).toBe('success');
      expect(events[1].authType).toBe('user');
    });
  });

  describe('JWT flow — tenant membership rejected', () => {
    it('should reject 403 when user is not a member of the tenant in the token', async () => {
      const jwt = await import('jsonwebtoken');
      const token = jwt.default.sign(
        { sub: 'user1', email: 'a@b.com', type: 'access', tenantId: 'bad-tenant' },
        'test-secret',
        PLATFORM_JWT_OPTS,
      );

      const config = createConfig({
        resolveTenantMembership: vi.fn().mockResolvedValue(null),
      });
      const middleware = createUnifiedAuthMiddleware(config);
      const req = createMockReq({ headers: { authorization: `Bearer ${token}` } });
      const res = createMockRes();

      await middleware(req, res, vi.fn());

      expect(res._status).toBe(403);
      expect((res._json as any).error).toBe('Not a member of this tenant');
    });
  });

  describe('JWT flow — no tenant context (new user)', () => {
    it('should pass through when user has no default tenant', async () => {
      const jwt = await import('jsonwebtoken');
      const token = jwt.default.sign(
        { sub: 'user1', email: 'a@b.com', type: 'access' },
        'test-secret',
        PLATFORM_JWT_OPTS,
      );

      const events: AuthEvent[] = [];
      const config = createConfig({
        resolveDefaultTenant: vi.fn().mockResolvedValue(null),
        onAuthEvent: (event) => events.push(event),
      });
      const middleware = createUnifiedAuthMiddleware(config);
      const req = createMockReq({ headers: { authorization: `Bearer ${token}` } });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(req.user).toBeDefined();
      expect(req.tenantContext).toBeUndefined();
      expect(events).toHaveLength(1);
      expect(events[0].outcome).toBe('success');
    });
  });

  describe('JWT flow — MFA pending with tenantId', () => {
    it('should set tenant context for MFA-pending token with tenantId', async () => {
      const jwt = await import('jsonwebtoken');
      const token = jwt.default.sign(
        { sub: 'user1', email: 'a@b.com', type: 'mfa_pending', tenantId: 'tenant1' },
        'test-secret',
        PLATFORM_JWT_OPTS,
      );

      const config = createConfig();
      const middleware = createUnifiedAuthMiddleware(config);
      const req = createMockReq({ headers: { authorization: `Bearer ${token}` } });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(req.user).toBeDefined();
      expect(req.mfaPending).toBe(true);
      expect(req.tenantContext).toBeDefined();
      expect(req.tenantContext!.tenantId).toBe('tenant1');
    });

    it('should pass through MFA-pending without tenantId', async () => {
      const jwt = await import('jsonwebtoken');
      const token = jwt.default.sign(
        { sub: 'user1', email: 'a@b.com', type: 'mfa_pending' },
        'test-secret',
        PLATFORM_JWT_OPTS,
      );

      const config = createConfig();
      const middleware = createUnifiedAuthMiddleware(config);
      const req = createMockReq({ headers: { authorization: `Bearer ${token}` } });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(req.user).toBeDefined();
      expect(req.mfaPending).toBe(true);
      expect(req.tenantContext).toBeUndefined();
    });

    it('should reject MFA-pending when user not found', async () => {
      const jwt = await import('jsonwebtoken');
      const token = jwt.default.sign(
        { sub: 'nonexistent', email: 'a@b.com', type: 'mfa_pending' },
        'test-secret',
        PLATFORM_JWT_OPTS,
      );

      const config = createConfig({
        getUserById: vi.fn().mockResolvedValue(null),
      });
      const middleware = createUnifiedAuthMiddleware(config);
      const req = createMockReq({ headers: { authorization: `Bearer ${token}` } });
      const res = createMockRes();

      await middleware(req, res, vi.fn());

      expect(res._status).toBe(401);
      expect((res._json as any).error).toBe('User not found');
    });

    it('should pass through MFA-pending when tenantId present but membership not found', async () => {
      const jwt = await import('jsonwebtoken');
      const token = jwt.default.sign(
        { sub: 'user1', email: 'a@b.com', type: 'mfa_pending', tenantId: 'tenant1' },
        'test-secret',
        PLATFORM_JWT_OPTS,
      );

      const config = createConfig({
        resolveTenantMembership: vi.fn().mockResolvedValue(null),
      });
      const middleware = createUnifiedAuthMiddleware(config);
      const req = createMockReq({ headers: { authorization: `Bearer ${token}` } });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(req.mfaPending).toBe(true);
      expect(req.tenantContext).toBeUndefined();
    });
  });

  describe('Catch-all error handler', () => {
    it('should return 500 when an unexpected error occurs', async () => {
      const jwt = await import('jsonwebtoken');
      const token = jwt.default.sign(
        { sub: 'user1', email: 'a@b.com', type: 'access', tenantId: 'tenant1' },
        'test-secret',
        PLATFORM_JWT_OPTS,
      );

      const config = createConfig({
        getUserById: vi.fn().mockRejectedValue(new Error('Unexpected DB failure')),
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
      });
      const middleware = createUnifiedAuthMiddleware(config);
      const req = createMockReq({
        headers: {
          authorization: `Bearer ${token}`,
          'x-request-id': 'req-123',
        },
      });
      const res = createMockRes();

      await middleware(req, res, vi.fn());

      expect(res._status).toBe(500);
      expect((res._json as any).error).toBe('Internal server error');
      expect((res._json as any).requestId).toBe('req-123');
      expect(config.logger!.error).toHaveBeenCalled();
    });

    it('should handle non-Error thrown objects', async () => {
      const jwt = await import('jsonwebtoken');
      const token = jwt.default.sign(
        { sub: 'user1', email: 'a@b.com', type: 'access', tenantId: 'tenant1' },
        'test-secret',
        PLATFORM_JWT_OPTS,
      );

      const config = createConfig({
        getUserById: vi.fn().mockRejectedValue('string-error'),
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
      });
      const middleware = createUnifiedAuthMiddleware(config);
      const req = createMockReq({ headers: { authorization: `Bearer ${token}` } });
      const res = createMockRes();

      await middleware(req, res, vi.fn());

      expect(res._status).toBe(500);
      expect(config.logger!.error).toHaveBeenCalledWith(
        'Unhandled auth error',
        expect.objectContaining({ error: 'string-error' }),
      );
    });
  });

  describe('API key flow — empty projectIds and environments', () => {
    it('should not set projectScope/environmentScope when arrays are empty', async () => {
      const config = createConfig({
        resolveApiKey: vi.fn().mockResolvedValue({
          tenantId: 'tenant2',
          apiKeyId: 'key1',
          clientId: 'client1',
          createdBy: 'user2',
          scopes: ['agent:execute'],
          projectIds: [],
          environments: [],
        }),
      });
      const middleware = createUnifiedAuthMiddleware(config);
      const req = createMockReq({ headers: { authorization: 'Bearer abl_test123' } });
      const res = createMockRes();

      await middleware(req, res, vi.fn());

      expect(req.tenantContext!.projectScope).toBeUndefined();
      expect(req.tenantContext!.environmentScope).toBeUndefined();
    });
  });

  describe('JWT flow — with tenantId in token', () => {
    it('should use tenantId from token and resolve membership', async () => {
      const jwt = await import('jsonwebtoken');
      const token = jwt.default.sign(
        { sub: 'user1', email: 'a@b.com', type: 'access', tenantId: 'token-tenant', orgId: 'org1' },
        'test-secret',
        PLATFORM_JWT_OPTS,
      );

      const config = createConfig({
        resolveTenantMembership: vi
          .fn()
          .mockResolvedValue({ role: 'MEMBER', customRoleId: 'custom1' }),
      });
      const middleware = createUnifiedAuthMiddleware(config);
      const req = createMockReq({ headers: { authorization: `Bearer ${token}` } });
      const res = createMockRes();

      await middleware(req, res, vi.fn());

      expect(config.resolveTenantMembership).toHaveBeenCalledWith('user1', 'token-tenant');
      expect(req.tenantContext!.tenantId).toBe('token-tenant');
      expect(req.tenantContext!.orgId).toBe('org1');
      expect(config.resolvePermissions).toHaveBeenCalledWith(
        'token-tenant',
        'user1',
        'MEMBER',
        'custom1',
      );
    });
  });

  describe('isSuperAdmin', () => {
    it('should set isSuperAdmin when configured', async () => {
      const jwt = await import('jsonwebtoken');
      const token = jwt.default.sign(
        { sub: 'admin1', email: 'admin@test.com', type: 'access' },
        'test-secret',
        PLATFORM_JWT_OPTS,
      );

      const config = createConfig({
        getUserById: vi
          .fn()
          .mockResolvedValue({ id: 'admin1', email: 'admin@test.com', name: 'Admin' }),
        isSuperAdmin: (userId) => userId === 'admin1',
      });
      const middleware = createUnifiedAuthMiddleware(config);
      const req = createMockReq({ headers: { authorization: `Bearer ${token}` } });
      const res = createMockRes();

      await middleware(req, res, vi.fn());

      expect(req.tenantContext!.isSuperAdmin).toBe(true);
    });
  });
});

describe('requireAuth', () => {
  it('should pass through when user is set', () => {
    const guard = requireAuth();
    const req = createMockReq();
    (req as any).user = { id: 'user1' };
    const res = createMockRes();
    const next = vi.fn();

    guard(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res._status).toBe(200);
  });

  it('should pass through when tenantContext is set', () => {
    const guard = requireAuth();
    const req = createMockReq();
    (req as any).tenantContext = { tenantId: 'tenant1' };
    const res = createMockRes();
    const next = vi.fn();

    guard(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('should reject when neither user nor tenantContext is set', () => {
    const guard = requireAuth();
    const req = createMockReq();
    const res = createMockRes();
    const next = vi.fn();

    guard(req, res, next);

    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});
