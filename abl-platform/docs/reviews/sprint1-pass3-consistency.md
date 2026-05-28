# Sprint 1 — Pass 3: Consistency Review

**Reviewer:** LLD-Reviewer Agent (Pass 3 — Consistency)
**Date:** 2026-03-22
**Scope:** Sprint 1 implementation files cross-referenced against HLD, LLD, feature doc, and test guide. Independent review with no context from previous passes.

---

## Methodology

Systematic cross-check of naming, type cross-references, imports, indexes, error codes, patterns, barrel exports, and test alignment across all specification documents and the Sprint 1 implementation.

Documents reviewed:

- HLD: `docs/specs/reusable-agent-modules-phase-plan.hld.md`
- LLD: `docs/specs/reusable-agent-modules-phase1.lld.md`
- Feature doc: `docs/features/reusable-agent-modules.md`
- Test guide: `docs/testing/reusable-agent-modules.md`

Implementation files reviewed:

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

Test files reviewed:

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

#### HIGH-1: `compiledIR` type mismatch between LLD, model, and builder output

**Location:**

- LLD Section 1.2: `compiledIR: Record<string, AgentIR>` (line 110)
- `packages/database/src/models/module-release.model.ts:59`: `compiledIR: Record<string, unknown>`
- `packages/project-io/src/module-release/build-module-release.ts:73`: `compiledIR: Record<string, Record<string, unknown>>`

The LLD declares the type as `Record<string, AgentIR>` (keyed by agent name, values are full AgentIR objects). The implementation deliberately weakens this:

- The Mongoose model uses `Record<string, unknown>` with an explicit comment explaining it avoids a compile-time dependency on `@abl/compiler` in the database package.
- The builder output uses `Record<string, Record<string, unknown>>` — structurally closer but still not `AgentIR`.

The deviation is intentional and the model comment explains why. However, this creates a three-way type divergence: the LLD says `AgentIR`, the model says `unknown`, and the builder says `Record<string, unknown>`. Downstream consumers in Sprint 2 (deployment build service, deployment resolver) must cast `compiledIR` values to `AgentIR` after reading from MongoDB. The LLD Section 6.1 already shows this casting in the resolver code, but no explicit type-narrowing utility or assertion is planned.

**Impact:** Sprint 2 implementors may use `as AgentIR` casts without runtime validation, creating a latent data shape mismatch risk if the IR schema evolves. The `Record<string, unknown>` in the database model means Mongoose will store whatever is passed with no schema validation on the IR structure.

**Fix:** Add an implementation note to the LLD Section 1.2 (or Section 6.1) specifying that a `parseAgentIR(value: unknown): AgentIR` assertion function should be used when reading `compiledIR` from MongoDB, rather than bare `as AgentIR` casts. Alternatively, document the intentional deviation with a cross-reference between the three locations.

---

#### HIGH-2: Feature doc `module_releases` field list omits `compiledIR` and `releaseNotes`

**Location:** `docs/features/reusable-agent-modules.md:99-114`

The feature doc's ModuleRelease collection field list does not include `compiledIR` or `releaseNotes`, which are present in both the LLD (Section 1.2, lines 107-108) and the implementation (`module-release.model.ts:52-53, 59`).

**Impact:** Teams referencing the feature doc for integration work (e.g., runtime deployment build service) will not know that `compiledIR` is available, leading them to re-compile from DSL sources at deployment time instead of using the pre-compiled IR.

**Fix:** Add `compiledIR: Record<string, unknown>` and `releaseNotes: string | null` to the feature doc's ModuleRelease field list.

---

#### HIGH-3: Feature doc DeploymentModuleSnapshot storage model is misleading

**Location:** `docs/features/reusable-agent-modules.md:148-164`

The feature doc lists `dependencies`, `mountedAgents`, and `mountedTools` as direct collection fields. The implementation (`deployment-module-snapshot.model.ts:15-24`) and LLD (Section 1.5) store these inside a single `compressedPayload: Buffer` field (gzip-compressed JSON of `DeploymentModuleSnapshotPayload`).

**Impact:** Any consumer reading the feature doc will expect to query these fields directly from the Mongoose model and get `undefined`. The actual data requires `gunzip + JSON.parse` of `compressedPayload`.

**Fix:** Update the feature doc to show `compressedPayload: Buffer (gzip-compressed JSON)` and note the payload structure separately.

---

#### HIGH-4: Feature doc DeploymentModuleSnapshot index missing `tenantId`

**Location:** `docs/features/reusable-agent-modules.md:162` vs `deployment-module-snapshot.model.ts:47`

Feature doc specifies `{ deploymentId: 1 } (unique)`. Implementation has `{ tenantId: 1, deploymentId: 1 } (unique)`. The LLD Section 1.5 matches the implementation.

**Fix:** Update feature doc index to `{ tenantId: 1, deploymentId: 1 } (unique)`.

---

### MEDIUM

#### MEDIUM-1: Dual selector type names across packages

**Location:**

- `packages/project-io/src/module-release/module-selector.ts:12`: `ModuleSelector`
- `packages/database/src/models/project-module-dependency.model.ts:17`: `ModuleDependencySelector`

Both types are structurally identical: `{ type: 'version' | 'environment'; value: string }`. Both are exported from their respective barrel files. The LLD Section 1.4 uses inline shape `{ type: 'version' | 'environment'; value: string }` and Section 3.3 uses `ModuleSelector`.

**Impact:** Consumer code must choose between two equivalent types. If one diverges in Sprint 2 (e.g., adding `'latest'` as a selector type), the other would silently fall out of sync.

**Fix:** Either (a) have `ModuleDependencySelector` import and re-export `ModuleSelector` from project-io, or (b) add JSDoc cross-references on each type. Option (a) creates a dependency from database to project-io which may not be desirable; option (b) is sufficient for Sprint 1.

---

#### MEDIUM-2: Feature doc `project_module_dependencies` omits `contractSnapshot` field

**Location:** `docs/features/reusable-agent-modules.md:131-146`

The feature doc lists `configOverrides: Record<string, string>` but does not include `contractSnapshot: ModuleReleaseContract` which is required in both the LLD (Decision 1c, Section 1.4, line 224) and the implementation (`project-module-dependency.model.ts:33`).

**Fix:** Add `contractSnapshot: ModuleReleaseContract (denormalized)` to the feature doc's field list.

---

#### MEDIUM-3: Feature doc `projects` collection omits `moduleDependencyVersion`, `archivedAt`, `archivedBy`

**Location:** `docs/features/reusable-agent-modules.md:86-96`

The feature doc lists only `kind` and `moduleVisibility` as new project fields. The implementation (`project.model.ts:26-28`) and LLD (Section 1.1, Section 10.1) also add `moduleDependencyVersion`, `archivedAt`, and `archivedBy`.

**Fix:** Add these three fields to the feature doc's project collection specification.

---

#### MEDIUM-4: Feature doc `project_module_dependencies` omits `createdAt`

**Location:** `docs/features/reusable-agent-modules.md:131-146`

The feature doc lists `updatedAt` but not `createdAt`. The implementation uses `timestamps: true` which creates both. The LLD Section 1.4 interface specifies both fields.

**Fix:** Add `createdAt: Date` to the feature doc's field list.

---

#### MEDIUM-5: Feature doc Studio API table omits two routes from LLD

**Location:** `docs/features/reusable-agent-modules.md:52-63`

Missing routes:

1. `POST /api/projects/:id/module-dependencies/preview` — LLD Section 7.1 (two-step import preview)
2. `GET /api/projects/:id/module-catalog/:moduleProjectId` — LLD Section 7.1 (module detail with full contract)

These are essential for the import UX flow (Decision 6b: two-step preview/confirm).

**Fix:** Add both routes to the feature doc's Studio API table.

---

#### MEDIUM-6: TraceEventType comment label misleading

**Location:** `packages/shared-kernel/src/types/trace-event.ts:27`

The comment `// Module provenance events` precedes only `tool_auth_resolved`. This event is about auth profile scope tracing for imported tools (LLD Section 6.4, Decision 5b), not about general module provenance. The actual module provenance data is carried through the optional fields on `TraceEvent` (`moduleAlias`, `moduleProjectId`, `moduleReleaseId`, `sourceAgentName` at lines 43-50), not through dedicated event types.

**Impact:** Low. A future implementor could misunderstand and add module lifecycle events (like `module_merge`, `module_resolve`) as new `TraceEventType` values when the design intent is to use the provenance fields on existing event types.

**Fix:** Change comment to `// Module auth scope tracing` or `// Tool auth resolution for imported modules`.

---

#### MEDIUM-7: `ModuleReleaseBuildSuccess.warnings` is `string[]` but `ModuleReleaseBuildFailure.warnings` is also `string[]` -- differs from LLD two-tier shape

**Location:**

- `packages/project-io/src/module-release/build-module-release.ts:76,82`: Both success and failure use `warnings: string[]`
- LLD Section 3.1 (Decision 2b: two-tier errors/warnings): Specifies structured output with separate `errors` and `warnings` arrays

The LLD describes a two-tier system where safety validation returns structured `{ severity: 'blocking' | 'warning'; code: string; source: string; message: string }` issues. The builder correctly processes these internally, but flattens them to `string[]` in the output. This means the API consumer (Studio publish route in Sprint 2) loses the structured `code` and `source` fields and must parse error messages to extract them.

**Impact:** The Studio publish route (Sprint 2, LLD Section 7.5) will receive flat string errors/warnings. If the route needs to display structured error details (e.g., which tool has a secret leak, with a code for i18n), it would need to re-parse the `[CODE] source: message` format.

**Fix:** Consider changing `warnings` and `errors` to `Array<{ code: string; source: string; message: string }>` on the build result types. Alternatively, accept the current flattening as sufficient for Sprint 1 and add structured output in Sprint 2.

---

### LOW

#### LOW-1: Test fixture `configOverrides: { API_KEY: 'sk-test-123' }` with `isSecret: true` contract

**Location:** `packages/database/src/__tests__/model-project-module-dependency.test.ts`

The test helper uses `configOverrides: { API_KEY: 'sk-test-123' }` while the contract declares `requiredConfigKeys: [{ key: 'API_KEY', isSecret: true }]`. Per LLD Section 11.2, this combination should be rejected at business validation time. The model test is testing Mongoose schema behavior, not business logic, so this is technically correct but confusing.

**Fix:** Add a comment or use a non-secret config key in the fixture.

---

#### LOW-2: `event-cascade-hooks.ts` not explicitly mocked in cascade-delete-modules.test.ts

**Location:** `packages/database/src/__tests__/cascade-delete-modules.test.ts`

The test mocks `../models/index.js` but not `./event-cascade-hooks.js`. The `deleteProject` function imports `getEventCascadeHook` which could attempt real operations. Works because the hook returns `undefined` by default in test environments, but is fragile.

**Fix:** Add `vi.mock('./event-cascade-hooks.js', ...)` to the test for explicit safety.

---

#### LOW-3: `module-publish-safety.ts` uses regex `BASE64_RE` that could false-positive on DSL keywords

**Location:** `packages/project-io/src/module-release/module-publish-safety.ts:55`

The regex `/[A-Za-z0-9+/=]{20,}/g` matches any 20+ alphanumeric string including normal DSL content like long agent descriptions or tool configuration paths. The `looksLikeEncodedSecret` heuristic filters most false positives, but edge cases exist. This was addressed in the implementation as a `warning` (not `blocking`), so impact is limited.

**Impact:** None for Sprint 1. The two-tier severity system correctly classifies Base64 detections as warnings.

---

## VERIFIED

### Naming Consistency

- [x] **Collection names** — `module_releases`, `module_environment_pointers`, `project_module_dependencies`, `deployment_module_snapshots` consistent across LLD, implementation, and feature doc
- [x] **Model registration names** — `ModuleRelease`, `ModuleEnvironmentPointer`, `ProjectModuleDependency`, `DeploymentModuleSnapshot` match across `mongoose.model()` calls and barrel exports
- [x] **Interface names** — `IModuleRelease`, `IModuleEnvironmentPointer`, `IProjectModuleDependency`, `IDeploymentModuleSnapshot` consistent in model files and barrel exports
- [x] **Runtime types** — `ModuleProvenance`, `ResolvedAgentIR`, `ResolvedToolDefinition`, `DeploymentModuleSnapshotPayload`, `MountedAgentEntry`, `MountedToolEntry`, `DeploymentModuleDependency` all match LLD Section 6.1 definitions
- [x] **Sub-document types** — `ModuleReleaseArtifact`, `ModuleReleaseContract` match LLD Section 1.2

### Type Cross-References

- [x] **ModuleReleaseContract** — Defined in `module-release.model.ts`, imported by `project-module-dependency.model.ts` (line 13), used by `module-contract.ts` (return type), `build-module-release.ts` (via ExtractContractFn). Consistent chain.
- [x] **ModuleReleaseArtifact** — Defined in `module-release.model.ts`, imported by `build-module-release.ts` (line 13). Type matches across definition and usage.
- [x] **AgentIR** — Referenced only in `apps/runtime/src/services/modules/types.ts` via `@abl/compiler`. Database package correctly avoids this dependency.
- [x] **ToolDefinitionLocal** — Referenced in `apps/runtime/src/services/modules/types.ts` via `@agent-platform/shared/tools`. Import path verified against actual export at `packages/shared/src/tools/resolve-tool-implementations.ts:103`.

### Import Paths (ESM)

- [x] All `.js` extensions present on every relative import in all implementation files
- [x] Cross-package imports use correct package specifiers: `@agent-platform/database/models`, `@abl/compiler/platform`, `@abl/compiler`, `@agent-platform/shared/tools`
- [x] `module-contract.ts` imports `extractEnvVarReferences`, `extractSecretReferences`, `extractAuthProfileReferences` from `../export/env-var-scanner.js` — verified these exports exist at `packages/project-io/src/export/env-var-scanner.ts:7,18,29`
- [x] All test imports use correct relative paths and `vi.mock()` paths

### Index Specifications

- [x] **ModuleRelease** — `{ tenantId: 1, moduleProjectId: 1, version: 1 }` unique + `{ tenantId: 1, moduleProjectId: 1, createdAt: -1 }` listing — matches LLD Section 1.2
- [x] **ModuleEnvironmentPointer** — `{ tenantId: 1, moduleProjectId: 1, environment: 1 }` unique — matches LLD Section 1.3
- [x] **ProjectModuleDependency** — `{ tenantId: 1, projectId: 1, alias: 1 }` unique + `{ tenantId: 1, moduleProjectId: 1 }` reverse lookup — matches LLD Section 1.4
- [x] **DeploymentModuleSnapshot** — `{ tenantId: 1, deploymentId: 1 }` unique + `{ tenantId: 1, projectId: 1 }` listing — matches LLD Section 1.5

### Pattern Adherence

- [x] **uuidv7 \_id generation** — All 4 new models use `{ type: String, default: uuidv7 }` consistent with existing models
- [x] **tenantIsolationPlugin** — All 4 new models call `.plugin(tenantIsolationPlugin)` consistent with existing models
- [x] **HMR guard** — All 4 new models use `mongoose.models[Name] || model()` pattern
- [x] **Error handling** — `err instanceof Error ? err.message : String(err)` at `build-module-release.ts:146` follows CLAUDE.md standard
- [x] **Logger** — `createLogger('module-release-builder')` and `createLogger('module-publish-safety')` use correct `@abl/compiler/platform` import
- [x] **Cascade delete** — Uses dynamic `await import('../models/index.js')` inside function body, same as existing `deleteTenant`/`deleteProject`
- [x] **No `findById()`** — All queries use `findOne({ _id, tenantId })` pattern per platform isolation rules
- [x] **Standard envelope** — `build-module-release.ts` returns `{ success: true/false }` discriminated union
- [x] **No `any`** — Only uses `any` in Mongoose model registration guards (`mongoose.models.X as any`) and `lean()` results — both are idiomatic patterns

### Barrel Export Completeness

- [x] **`packages/database/src/models/index.ts`** — Lines 149-169 export all 4 models, their interfaces, and sub-types under `// --- Modules ---` section
- [x] **`packages/database/src/cascade/index.ts`** — Exports `softDeleteModuleProject` and `CascadeDeleteBlockedError` alongside existing cascade functions
- [x] **`packages/project-io/src/module-release/index.ts`** — Exports all 5 modules with their types (15 named exports total)
- [x] **`packages/project-io/src/index.ts:14`** — Re-exports `./module-release/index.js`
- [x] **`packages/shared-kernel/src/types/index.ts:198`** — Re-exports `TraceEventType` and `TraceEvent` types

### Test-Implementation Alignment

- [x] **Test file paths match test guide** — All 9 test file paths in the test guide (`docs/testing/reusable-agent-modules.md:38-46`) match actual file locations
- [x] **module-release-builder.test.ts** — 16 test cases covering: success path, validation errors (no agents, null entry, missing entry), compile failures (null, throw Error, throw non-Error), safety blocking/warnings, variableNamespaceIds stripping, sourceHash determinism/divergence, per-asset hashes, model config warning, dependency injection verification, multiple compile failures
- [x] **module-contract.test.ts** — 18 test cases covering: provided agents/tools, env var extraction, secret extraction, auth profile extraction with referencedBy tracking, connector extraction, MCP server extraction, config key extraction with isSecret flag, deduplication, empty project, mixed content, alphabetical sorting
- [x] **module-selector.test.ts** — 8 test cases covering: version resolution, environment resolution (pointer + release), missing pointer, archived release, deleted release, tenant isolation, unknown selector type
- [x] **module-publish-safety.test.ts** — 14 test cases covering: Tier 1 structural (6 scenarios), Tier 2 pattern-based (5 scenarios), non-portable warnings (2 scenarios), source-project identifiers (3 scenarios), clean cases (3 scenarios)

### LLD-to-Implementation Traceability

- [x] **LLD Section 1.1** (Project model extension) — All 5 new fields implemented with correct types and defaults
- [x] **LLD Section 1.2** (ModuleRelease) — Model matches except compiledIR type (see HIGH-1, intentional deviation)
- [x] **LLD Section 1.3** (ModuleEnvironmentPointer) — Model matches exactly
- [x] **LLD Section 1.4** (ProjectModuleDependency) — Model matches exactly
- [x] **LLD Section 1.5** (DeploymentModuleSnapshot) — Model matches exactly
- [x] **LLD Section 1.6** (Model registration) — All 4 models exported from barrel
- [x] **LLD Section 2** (Cascade delete) — Both paths implemented with correct ordering, blocking error, soft-delete
- [x] **LLD Section 3.1** (Build pipeline) — All 9 steps implemented in correct order
- [x] **LLD Section 3.2** (Contract extraction) — Implemented with all prerequisite types
- [x] **LLD Section 3.3** (Module selector) — Implemented with exact query patterns
- [x] **LLD Section 6.1** (Runtime types) — All types match LLD definitions
- [x] **LLD Section 11.1** (Publish safety) — Both tiers implemented with all pattern types
- [x] **LLD Section 13** (Sprint 1 items 1-7) — All items implemented

---

## NOTES

1. **Feature doc is the primary source of drift.** All HIGH issues (except HIGH-1) and most MEDIUM issues are feature doc inconsistencies. The LLD and implementation are tightly aligned. The feature doc should be updated before Sprint 2 starts so downstream teams don't build against stale field lists or missing routes.

2. **The `compiledIR` type deviation (HIGH-1) is intentional and well-commented**, but the three-way divergence (LLD says `AgentIR`, model says `unknown`, builder says `Record<string, unknown>`) deserves a documented assertion pattern for Sprint 2 consumers. Without it, the deployment resolver and build service will use bare `as AgentIR` casts.

3. **The flattened `string[]` warnings/errors on the builder output (MEDIUM-7)** may need revisiting in Sprint 2 if the Studio publish route needs to display structured error details with i18n codes. For Sprint 1 (no Studio routes yet), the flat format is adequate.

4. **The dual selector type naming (MEDIUM-1)** is a known structural issue from previous reviews. It does not block implementation but should be resolved before the types are consumed in more places.

5. **Implementation quality is consistently high.** All patterns (uuidv7, tenantIsolationPlugin, HMR guard, ESM extensions, platform logger, error handling) are followed uniformly. No deviations from the CLAUDE.md coding standards were found.

6. **Test coverage for Sprint 1 scope is thorough.** The 56+ test cases across 9 test files cover all validation paths, error cases, edge cases, and happy paths specified in the LLD.

---

## VERDICT: APPROVED_WITH_RESERVATIONS

The Sprint 1 implementation is consistent with the LLD across naming, types, indexes, collection names, imports, exports, error codes, and patterns. The reservations are:

1. Feature doc drift (HIGH-2, HIGH-3, HIGH-4, MEDIUM-2 through MEDIUM-5) — must be resolved before Sprint 2 begins
2. `compiledIR` type divergence (HIGH-1) — intentional but needs documented assertion pattern for Sprint 2
3. Builder output flattening (MEDIUM-7) — acceptable for Sprint 1, may need structured output in Sprint 2

**Summary:**

- 0 CRITICAL issues
- 4 HIGH issues (1 type divergence, 3 feature doc field/index gaps)
- 7 MEDIUM issues (4 feature doc gaps, 1 dual type naming, 1 misleading comment, 1 builder output shape)
- 3 LOW issues (test fixture clarity, missing mock, regex false positives)
- All 17 implementation files verified against LLD
- All 9 test files verified against implementation
- All barrel exports complete and correct
- All ESM import paths verified
- All index specifications match LLD
- All collection names consistent across documents
