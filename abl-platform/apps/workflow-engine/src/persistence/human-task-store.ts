/**
 * MongoHumanTaskStore
 *
 * Persistence layer for human tasks within the workflow engine.
 * Used by the workflow handler to create and query tasks during execution.
 */

import type { ClientSession } from 'mongoose';
import { createLogger } from '@abl/compiler/platform';
import {
  HumanTask,
  type IHumanTask,
  type IHumanTaskResponse,
} from '@agent-platform/database/models';

import { computeHumanTaskTerminalCandidate } from './workflow-ttl.js';

const log = createLogger('workflow-engine:human-task-store');

/**
 * Optional persistence call options. `session` threads a Mongoose
 * ClientSession through the underlying create/findOneAndUpdate operations
 * so the caller can group the write into an outer `withTransaction` scope
 * alongside outbox writes. See LLD §3.2.
 */
export interface HumanTaskStoreOptions {
  session?: ClientSession;
}

export interface CreateHumanTaskParams {
  tenantId: string;
  projectId: string;
  type: IHumanTask['type'];
  mailbox: IHumanTask['mailbox'];
  status?: IHumanTask['status'];
  priority: IHumanTask['priority'];
  title: string;
  description?: string;
  source: IHumanTask['source'];
  /** Empty / undefined = open pool; [u] = direct; [u1, u2, ...] = scoped pool. */
  assignedTo?: string[];
  assignedToTeam?: string;
  fields: IHumanTask['fields'];
  context: Record<string, unknown>;
  dueAt?: Date;
  onTimeout?: IHumanTask['onTimeout'];
  escalationChain?: string[];
}

/**
 * Minimal HumanTask store shape consumed by resolution routes
 * (workflow-approvals, human-task-resolution). Both routes only need
 * lookup-by-source + status update-to-completed after Restate resolves
 * the durable promise — intentionally narrower than the full
 * MongoHumanTaskStore surface (which also supports createTask and
 * the broader HumanTaskStatus union used by the workflow handler).
 */
export interface HumanTaskStoreLike {
  findBySource(
    tenantId: string,
    projectId: string,
    sourceType: string,
    sourceFilter: Record<string, unknown>,
  ): Promise<{ _id: string; projectId: string } | null>;
  updateTaskStatus(
    taskId: string,
    tenantId: string,
    projectId: string,
    status: 'completed',
    extra?: { response?: IHumanTaskResponse },
    options?: HumanTaskStoreOptions,
  ): Promise<unknown>;
}

/**
 * Mark the HumanTask inbox mirror completed after Restate has accepted the
 * resolution of a `workflow_approval` or `workflow_human_task` durable
 * promise.
 *
 * Best-effort by design: Restate holds the canonical workflow state, so any
 * failure here only affects the MongoDB inbox view and must not fail the
 * route. Any exception is logged and swallowed. Missing mirror (no matching
 * HumanTask row) logs a `warn` and returns — this can legitimately happen if
 * the step existed before the inbox feature shipped, or if a previous
 * resolve attempt already completed the mirror.
 *
 * Consolidates the ~20-line find-by-source → update-to-completed → try/catch
 * block that was copy-pasted between `routes/workflow-approvals.ts` and
 * `routes/human-task-resolution.ts` with only the `sourceType` differing.
 */
export async function syncHumanTaskOnResolve(
  store: HumanTaskStoreLike,
  params: {
    tenantId: string;
    projectId: string;
    sourceType: 'workflow_approval' | 'workflow_human_task';
    executionId: string;
    stepId: string;
    respondedBy: string;
    respondedAt: Date;
    fields: Record<string, unknown>;
    notes?: string;
    decision?: string;
  },
): Promise<void> {
  try {
    const task = await store.findBySource(params.tenantId, params.projectId, params.sourceType, {
      executionId: params.executionId,
      stepId: params.stepId,
    });
    if (!task) {
      log.warn('No matching HumanTask found to sync after resolve', {
        sourceType: params.sourceType,
        executionId: params.executionId,
        stepId: params.stepId,
      });
      return;
    }
    await store.updateTaskStatus(task._id, params.tenantId, task.projectId, 'completed', {
      response: {
        respondedBy: params.respondedBy,
        respondedAt: params.respondedAt,
        fields: params.fields,
        notes: params.notes,
        decision: params.decision,
      } as IHumanTaskResponse,
    });
  } catch (err) {
    log.error('Failed to sync HumanTask status after resolve', {
      sourceType: params.sourceType,
      executionId: params.executionId,
      stepId: params.stepId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export class MongoHumanTaskStore {
  async createTask(
    params: CreateHumanTaskParams,
    options?: HumanTaskStoreOptions,
  ): Promise<IHumanTask> {
    // Mongoose's single-document Model.create() does NOT accept a session
    // option. Use the array overload so the session (when present) is
    // honoured for atomic writes within `withTransaction` scopes.
    const [doc] = await HumanTask.create(
      [
        {
          tenantId: params.tenantId,
          projectId: params.projectId,
          type: params.type,
          mailbox: params.mailbox,
          status: params.status ?? 'pending',
          priority: params.priority,
          title: params.title,
          description: params.description,
          source: params.source,
          assignedTo: params.assignedTo,
          assignedToTeam: params.assignedToTeam,
          fields: params.fields,
          context: params.context,
          dueAt: params.dueAt,
          onTimeout: params.onTimeout,
          escalationChain: params.escalationChain ?? [],
          currentEscalationLevel: 0,
        },
      ],
      options?.session ? { session: options.session } : undefined,
    );
    log.info('Human task created', { taskId: doc._id, type: params.type });
    return doc;
  }

  async updateTaskStatus(
    taskId: string,
    tenantId: string,
    projectId: string,
    status: IHumanTask['status'],
    extra?: Partial<
      Pick<IHumanTask, 'response' | 'claimedBy' | 'assignedTo' | 'assignedToTeam' | 'slaBreachedAt'>
    >,
    options?: HumanTaskStoreOptions,
  ): Promise<IHumanTask | null> {
    // LLD §6.2 — populate `expiresAt` on terminal transitions for
    // `mailbox='workflow'` tasks only, when the TTL flag is on. We use an
    // aggregation-pipeline update with `$cond` so the mailbox check is
    // atomic with the status write (no pre-fetch round trip). Agent /
    // escalation mailboxes keep `$expiresAt` untouched.
    const ttlTerminalCandidate = computeHumanTaskTerminalCandidate(status);
    let updatePayload: Record<string, unknown> | Record<string, unknown>[];
    if (ttlTerminalCandidate) {
      const base: Record<string, unknown> = { status, ...extra };
      updatePayload = [
        {
          $set: {
            ...base,
            expiresAt: {
              $cond: [{ $eq: ['$mailbox', 'workflow'] }, ttlTerminalCandidate, '$expiresAt'],
            },
          },
        },
      ];
    } else {
      updatePayload = { $set: { status, ...extra } };
    }

    const doc = await HumanTask.findOneAndUpdate(
      { _id: taskId, tenantId, projectId },
      updatePayload,
      {
        new: true,
        ...(options?.session ? { session: options.session } : {}),
      },
    ).lean();
    if (doc) {
      log.info('Human task status updated', { taskId, status });
    }
    return doc as IHumanTask | null;
  }

  async findBySource(
    tenantId: string,
    projectId: string,
    sourceType: string,
    sourceFilter: Record<string, unknown>,
  ): Promise<IHumanTask | null> {
    const filter: Record<string, unknown> = {
      tenantId,
      projectId,
      'source.type': sourceType,
      ...Object.fromEntries(Object.entries(sourceFilter).map(([k, v]) => [`source.${k}`, v])),
      status: { $in: ['pending', 'assigned', 'in_progress'] },
    };
    const doc = await HumanTask.findOne(filter).lean();
    return doc as IHumanTask | null;
  }

  async findById(taskId: string, tenantId: string, projectId: string): Promise<IHumanTask | null> {
    const doc = await HumanTask.findOne({ _id: taskId, tenantId, projectId }).lean();
    return doc as IHumanTask | null;
  }
}
