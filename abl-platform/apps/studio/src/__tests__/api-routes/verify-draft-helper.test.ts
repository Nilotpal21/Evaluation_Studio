import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runVerifyDraft } from '@/app/api/auth-profiles/_verify-draft-helper';

describe('runVerifyDraft', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns configuration_error when structural validation fails', async () => {
    // basic auth requires username + password — supplying neither triggers
    // the materialized validator
    const result = await runVerifyDraft({
      authType: 'basic',
      config: {},
      secrets: {},
    });

    expect(result.valid).toBe(false);
    expect(result.validationType).toBe('configuration');
    expect(result.health.state).toBe('configuration_error');
    expect(result.message).toBeTruthy();
  });

  it('returns valid + untested for a structurally-valid static auth (basic) draft', async () => {
    const result = await runVerifyDraft({
      authType: 'basic',
      config: {},
      secrets: { username: 'admin', password: 's3cret' },
    });

    expect(result.valid).toBe(true);
    expect(result.validationType).toBe('configuration');
    expect(result.health.state).toBe('untested');
  });

  it('runs a live token exchange for oauth2_client_credentials drafts', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'at-1', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof globalThis.fetch;

    const result = await runVerifyDraft({
      authType: 'oauth2_client_credentials',
      config: {
        tokenUrl: 'https://auth.example.com/token',
        scopes: ['read:client_grants'],
        audience: 'https://api.example.com/',
      },
      secrets: { clientId: 'cid', clientSecret: 'csec' },
    });

    expect(result.valid).toBe(true);
    expect(result.validationType).toBe('token_exchange');
    expect(result.health.state).toBe('verified');
    expect(result.message).toMatch(/succeeded/i);
    const requestInit = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as
      | RequestInit
      | undefined;
    const body = requestInit?.body;
    const encodedBody =
      body instanceof URLSearchParams ? body.toString() : body ? String(body) : undefined;
    expect(encodedBody).toContain('scope=read%3Aclient_grants');
    expect(encodedBody).toContain('audience=https%3A%2F%2Fapi.example.com%2F');
  });

  it('surfaces RFC 6749 error/error_description on a CC draft exchange failure', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: 'invalid_client', error_description: 'Wrong client_secret' }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
      ) as unknown as typeof globalThis.fetch;

    const result = await runVerifyDraft({
      authType: 'oauth2_client_credentials',
      config: { tokenUrl: 'https://auth.example.com/token' },
      secrets: { clientId: 'cid', clientSecret: 'wrong' },
    });

    expect(result.valid).toBe(false);
    expect(result.message).toContain('invalid_client');
    expect(result.message).toContain('Wrong client_secret');
    expect(result.health.state).toBe('configuration_error');
  });

  it('rejects CC drafts whose tokenUrl fails SSRF / metadata-IP checks', async () => {
    const result = await runVerifyDraft({
      authType: 'oauth2_client_credentials',
      config: { tokenUrl: 'https://169.254.169.254/latest/meta-data/iam' },
      secrets: { clientId: 'cid', clientSecret: 'csec' },
    });

    expect(result.valid).toBe(false);
    // Either the structural URL validator (config-tier) or the SSRF helper
    // catches the metadata IP. Both produce a "Blocked" / "metadata" message.
    expect(result.message?.toLowerCase()).toMatch(/blocked|ssrf|metadata/);
  });

  it('returns not_authorized for oauth2_app drafts (cannot verify grant without a saved profile)', async () => {
    const result = await runVerifyDraft({
      authType: 'oauth2_app',
      config: {
        authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
      },
      secrets: { clientId: 'cid', clientSecret: 'csec' },
    });

    // Structural validation passes for the draft, but a draft has no saved
    // profile to look up a grant against — health correctly reports
    // 'not_authorized'. The slide-over UX guides users to save first, then
    // click Authorize.
    expect(result.valid).toBe(true);
    expect(result.validationType).toBe('configuration');
    expect(result.health.state).toBe('not_authorized');
  });
});
