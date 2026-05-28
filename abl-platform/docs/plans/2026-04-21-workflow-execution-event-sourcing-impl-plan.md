# LLD: Workflow Execution Event Sourcing

**Feature Spec**: `docs/features/sub-features/workflow-execution-event-sourcing.md`
**HLD**: `docs/specs/workflow-execution-event-sourcing.hld.md`
**Test Spec**: `docs/testing/sub-features/workflow-execution-event-sourcing.md`
**Status**: DONE (all 6 phases implemented 2026-04-21; 5-round `pr-reviewer` loop complete and APPROVED; dockerized-CH integration PR still outstanding for GAP-008 tests)
**Author**: Pattabhi (Runtime / Workflows Team)
**Date**: 2026-04-21
**Jira**: ABLP-2
**Last Sync**: 2026-04-21 — post-implementation doc sync (round 2). Deviations vs plan documented per-phase in `../sdlc-logs/workflow-execution-event-sourcing/implementation.log.md`. Main deviations: (a) §3.2 decorator-based outbox wiring (not per-callsite `withTransaction`); (b) §3.7 structured-log trace events (no runtime `TraceStore` interface exists); (c) §4.6 retention service constructed but daily-cron wiring via `registerEventRetentionHandler` deferred (GAP-010); (d) integration/E2E/LOAD tests deferred to the dockerized-CH PR (feature-spec GAP-008).

**Post-Implementation Notes (2026-04-21, round-2 sync — integration hardening applied during the 5-round review loop)**:

- **Pipeline debug** (pre-review Kafka + CH end-to-end bring-up): `packages/eventstore/src/queues/kafka-queue.ts` now registers a pure-JS `lz4js` codec at module load (KafkaJS has no built-in LZ4 and the docker broker's `compression.type=lz4` forces recompression); `subscribe → run` was fused into a single promise chain to remove a startup race. `apps/runtime/src/services/workflow-events-consumer.ts` now uses fully-qualified CH table names (`abl_platform.workflow_execution_events`, `abl_platform.human_task_events`) and converts ISO-8601 timestamps to CH `DateTime64(3, 'UTC')` space-separator format via a new `toChDateTime()` helper. `apps/runtime/src/services/eventstore-singleton.ts` now calls `registerWorkflowExecutionEvents` + `registerHumanTaskEvents` at init (the prior top-level `export type *` in `packages/eventstore/src/index.ts` had stripped these value exports — explicit named re-exports were added).
- **Round 1** (code quality, 2 MEDIUM): `apps/workflow-engine/src/outbox/outbox-poller.ts` wraps both success-path and failure-path `updateOne` bookkeeping in try/catch — a transient Mongo hiccup can no longer abort the remaining rows in a drain batch. Dedup via ReplacingMergeTree `_version` absorbs any duplicate publish on the next cycle.
- **Round 2** (HLD compliance, 1 HIGH): `apps/workflow-engine/src/index.ts` now validates the TTL partial-filter index shape at startup (`partialFilterExpression.expiresAt.$type === 'date'`) and refuses to start with CRITICAL log + `process.exit(1)` if missing or wrong-shaped — closes the HLD §4 concern #11 migration-path gap where a silently-broken partial filter (Mongo rejects `$ne` but the error surfaces only at index build) would let pods run without TTL protection. `apps/runtime/src/services/hybrid-human-task-reader.ts` comments were rewritten to document the 2-layer mailbox scope guard (Mongo filter + MV `WHERE` clause at projection time; the `human_tasks_latest` projection table deliberately drops the `mailbox` column).
- **Round 3** (test coverage, 1 HIGH): extracted `parseStatusList` + `HUMAN_TASK_STATUS_VALUES` from `apps/runtime/src/routes/human-tasks.ts` and added a dedicated UT-04 test file (`apps/runtime/src/routes/__tests__/human-tasks-status-parser.test.ts`) with 9 pure-function cases. 2 new `outbox-poller.test.ts` cases cover the Round 1 bookkeeping-failed paths.
- **Round 4** (security & isolation, 1 HIGH): the final atomic `findOneAndUpdate` in `PATCH /api/projects/:projectId/human-tasks/:id` now filters on `projectId` alongside `_id` + `tenantId`. Closes a cross-project mutation gap at the atomic update site — the hybrid reader scoped correctly but the subsequent update was not scoped to `projectId`.
- **Round 5** (production readiness): APPROVED with 0 CRITICAL / 0 HIGH. 4 non-blocking findings filed as FU-2..FU-5 in `../sdlc-logs/workflow-execution-event-sourcing/followups.md` (outbox poison-pill cap; consumer shutdown ordering; parity-check `error_code` placeholder; observable-gauge `catch {}`). See `implementation.log.md` §Review Rounds for the full dimension-by-dimension matrix.

---

## 1. Design Decisions

### 1.1 Decision Log

| #   | Decision                                                                                                                                                                                            | Rationale                                                                                                                                                                                                  | Alternatives Rejected                                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1 | 6-phase rollout (P1 Infra Gaps → P2 Schema → P3 Write → P4 Sink → P5 Read → P6 TTL)                                                                                                                 | Isolates highest-risk refactors (HLD §3.6 Gaps) into Phase 1 as zero-behavior-change commits. Respects 40-file / 3-package commit-scope guards. Maps cleanly to feature spec's 2-phase flags.              | 3-phase bundle (too large per commit); data-first/API-first (can't validate end-to-end until both exist); per-flag sequencing (couples CH DDL to runtime). |
| D-2 | Add `options?: { session?: ClientSession }` parameter directly to `ExecutionStore` and `MongoHumanTaskStore` methods (HLD §3.6 Gap 1 option a)                                                      | Matches Mongoose's documented `{ session }` idiom. `WorkflowExecutionModel` already accepts `options?: Record<string, unknown>` in `updateOne`/`findOneAndUpdate`. No wrapper pattern exists in repo.      | Wrapper class `SessionedExecutionStore` — introduces new abstraction with zero precedent; doubles call-site changes at each usage.                         |
| D-3 | Add `publishAndAck(topic: string, event: unknown, key?: string): Promise<void>` to `KafkaEventQueue` (HLD §3.6 Gap 2 option b)                                                                      | Reuses existing producer setup, `idempotent: true`, `pendingMessages` tracking, partition-key logic (`packages/eventstore/src/queues/kafka-queue.ts:110-113`). Additive to `IEventQueue`.                  | Raw `KafkaProducer` exposure duplicates lifecycle/observability wiring; new `WorkflowEventPublisher` service adds a 4th Kafka abstraction layer.           |
| D-4 | ClickHouse DDL ships as TypeScript template literals in `packages/eventstore/src/stores/clickhouse/`, provisioned at service startup via `CREATE … IF NOT EXISTS`                                   | Matches `packages/database/src/clickhouse-schemas/init.ts` and `packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts` exactly. Zero new infrastructure needed.                           | External migration tool (none exists); `.sql` migration files (no precedent, requires runtime file reads per the analytics init comment at line 14).       |
| D-5 | Outbox poller uses BullMQ repeatable queue `workflow-outbox-publisher`, single-active-job leader election, concurrency 1, `every: WORKFLOW_OUTBOX_POLL_INTERVAL_MS`                                 | Mirrors `TriggerScheduler` blueprint (`apps/workflow-engine/src/services/trigger-scheduler.ts:57-135`). BullMQ guarantees single active runner of a repeatable job across replicas.                        | Raw Redis `SET NX PX` lock (reinvents BullMQ semantics); cron library (no horizontal scale); Kubernetes singleton Deployment (harder to roll).             |
| D-6 | Feature flags as `process.env` reads consolidated in `apps/workflow-engine/src/outbox/flag-gates.ts` pure function                                                                                  | Repo has zero GrowthBook/Unleash usage server-side. All 12 `process.env.WORKFLOW_*` refs are plain env reads. Pure function keeps UT-07 trivial.                                                           | GrowthBook (not deployed server-side); `packages/config` (over-engineered for binary flags); inline `process.env` reads (scatters flag truth).             |
| D-7 | Make `EventCascadeHook.deleteByExecutionIds` **optional** (`?`)                                                                                                                                     | Backward-compatible for existing consumers (`apps/runtime/src/services/eventstore-singleton.ts` hook impl never implemented this method). Caller uses `hook.deleteByExecutionIds?.(…)`.                    | Required method forces immediate update of every existing hook implementation (scope creep, breaks CLAUDE.md additive-commit rule).                        |
| D-8 | Test-diagnostic endpoints live at `apps/workflow-engine/src/routes/test-diagnostic.ts` + `apps/runtime/src/routes/test-diagnostic.ts`; mounted via dynamic `import()` gated on `NODE_ENV=test` only | Matches test-spec §10 contract verbatim. Dynamic import keeps test-only code out of production bundle. Both services need endpoints (workflow-engine for outbox/Mongo inspection, runtime for CH queries). | Single service hosts all test endpoints (forces cross-service fetches); compile-time feature flag (still ships code to prod bundle).                       |

### 1.2 Key Interfaces & Types

**New in `packages/eventstore/src/schema/events/workflow-execution-events.ts`:**

```typescript
import { z } from 'zod';
import { EventRegistry } from '../event-registry.js';

export const WorkflowExecutionEventTypeSchema = z.enum([
  'workflow.execution.started',
  'workflow.execution.step_started',
  'workflow.execution.step_completed',
  'workflow.execution.completed',
  'workflow.execution.failed',
  'workflow.execution.cancelled',
]);
export type WorkflowExecutionEventType = z.infer<typeof WorkflowExecutionEventTypeSchema>;

export const WorkflowExecutionEventSchema = z
  .object({
    event_id: z.string().min(1), // UUIDv7
    event_type: WorkflowExecutionEventTypeSchema,
    event_version: z.string().default('1.0.0'),
    occurred_at: z.string(), // ISO-8601 DateTime64(3,'UTC')
    tenant_id: z.string().min(1),
    project_id: z.string().min(1),
    execution_id: z.string().min(1),
    workflow_id: z.string().min(1),
    workflow_version: z.string().min(1),
    status: z.string().min(1),
    trigger_type: z.string().min(1),
    step_id: z.string().nullable().optional(),
    step_name: z.string().nullable().optional(),
    step_type: z.string().nullable().optional(),
    // step status is encoded in event_type (step_started / step_completed);
    // no separate column needed per HLD §5.3 DDL.
    started_at: z.string().nullable().optional(),
    completed_at: z.string().nullable().optional(),
    duration_ms: z.number().int().nullable().optional(),
    error_code: z.string().nullable().optional(),
    error_message: z.string().nullable().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .passthrough(); // FR-12 forward compatibility

export type WorkflowExecutionEvent = z.infer<typeof WorkflowExecutionEventSchema>;

/**
 * Registers one entry per enum value — the EventRegistry stores schemas in a
 * `Map<string, ZodSchema>` with no wildcard resolution (see
 * `packages/eventstore/src/schema/event-registry.ts:43`). A single wildcard
 * string like `workflow.execution.*` would register a literal key that never
 * matches incoming events.
 */
export function registerWorkflowExecutionEvents(registry: EventRegistry): void {
  for (const eventType of WorkflowExecutionEventTypeSchema.options) {
    registry.register(eventType, WorkflowExecutionEventSchema, {
      version: '1.0.0',
      category: 'workflow',
      containsPII: true,
    });
  }
}
```

**New in `packages/eventstore/src/schema/events/human-task-events.ts`:**

```typescript
export const HumanTaskEventSchema = z
  .object({
    event_id: z.string().min(1),
    event_type: z.enum([
      'human_task.created',
      'human_task.assigned',
      'human_task.approved',
      'human_task.rejected',
      'human_task.cancelled',
      'human_task.expired',
    ]),
    event_version: z.string().default('1.0.0'),
    occurred_at: z.string(),
    tenant_id: z.string().min(1),
    project_id: z.string().min(1),
    task_id: z.string().min(1),
    execution_id: z.string().min(1),
    workflow_id: z.string().min(1),
    workflow_version: z.string().min(1),
    mailbox: z.literal('workflow'), // HLD §5 — scope (other mailboxes are NOT in scope)
    status: z.string().min(1),
    assignees: z.array(z.string()).default([]),
    approvers: z.array(z.string()).default([]),
    policy: z.record(z.unknown()).optional(),
    payload: z.record(z.unknown()).optional(),
    outcome: z.string().nullable().optional(),
    outcome_by: z.string().nullable().optional(),
    decided_at: z.string().nullable().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .passthrough();
```

**Extended in `packages/database/src/cascade/event-cascade-hooks.ts`:**

```typescript
export interface EventCascadeHook {
  deleteBySessionIds: (tenantId: string, sessionIds: string[]) => Promise<void>;
  deleteTenant: (tenantId: string) => Promise<void>;
  /** NEW — optional for backward compat; called by workflow-engine GDPR cascade. */
  deleteByExecutionIds?: (tenantId: string, executionIds: string[]) => Promise<void>;
}
```

**New in `packages/database/src/models/workflow-event-outbox.model.ts`:**

```typescript
import mongoose, { Schema, type InferSchemaType } from 'mongoose';

const WorkflowEventOutboxSchema = new Schema(
  {
    // _id is the event_id (UUIDv7) generated by buildOutboxPayload — NOT
    // auto-generated. This diverges from the repo convention of
    // `default: uuidv7` because the outbox row's id must equal the Kafka
    // event_id it publishes (dedup contract in §4 concern #7).
    _id: { type: String, required: true },
    tenantId: { type: String, required: true, index: true },
    projectId: { type: String, required: true },
    entityKind: {
      type: String,
      required: true,
      enum: ['workflow_execution', 'human_task'],
      index: true,
    },
    entityId: { type: String, required: true, index: true },
    topic: { type: String, required: true },
    eventType: { type: String, required: true },
    eventVersion: { type: String, required: true, default: '1.0.0' },
    occurredAt: { type: Date, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    publishedAt: { type: Date, default: null, index: true },
    lastError: { type: String, default: null },
    retryCount: { type: Number, default: 0 },
    expiresAt: { type: Date, default: null }, // set when publishedAt set
  },
  { timestamps: true, collection: 'workflow_event_outbox' },
);

// Poller hot-path index — covers "unpublished, oldest first" query
WorkflowEventOutboxSchema.index(
  { occurredAt: 1 },
  { partialFilterExpression: { publishedAt: null } },
);

// TTL — only expires published rows (partial filter preserves unpublished indefinitely)
WorkflowEventOutboxSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, partialFilterExpression: { publishedAt: { $ne: null } } },
);

// Per-entity ordering / dedup lookup
WorkflowEventOutboxSchema.index({ tenantId: 1, entityKind: 1, entityId: 1, occurredAt: 1 });

export type WorkflowEventOutboxDoc = InferSchemaType<typeof WorkflowEventOutboxSchema>;

export const WorkflowEventOutboxModel =
  mongoose.models.WorkflowEventOutbox ??
  mongoose.model<WorkflowEventOutboxDoc>('WorkflowEventOutbox', WorkflowEventOutboxSchema);
```

**New in `apps/workflow-engine/src/outbox/flag-gates.ts`:**

```typescript
export interface WorkflowEventSourcingFlags {
  outboxEnabled: boolean;
  chSinkEnabled: boolean;
  dualReadEnabled: boolean;
  mongoTtlEnabled: boolean;
}

export function readFlags(env: NodeJS.ProcessEnv = process.env): WorkflowEventSourcingFlags {
  return {
    outboxEnabled: env.WORKFLOW_OUTBOX_ENABLED === 'true',
    chSinkEnabled: env.WORKFLOW_CH_SINK_ENABLED === 'true',
    dualReadEnabled: env.WORKFLOW_DUAL_READ_ENABLED === 'true',
    mongoTtlEnabled: env.WORKFLOW_MONGO_TTL_ENABLED === 'true',
  };
}
```

### 1.3 Module Boundaries

| Module                                                        | Responsibility                                           | Depends On                                                                                                     |
| ------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `packages/database` (WorkflowEventOutboxModel)                | Outbox persistence schema + indexes                      | mongoose                                                                                                       |
| `packages/database` (EventCascadeHook extension)              | GDPR cascade interface                                   | — (additive, zero deps)                                                                                        |
| `packages/eventstore` (Zod schemas + EventRegistry)           | Event type validation + registration                     | `EventRegistry`, zod                                                                                           |
| `packages/eventstore` (CH DDL constants + init function)      | ClickHouse schema provisioning                           | `@clickhouse/client` types only                                                                                |
| `packages/eventstore` (`KafkaEventQueue.publishAndAck`)       | ACK-awaitable topic-routed Kafka publish                 | existing `Producer` instance                                                                                   |
| `apps/workflow-engine/outbox/*`                               | Outbox writer + poller + flag gates + payload builder    | `@agent-platform/database`, `@agent-platform/eventstore`, `@agent-platform/shared` (`withTransaction`), BullMQ |
| `apps/workflow-engine/persistence/*` (session API)            | ExecutionStore + HumanTaskStore session support          | mongoose                                                                                                       |
| `apps/workflow-engine/persistence/dual-read-merger.ts`        | Pure function: UNION(Mongo, CH) with Mongo-wins dedup    | none                                                                                                           |
| `apps/workflow-engine/persistence/hybrid-execution-reader.ts` | Gated read router                                        | `ExecutionStore`, CH client, flag gates                                                                        |
| `apps/runtime/services/workflow-events-consumer.ts`           | Kafka consumer + CH sink + EventCascadeHook registration | `KafkaEventQueue`, `BufferedClickHouseWriter`, `registerEventCascadeHook`                                      |
| `apps/runtime/services/hybrid-human-task-reader.ts`           | Gated read router for `mailbox=workflow`                 | `HumanTaskModel`, CH client, flag gates                                                                        |
| `apps/*/routes/test-diagnostic.ts`                            | Test-only endpoints (NODE_ENV=test gated)                | respective models + clients                                                                                    |
| `tools/test-infra/parity-check.ts`                            | Offline CLI: Mongo↔CH drift sampler                      | `@agent-platform/database`                                                                                     |

## 2. File-Level Change Map

### 2.1 New Files (15)

| File                                                                           | Package                | Purpose                                                             | LOC  |
| ------------------------------------------------------------------------------ | ---------------------- | ------------------------------------------------------------------- | ---- |
| `packages/database/src/models/workflow-event-outbox.model.ts`                  | `packages/database`    | Mongoose model + indexes + TTL                                      | ~80  |
| `packages/eventstore/src/schema/events/workflow-execution-events.ts`           | `packages/eventstore`  | Zod schema + EventRegistry registration                             | ~80  |
| `packages/eventstore/src/schema/events/human-task-events.ts`                   | `packages/eventstore`  | Zod schema + EventRegistry registration                             | ~80  |
| `packages/eventstore/src/stores/clickhouse/workflow-execution-events-table.ts` | `packages/eventstore`  | CH DDL constants (raw table, latest projection, MV)                 | ~120 |
| `packages/eventstore/src/stores/clickhouse/human-task-events-table.ts`         | `packages/eventstore`  | CH DDL constants (raw table, latest projection, MV)                 | ~120 |
| `packages/eventstore/src/stores/clickhouse/init-workflow-event-tables.ts`      | `packages/eventstore`  | `initWorkflowEventTables(client)` startup fn                        | ~40  |
| `apps/workflow-engine/src/outbox/flag-gates.ts`                                | `apps/workflow-engine` | Pure function reading 4 env flags                                   | ~25  |
| `apps/workflow-engine/src/outbox/workflow-event-outbox-writer.ts`              | `apps/workflow-engine` | `WorkflowEventOutboxWriter` — tx-aware write + `buildOutboxPayload` | ~120 |
| `apps/workflow-engine/src/outbox/outbox-poller.ts`                             | `apps/workflow-engine` | BullMQ repeatable poller + publish loop                             | ~200 |
| `apps/workflow-engine/src/persistence/dual-read-merger.ts`                     | `apps/workflow-engine` | Pure function — UNION Mongo+CH, Mongo-wins dedup                    | ~80  |
| `apps/workflow-engine/src/persistence/hybrid-execution-reader.ts`              | `apps/workflow-engine` | Gated read router                                                   | ~100 |
| `apps/workflow-engine/src/routes/test-diagnostic.ts`                           | `apps/workflow-engine` | NODE_ENV=test endpoints (outbox/inspect, force-publish)             | ~180 |
| `apps/runtime/src/services/workflow-events-consumer.ts`                        | `apps/runtime`         | Kafka consumer → CH via `BufferedClickHouseWriter`                  | ~220 |
| `apps/runtime/src/services/hybrid-human-task-reader.ts`                        | `apps/runtime`         | Gated read router (mailbox='workflow')                              | ~100 |
| `apps/runtime/src/routes/test-diagnostic-workflow.ts`                          | `apps/runtime`         | NODE_ENV=test CH query + consumer controls endpoints                | ~180 |
| `tools/test-infra/parity-check.ts`                                             | `tools/`               | CLI — sample Mongo + CH, diff, report                               | ~180 |

### 2.2 Modified Files (11)

| File (verified exists)                                                                  | Change                                                                                                                                                                               | Risk                                                     |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| `apps/workflow-engine/src/persistence/execution-store.ts`                               | Add `options?: { session?: ClientSession }` to `createExecution`, `updateStepStatus`, `updateExecutionStatus`; thread `session` into Mongoose `updateOne`/`findOneAndUpdate` options | **High** — Phase 1 only, zero behavior change. See §6.1. |
| `apps/workflow-engine/src/persistence/human-task-store.ts`                              | Add `options?: { session?: ClientSession }` to `createTask`, `updateTaskStatus`                                                                                                      | Med                                                      |
| `packages/eventstore/src/queues/kafka-queue.ts`                                         | Add `publishAndAck(topic: string, event: unknown, key?: string): Promise<void>`                                                                                                      | Low (additive)                                           |
| `packages/database/src/cascade/event-cascade-hooks.ts`                                  | Add optional `deleteByExecutionIds` to `EventCascadeHook` interface                                                                                                                  | Low (additive)                                           |
| `packages/database/src/models/index.ts`                                                 | Export `WorkflowEventOutboxModel`                                                                                                                                                    | Low                                                      |
| `apps/runtime/src/services/eventstore-singleton.ts`                                     | Register workflow-specific `EventCascadeHook` impl with `deleteByExecutionIds` that drops CH rows by execution_id                                                                    | Med                                                      |
| `apps/workflow-engine/src/routes/workflow-executions.ts`                                | Inject & use `HybridExecutionReader` for GET list/detail endpoints                                                                                                                   | Med                                                      |
| `apps/runtime/src/routes/human-tasks.ts` (or equivalent inbox route file)               | Inject & use `HybridHumanTaskReader` for GET endpoints when `mailbox === 'workflow'` with no-op for other mailboxes                                                                  | Med                                                      |
| `apps/workflow-engine/src/index.ts`                                                     | Bootstrap `OutboxPoller` under `WORKFLOW_OUTBOX_ENABLED`; dynamic-import test-diagnostic routes when `NODE_ENV=test`                                                                 | Med                                                      |
| `apps/runtime/src/server.ts`                                                            | Bootstrap `WorkflowEventsConsumer` under `WORKFLOW_CH_SINK_ENABLED`; call `initWorkflowEventTables` at startup; dynamic-import test-diagnostic routes when `NODE_ENV=test`           | Med                                                      |
| `apps/studio/src/components/inbox/UnifiedInboxPage.tsx` (path verified at test-spec §4) | Add status filter (default `pending`) + "Show completed" toggle + `requestedAt` sort                                                                                                 | Low                                                      |

### 2.3 Deleted Files

**None.** The feature is fully additive — no exports are removed. Per CLAUDE.md export-removal guard and the feat() deletion-ratio guard, all 6 phases commit as `feat()` with <5% deletions.

## 3. Implementation Phases

CRITICAL: Each phase is independently deployable behind its own flag(s) and leaves the system in a fully working state. Flag defaults are all `false` — enabling flags is a deployment-config change in `abl-platform-deploy`, not a code change.

---

### Phase 1 — Infrastructure Gaps (P1)

**Goal**: Resolve HLD §3.6 Gap 1 (ExecutionStore session API) and Gap 2 (topic-routed ACK-awaitable Kafka publish) as isolated, zero-behavior-change refactors. No callers changed; no new feature behavior.

**Tasks**:

- 1.1. Add `options?: { session?: ClientSession }` as the last parameter to `ExecutionStore.createExecution`, `ExecutionStore.updateStepStatus`, `ExecutionStore.updateExecutionStatus`. Thread `options?.session` into the Mongoose `updateOne`/`findOneAndUpdate` options object at each existing call site. **Critical**: `createExecution` today passes `{ upsert: true }` — the session must be **merged**, not replaced: `{ upsert: true, ...(options?.session ? { session: options.session } : {}) }`. Same pattern for any other method that already carries options. Extend `WorkflowExecutionModel.create` signature typing to accept optional `options` (Mongoose already supports this).
- 1.2. Add `options?: { session?: ClientSession }` to `MongoHumanTaskStore.createTask` and `MongoHumanTaskStore.updateTaskStatus`. Same threading pattern as 1.1. **Three Mongoose-specific caveats the implementer MUST apply**:
  - `createTask` currently calls `HumanTask.create(doc)` (single-doc form). Mongoose's single-document `Model.create()` does NOT accept a session option. Convert to the array overload: `HumanTask.create([doc], options?.session ? { session: options.session } : undefined)`.
  - `updateTaskStatus` today filters `{ _id: taskId, tenantId }` but is missing `projectId` — a pre-existing isolation gap. Since this commit is already modifying the signature, fix in the same refactor: add `projectId: string` as a parameter and include it in the `findOneAndUpdate` filter. **The blast radius is 5 call-sites + 2 interface definitions**, all of which MUST be updated in this single commit:
    - `apps/workflow-engine/src/handlers/workflow-handler.ts` (2 call-sites, ~lines 1064, 1122)
    - `apps/workflow-engine/src/handlers/workflow-approvals.ts` (1 call-site, ~line 252)
    - `apps/workflow-engine/src/handlers/human-task-resolution.ts` (1 call-site, ~line 137)
    - `HumanTaskStoreLike` interface at `apps/workflow-engine/src/persistence/human-task-store.ts:51`
    - `HumanTaskStore` interface at `apps/workflow-engine/src/handlers/workflow-handler.ts:201`
  - **Source-path caveat**: `workflow-approvals.ts` and `human-task-resolution.ts` locate the task via `findBySource` which currently returns `{ taskId, tenantId }` only (no `projectId`). The implementer picks one of two options, documented in the commit: **(a)** extend `findBySource` return to include `projectId` (preferred — single source of truth), or **(b)** thread `req.params.projectId` from the calling route. Option (a) is the better fix; option (b) is acceptable if `findBySource` is tightly tested and a return-shape change would cascade.
  - **Exit criterion for this task**: `rg 'updateTaskStatus\(' apps/workflow-engine/src/` shows every caller passes `projectId` as the second parameter AND `rg '\.findOneAndUpdate\(\{[^}]*taskId[^}]*\}' apps/workflow-engine/src/persistence/human-task-store.ts` includes `projectId` in the filter.
- 1.3. Add `publishAndAck(topic: string, event: unknown, key?: string): Promise<void>` method to `KafkaEventQueue`. Implementation: `await this.producer.send({ topic, messages: [{ key: resolvedKey, value: JSON.stringify(event) }], acks: -1 })`. Key resolution reuses the existing partition-key pattern from `enqueue()` (lines 110-113). Increment/decrement `pendingMessages` around the `await` for observability parity with `enqueue`.
- 1.4. Add unit test `packages/eventstore/src/queues/__tests__/kafka-queue.publish-and-ack.test.ts` using DI — pass a fake `Producer` that records `send()` calls and resolves/rejects on demand. Test acks-required semantics, key derivation, and error propagation.
- 1.5. Add unit test `apps/workflow-engine/src/persistence/__tests__/execution-store.session.test.ts` — verifies `options.session` is passed through to the underlying Mongoose model. Uses a **DI test double** (the `WorkflowExecutionModel` interface allows DI per CLAUDE.md Test Architecture rule 5; this is injection-via-constructor, not `vi.mock()` of a platform module). No `MongoMemoryServer` needed for this unit-level check — the threading contract is testable with a recording double.

**Files Touched**:

- `apps/workflow-engine/src/persistence/execution-store.ts` — add optional session param on 3 methods (already accepts `options?: Record<string, unknown>` on the model interface lines 19, 24)
- `apps/workflow-engine/src/persistence/human-task-store.ts` — add optional session param on 2 methods
- `packages/eventstore/src/queues/kafka-queue.ts` — add `publishAndAck` method
- 2 new test files

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/workflow-engine --filter=@agent-platform/eventstore` passes with 0 errors.
- [ ] All existing `apps/workflow-engine` tests pass with zero regressions (`pnpm --filter=@agent-platform/workflow-engine test`).
- [ ] All existing `packages/eventstore` tests pass (`pnpm --filter=@agent-platform/eventstore test`).
- [ ] `publishAndAck` unit test: at least 3 cases — success path, failure rejects promise, `acks: -1` assert.
- [ ] `execution-store.session` unit test: `session` object forwarded into model options on all 3 methods.
- [ ] `git diff --stat` shows `deletions < 5%` (satisfies deletion-ratio guard for feat commits; these two tasks will actually commit as `refactor()` given the zero-behavior change intent — see Commit Discipline below).

**Test Strategy**:

- **Unit**: DI-based `Producer` stub and `WorkflowExecutionModel` stub — no mocks of platform components, only DI of test doubles (CLAUDE.md §Test Architecture rule 5).
- **Integration**: None — the methods are not yet wired to anything new.

**Rollback**: `git revert` both commits. Zero production impact because no caller invokes the new method or passes the session option.

**Commits**:

1. `[ABLP-2] refactor(workflow-engine): add optional session param to ExecutionStore + MongoHumanTaskStore methods` (§1.1 + §1.2 + unit test)
2. `[ABLP-2] feat(eventstore): add publishAndAck to KafkaEventQueue for topic-routed ACK-awaitable publish` (§1.3 + unit test)

---

### Phase 2 — Schema + Models (P2)

**Goal**: Land all data-layer artifacts (Mongo outbox model, CH DDL, Zod schemas, EventRegistry registration, flag gates) with unit tests. No write path, no consumer wired yet.

**Tasks**:

- 2.1. Create `packages/database/src/models/workflow-event-outbox.model.ts` per §1.2 above. Export from `packages/database/src/models/index.ts`.
- 2.2. Create `packages/eventstore/src/schema/events/workflow-execution-events.ts` (Zod schema + `registerWorkflowExecutionEvents`). Use `.passthrough()` for FR-12. **Registration-pattern note**: most existing event files in this directory (e.g., `channel-events.ts`, `agent-events.ts`) register with the global `eventRegistry` singleton as a module-level side effect, imported via the `index.ts` barrel. This LLD deliberately uses an explicit `registerWorkflowExecutionEvents(registry)` function (called from `apps/runtime/src/services/eventstore-singleton.ts` per wiring §4) because (a) these workflow events are flat objects, not `PlatformEvent.data` envelopes, so consumer validation bypasses `EventRegistry.validate()` and uses Zod directly (see §4.1); (b) the registry entry is retained only for GDPR/PII metadata lookup (`getPIIEventTypes`). Add an explanatory comment at the top of the file explaining this deliberate divergence. Update `packages/eventstore/src/schema/events/index.ts` barrel to re-export the new schemas + `registerWorkflowExecutionEvents` so runtime can import both from the single barrel.
- 2.3. Create `packages/eventstore/src/schema/events/human-task-events.ts` (Zod schema + `registerHumanTaskEvents`). Includes `mailbox: z.literal('workflow')` scope guard. **`registerHumanTaskEvents` MUST loop over each of the 6 human-task event types individually** (same pattern as `registerWorkflowExecutionEvents` in §1.2) — `EventRegistry.register()` does not support wildcard keys.
- 2.4. Create `packages/eventstore/src/stores/clickhouse/workflow-execution-events-table.ts`. Export 3 DDL constants: `WORKFLOW_EXECUTION_EVENTS_TABLE_DDL`, `WORKFLOW_EXECUTIONS_LATEST_TABLE_DDL`, `WORKFLOW_EXECUTIONS_LATEST_MV_DDL`. Column list per HLD §5.3. MV uses per-row projection with `_version = toUnixTimestamp64Milli(occurred_at)` (HLD §5.3 corrected DDL).
- 2.5. Create `packages/eventstore/src/stores/clickhouse/human-task-events-table.ts` with 3 DDL constants matching the pattern above. MV WHERE clause includes `WHERE mailbox = 'workflow'` (HLD §5.3 errata E-5).
- 2.6. Create `packages/eventstore/src/stores/clickhouse/init-workflow-event-tables.ts`. Exports `initWorkflowEventTables(client: ClickHouseClient): Promise<void>` that runs all 6 DDLs idempotently (pattern from `initAnalyticsTables` at `packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts:935`).
- 2.7. Create `apps/workflow-engine/src/outbox/flag-gates.ts` per §1.2 above.
- 2.8. Unit tests (test-spec canonical numbering — see test-spec §7):
  - `packages/eventstore/src/schema/events/__tests__/workflow-execution-events.test.ts` — **UT-01** (Workflow Event Zod Schema Round-Trip): round-trip serialization, FR-12 unknown-field passthrough.
  - `packages/eventstore/src/schema/events/__tests__/human-task-events.test.ts` — same UT-01 coverage + `mailbox` literal enforcement (human-task variant).
  - `apps/workflow-engine/src/outbox/__tests__/flag-gates.test.ts` — **UT-03** (Flag-Gate Predicate): 16-combination matrix over 4 flags.

**Files Touched**: 7 new files, 1 modified (`packages/database/src/models/index.ts` export).

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/database --filter=@agent-platform/eventstore --filter=@agent-platform/workflow-engine` passes.
- [ ] `UT-01` (event-payload serialization round-trip for workflow + human-task schemas, FR-12 passthrough) passes.
- [ ] `UT-03` (flag-gate 16-combination matrix) passes — all 16 combinations return the expected `{outboxEnabled, chSinkEnabled, dualReadEnabled, mongoTtlEnabled}` tuple.
- [ ] Outbox model indexes verified via `MongoMemoryReplSet` test: `db.workflow_event_outbox.getIndexes()` returns 3 expected indexes (poller-hot-path, TTL, per-entity-ordering).
- [ ] CH DDL template-literal validity verified via a dry-run integration test that calls `initWorkflowEventTables` against the dockerized ClickHouse and asserts `SELECT COUNT(*) FROM system.tables WHERE name LIKE 'workflow_%' OR name LIKE 'human_task%'` returns 6 rows (3 per entity).
- [ ] No caller invokes these modules yet — `rg 'WorkflowEventOutboxModel|publishAndAck|readFlags' apps/` returns only the test files from Phase 1 + Phase 2.

**Test Strategy**:

- **Unit**: Zod schema tests (zero mocks, pure function tests). Flag-gate tests inject a fake `env` object.
- **Integration**: CH DDL dry-run against real ClickHouse (docker-compose). Verify idempotency: run `initWorkflowEventTables` twice — second call is a no-op.

**Rollback**: `git revert` the Phase 2 commits. No production state touched (models not called; DDL not provisioned; flags default to `false`).

**Commits** (one per commit scope):

3. `[ABLP-2] feat(database): add workflow-event-outbox mongoose model + indexes` (§2.1)
4. `[ABLP-2] feat(eventstore): add workflow + human-task event zod schemas and registry registration` (§2.2 + §2.3 + UT-01 Zod round-trip test)
5. `[ABLP-2] feat(eventstore): add clickhouse DDL for workflow-event-sourcing tables + init function` (§2.4–§2.6)
6. `[ABLP-2] feat(workflow-engine): add feature-flag gate helper for event-sourcing flags` (§2.7 + UT-03 flag-gate matrix test)
7. `[ABLP-2] chore(infra): add Kafka topics (abl.workflow.execution, abl.human.task) + env vars to docker-compose + env.example` (§5.3 topic provisioning)

---

### Phase 3 — Write Path (P3)

**Goal**: Implement the Phase A write-path: domain write + outbox write in a single Mongo transaction → background BullMQ poller → `publishAndAck` to Kafka. Gated on `WORKFLOW_OUTBOX_ENABLED`.

**Tasks**:

- 3.1. Create `apps/workflow-engine/src/outbox/workflow-event-outbox-writer.ts`. Exports:
  - `buildOutboxPayload(event: WorkflowEvent | HumanTaskEvent): WorkflowEventOutboxDoc` — pure function. Generates `event_id` (UUIDv7) and snapshots `workflowVersion`/`tenant_id`/`project_id` into the payload.
  - `class WorkflowEventOutboxWriter` with `writeWithSession(outboxDocs: WorkflowEventOutboxDoc[], session: ClientSession | null): Promise<void>`. **Nullable session**: `withTransaction` (see §3.2) passes `null` when `canUseTransactions()` returns false (standalone Mongo — e.g., dev without replica set). When `session === null`, the writer still persists via `WorkflowEventOutboxModel.insertMany(docs)` (non-transactional, best-effort atomicity). Production runs on replica set and will always get a real session; standalone fallback exists so local dev without replica set doesn't crash.
- 3.2. Wire `WorkflowEventOutboxWriter` into workflow execution and human-task state transitions using the **existing** `withTransaction` utility (`packages/shared/src/repos/mongo-tx.ts`). **Call-site locations**: the `withTransaction(async (session) => …)` block lives in the **workflow handler call-sites**, NOT inside the outbox writer. Specifically: `apps/workflow-engine/src/handlers/workflow-handler.ts` (wherever `executionStore.createExecution` / `updateStepStatus` / `updateExecutionStatus` are invoked today) and the human-task handler (wherever `humanTaskStore.createTask` / `updateTaskStatus` are invoked). The writer stays a thin persistence wrapper; the transaction scope belongs to the handler so domain writes + outbox writes commit together. DO NOT reinvent transaction management — `withTransaction`:
  - Auto-detects replica-set support via `canUseTransactions()`, falls back to non-transactional on standalone Mongo.
  - Uses Mongoose's `session.withTransaction()` which auto-retries on `TransientTransactionError` and `UnknownTransactionCommitResult`.
  - Already used by `apps/runtime/src/services/workflow-version-service.ts:592,888`.

  Wiring shape (gated on `readFlags().outboxEnabled` — when `false`, skip the tx wrapper and use the existing non-transactional path):

  ```typescript
  import { withTransaction } from '@agent-platform/shared/repos';

  await withTransaction(async (session) => {
    const opts = session ? { session } : {};
    await executionStore.createExecution(input, opts);
    await outboxWriter.writeWithSession(buildOutboxPayload(event), session);
  });
  ```

  The outbox writer module gains `@agent-platform/shared` as a dependency (update §1.3 Module Boundaries accordingly).

- 3.3. Create `apps/workflow-engine/src/outbox/outbox-poller.ts`. `OutboxPoller` class:
  - Constructor takes `redis: Redis`, `model: typeof WorkflowEventOutboxModel`, `kafkaQueue: KafkaEventQueue`, `logger`.
  - `start()` creates BullMQ `Queue` `workflow-outbox-publisher` + `Worker` with concurrency 1; registers repeatable job with `{ repeat: { every: WORKFLOW_OUTBOX_POLL_INTERVAL_MS }, removeOnComplete: { count: 50 }, removeOnFail: { count: 200 } }` — `removeOn*` options are required to prevent Redis memory growth from accumulated job records (matches `TriggerScheduler` convention at `trigger-scheduler.ts:113-114`). Redis `duplicate({ maxRetriesPerRequest: null })` for BullMQ compat — copy `trigger-scheduler.ts:71-72` pattern.
  - Job handler batches (batch size = `WORKFLOW_OUTBOX_BATCH_SIZE=100`), publishes via `kafkaQueue.publishAndAck(doc.topic, doc.payload, String(doc.tenantId))`, then marks `{ publishedAt: new Date(), expiresAt: <publishedAt + WORKFLOW_OUTBOX_TTL_HOURS> }`.
  - Failure path: increment `retryCount`, set `lastError`, leave `publishedAt: null`.
  - `shutdown()` closes worker, queue, and both Redis duplicates (copy `trigger-scheduler.ts:168-176`).
- 3.4. Add workflow-specific `EventCascadeHook` impl stub — Phase 3 registers a hook whose `deleteByExecutionIds` is a no-op (CH cascade implemented in Phase 4). This keeps cascade interface extension live but defers actual CH deletion.
- 3.5. Bootstrap in `apps/workflow-engine/src/index.ts`: create `OutboxPoller` instance post-mongo/redis connect; call `.start()` if `readFlags().outboxEnabled`. Register `process.on('SIGTERM')` hook to call `.shutdown()`.
- 3.6. Add `apps/workflow-engine/src/routes/test-diagnostic.ts` (Phase 3 slice): `GET /api/admin/test/workflow-outbox`, `POST /api/admin/test/workflow-outbox/force-publish`, `GET /api/admin/test/workflow-executions/:id/mongo-raw` (matching test-spec §10.1, §10.2, §10.3). Gated on `NODE_ENV === 'test'` — dynamic `import()` in `index.ts` conditional on the env check. **Auth stack**: every route MUST mount behind the existing `[createUnifiedAuthMiddleware, requireAuth]` middleware stack — test-spec §10 explicitly requires "same auth middleware (no bypass)". All Mongo queries MUST include `tenantId` from `req.tenantContext` (Core Invariant #1). No unauthenticated endpoints, even in test.
- 3.7. **Trace events + metrics for write path (shipped with this phase, NOT deferred to P4)**:
  - **Trace events** via existing `TraceStore`: every outbox row published by `OutboxPoller` emits `{ category: 'workflow', event_type: 'workflow.outbox.published', data: { event_id, entity_kind, topic, latency_ms, attempt } }`. Every outbox write emits `{ event_type: 'workflow.outbox.enqueued', data: { event_id, entity_kind } }`. No ad-hoc logging substitutes.
  - **Prometheus metrics** via `@agent-platform/shared-observability` (matches existing workflow-engine observability at `apps/workflow-engine/src/index.ts:44`): `OutboxPoller` emits `workflow_outbox_unpublished_rows` (gauge, sampled each poll cycle via `countDocuments({ publishedAt: null })`), `workflow_outbox_publish_latency_ms` (histogram, each `publishAndAck` call), `workflow_outbox_publish_failures_total` (counter, each failure).
  - Rationale: Phase 3 is independently deployable via `WORKFLOW_OUTBOX_ENABLED=true`; shipping the write path without traces or metrics violates CLAUDE.md Core Invariant #4 and blocks production rollout gating (§5.2 rollout depends on these gauges).

**Files Touched**:

- 3 new files (outbox-writer, outbox-poller, test-diagnostic)
- 3 modified (workflow handler call-sites for transaction wrapping, `apps/workflow-engine/src/index.ts`, `apps/runtime/src/services/eventstore-singleton.ts` for hook stub — actually the hook registration lives in runtime, so this touches the runtime file too)

**Exit Criteria**:

- [ ] `INT-01` (Atomicity — Outbox + Domain in Same Transaction) passes with `MongoMemoryReplSet`.
- [ ] `INT-02` (Publisher Failure — Leader Election + Retry) passes.
- [ ] `UT-06` (EventCascadeHook compat — existing hook still works with optional new method undefined) passes.
- [ ] `GET /api/admin/test/workflow-outbox` returns outbox rows with pagination when called with `NODE_ENV=test`; returns 404 when `NODE_ENV=production`.
- [ ] With `WORKFLOW_OUTBOX_ENABLED=false`, existing workflow-engine tests show zero regressions.
- [ ] With `WORKFLOW_OUTBOX_ENABLED=true`, a workflow execution E2E still completes end-to-end (CH sink not yet consuming — Kafka backlog grows but no errors).

**Test Strategy**:

- **Unit**: `buildOutboxPayload` pure function tests. `outbox-poller` batch-publish tests with DI'd `KafkaEventQueue` fake.
- **Integration**: `INT-01` uses `MongoMemoryReplSet` (transactions require replica set). `INT-02` uses real Redis + dockerized Kafka (`docker-compose`).
- **No mocks of platform components.** The `KafkaEventQueue` used in integration tests is real; only in unit tests is it replaced via constructor DI with a fake Producer.

**Rollback**: Flip `WORKFLOW_OUTBOX_ENABLED=false` — poller stops writing, writer falls back to non-transactional path. If a worse rollback is needed, `git revert` Phase 3 commits (Phase 1 + Phase 2 remain safe; they have no behavioral impact with flags off).

**Kafka accumulation between P3 and P4**: When Phase 3 deploys with `WORKFLOW_OUTBOX_ENABLED=true` but Phase 4's consumer is NOT yet deployed, the outbox poller publishes to Kafka and nothing drains. Kafka topic retention is 7 days. Expected accumulation at peak (5M events/day) is ~35M messages (~10.5 GB at 300 bytes/msg) — bounded and manageable. Published outbox rows themselves expire after `WORKFLOW_OUTBOX_TTL_HOURS=72` via the TTL index, so the outbox Mongo collection stays small. This is expected behavior; drain happens when Phase 4 deploys and `WORKFLOW_CH_SINK_ENABLED=true`.

**Commits**:

8. `[ABLP-2] feat(workflow-engine): add transactional workflow-event outbox writer + payload builder` (§3.1)
9. `[ABLP-2] feat(workflow-engine): wire outbox writer into execution and human-task state transitions` (§3.2 — gated on outbox flag)
10. `[ABLP-2] feat(workflow-engine): add BullMQ repeatable outbox poller` (§3.3 + §3.5)
11. `[ABLP-2] feat(workflow-engine): add test-diagnostic outbox endpoints` (§3.6)
12. `[ABLP-2] test(workflow-engine): add INT-01 atomicity + INT-02 leader-election tests + UT-06 cascade compat` (§3 tests)

---

### Phase 4 — Consume + Sink (P4)

**Goal**: Implement the Kafka consumer that drains the outbox's Kafka topics and batches writes into ClickHouse via `BufferedClickHouseWriter`. Provision CH DDL at startup. Wire GDPR cascade. Gated on `WORKFLOW_CH_SINK_ENABLED`.

**Tasks**:

- 4.1. Create `apps/runtime/src/services/workflow-events-consumer.ts`. `WorkflowEventsConsumer` class:
  - Constructor accepts `ClickHouseClient`, `logger`, and either (a) two pre-built `KafkaEventQueue` instances or (b) construction config to build them internally. Each `KafkaEventQueue` instance targets one topic — `abl.workflow.execution` or `abl.human.task` (canonical topic names per HLD §3.3 and feature-spec FR-3).
  - **Kafka consumer group IDs MUST be explicit per instance** to avoid rebalancing collisions: `workflow-execution-consumer` for the `abl.workflow.execution` topic and `human-task-consumer` for `abl.human.task`. The default `KafkaEventQueue` groupId is `'eventstore-consumer'` (kafka-queue.ts:51) — two instances sharing this default would be joined into a single consumer group and trigger constant rebalances. The constructor config for each instance MUST override `kafka.groupId`.
  - Internally owns 2 `BufferedClickHouseWriter<T>` instances (one per CH event table) configured at `{ batchSize: 1000, flushIntervalMs: 1000 }`. **These are intentionally smaller than the `BufferedClickHouseWriter` defaults** (`DEFAULT_BATCH_SIZE=10_000`, `DEFAULT_FLUSH_INTERVAL_MS=5_000` at `packages/database/src/clickhouse.ts:157-158`). Rationale: workflow events are lower throughput than platform events; smaller batches reduce ingest latency toward the feature-spec §12 SLI p95 ≤ 10s target. The numbers can be raised once LOAD-01 confirms headroom.
  - `onProcess` handler: **validate event with the Zod schema directly** — `WorkflowExecutionEventSchema.safeParse(rawEvent)` (or the human-task schema). Do **not** use `EventRegistry.validate()` — that utility calls `schema.safeParse(event.data)` on the `PlatformEvent` envelope shape, and these workflow events are flat top-level objects with no nested `data` field. `EventRegistry.register` is still called in §2.2/§2.3 because the registry is consulted by GDPR scrubbing / PII lookup helpers (`getPIIEventTypes`); that's a separate usage path from consumer-side validation.
  - `start()` registers consumer handlers + calls `initWorkflowEventTables(chClient)` once before attaching handlers.
  - `shutdown()` calls `flush()` then `close()` on both writers, then disconnects Kafka consumers.
- 4.2. Bootstrap in `apps/runtime/src/server.ts`: create `WorkflowEventsConsumer` if `WORKFLOW_CH_SINK_ENABLED`. Call `.start()` post-DB/Kafka connect. Register SIGTERM shutdown. Also call `initWorkflowEventTables(chClient)` unconditionally at startup so the tables exist even when the sink is off (safe idempotent DDL).
- 4.3. Update `apps/runtime/src/services/eventstore-singleton.ts`: register workflow-specific `EventCascadeHook` implementation with a real `deleteByExecutionIds(tenantId, executionIds)`. **Use the runtime's existing CH delete convention** — `ALTER TABLE … DELETE` via `client.command()` (see `apps/runtime/src/repos/cascade-repo.ts:158-159` for the idiomatic pattern). Do NOT use `DELETE FROM`/`client.exec` — that's a different convention used only in search-ai. Concrete shape for each of the 4 tables (`workflow_execution_events`, `workflow_executions_latest`, `human_task_events`, `human_tasks_latest`):
  ```typescript
  await chClient.command({
    query: `ALTER TABLE abl_platform.workflow_execution_events DELETE WHERE tenant_id = {tenantId:String} AND execution_id IN ({executionIds:Array(String)})`,
    query_params: { tenantId, executionIds },
  });
  ```
  Issue the 4 commands concurrently via `Promise.all` with proper error propagation (never swallow — the cascade hook contract returns `Promise<void>` and errors must bubble to the calling GDPR code per HLD §4 concern #5).
- 4.4. Create `apps/runtime/src/routes/test-diagnostic-workflow.ts` (Phase 4 slice): `GET /api/admin/test/workflow-ch-events/:executionId`, `GET /api/admin/test/human-tasks-latest/:taskId`, `POST /api/admin/test/workflow-consumer/flush` (test-spec §10.4–§10.6). Dynamic `import()` gated on `NODE_ENV=test` in `server.ts`. **Auth stack**: same as §3.6 — routes mount behind `[createUnifiedAuthMiddleware, requireAuth]` and all CH queries include `tenantId` from `req.tenantContext`. No auth bypass.
- 4.5. Add **traces + metrics for consumer path** (complements the write-path observability added in §3.7):
  - **Trace events**: every CH batch flush emits `{ category: 'workflow', event_type: 'workflow.outbox.consumed', data: { topic, batch_size, lag_ms, row_count } }`. Buffered-writer flush failures emit `{ event_type: 'workflow.consumer.flush_failed', data: { error, attempt } }`.
  - **Prometheus metrics**: `WorkflowEventsConsumer` emits `workflow_ch_consumer_lag_ms` (gauge, `Date.now() - event.occurred_at` per message), `workflow_ch_ingest_latency_ms` (histogram, time from first-message-received to CH flush success), `workflow_ch_buffered_writer_flush_latency_ms` (histogram, observed on each `flush()` via `BufferedClickHouseWriter.getMetrics()`).
- 4.6. **FR-8: Plan-tiered CH retention** (gap closed from Round 3 audit). Create `packages/eventstore/src/retention/workflow-event-lifecycle.ts` implementing the full `IEventLifecycle` interface (5 methods at `packages/eventstore/src/interfaces/event-store.ts:79-108`) for the two workflow raw-event tables:
  - `purgeExpired(tenantId, olderThan)`: iterate both tables with `ALTER TABLE abl_platform.${table} DELETE WHERE tenant_id = {tenantId:String} AND occurred_at < {olderThan:DateTime64(3)}` via `client.command`.
  - `scrubPII(tenantId, olderThan, piiEventTypes)`: iterate both tables with `ALTER TABLE abl_platform.${table} UPDATE metadata = '{"anonymized":true}' WHERE tenant_id = {tenantId:String} AND occurred_at < {olderThan:DateTime64(3)} AND event_type IN {eventTypes:Array(String)}`.
  - `deleteBySessionIds(tenantId, sessionIds)`: **no-op** — workflow events are not session-scoped (comment the reason in-code).
  - `anonymizeActor(tenantId, actorId)`: **no-op** — workflow events don't carry `actor_id` columns (comment the reason).
  - `deleteTenant(tenantId)`: iterate both raw tables + both `_latest` projection tables with `ALTER TABLE abl_platform.${table} DELETE WHERE tenant_id = {tenantId:String}` via `client.command`.

  Wiring: in `apps/runtime/src/services/eventstore-singleton.ts` create `const workflowRetention = new EventRetentionService(new WorkflowEventLifecycle(chClient))` alongside the existing platform retention service. Call `workflowRetention.runRetention(tenantId, policy)` from the **same daily cron handler** that invokes the existing platform `EventRetentionService.runRetention` (per `packages/eventstore/src/factory.ts:124` wiring). Plan-tier policy lookup reuses the existing `RetentionPolicy` shape from `packages/eventstore/src/interfaces/event-retention.ts` (FREE 30d / TEAM 90d / BUSINESS 365d / ENTERPRISE 7y — per feature spec FR-8). The `_latest` projection tables inherit deletion via the MV upstream source rows for `purgeExpired` — but `deleteTenant` drops them explicitly since cross-cutting tenant deletion must be atomic.

- 4.7. **FR-10: Mongo GDPR cascade** (gap closed from Round 3 audit). Update `packages/database/src/cascade/cascade-delete.ts:deleteTenant()` to additionally drop rows from `WorkflowExecution`, `HumanTask` **(only where `mailbox === 'workflow'`)**, and `WorkflowEventOutbox` for the deleted tenant. Extend the workflow-specific `EventCascadeHook.deleteByExecutionIds` in §4.3 to also `WorkflowExecution.deleteMany({ tenantId, _id: { $in: executionIds } })` and `HumanTask.deleteMany({ tenantId, mailbox: 'workflow', executionId: { $in: executionIds } })` in addition to the CH `ALTER TABLE … DELETE` commands. Update the unit test (UT-06) + INT-05 to assert Mongo-side removal + CH-side removal + non-workflow mailboxes untouched.

**Files Touched**:

- 4 new files (consumer service, test-diagnostic-workflow, `workflow-event-lifecycle.ts`, cascade hook impl — lives inside the modified eventstore-singleton)
- 3 modified (`apps/runtime/src/server.ts`, `apps/runtime/src/services/eventstore-singleton.ts`, `packages/database/src/cascade/cascade-delete.ts`)

**Exit Criteria**:

- [ ] `INT-03` (CH Consumer dedup + flush + MV correctness) passes. Asserts: duplicates are deduplicated by `_version`; batched flush happens within `flushIntervalMs`; `workflow_executions_latest` projection reflects the latest event's cumulative state.
- [ ] `INT-05` (GDPR Cascade — `deleteByExecutionIds` drops CH rows + Mongo rows, agent-escalation mailbox untouched) passes. Creates 2 executions → hits GDPR delete endpoint → asserts raw + latest-projection CH rows gone, `workflow_executions` + `workflow`-mailbox `human_tasks` + `workflow_event_outbox` Mongo rows gone, non-workflow mailbox tasks remain intact.
- [ ] `E2E-05` (GDPR Tenant Deletion Cascade) passes — end-to-end tenant delete cascades to all stores (7 total) including the 3 Mongo collections and 4 CH tables for the workflow feature.
- [ ] `UT-04` (Zod validation — malformed events rejected with structured error) passes.
- [ ] **FR-8 retention test**: With a synthetic tenant policy (totalRetentionDays=1), injecting events with `occurred_at` > 1 day ago → running `EventRetentionService.runRetention(tenantId, policy)` → asserts CH rows for that tenant are purged from both workflow event tables.
- [ ] CH startup: `initWorkflowEventTables` succeeds idempotently on second call.
- [ ] With `WORKFLOW_CH_SINK_ENABLED=false`, runtime server starts cleanly; CH tables exist but are empty.
- [ ] With `WORKFLOW_CH_SINK_ENABLED=true`, an end-to-end workflow run writes to CH within 10s (matches feature-spec §12 SLI p95 ≤10s).

**Test Strategy**:

- **Unit**: `UT-04` pure Zod validation tests. `UT-05` preview of dual-read-merger (see Phase 5).
- **Integration**: `INT-03` uses real dockerized CH + Kafka. `INT-05` uses real CH + makes an HTTP DELETE against the runtime's existing GDPR delete endpoint.
- **No mocks.** The consumer integration test spins up the real runtime with real CH/Kafka connections.

**Rollback**: `WORKFLOW_CH_SINK_ENABLED=false` stops the consumer — Kafka retains unconsumed messages (idempotent replay). If CH DDL is actively problematic, drop the tables manually via `DROP TABLE` and restart the runtime without the flag. The outbox + poller continue independently (Phase 3 remains safe).

**Commits**:

13. `[ABLP-2] feat(runtime): add workflow-events kafka→clickhouse consumer with buffered writes` (§4.1 + §4.2)
14. `[ABLP-2] feat(database,runtime): extend event-cascade-hook with deleteByExecutionIds + mongo cascade + register workflow impl` (§4.3 + §4.7 — touches `packages/database/src/cascade/event-cascade-hooks.ts`, `packages/database/src/cascade/cascade-delete.ts`, `apps/runtime/src/services/eventstore-singleton.ts`)
15. `[ABLP-2] feat(runtime): add test-diagnostic workflow CH query endpoints` (§4.4)
16. `[ABLP-2] feat(runtime): add workflow.outbox.consumed + workflow.consumer.flush_failed trace events` (§4.5)
17. `[ABLP-2] feat(eventstore,runtime): add workflow-event lifecycle for plan-tiered CH retention (FR-8)` (§4.6)
18. `[ABLP-2] test(runtime): add INT-03 CH consumer dedup + INT-05 GDPR cascade (mongo+CH) + UT-02 row mapper + UT-04 zod validation + FR-8 retention test + E2E-05 tenant cascade` (§4 tests)

---

### Phase 5 — Read Path + UI (P5)

**Goal**: Dual-read merger + hybrid readers for executions and human tasks. Studio Inbox default-filter + toggle. Gated on `WORKFLOW_DUAL_READ_ENABLED`.

**Tasks**:

- 5.1. Create the dual-read merger as a pure function `mergeMongoAndCH<T>(mongoRows: T[], chRows: T[], keyFn: (row: T) => string): T[]` — UNION then dedup by `keyFn`, **Mongo wins on overlap** (HLD §4 concern #5 error-model decision). Returns sorted by `startedAt` DESC.
  - **Location decision**: `apps/workflow-engine/src/persistence/dual-read-merger.ts` for Phase 5. This is a **novel pattern** — the existing auth-profile dual-read at `packages/shared-auth-profile/src/dual-read.ts` is a binary branching function (A-OR-B), not a UNION-with-dedup merger. No Mongo→CH precedent exists.
  - **Reuse path for future CH migrations**: if a second Mongo→CH migration follows (e.g., search-ai ingestion migration), promote this function verbatim to `packages/database/src/migration-helpers/dual-read-merger.ts` in a later refactor. Flagged in §7 Open Question as a deferred decision — not blocking this LLD.
- 5.2. Create `apps/workflow-engine/src/persistence/hybrid-execution-reader.ts`. Constructor accepts `ExecutionStore`, `ClickHouseClient`, flag-reader function. Methods: `listByProject`, `getById`. When flag `dualReadEnabled === false`: delegate to `ExecutionStore` only (current behavior). When `true`: read from Mongo + `workflow_executions_latest` CH table, merge via §5.1, apply isolation filter (tenantId + projectId) in CH query parameters. **Metric**: each call emits `workflow_dual_read_request_latency_ms` (histogram, tagged with `mode={mongo-only|union}` label) via `@agent-platform/shared-observability`.
- 5.3. Create `apps/runtime/src/services/hybrid-human-task-reader.ts` — same pattern for `mailbox='workflow'` scoped tasks. **Critical**: CH query MUST include `AND mailbox = 'workflow'` filter; other mailboxes (agent-escalation, ticket, chat) are NOT in scope per HLD §5.3 errata E-5 — they must still read from Mongo-only. Emits the same `workflow_dual_read_request_latency_ms` histogram, tagged `entity=human_task, mode=...`.
- 5.4. Wire `HybridExecutionReader` into `apps/workflow-engine/src/routes/workflow-executions.ts` GET endpoints. Existing tests continue to pass with flag off.
- 5.5. Wire `HybridHumanTaskReader` into `apps/runtime/src/routes/human-tasks.ts` (or the correct inbox route file — agent to verify exact path via `rg 'human-tasks' apps/runtime/src/routes/`) for `mailbox=workflow` query-param paths only.
- 5.6. Add Studio Inbox UI changes per test-spec §4 (FR-9):
  - Default status filter: **`status=pending,assigned,in_progress`** (per feature-spec FR-9 + test-spec E2E-04 step 2). Not just `pending`.
  - "Show completed" toggle reveals `approved`/`rejected`/`expired`/`cancelled` rows.
  - Sort by `requestedAt` DESC.
  - Assert via E2E-04 (Playwright): default query-param contains `status=pending,assigned,in_progress`; after toggle click, completed-state rows appear.
- 5.7. Extend test-diagnostic routes added in Phase 3/4 with the dual-read inspection endpoints from test-spec §10.7 (`GET /api/admin/test/workflow-executions/:id/hybrid?mode=mongo-only|ch-only|union`) — 3 modes for parity testing.

**Files Touched**:

- 3 new files (dual-read-merger, hybrid-execution-reader, hybrid-human-task-reader)
- 3 modified (workflow-executions route, human-tasks route, UnifiedInboxPage.tsx)
- 1 augmented (test-diagnostic.ts — add hybrid endpoint)

**Exit Criteria**:

- [ ] `UT-05` (dual-read-merger pure function — UNION, Mongo-wins-dedup, sort) passes: at least 8 test cases including empty inputs, full overlap, disjoint, partial overlap.
- [ ] `INT-06` (user-isolation parity — cross-tenant returns 404 from both Mongo-only and union modes; cross-project returns 404 in both modes) passes.
- [ ] `INT-07` (flag-matrix parity — 16 combinations × 3 sample API calls = 48 cases, all return 2xx with structurally-identical response envelopes) passes.
- [ ] `E2E-01` (every state change → matching CH row within 10s, verified via `GET /api/admin/test/workflow-ch-events/:executionId` after `POST /api/projects/:projectId/workflow-executions`) passes.
- [ ] `E2E-02` (dual-read parity — 20-execution fixture produces structurally-identical response in `mongoOnly` vs `unionRead` modes; includes cross-tenant/cross-project 404 checks at step 7) passes.
- [ ] `E2E-03` (Monitor Tab — Historical Executions via CH, Phase B; Playwright verifies >48h runs surface from CH after Mongo TTL) passes. **Note**: E2E-03 may remain deferred to Phase 6 since it depends on MONGO_TTL; Phase 5 ships the code path, Phase 6 closes the assertion loop.
- [ ] `E2E-04` (Inbox Default Status Filter + Toggle; Playwright verifies query contains `status=pending,assigned,in_progress` by default and toggle reveals completed rows) passes.
- [ ] `E2E-06` (Cross-Feature Chain: Trigger → Execution → HumanTask → CH; verifies an end-to-end chain originated by a trigger-fired workflow produces matching CH rows in both `workflow_execution_events` and `human_task_events`) passes.
- [ ] **Performance budget gate** (not a test-spec E2E): workflow-engine GET list endpoints p95 < 500ms with `WORKFLOW_DUAL_READ_ENABLED=true` against a 1,000-execution fixture, measured via the `workflow_dual_read_request_latency_ms` histogram.

**Test Strategy**:

- **Unit**: `UT-05` is a pure-function test — zero mocks.
- **Integration**: `INT-06`/`INT-07` use real runtime + workflow-engine + Mongo + CH. No mocks.
- **E2E**: All 4 E2E tests run against dockerized full stack. The Studio E2E (E2E-03) runs via Playwright against the real Studio UI per test-spec §8.
- **Hybrid test-diagnostic endpoints**: provide the unified-vs-individual path for parity assertions in INT-07 + E2E-02.

**Rollback**: Flip `WORKFLOW_DUAL_READ_ENABLED=false` — readers fall back to Mongo-only instantly. UI default-filter change in §5.6 is a separate concern that doesn't require the flag but can be reverted independently if it causes user confusion.

**Commits**:

19. `[ABLP-2] feat(workflow-engine): add dual-read merger pure function with mongo-wins dedup` (§5.1 + UT-05)
20. `[ABLP-2] feat(workflow-engine): add HybridExecutionReader gated on dual-read flag` (§5.2 + §5.4)
21. `[ABLP-2] feat(runtime): add HybridHumanTaskReader scoped to mailbox=workflow` (§5.3 + §5.5)
22. `[ABLP-2] feat(studio): add Inbox default-filter pending + show-completed toggle + requestedAt sort` (§5.6)
23. `[ABLP-2] feat(workflow-engine,runtime): add hybrid-mode test-diagnostic inspection endpoints` (§5.7)
24. `[ABLP-2] test(workflow-engine,runtime): add INT-06 isolation + INT-07 flag-matrix parity + E2E-01 (CH row within 10s) + E2E-02 (dual-read parity + xtenant 404) + E2E-06 (cross-feature chain)` (workflow-engine + runtime integration tests; 2 packages).
25. `[ABLP-2] test(studio): add E2E-04 inbox default-filter Playwright spec (default pending/assigned/in_progress + toggle reveals completed)` (apps/studio only; separated from commit 24 to stay within the 3-package commit-scope guard).

---

### Phase 6 — TTL + Parity (P6)

**Goal**: Enable Mongo TTL cascade for terminal workflow/human-task rows (primary safety mechanism per HLD §4 concern #6). Ship the parity-check CLI. Complete the LOAD-02 CI smoke test. This is the destructive-operation phase — shipped last, flag-gated, with explicit post-parity-confirmation gate.

**Tasks**:

- 6.1. Add TTL partial-filter indexes to `workflow_executions` Mongoose schema. **Align with the repo's TTL pattern** (`packages/database/src/models/vocabulary-candidates.model.ts`, `channel-session.model.ts`, `attachment.model.ts`): use a dedicated `expiresAt: Date | null` field rather than TTLing a domain field directly.
  - Schema addition: `expiresAt: { type: Date, default: null }`.
  - State-transition code (in the terminal-status write path) sets `expiresAt = new Date(Date.now() + WORKFLOW_MONGO_TTL_SECONDS * 1000)` when `status ∈ {completed, failed, cancelled, rejected}`, else leaves `null`.
  - Index: `{ expiresAt: 1 }` with `{ expireAfterSeconds: 0, partialFilterExpression: { expiresAt: { $ne: null } } }`. Conditional — `ensureIndex` only runs at startup when `WORKFLOW_MONGO_TTL_ENABLED=true`.
  - Default TTL window = 14 days (test-spec §10 env table), narrowing to 48h after 1 week observation.
- 6.2. Apply the same `expiresAt` field + partial-filter TTL index to `human_tasks` Mongoose schema — but **only** when `mailbox === 'workflow'` AND `status ∈ {approved, rejected, cancelled, expired}`. Non-workflow mailboxes keep `expiresAt: null` and are untouched by TTL (per HLD §5 scope constraint).
- 6.3. Startup validation — in `apps/workflow-engine/src/index.ts`, if `WORKFLOW_MONGO_TTL_ENABLED=true`, log warn-level if the outbox row count exceeds the `WORKFLOW_OUTBOX_ALERT_THRESHOLD=10000` (surfacing stuck outbox that should block TTL enablement).
- 6.4. Create `tools/test-infra/parity-check.ts` — CLI that:
  - Samples N random executions from Mongo (configurable via `--sample-size`, default 1000)
  - Queries CH `workflow_executions_latest` for the same execution_ids
  - Diffs each pair on 10 canonical fields (`status`, `workflow_version`, `started_at`, `completed_at`, `duration_ms`, `workflow_id`, `project_id`, `trigger_type`, `last_event_at`, `error_code`)
  - Reports drift % and per-field diff histogram
  - Exits non-zero if drift > `--threshold` (default 0.1%)
  - Matches feature-spec §10 "parity-check tool" requirement.
- 6.5. Add `LOAD-02` CI smoke test per test-spec §9 — a scaled-down version of LOAD-01 (100 concurrent workflow runs × 5 minutes) that runs on each PR. Asserts: outbox backlog p95 < 10 rows, CH ingest lag p95 < 5s. Uses real docker-compose stack.

**Files Touched**:

- 2 modified (`workflow_executions` schema, `human_tasks` schema — both in `packages/database/src/models/`)
- 2 new files (`tools/test-infra/parity-check.ts`, CI smoke test in `apps/workflow-engine/src/__tests__/load-smoke.test.ts`)
- 1 modified (`apps/workflow-engine/src/index.ts` — startup validation)

**Exit Criteria**:

- [ ] `INT-04` (TTL behavior — terminal rows deleted, in-flight untouched) passes against a MongoDB replica set with accelerated TTL.
- [ ] `INT-08` (error-path coverage — Kafka down, CH down, Mongo down during poller — system degrades gracefully + recovers) passes.
- [ ] `E2E-03` (Monitor Tab — Historical Executions via CH, Phase B): Playwright asserts that completed-and-TTL-expired executions no longer exist in Mongo but continue to surface via the Monitor tab (read-through to CH). This is the assertion gate for FR-7 Phase B completion.
- [ ] `LOAD-02` CI smoke test passes within 7 minutes of wall time.
- [ ] Parity-check CLI run against a staging dataset of 10,000 executions reports drift < 0.1%.
- [ ] TTL index `getIndexes()` confirms `partialFilterExpression` is set correctly and `expireAfterSeconds` matches the configured seconds.
- [ ] With `WORKFLOW_MONGO_TTL_ENABLED=false`, no TTL index is created (verified by `rg` on `ensureIndex` calls being flag-conditional).

**Test Strategy**:

- **Integration**: `INT-04` requires `MongoMemoryReplSet` + accelerated TTL poll. `INT-08` uses `docker-compose pause`/`unpause` against Kafka/CH/Mongo to simulate failure scenarios.
- **Load**: `LOAD-02` uses k6 against docker-compose. Full `LOAD-01` (1M runs × 4h) runs in staging, not CI.
- **No mocks.** Failure scenarios use real docker orchestration.

**Rollback**: Flip `WORKFLOW_MONGO_TTL_ENABLED=false`. The index remains until manually dropped, but TTL evaluation is disabled at the partial-filter level (setting `expiresAt` on terminal transitions is also flag-gated). For full revert, drop the indexes via `db.workflow_executions.dropIndex('expiresAt_1')` and `db.human_tasks.dropIndex('expiresAt_1')` in production — non-blocking operation on MongoDB 4.2+.

**Commits**:

26. `[ABLP-2] feat(database): add expiresAt field + TTL partial-filter indexes for workflow-executions + human-tasks (workflow mailbox)` (§6.1 + §6.2)
27. `[ABLP-2] feat(workflow-engine): add startup validation for outbox backlog before TTL enablement` (§6.3)
28. `[ABLP-2] feat(tools): add workflow Mongo↔CH parity-check CLI` (§6.4)
29. `[ABLP-2] test(workflow-engine): add INT-04 TTL + INT-08 failure-scenario + E2E-03 monitor-historical (CH read-through) + LOAD-02 CI smoke` (§6.5 tests)

## 4. Wiring Checklist

CRITICAL: Every new component must be wired into its callers. This section prevents the #1 agent failure mode: writing code that nothing calls.

- [ ] `WorkflowEventOutboxModel` exported from `packages/database/src/models/index.ts`.
- [ ] `registerWorkflowExecutionEvents(registry)` + `registerHumanTaskEvents(registry)` called during eventstore initialization (`apps/runtime/src/services/eventstore-singleton.ts`).
- [ ] `initWorkflowEventTables(chClient)` called once at runtime startup (`apps/runtime/src/server.ts`), unconditionally (idempotent, tables created even when sink flag off).
- [ ] `OutboxPoller` instantiated + `start()`'d in `apps/workflow-engine/src/index.ts` post-Mongo/Redis connect, only when `readFlags().outboxEnabled`.
- [ ] `OutboxPoller.shutdown()` registered on `process.on('SIGTERM')` AND inside `server.close()` callback in `apps/workflow-engine/src/index.ts`.
- [ ] `WorkflowEventsConsumer` instantiated + `start()`'d in `apps/runtime/src/server.ts` post-Kafka/CH connect, only when `readFlags().chSinkEnabled`.
- [ ] `WorkflowEventsConsumer.shutdown()` registered on `process.on('SIGTERM')`.
- [ ] Workflow-engine test-diagnostic router registered via dynamic `import()` ONLY when `NODE_ENV === 'test'` in `apps/workflow-engine/src/index.ts`.
- [ ] Runtime test-diagnostic router registered via dynamic `import()` ONLY when `NODE_ENV === 'test'` in `apps/runtime/src/server.ts`.
- [ ] `HybridExecutionReader` injected into `apps/workflow-engine/src/routes/workflow-executions.ts` GET endpoints.
- [ ] `HybridHumanTaskReader` injected into `apps/runtime/src/routes/human-tasks.ts` GET endpoints, **only for `mailbox=workflow`** query-param path (other mailboxes remain Mongo-only).
- [ ] Studio `UnifiedInboxPage.tsx` default filter + toggle + sort change merged; Playwright testid assertions updated per test-spec §8.
- [ ] Workflow-specific `EventCascadeHook` implementation with `deleteByExecutionIds` registered via `registerEventCascadeHook` in `apps/runtime/src/services/eventstore-singleton.ts`.
- [ ] TTL partial-filter indexes on `workflow_executions` + `human_tasks` wired as conditional `ensureIndex` calls at app startup, gated on `readFlags().mongoTtlEnabled`.
- [ ] Trace events `workflow.outbox.enqueued` (P3 §3.7) + `workflow.outbox.published` (P3 §3.7) + `workflow.outbox.consumed` (P4 §4.5) + `workflow.consumer.flush_failed` (P4 §4.5) emitted via the existing `TraceStore` (no ad-hoc logging substitutes per CLAUDE.md Core Invariant #4).
- [ ] Prometheus metrics instrumented: `OutboxPoller` emits `workflow_outbox_unpublished_rows` + `workflow_outbox_publish_latency_ms` + `workflow_outbox_publish_failures_total` (P3 §3.7). `WorkflowEventsConsumer` emits `workflow_ch_consumer_lag_ms` + `workflow_ch_ingest_latency_ms` + `workflow_ch_buffered_writer_flush_latency_ms` (P4 §4.5). `HybridExecutionReader` + `HybridHumanTaskReader` emit `workflow_dual_read_request_latency_ms` (P5 §5.2 + §5.3). All via `@agent-platform/shared-observability`.
- [ ] Express static routes `/api/admin/test/workflow-outbox/force-publish` (POST) registered BEFORE any `/:id` wildcard routes (CLAUDE.md Express route ordering rule).

## 5. Cross-Phase Concerns

### 5.1 Database Migrations

- **Mongo**:
  - `workflow_event_outbox` collection — created on first write; 3 indexes created via schema definition at application startup (`ensureIndexes()`).
  - `workflow_executions` + `human_tasks` — TTL partial-filter indexes added via conditional `ensureIndex` at P6 startup gated on `WORKFLOW_MONGO_TTL_ENABLED`. Non-blocking index build on existing collections (MongoDB 4.2+).
- **ClickHouse**:
  - 6 tables + MVs created via `initWorkflowEventTables(chClient)` at runtime startup. All `CREATE … IF NOT EXISTS`. Order: raw tables → latest projection tables → MVs (MVs depend on the other two existing).
- **No external migration tool needed.** All schema setup is code-defined and idempotent.

### 5.2 Feature Flags

| Flag                                  | Default                  | Phase Introduced | Rollout Notes                                                                                                                              |
| ------------------------------------- | ------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `WORKFLOW_OUTBOX_ENABLED`             | `false`                  | P3               | Turn on first in dev → staging → prod; observe `workflow_outbox_unpublished_rows` gauge stays < 10K.                                       |
| `WORKFLOW_CH_SINK_ENABLED`            | `false`                  | P4               | Turn on after outbox is healthy and CH tables are provisioned; observe `workflow_ch_ingest_latency_ms` p95 ≤ 10s.                          |
| `WORKFLOW_DUAL_READ_ENABLED`          | `false`                  | P5               | Cohort-gated per HLD §4 concern #11; canary tenants first, then progressive rollout based on parity-check CLI results.                     |
| `WORKFLOW_MONGO_TTL_ENABLED`          | `false`                  | P6               | Flipped **only after** parity-check reports < 0.1% drift over 48h. TTL starts at 14 days; narrows to 48h after 1 week staging observation. |
| `WORKFLOW_OUTBOX_POLL_INTERVAL_MS`    | `100`                    | P3               | Integer env var. Test suite uses `50` for faster feedback.                                                                                 |
| `WORKFLOW_OUTBOX_BATCH_SIZE`          | `100`                    | P3               | Integer env var.                                                                                                                           |
| `WORKFLOW_OUTBOX_TTL_HOURS`           | `72`                     | P3               | Published outbox rows expire after this many hours.                                                                                        |
| `WORKFLOW_MONGO_TTL_SECONDS`          | `1209600`                | P6               | 14 days. Narrow to `172800` (48h) post-observation.                                                                                        |
| `WORKFLOW_OUTBOX_ALERT_THRESHOLD`     | `10000`                  | P6               | Gauge alert threshold for stuck outbox rows.                                                                                               |
| `WORKFLOW_EVENT_TOPIC_EXECUTION`      | `abl.workflow.execution` | P2/P3            | Kafka topic for workflow execution events (from feature spec §11). Used by both `OutboxPoller.publishAndAck` and the runtime consumer.     |
| `WORKFLOW_EVENT_TOPIC_HUMAN_TASK`     | `abl.human.task`         | P2/P3            | Kafka topic for human-task events (from feature spec §11). Same producer+consumer usage.                                                   |
| `WORKFLOW_CH_RETENTION_OVERRIDE_DAYS` | unset                    | P4               | Optional per-tenant override for FR-8 retention (from feature spec §11). When unset, `EventRetentionService` uses plan-tier defaults.      |

All flags are plain `process.env` reads. Production rollout via Helm values in `abl-platform-deploy`. Per-environment override is the standard Helm values stacking pattern (no special machinery needed).

### 5.3 Configuration Changes

New env vars listed in §5.2 must be documented in:

- `apps/workflow-engine/.env.example` (or wherever workflow-engine documents env)
- `apps/runtime/.env.example`
- `docker-compose.yml` — add defaults (all `false` / `100` / `true`-for-tests) to the `workflow-engine` and `runtime` service env sections

**Kafka topic provisioning** (blocker for local dev + CI): Phase 2 must add the two topics to the `init-kafka-topics` service definition in `docker-compose.yml` (per HLD §3.3 + feature-spec FR-3):

| Topic                    | Partitions | Replication        | Compression | Retention | Cleanup |
| ------------------------ | ---------- | ------------------ | ----------- | --------- | ------- |
| `abl.workflow.execution` | 3          | 1 (dev) / 3 (prod) | lz4         | 7 days    | delete  |
| `abl.human.task`         | 3          | 1 (dev) / 3 (prod) | lz4         | 7 days    | delete  |

In production (non-docker), topics are provisioned via `abl-platform-deploy` Helm pre-install hooks. Brokers with `auto.create.topics.enable=false` require explicit provisioning before the runtime consumer connects.

### 5.4 Observability

New metrics (Prometheus/OpenTelemetry via `@agent-platform/shared-observability`):

- `workflow_outbox_unpublished_rows` — gauge (alert > 10000 sustained 5m)
- `workflow_outbox_publish_latency_ms` — histogram (P95 alert > 2000ms)
- `workflow_outbox_publish_failures_total` — counter
- `workflow_ch_consumer_lag_ms` — gauge (alert > 30000ms)
- `workflow_ch_ingest_latency_ms` — histogram (P99 alert > 10000ms)
- `workflow_ch_buffered_writer_flush_latency_ms` — histogram
- `workflow_dual_read_request_latency_ms` — histogram, tagged by mode (`mongo-only`, `ch-only`, `union`) (P95 alert > 500ms)

Alert rules defined in `abl-platform-deploy` per existing conventions.

### 5.5 Security & Isolation

- **Tenant**: every Mongo + CH query includes `tenantId`. CH tables have `ORDER BY (tenant_id, …)` which enforces tenant locality for scans; `PARTITION BY toYYYYMM(occurred_at)` on event tables (HLD §5.3 — matches existing `platform_events` pattern at `packages/eventstore/src/stores/clickhouse/platform-events-table.ts:75`). **Do NOT include `tenant_id` in the PARTITION expression** — it would create extreme partition cardinality in a multi-tenant cluster.
- **Project**: test-diagnostic endpoints use the existing project-scoped route middleware (`/api/projects/:projectId/…` or explicit `?projectId=` filter for `/api/admin/test/` endpoints with `requireProjectPermission`).
- **User**: `human_tasks` read path preserves existing `createdBy`/assignee filtering — hybrid reader doesn't bypass this.
- **NODE_ENV=test gating**: test-diagnostic routes return 404 (not 403) in non-test environments, maintaining existence-leak prevention (CLAUDE.md Core Invariant #1).

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 6 phases complete with exit criteria met (§3).
- [ ] All 8 integration scenarios from test spec passing: `INT-01` through `INT-08`.
- [ ] All 6 E2E scenarios from test spec passing: `E2E-01` through `E2E-06`.
- [ ] All 6 unit test scenarios from test spec passing: `UT-01` (Zod round-trip), `UT-02` (CH row mapper), `UT-03` (flag-gate predicate matrix), `UT-04` (inbox status filter), `UT-05` (dual-read merge), `UT-06` (GDPR hook compat).
- [ ] Load test: `LOAD-01` passes in staging (1M runs × 4h, outbox backlog p95 ≤ 100 rows, CH ingest p95 ≤ 10s, zero event loss). `LOAD-02` passes in CI on each PR.
- [ ] Parity check: drift < 0.1% over 48h continuous window in staging with all Phase A flags ON.
- [ ] No regressions in existing workflow-engine, runtime, eventstore, database tests: `pnpm build && pnpm test` shows identical suite-size and passing-count against `main`.
- [ ] Feature spec updated with implementation details (triggered by `/post-impl-sync` per HLD §5.5 errata E-1..E-5).
- [ ] Testing guide coverage matrix shows green for all FR-1..FR-12.
- [ ] Production soak: 1 week with all Phase A flags ON, zero incidents.
- [ ] All SDLC docs (feature spec, test spec, HLD, LLD) marked as current; status lifecycle PLANNED → ALPHA achieved on P5 exit, ALPHA → BETA achieved on P6 exit + 1 week soak, BETA → STABLE achieved on 1 additional week of production use.
- [ ] **`agents.md` updated** for every package touched (per `docs/sdlc/pipeline.md` Package Learnings): `packages/database/agents.md` (outbox model, TTL pattern, cascade-delete extension), `packages/eventstore/agents.md` (EventRegistry per-type registration pattern, workflow-event lifecycle, CH DDL init), `apps/workflow-engine/agents.md` (outbox writer + poller, hybrid reader, trace/metric inventory), `apps/runtime/agents.md` (workflow events consumer, cascade hook registration, test-diagnostic dynamic import pattern), `apps/studio/e2e/workflows/agents.md` (Inbox E2E section). Cross-cutting learnings → `docs/sdlc-logs/agents.md`.

## 6A. LLD-to-Upstream-Doc Errata (for `/post-impl-sync`)

These are deltas introduced by the LLD that MUST propagate back to the feature spec, HLD, and test spec. Each is a concrete text change, not a guideline.

- **LLD-E-1**: Test-diagnostic endpoint paths. The **LLD's namespaced form is the canonical path** to avoid collisions with other features' diagnostic endpoints. HLD §6.2 and test spec §10 currently reference `/api/admin/test/outbox` and `/api/admin/test/workflow-consumer/...` — update to consistently use `/api/admin/test/workflow-outbox`, `/api/admin/test/workflow-outbox/force-publish`, `/api/admin/test/workflow-ch-events/:executionId`, `/api/admin/test/workflow-consumer/flush`, `/api/admin/test/workflow-executions/:id/mongo-raw`, `/api/admin/test/workflow-executions/:id/hybrid`, `/api/admin/test/human-tasks-latest/:taskId`.
- **LLD-E-2**: `MongoHumanTaskStore.updateTaskStatus` pre-existing project-isolation gap (see Phase 1 §1.2). The feature spec's §10 implementation-files table and test spec's §6 (Security & Isolation Tests) should surface this as an explicit fix item — the method today filters `{_id, tenantId}` and is missing `projectId`. LLD Phase 1 fixes this in the same refactor commit.
- **LLD-E-3**: Trace-event inventory. Feature spec §12 and HLD §4 concern #8 should enumerate the 4 trace event types introduced: `workflow.outbox.enqueued`, `workflow.outbox.published`, `workflow.outbox.consumed`, `workflow.consumer.flush_failed`. Phase 3 ships the first two; Phase 4 ships the last two.
- **LLD-E-4**: EventRegistry registration pattern. The HLD §5.1 (event-schema overview) should add an explicit note that each event type must be registered individually (not via wildcard) — `EventRegistry.register()` stores an exact-match `Map<string, ZodSchema>`.
- **LLD-E-5**: CH PARTITION BY clarification. Test spec §10 references HLD DDL but should explicitly note that `PARTITION BY toYYYYMM(occurred_at)` is correct (NOT `PARTITION BY (tenant_id, ...)`); tenant locality is enforced by `ORDER BY (tenant_id, ...)`, not partition key.
- **LLD-E-6**: **Mongo TTL mechanism pattern change** (HLD §5.2 + §4 concern #11 + §9.1 pin all specified `{ completedAt: 1, expireAfterSeconds, partialFilterExpression: { completedAt: { $type: 'date' } } }`). LLD §6.1/§6.2 changes to a dedicated `expiresAt: Date | null` field with `{ expireAfterSeconds: 0, partialFilterExpression: { expiresAt: { $ne: null } } }` — this matches the existing repo convention (`vocabulary-candidates.model.ts`, `attachment.model.ts`) and avoids coupling TTL to a domain field. Feature spec §9 (Data Model) and HLD §5.2 must be updated to reflect the `expiresAt` pattern. HLD §4 concern #11 startup-validation rule ("check for `completedAt` partial-filter clause") must change to check the `expiresAt` partial-filter clause.
- **LLD-E-7**: **Outbox model schema refinements** over HLD §5.1. LLD §1.2 makes 5 deliberate changes: (1) `_id` _is_ the `event_id` (single UUIDv7 field instead of separate `_id` and `event_id`); (2) adds a `topic: String` field so the poller routes without re-deriving; (3) adds `occurredAt: Date` as the poller hot-path sort key (distinct from Mongoose-auto `createdAt`); (4) adds `expiresAt: Date | null` with TTL partial-filter on published rows (HLD had a `{ publishedAt: { $ne: null } }` TTL — LLD uses `expiresAt` field so the row's actual expiry time is inspectable); (5) renames `attempts` → `retryCount` (clearer idiom). Feature spec §9 and HLD §5.1 must be updated to reflect these refinements.
- **LLD-E-8**: **Three additional env vars introduced by LLD**, not in feature spec §11: `WORKFLOW_OUTBOX_TTL_HOURS` (default `72`) — governs when published outbox rows expire; `WORKFLOW_MONGO_TTL_SECONDS` (default `1209600` = 14 days) — per FR-7 Phase B tunable; `WORKFLOW_OUTBOX_ALERT_THRESHOLD` (default `10000`) — startup gate + Prometheus alert threshold. Feature spec §11 env var table must add these three rows.

## 7. Open Questions

1. **`WORKFLOW_OUTBOX_POLL_INTERVAL_MS` lower bound in prod?** LLD recommends 100ms. If prod Mongo latency spikes cause the poller to hold BullMQ worker threads, we may need to raise to 250ms. Will be validated via LOAD-01 staging run.
2. **How will the Studio Inbox `UnifiedInboxPage.tsx` handle a 1000-row `pending,assigned,in_progress` list?** Feature spec FR-9 doesn't specify pagination. To be decided with UX — LLD assumes existing pagination is reused.
3. **What's the contract for Kafka topic creation in non-local environments?** Dev uses `init-kafka-topics` (§5.3). Staging/prod — need to confirm: does `abl-platform-deploy` pre-install hook provision `abl.workflow.execution` and `abl.human.task`, or must an admin CLI step run once? If `auto.create.topics.enable=true` is on in those clusters, no action needed; otherwise a deploy-repo task is required.
4. **Promote `mergeMongoAndCH` to `packages/database/src/migration-helpers/`?** Current location is `apps/workflow-engine/src/persistence/` (tied to this feature). If search-ai or pipeline-engine needs a similar Mongo→CH UNION-dedup during a future migration, promote to shared. **Deferred decision** — not blocking this LLD. If the second caller appears within 1 quarter, promote. Otherwise keep local.

### 7A. Resolved During LLD Drafting

- **R-1** (ex-OQ-1): `apps/runtime/src/routes/human-tasks.ts` — verified exists. §5.5 wiring path is stable.
- **R-2** (ex-OQ-2): `apps/workflow-engine/src/routes/workflow-executions.ts` — verified exists as a single file. No routes-subfolder split to handle.
- **R-3** (HLD §9.2 #5 — BullMQ queue naming): queue is named `workflow-outbox-publisher`. Decided here — consistent with the repo convention of kebab-case queue names per feature (`workflow-triggers`, `workflow-outbox-publisher`). Not prefixing with `trigger-scheduler:*` because the outbox is a distinct subsystem.
- **R-4** (HLD §9.2 #9 — PII sentinel constant export): decided to **keep internal** to `@agent-platform/eventstore`. The sentinel (used by `scrubPII` / `anonymized:true` marker) is an implementation detail of the PII scrub path; exporting it would invite downstream consumers to depend on an internal format. If a future consumer needs it, export then.
- **R-5** (HLD §9.2 #10 — Inbox `agents.md`): `apps/studio/e2e/workflows/` already has an `agents.md` that the existing workflow E2E suite contributes to. Decision: **reuse that file**; do NOT create a separate `apps/studio/e2e/inbox/` directory. Add an "Inbox E2E" section to the existing `agents.md` when Phase 5 ships the Playwright E2E scenarios.
- **R-6** (ex-OQ — human_tasks TTL conflict): verified via `grep 'expireAfterSeconds' packages/database/src/models/human-task.model.ts` → zero existing TTL indexes. Safe to add `expiresAt` TTL in P6 without collision.
- **R-7** (ex-OQ — test harness replica-set support): verified that `apps/workflow-engine/src/__tests__/helpers/setup-mongo.ts` uses `MongoMemoryServer` (standalone) at line 29, NOT `MongoMemoryReplSet`. **P3 preflight action required**: `INT-01` (transactional atomicity) cannot pass against standalone Mongo. Options: (a) create a new helper `setup-mongo-rs.ts` using `MongoMemoryReplSet` specifically for `INT-01`, or (b) upgrade `setup-mongo.ts` to use replica set (note: slower startup, may affect existing tests). Option (a) preferred — scopes the upgrade to only the tests that need it. This is a known dependency of commit 12 (`test(workflow-engine): add INT-01 …`) — add harness-setup task inside commit 12.

## 8. References

- **Feature spec**: `docs/features/sub-features/workflow-execution-event-sourcing.md`
- **HLD**: `docs/specs/workflow-execution-event-sourcing.hld.md` (commit `878afc6f2d`), especially §3.6 (Required Infrastructure Gaps), §5.3 (DDL), §5.5 (Errata E-1..E-5), §9 (Open Questions)
- **Test spec**: `docs/testing/sub-features/workflow-execution-event-sourcing.md`
- **HLD audit log**: `docs/sdlc-logs/workflow-execution-event-sourcing/hld.log.md`
- **SDLC pipeline**: `docs/sdlc/pipeline.md` — commit conventions, BETA→STABLE criteria, Quality Principles
- **Related source files** (all verified to exist at LLD authoring time):
  - `apps/workflow-engine/src/persistence/execution-store.ts` (220 LOC)
  - `apps/workflow-engine/src/persistence/human-task-store.ts` (123 LOC)
  - `apps/workflow-engine/src/services/trigger-scheduler.ts` (BullMQ repeatable pattern, ~250 LOC)
  - `packages/eventstore/src/queues/kafka-queue.ts` (270 LOC)
  - `packages/database/src/cascade/event-cascade-hooks.ts` (37 LOC)
  - `packages/database/src/clickhouse.ts` (`BufferedClickHouseWriter`, ~400 LOC)
  - `packages/database/src/clickhouse-schemas/init.ts` (init pattern)
  - `packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts` (analytics init pattern)
  - `packages/eventstore/src/stores/clickhouse/platform-events-table.ts` (platform-events table + MV DDL pattern)
  - `apps/runtime/src/services/eventstore-singleton.ts` (cascade hook registration site)
