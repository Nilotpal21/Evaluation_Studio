# Post-Impl-Sync Log: Pipeline Engine

**Phase**: POST-IMPL-SYNC
**Date**: 2026-03-23
**Status**: Complete (1 audit round, all findings resolved)

---

## Changes Summary

### Status Corrections

| Document       | Before        | After                                           |
| -------------- | ------------- | ----------------------------------------------- |
| Feature spec   | STABLE        | ALPHA                                           |
| Test spec      | PASS          | IN PROGRESS                                     |
| Testing index  | DONE, E2E: 5+ | IN PROGRESS, E2E: 0, Integration: 4             |
| HLD            | STABLE        | APPROVED (document finalized; feature is ALPHA) |
| LLD            | STABLE        | DONE (document finalized; feature is ALPHA)     |
| Quality matrix | TBD           | ALPHA                                           |

### Coverage Delta

| Type              | Before (claimed) | After (actual)                         |
| ----------------- | ---------------- | -------------------------------------- |
| Unit tests        | 49 files PASS    | 49 files PASS (1 FAIL: eval-preflight) |
| Integration tests | 4 files PASS     | 4 files PASS                           |
| E2E tests         | 0                | 0                                      |

### Deviations from Plan

The primary deviation is the status downgrade. All SDLC docs (feature spec, HLD, LLD) used "STABLE" to mean "document is finalized" when the feature lifecycle gates were not met:

- 0 E2E tests exist (BETA requires 3+, STABLE requires 5+)
- Cross-tenant and cross-project isolation are not E2E-tested
- RBAC boundary testing does not exist

### Audit Findings Resolved

| ID    | Severity | Finding                                      | Resolution                                  |
| ----- | -------- | -------------------------------------------- | ------------------------------------------- |
| PS-1  | CRITICAL | Quality matrix summary counts wrong          | ALPHA: 0->1, TBD: 44->43, ASCII chart fixed |
| PS-3  | HIGH     | LLD rollback section says "STABLE"           | Reworded to reference ALPHA status          |
| PS-6  | HIGH     | `packages/pipeline-engine/agents.md` missing | Created with 7 learnings                    |
| PS-4  | HIGH     | Missing config-driven-integration row in §17 | Added as row 11, renumbered subsequent rows |
| PS-3b | MEDIUM   | HLD/LLD dates not updated                    | Updated to 2026-03-23                       |
| PS-5  | MEDIUM   | No cross-cutting agents.md entry             | Added process learning about status vocab   |

### Documents Updated

- `docs/features/pipeline-engine.md` — status STABLE->ALPHA, added rationale, added integration test row, updated date
- `docs/testing/pipeline-engine.md` — status PASS->IN PROGRESS, updated date
- `docs/testing/README.md` — E2E: 5+->0, Integration: 5+->4, status DONE->IN PROGRESS
- `docs/specs/pipeline-engine.hld.md` — status STABLE->APPROVED, updated date
- `docs/plans/pipeline-engine.lld.md` — status STABLE->DONE, fixed rollback text, updated date
- `docs/feature-quality-matrix.md` — TBD->ALPHA, summary counts, ASCII chart
- `packages/pipeline-engine/agents.md` — created with 7 learnings
- `docs/sdlc-logs/agents.md` — added pipeline-engine to locations, added cross-cutting entry
- `docs/sdlc-logs/pipeline-engine/post-impl-sync.log.md` — this file

### Remaining Gaps (blocking BETA)

- **GAP-007 (HIGH)**: No E2E tests — 7 scenarios defined, 0 implemented
- **GAP-006 (MEDIUM)**: No TTL/cleanup for pipeline run records in MongoDB
- **GAP-009 (MEDIUM)**: No test for Restate pipeline scheduler
- **GAP-010 (MEDIUM)**: No ClickHouse integration test
- **GAP-005 (LOW)**: console.log usage in Restate handlers
- **GAP-001 (LOW)**: eval-preflight test requires ENCRYPTION_MASTER_KEY env var

---

## Sync #2: BETA Promotion + GAP Fixes (2026-03-23)

**Status**: Complete (1 audit round, all findings resolved)

### Status Changes

| Document       | Before                      | After                                 |
| -------------- | --------------------------- | ------------------------------------- |
| Feature spec   | ALPHA                       | BETA                                  |
| Test spec      | IN PROGRESS                 | PARTIAL                               |
| Testing index  | IN PROGRESS, E2E: 0         | PARTIAL 03-23, E2E: 5, Integration: 5 |
| HLD            | APPROVED (feature is ALPHA) | APPROVED (feature is BETA)            |
| LLD            | DONE (feature is ALPHA)     | DONE (feature is BETA)                |
| Quality matrix | ALPHA                       | BETA                                  |

### Coverage Delta

| Type              | Before   | After                              |
| ----------------- | -------- | ---------------------------------- |
| Unit tests        | 49 files | 49 files (eval-preflight now PASS) |
| Integration tests | 4 files  | 5 files (+execution pipeline)      |
| E2E tests         | 0        | 5 suites (22 tests)                |

### GAPs Resolved

| GAP     | Severity | Resolution                                                             |
| ------- | -------- | ---------------------------------------------------------------------- |
| GAP-001 | Low      | Closed — test sets ENCRYPTION_MASTER_KEY in beforeEach, self-contained |
| GAP-005 | Low      | Resolved — all bare console.log migrated to createLogger in 3 files    |
| GAP-006 | Medium   | Resolved — 90-day TTL index on startedAt for pipeline_run_records      |
| GAP-007 | High     | Resolved — 5 E2E suites (22 tests) + execution pipeline integration    |

### Code Changes

- `activity-router.service.ts`: 3 console.log → structured logging (log.warn/info/error)
- `pipeline-trigger.service.ts`: 4 console.log → structured logging (log.info)
- `pipeline-run.workflow.ts`: 2 console.log → structured logging (log.warn/info)
- `pipeline-run-record.schema.ts`: Added TTL index `{ startedAt: 1, expireAfterSeconds: 7776000 }`
- `pipeline-config.e2e.test.ts`: Added E2E-4 (config validation, 5 tests) + E2E-6 (trigger states, 4 tests)
- `integration-execution-pipeline.test.ts`: New file — walkGraph → real handlers data flow (5 tests)

### Audit Findings Resolved

| Severity | Finding                                                        | Resolution                                     |
| -------- | -------------------------------------------------------------- | ---------------------------------------------- |
| CRITICAL | Test spec coverage gaps table entirely stale                   | Pruned resolved gaps, added "Resolved" section |
| CRITICAL | INT-8 status still FAIL (requires env var)                     | Updated to PASS (self-contained)               |
| HIGH     | LLD rollback section still says ALPHA                          | Updated to BETA                                |
| HIGH     | HLD/LLD/feature spec stale GAP-005/006 references in body text | Updated all references                         |
| HIGH     | Quality matrix gap count wrong                                 | Corrected to 10 (total documented)             |

### Remaining Open Gaps

- **GAP-002 (Medium)**: No Studio UI for run history — feature gap, not code quality
- **GAP-003 (Medium)**: No Studio-to-backend save for custom graph defs — feature gap
- **GAP-008 (Low)**: Human review workflow (schema only) — feature gap
- **GAP-009 (Medium)**: No Restate scheduler test — requires Restate in CI
- **GAP-010 (Medium)**: No ClickHouse integration test — requires ClickHouse in CI

---

## Sync #3: Post-Implementation Doc Accuracy (2026-03-24)

**Status**: Complete
**Context**: After `/implement pipeline-engine` completed (4 LLD phases, 5 review rounds, 780 tests passing), Phase 4 doc sync regressed the LLD metadata from BETA back to ALPHA. This sync corrects that and updates §10 to reflect all files added during implementation.

### Changes

| Document         | Change                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------- |
| LLD metadata     | `feature is ALPHA` → `feature is BETA` (regressed during implementation Phase 4 doc sync)    |
| Feature spec §10 | "Unwired Node Services" heading → "Node Type Services (wired...)" — all 7 are now wired      |
| Feature spec §10 | Added `alert-evaluation-scheduler.ts` to handlers table                                      |
| Feature spec §10 | Added 13 test files to test table (implementation phases 1-3 + pre-existing)                 |
| GAP-004          | Removed from open gaps — resolved in implementation Phase 3 (alert scheduler + failure hook) |

### Remaining Open Gaps (unchanged)

- GAP-002, GAP-003, GAP-008, GAP-009, GAP-010 — all feature gaps or infrastructure-dependent

### Phase-Auditor Round 1

**Verdict**: NEEDS_REVISION → all findings resolved

| Severity | Count | Summary                                                     | Resolution                                      |
| -------- | ----- | ----------------------------------------------------------- | ----------------------------------------------- |
| CRITICAL | 5     | HLD stale text (unwired nodes, alert evaluator not bound)   | Updated §3.5, §3.7, §9, §10, §11                |
| HIGH     | 4     | Quality matrix gap count, impl log checkbox, LLD checkboxes | Fixed all — gap count 10→14, checkboxes checked |
| MEDIUM   | 2     | Feature spec test count stale, testing README date          | Updated 450→780+ tests, date to 2026-03-24      |
