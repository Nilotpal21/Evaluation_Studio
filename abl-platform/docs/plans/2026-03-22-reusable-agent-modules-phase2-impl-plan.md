# LLD: Reusable Agent Modules — Phase 2 (Safer Operations & Adoption UX)

**Feature Spec**: `docs/features/reusable-agent-modules.md`
**HLD**: `docs/specs/reusable-agent-modules-phase-plan.hld.md`
**Test Spec**: `docs/testing/reusable-agent-modules.md`
**Phase 1 LLD**: `docs/specs/reusable-agent-modules-phase1.lld.md`
**Status**: COMPLETE (All 3 sprints done, 5 PR review rounds passed)
**Date**: 2026-03-22

---

## 1. Design Decisions

### Decision Log

| #     | Decision                                                                               | Rationale                                                                                            | Alternatives Rejected                                               |
| ----- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| D2-1  | In-place PATCH for dependency upgrade (not delete+create)                              | Alias uniqueness constraint prevents temporary doubling; in-place is atomic and consistent           | Delete+create (window with no dependency), create-then-delete       |
| D2-2  | Same `reusable_modules` feature flag for Phase 2                                       | Additive capabilities — separate flag creates confusing states                                       | Separate `module_upgrade_flow` flag                                 |
| D2-3  | Server-side release diff (not client-side)                                             | Avoids exposing raw contracts for non-imported releases; enables breaking-change classification      | Client-side diff in browser                                         |
| D2-4  | On-demand reverse dependency queries (not materialized)                                | Compound index already exists on `ProjectModuleDependency`; low-frequency operation                  | Denormalized field on ModuleRelease, cached results                 |
| D2-5  | Batch query for update-available indicators                                            | One aggregation per dependency list load; avoids N+1; piggybacked on existing GET endpoint           | Per-dependency polling, WebSocket push                              |
| D2-6  | No semver range resolution in Phase 2                                                  | Explicit upgrade first; ranges introduce implicit drift. Ranges can be Phase 3.                      | `^1.0.0` range matching, `latest` resolution                        |
| D2-7  | Archived releases hidden from catalog but resolvable by existing users                 | Phase 1 already filters `archivedAt: null` for new imports; existing snapshots don't need release    | Auto-purge TTL, full hard delete                                    |
| D2-8  | Breaking-change classification in contract diff                                        | Users need actionable upgrade decisions; removed agents/tools and new required prereqs are breaking  | Flat diff without severity classification                           |
| D2-9  | `moduleReleaseIds` denormalized array on DeploymentModuleSnapshot                      | Enables indexed "which deployments use this release" without decompressing gzip payloads             | Decompress-and-filter on every reverse dependency query             |
| D2-10 | Phase 1 test gaps closed in Sprint 1 before Phase 2 features                           | Cutover safety and import validation are prerequisites for safe upgrade flows                        | Defer test gaps further, interleave with Phase 2 feature work       |
| D2-11 | Reverse dependency endpoint requires `MODULE_MANAGE` permission                        | Returns consumer project IDs/names — leaks project identities without owner-level access             | `MODULE_READ` (too permissive), filtered by caller access (complex) |
| D2-12 | New `validateContractAuthProfiles()` function (not reuse `evaluateAuthPreflight`)      | Existing auth-preflight is session-start OAuth consent with `AuthRequirementIR` — incompatible types | Reuse `evaluateAuthPreflight` (wrong input types)                   |
| D2-13 | Archival guard uses fallback `ProjectModuleDependency` check for pre-Phase-2 snapshots | Existing snapshots lack `moduleReleaseIds` field — `$in` query misses them                           | Backfill migration (heavyweight), accept gap (unsafe)               |
| D2-14 | Upgrade PATCH atomicity: accepted risk matching Phase 1 import pattern                 | Phase 1 import handler at `module-dependencies/route.ts:131` documents same TOCTOU acceptance        | `session.withTransaction()` (overkill for low-frequency op)         |
| D2-15 | Use existing `MODULE_RELEASE_ARCHIVED` audit action (not new `MODULE_ARCHIVED`)        | Already exists at `audit-service.ts:152`                                                             | New `MODULE_ARCHIVED` (redundant)                                   |

### Key Interfaces & Types

```typescript
// packages/project-io/src/module-release/module-contract-diff.ts

interface ContractDiffEntry {
  name: string;
  change: 'added' | 'removed' | 'modified';
  severity: 'breaking' | 'non-breaking' | 'warn';
  detail?: string;
}

// NOTE: Field names here are shortened from ModuleReleaseContract's naming convention
// (providedAgents → agents, requiredConfigKeys → configKeys, etc.). The diff function
// maps between these conventions internally.
interface ModuleContractDiff {
  agents: ContractDiffEntry[]; // maps from contract.providedAgents
  tools: ContractDiffEntry[]; // maps from contract.providedTools
  configKeys: ContractDiffEntry[]; // maps from contract.requiredConfigKeys
  envVars: ContractDiffEntry[]; // maps from contract.requiredEnvVars
  authProfiles: ContractDiffEntry[]; // maps from contract.requiredAuthProfiles
  connectors: ContractDiffEntry[]; // maps from contract.requiredConnectors
  mcpServers: ContractDiffEntry[]; // maps from contract.requiredMcpServers
  warnings: ContractDiffEntry[];
  hasBreakingChanges: boolean;
  summary: string; // e.g. "2 breaking, 3 non-breaking changes"
}

// Used by the upgrade preview endpoint
interface UpgradePreview {
  currentVersion: string;
  targetVersion: string;
  diff: ModuleContractDiff;
  prerequisiteIssues: PrerequisiteIssue[];
  // Computed from contractSnapshot.providedAgents/providedTools on the dependency
  // record (already loaded), NOT from deployment snapshot decompression.
  mountedSymbolChanges: {
    added: string[]; // new alias__symbol names
    removed: string[]; // removed alias__symbol names
    unchanged: string[];
  };
}

interface PrerequisiteIssue {
  type:
    | 'missing_env_var'
    | 'missing_auth_profile'
    | 'missing_connector'
    | 'missing_mcp_server'
    | 'missing_config_key';
  name: string;
  severity: 'blocking' | 'warning';
}

// Deploy-time auth profile validation (NOT reusing evaluateAuthPreflight —
// different input types. evaluateAuthPreflight takes AuthRequirementIR with
// connection_mode/scopes/variable_namespace_ids for session-start OAuth consent.
// This function takes contract-level { name, referencedBy } for deploy-time existence checks.)
interface ContractAuthProfileIssue {
  profileName: string;
  referencedBy: string; // dependency alias
  status: 'missing' | 'type_mismatch';
  expectedType?: string;
  actualType?: string;
}

// validateContractAuthProfiles: fail-closed on any missing profile OR any DB error.
// Collects ALL missing profiles before returning (not fail-on-first).
// Query: AuthProfile.findOne({ tenantId, projectId, name }) per required profile.
async function validateContractAuthProfiles(
  tenantId: string,
  projectId: string,
  dependencies: Array<{ alias: string; contractSnapshot: ModuleReleaseContract }>,
): Promise<{ success: boolean; issues: ContractAuthProfileIssue[] }>;

// Reverse dependency types
// NOTE: This endpoint requires MODULE_MANAGE permission (owner-level)
// to prevent leaking consumer project identities to non-owners.
interface ModuleConsumer {
  projectId: string;
  projectName: string;
  alias: string;
  resolvedVersion: string;
  resolvedReleaseId: string;
  hasActiveDeployment: boolean;
}

// Response shape uses platform envelope: { success, data, pagination, summary }
interface ReverseDepResponse {
  success: true;
  data: ModuleConsumer[];
  pagination: { nextCursor?: string; hasMore: boolean };
  summary: { totalConsumers: number; activeDeployments: number };
}

// Update-available enrichment
interface DependencyWithUpdate extends ModuleDependency {
  updateAvailable?: {
    latestVersion: string;
    latestReleaseId: string;
  };
}
```

### Module Boundaries

| Module                  | Responsibility                                           | Depends On                   |
| ----------------------- | -------------------------------------------------------- | ---------------------------- |
| `project-io`            | Contract diff logic, prerequisite re-validation          | —                            |
| `database`              | `moduleReleaseIds` field on DeploymentModuleSnapshot     | —                            |
| `studio` API routes     | Upgrade, diff, reverse dependency, archival endpoints    | `project-io`, `database`     |
| `studio` UI components  | UpgradeModuleDialog, update indicators, reverse dep view | `studio` API routes          |
| `runtime` build service | Auth profile preflight, `moduleReleaseIds` population    | `database`                   |
| `runtime` E2E tests     | Cutover safety, upgrade lifecycle                        | All of the above             |
| `studio` tests          | Import validation, tool picker, coordination section     | `studio` routes, `studio` UI |

---

## 2. File-Level Change Map

### New Files

| File                                                                                     | Purpose                                                  | LOC Estimate |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------ |
| `packages/project-io/src/module-release/module-contract-diff.ts`                         | Pure contract diff with breaking-change classification   | ~150         |
| `packages/project-io/src/__tests__/module-contract-diff.test.ts`                         | Diff unit tests: added/removed/modified, severity        | ~200         |
| `apps/studio/src/app/api/projects/[id]/module-dependencies/[dependencyId]/diff/route.ts` | Server-side diff endpoint                                | ~80          |
| `apps/studio/src/app/api/projects/[id]/module/consumers/route.ts`                        | Reverse dependency API                                   | ~80          |
| `apps/studio/src/app/api/projects/[id]/module/releases/[releaseId]/route.ts`             | Single release detail (GET) + archive action (POST)      | ~100         |
| `apps/studio/src/components/modules/UpgradeModuleDialog.tsx`                             | Upgrade flow: preview diff, validate prereqs, confirm    | ~250         |
| `apps/studio/src/components/modules/ReverseDepPanel.tsx`                                 | Show consumer projects and active deployments            | ~120         |
| `apps/runtime/src/services/modules/contract-auth-validator.ts`                           | Deploy-time auth profile existence check (fail-closed)   | ~60          |
| `apps/studio/src/__tests__/api-module-dependencies.test.ts`                              | Import validation, alias uniqueness, removal safety      | ~200         |
| `apps/studio/src/__tests__/api-module-upgrade.test.ts`                                   | Upgrade PATCH, diff endpoint, prerequisite re-validation | ~200         |
| `apps/studio/src/__tests__/api-module-consumers.test.ts`                                 | Reverse dependency endpoint tests                        | ~100         |
| `apps/studio/src/__tests__/tool-picker-imported-tools.test.tsx`                          | Imported tools read-only and provenance-labeled          | ~100         |
| `apps/studio/src/__tests__/coordination-section-imported-agents.test.tsx`                | Imported agents in routing/handoff/delegation authoring  | ~100         |
| `apps/runtime/src/__tests__/module-cutover-safety.e2e.test.ts`                           | Failed deploy leaves previous active                     | ~150         |
| `apps/runtime/src/__tests__/module-upgrade-lifecycle.e2e.test.ts`                        | Upgrade v1→v2, deploy, verify, downgrade                 | ~200         |
| `apps/studio/e2e/reusable-agent-modules-smoke.spec.ts`                                   | Browser smoke: publish, import, upgrade UX               | ~150         |

### Modified Files

| File                                                                                | Change Description                                                            | Risk   |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------ |
| `packages/database/src/models/deployment-module-snapshot.model.ts`                  | Add `moduleReleaseIds: string[]` indexed field                                | Low    |
| `apps/runtime/src/services/modules/deployment-build-service.ts`                     | Populate `moduleReleaseIds` on snapshot create; auth profile preflight        | Medium |
| `apps/studio/src/app/api/projects/[id]/module-dependencies/route.ts`                | Enrich GET response with `updateAvailable` per dependency                     | Low    |
| `apps/studio/src/app/api/projects/[id]/module-dependencies/[dependencyId]/route.ts` | Add PATCH handler for upgrade                                                 | Medium |
| `apps/studio/src/app/api/projects/[id]/module/releases/route.ts`                    | Filter archived releases from listing (add `showArchived` query param)        | Low    |
| `apps/studio/src/app/api/projects/[id]/module/route.ts`                             | Enrich response with consumer count for reverse dep indicator                 | Low    |
| `apps/studio/src/components/modules/ModuleDependencyList.tsx`                       | Add update-available badge, upgrade button (Sprint 3)                         | Low    |
| `apps/studio/src/components/modules/ModuleSettingsPanel.tsx`                        | Add link to reverse dependency panel / consumer count (Sprint 3)              | Low    |
| `apps/studio/src/components/abl/ToolPickerDialog.tsx`                               | Surface imported tools as read-only with provenance badge (Sprint 3)          | Low    |
| `apps/studio/src/components/agent-detail/CoordinationSection.tsx`                   | Surface imported agents in routing/handoff/delegation authoring (Sprint 3)    | Low    |
| `apps/studio/src/services/audit-service.ts`                                         | Add `MODULE_UPGRADED` audit action (reuse existing `MODULE_RELEASE_ARCHIVED`) | Low    |
| `packages/project-io/src/module-release/module-contract.ts`                         | Re-export `ModuleReleaseContract` type for diff consumption                   | Low    |
| `apps/studio/src/__tests__/api-module-routes.test.ts`                               | Add archive action tests                                                      | Low    |
| `apps/studio/src/__tests__/api-module-catalog-routes.test.ts`                       | Add archived-release filtering tests                                          | Low    |
| `apps/studio/src/__tests__/module-audit-events.test.ts`                             | Add upgrade and archive audit event tests                                     | Low    |
| `apps/runtime/src/__tests__/helpers/module-e2e-bootstrap.ts`                        | Add `upgradeModule()` helper method                                           | Low    |

---

## 3. Implementation Phases

### Sprint 1: Close Phase 1 Test Gaps + Data-Layer Foundations

**Goal**: Fill all remaining Phase 1 test coverage gaps and build the data-layer foundations for Phase 2 features.

**Tasks**:

1.1. **Contract diff function** — Create `packages/project-io/src/module-release/module-contract-diff.ts` with `diffModuleContracts(current: ModuleReleaseContract, target: ModuleReleaseContract): ModuleContractDiff`. Classify removed agents/tools and new required prereqs as `breaking`, added agents/tools as `non-breaking`, changed descriptions as `warn`.

1.2. **Contract diff unit tests** — Create `packages/project-io/src/__tests__/module-contract-diff.test.ts` with tests for: identical contracts, agent added, agent removed, tool type changed, new required env var, new required auth profile, mixed breaking/non-breaking, empty contracts.

1.3. **`moduleReleaseIds` on DeploymentModuleSnapshot** — Add `moduleReleaseIds: [String]` to the snapshot model with index `{ moduleReleaseIds: 1 }`. Update `deployment-build-service.ts` to populate this field from the resolved dependency release IDs during snapshot creation.

1.4. **Cutover safety E2E test** — Create `apps/runtime/src/__tests__/module-cutover-safety.e2e.test.ts` (GAP-008). Tests: (a) failed snapshot creation leaves previous deployment active, (b) no partial snapshot referenced, (c) actionable error returned, (d) retry after fix succeeds.

1.5. **Import validation Studio tests** — Create `apps/studio/src/__tests__/api-module-dependencies.test.ts`. Tests: alias uniqueness enforcement, removal safety, self-import guard, max dependency limit, config override validation, prerequisite blocking.

1.6. **Tool picker imported tools tests** — Create `apps/studio/src/__tests__/tool-picker-imported-tools.test.tsx`. Tests: imported tools appear read-only, provenance badge shown, local tools remain editable.

1.7. **Coordination section imported agents tests** — Create `apps/studio/src/__tests__/coordination-section-imported-agents.test.tsx`. Tests: imported agents appear in routing/handoff/delegation options, marked as imported with provenance label.

**Files Touched**:

- `packages/project-io/src/module-release/module-contract-diff.ts` — NEW
- `packages/project-io/src/__tests__/module-contract-diff.test.ts` — NEW
- `packages/database/src/models/deployment-module-snapshot.model.ts` — add `moduleReleaseIds` field
- `apps/runtime/src/services/modules/deployment-build-service.ts` — populate `moduleReleaseIds`
- `apps/runtime/src/__tests__/module-cutover-safety.e2e.test.ts` — NEW
- `apps/studio/src/__tests__/api-module-dependencies.test.ts` — NEW
- `apps/studio/src/__tests__/tool-picker-imported-tools.test.tsx` — NEW
- `apps/studio/src/__tests__/coordination-section-imported-agents.test.tsx` — NEW

**Exit Criteria**:

- [ ] `pnpm build --filter=project-io` succeeds with 0 errors
- [ ] `pnpm build --filter=@agent-platform/database` succeeds with 0 errors
- [ ] `pnpm test --filter=project-io -- module-contract-diff` — all contract diff tests pass (minimum 15 tests)
- [ ] `pnpm test --filter=runtime -- module-cutover-safety` — all cutover safety E2E tests pass (minimum 4 tests)
- [ ] `pnpm test --filter=@agent-platform/studio -- api-module-dependencies` — all import validation tests pass (minimum 10 tests)
- [ ] `pnpm test --filter=@agent-platform/studio -- tool-picker-imported` — all tool picker tests pass (minimum 5 tests)
- [ ] `pnpm test --filter=@agent-platform/studio -- coordination-section-imported` — all coordination section tests pass (minimum 5 tests)
- [ ] All existing Phase 1 module tests continue to pass (325+)
- [ ] `moduleReleaseIds` field is populated on snapshot creation and indexed

**Test Strategy**:

- Unit: contract diff function with 15+ test cases covering all severity classifications
- Integration: Studio route tests for import validation (mocked DB, real route handler logic)
- E2E: cutover safety with real Runtime server, real deployments, real failure scenarios

**Rollback**: Revert all Sprint 1 commits. `moduleReleaseIds` field is additive (no migration needed).

---

### Sprint 2: API Routes — Upgrade, Reverse Dependency, Diff, Archival

**Goal**: Ship the server-side API surface for upgrade flow, reverse dependency queries, release diff, and release archival.

**Tasks**:

2.1. **Upgrade PATCH endpoint** — Add `PATCH` export to `apps/studio/src/app/api/projects/[id]/module-dependencies/[dependencyId]/route.ts`. Uses `withRouteHandler` with `requireProject: true`, `permissions: StudioPermission.MODULE_IMPORT`, `requireFeature: 'reusable_modules'`, and `bodySchema: UpgradeSchema`.

**Zod schema**: `UpgradeSchema = z.object({ targetReleaseId: z.string().min(1), configOverrides: z.record(z.string()).optional() })`

**Flow**: (a) load current dependency by `{ _id: dependencyId, tenantId, projectId }`, (b) load target release by `{ _id: targetReleaseId, tenantId, moduleProjectId: dep.moduleProjectId, archivedAt: { $in: [null, undefined] } }` and verify exists, (c) re-validate prerequisites from target release contract against consumer project, (d) compute mounted symbol changes from current vs target contract, (e) `findOneAndUpdate` to update `resolvedReleaseId`, `resolvedVersion`, `configOverrides`, `contractSnapshot`, (f) increment `moduleDependencyVersion` on the project (separate DB op — accepted TOCTOU risk matching Phase 1 import pattern at `module-dependencies/route.ts:131`), (g) emit `MODULE_UPGRADED` audit event. Returns `NextResponse.json({ success: true, data: { id, alias, moduleProjectId, moduleProjectName, resolvedReleaseId, resolvedVersion, previousVersion, diff: { hasBreakingChanges, summary } } })` (nested `data` key matching existing import POST shape).

2.2. **Diff endpoint** — Create `apps/studio/src/app/api/projects/[id]/module-dependencies/[dependencyId]/diff/route.ts` (GET). Uses `withRouteHandler` with `requireProject: true`, `permissions: StudioPermission.MODULE_READ`, `requireFeature: 'reusable_modules'`. Validates `targetReleaseId` query param (must be non-empty string). Returns `UpgradePreview` with contract diff, prerequisite issues, and mounted symbol changes via `actionJson()`. Uses the `diffModuleContracts()` function from Sprint 1.

2.3. **Reverse dependency endpoint** — Create `apps/studio/src/app/api/projects/[id]/module/consumers/route.ts` (GET). Uses `withRouteHandler` with `requireProject: true`, `permissions: StudioPermission.MODULE_MANAGE` (owner-level — prevents leaking consumer project identities to non-owners), `requireFeature: 'reusable_modules'`. Supports cursor pagination: `?cursor=<lastId>&limit=<n>` (default limit 20, max 100). Queries `ProjectModuleDependency.find({ tenantId, moduleProjectId })` and enriches with project names (via `Project.find`) and active deployment status (via `DeploymentModuleSnapshot.find({ tenantId, moduleReleaseIds: { $in: releaseIds } })`). Returns `{ success: true, data: ModuleConsumer[], pagination: { nextCursor, hasMore }, summary: { totalConsumers, activeDeployments } }`.

2.4. **Single release detail + archive action** — Create `apps/studio/src/app/api/projects/[id]/module/releases/[releaseId]/route.ts`. GET uses `withRouteHandler` with `requireProject: true`, `permissions: StudioPermission.MODULE_READ`, `requireFeature: 'reusable_modules'`. Returns release detail including contract (excludes `compiledIR` to avoid leaking full IR) via `actionJson()`. POST uses `withRouteHandler` with `requireProject: true`, `permissions: StudioPermission.MODULE_MANAGE`, `requireFeature: 'reusable_modules'`, `bodySchema: z.object({ action: z.enum(['archive']) })`. Sets `archivedAt` after verifying no active pointers or deployment snapshots reference the release (archival guard check in the route handler, not in `cascade-delete.ts`). Returns `actionJson({ message: 'Release archived', releaseId, version })`.

2.5. **Update-available enrichment** — Modify `GET /module-dependencies` to batch-query latest non-archived release per dependent module. Aggregation: `ModuleRelease.aggregate([{ $match: { tenantId, moduleProjectId: { $in: depModuleIds }, archivedAt: { $in: [null, undefined] } }}, { $sort: { createdAt: -1 }}, { $group: { _id: '$moduleProjectId', latestVersion: { $first: '$version' }, latestReleaseId: { $first: '$_id' }}}])`. Compare each dependency's `resolvedVersion` against `latestVersion`. Include `updateAvailable: { latestVersion, latestReleaseId }` when different.

2.6. **Deploy-time auth profile preflight** — Create a NEW file `apps/runtime/src/services/modules/contract-auth-validator.ts` containing `validateContractAuthProfiles(tenantId, projectId, dependencies)` (do NOT reuse `evaluateAuthPreflight` — incompatible input types; do NOT add to the already 536-line `deployment-build-service.ts`). Called from `deployment-build-service.ts` after loading dependencies and before building the snapshot. For each dependency's `contractSnapshot.requiredAuthProfiles`, queries `AuthProfile.findOne({ tenantId, projectId, name })`. Collects ALL missing profiles before returning (not fail-on-first). **Fails closed**: returns `{ success: false }` on any missing profile OR any DB error. On failure, the build service returns 422 with actionable remediation listing which profiles are missing, which dependency requires them, and expected auth type.

2.7. **Strengthen archival guards** — In the archive POST route handler (Task 2.4), add a two-layer guard before setting `archivedAt`: (a) check `ModuleEnvironmentPointer.exists({ tenantId, moduleProjectId, moduleReleaseId: releaseId })` for active pointers, (b) primary: `DeploymentModuleSnapshot.exists({ moduleReleaseIds: releaseId })` for Phase 2+ snapshots, (c) fallback: `ProjectModuleDependency.exists({ tenantId, resolvedReleaseId: releaseId })` for pre-Phase-2 snapshots. If any returns true, return `errorJson('Release is in use', 409, ErrorCode.MODULE_HAS_CONSUMERS)` with blocking reference details.

2.8. **Audit actions** (prerequisite for Task 2.1) — Add `MODULE_UPGRADED` to `AuditActions` in `audit-service.ts`. Use existing `MODULE_RELEASE_ARCHIVED` (already at `audit-service.ts:152`) for archive events — do NOT create a new `MODULE_ARCHIVED`.

2.9. **Upgrade and diff route tests** — Create `apps/studio/src/__tests__/api-module-upgrade.test.ts`. Tests: successful upgrade, prerequisite failure blocks upgrade, archived release blocked, downgrade (re-pin older version), `moduleDependencyVersion` incremented, audit event emitted, diff endpoint returns correct breaking/non-breaking classification.

2.10. **Reverse dependency and archive route tests** — Create `apps/studio/src/__tests__/api-module-consumers.test.ts`. Tests: consumers listed correctly, cross-tenant returns empty, active deployment indicator, archive blocked by deployment snapshot, archive success when unreferenced.

**Files Touched**:

- `apps/studio/src/app/api/projects/[id]/module-dependencies/[dependencyId]/route.ts` — add PATCH
- `apps/studio/src/app/api/projects/[id]/module-dependencies/[dependencyId]/diff/route.ts` — NEW
- `apps/studio/src/app/api/projects/[id]/module/consumers/route.ts` — NEW
- `apps/studio/src/app/api/projects/[id]/module/releases/[releaseId]/route.ts` — NEW
- `apps/studio/src/app/api/projects/[id]/module-dependencies/route.ts` — enrich GET
- `apps/runtime/src/services/modules/deployment-build-service.ts` — auth profile preflight call
- `apps/runtime/src/services/modules/contract-auth-validator.ts` — NEW (from Task 2.6)
- `apps/studio/src/services/audit-service.ts` — new audit actions
- `apps/studio/src/__tests__/api-module-upgrade.test.ts` — NEW
- `apps/studio/src/__tests__/api-module-consumers.test.ts` — NEW
- `apps/studio/src/__tests__/api-module-routes.test.ts` — archive tests
- `apps/studio/src/__tests__/module-audit-events.test.ts` — upgrade/archive audit tests

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/studio` succeeds with 0 errors
- [ ] `pnpm build --filter=runtime` succeeds with 0 errors
- [ ] `pnpm test --filter=@agent-platform/studio -- api-module-upgrade` — all upgrade route tests pass (minimum 12 tests)
- [ ] `pnpm test --filter=@agent-platform/studio -- api-module-consumers` — all reverse dependency tests pass (minimum 8 tests)
- [ ] PATCH upgrade: `resolvedReleaseId` updated, `moduleDependencyVersion` incremented, audit event emitted
- [ ] PATCH upgrade with missing auth profile: returns 422 with actionable remediation
- [ ] Diff endpoint: returns `hasBreakingChanges: true` when agent is removed
- [ ] Reverse dependency: lists consumer projects with active deployment indicator
- [ ] Archive: blocked when deployment snapshot references the release
- [ ] All existing module tests (325+ Phase 1 + Sprint 1 additions) continue to pass
- [ ] Auth profile preflight in deployment build service validates all dependency contracts

**Test Strategy**:

- Unit/Integration: Studio route tests for all new endpoints (mocked DB, real route handler chain)
- Integration: auth profile preflight validation in deployment build service

**Rollback**: Revert Sprint 2 commits. New routes are additive. PATCH handler does not affect existing dependency creation/deletion.

---

### Sprint 3: UI Components + Upgrade E2E + Browser Smoke

**Goal**: Ship the Studio UI for upgrade flow, update indicators, and reverse dependency visibility. Add end-to-end and browser smoke tests.

**Tasks**:

3.1. **UpgradeModuleDialog** — Create `apps/studio/src/components/modules/UpgradeModuleDialog.tsx`. Flow: (a) fetch diff via `[dependencyId]/diff?targetReleaseId=...`, (b) display breaking/non-breaking changes with severity indicators, (c) show prerequisite issues (blocking issues disable confirm), (d) show mounted symbol changes (added/removed), (e) confirm triggers PATCH upgrade with loading/disabled state on the confirm button during request, (f) on success, call `mutate()` on the SWR `/module-dependencies` key to refresh the dependency list (matches existing `useSWR` cache invalidation pattern in Studio). All user-visible strings use `useTranslations('modules')` from `next-intl` — keys: `upgrade.title`, `upgrade.breaking`, `upgrade.nonBreaking`, `upgrade.confirm`, `upgrade.cancel`, `upgrade.prerequisiteBlocking`, `upgrade.symbolsAdded`, `upgrade.symbolsRemoved`.

3.2. **Update-available indicators** (requires Task 3.1) — Modify `ModuleDependencyList.tsx` to display an "Update available" badge next to each dependency where `updateAvailable` is present. Badge shows `→ v{latestVersion}`. Clicking opens UpgradeModuleDialog. Badge text uses `useTranslations('modules')` key `dependency.updateAvailable`.

3.3. **Reverse dependency panel** — Create `apps/studio/src/components/modules/ReverseDepPanel.tsx`. Shows consumer projects with alias, pinned version, and active deployment indicator. Linked from ModuleSettingsPanel (new "N projects use this module" line with expandable detail). User-visible strings use `useTranslations('modules')` keys: `consumers.title`, `consumers.count`, `consumers.activeDeployment`, `consumers.empty`.

3.4. **Archive release UI** — Add archive button to release list items (in releases route GET listing or a new release detail page). Confirm dialog warns about downstream impact using `useTranslations('modules')` keys: `archive.confirm`, `archive.warning`, `archive.blocked`. Calls POST `[releaseId]` with `{ action: 'archive' }`.

3.5. **Tool picker provenance integration** — Modify `ToolPickerDialog.tsx` to filter imported tools with a `[imported]` badge, `read-only` state, and provenance tooltip showing `alias → module name v{version}`.

3.6. **Coordination section integration** — Modify `CoordinationSection.tsx` to include imported agents in routing targets, handoff targets, and delegation targets. Show provenance badge and read-only indicator.

3.7. **Upgrade lifecycle E2E test** (requires Task 3.9) — Create `apps/runtime/src/__tests__/module-upgrade-lifecycle.e2e.test.ts`. Tests: (a) upgrade v1.0.0 → v1.1.0, deploy, verify new behavior, (b) downgrade back to v1.0.0, deploy, verify original behavior, (c) upgrade with breaking change (removed agent) — deploy fails with actionable error, (d) upgrade with new required auth profile — deploy preflight fails.

3.8. **Browser smoke test** — Create `apps/studio/e2e/reusable-agent-modules-smoke.spec.ts` (GAP-009). Tests: (a) open module project, publish a release, verify release appears in list, (b) open consumer project, import module, verify dependency list shows it, (c) verify update-available badge appears after publishing v1.1.0, (d) verify feature-disabled state hides module UI.

3.9. **E2E bootstrap enhancement** — Add `patch()` HTTP helper to `module-e2e-bootstrap.ts` (currently has `get()`, `post()`, `put()`, `del()` but no `patch()`). Then add `upgradeModule(consumerProjectId, dependencyId, targetReleaseId)` which calls `patch()` internally.

**Files Touched**:

- `apps/studio/src/components/modules/UpgradeModuleDialog.tsx` — NEW
- `apps/studio/src/components/modules/ReverseDepPanel.tsx` — NEW
- `apps/studio/src/components/modules/ModuleDependencyList.tsx` — update-available badge + upgrade action
- `apps/studio/src/components/modules/ModuleSettingsPanel.tsx` — reverse dep link
- `apps/studio/src/components/abl/ToolPickerDialog.tsx` — imported tool provenance
- `apps/studio/src/components/agent-detail/CoordinationSection.tsx` — imported agent targets
- `apps/runtime/src/__tests__/module-upgrade-lifecycle.e2e.test.ts` — NEW
- `apps/studio/e2e/reusable-agent-modules-smoke.spec.ts` — NEW
- `apps/runtime/src/__tests__/helpers/module-e2e-bootstrap.ts` — add `upgradeModule()`

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/studio` succeeds with 0 errors
- [ ] UpgradeModuleDialog renders diff with breaking/non-breaking indicators
- [ ] ModuleDependencyList shows update-available badge when newer version exists
- [ ] ReverseDepPanel lists consumer projects with deployment status
- [ ] ToolPickerDialog shows imported tools as read-only with provenance
- [ ] CoordinationSection includes imported agents in routing/handoff/delegation targets
- [ ] `pnpm test --filter=runtime -- module-upgrade-lifecycle` — all upgrade E2E tests pass (minimum 4 tests)
- [ ] Browser smoke tests pass (minimum 4 scenarios)
- [ ] All existing module tests (325+ Phase 1 + Sprint 1-2 additions) continue to pass

**Test Strategy**:

- E2E: Full upgrade lifecycle through Runtime API — upgrade, deploy, verify, downgrade, breaking change detection
- Browser smoke: Playwright tests for publish, import, upgrade indicator, and feature gate UX
- UI: Component tests for UpgradeModuleDialog, ReverseDepPanel render behavior

**Rollback**: Revert Sprint 3 commits. UI components are additive. E2E tests are independent.

---

## 4. Wiring Checklist

CRITICAL: Every new component must be wired into its callers.

- [ ] PATCH handler exported from `[dependencyId]/route.ts` (Next.js auto-routes)
- [ ] GET handler exported from `[dependencyId]/diff/route.ts` (Next.js auto-routes)
- [ ] GET handler exported from `module/consumers/route.ts` (Next.js auto-routes)
- [ ] GET + POST handlers exported from `module/releases/[releaseId]/route.ts` (Next.js auto-routes)
- [ ] All new routes include `requireFeature: 'reusable_modules'` in route handler options
- [ ] All new routes include appropriate `permissions` (MODULE_MANAGE for archive + consumers, MODULE_IMPORT for upgrade PATCH, MODULE_READ for diff GET + release detail GET)
- [ ] `diffModuleContracts` exported from `packages/project-io/src/module-release/module-contract-diff.ts`
- [ ] `diffModuleContracts` exported from `packages/project-io/src/module-release/index.ts` (barrel)
- [ ] `ModuleReleaseContract` type re-exported from `packages/project-io/src/module-release/index.ts` (barrel) — consumers of `diffModuleContracts` import from `project-io`, not `database`
- [ ] `validateContractAuthProfiles` exported from `apps/runtime/src/services/modules/contract-auth-validator.ts` and imported in `deployment-build-service.ts`
- [ ] `MODULE_UPGRADED` added to `AuditActions` enum (use existing `MODULE_RELEASE_ARCHIVED` for archive)
- [ ] `moduleReleaseIds` field added to DeploymentModuleSnapshot model schema
- [ ] `moduleReleaseIds` index created in model definition
- [ ] `UpgradeModuleDialog` imported and rendered from `ModuleDependencyList.tsx`
- [ ] `ReverseDepPanel` imported and rendered from `ModuleSettingsPanel.tsx`
- [ ] Imported tool provenance wired in `ToolPickerDialog.tsx`
- [ ] Imported agent targets wired in `CoordinationSection.tsx`
- [ ] Feature-resolver mock added to all new Studio test files
- [ ] `upgradeModule()` helper added to `module-e2e-bootstrap.ts` and used in upgrade E2E tests

---

## 5. Cross-Phase Concerns

### Database Changes

- **DeploymentModuleSnapshot**: Add `moduleReleaseIds: [String]` with index `{ moduleReleaseIds: 1 }`. No migration needed — new field is populated on new snapshot creation; existing snapshots have `undefined` which returns no match for `$in` queries. **NOTE**: Archival guards use a two-layer check: (a) `moduleReleaseIds` index for Phase 2+ snapshots, (b) fallback via `ProjectModuleDependency.exists({ resolvedReleaseId })` for pre-Phase-2 snapshots. This avoids a backfill migration.

### Feature Flags

- Same `reusable_modules` flag in `PLAN_FEATURES` for BUSINESS and ENTERPRISE tiers
- No new feature flags needed

### Configuration Changes

- No new environment variables
- No new runtime configuration

### Audit Events

| Action                  | Metadata                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| MODULE_UPGRADED         | `projectId, dependencyId, alias, previousReleaseId, newReleaseId, previousVersion, newVersion` |
| MODULE_RELEASE_ARCHIVED | `projectId, releaseId, version, archivedBy` (existing action — no new enum entry needed)       |

### Operational Metrics (Structured Logging)

| Metric                                     | Labels / Fields                                            |
| ------------------------------------------ | ---------------------------------------------------------- |
| `module.upgrade.count`                     | `tenantId`, `outcome` (`success` / `failed` / `cancelled`) |
| `module.diff.viewed`                       | `tenantId`, `hasBreakingChanges`                           |
| `module.reverse_dependency.duration_ms`    | `tenantId`, `consumerCount`                                |
| `module.upgrade.prerequisite_failure`      | `tenantId`, `reason`                                       |
| `module.release.archived`                  | `tenantId`                                                 |
| `module.deploy.auth_preflight.duration_ms` | `tenantId`, `profileCount`, `failedCount`                  |

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All Phase 1 test gaps closed: cutover safety E2E, import validation, tool picker, coordination section tests all passing
- [ ] Contract diff function produces correct breaking/non-breaking classifications
- [ ] Upgrade PATCH endpoint validates prerequisites, updates dependency, increments version counter, emits audit event
- [ ] Diff endpoint returns `UpgradePreview` with contract diff and prerequisite issues
- [ ] Reverse dependency API lists consumer projects with active deployment indicator
- [ ] Update-available indicators show on dependency list when newer release exists
- [ ] Release archive action is blocked when active deployment snapshots reference the release
- [ ] Deploy-time auth profile preflight fails closed when required profiles are missing (GAP-004 closure)
- [ ] Upgrade lifecycle E2E passes: upgrade, deploy, verify, downgrade, breaking change detection
- [ ] Browser smoke tests pass: publish, import, upgrade indicator, feature gate
- [ ] No regressions: all existing Phase 1 tests (325+) continue to pass
- [ ] `pnpm build && pnpm test` across all affected packages succeeds

---

## 7. Open Questions

1. **Upgrade UX for breaking changes**: Should the UI allow proceeding with a breaking upgrade (e.g., agent removed) even though deployment will likely fail? Or should it hard-block until the consumer DSL is updated? — **Decision: allow with explicit warning. The deploy preflight will catch actual breakage.**
2. **Reverse dependency pagination**: For modules with many consumers (50+), should the consumers endpoint paginate? — **Decision: add cursor pagination from the start, matching the releases list pattern.**
3. **Archived release visibility scope**: Should only module owners see archived releases, or also consumers who previously imported them? — **Decision: module owners see full history; consumers see only their pinned release even if archived.**
4. **Richer observability UI in Studio session/debug views**: The HLD lists this as Phase 2 scope. — **Decision: DEFERRED to Phase 3.** Phase 1 already emits `moduleAlias`, `moduleProjectId`, `moduleReleaseId`, and `sourceAgentName` in `TraceEvent` fields. The session/debug viewer in Studio reads these fields as raw metadata. Richer rendering (expandable module provenance panels, grouped-by-module trace views) depends on the Studio debug viewer redesign which is not yet planned. Phase 2 focuses on operational safety (upgrade, archival, reverse deps) rather than observability UX. HLD Phase 2 scope table should be updated to note this deferral during `/post-impl-sync`.

---

## 8. Phase 2 Test Plan Summary

| Test File                                       | Type          | Scenarios                                                            | Min Tests |
| ----------------------------------------------- | ------------- | -------------------------------------------------------------------- | --------- |
| `module-contract-diff.test.ts`                  | Unit          | Diff classification: added/removed/modified × agent/tool/config/auth | 15        |
| `api-module-dependencies.test.ts`               | Integration   | Import validation, alias uniqueness, removal safety                  | 10        |
| `api-module-upgrade.test.ts`                    | Integration   | Upgrade PATCH, diff endpoint, prerequisite re-validation             | 12        |
| `api-module-consumers.test.ts`                  | Integration   | Reverse dependency listing, cross-tenant isolation                   | 8         |
| `tool-picker-imported-tools.test.tsx`           | Unit          | Imported tools read-only, provenance-labeled                         | 5         |
| `coordination-section-imported-agents.test.tsx` | Unit          | Imported agents in routing/handoff/delegation                        | 5         |
| `module-cutover-safety.e2e.test.ts`             | E2E           | Failed deploy leaves previous active, retry succeeds                 | 4         |
| `module-upgrade-lifecycle.e2e.test.ts`          | E2E           | Upgrade, deploy, verify, downgrade, breaking change                  | 4         |
| `reusable-agent-modules-smoke.spec.ts`          | Browser smoke | Publish, import, upgrade indicator, feature gate                     | 4         |
| `api-module-routes.test.ts` (modified)          | Integration   | Archive action tests (added to existing file)                        | 3         |
| `api-module-catalog-routes.test.ts` (modified)  | Integration   | Archived-release filtering tests (added to existing file)            | 3         |
| `module-audit-events.test.ts` (modified)        | Unit          | Upgrade and archive audit event tests (added to existing file)       | 4         |
| **Total**                                       |               |                                                                      | **~77**   |

Combined with Phase 1's 325 tests, Phase 2 brings the total to **~402 tests** across 33 test files.
