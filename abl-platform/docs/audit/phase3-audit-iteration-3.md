# Phase 3 Audit — Iteration 3

**Date:** 2026-03-18
**Auditor:** Claude Agent
**Verdict:** NEEDS_CHANGES

## Critical Fix Verification

| Finding                                    | Status | Evidence                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1: console.error in audit-trail.plugin.ts | FIXED  | Line 196 now uses `process.stderr.write(...)`. No `console.error` or `console.log` anywhere in file. Grep returns zero matches.                                                                                                                                                                                                                                                               |
| C2: sanitizeChanges export                 | FIXED  | Line 217: `export function sanitizeChanges(...)`. Test file `packages/database/src/__tests__/audit-trail-redaction.test.ts` imports it (line 12) and has 6 real test cases with substantive assertions (redact direct fields, redact `$set`/`$unset` operators, pass-through non-sensitive, undefined input).                                                                                 |
| C3: Voice cache bounds                     | FIXED  | Line 38: `const MAX_CACHE_ENTRIES = 100;`. Lines 264-269: LRU eviction when `this.cache.size >= MAX_CACHE_ENTRIES` (deletes oldest via `Map.keys().next()`). Lines 234-239: LRU re-insertion on cache hit. `void err` on line 98 still present but was NOT part of the C3 finding (C3 was about `void err` in the cache/eviction code path, which is fixed — line 302 now uses `log.warn()`). |

## Additional Check Results

### 1. Bulk Actions Routes — PASS

**Tenant-scoped** (`apps/studio/src/app/api/auth-profiles/bulk/route.ts`):

- Zod schema enforces `.max(50)` on `profileIds` array (line 26)
- Runtime guard also checks `profileIds.length > 50` (line 43) — belt-and-suspenders
- Each profile verified individually with `findOne({ _id, tenantId, projectId: null, scope: 'tenant' })` (line 67-71)
- Returns `{ success: true, data: { results } }` (line 98-100)

**Project-scoped** (`apps/studio/src/app/api/projects/[id]/auth-profiles/bulk/route.ts`):

- Same Zod `.max(50)` constraint (line 27)
- Same runtime guard (line 48)
- Each profile verified with `findOne({ _id, tenantId, projectId })` (line 73-76)
- Proper response shape (line 104-107)

**Shared handler** (`_bulk-handler.ts`): Well-structured with cascade consumer checks across 17 model types.

### 2. mTLS Wiring — PASS

`apps/runtime/src/services/auth-profile/resolve-tool-auth.ts`:

- `ToolAuthResult` interface includes `tlsOptions?: { cert, key, ca?, rejectUnauthorized: true }` (line 26)
- `case 'mtls':` at line 121 correctly skips header injection
- Lines 134-146: Builds `tlsOptions` from `profile.secrets.clientCert`, `clientKey`, optional `caCert`
- `rejectUnauthorized: true` hardcoded (line 140) — cannot be overridden by profile data
- Tests verify all paths: with/without CA, rejectUnauthorized always true, non-mtls profiles excluded

### 3. SDK Channel Encryption — NOT IMPLEMENTED

`packages/database/src/models/sdk-channel.model.ts`:

- `secretKey` field is `{ type: String, default: null }` (line 53)
- NO encryption plugin applied. Only `tenantIsolationPlugin` is used (line 67)
- The `secretKey` stores HMAC secrets for identity verification. These are sensitive credentials that should be encrypted at rest.
- **Severity: MEDIUM** — This was listed as a Phase 3 deliverable. The field exists but has no field-level encryption.

### 4. Credential Age Monitor — PARTIAL

`apps/runtime/src/services/credential-age-monitor.ts`:

- `rotationStartedAt` is NOT queried or used anywhere in this file. Grep returns zero matches.
- The `CredentialRecord` interface (line 18-24) includes `rotatedAt` but not `rotationStartedAt`.
- The monitor uses `rotatedAt` as the effective date for age calculation (line 68), which is correct for completed rotations.
- However, if `rotationStartedAt` is set on an AuthProfile (indicating rotation is in progress), the monitor should factor this in — a profile currently being rotated should not fire stale-credential alerts.
- **Severity: LOW** — Functional but may produce false-positive alerts during active rotation windows.

### 5. Test Quality — PASS

**mTLS tests** (`apps/runtime/src/__tests__/auth-profile-mtls-tool-executor.test.ts`):

- 7 test cases with real assertions
- Tests: tlsOptions present for mtls, absent for non-mtls, ca optional, rejectUnauthorized=true, secrets available, cert content not in headers
- Proper mock setup with `vi.mock` for database models and logger

**Bulk actions tests** (`apps/studio/src/__tests__/api-auth-profile-bulk.test.ts`):

- 7 test cases across 4 describe blocks
- Tests: >50 IDs rejected, 0 IDs rejected, successful delete/revoke/activate, cross-tenant 404, cascade protection
- Real assertions on status codes, response shapes, and per-profile results

## New Findings

### NEW-1: `void err` in VoiceServiceFactory.resolveVoiceMode (MINOR)

**File:** `apps/runtime/src/services/voice/voice-service-factory.ts`, line 98
**Issue:** `void err; // DB not available — default to false` — swallows errors silently. While this is in a non-critical fallback path (checking if tenant has a realtime model), the codebase standard is to use `log.warn()` for caught-but-ignored errors.
**Severity:** LOW — Only affects voice mode resolution fallback behavior.

### NEW-2: SDK Channel secretKey not encrypted at rest (MEDIUM)

**File:** `packages/database/src/models/sdk-channel.model.ts`
**Issue:** The `secretKey` field (HMAC secret for identity verification) is stored as plaintext. No encryption plugin is applied to this model. The comment on line 28 says "Encrypted HMAC secret" but the schema has no encryption.
**Severity:** MEDIUM — Credentials stored in plaintext in MongoDB.

## Verdict

**NEEDS_CHANGES** — All 3 critical fixes from iteration 2 are verified as fixed. However, 2 new issues were found:

1. **SDK Channel secretKey encryption** (MEDIUM) — Phase 3 deliverable not implemented
2. **`void err` in voice mode resolver** (LOW) — Coding standard violation

The SDK Channel encryption is the blocking item. The `void err` is a minor cleanup that could be deferred.
