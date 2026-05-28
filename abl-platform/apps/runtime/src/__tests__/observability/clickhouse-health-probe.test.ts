/**
 * ClickHouse Health Probe Tests
 *
 * Validates that the active ClickHouse probe correctly reports
 * ok/failure states, measures latency, and handles edge cases.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  probeClickHouse,
  startClickHouseProbe,
  stopClickHouseProbe,
  getLastProbeResult,
} from '../../health/clickhouse-probe.js';

// Suppress logger output during tests
vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('ClickHouse health probe', () => {
  afterEach(() => {
    stopClickHouseProbe();
  });

  // ─── probeClickHouse() ──────────────────────────────────────────────

  it('returns ok=true when ping succeeds', async () => {
    const client = { ping: vi.fn().mockResolvedValue({ success: true }) };
    const result = await probeClickHouse(client);

    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
    expect(client.ping).toHaveBeenCalled();
  });

  it('returns ok=false when ping reports failure', async () => {
    const client = {
      ping: vi.fn().mockResolvedValue({ success: false, error: new Error('Connection refused') }),
    };
    const result = await probeClickHouse(client);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Connection refused');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns ok=false with error message when ping throws', async () => {
    const client = { ping: vi.fn().mockRejectedValue(new Error('Connection refused')) };
    const result = await probeClickHouse(client);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Connection refused');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('handles non-Error rejections gracefully', async () => {
    const client = { ping: vi.fn().mockRejectedValue('string error') };
    const result = await probeClickHouse(client);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('string error');
  });

  it('measures latency for both success and failure', async () => {
    // Slow success
    const slowClient = {
      ping: vi
        .fn()
        .mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve({ success: true }), 50)),
        ),
    };
    const successResult = await probeClickHouse(slowClient);
    expect(successResult.ok).toBe(true);
    // Latency should be at least ~50ms (allow some tolerance for CI)
    expect(successResult.latencyMs).toBeGreaterThanOrEqual(30);

    // Slow failure
    const slowFailClient = {
      ping: vi
        .fn()
        .mockImplementation(
          () =>
            new Promise((_resolve, reject) => setTimeout(() => reject(new Error('timeout')), 50)),
        ),
    };
    const failResult = await probeClickHouse(slowFailClient);
    expect(failResult.ok).toBe(false);
    expect(failResult.latencyMs).toBeGreaterThanOrEqual(30);
  });

  // ─── Periodic probe lifecycle ───────────────────────────────────────

  describe('startClickHouseProbe / stopClickHouseProbe', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      stopClickHouseProbe();
      vi.useRealTimers();
    });

    it('getLastProbeResult returns null before probe starts', () => {
      expect(getLastProbeResult()).toBeNull();
    });

    it('populates lastProbeResult after initial probe fires', async () => {
      const client = { ping: vi.fn().mockResolvedValue({ success: true }) };

      startClickHouseProbe(client);

      // The initial probe is a fire-and-forget promise — flush microtasks
      await vi.advanceTimersByTimeAsync(0);

      const result = getLastProbeResult();
      expect(result).not.toBeNull();
      expect(result!.ok).toBe(true);
    });

    it('updates result on periodic interval', async () => {
      let callCount = 0;
      const client = {
        ping: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount <= 2) return Promise.resolve({ success: true });
          return Promise.reject(new Error('gone'));
        }),
      };

      // Set a short interval for the test
      process.env.CLICKHOUSE_PROBE_INTERVAL_MS = '1000';
      startClickHouseProbe(client);

      // Flush initial probe
      await vi.advanceTimersByTimeAsync(0);
      expect(getLastProbeResult()!.ok).toBe(true);

      // Advance past one interval — second call still succeeds
      await vi.advanceTimersByTimeAsync(1000);
      expect(getLastProbeResult()!.ok).toBe(true);

      // Advance past another interval — third call fails
      await vi.advanceTimersByTimeAsync(1000);
      expect(getLastProbeResult()!.ok).toBe(false);
      expect(getLastProbeResult()!.error).toContain('gone');

      delete process.env.CLICKHOUSE_PROBE_INTERVAL_MS;
    });

    it('stopClickHouseProbe clears the cached result', async () => {
      const client = { ping: vi.fn().mockResolvedValue({ success: true }) };

      startClickHouseProbe(client);
      await vi.advanceTimersByTimeAsync(0);
      expect(getLastProbeResult()).not.toBeNull();

      stopClickHouseProbe();
      expect(getLastProbeResult()).toBeNull();
    });

    it('is safe to call stopClickHouseProbe when not started', () => {
      expect(() => stopClickHouseProbe()).not.toThrow();
    });

    it('start is idempotent — second call is a no-op', async () => {
      const client = { ping: vi.fn().mockResolvedValue({ success: true }) };

      startClickHouseProbe(client);
      startClickHouseProbe(client); // should not create a second interval

      // Flush microtasks for the initial probe
      await vi.advanceTimersByTimeAsync(0);

      // Only the initial probe from the first start should have fired
      // The second startClickHouseProbe call is a no-op (probeTimer !== null)
      expect(client.ping).toHaveBeenCalledTimes(1);
    });
  });
});
