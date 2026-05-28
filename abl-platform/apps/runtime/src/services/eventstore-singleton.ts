/**
 * EventStore Singleton
 *
 * Central event store accessor with ClickHouse backend.
 *
 * Call initializeEventStore() at server startup after ClickHouse init.
 * Use getEventStore() elsewhere for event emission, queries, retention, and GDPR.
 */

import { createLogger } from '@abl/compiler/platform';
import {
  createEventStore,
  EventRetentionService,
  WorkflowEventLifecycle,
  eventRegistry,
  registerWorkflowExecutionEvents,
  registerHumanTaskEvents,
  type EventStoreServices,
  type EventStoreConfig,
  type IEventRetention,
} from '@abl/eventstore';
import { registerEventCascadeHook } from '@agent-platform/database/cascade';
import { cascadeWorkflowByExecutionIds, cascadeWorkflowTenant } from './workflow-cascade-hook.js';

const log = createLogger('eventstore-singleton');

let _eventStore: EventStoreServices | null = null;
let _workflowRetention: IEventRetention | null = null;
let _initialized = false;

export async function initializeEventStore(opts: { clickhouseReady: boolean }): Promise<void> {
  if (_initialized) return;

  if (!opts.clickhouseReady) {
    log.error('ClickHouse not ready — EventStore cannot initialize');
    _initialized = true;
    return;
  }

  const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
  const client = getClickHouseClient();

  const config: EventStoreConfig = {
    mode: 'embedded',
    backend: 'clickhouse',
    clickhouse: { client },
    ...(process.env.EVENTSTORE_RESILIENCE_ENABLED !== 'false' && {
      resilience: {
        enabled: true,
        wal: { directory: process.env.EVENTSTORE_WAL_DIR ?? '/tmp/eventstore-wal' },
      },
    }),
  };

  _eventStore = createEventStore(config);
  _initialized = true;

  // Register workflow-execution + human-task event schemas with the shared
  // `eventRegistry` (LLD §4 wiring checklist item 2). The registry exposes
  // `getPIIEventTypes()` used by `WorkflowEventLifecycle.scrubPII()` and by
  // the platform-wide GDPR audit scrubber. Other event schemas register
  // via module-level side effects; workflow events use explicit registration
  // (see `packages/eventstore/src/schema/events/workflow-execution-events.ts`
  // file header for the rationale).
  registerWorkflowExecutionEvents(eventRegistry);
  registerHumanTaskEvents(eventRegistry);
  log.info('Workflow + human-task event schemas registered with EventRegistry');

  // WAL recovery
  if (_eventStore.recovery) {
    try {
      await _eventStore.recovery.recoverFromWAL();
      _eventStore.recovery.startPeriodicRecovery();
    } catch (walErr) {
      log.warn('WAL recovery failed (non-fatal)', {
        error: walErr instanceof Error ? walErr.message : String(walErr),
      });
    }
  }

  // GDPR cascade hooks
  //
  // `deleteBySessionIds` + `deleteTenant` fan out to the platform
  // eventstore (messages / traces / audit / facts / llm_metrics). The
  // additional `deleteByExecutionIds` hook (LLD §4.3 + §4.7) cascades
  // workflow-execution-event-sourcing rows across CH (raw + _latest) and
  // Mongo (WorkflowExecution + mailbox=workflow HumanTask). The platform
  // tenant delete is paired with a workflow tenant CH-side cascade so
  // `workflow_execution_events` / `workflow_executions_latest` /
  // `human_task_events` / `human_tasks_latest` are dropped on the same
  // tenant-deletion path.
  registerEventCascadeHook({
    deleteBySessionIds: (tenantId, sessionIds) =>
      _eventStore!.gdpr.deleteBySessionIds(tenantId, sessionIds),
    deleteTenant: async (tenantId) => {
      await _eventStore!.gdpr.deleteTenant(tenantId);
      await cascadeWorkflowTenant({ chClient: client }, tenantId);
    },
    deleteByExecutionIds: (tenantId, executionIds) =>
      cascadeWorkflowByExecutionIds({ chClient: client }, tenantId, executionIds),
  });

  // Workflow-event-sourcing retention (LLD §4.6, FR-8 plan-tiered CH
  // retention). Runs alongside the platform `EventRetentionService` — each
  // owns its own set of tables. The daily retention cron (studio-side via
  // `registerEventRetentionHandler`) should invoke BOTH; an upstream
  // integration wires the handler when that cron is activated.
  _workflowRetention = new EventRetentionService(new WorkflowEventLifecycle(client));

  log.info('EventStore initialized with ClickHouse backend');
}

export function getEventStore(): EventStoreServices | null {
  return _eventStore;
}

/**
 * Workflow-event-sourcing retention service (LLD §4.6). Null until
 * `initializeEventStore()` resolves with a ready ClickHouse backend.
 */
export function getWorkflowRetention(): IEventRetention | null {
  return _workflowRetention;
}

/** Test helper — reset singleton state */
export function _resetEventStore(): void {
  _eventStore = null;
  _workflowRetention = null;
  _initialized = false;
}
