import { describe, it, expect } from 'vitest';
import {
  QUERY_TOKEN_TRANSPORT_ALLOWLIST,
  extractIngressToken,
  tokensMatch,
} from '../inbound-auth.js';

describe('extractIngressToken', () => {
  it('returns x-channel-secret header when present', () => {
    expect(extractIngressToken({ 'x-channel-secret': 'secret-a' })).toBe('secret-a');
  });

  it('returns x-ingress-secret header when present', () => {
    expect(extractIngressToken({ 'x-ingress-secret': 'secret-b' })).toBe('secret-b');
  });

  it('returns x-webhook-secret header when present', () => {
    expect(extractIngressToken({ 'x-webhook-secret': 'secret-c' })).toBe('secret-c');
  });

  it('prefers x-channel-secret over Authorization header', () => {
    expect(
      extractIngressToken({ 'x-channel-secret': 'explicit', authorization: 'Bearer bearer-tok' }),
    ).toBe('explicit');
  });

  it('extracts Bearer token from Authorization header', () => {
    expect(extractIngressToken({ authorization: 'Bearer my-token-123' })).toBe('my-token-123');
  });

  it('does not accept query param tokens without an explicit allowlist entry', () => {
    expect(extractIngressToken({}, 'query-tok')).toBeNull();
  });

  it('falls back to query param token for approved legacy transports', () => {
    expect(extractIngressToken({}, 'query-tok', { allowQueryTokenFor: 'vxml_http' })).toBe(
      'query-tok',
    );
  });

  it('returns null when nothing is provided', () => {
    expect(extractIngressToken({})).toBeNull();
  });

  it('returns null for empty string query param', () => {
    expect(extractIngressToken({}, '')).toBeNull();
  });

  it('trims whitespace from query param', () => {
    expect(extractIngressToken({}, '  trimmed  ', { allowQueryTokenFor: 'audiocodes_http' })).toBe(
      'trimmed',
    );
  });

  it('handles array header values by using first element', () => {
    expect(extractIngressToken({ 'x-channel-secret': ['first', 'second'] })).toBe('first');
  });

  it('documents the only query-token legacy transports', () => {
    expect(Object.keys(QUERY_TOKEN_TRANSPORT_ALLOWLIST)).toEqual([
      'audiocodes_http',
      'audiocodes_ws',
      'korevg_ws',
      'twilio_ws',
      'vxml_http',
    ]);
  });
});

describe('tokensMatch', () => {
  it('returns true for identical tokens', () => {
    expect(tokensMatch('abc123', 'abc123')).toBe(true);
  });

  it('returns false for different tokens of same length', () => {
    // Same length to exercise timingSafeEqual path
    expect(tokensMatch('aaaaaa', 'bbbbbb')).toBe(false);
  });

  it('returns false for different length tokens', () => {
    expect(tokensMatch('short', 'much-longer-token')).toBe(false);
  });

  it('returns false when provided token is null', () => {
    expect(tokensMatch(null, 'expected')).toBe(false);
  });

  it('returns false when expected token is null', () => {
    expect(tokensMatch('provided', null)).toBe(false);
  });

  it('returns false when both are null', () => {
    expect(tokensMatch(null, null)).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(tokensMatch('Token', 'token')).toBe(false);
  });

  it('works with a realistic 64-char hex secret', () => {
    const secret = 'a'.repeat(64);
    expect(tokensMatch(secret, secret)).toBe(true);
    expect(tokensMatch(secret, 'b'.repeat(64))).toBe(false);
  });
});
