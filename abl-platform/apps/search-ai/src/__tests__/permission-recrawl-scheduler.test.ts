/**
 * Permission Recrawl Scheduler Tests
 *
 * Tests the cron scheduler that triggers weekly permission recrawls.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Queue } from 'bullmq';

// =============================================================================
// Mocks
// =============================================================================

const mockQueue = {
  add: vi.fn(),
  close: vi.fn(),
  process: vi.fn(),
  getRepeatableJobs: vi.fn(),
  removeRepeatableByKey: vi.fn(),
};

const mockRedisHandle = {
  duplicate: vi.fn(() => ({})),
};

class MockWorker {
  queueName: string;
  opts: any;
  on = vi.fn();
  close = vi.fn();

  constructor(queueName: string, processor: any, opts?: any) {
    this.queueName = queueName;
    this.opts = { processor, ...opts };
  }
}

class MockQueueEvents {
  on = vi.fn();
  close = vi.fn();
}

vi.mock('bullmq', () => {
  // Queue must be a constructable class (not a plain function)
  const MockQueue = function (this: any, _name: string, _opts?: any) {
    Object.assign(this, mockQueue);
  } as any;
  MockQueue.prototype = mockQueue;

  return {
    Queue: MockQueue,
    Worker: MockWorker,
    QueueEvents: MockQueueEvents,
  };
});

// =============================================================================
// Tests
// =============================================================================

describe('Permission Recrawl Scheduler', () => {
  let scheduler: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockQueue.getRepeatableJobs.mockResolvedValue([]);
    mockQueue.add.mockResolvedValue({ id: 'schedule-job-123' });
    mockRedisHandle.duplicate.mockReturnValue({});

    // Import scheduler after mocks are setup
    scheduler = await import('../scheduler/permission-recrawl-scheduler.js');
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  // ─── Setup ─────────────────────────────────────────────────────────────

  test('setupPermissionRecrawlScheduler creates recurring job', { timeout: 30_000 }, async () => {
    await scheduler.setupPermissionRecrawlScheduler({
      handle: mockRedisHandle as any,
      enabled: true,
    });

    // Should remove existing schedules first
    expect(mockQueue.getRepeatableJobs).toHaveBeenCalled();

    // Should add new recurring schedule
    expect(mockQueue.add).toHaveBeenCalledWith(
      'weekly-permission-recrawl',
      {},
      expect.objectContaining({
        repeat: {
          pattern: '0 2 * * 0', // Default: Sunday 2 AM
        },
        jobId: 'weekly-permission-recrawl',
      }),
    );

    // Processor is registered via Worker constructor (not queue.process)
  });

  test(
    'setupPermissionRecrawlScheduler respects custom cron schedule',
    { timeout: 30_000 },
    async () => {
      await scheduler.setupPermissionRecrawlScheduler({
        handle: mockRedisHandle as any,
        enabled: true,
        cronSchedule: '0 3 * * 1', // Monday 3 AM
      });

      expect(mockQueue.add).toHaveBeenCalledWith(
        'weekly-permission-recrawl',
        {},
        expect.objectContaining({
          repeat: {
            pattern: '0 3 * * 1',
          },
        }),
      );
    },
  );

  test('setupPermissionRecrawlScheduler skips when disabled', async () => {
    const result = await scheduler.setupPermissionRecrawlScheduler({
      handle: mockRedisHandle as any,
      enabled: false,
    });

    expect(result).toBeNull();
    expect(mockQueue.add).not.toHaveBeenCalled();
  });

  test('setupPermissionRecrawlScheduler removes existing schedule before adding new one', async () => {
    mockQueue.getRepeatableJobs.mockResolvedValue([
      {
        name: 'weekly-permission-recrawl',
        key: 'old-schedule-key',
        pattern: '0 1 * * 0',
      },
    ]);

    await scheduler.setupPermissionRecrawlScheduler({
      handle: mockRedisHandle as any,
      enabled: true,
    });

    expect(mockQueue.removeRepeatableByKey).toHaveBeenCalledWith('old-schedule-key');
    expect(mockQueue.add).toHaveBeenCalled();
  });

  // ─── Status ────────────────────────────────────────────────────────────

  test('getSchedulerStatus returns schedule info when enabled', async () => {
    const nextRunTime = Date.now() + 86400000; // Tomorrow
    mockQueue.getRepeatableJobs.mockResolvedValue([
      {
        name: 'weekly-permission-recrawl',
        key: 'schedule-key',
        pattern: '0 2 * * 0',
        next: nextRunTime,
      },
    ]);

    const status = await scheduler.getSchedulerStatus(mockQueue);

    expect(status.enabled).toBe(true);
    expect(status.schedule).toBe('0 2 * * 0');
    expect(status.nextRun).toEqual(new Date(nextRunTime));
  });

  test('getSchedulerStatus returns disabled when no schedule exists', async () => {
    mockQueue.getRepeatableJobs.mockResolvedValue([]);

    const status = await scheduler.getSchedulerStatus(mockQueue);

    expect(status.enabled).toBe(false);
    expect(status.schedule).toBeNull();
    expect(status.nextRun).toBeNull();
  });

  test('getSchedulerStatus ignores other repeatable jobs', async () => {
    mockQueue.getRepeatableJobs.mockResolvedValue([
      {
        name: 'other-job',
        key: 'other-key',
        pattern: '0 3 * * 1',
        next: Date.now(),
      },
    ]);

    const status = await scheduler.getSchedulerStatus(mockQueue);

    expect(status.enabled).toBe(false);
  });

  // ─── Pause/Resume ──────────────────────────────────────────────────────

  test('pauseScheduler removes repeatable job', async () => {
    mockQueue.getRepeatableJobs.mockResolvedValue([
      {
        name: 'weekly-permission-recrawl',
        key: 'schedule-key',
      },
    ]);

    await scheduler.pauseScheduler(mockQueue);

    expect(mockQueue.removeRepeatableByKey).toHaveBeenCalledWith('schedule-key');
  });

  test('pauseScheduler does nothing when no schedule exists', async () => {
    mockQueue.getRepeatableJobs.mockResolvedValue([]);

    await scheduler.pauseScheduler(mockQueue);

    expect(mockQueue.removeRepeatableByKey).not.toHaveBeenCalled();
  });

  test('resumeScheduler adds new schedule', async () => {
    mockQueue.getRepeatableJobs.mockResolvedValue([]);

    await scheduler.resumeScheduler(mockQueue, '0 4 * * 2');

    expect(mockQueue.add).toHaveBeenCalledWith(
      'weekly-permission-recrawl',
      {},
      expect.objectContaining({
        repeat: {
          pattern: '0 4 * * 2',
        },
      }),
    );
  });

  test('resumeScheduler uses default cron if not provided', async () => {
    mockQueue.getRepeatableJobs.mockResolvedValue([]);

    await scheduler.resumeScheduler(mockQueue);

    expect(mockQueue.add).toHaveBeenCalledWith(
      'weekly-permission-recrawl',
      {},
      expect.objectContaining({
        repeat: {
          pattern: '0 2 * * 0', // Default
        },
      }),
    );
  });

  test('resumeScheduler removes existing schedule first', async () => {
    mockQueue.getRepeatableJobs.mockResolvedValue([
      {
        name: 'weekly-permission-recrawl',
        key: 'old-key',
      },
    ]);

    await scheduler.resumeScheduler(mockQueue, '0 5 * * 3');

    expect(mockQueue.removeRepeatableByKey).toHaveBeenCalledWith('old-key');
    expect(mockQueue.add).toHaveBeenCalled();
  });
});
