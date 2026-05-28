import { describe, it, expect, vi } from 'vitest';
import {
  executeToolCall,
  type ToolCallStep,
  type ToolExecutionClient,
} from '../executors/tool-call-executor.js';
import type { WorkflowContextData } from '../context/expression-resolver.js';

const ctx: WorkflowContextData = {
  trigger: {
    type: 'webhook',
    payload: { orderId: 'ORD-123', quantity: 5 },
    metadata: { userId: 'user-123' },
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

function makeMockClient(): ToolExecutionClient {
  return {
    executeTool: vi.fn().mockResolvedValue({
      success: true,
      status: 'completed',
      output: { updated: true },
    }),
  };
}

describe('executeToolCall', () => {
  it('resolves param expressions and invokes tool', async () => {
    const step: ToolCallStep = {
      id: 'step-1',
      type: 'tool_call',
      toolName: 'update_order',
      params: {
        orderId: '{{trigger.payload.orderId}}',
        amount: '{{steps.lookup-order.output.amount}}',
      },
    };

    const client = makeMockClient();
    const result = await executeToolCall(step, ctx, client);

    expect(result.success).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ updated: true });
    expect(client.executeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'update_order',
        params: { orderId: 'ORD-123', amount: 99.5 },
        tenantId: 't1',
        projectId: 'p1',
        actorUserId: 'user-123',
      }),
    );
  });

  it('preserves typed values for single-expression params', async () => {
    const step: ToolCallStep = {
      id: 'step-2',
      type: 'tool_call',
      toolName: 'check_quantity',
      params: {
        quantity: '{{trigger.payload.quantity}}',
      },
    };

    const client = makeMockClient();
    await executeToolCall(step, ctx, client);

    const call = (client.executeTool as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.params.quantity).toBe(5);
    expect(typeof call.params.quantity).toBe('number');
  });

  it('passes through static typed params without string coercion', async () => {
    const step: ToolCallStep = {
      id: 'step-typed-static',
      type: 'tool_call',
      toolName: 'create_order',
      params: {
        status: 'approved',
        amount: 42,
        expedited: true,
        metadata: { source: 'migration' },
      },
    };

    const client = makeMockClient();
    await executeToolCall(step, ctx, client);

    expect(client.executeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        params: {
          status: 'approved',
          amount: 42,
          expedited: true,
          metadata: { source: 'migration' },
        },
      }),
    );
  });

  it('uses custom timeout when specified', async () => {
    const step: ToolCallStep = {
      id: 'step-3',
      type: 'tool_call',
      toolName: 'slow_tool',
      params: {},
      timeout: 15_000,
    };

    const client = makeMockClient();
    await executeToolCall(step, ctx, client);

    expect(client.executeTool).toHaveBeenCalledWith(expect.objectContaining({ timeout: 15_000 }));
  });

  it('uses default timeout when not specified', async () => {
    const step: ToolCallStep = {
      id: 'step-4',
      type: 'tool_call',
      toolName: 'fast_tool',
      params: {},
    };

    const client = makeMockClient();
    await executeToolCall(step, ctx, client);

    expect(client.executeTool).toHaveBeenCalledWith(expect.objectContaining({ timeout: 60_000 }));
  });

  it('propagates tool execution errors', async () => {
    const step: ToolCallStep = {
      id: 'step-5',
      type: 'tool_call',
      toolName: 'broken_tool',
      params: {},
    };

    const client: ToolExecutionClient = {
      executeTool: vi.fn().mockRejectedValue(new Error('Tool not found')),
    };

    await expect(executeToolCall(step, ctx, client)).rejects.toThrow('Tool not found');
  });

  it('returns error result from tool client', async () => {
    const step: ToolCallStep = {
      id: 'step-6',
      type: 'tool_call',
      toolName: 'failing_tool',
      params: {},
    };

    const client: ToolExecutionClient = {
      executeTool: vi.fn().mockResolvedValue({
        success: false,
        status: 'failed',
        error: { code: 'VALIDATION_ERROR', message: 'Invalid input' },
      }),
    };

    const result = await executeToolCall(step, ctx, client);
    expect(result.success).toBe(false);
    expect(result.error).toEqual({ code: 'VALIDATION_ERROR', message: 'Invalid input' });
  });

  it('falls back to trigger metadata triggeredBy when userId is absent', async () => {
    const step: ToolCallStep = {
      id: 'step-7',
      type: 'tool_call',
      toolName: 'fallback_actor_tool',
      params: {},
    };

    const client = makeMockClient();
    const triggeredByCtx: WorkflowContextData = {
      ...ctx,
      trigger: {
        ...ctx.trigger,
        metadata: { triggeredBy: 'user-456' },
      },
    };

    await executeToolCall(step, triggeredByCtx, client);

    expect(client.executeTool).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: 'user-456' }),
    );
  });
});
