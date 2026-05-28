# SDLC Log: workflow-start-end-first-class-steps — Post-Implementation Sync

**Feature**: `workflow-start-end-first-class-steps`
**Phase**: POST-IMPL-SYNC
**Date**: 2026-04-20
**Branch**: `feat/workflow-version`
**JIRA**: ABLP-2

---

## Documents Updated

- [x] Feature spec: `docs/features/workflows.md`
  - Added FR-41..FR-44 (First-class Start/End lifecycle, input validation/coercion, mapping-error visibility)
  - Added GAP-33/GAP-34 to "Mitigated" gaps table with commit reference (2026-04-20)
  - Added `Start Input Validator` to Architecture Components table
  - Updated `workflow_executions` data model to mention `nodeExecutions.*.mappingErrors[]` + always-present boundary records
  - Bumped `Last Updated` → 2026-04-20
- [x] Test spec: `docs/testing/workflows.md`
  - Added 4 new E2E scenarios: E2E-14 (coerced-vars end-to-end), E2E-15 (validation failure across fire paths), E2E-16 (single mapping failure), E2E-17 (multi-mapping partial failure)
  - Added 5 new integration scenarios: INT-10 (tier propagation), INT-11 (payload builder never-drop), INT-12 (validator purity), INT-13 (Start/End lifecycle against real Mongo), INT-14 (route preflight)
  - Rebuilt workflow-engine test inventory table — fixed stale counts across 18+ entries (drift pre-dating this feature), removed 3 phantom files, added 10 missing files. Total recount: **881 tests across 64 files** (was "857+ across 61").
  - Bumped `Last Updated` → 2026-04-20
- [x] Testing index: `docs/testing/README.md`
  - Row 48 Workflows: "18 UI + 0 HTTP" E2E, "33 route + 16 system (start/end)" integration, date 04-20
  - Bumped header `Last Updated` → 2026-04-20 (was stale at 2026-04-16)
- [x] HLD: `docs/specs/workflow-start-end-first-class-steps.hld.md`
  - Status DRAFT → **DONE (implemented 2026-04-20)**
  - Added commit range `7f2546dc5f..fcb051e09c` + implementation log path
- [x] LLD: `docs/plans/2026-04-19-workflow-start-end-first-class-steps-impl-plan.md`
  - Status DRAFT → **DONE (implemented 2026-04-20)**
  - Added implementation log path

## Coverage Delta

| Type                       | Before | After  | Delta                                                                                                 |
| -------------------------- | ------ | ------ | ----------------------------------------------------------------------------------------------------- |
| Validator unit tests       | 0      | 34     | New — `start-input-validator.test.ts` (pure function, zero mocks)                                     |
| Handler system tests       | 0      | 16     | New — `system-handler-start-end.test.ts` (real Mongo)                                                 |
| Route preflight tests      | 0      | 4      | Extended `workflow-executions-routes.test.ts` preflight suite                                         |
| Tier propagation tests     | 0      | 5      | Extended `version-resolution.test.ts` startInputVariables suite                                       |
| Payload never-drop tests   | 0      | 2      | Extended `execution-payload.test.ts`                                                                  |
| **Gross new**              | —      | **59** | 34 + 16 + 4 + 5 + 2 across 5 files                                                                    |
| **Updated existing tests** | —      | **9**  | event-sequence changes in e2e-medium/advanced, workflow-integration, workflow-handler, system-handler |

## Feature Status

- **Before**: Defects documented in parent `workflows.md` as active gaps + silent-null end-mapping behavior (no FR)
- **After**: FR-41..FR-44 in parent spec marked `Implemented`. GAP-33/GAP-34 moved to `Mitigated`. Parent feature status remains **BETA** (no transition — this is defect repair under existing FRs, not a stage-gate advance).

## Remaining Gaps

- **GAP-02 (pre-existing)**: `InMemoryWorkflowStore`/`InMemoryHumanTaskStore` still lack max size/TTL/eviction.
- **GAP-03 (pre-existing)**: `WorkflowRuntime` compiler uses `console.warn`/`console.error` via inline log shim.
- **Accepted LOW risk (this feature)**: `JSON_PARSE_ERROR.got` in preflight response echoes V8's parse error message which may include a snippet of malformed input. Information returns to the same caller who sent it, execution record is tenant+project scoped — no cross-tenant leak. Follow-up ticket recommended to truncate.
- **Pre-existing system-human-task-store failures** (`['bob']` vs `'bob'` array/scalar coercion): verified unrelated to this feature. 2 failing tests in `system-human-task-store.test.ts` both before and after this feature landed.

## Deviations from Plan

None. All 8 LLD phases implemented as specified with 1 round-1 fix (empty-string number coercion + phase-number comment cleanup) and 1 docs-sync commit. 5 pr-review rounds all cleared.

## Commits in This Feature

- `666d3e5b94` docs: LLD addendum (WorkflowIR/tool-binding consumer map)
- `7f2546dc5f` refactor: Phase 1 — data layer + shared types
- `a80c49d081` feat: Phase 2 — payload wiring (startInputVariables through 16 sites)
- `11cda091de` feat: Phase 3 — pure validator + 31 unit tests
- `d8779e4659` feat: Phase 4 — first-class Start step lifecycle
- `f4d3bd1929` feat: Phase 5 — first-class End step lifecycle + fail-on-mapping-error
- `721c87759a` feat: Phase 6 — execute-route preflight 4xx
- `d7862f481a` refactor: Phase 7 — Studio cleanup
- `1fac07dd0a` test: Phase 8 — E2E-1 + validator anchor
- `7d8842b647` fix: pr-review round 1 findings
- `fcb051e09c` docs: agents.md learnings + implementation log
- (this commit) docs: post-impl-sync — feature/test/HLD/LLD doc sync

## Auditor Verdict

phase-auditor APPROVED round 1:

- Zero CRITICAL / HIGH findings.
- 5 MEDIUM findings all addressed: test inventory total (857+→881), phantom files removed (3), missing files added (10), stale counts recounted against real `grep -c "^\s+it("` output, testing README Last Updated date bumped.
- Cross-phase consistency: all FRs trace to implementation, terminology consistent, file paths valid, status fields aligned across all 5 artifacts.

## Learnings

- **Recurring stale test inventory pattern** across post-impl-syncs (workflow-versioning R3, webhook-versioning R2, direct-db-refactor R3, this feature) suggests the post-impl-sync skill should adopt a scripted recount step — e.g., `for f in __tests__/*.test.ts; do echo "$f $(grep -cE '^\s+it\(' $f)"; done` — as standard practice. Logged as potential skill-level improvement.
- Sub-feature work under an active parent feature (workflows.md BETA) syncs cleanly into the parent FR table — no need for a dedicated sub-feature spec when the scope is defect repair within an existing FR umbrella.
