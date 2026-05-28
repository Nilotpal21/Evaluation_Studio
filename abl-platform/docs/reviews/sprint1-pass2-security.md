# Sprint 1 — Pass 2: Security Review

**Reviewer:** LLD Reviewer Agent (Security Pass 2 — Independent)
**Date:** 2026-03-22
**Scope:** All 13 Sprint 1 implementation files
**LLD Reference:** `docs/specs/reusable-agent-modules-phase1.lld.md` Section 11
**Prior Review:** Pass 1 findings are NOT referenced — this is an independent review.

---

## Summary

**VERDICT: APPROVED_WITH_RESERVATIONS**

Sprint 1 implementation has solid tenant isolation via the `tenantIsolationPlugin` and correctly implements cascade delete for both module and consumer project paths. The publish safety validator covers a broad range of secret patterns. However, 1 CRITICAL, 2 HIGH, and 4 MEDIUM findings need attention, mostly around DI safety bypass, identifier leakage gaps, and missing runtime decompression guards.

**Reviewed Files:**

| #   | File                                                               | Status           |
| --- | ------------------------------------------------------------------ | ---------------- |
| 1   | `packages/database/src/models/module-release.model.ts`             | PASS             |
| 2   | `packages/database/src/models/module-environment-pointer.model.ts` | PASS             |
| 3   | `packages/database/src/models/project-module-dependency.model.ts`  | PASS             |
| 4   | `packages/database/src/models/deployment-module-snapshot.model.ts` | PASS w/ findings |
| 5   | `packages/database/src/models/project.model.ts`                    | PASS             |
| 6   | `packages/database/src/cascade/cascade-delete.ts`                  | PASS w/ findings |
| 7   | `apps/runtime/src/services/modules/types.ts`                       | PASS             |
| 8   | `packages/shared-kernel/src/types/trace-event.ts`                  | PASS             |
| 9   | `packages/project-io/src/module-release/build-module-release.ts`   | PASS w/ findings |
| 10  | `packages/project-io/src/module-release/source-hash.ts`            | PASS             |
| 11  | `packages/project-io/src/module-release/module-contract.ts`        | PASS             |
| 12  | `packages/project-io/src/module-release/module-selector.ts`        | PASS w/ notes    |
| 13  | `packages/project-io/src/module-release/module-publish-safety.ts`  | PASS w/ findings |

---

## Findings

### P2-SEC-01 — CRITICAL: `validatePublishSafetyFn` is optional — callers can silently skip all secret detection

**File:** `packages/project-io/src/module-release/build-module-release.ts:107`
**OWASP:** A04:2021 - Insecure Design

The `buildModuleRelease` function signature declares `validatePublishSafetyFn` as an optional parameter:

```ts
export function buildModuleRelease(
  input: ModuleReleaseInput,
  compileFn: CompileFn,
  extractContractFn: ExtractContractFn,
  validatePublishSafetyFn?: ValidatePublishSafetyFn,  // <-- optional
): ModuleReleaseBuildResult {
```

At line 186, the entire publish safety validation block is guarded by `if (validatePublishSafetyFn)`. If the Sprint 2 route handler caller forgets to inject the validator, or passes `undefined` / `null`, all of the following security checks are silently bypassed:

- PEM private key detection
- URL-embedded API key detection
- Bearer/Basic/sk-/pk\_ token detection
- Literal auth value detection in HTTP tools
- `variableNamespaceId` blocking detection
- Source-project `_id` and `projectId` leakage warnings

The `extractContractFn` and `compileFn` are required parameters (non-optional), but the safety validator — arguably the most security-critical function — is the only optional one.

**Impact:** A single caller omission bypasses the entire security gate. Modules with hardcoded credentials could be published to tenant-wide visibility.

**Recommended Fix:**

```ts
// Make validatePublishSafetyFn REQUIRED:
export function buildModuleRelease(
  input: ModuleReleaseInput,
  compileFn: CompileFn,
  extractContractFn: ExtractContractFn,
  validatePublishSafetyFn: ValidatePublishSafetyFn,  // <-- no longer optional
): ModuleReleaseBuildResult {
```

If there are legitimate test-only callers that need to skip validation, provide a separate `buildModuleReleaseUnsafe()` function with a name that signals the risk, or require an explicit `{ skipSafetyValidation: true }` option object that must be deliberately passed.

---

### P2-SEC-02 — HIGH: `module-publish-safety.ts` does not detect `tenantId` leakage in DSL content

**File:** `packages/project-io/src/module-release/module-publish-safety.ts:333-375`
**OWASP:** A01:2021 - Broken Access Control (information disclosure)

The `checkSourceOnlyIdentifiers` function scans for three source-project-only patterns:

- `variableNamespaceId` references (line 342) — blocking
- Raw `_id` references (line 353, regex: `/_id\s*[:=]\s*['"]([a-f0-9-]{24,})['"]?/`) — warning
- `projectId` references (line 365, regex: `/projectId\s*[:=]\s*['"]([a-f0-9-]{24,})['"]?/`) — warning

However, there is no detection for `tenantId` leakage. If an agent or tool DSL contains a hardcoded `tenantId` reference (e.g., `tenantId: "abc-123-def-456"` in a tool's HTTP body template or custom header), this tenant identifier would be published in the module release artifact and made visible to all tenant members who can view the module.

More critically, if a module is later extended to support cross-tenant sharing (Phase 2+), hardcoded `tenantId` values in DSL content could be resolved in a different tenant's context, potentially causing data to route to the wrong tenant's infrastructure.

**Impact:** Tenant identifier leakage in published module artifacts. Low severity in Phase 1 (single-tenant module sharing), but becomes HIGH if cross-tenant sharing is added.

**Recommended Fix:**

Add a `tenantId` detection pattern alongside the existing `projectId` check:

```ts
/** tenantId references pointing to source tenant */
const TENANT_ID_RE = /tenantId\s*[:=]\s*['"]([a-f0-9-]{24,})['"]?/gi;

// In checkSourceOnlyIdentifiers:
const tenantIdRe = new RegExp(TENANT_ID_RE.source, TENANT_ID_RE.flags);
let tenantMatch: RegExpExecArray | null;
while ((tenantMatch = tenantIdRe.exec(content)) !== null) {
  issues.push({
    severity: 'warning',
    code: 'SOURCE_TENANT_ID',
    source,
    message: `${source} contains a tenantId reference "${tenantMatch[1].slice(0, 12)}..." pointing to the source tenant.`,
  });
}
```

---

### P2-SEC-03 — HIGH: `variableNamespaceIds` stripping operates only on compiled IR, not on raw DSL artifact

**File:** `packages/project-io/src/module-release/build-module-release.ts:156-162`
**OWASP:** A01:2021 - Broken Access Control (identifier leakage)

The `stripVariableNamespaceIds` function at line 157 recursively removes `variableNamespaceIds` keys from the **compiled IR**:

```ts
const strippedIR = stripVariableNamespaceIds(ir);
compiledIR[agentName] = strippedIR;
```

However, the raw DSL content stored in `artifact.agents[name].dslContent` (line 162) is preserved verbatim:

```ts
artifactAgents[agentName] = { dslContent, sourceHash: agentHash };
```

If the source DSL contains `variableNamespaceIds` as text (e.g., in a comment, in a YAML field, or in a tool configuration block that gets serialized), these identifiers survive into the published artifact.

The `module-publish-safety.ts` validator does scan for `variableNamespaceId` patterns in DSL content (line 342, `VARIABLE_NAMESPACE_RE`), but only if `validatePublishSafetyFn` is provided (see P2-SEC-01). If the safety validator is bypassed, the raw DSL content with `variableNamespaceIds` is persisted.

More importantly, the `VARIABLE_NAMESPACE_RE` pattern `/variableNamespaceId[s]?\s*[:=]\s*['"]?[^'"\s,}\]]+/gi` looks for assignment-style references. It would NOT match array-style references like:

```yaml
variableNamespaceIds:
  - 'ns-abc-123'
  - 'ns-def-456'
```

because the regex expects `:=` followed by a single value, not a YAML list.

**Impact:** Source-project-specific `variableNamespaceIds` could leak through the DSL artifact if:

1. The safety validator is not injected (P2-SEC-01), OR
2. The DSL uses a format the regex doesn't match (YAML list syntax)

**Recommended Fix:**

1. Fix P2-SEC-01 (make safety validator required) as the primary defense.
2. As defense-in-depth, add a `stripVariableNamespaceIdsFromDsl` step that uses a broader regex to scrub the raw DSL content before storing it in the artifact, or
3. Broaden the `VARIABLE_NAMESPACE_RE` to match multi-line YAML array syntax:

```ts
const VARIABLE_NAMESPACE_RE = /variableNamespaceId[s]?\s*[:=\-]\s*['"]?[^'"\s,}\]]+/gi;
```

Or preferably, add a second regex for the YAML array case:

```ts
const VARIABLE_NAMESPACE_YAML_RE = /variableNamespaceIds:\s*\n(\s+-\s*.+\n?)*/gi;
```

---

### P2-SEC-04 — MEDIUM: No decompression size limit on `compressedPayload` read path

**File:** `packages/database/src/models/deployment-module-snapshot.model.ts:22`
**OWASP:** A04:2021 - Insecure Design (decompression bomb)

The `DeploymentModuleSnapshot` stores `compressedPayload: Buffer` (gzip-compressed JSON). The LLD Section 1.5 specifies:

- Pre-compression: validate `JSON.stringify(payload).length <= 8_388_608` (8 MB)
- Post-validation: `zlib.gzip(jsonPayload)` before persistence
- On read: `zlib.gunzip(compressedPayload)` then `JSON.parse`

The LLD Section 6.1 (Runtime Merge) shows the read path:

```ts
const payload = JSON.parse(zlib.gunzipSync(moduleSnapshot.compressedPayload).toString());
```

Neither the model, the types, nor the current implementation enforce a decompression size limit. If a document with a crafted `compressedPayload` is stored (e.g., via direct DB manipulation or a bug in the size validation), `zlib.gunzipSync` will decompress to an unbounded buffer in memory.

Gzip has a theoretical compression ratio of 1000:1+ for repetitive data. A 4 MB compressed payload could decompress to 4 GB, causing an OOM kill on the runtime pod.

**Impact:** Decompression bomb can OOM-kill runtime pods. Requires pre-existing DB write access, so attacker needs to bypass the build service validation.

**Recommended Fix:**

Use streaming decompression with a size limit instead of `gunzipSync`:

```ts
import { createGunzip } from 'zlib';

const MAX_DECOMPRESSED_SIZE = 8 * 1024 * 1024; // 8 MB

function decompressSnapshot(compressed: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let totalSize = 0;

  // Synchronous approach with size tracking:
  const decompressed = zlib.gunzipSync(compressed, {
    maxOutputLength: MAX_DECOMPRESSED_SIZE,
  });
  return decompressed;
}
```

Node.js `zlib.gunzipSync` supports `maxOutputLength` option (added in Node 14). When the limit is exceeded, it throws `ERR_BUFFER_TOO_LARGE`. This is the simplest fix.

---

### P2-SEC-05 — MEDIUM: `deleteProject` Path A consumer dependency query exposes all consumer project IDs in memory

**File:** `packages/database/src/cascade/cascade-delete.ts:236-241`
**OWASP:** A01:2021 - Broken Access Control

When deleting a module project (Path A), the cascade logic first counts consumer dependencies (line 231), then if > 0, performs a second query to fetch ALL consumer project IDs (lines 236-239):

```ts
const consumerDeps = await ProjectModuleDependency.find(
  { tenantId: projectTenantId, moduleProjectId: projectId },
  { projectId: 1 },
).lean();
const consumerProjectIds = consumerDeps.map((d: any) => d.projectId);
throw new CascadeDeleteBlockedError(consumerProjectIds);
```

The `.find()` query has no `.limit()`. A popular module used by hundreds of projects would load all consumer project IDs into memory. While the `CascadeDeleteBlockedError` has a correct warning comment (line 30) about not serializing IDs to HTTP responses, the error object itself carries the full array.

**Impact:**

1. Memory: Unbounded array size for popular modules (low severity — hundreds, not millions)
2. Information: The full set of consumer project IDs is available to any code path that catches this error. Even with the warning comment, a future developer could accidentally log or serialize it.

**Recommended Fix:**

Since the route handler only needs the count (per the LLD), avoid fetching the full list:

```ts
if (consumerDepCount > 0) {
  // Only fetch a sample (first 5) for internal debugging — not for HTTP response
  const sampleDeps = await ProjectModuleDependency.find(
    { tenantId: projectTenantId, moduleProjectId: projectId },
    { projectId: 1 },
  )
    .limit(5)
    .lean();
  const sampleIds = sampleDeps.map((d: any) => d.projectId);
  throw new CascadeDeleteBlockedError(sampleIds, consumerDepCount);
}
```

Update `CascadeDeleteBlockedError` to accept a count parameter:

```ts
constructor(consumerProjectIds: string[], public readonly totalCount?: number) {
  super(`Cannot delete module project: ${totalCount ?? consumerProjectIds.length} consumer project(s) depend on it`);
}
```

---

### P2-SEC-06 — MEDIUM: `module-selector.ts` interpolates user-controlled `selector.value` into error messages without length bounds

**File:** `packages/project-io/src/module-release/module-selector.ts:38,51`
**OWASP:** A03:2021 - Injection (error message injection)

The `resolveSelector` function interpolates `selector.value` directly into error messages:

```ts
// Line 38:
return { error: `Version ${selector.value} not found or archived` };

// Line 51:
return {
  error: `No release promoted to '${selector.value}' environment. Promote a release first.`,
};
```

`selector.value` is user-controlled input. While these error strings are returned as JSON in HTTP responses (not rendered in HTML), there are two concerns:

1. **Unbounded length:** A 10 MB `selector.value` string would create a 10 MB error message, consuming memory and bandwidth. No length validation exists in this function or its callers (caller validation is Sprint 2 scope).

2. **Log injection:** If the error message is logged (likely, given the platform's logging conventions), a `selector.value` containing newlines could inject fake log entries:

```
selector.value = "1.0.0\n[ERROR] Security breach detected: admin escalation successful"
```

**Impact:** Low — error message bloat and potential log injection. Both are mitigated by Zod validation at the route layer (Sprint 2), but this function has no local defense.

**Recommended Fix:**

Truncate `selector.value` in error messages:

```ts
const safeValue = selector.value.slice(0, 100);
return { error: `Version ${safeValue} not found or archived` };
```

Or better, validate at the entry point of this function:

```ts
if (typeof selector.value !== 'string' || selector.value.length > 100) {
  return { error: 'Invalid selector value' };
}
```

---

### P2-SEC-07 — MEDIUM: `module-contract.ts` config/secret extraction does not handle escaped template delimiters

**File:** `packages/project-io/src/module-release/module-contract.ts:40-43`
**OWASP:** A04:2021 - Insecure Design (incomplete parsing)

The config and secret reference extraction uses simple regex patterns:

```ts
const CONFIG_REF_RE = /\{\{config\.([A-Za-z_][A-Za-z0-9_]*)\}\}/g;
const SECRET_REF_RE = /\{\{secrets\.([A-Za-z_][A-Za-z0-9_]*)\}\}/g;
```

These patterns extract config/secret key names from DSL content. The extracted keys populate the contract's `requiredConfigKeys` array, which is later used by `validateConfigOverrides` (LLD Section 11.2) to determine which keys are secret. If the extraction misses a secret key, `validateConfigOverrides` would allow a `configOverrides` entry for that key because it's not in the `secretKeys` set.

Specifically, these patterns would miss:

- Nested templates: `{{config.{{env.KEY_NAME}}}}` — the inner braces confuse the regex
- Whitespace variants: `{{ config.MY_KEY }}` or `{{config. MY_KEY}}`
- Comment-embedded references that shouldn't be extracted (false positive)

The existing `env-var-scanner.ts` utilities (`extractEnvVarReferences`, `extractSecretReferences`) may have different regex patterns — if they're inconsistent with the contract's patterns, the contract could under-report requirements.

**Impact:** Low — missed secret key extraction means the contract allows config overrides for keys that should be blocked. Requires adversarial DSL authoring by the module publisher, who already has access to their own secrets.

**Recommended Fix:**

Verify that `CONFIG_REF_RE` and `SECRET_REF_RE` patterns are consistent with the template engine's actual parsing behavior. Add a comment documenting which template syntax variants are expected:

```ts
// Template syntax: {{config.KEY}} — no spaces, no nesting.
// This matches the ABL template engine's parsing behavior.
```

If the template engine supports whitespace (e.g., `{{ config.KEY }}`), update the regexes accordingly.

---

## Verified Security Controls

### 1. Tenant Isolation — PASS

All 4 new models apply `tenantIsolationPlugin`:

| Model                      | Plugin Line | Index Leading Key              |
| -------------------------- | ----------- | ------------------------------ |
| `ModuleRelease`            | line 90     | `tenantId: 1` on all 2 indexes |
| `ModuleEnvironmentPointer` | line 47     | `tenantId: 1` on unique index  |
| `ProjectModuleDependency`  | line 68     | `tenantId: 1` on all 2 indexes |
| `DeploymentModuleSnapshot` | line 43     | `tenantId: 1` on all 2 indexes |

The `tenantIsolationPlugin` (verified at `packages/database/src/mongo/plugins/tenant-isolation.plugin.ts`) provides defense-in-depth:

- All read operations (`find`, `findOne`, `findOneAndUpdate`, `deleteMany`, etc.) have pre-hooks that inject `tenantId` from ALS context
- Cross-tenant write attempts throw `Tenant isolation violation` errors (lines 130-135, 151-158)
- Aggregation pipelines get a `$match { tenantId }` stage prepended (lines 107-118)
- Super-admin context can bypass isolation via `withSuperAdminContext()` (line 67)

### 2. Secret Leakage Prevention — PASS

`module-publish-safety.ts` implements two-tier validation per LLD Section 11.1:

**Tier 1 (Structural — blocking):**

- HTTP tools must use `auth_profile_ref` or template syntax (lines 158-183)
- Auth-sensitive headers (`Authorization`, `X-Api-Key`, `X-Auth-Token`, `Api-Key`) checked for non-templated values (lines 187-208)

**Tier 2 (Pattern-based — supplementary):**

- PEM private keys (line 61) — blocking
- URL-embedded API keys (line 58) — blocking
- Bearer/Basic/sk-/pk\_ tokens (line 64) — blocking
- Base64 secrets > 20 chars with printable ASCII heuristic (line 55) — warning

**Non-portable warnings:**

- SearchAI `indexId` references (line 302-315) — warning
- Workflow `workflowId` references (line 318-331) — warning

**Source-project identifiers:**

- `variableNamespaceId` patterns (line 341-349) — blocking
- Raw `_id` references (line 353-362) — warning
- `projectId` references (line 365-374) — warning

### 3. Template Injection Resistance — PASS (LLD spec)

LLD Section 11.2 specifies `validateConfigOverrides` using `/\{\{/` for template injection detection (line 1585), which correctly avoids the newline bypass vulnerability with `/\{\{.*?\}\}/`. This function is Sprint 2 scope and not yet implemented, but the LLD specification is correct.

Control character rejection uses `/[\x00-\x08\x0B\x0C\x0E-\x1F]/` (line 1591), which blocks binary injection while allowing tabs (`\x09`), newlines (`\x0A`), and carriage returns (`\x0D`).

### 4. `variableNamespaceIds` Stripping — PARTIAL PASS (see P2-SEC-03)

The `stripVariableNamespaceIds` function in `build-module-release.ts:268-288` correctly:

- Recursively walks all object properties
- Skips keys named `variableNamespaceIds`
- Handles nested objects and arrays (including arrays of objects)
- Uses `stripDeep` for the array branch, which recursively handles arrays-of-arrays

However, stripping only applies to compiled IR, not raw DSL content (see P2-SEC-03).

### 5. Source-Project Identifier Leakage — PARTIAL PASS (see P2-SEC-02)

Covers `_id`, `projectId`, and `variableNamespaceId` patterns. Does not cover `tenantId` (see P2-SEC-02).

### 6. Hash Algorithm Security — PASS

`source-hash.ts:34` uses `createHash('sha256')` — a collision-resistant hash function. Truncation to 16 hex chars (64 bits) provides sufficient collision resistance for per-project deduplication.

Deterministic serialization via `JSON.stringify` with sorted keys (lines 29-32) prevents hash divergence from non-deterministic key ordering.

### 7. Cascade Delete Cross-Tenant Safety — PASS

`deleteTenant()` (lines 48-170): All 4 new collections deleted with `{ tenantId }` scope. Deletion order respects dependencies: snapshots -> deps -> pointers -> releases.

`deleteProject()` Path A (module project, lines 229-259): Uses `{ tenantId: projectTenantId, moduleProjectId: projectId }` for all queries. Consumer dep check at lines 231-241 also scoped to `tenantId`.

`deleteProject()` Path B (consumer project, lines 263-276): Uses `{ tenantId: projectTenantId, projectId }` for dep and snapshot cleanup.

`softDeleteModuleProject()` (lines 359-379): Uses `{ _id: moduleProjectId, tenantId }` for project lookup and `{ tenantId, moduleProjectId }` for release update.

### 8. CascadeDeleteBlockedError Information Exposure — PASS with NOTE

The error class at lines 26-42 stores `consumerProjectIds` for internal cascade logic. The JSDoc warning at lines 28-31 explicitly states: "WARNING: Do NOT serialize this to HTTP responses — it leaks other projects' IDs. Route handlers should return only the count, not the IDs."

This is a documentation-level control, not an enforcement mechanism. See P2-SEC-05 for the recommendation to also limit the query result set.

### 9. Optimistic Concurrency TOCTOU Resistance — PASS (design level)

`ModuleEnvironmentPointer.revision` (model line 20, default: 1) provides the atomic compare-and-swap field. The LLD Section 10.3 specifies `findOneAndUpdate({ revision: expectedRevision }, { $inc: { revision: 1 } })` — a standard optimistic concurrency pattern that is TOCTOU-safe because MongoDB's `findOneAndUpdate` is atomic.

Redis lock for deployment builds (LLD Section 10.2) uses:

- `SET NX PX` for atomic acquisition (line 1448)
- Lua scripts for atomic compare-and-delete on release (lines 1423-1429)
- Lua scripts for atomic compare-and-renew on timer (lines 1431-1437)

Both patterns are correctly specified per the recommendations from prior reviews.

### 10. DI Type Safety — PARTIAL PASS (see P2-SEC-01)

`compileFn` and `extractContractFn` are required parameters — callers must provide them. `validatePublishSafetyFn` is optional — callers can silently bypass all secret detection.

---

## Summary Table

| ID        | Severity | File                                  | Line(s) | OWASP Category            | Status                              |
| --------- | -------- | ------------------------------------- | ------- | ------------------------- | ----------------------------------- |
| P2-SEC-01 | CRITICAL | `build-module-release.ts`             | 107     | A04 Insecure Design       | Must fix before Sprint 2 routes     |
| P2-SEC-02 | HIGH     | `module-publish-safety.ts`            | 333-375 | A01 Broken Access Control | Add `tenantId` pattern              |
| P2-SEC-03 | HIGH     | `build-module-release.ts`             | 156-162 | A01 Broken Access Control | Fix P2-SEC-01 + broaden regex       |
| P2-SEC-04 | MEDIUM   | `deployment-module-snapshot.model.ts` | 22      | A04 Insecure Design       | Add `maxOutputLength` on decompress |
| P2-SEC-05 | MEDIUM   | `cascade-delete.ts`                   | 236-241 | A01 Broken Access Control | Add `.limit()` to consumer query    |
| P2-SEC-06 | MEDIUM   | `module-selector.ts`                  | 38,51   | A03 Injection             | Truncate user input in errors       |
| P2-SEC-07 | MEDIUM   | `module-contract.ts`                  | 40-43   | A04 Insecure Design       | Document template syntax scope      |

---

## Checklist

- [x] Tenant isolation: All 4 models use `tenantIsolationPlugin`, all queries include `tenantId`
- [x] Secret leakage prevention: Two-tier validation covers required patterns
- [x] Template injection: LLD specifies `/\{\{/` — newline-bypass resistant
- [x] variableNamespaceIds stripping: Recursive on IR; DSL artifact has regex-based detection (P2-SEC-03)
- [x] Source-project identifier leakage: `_id`, `projectId` detected; `tenantId` missing (P2-SEC-02)
- [x] Hash algorithm and truncation: SHA-256, 64-bit truncation acceptable for scope
- [x] Cascade delete cross-tenant safety: All paths tenant-scoped
- [x] Buffer/payload size limits: No runtime decompression guard (P2-SEC-04)
- [x] CascadeDeleteBlockedError info exposure: Warning comment present, query unbounded (P2-SEC-05)
- [x] Optimistic concurrency TOCTOU: Atomic patterns correctly specified
- [x] DI type safety: Safety validator is optional — bypass risk (P2-SEC-01)
