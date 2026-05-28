import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  NLUSidecarClient,
  SIDECAR_HEADER_TENANT_ID,
  SIDECAR_HEADER_PROJECT_ID,
  SIDECAR_HEADER_SESSION_ID,
  type SidecarCallContext,
} from '../services/nlu/sidecar-client.js';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

const CTX: SidecarCallContext = {
  tenantId: 'tenant-1',
  projectId: 'project-1',
  sessionId: 'session-1',
};

function mockOk(body: unknown): void {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => body,
  });
}

function expectErr<T>(
  result: { ok: true; value: T } | { ok: false; error: { kind: string } },
  kind: string,
): void {
  if (result.ok) {
    throw new Error(`expected err with kind=${kind}, got ok`);
  }
  expect(result.error.kind).toBe(kind);
}

describe('NLUSidecarClient', () => {
  let client: NLUSidecarClient;

  beforeEach(() => {
    vi.useFakeTimers();
    client = new NLUSidecarClient({
      url: 'http://localhost:8090',
      timeoutMs: 500,
      circuitBreakerThreshold: 3,
      circuitBreakerResetMs: 1000,
    });
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('extract()', () => {
    it('sends tenancy headers and echoes tenancy in the body on every request', async () => {
      mockOk({ entities: { destination: 'Paris' }, confidence: { destination: 0.95 } });

      const result = await client.extract(
        {
          text: 'I want to go to Paris',
          fields: [{ name: 'destination', type: 'string', hints: [] }],
          locale: 'en',
        },
        CTX,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.entities).toEqual({ destination: 'Paris' });
      }

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:8090/extract');
      const headers = init.headers as Record<string, string>;
      expect(headers[SIDECAR_HEADER_TENANT_ID]).toBe('tenant-1');
      expect(headers[SIDECAR_HEADER_PROJECT_ID]).toBe('project-1');
      expect(headers[SIDECAR_HEADER_SESSION_ID]).toBe('session-1');

      const body = JSON.parse(init.body as string);
      expect(body.tenantId).toBe('tenant-1');
      expect(body.projectId).toBe('project-1');
      expect(body.sessionId).toBe('session-1');
      expect(body.text).toBe('I want to go to Paris');
      expect(body.fields).toEqual([{ name: 'destination', type: 'string', hints: [] }]);
      expect(body.locale).toBe('en');
    });

    it('rejects calls without a tenancy context', async () => {
      await expect(
        client.extract(
          {
            text: 'hi',
            fields: [],
            locale: 'en',
          },
          // biome-ignore lint: intentional invalid input for this negative test
          {} as SidecarCallContext,
        ),
      ).rejects.toThrow(/tenantId/);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns err(unavailable) when the sidecar is unreachable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const result = await client.extract(
        { text: 'hello', fields: [{ name: 'x', type: 'string', hints: [] }], locale: 'en' },
        CTX,
      );
      expectErr(result, 'unavailable');
    });

    it('returns err(bad_status) on a non-OK HTTP 5xx response', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
      const result = await client.extract(
        { text: 'hello', fields: [{ name: 'x', type: 'string', hints: [] }], locale: 'en' },
        CTX,
      );
      expectErr(result, 'bad_status');
      if (!result.ok) {
        expect(result.error.httpStatus).toBe(500);
      }
    });

    it('returns err(not_implemented) on HTTP 501', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 501,
        json: async () => ({
          error: { code: 'NLU_SIDECAR_NOT_IMPLEMENTED', message: 'disabled' },
        }),
      });
      const result = await client.extract({ text: 'hello', fields: [], locale: 'en' }, CTX);
      expectErr(result, 'not_implemented');
    });

    it('returns err(timeout) when the request is aborted', async () => {
      mockFetch.mockImplementationOnce(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
          }),
      );

      const resultPromise = client.extract(
        { text: 'hello', fields: [{ name: 'x', type: 'string', hints: [] }], locale: 'en' },
        CTX,
      );
      vi.advanceTimersByTime(600);
      const result = await resultPromise;
      expectErr(result, 'timeout');
    });

    it('returns err(invalid_response) when body fails schema validation', async () => {
      mockOk({ entities: 'not-an-object' });
      const result = await client.extract({ text: 'hello', fields: [], locale: 'en' }, CTX);
      expectErr(result, 'invalid_response');
    });

    it('propagates an empty-match extraction as ok()', async () => {
      mockOk({ entities: {}, confidence: {} });
      const result = await client.extract({ text: 'hello', fields: [], locale: 'en' }, CTX);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.entities).toEqual({});
      }
    });
  });

  describe('circuit breaker', () => {
    it('opens after consecutive failures and returns err(circuit_open)', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      for (let i = 0; i < 3; i++) {
        await client.extract({ text: `${i}`, fields: [], locale: 'en' }, CTX);
      }

      mockFetch.mockClear();
      const result = await client.extract({ text: 'after-open', fields: [], locale: 'en' }, CTX);
      expect(mockFetch).not.toHaveBeenCalled();
      expectErr(result, 'circuit_open');
    });

    it('stays open within the reset period', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      for (let i = 0; i < 3; i++) {
        await client.extract({ text: `${i}`, fields: [], locale: 'en' }, CTX);
      }

      vi.advanceTimersByTime(500);

      mockFetch.mockClear();
      const result = await client.extract({ text: 'x', fields: [], locale: 'en' }, CTX);
      expect(mockFetch).not.toHaveBeenCalled();
      expectErr(result, 'circuit_open');
    });

    it('half-opens after the reset period and closes on success', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      for (let i = 0; i < 3; i++) {
        await client.extract({ text: `${i}`, fields: [], locale: 'en' }, CTX);
      }

      vi.advanceTimersByTime(1100);

      mockFetch.mockReset();
      mockOk({ entities: {}, confidence: {} });

      const result = await client.extract({ text: 'probe', fields: [], locale: 'en' }, CTX);
      expect(mockFetch).toHaveBeenCalled();
      expect(result.ok).toBe(true);
    });

    it('re-opens on probe failure in half-open state', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      for (let i = 0; i < 3; i++) {
        await client.extract({ text: `${i}`, fields: [], locale: 'en' }, CTX);
      }

      vi.advanceTimersByTime(1100);

      mockFetch.mockReset();
      mockFetch.mockRejectedValueOnce(new Error('still down'));
      await client.extract({ text: 'probe', fields: [], locale: 'en' }, CTX);

      mockFetch.mockClear();
      const result = await client.extract({ text: 'after-probe', fields: [], locale: 'en' }, CTX);
      expect(mockFetch).not.toHaveBeenCalled();
      expectErr(result, 'circuit_open');
    });

    it('does not trip the breaker on 501 Not Implemented', async () => {
      for (let i = 0; i < 4; i++) {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 501,
          json: async () => ({ error: { code: 'NLU_SIDECAR_NOT_IMPLEMENTED' } }),
        });
        const result = await client.extract({ text: `${i}`, fields: [], locale: 'en' }, CTX);
        expectErr(result, 'not_implemented');
      }
      // The breaker should still be closed — next call should reach fetch.
      mockOk({ entities: {}, confidence: {} });
      const ok = await client.extract({ text: 'ok', fields: [], locale: 'en' }, CTX);
      expect(ok.ok).toBe(true);
    });

    it('resets consecutive-failure count on a successful request', async () => {
      mockFetch.mockRejectedValueOnce(new Error('fail'));
      await client.extract({ text: '1', fields: [], locale: 'en' }, CTX);
      mockFetch.mockRejectedValueOnce(new Error('fail'));
      await client.extract({ text: '2', fields: [], locale: 'en' }, CTX);

      mockOk({ entities: {}, confidence: {} });
      await client.extract({ text: '3', fields: [], locale: 'en' }, CTX);

      mockFetch.mockRejectedValueOnce(new Error('fail'));
      await client.extract({ text: '4', fields: [], locale: 'en' }, CTX);
      mockFetch.mockRejectedValueOnce(new Error('fail'));
      await client.extract({ text: '5', fields: [], locale: 'en' }, CTX);

      mockFetch.mockClear();
      mockFetch.mockRejectedValueOnce(new Error('fail'));
      await client.extract({ text: '6', fields: [], locale: 'en' }, CTX);
      expect(mockFetch).toHaveBeenCalled();
    });

    it('does not block health() calls', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      for (let i = 0; i < 3; i++) {
        await client.extract({ text: `${i}`, fields: [], locale: 'en' }, CTX);
      }

      mockFetch.mockReset();
      mockFetch.mockResolvedValueOnce({ ok: true });
      expect(await client.health()).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8090/health',
        expect.objectContaining({ method: 'GET' }),
      );
    });
  });

  describe('detectCorrection()', () => {
    it('sends correction detection request with tenancy', async () => {
      mockOk({
        is_correction: true,
        field: 'destination',
        new_value: 'Barcelona',
        confidence: 0.91,
      });

      const result = await client.detectCorrection(
        { text: 'actually Barcelona', context: { destination: 'Paris' }, locale: 'en' },
        CTX,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.is_correction).toBe(true);
        expect(result.value.field).toBe('destination');
      }

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:8090/detect-correction');
      const headers = init.headers as Record<string, string>;
      expect(headers[SIDECAR_HEADER_TENANT_ID]).toBe('tenant-1');
    });

    it('returns err(unavailable) when sidecar unreachable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const result = await client.detectCorrection(
        { text: 'actually Barcelona', context: {}, locale: 'en' },
        CTX,
      );
      expectErr(result, 'unavailable');
    });

    it('returns err(bad_status) on non-OK status', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
      const result = await client.detectCorrection(
        { text: 'actually Barcelona', context: { destination: 'Paris' }, locale: 'en' },
        CTX,
      );
      expectErr(result, 'bad_status');
    });

    it('returns ok for is_correction=false (not an error)', async () => {
      mockOk({ is_correction: false, confidence: 0.0 });
      const result = await client.detectCorrection(
        { text: 'hello', context: {}, locale: 'en' },
        CTX,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.is_correction).toBe(false);
      }
    });
  });

  describe('health()', () => {
    it('returns true when healthy', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });
      expect(await client.health()).toBe(true);
    });

    it('returns false when unhealthy', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      expect(await client.health()).toBe(false);
    });

    it('returns false on non-OK response', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
      expect(await client.health()).toBe(false);
    });
  });

  describe('URL normalization', () => {
    it('strips trailing slashes from base URL', async () => {
      const clientWithSlash = new NLUSidecarClient({
        url: 'http://localhost:8090/',
        timeoutMs: 500,
        circuitBreakerThreshold: 3,
        circuitBreakerResetMs: 1000,
      });

      mockOk({ entities: {}, confidence: {} });

      await clientWithSlash.extract({ text: 'test', fields: [], locale: 'en' }, CTX);
      expect(mockFetch).toHaveBeenCalledWith('http://localhost:8090/extract', expect.anything());
    });
  });
});
