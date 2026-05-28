# Sprint 1 -- Pass 5: Architecture Review (FINAL)

**Reviewer:** LLD Reviewer Agent (Architecture)
**Date:** 2026-03-22
**Scope:** Full Sprint 1 implementation -- data models, cascade delete, module release builder, contract extractor, module selector, publish safety validator, runtime types, trace events, barrel exports, unit tests
**Spec:** `docs/specs/reusable-agent-modules-phase1.lld.md` (Sections 1-3, 6.1 types, 11.1, 13 Sprint 1 scope), `docs/specs/reusable-agent-modules-phase-plan.hld.md`
**Context:** Final pass of 5-pass audit. NO prior-pass context. Independent assessment.

---

## VERDICT: APPROVED_WITH_RESERVATIONS

Sprint 1 is architecturally sound and ready to ship. The data model, cascade logic, builder pipeline, and safety validation are well-implemented and properly aligned with the LLD. Two HIGH issues should be fixed before Sprint 2 begins (test fixture and softDeleteModuleProject early-return). No CRITICAL issues.

---

## ISSUES

### CRITICAL

None.

### HIGH

**HIGH-1: `softDeleteModuleProject` silently proceeds with release archival when project is not a module**

The `kind: 'module'` guard was added to the `findOneAndUpdate` filter (line 376), which is good -- an application project will not be archived. However, if the project is NOT a module, the function silently continues to `ModuleRelease.updateMany({ tenantId, moduleProjectId })` on line 380. For an application project this is a no-op (no releases exist), but the function returns `{ archivedReleases: 0 }` with no indication that the project was not found or was the wrong kind. Callers will interpret this as success.

- File: `packages/database/src/cascade/cascade-delete.ts:366-386`
- Fix: Check the `findOneAndUpdate` return value. If null, either throw an error or return a distinct result indicating the project was not archived:
  ```ts
  const result = await Project.findOneAndUpdate(
    { _id: moduleProjectId, tenantId, kind: 'module' },
    { $set: { archivedAt: now, archivedBy: userId } },
  );
  if (!result) {
    throw new Error(`Project ${moduleProjectId} is not a module or does not exist`);
  }
  ```
- Impact: Sprint 2 service layer will call this function from archive routes. Silent no-ops create confusing UX.

**HIGH-2: Test fixture `model-project-module-dependency.test.ts` stores secret value in configOverrides against a contract declaring `isSecret: true`**

The `validDependency()` fixture sets `configOverrides: { API_KEY: 'sk-test-123' }` while `validContract()` declares `requiredConfigKeys: [{ key: 'API_KEY', isSecret: true }]`. Per LLD Section 11.2, this combination must be rejected by `validateConfigOverrides`. The model layer does not enforce this (it uses `Schema.Types.Mixed`), but tests that model invalid end-to-end scenarios mislead future implementors.

- File: `packages/database/src/__tests__/model-project-module-dependency.test.ts:34-44`
- Fix: Either change the contract to `isSecret: false`, or change the config key to a non-secret key (e.g., `TIMEOUT: '30'` with `isSecret: false`). The model test should represent a valid scenario even though validation is service-layer.

### MEDIUM

**MEDIUM-1: `compiledIR` three-way type divergence requires Sprint 2 assertion utility**

- LLD: `Record<string, AgentIR>`
- Database model: `Record<string, unknown>` (intentional -- avoids `@abl/compiler` dependency)
- Builder: `Record<string, Record<string, unknown>>`

All three are structurally compatible at runtime. The database deviation is well-commented (lines 54-59 of module-release.model.ts). However, Sprint 2 consumers reading `compiledIR` from MongoDB will need a validated assertion pattern rather than bare `as AgentIR`.

- Files: `packages/database/src/models/module-release.model.ts:58-59`, `packages/project-io/src/module-release/build-module-release.ts:73`
- Fix: Sprint 2 should add a `assertAgentIR(value: unknown): AgentIR` utility. No Sprint 1 change needed.

**MEDIUM-2: `DeploymentModuleSnapshotPayload` type lives in runtime, not co-located with the DB model**

The payload schema for `compressedPayload` is defined in `apps/runtime/src/services/modules/types.ts:75-80` but the envelope model is in `packages/database/src/models/deployment-module-snapshot.model.ts`. This creates an implicit coupling: if the runtime type drifts, the compressed payload becomes unreadable.

- Fix: Add a cross-reference comment in the database model pointing to the payload type definition. Consider re-exporting from shared-kernel if Sprint 2 requires cross-package access.

**MEDIUM-3: Dual selector type -- `ModuleSelector` vs `ModuleDependencySelector`**

`packages/project-io/src/module-release/module-selector.ts` exports `ModuleSelector` and `packages/database/src/models/project-module-dependency.model.ts` exports `ModuleDependencySelector`. Identical shape: `{ type: 'version' | 'environment'; value: string }`.

- Fix: Consolidate in Sprint 2 before the Studio API layer references both. No Sprint 1 change needed.

**MEDIUM-4: No test verifies soft-delete path correctly handles non-module project**

`cascade-delete-modules.test.ts` tests `softDeleteModuleProject` but only the happy path (project exists and is a module). There is no test for calling it with an application project or a non-existent project.

- File: `packages/database/src/__tests__/cascade-delete-modules.test.ts:282-307`
- Fix: Add a test confirming that `softDeleteModuleProject` for a non-module project either throws or returns a distinct result (depending on HIGH-1 fix).

**MEDIUM-5: Pre-existing cascade delete does not scope all deletes by `tenantId`**

The new module cascade code correctly includes `tenantId` in all `deleteMany` calls (Path A/B). The pre-existing standard cascade uses `projectId`-only filters for Session, Deployment, Workflow, and other entities (lines 282-354). This is not new to Sprint 1 but worth tracking.

- Fix: Incrementally add `tenantId` to existing deleteMany calls in a follow-up. Non-blocking for Sprint 1.

### LOW

**LOW-1: `computeModuleSourceHash` renamed from LLD spec `computeSourceHash`**

The LLD Section 1.2 specifies `computeSourceHash(entryAgentName, agents, tools)` but the implementation correctly uses `computeModuleSourceHash` to avoid collision with the existing platform-level `computeSourceHash(content: string)` in shared-kernel.

- Status: Intentional rename. Sound engineering decision. LLD should be updated to reflect the actual name.

**LOW-2: `TraceEventType` does not include module-specific resolve/mount event types**

The LLD Section 6.3 specifies enriching existing trace events with module fields rather than adding dedicated `module_resolved`/`module_mounted` types. The implementation adds `tool_auth_resolved` as specified. Module provenance is attached as optional fields on the existing `TraceEvent` interface. This is correct for Phase 1.

- Status: Correct per LLD specification.

---

## VERIFIED

### Data Model vs LLD

- [x] **ModuleRelease** -- All fields match LLD Section 1.2. `_id`, `tenantId`, `moduleProjectId`, `version`, `releaseNotes`, `artifact` (Mixed), `compiledIR` (Mixed), `contract` (Mixed), `sourceHash`, `createdBy`, `createdAt`, `archivedAt`, `archivedBy`. Timestamps: createdAt only (updatedAt disabled). Collection: `module_releases`.
- [x] **ModuleEnvironmentPointer** -- All fields match LLD Section 1.3. `_id`, `tenantId`, `moduleProjectId`, `environment` (enum: dev/staging/production), `moduleReleaseId`, `revision` (default 1), `updatedBy`. Timestamps: updatedAt only (createdAt disabled). Collection: `module_environment_pointers`.
- [x] **ProjectModuleDependency** -- All fields match LLD Section 1.4. `_id`, `tenantId`, `projectId`, `moduleProjectId`, `alias`, `selector` (sub-schema with type/value), `resolvedReleaseId`, `configOverrides` (Mixed, default {}), `contractSnapshot` (Mixed), `createdBy`. Timestamps: both enabled. Collection: `project_module_dependencies`.
- [x] **DeploymentModuleSnapshot** -- All fields match LLD Section 1.5. `_id`, `tenantId`, `projectId`, `deploymentId`, `snapshotHash`, `compressedPayload` (Buffer), `createdBy`. Timestamps: createdAt only. Collection: `deployment_module_snapshots`.
- [x] **Project extension** -- `kind` (enum application/module, default application, required), `moduleVisibility` (enum private/tenant, default private), `moduleDependencyVersion` (Number, default 0), `archivedAt` (Date, default null), `archivedBy` (String, default null). All present in both IProject interface and Mongoose schema.

### Index Definitions

- [x] `ModuleRelease: { tenantId: 1, moduleProjectId: 1, version: 1 }` unique -- prevents duplicate version publishes
- [x] `ModuleRelease: { tenantId: 1, moduleProjectId: 1, createdAt: -1 }` -- listing sorted by recency
- [x] `ModuleEnvironmentPointer: { tenantId: 1, moduleProjectId: 1, environment: 1 }` unique -- one pointer per environment
- [x] `ProjectModuleDependency: { tenantId: 1, projectId: 1, alias: 1 }` unique -- one alias per consumer project
- [x] `ProjectModuleDependency: { tenantId: 1, moduleProjectId: 1 }` -- reverse dependency lookup
- [x] `DeploymentModuleSnapshot: { tenantId: 1, deploymentId: 1 }` unique -- one snapshot per deployment
- [x] `DeploymentModuleSnapshot: { tenantId: 1, projectId: 1 }` -- consumer project listing

### Tenant Isolation

- [x] All 4 new models register `tenantIsolationPlugin`
- [x] All queries in `module-selector.ts` scope by `tenantId`
- [x] All cascade delete paths (Path A, Path B, tenant) scope by `tenantId`
- [x] `softDeleteModuleProject` scopes by `tenantId`
- [x] `CascadeDeleteBlockedError` consumer lookup scopes by `tenantId`

### Barrel Exports

- [x] All 4 models exported from `packages/database/src/models/index.ts` (lines 149-169) with model class, document interface, and sub-types
- [x] All 4 models exported from `packages/database/src/index.ts` with proper type-only exports for interfaces
- [x] `packages/project-io/src/module-release/index.ts` exports all builder, contract, selector, and safety types

### Cascade Delete

- [x] **Path A (module project)** -- Blocks on active consumers via `countDocuments`. Throws `CascadeDeleteBlockedError` with consumer project IDs (limited to 100). Deletes pointers then releases when no consumers. Does NOT delete consumer deployment snapshots.
- [x] **Path B (consumer project)** -- Deletes `ProjectModuleDependency` and `DeploymentModuleSnapshot` scoped to `(tenantId, projectId)`. Runs for all projects (not just applications), which correctly handles module-project-as-consumer edge case.
- [x] **Tenant deletion** -- All 4 module collections in correct dependency order: snapshots -> deps -> pointers -> releases (lines 110-120).
- [x] **Soft delete** -- Archives project with `kind: 'module'` guard and all releases with `tenantId` scope.
- [x] **`CascadeDeleteBlockedError`** -- Has `code` property (`MODULE_DELETE_BLOCKED`), `consumerProjectIds` (public with WARNING jsdoc), extends Error.

### Module Release Builder

- [x] 9-step pipeline matches LLD Section 3.1 exactly
- [x] DI pattern: `compileFn`, `extractContractFn`, `validatePublishSafetyFn` injected as function parameters -- clean testability
- [x] Error handling: `err instanceof Error ? err.message : String(err)` (line 147)
- [x] `variableNamespaceIds` stripping: recursive `stripVariableNamespaceIds` handles nested objects and arrays (tested)
- [x] Per-agent and per-tool sourceHash: 16-char truncated SHA-256
- [x] Safety validation runs before contract extraction (order matters -- blocking issues abort early)
- [x] Model config warning emitted when `hasModelConfigs` is true
- [x] Builder output: discriminated union `ModuleReleaseBuildResult` (success/failure)

### Contract Extraction

- [x] Reuses `extractEnvVarReferences`, `extractSecretReferences`, `extractAuthProfileReferences` from `env-var-scanner.ts`
- [x] Custom extractors for connectors, MCP servers, config keys, secret config keys
- [x] Deduplication via Sets/Maps
- [x] Sorted output for deterministic serialization
- [x] Auth profile `referencedBy` tracks which agents/tools reference each profile

### Module Selector

- [x] Version selector: `findOne({ tenantId, moduleProjectId, version, archivedAt: null })`
- [x] Environment selector: pointer lookup then release lookup, both scoped by `tenantId`
- [x] Archived releases excluded via `archivedAt: null` filter
- [x] Error result uses discriminated union pattern

### Publish Safety Validator

- [x] Tier 1 structural: HTTP tool auth config must use `auth_profile_ref` or templating
- [x] Tier 2 pattern: PEM keys, sk- prefixes, Bearer tokens, URL-embedded keys, Base64 suspects
- [x] Non-portable warnings: SearchAI indexId, workflowId bindings
- [x] Source-project identifiers: variableNamespaceIds (blocking), raw \_id/projectId/tenantId (warning)
- [x] Template patterns (`{{env.*}}`, `{{config.*}}`, `{{secrets.*}}`) correctly excluded from false positives

### Runtime Types

- [x] `ModuleProvenance` -- alias, moduleProjectId, moduleReleaseId, sourceAgentName
- [x] `ResolvedAgentIR` -- extends `AgentIR` with optional `_moduleProvenance`
- [x] `ResolvedToolDefinition` -- extends `ToolDefinitionLocal` with optional `_moduleProvenance` (sourceToolName instead of sourceAgentName)
- [x] `DeploymentModuleDependency`, `MountedAgentEntry`, `MountedToolEntry` -- deployment snapshot sub-types
- [x] `DeploymentModuleSnapshotPayload` -- compressed payload schema with snapshotHash

### TraceEvent Extension

- [x] `tool_auth_resolved` added to `TraceEventType` union
- [x] `moduleAlias`, `moduleProjectId`, `moduleReleaseId`, `sourceAgentName` added as optional fields on `TraceEvent`
- [x] Backward compatible -- local agents produce traces with no module fields

### Test Coverage

- [x] **Model tests** -- All 4 new models have validation, default value, and DB-dependent tests covering uniqueness, scoping, and timestamps. ModuleEnvironmentPointer additionally tests optimistic concurrency (revision mismatch returns null).
- [x] **Cascade delete tests** -- Path A blocking, Path A clean delete, Path B consumer cleanup, soft delete, tenant cascade, `CascadeDeleteBlockedError` shape. All tested with mocked models.
- [x] **Builder tests** -- 20 test cases covering success, validation failures (no agents, null entryAgentName, empty entryAgentName, missing entry agent), compile failures (null, throw Error, throw non-Error), safety blocking, safety warnings passthrough, variableNamespaceIds stripping, sourceHash determinism/uniqueness, per-agent/tool hashes, model config warning, contract and safety function argument verification.
- [x] **Contract tests** -- Provided agents/tools, env vars, secrets, auth profiles, connectors, MCP servers, config keys, deduplication, sorting, empty project, mixed content.
- [x] **Selector tests** -- Version match, version not found, archived version, environment match, missing pointer, archived pointer, deleted pointer, tenant isolation, unknown selector type.
- [x] **Safety tests** -- Structural (HTTP auth directives, headers, templates), pattern (PEM, sk-, Bearer, URL keys, Base64), non-portable (SearchAI, workflow), source identifiers (variableNamespaceIds, \_id, projectId), clean cases.

---

## ARCHITECTURE ASSESSMENT

### Strengths

1. **Clean package boundaries**: The database package uses `Record<string, unknown>` for `compiledIR` and `Schema.Types.Mixed` for complex sub-documents, avoiding compile-time dependencies on `@abl/compiler`. Runtime types use concrete `AgentIR` imports. The dependency direction is correct: `runtime -> {database, compiler, shared-kernel}`, `project-io -> {database, compiler}`, `database -> {nothing}`.

2. **DI-based builder pipeline**: The three injected functions (`compileFn`, `extractContractFn`, `validatePublishSafetyFn`) make the builder fully unit-testable without any module mocking. This is the right pattern for a pipeline that crosses package boundaries.

3. **Two-path cascade design**: Path A (module project) blocks on consumers and preserves consumer snapshots. Path B (consumer project) cleans up its own dependencies and snapshots. Tenant deletion cascades all four collections in correct dependency order. The `CascadeDeleteBlockedError` with its `consumerProjectIds` property (bounded to 100, with serialization warning) is well-designed.

4. **Immutability enforcement**: `ModuleRelease` disables `updatedAt` timestamps and uses a `(tenantId, moduleProjectId, version)` unique index to prevent duplicate publishes at the DB level. Combined with the LLD's specified `insertOne + catch E11000` pattern for the publish route, this provides robust deduplication.

5. **Comprehensive safety validation**: The two-tier approach (structural + pattern-based) with blocking/warning severity levels provides actionable feedback at publish time. The recursive `stripVariableNamespaceIds` function in the builder provides defense-in-depth against namespace ID leaks.

6. **Tenant isolation consistency**: Every query in every new file includes `tenantId`. The `tenantIsolationPlugin` is registered on all four new models. The new module cascade code is more secure than the pre-existing standard cascade (which omits `tenantId` from some `deleteMany` calls).

### Architecture Risks for Sprint 2

1. **`validateConfigOverrides` not implemented**: LLD Section 11.2 specifies this function with full pseudocode (50-key limit, 1KB/value limit, secret key rejection, template injection prevention, control character rejection). It exists only in the LLD and previous review documents. Sprint 2 must implement this before the import-dependency route goes live. This is the most significant Sprint 2 blocker identified.

2. **`compiledIR` type narrowing**: Sprint 2 code that reads `compiledIR` from MongoDB must use a validated assertion pattern. Bare `as AgentIR` casts will create silent runtime errors if the IR schema evolves.

3. **`DeploymentModuleSnapshotPayload` co-location**: The payload type lives in the runtime package but is consumed by the database model's `compressedPayload`. Sprint 2 should add at minimum a cross-reference comment.

---

## NOTES

- Sprint 1 scope (LLD Section 13) is fully covered: data models, cascade delete, shared types, module release builder, publish safety, module selector, and unit tests.
- The `softDeleteModuleProject` `kind: 'module'` guard was added since Pass 3/4 flagged it. The remaining issue is the silent no-op on non-module projects (HIGH-1).
- The `CascadeDeleteBlockedError.consumerProjectIds` field is public with a JSDoc warning against serialization. This is acceptable for Sprint 1 but should be revisited if error serialization middleware is added.
- The test fixture secret-in-configOverrides issue (HIGH-2) is model-layer-only. The service layer (Sprint 2) will enforce `validateConfigOverrides`, but the fixture sets a bad example.
- No CRITICAL issues. The two HIGH issues are fixable in a single follow-up PR before Sprint 2 implementation begins.
