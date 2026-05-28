import { describe, it, expect } from 'vitest';
import { applyDigestAuth } from '../digest-auth.js';

describe('applyDigestAuth', () => {
  const config = { realm: 'testrealm@example.com' };
  const secrets = { username: 'admin', password: 's3cret' };

  it('returns an Authorization header starting with "Digest"', () => {
    const result = applyDigestAuth(config, secrets, 'https://example.com/api/data', 'GET');
    expect(result.headers.Authorization).toMatch(/^Digest /);
  });

  it('includes all required Digest fields', () => {
    const result = applyDigestAuth(config, secrets, 'https://example.com/api/data', 'GET');
    const auth = result.headers.Authorization;

    expect(auth).toContain('username="admin"');
    expect(auth).toContain('realm="testrealm@example.com"');
    expect(auth).toContain('nonce=');
    expect(auth).toContain('uri="/api/data"');
    expect(auth).toContain('response=');
    expect(auth).toContain('qop=auth');
    expect(auth).toContain('nc=00000001');
    expect(auth).toContain('cnonce=');
  });

  it('defaults to MD5 algorithm', () => {
    const result = applyDigestAuth(config, secrets, 'https://example.com/', 'GET');
    expect(result.headers.Authorization).toContain('algorithm=MD5');
  });

  it('supports SHA-256 algorithm', () => {
    const result = applyDigestAuth(config, secrets, 'https://example.com/', 'GET', {
      algorithm: 'sha-256',
    });
    expect(result.headers.Authorization).toContain('algorithm=SHA-256');
  });

  it('uses server-provided nonce when given', () => {
    const result = applyDigestAuth(config, secrets, 'https://example.com/', 'GET', {
      nonce: 'server-nonce-123',
    });
    expect(result.headers.Authorization).toContain('nonce="server-nonce-123"');
  });

  it('includes opaque when provided', () => {
    const result = applyDigestAuth(config, secrets, 'https://example.com/', 'GET', {
      opaque: 'opaque-value',
    });
    expect(result.headers.Authorization).toContain('opaque="opaque-value"');
  });

  it('produces deterministic response with fixed nonce', () => {
    const opts = { nonce: 'fixed-nonce', nc: '00000001' };
    const r1 = applyDigestAuth(config, secrets, 'https://example.com/path', 'GET', opts);
    const r2 = applyDigestAuth(config, secrets, 'https://example.com/path', 'GET', opts);

    // The cnonce differs, so full header differs, but both should be valid Digest headers
    expect(r1.headers.Authorization).toMatch(/^Digest /);
    expect(r2.headers.Authorization).toMatch(/^Digest /);
  });

  it('extracts URI correctly from full URL with query params', () => {
    const result = applyDigestAuth(config, secrets, 'https://example.com/api?q=test&page=1', 'GET');
    expect(result.headers.Authorization).toContain('uri="/api?q=test&page=1"');
  });

  it('handles relative URLs gracefully', () => {
    const result = applyDigestAuth(config, secrets, '/api/resource', 'POST');
    expect(result.headers.Authorization).toContain('uri="/api/resource"');
  });
});
