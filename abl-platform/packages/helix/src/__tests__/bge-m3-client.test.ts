/**
 * Tests for BgeM3Client (src/intelligence/bge-m3-client.ts)
 *
 * Covers:
 *  - Happy-path embedding (single + batched)
 *  - Graceful degradation: returns null on network errors, 5xx (with 1 retry),
 *    and 4xx (immediate null, no retry)
 *  - Batch chunking respects maxBatchSize
 *  - healthCheck returns true on 200, false on errors
 *
 * All tests use vi.spyOn(globalThis, 'fetch') — no real network.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBgeM3Client } from '../intelligence/bge-m3-client.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeResponse(status: number, body: unknown, ok?: boolean): Response {
  return {
    ok: ok ?? (status >= 200 && status < 300),
    status,
    json: async () => body,
  } as unknown as Response;
}

function makeConfig(overrides: Partial<Parameters<typeof createBgeM3Client>[0]> = {}) {
  return {
    baseUrl: 'http://localhost:8000',
    timeoutMs: 5_000,
    maxBatchSize: 3,
    ...overrides,
  };
}

// ── Suite ──────────────────────────────────────────────────────────────────────

describe('createBgeM3Client', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── embedBatch ─────────────────────────────────────────────────────────────

  describe('embedBatch', () => {
    it('returns empty embeddings for empty input without calling fetch', async () => {
      const client = createBgeM3Client(makeConfig());
      const result = await client.embedBatch([]);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result).toEqual({ embeddings: [], model: 'bge-m3', dimensions: 1024 });
    });

    it('returns embeddings on successful single-chunk response', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeResponse(200, {
          embeddings: [[0.1, 0.2, 0.3]],
          model: 'bge-m3',
          dimensions: 3,
        }),
      );

      const client = createBgeM3Client(makeConfig());
      const result = await client.embedBatch(['hello']);
      expect(result).not.toBeNull();
      expect(result!.embeddings).toHaveLength(1);
      expect(result!.embeddings[0]).toEqual([0.1, 0.2, 0.3]);
      expect(result!.model).toBe('bge-m3');
    });

    it('uses fallback model/dimensions when not provided in response', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(200, { embeddings: [[0.5]] }));

      const client = createBgeM3Client(makeConfig());
      const result = await client.embedBatch(['test']);
      expect(result!.model).toBe('bge-m3');
      expect(result!.dimensions).toBe(1024);
    });

    it('chunks input into batches of maxBatchSize', async () => {
      // maxBatchSize=2, 4 texts → 2 fetch calls
      const vec = [0.1, 0.2];
      fetchSpy
        .mockResolvedValueOnce(
          makeResponse(200, { embeddings: [vec, vec], model: 'bge-m3', dimensions: 2 }),
        )
        .mockResolvedValueOnce(
          makeResponse(200, { embeddings: [vec, vec], model: 'bge-m3', dimensions: 2 }),
        );

      const client = createBgeM3Client(makeConfig({ maxBatchSize: 2 }));
      const result = await client.embedBatch(['a', 'b', 'c', 'd']);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(result!.embeddings).toHaveLength(4);
    });

    it('returns null immediately on 4xx (no retry)', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(400, {}));

      const client = createBgeM3Client(makeConfig());
      const result = await client.embedBatch(['x']);
      expect(result).toBeNull();
      expect(fetchSpy).toHaveBeenCalledTimes(1); // no retry on 4xx
    });

    it('retries once on 5xx and returns null after both attempts fail', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeResponse(503, {}))
        .mockResolvedValueOnce(makeResponse(503, {}));

      vi.useFakeTimers();
      const client = createBgeM3Client(makeConfig());
      const promise = client.embedBatch(['y']);
      await vi.runAllTimersAsync();
      const result = await promise;
      vi.useRealTimers();

      expect(result).toBeNull();
      expect(fetchSpy).toHaveBeenCalledTimes(2); // exactly one retry
    });

    it('retries once on 5xx and succeeds on the retry', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeResponse(500, {}))
        .mockResolvedValueOnce(
          makeResponse(200, { embeddings: [[1.0]], model: 'bge-m3', dimensions: 1 }),
        );

      // Speed up the test by bypassing the sleep
      vi.useFakeTimers();
      const client = createBgeM3Client(makeConfig());
      const promise = client.embedBatch(['z']);
      // Advance timers to resolve the 500ms back-off
      await vi.runAllTimersAsync();
      const result = await promise;
      vi.useRealTimers();

      expect(result).not.toBeNull();
      expect(result!.embeddings[0]).toEqual([1.0]);
    });

    it('returns null when fetch throws (endpoint unreachable)', async () => {
      // First attempt throws, retry also throws
      fetchSpy
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockRejectedValueOnce(new Error('ECONNREFUSED'));

      vi.useFakeTimers();
      const client = createBgeM3Client(makeConfig());
      const promise = client.embedBatch(['err']);
      await vi.runAllTimersAsync();
      const result = await promise;
      vi.useRealTimers();

      expect(result).toBeNull();
    });

    it('returns null when any chunk fails (whole batch is null)', async () => {
      // maxBatchSize=2, 3 texts → 2 chunks
      // chunk 1 ok, chunk 2 fails with 503 (attempt 1 + retry = 2 calls)
      fetchSpy
        .mockResolvedValueOnce(
          makeResponse(200, { embeddings: [[0.1], [0.2]], model: 'bge-m3', dimensions: 1 }),
        )
        .mockResolvedValueOnce(makeResponse(503, {}))
        .mockResolvedValueOnce(makeResponse(503, {}));

      vi.useFakeTimers();
      const client = createBgeM3Client(makeConfig({ maxBatchSize: 2 }));
      const promise = client.embedBatch(['a', 'b', 'c']);
      // Need multiple timer advances for the back-off sleep in chunk 2
      await vi.runAllTimersAsync();
      const result = await promise;
      vi.useRealTimers();

      expect(result).toBeNull();
    });

    it('includes Authorization header when authToken provided', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeResponse(200, { embeddings: [[0.1]], model: 'bge-m3', dimensions: 1 }),
      );

      const client = createBgeM3Client(makeConfig({ authToken: 'tok123' }));
      await client.embedBatch(['auth-test']);
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://localhost:8000/embed',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ Authorization: 'Bearer tok123' }),
        }),
      );
    });

    it('does NOT include Authorization header when no authToken', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeResponse(200, { embeddings: [[0.1]], model: 'bge-m3', dimensions: 1 }),
      );

      const client = createBgeM3Client(makeConfig());
      await client.embedBatch(['no-auth']);
      const callArgs = fetchSpy.mock.calls[0][1] as RequestInit;
      const headers = callArgs.headers as Record<string, string>;
      expect(headers['Authorization']).toBeUndefined();
    });
  });

  // ── healthCheck ────────────────────────────────────────────────────────────

  describe('healthCheck', () => {
    it('returns true on 200 OK', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(200, {}));
      const client = createBgeM3Client(makeConfig());
      expect(await client.healthCheck()).toBe(true);
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://localhost:8000/health',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('returns false on non-2xx response', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(503, {}, false));
      const client = createBgeM3Client(makeConfig());
      expect(await client.healthCheck()).toBe(false);
    });

    it('returns false when fetch throws', async () => {
      fetchSpy.mockRejectedValueOnce(new TypeError('Network error'));
      const client = createBgeM3Client(makeConfig());
      expect(await client.healthCheck()).toBe(false);
    });
  });

  describe('real HTTP boundary', () => {
    it('posts embed requests and sends bearer auth to a random-port HTTP service', async () => {
      vi.restoreAllMocks();
      const fake = await startHttpBgeM3Fake('expected-token');
      try {
        const client = createBgeM3Client(
          makeConfig({
            baseUrl: fake.baseUrl,
            authToken: 'expected-token',
            maxBatchSize: 2,
          }),
        );

        const result = await client.embedBatch(['alpha', 'beta', 'gamma']);

        expect(result).toEqual({
          embeddings: [
            [1, 0, 0],
            [1, 0, 0],
            [1, 0, 0],
          ],
          model: 'bge-m3',
          dimensions: 3,
        });
        expect(await client.healthCheck()).toBe(true);
        expect(fake.requests()).toEqual([
          {
            path: '/embed',
            authorization: 'Bearer expected-token',
            texts: ['alpha', 'beta'],
          },
          {
            path: '/embed',
            authorization: 'Bearer expected-token',
            texts: ['gamma'],
          },
          {
            path: '/health',
            authorization: 'Bearer expected-token',
            texts: [],
          },
        ]);
      } finally {
        await fake.close();
      }
    });
  });
});

async function startHttpBgeM3Fake(expectedToken: string): Promise<{
  baseUrl: string;
  requests: () => Array<{ path: string; authorization?: string; texts: string[] }>;
  close: () => Promise<void>;
}> {
  const requests: Array<{ path: string; authorization?: string; texts: string[] }> = [];
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const authorization = req.headers.authorization;

    if (authorization !== `Bearer ${expectedToken}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      requests.push({ path: url.pathname, authorization, texts: [] });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/embed') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { texts?: string[] };
      const texts = body.texts ?? [];
      requests.push({ path: url.pathname, authorization, texts });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          embeddings: texts.map(() => [1, 0, 0]),
          model: 'bge-m3',
          dimensions: 3,
        }),
      );
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise<void>((resolveServer) => {
    server.listen({ port: 0, host: '127.0.0.1' }, () => resolveServer());
  });
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests: () => [...requests],
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      }),
  };
}
