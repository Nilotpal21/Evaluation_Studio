import { describe, it, expect } from 'vitest';
import { applyHawkAuth } from '../hawk-auth.js';

describe('applyHawkAuth', () => {
  const config = { algorithm: 'sha256' as const };
  const secrets = { id: 'hawk-id-1', key: 'hawk-secret-key' };

  it('returns an Authorization header starting with "Hawk"', () => {
    const result = applyHawkAuth(config, secrets, 'https://example.com/api/data', 'GET');
    expect(result.headers.Authorization).toMatch(/^Hawk /);
  });

  it('includes required Hawk fields (id, ts, nonce, mac)', () => {
    const result = applyHawkAuth(config, secrets, 'https://example.com/api/data', 'GET');
    const auth = result.headers.Authorization;

    expect(auth).toContain('id="hawk-id-1"');
    expect(auth).toMatch(/ts="\d+"/);
    expect(auth).toMatch(/nonce="[a-f0-9]+"/);
    expect(auth).toMatch(/mac="[A-Za-z0-9+/=]+"/);
  });

  it('uses provided timestamp and nonce', () => {
    const result = applyHawkAuth(config, secrets, 'https://example.com/', 'POST', {
      timestamp: 1704067200,
      nonce: 'fixed-nonce',
    });
    const auth = result.headers.Authorization;

    expect(auth).toContain('ts="1704067200"');
    expect(auth).toContain('nonce="fixed-nonce"');
  });

  it('includes ext when provided', () => {
    const result = applyHawkAuth(config, secrets, 'https://example.com/', 'GET', {
      ext: 'app-specific-data',
    });
    expect(result.headers.Authorization).toContain('ext="app-specific-data"');
  });

  it('produces deterministic MAC with fixed inputs', () => {
    const opts = { timestamp: 1704067200, nonce: 'abc123' };
    const r1 = applyHawkAuth(config, secrets, 'https://example.com/path', 'GET', opts);
    const r2 = applyHawkAuth(config, secrets, 'https://example.com/path', 'GET', opts);

    expect(r1.headers.Authorization).toBe(r2.headers.Authorization);
  });

  it('produces different MAC for different methods', () => {
    const opts = { timestamp: 1704067200, nonce: 'abc123' };
    const get = applyHawkAuth(config, secrets, 'https://example.com/path', 'GET', opts);
    const post = applyHawkAuth(config, secrets, 'https://example.com/path', 'POST', opts);

    expect(get.headers.Authorization).not.toBe(post.headers.Authorization);
  });

  it('supports sha1 algorithm', () => {
    const sha1Config = { algorithm: 'sha1' as const };
    const result = applyHawkAuth(sha1Config, secrets, 'https://example.com/', 'GET');
    expect(result.headers.Authorization).toMatch(/^Hawk /);
  });

  it('handles URLs with ports and paths', () => {
    const result = applyHawkAuth(config, secrets, 'https://example.com:8443/api/v1?q=test', 'GET');
    expect(result.headers.Authorization).toMatch(/^Hawk /);
  });
});
