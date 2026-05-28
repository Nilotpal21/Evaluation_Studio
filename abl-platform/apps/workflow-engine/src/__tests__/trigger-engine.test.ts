import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TriggerEngine, type TriggerEngineDeps } from '../services/trigger-engine.js';

function makeDeps(overrides: Partial<TriggerEngineDeps> = {}): TriggerEngineDeps {
  return {
    triggerModel: {
      create: vi.fn().mockResolvedValue({ _id: 'reg-1' }),
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

describe('TriggerEngine', () => {
  let deps: TriggerEngineDeps;
  let engine: TriggerEngine;

  beforeEach(() => {
    deps = makeDeps();
    engine = new TriggerEngine(deps);
  });

  describe('register()', () => {
    it('creates a trigger and returns a registrationId', async () => {
      const result = await engine.register({
        workflowId: 'wf-1',
        tenantId: 't1',
        projectId: 'p1',
        triggerType: 'webhook',
        config: { connectorName: 'github', triggerName: 'push', connectionId: 'conn-1' },
      });

      expect(result.registrationId).toBeDefined();
      expect(typeof result.registrationId).toBe('string');
      expect(deps.triggerModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          workflowId: 'wf-1',
          tenantId: 't1',
          projectId: 'p1',
          triggerType: 'webhook',
          config: expect.objectContaining({
            connectorName: 'github',
            triggerName: 'push',
            connectionId: 'conn-1',
          }),
          status: 'active',
        }),
      );
    });

    it('passes empty config through when config omits connector fields', async () => {
      await engine.register({
        workflowId: 'wf-1',
        tenantId: 't1',
        projectId: 'p1',
        triggerType: 'event',
        config: {},
      });

      expect(deps.triggerModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          workflowId: 'wf-1',
          tenantId: 't1',
          projectId: 'p1',
          triggerType: 'event',
          config: {},
          status: 'active',
        }),
      );
    });

    it('persists workflowVersionId and environment on the trigger document', async () => {
      await engine.register({
        workflowId: 'wf-1',
        tenantId: 't1',
        projectId: 'p1',
        triggerType: 'webhook',
        config: {},
        workflowVersionId: 'ver-1',
        environment: 'production',
      });

      expect(deps.triggerModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          workflowVersionId: 'ver-1',
          environment: 'production',
        }),
      );
    });

    it('defaults triggerName to triggerType when caller does not supply one', async () => {
      // The TriggerRegistration schema requires `triggerName`. Studio callers
      // (WorkflowTriggersTab) omit it, so the engine must default the field
      // before persisting — otherwise Mongoose validation rejects the save.
      await engine.register({
        workflowId: 'wf-1',
        tenantId: 't1',
        projectId: 'p1',
        triggerType: 'webhook',
        config: {},
      });

      expect(deps.triggerModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ triggerName: 'webhook' }),
      );
    });

    it('preserves explicit triggerName when caller supplies one', async () => {
      await engine.register({
        workflowId: 'wf-1',
        tenantId: 't1',
        projectId: 'p1',
        triggerType: 'webhook',
        triggerName: 'incoming-lead',
        config: {},
      });

      expect(deps.triggerModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ triggerName: 'incoming-lead' }),
      );
    });

    it('includes workflowVersionId and environment in cron jobData', async () => {
      const scheduler = {
        scheduleCron: vi.fn().mockResolvedValue(undefined),
        scheduleOnce: vi.fn().mockResolvedValue(undefined),
        schedulePolling: vi.fn().mockResolvedValue(undefined),
        unschedule: vi.fn().mockResolvedValue(undefined),
        shutdown: vi.fn().mockResolvedValue(undefined),
      };
      deps = makeDeps({ scheduler });
      engine = new TriggerEngine(deps);

      await engine.register({
        workflowId: 'wf-1',
        tenantId: 't1',
        projectId: 'p1',
        triggerType: 'cron',
        config: { cronExpression: '0 9 * * *' },
        workflowVersionId: 'ver-1',
        environment: 'staging',
      });

      expect(scheduler.scheduleCron).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          workflowVersionId: 'ver-1',
          environment: 'staging',
        }),
        '0 9 * * *',
        undefined,
      );
    });

    it('omits version fields from cron jobData when not provided', async () => {
      const scheduler = {
        scheduleCron: vi.fn().mockResolvedValue(undefined),
        scheduleOnce: vi.fn().mockResolvedValue(undefined),
        schedulePolling: vi.fn().mockResolvedValue(undefined),
        unschedule: vi.fn().mockResolvedValue(undefined),
        shutdown: vi.fn().mockResolvedValue(undefined),
      };
      deps = makeDeps({ scheduler });
      engine = new TriggerEngine(deps);

      await engine.register({
        workflowId: 'wf-1',
        tenantId: 't1',
        projectId: 'p1',
        triggerType: 'cron',
        config: { cronExpression: '0 9 * * *' },
      });

      const jobDataArg = scheduler.scheduleCron.mock.calls[0][1];
      expect(jobDataArg).not.toHaveProperty('workflowVersionId');
      expect(jobDataArg).not.toHaveProperty('environment');
    });
  });

  // GAP-012 — Regression coverage for connector (app) trigger delegation.
  //
  // Context: between the unified-trigger-types refactor (commit 27f03ee221,
  // 2026-04-14) and this fix, `TriggerEngine.register()` persisted the
  // registration document but never called `connectorTriggerEngine.registerTrigger`.
  // As a result, every connector-backed app trigger (Gmail, Slack, etc.)
  // registered successfully but never fired — the polling worker had nothing
  // to process because no BullMQ job was ever enqueued.
  //
  // These tests assert the delegation branch in `register()`: any registration
  // whose `config.connectorName` is set is handed to the connector trigger
  // engine regardless of the caller-supplied `triggerType` (Studio sends
  // `event`, Activepieces may classify it as `cron`/polling — the connector
  // engine is the authority on strategy).
  describe('register() — connector delegation (app triggers)', () => {
    it('delegates to connectorTriggerEngine when config.connectorName is set', async () => {
      const connectorTriggerEngine = {
        registerTrigger: vi.fn().mockResolvedValue({ triggerType: 'cron' }),
      };
      deps = makeDeps({ connectorTriggerEngine });
      engine = new TriggerEngine(deps);

      const result = await engine.register({
        workflowId: 'wf-1',
        tenantId: 't1',
        projectId: 'p1',
        triggerType: 'event',
        config: {
          connectorName: 'gmail',
          triggerName: 'gmail_new_email_received',
          connectionId: 'conn-123',
        },
      });

      expect(connectorTriggerEngine.registerTrigger).toHaveBeenCalledTimes(1);
      expect(connectorTriggerEngine.registerTrigger).toHaveBeenCalledWith(
        expect.objectContaining({
          registrationId: result.registrationId,
          tenantId: 't1',
          projectId: 'p1',
          workflowId: 'wf-1',
          connectorName: 'gmail',
          triggerName: 'gmail_new_email_received',
          connectionId: 'conn-123',
        }),
      );
    });

    it('forwards pollingIntervalMs and cronExpression to connectorTriggerEngine when present', async () => {
      const connectorTriggerEngine = {
        registerTrigger: vi.fn().mockResolvedValue({ triggerType: 'cron' }),
      };
      deps = makeDeps({ connectorTriggerEngine });
      engine = new TriggerEngine(deps);

      await engine.register({
        workflowId: 'wf-1',
        tenantId: 't1',
        projectId: 'p1',
        triggerType: 'cron',
        config: {
          connectorName: 'slack',
          triggerName: 'new_message',
          connectionId: 'conn-2',
          pollingIntervalMs: 60_000,
          cronExpression: '*/5 * * * *',
        },
      });

      expect(connectorTriggerEngine.registerTrigger).toHaveBeenCalledWith(
        expect.objectContaining({
          connectorName: 'slack',
          pollingIntervalMs: 60_000,
          cronExpression: '*/5 * * * *',
        }),
      );
    });

    it('does NOT call the BullMQ scheduler when delegating to connectorTriggerEngine', async () => {
      // Guard against double-scheduling: the connector trigger engine owns
      // the job queue for connector triggers. If both ran, a polling trigger
      // would fire twice per tick.
      const scheduler = {
        scheduleCron: vi.fn().mockResolvedValue(undefined),
        scheduleOnce: vi.fn().mockResolvedValue(undefined),
        schedulePolling: vi.fn().mockResolvedValue(undefined),
        unschedule: vi.fn().mockResolvedValue(undefined),
        shutdown: vi.fn().mockResolvedValue(undefined),
      };
      const connectorTriggerEngine = {
        registerTrigger: vi.fn().mockResolvedValue({ triggerType: 'cron' }),
      };
      deps = makeDeps({ scheduler, connectorTriggerEngine });
      engine = new TriggerEngine(deps);

      await engine.register({
        workflowId: 'wf-1',
        tenantId: 't1',
        projectId: 'p1',
        triggerType: 'cron',
        config: {
          connectorName: 'gmail',
          triggerName: 'gmail_new_email_received',
          connectionId: 'conn-1',
          cronExpression: '*/5 * * * *',
        },
      });

      expect(connectorTriggerEngine.registerTrigger).toHaveBeenCalledTimes(1);
      expect(scheduler.scheduleCron).not.toHaveBeenCalled();
      expect(scheduler.schedulePolling).not.toHaveBeenCalled();
    });

    it('does NOT delegate when config.connectorName is absent', async () => {
      // User-created webhook / cron / event triggers (no connector) must keep
      // taking the scheduler path — delegation is connector-only.
      const connectorTriggerEngine = {
        registerTrigger: vi.fn().mockResolvedValue({ triggerType: 'cron' }),
      };
      deps = makeDeps({ connectorTriggerEngine });
      engine = new TriggerEngine(deps);

      await engine.register({
        workflowId: 'wf-1',
        tenantId: 't1',
        projectId: 'p1',
        triggerType: 'webhook',
        config: { url: 'https://example.com/hook' },
      });

      expect(connectorTriggerEngine.registerTrigger).not.toHaveBeenCalled();
    });

    it('persists the registration even when connectorTriggerEngine is unwired (deployments without Redis/connectors)', async () => {
      // Mirrors the "scheduler absent but still persist" pattern for cron.
      // If no connector trigger engine is provided, the trigger must NOT
      // throw — the registration is stored so an operator can attach the
      // engine and resume without data loss.
      deps = makeDeps(); // no connectorTriggerEngine
      engine = new TriggerEngine(deps);

      const result = await engine.register({
        workflowId: 'wf-1',
        tenantId: 't1',
        projectId: 'p1',
        triggerType: 'event',
        config: {
          connectorName: 'gmail',
          triggerName: 'gmail_new_email_received',
          connectionId: 'conn-1',
        },
      });

      expect(result.registrationId).toBeDefined();
      expect(deps.triggerModel.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('deregister()', () => {
    it('sets status to deleted with deletedAt using tenantId + projectId filter', async () => {
      await engine.deregister('reg-1', 't1', 'p1');

      expect(deps.triggerModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'reg-1', tenantId: 't1', projectId: 'p1' },
        { $set: { status: 'deleted', deletedAt: expect.any(Date) } },
      );
    });

    it('omits projectId from filter when not provided', async () => {
      await engine.deregister('reg-1', 't1');

      expect(deps.triggerModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'reg-1', tenantId: 't1' },
        expect.any(Object),
      );
    });
  });

  describe('pause()', () => {
    it('sets status to paused', async () => {
      await engine.pause('reg-1', 't1', 'p1');

      expect(deps.triggerModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'reg-1', tenantId: 't1', projectId: 'p1' },
        { $set: { status: 'paused' } },
      );
    });
  });

  describe('resume()', () => {
    it('sets status to active', async () => {
      await engine.resume('reg-1', 't1', 'p1');

      expect(deps.triggerModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'reg-1', tenantId: 't1', projectId: 'p1' },
        { $set: { status: 'active' } },
      );
    });
  });

  describe('fireWebhookTrigger()', () => {
    it('loads trigger + workflow and starts execution via Restate', async () => {
      const result = await engine.fireWebhookTrigger('reg-1', { event: 'push' }, 't1');

      expect(result.executionId).toBeDefined();
      expect(typeof result.executionId).toBe('string');

      expect(deps.triggerModel.findOne).toHaveBeenCalledWith({
        _id: 'reg-1',
        status: 'active',
        tenantId: 't1',
      });
      expect(deps.workflowModel.findOne).toHaveBeenCalledWith({
        _id: 'wf-1',
        tenantId: 't1',
        projectId: 'p1',
      });
      expect(deps.restateClient.startWorkflow).toHaveBeenCalledWith(
        result.executionId,
        expect.objectContaining({
          workflowId: 'wf-1',
          workflowName: 'Test Workflow',
          tenantId: 't1',
          projectId: 'p1',
          triggerType: 'webhook',
          triggerPayload: { event: 'push' },
          triggerMetadata: expect.objectContaining({
            registrationId: 'reg-1',
          }),
          steps: [{ id: 'step-1', type: 'http' }],
        }),
      );
    });

    it('throws if trigger not found or not active', async () => {
      deps.triggerModel.findOne = vi.fn().mockResolvedValue(null);
      engine = new TriggerEngine(deps);

      await expect(engine.fireWebhookTrigger('nonexistent', {}, 't1')).rejects.toThrow(
        'Trigger nonexistent not found or not active',
      );
    });

    it('throws if workflow not found', async () => {
      deps.workflowModel.findOne = vi.fn().mockResolvedValue(null);
      engine = new TriggerEngine(deps);

      await expect(engine.fireWebhookTrigger('reg-1', {}, 't1')).rejects.toThrow(
        'Workflow wf-1 not found',
      );
    });

    it('falls back to working copy when deployment-pinned version is missing', async () => {
      // deployment is resolved, manifest pins a version, but that WorkflowVersion
      // doc does not exist — expect a warn-and-continue, plus Restate still
      // fires using the working copy `steps`.
      deps.triggerModel.findOne = vi.fn().mockResolvedValue({
        _id: 'reg-1',
        workflowId: 'wf-1',
        tenantId: 't1',
        projectId: 'p1',
        strategy: 'webhook',
        status: 'active',
        environment: 'staging',
        config: {},
      });
      deps.deploymentModel = {
        findOne: vi.fn().mockReturnValue({
          sort: vi.fn().mockReturnValue({
            lean: vi.fn().mockResolvedValue({
              _id: 'dep-1',
              workflowVersionManifest: { 'Test Workflow': 'v2' },
            }),
          }),
        }),
      } as any;
      deps.workflowVersionModel = {
        findOne: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue(null), // pinned version not found
        }),
      } as any;
      engine = new TriggerEngine(deps);

      // Match the trigger's environment so the environment-gate passes and we
      // reach the deployment resolution branch we actually want to exercise.
      const result = await engine.fireWebhookTrigger('reg-1', { environment: 'staging' }, 't1');
      expect(result.executionId).toBeDefined();
      expect(deps.restateClient.startWorkflow).toHaveBeenCalledWith(
        result.executionId,
        expect.objectContaining({
          steps: [{ id: 'step-1', type: 'http' }],
        }),
      );
    });

    it('converts canvas nodes/edges when workflow.steps is empty', async () => {
      // When working copy doesn't carry a denormalized `steps` array, the
      // engine must run canvas-to-steps on nodes+edges (lines 492-507).
      deps.workflowModel.findOne = vi.fn().mockResolvedValue({
        _id: 'wf-1',
        name: 'Canvas Only',
        steps: undefined,
        nodes: [
          { id: 'start-1', nodeType: 'start', name: 'Start' },
          { id: 'end-1', nodeType: 'end', name: 'End' },
        ],
        edges: [{ id: 'e1', source: 'start-1', target: 'end-1' }],
      });
      engine = new TriggerEngine(deps);

      const result = await engine.fireWebhookTrigger('reg-1', {}, 't1');
      expect(result.executionId).toBeDefined();
      // Derived steps should be a non-empty array from the canvas conversion.
      const call = (deps.restateClient.startWorkflow as any).mock.calls[0];
      expect(Array.isArray(call[1].steps)).toBe(true);
    });
  });
});
