import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';
import { PLATFORM_SUPER_ADMIN_REQUIRED_MESSAGE } from '../lib/studio-admin-auth.js';

const mockFetch = vi.fn();
const TEST_JWT_SECRET = 'admin-auth-test-secret';
const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;
const ORIGINAL_FRONTEND_URL = process.env.FRONTEND_URL;
const ORIGINAL_NEXT_PUBLIC_APP_URL = process.env.NEXT_PUBLIC_APP_URL;
const ORIGINAL_STUDIO_API_URL = process.env.STUDIO_API_URL;
const ORIGINAL_STUDIO_BROWSER_URL = process.env.NEXT_PUBLIC_STUDIO_URL;
const ORIGINAL_STUDIO_URL = process.env.STUDIO_URL;

function makeRequest(path: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost:3003${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

function makeGetRequest(path: string): NextRequest {
  return new NextRequest(`http://localhost:3003${path}`, {
    method: 'GET',
  });
}

async function createAccessToken(
  overrides: {
    email?: string;
    role?: string;
    isSuperAdmin?: boolean;
  } = {},
): Promise<string> {
  return new SignJWT({
    email: overrides.email ?? 'admin@example.com',
    role: overrides.role,
    isSuperAdmin: overrides.isSuperAdmin ?? false,
    type: 'access',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('admin-user-001')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(TEST_JWT_SECRET));
}

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  delete process.env.FRONTEND_URL;
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.STUDIO_API_URL;
  delete process.env.NEXT_PUBLIC_STUDIO_URL;
  delete process.env.STUDIO_URL;
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (ORIGINAL_JWT_SECRET === undefined) {
    delete process.env.JWT_SECRET;
  } else {
    process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
  }

  if (ORIGINAL_FRONTEND_URL === undefined) {
    delete process.env.FRONTEND_URL;
  } else {
    process.env.FRONTEND_URL = ORIGINAL_FRONTEND_URL;
  }

  if (ORIGINAL_NEXT_PUBLIC_APP_URL === undefined) {
    delete process.env.NEXT_PUBLIC_APP_URL;
  } else {
    process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_NEXT_PUBLIC_APP_URL;
  }

  if (ORIGINAL_STUDIO_API_URL === undefined) {
    delete process.env.STUDIO_API_URL;
  } else {
    process.env.STUDIO_API_URL = ORIGINAL_STUDIO_API_URL;
  }

  if (ORIGINAL_STUDIO_BROWSER_URL === undefined) {
    delete process.env.NEXT_PUBLIC_STUDIO_URL;
  } else {
    process.env.NEXT_PUBLIC_STUDIO_URL = ORIGINAL_STUDIO_BROWSER_URL;
  }

  if (ORIGINAL_STUDIO_URL === undefined) {
    delete process.env.STUDIO_URL;
  } else {
    process.env.STUDIO_URL = ORIGINAL_STUDIO_URL;
  }
});

describe('Admin auth routes', () => {
  test('password login creates an admin session for a super admin', async () => {
    const { POST } = await import('../app/api/auth/login/route.js');
    const accessToken = await createAccessToken({ isSuperAdmin: true });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        accessToken,
        user: { id: 'super-admin-001', email: 'superadmin@example.com' },
      }),
    });

    const response = await POST(
      makeRequest('/api/auth/login', {
        email: 'superadmin@example.com',
        password: 'correct horse battery staple',
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      user: { id: 'super-admin-001', email: 'superadmin@example.com' },
      role: 'SUPER_ADMIN',
      isSuperAdmin: true,
    });
    expect(response.cookies.get('admin-session')?.value).toBe(accessToken);
    expect(response.cookies.get('admin-session')?.sameSite).toBe('lax');
    expect(response.cookies.get('admin-last-activity')?.value).toBeTruthy();
    expect(response.cookies.get('admin-last-activity')?.sameSite).toBe('lax');
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:5173/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'superadmin@example.com',
        password: 'correct horse battery staple',
      }),
    });
  });

  test('password login rejects Studio admin-role tokens that are not super admin', async () => {
    const { POST } = await import('../app/api/auth/login/route.js');
    const accessToken = await createAccessToken({ role: 'ADMIN' });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        accessToken,
        user: { id: 'tenant-admin-001', email: 'admin@example.com' },
      }),
    });

    const response = await POST(
      makeRequest('/api/auth/login', {
        email: 'admin@example.com',
        password: 'password123',
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      error: PLATFORM_SUPER_ADMIN_REQUIRED_MESSAGE,
    });
  });

  test('password login surfaces unsupported MFA responses clearly', async () => {
    const { POST } = await import('../app/api/auth/login/route.js');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        mfaRequired: true,
      }),
    });

    const response = await POST(
      makeRequest('/api/auth/login', {
        email: 'admin@example.com',
        password: 'password123',
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: 'MFA-enabled Studio accounts are not yet supported in the Admin app.',
    });
  });

  test('password login rejects non-super-admin Studio tokens', async () => {
    const { POST } = await import('../app/api/auth/login/route.js');
    const accessToken = await createAccessToken({ role: 'MEMBER' });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        accessToken,
        user: { id: 'member-001', email: 'member@example.com' },
      }),
    });

    const response = await POST(
      makeRequest('/api/auth/login', {
        email: 'member@example.com',
        password: 'password123',
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      error: PLATFORM_SUPER_ADMIN_REQUIRED_MESSAGE,
    });
  });

  test('SSO init redirects through Studio with an admin callback URL', async () => {
    const { GET } = await import('../app/api/auth/sso/route.js');

    const response = await GET(
      makeGetRequest('/api/auth/sso?email=admin@example.com&redirect=%2Ftenants'),
    );

    expect(response.status).toBe(307);

    const location = response.headers.get('location');
    expect(location).toBeTruthy();

    const url = new URL(location!);
    expect(url.origin).toBe('http://localhost:5173');
    expect(url.pathname).toBe('/api/sso/init');
    expect(url.searchParams.get('email')).toBe('admin@example.com');
    expect(url.searchParams.get('mode')).toBe('redirect');
    expect(url.searchParams.get('admin_redirect')).toBe(
      'http://localhost:3003/api/auth/studio/callback?redirect=%2Ftenants',
    );
  });

  test('Google login redirects through Studio with an admin callback URL', async () => {
    const { GET } = await import('../app/api/auth/google/route.js');

    const response = await GET(makeGetRequest('/api/auth/google?redirect=%2Ftenants'));

    expect(response.status).toBe(307);

    const location = response.headers.get('location');
    expect(location).toBeTruthy();

    const url = new URL(location!);
    expect(url.origin).toBe('http://localhost:5173');
    expect(url.pathname).toBe('/api/auth/google');
    expect(url.searchParams.get('admin_redirect')).toBe(
      'http://localhost:3003/api/auth/studio/callback?redirect=%2Ftenants',
    );
  });

  test('Google login prefers FRONTEND_URL for browser redirects', async () => {
    process.env.STUDIO_API_URL = 'http://abl-platform-dev-studio';
    process.env.FRONTEND_URL = 'https://agents-dev.kore.ai';

    const { GET } = await import('../app/api/auth/google/route');

    const response = await GET(makeGetRequest('/api/auth/google?redirect=%2Ftenants'));

    expect(response.status).toBe(307);

    const location = response.headers.get('location');
    expect(location).toBeTruthy();

    const url = new URL(location!);
    expect(url.origin).toBe('https://agents-dev.kore.ai');
    expect(url.pathname).toBe('/api/auth/google');
    expect(url.searchParams.get('admin_redirect')).toBe(
      'http://localhost:3003/api/auth/studio/callback?redirect=%2Ftenants',
    );
  });

  test('Google login falls back to NEXT_PUBLIC_APP_URL when FRONTEND_URL is unset', async () => {
    process.env.STUDIO_API_URL = 'http://abl-platform-dev-studio';
    process.env.NEXT_PUBLIC_APP_URL = 'https://agents-dev.kore.ai';

    const { GET } = await import('../app/api/auth/google/route');

    const response = await GET(makeGetRequest('/api/auth/google?redirect=%2Ftenants'));

    expect(response.status).toBe(307);

    const location = response.headers.get('location');
    expect(location).toBeTruthy();

    const url = new URL(location!);
    expect(url.origin).toBe('https://agents-dev.kore.ai');
    expect(url.pathname).toBe('/api/auth/google');
  });

  test('Microsoft login redirects through Studio with an admin callback URL', async () => {
    const { GET } = await import('../app/api/auth/microsoft/route.js');

    const response = await GET(makeGetRequest('/api/auth/microsoft?redirect=%2Ftenants'));

    expect(response.status).toBe(307);

    const location = response.headers.get('location');
    expect(location).toBeTruthy();

    const url = new URL(location!);
    expect(url.origin).toBe('http://localhost:5173');
    expect(url.pathname).toBe('/api/auth/microsoft');
    expect(url.searchParams.get('admin_redirect')).toBe(
      'http://localhost:3003/api/auth/studio/callback?redirect=%2Ftenants',
    );
  });

  test('Studio callback creates an admin session and redirects to the requested page', async () => {
    const { GET } = await import('../app/api/auth/studio/callback/route.js');
    const accessToken = await createAccessToken({ isSuperAdmin: true });

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ accessToken }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: 'super-admin-001',
          email: 'superadmin@example.com',
          name: 'Platform Admin',
          isSuperAdmin: true,
        }),
      });

    const response = await GET(
      makeGetRequest('/api/auth/studio/callback?code=auth-code-123&redirect=%2Ftenants'),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3003/tenants');
    expect(response.cookies.get('admin-session')?.value).toBe(accessToken);
    expect(response.cookies.get('admin-session')?.sameSite).toBe('lax');
    expect(response.cookies.get('admin-last-activity')?.value).toBeTruthy();
    expect(response.cookies.get('admin-last-activity')?.sameSite).toBe('lax');
    expect(mockFetch).toHaveBeenNthCalledWith(1, 'http://localhost:5173/api/sso/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'auth-code-123' }),
    });
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:5173/api/auth/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  });

  test('Studio callback keeps STUDIO_API_URL for server-side exchange when browser Studio URL differs', async () => {
    process.env.STUDIO_API_URL = 'http://abl-platform-dev-studio';
    process.env.FRONTEND_URL = 'https://agents-dev.kore.ai';

    const { GET } = await import('../app/api/auth/studio/callback/route');
    const accessToken = await createAccessToken({ isSuperAdmin: true });

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ accessToken }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: 'super-admin-001',
          email: 'superadmin@example.com',
          name: 'Platform Admin',
          isSuperAdmin: true,
        }),
      });

    const response = await GET(
      makeGetRequest('/api/auth/studio/callback?code=auth-code-123&redirect=%2Ftenants'),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3003/tenants');
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      'http://abl-platform-dev-studio/api/sso/exchange',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'auth-code-123' }),
      },
    );
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://abl-platform-dev-studio/api/auth/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  });

  test('Studio callback redirects back to login when the Studio account is not a super admin', async () => {
    const { GET } = await import('../app/api/auth/studio/callback/route.js');
    const accessToken = await createAccessToken({ role: 'ADMIN' });

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ accessToken }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: 'tenant-admin-001',
          email: 'admin@example.com',
          name: 'Tenant Admin',
          isSuperAdmin: false,
        }),
      });

    const response = await GET(
      makeGetRequest('/api/auth/studio/callback?code=auth-code-123&redirect=%2Ftenants'),
    );

    expect(response.status).toBe(307);
    const location = response.headers.get('location');
    expect(location).toBeTruthy();

    const url = new URL(location!);
    expect(url.origin).toBe('http://localhost:3003');
    expect(url.pathname).toBe('/login');
    expect(url.searchParams.get('redirect')).toBe('/tenants');
    expect(url.searchParams.get('error')).toBe(PLATFORM_SUPER_ADMIN_REQUIRED_MESSAGE);
  });
});

// ─── Dev Login Route ──────────────────────────────────────────────────────────

describe('Admin dev-login route', () => {
  test('dev login creates an admin session for a super-admin JWT', async () => {
    const { POST } = await import('../app/api/auth/dev-login/route.js');
    const accessToken = await createAccessToken({ isSuperAdmin: true });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        accessToken,
        user: { id: 'super-admin-001', email: 'superadmin@platform.internal' },
      }),
    });

    const response = await POST(
      makeRequest('/api/auth/dev-login', {
        email: 'superadmin@platform.internal',
        name: 'Super Admin',
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      user: { id: 'super-admin-001', email: 'superadmin@platform.internal' },
      role: 'SUPER_ADMIN',
      isSuperAdmin: true,
    });
    expect(response.cookies.get('admin-session')?.value).toBe(accessToken);
    expect(response.cookies.get('admin-session')?.sameSite).toBe('lax');
    expect(response.cookies.get('admin-last-activity')?.value).toBeTruthy();
    expect(response.cookies.get('admin-last-activity')?.sameSite).toBe('lax');
    // Verify it proxied to Studio's dev-login
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:5173/api/auth/dev-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'superadmin@platform.internal', name: 'Super Admin' }),
    });
  });

  test('dev login rejects non-super-admin JWT (403)', async () => {
    const { POST } = await import('../app/api/auth/dev-login/route.js');
    const accessToken = await createAccessToken({ isSuperAdmin: false });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        accessToken,
        user: { id: 'regular-user-001', email: 'dev@example.com' },
      }),
    });

    const response = await POST(makeRequest('/api/auth/dev-login', { email: 'dev@example.com' }));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({ error: PLATFORM_SUPER_ADMIN_REQUIRED_MESSAGE });
    // No session cookie should be set
    expect(response.cookies.get('admin-session')).toBeUndefined();
  });

  test('dev login returns 400 when email is missing', async () => {
    const { POST } = await import('../app/api/auth/dev-login/route.js');

    const response = await POST(makeRequest('/api/auth/dev-login', {}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: 'Email required' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('dev login returns 502 when Studio is unreachable', async () => {
    const { POST } = await import('../app/api/auth/dev-login/route.js');

    mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

    const response = await POST(makeRequest('/api/auth/dev-login', { email: 'admin@test.com' }));
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toEqual({ error: 'Studio server not reachable. Is it running?' });
  });

  test('dev login forwards Studio error responses', async () => {
    const { POST } = await import('../app/api/auth/dev-login/route.js');

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Not available' }),
    });

    const response = await POST(makeRequest('/api/auth/dev-login', { email: 'admin@test.com' }));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({ error: 'Not available' });
  });
});
