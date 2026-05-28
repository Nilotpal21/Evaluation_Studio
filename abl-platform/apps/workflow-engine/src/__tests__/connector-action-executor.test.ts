import { describe, it, expect, vi } from 'vitest';
import {
  executeConnectorAction,
  type ConnectorActionStep,
  type ConnectorActionDeps,
} from '../executors/connector-action-executor.js';
import type { WorkflowContextData } from '../context/expression-resolver.js';

const ctx: WorkflowContextData = {
  trigger: {
    type: 'webhook',
    payload: { channel: '#general', message: 'Hello from workflow' },
  },
  workflow: { id: 'wf-1', name: 'test', executionId: 'exec-1' },
  tenant: { tenantId: 't1', projectId: 'p1' },
  steps: {
    'prev-step': {
      output: { userId: 'U-123' },
      status: 'completed',
    },
  },
  vars: {},
};

function makeMockDeps(result: unknown = { messageId: 'msg-1' }): ConnectorActionDeps {
  return {
    connectorToolExecutor: {
      execute: vi.fn().mockResolvedValue(result),
    } as unknown as ConnectorActionDeps['connectorToolExecutor'],
  };
}

describe('executeConnectorAction', () => {
  it('resolves expressions in params and calls executor', async () => {
    const step: ConnectorActionStep = {
      id: 'step-1',
      type: 'connector_action',
      connector: 'slack',
      action: 'send_message',
      params: {
        channel: '{{trigger.payload.channel}}',
        text: '{{trigger.payload.message}}',
      },
    };

    const deps = makeMockDeps();
    const result = await executeConnectorAction(step, ctx, deps);

    expect(result).toEqual({ messageId: 'msg-1' });
    expect(deps.connectorToolExecutor.execute).toHaveBeenCalledWith(
      'slack.send_message',
      { channel: '#general', text: 'Hello from workflow' },
      60_000,
      undefined,
    );
  });

  it('resolves step output references in params', async () => {
    const step: ConnectorActionStep = {
      id: 'step-2',
      type: 'connector_action',
      connector: 'slack',
      action: 'send_dm',
      params: {
        userId: '{{steps.prev-step.output.userId}}',
        text: 'Hello {{steps.prev-step.output.userId}}',
      },
    };

    const deps = makeMockDeps();
    await executeConnectorAction(step, ctx, deps);

    expect(deps.connectorToolExecutor.execute).toHaveBeenCalledWith(
      'slack.send_dm',
      { userId: 'U-123', text: 'Hello U-123' },
      60_000,
      undefined,
    );
  });

  it('uses custom timeout when specified', async () => {
    const step: ConnectorActionStep = {
      id: 'step-3',
      type: 'connector_action',
      connector: 'slack',
      action: 'send_message',
      params: { channel: '#general' },
      timeout: 5_000,
    };

    const deps = makeMockDeps();
    await executeConnectorAction(step, ctx, deps);

    expect(deps.connectorToolExecutor.execute).toHaveBeenCalledWith(
      'slack.send_message',
      { channel: '#general' },
      5_000,
      undefined,
    );
  });

  it('propagates executor errors', async () => {
    const step: ConnectorActionStep = {
      id: 'step-4',
      type: 'connector_action',
      connector: 'slack',
      action: 'send_message',
      params: { channel: '#general' },
    };

    const deps: ConnectorActionDeps = {
      connectorToolExecutor: {
        execute: vi.fn().mockRejectedValue(new Error('Connection refused')),
      } as unknown as ConnectorActionDeps['connectorToolExecutor'],
    };

    await expect(executeConnectorAction(step, ctx, deps)).rejects.toThrow('Connection refused');
  });
});
