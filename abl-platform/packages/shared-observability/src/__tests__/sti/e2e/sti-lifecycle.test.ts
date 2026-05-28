/**
 * E2E: STI tracePath Lifecycle
 *
 * Tests the full STI flow:
 * 1. STI_ENABLED=true activates tracing
 * 2. ALS provides traceId context
 * 3. tracePath-wrapped functions record entries in STRBuffer
 * 4. Flush returns expected entries
 * 5. Kill switch disables recording
 * 6. Circuit breaker stops writes after repeated flush failures
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../context.js', () => ({
  getCurrentTraceId: vi.fn(),
}));

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let tracePathMod: typeof import('../../../sti/trace-path.js');
let getCurrentTraceIdMock: ReturnType<typeof vi.fn>;

import { STRBuffer, CIRCUIT_FAILURE_THRESHOLD } from '../../../sti/str-buffer.js';

describe('STI tracePath E2E Lifecycle', () => {
  let buffer: STRBuffer;

  beforeEach(async () => {
    buffer = new STRBuffer();
    const ctx = await import('../../../context.js');
    getCurrentTraceIdMock = ctx.getCurrentTraceId as ReturnType<typeof vi.fn>;
    tracePathMod = await import('../../../sti/trace-path.js');
    tracePathMod.setSharedSTRBuffer(buffer);
  });

  afterEach(() => {
    buffer.destroy();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe('full lifecycle with STI_ENABLED=true', () => {
    beforeEach(() => {
      vi.stubEnv('STI_ENABLED', 'true');
    });

    it('records entries from multiple tracePath-wrapped functions in sequence', async () => {
      getCurrentTraceIdMock.mockReturnValue('trace-abc');

      const step1 = tracePathMod.tracePath('agent/greeter/enter', async () => 'entered');
      const step2 = tracePathMod.tracePath('llm/chat/invoke', async () => 'response');
      const step3 = tracePathMod.tracePath('tool/weather/execute', async () => ({ temp: 72 }));

      const r1 = await step1();
      const r2 = await step2();
      const r3 = await step3();

      expect(r1).toBe('entered');
      expect(r2).toBe('response');
      expect(r3).toEqual({ temp: 72 });

      const entries = buffer.flush('trace-abc');
      expect(entries).toHaveLength(3);
      expect(entries[0].path).toBe('agent/greeter/enter');
      expect(entries[1].path).toBe('llm/chat/invoke');
      expect(entries[2].path).toBe('tool/weather/execute');

      // All entries should be successful
      for (const entry of entries) {
        expect(entry.outcome).toBe('success');
        expect(entry.durationUs).toBeGreaterThanOrEqual(0);
        expect(entry.timestamp).toBeGreaterThan(0);
      }
    });

    it('records entries across different traces independently', async () => {
      const fn = tracePathMod.tracePath('shared/path', async () => 'ok');

      getCurrentTraceIdMock.mockReturnValue('trace-1');
      await fn();
      await fn();

      getCurrentTraceIdMock.mockReturnValue('trace-2');
      await fn();

      const entries1 = buffer.flush('trace-1');
      const entries2 = buffer.flush('trace-2');

      expect(entries1).toHaveLength(2);
      expect(entries2).toHaveLength(1);
    });

    it('records error entries when wrapped function throws', async () => {
      getCurrentTraceIdMock.mockReturnValue('trace-err');

      const failing = tracePathMod.tracePath('failing/op', async () => {
        throw new Error('boom');
      });

      await expect(failing()).rejects.toThrow('boom');

      const entries = buffer.flush('trace-err');
      expect(entries).toHaveLength(1);
      expect(entries[0].outcome).toBe('error');
      expect(entries[0].durationUs).toBeGreaterThanOrEqual(0);
    });

    it('records depth parameter correctly', async () => {
      getCurrentTraceIdMock.mockReturnValue('trace-depth');

      const d0 = tracePathMod.tracePath('root/op', async () => 'ok', 0);
      const d1 = tracePathMod.tracePath('child/op', async () => 'ok', 1);
      const d2 = tracePathMod.tracePath('grandchild/op', async () => 'ok', 2);

      await d0();
      await d1();
      await d2();

      const entries = buffer.flush('trace-depth');
      expect(entries[0].depth).toBe(0);
      expect(entries[1].depth).toBe(1);
      expect(entries[2].depth).toBe(2);
    });

    it('flush returns empty array for unknown trace', () => {
      const entries = buffer.flush('nonexistent-trace');
      expect(entries).toEqual([]);
    });

    it('flush removes trace from buffer', async () => {
      getCurrentTraceIdMock.mockReturnValue('trace-flush');
      const fn = tracePathMod.tracePath('test/flush', async () => 'ok');
      await fn();

      expect(buffer.size).toBe(1);
      const entries = buffer.flush('trace-flush');
      expect(entries).toHaveLength(1);
      expect(buffer.size).toBe(0);

      // Second flush returns empty
      const entries2 = buffer.flush('trace-flush');
      expect(entries2).toEqual([]);
    });
  });

  describe('kill switch (STI_ENABLED=false)', () => {
    it('returns original function when disabled (zero overhead)', () => {
      // STI_ENABLED is not set (default = false)
      const fn = async () => 'original';
      const wrapped = tracePathMod.tracePath('test/disabled', fn);
      expect(wrapped).toBe(fn);
    });

    it('does not record entries when disabled', async () => {
      getCurrentTraceIdMock.mockReturnValue('trace-disabled');
      const fn = tracePathMod.tracePath('test/disabled', async () => 'ok');
      await fn();

      expect(buffer.size).toBe(0);
    });
  });

  describe('no traceId in ALS context', () => {
    beforeEach(() => {
      vi.stubEnv('STI_ENABLED', 'true');
    });

    it('executes function without recording when no traceId', async () => {
      getCurrentTraceIdMock.mockReturnValue(undefined);

      const fn = tracePathMod.tracePath('test/no-trace', async () => 'ok');
      const result = await fn();

      expect(result).toBe('ok');
      expect(buffer.size).toBe(0);
    });
  });

  describe('circuit breaker', () => {
    beforeEach(() => {
      vi.stubEnv('STI_ENABLED', 'true');
    });

    it('opens circuit after consecutive flush failures, rejecting writes', async () => {
      getCurrentTraceIdMock.mockReturnValue('trace-cb');

      // Record an initial entry to confirm writes work
      const fn = tracePathMod.tracePath('test/cb', async () => 'ok');
      await fn();
      expect(buffer.size).toBe(1);
      buffer.flush('trace-cb');

      // Simulate consecutive flush failures to open the circuit
      for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
        buffer.reportFlushFailure();
      }

      expect(buffer.isCircuitOpen()).toBe(true);

      // New writes should be silently rejected (noop handle)
      getCurrentTraceIdMock.mockReturnValue('trace-cb-after');
      const fn2 = tracePathMod.tracePath('test/cb-after', async () => 'ok');
      await fn2();

      // With circuit open, recordEntry returns noopHandle without pushing
      const entries = buffer.flush('trace-cb-after');
      expect(entries).toHaveLength(0);
    });

    it('resets circuit after timeout period', async () => {
      // Simulate circuit opening
      for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
        buffer.reportFlushFailure();
      }
      expect(buffer.isCircuitOpen()).toBe(true);

      // Fast-forward time past circuit reset
      const originalNow = Date.now;
      Date.now = () => originalNow() + 31_000; // 31s > CIRCUIT_RESET_MS (30s)

      expect(buffer.isCircuitOpen()).toBe(false);

      Date.now = originalNow;
    });

    it('resets failure counter on successful flush', () => {
      // Partially fill the failure counter
      for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD - 1; i++) {
        buffer.reportFlushFailure();
      }

      // Report success — resets counter
      buffer.reportFlushSuccess();

      // Now failures need to start over
      for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD - 1; i++) {
        buffer.reportFlushFailure();
      }

      expect(buffer.isCircuitOpen()).toBe(false);
    });
  });

  describe('exception safety', () => {
    beforeEach(() => {
      vi.stubEnv('STI_ENABLED', 'true');
    });

    it('does not propagate ALS errors to the caller', async () => {
      getCurrentTraceIdMock.mockImplementation(() => {
        throw new Error('ALS broken');
      });

      const fn = tracePathMod.tracePath('test/safety', async () => 'safe');
      const result = await fn();
      expect(result).toBe('safe');
    });

    it('preserves this context through tracePath wrapper', async () => {
      getCurrentTraceIdMock.mockReturnValue('trace-this');

      const obj = {
        multiplier: 5,
        async compute(x: number) {
          return x * this.multiplier;
        },
      };

      obj.compute = tracePathMod.tracePath('test/this', obj.compute);
      const result = await obj.compute(10);
      expect(result).toBe(50);
    });
  });
});
