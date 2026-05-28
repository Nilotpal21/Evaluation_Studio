# Security Review: Reusable Agent Modules Phase 1 LLD

**Reviewer:** LLD Security Reviewer Agent
**Date:** 2026-03-21
**LLD:** `docs/specs/reusable-agent-modules-phase1.lld.md`
**HLD:** `docs/specs/reusable-agent-modules-phase-plan.hld.md`
**Scope:** Security-focused pass covering tenant isolation, secret safety, auth, concurrency, input validation, feature gating, audit, error responses, Express route ordering, and OWASP top 10.

---

## VERDICT: NEEDS_CHANGES

---

## ISSUES

### CRITICAL

#### SEC-C1: `deleteProject()` signature does not accept `tenantId` -- cascade delete can bypass tenant isolation

The LLD Section 2.1 specifies cascade paths that include `tenantId` in every `deleteMany()` call (e.g., `DeploymentModuleSnapshot.deleteMany({ tenantId, moduleProjectId })`). However, the actual `deleteProject()` function at `packages/database/src/cascade/cascade-delete.ts:137` accepts only `projectId` -- it has **no `tenantId` parameter**. The function retrieves `tenantId` from the project document itself at line 166, but all cascade deletes use `{ projectId }` not `{ tenantId, projectId }`.

This means the LLD's cascade design implicitly assumes a `tenantId` parameter that does not exist in the current function signature. When implementing, the new module entity deletes could accidentally be tenant-unscoped if the implementer follows the existing pattern rather than the LLD's pseudocode.

**File:** `packages/database/src/cascade/cascade-delete.ts:137`
**Fix:** The LLD must explicitly specify that `deleteProject()` must be extended to accept `tenantId` as a parameter (or that a new `deleteModuleProject(projectId, tenantId)` function is needed). All new module entity deletions in the cascade must use `{ tenantId, ... }` in filter queries. Verify the existing cascade entries (DeploymentVariableSnapshot, Deployment, etc.) are also tenant-scoped.

---

#### SEC-C2: Redis lock renewal is not atomic -- TOCTOU race allows lock theft

LLD Section 10.2 specifies lock renewal via:

```
const current = await redis.get(lockKey);
if (current === lockId) {
  await redis.pExpire(lockKey, LOCK_TTL_MS);
}
```

This is a GET-then-EXPIRE pattern with a race window: between `get()` and `pExpire()`, another process could acquire the lock (if the TTL just expired), and the `pExpire()` would extend the **other process's lock**. The same TOCTOU pattern exists in the release function (`get` then `del`).

**File:** LLD Section 10.2 (Redis lock)
**Fix:** Use a Lua script for atomic check-and-renew:

```lua
-- Renewal
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end
```

And atomic check-and-delete for release:

```lua
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
```

Both patterns are standard in the platform per CLAUDE.md: "Redis lock patterns use `SET NX PX` with TTL." The SET is atomic, but the renewal and release must also be atomic.

---

#### SEC-C3: Soft-delete path allows data leakage -- archived module releases still resolve for new imports if `archivedAt: null` check is missing in catalog query

LLD Section 2.2 sets `archivedAt` on the project and releases when a module is soft-deleted. Section 7.3 (Catalog Route) filters `archivedAt: null` on Project but does **not** show the catalog query filtering `ModuleRelease` by `archivedAt: null` for the enrichment sub-query. The `latestRelease` query at line 807 does include `archivedAt: null`, but the parent Project query at line 792 uses `archivedAt: null` on the Project document.

However, the `IProject` interface at `packages/database/src/models/project.model.ts:14-27` has **no `archivedAt` or `archivedBy` field**. The LLD Section 2.2 calls `Project.findOneAndUpdate(..., { $set: { archivedAt: new Date(), archivedBy: userId } })` but the Project schema does not define these fields. Mongoose with `strict: true` (the default) would silently drop these fields, meaning the soft-delete would silently fail to mark the project as archived.

**File:** `packages/database/src/models/project.model.ts` -- missing `archivedAt`, `archivedBy` fields
**Fix:** The LLD must specify adding `archivedAt: { type: Date, default: null }` and `archivedBy: { type: String, default: null }` to the `IProject` interface and `ProjectSchema`. Without this, the entire soft-delete archive path is a no-op, and "deleted" module projects remain visible in the catalog.

---

#### SEC-C4: `configOverrides` values are not sanitized for injection -- stored as raw strings and potentially interpolated into DSL/config templates

LLD Section 11.2 validates `configOverrides` against the contract for key existence, secret key rejection, and size limits. However, there is no sanitization of the **values** themselves. The `configOverrides` values are `Record<string, string>` that are later interpolated into module config slots (Section 5.1, step 7a: "Apply configOverrides to module config slots").

If a config slot is used in a template context (e.g., `{{config.API_BASE_URL}}`), a malicious value like `http://evil.com"}}\n ADDITIONAL_HEADER: injection` could potentially modify the tool's HTTP binding. The LLD does not specify how config values are interpolated or whether they are escaped.

**File:** LLD Section 11.2 (configOverrides validation) and Section 5.1 step 7a
**Fix:** The LLD must specify:

1. Config override values must be validated against injection patterns (no template syntax `{{`, no newlines in URL-position values, no control characters)
2. When config overrides are applied, they must use strict string replacement (not template engine evaluation)
3. Add a Zod schema for configOverrides values: `z.string().max(1024).regex(/^[^\x00-\x1f]*$/)` (reject control characters)

---

#### SEC-C5: `resolveToolAuth` does not receive module provenance -- imported tools will resolve auth in wrong project scope

LLD Section 6.4 specifies auth resolution scope tracing but does not address a fundamental issue: the `resolveToolAuth` function at `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts:114-131` receives `tenantId` and optional `projectId`. For imported module tools, the tool's `variable_namespace_ids` (which are stripped per Section 3.1 step 3c) will be absent. The `auth_profile_ref` on the tool points to a profile name that must resolve in the **consumer project's** scope.

The LLD Section 6.1 merges mounted tools into `resolvedTools` with `_moduleProvenance` metadata, but does not specify how the consumer's `projectId` is threaded through to `resolveToolAuth()` for these imported tools. If the runtime passes the module's source projectId (from provenance) instead of the consumer's projectId, auth profiles will resolve in the wrong project.

**File:** `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts:114-131` and LLD Section 6.1
**Fix:** The LLD must explicitly specify: "When resolving auth for mounted module tools, always pass the consumer project's `projectId` to `resolveToolAuth()`, never the `moduleProjectId` from provenance. The `variable_namespace_ids` on imported tools must be set to the consumer project's default namespace IDs at deployment build time (Section 5.1 step 7a), not left empty." Add this as a requirement with a specific test case.

---

### HIGH

#### SEC-H1: `deleteProject()` cascade does not scope by `tenantId` in existing entity deletes

Beyond the module-specific issue in SEC-C1, the current `deleteProject()` at `packages/database/src/cascade/cascade-delete.ts:137-235` uses `{ projectId }` without `tenantId` for **all** its delete operations (e.g., `Session.deleteMany({ projectId })`, `Deployment.deleteMany({ projectId })`). While this is pre-existing, the LLD is adding new entities to this cascade and should not perpetuate the pattern.

**File:** `packages/database/src/cascade/cascade-delete.ts:137-235`
**Fix:** The LLD should note this pre-existing gap and specify that the new module cascade entries use `{ tenantId, ... }` queries. Optionally, raise a separate follow-up to fix the existing cascade entries.

---

#### SEC-H2: Dependency version counter check has a TOCTOU race between read and verify

LLD Section 10.1 reads `moduleDependencyVersion` before build and verifies it after:

```ts
const preVersion = project.moduleDependencyVersion;
// ... build snapshot ...
const currentProject = await Project.findOne({ _id: projectId, tenantId });
if (currentProject.moduleDependencyVersion !== preVersion) { throw ... }
```

Between the verify-read and the subsequent `DeploymentModuleSnapshot` persist, another process could increment the counter. The Redis lock (Section 10.2) should prevent this for concurrent deploys, but the dependency mutation (import/remove) runs on Studio, not Runtime, and does **not** acquire the deploy lock. This means:

1. Deploy starts, reads version=5, acquires lock
2. Studio import increments version to 6
3. Deploy verifies version=6 !== 5, correctly fails

This works. But the reverse is also possible:

1. Deploy reads version=5, acquires lock
2. Deploy builds snapshot
3. Deploy re-reads version=5 (still 5, verify passes)
4. Deploy persists snapshot
5. Studio import increments version to 6 (dependency changed but snapshot is stale)

The fix is to use an atomic `findOneAndUpdate` with `{ moduleDependencyVersion: preVersion }` as a condition when persisting the snapshot, not a separate read-verify.

**File:** LLD Section 10.1
**Fix:** Change the verification step to an atomic operation:

```ts
const updated = await Project.findOneAndUpdate(
  { _id: projectId, tenantId, moduleDependencyVersion: preVersion },
  { $set: { lastDeploymentSnapshotAt: new Date() } },
  { returnDocument: 'after' },
);
if (!updated) throw new ConflictError('Dependencies changed during deployment build');
```

This eliminates the TOCTOU window.

---

#### SEC-H3: Publish safety validation does not cover `connector_binding` tool type

LLD Section 11.1 specifies scanning HTTP tools for inline secrets and checking `auth_config`, `custom_headers`, `query_params`, `body_template`. The `ModuleReleaseArtifact` at Section 1.2 allows `toolType: 'http' | 'mcp' | 'sandbox' | 'searchai'`.

However, `resolve-tool-implementations.ts` line 114 shows tools can also have `connector_binding`. The LLD's publish safety scan focuses on HTTP tools but does not specify what to do with MCP, sandbox, or searchai tools that may contain credentials in their bindings (e.g., MCP server URLs with embedded tokens, sandbox environment secrets).

**File:** LLD Section 11.1 and `packages/shared/src/tools/resolve-tool-implementations.ts:114`
**Fix:** The LLD should specify that publish safety validation scans **all** tool binding types, not just HTTP. Specifically:

- MCP bindings: check `serverUrl` for embedded credentials
- Sandbox bindings: check `environmentVariables` for secret values
- SearchAI bindings: check `apiKey` or `endpoint` for inline secrets
- Add `'connector'` to the allowed toolType enum if connectors can be part of modules

---

#### SEC-H4: `auth_resolution` is not a valid TraceEventType -- trace enrichment will fail or be silently dropped

LLD Section 6.4 emits a trace event with `type: 'auth_resolution'`. The canonical `TraceEventType` at `packages/shared-kernel/src/types/trace-event.ts:10-26` is a union type that does **not** include `'auth_resolution'`. The trace store's `TraceEvent` interface at `apps/runtime/src/services/trace-store.ts:22` extends the base type but uses `type: string` (widened from the union), so the event would be accepted by the store. However, any downstream consumers that pattern-match on `TraceEventType` will not process it.

**File:** `packages/shared-kernel/src/types/trace-event.ts:10-26` and LLD Section 6.4
**Fix:** The LLD must specify adding `'auth_resolution'` to the `TraceEventType` union in `packages/shared-kernel/src/types/trace-event.ts`. This ensures type safety and downstream consumer compatibility. Similarly, add `'module_resolution'` if module-specific trace events are planned.

---

#### SEC-H5: No input validation specified for `version` field in publish route -- ReDoS and injection risk

LLD Section 7.5 states "Validate version follows semver pattern" but does not specify the actual validation. Semver regex can be complex and ReDoS-vulnerable. The version field is stored in MongoDB, used in queries, and displayed in the UI.

**File:** LLD Section 7.5
**Fix:** Specify the exact Zod validation for version:

```ts
z.string()
  .min(1)
  .max(50)
  .regex(/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/, 'Must be valid semver (e.g., 1.0.0)');
```

This limits length (prevents ReDoS), uses a simple regex (no backtracking), and prevents special characters that could cause issues in MongoDB queries or UI rendering.

---

### MEDIUM

#### SEC-M1: Catalog route `memberProjectIds` is not defined -- private module visibility check is underspecified

LLD Section 7.3 uses `{ _id: { $in: memberProjectIds } }` in the catalog query but does not define how `memberProjectIds` is computed. For private modules to be visible only to project members, the route handler must query `ProjectMember` to find which module projects the requesting user is a member of. This is a potentially expensive query if the user is a member of many projects.

**File:** LLD Section 7.3
**Fix:** Specify the exact query: `const memberProjectIds = await ProjectMember.distinct('projectId', { userId: user.id, tenantId })`. Note this returns **all** projects the user is a member of, not just module projects -- add `kind: 'module'` join or post-filter. Also specify an index on `ProjectMember` for this query pattern if one doesn't exist.

---

#### SEC-M2: Alias validation regex allows names that collide with DSL keywords

LLD Section 4.1 validates aliases with `^[a-z][a-z0-9_]{1,24}$` and rejects reserved prefixes (`system_`, `internal_`, `test_`). However, it does not reject aliases that match ABL DSL keywords (e.g., `agent`, `tools`, `goal`, `flow`, `handoff`, `delegate`, `gather`). An alias like `agent` would produce mounted names like `agent__lookup_tool`, which could confuse DSL parsing or UI rendering.

**File:** LLD Section 4.1
**Fix:** Add a reserved word list to alias validation: `['agent', 'tool', 'flow', 'handoff', 'delegate', 'gather', 'guard', 'model', 'config', 'env', 'module']`. Reject with 422 if the alias matches any reserved word.

---

#### SEC-M3: No rate limiting specified for publish and import routes

LLD Section 7.1 specifies routes using `withRouteHandler({ requireProject: true })` but does not mention rate limiting. Publishing triggers compilation (CPU-intensive) and import triggers preview validation. Without rate limits, a malicious tenant could DoS the system by rapidly publishing or importing.

**File:** LLD Section 7.1 and 7.5
**Fix:** Specify rate limits on publish and import routes:

- Publish: `rateLimit: { limit: 10, windowMs: 60_000, scope: 'tenant' }` (10 publishes per minute per tenant)
- Import preview: `rateLimit: { limit: 30, windowMs: 60_000, scope: 'user' }` (30 previews per minute per user)
- Import confirm: `rateLimit: { limit: 10, windowMs: 60_000, scope: 'user' }` (10 imports per minute per user)

---

#### SEC-M4: Feature gate `createModuleFeatureGate()` is a new function but `requireFeature()` already exists

LLD Section 9.2 defines a new `createModuleFeatureGate()` middleware that fails closed. The existing `requireFeature()` at `apps/runtime/src/middleware/feature-gate.ts:79` fails open. The LLD proposes adding a parallel function rather than extending the existing one. This creates maintenance risk -- two feature gate implementations to keep in sync.

**File:** `apps/runtime/src/middleware/feature-gate.ts:79-149` and LLD Section 9.2
**Fix:** Instead of a new function, extend `requireFeature()` with an options parameter:

```ts
requireFeature('reusable_modules', { failClosed: true });
```

This keeps a single implementation and makes the fail-closed behavior explicit at the call site.

---

#### SEC-M5: No validation on `releaseNotes` field -- XSS vector if rendered in UI

LLD Section 1.2 defines `releaseNotes: string | null` with no length limit or content validation. Release notes are displayed in Studio UI (Section 8). If the UI renders these without sanitization, they become a stored XSS vector.

**File:** LLD Section 1.2 and Section 7.5
**Fix:** Add Zod validation for releaseNotes in the publish route:

```ts
releaseNotes: z.string().max(2000).optional();
```

The Studio rendering layer should also escape HTML, but defense-in-depth requires server-side length limits.

---

#### SEC-M6: `DeploymentModuleSnapshot` compressed payload has no integrity check

LLD Section 1.5 stores `compressedPayload: Buffer` (gzip). On read, it does `gunzip` then `JSON.parse`. If the buffer is corrupted (bit rot, partial write), gunzip may produce malformed JSON, and `JSON.parse` will throw an unstructured error. There is no checksum to detect corruption.

**File:** LLD Section 1.5 and Section 6.1
**Fix:** Store a `payloadHash: string` alongside the compressed payload (SHA-256 of the uncompressed JSON). On read, verify the hash after gunzip and before parse. If the hash mismatches, return a structured error rather than an opaque JSON parse failure.

---

#### SEC-M7: `sourceHash` truncation to 16 hex chars reduces collision resistance

LLD Section 1.2 computes SHA-256 but truncates to 16 hex characters (64 bits). With birthday paradox, collision probability reaches 50% at ~2^32 (4 billion) hashes. While this is unlikely for module releases, the same pattern is used for deployment hashes (Section 5.3). If deployment hashes collide, the wrong cached compilation could be served.

**File:** LLD Section 1.2 (line 164) and Section 5.3
**Fix:** Use at least 32 hex characters (128 bits) for hashes that affect deployment correctness. The `sourceHash` on `ModuleRelease` is cosmetic (used for dedup), but the deployment hash (Section 5.3) drives cache lookups and must be collision-resistant.

---

#### SEC-M8: LLD Section 11.4 route ordering example is incorrect -- both routes have `:id` parameter

LLD Section 11.4 shows:

```ts
router.get('/deployments/:id/module-snapshot', moduleSnapshotHandler); // static segment
router.get('/deployments/:id', getDeploymentHandler); // parameterized -- must be AFTER
```

The comment says "static segment" but `/deployments/:id/module-snapshot` is **not** static -- `:id` is parameterized. Express would correctly match `/deployments/abc/module-snapshot` to the first route because it has more path segments, so this specific example works. But the comment is misleading and the LLD should clarify that this is about **longer path before shorter path** for same-prefix routes, not static-before-parameterized.

More importantly, the actual deployment routes at `apps/runtime/src/routes/deployments.ts` use `openapi.route()` with paths like `'/'`, `'/:deploymentId'`, `'/:deploymentId/retire'`, etc. The LLD should note that the new module-snapshot route must be registered through the same `openapi.route()` pattern and must appear before the `'/:deploymentId'` catch-all.

**File:** LLD Section 11.4 and `apps/runtime/src/routes/deployments.ts`
**Fix:** Correct the example and note that routes use `openapi.route()` not `router.get()`. The actual concern is that `/:deploymentId/module-snapshot` must be registered before `/:deploymentId` in the route file.

---

## VERIFIED

### Tenant Isolation

- [x] All new model queries include `tenantId` in filters (Sections 1.2-1.5, 3.3, 7.3)
- [x] Cross-tenant access returns 404 not 403 (Section 11.3)
- [x] Catalog query scoped to consumer project's tenant (Section 7.3)
- [x] Module selector queries include `tenantId` (Section 3.3)
- [ ] **FAIL**: Cascade delete `tenantId` scoping (SEC-C1, SEC-H1)
- [ ] **FAIL**: Auth resolution project scope for imported tools (SEC-C5)

### Project Isolation

- [x] All routes under `/api/projects/[id]/...` (Section 7.1)
- [x] Uses `withRouteHandler({ requireProject: true })` (Section 7.1)
- [x] Permission checks on every route (Section 7.2)
- [x] Consumer project's `projectId` used in dependency queries (Section 1.4)

### Secret Safety

- [x] Publish safety validation covers HTTP tools structurally (Section 11.1)
- [x] Pattern-based scanning for common secret formats (Section 11.1)
- [x] configOverrides reject `isSecret: true` keys (Section 11.2)
- [x] configOverrides size limits specified (50 keys, 1KB/value) (Section 1.4)
- [x] `variableNamespaceIds` stripped from artifacts (Section 3.1 step 3c)
- [ ] **FAIL**: No sanitization of configOverrides values for injection (SEC-C4)
- [ ] **FAIL**: Non-HTTP tool bindings not scanned (SEC-H3)

### Auth Profile Resolution

- [x] Trace logging for auth resolution scope specified (Section 6.4)
- [x] Scope field distinguishes project vs tenant resolution (Section 6.4)
- [ ] **FAIL**: `auth_resolution` not in TraceEventType union (SEC-H4)
- [ ] **FAIL**: Consumer projectId threading for imported tools not specified (SEC-C5)

### Cascade Delete

- [x] Two-path cascade logic specified (module project vs consumer project) (Section 2)
- [x] Tenant deletion cascade includes all 4 new entities (Section 2.1)
- [x] Soft-delete path preserves resolvability for existing deployments (Section 2.2)
- [x] Block-or-force logic for active consumer dependencies (Section 2.1 Path A)
- [ ] **FAIL**: `archivedAt`/`archivedBy` not in Project model (SEC-C3)
- [ ] **FAIL**: Cascade function signature mismatch (SEC-C1)

### Concurrency Control

- [x] Publish deduplication uses insertOne + catch E11000 (Section 7.5)
- [x] Dependency version counter specified (Section 10.1)
- [x] Redis lock key includes tenantId and projectId (Section 10.2)
- [x] Lock TTL 60s with 30s renewal (Section 10.2)
- [x] Pointer promotion uses optimistic concurrency (Section 10.3)
- [ ] **FAIL**: Lock renewal/release not atomic (SEC-C2)
- [ ] **FAIL**: Version counter verify has TOCTOU (SEC-H2)

### Input Validation

- [x] Alias pattern validation specified (Section 4.1)
- [x] Reserved prefixes rejected (`system_`, `internal_`, `test_`) (Section 4.1)
- [x] configOverrides size limits (Section 1.4)
- [x] Double underscore in alias rejected (Section 4.1)
- [ ] **FAIL**: Version format validation not specified (SEC-H5)
- [ ] **FAIL**: Alias reserved DSL keywords not rejected (SEC-M2)
- [ ] **FAIL**: releaseNotes no length limit (SEC-M5)

### Feature Gating

- [x] Fail-closed for module routes (Section 9.2)
- [x] Studio fails closed when runtime unreachable (Section 9.3)
- [x] Feature flag name and plan tiers specified (Section 9.1)
- [x] SWR cache with refresh interval for Studio (Section 9.3)

### Redis Lock

- [x] Lock key includes tenantId: `module:deploy:{tenantId}:{projectId}` (Section 10.2)
- [x] TTL is reasonable: 60s with 30s renewal (Section 10.2)
- [ ] **FAIL**: Renewal and release not atomic (SEC-C2)

### Audit Trail

- [x] 8 audit actions specified (Section 7.6)
- [x] Events sanitized -- no secret values, no full artifact content (Section 7.6)
- [x] MODULE_DELETE_BLOCKED included for security monitoring (Section 7.6)

### Error Responses

- [x] Standard `{ success, error: { code, message } }` envelope (Section 7.5, 9.2, 10.3)
- [x] Diagnostics truncated to first 10 errors (Section 5.1)
- [x] No stack traces in error responses (verified throughout)
- [x] Cross-tenant 404 not 403 (Section 11.3)

### Express Route Ordering

- [x] Static routes before parameterized addressed (Section 11.4)
- [ ] **FAIL**: Example uses wrong terminology and wrong API pattern (SEC-M8)

---

## OWASP Top 10 Assessment

| OWASP Category                 | Status    | Notes                                                                                                |
| ------------------------------ | --------- | ---------------------------------------------------------------------------------------------------- |
| A01: Broken Access Control     | NEEDS FIX | SEC-C1 (cascade tenantId), SEC-C5 (imported tool auth scope)                                         |
| A02: Cryptographic Failures    | OK        | SHA-256 for hashing, gzip for compression (not encryption), secrets properly excluded from artifacts |
| A03: Injection                 | NEEDS FIX | SEC-C4 (configOverrides values not sanitized for template injection)                                 |
| A04: Insecure Design           | OK        | Two-step import, fail-closed gates, optimistic concurrency all well-designed                         |
| A05: Security Misconfiguration | NEEDS FIX | SEC-M4 (parallel feature gate implementations risk divergence)                                       |
| A06: Vulnerable Components     | OK        | Uses existing platform libraries, no new external dependencies                                       |
| A07: Auth Failures             | OK        | Uses existing `withRouteHandler` auth chain, 4 new permissions properly mapped to roles              |
| A08: Data Integrity Failures   | NEEDS FIX | SEC-C2 (lock race), SEC-H2 (version counter TOCTOU), SEC-M6 (no payload integrity check)             |
| A09: Logging Failures          | NEEDS FIX | SEC-H4 (invalid TraceEventType silently dropped)                                                     |
| A10: SSRF                      | OK        | Module tools use `auth_profile_ref` indirection; publish safety checks URL patterns                  |

---

## NOTES

### Positive Security Observations

1. **Publish safety is two-tier** (structural + pattern-based) -- this is defense-in-depth done right.
2. **Fail-closed feature gating** for new module operations is correct. The LLD explicitly calls out that the existing `requireFeature()` fails open and specifies fail-closed for modules.
3. **The two-step import flow** (preview + confirm) with captured `resolvedReleaseId` prevents pointer drift attacks.
4. **insertOne + catch E11000** for publish deduplication avoids the classic check-then-write race.
5. **Cross-tenant 404** semantics are consistently specified throughout the LLD.
6. **configOverrides reject secret keys** by checking `isSecret: true` in the contract.
7. **Module artifacts strip `variableNamespaceIds`** -- this prevents source project namespace leakage.

### Implementation Warnings

1. **Compressed payload size**: The 8 MB uncompressed limit is checked before compression, but the compressed payload is stored as a BSON `Buffer`. MongoDB has a 16 MB document size limit. With 5 modules at the limit, the uncompressed total could be 40 MB, but each snapshot is per-deployment (not per-module), so the 8 MB cap applies to the total. Verify the compressed size stays well under 16 MB.

2. **Alias rewrite performance**: `deepRewriteIR()` uses `structuredClone()` which is O(n) in IR size. With 5 modules and complex agents, this could be slow. Consider benchmarking and adding a latency trace event.

3. **`setInterval` for lock renewal**: The renewal timer in Section 10.2 uses `setInterval`. If the deployment build throws before `release()` is called, the interval is never cleared. Wrap the build in a `try/finally` that calls `release()` (which clears the interval). The LLD should specify this pattern explicitly.

4. **Feature cache in Studio**: The 60-second SWR cache for feature flags (Section 9.3) means a tenant could see module UI for up to 60 seconds after the feature is disabled. For security-sensitive flags, this is acceptable but should be documented.

5. **The `ResolvedAgent` interface** at `apps/runtime/src/services/deployment-resolver.ts:55-64` has no `moduleProvenance` field. The LLD adds `_moduleProvenance` to individual `AgentIR` objects inside the `agents` record, which is a property injection on a compiler type. Consider whether this should be a separate field on `ResolvedAgent` instead (e.g., `moduleProvenance: Record<string, ModuleProvenance>`) to avoid modifying compiler types.

6. **`SessionData` has no `moduleProvenance` field** at `apps/runtime/src/services/session/types.ts:20-96`. The LLD Section 6.2 specifies adding it, but this is a change to a widely-used serializable type. Ensure backward compatibility -- existing sessions serialized without this field must deserialize cleanly (the `?` optional marker handles this, but verify).

---

## Summary

5 CRITICAL, 5 HIGH, 8 MEDIUM findings. The most urgent issues are:

1. **SEC-C1 + SEC-H1**: Cascade delete tenant isolation gap (pre-existing but worsened by new entities)
2. **SEC-C2**: Redis lock race conditions (Lua scripts required)
3. **SEC-C3**: Soft-delete silently fails (missing Project model fields)
4. **SEC-C4**: configOverrides injection risk
5. **SEC-C5**: Imported tool auth resolves in wrong project scope

The LLD is architecturally sound but needs these security fixes before implementation begins. Most fixes are specification-level changes (adding validation, using atomic operations, adding model fields) that do not require redesign.
