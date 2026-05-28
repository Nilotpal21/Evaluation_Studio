import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AuthProfileCache,
  computeScopeHash,
  type CK1KeyParts,
} from '../../services/auth-profile/auth-profile-cache.js';

describe('AuthProfileCache (CK-1)', () => {
  let cache: AuthProfileCache;

  beforeEach(() => {
    cache = new AuthProfileCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const creds = {
    profileId: 'prof-1',
    authType: 'api_key',
    config: { baseUrl: 'https://example.com' },
    secrets: { apiKey: 'sk-test' },
  };

  function ck1(overrides: Partial<CK1KeyParts> = {}): CK1KeyParts {
    return {
      tenantId: 't1',
      authType: 'api_key',
      profileId: 'prof-1',
      profileVersion: 1,
      scopeHash: '',
      ...overrides,
    };
  }

  it('returns null on cache miss', () => {
    expect(cache.get(ck1())).toBeNull();
  });

  it('returns cached credentials on hit', () => {
    cache.set(ck1(), creds);
    expect(cache.get(ck1())).toEqual(creds);
  });

  it('returns null after TTL expiry', () => {
    cache.set(ck1(), creds, 1000);
    vi.advanceTimersByTime(1001);
    expect(cache.get(ck1())).toBeNull();
  });

  it('returns null when updatedAt freshness metadata changes', () => {
    const updatedAt = new Date('2026-03-18T10:00:00.000Z');
    cache.set(ck1(), creds, 5000, { updatedAt });

    expect(cache.get(ck1(), { updatedAt: new Date('2026-03-18T10:05:00.000Z') })).toBeNull();
  });

  it('returns cached credentials when freshness metadata still matches', () => {
    const updatedAt = new Date('2026-03-18T10:00:00.000Z');
    const expiresAt = new Date('2026-03-19T10:00:00.000Z');
    cache.set(ck1(), creds, 5000, { updatedAt, expiresAt });

    expect(cache.get(ck1(), { updatedAt, expiresAt })).toEqual(creds);
  });

  it('evicts oldest entry when max capacity reached', () => {
    const small = new AuthProfileCache(3);
    small.set(ck1({ profileId: 'p1' }), { ...creds, profileId: 'p1' });
    small.set(ck1({ profileId: 'p2' }), { ...creds, profileId: 'p2' });
    small.set(ck1({ profileId: 'p3' }), { ...creds, profileId: 'p3' });
    small.set(ck1({ profileId: 'p4' }), { ...creds, profileId: 'p4' });
    expect(small.get(ck1({ profileId: 'p1' }))).toBeNull();
    expect(small.get(ck1({ profileId: 'p4' }))).toEqual({ ...creds, profileId: 'p4' });
    expect(small.size).toBe(3);
  });

  it('LRU: accessing an entry moves it to end, preventing eviction', () => {
    const small = new AuthProfileCache(3);
    small.set(ck1({ profileId: 'p1' }), { ...creds, profileId: 'p1' });
    small.set(ck1({ profileId: 'p2' }), { ...creds, profileId: 'p2' });
    small.set(ck1({ profileId: 'p3' }), { ...creds, profileId: 'p3' });
    small.get(ck1({ profileId: 'p1' }));
    small.set(ck1({ profileId: 'p4' }), { ...creds, profileId: 'p4' });
    expect(small.get(ck1({ profileId: 'p1' }))).not.toBeNull();
    expect(small.get(ck1({ profileId: 'p2' }))).toBeNull();
  });

  it('invalidates all entries for a tenant', () => {
    cache.set(ck1({ tenantId: 't1', profileId: 'p1' }), creds);
    cache.set(ck1({ tenantId: 't1', profileId: 'p2' }), creds);
    cache.set(ck1({ tenantId: 't2', profileId: 'p3' }), creds);
    cache.invalidate('t1');
    expect(cache.get(ck1({ tenantId: 't1', profileId: 'p1' }))).toBeNull();
    expect(cache.get(ck1({ tenantId: 't1', profileId: 'p2' }))).toBeNull();
    expect(cache.get(ck1({ tenantId: 't2', profileId: 'p3' }))).not.toBeNull();
  });

  it('invalidates entries for a specific profile within a tenant', () => {
    cache.set(ck1({ tenantId: 't1', profileId: 'p1', profileVersion: 1 }), creds);
    cache.set(ck1({ tenantId: 't1', profileId: 'p1', profileVersion: 2 }), creds);
    cache.set(ck1({ tenantId: 't1', profileId: 'p2' }), creds);
    cache.invalidate('t1', 'p1');
    expect(cache.get(ck1({ tenantId: 't1', profileId: 'p1', profileVersion: 1 }))).toBeNull();
    expect(cache.get(ck1({ tenantId: 't1', profileId: 'p1', profileVersion: 2 }))).toBeNull();
    expect(cache.get(ck1({ tenantId: 't1', profileId: 'p2' }))).not.toBeNull();
  });

  it('clear() removes all entries', () => {
    cache.set(ck1({ tenantId: 't1', profileId: 'p1' }), creds);
    cache.set(ck1({ tenantId: 't2', profileId: 'p2' }), creds);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('enforces max 200 entries by default', () => {
    const defaultCache = new AuthProfileCache();
    for (let i = 0; i < 201; i++) {
      defaultCache.set(ck1({ profileId: `p${i}` }), { ...creds, profileId: `p${i}` });
    }
    expect(defaultCache.size).toBe(200);
    expect(defaultCache.get(ck1({ profileId: 'p0' }))).toBeNull();
    expect(defaultCache.get(ck1({ profileId: 'p200' }))).not.toBeNull();
  });
});

describe('AuthProfileCache — CK-1 key isolation', () => {
  const creds = {
    profileId: 'prof-1',
    authType: 'api_key',
    config: {},
    secrets: { apiKey: 'sk-test' },
  };

  function ck1(overrides: Partial<CK1KeyParts> = {}): CK1KeyParts {
    return {
      tenantId: 't1',
      authType: 'api_key',
      profileId: 'prof-1',
      profileVersion: 1,
      scopeHash: '',
      ...overrides,
    };
  }

  it('isolates entries across tenants (TI-1)', () => {
    const cache = new AuthProfileCache();
    cache.set(ck1({ tenantId: 't1' }), { ...creds, secrets: { apiKey: 'tenant-1-key' } });
    expect(cache.get(ck1({ tenantId: 't2' }))).toBeNull();
  });

  it('isolates entries across authTypes', () => {
    const cache = new AuthProfileCache();
    cache.set(ck1({ authType: 'api_key' }), { ...creds, secrets: { apiKey: 'k' } });
    expect(cache.get(ck1({ authType: 'bearer' }))).toBeNull();
  });

  it('invalidates on profileVersion bump (event-driven cache invalidation)', () => {
    const cache = new AuthProfileCache();
    cache.set(ck1({ profileVersion: 1 }), { ...creds, secrets: { apiKey: 'old' } });
    expect(cache.get(ck1({ profileVersion: 1 }))?.secrets).toEqual({ apiKey: 'old' });
    expect(cache.get(ck1({ profileVersion: 2 }))).toBeNull();
  });

  it('isolates entries across scopeHash values', () => {
    const cache = new AuthProfileCache();
    const aHash = computeScopeHash(['read']);
    const bHash = computeScopeHash(['read', 'write']);
    cache.set(ck1({ scopeHash: aHash }), { ...creds, secrets: { apiKey: 'narrow' } });
    expect(cache.get(ck1({ scopeHash: bHash }))).toBeNull();
    expect(cache.get(ck1({ scopeHash: aHash }))?.secrets).toEqual({ apiKey: 'narrow' });
  });

  it('isolates entries across principalId for per-user grants', () => {
    const cache = new AuthProfileCache();
    cache.set(ck1({ principalKind: 'user', principalId: 'user-A' }), {
      ...creds,
      secrets: { token: 'A' },
    });
    expect(cache.get(ck1({ principalKind: 'user', principalId: 'user-B' }))).toBeNull();
  });

  it('treats omitted principal as distinct from any user-keyed principal', () => {
    const cache = new AuthProfileCache();
    cache.set(ck1(), { ...creds, secrets: { apiKey: 'shared' } });
    expect(cache.get(ck1({ principalKind: 'user', principalId: 'u1' }))).toBeNull();
  });
});

describe('computeScopeHash', () => {
  it('returns empty string for missing input', () => {
    expect(computeScopeHash(undefined)).toBe('');
    expect(computeScopeHash(null)).toBe('');
    expect(computeScopeHash([])).toBe('');
    expect(computeScopeHash('')).toBe('');
  });

  it('is order-independent (sorts before hashing)', () => {
    const a = computeScopeHash(['read', 'write', 'delete']);
    const b = computeScopeHash(['delete', 'read', 'write']);
    expect(a).toBe(b);
  });

  it('treats space-separated and comma-separated input identically when normalized', () => {
    const a = computeScopeHash('read write');
    const b = computeScopeHash('read,write');
    expect(a).toBe(b);
  });

  it('produces a stable 64-char hex digest', () => {
    expect(computeScopeHash(['read'])).toMatch(/^[0-9a-f]{64}$/);
  });
});
