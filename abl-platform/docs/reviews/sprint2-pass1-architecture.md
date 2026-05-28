# Sprint 2 -- Pass 1 Architecture Review

**Reviewer:** lld-reviewer (architecture focus)
**Date:** 2026-03-22
**Files reviewed:** 15 implementation files + LLD spec + 3 reference models

## Verdict: CHANGES_REQUIRED

---

## Findings

### CRITICAL-1: Missing tenantId in consumer dependency count query (cross-tenant isolation)

- **File:** `apps/studio/src/app/api/projects/[id]/module/route.ts:101-103`
- **Category:** separation / error-handling
- **Description:** The disable-module-mode path counts consumer dependencies using `ProjectModuleDependency.countDocuments({ moduleProjectId: projectId })` without `tenantId`. This queries across all tenants, meaning a module project could be blocked from disabling because of dependencies in a different tenant. More critically, the count is returned in the error message, leaking cross-tenant dependency information.
- **Recommendation:** Add `tenantId` to the query filter:
  ```ts
  const consumerCount = await ProjectModuleDependency.countDocuments({
    tenantId,
    moduleProjectId: projectId,
  });
  ```
- **Sprint scope:** Fix now

### CRITICAL-2: Deployment build TOCTOU race -- no post-build version verification

- **File:** `apps/runtime/src/services/modules/deployment-build-service.ts:86-119` vs `365-372`
- **Category:** concurrency
- **Description:** The LLD (Section 10.1) specifies a two-phase concurrency check: (1) pre-build version check, (2) atomic verify-and-persist using `findOneAndUpdate` with `moduleDependencyVersion` condition after building the snapshot. The implementation only does the pre-build check (line 104-119) and then unconditionally creates the snapshot (line 365). Between the version check and the snapshot persist, a dependency mutation can change the version, resulting in a snapshot built from stale dependency data.
- **Recommendation:** After building the snapshot and before or atomically with the `DeploymentModuleSnapshot.create`, verify the version hasn't changed:
  ```ts
  const versionCheck = await Project.findOneAndUpdate(
    { _id: projectId, tenantId, moduleDependencyVersion: expectedDependencyVersion },
    { $set: { lastDeployedAt: new Date() } },
    { returnDocument: 'after' },
  );
  if (!versionCheck) {
    // Dependencies changed during build -- abort
    return { success: false, ... diagnostics: [{ code: 'DEPENDENCY_VERSION_MISMATCH', ... }] };
  }
  ```
- **Sprint scope:** Fix now

### CRITICAL-3: Deployment build missing Redis distributed lock

- **File:** `apps/runtime/src/services/modules/deployment-build-service.ts` (entire file)
- **Category:** concurrency
- **Description:** The LLD Section 10.2 specifies a Redis distributed lock (`module:deploy:{tenantId}:{projectId}`) with 60s TTL and 30s renewal to prevent concurrent deployment builds for the same project. The implementation has no lock at all. Two concurrent deployments for the same project can race, creating duplicate or inconsistent snapshots.
- **Recommendation:** Implement the `acquireDeployLock` function as specified in LLD Section 10.2. Wrap the build logic in a lock/unlock pattern with try/finally. Return 409 if lock acquisition fails.
- **Sprint scope:** Fix now

---

### HIGH-1: N+1 queries in catalog route (2 queries per module)

- **File:** `apps/studio/src/app/api/projects/[id]/module-catalog/route.ts:42-88`
- **Category:** performance
- **Description:** The catalog route fetches all module projects (1 query), then for each module fires 2 additional queries in `Promise.all`: one for the latest release and one for environment pointers. With 100 modules (the limit), this is 201 queries. The LLD doesn't specify aggregation, but 200+ queries per request is architecturally unsound.
- **Recommendation:** Replace the per-module queries with two aggregate queries:
  1. Aggregate `ModuleRelease` grouped by `moduleProjectId` to get latest version per module.
  2. A single `ModuleEnvironmentPointer.find({ tenantId, moduleProjectId: { $in: moduleIds } })`.
     Then join in-memory.
- **Sprint scope:** Fix now

### HIGH-2: Alias rewriter missing `checkpoint.target` (tool name) and `staticGraph` (tool name)

- **File:** `apps/runtime/src/services/modules/module-alias-rewriter.ts`
- **Category:** separation (IR completeness)
- **Description:** The LLD Section 4.2 lists `constraints.constraints[].checkpoint.target` and `behavior_profiles[].constraints[].checkpoint.target` as tool name fields that must be rewritten. The implementation's `rewriteConstraint` function (lines 210-217) only handles `on_fail.target` for handoff agent names but does NOT rewrite `checkpoint.target`. Similarly, `flow.staticGraph.nodes[].step.call` is a tool name field (confirmed in `StaticGraphNode.step.call` in the IR schema) but is not handled by the rewriter. A module with BEFORE-lowered constraints or flow step visualizations will have dangling tool references after alias rewriting.
- **Recommendation:** Add `checkpoint.target` rewriting to `rewriteConstraint`:
  ```ts
  if (constraint.checkpoint?.target) {
    constraint.checkpoint.target = rewriteIfMapped(constraint.checkpoint.target, renameMap);
  }
  ```
  Add staticGraph node rewriting in `deepRewriteIR`:
  ```ts
  if (ir.flow?.staticGraph?.nodes) {
    for (const node of ir.flow.staticGraph.nodes) {
      if (node.step?.call) {
        node.step.call = rewriteIfMapped(node.step.call, renameMap);
      }
    }
  }
  ```
- **Sprint scope:** Fix now

### HIGH-3: Snapshot `version` field uses selector value instead of resolved version for environment selectors

- **File:** `apps/runtime/src/services/modules/deployment-build-service.ts:306-315`
- **Category:** api-design
- **Description:** The `resolvedDependencies` array uses `selector.value` as the `version` field. When the selector type is `environment`, the value is the environment name (e.g., `"production"`), not a semver version. This means the snapshot payload records `version: "production"` instead of the actual resolved version like `"1.2.0"`. Downstream consumers (trace events, provenance, UI) will display the wrong version.
- **Recommendation:** Track the resolved version during the per-dependency loop (it's available from `selectorResult.version` at line 154) and use it when building the resolvedDependencies array. Store the resolved versions in a `Map<alias, version>` during the loop.
- **Sprint scope:** Fix now

### HIGH-4: Duplicated `PLAN_FEATURES` constant across 2 files

- **File:** `apps/runtime/src/middleware/feature-gate.ts:23-46` and `apps/studio/src/app/api/features/route.ts:22-45`
- **Category:** separation
- **Description:** `PLAN_FEATURES` is duplicated verbatim in two files. Any plan tier change requires updating both. The LLD (Section 9.3) specifies that Studio should resolve features by calling the Runtime feature endpoint, which would centralize the logic. Instead, Studio resolves features directly from the DB with its own copy of the plan defaults.
- **Recommendation:** Either:
  - (a) Have the Studio `/api/features` route call the Runtime feature endpoint as specified in the LLD (preferred -- single source of truth), or
  - (b) Extract `PLAN_FEATURES` to a shared package (e.g., `@agent-platform/shared/features`) so both runtime and studio import from one place.
- **Sprint scope:** Fix now

### HIGH-5: Features route uses `tenantId` as `organizationId` (skips org resolution)

- **File:** `apps/studio/src/app/api/features/route.ts:100-101`
- **Category:** api-design
- **Description:** The Studio features route queries `Deal.find({ organizationId: tenantId, ... })`, directly using tenantId as the organizationId. The runtime's `feature-gate.ts` has a `resolveOrganizationId()` function (lines 55-69) that properly maps tenantId to the correct organizationId by looking up the Tenant document. This means the Studio features route may not find deals for tenants that have a different organizationId than their tenantId, resulting in features being incorrectly disabled.
- **Recommendation:** Use the same org resolution logic as the runtime, or delegate to the runtime endpoint as the LLD specifies.
- **Sprint scope:** Fix now

---

### MEDIUM-1: Duplicated `validateAlias` function and constants across 3 files

- **File:** `apps/studio/src/app/api/projects/[id]/module-dependencies/route.ts:21-59`, `apps/studio/src/app/api/projects/[id]/module-dependencies/preview/route.ts:23-57`, `apps/runtime/src/services/modules/module-alias-rewriter.ts:20-59`
- **Category:** separation
- **Description:** `ALIAS_PATTERN`, `RESERVED_PREFIXES`, and `validateAlias()` are copy-pasted across three files. Any change to alias validation rules requires updating all three. Drift risk is high -- if one file's pattern diverges, the preview will accept aliases that the confirm rejects (or vice versa).
- **Recommendation:** Extract alias validation to a shared location (e.g., `packages/project-io/src/module-release/alias-validator.ts`) and import from all three consumers.
- **Sprint scope:** Fix now (simple extraction, prevents drift)

### MEDIUM-2: `resolvedVersion` field returned in GET dependencies but doesn't exist on model

- **File:** `apps/studio/src/app/api/projects/[id]/module-dependencies/route.ts:83`
- **Category:** api-design
- **Description:** The GET dependencies response maps `d.resolvedVersion` from the lean document, but `IProjectModuleDependency` has no `resolvedVersion` field. This returns `undefined` for every dependency. The frontend either ignores it or shows blank version info.
- **Recommendation:** Either:
  - (a) Remove `resolvedVersion` from the response mapping, or
  - (b) Resolve it at response time by joining with `ModuleRelease` to get the actual version for each `resolvedReleaseId` (adds N+1 concern -- prefer option a and let the client resolve if needed).
- **Sprint scope:** Fix now

### MEDIUM-3: Catalog route does not implement visibility filtering per LLD

- **File:** `apps/studio/src/app/api/projects/[id]/module-catalog/route.ts:25-33`
- **Category:** api-design
- **Description:** The LLD Section 7.3 specifies visibility-aware filtering: `$or: [{ moduleVisibility: 'tenant' }, { _id: { $in: memberProjectIds } }]` -- meaning private modules should only be visible to project members. The implementation filters only by `{ kind: 'module', tenantId }`, making ALL module projects in the tenant visible regardless of their `moduleVisibility` setting. This means a module marked "private" is visible to everyone in the tenant.
- **Recommendation:** Implement the visibility filter as specified in the LLD. For Phase 1, if the member project ID resolution is not yet available, at minimum filter out private modules: `$or: [{ moduleVisibility: 'tenant' }, { moduleVisibility: { $in: [null, undefined] } }]`.
- **Sprint scope:** Fix now

### MEDIUM-4: Features route in-memory cache has no TTL-based eviction

- **File:** `apps/studio/src/app/api/features/route.ts:56-63`
- **Category:** performance
- **Description:** The `featureCache` Map has `MAX_CACHE_ENTRIES = 1_000` and 60s TTL per entry, but eviction only happens when the cache is at capacity (line 127-129). It evicts by FIFO (`keys().next().value`), not by TTL expiration. Stale entries from tenants that never re-request remain in memory indefinitely. In a multi-tenant deployment with thousands of tenants, this is a slow memory leak.
- **Recommendation:** Add periodic cleanup (e.g., sweep expired entries every 5 minutes) or use a TTL-aware cache structure. Given that Next.js routes may run in serverless contexts with short lifetimes, the practical impact may be low, but the pattern is architecturally incorrect.
- **Sprint scope:** Defer to Sprint 3

### MEDIUM-5: Promote route duplicates logic for `expectedRevision` vs upsert path

- **File:** `apps/studio/src/app/api/projects/[id]/module/releases/[releaseId]/promote/route.ts:52-148`
- **Category:** separation
- **Description:** The promote handler has two nearly identical code paths: one for when `expectedRevision` is provided (optimistic concurrency, lines 52-101) and one for upsert (lines 102-148). Both paths include identical audit logging and response formatting. This violates DRY and makes maintenance error-prone.
- **Recommendation:** Extract the common post-update logic (audit + response) into a helper, and branch only on the filter/options passed to `findOneAndUpdate`.
- **Sprint scope:** Defer to Sprint 3

### MEDIUM-6: Publish route mixes thick handler logic with route definition

- **File:** `apps/studio/src/app/api/projects/[id]/module/releases/route.ts:84-292`
- **Category:** separation
- **Description:** The POST handler is 200+ lines with 9 numbered steps mixing validation, compilation, DB writes, error handling, and audit logging. This violates the "Router + Service Extraction" pattern established in Sprint 3's API verticalization work. The handler should be a thin orchestrator calling into a `ModuleReleaseService`.
- **Recommendation:** Extract steps 3-6 (build + create) into a service function. Keep the route handler responsible for auth, validation, and response formatting only. Not blocking, but the pattern was established as the standard in Sprint 3.
- **Sprint scope:** Defer to Sprint 3

---

### LOW-1: `_log` unused logger in preview route

- **File:** `apps/studio/src/app/api/projects/[id]/module-dependencies/preview/route.ts:18`
- **Category:** separation
- **Description:** `const _log = createLogger('module-dependencies-preview-route')` is declared but never used (prefixed with `_` to suppress the linter). Either use it or remove it.
- **Recommendation:** Remove the unused import and declaration.
- **Sprint scope:** Fix now

### LOW-2: Feature gate `createModuleFeatureGate` is defined but not wired to Studio routes

- **File:** `apps/runtime/src/middleware/feature-gate.ts:163-239`
- **Category:** api-design
- **Description:** The LLD Section 9.2 states "Apply this middleware to all module-related routes in both Studio and Runtime." The `createModuleFeatureGate` is an Express middleware that cannot be directly used in Next.js API routes. The Studio module routes do not appear to check the feature flag at all -- they rely on the client-side `useFeatures()` hook to hide the UI, but the API endpoints are unprotected.
- **Recommendation:** Add server-side feature checking in each Studio module route handler (or in a shared wrapper). The `useFeatures()` hook is a UX convenience, not a security gate.
- **Sprint scope:** Fix now (API endpoints must enforce the gate server-side)

---

## Verified

- [x] **Resource isolation** -- All model queries include `tenantId` (except CRITICAL-1). Cross-scope returns 404.
- [x] **Auth** -- All routes use `withRouteHandler` with `requireProject: true` and appropriate `permissions`.
- [x] **Stateless** -- No pod-local state as truth. Features route cache is read-only acceleration with proper fallback.
- [x] **Error handling** -- Standard envelope `{ success, error: { code, message } }` used consistently. Error pattern `err instanceof Error ? err.message : String(err)` followed.
- [x] **Audit logging** -- All mutation paths emit audit events. Non-blocking (catch + log on failure).
- [x] **Cursor pagination** -- Releases GET uses proper cursor-based pagination with limit clamping.
- [x] **Optimistic concurrency** -- Promote route correctly implements revision-based optimistic locking.
- [x] **Size enforcement** -- Deployment build validates snapshot size < 8 MB before compression. Symbol count limit of 250 enforced.
- [x] **Zod validation** -- All POST routes use Zod schemas via `bodySchema`. ID fields use `.min(1)` not `.cuid()`.
- [x] **Duplicate version detection** -- Publish route uses `Model.create` + catch 11000 (not check-then-write).

## Notes

- The alias rewriter implementation is thorough for the fields it covers (14 top-level IR sections), but the missing `checkpoint.target` and `staticGraph` fields (HIGH-2) will cause subtle bugs for modules with BEFORE-lowered constraints.
- The features architecture diverges from the LLD: Studio resolves features directly from DB instead of via the Runtime endpoint. This creates drift risk and already manifests as HIGH-5 (missing org resolution).
- The config overrides validator (`config-overrides-validator.ts`) is well-implemented and matches the LLD Section 11.2 precisely, including template injection prevention and control character filtering.
- The `useFeatures` hook correctly fails closed with sensible SWR retry limits.
