# Architecture Review: Reusable Agent Modules HLD

**Document:** `docs/specs/reusable-agent-modules-phase-plan.hld.md`
**Reviewer:** LLD Reviewer Agent (architecture review mode)
**Date:** 2026-03-21
**Review Scope:** Phase Plan + Phase 1 High-Level Design

---

## VERDICT: APPROVED WITH NOTES

This is a well-structured, thorough HLD. The design correctly reuses existing platform patterns, explicitly avoids known anti-patterns (copy semantics, mutable dependencies, secret leakage), and demonstrates deep awareness of the codebase constraints. The Phase 1 boundary is well-chosen. The issues below are things to address during LLD/implementation planning, not blockers on the HLD itself.

---

## ISSUES

### [CRITICAL-1] `deleteProject` cascade does not mention new module entities

The HLD correctly identifies (line 65) that `packages/database/src/cascade/cascade-delete.ts` needs updating. However, the current `deleteProject()` function (lines 137-235 of that file) deletes 20+ entity types but has no awareness of module entities. The cascade must handle FOUR new collections:

- `ModuleRelease` (when deleting a module project)
- `ModuleEnvironmentPointer` (when deleting a module project)
- `ProjectModuleDependency` (when deleting a consumer project)
- `DeploymentModuleSnapshot` (when deleting either type of project)

Additionally, `deleteTenant()` (lines 26-131) also needs updating -- it cascades through projects but must also clean up tenant-level module entities.

**Risk:** The HLD mentions cascade in Workstream A notes but does not specify the two-path cascade logic: deleting a module project requires different cascade steps than deleting a consumer project. The LLD must specify both paths explicitly.

**File:** `/Users/prasannaarikala/projects/agent-platform/packages/database/src/cascade/cascade-delete.ts`

### [CRITICAL-2] Permission constants not yet defined -- naming collision risk

The HLD proposes four new permissions: `module:read`, `module:manage`, `module:publish`, `module:import`. The current `StudioPermission` object in `apps/studio/src/lib/permissions.ts` uses the `resource:operation` format. The proposed names are consistent, but:

1. `module:import` may collide semantically with `project:import` (existing). The LLD must clarify that `project:import` covers project-io file imports while `module:import` covers module dependency imports, and that permission resolution does not conflate them.
2. These permissions must also be added to the RBAC role definitions (likely in the admin service or shared RBAC config). The HLD does not specify which roles get these permissions by default.

**File:** `/Users/prasannaarikala/projects/agent-platform/apps/studio/src/lib/permissions.ts`
**Fix:** LLD must specify role-to-permission mapping for module permissions (e.g., OWNER gets all four, EDITOR gets read/import, VIEWER gets read only).

### [HIGH-1] `Project.kind` field migration strategy unspecified

The HLD says "default every existing project to `kind='application'`" (line 377). The `IProject` interface in `packages/database/src/models/project.model.ts` currently has no `kind` field. Adding a required field to an existing collection with hundreds of thousands of documents requires either:

- A MongoDB migration script to backfill `kind='application'` on all existing documents, OR
- Schema-level `default: 'application'` with queries that handle `null`/`undefined` as `'application'`

The HLD does not specify which approach. The second approach is simpler and safer but means queries must use `{ kind: { $in: ['application', null, undefined] } }` or equivalent until migration completes.

**File:** `/Users/prasannaarikala/projects/agent-platform/packages/database/src/models/project.model.ts`
**Fix:** LLD must specify the migration strategy. Recommend schema-level default + graceful null handling (treat null as 'application') for zero-downtime rollout.

### [HIGH-2] `moduleVisibility` scoping is underspecified for multi-project tenants

The HLD specifies `moduleVisibility: 'private' | 'tenant'` on the `Project` model. When `private`, only the owning user can see it; when `tenant`, all projects in the tenant can import it. However:

1. "Private" visibility is not clearly defined. Does it mean only the `ownerId` can see it? Or all members of the module project? This distinction matters for team-owned module projects.
2. There is no `project`-level visibility scope (e.g., a module visible only to specific consumer projects). This is fine for Phase 1 but should be noted as a Phase 2/3 concern.
3. The catalog query must filter by `moduleVisibility` AND tenant membership. The HLD states this but the consumer-project-scoped catalog route must also verify that the requesting user has `module:read` permission on the consumer project, not just tenant membership.

**Fix:** LLD must specify: when `moduleVisibility='private'`, who exactly can see the module in the catalog? Recommend: project members of the module project (not just ownerId).

### [HIGH-3] `DeploymentModuleSnapshot` document size risk

The HLD correctly identifies (line 542) that the snapshot should be stored in its own collection. However, the `mountedAgents` field stores full `AgentIR` objects and `mountedTools` stores `ToolDefinitionLocal` objects. A module with 50 agents and 100 tools could produce a snapshot of several megabytes. MongoDB's document size limit is 16MB.

The HLD mentions "compressed or size-bounded" (line 542) but does not specify how. The LLD must specify:

- Maximum snapshot size validation at creation time
- Whether to use compression (gzip before BSON storage) or chunking (GridFS)
- The proposed cap of 250 mounted agents+tools combined (line 633) is good but the actual byte-size limit must also be enforced

**Fix:** LLD must specify size enforcement strategy. Recommend: validate total byte size before persistence, reject with 422 if over limit (e.g., 8MB uncompressed), and add gzip compression as a Phase 1 optimization.

### [HIGH-4] Alias rewriting scope is broader than listed

The HLD identifies (line 539) that alias rewriting must cover "routing targets, delegate targets, fan-out targets, `available_agents`, and any coordination metadata keyed by agent name." This is correct but incomplete. The rewriter must also handle:

1. **Guard conditions** in routing that reference agent names by string
2. **Completion detection** references (e.g., `required_completions` lists)
3. **Tool references** in agent DSL `TOOLS:` sections when tools are imported from modules
4. **Handoff conditions** in `COORDINATION:` sections that name specific agents
5. **`DELEGATE TO:` targets** in reasoning execution paths

The HLD's `module-alias-rewriter.ts` test (P1-U07) should verify ALL of these surfaces, not just handoffs and tool references.

**Fix:** LLD must provide an exhaustive list of IR fields that reference agent/tool names and must be rewritten. Recommend: the alias rewriter should walk the entire AgentIR tree and rewrite any string field that matches a known module-exported symbol name.

### [HIGH-5] Feature flag name `reusable_modules` not specified in PLAN_FEATURES

The HLD says to use the existing feature-gate pattern in `apps/runtime/src/middleware/feature-gate.ts`. The current `PLAN_FEATURES` object (lines 23-44 of that file) maps plan tiers to feature strings. The HLD does not specify:

1. What the feature flag name will be (e.g., `reusable_modules`)
2. Which plan tiers will include it (presumably BUSINESS and ENTERPRISE)
3. How Studio reads the feature flag (Studio is Next.js, not Express -- it cannot use the Express middleware directly)

**File:** `/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/middleware/feature-gate.ts`
**Fix:** LLD must specify the feature flag name, plan-tier mapping, and Studio-side feature resolution mechanism.

### [HIGH-6] No specification for `configOverrides` validation or shape

The `ProjectModuleDependency` entity includes `configOverrides` but the HLD does not specify:

1. What the shape of `configOverrides` is (Record<string, string>? Record<string, unknown>?)
2. How overrides are validated against the module contract's `required config keys`
3. Whether overrides can reference `{{env.VAR}}` templates or must be literal values
4. Maximum size of the configOverrides document

Since configOverrides are "non-secret only" (line 147), the LLD must enforce this -- but how? A string value like a password is indistinguishable from a non-secret string without semantic analysis.

**Fix:** LLD must specify configOverrides schema, validation rules, and max size. Recommend: `Record<string, string>` with max 50 keys, max 1KB per value, validated against the module contract's declared config keys.

### [MEDIUM-1] `tenantId` on `Project` is nullable -- module queries must handle this

The current `IProject` interface has `tenantId: string | null`. Modules are tenant-scoped by design. The LLD must ensure that:

1. A project cannot be converted to `kind='module'` if its `tenantId` is null
2. All module catalog queries include `tenantId: { $ne: null }` or equivalent
3. The `ModuleRelease`, `ModuleEnvironmentPointer`, and `ProjectModuleDependency` models should have `tenantId` as required (non-nullable)

**File:** `/Users/prasannaarikala/projects/agent-platform/packages/database/src/models/project.model.ts` (line 18: `tenantId: string | null`)

### [MEDIUM-2] Concurrent publish safety mechanism unspecified

The HLD requires "publishing the same module version twice in parallel must produce a single winning release and one deterministic 409 loser" (line 162). The mechanism is not specified. Options:

1. Unique compound index on `(tenantId, moduleProjectId, version)` -- simplest, MongoDB enforces atomicity
2. Redis distributed lock with `SET NX PX` -- consistent with platform patterns
3. MongoDB `findOneAndUpdate` with `upsert: true` + version check

The unique index approach is the simplest and most correct for this use case. The LLD should specify this explicitly.

**Fix:** LLD should specify unique index on `(tenantId, moduleProjectId, version)` as the primary concurrency control, with proper `MongoServerError` code 11000 handling to return 409.

### [MEDIUM-3] `sourceHash` computation method unspecified

Both `ModuleRelease` and `DeploymentModuleSnapshot` use a `sourceHash` or `snapshotHash`. The HLD does not specify:

1. What the hash covers (DSL content only? DSL + tool definitions? DSL + contract?)
2. Whether the hash is deterministic across serialization formats (JSON key ordering)
3. The hash algorithm (SHA-256 is the platform standard per `deployment-resolver.ts` which uses `createHash`)

**Fix:** LLD should specify: SHA-256 of canonical JSON (sorted keys) of the artifact content, consistent with the existing `createHash('sha256')` pattern in `deployment-resolver.ts`.

### [MEDIUM-4] Audit actions not yet in `AuditActions` constant

The HLD proposes four audit actions: `module_published`, `module_promoted`, `module_imported`, `module_removed`. The current `AuditActions` constant in `apps/studio/src/services/audit-service.ts` does not have these. The LLD must add them. Additionally, the HLD mentions "module enable" and "delete-blocked" as audit-worthy actions (line 482) but does not include them in the explicit audit action list (lines 483-487). The LLD should include:

- `MODULE_ENABLED` (when `kind` changes to `module`)
- `MODULE_DISABLED` (when `kind` changes back to `application`)
- `MODULE_DELETE_BLOCKED` (when deletion is prevented by active consumers)
- `MODULE_RELEASE_ARCHIVED`

**File:** `/Users/prasannaarikala/projects/agent-platform/apps/studio/src/services/audit-service.ts`

### [MEDIUM-5] Express route ordering concern for runtime module routes

The HLD does not specify new runtime Express routes, but Workstream D modifies `apps/runtime/src/routes/deployments.ts`. If new routes like `/deployments/:id/module-snapshot` are added, they must be registered before the existing `/:id` parameterized route to avoid capture. The LLD must verify route registration order.

**File:** `/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/routes/deployments.ts`

### [MEDIUM-6] `ProjectManifestV2` already has `required_auth_profiles` -- module contract should reuse

The existing `ProjectManifestV2` type (in `packages/project-io/src/types.ts`, line 400) already defines `required_auth_profiles` with a rich schema including `authType`, `scope`, `connector`, `category`, `connectionMode`, `config`, and `referencedBy`. The module contract's "required auth profiles" field should reuse this exact shape rather than inventing a new one. The HLD implies this reuse but does not make it explicit.

**File:** `/Users/prasannaarikala/projects/agent-platform/packages/project-io/src/types.ts`

### [MEDIUM-7] No mention of i18n for new Studio UI components

Workstream C introduces four new components: `ModuleSettingsPanel`, `PublishModuleDialog`, `ImportModuleDialog`, `ModuleDependencyList`. The HLD does not specify i18n strategy. All user-visible strings in these components must use translation keys from `packages/i18n/locales/en/studio.json`. The LLD must specify the i18n namespace (e.g., `modules`) and list the key categories.

### [MEDIUM-8] SWR cache invalidation strategy not specified for module operations

Workstream C lists multiple Studio API endpoints but does not specify how SWR caches should be invalidated after mutations (publish, import, promote, dependency changes). For example:

- After publishing a release, the module catalog in all open consumer project tabs must update
- After importing a dependency, the topology view must refresh
- After promoting a pointer, dependency lists showing "update available" indicators must refresh

The LLD must specify `mutate()` call patterns for each mutation endpoint.

### [LOW-1] `kind` field uses `'application' | 'module'` -- consider future extensibility

The HLD uses a simple string union. If the platform later needs other project kinds (e.g., `'template'`, `'library'`), this is fine as a string enum. But the schema should use Mongoose `enum` validation to prevent arbitrary values. This is a minor implementation note.

### [LOW-2] Module preview uses `entryAgentName` but the field is nullable

`Project.entryAgentName` is `string | null` in the current schema. The HLD says modules reuse this as the "fixed preview entry agent." The LLD must validate that `entryAgentName` is set before allowing module preview. If null, return a 422 with a remediation message directing the user to set it.

### [LOW-3] Missing mention of `AgentModelConfig` portability enforcement

The HLD correctly notes (line 127, 176) that `AgentModelConfig` is not portable. However, it does not specify what happens at publish time if the module project has `AgentModelConfig` records. The publish contract should emit a warning that model configuration is not included in the release artifact and that consumers must configure models independently.

---

## VERIFIED

- [x] **File paths verified** -- All 55 "Files to update" paths in the HLD exist in the codebase. The following files were confirmed present:
  - `packages/project-io/src/export/project-exporter.ts`
  - `packages/project-io/src/export/manifest-generator.ts`
  - `packages/project-io/src/types.ts` (with `ProjectManifestV2`)
  - `packages/project-io/src/import/prerequisite-validator.ts`
  - `packages/project-io/src/import/auth-profile-resolver.ts`
  - `apps/studio/src/app/api/sdk/preview-token/route.ts`
  - `apps/studio/src/app/preview/[projectId]/page.tsx`
  - `apps/runtime/src/services/session/session-bootstrap.ts`
  - `apps/runtime/src/services/deployment-resolver.ts`
  - `apps/runtime/src/services/snapshot-service.ts`
  - `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts`
  - `packages/compiler/src/platform/ir/auth-requirement-collector.ts`
  - `packages/shared/src/tools/resolve-tool-implementations.ts`
  - `apps/studio/src/lib/route-handler.ts`
  - `apps/studio/src/lib/permissions.ts`
  - `apps/studio/src/lib/project-access.ts`
  - `apps/studio/src/store/project-store.ts`
  - `apps/studio/src/api/projects.ts`
  - `apps/studio/src/api/tools.ts`
  - `apps/studio/src/components/projects/ProjectDashboard.tsx`
  - `apps/studio/src/components/projects/ProjectCard.tsx`
  - `apps/studio/src/components/projects/ProjectSwitcher.tsx`
  - `apps/studio/src/components/creation/NewProjectDropdown.tsx`
  - `apps/studio/src/components/abl/ABLEditor.tsx`
  - `apps/studio/src/components/abl/ABLSymbolTree.tsx`
  - `apps/studio/src/components/abl/ToolPickerDialog.tsx`
  - `apps/studio/src/components/agent-detail/CoordinationSection.tsx`
  - `apps/studio/src/app/api/projects/[id]/dependencies/route.ts`
  - `apps/studio/src/app/api/projects/[id]/topology/route.ts`
  - `apps/runtime/src/middleware/feature-gate.ts`
  - `apps/runtime/src/routes/platform-admin-features.ts`
  - `apps/runtime/src/services/preflight-validation-service.ts`
  - `apps/runtime/src/services/auth-profile/auth-preflight.ts`
  - `apps/runtime/src/services/execution/routing-executor.ts`
  - `apps/runtime/src/services/runtime-executor.ts`
  - `apps/runtime/src/services/config/project-runtime-config-resolver.ts`
  - `apps/runtime/src/services/llm/model-resolution.ts`
  - `apps/runtime/src/tools/load-project-tools-as-ir.ts`
  - `apps/runtime/src/services/version-service.ts`
  - `apps/runtime/src/services/trace-store.ts`
  - `apps/runtime/src/routes/deployments.ts`
  - `apps/runtime/src/repos/deployment-repo.ts`
  - `apps/runtime/src/services/session/redis-session-store.ts`
  - `apps/runtime/src/services/session/session-state-repo.ts`
  - `apps/runtime/src/services/execution/types.ts`
  - `apps/runtime/src/services/session/types.ts`
  - `apps/runtime/src/routes/sessions.ts`
  - `apps/runtime/src/__tests__/helpers/runtime-api-harness.ts`
  - `apps/runtime/src/__tests__/helpers/channel-e2e-bootstrap.ts`
  - `apps/studio/src/services/audit-service.ts`
  - `apps/studio/src/repos/project-repo.ts`
  - `apps/studio/src/services/project-service.ts`

- [x] **Architecture compliance** -- Design enforces:
  - Tenant isolation: `tenantId` on every new entity, catalog scoped to consumer project's tenant
  - Project scoping: routes under `/api/projects/[id]/module*`, all queries include `projectId`
  - Cross-scope access returns 404 (explicitly stated in security table, line 133-141)
  - Centralized auth: uses `withRouteHandler` pattern (line 480) consistent with existing Studio routes
  - Stateless: no pod-local state, snapshots stored in MongoDB, no in-memory module caches
  - Traceability: explicit trace provenance fields (`moduleAlias`, `moduleProjectId`, `moduleReleaseId`, `sourceAgentName`)
  - Compliance: secrets never in release artifacts, audit events for all lifecycle actions

- [x] **Pattern consistency** -- Design correctly:
  - Reuses `withRouteHandler` middleware chain
  - Reuses `PrereqContext` / `PrerequisiteValidator` pattern from `packages/project-io`
  - Reuses `ProjectManifestV2` metadata shape for contract prerequisites
  - Reuses `snapshot-service.ts` deployment snapshot pattern
  - Reuses existing `PLAN_FEATURES` feature-gate pattern
  - Follows existing `DeploymentVariableSnapshot` as a model for `DeploymentModuleSnapshot`

- [x] **Domain rules checked**:
  - No `.cuid()` or `.cuid2()` Zod patterns referenced
  - Error envelope format `{ success, data/error: { code, message } }` implied by existing route-handler pattern
  - Provider-neutral types: no LLM-specific fields in module entities
  - Express route ordering concern flagged (MEDIUM-5)
  - Dockerfile COPY lines: `packages/project-io/package.json` already present in all app Dockerfiles; no new packages are created (new models go in existing `packages/database`)

- [x] **Phase 1 boundary is correct**:
  - Excludes transitive dependencies (major complexity reducer)
  - Excludes partial export (keeps mental model simple)
  - Excludes auto-upgrade (prevents silent breakage)
  - Includes full end-to-end runtime execution (proves value)
  - Includes feature gating (safe rollout)

- [x] **Test plan is comprehensive**:
  - 16 unit tests, 15 integration tests, 13 E2E scenarios, 3 browser smoke tests, 26 regression matrix items
  - E2E tests correctly specify API-only, no direct DB access, real servers
  - Test suite boundaries are well-separated (package, studio, runtime, browser)
  - Regression matrix covers backward compatibility for all existing paths

- [x] **Security model is sound**:
  - Secrets never in artifacts (explicitly enforced at publish time)
  - `configOverrides` are non-secret only
  - Cross-tenant access returns 404
  - Auth profile references are validated at deploy preflight
  - Publish rejects inline secrets in tool DSL
  - Source-only identifiers stripped (`variableNamespaceIds`)

---

## NOTES FOR LLD/IMPLEMENTATION

### Architectural strengths to preserve

1. **Immutability-first design.** The release-once, resolve-at-deploy pattern is the correct architecture. Do not add mutable fields to `ModuleRelease` beyond `archivedAt`/`archivedBy`.

2. **Consumer-project-scoped catalog.** Routing module discovery through the consumer project's context rather than a global surface is the right call for Phase 1. It automatically inherits tenant isolation.

3. **Separation of snapshot from deployment.** Storing `DeploymentModuleSnapshot` in its own collection (not embedded in `Deployment`) is correct for document size management and independent lifecycle.

4. **Config-variable indirection.** Using `{{config.KEY}}` rather than a new binding DSL is the right Phase 1 simplification.

### Watch items during implementation

1. **Alias collision with local agents.** The `<alias>__<symbol>` naming convention must be validated to not collide with any existing local agent or tool name in the consumer project. The import endpoint must check this before saving the dependency.

2. **Working-copy preview vs. deployment preview.** Module preview uses working-copy compilation (no deployment). Consumer project preview must also compile imported module sources from their pinned release -- not from the module project's current working copy. This distinction must be explicit in the deployment-resolver code path.

3. **Agent name length limits.** The `<alias>__<symbol>` rewriting can produce long names. If MongoDB indexes or IR structures have name length limits, the alias rewriter must validate that mounted names do not exceed them.

4. **Optimistic conflict detection (line 165).** The HLD requires that dependency edits and deployment creation use optimistic conflict detection. The LLD should specify the mechanism -- likely `_v` (version counter) on `ProjectModuleDependency` with `findOneAndUpdate({ _v: expectedVersion })`.

5. **`ResolvedAgent` interface extension.** The current `ResolvedAgent` type (in `deployment-resolver.ts`, lines 55-64) has no module provenance fields. The LLD must extend it with optional `moduleProvenance?: Record<string, { alias: string, moduleProjectId: string, moduleReleaseId: string }>` keyed by agent name, and ensure this data survives serialization to session state.

6. **Combined compile latency.** The deployment build service must compile local agents AND re-compile module agents from DSL (since the release stores DSL, not IR). For a consumer with 3 modules of 10 agents each, this could add significant compilation time. The LLD should specify whether compilation is serial or parallelized, and whether module IR can be cached by release hash.

7. **Backward compatibility of deployment resolver.** The HLD correctly states (line 533-534) that projects without module dependencies must behave exactly as before. The LLD must ensure the deployment-resolver has a clean early-return path when no module dependencies exist, with no performance penalty for the common case.

8. **Pointer resolution timing.** When a consumer imports "latest from dev pointer", the `resolvedReleaseId` must be captured at save time, not at deploy time. The HLD specifies this (line 99) but the LLD must enforce it: the import API must resolve the pointer and persist `resolvedReleaseId` atomically.

### Missing workstream: API client layer

Workstream C lists `apps/studio/src/api/projects.ts` and `apps/studio/src/api/tools.ts` as files to update but does not mention creating a new `apps/studio/src/api/modules.ts` API client file. The Studio frontend follows a pattern where each API surface has a dedicated client file (see `api/projects.ts`, `api/tools.ts`). The LLD should add `apps/studio/src/api/modules.ts` to centralize module API calls.

### Missing workstream: Zustand store for module state

Workstream C lists `apps/studio/src/store/project-store.ts` as a file to update but does not mention whether module dependency state, catalog state, or publish state needs a dedicated Zustand store slice or a new store file. Given the complexity of module operations, a dedicated `apps/studio/src/store/module-store.ts` may be warranted. The LLD should specify the state management strategy.

---

## SUMMARY

| Category                | Status          | Details                                        |
| ----------------------- | --------------- | ---------------------------------------------- |
| File paths              | PASS            | All 55 referenced files verified to exist      |
| Architecture compliance | PASS            | All 6 platform principles addressed            |
| Security model          | PASS            | Secret safety, tenant isolation, 404 semantics |
| Phase boundary          | PASS            | Right scope for Phase 1                        |
| Domain model            | PASS WITH NOTES | 8 issues to address in LLD                     |
| Test plan               | PASS            | Comprehensive 4-suite plan with 67 test items  |
| Workstream completeness | PASS WITH NOTES | 2 missing workstream items (API client, store) |
| i18n                    | NOT SPECIFIED   | Must be addressed in LLD                       |
| SWR/frontend state      | NOT SPECIFIED   | Must be addressed in LLD                       |

The HLD is ready for LLD decomposition. The issues above should be resolved during LLD writing, not retroactively patched into the HLD.
