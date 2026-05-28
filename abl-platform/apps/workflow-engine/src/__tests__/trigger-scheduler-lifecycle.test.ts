/**
 * TriggerScheduler — supplementary lifecycle coverage
 *
 * The sibling `trigger-scheduler-timezone.test.ts` already covers scheduleCron,
 * scheduleOnce, basic processJob, unschedule, and shutdown. This file fills
 * the remaining gaps:
 *   - schedulePolling (no test existed)
 *   - processJob version-cascade integration (pinned + deployment tiers)
 *   - processJob callbackUrl propagation from trigger.config
 *   - Worker `failed` event listener is registered at construction
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQueueAdd = vi.fn().mockResolvedValue({ id: 'job-1' });
const mockQueueClose = vi.fn().mockResolvedValue(undefined);
const mockQueueGetRepeatableJobs = vi.fn().mockResolvedValue([]);
const mockQueueRemoveRepeatableByKey = vi.fn().mockResolvedValue(undefined);
// `Queue.remove(jobId)` — used by `unschedule` to clean up one-shot delayed
// jobs (finding ABLP-2 #6). Default `0` return mirrors BullMQ's "no match".
const mockQueueRemove = vi.fn().mockResolvedValue(0);

const mockWorkerClose = vi.fn().mockResolvedValue(undefined);
let workerProcessor: ((job: unknown) => Promise<void>) | null = null;
const mockWorkerOn = vi.fn();

// bullmq is a third-party infrastructure package — mocking is allowed per
// the project rules for genuinely external dependencies.
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
    return { close: mockWorkerClose, on: mockWorkerOn };
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
    duplicate: vi.fn().mockReturnValue({ disconnect: vi.fn() }),
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

describe('TriggerScheduler — schedulePolling', () => {
  let scheduler: TriggerScheduler;

  beforeEach(() => {
    vi.clearAllMocks();
    workerProcessor = null;
    scheduler = new TriggerScheduler(makeMockRedis(), makeDeps());
  });

  it('creates a repeatable job with `every: intervalMs` and the registration as jobId', async () => {
    const data = makeJobData({ type: 'polling' });
    await scheduler.schedulePolling('reg-poll-1', data, 30_000);

    expect(mockQueueAdd).toHaveBeenCalledWith('poll:reg-poll-1', data, {
      repeat: { every: 30_000 },
      jobId: 'reg-poll-1',
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
    });
  });

  it('supports sub-second polling intervals without special-casing', async () => {
    // Polling triggers in tests sometimes use very short intervals — the
    // scheduler should just forward the number to BullMQ, which handles the
    // minimum enforcement.
    await scheduler.schedulePolling('reg-poll-2', makeJobData({ type: 'polling' }), 500);

    const [, , options] = mockQueueAdd.mock.calls[0];
    expect(options.repeat).toEqual({ every: 500 });
  });
});

describe('TriggerScheduler — processJob version cascade integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workerProcessor = null;
  });

  it('uses the pinned workflowVersionId from job data (Tier 1) when provided', async () => {
    const versionDoc = {
      _id: 'ver-pinned',
      workflowId: 'wf-1',
      tenantId: 't1',
      projectId: 'p1',
      version: '2.0.0',
      definition: { nodes: [], edges: [] },
    };

    const workflowVersionModel = {
      findOne: vi.fn().mockReturnValue({ lean: async () => versionDoc }),
      find: vi.fn().mockReturnValue({ lean: async () => [] }),
    };

    const deps = makeDeps({ workflowVersionModel });
    const scheduler = new TriggerScheduler(makeMockRedis(), deps);
    expect(scheduler).toBeDefined();

    const data = makeJobData({ workflowVersionId: 'ver-pinned' });
    await workerProcessor!({ id: 'job-1', data });

    expect(workflowVersionModel.findOne).toHaveBeenCalledWith({
      _id: 'ver-pinned',
      workflowId: 'wf-1',
      tenantId: 't1',
      projectId: 'p1',
      deleted: { $ne: true },
    });
    expect(deps.restateClient.startWorkflow).toHaveBeenCalledTimes(1);
    const [executionId, payload] = (deps.restateClient.startWorkflow as ReturnType<typeof vi.fn>)
      .mock.calls[0];
    expect(typeof executionId).toBe('string');
    expect(payload.workflowVersion).toBe('2.0.0');
    expect(payload.workflowVersionId).toBe('ver-pinned');
  });

  it('forwards callbackUrl from trigger.config into the Restate triggerMetadata', async () => {
    // Cron triggers with configured callbackUrl must propagate it so the
    // completion callback fires. Missing this wiring silently breaks the
    // async-webhook-like round-trip.
    const trigger = {
      _id: 'reg-1',
      tenantId: 't1',
      status: 'active',
      config: {
        cronExpression: '0 * * * *',
        callbackUrl: 'https://example.com/hooks/done',
      },
    };

    const deps = makeDeps({
      triggerModel: {
        findOne: vi.fn().mockResolvedValue(trigger),
        findOneAndUpdate: vi.fn().mockResolvedValue(null),
      },
    });
    new TriggerScheduler(makeMockRedis(), deps);

    await workerProcessor!({ id: 'job-2', data: makeJobData() });

    expect(deps.restateClient.startWorkflow).toHaveBeenCalledTimes(1);
    const [, payload] = (deps.restateClient.startWorkflow as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(payload.triggerMetadata).toEqual(
      expect.objectContaining({
        callbackUrl: 'https://example.com/hooks/done',
        registrationId: 'reg-1',
      }),
    );
  });

  it('passes the trigger config through as the triggerPayload (plus scheduledAt marker)', async () => {
    const trigger = {
      _id: 'reg-1',
      tenantId: 't1',
      status: 'active',
      config: {
        cronExpression: '*/5 * * * *',
        customField: 'widget',
      },
    };

    const deps = makeDeps({
      triggerModel: {
        findOne: vi.fn().mockResolvedValue(trigger),
        findOneAndUpdate: vi.fn().mockResolvedValue(null),
      },
    });
    new TriggerScheduler(makeMockRedis(), deps);

    await workerProcessor!({ id: 'job-3', data: makeJobData() });

    const [, payload] = (deps.restateClient.startWorkflow as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(payload.triggerType).toBe('cron');
    expect(payload.triggerPayload.customField).toBe('widget');
    expect(payload.triggerPayload.cronExpression).toBe('*/5 * * * *');
    expect(typeof payload.triggerPayload.scheduledAt).toBe('string');
    expect(Date.parse(payload.triggerPayload.scheduledAt)).not.toBeNaN();
  });
});

describe('TriggerScheduler — worker error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workerProcessor = null;
  });

  it('registers a `failed` listener on the worker at construction', () => {
    new TriggerScheduler(makeMockRedis(), makeDeps());

    // The scheduler logs a warning when a job fails — the listener must be
    // wired up front or BullMQ failures become silent.
    expect(mockWorkerOn).toHaveBeenCalledWith('failed', expect.any(Function));
  });

  it('propagates restateClient.startWorkflow errors back through the worker (so BullMQ retries)', async () => {
    const deps = makeDeps({
      restateClient: {
        startWorkflow: vi.fn().mockRejectedValue(new Error('restate down')),
      },
    });
    new TriggerScheduler(makeMockRedis(), deps);

    // The processor must not swallow the error — BullMQ relies on the
    // promise rejection to mark the job failed and honor the retry policy.
    await expect(workerProcessor!({ id: 'job-fail', data: makeJobData() })).rejects.toThrow(
      /restate down/,
    );
  });
});
