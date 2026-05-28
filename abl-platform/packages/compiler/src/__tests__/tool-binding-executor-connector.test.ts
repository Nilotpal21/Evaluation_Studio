import { describe, it, expect, vi } from 'vitest';
import { ToolBindingExecutor } from '../platform/constructs/executors/tool-binding-executor.js';
import type { ToolDefinition } from '../platform/ir/schema.js';
import type { ToolExecutor } from '../platform/constructs/types.js';

function makeConnectorTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'slack.send_message',
    description: 'Send a Slack message',
    parameters: [],
    returns: { type: 'object' },
    hints: { cacheable: false, latency: 'medium', parallelizable: false },
    tool_type: 'connector',
    connector_binding: { connector: 'slack', action: 'send_message' },
    ...overrides,
  };
}

function makeWorkflowTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'process_refund',
    description: 'Process a refund via workflow',
    parameters: [],
    returns: { type: 'object' },
    hints: { cacheable: false, latency: 'slow', parallelizable: false },
    tool_type: 'workflow',
    workflow_binding: {
      workflowId: 'wf-refund',
      triggerId: 'trigger-refund-1',
      mode: 'sync',
      paramMapping: { order_id: 'orderId' },
      timeoutMs: 30_000,
    },
    ...overrides,
  };
}

function makeMockExecutor(result: unknown = { ok: true }): ToolExecutor {
  return {
    execute: vi.fn().mockResolvedValue(result),
  };
}

const noopSecrets = {
  get: vi.fn().mockResolvedValue(undefined),
  getOrThrow: vi.fn().mockRejectedValue(new Error('not found')),
};

describe('ToolBindingExecutor: connector and workflow dispatch', () => {
  it('routes connector tool_type to connectorToolExecutor', async () => {
    const connectorExecutor = makeMockExecutor({ messageId: 'msg-1' });
    const executor = new ToolBindingExecutor({
      tools: [makeConnectorTool()],
      secrets: noopSecrets,
      connectorToolExecutor: connectorExecutor,
    });

    const result = await executor.execute(
      'slack.send_message',
      { channel: '#general', text: 'hello' },
      30_000,
    );

    expect(result).toEqual({ messageId: 'msg-1' });
    expect(connectorExecutor.execute).toHaveBeenCalledWith(
      'slack.send_message',
      { channel: '#general', text: 'hello' },
      30_000,
    );
  });

  it('routes workflow tool_type to workflowToolExecutor', async () => {
    const workflowExecutor = makeMockExecutor({ executionId: 'exec-1', status: 'completed' });
    const executor = new ToolBindingExecutor({
      tools: [makeWorkflowTool()],
      secrets: noopSecrets,
      workflowToolExecutor: workflowExecutor,
    });

    const result = await executor.execute(
      'process_refund',
      { order_id: 'ORD-1', amount: 50 },
      30_000,
    );

    expect(result).toEqual({ executionId: 'exec-1', status: 'completed' });
    expect(workflowExecutor.execute).toHaveBeenCalledWith(
      'process_refund',
      { order_id: 'ORD-1', amount: 50 },
      30_000,
    );
  });

  it('throws when connector tool_type used without connectorToolExecutor', async () => {
    const executor = new ToolBindingExecutor({
      tools: [makeConnectorTool()],
      secrets: noopSecrets,
    });

    await expect(executor.execute('slack.send_message', {}, 30_000)).rejects.toThrow(
      'ConnectorToolExecutor not initialized',
    );
  });

  it('throws when workflow tool_type used without workflowToolExecutor', async () => {
    const executor = new ToolBindingExecutor({
      tools: [makeWorkflowTool()],
      secrets: noopSecrets,
    });

    await expect(executor.execute('process_refund', {}, 30_000)).rejects.toThrow(
      'WorkflowToolExecutor not initialized',
    );
  });

  it('respects per-tool timeout for connector tools', async () => {
    const connectorExecutor = makeMockExecutor({ ok: true });
    const toolWithTimeout = makeConnectorTool({
      hints: { cacheable: false, latency: 'medium', parallelizable: false, timeout: 5_000 },
    });

    const executor = new ToolBindingExecutor({
      tools: [toolWithTimeout],
      secrets: noopSecrets,
      connectorToolExecutor: connectorExecutor,
    });

    await executor.execute('slack.send_message', {}, 30_000);

    // Should use the smaller of tool timeout (5000) and global timeout (30000)
    expect(connectorExecutor.execute).toHaveBeenCalledWith('slack.send_message', {}, 5_000);
  });
});
