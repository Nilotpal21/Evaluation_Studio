# Feature: Workflow Execution Event Sourcing

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Workflows & Human Tasks](../workflows.md) / [EventStore](../eventstore.md)
**Status**: ALPHA
**Feature Area(s)**: `observability`, `governance`, `enterprise`, `admin operations`
**Package(s)**: `apps/workflow-engine`, `packages/eventstore`, `packages/database`, `apps/studio`, `apps/runtime`
**Owner(s)**: Runtime / Workflows Team
**Testing Guide**: [`../../testing/sub-features/workflow-execution-event-sourcing.md`](../../testing/sub-features/workflow-execution-event-sourcing.md)
**Last Updated**: 2026-04-21
**Jira**: ABLP-2

> **ALPHA scope note**: All 6 LLD phases landed in 38 commits on branch `feat/workflow-runs-mongo-2-clickhouse` (2026-04-21). Every production code path is in place behind four flags, all default-off (`WORKFLOW_OUTBOX_ENABLED`, `WORKFLOW_CH_SINK_ENABLED`, `WORKFLOW_DUAL_READ_ENABLED`, `WORKFLOW_MONGO_TTL_ENABLED`). Unit coverage: **141 test cases across 18 files** (verified 2026-04-21 via `grep -cE '^\s*(it|test)\('` on every shipped test file) — locks down pure logic, row mappers, Zod validation, hybrid readers, cascade hooks, TTL helpers, the dual-read merger, and the `?status=` query-param parser (UT-04). Integration coverage: **1 scenario** (INT-01 transactional atomicity via `MongoMemoryReplSet`, 3 cases). **E2E coverage: 3 gated scenarios SHIPPED** (E2E-01 execution lifecycle, E2E-02 dual-read parity, E2E-06 cross-entity CH correlation — 6 cases total, green against the operator-provisioned stack 2026-04-22; E2E-06's main case mid-run-skips when the seeded workflow doesn't produce a human_task). Real-infra INT-02/INT-03/INT-04/INT-05/INT-06/INT-07/INT-08/E2E-03/E2E-04/E2E-05 + LOAD-02 CI smoke remain deferred — tracked in §16 as GAP-008.
>
> **Post-sync integration hardening (2026-04-21)** — applied during the 5-round `pr-reviewer` loop; all 5 rounds APPROVED with 0 CRITICAL / 0 HIGH unresolved:
>
> - **Pipeline debug** (pre-review): `KafkaEventQueue` now registers an `lz4js` codec at module load (KafkaJS lacks built-in LZ4 and broker-level `compression.type=lz4` forces recompression); `subscribe → run` sequencing moved into a single promise chain to avoid a race. `workflow-events-consumer.ts` qualifies CH table names (`abl_platform.workflow_execution_events`) and converts ISO-8601 timestamps to CH `DateTime64(3, 'UTC')` format (`YYYY-MM-DD HH:MM:SS.sss`). `eventstore-singleton.ts` now calls `registerWorkflowExecutionEvents` + `registerHumanTaskEvents` at init (previously the `EventRegistry` was never populated with the new schemas).
> - **Round 1 (code quality)**: `outbox-poller.ts` wraps both success-path and failure-path `updateOne` calls in try/catch so a transient Mongo hiccup during bookkeeping does not abort the remaining rows in the batch — ReplacingMergeTree `_version` dedup absorbs any duplicate publish.
> - **Round 2 (HLD compliance)**: `apps/workflow-engine/src/index.ts` now validates the TTL partial-filter shape at startup (`{expiresAt: {$type: 'date'}}`) and refuses to start with CRITICAL log + `process.exit(1)` if the index is missing or wrong-shaped. `hybrid-human-task-reader.ts` file header + inline comments rewritten to document the 2-layer mailbox scope guard (Mongo filter + MV `WHERE` clause at projection time — the `human_tasks_latest` table intentionally drops the `mailbox` column).
> - **Round 3 (test coverage)**: extracted `parseStatusList` + `HUMAN_TASK_STATUS_VALUES` from `apps/runtime/src/routes/human-tasks.ts` and added a dedicated UT-04 test file — 9 pure-function cases covering absent / empty / single / comma-list / whitespace / dedupe / unknown-enum / mixed-valid-invalid / every-enum-value-individually. 2 new `outbox-poller.test.ts` cases cover the bookkeeping-failed paths.
> - **Round 4 (security & isolation)**: `PATCH /api/projects/:projectId/human-tasks/:id` final `findOneAndUpdate` filter now includes `projectId` (was `{_id, tenantId}` only) — closes a cross-project mutation gap at the atomic update site.
> - **Round 5 (production readiness)**: APPROVED. 4 non-blocking findings filed as FU-2..FU-5 in `docs/sdlc-logs/workflow-execution-event-sourcing/followups.md` (outbox poison-pill cap, consumer shutdown ordering, parity-check `error_code` placeholder, observable-gauge `catch {}`).

---

## 1. Introduction / Overview

### Problem Statement

The `workflow_executions` MongoDB collection (and workflow-sourced rows in `human_tasks`) grows unboundedly with run volume. There is no TTL index, no archival pipeline, and no separate analytical store. At projected scale (100K–500K runs/day platform-wide, with each execution document holding nested `nodeExecutions[]` arrays that can reach 50–100 KB), three failure modes emerge:

1. **Mongo working-set pressure**. The collection accumulates forever. Hot-set shrinks relative to total size, page faults increase, and index size compounds. Operational cost rises with no visibility into when the ceiling lands.
2. **Query latency degrades at scale**. The Studio Monitor tab polls `GET /executions` every 5 seconds and computes KPIs (total, in-progress, P90/P99 duration, failure rate) client-side from a limited result set. Analytical queries spanning the full history (trend charts, p95 duration per workflow, step-type heatmaps) are index-inefficient in MongoDB due to the nested array shape.
3. **No analytical store for workflow data**. Platform traces, messages, metrics, and audit already flow into ClickHouse via the eventstore pipeline. Workflow execution data is the only operationally-critical domain without a matching CH projection. `workflows.md` GAP-10 ("No audit logging for workflow lifecycle events") and GAP-12 ("Workflow, execution, human task, and version collections lack GDPR data deletion flows") both trace to this absence.

### Goal Statement

Apply the existing platform pattern — Mongo for transactional hot-path, ClickHouse for append-only analytics — to workflow execution and workflow-sourced human-task data. Keep MongoDB as the source of truth for in-flight runs and recently-completed records (48h). Emit lifecycle events via a transactional outbox to Kafka. Sink events into new ClickHouse event tables and `ReplacingMergeTree`-backed projections. Bound MongoDB footprint independent of total execution history while unlocking analytical queries on the full record of workflow activity.

### Summary

Workflow-engine writes execution and task state transitions to MongoDB **and** to a shared Mongo `workflow_event_outbox` collection in a single transaction. A BullMQ-repeatable outbox poller publishes events to dedicated Kafka topics (`abl.workflow.execution`, `abl.human.task`). A ClickHouse consumer (reusing `BufferedClickHouseWriter` from `packages/eventstore`) writes rows into two append-only event tables: `workflow_execution_events` and `human_task_events`. Two `ReplacingMergeTree`-backed projections (`workflow_executions_latest`, `human_tasks_latest`) serve as read models for the Monitor tab and Inbox when the data has aged past the 48h Mongo window. The API layer (`GET /executions`, `GET /human-tasks`) transparently UNIONs Mongo (hot) with CH (cold). Rollout is 2-phase, feature-flag gated: Phase A ships shadow write + dual-read behind flags; Phase B enables Mongo TTL once CH parity is verified.

---

## 2. Scope

### Goals

- Keep MongoDB `workflow_executions` bounded to in-flight runs (`status ∈ {running, waiting_human, waiting_approval, waiting_callback}`) plus a 48-hour read-through buffer for recently completed runs.
- Apply the same tiering to `human_tasks` rows where `mailbox = 'workflow'`. Agent-escalation tasks (`mailbox = 'agent'`) are out of scope.
- Emit workflow execution and workflow-sourced human-task lifecycle events via a transactional outbox in MongoDB, guaranteeing at-least-once delivery to Kafka.
- Sink events into ClickHouse tables (`workflow_execution_events`, `human_task_events`) following existing codec, compression, partitioning, and retention conventions from `platform_events`.
- Project current state per entity into `ReplacingMergeTree`-backed tables (`workflow_executions_latest`, `human_tasks_latest`) via CH materialized views.
- Extend the `GET /executions` and `GET /human-tasks` API layer to transparently UNION Mongo (hot) with CH (cold). Studio UI remains unchanged except for the Inbox default status filter.
- Add default `status ∈ {pending, assigned, in_progress}` filter to the Inbox list view with an "Include completed" toggle for history (Q20 in scope).
- Register a workflow-specific `EventCascadeHook` so tenant and execution deletion cascades across Mongo (outbox + executions + workflow-sourced tasks) and ClickHouse (event tables + `*_latest` projections), closing `workflows.md` GAP-12.
- Roll out in 2 feature-flag-gated phases: (A) shadow + dual-read behind flags, (B) Mongo TTL enablement.

### Non-Goals (Out of Scope)

- **Agent-escalation human tasks** (`mailbox = 'agent'`, `source.type = 'agent_escalation'`). These belong to the Memory & Sessions / Agent Runtime feature area and will be addressed in a separate ticket.
- **Migration of existing production Mongo data into CH**. The feature is BETA and the 48h Mongo buffer + dual-read UNION gracefully handle the gap. A one-time backfill is a nice-to-have follow-up, not a blocker.
- **New analytical dashboards and Monitor tab UI redesigns**. v1 scope keeps the existing Monitor tab and Inbox UI intact (one UX tweak: Inbox default-status filter). New charts that exploit the CH aggregation pipeline will be scoped in a follow-up feature.
- **Per-tenant retention overrides**. Retention uses the existing plan-tiered model shared with `platform_events`. Per-tenant tuning is deferred.
- **Scoping changes to `workflow_versions`, `workflow_api_keys`, or approval policy collections**. These have different access patterns and small footprints — no tiering needed.
- **Restate journal changes**. Restate's internal RocksDB journal is untouched. This feature only restructures the business-facing read model.
- **Removing dependency on MongoDB for workflow state**. Mongo remains the source of truth for in-flight runs; CH is a read model, not a replacement.

---

## 3. User Stories

1. **As a Studio user viewing the Workflow Monitor tab**, I want to see all historical executions for a workflow including those from months or years ago, so that I can audit past runs and debug intermittent issues without limits imposed by Mongo retention.
2. **As a Studio user working the Inbox**, I want the list to default to open tasks only (pending / assigned / in_progress) so that my queue is not noisy with completed tasks, and I want a clear toggle to include completed tasks when I need to look back.
3. **As a platform operator / SRE**, I want MongoDB `workflow_executions` storage to remain bounded relative to concurrent active runs rather than growing linearly with cumulative run volume, so that infra cost and working-set size stay predictable.
4. **As a product analytics consumer**, I want to run SQL aggregations over all workflow lifecycle events (p95 duration per workflow, success-rate trends over time, step-type heatmap, trigger-type breakdown) so that I can build dashboards without scanning a live OLTP store.
5. **As a compliance auditor**, I want every workflow execution and workflow-sourced human-task state transition captured as an immutable, tenant-isolated event with long retention, so that post-hoc audit queries answer "who approved what, when, and in what order?" across the product lifetime.
6. **As a platform operator invoking GDPR right-to-erasure for a tenant**, I want a single delete to cascade across MongoDB collections (`workflow_executions`, workflow-sourced `human_tasks`, outbox) and ClickHouse tables (`workflow_execution_events`, `human_task_events`, and both `*_latest` projections) so that no orphan data remains.
7. **As a workflow-engine developer**, I want event emission to be durable and at-least-once (never lost in a crash between Mongo commit and Kafka publish) so that CH reliably reflects Mongo state without reconciliation scripts.

---

## 4. Functional Requirements

1. **FR-1 (Transactional Outbox)**: The system must write every workflow execution state transition (create, node start, node complete, execution complete/fail, cancel) and every workflow-sourced human-task state transition (create, assign, claim, respond, expire, cancel) to a Mongo `workflow_event_outbox` collection in the same MongoDB transaction as the domain update. If the transaction rolls back, no outbox row is written. Each outbox row has a unique `event_id` (UUIDv7) used for idempotent Kafka publication.
2. **FR-2 (Outbox Publisher)**: The system must run exactly one outbox poller across workflow-engine replicas (leader-elected via BullMQ repeatable-job semantics backed by Redis). The poller reads unpublished rows in FIFO order, publishes each to the correct Kafka topic keyed by entity ID (`executionId` for workflow events; `taskId` for task events), and marks the row as published. Publish failures retry with bounded exponential backoff; the row stays unpublished until success.
3. **FR-3 (Kafka Topic Routing)**: The system must publish workflow execution events to topic `abl.workflow.execution` and workflow-sourced human-task events to topic `abl.human.task`. Both topics use tenant-ID-based partitioning to guarantee per-tenant ordered delivery. Topic retention is 7 days (short-term buffer; CH is long-term store).
4. **FR-4 (ClickHouse Event Sink)**: The system must consume both topics via a KafkaJS consumer group and write rows to two ClickHouse tables (`workflow_execution_events`, `human_task_events`) through the existing `BufferedClickHouseWriter` (10K batch / 5s flush). Writes are idempotent via `event_id` dedup handled by `ReplacingMergeTree` at the projection layer. Raw event rows append without mutation.
5. **FR-5 (Current-State Projections)**: The system must maintain two ClickHouse `ReplacingMergeTree`-backed materialized views — `workflow_executions_latest` (keyed on `tenant_id, project_id, workflow_id, execution_id`) and `human_tasks_latest` (keyed on `tenant_id, project_id, task_id`) — that project the current-state-per-entity from the event streams. Row version is the max `occurred_at` timestamp per entity. **HLD validation required**: the exact MV pattern must be decided in the HLD phase between (a) simple row-projection into `ReplacingMergeTree` (let the merge engine collapse duplicates), (b) `AggregatingMergeTree` with `argMaxState` / `argMaxMerge` combinators for running aggregation, or (c) hybrid. The SELECT shown in §9 uses `argMax`/`min`/`max`/`maxIf` aggregations in the MV, which do NOT accumulate across insertion blocks when targeting a plain `ReplacingMergeTree`; the HLD must resolve this and the LLD must pin the final SQL.
6. **FR-6 (Hybrid API Reads)**: The API layer serving `GET /api/projects/:pid/workflows/:wfId/executions`, `GET /api/projects/:pid/workflows/:wfId/executions/:id`, and `GET /api/projects/:pid/human-tasks` must transparently merge MongoDB results (for active and <48h completed rows) with ClickHouse projection results (for older archived rows), deduplicating by entity `_id` with MongoDB winning on overlap. Active-status queries (`status ∈ active_set`) must read from MongoDB only. API response shapes are identical to current contracts.
7. **FR-7 (Mongo TTL)**: Once Phase B is enabled, the system must enforce MongoDB TTL indexes: `workflow_executions.completedAt + 48h` (partial index scoped to documents where `completedAt` exists); `human_tasks.updatedAt + 48h` (partial index scoped to `mailbox = 'workflow'` AND `status ∈ {completed, expired, cancelled}`); `workflow_event_outbox.published_at + 7d` (partial index scoped to documents with `published_at` set). TTL indexes do not delete in-flight runs or unpublished outbox rows.
8. **FR-8 (Plan-Tiered CH Retention)**: ClickHouse tables must be partitioned by `toYYYYMM(occurred_at)` and retained per plan tier using the existing `EventRetentionService` mechanism (FREE 30d / TEAM 90d / BUSINESS 365d / ENTERPRISE 7y). Partitions past the retention boundary are dropped during merges — no hot-path cost.
9. **FR-9 (Inbox Default Filter)**: The Studio Inbox list view must default to `status ∈ {pending, assigned, in_progress}` for both `workflow` and `agent` mailboxes. An "Include completed" toggle expands the query to include completed / expired / cancelled tasks. The Inbox count badges (already scoped server-side to active statuses) remain unchanged. _(Scope note: this is a Studio UX improvement bundled via Q20 user override; it is orthogonal to the storage-tiering pipeline and is independently deployable. The HLD/LLD should scope this UI work separately from the event-sourcing pipeline.)_
10. **FR-10 (GDPR Cascade)**: The system must extend the existing `EventCascadeHook` interface at `packages/database/src/cascade/event-cascade-hooks.ts` (which today defines only `deleteBySessionIds(tenantId, sessionIds[])` and `deleteTenant(tenantId)`) with a new method `deleteByExecutionIds(tenantId, executionIds[])`. All existing hook implementations must provide a no-op implementation of the new method to preserve backward compatibility. The system must then register a workflow-specific `EventCascadeHook` implementation that handles `deleteTenant` and `deleteByExecutionIds`. The cascade must remove rows from: Mongo `workflow_executions`, Mongo `human_tasks` where `mailbox = 'workflow'`, Mongo `workflow_event_outbox`, CH `workflow_execution_events`, CH `human_task_events`, CH `workflow_executions_latest`, CH `human_tasks_latest`. PII scrubbing for events that carry user-provided payloads follows the existing eventstore PII pattern (`containsPII: true`).
11. **FR-11 (Feature-Flag-Gated Rollout)**: The system must expose independent feature flags for each mutation point: `WORKFLOW_OUTBOX_ENABLED`, `WORKFLOW_CH_SINK_ENABLED`, `WORKFLOW_DUAL_READ_ENABLED`, `WORKFLOW_MONGO_TTL_ENABLED`. Each flag defaults OFF; each can be toggled independently without redeploy. Mongo TTL flags are configuration-driven so an index can be dropped to halt deletion.
12. **FR-12 (Event Schema Versioning)**: Every event payload written to CH includes an `event_version` column (semver string). Workflow events register in the `EventRegistry` with an initial `version: '1.0.0'`. Zod schemas use `.passthrough()` for additive compatibility. Breaking schema changes bump the version and add a new Zod schema registration.

> Every FR is testable: FR-1 via transaction atomicity assertions, FR-2 via leader-election + retry tests, FR-3–FR-8 via topic/table DDL + consumer tests, FR-9 via Studio E2E, FR-10 via cascade integration tests, FR-11 via flag-flip regression tests, FR-12 via schema registry assertions.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                       |
| -------------------------- | ------------ | --------------------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Tenant/project isolation must be preserved end-to-end through CH.           |
| Agent lifecycle            | NONE         | Agent-runtime path is untouched.                                            |
| Customer experience        | SECONDARY    | Monitor tab + Inbox remain functional; Inbox gains default filter UX tweak. |
| Integrations / channels    | NONE         |                                                                             |
| Observability / tracing    | **PRIMARY**  | Closes `workflows.md` GAP-10; enables platform-wide workflow analytics.     |
| Governance / controls      | SECONDARY    | Per-plan retention enforces governance over workflow history.               |
| Enterprise / compliance    | **PRIMARY**  | Closes `workflows.md` GAP-12 (GDPR cascade). Enables long-term audit trail. |
| Admin / operator workflows | SECONDARY    | Bounded Mongo footprint simplifies capacity planning.                       |

### Related Feature Integration Matrix

| Related Feature                            | Relationship Type                           | Why It Matters                                                                                                                                                                                                                                                                                              | Key Touchpoints                                                                                                                                                                                            | Current State                            |
| ------------------------------------------ | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| [Workflows & Human Tasks](../workflows.md) | extends                                     | This is the storage-layer evolution for workflow execution and workflow-sourced human-task data.                                                                                                                                                                                                            | `WorkflowExecution` model, `HumanTask` model, `ExecutionStore`, `/executions` + `/human-tasks` routes                                                                                                      | Workflows BETA; this sub-feature PLANNED |
| [EventStore](../eventstore.md)             | depends on / emits into / extends interface | Reuses `KafkaEventQueue`, `BufferedClickHouseWriter`, `EventRegistry`, `EventRetentionService`. Adds two new dedicated Kafka topics and two new CH tables. **Extends** the `EventCascadeHook` interface in `packages/database/src/cascade/event-cascade-hooks.ts` with a new `deleteByExecutionIds` method. | `packages/eventstore/src/queues/kafka-queue.ts`, `packages/eventstore/src/stores/clickhouse/*`, `packages/eventstore/src/schema/event-registry.ts`, `packages/database/src/cascade/event-cascade-hooks.ts` | STABLE                                   |
| [Audit Logging](../audit-logging.md)       | shares data with                            | Workflow lifecycle events augment the audit surface — closes `workflows.md` GAP-10.                                                                                                                                                                                                                         | CH tables serve as the audit record for workflow state transitions                                                                                                                                         | ALPHA                                    |
| [Memory & Sessions](../memory-sessions.md) | shares data with                            | Agent-escalation human tasks are owned by this feature and explicitly out of scope here. A future parallel ticket will extend tiering to agent-source tasks.                                                                                                                                                | `human_tasks WHERE mailbox = 'agent'`                                                                                                                                                                      | BETA                                     |
| [Pipeline Engine](../pipeline-engine.md)   | tested with                                 | Pipeline Engine v2 established the `ReplacingMergeTree` + MV patterns. This feature reuses and extends them.                                                                                                                                                                                                | `docs/plans/2026-03-10-pipeline-engine-v2-design.md`                                                                                                                                                       | ALPHA                                    |

---

## 6. Design Considerations

No net-new UX surface except the Inbox default-status filter (FR-9). The Monitor tab and Inbox retain their current layouts, polling intervals, and component structure. The filter toggle on the Inbox ("Include completed") is a single control (likely a checkbox or segment control) placed adjacent to the existing mailbox selector in `UnifiedInboxPage.tsx`.

Design-time vs runtime: this feature has no design-time surface. All behavior is runtime: writes, reads, retention, cascades. There are no new author-facing assets, aliases, or materialization forms.

---

## 7. Technical Considerations

- **BullMQ pattern reuse**: the outbox poller uses BullMQ repeatable jobs (same pattern as `TriggerScheduler`) for free leader election across workflow-engine replicas. This avoids introducing a new Redis-lock implementation.
- **CH codec conventions** must match `platform_events`: `LowCardinality(String)` for enum-like fields, `CODEC(ZSTD(1))` for ID columns, `CODEC(ZSTD(3))` for JSON payload blobs, `CODEC(DoubleDelta, LZ4)` for DateTime columns, `CODEC(T64, LZ4)` for small integers.
- **Restate integration is unaffected**: Restate writes to its own RocksDB journal, independent of Mongo `workflow_executions`. The `ExecutionStore.createExecution()` upsert pattern (`execution-store.ts:L54–L84`) already tolerates replays. TTL removing completed records is safe because Restate does not replay terminal executions.
- **Dockerfile / topic init sync**: `docker-compose.yml` must register the two new topics in `init-kafka-topics` with 3 partitions, `lz4` compression, and `retention.ms=604800000` (7d). Production topic init (Helm / Terraform) must be updated in the `abl-platform-deploy` and `abl-platform-infra` repos.
- **Rollout posture (2-phase flag-gated per Q15=B)**:
  - **Phase A** ships all code: outbox, Kafka producer, CH sink, MV, dual-read API. Each mutation behind its own flag. Flags default OFF. Enable progressively in prod with parity-check observation between flips.
  - **Phase B** enables Mongo TTL indexes. Creates the only destructive operation. Can be reversed by dropping the TTL indexes (stops new deletes but does not recover already-deleted rows — Mongo oplog retention is a short-term safety net only).
- **Outbox sizing**: at 500K runs/day × ~10 events per run = 5M outbox rows/day = ~1.5 GB/day at ~300 bytes/row. With 7-day published-row TTL, peak outbox size ~11 GB. Poller writes an index on `published_at: null` to keep unpublished scans cheap.
- **Mongo TTL behavior**: cleanup is eventual (~60s-lagged background thread), not real-time. Design treats the 48h retention as "at least 48h" not "exactly 48h". Read paths tolerate a small overlap where a record lives both in Mongo (pre-TTL) and CH — dedup by `_id` handles this.
- **Studio Route Handler invariant** (per CLAUDE.md): the Studio Inbox default-filter change must keep the tenant scoping explicit in every Mongo query. The `UnifiedInboxPage.tsx` sends `status` via query string; the Studio route passes through to runtime; runtime applies `filter.status` atop the visibility filter.

---

## 8. How to Consume

### Studio UI

- **Workflow Monitor tab** (`apps/studio/src/components/workflows/tabs/WorkflowMonitorTab.tsx`): UI unchanged. `useWorkflowExecutions()` hook continues polling `/api/projects/:id/workflows/:workflowId/executions` at 5s intervals. Server-side API returns a merged MongoDB + ClickHouse result set.
- **Unified Inbox** (`apps/studio/src/components/inbox/UnifiedInboxPage.tsx`): gains a default status filter (`pending`, `assigned`, `in_progress`) + "Include completed" toggle. Mailbox selector and type-pill filter are unchanged. `useHumanTasks()` hook updates its default `params` to include `status` filter list unless toggle is on.

### Surface Semantics Matrix

N/A. Feature has no design-time / runtime split. All consumer contracts are runtime API responses; no authored assets involved.

### Design-Time vs Runtime Behavior

N/A. Purely a runtime/storage-layer change. No aliases, selectors, snapshots, or compiled identifiers. No control-plane surface.

### API (Runtime)

| Method | Path                                                                            | Purpose                         | Behavior change                                                         |
| ------ | ------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------- |
| GET    | `/api/projects/:projectId/workflows/:workflowId/executions`                     | List executions (existing)      | UNION Mongo + CH when `WORKFLOW_DUAL_READ_ENABLED=true`                 |
| GET    | `/api/projects/:projectId/workflows/:workflowId/executions/:executionId`        | Execution detail (existing)     | Mongo primary; CH fallback when `WORKFLOW_DUAL_READ_ENABLED=true`       |
| GET    | `/api/projects/:projectId/workflows/:workflowId/executions/:executionId/steps`  | List execution steps (existing) | Mongo primary; CH fallback                                              |
| POST   | `/api/projects/:projectId/workflows/:workflowId/executions/:executionId/cancel` | Cancel execution (existing)     | Unchanged — writes to Mongo only; emits cancellation event via outbox   |
| GET    | `/api/projects/:projectId/human-tasks`                                          | List human tasks (existing)     | UNION Mongo + CH for `mailbox=workflow`; Mongo-only for `mailbox=agent` |
| GET    | `/api/projects/:projectId/human-tasks/:taskId`                                  | Task detail (existing)          | Mongo primary; CH fallback for workflow mailbox                         |

### API (Studio)

All Studio routes are thin proxies to runtime (`apps/studio/src/app/api/projects/[id]/workflows/[workflowId]/executions/route.ts`, `apps/studio/src/app/api/projects/[id]/human-tasks/route.ts`). No new endpoints. Existing proxy behavior is preserved; the tenant-scoping requirement from CLAUDE.md §Studio Route Handler Gotchas applies to all Mongo reads within Studio routes.

### Admin Portal

N/A. Tenant-level inspection of workflow history is already handled through Studio. Admin surface is unchanged.

### Channel / SDK / Voice / A2A / MCP Integration

Not channel-aware. Workflow execution events are internal platform events; they are not surfaced over channel / SDK / voice / A2A / MCP contracts.

---

## 9. Data Model

### MongoDB (existing, modified)

**Collection: `workflow_executions`** — unchanged schema. Added TTL index:

```text
Collection: workflow_executions (existing, packages/database/src/models/workflow-execution.model.ts)
New index:
  - { completedAt: 1 } with expireAfterSeconds: 48*3600
    partialFilterExpression: { completedAt: { $type: 'date' } }
  (gated on WORKFLOW_MONGO_TTL_ENABLED — Phase B only)
```

**Collection: `human_tasks`** — unchanged schema. Added TTL index:

```text
Collection: human_tasks (existing, packages/database/src/models/human-task.model.ts)
New index:
  - { updatedAt: 1 } with expireAfterSeconds: 48*3600
    partialFilterExpression:
      mailbox: 'workflow'
      status: { $in: ['completed', 'expired', 'cancelled'] }
  (gated on WORKFLOW_MONGO_TTL_ENABLED — Phase B only)
```

**Collection: `workflow_event_outbox`** — new.

```text
Collection: workflow_event_outbox
Fields:
  - _id: string (UUIDv7)
  - tenantId: string (required)
  - projectId: string (required)
  - event_id: string (required, unique — used for Kafka key + CH dedup)
  - event_type: string (required, discriminator — e.g. 'workflow.execution.completed', 'workflow.human_task.claimed')
  - event_version: string (required, semver)
  - entity_kind: 'execution' | 'human_task' (required, routes to correct Kafka topic)
  - entity_id: string (required — executionId or taskId)
  - payload: Mixed (event body, validated against Zod schema at emit time)
  - created_at: Date (required)
  - published_at: Date | null (null until poller acks Kafka publish)
  - attempts: number (default 0, incremented on publish failure)
  - last_error: string | null
Indexes:
  - { tenantId: 1, projectId: 1 }
  - { tenantId: 1, entity_kind: 1, entity_id: 1 }  # supports GDPR cascade by executionId and by taskId
  - { published_at: 1 } partial TTL
      expireAfterSeconds: 7 * 86400
      partialFilterExpression: { published_at: { $type: 'date' } }
      # Single index: partial filter excludes unpublished rows (NULL published_at),
      # which both indexes them sparsely AND prevents TTL from deleting them.
      # The poller scans this index with { published_at: null } — efficient because
      # unpublished rows fall outside the partial filter and the key range is bounded.
  - { event_id: 1 } unique
```

### ClickHouse (new)

**Table: `workflow_execution_events`** — append-only event stream.

```sql
CREATE TABLE workflow_execution_events (
  event_id         UUID,
  event_version    LowCardinality(String),
  execution_id     String                 CODEC(ZSTD(1)),
  tenant_id        LowCardinality(String),
  project_id       LowCardinality(String),
  workflow_id      String                 CODEC(ZSTD(1)),
  workflow_version String                 CODEC(ZSTD(1)),
  event_type       LowCardinality(String),
  status           LowCardinality(String),
  step_id          String                 CODEC(ZSTD(1)),
  step_name        String                 CODEC(ZSTD(1)),
  step_type        LowCardinality(String),
  trigger_type     LowCardinality(String),
  duration_ms      UInt32                 CODEC(T64, LZ4),
  error_code       LowCardinality(String),
  error_message    String                 CODEC(ZSTD(3)),
  payload          String                 CODEC(ZSTD(3)),  -- JSON
  occurred_at      DateTime64(3, 'UTC')   CODEC(DoubleDelta, LZ4),
  ingested_at      DateTime64(3, 'UTC')   CODEC(DoubleDelta, LZ4)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (tenant_id, project_id, execution_id, occurred_at)
TTL occurred_at + INTERVAL <plan-based> -- resolved by EventRetentionService
SETTINGS index_granularity = 8192;
```

**Table: `human_task_events`** — append-only event stream.

```sql
CREATE TABLE human_task_events (
  event_id         UUID,
  event_version    LowCardinality(String),
  task_id          String                 CODEC(ZSTD(1)),
  tenant_id        LowCardinality(String),
  project_id       LowCardinality(String),
  execution_id     String                 CODEC(ZSTD(1)),
  workflow_id      String                 CODEC(ZSTD(1)),
  step_id          String                 CODEC(ZSTD(1)),
  task_type        LowCardinality(String),  -- approval | data_entry | review | decision
  mailbox          LowCardinality(String),  -- always 'workflow' in this table
  status           LowCardinality(String),
  priority         LowCardinality(String),
  event_type       LowCardinality(String),  -- created | assigned | claimed | responded | expired | cancelled
  assigned_to      Array(LowCardinality(String))  CODEC(ZSTD(1)),
  claimed_by       LowCardinality(String),
  responded_by     LowCardinality(String),
  decision         LowCardinality(String),
  due_at           Nullable(DateTime64(3, 'UTC')) CODEC(DoubleDelta, LZ4),
  sla_breached_at  Nullable(DateTime64(3, 'UTC')) CODEC(DoubleDelta, LZ4),
  payload          String                 CODEC(ZSTD(3)),
  occurred_at      DateTime64(3, 'UTC')   CODEC(DoubleDelta, LZ4),
  ingested_at      DateTime64(3, 'UTC')   CODEC(DoubleDelta, LZ4)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (tenant_id, project_id, task_id, occurred_at)
TTL occurred_at + INTERVAL <plan-based>
SETTINGS index_granularity = 8192;
```

**Projection table + MV: `workflow_executions_latest`** — current state per execution.

```sql
CREATE TABLE workflow_executions_latest (
  execution_id     String               CODEC(ZSTD(1)),
  tenant_id        LowCardinality(String),
  project_id       LowCardinality(String),
  workflow_id      String               CODEC(ZSTD(1)),
  workflow_version String               CODEC(ZSTD(1)),
  status           LowCardinality(String),
  trigger_type     LowCardinality(String),
  started_at       DateTime64(3, 'UTC') CODEC(DoubleDelta, LZ4),
  completed_at     Nullable(DateTime64(3, 'UTC')) CODEC(DoubleDelta, LZ4),
  duration_ms      UInt32               CODEC(T64, LZ4),
  last_event_at    DateTime64(3, 'UTC') CODEC(DoubleDelta, LZ4),
  _version         UInt64               CODEC(T64, LZ4)
)
ENGINE = ReplacingMergeTree(_version)
PARTITION BY toYYYYMM(started_at)
ORDER BY (tenant_id, project_id, workflow_id, execution_id)
TTL started_at + INTERVAL <plan-based>;

CREATE MATERIALIZED VIEW workflow_executions_latest_mv TO workflow_executions_latest AS
SELECT
  execution_id,
  tenant_id,
  project_id,
  workflow_id,
  argMax(workflow_version, occurred_at)  AS workflow_version,
  argMax(status, occurred_at)            AS status,
  argMax(trigger_type, occurred_at)      AS trigger_type,
  min(occurred_at)                       AS started_at,
  maxIf(occurred_at, status IN ('completed','failed','cancelled','rejected')) AS completed_at,
  argMaxIf(duration_ms, occurred_at, status IN ('completed','failed','cancelled','rejected')) AS duration_ms,
  max(occurred_at)                       AS last_event_at,
  toUnixTimestamp64Milli(max(occurred_at)) AS _version
FROM workflow_execution_events
GROUP BY tenant_id, project_id, workflow_id, execution_id;
```

**Projection table + MV: `human_tasks_latest`** — current state per task.

```sql
CREATE TABLE human_tasks_latest (
  task_id          String               CODEC(ZSTD(1)),
  tenant_id        LowCardinality(String),
  project_id       LowCardinality(String),
  execution_id     String               CODEC(ZSTD(1)),
  workflow_id      String               CODEC(ZSTD(1)),
  task_type        LowCardinality(String),
  status           LowCardinality(String),
  priority         LowCardinality(String),
  assigned_to      Array(LowCardinality(String)) CODEC(ZSTD(1)),
  claimed_by       LowCardinality(String),
  responded_by     LowCardinality(String),
  decision         LowCardinality(String),
  due_at           Nullable(DateTime64(3, 'UTC')) CODEC(DoubleDelta, LZ4),
  sla_breached_at  Nullable(DateTime64(3, 'UTC')) CODEC(DoubleDelta, LZ4),
  created_at       DateTime64(3, 'UTC') CODEC(DoubleDelta, LZ4),
  last_event_at    DateTime64(3, 'UTC') CODEC(DoubleDelta, LZ4),
  _version         UInt64               CODEC(T64, LZ4)
)
ENGINE = ReplacingMergeTree(_version)
PARTITION BY toYYYYMM(created_at)
ORDER BY (tenant_id, project_id, task_id)
TTL created_at + INTERVAL <plan-based>;

CREATE MATERIALIZED VIEW human_tasks_latest_mv TO human_tasks_latest AS
SELECT
  task_id,
  tenant_id,
  project_id,
  argMax(execution_id, occurred_at) AS execution_id,
  argMax(workflow_id, occurred_at)  AS workflow_id,
  argMax(task_type, occurred_at)    AS task_type,
  argMax(status, occurred_at)       AS status,
  argMax(priority, occurred_at)     AS priority,
  argMax(assigned_to, occurred_at)  AS assigned_to,
  argMax(claimed_by, occurred_at)   AS claimed_by,
  argMax(responded_by, occurred_at) AS responded_by,
  argMax(decision, occurred_at)     AS decision,
  argMax(due_at, occurred_at)       AS due_at,
  argMax(sla_breached_at, occurred_at) AS sla_breached_at,
  min(occurred_at)                  AS created_at,
  max(occurred_at)                  AS last_event_at,
  toUnixTimestamp64Milli(max(occurred_at)) AS _version
FROM human_task_events
WHERE mailbox = 'workflow'
GROUP BY tenant_id, project_id, task_id;
```

### Key Relationships

- `workflow_execution_events.execution_id` → `workflow_executions._id` (Mongo) → `workflow_executions_latest.execution_id` (CH projection). All three use the same UUIDv7 identifier.
- `human_task_events.task_id` → `human_tasks._id` (Mongo) → `human_tasks_latest.task_id` (CH projection).
- `human_task_events.execution_id` → `workflow_execution_events.execution_id` (cross-entity join key).
- `workflow_event_outbox.event_id` → Kafka message key → CH `event_id` column (dedup / idempotency).
- All entities share the `{ tenant_id, project_id }` tuple for isolation and partition / sort-key alignment.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                                           | Status   | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/workflow-engine/src/persistence/execution-store.ts`                      | Modified | Terminal-transition write now populates `expiresAt` via `computeExecutionExpiresAt` (Phase 6); session-threading added in Phase 1                                                                                                                                                                                                                                                                                                     |
| `apps/workflow-engine/src/persistence/human-task-store.ts`                     | Modified | Aggregation-pipeline `$cond` on mailbox='workflow' sets `expiresAt` on terminal transitions; `projectId` arg added to `updateTaskStatus`                                                                                                                                                                                                                                                                                              |
| `apps/workflow-engine/src/persistence/workflow-ttl.ts`                         | New (P6) | Pure TTL helpers — flag gating + terminal-set + mailbox scope                                                                                                                                                                                                                                                                                                                                                                         |
| `apps/workflow-engine/src/persistence/dual-read-merger.ts`                     | New (P5) | `mergeMongoAndCH<T>()` UNION + Mongo-wins-dedup pure function                                                                                                                                                                                                                                                                                                                                                                         |
| `apps/workflow-engine/src/persistence/hybrid-execution-reader.ts`              | New (P5) | Dual-read reader for workflow-executions list + detail; OTel latency histogram per call                                                                                                                                                                                                                                                                                                                                               |
| `apps/workflow-engine/src/persistence/hybrid-read-metrics.ts`                  | New (P5) | Shared `workflow_dual_read_request_latency_ms` histogram for execution + human-task readers                                                                                                                                                                                                                                                                                                                                           |
| `apps/workflow-engine/src/outbox/workflow-event-outbox-writer.ts`              | New (P3) | Transactional outbox writer + `buildOutboxPayload()` mapper; `_id = event.event_id` (dedup contract)                                                                                                                                                                                                                                                                                                                                  |
| `apps/workflow-engine/src/outbox/event-builders.ts`                            | New (P3) | Pure status → event_type mappers + typed builders for execution + human-task events                                                                                                                                                                                                                                                                                                                                                   |
| `apps/workflow-engine/src/outbox/execution-persistence-with-outbox.ts`         | New (P3) | Decorators (`ExecutionPersistenceWithOutbox` + `HumanTaskStoreWithOutbox`) that wrap the raw stores and emit outbox rows inside `withTransaction`                                                                                                                                                                                                                                                                                     |
| `apps/workflow-engine/src/outbox/outbox-poller.ts`                             | New (P3) | BullMQ repeatable poller — concurrency 1, jobId-based leader lock, `publishAndAck` to Kafka, retry + lastError bookkeeping                                                                                                                                                                                                                                                                                                            |
| `apps/workflow-engine/src/outbox/flag-gates.ts`                                | New (P2) | Central flag reader — `{outboxEnabled, chSinkEnabled, dualReadEnabled, mongoTtlEnabled}`                                                                                                                                                                                                                                                                                                                                              |
| `apps/workflow-engine/src/outbox/metrics.ts`                                   | New (P3) | OTel meter handles for outbox — unpublished-rows gauge, publish-latency histogram, success/failure counters                                                                                                                                                                                                                                                                                                                           |
| `packages/database/src/models/workflow-event-outbox.model.ts`                  | New (P2) | Mongoose model + indexes (poller hot-path, TTL partial-filter on `{publishedAt:$type:date}`, per-entity ordering)                                                                                                                                                                                                                                                                                                                     |
| `packages/database/src/models/workflow-execution.model.ts`                     | Modified | Added `expiresAt: Date \| null` + flag-gated TTL partial-filter index                                                                                                                                                                                                                                                                                                                                                                 |
| `packages/database/src/models/human-task.model.ts`                             | Modified | Added `expiresAt: Date \| null` + flag-gated TTL partial-filter index                                                                                                                                                                                                                                                                                                                                                                 |
| `packages/database/src/cascade/event-cascade-hooks.ts`                         | Modified | `EventCascadeHook.deleteByExecutionIds?` marked optional — additive; old implementations work unchanged                                                                                                                                                                                                                                                                                                                               |
| `packages/database/src/cascade/cascade-delete.ts`                              | Modified | `deleteTenant()` now drops `WorkflowExecution`, `workflow`-mailbox `HumanTask`, `WorkflowEventOutbox`                                                                                                                                                                                                                                                                                                                                 |
| `packages/eventstore/src/schema/events/workflow-execution-events.ts`           | New (P2) | Flat-object Zod schema + enum + explicit `registerWorkflowExecutionEvents(registry)`                                                                                                                                                                                                                                                                                                                                                  |
| `packages/eventstore/src/schema/events/human-task-events.ts`                   | New (P2) | Flat-object Zod schema with `mailbox: z.literal('workflow')` belt-and-suspenders scope guard                                                                                                                                                                                                                                                                                                                                          |
| `packages/eventstore/src/stores/clickhouse/workflow-execution-events-table.ts` | New (P2) | CH DDL — raw `workflow_execution_events` (MergeTree) + `workflow_executions_latest` (ReplacingMergeTree) + MV                                                                                                                                                                                                                                                                                                                         |
| `packages/eventstore/src/stores/clickhouse/human-task-events-table.ts`         | New (P2) | CH DDL — raw `human_task_events` + `human_tasks_latest` + MV (WHERE mailbox='workflow')                                                                                                                                                                                                                                                                                                                                               |
| `packages/eventstore/src/stores/clickhouse/init-workflow-event-tables.ts`      | New (P2) | Idempotent `CREATE … IF NOT EXISTS` orchestrator — streams → projections → MVs order                                                                                                                                                                                                                                                                                                                                                  |
| `packages/eventstore/src/queues/kafka-queue.ts`                                | Modified | Added `publishAndAck(topic, event, key?)` with `acks: -1`. **Post-sync**: module-load `lz4js` codec registration (KafkaJS has no built-in LZ4; broker `compression.type=lz4` forces recompression); consumer `subscribe → run` fused into a single promise chain to fix a startup race.                                                                                                                                               |
| `packages/eventstore/src/index.ts`                                             | Modified | Post-sync: explicit named re-exports for `registerWorkflowExecutionEvents` / `registerHumanTaskEvents` / schemas — the prior `export type *` stripped value exports.                                                                                                                                                                                                                                                                  |
| `packages/eventstore/src/retention/workflow-event-lifecycle.ts`                | New (P4) | `IEventLifecycle` impl for the 4 workflow tables — plan-tiered retention (FR-8)                                                                                                                                                                                                                                                                                                                                                       |
| `apps/runtime/src/services/eventstore-singleton.ts`                            | Modified | Registers `deleteByExecutionIds` cascade hook + instantiates `WorkflowEventLifecycle` retention; exposes `getWorkflowRetention()`. **Post-sync**: calls `registerWorkflowExecutionEvents` + `registerHumanTaskEvents` at init so the `EventRegistry` is populated before the consumer receives any message.                                                                                                                           |
| `apps/runtime/src/services/workflow-events-consumer.ts`                        | New (P4) | Two `KafkaEventQueue` instances (explicit groupIds) + two `BufferedClickHouseWriter`s (1K batch / 1s flush); Zod-validates at entry. **Post-sync**: `BufferedClickHouseWriter` `table:` options now use fully-qualified `abl_platform.*` names; added `toChDateTime()` helper that rewrites ISO-8601 → CH `YYYY-MM-DD HH:MM:SS.sss` space-separator format for every timestamp column.                                                |
| `apps/runtime/src/services/workflow-events-consumer-metrics.ts`                | New (P4) | OTel meter handles for consumer — lag histogram, ingest-latency histogram, flush success/failure counters                                                                                                                                                                                                                                                                                                                             |
| `apps/runtime/src/services/workflow-cascade-hook.ts`                           | New (P4) | `cascadeWorkflowByExecutionIds()` — concurrent CH + Mongo delete; `cascadeWorkflowTenant()` for tenant-wide CH fan-out                                                                                                                                                                                                                                                                                                                |
| `apps/runtime/src/services/hybrid-human-task-reader.ts`                        | New (P5) | `mailbox='workflow'` dual-read reader; local inlined copy of `mergeMongoAndCH` (LLD §7 promotion path). **Post-sync**: file header + inline comments rewritten to document the 2-layer scope guard — Mongo filter + MV `WHERE` clause at projection time. The `human_tasks_latest` table intentionally drops the `mailbox` column (the MV already filtered it) so `queryCh()` deliberately OMITS `mailbox = 'workflow'` from the SQL. |
| `apps/workflow-engine/src/index.ts`                                            | Modified | **Post-sync**: validates the TTL partial-filter index shape at startup — inspects `listIndexes()` for `workflow_executions` + `human_tasks`, extracts `partialFilterExpression.expiresAt.$type`, and refuses to start with CRITICAL log + `process.exit(1)` if missing or wrong-shaped. Only runs when `WORKFLOW_MONGO_TTL_ENABLED=true`.                                                                                             |
| `apps/workflow-engine/src/outbox/outbox-poller.ts`                             | Modified | **Post-sync (round 1)**: wraps both success-path and failure-path `updateOne` in try/catch so a transient Mongo hiccup during bookkeeping does not abort the remaining rows in the batch. Emits `workflow.outbox.bookkeeping_failed` log; ReplacingMergeTree `_version` dedup absorbs any duplicate publish on the next drain cycle.                                                                                                  |
| `apps/runtime/src/routes/human-tasks.ts`                                       | Modified | **Post-sync (round 3)**: extracted `parseStatusList` + `HUMAN_TASK_STATUS_VALUES` to the public surface; Zod-validates comma-separated multi-value. **Post-sync (round 4)**: final `findOneAndUpdate` filter now includes `projectId` alongside `_id` + `tenantId` — closes a cross-project mutation gap at the atomic update site.                                                                                                   |

### Routes / Handlers

| File                                                                               | Status    | Purpose                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/workflow-engine/src/routes/workflow-executions.ts`                           | Modified  | GET list + GET /:id route through `hybridReader` when dual-read flag on; CH-miss fallback returns `{...chRow, steps: []}` so UI knows to render reduced view                                                         |
| `apps/workflow-engine/src/routes/test-diagnostic.ts`                               | New (P3)  | `GET /api/admin/test/workflow-outbox`, `POST /workflow-outbox/force-publish`, `GET /workflow-executions/:id/mongo-raw`, `GET /workflow-executions/:id/hybrid?mode=…` (NODE_ENV=test only)                            |
| `apps/runtime/src/routes/human-tasks.ts`                                           | Modified  | Accepts comma-separated `status=pending,assigned,in_progress` multi-value; when `mailbox=workflow` and the hybrid-reader factory is set, routes through `HybridHumanTaskReader`; agent-mailbox path stays Mongo-only |
| `apps/runtime/src/routes/test-diagnostic-workflow.ts`                              | New (P4)  | `GET /workflow-ch-events/:executionId`, `GET /human-tasks-latest/:taskId`, `POST /workflow-consumer/flush` (NODE_ENV=test only, authMiddleware stack, tenant-scoped)                                                 |
| `apps/studio/src/app/api/projects/[id]/workflows/[workflowId]/executions/route.ts` | Unchanged | Existing proxy — no change                                                                                                                                                                                           |
| `apps/studio/src/app/api/projects/[id]/human-tasks/route.ts`                       | Unchanged | Existing proxy — no change                                                                                                                                                                                           |

### UI Components

| File                                                               | Status    | Purpose                                                                                                                                                                |
| ------------------------------------------------------------------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/components/inbox/UnifiedInboxPage.tsx`            | Modified  | Default status filter `['pending','assigned','in_progress']` + "Include completed" toggle with `data-testid="inbox-include-completed-toggle"`                          |
| `apps/studio/src/hooks/useHumanTasks.ts`                           | Modified  | `status` param accepts `HumanTaskStatus \| HumanTaskStatus[]`; arrays joined with commas for the query-string contract                                                 |
| `apps/studio/src/api/human-tasks.ts`                               | Modified  | Same `status` array-forwarding change in the `listHumanTasks` client                                                                                                   |
| `apps/studio/src/components/workflows/tabs/WorkflowMonitorTab.tsx` | Unchanged | No change this feature — the CH-read-through for historical executions is transparent to the component (the hybrid reader returns `{...chRow, steps: []}` via the API) |

### Jobs / Workers / Background Processes

| File                                                            | Status    | Purpose                                                                                                                                                                                                                       |
| --------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/workflow-engine/src/outbox/outbox-poller.ts`              | New (P3)  | BullMQ repeatable job — single leader via Redis, concurrency 1, 1s poll; `publishAndAck` to Kafka; retry + `lastError` bookkeeping                                                                                            |
| `apps/runtime/src/services/workflow-events-consumer.ts`         | New (P4)  | Shipped at the flat `services/` path (not `event-bus/` — matches sibling `eventstore-singleton.ts` convention). Two `KafkaEventQueue` instances (explicit groupIds) + two `BufferedClickHouseWriter`s (1K batch / 1s flush)   |
| `packages/eventstore/src/retention/event-retention-service.ts`  | Unchanged | Platform retention unchanged — Phase 4 ships a separate `WorkflowEventLifecycle` that instantiates its own `EventRetentionService` via `getWorkflowRetention()` (avoid coupling workflow retention to the platform lifecycle) |
| `packages/eventstore/src/retention/workflow-event-lifecycle.ts` | New (P4)  | Dedicated `IEventLifecycle` impl for the 4 workflow tables: purgeExpired / scrubPII / deleteBySessionIds (no-op) / anonymizeActor (no-op) / deleteTenant                                                                      |
| `tools/test-infra/parity-check.ts`                              | New (P6)  | Mongo ↔ CH parity CLI — 10-field diff over a random sample, drift-threshold gate, per-field drift histogram                                                                                                                   |

### Tests

Authoritative test-file mapping is maintained in the test spec at [`docs/testing/sub-features/workflow-execution-event-sourcing.md#11-test-file-mapping`](../../testing/sub-features/workflow-execution-event-sourcing.md#11-test-file-mapping). Summary of shipped tests:

| File                                                                                  | Tier         | Status           | Coverage Focus                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------- | ------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/workflow-engine/src/__tests__/system-outbox-atomicity.test.ts`                  | system (INT) | SHIPPED          | INT-01 — outbox + domain tx atomicity via `MongoMemoryReplSet` (happy / abort / flag-off)                                                                                                                                                                                                                                                                                                      |
| `apps/workflow-engine/src/outbox/__tests__/workflow-event-outbox-writer.test.ts`      | unit         | SHIPPED          | Outbox writer + `buildOutboxPayload()` shape                                                                                                                                                                                                                                                                                                                                                   |
| `apps/workflow-engine/src/outbox/__tests__/execution-persistence-with-outbox.test.ts` | unit         | SHIPPED          | Decorator coverage — transaction scope, flag-off bypass, mailbox scope guard                                                                                                                                                                                                                                                                                                                   |
| `apps/workflow-engine/src/outbox/__tests__/outbox-poller.test.ts`                     | unit         | SHIPPED          | Poller drain semantics — success updates `publishedAt`, failure increments `retryCount`                                                                                                                                                                                                                                                                                                        |
| `apps/workflow-engine/src/routes/__tests__/test-diagnostic.test.ts`                   | unit         | SHIPPED          | Phase 3 test-diagnostic routes — auth, tenant scoping, query-param coercion, NODE_ENV guard                                                                                                                                                                                                                                                                                                    |
| `apps/workflow-engine/src/persistence/__tests__/execution-store.session.test.ts`      | unit         | SHIPPED          | Session-threading forwarded to `updateOne` / `findOneAndUpdate`                                                                                                                                                                                                                                                                                                                                |
| `apps/workflow-engine/src/outbox/__tests__/flag-gates.test.ts`                        | unit         | SHIPPED          | UT-03 — flag-gate 16-combination matrix                                                                                                                                                                                                                                                                                                                                                        |
| `apps/workflow-engine/src/persistence/__tests__/dual-read-merger.test.ts`             | unit         | SHIPPED          | UT-05 — merger pure function (9 tests: empty, disjoint, overlap, sort, dup keys)                                                                                                                                                                                                                                                                                                               |
| `apps/workflow-engine/src/persistence/__tests__/hybrid-execution-reader.test.ts`      | unit         | SHIPPED          | HybridExecutionReader — flag gating, Mongo-wins-overlap, CH-failure fallback, inspection                                                                                                                                                                                                                                                                                                       |
| `apps/workflow-engine/src/persistence/__tests__/workflow-ttl.test.ts`                 | unit         | SHIPPED          | workflow-ttl helpers — flag × terminal × mailbox × custom-seconds override                                                                                                                                                                                                                                                                                                                     |
| `apps/runtime/src/services/__tests__/workflow-events-consumer.test.ts`                | unit         | SHIPPED          | UT-02 row mappers + UT-04 Zod validation + consumer dispatch + mailbox literal guard                                                                                                                                                                                                                                                                                                           |
| `apps/runtime/src/services/__tests__/hybrid-human-task-reader.test.ts`                | unit         | SHIPPED          | HybridHumanTaskReader — flag gating, multi-status `$in`, mailbox='workflow' scope, CH fail                                                                                                                                                                                                                                                                                                     |
| `apps/runtime/src/routes/__tests__/test-diagnostic-workflow.test.ts`                  | unit         | SHIPPED          | Phase 4 test-diagnostic routes — auth, CH query-param forwarding, 404 miss, NODE_ENV guard                                                                                                                                                                                                                                                                                                     |
| `apps/runtime/src/routes/__tests__/human-tasks-status-parser.test.ts`                 | unit         | SHIPPED          | UT-04 — `?status=` enum parser: 9 cases (absent / empty / single / comma / whitespace / dedupe / unknown / mixed / all-enums)                                                                                                                                                                                                                                                                  |
| `apps/workflow-engine/src/__tests__/execution-lifecycle.e2e.test.ts`                  | e2e (gated)  | SHIPPED (pilot)  | **E2E-01** — operator-provisioned stack. Gated via `helpers/e2e-gate.ts` — skips unless required flags + `E2E_AUTH_TOKEN` + reachable workflow-engine/runtime/CH/Kafka. Run via `pnpm --filter=@agent-platform/workflow-engine test:e2e`.                                                                                                                                                      |
| `apps/workflow-engine/src/__tests__/dual-read.e2e.test.ts`                            | e2e (gated)  | SHIPPED          | **E2E-02** — hybrid inspector mongo-only vs ch-only vs union parity + 404 on unknown execution. Additionally requires `WORKFLOW_DUAL_READ_ENABLED=true` + `CLICKHOUSE_USER`/`CLICKHOUSE_PASSWORD` on the workflow-engine.                                                                                                                                                                      |
| `apps/workflow-engine/src/__tests__/trigger-to-ch.e2e.test.ts`                        | e2e (gated)  | SHIPPED (scoped) | **E2E-06 (scoped)** — cross-entity CH correlation: execute workflow → both `workflow_execution_events` and `human_task_events` land in CH with shared `execution_id`. Requires `E2E_HUMAN_TASK_WORKFLOW_ID` to point at a workflow whose first step creates a human_task; skips mid-run if the seeded workflow doesn't fire a task on bare input. Full approve/claim roundtrip still deferred. |
| `packages/eventstore/src/schema/events/__tests__/workflow-execution-events.test.ts`   | unit         | SHIPPED          | UT-01 — workflow-execution Zod round-trip + registry registration                                                                                                                                                                                                                                                                                                                              |
| `packages/eventstore/src/schema/events/__tests__/human-task-events.test.ts`           | unit         | SHIPPED          | UT-01 — human-task Zod + literal-mailbox rejection                                                                                                                                                                                                                                                                                                                                             |
| `packages/eventstore/src/retention/__tests__/workflow-event-lifecycle.test.ts`        | unit         | SHIPPED          | 5-method `IEventLifecycle` contract + FR-8 retention pipeline via `EventRetentionService`                                                                                                                                                                                                                                                                                                      |
| `packages/database/src/cascade/__tests__/event-cascade-hooks.test.ts`                 | unit         | SHIPPED          | UT-06 — `deleteByExecutionIds` optional chaining backward-compat                                                                                                                                                                                                                                                                                                                               |

Deferred integration + E2E tests — tracked as GAP-008 pending dockerized-CH harness:

| Test ID | Tier        | Planned Path                                                                                                                                                                                                                                                                                                                                                              | Deferred To                |
| ------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| INT-02  | integration | `apps/workflow-engine/src/__tests__/system-outbox-leader.test.ts`                                                                                                                                                                                                                                                                                                         | CH-integration PR          |
| INT-03  | integration | `apps/runtime/src/__tests__/workflow-consumer.integration.test.ts`                                                                                                                                                                                                                                                                                                        | CH-integration PR          |
| INT-04  | integration | `apps/workflow-engine/src/__tests__/mongo-ttl.integration.test.ts`                                                                                                                                                                                                                                                                                                        | CH-integration PR          |
| INT-05  | integration | `apps/runtime/src/__tests__/gdpr-workflow-cascade.integration.test.ts`                                                                                                                                                                                                                                                                                                    | CH-integration PR          |
| INT-06  | integration | `apps/workflow-engine/src/__tests__/user-isolation-parity.integration.test.ts`                                                                                                                                                                                                                                                                                            | CH-integration PR          |
| INT-07  | integration | `apps/workflow-engine/src/__tests__/flag-matrix.integration.test.ts`                                                                                                                                                                                                                                                                                                      | CH-integration PR          |
| INT-08  | integration | `apps/workflow-engine/src/__tests__/error-paths.integration.test.ts`                                                                                                                                                                                                                                                                                                      | CH-integration PR          |
| E2E-03  | e2e (pw)    | `apps/studio/e2e/workflows/monitor-historical.spec.ts`                                                                                                                                                                                                                                                                                                                    | Studio Playwright + TTL PR |
| E2E-04  | e2e (pw)    | `apps/studio/e2e/inbox/default-filter.spec.ts`                                                                                                                                                                                                                                                                                                                            | Studio Playwright + TTL PR |
| E2E-05  | e2e         | `apps/runtime/src/__tests__/gdpr-cascade.e2e.test.ts` — **blocked**: no HTTP tenant-cascade endpoint exposed. `cascadeWorkflowTenant` is a function (`apps/runtime/src/services/workflow-cascade-hook.ts`) but no admin route calls it. Build the endpoint first (e.g. `POST /api/admin/tenants/:id/cascade-delete` gated behind `NODE_ENV=test` + platform-admin scope). | Separate route-addition PR |
| LOAD-02 | load        | `apps/workflow-engine/src/__tests__/load-smoke.test.ts` (k6 + dockerized CH)                                                                                                                                                                                                                                                                                              | LOAD-02 CI smoke PR        |

---

## 11. Configuration

### Environment Variables

| Variable                              | Default                  | Description                                                                                                                                                                                      |
| ------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WORKFLOW_OUTBOX_ENABLED`             | `false`                  | Gate transactional outbox writes in workflow-engine + decorator wiring + BullMQ poller startup.                                                                                                  |
| `WORKFLOW_CH_SINK_ENABLED`            | `false`                  | Gate runtime-side Kafka → CH `BufferedClickHouseWriter` consumer startup.                                                                                                                        |
| `WORKFLOW_DUAL_READ_ENABLED`          | `false`                  | Gate UNION read path on workflow-engine + runtime list/detail endpoints. Hybrid readers are lazily wired at startup when on.                                                                     |
| `WORKFLOW_MONGO_TTL_ENABLED`          | `false`                  | Gates TTL partial-filter index creation at schema-load time AND `expiresAt` population on terminal transitions (flip both together — orphans a flag-off caller from ever populating the column). |
| `WORKFLOW_MONGO_TTL_SECONDS`          | `1209600` (14 days)      | Override for the TTL window. Malformed values fall back to the default. LLD §6.1 — narrow to 172800 (48 h) after 1 week staging observation.                                                     |
| `WORKFLOW_OUTBOX_ALERT_THRESHOLD`     | `10000`                  | Startup gate on TTL enablement — if `workflow_event_outbox.countDocuments({publishedAt:null}) > threshold` and TTL is being turned on, workflow-engine logs a warn-level safety alert.           |
| `WORKFLOW_OUTBOX_POLL_INTERVAL_MS`    | `1000`                   | BullMQ repeatable poll interval (ms). Default raised from LLD's 100ms to 1000ms — matches what the poller actually ships with.                                                                   |
| `WORKFLOW_OUTBOX_BATCH_SIZE`          | `100`                    | Max rows fetched per outbox drain.                                                                                                                                                               |
| `WORKFLOW_CH_RETENTION_OVERRIDE_DAYS` | unset                    | Operational override for CH retention (test/staging only; production uses plan-based via `RetentionPolicy`).                                                                                     |
| `WORKFLOW_EVENT_TOPIC_EXECUTION`      | `abl.workflow.execution` | Kafka topic for workflow execution events.                                                                                                                                                       |
| `WORKFLOW_EVENT_TOPIC_HUMAN_TASK`     | `abl.human.task`         | Kafka topic for workflow-sourced human-task events.                                                                                                                                              |
| `EVENT_KAFKA_BROKERS`                 | `localhost:9092`         | Comma-separated Kafka broker list — used by both the workflow-engine outbox poller and the runtime consumer.                                                                                     |

### Runtime Configuration

- Feature flags above are loaded via the existing runtime config loader (`apps/runtime/src/config/index.ts`) with per-environment overrides allowed.
- Plan-based retention is resolved at table-DDL time by the `EventRetentionService` — no per-request flag.
- Kafka topic partition count and retention are owned by `docker-compose.yml` (dev) and the corresponding Helm / Terraform in `abl-platform-deploy` / `abl-platform-infra` (prod).

### DSL / Agent IR / Schema

N/A. No DSL or IR changes. Event payload schemas are registered at runtime via `EventRegistry` in `packages/eventstore`.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant isolation  | Every outbox row, Kafka message, CH row, and MV projection must carry `tenant_id`. All CH queries filter by `tenant_id` as the leading sort key. Cross-tenant reads return empty / 404.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Project isolation | Every outbox row, Kafka message, CH row, and MV projection carries `project_id`. API routes under `/api/projects/:projectId/...` filter by `projectId` in both Mongo and CH legs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| User isolation    | Workflow executions are **project-scoped, not user-owned** — any user with `workflow:read` on the project may view any execution. Human tasks carry `assigned_to[]`, `claimed_by`, `responded_by`. The UNION read path (FR-6) MUST apply the same visibility filter against the CH projection as against Mongo: for user-scoped task queries the filter must match `assigned_to` array-contains `userId` OR `claimed_by = userId` (admins/owners bypass per existing logic). The UNION implementation contract passes the authenticated user identity into the CH query — CH must not return rows the Mongo path would have hidden. Cross-user access (outside assignment) returns 404 to avoid leaking task existence. |

### Security & Compliance

- Authn/authz: existing `createUnifiedAuthMiddleware` / `requireAuth` + `requireProjectPermission('workflow:read' / 'human_task:read')` applied unchanged.
- CH workflow-event tables carry raw tenant and execution identifiers. Studio and API responses are sanitized per CLAUDE.md User-Facing Runtime Error Sanitization — no tenantId leakage in user-visible payloads.
- PII in event payloads (trigger payload, step output, human-task response fields) is registered with `containsPII: true` in the `EventRegistry`. PII scrubbing follows the existing eventstore pattern.
- GDPR right-to-erasure: FR-10 `EventCascadeHook` guarantees deletion cascade across Mongo (executions, workflow-sourced tasks, outbox) and CH (event tables + `*_latest` MVs). Closes `workflows.md` GAP-12.
- Secrets: event payloads must not carry credentials, API keys, or auth tokens. Existing workflow step sanitization applies.

### Performance & Scalability

- **Write path**: each state transition adds one Mongo insert (outbox). Overhead ~1–3 ms per transition. At 500K runs/day × 10 events = 5M outbox writes/day, adequately absorbed by a Mongo replica set.
- **Kafka throughput**: 5M events/day = ~60 events/s avg, with bursts to several hundred. Well below the `KafkaEventQueue` 100K events/s capacity. 3 partitions sufficient initially; scale by tenant partition pressure.
- **CH ingest lag budget**: Kafka linger 500 ms + buffered writer 5s flush + CH merge ≈ **≤10 s p95** end-to-end.
- **CH read latency**: `workflow_executions_latest` queries filtered by `(tenant_id, workflow_id)` hit the sort-key index directly. Target **p95 ≤ 200 ms** for list queries over current quarter; **≤ 500 ms** for multi-year aggregates.
- **Mongo working set**: bounded by in-flight runs + 48h completed ≈ 100 concurrent × 100 KB + 48h × 500K × 100 KB ÷ 30 ≈ ~1.5 GB steady state per tenant at peak. Index pressure proportional.
- **Outbox size**: ~11 GB peak (7-day retention at 500K runs × 10 events × ~300 bytes).

### Reliability & Failure Modes

- **Outbox durability**: outbox row is written in the same Mongo transaction as the domain update. A crash between Mongo commit and Kafka publish leaves the row unpublished; the poller retries. A crash between Kafka ack and outbox mark-published also retries — idempotent via `event_id` dedup at CH.
- **Kafka unavailability**: outbox accumulates; Mongo writes and reads continue. When Kafka recovers, poller drains the backlog.
- **CH unavailability**: Kafka buffers up to its retention (7d). When CH recovers, consumer catches up.
- **Consumer lag**: monitored via the existing Kafka consumer lag metrics in `KafkaEventQueue`. Alert at p95 > 60 s for 5 minutes.
- **Mongo TTL failure**: TTL thread stall → retention SLA slips; monitored via `db.serverStatus().metrics.ttl.deletedDocuments`. Alert on flatline.
- **Flag rollback**: Any flag can flip off to short-circuit the corresponding behavior. The TTL flag dropping removes indexes (stops new deletions); already-deleted rows are unrecoverable from Mongo alone — recovery path depends on CH (where the data also lives).
- **Feature degradation**: if CH is completely unavailable and dual-read is enabled, requests falling back to Mongo-only still serve active + recent data (<48h). Users see "historical runs unavailable — retry shortly" on older-than-48h queries.

### Observability

- **Metrics (new)**:
  - `workflow_outbox_unpublished_rows` (gauge, per tenant)
  - `workflow_outbox_publish_latency_ms` (histogram)
  - `workflow_outbox_publish_attempts` (counter)
  - `workflow_kafka_consumer_lag_ms` (per topic, per partition)
  - `workflow_ch_ingest_latency_ms` (buffered-writer flush latency)
  - `workflow_dual_read_path_distribution` (counter labeled `source ∈ {mongo, ch, union}`)
  - `workflow_ttl_deleted_documents` (counter, per collection)
- **Traces**: every state transition emits a `TraceEvent` via the existing `TraceStore` — unchanged.
- **Logs**: outbox publish failures log error level with `event_id`, `attempts`, `last_error`. CH consumer dedup hits log debug.
- **Dashboards**: extend the existing eventstore Grafana dashboards with workflow-execution-events rows. Add a "Mongo ↔ CH parity" panel used during Phase A observation window to gate the Phase B flag flip.
- **Alerts**:
  - `workflow_outbox_unpublished_rows > 10K` for 5 minutes → on-call alert
  - `workflow_kafka_consumer_lag_ms p95 > 60s` for 5 minutes → on-call alert
  - `workflow_ttl_deleted_documents` flatline for 1 hour with non-zero active data → warning

### Data Lifecycle

| Store                                                | Retention                                          | Mechanism                                     |
| ---------------------------------------------------- | -------------------------------------------------- | --------------------------------------------- |
| Mongo `workflow_executions`                          | In-flight forever; completed `completedAt + 48h`   | Partial-filter TTL index (Phase B flag)       |
| Mongo `human_tasks` (`mailbox='workflow'`, terminal) | `updatedAt + 48h`                                  | Partial-filter TTL index (Phase B flag)       |
| Mongo `workflow_event_outbox`                        | Unpublished forever; published `published_at + 7d` | Partial-filter TTL index                      |
| Kafka `abl.workflow.execution`, `abl.human.task`     | 7 days                                             | Topic config (`retention.ms=604800000`)       |
| CH `workflow_execution_events`                       | Plan-tiered (30d / 90d / 365d / 7y)                | `TTL occurred_at + INTERVAL` + partition drop |
| CH `human_task_events`                               | Plan-tiered (same)                                 | Same                                          |
| CH `workflow_executions_latest`                      | Plan-tiered (aligned with source)                  | Same                                          |
| CH `human_tasks_latest`                              | Plan-tiered (aligned with source)                  | Same                                          |

GDPR right-to-erasure cascades all seven stores via the `EventCascadeHook` registered in `eventstore-singleton.ts` (FR-10).

---

## 13. Delivery Plan / Work Breakdown

Two phases, feature-flag-gated (Q15=B). Each phase commits independently under real Jira keys.

1. **Phase A — Shadow write + dual-read (behind flags)**
   1.0 Extend `EventCascadeHook` interface at `packages/database/src/cascade/event-cascade-hooks.ts` to add `deleteByExecutionIds(tenantId: string, executionIds: string[]): Promise<void>`. Update every existing hook implementation with a no-op default (backward-compatible). Ship this interface extension as its own commit before any of the workflow-specific code lands.
   1.1 Add `workflow_event_outbox` MongoDB collection schema + Mongoose model.
   1.2 Register workflow execution and human-task event schemas in `EventRegistry` (`packages/eventstore/src/schema/events/`).
   1.3 Wire transactional outbox writer into `ExecutionStore` and `HumanTaskStore`.
   1.4 Implement BullMQ-repeatable outbox poller (`outbox-poller.ts`). Publishes to `abl.workflow.execution` / `abl.human.task`.
   1.5 Add the two Kafka topics to `docker-compose.yml` `init-kafka-topics` service (and to the corresponding Helm / Terraform).
   1.6 Build Kafka-to-CH consumer service (`workflow-events-consumer.ts`) reusing `BufferedClickHouseWriter`.
   1.7 Ship ClickHouse DDL: `workflow_execution_events`, `human_task_events`, `workflow_executions_latest` (+ MV), `human_tasks_latest` (+ MV). Codec conventions match `platform_events`.
   1.8 Extend `EventRetentionService` to cover the four new CH tables.
   1.9 Extend `/api/projects/.../executions` (workflow-engine) and `/api/projects/.../human-tasks` (runtime) with UNION Mongo + CH logic behind `WORKFLOW_DUAL_READ_ENABLED`.
   1.10 Build Mongo ↔ CH parity-check script (standalone CLI or cron) used to observe drift during Phase A.
   1.11 Register the workflow-specific `EventCascadeHook` (FR-10).
   1.12 Update Studio Inbox `UnifiedInboxPage.tsx` with default status filter + "Include completed" toggle (FR-9).
   1.13 Ship all tests (integration + e2e + parity). Run `pnpm test:report` to ensure zero regressions.
   1.14 Deploy with all flags OFF. Flip flags progressively in production: `OUTBOX_ENABLED` → observe outbox lag → `CH_SINK_ENABLED` → observe CH ingest + parity-check → `DUAL_READ_ENABLED` → observe API latency distribution.

2. **Phase B — Mongo TTL enablement**
   2.1 Gate TTL index creation on `WORKFLOW_MONGO_TTL_ENABLED`. Index creation runs as an idempotent Mongo migration on startup (ensureIndex) when flag is true.
   2.2 Initial rollout: set TTL to 14 days (conservative). Observe parity-check for one week.
   2.3 Narrow to 48h once confidence is high.
   2.4 Remove any leftover Mongo-only read fallback; CH becomes the sole source for runs >48h old.
   2.5 Publish post-impl-sync: feature spec status PLANNED → ALPHA (requires passing E2E + integration test suites per SDLC pipeline).

---

## 14. Success Metrics

| Metric                                          | Baseline                                        | Target                                       | How Measured                                                    |
| ----------------------------------------------- | ----------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------- |
| Mongo `workflow_executions` collection size     | Growing linearly with total runs                | Flat (bounded by concurrent + 48h completed) | `db.workflow_executions.stats().size` over 4 weeks post-Phase-B |
| Mongo working-set page-fault rate               | X (pre-release baseline)                        | ≤ 20% of baseline                            | Mongo server metrics                                            |
| Monitor tab p95 list-query latency              | Current Mongo-only p95                          | ≤ current + 50 ms (target parity)            | Studio API latency dashboards                                   |
| Historical (>48h) execution visibility coverage | 0% (no CH today)                                | 100% of runs within retention tier visible   | Parity-check script sampling                                    |
| Outbox unpublished backlog                      | N/A                                             | 0 at steady state; < 10K during incident     | `workflow_outbox_unpublished_rows` metric                       |
| Kafka → CH ingest lag p95                       | N/A                                             | ≤ 10s                                        | `workflow_ch_ingest_latency_ms` metric                          |
| GDPR delete cascade completeness                | `workflows.md` GAP-12 open (no cascade)         | 100% (all 7 stores purged)                   | Integration test                                                |
| Workflow audit coverage                         | `workflows.md` GAP-10 open (no lifecycle audit) | 100% of state transitions captured in CH     | Parity-check script                                             |

---

## 15. Open Questions

1. **Back-pressure on high-fanout runs**: a single workflow execution can generate 20+ step events in a short window. Does the current `BufferedClickHouseWriter` (10K batch / 5s) maintain ingest SLA under burst loads from many concurrent runs? Need a load test at Phase A exit to validate.
2. **Agent-escalation parallel track**: when the Memory & Sessions team scopes tiering for `mailbox='agent'` tasks, will they extend `abl.human.task` with a relaxed filter, or introduce `abl.agent.escalation`? Cross-team coordination point — flag in parent `workflows.md` Open Questions.
3. **Backfill of pre-release data**: should we ship a one-time migration script to seed CH with historical completed executions from Mongo at Phase A rollout, even though the 48h window covers the gap going forward? Nice-to-have; decides whether dashboards have immediate historical coverage or build up over weeks.
4. **UI analytical dashboards**: the new CH tables enable trend charts, duration heatmaps, per-workflow success-rate panels. When does this get scoped as a follow-up feature — same release or later?
5. **Inbox "Include completed" toggle state persistence**: should the toggle state persist per-user (localStorage) or reset on navigation? Follow default UX pattern from other Studio surfaces (TBD during implementation).
6. **Workflow-version evolution on the ReplacingMergeTree**: if a workflow definition is updated mid-run (e.g. hot reload of workflow version), `workflow_version` in the projection updates based on `argMax(occurred_at)`. Is this the right semantic or do we want to pin to the initial version at start? Product decision.

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                                                                                                                                                                                                                | Severity | Status                             |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------- |
| GAP-001 | No backfill of pre-Phase-A Mongo data into CH — dashboards build up over weeks of runtime history.                                                                                                                                                                                                                                                         | Low      | Open (see Q3 in §15)               |
| GAP-002 | Agent-escalation tasks do not benefit from tiered storage under this feature. They remain in Mongo indefinitely until the Sessions team scopes their own ticket.                                                                                                                                                                                           | Medium   | Open (scope boundary decision Q18) |
| GAP-003 | BullMQ repeatable-job leader election guarantees at-most-one concurrent poller but the lease is soft — during leader failover there may be a brief window of no poller activity (seconds). Outbox backlog drains on next leader.                                                                                                                           | Low      | Mitigated (acceptable per SLA)     |
| GAP-004 | Mongo TTL is best-effort (~60s thread cycle). Under heavy load, stale records may linger beyond the 48h window. Acceptable per design; UX is unaffected.                                                                                                                                                                                                   | Low      | Known behavior                     |
| GAP-005 | CH ingest lag creates a brief window where a just-completed run's status update lags in dual-read results. Mitigated by the 48h Mongo read-through (Mongo wins on overlap).                                                                                                                                                                                | Low      | Mitigated by design                |
| GAP-006 | Per-tenant retention overrides not supported. Plan-tiered only. Future enhancement.                                                                                                                                                                                                                                                                        | Low      | Out of scope                       |
| GAP-007 | New analytical dashboards exploiting the CH tables are not part of this feature — they require follow-up scoping.                                                                                                                                                                                                                                          | Low      | Deferred                           |
| GAP-008 | Real-infra integration + E2E tests (INT-02/03/04/05/06/07/08, E2E-01/02/03/04/05/06, LOAD-02 CI smoke) deferred to a follow-up dockerized-CH PR. Unit coverage (141 test cases across 18 files) locks down pure logic, command shapes, and flag gating in the interim; real CH + Kafka + Playwright roundtrips are required before promoting beyond ALPHA. | High     | Open (blocks BETA promotion)       |
| GAP-009 | Pre-existing `system-human-task-store.test.ts` — 2 failing tests from a string vs string[] `assignedTo` mismatch (see `docs/sdlc-logs/workflow-execution-event-sourcing/followups.md`). Unrelated to this feature; tracked separately as a test-debt Jira follow-up.                                                                                       | Low      | Open (tracked in followups.md)     |
| GAP-010 | Platform-retention cron hook (`registerEventRetentionHandler` in `apps/studio/src/services/retention/retention-scheduler.ts`) is available but no caller wires `WorkflowEventLifecycle.runRetention(tenantId, policy)` to it today. `getWorkflowRetention()` is exposed; wiring the studio-side daily cron is a separate integration.                      | Medium   | Open (FR-8 runtime-wiring gap)     |
| GAP-011 | Phase 2 `packages/eventstore/src/stores/clickhouse/init-workflow-event-tables.ts` imports from `@abl/compiler/platform` — an undeclared dep in `@abl/eventstore/package.json`. Turbo build resolves it via hoisted `node_modules`; vitest's native resolver does not. Phase 4 `WorkflowEventLifecycle` uses `@agent-platform/shared-observability`.        | Low      | Open (Phase 2 errata)              |

---

## 17. Testing & Validation

### Required Test Coverage

Full test-scenario catalog lives in the test spec — six E2E scenarios (E2E-01..E2E-06) and eight integration scenarios (INT-01..INT-08). Cross-reference (SHIPPED = landed in this feature; DEFERRED = tracked as GAP-008):

| #   | Scenario                                                                                                | Coverage Type     | Status           | Test File                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------- | ----------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Outbox row written atomically with Mongo domain update; rollback removes both                           | integration       | SHIPPED          | `apps/workflow-engine/src/__tests__/system-outbox-atomicity.test.ts` (MongoMemoryReplSet — happy / abort / flag-off)                                                                                                                                                                                                                                                          |
| 2   | Outbox poller leader election, retry, FIFO, and Kafka topic routing                                     | integration       | DEFERRED         | Retry / success semantics covered by `outbox-poller.test.ts` UT; multi-replica leader case deferred with GAP-008                                                                                                                                                                                                                                                              |
| 3   | End-to-end: execution → Mongo + outbox → Kafka → CH → MV projection                                     | e2e (gated)       | SHIPPED (pilot)  | `apps/workflow-engine/src/__tests__/execution-lifecycle.e2e.test.ts` — operator-gated via `helpers/e2e-gate.ts`. Skips unless `WORKFLOW_OUTBOX_ENABLED` + `WORKFLOW_CH_SINK_ENABLED` + `E2E_AUTH_TOKEN` + reachable workflow-engine/runtime/CH/Kafka. `pnpm --filter=@agent-platform/workflow-engine test:e2e`.                                                               |
| 4   | Dual-read UNION returns identical shape to Mongo-only path; dedup on overlap; pagination correct        | e2e (gated)       | SHIPPED          | `apps/workflow-engine/src/__tests__/dual-read.e2e.test.ts` — operator-gated. Uses the hybrid inspector endpoint to compare mongo-only / ch-only / union for the same execution; asserts Mongo-wins-on-overlap + 404 on unknown. Plus UT coverage (`dual-read-merger.test.ts`, `hybrid-execution-reader.test.ts`). Pagination parity still deferred with the broader scenario. |
| 5   | Monitor tab surfaces runs older than 48h via CH                                                         | e2e (pw)          | DEFERRED         | GAP-008 (depends on Mongo-TTL running in staging + Studio Playwright lane)                                                                                                                                                                                                                                                                                                    |
| 6   | Inbox default filter applied on load; "Include completed" toggle extends query; count badges unaffected | e2e (pw)          | PARTIAL          | UI code + API-client coverage via SHIPPED status-multi-value query; UT-04 parser now dedicated (`human-tasks-status-parser.test.ts`). Playwright spec GAP-008.                                                                                                                                                                                                                |
| 7   | GDPR cascade deletes all 7 stores for tenant + execution                                                | integration + e2e | PARTIAL          | Cascade-hook backward-compat SHIPPED (`event-cascade-hooks.test.ts`). Full 7-store cascade roundtrip DEFERRED with GAP-008.                                                                                                                                                                                                                                                   |
| 8   | Mongo TTL deletes terminal completed executions after 48h; does not delete in-flight                    | integration       | PARTIAL          | TTL write-path + flag gating SHIPPED (`workflow-ttl.test.ts`). Real Mongo TTL roundtrip DEFERRED with GAP-008.                                                                                                                                                                                                                                                                |
| 9   | Human-task user-isolation parity between CH and Mongo                                                   | integration       | DEFERRED         | GAP-008                                                                                                                                                                                                                                                                                                                                                                       |
| 10  | Flag-flip regression: 2^4 flag combinations produce valid behavior                                      | integration       | PARTIAL          | 16-combination flag-gate matrix SHIPPED as UT (`flag-gates.test.ts`). Full-stack flag-matrix DEFERRED with GAP-008.                                                                                                                                                                                                                                                           |
| 11  | Failure paths — Kafka down, CH drop, Mongo tx abort, Redis drop                                         | integration       | DEFERRED         | GAP-008 (needs docker-compose pause/unpause orchestration)                                                                                                                                                                                                                                                                                                                    |
| 12  | Cross-feature Trigger → Execution → HumanTask → CH chain                                                | e2e (gated)       | SHIPPED (scoped) | `apps/workflow-engine/src/__tests__/trigger-to-ch.e2e.test.ts` — operator-gated, scoped to CH cross-entity correlation (shared `execution_id` across `workflow_execution_events` + `human_tasks_latest`). Main case mid-run-skips if the seeded workflow doesn't produce a human_task on bare input; isolation check always runs. Full approve/claim roundtrip deferred.      |
| 13  | LOAD-02 CI smoke — outbox backlog p95 < 10 rows + CH ingest p95 < 5 s over 100 concurrent runs × 5 min  | load              | DEFERRED         | GAP-008 (requires k6 + dockerized full stack — LLD §6.5)                                                                                                                                                                                                                                                                                                                      |

### Testing Notes

- **Real-infra requirements**: tests must run against real MongoDB (MongoMemoryServer), real Kafka (KafkaJS + testcontainers or docker-compose), real ClickHouse (testcontainers or docker-compose). No mocking of codebase components per CLAUDE.md Test Architecture.
- **Mocking boundary**: only external services (LLM providers, payment APIs) mockable via DI. Kafka + CH + Mongo run for real in integration/e2e suites.
- **Parity check as a test gate**: the Mongo↔CH parity-check script is a test artifact that doubles as an operational tool during Phase A observation. Tests assert zero drift under load; the same script runs as a scheduled job in prod during rollout.
- **Load test**: at Phase A exit, run a synthetic 1M-runs-over-4-hours test to validate CH ingest SLA, Kafka lag, and outbox backlog budgets. Target: p95 ingest lag ≤ 10s, zero outbox loss, zero CH dedup conflicts.
- **Flag-matrix coverage**: every flag combination (2^4 = 16) must be asserted valid via automated test — ensures rollback safety.

> Full testing details: [`../../testing/sub-features/workflow-execution-event-sourcing.md`](../../testing/sub-features/workflow-execution-event-sourcing.md)

---

## 18. References

- Parent feature: [`docs/features/workflows.md`](../workflows.md)
- EventStore feature: [`docs/features/eventstore.md`](../eventstore.md)
- Audit Logging feature: [`docs/features/audit-logging.md`](../audit-logging.md)
- Memory & Sessions feature: [`docs/features/memory-sessions.md`](../memory-sessions.md)
- Related sub-features: [`docs/features/sub-features/workflow-triggers.md`](./workflow-triggers.md), [`docs/features/sub-features/workflow-function-node.md`](./workflow-function-node.md)
- Design references: [`docs/specs/workflows.hld.md`](../../specs/workflows.hld.md)
- Pattern references: `packages/eventstore/src/stores/clickhouse/platform-events-table.ts` (CH DDL conventions), `apps/workflow-engine/src/services/trigger-scheduler.ts` (BullMQ repeatable / leader-election pattern)
- Pipeline: [`docs/sdlc/pipeline.md`](../../sdlc/pipeline.md)
- Feature spec log: [`docs/sdlc-logs/workflow-execution-event-sourcing/feature-spec.log.md`](../../sdlc-logs/workflow-execution-event-sourcing/feature-spec.log.md)
- Ops runbook: [`docs/guides/workflow-execution-event-sourcing-ops.md`](../../guides/workflow-execution-event-sourcing-ops.md) — phased rollout, flag-flip order, Kafka topic registration, observability dashboards, rollback procedures
- Review + follow-ups: [`docs/sdlc-logs/workflow-execution-event-sourcing/implementation.log.md`](../../sdlc-logs/workflow-execution-event-sourcing/implementation.log.md) (5-round `pr-reviewer` summary) and [`followups.md`](../../sdlc-logs/workflow-execution-event-sourcing/followups.md) (FU-1..FU-5)
