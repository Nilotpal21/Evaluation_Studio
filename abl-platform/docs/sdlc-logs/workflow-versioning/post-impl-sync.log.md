# SDLC Log: Workflow Versioning — Post-Impl Sync

**Feature**: workflow-versioning
**Phase**: POST-IMPL-SYNC
**Date**: 2026-04-15

---

## Documents Updated

- [x] Feature spec: `docs/features/sub-features/workflow-versioning.md`
  - Status: PLANNED → ALPHA
  - §9 Data Model: Added `deletedAt` and `_v` fields to WorkflowVersion schema
  - §10 Key Implementation Files: Updated Tests section with 11 actual test files, added Migration Script section
  - §16 Gaps: GAP-008 marked Mitigated, added GAP-009 through GAP-012
  - §17 Testing: Replaced all NOT TESTED with actual status (14 TESTED, 3 DEFERRED, 1 PARTIAL)
- [x] Test spec: `docs/testing/sub-features/workflow-versioning.md`
  - Status: PLANNED → IN PROGRESS
  - LLD reference added
  - Coverage matrix: Updated all 20 FRs with actual ✅/PLAN/DEFERRED status
  - Test baseline: Replaced old model table with actual test file mapping (11 files)
- [x] Testing index: `docs/testing/README.md`
  - Updated row 93: PLANNED → IN PROGRESS (ALPHA) with actual counts
- [x] HLD: `docs/specs/workflow-versioning.hld.md`
  - Status: APPROVED → IMPLEMENTED
- [x] LLD: `docs/plans/2026-04-14-workflow-versioning-impl-plan.md`
  - Status: DRAFT → DONE

## Coverage Delta

| Type              | Before | After                    |
| ----------------- | ------ | ------------------------ |
| Unit tests        | 0      | 59 (4 rewritten files)   |
| Integration tests | 0      | 8 (INT-11 + trigger env) |
| E2E tests         | 0      | 19+ (3 new files)        |

## Deviations from Plan

- Phase 1 migration is implemented but not yet in the dual-write "Phase 2 cleanup" stage — workflow document retains legacy fields
- Activation atomicity (wrapping in transaction) was deferred — identified in round 5 review
- Canvas auto-save required a round 5 fix to nest payload under `definition` key
- WorkflowVersionsTab accessed wrong response field (`.data` vs `.versions`) — caught in round 5

## Remaining Gaps

### Mitigated (since initial post-impl-sync)

- GAP-001: Connector trigger version awareness — Mitigated (cron/webhook/polling + 14 unit tests)
- GAP-002: Version diff UI — Mitigated (two-click compare flow in WorkflowVersionsTab with DiffViewer dialog)
- GAP-003: WorkflowExecution workflowVersionId — Mitigated (model, store, handler)
- GAP-004: Environment-scoped event routing — Mitigated (jobData threading fixed)
- GAP-005: Export/import version-first — Mitigated (WorkflowsAssembler exports all versions; WorkflowsDisassembler parses version files + back-compat for fat workflow files)
- GAP-006: Purge job for soft-deleted workflows — Mitigated (workflow-purge-job.ts)
- GAP-007: Version collision error message — Mitigated (409 CONFLICT)
- GAP-009: Activation atomicity — Mitigated (withTransaction wrapping)
- GAP-010: VersionsTab loading/error states — Mitigated (Loader2 + error UI)
- GAP-011: Cron frozen flow resolution — Mitigated (integration test via BullMQ worker processor; 3 tests)
- GAP-012: VERSION_INACTIVE toggle guard — Mitigated (pause/resume block when owning version inactive; 5 tests)

### Still Open/Deferred

- INT-12: In-flight executions surviving version deactivation — still deferred (needs execution harness)
