/**
 * Tests for HttpClient — runtimeHealthCheck
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpClient } from '../client/http-client.js';
import { DEFAULT_HTTP_URL } from '../constants.js';

// Save original fetch
const originalFetch = globalThis.fetch;

describe('HttpClient', () => {
  let client: HttpClient;

  beforeEach(() => {
    client = new HttpClient('http://localhost:3112');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('constructor', () => {
    test('defaults to the configured runtime URL or empty string when unset', () => {
      const c = new HttpClient();
      expect(c.getBaseUrl()).toBe(DEFAULT_HTTP_URL ?? '');
    });

    test('accepts custom URL', () => {
      const c = new HttpClient('http://custom:9999');
      expect(c.getBaseUrl()).toBe('http://custom:9999');
    });
  });

  describe('runtimeHealthCheck', () => {
    test('returns reachable with details on 200 JSON response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ status: 'healthy', uptime: 42 }),
      });

      const result = await client.runtimeHealthCheck();
      expect(result.reachable).toBe(true);
      expect(result.status).toBe(200);
      expect(result.details).toEqual({ status: 'healthy', uptime: 42 });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://localhost:3112/health',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    test('returns reachable without details on 200 non-JSON response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.reject(new Error('not JSON')),
      });

      const result = await client.runtimeHealthCheck();
      expect(result.reachable).toBe(true);
      expect(result.status).toBe(200);
      expect(result.details).toBeUndefined();
    });

    test('returns reachable for 401 (auth needed)', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
      });

      const result = await client.runtimeHealthCheck();
      expect(result.reachable).toBe(true);
      expect(result.status).toBe(401);
    });

    test('returns reachable for 403 (auth needed)', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
      });

      const result = await client.runtimeHealthCheck();
      expect(result.reachable).toBe(true);
      expect(result.status).toBe(403);
    });

    test('returns not reachable for 500', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });

      const result = await client.runtimeHealthCheck();
      expect(result.reachable).toBe(false);
      expect(result.status).toBe(500);
    });

    test('returns not reachable with error details on ECONNREFUSED', async () => {
      const typeError = new TypeError('fetch failed');
      (typeError as any).cause = { code: 'ECONNREFUSED' };
      globalThis.fetch = vi.fn().mockRejectedValue(typeError);

      const result = await client.runtimeHealthCheck();
      expect(result.reachable).toBe(false);
      expect(result.status).toBeUndefined();
      expect(result.errorCode).toBe('CONNECTION_REFUSED');
      expect(result.error).toContain('Connection refused');
    });

    test('returns not reachable with TIMEOUT on abort', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError'));

      const result = await client.runtimeHealthCheck();
      expect(result.reachable).toBe(false);
      expect(result.errorCode).toBe('TIMEOUT');
    });

    test('returns not reachable with error string for unknown errors', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('something unexpected'));

      const result = await client.runtimeHealthCheck();
      expect(result.reachable).toBe(false);
      expect(result.error).toContain('something unexpected');
    });
  });

  describe('healthCheck (deprecated)', () => {
    test('returns true when reachable', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      });

      expect(await client.healthCheck()).toBe(true);
    });

    test('returns false when not reachable', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      expect(await client.healthCheck()).toBe(false);
    });
  });

  describe('setAuthToken / getHeaders', () => {
    test('includes Bearer token in requests after setAuthToken', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ agents: {} }),
      });

      client.setAuthToken('my-jwt');
      await client.listAgents();

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://localhost:3112/api/agents',
        expect.objectContaining({
          headers: { Authorization: 'Bearer my-jwt' },
          signal: expect.any(AbortSignal),
        }),
      );
    });
  });
});
