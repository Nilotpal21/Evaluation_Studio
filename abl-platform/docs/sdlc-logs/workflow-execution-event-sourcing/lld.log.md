# LLD Log — workflow-execution-event-sourcing

**Feature**: workflow-execution-event-sourcing
**Phase**: LLD (Phase 4 of SDLC pipeline)
**Date**: 2026-04-21
**Branch**: feat/workflow-version
**Jira**: ABLP-2

---

## 1. Prerequisites Verified

- [x] Feature spec: `docs/features/sub-features/workflow-execution-event-sourcing.md` (691 lines)
- [x] HLD: `docs/specs/workflow-execution-event-sourcing.hld.md` (committed as `878afc6f2d`)
- [x] Test spec: `docs/testing/sub-features/workflow-execution-event-sourcing.md` (563 lines)
- [x] HLD audit log: `docs/sdlc-logs/workflow-execution-event-sourcing/hld.log.md`

## 2. Clarifying Questions — Oracle Summary

Spawned **product-oracle** agent with 15 questions across 3 areas (Implementation Strategy, Technical Details, Risk & Dependencies).

**Result**: All 15 classified as ANSWERED, INFERRED, or DECIDED. **Zero AMBIGUOUS — no user escalation required.**

### 2.1 Area A — Implementation Strategy

| #                             | Classification | Decision                                                                                                                                    |
| ----------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 Implementation order       | DECIDED        | 6-phase breakdown: (P1) Infra Gaps → (P2) Schema + Models → (P3) Write Path → (P4) Consume + Sink → (P5) Read Path + UI → (P6) TTL + Parity |
| A2 ExecutionStore session API | ANSWERED       | Option (a): add `options?: { session?: ClientSession }` — matches Mongoose idiom; no wrapper patterns exist in repo                         |
| A3 Kafka publish approach     | DECIDED        | Option (b): add `publishAndAck(topic, event, key?): Promise<void>` to `KafkaEventQueue` — preserves existing queue observability            |
| A4 CH DDL provisioning        | ANSWERED       | Startup-provisioned via TS template literals (`CREATE TABLE IF NOT EXISTS`). Matches `initClickHouseSchema` + `initAnalyticsTables` pattern |
| A5 Test cadence               | DECIDED        | Test-after, as dedicated `test()` commits trailing each `feat()` commit — matches repo convention + CLAUDE.md "one concern per commit"      |

### 2.2 Area B — Technical Details

| #                                  | Classification | Key Finding                                                                                                                                               |
| ---------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1 File paths                      | ANSWERED       | 15 new files + 11 modified files identified with exact paths (see LLD §2)                                                                                 |
| B2 Types                           | INFERRED       | Extend `EventCascadeHook` with optional `deleteByExecutionIds` (backward-compatible). Reuse `BufferedClickHouseWriter<T>`, `EventRegistry`, `IEventQueue` |
| B3 Migration strategy              | ANSWERED       | Mongo: declarative schema indexes (no migration tool). CH: startup-provisioned DDL functions. All idempotent via `IF NOT EXISTS` / `ensureIndex`          |
| B4 Poll interval + leader election | ANSWERED       | Outbox poll = 100ms (feature spec pinned). BullMQ repeatable pattern from `TriggerScheduler` (`workflow-outbox-publisher` queue, concurrency 1)           |
| B5 Feature flags                   | ANSWERED       | Plain `process.env` reads. No GrowthBook/Unleash server-side. Rollout via Helm values in `abl-platform-deploy`                                            |

### 2.3 Area C — Risk & Dependencies

| #                            | Classification | Key Finding                                                                                                                                                                                 |
| ---------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 Workflow-version conflict | INFERRED       | Low conflict. `ExecutionStore` already carries `workflowVersion`/`workflowVersionId`. Integration point: outbox payload must snapshot these (HLD DDL already has `workflow_version` column) |
| C2 Risk ranking              | DECIDED        | #1 ExecutionStore session refactor (affects ALL workflows) → #2 MV `_version` correctness → #3 Outbox ACK race → #4 TTL partial-filter buildup → #5 Dual-read skew                          |
| C3 Ownership                 | ANSWERED       | No CODEOWNERS file. Workflow-engine owned by Runtime/Workflows team. `packages/eventstore/` + `packages/database/` are shared — changes gated by SDLC auditor rounds                        |
| C4 Monitoring                | ANSWERED       | `@abl/compiler/platform` logger (only approved logger). `@agent-platform/shared-observability` middleware. OpenTelemetry traces. Code-defined metrics; deploy-repo-defined alerts           |
| C5 Definition of done        | ANSWERED       | Per `docs/sdlc/pipeline.md` BETA→STABLE: all 6 E2E + 8 integration scenarios pass, zero CRITICAL/HIGH gaps, 1 week staging/prod use. LOAD-01 is PLANNED→ALPHA gate                          |

## 3. Key Design Decisions Locked

1. **D-1**: 6-phase rollout with Phase 1 as isolated zero-behavior-change infra refactor (de-risks the session API change).
2. **D-2**: `KafkaEventQueue.publishAndAck(topic, event, key?)` as additive API (no existing caller changes).
3. **D-3**: `ExecutionStore` + `MongoHumanTaskStore` methods get optional `session` parameter (existing callers pass nothing; no behavior change).
4. **D-4**: CH DDL ships as TS template literals in `packages/eventstore/src/stores/clickhouse/` matching `platform-events-table.ts` pattern. Called from consumer startup.
5. **D-5**: Outbox poller uses BullMQ repeatable queue `workflow-outbox-publisher`, concurrency 1, `every: WORKFLOW_OUTBOX_POLL_INTERVAL_MS` — same blueprint as `TriggerScheduler`.
6. **D-6**: Feature flags are `process.env` reads; centralized in `apps/workflow-engine/src/outbox/flag-gates.ts` pure function.
7. **D-7**: `EventCascadeHook.deleteByExecutionIds` is **optional** to preserve backward compat for existing hook implementations.
8. **D-8**: Test-diagnostic endpoints live at `apps/workflow-engine/src/routes/test-diagnostic.ts` and `apps/runtime/src/routes/test-diagnostic.ts` — dynamic-`import()` gated on `NODE_ENV=test`.

## 4. Generated Artifact

- [x] `docs/plans/2026-04-21-workflow-execution-event-sourcing-impl-plan.md` — 6-phase LLD + implementation plan

## 5. Audit Rounds

### Round 1 — lld-reviewer (Architecture Compliance)

**Verdict**: NEEDS_CHANGES — 2 CRITICAL + 4 HIGH + 4 MEDIUM + 2 LOW.

**Findings**:

- **CRITICAL-1**: EventRegistry wildcard registration `registry.register('workflow.execution.*', ...)` doesn't match — `EventRegistry.register` stores literal keys in a Map, no wildcard resolution.
- **CRITICAL-2**: Kafka topic name inconsistency — §4.1 used `workflow-execution-events`/`workflow-human-task-events` vs the rest of the LLD using canonical `abl.workflow.execution`/`abl.human.task`.
- **HIGH**: §5.5 `PARTITION BY (tenant_id, toYYYYMM(...))` contradicted HLD pattern; test-diagnostic endpoints didn't specify auth middleware; test-diagnostic URL mismatch across LLD/HLD/test-spec; trace events deferred to P4 but P3 was independently deployable.
- **MEDIUM**: `MongoHumanTaskStore.updateTaskStatus` pre-existing `projectId` gap; commit 13 scope label missed `database`; `HumanTask.create` requires array form for session; §2.3 didn't mandate per-type registration for human-task events.
- **LOW**: Outbox `occurredAt` camelCase was consistent (no issue); docker-compose.yml Kafka topic init not a task.

**Fixes applied (8 edits)**:

1. Replaced wildcard registration with per-enum-value loop pattern; §2.3 explicit about applying same pattern for human-task events.
2. §4.1 topic names corrected to canonical `abl.workflow.execution`/`abl.human.task`.
3. §5.5 PARTITION BY corrected to `toYYYYMM(occurred_at)` only; added "do NOT include tenant_id" warning.
4. §3.6 + §4.4 now mandate `[createUnifiedAuthMiddleware, requireAuth]` stack; all queries scope by `tenantId`.
5. New §6A "LLD-to-Upstream-Doc Errata" block (LLD-E-1..LLD-E-5) for propagating URL paths + projectId gap + trace event inventory + registration pattern + PARTITION BY clarification back to HLD/test-spec via `/post-impl-sync`.
6. New §3.7 ships `workflow.outbox.enqueued` + `workflow.outbox.published` traces in Phase 3 (not deferred to P4).
7. Phase 1 §1.2 expanded: `HumanTask.create([doc], {session})` array form + pre-existing `projectId` gap fix in same refactor commit.
8. Commit 13 scope label → `feat(database,runtime)`; §5.3 adds Kafka topic provisioning sub-task.

### Round 2 — lld-reviewer (Pattern Consistency)

**Verdict**: NEEDS_CHANGES — 1 CRITICAL + 4 HIGH + 4 MEDIUM + 2 LOW.

**Findings**:

- **CRITICAL**: §3.2 reinvented Mongoose transaction management — `withTransaction()` utility already exists at `packages/shared/src/repos/mongo-tx.ts` (auto-detects replica-set support + auto-retries on `TransientTransactionError`).
- **HIGH**: `EventRegistry.validate()` expects `PlatformEvent` envelope with `.data` nesting, but workflow events are flat; §4.3 `DELETE FROM` CH syntax inconsistent with runtime's `ALTER TABLE … DELETE` convention at `cascade-repo.ts:158-159`; §4.1 `BufferedClickHouseWriter` config misrepresented as "matching defaults" (actual defaults 10000/5000, not 1000/1000); §4.1 two `KafkaEventQueue` instances would collide on default `'eventstore-consumer'` groupId → rebalance storm.
- **MEDIUM**: Outbox `_id` pattern diverges from repo `default: uuidv7` convention (intentional but undocumented); §3.3 `OutboxPoller` missing `removeOnComplete`/`removeOnFail`; §6.1 TTL pattern uses domain field `completedAt` instead of repo-standard `expiresAt` field pattern; §5.1 dual-read merger is a novel pattern with no repo precedent; §2.2 event-schema registration style diverges from repo convention without explicit justification.
- **LOW**: Concurrency 1 on outbox vs 10 on TriggerScheduler (intentional, noting); §1.5 "model mock" terminology should be "DI test double".

**Fixes applied (8 edits)**:

1. §3.2 rewritten to use `withTransaction` from `@agent-platform/shared/repos`; §1.3 Module Boundaries adds shared as a dep.
2. §4.1 clarified: `BufferedClickHouseWriter { batchSize: 1000, flushIntervalMs: 1000 }` explicitly intentionally smaller than defaults with rationale (lower-volume events, p95 ≤10s SLI); consumer uses Zod direct (not `EventRegistry.validate`); two `KafkaEventQueue` instances get explicit groupIds `workflow-execution-consumer` + `human-task-consumer`.
3. §4.3 CH delete uses `ALTER TABLE abl_platform.${table} DELETE ...` via `client.command` (matches `cascade-repo.ts:158-159`); errors propagate (no swallow).
4. Outbox `_id` now has explanatory comment documenting the divergence (`_id IS the event_id, not auto-generated`).
5. §3.3 adds `removeOnComplete: { count: 50 }` + `removeOnFail: { count: 200 }` to BullMQ job config.
6. §6.1/§6.2 switched to `expiresAt: Date | null` field pattern (aligned with `vocabulary-candidates.model.ts`, `attachment.model.ts`, `channel-session.model.ts`); state-transition code sets `expiresAt` on terminal statuses.
7. §5.1 dual-read merger location documented explicitly; promotion to `packages/database/` added as OQ #6 (deferred).
8. §2.2 now explicitly explains WHY the explicit-function registration pattern diverges from the module-level-side-effect convention (flat-object events bypass `EventRegistry.validate`, registry used for GDPR/PII metadata only) + adds barrel-file re-export instruction.
9. Added `writeWithSession(docs, session: ClientSession | null)` nullable-session handling for standalone-Mongo fallback; §1.5 "DI test double" terminology.

### Round 3 — lld-reviewer (Completeness)

**Verdict**: NEEDS_CHANGES — 2 CRITICAL + 4 HIGH + 4 MEDIUM + 2 LOW.

**Findings**:

- **CRITICAL-1**: FR-8 (plan-tiered CH retention per `EventRetentionService`) had no implementation task anywhere in the LLD.
- **CRITICAL-2**: GDPR Mongo cascade gap — `packages/database/src/cascade/cascade-delete.ts:deleteTenant()` does not include `WorkflowExecution`, `HumanTask`, `WorkflowEventOutbox`; LLD addressed only the CH side.
- **HIGH**: E2E-05 (GDPR Tenant Deletion Cascade) not scheduled in any phase; UT numbering mismatch LLD vs test-spec (LLD had phantom UT-07); 7 Prometheus metrics listed in §5.4 but no task instrumented them; docker-compose.yml Kafka topic commit mentioned but absent from commit list.
- **MEDIUM**: Phase 6 rollback referenced index name `completedAt_1` (should be `expiresAt_1` after R2 fix); wiring checklist trace event names inconsistent (`batch_flushed` vs `flush_failed`, missing `enqueued`); `writeWithSession(session: ClientSession)` non-nullable but `withTransaction` can pass `null` on standalone Mongo; `withTransaction` call-site not explicitly mapped to a file in §2.1.
- **LOW**: Acceptance criteria claimed 7 UTs (test-spec has 6); `createExecution` upsert + session options must merge, not replace.

**Fixes applied (11 edits)**:

1. New §4.6 task: `WorkflowEventLifecycle` implementing `IEventLifecycle.purgeExpired` targeting `occurred_at`; registered with `EventRetentionService`; plan-tier policy reuses `RetentionPolicy` shape.
2. New §4.7 task: extend `cascade-delete.ts:deleteTenant()` to include `WorkflowExecution`, `HumanTask` (mailbox=workflow), `WorkflowEventOutbox`; `deleteByExecutionIds` extended to purge matching Mongo rows.
3. E2E-05 added to Phase 4 exit criteria + commit 18; UT numbering aligned to test-spec canonical UT-01..UT-06; acceptance criteria count corrected to 6 UTs.
4. Prometheus metrics tasks explicit: OutboxPoller (§3.7), WorkflowEventsConsumer (§4.5), Hybrid readers (§5.2/§5.3) — all 7 metrics assigned to concrete tasks with emitter.
5. New commit 7 `chore(infra): add Kafka topics + env vars to docker-compose + env.example`.
6. Phase 6 rollback now uses `expiresAt_1` + `db.human_tasks.dropIndex('expiresAt_1')`.
7. Wiring checklist lists all 4 canonical trace events (`workflow.outbox.enqueued`, `workflow.outbox.published`, `workflow.outbox.consumed`, `workflow.consumer.flush_failed`).
8. `writeWithSession(docs, session: ClientSession | null)` with fallback behavior documented; standalone-Mongo path uses `insertMany` without session.
9. §3.2 explicit: `withTransaction` call lives in handler files (workflow-handler.ts, workflow-approvals.ts, human-task-resolution.ts), not inside the outbox writer.
10. §1.1 upsert + session merge pattern: `{ upsert: true, ...(options?.session ? { session } : {}) }`.
11. OQ #1 + OQ #2 resolved (both file paths verified to exist) → moved to §7A.

### Round 4 — phase-auditor (Cross-Phase Consistency)

**Verdict**: NEEDS_REVISION — 1 CRITICAL + 4 HIGH + 3 MEDIUM.

**Findings**:

- **CRITICAL (XP-1)**: E2E scenario numbering mismatch between LLD Phase 5 exit criteria and test-spec — E2E-03/E2E-04 descriptions were swapped; LLD's "E2E-04 cross-tenant 404" didn't exist as a standalone test-spec E2E; LLD's "E2E-06" described a latency benchmark but test-spec E2E-06 is the cross-feature chain scenario.
- **HIGH (XP-3)**: TTL approach change (completedAt → expiresAt) undocumented in errata; outbox model schema drift vs HLD §5.1 (5 refinements) undocumented; 3 new env vars (`WORKFLOW_OUTBOX_TTL_HOURS`, `WORKFLOW_MONGO_TTL_SECONDS`, `WORKFLOW_OUTBOX_ALERT_THRESHOLD`) introduced but not in feature-spec §11; Zod `step_status` field has no CH DDL column.
- **HIGH (XP-1)**: HLD §9.2 items #5 (BullMQ queue naming), #9 (PII sentinel export), #10 (Inbox agents.md) not explicitly resolved in LLD.
- **MEDIUM (XP-2)**: Phase 3 Kafka accumulation bound between P3-P4 not documented; Phase 5 §5.6 default status filter says "pending" but feature-spec + test-spec mandate `pending,assigned,in_progress`; no reference to `agents.md` updates per package.

**Fixes applied (9 edits)**:

1. Phase 5 exit criteria rewritten: E2E-03 (Monitor-Historical, deferred to P6 since it depends on MONGO_TTL), E2E-04 (Inbox default filter, correct), E2E-06 (cross-feature chain, correct); performance budget split out as separate acceptance item.
2. Commit 24 description corrected to match; new commit 29 adds E2E-03 in P6.
3. Phase 6 exit criteria + commit 29 now include E2E-03 (Monitor tab CH read-through verifies FR-7 Phase B end).
4. LLD-E-6 (TTL mechanism pattern change from completedAt to expiresAt), LLD-E-7 (outbox model 5 refinements), LLD-E-8 (3 new env vars) added to §6A errata.
5. `step_status` removed from workflow Zod schema (event_type already encodes step state transitions per HLD DDL).
6. §7A R-3/R-4/R-5 resolve HLD §9.2 #5/#9/#10.
7. Phase 3 rollback section documents Kafka accumulation bound: ~35M msgs / ~10.5 GB max between P3 and P4 deploys.
8. §5.6 default filter corrected to `status=pending,assigned,in_progress`.
9. Acceptance criteria checklist adds `agents.md` update requirement enumerated per package.

### Round 5 — lld-reviewer (Final Sweep)

**Verdict**: **APPROVED** with 1 HIGH + 2 MEDIUM + 2 LOW (non-blocking).

**Findings**:

- **HIGH**: `WorkflowEventLifecycle` specified to implement `IEventLifecycle` but only defined `purgeExpired`; interface requires 5 methods → `tsc --noEmit` would fail at P4.
- **MEDIUM**: Commit 24 (Phase 5 tests) touches 3 packages at the exact scope-guard limit — any spill pushes it over; `updateTaskStatus` projectId blast radius is 5 call-sites + 2 interface definitions (not 1 as stated).
- **LOW**: §4.6 wiring to platform retention scheduler needed sharper detail; OQ #2 (human-task TTL indexes) and OQ #5 (test-harness replica-set support) are answerable now.

**Fixes applied (5 edits)**:

1. §4.6 now specifies full `IEventLifecycle` 5-method implementation (`purgeExpired`, `scrubPII`, `deleteBySessionIds` no-op, `anonymizeActor` no-op, `deleteTenant`) with rationale per method; wiring pattern detailed (second `EventRetentionService` instance invoked from the same daily cron path).
2. §1.2 `updateTaskStatus` task now enumerates the full 5 call-sites + 2 interfaces, and adds a source-path design micro-decision (`findBySource` return extension vs `req.params.projectId` threading).
3. Commit 24 split into commits 24 (workflow-engine + runtime integration tests, 2 packages) and 25 (Studio Playwright E2E-04, 1 package) → stays within 3-package guard; Phase 6 commits renumbered 25-28 → 26-29.
4. §7A R-6 resolves OQ "human_tasks TTL collision": `grep 'expireAfterSeconds' packages/database/src/models/human-task.model.ts` returned zero — safe to add.
5. §7A R-7 resolves OQ "test-harness replica-set support": existing harness uses `MongoMemoryServer` (standalone) — Phase 3 commit 12 must add `setup-mongo-rs.ts` using `MongoMemoryReplSet` for INT-01.

**Final state**: all prior-round CRITICAL + HIGH findings are resolved and stickness verified. 4 open questions remain (all deferrable: prod tuning, UX pagination, Kafka deploy-repo topic provisioning, future-caller-driven merger promotion).

## 6. Commit

Pending: prettier + commit the LLD artifact (`docs/plans/2026-04-21-workflow-execution-event-sourcing-impl-plan.md`) and this log file.
