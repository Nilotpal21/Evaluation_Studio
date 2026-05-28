# HLD Log — workflow-execution-event-sourcing

**Feature**: Workflow Execution Event Sourcing (ABLP-2)
**Parent Feature**: [Workflows & Human Tasks](../../features/workflows.md) / [EventStore](../../features/eventstore.md)
**Slug**: `workflow-execution-event-sourcing`
**Doc Type**: SUB-FEATURE
**Phase**: HLD (Phase 3 of 6)
**Status at HLD time**: PLANNED
**Created**: 2026-04-20
**Last Updated**: 2026-04-20

---

## 1. Invocation

- **Command**: `/hld workflow-execution-event-sourcing`
- **Skill version**: hld (as of 2026-04-20)
- **Working tree**: `/Users/Pattabhi.Dasari/abl-platform/.worktrees/workflow-runs-mongo-2-clickhouse`
- **Branch**: `feat/workflow-version`
- **Prior artifacts**:
  - Feature spec: `docs/features/sub-features/workflow-execution-event-sourcing.md` (commit `2727e7a731`)
  - Test spec: `docs/testing/sub-features/workflow-execution-event-sourcing.md` (commit `09536d3767`)
  - Feature-spec log: `docs/sdlc-logs/workflow-execution-event-sourcing/feature-spec.log.md`
  - Test-spec log: `docs/sdlc-logs/workflow-execution-event-sourcing/test-spec.log.md`

## 2. Inputs Consulted

Per HLD skill Phase 1 + product-oracle evidence trail:

- Feature spec (691 lines) and test spec (563 lines)
- `docs/specs/eventstore.hld.md` (pattern source of truth)
- `packages/eventstore/src/stores/clickhouse/platform-events-table.ts` (CH DDL conventions, `platform_events_by_session_mv` per-row projection pattern)
- `packages/eventstore/src/schema/event-registry.ts` (Zod + metadata + PII flagging)
- `packages/eventstore/src/queues/kafka-queue.ts` (existing `tenant_id` partition-key strategy)
- `packages/eventstore/src/stores/clickhouse/clickhouse-event-store.ts` + `packages/database/src/clickhouse.ts` (`BufferedClickHouseWriter.flush()`/`close()`/`pending`/`getMetrics()`)
- `packages/eventstore/src/retention/event-retention-service.ts` (`scrubPII` + `deleteTenant` + `deleteBySessionIds`)
- `packages/database/src/cascade/event-cascade-hooks.ts` (interface extension point)
- `apps/workflow-engine/src/services/trigger-scheduler.ts` (BullMQ repeatable + Redis duplicate connection pattern)
- `apps/workflow-engine/src/persistence/execution-store.ts` (store shape; outbox integration point)
- `apps/runtime/src/services/eventstore-singleton.ts` (cascade hook registration site)
- `apps/runtime/src/services/event-bus/` (inspected: this is a producer bus, not a sink consumer)
- `packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts` + `init-eval-tables.ts` (`ReplacingMergeTree` vs `AggregatingMergeTree` precedents)
- CLAUDE.md (platform principles, test architecture, E2E rules, commit discipline)

## 3. Clarifying Questions & Decisions

15 questions asked, grouped by Architecture/Integration/Risk. All resolved by the product-oracle agent via codebase evidence or defensible DECIDED judgment calls — **zero AMBIGUOUS escalations**.

### Architecture & Data Flow

| #   | Question                       | Classification | Final decision                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------ | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | `*_latest` MV pattern (FR-5)   | DECIDED        | **Per-row projection into `ReplacingMergeTree(_version)`**, NO aggregation in MV SELECT. Outbox events carry cumulative state (status, duration_ms, started_at, etc.) enriched at emit time from Mongo domain doc. MV writes one row per event; `ReplacingMergeTree` merges collapse to highest `_version`. Matches `platform_events_by_session_mv` (eventstore) + all pipeline-engine analytics tables. Kills FR-5 HLD-validation gap. |
| Q2  | Kafka→CH consumer directory    | ANSWERED       | `apps/runtime/src/services/workflow-events-consumer.ts` (flat, colocated with `eventstore-singleton.ts`). NOT inside `event-bus/` — that directory is a producer bus (`KafkaSubscriber` publishes outbound events); this consumer is the opposite direction. Kills the PROVISIONAL flag in feature spec §10.                                                                                                                            |
| Q3  | Outbox poller location         | ANSWERED       | `apps/workflow-engine/src/outbox/outbox-poller.ts`. Emit + publish live together in workflow-engine (matches `TriggerScheduler` pattern at `apps/workflow-engine/src/services/trigger-scheduler.ts:57-96`); consume + sink live in runtime. No change from feature spec §10.                                                                                                                                                            |
| Q4  | Dual-read UNION physical split | DECIDED        | `HybridExecutionReader` service injected into routes. Calls `ExecutionStore` (Mongo leg), a CH query builder (CH leg), delegates merge + dedup to pure function `apps/workflow-engine/src/persistence/dual-read-merger.ts` (already planned for UT-05). User identity passed into the service; both legs apply identical visibility filter.                                                                                             |
| Q5  | Kafka partition key            | ANSWERED       | `key = tenantId` — matches existing `KafkaEventQueue` at `packages/eventstore/src/queues/kafka-queue.ts:109-112`. Per-tenant ordering across entities. FR-2's mention of "keyed by entity ID" is resolved in favor of FR-3's "tenant-ID-based partitioning" — HLD explicitly pins this and notes the FR contradiction.                                                                                                                  |

### Integration & Dependencies

| #   | Question                                          | Classification | Final decision                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q6  | Outbox Mongoose model location                    | ANSWERED       | `packages/database/src/models/workflow-event-outbox.model.ts`. Follows established convention (every model lives in `packages/database/src/models/`; cascade hook already lives in `packages/database/src/cascade/`).                                                                                       |
| Q7  | Test-diagnostic endpoints (`/api/admin/test/...`) | DECIDED        | Acceptable. No prior precedent in codebase (new pattern), but CLAUDE.md E2E rules forbid direct DB access — diagnostic endpoints are the only correct pattern. Gated on `NODE_ENV=test`, registered via dynamic import, identical auth middleware, sanitized bodies. Kills test-spec OQ-3.                  |
| Q8  | testcontainers vs docker-compose                  | ANSWERED       | Stick with docker-compose + `.ci.yml`. Zero testcontainers usage in current codebase; introducing it would be a new dependency pattern across the monorepo. Add the two new Kafka topics + CH tables to existing `docker-compose.yml`. Kills test-spec OQ-1.                                                |
| Q9  | `BufferedClickHouseWriter` flush hook             | ANSWERED       | No new API surface needed. Existing `flush()`, `close()`, `pending`, `getMetrics()` at `packages/database/src/clickhouse.ts:261-340` are sufficient. Integration tests call `await writer.flush()` and assert. Kills test-spec OQ-2.                                                                        |
| Q10 | `MongoMemoryReplSet` tx support                   | ANSWERED       | Existing helpers (`packages/database/src/__tests__/helpers/setup-mongo.ts`, `apps/workflow-engine/src/__tests__/helpers/setup-mongo.ts`) use standalone `MongoMemoryServer`. Must switch to `MongoMemoryReplSet` (same `mongodb-memory-server` package, no new dep). ~5-10s startup acceptable. Kills OQ-4. |

### Risk & Migration

| #   | Question                 | Classification | Final decision                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q11 | Biggest technical risk   | DECIDED        | **MV projection correctness** — silent data corruption is the worst failure mode. Resolved by Q1 decision (per-row projection instead of aggregation). Must be validated by INT-03 (MV projection test) before Phase A exit. Kafka→CH lag, poller leader-election failover, and TTL-on-in-flight are Low/Medium.                                                               |
| Q12 | Phase B TTL bug rollback | DECIDED        | CH is the recovery source. Drop TTL index (stops deletion in ~60s) → query `workflow_execution_events` in CH for affected range → re-materialize into Mongo via backfill script. Progressive enablement (14d → 48h) per feature spec §13 step 2.2 limits blast radius.                                                                                                         |
| Q13 | PII scoring              | INFERRED       | Events with PII: `workflow.execution.started` (trigger_payload), `workflow.execution.completed` (output), `workflow.human_task.created` (task content), `workflow.human_task.responded` (response/decision). Register `containsPII: true` in `EventRegistry`. Scrub runs on BOTH daily retention tick (`scrubPII`) AND GDPR cascade (`deleteTenant` / `deleteByExecutionIds`). |
| Q14 | One-time backfill        | DECIDED        | Optional CLI scoped as follow-up ticket. NOT required at Phase A. Feature spec §2 Non-Goals already defers; §16 GAP-001 documents (Low severity). HLD mentions as deferred; CH historical coverage builds up naturally over plan_retention_days.                                                                                                                               |
| Q15 | Mongo TTL force-sweep    | DECIDED        | Test-admin `POST /api/admin/test/mongo/ttl-sweep?collection=...` endpoint runs `deleteMany` with the same filter as the TTL index. Fast (<100ms), deterministic, mirrors TTL's `partialFilterExpression` exactly. We test app behavior under deletion, not Mongo's TTL implementation.                                                                                         |

## 4. Files Created

- `docs/specs/workflow-execution-event-sourcing.hld.md`
- `docs/sdlc-logs/workflow-execution-event-sourcing/hld.log.md` (this file)

## 5. Audit Rounds

### Round 1 — NEEDS_REVISION

**Findings:**

CRITICAL:

- HD-2 — `KafkaEventQueue.enqueue()` is single-topic + fire-and-forget at `kafka-queue.ts:50,102`; HLD invented a 3-arg topic-routing form in §3.3 step 5b and assumed ACK-awaitable semantics in §3.5 sequence diagram.
- HD-2 — `ExecutionStore` (220 lines) has no Mongo `ClientSession` support; HLD §3.3 / §3.5 / §4 concern #7 assumed atomic outbox-in-tx as if it existed.

HIGH:

- XP-3 — Feature spec FR-2 "keyed by entity ID" contradiction persisted; HLD log pinned tenantId but feature spec wording not flagged for amendment.
- XP-4 — `payload_truncated UInt8` column introduced in HLD DDL without any errata note reconciling it against feature-spec DDL.
- HD-8 — Phase B TTL rollback plan implied CH as universal recovery source; in-flight runs deleted by misconfigured TTL are unrecoverable from CH (Restate journal would fail on missing domain doc).

MEDIUM:

- HD-10 — OQ-1 was partially resolved by the HLD itself (MV shape pinned in §5.3); reframe needed.
- XP-4 — Consumer file path had 3 different values across HLD component table, HLD log, and feature spec.

**Fixes applied:**

1. Added new §3.6 "Required Infrastructure Gaps" section naming Gap 1 (ExecutionStore session API) and Gap 2 (topic-routed ACK-awaitable Kafka publish). Each gap cites exact file:line evidence and lists 2–3 LLD options with a recommendation.
2. Rewrote §3.3 write-path to call `ExecutionStore.createExecution(payload, { session })` with an explicit NOTE referencing §3.6 Gap 1; replaced invented `KafkaEventQueue.enqueue(topic, event, key)` with `await kafkaProducer.send({...})` and cross-referenced §3.6 Gap 2.
3. Updated §3.5 sequence diagram to annotate the session-aware API requirement as a gap rather than showing it as existing behavior.
4. Added new §5.5 "Feature-Spec Errata" section consolidating deltas the HLD introduces: E-1 (FR-2 partition key = `tenantId`), E-2 (`payload_truncated` column on both CH event tables), E-3 (consumer file path resolved to `apps/runtime/src/services/workflow-events-consumer.ts`).
5. Rewrote §4 concern #11 Rollback Plan to make the TTL `partialFilterExpression: { completedAt: { $type: 'date' } }` the primary safety mechanism for in-flight runs, with an explicit LLD requirement for a startup-validation check; distinguished terminal-run recovery (from CH) vs in-flight-run non-recovery.
6. Added "§3.6 dependency" note to §4 concern #7 Idempotency.
7. Split §9 Open Questions into §9.1 "Already Pinned" (7 items) and §9.2 "Carried Forward" (10 items) — added Gap 1, Gap 2, test-diagnostic registration, inbox `agents.md` decision to §9.2.
8. Pinned consumer file path to `apps/runtime/src/services/workflow-events-consumer.ts` in §3.2 component table and §9.1.

### Round 2 — NEEDS_REVISION

**Findings:**

CRITICAL:

- HD-4 / XP-3 — `human_tasks_latest_mv` was deferred to feature-spec §9 DDL which still used the invalidated `argMax/min/max + GROUP BY` aggregation pattern that the HLD itself had corrected for `workflow_executions_latest_mv`. Same class of bug; would have shipped broken projection for workflow-sourced human tasks.

HIGH:

- HD-4 / XP-3 — Missing errata for `started_at` and `completed_at` column additions to `workflow_execution_events` (both required to make the per-row MV projection work). `/post-impl-sync` would not know to propagate.
- HD-4 — `human_task_events` DDL deferred to stale feature spec, but errata E-2 said `payload_truncated` needed adding — reader following the pointer would see an incomplete DDL.

**Fixes applied:**

1. Inlined the full `human_task_events` column list in §5.3 (with `payload_truncated` and `created_at` additions noted inline), replacing the "See feature spec §9" pointer.
2. Inlined the corrected `human_tasks_latest_mv` DDL (per-row projection, no GROUP BY, no argMax, with `WHERE mailbox = 'workflow'` scope at the MV). Explicitly stated this supersedes feature spec §9.
3. Added errata row E-4: `started_at` + `completed_at` on `workflow_execution_events`, `created_at` on `human_task_events` — cumulative state columns required by the per-row MV pattern.
4. Added errata row E-5: `human_tasks_latest_mv` DDL replacement documented for `/post-impl-sync` to propagate back to feature spec §9.

### Round 3 — APPROVED

Round 3 verified:

- All Round 1 and Round 2 CRITICAL + HIGH findings resolved.
- LLD handoff readiness: §3.6 gaps (Gap 1 + Gap 2), §5.5 errata (E-1 through E-5), §6 API design, and §9.2 Carried-Forward (10 items) are all actionable with concrete options.
- Quality-gate compliance: all 12 concerns substantively addressed, 4 alternatives with genuine trade-offs, architecture diagrams present, data model complete for both CH tables + MVs, API design complete (existing + 8 test-diagnostic endpoints), test strategy specifies real-service boundaries with no codebase-component mocking.
- Silent-failure risk scan: claims like "existing X" / "reuses Y" verified against code; no new unbacked assumptions.

Two non-blocking MEDIUMs remain (cosmetic section numbering, `human_task_events` partially in prose vs pure DDL) — explicitly marked as deferrable to LLD or `/post-impl-sync` per the auditor.

**Verdict**: APPROVED for next SDLC phase (`/lld`).

## 6. Open Items for Next Phase (`/lld`)

- Concrete SQL for the corrected MV SELECT (per-row projection) — LLD must pin the exact column list and timestamp semantics for `started_at` and `completed_at` given the corrected approach.
- Exact signature of the outbox payload enrichment helper (`buildOutboxPayload(executionDoc, event_type)`) that copies cumulative state from Mongo into each event.
- Wiring path for the test-diagnostic endpoints (`NODE_ENV=test` guarded dynamic import) — LLD chooses between a feature-flag module loader vs conditional `app.use()`.
- BullMQ queue naming convention for the outbox poller repeatable job — align with existing `trigger-scheduler:*` queue names.
- Rollout sequencing inside Phase A: specific flag-flip order and parity-check gate thresholds (e.g., "drift < 0.1% over 48h window" before next flip).
