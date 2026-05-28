/**
 * Unified Auth Context Population Tests
 *
 * Verifies that createUnifiedAuthMiddleware populates req.authContext
 * (typed AuthContext) alongside req.tenantContext for all three auth flows.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { PLATFORM_ACCESS_TOKEN_AUDIENCE, PLATFORM_JWT_ISSUER } from '@agent-platform/shared-auth';
import { createUnifiedAuthMiddleware } from '../middleware/unified-auth.js';
import type { UnifiedAuthConfig } from '../middleware/unified-auth.js';

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

describe('req.authContext population', () => {
  let next: NextFunction;

  beforeEach(() => {
    next = vi.fn();
  });

  describe('User JWT flow', () => {
    it('should populate both tenantContext and authContext with authType user', async () => {
      const jwt = await import('jsonwebtoken');
      const token = jwt.default.sign(
        { sub: 'user1', email: 'a@b.com', type: 'access' },
        'test-secret',
        { issuer: PLATFORM_JWT_ISSUER, audience: PLATFORM_ACCESS_TOKEN_AUDIENCE },
      );

      const config = createConfig();
      const middleware = createUnifiedAuthMiddleware(config);
      const req = createMockReq({ headers: { authorization: `Bearer ${token}` } });
      const res = createMockRes();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);

      // tenantContext should still be populated (backward compatibility)
      expect(req.tenantContext).toBeDefined();
      expect(req.tenantContext!.authType).toBe('user');
      expect(req.tenantContext!.tenantId).toBe('tenant1');

      // authContext should also be populated
      expect(req.authContext).toBeDefined();
      expect(req.authContext!.authType).toBe('user');
      expect(req.authContext!.tenantId).toBe('tenant1');
      expect(req.authContext!.permissions).toEqual(['project:read', 'agent:execute']);

      // Type-specific fields for user auth
      if (req.authContext!.authType === 'user') {
        expect(req.authContext!.userId).toBe('user1');
        expect(req.authContext!.role).toBe('ADMIN');
        expect(typeof req.authContext!.isSuperAdmin).toBe('boolean');
      }
    });

    it('should set isSuperAdmin correctly on authContext', async () => {
      const jwt = await import('jsonwebtoken');
      const token = jwt.default.sign(
        { sub: 'admin1', email: 'admin@test.com', type: 'access' },
        'test-secret',
        { issuer: PLATFORM_JWT_ISSUER, audience: PLATFORM_ACCESS_TOKEN_AUDIENCE },
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

      await middleware(req, res, next);

      expect(req.authContext).toBeDefined();
      expect(req.authContext!.authType).toBe('user');
      if (req.authContext!.authType === 'user') {
        expect(req.authContext!.isSuperAdmin).toBe(true);
      }
    });
  });

  describe('SDK Session Token flow', () => {
    it('should populate authContext with authType sdk_session and callerIdentity', async () => {
      const config = createConfig({
        verifySDKSessionToken: vi.fn().mockReturnValue({
          type: 'sdk_session',
          tenantId: 'tenant1',
          projectId: 'proj1',
          channelId: 'chan1',
          deploymentId: 'deploy1',
          sessionId: 'sess1',
          sessionPrincipal: 'sp-1',
          permissions: ['session:send_message'],
          identityTier: 2,
          verificationMethod: 'hmac',
          authScope: 'user',
          verifiedUserId: 'cust1',
          channelArtifact: 'artifact123',
          userContext: { userId: 'cust1', customAttributes: { plan: 'pro' } },
        }),
      });
      const middleware = createUnifiedAuthMiddleware(config);
      const req = createMockReq({ headers: { 'x-sdk-token': 'valid-sdk-token' } });
      const res = createMockRes();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);

      // tenantContext should still be populated
      expect(req.tenantContext).toBeDefined();
      expect(req.tenantContext!.authType).toBe('sdk_session');
      expect(req.tenantContext!.projectId).toBe('proj1');

      // authContext should be populated with sdk_session type
      expect(req.authContext).toBeDefined();
      expect(req.authContext!.authType).toBe('sdk_session');
      expect(req.authContext!.tenantId).toBe('tenant1');
      expect(req.authContext!.permissions).toEqual(['session:send_message']);

      // Type-specific fields for SDK session
      if (req.authContext!.authType === 'sdk_session') {
        expect(req.authContext!.projectId).toBe('proj1');
        expect(req.authContext!.channelId).toBe('chan1');
        expect(req.authContext!.deploymentId).toBe('deploy1');
        expect(req.authContext!.sessionId).toBe('sess1');
        expect(req.authContext!.callerIdentity).toBeDefined();
        expect(req.authContext!.callerIdentity.identityTier).toBe(2);
        expect(req.authContext!.callerIdentity.verificationMethod).toBe('hmac');
        expect(req.authContext!.callerIdentity.channelArtifact).toBe('artifact123');
        expect(req.authContext!.callerIdentity.customerId).toBe('cust1');
        expect(req.authContext!.callerIdentity.authScope).toBe('user');
        expect(req.authContext!.userContext).toEqual({
          userId: 'cust1',
          customAttributes: { plan: 'pro' },
        });
      }
    });

    it('should default callerIdentity fields when not provided in SDK token', async () => {
      const config = createConfig({
        verifySDKSessionToken: vi.fn().mockReturnValue({
          type: 'sdk_session',
          tenantId: 'tenant1',
          projectId: 'proj1',
          channelId: 'chan1',
          sessionPrincipal: 'sp-default',
          permissions: ['session:send_message'],
          // No identityTier, verificationMethod, channelArtifact, or userContext
        }),
      });
      const middleware = createUnifiedAuthMiddleware(config);
      const req = createMockReq({ headers: { 'x-sdk-token': 'valid-sdk-token' } });
      const res = createMockRes();

      await middleware(req, res, next);

      expect(req.authContext).toBeDefined();
      if (req.authContext!.authType === 'sdk_session') {
        expect(req.authContext!.callerIdentity.identityTier).toBe(0);
        expect(req.authContext!.callerIdentity.verificationMethod).toBe('none');
      }
    });
  });

  describe('API Key flow', () => {
    it('should populate authContext with authType api_key', async () => {
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

      // tenantContext should still be populated
      expect(req.tenantContext).toBeDefined();
      expect(req.tenantContext!.authType).toBe('api_key');

      // authContext should be populated with api_key type
      expect(req.authContext).toBeDefined();
      expect(req.authContext!.authType).toBe('api_key');
      expect(req.authContext!.tenantId).toBe('tenant2');
      expect(req.authContext!.permissions).toEqual(['agent:execute', 'session:create']);

      // Type-specific fields for API key
      if (req.authContext!.authType === 'api_key') {
        expect(req.authContext!.apiKeyId).toBe('key1');
        expect(req.authContext!.clientId).toBe('client1');
        expect(req.authContext!.createdBy).toBe('user2');
        expect(req.authContext!.projectScope).toEqual(['proj1']);
        expect(req.authContext!.environmentScope).toEqual(['production']);
      }
    });
  });

  describe('No auth header', () => {
    it('should not set authContext when no auth headers present', async () => {
      const config = createConfig();
      const middleware = createUnifiedAuthMiddleware(config);
      const req = createMockReq();
      const res = createMockRes();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(req.tenantContext).toBeUndefined();
      expect(req.authContext).toBeUndefined();
    });
  });

  describe('Auth failure', () => {
    it('should not set authContext when auth fails', async () => {
      const config = createConfig({
        resolveApiKey: vi.fn().mockResolvedValue(null),
      });
      const middleware = createUnifiedAuthMiddleware(config);
      const req = createMockReq({
        headers: { authorization: 'Bearer abl_bad_key' },
      });
      const res = createMockRes();

      await middleware(req, res, next);

      expect(res._status).toBe(401);
      expect(req.authContext).toBeUndefined();
    });
  });
});
