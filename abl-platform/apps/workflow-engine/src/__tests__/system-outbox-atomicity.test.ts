/**
 * INT-01 — Outbox + Domain write are committed atomically (LLD §3, test-spec).
 *
 * Spins up a MongoMemoryReplSet (transactions require a replica set) and
 * exercises the full decorator stack (`ExecutionPersistenceWithOutbox` +
 * `WorkflowEventOutboxWriter`) against the real Mongoose models
 * (`WorkflowExecution` + `WorkflowEventOutboxModel`).
 *
 * Assertions
 * ----------
 *  1. Happy path — a successful `createExecution` persists BOTH the
 *     execution row and a `workflow.execution.started` outbox row
 *     (same `tenantId`, `projectId`, and `entityId === executionId`).
 *  2. Abort path — if the outbox write throws inside the transaction,
 *     `withTransaction` aborts and the execution row is NOT persisted.
 *     The write is tested by injecting an `insertMany`-throwing stub
 *     into the writer so the domain write does succeed in isolation
 *     but the overall transaction fails.
 *  3. Flag-off path — with `WORKFLOW_OUTBOX_ENABLED` unset, the
 *     decorator forwards directly and no outbox row is created even
 *     when the decorator stack is present.
 *
 * This test lives in the `system-*` glob (vitest.system.config.ts) —
 * it boots an in-process replica set which takes a few seconds to start.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { WorkflowExecution, WorkflowEventOutboxModel } from '@agent-platform/database/models';
import { _resetTxCache } from '@agent-platform/shared/repos';
import { ExecutionStore } from '../persistence/execution-store.js';
import { ExecutionPersistenceWithOutbox } from '../outbox/execution-persistence-with-outbox.js';
import {
  WorkflowEventOutboxWriter,
  type OutboxModelLike,
  type WorkflowEventOutboxDoc,
} from '../outbox/workflow-event-outbox-writer.js';

let replSet: MongoMemoryReplSet | undefined;
let replSetAvailable = false;

const REPL_LAUNCH_TIMEOUT_MS = 60_000;

const originalFlag = process.env.WORKFLOW_OUTBOX_ENABLED;

beforeAll(async () => {
  mongoose.set('bufferTimeoutMS', 60_000);
  try {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1 },
      binary: { version: process.env.MONGOMS_VERSION || '7.0.20' },
      instanceOpts: [{ launchTimeout: REPL_LAUNCH_TIMEOUT_MS }],
    });
    await mongoose.connect(replSet.getUri(), { directConnection: false });
    await mongoose.connection.asPromise();
    await mongoose.connection.syncIndexes();
    replSetAvailable = true;
  } catch (err) {
    console.warn('[INT-01] MongoMemoryReplSet unavailable — test will skip', err);
    replSetAvailable = false;
  }
}, REPL_LAUNCH_TIMEOUT_MS + 10_000);

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (replSet) {
    await replSet.stop();
  }
});

beforeEach(async () => {
  if (!replSetAvailable) return;
  // _resetTxCache so the withTransaction helper re-checks the replica-set
  // detection at the start of each test — previous tests may have set
  // it to `false` under a standalone server.
  _resetTxCache();
  process.env.WORKFLOW_OUTBOX_ENABLED = 'true';
  await WorkflowExecution.deleteMany({});
  await WorkflowEventOutboxModel.deleteMany({});
});

afterEach(() => {
  if (originalFlag === undefined) {
    delete process.env.WORKFLOW_OUTBOX_ENABLED;
  } else {
    process.env.WORKFLOW_OUTBOX_ENABLED = originalFlag;
  }
});

function buildDecorator(opts: { outboxOverride?: OutboxModelLike } = {}) {
  const exec = new ExecutionStore(WorkflowExecution as unknown as never);
  const outboxModel: OutboxModelLike =
    opts.outboxOverride ?? (WorkflowEventOutboxModel as unknown as OutboxModelLike);
  const writer = new WorkflowEventOutboxWriter(outboxModel);
  const readModel = {
    findOne: async (filter: Record<string, unknown>, options?: Record<string, unknown>) =>
      (
        WorkflowExecution as unknown as {
          findOne: (
            filter: Record<string, unknown>,
            options?: Record<string, unknown>,
          ) => Promise<unknown>;
        }
      ).findOne(filter, options ?? undefined),
  };
  return new ExecutionPersistenceWithOutbox(exec, writer, readModel);
}

describe('INT-01 — outbox + domain atomicity', () => {
  it('[happy path] createExecution persists the execution row AND an outbox row', async ({
    skip,
  }) => {
    if (!replSetAvailable) return skip('MongoMemoryReplSet unavailable');

    const decorator = buildDecorator();
    await decorator.createExecution({
      executionId: 'exec-happy',
      tenantId: 't1',
      projectId: 'p1',
      workflowId: 'wf-1',
      workflowVersion: '7',
      status: 'running',
      triggerType: 'manual',
      triggerPayload: { foo: 'bar' },
      steps: [{ stepId: 's1', name: 'Step 1', type: 'http', status: 'pending' }],
    });

    const execDoc = (await WorkflowExecution.findOne({
      _id: 'exec-happy',
      tenantId: 't1',
    }).lean()) as { _id: string; workflowId: string } | null;
    expect(execDoc).not.toBeNull();
    expect(execDoc!.workflowId).toBe('wf-1');

    const outboxRows = (await WorkflowEventOutboxModel.find({
      tenantId: 't1',
      entityId: 'exec-happy',
    }).lean()) as Array<{ eventType: string; entityKind: string; topic: string }>;
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]!.eventType).toBe('workflow.execution.started');
    expect(outboxRows[0]!.entityKind).toBe('workflow_execution');
    expect(outboxRows[0]!.topic).toBe('abl.workflow.execution');
  });

  it('[abort path] outbox write failure rolls back the domain write — neither row persists', async ({
    skip,
  }) => {
    if (!replSetAvailable) return skip('MongoMemoryReplSet unavailable');

    const failingOutbox: OutboxModelLike = {
      insertMany: async () => {
        throw new Error('outbox failed — simulate transient mongo error');
      },
    };
    const decorator = buildDecorator({ outboxOverride: failingOutbox });

    await expect(
      decorator.createExecution({
        executionId: 'exec-abort',
        tenantId: 't1',
        projectId: 'p1',
        workflowId: 'wf-1',
        workflowVersion: '7',
        status: 'running',
        triggerType: 'manual',
        triggerPayload: { foo: 'bar' },
        steps: [],
      }),
    ).rejects.toThrow(/outbox failed/);

    const execDoc = await WorkflowExecution.findOne({
      _id: 'exec-abort',
      tenantId: 't1',
    }).lean();
    // Critical: the transaction must have rolled back the domain write.
    expect(execDoc).toBeNull();

    const outboxCount = await WorkflowEventOutboxModel.countDocuments({ tenantId: 't1' });
    expect(outboxCount).toBe(0);
  });

  it('[flag-off path] WORKFLOW_OUTBOX_ENABLED=false — domain write persists; no outbox row', async ({
    skip,
  }) => {
    if (!replSetAvailable) return skip('MongoMemoryReplSet unavailable');

    process.env.WORKFLOW_OUTBOX_ENABLED = 'false';
    const decorator = buildDecorator();
    await decorator.createExecution({
      executionId: 'exec-flagoff',
      tenantId: 't1',
      projectId: 'p1',
      workflowId: 'wf-1',
      workflowVersion: '7',
      status: 'running',
      triggerType: 'manual',
      triggerPayload: {},
      steps: [],
    });

    const execDoc = await WorkflowExecution.findOne({
      _id: 'exec-flagoff',
      tenantId: 't1',
    }).lean();
    expect(execDoc).not.toBeNull();

    const outboxCount = await WorkflowEventOutboxModel.countDocuments({ tenantId: 't1' });
    expect(outboxCount).toBe(0);

    // WorkflowExecutionOutboxModel should have no rows created under flag-off
    const rows = (await WorkflowEventOutboxModel.find({} as Record<string, unknown>)
      .sort({ occurredAt: 1 })
      .limit(10)
      .lean()) as WorkflowEventOutboxDoc[];
    expect(rows).toHaveLength(0);
  });
});
