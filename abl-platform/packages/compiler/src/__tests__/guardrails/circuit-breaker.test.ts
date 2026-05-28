import { describe, it, expect } from 'vitest';
import { CircuitBreaker } from '../../platform/guardrails/circuit-breaker';

describe('CircuitBreaker', () => {
  it('should start in CLOSED state', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });
    expect(cb.state).toBe('closed');
    expect(cb.canExecute()).toBe(true);
  });

  it('should open after threshold failures', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe('closed');
    cb.recordFailure();
    expect(cb.state).toBe('open');
    expect(cb.canExecute()).toBe(false);
  });

  it('should reset failure count on success', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    expect(cb.state).toBe('closed');
    cb.recordFailure(); // Now at 1, not 3
    expect(cb.state).toBe('closed');
  });

  it('should transition to half-open after timeout', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 50 });
    cb.recordFailure(); // Opens
    expect(cb.state).toBe('open');

    await new Promise((r) => setTimeout(r, 60));

    expect(cb.canExecute()).toBe(true); // Allows one attempt (half-open)
    expect(cb.state).toBe('half-open');
  });

  it('should close after successful half-open attempt', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 50 });
    cb.recordFailure(); // Opens

    await new Promise((r) => setTimeout(r, 60));

    cb.canExecute(); // Transitions to half-open
    cb.recordSuccess(); // Closes
    expect(cb.state).toBe('closed');
  });

  it('should re-open after failed half-open attempt', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 50 });
    cb.recordFailure(); // Opens

    await new Promise((r) => setTimeout(r, 60));

    cb.canExecute(); // Transitions to half-open
    cb.recordFailure(); // Re-opens
    expect(cb.state).toBe('open');
  });

  it('should track consecutive failures', () => {
    const cb = new CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 1000 });
    for (let i = 0; i < 4; i++) cb.recordFailure();
    expect(cb.state).toBe('closed');
    expect(cb.consecutiveFailures).toBe(4);
  });

  it('should use default config when none provided', () => {
    const cb = new CircuitBreaker();
    expect(cb.state).toBe('closed');
    // Default threshold is 5
    for (let i = 0; i < 4; i++) cb.recordFailure();
    expect(cb.state).toBe('closed');
    cb.recordFailure();
    expect(cb.state).toBe('open');
  });

  it('should not allow execution when open and timeout has not elapsed', () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 60000 });
    cb.recordFailure();
    expect(cb.state).toBe('open');
    expect(cb.canExecute()).toBe(false);
  });

  it('should reset consecutive failures to zero on success', () => {
    const cb = new CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 1000 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.consecutiveFailures).toBe(2);
    cb.recordSuccess();
    expect(cb.consecutiveFailures).toBe(0);
  });

  describe('halfOpenMaxAttempts', () => {
    it('should re-open after single failure when halfOpenMaxAttempts=1 (default)', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 50 });
      cb.recordFailure(); // Opens
      await new Promise((r) => setTimeout(r, 60));
      cb.canExecute(); // Transitions to half-open
      cb.recordFailure(); // 1 >= 1, re-opens
      expect(cb.state).toBe('open');
    });

    it('should stay half-open after first failures when halfOpenMaxAttempts=3', async () => {
      const cb = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeoutMs: 50,
        halfOpenMaxAttempts: 3,
      });
      cb.recordFailure(); // Opens
      await new Promise((r) => setTimeout(r, 60));
      cb.canExecute(); // Transitions to half-open

      cb.recordFailure(); // 1st half-open failure
      expect(cb.state).toBe('half-open');
      expect(cb.canExecute()).toBe(true); // Still allows attempts

      cb.recordFailure(); // 2nd half-open failure
      expect(cb.state).toBe('half-open');
      expect(cb.canExecute()).toBe(true); // Still allows one more

      cb.recordFailure(); // 3rd half-open failure (3 >= 3), re-opens
      expect(cb.state).toBe('open');
    });

    it('should close on success mid-way through half-open attempts', async () => {
      const cb = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeoutMs: 50,
        halfOpenMaxAttempts: 3,
      });
      cb.recordFailure(); // Opens
      await new Promise((r) => setTimeout(r, 60));
      cb.canExecute(); // Transitions to half-open

      cb.recordFailure(); // 1st half-open failure
      expect(cb.state).toBe('half-open');

      cb.recordSuccess(); // Success resets and closes
      expect(cb.state).toBe('closed');
    });

    it('should reset half-open counter on open→half-open transition', async () => {
      const cb = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeoutMs: 50,
        halfOpenMaxAttempts: 2,
      });
      // First cycle: open → half-open → exhaust attempts → re-open
      cb.recordFailure();
      await new Promise((r) => setTimeout(r, 60));
      cb.canExecute(); // half-open, counter reset to 0
      cb.recordFailure(); // 1st
      cb.recordFailure(); // 2nd, re-opens
      expect(cb.state).toBe('open');

      // Second cycle: counter should be reset
      await new Promise((r) => setTimeout(r, 60));
      cb.canExecute(); // half-open again, counter reset to 0
      expect(cb.state).toBe('half-open');
      cb.recordFailure(); // 1st (not 3rd)
      expect(cb.state).toBe('half-open'); // Still half-open
    });

    it('should block execution when half-open attempts exhausted but not yet re-opened', async () => {
      const cb = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeoutMs: 50,
        halfOpenMaxAttempts: 1,
      });
      cb.recordFailure(); // Opens
      await new Promise((r) => setTimeout(r, 60));
      cb.canExecute(); // half-open
      // Don't record anything yet — attempt counter is 0, under limit
      expect(cb.canExecute()).toBe(true);
    });
  });
});
