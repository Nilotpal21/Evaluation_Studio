# LLD: Direct-DB-in-Routes Refactor (apps/runtime)

**Feature Spec**: _N/A — behaviour-neutral refactor, no feature spec produced._
**HLD**: _N/A — scope authored inline from refactor brief._
**Test Spec**: _N/A — existing route tests serve as regression net; new repo unit tests added in-plan._
**Status**: DONE
**Date**: 2026-04-16

---

## 0. Preamble — Why this skips feature-spec + HLD

This is a **bounded, behaviour-neutral refactor** flagged by `pre-review-audit.sh` (check 6/8, Route Layering). The refactor brief (scope, constraints, non-goals) is authoritative. The `/lld` skill normally gates on a feature-spec + HLD, but those artifacts describe _user-facing requirements_ and _architectural decisions for new behaviour_ — neither applies here. The 10 flagged call sites are a closed set; the target state is "same Mongoose queries, invoked from repo-layer functions instead of inline in route handlers."

The `/lld` clarifying-question protocol was run via `product-oracle` against the codebase and the brief. 15/15 questions were resolved without user escalation. Decisions are reproduced in §1.

---

## 1. Design Decisions

### Decision Log

| #    | Decision                                                                                                                                               | Rationale                                                                                                                                                                   | Alternatives Rejected                                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1  | Split by file: `deployments.ts` first (6 sites), then `process-api.ts` (4 sites).                                                                      | Keeps each commit to one route file + one or two repo files. Minimizes merge surface with ongoing ABLP-2 work.                                                              | By-entity ordering would touch both routes per commit; single-commit all-10 mixes two independent concerns.                                    |
| D-2  | Use **module-pattern repos** (not class-based stores) for all new functions.                                                                           | 100% of `apps/runtime/src/repos/` uses this pattern (`deployment-repo.ts`, `variable-namespace-repo.ts`).                                                                   | `MongoWorkflowDefinitionStore` (`services/stores/`) returns a typed `WorkflowDefinition` abstraction — wrong boundary for raw lean lookup.     |
| D-3  | **Separate functions** for tenant-only vs tenant+project scopes — no optional `projectId` parameter.                                                   | Explicit function names make isolation contract visible; optional args invite accidental isolation weakening.                                                               | Single function with optional `projectId` was considered but rejected per CLAUDE.md Core Invariant #1.                                         |
| D-4  | **Preserve** the filter-shape difference between process-api.ts L124 (`deleted: { $ne: true }`) and L527 (no `deleted` filter).                        | Behaviour-neutral mandate. L527's absence is plausibly intentional (allow status polling for deleted-workflow jobs). Flag as follow-up ticket, do NOT fix in this refactor. | Adding `deleted: { $ne: true }` to L527 would be a semantic change outside scope.                                                              |
| D-5  | **Two** `WorkflowVersion` repo functions: `findActiveWorkflowVersion` (with `state: 'active', deleted: false`) and `findWorkflowVersion` (no filters). | Matches intentional difference between L158 (execute — needs active) and L532 (deployment pin — state-agnostic).                                                            | Single function with filter params was considered; two explicit functions read more clearly at call sites.                                     |
| D-6  | Snapshot helpers live in **`deployment-repo.ts`** (extension), not a new file.                                                                         | `DeploymentVariableSnapshot` is a deployment-lifecycle entity; the existing file already handles `Deployment` and `SDKChannel` for deployments.                             | A new `deployment-snapshot-repo.ts` was considered; the snapshot entity's lifecycle is fully coupled to deployments.                           |
| D-7  | `Workflow` + `WorkflowVersion` + `WorkflowExecution` helpers live in a **new `workflow-repo.ts`**.                                                     | Keeps workflow-domain reads in one file; single small file rather than three tiny ones.                                                                                     | Three separate files (`workflow-repo.ts`, `workflow-version-repo.ts`, `workflow-execution-repo.ts`) was considered; overkill for ≤6 functions. |
| D-8  | Return type is **`Promise<any \| null>`** across all new functions.                                                                                    | Matches 100% of existing `apps/runtime/src/repos/` files. `any`-type cleanup is an explicit non-goal of this refactor.                                                      | Typed Mongoose document returns deferred to a separate cross-repo cleanup.                                                                     |
| D-9  | **Refactor-first, tests-after**. Run existing route tests as regression net; then add service-level unit tests for each new repo function.             | Matches CLAUDE.md "Prefer adding service-level unit tests rather than rewriting route tests." Route tests already exercise the queries.                                     | Test-first (TDD) is ill-suited because the repo functions don't exist yet to test against — they'd be stubs.                                   |
| D-10 | **No feature flag**, **no monitoring change**, **no auth semantic change**.                                                                            | Behaviour-neutral: identical Mongoose queries, same `.lean()`, same traces, same error paths.                                                                               | Feature flag would add ceremony for no user-facing change.                                                                                     |
| D-11 | Two JIRA commits, one per phase. Scope-guard hook enforces ≤40 files, ≤3 packages per commit.                                                          | Commit discipline per CLAUDE.md. Each phase fits easily within cap.                                                                                                         | Single mega-commit was considered; violates "one concern per commit".                                                                          |

### Key Interfaces & Types

All new functions return `Promise<any | null>` or `Promise<any[]>` to match existing repo conventions. Concrete signatures:

```typescript
// apps/runtime/src/repos/workflow-repo.ts (NEW FILE)

/**
 * Find a workflow by name within a tenant+project scope.
 * Call site: deployments.ts:495 (deployment validation — workflow-version manifest check).
 * Filter: { projectId, tenantId, name }
 */
export async function findWorkflowByNameAndProject(
  name: string,
  tenantId: string,
  projectId: string,
): Promise<any | null>;

/**
 * Find a workflow by _id within a tenant scope only. Caller MUST verify project
 * scope via `tenantContext.projectScope[]` after lookup (API-key auth pattern).
 * Call site: process-api.ts:124 (execute), process-api.ts:527 (status).
 *
 * NOTE: The `deleted` filter is passed by the caller — L124 sets
 * `includeDeleted: false`; L527 sets `includeDeleted: true` (status endpoint
 * intentionally allows polling executions of soft-deleted workflows, see D-4).
 */
export async function findWorkflowByIdAndTenant(
  workflowId: string,
  tenantId: string,
  opts?: { includeDeleted?: boolean },
): Promise<any | null>;

/**
 * Find a workflow version — state-agnostic (does NOT filter on state or deleted).
 * Call site: deployments.ts:532 (version-manifest validation during deployment creation).
 * Filter: { workflowId, version, tenantId, projectId }
 */
export async function findWorkflowVersion(
  workflowId: string,
  version: string,
  tenantId: string,
  projectId: string,
): Promise<any | null>;

/**
 * Find an active, non-deleted workflow version — used when executing.
 * Call site: process-api.ts:158 (execute endpoint with explicit ?version= query).
 * Filter: { workflowId, version, tenantId, projectId, state: 'active', deleted: false }
 */
export async function findActiveWorkflowVersion(
  workflowId: string,
  version: string,
  tenantId: string,
  projectId: string,
): Promise<any | null>;

/**
 * Find a workflow execution by traceId (= _id), scoped to tenant+project+workflow.
 * Call site: process-api.ts:555 (status endpoint).
 * Filter: { _id: traceId, workflowId, tenantId, projectId }
 */
export async function findWorkflowExecution(
  traceId: string,
  workflowId: string,
  tenantId: string,
  projectId: string,
): Promise<any | null>;
```

```typescript
// apps/runtime/src/repos/deployment-repo.ts (EXTENDED)

/**
 * Find a deployment's variable snapshot by deploymentId + tenantId.
 * Call sites: deployments.ts:1155, 1239, 1367, 1368.
 * Filter: { deploymentId, tenantId }
 */
export async function findDeploymentVariableSnapshot(
  deploymentId: string,
  tenantId: string,
): Promise<any | null>;
```

### Module Boundaries

| Module                                                              | Responsibility                                                               | Depends On                                                  |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `apps/runtime/src/repos/workflow-repo.ts` (NEW)                     | Data access for `Workflow`, `WorkflowVersion`, `WorkflowExecution` reads.    | `@agent-platform/database/models` (dynamic import).         |
| `apps/runtime/src/repos/deployment-repo.ts` (EXTENDED)              | Data access for `Deployment`, `SDKChannel`, `DeploymentVariableSnapshot`.    | `@agent-platform/database/models` (dynamic import).         |
| `apps/runtime/src/repos/index.ts` (EXTENDED)                        | Barrel export — adds `./workflow-repo.js`.                                   | `workflow-repo.js`.                                         |
| `apps/runtime/src/routes/deployments.ts` (MODIFIED)                 | Route handlers — replaces inline `Model.findOne(...)` with repo calls.       | `repos/deployment-repo.ts`, `repos/workflow-repo.ts` (new). |
| `apps/runtime/src/routes/process-api.ts` (MODIFIED)                 | Route handlers — same replacement.                                           | `repos/workflow-repo.ts` (new).                             |
| `apps/runtime/src/__tests__/workflow-repo.test.ts` (NEW)            | Unit tests for `workflow-repo.ts` — asserts exact filter shape per function. | In-memory MongoDB via existing test harness.                |
| `apps/runtime/src/__tests__/deployment-repo-snapshot.test.ts` (NEW) | Unit tests for `findDeploymentVariableSnapshot` — asserts filter shape.      | In-memory MongoDB via existing test harness.                |

---

## 2. File-Level Change Map

### New Files

| File                                                          | Purpose                                              | LOC Estimate |
| ------------------------------------------------------------- | ---------------------------------------------------- | ------------ |
| `apps/runtime/src/repos/workflow-repo.ts`                     | Module-pattern repo for Workflow domain reads.       | ~90          |
| `apps/runtime/src/__tests__/workflow-repo.test.ts`            | Unit tests — one per new function, asserting filter. | ~180         |
| `apps/runtime/src/__tests__/deployment-repo-snapshot.test.ts` | Unit tests for new snapshot helper.                  | ~60          |

### Modified Files

| File                                                         | Change Description                                                                                                                                                                                                           | Risk   |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `apps/runtime/src/repos/deployment-repo.ts`                  | Add `findDeploymentVariableSnapshot(deploymentId, tenantId)`. Additive.                                                                                                                                                      | Low    |
| `apps/runtime/src/repos/index.ts`                            | Add `export * from './workflow-repo.js';`. Additive.                                                                                                                                                                         | Low    |
| `apps/runtime/src/routes/deployments.ts`                     | Replace 2 × Workflow/WorkflowVersion `findOne` (L495, L532) with repo calls. Replace 4 × `DeploymentVariableSnapshot.findOne` (L1155, L1239, L1367, L1368) with repo calls. Remove dynamic imports of models at those sites. | Medium |
| `apps/runtime/src/routes/process-api.ts`                     | Replace 4 × findOne (L124 Workflow, L158 WorkflowVersion, L527 Workflow, L555 WorkflowExecution) with repo calls. Remove dynamic imports.                                                                                    | Medium |
| `apps/runtime/src/__tests__/process-api.integration.test.ts` | Mock wiring update: add `Workflow` and `WorkflowVersion` to `@agent-platform/database/models` mock (task 2.2a). Remove dead `Workflow` entry from `@agent-platform/database` mock.                                           | Low    |

### Deleted Files

None.

---

## 3. Implementation Phases

CRITICAL: Each phase is independently deployable and testable. Each commit stays within scope-guard limits (≤40 files, ≤3 packages).

### Phase 1: `deployments.ts` extraction

**Goal**: Extract all 6 direct-DB calls in `routes/deployments.ts` into repo functions; leave `process-api.ts` untouched.

**Tasks**:

1.1. Create `apps/runtime/src/repos/workflow-repo.ts` with **two** functions needed by this phase:

- `findWorkflowByNameAndProject(name, tenantId, projectId)` — for L495.
- `findWorkflowVersion(workflowId, version, tenantId, projectId)` — for L532 (state-agnostic).
  Follow the exact module-pattern from `deployment-repo.ts`: dynamic `await import('@agent-platform/database/models')`, `.lean()`, `Promise<any | null>` returns, section comments.

  1.2. Extend `apps/runtime/src/repos/deployment-repo.ts` with `findDeploymentVariableSnapshot(deploymentId, tenantId)` — used by L1155, L1239, L1367, L1368.

  1.3. Update `apps/runtime/src/repos/index.ts`: add `export * from './workflow-repo.js';`.

  1.4. In `apps/runtime/src/routes/deployments.ts`, replace all 6 call sites with repo calls. At each site, remove the now-unused inline `const { Model } = await import(...)` lines (or narrow the imported symbols if other models remain).

  1.5. Run `pnpm build --filter=@agent-platform/runtime` — must be zero errors.

  1.6. Run existing route tests: `pnpm test --filter=@agent-platform/runtime -- deployment-routes` — must stay green with zero test changes.

  1.7. Add new unit tests in `apps/runtime/src/__tests__/workflow-repo.test.ts` for `findWorkflowByNameAndProject` and `findWorkflowVersion`. Add unit tests in `apps/runtime/src/__tests__/deployment-repo-snapshot.test.ts` for `findDeploymentVariableSnapshot`. **Each test must assert the exact filter shape passed to Mongoose** (via a real in-memory model — not `vi.mock`). Pattern: seed a doc, call the repo function, assert the returned doc matches; also seed a doc with a _different_ tenantId/projectId and assert `null` is returned (isolation smoke-test).

**Files Touched**: ~5 files (2 new repo test files, 1 new repo file, 1 modified repo file, 1 modified barrel, 1 modified route file) + test updates if any. Well under 40-file cap. 1 package (runtime) only. Under 3-package cap.

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/runtime` exits 0.
- [ ] `pnpm test --filter=@agent-platform/runtime -- tools-deployment/deployment-routes` passes with 0 changes to existing test file.
- [ ] `pnpm test --filter=@agent-platform/runtime -- workflow-repo` passes with ≥4 new tests (2 per function: happy-path + isolation miss).
- [ ] `pnpm test --filter=@agent-platform/runtime -- deployment-repo-snapshot` passes with ≥2 new tests.
- [ ] `pnpm test --filter=@agent-platform/runtime` exits 0 (full runtime suite — catches regressions from barrel export or deployment-repo extension).
- [ ] `Grep Workflow\.findOne|WorkflowVersion\.findOne|DeploymentVariableSnapshot\.findOne` over `apps/runtime/src/routes/deployments.ts` returns **zero** matches.
- [ ] `tools/pre-review-audit.sh --files apps/runtime/src/routes/deployments.ts` does NOT flag check 6/8 for the 6 lines listed in the brief.
- [ ] Prettier applied to all changed files.

**Test Strategy**:

- **Unit** (new): `workflow-repo.test.ts`, `deployment-repo-snapshot.test.ts` — one happy-path + one isolation-miss per function. Real Mongoose models against in-memory MongoDB; no mocks.
- **Integration** (existing, unchanged): `__tests__/tools-deployment/deployment-routes.test.ts`, `__tests__/tools-deployment/deployment-pipeline.integration.test.ts` — act as regression net.
- **E2E** (existing, unchanged): `__tests__/tools-deployment/deployment-pipeline.e2e.test.ts`. Note: E2E tests require the serialized E2E tier (`vitest.e2e.config.ts`) and are not exercised by the default `pnpm test` command — they serve as a secondary regression net for CI.

**Rollback**: `git revert <phase-1-commit>`. Zero DB state changes (no migrations). Zero runtime wire changes. Rollback leaves codebase identical to pre-phase.

---

### Phase 2: `process-api.ts` extraction

**Goal**: Extract all 4 direct-DB calls in `routes/process-api.ts` into the `workflow-repo.ts` created in Phase 1.

**Tasks**:

2.1. Extend `apps/runtime/src/repos/workflow-repo.ts` (from Phase 1) with **three additional** functions:

- `findWorkflowByIdAndTenant(workflowId, tenantId, opts?: { includeDeleted?: boolean })` — for L124 (`includeDeleted: false`) and L527 (`includeDeleted: true`). Internally: base filter `{ _id, tenantId }`; if `!includeDeleted`, add `deleted: { $ne: true }`. Add inline comment documenting D-4 (intentional divergence between L124 and L527; link to follow-up ticket).
- `findActiveWorkflowVersion(workflowId, version, tenantId, projectId)` — for L158. Filter: `{ workflowId, version, tenantId, projectId, state: 'active', deleted: false }`.
- `findWorkflowExecution(traceId, workflowId, tenantId, projectId)` — for L555. Filter: `{ _id: traceId, workflowId, tenantId, projectId }`.

  2.2. In `apps/runtime/src/routes/process-api.ts`, replace all 4 call sites with repo calls. Add a static import from `../repos/workflow-repo.js` at the top of the file (matching the direct-import style used in `deployments.ts`). Remove the inline dynamic imports of `Workflow`, `WorkflowVersion`, `WorkflowExecution`.

  2.2a. Update the mock setup in `apps/runtime/src/__tests__/process-api.integration.test.ts` to account for the changed import chain: after refactoring, the route calls repo functions (which dynamically import from `@agent-platform/database/models`), so the existing `/models` mock must also provide `Workflow` and `WorkflowVersion`. This is a minimal mock-wiring fix — no test logic changes.

  2.3. Extend `workflow-repo.test.ts` with unit tests for the 3 new functions:

- `findWorkflowByIdAndTenant` — 3 tests: (a) found with `includeDeleted: false` and doc not deleted; (b) returns null with `includeDeleted: false` and doc soft-deleted; (c) returns doc with `includeDeleted: true` even when soft-deleted.
- `findActiveWorkflowVersion` — 3 tests: (a) happy path, (b) null when state != 'active', (c) null when deleted.
- `findWorkflowExecution` — 2 tests: happy path + isolation miss (wrong projectId returns null).

  2.4. Run `pnpm build --filter=@agent-platform/runtime`.

  2.5. Run existing process-api tests (if any) + full runtime test suite.

**Files Touched**: ~3 files modified (`workflow-repo.ts`, `process-api.ts`, `process-api.integration.test.ts`) + 1 test file extended (`workflow-repo.test.ts`). Under 40-file cap. 1 package only. Under 3-package cap.

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/runtime` exits 0.
- [ ] Existing process-api tests stay green. **Note**: `process-api.integration.test.ts` mocks `@agent-platform/database` and `@agent-platform/database/models`; after this refactor the route no longer imports models directly — the mocks must be adjusted to also provide `Workflow` and `WorkflowVersion` in the `/models` mock (or mock `../repos/workflow-repo.js` instead). This is a minimal mock-wiring fix, not a semantic change. The E2E tests (`process-api-auth.e2e.test.ts`, `process-api.e2e.test.ts`) require no changes.
- [ ] `Grep Workflow\.findOne|WorkflowVersion\.findOne|WorkflowExecution\.findOne` over `apps/runtime/src/routes/process-api.ts` returns **zero** matches.
- [ ] New unit tests for the 3 functions all pass (≥8 test cases total).
- [ ] `tools/pre-review-audit.sh --files apps/runtime/src/routes/process-api.ts` does NOT flag check 6/8 for the 4 lines listed in the brief.
- [ ] Prettier applied to all changed files.

**Test Strategy**:

- **Unit** (new): extensions to `workflow-repo.test.ts` — real MongoDB, no mocks. Each test asserts both (a) correct doc returned and (b) isolation miss returns null. The `includeDeleted` parameter gets explicit positive + negative coverage.
- **Integration** (existing): `process-api.integration.test.ts` — mock wiring updated per task 2.2a; existing test scenarios must stay green.
- **E2E** (existing, unchanged): `process-api.e2e.test.ts`, `process-api-auth.e2e.test.ts`. Note: E2E tests require the E2E tier and are not exercised by default `pnpm test`.

**Rollback**: `git revert <phase-2-commit>`. Zero DB state changes. Phase 1 remains intact — the repo functions exist but process-api.ts reverts to inline queries.

---

## 4. Wiring Checklist

CRITICAL: Every new component must be wired into its callers. This section prevents the #1 agent failure mode: writing code that nothing calls.

- [ ] **Phase 1**: `findWorkflowByNameAndProject` is called from `deployments.ts:495` (replacement).
- [ ] **Phase 1**: `findWorkflowVersion` is called from `deployments.ts:532` (replacement).
- [ ] **Phase 1**: `findDeploymentVariableSnapshot` is called from `deployments.ts:1155, 1239, 1367, 1368` (4 replacements; L1367 and L1368 are two calls inside a single `Promise.all([...])` — preserve the `Promise.all` wrapper).
- [ ] **Phase 1**: `workflow-repo.ts` is re-exported from `repos/index.ts`.
- [ ] **Phase 1**: No orphan imports left in `deployments.ts` (the old inline `await import('@agent-platform/database/models')` for `Workflow`, `WorkflowVersion`, `DeploymentVariableSnapshot` must be removed).
- [ ] **Phase 2**: `findWorkflowByIdAndTenant` is called from `process-api.ts:124` (`includeDeleted: false`) AND `process-api.ts:527` (`includeDeleted: true`).
- [ ] **Phase 2**: `findActiveWorkflowVersion` is called from `process-api.ts:158`.
- [ ] **Phase 2**: `findWorkflowExecution` is called from `process-api.ts:555`.
- [ ] **Phase 2**: No orphan imports left in `process-api.ts`.
- [ ] **Both phases**: The new repo functions are exported from `workflow-repo.ts` (not just defined).
- [ ] **Both phases**: Each new function has a JSDoc comment naming the call site (file:line) it was extracted from, and the exact filter shape.

(Not applicable to this refactor — no DI container, no new routes, no new models, no new middleware, no workers, no UI, no OpenAPI endpoints.)

---

## 5. Cross-Phase Concerns

### Database Migrations

None. All queries remain identical.

### Feature Flags

None (see D-10).

### Configuration Changes

None. No new env vars, no new config keys.

### Merge Conflict Strategy

Per oracle finding C1, `deployments.ts` and `process-api.ts` are actively evolving (ABLP-2 workflow versioning phase 3a). Mitigation:

1. **Rebase onto `main` immediately before starting each phase.**
2. **Keep each phase as a single focused commit** — minimizes bisection surface.
3. **If a rebase conflict lands on one of the 10 flagged lines**: the new line is the source of truth. Re-extract with the updated filter shape. Update the JSDoc reference.

### JIRA Ticket

Use existing workflow/runtime cleanup ticket if one exists, else create `ABLP-xxx refactor(runtime): extract direct-DB calls from route handlers`. Per CLAUDE.md: "If a commit is required and no ticket exists, create or reuse the Jira ticket before committing. Never invent placeholder keys."

### Follow-up Tickets (NOT in scope of this refactor)

- **FOLLOW-UP-1** (D-4): Evaluate whether `process-api.ts:527` (status endpoint) should reject soft-deleted workflows. Current behaviour allows polling execution status of deleted-workflow jobs. Confirm intent; if not, add `deleted: { $ne: true }` filter.
- **FOLLOW-UP-2** (B5): Systematic `any`-cleanup across `apps/runtime/src/repos/` — replace `Promise<any | null>` with typed Mongoose document returns (`IWorkflow`, `IWorkflowVersion`, etc.).

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 10 flagged direct-DB call sites are replaced with repo function calls (6 in `deployments.ts`, 4 in `process-api.ts`).
- [ ] Existing route tests (`tools-deployment/deployment-routes.test.ts`, `tools-deployment/deployment-pipeline.integration.test.ts`, `tools-deployment/deployment-pipeline.e2e.test.ts`) stay green with zero test-code changes. Process-api tests (`process-api.integration.test.ts`, `process-api.e2e.test.ts`, `process-api-auth.e2e.test.ts`) stay green — the integration test's mock setup requires a minimal wiring update (task 2.2a), but test logic is unchanged.
- [ ] New repo-level unit tests added: ≥12 test cases for `workflow-repo.test.ts` (Phase 1: ≥4, Phase 2: ≥8), ≥2 for `deployment-repo-snapshot.test.ts`. Each function has at least one happy-path + one isolation-miss assertion.
- [ ] `pnpm build --filter=@agent-platform/runtime` exits 0 after each phase commit.
- [ ] `pnpm test --filter=@agent-platform/runtime` exits 0 after each phase commit.
- [ ] `tools/pre-review-audit.sh --files apps/runtime/src/routes/deployments.ts apps/runtime/src/routes/process-api.ts` no longer flags the 10 listed lines under check 6/8 (Route Layering).
- [ ] `npx prettier --check` passes on all changed files (enforced by pre-commit hook).
- [ ] Both commits follow `[ABLP-xxx] refactor(runtime): ...` format with a real JIRA key.
- [ ] Each commit stays within scope-guard limits (≤40 files, ≤3 packages, ≤30% deletion ratio for refactor-labeled commits — note: refactor() is explicitly excluded from the deletion-ratio guard; additive-where-possible still applies).
- [ ] No isolation regressions: each repo function's JSDoc names the extracted call site and documents the filter shape verbatim.
- [ ] Two follow-up tickets created (FOLLOW-UP-1, FOLLOW-UP-2) — these are NOT blockers for closing this refactor.

---

## 7. Open Questions

None. All 15 clarifying questions resolved by `product-oracle` against the codebase; 0 AMBIGUOUS escalations.

Two items are deferred to follow-up tickets (see §5 above) and are **explicitly out of scope** for this refactor:

1. Semantic fix of `process-api.ts:527` missing `deleted` filter (D-4) → FOLLOW-UP-1.
2. Typed return types across all `apps/runtime/src/repos/` (D-8) → FOLLOW-UP-2.
