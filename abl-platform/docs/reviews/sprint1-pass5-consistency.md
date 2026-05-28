# Sprint 1 — Pass 5: Consistency Review (FINAL)

**Reviewer:** LLD-Reviewer Agent (Pass 5 — Consistency — FINAL)
**Date:** 2026-03-22
**Scope:** Cross-file consistency for all Sprint 1 implementation files, specs, and documentation. Independent review with no prior-pass context. This is the deciding pass.

---

## Methodology

Exhaustive cross-check of every implementation file against the HLD, LLD, feature doc, and test guide. For each file pair or cross-reference I verified:

1. **Field-level consistency** — types, names, optionality, and defaults match across LLD, model, and feature doc
2. **Type cross-references** — imports resolve, shapes agree, package boundaries are respected
3. **Index specifications** — unique constraints, compound key ordering, and `tenantId` prefixing match across all docs and implementation
4. **Naming** — function names, type names, collection names, and Mongoose model registration names match or have documented reasons for divergence
5. **Export chains** — every public symbol has an unbroken barrel export path from source to consumer
6. **Test alignment** — test files exercise the real implementation signatures and cover the LLD acceptance criteria

### Documents Reviewed

| Document    | Path                                                  |
| ----------- | ----------------------------------------------------- |
| HLD         | `docs/specs/reusable-agent-modules-phase-plan.hld.md` |
| LLD         | `docs/specs/reusable-agent-modules-phase1.lld.md`     |
| Feature doc | `docs/features/reusable-agent-modules.md`             |
| Test guide  | `docs/testing/reusable-agent-modules.md`              |

### Implementation Files Reviewed (17)

- `packages/database/src/models/module-release.model.ts`
- `packages/database/src/models/module-environment-pointer.model.ts`
- `packages/database/src/models/project-module-dependency.model.ts`
- `packages/database/src/models/deployment-module-snapshot.model.ts`
- `packages/database/src/models/project.model.ts`
- `packages/database/src/models/index.ts`
- `packages/database/src/cascade/cascade-delete.ts`
- `packages/database/src/cascade/index.ts`
- `apps/runtime/src/services/modules/types.ts`
- `packages/shared-kernel/src/types/trace-event.ts`
- `packages/project-io/src/module-release/build-module-release.ts`
- `packages/project-io/src/module-release/source-hash.ts`
- `packages/project-io/src/module-release/module-contract.ts`
- `packages/project-io/src/module-release/module-selector.ts`
- `packages/project-io/src/module-release/module-publish-safety.ts`
- `packages/project-io/src/module-release/index.ts`
- `packages/project-io/src/index.ts`

### Test Files Reviewed (9)

- `packages/project-io/src/__tests__/module-release-builder.test.ts`
- `packages/project-io/src/__tests__/module-contract.test.ts`
- `packages/project-io/src/__tests__/module-selector.test.ts`
- `packages/project-io/src/__tests__/module-publish-safety.test.ts`
- `packages/database/src/__tests__/model-module-release.test.ts`
- `packages/database/src/__tests__/model-module-environment-pointer.test.ts`
- `packages/database/src/__tests__/model-project-module-dependency.test.ts`
- `packages/database/src/__tests__/model-deployment-module-snapshot.test.ts`
- `packages/database/src/__tests__/cascade-delete-modules.test.ts`

---

## ISSUES

### CRITICAL — None

No critical consistency issues found.

---

### HIGH

#### HIGH-1: Three-way `compiledIR` type divergence persists across LLD, model, and builder

| Source          | Type                                      | Location                     |
| --------------- | ----------------------------------------- | ---------------------------- |
| LLD Section 1.2 | `Record<string, AgentIR>`                 | line 110                     |
| Model           | `Record<string, unknown>`                 | `module-release.model.ts:59` |
| Builder output  | `Record<string, Record<string, unknown>>` | `build-module-release.ts:73` |
| Runtime types   | `ir: AgentIR` (in `MountedAgentEntry`)    | `types.ts:55`                |

The model deviation is intentional (JSDoc at line 54-58 explains the `@agent-platform/database` to `@abl/compiler` boundary). However, four different expressions of the same data exist across three packages and the LLD. Sprint 2 consumers (deployment build service, deployment resolver) will inevitably write bare `as AgentIR` casts without a documented assertion pattern.

**Status:** Persistent finding from all prior consistency reviews. Confirmed independently.

**Fix for Sprint 2:** Add a `parseAgentIR(value: unknown): AgentIR` assertion function (runtime validation) to `packages/shared-kernel` or `apps/runtime/src/services/modules/`. Document it in LLD Section 6.1. This prevents shape mismatches when the IR schema evolves.

---

#### HIGH-2: Feature doc `module_releases` omits `compiledIR` and `releaseNotes` fields

**Location:** `docs/features/reusable-agent-modules.md:99-114`

The feature doc field list for `module_releases` includes `artifact`, `contract`, `sourceHash`, `createdBy`, `archivedAt`, `archivedBy`, `createdAt` but omits:

- `compiledIR: Record<string, unknown>` — present in LLD (Section 1.2) and model (`module-release.model.ts:59`)
- `releaseNotes: string | null` — present in LLD (Section 1.2) and model (`module-release.model.ts:52`)

**Impact:** Teams building the deployment resolver against the feature doc will not know pre-compiled IR is available and may re-compile from DSL unnecessarily.

**Fix:** Add both fields to the feature doc's `module_releases` collection specification.

---

#### HIGH-3: Feature doc `deployment_module_snapshots` uses raw fields; implementation uses `compressedPayload: Buffer`

**Location:** `docs/features/reusable-agent-modules.md:148-164`

| Feature doc says                       | Implementation has          |
| -------------------------------------- | --------------------------- |
| `dependencies: Array<{...}>`           | `compressedPayload: Buffer` |
| `mountedAgents: Record<string, {...}>` | (inside compressed payload) |
| `mountedTools: Record<string, {...}>`  | (inside compressed payload) |

The LLD Section 1.5 and model (`deployment-module-snapshot.model.ts:21`) both use `compressedPayload: Buffer`. The feature doc describes the logical payload structure as if it were direct collection fields.

**Fix:** Replace the three direct field entries in the feature doc with `compressedPayload: Buffer (gzip-compressed JSON of DeploymentModuleSnapshotPayload)` and reference `apps/runtime/src/services/modules/types.ts:75`.

---

#### HIGH-4: Feature doc `deployment_module_snapshots` unique index missing `tenantId` prefix

**Location:** `docs/features/reusable-agent-modules.md:162` shows `{ deploymentId: 1 } (unique)`

**Implementation:** `deployment-module-snapshot.model.ts:47` has `{ tenantId: 1, deploymentId: 1 } (unique)`

**LLD Section 1.5** matches the implementation.

**Impact:** An integrator building a query to find a snapshot by `deploymentId` without `tenantId` would bypass tenant isolation.

**Fix:** Update the feature doc index to `{ tenantId: 1, deploymentId: 1 } (unique)`.

---

### MEDIUM

#### MEDIUM-1: Dual selector type naming — `ModuleSelector` vs `ModuleDependencySelector`

| Package      | Type Name                  | Location                                |
| ------------ | -------------------------- | --------------------------------------- |
| `project-io` | `ModuleSelector`           | `module-selector.ts:12`                 |
| `database`   | `ModuleDependencySelector` | `project-module-dependency.model.ts:17` |

Both are exported from their barrels. They are structurally identical: `{ type: 'version' | 'environment'; value: string }`. The LLD uses inline shape in Section 1.4 and `ModuleSelector` in Section 3.3.

**Impact:** Sprint 2 code must choose between two equivalent types. If one adds `'latest'` as a selector type, the other silently falls out of sync.

**Fix:** Add JSDoc cross-references on each type pointing to the other. A shared package dependency from database to project-io is architecturally undesirable, so documentation linkage is the pragmatic solution.

---

#### MEDIUM-2: Function name divergence — LLD `computeSourceHash` vs implementation `computeModuleSourceHash`

| Source                        | Name                      | Signature                                   |
| ----------------------------- | ------------------------- | ------------------------------------------- |
| LLD Section 1.2 (line 170)    | `computeSourceHash`       | `(entryAgentName, agents, tools) => string` |
| Implementation                | `computeModuleSourceHash` | `(entryAgentName, agents, tools) => string` |
| Platform (shared-kernel)      | `computeSourceHash`       | `(content: string) => string` (64-char hex) |
| Platform (lockfile-generator) | `computeSourceHash`       | `(content: string) => string` (16-char hex) |

The rename to `computeModuleSourceHash` is correct engineering to avoid collision with the existing platform-level single-parameter `computeSourceHash`. However, the LLD still references the old name.

**Fix:** Update LLD Section 1.2 to use `computeModuleSourceHash`.

---

#### MEDIUM-3: Feature doc `project_module_dependencies` omits `contractSnapshot` and `createdAt`

**Location:** `docs/features/reusable-agent-modules.md:131-146`

Missing fields:

- `contractSnapshot: ModuleReleaseContract` — LLD Section 1.4 (Decision 1c), model line 33
- `createdAt: Date` — model uses `timestamps: true`, LLD Section 1.4 interface specifies it

**Fix:** Add both fields to the feature doc.

---

#### MEDIUM-4: Feature doc `projects` collection omits three new fields

**Location:** `docs/features/reusable-agent-modules.md:86-96`

Lists only `kind` and `moduleVisibility`. Implementation and LLD also add:

- `moduleDependencyVersion: number` (optimistic concurrency for dependency edits)
- `archivedAt: Date | null` (soft-delete timestamp)
- `archivedBy: string | null` (soft-delete actor)

**Fix:** Add all three fields to the feature doc's project collection specification.

---

#### MEDIUM-5: Feature doc Studio API table omits two LLD routes

**Location:** `docs/features/reusable-agent-modules.md:52-63`

Missing:

1. `POST /api/projects/:id/module-dependencies/preview` — LLD Section 7.1 (two-step import preview)
2. `GET /api/projects/:id/module-catalog/:moduleProjectId` — LLD Section 7.1 (module detail with full contract)

**Fix:** Add both routes to the feature doc's Studio API table.

---

#### MEDIUM-6: Builder output flattens structured safety issues to `string[]`

| Layer            | Type                                                              | Location                         |
| ---------------- | ----------------------------------------------------------------- | -------------------------------- |
| Safety validator | `PublishSafetyIssue[]` with `{ severity, code, source, message }` | `module-publish-safety.ts:27-32` |
| Builder output   | `errors: string[]`, `warnings: string[]`                          | `build-module-release.ts:76,82`  |
| LLD Section 3.1  | Decision 2b: "two-tier errors/warnings" (implies structured)      | line 367                         |

The builder formats issues as `[${i.code}] ${i.source}: ${i.message}` (line 201). Sprint 2 Studio publish route will need to parse this string to extract error codes for i18n.

**Status:** Acceptable for Sprint 1 (no API consumers). Should be revisited in Sprint 2.

---

#### MEDIUM-7: Hash length convention split (16-char vs 64-char) undocumented in LLD

| Context                 | Length  | Source                                       |
| ----------------------- | ------- | -------------------------------------------- |
| Module sourceHash       | 16-char | `source-hash.ts:34` `.slice(0, 16)`          |
| Per-agent/per-tool hash | 16-char | `build-module-release.ts:161,177`            |
| Platform tool hash      | 64-char | `shared-kernel/utils/hash.ts` (full digest)  |
| Platform lockfile hash  | 16-char | `project-io/export/lockfile-generator.ts:24` |

Two conventions coexist. Module hashes follow the compiler/lockfile 16-char convention. Shared-kernel `computeSourceHash` uses full 64-char. Both are internally consistent within their subsystems.

**Fix:** Document the convention explicitly in LLD Section 1.2.

---

### LOW

#### LOW-1: Test fixture `configOverrides: { API_KEY: 'sk-test-123' }` paired with `isSecret: true`

**Location:** `packages/database/src/__tests__/model-project-module-dependency.test.ts:41`

Per LLD Section 11.2, `configOverrides` with `isSecret: true` keys would be rejected at business logic validation. The model test only exercises Mongoose schema behavior, so this is technically correct but misleading.

**Fix:** Use a non-secret config key name or add a clarifying comment.

---

#### LOW-2: `event-cascade-hooks.ts` not explicitly mocked in cascade-delete-modules.test.ts

**Location:** `packages/database/src/__tests__/cascade-delete-modules.test.ts`

The `deleteProject` function calls `getEventCascadeHook()` which returns `undefined` by default. The test relies on this implicit behavior rather than explicit mock control.

**Fix:** Add `vi.mock('./event-cascade-hooks.js', ...)` for explicit safety.

---

## VERIFIED

### Cross-File Field Consistency

| Entity                                        | LLD                     | Model                   | Feature Doc      | Runtime Types | Status         |
| --------------------------------------------- | ----------------------- | ----------------------- | ---------------- | ------------- | -------------- |
| `IModuleRelease._id`                          | string                  | String, uuidv7          | string           | —             | MATCH          |
| `IModuleRelease.tenantId`                     | string, required        | String, required        | string, required | —             | MATCH          |
| `IModuleRelease.moduleProjectId`              | string                  | String, required        | string, required | —             | MATCH          |
| `IModuleRelease.version`                      | string                  | String, required        | string, required | —             | MATCH          |
| `IModuleRelease.releaseNotes`                 | string or null          | String, default null    | **MISSING**      | —             | HIGH-2         |
| `IModuleRelease.artifact`                     | ModuleReleaseArtifact   | Mixed, required         | yes              | —             | MATCH          |
| `IModuleRelease.compiledIR`                   | Record<string, AgentIR> | Record<string, unknown> | **MISSING**      | —             | HIGH-1, HIGH-2 |
| `IModuleRelease.contract`                     | ModuleReleaseContract   | Mixed, required         | yes              | —             | MATCH          |
| `IModuleRelease.sourceHash`                   | string                  | String, required        | string, required | —             | MATCH          |
| `IModuleRelease.createdBy`                    | string                  | String, required        | string, required | —             | MATCH          |
| `IModuleRelease.createdAt`                    | Date                    | timestamps: true        | Date             | —             | MATCH          |
| `IModuleRelease.archivedAt`                   | Date or null            | Date, default null      | Date or null     | —             | MATCH          |
| `IModuleRelease.archivedBy`                   | string or null          | String, default null    | string or null   | —             | MATCH          |
| `IDeploymentModuleSnapshot.compressedPayload` | Buffer (gzip)           | Buffer, required        | **RAW FIELDS**   | —             | HIGH-3         |

### Index Specifications — All Match Between LLD and Implementation

- [x] `ModuleRelease`: `{ tenantId: 1, moduleProjectId: 1, version: 1 }` unique + `{ tenantId: 1, moduleProjectId: 1, createdAt: -1 }` listing
- [x] `ModuleEnvironmentPointer`: `{ tenantId: 1, moduleProjectId: 1, environment: 1 }` unique
- [x] `ProjectModuleDependency`: `{ tenantId: 1, projectId: 1, alias: 1 }` unique + `{ tenantId: 1, moduleProjectId: 1 }` reverse lookup
- [x] `DeploymentModuleSnapshot`: `{ tenantId: 1, deploymentId: 1 }` unique + `{ tenantId: 1, projectId: 1 }` listing

### Naming Consistency — All Match

- [x] Collection names: `module_releases`, `module_environment_pointers`, `project_module_dependencies`, `deployment_module_snapshots` — consistent across LLD, Mongoose `collection:` option, and feature doc
- [x] Mongoose model names: `ModuleRelease`, `ModuleEnvironmentPointer`, `ProjectModuleDependency`, `DeploymentModuleSnapshot` — consistent in `mongoose.model()` and `mongoose.models[name]` guards
- [x] Interface names: `IModuleRelease`, `IModuleEnvironmentPointer`, `IProjectModuleDependency`, `IDeploymentModuleSnapshot` — follow `I<Model>` convention
- [x] Sub-document types: `ModuleReleaseArtifact`, `ModuleReleaseContract` — consistent between model definition, barrel export, and consumer imports
- [x] Runtime types: `ModuleProvenance`, `ResolvedAgentIR`, `ResolvedToolDefinition`, `DeploymentModuleDependency`, `MountedAgentEntry`, `MountedToolEntry`, `DeploymentModuleSnapshotPayload` — all match LLD Section 6.1
- [x] TraceEvent fields: `moduleAlias`, `moduleProjectId`, `moduleReleaseId`, `sourceAgentName` — match LLD Section 6.3

### Import/Export Chain Completeness

- [x] Database barrel (`index.ts:149-169`): All 4 models + interfaces + sub-types exported under `// --- Modules ---`
- [x] Cascade barrel (`cascade/index.ts`): `softDeleteModuleProject`, `CascadeDeleteBlockedError`, `CascadeDeleteResult` all exported
- [x] Module-release barrel (`module-release/index.ts`): All 5 sub-modules with 15+ named exports verified
- [x] Project-io barrel (`project-io/src/index.ts:14`): Re-exports `./module-release/index.js`
- [x] All `.js` extensions present on every relative import
- [x] Cross-package imports: `@agent-platform/database/models`, `@abl/compiler/platform`, `@abl/compiler`, `@agent-platform/shared/tools` — all verified to resolve

### Type Cross-References

- [x] `ModuleReleaseContract`: defined in `module-release.model.ts:29-43`, imported by `project-module-dependency.model.ts:13`, consumed in `module-contract.ts:58` and `build-module-release.ts:48`. Same shape everywhere.
- [x] `ModuleReleaseArtifact`: defined in `module-release.model.ts:15-27`, imported in `build-module-release.ts:13`. All fields and literal type unions match.
- [x] `AgentIR`: only imported in `apps/runtime/src/services/modules/types.ts:9` from `@abl/compiler`. Database package correctly avoids this import.
- [x] `ToolDefinitionLocal`: only imported in `types.ts:10` from `@agent-platform/shared/tools`.
- [x] `ModuleRelease` and `ModuleEnvironmentPointer` Mongoose models: imported in `module-selector.ts:10` from `@agent-platform/database/models`. Barrel exports verified.

### Pattern Adherence

- [x] `uuidv7` \_id generation — all 4 new models
- [x] `tenantIsolationPlugin` — all 4 new models
- [x] HMR guard `(mongoose.models[Name] as any) || model<I...>()` — all 4 models
- [x] `err instanceof Error ? err.message : String(err)` — `build-module-release.ts:146`
- [x] `createLogger('module-name')` from `@abl/compiler/platform` — builder and safety validator
- [x] No `findById()` — all queries use `findOne({ _id, tenantId })` or scoped `find()`
- [x] `{ success: true/false }` discriminated union — builder output
- [x] Dynamic `await import('../models/index.js')` in cascade functions
- [x] No `any` except idiomatic Mongoose patterns (`mongoose.models.X as any`, `.lean()` results)

### LLD-to-Implementation Traceability

| LLD Section | Description                    | Status                                                       |
| ----------- | ------------------------------ | ------------------------------------------------------------ |
| 1.1         | Project model extension        | Exact match (5 fields, types, defaults, enum)                |
| 1.2         | ModuleRelease model            | Match except intentional `compiledIR` type boundary (HIGH-1) |
| 1.3         | ModuleEnvironmentPointer model | Exact match                                                  |
| 1.4         | ProjectModuleDependency model  | Exact match (including `contractSnapshot`)                   |
| 1.5         | DeploymentModuleSnapshot model | Exact match                                                  |
| 1.6         | Model registration             | All 4 models in barrel                                       |
| 2.1         | Cascade delete (Path A + B)    | Both paths implemented with correct ordering                 |
| 2.2         | Soft delete                    | `softDeleteModuleProject` implemented and exported           |
| 3.1         | Build pipeline (9 steps)       | All steps in correct order                                   |
| 3.2         | Contract extraction            | All prerequisite types extracted                             |
| 3.3         | Module selector                | Query patterns match LLD exactly                             |
| 6.1         | Runtime types                  | All 7 types match                                            |
| 6.3         | Trace enrichment               | 4 provenance fields present                                  |
| 6.4         | Auth trace event               | `tool_auth_resolved` in `TraceEventType`                     |
| 11.1        | Publish safety                 | Both tiers implemented                                       |

### Test-to-Implementation Alignment

| Test File                        | Tests | Coverage                                                                                                                          |
| -------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------- |
| `module-release-builder.test.ts` | 16+   | Success, validation errors, compile failures, safety blocking, strip variableNamespaceIds, hash determinism, model config warning |
| `module-contract.test.ts`        | 18+   | Provided agents/tools, env vars, secrets, auth profiles, connectors, MCP servers, config keys, deduplication, sorting             |
| `module-selector.test.ts`        | 8+    | Version match/miss/archived, environment match/no-pointer/archived, tenant isolation, unknown type                                |
| `module-publish-safety.test.ts`  | 15+   | Tier 1 structural (HTTP auth), Tier 2 pattern (PEM, URL, prefix, Base64), non-portable warnings, source identifiers               |
| 4 database model tests           | 20+   | Required fields, enum validation, index uniqueness, tenant isolation                                                              |
| `cascade-delete-modules.test.ts` | 8+    | Path A (module project), Path B (consumer project), soft-delete, tenant cascade                                                   |

---

## NOTES

1. **Feature doc drift is the single most persistent consistency gap.** 4 HIGH issues and 4 MEDIUM issues involve the feature doc diverging from the LLD and implementation. The LLD-to-implementation alignment is excellent across all 17 files. The feature doc should be updated as a Sprint 2 prerequisite to prevent downstream integration confusion.

2. **The `compiledIR` three-way type divergence (HIGH-1) is the most persistent cross-package type issue.** It has been independently confirmed in every consistency review (Passes 2, 3, 4, and now 5). The deviation is intentional and well-documented at the model level. The recommended fix (a `parseAgentIR` assertion function) should be implemented early in Sprint 2 before the deployment resolver consumes this data.

3. **All LLD-to-implementation mappings verified.** Every section of the LLD that maps to Sprint 1 scope has a matching implementation with correct types, names, indexes, and logic ordering. No missing implementations found.

4. **Export chains are complete and correct.** Every public symbol has an unbroken barrel export path from source to top-level package entry. ESM `.js` extensions are present on all relative imports.

5. **Test coverage is thorough.** 85+ test cases across 9 test files exercise validation paths, error branches, edge cases, and happy paths. Test file locations match the test guide inventory. All tests import the real implementation signatures (not stale types).

6. **Platform pattern adherence is strong.** All platform invariants are followed: tenant isolation plugin, uuidv7 IDs, HMR guards, platform logger, error handling convention, no `findById()`, standard response envelopes, no `any` beyond Mongoose idioms.

7. **The dual `ModuleSelector`/`ModuleDependencySelector` type naming (MEDIUM-1)** is an inherent boundary issue between packages. The two types cannot be unified without creating an undesirable dependency from `@agent-platform/database` to `@agent-platform/project-io`. JSDoc cross-references are the pragmatic fix.

---

## SUMMARY

| Severity | Count | Primary Theme                                                                            |
| -------- | ----- | ---------------------------------------------------------------------------------------- |
| CRITICAL | 0     | —                                                                                        |
| HIGH     | 4     | 1 type divergence, 3 feature doc field gaps                                              |
| MEDIUM   | 7     | 3 feature doc gaps, 2 naming divergences, 1 builder output flattening, 1 hash convention |
| LOW      | 2     | Test fixture clarity, missing mock                                                       |

---

## VERDICT: APPROVED_WITH_RESERVATIONS

Sprint 1 implementation is **internally consistent** across all 17 implementation files and 9 test files. The LLD-to-implementation alignment is verified for all in-scope sections (Sections 1-3, 6, 11). All index specifications, naming conventions, export chains, type cross-references, and platform patterns are correct.

The reservations that must be resolved before Sprint 2 begins:

1. **Feature doc update** (HIGH-2, HIGH-3, HIGH-4, MEDIUM-3, MEDIUM-4, MEDIUM-5) — 6 issues where `docs/features/reusable-agent-modules.md` lags behind the LLD and implementation. Must be resolved so downstream teams build against accurate specs.

2. **`compiledIR` assertion pattern** (HIGH-1) — Sprint 2 consumers need a documented type-assertion utility rather than bare `as AgentIR` casts.

3. **LLD function name update** (MEDIUM-2) — The LLD references `computeSourceHash` but implementation correctly uses `computeModuleSourceHash`.

These are all documentation and type-safety hygiene items. No implementation code changes are required to unblock Sprint 2.
