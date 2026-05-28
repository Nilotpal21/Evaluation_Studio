/**
 * Tests for fetch utilities — FetchError classification
 */

import { describe, test, expect, vi, afterEach } from 'vitest';
import { FetchError, classifyFetchError, fetchWithTimeout } from '../utils/fetch.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('classifyFetchError', () => {
  const url = 'http://localhost:3112/health';

  test('returns existing FetchError as-is', () => {
    const existing = new FetchError('already classified', 'TIMEOUT', url);
    const result = classifyFetchError(existing, url);
    expect(result).toBe(existing);
  });

  test('classifies AbortError as TIMEOUT', () => {
    const abort = new DOMException('The operation was aborted', 'AbortError');
    const result = classifyFetchError(abort, url);
    expect(result).toBeInstanceOf(FetchError);
    expect(result.code).toBe('TIMEOUT');
    expect(result.url).toBe(url);
    expect(result.cause).toBe(abort);
  });

  test('classifies TypeError with ECONNREFUSED cause as CONNECTION_REFUSED', () => {
    const cause = { code: 'ECONNREFUSED' };
    const typeError = new TypeError('fetch failed');
    (typeError as any).cause = cause;
    const result = classifyFetchError(typeError, url);
    expect(result.code).toBe('CONNECTION_REFUSED');
    expect(result.url).toBe(url);
  });

  test('classifies TypeError with ENOTFOUND cause as DNS_LOOKUP_FAILED', () => {
    const cause = { code: 'ENOTFOUND' };
    const typeError = new TypeError('fetch failed');
    (typeError as any).cause = cause;
    const result = classifyFetchError(typeError, url);
    expect(result.code).toBe('DNS_LOOKUP_FAILED');
  });

  test('classifies TypeError with ECONNREFUSED in message as CONNECTION_REFUSED', () => {
    const typeError = new TypeError('connect ECONNREFUSED 127.0.0.1:3112');
    const result = classifyFetchError(typeError, url);
    expect(result.code).toBe('CONNECTION_REFUSED');
  });

  test('classifies TypeError with ENOTFOUND in message as DNS_LOOKUP_FAILED', () => {
    const typeError = new TypeError('getaddrinfo ENOTFOUND example.invalid');
    const result = classifyFetchError(typeError, url);
    expect(result.code).toBe('DNS_LOOKUP_FAILED');
  });

  test('classifies generic TypeError as NETWORK_ERROR', () => {
    const typeError = new TypeError('Failed to fetch');
    const result = classifyFetchError(typeError, url);
    expect(result.code).toBe('NETWORK_ERROR');
  });

  test('classifies unknown error as UNKNOWN', () => {
    const result = classifyFetchError(new Error('something weird'), url);
    expect(result.code).toBe('UNKNOWN');
    expect(result.message).toContain('something weird');
  });

  test('classifies non-Error value as UNKNOWN', () => {
    const result = classifyFetchError('string error', url);
    expect(result.code).toBe('UNKNOWN');
    expect(result.message).toContain('string error');
  });
});

describe('fetchWithTimeout', () => {
  test('returns response on success', async () => {
    const mockResponse = { ok: true, status: 200 } as Response;
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const result = await fetchWithTimeout('http://localhost:3112/health');
    expect(result).toBe(mockResponse);
  });

  test('throws FetchError with TIMEOUT code on abort', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'));

    await expect(fetchWithTimeout('http://localhost:3112/health')).rejects.toThrow(FetchError);
    try {
      await fetchWithTimeout('http://localhost:3112/health');
    } catch (e) {
      expect(e).toBeInstanceOf(FetchError);
      expect((e as FetchError).code).toBe('TIMEOUT');
    }
  });

  test('throws FetchError with CONNECTION_REFUSED on ECONNREFUSED', async () => {
    const typeError = new TypeError('fetch failed');
    (typeError as any).cause = { code: 'ECONNREFUSED' };
    globalThis.fetch = vi.fn().mockRejectedValue(typeError);

    await expect(fetchWithTimeout('http://localhost:3112/health')).rejects.toThrow(FetchError);
    try {
      await fetchWithTimeout('http://localhost:3112/health');
    } catch (e) {
      expect((e as FetchError).code).toBe('CONNECTION_REFUSED');
    }
  });

  test('passes signal to fetch', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true } as Response);

    await fetchWithTimeout('http://localhost:3112/health');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:3112/health',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
