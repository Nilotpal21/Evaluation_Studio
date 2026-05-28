# Auth Profile Infrastructure Gaps — Implementation Plan

> **Date:** 2026-03-13
> **Status:** Draft
> **Scope:** Seven infrastructure gaps identified in the auth profile security review and false negatives audit
> **Prerequisites:** Auth Profile Phase 1-3 implementation (in progress on `feature/auth-profile-phase1`)

---

## Dependencies

This plan is **independent** of the four consent plans (GAP-3.1 through GAP-3.4) and can proceed in parallel.

Internal dependencies:

- **Gap 5** depends on **Gap 1** (needs `rotationStartedAt` field)
- **Gap 6** depends on **Gap 1** (rotation events depend on rotation being functional)
- **Gap 7** is deferred to Phase 3 cleanup

Plans that depend on this plan:

- **GAP-3.1** — Rotation grace period logic (Gap 1) affects token validation during preflight
- **GAP-3.3** — Background refresh must handle `AUTH_PROFILE_DECRYPTION_FAILED` from Gap 1 rotation changes

---

## Table of Contents

1. [Gap Overview](#gap-overview)
2. [Gap 1: Rotation Fields Inert](#gap-1-rotation-fields-inert)
3. [Gap 2: SDKChannel.secretKey Plain-Text](#gap-2-sdkchannelsecretkey-plain-text)
4. [Gap 3: TokenManager Bypasses Auth Profile](#gap-3-tokenmanager-bypasses-auth-profile)
5. [Gap 4: Audit Trail for Encrypted Fields](#gap-4-audit-trail-for-encrypted-fields)
6. [Gap 5: CredentialAgeMonitor Must Query AuthProfile](#gap-5-credentialagemonitor-must-query-authprofile)
7. [Gap 6: VoiceServiceFactory Cache Invalidation](#gap-6-voiceservicefactory-cache-invalidation)
8. [Gap 7: ConnectorConnection.encryptionKeyVersion Orphaned](#gap-7-connectorconnectionencryptionkeyversion-orphaned)
9. [Dependency Graph](#dependency-graph)
10. [Implementation Order](#implementation-order)
11. [Risk Assessment](#risk-assessment)
12. [Testing Strategy](#testing-strategy)

---

## Gap Overview

| #   | Gap                                               | Severity | Source Finding             | Files                                                                                            |
| --- | ------------------------------------------------- | -------- | -------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | Rotation fields inert                             | Critical | Security-001, Security-008 | `packages/shared/src/encryption/engine.ts`, `packages/database/src/models/auth-profile.model.ts` |
| 2   | SDKChannel.secretKey plain-text                   | Medium   | FN-1.3                     | `packages/database/src/models/sdk-channel.model.ts`                                              |
| 3   | TokenManager bypasses Auth Profile                | High     | FN-2.2                     | `packages/connectors/base/src/auth/token-manager.ts`                                             |
| 4   | Audit trail records ciphertext                    | Critical | Security-002, Security-007 | `packages/database/src/mongo/plugins/audit-trail.plugin.ts`                                      |
| 5   | CredentialAgeMonitor needs AuthProfile            | Medium   | FN-1.7                     | `apps/runtime/src/services/credential-age-monitor.ts`                                            |
| 6   | VoiceServiceFactory cache invalidation            | Medium   | FN-3.1                     | `apps/runtime/src/services/voice/voice-service-factory.ts`                                       |
| 7   | ConnectorConnection.encryptionKeyVersion orphaned | Low      | FN-2.1                     | `packages/database/src/models/connector-connection.model.ts`                                     |

---

## Gap 1: Rotation Fields Inert

### Current State

The `AuthProfile` model declares three rotation-related fields:

- `rotationPolicy: Record<string, unknown>` — schema present, no consumer
- `previousEncryptedSecrets: string` — encrypted by `encryptionPlugin`, but no code path writes to it during rotation
- `rotationGracePeriodMs: number` — stored, but the grace period logic (fall back to `previousEncryptedSecrets` if `encryptedSecrets` fails) does not exist in `AuthProfileService.resolve()`

The `EncryptionService` (`packages/shared/src/encryption/engine.ts`) already supports multi-key decryption via the `previous` config array (lines 38-51). The `decryptWithFallback()` and `decryptForTenantWithFallback()` methods iterate over `previousKeys` when the current key fails. However:

1. The `encryptionPlugin` (`packages/database/src/mongo/plugins/encryption.plugin.ts`) does NOT use `decryptForTenantWithFallback()` — it uses `decryptForTenant()` which throws on key mismatch.
2. The `encryptionKeyVersion` field on `AuthProfile` (default `1`) is never incremented and never consulted during encryption or decryption.
3. The `KeyVersion` model (`packages/database/src/models/key-version.model.ts`) tracks lifecycle states (`active`, `decrypt_only`, `destroyed`) per tenant but is never queried by any encryption code path.

Additionally, `rotationGracePeriodMs` is anchored to `updatedAt` per the design, but Mongoose `timestamps: true` updates `updatedAt` on every `save()`, including `lastUsedAt` and `status` changes during normal resolution. This silently resets the grace window.

### Target State

1. **EncryptionService multi-key at the plugin level**: The `encryptionPlugin` v3 path calls `decryptForTenantWithFallback()` instead of `decryptForTenant()` so that documents encrypted with a previous master key can still be decrypted.
2. **`encryptionKeyVersion` connected to actual key version**: When encrypting, the plugin stamps the current key version. When decrypting, if the primary key fails, the fallback chain is used.
3. **Rotation fields functional**:
   - On credential update, if `rotationPolicy` is set, the old `encryptedSecrets` is copied to `previousEncryptedSecrets` automatically.
   - `rotationStartedAt` field added (explicit timestamp, not relying on `updatedAt`).
   - `AuthProfileService.resolve()` tries `encryptedSecrets` first; on failure within `rotationGracePeriodMs` of `rotationStartedAt`, falls back to `previousEncryptedSecrets`.
4. **Re-encryption batch job**: A worker that iterates all `AuthProfile` documents encrypted with a `decrypt_only` key version and re-encrypts them with the current `active` key.

### Migration Strategy

**Phase A — Multi-key decryption (non-breaking):**

1. Update `EncryptionServiceConfig` to accept `previous` keys from environment/vault (already supported in types).
2. Wire `resolveMasterKey()` to also resolve `ENCRYPTION_PREVIOUS_MASTER_KEYS` (comma-separated hex pairs of `version:hex`).
3. Update `encryptionPlugin` v3 decrypt path to call `decryptForTenantWithFallback()`.
4. This is backward-compatible — existing documents decrypt with the current key; only if that fails do previous keys get tried.

**Phase B — Rotation fields activation:**

1. Add `rotationStartedAt: Date | null` field to `AuthProfile` schema (default `null`).
2. In `AuthProfileService.update()`, when `encryptedSecrets` changes and `rotationPolicy` is set:
   - Copy current `encryptedSecrets` to `previousEncryptedSecrets`.
   - Set `rotationStartedAt = new Date()`.
3. Update existing `resolveWithGracePeriod()` in `packages/shared/src/services/auth-profile/grace-period.ts` — this function **already implements** the try/catch/fallback logic (lines 28-47). The only changes needed are:
   - Add `rotationStartedAt` to the `GracePeriodProfile` interface (currently only has `updatedAt`).
   - Change the grace period anchor from `profile.updatedAt` to `profile.rotationStartedAt ?? profile.updatedAt` (fixes the bug where `timestamps: true` resets the grace window on every save).
   - Verify that `AuthProfileService.resolve()` actually calls `resolveWithGracePeriod()` — if not yet wired, add the call.
   - If outside grace period, throw `AUTH_PROFILE_DECRYPTION_FAILED`.
4. Add a scheduled cleanup that nulls `previousEncryptedSecrets` and `rotationStartedAt` when the grace period expires.

**Phase C — Re-encryption worker:**

1. BullMQ job: `auth-profile-re-encrypt`.
2. Queries `AuthProfile.find({ encryptionKeyVersion: { $lt: currentVersion } })`.
3. For each document: decrypt with fallback, re-encrypt with current key, update `encryptionKeyVersion`.
4. Rate-limited (batch size 100, 500ms delay between batches) to avoid DB pressure.
5. Emits `auth_profile_reencrypted` trace event per document.

### Files to Modify

| File                                                              | Change                                                |
| ----------------------------------------------------------------- | ----------------------------------------------------- |
| `packages/shared/src/encryption/engine.ts`                        | Already supports multi-key — no change needed         |
| `packages/shared/src/encryption/master-key-resolver.ts`           | Resolve `ENCRYPTION_PREVIOUS_MASTER_KEYS` env var     |
| `packages/database/src/mongo/plugins/encryption.plugin.ts`        | v3 decrypt path uses `decryptForTenantWithFallback`   |
| `packages/database/src/models/auth-profile.model.ts`              | Add `rotationStartedAt` field                         |
| `packages/shared/src/services/auth-profile.service.ts`            | Rotation copy logic, grace period fallback in resolve |
| New: `apps/runtime/src/workers/auth-profile-re-encrypt.worker.ts` | Re-encryption batch job                               |

---

## Gap 2: SDKChannel.secretKey Plain-Text

### Current State

`SDKChannel.secretKey` (`packages/database/src/models/sdk-channel.model.ts:52`) is stored as a plain `String` field with no `encryptionPlugin`. The schema only applies `tenantIsolationPlugin`. This field is the HMAC secret used for SDK channel identity verification when `hmacEnforcement` is `required` or `optional`.

The model already has an `authProfileId: string | null` field (line 53), indicating forward-compatibility with the Auth Profile migration was planned but not yet wired.

### Target State

1. **Interim encryption**: Apply `encryptionPlugin` to `secretKey` so it is encrypted at rest immediately, before the Auth Profile migration completes.
2. **Auth Profile migration**: New SDK channels created with `hmacEnforcement !== 'disabled'` should create an `AuthProfile` with `authType: 'api_key'` and `webhookVerification` addon, storing the HMAC secret in `encryptedSecrets`. The `authProfileId` is set on the `SDKChannel`.
3. **Dual-read**: SDK identity verification reads the HMAC secret from `AuthProfile` when `authProfileId` is set; otherwise falls back to `secretKey`.
4. **Phase 3 cleanup**: Remove `secretKey` field from `SDKChannel` schema once all records have `authProfileId`.

### Migration Strategy

**Step 1 — Interim encryption (immediate, pre-migration):**

1. Add `encryptionPlugin` to `SDKChannelSchema` with `fieldsToEncrypt: ['secretKey']`.
2. Write a one-time migration script that reads each `SDKChannel` with a non-null `secretKey`, triggers a `save()` to encrypt it via the plugin.
3. This is backward-compatible: the plugin auto-decrypts on read, so existing code that reads `secretKey` continues to work.

**Step 2 — Auth Profile creation for existing channels:**

1. Migration script iterates `SDKChannel.find({ secretKey: { $ne: null }, authProfileId: null })`.
2. For each channel:
   - Create an `AuthProfile` with `authType: 'api_key'`, `encryptedSecrets: JSON.stringify({ hmacSecret: secretKey })`, `webhookVerification: { algorithm: 'hmac-sha256' }`, scoped to the channel's `tenantId` and `projectId`.
   - Set `SDKChannel.authProfileId = newProfile._id`.
3. Batch size: 200 per iteration, with 1s delay.

**Step 3 — Dual-read in verification path:**

1. Locate the HMAC verification code that reads `SDKChannel.secretKey` (likely in SDK middleware).
2. Wrap with `dualReadCredentials()`: if `authProfileId` is set, resolve from Auth Profile; otherwise use `secretKey`.

**Step 4 — Cleanup (Phase 3):**

1. Drop `secretKey` from schema.
2. MongoDB migration: `SDKChannel.updateMany({}, { $unset: { secretKey: '' } })`.

### Files to Modify

| File                                                                                          | Change                                 |
| --------------------------------------------------------------------------------------------- | -------------------------------------- |
| `packages/database/src/models/sdk-channel.model.ts`                                           | Add `encryptionPlugin` for `secretKey` |
| New: migration script for encrypting existing `secretKey` values                              | One-time data migration                |
| New: migration script for creating Auth Profiles from `secretKey`                             | Batch migration                        |
| SDK HMAC verification middleware (locate via grep for `hmacEnforcement` or `secretKey` usage) | Add dual-read                          |

---

## Gap 3: TokenManager Bypasses Auth Profile

### Current State

`TokenManager` in `packages/connectors/base/src/auth/token-manager.ts` takes a `Model<IEndUserOAuthToken>` constructor argument and operates directly on it:

- `storeTokens()` (line 78): Creates/updates `EndUserOAuthToken` records directly.
- `refreshToken()` (line 180): Reads `encryptedRefreshToken` from `EndUserOAuthToken` and writes the refreshed token back.
- `getAccessToken()` (line 122): Has a partial dual-read via `TokenManagerAuthProfileResolver` interface (lines 32-38) — when `authProfileId` and `authProfileResolver` are provided, it tries Auth Profile first for reads.

The dual-read is read-only. The `storeTokens()` and `refreshToken()` methods always write to `EndUserOAuthToken` — they never write to Auth Profile. When `EndUserOAuthToken` is deleted in Phase 3, all SharePoint and future connector token write operations break.

The `TokenManagerAuthProfileResolver` interface already exists (lines 32-38) and is wired in the constructor (lines 58-68), but only for `getAccessToken()`.

### Target State

1. `storeTokens()` writes to Auth Profile when `authProfileId` is set and feature is enabled.
2. `refreshToken()` stores refreshed tokens to Auth Profile when `authProfileId` is set.
3. `revokeToken()` updates Auth Profile status to `revoked` when applicable.
4. The `TokenManagerAuthProfileResolver` interface is extended to support write operations.
5. `EndUserOAuthToken` write path remains as fallback for non-migrated connectors.

### Migration Strategy

**Step 1 — Extend `TokenManagerAuthProfileResolver` interface:**

```typescript
export interface TokenManagerAuthProfileResolver {
  resolveToken(params: {
    authProfileId: string;
    tenantId: string;
    userId: string;
  }): Promise<{ accessToken: string; expiresAt: Date | null } | null>;

  storeToken(params: {
    authProfileId: string;
    tenantId: string;
    userId: string;
    accessToken: string;
    refreshToken: string | null;
    expiresIn: number;
    scope: string;
  }): Promise<void>;

  revokeToken(params: { authProfileId: string; tenantId: string; userId: string }): Promise<void>;
}
```

**Step 2 — Update `storeTokens()`:**

Wrap the existing logic with a dual-write check:

1. If `authProfileId` and `authProfileResolver` are set and `isAuthProfileEnabled()`:
   - Call `authProfileResolver.storeToken()`.
   - Still write to `EndUserOAuthToken` during dual-write phase (both paths active).
2. Otherwise: existing logic only.

**Step 3 — Update `refreshToken()`:**

After successful refresh:

1. If `authProfileId` and `authProfileResolver` are set:
   - Call `authProfileResolver.storeToken()` with the refreshed tokens.
2. Still write to `EndUserOAuthToken` during dual-write phase.

**Step 4 — Implement the resolver:**

Create `packages/connectors/base/src/auth/auth-profile-token-resolver.ts` implementing `TokenManagerAuthProfileResolver`. This calls `AuthProfileService.update()` to store tokens in `encryptedSecrets` and `AuthProfileService.revoke()` for revocation.

**Step 5 — Wire in connector constructors:**

Update `SharePointConnector` (and any other connector using `TokenManager`) to pass the Auth Profile resolver when available.

**Phase 3 cleanup:** Remove `EndUserOAuthToken` write path from `storeTokens()` and `refreshToken()`.

### Files to Modify

| File                                                                        | Change                                                                           |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `packages/connectors/base/src/auth/token-manager.ts`                        | Extend interface, add dual-write to `storeTokens`, `refreshToken`, `revokeToken` |
| New: `packages/connectors/base/src/auth/auth-profile-token-resolver.ts`     | Implement `TokenManagerAuthProfileResolver` with write support                   |
| Connector constructors (e.g., SharePoint)                                   | Wire resolver                                                                    |
| `packages/connectors/base/src/__tests__/token-manager-auth-profile.test.ts` | Extend tests for write paths                                                     |

---

## Gap 4: Audit Trail for Encrypted Fields

### Current State

The `auditTrailPlugin` (`packages/database/src/mongo/plugins/audit-trail.plugin.ts`) already has encrypted field masking implemented (lines 201-244):

1. `FALLBACK_MASKED_FIELDS` includes `encryptedSecrets` and `previousEncryptedSecrets` (line 206).
2. `getEncryptedFieldsFromSchema()` (lines 208-224) reads the `fieldsToEncrypt` metadata from the document or schema.
3. `getModifiedFields()` (lines 226-245) checks each modified path against `maskedFields` and replaces values with `'[ENCRYPTED]'` (line 238).

This means the original critical findings (Security-002, Security-007) about ciphertext appearing in audit logs have already been addressed. The `pre('save')` hook at line 109 captures `_modifiedChanges` before the document is saved, and `getModifiedFields` masks encrypted field values.

**However, there are remaining gaps:**

1. The `findOneAndUpdate` post hook (line 139) captures changes via `this.getUpdate()` which returns the raw MongoDB update object. If the update includes `$set: { encryptedSecrets: '<ciphertext>' }`, this ciphertext is NOT masked because `getModifiedFields` is only called for `save()` operations, not for `findOneAndUpdate`.
2. The masking only applies to fields explicitly listed in `fieldsToEncrypt`. If a new encrypted model is added and forgets to apply `encryptionPlugin` before `auditTrailPlugin`, the masking won't activate.

### Target State

1. The `findOneAndUpdate` post hook masks encrypted fields in the update object before writing to audit.
2. A safety check ensures `auditTrailPlugin` is always applied after `encryptionPlugin` (plugin ordering).
3. Runtime `resolve()` decryption events are audited to ClickHouse (not MongoDB audit_logs) for compliance with Security-005.

### Migration Strategy

**Step 1 — Fix `findOneAndUpdate` masking:**

In the `post('findOneAndUpdate')` hook (line 139), before calling `writeAuditEntry`, filter the `changes` object:

1. Read `fieldsToEncrypt` from the model's schema options.
2. If `changes` is an object with `$set`, iterate its keys and replace any that match `fieldsToEncrypt` with `'[ENCRYPTED]'`.
3. Similarly handle `$unset` (just log the field name, not the value — which would be `''` anyway).

**Step 2 — Plugin ordering guard:**

Add a runtime check in `auditTrailPlugin` that warns (via `createLogger`) if the schema does not have `fieldsToEncrypt` metadata but has fields named `encrypted*` or `secret*`. This is a dev-time safety net, not a production blocker.

**Step 3 — Runtime resolution audit (ClickHouse):**

This is a separate concern from the audit trail plugin fix. In `AuthProfileService.resolve()`:

1. After successful decryption, emit a lightweight event to ClickHouse:
   ```
   { type: 'auth_profile_secrets_accessed', profileId, tenantId, consumer, sessionId, timestamp }
   ```
2. Use the existing `TraceStore` / ClickHouse event pipeline.
3. No actor context needed — log the invocation context (worker name, sessionId) instead.

### Files to Modify

| File                                                        | Change                                           |
| ----------------------------------------------------------- | ------------------------------------------------ |
| `packages/database/src/mongo/plugins/audit-trail.plugin.ts` | Mask encrypted fields in `findOneAndUpdate` hook |
| `packages/shared/src/services/auth-profile.service.ts`      | Emit ClickHouse audit event in `resolve()`       |
| ClickHouse schema for `audit_events` table                  | Add `auth_profile_secrets_accessed` event type   |

---

## Gap 5: CredentialAgeMonitor Must Query AuthProfile

### Current State

`CredentialAgeMonitor` (`apps/runtime/src/services/credential-age-monitor.ts`) has already been updated to include Auth Profile queries:

1. `checkAll()` (line 40) imports `AuthProfile` from `@agent-platform/database/models` and queries it alongside `ToolSecret`, `LLMCredential`, and `ApiKey`.
2. `findAuthProfileCandidates()` (line 118) queries `AuthProfile` for records where `createdAt` is older than the warning threshold and no `rotationPolicy` is set, OR where `lastValidatedAt` is older than the threshold.
3. `checkAuthProfileExpiration()` (line 142) checks for profiles approaching their `expiresAt` date within the rotation grace period.
4. Auth Profile results are included in the `allCandidates` array with `source: 'AuthProfile'` (line 63).

**This gap has been addressed.** The implementation already queries Auth Profile correctly.

**Remaining concern:** The monitor uses `rotatedAt` from the `CredentialRecord` interface (line 68), but `AuthProfile` does not have a `rotatedAt` field — it has `rotationStartedAt` (proposed in Gap 1) which does not yet exist. Currently, the monitor falls back to `createdAt` when `rotatedAt` is null, which is correct behavior for profiles that have never been rotated. Once Gap 1 adds `rotationStartedAt`, the monitor should be updated to use it as the effective rotation date.

### Target State

1. Once Gap 1 adds `rotationStartedAt`, update `findAuthProfileCandidates()` to use `rotationStartedAt` as the effective date for age calculation (in addition to `createdAt` fallback).
2. Update the `CredentialRecord` interface or the mapping logic to handle `rotationStartedAt` as an alias for `rotatedAt`.

### Migration Strategy

This is a minor follow-up change after Gap 1 is implemented. No migration needed — the monitor already queries Auth Profile.

### Files to Modify

| File                                                  | Change                                                               |
| ----------------------------------------------------- | -------------------------------------------------------------------- |
| `apps/runtime/src/services/credential-age-monitor.ts` | Map `rotationStartedAt` to `rotatedAt` in Auth Profile query results |

---

## Gap 6: VoiceServiceFactory Cache Invalidation

### Current State

`VoiceServiceFactory` (`apps/runtime/src/services/voice/voice-service-factory.ts`) has already been updated with Redis pub/sub cache invalidation:

1. `subscribeToAuthProfileEvents()` (lines 136-166) subscribes to the `auth-profile:updated` Redis channel.
2. When a message with `category: 'voice'` is received, it calls `this.invalidate(tenantId)` to clear all cached voice services for that tenant.
3. The `invalidate()` method (line 68) correctly removes entries from the process-local `Map` cache.

**However, the wiring is incomplete:**

1. `subscribeToAuthProfileEvents()` exists but is never called from the server startup code. The Redis subscriber client must be passed in, and the returned cleanup function must be called on shutdown.
2. The Auth Profile update/rotation code paths do not publish to the `auth-profile:updated` Redis channel. When an Auth Profile is updated or rotated, no Redis event is emitted.

### Target State

1. The runtime server startup code calls `voiceServiceFactory.subscribeToAuthProfileEvents(redisSub)` during initialization.
2. `AuthProfileService.update()` and `AuthProfileService.rotate()` publish `{ tenantId, category, profileId }` to the `auth-profile:updated` Redis channel after successful writes.
3. The cleanup function is called during graceful shutdown.

### Migration Strategy

**Step 1 — Wire subscription at startup:**

In the runtime server initialization (likely `apps/runtime/src/server.ts` or the service bootstrap):

1. Create a dedicated Redis subscriber client (or reuse the existing pub/sub client).
2. Call `voiceServiceFactory.subscribeToAuthProfileEvents(redisSub)`.
3. Store the cleanup function and call it in the shutdown handler.

**Step 2 — Publish events from AuthProfileService:**

In `AuthProfileService.update()` and any rotation method:

1. After successful MongoDB write, publish to Redis:
   ```
   redis.publish('auth-profile:updated', JSON.stringify({
     tenantId,
     category: profile.category,
     profileId: profile._id,
     event: 'updated' | 'rotated',
   }))
   ```
2. The `category` field allows consumers (like VoiceServiceFactory) to filter relevant events.

**Step 3 — Extend to other consumers:**

The same Redis pub/sub channel can be used by `RuntimeSecretsProvider` and any other credential cache that needs invalidation on rotation. The channel design should be generic enough to support multiple consumer types filtering by `category`.

### Files to Modify

| File                                                        | Change                               |
| ----------------------------------------------------------- | ------------------------------------ |
| Runtime server startup (e.g., `apps/runtime/src/server.ts`) | Wire `subscribeToAuthProfileEvents`  |
| `packages/shared/src/services/auth-profile.service.ts`      | Publish Redis event on update/rotate |
| Runtime shutdown handler                                    | Call cleanup function                |

---

## Gap 7: ConnectorConnection.encryptionKeyVersion Orphaned

### Current State

`ConnectorConnection.encryptionKeyVersion` (`packages/database/src/models/connector-connection.model.ts:55`) is a `Number` field with `default: 1` and `required: true`. It was intended to track which encryption key version was used to encrypt `encryptedCredentials`.

However:

1. The field is written (default `1`) but never updated — no code increments it during re-encryption.
2. No code reads it during decryption — the `ConnectionService` encrypts/decrypts using `EncryptionService` methods that derive the key from the current master key, ignoring the version field.
3. The `ConnectorConnection` model does NOT use `encryptionPlugin` (line 73 comment: "No encryptionPlugin — encryptedCredentials is managed by ConnectionService").
4. As Auth Profile migration proceeds, `ConnectorConnection` already has `authProfileId` (line 33 interface, line 65 schema: `{ type: String, default: null }`) and will eventually drop `encryptedCredentials`. The `encryptionKeyVersion` field becomes dead weight.

### Target State

1. During Auth Profile migration Phase 2/3, when `ConnectorConnection` records are migrated to Auth Profile, the migration script does not need to read `encryptionKeyVersion` (it is meaningless).
2. In the Phase 3 cleanup migration that removes `encryptedCredentials` and `oauth2RefreshToken`, also remove `encryptionKeyVersion`.
3. The schema field is removed and a MongoDB `$unset` migration cleans existing documents.

### Migration Strategy

This is a housekeeping task bundled with the Phase 3 cleanup of `ConnectorConnection`. No standalone migration is needed.

**Cleanup step (Phase 3):**

1. Remove `encryptionKeyVersion` from `IConnectorConnection` interface and schema.
2. MongoDB migration: `ConnectorConnection.updateMany({}, { $unset: { encryptionKeyVersion: '', encryptedCredentials: '', oauth2RefreshToken: '' } })`.
3. Update any code that references `encryptionKeyVersion` on `ConnectorConnection` (expected: none beyond the schema definition).

### Files to Modify

| File                                                         | Change                                        |
| ------------------------------------------------------------ | --------------------------------------------- |
| `packages/database/src/models/connector-connection.model.ts` | Remove `encryptionKeyVersion` field (Phase 3) |
| Phase 3 migration script                                     | `$unset` the field from all documents         |

---

## Dependency Graph

```
Gap 1 (Rotation fields)
  ├── Gap 5 (CredentialAgeMonitor) — needs rotationStartedAt from Gap 1
  └── Gap 6 (VoiceServiceFactory) — rotation events depend on rotation being functional

Gap 4 (Audit trail) — independent, can proceed in parallel

Gap 2 (SDKChannel.secretKey) — independent, can proceed in parallel
  └── depends on encryptionPlugin being available (already is)

Gap 3 (TokenManager) — independent, can proceed in parallel
  └── depends on AuthProfileService write API (already exists)

Gap 7 (ConnectorConnection cleanup) — deferred to Phase 3, no current dependencies
```

**Critical path:** Gap 1 must be completed before Gap 5 and Gap 6 can be finalized. Gaps 2, 3, and 4 are independent and can proceed in parallel.

---

## Implementation Order

### Sprint 1: Security-Critical (Gaps 1, 4)

| Task                                                             | Gap | Effort | Priority |
| ---------------------------------------------------------------- | --- | ------ | -------- |
| Wire `decryptForTenantWithFallback` in encryption plugin v3 path | 1A  | 2d     | P0       |
| Resolve `ENCRYPTION_PREVIOUS_MASTER_KEYS` in master-key-resolver | 1A  | 1d     | P0       |
| Add `rotationStartedAt` field to AuthProfile schema              | 1B  | 0.5d   | P0       |
| Implement rotation copy logic in AuthProfileService.update()     | 1B  | 2d     | P0       |
| Grace period fallback in AuthProfileService.resolve()            | 1B  | 1d     | P0       |
| Mask encrypted fields in audit trail `findOneAndUpdate` hook     | 4   | 1d     | P0       |
| Add runtime resolution audit to ClickHouse                       | 4   | 2d     | P1       |

### Sprint 2: Data Integrity (Gaps 2, 3)

| Task                                                                   | Gap | Effort | Priority |
| ---------------------------------------------------------------------- | --- | ------ | -------- |
| Add encryptionPlugin to SDKChannel for `secretKey`                     | 2   | 0.5d   | P1       |
| Write migration script to encrypt existing SDKChannel.secretKey values | 2   | 1d     | P1       |
| Extend TokenManagerAuthProfileResolver with write operations           | 3   | 1d     | P1       |
| Update storeTokens() and refreshToken() for dual-write                 | 3   | 2d     | P1       |
| Implement auth-profile-token-resolver                                  | 3   | 1d     | P1       |
| Wire resolver in connector constructors                                | 3   | 1d     | P1       |

### Sprint 3: Operational (Gaps 5, 6, 1C)

| Task                                                          | Gap | Effort | Priority |
| ------------------------------------------------------------- | --- | ------ | -------- |
| Update CredentialAgeMonitor to use rotationStartedAt          | 5   | 0.5d   | P2       |
| Wire VoiceServiceFactory subscription at runtime startup      | 6   | 1d     | P1       |
| Publish Redis events from AuthProfileService on update/rotate | 6   | 1d     | P1       |
| Implement re-encryption batch worker                          | 1C  | 3d     | P2       |

### Phase 3 Cleanup (Gap 7)

| Task                                                 | Gap | Effort | Priority |
| ---------------------------------------------------- | --- | ------ | -------- |
| Remove encryptionKeyVersion from ConnectorConnection | 7   | 0.5d   | P3       |
| $unset migration for orphaned fields                 | 7   | 0.5d   | P3       |

---

## Risk Assessment

| Risk                                                                                           | Impact | Likelihood | Mitigation                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------- | ------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-key decryption introduces performance regression (iterating previous keys on every read) | Medium | Low        | Previous keys are only tried on decryption failure of current key. In steady state (no rotation in progress), only the fast path runs. Add a counter metric for fallback hits.                                                  |
| SDKChannel encryption migration causes downtime for HMAC verification                          | High   | Low        | The `encryptionPlugin` auto-decrypts on read. Existing code that reads `secretKey` continues to work transparently. Run migration during low-traffic window.                                                                    |
| TokenManager dual-write creates inconsistency between EndUserOAuthToken and AuthProfile        | Medium | Medium     | During dual-write phase, Auth Profile is the source of truth for reads (via `getAccessToken()` dual-read). EndUserOAuthToken writes are for backward compatibility only. Add a consistency check job that compares both stores. |
| Re-encryption worker causes MongoDB load spike                                                 | Medium | Medium     | Rate-limit batch size (100 docs) with 500ms inter-batch delay. Run during off-peak hours. Monitor `oplog` lag. Add a kill switch env var to pause the worker.                                                                   |
| Redis pub/sub message lost during VoiceServiceFactory cache invalidation                       | Low    | Medium     | The cache has a 10-minute TTL regardless. A missed invalidation means stale credentials for at most 10 minutes. For critical rotation scenarios, operators can restart the runtime pod.                                         |
| Audit trail ClickHouse writes add latency to resolve()                                         | Medium | Low        | Use fire-and-forget async write. Do not await the ClickHouse insert in the hot path. Buffer events in memory and flush periodically (similar to existing TraceStore pattern).                                                   |

---

## Testing Strategy

### Gap 1 — Rotation Fields

- **Unit tests:**
  - `encryptionPlugin` v3 decrypt path falls back to previous key when current key fails.
  - `encryptionPlugin` v3 decrypt succeeds on first try when current key matches (no regression).
  - `AuthProfileService.update()` copies `encryptedSecrets` to `previousEncryptedSecrets` when `rotationPolicy` is set.
  - `AuthProfileService.resolve()` falls back to `previousEncryptedSecrets` within grace period.
  - `AuthProfileService.resolve()` throws after grace period expires.
  - `rotationStartedAt` is set on rotation and not reset by unrelated saves.
- **Integration tests:**
  - Full rotation flow: create profile -> rotate master key -> resolve succeeds via fallback -> re-encrypt -> resolve succeeds via current key.
  - Re-encryption worker processes a batch of 10 profiles and all end up with current key version.

### Gap 2 — SDKChannel.secretKey

- **Unit tests:**
  - New SDKChannel with `secretKey` set: verify field is encrypted in the DB document (inspect raw MongoDB doc).
  - Read back: verify `secretKey` is decrypted transparently.
  - Migration script: mock a set of unencrypted SDKChannel docs, run migration, verify all are encrypted.
- **Integration tests:**
  - HMAC verification with encrypted `secretKey` works end-to-end.
  - Dual-read: channel with `authProfileId` resolves HMAC secret from Auth Profile.

### Gap 3 — TokenManager

- **Unit tests:**
  - `storeTokens()` calls `authProfileResolver.storeToken()` when `authProfileId` is set.
  - `storeTokens()` falls back to `EndUserOAuthToken` when `authProfileId` is not set.
  - `refreshToken()` writes to both Auth Profile and EndUserOAuthToken during dual-write.
  - `revokeToken()` updates Auth Profile status when `authProfileId` is set.
- **Integration tests:**
  - SharePoint connector token refresh with Auth Profile resolver: verify tokens are stored in Auth Profile.
  - Verify `getAccessToken()` reads from Auth Profile after `storeTokens()` writes to it.

### Gap 4 — Audit Trail

- **Unit tests:**
  - `findOneAndUpdate` with `$set: { encryptedSecrets: 'ciphertext' }` produces audit entry with `encryptedSecrets: '[ENCRYPTED]'`.
  - `findOneAndUpdate` with non-encrypted fields produces audit entry with actual values.
  - `save()` path continues to mask encrypted fields (regression test for existing behavior).
- **Integration tests:**
  - Create an AuthProfile, update its `encryptedSecrets`, verify audit_logs entry has `[ENCRYPTED]` not ciphertext.
  - ClickHouse audit: call `AuthProfileService.resolve()`, verify `auth_profile_secrets_accessed` event appears in ClickHouse.

### Gap 5 — CredentialAgeMonitor

- **Unit tests:**
  - After Gap 1 adds `rotationStartedAt`, verify monitor uses it as effective date.
  - Mock Auth Profiles with various ages: verify correct warning/critical classification.
- **Existing tests:** `apps/runtime/src/__tests__/services/credential-age-monitor.test.ts` — extend with Auth Profile mocks using `rotationStartedAt`.

### Gap 6 — VoiceServiceFactory

- **Unit tests:**
  - `subscribeToAuthProfileEvents()` with a mock Redis: publish `{ tenantId: 't1', category: 'voice' }` -> verify `invalidate('t1')` called.
  - Publish event with `category: 'llm'` -> verify cache NOT invalidated.
- **Integration tests:**
  - Wire subscription at startup, update an Auth Profile with `category: 'voice'`, verify cached voice service is evicted.
  - Verify the 10-minute TTL still works as a safety net when Redis event is missed.

### Gap 7 — ConnectorConnection Cleanup

- **Unit tests:**
  - After schema field removal, verify `ConnectorConnection` can be created without `encryptionKeyVersion`.
  - Migration script: verify `$unset` removes the field from existing documents.
- **Existing cascade tests:** Verify no regressions in `packages/database/src/__tests__/mongo-cascade.test.ts`.

### Cross-Cutting Test Infrastructure

- Add `makeAuthProfile()` test factory to `packages/test-helpers/` (or a shared location) with sensible defaults for all 7 gaps.
- Add `makeDecryptedCredentials(authType)` helper that returns the expected shape for each auth type.
- Ensure all new tests use the shared factory rather than inline mock construction.

---

## Gap 1 Migration Note: rotationStartedAt Backfill

When adding `rotationStartedAt` to the AuthProfile schema, the migration must set `rotationStartedAt = updatedAt` for all existing `AuthProfile` documents that have a non-null `rotationPolicy` and non-null `previousEncryptedSecrets`. This preserves existing grace period behavior during the transition. Documents without active rotation get `rotationStartedAt = null`.

---

## Existing Schema Acknowledgment

The following already exists and does NOT need to be created:

- `AuthProfile` with `encryptionKeyVersion` (default 1, never incremented) — in `packages/database/src/models/auth-profile.model.ts`
- `KeyVersion` model tracking lifecycle states — in `packages/database/src/models/key-version.model.ts`
- `decryptWithFallback()` and `decryptForTenantWithFallback()` methods — in `packages/shared/src/encryption/engine.ts`
- `ConnectorConnection.authProfileId` already exists on the schema (line 65)
- `resolveWithGracePeriod` — in `packages/shared/src/services/auth-profile/grace-period.ts` (**fully implemented** with try/catch/fallback logic; only the `rotationStartedAt` field swap is needed — see Gap 1 Phase B step 3)

---

## Security Findings Not Yet Addressed

The following findings from the security and false negatives reviews are NOT covered by Gaps 1-7 and should be tracked as future work or additional gaps:

1. **Validate endpoint visibility enforcement** (Security-003): `POST /:id/validate` does not enforce personal profile visibility. Add `$or: [{ visibility: 'shared' }, { visibility: 'personal', createdBy: userId }]`.
2. **Proxy chain shared-to-personal** (Security-004): `proxyAuthProfileId` allows shared profile to reference personal profile, bypassing visibility.
3. **providerUserId PII leak** (Security-006): Existing `config.providerUserId` must be migrated to `encryptedSecrets`.
4. **NormalizedAuthProfile type safety** (Security-009): Define with `encryptedSecrets?: never` to prevent ciphertext leakage.
5. **SSRF on URL fields / Zod .strict()** (Security-012): All config Zod schemas must use `.strict()` and URL fields need SSRF validation.
6. **TriggerRegistration.webhookSecret** (FN-1.1): Plain-text credential not in migration table.
7. **GuardrailPolicy.providerOverrides.apiKeyCredentialId** (FN-1.2): Consumer mapping needed for LLMCredential Phase 3 deletion.
8. **ModelConfig.credentialId** (FN-1.4): Consumer mapping needed.
9. **Alerting thresholds** (FN-5.1): Define P1/P2 alerts for `AUTH_PROFILE_DECRYPTION_FAILED`, `AUTH_PROFILE_TOKEN_REFRESH_FAILED`, etc.
10. **Health check** (FN-5.2): Register `AuthProfile` in service-registry with MongoDB + encryption verification.

---

## Gap 8: Migration Name Deduplication

### Problem

The `AuthProfile` model has a `{ tenantId, projectId, name }` unique constraint. During data migration from `LLMCredential`, `ToolSecret`, and `ConnectorConnection`, auto-generated names may collide within the same `(tenantId, projectId)` scope (e.g., two `LLMCredential` records both named "Production OpenAI" in the same project).

### Migration Script Requirements

The migration script must:

1. **Generate names** from the source model (`LLMCredential.name`, `ToolSecret.key`, `ConnectorConnection.name`).
2. **Detect collisions:** Before inserting, check if a name already exists in the target `(tenantId, projectId)` scope.
3. **Append deduplication suffix on collision:** "Production OpenAI" becomes "Production OpenAI (2)", then "Production OpenAI (3)", etc.
4. **Create the unique index AFTER migration completes** with deduplication, not before. This prevents partial migration failures from leaving the index in an inconsistent state.
5. **Log all deduplication actions** with the original name and new name for audit trail.

### Sprint Assignment

This is a Sprint 2 task (alongside Gap 2 SDKChannel migration). Add to the Sprint 2 table:

| Task                                               | Gap | Effort | Priority |
| -------------------------------------------------- | --- | ------ | -------- |
| Add name deduplication logic to migration scripts  | 8   | 1d     | P1       |
| Defer unique index creation to post-migration step | 8   | 0.5d   | P1       |

---

## Consumer Migrations for Phase 3 Cleanup

### Problem

Phase 3 cleanup deletes `LLMCredential`. Three consumer models reference `LLMCredential` by ID and must be migrated to use Auth Profile references before deletion:

1. **TriggerRegistration.webhookSecret** — plain-text credential, needs migration to Auth Profile `api_key` type.
2. **GuardrailPolicy.providerOverrides.apiKeyCredentialId** — references `LLMCredential._id`, needs migration to `authProfileId`.
3. **ModelConfig.credentialId** — references `LLMCredential._id`, needs migration to `authProfileId`.

### Sprint Assignment

These MUST be completed before Phase 3 cleanup. Add to the Sprint 3 table:

| Task                                                                               | Gap      | Effort | Priority |
| ---------------------------------------------------------------------------------- | -------- | ------ | -------- |
| Migrate TriggerRegistration.webhookSecret to Auth Profile `api_key`                | Consumer | 1d     | P1       |
| Migrate GuardrailPolicy.apiKeyCredentialId to authProfileId                        | Consumer | 1d     | P1       |
| Migrate ModelConfig.credentialId to authProfileId                                  | Consumer | 1d     | P1       |
| Add dual-read for all three consumers (authProfileId first, credentialId fallback) | Consumer | 1d     | P1       |

---

## Revision History

- **Pass 1 (2026-03-13)**: Initial implementation plan.
- **Pass 2 (2026-03-13)**: Applied 131 audit findings from 3 auditors. Added cross-plan dependencies section, noted `ConnectorConnection.authProfileId` already exists in schema, added `rotationStartedAt` backfill migration note for existing documents, added existing schema acknowledgment (including `resolveWithGracePeriod` that may already implement grace period logic), added comprehensive list of unaddressed security findings as future work tracking.
- **Pass 4 (2026-03-13)**: Applied 20 findings from Pass 3 auditors. Acknowledged existing `resolveWithGracePeriod()` already implements grace period fallback (only `rotationStartedAt` swap needed), added Gap 8 for migration name deduplication (G-42), scheduled consumer migrations (TriggerRegistration, GuardrailPolicy, ModelConfig) as Sprint 2-3 tasks required before Phase 3 cleanup.
