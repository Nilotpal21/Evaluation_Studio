/**
 * GAP-011: Cron fires version's frozen flow (not working copy)
 * GAP-012: Per-trigger toggle with VERSION_INACTIVE guard
 *
 * These tests exercise the processJob() version-first resolution path
 * and the TriggerEngine pause/resume VERSION_INACTIVE guard via DI.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock bullmq before importing TriggerScheduler
let workerProcessor: ((job: unknown) => Promise<void>) | null = null;

vi.mock('bullmq', () => {
  function MockQueue() {
    return {
      add: vi.fn().mockResolvedValue({ id: 'job-1' }),
      close: vi.fn().mockResolvedValue(undefined),
      getRepeatableJobs: vi.fn().mockResolvedValue([]),
      removeRepeatableByKey: vi.fn().mockResolvedValue(undefined),
      // `Queue.remove` — needed by `unschedule` for one-shot cleanup
      // (finding ABLP-2 #6). Stubbed as a no-op; this suite never
      // asserts on it.
      remove: vi.fn().mockResolvedValue(0),
    };
  }
  function MockWorker(_name: string, processor: (job: unknown) => Promise<void>) {
    workerProcessor = processor;
    return {
      close: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
    };
  }
  return { Queue: MockQueue, Worker: MockWorker };
});

import {
  TriggerScheduler,
  type TriggerSchedulerDeps,
  type TriggerJobData,
} from '../services/trigger-scheduler.js';
import { TriggerEngine, type TriggerEngineDeps } from '../services/trigger-engine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockRedis() {
  return {
    duplicate: vi.fn().mockReturnValue({ disconnect: vi.fn() }),
  } as unknown as import('ioredis').Redis;
}

function makeSchedulerDeps(overrides: Partial<TriggerSchedulerDeps> = {}): TriggerSchedulerDeps {
  return {
    triggerModel: {
      findOne: vi.fn().mockResolvedValue({
        _id: 'reg-1',
        tenantId: 't1',
        status: 'active',
        config: {},
      }),
      findOneAndUpdate: vi.fn().mockResolvedValue(null),
    },
    workflowModel: {
      findOne: vi.fn().mockResolvedValue({
        _id: 'wf-1',
        name: 'Working Copy Workflow',
        nodes: [
          {
            id: 'start-1',
            nodeType: 'start',
            name: 'Start',
            config: {},
          },
          {
            id: 'http-1',
            nodeType: 'api',
            name: 'WorkingCopyHTTP',
            config: { url: 'https://working-copy.example.com' },
          },
          {
            id: 'end-1',
            nodeType: 'end',
            name: 'End',
            config: {},
          },
        ],
        edges: [
          { id: 'e1', source: 'start-1', target: 'http-1' },
          { id: 'e2', source: 'http-1', target: 'end-1' },
        ],
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

// ---------------------------------------------------------------------------
// GAP-011: processJob loads frozen version flow
// ---------------------------------------------------------------------------

describe('GAP-011: processJob loads version-frozen flow', () => {
  let deps: TriggerSchedulerDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    workerProcessor = null;
  });

  it('uses version definition when workflowVersionId is set in jobData', async () => {
    const frozenNodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      {
        id: 'http-frozen',
        nodeType: 'api',
        name: 'FrozenHTTP',
        config: { url: 'https://frozen-v1.example.com' },
      },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const frozenEdges = [
      { id: 'e1', source: 'start-1', target: 'http-frozen' },
      { id: 'e2', source: 'http-frozen', target: 'end-1' },
    ];

    deps = makeSchedulerDeps({
      workflowVersionModel: {
        findOne: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue({
            _id: 'ver-1',
            workflowId: 'wf-1',
            version: 'v1.0',
            definition: { nodes: frozenNodes, edges: frozenEdges },
          }),
        }),
      },
    });

    new TriggerScheduler(makeMockRedis(), deps);
    expect(workerProcessor).not.toBeNull();

    const job = {
      id: 'job-1',
      data: makeJobData({ workflowVersionId: 'ver-1' }),
    };
    await workerProcessor!(job);

    // Should have called startWorkflow
    expect(deps.restateClient.startWorkflow).toHaveBeenCalledTimes(1);

    const callArgs = (deps.restateClient.startWorkflow as ReturnType<typeof vi.fn>).mock.calls[0];
    const payload = callArgs[1] as Record<string, unknown>;

    // Verify frozen version was used (workflowVersion and workflowVersionId present)
    expect(payload.workflowVersion).toBe('v1.0');
    expect(payload.workflowVersionId).toBe('ver-1');

    // Verify the steps came from the version, not the working copy
    // The frozen version has 'FrozenHTTP' node; the working copy has 'WorkingCopyHTTP'
    const steps = payload.steps as Array<{ name?: string; id: string }>;
    const stepNames = steps.map((s) => s.name ?? s.id);
    expect(stepNames).toContain('FrozenHTTP');
    expect(stepNames).not.toContain('WorkingCopyHTTP');
  });

  it('falls back to working copy when workflowVersionId is not in jobData', async () => {
    deps = makeSchedulerDeps();

    new TriggerScheduler(makeMockRedis(), deps);
    expect(workerProcessor).not.toBeNull();

    const job = { id: 'job-1', data: makeJobData() };
    await workerProcessor!(job);

    expect(deps.restateClient.startWorkflow).toHaveBeenCalledTimes(1);

    const callArgs = (deps.restateClient.startWorkflow as ReturnType<typeof vi.fn>).mock.calls[0];
    const payload = callArgs[1] as Record<string, unknown>;

    // No version fields when falling back to working copy
    expect(payload).not.toHaveProperty('workflowVersion');
    expect(payload).not.toHaveProperty('workflowVersionId');

    // Steps came from the working copy
    const steps = payload.steps as Array<{ name?: string; id: string }>;
    const stepNames = steps.map((s) => s.name ?? s.id);
    expect(stepNames).toContain('WorkingCopyHTTP');
  });

  it('falls back to working copy when version document is not found', async () => {
    deps = makeSchedulerDeps({
      workflowVersionModel: {
        findOne: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue(null),
        }),
      },
    });

    new TriggerScheduler(makeMockRedis(), deps);
    expect(workerProcessor).not.toBeNull();

    const job = {
      id: 'job-1',
      data: makeJobData({ workflowVersionId: 'ver-missing' }),
    };
    await workerProcessor!(job);

    // Should still execute using working copy
    expect(deps.restateClient.startWorkflow).toHaveBeenCalledTimes(1);

    const callArgs = (deps.restateClient.startWorkflow as ReturnType<typeof vi.fn>).mock.calls[0];
    const payload = callArgs[1] as Record<string, unknown>;
    const steps = payload.steps as Array<{ name?: string; id: string }>;
    const stepNames = steps.map((s) => s.name ?? s.id);
    expect(stepNames).toContain('WorkingCopyHTTP');
  });
});

// ---------------------------------------------------------------------------
// GAP-012: Per-trigger toggle with VERSION_INACTIVE guard
// ---------------------------------------------------------------------------

describe('GAP-012: per-trigger toggle with VERSION_INACTIVE guard', () => {
  function makeEngineDeps(overrides: Partial<TriggerEngineDeps> = {}): TriggerEngineDeps {
    return {
      triggerModel: {
        create: vi.fn().mockResolvedValue({ _id: 'reg-1' }),
        findOne: vi.fn().mockResolvedValue({
          _id: 'reg-1',
          workflowId: 'wf-1',
          tenantId: 't1',
          projectId: 'p1',
          triggerType: 'cron',
          status: 'active',
          config: { cronExpression: '0 9 * * *' },
          workflowVersionId: 'ver-1',
        }),
        findOneAndUpdate: vi.fn().mockResolvedValue(null),
      },
      workflowModel: {
        findOne: vi.fn().mockResolvedValue({ _id: 'wf-1', name: 'Test' }),
        findOneAndUpdate: vi.fn().mockResolvedValue(null),
      },
      restateClient: {
        startWorkflow: vi.fn().mockResolvedValue(undefined),
      },
      workflowVersionModel: {
        findOne: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue({
            _id: 'ver-1',
            state: 'active',
          }),
        }),
      },
      ...overrides,
    };
  }

  it('allows pause when owning version is active', async () => {
    const deps = makeEngineDeps();
    const engine = new TriggerEngine(deps);

    await engine.pause('reg-1', 't1', 'p1');

    expect(deps.triggerModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'reg-1', tenantId: 't1', projectId: 'p1' },
      { $set: { status: 'paused' } },
    );
  });

  it('allows resume when owning version is active', async () => {
    const deps = makeEngineDeps();
    const engine = new TriggerEngine(deps);

    await engine.resume('reg-1', 't1', 'p1');

    expect(deps.triggerModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'reg-1', tenantId: 't1', projectId: 'p1' },
      { $set: { status: 'active' } },
    );
  });

  it('rejects pause when owning version is inactive (VERSION_INACTIVE)', async () => {
    const deps = makeEngineDeps({
      workflowVersionModel: {
        findOne: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue({
            _id: 'ver-1',
            state: 'inactive',
          }),
        }),
      },
    });
    const engine = new TriggerEngine(deps);

    await expect(engine.pause('reg-1', 't1', 'p1')).rejects.toThrow('VERSION_INACTIVE');
  });

  it('rejects resume when owning version is inactive (VERSION_INACTIVE)', async () => {
    const deps = makeEngineDeps({
      workflowVersionModel: {
        findOne: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue({
            _id: 'ver-1',
            state: 'inactive',
          }),
        }),
      },
    });
    const engine = new TriggerEngine(deps);

    await expect(engine.resume('reg-1', 't1', 'p1')).rejects.toThrow('VERSION_INACTIVE');
  });

  it('allows pause when trigger has no workflowVersionId (legacy)', async () => {
    const deps = makeEngineDeps({
      triggerModel: {
        create: vi.fn().mockResolvedValue({ _id: 'reg-1' }),
        findOne: vi.fn().mockResolvedValue({
          _id: 'reg-1',
          workflowId: 'wf-1',
          tenantId: 't1',
          projectId: 'p1',
          triggerType: 'cron',
          status: 'active',
          config: {},
          // No workflowVersionId — legacy trigger
        }),
        findOneAndUpdate: vi.fn().mockResolvedValue(null),
      },
    });
    const engine = new TriggerEngine(deps);

    await engine.pause('reg-1', 't1', 'p1');

    expect(deps.triggerModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'reg-1', tenantId: 't1', projectId: 'p1' },
      { $set: { status: 'paused' } },
    );
  });
});
