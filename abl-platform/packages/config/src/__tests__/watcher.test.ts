import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConfigWatcher } from '../watcher.js';

describe('ConfigWatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('start creates a timer and stop clears it', () => {
    const watcher = new ConfigWatcher({ intervalMs: 1000 });
    const hashFn = vi.fn(() => 'hash-a');

    watcher.start(hashFn);
    // Timer should be scheduled — advancing should trigger a poll
    expect(hashFn).toHaveBeenCalledTimes(1); // initial hash capture

    watcher.stop();
    // After stop, advancing time should not call hashFn again
    const callCount = hashFn.mock.calls.length;
    vi.advanceTimersByTime(5000);
    expect(hashFn).toHaveBeenCalledTimes(callCount);
  });

  it('calls onReload when hash changes', async () => {
    const onReload = vi.fn(async () => {});
    const watcher = new ConfigWatcher({ intervalMs: 1000, onReload });

    let hash = 'hash-a';
    const hashFn = vi.fn(() => hash);

    watcher.start(hashFn);

    // Change the hash before next poll
    hash = 'hash-b';
    await vi.advanceTimersByTimeAsync(1000);

    expect(onReload).toHaveBeenCalledTimes(1);

    watcher.stop();
  });

  it('skips poll when a reload is still in-flight (concurrency guard)', async () => {
    let resolveReload: () => void;
    const onReload = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveReload = resolve;
        }),
    );
    const watcher = new ConfigWatcher({ intervalMs: 1000, onReload });

    let hash = 'hash-a';
    const hashFn = vi.fn(() => hash);

    watcher.start(hashFn);

    // Trigger first reload
    hash = 'hash-b';
    // Start the poll but don't await the full resolution
    const pollPromise = vi.advanceTimersByTimeAsync(1000);

    // Change hash again — this poll should skip because isReloading is true
    hash = 'hash-c';
    await vi.advanceTimersByTimeAsync(1000);

    // onReload should only have been called once (the second poll was skipped)
    expect(onReload).toHaveBeenCalledTimes(1);

    // Resolve the first reload
    resolveReload!();
    await pollPromise;

    watcher.stop();
  });

  it('applies exponential backoff on reload failure', async () => {
    const onReload = vi.fn(async () => {
      throw new Error('reload failed');
    });
    const watcher = new ConfigWatcher({ intervalMs: 1000, maxBackoffMs: 8000, onReload });

    let callCount = 0;
    const hashFn = vi.fn(() => `hash-${++callCount}`);

    watcher.start(hashFn);

    // First poll: interval is 1000, fail -> backoff to 2000
    await vi.advanceTimersByTimeAsync(1000);
    expect(onReload).toHaveBeenCalledTimes(1);

    // Second poll: interval is 2000, fail -> backoff to 4000
    await vi.advanceTimersByTimeAsync(2000);
    expect(onReload).toHaveBeenCalledTimes(2);

    // Third poll: interval is 4000, fail -> backoff to 8000 (capped at max)
    await vi.advanceTimersByTimeAsync(4000);
    expect(onReload).toHaveBeenCalledTimes(3);

    // Fourth poll: interval is 8000 (max), fail -> stays at 8000
    await vi.advanceTimersByTimeAsync(8000);
    expect(onReload).toHaveBeenCalledTimes(4);

    watcher.stop();
  });

  it('resets interval to base after successful reload following backoff', async () => {
    let shouldFail = true;
    const onReload = vi.fn(async () => {
      if (shouldFail) throw new Error('fail');
    });
    const watcher = new ConfigWatcher({ intervalMs: 1000, maxBackoffMs: 16000, onReload });

    let callCount = 0;
    const hashFn = vi.fn(() => `hash-${++callCount}`);

    watcher.start(hashFn);

    // Fail first: backoff to 2000
    await vi.advanceTimersByTimeAsync(1000);
    expect(onReload).toHaveBeenCalledTimes(1);

    // Fail second: backoff to 4000
    await vi.advanceTimersByTimeAsync(2000);
    expect(onReload).toHaveBeenCalledTimes(2);

    // Now succeed
    shouldFail = false;
    await vi.advanceTimersByTimeAsync(4000);
    expect(onReload).toHaveBeenCalledTimes(3);

    // After success, interval should reset to base (1000)
    await vi.advanceTimersByTimeAsync(1000);
    expect(onReload).toHaveBeenCalledTimes(4);

    watcher.stop();
  });

  it('stops gracefully during an in-flight reload', async () => {
    let resolveReload!: () => void;
    let reloadStartedResolve!: () => void;
    const reloadStartedPromise = new Promise<void>((r) => (reloadStartedResolve = r));

    const onReload = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveReload = resolve;
          reloadStartedResolve();
        }),
    );
    const watcher = new ConfigWatcher({ intervalMs: 1000, onReload });

    let hash = 'hash-a';
    const hashFn = vi.fn(() => hash);

    watcher.start(hashFn);

    // Trigger reload by changing hash and advancing timer
    hash = 'hash-b';
    const pollPromise = vi.advanceTimersByTimeAsync(1000);

    // Wait for onReload to actually be invoked
    await reloadStartedPromise;

    // Now stop while reload is in-flight
    watcher.stop();

    // Resolve the reload — should not schedule another poll since stopped
    resolveReload();
    await pollPromise;

    // Advancing time should not trigger any more polls
    hash = 'hash-c';
    await vi.advanceTimersByTimeAsync(5000);
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});
