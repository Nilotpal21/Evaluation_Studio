# Round 1 Review: Security & Correctness

**Reviewer**: Auditor 2 (Security & Correctness)
**Scope**: Sections 01-05 of import-implementation plan
**Cross-referenced**: `project-io.ts`, `import-validator.ts`, `staged-importer.ts`, `import-operation.model.ts`, `shared-auth/` middleware, database models

---

## Critical Vulnerabilities (Must Fix Before Implementation)

### [VULN-1] DNS Rebinding Bypasses SSRF Validation (Severity: HIGH)

- **Attack vector**: The SSRF validator in Section 4.4.2 performs hostname checks at validation time only. An attacker crafts a webhook URL like `http://evil-rebind.attacker.com/callback` that initially resolves to a public IP during validation, then rebinds to `169.254.169.254` at actual request time. The plan acknowledges DNS rebinding with a comment ("actual DNS resolution happens at request time -- this is a static heuristic") but offers no mitigation beyond blocking `.local` and `.internal` suffixes.
- **Impact**: SSRF to cloud metadata endpoints, internal service discovery, and data exfiltration from internal networks.
- **Section**: 04-security-validation.md, Section 4.4.2 `checkSSRF()`
- **Mitigation**: Perform DNS resolution at validation time and pin the resolved IP for subsequent use. Alternatively, implement a two-phase check: validate at import time AND re-validate at the network layer when the URL is actually fetched (e.g., using a proxy that blocks private IPs). Consider using a service like a forward proxy with SSRF protections that resolves DNS and checks the IP before establishing the TCP connection.

### [VULN-2] Zod `.passthrough()` Defeats Schema Validation Purpose (Severity: HIGH)

- **Attack vector**: Every entity schema in Section 4.3 uses `.passthrough()` followed by `.transform(stripInternal)`. The `stripInternal` function only removes 7 named fields (`_id`, `__v`, `tenantId`, `projectId`, `createdAt`, `updatedAt`, `status`). Any other unexpected field passes through and gets inserted into MongoDB. An attacker can inject arbitrary fields like `role: "admin"`, `permissions: ["*:*"]`, `isVerified: true`, or any field that downstream code might trust.
- **Impact**: Data model pollution. Injected fields could be consumed by downstream code that reads documents without expecting untrusted content. Depending on which models have loosely typed `Record<string, unknown>` fields, this could enable privilege escalation or behavioral manipulation.
- **Section**: 04-security-validation.md, Section 4.3 (all `Imported*Schema` definitions)
- **Mitigation**: Replace `.passthrough().transform(stripInternal)` with `.strict()` (which rejects unknown keys) or `.strip()` (which silently removes unknown keys). If certain layers genuinely need extensibility (e.g., connector config), use an explicit `additionalProperties: z.record(z.unknown())` field rather than `.passthrough()` on the root object. This contains unknown data within a named field rather than mixing it with known fields.

### [VULN-3] `scanObject` Recursion in SSRF/Injection/Secret Scanners Has No Depth Limit (Severity: HIGH)

- **Attack vector**: The `scanObject`, `scanForInjection`, `scanForSecrets`, and `scanForRedacted` functions in Section 4 all recurse into nested objects without any depth limit. An attacker crafts a JSON file with 10,000+ levels of nesting (e.g., `{"a":{"a":{"a":...}}}`) that stays within the 1MB file size limit but causes stack overflow during scanning.
- **Impact**: Denial of service via worker crash (stack overflow). The import worker process dies, affecting all concurrent imports on that pod. With 3 concurrent workers per pod, a single malicious payload can take down all import capacity.
- **Section**: 04-security-validation.md, Sections 4.4.2-4.4.5 (all recursive scan functions)
- **Mitigation**: Add a `MAX_RECURSION_DEPTH` parameter (e.g., 32) to all recursive scanning functions. Track current depth and refuse to recurse beyond the limit, treating deep nesting as a security finding. Additionally, add a JSON nesting depth check early in the pipeline before parsing, using a simple character-counting approach that rejects files exceeding the nesting threshold.

### [VULN-4] Tenant Isolation Check Has Conditional Logic Flaw (Severity: CRITICAL)

- **Attack vector**: The `verifyTenantIsolation` function in Section 4.4.7 checks `if (data.tenantId && data.tenantId !== expectedTenantId)`. The condition `data.tenantId &&` means that records **without** a `tenantId` field pass the check silently. The disassemblers are supposed to inject `tenantId` from the server-side context, but if a disassembler bug omits it, the record gets inserted without tenant scoping. Any subsequent query that filters by `tenantId` would miss this orphaned record, but queries without tenant filtering could expose it cross-tenant.
- **Impact**: Records inserted without `tenantId` become invisible to their owning tenant (data loss) or visible to queries that do not filter by tenant (data leakage). The `tenantIsolationPlugin` in Mongoose models may catch this at the model level, but the defense-in-depth check should not have this gap.
- **Section**: 04-security-validation.md, Section 4.4.7
- **Mitigation**: Change the check to verify that `tenantId` IS present AND matches. Records without `tenantId` should be flagged as violations. The check should be: `if (!data.tenantId || data.tenantId !== expectedTenantId)`. Same for `projectId`. Also verify that the `tenantIsolationPlugin` applied to the `ImportOperation` model enforces `tenantId` as required at the Mongoose layer (confirmed in `import-operation.model.ts` -- `tenantId: { type: String, required: true }` exists).

### [VULN-5] Import Operation Status Endpoint Lacks Tenant Scoping (Severity: HIGH)

- **Attack vector**: Section 5 defines the status endpoint `GET /api/projects/:projectId/project-io/import/v2/status/:operationId`. If the query to fetch the import operation uses `findOne({ _id: operationId })` without including `tenantId` in the filter, a user from tenant A who guesses or enumerates `operationId` values can view import status (including error messages, layer names, entity counts) belonging to tenant B.
- **Impact**: Information disclosure of project structure, entity types, and error messages across tenants. The `operationId` uses UUIDv7 which is time-ordered and partially predictable.
- **Section**: 05-performance-queueing.md, Section 2.4 (Status API Endpoint)
- **Mitigation**: Ensure the status query always includes `tenantId` and `projectId` in the filter: `ImportOperation.findOne({ _id: operationId, projectId, tenantId })`. The existing `import-operation.model.ts` has `tenantIsolationPlugin` applied, which should auto-inject `tenantId` into queries if configured correctly. Verify this behavior and add an explicit `tenantId` filter as defense-in-depth. Additionally, the plan should show the route handler code including these filters.

---

## Data Integrity Risks

### [INT-1] Fuzzy Auth Profile Matching Can Silently Wire Wrong Credentials (Severity: HIGH)

- **Scenario**: The auth profile resolver in Section 4.2 performs fuzzy matching with a 0.7 threshold. If an exported connection referenced a "Salesforce Production" auth profile and the target environment has a "Salesforce Staging" profile, the fuzzy matcher would match on `authType: oauth2`, `scope: tenant`, `connector: salesforce` with a combined score of 0.9. The import would silently wire the production connection to staging credentials, potentially exposing staging data to production users or vice versa.
- **Impact**: Production connections wired to staging credentials (or vice versa) leading to data being sent to wrong environments, authentication failures at runtime, or silent data routing to unintended destinations.
- **Mitigation**: Fuzzy-matched auth profiles should NEVER be auto-applied. They should only appear as "suggested mappings" in the preview step, requiring explicit user confirmation. Only `exact_name` matches (confidence 1.0) should be auto-applied. Change the fuzzy match flow to: detect candidates, present to user in preview, require explicit selection before import proceeds.

### [INT-2] Rollback Cannot Fully Restore Pre-Import State (Severity: MEDIUM)

- **Scenario**: During Phase 3 (activation), layer A activates successfully (staged records become active, old records become superseded). Layer B fails. Rollback reverses layer A by marking staged as deleted and superseded as active. However, the `activateLayer` in `staged-importer.ts` performs a bulk status swap. If any additional writes happened to layer A's records between activation and rollback (e.g., a user editing an agent that was just imported), the rollback would overwrite those changes by restoring the superseded version.
- **Impact**: User edits made during the brief activation-to-rollback window are silently lost.
- **Mitigation**: The per-project distributed lock already prevents concurrent imports, but does not prevent user edits via the normal Studio UI. Document that during import, the project should be in a "read-only" or "importing" state that blocks writes from other sources. Alternatively, use optimistic locking (version numbers) on records to detect and fail the rollback if records were modified since activation.

### [INT-3] Duplicate Entity Names Within a Single Import Are Not Validated (Severity: MEDIUM)

- **Scenario**: An import file set contains two agent files: `agents/booking.agent.abl` and `agents/Booking.agent.abl` (differing only in case). Or two tool files with the same `name` field. The plan's schema validation checks individual files but does not validate uniqueness across files within the same import.
- **Impact**: Both records get staged and activated, creating duplicate entities in the project. Downstream lookups by name may behave unpredictably (returning the first match, or failing with "multiple results").
- **Mitigation**: Add a uniqueness check during the disassembly phase that collects entity names per collection and rejects duplicates. This should be case-insensitive for entities that use name-based lookups.

### [INT-4] Circular Agent Handoff References Not Validated (Severity: LOW)

- **Scenario**: Agent A's DSL contains `HAND_OFF: AgentB` and Agent B contains `HAND_OFF: AgentA`. The existing `validateCrossLayerDeps` checks agent-to-tool references but does not detect circular agent-to-agent handoff chains. While circular handoffs may be intentional (ping-pong), deeply circular chains could cause infinite loops at runtime.
- **Impact**: Imported projects may enter infinite agent handoff loops at runtime, consuming LLM credits and conversation resources.
- **Mitigation**: Add a cycle detection pass during cross-layer validation. Circular references should be flagged as warnings (not blocking), since some circular patterns are valid (e.g., supervisor routing back to specialist).

### [INT-5] `ImportFileStore` in MongoDB Not Encrypted at Rest (Severity: MEDIUM)

- **Scenario**: Import payloads stored in MongoDB's `ImportFileStore` collection contain the full project configuration including DSL content, connection configs (with redacted secrets), and entity definitions. If MongoDB at-rest encryption is not enabled, these files are readable from disk. The plan stores them as gzip-compressed BSON binary but compression is not encryption.
- **Impact**: Exposure of project configuration data from MongoDB disk access or backups.
- **Mitigation**: Document that MongoDB at-rest encryption (via WiredTiger encryption or dm-crypt) is a prerequisite for this feature. Add a startup check that verifies encryption is enabled, or at minimum log a warning. Consider encrypting the `compressedFiles` field with a DEK before storage using the platform's existing `dek-registry` pattern.

---

## Authorization Gaps

### [AUTH-1] Per-Layer Permission Checks Only At Prerequisite Time, Not At Write Time

- **Description**: Section 4.1 validates per-layer permissions (`guardrail:write`, `connector:write`, etc.) during the prerequisite check at import initiation. However, the async BullMQ worker that actually writes data does not re-check permissions. For long-running imports, a user's permissions could be revoked between import initiation and worker execution (e.g., admin removes their `guardrail:write` role). The worker would still write guardrail data.
- **Impact**: Users whose permissions were revoked after import initiation can still have data written on their behalf.
- **Mitigation**: Re-check permissions at the start of the worker execution phase, not just at the API request phase. Store the required permissions in the `ImportOperationState` and verify them when the worker picks up the job. If permissions were revoked, fail the import with a clear message.

### [AUTH-2] Import Operation Status Endpoint Does Not Verify Ownership

- **Description**: The status endpoint in Section 5, Section 2.4 returns import operation details. The plan does not specify whether any user in the project can view any import operation, or only the user who initiated it. The `ImportOperationStateV2` stores `userId` but the query does not filter by it.
- **Impact**: User A can view the import status of User B's import, potentially leaking information about what was imported (entity names, error messages containing data).
- **Mitigation**: For non-admin users, filter by `userId` in addition to `projectId` and `tenantId`. Project admins should be able to see all imports. Define a permission like `project:import:read` for viewing others' import operations.

### [AUTH-3] DLQ Admin Endpoints Lack Permission Specification

- **Description**: Section 5, Section 5.5 defines `GET /api/admin/import/v2/dlq` and `POST /api/admin/import/v2/dlq/:jobId/retry` endpoints. The plan does not specify what authentication/authorization these require. If they use the same `project:import` permission, any project user could inspect and re-enqueue dead-lettered imports from other tenants.
- **Impact**: Cross-tenant data access via DLQ inspection. Re-enqueueing a dead-lettered import from another tenant into the active queue.
- **Mitigation**: These must use `requirePlatformAdmin()` middleware (not tenant-level permissions). DLQ operations are infrastructure-level concerns, not project-level.

### [AUTH-4] Non-Admin Users Can Import Connections Referencing Tenant-Scoped Auth Profiles

- **Description**: The prerequisite check in Section 4.1 validates that required auth profiles exist but does not check whether the importing user has permission to USE those auth profiles. Tenant-scoped auth profiles may be restricted to certain users/roles. A user with `project:import` permission but without access to a specific OAuth credential could import a connection that references it.
- **Impact**: Privilege escalation -- users gain indirect access to credentials they should not be able to use.
- **Mitigation**: Add a visibility check during auth profile resolution. If the auth profile has `visibility: 'personal'`, verify that the importing user is the owner. If `visibility: 'shared'`, check that the user has `connector:write` permission on the relevant connector type.

---

## Missing Security Controls

### [SEC-1] No JSON Nesting Depth Limit Before Parsing

- **Where**: Section 4.3 schema validation happens after `JSON.parse()`. A deeply nested JSON file (100,000 levels) will crash `JSON.parse()` with a stack overflow BEFORE any schema validation runs.
- **Fix**: Add a pre-parse nesting depth check. Scan the raw string for `{` and `[` characters, tracking depth. Reject files exceeding a threshold (e.g., 50 levels) before calling `JSON.parse()`.

### [SEC-2] No Rate Limit on Import Preview Endpoint

- **Where**: Section 5, Section 4.5 defines rate limiting for the import API (10 requests/minute/tenant). However, the import preview endpoint (`POST /import/preview`) is not explicitly called out as covered. Preview involves file parsing, schema validation, dependency checking, and security scanning -- all CPU-intensive. Rapid preview requests could exhaust compute.
- **Fix**: Ensure the import rate limit applies to both `/import/preview` and `/import` endpoints. Consider a stricter sub-limit for preview since it is a read-only operation users might poll repeatedly.

### [SEC-3] No Validation of `userMappings` IDs in Auth Profile Resolution

- **Where**: Section 4.2, `resolveAuthProfiles()` accepts `userMappings?: Record<string, string>` where values are auth profile `_id` strings provided by the user. The function looks up `activeProfiles.find(p => p._id === mappedId)` which is safe, but if a user provides an auth profile ID from a different tenant, and the query to fetch `targetProfiles` was not properly scoped, the lookup would fail silently (no match). However, if the target profile query leaks cross-tenant data, the user could map to another tenant's credential.
- **Fix**: Ensure the query that populates `targetProfiles` always includes `tenantId` in its filter. Add explicit validation: `if (!targetProfiles.find(p => p._id === mappedId)) throw new Error('Invalid mapping')`.

### [SEC-4] Injection Guard Does Not Check Field Values for `$` Operators

- **Where**: Section 4.4.3 `scanForInjection()` checks keys starting with `$` but does not check string values that might be used in `$where` clauses or regex injections. A field like `{ "name": { "$regex": ".*", "$options": "si" } }` would be caught because `$regex` is a key. But if a value like `{ "filter": "{ $where: 'sleep(5000)' }" }` is stored as a string that later gets parsed and used in a query, the injection guard would miss it.
- **Impact**: Second-order NoSQL injection if imported data is later used in query construction.
- **Fix**: Add a warning (not blocking) for string values that contain MongoDB operator patterns. Also audit all downstream code that uses imported data in queries to ensure parameterized queries are used.

### [SEC-5] No Content-Type Enforcement on Import Payloads

- **Where**: The existing `project-io.ts` uses `express.json({ limit: '60mb' })` which implicitly requires `Content-Type: application/json`. However, the plan does not discuss what happens if a request sends `Content-Type: multipart/form-data` or `text/plain`. Express will reject non-JSON content types, but explicit validation is a defense-in-depth measure.
- **Fix**: Add explicit Content-Type validation middleware before the body parser.

### [SEC-6] XSS Via Imported Entity Descriptions Rendered in Studio UI

- **Where**: Section 2 and Section 3 disassemblers parse descriptions from imported entities (agent descriptions, tool descriptions, guardrail descriptions). These are stored in MongoDB and rendered in the Studio UI. If a description contains `<script>alert('xss')</script>` or SVG-based XSS payloads, and the UI renders them without sanitization, XSS is possible.
- **Fix**: Add HTML sanitization to all user-facing string fields during import (or ensure the Studio UI consistently escapes all rendered content). The Zod schemas in Section 4.3 validate max length but do not sanitize HTML.

### [SEC-7] No Maximum Entity Count Per Layer

- **Where**: The `V2_IMPORT_LIMITS` in Section 4.4.6 sets `maxFileCount: 2000` for the total import. But there is no per-layer entity count limit. An attacker could create 1,999 guardrail files (each 256KB) totaling ~500MB of guardrail configs for a single project, overwhelming the guardrail evaluation pipeline at runtime.
- **Fix**: Add per-layer entity count limits (e.g., max 100 agents, max 200 tools, max 50 guardrails, max 10,000 vocabulary entries). These should align with existing platform limits on entity creation.

---

## Positive Security Measures

The plan demonstrates strong security awareness in several areas:

1. **Server-side `tenantId`/`projectId` injection**: The `DisassembleContext` in Section 3 correctly receives `tenantId` and `projectId` from the server-side route context, not from the imported file content. The `stripInternal` function removes any `tenantId`/`projectId` from imported JSON before these are re-injected server-side.

2. **Three-tier SHA integrity verification**: Section 1's lockfile verification (root hash, per-layer hashes, per-file hashes) provides strong tamper detection for import files modified after export.

3. **Distributed lock for concurrent import protection**: Both v1 (`project-io.ts`) and v2 (Section 5) use Redis `SET NX` with atomic Lua release scripts to prevent concurrent imports on the same project.

4. **Redacted value handling**: Section 4.5's approach of detecting `***REDACTED***` sentinels, replacing them with empty strings, and marking connections as needing credential setup is well-designed. The sentinel is never stored in the database.

5. **Secret detection**: Section 4.4.4's pattern-based secret detection covers AWS keys, JWT tokens, GitHub tokens, private keys, and generic API keys. The truncated preview (first 8 chars only) prevents accidental secret exposure in logs.

6. **Existing auth middleware chain**: The current `project-io.ts` correctly chains `authMiddleware`, `requireProjectScope`, `tenantRateLimit`, and `requireProjectPermission` -- and the plan builds on this foundation for v2.

7. **Staged import with rollback**: The three-phase model (stage, activate, cleanup) with per-layer rollback in `staged-importer.ts` provides good atomicity guarantees at the layer level.

8. **Path traversal prevention**: Both v1 (existing `validateImportPayload`) and v2 (Section 4.4.5 `validateV2FilePath`) check for `..`, leading `/`, null bytes, backslashes, and restrict paths to known layer folders.

9. **Per-tenant rate limiting for imports**: Section 5's multi-layer rate limiting (per-project lock, per-tenant concurrent limit, per-project cooldown, API rate limit) provides defense-in-depth against import flooding.

10. **Comprehensive threat model**: Section 4.4.1 explicitly enumerates threats including SSRF, NoSQL injection, template injection, secret leakage, path traversal, tenant escape, DoS, privilege escalation, and zip bombs -- indicating the designers thought adversarially.

---

## Verdict

**PASS WITH CONDITIONS**

The plan demonstrates strong security fundamentals -- server-side identity injection, staged rollback, distributed locking, comprehensive threat modeling, and multi-layer rate limiting. However, five issues must be resolved before implementation:

1. **VULN-2** (Zod `.passthrough()` defeats schema validation) -- this is the most impactful gap since it undermines the entire schema validation layer. Switch to `.strict()` or `.strip()`.
2. **VULN-4** (Tenant isolation check conditional logic flaw) -- change to `!data.tenantId || data.tenantId !== expected` to catch missing fields.
3. **VULN-5** (Status endpoint tenant scoping) -- ensure all operation queries include `tenantId` and `projectId`.
4. **VULN-3** (Unbounded recursion in scanners) -- add depth limits to prevent stack overflow DoS.
5. **INT-1** (Fuzzy auth profile matching auto-applied) -- fuzzy matches must require user confirmation, not be silently auto-wired.

The remaining findings (AUTH-1 through AUTH-4, SEC-1 through SEC-7, INT-2 through INT-5) are important hardening items that should be addressed during implementation but do not block the design approval.
