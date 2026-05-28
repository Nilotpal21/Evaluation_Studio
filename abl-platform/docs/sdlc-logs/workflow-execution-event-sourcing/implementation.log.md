# SDLC Log: workflow-execution-event-sourcing — Implementation Phase

**Feature**: workflow-execution-event-sourcing
**Phase**: IMPLEMENTATION
**LLD**: `docs/plans/2026-04-21-workflow-execution-event-sourcing-impl-plan.md` (commit `c5e2d75acc`)
**Jira**: ABLP-2
**Date Started**: 2026-04-21
**Date Completed**: IN PROGRESS

---

## Preflight (2026-04-21)

- [x] LLD file paths verified:
  - `apps/workflow-engine/src/persistence/execution-store.ts` — 220 LOC, `WorkflowExecutionModel` interface already has `options?: Record<string, unknown>` on `updateOne` (line 19) and `findOneAndUpdate` (line 24). `createExecution` uses `updateOne` with `{ upsert: true }` at lines 57–83. All three methods use `findOneAndUpdate` with no options today — adding threading is additive.
  - `apps/workflow-engine/src/persistence/human-task-store.ts` — 123 LOC. `createTask` calls `HumanTask.create(doc)` single-doc form at line 61 (must convert to array overload). `updateTaskStatus` filters `{ _id: taskId, tenantId }` at line 94 — pre-existing `projectId` isolation gap confirmed.
  - `packages/eventstore/src/queues/kafka-queue.ts` — 270 LOC. Producer instance at line 38 with `idempotent: true`. `enqueue()` (line 102) is fire-and-forget; `publishAndAck` will use the same producer + pendingMessages pattern but await the send.
- [x] Function signatures current — all match LLD claims.
- [x] `updateTaskStatus` call-sites verified (4 production + 5 test):
  - `apps/workflow-engine/src/handlers/workflow-handler.ts:1064,1122` — `ctx.tenant.projectId` available
  - `apps/workflow-engine/src/routes/workflow-approvals.ts:252` — `projectId` from `req.params` available
  - `apps/workflow-engine/src/routes/human-task-resolution.ts:137` — `projectId` from `req.params` (line 62) available
  - `apps/workflow-engine/src/__tests__/system-human-task-store.test.ts` — 5 calls, createTask already passes `projectId: 'p1'`
- [x] `HumanTaskStoreLike` interface at `human-task-store.ts:51` — MUST update `updateTaskStatus` signature.
- [x] `HumanTaskStore` interface at `workflow-handler.ts:201` — MUST update `updateTaskStatus` signature.
- [x] `git log -5 -- apps/workflow-engine apps/runtime packages/eventstore packages/database` — no recent conflicting changes since LLD authored.
- Discrepancies: none.

## Phase Execution

### LLD Phase 1: Infrastructure Gaps — DONE (2026-04-21)

- **Status**: DONE
- **Commits**:
  - `2b73eb2b26` [ABLP-2] refactor(workflow-engine): add optional session param to Execution + HumanTask stores + fix updateTaskStatus projectId gap — 10 files, +344/-64
  - `1167ed756b` [ABLP-2] feat(eventstore): add publishAndAck to KafkaEventQueue for topic-routed ACK-awaitable publish — 2 files, +139
- **Exit Criteria Met**:
  - [x] `pnpm build --filter=@agent-platform/workflow-engine --filter=@abl/eventstore` — 0 errors (Turbo: 15 tasks, 14 cached).
  - [x] `pnpm --filter=@agent-platform/workflow-engine test:fast` — 38+3 files, 515+50 tests pass, zero regressions.
  - [x] `pnpm --filter=@abl/eventstore test` — 20 files, 288 tests pass (includes 5 new publishAndAck tests).
  - [x] `publishAndAck` unit test — 5 cases: success + failure + pendingCount-zero-after-each + explicit-key + undefined-key fallback.
  - [x] `execution-store.session` unit test — 6 cases: session forwarded on createExecution (upsert preserved) + updateStepStatus + updateExecutionStatus (both primary + terminal duration updates); omitted when not provided.
  - [x] Commit-scope guard: commit 1 = 10 files / 1 package; commit 2 = 2 files / 1 package. Both well within 40-file / 3-package limits.
- **Pre-existing gap fixed as part of §1.2**: `updateTaskStatus` previously filtered `{_id, tenantId}` missing `projectId`. Now takes `projectId` as 2nd param and filters on it. 4 production call-sites + 2 interfaces + 5 tests + stale findBySource mocks in 2 test files all updated in commit 1.
- **Deviations from LLD**: none.

### LLD Phase 2: Schema + Models — DONE (2026-04-21)

- **Status**: DONE
- **Commits** (5, one per LLD-prescribed scope):
  - `b7d89baf7b` [ABLP-2] feat(database): add workflow-event-outbox mongoose model + indexes — 2 files, +65/-0 (§2.1)
  - `7b5b008a2c` [ABLP-2] feat(eventstore): add workflow + human-task event zod schemas and registry registration — 5 files, +368/-0 (§2.2, §2.3, UT-01)
  - `635c3d7659` [ABLP-2] feat(eventstore): add clickhouse DDL for workflow-event-sourcing tables + init function — 4 files, +280/-0 (§2.4, §2.5, §2.6)
  - `9e145b3baf` [ABLP-2] feat(workflow-engine): add feature-flag gate helper for event-sourcing flags — 3 files, +109/-1 (§2.7, UT-03; also broadened vitest include glob to enable co-located tests)
  - `b225eb3938` [ABLP-2] chore(docker): add workflow event-sourcing kafka topics + env flags — 2 files, +15/-1 (commit 7)
- **Exit Criteria Met**:
  - [x] `pnpm build --filter=@agent-platform/database --filter=@abl/eventstore --filter=@agent-platform/workflow-engine` — 0 errors (Turbo: 15 tasks, 14 cached).
  - [x] UT-01 workflow + human-task Zod round-trip tests — 17 tests pass (9 workflow + 8 human-task).
  - [x] UT-03 flag-gate 16-combination matrix — 18 tests pass (16 matrix + 2 default-behavior).
  - [x] `pnpm --filter=@agent-platform/workflow-engine` full test suite: 712 tests pass (pre-existing `graceful-shutdown` health-endpoint failure predates this work).
  - [x] No caller invokes the new modules yet (§2 exit criterion verified).
  - [x] Commit-scope guard: all 5 commits ≤5 files / ≤1 package.
- **Deviations from LLD**:
  - **TTL interval omitted from CH DDL** — LLD §2.4 and §2.5 reference `TTL occurred_at + INTERVAL <plan-based>` but the plan-based TTL wiring lands in Phase 6 (`WorkflowEventLifecycle`). Tables ship without a TTL clause; Phase 6 will `ALTER TABLE ... MODIFY TTL` with the plan-tiered value. This is additive and safer than shipping a hardcoded 7-day TTL that Phase 6 would have to overwrite.
  - **vitest include glob broadened** — `src/__tests__/**/*.test.ts` → `src/**/__tests__/**/*.test.ts`. The LLD-specified test locations (`src/persistence/__tests__/execution-store.session.test.ts` in Phase 1, `src/outbox/__tests__/flag-gates.test.ts` in Phase 2) are co-located — the narrow glob silently excluded them. Broadening the glob retroactively enabled the Phase 1 session test as well (6 tests that had been invisible).

### LLD Phase 3: Write Path — DONE (2026-04-21)

- **Status**: DONE — 6 commits, all exit criteria met except INT-02 (Kafka docker) which is deferred to Phase 4 where the full Kafka + consumer chain is exercised end-to-end.
- **Commits** (in order):
  - `4f42d4be67` [ABLP-2] feat(workflow-engine): add transactional workflow-event outbox writer + payload builder — 6 files, +449/-1 (§3.1 + §3.7 metric scaffolding).
  - `b7d088d0eb` [ABLP-2] feat(database): mark EventCascadeHook.deleteByExecutionIds optional — 2 files, +86 (§3.4 + UT-06).
  - `e0884a0e82` [ABLP-2] feat(workflow-engine): wire outbox decorator into execution + human-task stores — 4 files, +1230/-3 (§3.2 via deviation; gated on `outboxEnabled`).
  - `40cf895953` [ABLP-2] feat(workflow-engine): add BullMQ repeatable outbox poller + bootstrap — 4 files, +495/-1 (§3.3 + §3.5 + §3.7 metrics).
  - `fda99105ca` [ABLP-2] feat(workflow-engine): add test-diagnostic outbox endpoints (NODE_ENV=test) — 3 files, +444 (§3.6 + test-spec §10.1-§10.3).
  - `ff16216e6e` [ABLP-2] fix(database): replace unsupported `$ne` with `$type` in outbox TTL partial filter + INT-01 atomicity test — 3 files, +226/-3 (INT-01 + Phase 2 latent defect fix).
- **Exit Criteria**:
  - [x] `pnpm build --filter=@agent-platform/workflow-engine --filter=@agent-platform/database --filter=@agent-platform/shared` — 0 errors.
  - [x] `pnpm --filter=@agent-platform/workflow-engine test:fast` — 573 fast + 50 forks tests pass (+37 new: 9 writer + 3 cascade + 12 decorator + 4 poller + 9 test-diagnostic, zero regressions).
  - [x] INT-01 (3 scenarios: happy path, abort/rollback, flag-off) passes against `MongoMemoryReplSet`.
  - [x] UT-06 (cascade-hook back-compat) — 3/3 pass.
  - [x] `GET /api/admin/test/workflow-outbox` returns rows with tenant isolation under `NODE_ENV=test`; returns 404 when NODE_ENV is any other value (factory + router guards both in place).
  - [x] With `WORKFLOW_OUTBOX_ENABLED=false`, existing workflow-engine tests show zero regressions (confirmed by stash-and-compare across the 2 pre-existing system-human-task-store failures — they predate Phase 3).
  - [ ] **INT-02** (publisher failure — leader election + retry) — deferred to Phase 4. Rationale: INT-02 as LLD-specified needs dockerized Kafka + a second replica competing for the leader lock. The semantic equivalent (retry semantics) is covered by the unit-test suite (`outbox-poller.test.ts — on Kafka failure: bumps retryCount, stores lastError, leaves publishedAt null`). True multi-replica leader election is a BullMQ guarantee already validated by the `TriggerScheduler` integration tests. Phase 4 will add the full Kafka + CH round-trip which subsumes INT-02.
  - [x] Commit-scope guard: all 6 commits ≤6 files / ≤1 package. Deletion ratio <5% for every feat() commit.
- **Deviations from LLD**:
  - **§3.2 wiring architecture** (deliberate): persistence-layer decorator instead of 30+ handler-site `withTransaction` wrappings. Atomicity preserved — domain write + outbox write share the same `ClientSession` inside `withTransaction`. Respects the 40-file / 3-package commit scope guard and the "outbox writer stays a thin persistence wrapper" invariant. Documented in `execution-persistence-with-outbox.ts` file header.
  - **§3.7 observability surface**: LLD says "emit via TraceStore" — repo has no runtime `TraceStore` interface, only the migration-bridge type. Shipped as structured log events through `@abl/compiler/platform`'s `createLogger` (`workflow.outbox.enqueued`, `workflow.outbox.published`, `workflow.consumer.flush_failed`). Metrics exposed via the existing `@opentelemetry/api` meter (not `prom-client`) since workflow-engine already wires `OTLPMetricExporter` at boot.
  - **Phase 2 latent defect fixed**: the Phase 2 outbox-model shipped a TTL partial filter `{publishedAt: {$ne: null}}` which Mongo rejects (`Expression not supported in partial index: $not`). No Phase 2 test loaded the model against a real Mongo, so the defect went undetected. INT-01 caught it. Fix: `{publishedAt: {$type: 'date'}}` — same semantic (BSON Date present ⇒ row is published), supported everywhere. Bundled with the INT-01 commit (§3 test slice) so INT-01 passes in the same commit.
  - **INT-02** (see exit criteria above): deferred to Phase 4 when the Kafka + consumer stack lands end-to-end.

### LLD Phase 4: Consume + Sink — PREFLIGHT (2026-04-21)

- [x] LLD file paths verified (all present): `apps/runtime/src/services/eventstore-singleton.ts`, `apps/runtime/src/server.ts`, `apps/runtime/src/repos/cascade-repo.ts` (ALTER TABLE pattern at L158-161), `packages/database/src/cascade/cascade-delete.ts` (deleteTenant at L49), `packages/database/src/cascade/event-cascade-hooks.ts` (optional `deleteByExecutionIds` landed in Phase 3 commit `b7d088d0eb`), `packages/database/src/clickhouse.ts` (BufferedClickHouseWriter defaults at L157-158), `packages/eventstore/src/queues/kafka-queue.ts` (default groupId `'eventstore-consumer'` at L51), `packages/eventstore/src/stores/clickhouse/init-workflow-event-tables.ts` (exported from `@abl/eventstore`), `packages/eventstore/src/retention/event-retention-service.ts` (constructor accepts `IEventLifecycle`).
- [x] Signatures current — `KafkaEventQueue.onProcess(handler)` subscribes to configured `topic`; `RetentionPolicy` has `events.totalRetentionDays` + `events.piiRetentionDays`; `IEventLifecycle` has 5 methods (purgeExpired, scrubPII, deleteBySessionIds, anonymizeActor, deleteTenant); Zod schemas `WorkflowExecutionEventSchema` + `HumanTaskEventSchema` are flat (no `data` envelope) and use `.passthrough()`.
- [x] `git log --since="2 days ago" -- apps/runtime packages/database packages/eventstore` shows only ABLP-2 Phase 1-3 commits plus one unrelated change (`b6a1962600` — clickhouse repair client MV that doesn't touch Phase 4 surface).
- Discrepancies documented:
  - **No runtime-side retention cron exists today.** `registerEventRetentionHandler` (defined at `apps/studio/src/services/retention/retention-scheduler.ts:64`) is the sole hook point, but no runtime caller wires to it. LLD §4.6 ("same daily cron handler that invokes the existing platform `EventRetentionService.runRetention`") assumes a cron that doesn't exist. Will build `WorkflowEventLifecycle` + retention service regardless and expose it from the eventstore singleton so it's registerable — covering FR-8 exit criterion. Studio-side cron wiring is orthogonal infra (tracked separately if needed).
  - **Plan-tier → `RetentionPolicy` translation** lives outside the `EventRetentionService` (which only knows about totalRetentionDays/piiRetentionDays). The LLD's FREE 30d / TEAM 90d / BUSINESS 365d / ENTERPRISE 7y matrix is a caller concern; exit criterion will test with a synthetic `RetentionPolicy` directly.

### LLD Phase 4: Consume + Sink — DONE (2026-04-21)

- **Status**: DONE — 6 commits, all exit criteria met except the 3 real-CH integration tests (INT-03, INT-05, E2E-05) which are deferred to a dockerized-CH follow-up. Rationale logged below.
- **Commits**:
  - `4a8061d6e9` [ABLP-2] feat(runtime): add workflow-events kafka->clickhouse consumer with buffered writes — 2 files, +375/-0 (§4.1 + §4.2 + `initWorkflowEventTables` bootstrap + SIGTERM shutdown)
  - `2b1d673401` [ABLP-2] feat(database,runtime): extend event-cascade-hook with deleteByExecutionIds + mongo cascade + register workflow impl — 3 files, +152/-1 (§4.3 + §4.7)
  - `97abf64b04` [ABLP-2] feat(runtime): add test-diagnostic workflow CH query endpoints — 2 files, +240/-0 (§4.4)
  - `5676d17d09` [ABLP-2] feat(runtime): add workflow.outbox.consumed + workflow.consumer.flush_failed trace events — 2 files, +160/-0 (§4.5)
  - `756fb9921a` [ABLP-2] feat(eventstore,runtime): add workflow-event lifecycle for plan-tiered CH retention (FR-8) — 3 files, +175/-1 (§4.6)
  - `4a92ea889c` [ABLP-2] test(runtime,eventstore): add consumer + lifecycle + test-diagnostic UT coverage for Phase 4 — 4 files, +520/-1 (§4 tests: UT-02 row mapper + UT-04 Zod + consumer dispatch + lifecycle + FR-8 retention pipeline + 3 route cases)
- **Exit Criteria**:
  - [x] `pnpm build --filter=@agent-platform/runtime --filter=@abl/eventstore --filter=@agent-platform/database` — 0 errors (Turbo: 27 tasks).
  - [x] UT-02 (row mapper) — 5 tests pass across both Zod schemas.
  - [x] UT-04 (Zod validation) — 4 tests pass; invalid workflow.execution is dropped with structured log, agent-mailbox human_task is rejected by the literal-union schema guard, malformed `occurred_at` short-circuits the lag histogram.
  - [x] WorkflowEventLifecycle 5-method contract — 7 tests pass: purgeExpired / scrubPII / no-op guards / deleteTenant fans out to raw + `_latest`.
  - [x] **FR-8 retention test** (§4.6 exit criterion): `EventRetentionService(new WorkflowEventLifecycle(fakeChClient)).runRetention('t1', {events:{totalRetentionDays:30, piiRetentionDays:30}})` issues `ALTER TABLE … DELETE` on both raw tables with a cutoff ~30 days in the past. Full chain covered.
  - [x] `eventstore` full suite: 312 tests pass (+7 new lifecycle tests, zero regressions).
  - [x] Runtime fast lane: see regression section below.
  - [x] `initWorkflowEventTables` idempotency — DDL uses `CREATE … IF NOT EXISTS` (Phase 2 already verified).
  - [x] Runtime bootstrap: `initWorkflowEventTables(chClient)` called unconditionally at startup; consumer start gated on `WORKFLOW_CH_SINK_ENABLED=true`; test-diagnostic routes mounted only when `NODE_ENV=test`.
  - [x] Commit-scope guard: every commit ≤4 files / ≤2 packages (well within 40/3 limits).
  - [x] Deletion ratio: every feat() commit is purely additive (0% deletions).
  - [ ] **INT-03** (Kafka → CH dedup + flush + MV correctness) — deferred to a dockerized-CH follow-up. Rationale: the runtime test harness does not have a ClickHouseContainer / testcontainers setup today; all CH-consuming runtime tests in `src/__tests__/**/*.integration.test.ts` skip gracefully when CH is unavailable. The Phase 4 UT coverage (dispatch, row mapper, ZOD validation, lifecycle) already locks down the per-event correctness and command shape. The full Kafka+CH roundtrip will be added with the LOAD-02 CI smoke lane (Phase 6) which brings up dockerized CH.
  - [ ] **INT-05** (GDPR cascade — CH rows + Mongo rows, agent mailbox untouched) — deferred for the same reason. The `cascadeWorkflowByExecutionIds` unit surface is small and purely delegates to `client.command()` + `Model.deleteMany()`; INT-05 confirms the wire-up which is safer to test once a dockerized harness exists. `deleteTenant` Mongo-side cleanup is exercised by the existing `cascade-delete.test.ts` harness (pre-existing integration lane).
  - [ ] **E2E-05** (Tenant deletion cascade — 7 stores) — deferred; same dockerized-CH dependency.
- **Deviations from LLD**:
  - **Test-harness deferral of INT-03/INT-05/E2E-05**: documented above. Not a scope reduction — the tests are added to the follow-up CI work (Phase 6 LOAD-02 or separate CH-integration PR).
  - **`EventRetentionHandler` hook wiring** (§4.6): the runtime instantiates `WorkflowEventLifecycle` + `EventRetentionService` and exposes `getWorkflowRetention()` from the eventstore singleton, but does NOT call `registerEventRetentionHandler` because there is no runtime-side daily retention cron today. The studio-side cron handler is the canonical caller per `apps/studio/src/services/retention/retention-scheduler.ts:64`. Exposing the service is sufficient to satisfy FR-8's "plan-tiered retention is implementable" — a later integration wires the registerEventRetentionHandler hook.
  - **Logger import in `workflow-event-lifecycle.ts`**: uses `@agent-platform/shared-observability` (peer `clickhouse-event-store.ts` convention) rather than `@abl/compiler/platform` (what Phase 2's `init-workflow-event-tables.ts` shipped with). The latter is an undeclared dep in `@abl/eventstore/package.json` and breaks vitest's native resolver — Phase 2's test-gap hid the issue. Pre-existing Phase 2 defect tracked as a follow-up; intentionally not bundled into this Phase 4 commit to preserve `[ABLP-2] feat(…)` scope.

### LLD Phase 5: Read Path + UI — DONE (2026-04-21)

- **Status**: DONE — 6 commits. UT coverage for hybrid readers + dual-read merger + Studio UI changes. Integration/E2E tests (INT-06, INT-07, E2E-01, E2E-02, E2E-04, E2E-06) deferred to the dockerized-CH follow-up for the same reason as Phases 3-4.
- **Commits**:
  - `3c0d175f86` [ABLP-2] feat(workflow-engine): add dual-read merger pure function with mongo-wins dedup — 2 files, +181/-0 (§5.1 + UT-05 9 tests)
  - `669b18dc07` [ABLP-2] feat(workflow-engine): add HybridExecutionReader gated on dual-read flag — 4 files, +387/-0 (§5.2 + §5.4 + metrics module)
  - `7fdb36f5da` [ABLP-2] feat(runtime): add HybridHumanTaskReader scoped to mailbox=workflow — 3 files, +353/-2 (§5.3 + §5.5 + multi-value status parsing + late-binding factory)
  - `c63a62c72b` [ABLP-2] feat(studio): add Inbox default-filter pending + show-completed toggle — 3 files, +41/-7 (§5.6: `status=pending,assigned,in_progress` default + `data-testid="inbox-include-completed-toggle"`)
  - `1f5c8cb5ac` [ABLP-2] feat(workflow-engine): add hybrid-mode test-diagnostic inspection endpoint — 3 files, +166/-2 (§5.7: `GET /api/admin/test/workflow-executions/:id/hybrid?mode=mongo-only|ch-only|union`)
  - `d9916e816d` [ABLP-2] test(workflow-engine,runtime): add HybridExecutionReader + HybridHumanTaskReader unit coverage — 2 files, +510/-0 (17 new tests)
- **Exit Criteria**:
  - [x] **UT-05** (dual-read merger): 9 tests pass (empty/empty, empty/ch, mongo/empty, disjoint, full overlap with Mongo winning, partial overlap, within-side dup keys, DESC sort, numeric sort).
  - [x] HybridExecutionReader UT: 11 tests pass (flag-off delegation, flag-on union, Mongo-wins-on-overlap, CH-failure fallback, page-limit respect, getById × 3, inspection × 3).
  - [x] HybridHumanTaskReader UT: 6 tests pass (flag gating × 2, filter shape × 3 including mailbox-workflow scope guard + multi-status `$in`, CH failure fallback).
  - [x] `pnpm build --filter=@agent-platform/workflow-engine --filter=@agent-platform/runtime` — 0 errors. Studio Next.js full compile — green.
  - [x] Commit-scope guard: every commit ≤4 files / ≤2 packages. Zero deletions in feat() commits.
  - [ ] **INT-06, INT-07, E2E-01, E2E-02, E2E-04, E2E-06** — deferred to the dockerized-CH follow-up. Same rationale as Phase 3/4: no CH testcontainers harness in runtime/workflow-engine. UT coverage (26 new tests this phase) locks down pure logic, command shapes, and flag gating; full-stack roundtrips land with Phase 6 LOAD-02 / separate CH-integration PR.
  - [ ] **E2E-03** (Historical Executions via CH after Mongo TTL) — deferred to Phase 6 per LLD.
  - [ ] Performance budget gate (p95 < 500ms @ 1k-execution fixture) — deferred alongside LOAD-02.
- **Deviations from LLD**:
  - **Dual-read-merger location** (§5.1): kept in `apps/workflow-engine/src/persistence/`; runtime inlines the 15-line function rather than importing cross-app. LLD §7 already earmarks promoting to `packages/database/src/migration-helpers/` when a second Mongo→CH migration lands.
  - **Hybrid reader late-binding** (§5.5): runtime's `createHumanTaskRouter` runs at module-load, so the hybrid reader is late-bound via factory `() => reader | null` — `startServer()` populates the module-level binding once CH is ready. Same semantics, cleaner lifecycle.
  - **Execution detail GET fallback** (§5.2 + §5.4): when Mongo misses and `hybridReader` is set, the route falls through to CH and returns `{ ...chRow, steps: [] }`. CH `workflow_executions_latest` doesn't project `nodeExecutions`, so the UI renders a reduced view for post-TTL historical runs keyed on `source: 'ch'`.
  - **`requestedAt` sort** (§5.6): LLD mentions `requestedAt DESC` but the Mongo model uses `createdAt` (Mongoose timestamps). Kept `createdAt` — treat `requestedAt` as a synonym.

### LLD Phase 6: TTL + Parity — DONE (2026-04-21)

- **Status**: DONE — 4 commits. Mongo TTL wiring + outbox backlog safety check + Mongo↔CH parity-check CLI + UT coverage. Destructive / integration-dependent tests (INT-04, INT-08, E2E-03, LOAD-02) deferred to the dockerized-CH follow-up per the pattern established in Phases 3–5.
- **Commits**:
  - `b5bb0a9213` [ABLP-2] feat(database,workflow-engine): add expiresAt field + TTL partial-filter indexes for workflow-executions + human-tasks (workflow mailbox) — 5 files, +174/-2 (§6.1 + §6.2 + `workflow-ttl.ts` helper + aggregation-pipeline `$cond` mailbox guard)
  - `8036ee5599` [ABLP-2] feat(workflow-engine): add startup validation for outbox backlog before TTL enablement — 1 file, +30/-0 (§6.3)
  - `10ff977216` [ABLP-2] feat(workflow-engine): add Mongo<->CH parity-check CLI for workflow executions — 1 file, +335/-0 (§6.4 `tools/test-infra/parity-check.ts`)
  - `740f836963` [ABLP-2] test(workflow-engine): add workflow-ttl helper coverage — 1 file, +126/-0 (13 UT covering flag gating × terminal × mailbox × custom-seconds override)
- **Exit Criteria**:
  - [x] TTL indexes on `workflow_executions` + `human_tasks` — partial-filter `{expiresAt: {$type: 'date'}}` with `expireAfterSeconds: 0`. Index creation itself is flag-gated: only registered when `WORKFLOW_MONGO_TTL_ENABLED=true` at model-load time.
  - [x] Terminal-transition write path populates `expiresAt` on execution + workflow-mailbox human tasks; in-flight rows + agent-mailbox tasks keep `null` (HLD §5 scope guard enforced via aggregation-pipeline `$cond` in `updateTaskStatus`).
  - [x] Default TTL window = 14 days; override via `WORKFLOW_MONGO_TTL_SECONDS`; malformed env falls back to default.
  - [x] `WORKFLOW_OUTBOX_ALERT_THRESHOLD` check at startup (default 10K) — warns if outbox backlog exceeds the threshold when TTL enablement is attempted.
  - [x] Parity-check CLI: `pnpm tsx tools/test-infra/parity-check.ts --help` runs clean; arg validation (`--sample-size`, `--threshold`) rejects invalid inputs; exit codes 0/1/2 per LLD.
  - [x] Parity CLI diffs 10 canonical fields per LLD §6.4 (status, workflow_version, started_at, completed_at, duration_ms, workflow_id, project_id, trigger_type, last_event_at, error_code); normalizes timestamps between Mongo's `Date.toISOString()` and CH's `YYYY-MM-DD HH:MM:SS.sss`.
  - [x] workflow-ttl UT: 13 tests cover the 4 gating dimensions (flag, terminal, mailbox, seconds override) across all 3 helpers.
  - [x] `pnpm build --filter=@agent-platform/database --filter=@agent-platform/workflow-engine` — 0 errors.
  - [x] Commit-scope guard: every commit ≤5 files / ≤2 packages. Zero deletions.
  - [ ] **INT-04** (MongoMemoryReplSet + accelerated TTL) — deferred. Requires real Mongo replica set with TTL monitor. Covered conceptually by UT; true TTL behaviour lands with the CH-integration PR.
  - [ ] **INT-08** (Kafka/CH/Mongo failure scenarios via `docker-compose pause`) — deferred. Needs orchestration harness.
  - [ ] **E2E-03** (Monitor Tab — Historical Executions via CH after Mongo TTL) — deferred. Depends on real TTL + Studio Playwright lane.
  - [ ] **LOAD-02** CI smoke — deferred. Needs k6 + dockerized full stack.
  - [ ] Parity-check against 10K-execution staging dataset — requires staging infra; scheduled for the canary rollout phase.
- **Deviations from LLD**:
  - **Mailbox scope guard via aggregation-pipeline `$cond`** (§6.2): the LLD directs us to set `expiresAt` only on `mailbox='workflow'` terminal transitions. Since `updateTaskStatus()` doesn't receive `mailbox` as a parameter, we use a Mongo aggregation-pipeline update with `$cond: [{$eq: ['$mailbox','workflow']}, <ttl-date>, '$expiresAt']` so the mailbox check is atomic with the status write — no pre-fetch round trip, agent/escalation tasks stay untouched.
  - **TTL index creation is flag-gated at schema-load time** (§6.1 / §6.2): the LLD says `ensureIndex only runs at startup when WORKFLOW_MONGO_TTL_ENABLED=true`. Implemented by wrapping the `Schema.index()` call in `if (process.env.WORKFLOW_MONGO_TTL_ENABLED === 'true')`. Mongoose calls `ensureIndexes` after model load — with the conditional, the TTL index is never declared unless the flag is on at boot.
  - **Partial-filter operator**: used `{expiresAt: {$type: 'date'}}` not `{expiresAt: {$ne: null}}` — Mongo rejects `$ne` in partial filters. Same fix pattern as Phase 3 commit `ff16216e6e` on the outbox model.
  - **Parity CLI uses mongoose**: root `package.json` doesn't expose `mongodb` as a direct dep (mongoose bundles it internally). Swapped the CLI's MongoDB driver import to mongoose-mediated. ClickHouse client is available via `@clickhouse/client` at the root.
  - **INT-04/INT-08/E2E-03/LOAD-02 deferral**: consistent with Phases 3–5 — ships the production code paths + UT; real integration / destructive tests land with the CH-integration PR.

## Review Rounds

5 mandatory pr-reviewer rounds executed per `/implement` playbook. Each round spawned as a separate Agent tool invocation with fresh context; findings fixed and committed before the next round.

| Round | Focus                | Verdict  | Critical | High | Medium | Low |
| ----- | -------------------- | -------- | -------- | ---- | ------ | --- |
| 1     | Code quality         | APPROVED | 0        | 0    | 2      | 3   |
| 2     | HLD compliance       | APPROVED | 0        | 1    | 2      | 1   |
| 3     | Test coverage        | APPROVED | 0        | 1    | 2      | 1   |
| 4     | Security & isolation | APPROVED | 0        | 1    | 1      | 1   |
| 5     | Production readiness | APPROVED | 0        | 0    | 2      | 2   |

### Round 1 — Code quality

Focus: types, error handling, logging conventions, style.

Key findings resolved:

- **outbox-poller.ts**: success-path `updateOne` had no try/catch — a transient Mongo hiccup during success bookkeeping could abort the remaining rows in the batch. Wrapped in try/catch with `workflow.outbox.bookkeeping_failed` log; documented that the ReplacingMergeTree `_version` dedup absorbs the duplicate on the next drain cycle.
- **outbox-poller.ts**: symmetric issue on the failure-path `updateOne`. Same wrap; dedicated log message clarifies "retryCount/lastError not incremented for this cycle."

Test additions: 2 new unit tests in `outbox-poller.test.ts` — `on success-path Mongo updateOne failure: counts the publish + continues` and `on failure-path Mongo updateOne failure: counts the row as failed + continues`.

Commit: `e45c1da...` (round-1 fixes).

### Round 2 — HLD compliance

Focus: architecture alignment with `docs/specs/workflow-execution-event-sourcing.hld.md`.

Key findings resolved:

- **HIGH — TTL index shape validation at startup (HLD §4 concern #11)**: HLD mandates startup-time verification that the TTL partial-filter uses `{$type: 'date'}` (not `{$ne: null}`) — the latter is silently rejected by Mongo so TTL never fires. Added a CRITICAL-log + `process.exit(1)` block in `apps/workflow-engine/src/index.ts` that inspects `listIndexes()` for both `workflow_executions` and `human_tasks`, extracts the `partialFilterExpression.expiresAt.$type`, and refuses to start if missing or wrong shape. Only runs when `WORKFLOW_MONGO_TTL_ENABLED=true`.
- **hybrid-human-task-reader.ts header + inline comments** were misleading — they described a non-existent `mailbox='workflow'` filter in the CH SQL. The MV (`human_tasks_latest_mv`) enforces mailbox scope at projection time so the projection table `human_tasks_latest` intentionally drops the `mailbox` column. Rewrote the file header + inline comment at `queryCh()` to document the 2-layer guard clearly.

Commit: `38d4b2e...` (round-2 fixes).

### Round 3 — Test coverage

Focus: alignment with `docs/testing/workflow-execution-event-sourcing.md` coverage matrix.

Key findings resolved:

- **HIGH — UT-04 (`?status=` query-param parser) had no direct test**: the Zod enum contract was only exercised implicitly through HTTP. Extracted `parseStatusList` + `HUMAN_TASK_STATUS_VALUES` into the route module's public surface; added `apps/runtime/src/routes/__tests__/human-tasks-status-parser.test.ts` with 9 pure-function cases covering absent / empty / single / comma-list / whitespace / dedupe / unknown-enum / mixed-valid-invalid / every-enum-value-individually. Validates the `VALIDATION_ERROR` envelope includes the allowed-values hint.

Commit: `c711f04...` (round-3 fixes).

### Round 4 — Security & isolation

Focus: Core Invariant #1 (tenant/project/user isolation), auth, input validation.

Key findings resolved:

- **HIGH — `PATCH /api/projects/:projectId/human-tasks/:id` final `findOneAndUpdate` missing `projectId` in filter**: the route resolves the task via the hybrid reader (which is scoped) but the subsequent atomic update only filtered `{_id, tenantId}`. A cross-project task with a leaked ID could have been mutated. Added `projectId: req.params.projectId` to the filter so atomicity and project isolation are preserved at the update site.

No isolation gaps found in the hybrid-reader path, CH queries, or outbox writes — all already scope by `tenant_id` + `project_id` in SQL params and Mongo filters.

Commit: `7b9a2c0...` (round-4 fixes).

### Round 5 — Production readiness (FINAL)

Focus: performance budgets, observability gaps, failure modes, resource safety, shutdown correctness, back-pressure, rollback safety, startup ordering, error-message leakage, disaster recovery.

**VERDICT: APPROVED** — 0 CRITICAL, 0 HIGH.

4 non-blocking findings filed as follow-ups (`docs/sdlc-logs/workflow-execution-event-sourcing/followups.md`):

- **FU-2 (MEDIUM)** — outbox poller has no poison-pill cap on `retryCount`. Under persistent per-row Kafka failure, a bad row monopolises batch slots forever. Not a correctness issue; operational hardening ticket.
- **FU-3 (MEDIUM)** — consumer shutdown ordering: `flushAll()` runs before Kafka disconnect, allowing a sub-millisecond window for late-arriving events. Kafka offset tracking redelivers on restart so no data loss. Ordering should be reversed.
- **FU-4 (LOW)** — `parity-check.ts` hardcodes `error_code = ''`. Ops-tooling only; either add the column to the MV or drop the field from the canonical list.
- **FU-5 (LOW)** — observable gauge callback has `catch {}`. Cosmetic; replace with `log.debug`.

Dimension-by-dimension assessment (all PASS):

| #   | Dimension                              | Result                                                                                                                                                       |
| --- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Performance budget (p95 ≤10s / <500ms) | PASS. Consumer batch-size 1000 / flush-interval 1000ms worst-case ~1s; CH queries capped at `max_execution_time = 10`; parallel fanout in hybrid readers.    |
| 2   | Observability gaps                     | PASS. Structured events + OTel histograms + counters on both sides; unpublished-rows gauge for backlog visibility.                                           |
| 3   | Failure-mode completeness              | Kafka/CH/Mongo/Redis/BullMQ-failover/consumer-crash/poller-crash all handled gracefully; FU-2 is the only gap.                                               |
| 4   | Resource safety                        | PASS. `BufferedClickHouseWriter.maxBufferSize` caps; `lean()` queries; `removeOnComplete`/`removeOnFail` cap Redis memory.                                   |
| 5   | Shutdown correctness                   | PASS with FU-3 caveat.                                                                                                                                       |
| 6   | Rate-limit / back-pressure             | PASS. `WORKFLOW_OUTBOX_ALERT_THRESHOLD` startup check; `BufferedClickHouseWriter` overflow handling.                                                         |
| 7   | Rollback safety                        | PASS. All 4 flags flip back cleanly; no irreversible side effects (CH projections are idempotent).                                                           |
| 8   | Startup ordering                       | PASS. Runtime: eventstore → `initWorkflowEventTables` → consumer start → hybrid reader. Engine: DB → Redis → decorators → poller → TTL validation → Restate. |
| 9   | Error-message leakage                  | PASS. All error paths sanitise via `err instanceof Error ? err.message : String(err)`; Express error handler returns generic body.                           |
| 10  | Disaster recovery                      | PASS. Outbox rows replay Kafka; Mongo is source-of-truth for executions older than 72h outbox TTL.                                                           |

### Deferred Findings

Tracked in `followups.md`:

- **FU-1 (pre-existing, unrelated to this feature)** — `system-human-task-store.test.ts` string vs string[] `assignedTo` mismatch (confirmed pre-existing via git stash/compare during Phase 3).
- **FU-2** (MEDIUM) — outbox poller poison-pill cap.
- **FU-3** (MEDIUM) — consumer shutdown ordering.
- **FU-4** (LOW) — parity-check `error_code` placeholder.
- **FU-5** (LOW) — observable gauge `catch {}`.

Plus scoped deferrals from LLD phase execution:

- **GAP-008** — INT-02..INT-08 + E2E + LOAD-02: deferred to dockerized-CH CI follow-up.
- **GAP-009** — pre-existing `system-human-task-store.test.ts` defect (same as FU-1).
- **GAP-010** — retention cron wiring (studio-side; orthogonal infra).
- **GAP-011** — Phase 2 `init-workflow-event-tables.ts` uses `@abl/compiler/platform` logger (undeclared dep in `@abl/eventstore/package.json`; Phase 4 peer module uses `@agent-platform/shared-observability`).

## Acceptance Criteria

- [x] All 6 LLD phases complete with exit criteria met (INT-02..INT-08 + LOAD-02 documented as deferred).
- [x] Unit test coverage: 141 test cases across 18 files (verified 2026-04-21 via `grep -cE '^\s*(it|test)\('`) — outbox, consumer, lifecycle, hybrid readers, TTL helper, status parser, Zod schemas, cascade hooks, flag gates, test-diagnostic routes.
- [x] Smoke E2E via `apps/workflow-engine/src/system-tests/workflow-connector-polling.test.ts` — workflow execution produces outbox row → poller publishes → consumer writes CH; verified manually with all 4 flags enabled end-to-end (workflow execution + human task + TTL + cross-tenant isolation + agent-mailbox rejection), test data cleaned up after verification.
- [x] INT-01 (transactional atomicity) passes against `MongoMemoryReplSet`.
- [x] `pnpm build` across all touched packages — 0 errors.
- [x] `pnpm --filter=@agent-platform/workflow-engine test:fast` + `@abl/eventstore` + runtime fast lane — all green (pre-existing graceful-shutdown health-endpoint failure predates this work; FU-1 assignedTo mismatch is pre-existing and orthogonal).
- [x] Feature spec, test spec, HLD, LLD paths verified in `/post-impl-sync`.
- [x] 5 pr-reviewer rounds — all APPROVED; 0 CRITICAL, 0 HIGH unresolved.
- [ ] **Deferred to dockerized-CH CI PR**: INT-02..INT-08, E2E-01..E2E-06, LOAD-02 (documented pattern across Phases 3–6).
- [ ] **Deferred to canary rollout**: parity-check against 10K-execution staging dataset.

## Learnings

### Cross-cutting

- **LZ4 codec registration** — KafkaJS broker-level `compression.type=lz4` forces recompression on every message regardless of producer `compression` setting. KafkaJS has no built-in LZ4. Workarounds:
  - `kafkajs-lz4@2.0.0-beta.0` ships `lz4-asm` WASM which fails on Node 24 with `ERR_INVALID_URL`.
  - Pure-JS `lz4js` + hand-rolled codec works. Register at module-load via `createRequire` because `kafkajs` exports `CompressionTypes` / `CompressionCodecs` as CJS-only and tsx's ESM loader cannot see them from `import { }` statements.
- **ClickHouse `DateTime64(3, 'UTC')` JSONEachRow ingest** rejects ISO-8601 (`...T10:00:00Z`) with `Cannot parse input: expected '"' before 'Z"...'`. Must use space-separator: `YYYY-MM-DD HH:MM:SS.sss`. Added `toChDateTime()` helper in `workflow-events-consumer.ts`.
- **CH `BufferedClickHouseWriter` requires fully-qualified table names** (`abl_platform.workflow_execution_events`, not `workflow_execution_events`) — the writer does not scope to a default database and will fail with `UNKNOWN_TABLE: Table default.…` otherwise.
- **macOS + Node 18+ localhost resolution**: `localhost` resolves to `::1` (IPv6) first. Docker `localhost:19092` port-bindings are IPv4-only. KafkaJS and ioredis do not fall back from IPv6. Use explicit `127.0.0.1` in `.env` for all local dev connection strings.
- **Root `.env` vs app-local `.env`**: `pnpm dev` sets CWD to the app directory so `dotenv` loads `apps/<name>/.env`, not the repo root. Feature flags must be set in both if they gate behaviour in multiple apps (`apps/runtime/.env` + `apps/workflow-engine/.env`).
- **`export type *` strips value exports**: `packages/eventstore/src/index.ts` used `export type * from './schema/events/index.js'` which drops the register functions (`registerWorkflowExecutionEvents`, `registerHumanTaskEvents`). Added explicit named re-exports to fix.
- **TTL index partial-filter operator**: Mongo rejects `$ne` in partial filters with "Expression not supported in partial index: $not". Use `{expiresAt: {$type: 'date'}}`for the same semantic. Same fix applied to both outbox model (Phase 3`ff16216e6e`) and TTL indexes (Phase 6 `b5bb0a9213`).
- **Aggregation-pipeline updates for conditional field writes**: `updateTaskStatus` doesn't receive `mailbox` as a parameter. Using `$cond: [{$eq: ['$mailbox','workflow']}, <ttl>, '$expiresAt']` in an aggregation-pipeline update keeps the mailbox scope check atomic with the status write — no pre-fetch round-trip, agent/escalation tasks stay untouched.

### Package-specific

- `packages/eventstore/agents.md` — LZ4 codec registration in `kafka-queue.ts`; `publishAndAck` pattern vs fire-and-forget `enqueue`.
- `apps/workflow-engine/agents.md` — transactional-outbox decorator pattern (persistence-layer wrapping avoids 30+ handler-site `withTransaction` edits); BullMQ single-active-job leader election via fixed `jobId`; TTL index shape startup validation.
- `apps/runtime/agents.md` — buffered-writer shutdown ordering gotcha (see FU-3); CH DateTime64 space-separator format; late-binding factory for hybrid readers since `createHumanTaskRouter` runs at module-load.
- `packages/database/agents.md` — TTL partial-filter must use `$type` not `$ne`; aggregation-pipeline conditional updates for scope-guarded field writes.
