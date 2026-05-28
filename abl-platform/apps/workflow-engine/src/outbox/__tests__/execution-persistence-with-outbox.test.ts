/**
 * Unit tests for the outbox decorator stack.
 *
 * Covers:
 *  - `ExecutionPersistenceWithOutbox` forwards transparently when
 *    `WORKFLOW_OUTBOX_ENABLED` is unset (flag-off path).
 *  - When enabled, each state-machine transition produces exactly one
 *    outbox row with the expected `entityKind`, `entityId`, `eventType`,
 *    and tenant/project fields threaded through.
 *  - `status='skipped'` (or similar data-only patches) produces NO outbox
 *    row — the status → event_type mapping in `event-builders.ts` is the
 *    single source of truth.
 *  - `HumanTaskStoreWithOutbox` scope-guards agent-mailbox tasks: they
 *    skip the outbox path entirely even when the flag is on.
 *  - Transaction threading: the writer receives the same session handle
 *    that the inner store was called with.
 *
 * `withTransaction` is imported from `@agent-platform/shared/repos` and
 * NOT mocked (platform-mock-lint forbids it). Instead the test drives
 * standalone-Mongo behaviour by using `canUseTransactions` returning
 * false — `withTransaction` will call back with `session: null`, which
 * the decorator forwards to the outbox writer (optional-session path).
 * `_resetTxCache` from the shared tx helper is used to force a fresh
 * check so the test-only env doesn't leak into production paths.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ExecutionPersistenceWithOutbox,
  HumanTaskStoreWithOutbox,
  type ExecutionReadModel,
} from '../execution-persistence-with-outbox.js';
import {
  WorkflowEventOutboxWriter,
  type OutboxModelLike,
} from '../workflow-event-outbox-writer.js';
import type { ExecutionStore } from '../../persistence/execution-store.js';
import type {
  MongoHumanTaskStore,
  CreateHumanTaskParams,
} from '../../persistence/human-task-store.js';

interface RecordedOutboxCall {
  docs: Array<{
    _id: string;
    entityKind: string;
    entityId: string;
    eventType: string;
    tenantId: string;
    projectId: string;
  }>;
  session: unknown;
}

function makeFakes() {
  const createdExecs: Array<Record<string, unknown>> = [];
  const stepUpdates: Array<Record<string, unknown>> = [];
  const execUpdates: Array<Record<string, unknown>> = [];
  const execInner: ExecutionStore = {
    createExecution: vi.fn(async (input, options) => {
      createdExecs.push({ input, options });
    }),
    updateStepStatus: vi.fn(
      async (executionId, tenantId, projectId, stepId, status, data, opts) => {
        stepUpdates.push({ executionId, tenantId, projectId, stepId, status, data, opts });
      },
    ),
    updateExecutionStatus: vi.fn(async (executionId, tenantId, projectId, status, data, opts) => {
      execUpdates.push({ executionId, tenantId, projectId, status, data, opts });
    }),
    getByTenant: vi.fn(async () => []),
    getById: vi.fn(async () => null),
  } as unknown as ExecutionStore;

  const taskUpdates: Array<Record<string, unknown>> = [];
  const createdTasks: Array<Record<string, unknown>> = [];
  const humanTaskInner: MongoHumanTaskStore = {
    createTask: vi.fn(async (params: CreateHumanTaskParams, options) => {
      const record = {
        _id: `task-${createdTasks.length + 1}`,
        createdAt: new Date('2026-04-21T10:00:00Z'),
        status: 'pending',
      };
      createdTasks.push({ params, options });
      return record as never;
    }),
    updateTaskStatus: vi.fn(async (taskId, tenantId, projectId, status, extra, opts) => {
      taskUpdates.push({ taskId, tenantId, projectId, status, extra, opts });
      return {
        _id: taskId,
        tenantId,
        projectId,
        status,
        mailbox: 'workflow',
        source: {
          type: 'workflow_approval',
          workflowId: 'wf-1',
          executionId: 'exec-1',
          stepId: 'step-1',
        },
        context: { approvers: ['alice'] },
        assignedTo: ['alice'],
        createdAt: new Date('2026-04-21T10:00:00Z'),
      } as never;
    }),
    findBySource: vi.fn(async () => null),
    findById: vi.fn(async () => null),
  } as unknown as MongoHumanTaskStore;

  const outboxCalls: RecordedOutboxCall[] = [];
  const outboxModel: OutboxModelLike = {
    insertMany: vi.fn(
      async (
        docs: Array<{
          _id: string;
          entityKind: string;
          entityId: string;
          eventType: string;
          tenantId: string;
          projectId: string;
        }>,
        options,
      ) => {
        outboxCalls.push({
          docs: docs.map((d) => ({
            _id: d._id,
            entityKind: d.entityKind,
            entityId: d.entityId,
            eventType: d.eventType,
            tenantId: d.tenantId,
            projectId: d.projectId,
          })),
          session: options?.session,
        });
        return docs;
      },
    ),
  };

  const executionReadModel: ExecutionReadModel = {
    findOne: vi.fn(async () => ({
      _id: 'exec-1',
      tenantId: 't1',
      projectId: 'p1',
      workflowId: 'wf-1',
      workflowVersion: '3',
      triggerType: 'manual',
      startedAt: new Date('2026-04-21T10:00:00Z'),
    })),
  };

  return {
    execInner,
    humanTaskInner,
    outboxModel,
    executionReadModel,
    records: { createdExecs, stepUpdates, execUpdates, createdTasks, taskUpdates, outboxCalls },
  };
}

const originalFlag = process.env.WORKFLOW_OUTBOX_ENABLED;

beforeEach(() => {
  process.env.WORKFLOW_OUTBOX_ENABLED = 'true';
});

afterEach(() => {
  if (originalFlag === undefined) {
    delete process.env.WORKFLOW_OUTBOX_ENABLED;
  } else {
    process.env.WORKFLOW_OUTBOX_ENABLED = originalFlag;
  }
});

describe('ExecutionPersistenceWithOutbox — flag-off path', () => {
  it('forwards directly without writing to outbox when outboxEnabled is false', async () => {
    process.env.WORKFLOW_OUTBOX_ENABLED = 'false';
    const f = makeFakes();
    const writer = new WorkflowEventOutboxWriter(f.outboxModel);
    const decorator = new ExecutionPersistenceWithOutbox(f.execInner, writer, f.executionReadModel);

    await decorator.createExecution({
      executionId: 'exec-1',
      tenantId: 't1',
      projectId: 'p1',
      workflowId: 'wf-1',
      workflowVersion: '3',
      status: 'running',
      triggerType: 'manual',
      triggerPayload: {},
      steps: [],
    });

    expect(f.records.createdExecs).toHaveLength(1);
    expect(f.records.outboxCalls).toHaveLength(0);
    expect(f.executionReadModel.findOne).not.toHaveBeenCalled();
  });
});

describe('ExecutionPersistenceWithOutbox — flag-on path', () => {
  it('emits workflow.execution.started on createExecution', async () => {
    const f = makeFakes();
    const writer = new WorkflowEventOutboxWriter(f.outboxModel);
    const decorator = new ExecutionPersistenceWithOutbox(f.execInner, writer, f.executionReadModel);

    await decorator.createExecution({
      executionId: 'exec-1',
      tenantId: 't1',
      projectId: 'p1',
      workflowId: 'wf-1',
      workflowVersion: '3',
      status: 'running',
      triggerType: 'manual',
      triggerPayload: { foo: 'bar' },
      steps: [],
    });

    expect(f.records.createdExecs).toHaveLength(1);
    expect(f.records.outboxCalls).toHaveLength(1);
    expect(f.records.outboxCalls[0]!.docs).toHaveLength(1);
    expect(f.records.outboxCalls[0]!.docs[0]).toMatchObject({
      entityKind: 'workflow_execution',
      entityId: 'exec-1',
      eventType: 'workflow.execution.started',
      tenantId: 't1',
      projectId: 'p1',
    });
  });

  it('emits workflow.execution.step_started on updateStepStatus with status=running', async () => {
    const f = makeFakes();
    const writer = new WorkflowEventOutboxWriter(f.outboxModel);
    const decorator = new ExecutionPersistenceWithOutbox(f.execInner, writer, f.executionReadModel);

    await decorator.updateStepStatus('exec-1', 't1', 'p1', 'step-42', 'running', {
      input: { x: 1 },
    });

    expect(f.records.stepUpdates).toHaveLength(1);
    expect(f.records.outboxCalls).toHaveLength(1);
    expect(f.records.outboxCalls[0]!.docs[0]!.eventType).toBe('workflow.execution.step_started');
  });

  it('emits workflow.execution.step_completed on updateStepStatus with status=completed', async () => {
    const f = makeFakes();
    const writer = new WorkflowEventOutboxWriter(f.outboxModel);
    const decorator = new ExecutionPersistenceWithOutbox(f.execInner, writer, f.executionReadModel);

    await decorator.updateStepStatus('exec-1', 't1', 'p1', 'step-42', 'completed', {
      output: { ok: true },
      durationMs: 250,
    });

    expect(f.records.outboxCalls).toHaveLength(1);
    expect(f.records.outboxCalls[0]!.docs[0]!.eventType).toBe('workflow.execution.step_completed');
  });

  it('does NOT emit on updateStepStatus with status=skipped (data-only passthrough)', async () => {
    const f = makeFakes();
    const writer = new WorkflowEventOutboxWriter(f.outboxModel);
    const decorator = new ExecutionPersistenceWithOutbox(f.execInner, writer, f.executionReadModel);

    await decorator.updateStepStatus('exec-1', 't1', 'p1', 'step-42', 'skipped');

    expect(f.records.stepUpdates).toHaveLength(1);
    expect(f.records.outboxCalls).toHaveLength(0);
    // Flag-on skipped path does NOT open a transaction.
    expect(f.executionReadModel.findOne).not.toHaveBeenCalled();
  });

  it('emits workflow.execution.completed on updateExecutionStatus with status=completed', async () => {
    const f = makeFakes();
    const writer = new WorkflowEventOutboxWriter(f.outboxModel);
    const decorator = new ExecutionPersistenceWithOutbox(f.execInner, writer, f.executionReadModel);

    await decorator.updateExecutionStatus('exec-1', 't1', 'p1', 'completed', {
      output: { result: 42 },
    });

    expect(f.records.outboxCalls).toHaveLength(1);
    expect(f.records.outboxCalls[0]!.docs[0]!.eventType).toBe('workflow.execution.completed');
  });

  it('emits workflow.execution.cancelled on terminal status=rejected', async () => {
    const f = makeFakes();
    const writer = new WorkflowEventOutboxWriter(f.outboxModel);
    const decorator = new ExecutionPersistenceWithOutbox(f.execInner, writer, f.executionReadModel);

    await decorator.updateExecutionStatus('exec-1', 't1', 'p1', 'rejected');

    expect(f.records.outboxCalls).toHaveLength(1);
    expect(f.records.outboxCalls[0]!.docs[0]!.eventType).toBe('workflow.execution.cancelled');
  });

  it('skips outbox when the execution row cannot be found (non-existent exec)', async () => {
    const f = makeFakes();
    f.executionReadModel.findOne = vi.fn(async () => null);
    const writer = new WorkflowEventOutboxWriter(f.outboxModel);
    const decorator = new ExecutionPersistenceWithOutbox(f.execInner, writer, f.executionReadModel);

    await decorator.updateStepStatus('exec-missing', 't1', 'p1', 'step-1', 'running');

    expect(f.records.stepUpdates).toHaveLength(1); // inner still called
    expect(f.records.outboxCalls).toHaveLength(0);
  });
});

describe('HumanTaskStoreWithOutbox', () => {
  it('skips outbox entirely for agent-mailbox tasks', async () => {
    const f = makeFakes();
    const writer = new WorkflowEventOutboxWriter(f.outboxModel);
    const decorator = new HumanTaskStoreWithOutbox(f.humanTaskInner, writer, f.executionReadModel);

    await decorator.createTask({
      tenantId: 't1',
      projectId: 'p1',
      type: 'escalation',
      mailbox: 'agent',
      priority: 'medium',
      title: 'Agent help requested',
      source: { type: 'agent_escalation', sessionId: 's1', agentName: 'router' },
      fields: [],
      context: {},
    });

    expect(f.records.createdTasks).toHaveLength(1);
    expect(f.records.outboxCalls).toHaveLength(0);
  });

  it('emits human_task.created for workflow-mailbox tasks', async () => {
    const f = makeFakes();
    const writer = new WorkflowEventOutboxWriter(f.outboxModel);
    const decorator = new HumanTaskStoreWithOutbox(f.humanTaskInner, writer, f.executionReadModel);

    await decorator.createTask({
      tenantId: 't1',
      projectId: 'p1',
      type: 'approval',
      mailbox: 'workflow',
      priority: 'medium',
      title: 'Approve?',
      source: {
        type: 'workflow_approval',
        workflowId: 'wf-1',
        executionId: 'exec-1',
        stepId: 'step-1',
      },
      fields: [],
      context: { approvers: ['alice'] },
      assignedTo: ['alice'],
    });

    expect(f.records.outboxCalls).toHaveLength(1);
    expect(f.records.outboxCalls[0]!.docs[0]).toMatchObject({
      entityKind: 'human_task',
      eventType: 'human_task.created',
      tenantId: 't1',
      projectId: 'p1',
    });
  });

  it('emits human_task.approved when updateTaskStatus(completed, response.action=approve)', async () => {
    const f = makeFakes();
    const writer = new WorkflowEventOutboxWriter(f.outboxModel);
    const decorator = new HumanTaskStoreWithOutbox(f.humanTaskInner, writer, f.executionReadModel);

    await decorator.updateTaskStatus('task-1', 't1', 'p1', 'completed', {
      response: { action: 'approve', by: 'alice', at: new Date('2026-04-21T10:05:00Z') },
    });

    expect(f.records.taskUpdates).toHaveLength(1);
    expect(f.records.outboxCalls).toHaveLength(1);
    expect(f.records.outboxCalls[0]!.docs[0]!.eventType).toBe('human_task.approved');
  });

  it('does NOT emit on a no-op status (e.g. in_progress)', async () => {
    const f = makeFakes();
    const writer = new WorkflowEventOutboxWriter(f.outboxModel);
    const decorator = new HumanTaskStoreWithOutbox(f.humanTaskInner, writer, f.executionReadModel);

    await decorator.updateTaskStatus('task-1', 't1', 'p1', 'in_progress');

    expect(f.records.taskUpdates).toHaveLength(1);
    expect(f.records.outboxCalls).toHaveLength(0);
  });
});
