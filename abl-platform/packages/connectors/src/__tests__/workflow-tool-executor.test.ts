import { describe, it, expect, vi } from 'vitest';
import {
  WorkflowToolExecutor,
  type WorkflowClient,
  type WorkflowHandle,
} from '../executor/workflow-tool-executor.js';

function makeMockClient(
  resultOverrides: Partial<Awaited<ReturnType<WorkflowHandle['result']>>> = {},
): WorkflowClient {
  const handle: WorkflowHandle = {
    result: vi.fn().mockResolvedValue({
      status: 'completed',
      context: {
        steps: { 'step-1': { output: { refundId: 're_123' } } },
      },
      ...resultOverrides,
    }),
  };

  return {
    submit: vi.fn().mockResolvedValue(handle),
  };
}

describe('WorkflowToolExecutor', () => {
  it('sync mode: starts workflow and waits for result', async () => {
    const client = makeMockClient();
    const executor = new WorkflowToolExecutor(client, {
      tenantId: 't-1',
      projectId: 'p-1',
    });

    executor.registerBinding('process_refund', {
      workflowId: 'wf-refund',
      mode: 'sync',
      paramMapping: { order_id: 'orderId', amount: 'amount' },
      timeoutMs: 30_000,
    });

    const result = await executor.execute(
      'process_refund',
      { order_id: 'ORD-1', amount: 50 },
      30_000,
    );

    expect(result.status).toBe('completed');
    expect(result.output).toBeDefined();
    expect(result.executionId).toBeDefined();
    expect(client.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: 'wf-refund',
        tenantId: 't-1',
        projectId: 'p-1',
        triggerType: 'agent',
        triggerPayload: { orderId: 'ORD-1', amount: 50 },
      }),
    );
  });

  it('async mode: returns executionId immediately', async () => {
    const client = makeMockClient();
    const executor = new WorkflowToolExecutor(client, {
      tenantId: 't-1',
      projectId: 'p-1',
    });

    executor.registerBinding('long_process', {
      workflowId: 'wf-long',
      mode: 'async',
      paramMapping: {},
    });

    const result = await executor.execute('long_process', {}, 30_000);

    expect(result.status).toBe('submitted');
    expect(result.executionId).toBeDefined();
    // In async mode, handle.result() should NOT be called
    const handle = await (client.submit as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(handle.result).not.toHaveBeenCalled();
  });

  it('throws on unknown workflow binding', async () => {
    const client = makeMockClient();
    const executor = new WorkflowToolExecutor(client, {
      tenantId: 't-1',
      projectId: 'p-1',
    });

    await expect(executor.execute('unknown', {}, 30_000)).rejects.toThrow(
      'No workflow binding registered for tool: unknown',
    );
  });

  it('maps tool params to workflow trigger payload using paramMapping', async () => {
    const client = makeMockClient();
    const executor = new WorkflowToolExecutor(client, {
      tenantId: 't-1',
      projectId: 'p-1',
    });

    executor.registerBinding('create_ticket', {
      workflowId: 'wf-ticket',
      mode: 'sync',
      paramMapping: {
        title: 'ticketTitle',
        priority: 'ticketPriority',
        assigned_to: 'assignee',
      },
    });

    await executor.execute(
      'create_ticket',
      { title: 'Bug report', priority: 'high', assigned_to: 'alice' },
      30_000,
    );

    expect(client.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerPayload: {
          ticketTitle: 'Bug report',
          ticketPriority: 'high',
          assignee: 'alice',
        },
      }),
    );
  });

  it('uses binding timeoutMs for sync mode result wait', async () => {
    const handle: WorkflowHandle = {
      result: vi.fn().mockResolvedValue({ status: 'completed', context: {} }),
    };
    const client: WorkflowClient = {
      submit: vi.fn().mockResolvedValue(handle),
    };

    const executor = new WorkflowToolExecutor(client, {
      tenantId: 't-1',
      projectId: 'p-1',
    });

    executor.registerBinding('quick_task', {
      workflowId: 'wf-quick',
      mode: 'sync',
      paramMapping: {},
      timeoutMs: 5_000,
    });

    await executor.execute('quick_task', {}, 30_000);

    expect(handle.result).toHaveBeenCalledWith({ timeout: 5_000 });
  });

  it('falls back to execute timeoutMs when binding has no timeoutMs', async () => {
    const handle: WorkflowHandle = {
      result: vi.fn().mockResolvedValue({ status: 'completed', context: {} }),
    };
    const client: WorkflowClient = {
      submit: vi.fn().mockResolvedValue(handle),
    };

    const executor = new WorkflowToolExecutor(client, {
      tenantId: 't-1',
      projectId: 'p-1',
    });

    executor.registerBinding('no_timeout_task', {
      workflowId: 'wf-no-timeout',
      mode: 'sync',
      paramMapping: {},
    });

    await executor.execute('no_timeout_task', {}, 15_000);

    expect(handle.result).toHaveBeenCalledWith({ timeout: 15_000 });
  });

  it('propagates failed workflow status', async () => {
    const client = makeMockClient({
      status: 'failed',
      error: 'Step failed: payment declined',
    });
    const executor = new WorkflowToolExecutor(client, {
      tenantId: 't-1',
      projectId: 'p-1',
    });

    executor.registerBinding('failing_workflow', {
      workflowId: 'wf-fail',
      mode: 'sync',
      paramMapping: {},
    });

    const result = await executor.execute('failing_workflow', {}, 30_000);

    expect(result.status).toBe('failed');
    expect(result.error).toBe('Step failed: payment declined');
  });
});
