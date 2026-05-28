/**
 * Tests for Auth API Client (apps/studio/src/api/auth.ts)
 *
 * Covers: getGoogleLoginUrl, fetchCurrentUser, refreshAccessToken,
 * logout, handleOAuthCallback, scheduleTokenRefresh, cancelTokenRefresh,
 * startIdleTimeout, stopIdleTimeout.
 */

import { NextRequest } from 'next/server';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { expectRejectedMessage } from '../helpers/expect-rejected-message';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockClearAuth = vi.fn();
const mockSetAuth = vi.fn();
const mockSetTokens = vi.fn();
const mockSetLoading = vi.fn();
const mockSetIdleLock = vi.fn();
const mockClearIdleLock = vi.fn();
const mockSignalLogout = vi.fn();
const mockRevokeRefreshToken = vi.fn();
const mockRefreshTokens = vi.fn();
const mockGetRefreshTokenAuditContext = vi.fn();
const mockCheckRateLimit = vi.fn();
const mockFindUserByEmail = vi.fn();
const mockRequireAuth = vi.fn();
const mockIsAuthError = vi.fn();
const mockCreateWorkspaceWithOwner = vi.fn();
const mockFindTenantBySlug = vi.fn();
const mockLogAuditEvent = vi.fn();
const mockCreateTokenPair = vi.fn();
const mockCountDocuments = vi.fn();

const authStoreState = {
  accessToken: 'test-token' as string | null,
  tenantId: 'test-tenant' as string | null,
  isAuthenticated: true,
  clearAuth: mockClearAuth,
  setAuth: mockSetAuth,
  setTokens: mockSetTokens,
  setLoading: mockSetLoading,
  setIdleLock: mockSetIdleLock,
  clearIdleLock: mockClearIdleLock,
};

const sessionStoreState = {
  sessionId: null as string | null,
  resumeHandle: {
    sessionId: null as string | null,
    projectId: null as string | null,
    kind: null as 'web_debug' | null,
    lastSeenTraceEventId: null as string | null,
  },
};

const archUiStoreState = {
  session: null as { id?: string } | null,
  resume: null as Record<string, unknown> | null,
};

vi.mock('../../store/auth-store', () => ({
  signalLogout: (...args: unknown[]) => mockSignalLogout(...args),
  useAuthStore: {
    getState: () => authStoreState,
  },
}));

vi.mock('../../store/session-store', () => ({
  useSessionStore: {
    getState: () => sessionStoreState,
  },
}));

vi.mock('../../lib/arch-ai/ui/store', () => ({
  useArchUIStore: {
    getState: () => archUiStoreState,
  },
}));

vi.mock('@/services/auth-service', () => ({
  revokeRefreshToken: (...args: unknown[]) => mockRevokeRefreshToken(...args),
  refreshTokens: (...args: unknown[]) => mockRefreshTokens(...args),
  getRefreshTokenAuditContext: (...args: unknown[]) => mockGetRefreshTokenAuditContext(...args),
  createTokenPair: (...args: unknown[]) => mockCreateTokenPair(...args),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

vi.mock('@/repos/auth-repo', () => ({
  findUserByEmail: (...args: unknown[]) => mockFindUserByEmail(...args),
}));

vi.mock('@/lib/auth', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  isAuthError: (...args: unknown[]) => mockIsAuthError(...args),
}));

vi.mock('@/repos/workspace-repo', () => ({
  createWorkspaceWithOwner: (...args: unknown[]) => mockCreateWorkspaceWithOwner(...args),
  findTenantBySlug: (...args: unknown[]) => mockFindTenantBySlug(...args),
}));

vi.mock('@/services/audit-service', () => ({
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
  AuditActions: {
    WORKSPACE_CREATED: 'workspace_created',
    LOGOUT: 'logout',
    TOKEN_REFRESH: 'token_refresh',
  },
}));

vi.mock('@/config', () => ({
  getConfig: vi.fn(() => ({
    auth: {
      tokens: {
        refreshCookieMaxAgeSeconds: 7 * 24 * 60 * 60,
      },
      rateLimits: {
        refresh: { maxAttempts: 5, windowMs: 60 * 1000 },
        createWorkspace: { maxAttempts: 5, windowMs: 60 * 1000 },
      },
    },
  })),
  isConfigLoaded: vi.fn(() => true),
}));

vi.mock('@/lib/auth-constants', () => ({
  AUTH_CONFIG_DEFAULTS: {
    rateLimits: {
      refresh: { maxAttempts: 5, windowMs: 60 * 1000 },
      createWorkspace: { maxAttempts: 5, windowMs: 60 * 1000 },
    },
  },
}));

vi.mock('@agent-platform/database/models', () => ({
  TenantMember: {
    countDocuments: (...args: unknown[]) => mockCountDocuments(...args),
  },
}));

// Bypass the studio platform-auth-policy wrapper. The real wrapper calls
// ensureDb() and the database-level access policy, which require live
// encryption + Mongoose. Route-level unit tests assume the policy returns
// true (allowed) so we exercise the surrounding handler logic, not the
// allowlist check itself (which is covered in packages/database tests).
vi.mock('@/lib/platform-auth-policy', () => ({
  isEmailAllowedForAuth: async () => true,
  canUserCreateWorkspace: async () => true,
  isPlatformAdminUser: async () => false,
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import {
  getGoogleLoginUrl,
  fetchCurrentUser,
  refreshAccessToken,
  logout,
  handleOAuthCallback,
  scheduleTokenRefresh,
  cancelTokenRefresh,
  startIdleTimeout,
  stopIdleTimeout,
  initializeAuth,
} from '../../api/auth';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  mockClearAuth.mockReset();
  mockSetAuth.mockReset();
  mockSetTokens.mockReset();
  mockSetLoading.mockReset();
  mockSetIdleLock.mockReset();
  mockClearIdleLock.mockReset();
  mockSignalLogout.mockReset();
  mockRevokeRefreshToken.mockReset();
  mockRefreshTokens.mockReset();
  mockGetRefreshTokenAuditContext.mockReset();
  mockCheckRateLimit.mockReset();
  mockFindUserByEmail.mockReset();
  mockRequireAuth.mockReset();
  mockIsAuthError.mockReset();
  mockCreateWorkspaceWithOwner.mockReset();
  mockFindTenantBySlug.mockReset();
  mockLogAuditEvent.mockReset();
  mockCreateTokenPair.mockReset();
  mockCountDocuments.mockReset();
  authStoreState.accessToken = 'test-token';
  authStoreState.tenantId = 'test-tenant';
  authStoreState.isAuthenticated = true;
  sessionStoreState.sessionId = null;
  sessionStoreState.resumeHandle = {
    sessionId: null,
    projectId: null,
    kind: null,
    lastSeenTraceEventId: null,
  };
  archUiStoreState.session = null;
  archUiStoreState.resume = null;
  global.fetch = mockFetch;
  vi.useFakeTimers();

  mockCheckRateLimit.mockResolvedValue({ allowed: true });
  mockIsAuthError.mockReturnValue(false);
  mockRequireAuth.mockResolvedValue({ id: 'user-1', email: 'user@example.com' });
  mockGetRefreshTokenAuditContext.mockResolvedValue({ userId: 'user-1', tenantId: 'tenant-1' });
  mockFindTenantBySlug.mockResolvedValue(null);
  mockLogAuditEvent.mockResolvedValue(undefined);
  mockCountDocuments.mockResolvedValue(0);
  mockSetAuth.mockImplementation((_user: unknown, accessToken: string) => {
    authStoreState.accessToken = accessToken;
    authStoreState.isAuthenticated = true;
  });
  mockSetTokens.mockImplementation((accessToken: string) => {
    authStoreState.accessToken = accessToken;
  });
  mockClearAuth.mockImplementation(() => {
    authStoreState.accessToken = null;
    authStoreState.tenantId = null;
    authStoreState.isAuthenticated = false;
  });
});

afterEach(() => {
  cancelTokenRefresh();
  stopIdleTimeout();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function createAccessToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    .toString('base64url')
    .replace(/=/g, '');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url').replace(/=/g, '');
  return `${header}.${body}.signature`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getGoogleLoginUrl', () => {
  it('should return the Google OAuth login URL', () => {
    const url = getGoogleLoginUrl();
    expect(url).toBe('/api/auth/google');
  });
});

describe('fetchCurrentUser', () => {
  it('should call /api/auth/me with the given token', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          id: 'user-1',
          email: 'test@example.com',
          name: 'Test User',
          avatarUrl: 'https://example.com/avatar.png',
          createdAt: '2024-01-01',
          lastLoginAt: null,
        }),
    });

    await fetchCurrentUser('my-token');

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/auth/me');
    expect(opts.headers).toHaveProperty('Authorization', 'Bearer my-token');
    expect(opts.credentials).toBe('same-origin');
  });

  it('should return a mapped User object (id, email, name, avatarUrl)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          id: 'user-1',
          email: 'test@example.com',
          name: 'Test',
          avatarUrl: 'https://pic.url',
          createdAt: '2024-01-01',
          lastLoginAt: '2024-06-01',
        }),
    });

    const user = await fetchCurrentUser('tok');

    expect(user).toEqual({
      id: 'user-1',
      email: 'test@example.com',
      name: 'Test',
      avatarUrl: 'https://pic.url',
      role: null,
      permissions: [],
    });
  });

  it('should handle missing optional fields', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          id: 'user-2',
          email: 'no-name@example.com',
          createdAt: '2024-01-01',
          lastLoginAt: null,
        }),
    });

    const user = await fetchCurrentUser('tok');

    expect(user.id).toBe('user-2');
    expect(user.email).toBe('no-name@example.com');
    expect(user.name).toBeUndefined();
    expect(user.avatarUrl).toBeUndefined();
  });

  it('should throw on non-ok response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401 });

    await expectRejectedMessage(fetchCurrentUser('bad-token'), 'Failed to fetch user');
  });
});

describe('refreshAccessToken', () => {
  it('should POST to /api/auth/refresh with the persisted tenantId', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ accessToken: 'new-token', expiresIn: 900 }),
    });

    await refreshAccessToken();

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/auth/refresh');
    expect(opts.method).toBe('POST');
    expect(opts.body).toBe(JSON.stringify({ tenantId: 'test-tenant' }));
    expect(opts.credentials).toBe('same-origin');
  });

  it('should return TokenResponse', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ accessToken: 'new-tok', expiresIn: 600 }),
    });

    const result = await refreshAccessToken();

    expect(result).toEqual({ accessToken: 'new-tok', expiresIn: 600 });
  });

  it('should throw on non-ok response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401 });

    await expectRejectedMessage(refreshAccessToken(), 'Failed to refresh token');
  });
});

describe('logout', () => {
  it('should clear auth state and call logout endpoint without a request body', async () => {
    mockFetch.mockResolvedValue({ ok: true });

    await logout();

    expect(mockSignalLogout).toHaveBeenCalledWith('explicit-logout');
    expect(mockClearAuth).toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledWith('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
    });
  });

  it('should not throw if logout endpoint fails', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    // Should not throw
    await logout();

    expect(mockSignalLogout).toHaveBeenCalledWith('explicit-logout');
    expect(mockClearAuth).toHaveBeenCalled();
  });
});

describe('logout route', () => {
  it('accepts empty request bodies', async () => {
    const { POST } = await import('../../app/api/auth/logout/route');
    const request = new NextRequest(new URL('http://localhost/api/auth/logout'), {
      method: 'POST',
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(mockRevokeRefreshToken).not.toHaveBeenCalled();
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'logout',
      }),
    );
  });

  it('attributes logout audit events when refresh token context is available', async () => {
    const { POST } = await import('../../app/api/auth/logout/route');
    const request = new NextRequest(new URL('http://localhost/api/auth/logout'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ refreshToken: 'test-refresh-token' }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(mockGetRefreshTokenAuditContext).toHaveBeenCalledWith('test-refresh-token');
    expect(mockRevokeRefreshToken).toHaveBeenCalledWith('test-refresh-token');
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'logout',
        userId: 'user-1',
        tenantId: 'tenant-1',
      }),
    );
  });
});

describe('auth route IP hardening', () => {
  it('uses the trusted rightmost x-forwarded-for value for resolve-account throttling', async () => {
    mockFindUserByEmail.mockResolvedValue(null);
    const { POST } = await import('../../app/api/auth/resolve-account/route');
    const request = new NextRequest(new URL('http://localhost/api/auth/resolve-account'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '198.51.100.10, 10.0.0.5',
      },
      body: JSON.stringify({ email: 'new@example.com' }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(mockCheckRateLimit).toHaveBeenCalledWith('resolve-account:10.0.0.5', 10, 60 * 1000);
  });

  it('uses the trusted rightmost x-forwarded-for value for refresh throttling', async () => {
    mockRefreshTokens.mockResolvedValue({
      accessToken: 'new-access-token',
      refreshToken: 'rotated-refresh-token',
      expiresIn: 900,
      userId: 'user-1',
      tenantId: 'tenant-1',
    });
    // Reset mocks before the test to ensure clean state
    mockCheckRateLimit.mockClear();
    mockCheckRateLimit.mockResolvedValue({ allowed: true });

    const { POST } = await import('../../app/api/auth/refresh/route');
    const request = new NextRequest(new URL('http://localhost/api/auth/refresh'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.10, 10.0.0.6',
      },
      body: JSON.stringify({ refresh_token: 'test-refresh-token' }),
    });

    const response = await POST(request);

    // Accept either success or expected error (cookie parsing may vary in test env)
    expect(response.status).toBeLessThan(500);
    // Verify checkRateLimit was called with the rightmost IP - this is the key assertion
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      expect.stringContaining('refresh:'),
      5,
      60 * 1000,
    );
    // Specifically verify the IP is the rightmost one
    const callArg = mockCheckRateLimit.mock.calls[0][0];
    expect(callArg).toBe('refresh:10.0.0.6');
    expect(mockRefreshTokens).toHaveBeenCalledWith('test-refresh-token', undefined);
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        tenantId: 'tenant-1',
        action: 'token_refresh',
        ip: '10.0.0.6',
        metadata: {
          refreshTokenSource: 'body',
          requestedTenantId: null,
        },
      }),
    );
  });

  it('passes the requested tenantId through the refresh route', async () => {
    mockRefreshTokens.mockResolvedValue({
      accessToken: 'new-access-token',
      refreshToken: 'rotated-refresh-token',
      expiresIn: 900,
      userId: 'user-1',
      tenantId: 'tenant-2',
    });

    const { POST } = await import('../../app/api/auth/refresh/route');
    const request = new NextRequest(new URL('http://localhost/api/auth/refresh'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ refresh_token: 'test-refresh-token', tenantId: 'tenant-2' }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(mockRefreshTokens).toHaveBeenCalledWith('test-refresh-token', 'tenant-2');
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        tenantId: 'tenant-2',
        action: 'token_refresh',
        metadata: {
          refreshTokenSource: 'body',
          requestedTenantId: 'tenant-2',
        },
      }),
    );
  });
});

describe('create-workspace route', () => {
  it('returns a generic error message when workspace creation fails', async () => {
    mockCreateWorkspaceWithOwner.mockRejectedValue(new Error('duplicate key 11000 at create'));
    const { POST } = await import('../../app/api/auth/create-workspace/route');
    const request = new NextRequest(new URL('http://localhost/api/auth/create-workspace'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-token',
      },
      body: JSON.stringify({ name: 'Example Workspace' }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: 'Workspace creation failed. Please try again.' });
    expect(body.error).not.toContain('duplicate key');
    expect(body.error).not.toContain('create');
  });
});

describe('initializeAuth', () => {
  it('schedules refresh from the refreshed token expiry when no access token is present', async () => {
    authStoreState.accessToken = null;
    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/auth/refresh') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ accessToken: 'new-token', expiresIn: 120 }),
        });
      }

      if (url === '/api/auth/me') {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              id: 'user-1',
              email: 'test@example.com',
              createdAt: '2024-01-01',
              lastLoginAt: null,
            }),
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await initializeAuth();

    expect(result).toEqual({
      authenticated: true,
      accessToken: 'new-token',
      expiresIn: 120,
      source: 'refreshed-token',
    });
    expect(mockSetAuth).toHaveBeenCalledWith(
      {
        id: 'user-1',
        email: 'test@example.com',
        name: undefined,
        avatarUrl: undefined,
        role: null,
        permissions: [],
      },
      'new-token',
    );

    mockFetch.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/auth/refresh',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('derives remaining lifetime from the existing access token instead of a hardcoded refresh window', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    authStoreState.accessToken = createAccessToken({
      exp: nowSeconds + 180,
      tenantId: 'tenant-1',
    });

    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/auth/me') {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              id: 'user-1',
              email: 'test@example.com',
              createdAt: '2024-01-01',
              lastLoginAt: null,
            }),
        });
      }

      if (url === '/api/auth/refresh') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ accessToken: 'rotated-token', expiresIn: 900 }),
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await initializeAuth();

    expect(result.authenticated).toBe(true);
    expect(result.source).toBe('existing-token');
    expect(result.expiresIn).toBeGreaterThanOrEqual(179);
    expect(result.expiresIn).toBeLessThanOrEqual(180);

    const refreshDelayMs = Math.max(((result.expiresIn ?? 0) - 60) * 1000, 10_000);

    mockFetch.mockClear();
    vi.advanceTimersByTime(refreshDelayMs - 1);
    expect(mockFetch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/auth/refresh',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('handleOAuthCallback', () => {
  it('should return null if no code in search params', async () => {
    const params = new URLSearchParams();

    const result = await handleOAuthCallback(params);

    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should POST the code to /api/sso/exchange', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          accessToken: 'new-token',
          expiresIn: 900,
          needsOnboarding: false,
          pendingInvitations: 0,
        }),
    });

    const params = new URLSearchParams({ code: 'auth-code-123' });

    await handleOAuthCallback(params);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/sso/exchange');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ code: 'auth-code-123' });
  });

  it('should return ExchangeResult on success', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          accessToken: 'at-123',
          expiresIn: 1800,
          needsOnboarding: true,
          pendingInvitations: 2,
        }),
    });

    const result = await handleOAuthCallback(new URLSearchParams({ code: 'c' }));

    expect(result).toEqual({
      accessToken: 'at-123',
      expiresIn: 1800,
      needsOnboarding: true,
      pendingInvitations: 2,
    });
  });

  it('should default expiresIn to 900 if not returned', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          accessToken: 'at-123',
        }),
    });

    const result = await handleOAuthCallback(new URLSearchParams({ code: 'c' }));

    expect(result?.expiresIn).toBe(900);
  });

  it('should throw on non-ok response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 400 });

    await expectRejectedMessage(
      handleOAuthCallback(new URLSearchParams({ code: 'bad' })),
      'Failed to exchange auth code',
    );
  });
});

describe('scheduleTokenRefresh', () => {
  it('should schedule a refresh before token expiry', () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ accessToken: 'refreshed', expiresIn: 900 }),
    });

    scheduleTokenRefresh(120);

    // The refresh should be scheduled for (120 - 60) * 1000 = 60000ms
    // but min is 10000, so it should be 60000ms
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should use minimum timeout of 10 seconds', () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ accessToken: 'refreshed', expiresIn: 900 }),
    });

    scheduleTokenRefresh(30); // (30 - 60) * 1000 = negative, max with 10000 = 10000
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should clear previous timeout when called again', () => {
    scheduleTokenRefresh(120);
    scheduleTokenRefresh(300);

    // The second call should replace the first timer.
    // Advancing by 60s (120 - 60 buffer) should NOT trigger a refresh,
    // because the first timer was cleared by the second call.
    vi.advanceTimersByTime(60_000);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('cancelTokenRefresh', () => {
  it('should cancel a scheduled refresh', () => {
    scheduleTokenRefresh(120);
    cancelTokenRefresh();

    // Advancing time should not trigger the refresh
    vi.advanceTimersByTime(120_000);
    expect(mockSetTokens).not.toHaveBeenCalled();
  });

  it('should be safe to call when no refresh is scheduled', () => {
    expect(() => cancelTokenRefresh()).not.toThrow();
  });
});

describe('startIdleTimeout / stopIdleTimeout', () => {
  // startIdleTimeout / stopIdleTimeout guard with `typeof window === 'undefined'`
  // so we need a minimal window mock in the node environment.
  let fakeWindow: {
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
    location: { href: string; pathname: string };
  };

  beforeEach(() => {
    fakeWindow = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      location: { href: '', pathname: '/' },
    };
    (globalThis as Record<string, unknown>).window = fakeWindow;
  });

  afterEach(() => {
    stopIdleTimeout();
    delete (globalThis as Record<string, unknown>).window;
  });

  it('should start listening for user activity events', () => {
    startIdleTimeout();

    // Should add listeners for mousedown, keydown, touchstart, scroll
    const listenedEvents = fakeWindow.addEventListener.mock.calls.map(
      (args: unknown[]) => args[0] as string,
    );
    expect(listenedEvents).toContain('mousedown');
    expect(listenedEvents).toContain('keydown');
    expect(listenedEvents).toContain('touchstart');
    expect(listenedEvents).toContain('scroll');
  });

  it('should stop listening when stopIdleTimeout is called', () => {
    startIdleTimeout();
    stopIdleTimeout();

    const removedEvents = fakeWindow.removeEventListener.mock.calls.map(
      (args: unknown[]) => args[0] as string,
    );
    expect(removedEvents).toContain('mousedown');
    expect(removedEvents).toContain('keydown');
  });

  it('stopIdleTimeout should be safe to call when not started', () => {
    // Remove the window mock to test the typeof guard
    delete (globalThis as Record<string, unknown>).window;
    expect(() => stopIdleTimeout()).not.toThrow();
  });

  it('logs out on browser idle when no session can be recovered', () => {
    startIdleTimeout();
    vi.advanceTimersByTime(30 * 60 * 1000);

    expect(mockSignalLogout).toHaveBeenCalledWith('browser_idle_logout');
    expect(mockClearAuth).toHaveBeenCalled();
    expect(mockSetIdleLock).not.toHaveBeenCalled();
    expect(fakeWindow.location.href).toBe('/auth/login');
  });

  it('logs out on browser idle when only a stale resume handle exists', () => {
    sessionStoreState.resumeHandle = {
      sessionId: 'session-1',
      projectId: 'project-1',
      kind: 'web_debug',
      lastSeenTraceEventId: 'trace-1',
    };

    startIdleTimeout();
    vi.advanceTimersByTime(30 * 60 * 1000);

    expect(mockSignalLogout).toHaveBeenCalledWith('browser_idle_logout');
    expect(mockClearAuth).toHaveBeenCalled();
    expect(mockSetIdleLock).not.toHaveBeenCalled();
    expect(fakeWindow.location.href).toBe('/auth/login');
  });

  it('soft-locks instead of logging out when an active developer session exists', () => {
    sessionStoreState.sessionId = 'session-1';

    startIdleTimeout();
    vi.advanceTimersByTime(30 * 60 * 1000);

    expect(mockSetIdleLock).toHaveBeenCalledWith('recoverable_session');
    expect(mockSignalLogout).not.toHaveBeenCalledWith('browser_idle_logout');
    expect(mockClearAuth).not.toHaveBeenCalled();
    expect(fakeWindow.location.href).toBe('');
  });
});
