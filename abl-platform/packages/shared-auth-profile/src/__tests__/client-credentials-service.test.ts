import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RedisClient } from '@agent-platform/redis';
import { resolveClientCredentialsToken } from '../client-credentials-service.js';

describe('resolveClientCredentialsToken (CK-1 cache key)', () => {
  const mockRedis = {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn().mockResolvedValue(1),
  };
  // Cast for DI — implementation only calls get/set/del (single-key ops)
  const testRedis = mockRedis as unknown as RedisClient;

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn();
  });

  function expectedCacheKey(
    tenantId: string,
    profileId: string,
    profileVersion: number,
    scopes: string[],
  ): string {
    const list = scopes.filter((s) => s.length > 0);
    const scopeHash =
      list.length === 0
        ? ''
        : createHash('sha256')
            .update([...list].sort().join(','))
            .digest('hex');
    return `auth-token:${tenantId}:oauth2_client_credentials:${profileId}:${profileVersion}:${scopeHash}`;
  }

  it('returns cached token from Redis when available', async () => {
    mockRedis.get.mockResolvedValue(
      JSON.stringify({ accessToken: 'cached-at', expiresAt: '2026-12-01T00:00:00Z' }),
    );

    const result = await resolveClientCredentialsToken(
      'prof-1',
      'tenant-1',
      1,
      'https://auth.example.com/token',
      'cid',
      'csec',
      ['read'],
      {
        redis: testRedis,
      },
    );

    expect(result).toEqual({
      accessToken: 'cached-at',
      expiresAt: '2026-12-01T00:00:00Z',
      cached: true,
    });
    expect(mockRedis.get).toHaveBeenCalledWith(expectedCacheKey('tenant-1', 'prof-1', 1, ['read']));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('reads and writes the canonical CK-1 cache key shape', async () => {
    mockRedis.get.mockResolvedValue(null);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'fresh-at', expires_in: 3600 }),
    });

    await resolveClientCredentialsToken(
      'prof-7',
      'tenant-9',
      42,
      'https://auth.example.com/token',
      'cid',
      'csec',
      ['write', 'read'],
      { redis: testRedis },
    );

    const expected = expectedCacheKey('tenant-9', 'prof-7', 42, ['read', 'write']);
    expect(mockRedis.get).toHaveBeenCalledWith(expected);
    expect(mockRedis.set).toHaveBeenCalledWith(
      expected,
      expect.any(String),
      'EX',
      expect.any(Number),
    );
  });

  it('includes audience when provided', async () => {
    mockRedis.get.mockResolvedValue(null);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'aud-token', expires_in: 3600 }),
    });

    await resolveClientCredentialsToken(
      'prof-7',
      'tenant-9',
      42,
      'https://auth.example.com/token',
      'cid',
      'csec',
      ['read'],
      { redis: testRedis, audience: 'https://api.example.com/' },
    );

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const request = fetchCall[1] as RequestInit | undefined;
    const body = request?.body;
    const encodedBody =
      body instanceof URLSearchParams ? body.toString() : body ? String(body) : undefined;
    expect(encodedBody).toContain('audience=https%3A%2F%2Fapi.example.com%2F');
  });

  it('bumping profileVersion produces a fresh cache key (event-driven invalidation)', async () => {
    mockRedis.get.mockResolvedValue(null);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'a', expires_in: 3600 }),
    });

    await resolveClientCredentialsToken(
      'prof-1',
      'tenant-1',
      1,
      'https://auth.example.com/token',
      'cid',
      'csec',
      ['read'],
      { redis: testRedis },
    );
    await resolveClientCredentialsToken(
      'prof-1',
      'tenant-1',
      2,
      'https://auth.example.com/token',
      'cid',
      'csec',
      ['read'],
      { redis: testRedis },
    );

    const v1Key = expectedCacheKey('tenant-1', 'prof-1', 1, ['read']);
    const v2Key = expectedCacheKey('tenant-1', 'prof-1', 2, ['read']);
    expect(v1Key).not.toBe(v2Key);
    expect(mockRedis.get).toHaveBeenNthCalledWith(1, v1Key);
    expect(mockRedis.get).toHaveBeenNthCalledWith(2, v2Key);
  });

  it('different scope lists produce different cache keys; sort order does not', async () => {
    mockRedis.get.mockResolvedValue(null);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'a', expires_in: 3600 }),
    });

    const sameKeyA = expectedCacheKey('tenant-1', 'prof-1', 1, ['read', 'write']);
    const sameKeyB = expectedCacheKey('tenant-1', 'prof-1', 1, ['write', 'read']);
    expect(sameKeyA).toBe(sameKeyB);

    const narrowKey = expectedCacheKey('tenant-1', 'prof-1', 1, ['read']);
    const wideKey = expectedCacheKey('tenant-1', 'prof-1', 1, ['read', 'write']);
    expect(narrowKey).not.toBe(wideKey);
  });

  it('continues token exchange when cache delete fails for invalid cached payload', async () => {
    mockRedis.get.mockResolvedValue('{"broken-json"');
    mockRedis.del.mockRejectedValue(new Error('redis down'));
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'fresh-at', expires_in: 3600 }),
    });

    const result = await resolveClientCredentialsToken(
      'prof-1',
      'tenant-1',
      1,
      'https://auth.example.com/token',
      'cid',
      'csec',
      [],
      { redis: testRedis },
    );

    expect(result).toMatchObject({ accessToken: 'fresh-at', cached: false });
    expect(mockRedis.del).toHaveBeenCalled();
  });

  it('rejects non-HTTPS token URLs at service boundary', async () => {
    await expect(
      resolveClientCredentialsToken(
        'prof-1',
        'tenant-1',
        1,
        'http://example.com/oauth/token',
        'cid',
        'csec',
        [],
        {},
      ),
    ).rejects.toThrow(/must use HTTPS/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects SSRF-unsafe token URLs at service boundary', async () => {
    await expect(
      resolveClientCredentialsToken(
        'prof-1',
        'tenant-1',
        1,
        'https://169.254.169.254/latest/meta-data/iam/security-credentials',
        'cid',
        'csec',
        [],
        {},
      ),
    ).rejects.toThrow(/Blocked/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects malformed token payloads before caching them', async () => {
    mockRedis.get.mockResolvedValue(null);

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        expires_in: 3600,
      }),
    });

    await expect(
      resolveClientCredentialsToken(
        'prof-1',
        'tenant-1',
        1,
        'https://auth.example.com/token',
        'cid',
        'csec',
        [],
        { redis: testRedis },
      ),
    ).rejects.toThrow(/invalid access_token/);

    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it('caches with default TTL when provider omits expires_in (avoids hammering token endpoint)', async () => {
    mockRedis.get.mockResolvedValue(null);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'at-no-expiry',
        // expires_in deliberately omitted
      }),
    });

    const result = await resolveClientCredentialsToken(
      'prof-1',
      'tenant-1',
      1,
      'https://auth.example.com/token',
      'cid',
      'csec',
      [],
      { redis: testRedis },
    );

    expect(result.accessToken).toBe('at-no-expiry');
    expect(result.cached).toBe(false);
    // Without expires_in the result has no expiresAt — that is preserved for callers.
    expect(result.expiresAt).toBeUndefined();

    // But the Redis write MUST still happen, with default fallback TTL (10 min)
    // and a synthesized cachedExpiresAt so cache reads remain valid.
    expect(mockRedis.set).toHaveBeenCalledTimes(1);
    const [, cachedJson, exFlag, ttlSecs] = mockRedis.set.mock.calls[0];
    expect(exFlag).toBe('EX');
    expect(ttlSecs).toBe(600);
    const parsed = JSON.parse(cachedJson);
    expect(parsed.accessToken).toBe('at-no-expiry');
    expect(typeof parsed.expiresAt).toBe('string');
  });

  it('surfaces RFC 6749 error/error_description from a failed exchange (B.2)', async () => {
    mockRedis.get.mockResolvedValue(null);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 401,
      text: async () =>
        JSON.stringify({
          error: 'invalid_client',
          error_description: 'Wrong client_secret',
        }),
    });

    await expect(
      resolveClientCredentialsToken(
        'prof-1',
        'tenant-1',
        1,
        'https://auth.example.com/token',
        'cid',
        'wrong-secret',
        ['read'],
        { redis: testRedis },
      ),
    ).rejects.toThrow(/status 401: invalid_client: Wrong client_secret/);
  });

  it('emits AUTH_PROFILE_CC_PROVIDER_ERROR code on exchange failure', async () => {
    mockRedis.get.mockResolvedValue(null);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 403,
      text: async () =>
        JSON.stringify({ error: 'unauthorized_client', error_description: 'No CC grant' }),
    });

    let caught: unknown = null;
    try {
      await resolveClientCredentialsToken(
        'prof-1',
        'tenant-1',
        1,
        'https://auth.example.com/token',
        'cid',
        'csec',
        ['read'],
        { redis: testRedis },
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeTruthy();
    expect((caught as { code?: string }).code).toBe('AUTH_PROFILE_CC_PROVIDER_ERROR');
    expect((caught as { statusCode?: number }).statusCode).toBe(403);
  });

  it('caps non-JSON error response bodies at 200 chars and includes them as raw detail', async () => {
    mockRedis.get.mockResolvedValue(null);
    const longHtml = '<html><body>' + 'x'.repeat(500) + '</body></html>';
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => longHtml,
    });

    let message = '';
    try {
      await resolveClientCredentialsToken(
        'prof-1',
        'tenant-1',
        1,
        'https://auth.example.com/token',
        'cid',
        'csec',
        [],
        { redis: testRedis },
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain('status 500');
    // Detail must be present (provider returned a body) but capped at 200 chars
    const detailPart = message.split('status 500: ')[1] ?? '';
    expect(detailPart.length).toBeGreaterThan(0);
    expect(detailPart.length).toBeLessThanOrEqual(200);
  });

  it('handles failed exchanges with empty body (no detail string appended)', async () => {
    mockRedis.get.mockResolvedValue(null);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => '',
    });

    let message = '';
    try {
      await resolveClientCredentialsToken(
        'prof-1',
        'tenant-1',
        1,
        'https://auth.example.com/token',
        'cid',
        'csec',
        [],
        { redis: testRedis },
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toBe('Client credentials exchange failed with status 502');
  });
});
