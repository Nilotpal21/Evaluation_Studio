# SDLC Log: workflow-execution-event-sourcing — Post-Impl Sync

**Feature**: workflow-execution-event-sourcing
**Phase**: POST-IMPL-SYNC
**Date**: 2026-04-21
**Branch**: `feat/workflow-runs-mongo-2-clickhouse`
**Implementation**: 38 commits (all 6 LLD phases) — see `implementation.log.md`.

---

## Documents Updated

- **Feature spec** (`docs/features/sub-features/workflow-execution-event-sourcing.md`)
  - Status: PLANNED → ALPHA (with scope note explaining deferral of integration/E2E tests)
  - §10 Key Implementation Files — rewritten to list every actual shipped file with New/Modified/Unchanged status (27 production files + 17 test files)
  - §10 Routes / Handlers — shipped `test-diagnostic.ts` + `test-diagnostic-workflow.ts` endpoints
  - §10 UI Components — shipped `UnifiedInboxPage.tsx` default-filter + toggle + hook/API `status` array support
  - §10 Jobs / Workers — shipped consumer at flat `services/` path (not `event-bus/`); shipped `WorkflowEventLifecycle`; shipped `tools/test-infra/parity-check.ts`
  - §10 Tests — SHIPPED vs DEFERRED tables with real file paths
  - §11 Configuration — added `WORKFLOW_MONGO_TTL_SECONDS`, `WORKFLOW_OUTBOX_ALERT_THRESHOLD`, `EVENT_KAFKA_BROKERS`; corrected poll interval default (1000ms not 100ms)
  - §16 Gaps — added GAP-008 (deferred integration/E2E tests), GAP-009 (pre-existing string/array test defect), GAP-010 (retention cron wiring gap), GAP-011 (Phase 2 logger-import errata)
  - §17 Testing — updated all 12 scenario statuses (SHIPPED / PARTIAL / DEFERRED) and added evidence cross-refs to §11
  - Last Updated: 2026-04-20 → 2026-04-21
- **Test spec** (`docs/testing/sub-features/workflow-execution-event-sourcing.md`)
  - HLD + LLD links — was "Pending"; now linked to the real paths
  - Status: PLANNED → PARTIAL (with GAP-008 reference)
  - §2 Current State table — Feature impl DONE, test impl PARTIAL, coverage summary
  - §4 Coverage Matrix — converted from ✓/— aspirational to ✅/🟡/❌ with FR-by-FR actual status
  - §11 Test File Mapping — split into "SHIPPED" (17 files, confirmed paths) + "DEFERRED" (14 files, planned paths with deferral reasons)
  - §13 Status — explicit PARTIAL with GAP-008 reference
  - Last Updated: 2026-04-20 → 2026-04-21
- **HLD** (`docs/specs/workflow-execution-event-sourcing.hld.md`)
  - Status: DRAFT → APPROVED (implementation complete, ALPHA feature state)
  - Added Last Sync line with HLD-level deviations (dual-read-merger location, retention cron wiring, GAP-008)
- **LLD** (`docs/plans/2026-04-21-workflow-execution-event-sourcing-impl-plan.md`)
  - Status: DRAFT → DONE (all 6 phases implemented)
  - Added Last Sync line enumerating the 4 main deviations (§3.2 decorator wiring, §3.7 trace events, §4.6 retention cron, GAP-008)
- **Testing index** (`docs/testing/README.md`)
  - Workflow Execution Event Sourcing row: PLANNED → PARTIAL with updated test counts
- **Features index** (`docs/features/README.md`)
  - Workflow Execution Event Sourcing row: PLANNED → ALPHA
- **Package agents.md** (4 files)
  - `apps/workflow-engine/agents.md` — appended 4 learnings (decorator pattern, partial-filter `$type:date`, pure-fn merger testing, flag-gated TTL index)
  - `apps/runtime/agents.md` — appended 5 learnings (Kafka groupId, late-binding factory, `BufferedClickHouseWriter` tuning, optional cascade-hook extension, fast-lane auto-exclusion)
  - `packages/database/agents.md` — appended 4 learnings (outbox 3-index pattern, optional-method extension, flag-gated TTL restart behaviour, `cascade-delete.ts` scope guards)
  - `packages/eventstore/agents.md` — CREATED (no prior file) with 5 learnings (flat-object schema + explicit registry wiring, `@abl/compiler/platform` undeclared-dep gotcha, per-row MV projection, `publishAndAck`, 5-method `IEventLifecycle` contract)
- **Post-sync auditor fixes** (post-sync round 1)
  - Added LOAD-02 row 13 to feature spec §17 scenario table (auditor finding PS-5)
  - Addressed auditor finding PS-6 by updating/creating 4 agents.md files (above)

---

## Coverage Delta

| Tier              | Before sync | After sync (SHIPPED)                        |
| ----------------- | ----------- | ------------------------------------------- |
| Unit tests        | 0           | 100+ (spread across 17 test files)          |
| Integration tests | 0           | 1 (INT-01 atomicity via MongoMemoryReplSet) |
| E2E tests         | 0           | 0 (all deferred)                            |
| LOAD tests        | 0           | 0 (LOAD-02 deferred)                        |

## Remaining Gaps

- **GAP-008 (HIGH)**: Integration + E2E + LOAD-02 tests deferred. Blocks BETA promotion. Tracked with explicit deferral paths in test spec §11.
- **GAP-010 (MEDIUM)**: `WorkflowEventLifecycle` is instantiated + exposed via `getWorkflowRetention()` but no caller wires it to `registerEventRetentionHandler`. FR-8 is code-complete but runtime-dormant.
- **GAP-011 (LOW)**: Phase 2 `init-workflow-event-tables.ts` imports `@abl/compiler/platform` (undeclared dep in eventstore). Turbo build works; vitest's native resolver does not. Phase 4 lifecycle uses the peer `@agent-platform/shared-observability` convention instead.
- **GAP-009 (LOW)**: Pre-existing `system-human-task-store.test.ts` failures — tracked separately in `followups.md`.

## Deviations from Plan

See implementation.log.md for per-phase detail. The main HLD/LLD-level deviations:

1. **Decorator-based outbox wiring** (LLD §3.2): persistence-layer decorators instead of 30+ handler-site `withTransaction` wrappings. Atomicity preserved; respects commit-scope guard.
2. **Structured-log trace events** (LLD §3.7): `createLogger` events rather than an ad-hoc `TraceStore` interface (which doesn't exist at runtime). Metrics via OTel meter (already wired in workflow-engine + runtime).
3. **Retention cron wiring deferred** (LLD §4.6): `WorkflowEventLifecycle` + `EventRetentionService` constructed; `registerEventRetentionHandler` wiring out of scope — GAP-010.
4. **Dual-read merger location** (LLD §5.1): kept in `apps/workflow-engine/src/persistence/` per the LLD; runtime inlines a local copy to avoid cross-app imports. Promotion to `packages/database/src/migration-helpers/` earmarked as LLD §7 OQ.
5. **Aggregation-pipeline `$cond` for mailbox guard** (LLD §6.2): the mailbox scope check is atomic with the status write via Mongo aggregation-pipeline update. No extra round trip.
6. **Integration/E2E/LOAD deferred** (every phase): dockerized-CH harness doesn't exist in the current test configs. All such tests tracked with explicit planned paths in the test spec.

## Review Gates Still to Run

Per the implement playbook, these phases are still outstanding before merging:

- **Wiring Verification** — walk the LLD §4 wiring checklist (15 items) and confirm each is in the shipped code.
- **PR-Reviewer Round 1..5** — code quality, HLD compliance, test coverage, security/isolation, production readiness.
- **Acceptance Verification** — confirm LLD acceptance criteria pass.

These are intentionally owner-paced and not run automatically by `/post-impl-sync`.

---

## Round-2 Sync (2026-04-21, post-review)

Second `/post-impl-sync` pass after the review gates above completed. Captures the delta from commit `a87d1e4da2` (initial sync) to the current branch head.

**What changed on the branch since initial sync**:

- Ops runbook added (`docs/guides/workflow-execution-event-sourcing-ops.md` + Feature Flags reference section)
- Pipeline debug fixes (pre-review): LZ4 codec registration in `packages/eventstore/src/queues/kafka-queue.ts`; subscribe-race fix in the same file; CH table-name qualification + `toChDateTime()` helper in `apps/runtime/src/services/workflow-events-consumer.ts`; schema registration in `apps/runtime/src/services/eventstore-singleton.ts`; explicit value re-exports in `packages/eventstore/src/index.ts`; `lz4js` added to `packages/eventstore/package.json`
- 5-round `pr-reviewer` loop (all APPROVED, 0 CRITICAL / 0 HIGH unresolved):
  - Round 1 fixes: `outbox-poller.ts` bookkeeping try/catch wraps on both success + failure paths
  - Round 2 fixes: TTL index shape startup validation in `apps/workflow-engine/src/index.ts`; `hybrid-human-task-reader.ts` comment clarification for the 2-layer mailbox scope guard
  - Round 3 fixes: extracted `parseStatusList` + `HUMAN_TASK_STATUS_VALUES` + added dedicated UT-04 parser test file (`apps/runtime/src/routes/__tests__/human-tasks-status-parser.test.ts`, 9 cases); added 2 bookkeeping-failed test cases to `outbox-poller.test.ts`
  - Round 4 fix: added `projectId` to `findOneAndUpdate` filter in `apps/runtime/src/routes/human-tasks.ts`
  - Round 5: APPROVED — 4 non-blocking follow-ups filed (FU-2 outbox poison-pill cap; FU-3 consumer shutdown ordering; FU-4 parity-check error_code placeholder; FU-5 observable-gauge catch-swallow)
- Env documentation expansion: `.env.example` + `apps/runtime/.env.example` + `apps/workflow-engine/.env.example`

**Documents Updated (this pass)**:

- **Feature spec** (`docs/features/sub-features/workflow-execution-event-sourcing.md`)
  - ALPHA scope note — added a "Post-sync integration hardening" subsection enumerating pipeline debug + round-by-round fixes + round-5 follow-ups
  - §10 Key Implementation Files — annotated `kafka-queue.ts`, `eventstore/src/index.ts`, `eventstore-singleton.ts`, `workflow-events-consumer.ts`, `hybrid-human-task-reader.ts`, `workflow-engine/src/index.ts`, `outbox-poller.ts`, `human-tasks.ts` with post-sync change descriptions
  - §10 Tests — appended row for `human-tasks-status-parser.test.ts` (UT-04 dedicated SHIPPED)
  - §17 row 6 — now references the dedicated UT-04 parser test
  - §18 References — added ops runbook + implementation-log + follow-ups links
  - Unit-test counter: 100+ → 141 cases across 18 files (verified 2026-04-21 via `grep -cE '^\s*(it|test)\('`; reflects new UT-04 parser + outbox-poller bookkeeping cases + the 16-file existing suite whose counts were never enumerated in the initial sync)
- **Test spec** (`docs/testing/sub-features/workflow-execution-event-sourcing.md`)
  - Status line — noted 141 unit cases / 18 files, 5-round pr-review APPROVED
  - §7 UT-04 scenario — expanded the input/output contract (trimmed/deduped array semantics + discriminated union), added the dedicated test-file reference
  - §11 SHIPPED — appended row for `human-tasks-status-parser.test.ts`
- **HLD** (`docs/specs/workflow-execution-event-sourcing.hld.md`) — Last Sync line updated to "round 2"; added a "Post-Implementation Notes (round-2 sync)" block enumerating the startup TTL validation (strengthens §4 concern #11), schema-registration init (strengthens §4 concern #8), LZ4 codec transport deviation, round-4 project-isolation gap closure, and the 5-round `pr-reviewer` outcome summary
- **LLD** (`docs/plans/2026-04-21-workflow-execution-event-sourcing-impl-plan.md`) — Status line updated to note review loop complete; Last Sync line updated to "round 2"; added a per-round "Post-Implementation Notes" block covering pipeline debug + rounds 1–5 + follow-ups
- **Testing index** (`docs/testing/README.md`) — row 92 updated: 141 unit cases / 18 files SHIPPED + 5-round pr-review APPROVED annotation
- **Features index** (`docs/features/README.md`) — no change (already ALPHA)
- **This log** — round-2 block appended below

**Coverage Delta (this pass)**:

| Tier              | Prior-pass count                        | Round-2 count                                               |
| ----------------- | --------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------- |
| Unit tests        | 100+ across 17 files (unverified count) | 141 cases across 18 files (verified via `grep -cE '^\s\*(it | test)\('`; added UT-04 parser file; +2 outbox-poller cases) |
| Integration tests | 1 (INT-01)                              | 1 (unchanged)                                               |
| E2E tests         | 0                                       | 0 (unchanged)                                               |
| LOAD tests        | 0                                       | 0 (unchanged)                                               |

**Remaining Gaps (this pass — unchanged)**: GAP-008 (HIGH) / GAP-010 (MEDIUM) / GAP-011 (LOW) / GAP-009 (LOW). New follow-ups FU-2..FU-5 are non-blocking for merge per round-5 verdict; they live in `followups.md`.

**Deviations from Plan (this pass)**:

- None new beyond those documented in the HLD + LLD Post-Implementation Notes blocks. The post-sync integration hardening is captured as strengthening of HLD §4 concerns (#11 migration path, #8 observability, #1 tenant isolation), not as a scope change.
