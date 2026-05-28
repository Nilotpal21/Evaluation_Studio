import { describe, it, expect, vi } from 'vitest';
import {
  executeAgentInvocation,
  type AgentInvocationStep,
  type RuntimeClient,
} from '../executors/agent-invocation-executor.js';
import type { WorkflowContextData } from '../context/expression-resolver.js';

const ctx: WorkflowContextData = {
  trigger: {
    type: 'webhook',
    payload: { orderId: 'ORD-123', customerId: 'CUST-456' },
  },
  workflow: { id: 'wf-1', name: 'order-flow', executionId: 'exec-1' },
  tenant: { tenantId: 't1', projectId: 'p1' },
  steps: {
    'lookup-order': {
      output: { status: 'pending', amount: 99.5 },
      status: 'completed',
    },
  },
  vars: {},
};

function makeMockClient(): RuntimeClient {
  return {
    sendMessage: vi.fn().mockResolvedValue({
      sessionId: 'sess-abc',
      agentResponse: 'Order ORD-123 has been processed.',
      toolResults: [{ toolName: 'update_status', result: { success: true } }],
    }),
  };
}

describe('executeAgentInvocation', () => {
  it('resolves message expressions and invokes agent', async () => {
    const step: AgentInvocationStep = {
      id: 'step-1',
      type: 'agent_invocation',
      agentId: 'order-agent',
      message:
        'Process order {{trigger.payload.orderId}} for customer {{trigger.payload.customerId}}',
    };

    const client = makeMockClient();
    const result = await executeAgentInvocation(step, ctx, client);

    expect(result.sessionId).toBe('sess-abc');
    expect(result.agentResponse).toBe('Order ORD-123 has been processed.');
    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'order-agent',
        message: 'Process order ORD-123 for customer CUST-456',
        tenantId: 't1',
        projectId: 'p1',
        callerContext: { source: 'workflow', workflowExecutionId: 'exec-1' },
      }),
    );
  });

  it('passes sessionId when provided', async () => {
    const step: AgentInvocationStep = {
      id: 'step-2',
      type: 'agent_invocation',
      agentId: 'order-agent',
      message: 'Continue processing',
      sessionId: 'sess-existing',
    };

    const client = makeMockClient();
    await executeAgentInvocation(step, ctx, client);

    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-existing' }),
    );
  });

  it('uses custom timeout when specified', async () => {
    const step: AgentInvocationStep = {
      id: 'step-3',
      type: 'agent_invocation',
      agentId: 'order-agent',
      message: 'Quick check',
      timeout: 10_000,
    };

    const client = makeMockClient();
    await executeAgentInvocation(step, ctx, client);

    expect(client.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ timeout: 10_000 }));
  });

  it('uses default timeout when not specified', async () => {
    const step: AgentInvocationStep = {
      id: 'step-4',
      type: 'agent_invocation',
      agentId: 'order-agent',
      message: 'Check status',
    };

    const client = makeMockClient();
    await executeAgentInvocation(step, ctx, client);

    expect(client.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ timeout: 120_000 }));
  });

  it('propagates runtime client errors', async () => {
    const step: AgentInvocationStep = {
      id: 'step-5',
      type: 'agent_invocation',
      agentId: 'order-agent',
      message: 'Process',
    };

    const client: RuntimeClient = {
      sendMessage: vi.fn().mockRejectedValue(new Error('Agent not found')),
    };

    await expect(executeAgentInvocation(step, ctx, client)).rejects.toThrow('Agent not found');
  });
});
