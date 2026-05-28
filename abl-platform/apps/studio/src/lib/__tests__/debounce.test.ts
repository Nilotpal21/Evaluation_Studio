/**
 * Tests for debounceAsync utility.
 *
 * Uses vi.useFakeTimers() for deterministic timer control.
 * Covers: trailing mode, leading mode, cancel, pending, rapid calls,
 * argument forwarding, and edge cases.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { debounceAsync } from '@/lib/debounce';

describe('debounceAsync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // Trailing mode (default)
  // ---------------------------------------------------------------------------

  describe('trailing mode (default)', () => {
    test('does not fire immediately on call', () => {
      const fn = vi.fn(async () => {});
      const debounced = debounceAsync(fn, 300);

      debounced();

      expect(fn).not.toHaveBeenCalled();
    });

    test('fires after the delay elapses', () => {
      const fn = vi.fn(async () => {});
      const debounced = debounceAsync(fn, 300);

      debounced();
      vi.advanceTimersByTime(300);

      expect(fn).toHaveBeenCalledTimes(1);
    });

    test('rapid calls only fire once (last call wins)', () => {
      const fn = vi.fn(async (value: string) => {});
      const debounced = debounceAsync(fn, 200);

      debounced('first');
      debounced('second');
      debounced('third');

      vi.advanceTimersByTime(200);

      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith('third');
    });

    test('resets timer on each call', () => {
      const fn = vi.fn(async () => {});
      const debounced = debounceAsync(fn, 300);

      debounced();
      vi.advanceTimersByTime(200); // 200ms in — not yet fired
      debounced(); // resets timer
      vi.advanceTimersByTime(200); // 200ms after reset — still not fired
      expect(fn).not.toHaveBeenCalled();

      vi.advanceTimersByTime(100); // 300ms after last call
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test('fires again after delay if called again after first execution', () => {
      const fn = vi.fn(async () => {});
      const debounced = debounceAsync(fn, 100);

      debounced();
      vi.advanceTimersByTime(100);
      expect(fn).toHaveBeenCalledTimes(1);

      debounced();
      vi.advanceTimersByTime(100);
      expect(fn).toHaveBeenCalledTimes(2);
    });

    test('forwards all arguments to the original function', () => {
      const fn = vi.fn(async (a: number, b: string, c: boolean) => {});
      const debounced = debounceAsync(fn, 50);

      debounced(42, 'hello', true);
      vi.advanceTimersByTime(50);

      expect(fn).toHaveBeenCalledWith(42, 'hello', true);
    });

    test('does not fire if delay has not fully elapsed', () => {
      const fn = vi.fn(async () => {});
      const debounced = debounceAsync(fn, 500);

      debounced();
      vi.advanceTimersByTime(499);

      expect(fn).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Leading mode
  // ---------------------------------------------------------------------------

  describe('leading mode', () => {
    test('fires immediately on the first call', () => {
      const fn = vi.fn(async () => {});
      const debounced = debounceAsync(fn, 300, { leading: true });

      debounced();

      expect(fn).toHaveBeenCalledTimes(1);
    });

    test('subsequent calls within the delay are ignored', () => {
      const fn = vi.fn(async () => {});
      const debounced = debounceAsync(fn, 300, { leading: true });

      debounced();
      debounced();
      debounced();

      expect(fn).toHaveBeenCalledTimes(1);
    });

    test('allows a new leading call after cooldown expires', () => {
      const fn = vi.fn(async () => {});
      const debounced = debounceAsync(fn, 200, { leading: true });

      debounced();
      expect(fn).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(200);

      debounced();
      expect(fn).toHaveBeenCalledTimes(2);
    });

    test('resets cooldown timer on each subsequent call', () => {
      const fn = vi.fn(async () => {});
      const debounced = debounceAsync(fn, 300, { leading: true });

      debounced(); // fires immediately
      expect(fn).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(200);
      debounced(); // resets cooldown timer, does NOT fire
      expect(fn).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(200); // only 200ms after reset, not 300
      debounced(); // cooldown still active — should not fire
      expect(fn).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(300); // now cooldown expires

      debounced(); // new leading call
      expect(fn).toHaveBeenCalledTimes(2);
    });

    test('forwards arguments on the leading call', () => {
      const fn = vi.fn(async (x: number) => {});
      const debounced = debounceAsync(fn, 100, { leading: true });

      debounced(99);
      expect(fn).toHaveBeenCalledWith(99);
    });

    test('uses first call arguments, ignores subsequent ones during cooldown', () => {
      const fn = vi.fn(async (x: string) => {});
      const debounced = debounceAsync(fn, 200, { leading: true });

      debounced('first');
      debounced('second');
      debounced('third');

      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith('first');
    });
  });

  // ---------------------------------------------------------------------------
  // cancel()
  // ---------------------------------------------------------------------------

  describe('cancel()', () => {
    test('prevents a pending trailing call from firing', () => {
      const fn = vi.fn(async () => {});
      const debounced = debounceAsync(fn, 300);

      debounced();
      debounced.cancel();
      vi.advanceTimersByTime(300);

      expect(fn).not.toHaveBeenCalled();
    });

    test('resets leading state so next call fires immediately', () => {
      const fn = vi.fn(async () => {});
      const debounced = debounceAsync(fn, 300, { leading: true });

      debounced(); // fires immediately
      expect(fn).toHaveBeenCalledTimes(1);

      debounced.cancel(); // resets leading state

      debounced(); // should fire immediately again
      expect(fn).toHaveBeenCalledTimes(2);
    });

    test('is safe to call when nothing is pending', () => {
      const fn = vi.fn(async () => {});
      const debounced = debounceAsync(fn, 100);

      // No pending call — should not throw
      expect(() => debounced.cancel()).not.toThrow();
    });

    test('is safe to call multiple times in a row', () => {
      const fn = vi.fn(async () => {});
      const debounced = debounceAsync(fn, 100);

      debounced();
      debounced.cancel();
      debounced.cancel();
      debounced.cancel();

      vi.advanceTimersByTime(100);
      expect(fn).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // pending
  // ---------------------------------------------------------------------------

  describe('pending', () => {
    test('is false initially', () => {
      const fn = vi.fn(async () => {});
      const debounced = debounceAsync(fn, 200);

      expect(debounced.pending).toBe(false);
    });

    test('is true while a trailing call is pending', () => {
      const fn = vi.fn(async () => {});
      const debounced = debounceAsync(fn, 200);

      debounced();
      expect(debounced.pending).toBe(true);
    });

    test('is false after trailing call fires', () => {
      const fn = vi.fn(async () => {});
      const debounced = debounceAsync(fn, 200);

      debounced();
      vi.advanceTimersByTime(200);
      expect(debounced.pending).toBe(false);
    });

    test('is false after cancel()', () => {
      const fn = vi.fn(async () => {});
      const debounced = debounceAsync(fn, 200);

      debounced();
      expect(debounced.pending).toBe(true);
      debounced.cancel();
      expect(debounced.pending).toBe(false);
    });

    test('is true during leading cooldown', () => {
      const fn = vi.fn(async () => {});
      const debounced = debounceAsync(fn, 200, { leading: true });

      debounced();
      // Leading call has fired, but cooldown timer is active
      expect(debounced.pending).toBe(true);
    });

    test('is false after leading cooldown expires', () => {
      const fn = vi.fn(async () => {});
      const debounced = debounceAsync(fn, 200, { leading: true });

      debounced();
      vi.advanceTimersByTime(200);
      expect(debounced.pending).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    test('works with zero delay (trailing fires on next tick)', () => {
      const fn = vi.fn(async () => {});
      const debounced = debounceAsync(fn, 0);

      debounced();
      expect(fn).not.toHaveBeenCalled();

      vi.advanceTimersByTime(0);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test('works with zero delay in leading mode', () => {
      const fn = vi.fn(async () => {});
      const debounced = debounceAsync(fn, 0, { leading: true });

      debounced();
      expect(fn).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(0);

      debounced();
      expect(fn).toHaveBeenCalledTimes(2);
    });

    test('handles function that returns a rejected promise', () => {
      const fn = vi.fn(async () => {
        throw new Error('boom');
      });
      const debounced = debounceAsync(fn, 100);

      debounced();

      // Should not throw synchronously
      expect(() => vi.advanceTimersByTime(100)).not.toThrow();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test('handles function with no arguments', () => {
      const fn = vi.fn(async () => 'result');
      const debounced = debounceAsync(fn, 50);

      debounced();
      vi.advanceTimersByTime(50);

      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith();
    });

    test('many rapid calls in quick succession only fire once', () => {
      const fn = vi.fn(async (n: number) => {});
      const debounced = debounceAsync(fn, 100);

      for (let i = 0; i < 100; i++) {
        debounced(i);
      }

      vi.advanceTimersByTime(100);

      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith(99); // last call wins
    });

    test('many rapid calls in leading mode only fire once', () => {
      const fn = vi.fn(async (n: number) => {});
      const debounced = debounceAsync(fn, 100, { leading: true });

      for (let i = 0; i < 100; i++) {
        debounced(i);
      }

      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith(0); // first call wins
    });

    test('independent debounced instances do not interfere', () => {
      const fnA = vi.fn(async () => {});
      const fnB = vi.fn(async () => {});
      const debouncedA = debounceAsync(fnA, 200);
      const debouncedB = debounceAsync(fnB, 200);

      debouncedA();
      debouncedB();

      debouncedA.cancel();
      vi.advanceTimersByTime(200);

      expect(fnA).not.toHaveBeenCalled();
      expect(fnB).toHaveBeenCalledTimes(1);
    });
  });
});
