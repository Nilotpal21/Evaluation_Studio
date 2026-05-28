# Sprint 1 — Pass 1: Consistency Review

**Reviewer:** lld-reviewer
**Date:** 2026-03-22
**Scope:** All Sprint 1 implementation files vs LLD, HLD, feature doc, and testing doc

---

## Summary

**Verdict: APPROVED_WITH_RESERVATIONS**

Overall, the Sprint 1 implementation is highly consistent across the codebase. The data models, cascade delete logic, release builder pipeline, contract extractor, module selector, and publish safety validator all faithfully follow the LLD specification. Naming conventions, collection names, index definitions, and type cross-references are correct and aligned across all documents.

Six findings were identified. Two are MEDIUM severity (deliberate implementation deviations that should be documented), three are LOW severity (minor gaps), and one is informational.

---

## Findings

### C01 — MEDIUM: `IModuleRelease.compiledIR` typed as `Record<string, unknown>` vs LLD `Record<string, AgentIR>`

**Files:** `packages/database/src/models/module-release.model.ts:54`, LLD Section 1.2 (line 110)

**Description:**
The LLD specifies `compiledIR: Record<string, AgentIR>` on the `IModuleRelease` interface, which provides strong typing for the pre-compiled IR keyed by agent name. The implementation uses `compiledIR: Record<string, unknown>`, losing the type-level guarantee that the stored value conforms to `AgentIR`.

This is likely a deliberate choice to avoid importing `AgentIR` from `@abl/compiler` into the database package (keeping the dependency graph clean), and the Mongoose schema uses `Schema.Types.Mixed` regardless. However, the deviation should be documented.

**Recommended fix:**
Add a doc comment on the `compiledIR` field explaining why it is `Record<string, unknown>` instead of `Record<string, AgentIR>`:

```ts
/** Pre-compiled IR keyed by agent name. Typed as unknown to avoid @abl/compiler dependency in DB package. Cast to Record<string, AgentIR> at consumption sites. */
compiledIR: Record<string, unknown>;
```

---

### C02 — MEDIUM: Feature doc `DeploymentModuleSnapshot` fields diverge from LLD compressed-payload design

**Files:** `docs/features/reusable-agent-modules.md:148-163`, LLD Section 1.5 (lines 247-279), `packages/database/src/models/deployment-module-snapshot.model.ts`

**Description:**
The feature doc (Section 3, Data Model) defines `DeploymentModuleSnapshot` with inline structured fields:

```
dependencies: Array<{ alias, moduleProjectId, moduleReleaseId, version }>
mountedAgents: Record<string, { sourceAgentName, alias, moduleProjectId, moduleReleaseId, ir }>
mountedTools: Record<string, { sourceToolName, alias, moduleProjectId, moduleReleaseId, definition }>
```

The LLD (Section 1.5) and the implementation both use a `compressedPayload: Buffer` design where these fields are gzip-compressed JSON inside a `DeploymentModuleSnapshotPayload` type. The feature doc was written before the LLD finalized the compressed payload approach (Decision HIGH-2) and was not updated.

The implementation and LLD are consistent with each other. The feature doc is stale on this point.

**Recommended fix:**
Update `docs/features/reusable-agent-modules.md` Section 3 to reflect the `compressedPayload: Buffer` design, or add a note that the LLD is authoritative for schema details.

---

### C03 — LOW: `TraceEventType` lacks dedicated module provenance event types

**Files:** `packages/shared-kernel/src/types/trace-event.ts:10-28`, LLD Section 6.3

**Description:**
The LLD (Section 6.3, Section 6.4, and Section 13 implementation order) specifies extending `TraceEventType` with `tool_auth_resolved`. The implementation has added `tool_auth_resolved` to the union (line 28). However, the LLD comment at line 27 reads `// Module provenance events` but only one event type follows (`tool_auth_resolved`).

The `TraceEvent` interface has been correctly extended with `moduleAlias`, `moduleProjectId`, `moduleReleaseId`, and `sourceAgentName` fields (lines 43-50), which is exactly what the LLD specifies.

This is consistent. The comment is slightly misleading since `tool_auth_resolved` is technically an auth-resolution event with module context, not a "module provenance event" per se. No action needed -- included for completeness.

**Status:** No fix required. Informational only.

---

### C04 — LOW: Missing test files for `ProjectModuleDependency` and `DeploymentModuleSnapshot` models

**Files:** Testing doc lists `model-project-module-dependency.test.ts` and `model-deployment-module-snapshot.test.ts` as PLANNED

**Description:**
The testing doc (`docs/testing/reusable-agent-modules.md`) lists:

- `packages/database/src/__tests__/model-project-module-dependency.test.ts` — PLANNED
- `packages/database/src/__tests__/model-deployment-module-snapshot.test.ts` — PLANNED

These files do not exist in the codebase. The existing test files cover `ModuleRelease` and `ModuleEnvironmentPointer` models. The `ProjectModuleDependency` and `DeploymentModuleSnapshot` models have no dedicated model-level test files.

The cascade delete tests (`cascade-delete-modules.test.ts`) indirectly exercise these models via mocked operations, but they do not validate schema constraints (required fields, index uniqueness, default values) the way the existing model tests do.

**Recommended fix:**
Create `model-project-module-dependency.test.ts` and `model-deployment-module-snapshot.test.ts` following the same pattern as the existing `model-module-release.test.ts` and `model-module-environment-pointer.test.ts`. Each should test:

- Required field validation (`validateSync()`)
- Default values (`_id` UUIDv7, timestamps)
- Unique index enforcement (DB-dependent)
- Tenant scoping queries

---

### C05 — LOW: `extractModuleContract` function signature differs from `ExtractContractFn` type in builder

**Files:** `packages/project-io/src/module-release/module-contract.ts:58`, `packages/project-io/src/module-release/build-module-release.ts:44`

**Description:**
The `ExtractContractFn` type in `build-module-release.ts` expects:

```ts
(params: {
  agents: Record<string, Record<string, unknown>>;
  tools: Record<string, { dslContent: string; toolType: ... }>;
  entryAgentName: string;
}) => ModuleReleaseContract
```

The `extractModuleContract` function in `module-contract.ts` has signature:

```ts
(agents: ContractAgentInput[], tools: ContractToolInput[]) => ModuleReleaseContract;
```

These are intentionally different: `extractModuleContract` is a low-level extraction utility that takes array inputs, while `ExtractContractFn` is the callback shape injected into the builder (which passes compiled IR records). The caller is responsible for adapting between the two.

This is a correct dependency-inversion pattern. The builder does not depend on the contract module directly; the wiring layer adapts between them. However, the barrel export (`index.ts`) re-exports both without documenting this adapter requirement.

**Recommended fix:**
Add a doc comment to `ExtractContractFn` noting that callers must adapt from `extractModuleContract`'s array-based API to the builder's record-based API. This prevents future developers from naively passing `extractModuleContract` directly as the `ExtractContractFn` argument.

---

### C06 — LOW: `ModuleDependencySelector` type duplicated in two locations

**Files:** `packages/database/src/models/project-module-dependency.model.ts:17`, `packages/project-io/src/module-release/module-selector.ts:12`

**Description:**
The selector type is defined in two places:

1. `ModuleDependencySelector` in `project-module-dependency.model.ts`: `{ type: 'version' | 'environment'; value: string }`
2. `ModuleSelector` in `module-selector.ts`: `{ type: 'version' | 'environment'; value: string }`

Both are structurally identical but have different names. The database model exports `ModuleDependencySelector` via the barrel, and `module-selector.ts` defines its own `ModuleSelector`.

This is not a bug -- structural compatibility means they are interchangeable at runtime. But having two nominally different types for the same concept creates potential confusion.

**Recommended fix:**
Either (a) have `module-selector.ts` import and re-export `ModuleDependencySelector` from the database package, or (b) document that `ModuleSelector` is intentionally a local alias to avoid a database dependency in `project-io`. Option (b) is likely the right choice to keep `project-io` from depending on `@agent-platform/database` for this single type. Add a comment:

```ts
/** Local alias matching ModuleDependencySelector from database package. Avoids circular dependency. */
export type ModuleSelector = { type: 'version' | 'environment'; value: string };
```

Note: `module-selector.ts` already imports `ModuleRelease` and `ModuleEnvironmentPointer` from `@agent-platform/database/models`, so the dependency already exists. This makes option (a) viable without introducing a new dependency.

---

## Cross-Reference Verification

### Naming Consistency

| Concept                        | LLD                                                                                                                                          | HLD                           | Feature Doc                   | Implementation                | Consistent? |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------- | ----------------------------- | ----------- |
| Module Release collection      | `module_releases`                                                                                                                            | `module_releases`             | `module_releases`             | `module_releases`             | YES         |
| Environment Pointer collection | `module_environment_pointers`                                                                                                                | `module_environment_pointers` | `module_environment_pointers` | `module_environment_pointers` | YES         |
| Dependency collection          | `project_module_dependencies`                                                                                                                | `project_module_dependencies` | `project_module_dependencies` | `project_module_dependencies` | YES         |
| Snapshot collection            | `deployment_module_snapshots`                                                                                                                | `deployment_module_snapshots` | `deployment_module_snapshots` | `deployment_module_snapshots` | YES         |
| Project kind values            | `'application' \| 'module'`                                                                                                                  | same                          | same                          | same                          | YES         |
| Module visibility values       | `'private' \| 'tenant'`                                                                                                                      | same                          | same                          | same                          | YES         |
| Environment values             | `'dev' \| 'staging' \| 'production'`                                                                                                         | same                          | same                          | same                          | YES         |
| Selector types                 | `'version' \| 'environment'`                                                                                                                 | same                          | same                          | same                          | YES         |
| Artifact shape fields          | `dslFormat, entryAgentName, agents, tools`                                                                                                   | same                          | same                          | same                          | YES         |
| Contract shape fields          | `providedAgents, providedTools, requiredConfigKeys, requiredEnvVars, requiredAuthProfiles, requiredConnectors, requiredMcpServers, warnings` | same                          | same                          | same                          | YES         |

### Index Consistency

| Collection                  | LLD Index                                                    | Implementation    | Match? |
| --------------------------- | ------------------------------------------------------------ | ----------------- | ------ |
| module_releases             | `{ tenantId: 1, moduleProjectId: 1, version: 1 }` unique     | Line 89: same     | YES    |
| module_releases             | `{ tenantId: 1, moduleProjectId: 1, createdAt: -1 }` listing | Line 90: same     | YES    |
| module_environment_pointers | `{ tenantId: 1, moduleProjectId: 1, environment: 1 }` unique | Lines 50-53: same | YES    |
| project_module_dependencies | `{ tenantId: 1, projectId: 1, alias: 1 }` unique             | Line 72: same     | YES    |
| project_module_dependencies | `{ tenantId: 1, moduleProjectId: 1 }` reverse lookup         | Line 73: same     | YES    |
| deployment_module_snapshots | `{ tenantId: 1, deploymentId: 1 }` unique                    | Line 47: same     | YES    |
| deployment_module_snapshots | `{ tenantId: 1, projectId: 1 }` listing                      | Line 48: same     | YES    |

### Type Cross-References

| Type                              | Defined In                              | Used In                                                                                                                   | Consistent? |
| --------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `ModuleReleaseContract`           | `module-release.model.ts:29`            | `project-module-dependency.model.ts:13` (import), `module-contract.ts:10` (import), `build-module-release.ts:13` (import) | YES         |
| `ModuleReleaseArtifact`           | `module-release.model.ts:15`            | `build-module-release.ts:13` (import)                                                                                     | YES         |
| `ModuleDependencySelector`        | `project-module-dependency.model.ts:17` | barrel export in `index.ts:164`                                                                                           | YES         |
| `ModuleProvenance`                | `types.ts:16`                           | Used by `ResolvedAgentIR`, `ResolvedToolDefinition`                                                                       | YES         |
| `DeploymentModuleSnapshotPayload` | `types.ts:75`                           | Matches LLD Section 1.5 compressed payload structure                                                                      | YES         |
| `MountedAgentEntry`               | `types.ts:50`                           | Matches LLD/HLD `mountedAgents` value shape                                                                               | YES         |
| `MountedToolEntry`                | `types.ts:62`                           | Matches LLD/HLD `mountedTools` value shape                                                                                | YES         |

### Import Path Consistency (ESM `.js` extensions)

All implementation files use `.js` extensions for local imports:

- `module-release.model.ts`: `../mongo/base-document.js`, `../mongo/plugins/tenant-isolation.plugin.js` -- YES
- `module-environment-pointer.model.ts`: same pattern -- YES
- `project-module-dependency.model.ts`: `./module-release.model.js` -- YES
- `deployment-module-snapshot.model.ts`: same pattern -- YES
- `build-module-release.ts`: `./source-hash.js` -- YES
- `module-contract.ts`: `../export/env-var-scanner.js` -- YES
- `module-selector.ts`: `@agent-platform/database/models` (package import) -- YES
- `module-publish-safety.ts`: `@abl/compiler/platform` (package import) -- YES
- `index.ts` barrel: all `.js` extensions -- YES
- `types.ts`: `@abl/compiler`, `@agent-platform/shared/tools` (package imports) -- YES

### Barrel Export Completeness

**`packages/database/src/models/index.ts`** (lines 149-169):

- `ModuleRelease` + `IModuleRelease` + `ModuleReleaseArtifact` + `ModuleReleaseContract` -- YES
- `ModuleEnvironmentPointer` + `IModuleEnvironmentPointer` -- YES
- `ProjectModuleDependency` + `IProjectModuleDependency` + `ModuleDependencySelector` -- YES
- `DeploymentModuleSnapshot` + `IDeploymentModuleSnapshot` -- YES

**`packages/project-io/src/module-release/index.ts`** (lines 1-35):

- `buildModuleRelease` + input/output types -- YES
- `computeModuleSourceHash` -- YES
- `extractModuleContract` + input types -- YES
- `resolveSelector` + result types -- YES
- `validatePublishSafety` + result types -- YES

### Pattern Adherence

| Pattern                       | Expected                                           | Actual                                                                                                                          | Match? |
| ----------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------ |
| UUIDv7 `_id`                  | `{ type: String, default: uuidv7 }`                | All 4 models use this                                                                                                           | YES    |
| `tenantIsolationPlugin`       | Applied to all models                              | All 4 models apply it                                                                                                           | YES    |
| `timestamps` config           | Varies per model                                   | ModuleRelease: `createdAt` only, Pointer: `updatedAt` only, Dependency: both, Snapshot: `createdAt` only -- all correct per LLD | YES    |
| Mongoose `Schema.Types.Mixed` | For embedded complex objects                       | `artifact`, `compiledIR`, `contract`, `configOverrides`, `contractSnapshot` -- YES                                              | YES    |
| Model registration guard      | `mongoose.models.X \|\| model()`                   | All 4 models use this pattern                                                                                                   | YES    |
| Error handling                | `err instanceof Error ? err.message : String(err)` | `build-module-release.ts:139`                                                                                                   | YES    |
| Logger usage                  | `createLogger('module')`                           | `build-module-release.ts:16`, `module-publish-safety.ts:20`                                                                     | YES    |

### Test-Implementation Alignment

| Test File                                  | Tests Match Implementation? | Notes                                                                                                                                                                 |
| ------------------------------------------ | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model-module-release.test.ts`             | YES                         | Tests all required fields, defaults, unique index, soft delete, tenant scoping, listing sort                                                                          |
| `model-module-environment-pointer.test.ts` | YES                         | Tests all required fields, env enum validation, defaults, unique index, revision concurrency                                                                          |
| `cascade-delete-modules.test.ts`           | YES                         | Tests Path A blocked, Path A clean, Path B consumer, soft delete, tenant cascade. All call signatures match implementation. `CascadeDeleteBlockedError` shape tested. |
| `module-release-builder.test.ts`           | YES                         | Tests all 9 steps, compilation failures, safety validation, sourceHash determinism, variableNamespaceIds stripping                                                    |
| `module-contract.test.ts`                  | YES                         | Tests provided agents/tools, env vars, secrets, auth profiles, connectors, MCP servers, config keys, deduplication, sorting                                           |
| `module-selector.test.ts`                  | YES                         | Tests version/environment selectors, archived release handling, tenant isolation, unknown type                                                                        |
| `module-publish-safety.test.ts`            | YES                         | Tests Tier 1 structural (HTTP auth), Tier 2 pattern (PEM, sk-, Bearer, Base64), non-portable warnings, source identifiers                                             |

---

## Verified Checklist

- [x] **Naming consistency** -- All field names, type names, function names consistent across LLD, HLD, feature doc, and implementation
- [x] **Type cross-references** -- All cross-file type references match their definitions
- [x] **Import consistency** -- All imports use correct paths with `.js` extensions for ESM
- [x] **Collection names** -- All 4 collections match across LLD, HLD, feature doc, and implementation
- [x] **Index specifications** -- All compound indexes match across LLD and implementation (7/7)
- [x] **Error messages** -- Error codes and messages consistent
- [x] **Pattern adherence** -- New files follow existing patterns (UUIDv7, tenantIsolation, timestamps, Mixed, model guard)
- [x] **Barrel export completeness** -- All public types and models exported
- [x] **Test-implementation alignment** -- Test assertions match actual implementation behavior

---

## Action Items

| ID  | Severity | Action                                                                                         | Owner       |
| --- | -------- | ---------------------------------------------------------------------------------------------- | ----------- |
| C01 | MEDIUM   | Add doc comment on `IModuleRelease.compiledIR` explaining the `Record<string, unknown>` choice | Implementer |
| C02 | MEDIUM   | Update feature doc snapshot model to reflect `compressedPayload: Buffer` design                | Docs        |
| C04 | LOW      | Create missing model test files for `ProjectModuleDependency` and `DeploymentModuleSnapshot`   | Implementer |
| C05 | LOW      | Add doc comment on `ExtractContractFn` noting the adapter requirement                          | Implementer |
| C06 | LOW      | Add clarifying comment on `ModuleSelector` type in `module-selector.ts`                        | Implementer |
