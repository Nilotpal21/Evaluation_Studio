import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitCircuitBreaker, GitCircuitBreakerError } from '../git/git-circuit-breaker.js';

describe('GitCircuitBreaker', () => {
  let breaker: GitCircuitBreaker;

  beforeEach(() => {
    breaker = new GitCircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1_000 });
  });

  it('starts in CLOSED state', () => {
    expect(breaker.getState()).toBe('CLOSED');
    expect(breaker.getFailureCount()).toBe(0);
  });

  it('allows requests through when CLOSED', async () => {
    const result = await breaker.execute(async () => 'ok');
    expect(result).toBe('ok');
    expect(breaker.getState()).toBe('CLOSED');
  });

  it('stays CLOSED after failures below threshold', async () => {
    for (let i = 0; i < 2; i++) {
      await expect(
        breaker.execute(async () => {
          throw new Error('fail');
        }),
      ).rejects.toThrow('fail');
    }
    expect(breaker.getState()).toBe('CLOSED');
    expect(breaker.getFailureCount()).toBe(2);
  });

  it('opens after consecutive failures reach threshold', async () => {
    for (let i = 0; i < 3; i++) {
      await expect(
        breaker.execute(async () => {
          throw new Error('fail');
        }),
      ).rejects.toThrow('fail');
    }
    expect(breaker.getState()).toBe('OPEN');
    expect(breaker.getFailureCount()).toBe(3);
  });

  it('rejects immediately when OPEN', async () => {
    // Trip the breaker with consecutive failures
    for (let i = 0; i < 3; i++) {
      await expect(
        breaker.execute(async () => {
          throw new Error('fail');
        }),
      ).rejects.toThrow('fail');
    }

    await expect(breaker.execute(async () => 'should not run')).rejects.toThrow(
      GitCircuitBreakerError,
    );

    await expect(breaker.execute(async () => 'should not run')).rejects.toThrow(
      'Circuit breaker OPEN [tool_service:git]',
    );
  });

  it('includes retryAfterMs on GitCircuitBreakerError', async () => {
    for (let i = 0; i < 3; i++) {
      await expect(
        breaker.execute(async () => {
          throw new Error('fail');
        }),
      ).rejects.toThrow('fail');
    }

    try {
      await breaker.execute(async () => 'nope');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GitCircuitBreakerError);
      const cbErr = err as GitCircuitBreakerError;
      expect(cbErr.retryAfterMs).toBeGreaterThan(0);
      expect(cbErr.retryAfterMs).toBeLessThanOrEqual(1_000);
      expect(cbErr.state).toBe('OPEN');
    }
  });

  it('resets failure count on success', async () => {
    // 2 failures
    for (let i = 0; i < 2; i++) {
      await expect(
        breaker.execute(async () => {
          throw new Error('fail');
        }),
      ).rejects.toThrow();
    }
    expect(breaker.getFailureCount()).toBe(2);

    // 1 success resets
    await breaker.execute(async () => 'ok');
    expect(breaker.getFailureCount()).toBe(0);
    expect(breaker.getState()).toBe('CLOSED');
  });

  it('transitions to HALF_OPEN after resetTimeout', async () => {
    vi.useFakeTimers();

    // Trip the breaker
    for (let i = 0; i < 3; i++) {
      await expect(
        breaker.execute(async () => {
          throw new Error('fail');
        }),
      ).rejects.toThrow('fail');
    }
    expect(breaker.getState()).toBe('OPEN');

    // Advance time past resetTimeout
    vi.advanceTimersByTime(1_100);

    // Next call should go through (half-open probe)
    const result = await breaker.execute(async () => 'probe-ok');
    expect(result).toBe('probe-ok');
    expect(breaker.getState()).toBe('CLOSED');

    vi.useRealTimers();
  });

  it('re-opens on HALF_OPEN probe failure', async () => {
    vi.useFakeTimers();

    // Trip the breaker
    for (let i = 0; i < 3; i++) {
      await expect(
        breaker.execute(async () => {
          throw new Error('fail');
        }),
      ).rejects.toThrow('fail');
    }
    expect(breaker.getState()).toBe('OPEN');

    // Advance time past resetTimeout
    vi.advanceTimersByTime(1_100);

    // Probe fails — should re-open
    await expect(
      breaker.execute(async () => {
        throw new Error('probe-fail');
      }),
    ).rejects.toThrow('probe-fail');
    expect(breaker.getState()).toBe('OPEN');

    vi.useRealTimers();
  });

  it('uses default config when none provided', async () => {
    const defaultBreaker = new GitCircuitBreaker();
    expect(defaultBreaker.getState()).toBe('CLOSED');
    // Should use threshold=3 by default
    for (let i = 0; i < 2; i++) {
      await expect(
        defaultBreaker.execute(async () => {
          throw new Error('fail');
        }),
      ).rejects.toThrow();
    }
    expect(defaultBreaker.getState()).toBe('CLOSED');
  });

  it('propagates the original error from the wrapped function', async () => {
    const customError = new TypeError('custom type error');
    await expect(
      breaker.execute(async () => {
        throw customError;
      }),
    ).rejects.toBe(customError);
  });
});
