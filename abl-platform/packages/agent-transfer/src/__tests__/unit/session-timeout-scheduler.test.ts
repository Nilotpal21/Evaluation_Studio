/**
 * Tests for SessionTimeoutScheduler.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SessionTimeoutScheduler,
  type TimeoutQueueHandle,
} from '../../events/session-timeout-scheduler.js';

// Mock createLogger
vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function createMockTimeoutQueue(): TimeoutQueueHandle & {
  add: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    add: vi.fn().mockResolvedValue({ id: 'job-1' }),
    remove: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('SessionTimeoutScheduler', () => {
  let queue: ReturnType<typeof createMockTimeoutQueue>;
  let scheduler: SessionTimeoutScheduler;

  beforeEach(() => {
    queue = createMockTimeoutQueue();
    scheduler = new SessionTimeoutScheduler(queue);
  });

  describe('scheduleTimeout', () => {
    it('adds a delayed job to the queue', async () => {
      const jobId = await scheduler.scheduleTimeout('session:key', 30_000);

      expect(jobId).toBe('job-1');
      expect(queue.add).toHaveBeenCalledOnce();
      expect(queue.add).toHaveBeenCalledWith(
        'session_timeout',
        expect.objectContaining({ sessionKey: 'session:key' }),
        expect.objectContaining({
          delay: 30_000,
          removeOnComplete: true,
          jobId: 'timeout:session:key',
        }),
      );
    });

    it('cancels previous timeout before scheduling new one', async () => {
      await scheduler.scheduleTimeout('session:key', 30_000);
      queue.add.mockResolvedValue({ id: 'job-2' });
      await scheduler.scheduleTimeout('session:key', 60_000);

      // First job should have been removed
      expect(queue.remove).toHaveBeenCalledWith('job-1');
      expect(queue.add).toHaveBeenCalledTimes(2);
    });

    it('tracks pending count', async () => {
      expect(scheduler.pendingCount).toBe(0);
      await scheduler.scheduleTimeout('key-1', 1000);
      expect(scheduler.pendingCount).toBe(1);
      queue.add.mockResolvedValue({ id: 'job-2' });
      await scheduler.scheduleTimeout('key-2', 2000);
      expect(scheduler.pendingCount).toBe(2);
    });
  });

  describe('cancelTimeout', () => {
    it('removes the job from the queue', async () => {
      await scheduler.scheduleTimeout('session:key', 30_000);
      await scheduler.cancelTimeout('session:key');

      expect(queue.remove).toHaveBeenCalledWith('job-1');
      expect(scheduler.pendingCount).toBe(0);
    });

    it('does nothing if no timeout is scheduled for that key', async () => {
      await scheduler.cancelTimeout('nonexistent');
      expect(queue.remove).not.toHaveBeenCalled();
    });

    it('handles remove failure gracefully', async () => {
      await scheduler.scheduleTimeout('session:key', 30_000);
      queue.remove.mockRejectedValueOnce(new Error('Job not found'));

      // Should not throw
      await scheduler.cancelTimeout('session:key');
      expect(scheduler.pendingCount).toBe(0);
    });
  });

  describe('processTimeout', () => {
    it('invokes the registered handler', async () => {
      const handler = vi.fn();
      scheduler.onTimeout(handler);

      await scheduler.scheduleTimeout('session:key', 1000);
      await scheduler.processTimeout({ sessionKey: 'session:key', scheduledAt: Date.now() });

      expect(handler).toHaveBeenCalledWith('session:key');
      expect(scheduler.pendingCount).toBe(0);
    });

    it('does not throw if no handler is registered', async () => {
      await scheduler.processTimeout({ sessionKey: 'session:key', scheduledAt: Date.now() });
      // should complete without error
    });
  });

  describe('close', () => {
    it('closes the queue and clears active jobs', async () => {
      await scheduler.scheduleTimeout('key-1', 1000);
      await scheduler.close();

      expect(queue.close).toHaveBeenCalledOnce();
      expect(scheduler.pendingCount).toBe(0);
    });
  });
});
