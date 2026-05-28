# Feature Spec Log — workflow-execution-event-sourcing

**Feature**: Workflow Execution Event Sourcing (ABLP-2)
**Parent Feature**: [Workflows & Human Tasks](../../features/workflows.md)
**Slug**: `workflow-execution-event-sourcing`
**Doc Type**: SUB-FEATURE
**Status at spec time**: PLANNED
**Created**: 2026-04-20
**Last Updated**: 2026-04-20

---

## 1. Invocation

- **Command**: `/feature-spec workflow-execution-event-sourcing`
- **Skill version**: feature-spec (as of 2026-04-20)
- **Working tree**: `/Users/Pattabhi.Dasari/abl-platform/.worktrees/workflow-runs-mongo-2-clickhouse`
- **Branch**: `feat/workflow-runs-mongo-2-clickhouse`
- **Base**: `origin/develop`

## 2. Discovery Summary

### Prior art

- **Parent feature**: `docs/features/workflows.md` (BETA, WorkflowExecution model, Restate-backed)
- **Existing event pipeline pattern**: `docs/features/eventstore.md` (STABLE) + `packages/eventstore/`
- **Existing CH tables with similar shape**: `platform_events` (`packages/eventstore/src/stores/clickhouse/platform-events-table.ts`)
- **Existing outbox-like patterns**: `TriggerScheduler` (BullMQ repeatable) provides leader-election precedent
- No prior `*mongo*click*` or `*workflow-execution-event*` spec/plan found

### Key code surfaces consulted

- `packages/database/src/models/workflow-execution.model.ts`
- `packages/database/src/models/human-task.model.ts`
- `apps/workflow-engine/src/persistence/execution-store.ts`
- `apps/workflow-engine/src/routes/workflow-executions.ts`
- `apps/studio/src/components/workflows/tabs/WorkflowMonitorTab.tsx`
- `apps/studio/src/components/inbox/UnifiedInboxPage.tsx`
- `apps/studio/src/hooks/useWorkflowDetail.ts`
- `apps/studio/src/hooks/useHumanTasks.ts`
- `apps/studio/src/app/api/projects/[id]/workflows/[workflowId]/executions/route.ts`
- `apps/studio/src/app/api/projects/[id]/human-tasks/route.ts`
- `apps/runtime/src/routes/human-tasks.ts`
- `packages/eventstore/src/queues/kafka-queue.ts`
- `packages/eventstore/src/stores/clickhouse/clickhouse-event-store.ts`
- `packages/eventstore/src/schema/event-registry.ts`
- `docker-compose.yml` (Kafka, Restate, Mongo, CH)

## 3. Clarifying Questions & Decisions

20 questions covered across Scope & Problem, User Stories & Requirements, Technical & Architecture, and post-oracle scope refinements. All questions were resolved via the product-oracle agent and user review — zero AMBIGUOUS escalations.

### Scope & Problem

| #   | Question               | Classification                          | Final decision                                                                                                |
| --- | ---------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Q1  | Primary scaling driver | INFERRED                                | Mongo working-set pressure + query latency at scale for historical data                                       |
| Q2  | Target scale           | INFERRED                                | 100K–500K runs/day platform-wide; 100 concurrent active runs per tenant; ~5–100 KB per execution doc          |
| Q3  | Backfill needed        | DECIDED                                 | No backfill. Feature is BETA; dual-read UNION + 48h Mongo buffer covers gap                                   |
| Q4  | Scope boundary         | DECIDED (refined via user conversation) | `workflow_executions` + `human_tasks WHERE mailbox='workflow'`. Excludes `agent_escalation` tasks             |
| Q5  | Retention              | DECIDED                                 | Plan-tiered retention in CH (FREE 30d / TEAM 90d / BUSINESS 365d / ENTERPRISE 7y), matching `platform_events` |

### User Stories & Requirements

| #   | Question           | Classification | Final decision                                                                                                                                   |
| --- | ------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q6  | Primary personas   | ANSWERED       | Studio user (primary), platform operator (SRE), analytics consumer, auditor/compliance (closes `workflows.md` GAP-10)                            |
| Q7  | Freshness SLA      | INFERRED       | Active runs: ≤5s (SWR poll). Recent (<48h): ≤5s. Historical (>48h): ≤10s (Kafka linger + CH flush)                                               |
| Q8  | Net-new queries    | INFERRED       | v1 UI unchanged. New CH-aggregated queries enabled: p95/p99 duration per workflow, success-rate trend, step-type heatmap, trigger-type breakdown |
| Q9  | Cancel latency     | ANSWERED       | ≤5s (unchanged). Cancel writes to Mongo; unaffected by tiering                                                                                   |
| Q10 | Compliance signoff | DECIDED        | No formal process; register workflow events with `containsPII: true` (reuse eventstore PII pattern). No per-tenant retention overrides           |

### Technical & Architecture

| #   | Question                     | Classification                             | Final decision                                                                                                                                                                                        |
| --- | ---------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q11 | Topic strategy               | DECIDED                                    | Dedicated topics per domain: `abl.workflow.execution`, `abl.human.task`. Matches runtime event-bus `abl.*` convention                                                                                 |
| Q12 | Restate replay constraints   | ANSWERED                                   | Restate uses its own journal, not Mongo. TTL on completed runs is safe. In-flight upsert pattern in `execution-store.ts` already handles replay idempotency                                           |
| Q13 | Outbox cluster-safety        | ANSWERED                                   | Use BullMQ repeatable job for outbox poller (same pattern as `TriggerScheduler`). Free leader election via BullMQ/Redis                                                                               |
| Q14 | `ReplacingMergeTree` pattern | ANSWERED                                   | Already well-established (`platform_events_by_session`, facts store, pipeline engine). Extends existing pattern                                                                                       |
| Q15 | Rollout sequence             | USER OVERRIDE → **B — 2-phase flag-gated** | Phase A: ship outbox + Kafka + CH + dual-read behind feature flags. Flip flags progressively. Phase B: enable Mongo TTL                                                                               |
| Q16 | Event schema evolution       | ANSWERED                                   | `EventRegistry` requires semver `version`. Add `event_version` column in new CH table (improves on `platform_events`). Zod `.passthrough()` for additive schema changes                               |
| Q17 | GDPR cascade                 | ANSWERED                                   | Register workflow-specific `EventCascadeHook` (closes `workflows.md` GAP-12). Cascade spans Mongo (`workflow_executions`, `human_tasks` workflow-source, outbox) + CH (event tables + `*_latest` MVs) |

### Post-oracle scope refinements

| #   | Topic                          | Final decision                                                                                                                                    |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q18 | human_tasks subset             | `mailbox='workflow'` in scope; `mailbox='agent'` (agent_escalation) **out of scope** — belongs to future Sessions ticket                          |
| Q19 | Separate CH tables per entity  | YES — separate tables + separate MVs + separate Kafka topics. Shared outbox collection (discriminated by `event_type`). Shared ingestion pipeline |
| Q20 | Inbox default-status filter UX | USER OVERRIDE → **in scope**. Default Inbox list view filters `status ∈ {pending, assigned, in_progress}`. "Include completed" toggle for history |

## 4. Files Created

- `docs/features/sub-features/workflow-execution-event-sourcing.md`
- `docs/testing/sub-features/workflow-execution-event-sourcing.md`

## 5. Index Updates

- `docs/features/README.md` — added row under Workflows P3 parent
- `docs/testing/README.md` — added row under matching section
- `docs/features/sub-features/README.md` — added row
- `docs/testing/sub-features/README.md` — added row

## 6. Audit Rounds

### Round 1 — NEEDS_REVISION

**Findings:**

CRITICAL:

- FS-2a `EventCascadeHook` interface does not support `deleteByExecutionIds` — spec claimed reuse but the method is net-new.
- FS-2b CH DDL ORDER BY omits `project_id` across all 4 tables, violating project isolation performance contract.

HIGH:

- FS-3a MV SELECT uses `argMax`/`maxIf`/`min`/`max` aggregations targeting plain `ReplacingMergeTree` — does not accumulate across insertion blocks. Needs HLD validation.
- FS-7 `workflow_event_outbox` missing compound index `{tenantId, entity_kind, entity_id}` for efficient cascade-by-executionId.
- FS-6 User isolation section thin — no UNION-path visibility contract specified.
- FS-8 Delivery plan missing subtask for `EventCascadeHook` interface extension.
- FS-10 Parent link in header referenced only Workflows; index entries reference `Workflows / EventStore`.

MEDIUM:

- FS-9 E2E scenarios in testing placeholder lacked explicit auth context.
- FS-3b FR-9 mixed UI scope with storage scope — acknowledge origin via note.
- FS-2c `event-bus/workflow-events-consumer.ts` directory path provisional — note for HLD validation.

**Fixes applied:**

1. Updated header `Parent Feature` to `Workflows & Human Tasks / EventStore`.
2. Rewrote FR-10 to explicitly state `EventCascadeHook` interface extension at `packages/database/src/cascade/event-cascade-hooks.ts` with backward-compat no-op defaults on existing implementations.
3. Upgraded EventStore row in integration matrix to `depends on / emits into / extends interface` with the cascade-hook file added to key touchpoints.
4. Added `project_id` to ORDER BY across all 4 CH tables (`workflow_execution_events`, `human_task_events`, `workflow_executions_latest`, `human_tasks_latest`).
5. Appended HLD-validation note to FR-5 flagging that the `argMax` MV pattern against plain `ReplacingMergeTree` does not accumulate across insertion blocks; HLD must choose row-projection vs `AggregatingMergeTree`.
6. Added compound index `{ tenantId: 1, entity_kind: 1, entity_id: 1 }` to `workflow_event_outbox`.
7. Expanded user isolation row in §12 to specify the UNION-path contract: CH queries must apply the same user-visibility filter as Mongo; cross-user access returns 404; user identity is passed into the CH query.
8. Added delivery subtask 1.0 — ship the `EventCascadeHook` interface extension as its own backward-compat commit before any workflow-specific code.
9. Added scope-origin note to FR-9 marking it as a Q20 override that is independently deployable.
10. Flagged `event-bus/workflow-events-consumer.ts` directory as provisional pending HLD/LLD confirmation.
11. Added an "Auth Context Baseline" block (tenant/project/user = t1/p1/u1, role=project_admin) to the testing placeholder.

### Round 2 — APPROVED

Round 2 verified all CRITICAL and HIGH findings from round 1 were resolved. Remaining advisory MEDIUMs:

- **FS-7 (addressed)**: outbox `published_at` index was listed twice (sparse + partial TTL). Collapsed to a single partial TTL index — the partial filter both sparsifies the index (unpublished rows excluded) and gates TTL deletion.
- **FS-2 (out of scope)**: parent feature status divergence (`docs/features/README.md` line 79 says ALPHA; `docs/features/workflows.md` line 5 says BETA). Pre-existing; owned by `/post-impl-sync` for the Workflows feature, not this ticket.
- **FS-9 (addressed)**: round 1 + round 2 entries now populated in this log file.

**Verdict**: APPROVED for the next SDLC phase (`/test-spec`).

## 7. Open Items for Next Phase (`/test-spec`)

- Full E2E scenario design (per 2-phase rollout: shadow parity, dual-read correctness, TTL correctness)
- Performance budgets: outbox poll lag, Kafka consumer lag, CH ingest lag, MV merge lag
- Load-test plan for 50K+ runs/day ingest validation
- Mongo→CH parity check tooling design (used to gate Phase A → Phase B flag flip)
