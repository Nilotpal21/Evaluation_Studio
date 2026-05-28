import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TriggerEngine, type TriggerEngineDeps } from '../services/trigger-engine.js';

function makeDeps(overrides: Partial<TriggerEngineDeps> = {}): TriggerEngineDeps {
  return {
    triggerModel: {
      create: vi.fn().mockResolvedValue({ _id: 'reg-1' }),
      find: vi.fn().mockReturnValue({ lean: () => Promise.resolve([]) }),
      findOne: vi.fn().mockResolvedValue({
        _id: 'reg-1',
        workflowId: 'wf-1',
        tenantId: 't1',
        projectId: 'p1',
        strategy: 'webhook',
        status: 'active',
        config: {},
      }),
      findOneAndUpdate: vi.fn().mockResolvedValue(null),
    },
    workflowModel: {
      findOne: vi.fn().mockResolvedValue({
        _id: 'wf-1',
        name: 'Test Workflow',
        steps: [{ id: 'step-1', type: 'http' }],
      }),
      findOneAndUpdate: vi.fn().mockResolvedValue(null),
    },
    restateClient: {
      startWorkflow: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  };
}

describe('Trigger registration — environment field', () => {
  let deps: TriggerEngineDeps;
  let engine: TriggerEngine;

  beforeEach(() => {
    deps = makeDeps();
    engine = new TriggerEngine(deps);
  });

  it('stores environment on trigger registration', async () => {
    await engine.register({
      workflowId: 'wf-1',
      tenantId: 't1',
      projectId: 'p1',
      triggerType: 'cron',
      config: { cron: '0 9 * * *' },
      environment: 'production',
    });

    expect(deps.triggerModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: 'production',
      }),
    );
  });

  it('defaults environment to undefined when not provided', async () => {
    await engine.register({
      workflowId: 'wf-1',
      tenantId: 't1',
      projectId: 'p1',
      triggerType: 'webhook',
      config: {},
    });

    const createCall = (deps.triggerModel.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createCall.environment).toBeUndefined();
  });

  it('passes environment through the route body', async () => {
    await engine.register({
      workflowId: 'wf-1',
      tenantId: 't1',
      projectId: 'p1',
      triggerType: 'webhook',
      config: {},
      environment: 'staging',
    });

    expect(deps.triggerModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: 'staging',
      }),
    );
  });
});
