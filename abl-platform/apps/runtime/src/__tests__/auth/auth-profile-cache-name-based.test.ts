import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthProfileCache } from '../../services/auth-profile/auth-profile-cache.js';

describe('AuthProfileCache — name-based lookups', () => {
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

  it('returns null on name-based cache miss', () => {
    expect(cache.getByName('t1', 'my-profile', null)).toBeNull();
  });

  it('returns cached credentials for name-based lookup', () => {
    cache.setByName('t1', 'my-profile', null, creds);
    const result = cache.getByName('t1', 'my-profile', null);
    expect(result).toEqual(creds);
  });

  it('separates name-based and id-based cache entries', () => {
    const ck1 = {
      tenantId: 't1',
      authType: 'api_key',
      profileId: 'prof-1',
      profileVersion: 1,
      scopeHash: '',
    };
    cache.set(ck1, { ...creds, profileId: 'id-based' });
    cache.setByName('t1', 'my-profile', null, { ...creds, profileId: 'name-based' });

    expect(cache.get(ck1)?.profileId).toBe('id-based');
    expect(cache.getByName('t1', 'my-profile', null)?.profileId).toBe('name-based');
  });

  it('returns null after TTL expiry for name-based entries', () => {
    cache.setByName('t1', 'my-profile', null, creds, 1000);
    vi.advanceTimersByTime(1001);
    expect(cache.getByName('t1', 'my-profile', null)).toBeNull();
  });

  it('invalidateByName removes name-based entries', () => {
    cache.setByName('t1', 'my-profile', 'prod', creds);
    cache.setByName('t1', 'my-profile', 'staging', creds);
    cache.setByName('t1', 'other-profile', 'prod', creds);

    cache.invalidateByName('t1', 'my-profile');

    expect(cache.getByName('t1', 'my-profile', 'prod')).toBeNull();
    expect(cache.getByName('t1', 'my-profile', 'staging')).toBeNull();
    expect(cache.getByName('t1', 'other-profile', 'prod')).not.toBeNull();
  });

  it('tenant-level invalidate clears both id-based and name-based entries', () => {
    const ck1 = {
      tenantId: 't1',
      authType: 'api_key',
      profileId: 'prof-1',
      profileVersion: 1,
      scopeHash: '',
    };
    cache.set(ck1, creds);
    cache.setByName('t1', 'my-profile', null, creds);
    cache.setByName('t2', 'my-profile', null, creds);

    cache.invalidate('t1');

    expect(cache.get(ck1)).toBeNull();
    expect(cache.getByName('t1', 'my-profile', null)).toBeNull();
    expect(cache.getByName('t2', 'my-profile', null)).not.toBeNull();
  });

  it('handles environment in name-based cache key', () => {
    cache.setByName('t1', 'profile', null, { ...creds, profileId: 'null-env' });
    cache.setByName('t1', 'profile', 'prod', { ...creds, profileId: 'prod-env' });

    expect(cache.getByName('t1', 'profile', null)?.profileId).toBe('null-env');
    expect(cache.getByName('t1', 'profile', 'prod')?.profileId).toBe('prod-env');
  });

  it('name-based entries count toward max capacity', () => {
    const small = new AuthProfileCache(3);
    small.setByName('t1', 'p1', null, { ...creds, profileId: 'p1' });
    small.setByName('t1', 'p2', null, { ...creds, profileId: 'p2' });
    small.setByName('t1', 'p3', null, { ...creds, profileId: 'p3' });
    // Adding a 4th should evict oldest
    small.setByName('t1', 'p4', null, { ...creds, profileId: 'p4' });
    expect(small.getByName('t1', 'p1', null)).toBeNull();
    expect(small.getByName('t1', 'p4', null)).toEqual({ ...creds, profileId: 'p4' });
    expect(small.size).toBe(3);
  });
});
