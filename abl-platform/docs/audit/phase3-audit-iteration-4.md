# Phase 3 Audit -- Iteration 4 (Final)

**Date:** 2026-03-18
**Auditor:** Lead Architect Agent
**Scope:** Verify iteration-3 fixes (NEW-1, NEW-2) + final sweep of all Phase 3 deliverables
**Verdict:** PASS

---

## Fix Verification

### NEW-1 (LOW): void err in voice-service-factory.ts -- VERIFIED FIXED

**File:** `apps/runtime/src/services/voice/voice-service-factory.ts`, lines 97-101

The `void err;` has been replaced with a proper `log.warn()` call:

```ts
log.warn('Failed to check tenant realtime model availability', {
  tenantId: ctx.tenantId,
  error: err instanceof Error ? err.message : String(err),
});
```

This follows the codebase error-handling convention (`err instanceof Error ? err.message : String(err)`) and uses `createLogger` as required. **FIXED.**

### NEW-2 (MEDIUM): SDK Channel secretKey not encrypted -- VERIFIED FIXED

**File:** `packages/database/src/models/sdk-channel.model.ts`, line 69

The encryption plugin is now applied after the tenant isolation plugin:

```ts
SDKChannelSchema.plugin(tenantIsolationPlugin);
SDKChannelSchema.plugin(encryptionPlugin, { fieldsToEncrypt: ['secretKey'] });
```

The `secretKey` field (line 54) is correctly typed as `String | null` with `default: null`, meaning the plugin will only encrypt when a value is set. **FIXED.**

---

## Final Sweep

### 1. Bulk Actions

#### Tenant-scoped: `apps/studio/src/app/api/auth-profiles/bulk/route.ts`

- **Tenant isolation:** Query includes `tenantId`, `projectId: null`, `scope: 'tenant'` (line 68-71). Correct.
- **Permission check:** Per-action permission gating (DELETE vs WRITE) at line 53-63. Correct.
- **Batch limit:** Zod schema enforces `.max(50)`, plus runtime check at line 48. Redundant but harmless.
- **Error handling:** Per-profile try/catch with structured BulkResult. Correct.
- **No issues.**

#### Project-scoped: `apps/studio/src/app/api/projects/[id]/auth-profiles/bulk/route.ts`

- **Project isolation:** Query includes `tenantId` AND `projectId` (line 73-76). Correct.
- **`requireProject: true`** in route handler config. Correct.
- **Consumer filter:** Passes `{ projectId }` to `executeBulkAction` (line 92). Correct.
- **No issues.**

#### Shared handler: `apps/studio/src/app/api/auth-profiles/_bulk-handler.ts`

- **Consumer checks:** 17 consumer types checked for cascade protection (lines 17-36). Comprehensive.
- **Ownership filter:** Used for all write ops (`findOneAndDelete`, `findOneAndUpdate`). Correct -- never uses `findById`.
- **Revoke skip logic:** Skips already-expired/revoked profiles (line 105). Correct.
- **No issues.**

### 2. mTLS: `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts`

- **mTLS case in switch:** Lines 137-141 -- correctly does not set headers (mTLS uses client certs, not headers).
- **tlsOptions construction:** Lines 151-162 -- extracts `clientCert`, `clientKey`, `caCert` from secrets. `rejectUnauthorized: true` hardcoded. Correct.
- **Return shape:** `tlsOptions` conditionally included in result (line 169). Correct.
- **Config var resolution:** `resolveAuthProfileRef` handles `{{config.VAR}}` templates. Correct.
- **AuthProfileNotFoundError:** Typed error with `jitAuth` flag for downstream handling. Correct.
- **No issues.**

### 3. Audit Trail: `packages/database/src/mongo/plugins/audit-trail.plugin.ts`

- **AsyncLocalStorage actor context:** Clean API (`withAuditActor`, `getCurrentAuditActor`). Correct.
- **Encrypted field masking:** `sanitizeChanges` redacts encrypted fields in both direct changes and `$set`/`$unset` operators. Correct.
- **Custom handler support:** `setAuditHandler(null)` reverts to default. Good for testing.
- **Pre-save tracking:** `$locals._wasNew` and `$locals._wasModified` captured in pre('save') to handle Mongoose 8 behavior. Correct.

**Observations (INFO, not blocking):**

- Line 179: `catch {}` (empty catch) in custom handler path. While this is intentional (audit failures must not block operations), it silently swallows errors. The default path (line 196-198) uses `process.stderr.write` instead of `createLogger`. Both are acceptable for an audit plugin that must not create circular dependencies on the logging infrastructure, and the comment on line 178 documents the intent.
- No TTL index on `audit_logs.createdAt` -- audit logs will grow unbounded. This is a separate concern (operational, not code quality) and should be addressed in a future infrastructure ticket.

### 4. Voice Cache: `apps/runtime/src/services/voice/voice-service-factory.ts`

- **Cache with TTL + max size:** `CACHE_TTL_MS = 10 min`, `MAX_CACHE_ENTRIES = 100` (lines 37-38). Correct.
- **LRU eviction:** Delete-and-reinsert on hit (line 240-242), oldest-key eviction at capacity (line 267-272). Correct.
- **Redis pub/sub invalidation:** `subscribeToAuthProfileEvents` listens on `auth-profile:updated` channel, invalidates voice caches on category='voice' events. Returns cleanup function. Correct.
- **Dual-read credentials:** `dualReadCredentials` with auth-profile-first, legacy-fallback pattern. Correct.
- **No issues.**

### 5. Auth Type Metadata: `apps/studio/src/components/auth-profiles/auth-type-metadata.ts`

**Observation (INFO):** The `mtls` auth type exists in the `AuthType` union (`apps/studio/src/api/auth-profiles.ts:25`) and in the database enum (`packages/database/src/models/auth-profile.model.ts:33`), but there is no corresponding entry in `AUTH_TYPE_METADATA`. This means if an mTLS profile is displayed in the UI, it will fall through to undefined metadata. This is acceptable for Phase 3 since the mTLS runtime resolution is the deliverable -- the Studio UI form for creating mTLS profiles can be added in a follow-up phase. The `PHASE1_AUTH_TYPES` array correctly excludes `mtls`.

---

## Summary

| ID     | Severity | Status | Description                                                                          |
| ------ | -------- | ------ | ------------------------------------------------------------------------------------ |
| NEW-1  | LOW      | FIXED  | `void err` replaced with `log.warn()` in voice-service-factory.ts                    |
| NEW-2  | MEDIUM   | FIXED  | `encryptionPlugin` added for `secretKey` in sdk-channel.model.ts                     |
| INFO-1 | INFO     | N/A    | Audit trail plugin uses `process.stderr.write` instead of createLogger (intentional) |
| INFO-2 | INFO     | N/A    | No TTL index on audit_logs (operational concern, not code)                           |
| INFO-3 | INFO     | N/A    | No `mtls` entry in AUTH_TYPE_METADATA (UI form is Phase 4 scope)                     |

**No new CRITICAL, HIGH, or MEDIUM issues found.**

---

## Verdict: PASS

Both iteration-3 fixes verified. Final sweep found no blocking issues. Phase 3 deliverables (mTLS resolution, bulk actions, audit trail, voice cache, SDK channel encryption) are complete and correct.
