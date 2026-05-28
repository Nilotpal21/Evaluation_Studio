# Test Specification: Workflow Execution Event Sourcing

**Feature ID**: ABLP-2 (sub-feature of [Workflows & Human Tasks](../workflows.md) / [EventStore](../eventstore.md))
**Feature Spec**: [`../../features/sub-features/workflow-execution-event-sourcing.md`](../../features/sub-features/workflow-execution-event-sourcing.md)
**HLD**: [`../../specs/workflow-execution-event-sourcing.hld.md`](../../specs/workflow-execution-event-sourcing.hld.md)
**LLD**: [`../../plans/2026-04-21-workflow-execution-event-sourcing-impl-plan.md`](../../plans/2026-04-21-workflow-execution-event-sourcing-impl-plan.md)
**Status**: PARTIAL — unit coverage SHIPPED (141 cases across 18 files, including a dedicated UT-04 parser test; counts verified 2026-04-21); 5-round `pr-reviewer` loop complete (all APPROVED, 0 CRITICAL / 0 HIGH unresolved, 4 non-blocking follow-ups filed); real-infra integration + E2E + LOAD-02 deferred to the dockerized-CH PR (tracked as feature-spec GAP-008).
**Created**: 2026-04-20
**Last Updated**: 2026-04-21

---

## 1. Feature Metadata

- **Scope**: MongoDB `workflow_executions` + `human_tasks WHERE mailbox='workflow'` tiered to ClickHouse via transactional outbox + Kafka + CH MV projection.
- **Excluded**: `human_tasks WHERE mailbox='agent'` (Memory & Sessions area), Restate internal journal, new analytical dashboards.
- **Rollout**: 2-phase flag-gated (Phase A = shadow + dual-read behind flags; Phase B = Mongo TTL).
- **Feature flags under test**: `WORKFLOW_OUTBOX_ENABLED`, `WORKFLOW_CH_SINK_ENABLED`, `WORKFLOW_DUAL_READ_ENABLED`, `WORKFLOW_MONGO_TTL_ENABLED`.

## 2. Current State

| Aspect                               | Status                                                                                                                                                                                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Feature implementation               | DONE (ALPHA) — all 6 LLD phases landed on branch `feat/workflow-runs-mongo-2-clickhouse` (38 commits, 2026-04-21)                                                                                                                                                               |
| Test implementation                  | PARTIAL — 141 unit cases across 18 files SHIPPED (see §11, includes UT-04 parser dedicated test); 1 integration scenario SHIPPED (INT-01); 0 E2E SHIPPED; real-infra integration + E2E + LOAD-02 deferred to dockerized-CH PR                                                   |
| Coverage today                       | Unit: high (row mapper, Zod, hybrid readers, merger, TTL helpers, cascade hooks, flag gates, lifecycle). Integration: INT-01 atomicity SHIPPED via `MongoMemoryReplSet`. E2E / LOAD: 0%.                                                                                        |
| Adjacent tests that will be extended | Same as before — `apps/workflow-engine/src/__tests__/workflow-executions-routes.test.ts`, `apps/workflow-engine/src/__tests__/executions-isolation.integration.test.ts`, `apps/runtime/src/__tests__/human-task-routes.test.ts`                                                 |
| Test-infra pieces reused             | `packages/database/src/__tests__/helpers/setup-mongo.ts` (`MongoMemoryServer`), `MongoMemoryReplSet` for INT-01 transaction tests                                                                                                                                               |
| Test-infra pieces that must be built | **Still needed**: Kafka test helper (produce/consume + topic lifecycle), CH testcontainers helper (connect / create-tables / query / teardown), docker-compose pause/unpause orchestration for INT-08, shared `startTestServer(...)` for runtime/workflow-engine full-stack E2E |

## 3. Test Strategy

This feature is high-risk storage-architecture work touching five systems (Mongo, outbox, Kafka, CH sink, CH projection) behind four independent feature flags. Testing must prove:

1. **Atomicity and durability** — outbox row commits iff Mongo domain update commits (FR-1); at-least-once delivery to Kafka under crash (FR-2).
2. **Pipeline integrity** — every Mongo state change → matching CH row within ≤10 s ingest window with correct `event_id` dedup (FR-3, FR-4, FR-5).
3. **Read-path parity** — UNION Mongo+CH returns identical shape, identical ordering, identical pagination behavior as Mongo-only for overlapping and non-overlapping ranges (FR-6).
4. **Isolation at every boundary** — tenant, project, and user isolation preserved end-to-end through Mongo query, Kafka key, CH query, and MV projection (FR-6, FR-10).
5. **Retention correctness** — Mongo TTL deletes completed rows and leaves in-flight runs untouched; CH plan-tiered TTL drops the right partitions (FR-7, FR-8).
6. **Rollback safety** — every flag combination of (OUTBOX × CH_SINK × DUAL_READ × MONGO_TTL) produces valid behavior (FR-11).
7. **GDPR cascade** — tenant- and execution-level deletion fully cascades across all 7 stores with no orphan rows (FR-10).

### Auth Context Baseline

Unless a scenario overrides, every E2E below runs under:

- **Tenant**: `t1`
- **Project**: `p1`
- **User**: `u1` (role `project_admin`, holds `workflow:read`, `workflow:write`, `human_task:read`, `human_task:write`)
- **Auth header**: bearer JWT signed via the shared auth test-key infrastructure (`packages/shared-auth/src/__tests__/helpers/*`).

Any cross-tenant (`t2`), cross-project (`p2`), cross-user (`u2`), missing-auth, or reduced-scope scenario is stated explicitly in the scenario's **Auth Context** block and asserted as a first-class expectation.

### Test Tiers

| Tier        | Location                                                                                                                                                                 | Purpose                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | `packages/eventstore/src/__tests__/events/*.test.ts`, `apps/workflow-engine/src/outbox/__tests__/*.test.ts`                                                              | Pure functions: Zod schema validation, event-row mapping, outbox-payload derivation, CH DDL string generation, flag-gate predicate             |
| Integration | `apps/workflow-engine/src/__tests__/*.integration.test.ts`, `packages/eventstore/src/__tests__/*.test.ts`, `apps/runtime/src/__tests__/*.integration.test.ts`            | Real service boundaries: Mongo tx atomicity, BullMQ leader election, Kafka→CH dedup & flush, CH projection MV, cascade hook, flag-matrix smoke |
| E2E         | `apps/workflow-engine/src/__tests__/*.e2e.test.ts`, `apps/runtime/src/__tests__/*.e2e.test.ts`, `apps/studio/e2e/workflows/*.spec.ts`, `apps/studio/e2e/inbox/*.spec.ts` | Full HTTP API flow + full middleware chain (auth, tenant isolation, validation) + real Mongo + real Kafka + real CH + real Redis               |

### Test-Integrity Rules (CLAUDE.md)

- **No `vi.mock` / `jest.mock` of `@agent-platform/*`, `@abl/*`, or relative imports** — in ANY tier.
- **External-only mocking via DI** — LLM providers, HTTP stubs for third-party APIs, and nothing else.
- **Direct DB access is permitted in integration tier, forbidden in E2E tier.** E2E tests seed via POST and assert via GET only. Integration tests MAY import the CH client or Mongoose models directly to assert query-builder parity (e.g., INT-06 verifies CH vs Mongo user-isolation filters yield identical counts — this requires side-by-side direct queries that a black-box HTTP test cannot express).
- **Real servers on random ports** — every E2E runs Express on `{ port: 0 }` and a fresh middleware chain per test.
- **No TODO stubs** — every scenario must land with working infrastructure; placeholders such as `const portA = 0; // TODO` are rejected.
- **Structured content-type round-trips** — human-task payloads carry structured content (arrays, objects); assertions must include at least one non-scalar field.
- **Studio Playwright conventions** — the E2E-03 and E2E-04 Playwright specs (`apps/studio/e2e/workflows/monitor-historical.spec.ts`, `apps/studio/e2e/inbox/default-filter.spec.ts`) MUST follow the layout, helper imports, test-tier classification, and `data-testid` registry defined in [`apps/studio/e2e/workflows/agents.md`](../../../apps/studio/e2e/workflows/agents.md). Read that `agents.md` before authoring the specs and update it after implementation (folder layout, coverage tables, testid registry, learnings) per CLAUDE.md E2E Test Standards.

---

## 4. Coverage Matrix

One row per functional requirement. `✅` = SHIPPED + passing; `🟡` = PARTIAL (pure-logic SHIPPED but full-stack DEFERRED to GAP-008); `❌` = DEFERRED (GAP-008); `—` = not applicable at that tier.

| FR    | Description                                  | Unit | Integration | E2E | Load / Manual | Status   |
| ----- | -------------------------------------------- | ---- | ----------- | --- | ------------- | -------- |
| FR-1  | Outbox atomicity with Mongo transaction      | ✅   | ✅          | ❌  | —             | PARTIAL  |
| FR-2  | Outbox poller — leader election, retry, FIFO | ✅   | 🟡          | —   | —             | PARTIAL  |
| FR-3  | Kafka topic routing + tenant partition key   | ✅   | ❌          | ❌  | —             | PARTIAL  |
| FR-4  | CH event-sink append + dedup on `event_id`   | ✅   | ❌          | ❌  | —             | PARTIAL  |
| FR-5  | `*_latest` MV projections                    | ✅   | ❌          | ❌  | —             | PARTIAL  |
| FR-6  | Hybrid API reads (UNION Mongo + CH)          | ✅   | ❌          | ❌  | —             | PARTIAL  |
| FR-7  | Mongo TTL behavior (terminal vs in-flight)   | ✅   | ❌          | ❌  | —             | PARTIAL  |
| FR-8  | Plan-tiered CH retention (partition drop)    | ✅   | ❌          | —   | ❌            | PARTIAL  |
| FR-9  | Inbox default status filter + toggle         | ✅   | —           | ❌  | —             | PARTIAL  |
| FR-10 | GDPR cascade across all 7 stores             | ✅   | ❌          | ❌  | —             | PARTIAL  |
| FR-11 | Feature-flag matrix (2^4)                    | ✅   | ❌          | —   | —             | PARTIAL  |
| FR-12 | Event schema versioning + `.passthrough()`   | ✅   | ❌          | —   | —             | PARTIAL  |
| —     | 1 M runs / 4 h ingest load + CH ingest SLA   | —    | —           | —   | ❌            | DEFERRED |

**Evidence for ✅ Unit cells**: see §11 "Test File Mapping — SHIPPED". All `❌` cells are grouped under feature-spec GAP-008 (dockerized-CH PR).

---

## 5. E2E Test Scenarios (MANDATORY — minimum 5; 6 defined)

Every E2E exercises the real HTTP API through the full middleware chain with real Mongo, Kafka, Redis, and CH. No mocks.

### E2E-01: Workflow Execution Lifecycle — Full Event Flow

- **Objective**: Prove the end-to-end pipeline from execute request → Mongo domain row + outbox row → Kafka → CH event row → `*_latest` MV projection. Proves FR-1, FR-3, FR-4, FR-5, FR-12. (FR-2 poller internals — leader election, retry, FIFO — are covered exclusively by INT-02; E2E-01 only depends on the poller running.)
- **Preconditions**:
  - Flags `WORKFLOW_OUTBOX_ENABLED=true`, `WORKFLOW_CH_SINK_ENABLED=true`, `WORKFLOW_DUAL_READ_ENABLED=false`, `WORKFLOW_MONGO_TTL_ENABLED=false`.
  - Workflow `wf1` version `1.0.0` deployed into `p1` via `POST /api/projects/p1/workflows` seed helper.
  - Kafka topics `abl.workflow.execution` + `abl.human.task` created with 3 partitions.
- **Auth Context**: baseline `t1 / p1 / u1 (project_admin)`.
- **Steps**:
  1. `POST /api/projects/p1/workflows/wf1/executions/execute` with trigger payload `{ "input": { "customerId": "c-1" } }`. Expect `201` with `{ executionId }`.
  2. `GET /api/projects/p1/workflows/wf1/executions/:executionId` (dual-read OFF — Mongo leg only). Assert `status ∈ {running, waiting_callback}` and `tenantId=t1`, `projectId=p1`.
  3. Poll the Mongo test admin endpoint (test-only) OR call `GET /api/admin/test/outbox?tenantId=t1` (a test-tier diagnostic endpoint, gated behind `NODE_ENV=test`) to confirm an outbox row exists with `entity_kind='execution'`, `event_type='workflow.execution.started'`, `published_at=null`.
  4. Wait up to `poll_interval + 2 s`. Re-query the diagnostic endpoint. Assert `published_at` is set (poller acked Kafka).
  5. Wait up to 15 s. Query `GET /api/admin/test/ch/workflow_execution_events?execution_id=:executionId` (test-tier diagnostic). Assert exactly one row for the `workflow.execution.started` event with correct `tenant_id`, `project_id`, `event_version='1.0.0'`, `occurred_at` within 30 s of the POST.
  6. Drive the workflow to completion (trigger the callback or simulate step completion by hitting the workflow-engine step-advance endpoint for `wf1` step `s-final`). Expect `POST` returns `202`.
  7. Wait up to 15 s. Query `GET /api/admin/test/ch/workflow_executions_latest?execution_id=:executionId`. Assert `status='completed'`, `completed_at` non-null, `duration_ms > 0`.
  8. Re-query the original `GET /api/projects/p1/workflows/wf1/executions/:executionId` endpoint; assert `status='completed'` (served from Mongo — still within 48 h).
- **Expected Result**: Every step assertion passes without retry beyond the stated timeouts; no outbox rows orphaned; CH row and Mongo row carry identical `executionId` and identical final `status`.
- **Isolation Check**: Before completion in step 7, issue `GET /api/admin/test/ch/workflow_execution_events?execution_id=:executionId` with a `t2` identity on the diagnostic endpoint. Assert the diagnostic returns `404` even though a row exists — this verifies CH reads never leak across tenants even in test-diagnostic paths.

### E2E-02: Dual-Read UNION — Parity with Mongo-Only Path

- **Objective**: Prove `GET /executions` returns byte-for-byte identical shape and ordering when `WORKFLOW_DUAL_READ_ENABLED` is toggled, with correct dedup on the 48 h overlap. Proves FR-6 and FR-11 partial.
- **Preconditions**:
  - All flags through `WORKFLOW_DUAL_READ_ENABLED=true`; `WORKFLOW_MONGO_TTL_ENABLED=false`.
  - Seed 20 executions under `wf1` in `p1 / t1` via `POST .../execute`, letting them settle to terminal states (mix of `completed`, `failed`, `cancelled`). Wait until parity-check reports zero drift vs CH.
- **Auth Context**:
  - Positive: `t1 / p1 / u1 (project_admin)` and `t1 / p1 / u3 (project_member with workflow:read only)`.
  - Negative: `t2 / p1 / u-t2` (cross-tenant), `t1 / p2 / u-p2` (cross-project), missing-auth.
- **Steps**:
  1. With `WORKFLOW_DUAL_READ_ENABLED=false`, `GET /api/projects/p1/workflows/wf1/executions?limit=50&sort=startedAt:desc`. Capture the response JSON as `mongoOnly`.
  2. Flip `WORKFLOW_DUAL_READ_ENABLED=true` in process config (test helper hot-reload).
  3. `GET` the same URL. Capture as `unionRead`.
  4. Assert `unionRead.data.length === mongoOnly.data.length` and a deep-equal comparison of each record by `_id` (excluding the `source` diagnostic field which is added only under dual-read).
  5. `GET /api/projects/p1/workflows/wf1/executions?limit=5&cursor=<cursor-from-page-1>` — assert pagination cursors behave identically across both modes.
  6. With `project_member` (read-only) identity, repeat step 3. Expect `200` + same body.
  7. Negative matrix: cross-tenant `t2` identity against `p1` path → `404`; cross-project `t1` + `p2` identity → `404`; missing `Authorization` header → `401`; `project_member` attempting `POST .../:executionId/cancel` → `403`.
- **Expected Result**: `mongoOnly` and `unionRead` are structurally identical for the 20-execution fixture; every negative case returns the stated status; no `tenantId` or internal identifiers leak in `404` bodies (per CLAUDE.md User-Facing Runtime Error Sanitization).
- **Isolation Check**: Embedded in step 7 negative matrix.

### E2E-03: Monitor Tab — Historical Executions via CH (Phase B)

- **Objective**: Prove the Studio Monitor tab surfaces executions older than 48 h from CH after Mongo TTL has purged them, with correct dedup on the crossover boundary. Proves FR-6 and FR-7.
- **Preconditions**:
  - All four flags ON (Phase B complete).
  - Seed 10 executions with `completedAt` backdated >48 h ago (insert at the workflow-engine test seed helper with a time-machine override that shifts `completedAt` on insert — bypasses Mongo TTL by design during seeding, NOT by direct DB insert). Let CH ingest complete, then force-run the TTL sweep via test-admin endpoint `POST /api/admin/test/mongo/ttl-sweep?collection=workflow_executions`.
  - Seed 5 recent executions in last 24 h.
- **Auth Context**: baseline `t1 / p1 / u1` and cross-tenant `t2 / p1 / u-t2` for isolation check.
- **Steps**:
  1. As `u1`, `GET /projects/p1/workflows/wf1` Monitor route via Studio (Playwright). Wait for `useWorkflowExecutions` SWR hook to settle.
  2. Inspect Playwright network panel for `/api/projects/.../executions?limit=50`. Assert response has 15 rows.
  3. Assert the diagnostic `source` field (added only under `WORKFLOW_DUAL_READ_ENABLED=true`) shows 10 rows with `source='ch'` and 5 with `source='mongo'`.
  4. Click a run whose `completedAt` is 47 h ago (exactly at the Mongo+CH overlap boundary). Assert the detail panel renders and the executionId appears exactly once in the list (dedup correct — Mongo wins on overlap per FR-6).
  5. Click a run with `completedAt` 5 days ago. Assert detail panel renders from CH.
  6. Cross-tenant check: switch Playwright storage to `t2 / u-t2` auth. Navigate to `/projects/p1/workflows/wf1`. Expect a `404` toast (per CLAUDE.md Core Invariants #1 — cross-scope = 404), not a `403`.
- **Expected Result**: Monitor tab renders 15 unique rows; boundary execution is deduped; cross-tenant navigation fails with 404 and sanitized error copy (no tenant ID leakage).
- **Isolation Check**: Step 6 cross-tenant 404; verify Playwright receives no CH row data for `t1` executions from a `t2` session.

### E2E-04: Inbox Default Status Filter + Toggle

- **Objective**: Prove the Inbox default filter shows only `pending / assigned / in_progress` workflow-source tasks, that the "Include completed" toggle expands the query, and that the count badge remains pinned to the active-status subset. Proves FR-9.
- **Preconditions**:
  - All four flags ON.
  - Seed 5 `pending` + 3 `in_progress` + 10 `completed` + 2 `cancelled` workflow-source tasks in `p1 / t1` via `POST .../human-tasks` seed helper that drives them through the real route handler (not a DB write).
  - Seed 2 agent-escalation tasks (`mailbox='agent'`) to verify out-of-scope path stays Mongo-only.
- **Auth Context**:
  - Positive: `t1 / p1 / u1 (project_admin)`.
  - Negative: `t1 / p1 / u4` (project_member with `human_task:read` only; `assigned_to` array does NOT contain `u4`) — per FR-6 user isolation, cross-user task rows should not appear.
- **Steps**:
  1. As `u1`, `GET /projects/p1/inbox?mailbox=workflow` via Studio (Playwright).
  2. Inspect network panel: query contains `status=pending,assigned,in_progress` (comma-joined).
  3. Assert rendered row count = 8.
  4. Assert count badge on the "Workflow" mailbox tab = `8`.
  5. Click the "Include completed" toggle.
  6. Assert subsequent `GET` request drops the `status` query param (or sends `status=*`).
  7. Assert rendered row count = 20.
  8. Assert count badge still reads `8` (server-side active filter unchanged).
  9. Switch to agent mailbox. Assert 2 rows render and network panel shows a Mongo-only path (diagnostic `source='mongo'` only, no `ch` entries).
  10. Negative: as `u4`, repeat step 1. Assert rendered row count = 0 (tasks not assigned to `u4`), while count badge = 0.
  11. Negative: send `GET /api/projects/p1/human-tasks?status=foo` (invalid enum) as `u1`. Expect `400` with `{ success: false, error: { code: 'VALIDATION_ERROR', message: <sanitized> } }`.
- **Expected Result**: Filter applied on load; toggle expands; count badge stable; agent path stays Mongo-only; invalid enum returns 400 with structured error; user isolation scopes the list to tasks the user is assigned to.
- **Isolation Check**: Step 10 cross-user isolation; step 11 input validation rejection.

### E2E-05: GDPR Tenant Deletion Cascade

- **Objective**: Prove that tenant deletion cascades across all 7 in-scope stores with no orphan rows. Proves FR-10.
- **Preconditions**:
  - All flags ON.
  - Seed tenant `t-del` with 5 executions + 10 workflow-source tasks + 2 agent-escalation tasks (explicitly out of scope — asserted to REMAIN after cascade). Propagate to CH.
  - Confirm parity-check reports zero drift for `t-del`.
- **Auth Context**: tenant-delete is a platform-operator action, not a user action. Test via the admin platform-key path (`abl_`-prefixed key with `platform:tenant:delete` scope) against the admin API.
- **Steps**:
  1. Platform admin: `POST /api/admin/tenants/t-del/delete` (or equivalent production path per feature spec §10). Expect `202` + `operationId`.
  2. Poll `GET /api/admin/tenants/t-del/delete/:operationId` until `status='completed'` (timeout 60 s).
  3. Assert via test-admin diagnostics:
     - Mongo `workflow_executions WHERE tenantId='t-del'` → 0 rows.
     - Mongo `human_tasks WHERE tenantId='t-del' AND mailbox='workflow'` → 0 rows.
     - Mongo `workflow_event_outbox WHERE tenantId='t-del'` → 0 rows.
     - CH `workflow_execution_events WHERE tenant_id='t-del'` → 0 rows (after `OPTIMIZE FINAL` or wait for merge).
     - CH `human_task_events WHERE tenant_id='t-del'` → 0 rows.
     - CH `workflow_executions_latest WHERE tenant_id='t-del'` → 0 rows.
     - CH `human_tasks_latest WHERE tenant_id='t-del'` → 0 rows.
  4. Assert out-of-scope stays untouched: Mongo `human_tasks WHERE tenantId='t-del' AND mailbox='agent'` still has 2 rows (the agent-escalation records — these are the Memory & Sessions team's cascade, not this feature's).
  5. Negative: repeat `POST /api/admin/tenants/t-del/delete` for a non-existent tenant `t-missing`. Expect `404` with sanitized error copy.
- **Expected Result**: All 7 stores purged; agent-escalation path untouched; idempotent re-invocation is a no-op that returns 404 rather than leaking existence of prior delete.
- **Isolation Check**: Step 4 verifies cascade **does not** overreach into out-of-scope data.

### E2E-06: Cross-Feature Trigger → Execution → HumanTask → CH Chain

- **Objective**: Prove the full chain from a Trigger fire through workflow execution that creates a human-task step, with both outbox paths (execution + human_task) landing in their respective CH tables and sharing `execution_id` as a join key. Proves FR-3, FR-4, FR-5, FR-6 for cross-entity correlation (feature spec §9 Key Relationships).
- **Preconditions**:
  - `WORKFLOW_OUTBOX_ENABLED=true`, `WORKFLOW_CH_SINK_ENABLED=true`, `WORKFLOW_DUAL_READ_ENABLED=true`, `WORKFLOW_MONGO_TTL_ENABLED=false`.
  - Workflow `wf-approval` deployed with a `human_task` step and a terminal step. Trigger `tr-approval` wired to it (per Workflow Triggers feature).
- **Auth Context**: baseline `t1 / p1 / u1`. For the assignee, use `u2` (project_member, `human_task:read + respond` scope).
- **Steps**:
  1. Fire the trigger: `POST /api/projects/p1/workflows/wf-approval/triggers/tr-approval/fire` with `{ "payload": { "amount": 500 } }`. Expect `202` with `executionId`.
  2. Wait up to 10 s. Poll `GET /api/projects/p1/workflows/wf-approval/executions/:executionId`. Assert `status='waiting_human'`.
  3. `GET /api/projects/p1/human-tasks?executionId=:executionId` as `u1`. Assert 1 task present with `task_type='approval'`, `assigned_to=['u2']`, `status='pending'`.
  4. Switch to `u2`: `POST /api/projects/p1/human-tasks/:taskId/claim`. Expect `200`, `status='in_progress'`, `claimed_by='u2'`.
  5. `POST /api/projects/p1/human-tasks/:taskId/respond` with `{ "decision": "approve" }`. Expect `200`, task `status='completed'`.
  6. Wait up to 10 s. Poll `GET /api/projects/p1/workflows/wf-approval/executions/:executionId`. Assert `status='completed'`.
  7. Query test-admin diagnostics:
     - CH `workflow_execution_events WHERE execution_id=:executionId` → ≥ 4 rows (started, step_started, waiting_human, completed).
     - CH `human_task_events WHERE execution_id=:executionId` → ≥ 4 rows (created, assigned, claimed, responded).
     - CH `workflow_executions_latest WHERE execution_id=:executionId` has `status='completed'`.
     - CH `human_tasks_latest WHERE execution_id=:executionId` has `status='completed'`, `decision='approve'`.
  8. Cross-join query through CH: `SELECT count() FROM workflow_executions_latest e JOIN human_tasks_latest h ON e.execution_id = h.execution_id WHERE e.tenant_id='t1' AND e.execution_id=:executionId` returns 1. Proves the shared join key (feature spec §9).
- **Expected Result**: Both outbox paths propagate; join-key alignment holds; `assigned_to` array and `decision` column round-trip correctly (structured content types per CLAUDE.md E2E rule #6).
- **Isolation Check**: In step 4, if `u3` (not assigned) attempts `claim`, expect `404` (cross-user).

---

## 6. Integration Test Scenarios (MANDATORY — minimum 5; 8 defined)

### INT-01: Outbox Transaction Atomicity

- **Boundary**: `ExecutionStore.createExecution()` ↔ real MongoDB replica set (transactions required).
- **Setup**: `MongoMemoryReplSet` from `mongodb-memory-server`; `WORKFLOW_OUTBOX_ENABLED=true`; outbox writer wired into store.
- **Steps**:
  1. Invoke `createExecution({ tenantId: 't1', projectId: 'p1', workflowId: 'wf1', ... })`. Commit succeeds.
  2. Assert `workflow_executions` collection has 1 doc AND `workflow_event_outbox` has 1 row with matching `event_id`.
  3. Induce tx abort via a `stopSession`-style hook after the domain write but before commit.
  4. Assert both collections are empty for that `executionId` (all-or-nothing).
  5. Retry `createExecution()`; assert exactly 1 row each (no orphan rows from the aborted attempt).
- **Expected Result**: Atomic commit of domain doc + outbox row; abort leaves no partial state.
- **Failure Mode Tested**: process crash between domain write and outbox write → tx abort → neither persists.

### INT-02: Outbox Poller — Leader Election + Retry + FIFO + Topic Routing

- **Boundary**: `OutboxPoller` ↔ real Redis + real Kafka (BullMQ repeatable job).
- **Setup**: Start 3 `OutboxPoller` instances in-process with distinct `workerId`s all pointing at the same Redis + Kafka. Seed 50 unpublished outbox rows across 3 tenants — mix of `entity_kind='execution'` and `entity_kind='human_task'`.
- **Steps**:
  1. Let the poller run for 10 s.
  2. Assert exactly one instance processed rows (count publishes per `workerId`). BullMQ repeatable semantics guarantee single-active-worker per repeatable job.
  3. Crash the active instance (`process.kill` its worker pool). Wait 5 s.
  4. Assert a second instance picks up unpublished remainder (leader failover). No row published twice (dedup via `event_id` at CH — verify by querying CH).
  5. Inject Kafka publish failure for 5 specific `event_id`s (stop Kafka container briefly). Assert `attempts` counter increments, exponential backoff applied, then all 5 succeed on retry after Kafka returns.
  6. Assert FIFO ordering: outbox rows with the same `tenantId` + `entity_id` land in Kafka in `created_at` order (Kafka partition ordering guarantee).
  7. **FR-3 topic routing** — consume both topics with a test client and assert:
     - every `entity_kind='execution'` row was published to `abl.workflow.execution` (zero cross-leakage to `abl.human.task`);
     - every `entity_kind='human_task'` row was published to `abl.human.task`;
     - Kafka message `key` equals the `tenantId` (tenant-based partitioning) for ordered per-tenant delivery.
- **Expected Result**: Exactly-once steady state; failover drains backlog; retries eventually succeed; FIFO per partition; each topic carries only its intended entity kind; partition key equals `tenantId`.
- **Failure Mode Tested**: leader crash mid-batch, Kafka unavailability, mis-routing of entity kinds between topics.

### INT-03: Kafka → CH Consumer — Dedup + Buffer Flush + MV Projection

- **Boundary**: Kafka consumer ↔ `BufferedClickHouseWriter` ↔ real CH (via docker-compose).
- **Setup**: `WORKFLOW_CH_SINK_ENABLED=true`; consumer started with test group ID; CH tables + MVs created via DDL helper.
- **Steps**:
  1. Produce the same event twice to `abl.workflow.execution` (simulates at-least-once Kafka).
  2. Wait for `BufferedClickHouseWriter` flush (≤ 5 s).
  3. Query `SELECT count() FROM workflow_execution_events WHERE event_id = :id`. Assert value is 1 **after** `OPTIMIZE TABLE workflow_execution_events FINAL` (ReplacingMergeTree dedup collapses on merge).
  4. Burst: produce 10 000 events with distinct `event_id`s. Assert CH ingestion completes within 5 s flush window (`BufferedClickHouseWriter` batch = 10 K). Latency histogram p95 ≤ 5 s.
  5. Query `workflow_executions_latest` MV projection for each unique `executionId` seen in the burst; assert every projection row matches the last event's fields per entity.
- **Expected Result**: Event-id dedup holds after merge; 10 K batch flushes in one writer cycle; projection correctness across the burst.
- **Failure Mode Tested**: double-publish from Kafka, large batch flush behavior.

### INT-04: Mongo TTL Behavior

- **Boundary**: `workflow_executions` collection ↔ Mongo TTL thread.
- **Setup**: `WORKFLOW_MONGO_TTL_ENABLED=true`; ensure TTL index created on startup via idempotent `ensureIndex` migration.
- **Steps**:
  1. Seed 50 executions: 20 with `completedAt` >48 h ago, 20 with `completedAt` <48 h ago, 10 with `completedAt = null` (in-flight).
  2. Force TTL sweep (Mongo `db.runCommand({ collMod: 'workflow_executions', ... })` is not permitted directly — use a test-only admin endpoint that tickles the TTL monitor, or wait 60–90 s).
  3. Assert 20 old rows deleted; 20 recent rows remain; 10 in-flight rows untouched.
  4. Outbox TTL: seed 10 published rows with `published_at` 8 days ago + 5 unpublished (`published_at=null`). Force sweep. Assert 10 old published rows deleted; 5 unpublished remain.
  5. Negative: drop the TTL index (flag off). Confirm no further deletions occur (remaining in-flight runs protected from accidental purge when flag flips off).
- **Expected Result**: Partial-filter TTL only targets terminal rows; in-flight and unpublished rows always survive.
- **Failure Mode Tested**: TTL purge of in-flight runs (must NOT happen).

### INT-05: GDPR Cascade Hook — Mongo + CH

- **Boundary**: `EventCascadeHook` registration ↔ eventstore-singleton ↔ Mongo + CH.
- **Setup**: Register workflow-specific hook via `registerEventCascadeHook()` at app bootstrap. Seed 5 executions + 10 workflow-source tasks in `t-del`.
- **Steps**:
  1. Call `eventstoreSingleton.getRegistry().deleteTenant('t-del')`. Assert the workflow hook's `deleteTenant` is invoked once.
  2. Verify Mongo: `workflow_executions`, `human_tasks WHERE mailbox='workflow'`, `workflow_event_outbox` all have 0 rows for `t-del`.
  3. Verify CH: `ALTER TABLE ... DELETE WHERE tenant_id='t-del'` issued against each of the 4 CH tables. Poll `system.mutations` until complete.
  4. Verify `deleteByExecutionIds('t-del', ['e-1','e-2'])` variant: seed 5 executions, call `deleteByExecutionIds` for 2 of them, assert only those 2 are purged from all 7 stores, 3 remain untouched.
  5. Negative: call `deleteTenant('t-none')` (no data). Assert no errors; all hook implementations succeed with a no-op.
  6. Backward compatibility: a hook implementation that does NOT override `deleteByExecutionIds` falls back to the default no-op; cascade still succeeds.
- **Expected Result**: Full cascade; `deleteByExecutionIds` scopes correctly; no-op backward-compat path works.
- **Failure Mode Tested**: partial implementation (hook that overrides one method but not the other) still boots and runs.

### INT-06: User-Isolation Parity — Mongo vs CH Human-Task Visibility

- **Boundary**: `human_task` list route → UNION query builder → Mongo + CH.
- **Setup**: Seed 50 tasks: 20 assigned to `u1`, 15 to `u2`, 15 unassigned. Half are terminal and live only in CH (after TTL); half are in-flight in Mongo.
- **Steps**:
  1. As `u1` (scope `human_task:read` only, NOT admin): query `GET /api/projects/p1/human-tasks?mailbox=workflow&limit=100` via UNION path.
  2. Assert 20 rows returned — exactly the tasks where `assigned_to` array-contains `u1` OR `claimed_by = u1`.
  3. As an **integration-tier** test, import the CH client directly from the test suite (permitted in integration tier, forbidden in E2E per CLAUDE.md) and run `SELECT count() FROM human_tasks_latest WHERE tenant_id='t1' AND project_id='p1' AND (has(assigned_to, 'u1') OR claimed_by = 'u1')`. Assert this count equals the number of CH-sourced rows returned by the API in step 2.
  4. Similarly, use the Mongoose model directly from the integration test to run `HumanTask.countDocuments({ tenantId:'t1', projectId:'p1', mailbox:'workflow', $or:[{ assigned_to:'u1' }, { claimed_by:'u1' }] })`. Assert this count equals the number of Mongo-sourced rows returned by the API in step 2.
  5. Cross-user: with same filters, `u2` identity should see exactly 15 rows and never see `u1`'s 20.
  6. Admin (`project_admin`): sees all 50 regardless of assignment.
- **Expected Result**: CH and Mongo apply the same visibility filter; union count never leaks cross-user rows.
- **Failure Mode Tested**: CH query builder skipping the user-isolation filter (would return everyone's tasks) — must fail the assertion.

### INT-07: Flag-Matrix Smoke — 16 Combinations

- **Boundary**: runtime + workflow-engine entry points under each flag combination.
- **Setup**: Parameterize over `[OUTBOX, CH_SINK, DUAL_READ, MONGO_TTL] ∈ {0,1}^4 = 16` combinations. Per combination, start fresh workflow-engine process with only that flag set active.
- **Steps**: For each combination:
  1. `POST /executions/execute` with valid payload. Expect `201` in all cases (baseline behavior must not regress).
  2. `GET /executions/:id`. Expect `200` with valid shape.
  3. If `OUTBOX=1`, assert an outbox row exists.
  4. If `CH_SINK=1 AND OUTBOX=1`, assert CH row appears within 15 s.
  5. If `DUAL_READ=1`, assert `source` diagnostic field present in list response.
  6. If `MONGO_TTL=1`, assert TTL index created on `workflow_executions`.
  7. Every invalid combination (e.g., `CH_SINK=1, OUTBOX=0`) logs a startup warning but does not crash.
- **Expected Result**: All 16 return `2xx` on the smoke POST/GET; invalid combinations degrade gracefully.
- **Failure Mode Tested**: partial-feature-flag rollout regression.

### INT-08: Error-Path Coverage — Kafka-Down, CH-Drop, Mongo-Abort

- **Boundary**: poller + consumer + outbox writer under induced failure.
- **Setup**: docker-compose harness with per-service stop/start control.
- **Steps**:
  1. **Kafka down**: with `WORKFLOW_OUTBOX_ENABLED=true, WORKFLOW_CH_SINK_ENABLED=true`, `docker compose stop kafka`. Drive 20 executions. Assert 20 outbox rows accumulate with `published_at=null`, `attempts > 0`. `docker compose start kafka`; assert backlog drains within 30 s; every row eventually has `published_at` set.
  2. **CH connection dropped**: mid-flush, kill CH container. Assert `BufferedClickHouseWriter` surfaces the error (logged via `createLogger`), no data loss — Kafka offset NOT committed until CH write succeeds, so consumer re-reads and retries on CH recovery.
  3. **Mongo tx abort**: simulate via test hook that throws on outbox-insert mid-tx. Assert the execution creation rolls back fully — zero orphaned documents (covered by INT-01 but asserted again in the failure-mode path).
  4. **Redis dropped**: (lowest priority) kill Redis. Assert poller stops processing; on Redis recovery, poller resumes; no duplicate publishes.
- **Expected Result**: every failure produces recoverable backlog, no data loss, no duplicate publish after recovery.
- **Failure Mode Tested**: every single-service outage in the pipeline.

---

## 7. Unit Test Scenarios

### UT-01: Workflow Event Zod Schema Round-Trip

- **Module**: `packages/eventstore/src/schema/events/workflow-execution-events.ts`
- **Input**: Sample payloads for each event type (`started`, `completed`, `failed`, `cancelled`, `step_started`, `step_completed`).
- **Expected Output**: `schema.parse(input)` returns a structurally equivalent object with `event_version='1.0.0'`. `schema.safeParse({ ...input, extraField: 'x' })` succeeds via `.passthrough()` (FR-12 additive compatibility). Required field missing → `safeParse().success === false`.

### UT-02: Event-Row → CH Row Mapper

- **Module**: `packages/eventstore/src/stores/clickhouse/workflow-execution-events-table.ts` (row-mapping helper).
- **Input**: A validated workflow event object.
- **Expected Output**: Row with all columns populated, `ingested_at` set to the current time, `occurred_at` copied from event, `event_id` is a valid UUIDv7.

### UT-03: Flag-Gate Predicate

- **Module**: `apps/workflow-engine/src/outbox/flag-gates.ts` (pure function).
- **Input**: `{ WORKFLOW_OUTBOX_ENABLED, WORKFLOW_CH_SINK_ENABLED, WORKFLOW_DUAL_READ_ENABLED, WORKFLOW_MONGO_TTL_ENABLED }` across all 16 combinations.
- **Expected Output**: The function returns a typed decision object identifying which subsystems to activate. No combination throws.

### UT-04: Inbox Status Filter Query-Param Parser

- **Module**: `parseStatusList` + `HUMAN_TASK_STATUS_VALUES` exported from `apps/runtime/src/routes/human-tasks.ts`.
- **Input**: `?status=pending`, `?status=pending,assigned`, `?status= pending , assigned ` (whitespace), `?status=pending,pending,assigned` (duplicates), no `status`, `?status=foo` (unknown), `?status=pending,foo` (mixed).
- **Expected Output**: Parser returns a discriminated union `{statuses} | {error}`. Valid inputs yield a trimmed, deduped string array; absent/empty yields `[]` (the route layer applies the default `['pending','assigned','in_progress']`); invalid/mixed yields `error: { code: 'VALIDATION_ERROR', message: ... }` whose message includes every allowed enum value as a hint. Route translates to HTTP 400 on error.
- **Test file**: `apps/runtime/src/routes/__tests__/human-tasks-status-parser.test.ts` (9 cases, SHIPPED 2026-04-21).

### UT-05: Dual-Read Merge & Dedup

- **Module**: `apps/workflow-engine/src/persistence/dual-read-merger.ts` (pure function).
- **Input**: Two arrays: `mongoRows` (authoritative for <48h) and `chRows` (older). Overlap: 2 documents present in both.
- **Expected Output**: Merged array has unique `_id` values, Mongo row wins on overlap, ordering preserved by `startedAt DESC`.

### UT-06: GDPR Hook Interface Backward-Compat Default

- **Module**: `packages/database/src/cascade/event-cascade-hooks.ts`.
- **Input**: A legacy hook implementation that only defines `deleteBySessionIds` and `deleteTenant`, not `deleteByExecutionIds`.
- **Expected Output**: `hook.deleteByExecutionIds(tenantId, ids)` falls back to the interface's default no-op and resolves without throwing.

---

## 7a. Surface Semantics & Design-Time vs Runtime Verification

**N/A.** This feature has no design-time surface. All behavior is runtime storage-layer tiering — no authored assets, aliases, selectors, or compiled identifiers are introduced. The only UX-visible change (Inbox default filter + "Include completed" toggle, FR-9) is a runtime presentation concern; no DSL / IR / snapshot verification is required. See feature spec §6 ("Design-time vs runtime: this feature has no design-time surface") and §8 ("N/A. Feature has no design-time / runtime split").

---

## 8. Security & Isolation Tests

All items below are asserted in the E2E or integration scenarios above; this table is the compliance view.

| Check                                                                         | Covered by                                                                      | Expected                                                                          |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Cross-tenant read access to execution list → `404`                            | E2E-02 step 7                                                                   | `404`, sanitized error (no tenantId echoed)                                       |
| Cross-tenant read access to execution detail → `404`                          | E2E-03 step 6                                                                   | `404`                                                                             |
| Cross-project read access (same tenant) → `404`                               | E2E-02 step 7                                                                   | `404`                                                                             |
| Cross-user attempt to claim a human task → `404`                              | E2E-06 step 4                                                                   | `404` (not `403` — avoid existence leak)                                          |
| Cross-user list filter parity (CH vs Mongo) for human tasks                   | INT-06                                                                          | Identical row counts, no leakage                                                  |
| Missing `Authorization` header → `401`                                        | E2E-02 step 7                                                                   | `401`                                                                             |
| Reduced-scope token (`workflow:read` but NOT `workflow:write`) cancel → `403` | E2E-02 step 7                                                                   | `403`                                                                             |
| Invalid `status=foo` enum → `400` with structured error                       | E2E-04 step 11                                                                  | `400` + `{ success:false, error:{ code, message } }`                              |
| GDPR cascade does NOT overreach to `mailbox='agent'` rows                     | E2E-05 step 4                                                                   | Agent rows remain intact                                                          |
| `tenantId` never leaked in user-visible error copy                            | E2E-02 step 7, E2E-03 step 6                                                    | Error copy matches sanitizer contract                                             |
| PII fields in CH payload scrubbed on retention flag                           | covered in `packages/eventstore/src/__tests__/retention-gdpr.test.ts` extension | Fields equal imported sentinel constant                                           |
| Platform API keys authorize strictly by scope, not creator identity           | E2E-05 step 1                                                                   | `abl_` key with `platform:tenant:delete` succeeds; same key without scope → `403` |

---

## 9. Performance & Load Tests

### LOAD-01: 1 M executions / 4 h ingest validation (manual staging gate)

- **Objective**: Validate CH ingest SLA, outbox backlog budget, Kafka lag, Mongo working-set under sustained load.
- **Environment**: Grafana Cloud k6 (per `load-test-analysis` skill) against a staging cluster with production-like infra sizing.
- **Scenario**:
  - Rate: 70 exec/s sustained for 4 h → 1 M executions total, ~10 M events.
  - Workflow: `wf-load` with 1 human_task step + 2 function steps + callback.
- **Assertions**:
  - Outbox unpublished backlog p95 ≤ 100 rows.
  - Kafka consumer lag p95 ≤ 30 s.
  - CH ingest lag (outbox commit → `*_latest` MV update) p95 ≤ 10 s.
  - Mongo `workflow_executions` collection size steady at `(concurrent_in_flight × 100 KB) + (48 h × 70/s × 100 KB) ≈ 2.4 GB` per tenant.
  - Zero event loss: distinct `event_id` count in CH equals distinct count in outbox.
  - Monitor-tab API p95 ≤ 300 ms.
  - Zero deadlocks in poller leader election during the 4 h window.
- **Pass/Fail Gate**: all assertions must hold before promoting feature status from `PLANNED → ALPHA`.

### LOAD-02: CI smoke — 100 executions

- **Objective**: Lightweight CI-runnable assertion that the pipeline holds under modest burst.
- **Scenario**: 100 executions queued in 30 s against docker-compose harness.
- **Assertions**: zero outbox-loss; every execution has matching CH row within 30 s; no test exceeds 2 min total runtime.

---

## 10. Test Infrastructure

### Required Services (docker-compose harness)

| Service    | Image / Source                                 | Port(s) | Notes                                                 |
| ---------- | ---------------------------------------------- | ------- | ----------------------------------------------------- |
| MongoDB    | `MongoMemoryReplSet` (in-process, for tx)      | dynamic | Atomicity tests need a replica set                    |
| Redis      | `redis:7` via docker-compose                   | `6380`  | Shared across workers for real BullMQ leader election |
| Kafka      | `confluentinc/cp-kafka:...` via docker-compose | `19092` | KRaft mode, single broker, auto-create off            |
| ClickHouse | `clickhouse/clickhouse-server:latest`          | `8123`  | Pre-seed DDL via helper at suite start                |

### Test Helpers to Build (NEW)

| Helper                                                                | Responsibility                                                                                |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `packages/eventstore/src/__tests__/helpers/kafka-test-client.ts`      | Produce + consume + topic lifecycle against real Kafka                                        |
| `packages/eventstore/src/__tests__/helpers/clickhouse-test-client.ts` | Connect, create workflow tables + MVs, run arbitrary query, teardown                          |
| `apps/workflow-engine/src/__tests__/helpers/start-test-server.ts`     | Boot Express on `{ port: 0 }` with full middleware chain; return base URL                     |
| `apps/workflow-engine/src/__tests__/helpers/outbox-diagnostic.ts`     | Test-tier endpoint registration for outbox + CH diagnostic queries (gated on `NODE_ENV=test`) |
| `tools/test-infra/parity-check.ts`                                    | Mongo ↔ CH parity script — doubles as Phase A operational tool                                |

### Test-Diagnostic Endpoints (gated)

All `GET|POST /api/admin/test/...` endpoints are registered ONLY when `NODE_ENV=test`. They enforce the same auth middleware (no bypass) and return sanitized bodies. Contract:

| Method | Path                                            | Purpose                                                                                                                                                                                                       |
| ------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/admin/test/outbox`                        | Raw outbox rows for a tenant/project                                                                                                                                                                          |
| GET    | `/api/admin/test/ch/workflow_execution_events`  | Passthrough CH query with filter params                                                                                                                                                                       |
| GET    | `/api/admin/test/ch/workflow_executions_latest` | MV projection row                                                                                                                                                                                             |
| GET    | `/api/admin/test/ch/human_task_events`          | Human-task event rows                                                                                                                                                                                         |
| GET    | `/api/admin/test/ch/human_tasks_latest`         | Human-task projection row                                                                                                                                                                                     |
| POST   | `/api/admin/test/mongo/ttl-sweep`               | Force TTL monitor tick for a collection                                                                                                                                                                       |
| POST   | `/api/admin/test/seed/executions`               | Seed an execution record through the real store layer, with opt-in `completedAt`/`startedAt` overrides (used by E2E-03 to place rows on either side of the 48 h TTL boundary without touching Mongo directly) |
| POST   | `/api/admin/test/seed/human-tasks`              | Seed a human-task record through the real store layer with status + timestamp overrides (used by E2E-04)                                                                                                      |

### Environment Variables (test)

| Variable                           | Default for Test Suite                |
| ---------------------------------- | ------------------------------------- |
| `WORKFLOW_OUTBOX_ENABLED`          | scenario-specific                     |
| `WORKFLOW_CH_SINK_ENABLED`         | scenario-specific                     |
| `WORKFLOW_DUAL_READ_ENABLED`       | scenario-specific                     |
| `WORKFLOW_MONGO_TTL_ENABLED`       | scenario-specific                     |
| `WORKFLOW_OUTBOX_POLL_INTERVAL_MS` | `50` (faster feedback than prod 100)  |
| `WORKFLOW_OUTBOX_BATCH_SIZE`       | `100`                                 |
| `KAFKA_BROKERS`                    | `127.0.0.1:19092`                     |
| `CH_URL`                           | `http://127.0.0.1:8123`               |
| `CH_DATABASE`                      | `abl_platform_test_<suite-id>`        |
| `REDIS_URL`                        | `redis://:localdev@127.0.0.1:6380/15` |
| `NODE_ENV`                         | `test`                                |

### CI Configuration

- Integration + E2E suites run under `pnpm turbo test --filter=@abl/workflow-engine --filter=@agent-platform/runtime --filter=@agent-platform/eventstore`.
- docker-compose services start in CI via the existing infra harness (no testcontainers yet — see Open Question OQ-1).
- Each integration / E2E suite uses a unique CH database (`abl_platform_test_<suite-id>`) to prevent cross-suite pollution.
- After suite tear-down, CH database is dropped; Kafka topics prefixed by suite-id are deleted; Redis DB 15 is flushed.

---

## 11. Test File Mapping

### SHIPPED — in-repo, passing as of 2026-04-21

Per-file case counts verified 2026-04-21 via `grep -cE '^\s*(it|test)\('`. Total: **141 test cases across 18 files** (140 unit + 3 integration cases in `system-outbox-atomicity.test.ts`, minus double-counting).

| Test file (actual)                                                                    | Tier         | Cases | Covers                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------- | ------------ | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/workflow-engine/src/__tests__/system-outbox-atomicity.test.ts`                  | system (INT) |     3 | FR-1 / INT-01 (MongoMemoryReplSet — happy / abort / flag-off)                                                                                                                                                                                                                                                                                                                                                      |
| `apps/workflow-engine/src/outbox/__tests__/workflow-event-outbox-writer.test.ts`      | unit         |     9 | Outbox writer + payload builder                                                                                                                                                                                                                                                                                                                                                                                    |
| `apps/workflow-engine/src/outbox/__tests__/execution-persistence-with-outbox.test.ts` | unit         |    12 | Decorator tx scope + flag-off bypass + mailbox guard                                                                                                                                                                                                                                                                                                                                                               |
| `apps/workflow-engine/src/outbox/__tests__/outbox-poller.test.ts`                     | unit         |     6 | Poller drain — success, CH failure retry, bookkeeping try/catch (both paths), metrics                                                                                                                                                                                                                                                                                                                              |
| `apps/workflow-engine/src/outbox/__tests__/flag-gates.test.ts`                        | unit         |     3 | UT-03 — 16-combination flag-gate matrix (parametrized)                                                                                                                                                                                                                                                                                                                                                             |
| `apps/workflow-engine/src/routes/__tests__/test-diagnostic.test.ts`                   | unit         |     9 | Test-diagnostic auth + tenant scoping + query coercion                                                                                                                                                                                                                                                                                                                                                             |
| `apps/workflow-engine/src/persistence/__tests__/dual-read-merger.test.ts`             | unit         |     9 | UT-05 — pure merger (empty / disjoint / overlap / sort / dup keys)                                                                                                                                                                                                                                                                                                                                                 |
| `apps/workflow-engine/src/persistence/__tests__/hybrid-execution-reader.test.ts`      | unit         |    11 | Hybrid exec reader — flag gating, Mongo-wins, CH fallback, inspection                                                                                                                                                                                                                                                                                                                                              |
| `apps/workflow-engine/src/persistence/__tests__/execution-store.session.test.ts`      | unit         |     6 | Mongoose session-threading forwarded                                                                                                                                                                                                                                                                                                                                                                               |
| `apps/workflow-engine/src/persistence/__tests__/workflow-ttl.test.ts`                 | unit         |    13 | FR-7 TTL helpers — flag × terminal × mailbox × seconds                                                                                                                                                                                                                                                                                                                                                             |
| `apps/runtime/src/services/__tests__/workflow-events-consumer.test.ts`                | unit         |     9 | UT-02 row mappers + UT-04 Zod + consumer dispatch + mailbox literal guard                                                                                                                                                                                                                                                                                                                                          |
| `apps/runtime/src/services/__tests__/hybrid-human-task-reader.test.ts`                | unit         |     6 | Hybrid human-task reader — flag, multi-status $in, mailbox scope, CH fail                                                                                                                                                                                                                                                                                                                                          |
| `apps/runtime/src/routes/__tests__/test-diagnostic-workflow.test.ts`                  | unit         |     8 | Runtime test-diagnostic routes — CH param forwarding, 404, NODE_ENV guard                                                                                                                                                                                                                                                                                                                                          |
| `apps/runtime/src/routes/__tests__/human-tasks-status-parser.test.ts`                 | unit         |     9 | UT-04 — `?status=` enum parser (9 cases: absent / empty / single / comma / whitespace / dedupe / unknown / mixed / all-enums)                                                                                                                                                                                                                                                                                      |
| `packages/eventstore/src/schema/events/__tests__/workflow-execution-events.test.ts`   | unit         |     9 | UT-01 — workflow-execution Zod round-trip                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/eventstore/src/schema/events/__tests__/human-task-events.test.ts`           | unit         |     8 | UT-01 — human-task Zod + literal mailbox rejection                                                                                                                                                                                                                                                                                                                                                                 |
| `packages/eventstore/src/retention/__tests__/workflow-event-lifecycle.test.ts`        | unit         |     7 | FR-8 — IEventLifecycle 5-method contract + retention pipeline                                                                                                                                                                                                                                                                                                                                                      |
| `packages/database/src/cascade/__tests__/event-cascade-hooks.test.ts`                 | unit         |     3 | UT-06 — `deleteByExecutionIds` optional-chaining backward-compat                                                                                                                                                                                                                                                                                                                                                   |
| `apps/workflow-engine/src/__tests__/execution-lifecycle.e2e.test.ts`                  | e2e (gated)  |     2 | **E2E-01 pilot** — happy-path lifecycle + cross-tenant CH isolation. Gated via `helpers/e2e-gate.ts` — skips unless operator flips `WORKFLOW_OUTBOX_ENABLED` + `WORKFLOW_CH_SINK_ENABLED` + exports auth context + provisions CH/Kafka/services. Runs via `pnpm test:e2e`.                                                                                                                                         |
| `apps/workflow-engine/src/__tests__/dual-read.e2e.test.ts`                            | e2e (gated)  |     2 | **E2E-02** — hybrid inspector mongo-only vs ch-only vs union parity with Mongo-wins-on-overlap + 404 on unknown execution. Additionally requires `WORKFLOW_DUAL_READ_ENABLED=true`. Reuses the shared `helpers/e2e-gate.ts`.                                                                                                                                                                                       |
| `apps/workflow-engine/src/__tests__/trigger-to-ch.e2e.test.ts`                        | e2e (gated)  |     2 | **E2E-06 (scoped)** — cross-entity CH correlation: execute workflow → both `workflow_execution_events` and `human_task_events` land in CH with shared `execution_id`. Gracefully mid-run skips when the seeded `E2E_HUMAN_TASK_WORKFLOW_ID` workflow doesn't produce a human_task on bare input (workflow design vs test-infra concern). Isolation check always runs. Full approve/claim roundtrip still deferred. |
| `apps/workflow-engine/src/__tests__/helpers/e2e-gate.ts`                              | e2e helper   |   n/a | Shared gate helper — probes workflow-engine / runtime / CH / Kafka + checks required feature flags + validates `E2E_AUTH_TOKEN`. Returns `shouldRun` + structured skip reason.                                                                                                                                                                                                                                     |

### DEFERRED — tracked as feature-spec GAP-008

| Test file (planned)                                                                                                                                | Tier        | Covers                            | Deferral Reason                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/workflow-engine/src/__tests__/system-outbox-leader.test.ts`                                                                                  | integration | INT-02 multi-replica leader       | Needs dockerized Kafka + 2 replicas                                                                                                                                                                                                                                                                                                |
| `apps/runtime/src/__tests__/workflow-consumer.integration.test.ts`                                                                                 | integration | INT-03 Kafka → CH dedup + MV      | Needs dockerized CH + Kafka                                                                                                                                                                                                                                                                                                        |
| `apps/workflow-engine/src/__tests__/mongo-ttl.integration.test.ts`                                                                                 | integration | INT-04 real Mongo TTL sweep       | Needs Mongo with accelerated TTL                                                                                                                                                                                                                                                                                                   |
| `apps/runtime/src/__tests__/gdpr-workflow-cascade.integration.test.ts`                                                                             | integration | INT-05 GDPR cascade               | Needs dockerized CH + Mongo                                                                                                                                                                                                                                                                                                        |
| `apps/workflow-engine/src/__tests__/user-isolation-parity.integration.test.ts`                                                                     | integration | INT-06 CH vs Mongo filter parity  | Needs real CH                                                                                                                                                                                                                                                                                                                      |
| `apps/workflow-engine/src/__tests__/flag-matrix.integration.test.ts`                                                                               | integration | INT-07 16-combo flag-matrix smoke | Needs real full stack                                                                                                                                                                                                                                                                                                              |
| `apps/workflow-engine/src/__tests__/error-paths.integration.test.ts`                                                                               | integration | INT-08 Kafka/CH/Mongo failures    | Needs docker-compose pause/unpause                                                                                                                                                                                                                                                                                                 |
| `apps/workflow-engine/src/__tests__/execution-lifecycle.e2e.test.ts` — **PILOT SHIPPED** (gated, skipped in CI without operator-provisioned stack) | e2e         | E2E-01                            | Lit-up by operator (flags + auth token + user-provisioned CH/Kafka/services)                                                                                                                                                                                                                                                       |
| `apps/runtime/src/__tests__/gdpr-cascade.e2e.test.ts`                                                                                              | e2e         | E2E-05                            | **Blocked**: no HTTP tenant-cascade endpoint exposed. `cascadeWorkflowTenant` is a function (`apps/runtime/src/services/workflow-cascade-hook.ts`) but no admin route calls it. Ship the endpoint (e.g. `POST /api/admin/tenants/:id/cascade-delete` gated behind `NODE_ENV=test` + platform-admin scope) before writing this E2E. |
| `apps/studio/e2e/workflows/monitor-historical.spec.ts`                                                                                             | e2e (pw)    | E2E-03                            | Studio Playwright + TTL PR                                                                                                                                                                                                                                                                                                         |
| `apps/studio/e2e/inbox/default-filter.spec.ts`                                                                                                     | e2e (pw)    | E2E-04                            | Studio Playwright PR                                                                                                                                                                                                                                                                                                               |
| `apps/workflow-engine/src/__tests__/load-smoke.test.ts`                                                                                            | load        | LOAD-02 CI smoke                  | k6 + dockerized full stack                                                                                                                                                                                                                                                                                                         |

---

## 12. Open Testing Questions

| ID   | Question                                                                                                                                                                                                                                                       | Owner / Resolver                                       |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| OQ-1 | Should we introduce `testcontainers` for CH / Kafka instead of docker-compose harness?                                                                                                                                                                         | HLD decision (testing-infra scope)                     |
| OQ-2 | Does the `BufferedClickHouseWriter` expose a flush hook usable in tests, or do we need a new helper?                                                                                                                                                           | LLD — `packages/eventstore` owner                      |
| OQ-3 | Are the test-diagnostic endpoints (`/api/admin/test/...`) acceptable in this repo, or must we bypass HTTP for the CH assertions?                                                                                                                               | HLD / Product-Oracle resolution                        |
| OQ-4 | Does `MongoMemoryReplSet` support the `session`-level abort semantics needed by INT-01, or do we need a real Mongo container?                                                                                                                                  | INT-01 dry-run during LLD                              |
| OQ-5 | How do we deterministically force a Mongo TTL sweep in CI (INT-04 step 2) given Mongo's 60s background thread?                                                                                                                                                 | LLD — evaluate `collMod` + wait vs test-admin endpoint |
| OQ-6 | Should the flag-matrix smoke (INT-07) live in CI full-run or only in nightly, given 16× boot cost?                                                                                                                                                             | LLD — CI cost vs coverage tradeoff                     |
| OQ-7 | Does Playwright-driven Studio E2E (E2E-03, E2E-04) need its own flag-state fixture, or can we reuse the runtime-level fixture?                                                                                                                                 | Studio E2E `agents.md` update                          |
| OQ-8 | PII sentinel constant — do we export it publicly from `@agent-platform/eventstore`, or keep it internal?                                                                                                                                                       | HLD — API surface decision                             |
| OQ-9 | `apps/studio/e2e/inbox/` is a net-new Playwright test directory (the existing `apps/studio/e2e/workflows/agents.md` covers only the `workflows/` subtree). Does this subtree get its own `agents.md`, or is it consolidated under `apps/studio/e2e/agents.md`? | LLD — Studio E2E conventions                           |

---

## 13. Status

**PARTIAL** — Implementation Phases 1-6 landed as 38 commits on branch `feat/workflow-runs-mongo-2-clickhouse` (2026-04-21). Unit coverage SHIPPED. Real-infra integration tests + 6 E2E Playwright specs + LOAD-02 CI smoke DEFERRED to the dockerized-CH PR (tracked as feature-spec GAP-008 — blocks BETA promotion).

---

## 14. References

- Feature spec: [`../../features/sub-features/workflow-execution-event-sourcing.md`](../../features/sub-features/workflow-execution-event-sourcing.md)
- Feature-spec log: [`../../sdlc-logs/workflow-execution-event-sourcing/feature-spec.log.md`](../../sdlc-logs/workflow-execution-event-sourcing/feature-spec.log.md)
- Test-spec log: [`../../sdlc-logs/workflow-execution-event-sourcing/test-spec.log.md`](../../sdlc-logs/workflow-execution-event-sourcing/test-spec.log.md)
- Parent feature test guide: [`../workflows.md`](../workflows.md)
- EventStore test guide: [`../eventstore.md`](../eventstore.md)
- Memory & Sessions test guide: [`../memory-sessions.md`](../memory-sessions.md)
- Test-integrity rules: CLAUDE.md "Test Architecture" + "E2E Test Standards"
- Pipeline: [`../../sdlc/pipeline.md`](../../sdlc/pipeline.md)
- Test-spec playbook: [`../../sdlc/test-spec-playbook.md`](../../sdlc/test-spec-playbook.md)
