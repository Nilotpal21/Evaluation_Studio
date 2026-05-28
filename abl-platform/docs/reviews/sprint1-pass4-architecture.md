# Sprint 1 — Pass 4: Architecture Review

**Reviewer:** LLD Reviewer Agent (Architecture)
**Date:** 2026-03-22
**Scope:** Data model, cascade delete, module release builder, contract extractor, module selector, publish safety validator, runtime types, trace events, barrel exports, tests
**Spec:** `docs/specs/reusable-agent-modules-phase1.lld.md`, `docs/specs/reusable-agent-modules-phase-plan.hld.md`

---

## VERDICT: APPROVED_WITH_RESERVATIONS

---

## ISSUES

### CRITICAL

None.

### HIGH

**HIGH-1: `softDeleteModuleProject` has no guard for `kind === 'module'`**

The function accepts any `moduleProjectId` and archives it without verifying the project is actually a module. Callers could accidentally archive an application project.

- File: `packages/database/src/cascade/cascade-delete.ts:366-386`
- Fix: Add a guard at the top of `softDeleteModuleProject`:
  ```ts
  const project = await Project.findOne({ _id: moduleProjectId, tenantId }, { kind: 1 }).lean();
  if (!project || project.kind !== 'module') {
    throw new Error('softDeleteModuleProject can only archive module projects');
  }
  ```
- Note: This was flagged in Pass 3. Remains unfixed. Defense-in-depth requires the function to verify the entity type before mutating.

**HIGH-2: Test fixture `model-project-module-dependency.test.ts` stores `sk-test-123` in `configOverrides` against a contract declaring `isSecret: true`**

The `validDependency()` helper sets `configOverrides: { API_KEY: 'sk-test-123' }` while the `validContract()` declares `requiredConfigKeys: [{ key: 'API_KEY', isSecret: true }]`. Per LLD Section 1.4, "Values matching declared secret prerequisites (where `isSecret: true`) must be rejected." This fixture models an invalid end-to-end scenario. Downstream implementors reading tests as examples may assume this combination is valid.

- File: `packages/database/src/__tests__/model-project-module-dependency.test.ts:34-44`
- Fix: Change the contract to `isSecret: false` or change the configOverrides key to a non-secret key. The model layer doesn't enforce this, but the fixture should represent a valid scenario.
- Note: This was flagged in Pass 3. Remains unfixed. Model-layer tests represent the lowest validation layer, but fixture data should still be realistic.

**HIGH-3: Pre-existing cascade tenantId inconsistency — new module code is more secure than existing code**

The new module cascade paths (Path A/Path B) correctly include `tenantId` in all `deleteMany` calls. However, the pre-existing standard cascade still uses:

- `Session.deleteMany({ projectId })` without tenantId (line 301)
- `Deployment.deleteMany({ projectId })` without tenantId (line 315)
- `Workflow.deleteMany({ projectId })` without tenantId (line 318)
- Final `Project.deleteMany` only includes tenantId conditionally (lines 347-350)

This is a pre-existing gap — the new module code establishes the correct pattern. Not blocking for this sprint but should be tracked.

- File: `packages/database/src/cascade/cascade-delete.ts:282-354`
- Fix: Incrementally add `tenantId` to existing deleteMany calls in a follow-up PR.

### MEDIUM

**MEDIUM-1: `compiledIR` three-way type divergence**

- LLD says `Record<string, AgentIR>`
- Database model says `Record<string, unknown>` (intentional cross-package boundary)
- Builder returns `Record<string, Record<string, unknown>>`

The database model deviation is intentional and well-commented (avoids `@abl/compiler` dependency in `@agent-platform/database`). The builder's `Record<string, Record<string, unknown>>` is structurally compatible. However, Sprint 2 consumers reading `compiledIR` from MongoDB will need a documented type assertion pattern rather than bare `as AgentIR` casts.

- Files: LLD Section 1.2, `packages/database/src/models/module-release.model.ts:58-59`, `packages/project-io/src/module-release/build-module-release.ts:73`
- Fix: Add a comment or utility function in Sprint 2 that provides runtime validation when narrowing `unknown` to `AgentIR`. No change needed in Sprint 1.

**MEDIUM-2: `DeploymentModuleSnapshotPayload` defined in runtime types but not co-located with the database model**

The `DeploymentModuleSnapshotPayload` type in `apps/runtime/src/services/modules/types.ts` describes the JSON stored inside `compressedPayload` of `DeploymentModuleSnapshot`. This creates an implicit coupling: the database model defines the envelope, but the payload schema lives in a different package. If the runtime types drift, the compressed payload becomes unreadable.

- File: `apps/runtime/src/services/modules/types.ts:75-80` vs `packages/database/src/models/deployment-module-snapshot.model.ts:15-24`
- Fix: Consider adding a type-level comment in the database model pointing to the payload type definition, or re-exporting the payload type from a shared location.

**MEDIUM-3: `ModuleSelector` type exported from two locations with different names**

`packages/project-io/src/module-release/module-selector.ts` exports `ModuleSelector` as `{ type: 'version' | 'environment'; value: string }`. `packages/database/src/models/project-module-dependency.model.ts` exports `ModuleDependencySelector` with the identical shape. These are semantically the same type.

- Fix: Sprint 2 should either re-export one from the other or consolidate into `@agent-platform/shared-kernel`. No Sprint 1 change needed — both are structurally compatible and there is no import between them.

**MEDIUM-4: No test for `model-module-environment-pointer` DB-dependent deletion order**

The `ModuleEnvironmentPointer` test file has good validation, uniqueness, and optimistic concurrency tests. However, there is no test verifying that deleting a `ModuleRelease` does not automatically cascade-delete its `ModuleEnvironmentPointer` (since there is no DB-level foreign key). This is important because the application-level cascade in `cascade-delete.ts` handles this ordering explicitly.

- File: `packages/database/src/__tests__/model-module-environment-pointer.test.ts`
- Fix: Add a test confirming that `ModuleRelease.deleteMany` does NOT affect `ModuleEnvironmentPointer` records. This validates the assumption that cascade ordering is application-level only.

**MEDIUM-5: Cascade delete event hook error handling is bare `catch {}`**

Both `deleteTenant` and `deleteProject` catch event hook failures with empty catch blocks. While the comment says "non-fatal", there is no logging. Platform conventions require `createLogger` for all error paths.

- File: `packages/database/src/cascade/cascade-delete.ts:161-163`, `344-346`
- Fix: Pre-existing pattern. Low priority but should be addressed when the cascade module is next touched.

### LOW

**LOW-1: `env-var-scanner.ts` uses global regex flags — safe because each call creates fresh RegExp instances**

The contract extractor at `module-contract.ts:182-219` creates fresh `RegExp` instances from the source/flags of module-level regex constants. This is correct — global regex instances share `.lastIndex` state, so the fresh instantiation avoids cross-invocation state leaks. No fix needed, but worth noting the pattern is intentional.

- File: `packages/project-io/src/module-release/module-contract.ts:179-220`
- Status: Working correctly. Code is defensive.

**LOW-2: `TraceEventType` union does not include a dedicated `module_resolved` event type**

The LLD Section 6.3 specifies enriching existing trace event types with module provenance fields rather than adding a new `module_resolved` type. The implementation correctly adds `tool_auth_resolved` for auth scope tracing. This is sufficient for Phase 1.

- File: `packages/shared-kernel/src/types/trace-event.ts`
- Status: Correct per LLD. No change needed.

---

## VERIFIED

- [x] **Data model correctness vs LLD** — All 4 new models (`ModuleRelease`, `ModuleEnvironmentPointer`, `ProjectModuleDependency`, `DeploymentModuleSnapshot`) match LLD Section 1 field-by-field. Interface fields, schema types, index definitions, and default values all align.
- [x] **Project model extension** — `kind`, `moduleVisibility`, `moduleDependencyVersion`, `archivedAt`, `archivedBy` all present in both interface and schema with correct defaults and enum constraints.
- [x] **Index definitions** — All compound indexes match LLD specifications:
  - `(tenantId, moduleProjectId, version)` unique on ModuleRelease
  - `(tenantId, moduleProjectId, environment)` unique on ModuleEnvironmentPointer
  - `(tenantId, projectId, alias)` unique on ProjectModuleDependency
  - `(tenantId, deploymentId)` unique on DeploymentModuleSnapshot
  - `(tenantId, moduleProjectId)` on ProjectModuleDependency for reverse lookup
  - `(tenantId, projectId)` on DeploymentModuleSnapshot for consumer listing
- [x] **Barrel exports** — All 4 models with their interfaces and sub-types registered in `packages/database/src/models/index.ts` under the "Modules" section (lines 149-169).
- [x] **Cascade delete — Path A** — Module project deletion correctly blocks on active consumers (throws `CascadeDeleteBlockedError`), deletes pointers then releases when no consumers, and does NOT delete consumer deployment snapshots.
- [x] **Cascade delete — Path B** — Consumer project deletion correctly deletes `ProjectModuleDependency` and `DeploymentModuleSnapshot` scoped to `(tenantId, projectId)`.
- [x] **Cascade delete — Tenant** — `deleteTenant` cascades all 4 module collections in correct dependency order (snapshots -> deps -> pointers -> releases).
- [x] **Cascade delete — Soft delete** — `softDeleteModuleProject` correctly archives project and releases using `findOneAndUpdate` / `updateMany` with tenantId scope.
- [x] **`CascadeDeleteBlockedError`** — Limits consumer project ID retrieval to 100 (line 238-243). WARNING comment correctly prevents serializing IDs to HTTP responses.
- [x] **Tenant isolation plugin** — All 4 models register `tenantIsolationPlugin`.
- [x] **Module release builder** — 9-step pipeline matches LLD Section 3.1. DI pattern (compileFn, extractContractFn, validatePublishSafetyFn) is clean and testable.
- [x] **variableNamespaceIds stripping** — Recursive `stripVariableNamespaceIds` correctly handles nested objects and arrays. Test confirms stripping at all depths.
- [x] **Source hash computation** — Uses canonical JSON serialization with deep-sorted keys. Includes `entryAgentName` per LLD Decision 2c. 16-char truncated SHA-256.
- [x] **Contract extraction** — Scans agents and tools for env vars, secrets, auth profiles, connectors, MCP servers, and config keys. Deduplicates and sorts. Reuses existing `env-var-scanner.ts` utilities.
- [x] **Module selector** — Both version and environment selector paths correctly scope queries by `tenantId` and filter `archivedAt: null`.
- [x] **Publish safety validator** — Two-tier validation (structural + pattern-based). Correctly blocks PEM keys, sk- prefixes, Bearer tokens, URL-embedded keys, variableNamespaceIds, literal auth values. Warns on Base64 suspects, SearchAI indexIds, workflowIds, raw MongoDB IDs, projectIds, tenantIds.
- [x] **Runtime types** — `ModuleProvenance`, `ResolvedAgentIR`, `ResolvedToolDefinition`, `DeploymentModuleDependency`, `MountedAgentEntry`, `MountedToolEntry`, `DeploymentModuleSnapshotPayload` all defined and match LLD Section 6.
- [x] **TraceEvent extension** — `moduleAlias`, `moduleProjectId`, `moduleReleaseId`, `sourceAgentName` fields added as optional properties. `tool_auth_resolved` added to `TraceEventType`. Backward compatible for local agents (no module fields).
- [x] **DI pattern** — Builder uses injected functions rather than direct imports, enabling unit testing without mocking module systems. Contract extractor and safety validator follow the same pattern.
- [x] **Error handling** — `err instanceof Error ? err.message : String(err)` pattern used in builder (line 146). Errors are structured with context (agent name, issue code, source).
- [x] **Package boundary types** — `compiledIR: Record<string, unknown>` in database package intentionally avoids `@abl/compiler` dependency. Well-commented (lines 54-59).
- [x] **Test coverage** — All models have validation, default value, and DB-dependent tests. Builder, contract, selector, safety validator all have comprehensive unit tests. Cascade delete has mock-based tests for all paths.

---

## ARCHITECTURE ASSESSMENT

### Strengths

1. **Clean package boundaries**: Database models use `unknown` types at the compiler boundary, runtime types use concrete `AgentIR` imports. The dependency direction is correct: runtime depends on both database and compiler, database depends on neither.

2. **DI-based testability**: The builder pipeline injects compile, contract extraction, and safety validation as functions. This avoids deep mocking of the compiler and keeps tests fast and deterministic.

3. **Cascade delete design**: Two-path cascade (module vs consumer) is well-structured. The blocking guard (`CascadeDeleteBlockedError`) prevents orphaning consumers. The soft-delete path preserves resolvability for existing deployments.

4. **Tenant isolation**: All models use `tenantIsolationPlugin`. All queries in the selector, cascade, and contract extractor include `tenantId`. New module cascade code is more secure than the pre-existing standard cascade.

5. **Immutability enforcement**: `ModuleRelease` uses `timestamps: { createdAt: true, updatedAt: false }` — releases are created once and never modified (only archived). The unique `(tenantId, moduleProjectId, version)` index prevents duplicate publishes at the DB level.

6. **Compressed payload**: `DeploymentModuleSnapshot` stores gzip-compressed JSON rather than raw BSON, per LLD Section 1.5. Size enforcement is specified in LLD (8 MB pre-compression limit) and will be enforced at the service layer in Sprint 2.

### Architecture Risks for Sprint 2

1. **compiledIR type narrowing**: Sprint 2 code reading `compiledIR` from MongoDB must use a validated assertion pattern, not bare `as AgentIR`. Consider a utility like `assertAgentIR(value: unknown): AgentIR` with runtime validation.

2. **Dual selector types**: `ModuleSelector` (project-io) and `ModuleDependencySelector` (database) should be consolidated before the Studio API layer references both.

3. **Feature doc drift**: Based on previous review patterns, the feature doc at `docs/features/*.md` is likely already behind the LLD and implementation. Cross-check before Sprint 2 planning.

---

## NOTES

- The `softDeleteModuleProject` kind guard (HIGH-1) should be fixed before Sprint 2 introduces service-layer callers that might pass incorrect project IDs.
- The test fixture secret value issue (HIGH-2) should be fixed to prevent confusion for developers using tests as implementation examples.
- Sprint 1 implementation is architecturally sound and ready for Sprint 2 service/route layer work. The module data model is well-designed, properly indexed, and correctly integrated with the existing cascade delete and tenant isolation infrastructure.
