# PR Review: feature/epoch-removal-dek-cache-fix — DEK Envelope Encryption

**Reviewer:** Platform team
**Date:** 2026-03-25
**Branch:** `feature/epoch-removal-dek-cache-fix` (4 core commits, 73 files, +8906/-1861)
**PR:** #505
**Status:** Changes requested

---

## Summary

This PR makes a major architectural change to the encryption subsystem:

1. **Epoch removal**: DEK scoping simplifies from per-(tenant, project, environment, epoch) to per-tenant only
2. **Code migration**: Core KMS logic (`DEKManager`, `KMSResolver`) moves from `apps/runtime/services/kms/` down to `packages/database/src/kms/` (shared across all services)
3. **DEK envelope encryption**: New binary wire format with embedded DEK ID, `TenantEncryptionFacade` as the unified encrypt/decrypt path
4. **Per-tenant KMS config**: Auth credential encryption, Zod validation on admin API
5. **Consumer migration**: All callers switch from sync `getEncryptionService().decryptForTenant()` to async `decryptForTenantAuto()`

**What's good and should be kept:**

- Re-encryption verification (byte-for-byte comparison after rewrap, zero-fill both buffers) — excellent security practice
- BullMQ job ID separator fix (`:` to `-`) — prevents silent BullMQ failures with custom IDs
- Zod validation on admin API — significant improvement over unvalidated request bodies
- Auth credential encryption — correctly uses platform key for tenant credentials (avoids chicken-and-egg)
- Typed `globalThis` accessors (`facade-accessor.ts`, `kms-resolver-accessor.ts`) — replaces unsafe `(globalThis as any)` casts
- Ciphertext leak prevention — every decrypt failure path nulls out fields and strips encryption metadata
- Non-fatal facade init — all services fall back to PBKDF2 if DEK setup fails
- Zero-fill discipline maintained consistently across all key material handling
- Clean codec layer (`dek-codec.ts`) — stateless, well-validated, easy to audit
- Sync/async path split is well-designed for performance

**What needs to change:** Critical security issues, compliance regression, and several high-severity correctness bugs. Details below.

---

## Architectural Concern: Epoch & Scope Removal — Compliance Regression

### Background

The original design had 3 dimensions of DEK scoping for specific security/compliance reasons:

**Project + Environment — Blast radius containment:**
The 5-level KMS config inheritance chain (`TenantKMSConfig`) allowed different KMS providers per project (e.g., Project A uses AWS KMS, Project B uses Azure Key Vault) and per environment (e.g., staging uses `local`, production uses `aws-kms` with HSM). A compromise of one project's DEK didn't expose another project's data. The `KMSMaterializer` walked this chain and pre-resolved configs for every (tenant, project, environment) tuple.

**Epoch — Cryptoperiod enforcement (NIST SP 800-57):**
Each DEK had a time-bounded validity window (`dekEpochIntervalHours`, default 24h) and a usage cap (`dekMaxUsageCount`, default 2^30). This enforced:

- Key rotation by time — after 24h, the active DEK transitions to `decrypt_only` and a new one is created
- Key rotation by usage — after N encryptions, same transition
- Lifecycle: `active → decrypt_only → destroyed` — destroyed DEKs have `wrappedDek` zeroed (crypto-shredding)
- Retention window (`dekRetentionDays`: 90) — old DEKs remain in `decrypt_only` for 90 days, then destroyed

This is required by SOC 2, HIPAA, PCI-DSS, and ISO 27001 A.10 for key lifecycle management.

### What the PR removes

- **No project/environment isolation** — all projects share one DEK per tenant
- **No time-based rotation** — `expiresAt` is no longer set on new DEKs, so `kms-rotation-job.ts` becomes a no-op for new DEKs
- **No usage-based rotation** — `maxUsageCount` deprecated

### Decision needed

If this is a deliberate simplification (perhaps because multi-dimensional scoping was never used in production and compliance requirements aren't yet active), it must be explicitly documented as a trade-off with a plan to re-introduce automated rotation. The feature spec says "encryption is tenant-scoped, not project-scoped" but doesn't explain **why** the compliance properties are being dropped.

---

## CRITICAL Issues

### Issue 1: Cross-tenant DEK ID leakage via `_lastAcquiredDekId`

**File:** `packages/database/src/kms/dek-manager.ts`

`_lastAcquiredDekId` is a **single instance variable shared across all tenants**. When tenant A acquires `"active:R1"` and tenant B acquires `"active"`, `getActiveDEKId()` returns tenant B's DEK ID. Any sync encrypt path using `getActiveDEKId()` for tenant A would encrypt with the wrong DEK ID.

**Impact:** Cross-tenant data corruption — encrypting with the wrong tenant's DEK ID means the ciphertext header points to a DEK that doesn't exist in that tenant's scope, causing decryption failures or — worse — if both tenants happen to have a DEK with the same ID, decryption with the wrong key returning garbage that passes GCM auth (cryptographically negligible but architecturally wrong).

**Fix:** Replace with `Map<tenantId, dekId>` (bounded, with eviction).

### Issue 2: Duplicate `isDEKEnvelopeFormat` with different thresholds

**Files:** `packages/shared-encryption/src/encryption-registry.ts` (private), `packages/shared-encryption/src/legacy-format-detection.ts` (exported)

Two nearly identical implementations with a subtle length threshold discrepancy:

- `encryption-registry.ts`: `value.length <= 40` (rejects values of exactly 40 chars)
- `legacy-format-detection.ts`: `value.length < 40` (accepts values of exactly 40 chars)

The double-encryption guard (`isAlreadyEncrypted` in the registry) and the decrypt routing (`isDEKEnvelopeFormat` from legacy-format-detection) disagree on edge cases. A value exactly 40 characters long would pass the facade's decrypt check but fail the registry's double-encryption guard, potentially allowing double encryption.

**Fix:** Delete the private function in `encryption-registry.ts` and import the exported one from `legacy-format-detection.ts`.

### Issue 3: `decrypt()` silently returns ciphertext as "plaintext" for unrecognized formats

**File:** `packages/shared-encryption/src/tenant-encryption-facade.ts`

If a value doesn't match any known format (legacy hex 3-part, `ENC:v3:`, compressed, or DEK envelope), `decrypt()` returns it as-is under the assumption it's "plaintext stored before encryption was enabled."

**Impact:**

- A corrupted ciphertext that doesn't match any format is returned as garbage instead of throwing
- If new encryption formats are added and this code isn't updated, encrypted data leaks as plaintext
- A DEK envelope ciphertext that hits the 40-char edge case (Issue 2) is silently returned as "plaintext"

**Fix:** At minimum, log a warning when returning a value as-is. Ideally, require an explicit opt-in flag for "passthrough unencrypted values" rather than making it the default.

---

## HIGH Issues

### Issue 4: `resolveAuthConfig` falls back to platform env vars on per-tenant decrypt failure

**File:** `packages/database/src/kms/kms-provider-pool.ts`

If `decryptAuthConfig` fails for a per-tenant config, the code silently falls back to platform-level env vars. A misconfigured tenant could use the **platform's KMS credentials**, accessing the wrong cloud KMS keys.

**Fix:** Only fall back to platform env vars for platform-level configs (where `authConfigEncrypted` is null). Per-tenant configs should fail-closed.

### Issue 5: `decryptForTenant` (sync) breaks on DEK envelope data with cold cache

**File:** `packages/shared-encryption/src/engine.ts`

When the DEK cache misses:

1. `facade.decryptSync()` returns `null`
2. Falls through to `decryptFromHex3Part()` which expects hex 3-part format
3. DEK envelope ciphertext (base64) fails the `parts.length !== 3` check and throws `invalidFormat()`

The PR migrates most callers to `decryptForTenantAuto`, but any remaining sync callers of `decryptForTenant` will fail on DEK-encrypted data when the cache is cold. All call sites must be audited.

**Fix:** Either make `decryptForTenant` handle DEK envelope format gracefully (return null or throw a descriptive error), or verify zero sync callers remain.

### Issue 6: `insertMany` facade path lacks double-encryption guard

**File:** `packages/database/src/mongo/plugins/encryption.plugin.ts`

The facade encrypt path calls `encryptionFacade!.encrypt(strValue, ...)` without first calling `rejectIfAlreadyEncrypted()`. The facade has its own `looksLikeEncrypted` check, but it uses `isDEKEnvelopeFormat` + `isLegacyFormat`, which may not cover all the same patterns as the plugin's `isAlreadyEncrypted`. If the two detection functions diverge, double encryption could slip through.

**Fix:** Call `rejectIfAlreadyEncrypted()` before the facade encrypt call, same as the PBKDF2 path.

### Issue 7: Rotation job vs. new DEK model mismatch

**File:** `apps/runtime/src/services/kms/kms-rotation-job.ts`

`transitionExpiredDEKs()` queries `{ status: 'active', expiresAt: { $lt: now } }`, but the new `DEKManager` does not set `expiresAt` when creating DEKs (now optional). New DEKs will **never be auto-rotated or auto-destroyed**. Similarly, `destroyRetiredDEKs()` uses `expiresAt` for the retention cutoff, so DEKs without `expiresAt` will never be auto-destroyed.

**Impact:** New DEKs have unbounded lifetime unless manually force-rotated via admin API. The rotation job effectively becomes legacy cleanup only.

**Fix:** If intentional, document this explicitly and add a manual rotation cadence recommendation. If not, set `expiresAt` based on a configurable interval (even if longer than 24h).

### Issue 8: `encryptForTenantAuto` lacks PBKDF2 fallback on facade error

**File:** `packages/shared-encryption/src/index.ts`

If the facade exists but `facade.encrypt()` throws (e.g., DEK manager error, MongoDB down), the error propagates with no fallback. The sync path in `engine.ts` has a PBKDF2 fallback, but the async path in `encryptForTenantAuto` does not.

**Fix:** Add a try-catch around `facade.encrypt()` in `encryptForTenantAuto` that falls back to `getEncryptionService().encryptForTenant()` on failure, matching the sync path's behavior.

---

## MEDIUM Issues

### Issue 9: Platform default never cached in L1

**File:** `packages/database/src/kms/kms-resolver.ts`

When `resolve()` falls back to `getPlatformDefault()`, it returns directly without calling `this.cache.set(tenantId, ...)`. Every request for a tenant without a `TenantKMSConfig` document hits MongoDB on every call after cache TTL expiry.

**Fix:** Cache the platform default result.

### Issue 10: Removed exported interfaces

**File:** `packages/database/src/models/tenant-kms-config.model.ts`

`IKMSEnvironmentOverride` and `IKMSProjectOverride` were exported on develop. Per CLAUDE.md: "Never delete exports during feature work." If any other package imports these types, build failures will occur.

**Fix:** Verify no consumers import these types. If consumers exist, deprecate instead of deleting.

### Issue 11: `PBKDF2 fallback in decrypt() catch block swallows the fallback error

**File:** `packages/shared-encryption/src/tenant-encryption-facade.ts`

When DEK envelope decryption fails and the PBKDF2 fallback also fails, the original DEK error is thrown but the PBKDF2 error is silently swallowed. If the real issue is a corrupted PBKDF2 ciphertext that happened to pass the `isDEKEnvelopeFormat` heuristic, the developer sees a misleading DEK error.

**Fix:** Log the PBKDF2 fallback error before re-throwing the DEK error.

### Issue 12: `decryptLegacyPBKDF2` doesn't handle `ENC:v3:` prefix correctly

**File:** `packages/shared-encryption/src/tenant-encryption-facade.ts`

It strips the `ENC:v3:` prefix and attempts hex 3-part parsing, but real `ENC:v3:` data in the codebase uses base64, not hex. This fallback path would fail with "Invalid legacy hex format: expected 3 parts" on real `ENC:v3:` data.

**Fix:** Handle `ENC:v3:` base64 format in the PBKDF2 fallback path.

### Issue 13: Orphaned `MaterializedKMSConfig` documents

The materializer is now a no-op stub. Existing `MaterializedKMSConfig` documents in MongoDB will never be read, updated, or cleaned up.

**Fix:** Add a migration task to clean up orphaned documents, or document the cleanup plan.

### Issue 14: DEK facade init duplicated across 4 servers

`runtime/server.ts`, `search-ai/server.ts`, `search-ai-runtime/server.ts`, and `studio/ensure-db.ts` all have near-identical ~30-line blocks to initialize `KMSProviderPool` → `KMSResolver` → `DEKManager` → `TenantEncryptionFacade`.

**Fix:** Extract a shared helper (e.g., `initializeDEKFacade(masterKeyHex)`) in `packages/database/src/kms/`.

### Issue 15: No protection against accidental double-set of global facade

**File:** `packages/shared-encryption/src/facade-accessor.ts`

`setGlobalEncryptionFacade` silently overwrites any existing facade. In hot-module-reload or multi-init scenarios, the previous facade is abandoned without shutdown.

**Fix:** Log a warning on overwrite, or throw if already set (with an explicit `replace` method for test resets).

### Issue 16: `reason` field not validated at runtime

**File:** `apps/runtime/src/routes/kms-admin.ts`

In POST `/keys/rotate`, `req.body.reason` is passed directly to `enqueueReencryption()` without validating against the `'kek-age-exceeded' | 'manual-rotation' | 'key-compromise'` union type. TypeScript enforcement is compile-time only.

**Fix:** Add Zod validation for the reason field.

---

## LOW Issues

### Issue 17: `console.warn`/`console.info` in `packages/database/`

**Files:** `dek-manager.ts`, `kms-provider-pool.ts`

Documented as intentional (circular dependency with `@abl/compiler/platform`), but should be documented as a permanent exception to the no-console.log rule, not just a code comment.

### Issue 18: Scope creep — unrelated changes bundled

- `runtime/server.ts`: A2A connection handler, `MemoryA2ASessionResolver`, `agentCardProvider` additions are unrelated to KMS/DEK changes
- `studio/`: `MessageList.tsx` whitespace, `useKnowledgeBases` retry config, `search-ai-proxy.ts` error handling are separate concerns
- `studio/ProjectOverviewPage.tsx`: SWR retry config change

These should be separate commits.

### Issue 19: ClickHouse column name mismatch

**File:** `apps/runtime/src/services/kms/kms-audit-logger.ts`

TypeScript `dekId` maps to ClickHouse `epoch` column. Semantic mismatch should be documented in the interface.

### Issue 20: `configActive` field removed from PUT /config response

**File:** `apps/runtime/src/routes/kms-admin.ts`

Potentially breaking for API consumers relying on this field.

### Issue 21: Missing re-exports in backward-compat layer

**File:** `packages/shared/src/encryption/index.ts`

`isLegacyCEKDocument`, `isDEKEnvelopeFormat`, `DEKScope`, `AcquiredDEK`, `DEKManagerLike` are exported from `@agent-platform/shared-encryption` but NOT re-exported from `@agent-platform/shared/encryption`. Consumers using the `@agent-platform/shared` path won't have access.

### Issue 22: `buildPlatformDefault()` can throw at resolve time

**File:** `packages/database/src/kms/kms-resolver.ts`

If `KMS_PROVIDER=aws-kms` but `KMS_AWS_KEY_ID` is missing, the first `resolve()` call throws. Fail-closed is correct, but the error surfaces late (at first encrypt/decrypt, not startup).

---

## Files Changed Summary

| Area                                   | Files | Change Type                                                                                                           |
| -------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------- |
| `packages/shared-encryption/src/`      | 7     | New codec, facade, legacy detection, accessor; modified engine, registry, index                                       |
| `packages/database/src/kms/`           | 6     | New DEKManager, KMSResolver, auth-config-crypto, accessor; modified provider-pool, index                              |
| `packages/database/src/models/`        | 3     | Modified dek-registry, tenant-kms-config, materialized-kms-config                                                     |
| `packages/database/src/mongo/plugins/` | 1     | Modified encryption.plugin (DEK facade integration)                                                                   |
| `packages/shared/src/encryption/`      | 1     | Modified re-exports                                                                                                   |
| `apps/runtime/src/services/kms/`       | 6     | Gutted to shims (dek-manager, kms-resolver), no-op stub (materializer), modified cache, audit, rotation, reencryption |
| `apps/runtime/src/routes/`             | 3     | Modified kms-admin (Zod, auth encryption), channel-connections, deployments                                           |
| `apps/runtime/src/services/`           | 5     | Modified model-resolution, secrets-provider, tool-oauth, delivery-worker, voice-session-resolver                      |
| `apps/runtime/src/server.ts`           | 1     | DEK facade init, A2A additions                                                                                        |
| `apps/search-ai*/src/server.ts`        | 2     | DEK facade init blocks                                                                                                |
| `apps/studio/src/`                     | 5     | DEK facade init, SWR retry config, proxy error handling                                                               |
| `docs/`                                | 5     | Feature spec, HLD, LLD, testing spec, Azure setup guide                                                               |
| Tests                                  | 15    | New and modified unit/integration/E2E tests                                                                           |

---

## Verdict

**Changes requested.** The cross-tenant `_lastAcquiredDekId` bug (Issue 1) is a ship-blocker. The compliance regression from epoch/scope removal needs an explicit decision and documentation. Issues 2-8 should be resolved before merge.
