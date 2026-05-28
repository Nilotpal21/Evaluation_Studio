# Sprint 2 -- Pass 1 Security Review

## Verdict: APPROVED_WITH_RESERVATIONS

**Reviewed files:** 13 implementation files (1 modified, 12 new)
**Reviewer:** LLD Reviewer Agent (Security Pass)
**Date:** 2026-03-22

---

## Findings

### CRITICAL-1: Consumer count query missing tenantId -- cross-tenant module disable block

- **File:** `apps/studio/src/app/api/projects/[id]/module/route.ts:101-103`
- **Category:** tenant-isolation
- **Description:** When disabling module mode, the consumer count check queries `ProjectModuleDependency.countDocuments({ moduleProjectId: projectId })` without `tenantId`. This means consumer dependencies from ANY tenant count toward the block, potentially preventing a legitimate module owner from disabling their own module. While this is a denial-of-service rather than data exposure, it also leaks cross-tenant usage information: if a module owner in tenant A sees "3 consumer projects depend on this module" and they know their own tenant has 0 consumers, they learn that other tenants have dependencies.

  In a multi-tenant SaaS scenario where module visibility is scoped to `tenantId` (as enforced by the catalog route), dependencies from other tenants should not affect the module owner's ability to disable their module -- OR the count should still be tenantId-scoped and cross-tenant consumers handled separately.

- **Recommendation:** Add `tenantId` to the consumer count query:
  ```typescript
  const consumerCount = await ProjectModuleDependency.countDocuments({
    tenantId,
    moduleProjectId: projectId,
  });
  ```
  If cross-tenant consumers should also block disable, use two queries and return a generic message that doesn't reveal cross-tenant counts.
- **Sprint scope:** Fix now

### HIGH-1: Cursor pagination parameter unsanitized -- potential NoSQL operator injection

- **File:** `apps/studio/src/app/api/projects/[id]/module/releases/route.ts:46-50`
- **Category:** injection
- **Description:** The `cursor` query parameter from `url.searchParams.get('cursor')` is inserted directly into a MongoDB query as `filter._id = { $lt: cursor }`. Since `cursor` is a raw string from the URL, it is used as a MongoDB comparison value. While MongoDB driver typically handles string comparisons safely, the cursor is not validated as a valid ObjectId or string ID format. A malicious cursor value like a very long string could cause performance issues. More importantly, this pattern of accepting raw user input for MongoDB operators should be validated.
- **Recommendation:** Validate cursor as a valid MongoDB ObjectId before use:
  ```typescript
  import { Types } from 'mongoose';
  if (cursor) {
    if (!Types.ObjectId.isValid(cursor)) {
      return errorJson('Invalid cursor', 400, ErrorCode.VALIDATION_ERROR);
    }
    filter._id = { $lt: cursor };
  }
  ```
- **Sprint scope:** Fix now

### HIGH-2: Snapshot hash truncated to 64 bits -- birthday collision risk

- **File:** `apps/runtime/src/services/modules/deployment-build-service.ts:333`
- **Category:** validation
- **Description:** `crypto.createHash('sha256').update(hashInput).digest('hex').slice(0, 16)` truncates SHA-256 to 16 hex chars (64 bits). Birthday collision probability reaches 50% at ~2^32 snapshots. While this volume is unlikely per-project, the hash is used as `snapshotHash` which could become a uniqueness constraint. This was flagged in Sprint 1 review (Pass 3 and Pass 4) and remains unfixed.
- **Recommendation:** Use at least 32 hex characters (128 bits) for collision resistance:
  ```typescript
  .digest('hex').slice(0, 32)
  ```
- **Sprint scope:** Fix now (persistent pattern from Sprint 1)

### HIGH-3: Feature gate fail-open allows unauthorized module access during outages

- **File:** `apps/runtime/src/middleware/feature-gate.ts:144-149`
- **Category:** access-control
- **Description:** The generic `requireFeature()` middleware fails open on errors (calls `next()` in the catch block). While this is the documented design for general features, if any module route mistakenly uses `requireFeature('reusable_modules')` instead of `createModuleFeatureGate()`, it would allow access during DB outages. The `createModuleFeatureGate()` correctly fails closed (returns 503), but nothing prevents an implementor from using the wrong function.
- **Recommendation:** Add a runtime warning or TypeScript nominal type to prevent `requireFeature('reusable_modules')` from being used:
  ```typescript
  export function requireFeature(featureName: string) {
    if (featureName === 'reusable_modules') {
      log.warn('Use createModuleFeatureGate() for reusable_modules -- requireFeature fails open');
    }
    // ...
  }
  ```
  Alternatively, document prominently that module routes MUST use `createModuleFeatureGate()`.
- **Sprint scope:** Fix now

### HIGH-4: Release route preview query missing moduleProjectId scope

- **File:** `apps/studio/src/app/api/projects/[id]/module-dependencies/preview/route.ts:96-99`
- **Category:** project-isolation
- **Description:** The release lookup `ModuleRelease.findOne({ _id: selectorResult.releaseId, tenantId, archivedAt: null })` does not include `moduleProjectId` in the filter. While `resolveSelector()` internally scopes by `tenantId` and `moduleProjectId`, the subsequent `findOne` on the release only uses `_id` and `tenantId`. If there were a release ID collision (or if IDs are predictable), this could return a release from a different module project within the same tenant.

  Compare with the promote route (`releases/[releaseId]/promote/route.ts:37-41`) which correctly uses `{ _id: releaseId, tenantId, moduleProjectId: projectId }`.

- **Recommendation:** Add `moduleProjectId: body.moduleProjectId` to the filter:
  ```typescript
  const release = await ModuleRelease.findOne({
    _id: selectorResult.releaseId,
    tenantId,
    moduleProjectId: body.moduleProjectId,
    archivedAt: null,
  });
  ```
- **Sprint scope:** Fix now

### MEDIUM-1: In-memory feature cache lacks TTL eviction -- stale entries accumulate

- **File:** `apps/studio/src/app/api/features/route.ts:56-63`
- **Category:** access-control
- **Description:** The `featureCache` Map has a max entry limit (`MAX_CACHE_ENTRIES = 1000`) and a TTL check on read, but stale entries are never proactively evicted. The eviction strategy (delete first key when at capacity) is FIFO, not LRU/TTL-based. This means 999 expired entries can sit in memory while a single fresh write triggers deletion of the oldest-but-potentially-still-valid entry.

  Security implication: A tenant whose features were downgraded will continue to see cached (higher privilege) features until the 60s TTL expires. This is acceptable for 60s but the cache never prunes expired entries, so memory grows monotonically to `MAX_CACHE_ENTRIES`.

- **Recommendation:** Add periodic cleanup (e.g., sweep expired entries every 5 minutes) or use an LRU cache library. The 60s TTL window for stale feature state is acceptable.
- **Sprint scope:** Defer to Sprint 3

### MEDIUM-2: Error messages in deployment-build-service reveal internal details

- **File:** `apps/runtime/src/services/modules/deployment-build-service.ts:108-118`
- **Category:** disclosure
- **Description:** The `DEPENDENCY_VERSION_MISMATCH` diagnostic message includes both `expectedDependencyVersion` and `currentDepVersion`: `Dependencies changed during build (expected v${expectedDependencyVersion}, current v${currentDepVersion})`. While this is an internal service (not directly exposed via HTTP), if these diagnostics are forwarded to a client response, they leak internal version tracking state.
- **Recommendation:** Ensure build diagnostics are not returned verbatim in HTTP responses. The message is acceptable for internal logging but should be sanitized if surfaced to users.
- **Sprint scope:** Defer to Sprint 3

### MEDIUM-3: configOverrides validation allows newlines in values -- template injection via multi-line

- **File:** `packages/project-io/src/module-release/config-overrides-validator.ts:22-23`
- **Category:** injection
- **Description:** The `CONTROL_CHAR_RE` regex explicitly excludes tab (`\x09`), newline (`\x0A`), and carriage return (`\x0D`): `/[\x00-\x08\x0B\x0C\x0E-\x1F]/`. This means a config override value can contain newlines. The `TEMPLATE_INJECTION_RE` correctly uses `/\{\{/` (anchored on the opening delimiter, not requiring `.*}}`), which avoids the newline bypass issue flagged in Sprint 1 Pass 3.

  However, newlines in config values that are interpolated into multi-line template contexts (YAML, HTTP headers) could still enable injection depending on the downstream consumer. For example, a config value of `foo\nINJECTED_HEADER: bar` could inject an HTTP header if the template context is an HTTP tool binding.

- **Recommendation:** Consider whether newlines should be allowed in config override values. If the interpolation target is always a single-valued context (not multi-line), reject `\n` and `\r`. If newlines are needed, document which template contexts safely handle them.
- **Sprint scope:** Fix now (depends on template interpolation context analysis)

### MEDIUM-4: Duplicate PLAN_FEATURES definition -- divergence risk

- **File:** `apps/studio/src/app/api/features/route.ts:22-45` and `apps/runtime/src/middleware/feature-gate.ts:23-46`
- **Category:** access-control
- **Description:** `PLAN_FEATURES` is defined identically in both the Studio features route and the Runtime feature gate. If one is updated without the other, the Studio UI and Runtime will disagree on which features are available for a plan tier, creating a discrepancy where the UI shows a feature as available but the runtime rejects it (or vice versa).
- **Recommendation:** Extract `PLAN_FEATURES` to a shared package (e.g., `@agent-platform/shared/features`) and import in both locations.
- **Sprint scope:** Defer to Sprint 3

### MEDIUM-5: Promote route upsert path creates pointer without validating initial state

- **File:** `apps/studio/src/app/api/projects/[id]/module/releases/[releaseId]/promote/route.ts:104-123`
- **Category:** authorization
- **Description:** When `expectedRevision` is not provided, the upsert path will create a new `ModuleEnvironmentPointer` or update an existing one with no concurrency check. The `$setOnInsert` includes `tenantId`, `moduleProjectId`, `environment` which is good for idempotent upserts. However, this means any caller with `MODULE_PUBLISH` permission can silently overwrite another user's promotion without concurrency awareness. While `expectedRevision` is optional for convenience, the default path should at minimum log that it's overwriting.
- **Recommendation:** Log when an upsert overwrites an existing pointer (check if `result.revision > 1` to determine if it was an update vs create).
- **Sprint scope:** Defer to Sprint 3

### LOW-1: Unused logger variable in preview route

- **File:** `apps/studio/src/app/api/projects/[id]/module-dependencies/preview/route.ts:18`
- **Category:** validation
- **Description:** `const _log = createLogger('module-dependencies-preview-route')` is declared but never used (underscore prefix indicates awareness). This is not a security issue but indicates either incomplete error logging or dead code.
- **Recommendation:** Either use the logger for error paths or remove it.
- **Sprint scope:** Defer

### LOW-2: Release list GET does not filter by archivedAt

- **File:** `apps/studio/src/app/api/projects/[id]/module/releases/route.ts:48-56`
- **Category:** disclosure
- **Description:** The GET releases list does not filter out archived releases by default. It includes `archivedAt` in the response shape (line 75), meaning archived releases are visible. The catalog detail route (`module-catalog/[moduleProjectId]/route.ts:37-41`) DOES filter `archivedAt: { $in: [null, undefined] }`. This inconsistency means the releases list shows archived releases while the catalog detail does not.
- **Recommendation:** Either filter archived releases by default (with opt-in `includeArchived` param like the catalog route), or document this is intentional for module publishers to see their full release history.
- **Sprint scope:** Defer to Sprint 3

---

## Verified

- [x] **Tenant isolation** -- All DB queries include `tenantId` (except CRITICAL-1 consumer count). No `findById()` usage found. Cross-scope access returns 404.
- [x] **Project isolation** -- All routes use `withRouteHandler({ requireProject: true })` which calls `requireProjectAccess()`. Queries scope to `projectId` from `params.id`. One exception noted (HIGH-4).
- [x] **Authorization** -- Correct `StudioPermission` constants used per route: `MODULE_READ` for GETs, `MODULE_MANAGE` for settings, `MODULE_PUBLISH` for releases/promote, `MODULE_IMPORT` for dependencies.
- [x] **Input validation** -- Zod schemas present for all POST bodies. ID fields use `z.string().min(1)` (correct, no `.cuid()`). Version uses semver regex.
- [x] **Error handling** -- `err instanceof Error ? err.message : String(err)` pattern used correctly. Standard `{ success, error: { code, message } }` envelope.
- [x] **No console.log** -- All files use `createLogger()` from `@abl/compiler/platform`.
- [x] **No findById()** -- All queries use `findOne({ _id, tenantId })` pattern.
- [x] **Config override validation** -- `validateConfigOverrides()` exists and is implemented (Sprint 1 CRITICAL was addressed). Rejects `{{` template injection, control characters, oversized values, secret key overrides.
- [x] **Module feature gate fails closed** -- `createModuleFeatureGate()` returns 503 on error, not `next()`.
- [x] **Alias validation** -- Rejects reserved prefixes, double underscores, validates pattern.
- [x] **Deployment snapshot size limit** -- 8 MB pre-compression check present.
- [x] **Symbol count limit** -- MAX_MOUNTED_SYMBOLS = 250 enforced.

---

## Notes

- **CRITICAL-1 is the highest priority** -- the missing `tenantId` in the consumer count query is a tenant isolation violation that should block deployment.
- **Sprint 1 carryover:** HIGH-2 (hash truncation) was flagged in Sprint 1 Pass 3 and Pass 4 but remains. This should be addressed before it becomes a harder-to-change convention.
- **Template injection defense is good** -- The `validateConfigOverrides` implementation correctly uses `/\{\{/` (anchored on opening delimiter) rather than the full `{{...}}` pattern that was flagged as vulnerable to newline bypass in Sprint 1 Pass 3.
- **Module selector (`resolveSelector`) has good tenant scoping** -- All internal queries include `tenantId` and `moduleProjectId`.
- **No decompression path found in Sprint 2** -- The `gzip()` compression path exists in `deployment-build-service.ts` but no `gunzip`/decompression was found in these files. The runtime decompression path (where `maxOutputLength` should be checked) is likely in a separate runtime resolver file not in this sprint's scope.
- **Audit logging is consistent** -- All mutating operations emit audit events. Non-fatal audit failures are caught and logged (not swallowed).
