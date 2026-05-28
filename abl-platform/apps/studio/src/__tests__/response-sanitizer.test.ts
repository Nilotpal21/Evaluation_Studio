/**
 * Tests for Response Sanitizer
 *
 * Covers: header redaction, body truncation, pattern scrubbing, nested objects.
 */

import { describe, test, expect } from 'vitest';
import { sanitizeResponseData, redactSensitiveHeaders } from '../lib/response-sanitizer';

describe('redactSensitiveHeaders', () => {
  test('redacts Authorization header', () => {
    const result = redactSensitiveHeaders({
      Authorization: 'Bearer abc123',
      'Content-Type': 'application/json',
    });
    expect(result.Authorization).toBe('[REDACTED]');
    expect(result['Content-Type']).toBe('application/json');
  });

  test('redacts cookie headers (case-insensitive)', () => {
    const result = redactSensitiveHeaders({
      cookie: 'session=abc',
      'set-cookie': 'token=xyz',
    });
    expect(result.cookie).toBe('[REDACTED]');
    expect(result['set-cookie']).toBe('[REDACTED]');
  });

  test('redacts x-api-key and x-auth-token', () => {
    const result = redactSensitiveHeaders({
      'x-api-key': 'sk-1234567890',
      'x-auth-token': 'tok-abc',
    });
    expect(result['x-api-key']).toBe('[REDACTED]');
    expect(result['x-auth-token']).toBe('[REDACTED]');
  });

  test('preserves non-sensitive headers', () => {
    const result = redactSensitiveHeaders({
      'Content-Length': '128',
      Accept: 'application/json',
      'X-Request-Id': 'req-123',
    });
    expect(result['Content-Length']).toBe('128');
    expect(result.Accept).toBe('application/json');
    expect(result['X-Request-Id']).toBe('req-123');
  });
});

describe('sanitizeResponseData', () => {
  // ─── String scrubbing ────────────────────────────────────────────

  test('scrubs Bearer tokens from strings', () => {
    const data = { message: 'Token: Bearer eyJhbGciOiJIUzI1NiJ9.abcdef.ghijkl' };
    const result = sanitizeResponseData(data, {});
    expect(result.message).not.toContain('Bearer eyJ');
    expect(result.message).toContain('[REDACTED]');
  });

  test('scrubs API key patterns from strings', () => {
    const data = { output: 'Config: api_key=sk_live_1234567890abcdefghij' };
    const result = sanitizeResponseData(data, {});
    expect(result.output).not.toContain('sk_live_1234567890');
    expect(result.output).toContain('[REDACTED]');
  });

  test('scrubs platform keys (abl_) from strings', () => {
    const data = { log: 'Key is abl_abcdefghijklmnopqrstuvwx' };
    const result = sanitizeResponseData(data, {});
    expect(result.log).not.toContain('abl_abcdefghijklmnop');
    expect(result.log).toContain('[REDACTED]');
  });

  test('leaves clean strings untouched', () => {
    const data = { message: 'Hello world, this is a normal response.' };
    const result = sanitizeResponseData(data, {});
    expect(result.message).toBe('Hello world, this is a normal response.');
  });

  // ─── Header redaction in objects ─────────────────────────────────

  test('redacts sensitive header keys in nested objects', () => {
    const data = {
      response: {
        headers: {
          authorization: 'Bearer secret',
          'content-type': 'application/json',
        },
      },
    };
    const result = sanitizeResponseData(data, { redactHeaders: true });
    expect(result.response.headers.authorization).toBe('[REDACTED]');
    expect(result.response.headers['content-type']).toBe('application/json');
  });

  // ─── Body truncation ────────────────────────────────────────────

  test('truncates strings exceeding maxBodySize', () => {
    const longString = 'a'.repeat(200);
    const result = sanitizeResponseData(longString, { maxBodySize: 100 });
    const parsed = JSON.parse(result);
    expect(parsed._truncated).toBe(true);
    expect(parsed.byteSize).toBe(200);
    expect(parsed.preview).toHaveLength(200); // preview is first 1000 chars (all 200 fit)
  });

  // ─── Custom patterns ────────────────────────────────────────────

  test('applies custom redact patterns', () => {
    const data = { output: 'SSN: 123-45-6789, Name: John' };
    const result = sanitizeResponseData(data, {
      redactPatterns: [/\d{3}-\d{2}-\d{4}/g],
    });
    expect(result.output).not.toContain('123-45-6789');
    expect(result.output).toContain('[REDACTED]');
    expect(result.output).toContain('John');
  });

  // ─── Nested structures ──────────────────────────────────────────

  test('recursively sanitizes arrays', () => {
    const data = [{ token: 'Bearer secret-token-here-1234567890' }, { clean: 'no secrets' }];
    const result = sanitizeResponseData(data, {});
    expect(result[0].token).toContain('[REDACTED]');
    expect(result[1].clean).toBe('no secrets');
  });

  test('handles null and undefined', () => {
    expect(sanitizeResponseData(null, {})).toBeNull();
    expect(sanitizeResponseData(undefined, {})).toBeUndefined();
  });

  test('handles primitive types', () => {
    expect(sanitizeResponseData(42, {})).toBe(42);
    expect(sanitizeResponseData(true, {})).toBe(true);
  });
});
