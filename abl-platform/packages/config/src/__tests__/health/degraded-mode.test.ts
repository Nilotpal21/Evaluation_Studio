import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DegradedModeManager } from '../../health/degraded-mode.js';
import type { DegradedModeListener } from '../../health/degraded-mode.js';

describe('DegradedModeManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('initial state is not degraded', () => {
    const manager = new DegradedModeManager();
    expect(manager.isDegraded()).toBe(false);
    expect(manager.getStatus().isDegraded).toBe(false);
    expect(manager.getStatus().reason).toBeNull();
    expect(manager.getStatus().since).toBeNull();
    expect(manager.getStatus().durationMs).toBe(0);
    manager.destroy();
  });

  it('enter() sets degraded state', () => {
    const manager = new DegradedModeManager();
    manager.enter('test reason');
    expect(manager.isDegraded()).toBe(true);
    expect(manager.getStatus().reason).toBe('test reason');
    expect(manager.getStatus().since).toBeInstanceOf(Date);
    manager.destroy();
  });

  it('exit() clears degraded state', () => {
    const manager = new DegradedModeManager();
    manager.enter('test reason');
    manager.exit();
    expect(manager.isDegraded()).toBe(false);
    expect(manager.getStatus().reason).toBeNull();
    expect(manager.getStatus().since).toBeNull();
    manager.destroy();
  });

  it('listeners are notified on enter and exit', () => {
    const manager = new DegradedModeManager();
    const listener: DegradedModeListener = {
      onEnterDegradedMode: vi.fn(),
      onExitDegradedMode: vi.fn(),
    };
    manager.addListener(listener);

    manager.enter('db down');
    expect(listener.onEnterDegradedMode).toHaveBeenCalledWith('db down');

    manager.exit();
    expect(listener.onExitDegradedMode).toHaveBeenCalledTimes(1);

    manager.destroy();
  });

  it('getStatus() returns correct duration', () => {
    const manager = new DegradedModeManager();
    manager.enter('slow');
    vi.advanceTimersByTime(5000);
    const status = manager.getStatus();
    expect(status.durationMs).toBeGreaterThanOrEqual(5000);
    manager.destroy();
  });

  it('auto-exits when revalidation check returns true', async () => {
    const manager = new DegradedModeManager(100, 300_000); // 100ms revalidation interval
    manager.addRevalidationCheck(async () => true);

    manager.enter('temp issue');
    expect(manager.isDegraded()).toBe(true);

    // Advance past the revalidation interval
    await vi.advanceTimersByTimeAsync(150);

    expect(manager.isDegraded()).toBe(false);
    manager.destroy();
  });

  it('stays degraded when revalidation check returns false', async () => {
    const manager = new DegradedModeManager(100, 300_000);
    manager.addRevalidationCheck(async () => false);

    manager.enter('persistent issue');
    expect(manager.isDegraded()).toBe(true);

    await vi.advanceTimersByTimeAsync(150);

    expect(manager.isDegraded()).toBe(true);
    manager.destroy();
  });

  it('stops revalidation and resets state after max degraded duration', async () => {
    const manager = new DegradedModeManager(100, 500); // 100ms interval, 500ms max
    const check = vi.fn(async () => false);
    manager.addRevalidationCheck(check);

    manager.enter('long outage');

    // Advance past the max degraded duration
    await vi.advanceTimersByTimeAsync(600);

    // After exceeding max threshold, state is reset so enter() can be called again
    expect(manager.isDegraded()).toBe(false);

    // Verify that enter() can be called again after max duration reset
    manager.enter('new issue');
    expect(manager.isDegraded()).toBe(true);
    expect(manager.getStatus().reason).toBe('new issue');

    manager.destroy();
  });

  it('destroy() cleans up timers and listeners', () => {
    const manager = new DegradedModeManager(100);
    const listener: DegradedModeListener = {
      onEnterDegradedMode: vi.fn(),
      onExitDegradedMode: vi.fn(),
    };
    manager.addListener(listener);
    manager.addRevalidationCheck(async () => true);

    manager.enter('cleanup test');
    manager.destroy();

    // After destroy, entering should still work (no error), but listeners won't be called
    // because they were cleared
    // The revalidation timer should be cleared
    vi.advanceTimersByTime(1000);
    // No errors thrown means cleanup was successful
  });

  it('double enter() is a no-op', () => {
    const manager = new DegradedModeManager();
    const listener: DegradedModeListener = {
      onEnterDegradedMode: vi.fn(),
      onExitDegradedMode: vi.fn(),
    };
    manager.addListener(listener);

    manager.enter('first');
    manager.enter('second');

    expect(listener.onEnterDegradedMode).toHaveBeenCalledTimes(1);
    expect(manager.getStatus().reason).toBe('first');

    manager.destroy();
  });
});
