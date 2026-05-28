import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock bullmq before importing TriggerScheduler
const mockQueueAdd = vi.fn().mockResolvedValue({ id: 'job-1' });
const mockQueueClose = vi.fn().mockResolvedValue(undefined);
const mockQueueGetRepeatableJobs = vi.fn().mockResolvedValue([]);
const mockQueueRemoveRepeatableByKey = vi.fn().mockResolvedValue(undefined);
// `Queue.remove(jobId)` — covers one-shot / delayed job cleanup for the
// `scheduleOnce` path (finding ABLP-2 #6). Default return is `0` (no job
// matched) which matches BullMQ's behavior for triggers that were only
// repeatable.
const mockQueueRemove = vi.fn().mockResolvedValue(0);

const mockWorkerClose = vi.fn().mockResolvedValue(undefined);
let workerProcessor: ((job: unknown) => Promise<void>) | null = null;
const mockWorkerOn = vi.fn();

vi.mock('bullmq', () => {
  function MockQueue() {
    return {
      add: mockQueueAdd,
      close: mockQueueClose,
      getRepeatableJobs: mockQueueGetRepeatableJobs,
      removeRepeatableByKey: mockQueueRemoveRepeatableByKey,
      remove: mockQueueRemove,
    };
  }
  function MockWorker(_name: string, processor: (job: unknown) => Promise<void>) {
    workerProcessor = processor;
    return {
      close: mockWorkerClose,
      on: mockWorkerOn,
    };
  }
  return { Queue: MockQueue, Worker: MockWorker };
});

import {
  TriggerScheduler,
  type TriggerSchedulerDeps,
  type TriggerJobData,
} from '../services/trigger-scheduler.js';

function makeMockRedis() {
  return {
    duplicate: vi.fn().mockReturnValue({
      disconnect: vi.fn(),
    }),
  } as unknown as import('ioredis').Redis;
}

function makeDeps(overrides: Partial<TriggerSchedulerDeps> = {}): TriggerSchedulerDeps {
  return {
    triggerModel: {
      findOne: vi.fn().mockResolvedValue({
        _id: 'reg-1',
        tenantId: 't1',
        status: 'active',
        config: { cronExpression: '0 9 * * *' },
      }),
      findOneAndUpdate: vi.fn().mockResolvedValue(null),
    },
    workflowModel: {
      findOne: vi.fn().mockResolvedValue({
        _id: 'wf-1',
        name: 'Test Workflow',
        steps: [{ id: 'step-1', type: 'http' }],
      }),
    },
    restateClient: {
      startWorkflow: vi.fn().mockResolvedValue(undefined),
    },
    createBullMQPairFn: (handle) => {
      const qc = handle.duplicate({ maxRetriesPerRequest: null });
      const wc = handle.duplicate({ maxRetriesPerRequest: null });
      return {
        queueConnection: qc,
        workerConnection: wc,
        disconnect: () => {
          qc.disconnect();
          wc.disconnect();
        },
      };
    },
    ...overrides,
  };
}

function makeJobData(overrides: Partial<TriggerJobData> = {}): TriggerJobData {
  return {
    registrationId: 'reg-1',
    tenantId: 't1',
    projectId: 'p1',
    workflowId: 'wf-1',
    type: 'cron',
    ...overrides,
  };
}

describe('TriggerScheduler — timezone support', () => {
  let scheduler: TriggerScheduler;
  let deps: TriggerSchedulerDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    workerProcessor = null;
    deps = makeDeps();
    scheduler = new TriggerScheduler(makeMockRedis(), deps);
  });

  describe('INT-3: Preset resolves to correct cron with timezone in BullMQ', () => {
    it('passes tz option to queue.add() when timezone is provided', async () => {
      const data = makeJobData();
      await scheduler.scheduleCron('reg-1', data, '0 9 * * *', 'America/New_York');

      expect(mockQueueAdd).toHaveBeenCalledWith('cron:reg-1', data, {
        repeat: {
          pattern: '0 9 * * *',
          tz: 'America/New_York',
        },
        jobId: 'reg-1',
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
      });
    });

    it('omits tz from repeat options when timezone is not provided', async () => {
      const data = makeJobData();
      await scheduler.scheduleCron('reg-1', data, '0 9 * * *');

      expect(mockQueueAdd).toHaveBeenCalledWith('cron:reg-1', data, {
        repeat: {
          pattern: '0 9 * * *',
        },
        jobId: 'reg-1',
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
      });
    });

    it('passes tz option for various timezones', async () => {
      const data = makeJobData();
      await scheduler.scheduleCron('reg-1', data, '30 14 * * 1-5', 'Europe/London');

      expect(mockQueueAdd).toHaveBeenCalledWith(
        'cron:reg-1',
        data,
        expect.objectContaining({
          repeat: expect.objectContaining({
            pattern: '30 14 * * 1-5',
            tz: 'Europe/London',
          }),
        }),
      );
    });
  });

  describe('INT-5: One-shot fires once and auto-pauses', () => {
    it('scheduleOnce creates a delayed job in the queue', async () => {
      const data = makeJobData({ type: 'once' });
      await scheduler.scheduleOnce('reg-1', data, 60000);

      expect(mockQueueAdd).toHaveBeenCalledWith('once:reg-1', data, {
        delay: 60000,
        jobId: 'reg-1',
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
      });
    });

    it('processJob with type=once calls findOneAndUpdate to pause the trigger', async () => {
      const data = makeJobData({ type: 'once' });

      // Ensure worker processor was captured
      expect(workerProcessor).not.toBeNull();

      const mockJob = {
        id: 'job-1',
        data,
      };

      await workerProcessor!(mockJob);

      // Verify workflow was started
      expect(deps.restateClient.startWorkflow).toHaveBeenCalledWith(
        expect.any(String), // executionId
        expect.objectContaining({
          workflowId: 'wf-1',
          tenantId: 't1',
          projectId: 'p1',
          triggerType: 'cron',
        }),
      );

      // Verify the trigger was paused after firing
      expect(deps.triggerModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'reg-1', tenantId: 't1' },
        { $set: { status: 'paused' } },
      );
    });

    it('processJob with type=cron does NOT pause the trigger', async () => {
      const data = makeJobData({ type: 'cron' });

      expect(workerProcessor).not.toBeNull();

      const mockJob = {
        id: 'job-1',
        data,
      };

      await workerProcessor!(mockJob);

      // Verify workflow was started
      expect(deps.restateClient.startWorkflow).toHaveBeenCalled();

      // Verify the trigger was NOT paused
      expect(deps.triggerModel.findOneAndUpdate).not.toHaveBeenCalled();
    });
  });

  describe('INT-6: BullMQ tz option is passed correctly', () => {
    it('repeat options include tz for Asia/Tokyo', async () => {
      const data = makeJobData();
      await scheduler.scheduleCron('reg-1', data, '0 0 * * *', 'Asia/Tokyo');

      const callArgs = mockQueueAdd.mock.calls[0];
      expect(callArgs[2].repeat).toEqual({
        pattern: '0 0 * * *',
        tz: 'Asia/Tokyo',
      });
    });

    it('repeat options include tz for UTC', async () => {
      const data = makeJobData();
      await scheduler.scheduleCron('reg-1', data, '*/5 * * * *', 'UTC');

      const callArgs = mockQueueAdd.mock.calls[0];
      expect(callArgs[2].repeat).toEqual({
        pattern: '*/5 * * * *',
        tz: 'UTC',
      });
    });

    it('repeat options do not contain tz key when undefined', async () => {
      const data = makeJobData();
      await scheduler.scheduleCron('reg-1', data, '0 12 * * *', undefined);

      const callArgs = mockQueueAdd.mock.calls[0];
      expect(callArgs[2].repeat).toEqual({
        pattern: '0 12 * * *',
      });
      expect(callArgs[2].repeat).not.toHaveProperty('tz');
    });
  });

  describe('processJob — trigger lookup', () => {
    it('skips execution when trigger is no longer active', async () => {
      deps.triggerModel.findOne = vi.fn().mockResolvedValue(null);

      const mockJob = { id: 'job-1', data: makeJobData() };
      await workerProcessor!(mockJob);

      expect(deps.restateClient.startWorkflow).not.toHaveBeenCalled();
    });

    it('skips execution when workflow is not found', async () => {
      deps.workflowModel.findOne = vi.fn().mockResolvedValue(null);

      const mockJob = { id: 'job-1', data: makeJobData() };
      await workerProcessor!(mockJob);

      expect(deps.restateClient.startWorkflow).not.toHaveBeenCalled();
    });

    it('skips execution when job environment does not match trigger environment', async () => {
      // Covers the env-mismatch warn-and-skip branch (lines 197-202).
      deps.triggerModel.findOne = vi.fn().mockResolvedValue({
        _id: 'reg-1',
        tenantId: 't1',
        status: 'active',
        environment: 'production',
        config: {},
      });

      const mockJob = {
        id: 'job-1',
        data: makeJobData({ environment: 'staging' }),
      };
      await workerProcessor!(mockJob);

      expect(deps.restateClient.startWorkflow).not.toHaveBeenCalled();
    });
  });

  describe('unschedule()', () => {
    it('removes the repeatable job whose id matches the registrationId', async () => {
      mockQueueGetRepeatableJobs.mockResolvedValueOnce([
        { id: 'reg-1', key: 'repeat-key-1' },
        { id: 'reg-2', key: 'repeat-key-2' },
      ]);

      await scheduler.unschedule('reg-1');

      expect(mockQueueRemoveRepeatableByKey).toHaveBeenCalledWith('repeat-key-1');
      expect(mockQueueRemoveRepeatableByKey).not.toHaveBeenCalledWith('repeat-key-2');
    });

    it('is a no-op on repeatable removal when no repeatable job matches', async () => {
      mockQueueGetRepeatableJobs.mockResolvedValueOnce([{ id: 'other', key: 'k' }]);

      await scheduler.unschedule('reg-1');

      expect(mockQueueRemoveRepeatableByKey).not.toHaveBeenCalled();
    });

    // Finding ABLP-2 #6: `scheduleOnce` uses `delay` (not `repeat`), so the
    // resulting job is NOT returned by `getRepeatableJobs()`. Before the fix,
    // `unschedule` quietly left the delayed job in place and it would still
    // fire after the operator paused or deleted the trigger. `unschedule`
    // now also calls `queue.remove(registrationId)` which covers waiting /
    // delayed / active jobs — this pins that call site.
    it('removes the one-shot delayed job by registrationId (finding #6)', async () => {
      mockQueueGetRepeatableJobs.mockResolvedValueOnce([]);
      mockQueueRemove.mockResolvedValueOnce(1);

      await scheduler.unschedule('reg-once');

      expect(mockQueueRemoveRepeatableByKey).not.toHaveBeenCalled();
      expect(mockQueueRemove).toHaveBeenCalledWith('reg-once');
    });

    it('removes both the repeatable and any one-shot variant for the same registrationId', async () => {
      mockQueueGetRepeatableJobs.mockResolvedValueOnce([
        { id: 'reg-mixed', key: 'repeat-key-mixed' },
      ]);
      mockQueueRemove.mockResolvedValueOnce(1);

      await scheduler.unschedule('reg-mixed');

      expect(mockQueueRemoveRepeatableByKey).toHaveBeenCalledWith('repeat-key-mixed');
      expect(mockQueueRemove).toHaveBeenCalledWith('reg-mixed');
    });

    it('surfaces nothing when `queue.remove` errors — unschedule stays best-effort', async () => {
      mockQueueGetRepeatableJobs.mockResolvedValueOnce([]);
      mockQueueRemove.mockRejectedValueOnce(new Error('redis unavailable'));

      // Should not throw — the repeatable sweep already succeeded and we
      // log the remove failure rather than bubbling it up.
      await expect(scheduler.unschedule('reg-err')).resolves.toBeUndefined();
      expect(mockQueueRemove).toHaveBeenCalledWith('reg-err');
    });
  });

  describe('shutdown()', () => {
    it('closes the worker and queue and disconnects both Redis connections', async () => {
      // Build a scheduler with trackable disconnect spies (the shared redis stub
      // above returns a fresh object each .duplicate() call).
      const queueDisconnect = vi.fn();
      const workerDisconnect = vi.fn();
      const redis = {
        duplicate: vi
          .fn()
          .mockReturnValueOnce({ disconnect: queueDisconnect })
          .mockReturnValueOnce({ disconnect: workerDisconnect }),
      } as unknown as import('ioredis').Redis;

      const local = new TriggerScheduler(redis, makeDeps());
      await local.shutdown();

      expect(mockWorkerClose).toHaveBeenCalled();
      expect(mockQueueClose).toHaveBeenCalled();
      expect(queueDisconnect).toHaveBeenCalled();
      expect(workerDisconnect).toHaveBeenCalled();
    });
  });
});
