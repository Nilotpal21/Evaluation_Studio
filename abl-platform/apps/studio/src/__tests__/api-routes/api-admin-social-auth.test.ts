import { AppError, ErrorCodes } from '@agent-platform/shared/errors';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockGenerateAuthUrl = vi.fn(({ state }: { state: string }) => {
  return `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`;
});
const mockGetToken = vi.fn(async () => ({
  tokens: {
    id_token: 'google-id-token',
  },
}));
const mockVerifyIdToken = vi.fn(async () => ({
  getPayload: () => ({
    sub: 'google-sub-123',
    email: 'admin@example.com',
    email_verified: true,
    name: 'Admin User',
    picture: 'https://example.com/avatar.png',
  }),
}));

const mockFindOrCreateGoogleUser = vi.fn(async () => ({
  id: 'google-user-1',
  email: 'admin@example.com',
  name: 'Admin User',
}));
const mockFindOrCreateMicrosoftUser = vi.fn(async () => ({
  id: 'microsoft-user-1',
  email: 'admin@example.com',
  name: 'Admin User',
}));
const mockCreateTokenPair = vi.fn(async () => ({
  accessToken: 'studio-access-token',
  refreshToken: 'studio-refresh-token',
  expiresIn: 900,
}));
const mockCreatePartialToken = vi.fn(() => 'mfa-partial-token');
const mockResolveUserContextOrAutoAcceptInvite = vi.fn(async () => ({
  tenantContext: { tenantId: 'tenant-1', role: 'ADMIN' },
  pendingInvitationChoice: false,
}));

const mockGetMFAStatus = vi.fn(async () => ({ enabled: false }));
const mockLogAuditEvent = vi.fn(async () => undefined);
const mockStoreAuthCode = vi.fn(async () => undefined);
const mockFindDefaultTenantMembership = vi.fn(async () => null);

const mockHttpsPost = vi.fn(async () => ({
  ok: true,
  status: 200,
  body: JSON.stringify({
    access_token: 'microsoft-provider-access-token',
    id_token: 'microsoft-id-token',
  }),
}));
const mockHttpsGet = vi.fn(async () => ({
  ok: true,
  status: 200,
  body: JSON.stringify({
    mail: 'admin@example.com',
    givenName: 'Admin',
    surname: 'User',
  }),
}));

vi.mock('google-auth-library', () => ({
  OAuth2Client: vi.fn(function MockOAuth2Client() {
    return {
      generateAuthUrl: mockGenerateAuthUrl,
      getToken: mockGetToken,
      verifyIdToken: mockVerifyIdToken,
    };
  }),
}));

vi.mock('@/services/auth-service', () => ({
  findOrCreateGoogleUser: mockFindOrCreateGoogleUser,
  findOrCreateMicrosoftUser: mockFindOrCreateMicrosoftUser,
  createTokenPair: mockCreateTokenPair,
  createPartialToken: mockCreatePartialToken,
  resolveUserContextOrAutoAcceptInvite: mockResolveUserContextOrAutoAcceptInvite,
}));

vi.mock('@/services/auth/mfa-service', () => ({
  getMFAStatus: mockGetMFAStatus,
}));

vi.mock('@/services/audit-service', () => ({
  logAuditEvent: mockLogAuditEvent,
  AuditActions: {
    LOGIN: 'LOGIN',
  },
}));

vi.mock('@/lib/sso-auth-codes', () => ({
  storeAuthCode: mockStoreAuthCode,
}));

vi.mock('@/repos/auth-repo', () => ({
  findDefaultTenantMembership: mockFindDefaultTenantMembership,
}));

vi.mock('@/lib/oauth-http', () => ({
  httpsPost: mockHttpsPost,
  httpsGet: mockHttpsGet,
}));

vi.mock('@/config', () => ({
  isConfigLoaded: vi.fn(() => true),
  getConfig: vi.fn(() => ({
    server: {
      frontendUrl: 'http://localhost:5173',
    },
    oauth: {
      google: {
        clientId: 'google-client-id',
        clientSecret: 'google-client-secret',
      },
      microsoft: {
        clientId: 'microsoft-client-id',
        clientSecret: 'microsoft-client-secret',
        tenantId: 'common',
        authorizeUrl: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize',
        tokenUrl: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token',
        profileUrl: 'https://graph.microsoft.com/v1.0/me',
        scope: 'openid email profile User.Read',
        stateCookieTtlSeconds: 600,
      },
    },
    auth: {
      tokens: {
        mfaCookieMaxAgeSeconds: 300,
      },
    },
    jwt: {
      secret: 'test-secret',
    },
  })),
}));

vi.mock('@/lib/auth-helpers', () => ({
  getFrontendUrl: vi.fn(() => 'http://localhost:5173'),
  getMicrosoftConfig: vi.fn(() => ({
    clientId: 'microsoft-client-id',
    clientSecret: 'microsoft-client-secret',
    tenantId: 'common',
    redirectUri: 'http://localhost:5173/api/auth/microsoft/callback',
    authorizeUrl: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token',
    profileUrl: 'https://graph.microsoft.com/v1.0/me',
    scope: 'openid email profile User.Read',
    stateCookieTtlSeconds: 600,
    mfaCookieMaxAge: 300,
  })),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  })),
}));

function makeRequest(path: string, init?: RequestInit): NextRequest {
  const headers = new Headers(init?.headers);
  const request = new NextRequest(
    new Request(`http://localhost:5173${path}`, {
      ...init,
      headers,
    }),
  );

  const cookieHeader = headers.get('cookie');
  if (cookieHeader) {
    for (const cookie of cookieHeader.split(/;\s*/)) {
      const [name, ...valueParts] = cookie.split('=');
      if (!name) continue;
      request.cookies.set(name, valueParts.join('='));
    }
  }

  return request;
}

type ResponseWithCookies = Response & {
  cookies: {
    get: (name: string) => { name: string; value: string } | undefined;
    getAll: () => Array<{ name: string; value: string }>;
  };
};

function getResponseCookie(
  response: ResponseWithCookies,
  name: string,
): { name: string; value: string } | undefined {
  const responseWithSetCookie = response as Response & {
    headers: Headers & { getSetCookie?: () => string[] };
  };
  const headerCookies = responseWithSetCookie.headers.getSetCookie?.() ?? [];
  for (const headerCookie of headerCookies) {
    const cookiePair = headerCookie.split(';', 1)[0];
    const [cookieName, ...cookieValueParts] = cookiePair.split('=');
    if (cookieName === name) {
      return { name: cookieName, value: cookieValueParts.join('=') };
    }
  }

  return response.cookies.get(name);
}

function cookiesToHeader(response: ResponseWithCookies, cookieNames?: string[]): string {
  if (cookieNames?.length) {
    return cookieNames
      .map((name) => getResponseCookie(response, name))
      .filter((cookie): cookie is { name: string; value: string } => Boolean(cookie))
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');
  }

  const responseWithSetCookie = response as Response & {
    headers: Headers & { getSetCookie?: () => string[] };
  };
  const headerCookies = responseWithSetCookie.headers.getSetCookie?.() ?? [];
  if (headerCookies.length > 0) {
    return headerCookies.map((cookie) => cookie.split(';', 1)[0]).join('; ');
  }

  return response.cookies
    .getAll()
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

function getOAuthStateFromRedirect(response: Response): string {
  const location = response.headers.get('location');
  expect(location).toBeTruthy();

  const state = new URL(location!).searchParams.get('state');
  expect(state).toBeTruthy();

  return state!;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetMFAStatus.mockResolvedValue({ enabled: false });
  mockResolveUserContextOrAutoAcceptInvite.mockResolvedValue({
    tenantContext: { tenantId: 'tenant-1', role: 'ADMIN' },
    pendingInvitationChoice: false,
  });
  mockFindDefaultTenantMembership.mockResolvedValue(null);
});

describe('Admin social auth handoff', () => {
  it('stores admin redirect context when Google login starts', async () => {
    const { GET } = await import('@/app/api/auth/google/route');
    const { ADMIN_AUTH_REDIRECT_COOKIE } = await import('@/lib/admin-auth-handoff');

    const response = await GET(
      makeRequest(
        '/api/auth/google?admin_redirect=http%3A%2F%2Flocalhost%3A3003%2Fapi%2Fauth%2Fstudio%2Fcallback%3Fredirect%3D%252Ftenants',
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('accounts.google.com');
    expect(
      getResponseCookie(response as ResponseWithCookies, ADMIN_AUTH_REDIRECT_COOKIE)?.value,
    ).toBeTruthy();
    expect(getResponseCookie(response as ResponseWithCookies, 'oauth_state')?.value).toBeTruthy();
  });

  it('redirects successful Google logins back to the Admin callback with an auth code', async () => {
    const { GET: startGoogle } = await import('@/app/api/auth/google/route');
    const { GET: finishGoogle } = await import('@/app/api/auth/callback/route');
    const { ADMIN_AUTH_REDIRECT_COOKIE } = await import('@/lib/admin-auth-handoff');

    const startResponse = await startGoogle(
      makeRequest(
        '/api/auth/google?admin_redirect=http%3A%2F%2Flocalhost%3A3003%2Fapi%2Fauth%2Fstudio%2Fcallback%3Fredirect%3D%252Ftenants',
      ),
    );
    const oauthState = getOAuthStateFromRedirect(startResponse);

    const callbackResponse = await finishGoogle(
      makeRequest(`/api/auth/callback?code=google-oauth-code&state=${oauthState}`, {
        headers: {
          cookie: cookiesToHeader(startResponse as ResponseWithCookies, [
            'oauth_state',
            ADMIN_AUTH_REDIRECT_COOKIE,
          ]),
        },
      }),
    );

    expect(callbackResponse.status).toBe(307);

    const location = callbackResponse.headers.get('location');
    expect(location).toBeTruthy();

    const redirectUrl = new URL(location!);
    expect(redirectUrl.origin).toBe('http://localhost:3003');
    expect(redirectUrl.pathname).toBe('/api/auth/studio/callback');
    expect(redirectUrl.searchParams.get('redirect')).toBe('/tenants');
    expect(redirectUrl.searchParams.get('code')).toBeTruthy();

    expect(mockStoreAuthCode).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        accessToken: 'studio-access-token',
        refreshToken: 'studio-refresh-token',
        expiresIn: 900,
      }),
    );
  });

  it('redirects Google admin handoff back to Admin login when MFA is enabled', async () => {
    const { GET: startGoogle } = await import('@/app/api/auth/google/route');
    const { GET: finishGoogle } = await import('@/app/api/auth/callback/route');
    const { ADMIN_AUTH_REDIRECT_COOKIE } = await import('@/lib/admin-auth-handoff');

    mockGetMFAStatus.mockResolvedValue({ enabled: true });

    const startResponse = await startGoogle(
      makeRequest(
        '/api/auth/google?admin_redirect=http%3A%2F%2Flocalhost%3A3003%2Fapi%2Fauth%2Fstudio%2Fcallback%3Fredirect%3D%252Ftenants',
      ),
    );
    const oauthState = getOAuthStateFromRedirect(startResponse);

    const callbackResponse = await finishGoogle(
      makeRequest(`/api/auth/callback?code=google-oauth-code&state=${oauthState}`, {
        headers: {
          cookie: cookiesToHeader(startResponse as ResponseWithCookies, [
            'oauth_state',
            ADMIN_AUTH_REDIRECT_COOKIE,
          ]),
        },
      }),
    );

    expect(callbackResponse.status).toBe(307);
    expect(callbackResponse.headers.get('location')).toBe(
      'http://localhost:3003/login?redirect=%2Ftenants&error=mfa_unsupported',
    );
  });

  it('rejects Google admin handoff when the email is not registered in Studio', async () => {
    const { GET: startGoogle } = await import('@/app/api/auth/google/route');
    const { GET: finishGoogle } = await import('@/app/api/auth/callback/route');
    const { ADMIN_AUTH_REDIRECT_COOKIE } = await import('@/lib/admin-auth-handoff');

    mockFindOrCreateGoogleUser.mockRejectedValueOnce(
      new AppError(
        'This Google account must already belong to a Studio user before it can access Admin.',
        { ...ErrorCodes.NOT_FOUND },
      ),
    );

    const startResponse = await startGoogle(
      makeRequest(
        '/api/auth/google?admin_redirect=http%3A%2F%2Flocalhost%3A3003%2Fapi%2Fauth%2Fstudio%2Fcallback%3Fredirect%3D%252Ftenants',
      ),
    );
    const oauthState = getOAuthStateFromRedirect(startResponse);

    const callbackResponse = await finishGoogle(
      makeRequest(`/api/auth/callback?code=google-oauth-code&state=${oauthState}`, {
        headers: {
          cookie: cookiesToHeader(startResponse as ResponseWithCookies, [
            'oauth_state',
            ADMIN_AUTH_REDIRECT_COOKIE,
          ]),
        },
      }),
    );

    expect(callbackResponse.status).toBe(307);
    expect(callbackResponse.headers.get('location')).toBe(
      'http://localhost:3003/login?redirect=%2Ftenants&error=studio_account_required',
    );
  });

  it('stores admin redirect context when Microsoft login starts', async () => {
    const { GET } = await import('@/app/api/auth/microsoft/route');
    const { ADMIN_AUTH_REDIRECT_COOKIE } = await import('@/lib/admin-auth-handoff');

    const response = await GET(
      makeRequest(
        '/api/auth/microsoft?admin_redirect=http%3A%2F%2Flocalhost%3A3003%2Fapi%2Fauth%2Fstudio%2Fcallback%3Fredirect%3D%252Ftenants',
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('login.microsoftonline.com');
    expect(response.cookies.get(ADMIN_AUTH_REDIRECT_COOKIE)?.value).toBeTruthy();
    expect(response.cookies.get('oauth_state_ms')?.value).toBeTruthy();
  });

  it('redirects successful Microsoft logins back to the Admin callback with an auth code', async () => {
    const { GET: startMicrosoft } = await import('@/app/api/auth/microsoft/route');
    const { GET: finishMicrosoft } = await import('@/app/api/auth/microsoft/callback/route');
    const { ADMIN_AUTH_REDIRECT_COOKIE } = await import('@/lib/admin-auth-handoff');

    const startResponse = await startMicrosoft(
      makeRequest(
        '/api/auth/microsoft?admin_redirect=http%3A%2F%2Flocalhost%3A3003%2Fapi%2Fauth%2Fstudio%2Fcallback%3Fredirect%3D%252Ftenants',
      ),
    );
    const oauthState = getOAuthStateFromRedirect(startResponse);

    const callbackResponse = await finishMicrosoft(
      makeRequest(`/api/auth/microsoft/callback?code=microsoft-oauth-code&state=${oauthState}`, {
        headers: {
          cookie: cookiesToHeader(startResponse as ResponseWithCookies, [
            'oauth_state_ms',
            ADMIN_AUTH_REDIRECT_COOKIE,
          ]),
        },
      }),
    );

    expect(callbackResponse.status).toBe(307);

    const location = callbackResponse.headers.get('location');
    expect(location).toBeTruthy();

    const redirectUrl = new URL(location!);
    expect(redirectUrl.origin).toBe('http://localhost:3003');
    expect(redirectUrl.pathname).toBe('/api/auth/studio/callback');
    expect(redirectUrl.searchParams.get('redirect')).toBe('/tenants');
    expect(redirectUrl.searchParams.get('code')).toBeTruthy();

    expect(mockStoreAuthCode).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        accessToken: 'studio-access-token',
        refreshToken: 'studio-refresh-token',
        expiresIn: 900,
      }),
    );
  });

  it('rejects Microsoft admin handoff when the email is not registered in Studio', async () => {
    const { GET: startMicrosoft } = await import('@/app/api/auth/microsoft/route');
    const { GET: finishMicrosoft } = await import('@/app/api/auth/microsoft/callback/route');
    const { ADMIN_AUTH_REDIRECT_COOKIE } = await import('@/lib/admin-auth-handoff');

    mockFindOrCreateMicrosoftUser.mockRejectedValueOnce(
      new AppError(
        'This Microsoft account must already belong to a Studio user before it can access Admin.',
        { ...ErrorCodes.NOT_FOUND },
      ),
    );

    const startResponse = await startMicrosoft(
      makeRequest(
        '/api/auth/microsoft?admin_redirect=http%3A%2F%2Flocalhost%3A3003%2Fapi%2Fauth%2Fstudio%2Fcallback%3Fredirect%3D%252Ftenants',
      ),
    );
    const oauthState = getOAuthStateFromRedirect(startResponse);

    const callbackResponse = await finishMicrosoft(
      makeRequest(`/api/auth/microsoft/callback?code=microsoft-oauth-code&state=${oauthState}`, {
        headers: {
          cookie: cookiesToHeader(startResponse as ResponseWithCookies, [
            'oauth_state_ms',
            ADMIN_AUTH_REDIRECT_COOKIE,
          ]),
        },
      }),
    );

    expect(callbackResponse.status).toBe(307);
    expect(callbackResponse.headers.get('location')).toBe(
      'http://localhost:3003/login?redirect=%2Ftenants&error=studio_account_required',
    );
  });
});

describe('Workspace social auth flow', () => {
  it('keeps standard Google login on the Studio callback path', async () => {
    const { GET: startGoogle } = await import('@/app/api/auth/google/route');
    const { GET: finishGoogle } = await import('@/app/api/auth/callback/route');
    const { ADMIN_AUTH_REDIRECT_COOKIE } = await import('@/lib/admin-auth-handoff');

    const startResponse = await startGoogle(makeRequest('/api/auth/google'));
    const oauthState = getOAuthStateFromRedirect(startResponse);

    expect(
      getResponseCookie(startResponse as ResponseWithCookies, ADMIN_AUTH_REDIRECT_COOKIE)?.value,
    ).toBeUndefined();

    const callbackResponse = await finishGoogle(
      makeRequest(`/api/auth/callback?code=google-oauth-code&state=${oauthState}`, {
        headers: {
          cookie: cookiesToHeader(startResponse as ResponseWithCookies, ['oauth_state']),
        },
      }),
    );

    expect(callbackResponse.status).toBe(307);

    const location = callbackResponse.headers.get('location');
    expect(location).toBeTruthy();

    const redirectUrl = new URL(location!);
    expect(redirectUrl.origin).toBe('http://localhost:5173');
    expect(redirectUrl.pathname).toBe('/auth/callback');
    expect(redirectUrl.searchParams.get('code')).toBeTruthy();

    expect(mockFindOrCreateGoogleUser).toHaveBeenCalledWith(
      expect.objectContaining({
        googleId: 'google-sub-123',
        email: 'admin@example.com',
      }),
      { requireExistingUser: false },
    );
  });

  it('keeps standard Google MFA users on the Studio MFA screen', async () => {
    const { GET: startGoogle } = await import('@/app/api/auth/google/route');
    const { GET: finishGoogle } = await import('@/app/api/auth/callback/route');

    mockGetMFAStatus.mockResolvedValue({ enabled: true });

    const startResponse = await startGoogle(makeRequest('/api/auth/google'));
    const oauthState = getOAuthStateFromRedirect(startResponse);

    const callbackResponse = await finishGoogle(
      makeRequest(`/api/auth/callback?code=google-oauth-code&state=${oauthState}`, {
        headers: {
          cookie: cookiesToHeader(startResponse as ResponseWithCookies, ['oauth_state']),
        },
      }),
    );

    expect(callbackResponse.status).toBe(307);
    expect(callbackResponse.headers.get('location')).toBe('http://localhost:5173/auth/mfa');
    expect(callbackResponse.cookies.get('mfa_partial')?.value).toBe('mfa-partial-token');
  });

  it('keeps standard Microsoft login on the Studio callback path', async () => {
    const { GET: startMicrosoft } = await import('@/app/api/auth/microsoft/route');
    const { GET: finishMicrosoft } = await import('@/app/api/auth/microsoft/callback/route');
    const { ADMIN_AUTH_REDIRECT_COOKIE } = await import('@/lib/admin-auth-handoff');

    const startResponse = await startMicrosoft(makeRequest('/api/auth/microsoft'));
    const oauthState = getOAuthStateFromRedirect(startResponse);

    expect(
      getResponseCookie(startResponse as ResponseWithCookies, ADMIN_AUTH_REDIRECT_COOKIE)?.value,
    ).toBeUndefined();

    const callbackResponse = await finishMicrosoft(
      makeRequest(`/api/auth/microsoft/callback?code=microsoft-oauth-code&state=${oauthState}`, {
        headers: {
          cookie: cookiesToHeader(startResponse as ResponseWithCookies, ['oauth_state_ms']),
        },
      }),
    );

    expect(callbackResponse.status).toBe(307);

    const location = callbackResponse.headers.get('location');
    expect(location).toBeTruthy();

    const redirectUrl = new URL(location!);
    expect(redirectUrl.origin).toBe('http://localhost:5173');
    expect(redirectUrl.pathname).toBe('/auth/callback');
    expect(redirectUrl.searchParams.get('code')).toBeTruthy();

    expect(mockFindOrCreateMicrosoftUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'admin@example.com',
        name: 'Admin User',
      }),
      { requireExistingUser: false },
    );
  });

  it('keeps standard Microsoft MFA users on the Studio MFA screen', async () => {
    const { GET: startMicrosoft } = await import('@/app/api/auth/microsoft/route');
    const { GET: finishMicrosoft } = await import('@/app/api/auth/microsoft/callback/route');

    mockGetMFAStatus.mockResolvedValue({ enabled: true });

    const startResponse = await startMicrosoft(makeRequest('/api/auth/microsoft'));
    const oauthState = getOAuthStateFromRedirect(startResponse);

    const callbackResponse = await finishMicrosoft(
      makeRequest(`/api/auth/microsoft/callback?code=microsoft-oauth-code&state=${oauthState}`, {
        headers: {
          cookie: cookiesToHeader(startResponse as ResponseWithCookies, ['oauth_state_ms']),
        },
      }),
    );

    expect(callbackResponse.status).toBe(307);
    expect(callbackResponse.headers.get('location')).toBe('http://localhost:5173/auth/mfa');
    expect(callbackResponse.cookies.get('mfa_partial')?.value).toBe('mfa-partial-token');
  });
});
