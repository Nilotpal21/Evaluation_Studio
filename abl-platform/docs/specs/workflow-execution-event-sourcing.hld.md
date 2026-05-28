# HLD: Workflow Execution Event Sourcing

**Feature ID**: ABLP-2 (sub-feature of [Workflows & Human Tasks](../features/workflows.md) / [EventStore](../features/eventstore.md))
**Feature Spec**: [`../features/sub-features/workflow-execution-event-sourcing.md`](../features/sub-features/workflow-execution-event-sourcing.md)
**Test Spec**: [`../testing/sub-features/workflow-execution-event-sourcing.md`](../testing/sub-features/workflow-execution-event-sourcing.md)
**Status**: APPROVED (implementation complete, ALPHA feature state as of 2026-04-21)
**Author**: Pattabhi
**Date**: 2026-04-20
**Last Sync**: 2026-04-21 — post-implementation doc sync (round 2). LLD at `../plans/2026-04-21-workflow-execution-event-sourcing-impl-plan.md` was implemented across 38 commits on branch `feat/workflow-runs-mongo-2-clickhouse` plus a post-sync integration-hardening pass. Deviations logged in the implementation log at `../sdlc-logs/workflow-execution-event-sourcing/implementation.log.md`. Key HLD-level deviations: (a) dual-read merger kept in `apps/workflow-engine/src/persistence/` (novel pattern, not yet promoted to shared pkg — LLD §7 OQ); (b) Phase 4 retention instantiated but the daily-cron wiring via `registerEventRetentionHandler` is deferred (GAP-010); (c) Deferred integration/E2E/LOAD tests tracked as GAP-008 in the feature spec.

**Post-Implementation Notes (2026-04-21, round-2 sync)**:

- **HLD §4 concern #11 (migration path) strengthened** — startup-time TTL partial-filter validation added to `apps/workflow-engine/src/index.ts`. Boot refuses to start with CRITICAL log + `process.exit(1)` if `listIndexes()` returns a TTL index whose `partialFilterExpression.expiresAt.$type` is not `'date'`. Closes the HLD concern that a silently-broken partial filter (Mongo rejects `$ne` in partial indexes but the error only surfaces at index-build time) would let pods run without TTL protection.
- **HLD §4 concern #8 (observability) strengthened** — schema registration moved into `apps/runtime/src/services/eventstore-singleton.ts` init so `EventRegistry` carries the workflow + human-task Zod schemas before the consumer receives its first message. Previously the registry was only populated via the consumer's own entry-validation step — which was functional but observationally opaque at startup.
- **Pipeline transport deviation** — KafkaJS has no built-in LZ4 codec and the docker broker's `compression.type=lz4` forces recompression. `packages/eventstore/src/queues/kafka-queue.ts` now registers a pure-JS `lz4js` codec at module load via `createRequire` (tsx's ESM loader cannot see KafkaJS's CJS-only `CompressionTypes` / `CompressionCodecs` exports through `import`). See ops runbook `docs/guides/workflow-execution-event-sourcing-ops.md` for Node 24 compatibility notes.
- **HLD §4 concern #1 (tenant isolation) completion** — `PATCH /api/projects/:projectId/human-tasks/:id` final `findOneAndUpdate` filter now includes `projectId` alongside `_id` + `tenantId` (was `{_id, tenantId}`-only). Closes the cross-project mutation gap flagged in `pr-reviewer` round 4.
- **5-round `pr-reviewer` loop**: all rounds APPROVED. Round 5 verdict APPROVED with 0 CRITICAL / 0 HIGH. 4 non-blocking findings filed as FU-2..FU-5 in `followups.md` (poison-pill cap, consumer shutdown ordering, parity-check error_code placeholder, observable-gauge catch-swallow). See implementation.log.md §Review Rounds for the dimension-by-dimension production-readiness matrix.

---

## 1. Problem Statement

MongoDB `workflow_executions` and workflow-sourced rows in `human_tasks` grow unboundedly with run volume. At the projected scale of **100K–500K runs/day platform-wide** with 5–100 KB per execution document:

1. **Mongo working-set pressure** — hot set shrinks relative to total collection size, page faults rise, index size compounds. No TTL exists today.
2. **Query latency degrades at scale** — the Studio Monitor tab polls `GET /executions` every 5 seconds. Analytical queries spanning full history (p95 duration per workflow, trend charts, step-type heatmaps) are index-inefficient in MongoDB because of the nested `nodeExecutions[]` array shape.
3. **No analytical store for workflow data** — every other operational domain (traces, messages, metrics, audit) already flows into ClickHouse via `@abl/eventstore`. Workflow execution is the last operationally-critical domain without a matching CH projection. This is the root cause of `workflows.md` GAP-10 (no workflow-lifecycle audit) and GAP-12 (no GDPR cascade for workflow data).

**Goal**: apply the existing platform pattern — MongoDB for transactional hot-path, ClickHouse for append-only analytics — to workflow execution and workflow-sourced human-task data. Keep MongoDB as the source of truth for in-flight runs and the 48h read-through buffer for recently-completed runs. Emit lifecycle events via a transactional outbox to Kafka, sink into dedicated CH event tables, and project current state via `ReplacingMergeTree` materialized views. The API layer transparently UNIONs the two stores. Rollout is 2-phase, feature-flag gated (Phase A = shadow write + dual-read behind flags; Phase B = Mongo TTL enablement).

This HLD pins architectural decisions for Phase 3 of the SDLC (feature-spec → test-spec → **HLD** → LLD → implement → post-impl-sync) and resolves the nine open questions deferred from the test-spec plus the FR-5 MV-pattern open question deferred from the feature-spec.

---

## 2. Alternatives Considered

### Option A — Transactional Outbox + Kafka + ClickHouse (CHOSEN)

- **Description**: Workflow-engine writes every execution / workflow-sourced human-task state transition to MongoDB **and** to a shared `workflow_event_outbox` collection in a single Mongo transaction. A BullMQ-repeatable outbox poller publishes unpublished rows to two dedicated Kafka topics (`abl.workflow.execution`, `abl.human.task`). A runtime-side Kafka consumer reuses the existing `BufferedClickHouseWriter` to append rows into `workflow_execution_events` / `human_task_events`. `ReplacingMergeTree`-backed projection MVs (`workflow_executions_latest`, `human_tasks_latest`) serve the Monitor tab and Inbox for historical data (>48h) while Mongo stays authoritative for <48h. Read path UNIONs both legs behind a flag.
- **Pros**:
  1. **Exactly matches the platform's established pipeline** — `KafkaEventQueue`, `BufferedClickHouseWriter`, `EventRegistry`, `EventRetentionService`, `EventCascadeHook` all reused without modification (except a single additive method on the cascade hook).
  2. **Durable at-least-once delivery** — outbox row is atomic with domain write; poller retries until Kafka ACKs; CH dedup via `event_id` closes the loop.
  3. **Clean leader election** — BullMQ repeatable-job semantics (same pattern as `TriggerScheduler`) give us single-active-poller without introducing new Redis locks.
  4. **Decoupled read path** — Mongo and CH can degrade independently; the UNION reader falls back to Mongo-only if CH is unavailable.
  5. **Plan-tiered retention reuses `EventRetentionService`** — no new retention code; only new table registrations.
  6. **GDPR cascade is a natural extension** — `EventCascadeHook` already exists for sessions/tenants; adding `deleteByExecutionIds` plus a workflow-specific hook implementation closes GAP-12 with minimal surface area.
- **Cons**:
  1. **5 moving parts in series** (Mongo tx → outbox → poller → Kafka → CH consumer → CH merge). Each has its own failure mode; observability is non-optional.
  2. **Outbox write adds ~1–3 ms per state transition** — acceptable at the projected 60 events/s average.
  3. **ClickHouse merge lag** — the `*_latest` projection is eventually consistent across merges. Queries use `FINAL` or `argMax(... _version)` to get deterministic latest state before a background merge runs.
- **Effort**: **L** — new CH tables × 4, two Kafka topics, outbox writer + model + poller, consumer, dual-read reader, cascade hook extension, Inbox UI tweak, parity-check tooling, plus test infra (MongoMemoryReplSet switch, Kafka+CH docker-compose additions, diagnostic endpoints).

### Option B — Dual-Write from Application (no outbox)

- **Description**: Workflow-engine writes to Mongo and directly calls `KafkaEventQueue.enqueue()` in the same request. No outbox collection.
- **Pros**: Fewer components (no outbox, no poller). Lower write latency.
- **Cons**:
  1. **Not transactional** — if the Mongo write commits and Kafka publish fails (network blip, broker down), the event is lost forever. There is no retry mechanism.
  2. **Breaks "at-least-once" guarantee** required by FR-2.
  3. **No recovery path** — a 5-minute Kafka outage would silently drop thousands of events. Parity-check would detect drift but not be able to reconstruct the lost events from Mongo alone (Mongo state is cumulative; we cannot rebuild per-step event history).
  4. **Still needs CH consumer** — one fewer hop but the rest of the pipeline is unchanged.
- **Effort**: M. Rejected as architecturally unsound per CLAUDE.md "no shortcuts" principle.

### Option C — Mongo Change Data Capture (Debezium / MongoDB Connector)

- **Description**: Stream Mongo oplog into Kafka via Debezium or Kafka Connect's Mongo connector. CH consumer as in Option A.
- **Pros**: Zero app-level write overhead. CDC is a well-known pattern.
- **Cons**:
  1. **New operational burden** — Debezium / Kafka Connect clusters to run, monitor, upgrade. Not used anywhere else in this codebase today.
  2. **Schema drift is implicit** — oplog captures whole-document state at commit time. We want discrete event rows with fields like `event_type='workflow.execution.completed'`, `duration_ms`, `step_id`. CDC would give us full-doc changes and we'd have to reconstruct event semantics at the consumer. That reconstruction is fragile (which fields changed? which state transition? was it a cancel or a natural completion?).
  3. **Oplog retention coupling** — if the connector stalls, we lose data once oplog rolls.
  4. **PII control is weaker** — full-doc CDC captures every field; we'd need consumer-side redaction rather than registry-driven emission.
  5. **Restate + Mongo coupling** — Restate replays sometimes re-touch `workflow_executions`; CDC would emit spurious "change" events that are not true state transitions.
- **Effort**: M-L. Rejected — the operational/complexity cost of a new CDC stack is not justified when the existing eventstore pipeline already provides at-least-once delivery semantics.

### Option D — Scheduled Batch Export (hourly cron → CH)

- **Description**: A scheduled job reads terminal executions from Mongo and bulk-inserts into CH. Monitor tab reads from the most recent export.
- **Pros**: Simplest pipeline. No Kafka, no outbox.
- **Cons**:
  1. **Hourly (or longer) latency** — Monitor tab cannot show real-time state; breaks the 5-second SWR polling UX.
  2. **No audit event stream** — closes GAP-10 only partially; we lose per-step granularity because batch exports can only capture final state.
  3. **Not suitable for GDPR cascade** — no real-time deletion propagation.
  4. **Duplicate work on Mongo** — scheduled scans add load that the outbox approach avoids (outbox index is bounded by unpublished rows only).
- **Effort**: S. Rejected — fundamentally fails the freshness SLA and audit requirements.

### Recommendation: Option A (Transactional Outbox + Kafka + ClickHouse)

**Rationale**: Option A is the only approach that simultaneously satisfies at-least-once delivery (FR-2), per-step audit granularity (GAP-10), GDPR cascade (GAP-12 / FR-10), the 10-second freshness SLA, and maximum reuse of existing platform infrastructure. The cost is operational complexity (5 components in series), but every component has proven prior art in this codebase — `@abl/eventstore`, `TriggerScheduler`, `EventCascadeHook`, `platform_events` CH tables — so we are composing known-good pieces, not inventing new infrastructure.

The feature spec already committed to Option A in Phase 1; this HLD validates the decision against the alternatives and pins the concrete architectural shape.

---

## 3. Architecture

### 3.1 System Context Diagram

```
┌────────────────┐      ┌────────────────┐      ┌────────────────┐
│   Studio UI    │      │   Runtime /    │      │   Platform     │
│  Monitor + Inbox│      │ Studio BFF     │      │  Admin API     │
└────────┬───────┘      └────────┬───────┘      └────────┬───────┘
         │ HTTP                    │ HTTP                  │ HTTP
         │                         │                       │ (tenant delete)
         ▼                         ▼                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   workflow-engine (apps/workflow-engine)     runtime (apps/runtime)│
│  ┌──────────────────────────────────────┐   ┌───────────────────────┐│
│  │ /api/projects/:pid/workflows/.../    │   │ /api/projects/:pid/   ││
│  │   executions  — HybridExecutionReader │◄─►│   human-tasks — Hybrid││
│  └──────────┬───────────────┬───────────┘   │   HumanTaskReader     ││
│             │               │               └──────┬────────────────┘│
│  ┌──────────▼───┐  ┌────────▼───────┐              │                 │
│  │ ExecutionStore│  │workflow-events-│              │                 │
│  │ +Outbox writer│  │ consumer       │◄─────────────┼─ eventstore-   │
│  └──────┬────────┘  └────────┬───────┘              │  singleton      │
│         │ tx write            │ consume             │                 │
│         │                     │                     │                 │
│  ┌──────▼───────┐      ┌──────▼───────────┐         │                 │
│  │ Mongo        │      │ BufferedClickHouse│         │                 │
│  │ tx           │      │ Writer (existing)│         │                 │
│  └──────┬───────┘      └──────┬───────────┘         │                 │
│         │                     │                     │                 │
│  ┌──────▼──────────────┐      ▼                     │                 │
│  │ workflow-engine:    │   ClickHouse               │                 │
│  │ outbox-poller       │◄──┐                        │                 │
│  │ (BullMQ repeatable) │   │                        │                 │
│  └──────┬──────────────┘   │                        │                 │
│         │ publish           │                        │                 │
└─────────┼───────────────────┼────────────────────────┼─────────────────┘
          │                   │                        │
          ▼                   │                        │
    ┌────────────────┐        │                        │
    │ Kafka topics:  │        │                        │
    │ abl.workflow.  ├────────┘                        │
    │ execution      │                                 │
    │ abl.human.task │                                 │
    └────────────────┘                                 │
                                                       │
                                ┌──────────────────────▼──────────────┐
                                │ EventCascadeHook registry           │
                                │  (workflow hook added this feature) │
                                └─────────────────────────────────────┘
```

**Flow summary**: write-path is single-direction through outbox → Kafka → CH. Read-path is dual-source UNION (Mongo hot + CH cold). GDPR cascade is orthogonal — it invokes all registered hooks in parallel.

### 3.2 Component Diagram

| Component                                                                          | Owner                                    | Responsibility                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ExecutionStore` (existing, extended)                                              | `apps/workflow-engine`                   | Mongoose persistence for `workflow_executions`; **new**: in-tx outbox write via `WorkflowEventOutboxWriter`                                                                                                                                                                                                   |
| `HumanTaskStore` (existing or new, extended)                                       | `apps/workflow-engine`                   | Mongoose persistence for `human_tasks` (workflow mailbox); in-tx outbox write                                                                                                                                                                                                                                 |
| `WorkflowEventOutboxWriter`                                                        | `apps/workflow-engine`                   | **New.** Builds + Zod-validates + inserts `workflow_event_outbox` row from a domain update. Enriches each event payload with cumulative current-state fields from the domain doc (key for Q1).                                                                                                                |
| `OutboxPoller` (BullMQ repeatable job)                                             | `apps/workflow-engine`                   | **New.** Reads unpublished outbox rows in FIFO order, publishes to Kafka with **ACK-awaitable semantics** (see §3.6 — existing `KafkaEventQueue.enqueue()` is fire-and-forget/single-topic and is NOT suitable), marks `published_at` on ACK. Retries with backoff. BullMQ repeatable ⇒ single-active-leader. |
| `WorkflowEventsConsumer` (`apps/runtime/src/services/workflow-events-consumer.ts`) | `apps/runtime`                           | **New.** KafkaJS consumer group subscribed to both topics; writes rows through `BufferedClickHouseWriter`. Consumer offset commits only after `BufferedClickHouseWriter.flush()` ACKs. File path pinned flat (NOT under `event-bus/`) per HLD-log Q2 — supersedes feature-spec §10's PROVISIONAL path.        |
| `BufferedClickHouseWriter` (existing)                                              | `packages/database`                      | Batch (10K / 5s) writer to CH. Reused unchanged — `flush()` / `close()` / `getMetrics()` are sufficient.                                                                                                                                                                                                      |
| `HybridExecutionReader`                                                            | `apps/workflow-engine`                   | **New.** Injected service: takes authenticated user context, queries Mongo via `ExecutionStore`, queries CH via `ClickHouseQueryBuilder`, delegates merge/dedup to `dual-read-merger.ts`. Gated on `WORKFLOW_DUAL_READ_ENABLED`.                                                                              |
| `HybridHumanTaskReader`                                                            | `apps/runtime`                           | **New.** Mirror of above for human-task list/detail endpoints; applies `mailbox='workflow'` filter in CH leg and Mongo-only when `mailbox='agent'`.                                                                                                                                                           |
| `dual-read-merger.ts`                                                              | `apps/workflow-engine`                   | **New.** Pure function — merges Mongo + CH arrays with `_id` dedup (Mongo wins on overlap) and preserves ordering. Testable without any mocks.                                                                                                                                                                |
| `WorkflowEventCascadeHook`                                                         | `apps/runtime` (registered at bootstrap) | **New.** Implementation of extended `EventCascadeHook` interface — `deleteTenant` + new `deleteByExecutionIds`. Cascades to 3 Mongo collections + 4 CH tables.                                                                                                                                                |
| `EventRegistry` (existing, extended)                                               | `packages/eventstore`                    | Register workflow + human-task event Zod schemas at module-import time. Marks PII-bearing events with `containsPII: true`.                                                                                                                                                                                    |
| `EventRetentionService` (existing, extended)                                       | `packages/eventstore`                    | Register the 4 new CH tables with plan-tiered retention. No behavioral change to the service itself.                                                                                                                                                                                                          |
| `KafkaEventQueue` (existing)                                                       | `packages/eventstore`                    | Outbound producer for the two new topics. Reused; tenant-id partition key is already its default.                                                                                                                                                                                                             |
| Parity-check tool (`tools/test-infra/parity-check.ts`)                             | `tools/`                                 | **New.** CLI that compares Mongo vs CH row counts per `(tenant_id, projectId, workflow_id)` tuple. Doubles as the operational gate for Phase A → Phase B flag flip.                                                                                                                                           |

### 3.3 Write-Path Data Flow (Happy Path)

```
1. Request:  POST /api/projects/:pid/workflows/:wfId/executions/execute
2. Route handler validates, calls ExecutionStore.createExecution(payload, { session })
   NOTE: ExecutionStore TODAY does NOT accept a Mongo ClientSession. This must be
         added by the LLD — see §3.6 "Required Infrastructure Gaps".
3. Caller opens a Mongo session + runs withTransaction(async session => { ... }) wrapping
   BOTH the domain write and the outbox write:
      3a. ExecutionStore.insertOne(execDoc, { session }) — `workflow_executions`
      3b. WorkflowEventOutboxWriter.enqueue({
            event_id: uuidv7(),
            event_type: 'workflow.execution.started',
            event_version: '1.0.0',
            entity_kind: 'execution',
            entity_id: executionId,
            payload: buildOutboxPayload(executionDoc, 'started'),  -- carries started_at, trigger_type, workflow_version, status='running'
            created_at: now,
            published_at: null,
          }, { session })
      3c. OutboxModel.insertOne(outboxRow, { session }) — `workflow_event_outbox`
      3d. withTransaction commits — both rows land or neither does
4. Response returned to caller: 201 { executionId }

5. (async) OutboxPoller tick:
      5a. SELECT from workflow_event_outbox WHERE published_at IS NULL ORDER BY created_at LIMIT batch
      5b. For each row:
          - await kafkaProducer.send({ topic: entity_kind === 'execution' ? 'abl.workflow.execution' : 'abl.human.task',
                                       messages: [{ key: tenantId, value: serialize(event) }] })
            ** Uses an ACK-awaitable producer path (raw KafkaJS producer OR an extended `KafkaEventQueue.publishAndAck(topic, event)` method).
               See §3.6 — existing `KafkaEventQueue.enqueue(event): void` is single-topic + fire-and-forget and CANNOT support the mark-published guarantee. LLD picks the concrete option. **
          - On ACK: UPDATE workflow_event_outbox SET published_at=now WHERE event_id=? AND published_at IS NULL
          - On failure: INCREMENT attempts, set last_error, exponential backoff

6. (async) WorkflowEventsConsumer (runtime):
      6a. Kafka consumer reads batch
      6b. Zod-validate each message against EventRegistry
      6c. Map to CH row shape (one row per event)
      6d. BufferedClickHouseWriter.write(rows)
      6e. When writer's next flush() resolves, commit Kafka offset
      6f. CH's `workflow_executions_latest_mv` fires on the INSERT, writing one projection row per event into `workflow_executions_latest` (ReplacingMergeTree)
      6g. At background merge time, ReplacingMergeTree keeps the row with max `_version` per `(tenant_id, project_id, workflow_id, execution_id)`
```

### 3.4 Read-Path Data Flow (Dual-Read UNION)

```
1. Request:  GET /api/projects/:pid/workflows/:wfId/executions?limit=50&sort=startedAt:desc
2. Route handler calls HybridExecutionReader.list(ctx, filters)
   where ctx carries { tenantId, projectId, userId, userRole, scopes }
3. HybridExecutionReader:
      3a. (always) Mongo leg — ExecutionStore.list({ tenantId, projectId, workflowId, ...filters })
          · returns active + <48h completed runs
      3b. (if WORKFLOW_DUAL_READ_ENABLED)
          CH leg — ClickHouseQueryBuilder.workflowExecutionsLatest({
            tenantId, projectId, workflowId, ...filters,
            user_visibility: buildUserFilter(ctx)   -- same filter applied to Mongo
          })
          · returns only rows >48h OR !status in active_set
          · query uses FINAL modifier or argMax(... _version) for deterministic latest state
          · parameterized; no string interpolation
      3c. mergeAndDedup(mongoRows, chRows, { dedupKey: '_id', mongoWinsOnOverlap: true, ordering: filters.sort })
      3d. Apply pagination cursor (based on `startedAt` from the merged list)
4. Response: sanitized shape identical to Mongo-only path; optional `source` diagnostic field only in test mode
```

### 3.5 Sequence Diagram — Outbox Atomicity under Crash

```
Workflow-Engine                  Mongo                    Outbox Poller             Kafka
     │                            │                           │                       │
     │ createExecution()           │                           │                       │
     │ ── startSession() ─────────►│                           │                       │
     │ ── withTransaction(async =>)│                           │                       │
     │   ** requires session-aware │                           │                       │
     │      ExecutionStore API —   │                           │                       │
     │      see §3.6 gap **        │                           │                       │
     │        insert exec ────────►│                           │                       │
     │        insert outbox ──────►│                           │                       │
     │    )                        │                           │                       │
     │    ◄─── commitTransaction ──│                           │                       │
     │ ─ response: 201 ────────────                            │                       │
     │                             │                           │                       │
     │                             │ ◄── poll (every 100ms) ───│                       │
     │                             │ SELECT unpublished ───────│                       │
     │                             │ ───────────────────────── ►│                       │
     │                             │                           │ ─ await producer.send─►│
     │                             │                           │ ◄─ ACK ───────────────│
     │                             │ UPDATE published_at ◄─────│                       │
     │                             │                           │                       │
 CRASH SCENARIO A: crash between Mongo commit and poller tick  │                       │
     │ (no state loss — row is still unpublished)              │                       │
 CRASH SCENARIO B: crash between Kafka publish and mark-published
     │                             │ (row stays unpublished)   │                       │
     │                             │ next poller retries       │ ◄─ publish (same      │
     │                             │                           │     event_id) ────────►│
     │                             │                           │    CH dedups on       │
     │                             │                           │    event_id via       │
     │                             │                           │    ReplacingMergeTree │
```

### 3.6 Required Infrastructure Gaps (LLD must resolve)

Two pieces of existing infrastructure do not yet satisfy this feature's requirements. The HLD names them explicitly so the LLD cannot silently assume they exist:

**Gap 1 — `ExecutionStore` / `HumanTaskStore` session support**

The current `apps/workflow-engine/src/persistence/execution-store.ts` API (220 lines) is session-agnostic: `createExecution`, `updateStepStatus`, `updateExecutionStatus` all call Mongoose directly with no `session` parameter. FR-1 atomicity requires both the domain write and the outbox write to participate in the same Mongo `ClientSession`.

The LLD must choose one:

- **(a) Add an optional `session?: ClientSession` parameter** to every store method. Backward-compatible (old callers pass nothing), forward-compatible for the outbox caller.
- **(b) Keep store methods synchronous** and hoist the `withTransaction` wrapper into a caller-side orchestrator (e.g., `executionLifecycleService`) that opens the session, calls `store.x({ session })`, and calls `outboxWriter.enqueue({ session })`.

Recommendation: option (a). Minimum surface-area change; matches Mongoose's documented idiom. The LLD pins the exact method-signature updates and the set of store methods that must accept `session`.

**Gap 2 — Topic-routed, ACK-awaitable Kafka publish**

`packages/eventstore/src/queues/kafka-queue.ts:50` binds a single topic at construction. `enqueue(event)` at line 102 returns `void` and handles errors via `.then/.catch` (fire-and-forget). The outbox poller needs:

1. Two distinct topics (`abl.workflow.execution`, `abl.human.task`) routed per row.
2. ACK-awaitable semantics — `await publish(...)` so we only mark the outbox row `published_at` after Kafka confirms.
3. `key = tenantId` partition-key (matches the existing `KafkaEventQueue` default at `kafka-queue.ts:109-112`).

The LLD must choose one:

- **(a) Raw KafkaJS producer** in the outbox poller — opens its own `Producer`, calls `await producer.send({ topic, messages, acks: -1 })`. Most direct; bypasses `KafkaEventQueue` entirely for this code path.
- **(b) Extend `KafkaEventQueue`** with a new `publishAndAck(topic: string, event: unknown): Promise<void>` method. Keeps the poller working through the shared queue abstraction.
- **(c) Instantiate two `KafkaEventQueue` instances** (one per topic) — only helps with topic routing; does NOT solve ACK-awaitability.

Recommendation: option (b). Preserves the existing queue abstraction's observability (connection health, pendingMessages metric) and adds an ACK-awaitable path without duplicating KafkaJS setup. The LLD pins the exact method signature and retry/timeout semantics.

**These are the two highest-risk LLD design tasks.** Both are called out in §9 Open Questions.

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | Every store carries `tenant_id`: outbox row, Kafka message (as partition key), CH columns (leading sort-key position), MV projection, API query filter. `HybridExecutionReader` and `HybridHumanTaskReader` pass `tenantId` into both legs. Cross-tenant read returns 404 (per CLAUDE.md Core Invariants #1). CH queries use `(tenant_id, project_id, ...)` sort-key so per-tenant reads hit the index directly.                                                                                                                                                                                                                                                                                                                                          |
| 2   | **Data Access Pattern** | Mongo: `ExecutionStore` / `HumanTaskStore` thin Mongoose wrappers. CH: parameterized client via `@abl/database` ClickHouse factory — no string interpolation. `HybridExecutionReader` / `HybridHumanTaskReader` are the UNION read contract. Write-path never reads CH. Read-path never writes to CH (CH writes come only from the consumer). The route handler only sees the hybrid reader, never either leg directly.                                                                                                                                                                                                                                                                                                                                   |
| 3   | **API Contract**        | Zero new endpoints; extending existing `GET /executions`, `GET /executions/:id`, `GET /executions/:id/steps`, `GET /human-tasks`, `GET /human-tasks/:id`. Response shape is unchanged — same fields, same sort order, same pagination cursor format. Only a test-only `source` diagnostic field is added, and it is stripped in production. Error envelope matches the structured `{ success: false, error: { code, message } }` contract. Versioning handled at the event layer via `event_version` semver, not at the HTTP layer.                                                                                                                                                                                                                       |
| 4   | **Security Surface**    | **Auth**: `createUnifiedAuthMiddleware` / `requireProjectPermission('workflow:read' \| 'human_task:read')` unchanged. **Input validation**: Zod at route boundary; `.strict()` on new body/query schemas per Studio Route Handler Gotcha rule. **SSRF**: N/A (no external HTTP calls from new code path). **Encryption**: TLS in transit to Kafka and CH (existing cluster config); at-rest per storage engine. **Secret hygiene**: event payloads must not carry credentials — existing workflow step sanitization applies, and the outbox writer runs the same sanitizer before serializing. **Sanitizer**: error responses use the existing user-facing sanitizer (CLAUDE.md User-Facing Runtime Error Sanitization) — no tenantId leak in 404 bodies. |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | Write-path errors: Mongo transaction abort → whole createExecution call returns 5xx; outbox row never landed ⇒ no downstream effect. Read-path errors: CH unavailable with dual-read ON → fall back to Mongo-only with a structured warning log (no user-facing error); historical runs unavailable message surfaces only if the CH leg was the sole source (>48h query). Consumer errors: Kafka deserialization / Zod failure → dead-letter topic (existing pattern in `kafka-subscriber.ts`) + metric. All structured errors follow `{ success: false, error: { code, message } }`. Error code taxonomy reuses existing workflow errors; no new codes required except `WORKFLOW_HISTORICAL_UNAVAILABLE` for the dual-read fallback path.                                                                                                                                                                                                    |
| 6   | **Failure Modes** | See feature spec §12 Reliability table. Key cases: **Kafka down** — outbox accumulates; Mongo writes & reads continue; poller drains on recovery. **CH down** — Kafka retains 7 days; consumer offset un-committed until write ACKs, so no loss on recovery. **Mongo tx abort** — neither domain row nor outbox row persists (INT-01). **Redis down** — poller pauses; BullMQ reconnects. **Outbox poller leader failover** — BullMQ repeatable guarantees at-most-one active worker; during failover there is a seconds-long window of no poller, acceptable per GAP-003. **Circuit breaker**: no new circuit breakers introduced — the existing `BufferedClickHouseWriter.getMetrics()` surfaces `consecutiveFailures` for ops dashboards.                                                                                                                                                                                                  |
| 7   | **Idempotency**   | Every event carries a `event_id` (UUIDv7 at outbox-write time). Kafka publish uses `event_id` as the de-dupe anchor at CH: `ReplacingMergeTree(_version)` collapses on `(tenant_id, project_id, entity_id)` at merge time. Consumer writes append-only to `*_events` tables; duplicate arrivals produce duplicate raw rows that collapse post-merge. `OPTIMIZE TABLE ... FINAL` is never run in production; `SELECT ... FINAL` or `argMax(... _version)` is used at query time for deterministic latest state. Outbox `mark-published` uses conditional UPDATE (`WHERE published_at IS NULL`) to be safe against poller-level double-process. **Note**: atomicity (FR-1) depends on the session-passing gap in §3.6 Gap 1 being resolved by the LLD.                                                                                                                                                                                          |
| 8   | **Observability** | New metrics (see feature spec §12 Observability): `workflow_outbox_unpublished_rows` gauge, `workflow_outbox_publish_latency_ms` histogram, `workflow_outbox_publish_attempts` counter, `workflow_kafka_consumer_lag_ms` per-topic histogram, `workflow_ch_ingest_latency_ms` (outbox commit → MV row appears), `workflow_dual_read_path_distribution` labeled counter, `workflow_ttl_deleted_documents` counter. **Traces**: every state transition emits a `TraceEvent` via existing `TraceStore` — unchanged. **Logs**: use `createLogger('workflow-outbox' \| 'workflow-consumer' \| 'workflow-dual-read')`; publish failures log error level with `{ event_id, attempts, last_error }`. **Dashboards**: extend existing eventstore Grafana panels with the 4 new CH tables; add a Mongo↔CH parity panel (used as Phase-A→Phase-B gate). **Alerts**: backlog > 10K rows for 5 min; consumer lag p95 > 60s for 5 min; TTL flatline for 1h. |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | **Write overhead**: outbox insert ~1–3 ms per state transition; acceptable at projected 60 events/s average. **Kafka**: 5M events/day = ~60 events/s avg, bursts to ~700 events/s; 3 partitions sufficient. **CH ingest lag**: Kafka linger (500 ms) + `BufferedClickHouseWriter` 5s flush + merge ≈ p95 ≤ **10 s** end-to-end. **CH read latency**: `workflow_executions_latest` filtered by `(tenant_id, project_id, workflow_id)` hits sort-key index directly; target p95 ≤ **200 ms** current quarter, ≤ **500 ms** multi-year aggregates. **Mongo working set**: bounded by `concurrent_in_flight × 100 KB + 48h × 500K × 100 KB ÷ 30 ≈ 1.5–2.4 GB steady-state per tenant at peak`. **Outbox size**: ~11 GB peak at 500K runs/day × 10 events × 300 bytes × 7d. **Payload size validation**: outbox writer enforces a 256 KB per-event cap; exceeding rows are sanitized and `payload_truncated: true` is stamped in the CH row.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 10  | **Migration Path**     | 2-phase flag-gated rollout (Q15 from feature spec = Option B). **Phase A**: all code + CH tables + Kafka topics ship behind flags defaulting OFF. Flags flip progressively: `WORKFLOW_OUTBOX_ENABLED` → observe outbox lag → `WORKFLOW_CH_SINK_ENABLED` → observe ingest lag + parity → `WORKFLOW_DUAL_READ_ENABLED` → observe API latency distribution. Parity-check CLI runs as a scheduled staging job and must report drift < 0.1% over a 48h window before the next flip. **Phase B**: `WORKFLOW_MONGO_TTL_ENABLED=true` creates TTL indexes (initially `expireAfterSeconds = 14d` conservative, narrowed to `48h` after a week of observation). **No production data backfill** — feature is BETA and 48h dual-read UNION gracefully covers the gap (Q14 oracle decision). An optional backfill CLI is scoped as a follow-up ticket.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 11  | **Rollback Plan**      | Every flag can flip off independently without a redeploy. **Before TTL**: zero destructive changes — flipping all four flags off returns the system to the pre-feature state. **After TTL** (Phase B): dropping the TTL index stops new deletions within ~60s. **Primary safety mechanism** is the TTL `partialFilterExpression: { completedAt: { $type: 'date' } }` — in-flight runs have `completedAt = null` (field absent or null), so they are **excluded from the TTL index by design** and cannot be deleted. The LLD must add a **startup validation check** that fails loudly (CRITICAL log + bootstrap abort) if the TTL index does not include this partial-filter clause; accidental deletion of in-flight runs via a misconfigured index is NOT recoverable from CH (CH has only event snapshots, not the nested `nodeExecutions[]` + `context` + Restate-correlation shape Mongo carries, and Restate journal replay would fail on missing domain doc). Terminal (completed) runs deleted by correctly-configured TTL ARE recoverable from CH by querying `workflow_execution_events` + `workflow_executions_latest` and re-materializing via a backfill script — this is the Phase B rollback path. Progressive enablement (14d → 48h) limits blast radius. **CH schema rollback**: append-only CH tables don't require online mutation on drop; if DDL needs to change post-release, we issue `ALTER TABLE ADD COLUMN` (backwards compatible) or ship a new table + MV and drop the old one during a maintenance window. **Tenant-scoped rollback**: `WORKFLOW_DUAL_READ_ENABLED` can be cohort-gated per-tenant via the existing feature-flag loader, enabling canary tenants. |
| 12  | **Test Strategy**      | Per the test spec: 6 E2E scenarios (E2E-01..06), 8 integration scenarios (INT-01..08), 6 unit scenarios (UT-01..06), 1 load scenario (LOAD-01 1M runs / 4 h), 1 CI smoke (LOAD-02 100 runs). **Integration boundaries** are real Mongo (MongoMemoryReplSet for tx), real Redis, real Kafka, real CH — no mocks of `@agent-platform/*` / `@abl/*`. **E2E tier** interacts only via HTTP API; data assertions against CH go through the test-diagnostic endpoints (`/api/admin/test/...` gated on `NODE_ENV=test`), never direct DB imports. **Coverage matrix**: every FR maps to at least one integration or E2E scenario (see test spec §4). **Parity test**: the parity-check CLI ships as a test asset AND operational tool — asserts zero drift under load before Phase B flag flip.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

---

## 5. Data Model

### 5.1 New Collections

**Mongo — `workflow_event_outbox`** (new collection; Mongoose model at `packages/database/src/models/workflow-event-outbox.model.ts`)

```typescript
interface WorkflowEventOutboxDoc {
  _id: string; // UUIDv7
  tenantId: string;
  projectId: string;
  event_id: string; // UUIDv7, unique — Kafka key + CH dedup anchor
  event_type: string; // e.g. 'workflow.execution.started', 'workflow.human_task.claimed'
  event_version: string; // semver, e.g. '1.0.0'
  entity_kind: 'execution' | 'human_task';
  entity_id: string; // executionId or taskId
  payload: Record<string, unknown>; // Zod-validated at write time
  created_at: Date;
  published_at: Date | null; // null until poller ACKs Kafka publish
  attempts: number; // default 0, increments on publish failure
  last_error: string | null;
}
```

Indexes (created idempotently on startup via `ensureIndex`):

- `{ tenantId: 1, projectId: 1 }` — tenant-scoped scans
- `{ tenantId: 1, entity_kind: 1, entity_id: 1 }` — GDPR cascade by executionId/taskId
- `{ event_id: 1 }` — unique
- `{ published_at: 1 }` partial TTL — `partialFilterExpression: { published_at: { $type: 'date' } }`, `expireAfterSeconds: 7 * 86400`. Single index: the partial filter excludes unpublished rows, which both keeps the index sparse (poller scans `{ published_at: null }` efficiently) AND prevents TTL from deleting them.

### 5.2 Modified Collections

**Mongo — `workflow_executions`** — schema unchanged. New TTL index (Phase B flag):

- `{ completedAt: 1 }` with `expireAfterSeconds: 48 * 3600`, `partialFilterExpression: { completedAt: { $type: 'date' } }`.
  The partial filter excludes in-flight runs (no `completedAt` yet); they survive the TTL forever.

**Mongo — `human_tasks`** — schema unchanged. New TTL index (Phase B flag, workflow mailbox only):

- `{ updatedAt: 1 }` with `expireAfterSeconds: 48 * 3600`, `partialFilterExpression: { mailbox: 'workflow', status: { $in: ['completed', 'expired', 'cancelled'] } }`.
  The partial filter excludes `mailbox='agent'` tasks (out of scope) and active-status tasks.

### 5.3 New ClickHouse Tables

Four tables: two append-only event streams, two `ReplacingMergeTree`-backed projections. Codec conventions match `platform_events` (`LowCardinality` for enums, `ZSTD(1)` for IDs, `ZSTD(3)` for JSON blobs, `DoubleDelta/LZ4` for timestamps, `T64/LZ4` for small ints).

**Table: `workflow_execution_events`** (append-only stream)

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
  status           LowCardinality(String),                    -- current state carried in every event
  started_at       DateTime64(3, 'UTC')   CODEC(DoubleDelta, LZ4),
  completed_at     Nullable(DateTime64(3, 'UTC')) CODEC(DoubleDelta, LZ4),
  duration_ms      UInt32                 CODEC(T64, LZ4),
  step_id          String                 CODEC(ZSTD(1)),
  step_name        String                 CODEC(ZSTD(1)),
  step_type        LowCardinality(String),
  trigger_type     LowCardinality(String),
  error_code       LowCardinality(String),
  error_message    String                 CODEC(ZSTD(3)),
  payload          String                 CODEC(ZSTD(3)),     -- JSON body
  payload_truncated UInt8  DEFAULT 0,
  occurred_at      DateTime64(3, 'UTC')   CODEC(DoubleDelta, LZ4),
  ingested_at      DateTime64(3, 'UTC')   CODEC(DoubleDelta, LZ4)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (tenant_id, project_id, execution_id, occurred_at)
TTL occurred_at + INTERVAL <plan-based>
SETTINGS index_granularity = 8192;
```

**Table: `human_task_events`** — identical structure, keyed on `task_id` with the additional `mailbox`, `assigned_to Array(LowCardinality(String))`, `claimed_by`, `responded_by`, `decision`, `due_at`, `sla_breached_at` columns. See feature spec §9 for full DDL.

**Projection: `workflow_executions_latest`** (ReplacingMergeTree target)

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
```

**Projection MV (corrected per Q1 decision — per-row projection, NO aggregation):**

```sql
CREATE MATERIALIZED VIEW workflow_executions_latest_mv TO workflow_executions_latest AS
SELECT
  execution_id,
  tenant_id,
  project_id,
  workflow_id,
  workflow_version,
  status,
  trigger_type,
  started_at,                                               -- carried in every event payload
  completed_at,                                             -- NULL until terminal event; then carried
  duration_ms,                                              -- 0 until terminal event; then carried
  occurred_at AS last_event_at,
  toUnixTimestamp64Milli(occurred_at) AS _version
FROM workflow_execution_events;
```

**Why this works**: every outbox event carries the cumulative state. `WorkflowEventOutboxWriter.buildOutboxPayload()` copies `started_at`, `completed_at`, `duration_ms`, `status`, `workflow_version`, `trigger_type` into each event's payload, snapshotting the Mongo domain doc at emit time. The MV projects each event row 1:1 into the `ReplacingMergeTree` target. On merge, `ReplacingMergeTree(_version)` keeps the row with the highest `_version`. Reads use `argMax(<col>, _version) GROUP BY tenant_id, project_id, execution_id` or `SELECT ... FINAL` for deterministic latest state. This mirrors `platform_events_by_session_mv` (at `packages/eventstore/src/stores/clickhouse/platform-events-table.ts:127-156`) and every projection in `packages/pipeline-engine`.

**Table: `human_task_events`** — append-only stream. Columns inherited from feature spec §9 with HLD additions (see §5.5 errata): `task_id`, `tenant_id`, `project_id`, `execution_id`, `workflow_id`, `step_id`, `task_type`, `mailbox` (always `'workflow'`), `status`, `priority`, `event_type`, `assigned_to Array(LowCardinality(String))`, `claimed_by`, `responded_by`, `decision`, `due_at Nullable(DateTime64)`, `sla_breached_at Nullable(DateTime64)`, `payload String CODEC(ZSTD(3))`, **`payload_truncated UInt8 DEFAULT 0`** (HLD errata E-2), **`created_at DateTime64(3, 'UTC') CODEC(DoubleDelta, LZ4)`** (HLD errata E-4 — carried cumulative state; distinct from `occurred_at`), `occurred_at`, `ingested_at`. ENGINE / PARTITION BY / ORDER BY / TTL unchanged from feature spec (ENGINE=MergeTree; PARTITION BY `toYYYYMM(occurred_at)`; ORDER BY `(tenant_id, project_id, task_id, occurred_at)`; plan-based TTL). Codecs match `platform_events` conventions.

**Projection: `human_tasks_latest`** (ReplacingMergeTree target) — unchanged from feature spec §9 DDL structure: same columns as the target table including `assigned_to`, `claimed_by`, `responded_by`, `decision`, `due_at`, `sla_breached_at`, `created_at`, `last_event_at`, `_version`.

**Projection MV for `human_tasks_latest` (corrected per Q1 decision — per-row projection, NO aggregation):**

```sql
CREATE MATERIALIZED VIEW human_tasks_latest_mv TO human_tasks_latest AS
SELECT
  task_id,
  tenant_id,
  project_id,
  execution_id,
  workflow_id,
  task_type,
  status,
  priority,
  assigned_to,
  claimed_by,
  responded_by,
  decision,
  due_at,
  sla_breached_at,
  created_at,                                               -- carried cumulative state
  occurred_at AS last_event_at,
  toUnixTimestamp64Milli(occurred_at) AS _version
FROM human_task_events
WHERE mailbox = 'workflow';                                 -- scope enforced at MV (agent mailbox out of scope)
```

**Why this works**: every outbox event for a human task carries the cumulative state (status, priority, current `assigned_to` array, claimed_by, responded_by, decision). `WorkflowEventOutboxWriter.buildOutboxPayload()` snapshots the Mongo task doc at emit time. The MV projects each event 1:1 into the target; `ReplacingMergeTree(_version)` collapses on `(tenant_id, project_id, task_id)` at merge time. Reads use `SELECT ... FINAL` or `argMax(<col>, _version) GROUP BY` for deterministic latest state. `WHERE mailbox = 'workflow'` at MV guarantees agent-mailbox events never land in the workflow projection even if the same topic/table ever co-hosts them (belt-and-suspenders isolation with the planned topic separation). This supersedes the feature spec §9 `human_tasks_latest_mv` DDL which used `argMax`/`min`/`max` + `GROUP BY` — an aggregation pattern that does not accumulate across insertion blocks when targeting `ReplacingMergeTree`, per the FR-5 HLD-validation note in the feature spec itself.

### 5.5 Feature-Spec Errata (deltas this HLD introduces)

This HLD supersedes or amends three points from the feature spec. The `/post-impl-sync` phase MUST propagate these back into the feature spec after implementation. They are consolidated here so nothing is lost between phases:

| #   | Feature-spec reference                                                 | HLD delta                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E-1 | FR-2 (§4, line ~76): "keyed by entity ID"                              | **Corrected to `key = tenantId`** (matches existing `KafkaEventQueue` default at `packages/eventstore/src/queues/kafka-queue.ts:109-112`; provides per-tenant ordering required by FR-3). The feature spec FR-2 wording must change to: "publishes each row to the correct Kafka topic with `tenantId` as the message key for per-tenant ordered delivery, in alignment with FR-3."                                                                                                                                                                                                  |
| E-2 | §9 `workflow_execution_events` DDL                                     | **Adds one column**: `payload_truncated UInt8 DEFAULT 0`. Set to `1` when the outbox writer enforces the 256 KB per-event payload cap and must sanitize/truncate. Same column must be added to `human_task_events`. Feature spec DDL should be updated to include it.                                                                                                                                                                                                                                                                                                                |
| E-3 | §10 Jobs/Workers table, `workflow-events-consumer.ts` provisional path | **Resolved to `apps/runtime/src/services/workflow-events-consumer.ts`** (flat, NOT under `event-bus/`). `apps/runtime/src/services/event-bus/` is a Kafka producer bus — the workflow consumer is an inbound sink, architecturally distinct. Feature spec should drop the PROVISIONAL flag and pin this path.                                                                                                                                                                                                                                                                        |
| E-4 | §9 `workflow_execution_events` DDL                                     | **Adds two columns** to carry cumulative state required by the per-row MV pattern (Q1 decision): `started_at DateTime64(3, 'UTC') CODEC(DoubleDelta, LZ4)` and `completed_at Nullable(DateTime64(3, 'UTC')) CODEC(DoubleDelta, LZ4)`. Without these columns, the MV cannot project `started_at`/`completed_at` into `workflow_executions_latest`. `human_task_events` adds `created_at DateTime64(3, 'UTC') CODEC(DoubleDelta, LZ4)` for the same reason (distinct from `occurred_at` which is the per-event timestamp). Feature spec DDLs must be updated to include these columns. |
| E-5 | §9 `human_tasks_latest_mv` DDL                                         | **Corrected MV SELECT** — replaces the `argMax/min/max + GROUP BY` aggregation pattern with a per-row projection matching `workflow_executions_latest_mv` (Q1 decision; pinned in HLD §5.3). The feature spec's own FR-5 already flagged the aggregation pattern as HLD-validation-required; this errata is the resolution. Feature spec should replace the §9 `human_tasks_latest_mv` DDL with the HLD §5.3 corrected version.                                                                                                                                                      |

### 5.4 Key Relationships

- `workflow_execution_events.execution_id` ↔ `workflow_executions._id` (Mongo) ↔ `workflow_executions_latest.execution_id` (CH) — all UUIDv7
- `human_task_events.task_id` ↔ `human_tasks._id` ↔ `human_tasks_latest.task_id`
- `human_task_events.execution_id` ↔ `workflow_execution_events.execution_id` — cross-entity join key for trigger → execution → human-task chains (E2E-06 validates)
- `workflow_event_outbox.event_id` ↔ Kafka message key (dedup anchor) ↔ CH `event_id` column
- All entities share `{ tenant_id, project_id }` for isolation + CH sort-key alignment

---

## 6. API Design

### 6.1 Existing Endpoints — Extended

No new endpoints. The following existing endpoints gain the UNION read behavior behind `WORKFLOW_DUAL_READ_ENABLED`:

| Method | Path                                                                            | Purpose              | Behavior change                                                                                      | Auth                                  |
| ------ | ------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------- |
| GET    | `/api/projects/:projectId/workflows/:workflowId/executions`                     | List executions      | UNION Mongo + CH behind flag; dedup by `_id`; Mongo wins on overlap; ordering + pagination unchanged | `workflow:read`                       |
| GET    | `/api/projects/:projectId/workflows/:workflowId/executions/:executionId`        | Execution detail     | Mongo-primary + CH-fallback when not in Mongo and flag ON                                            | `workflow:read`                       |
| GET    | `/api/projects/:projectId/workflows/:workflowId/executions/:executionId/steps`  | List execution steps | Mongo-primary + CH-fallback                                                                          | `workflow:read`                       |
| POST   | `/api/projects/:projectId/workflows/:workflowId/executions/:executionId/cancel` | Cancel execution     | Unchanged write path; emits cancellation event via outbox                                            | `workflow:cancel` or `workflow:write` |
| GET    | `/api/projects/:projectId/human-tasks`                                          | List human tasks     | UNION for `mailbox=workflow`; Mongo-only for `mailbox=agent`                                         | `human_task:read`                     |
| GET    | `/api/projects/:projectId/human-tasks/:taskId`                                  | Task detail          | Mongo-primary + CH-fallback for workflow mailbox                                                     | `human_task:read`                     |

### 6.2 Test-Diagnostic Endpoints (NEW, `NODE_ENV=test` only)

Registered conditionally at app bootstrap; never loaded in production. Full auth chain enforced (no bypass).

| Method | Path                                            | Purpose                                                                                                                      |
| ------ | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/admin/test/outbox`                        | Raw outbox rows for a tenant / project                                                                                       |
| GET    | `/api/admin/test/ch/workflow_execution_events`  | Passthrough CH query with safe filter params                                                                                 |
| GET    | `/api/admin/test/ch/workflow_executions_latest` | MV projection row                                                                                                            |
| GET    | `/api/admin/test/ch/human_task_events`          | Human-task event rows                                                                                                        |
| GET    | `/api/admin/test/ch/human_tasks_latest`         | Human-task projection row                                                                                                    |
| POST   | `/api/admin/test/mongo/ttl-sweep`               | Force TTL by running `deleteMany` with the same filter as the TTL index (deterministic, mirrors production delete semantics) |
| POST   | `/api/admin/test/seed/executions`               | Seed an execution through the real store layer with `completedAt` / `startedAt` overrides                                    |
| POST   | `/api/admin/test/seed/human-tasks`              | Seed a human-task through the real store layer with status + timestamp overrides                                             |

**Registration pattern** (LLD pins the exact wire-up):

```typescript
// apps/workflow-engine/src/server.ts (and apps/runtime/src/server.ts)
if (process.env.NODE_ENV === 'test') {
  const { testDiagnosticRouter } = await import('./routes/test-diagnostic.js');
  app.use('/api/admin/test', testDiagnosticRouter);
}
```

### 6.3 Error Responses

No new error codes at HTTP layer. CH-fallback failures use:

- `WORKFLOW_HISTORICAL_UNAVAILABLE` — returned with HTTP 503 when the user specifically requests historical data (>48h) and CH is unavailable. Mongo-only responses simply omit the historical rows.
- All other errors reuse existing workflow + human-task error codes. Response shape: `{ success: false, error: { code, message } }` per CLAUDE.md.

---

## 7. Cross-Cutting Concerns

- **Audit Logging**: closing GAP-10 — every workflow + workflow-sourced human-task state transition is written to `workflow_execution_events` / `human_task_events` with plan-tiered retention. The audit surface is the CH tables themselves; no separate audit log collection is added.
- **Rate Limiting**: no changes. Existing per-tenant rate limits on `/api/projects/:pid/workflows/:wfId/executions/execute` unaffected.
- **Caching**: `EventQueryService` (eventstore) caches query results with a 60s TTL keyed on tenantId. For workflow analytics queries (future dashboards), this cache will be reused. `HybridExecutionReader` does NOT cache — the Mongo leg is always fresh, and CH reads over the sort-key are fast enough to not need it at v1.
- **Encryption**: TLS for all Kafka + CH connections (existing cluster-wide config). MongoDB at-rest encryption per cluster setup. No new secrets are introduced.
- **GDPR cascade**: `WorkflowEventCascadeHook` registered at `apps/runtime/src/services/eventstore-singleton.ts` bootstrap. Implements extended `EventCascadeHook` interface:
  - `deleteTenant(tenantId)` — Mongo `deleteMany({ tenantId })` on `workflow_executions`, `workflow_event_outbox`, and `human_tasks WHERE mailbox='workflow'`; CH `ALTER TABLE ... DELETE WHERE tenant_id=?` on all 4 tables; polls `system.mutations` until complete.
  - `deleteByExecutionIds(tenantId, executionIds[])` — same cascade scoped by `executionId`. Backward-compatible default (no-op) for existing hooks that don't override.
- **PII scrubbing**: events with user-provided content (`workflow.execution.started.trigger_payload`, `workflow.execution.completed.output`, `workflow.human_task.created.payload`, `workflow.human_task.responded.response`) register with `containsPII: true` in `EventRegistry`. `EventRetentionService.scrubPII` runs on the daily retention tick, replacing `payload` with `'{"anonymized":true}'` for rows older than PII cutoff but within total retention. Actor IDs (`assigned_to[]`, `claimed_by`, `responded_by`) are subject to actor-level anonymization via the existing `anonymizeActor` path.

---

## 8. Dependencies

### 8.1 Upstream (this feature depends on)

| Dependency                                                                                                  | Type                                        | Risk                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@abl/eventstore` (`KafkaEventQueue`, `BufferedClickHouseWriter`, `EventRegistry`, `EventRetentionService`) | reuse existing                              | Low — STABLE, proven at scale.                                                                                                                                      |
| `@agent-platform/database` Mongoose models + `BufferedClickHouseWriter`                                     | reuse existing                              | Low — STABLE.                                                                                                                                                       |
| `@agent-platform/database/cascade/event-cascade-hooks`                                                      | **extends interface**                       | Medium — adding `deleteByExecutionIds` requires backward-compat defaults in all existing implementations. Ship as its own commit before any workflow-specific code. |
| BullMQ + Redis                                                                                              | reuse existing pattern (`TriggerScheduler`) | Low — established pattern.                                                                                                                                          |
| Kafka + ClickHouse infra                                                                                    | existing clusters                           | Low — steady-state Kafka capacity well above projected throughput (60 events/s avg).                                                                                |
| Studio UI (`UnifiedInboxPage.tsx`, `useHumanTasks`)                                                         | existing, modified                          | Low — single UX toggle.                                                                                                                                             |
| `abl-platform-deploy` / `abl-platform-infra` repos                                                          | coordination                                | Low — Kafka topic creation + CH DDL rollout must happen in these repos before workflow-engine flips its flag. Non-blocking but requires cross-repo sequencing.      |

### 8.2 Downstream (depends on this feature)

| Consumer                                                 | Impact                                                                                                               |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Studio Monitor tab (`WorkflowMonitorTab.tsx`)            | None directly — the API contract is unchanged. Users see >48h runs once Phase A is enabled; no code change required. |
| Studio Unified Inbox (`UnifiedInboxPage.tsx`)            | Gains default status filter + toggle (FR-9). Independently deployable per feature-spec scope note.                   |
| Future analytics dashboards                              | Unlocks CH aggregation surface (p95 duration, success-rate trend, step-type heatmap). Not in v1 scope.               |
| Audit-logging feature (`docs/features/audit-logging.md`) | Workflow events augment the audit surface. Closes GAP-10.                                                            |
| Agent-escalation human tasks (Memory & Sessions)         | Parallel track — future ticket will extend tiering to `mailbox='agent'`. This feature sets the pattern.              |

---

## 9. Open Questions & Decisions Needed

### 9.1 Already Pinned by this HLD (no further decision required)

- **MV architectural shape** — per-row projection into plain `ReplacingMergeTree(_version)`; NO aggregation in MV SELECT. Column list, nullability (`completed_at` NULL pre-terminal, non-NULL at terminal), and `_version = toUnixTimestamp64Milli(occurred_at)` are pinned in §5.3.
- **Consumer file path** — `apps/runtime/src/services/workflow-events-consumer.ts` (flat, per errata E-3).
- **Kafka partition key** — `tenantId` (per errata E-1).
- **MongoMemoryReplSet adoption** — test helpers switch from `MongoMemoryServer` to `MongoMemoryReplSet` (same package) for INT-01 tx support.
- **Test-diagnostic endpoints** — gated on `NODE_ENV=test` via dynamic `import()`, same auth chain, sanitized bodies.
- **TTL safety mechanism** — the `partialFilterExpression: { completedAt: { $type: 'date' } }` on `workflow_executions` IS the primary safety. LLD must add a startup validation that aborts if the filter is missing (§4 concern #11).
- **Backfill** — explicitly NOT in v1 scope; optional follow-up ticket only.

### 9.2 Carried forward into LLD / implementation

1. **§3.6 Gap 1 — `ExecutionStore` / `HumanTaskStore` session support**. LLD must pin whether to (a) add `session?: ClientSession` to every store method (recommended) or (b) hoist `withTransaction` into a new lifecycle orchestrator. This is the highest-risk LLD design task.
2. **§3.6 Gap 2 — Topic-routed, ACK-awaitable Kafka publish**. LLD must pin whether to (a) use raw KafkaJS producer in the outbox poller, (b) add `KafkaEventQueue.publishAndAck(topic, event): Promise<void>` (recommended), or (c) instantiate two `KafkaEventQueue` instances. Option (c) is a strawman — it does not solve ACK-awaitability.
3. **Outbox payload enrichment helper** — `WorkflowEventOutboxWriter.buildOutboxPayload(executionDoc, event_type)` signature and the exact per-`event_type` field-copy list (e.g., `workflow.execution.started` copies `started_at`, `trigger_type`, `workflow_version`, `status='running'`; terminal events also copy `completed_at`, `duration_ms`, `error_code`, `error_message`).
4. **Test-diagnostic registration** — exact `server.ts` wire-up for `NODE_ENV=test` guarded dynamic import for both `apps/workflow-engine` and `apps/runtime`.
5. **BullMQ queue naming** — align `outbox-poller` queue + job names with existing `trigger-scheduler:*` convention.
6. **Parity-check drift threshold + counting method** — this HLD proposes "drift < 0.1% over 48h window" as the Phase A → Phase B gate. LLD pins the exact query, tolerance, and observation duration.
7. **Phase A flag-flip sequencing in prod** — exact order, per-flag observation duration, alert-gate criteria. LLD produces a detailed rollout runbook.
8. **Agent-escalation extension** (parallel ticket, different team) — when Memory & Sessions adopts this pattern for `mailbox='agent'`, shared topic vs new topic is their call. Flagged as parent-feature Open Question.
9. **PII sentinel constant export** — test-spec OQ-8; LLD decides whether to export from `@agent-platform/eventstore` publicly or keep internal. Low-priority.
10. **Inbox directory `agents.md`** — test-spec OQ-9; whether `apps/studio/e2e/inbox/` gets its own `agents.md` or is consolidated under `apps/studio/e2e/agents.md`. LLD / Studio conventions.

---

## 10. References

### Primary artifacts

- Feature spec: [`../features/sub-features/workflow-execution-event-sourcing.md`](../features/sub-features/workflow-execution-event-sourcing.md)
- Test spec: [`../testing/sub-features/workflow-execution-event-sourcing.md`](../testing/sub-features/workflow-execution-event-sourcing.md)
- Feature-spec log: [`../sdlc-logs/workflow-execution-event-sourcing/feature-spec.log.md`](../sdlc-logs/workflow-execution-event-sourcing/feature-spec.log.md)
- Test-spec log: [`../sdlc-logs/workflow-execution-event-sourcing/test-spec.log.md`](../sdlc-logs/workflow-execution-event-sourcing/test-spec.log.md)
- HLD log: [`../sdlc-logs/workflow-execution-event-sourcing/hld.log.md`](../sdlc-logs/workflow-execution-event-sourcing/hld.log.md)

### Pattern references

- [`eventstore.hld.md`](./eventstore.hld.md) — platform event-sourcing architecture (STABLE)
- `packages/eventstore/src/stores/clickhouse/platform-events-table.ts` — CH DDL + `platform_events_by_session_mv` per-row projection pattern
- `packages/eventstore/src/queues/kafka-queue.ts:109-112` — tenant-id partition key convention
- `packages/eventstore/src/retention/event-retention-service.ts` — `scrubPII` + `deleteTenant` behavior
- `packages/database/src/clickhouse.ts:261-340` — `BufferedClickHouseWriter` `flush` / `close` / `pending` / `getMetrics`
- `packages/database/src/cascade/event-cascade-hooks.ts` — interface extension point
- `apps/workflow-engine/src/services/trigger-scheduler.ts:57-96` — BullMQ repeatable + Redis `duplicate` connection pattern
- `packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts` — `ReplacingMergeTree(processed_at)` precedent
- `packages/pipeline-engine/agents.md` — analytics = ReplacingMergeTree, eval = AggregatingMergeTree learning

### Parent & related features

- [`workflows.md`](../features/workflows.md) — parent feature (BETA); GAP-10 + GAP-12 closed by this sub-feature
- [`eventstore.md`](../features/eventstore.md) — reused pipeline infrastructure (STABLE)
- [`memory-sessions.md`](../features/memory-sessions.md) — parallel-track owner of `mailbox='agent'` task tiering
- [`audit-logging.md`](../features/audit-logging.md) — consumer of workflow lifecycle events

### Pipeline references

- [`../sdlc/pipeline.md`](../sdlc/pipeline.md) — canonical SDLC pipeline
- [`../sdlc/hld-playbook.md`](../sdlc/hld-playbook.md) — HLD authoring guide
- CLAUDE.md — platform principles, test architecture, E2E rules, commit discipline
