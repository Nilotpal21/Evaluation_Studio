import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockWorkflowExecutionDeleteMany, mockHumanTaskDeleteMany, mockWorkflowOutboxDeleteMany } =
  vi.hoisted(() => ({
    mockWorkflowExecutionDeleteMany: vi.fn(),
    mockHumanTaskDeleteMany: vi.fn(),
    mockWorkflowOutboxDeleteMany: vi.fn(),
  }));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@agent-platform/database/models', () => ({
  WorkflowExecution: {
    deleteMany: (...args: unknown[]) => mockWorkflowExecutionDeleteMany(...args),
  },
  HumanTask: {
    deleteMany: (...args: unknown[]) => mockHumanTaskDeleteMany(...args),
  },
  WorkflowEventOutboxModel: {
    deleteMany: (...args: unknown[]) => mockWorkflowOutboxDeleteMany(...args),
  },
}));

import { cascadeWorkflowByExecutionIds, cascadeWorkflowTenant } from '../workflow-cascade-hook.js';

describe('cascadeWorkflowByExecutionIds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkflowExecutionDeleteMany.mockResolvedValue({ deletedCount: 2 });
    mockHumanTaskDeleteMany.mockResolvedValue({ deletedCount: 2 });
    mockWorkflowOutboxDeleteMany.mockResolvedValue({ deletedCount: 2 });
  });

  it('cleans nested human-task execution ids and both workflow outbox entity families', async () => {
    const chClient = { command: vi.fn().mockResolvedValue(undefined) };

    await cascadeWorkflowByExecutionIds({ chClient: chClient as never }, 'tenant-1', [
      'exec-1',
      'exec-2',
    ]);

    expect(mockWorkflowExecutionDeleteMany).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      _id: { $in: ['exec-1', 'exec-2'] },
    });
    expect(mockHumanTaskDeleteMany).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      mailbox: 'workflow',
      'source.executionId': { $in: ['exec-1', 'exec-2'] },
    });
    expect(mockWorkflowOutboxDeleteMany).toHaveBeenNthCalledWith(1, {
      tenantId: 'tenant-1',
      entityKind: 'workflow_execution',
      entityId: { $in: ['exec-1', 'exec-2'] },
    });
    expect(mockWorkflowOutboxDeleteMany).toHaveBeenNthCalledWith(2, {
      tenantId: 'tenant-1',
      entityKind: 'human_task',
      'payload.execution_id': { $in: ['exec-1', 'exec-2'] },
    });
    for (const call of chClient.command.mock.calls) {
      expect(call[0].query).toContain('SETTINGS mutations_sync = 1');
    }
  });

  it('waits for tenant-wide ClickHouse cascade mutations', async () => {
    const chClient = { command: vi.fn().mockResolvedValue(undefined) };

    await cascadeWorkflowTenant({ chClient: chClient as never }, 'tenant-1');

    expect(chClient.command).toHaveBeenCalledTimes(4);
    for (const call of chClient.command.mock.calls) {
      expect(call[0].query).toContain('SETTINGS mutations_sync = 1');
    }
  });
});
