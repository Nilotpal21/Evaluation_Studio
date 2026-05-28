import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  registerPollingTrigger,
  deregisterPollingTrigger,
  processPollingJob,
  type PollingSchedulerDeps,
} from '../triggers/polling-scheduler.js';
import { ConnectorRegistry } from '../registry.js';
import type { TriggerRegistration, TriggerJobData } from '../triggers/types.js';
import { DEFAULT_POLLING_INTERVAL_MS, MIN_POLLING_INTERVAL_MS } from '../triggers/constants.js';

function makeRegistration(overrides: Partial<TriggerRegistration> = {}): TriggerRegistration {
  return {
    _id: 'reg-1',
    tenantId: 't1',
    projectId: 'p1',
    workflowId: 'wf-1',
    connectorName: 'hubspot',
    triggerName: 'new_contact',
    connectionId: 'conn-1',
    triggerType: 'cron',
    status: 'active',
    config: {},
    consecutiveErrors: 0,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<PollingSchedulerDeps> = {}): PollingSchedulerDeps {
  const registry = new ConnectorRegistry();
  registry.register({
    name: 'hubspot',
    displayName: 'HubSpot',
    version: '1.0.0',
    description: 'HubSpot CRM',
    auth: { type: 'api_key' },
    triggers: [
      {
        name: 'new_contact',
        displayName: 'New Contact',
        description: 'New contact created',
        triggerType: 'cron',
        props: [],
        onEnable: vi.fn().mockResolvedValue(undefined),
        onDisable: vi.fn().mockResolvedValue(undefined),
        run: vi.fn().mockResolvedValue([]),
      },
    ],
    actions: [],
  });

  const store = {
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };

  return {
    registry,
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
    storeFactory: vi.fn().mockReturnValue(store),
    ...overrides,
  };
}

const jobData: TriggerJobData = {
  registrationId: 'reg-1',
  tenantId: 't1',
  projectId: 'p1',
  connectorName: 'hubspot',
  triggerName: 'new_contact',
  connectionId: 'conn-1',
};

describe('registerPollingTrigger', () => {
  it('creates a BullMQ repeatable job at the specified interval', async () => {
    const deps = makeDeps();

    await registerPollingTrigger(
      {
        _id: 'reg-1',
        tenantId: 't1',
        projectId: 'p1',
        connectorName: 'hubspot',
        triggerName: 'new_contact',
        connectionId: 'conn-1',
        pollingIntervalMs: 120_000,
      },
      deps,
    );

    expect(deps.queue.add).toHaveBeenCalledWith(
      'poll-trigger',
      expect.objectContaining({ registrationId: 'reg-1' }),
      expect.objectContaining({
        repeat: { every: 120_000 },
        jobId: 'poll:reg-1',
      }),
    );
  });

  it('uses default polling interval when not specified', async () => {
    const deps = makeDeps();

    await registerPollingTrigger(
      {
        _id: 'reg-1',
        tenantId: 't1',
        projectId: 'p1',
        connectorName: 'hubspot',
        triggerName: 'new_contact',
        connectionId: 'conn-1',
      },
      deps,
    );

    expect(deps.queue.add).toHaveBeenCalledWith(
      'poll-trigger',
      expect.anything(),
      expect.objectContaining({
        repeat: { every: DEFAULT_POLLING_INTERVAL_MS },
      }),
    );
  });

  it('clamps interval to minimum', async () => {
    const deps = makeDeps();

    await registerPollingTrigger(
      {
        _id: 'reg-1',
        tenantId: 't1',
        projectId: 'p1',
        connectorName: 'hubspot',
        triggerName: 'new_contact',
        connectionId: 'conn-1',
        pollingIntervalMs: 1000, // too short
      },
      deps,
    );

    expect(deps.queue.add).toHaveBeenCalledWith(
      'poll-trigger',
      expect.anything(),
      expect.objectContaining({
        repeat: { every: MIN_POLLING_INTERVAL_MS },
      }),
    );
  });
});

describe('deregisterPollingTrigger', () => {
  it('removes the repeatable job', async () => {
    const deps = makeDeps();

    await deregisterPollingTrigger('reg-1', 120_000, { queue: deps.queue });

    expect(deps.queue.removeRepeatable).toHaveBeenCalledWith('poll-trigger', {
      every: 120_000,
      jobId: 'poll:reg-1',
    });
  });
});

describe('processPollingJob', () => {
  it('skips when registration not found', async () => {
    const deps = makeDeps({
      registrationModel: {
        findOne: vi.fn().mockResolvedValue(null),
        findOneAndUpdate: vi.fn().mockResolvedValue(null),
      },
    });

    await processPollingJob(jobData, deps);

    expect(deps.restateClient.startWorkflow).not.toHaveBeenCalled();
  });

  it('invokes Restate for each new item returned by trigger.run()', async () => {
    const registry = new ConnectorRegistry();
    registry.register({
      name: 'hubspot',
      displayName: 'HubSpot',
      version: '1.0.0',
      description: 'HubSpot CRM',
      auth: { type: 'api_key' },
      triggers: [
        {
          name: 'new_contact',
          displayName: 'New Contact',
          description: 'New contact',
          triggerType: 'cron',
          props: [],
          onEnable: vi.fn().mockResolvedValue(undefined),
          onDisable: vi.fn().mockResolvedValue(undefined),
          run: vi.fn().mockResolvedValue([{ id: 'c1' }, { id: 'c2' }]),
        },
      ],
      actions: [],
    });

    const store = {
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    const deps = makeDeps({ registry, storeFactory: vi.fn().mockReturnValue(store) });

    await processPollingJob(jobData, deps);

    expect(deps.restateClient.startWorkflow).toHaveBeenCalledTimes(2);
    expect(deps.restateClient.startWorkflow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        // Connector-backed triggers are events, not cron — the BullMQ
        // polling cadence is an implementation detail. Monitor tab + audit
        // logs need the user-visible category ('event') to correctly
        // classify runs that came from Gmail/Slack/etc.
        triggerType: 'event',
        triggerPayload: { id: 'c1' },
      }),
    );
  });

  // Regression: canvas-authored workflows (nodes+edges, no legacy `steps`
  // array) were reaching Restate with empty `steps` and zero wiring data
  // because the `WorkflowDefinitionResolver` interface only returned
  // `{workflowName, steps}`. `processPollingJob` must forward the full
  // shape — including outputMappings + nameToIdMap — so canvas workflows
  // fired from polling triggers produce real executions, not empty shells.
  it('forwards outputMappings and nameToIdMap from resolver to Restate', async () => {
    const registry = new ConnectorRegistry();
    registry.register({
      name: 'hubspot',
      displayName: 'HubSpot',
      version: '1.0.0',
      description: 'HubSpot CRM',
      auth: { type: 'api_key' },
      triggers: [
        {
          name: 'new_contact',
          displayName: 'New Contact',
          description: 'New contact',
          triggerType: 'cron',
          props: [],
          onEnable: vi.fn().mockResolvedValue(undefined),
          onDisable: vi.fn().mockResolvedValue(undefined),
          run: vi.fn().mockResolvedValue([{ id: 'c1' }]),
        },
      ],
      actions: [],
    });

    const resolvedSteps = [{ id: 'step-1', type: 'http' }];
    const resolvedOutputMappings = { 'step-1.result': 'workflow.output.foo' };
    const resolvedNameToIdMap = { start: 'step-start', http: 'step-1' };

    const deps = makeDeps({
      registry,
      workflowResolver: {
        resolve: vi.fn().mockResolvedValue({
          workflowName: 'My Canvas Workflow',
          steps: resolvedSteps,
          outputMappings: resolvedOutputMappings,
          nameToIdMap: resolvedNameToIdMap,
        }),
      },
    });

    await processPollingJob(jobData, deps);

    expect(deps.restateClient.startWorkflow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        workflowName: 'My Canvas Workflow',
        steps: resolvedSteps,
        outputMappings: resolvedOutputMappings,
        nameToIdMap: resolvedNameToIdMap,
      }),
    );
  });

  it('updates cursor after successful poll', async () => {
    const registry = new ConnectorRegistry();
    registry.register({
      name: 'hubspot',
      displayName: 'HubSpot',
      version: '1.0.0',
      description: 'HubSpot CRM',
      auth: { type: 'api_key' },
      triggers: [
        {
          name: 'new_contact',
          displayName: 'New Contact',
          description: 'New contact',
          triggerType: 'cron',
          props: [],
          onEnable: vi.fn().mockResolvedValue(undefined),
          onDisable: vi.fn().mockResolvedValue(undefined),
          run: vi.fn().mockResolvedValue([{ id: 'c1', cursor: 'abc' }]),
        },
      ],
      actions: [],
    });

    const store = {
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    const deps = makeDeps({ registry, storeFactory: vi.fn().mockReturnValue(store) });

    await processPollingJob(jobData, deps);

    // Cursor should be set to the last item
    expect(store.set).toHaveBeenCalledWith('cursor:reg-1', { id: 'c1', cursor: 'abc' });
  });

  it('tracks consecutive errors on failure', async () => {
    const registry = new ConnectorRegistry();
    registry.register({
      name: 'hubspot',
      displayName: 'HubSpot',
      version: '1.0.0',
      description: 'HubSpot CRM',
      auth: { type: 'api_key' },
      triggers: [
        {
          name: 'new_contact',
          displayName: 'New Contact',
          description: 'Fails',
          triggerType: 'cron',
          props: [],
          onEnable: vi.fn().mockResolvedValue(undefined),
          onDisable: vi.fn().mockResolvedValue(undefined),
          run: vi.fn().mockRejectedValue(new Error('API error')),
        },
      ],
      actions: [],
    });

    const deps = makeDeps({ registry });

    await processPollingJob(jobData, deps);

    expect(deps.registrationModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'reg-1', tenantId: 't1' },
      expect.objectContaining({ $inc: { consecutiveErrors: 1 } }),
      { new: true },
    );
  });

  it('passes workflowVersionId to startWorkflow when present on registration', async () => {
    const registry = new ConnectorRegistry();
    registry.register({
      name: 'hubspot',
      displayName: 'HubSpot',
      version: '1.0.0',
      description: 'HubSpot CRM',
      auth: { type: 'api_key' },
      triggers: [
        {
          name: 'new_contact',
          displayName: 'New Contact',
          description: 'New contact',
          triggerType: 'cron',
          props: [],
          onEnable: vi.fn().mockResolvedValue(undefined),
          onDisable: vi.fn().mockResolvedValue(undefined),
          run: vi.fn().mockResolvedValue([{ id: 'c1' }]),
        },
      ],
      actions: [],
    });

    const store = {
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    const deps = makeDeps({
      registry,
      storeFactory: vi.fn().mockReturnValue(store),
      registrationModel: {
        findOne: vi.fn().mockResolvedValue(makeRegistration({ workflowVersionId: 'ver-1' })),
        findOneAndUpdate: vi.fn().mockResolvedValue(makeRegistration()),
      },
    });

    await processPollingJob(jobData, deps);

    expect(deps.restateClient.startWorkflow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        workflowId: 'wf-1',
        workflowVersionId: 'ver-1',
      }),
    );
  });

  it('omits workflowVersionId from startWorkflow when absent on registration', async () => {
    const registry = new ConnectorRegistry();
    registry.register({
      name: 'hubspot',
      displayName: 'HubSpot',
      version: '1.0.0',
      description: 'HubSpot CRM',
      auth: { type: 'api_key' },
      triggers: [
        {
          name: 'new_contact',
          displayName: 'New Contact',
          description: 'New contact',
          triggerType: 'cron',
          props: [],
          onEnable: vi.fn().mockResolvedValue(undefined),
          onDisable: vi.fn().mockResolvedValue(undefined),
          run: vi.fn().mockResolvedValue([{ id: 'c1' }]),
        },
      ],
      actions: [],
    });

    const store = {
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    const deps = makeDeps({ registry, storeFactory: vi.fn().mockReturnValue(store) });

    await processPollingJob(jobData, deps);

    const call = (deps.restateClient.startWorkflow as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1]).not.toHaveProperty('workflowVersionId');
  });
});

describe('registerPollingTrigger — version fields', () => {
  it('includes workflowVersionId and environment in BullMQ job data', async () => {
    const deps = makeDeps();

    await registerPollingTrigger(
      {
        _id: 'reg-1',
        tenantId: 't1',
        projectId: 'p1',
        connectorName: 'hubspot',
        triggerName: 'new_contact',
        connectionId: 'conn-1',
        workflowVersionId: 'ver-1',
        environment: 'staging',
      },
      deps,
    );

    expect(deps.queue.add).toHaveBeenCalledWith(
      'poll-trigger',
      expect.objectContaining({
        registrationId: 'reg-1',
        workflowVersionId: 'ver-1',
        environment: 'staging',
      }),
      expect.any(Object),
    );
  });

  it('omits version fields from BullMQ job data when absent', async () => {
    const deps = makeDeps();

    await registerPollingTrigger(
      {
        _id: 'reg-1',
        tenantId: 't1',
        projectId: 'p1',
        connectorName: 'hubspot',
        triggerName: 'new_contact',
        connectionId: 'conn-1',
      },
      deps,
    );

    const jobDataArg = (deps.queue.add as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(jobDataArg).not.toHaveProperty('workflowVersionId');
    expect(jobDataArg).not.toHaveProperty('environment');
  });
});
