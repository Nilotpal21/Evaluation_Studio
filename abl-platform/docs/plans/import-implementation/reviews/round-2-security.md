# Round 2 Review: Security & Correctness (Post-Fix Verification)

**Reviewer**: Auditor 2 (Security & Correctness)
**Scope**: Sections 01-05 of import-implementation plan, with focus on R1 fixes in 03, 04, and 05
**Prior review**: `round-1-security.md` (5 critical/high vulnerabilities, 5 data integrity risks, 4 authorization gaps, 7 missing controls)

---

## R1 Fix Verification

### VULN-1: DNS Rebinding Bypasses SSRF Validation -- RESOLVED WITH RESIDUAL

**R1 finding**: `checkSSRF()` performed hostname checks at validation time only. DNS rebinding could redirect to `169.254.169.254` at request time.

**Fix applied**: Dual-phase design added. `checkSSRF()` remains as Phase 1 (static, at parse time). New `checkSSRFAtConnect()` (Phase 2) performs DNS resolution via `dns/promises.lookup()` and checks the resolved IP against `BLOCKED_IP_RANGES`. The resolved IP is returned in `SSRFCheckResult.resolvedIp` for pinning.

**Verification**:

- Phase 1 covers: invalid URLs, scheme allowlist (`https`, `http`, `wss`, `ws`), hostname blocklist (cloud metadata), IP literal range checks, `.local`/`.internal`/`localhost` heuristics. Adequate.
- Phase 2 covers: DNS resolution, resolved IP against `BLOCKED_IP_RANGES`, resolved IP against `BLOCKED_HOSTNAMES`. Adequate.
- `BLOCKED_IP_RANGES` covers RFC 1918 (`10.x`, `172.16-31.x`, `192.168.x`), loopback (`127.x`), link-local (`169.254.x`), and this-network (`0.x`). Adequate for IPv4.
- `BLOCKED_HOSTNAMES` covers AWS/GCP/Azure metadata (`169.254.169.254`), Google metadata (`metadata.google.internal`, `metadata.google`), Alibaba (`100.100.100.200`), and AWS IPv6 metadata (`fd00:ec2::254`). Good coverage.

**Residual R2-SSRF-1 (LOW)**: The `isBlockedIP()` function only handles IPv4. `dns/promises.lookup()` may return an IPv6 address (e.g., `::ffff:169.254.169.254` or `::1`). The `ipToLong()` function will produce garbage for IPv6, and the range check will pass. The `BLOCKED_HOSTNAMES` set includes `fd00:ec2::254` but `isBlockedIP()` never matches it -- the set check runs against the hostname input, not the resolved address.

- **Fix needed at implementation time**: Add IPv6 range checks (at minimum: `::1`, `::ffff:0:0/96`, `fc00::/7`, `fe80::/10`) or force `lookup()` to resolve IPv4 only via `{ family: 4 }`.

**Residual R2-SSRF-2 (LOW)**: The plan states the resolved IP "should be pinned and used for the actual TCP connection" but does not show how pinning works at the HTTP client level. Node's `http.request` and most HTTP libraries re-resolve DNS by default. The implementation must use a custom `lookup` function or agent that returns the pinned IP.

- **Not a plan deficiency** -- this is an implementation detail. But the plan should add a note specifying that `checkSSRFAtConnect` results must be consumed via a pinning mechanism (e.g., custom `dns.lookup` override in the HTTP agent).

**Verdict**: RESOLVED. Residuals are low severity and can be addressed during implementation.

---

### VULN-2: Zod `.passthrough()` Defeats Schema Validation -- RESOLVED

**R1 finding**: All entity schemas used `.passthrough()` with `stripInternal`, allowing arbitrary field injection into MongoDB.

**Fix applied**: All schemas now use `.strip()`. The R1 Fix note at line 482 of Section 4.3 explicitly states the change and rationale. Where extensibility is needed (e.g., `connectionConfig`, `filterConfig`, `settings`, `metadata`), explicit `z.record(z.unknown())` fields contain unknown data within named boundaries.

**Verification**: I checked every schema definition in Section 4.3:

| Schema                           | `.strip()` present | `z.record(z.unknown())` fields (explicit extensibility) |
| -------------------------------- | ------------------ | ------------------------------------------------------- |
| `ImportedConnectionSchema`       | Yes                | `authProfile`                                           |
| `ImportedConnectorConfigSchema`  | Yes                | `connectionConfig`, `filterConfig`, `permissionConfig`  |
| `ImportedGuardrailSchema`        | Yes                | `settings`                                              |
| `ImportedWorkflowSchema`         | Yes                | `steps[]`, `triggers[]`, `escalationRules[]`            |
| `ImportedWorkflowVersionSchema`  | Yes                | `definition`                                            |
| `ImportedEvalSetSchema`          | Yes                | `variants[]`, `personaModelConfig`                      |
| `ImportedEvalScenarioSchema`     | Yes                | `expectedMilestones[]`                                  |
| `ImportedEvalPersonaSchema`      | Yes                | None                                                    |
| `ImportedEvaluatorSchema`        | Yes                | `scoringRubric`, `biasSettings`, `scorerConfig`         |
| `ImportedSearchIndexSchema`      | Yes                | `tokenChunkStrategy`, `vectorStore`, `searchDefaults`   |
| `ImportedSearchSourceSchema`     | Yes                | `extractionConfig`, `enrichmentConfig`, `syncSchedule`  |
| `ImportedKnowledgeBaseSchema`    | Yes                | None                                                    |
| `ImportedCrawlPatternSchema`     | Yes                | `metadata`                                              |
| `ImportedChannelSchema`          | Yes                | `config`                                                |
| `ImportedWebhookSchema`          | Yes                | None                                                    |
| `ImportedWidgetConfigSchema`     | Yes                | `theme`, `branding`, `behavior`                         |
| `ImportedLookupEntrySchema`      | Yes                | `metadata`                                              |
| `ImportedCanonicalSchemaFile`    | Yes                | `fields[]`                                              |
| `ImportedDomainVocabularySchema` | Yes                | `entries[]`                                             |
| `ImportedFactSchema`             | Yes                | `metadata`                                              |

All 20 schemas use `.strip()`. No `.passthrough()` calls remain. The `stripInternal` transform is still applied after `.strip()` as defense-in-depth for the 7 named internal fields.

**Verdict**: FULLY RESOLVED.

---

### VULN-3: Unbounded Recursion in Scanners -- RESOLVED

**R1 finding**: `scanObject`, `scanForInjection`, `scanForSecrets`, `scanForRedacted` had no depth limit, enabling stack overflow via deeply nested payloads.

**Fix applied**: `MAX_SCAN_DEPTH = 20` constant added at line 1197 of Section 4. All four recursive functions now accept a `depth` parameter and return/push findings when `depth >= MAX_SCAN_DEPTH`.

**Verification**:

| Function               | `depth` parameter | Check at entry | Behavior on exceeded       |
| ---------------------- | ----------------- | -------------- | -------------------------- |
| `scanObject` (SSRF)    | Yes (line 1250)   | Line 1255      | Push finding, return early |
| `scanForInjection`     | Yes (line 1304)   | Line 1313      | Push finding, return early |
| `scanForSecrets`       | Yes (line 1502)   | Line 1508      | Return early (silent)      |
| `scanForRedacted`      | Yes (line 1963)   | Line 1968      | Return early (silent)      |
| `sanitizeImportedData` | Yes (line 1376)   | Line 1377      | Return `{}` (truncate)     |

**Is `MAX_SCAN_DEPTH = 20` appropriate?** Yes. Legitimate import data structures rarely exceed 5-6 levels of nesting. Even the most complex structures (workflow step definitions with nested conditions and actions) would not exceed 10 levels. 20 provides ample headroom while still protecting against deliberate nesting attacks. The original R1 suggestion of 32 would also work, but 20 is conservative and appropriate.

**Are all recursive functions covered?** Almost. The `deepReplace` function in Section 4.5 (redacted value handling, line 2019) still recurses without a depth limit. While it only processes connection files (smaller scope), a maliciously crafted `.connection.json` with deep nesting would still cause a stack overflow in `deepReplace`.

**Residual R2-DEPTH-1 (LOW)**: `deepReplace()` at line 2019 lacks a depth parameter. Add `depth` tracking consistent with the other scan functions.

**Verdict**: SUBSTANTIALLY RESOLVED. One minor function (`deepReplace`) still needs the same treatment.

---

### VULN-4: Tenant Isolation Check Conditional Logic Flaw -- RESOLVED

**R1 finding**: `verifyTenantIsolation` used `if (data.tenantId && data.tenantId !== expected)`, silently passing records without `tenantId`.

**Fix applied**: Changed to `if (!data.tenantId || data.tenantId !== expectedTenantId)` at line 1702. Same pattern for `projectId` at line 1713. Additionally, `_id` smuggling is now detected at line 1724.

**Verification**:

- Missing `tenantId`: caught by `!data.tenantId` -- produces "tenantId missing" violation. Correct.
- Wrong `tenantId`: caught by `data.tenantId !== expectedTenantId` -- produces "tenantId mismatch" violation. Correct.
- Missing `projectId`: caught by `!data.projectId` -- same pattern. Correct.
- Smuggled `_id`: caught by `if (data._id)` check. Correct.

The error messages are diagnostic -- they distinguish between "missing" and "mismatch" cases, which aids debugging.

**Verdict**: FULLY RESOLVED.

---

### VULN-5: Import Operation Status Endpoint Lacks Tenant Scoping -- RESOLVED

**R1 finding**: Status endpoint might query by `_id` only, allowing cross-tenant information disclosure.

**Fix applied**: Section 5, lines 584-605 now show the explicit query with `tenantId` and `projectId`:

```
ImportOperationState.findOne({ _id: operationId, projectId, tenantId })
```

The fix note explains that `tenantIsolationPlugin` provides some protection, but the explicit filter is defense-in-depth. Returns 404 (not 403) to avoid leaking existence, consistent with platform principles.

**Verdict**: FULLY RESOLVED.

---

### INT-1: Fuzzy Auth Profile Matching Silently Auto-Applied -- NOT RESOLVED

**R1 finding**: Fuzzy matches (score >= 0.7) should require user confirmation, not be auto-applied.

**Status**: Section 4.2 (lines 302-382) still shows fuzzy matches being auto-applied in `resolveAuthProfiles()`. When `candidates[0].score >= 0.7`, the function directly sets `resolved` and `nameToIdMap` (lines 358-368). There is no distinction between "confirmed" and "suggested" fuzzy matches. The function returns `unresolved` only when no candidate exceeds 0.7.

The R1 review flagged this as a condition for design approval. The fix was not applied.

**Impact**: A "Salesforce Production" profile could silently match "Salesforce Staging" (same authType, scope, connector = score 0.9), wiring production connections to staging credentials.

**Residual R2-AUTH-1 (HIGH)**: Fuzzy matches must be returned as candidates in the `unresolved` array (or a new `suggestedMappings` field), not auto-applied. Only `exact_name` (confidence 1.0) and `user_mapped` should be auto-applied. The preview response should present fuzzy suggestions for user confirmation before the import proceeds.

**Verdict**: NOT RESOLVED. This was flagged as a condition for approval in R1.

---

### R1 Non-Blocking Items: Status Check

| R1 Finding                               | Status                                                     | Notes                                              |
| ---------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------- |
| INT-2 (Rollback vs user edits)           | Not addressed in plan updates                              | Acceptable -- documented as implementation concern |
| INT-3 (Duplicate entity names)           | Not addressed in plan updates                              | Acceptable -- implementation concern               |
| INT-4 (Circular agent handoffs)          | Not addressed in plan updates                              | Acceptable -- low severity                         |
| INT-5 (MongoDB encryption at rest)       | Not addressed in plan updates                              | Acceptable -- infrastructure concern               |
| AUTH-1 (Worker-time permission re-check) | Not addressed                                              | See R2-AUTH-2 below                                |
| AUTH-2 (Status endpoint ownership)       | Not addressed                                              | See R2-AUTH-3 below                                |
| AUTH-3 (DLQ admin endpoints)             | Not addressed                                              | See R2-AUTH-4 below                                |
| AUTH-4 (Auth profile visibility)         | Not addressed                                              | See R2-AUTH-5 below                                |
| SEC-1 (JSON nesting before parse)        | Not addressed                                              | Partially mitigated by VULN-3 depth limits         |
| SEC-2 (Preview rate limit)               | Partially addressed -- rate limit applies to import routes | Acceptable                                         |
| SEC-3 (userMappings ID validation)       | Not addressed                                              | See cross-ref analysis below                       |
| SEC-4 (Injection guard value check)      | Not addressed                                              | Acceptable -- second-order risk                    |
| SEC-5 (Content-Type enforcement)         | Not addressed                                              | Acceptable -- Express handles this                 |
| SEC-6 (XSS via descriptions)             | Not addressed                                              | Studio UI concern, not import pipeline             |
| SEC-7 (Per-layer entity count limits)    | Not addressed                                              | See R2-LIMITS-1 below                              |

---

## New Security Analysis: R2-Specific Findings

### R2-GRIDFS-1: GridFS Storage Lacks Tenant Scoping on Read (Severity: MEDIUM)

**Location**: Section 5, lines 144-154 (`loadImportFiles`)

The `loadImportFiles` function retrieves files by filename pattern `${operationId}.gz` only:

```typescript
bucket.openDownloadStreamByName(`${operationId}.gz`);
```

The `storeImportFiles` function correctly stores `tenantId` in metadata, but the load function does not verify it. If an attacker discovers or guesses an `operationId` (UUIDv7, time-ordered), they could load another tenant's import files from GridFS.

In practice, only the BullMQ worker calls `loadImportFiles`, and the worker receives `tenantId` from the job data (which is set at enqueue time by the authenticated route handler). However, `loadImportFiles` as designed is a tenant-unscoped read.

**Fix**: Change `loadImportFiles` to accept `tenantId` and verify `metadata.tenantId` matches before returning data. Use `bucket.find({ filename, 'metadata.tenantId': tenantId })` to scope the query, then open the download stream by the matched file's `_id`.

**Mitigation factor**: The function is only called from the worker, which receives tenant context from the job. The risk is that a future caller might invoke `loadImportFiles` without tenant scoping. Defense-in-depth mandates the function itself enforces the scope.

---

### R2-GRIDFS-2: GridFS Cleanup Job Not Tenant-Scoped (Severity: LOW)

**Location**: Section 5, lines 1586-1598 (cleanup job)

The cleanup job queries all expired files across all tenants:

```typescript
bucket.find({ 'metadata.expiresAt': { $lt: now } });
```

This is correct behavior for a cleanup job (it should clean all expired files). No security issue here -- the cleanup job runs as a system-level process, not a user-facing endpoint.

**Verdict**: No issue. Cleanup jobs appropriately operate cross-tenant.

---

### R2-CROSSREF-1: Cross-Reference bulkWrite Queries Use `_id` Scoping -- Safe (Severity: NONE)

**Location**: Section 3, lines 988-1116 (cross-ref resolver)

The `batchUpdateStagedRecords` function uses `{ _id: <specific-id> }` filters for all updates. The `_id` values come from `stagedRecordIds`, which are returned by `StagedImporter.stage()` -- these are the IDs of records just inserted by the current import operation.

The anchor queries (STEP 1) also scope by `{ _id: { $in: stagedRecordIds.<collection> }, status: 'staged' }`.

**Analysis**: No injection vector in the bulkWrite queries. The `_id` values are server-generated ObjectIds, not user-supplied strings. The `$set` and `$unset` operations use hardcoded field paths (`data.workflowId`, `data._parentSetName`, etc.), not user-controlled keys. The values being set (`workflowId`, `indexId`, etc.) are looked up from the name-to-newId maps built from the same staged records.

**Potential concern**: If a cross-ref lookup fails (name not found in map), the update would set the field to `undefined`. The pseudocode does not show a guard for missing map entries. This is a correctness issue, not a security issue. Implementation should skip updates where the resolved ID is undefined and emit a warning.

**Verdict**: No injection risk. Minor correctness note for implementation.

---

### R2-CROSSREF-2: Temporary Fields With `_` Prefix Could Leak to Activated Records (Severity: MEDIUM)

**Location**: Section 3, lines 591-610, 747-748, 759-760, 832-833

Disassemblers add temporary fields prefixed with `_` to staged records: `_parentSetName`, `_nestedScenarioNames`, `_nestedPersonaNames`, `_originalIndexId`, `_indexSlug`, `_originalSearchIndexId`, `_originalChannelConnectionId`, `_channelDisplayName`.

The cross-reference resolver (Phase 2.5) is responsible for stripping these via `$unset`. If the cross-ref resolution phase is skipped (e.g., no cross-referencing collections are present in the import, or the phase throws an error that is caught but does not prevent activation), these internal temporary fields would be activated and persisted in the database.

**Risk**: Fields prefixed with `_` in the data subdocument could confuse downstream queries or be exposed through API responses that return raw document data.

**Fix**: Add a post-cross-ref validation step that checks all staged records for any `data._*` fields before activation proceeds. Alternatively, the activation phase should strip all `data._*` fields as a safety net.

---

### R2-RESUME-1: Resume-Aware Worker Phase Detection Has Incomplete Coverage (Severity: MEDIUM)

**Location**: Section 5, lines 1143-1178 (`determineResumePoint`)

The resume logic handles these states:

- `status === 'activating'` -> rollback first, then re-attempt
- `status === 'staging'` with completed layers -> resume from next layer
- `status === 'queued'` -> start from validation

**Gap**: If the worker crashed during the cross-reference resolution phase (Phase 2.5), the `ImportOperationState.status` would still be `'staging'` (since the plan does not define a dedicated status for Phase 2.5). On resume, the worker would see `status === 'staging'` with all layers having `status === 'staged'`, interpret this as "all staging complete," and skip to the next step. But the cross-reference fields would still contain stale temporary values.

**Fix**: Either add a dedicated `'resolving_refs'` status for Phase 2.5, or have the resume logic detect the presence of `data._*` fields on staged records as a signal that cross-ref resolution needs to re-run. The resolution is idempotent (it reads staged records, builds maps, updates with `$set`/`$unset`), so re-running it is safe.

---

### R2-SCHEMA-1: `.strip()` Schemas May Reject Valid Exports With New Fields (Severity: LOW)

**Analysis**: The switch from `.passthrough()` to `.strip()` is the correct security choice. However, `.strip()` silently removes any field not declared in the schema. If a future platform release adds new fields to an entity (e.g., a new `priority` field on connections), exports from the new version imported into an older version would silently lose that field.

This is acceptable behavior -- the alternative (`.passthrough()`) would reintroduce VULN-2. The plan already handles this correctly: `.strip()` provides forward-compatibility by ignoring unknown fields rather than rejecting them. The `format_version` in the manifest allows the import pipeline to detect version mismatches and warn the user.

**Verdict**: No issue. The design correctly prioritizes security over perfect data preservation for cross-version imports.

---

### R2-SCHEMA-2: `getSchemaForFile` Returns `null` for Unknown Files, Bypassing Validation (Severity: MEDIUM)

**Location**: Section 4.3, lines 933-939 (`validateEntitySchema`)

When `getSchemaForFile` returns `null` (unknown file type), the validation runner returns `valid: true` with only `stripInternal` applied -- no Zod schema validation at all. This means any file that does not match a known extension pattern bypasses all schema validation, including the `.strip()` protection.

**Scenario**: An attacker includes a file named `connections/evil.json` (note: not `.connection.json`). The `getSchemaForFile` function checks `filePath.endsWith('.connection.json')` and does not match. The file is "validated" with only `stripInternal` -- the 7 named fields are removed, but all other arbitrary fields pass through.

**Mitigating factor**: The path validation (`validateV2FilePath`) restricts files to known layer folders and known extensions. The `scanForInjection` check runs on all JSON files regardless of schema match. And the disassemblers themselves parse only files matching expected patterns (e.g., `*.connection.json`). Files that do not match any disassembler pattern are effectively ignored during staging.

**Fix**: Change the fallback in `validateEntitySchema` to return `valid: false` for unknown file types within recognized layer folders, or log a warning and omit the file from staging. This prevents reliance on the assumption that disassemblers will ignore unrecognized files.

---

### R2-AUTH-2: AUTH-1 Still Unaddressed -- Worker-Time Permission Re-Check (Severity: MEDIUM)

**Location**: Section 5 worker implementation

The R1 review flagged that permissions are checked only at API request time, not when the async worker processes the job. Section 5's `ImportV2JobData` includes `userId` but the worker does not re-check permissions before writing.

For imports queued during off-hours or when the queue is backed up, there could be a meaningful delay between permission check and execution. During this window, the user's `guardrail:write` permission could be revoked.

**Residual**: Store the user's required layer permissions in `ImportV2JobData` or `ImportOperationState`. At worker startup, re-query the user's current permissions and verify they still have all required layer permissions. If any are revoked, fail the import with error code `PERMISSIONS_REVOKED`.

---

### R2-AUTH-3: AUTH-2 Still Unaddressed -- Status Endpoint Ownership (Severity: LOW)

Any user in the project can view any other user's import status (entity names, error messages). While VULN-5 is fixed (cross-tenant scoping), within the same project, User A can see User B's import details.

**Residual**: For non-admin users, the status endpoint should optionally filter by `userId`. This is a privacy concern, not a critical security issue. Can be addressed during implementation.

---

### R2-AUTH-4: AUTH-3 Still Unaddressed -- DLQ Admin Endpoints Lack Auth Specification (Severity: HIGH)

**Location**: Section 5, lines 1236-1238

The DLQ endpoints are defined but their auth requirements are not specified in the plan. If implemented with project-level permissions, any project user could inspect DLQ jobs from other tenants.

**Residual**: The plan must explicitly state that DLQ endpoints require `requirePlatformAdmin()` middleware. This is critical because DLQ jobs contain full import metadata including `tenantId`, `projectId`, error messages, and layer details from potentially any tenant.

---

### R2-AUTH-5: AUTH-4 Still Unaddressed -- Auth Profile Visibility Check (Severity: MEDIUM)

**Location**: Section 4.2 (auth profile resolution)

The auth profile resolver fetches all active profiles for the tenant without checking the importing user's access to `visibility: 'personal'` profiles. A user could import a connection that references another user's personal OAuth credential.

**Residual**: During implementation, filter `targetProfiles` to exclude `visibility: 'personal'` profiles not owned by the importing user.

---

### R2-LIMITS-1: SEC-7 Still Unaddressed -- No Per-Layer Entity Count Limits (Severity: LOW)

**Location**: Section 4.4.6

`V2_IMPORT_LIMITS.maxFileCount = 2000` caps total files, but there is no per-layer cap. An import with 1,999 guardrail files (each within size limits) would pass validation.

**Residual**: Add per-layer entity count limits during implementation. The capacity table in Section 5 already lists reasonable max entities per layer (1000 core, 200 connections, 100 guardrails, etc.) -- these should be enforced, not just documented.

---

### R2-CLEANUP-1: Stale Operation Cleanup Lacks Tenant Scoping (Severity: LOW)

**Location**: Section 5, lines 1603-1682 (cleanup job)

The cleanup job queries `ImportOperationState.find({ status: { $in: [...] } })` without `tenantId`. This is correct for a system-level cleanup job. The `tenantIsolationPlugin` on the model should be configured to allow unscoped queries from system contexts (or the cleanup job runs with a system context that bypasses the plugin).

**Potential issue**: If the `tenantIsolationPlugin` is strict and requires `tenantId` on all queries, the cleanup job would silently find no results and fail to clean up stale imports.

**Fix**: Verify during implementation that the cleanup job uses a system-level database connection or context that is not subject to `tenantIsolationPlugin` filtering.

---

## Summary of Round 2 Findings

### R1 Fix Verification

| R1 Finding                        | R2 Verdict                 | Notes                                                            |
| --------------------------------- | -------------------------- | ---------------------------------------------------------------- |
| VULN-1 (DNS rebinding)            | RESOLVED (2 low residuals) | IPv6 handling and IP pinning need implementation attention       |
| VULN-2 (`.passthrough()` schemas) | FULLY RESOLVED             | All 20 schemas verified                                          |
| VULN-3 (Unbounded recursion)      | SUBSTANTIALLY RESOLVED     | `deepReplace` still lacks depth limit                            |
| VULN-4 (Tenant isolation logic)   | FULLY RESOLVED             | Correct `!data.tenantId \|\| ...` pattern                        |
| VULN-5 (Status endpoint scoping)  | FULLY RESOLVED             | Explicit `tenantId` + `projectId` in query                       |
| INT-1 (Fuzzy auth auto-apply)     | **NOT RESOLVED**           | Still auto-applies fuzzy matches -- was an R1 approval condition |

### New R2 Findings

| Finding                                       | Severity | Category                                        |
| --------------------------------------------- | -------- | ----------------------------------------------- |
| R2-AUTH-1 (Fuzzy auth still auto-applied)     | HIGH     | Data integrity / authorization -- R1 carry-over |
| R2-AUTH-4 (DLQ endpoints lack auth spec)      | HIGH     | Authorization gap -- R1 carry-over              |
| R2-GRIDFS-1 (GridFS read not tenant-scoped)   | MEDIUM   | Tenant isolation                                |
| R2-CROSSREF-2 (Temp `_` fields could leak)    | MEDIUM   | Data integrity                                  |
| R2-RESUME-1 (Phase 2.5 not in resume logic)   | MEDIUM   | Correctness / race condition                    |
| R2-SCHEMA-2 (Unknown files bypass validation) | MEDIUM   | Schema bypass                                   |
| R2-AUTH-2 (Worker permission re-check)        | MEDIUM   | Authorization gap -- R1 carry-over              |
| R2-AUTH-5 (Auth profile visibility)           | MEDIUM   | Authorization gap -- R1 carry-over              |
| R2-SSRF-1 (IPv6 not covered in IP check)      | LOW      | SSRF residual                                   |
| R2-SSRF-2 (IP pinning not specified)          | LOW      | SSRF residual                                   |
| R2-DEPTH-1 (`deepReplace` no depth limit)     | LOW      | DoS residual                                    |
| R2-AUTH-3 (Status endpoint ownership)         | LOW      | Privacy                                         |
| R2-LIMITS-1 (No per-layer entity caps)        | LOW      | DoS                                             |
| R2-CLEANUP-1 (Cleanup tenant scoping)         | LOW      | Operational                                     |
| R2-SCHEMA-1 (`.strip()` forward compat)       | NONE     | By design, acceptable                           |
| R2-CROSSREF-1 (bulkWrite injection)           | NONE     | No issue found                                  |

---

## Verdict

**CONDITIONAL PASS -- 2 items must be addressed before implementation begins:**

1. **R2-AUTH-1 / INT-1 (Fuzzy auth auto-application)**: This was flagged as an R1 approval condition and remains unresolved. Fuzzy matches with score < 1.0 must be presented as suggestions, not auto-applied. Only `exact_name` and `user_mapped` strategies should populate `nameToIdMap`. This is a one-line change in the plan: move the `candidates[0].score >= 0.7` branch from `resolved` to a new `suggestions` output field.

2. **R2-AUTH-4 (DLQ endpoints)**: Add explicit `requirePlatformAdmin()` specification to the DLQ route definitions in Section 5. Without this, implementers may default to project-level auth, enabling cross-tenant DLQ access.

The remaining medium-severity findings (R2-GRIDFS-1, R2-CROSSREF-2, R2-RESUME-1, R2-SCHEMA-2, R2-AUTH-2, R2-AUTH-5) should be tracked as implementation requirements but do not block plan approval. They are well-scoped and have clear fixes.

The plan's security posture is strong overall. The R1 fixes for VULN-2, VULN-3, VULN-4, and VULN-5 are thorough and correctly implemented. The two-phase security pipeline (file-level then record-level), the `.strip()` schema enforcement, and the GridFS storage redesign are well-designed.
