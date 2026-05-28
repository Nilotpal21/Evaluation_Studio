# LLD: Reusable Agent Modules -- Consolidated Implementation Plan

**Feature Spec**: `docs/features/reusable-agent-modules.md`
**HLD**: `docs/specs/reusable-agent-modules.hld.md`
**Test Spec**: `docs/testing/reusable-agent-modules.md`
**Phase 1 LLD**: `docs/plans/reusable-agent-modules-phase1-impl-plan.md`
**Phase 2 LLD**: `docs/plans/2026-03-22-reusable-agent-modules-phase2-impl-plan.md`
**Status**: IN PROGRESS
**Date**: 2026-03-23

---

## 1. Context and Prior Work

### Completed Work

**Phase 1** (5 sprints, DONE): Core module lifecycle -- data model (5 entities, 4 new Mongoose models), release builder, contract extractor, selector, publish safety, alias rewriter, deployment build service, Studio routes, Studio UI components, E2E tests, feature gating. Total: ~325 tests passing.

**Phase 2 Sprint 1** (DONE): Test gap closure + data-layer foundations -- contract diff (23 tests), cutover safety E2E (5 tests), import validation (17 tests), tool picker provenance (5 tests), coordination section imported agents (6 tests), `moduleReleaseIds` denormalized array on snapshots. Total with Phase 1: ~381 tests.

### Remaining Scope

This plan covers Phase 2 Sprints 2-3 (safer operations and adoption UX) and Phase 3 (broader reuse and richer contracts). Each sprint has explicit entry/exit criteria and a file-level change map.

---

## 2. Design Decisions

### Decisions from Phase 2 (Inherited)

| #     | Decision                                                  | Rationale                                                              |
| ----- | --------------------------------------------------------- | ---------------------------------------------------------------------- |
| D2-1  | In-place PATCH for dependency upgrade (not delete+create) | Alias uniqueness constraint prevents temporary doubling; atomic update |
| D2-3  | Server-side release diff (not client-side)                | Avoids exposing raw contracts; enables breaking-change classification  |
| D2-4  | On-demand reverse dependency queries (not materialized)   | Compound index exists; low-frequency operation                         |
| D2-6  | No semver range resolution in Phase 2                     | Explicit upgrade first; ranges introduce implicit drift                |
| D2-8  | Breaking-change classification in contract diff           | Users need actionable upgrade decisions                                |
| D2-11 | Reverse dependency endpoint requires `MODULE_MANAGE`      | Prevents leaking consumer project identities to non-owners             |
| D2-12 | New `validateContractAuthProfiles()` function             | Existing `evaluateAuthPreflight` has incompatible input types          |

### New Decisions for Phase 3

| #    | Decision                                                                 | Rationale                                                                        | Alternatives Rejected                                    |
| ---- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | -------------------------------------------------------- |
| D3-1 | Data-field mapping uses IR metadata, not new DSL syntax                  | Keep Phase 3 parser-safe; field mapping is consumer config, not agent definition | New DSL `MAP:` section, inline mapping expressions       |
| D3-2 | Namespace binding uses consumer-side config, not module-side declaration | Module should not assume consumer namespace structure                            | Module declares namespace requirements, auto-bind        |
| D3-3 | Transitive dependencies limited to depth 1 in Phase 3                    | Full DAG resolution is substantial; depth-1 covers 90% of use cases              | Full DAG, no limit, compile-time only resolution         |
| D3-4 | Tenant-admin catalog uses existing RBAC + new `module:curate` permission | Fits existing permission model; no new auth surface                              | Separate admin API, new service account type             |
| D3-5 | Reusable workflows mount via the same alias mechanism as agents/tools    | Consistent mental model; alias rewriter already handles routing surfaces         | Separate workflow import path, inline workflow expansion |
| D3-6 | Cross-tenant modules deferred beyond Phase 3                             | Requires marketplace infrastructure, trust model, and billing integration        | Phase 3 cross-tenant with signed artifacts               |

### Key Interfaces & Types (Phase 3 additions)

```typescript
// packages/project-io/src/module-release/field-mapping.ts

interface FieldMapping {
  sourceField: string; // module-side gather field name
  targetField: string; // consumer-side gather field name or context variable
  transform?: 'identity' | 'rename' | 'format'; // Phase 3 supports identity and rename only
}

interface ModuleFieldMappingConfig {
  alias: string;
  mappings: FieldMapping[];
}

// packages/project-io/src/module-release/transitive-resolver.ts

interface TransitiveResolution {
  directDependencies: ResolvedDependency[];
  transitiveDependencies: ResolvedDependency[]; // depth-1 only in Phase 3
  conflictResolution: ConflictEntry[]; // when two modules depend on the same transitive
}

interface ConflictEntry {
  moduleProjectId: string;
  requestedByAliases: string[]; // which direct deps need this transitive
  resolvedVersion: string; // higher version wins
  resolvedReleaseId: string;
}

// apps/studio/src/app/api/projects/[id]/module-admin/route.ts

interface ModuleCurationEntry {
  moduleProjectId: string;
  status: 'featured' | 'approved' | 'hidden';
  curatedBy: string;
  curatedAt: Date;
  note?: string;
}
```

### Module Boundaries

| Module                  | Responsibility                                                  | Depends On               |
| ----------------------- | --------------------------------------------------------------- | ------------------------ |
| `project-io`            | Contract diff, field mapping, transitive resolution             | --                       |
| `database`              | `ModuleCuration` model, transitive dep fields                   | --                       |
| `studio` API routes     | Upgrade, diff, reverse deps, archival, curation, namespace      | `project-io`, `database` |
| `studio` UI components  | UpgradeDialog, update indicators, reverse dep, field mapping UI | `studio` API routes      |
| `runtime` build service | Auth profile preflight, transitive resolution, field mapping    | `database`, `project-io` |
| `compiler`              | Module-aware IR validation (transitive symbol conflicts)        | `project-io`             |

---

## 3. Implementation Phases

### Sprint 2: Phase 2 API Routes -- Upgrade, Reverse Dependency, Diff, Archival

**Goal**: Ship server-side API for upgrade flow, reverse dependency queries, release diff, and release archival.

**Entry Criteria**:

- Sprint 1 exit criteria met (381+ tests passing)
- Contract diff function (`diffModuleContracts`) available in `project-io`
- `moduleReleaseIds` populated on deployment module snapshots

**Tasks**:

2.1. **Upgrade PATCH endpoint** -- Add `PATCH` to `apps/studio/src/app/api/projects/[id]/module-dependencies/[dependencyId]/route.ts`.

- Zod schema: `z.object({ targetReleaseId: z.string().min(1), configOverrides: z.record(z.string()).optional() })`
- Flow: load dependency, load target release, re-validate prerequisites, compute symbol changes, `findOneAndUpdate`, increment `moduleDependencyVersion`, emit `MODULE_UPGRADED` audit event
- Returns: `{ success: true, data: { id, alias, moduleProjectId, resolvedReleaseId, resolvedVersion, previousVersion, diff: { hasBreakingChanges, summary } } }`

  2.2. **Diff endpoint** -- Create `apps/studio/src/app/api/projects/[id]/module-dependencies/[dependencyId]/diff/route.ts` (GET).

- Query param: `targetReleaseId` (required, `z.string().min(1)`)
- Returns `UpgradePreview` with contract diff, prerequisite issues, mounted symbol changes

  2.3. **Reverse dependency endpoint** -- Create `apps/studio/src/app/api/projects/[id]/module/consumers/route.ts` (GET).

- Permission: `MODULE_MANAGE` (owner-level)
- Cursor pagination: `?cursor=<lastId>&limit=<n>` (default 20, max 100)
- Returns: `{ success: true, data: ModuleConsumer[], pagination, summary }`

  2.4. **Single release detail + archive action** -- Create `apps/studio/src/app/api/projects/[id]/module/releases/[releaseId]/route.ts`.

- GET: release detail with contract (excludes `compiledIR`)
- POST with `{ action: 'archive' }`: sets `archivedAt` after verifying no active pointers or snapshots

  2.5. **Update-available enrichment** -- Modify `GET /module-dependencies` to batch-query latest non-archived release per dependent module via aggregation pipeline.

  2.6. **Deploy-time auth profile preflight** -- Create `apps/runtime/src/services/modules/contract-auth-validator.ts`. Called from `deployment-build-service.ts`. Collects ALL missing profiles before returning (not fail-on-first). Fails closed on DB errors.

  2.7. **Strengthen archival guards** -- Two-layer check: (a) `ModuleEnvironmentPointer` for active pointers, (b) `DeploymentModuleSnapshot.moduleReleaseIds` for Phase 2+ snapshots, (c) fallback `ProjectModuleDependency.resolvedReleaseId` for pre-Phase-2 snapshots.

  2.8. **Audit actions** -- Add `MODULE_UPGRADED` to `AuditActions`. Reuse existing `MODULE_RELEASE_ARCHIVED` for archive events.

  2.9. **Upgrade and diff route tests** -- `apps/studio/src/__tests__/api-module-upgrade.test.ts` (minimum 12 tests).

  2.10. **Reverse dependency and archive route tests** -- `apps/studio/src/__tests__/api-module-consumers.test.ts` (minimum 8 tests).

**Files Touched**:

- `apps/studio/src/app/api/projects/[id]/module-dependencies/[dependencyId]/route.ts` -- add PATCH
- `apps/studio/src/app/api/projects/[id]/module-dependencies/[dependencyId]/diff/route.ts` -- NEW
- `apps/studio/src/app/api/projects/[id]/module/consumers/route.ts` -- NEW
- `apps/studio/src/app/api/projects/[id]/module/releases/[releaseId]/route.ts` -- NEW
- `apps/studio/src/app/api/projects/[id]/module-dependencies/route.ts` -- enrich GET
- `apps/runtime/src/services/modules/deployment-build-service.ts` -- auth preflight call
- `apps/runtime/src/services/modules/contract-auth-validator.ts` -- NEW
- `apps/studio/src/services/audit-service.ts` -- new audit action
- `apps/studio/src/__tests__/api-module-upgrade.test.ts` -- NEW
- `apps/studio/src/__tests__/api-module-consumers.test.ts` -- NEW

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/studio --filter=runtime` succeeds
- [ ] All upgrade route tests pass (minimum 12)
- [ ] All reverse dependency tests pass (minimum 8)
- [ ] PATCH upgrade: `resolvedReleaseId` updated, `moduleDependencyVersion` incremented, audit event emitted
- [ ] PATCH with missing auth profile returns 422 with actionable remediation
- [ ] Diff endpoint returns correct breaking/non-breaking classification
- [ ] Archive blocked when deployment snapshot references the release
- [ ] All existing 381+ tests continue to pass

---

### Sprint 3: Phase 2 UI + E2E + Browser Smoke

**Goal**: Ship Studio UI for upgrade flow, update indicators, reverse dependency visibility. Add E2E and browser smoke tests.

**Entry Criteria**:

- Sprint 2 exit criteria met
- Upgrade PATCH, diff, reverse dependency, and archive endpoints passing

**Tasks**:

3.1. **UpgradeModuleDialog** -- Create `apps/studio/src/components/modules/UpgradeModuleDialog.tsx`.

- Fetch diff via `[dependencyId]/diff?targetReleaseId=...`
- Display breaking/non-breaking changes with severity indicators
- Show prerequisite issues (blocking issues disable confirm)
- Confirm triggers PATCH upgrade with loading state
- All strings via `useTranslations('modules')`

  3.2. **Update-available indicators** -- Modify `ModuleDependencyList.tsx` with "Update available" badge showing `-> v{latestVersion}`. Click opens UpgradeModuleDialog.

  3.3. **Reverse dependency panel** -- Create `apps/studio/src/components/modules/ReverseDepPanel.tsx`. Shows consumer projects with alias, pinned version, active deployment indicator. Linked from ModuleSettingsPanel.

  3.4. **Archive release UI** -- Add archive button to release list with confirm dialog and downstream impact warning.

  3.5. **Tool picker provenance integration** -- Modify `ToolPickerDialog.tsx` to filter imported tools with `[imported]` badge, read-only state, and provenance tooltip.

  3.6. **Coordination section integration** -- Modify `CoordinationSection.tsx` to include imported agents in routing/handoff/delegation targets with provenance badge.

  3.7. **Upgrade lifecycle E2E test** -- `apps/runtime/src/__tests__/module-upgrade-lifecycle.e2e.test.ts` (minimum 4 tests): upgrade v1->v2, downgrade, breaking change error, missing auth profile error.

  3.8. **Browser smoke test** -- `apps/studio/e2e/reusable-agent-modules-smoke.spec.ts` (minimum 4 scenarios): publish, import, upgrade indicator, feature gate.

  3.9. **E2E bootstrap enhancement** -- Add `patch()` and `upgradeModule()` to `module-e2e-bootstrap.ts`.

**Files Touched**:

- `apps/studio/src/components/modules/UpgradeModuleDialog.tsx` -- NEW
- `apps/studio/src/components/modules/ReverseDepPanel.tsx` -- NEW
- `apps/studio/src/components/modules/ModuleDependencyList.tsx` -- update badge
- `apps/studio/src/components/modules/ModuleSettingsPanel.tsx` -- reverse dep link
- `apps/studio/src/components/abl/ToolPickerDialog.tsx` -- imported provenance
- `apps/studio/src/components/agent-detail/CoordinationSection.tsx` -- imported targets
- `apps/runtime/src/__tests__/module-upgrade-lifecycle.e2e.test.ts` -- NEW
- `apps/studio/e2e/reusable-agent-modules-smoke.spec.ts` -- NEW
- `apps/runtime/src/__tests__/helpers/module-e2e-bootstrap.ts` -- upgrade helper

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/studio` succeeds
- [ ] UpgradeModuleDialog renders diff with breaking/non-breaking indicators
- [ ] ModuleDependencyList shows update-available badge
- [ ] ReverseDepPanel lists consumer projects with deployment status
- [ ] Upgrade lifecycle E2E tests pass (minimum 4)
- [ ] Browser smoke tests pass (minimum 4 scenarios)
- [ ] All existing 381+ tests continue to pass

---

### Sprint 4: Phase 3 Foundation -- Transitive Dependencies (Depth-1)

**Goal**: Enable a module to declare dependencies on other modules, resolved at depth-1 during consumer deployment build.

**Entry Criteria**:

- Phase 2 (Sprints 2-3) exit criteria met
- All ~402 tests passing

**Tasks**:

4.1. **Transitive dependency model** -- Extend `ProjectModuleDependency` with optional `transitiveDependencies: Array<{ moduleProjectId: string, alias: string, resolvedReleaseId: string }>` in the module release contract. When a module project itself has module dependencies, those dependencies appear in the release contract as transitive prerequisites.

4.2. **Transitive resolver** -- Create `packages/project-io/src/module-release/transitive-resolver.ts`.

- Input: consumer's direct dependencies + each module's contract transitive prerequisites
- Output: flattened list of all resolved releases (direct + transitive), conflict resolution for shared transitive deps (higher version wins)
- Depth limit: 1 (a module's dependency cannot itself have module dependencies)
- Circular dependency detection: reject if any transitive moduleProjectId appears in direct dependencies

  4.3. **Deployment build with transitive resolution** -- Update `apps/runtime/src/services/modules/deployment-build-service.ts`:

- After resolving direct dependencies, load each module release's contract transitive prerequisites
- Call transitive resolver to compute full dependency set
- Build snapshot including both direct and transitive mounted agents/tools
- Alias rewriter must handle nested alias mounting: `<consumerAlias>__<transitiveAlias>__<symbol>`

  4.4. **Publish-time transitive contract extraction** -- Update `packages/project-io/src/module-release/build-module-release.ts`:

- When a module project has module dependencies, include them in the release contract as `transitiveDependencies`
- Validate depth: reject publish if any dependency itself has transitive dependencies (depth > 1)

  4.5. **Studio UI for transitive dependencies** -- Update `ModuleDependencyList.tsx` to show transitive dependencies as expandable nested items under each direct dependency. Mark as "auto-resolved" with provenance.

  4.6. **Transitive resolver unit tests** -- `packages/project-io/src/__tests__/transitive-resolver.test.ts` (minimum 15 tests): single transitive, multiple, conflict resolution, circular detection, depth limit enforcement, empty transitive.

  4.7. **Transitive E2E test** -- `apps/runtime/src/__tests__/module-transitive.e2e.test.ts` (minimum 5 tests): module A depends on module B, consumer imports A, deployment resolves both, execution works, conflict resolution.

**Files Touched**:

- `packages/project-io/src/module-release/transitive-resolver.ts` -- NEW
- `packages/project-io/src/module-release/build-module-release.ts` -- transitive contract
- `apps/runtime/src/services/modules/deployment-build-service.ts` -- transitive resolution
- `apps/runtime/src/services/modules/module-alias-rewriter.ts` -- nested alias support
- `apps/studio/src/components/modules/ModuleDependencyList.tsx` -- transitive UI
- `packages/project-io/src/__tests__/transitive-resolver.test.ts` -- NEW
- `apps/runtime/src/__tests__/module-transitive.e2e.test.ts` -- NEW

**Exit Criteria**:

- [ ] `pnpm build` across all affected packages succeeds
- [ ] Transitive resolver tests pass (minimum 15)
- [ ] Transitive E2E tests pass (minimum 5)
- [ ] Depth limit enforced: publish rejects depth > 1
- [ ] Conflict resolution: higher version wins for shared transitive deps
- [ ] All existing 402+ tests continue to pass

---

### Sprint 5: Phase 3 -- Data-Field Mapping and Namespace Binding

**Goal**: Enable consumer projects to map module gather fields to consumer-side context variables and bind imported tools to specific variable namespaces.

**Entry Criteria**:

- Sprint 4 exit criteria met

**Tasks**:

5.1. **Field mapping config model** -- Extend `ProjectModuleDependency` with `fieldMappings: FieldMapping[]` (optional). Each mapping specifies `sourceField` (module gather field), `targetField` (consumer context variable), and `transform` (identity or rename).

5.2. **Field mapping validation** -- Create `packages/project-io/src/module-release/field-mapping-validator.ts`:

- Validate source fields exist in the module contract's provided agents' gather configs
- Validate target fields are valid consumer context variable names
- Reject circular mappings (A -> B -> A)

  5.3. **Field mapping application in deployment build** -- Update deployment build service:

- After alias rewriting, apply field mappings to mounted agent IR gather configs
- Replace module-side gather field references with consumer-side targets
- Validate all mappings before building snapshot

  5.4. **Namespace binding config** -- Extend `ProjectModuleDependency` with `namespaceMappings: Record<string, string>` (optional). Maps module tool names to consumer variable namespace IDs.

  5.5. **Namespace binding application** -- Update alias rewriter to apply namespace bindings when mounting imported tools. Replace module default namespace with consumer-specified namespace.

  5.6. **Studio field mapping UI** -- Create `apps/studio/src/components/modules/FieldMappingEditor.tsx`:

- Two-column mapping: module fields (left) to consumer fields (right)
- Autocomplete for consumer context variables
- Validation feedback for invalid mappings

  5.7. **Studio namespace binding UI** -- Create `apps/studio/src/components/modules/NamespaceBindingEditor.tsx`:

- List imported tools with current namespace
- Dropdown to select consumer namespace per tool

  5.8. **Field mapping tests** -- `packages/project-io/src/__tests__/field-mapping-validator.test.ts` (minimum 12 tests).

  5.9. **Namespace binding tests** -- Unit tests in alias rewriter test file (minimum 8 tests).

  5.10. **Field mapping E2E test** -- `apps/runtime/src/__tests__/module-field-mapping.e2e.test.ts` (minimum 4 tests).

**Files Touched**:

- `packages/database/src/models/project-module-dependency.model.ts` -- fieldMappings, namespaceMappings
- `packages/project-io/src/module-release/field-mapping-validator.ts` -- NEW
- `apps/runtime/src/services/modules/deployment-build-service.ts` -- field mapping application
- `apps/runtime/src/services/modules/module-alias-rewriter.ts` -- namespace binding
- `apps/studio/src/components/modules/FieldMappingEditor.tsx` -- NEW
- `apps/studio/src/components/modules/NamespaceBindingEditor.tsx` -- NEW
- `apps/studio/src/components/modules/ImportModuleDialog.tsx` -- integrate editors
- `packages/project-io/src/__tests__/field-mapping-validator.test.ts` -- NEW
- `apps/runtime/src/__tests__/module-field-mapping.e2e.test.ts` -- NEW

**Exit Criteria**:

- [ ] `pnpm build` across all affected packages succeeds
- [ ] Field mapping validation tests pass (minimum 12)
- [ ] Namespace binding tests pass (minimum 8)
- [ ] Field mapping E2E tests pass (minimum 4)
- [ ] Invalid mappings rejected with actionable error
- [ ] All existing tests continue to pass

---

### Sprint 6: Phase 3 -- Tenant-Admin Curation and Reusable Workflows

**Goal**: Enable tenant admins to curate the module catalog and support reusable workflow definitions in module releases.

**Entry Criteria**:

- Sprint 5 exit criteria met

**Tasks**:

6.1. **Module curation model** -- Create `packages/database/src/models/module-curation.model.ts`:

- Fields: `tenantId`, `moduleProjectId`, `status` (featured/approved/hidden), `curatedBy`, `curatedAt`, `note`
- Unique index: `{ tenantId, moduleProjectId }`

  6.2. **Curation API** -- Create `apps/studio/src/app/api/projects/[id]/module-admin/route.ts`:

- GET: list curation entries for tenant
- POST: create/update curation entry
- Permission: new `module:curate` added to admin roles

  6.3. **Catalog filtering by curation** -- Update module catalog endpoint to respect curation status:

- `featured` modules appear first in catalog results
- `hidden` modules are excluded from catalog (still accessible by direct ID)
- `approved` modules appear normally

  6.4. **Reusable workflow mounting** -- Extend module release artifact and contract:

- Include workflow definitions in release artifact
- Alias rewriter handles workflow step agent references
- Deployment build mounts workflows alongside agents and tools

  6.5. **Workflow import validation** -- Extend prerequisite validation to check workflow-specific requirements (trigger types, notification channels).

  6.6. **Studio catalog curation UI** -- Create admin-facing curation interface in module settings with featured/approved/hidden controls.

  6.7. **Curation tests** -- `apps/studio/src/__tests__/api-module-curation.test.ts` (minimum 10 tests).

  6.8. **Workflow mounting tests** -- Extend existing E2E tests with workflow-backed module scenarios (minimum 4 tests).

**Files Touched**:

- `packages/database/src/models/module-curation.model.ts` -- NEW
- `packages/database/src/models/index.ts` -- register model
- `apps/studio/src/app/api/projects/[id]/module-admin/route.ts` -- NEW
- `apps/studio/src/app/api/projects/[id]/module-catalog/route.ts` -- curation filtering
- `packages/project-io/src/module-release/build-module-release.ts` -- workflow artifact
- `apps/runtime/src/services/modules/module-alias-rewriter.ts` -- workflow references
- `apps/runtime/src/services/modules/deployment-build-service.ts` -- workflow mounting
- `apps/studio/src/__tests__/api-module-curation.test.ts` -- NEW

**Exit Criteria**:

- [ ] `pnpm build` across all affected packages succeeds
- [ ] Curation tests pass (minimum 10)
- [ ] Workflow mounting tests pass (minimum 4)
- [ ] Featured modules appear first in catalog
- [ ] Hidden modules excluded from catalog browse
- [ ] All existing tests continue to pass

---

## 4. Wiring Checklist

### Sprint 2 (Phase 2 APIs)

- [ ] PATCH handler exported from `[dependencyId]/route.ts`
- [ ] GET handler exported from `[dependencyId]/diff/route.ts`
- [ ] GET handler exported from `module/consumers/route.ts`
- [ ] GET + POST handlers exported from `module/releases/[releaseId]/route.ts`
- [ ] All new routes include `requireFeature: 'reusable_modules'`
- [ ] `validateContractAuthProfiles` exported and imported in `deployment-build-service.ts`
- [ ] `MODULE_UPGRADED` added to `AuditActions`
- [ ] Feature-resolver mock added to all new Studio test files

### Sprint 3 (Phase 2 UI)

- [ ] `UpgradeModuleDialog` imported and rendered from `ModuleDependencyList.tsx`
- [ ] `ReverseDepPanel` imported and rendered from `ModuleSettingsPanel.tsx`
- [ ] Imported tool provenance wired in `ToolPickerDialog.tsx`
- [ ] Imported agent targets wired in `CoordinationSection.tsx`
- [ ] `upgradeModule()` helper added to `module-e2e-bootstrap.ts`
- [ ] i18n keys added to `modules` namespace in `studio.json`

### Sprint 4 (Phase 3 Transitive)

- [ ] `transitiveDependencies` field added to module release contract type
- [ ] Transitive resolver exported from `project-io`
- [ ] Deployment build service calls transitive resolver
- [ ] Nested alias format documented in alias rewriter tests

### Sprint 5 (Phase 3 Field Mapping)

- [ ] `fieldMappings` and `namespaceMappings` fields added to dependency model
- [ ] Field mapping validator exported from `project-io`
- [ ] `FieldMappingEditor` imported in `ImportModuleDialog.tsx`
- [ ] `NamespaceBindingEditor` imported in `ImportModuleDialog.tsx`

### Sprint 6 (Phase 3 Curation + Workflows)

- [ ] `ModuleCuration` model registered in `packages/database/src/models/index.ts`
- [ ] `module:curate` permission added to admin roles
- [ ] Catalog route imports curation filtering logic
- [ ] Workflow definitions included in release artifact type

---

## 5. Cross-Phase Concerns

### Database Changes

| Sprint | Change                                                     | Migration? |
| ------ | ---------------------------------------------------------- | ---------- |
| 2      | None (Sprint 1 already added `moduleReleaseIds`)           | No         |
| 4      | `transitiveDependencies` in release contract (schema only) | No         |
| 5      | `fieldMappings`, `namespaceMappings` on dependency model   | No         |
| 6      | New `module_curations` collection                          | No         |

All changes are additive -- no destructive migrations required.

### Feature Flags

- Same `reusable_modules` flag throughout Phases 2 and 3
- No new feature flags

### Audit Events

| Action                  | Sprint | Metadata                                                                  |
| ----------------------- | ------ | ------------------------------------------------------------------------- |
| MODULE_UPGRADED         | 2      | projectId, dependencyId, alias, previousReleaseId, newReleaseId, versions |
| MODULE_RELEASE_ARCHIVED | 2      | projectId, releaseId, version (existing action)                           |
| MODULE_FIELD_MAPPED     | 5      | projectId, dependencyId, alias, mappingCount                              |
| MODULE_CURATED          | 6      | tenantId, moduleProjectId, status, curatedBy                              |

### Operational Metrics

| Metric                                     | Sprint | Labels                                 |
| ------------------------------------------ | ------ | -------------------------------------- |
| `module.upgrade.count`                     | 2      | tenantId, outcome                      |
| `module.diff.viewed`                       | 2      | tenantId, hasBreakingChanges           |
| `module.reverse_dependency.duration_ms`    | 2      | tenantId, consumerCount                |
| `module.deploy.auth_preflight.duration_ms` | 2      | tenantId, profileCount, failedCount    |
| `module.transitive.resolution_ms`          | 4      | tenantId, directCount, transitiveCount |
| `module.field_mapping.count`               | 5      | tenantId, mappingCount                 |

---

## 6. Test Plan Summary

| Sprint | New Tests (min) | Cumulative Total |
| ------ | --------------- | ---------------- |
| 2      | 20+             | ~401             |
| 3      | 12+             | ~413             |
| 4      | 20+             | ~433             |
| 5      | 24+             | ~457             |
| 6      | 14+             | ~471             |

### By Test Type

| Type              | Sprint 2 | Sprint 3 | Sprint 4 | Sprint 5 | Sprint 6 |
| ----------------- | -------- | -------- | -------- | -------- | -------- |
| Unit              | 0        | 0        | 15       | 20       | 10       |
| Integration       | 20       | 0        | 0        | 0        | 0        |
| E2E               | 0        | 4        | 5        | 4        | 4        |
| Browser smoke     | 0        | 4        | 0        | 0        | 0        |
| Component (React) | 0        | 4        | 0        | 0        | 0        |

---

## 7. Acceptance Criteria (Complete Feature)

- [ ] Phase 1 (DONE): core lifecycle with 325+ tests
- [ ] Phase 2 Sprint 1 (DONE): test gaps closed, 381+ tests
- [ ] Phase 2 Sprint 2: upgrade, diff, reverse deps, archival API with 401+ tests
- [ ] Phase 2 Sprint 3: Studio UI, E2E, browser smoke with 413+ tests
- [ ] Phase 3 Sprint 4: transitive dependencies (depth-1) with 433+ tests
- [ ] Phase 3 Sprint 5: field mapping and namespace binding with 457+ tests
- [ ] Phase 3 Sprint 6: tenant-admin curation and reusable workflows with 471+ tests
- [ ] `pnpm build && pnpm test` succeeds across all packages
- [ ] No cross-tenant isolation violations
- [ ] No secret leaks in module artifacts
- [ ] All feature-gated routes return 403 when disabled

---

## 8. Open Questions

| #   | Question                                                                           | Status  | Decision                                        |
| --- | ---------------------------------------------------------------------------------- | ------- | ----------------------------------------------- |
| 1   | Should depth-1 transitive be enforced at publish time or import time?              | Open    | Recommend publish time for earlier feedback     |
| 2   | Should field mapping support computed transforms (format, type conversion)?        | Open    | Phase 3 starts with identity and rename only    |
| 3   | Should reusable workflows support HITL trigger types from the module?              | Open    | Likely requires Phase 4 for trigger portability |
| 4   | Should tenant-admin curation be per-tenant or per-project?                         | Decided | Per-tenant (admin manages for entire tenant)    |
| 5   | What is the retention policy for archived releases unreferenced by any deployment? | Open    | Recommend 90-day TTL with soft delete           |

---

## 9. Rollback Strategy

Each sprint is independently revertable:

- **Sprint 2**: Revert commits. New routes are additive. PATCH handler does not affect existing create/delete.
- **Sprint 3**: Revert commits. UI components are additive. E2E tests are independent.
- **Sprint 4**: Revert commits. Transitive resolution is opt-in (only active when module has module deps).
- **Sprint 5**: Revert commits. Field mappings and namespace bindings are optional fields.
- **Sprint 6**: Revert commits. Curation collection and workflow mounting are additive.

Kill switch: `reusable_modules` feature flag disables all module functionality at the tenant level.
