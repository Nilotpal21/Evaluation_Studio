# SDLC Log: direct-db-in-routes-refactor — Post-Implementation Sync

**Feature**: direct-db-in-routes-refactor
**Phase**: POST-IMPL-SYNC
**Date**: 2026-04-16

---

## Inventory

### Changed Files (this refactor only)

| File                                                          | Change   |
| ------------------------------------------------------------- | -------- |
| `apps/runtime/src/repos/workflow-repo.ts`                     | NEW      |
| `apps/runtime/src/repos/deployment-repo.ts`                   | MODIFIED |
| `apps/runtime/src/repos/index.ts`                             | MODIFIED |
| `apps/runtime/src/routes/deployments.ts`                      | MODIFIED |
| `apps/runtime/src/routes/process-api.ts`                      | MODIFIED |
| `apps/runtime/src/__tests__/workflow-repo.test.ts`            | NEW      |
| `apps/runtime/src/__tests__/deployment-repo-snapshot.test.ts` | NEW      |

### Commits

| Hash         | Message                                                                        |
| ------------ | ------------------------------------------------------------------------------ |
| `866eb18e1e` | `[ABLP-2] refactor(runtime): Phase 1 — extract 6 DB calls from deployments.ts` |
| `04f9885bf4` | `[ABLP-2] refactor(runtime): Phase 2 — extract 4 DB calls from process-api.ts` |
| `bd9d754d68` | `[ABLP-2] test(runtime): add missing isolation tests from review round 3`      |
| `d39b1aa`    | `[ABLP-2] docs(runtime): implementation log for direct-db-in-routes-refactor`  |

### Related SDLC Artifacts

| Artifact     | Path                                                                | Exists? |
| ------------ | ------------------------------------------------------------------- | ------- |
| Feature Spec | N/A — behaviour-neutral refactor                                    | N/A     |
| Test Spec    | N/A — existing route tests serve as regression net                  | N/A     |
| HLD          | N/A — scope authored inline from refactor brief                     | N/A     |
| LLD          | `docs/plans/2026-04-16-direct-db-in-routes-refactor-impl-plan.md`   | YES     |
| Impl Log     | `docs/sdlc-logs/direct-db-in-routes-refactor/implementation.log.md` | YES     |

## Documents Updated

- [x] LLD: `docs/plans/2026-04-16-direct-db-in-routes-refactor-impl-plan.md` — Status updated from DRAFT → DONE
- [ ] Feature spec: N/A (behaviour-neutral refactor, no feature spec)
- [ ] Test spec: N/A (no test spec)
- [ ] Testing index: N/A (internal refactor, no testing README entry)
- [ ] HLD: N/A (no HLD)

## Coverage Delta

| Type              | Before | After                                              |
| ----------------- | ------ | -------------------------------------------------- |
| Unit tests        | 0      | 17 (15 workflow-repo + 2 deployment-repo-snapshot) |
| Integration tests | 27     | 27 (mock wiring updated, zero test logic changes)  |
| E2E tests         | 24     | 24 (zero changes)                                  |

## Deviations from Plan

None. All 10 call sites replaced exactly as specified in the LLD. No semantic changes to queries. Two follow-up items remain deferred as planned:

1. **D-4 follow-up**: `process-api.ts:527` intentionally omits `deleted` filter — semantic fix out of scope
2. **D-8 follow-up**: Typed return types across all `apps/runtime/src/repos/` — deferred to cross-repo cleanup

## Remaining Gaps

- Pre-existing `parseDeploymentJson` unguarded `JSON.parse` (flagged in review R1, out of scope)
- ~~Pre-existing E2E test flakes in `workflow-crud.e2e.test.ts` (`expected 404 to be 422`) from ABLP-353~~ — RESOLVED: promote tests replaced with activate/deactivate
- `findActiveWorkflowVersion` projectId isolation test — low risk (upstream check), deferred
- `findDeploymentVariableSnapshot` deploymentId isolation test — low risk, deferred

---

## Follow-Up Sync: Data-Flow Audit Fixes (2026-04-16)

### What Changed

Workflow-engine data-flow audit identified silent data-loss bugs where Mongoose `strict: true` was dropping fields written by route handlers but not defined in schemas.

### Documents Updated

- [x] Feature spec: `docs/features/workflows.md` — Updated §6 Data Model (execution fields), §9 Gaps (GAP-14, GAP-15 mitigated), Last Updated date
- [x] Test spec: `docs/testing/workflows.md` — Updated Last Updated date
- [x] Testing index: `docs/testing/README.md` — Updated Workflows row date
- [x] LLD: already DONE, no changes
- [x] Implementation log: appended data-flow audit findings and fixes

### Files Changed (this sync)

| File                                                       | Change                                                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `packages/database/src/models/workflow-execution.model.ts` | Added: `cancelledAt`, `workflowVersion`, approval metadata on `NodeExecutionSchema`   |
| `apps/workflow-engine/src/handlers/workflow-handler.ts`    | Extended: `WorkflowExecutionInput`, `ExecutionPersistence`, `runWorkflow()` call site |
| `apps/workflow-engine/src/persistence/execution-store.ts`  | Extended: `createExecution()` input + `$setOnInsert`                                  |
| `apps/workflow-engine/src/routes/index.ts`                 | Added: `createHumanTaskResolutionRouter` barrel export                                |

### Coverage Delta

| Type                         | Before | After                               |
| ---------------------------- | ------ | ----------------------------------- |
| Unit tests (workflow-engine) | 675    | 675 (schema-only changes, all pass) |

### Deviations

None — all fixes are additive schema/interface extensions. No behavioral changes.

---

## Follow-Up Sync: E2E Fix + Zod Validation (2026-04-16)

### What Changed

1. **E2E test fix (ABLP-353)**: `workflow-crud.e2e.test.ts` had permanently broken promote tests — the `POST /versions/:v/promote` route never existed. Replaced with activate/deactivate tests matching the actual 2-state API. Test was also orphaned (not in any vitest config tier). Added to `vitest.e2e.config.ts` include and `vitest.config.ts` exclude.
2. **Zod validation — execution routes (F-4)**: Replaced manual parseInt/regex/typeof checks in `workflow-executions.ts` with `listExecutionsQuerySchema` and `executeBodySchema` Zod schemas.
3. **Zod validation — connection routes (F-8)**: Replaced raw `req.body` destructure in `connections.ts` with `createConnectionBodySchema` and `updateConnectionBodySchema` Zod schemas.

### Documents Updated

- [x] Feature spec: `docs/features/workflows.md` — §5 API: replaced promote endpoint with activate/deactivate/DELETE/PATCH version routes; updated Studio BFF description; updated version service description; §9 Gaps: GAP-16 + GAP-17 mitigated; fixed versioning description from 5-state to 2-state lifecycle
- [x] Test spec: `docs/testing/workflows.md` — Updated version service test description; added 3 new test files to Runtime table (deployment-repo-snapshot: 3, workflow-repo: 16, workflow-crud.e2e: 39); updated runtime total (134+ → 192+); updated versioning row in test matrix to show HTTP E2E coverage
- [x] Testing index: `docs/testing/README.md` — Updated workflows row E2E count (12 UI + 0 HTTP → 12 UI + 39 HTTP); updated versioning sub-feature status
- [x] HLD: `docs/specs/workflow-versioning.hld.md` — already IMPLEMENTED, no changes
- [x] LLD: `docs/plans/2026-04-14-workflow-versioning-impl-plan.md` — already DONE, no changes

### Files Changed (this sync — code)

| File                                                                 | Change                                                        |
| -------------------------------------------------------------------- | ------------------------------------------------------------- |
| `apps/runtime/src/__tests__/e2e/workflows/workflow-crud.e2e.test.ts` | Fixed: promote → activate/deactivate tests, status → state    |
| `apps/runtime/vitest.e2e.config.ts`                                  | Added: workflow-crud.e2e.test.ts to E2E tier include list     |
| `apps/runtime/vitest.config.ts`                                      | Added: workflow-crud.e2e.test.ts to default tier exclude list |
| `apps/workflow-engine/src/routes/workflow-executions.ts`             | Added: Zod schemas replacing manual validation (F-4)          |
| `apps/workflow-engine/src/routes/connections.ts`                     | Added: Zod schemas replacing raw destructure (F-8)            |

### Coverage Delta

| Type             | Before | After                                      |
| ---------------- | ------ | ------------------------------------------ |
| E2E tests (HTTP) | 0      | 39 (workflow-crud.e2e.test.ts now passing) |
| Workflow-engine  | 675    | 675 (Zod changes are validation-only)      |

### Remaining Gaps (from original post-impl-sync)

- GAP-68: Pre-existing E2E test flakes in workflow-crud.e2e.test.ts — **RESOLVED** (promote tests replaced)
- Pre-existing `parseDeploymentJson` unguarded `JSON.parse` — still deferred
- `findActiveWorkflowVersion` projectId isolation test — still deferred
- `findDeploymentVariableSnapshot` deploymentId isolation test — still deferred

---

## Follow-Up Sync: Workflow Proxy + Human Task E2E Tests (2026-04-16)

### What Changed

Added 49 E2E tests across 4 new test files covering all 28 workflow proxy endpoints (executions, triggers, approvals, notifications, connectors) and the human task resolve flow (approval approve/reject, human_task with fields, validation, associate-session). Uses a shared mock workflow engine helper — a real Express HTTP server on random port (not vi.mock), injected via `WORKFLOW_ENGINE_URL` env var.

### Documents Updated

- [x] Feature spec: `docs/features/workflows.md` — Updated GAP-01 runtime test count (192+ → 241+)
- [x] Test spec: `docs/testing/workflows.md` — Added 4 new test files to runtime table; updated test matrix with E2E coverage for human tasks, approvals, triggers, notifications, connectors; marked "Human task resolution E2E" gap as COVERED; total 241+
- [x] Testing index: `docs/testing/README.md` — Updated workflows row E2E count (12 UI + 16 HTTP → 12 UI + 65 HTTP)
- [x] LLD: N/A (test-only change)
- [x] HLD: N/A (test-only change)

### Files Changed (this sync — code)

| File                                                                               | Change                                         |
| ---------------------------------------------------------------------------------- | ---------------------------------------------- |
| `apps/runtime/src/__tests__/helpers/mock-workflow-engine.ts`                       | NEW: Shared mock workflow engine helper        |
| `apps/runtime/src/__tests__/e2e/workflows/workflow-proxy-execution.e2e.test.ts`    | NEW: 16 proxy execution E2E tests              |
| `apps/runtime/src/__tests__/e2e/workflows/workflow-proxy-triggers.e2e.test.ts`     | NEW: 10 proxy trigger E2E tests                |
| `apps/runtime/src/__tests__/e2e/workflows/workflow-proxy-admin.e2e.test.ts`        | NEW: 15 proxy admin E2E tests                  |
| `apps/runtime/src/__tests__/e2e/workflows/workflow-human-task-resolve.e2e.test.ts` | NEW: 8 human task resolve E2E tests            |
| `apps/runtime/vitest.e2e.config.ts`                                                | Added 4 new test files to E2E tier include     |
| `apps/runtime/vitest.config.ts`                                                    | Added 4 new test files to default tier exclude |

### Coverage Delta

| Type             | Before | After                               |
| ---------------- | ------ | ----------------------------------- |
| E2E tests (HTTP) | 39     | 88 (+49 proxy + human task resolve) |
| Unit tests       | 192+   | 192+ (no unit test changes)         |

### Deviations

None — all tests follow the established `startRuntimeServerHarness()` + `createMockWorkflowEngine()` pattern.
