import { describe, it, expect, vi } from 'vitest';
import {
  rehydrateConnectorTriggers,
  type RehydrateDeps,
  type ConnectorTriggerDoc,
} from '../services/connector-trigger-rehydrator.js';

function makeDoc(overrides: Partial<ConnectorTriggerDoc> = {}): ConnectorTriggerDoc {
  return {
    _id: 'reg-gmail-1',
    tenantId: 't1',
    projectId: 'p1',
    workflowId: 'wf-1',
    status: 'active',
    config: {
      connectorName: 'gmail',
      triggerName: 'gmail_new_email_received',
      connectionId: 'conn-1',
    },
    ...overrides,
  };
}

function makeDeps(
  docs: ConnectorTriggerDoc[] = [],
  registerImpl?: () => Promise<unknown>,
): RehydrateDeps {
  const registerTrigger =
    registerImpl ??
    (vi.fn().mockResolvedValue({ triggerType: 'cron' }) as unknown as () => Promise<unknown>);
  return {
    triggerModel: {
      find: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(docs),
      }),
    },
    connectorTriggerEngine: {
      // Cast through unknown — test doubles don't need the full deps shape.
      registerTrigger:
        registerTrigger as unknown as RehydrateDeps['connectorTriggerEngine']['registerTrigger'],
    },
  };
}

describe('rehydrateConnectorTriggers', () => {
  it('queries active registrations with a connectorName present', async () => {
    const deps = makeDeps([]);
    await rehydrateConnectorTriggers(deps);

    expect(deps.triggerModel.find).toHaveBeenCalledWith({
      status: 'active',
      'config.connectorName': { $exists: true, $ne: null },
    });
  });

  it('calls registerTrigger for each valid registration and returns a success count', async () => {
    const deps = makeDeps([
      makeDoc({ _id: 'reg-1' }),
      makeDoc({
        _id: 'reg-2',
        config: {
          connectorName: 'slack',
          triggerName: 'new_message',
          connectionId: 'conn-2',
          pollingIntervalMs: 60_000,
        },
      }),
    ]);

    const result = await rehydrateConnectorTriggers(deps);

    expect(result).toEqual({ rehydrated: 2, skipped: 0, failed: 0 });
    expect(deps.connectorTriggerEngine.registerTrigger).toHaveBeenCalledTimes(2);
    // First call — Gmail, default interval (no pollingIntervalMs in config).
    expect(deps.connectorTriggerEngine.registerTrigger).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        registrationId: 'reg-1',
        connectorName: 'gmail',
        triggerName: 'gmail_new_email_received',
        connectionId: 'conn-1',
      }),
    );
    // Second call — Slack, with explicit interval forwarded from config.
    expect(deps.connectorTriggerEngine.registerTrigger).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        registrationId: 'reg-2',
        connectorName: 'slack',
        triggerName: 'new_message',
        connectionId: 'conn-2',
        pollingIntervalMs: 60_000,
      }),
    );
  });

  it('forwards workflowVersionId and environment when present on the registration', async () => {
    const deps = makeDeps([
      makeDoc({
        _id: 'reg-versioned',
        workflowVersionId: 'ver-1',
        environment: 'production',
      }),
    ]);

    await rehydrateConnectorTriggers(deps);

    expect(deps.connectorTriggerEngine.registerTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowVersionId: 'ver-1',
        environment: 'production',
      }),
    );
  });

  it('skips registrations missing connectorName / triggerName / connectionId', async () => {
    const deps = makeDeps([
      makeDoc({
        _id: 'reg-missing-trigger',
        config: { connectorName: 'gmail' }, // no triggerName, no connectionId
      }),
      makeDoc({
        _id: 'reg-missing-connection',
        config: {
          connectorName: 'slack',
          triggerName: 'new_message',
          // connectionId omitted
        },
      }),
    ]);

    const result = await rehydrateConnectorTriggers(deps);

    expect(result).toEqual({ rehydrated: 0, skipped: 2, failed: 0 });
    expect(deps.connectorTriggerEngine.registerTrigger).not.toHaveBeenCalled();
  });

  it('counts registerTrigger throws as failed and continues with the rest', async () => {
    const impl = vi
      .fn()
      .mockRejectedValueOnce(new Error('Unknown trigger'))
      .mockResolvedValueOnce({ triggerType: 'cron' })
      .mockRejectedValueOnce(new Error('Redis connection lost'));
    const deps = makeDeps(
      [makeDoc({ _id: 'reg-bad-1' }), makeDoc({ _id: 'reg-good' }), makeDoc({ _id: 'reg-bad-2' })],
      impl,
    );

    const result = await rehydrateConnectorTriggers(deps);

    // One succeeds between two failures — proving we don't short-circuit.
    expect(result).toEqual({ rehydrated: 1, skipped: 0, failed: 2 });
    expect(impl).toHaveBeenCalledTimes(3);
  });

  it('returns zeros when there are no connector-backed registrations', async () => {
    const deps = makeDeps([]);
    const result = await rehydrateConnectorTriggers(deps);
    expect(result).toEqual({ rehydrated: 0, skipped: 0, failed: 0 });
    expect(deps.connectorTriggerEngine.registerTrigger).not.toHaveBeenCalled();
  });
});
