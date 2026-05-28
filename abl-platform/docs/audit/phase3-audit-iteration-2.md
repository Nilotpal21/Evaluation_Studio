# Phase 3 Audit -- Iteration 2

**Date:** 2026-03-18
**Reviewer:** LLD Architecture Reviewer
**Scope:** Verify 3 Critical, 4 High, 4 Medium fixes from Iteration 1
**Branch:** develop

---

## VERDICT: NEEDS_CHANGES

3 Critical issues remain unfixed. 1 Critical has regressed (broken import). All 4 High issues are fixed. 2 of 4 Medium issues are fixed.

---

## FIX VERIFICATION

### CRITICAL -- Status

| ID  | Issue                                                 | Status    | Details                                                                                                                                                                                                                                                                                                                                                            |
| --- | ----------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C-1 | `console.error` in audit-trail.plugin.ts              | NOT FIXED | `console.error` remains on line 195. No `createLogger` import added.                                                                                                                                                                                                                                                                                               |
| C-2 | Audit trail redaction tests have real assertions      | REGRESSED | Tests now have 6 real assertions against `sanitizeChanges` -- good. But `sanitizeChanges` is NOT exported from `audit-trail.plugin.ts`. The test at line 12 does `import { setAuditHandler, sanitizeChanges } from '../mongo/plugins/audit-trail.plugin.js'` but only `setAuditHandler` is exported. This test will fail at import with a module resolution error. |
| C-3 | VoiceServiceFactory cache has MAX_CACHE_ENTRIES + LRU | NOT FIXED | Line 40 still declares `private cache: Map<string, CachedService> = new Map()` with no max size constant, no eviction logic. Only TTL check exists (line 235).                                                                                                                                                                                                     |

### HIGH -- Status

| ID  | Issue                                             | Status | Details                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ----------------------------------------------------------------------- |
| H-1 | Bulk cascade check includes projectId filter      | FIXED  | Project-scoped route passes `consumerFilter: { projectId }` (line 93). `_bulk-handler.ts` applies it to `baseFilter` (lines 73-76). Consumer queries now include `projectId` for project-scoped deletes.                                                                                           |
| H-2 | mTLS tlsOptions includes rejectUnauthorized: true | FIXED  | `resolve-tool-auth.ts` line 140: `tlsOptions = { cert, key, rejectUnauthorized: true }`. Type definition at line 26 also declares `rejectUnauthorized: true` (literal type). Test at line 130-140 asserts `rejectUnauthorized` is `true`.                                                          |
| H-3 | Bulk routes have per-action permission checks     | FIXED  | Both routes now check permissions per-action inside the handler body. Tenant route lines 47-57; project route lines 52-63. Uses `hasPermission(user.permissions, requiredPermission)` where `requiredPermission` is `AUTH_PROFILE_DELETE` for delete and `AUTH_PROFILE_WRITE` for revoke/activate. |
| H-4 | Bulk revoke skips expired/revoked profiles        | FIXED  | `_bulk-handler.ts` lines 104-110: checks `currentStatus === 'expired'                                                                                                                                                                                                                              |     | currentStatus === 'revoked'`and returns`{ status: 'skipped', reason }`. |

### MEDIUM -- Status

| ID  | Issue                                              | Status          | Details                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | -------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M-1 | SDKChannel encryption test has real assertions     | NOT FIXED       | Test still only checks schema paths exist (`ire`, `cek`, `iv`, `kmsKeyId`, `fieldsToEncrypt`, `secretKey`). Does not verify `fieldsToEncrypt` default includes `secretKey`. Same 4 test cases as iteration 1.                                                                                                                                                                                                  |
| M-2 | Shared bulk handler extracted to \_bulk-handler.ts | FIXED           | `apps/studio/src/app/api/auth-profiles/_bulk-handler.ts` contains `executeBulkAction()`, `loadModelMap()`, `CONSUMER_CHECKS[]`, and `BulkResult` type. Both routes import from it.                                                                                                                                                                                                                             |
| M-3 | mTLS test verifies certs not in headers            | PARTIALLY FIXED | Test "cert and key content do not appear in log calls" (line 142) checks that `JSON.stringify(result.headers)` does not contain cert content. However, it does NOT verify the actual logger mock calls -- the test creates new logger spies (lines 143-155) that are separate from the module-level logger mock. The module logger calls are not inspected.                                                    |
| M-4 | CredentialAgeMonitor field name verified correct   | NOT FIXED       | Test at line 61-86 sets `rotationStartedAt: oldDate` in mock data and `rotatedAt: null`. The actual code at `credential-age-monitor.ts:68` uses `cred.rotatedAt ?? cred.createdAt` as the effective date. Since `rotatedAt` is `null`, it falls through to `createdAt` (which is also `oldDate`), so the test passes by coincidence. The `rotationStartedAt` field is never read by the age calculation logic. |

---

## REMAINING ISSUES

### CRITICAL (must fix)

**C-1 (unchanged). `console.error` in audit-trail.plugin.ts**

- File: `/Users/prasannaarikala/projects/agent-platform/packages/database/src/mongo/plugins/audit-trail.plugin.ts:195`
- Fix: Add `import { createLogger } from '@abl/compiler/platform';` and `const log = createLogger('audit-trail-plugin');` at the top. Replace line 195 `console.error(...)` with `log.error(...)`.

**C-2 (regressed). `sanitizeChanges` not exported -- test will fail at import**

- File: `/Users/prasannaarikala/projects/agent-platform/packages/database/src/mongo/plugins/audit-trail.plugin.ts` (missing export)
- File: `/Users/prasannaarikala/projects/agent-platform/packages/database/src/__tests__/audit-trail-redaction.test.ts:12` (imports non-existent export)
- Fix: Add `export` to the `sanitizeChanges` function in `audit-trail.plugin.ts`, OR rename the internal `getModifiedFields` function to handle both direct changes and $set operator patterns, and export it as `sanitizeChanges`. The function needs to exist and be exported for the test to compile.
- Note: The test assertions themselves are now correct (6 real assertions across 6 test cases). The only issue is the missing export.

**C-3 (unchanged). VoiceServiceFactory cache has no max size or eviction**

- File: `/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/services/voice/voice-service-factory.ts:40`
- Fix: Add `const MAX_CACHE_ENTRIES = 100;` constant. In the `getService` method after `this.cache.set(...)` (line 261), add eviction logic:
  ```typescript
  if (this.cache.size > MAX_CACHE_ENTRIES) {
    // Evict oldest entry (first key in Map insertion order)
    const oldestKey = this.cache.keys().next().value;
    if (oldestKey) this.cache.delete(oldestKey);
  }
  ```
  For true LRU, delete-and-reinsert on cache hit (line 236) to move accessed entries to the end.

---

### MEDIUM (recommended)

**M-1 (unchanged). SDKChannel encryption test is weak**

- File: `/Users/prasannaarikala/projects/agent-platform/packages/database/src/__tests__/sdk-channel-encryption.test.ts`
- Fix: Add a test that reads the model source or schema options to verify `fieldsToEncrypt` includes `'secretKey'`. Example:
  ```typescript
  it('fieldsToEncrypt default includes secretKey', () => {
    const schema = SDKChannel.schema;
    const ftePath = schema.path('fieldsToEncrypt');
    const defaultVal = ftePath?.options?.default;
    expect(defaultVal).toContain('secretKey');
  });
  ```

**M-3 (partial). mTLS test does not verify actual logger mock calls**

- File: `/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/__tests__/auth-profile-mtls-tool-executor.test.ts:142-176`
- Fix: The module-level mock at line 16-23 returns `vi.fn()` loggers. Capture these at module scope and assert after `resolveToolAuth` calls:
  ```typescript
  const mockDebug = vi.fn();
  // ... in createLogger mock, return { debug: mockDebug, ... }
  // After test: expect(JSON.stringify(mockDebug.mock.calls)).not.toContain('PRIVATE KEY');
  ```

**M-4 (unchanged). CredentialAgeMonitor test passes by coincidence**

- File: `/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/__tests__/auth-profile-credential-age-monitor.test.ts:61-86`
- File: `/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/services/credential-age-monitor.ts:68`
- Fix: Either (a) update the monitor code to use `cred.rotationStartedAt ?? cred.rotatedAt ?? cred.createdAt` as the effective date, matching the spec intent, OR (b) update the test to set `rotatedAt: oldDate` and `createdAt: new Date()` so the test actually validates the `rotatedAt` path. Currently both `rotatedAt: null` and `createdAt: oldDate` mean `createdAt` is the effective date, making `rotationStartedAt` irrelevant.

---

## VERIFIED (from iteration 1, still valid)

- [x] **H-1 through H-4** -- All 4 High issues fixed correctly
- [x] **M-2** -- Shared bulk handler extraction is clean and complete
- [x] **Architecture compliance** -- tenantId on every query, cross-scope returns 404-equivalent, auth via `withRouteHandler`, stateless design
- [x] **Pattern consistency** -- `err instanceof Error ? err.message : String(err)`, `z.string().min(1)` for IDs, `{ success, data }` response format
- [x] **Task independence** -- `_bulk-handler.ts` is correctly shared between both route files via import

---

## SUMMARY

| Severity | Total | Fixed | Remaining                                       |
| -------- | ----- | ----- | ----------------------------------------------- |
| Critical | 3     | 0     | 3 (C-1 unchanged, C-2 regressed, C-3 unchanged) |
| High     | 4     | 4     | 0                                               |
| Medium   | 4     | 2     | 2 (M-1, M-4 unchanged) + 1 partial (M-3)        |

**Iteration 3 required.** All 3 Critical issues must be resolved before implementation can proceed. The C-2 regression (missing export) is particularly concerning as it means the test file was written without being run.
