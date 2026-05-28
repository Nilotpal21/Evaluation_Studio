/**
 * Workflow GDPR cascade hook (LLD §4.3 + §4.7 — Phase 4).
 *
 * Implements `deleteByExecutionIds(tenantId, executionIds)` for the
 * workflow-execution-event-sourcing pipeline. Dropping by executionIds
 * needs to touch 7 surfaces:
 *
 *   ClickHouse (4 tables)
 *     - workflow_execution_events        (raw append-only stream)
 *     - workflow_executions_latest       (ReplacingMergeTree projection)
 *     - human_task_events                (raw append-only stream)
 *     - human_tasks_latest               (ReplacingMergeTree projection)
 *
 *   MongoDB (3 collections)
 *     - workflow_executions              (full-execution domain write)
 *     - human_tasks (mailbox=workflow)   (workflow-scoped human tasks)
 *     - workflow_event_outbox            (pending/published Kafka outbox rows)
 *
 * Design:
 *   - ClickHouse side uses `ALTER TABLE … DELETE` via `client.command`
 *     — the existing runtime convention in `cascade-repo.ts:158`.
 *   - All 4 CH commands run concurrently (`Promise.all`); errors propagate
 *     since the eventstore cascade contract returns `Promise<void>` and
 *     the caller (packages/database/src/cascade/cascade-delete.ts) catches
 *     at a higher level.
 *   - Mongo deletes are scoped:
 *       `WorkflowExecution.deleteMany({ tenantId, _id: { $in: executionIds } })`
 *       `HumanTask.deleteMany({ tenantId, mailbox: 'workflow', 'source.executionId': { $in: executionIds } })`
 *       `WorkflowEventOutboxModel.deleteMany({ tenantId, entityKind: 'workflow_execution', entityId: { $in: executionIds } })`
 *       `WorkflowEventOutboxModel.deleteMany({ tenantId, entityKind: 'human_task', 'payload.execution_id': { $in: executionIds } })`
 *     Non-workflow mailboxes are untouched.
 *
 * This hook is registered in `eventstore-singleton.ts` via
 * `registerEventCascadeHook` alongside the existing platform hook.
 */

import type { ClickHouseClient } from '@clickhouse/client';
import { createLogger } from '@abl/compiler/platform';
import {
  HumanTask,
  WorkflowEventOutboxModel,
  WorkflowExecution,
} from '@agent-platform/database/models';

const log = createLogger('workflow-cascade-hook');

const CH_EXECUTION_TABLES = ['workflow_execution_events', 'workflow_executions_latest'] as const;
const CH_HUMAN_TASK_TABLES = ['human_task_events', 'human_tasks_latest'] as const;
const WAIT_FOR_LOCAL_MUTATION_SETTING = 'SETTINGS mutations_sync = 1';

export interface WorkflowCascadeDeps {
  chClient: ClickHouseClient;
}

/**
 * Drop every workflow-event-sourcing row belonging to the given tenant's
 * set of execution ids — across both the raw CH streams, the CH `_latest`
 * projection targets, and the Mongo-side `WorkflowExecution` +
 * workflow-mailbox `HumanTask` collections.
 *
 * @param tenantId     Scopes ALL deletes — never fan-outs across tenants.
 * @param executionIds Set of workflow execution ids to cascade.
 */
export async function cascadeWorkflowByExecutionIds(
  deps: WorkflowCascadeDeps,
  tenantId: string,
  executionIds: string[],
): Promise<void> {
  if (executionIds.length === 0) return;

  const chWork = [...CH_EXECUTION_TABLES, ...CH_HUMAN_TASK_TABLES].map((table) =>
    deps.chClient.command({
      query: `ALTER TABLE abl_platform.${table} DELETE WHERE tenant_id = {tenantId:String} AND execution_id IN ({executionIds:Array(String)}) ${WAIT_FOR_LOCAL_MUTATION_SETTING}`,
      query_params: { tenantId, executionIds },
    }),
  );

  const mongoWork: Array<Promise<unknown>> = [
    WorkflowExecution.deleteMany({ tenantId, _id: { $in: executionIds } }),
    HumanTask.deleteMany({
      tenantId,
      mailbox: 'workflow',
      'source.executionId': { $in: executionIds },
    }),
    WorkflowEventOutboxModel.deleteMany({
      tenantId,
      entityKind: 'workflow_execution',
      entityId: { $in: executionIds },
    }),
    WorkflowEventOutboxModel.deleteMany({
      tenantId,
      entityKind: 'human_task',
      'payload.execution_id': { $in: executionIds },
    }),
  ];

  await Promise.all([...chWork, ...mongoWork]);

  log.info('Workflow cascade by executionIds complete', {
    tenantId,
    executionCount: executionIds.length,
  });
}

/**
 * Drop every workflow-event-sourcing CH row belonging to the tenant.
 * Used by the eventstore `deleteTenant` hook path (Mongo-side is already
 * dropped by `packages/database/src/cascade/cascade-delete.ts:deleteTenant`).
 */
export async function cascadeWorkflowTenant(
  deps: WorkflowCascadeDeps,
  tenantId: string,
): Promise<void> {
  const tables = [...CH_EXECUTION_TABLES, ...CH_HUMAN_TASK_TABLES];
  await Promise.all(
    tables.map((table) =>
      deps.chClient.command({
        query: `ALTER TABLE abl_platform.${table} DELETE WHERE tenant_id = {tenantId:String} ${WAIT_FOR_LOCAL_MUTATION_SETTING}`,
        query_params: { tenantId },
      }),
    ),
  );
  log.info('Workflow cascade by tenant complete', { tenantId });
}

/**
 * Supplementary Mongo-side cleanup for `deleteTenant` — the cascade-delete
 * helper already drops rows before the eventstore hook fires, so this is
 * defensive only. Kept so that a direct call via the hook still lands
 * Mongo-side consistency even if the caller skipped the outer cascade.
 */
export async function cascadeWorkflowTenantMongo(tenantId: string): Promise<void> {
  await Promise.all([
    WorkflowExecution.deleteMany({ tenantId }),
    HumanTask.deleteMany({ tenantId, mailbox: 'workflow' }),
    WorkflowEventOutboxModel.deleteMany({ tenantId }),
  ]);
}
