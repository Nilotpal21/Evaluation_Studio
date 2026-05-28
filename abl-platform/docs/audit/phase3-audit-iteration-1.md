# Phase 3 Audit — Iteration 1

**Date:** 2026-03-18
**Reviewer:** LLD Architecture Reviewer
**Scope:** Tasks 3.1-3.10, Integration Scenarios IS-3.1 through IS-3.10
**Branch:** develop

---

## VERDICT: NEEDS_CHANGES

---

## ISSUES

### CRITICAL

**C1. `console.error` in audit trail plugin — violates logging standard**

The `audit-trail.plugin.ts` at line 245 uses `console.error` instead of `createLogger`. This is the exact same class of issue that Task 1.13 was supposed to fix for MCP server registry. Audit trail is a security-sensitive code path.

- File: `packages/database/src/mongo/plugins/audit-trail.plugin.ts:245`
- Fix: Import `createLogger('audit-trail-plugin')` and replace `console.error(...)` with `log.error(...)`. The plugin already imports from `node:async_hooks` and `mongoose`, so adding the logger import is straightforward.

---

**C2. Audit trail redaction tests are empty — `expect(true).toBe(true)` assertions**

Two of the three test cases in `packages/database/src/__tests__/audit-trail-redaction.test.ts` contain only `expect(true).toBe(true)`. These are not real assertions. The `sanitizeChanges` function is not exported, but it is testable via the `setAuditHandler` mechanism that IS exported — the test file already imports it but never uses it for the actual redaction tests (lines 45-63).

- File: `packages/database/src/__tests__/audit-trail-redaction.test.ts:45-63`
- Fix: Use `setAuditHandler` to capture audit entries, then trigger a Mongoose save or findOneAndUpdate operation on a model with `encryptedSecrets` in the changes. Assert that the captured entry has `[REDACTED]` for encrypted fields and real values for non-sensitive fields. If a DB connection is impractical in unit tests, export `sanitizeChanges` as a named export and test it directly.

---

**C3. VoiceServiceFactory cache `Map` has no max size or eviction limit**

The `VoiceServiceFactory` at line 40 declares `private cache: Map<string, CachedService> = new Map()` with a TTL (`CACHE_TTL_MS = 10min`) but no maximum entry count. Per platform invariant, every in-memory `Map` needs max size, TTL, and eviction. In a multi-tenant runtime with thousands of tenants, this Map grows unbounded.

- File: `apps/runtime/src/services/voice/voice-service-factory.ts:40`
- Fix: Add a `MAX_CACHE_SIZE` constant (e.g., 200) and evict oldest entries when the limit is reached, similar to `AuthProfileCache` (LRU, 200 entries, 5min TTL) already established in this codebase.

---

### HIGH

**H1. Bulk API consumer count query missing `projectId` filter (project-scoped route)**

In the project-scoped bulk route (`apps/studio/src/app/api/projects/[id]/auth-profiles/bulk/route.ts`), the cascade consumer check at lines 139-141 filters by `authProfileId + tenantId` but does NOT include `projectId`. This means a consumer in a different project could block deletion. The tenant-scoped route correctly uses `tenantId` only (which is correct for tenant scope), but the project-scoped route should also filter consumers by `projectId` where applicable.

- File: `apps/studio/src/app/api/projects/[id]/auth-profiles/bulk/route.ts:139-141`
- Fix: Add `projectId` to the consumer count query filter: `{ [field ?? 'authProfileId']: profileId, tenantId, projectId }`. Note: some consumer models may be tenant-scoped (not project-scoped), so this needs a per-model check. Consider adding a `projectScoped: boolean` flag to `CONSUMER_CHECKS`.

---

**H2. mTLS `rejectUnauthorized: true` not enforced — delegated to caller without guarantee**

The spec says (Task 3.1): "creates `new https.Agent({ cert, key, ca, rejectUnauthorized: true })`". However, `resolve-tool-auth.ts` only returns `tlsOptions: { cert, key, ca? }` — it does NOT include `rejectUnauthorized`. The comment says "caller creates https.Agent with these", but there is no enforcement that the caller sets `rejectUnauthorized: true`. The mTLS metadata in `auth-type-metadata.ts` defines a `rejectUnauthorized` config field (line 248-253), but the resolver does not read `profile.config.rejectUnauthorized`.

- File: `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts:134-146`
- Fix: Either (a) include `rejectUnauthorized` in the `tlsOptions` return type and populate it from `profile.config.rejectUnauthorized ?? true`, or (b) create the `https.Agent` inside resolve-tool-auth and return it directly (preferred, since it prevents callers from forgetting). The `ToolAuthResult.tlsOptions` type should include `rejectUnauthorized: boolean`.

---

**H3. Bulk route permissions use `hasAnyPermission` — both WRITE and DELETE should be required for delete action**

Both bulk routes request `permissions: [StudioPermission.AUTH_PROFILE_WRITE, StudioPermission.AUTH_PROFILE_DELETE]`. Looking at the `withRouteHandler` code (line 162-163), when multiple permissions are provided, it uses `hasAnyPermission` (OR logic). This means a user with only WRITE permission can perform bulk deletes. The delete action should require DELETE permission specifically.

- File: `apps/studio/src/app/api/auth-profiles/bulk/route.ts:57` and `apps/studio/src/app/api/projects/[id]/auth-profiles/bulk/route.ts:58`
- Fix: Check permissions inside the handler based on the action: `if (action === 'delete')` require `AUTH_PROFILE_DELETE`; otherwise require `AUTH_PROFILE_WRITE`. Or split into separate permission checks per action within the handler body.

---

**H4. Bulk revoke does not check current status — can "revoke" already-expired profiles**

The spec IS-3.5 says: "Bulk revoke 1 expired profile -> status stays expired (can't revoke what's already expired) or returns error." But the current implementation (lines 167-172 in both routes) blindly sets `status: 'revoked'` without checking the current status. An expired profile would be silently changed to revoked.

- File: `apps/studio/src/app/api/auth-profiles/bulk/route.ts:167-172` (and project-scoped equivalent)
- Fix: After finding the profile, check `profile.status`. If status is `expired`, skip the revoke and return `{ status: 'error', error: 'Cannot revoke expired profile' }`. Similarly for activate — should not activate an expired profile.

---

### MEDIUM

**M1. SDKChannel encryption test is weak — only checks schema paths exist**

The test in `packages/database/src/__tests__/sdk-channel-encryption.test.ts` only verifies that schema paths like `ire`, `cek`, `iv`, `kmsKeyId` exist. It does not verify that the `fieldsToEncrypt` actually includes `secretKey`. The test at line 26-30 acknowledges the default may be empty and says "that's okay" — but this defeats the purpose of testing that encryption is applied to `secretKey`.

- File: `packages/database/src/__tests__/sdk-channel-encryption.test.ts:21-31`
- Fix: Verify the plugin was called with `{ fieldsToEncrypt: ['secretKey'] }` by checking `SDKChannelSchema.options` or by actually testing that a saved document has its `secretKey` encrypted. The model source at `sdk-channel.model.ts:69` confirms `encryptionPlugin` is applied with `{ fieldsToEncrypt: ['secretKey'] }`.

---

**M2. Duplicate code between tenant-scoped and project-scoped bulk routes**

The two bulk route files are nearly identical (197 lines each), with the only differences being: (1) `requireProject: true`, (2) `projectId` in queries, and (3) `scope: 'tenant'` filter. This violates DRY. If the CONSUMER_CHECKS list changes (which it will as models are added), both files must be updated in lockstep.

- File: Both bulk route files
- Fix: Extract shared logic into a `executeBulkAction(profileIds, tenantId, projectId?, scope?)` helper in a shared module (e.g., `apps/studio/src/lib/auth-profile-bulk.ts`). Each route becomes a thin wrapper.

---

**M3. mTLS test does not verify certs are NOT logged**

The spec says (IS-3.1) that certs should not be logged. The test at `apps/runtime/src/__tests__/auth-profile-mtls-tool-executor.test.ts` verifies cert values are returned correctly but does not assert that `log.debug`/`log.info` calls do NOT include cert content. This is a security requirement from the spec.

- File: `apps/runtime/src/__tests__/auth-profile-mtls-tool-executor.test.ts`
- Fix: After resolving mTLS auth, assert that `log.debug` and `log.info` mock calls do not contain cert/key content. Example: `expect(JSON.stringify(logDebugMock.mock.calls)).not.toContain('MOCK_KEY')`.

---

**M4. CredentialAgeMonitor test uses `rotationStartedAt` in mock data but actual code uses `rotatedAt`**

The test mock at line 70 sets `rotationStartedAt: oldDate` but the `CredentialAgeMonitor.checkAll()` code at line 68 uses `cred.rotatedAt ?? cred.createdAt` as the effective date. The `findAuthProfileCandidates` query at line 129 does query `rotationStartedAt`, but the age calculation in `checkAll` uses `rotatedAt`. The test at line 69 sets `rotatedAt: null`, so it falls through to `createdAt`, which works by coincidence but does not actually test the `rotationStartedAt` scenario described in IS-3.10.

- File: `apps/runtime/src/__tests__/auth-profile-credential-age-monitor.test.ts:61-86` and `apps/runtime/src/services/credential-age-monitor.ts:68`
- Fix: Either (a) the monitor code should use `rotationStartedAt ?? rotatedAt ?? createdAt` as the effective date (matching the spec), or (b) the test should set `rotatedAt` to the old date instead of relying on `createdAt` fallback. The spec (IS-3.10) specifically says "rotationStartedAt 30 days ago -> flags as stale", implying `rotationStartedAt` should be the effective date for age calculation.

---

## VERIFIED

- [x] **Architecture compliance** -- tenant isolation on every bulk query (findOne, findOneAndDelete, findOneAndUpdate all include tenantId). Cross-scope returns "Profile not found" (404 equivalent in per-item results). Auth via `withRouteHandler` (not custom token verification). Stateless (no pod-local state issues).
- [x] **Pattern consistency** -- uses `createLogger` (except audit-trail.plugin.ts flagged above). Error handling follows `err instanceof Error ? err.message : String(err)`. Response format `{ success, data }` on bulk routes. Zod validation uses `z.string().min(1)` for IDs (not `.cuid()`).
- [x] **Completeness** -- All 10 tasks (3.1-3.10) have corresponding implementation files. All 10 integration scenarios (IS-3.1 through IS-3.10) have test coverage (with quality caveats noted above).
- [x] **Domain rules** -- TokenManager dual-read pattern follows existing `dualReadCredentials` convention. CredentialAgeMonitor queries AuthProfile alongside existing credential types. Voice cache invalidation uses Redis pub/sub pattern.
- [x] **File verification** -- All 8 new files exist and are readable. All 6 modified files confirmed with matching signatures: `resolveToolAuth()`, `CredentialAgeMonitor`, `VoiceServiceFactory.invalidate()`, `VoiceServiceFactory.subscribeToAuthProfileEvents()`, `TokenManager.getAccessToken()`, `sanitizeChanges()`.

---

## INTEGRATION SCENARIO COVERAGE

| Scenario                           | Status  | Notes                                                                                    |
| ---------------------------------- | ------- | ---------------------------------------------------------------------------------------- |
| IS-3.1: mTLS tool call e2e         | PARTIAL | tlsOptions returned but `rejectUnauthorized` missing (H2). No https.Agent creation test. |
| IS-3.2: Studio mTLS creation       | PASS    | `auth-type-metadata.ts` has mtls entry with cert/key/ca fields.                          |
| IS-3.3: Bulk delete mixed outcomes | PASS    | Test covers mixed success/error results with cascade check.                              |
| IS-3.4: Bulk tenant isolation      | PASS    | Test verifies cross-tenant profile returns "not found".                                  |
| IS-3.5: Bulk revoke/activate       | PARTIAL | Missing status pre-check for expired profiles (H4).                                      |
| IS-3.6: Bulk action limits         | PASS    | Zod `.max(50)` and `.min(1)` enforce limits. Test covers >50 and 0.                      |
| IS-3.7: SDKChannel encryption      | PARTIAL | Plugin applied correctly in model. Test is weak (M1).                                    |
| IS-3.8: TokenManager AuthProfile   | PASS    | Dual-read implemented with fallback. Wiring gap detection present.                       |
| IS-3.9: Audit trail redaction      | PARTIAL | `sanitizeChanges` implemented. Tests are empty stubs (C2).                               |
| IS-3.10: Credential age monitoring | PARTIAL | AuthProfile query present but `rotationStartedAt` vs `rotatedAt` mismatch (M4).          |

---

## NOTES

- The `CONSUMER_CHECKS` list has 17 entries across both bulk routes. If Phase 1 Task 1.3 already has a cascade check implementation, consider extracting it to a shared utility to avoid triple maintenance (single delete + tenant bulk + project bulk).
- The `VoiceServiceFactory` pre-existing max-size issue (C3) is not new to Phase 3 but is surfaced by the cache invalidation work in Task 3.10. It should be fixed as part of this phase since the invalidation work touches the same code.
- The `TokenManager` auth profile path (Task 3.7) correctly throws `AUTH_PROFILE_RESOLVER_MISSING` when `authProfileId` is set but no resolver is injected. This is good defensive design but callers of `TokenManager` need to be updated to inject the resolver -- verify this wiring in the connector packages.
- The `secretKey` field on SDKChannel (Task 3.6) is correctly encrypted via `encryptionPlugin` at model level (`sdk-channel.model.ts:69`). Backward compatibility with existing plain-text values depends on the encryption plugin's behavior on read -- verify the plugin handles unencrypted values gracefully (dual-read or migration script).
