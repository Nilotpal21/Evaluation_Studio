# Sprint 1 Pass 3 Architecture Review

**Date:** 2026-03-22
**Reviewer:** LLD Reviewer Agent (Architecture Pass)
**Scope:** Sprint 1 Foundation (Workstreams A + B) -- Data Model, Cascade Delete, Module Release Builder, Shared Types, TraceEvent Extension
**LLD:** `docs/specs/reusable-agent-modules-phase1.lld.md`
**HLD:** `docs/specs/reusable-agent-modules-phase-plan.hld.md`

---

## Files Reviewed

### Data Models (`packages/database/src/models/`)

- `module-release.model.ts`
- `module-environment-pointer.model.ts`
- `project-module-dependency.model.ts`
- `deployment-module-snapshot.model.ts`
- `project.model.ts` (extensions: `kind`, `moduleVisibility`, `moduleDependencyVersion`, `archivedAt`, `archivedBy`)
- `index.ts` (barrel exports)

### Cascade Delete

- `packages/database/src/cascade/cascade-delete.ts`

### Shared Types

- `apps/runtime/src/services/modules/types.ts`
- `packages/shared-kernel/src/types/trace-event.ts`

### Module Release Builder (`packages/project-io/src/module-release/`)

- `build-module-release.ts`
- `source-hash.ts`
- `module-contract.ts`
- `module-selector.ts`
- `module-publish-safety.ts`
- `index.ts`

### Tests (`packages/database/src/__tests__/`)

- `model-module-release.test.ts`
- `model-module-environment-pointer.test.ts`
- `model-project-module-dependency.test.ts`
- `model-deployment-module-snapshot.test.ts`
- `cascade-delete-modules.test.ts`

### Tests (`packages/project-io/src/__tests__/`)

- `module-release-builder.test.ts`
- `module-contract.test.ts`
- `module-selector.test.ts`
- `module-publish-safety.test.ts`

---

## Verdict: APPROVED_WITH_RESERVATIONS

Sprint 1 implementation is architecturally sound and faithfully follows the LLD. The data model is well-structured, cascade delete handles both paths correctly, the release builder pipeline follows the 9-step spec, and test coverage is solid. There are no CRITICAL issues. The reservations are two HIGH findings around defensive coding and one data model gap, plus several MEDIUM items for robustness.

---

## Issues

### HIGH

#### HIGH-1: `deleteProject` does not scope final Project deletion by tenantId

**File:** `packages/database/src/cascade/cascade-delete.ts:347`

The final `Project.deleteMany({ _id: projectId })` on line 347 does not include `tenantId` in the filter. While the earlier lookup on line 222-223 correctly scopes by `tenantId` when provided, the final deletion uses only `_id`. For consistency with the platform invariant "every query includes tenantId," the final delete should also be scoped.

```ts
// Current (line 347):
counts.Project = (await Project.deleteMany({ _id: projectId })).deletedCount;

// Should be:
counts.Project = (
  await Project.deleteMany(
    projectTenantId ? { _id: projectId, tenantId: projectTenantId } : { _id: projectId },
  )
).deletedCount;
```

**Risk:** If `tenantId` is provided but the project has been reassigned (edge case), the delete could target a project in a different tenant. The risk is low because the earlier lookup would fail, but the pattern violates the stated invariant.

**Fix:** Add `tenantId` to the final `Project.deleteMany` filter when available.

---

#### HIGH-2: Standard cascade deletes (Session, Deployment, etc.) in `deleteProject` do not include `tenantId`

**File:** `packages/database/src/cascade/cascade-delete.ts:282-331`

The standard cascade section (lines 282-331) deletes Sessions, Messages, Deployments, etc. using only `projectId` or `sessionId` -- not `tenantId`. This is a pre-existing pattern, not introduced by the module work, but the module cascade logic (lines 229-280) correctly includes `tenantId` in all queries. The inconsistency means new module entity deletes are more secure than existing entity deletes.

**Risk:** Pre-existing; not introduced by Sprint 1. Flagging for awareness since the module cascade sets a better standard.

**Fix:** Non-blocking for Sprint 1. Should be addressed as a platform-wide improvement in a future sprint.

---

#### HIGH-3: `configOverrides` in test fixture uses secret-like value in non-secret context

**File:** `packages/database/src/__tests__/model-project-module-dependency.test.ts:42`

```ts
configOverrides: { API_KEY: 'sk-test-123' },
```

The test fixture stores `sk-test-123` (a secret-prefix value) in `configOverrides`. Per LLD Section 11.2, config overrides must reject values for keys declared as `isSecret: true` in the contract. The test fixture's `contractSnapshot` declares `API_KEY` with `isSecret: true` (line 26), which means this combination would be rejected by the validation described in LLD Section 11.2. While this is a model-level test (no validation logic runs), the fixture creates confusion about what valid data looks like.

**Risk:** Low -- the model layer stores whatever it receives. But downstream implementors reading these tests as examples may think storing secret values in `configOverrides` is acceptable.

**Fix:** Change the test fixture to use a non-secret config key (e.g., `{ REGION: 'us-east-1' }`) with a non-secret contract entry (e.g., `{ key: 'REGION', isSecret: false }`).

---

### MEDIUM

#### MEDIUM-1: `compiledIR` typed as `Record<string, unknown>` in model, `Record<string, Record<string, unknown>>` in builder

**File:** `packages/database/src/models/module-release.model.ts:59` vs `packages/project-io/src/module-release/build-module-release.ts:73`

The `IModuleRelease.compiledIR` is typed as `Record<string, unknown>` but the builder returns `Record<string, Record<string, unknown>>`. The model comment explains this is to avoid a compile-time dependency on `@abl/compiler`, which is architecturally correct. However, the type mismatch means callers must cast at the boundary.

**Risk:** Type confusion when consuming `compiledIR` from the model. The builder's output won't assign cleanly to the model's field without an `as any` or `as Record<string, unknown>` cast.

**Fix:** Either widen the builder's output type to match the model (`Record<string, unknown>`) or add a comment in the builder noting the intentional narrowing.

---

#### MEDIUM-2: No validation of `selector.type` enum at Mongoose schema level beyond embedded sub-document

**File:** `packages/database/src/models/project-module-dependency.model.ts:49-56`

The selector sub-document correctly uses `enum: ['version', 'environment']`, which is good. However, the `configOverrides` field is typed as `Schema.Types.Mixed` with no Mongoose-level validation. The LLD Section 1.4 specifies constraints (max 50 keys, max 1KB per value), but these are enforcement points for the service layer, not the model.

**Risk:** Low -- the model layer is intentionally thin. Service-layer validation is the correct enforcement point. Noting for completeness.

**Fix:** None required. Document that model-layer validation is intentionally minimal; service layer enforces LLD constraints.

---

#### MEDIUM-3: `softDeleteModuleProject` does not verify project is actually `kind: 'module'` before archiving

**File:** `packages/database/src/cascade/cascade-delete.ts:363-383`

The function accepts `moduleProjectId` and `tenantId` but does not verify the project is `kind: 'module'` before setting `archivedAt`. If called on an `application` project by mistake, it would silently archive it.

**Risk:** Caller error could archive a non-module project. The function name implies module-only, but there's no guard.

**Fix:** Add a pre-check: load the project, verify `kind === 'module'`, return an error or no-op if not.

---

#### MEDIUM-4: TraceEvent type `tool_auth_resolved` is the only module provenance event type

**File:** `packages/shared-kernel/src/types/trace-event.ts:28`

The LLD Section 6.3 describes enriching existing trace events (llm_call, tool_call, decision, handoff, etc.) with optional module provenance fields, which the `TraceEvent` interface correctly supports via optional `moduleAlias`, `moduleProjectId`, `moduleReleaseId`, `sourceAgentName` fields. However, the only new event type added is `tool_auth_resolved`. This is correct for Sprint 1 since module provenance piggybacks on existing event types. No issue here -- just confirming the approach is sound.

**Risk:** None. Documenting for clarity.

---

#### MEDIUM-5: `module-contract.ts` does not extract connector type from CONNECTOR directive

**File:** `packages/project-io/src/module-release/module-contract.ts:155`

The `ModuleReleaseContract.requiredConnectors` type includes `{ name: string; connectorType?: string }` but the extractor only captures the name, not the connector type. The regex `CONNECTOR_RE` matches `CONNECTOR: <name>` but DSL connectors may specify a type.

**Risk:** Low -- connector type is optional in the contract. The consumer prerequisite validation may want connector type for better matching, but that's a Phase 2 concern.

**Fix:** Non-blocking. Phase 2 can enhance connector type extraction if needed.

---

#### MEDIUM-6: `buildModuleRelease` catches compile errors per-agent but continues processing remaining agents

**File:** `packages/project-io/src/module-release/build-module-release.ts:141-168`

When compilation fails for one agent, the builder continues compiling remaining agents before returning errors. This is intentionally done (the loop uses `continue` on error, line 148) so the publisher sees all compilation failures at once. This is architecturally sound -- batch error reporting is better UX than fail-fast for publish validation.

**Risk:** None. Documenting as a verified design choice.

---

### LOW

#### LOW-1: `module-publish-safety.ts` uses `AUTH_CONFIG_RE` with global flag stored at module scope

**File:** `packages/project-io/src/module-release/module-publish-safety.ts:71`

The regex `AUTH_CONFIG_RE` is defined at module scope with the `g` flag. It's correctly re-instantiated in `validateHttpToolAuth` (line 162: `const re = new RegExp(AUTH_CONFIG_RE.source, AUTH_CONFIG_RE.flags)`), avoiding the stateful lastIndex bug. Same pattern is used for all other module-scope regexes. This is correct.

**Risk:** None. Documenting as verified.

---

#### LOW-2: `ModuleEnvironmentPointer` revision defaults to 1, not 0

**File:** `packages/database/src/models/module-environment-pointer.model.ts:38`

The `revision` field defaults to 1. This is consistent with the LLD Section 10.3 which uses `revision: expectedRevision` in the optimistic concurrency check. Starting at 1 means the first promotion creates a pointer with revision 1, and the first concurrent update must match revision 1 to succeed. This is correct.

**Risk:** None. Documenting as verified.

---

#### LOW-3: `extractModuleContract` auth profile detection has limited pattern matching

**File:** `packages/project-io/src/module-release/module-contract.ts` via `packages/project-io/src/export/env-var-scanner.ts:29-35`

The `extractAuthProfileReferences` function matches `AUTH: <profileName>` lines. This is a regex on raw DSL content, not a parsed AST. If auth profile references appear in non-AUTH contexts (e.g., comments, string literals), they would be falsely detected. However, false positives in prerequisite lists are harmless -- they just ask the consumer to provision something they may already have.

**Risk:** Very low. False positives in contract prerequisites are conservative and safe.

---

## Verified

- [x] **Architecture compliance** -- All models use `tenantIsolationPlugin`, `tenantId` is required and non-nullable on all four new models, queries scope by `tenantId`, cross-tenant access returns no results (not 403)
- [x] **Resource isolation** -- `ProjectModuleDependency` correctly includes both `tenantId` and `projectId` in its unique index; `DeploymentModuleSnapshot` scoped by `(tenantId, deploymentId)`; cascade delete uses `tenantId` in all module entity queries
- [x] **Immutability** -- `ModuleRelease` uses `timestamps: { createdAt: true, updatedAt: false }` ensuring releases are write-once; no updatedAt field exists
- [x] **Pattern consistency** -- All models follow existing patterns: `uuidv7` for `_id`, `tenantIsolationPlugin`, `Schema.Types.Mixed` for complex sub-documents, named collections
- [x] **Index design** -- Unique indexes match LLD: `(tenantId, moduleProjectId, version)` on releases, `(tenantId, moduleProjectId, environment)` on pointers, `(tenantId, projectId, alias)` on dependencies, `(tenantId, deploymentId)` on snapshots. Listing indexes present for reverse lookups
- [x] **Cascade delete correctness** -- Two-path cascade (Path A: module project blocks on consumers, then deletes pointers/releases; Path B: consumer project deletes dependencies/snapshots). Tenant cascade includes all 4 new models in correct dependency order. `CascadeDeleteBlockedError` exposes only count to HTTP layer (IDs are internal-only per the JSDoc warning)
- [x] **Soft-delete fields in schema** -- `archivedAt` and `archivedBy` are defined in both `Project` and `ModuleRelease` Mongoose schemas, preventing Mongoose `strict: true` silent drops (past review finding from memory)
- [x] **DI/testability** -- `buildModuleRelease` injects `CompileFn`, `ExtractContractFn`, and `ValidatePublishSafetyFn` rather than importing them directly, enabling clean unit testing without mocking modules
- [x] **Source hash determinism** -- `computeModuleSourceHash` deep-sorts object keys before serialization, includes `entryAgentName` (per Decision 2c), and produces a truncated SHA-256 hex digest
- [x] **variableNamespaceIds stripping** -- `stripVariableNamespaceIds` recursively walks all objects and arrays, removing the key at every nesting level. Test confirms nested stripping works
- [x] **Publish safety two-tier validation** -- Structural checks (HTTP tool auth must use auth*profile_ref or templates) and pattern-based checks (PEM keys, Bearer/Basic/sk-/pk* prefixes, URL-embedded keys, Base64 heuristic). SearchAI/Workflow binding warnings for non-portable tools. variableNamespaceIds blocking check
- [x] **Module selector tenant scoping** -- `resolveSelector` includes `tenantId` in all `findOne` queries for both version and environment paths. Archived releases filtered via `archivedAt: null`
- [x] **Contract extraction reuse** -- `extractModuleContract` reuses existing `extractEnvVarReferences`, `extractSecretReferences`, `extractAuthProfileReferences` from `env-var-scanner.ts` rather than reimplementing
- [x] **Runtime types** -- `ResolvedAgentIR` and `ResolvedToolDefinition` use intersection types with optional `_moduleProvenance`, preserving backward compatibility. `DeploymentModuleSnapshotPayload` type matches the compressed payload shape from LLD Section 1.5
- [x] **TraceEvent backward compatibility** -- New optional fields (`moduleAlias`, `moduleProjectId`, `moduleReleaseId`, `sourceAgentName`) do not break existing trace consumers. New `tool_auth_resolved` type added to the union
- [x] **Barrel export completeness** -- `packages/database/src/models/index.ts` exports all 4 new models with their document interfaces and sub-types. `packages/project-io/src/module-release/index.ts` exports all builder functions and types
- [x] **No `any` in public interfaces** -- All model interfaces use typed fields. `compiledIR: Record<string, unknown>` in the model is intentionally weakened (comment explains avoiding `@abl/compiler` dependency)
- [x] **Error handling** -- `buildModuleRelease` uses `err instanceof Error ? err.message : String(err)` per code standards. `CascadeDeleteBlockedError` extends `Error` properly with `name` and `code` fields
- [x] **Completeness** -- All HLD Workstream A (data model) and Workstream B (release builder) entities are implemented. All LLD Section 1-3 types are present
- [x] **Domain rules** -- No transitive module dependencies (Phase 1 boundary respected). Releases are immutable (no updatedAt). Secrets never stored in artifacts (publish safety validates). Deployment snapshots use compressed storage (Buffer type)

## Test Coverage Assessment

| Test File                                  | Assertions                                                                                                                                                                                                             | Quality                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `model-module-release.test.ts`             | 12 tests: 7 validation, 2 defaults, 5 DB (uniqueness, tenant scoping, soft-delete)                                                                                                                                     | Good. Covers uniqueness enforcement, soft-delete persistence, and tenant scoping |
| `model-module-environment-pointer.test.ts` | 10 tests: 5 validation, 3 defaults, 4 DB (uniqueness, environment variants, optimistic concurrency)                                                                                                                    | Good. Optimistic concurrency test validates revision-based update rejection      |
| `model-project-module-dependency.test.ts`  | 12 tests: 8 validation, 5 defaults (selector, configOverrides), 4 DB (uniqueness, cross-project alias, reverse lookup)                                                                                                 | Good. Reverse lookup test validates the `(tenantId, moduleProjectId)` index      |
| `model-deployment-module-snapshot.test.ts` | 10 tests: 6 validation, 2 defaults, 5 DB (uniqueness, Buffer round-trip, consumer listing)                                                                                                                             | Good. Buffer round-trip test validates compressed payload storage                |
| `cascade-delete-modules.test.ts`           | 5 describe blocks: Path A blocked, Path A clean, Path B, soft-delete, tenant cascade, error shape                                                                                                                      | Good. Uses mock models appropriately for cascade logic testing                   |
| `module-release-builder.test.ts`           | 20 tests: success, validation (empty agents, null entry, missing entry), compile failures, safety blocking/warnings, variableNamespaceIds stripping, sourceHash determinism/variation, tool artifacts, DI verification | Excellent. Comprehensive coverage of the 9-step pipeline                         |
| `module-contract.test.ts`                  | 25 tests: provided agents/tools, env vars, secrets, auth profiles, connectors, MCP servers, config keys, deduplication, empty case, mixed content, sorting                                                             | Excellent. Tests all extraction categories and deduplication                     |
| `module-selector.test.ts`                  | 8 tests: version match/miss, environment match/miss/archived, tenant isolation, unknown type                                                                                                                           | Good. Covers both selector paths and tenant scoping                              |
| `module-publish-safety.test.ts`            | 16 tests: Tier 1 structural (HTTP auth), Tier 2 pattern (PEM, sk-, Bearer, Base64), non-portable warnings (SearchAI, Workflow), source identifiers (variableNamespaceIds, \_id, projectId), clean cases                | Excellent. Both tiers thoroughly tested                                          |

### Missing Tests

- **P1-U02 gap:** `model-project-module-dependency.test.ts` does not test selector sub-document enum validation (passing `type: 'invalid'` to selector). The Mongoose sub-schema has an `enum` constraint, but it's not exercised in tests.
- **P1-U03 gap:** `model-deployment-module-snapshot.test.ts` does not test that the `(tenantId, projectId)` index supports efficient listing queries (no explain/index-use assertion). The index exists but its query-plan benefit is assumed.
- **No cross-model integration test:** There is no test that creates a `ModuleRelease`, creates a `ProjectModuleDependency` referencing it, then verifies the cascade delete blocks correctly. The cascade test uses mocks throughout. This is acceptable for Sprint 1 unit scope but should be an integration test in Sprint 4.

---

## Notes

1. **Implementation is well-aligned with LLD.** Every section of the LLD (Sections 1-3, plus security Section 11.1-11.2) has a corresponding implementation. The type shapes match exactly. The DI pattern in the builder is clean and testable.

2. **Pre-existing cascade delete inconsistency.** The standard project cascade (Sessions, Deployments, etc.) does not include `tenantId` in delete queries, while the new module cascade correctly does. This is a pre-existing gap -- not introduced by Sprint 1 -- but worth noting since the module code establishes the better pattern.

3. **Watch for Sprint 2.** The alias rewriter (LLD Section 4) and deployment build service (LLD Section 5) depend on the data model and types established here. The `DeploymentModuleSnapshotPayload` type in `types.ts` will be the primary contract between the snapshot creator (Sprint 2) and the deployment resolver (Sprint 3). Any changes to this type during Sprint 2 must be backward-compatible with already-persisted snapshots.

4. **configOverrides validation is deferred to service layer.** The model stores `configOverrides` as `Schema.Types.Mixed` with no size or injection validation. This is correct -- the LLD specifies service-layer validation (Section 11.2). Sprint 2 route handlers must implement the 50-key limit, 1KB/value limit, `{{` rejection, and control character rejection described in the LLD.

5. **Cascade delete consumer project ID exposure.** `CascadeDeleteBlockedError.consumerProjectIds` is internal-only with a clear JSDoc warning. Route handlers should expose only the count. Test verifies the error shape. This is a good defense-in-depth pattern.

6. **Module release `compiledIR` avoids cross-package dependency.** Typing `compiledIR` as `Record<string, unknown>` in the database package avoids importing `@abl/compiler` into `@agent-platform/database`. This is the correct architectural boundary. The runtime package imports both and casts at the boundary.
