# Sprint 1 — Pass 3: Security Review

**Reviewer:** LLD Reviewer Agent (Security Pass)
**Date:** 2026-03-22
**Scope:** All Sprint 1 implementation files (models, cascade-delete, project-io/module-release/\*, runtime types, trace-event) vs. LLD Section 11 (Security)

---

## VERDICT: APPROVED_WITH_RESERVATIONS

The implementation addresses the majority of security requirements from the LLD. Tenant isolation is structurally enforced via the `tenantIsolationPlugin` on all new models. The publish safety validator is comprehensive with two-tier secret detection. The cascade delete logic properly gates module deletion on consumer dependency checks. However, several gaps remain — most notably a missing implementation for `validateConfigOverrides`, a pre-existing `deleteProject` call site that bypasses tenant scoping, and the absence of decompression bomb limits on the snapshot payload.

---

## ISSUES

### CRITICAL

#### S3-C1: `validateConfigOverrides` not implemented — template injection vector open

**OWASP:** A03:2021 Injection
**LLD Section:** 11.2
**File:** Not yet created — only exists as pseudocode in LLD spec lines 1549-1597

The LLD specifies a `validateConfigOverrides` function that rejects `{{` template syntax in config override values, enforces 50-key/1KB-per-value limits, blocks secret keys, and strips control characters. **This function does not exist anywhere in the codebase.** The `configOverrides` field on `ProjectModuleDependency` is typed as `Record<string, string>` with `Schema.Types.Mixed` and no validation.

Without this function, an attacker can store arbitrary template syntax (`{{env.SECRET_KEY}}`, `{{config.ADMIN_TOKEN}}`) in config override values. When these values are interpolated into module tool templates at runtime, they resolve to the consumer project's secret environment variables — a server-side template injection (SSTI) that leaks secrets cross-module.

**Impact:** Secret exfiltration via template injection in config overrides.
**Fix:** Implement `validateConfigOverrides` as specified in LLD 11.2. Wire it as a blocking validation in the dependency create/update route handler (POST `/api/projects/[id]/module-dependencies`). This is a Phase 1 requirement, not a future enhancement.

---

#### S3-C2: Pre-existing `deleteProject` call in runtime lacks tenantId — cascade bypass

**OWASP:** A01:2021 Broken Access Control
**File:** `apps/runtime/src/repos/cascade-repo.ts:106`

```ts
const result = await deleteProject(projectId);
```

The `deleteProject` function signature is `deleteProject(projectId: string, tenantId?: string)`. When `tenantId` is omitted (as in this call site), the function falls through to `{ _id: projectId }` — no tenant scoping on the initial project lookup (line 222). This means the Path A module deletion guard (`countDocuments({ tenantId: projectTenantId, moduleProjectId })`) uses the project's own tenantId fetched without isolation, which is correct only if the caller already verified ownership.

While the `tenantIsolationPlugin` would inject tenant context from ALS if present, the runtime's cascade-repo is called from admin/cleanup contexts that may not have ALS tenant context set. This is a **pre-existing issue** not introduced by Sprint 1, but Sprint 1 widened its blast radius by adding module-specific cascade paths (Path A/B) that assume `projectTenantId` is trustworthy.

**Impact:** A cascade delete triggered without ALS context could delete module entities belonging to the wrong tenant.
**Fix:** Change `cascade-repo.ts:106` to pass `tenantId` explicitly from the request context. This was already flagged in prior reviews (memory: `review_modules_phase1_security.md` item 1) and the LLD added `tenantId?` as an optional param, but the existing call site was not updated.

---

### HIGH

#### S3-H1: No decompression bomb limit on `gunzipSync` at session bootstrap

**OWASP:** A05:2021 Security Misconfiguration
**LLD Section:** 5.1 (step 11 specifies "validate payload size < 8 MB uncompressed")
**File (LLD):** `apps/runtime/src/services/deployment-resolver.ts` — runtime merge code

The LLD specifies validating uncompressed payload size < 8 MB at build time but the runtime decompression path (`zlib.gunzipSync(moduleSnapshot.compressedPayload)`) has no size guard. A maliciously crafted `compressedPayload` could decompress to hundreds of megabytes, causing OOM on the runtime pod.

The build-time validation (step 11) only protects the happy path. If a snapshot is crafted or corrupted (e.g., direct DB write by an admin tool), the runtime is the last line of defense.

**Impact:** Denial of service via decompression bomb at session bootstrap.
**Fix:** Use `zlib.gunzipSync` with `maxOutputLength` option (Node.js 14+):

```ts
const MAX_SNAPSHOT_SIZE = 8 * 1024 * 1024; // 8 MB
const decompressed = zlib.gunzipSync(moduleSnapshot.compressedPayload, {
  maxOutputLength: MAX_SNAPSHOT_SIZE,
});
```

---

#### S3-H2: Source hash truncated to 16 hex chars (64 bits) — collision risk for deduplication

**OWASP:** A02:2021 Cryptographic Failures
**File:** `packages/project-io/src/module-release/source-hash.ts:34`

```ts
return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
```

The `sourceHash` is used for deduplication detection (LLD Decision 2c). At 64 bits, the birthday bound puts the collision probability at 50% after ~2^32 (4 billion) releases — unlikely in absolute terms but the hash is also used as per-agent individual hashes (`build-module-release.ts:161`) which are stored alongside artifact data and could mislead diffing/caching logic.

More concerning: if `sourceHash` is ever promoted to a uniqueness constraint or used as a content-addressable key (natural evolution for a release deduplication feature), 64 bits is insufficient. SHA-256 truncated to 32 hex chars (128 bits) provides birthday resistance to ~2^64.

**Impact:** Low probability of accidental collision, but the truncation is aggressive for a deduplication hash. If dedup is enforced rather than advisory, this becomes a correctness issue.
**Fix:** Increase truncation to at least 32 hex chars (128 bits). The storage cost is negligible (16 extra bytes per release).

---

#### S3-H3: `CascadeDeleteBlockedError.consumerProjectIds` leaks cross-project IDs

**OWASP:** A01:2021 Broken Access Control
**File:** `packages/database/src/cascade/cascade-delete.ts:28-41`

The error class stores `consumerProjectIds` as a public readonly array. The JSDoc warns "Do NOT serialize this to HTTP responses — it leaks other projects' IDs", and the code limits to 100 IDs. However, the property is `public` — any route handler catching this error can access `err.consumerProjectIds` and could inadvertently include it in error responses, logs, or audit events.

The LLD specifies returning only the count, not the IDs. The comment-only guard is fragile.

**Impact:** Information disclosure of other projects' IDs if a future handler serializes the error.
**Fix:** Consider making `consumerProjectIds` private or storing only the count on the error. If the IDs are needed internally (e.g., for logging), expose them via a method that requires explicit opt-in rather than a public field.

---

### MEDIUM

#### S3-M1: `tenantId` leakage warning (not blocking) for DSL artifacts

**OWASP:** A01:2021 Broken Access Control
**File:** `packages/project-io/src/module-release/module-publish-safety.ts:380-389`

The `SOURCE_TENANT_ID` check emits a **warning**, not a blocking error. A module release containing a literal `tenantId = "abc-123-..."` in its DSL would be published with just a warning, potentially leaking the publishing tenant's identity to all consumers within the same tenant scope.

While cross-tenant visibility is already prevented by query-level isolation, the tenant ID itself is sensitive metadata that should not be embedded in portable artifacts.

**Impact:** Tenant identity leakage in published module artifacts.
**Fix:** Elevate `SOURCE_TENANT_ID` from warning to blocking severity, or at minimum ensure the `stripVariableNamespaceIds` recursive walker also strips `tenantId` fields from compiled IR (currently it only strips `variableNamespaceIds`).

---

#### S3-M2: `BASE64_RE` pattern is overly broad — false positives on DSL content

**OWASP:** N/A (false positive risk, not a vulnerability)
**File:** `packages/project-io/src/module-release/module-publish-safety.ts:55`

```ts
const BASE64_RE = /[A-Za-z0-9+/=]{20,}/g;
```

This regex matches any 20+ character alphanumeric string, which commonly occurs in DSL content (long identifier names, UUIDs, description text). The `looksLikeEncodedSecret` heuristic helps but still produces false positives on UUIDs and long kebab-case names joined without hyphens.

Since this is a `warning` severity, it won't block publishing, but excessive false positive warnings erode trust in the safety validator and may cause publishers to ignore legitimate warnings.

**Impact:** Warning fatigue from false positives.
**Fix:** Add exclusions for common patterns (UUIDs, SHA hashes, known DSL keywords > 20 chars) before the `looksLikeEncodedSecret` check. Or increase the threshold to 32+ chars.

---

#### S3-M3: `configOverrides` stored as `Schema.Types.Mixed` with no schema validation

**OWASP:** A03:2021 Injection
**File:** `packages/database/src/models/project-module-dependency.model.ts:59`

```ts
configOverrides: { type: Schema.Types.Mixed, default: {} },
```

`Schema.Types.Mixed` accepts any JSON value, not just `Record<string, string>`. A caller could store nested objects, arrays, numbers, or other types that the TypeScript interface does not represent. While the TS type says `Record<string, string>`, MongoDB does not enforce this.

Combined with the missing `validateConfigOverrides` (S3-C1), this means there is zero runtime validation on what goes into this field.

**Impact:** Schema-type mismatch allows non-string values to bypass string-level checks even after `validateConfigOverrides` is implemented (if it only validates string values).
**Fix:** When implementing `validateConfigOverrides`, add an explicit check that every value in `configOverrides` is a string: `typeof value === 'string'`. Alternatively, define a Mongoose schema with `Map` type (`{ type: Map, of: String }`).

---

#### S3-M4: `setInterval` timer leak in lock renewal on exception path

**OWASP:** A05:2021 Security Misconfiguration
**LLD Section:** 10.2 (lines 1452-1455)

The LLD's `acquireDeployLock` specification starts a `setInterval` for lock renewal. If the deployment build throws before calling `release()`, the interval timer continues running, preventing Node.js from garbage-collecting the closure and keeping the lock key alive longer than intended.

The LLD does not specify that callers MUST use `try/finally` with the lock's `release()`. This was flagged in Pass 3 of the prior review cycle (memory: `review_modules_pass3_security.md` item 5) but the LLD still does not mandate it.

**Impact:** Resource leak (timer + Redis key) on deployment build failures.
**Fix:** Add to LLD Section 10.2: "Callers MUST invoke `release()` in a `finally` block. The lock implementation SHOULD additionally include a `renewalTimer.unref()` call so that leaked timers do not prevent graceful shutdown."

---

#### S3-M5: `contractSnapshot` stored as `Schema.Types.Mixed` — no immutability enforcement

**OWASP:** A04:2021 Insecure Design
**File:** `packages/database/src/models/project-module-dependency.model.ts:59`

The `contractSnapshot` is denormalized from the `ModuleRelease.contract` at import time. It is stored as `Mixed`, meaning any code with write access to the collection can mutate it without validation. If a handler inadvertently updates the snapshot (e.g., in a bulk update that touches the whole document), the contract becomes inconsistent with the release it was snapshotted from.

**Impact:** Silent contract corruption could hide breaking changes during dependency updates.
**Fix:** Document as an implementation note that `contractSnapshot` must never be updated after creation. Consider using a Mongoose middleware `pre('findOneAndUpdate')` that strips `contractSnapshot` from `$set` operations, or mark it as immutable in the schema: `{ type: Schema.Types.Mixed, required: true, immutable: true }`.

---

### LOW

#### S3-L1: Missing `tool_auth_resolved` trace event in `TraceEventType` union is incomplete for module provenance

**OWASP:** N/A (observability gap)
**File:** `packages/shared-kernel/src/types/trace-event.ts:28`

The `tool_auth_resolved` event type IS present in the union (line 28), but the LLD Section 6 specifies additional module-specific trace events that are NOT in the union:

- No `module_resolve` event for dependency resolution at build time
- No `module_merge` event for runtime agent/tool merge
- No `module_config_applied` event for config override application

These are specified in the LLD's Section 6.3 trace enrichment but only as field additions to existing trace types, not as dedicated event types. This is acceptable for Phase 1 but limits observability of module-specific failures.

**Impact:** Reduced debugging ability for module-specific issues.
**Fix:** Consider adding `module_resolve`, `module_merge`, `module_config_applied` to `TraceEventType` in a future sprint.

---

#### S3-L2: `ModuleRelease.compiledIR` typed as `Record<string, unknown>` loses type safety at boundary

**OWASP:** N/A (type safety gap)
**File:** `packages/database/src/models/module-release.model.ts:59`

The JSDoc explains this is intentional to avoid a compile-time dependency on `@abl/compiler`. However, the `unknown` typing means consumers must cast without validation. If a corrupted or tampered IR is stored, it propagates silently into the runtime merge path.

**Impact:** Corrupted IR in a release would not be caught until runtime execution failure.
**Fix:** Add a Zod schema or structural validation at the point where `compiledIR` is read from the database and cast to `AgentIR` (in the deployment build service). This is a runtime boundary and the appropriate place for validation.

---

## VERIFIED

- [x] **Tenant isolation** — All 4 new models (`ModuleRelease`, `ModuleEnvironmentPointer`, `ProjectModuleDependency`, `DeploymentModuleSnapshot`) apply `tenantIsolationPlugin`. All indexes include `tenantId` as the leading key. All queries in `module-selector.ts` include `tenantId` explicitly.
- [x] **Cross-tenant access returns 404** — `resolveSelector` returns generic error messages ("not found or archived", "no release promoted") that do not reveal whether the resource exists in another tenant.
- [x] **Soft-delete fields in schema** — `archivedAt` and `archivedBy` are present in both `project.model.ts` (lines 62-69) and `module-release.model.ts` (lines 83-84), resolving the prior finding about `strict: true` silently dropping unknown fields.
- [x] **Cascade delete tenant scoping** — `deleteTenant` deletes all 4 new entity types with `{ tenantId }` filter. `deleteProject` accepts optional `tenantId` and uses it when provided for both Path A and Path B module cleanup.
- [x] **Cascade delete consumer blocking** — `deleteProject` Path A correctly blocks deletion when `consumerDepCount > 0`, limiting consumer ID fetch to 100 documents.
- [x] **Publish safety: structural validation** — `validateHttpToolAuth` checks AUTH_CONFIG directives for non-templated literals and rejects them as blocking.
- [x] **Publish safety: secret pattern detection** — PEM keys, URL-embedded keys, Bearer/Basic/sk-/pk\_ prefixes are detected and flagged as blocking.
- [x] **Publish safety: source-project identifiers** — `variableNamespaceIds`, raw `_id`, `projectId`, and `tenantId` references are detected. `variableNamespaceIds` is blocking; others are warnings.
- [x] **IR namespace stripping** — `stripVariableNamespaceIds` recursively removes `variableNamespaceIds` from compiled IR before storing in artifact, preventing project-scoped identifiers from leaking into module releases.
- [x] **Redis lock uses Lua scripts** — LLD Section 10.2 specifies Lua scripts for both lock release (compare-and-delete) and renewal (compare-and-renew), resolving the prior finding about GET-then-EXPIRE race conditions.
- [x] **Optimistic concurrency on pointer promotion** — `ModuleEnvironmentPointer` uses `revision` counter with atomic `findOneAndUpdate` condition.
- [x] **Module provenance fields on TraceEvent** — `moduleAlias`, `moduleProjectId`, `moduleReleaseId`, `sourceAgentName` are added to the canonical `TraceEvent` interface.
- [x] **Auth profile resolution scope** — LLD Section 6.4 correctly specifies consumer `projectId` for auth resolution, not module source `projectId`.
- [x] **Error class design** — `CascadeDeleteBlockedError` has a specific `code` property and a message that includes only the count, not IDs.
- [x] **`tool_auth_resolved` in trace union** — Present at line 28 of `trace-event.ts`.
- [x] **Unique version constraint** — `ModuleRelease` index `{ tenantId, moduleProjectId, version }` is unique, preventing duplicate versions.
- [x] **LLD template injection fix** — LLD 11.2 correctly uses `/\{\{/` (not `/\{\{.*?\}\}/`) for template syntax rejection, addressing the newline bypass from prior review.

---

## NOTES

1. **S3-C1 is the most urgent gap.** Without `validateConfigOverrides`, the entire config override mechanism is an unguarded injection surface. This should be implemented before any route handler that writes `configOverrides` to `ProjectModuleDependency`.

2. **S3-C2 is pre-existing** but widened by Sprint 1. Consider fixing it as part of Sprint 1 since the cascade delete logic was already modified.

3. The **publish safety validator** (`module-publish-safety.ts`) is impressively thorough for a Phase 1 implementation. The two-tier approach (structural + pattern) with non-portable warnings provides good defense-in-depth.

4. The `tenantIsolationPlugin` provides strong defense-in-depth for all new models. Even if route-level tenant checks are missed, the plugin will inject tenant filters from ALS context. This significantly reduces the blast radius of any individual isolation gap.

5. **Watch during implementation:** When building the deployment build service (Section 5), ensure the gzip compression step includes a pre-compression size check (step 11: < 8 MB uncompressed) AND the decompression path includes `maxOutputLength`. Both sides need the guard.
