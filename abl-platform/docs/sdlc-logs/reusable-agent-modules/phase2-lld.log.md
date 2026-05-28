# SDLC Log: Reusable Agent Modules — Phase 2 LLD

**Feature**: reusable-agent-modules
**Phase**: LLD
**Date**: 2026-03-22
**LLD**: `docs/plans/2026-03-22-reusable-agent-modules-phase2-impl-plan.md`

---

## Oracle Decisions

All 15 clarifying questions resolved without user escalation.

### Implementation Strategy (Q1–Q5)

| Q   | Classification | Decision                                                         |
| --- | -------------- | ---------------------------------------------------------------- |
| Q1  | DECIDED        | Data-layer first, then API, then UI (mirrors Phase 1)            |
| Q2  | DECIDED        | Same `reusable_modules` feature flag                             |
| Q3  | ANSWERED       | Phase 1 test gaps included as Sprint 1 (before Phase 2 features) |
| Q4  | DECIDED        | In-place PATCH (alias uniqueness prevents delete+create)         |
| Q5  | ANSWERED       | Yes, re-run prerequisite validation on upgrade                   |

### Technical Details (Q6–Q10)

| Q   | Classification | Decision                                                              |
| --- | -------------- | --------------------------------------------------------------------- |
| Q6  | DECIDED        | Server-side diff endpoint (security + breaking-change classification) |
| Q7  | DECIDED        | On-demand DB query (compound index already exists)                    |
| Q8  | DECIDED        | Batch query enriching GET /module-dependencies response               |
| Q9  | DECIDED        | Archived = hidden from catalog, resolvable by existing consumers      |
| Q10 | DECIDED        | No semver ranges — explicit pin + upgrade only                        |

### Risk & Dependencies (Q11–Q15)

| Q   | Classification | Decision                                                       |
| --- | -------------- | -------------------------------------------------------------- |
| Q11 | ANSWERED       | Current mechanism sufficient; cutover E2E test is priority     |
| Q12 | ANSWERED       | Yes, deploy-time auth profile preflight (GAP-004 closure)      |
| Q13 | DECIDED        | Breaking-change classification in diff (removed = breaking)    |
| Q14 | DECIDED        | 5 structured logging metrics (upgrade count, diff views, etc.) |
| Q15 | DECIDED        | 10-point definition of done for Phase 2                        |

## Audit Rounds

| Round | Verdict       | Critical | High | Medium | Low | Notes                                                                                                   |
| ----- | ------------- | -------- | ---- | ------ | --- | ------------------------------------------------------------------------------------------------------- |
| 1     | NEEDS_CHANGES | 2        | 5    | 5      | 0   | Auth preflight unspecified, reverse dep leaks identities, PATCH missing Zod, backfill gap, atomicity    |
| 2     | NEEDS_CHANGES | 0        | 5    | 11     | 0   | Permissions on GETs, response shapes unspecified, envelope nesting, archival guard location, colocation |
| 3     | NEEDS_CHANGES | 0        | 4    | 6      | 2   | ErrorCode mismatch, stale cascade-delete ref, ReverseDepResult inconsistency, observability deferred    |
| 4     | APPROVED      | 0        | 0    | 4      | 4   | Cross-phase: feature spec + HLD will update in post-impl-sync; exit criteria baselines fixed            |
| 5     | APPROVED      | 0        | 0    | 6      | 2   | Final sweep: PATCH response envelope, wiring checklist perms, task deps, metrics table formatting       |

### Round 3 Fixes Applied

- **H1**: Changed `ErrorCode.ARCHIVE_BLOCKED` → `ErrorCode.MODULE_HAS_CONSUMERS` (existing)
- **H2**: Removed `cascade-delete.ts` from Modified Files and Sprint 2 Files Touched; added `contract-auth-validator.ts` instead
- **H3**: Updated `ReverseDepResult` → `ReverseDepResponse` with nested `summary` matching Task 2.3 response shape
- **H4**: Added Open Question #4 explicitly deferring "Richer observability UI" to Phase 3 with justification
- **M1**: Fixed `archivedAt: null` → `{ $in: [null, undefined] }` in Task 2.1
- **M2**: Added i18n `useTranslations('modules')` key specifications for all Sprint 3 UI tasks (3.1-3.4)
- **M3**: Added SWR `mutate()` cache invalidation and confirm button loading state to Task 3.1
- **M4**: Added `ModuleReleaseContract` re-export to wiring checklist; clarified import path is from `project-io`
- **M5**: Moved ToolPickerDialog/CoordinationSection to Sprint 3 only in Modified Files table (annotated with "(Sprint 3)")
- **M6**: Added 3 modified test files to Test Plan Summary (archive, catalog filter, audit events) — total 67→77
- **L1**: Added `patch()` HTTP helper to Task 3.9 bootstrap enhancement
- **L2**: Line number reference kept (low risk, pragmatic)

### Round 5 Fixes Applied

- **M1**: Fixed PATCH upgrade response to use nested `data` key matching import POST shape
- **M2**: Fixed wiring checklist permissions: MODULE_READ for diff GET + release detail GET (was incorrectly summarized as MODULE_IMPORT)
- **M3**: Reviewer flagged test files as non-existent but they DO exist (Phase 1 created them) — no change needed
- **M4**: Exit criteria baselines clarified with descriptive text instead of concrete numbers (Sprint 1 additions vary)
- **M5**: Added "(prerequisite for Task 2.1)" note to Task 2.8 (audit actions)
- **M6**: Added "(requires Task 3.1)" to Task 3.2, "(requires Task 3.9)" to Task 3.7
- **L1**: Fixed metrics table broken pipe formatting for `module.upgrade.count` row
- **L2**: Pre-existing `archivedAt: null` bug in import/preview routes noted for post-impl-sync cleanup
