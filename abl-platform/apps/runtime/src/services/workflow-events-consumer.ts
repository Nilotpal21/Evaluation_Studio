/**
 * Workflow Events Consumer (LLD §4.1 — Phase 4 Consume + Sink).
 *
 * Drains the two Kafka topics populated by the workflow-engine's outbox
 * poller and batches writes into ClickHouse via `BufferedClickHouseWriter`.
 *
 * Design notes
 * ------------
 *  - **Two independent `KafkaEventQueue` instances**, one per topic. Each
 *    instance MUST have an explicit consumer-group id. The default groupId
 *    is `'eventstore-consumer'` (see `packages/eventstore/src/queues/kafka-queue.ts:51`),
 *    so two instances sharing that default would be joined into one consumer
 *    group and trigger constant rebalances.
 *  - **Zod validation directly** via `WorkflowExecutionEventSchema.safeParse()`
 *    / `HumanTaskEventSchema.safeParse()`. We do NOT use
 *    `EventRegistry.validate()` — that helper parses the `data` field of a
 *    `PlatformEvent` envelope, and these events are flat top-level objects.
 *  - **Smaller batches than the `BufferedClickHouseWriter` defaults**
 *    (`batchSize: 1000`, `flushIntervalMs: 1000`). The defaults are tuned
 *    for high-volume platform event traffic (10,000 / 5s); workflow events
 *    are lower-volume but latency-sensitive (feature-spec §12 SLI p95 ≤10s
 *    event→CH). These numbers can be raised once LOAD-01 confirms headroom.
 *  - **Idempotency** is guaranteed downstream by the `_latest`
 *    ReplacingMergeTree projection keyed on the occurred-at-derived
 *    `_version` — raw-event duplicates are tolerated for at-least-once
 *    delivery; the projection collapses them on merge.
 *  - **`HumanTaskEventSchema.mailbox` is pinned to literal `'workflow'`** —
 *    schema-level scope enforcement (HLD §5.3 errata E-5, belt-and-
 *    suspenders with the MV's `WHERE mailbox = 'workflow'`).
 */

import type { ClickHouseClient } from '@clickhouse/client';
import { createLogger } from '@abl/compiler/platform';
import { BufferedClickHouseWriter } from '@agent-platform/database/clickhouse';
import {
  WorkflowExecutionEventSchema,
  type WorkflowExecutionEvent,
  HumanTaskEventSchema,
  type HumanTaskEvent,
} from '@abl/eventstore/schema';
import {
  recordConsumerLag,
  recordFlushFailure,
  recordFlushLatency,
  recordFlushSuccess,
  recordIngestLatency,
} from './workflow-events-consumer-metrics.js';

/**
 * CH row shape for `workflow_execution_events`. Column order + types mirror
 * `packages/eventstore/src/stores/clickhouse/workflow-execution-events-table.ts`.
 */
export interface WorkflowExecutionEventRow {
  event_id: string;
  event_version: string;
  execution_id: string;
  tenant_id: string;
  project_id: string;
  workflow_id: string;
  workflow_version: string;
  event_type: string;
  status: string;
  started_at: string; // DateTime64(3,'UTC') as ISO-8601
  completed_at: string | null;
  duration_ms: number;
  step_id: string;
  step_name: string;
  step_type: string;
  trigger_type: string;
  error_code: string;
  error_message: string;
  payload: string;
  payload_truncated: 0 | 1;
  occurred_at: string;
  ingested_at: string;
}

/**
 * CH row shape for `human_task_events`. Mirrors
 * `packages/eventstore/src/stores/clickhouse/human-task-events-table.ts`.
 */
export interface HumanTaskEventRow {
  event_id: string;
  event_version: string;
  task_id: string;
  tenant_id: string;
  project_id: string;
  execution_id: string;
  workflow_id: string;
  step_id: string;
  task_type: string;
  mailbox: string;
  status: string;
  priority: string;
  event_type: string;
  assigned_to: string[];
  claimed_by: string;
  responded_by: string;
  decision: string;
  due_at: string | null;
  sla_breached_at: string | null;
  created_at: string;
  payload: string;
  payload_truncated: 0 | 1;
  occurred_at: string;
  ingested_at: string;
}

const WORKFLOW_EXECUTION_TOPIC = 'abl.workflow.execution';
const HUMAN_TASK_TOPIC = 'abl.human.task';

/**
 * ClickHouse `DateTime64(3, 'UTC')` parsing in `JSONEachRow` format expects
 * `YYYY-MM-DD HH:MM:SS.sss` (space separator, no `T`, no trailing `Z`). The
 * event payloads use ISO-8601 — this helper strips the `T`/`Z` so the row
 * mapper emits CH-native timestamps.
 *
 * Accepts `null` for the nullable DateTime columns (completed_at, due_at,
 * sla_breached_at). Preserves `null` through — CH treats that as NULL.
 */
function toChDateTime<T extends string | null | undefined>(iso: T): T {
  if (iso === null || iso === undefined) return iso;
  return (iso as string).replace('T', ' ').replace('Z', '') as T;
}

/** LLD-specified consumer group ids — explicit per instance to avoid rebalance collisions. */
const WORKFLOW_EXECUTION_GROUP_ID = 'workflow-execution-consumer';
const HUMAN_TASK_GROUP_ID = 'human-task-consumer';

/** Feature-spec §12 SLI: p95 ≤10s event→CH. Small batches keep us under target. */
const WORKFLOW_EVENTS_BATCH_SIZE = 1000;
const WORKFLOW_EVENTS_FLUSH_INTERVAL_MS = 1000;

/**
 * Topic-subscribing / ack-responsibility interface satisfied by
 * `KafkaEventQueue` (`onProcess(handler)` + `close()`). Typed structurally
 * so tests can inject in-memory fakes.
 */
export interface ConsumerQueueClient {
  onProcess(handler: (event: unknown) => void | Promise<void>): void;
  close(): Promise<void>;
  /**
   * Kafka connection liveness. KafkaEventQueue exposes this via its
   * internal `kafkaHealthy` flag (flipped by kafkajs connect/disconnect
   * events). Optional so test doubles can omit it.
   */
  isHealthy?(): boolean;
}

export interface WorkflowEventsConsumerDeps {
  chClient: ClickHouseClient;
  executionQueue: ConsumerQueueClient;
  humanTaskQueue: ConsumerQueueClient;
  /** Optional override for batch/flush tuning — default per LLD §4.1. */
  batchSize?: number;
  flushIntervalMs?: number;
}

/**
 * Pure row mapper — converts a validated `WorkflowExecutionEvent` into the
 * CH row. Exported for unit testing (UT-02 per test spec).
 */
export function toWorkflowExecutionEventRow(
  event: WorkflowExecutionEvent,
): WorkflowExecutionEventRow {
  return {
    event_id: event.event_id,
    event_version: event.event_version,
    execution_id: event.execution_id,
    tenant_id: event.tenant_id,
    project_id: event.project_id,
    workflow_id: event.workflow_id,
    workflow_version: event.workflow_version,
    event_type: event.event_type,
    status: event.status,
    started_at: toChDateTime(event.started_at ?? event.occurred_at),
    completed_at: toChDateTime(event.completed_at ?? null),
    duration_ms: event.duration_ms ?? 0,
    step_id: event.step_id ?? '',
    step_name: event.step_name ?? '',
    step_type: event.step_type ?? '',
    trigger_type: event.trigger_type,
    error_code: event.error_code ?? '',
    error_message: event.error_message ?? '',
    payload: event.metadata ? JSON.stringify(event.metadata) : '{}',
    payload_truncated: 0,
    occurred_at: toChDateTime(event.occurred_at),
    ingested_at: toChDateTime(new Date().toISOString()),
  };
}

/**
 * Pure row mapper — converts a validated `HumanTaskEvent` into the CH row.
 */
export function toHumanTaskEventRow(event: HumanTaskEvent): HumanTaskEventRow {
  // `.passthrough()` means schema-extended fields may be present. Narrow
  // optionals via `as` after the Zod parse has validated the known shape.
  const extended = event as HumanTaskEvent & {
    step_id?: string;
    task_type?: string;
    priority?: string;
    assigned_to?: string[];
    claimed_by?: string;
    responded_by?: string;
    decision?: string;
    due_at?: string | null;
    sla_breached_at?: string | null;
  };
  return {
    event_id: event.event_id,
    event_version: event.event_version,
    task_id: event.task_id,
    tenant_id: event.tenant_id,
    project_id: event.project_id,
    execution_id: event.execution_id,
    workflow_id: event.workflow_id,
    step_id: extended.step_id ?? '',
    task_type: extended.task_type ?? '',
    mailbox: event.mailbox, // Zod-validated as literal 'workflow'.
    status: event.status,
    priority: extended.priority ?? '',
    event_type: event.event_type,
    assigned_to: extended.assigned_to ?? event.assignees,
    claimed_by: extended.claimed_by ?? '',
    responded_by: extended.responded_by ?? event.outcome_by ?? '',
    decision: extended.decision ?? event.outcome ?? '',
    due_at: toChDateTime(extended.due_at ?? null),
    sla_breached_at: toChDateTime(extended.sla_breached_at ?? null),
    created_at: toChDateTime(event.created_at ?? event.occurred_at),
    payload: event.payload ? JSON.stringify(event.payload) : '{}',
    payload_truncated: 0,
    occurred_at: toChDateTime(event.occurred_at),
    ingested_at: toChDateTime(new Date().toISOString()),
  };
}

const log = createLogger('workflow-events-consumer');

/**
 * WorkflowEventsConsumer — owns two `KafkaEventQueue` subscriptions and two
 * `BufferedClickHouseWriter` instances. Lifecycle:
 *
 *  1. Caller constructs with pre-built queue clients + CH client.
 *  2. `start()` registers consumer handlers. The `init` of CH tables happens
 *     at server bootstrap (idempotent; see `server.ts` wiring).
 *  3. On each validated event: insert into the matching buffered writer.
 *     Zod-rejected events are dropped with a structured log (no crash).
 *  4. `shutdown()` first disconnects Kafka, then flushes + closes both
 *     writers so any last in-flight events enqueued during disconnect are
 *     still persisted before process exit.
 */
export class WorkflowEventsConsumer {
  private readonly executionWriter: BufferedClickHouseWriter<WorkflowExecutionEventRow>;
  private readonly humanTaskWriter: BufferedClickHouseWriter<HumanTaskEventRow>;
  private started = false;

  // Per-buffer "first event seen" timestamps. Reset after each flush so
  // ingest latency measures the oldest-in-buffer → flush-success window.
  private executionFirstEventAt: number | null = null;
  private humanTaskFirstEventAt: number | null = null;

  constructor(private readonly deps: WorkflowEventsConsumerDeps) {
    const batchSize = deps.batchSize ?? WORKFLOW_EVENTS_BATCH_SIZE;
    const flushIntervalMs = deps.flushIntervalMs ?? WORKFLOW_EVENTS_FLUSH_INTERVAL_MS;

    this.executionWriter = new BufferedClickHouseWriter<WorkflowExecutionEventRow>(deps.chClient, {
      table: 'abl_platform.workflow_execution_events',
      batchSize,
      flushIntervalMs,
      onSuccess: (rowCount, durationMs) => {
        const firstAt = this.executionFirstEventAt;
        this.executionFirstEventAt = null;
        recordFlushSuccess({ topic: WORKFLOW_EXECUTION_TOPIC });
        recordFlushLatency(durationMs, { topic: WORKFLOW_EXECUTION_TOPIC });
        if (firstAt !== null) {
          recordIngestLatency(Date.now() - firstAt, { topic: WORKFLOW_EXECUTION_TOPIC });
        }
        log.info('workflow.outbox.consumed', {
          topic: WORKFLOW_EXECUTION_TOPIC,
          row_count: rowCount,
          flush_latency_ms: durationMs,
        });
      },
      onError: (error, ctx) => {
        recordFlushFailure({ topic: WORKFLOW_EXECUTION_TOPIC });
        log.error('workflow.consumer.flush_failed', {
          topic: WORKFLOW_EXECUTION_TOPIC,
          error: error instanceof Error ? error.message : String(error),
          pending: ctx.pending,
          retries: ctx.retries,
        });
      },
    });

    this.humanTaskWriter = new BufferedClickHouseWriter<HumanTaskEventRow>(deps.chClient, {
      table: 'abl_platform.human_task_events',
      batchSize,
      flushIntervalMs,
      onSuccess: (rowCount, durationMs) => {
        const firstAt = this.humanTaskFirstEventAt;
        this.humanTaskFirstEventAt = null;
        recordFlushSuccess({ topic: HUMAN_TASK_TOPIC });
        recordFlushLatency(durationMs, { topic: HUMAN_TASK_TOPIC });
        if (firstAt !== null) {
          recordIngestLatency(Date.now() - firstAt, { topic: HUMAN_TASK_TOPIC });
        }
        log.info('workflow.outbox.consumed', {
          topic: HUMAN_TASK_TOPIC,
          row_count: rowCount,
          flush_latency_ms: durationMs,
        });
      },
      onError: (error, ctx) => {
        recordFlushFailure({ topic: HUMAN_TASK_TOPIC });
        log.error('workflow.consumer.flush_failed', {
          topic: HUMAN_TASK_TOPIC,
          error: error instanceof Error ? error.message : String(error),
          pending: ctx.pending,
          retries: ctx.retries,
        });
      },
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    this.deps.executionQueue.onProcess((raw: unknown) => {
      const parsed = WorkflowExecutionEventSchema.safeParse(raw);
      if (!parsed.success) {
        log.warn('Dropped invalid workflow.execution event', {
          error: parsed.error.issues.map((i) => `${i.path.join('.')}:${i.message}`).join('; '),
        });
        return;
      }
      this.recordLag(parsed.data.occurred_at, WORKFLOW_EXECUTION_TOPIC);
      if (this.executionFirstEventAt === null) this.executionFirstEventAt = Date.now();
      this.executionWriter.insert(toWorkflowExecutionEventRow(parsed.data));
    });

    this.deps.humanTaskQueue.onProcess((raw: unknown) => {
      const parsed = HumanTaskEventSchema.safeParse(raw);
      if (!parsed.success) {
        log.warn('Dropped invalid human.task event', {
          error: parsed.error.issues.map((i) => `${i.path.join('.')}:${i.message}`).join('; '),
        });
        return;
      }
      this.recordLag(parsed.data.occurred_at, HUMAN_TASK_TOPIC);
      if (this.humanTaskFirstEventAt === null) this.humanTaskFirstEventAt = Date.now();
      this.humanTaskWriter.insert(toHumanTaskEventRow(parsed.data));
    });

    log.info('WorkflowEventsConsumer started', {
      topics: [WORKFLOW_EXECUTION_TOPIC, HUMAN_TASK_TOPIC],
      groupIds: [WORKFLOW_EXECUTION_GROUP_ID, HUMAN_TASK_GROUP_ID],
    });
  }

  /**
   * Compute per-event lag (`Date.now() - occurred_at`) and record into the
   * consumer-lag histogram. Safe against an unparseable `occurred_at` (just
   * skips the sample — the schema already validated the field is a string).
   */
  private recordLag(occurredAtIso: string, topic: string): void {
    const occurredAtMs = Date.parse(occurredAtIso);
    if (!Number.isFinite(occurredAtMs)) return;
    const lag = Date.now() - occurredAtMs;
    if (lag >= 0) recordConsumerLag(lag, { topic });
  }

  /** Force a flush of both buffers — used by test-diagnostic routes. */
  async flushAll(): Promise<void> {
    await Promise.all([this.executionWriter.flush(), this.humanTaskWriter.flush()]);
  }

  /**
   * Liveness signal for the runtime readiness probe. Reports the consumer
   * as healthy when `start()` has been called AND both Kafka queues that
   * expose an `isHealthy()` signal are currently connected. Queue clients
   * without the optional method (test doubles) are treated as healthy so
   * tests don't need to stub it.
   */
  isHealthy(): boolean {
    if (!this.started) return false;
    const executionHealthy = this.deps.executionQueue.isHealthy?.() ?? true;
    const humanTaskHealthy = this.deps.humanTaskQueue.isHealthy?.() ?? true;
    return executionHealthy && humanTaskHealthy;
  }

  async shutdown(): Promise<void> {
    await Promise.all([this.deps.executionQueue.close(), this.deps.humanTaskQueue.close()]);
    await this.flushAll();
    await Promise.all([this.executionWriter.close(), this.humanTaskWriter.close()]);
    log.info('WorkflowEventsConsumer shut down');
  }
}

export {
  WORKFLOW_EXECUTION_TOPIC,
  HUMAN_TASK_TOPIC,
  WORKFLOW_EXECUTION_GROUP_ID,
  HUMAN_TASK_GROUP_ID,
  WORKFLOW_EVENTS_BATCH_SIZE,
  WORKFLOW_EVENTS_FLUSH_INTERVAL_MS,
};
