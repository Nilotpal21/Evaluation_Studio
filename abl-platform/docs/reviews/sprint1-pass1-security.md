# Sprint 1 — Pass 1: Security Review

**Reviewer:** LLD Reviewer Agent (Security Pass)
**Date:** 2026-03-22
**Scope:** All 13 Sprint 1 implementation files
**LLD Reference:** `docs/specs/reusable-agent-modules-phase1.lld.md` Section 11

---

## Summary

**VERDICT: APPROVED_WITH_RESERVATIONS**

Sprint 1 implementation has strong tenant isolation fundamentals (all 4 new models use `tenantIsolationPlugin`, cascade deletes scope by `tenantId`). However, there are 2 HIGH findings and 5 MEDIUM findings that should be addressed before Sprint 2 implementation begins.

**Reviewed Files:**

| #   | File                                                               | Status           |
| --- | ------------------------------------------------------------------ | ---------------- |
| 1   | `packages/database/src/models/module-release.model.ts`             | PASS             |
| 2   | `packages/database/src/models/module-environment-pointer.model.ts` | PASS             |
| 3   | `packages/database/src/models/project-module-dependency.model.ts`  | PASS             |
| 4   | `packages/database/src/models/deployment-module-snapshot.model.ts` | PASS w/ notes    |
| 5   | `packages/database/src/models/project.model.ts`                    | PASS             |
| 6   | `packages/database/src/cascade/cascade-delete.ts`                  | PASS w/ findings |
| 7   | `apps/runtime/src/services/modules/types.ts`                       | PASS             |
| 8   | `packages/shared-kernel/src/types/trace-event.ts`                  | PASS             |
| 9   | `packages/project-io/src/module-release/build-module-release.ts`   | PASS w/ findings |
| 10  | `packages/project-io/src/module-release/source-hash.ts`            | PASS w/ notes    |
| 11  | `packages/project-io/src/module-release/module-contract.ts`        | PASS             |
| 12  | `packages/project-io/src/module-release/module-selector.ts`        | PASS             |
| 13  | `packages/project-io/src/module-release/module-publish-safety.ts`  | PASS w/ findings |

---

## Findings

### SEC-01 — HIGH: Runtime `cascadeDeleteProject` does not pass `tenantId`

**File:** `apps/runtime/src/repos/cascade-repo.ts:106`
**OWASP:** A01:2021 - Broken Access Control

The runtime's `cascadeDeleteProject(projectId, actor)` calls `deleteProject(projectId)` without a `tenantId` argument. The `deleteProject` function (cascade-delete.ts:181) accepts `tenantId?` as optional and falls back to resolving it from the Project document at line 216-218.

This is safe **only** because the `tenantIsolationPlugin` injects `tenantId` via ALS context on the `Project.find()` call at line 216. However:

1. If the runtime caller runs outside ALS context (e.g., a background job, admin endpoint, or test runner), `tenantId` resolves to `undefined` and the module-specific Path A/B code at lines 222-269 is **completely skipped** (both `if` blocks require `projectTenantId` to be truthy).
2. The standard cascade at lines 272-336 then proceeds with `projectId`-only scoped deletes, which are NOT tenant-isolated for models like `Session.deleteMany({ projectId })`.

**Impact:** If `deleteProject` is called without tenantId in a context where ALS is not set, module cascade paths are silently skipped and some deletes lack tenant scoping.

**Recommended Fix:**

```ts
// cascade-repo.ts — pass tenantId explicitly
export async function cascadeDeleteProject(
  projectId: string,
  tenantId: string, // <-- make required
  actor: string,
): Promise<CascadeDeleteResult> {
  const result = await deleteProject(projectId, tenantId);
  // ...
}
```

Update all callers to provide tenantId. The LLD already calls for this at Section 2: "requires `deleteProject` signature extension" (line 1708 of LLD).

---

### SEC-02 — HIGH: `CascadeDeleteBlockedError` exposes consumer project IDs

**File:** `packages/database/src/cascade/cascade-delete.ts:26-37`
**OWASP:** A01:2021 - Broken Access Control (information disclosure)

The `CascadeDeleteBlockedError` stores and exposes `consumerProjectIds: string[]` — the actual internal `_id` values of projects belonging to other users within the same tenant. When this error propagates to an HTTP response:

1. The error message includes the count: `"Cannot delete module project: 2 consumer project(s) depend on it"` — this is fine.
2. But if the route handler serializes the full error object (or the `consumerProjectIds` property), it leaks project IDs that the requesting user may not have permission to see.

**Impact:** A module project owner who attempts deletion learns the internal IDs of all consumer projects, even those they don't have access to. This aids enumeration attacks within a tenant.

**Recommended Fix:**
The error class itself is fine for internal use (cascade logic needs the IDs). The fix belongs in the route handler that catches this error:

```ts
// Route handler — NEVER expose consumerProjectIds to the client
if (err instanceof CascadeDeleteBlockedError) {
  return res.status(409).json({
    success: false,
    error: {
      code: 'MODULE_DELETE_BLOCKED',
      message: `Cannot delete: ${err.consumerProjectIds.length} consumer project(s) depend on this module.`,
      // Do NOT include err.consumerProjectIds
    },
  });
}
```

Add an implementation note to the LLD for Sprint 2 route handlers: "When catching `CascadeDeleteBlockedError`, return only the count, not the project IDs."

---

### SEC-03 — MEDIUM: `stripVariableNamespaceIds` does not handle `__proto__` / prototype pollution keys

**File:** `packages/project-io/src/module-release/build-module-release.ts:244-263`
**OWASP:** A03:2021 - Injection

The `stripVariableNamespaceIds` function iterates `Object.entries(obj)` and copies keys into a new `{}` object. If the input IR contains keys like `__proto__`, `constructor`, or `prototype`, these are copied through to the result. Since the IR comes from the compiler (trusted), this is low-risk in practice. However, the function creates a new `Record<string, unknown>` via `{}` literal — `Object.entries()` does NOT enumerate `__proto__` as an own property, so this is actually safe against the common prototype pollution vector.

**Residual concern:** The function does NOT strip `Date` objects, `Buffer` instances, or other non-plain-object values — it only recurses into `typeof value === 'object'`. The `!Array.isArray(value)` guard correctly prevents double-processing, but the array branch does not recurse into nested arrays (arrays-of-arrays).

**Impact:** If the compiled IR ever contains `variableNamespaceIds` inside a nested array structure like `[[{ variableNamespaceIds: [...] }]]`, the inner array would not be recursed into. Current IR schema does not have arrays-of-arrays, so this is theoretical.

**Recommended Fix:** Low priority. Add a comment documenting the assumption that IR does not contain nested arrays of objects, or add the recursive case:

```ts
// In the array branch:
result[key] = value.map((item) => {
  if (Array.isArray(item)) {
    // Recurse into nested arrays (defensive)
    return item.map((subItem) =>
      subItem && typeof subItem === 'object' && !Array.isArray(subItem)
        ? stripVariableNamespaceIds(subItem as Record<string, unknown>)
        : subItem,
    );
  }
  if (item && typeof item === 'object') {
    return stripVariableNamespaceIds(item as Record<string, unknown>);
  }
  return item;
});
```

---

### SEC-04 — MEDIUM: Source hash truncation to 16 hex chars provides only 64 bits of collision resistance

**File:** `packages/project-io/src/module-release/source-hash.ts:34`
**OWASP:** n/a (integrity, not access control)

`computeModuleSourceHash` computes SHA-256 (256 bits) but truncates to 16 hex characters (64 bits). The hash is used for:

1. Deduplication detection (LLD Decision 2c) — checking if a new publish is identical to a previous one
2. Per-agent/per-tool `sourceHash` in the artifact (build-module-release.ts:153, 169)
3. `snapshotHash` in DeploymentModuleSnapshot

At 64 bits, the birthday-bound collision probability reaches 1% at ~6.1 billion hashes. For deduplication within a single tenant's module project, this is practically safe. However:

- If the hash is ever used as a content-addressable identifier across tenants (e.g., a global deduplication cache), the collision space is concerning.
- The LLD Section 1.2 describes the hash as part of a unique constraint `{ tenantId, moduleProjectId, version }`, so collisions in `sourceHash` alone don't cause data corruption — they only produce false positives in the "already published" deduplication check.

**Impact:** False positive "already published" detection at ~1 in 6 billion publishes per project. Not security-critical.

**Recommended Fix:** Acceptable for Phase 1. If the hash is later used as a content-addressable identifier, increase to 32 hex chars (128 bits). Add a comment documenting the design choice:

```ts
// 16 hex chars = 64 bits. Sufficient for per-project deduplication.
// Not intended as a cryptographic content address.
```

---

### SEC-05 — MEDIUM: `compiledIR` and `contract` stored as `Schema.Types.Mixed` without size validation

**File:** `packages/database/src/models/module-release.model.ts:72-74`
**OWASP:** A04:2021 - Insecure Design

The `ModuleRelease` model stores `artifact`, `compiledIR`, and `contract` as `Schema.Types.Mixed`. These accept arbitrary JSON of any size. The LLD specifies an 8 MB limit for deployment snapshots (Section 1.5), but no corresponding limit for ModuleRelease documents.

A module with many agents and tools could produce a very large `compiledIR` object. MongoDB's BSON document limit is 16 MB, which provides a hard ceiling, but:

1. No application-level size validation exists in the builder
2. Large documents degrade query performance (especially for `ModuleRelease.findOne()` in the selector)

**Impact:** A pathological module (e.g., 100+ agents) could create multi-MB release documents that slow catalog queries and consume excess storage.

**Recommended Fix:** Add size validation in `buildModuleRelease()` after the build completes:

```ts
const serializedSize = Buffer.byteLength(
  JSON.stringify({ artifact, compiledIR, contract }),
  'utf8',
);
if (serializedSize > 8 * 1024 * 1024) {
  return { success: false, errors: ['Module release exceeds 8 MB size limit'], warnings };
}
```

---

### SEC-06 — MEDIUM: `compressedPayload: Buffer` has no size limit at the model layer

**File:** `packages/database/src/models/deployment-module-snapshot.model.ts:22`
**OWASP:** A04:2021 - Insecure Design

The `DeploymentModuleSnapshot` stores `compressedPayload: Buffer` with no size validation at the schema level. The LLD specifies an 8 MB limit (Section 1.5) but this limit must be enforced in the deployment build service (Sprint 2 scope).

`Buffer` stored in MongoDB via the `Buffer` SchemaType becomes BSON `BinData`. The 16 MB BSON limit applies, but 8 MB of gzip-compressed data could represent 50+ MB of uncompressed JSON, creating a decompression bomb risk at runtime.

**Impact:** If the build service does not enforce the 8 MB limit, a malicious or pathological deployment could store oversized snapshots. At read time, decompressing an unexpectedly large buffer could cause OOM.

**Recommended Fix:** This is a Sprint 2 implementation concern, but add a defensive check in the model or a comment:

```ts
// SECURITY: compressedPayload must be validated at creation time.
// Maximum: 8 MB compressed (enforced in deployment-build-service.ts).
// Decompression must also enforce a limit (see SEC-06 in sprint1-pass1-security.md).
compressedPayload: { type: Buffer, required: true },
```

---

### SEC-07 — MEDIUM: Publish safety `BASE64_RE` has high false-positive rate on DSL content

**File:** `packages/project-io/src/module-release/module-publish-safety.ts:55`
**OWASP:** n/a (usability, not security)

The `BASE64_RE` pattern `/[A-Za-z0-9+/=]{20,}/g` matches any alphanumeric string of 20+ characters. This will match:

- Normal English words and sentences without spaces
- URL paths (e.g., `/api/v1/agents/myAgentName`)
- Agent and tool names that are 20+ characters
- Template content like `{{config.SOME_LONG_KEY_NAME}}`

The `looksLikeEncodedSecret` heuristic (line 282) helps filter — it checks Base64 validity and printable ASCII ratio. But many DSL strings are valid Base64 that decode to printable ASCII. The severity is only `warning` (not blocking), which limits impact.

**Impact:** Module publishers may see false-positive Base64 warnings that create alert fatigue, causing them to ignore real warnings.

**Recommended Fix:** Add exemptions for known safe patterns before the Base64 check:

```ts
// Skip if the match is inside a known safe pattern (URLs, template refs, agent/tool names)
if (/^[A-Za-z_][\w]*$/.test(value)) continue; // identifiers
if (value.includes('/')) continue; // URL paths
```

Or increase the minimum length threshold from 20 to 40 characters.

---

## Verified Security Controls

### Tenant Isolation — PASS

All 4 new models apply `tenantIsolationPlugin`:

- `ModuleRelease` (line 85) — `tenantIsolationPlugin`
- `ModuleEnvironmentPointer` (line 47) — `tenantIsolationPlugin`
- `ProjectModuleDependency` (line 68) — `tenantIsolationPlugin`
- `DeploymentModuleSnapshot` (line 43) — `tenantIsolationPlugin`

The plugin (verified at `packages/database/src/mongo/plugins/tenant-isolation.plugin.ts`) automatically injects `tenantId` on all read/write operations via ALS context. Cross-tenant writes throw `Tenant isolation violation` errors.

All indexes include `tenantId` as the leading key, preventing cross-tenant query scanning.

### Cascade Delete Tenant Scoping — PASS

`deleteTenant()` (cascade-delete.ts:43-165): All 4 new module collections are deleted with `{ tenantId }` scope:

- `DeploymentModuleSnapshot.deleteMany({ tenantId })` (line 107)
- `ProjectModuleDependency.deleteMany({ tenantId })` (line 110)
- `ModuleEnvironmentPointer.deleteMany({ tenantId })` (line 113)
- `ModuleRelease.deleteMany({ tenantId })` (line 115)

Deletion order respects foreign key dependencies: snapshots -> dependencies -> pointers -> releases.

`deleteProject()` Path A (module project): Scopes to `{ tenantId, moduleProjectId }` (lines 239, 245).
`deleteProject()` Path B (consumer project): Scopes to `{ tenantId, projectId }` (lines 258, 263).
`softDeleteModuleProject()`: Scopes to `{ _id, tenantId }` and `{ tenantId, moduleProjectId }` (lines 361, 367).

### Secret Detection — PASS

`module-publish-safety.ts` covers the required patterns from LLD Section 11.1:

- PEM private keys (line 61) — `-----BEGIN.*PRIVATE KEY-----`
- URL-embedded API keys (line 58) — `api_key|apikey|key|token|secret|access_token|auth`
- Bearer/Basic tokens (line 64-65) — `Bearer`, `Basic`, `sk-`, `pk_`
- Base64 secrets (line 55) — 20+ char strings with ASCII decode heuristic
- Non-templated auth headers (lines 188-208) — `Authorization`, `X-Api-Key`, `X-Auth-Token`, `Api-Key`

### Template Injection — PASS (addressed in LLD)

The LLD Section 11.2 specifies the template injection check uses `/\{\{/` (not `/\{\{.*?\}\}/`), which is resistant to the newline bypass identified in prior review Pass 3 (SEC-03 from `review_modules_pass3_security.md`). The `validateConfigOverrides` function shown in the LLD correctly uses `/\{\{/.test(value)` at line 1585.

Note: `validateConfigOverrides` is Sprint 2 scope (route handler implementation) — not yet implemented.

### Source-Project Identifier Detection — PASS

`module-publish-safety.ts` detects:

- `variableNamespaceId` references (line 83, 341-349) — severity: blocking
- Raw `_id` references with 24+ hex chars (line 86, 353-362) — severity: warning
- `projectId` references with 24+ hex chars (line 89, 365-374) — severity: warning

`build-module-release.ts` strips `variableNamespaceIds` keys recursively (line 149, function at 244-263).

### Module Selector Tenant Isolation — PASS

`module-selector.ts` `resolveSelector()`:

- Version lookup: `ModuleRelease.findOne({ tenantId, moduleProjectId, version, archivedAt: null })` (line 32-37)
- Environment lookup: `ModuleEnvironmentPointer.findOne({ tenantId, moduleProjectId, environment })` (line 43-46)
- Release verification: `ModuleRelease.findOne({ _id, tenantId, archivedAt: null })` (line 53-56)

All queries include `tenantId`. Cross-tenant access returns null (mapped to error message), not 403. Archived releases are excluded.

### Optimistic Concurrency — PASS (design level)

`ModuleEnvironmentPointer` has a `revision` field (line 20) that the LLD specifies for TOCTOU-safe updates. The actual `findOneAndUpdate({ revision: expectedRevision })` pattern will be implemented in Sprint 2 route handlers. The model correctly marks `revision` as `required: true, default: 1`.

### Project Model Extension — PASS

`project.model.ts` correctly adds `archivedAt` and `archivedBy` to the Mongoose schema (lines 62-69), preventing the silent-drop issue with `strict: true` mode identified in prior review (review_modules_phase1_security.md finding #3). Both fields use `default: null`.

`kind` field uses `enum: ['application', 'module']` (line 49) preventing arbitrary values.

### Shared Types — PASS

`apps/runtime/src/services/modules/types.ts`: Module provenance types are clean — no database queries, no auth logic, just type definitions. `moduleProjectId` is included for tracing but never used for authorization decisions at the type level.

`packages/shared-kernel/src/types/trace-event.ts`: `tool_auth_resolved` added to the `TraceEventType` union (line 28). Module provenance fields (`moduleAlias`, `moduleProjectId`, `moduleReleaseId`, `sourceAgentName`) are optional on `TraceEvent` (lines 43-50), which is correct — they should only be present on module-originated events.

---

## Summary Table

| ID     | Severity | File                                                               | Line(s) | Category                | Status                           |
| ------ | -------- | ------------------------------------------------------------------ | ------- | ----------------------- | -------------------------------- |
| SEC-01 | HIGH     | `apps/runtime/src/repos/cascade-repo.ts`                           | 106     | Broken Access Control   | Fix before Sprint 2              |
| SEC-02 | HIGH     | `packages/database/src/cascade/cascade-delete.ts`                  | 26-37   | Information Disclosure  | Implementation note for Sprint 2 |
| SEC-03 | MEDIUM   | `packages/project-io/src/module-release/build-module-release.ts`   | 244-263 | Injection (theoretical) | Low priority                     |
| SEC-04 | MEDIUM   | `packages/project-io/src/module-release/source-hash.ts`            | 34      | Integrity               | Acceptable, add comment          |
| SEC-05 | MEDIUM   | `packages/database/src/models/module-release.model.ts`             | 72-74   | Insecure Design         | Add size check in builder        |
| SEC-06 | MEDIUM   | `packages/database/src/models/deployment-module-snapshot.model.ts` | 22      | Insecure Design         | Sprint 2 enforcement             |
| SEC-07 | MEDIUM   | `packages/project-io/src/module-release/module-publish-safety.ts`  | 55      | Usability               | Reduce false positives           |

---

## Checklist

- [x] Tenant isolation: All 4 new models use `tenantIsolationPlugin`, all queries include `tenantId`
- [x] Secret leakage prevention: PEM, Bearer, Base64, URL-embedded keys, secret prefixes all detected
- [x] Template injection: LLD specifies `/\{\{/` pattern (not full match) — newline-bypass resistant
- [x] variableNamespaceIds stripping: Recursive function handles nested objects and arrays of objects
- [x] Source-project identifier leakage: `_id`, `projectId`, `variableNamespaceId` all detected
- [x] Hash security: SHA-256 used, 16 hex chars sufficient for per-project deduplication (see SEC-04)
- [x] Cascade delete safety: Tenant-scoped deletes prevent cross-tenant cascade (see SEC-01 for runtime caller gap)
- [x] Buffer handling: `compressedPayload: Buffer` stored as BSON BinData, no injection risk (see SEC-06 for size)
- [x] CascadeDeleteBlockedError: Exposes internal IDs — route handler must not serialize them (see SEC-02)
- [x] Optimistic concurrency: `revision` field present, TOCTOU prevention deferred to Sprint 2 route implementation
