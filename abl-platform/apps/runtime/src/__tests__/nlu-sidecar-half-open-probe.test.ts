/**
 * NLU Sidecar Client Half-Open Probe Tests
 *
 * Verifies the probeInProgress flag in NLUSidecarClient's internal circuit
 * breaker ensures only one request passes through during the half-open state.
 * Tests exercise the circuit breaker through the public API (extract / detectCorrection).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  NLUSidecarClient,
  type SidecarCallContext,
  type SidecarResult,
} from '../services/nlu/sidecar-client.js';

const CTX: SidecarCallContext = {
  tenantId: 'tenant-1',
  projectId: 'project-1',
  sessionId: 'session-1',
};

function expectErr<T>(
  result: SidecarResult<T>,
  kind: 'unavailable' | 'timeout' | 'circuit_open' | 'no_match' | 'invalid_response',
): void {
  if (result.ok) {
    throw new Error(`expected err with kind=${kind}, got ok`);
  }
  expect(result.error.kind).toBe(kind);
}

describe('NLUSidecarClient half-open probe guard', () => {
  let client: NLUSidecarClient;
  let originalFetch: typeof globalThis.fetch;

  const THRESHOLD = 3;
  const RESET_MS = 5000;

  beforeEach(() => {
    vi.useFakeTimers();
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn();
    client = new NLUSidecarClient({
      url: 'http://localhost:8090',
      circuitBreakerThreshold: THRESHOLD,
      circuitBreakerResetMs: RESET_MS,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  /**
   * Helper: make the sidecar fail `count` times to trip the circuit breaker.
   */
  async function tripBreaker(count: number = THRESHOLD): Promise<void> {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockRejectedValue(new Error('Connection refused'));

    for (let i = 0; i < count; i++) {
      const result = await client.extract(
        {
          text: 'fail',
          fields: [],
          locale: 'en',
        },
        CTX,
      );
      expectErr(result, 'unavailable');
    }
  }

  it('allows first probe after transition to half-open', async () => {
    await tripBreaker();

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;

    // Advance time past the reset timeout
    vi.advanceTimersByTime(RESET_MS + 1);

    // Mock a successful response for the probe request
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ entities: { name: 'John' }, confidence: { name: 0.95 } }),
    } as Response);

    const result = await client.extract(
      {
        text: 'hello',
        fields: [{ name: 'name', type: 'string', hints: [] }],
        locale: 'en',
      },
      CTX,
    );

    // The probe request should have gone through
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.entities).toEqual({ name: 'John' });
    }

    // fetch should have been called for this request
    // (THRESHOLD failures + 1 probe = THRESHOLD + 1 total calls)
    expect(fetchMock).toHaveBeenCalledTimes(THRESHOLD + 1);
  });

  it('blocks second request when probe is in progress', async () => {
    await tripBreaker();

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;

    // Advance time past reset timeout
    vi.advanceTimersByTime(RESET_MS + 1);

    // Make fetch hang so the probe stays in-flight
    let resolveFetch!: (value: Response) => void;
    const pendingFetch = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    fetchMock.mockReturnValueOnce(pendingFetch);

    // Start the first (probe) request — do not await it yet
    const probePromise = client.extract(
      {
        text: 'probe',
        fields: [],
        locale: 'en',
      },
      CTX,
    );

    // The second request should be blocked immediately (circuit open for non-probe)
    const blocked = await client.extract(
      {
        text: 'blocked',
        fields: [],
        locale: 'en',
      },
      CTX,
    );
    expectErr(blocked, 'circuit_open');

    // fetch should have been called only for the probe (not the blocked request)
    // THRESHOLD failures + 1 probe = THRESHOLD + 1
    expect(fetchMock).toHaveBeenCalledTimes(THRESHOLD + 1);

    // Resolve the probe so it completes
    resolveFetch({
      ok: true,
      json: async () => ({ entities: {}, confidence: {} }),
    } as Response);

    const probeResult = await probePromise;
    expect(probeResult.ok).toBe(true);
  });

  it('recordSuccess clears flag and subsequent requests go through', async () => {
    await tripBreaker();

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;

    // Advance time past reset timeout
    vi.advanceTimersByTime(RESET_MS + 1);

    // Mock successful probe
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ entities: {}, confidence: {} }),
    } as Response);

    const probe = await client.extract({ text: 'probe', fields: [], locale: 'en' }, CTX);
    expect(probe.ok).toBe(true);

    // Circuit should now be closed; subsequent requests should succeed
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ entities: { city: 'NYC' }, confidence: { city: 0.9 } }),
    } as Response);

    const next = await client.extract(
      {
        text: 'next',
        fields: [{ name: 'city', type: 'string', hints: [] }],
        locale: 'en',
      },
      CTX,
    );
    expect(next.ok).toBe(true);
    if (next.ok) {
      expect(next.value.entities).toEqual({ city: 'NYC' });
    }

    // THRESHOLD failures + 2 successful calls
    expect(fetchMock).toHaveBeenCalledTimes(THRESHOLD + 2);
  });

  it('recordFailure clears flag and blocks until next timeout', async () => {
    await tripBreaker();

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;

    // Advance time past reset timeout
    vi.advanceTimersByTime(RESET_MS + 1);

    // Probe fails
    fetchMock.mockRejectedValueOnce(new Error('Still down'));

    const probe = await client.extract({ text: 'probe', fields: [], locale: 'en' }, CTX);
    expectErr(probe, 'unavailable');

    // Circuit should be back to open; requests should be blocked without calling fetch
    const callCountAfterProbe = fetchMock.mock.calls.length;

    const blocked = await client.extract({ text: 'blocked', fields: [], locale: 'en' }, CTX);
    expectErr(blocked, 'circuit_open');

    // No new fetch call should have been made
    expect(fetchMock).toHaveBeenCalledTimes(callCountAfterProbe);

    // Advance time past reset timeout again
    vi.advanceTimersByTime(RESET_MS + 1);

    // Now a new probe should be allowed
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ entities: {}, confidence: {} }),
    } as Response);

    const newProbe = await client.extract({ text: 'retry', fields: [], locale: 'en' }, CTX);
    expect(newProbe.ok).toBe(true);
  });

  it('recordSuccess when circuit is closed is a no-op for state transition', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;

    // Client starts with circuit closed
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ entities: { test: 'value' }, confidence: { test: 0.85 } }),
    } as Response);

    // Call extract when circuit is already closed
    const result = await client.extract(
      {
        text: 'test',
        fields: [{ name: 'test', type: 'string', hints: [] }],
        locale: 'en',
      },
      CTX,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.entities).toEqual({ test: 'value' });
    }

    // Circuit should still be closed; subsequent requests should succeed
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ entities: { test: 'value2' }, confidence: { test: 0.9 } }),
    } as Response);

    const result2 = await client.extract(
      {
        text: 'test2',
        fields: [{ name: 'test', type: 'string', hints: [] }],
        locale: 'en',
      },
      CTX,
    );

    expect(result2.ok).toBe(true);
    if (result2.ok) {
      expect(result2.value.entities).toEqual({ test: 'value2' });
    }

    // No errors should have been thrown
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
