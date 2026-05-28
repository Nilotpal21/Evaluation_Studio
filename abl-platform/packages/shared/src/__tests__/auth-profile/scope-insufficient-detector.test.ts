import { describe, it, expect } from 'vitest';
import { detectInsufficientScope } from '../../services/auth-profile/scope-insufficient-detector.js';

describe('detectInsufficientScope', () => {
  // ─── Standard body.error = 'insufficient_scope' ─────────────────

  it('detects standard insufficient_scope error with granted/missing scopes', () => {
    const result = detectInsufficientScope({
      status: 403,
      body: {
        error: 'insufficient_scope',
        scope: 'read',
        error_description: 'The access token does not have the required scope: write admin',
      },
    });

    expect(result).not.toBeNull();
    expect(result?.granted).toEqual(['read']);
    expect(result?.missing).toEqual(['write', 'admin']);
  });

  it('detects insufficient_scope with array scope field', () => {
    const result = detectInsufficientScope({
      status: 403,
      body: {
        error: 'insufficient_scope',
        scope: ['read', 'user:email'],
        required_scopes: ['read', 'user:email', 'repo'],
      },
    });

    expect(result).not.toBeNull();
    expect(result?.granted).toEqual(['read', 'user:email']);
    expect(result?.missing).toEqual(['read', 'user:email', 'repo']);
  });

  it('detects insufficient_scope with granted_scopes field', () => {
    const result = detectInsufficientScope({
      status: 401,
      body: {
        error: 'insufficient_scope',
        granted_scopes: 'read profile',
        required_scopes: 'write admin',
      },
    });

    expect(result).not.toBeNull();
    expect(result?.granted).toEqual(['read', 'profile']);
    expect(result?.missing).toEqual(['write', 'admin']);
  });

  it('detects insufficient_scope with nested error object', () => {
    const result = detectInsufficientScope({
      status: 403,
      body: {
        error: { type: 'insufficient_scope', message: 'Missing scopes' },
      },
    });

    expect(result).not.toBeNull();
    expect(result?.granted).toEqual([]);
    expect(result?.missing).toEqual([]);
  });

  it('detects insufficient_scope with 401 status', () => {
    const result = detectInsufficientScope({
      status: 401,
      body: { error: 'insufficient_scope' },
    });

    expect(result).not.toBeNull();
    expect(result?.granted).toEqual([]);
    expect(result?.missing).toEqual([]);
  });

  // ─── WWW-Authenticate header ────────────────────────────────────

  it('detects insufficient_scope from WWW-Authenticate header with quoted scope', () => {
    const result = detectInsufficientScope({
      status: 401,
      body: {},
      headers: {
        'www-authenticate':
          'Bearer realm="example", scope="read write", error="insufficient_scope"',
      },
    });

    expect(result).not.toBeNull();
    expect(result?.missing).toEqual(['read', 'write']);
  });

  it('detects insufficient_scope from WWW-Authenticate header with unquoted scope', () => {
    const result = detectInsufficientScope({
      status: 403,
      body: {},
      headers: {
        'www-authenticate': 'Bearer scope=read+write',
      },
    });

    expect(result).not.toBeNull();
    expect(result?.missing).toEqual(['read+write']);
  });

  it('detects insufficient_scope keyword in WWW-Authenticate', () => {
    const result = detectInsufficientScope({
      status: 403,
      body: {},
      headers: {
        'www-authenticate':
          'Bearer error="insufficient_scope", error_description="Need more scopes"',
      },
    });

    expect(result).not.toBeNull();
  });

  it('merges body and WWW-Authenticate scopes without duplicates', () => {
    const result = detectInsufficientScope({
      status: 403,
      body: {
        error: 'insufficient_scope',
        scope: 'read',
        error_description: 'Required scope: write',
      },
      headers: {
        'www-authenticate': 'Bearer scope="write admin"',
      },
    });

    expect(result).not.toBeNull();
    expect(result?.granted).toEqual(['read']);
    expect(result?.missing).toEqual(['write', 'admin']);
  });

  // ─── Null cases (NOT insufficient_scope) ────────────────────────

  it('returns null for HTTP 200', () => {
    const result = detectInsufficientScope({
      status: 200,
      body: { error: 'insufficient_scope' },
    });
    expect(result).toBeNull();
  });

  it('returns null for HTTP 500', () => {
    const result = detectInsufficientScope({
      status: 500,
      body: { error: 'server_error' },
    });
    expect(result).toBeNull();
  });

  it('returns null for 403 without insufficient_scope error', () => {
    const result = detectInsufficientScope({
      status: 403,
      body: { error: 'access_denied', message: 'Forbidden' },
    });
    expect(result).toBeNull();
  });

  it('returns null for 401 without scope info', () => {
    const result = detectInsufficientScope({
      status: 401,
      body: { error: 'invalid_token' },
    });
    expect(result).toBeNull();
  });

  it('returns null when body is null', () => {
    const result = detectInsufficientScope({
      status: 403,
      body: null,
    });
    expect(result).toBeNull();
  });

  it('returns null when body is a string', () => {
    const result = detectInsufficientScope({
      status: 403,
      body: 'Unauthorized',
    });
    expect(result).toBeNull();
  });

  it('returns null for 401 with WWW-Authenticate but no scope or error keyword', () => {
    const result = detectInsufficientScope({
      status: 401,
      body: {},
      headers: {
        'www-authenticate': 'Bearer realm="example"',
      },
    });
    expect(result).toBeNull();
  });

  // ─── Edge cases ─────────────────────────────────────────────────

  it('handles empty error_description', () => {
    const result = detectInsufficientScope({
      status: 403,
      body: {
        error: 'insufficient_scope',
        error_description: '',
      },
    });

    expect(result).not.toBeNull();
    expect(result?.missing).toEqual([]);
  });

  it('handles comma-separated scopes', () => {
    const result = detectInsufficientScope({
      status: 403,
      body: {
        error: 'insufficient_scope',
        scope: 'read,write,admin',
      },
    });

    expect(result).not.toBeNull();
    expect(result?.granted).toEqual(['read', 'write', 'admin']);
  });

  it('handles case-insensitive WWW-Authenticate header key', () => {
    const result = detectInsufficientScope({
      status: 401,
      body: {},
      headers: {
        'WWW-Authenticate': 'Bearer scope="read write", error="insufficient_scope"',
      },
    });

    expect(result).not.toBeNull();
    expect(result?.missing).toEqual(['read', 'write']);
  });
});
