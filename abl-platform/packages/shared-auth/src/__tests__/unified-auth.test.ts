import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import {
  createUnifiedAuthMiddleware,
  requireAuth,
  requireTenantContext,
  defaultLogger,
} from '../middleware/unified-auth.js';
import { requirePermission } from '../middleware/permission-guard.js';
import { PLATFORM_ACCESS_TOKEN_AUDIENCE, PLATFORM_JWT_ISSUER } from '../purpose-jwt.js';
import type { UnifiedAuthConfig, ApiKeyResolution } from '../middleware/unified-auth.js';
import type { AuthUser, JWTPayload, SDKSessionTokenPayload } from '../types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SECRET = 'unified-test-secret';

function makeJwt(payload: Partial<JWTPayload>, secret = SECRET): string {
  return jwt.sign(payload, secret, {
    issuer: PLATFORM_JWT_ISSUER,
    audience: PLATFORM_ACCESS_TOKEN_AUDIENCE,
  });
}

const testUser: AuthUser = { id: 'user-1', email: 'test@example.com', name: 'Test' };

function mockReq(headers: Record<string, string> = {}): Request {
  return {
    headers,
    ip: '127.0.0.1',
    method: 'GET',
    url: '/protected',
    originalUrl: '/protected',
  } as unknown as Request;
}

function mockRes(): Response {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

function mockNext(): NextFunction {
  return vi.fn();
}

function makeConfig(overrides: Partial<UnifiedAuthConfig> = {}): UnifiedAuthConfig {
  return {
    getJwtSecret: () => SECRET,
    getUserById: vi.fn<(id: string) => Promise<AuthUser | null>>().mockResolvedValue(testUser),
    resolveTenantMembership: vi
      .fn<
        (
          userId: string,
          tenantId: string,
        ) => Promise<{ role: string; customRoleId?: string | null; orgId?: string } | null>
      >()
      .mockResolvedValue({ role: 'ADMIN', customRoleId: null }),
    resolveDefaultTenant: vi
      .fn<
        (userId: string) => Promise<{
          tenantId: string;
          role: string;
          customRoleId?: string | null;
          orgId?: string;
        } | null>
      >()
      .mockResolvedValue({ tenantId: 'default-tenant', role: 'MEMBER' }),
    resolvePermissions: vi
      .fn<
        (
          tenantId: string,
          userId: string,
          role: string,
          customRoleId?: string | null,
        ) => Promise<string[]>
      >()
      .mockResolvedValue(['agent:read', 'agent:write']),
    ...overrides,
  };
}

function makeApiKeyResolution(overrides: Partial<ApiKeyResolution> = {}): ApiKeyResolution {
  return {
    tenantId: 'tenant-api',
    apiKeyId: 'key-1',
    clientId: 'client-1',
    createdBy: 'creator-1',
    scopes: ['agent:execute'],
    projectIds: ['proj-1'],
    environments: ['production'],
    ...overrides,
  };
}

function makeSdkPayload(overrides: Partial<SDKSessionTokenPayload> = {}): SDKSessionTokenPayload {
  return {
    type: 'sdk_session',
    tenantId: 'tenant-sdk',
    projectId: 'proj-1',
    channelId: 'web-channel',
    sessionId: 'sdk-session-1',
    sessionPrincipal: 'sdk-session-1',
    authScope: 'session',
    permissions: ['session:read'],
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// No auth header
// ---------------------------------------------------------------------------

describe('createUnifiedAuthMiddleware — no auth', () => {
  it('calls next without setting user or tenantContext when no headers', async () => {
    const config = makeConfig();
    const middleware = createUnifiedAuthMiddleware(config);
    const req = mockReq();
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect((req as any).user).toBeUndefined();
    expect((req as any).tenantContext).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SDK Session (X-SDK-Token)
// ---------------------------------------------------------------------------

describe('createUnifiedAuthMiddleware — SDK session', () => {
  it('sets tenantContext with authType sdk_session for valid token', async () => {
    const sdkPayload = makeSdkPayload();
    const config = makeConfig({
      verifySDKSessionToken: vi.fn().mockReturnValue(sdkPayload),
    });
    const middleware = createUnifiedAuthMiddleware(config);
    const req = mockReq({ 'x-sdk-token': 'valid-sdk-token' });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect((req as any).tenantContext).toBeDefined();
    expect((req as any).tenantContext.authType).toBe('sdk_session');
    expect((req as any).tenantContext.tenantId).toBe('tenant-sdk');
    expect((req as any).tenantContext.projectId).toBe('proj-1');
    expect((req as any).tenantContext.channelId).toBe('web-channel');
    expect((req as any).tenantContext.userId).toBe('sdk-session-1');
    expect((req as any).tenantContext.sessionPrincipal).toBe('sdk-session-1');
  });

  it('returns 401 for invalid SDK session token', async () => {
    const config = makeConfig({
      verifySDKSessionToken: vi.fn().mockReturnValue(null),
    });
    const middleware = createUnifiedAuthMiddleware(config);
    const req = mockReq({ 'x-sdk-token': 'bad-token' });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 for a user-scoped SDK session without a verified user identity', async () => {
    const sdkPayload = makeSdkPayload({
      authScope: 'user',
      verifiedUserId: undefined,
      identityTier: 0,
      userContext: { userId: 'unsigned-user' },
    });
    const config = makeConfig({
      verifySDKSessionToken: vi.fn().mockReturnValue(sdkPayload),
    });
    const middleware = createUnifiedAuthMiddleware(config);
    const req = mockReq({ 'x-sdk-token': 'invalid-sdk-token-state' });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 for an SDK session without a channelId', async () => {
    const sdkPayload = makeSdkPayload({
      channelId: '',
    });
    const config = makeConfig({
      verifySDKSessionToken: vi.fn().mockReturnValue(sdkPayload),
    });
    const middleware = createUnifiedAuthMiddleware(config);
    const req = mockReq({ 'x-sdk-token': 'invalid-sdk-token-state' });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('propagates SDK identity fields to tenantContext', async () => {
    const sdkPayload = makeSdkPayload({
      authScope: 'user',
      verifiedUserId: 'verified-user-1',
      identityTier: 2,
      verificationMethod: 'hmac',
      channelArtifact: 'artifact-hash',
      userContext: { userId: 'display-user-1', customAttributes: { plan: 'pro' } },
    });
    const config = makeConfig({
      verifySDKSessionToken: vi.fn().mockReturnValue(sdkPayload),
    });
    const middleware = createUnifiedAuthMiddleware(config);
    const req = mockReq({ 'x-sdk-token': 'valid-sdk-token' });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    const ctx = (req as any).tenantContext;
    expect(ctx.userId).toBe('verified-user-1');
    expect(ctx.verifiedUserId).toBe('verified-user-1');
    expect(ctx.identityTier).toBe(2);
    expect(ctx.verificationMethod).toBe('hmac');
    expect(ctx.authScope).toBe('user');
    expect(ctx.channelArtifact).toBe('artifact-hash');
    expect(ctx.sessionPrincipal).toBe('sdk-session-1');
    expect(ctx.userContext).toEqual({
      userId: 'display-user-1',
      customAttributes: { plan: 'pro' },
    });
  });

  it('keeps unsigned SDK metadata session-scoped', async () => {
    const sdkPayload = makeSdkPayload({
      authScope: 'session',
      identityTier: 0,
      verificationMethod: 'none',
      userContext: { userId: 'metadata-user', customAttributes: { plan: 'free' } },
    });
    const config = makeConfig({
      verifySDKSessionToken: vi.fn().mockReturnValue(sdkPayload),
    });
    const middleware = createUnifiedAuthMiddleware(config);
    const req = mockReq({ 'x-sdk-token': 'valid-sdk-token' });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    const ctx = (req as any).tenantContext;
    expect(ctx.userId).toBe('sdk-session-1');
    expect(ctx.verifiedUserId).toBeUndefined();
    expect(ctx.authScope).toBe('session');
    expect(ctx.sessionPrincipal).toBe('sdk-session-1');
    expect(ctx.userContext).toEqual({
      userId: 'metadata-user',
      customAttributes: { plan: 'free' },
    });
  });

  it('sets authContext for valid SDK session', async () => {
    const sdkPayload = makeSdkPayload();
    const config = makeConfig({
      verifySDKSessionToken: vi.fn().mockReturnValue(sdkPayload),
    });
    const middleware = createUnifiedAuthMiddleware(config);
    const req = mockReq({ 'x-sdk-token': 'valid-sdk-token' });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect((req as any).authContext).toBeDefined();
    expect((req as any).authContext.authType).toBe('sdk_session');
  });
});

// ---------------------------------------------------------------------------
// API Key (Bearer abl_*)
// ---------------------------------------------------------------------------

describe('createUnifiedAuthMiddleware — API key', () => {
  it('sets tenantContext with authType api_key for valid key', async () => {
    const config = makeConfig({
      resolveApiKey: vi.fn().mockResolvedValue(makeApiKeyResolution()),
    });
    const middleware = createUnifiedAuthMiddleware(config);
    const req = mockReq({ authorization: 'Bearer abl_test_key_123' });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    const ctx = (req as any).tenantContext;
    expect(ctx).toBeDefined();
    expect(ctx.authType).toBe('api_key');
    expect(ctx.tenantId).toBe('tenant-api');
    expect(ctx.apiKeyId).toBe('key-1');
    expect(ctx.clientId).toBe('client-1');
    expect(ctx.userId).toBe('creator-1');
  });

  it('returns 401 for invalid API key', async () => {
    const config = makeConfig({
      resolveApiKey: vi.fn().mockResolvedValue(null),
    });
    const middleware = createUnifiedAuthMiddleware(config);
    const req = mockReq({ authorization: 'Bearer abl_invalid_key' });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('does not treat public SDK bearer keys as generic API keys', async () => {
    const resolveApiKey = vi.fn().mockResolvedValue(makeApiKeyResolution());
    const config = makeConfig({ resolveApiKey });
    const middleware = createUnifiedAuthMiddleware(config);
    const req = mockReq({ authorization: 'Bearer pk_public_sdk_key' });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect(resolveApiKey).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('maps projectIds and environments to scope arrays', async () => {
    const config = makeConfig({
      resolveApiKey: vi.fn().mockResolvedValue(
        makeApiKeyResolution({
          projectIds: ['proj-a', 'proj-b'],
          environments: ['staging', 'production'],
        }),
      ),
    });
    const middleware = createUnifiedAuthMiddleware(config);
    const req = mockReq({ authorization: 'Bearer abl_key' });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    const ctx = (req as any).tenantContext;
    expect(ctx.projectScope).toEqual(['proj-a', 'proj-b']);
    expect(ctx.environmentScope).toEqual(['staging', 'production']);
  });

  it('omits scope arrays when projectIds/environments are empty', async () => {
    const config = makeConfig({
      resolveApiKey: vi.fn().mockResolvedValue(
        makeApiKeyResolution({
          projectIds: [],
          environments: [],
        }),
      ),
    });
    const middleware = createUnifiedAuthMiddleware(config);
    const req = mockReq({ authorization: 'Bearer abl_key' });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    const ctx = (req as any).tenantContext;
    expect(ctx.projectScope).toBeUndefined();
    expect(ctx.environmentScope).toBeUndefined();
  });

  it('sets authContext for valid API key', async () => {
    const config = makeConfig({
      resolveApiKey: vi.fn().mockResolvedValue(makeApiKeyResolution()),
    });
    const middleware = createUnifiedAuthMiddleware(config);
    const req = mockReq({ authorization: 'Bearer abl_key' });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect((req as any).authContext).toBeDefined();
    expect((req as any).authContext.authType).toBe('api_key');
  });
});

// ---------------------------------------------------------------------------
// JWT (Bearer <non-abl token>)
// ---------------------------------------------------------------------------

describe('createUnifiedAuthMiddleware — JWT', () => {
  it('sets user and tenantContext for valid JWT with tenantId', async () => {
    const config = makeConfig();
    const middleware = createUnifiedAuthMiddleware(config);
    const token = makeJwt({
      sub: 'user-1',
      email: 'test@example.com',
      type: 'access',
      tenantId: 'tenant-jwt',
    });
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect((req as any).user).toEqual(testUser);
    expect((req as any).tenantContext).toBeDefined();
    expect((req as any).tenantContext.tenantId).toBe('tenant-jwt');
    expect((req as any).tenantContext.authType).toBe('user');
    expect((req as any).tenantContext.permissions).toEqual(['agent:read', 'agent:write']);
  });

  it('returns 401 for invalid JWT', async () => {
    const config = makeConfig();
    const middleware = createUnifiedAuthMiddleware(config);
    const req = mockReq({ authorization: 'Bearer not-a-valid-jwt' });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when user is not found', async () => {
    const config = makeConfig({
      getUserById: vi.fn<(id: string) => Promise<AuthUser | null>>().mockResolvedValue(null),
    });
    const middleware = createUnifiedAuthMiddleware(config);
    const token = makeJwt({ sub: 'missing-user', email: 'a@b.c', type: 'access' });
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('sets mfaPending for mfa_pending JWT', async () => {
    const config = makeConfig();
    const middleware = createUnifiedAuthMiddleware(config);
    const token = makeJwt({ sub: 'user-1', email: 'a@b.c', type: 'mfa_pending' });
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect((req as any).user).toEqual(testUser);
    expect((req as any).mfaPending).toBe(true);
  });

  it('resolves default tenant when JWT has no tenantId', async () => {
    const config = makeConfig({
      resolveDefaultTenant: vi
        .fn()
        .mockResolvedValue({ tenantId: 'default-t', role: 'MEMBER', customRoleId: null }),
    });
    const middleware = createUnifiedAuthMiddleware(config);
    const token = makeJwt({ sub: 'user-1', email: 'a@b.c', type: 'access' });
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect((req as any).tenantContext).toBeDefined();
    expect((req as any).tenantContext.tenantId).toBe('default-t');
  });

  it('sets user but no tenantContext when no default tenant', async () => {
    const config = makeConfig({
      resolveDefaultTenant: vi.fn().mockResolvedValue(null),
    });
    const middleware = createUnifiedAuthMiddleware(config);
    const token = makeJwt({ sub: 'user-1', email: 'a@b.c', type: 'access' });
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect((req as any).user).toEqual(testUser);
    expect((req as any).tenantContext).toBeUndefined();
  });

  it('returns 403 when user is not a member of the tenantId in JWT', async () => {
    const config = makeConfig({
      resolveTenantMembership: vi.fn().mockResolvedValue(null),
    });
    const middleware = createUnifiedAuthMiddleware(config);
    const token = makeJwt({
      sub: 'user-1',
      email: 'a@b.c',
      type: 'access',
      tenantId: 'tenant-x',
    });
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('checks isSuperAdmin and sets it on tenantContext', async () => {
    const config = makeConfig({
      isSuperAdmin: (userId: string) => userId === 'user-1',
    });
    const middleware = createUnifiedAuthMiddleware(config);
    const token = makeJwt({
      sub: 'user-1',
      email: 'a@b.c',
      type: 'access',
      tenantId: 'tenant-1',
    });
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect((req as any).tenantContext.isSuperAdmin).toBe(true);
  });

  it('sets authContext for valid JWT', async () => {
    const config = makeConfig();
    const middleware = createUnifiedAuthMiddleware(config);
    const token = makeJwt({
      sub: 'user-1',
      email: 'a@b.c',
      type: 'access',
      tenantId: 'tenant-1',
    });
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect((req as any).authContext).toBeDefined();
    expect((req as any).authContext.authType).toBe('user');
  });

  it('returns 401 when mfa_pending user is not found', async () => {
    const config = makeConfig({
      getUserById: vi.fn<(id: string) => Promise<AuthUser | null>>().mockResolvedValue(null),
    });
    const middleware = createUnifiedAuthMiddleware(config);
    const token = makeJwt({ sub: 'missing', email: 'a@b.c', type: 'mfa_pending' });
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('wraps mfa_pending in tenant context when JWT has tenantId and membership exists', async () => {
    const config = makeConfig({
      resolveTenantMembership: vi.fn().mockResolvedValue({ role: 'VIEWER' }),
    });
    const middleware = createUnifiedAuthMiddleware(config);
    const token = makeJwt({
      sub: 'user-1',
      email: 'a@b.c',
      type: 'mfa_pending',
      tenantId: 'tenant-mfa',
    });
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect((req as any).mfaPending).toBe(true);
    expect((req as any).tenantContext).toBeDefined();
    expect((req as any).tenantContext.tenantId).toBe('tenant-mfa');
  });

  it('calls onAuthEvent on successful JWT auth', async () => {
    const onAuthEvent = vi.fn();
    const config = makeConfig({ onAuthEvent });
    const middleware = createUnifiedAuthMiddleware(config);
    const token = makeJwt({
      sub: 'user-1',
      email: 'a@b.c',
      type: 'access',
      tenantId: 'tenant-1',
    });
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect(onAuthEvent).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'success', authType: 'user', userId: 'user-1' }),
    );
  });

  it('uses the trusted rightmost x-forwarded-for value in auth events', async () => {
    const onAuthEvent = vi.fn();
    const config = makeConfig({ onAuthEvent });
    const middleware = createUnifiedAuthMiddleware(config);
    const token = makeJwt({
      sub: 'user-1',
      email: 'a@b.c',
      type: 'access',
      tenantId: 'tenant-1',
    });
    const req = mockReq({
      authorization: `Bearer ${token}`,
      'x-forwarded-for': '198.51.100.10, 10.0.0.5',
    });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect(onAuthEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'success',
        authType: 'user',
        userId: 'user-1',
        ip: '10.0.0.5',
      }),
    );
  });

  it('falls back to x-real-ip for auth events when x-forwarded-for is absent', async () => {
    const onAuthEvent = vi.fn();
    const config = makeConfig({ onAuthEvent });
    const middleware = createUnifiedAuthMiddleware(config);
    const token = makeJwt({
      sub: 'user-1',
      email: 'a@b.c',
      type: 'access',
      tenantId: 'tenant-1',
    });
    const req = mockReq({
      authorization: `Bearer ${token}`,
      'x-real-ip': '203.0.113.7',
    });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect(onAuthEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'success',
        authType: 'user',
        userId: 'user-1',
        ip: '203.0.113.7',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// requireAuth
// ---------------------------------------------------------------------------

describe('requireAuth', () => {
  it('calls next when req.user is set', () => {
    const middleware = requireAuth();
    const req = mockReq();
    (req as any).user = testUser;
    const res = mockRes();
    const next = mockNext();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('calls next when req.tenantContext is set', () => {
    const middleware = requireAuth();
    const req = mockReq();
    (req as any).tenantContext = {
      tenantId: 'tenant-1',
      userId: 'user-1',
      role: 'ADMIN',
      permissions: [],
      authType: 'user',
      isSuperAdmin: false,
    };
    const res = mockRes();
    const next = mockNext();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('returns 401 when neither user nor tenantContext is set', () => {
    const middleware = requireAuth();
    const req = mockReq();
    const res = mockRes();
    const next = mockNext();

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Authentication required' }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('falls back to the shared access-denied reporter when no request reporter was attached', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const middleware = requireAuth();
    const req = mockReq({ 'x-request-id': 'req-fallback-denial' });
    const res = mockRes();
    const next = mockNext();

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(warnSpy).toHaveBeenCalledWith(
      '[AccessDenied] Access denied',
      expect.objectContaining({
        reasonCode: 'AUTHENTICATION_REQUIRED',
        requestId: 'req-fallback-denial',
      }),
    );
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Security: header injection protection
// ---------------------------------------------------------------------------

describe('createUnifiedAuthMiddleware — security', () => {
  it('does NOT read tenantId from X-Tenant-Id header (prevents header injection)', async () => {
    const resolveDefaultTenant = vi
      .fn()
      .mockResolvedValue({ tenantId: 'default-t', role: 'MEMBER', customRoleId: null });
    const config = makeConfig({ resolveDefaultTenant });
    const middleware = createUnifiedAuthMiddleware(config);
    // JWT has no tenantId, but request has X-Tenant-Id header
    const token = makeJwt({ sub: 'user-1', email: 'a@b.c', type: 'access' });
    const req = mockReq({
      authorization: `Bearer ${token}`,
      'x-tenant-id': 'injected-tenant-id',
    });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    // Should use the default tenant from DB, NOT the injected header
    expect((req as any).tenantContext.tenantId).toBe('default-t');
    expect((req as any).tenantContext.tenantId).not.toBe('injected-tenant-id');
  });

  it('does NOT read organization from X-Organization-Id header', async () => {
    const config = makeConfig({
      resolveDefaultTenant: vi
        .fn()
        .mockResolvedValue({ tenantId: 'default-t', role: 'MEMBER', orgId: 'real-org' }),
    });
    const middleware = createUnifiedAuthMiddleware(config);
    const token = makeJwt({ sub: 'user-1', email: 'a@b.c', type: 'access' });
    const req = mockReq({
      authorization: `Bearer ${token}`,
      'x-organization-id': 'injected-org-id',
    });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect((req as any).tenantContext.orgId).toBe('real-org');
    expect((req as any).tenantContext.orgId).not.toBe('injected-org-id');
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('createUnifiedAuthMiddleware — error handling', () => {
  it('returns 500 when an unhandled error occurs', async () => {
    const config = makeConfig({
      getUserById: vi.fn().mockRejectedValue(new Error('db crash')),
    });
    const middleware = createUnifiedAuthMiddleware(config);
    const token = makeJwt({
      sub: 'user-1',
      email: 'a@b.c',
      type: 'access',
      tenantId: 'tenant-1',
    });
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Internal server error' }),
    );
  });

  it('includes requestId in 500 error response when x-request-id header is present', async () => {
    const config = makeConfig({
      getUserById: vi.fn().mockRejectedValue(new Error('db crash')),
    });
    const middleware = createUnifiedAuthMiddleware(config);
    const token = makeJwt({
      sub: 'user-1',
      email: 'a@b.c',
      type: 'access',
      tenantId: 'tenant-1',
    });
    const req = mockReq({
      authorization: `Bearer ${token}`,
      'x-request-id': 'req-123',
    });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Internal server error',
      requestId: 'req-123',
    });
  });

  it('omits requestId from error response when x-request-id header is absent', async () => {
    const config = makeConfig({
      getUserById: vi.fn().mockRejectedValue(new Error('db crash')),
    });
    const middleware = createUnifiedAuthMiddleware(config);
    const token = makeJwt({
      sub: 'user-1',
      email: 'a@b.c',
      type: 'access',
      tenantId: 'tenant-1',
    });
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error' });
  });

  it('handles non-Error thrown values in catch block', async () => {
    const config = makeConfig({
      getUserById: vi.fn().mockRejectedValue('string error'),
    });
    const middleware = createUnifiedAuthMiddleware(config);
    const token = makeJwt({
      sub: 'user-1',
      email: 'a@b.c',
      type: 'access',
      tenantId: 'tenant-1',
    });
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ---------------------------------------------------------------------------
// Default logger
// ---------------------------------------------------------------------------

describe('createUnifiedAuthMiddleware — default logger', () => {
  it('uses default logger info (no-op) when no logger provided', async () => {
    // The default logger.info is a no-op; just verify it doesn't throw
    const config = makeConfig();
    // No logger provided — will use defaultLogger
    const middleware = createUnifiedAuthMiddleware(config);
    const token = makeJwt({
      sub: 'user-1',
      email: 'a@b.c',
      type: 'access',
      tenantId: 'tenant-1',
    });
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('default logger warn and error log to console', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = makeConfig({
      verifySDKSessionToken: vi.fn().mockReturnValue(null),
    });
    const middleware = createUnifiedAuthMiddleware(config);
    const req = mockReq({ 'x-sdk-token': 'bad-token' });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('defaultLogger.info is a no-op function', () => {
    // Directly exercise the info function for coverage
    expect(() => defaultLogger.info('test')).not.toThrow();
    expect(() => defaultLogger.info('test', { key: 'value' })).not.toThrow();
  });

  it('defaultLogger.warn logs to console.warn with meta', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    defaultLogger.warn('test message', { key: 'value' });
    expect(spy).toHaveBeenCalledWith('[UnifiedAuth] test message', { key: 'value' });
    spy.mockRestore();
  });

  it('defaultLogger.warn logs to console.warn without meta', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    defaultLogger.warn('test message');
    expect(spy).toHaveBeenCalledWith('[UnifiedAuth] test message', '');
    spy.mockRestore();
  });

  it('defaultLogger.error logs to console.error with meta', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    defaultLogger.error('test error', { key: 'value' });
    expect(spy).toHaveBeenCalledWith('[UnifiedAuth] test error', { key: 'value' });
    spy.mockRestore();
  });

  it('defaultLogger.error logs to console.error without meta', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    defaultLogger.error('test error');
    expect(spy).toHaveBeenCalledWith('[UnifiedAuth] test error', '');
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// MFA-pending tenant context edge cases
// ---------------------------------------------------------------------------

describe('createUnifiedAuthMiddleware — MFA-pending tenant context', () => {
  it('sets tenant context when mfa_pending JWT has tenantId and membership resolves', async () => {
    const config = makeConfig({
      resolveTenantMembership: vi.fn().mockResolvedValue({ role: 'VIEWER' }),
    });
    const middleware = createUnifiedAuthMiddleware(config);
    const token = makeJwt({
      sub: 'user-1',
      email: 'a@b.c',
      type: 'mfa_pending',
      tenantId: 'tenant-mfa',
      orgId: 'org-mfa',
    });
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect((req as any).mfaPending).toBe(true);
    expect((req as any).tenantContext).toBeDefined();
    expect((req as any).tenantContext.tenantId).toBe('tenant-mfa');
    expect((req as any).tenantContext.orgId).toBe('org-mfa');
    expect((req as any).authContext).toBeDefined();
  });

  it('does not set tenant context when mfa_pending JWT has tenantId but membership is null', async () => {
    const config = makeConfig({
      resolveTenantMembership: vi.fn().mockResolvedValue(null),
    });
    const middleware = createUnifiedAuthMiddleware(config);
    const token = makeJwt({
      sub: 'user-1',
      email: 'a@b.c',
      type: 'mfa_pending',
      tenantId: 'tenant-mfa',
    });
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect((req as any).mfaPending).toBe(true);
    expect((req as any).tenantContext).toBeUndefined();
  });

  it('does not set tenant context when mfa_pending JWT has no tenantId', async () => {
    const config = makeConfig();
    const middleware = createUnifiedAuthMiddleware(config);
    const token = makeJwt({
      sub: 'user-1',
      email: 'a@b.c',
      type: 'mfa_pending',
    });
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect((req as any).mfaPending).toBe(true);
    // No tenantId in token, so no tenant context resolution attempted
    expect((req as any).tenantContext).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// errorJson helper coverage
// ---------------------------------------------------------------------------

describe('createUnifiedAuthMiddleware — errorJson requestId', () => {
  it('includes requestId in 401 error for invalid JWT when x-request-id is present', async () => {
    const config = makeConfig();
    const middleware = createUnifiedAuthMiddleware(config);
    const req = mockReq({
      authorization: 'Bearer invalid-jwt',
      'x-request-id': 'req-456',
    });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Invalid or expired token',
      requestId: 'req-456',
    });
  });

  it('omits requestId from 401 error for invalid JWT when x-request-id is absent', async () => {
    const config = makeConfig();
    const middleware = createUnifiedAuthMiddleware(config);
    const req = mockReq({ authorization: 'Bearer invalid-jwt' });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid or expired token' });
  });

  it('includes requestId in requireAuth 401 response', () => {
    const middleware = requireAuth();
    const req = mockReq({ 'x-request-id': 'req-789' });
    const res = mockRes();
    const next = mockNext();

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Authentication required',
      requestId: 'req-789',
    });
  });
});

describe('createUnifiedAuthMiddleware — access denied reporting', () => {
  it('reports invalid SDK session tokens through onAccessDenied', async () => {
    const onAccessDenied = vi.fn();
    const config = makeConfig({
      onAccessDenied,
      verifySDKSessionToken: vi.fn().mockReturnValue(null),
    });
    const middleware = createUnifiedAuthMiddleware(config);
    const req = mockReq({ 'x-sdk-token': 'bad-sdk-token' });
    const res = mockRes();

    await middleware(req, res, mockNext());

    expect(onAccessDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        layer: 'unified_auth',
        scope: 'auth',
        reasonCode: 'SDK_SESSION_TOKEN_INVALID',
        authType: 'sdk_session',
        statusCode: 401,
      }),
    );
  });

  it('reports invalid API keys through onAccessDenied', async () => {
    const onAccessDenied = vi.fn();
    const config = makeConfig({
      onAccessDenied,
      resolveApiKey: vi.fn().mockResolvedValue(null),
    });
    const middleware = createUnifiedAuthMiddleware(config);
    const req = mockReq({ authorization: 'Bearer abl_invalid_key' });
    const res = mockRes();

    await middleware(req, res, mockNext());

    expect(onAccessDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        layer: 'unified_auth',
        scope: 'auth',
        reasonCode: 'API_KEY_INVALID',
        authType: 'api_key',
        statusCode: 401,
      }),
    );
  });

  it('reports invalid JWTs through onAccessDenied', async () => {
    const onAccessDenied = vi.fn();
    const config = makeConfig({ onAccessDenied });
    const middleware = createUnifiedAuthMiddleware(config);
    const req = mockReq({ authorization: 'Bearer invalid-jwt' });
    const res = mockRes();

    await middleware(req, res, mockNext());

    expect(onAccessDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        layer: 'unified_auth',
        scope: 'auth',
        reasonCode: 'JWT_TOKEN_INVALID',
        authType: 'user',
        statusCode: 401,
      }),
    );
  });

  it('reports revoked tenant membership through onAccessDenied', async () => {
    const onAccessDenied = vi.fn();
    const config = makeConfig({
      onAccessDenied,
      resolveTenantMembership: vi.fn().mockResolvedValue(null),
    });
    const middleware = createUnifiedAuthMiddleware(config);
    const req = mockReq({
      authorization: `Bearer ${makeJwt({
        sub: 'user-1',
        type: 'access',
        tenantId: 'tenant-revoked',
      })}`,
    });
    const res = mockRes();

    await middleware(req, res, mockNext());

    expect(onAccessDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        layer: 'unified_auth',
        scope: 'tenant',
        reasonCode: 'TENANT_MEMBERSHIP_REQUIRED',
        authType: 'user',
        tenantId: 'tenant-revoked',
        userId: 'user-1',
        statusCode: 403,
      }),
    );
  });

  it('forwards requireAuth denials to onAccessDenied through the request reporter', async () => {
    const onAccessDenied = vi.fn();
    const config = makeConfig({ onAccessDenied });
    const middleware = createUnifiedAuthMiddleware(config);
    const req = mockReq({ 'x-request-id': 'req-auth-denied' });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);
    requireAuth()(req, res, mockNext());

    expect(onAccessDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        layer: 'require_auth',
        scope: 'auth',
        reasonCode: 'AUTHENTICATION_REQUIRED',
        requestId: 'req-auth-denied',
        path: '/protected',
        method: 'GET',
      }),
    );
  });

  it('forwards requireTenantContext denials to onAccessDenied through the request reporter', async () => {
    const onAccessDenied = vi.fn();
    const config = makeConfig({
      onAccessDenied,
      resolveDefaultTenant: vi.fn().mockResolvedValue(null),
    });
    const middleware = createUnifiedAuthMiddleware(config);
    const req = mockReq({ authorization: `Bearer ${makeJwt({ sub: 'user-1', type: 'access' })}` });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);
    requireTenantContext()(req, res, mockNext());

    expect(onAccessDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        layer: 'require_tenant_context',
        scope: 'tenant',
        reasonCode: 'TENANT_CONTEXT_REQUIRED',
        path: '/protected',
        method: 'GET',
      }),
    );
  });

  it('includes resolved tenant metadata when permission guards deny after auth resolution', async () => {
    const onAccessDenied = vi.fn();
    const config = makeConfig({
      onAccessDenied,
      resolvePermissions: vi.fn().mockResolvedValue(['agent:read']),
    });
    const middleware = createUnifiedAuthMiddleware(config);
    const req = mockReq({
      authorization: `Bearer ${makeJwt({ sub: 'user-1', type: 'access' })}`,
      'x-request-id': 'req-permission-denied',
    });
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);
    requirePermission('agent:delete')(req, res, mockNext());

    expect(onAccessDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        layer: 'permission_guard',
        scope: 'rbac',
        reasonCode: 'PERMISSION_REQUIRED',
        requestId: 'req-permission-denied',
        tenantId: 'default-tenant',
        userId: 'user-1',
        authType: 'user',
        requiredPermission: 'agent:delete',
      }),
    );
  });
});
