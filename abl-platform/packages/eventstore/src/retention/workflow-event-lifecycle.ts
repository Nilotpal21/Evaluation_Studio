/**
 * WorkflowEventLifecycle — implements `IEventLifecycle` for the workflow
 * event-sourcing tables (LLD §4.6, FR-8).
 *
 * The platform `ClickHouseEventStore` owns `platform_events`; this lifecycle
 * owns the workflow-execution-event-sourcing tables:
 *   - `workflow_execution_events` (raw append-only stream)
 *   - `human_task_events`         (raw append-only stream, mailbox=workflow)
 *   - `workflow_executions_latest` (ReplacingMergeTree projection)
 *   - `human_tasks_latest`         (ReplacingMergeTree projection)
 *
 * The two `_latest` projections are populated by materialized views from
 * their raw counterparts. ClickHouse materialized views do not replay source
 * mutations into target tables, so lifecycle operations must explicitly touch
 * projections where they retain rows or identity-bearing columns.
 *
 * Wiring: `apps/runtime/src/services/eventstore-singleton.ts` instantiates
 * `EventRetentionService(new WorkflowEventLifecycle(chClient))` alongside
 * the existing platform retention service. The `registerEventRetention
 * Handler` hook in `apps/studio/src/services/retention/retention-scheduler.ts`
 * is the integration point for the daily cron.
 */

import { createLogger } from '@agent-platform/shared-observability';
import type { IEventLifecycle } from '../interfaces/event-store.js';
import type { PurgeResult } from '../interfaces/types.js';

const DATABASE = 'abl_platform';
const WAIT_FOR_LOCAL_MUTATION_SETTING = 'SETTINGS mutations_sync = 1';

/**
 * Minimal CH client surface — `command()` for DDL/DML. Kept structural so
 * tests inject fakes without depending on `@clickhouse/client`.
 */
export interface WorkflowEventLifecycleClient {
  command(params: { query: string; query_params?: Record<string, unknown> }): Promise<unknown>;
}

/** Raw event tables — `scrubPII` payload updates touch these directly. */
const RAW_EVENT_TABLES = ['workflow_execution_events', 'human_task_events'] as const;

/**
 * Projection tables — `deleteTenant` explicitly drops rows from these in
 * addition to the raw tables so tenant offboarding is atomic and does not
 * depend on materialized-view merge timing.
 */
const PROJECTION_TABLES = ['workflow_executions_latest', 'human_tasks_latest'] as const;

const HUMAN_TASK_EVENT_TYPES_PREFIX = 'human_task.';

const PURGE_TARGETS = [
  ...RAW_EVENT_TABLES.map((table) => ({
    table,
    timestampColumn: 'occurred_at',
  })),
  { table: 'workflow_executions_latest', timestampColumn: 'last_event_at' },
  { table: 'human_tasks_latest', timestampColumn: 'last_event_at' },
] as const;

const log = createLogger('eventstore:workflow-event-lifecycle');

export class WorkflowEventLifecycle implements IEventLifecycle {
  constructor(private readonly client: WorkflowEventLifecycleClient) {}

  /**
   * Delete events older than `olderThan` for the given tenant. Issues one
   * `ALTER TABLE ... DELETE` per raw table/projection, concurrently.
   *
   * Returns a `PurgeResult` with `deletedEstimate: -1` because CH
   * `ALTER TABLE ... DELETE` is an async mutation and the row count is not
   * reported synchronously. Consumers must treat this as "best-effort
   * completion" and check `system.mutations` if exact counts are needed
   * (platform `ClickHouseEventStore` follows the same convention).
   */
  async purgeExpired(tenantId: string, olderThan: Date): Promise<PurgeResult> {
    await Promise.all(
      PURGE_TARGETS.map(({ table, timestampColumn }) =>
        this.client.command({
          query: `ALTER TABLE ${DATABASE}.${table} DELETE WHERE tenant_id = {tenantId:String} AND ${timestampColumn} < {olderThan:DateTime64(3)} ${WAIT_FOR_LOCAL_MUTATION_SETTING}`,
          query_params: { tenantId, olderThan: olderThan.toISOString() },
        }),
      ),
    );
    log.info('Workflow events purgeExpired complete', {
      tenantId,
      olderThan: olderThan.toISOString(),
      tables: PURGE_TARGETS.map(({ table }) => table),
    });
    return { deletedEstimate: -1 };
  }

  /**
   * Anonymize raw payload columns on rows older than `olderThan` whose
   * `event_type` is in the supplied PII list. Human-task projections also
   * carry assignee identity columns, so they are scrubbed directly when the
   * retention PII set includes any human-task event type.
   *
   * No-op when `eventTypes` is empty.
   */
  async scrubPII(tenantId: string, olderThan: Date, eventTypes: string[]): Promise<void> {
    if (eventTypes.length === 0) return;
    const commands: Array<Promise<unknown>> = [
      this.client.command({
        query: `ALTER TABLE ${DATABASE}.workflow_execution_events UPDATE payload = '{"anonymized":true}', payload_truncated = 1, error_message = '' WHERE tenant_id = {tenantId:String} AND occurred_at < {olderThan:DateTime64(3)} AND event_type IN {eventTypes:Array(String)} ${WAIT_FOR_LOCAL_MUTATION_SETTING}`,
        query_params: {
          tenantId,
          olderThan: olderThan.toISOString(),
          eventTypes,
        },
      }),
      this.client.command({
        query: `ALTER TABLE ${DATABASE}.human_task_events UPDATE payload = '{"anonymized":true}', payload_truncated = 1 WHERE tenant_id = {tenantId:String} AND occurred_at < {olderThan:DateTime64(3)} AND event_type IN {eventTypes:Array(String)} ${WAIT_FOR_LOCAL_MUTATION_SETTING}`,
        query_params: {
          tenantId,
          olderThan: olderThan.toISOString(),
          eventTypes,
        },
      }),
    ];

    if (eventTypes.some((eventType) => eventType.startsWith(HUMAN_TASK_EVENT_TYPES_PREFIX))) {
      commands.push(
        this.client.command({
          query: `ALTER TABLE ${DATABASE}.human_tasks_latest UPDATE assigned_to = [], claimed_by = '', responded_by = '' WHERE tenant_id = {tenantId:String} AND last_event_at < {olderThan:DateTime64(3)} ${WAIT_FOR_LOCAL_MUTATION_SETTING}`,
          query_params: {
            tenantId,
            olderThan: olderThan.toISOString(),
          },
        }),
      );
    }
    await Promise.all(commands);
    log.info('Workflow events scrubPII complete', {
      tenantId,
      olderThan: olderThan.toISOString(),
      eventTypesCount: eventTypes.length,
    });
  }

  /**
   * No-op — workflow events are not session-scoped. Present to satisfy the
   * `IEventLifecycle` contract; the platform `ClickHouseEventStore`
   * implementation handles session deletion for `platform_events`.
   */
  async deleteBySessionIds(_tenantId: string, _sessionIds: string[]): Promise<void> {
    // Workflow events carry executionId, not sessionId — intentionally no-op.
  }

  /**
   * No-op — workflow event tables don't carry an `actor_id` column. Present
   * to satisfy the `IEventLifecycle` contract; platform `platform_events`
   * handles actor anonymization.
   */
  async anonymizeActor(_tenantId: string, _actorId: string): Promise<void> {
    // No actor_id column on workflow event tables — intentionally no-op.
  }

  /**
   * Drop every workflow-event-sourcing row for a tenant across BOTH raw
   * event tables AND the `_latest` projection tables. Concurrent fan-out
   * with error propagation — callers see the first failure immediately.
   */
  async deleteTenant(tenantId: string): Promise<void> {
    const tables = [...RAW_EVENT_TABLES, ...PROJECTION_TABLES];
    await Promise.all(
      tables.map((table) =>
        this.client.command({
          query: `ALTER TABLE ${DATABASE}.${table} DELETE WHERE tenant_id = {tenantId:String} ${WAIT_FOR_LOCAL_MUTATION_SETTING}`,
          query_params: { tenantId },
        }),
      ),
    );
    log.info('Workflow events deleteTenant complete', { tenantId, tables });
  }
}
