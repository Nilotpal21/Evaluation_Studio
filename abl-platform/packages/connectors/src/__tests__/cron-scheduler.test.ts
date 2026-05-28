import { describe, it, expect, vi } from 'vitest';
import {
  registerCronTrigger,
  deregisterCronTrigger,
  processCronJob,
  isValidCronExpression,
  type CronSchedulerDeps,
} from '../triggers/cron-scheduler.js';
import type { TriggerRegistration, TriggerJobData } from '../triggers/types.js';

function makeRegistration(overrides: Partial<TriggerRegistration> = {}): TriggerRegistration {
  return {
    _id: 'reg-1',
    tenantId: 't1',
    projectId: 'p1',
    workflowId: 'wf-1',
    connectorName: 'scheduler',
    triggerName: 'daily_sync',
    connectionId: 'conn-1',
    triggerType: 'cron',
    status: 'active',
    config: {},
    cronExpression: '0 9 * * *',
    consecutiveErrors: 0,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<CronSchedulerDeps> = {}): CronSchedulerDeps {
  return {
    registrationModel: {
      findOne: vi.fn().mockResolvedValue(makeRegistration()),
      findOneAndUpdate: vi.fn().mockResolvedValue(makeRegistration()),
    },
    restateClient: {
      startWorkflow: vi.fn().mockResolvedValue(undefined),
    },
    queue: {
      add: vi.fn().mockResolvedValue(undefined),
      removeRepeatable: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  };
}

const jobData: TriggerJobData = {
  registrationId: 'reg-1',
  tenantId: 't1',
  projectId: 'p1',
  connectorName: 'scheduler',
  triggerName: 'daily_sync',
  connectionId: 'conn-1',
};

describe('isValidCronExpression', () => {
  it('accepts standard 5-field cron', () => {
    expect(isValidCronExpression('0 9 * * *')).toBe(true);
    expect(isValidCronExpression('*/5 * * * *')).toBe(true);
  });

  it('accepts 6-field cron (with seconds)', () => {
    expect(isValidCronExpression('0 0 9 * * *')).toBe(true);
  });

  it('rejects invalid cron', () => {
    expect(isValidCronExpression('foo')).toBe(false);
    expect(isValidCronExpression('1 2 3')).toBe(false);
    expect(isValidCronExpression('')).toBe(false);
  });
});

describe('registerCronTrigger', () => {
  it('creates a BullMQ repeatable job with cron expression', async () => {
    const deps = makeDeps();

    await registerCronTrigger(
      {
        _id: 'reg-1',
        tenantId: 't1',
        projectId: 'p1',
        workflowId: 'wf-1',
        connectorName: 'scheduler',
        triggerName: 'daily_sync',
        connectionId: 'conn-1',
        cronExpression: '0 9 * * *',
      },
      deps,
    );

    expect(deps.queue.add).toHaveBeenCalledWith(
      'cron-trigger',
      expect.objectContaining({ registrationId: 'reg-1' }),
      expect.objectContaining({
        repeat: { cron: '0 9 * * *' },
        jobId: 'cron:reg-1',
      }),
    );
  });

  it('throws on invalid cron expression', async () => {
    const deps = makeDeps();

    await expect(
      registerCronTrigger(
        {
          _id: 'reg-1',
          tenantId: 't1',
          projectId: 'p1',
          workflowId: 'wf-1',
          connectorName: 'scheduler',
          triggerName: 'daily_sync',
          connectionId: 'conn-1',
          cronExpression: 'invalid',
        },
        deps,
      ),
    ).rejects.toThrow('Invalid cron expression');
  });
});

describe('deregisterCronTrigger', () => {
  it('removes the repeatable job', async () => {
    const deps = makeDeps();

    await deregisterCronTrigger('reg-1', '0 9 * * *', { queue: deps.queue });

    expect(deps.queue.removeRepeatable).toHaveBeenCalledWith('cron-trigger', {
      cron: '0 9 * * *',
      jobId: 'cron:reg-1',
    });
  });
});

describe('processCronJob', () => {
  it('skips when registration not found', async () => {
    const deps = makeDeps({
      registrationModel: {
        findOne: vi.fn().mockResolvedValue(null),
        findOneAndUpdate: vi.fn().mockResolvedValue(null),
      },
    });

    await processCronJob(jobData, deps);

    expect(deps.restateClient.startWorkflow).not.toHaveBeenCalled();
  });

  it('invokes Restate workflow with cron payload', async () => {
    const deps = makeDeps();

    await processCronJob(jobData, deps);

    expect(deps.restateClient.startWorkflow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        workflowId: 'wf-1',
        tenantId: 't1',
        projectId: 'p1',
        triggerType: 'cron',
        triggerPayload: expect.objectContaining({
          firedAt: expect.any(String),
          cronExpression: '0 9 * * *',
        }),
      }),
    );
  });

  it('resets error counter on success', async () => {
    const deps = makeDeps();

    await processCronJob(jobData, deps);

    expect(deps.registrationModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'reg-1', tenantId: 't1' },
      expect.objectContaining({
        $set: expect.objectContaining({ consecutiveErrors: 0 }),
      }),
    );
  });

  it('tracks consecutive errors on failure', async () => {
    const deps = makeDeps({
      restateClient: {
        startWorkflow: vi.fn().mockRejectedValue(new Error('Restate down')),
      },
    });

    await processCronJob(jobData, deps);

    expect(deps.registrationModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'reg-1', tenantId: 't1' },
      expect.objectContaining({
        $inc: { consecutiveErrors: 1 },
      }),
      { new: true },
    );
  });

  it('passes workflowVersionId to startWorkflow when present on registration', async () => {
    const deps = makeDeps({
      registrationModel: {
        findOne: vi.fn().mockResolvedValue(makeRegistration({ workflowVersionId: 'ver-1' })),
        findOneAndUpdate: vi.fn().mockResolvedValue(makeRegistration()),
      },
    });

    await processCronJob(jobData, deps);

    expect(deps.restateClient.startWorkflow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        workflowId: 'wf-1',
        workflowVersionId: 'ver-1',
      }),
    );
  });

  it('omits workflowVersionId from startWorkflow when absent on registration', async () => {
    const deps = makeDeps();

    await processCronJob(jobData, deps);

    const call = (deps.restateClient.startWorkflow as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1]).not.toHaveProperty('workflowVersionId');
  });
});

describe('registerCronTrigger — version fields', () => {
  it('includes workflowVersionId and environment in BullMQ job data', async () => {
    const deps = makeDeps();

    await registerCronTrigger(
      {
        _id: 'reg-1',
        tenantId: 't1',
        projectId: 'p1',
        workflowId: 'wf-1',
        connectorName: 'scheduler',
        triggerName: 'daily_sync',
        connectionId: 'conn-1',
        cronExpression: '0 9 * * *',
        workflowVersionId: 'ver-1',
        environment: 'production',
      },
      deps,
    );

    expect(deps.queue.add).toHaveBeenCalledWith(
      'cron-trigger',
      expect.objectContaining({
        registrationId: 'reg-1',
        workflowVersionId: 'ver-1',
        environment: 'production',
      }),
      expect.any(Object),
    );
  });

  it('omits version fields from BullMQ job data when absent', async () => {
    const deps = makeDeps();

    await registerCronTrigger(
      {
        _id: 'reg-1',
        tenantId: 't1',
        projectId: 'p1',
        workflowId: 'wf-1',
        connectorName: 'scheduler',
        triggerName: 'daily_sync',
        connectionId: 'conn-1',
        cronExpression: '0 9 * * *',
      },
      deps,
    );

    const jobDataArg = (deps.queue.add as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(jobDataArg).not.toHaveProperty('workflowVersionId');
    expect(jobDataArg).not.toHaveProperty('environment');
  });
});
