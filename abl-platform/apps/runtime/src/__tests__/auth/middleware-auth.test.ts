/**
 * Auth Middleware Tests
 *
 * Tests for middleware/auth.ts which exports:
 * - unifiedAuth: middleware created via createUnifiedAuthMiddleware from @agent-platform/shared
 * - authMiddleware: chains unifiedAuth + requireAuthWithTenant
 * - extractUserIdFromToken: extracts user ID from a JWT without full user lookup
 *
 * Strategy:
 * - Mock @agent-platform/shared to control unified auth behavior
 * - Mock config, DB, auth-repo, and permission-resolution
 * - Test the exported middleware with mock Express req/res/next
 */

import { afterEach, describe, test, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

// =============================================================================
// TEST CONSTANTS
// =============================================================================

const TEST_SECRET = 'test-secret-key-for-auth-middleware';
const TEST_USER_ID = 'user-123';
const TEST_TENANT_ID = 'tenant-456';
const TEST_EMAIL = 'test@example.com';
const PLATFORM_JWT_ISSUER = 'abl-platform';
const PLATFORM_ACCESS_TOKEN_AUDIENCE = 'platform-access';
const SDK_SESSION_TOKEN_AUDIENCE = 'sdk-session';

// =============================================================================
// HOISTED MOCKS (vi.mock factories are hoisted above all other code)
// =============================================================================

const {
  capturedConfigHolder,
  mockUnifiedMiddleware,
  mockRequireAuthMiddleware,
  mockRequireTenantContextMiddleware,
  mockFindUserById,
  mockResolveTenantMembership,
  mockResolveDefaultTenant,
  mockResolveApiKey,
  mockWriteAuditLog,
  mockResolvePermissions,
  mockIsDbPlatformAdminUser,
  mockConfig,
} = vi.hoisted(() => ({
  capturedConfigHolder: { value: null as any },
  mockUnifiedMiddleware: vi.fn(),
  mockRequireAuthMiddleware: vi.fn(),
  mockRequireTenantContextMiddleware: vi.fn(),
  mockFindUserById: vi.fn(),
  mockResolveTenantMembership: vi.fn(),
  mockResolveDefaultTenant: vi.fn(),
  mockResolveApiKey: vi.fn(),
  mockWriteAuditLog: vi.fn(),
  mockResolvePermissions: vi.fn().mockResolvedValue(['read', 'write']),
  mockIsDbPlatformAdminUser: vi.fn(),
  mockConfig: {
    jwt: { secret: 'test-secret-key-for-auth-middleware' },
    env: 'test' as string,
    security: { superAdminUserIds: ['super-admin-1'] },
  },
}));

// =============================================================================
// MOCK: @agent-platform/shared
// =============================================================================

vi.mock('@agent-platform/shared-auth', async () => {
  const _jwt = await import('jsonwebtoken');
  const platformJwtIssuer = 'abl-platform';
  const platformAccessTokenAudience = 'platform-access';
  const sdkSessionTokenAudience = 'sdk-session';
  class AuthError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
      super(message);
      this.name = 'AuthError';
      this.code = code;
    }
  }
  const normalizeOptionalString = (value: unknown) => {
    if (typeof value !== 'string') {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };
  const requireStringClaim = (payload: Record<string, unknown>, claim: string) => {
    if (!normalizeOptionalString(payload[claim])) {
      throw new AuthError('INVALID_PAYLOAD', `Token missing ${claim} claim`);
    }
  };
  return {
    AuthError,
    createUnifiedAuthMiddleware: (config: any) => {
      capturedConfigHolder.value = config;
      return mockUnifiedMiddleware;
    },
    requireAuth: vi.fn(() => (_req: any, _res: any, next: any) => next()),
    requireAuthWithTenant: () => [mockRequireAuthMiddleware, mockRequireTenantContextMiddleware],
    getRequestAccessDeniedReporter: vi.fn(() => vi.fn()),
    PLATFORM_ADMIN_TENANT_ID: '__platform_admin__',
    runWithTenantContext: (_ctx: unknown, fn: () => unknown) => fn(),
    toAuthContext: (ctx: any) => ({
      tenantId: ctx.tenantId,
      orgId: ctx.orgId,
      authType: ctx.authType,
      permissions: ctx.permissions,
      userId: ctx.userId,
      role: ctx.role,
      isSuperAdmin: ctx.isSuperAdmin,
    }),
    verifyToken: (token: string, secret: string) => {
      try {
        return _jwt.default.verify(token, secret, {
          issuer: platformJwtIssuer,
          audience: platformAccessTokenAudience,
        }) as any;
      } catch {
        return null;
      }
    },
    extractUserIdFromToken: (token: string, secret: string) => {
      try {
        const payload = _jwt.default.verify(token, secret, {
          issuer: platformJwtIssuer,
          audience: platformAccessTokenAudience,
        }) as any;
        if (payload.type !== 'access' && payload.type !== 'mfa_pending') return null;
        return payload.sub ?? null;
      } catch {
        return null;
      }
    },
    resolveSdkSessionIdentityState: (payload: any) => {
      const projectId = normalizeOptionalString(payload.projectId);
      if (!projectId) {
        return { success: false, reason: 'missing_project_scope' };
      }

      const channelId = normalizeOptionalString(payload.channelId);
      if (!channelId) {
        return { success: false, reason: 'missing_channel_scope' };
      }

      const verifiedUserId = normalizeOptionalString(payload.verifiedUserId);
      const authScope =
        payload.authScope === 'session' || payload.authScope === 'user'
          ? payload.authScope
          : verifiedUserId
            ? 'user'
            : 'session';

      if (authScope === 'user' && !verifiedUserId) {
        return { success: false, reason: 'missing_verified_user' };
      }

      const sessionPrincipal =
        normalizeOptionalString(payload.sessionPrincipal) ??
        normalizeOptionalString(payload.sessionId);
      if (!sessionPrincipal) {
        return { success: false, reason: 'missing_session_principal' };
      }

      return {
        success: true,
        sessionPrincipal,
        authScope,
        principalUserId: authScope === 'user' ? verifiedUserId : sessionPrincipal,
        ...(verifiedUserId ? { verifiedUserId } : {}),
      };
    },
    verifySDKSessionToken: (token: string, secret: string) => {
      const payload = _jwt.default.verify(token, secret, {
        issuer: platformJwtIssuer,
        audience: sdkSessionTokenAudience,
      }) as any;
      if (payload.type !== 'sdk_session') {
        throw new AuthError('WRONG_PURPOSE', 'Token is not an SDK session token');
      }
      requireStringClaim(payload, 'tenantId');
      requireStringClaim(payload, 'projectId');
      requireStringClaim(payload, 'channelId');
      return payload;
    },
    PROJECT_ROLE_NAMES: ['admin', 'developer', 'tester', 'viewer'],
    PLATFORM_JWT_ISSUER: platformJwtIssuer,
    PLATFORM_ACCESS_TOKEN_AUDIENCE: platformAccessTokenAudience,
    SDK_SESSION_TOKEN_AUDIENCE: sdkSessionTokenAudience,
  };
});

// =============================================================================
// MOCK: ../config/index.js
// =============================================================================

vi.mock('../../config/index.js', () => ({
  getConfig: () => mockConfig,
}));

// =============================================================================
// MOCK: ../db/index.js
// =============================================================================

vi.mock('../../db/index.js', () => ({
  isDatabaseAvailable: () => true,
}));

// =============================================================================
// MOCK: ../repos/auth-repo.js
// =============================================================================

vi.mock('../../repos/auth-repo.js', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  findUserById: (...args: any[]) => mockFindUserById(...args),
  resolveTenantMembership: (...args: any[]) => mockResolveTenantMembership(...args),
  resolveDefaultTenant: (...args: any[]) => mockResolveDefaultTenant(...args),
  resolveApiKey: (...args: any[]) => mockResolveApiKey(...args),
  writeAuditLog: (...args: any[]) => mockWriteAuditLog(...args),
}));

// =============================================================================
// MOCK: ../services/permission-resolution.js
// =============================================================================

vi.mock('../../services/permission-resolution.js', () => ({
  clearPermissionCache: vi.fn(),
  resolveEffectivePermissions: (...args: any[]) => mockResolvePermissions(...args),
}));

vi.mock('@agent-platform/database/platform-access-policy', () => ({
  isPlatformAdminUser: (...args: unknown[]) => mockIsDbPlatformAdminUser(...args),
}));

// =============================================================================
// MOCK: @abl/compiler/platform (logger)
// =============================================================================

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// =============================================================================
// IMPORT UNDER TEST (after mocks are set up)
// =============================================================================

import * as authModule from '../../middleware/auth.js';

const {
  authMiddleware,
  platformAdminAuthMiddleware,
  unifiedAuth,
  extractUserIdFromToken,
  resetRuntimeSdkSessionVerifierForTesting,
  SDK_TOKEN_ISSUER,
  SDK_TOKEN_AUDIENCE,
  setRuntimeSdkSessionVerifierForTesting,
} = authModule;

// =============================================================================
// HELPERS
// =============================================================================

const mockReq = (headers: Record<string, string> = {}) =>
  ({
    headers,
    get: (name: string) => headers[name.toLowerCase()],
    ip: '127.0.0.1',
    query: {},
    user: undefined as any,
    tenantContext: undefined as any,
    mfaPending: undefined as any,
  }) as any;

const mockRes = () => {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as any;
  return res;
};

function createAccessToken(payload: Record<string, unknown> = {}, secret = TEST_SECRET): string {
  return jwt.sign({ sub: TEST_USER_ID, email: TEST_EMAIL, type: 'access', ...payload }, secret, {
    issuer: PLATFORM_JWT_ISSUER,
    audience: PLATFORM_ACCESS_TOKEN_AUDIENCE,
  });
}

function createExpiredToken(): string {
  return jwt.sign({ sub: TEST_USER_ID, email: TEST_EMAIL, type: 'access' }, TEST_SECRET, {
    issuer: PLATFORM_JWT_ISSUER,
    audience: PLATFORM_ACCESS_TOKEN_AUDIENCE,
    expiresIn: -10,
  });
}

function createSDKSessionToken(payload: Record<string, unknown> = {}): string {
  return jwt.sign(
    {
      type: 'sdk_session',
      tenantId: TEST_TENANT_ID,
      projectId: 'proj-1',
      channelId: 'ch-1',
      sessionId: 'sdk-session-1',
      permissions: ['chat'],
      ...payload,
    },
    TEST_SECRET,
    { issuer: PLATFORM_JWT_ISSUER, audience: SDK_SESSION_TOKEN_AUDIENCE, expiresIn: '1h' },
  );
}

async function flushMiddlewarePromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// =============================================================================
// TESTS: extractUserIdFromToken
// =============================================================================

describe('extractUserIdFromToken', () => {
  test('returns user ID from a valid JWT with sub claim', () => {
    const token = createAccessToken();
    const userId = extractUserIdFromToken(token);
    expect(userId).toBe(TEST_USER_ID);
  });

  test('returns null for an invalid JWT', () => {
    const result = extractUserIdFromToken('not.a.valid.jwt');
    expect(result).toBeNull();
  });

  test('returns null for an expired JWT', () => {
    const token = createExpiredToken();
    const result = extractUserIdFromToken(token);
    expect(result).toBeNull();
  });

  test('returns null for an empty string', () => {
    const result = extractUserIdFromToken('');
    expect(result).toBeNull();
  });
});

// =============================================================================
// TESTS: authMiddleware
// =============================================================================

describe('authMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireTenantContextMiddleware.mockImplementation((_req: any, _res: any, next: any) =>
      next(),
    );
  });

  test('calls next when unifiedAuth sets req.user (authenticated)', () => {
    mockUnifiedMiddleware.mockImplementation((req: any, _res: any, next: any) => {
      req.user = { id: TEST_USER_ID, email: TEST_EMAIL };
      req.tenantContext = { tenantId: TEST_TENANT_ID, userId: TEST_USER_ID, role: 'ADMIN' };
      next();
    });
    mockRequireAuthMiddleware.mockImplementation((req: any, _res: any, next: any) => {
      if (req.user || req.tenantContext) {
        next();
      } else {
        _res.status(401).json({ error: 'Authentication required' });
      }
    });

    const req = mockReq({ authorization: `Bearer ${createAccessToken()}` });
    const res = mockRes();
    const next = vi.fn();

    authMiddleware(req, res, next);

    expect(mockUnifiedMiddleware).toHaveBeenCalledTimes(1);
    expect(mockRequireTenantContextMiddleware).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('returns 401 when unifiedAuth does NOT set req.user', () => {
    mockUnifiedMiddleware.mockImplementation((_req: any, _res: any, next: any) => {
      next();
    });
    mockRequireAuthMiddleware.mockImplementation((_req: any, res: any, _next: any) => {
      res.status(401).json({ error: 'Authentication required' });
    });

    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    authMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Authentication required' }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 403 when authentication succeeds without tenant context', () => {
    mockUnifiedMiddleware.mockImplementation((req: any, _res: any, next: any) => {
      req.user = { id: TEST_USER_ID, email: TEST_EMAIL };
      next();
    });
    mockRequireAuthMiddleware.mockImplementation((req: any, _res: any, next: any) => {
      if (req.user) next();
    });
    mockRequireTenantContextMiddleware.mockImplementation((_req: any, res: any, _next: any) => {
      res.status(403).json({
        success: false,
        error: {
          code: 'TENANT_CONTEXT_REQUIRED',
          message: 'Tenant context is required for this operation',
        },
      });
    });

    const req = mockReq({ authorization: `Bearer ${createAccessToken()}` });
    const res = mockRes();
    const next = vi.fn();

    authMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('processes Authorization header with valid Bearer token', () => {
    mockUnifiedMiddleware.mockImplementation((req: any, _res: any, next: any) => {
      req.user = { id: TEST_USER_ID, email: TEST_EMAIL };
      req.tenantContext = { tenantId: TEST_TENANT_ID, userId: TEST_USER_ID, role: 'ADMIN' };
      next();
    });
    mockRequireAuthMiddleware.mockImplementation((req: any, _res: any, next: any) => {
      if (req.user || req.tenantContext) next();
    });

    const token = createAccessToken();
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();
    const next = vi.fn();

    authMiddleware(req, res, next);

    expect(mockUnifiedMiddleware).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: `Bearer ${token}` }),
      }),
      res,
      expect.any(Function),
    );
    expect(next).toHaveBeenCalled();
  });

  test('processes Authorization header with API key (abl_* prefix)', () => {
    mockUnifiedMiddleware.mockImplementation((req: any, _res: any, next: any) => {
      req.tenantContext = {
        tenantId: TEST_TENANT_ID,
        userId: 'api-key-creator',
        role: 'api_key',
        authType: 'api_key',
      };
      next();
    });
    mockRequireAuthMiddleware.mockImplementation((req: any, _res: any, next: any) => {
      if (req.user || req.tenantContext) next();
    });

    const req = mockReq({ authorization: 'Bearer abl_test_key_123456' });
    const res = mockRes();
    const next = vi.fn();

    authMiddleware(req, res, next);

    expect(mockUnifiedMiddleware).toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('returns 401 when no Authorization header is present', () => {
    mockUnifiedMiddleware.mockImplementation((_req: any, _res: any, next: any) => {
      next();
    });
    mockRequireAuthMiddleware.mockImplementation((_req: any, res: any, _next: any) => {
      res.status(401).json({ error: 'Authentication required' });
    });

    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    authMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('passes error to next when unifiedAuth errors', () => {
    const authError = new Error('Auth processing failed');
    mockUnifiedMiddleware.mockImplementation((_req: any, _res: any, next: any) => {
      next(authError);
    });

    const req = mockReq({ authorization: `Bearer ${createAccessToken()}` });
    const res = mockRes();
    const next = vi.fn();

    authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledWith(authError);
  });

  test('sets tenantContext when SDK token is provided', () => {
    mockUnifiedMiddleware.mockImplementation((req: any, _res: any, next: any) => {
      req.tenantContext = {
        tenantId: TEST_TENANT_ID,
        userId: 'sdk:ch-1',
        role: 'sdk_session',
        authType: 'sdk_session',
      };
      next();
    });
    mockRequireAuthMiddleware.mockImplementation((req: any, _res: any, next: any) => {
      if (req.user || req.tenantContext) next();
    });

    const sdkToken = createSDKSessionToken();
    const req = mockReq({ 'x-sdk-token': sdkToken });
    const res = mockRes();
    const next = vi.fn();

    authMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('does not call requireAuth when unifiedAuth returns error', () => {
    const err = new Error('middleware error');
    mockUnifiedMiddleware.mockImplementation((_req: any, _res: any, next: any) => {
      next(err);
    });

    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    authMiddleware(req, res, next);

    expect(mockRequireAuthMiddleware).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(err);
  });
});

// =============================================================================
// TESTS: platformAdminAuthMiddleware
// =============================================================================

describe('platformAdminAuthMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsDbPlatformAdminUser.mockResolvedValue(false);
  });

  test('creates a platform-admin context for a DB-managed admin without tenant membership', async () => {
    mockUnifiedMiddleware.mockImplementation((req: any, _res: any, next: any) => {
      req.user = { id: 'db-admin-1', email: 'db-admin@example.com' };
      next();
    });
    mockIsDbPlatformAdminUser.mockResolvedValue(true);

    const req = mockReq({ authorization: `Bearer ${createAccessToken()}` });
    const res = mockRes();
    const next = vi.fn();

    platformAdminAuthMiddleware(req, res, next);
    await flushMiddlewarePromises();

    expect(mockIsDbPlatformAdminUser).toHaveBeenCalledWith({
      id: 'db-admin-1',
      email: 'db-admin@example.com',
    });
    expect(req.tenantContext).toEqual({
      tenantId: '__platform_admin__',
      userId: 'db-admin-1',
      role: 'platform_admin',
      permissions: [],
      authType: 'user',
      isSuperAdmin: true,
    });
    expect(req.authContext).toEqual({
      tenantId: '__platform_admin__',
      authType: 'user',
      permissions: [],
      userId: 'db-admin-1',
      role: 'platform_admin',
      isSuperAdmin: true,
    });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('upgrades an existing tenant context for a DB-managed admin', async () => {
    mockUnifiedMiddleware.mockImplementation((req: any, _res: any, next: any) => {
      req.user = { id: 'db-admin-2', email: 'db-admin-2@example.com' };
      req.tenantContext = {
        tenantId: TEST_TENANT_ID,
        userId: 'db-admin-2',
        role: 'ADMIN',
        permissions: ['read'],
        authType: 'user',
        isSuperAdmin: false,
      };
      next();
    });
    mockIsDbPlatformAdminUser.mockResolvedValue(true);

    const req = mockReq({ authorization: `Bearer ${createAccessToken()}` });
    const res = mockRes();
    const next = vi.fn();

    platformAdminAuthMiddleware(req, res, next);
    await flushMiddlewarePromises();

    expect(req.tenantContext.isSuperAdmin).toBe(true);
    expect(req.authContext).toEqual({
      tenantId: TEST_TENANT_ID,
      authType: 'user',
      permissions: ['read'],
      userId: 'db-admin-2',
      role: 'ADMIN',
      isSuperAdmin: true,
    });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});

// =============================================================================
// TESTS: unifiedAuth config callbacks
// =============================================================================

describe('unifiedAuth config callbacks', () => {
  // capturedConfigHolder.value is set when the module loads and
  // createUnifiedAuthMiddleware is called. We test the config callbacks
  // that were passed to it.

  beforeEach(() => {
    vi.clearAllMocks();
    setRuntimeSdkSessionVerifierForTesting(async (token) => {
      try {
        const payload = jwt.verify(token, TEST_SECRET, {
          issuer: PLATFORM_JWT_ISSUER,
          audience: SDK_SESSION_TOKEN_AUDIENCE,
        }) as any;

        if (payload.type !== 'sdk_session' || !payload.channelId) {
          return {
            success: false,
            status: 401,
            code: 'INVALID_SDK_TOKEN',
            error: 'Invalid or expired SDK session token',
            logReason: 'test_invalid_sdk_session',
          };
        }

        return {
          success: true,
          payload,
          envelope: 'signed',
        };
      } catch {
        return {
          success: false,
          status: 401,
          code: 'INVALID_SDK_TOKEN',
          error: 'Invalid or expired SDK session token',
          logReason: 'test_invalid_sdk_session',
        };
      }
    });
  });

  afterEach(() => {
    resetRuntimeSdkSessionVerifierForTesting();
  });

  test('resolveApiKey hashes the key and calls the repo', async () => {
    const rawKey = 'abl_test_key_abcdef1234567890';
    const expectedPrefix = rawKey.substring(0, 8);

    mockResolveApiKey.mockResolvedValue({
      tenantId: TEST_TENANT_ID,
      apiKeyId: 'key-1',
      clientId: 'client-1',
      createdBy: 'user-1',
      scopes: ['read'],
      projectIds: [],
      environments: [],
    });

    const config = capturedConfigHolder.value;
    expect(config).not.toBeNull();
    const result = await config.resolveApiKey(rawKey);

    expect(mockResolveApiKey).toHaveBeenCalledTimes(1);
    // The first arg should be a SHA-256 hex hash
    const hashArg = mockResolveApiKey.mock.calls[0][0];
    expect(hashArg).toMatch(/^[a-f0-9]{64}$/);
    // The second arg should be the 8-char prefix
    const prefixArg = mockResolveApiKey.mock.calls[0][1];
    expect(prefixArg).toBe(expectedPrefix);
    expect(result).toEqual(expect.objectContaining({ tenantId: TEST_TENANT_ID }));
  });

  test('resolveApiKey returns null when repo throws', async () => {
    mockResolveApiKey.mockRejectedValue(new Error('DB connection failed'));

    const config = capturedConfigHolder.value;
    const result = await config.resolveApiKey('abl_bad_key');
    expect(result).toBeNull();
  });

  test('verifySDKSessionToken with valid token returns payload', async () => {
    const token = createSDKSessionToken();
    const config = capturedConfigHolder.value;
    const result = await config.verifySDKSessionToken(token);

    expect(result).not.toBeNull();
    expect(result.type).toBe('sdk_session');
    expect(result.tenantId).toBe(TEST_TENANT_ID);
    expect(result.channelId).toBe('ch-1');
  });

  test('verifySDKSessionToken with missing channelId returns null', async () => {
    const token = createSDKSessionToken({ channelId: '' });
    const config = capturedConfigHolder.value;
    const result = await config.verifySDKSessionToken(token);
    expect(result).toBeNull();
  });

  test('verifySDKSessionToken with invalid token returns null', async () => {
    const config = capturedConfigHolder.value;
    const result = await config.verifySDKSessionToken('invalid.token.here');
    expect(result).toBeNull();
  });

  test('verifySDKSessionToken with wrong type returns null', async () => {
    const token = jwt.sign(
      { type: 'access', tenantId: TEST_TENANT_ID, channelId: 'ch-1', permissions: [] },
      TEST_SECRET,
      { issuer: PLATFORM_JWT_ISSUER, audience: SDK_SESSION_TOKEN_AUDIENCE, expiresIn: '1h' },
    );
    const config = capturedConfigHolder.value;
    const result = await config.verifySDKSessionToken(token);
    expect(result).toBeNull();
  });

  test('getUserById with existing user returns AuthUser shape', async () => {
    mockFindUserById.mockResolvedValue({
      id: TEST_USER_ID,
      email: TEST_EMAIL,
      name: 'Test User',
    });

    const config = capturedConfigHolder.value;
    const result = await config.getUserById(TEST_USER_ID);

    expect(result).toEqual({
      id: TEST_USER_ID,
      email: TEST_EMAIL,
      name: 'Test User',
    });
    expect(mockFindUserById).toHaveBeenCalledWith(TEST_USER_ID);
  });

  test('getUserById in dev mode with non-existent user returns dev user', async () => {
    mockFindUserById.mockResolvedValue(null);
    mockConfig.env = 'dev';

    const config = capturedConfigHolder.value;
    const result = await config.getUserById('dev-user');

    expect(result).toEqual({
      id: 'dev-user',
      email: 'dev-user@dev.local',
      name: 'dev-user',
    });

    mockConfig.env = 'test';
  });

  test('getUserById in dev mode with email-like ID uses email directly', async () => {
    mockFindUserById.mockResolvedValue(null);
    mockConfig.env = 'dev';

    const config = capturedConfigHolder.value;
    const result = await config.getUserById('admin@company.com');

    expect(result).toEqual({
      id: 'admin@company.com',
      email: 'admin@company.com',
      name: 'admin@company.com',
    });

    mockConfig.env = 'test';
  });

  test('getUserById in production with non-existent user returns null', async () => {
    mockFindUserById.mockResolvedValue(null);
    mockConfig.env = 'production';

    const config = capturedConfigHolder.value;
    const result = await config.getUserById('nonexistent');

    expect(result).toBeNull();

    mockConfig.env = 'test';
  });

  test('isSuperAdmin returns true for configured super admin IDs', () => {
    const config = capturedConfigHolder.value;
    expect(config.isSuperAdmin('super-admin-1')).toBe(true);
    expect(config.isSuperAdmin('regular-user')).toBe(false);
  });

  test('getJwtSecret returns the configured JWT secret', () => {
    const config = capturedConfigHolder.value;
    expect(config.getJwtSecret()).toBe(TEST_SECRET);
  });
});

// =============================================================================
// TESTS: SDK_TOKEN constants
// =============================================================================

describe('SDK token constants', () => {
  test('SDK_TOKEN_ISSUER is "abl-platform"', () => {
    expect(SDK_TOKEN_ISSUER).toBe(PLATFORM_JWT_ISSUER);
  });

  test('SDK_TOKEN_AUDIENCE is "sdk-session"', () => {
    expect(SDK_TOKEN_AUDIENCE).toBe(SDK_SESSION_TOKEN_AUDIENCE);
  });
});
