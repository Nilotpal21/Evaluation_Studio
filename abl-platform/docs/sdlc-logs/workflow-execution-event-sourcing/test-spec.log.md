# Test Spec Log — workflow-execution-event-sourcing

**Feature**: Workflow Execution Event Sourcing (ABLP-2)
**Parent Feature**: [Workflows & Human Tasks](../../features/workflows.md) / [EventStore](../../features/eventstore.md)
**Slug**: `workflow-execution-event-sourcing`
**Doc Type**: SUB-FEATURE
**Status at spec time**: PLANNED
**Created**: 2026-04-20
**Last Updated**: 2026-04-20

---

## 1. Invocation

- **Command**: `/test-spec workflow-execution-event-sourcing`
- **Skill version**: test-spec (as of 2026-04-20)
- **Working tree**: `/Users/Pattabhi.Dasari/abl-platform/.worktrees/workflow-runs-mongo-2-clickhouse`
- **Branch**: `feat/workflow-runs-mongo-2-clickhouse`
- **Base**: `origin/develop`

## 2. Inputs

- **Feature spec**: `docs/features/sub-features/workflow-execution-event-sourcing.md` (committed `2727e7a731`)
- **Prior placeholder**: `docs/testing/sub-features/workflow-execution-event-sourcing.md` (shipped with feature spec)
- **Feature-spec log**: `docs/sdlc-logs/workflow-execution-event-sourcing/feature-spec.log.md` (2 audit rounds, APPROVED)
- **Existing test patterns consulted**:
  - `apps/workflow-engine/src/__tests__/execution-store.test.ts`
  - `apps/workflow-engine/src/__tests__/system-persistence.test.ts`
  - `apps/workflow-engine/src/__tests__/executions-isolation.integration.test.ts`
  - `apps/workflow-engine/src/__tests__/workflow-executions-routes.test.ts`
  - `apps/workflow-engine/src/__tests__/e2e-basic.test.ts`
  - `apps/workflow-engine/src/__tests__/trigger-scheduler-timezone.test.ts`
  - `apps/runtime/src/__tests__/human-task-routes.test.ts`
  - `packages/eventstore/src/__tests__/retention-gdpr.test.ts`
  - `packages/eventstore/src/__tests__/schema-passthrough.test.ts`
  - `packages/database/src/__tests__/helpers/setup-mongo.ts`
  - `packages/database/src/__tests__/clickhouse-writer.test.ts`
  - `apps/studio/e2e/workflows/agents.md`
- **Test-spec playbook**: `docs/sdlc/test-spec-playbook.md`

## 3. Clarifying Questions & Decisions

20 questions grouped across Test Scope & Priorities, E2E Scenarios, Integration Boundaries, Isolation & Security Coverage, and Test Infrastructure. All questions resolved via product-oracle agent — zero AMBIGUOUS escalations.

### Test Scope & Priorities

| #   | Question                            | Classification | Final decision                                                                                                                                              |
| --- | ----------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Highest-risk FRs                    | INFERRED       | FR-1 (Outbox Atomicity), FR-2 (Poller/Leader), FR-6 (Hybrid API Reads), FR-10 (GDPR Cascade) — confirmed by GAP-003 and GAP-005 in feature spec             |
| Q2  | Known edge cases                    | INFERRED       | Restate replay + concurrent cancel vs step-complete + burst fan-out (20+ events/run, Open Q1) — integration-level coverage                                  |
| Q3  | Baseline coverage                   | ANSWERED       | Workflow-engine has ~55 test files (unit/system/e2e). `packages/eventstore` uses `MemoryEventStore`. **Zero coverage** exists for outbox/Kafka→CH/dual-read |
| Q4  | Mock-vs-real boundary               | DECIDED        | Real: Mongo, Redis, Kafka, CH. Mocked via DI: LLM providers only (if used in a step)                                                                        |
| Q5  | CI testcontainers vs docker-compose | INFERRED       | No testcontainers infra exists today. Use docker-compose harness (+ `MongoMemoryServer` where tx-support not needed). Testcontainers deferred               |

### E2E Scenarios

| #   | Question               | Classification | Final decision                                                                                                                     |
| --- | ---------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Q6  | Critical user journeys | ANSWERED       | 5 existing (E2E-01..E2E-05) + add E2E-06 cross-feature Trigger→Execution→HumanTask→CH chain per D-8                                |
| Q7  | Auth combinations      | DECIDED        | project_admin (baseline) + project_member read-only + cross-tenant 404 + cross-project 404 + missing-auth 401 + API key read-scope |
| Q8  | Cross-feature coverage | DECIDED        | Add 1 cross-feature E2E covering two separate outbox paths (execution + human_task) and the shared `execution_id` join key         |
| Q9  | Seeding approach       | ANSWERED       | E2E = HTTP-only (per CLAUDE.md E2E rule #2). Integration = direct `ExecutionStore.createExecution()` calls acceptable              |
| Q10 | Load test runtime      | DECIDED        | Load (1M runs / 4h) is a manual staging gate with Grafana k6. CI carries a lightweight 100-exec smoke assertion only               |

### Integration Boundaries

| #   | Question                        | Classification | Final decision                                                                                                                                           |
| --- | ------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q11 | Outbox-atomicity boundary       | DECIDED        | Hit `ExecutionStore.createExecution()` directly with real Mongo replica set (tx required). Not at route-handler level                                    |
| Q12 | Multi-replica BullMQ simulation | INFERRED       | Start 3 poller instances in-process pointing at **real Redis** (docker-compose). No `vi.mock('bullmq')` — use real BullMQ repeatable-job semantics       |
| Q13 | Kafka→CH consumer test tier     | DECIDED        | Both: integration tests the consumer + BufferedClickHouseWriter boundary; E2E-01 proves the full chain                                                   |
| Q14 | Race conditions                 | DECIDED        | All three (cancel-vs-step, Restate replay, burst fan-out) at **integration** level — real DB contention cannot be faked                                  |
| Q15 | Error paths                     | DECIDED        | All four tested. Priority: Kafka-down > CH-drop > Mongo tx-abort > Redis-drop. Simulate via docker-compose service stop or DI-injected connection errors |

### Isolation & Security Coverage

| #   | Question                         | Classification | Final decision                                                                                                                                      |
| --- | -------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q16 | Negative-test tier split         | DECIDED        | Cross-tenant / cross-project / 401 / 403 at **E2E** (auth middleware chain required). CH query builder isolation at **integration**                 |
| Q17 | Human-task user-isolation parity | ANSWERED       | Dedicated integration test — assert UNION path CH query matches Mongo for `has(assigned_to, userId) OR claimed_by = userId` filter                  |
| Q18 | Invalid `status=foo` enum        | INFERRED       | Expect HTTP 400 with `{ success: false, error: { code: 'VALIDATION_ERROR', ... } }` via Zod validation — unit (schema) + E2E (HTTP) test pair       |
| Q19 | PII scrubbing assertion          | INFERRED       | Import sentinel constant from eventstore package; assert equality to sentinel instead of substring match. GDPR cascade (FR-10) asserts row deletion |

### Test Infrastructure

| #   | Question                  | Classification | Final decision                                                                                                                                           |
| --- | ------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q20 | Existing fixtures/helpers | ANSWERED       | Mongo: `setupTestMongo()` exists. Kafka: **no helper** — must build one. CH: **no helper** — must build one. Express: inline `createApp()` per test file |

## 4. Files Created / Modified

- **Rewritten**: `docs/testing/sub-features/workflow-execution-event-sourcing.md` (expanded placeholder → full test spec)
- **Created**: `docs/sdlc-logs/workflow-execution-event-sourcing/test-spec.log.md` (this file)
- **No index updates required**: test spec entries already exist in `docs/testing/README.md` and `docs/testing/sub-features/README.md` from the feature-spec phase.

## 5. Audit Rounds

### Round 1 — NEEDS_REVISION

Verdict: NEEDS_REVISION. Zero CRITICAL. 2 HIGH + 4 MEDIUM findings.

**Findings:**

HIGH:

- **TS-9 / XP-4**: Test file names diverge between feature spec §10 and test spec §11 (6+ mismatches).
- **TS-4**: INT-06 steps 3–4 language "direct query against the CH table" ambiguous about access mechanism (direct client vs HTTP endpoint).

MEDIUM:

- Playbook §3 Surface Semantics & Design-Time vs Runtime Verification section missing.
- TS-8: Test-diagnostic `/api/admin/test/...` endpoints — security design deferred to HLD (already captured in OQ-3, no change needed).
- TS-10: Studio Playwright E2E-03/E2E-04 missing reference to `apps/studio/e2e/workflows/agents.md`.
- XP-4 (secondary): FR-3 Kafka topic routing has no explicit assertion in INT-02.

**Fixes applied:**

1. Rewrote feature spec §10 Tests table to adopt the authoritative `.integration.test.ts` / `.e2e.test.ts` / `.spec.ts` naming convention; added all 8 integration + 6 E2E + 6 unit files — now fully aligned with test spec §11.
2. Rewrote feature spec §17 Required Test Coverage table to match the test spec's 12-row scenario catalog with updated test-file paths.
3. Expanded INT-02 to **INT-02: Outbox Poller — Leader Election + Retry + FIFO + Topic Routing**. Added step 7 asserting (a) execution rows publish to `abl.workflow.execution`, (b) human_task rows publish to `abl.human.task`, (c) Kafka message `key === tenantId` for tenant-based partitioning.
4. Clarified INT-06 steps 3–4: direct CH client query + direct Mongoose model query are explicitly permitted in **integration tier** (never in E2E per CLAUDE.md). Concrete CH SQL and Mongoose expression now in-line.
5. Added **§7a Surface Semantics & Design-Time vs Runtime Verification** — documents feature is purely runtime/storage-layer, no DSL/IR/snapshot surface.
6. Expanded Test-Integrity Rules in §3: added "Direct DB access permitted in integration tier, forbidden in E2E tier" rule explicitly. Added "Studio Playwright conventions" bullet referencing `apps/studio/e2e/workflows/agents.md` with update obligation.

### Round 2 — APPROVED

Verdict: APPROVED. Zero CRITICAL, zero HIGH. 2 MEDIUM + 2 LOW advisories; the MEDIUMs and one LOW were addressed in-place before commit.

**Round 1 fixes verified**:

- Feature spec §10 Tests table and test spec §11 test-file mapping now byte-identical (20 paths).
- Feature spec §17 scenario catalog mirrors test spec (6 E2E + 8 integration).
- INT-02 step 7 asserts FR-3 topic routing + tenant partition key.
- INT-06 steps 3–4 specify CH SQL + Mongoose expression as integration-tier direct queries.
- §7a Surface Semantics N/A section present.
- Studio Playwright `agents.md` reference + update obligation added to §3.

**Round 2 advisory findings addressed in-place**:

1. **MEDIUM — `apps/studio/e2e/inbox/` is net-new.** Added OQ-9: "Does the `inbox/` subtree get its own `agents.md`, or is it consolidated under `apps/studio/e2e/agents.md`?" — LLD decision.
2. **MEDIUM — E2E-03 time-travel seeding underspecified.** Added two new test-admin diagnostic endpoints to §10: `POST /api/admin/test/seed/executions` and `POST /api/admin/test/seed/human-tasks`, both routing through the real store layer with opt-in `completedAt` / `startedAt` overrides. E2E-03 preconditions now reference these endpoints instead of the abstract "time-machine override" phrasing.
3. **LOW — E2E-01 overclaims FR-2.** Dropped FR-2 from E2E-01 objective; added explanatory note that poller internals are covered exclusively by INT-02.
4. **LOW — FR-2 coverage matrix shows no E2E column.** Informational; no change required. The matrix accurately reflects FR-2 as integration-only.

**Verdict**: APPROVED for the next SDLC phase (`/hld`).

## 6. Open Items for Next Phase (`/hld`)

- Resolve FR-5 `ReplacingMergeTree` MV pattern (plain vs `AggregatingMergeTree` with `argMaxState`/`argMaxMerge`) — the test spec pins concrete assertions that the HLD must make implementable.
- Confirm outbox-poller BullMQ repeatable-job naming scheme (so the 3-replica integration test seeds the right job key).
- Decide whether Kafka test helper lives in `packages/testing-infra/` (new) or inline under `packages/eventstore/src/__tests__/helpers/`.
- Decide CH test-helper reuse — extend `packages/database/src/__tests__/helpers/` or create a new module.
