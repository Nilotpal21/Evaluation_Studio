/**
 * ExecutionPersistenceWithOutbox — decorator that wraps an `ExecutionStore`
 * so domain writes and outbox writes commit in the same Mongo transaction.
 *
 * Deviation from LLD §3.2 (deliberate, logged in implementation.log.md):
 * The LLD calls for `withTransaction(async (session) => { domainWrite;
 * outboxWrite })` at every call-site inside `workflow-handler.ts` (30+
 * sites). That expansion would exceed the 40-file / 3-package commit
 * scope guard and force every call-site edit to ship together. A
 * persistence-layer decorator preserves the same atomicity guarantee
 * (both writes share one `ClientSession`), requires zero handler changes,
 * and keeps the transaction scope entirely inside this class — which is
 * precisely what the LLD's "outbox writer stays a thin persistence
 * wrapper" rule is guarding.
 *
 * Correctness guarantees
 * ----------------------
 *  - Gated by `readFlags().outboxEnabled`: when false, every method
 *    forwards to the wrapped store directly — no transaction, no extra
 *    Mongo read, zero behavioural difference vs. the un-decorated path.
 *  - When on, each entry point:
 *      1. opens `withTransaction`,
 *      2. reads the enclosing execution doc inside the transaction so
 *         `workflow_id` / `workflow_version` / `trigger_type` / `started_at`
 *         come from the same consistent snapshot as the domain write,
 *      3. performs the domain write with the session,
 *      4. calls the outbox writer with the same session.
 *  - Data-only or transient patches (e.g. `status === 'skipped'`, or
 *    output-field-only updates) bypass the tx wrapper and the outbox
 *    write — they do not represent state-machine transitions. The
 *    status → event_type mapping in `event-builders.ts` is the single
 *    source of truth for which transitions emit events.
 */

import type { ClientSession } from 'mongoose';
import { createLogger } from '@abl/compiler/platform';
import { withTransaction } from '@agent-platform/shared/repos';
import type { ExecutionPersistence, HumanTaskStore } from '../handlers/workflow-handler.js';
import type { ExecutionStore, ExecutionStoreOptions } from '../persistence/execution-store.js';
import type {
  MongoHumanTaskStore,
  HumanTaskStoreOptions,
  HumanTaskStoreLike,
  CreateHumanTaskParams,
} from '../persistence/human-task-store.js';
import { readFlags } from './flag-gates.js';
import {
  buildOutboxPayload,
  type OutboxModelLike,
  WorkflowEventOutboxWriter,
} from './workflow-event-outbox-writer.js';
import {
  buildExecutionStartedEvent,
  buildExecutionTerminalEvent,
  buildHumanTaskCreatedEvent,
  buildHumanTaskTransitionEvent,
  buildStepEvent,
  execStatusToEventType,
  stepStatusToEventType,
  taskStatusToEventType,
  type ExecutionSnapshot,
} from './event-builders.js';

const log = createLogger('workflow-engine:outbox-decorator');

/**
 * Minimal read model — lifts `findOne` out of `ExecutionStore` so the
 * decorator can snapshot the execution row inside the tx without
 * coupling to Mongoose.
 */
export interface ExecutionReadModel {
  findOne(filter: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
}

/** Snapshot helper — extracts the exec fields the event builders need. */
function snapshotExecution(doc: unknown): ExecutionSnapshot | null {
  if (!doc || typeof doc !== 'object') return null;
  const d = doc as Record<string, unknown>;
  return {
    tenantId: String(d.tenantId ?? ''),
    projectId: String(d.projectId ?? ''),
    workflowId: String(d.workflowId ?? ''),
    workflowVersion: (d.workflowVersion as string | null | undefined) ?? null,
    triggerType: (d.triggerType as string | null | undefined) ?? null,
    startedAt: d.startedAt instanceof Date ? d.startedAt : null,
    completedAt: d.completedAt instanceof Date ? d.completedAt : null,
    durationMs: typeof d.durationMs === 'number' ? d.durationMs : null,
  };
}

/**
 * Wraps `ExecutionStore` so createExecution / updateStepStatus /
 * updateExecutionStatus commit a workflow-execution outbox row in the
 * same transaction.
 */
export class ExecutionPersistenceWithOutbox implements ExecutionPersistence {
  constructor(
    private readonly inner: ExecutionStore,
    private readonly outboxWriter: WorkflowEventOutboxWriter,
    private readonly readModel: ExecutionReadModel,
  ) {}

  async createExecution(input: Parameters<ExecutionStore['createExecution']>[0]): Promise<void> {
    if (!readFlags().outboxEnabled) {
      return this.inner.createExecution(input);
    }

    await withTransaction(async (session) => {
      await this.inner.createExecution(input, sessionOpt(session));
      const event = buildExecutionStartedEvent({
        executionId: input.executionId,
        tenantId: input.tenantId,
        projectId: input.projectId,
        workflowId: input.workflowId,
        workflowVersion: input.workflowVersion,
        triggerType: input.triggerType,
      });
      await this.outboxWriter.writeWithSession(
        [buildOutboxPayload({ entityKind: 'workflow_execution', event })],
        session,
      );
    });
  }

  async updateStepStatus(
    executionId: string,
    tenantId: string,
    projectId: string,
    stepId: string,
    status: string,
    data?: Parameters<ExecutionStore['updateStepStatus']>[5],
  ): Promise<void> {
    const eventType = stepStatusToEventType(status);
    if (!readFlags().outboxEnabled || !eventType) {
      return this.inner.updateStepStatus(executionId, tenantId, projectId, stepId, status, data);
    }

    await withTransaction(async (session) => {
      const execDoc = await this.readModel.findOne(
        { _id: executionId, tenantId, projectId },
        sessionOpt(session),
      );
      const exec = snapshotExecution(execDoc);
      if (!exec) {
        // Race: the step update would no-op upstream too — skip outbox emit.
        await this.inner.updateStepStatus(
          executionId,
          tenantId,
          projectId,
          stepId,
          status,
          data,
          sessionOpt(session),
        );
        return;
      }

      await this.inner.updateStepStatus(
        executionId,
        tenantId,
        projectId,
        stepId,
        status,
        data,
        sessionOpt(session),
      );

      const err = extractStepError(data?.error);
      const event = buildStepEvent({
        executionId,
        tenantId,
        projectId,
        stepId,
        status: status as 'running' | 'completed' | 'failed',
        exec,
        durationMs: (data?.durationMs as number | undefined) ?? null,
        error: err,
      });
      await this.outboxWriter.writeWithSession(
        [buildOutboxPayload({ entityKind: 'workflow_execution', event })],
        session,
      );
    });
  }

  async updateExecutionStatus(
    executionId: string,
    tenantId: string,
    projectId: string,
    status: string,
    data?: Parameters<ExecutionStore['updateExecutionStatus']>[4],
  ): Promise<void> {
    const eventType = execStatusToEventType(status);
    if (!readFlags().outboxEnabled || !eventType) {
      return this.inner.updateExecutionStatus(executionId, tenantId, projectId, status, data);
    }

    await withTransaction(async (session) => {
      const execDoc = await this.readModel.findOne(
        { _id: executionId, tenantId, projectId },
        sessionOpt(session),
      );
      const exec = snapshotExecution(execDoc);
      if (!exec) {
        await this.inner.updateExecutionStatus(
          executionId,
          tenantId,
          projectId,
          status,
          data,
          sessionOpt(session),
        );
        return;
      }

      await this.inner.updateExecutionStatus(
        executionId,
        tenantId,
        projectId,
        status,
        data,
        sessionOpt(session),
      );

      const err = extractExecutionError(data?.error);
      const event = buildExecutionTerminalEvent({
        executionId,
        tenantId,
        projectId,
        status: status as 'completed' | 'failed' | 'cancelled' | 'rejected',
        exec,
        errorCode: err?.code ?? null,
        errorMessage: err?.message ?? null,
      });
      await this.outboxWriter.writeWithSession(
        [buildOutboxPayload({ entityKind: 'workflow_execution', event })],
        session,
      );
    });
  }

  // H-7 fix: Delegate all relay-race methods to the inner ExecutionStore.
  // Without this, when WORKFLOW_OUTBOX_ENABLED=true the outbox-wrapped store
  // is passed to buildRestateEndpoint() and executeWorkflow() finds all relay-race
  // methods undefined, causing immediate bail-out and broken relay-race execution.
  getExecutionForLeg: ExecutionStore['getExecutionForLeg'] = (...args) =>
    this.inner.getExecutionForLeg!(...args);
  atomicBarrierIncrement: ExecutionStore['atomicBarrierIncrement'] = (...args) =>
    this.inner.atomicBarrierIncrement!(...args);
  atomicBarrierFailIncrement: ExecutionStore['atomicBarrierFailIncrement'] = (...args) =>
    this.inner.atomicBarrierFailIncrement!(...args);
  initStepBarrier: ExecutionStore['initStepBarrier'] = (...args) =>
    this.inner.initStepBarrier!(...args);
  parkStep: ExecutionStore['parkStep'] = (...args) => this.inner.parkStep!(...args);
  resolveParkedStep: ExecutionStore['resolveParkedStep'] = (...args) =>
    this.inner.resolveParkedStep!(...args);
  incrementLegCounter: ExecutionStore['incrementLegCounter'] = (...args) =>
    this.inner.incrementLegCounter!(...args);
  storeLoopData: ExecutionStore['storeLoopData'] = (...args) => this.inner.storeLoopData!(...args);
  readLoopData: ExecutionStore['readLoopData'] = (...args) => this.inner.readLoopData!(...args);
  // atomicLoopNextDispatch removed (H-6: dead code)
}

/**
 * Wraps `MongoHumanTaskStore` so createTask / updateTaskStatus commit a
 * human-task outbox row alongside the domain write.
 *
 * Exposes both `HumanTaskStore` (workflow-handler.ts interface — subset
 * used during execution) and `HumanTaskStoreLike` (resolution-route
 * interface). The resolver routes invoke `updateTaskStatus` after Restate
 * resolves a durable promise; the decorator must emit the outbox row for
 * those completions as well.
 */
export class HumanTaskStoreWithOutbox implements HumanTaskStore, HumanTaskStoreLike {
  constructor(
    private readonly inner: MongoHumanTaskStore,
    private readonly outboxWriter: WorkflowEventOutboxWriter,
    private readonly executionReadModel: ExecutionReadModel,
  ) {}

  async createTask(params: CreateHumanTaskParams): Promise<{ _id: string }> {
    // Scope guard — only workflow-mailbox tasks are event-sourced (HLD §5).
    // Skip the tx wrapper entirely for agent-mailbox tasks so they keep
    // their existing single-write semantics.
    if (!readFlags().outboxEnabled || params.mailbox !== 'workflow') {
      return this.inner.createTask(params);
    }
    const workflowSrc = extractWorkflowSource(params.source);
    if (!workflowSrc) {
      // Workflow mailbox without a workflow source — shouldn't happen in
      // practice, but if it does we can't emit a valid outbox event, so
      // forward to the inner store and log instead of failing the write.
      log.warn('Workflow-mailbox human task missing workflow source; skipping outbox', {
        tenantId: params.tenantId,
      });
      return this.inner.createTask(params);
    }

    return withTransaction(async (session) => {
      const task = await this.inner.createTask(params, sessionOpt(session));

      const execDoc = await this.executionReadModel.findOne(
        {
          _id: workflowSrc.executionId,
          tenantId: params.tenantId,
          projectId: params.projectId,
        },
        sessionOpt(session),
      );
      const exec = snapshotExecution(execDoc) ?? {
        tenantId: params.tenantId,
        projectId: params.projectId,
        workflowId: workflowSrc.workflowId,
      };

      const event = buildHumanTaskCreatedEvent({
        task: {
          _id: String(task._id),
          tenantId: params.tenantId,
          projectId: params.projectId,
          status: task.status ?? 'pending',
          priority: params.priority,
          assignedTo: params.assignedTo,
          source: {
            workflowId: workflowSrc.workflowId,
            executionId: workflowSrc.executionId,
            stepId: workflowSrc.stepId,
          },
          context: params.context,
          dueAt: params.dueAt ?? null,
          createdAt: task.createdAt instanceof Date ? task.createdAt : new Date(),
        },
        exec,
      });

      await this.outboxWriter.writeWithSession(
        [buildOutboxPayload({ entityKind: 'human_task', event })],
        session,
      );
      return task;
    });
  }

  async updateTaskStatus(
    taskId: string,
    tenantId: string,
    projectId: string,
    status: string,
    extra?: Record<string, unknown>,
  ): Promise<unknown> {
    const response = (extra as { response?: { action?: string; by?: string; at?: Date } })
      ?.response;
    const eventType = taskStatusToEventType(status, response);

    if (!readFlags().outboxEnabled || !eventType) {
      return this.inner.updateTaskStatus(
        taskId,
        tenantId,
        projectId,
        status as Parameters<MongoHumanTaskStore['updateTaskStatus']>[3],
        extra as Parameters<MongoHumanTaskStore['updateTaskStatus']>[4],
      );
    }

    return withTransaction(async (session) => {
      const updated = await this.inner.updateTaskStatus(
        taskId,
        tenantId,
        projectId,
        status as Parameters<MongoHumanTaskStore['updateTaskStatus']>[3],
        extra as Parameters<MongoHumanTaskStore['updateTaskStatus']>[4],
        sessionOpt<HumanTaskStoreOptions>(session),
      );

      if (!updated) return updated;

      const updatedRec = updated as unknown as {
        mailbox?: string;
        source?: unknown;
        context?: Record<string, unknown>;
        assignedTo?: string[];
        claimedBy?: string;
        createdAt?: Date;
      };

      // Scope guard — agent-mailbox tasks are out of scope for event sourcing.
      if (updatedRec.mailbox && updatedRec.mailbox !== 'workflow') {
        return updated;
      }

      const workflowSrc = extractWorkflowSource(updatedRec.source);
      if (!workflowSrc) {
        log.warn('Workflow-mailbox human task missing workflow source on update', {
          taskId,
          tenantId,
        });
        return updated;
      }

      const execDoc = await this.executionReadModel.findOne(
        { _id: workflowSrc.executionId, tenantId, projectId },
        sessionOpt(session),
      );
      const exec = snapshotExecution(execDoc) ?? {
        tenantId,
        projectId,
        workflowId: workflowSrc.workflowId,
      };

      const event = buildHumanTaskTransitionEvent({
        taskId,
        tenantId,
        projectId,
        status,
        response,
        task: {
          status: status as Parameters<MongoHumanTaskStore['updateTaskStatus']>[3],
          assignedTo: updatedRec.assignedTo ?? [],
          claimedBy: updatedRec.claimedBy,
          source: {
            workflowId: workflowSrc.workflowId,
            executionId: workflowSrc.executionId,
            stepId: workflowSrc.stepId,
          },
          context: updatedRec.context,
          createdAt: updatedRec.createdAt,
        },
        exec,
      });
      if (event) {
        await this.outboxWriter.writeWithSession(
          [buildOutboxPayload({ entityKind: 'human_task', event })],
          session,
        );
      } else {
        log.debug('Human task update produced no outbox event', { taskId, status });
      }
      return updated;
    });
  }

  async findBySource(
    tenantId: string,
    projectId: string,
    sourceType: string,
    sourceFilter: Record<string, unknown>,
  ): Promise<{ _id: string; projectId: string } | null> {
    const doc = await this.inner.findBySource(tenantId, projectId, sourceType, sourceFilter);
    return doc ? { _id: String(doc._id), projectId: doc.projectId } : null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

function sessionOpt<T = ExecutionStoreOptions>(session: ClientSession | null): T | undefined {
  return (session ? { session } : undefined) as T | undefined;
}

/**
 * Narrow the discriminated `IHumanTaskSource` union to the two workflow
 * variants. Returns the common shape or `null` for agent-escalation
 * sources (which should never reach this code path — mailbox guard in
 * the caller runs first).
 */
function extractWorkflowSource(
  source: unknown,
): { workflowId: string; executionId: string; stepId: string } | null {
  if (!source || typeof source !== 'object') return null;
  const rec = source as Record<string, unknown>;
  if (rec.type !== 'workflow_approval' && rec.type !== 'workflow_human_task') return null;
  if (
    typeof rec.workflowId !== 'string' ||
    typeof rec.executionId !== 'string' ||
    typeof rec.stepId !== 'string'
  ) {
    return null;
  }
  return {
    workflowId: rec.workflowId,
    executionId: rec.executionId,
    stepId: rec.stepId,
  };
}

function extractStepError(err: unknown): { code?: string; message?: string } | null {
  if (!err || typeof err !== 'object') return null;
  const rec = err as Record<string, unknown>;
  return {
    code: typeof rec.code === 'string' ? rec.code : undefined,
    message: typeof rec.message === 'string' ? rec.message : undefined,
  };
}

function extractExecutionError(err: unknown): { code?: string; message?: string } | null {
  return extractStepError(err);
}

/**
 * Convenience factory: wires the decorator stack atop existing stores,
 * reading the outbox model through a `WorkflowEventOutboxWriter` under
 * the covers. Index.ts uses this so `readFlags().outboxEnabled` controls
 * the whole wiring from a single call.
 */
export function wireOutboxDecorators(deps: {
  executionStore: ExecutionStore;
  humanTaskStore: MongoHumanTaskStore;
  outboxModel: OutboxModelLike;
  executionReadModel: ExecutionReadModel;
}): {
  executionPersistence: ExecutionPersistence;
  humanTaskStore: HumanTaskStore & HumanTaskStoreLike;
} {
  const writer = new WorkflowEventOutboxWriter(deps.outboxModel);
  return {
    executionPersistence: new ExecutionPersistenceWithOutbox(
      deps.executionStore,
      writer,
      deps.executionReadModel,
    ),
    humanTaskStore: new HumanTaskStoreWithOutbox(
      deps.humanTaskStore,
      writer,
      deps.executionReadModel,
    ),
  };
}
