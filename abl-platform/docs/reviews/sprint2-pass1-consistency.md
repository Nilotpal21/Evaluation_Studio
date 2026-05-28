# Sprint 2 -- Pass 1 Consistency Review

**Reviewer:** LLD Reviewer Agent (consistency pass)
**Date:** 2026-03-22
**Scope:** All Sprint 2 implementation files against LLD spec, codebase conventions, type safety, naming, and Sprint 1 integration.

## Verdict: CHANGES_REQUIRED

---

## Findings

### CRITICAL-1: System roles missing `module:*` permissions -- RBAC is broken for non-OWNER roles

- **File:** `packages/database/src/constants/system-roles.ts`
- **Category:** lld-alignment
- **Description:** The LLD Section 7.2 specifies role mappings: OWNER gets all 4 module permissions, EDITOR gets `module:read` + `module:import`, VIEWER gets `module:read`. The 4 module permissions are defined in `apps/studio/src/lib/permissions.ts:59-62`, but they are NOT added to `system-roles.ts`. The SYSTEM_ROLES array has no `module:*` entries for ADMIN, OPERATOR, MEMBER, or VIEWER. Only OWNER (`*:*`) would match via wildcard. Additionally, the LLD refers to "EDITOR" which does not exist as a system role -- the closest is MEMBER or OPERATOR. As a result, no non-OWNER user can access any module route because the permission resolver falls back to these system roles when no DB-seeded RoleDefinitions exist.
- **Recommendation:** Add `module:read`, `module:manage`, `module:publish`, `module:import` to the appropriate system roles. Map the LLD's "EDITOR" to MEMBER (read+import) and "VIEWER" to VIEWER (read-only). Add `module:*` to ADMIN. Sprint scope: **Fix now** -- without this, module routes are OWNER-only.

### HIGH-1: Module settings route missing `tenantId` in consumer dependency count query

- **File:** `apps/studio/src/app/api/projects/[id]/module/route.ts:101`
- **Category:** convention (tenant isolation)
- **Description:** When disabling module mode, the consumer count query is: `ProjectModuleDependency.countDocuments({ moduleProjectId: projectId })`. This is missing `tenantId`, violating the platform invariant that every query must be scoped by tenant. While currently all dependencies within a single deployment share the same tenant, this is a defense-in-depth gap.
- **Recommendation:** Change to `ProjectModuleDependency.countDocuments({ tenantId, moduleProjectId: projectId })`.
- **Sprint scope:** Fix now

### HIGH-2: Feature gate error code diverges from LLD spec

- **File:** `apps/runtime/src/middleware/feature-gate.ts:230-234`
- **Category:** lld-alignment
- **Description:** The LLD Section 9.2 specifies the fail-closed error response should use code `FEATURE_GATE_ERROR` with message "Module feature availability check failed". The implementation uses code `SERVICE_UNAVAILABLE` with message "Module feature check unavailable". For the feature-disabled case, the LLD specifies code `FEATURE_DISABLED` with message "Reusable modules is not enabled for this tenant". The implementation uses the correct code `FEATURE_DISABLED` but a different message: "Reusable modules feature is not available on your current plan".
- **Recommendation:** Align error codes and messages with LLD. Change line 232 from `SERVICE_UNAVAILABLE` to `FEATURE_GATE_ERROR`. Update messages to match LLD.
- **Sprint scope:** Fix now

### HIGH-3: Alias rewriter missing checkpoint.target rewrite for tool names

- **File:** `apps/runtime/src/services/modules/module-alias-rewriter.ts`
- **Category:** lld-alignment (completeness)
- **Description:** The LLD Section 4.2 TOOL_NAME_FIELDS lists `constraints.constraints[].checkpoint.target` and `behavior_profiles[].constraints[].checkpoint.target` as tool name fields that must be rewritten. The `rewriteConstraint` function (lines 210-217) only rewrites `on_fail.target` when type is `handoff` (agent name). It does NOT rewrite `checkpoint.target` (tool name for BEFORE-lowered constraints). This means a module agent with a checkpoint-targeted constraint on a module tool would fail to resolve at runtime because the tool name wouldn't have the alias prefix.
- **Recommendation:** Add checkpoint.target rewriting to the constraint handler. Inside `rewriteConstraint`, add: if `constraint.checkpoint?.target` exists, rewrite it via `rewriteIfMapped`. Do the same in the behavior_profiles loop.
- **Sprint scope:** Fix now

### HIGH-4: Alias rewriter missing staticGraph, human_approval, and flow.definitions[*].then/on_fail agent name fields

- **File:** `apps/runtime/src/services/modules/module-alias-rewriter.ts`
- **Category:** lld-alignment (completeness)
- **Description:** The LLD Section 4.2 lists several additional fields that are not handled by the rewriter:
  1. `flow.staticGraph.nodes[].step.call` -- tool name in static graph visualization nodes
  2. `flow.definitions[*].human_approval.onApprove/onReject/onTimeout` -- step transitions (these are typically step names and would be safely skipped by the rename map, but the LLD explicitly lists them)
  3. `flow.definitions[*].then` and `flow.definitions[*].on_fail` -- These are in AGENT_NAME_FIELDS but `rewriteFlowStep` doesn't handle them. The LLD note says "step names won't be in renameMap and are safely skipped" which makes them low-risk, but an agent name used as a flow `then` target would not be rewritten.

  The staticGraph one matters for Studio rendering of imported module agents.

- **Recommendation:** Add `staticGraph.nodes[].step.call` rewriting in `deepRewriteIR`. Add `then` and `on_fail` handling in `rewriteFlowStep` (safe no-op for step names since they won't be in renameMap). `human_approval` fields are step transitions -- add for completeness.
- **Sprint scope:** Fix now (staticGraph); defer `then`/`on_fail`/`human_approval` to Sprint 3 if risk is judged low.

### HIGH-5: ModuleBuildDiagnostic type shape differs from LLD

- **File:** `apps/runtime/src/services/modules/deployment-build-service.ts:39-44`
- **Category:** lld-alignment
- **Description:** The LLD Section 5.1 specifies `ModuleBuildDiagnostic` as `{ alias, moduleProjectId, agentName?, severity, code, message }`. The implementation uses `{ severity, code, source, message }` where `source` is a flat string like `dependency:${alias}` or `build`. This loses structured access to `alias`, `moduleProjectId`, and `agentName` separately. Studio UI consumers will need to parse the `source` string to display per-module error attribution.
- **Recommendation:** Either align to the LLD's structured shape or document the deviation explicitly. The structured shape is better for frontend consumption. Consider: `{ alias?: string; moduleProjectId?: string; agentName?: string; severity; code; message }`.
- **Sprint scope:** Fix now -- this is a public API contract consumed by the Studio publish and deploy routes.

### HIGH-6: GET dependencies response references non-existent `resolvedVersion` field

- **File:** `apps/studio/src/app/api/projects/[id]/module-dependencies/route.ts:83`
- **Category:** lld-alignment
- **Description:** The GET handler response mapping includes `resolvedVersion: d.resolvedVersion`, but the `IProjectModuleDependency` model (from Sprint 1) has no `resolvedVersion` field. The field will always be `undefined` in the response. The LLD Section 7.4 preview response includes `resolvedVersion` but it comes from the selector resolution, not from the stored dependency.
- **Recommendation:** Either remove `resolvedVersion` from the GET response (it's not stored), or add it to the model, or resolve it at read time by joining to ModuleRelease.
- **Sprint scope:** Fix now

### HIGH-7: Catalog route missing `slug` field specified in LLD

- **File:** `apps/studio/src/app/api/projects/[id]/module-catalog/route.ts:36`
- **Category:** lld-alignment
- **Description:** The LLD Section 7.3 catalog response includes `slug` in the Project.find select clause and in the response shape. The implementation omits `slug` from both the select clause (line 36) and the response (lines 69-85).
- **Recommendation:** Add `slug` to the select clause and response. Verify the Project model has a `slug` field.
- **Sprint scope:** Fix now

### MEDIUM-1: Features route duplicates PLAN_FEATURES constant instead of importing from runtime

- **File:** `apps/studio/src/app/api/features/route.ts:22-45`
- **Category:** convention (DRY)
- **Description:** The LLD Section 9.3 specifies that Studio resolves features by calling the Runtime feature endpoint (`GET /api/tenants/${tenantId}/features`). Instead, the implementation duplicates the `PLAN_FEATURES` constant from `apps/runtime/src/middleware/feature-gate.ts` and performs local resolution. This means any change to plan features must be synchronized across two files. The LLD architecture explicitly chose the "Studio calls Runtime" approach to have a single source of truth.
- **Recommendation:** Either import the constant from a shared package, or follow the LLD's prescribed architecture and have the Studio route call the Runtime API. If local resolution is preferred for latency, extract `PLAN_FEATURES` to `packages/config/` or `packages/shared-kernel/`.
- **Sprint scope:** Fix now

### MEDIUM-2: Features route uses `organizationId: tenantId` for Deal lookup, diverging from feature-gate.ts

- **File:** `apps/studio/src/app/api/features/route.ts:101`
- **Category:** convention (consistency)
- **Description:** The Runtime `feature-gate.ts` uses `resolveOrganizationId(tenantId, contextOrgId)` which first checks `contextOrgId`, then looks up the Tenant document's `organizationId`, then falls back to `tenantId`. The Studio features route skips this resolution and always uses `tenantId` as the `organizationId` for Deal lookup. If tenants have a distinct `organizationId`, the Studio features route will return incorrect results.
- **Recommendation:** Either call the Runtime API (per LLD) or replicate the `resolveOrganizationId` logic.
- **Sprint scope:** Fix now

### MEDIUM-3: Catalog route doesn't implement visibility filtering from LLD

- **File:** `apps/studio/src/app/api/projects/[id]/module-catalog/route.ts:25-33`
- **Category:** lld-alignment
- **Description:** The LLD Section 7.3 specifies visibility filtering: modules with `moduleVisibility: 'tenant'` are visible to all projects, while `private` modules are only visible to project members. The implementation filters by `tenantId` and `kind: 'module'` but doesn't distinguish between `tenant` and `private` visibility. All modules in the tenant are visible to any authenticated user, regardless of the `moduleVisibility` setting. This effectively makes all modules tenant-visible.
- **Recommendation:** Add the `$or` visibility filter from the LLD: `{ $or: [{ moduleVisibility: 'tenant' }, { _id: { $in: memberProjectIds } }] }`. This requires resolving the user's project memberships.
- **Sprint scope:** Fix now

### MEDIUM-4: validateAlias function duplicated in 3 files

- **Files:**
  - `apps/runtime/src/services/modules/module-alias-rewriter.ts:47-60`
  - `apps/studio/src/app/api/projects/[id]/module-dependencies/route.ts:46-59`
  - `apps/studio/src/app/api/projects/[id]/module-dependencies/preview/route.ts:44-57`
- **Category:** convention (DRY)
- **Description:** The alias validation logic is copy-pasted across three files with slight wording differences in error messages. The `ALIAS_PATTERN` regex and `RESERVED_PREFIXES` array are also duplicated. This creates a maintenance risk where validation rules drift.
- **Recommendation:** The alias rewriter already exports `validateAlias`. Import and use it in the Studio routes, or extract to a shared module like `@agent-platform/project-io`.
- **Sprint scope:** Fix now

### MEDIUM-5: Deployment build service resolves selector but LLD says use stored resolvedReleaseId

- **File:** `apps/runtime/src/services/modules/deployment-build-service.ts:142`
- **Category:** lld-alignment
- **Description:** The deployment build service calls `resolveSelector(tenantId, moduleProjectId, selector)` for each dependency, which re-resolves the selector at deploy time. However, each `ProjectModuleDependency` document already stores `resolvedReleaseId` (pinned at import time). The LLD Section 5.1 step 6a says "Load ModuleRelease by resolvedReleaseId" -- it uses the stored ID, not a re-resolution. Re-resolving means environment pointers could have moved since import, causing a different release to be used than what the user approved.
- **Recommendation:** Use `dep.resolvedReleaseId` directly to load the release, rather than re-resolving via selector. This matches the LLD's design intent of pinning at import time.
- **Sprint scope:** Fix now

### MEDIUM-6: Deployment build service `version` field set to `selector.value` instead of release version

- **File:** `apps/runtime/src/services/modules/deployment-build-service.ts:313`
- **Category:** lld-alignment
- **Description:** In the `resolvedDependencies` array, `version` is set to `selector.value`, which for environment selectors would be `"dev"`, `"staging"`, or `"production"` -- not the actual release version string like `"1.2.0"`. This makes the deployment snapshot's dependency metadata misleading.
- **Recommendation:** Set `version` to the actual release version (e.g., from `(releaseDoc.version as string)` after loading the release). This requires tracking the version per dependency during the loop.
- **Sprint scope:** Fix now

### MEDIUM-7: Promote route `updatedAt` not explicitly set in `$set`

- **File:** `apps/studio/src/app/api/projects/[id]/module/releases/[releaseId]/promote/route.ts:54-69`
- **Category:** lld-alignment
- **Description:** The LLD Section 10.3 includes `updatedAt: new Date()` in the `$set` clause of the pointer promotion update. The implementation omits `updatedAt` from `$set`. If the `ModuleEnvironmentPointer` schema uses `{ timestamps: true }`, Mongoose will auto-set it. However, if not, the field won't be updated.
- **Recommendation:** Verify `ModuleEnvironmentPointer` schema uses `timestamps: true`. If not, add `updatedAt: new Date()` to the `$set` clause.
- **Sprint scope:** Fix now

### MEDIUM-8: Features cache entry has no tenant context validation

- **File:** `apps/studio/src/app/api/features/route.ts:127-134`
- **Category:** convention
- **Description:** The in-memory feature cache eviction uses FIFO (delete first inserted key), which is fine. However, the MAX_CACHE_ENTRIES and CACHE_TTL_MS are correctly specified. The `featureCache` Map correctly implements max size (1000) and TTL (60s), meeting the "in-memory Maps must have max size, TTL, and eviction" invariant. No issue here -- marking as verified.
- **Recommendation:** None (verified).
- **Sprint scope:** N/A

### LOW-1: Logger variable prefixed with underscore in preview route

- **File:** `apps/studio/src/app/api/projects/[id]/module-dependencies/preview/route.ts:18`
- **Category:** convention
- **Description:** The logger is assigned as `const _log = createLogger(...)` with an underscore prefix, indicating it's unused. If logging is not needed in the preview route, the import and assignment should be removed. If logging is needed, remove the underscore prefix and use it.
- **Recommendation:** Remove the unused logger, or use it for error logging within the route.
- **Sprint scope:** Fix now

### LOW-2: ModuleRelease.find filter uses `archivedAt: { $in: [null, undefined] }` inconsistently

- **Files:**
  - `apps/studio/src/app/api/projects/[id]/module-catalog/route.ts:30,51` -- uses `{ $in: [null, undefined] }`
  - `apps/studio/src/app/api/projects/[id]/module-catalog/[moduleProjectId]/route.ts:41` -- uses `{ $in: [null, undefined] }`
  - `apps/studio/src/app/api/projects/[id]/module-dependencies/route.ts:152` -- uses `archivedAt: null`
  - `apps/studio/src/app/api/projects/[id]/module-dependencies/preview/route.ts:99` -- uses `archivedAt: null`
- **Category:** convention
- **Description:** Some routes use `archivedAt: null` and others use `archivedAt: { $in: [null, undefined] }` to filter non-archived releases. In MongoDB, `null` matches both `null` values and missing fields, so `archivedAt: null` is sufficient and simpler. The `{ $in: [null, undefined] }` form is redundant (MongoDB `undefined` is deprecated).
- **Recommendation:** Standardize on `archivedAt: null` across all routes for consistency.
- **Sprint scope:** Defer to Sprint 3

---

## Verified Checks

- [x] **Permission constants** -- All 4 module permissions defined in `permissions.ts:59-62` match LLD Section 7.2 names exactly (`module:read`, `module:manage`, `module:publish`, `module:import`)
- [x] **Audit actions** -- All 8 LLD-specified audit actions present in `audit-service.ts:146-153` with correct names
- [x] **withRouteHandler usage** -- All routes correctly use `requireProject: true` and appropriate permissions
- [x] **Error envelope format** -- All error responses use `errorJson()` or `NextResponse.json({ success: false, errors: [...] })` format
- [x] **Zod request validation** -- Publish, promote, import, and preview routes all use bodySchema with proper Zod schemas
- [x] **Zod ID validation** -- All ID fields use `z.string().min(1)` (not `.cuid()` or `.cuid2()`)
- [x] **Logger convention** -- All files use `createLogger('module-name')` from `@abl/compiler/platform`
- [x] **Error handling** -- All catch blocks use `err instanceof Error ? err.message : String(err)` pattern
- [x] **Feature flag name** -- `reusable_modules` matches LLD Section 9.1
- [x] **PLAN_FEATURES tiers** -- `reusable_modules` correctly in BUSINESS and ENTERPRISE arrays
- [x] **Fail-closed gate** -- `createModuleFeatureGate()` returns 503 on error, never calls `next()` (line 229)
- [x] **SWR hook** -- `useFeatures()` correctly implements fail-closed with fallback data, refresh interval, and retry limits
- [x] **Cursor pagination** -- Releases GET uses cursor-based pagination with `limit + 1` pattern
- [x] **Publish deduplication** -- Uses Model.create + catch E11000 (not check-then-write) per LLD Section 7.5
- [x] **Optimistic concurrency** -- Promote route implements revision-based concurrency per LLD Section 10.3
- [x] **Dependency version increment** -- Both POST and DELETE dependency routes increment `moduleDependencyVersion`
- [x] **configOverrides validation** -- Uses shared `validateConfigOverrides` from project-io with template injection, control char, and secret prevention
- [x] **Sprint 1 model integration** -- Routes correctly use `ProjectModuleDependency`, `ModuleRelease`, `ModuleEnvironmentPointer` from Sprint 1
- [x] **Types file** -- `ResolvedAgentIR`, `ResolvedToolDefinition`, `MountedAgentEntry`, `MountedToolEntry`, `DeploymentModuleSnapshotPayload` all match LLD Section 6

---

## Summary

**14 findings total: 1 CRITICAL, 7 HIGH, 7 MEDIUM, 2 LOW**

The CRITICAL finding (CRITICAL-1: missing system role permissions) blocks all non-OWNER users from accessing module routes. This must be fixed before any testing.

The HIGH findings cluster around two themes:

1. **LLD alignment gaps** in the alias rewriter (missing checkpoint.target, staticGraph), feature gate error codes, diagnostic type shape, and catalog response fields
2. **Data integrity** issues: missing tenantId in a count query, phantom `resolvedVersion` field, re-resolving selectors instead of using pinned IDs

The MEDIUM findings are mostly about code duplication (validateAlias x3, PLAN_FEATURES x2) and the catalog route's missing visibility filtering.

**Prior review patterns confirmed:**

- Feature doc drift was the top issue in Sprint 1 reviews. Sprint 2 shows the same pattern with the `resolvedVersion` ghost field and `slug` omission.
- The `compiledIR` three-way type divergence from Sprint 1 reviews is handled correctly in deployment-build-service via `as AgentIR` cast on line 197.
