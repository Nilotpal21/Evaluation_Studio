/**
 * Tests for Secret Safety Middleware
 *
 * Covers: secret scrubbing (Bearer, API key, platform key, PEM, AWS key),
 * secret validation (empty auth headers), passthrough for clean data,
 * edge cases (nested objects, arrays, non-string values).
 */

import { describe, test, expect, vi } from 'vitest';
import {
  createSecretScrubberMiddleware,
  createSecretValidationMiddleware,
  SecretNotFoundError,
} from '../../platform/constructs/executors/sanitizer-middleware.js';
import { REDACTED } from '../../platform/constructs/executors/scrub-patterns.js';
import type {
  ToolCallContext,
  ToolCallResult,
  ToolMiddlewareNext,
} from '../../platform/constructs/executors/tool-middleware.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeCtx(overrides?: Partial<ToolCallContext>): ToolCallContext {
  return {
    toolName: 'test-tool',
    params: {},
    timeoutMs: 5000,
    ...overrides,
  };
}

function makeNext(result: unknown): ToolMiddlewareNext {
  return async () => ({ result });
}

// ─── Secret Scrubber ───────────────────────────────────────────────────────

describe('createSecretScrubberMiddleware', () => {
  const middleware = createSecretScrubberMiddleware();

  test('scrubs Bearer tokens from string results', async () => {
    const next = makeNext('Response with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xyz in it');
    const result = await middleware(makeCtx(), next);
    expect(result.result).toBe(`Response with ${REDACTED} in it`);
  });

  test('scrubs API key patterns from string results', async () => {
    const next = makeNext('Config: api_key: sk_live_AbCdEfGhIjKlMnOpQrStUv');
    const result = await middleware(makeCtx(), next);
    expect(result.result).toContain(REDACTED);
    expect(result.result).not.toContain('AbCdEfGhIjKlMnOp');
  });

  test('scrubs platform keys (abl_xxx)', async () => {
    const next = makeNext('Key is abl_AbCdEfGhIjKlMnOpQrStUvWx');
    const result = await middleware(makeCtx(), next);
    expect(result.result).toContain(REDACTED);
    expect(result.result).not.toContain('abl_AbCdEfGhIj');
  });

  test('scrubs PEM private keys', async () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEvgIBADANBg...\n-----END RSA PRIVATE KEY-----';
    const next = makeNext(`Certificate: ${pem}`);
    const result = await middleware(makeCtx(), next);
    expect(result.result).toContain(REDACTED);
    expect(result.result).not.toContain('BEGIN RSA PRIVATE KEY');
  });

  test('scrubs AWS access key IDs', async () => {
    const next = makeNext('aws_access_key_id = AKIAIOSFODNN7EXAMPLE');
    const result = await middleware(makeCtx(), next);
    expect(result.result).toContain(REDACTED);
    expect(result.result).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  test('scrubs secrets in nested objects', async () => {
    const next = makeNext({
      data: {
        headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig' },
        body: 'OK',
      },
    });
    const result = await middleware(makeCtx(), next);
    const data = (result.result as any).data;
    expect(data.headers.Authorization).toContain(REDACTED);
    expect(data.body).toBe('OK');
  });

  test('scrubs secrets in arrays', async () => {
    const next = makeNext(['clean', 'token: my_secret_abcdefghijklmnop1234', 42]);
    const result = await middleware(makeCtx(), next);
    const arr = result.result as unknown[];
    expect(arr[0]).toBe('clean');
    expect(arr[1]).toContain(REDACTED);
    expect(arr[2]).toBe(42);
  });

  test('passes through clean results unchanged', async () => {
    const next = makeNext({ status: 200, data: 'Hello World', count: 42 });
    const result = await middleware(makeCtx(), next);
    expect(result.result).toEqual({ status: 200, data: 'Hello World', count: 42 });
  });

  test('handles null and undefined values', async () => {
    const next = makeNext({ a: null, b: undefined, c: 'clean' });
    const result = await middleware(makeCtx(), next);
    expect(result.result).toEqual({ a: null, b: undefined, c: 'clean' });
  });

  test('handles primitive results (number, boolean)', async () => {
    const numberNext = makeNext(42);
    expect((await middleware(makeCtx(), numberNext)).result).toBe(42);

    const boolNext = makeNext(true);
    expect((await middleware(makeCtx(), boolNext)).result).toBe(true);
  });

  test('accepts custom scrub patterns', async () => {
    const custom = createSecretScrubberMiddleware([/SECRET_\d+/g]);
    const next = makeNext('Found SECRET_12345 in response');
    const result = await custom(makeCtx(), next);
    expect(result.result).toBe(`Found ${REDACTED} in response`);
  });

  test('preserves metadata from inner result', async () => {
    const next: ToolMiddlewareNext = async () => ({
      result: 'Bearer eyJhbGciOiJ9.x.y',
      metadata: { latencyMs: 100 },
    });
    const result = await middleware(makeCtx(), next);
    expect(result.metadata).toEqual({ latencyMs: 100 });
    expect(result.result).toContain(REDACTED);
  });

  test('returns raw result if scrubbing throws', async () => {
    // Create a proxy that throws on property access to simulate scrubbing failure
    const badResult = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('Proxy trap');
        },
      },
    );
    const next: ToolMiddlewareNext = async () => ({ result: badResult });
    const result = await middleware(makeCtx(), next);
    expect(result.result).toBe(badResult);
  });

  test('scrubs multiple secrets in same string', async () => {
    const next = makeNext('Auth: Bearer eyJhbGci.x.y, Key: abl_AbCdEfGhIjKlMnOpQrStUvWx end');
    const result = await middleware(makeCtx(), next);
    const str = result.result as string;
    expect(str).not.toContain('eyJhbGci');
    expect(str).not.toContain('abl_AbCdEfGhIj');
    // Two separate redactions
    const count = (str.match(/\[REDACTED\]/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });
});

// ─── Secret Validation ────────────────────────────────────────────────────

describe('createSecretValidationMiddleware', () => {
  const middleware = createSecretValidationMiddleware();
  const passNext: ToolMiddlewareNext = async () => ({ result: 'OK' });

  test('passes through when tool has no http_binding', async () => {
    const ctx = makeCtx({ tool: { name: 'test', tool_type: 'sandbox' } as any });
    const result = await middleware(ctx, passNext);
    expect(result.result).toBe('OK');
  });

  test('passes through when http_binding has no auth', async () => {
    const ctx = makeCtx({
      tool: {
        name: 'test',
        tool_type: 'http',
        http_binding: { endpoint: 'https://api.example.com', method: 'GET' },
      } as any,
    });
    const result = await middleware(ctx, passNext);
    expect(result.result).toBe('OK');
  });

  test('throws SecretNotFoundError for empty Bearer Authorization header', async () => {
    const ctx = makeCtx({
      toolName: 'my-api',
      tool: {
        name: 'my-api',
        tool_type: 'http',
        http_binding: {
          endpoint: 'https://api.example.com',
          method: 'GET',
          auth: { type: 'bearer' },
          headers: { Authorization: '' },
        },
      } as any,
    });

    await expect(middleware(ctx, passNext)).rejects.toThrow(SecretNotFoundError);
    await expect(middleware(ctx, passNext)).rejects.toThrow(/my-api/);
    await expect(middleware(ctx, passNext)).rejects.toThrow(/bearer auth/i);
  });

  test('throws SecretNotFoundError for empty custom_header Authorization', async () => {
    const ctx = makeCtx({
      tool: {
        name: 'custom-tool',
        tool_type: 'http',
        http_binding: {
          endpoint: 'https://api.example.com',
          method: 'POST',
          auth: { type: 'custom_header' },
          headers: { Authorization: '  ' },
        },
      } as any,
    });

    await expect(middleware(ctx, passNext)).rejects.toThrow(SecretNotFoundError);
  });

  test('throws SecretNotFoundError for empty API key header', async () => {
    const ctx = makeCtx({
      tool: {
        name: 'keyed-api',
        tool_type: 'http',
        http_binding: {
          endpoint: 'https://api.example.com',
          method: 'GET',
          auth: { type: 'api_key', config: { headerName: 'X-Api-Key' } },
          headers: { 'X-Api-Key': '' },
        },
      } as any,
    });

    await expect(middleware(ctx, passNext)).rejects.toThrow(SecretNotFoundError);
    await expect(middleware(ctx, passNext)).rejects.toThrow(/X-Api-Key/);
  });

  test('passes through when Authorization header is present and non-empty', async () => {
    const ctx = makeCtx({
      tool: {
        name: 'good-api',
        tool_type: 'http',
        http_binding: {
          endpoint: 'https://api.example.com',
          method: 'GET',
          auth: { type: 'bearer' },
          headers: { Authorization: 'Bearer valid-token-here' },
        },
      } as any,
    });

    const result = await middleware(ctx, passNext);
    expect(result.result).toBe('OK');
  });

  test('passes through when API key header is present and non-empty', async () => {
    const ctx = makeCtx({
      tool: {
        name: 'keyed-api',
        tool_type: 'http',
        http_binding: {
          endpoint: 'https://api.example.com',
          method: 'GET',
          auth: { type: 'api_key', config: { headerName: 'X-Api-Key' } },
          headers: { 'X-Api-Key': 'my-valid-key' },
        },
      } as any,
    });

    const result = await middleware(ctx, passNext);
    expect(result.result).toBe('OK');
  });

  test('SecretNotFoundError has correct code property', () => {
    const err = new SecretNotFoundError('test-tool', 'missing token');
    expect(err.code).toBe('SECRET_NOT_FOUND');
    expect(err.name).toBe('SecretNotFoundError');
    expect(err.message).toContain('test-tool');
    expect(err.message).toContain('missing token');
  });
});
