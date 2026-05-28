import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import {
  generateWebhookSecret,
  computeWebhookSignature,
  buildSignatureHeaders,
  verifyWebhookSignature,
} from '../webhook-signature.js';

describe('generateWebhookSecret', () => {
  it('returns a string with whsec_ prefix', () => {
    const secret = generateWebhookSecret();
    expect(secret.startsWith('whsec_')).toBe(true);
  });

  it('returns correct total length (6 prefix + 64 hex chars)', () => {
    const secret = generateWebhookSecret();
    // "whsec_" is 6 chars, 32 random bytes → 64 hex chars
    expect(secret.length).toBe(6 + 64);
  });

  it('generates unique secrets on each call', () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a).not.toBe(b);
  });

  it('hex portion contains only valid hex characters', () => {
    const secret = generateWebhookSecret();
    const hex = secret.slice(6);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('computeWebhookSignature', () => {
  it('produces a deterministic signature for the same inputs', () => {
    const sig1 = computeWebhookSignature('whsec_abc123', '{"event":"test"}', '1700000000');
    const sig2 = computeWebhookSignature('whsec_abc123', '{"event":"test"}', '1700000000');
    expect(sig1).toBe(sig2);
  });

  it('produces different signatures for different bodies', () => {
    const sig1 = computeWebhookSignature('whsec_abc123', '{"a":1}', '1700000000');
    const sig2 = computeWebhookSignature('whsec_abc123', '{"a":2}', '1700000000');
    expect(sig1).not.toBe(sig2);
  });

  it('produces different signatures for different secrets', () => {
    const sig1 = computeWebhookSignature('whsec_secret1', '{"a":1}', '1700000000');
    const sig2 = computeWebhookSignature('whsec_secret2', '{"a":1}', '1700000000');
    expect(sig1).not.toBe(sig2);
  });

  it('produces different signatures for different timestamps', () => {
    const sig1 = computeWebhookSignature('whsec_abc123', '{"a":1}', '1700000000');
    const sig2 = computeWebhookSignature('whsec_abc123', '{"a":1}', '1700000001');
    expect(sig1).not.toBe(sig2);
  });

  it('strips whsec_ prefix before computing', () => {
    const withPrefix = computeWebhookSignature('whsec_rawkey', 'body');
    const withoutPrefix = computeWebhookSignature('rawkey', 'body');
    expect(withPrefix).toBe(withoutPrefix);
  });

  it('works without timestamp (signs body only)', () => {
    const secret = 'rawkey';
    const body = 'test-body';
    const expected = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    expect(computeWebhookSignature(secret, body)).toBe(expected);
  });

  it('with timestamp signs "timestamp.body"', () => {
    const secret = 'rawkey';
    const body = 'test-body';
    const ts = '1700000000';
    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${ts}.${body}`, 'utf8')
      .digest('hex');
    expect(computeWebhookSignature(secret, body, ts)).toBe(expected);
  });

  it('returns a hex string of correct length (sha256 = 64 hex chars)', () => {
    const sig = computeWebhookSignature('whsec_abc', 'body');
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it('throws on empty secret after prefix strip', () => {
    expect(() => computeWebhookSignature('whsec_', 'body')).toThrow(
      'Webhook secret cannot be empty',
    );
  });

  it('throws on empty secret without prefix', () => {
    expect(() => computeWebhookSignature('', 'body')).toThrow('Webhook secret cannot be empty');
  });
});

describe('buildSignatureHeaders', () => {
  const FIXED_EPOCH_MS = new Date('2024-01-15T00:00:00Z').getTime();

  beforeEach(() => {
    // Use spyOn instead of vi.useFakeTimers to avoid conflict with crypto.randomUUID()
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_EPOCH_MS);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns all three required headers', () => {
    const headers = buildSignatureHeaders('whsec_test', '{"data":1}');
    expect(headers).toHaveProperty('x-webhook-signature');
    expect(headers).toHaveProperty('x-webhook-timestamp');
    expect(headers).toHaveProperty('x-webhook-id');
  });

  it('timestamp is a numeric string (unix seconds)', () => {
    const headers = buildSignatureHeaders('whsec_test', '{"data":1}');
    const ts = headers['x-webhook-timestamp'];
    expect(ts).toMatch(/^\d+$/);
    expect(Number(ts)).toBe(Math.floor(FIXED_EPOCH_MS / 1000));
  });

  it('signature matches manual computation', () => {
    const secret = 'whsec_mykey';
    const body = '{"event":"ping"}';
    const headers = buildSignatureHeaders(secret, body);
    const ts = headers['x-webhook-timestamp'];

    const expected = computeWebhookSignature(secret, body, ts);
    expect(headers['x-webhook-signature']).toBe(expected);
  });

  it('webhook-id is a valid UUID', () => {
    const headers = buildSignatureHeaders('whsec_test', 'body');
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    expect(headers['x-webhook-id']).toMatch(uuidRegex);
  });
});

describe('verifyWebhookSignature', () => {
  const secret = 'whsec_testkey123';
  const body = '{"event":"test","data":{"id":1}}';
  const FIXED_EPOCH_MS = new Date('2024-01-15T00:00:00Z').getTime();

  function makeValidSignature(
    s: string,
    b: string,
    ts: string,
  ): { signature: string; timestamp: string } {
    const signature = computeWebhookSignature(s, b, ts);
    return { signature, timestamp: ts };
  }

  beforeEach(() => {
    // Use spyOn instead of vi.useFakeTimers to avoid conflict with crypto.randomUUID()
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_EPOCH_MS);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true for a valid signature', () => {
    const now = Math.floor(Date.now() / 1000).toString();
    const { signature, timestamp } = makeValidSignature(secret, body, now);
    expect(verifyWebhookSignature(secret, body, signature, timestamp)).toBe(true);
  });

  it('returns false for a tampered body', () => {
    const now = Math.floor(Date.now() / 1000).toString();
    const { signature, timestamp } = makeValidSignature(secret, body, now);
    expect(verifyWebhookSignature(secret, '{"tampered":true}', signature, timestamp)).toBe(false);
  });

  it('returns false for a wrong signature', () => {
    const now = Math.floor(Date.now() / 1000).toString();
    expect(verifyWebhookSignature(secret, body, 'badsignature', now)).toBe(false);
  });

  it('returns false for an expired timestamp (>5 min old)', () => {
    const expired = (Math.floor(Date.now() / 1000) - 301).toString();
    const { signature, timestamp } = makeValidSignature(secret, body, expired);
    expect(verifyWebhookSignature(secret, body, signature, timestamp)).toBe(false);
  });

  it('returns false for a future timestamp beyond tolerance', () => {
    const future = (Math.floor(Date.now() / 1000) + 301).toString();
    const { signature, timestamp } = makeValidSignature(secret, body, future);
    expect(verifyWebhookSignature(secret, body, signature, timestamp)).toBe(false);
  });

  it('returns false for NaN timestamp', () => {
    const { signature } = makeValidSignature(secret, body, 'notanumber');
    expect(verifyWebhookSignature(secret, body, signature, 'notanumber')).toBe(false);
  });

  it('respects custom tolerance', () => {
    const old = (Math.floor(Date.now() / 1000) - 60).toString();
    const { signature, timestamp } = makeValidSignature(secret, body, old);
    // Should fail with 30s tolerance
    expect(verifyWebhookSignature(secret, body, signature, timestamp, 30)).toBe(false);
    // Should pass with 120s tolerance
    expect(verifyWebhookSignature(secret, body, signature, timestamp, 120)).toBe(true);
  });
});
