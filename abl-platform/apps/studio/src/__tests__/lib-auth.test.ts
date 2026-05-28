/**
 * Tests for auth-related lib utilities:
 * - api-client.ts (authHeaders, apiFetch, handleResponse)
 * - auth.ts (getAuthenticatedUser, requireAuth, isAuthError, requireAuthOrMFAPending)
 * - rate-limit.ts (checkRateLimit)
 * - runtime-proxy.ts (buildRuntimeProxyHeaders, proxyToRuntime)
 * - token-hash.ts (hashToken)
 * - swr-config.ts (swrFetcher, swrConfig)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';

// ---------------------------------------------------------------------------
// Mock zustand stores
// ---------------------------------------------------------------------------

const mockAuthStoreState = {
  accessToken: 'test-token-123',
  tenantId: 'tenant-abc',
  setTokens: vi.fn(),
  clearAuth: vi.fn(),
};

vi.mock('@/store/auth-store', () => ({
  useAuthStore: {
    getState: () => mockAuthStoreState,
  },
}));

const mockProjectStoreState = {
  setProjects: vi.fn(),
  setLoading: vi.fn(),
  setError: vi.fn(),
  addProject: vi.fn(),
  removeProject: vi.fn(),
};

vi.mock('@/store/project-store', () => ({
  useProjectStore: {
    getState: () => mockProjectStoreState,
  },
  // Re-export types via inline placeholder
}));

// ---------------------------------------------------------------------------
// Mock server-only (auth.ts imports 'server-only' which throws in non-server env)
// ---------------------------------------------------------------------------

vi.mock('server-only', () => ({}));

// ---------------------------------------------------------------------------
// Mock auth-service and auth-repo for auth.ts tests
// ---------------------------------------------------------------------------

const mockVerifyAccessToken = vi.fn();
const mockResolveUserTenantContext = vi.fn();
const mockRevokeAllUserTokens = vi.fn();
vi.mock('@/services/auth-service', () => ({
  verifyAccessToken: (...args: unknown[]) => mockVerifyAccessToken(...args),
  resolveUserTenantContext: (...args: unknown[]) => mockResolveUserTenantContext(...args),
  revokeAllUserTokens: (...args: unknown[]) => mockRevokeAllUserTokens(...args),
}));

const mockFindUserById = vi.fn();
const mockFindTenantMembership = vi.fn();
const mockResetFailedLoginAttempts = vi.fn();
vi.mock('@/repos/auth-repo', () => ({
  findUserById: (...args: unknown[]) => mockFindUserById(...args),
  findTenantMembership: (...args: unknown[]) => mockFindTenantMembership(...args),
  resetFailedLoginAttempts: (...args: unknown[]) => mockResetFailedLoginAttempts(...args),
}));

const mockFindTenantMember = vi.fn();
const mockUpdateTenantMember = vi.fn();
vi.mock('@/repos/workspace-repo', () => ({
  findTenantMember: (...args: unknown[]) => mockFindTenantMember(...args),
  updateTenantMember: (...args: unknown[]) => mockUpdateTenantMember(...args),
}));

const mockLogAuditEvent = vi.fn();
vi.mock('@/services/audit-service', () => ({
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
}));

// ---------------------------------------------------------------------------
// Mock permission-resolver (avoids real DB queries to RoleDefinition/ResourcePermission)
// ---------------------------------------------------------------------------

const mockResolveStudioPermissions = vi.fn().mockResolvedValue(['*:*']);

vi.mock('@/lib/permission-resolver', () => ({
  resolveStudioPermissions: (...args: unknown[]) => mockResolveStudioPermissions(...args),
  hasPermission: vi.fn().mockReturnValue(true),
  hasAnyPermission: vi.fn().mockReturnValue(true),
}));

const mockVerifyPlatformAccessToken = vi.fn();

vi.mock('@agent-platform/shared-auth', () => ({
  verifyPlatformAccessToken: (...args: unknown[]) => mockVerifyPlatformAccessToken(...args),
}));

// ---------------------------------------------------------------------------
// Mock sanitize-error
// ---------------------------------------------------------------------------

vi.mock('@/lib/sanitize-error', () => ({
  sanitizeServerError: (msg: unknown, fallback: string) =>
    typeof msg === 'string' && msg.length > 0 ? msg : fallback,
  sanitizeError: (err: unknown, fallback: string) => {
    if (err instanceof Error && err.message) return err.message;
    if (typeof err === 'string' && err.length > 0) return err;
    return fallback;
  },
}));

// ---------------------------------------------------------------------------
// Mock @agent-platform/shared/errors (imported by api-client and swr-config)
// ---------------------------------------------------------------------------

vi.mock('@agent-platform/shared/errors', () => {
  class AppError extends Error {
    code: string;
    statusCode: number;
    cause?: unknown;
    constructor(
      message: string,
      opts?: { code?: string; statusCode?: number; cause?: unknown; messages?: string[] },
    ) {
      super(message);
      this.name = 'AppError';
      this.code = opts?.code || 'INTERNAL_ERROR';
      this.statusCode = opts?.statusCode || 500;
      this.cause = opts?.cause;
    }
  }
  return {
    AppError,
    ErrorCodes: {
      BAD_REQUEST: { code: 'BAD_REQUEST', statusCode: 400 },
      UNAUTHORIZED: { code: 'UNAUTHORIZED', statusCode: 401 },
      FORBIDDEN: { code: 'FORBIDDEN', statusCode: 403 },
      NOT_FOUND: { code: 'NOT_FOUND', statusCode: 404 },
      INTERNAL_ERROR: { code: 'INTERNAL_ERROR', statusCode: 500 },
    },
  };
});

// ---------------------------------------------------------------------------
// Mock @/lib/api-response (imported by auth.ts)
// ---------------------------------------------------------------------------

vi.mock('@/lib/api-response', () => ({
  errorJson: (message: string, status: number, code: string) =>
    NextResponse.json({ success: false, errors: [{ msg: message, code }] }, { status }),
  ErrorCode: {
    UNAUTHORIZED: 'UNAUTHORIZED',
    FORBIDDEN: 'FORBIDDEN',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    NOT_FOUND: 'NOT_FOUND',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
  },
}));

// (permission-resolver mock already declared above)

// ---------------------------------------------------------------------------
// Mock @/lib/redis-client (imported by rate-limit.ts)
// ---------------------------------------------------------------------------

vi.mock('@/lib/redis-client', () => ({
  isRedisAvailable: () => false,
  getRedisClient: () => null,
}));

// ---------------------------------------------------------------------------
// Mock @/config (imported transitively by redis-client)
// ---------------------------------------------------------------------------

vi.mock('@/config', () => ({
  getConfig: () => ({
    jwt: { secret: 'test-secret' },
    server: { frontendUrl: 'http://localhost:5173' },
    auth: { tokens: { mfaCookieMaxAgeSeconds: 300 } },
  }),
  isConfigLoaded: () => true,
}));

// ---------------------------------------------------------------------------
// Global fetch mock
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();

async function expectRejectedMessage(
  promise: Promise<unknown>,
  expectedMessage: string,
): Promise<void> {
  expect.assertions(2);

  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    expect(err instanceof Error ? err.message : String(err)).toContain(expectedMessage);
  }
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
  mockVerifyPlatformAccessToken.mockImplementation((token: string) =>
    jwt.verify(token, 'test-secret'),
  );
  mockResolveUserTenantContext.mockResolvedValue(null);
  mockFindTenantMembership.mockResolvedValue(null);
  mockFindTenantMember.mockResolvedValue(null);
  // Reset auth store defaults
  mockAuthStoreState.accessToken = 'test-token-123';
  mockAuthStoreState.tenantId = 'tenant-abc';
});

// ===========================================================================
// api-client.ts
// ===========================================================================

describe('api-client', () => {
  describe('authHeaders', () => {
    it('should return Authorization and X-Tenant-Id headers when both are set', async () => {
      const { authHeaders } = await import('../lib/api-client');
      const headers = authHeaders();
      expect(headers).toEqual({
        Authorization: 'Bearer test-token-123',
        'X-Tenant-Id': 'tenant-abc',
      });
    });

    it('should omit Authorization when accessToken is null', async () => {
      mockAuthStoreState.accessToken = null as unknown as string;
      const { authHeaders } = await import('../lib/api-client');
      const headers = authHeaders();
      expect(headers).not.toHaveProperty('Authorization');
    });

    it('should omit X-Tenant-Id when tenantId is null', async () => {
      mockAuthStoreState.tenantId = null as unknown as string;
      const { authHeaders } = await import('../lib/api-client');
      const headers = authHeaders();
      expect(headers).not.toHaveProperty('X-Tenant-Id');
    });

    it('should return empty object when both are null', async () => {
      mockAuthStoreState.accessToken = null as unknown as string;
      mockAuthStoreState.tenantId = null as unknown as string;
      const { authHeaders } = await import('../lib/api-client');
      const headers = authHeaders();
      expect(headers).toEqual({});
    });
  });

  describe('apiFetch', () => {
    it('should make a fetch request with auth headers', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      const { apiFetch } = await import('../lib/api-client');

      await apiFetch('/api/test');

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/test',
        expect.objectContaining({
          credentials: 'same-origin',
        }),
      );
    });

    it('should merge custom headers with auth headers', async () => {
      mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));
      const { apiFetch } = await import('../lib/api-client');

      await apiFetch('/api/test', {
        headers: { 'Content-Type': 'application/json' },
      });

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/test',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-token-123',
            'X-Tenant-Id': 'tenant-abc',
          }),
        }),
      );
    });

    it('should return response directly on non-401 status', async () => {
      const responseBody = JSON.stringify({ data: 'value' });
      mockFetch.mockResolvedValueOnce(new Response(responseBody, { status: 200 }));
      const { apiFetch } = await import('../lib/api-client');

      const result = await apiFetch('/api/data');
      expect(result.status).toBe(200);
    });

    it('should return the original 401 when token refresh fails', async () => {
      // First call returns 401
      mockFetch.mockResolvedValueOnce(new Response('{}', { status: 401 }));
      // Refresh call fails
      mockFetch.mockResolvedValueOnce(new Response('{}', { status: 403 }));

      const { apiFetch } = await import('../lib/api-client');
      const result = await apiFetch('/api/protected');

      // Returns the original 401 when refresh fails and leaves auth state unchanged.
      expect(result.status).toBe(401);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockAuthStoreState.clearAuth).not.toHaveBeenCalled();
    });

    it('should retry original request after successful token refresh', async () => {
      // First call returns 401
      mockFetch.mockResolvedValueOnce(new Response('{}', { status: 401 }));
      // Refresh call succeeds
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ accessToken: 'new-token' }), { status: 200 }),
      );
      // Retry call succeeds
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: 'ok' }), { status: 200 }),
      );

      const { apiFetch } = await import('../lib/api-client');
      const result = await apiFetch('/api/protected');

      expect(result.status).toBe(200);
      expect(mockAuthStoreState.setTokens).toHaveBeenCalledWith('new-token');
    });

    it('should pass through request init options', async () => {
      mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));
      const { apiFetch } = await import('../lib/api-client');

      await apiFetch('/api/data', { method: 'POST', body: '{"key":"value"}' });

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/data',
        expect.objectContaining({
          method: 'POST',
          body: '{"key":"value"}',
        }),
      );
    });
  });

  describe('handleResponse', () => {
    it('should parse JSON for successful responses', async () => {
      const { handleResponse } = await import('../lib/api-client');
      const response = new Response(JSON.stringify({ name: 'test' }), { status: 200 });

      const result = await handleResponse<{ name: string }>(response);
      expect(result).toEqual({ name: 'test' });
    });

    it('should throw an error for non-ok responses with error body', async () => {
      const { handleResponse } = await import('../lib/api-client');
      const response = new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });

      await expectRejectedMessage(handleResponse(response), 'Not found');
    });

    it('should throw fallback error when body is not JSON', async () => {
      const { handleResponse } = await import('../lib/api-client');
      const response = new Response('not json', { status: 500 });

      await expectRejectedMessage(handleResponse(response), 'Request failed');
    });

    it('should throw fallback error when body has no error field', async () => {
      const { handleResponse } = await import('../lib/api-client');
      const response = new Response(JSON.stringify({}), { status: 400 });

      await expectRejectedMessage(handleResponse(response), 'Request failed');
    });

    it('should preserve structured export readiness issues in the thrown error cause', async () => {
      const { handleResponse } = await import('../lib/api-client');
      const response = new Response(
        JSON.stringify({
          error: {
            code: 'INVALID_AGENT_DRAFT',
            message: 'Export blocked because the project working copy has validation errors.',
          },
          issues: [
            {
              kind: 'runtime_config',
              diagnostics: [
                {
                  severity: 'error',
                  message: 'Runtime filler prompt reference is archived',
                },
              ],
            },
          ],
        }),
        { status: 409 },
      );

      try {
        await handleResponse(response);
        expect.unreachable('Expected handleResponse to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(
          'Export blocked because the project working copy has validation errors.',
        );
        expect(error).toMatchObject({
          cause: {
            issues: [
              {
                kind: 'runtime_config',
                diagnostics: [
                  {
                    severity: 'error',
                    message: 'Runtime filler prompt reference is archived',
                  },
                ],
              },
            ],
          },
        });
      }
    });
  });
});

// ===========================================================================
// auth.ts
// ===========================================================================

describe('auth', () => {
  function makeNextRequest(authHeader?: string, cookies?: Record<string, string>): NextRequest {
    const headers = new Headers();
    if (authHeader) {
      headers.set('authorization', authHeader);
    }
    const url = 'http://localhost:3000/api/test';
    const req = new NextRequest(url, { headers });
    // Set cookies if provided
    if (cookies) {
      for (const [name, value] of Object.entries(cookies)) {
        req.cookies.set(name, value);
      }
    }
    return req;
  }

  describe('getAuthenticatedUser', () => {
    it('should return null when no authorization header', async () => {
      const { getAuthenticatedUser } = await import('../lib/auth');
      const request = makeNextRequest();
      const result = await getAuthenticatedUser(request);
      expect(result).toBeNull();
    });

    it('should return null when authorization header does not start with Bearer', async () => {
      const { getAuthenticatedUser } = await import('../lib/auth');
      const request = makeNextRequest('Basic abc123');
      const result = await getAuthenticatedUser(request);
      expect(result).toBeNull();
    });

    it('should return null when token verification fails', async () => {
      mockVerifyAccessToken.mockReturnValue(null);
      const { getAuthenticatedUser } = await import('../lib/auth');
      const request = makeNextRequest('Bearer invalid-token');
      const result = await getAuthenticatedUser(request);
      expect(result).toBeNull();
    });

    it('should return null when user is not found in database', async () => {
      mockVerifyAccessToken.mockReturnValue({ sub: 'user-1', tenantId: 'tenant-1' });
      mockFindUserById.mockResolvedValue(null);
      const { getAuthenticatedUser } = await import('../lib/auth');
      const request = makeNextRequest('Bearer valid-token');
      const result = await getAuthenticatedUser(request);
      expect(result).toBeNull();
    });

    it('should return authenticated user on success', async () => {
      mockVerifyAccessToken.mockReturnValue({
        sub: 'user-1',
        tenantId: 'tenant-1',
        role: 'admin',
      });
      mockFindUserById.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
        name: 'Test User',
      });
      mockFindTenantMembership.mockResolvedValue({
        tenantId: 'tenant-1',
        role: 'ADMIN',
      });

      const { getAuthenticatedUser } = await import('../lib/auth');
      const request = makeNextRequest('Bearer valid-token');
      const result = await getAuthenticatedUser(request);

      expect(result).toEqual({
        id: 'user-1',
        email: 'test@example.com',
        name: 'Test User',
        tenantId: 'tenant-1',
        role: 'ADMIN',
        permissions: expect.any(Array),
      });
    });

    it('should strip stale tenant context when the membership is no longer active', async () => {
      mockVerifyAccessToken.mockReturnValue({
        sub: 'user-1',
        tenantId: 'tenant-archived',
        role: 'OWNER',
      });
      mockFindUserById.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
        name: 'Test User',
      });
      mockFindTenantMembership.mockResolvedValue(null);

      const { getAuthenticatedUser } = await import('../lib/auth');
      const request = makeNextRequest('Bearer valid-token');
      const result = await getAuthenticatedUser(request);

      expect(result).toEqual({
        id: 'user-1',
        email: 'test@example.com',
        name: 'Test User',
        tenantId: undefined,
        role: undefined,
        permissions: [],
      });
      expect(mockResolveUserTenantContext).not.toHaveBeenCalled();
    });

    it('should resolve active tenant context only when the JWT has no tenantId', async () => {
      mockVerifyAccessToken.mockReturnValue({
        sub: 'user-1',
      });
      mockFindUserById.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
        name: 'Test User',
      });
      mockResolveUserTenantContext.mockResolvedValue({
        tenantId: 'tenant-2',
        role: 'MEMBER',
      });

      const { getAuthenticatedUser } = await import('../lib/auth');
      const request = makeNextRequest('Bearer valid-token');
      const result = await getAuthenticatedUser(request);

      expect(result).toEqual({
        id: 'user-1',
        email: 'test@example.com',
        name: 'Test User',
        tenantId: 'tenant-2',
        role: 'MEMBER',
        permissions: expect.any(Array),
      });
      expect(mockFindTenantMembership).not.toHaveBeenCalled();
    });

    it('should extract token from Bearer prefix correctly', async () => {
      mockVerifyAccessToken.mockReturnValue(null);
      const { getAuthenticatedUser } = await import('../lib/auth');
      const request = makeNextRequest('Bearer my-jwt-token');
      await getAuthenticatedUser(request);
      expect(mockVerifyAccessToken).toHaveBeenCalledWith('my-jwt-token');
    });
  });

  describe('requireAuth', () => {
    it('should return 401 response when not authenticated', async () => {
      const { requireAuth, isAuthError } = await import('../lib/auth');
      const request = makeNextRequest();
      const result = await requireAuth(request);
      expect(isAuthError(result)).toBe(true);
      expect((result as NextResponse).status).toBe(401);
    });

    it('should return user when authenticated', async () => {
      mockVerifyAccessToken.mockReturnValue({ sub: 'user-1', tenantId: 'tenant-1' });
      mockFindUserById.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
        name: 'Test User',
      });

      const { requireAuth, isAuthError } = await import('../lib/auth');
      const request = makeNextRequest('Bearer valid-token');
      const result = await requireAuth(request);

      expect(isAuthError(result)).toBe(false);
      expect(result).toHaveProperty('id', 'user-1');
    });
  });

  describe('requireAuthOrMFAPending', () => {
    it('should strip stale tenant context from MFA-pending tokens', async () => {
      mockVerifyAccessToken.mockReturnValue(null);
      mockFindUserById.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
        name: 'Test User',
      });
      mockFindTenantMembership.mockResolvedValue(null);

      const mfaPendingToken = jwt.sign(
        {
          sub: 'user-1',
          email: 'test@example.com',
          type: 'mfa_pending',
          tenantId: 'tenant-archived',
          role: 'OWNER',
        },
        'test-secret',
      );

      const { requireAuthOrMFAPending } = await import('../lib/auth');
      const request = makeNextRequest(`Bearer ${mfaPendingToken}`);
      const result = await requireAuthOrMFAPending(request);

      expect(result instanceof NextResponse).toBe(false);
      expect(result).toEqual({
        id: 'user-1',
        email: 'test@example.com',
        name: 'Test User',
        tenantId: undefined,
        role: undefined,
        permissions: [],
      });
      expect(mockFindTenantMembership).toHaveBeenCalledWith('user-1', 'tenant-archived');
      expect(mockResolveUserTenantContext).not.toHaveBeenCalled();
    });
  });

  describe('isAuthError', () => {
    it('should return true for NextResponse', async () => {
      const { isAuthError } = await import('../lib/auth');
      const response = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      expect(isAuthError(response)).toBe(true);
    });

    it('should return false for user object', async () => {
      const { isAuthError } = await import('../lib/auth');
      const user = { id: '1', email: 'test@test.com', name: 'Test', permissions: [] };
      expect(isAuthError(user)).toBe(false);
    });
  });
});

// ===========================================================================
// rate-limit.ts
// ===========================================================================

describe('rate-limit', () => {
  describe('checkRateLimit', () => {
    it('should allow first request', async () => {
      const { checkRateLimit } = await import('../lib/rate-limit');
      const result = await checkRateLimit('test-key-new-1', 5, 60000);
      expect(result.allowed).toBe(true);
    });

    it('should allow requests under the limit', async () => {
      const { checkRateLimit } = await import('../lib/rate-limit');
      const key = 'test-key-under-limit';

      for (let i = 0; i < 4; i++) {
        const result = await checkRateLimit(key, 5, 60000);
        expect(result.allowed).toBe(true);
      }
    });

    it('should deny requests at the limit', async () => {
      const { checkRateLimit } = await import('../lib/rate-limit');
      const key = 'test-key-at-limit';

      // Consume all 5 attempts
      for (let i = 0; i < 5; i++) {
        await checkRateLimit(key, 5, 60000);
      }

      const result = await checkRateLimit(key, 5, 60000);
      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeDefined();
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it('should reset after window expires', async () => {
      const { checkRateLimit } = await import('../lib/rate-limit');
      const key = 'test-key-expired-window';

      // Use a very short window
      const result1 = await checkRateLimit(key, 1, 1); // 1ms window
      expect(result1.allowed).toBe(true);

      // Wait for window to expire
      await new Promise((resolve) => setTimeout(resolve, 10));

      const result2 = await checkRateLimit(key, 1, 1);
      expect(result2.allowed).toBe(true);
    });

    it('should track different keys independently', async () => {
      const { checkRateLimit } = await import('../lib/rate-limit');

      // Exhaust key A
      await checkRateLimit('key-a-independent', 1, 60000);
      const resultA = await checkRateLimit('key-a-independent', 1, 60000);
      expect(resultA.allowed).toBe(false);

      // Key B should still be allowed
      const resultB = await checkRateLimit('key-b-independent', 1, 60000);
      expect(resultB.allowed).toBe(true);
    });

    it('should return retryAfter in seconds', async () => {
      const { checkRateLimit } = await import('../lib/rate-limit');
      const key = 'test-retry-after-val';
      const windowMs = 30000;

      await checkRateLimit(key, 1, windowMs);
      const result = await checkRateLimit(key, 1, windowMs);

      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeDefined();
      // retryAfter should be roughly windowMs/1000 (within tolerance)
      expect(result.retryAfter!).toBeLessThanOrEqual(31);
      expect(result.retryAfter!).toBeGreaterThan(0);
    });

    it('should increment count on successive calls within window', async () => {
      const { checkRateLimit } = await import('../lib/rate-limit');
      const key = 'test-increment-count';

      // First call (count=1)
      await checkRateLimit(key, 3, 60000);
      // Second call (count=2)
      await checkRateLimit(key, 3, 60000);
      // Third call (count=3)
      await checkRateLimit(key, 3, 60000);
      // Fourth call should be denied
      const result = await checkRateLimit(key, 3, 60000);
      expect(result.allowed).toBe(false);
    });
  });
});

// ===========================================================================
// runtime-proxy.ts
// ===========================================================================

describe('runtime-proxy', () => {
  describe('buildRuntimeProxyHeaders', () => {
    it('should build headers with Content-Type, Authorization, and X-Tenant-Id', async () => {
      const { buildRuntimeProxyHeaders } = await import('../lib/runtime-proxy');
      const request = new NextRequest('http://localhost:3000/api/proxy', {
        headers: { Authorization: 'Bearer my-token' },
      });

      const headers = buildRuntimeProxyHeaders(request, 'tenant-xyz');

      expect(headers).toEqual({
        'Content-Type': 'application/json',
        Authorization: 'Bearer my-token',
        'X-Tenant-Id': 'tenant-xyz',
      });
    });

    it('should omit Authorization when not present in request', async () => {
      const { buildRuntimeProxyHeaders } = await import('../lib/runtime-proxy');
      const request = new NextRequest('http://localhost:3000/api/proxy');

      const headers = buildRuntimeProxyHeaders(request, 'tenant-xyz');

      expect(headers).toEqual({
        'Content-Type': 'application/json',
        'X-Tenant-Id': 'tenant-xyz',
      });
    });

    it('should always include Content-Type', async () => {
      const { buildRuntimeProxyHeaders } = await import('../lib/runtime-proxy');
      const request = new NextRequest('http://localhost:3000/api/proxy');

      const headers = buildRuntimeProxyHeaders(request, 'any-tenant');

      expect(headers['Content-Type']).toBe('application/json');
    });
  });

  describe('proxyToRuntime', () => {
    it('should throw when options with tenantId are not provided', async () => {
      const { proxyToRuntime } = await import('../lib/runtime-proxy');
      const request = new NextRequest('http://localhost:3000/api/test');

      // tenantId is required in options — calling without options throws
      await expect(
        proxyToRuntime(request, '/api/data', undefined as unknown as { tenantId: string }),
      ).rejects.toThrow();
    });

    it('should use tenantId from options', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ result: 'ok' }), { status: 200 }),
      );
      const { proxyToRuntime } = await import('../lib/runtime-proxy');
      const request = new NextRequest('http://localhost:3000/api/test');

      await proxyToRuntime(request, '/api/data', { tenantId: 'tenant-from-options' });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/data'),
        expect.objectContaining({
          headers: expect.objectContaining({ 'X-Tenant-Id': 'tenant-from-options' }),
        }),
      );
    });

    it('should use tenantId from options when provided', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ result: 'ok' }), { status: 200 }),
      );
      const { proxyToRuntime } = await import('../lib/runtime-proxy');
      const request = new NextRequest('http://localhost:3000/api/test');

      await proxyToRuntime(request, '/api/data', { tenantId: 'option-tenant' });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/data'),
        expect.objectContaining({
          headers: expect.objectContaining({ 'X-Tenant-Id': 'option-tenant' }),
        }),
      );
    });

    it('should forward response status from runtime', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Not Found' }), { status: 404 }),
      );
      const { proxyToRuntime } = await import('../lib/runtime-proxy');
      const request = new NextRequest('http://localhost:3000/api/test');

      const result = await proxyToRuntime(request, '/api/missing', { tenantId: 'tenant-1' });

      expect(result.status).toBe(404);
    });

    it('should use the request method by default', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
      const { proxyToRuntime } = await import('../lib/runtime-proxy');
      const request = new NextRequest('http://localhost:3000/api/test', { method: 'DELETE' });

      await proxyToRuntime(request, '/api/resource', { tenantId: 'tenant-1' });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    it('should override method when specified in options', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
      const { proxyToRuntime } = await import('../lib/runtime-proxy');
      const request = new NextRequest('http://localhost:3000/api/test', { method: 'GET' });

      await proxyToRuntime(request, '/api/resource', { tenantId: 'tenant-1', method: 'POST' });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('should serialize body when provided', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
      const { proxyToRuntime } = await import('../lib/runtime-proxy');
      const request = new NextRequest('http://localhost:3000/api/test');

      await proxyToRuntime(request, '/api/resource', {
        tenantId: 'tenant-1',
        method: 'POST',
        body: { key: 'value' },
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ body: JSON.stringify({ key: 'value' }) }),
      );
    });

    it('should construct URL with RUNTIME_URL base', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
      const { proxyToRuntime } = await import('../lib/runtime-proxy');
      const request = new NextRequest('http://localhost:3000/api/test');

      await proxyToRuntime(request, '/api/sessions', { tenantId: 'tenant-1' });

      // Default RUNTIME_URL is http://localhost:3112
      const calledUrl = mockFetch.mock.calls[0][0];
      expect(calledUrl).toContain('/api/sessions');
    });

    it('should return JSON response data from runtime', async () => {
      const runtimeData = { sessions: [{ id: 's1' }] };
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(runtimeData), { status: 200 }));
      const { proxyToRuntime } = await import('../lib/runtime-proxy');
      const request = new NextRequest('http://localhost:3000/api/test');

      const result = await proxyToRuntime(request, '/api/sessions', { tenantId: 'tenant-1' });
      const body = await result.json();

      expect(body).toEqual(runtimeData);
    });
  });
});

// ===========================================================================
// token-hash.ts
// ===========================================================================

describe('token-hash', () => {
  describe('hashToken', () => {
    it('should return a hex string', async () => {
      const { hashToken } = await import('../lib/token-hash');
      const result = hashToken('test-token');
      expect(result).toMatch(/^[0-9a-f]+$/);
    });

    it('should return a 64-character SHA-256 hex digest', async () => {
      const { hashToken } = await import('../lib/token-hash');
      const result = hashToken('any-token');
      expect(result).toHaveLength(64);
    });

    it('should produce consistent output for same input', async () => {
      const { hashToken } = await import('../lib/token-hash');
      const hash1 = hashToken('same-token');
      const hash2 = hashToken('same-token');
      expect(hash1).toBe(hash2);
    });

    it('should produce different output for different inputs', async () => {
      const { hashToken } = await import('../lib/token-hash');
      const hash1 = hashToken('token-a');
      const hash2 = hashToken('token-b');
      expect(hash1).not.toBe(hash2);
    });

    it('should handle empty string', async () => {
      const { hashToken } = await import('../lib/token-hash');
      const result = hashToken('');
      expect(result).toHaveLength(64);
      expect(result).toMatch(/^[0-9a-f]+$/);
    });

    it('should handle long tokens', async () => {
      const { hashToken } = await import('../lib/token-hash');
      const longToken = 'x'.repeat(10000);
      const result = hashToken(longToken);
      expect(result).toHaveLength(64);
    });

    it('should match known SHA-256 hash for "test"', async () => {
      const { hashToken } = await import('../lib/token-hash');
      // SHA-256 of "test" = 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
      const result = hashToken('test');
      expect(result).toBe('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08');
    });
  });
});

// ===========================================================================
// swr-config.ts
// ===========================================================================

describe('swr-config', () => {
  describe('swrConfig', () => {
    it('should export default SWR configuration', async () => {
      const { swrConfig } = await import('../lib/swr-config');
      expect(swrConfig.dedupingInterval).toBe(5000);
      expect(swrConfig.revalidateOnFocus).toBe(true);
      expect(swrConfig.errorRetryCount).toBe(2);
      expect(swrConfig.shouldRetryOnError).toBe(true);
      expect(swrConfig.revalidateOnReconnect).toBe(true);
    });

    it('should have a fetcher configured', async () => {
      const { swrConfig } = await import('../lib/swr-config');
      expect(swrConfig.fetcher).toBeDefined();
      expect(typeof swrConfig.fetcher).toBe('function');
    });
  });

  describe('swrFetcher', () => {
    it('should return parsed JSON for successful responses', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [1, 2, 3] }), { status: 200 }),
      );
      const { swrFetcher } = await import('../lib/swr-config');

      const result = await swrFetcher('/api/items');
      expect(result).toEqual({ data: [1, 2, 3] });
    });

    it('should throw on non-ok responses', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }),
      );
      const { swrFetcher } = await import('../lib/swr-config');

      await expectRejectedMessage(swrFetcher('/api/secret'), 'Forbidden');
    });

    it('should throw fallback error when response body parsing fails', async () => {
      mockFetch.mockResolvedValueOnce(new Response('not json', { status: 500 }));
      const { swrFetcher } = await import('../lib/swr-config');

      await expectRejectedMessage(swrFetcher('/api/broken'), "Couldn't load data");
    });
  });
});
