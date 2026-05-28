import { describe, it, expect, vi, afterEach } from 'vitest';
import { TriggerEngine, type TriggerEngineDeps } from '../triggers/trigger-engine.js';
import { CONNECTOR_POLLING_DEFAULTS_MS } from '../triggers/polling-defaults.js';
import { DEFAULT_POLLING_INTERVAL_MS } from '../triggers/constants.js';
import { ConnectorRegistry } from '../registry.js';
import type { ConnectorTrigger } from '../types.js';

function makeTrigger(
  triggerType: 'webhook' | 'cron' | 'event',
  name = 'test_trigger',
): ConnectorTrigger {
  return {
    name,
    displayName: 'Test Trigger',
    description: 'Test',
    triggerType,
    props: [],
    pollingIntervalMs: 120_000,
    onEnable: vi.fn().mockResolvedValue(undefined),
    onDisable: vi.fn().mockResolvedValue(undefined),
    run: vi.fn().mockResolvedValue([]),
  };
}

function makeDeps(triggers: ConnectorTrigger[]): TriggerEngineDeps {
  const registry = new ConnectorRegistry();
  registry.register({
    name: 'test-connector',
    displayName: 'Test',
    version: '1.0.0',
    description: 'Test connector',
    auth: { type: 'none' },
    triggers,
    actions: [],
  });

  return {
    registry,
    registrationModel: {
      findOne: vi.fn().mockResolvedValue(null),
      findOneAndUpdate: vi.fn().mockResolvedValue(null),
    },
    restateClient: {
      startWorkflow: vi.fn().mockResolvedValue(undefined),
    },
    redis: {
      set: vi.fn().mockResolvedValue('OK'),
    },
    pollingQueue: {
      add: vi.fn().mockResolvedValue(undefined),
      removeRepeatable: vi.fn().mockResolvedValue(undefined),
    },
    cronQueue: {
      add: vi.fn().mockResolvedValue(undefined),
      removeRepeatable: vi.fn().mockResolvedValue(undefined),
    },
    decryptSecret: vi.fn().mockResolvedValue('secret'),
    storeFactory: vi.fn().mockReturnValue({
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    }),
  };
}

describe('TriggerEngine', () => {
  describe('registerTrigger', () => {
    it('routes webhook triggers (no queue job needed)', async () => {
      const deps = makeDeps([makeTrigger('webhook')]);
      const engine = new TriggerEngine(deps);

      const result = await engine.registerTrigger({
        registrationId: 'reg-1',
        tenantId: 't1',
        projectId: 'p1',
        workflowId: 'wf-1',
        connectorName: 'test-connector',
        triggerName: 'test_trigger',
        connectionId: 'conn-1',
        config: {},
      });

      expect(result.triggerType).toBe('webhook');
      expect(deps.pollingQueue.add).not.toHaveBeenCalled();
      expect(deps.cronQueue.add).not.toHaveBeenCalled();
    });

    it('routes cron triggers with polling interval to polling queue', async () => {
      const deps = makeDeps([makeTrigger('cron')]);
      const engine = new TriggerEngine(deps);

      const result = await engine.registerTrigger({
        registrationId: 'reg-2',
        tenantId: 't1',
        projectId: 'p1',
        workflowId: 'wf-1',
        connectorName: 'test-connector',
        triggerName: 'test_trigger',
        connectionId: 'conn-1',
        config: {},
        pollingIntervalMs: 180_000,
      });

      expect(result.triggerType).toBe('cron');
      expect(deps.pollingQueue.add).toHaveBeenCalledWith(
        'poll-trigger',
        expect.objectContaining({ registrationId: 'reg-2' }),
        expect.objectContaining({
          repeat: { every: 180_000 },
        }),
      );
    });

    it('routes cron triggers with cronExpression to cron queue', async () => {
      const deps = makeDeps([makeTrigger('cron')]);
      const engine = new TriggerEngine(deps);

      const result = await engine.registerTrigger({
        registrationId: 'reg-3',
        tenantId: 't1',
        projectId: 'p1',
        workflowId: 'wf-1',
        connectorName: 'test-connector',
        triggerName: 'test_trigger',
        connectionId: 'conn-1',
        config: {},
        cronExpression: '0 9 * * *',
      });

      expect(result.triggerType).toBe('cron');
      expect(deps.cronQueue.add).toHaveBeenCalledWith(
        'cron-trigger',
        expect.objectContaining({ registrationId: 'reg-3' }),
        expect.objectContaining({
          repeat: { cron: '0 9 * * *' },
        }),
      );
    });

    it('falls back to polling queue when cron trigger has no cronExpression', async () => {
      const deps = makeDeps([makeTrigger('cron')]);
      const engine = new TriggerEngine(deps);

      const result = await engine.registerTrigger({
        registrationId: 'reg-4',
        tenantId: 't1',
        projectId: 'p1',
        workflowId: 'wf-1',
        connectorName: 'test-connector',
        triggerName: 'test_trigger',
        connectionId: 'conn-1',
        config: {},
      });

      expect(result.triggerType).toBe('cron');
      expect(deps.pollingQueue.add).toHaveBeenCalled();
    });

    it('throws when trigger not found', async () => {
      const deps = makeDeps([]);
      const engine = new TriggerEngine(deps);

      await expect(
        engine.registerTrigger({
          registrationId: 'reg-5',
          tenantId: 't1',
          projectId: 'p1',
          workflowId: 'wf-1',
          connectorName: 'test-connector',
          triggerName: 'nonexistent',
          connectionId: 'conn-1',
          config: {},
        }),
      ).rejects.toThrow('Unknown trigger');
    });

    // Per-connector override precedence: when the piece doesn't declare a
    // pollingIntervalMs and the caller doesn't pass one, the platform-level
    // CONNECTOR_POLLING_DEFAULTS_MS map wins over the global default.
    describe('per-connector polling override (CONNECTOR_POLLING_DEFAULTS_MS)', () => {
      afterEach(() => {
        delete CONNECTOR_POLLING_DEFAULTS_MS['test-connector'];
      });

      it('uses the per-connector override when piece and input omit pollingIntervalMs', async () => {
        // Piece-less interval by explicitly clearing the fixture value.
        const pieceTrigger = makeTrigger('cron');
        delete (pieceTrigger as { pollingIntervalMs?: number }).pollingIntervalMs;
        const deps = makeDeps([pieceTrigger]);
        const engine = new TriggerEngine(deps);

        CONNECTOR_POLLING_DEFAULTS_MS['test-connector'] = 45_000;

        await engine.registerTrigger({
          registrationId: 'reg-override',
          tenantId: 't1',
          projectId: 'p1',
          workflowId: 'wf-1',
          connectorName: 'test-connector',
          triggerName: 'test_trigger',
          connectionId: 'conn-1',
          config: {},
        });

        expect(deps.pollingQueue.add).toHaveBeenCalledWith(
          'poll-trigger',
          expect.anything(),
          expect.objectContaining({ repeat: { every: 45_000 } }),
        );
      });

      it('falls through to DEFAULT_POLLING_INTERVAL_MS when no override is set anywhere', async () => {
        // No override, no piece-declared interval, no input — global default wins.
        const pieceTrigger = makeTrigger('cron');
        delete (pieceTrigger as { pollingIntervalMs?: number }).pollingIntervalMs;
        const deps = makeDeps([pieceTrigger]);
        const engine = new TriggerEngine(deps);

        await engine.registerTrigger({
          registrationId: 'reg-global-default',
          tenantId: 't1',
          projectId: 'p1',
          workflowId: 'wf-1',
          connectorName: 'test-connector',
          triggerName: 'test_trigger',
          connectionId: 'conn-1',
          config: {},
        });

        expect(deps.pollingQueue.add).toHaveBeenCalledWith(
          'poll-trigger',
          expect.anything(),
          expect.objectContaining({ repeat: { every: DEFAULT_POLLING_INTERVAL_MS } }),
        );
      });

      it('prefers input.pollingIntervalMs over the per-connector override', async () => {
        const pieceTrigger = makeTrigger('cron');
        delete (pieceTrigger as { pollingIntervalMs?: number }).pollingIntervalMs;
        const deps = makeDeps([pieceTrigger]);
        const engine = new TriggerEngine(deps);

        CONNECTOR_POLLING_DEFAULTS_MS['test-connector'] = 45_000;

        await engine.registerTrigger({
          registrationId: 'reg-input-wins',
          tenantId: 't1',
          projectId: 'p1',
          workflowId: 'wf-1',
          connectorName: 'test-connector',
          triggerName: 'test_trigger',
          connectionId: 'conn-1',
          config: {},
          pollingIntervalMs: 15_000, // caller explicit — should win
        });

        expect(deps.pollingQueue.add).toHaveBeenCalledWith(
          'poll-trigger',
          expect.anything(),
          expect.objectContaining({ repeat: { every: 15_000 } }),
        );
      });
    });
  });

  describe('deregisterTrigger', () => {
    it('removes cron queue job with cronExpression', async () => {
      const deps = makeDeps([makeTrigger('cron')]);
      const engine = new TriggerEngine(deps);

      await engine.deregisterTrigger('reg-1', 'cron', { cronExpression: '0 9 * * *' });

      expect(deps.cronQueue.removeRepeatable).toHaveBeenCalled();
    });

    it('removes cron queue job with pollingIntervalMs', async () => {
      const deps = makeDeps([makeTrigger('cron')]);
      const engine = new TriggerEngine(deps);

      await engine.deregisterTrigger('reg-1', 'cron', { pollingIntervalMs: 120_000 });

      expect(deps.pollingQueue.removeRepeatable).toHaveBeenCalled();
    });

    it('no-ops for webhook triggers', async () => {
      const deps = makeDeps([makeTrigger('webhook')]);
      const engine = new TriggerEngine(deps);

      await engine.deregisterTrigger('reg-1', 'webhook');

      expect(deps.pollingQueue.removeRepeatable).not.toHaveBeenCalled();
      expect(deps.cronQueue.removeRepeatable).not.toHaveBeenCalled();
    });

    it('no-ops for event triggers', async () => {
      const deps = makeDeps([makeTrigger('event')]);
      const engine = new TriggerEngine(deps);

      await engine.deregisterTrigger('reg-1', 'event');

      expect(deps.pollingQueue.removeRepeatable).not.toHaveBeenCalled();
      expect(deps.cronQueue.removeRepeatable).not.toHaveBeenCalled();
    });
  });

  describe('pauseTrigger', () => {
    it('sets status to paused and removes queue job', async () => {
      const deps = makeDeps([makeTrigger('cron')]);
      const engine = new TriggerEngine(deps);

      await engine.pauseTrigger('reg-1', 't1', 'cron', { pollingIntervalMs: 120_000 });

      expect(deps.registrationModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'reg-1', tenantId: 't1' },
        { $set: { status: 'paused' } },
      );
      expect(deps.pollingQueue.removeRepeatable).toHaveBeenCalled();
    });
  });
});
