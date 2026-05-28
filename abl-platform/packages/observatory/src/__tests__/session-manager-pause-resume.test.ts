import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionManager } from '../protocol/session-manager.js';

const SESSION_ID = 'session-1';
const AUTO_RESUME_TIMEOUT_MS = 5 * 60 * 1000;

function createSessionManager(): SessionManager {
  const manager = new SessionManager();
  manager.registerSession(SESSION_ID, 'Debug session', 'root-agent');
  return manager;
}

async function expectPending(promise: Promise<void>): Promise<void> {
  const settled = vi.fn();
  void promise.then(settled);
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
}

describe('SessionManager pause and resume flow', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resumes a paused session and releases the pause waiter', async () => {
    const manager = createSessionManager();
    const events: string[] = [];
    manager.onEvent((_, event) => events.push(event));

    const pausePromise = manager.pause(SESSION_ID);

    expect(manager.shouldWait(SESSION_ID)).toBe(true);
    expect(manager.getSession(SESSION_ID)?.state).toBe('paused');
    await expectPending(pausePromise);

    manager.resume(SESSION_ID);

    await expect(pausePromise).resolves.toBeUndefined();
    expect(manager.shouldWait(SESSION_ID)).toBe(false);
    expect(manager.getSession(SESSION_ID)?.state).toBe('running');
    expect(events).toEqual(['paused', 'resumed']);
  });

  it('reuses the same pause gate for pauseExecution and waitIfPaused callers', async () => {
    const manager = createSessionManager();

    const pausePromise = manager.pause(SESSION_ID);
    const waitPromise = manager.waitIfPaused(SESSION_ID);

    await expectPending(pausePromise);
    await expectPending(waitPromise);

    manager.resume(SESSION_ID);

    await expect(Promise.all([pausePromise, waitPromise])).resolves.toEqual([undefined, undefined]);
    expect(manager.shouldWait(SESSION_ID)).toBe(false);
  });

  it('releases paused waiters when stepping and preserves step state', async () => {
    const manager = createSessionManager();

    const pausePromise = manager.pause(SESSION_ID);
    const waitPromise = manager.waitIfPaused(SESSION_ID);

    manager.step(SESSION_ID, 'into');

    await expect(Promise.all([pausePromise, waitPromise])).resolves.toEqual([undefined, undefined]);
    expect(manager.shouldWait(SESSION_ID)).toBe(false);
    expect(manager.isStepping(SESSION_ID)).toEqual({
      stepping: true,
      type: 'into',
    });
    expect(manager.markStepComplete(SESSION_ID)).toBe(true);
    expect(manager.isStepping(SESSION_ID)).toEqual({
      stepping: false,
      type: undefined,
    });
  });

  it('releases paused waiters when unregistering a paused session', async () => {
    const manager = createSessionManager();

    const pausePromise = manager.pause(SESSION_ID);
    const waitPromise = manager.waitIfPaused(SESSION_ID);

    await expectPending(pausePromise);
    await expectPending(waitPromise);

    manager.unregisterSession(SESSION_ID);

    await expect(Promise.all([pausePromise, waitPromise])).resolves.toEqual([undefined, undefined]);
    expect(manager.getSession(SESSION_ID)).toBeUndefined();
    expect(manager.shouldWait(SESSION_ID)).toBe(false);
  });

  it('auto-resumes after the pause timeout', async () => {
    vi.useFakeTimers();

    const manager = createSessionManager();
    const events: string[] = [];
    manager.onEvent((_, event) => events.push(event));

    const pausePromise = manager.pause(SESSION_ID);

    await expectPending(pausePromise);

    await vi.advanceTimersByTimeAsync(AUTO_RESUME_TIMEOUT_MS - 1);
    await expectPending(pausePromise);
    expect(manager.shouldWait(SESSION_ID)).toBe(true);

    await vi.advanceTimersByTimeAsync(1);

    await expect(pausePromise).resolves.toBeUndefined();
    expect(manager.shouldWait(SESSION_ID)).toBe(false);
    expect(manager.getSession(SESSION_ID)?.state).toBe('running');
    expect(events).toEqual(['paused', 'resumed']);
  });
});
