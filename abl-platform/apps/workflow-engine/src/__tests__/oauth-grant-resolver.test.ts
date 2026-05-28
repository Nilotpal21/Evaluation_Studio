/**
 * OAuthGrantResolver — unit tests for the durable EndUserOAuthToken lookup
 * + proactive refresh service.
 *
 * Strategy:
 *   - The module is already DI-shaped: tokenModel, authProfileModel,
 *     encryption, and redis are injected. Tests inject in-memory fakes.
 *   - No vi.mock of internal packages or relative imports.
 *   - Injects a safeFetch test double for the refresh HTTP call.
 *
 * Covers the resolver's contract:
 *   - Null when no grant exists for either user-specific or tenant-shared principal.
 *   - User-specific grant takes priority; falls back to tenant-shared.
 *   - Valid (not near expiry) tokens are returned as-is (after decrypt).
 *   - Tokens near expiry are refreshed, persisted, and returned.
 *   - tokenUrl must be HTTPS (SSRF guard).
 *   - Refresh failure returns the existing token (fallback path).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createOAuthGrantResolver,
  type AuthProfileModel,
  type EncryptionFacade,
  type OAuthGrantResolverDeps,
  type OAuthTokenModel,
  type RedisLike,
} from '../services/oauth-grant-resolver.js';

// ─── Test doubles ───────────────────────────────────────────────────────────

interface TokenRow {
  _id: string;
  tenantId: string;
  userId: string;
  provider: string;
  encryptedAccessToken?: string;
  encryptedRefreshToken?: string;
  expiresAt?: Date;
  revokedAt?: Date | null;
}

/** In-memory OAuthTokenModel — supports findOne+lean and collection.updateOne. */
function makeTokenModel(rows: TokenRow[]): OAuthTokenModel & { _rows: TokenRow[] } {
  const rowsRef = rows;
  return {
    _rows: rowsRef,
    findOne(filter: Record<string, unknown>) {
      const match =
        rowsRef.find((r) =>
          Object.entries(filter).every(([k, v]) => (r as Record<string, unknown>)[k] === v),
        ) ?? null;
      return {
        lean: async () => (match ? { ...match } : null),
      };
    },
    collection: {
      updateOne: vi.fn(async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
        // ABLP-1123: resolver now filters on revokedAt: null in its refresh
        // write-back and aborts when matchedCount === 0, so the stub must
        // honor that filter and report a matchedCount the real driver would.
        const target = rowsRef.find(
          (r) =>
            r._id === filter._id &&
            r.tenantId === filter.tenantId &&
            (filter.revokedAt === undefined || r.revokedAt === filter.revokedAt),
        );
        if (target && update.$set) Object.assign(target, update.$set);
        return { acknowledged: true, matchedCount: target ? 1 : 0, modifiedCount: target ? 1 : 0 };
      }),
    },
  };
}

function makeAuthProfileModel(
  profile: {
    _id: string;
    tenantId: string;
    encryptedSecrets: string | Record<string, unknown> | null;
    config?: Record<string, unknown>;
    status?: string;
    enabled?: boolean;
  } | null,
): AuthProfileModel {
  return {
    findOne(filter: Record<string, unknown>) {
      if (!profile) return { lean: async () => null };
      // Honour enabled: { $ne: false } and status: { $ne: 'revoked' } operator filters
      // so tests can exercise the F-3 / F-4 gate without a real Mongo driver.
      const enabledFilter = filter.enabled as { $ne?: unknown } | undefined;
      if (enabledFilter?.$ne !== undefined && profile.enabled === enabledFilter.$ne) {
        return { lean: async () => null };
      }
      const statusFilter = filter.status as { $ne?: unknown } | undefined;
      if (statusFilter?.$ne !== undefined && profile.status === statusFilter.$ne) {
        return { lean: async () => null };
      }
      return { lean: async () => ({ ...profile }) };
    },
  };
}

/** Plaintext-passthrough encryption — decrypt is the identity for tokens that
 *  pass the "looks like ciphertext" heuristic; for production DEK ciphertext
 *  values we use long base64-only strings in tests. */
function makeEncryption(): EncryptionFacade {
  return {
    encrypt: vi.fn((plaintext: string) => `enc(${plaintext})`),
    decrypt: vi.fn((ciphertext: string) => {
      const m = /^enc\((.+)\)$/.exec(ciphertext);
      return m ? m[1] : ciphertext;
    }),
  };
}

function makeRedis(opts?: { lockBusy?: boolean }): RedisLike & { setCalls: number } {
  let setCalls = 0;
  const redis = {
    set: vi.fn(async () => {
      setCalls++;
      return opts?.lockBusy ? null : ('OK' as const);
    }),
    eval: vi.fn(async () => 1),
    get setCalls() {
      return setCalls;
    },
  };
  return redis as unknown as RedisLike & { setCalls: number };
}

// Stored token values must pass isDEKEnvelopeFormat() — base64 with a valid
// DEK wire header (dekIdLen byte 5-50, printable ASCII dekId, min length for
// IV+authTag). safeDecrypt() was updated from a naive base64 regex to this
// stricter check to avoid double-decrypting Zendesk/ServiceNow hex tokens.
// Wire format: base64(dekIdLen[1] + dekId[N] + iv[12] + authTag[16] + ciphertext)
const ENC_ACCESS = Buffer.concat([
  Buffer.from([8]),
  Buffer.from('dek-id-1'),
  Buffer.alloc(12),
  Buffer.alloc(16),
  Buffer.from('access-ciphertext'),
]).toString('base64');
const ENC_REFRESH = Buffer.concat([
  Buffer.from([8]),
  Buffer.from('dek-id-2'),
  Buffer.alloc(12),
  Buffer.alloc(16),
  Buffer.from('refresh-ciphertext'),
]).toString('base64');

const originalFetch = globalThis.fetch;
const mockSafeFetch = vi.fn();

beforeEach(() => {
  mockSafeFetch.mockReset();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function createTestResolver(
  deps: OAuthGrantResolverDeps,
): ReturnType<typeof createOAuthGrantResolver> {
  return createOAuthGrantResolver({ safeFetch: mockSafeFetch, ...deps });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('createOAuthGrantResolver — lookup', () => {
  it('returns null when no grant exists for user or tenant-shared principal', async () => {
    const resolver = createTestResolver({
      tokenModel: makeTokenModel([]),
      authProfileModel: makeAuthProfileModel(null),
      encryption: makeEncryption(),
    });

    const result = await resolver.resolveGrant({
      authProfileId: 'ap-1',
      tenantId: 't1',
      userId: 'u-alice',
    });

    expect(result).toBeNull();
  });

  it('prefers a user-specific grant over the tenant-shared one', async () => {
    const resolver = createTestResolver({
      tokenModel: makeTokenModel([
        {
          _id: 'g-user',
          tenantId: 't1',
          userId: 'u-alice',
          provider: 'auth-profile:ap-1',
          encryptedAccessToken: 'user-token',
          revokedAt: null,
        },
        {
          _id: 'g-shared',
          tenantId: 't1',
          userId: '__tenant__',
          provider: 'auth-profile:ap-1',
          encryptedAccessToken: 'shared-token',
          revokedAt: null,
        },
      ]),
      authProfileModel: makeAuthProfileModel(null),
      encryption: makeEncryption(),
    });

    const result = await resolver.resolveGrant({
      authProfileId: 'ap-1',
      tenantId: 't1',
      userId: 'u-alice',
    });

    expect(result).toEqual({ access_token: 'user-token' });
  });

  it('falls back to the tenant-shared grant when the user-specific one is missing', async () => {
    const resolver = createTestResolver({
      tokenModel: makeTokenModel([
        {
          _id: 'g-shared',
          tenantId: 't1',
          userId: '__tenant__',
          provider: 'auth-profile:ap-1',
          encryptedAccessToken: 'shared-token',
          encryptedRefreshToken: 'shared-refresh',
          revokedAt: null,
        },
      ]),
      authProfileModel: makeAuthProfileModel(null),
      encryption: makeEncryption(),
    });

    const result = await resolver.resolveGrant({
      authProfileId: 'ap-1',
      tenantId: 't1',
      userId: 'u-alice',
    });

    expect(result).toEqual({
      access_token: 'shared-token',
      refresh_token: 'shared-refresh',
    });
  });

  it('only looks up the tenant-shared grant when no userId is supplied', async () => {
    const resolver = createTestResolver({
      tokenModel: makeTokenModel([
        {
          _id: 'g-shared',
          tenantId: 't1',
          userId: '__tenant__',
          provider: 'auth-profile:ap-1',
          encryptedAccessToken: 'shared-only',
          revokedAt: null,
        },
      ]),
      authProfileModel: makeAuthProfileModel(null),
      encryption: makeEncryption(),
    });

    const result = await resolver.resolveGrant({ authProfileId: 'ap-1', tenantId: 't1' });

    expect(result).toEqual({ access_token: 'shared-only' });
  });
});

describe('createOAuthGrantResolver — refresh', () => {
  it('returns the stored token unchanged when it is well before expiry', async () => {
    const farFuture = new Date(Date.now() + 60 * 60 * 1000); // 1h from now
    const encryption = makeEncryption();
    const resolver = createTestResolver({
      tokenModel: makeTokenModel([
        {
          _id: 'g-1',
          tenantId: 't1',
          userId: 'u-alice',
          provider: 'auth-profile:ap-1',
          encryptedAccessToken: ENC_ACCESS,
          encryptedRefreshToken: ENC_REFRESH,
          expiresAt: farFuture,
          revokedAt: null,
        },
      ]),
      authProfileModel: makeAuthProfileModel(null),
      encryption,
    });

    const result = await resolver.resolveGrant({
      authProfileId: 'ap-1',
      tenantId: 't1',
      userId: 'u-alice',
    });

    expect(result?.access_token).toBe(ENC_ACCESS);
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });

  it('refreshes a token inside the 5-minute expiry buffer and persists the new values', async () => {
    const nearExpiry = new Date(Date.now() + 60 * 1000); // 60s from now → inside 5-min buffer
    const rows: TokenRow[] = [
      {
        _id: 'g-1',
        tenantId: 't1',
        userId: 'u-alice',
        provider: 'auth-profile:ap-1',
        encryptedAccessToken: ENC_ACCESS,
        encryptedRefreshToken: ENC_REFRESH,
        expiresAt: nearExpiry,
        revokedAt: null,
      },
    ];
    const tokenModel = makeTokenModel(rows);
    const encryption = makeEncryption();

    mockSafeFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          access_token: 'fresh-access',
          refresh_token: 'fresh-refresh',
          expires_in: 3600,
        }),
      headers: { get: () => 'application/json' },
    });

    const resolver = createTestResolver({
      tokenModel,
      authProfileModel: makeAuthProfileModel({
        _id: 'ap-1',
        tenantId: 't1',
        encryptedSecrets: { clientId: 'cid', clientSecret: 'csec' },
        config: { tokenUrl: 'https://auth.example.com/token' },
      }),
      encryption,
    });

    const result = await resolver.resolveGrant({
      authProfileId: 'ap-1',
      tenantId: 't1',
      userId: 'u-alice',
    });

    expect(result).toEqual({
      access_token: 'fresh-access',
      refresh_token: 'fresh-refresh',
    });
    // Confirm we sent a refresh_token grant to the provider.
    const [url, init] = mockSafeFetch.mock.calls[0];
    expect(url).toBe('https://auth.example.com/token');
    expect(init.method).toBe('POST');
    const bodyParams = new URLSearchParams(init.body as string);
    expect(bodyParams.get('grant_type')).toBe('refresh_token');
    expect(bodyParams.get('refresh_token')).toBe(ENC_REFRESH);
    expect(bodyParams.get('client_id')).toBe('cid');
    expect(bodyParams.get('client_secret')).toBe('csec');

    // Persisted write-back went through updateOne with encrypted values.
    expect(tokenModel.collection.updateOne).toHaveBeenCalledTimes(1);
    const updateArgs = (tokenModel.collection.updateOne as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as { $set: Record<string, unknown> };
    expect(updateArgs.$set.encryptedAccessToken).toBe('enc(fresh-access)');
    expect(updateArgs.$set.encryptedRefreshToken).toBe('enc(fresh-refresh)');
    expect(updateArgs.$set.expiresAt).toBeInstanceOf(Date);
  });

  it('rejects non-HTTPS tokenUrl (SSRF guard) and returns the existing token as fallback', async () => {
    const nearExpiry = new Date(Date.now() + 30 * 1000);
    const resolver = createTestResolver({
      tokenModel: makeTokenModel([
        {
          _id: 'g-1',
          tenantId: 't1',
          userId: 'u-alice',
          provider: 'auth-profile:ap-1',
          encryptedAccessToken: ENC_ACCESS,
          encryptedRefreshToken: ENC_REFRESH,
          expiresAt: nearExpiry,
          revokedAt: null,
        },
      ]),
      authProfileModel: makeAuthProfileModel({
        _id: 'ap-1',
        tenantId: 't1',
        encryptedSecrets: { clientId: 'cid', clientSecret: 'csec' },
        // http:// is blocked — refresh throws, resolver falls through to the stored token
        config: { tokenUrl: 'http://internal.service/token' },
      }),
      encryption: makeEncryption(),
    });

    const result = await resolver.resolveGrant({
      authProfileId: 'ap-1',
      tenantId: 't1',
      userId: 'u-alice',
    });

    expect(mockSafeFetch).not.toHaveBeenCalled();
    // Refresh was attempted and failed → return the existing decrypted token.
    expect(result?.access_token).toBe(ENC_ACCESS);
  });

  it('falls back to the existing token when safeFetch blocks a metadata tokenUrl', async () => {
    const nearExpiry = new Date(Date.now() + 30 * 1000);
    mockSafeFetch.mockRejectedValueOnce(new Error('URL resolved to a blocked metadata address'));
    const resolver = createTestResolver({
      tokenModel: makeTokenModel([
        {
          _id: 'g-1',
          tenantId: 't1',
          userId: 'u-alice',
          provider: 'auth-profile:ap-1',
          encryptedAccessToken: ENC_ACCESS,
          encryptedRefreshToken: ENC_REFRESH,
          expiresAt: nearExpiry,
          revokedAt: null,
        },
      ]),
      authProfileModel: makeAuthProfileModel({
        _id: 'ap-1',
        tenantId: 't1',
        encryptedSecrets: { clientId: 'cid', clientSecret: 'csec' },
        config: { tokenUrl: 'https://metadata.google.internal/token' },
      }),
      encryption: makeEncryption(),
    });

    const result = await resolver.resolveGrant({
      authProfileId: 'ap-1',
      tenantId: 't1',
      userId: 'u-alice',
    });

    expect(mockSafeFetch).toHaveBeenCalledWith(
      'https://metadata.google.internal/token',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result?.access_token).toBe(ENC_ACCESS);
  });

  it('falls back to the existing token when the refresh endpoint returns an error', async () => {
    const nearExpiry = new Date(Date.now() + 30 * 1000);
    mockSafeFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: 'invalid_grant' }),
    });
    const resolver = createTestResolver({
      tokenModel: makeTokenModel([
        {
          _id: 'g-1',
          tenantId: 't1',
          userId: 'u-alice',
          provider: 'auth-profile:ap-1',
          encryptedAccessToken: ENC_ACCESS,
          encryptedRefreshToken: ENC_REFRESH,
          expiresAt: nearExpiry,
          revokedAt: null,
        },
      ]),
      authProfileModel: makeAuthProfileModel({
        _id: 'ap-1',
        tenantId: 't1',
        encryptedSecrets: { clientId: 'cid', clientSecret: 'csec' },
        config: { tokenUrl: 'https://auth.example.com/token' },
      }),
      encryption: makeEncryption(),
    });

    const result = await resolver.resolveGrant({
      authProfileId: 'ap-1',
      tenantId: 't1',
      userId: 'u-alice',
    });

    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
    expect(result?.access_token).toBe(ENC_ACCESS);
  });

  it('acquires the Redis refresh lock when provided and releases it on success', async () => {
    const nearExpiry = new Date(Date.now() + 30 * 1000);
    mockSafeFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ access_token: 'fresh', expires_in: 3600 }),
      headers: { get: () => 'application/json' },
    });
    const redis = makeRedis();
    const resolver = createTestResolver({
      tokenModel: makeTokenModel([
        {
          _id: 'g-1',
          tenantId: 't1',
          userId: 'u-alice',
          provider: 'auth-profile:ap-1',
          encryptedAccessToken: ENC_ACCESS,
          encryptedRefreshToken: ENC_REFRESH,
          expiresAt: nearExpiry,
          revokedAt: null,
        },
      ]),
      authProfileModel: makeAuthProfileModel({
        _id: 'ap-1',
        tenantId: 't1',
        encryptedSecrets: { clientId: 'cid', clientSecret: 'csec' },
        config: { tokenUrl: 'https://auth.example.com/token' },
      }),
      encryption: makeEncryption(),
      redis,
    });

    const result = await resolver.resolveGrant({
      authProfileId: 'ap-1',
      tenantId: 't1',
      userId: 'u-alice',
    });

    expect(result?.access_token).toBe('fresh');
    expect(redis.set).toHaveBeenCalledTimes(1);
    const setCall = (redis.set as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(setCall[0]).toMatch(/^oauth-grant-refresh:g-1$/);
    expect(setCall[2]).toBe('NX');
    expect(setCall[3]).toBe('PX');
    // Lock released via eval (compare-and-delete Lua).
    expect(redis.eval).toHaveBeenCalledTimes(1);
  });

  it('falls back to the existing token (no refresh) when the app profile is disabled (F-3)', async () => {
    // A disabled app profile must NOT have its client credentials used to mint
    // fresh tokens. The resolver should fall through to return the (possibly
    // near-expiry) existing token rather than call the provider.
    const nearExpiry = new Date(Date.now() + 30 * 1000);
    const resolver = createTestResolver({
      tokenModel: makeTokenModel([
        {
          _id: 'g-1',
          tenantId: 't1',
          userId: 'u-alice',
          provider: 'auth-profile:ap-1',
          encryptedAccessToken: ENC_ACCESS,
          encryptedRefreshToken: ENC_REFRESH,
          expiresAt: nearExpiry,
          revokedAt: null,
        },
      ]),
      // App profile has enabled:false — refreshGrantToken must block it
      authProfileModel: makeAuthProfileModel({
        _id: 'ap-1',
        tenantId: 't1',
        encryptedSecrets: { clientId: 'cid', clientSecret: 'csec' },
        config: { tokenUrl: 'https://auth.example.com/token' },
        enabled: false,
      }),
      encryption: makeEncryption(),
    });

    const result = await resolver.resolveGrant({
      authProfileId: 'ap-1',
      tenantId: 't1',
      userId: 'u-alice',
    });

    // Disabled app profile → refresh blocked → fall through to existing token
    expect(result?.access_token).toBe(ENC_ACCESS);
    // Provider must NOT have been called with client credentials
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });
});
