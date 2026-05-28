/**
 * NLU Circuit Breaker Tests
 *
 * Tests the per-layer circuit breaker: state machine transitions,
 * failure thresholds, timeout-based recovery, and reset operations.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { NLUCircuitBreaker } from '../../platform/nlu/enterprise/circuit-breaker.js';

// =============================================================================
// HELPERS
// =============================================================================

function makeBreaker(opts?: {
  enabled?: boolean;
  failureThreshold?: number;
  resetTimeoutMs?: number;
}) {
  return new NLUCircuitBreaker({
    enabled: opts?.enabled ?? true,
    failureThreshold: opts?.failureThreshold ?? 3,
    resetTimeoutMs: opts?.resetTimeoutMs ?? 5000,
  });
}

async function failN(breaker: NLUCircuitBreaker, layer: string, n: number) {
  for (let i = 0; i < n; i++) {
    try {
      await breaker.wrapLLMCall(layer, () => Promise.reject(new Error('fail')));
    } catch {
      // expected
    }
  }
}

// =============================================================================
// TESTS
// =============================================================================

describe('NLUCircuitBreaker', () => {
  let nowSpy: ReturnType<typeof vi.spyOn>;
  let currentTime: number;

  beforeEach(() => {
    currentTime = 1000000;
    nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => currentTime);
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  // =========================================================================
  // DISABLED MODE
  // =========================================================================

  describe('disabled mode', () => {
    test('passes calls through directly when disabled', async () => {
      const breaker = makeBreaker({ enabled: false });
      const result = await breaker.wrapLLMCall('fast', () => Promise.resolve('ok'));
      expect(result).toBe('ok');
    });

    test('state is always closed when disabled', async () => {
      const breaker = makeBreaker({ enabled: false });
      // Even after failures, state stays closed because disabled breaker doesn't track
      expect(breaker.getState('fast')).toBe('closed');
    });
  });

  // =========================================================================
  // CLOSED STATE
  // =========================================================================

  describe('closed state', () => {
    test('successful calls return result and stay closed', async () => {
      const breaker = makeBreaker();
      const result = await breaker.wrapLLMCall('fast', () => Promise.resolve(42));
      expect(result).toBe(42);
      expect(breaker.getState('fast')).toBe('closed');
    });

    test('failures below threshold stay closed', async () => {
      const breaker = makeBreaker({ failureThreshold: 3 });
      await failN(breaker, 'fast', 2);
      expect(breaker.getState('fast')).toBe('closed');
    });

    test('failure at threshold transitions to open', async () => {
      const breaker = makeBreaker({ failureThreshold: 3 });
      await failN(breaker, 'fast', 3);
      expect(breaker.getState('fast')).toBe('open');
    });

    test('success resets failure count', async () => {
      const breaker = makeBreaker({ failureThreshold: 3 });
      await failN(breaker, 'fast', 2);
      await breaker.wrapLLMCall('fast', () => Promise.resolve('ok'));
      // Now 2 more failures should not open (count was reset)
      await failN(breaker, 'fast', 2);
      expect(breaker.getState('fast')).toBe('closed');
    });
  });

  // =========================================================================
  // OPEN STATE
  // =========================================================================

  describe('open state', () => {
    test('returns null when timeout not elapsed', async () => {
      const breaker = makeBreaker({ failureThreshold: 1, resetTimeoutMs: 5000 });
      await failN(breaker, 'fast', 1);
      expect(breaker.getState('fast')).toBe('open');

      // Advance time by less than resetTimeoutMs
      currentTime += 3000;
      const result = await breaker.wrapLLMCall('fast', () => Promise.resolve('ok'));
      expect(result).toBeNull();
    });

    test('transitions to half-open after resetTimeoutMs elapsed', async () => {
      const breaker = makeBreaker({ failureThreshold: 1, resetTimeoutMs: 5000 });
      await failN(breaker, 'fast', 1);
      expect(breaker.getState('fast')).toBe('open');

      // Advance time past resetTimeoutMs
      currentTime += 5000;
      // The transition happens on the next wrapLLMCall attempt
      await breaker.wrapLLMCall('fast', () => Promise.resolve('ok'));
      expect(breaker.getState('fast')).toBe('closed'); // success in half-open -> closed
    });

    test('different layers have independent circuits', async () => {
      const breaker = makeBreaker({ failureThreshold: 1 });
      await failN(breaker, 'fast', 1);
      expect(breaker.getState('fast')).toBe('open');
      expect(breaker.getState('balanced')).toBe('closed');

      const result = await breaker.wrapLLMCall('balanced', () => Promise.resolve('ok'));
      expect(result).toBe('ok');
    });
  });

  // =========================================================================
  // HALF-OPEN STATE
  // =========================================================================

  describe('half-open state', () => {
    test('success transitions back to closed and resets counters', async () => {
      const breaker = makeBreaker({ failureThreshold: 1, resetTimeoutMs: 5000 });
      await failN(breaker, 'fast', 1);
      expect(breaker.getState('fast')).toBe('open');

      // Advance past timeout
      currentTime += 5000;
      const result = await breaker.wrapLLMCall('fast', () => Promise.resolve('recovered'));
      expect(result).toBe('recovered');
      expect(breaker.getState('fast')).toBe('closed');
    });

    test('failure immediately reopens (no threshold check)', async () => {
      const breaker = makeBreaker({ failureThreshold: 3, resetTimeoutMs: 5000 });
      await failN(breaker, 'fast', 3);
      expect(breaker.getState('fast')).toBe('open');

      // Advance past timeout to enter half-open
      currentTime += 5000;
      // One failure in half-open should immediately reopen
      try {
        await breaker.wrapLLMCall('fast', () => Promise.reject(new Error('still broken')));
      } catch {
        // expected
      }
      expect(breaker.getState('fast')).toBe('open');
    });
  });

  // =========================================================================
  // RESET
  // =========================================================================

  describe('reset', () => {
    test('reset(layer) resets specific layer to closed', async () => {
      const breaker = makeBreaker({ failureThreshold: 1 });
      await failN(breaker, 'fast', 1);
      await failN(breaker, 'balanced', 1);
      expect(breaker.getState('fast')).toBe('open');
      expect(breaker.getState('balanced')).toBe('open');

      breaker.reset('fast');
      expect(breaker.getState('fast')).toBe('closed');
      expect(breaker.getState('balanced')).toBe('open');
    });

    test('resetAll() clears all circuits', async () => {
      const breaker = makeBreaker({ failureThreshold: 1 });
      await failN(breaker, 'fast', 1);
      await failN(breaker, 'balanced', 1);

      breaker.resetAll();
      expect(breaker.getState('fast')).toBe('closed');
      expect(breaker.getState('balanced')).toBe('closed');
    });
  });

  // =========================================================================
  // ERROR PROPAGATION
  // =========================================================================

  describe('error propagation', () => {
    test('throws the original error from the wrapped function', async () => {
      const breaker = makeBreaker();
      const err = new Error('LLM timeout');
      await expect(breaker.wrapLLMCall('fast', () => Promise.reject(err))).rejects.toThrow(
        'LLM timeout',
      );
    });
  });
});
