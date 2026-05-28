/**
 * OAuth Provider Adapters (Arctic v3) — Unit Tests
 *
 * Tests the three concrete OAuthProviderAdapter implementations:
 *   - GoogleOAuthAdapter — delegates to Arctic Google, fetches from googleapis.com
 *   - MicrosoftOAuthAdapter — delegates to Arctic MicrosoftEntraId, fetches from graph.microsoft.com
 *   - GitHubOAuthAdapter — delegates to Arctic GitHub (no PKCE), fetches from api.github.com
 *
 * Arctic providers are injected via DI (constructor overload) — no vi.mock().
 * The global `fetch` is mocked for userinfo endpoint assertions (external HTTP boundary).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  GoogleOAuthAdapter,
  MicrosoftOAuthAdapter,
  GitHubOAuthAdapter,
  type ArcticLikeProvider,
} from '../../../../contexts/identity/infrastructure/verifiers/oauth-adapters.js';

// =============================================================================
// FAKE ARCTIC PROVIDERS (injected via DI — not vi.mock)
// =============================================================================

function createFakeProvider(): ArcticLikeProvider & {
  createAuthorizationURL: ReturnType<typeof vi.fn>;
  validateAuthorizationCode: ReturnType<typeof vi.fn>;
} {
  return {
    createAuthorizationURL: vi.fn(),
    validateAuthorizationCode: vi.fn(),
  };
}

/** Fake OAuth2Tokens — Arctic v3 tokens use accessToken() as a method. */
function fakeTokens(accessToken: string) {
  return {
    accessToken: () => accessToken,
    tokenType: () => 'Bearer',
    data: {},
  };
}

// =============================================================================
// MOCK FETCH (external HTTP boundary — allowed)
// =============================================================================

const originalFetch = globalThis.fetch;

function mockFetchOk(body: unknown): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => body,
  }) as unknown as typeof fetch;
}

function mockFetchFail(status: number): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => ({}),
  }) as unknown as typeof fetch;
}

// =============================================================================
// TESTS
// =============================================================================

describe('GoogleOAuthAdapter', () => {
  let fakeArctic: ReturnType<typeof createFakeProvider>;
  let adapter: GoogleOAuthAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    fakeArctic = createFakeProvider();
    adapter = new GoogleOAuthAdapter(fakeArctic);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('createAuthorizationURL delegates to provider with openid, email, profile scopes', () => {
    const expectedUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth?state=test-state');
    fakeArctic.createAuthorizationURL.mockReturnValue(expectedUrl);

    const result = adapter.createAuthorizationURL('test-state', 'test-verifier');

    expect(fakeArctic.createAuthorizationURL).toHaveBeenCalledWith('test-state', 'test-verifier', [
      'openid',
      'email',
      'profile',
    ]);
    expect(result).toBe(expectedUrl);
  });

  it('validateAuthorizationCode delegates to provider and extracts accessToken', async () => {
    fakeArctic.validateAuthorizationCode.mockResolvedValue(fakeTokens('google-access-token-123'));

    const result = await adapter.validateAuthorizationCode('auth-code', 'verifier');

    expect(fakeArctic.validateAuthorizationCode).toHaveBeenCalledWith('auth-code', 'verifier');
    expect(result).toEqual({ accessToken: 'google-access-token-123' });
  });

  it('fetchUserEmail calls Google userinfo endpoint and returns email', async () => {
    mockFetchOk({ email: 'user@gmail.com', name: 'Test User' });

    const email = await adapter.fetchUserEmail('goog-token');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://www.googleapis.com/oauth2/v3/userinfo',
      expect.objectContaining({
        headers: { Authorization: 'Bearer goog-token' },
      }),
    );
    expect(email).toBe('user@gmail.com');
  });

  it('fetchUserEmail throws when Google returns no email', async () => {
    mockFetchOk({ name: 'No Email User' });

    await expect(adapter.fetchUserEmail('goog-token')).rejects.toThrow(
      'Google userinfo response missing email field',
    );
  });

  it('fetchUserEmail throws when Google returns non-OK status', async () => {
    mockFetchFail(401);

    await expect(adapter.fetchUserEmail('bad-token')).rejects.toThrow(
      'Google userinfo returned 401',
    );
  });
});

describe('MicrosoftOAuthAdapter', () => {
  let fakeArctic: ReturnType<typeof createFakeProvider>;
  let adapter: MicrosoftOAuthAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    fakeArctic = createFakeProvider();
    adapter = new MicrosoftOAuthAdapter(fakeArctic);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('createAuthorizationURL delegates to provider with openid, email, profile scopes', () => {
    const expectedUrl = new URL('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    fakeArctic.createAuthorizationURL.mockReturnValue(expectedUrl);

    const result = adapter.createAuthorizationURL('ms-state', 'ms-verifier');

    expect(fakeArctic.createAuthorizationURL).toHaveBeenCalledWith('ms-state', 'ms-verifier', [
      'openid',
      'email',
      'profile',
    ]);
    expect(result).toBe(expectedUrl);
  });

  it('validateAuthorizationCode delegates to provider and extracts accessToken', async () => {
    fakeArctic.validateAuthorizationCode.mockResolvedValue(fakeTokens('ms-access-token-456'));

    const result = await adapter.validateAuthorizationCode('ms-auth-code', 'ms-verifier');

    expect(fakeArctic.validateAuthorizationCode).toHaveBeenCalledWith(
      'ms-auth-code',
      'ms-verifier',
    );
    expect(result).toEqual({ accessToken: 'ms-access-token-456' });
  });

  it('fetchUserEmail calls Microsoft Graph /me and returns mail field', async () => {
    mockFetchOk({ mail: 'user@contoso.com', displayName: 'Test' });

    const email = await adapter.fetchUserEmail('ms-token');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://graph.microsoft.com/v1.0/me',
      expect.objectContaining({
        headers: { Authorization: 'Bearer ms-token' },
      }),
    );
    expect(email).toBe('user@contoso.com');
  });

  it('fetchUserEmail falls back to userPrincipalName when mail is absent', async () => {
    mockFetchOk({ userPrincipalName: 'upn@contoso.onmicrosoft.com' });

    const email = await adapter.fetchUserEmail('ms-token');

    expect(email).toBe('upn@contoso.onmicrosoft.com');
  });

  it('fetchUserEmail throws when both mail and userPrincipalName are missing', async () => {
    mockFetchOk({ displayName: 'No Email' });

    await expect(adapter.fetchUserEmail('ms-token')).rejects.toThrow(
      'Microsoft Graph /me response missing mail and userPrincipalName',
    );
  });

  it('fetchUserEmail throws when Microsoft Graph returns non-OK status', async () => {
    mockFetchFail(403);

    await expect(adapter.fetchUserEmail('bad-ms-token')).rejects.toThrow(
      'Microsoft Graph /me returned 403',
    );
  });
});

describe('GitHubOAuthAdapter', () => {
  let fakeArctic: ReturnType<typeof createFakeProvider>;
  let adapter: GitHubOAuthAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    fakeArctic = createFakeProvider();
    adapter = new GitHubOAuthAdapter(fakeArctic);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('createAuthorizationURL delegates to provider with user:email scope (no codeVerifier)', () => {
    const expectedUrl = new URL('https://github.com/login/oauth/authorize?state=gh-state');
    fakeArctic.createAuthorizationURL.mockReturnValue(expectedUrl);

    const result = adapter.createAuthorizationURL('gh-state', 'ignored-verifier');

    // GitHub's Arctic class does not accept codeVerifier — only state + scopes
    expect(fakeArctic.createAuthorizationURL).toHaveBeenCalledWith('gh-state', ['user:email']);
    expect(result).toBe(expectedUrl);
  });

  it('validateAuthorizationCode delegates to provider (no codeVerifier)', async () => {
    fakeArctic.validateAuthorizationCode.mockResolvedValue(fakeTokens('gh-access-token-789'));

    const result = await adapter.validateAuthorizationCode('gh-auth-code', 'ignored-verifier');

    // GitHub's Arctic class does not accept codeVerifier
    expect(fakeArctic.validateAuthorizationCode).toHaveBeenCalledWith('gh-auth-code');
    expect(result).toEqual({ accessToken: 'gh-access-token-789' });
  });

  it('fetchUserEmail calls GitHub /user/emails and returns the primary verified email', async () => {
    mockFetchOk([
      { email: 'secondary@github.com', primary: false, verified: true },
      { email: 'primary@github.com', primary: true, verified: true },
      { email: 'unverified@github.com', primary: false, verified: false },
    ]);

    const email = await adapter.fetchUserEmail('gh-token');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.github.com/user/emails',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer gh-token',
          Accept: 'application/vnd.github+json',
        }),
      }),
    );
    expect(email).toBe('primary@github.com');
  });

  it('fetchUserEmail throws when no primary verified email exists', async () => {
    mockFetchOk([
      { email: 'unverified@github.com', primary: true, verified: false },
      { email: 'secondary@github.com', primary: false, verified: true },
    ]);

    await expect(adapter.fetchUserEmail('gh-token')).rejects.toThrow(
      'No primary verified email found in GitHub account',
    );
  });

  it('fetchUserEmail throws when GitHub returns non-OK status', async () => {
    mockFetchFail(403);

    await expect(adapter.fetchUserEmail('gh-token')).rejects.toThrow(
      'GitHub /user/emails returned 403',
    );
  });
});
