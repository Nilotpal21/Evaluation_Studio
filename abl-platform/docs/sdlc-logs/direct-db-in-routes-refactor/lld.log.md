# LLD Log: direct-db-in-routes-refactor

**Date**: 2026-04-16
**Artifact**: `docs/plans/2026-04-16-direct-db-in-routes-refactor-impl-plan.md`
**Status**: DRAFT (ready for implementation)

## Prerequisites

- Feature spec: N/A (behaviour-neutral refactor)
- HLD: N/A (scope from refactor brief)
- Test spec: N/A (existing route tests as regression net)

## Product Oracle

15/15 clarifying questions answered autonomously (0 AMBIGUOUS escalations). 11 design decisions documented in LLD §1.

Key decisions:

- D-1: Split by file (deployments.ts first, process-api.ts second)
- D-3: Separate tenant-only vs tenant+project functions (no optional projectId)
- D-4: Preserve missing `deleted` filter on status endpoint (flag as follow-up)
- D-5: Two WorkflowVersion functions (state-agnostic vs active-only)

## Audit Rounds

| Round | Auditor       | Verdict | Key Findings                                                                              |
| ----- | ------------- | ------- | ----------------------------------------------------------------------------------------- |
| 1     | lld-reviewer  | PASS    | 2 MEDIUM (exit criteria wording, Promise.all note) — fixed                                |
| 2     | lld-reviewer  | PASS    | 1 MEDIUM (test file flat naming) — fixed                                                  |
| 3     | lld-reviewer  | FAIL    | 1 CRITICAL (integration test mock breakage), 2 HIGH (test paths, count floor) — all fixed |
| 4     | phase-auditor | PASS    | 1 HIGH (missing file in §2), 1 MEDIUM (Phase 1 full-suite gate) — fixed                   |
| 5     | lld-reviewer  | PASS    | 1 LOW (remaining grep escape) — fixed. All prior fixes verified stuck.                    |

## Learnings

- `process-api.integration.test.ts` mocks `@agent-platform/database` and `@agent-platform/database/models` — any refactor that changes import paths in `process-api.ts` must update mock wiring in this test file.
- Existing repo test files are flat in `__tests__/` (e.g., `repos.test.ts`), not in a `__tests__/repos/` subdirectory. Follow this convention.
- Deployment route tests live under `__tests__/tools-deployment/`, not flat in `__tests__/`. Always verify test file paths before referencing them in plans.
- L527 (process-api status endpoint) intentionally omits `deleted` filter to allow status polling for soft-deleted workflow executions. This is a D-4 follow-up item, not a bug to fix in the refactor.
