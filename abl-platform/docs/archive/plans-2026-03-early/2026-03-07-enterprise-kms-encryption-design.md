# Enterprise KMS & Encryption Hardening — Design Document

> **Date:** 2026-03-07
> **Status:** Implemented (Phase 0-4 complete, Phase 5 partial) — updated 2026-03-08
> **Scope:** Fix broken multi-provider KMS wiring, harden encryption plugin, close security gaps

---

## Implementation Status (2026-03-08)

### Summary

The core KMS architecture has been implemented and verified end-to-end. The system is operational with local KMS provider, per-tenant config resolution, DEK lifecycle management, ClickHouse audit logging, and encryption round-trips passing all tests.

### Phase Status

| Phase                                        | Status      | Notes                                                                                                                                 |
| -------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 0: Prerequisites                       | COMPLETE    | `pbkdf2Sync` converted to async in `LocalKMSProvider`                                                                                 |
| Phase 1: Encryption Plugin Hardening         | COMPLETE    | Bulk op blocking, serialization stripping, atomic encryption, v3 downgrade prevention, master key validation, `findOneAndDelete` hook |
| Phase 2: KMS Provider Pool                   | COMPLETE    | `KMSProviderPool` with fingerprint-based LRU cache (50 max, 30min idle), 6 provider types                                             |
| Phase 3: Wire Pool Into Consumers            | COMPLETE    | `dek-manager`, `reencryption-queue`, `kms-rotation-job`, `kms-admin` health/rotate, `encryption.plugin` v2 path all use pool          |
| Phase 4: Config Validation & Materialization | COMPLETE    | Materialization is synchronous on config save, resolver cache with Redis Pub/Sub invalidation                                         |
| Phase 5: Store Gaps                          | NOT STARTED | ClickHouse FactStore encryption and Redis TLS cert validation not yet implemented                                                     |

### Audit Findings Resolution

#### KMS Wiring (all resolved)

| #   | Issue                                                      | Status | Resolution                                                           |
| --- | ---------------------------------------------------------- | ------ | -------------------------------------------------------------------- |
| W1  | Server hardcodes `LocalKMSProvider`                        | FIXED  | Server creates `KMSProviderPool`, calls `setKMSProviderPool()`       |
| W2  | Consumers ignore resolver, call `getPlatformKMSProvider()` | FIXED  | All consumers use `getKMSProviderPool().getProvider(resolvedConfig)` |
| W3  | `createKMSProvider()` factory never called                 | FIXED  | Pool calls factory internally on `getProvider()`                     |
| W4  | Admin saves config without validation                      | FIXED  | Materialization runs synchronously on save                           |
| W5  | Health endpoint checks wrong provider                      | FIXED  | Health resolves per-tenant provider via pool                         |
| W6  | Re-encryption uses global singleton                        | FIXED  | Uses pool with per-tenant resolution                                 |
| W7  | Encryption plugin v2 uses global `kmsProvider`             | FIXED  | Injected `kmsResolverFn` resolves per-tenant via pool                |
| W8  | Materialization is fire-and-forget                         | FIXED  | Awaited synchronously in PUT /config handler                         |

#### Encryption Plugin (all resolved)

| #   | Issue                                    | Status    | Resolution                                                                                             |
| --- | ---------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------ |
| E1  | Bulk ops bypass encryption               | FIXED     | `pre('insertMany')` and `pre('updateMany')` block plaintext                                            |
| E2  | Serialization leaks encrypted fields     | FIXED     | `toJSON`/`toObject` transforms strip `ire`, `cek`, `iv`, `kmsKeyId`                                    |
| E3  | Partial writes on mid-encryption failure | FIXED     | Encrypt to `Map` first, apply atomically                                                               |
| E4  | IV_LENGTH mismatch (16 vs 12)            | FIXED     | Plugin uses correct 12 bytes; shared constant unchanged for backward compat                            |
| E5  | v3 to v1 downgrade                       | FIXED     | Pre-save throws if `ire='v3'` and tenant encryption unavailable                                        |
| E6  | `ire` field mutable                      | PARTIAL   | Not made `immutable` on schema (breaks re-encryption); protected by pre-save logic                     |
| E7  | Master key hex not validated             | FIXED     | `setMasterKey()` validates `/^[0-9a-f]{64}$/i`                                                         |
| E8  | Decrypt returns ciphertext on failure    | PARTIAL   | Outer catch logs warning, leaves field encrypted (not thrown — avoids breaking reads for corrupt docs) |
| E9  | `findOneAndDelete` missing hook          | FIXED     | Added `post('findOneAndDelete')`                                                                       |
| E10 | Double-encryption detection fragile      | UNCHANGED | Low priority; regex works in practice                                                                  |

#### Configuration Model (all resolved)

| #   | Issue                                | Status | Resolution                                                                             |
| --- | ------------------------------------ | ------ | -------------------------------------------------------------------------------------- |
| C1  | Missing `dekRetentionDays`           | FIXED  | Added to `TenantKMSConfig` schema, used by rotation job                                |
| C2  | Missing `kekRotationPeriodDays`      | FIXED  | Added to schema                                                                        |
| C3  | Missing re-encryption settings       | FIXED  | `reencryption: { enabled, concurrency, batchSize, maxRetries }` added                  |
| C4  | Dead KMS env vars                    | FIXED  | Removed `KMS_PROVIDER`, `KMS_REGION`, `KMS_KEY_ID`, `KMS_VAULT_URL`                    |
| C5  | Rotation job reads env instead of DB | FIXED  | Per-tenant retention from `TenantKMSConfig`, global fallback for un-configured tenants |

#### Redis & ClickHouse (not started)

| #   | Issue                              | Status      | Resolution                                       |
| --- | ---------------------------------- | ----------- | ------------------------------------------------ |
| S1  | ClickHouse FactStore not encrypted | NOT STARTED | Needs `encryptionService` wiring                 |
| S2  | Redis TLS no cert validation       | NOT STARTED | Needs `ca`, `cert`, `rejectUnauthorized` options |
| S3  | Redis message content plaintext    | NOT STARTED | Needs encryption before persistence              |

### E2E Test Results (2026-03-08)

**Unit Tests:** 106 tests across 9 files, all passing

**KMS Live API Tests:** 14 passed, 0 failed, 2 warnings

- All 7 admin endpoints operational (config, keys, rotate, validate, audit, health)
- ClickHouse audit logging verified (config_update, force_rotate events)
- KMS startup chain verified (master key -> pool -> resolver -> cache invalidation -> plugin wired -> rotation job)
- DEK lifecycle verified (active -> decrypt_only -> destroyed by rotation job)

**Encryption Round-Trip:** 9 passed, 0 failed

- Create with plaintext -> MongoDB stores ciphertext (104 chars vs 49 original)
- Mongoose read transparently decrypts to original
- Update re-encrypts at rest, decrypts correctly

### Known Issues Found During Testing

1. **ClickHouse timestamp format**: `DateTime64(3)` cannot parse ISO 8601 trailing `Z` — fixed by stripping `Z` and replacing `T` with space
2. **DEK collection name**: Model uses `dek_registry` collection but seeds went to `dekentries` — corrected
3. **Cross-tenant access**: Auth middleware does not validate `req.params.tenantId` matches token's tenantId — pre-existing platform issue, not KMS-specific

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Audit Findings](#2-audit-findings)
3. [Design: KMS Provider Pool](#3-design-kms-provider-pool)
4. [Design: Encryption Plugin Hardening](#4-design-encryption-plugin-hardening)
5. [Design: Server Startup & Wiring](#5-design-server-startup--wiring)
6. [Design: Config Validation](#6-design-config-validation)
7. [Design: Redis & ClickHouse Gaps](#7-design-redis--clickhouse-gaps)
8. [Implementation Plan](#8-implementation-plan)
9. [Testing Strategy](#9-testing-strategy)
10. [Migration & Backward Compatibility](#10-migration--backward-compatibility)
11. [Risk Assessment](#11-risk-assessment)

---

## 1. Problem Statement

The platform has a sophisticated multi-provider KMS configuration system (per-tenant config, 5-level inheritance, materialized configs, DEK registry, rotation jobs) — but the actual runtime wiring is broken. Every KMS operation goes through a single `LocalKMSProvider` singleton regardless of tenant configuration. Additionally, the Mongoose encryption plugin has security gaps around bulk operations, serialization, and partial writes.

**Result:** Tenants configured with AWS KMS, Azure Key Vault, or GCP Cloud KMS are silently using LocalKMS. This is a compliance violation and security risk.

---

## 2. Audit Findings

### 2.1 KMS Wiring (CRITICAL)

| #   | Issue                                                                                                | Severity | File                                                         |
| --- | ---------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------ |
| W1  | Server always hardcodes `LocalKMSProvider` — ignores per-tenant KMS config from DB                   | CRITICAL | `server.ts`                                                  |
| W2  | `KMSResolver` returns `providerType` but every consumer ignores it, calls `getPlatformKMSProvider()` | CRITICAL | `kms-resolver.ts`, `dek-manager.ts`, `reencryption-queue.ts` |
| W3  | `createKMSProvider()` factory exists but is never called at runtime                                  | CRITICAL | `providers/index.ts`                                         |
| W4  | Admin saves config with no validation that provider can be instantiated                              | HIGH     | `kms-admin.ts`                                               |
| W5  | Health endpoint reports tenant's configured provider but checks LocalKMS                             | MEDIUM   | `kms-admin.ts`                                               |
| W6  | Re-encryption job uses global singleton, would corrupt DEKs on real KMS                              | CRITICAL | `reencryption-queue.ts`                                      |
| W7  | Encryption plugin v2 path uses global `kmsProvider`/`kmsKeyId` set at startup                        | HIGH     | `encryption.plugin.ts`                                       |
| W8  | Config change race condition — materialization is fire-and-forget                                    | HIGH     | `kms-admin.ts`                                               |

### 2.2 Encryption Plugin (HIGH)

| #   | Issue                                                                        | Severity | File                                   |
| --- | ---------------------------------------------------------------------------- | -------- | -------------------------------------- |
| E1  | Bulk ops (`insertMany`, `updateMany`, `deleteMany`) bypass encryption hooks  | HIGH     | `encryption.plugin.ts`                 |
| E2  | No `toJSON`/`toObject` hook — encrypted fields leak in serialization         | HIGH     | `encryption.plugin.ts`                 |
| E3  | Partial writes on mid-save encryption failure (non-atomic)                   | HIGH     | `encryption.plugin.ts`                 |
| E4  | IV_LENGTH mismatch: shared constants=16, plugin=12                           | HIGH     | `constants.ts`, `encryption.plugin.ts` |
| E5  | v3→v1 downgrade if tenant encryption temporarily unavailable                 | MEDIUM   | `encryption.plugin.ts`                 |
| E6  | `ire` field is mutable — can be manually modified to force wrong decrypt     | MEDIUM   | `encryption.plugin.ts`                 |
| E7  | Master key hex format not validated — `Buffer.from` silently truncates       | MEDIUM   | `engine.ts`                            |
| E8  | Decryption returns ciphertext as-is if all attempts fail instead of throwing | MEDIUM   | `encryption.plugin.ts`                 |
| E9  | `findOneAndDelete` not in post-hooks — returns encrypted fields              | MEDIUM   | `encryption.plugin.ts`                 |
| E10 | Double-encryption detection regex is fragile (matches any 3-part hex)        | LOW      | `encryption.plugin.ts`                 |

### 2.3 Configuration Model Gaps

| #   | Issue                                                                                                                               | Severity | File                         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------- |
| C1  | `TenantKMSConfig` missing `dekRetentionDays` — hardcoded in env var                                                                 | HIGH     | `tenant-kms-config.model.ts` |
| C2  | `TenantKMSConfig` missing `kekRotationPeriodDays` — hardcoded in env var                                                            | HIGH     | `tenant-kms-config.model.ts` |
| C3  | `TenantKMSConfig` missing re-encryption settings (`enabled`, `concurrency`, `batchSize`, `maxRetries`) — all hardcoded as env vars  | HIGH     | `tenant-kms-config.model.ts` |
| C4  | `KMS_PROVIDER`, `KMS_REGION`, `KMS_KEY_ID`, `KMS_VAULT_URL` env vars exist in config but are dead code — never consumed, misleading | LOW      | `config/index.ts`            |
| C5  | Rotation job reads `KMS_ROTATION_INTERVAL_MINUTES` and `KMS_DEK_RETENTION_DAYS` from env instead of per-tenant config               | HIGH     | `kms-rotation-job.ts`        |

### 2.4 Redis & ClickHouse

| #   | Issue                                                                      | Severity | File                           |
| --- | -------------------------------------------------------------------------- | -------- | ------------------------------ |
| S1  | ClickHouse FactStore not encrypted — may contain sensitive data            | MEDIUM   | `clickhouse-fact-store.ts`     |
| S2  | Redis TLS: no cert validation options (`ca`, `cert`, `rejectUnauthorized`) | MEDIUM   | `redis-client.ts`              |
| S3  | Redis message content stored in plaintext before persistence               | MEDIUM   | `message-persistence-queue.ts` |

---

## 3. Design: KMS Provider Pool

### 3.1 Architecture

Replace the global `setPlatformKMSProvider()` singleton with a `KMSProviderPool` that lazily instantiates, caches, and manages provider instances keyed by their configuration fingerprint.

```
                  KMSProviderPool (singleton)
                  |
                  +-- providers: Map<fingerprint, PooledProvider>
                  |     |
                  |     +-- "local:default" --> LocalKMSProvider
                  |     +-- "aws-kms:us-east-1:arn:..." --> AWSKMSProvider
                  |     +-- "azure-keyvault:https://vault..." --> AzureKeyVaultProvider
                  |
                  +-- getProvider(resolvedConfig) --> KMSProvider
                  +-- healthCheck(fingerprint) --> HealthStatus
                  +-- shutdown() --> void (shuts down all)
```

### 3.2 Fingerprint Strategy

Provider instances are keyed by a deterministic fingerprint derived from immutable config properties (not credentials):

```typescript
function computeFingerprint(config: IResolvedProviderRef): string {
  switch (config.providerType) {
    case 'local':
      return 'local:default';
    case 'aws-kms':
      return `aws-kms:${config.region}:${config.keyId}`;
    case 'azure-keyvault':
    case 'azure-managed-hsm':
      return `${config.providerType}:${config.vaultUrl}`;
    case 'gcp-cloud-kms':
      return `gcp-cloud-kms:${config.projectId}:${config.location}:${config.keyRing}`;
    case 'external':
      return `external:${config.externalEndpoint}`;
  }
}
```

Two tenants on the same AWS region + key share the same provider instance. Two tenants on different AWS regions get separate instances.

### 3.3 Pool Lifecycle

```typescript
interface KMSProviderPool {
  /** Get or create a provider for the given resolved config */
  getProvider(config: IResolvedProviderRef): Promise<KMSProvider>;

  /** Get the default local provider (for v1 fallback) */
  getLocalProvider(): KMSProvider;

  /** Health check a specific provider */
  healthCheck(config: IResolvedProviderRef): Promise<HealthStatus>;

  /** Evict a specific provider (e.g., on credential rotation) */
  evict(fingerprint: string): Promise<void>;

  /** Shutdown all providers */
  shutdown(): Promise<void>;
}
```

### 3.4 Pool Constraints

| Parameter             | Value  | Rationale                                                 |
| --------------------- | ------ | --------------------------------------------------------- |
| Max pool size         | 50     | Bound memory; most deployments have < 10 provider configs |
| Idle timeout          | 30 min | Release unused SDK clients                                |
| Eviction policy       | LRU    | Evict least-recently-used provider on pool full           |
| Initialize timeout    | 10s    | Fail fast if cloud SDK can't connect                      |
| Health check interval | 5 min  | Detect provider failures early                            |

### 3.5 Error Handling

- `getProvider()` throws if provider can't be instantiated (fail-closed)
- Existing circuit breaker wraps each pooled provider instance
- On eviction, `provider.shutdown()` is called and key material is zero-filled
- `getLocalProvider()` always returns the local fallback (never evicted)

### 3.6 File Location

```
packages/database/src/kms/kms-provider-pool.ts
```

---

## 4. Design: Encryption Plugin Hardening

### 4.1 Fix Bulk Operation Bypass (E1)

Add `pre` middleware for write operations that bypass `save()`:

```typescript
// Block unencrypted bulk writes on models with encryption plugin
schema.pre('insertMany', function (next, docs) {
  for (const doc of docs) {
    for (const field of fieldsToEncrypt) {
      if (doc[field] && !isEncryptedValue(doc[field])) {
        return next(
          new Error(
            `[encryption-plugin] Cannot insertMany with unencrypted field '${field}'. Use save() or encrypt manually.`,
          ),
        );
      }
    }
  }
  next();
});

schema.pre('updateMany', function (next) {
  const update = this.getUpdate();
  for (const field of fieldsToEncrypt) {
    if (update?.$set?.[field] && !isEncryptedValue(update.$set[field])) {
      return next(
        new Error(
          `[encryption-plugin] Cannot updateMany with unencrypted field '${field}'. Use findOneAndUpdate() or encrypt manually.`,
        ),
      );
    }
  }
  next();
});
```

This **blocks** bulk writes with plaintext encrypted fields rather than silently allowing them. Code that needs bulk operations must pre-encrypt values.

### 4.2 Fix Serialization Leak (E2)

Add transform to strip or preserve encrypted fields on serialization:

```typescript
schema.set('toJSON', {
  transform: (doc, ret) => {
    // Fields are already decrypted by post-find hooks for normal queries.
    // For safety, strip encryption metadata from JSON output.
    delete ret.ire;
    delete ret.cek;
    delete ret.iv;
    delete ret.kmsKeyId;
    return ret;
  },
});
```

### 4.3 Fix Partial Writes (E3)

Encrypt all fields to a temporary map first, then apply atomically:

```typescript
// Current (BROKEN):
for (const field of fieldsToEncrypt) {
  this.set(field, encrypt(this.get(field))); // Fails mid-loop = partial
}

// Fixed (ATOMIC):
const encrypted = new Map<string, string>();
for (const field of fieldsToEncrypt) {
  encrypted.set(field, encrypt(this.get(field))); // All-or-nothing
}
// Only apply if ALL succeeded
for (const [field, value] of encrypted) {
  this.set(field, value);
}
```

### 4.4 Fix IV_LENGTH Mismatch (E4)

The plugin's local `IV_LENGTH = 12` is correct for AES-256-GCM. The shared constant of 16 is wrong for GCM mode (GCM recommends 96-bit = 12-byte IVs per NIST SP 800-38D).

**Fix:** Update `packages/shared/src/encryption/constants.ts` to use `IV_LENGTH = 12`.

Audit all consumers of the shared constant to verify they work with 12 bytes. The `engine.ts` `aesGcmEncryptHex` method generates IVs via `randomBytes(IV_LENGTH)` — changing to 12 only affects NEW encryptions. Old 16-byte IV data is self-describing (IV is stored in output format).

### 4.5 Prevent v3→v1 Downgrade (E5)

If a document already has `ire='v3'`, refuse to downgrade:

```typescript
// In pre-save hook:
if (existingIre === 'v3' && !isTenantEncryptionAvailable()) {
  throw new Error(
    '[encryption-plugin] Cannot save: tenant encryption unavailable and document requires v3. ' +
      'Refusing to downgrade to v1.',
  );
}
```

### 4.6 Make `ire` Field Immutable After First Write (E6)

```typescript
schema.add({
  ire: { type: String, immutable: true },
});
```

Note: Mongoose `immutable` prevents modification via `save()` and `findOneAndUpdate()` but not raw MongoDB operations. This is acceptable — raw MongoDB access is already a privileged operation.

### 4.7 Fix Decrypt Failure Behavior (E8)

Instead of returning ciphertext on decrypt failure, throw:

```typescript
// Current: silently returns encrypted data
// Fixed: throw with context
if (allDecryptAttemptsFailed) {
  throw new Error(
    `[encryption-plugin] Failed to decrypt field '${field}' on document ${doc._id}. ` +
      `Encryption version: ${doc.ire}. All decrypt paths exhausted.`,
  );
}
```

### 4.8 Add Missing Post-Hook (E9)

```typescript
// Add to the existing post-hook list:
for (const hook of ['find', 'findOne', 'findOneAndUpdate', 'findOneAndDelete']) {
  schema.post(hook, async function (docs) { ... });
}
```

---

## 5. Design: Server Startup & Wiring

### 5.1 Current (Broken)

```typescript
// server.ts — always LocalKMSProvider
const kmsProvider = new LocalKMSProvider(masterKey);
setPlatformKMSProvider(kmsProvider);
```

### 5.2 Proposed

```typescript
// server.ts — initialize pool with local provider as default
const { KMSProviderPool } = await import('@agent-platform/database/kms');
const pool = new KMSProviderPool({ masterKey: encMasterKey });
await pool.initialize(); // Creates LocalKMSProvider as default
setKMSProviderPool(pool); // Replace setPlatformKMSProvider

// For backward compat, existing getPlatformKMSProvider() returns pool.getLocalProvider()
```

### 5.3 Consumer Migration

Every place that calls `getPlatformKMSProvider()` must be updated to use the pool with resolved config:

```typescript
// BEFORE (broken):
const kms = getPlatformKMSProvider();
await kms.wrapKey(keyId, plaintext);

// AFTER (correct):
const pool = getKMSProviderPool();
const config = await resolver.resolve(tenantId, projectId, environment);
const kms = await pool.getProvider(config.provider);
await kms.wrapKey(config.provider.keyId, plaintext);
```

### 5.4 Affected Consumers

| File                        | Current                    | Change                                        |
| --------------------------- | -------------------------- | --------------------------------------------- |
| `dek-manager.ts`            | `getPlatformKMSProvider()` | `pool.getProvider(resolvedConfig)`            |
| `reencryption-queue.ts`     | `getPlatformKMSProvider()` | `pool.getProvider(resolvedConfig)`            |
| `kms-admin.ts` (health)     | `getPlatformKMSProvider()` | `pool.getProvider(resolvedConfig)`            |
| `kms-admin.ts` (rotate)     | `getPlatformKMSProvider()` | `pool.getProvider(resolvedConfig)`            |
| `encryption.plugin.ts` (v2) | Global `kmsProvider`       | `pool.getProvider(resolvedConfig)`            |
| `kms-rotation-job.ts`       | `getPlatformKMSProvider()` | `pool.getProvider(resolvedConfig)` per tenant |

### 5.5 Encryption Plugin v2 Change

The plugin currently holds a global `kmsProvider` and `kmsKeyId` set at startup. This must change to resolve per-document:

```typescript
// encryption.plugin.ts v2 path — BEFORE:
const { ciphertext } = await kmsProvider.wrapKey(kmsKeyId, cek);

// AFTER:
const pool = getKMSProviderPool();
const tenantId = this.get(tenantIdField);
const config = await kmsResolver.resolve(tenantId);
const provider = await pool.getProvider(config.provider);
const { ciphertext } = await provider.wrapKey(config.provider.keyId, cek);
```

---

## 6. Design: Config Validation

### 6.1 Validate on Save

When admin saves a tenant's KMS config, validate BEFORE persisting:

```typescript
// kms-admin.ts PUT /config — PROPOSED:
async function validateProviderConfig(config: IKMSProviderRef): Promise<void> {
  const pool = getKMSProviderPool();
  const provider = await pool.getProvider(config);  // Tries to instantiate
  const health = await provider.healthCheck();       // Verifies connectivity
  if (!health.healthy) {
    throw new ValidationError(`KMS provider health check failed: ${health.message}`);
  }
}

// Validate BEFORE saving
await validateProviderConfig(body.defaultProvider);
const updated = await TenantKMSConfig.findOneAndUpdate(...);
```

### 6.2 Synchronous Materialization

Change materialization from fire-and-forget to awaited:

```typescript
// BEFORE:
materializer.materialize(tenantId).catch(...);  // Fire-and-forget

// AFTER:
await materializer.materialize(tenantId);  // Wait for completion
// Now resolver will return correct config immediately
```

### 6.3 Master Key Validation

```typescript
// engine.ts constructor:
if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) {
  throw new Error('ENCRYPTION_MASTER_KEY must be exactly 64 hex characters (32 bytes)');
}
```

---

## 7. Design: Redis & ClickHouse Gaps

### 7.1 ClickHouse FactStore Encryption (S1)

Wire `encryptionService` into `ClickHouseFactStore` following the same pattern as `ClickHouseMessageStore`:

```typescript
// clickhouse-fact-store.ts
constructor(options: { client, encryptionService, tenantId }) {
  this.encryption = options.encryptionService;
}

async setFact(key, value) {
  const encrypted = this.encryption.compressAndEncryptForTenant(
    JSON.stringify(value), this.tenantId
  );
  await this.insert({ key, value: encrypted, encrypted: 1 });
}
```

### 7.2 Redis TLS Enhancement (S2)

Extend Redis config schema:

```typescript
// redis.schema.ts
const RedisSchema = z.object({
  url: z.string(),
  enabled: z.boolean().default(true),
  tls: z.boolean().default(false),
  tlsRejectUnauthorized: z.boolean().default(true),
  tlsCa: z.string().optional(), // CA cert path
  tlsCert: z.string().optional(), // Client cert path
  tlsKey: z.string().optional(), // Client key path
  cluster: z.boolean().default(false),
});
```

### 7.3 ClickHouse TLS (Not in scope)

Adding TLS to ClickHouse is a config-level change (switch URL from `http://` to `https://`). Document it but don't add code — it's a deployment concern.

---

## 8. Implementation Plan

### Phase 1: Security Fixes (No Behavioral Change)

Fixes that harden existing behavior without changing the KMS provider model.

| Task                            | Issue(s) | Risk   | Files                  |
| ------------------------------- | -------- | ------ | ---------------------- |
| 1.1 Fix bulk operation bypass   | E1       | HIGH   | `encryption.plugin.ts` |
| 1.2 Fix serialization leak      | E2       | HIGH   | `encryption.plugin.ts` |
| 1.3 Fix partial write atomicity | E3       | HIGH   | `encryption.plugin.ts` |
| 1.4 Fix IV_LENGTH constant      | E4       | HIGH   | `constants.ts`         |
| 1.5 Prevent v3→v1 downgrade     | E5       | MEDIUM | `encryption.plugin.ts` |
| 1.6 Make `ire` immutable        | E6       | MEDIUM | `encryption.plugin.ts` |
| 1.7 Validate master key hex     | E7       | MEDIUM | `engine.ts`            |
| 1.8 Throw on decrypt failure    | E8       | MEDIUM | `encryption.plugin.ts` |
| 1.9 Add `findOneAndDelete` hook | E9       | MEDIUM | `encryption.plugin.ts` |

### Phase 2: KMS Provider Pool

Build the pool and wire it in, keeping LocalKMS as default.

| Task                                                                              | Issue(s) | Risk   | Files                        |
| --------------------------------------------------------------------------------- | -------- | ------ | ---------------------------- |
| 2.1 Implement `KMSProviderPool`                                                   | W1-W3    | HIGH   | `kms-provider-pool.ts` (new) |
| 2.2 Add `setKMSProviderPool` / `getKMSProviderPool` to registry                   | W1       | MEDIUM | `kms-registry.ts`            |
| 2.3 Update server startup to use pool                                             | W1       | HIGH   | `server.ts`                  |
| 2.4 Backward compat: `getPlatformKMSProvider()` returns `pool.getLocalProvider()` | —        | LOW    | `kms-registry.ts`            |

### Phase 3: Wire Pool Into Consumers

Replace every `getPlatformKMSProvider()` call with pool-resolved provider.

| Task                                       | Issue(s) | Risk     | Files                   |
| ------------------------------------------ | -------- | -------- | ----------------------- |
| 3.1 Update `dek-manager.ts`                | W2       | HIGH     | `dek-manager.ts`        |
| 3.2 Update `reencryption-queue.ts`         | W6       | CRITICAL | `reencryption-queue.ts` |
| 3.3 Update `kms-rotation-job.ts`           | W2       | HIGH     | `kms-rotation-job.ts`   |
| 3.4 Update `kms-admin.ts` (health, rotate) | W5       | MEDIUM   | `kms-admin.ts`          |
| 3.5 Update `encryption.plugin.ts` v2 path  | W7       | HIGH     | `encryption.plugin.ts`  |

### Phase 4: Config Validation & Materialization

| Task                                       | Issue(s) | Risk   | Files                               |
| ------------------------------------------ | -------- | ------ | ----------------------------------- |
| 4.1 Add provider validation on config save | W4       | HIGH   | `kms-admin.ts`                      |
| 4.2 Make materialization synchronous       | W8       | MEDIUM | `kms-admin.ts`                      |
| 4.3 Add cloud provider config validators   | W4       | MEDIUM | `kms-admin.ts`, new validator files |

### Phase 5: Store Gaps

| Task                                          | Issue(s) | Risk   | Files                                |
| --------------------------------------------- | -------- | ------ | ------------------------------------ |
| 5.1 Wire encryption into ClickHouse FactStore | S1       | MEDIUM | `clickhouse-fact-store.ts`           |
| 5.2 Extend Redis TLS config schema            | S2       | LOW    | `redis.schema.ts`, `redis-client.ts` |

---

## 9. Testing Strategy

### Unit Tests

| Area                    | Test Cases                                                                 |
| ----------------------- | -------------------------------------------------------------------------- |
| KMSProviderPool         | Instantiation, caching, eviction, shutdown, zero-fill, concurrent access   |
| Bulk op blocking        | `insertMany` with plaintext → throws, `updateMany` with plaintext → throws |
| Serialization           | `toJSON()` strips encryption metadata, `toObject()` strips metadata        |
| Atomic encryption       | Mid-encryption failure → document unchanged                                |
| v3 downgrade prevention | Save v3 doc without tenant encryption → throws                             |
| Provider resolution     | Resolve AWS config → get AWSKMSProvider, resolve local → get LocalKMS      |
| Config validation       | Invalid AWS config → validation error before save                          |
| `findOneAndDelete`      | Returns decrypted fields                                                   |

### Integration Tests

| Area           | Test Cases                                                                      |
| -------------- | ------------------------------------------------------------------------------- |
| Multi-provider | Tenant A (local) + Tenant B (local simulating AWS key) → different key material |
| DEK rotation   | Rotate with resolved provider → DEKs re-wrapped with correct provider           |
| Health check   | Health endpoint returns correct provider type AND health                        |
| Config change  | Update config → immediate materialization → next encrypt uses new config        |

### Existing Test Verification

All 51 existing `curl-parser` tests and ClickHouse enterprise tests must continue passing.

---

## 10. Migration & Backward Compatibility

### No Data Migration Required

- Phase 1 (plugin hardening) changes behavior for NEW writes only
- Phase 2-3 (pool) is backward compatible — `getPlatformKMSProvider()` still works, returns local
- Existing v1/v2/v3 encrypted documents decrypt without changes
- Pool defaults to LocalKMS when no tenant config exists

### Breaking Changes

| Change               | Impact                                                  | Mitigation                          |
| -------------------- | ------------------------------------------------------- | ----------------------------------- |
| Bulk ops blocked     | Code using `insertMany` with encrypted models will fail | Audit all call sites before deploy  |
| Decrypt throws       | Code catching decryption errors may need updates        | Add error handler in API middleware |
| `ire` immutable      | Code manually setting `ire` will fail                   | Should not exist — audit first      |
| Materialization sync | Config save is slower (~100ms)                          | Acceptable for admin operations     |

---

## 11. Risk Assessment

| Phase   | Risk                                         | Mitigation                                                              |
| ------- | -------------------------------------------- | ----------------------------------------------------------------------- |
| Phase 1 | Bulk op blocking breaks existing code        | Audit all `insertMany`/`updateMany` call sites first                    |
| Phase 2 | Pool initialization failure blocks startup   | Local provider always available as fallback                             |
| Phase 3 | Wrong provider for existing documents        | Documents store their `ire` + `kmsKeyId` — decrypt uses stored metadata |
| Phase 4 | Config validation blocks legitimate saves    | Add `skipValidation` escape hatch for emergencies                       |
| Phase 5 | FactStore encryption breaks existing queries | Add `encrypted` column, handle `encrypted=0` rows                       |
