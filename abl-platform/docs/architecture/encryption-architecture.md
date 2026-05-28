# Encryption Architecture

> **Status:** Living document — last verified 2026-03-08 (all E2E tests passing)
> **Scope:** End-to-end encryption across MongoDB, Redis, ClickHouse, and KMS integration
> **Supersedes:** All prior encryption docs in `docs/plans/2026-02-23-*` and `docs/plans/2026-03-06-*`
> **Design doc:** `docs/plans/2026-03-07-enterprise-kms-encryption-design.md` (audit findings + implementation status)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Core Encryption Service](#2-core-encryption-service)
3. [Key Hierarchy](#3-key-hierarchy)
4. [MongoDB Encryption](#4-mongodb-encryption)
5. [ClickHouse Encryption](#5-clickhouse-encryption)
6. [Redis Encryption](#6-redis-encryption)
7. [KMS Architecture](#7-kms-architecture)
8. [Key Rotation](#8-key-rotation)
9. [Transport Security](#9-transport-security)
10. [Server Startup Wiring](#10-server-startup-wiring)
11. [Environment Variables](#11-environment-variables)
12. [Compliance & GDPR](#12-compliance--gdpr)
13. [Known Gaps & Roadmap](#13-known-gaps--roadmap)
14. [Key Files Reference](#14-key-files-reference)

---

## 1. Overview

The platform implements application-layer encryption using **AES-256-GCM** (NIST-approved) across all three data stores. A single `EncryptionService` singleton provides the cryptographic primitives, with store-specific integration layers handling when and how encryption occurs.

```
                    +----------------------------------+
                    |     ENCRYPTION_MASTER_KEY (env)   |
                    |       64-char hex (32 bytes)      |
                    +----------------+-----------------+
                                     |
                    +----------------v-----------------+
                    |    EncryptionService (singleton)   |
                    |   packages/shared/src/encryption/  |
                    +--+-------------+-------------+---+
                       |             |             |
          +------------v--+  +------v------+  +---v-----------+
          |   MONGODB      |  |   REDIS     |  |  CLICKHOUSE   |
          |                |  |             |  |               |
          | Mongoose plugin|  | App-layer   |  | Compress +   |
          | v1/v2/v3       |  | per-flow    |  | encrypt       |
          | Pre-save/      |  | (messages,  |  | per-insert    |
          | Post-find      |  |  sessions)  |  |               |
          +----------------+  +-------------+  +---------------+
```

### Design Principles

- **Single source of truth** — One `EncryptionService` class in `packages/shared`, no copies
- **Tenant isolation** — Every encryption operation is scoped to a `tenantId` via HKDF key derivation
- **Fail-closed** — Missing keys or KMS failures reject the operation, never store plaintext
- **Backward compatible** — Three encryption versions (v1, v2, v3) with auto-detection on read
- **Compress before encrypt** — Zstd compression for ClickHouse payloads >= 64 bytes

---

## 2. Core Encryption Service

**File:** `packages/shared/src/encryption/engine.ts`

### Algorithm

| Parameter       | Value                                                          |
| --------------- | -------------------------------------------------------------- |
| Cipher          | AES-256-GCM                                                    |
| Key length      | 32 bytes (256 bits)                                            |
| IV length       | 12 bytes (96 bits)                                             |
| Auth tag length | 16 bytes (128 bits)                                            |
| Key derivation  | HKDF-SHA256 (modern) / PBKDF2-SHA256 (legacy, 100k iterations) |

### Scoping Levels

```
EncryptionService
  |
  +-- encrypt(plaintext, userId)              # User-scoped
  +-- encryptForTenant(plaintext, tenantId)   # Tenant-scoped
  +-- encryptContactPII(plaintext, contactId) # Contact-scoped (GDPR)
  |
  +-- compressAndEncryptForTenant(data, tid)  # Compress + encrypt (ClickHouse)
  +-- decryptAndDecompressForTenant(enc, tid) # Decrypt + decompress
```

### Singleton Access

```typescript
import { getEncryptionService } from '@agent-platform/shared/encryption';

const enc = getEncryptionService(); // Reads ENCRYPTION_MASTER_KEY on first call
enc.encryptForTenant(plaintext, tenantId);
```

### Tenant Key Cache

- `TenantKeyCache` with configurable max size (default: 1000) and TTL (default: 30 min)
- Single-flight coalescing prevents thundering herd on cache miss
- `evictTenantKey(tenantId)` for targeted invalidation

---

## 3. Key Hierarchy

```
  ENCRYPTION_MASTER_KEY (env, 32 bytes)
           |
           +-- HKDF(master, "tenant:{tenantId}")  -->  Tenant DEK
           |       |
           |       +-- AES-256-GCM encrypt/decrypt
           |
           +-- HKDF(master, "contact:{contactId}") -->  Contact DEK
           |       |
           |       +-- PII encrypt/decrypt (GDPR crypto-shredding)
           |
           +-- PBKDF2(master, "user:{userId}")     -->  User DEK (legacy)
           |
           +-- PBKDF2(master, "kms:{kmsKeyId}")    -->  KMS local key (LocalKMSProvider)
```

For cloud KMS (v2), the key hierarchy extends:

```
  Cloud KMS (AWS/Azure/GCP)
           |
           +-- KEK (Key Encryption Key, managed by cloud)
                 |
                 +-- wrapKey(DEK) --> stored in MongoDB doc as `cek`
                 +-- unwrapKey(cek) --> plaintext DEK for field encryption
```

---

## 4. MongoDB Encryption

**File:** `packages/database/src/mongo/plugins/encryption.plugin.ts`

### Plugin Model

Mongoose plugin attached to schemas that contain sensitive fields:

```typescript
schema.plugin(encryptionPlugin, {
  fieldsToEncrypt: ['apiKey', 'secret', 'accessToken'],
  tenantIdField: 'tenantId', // field name for tenant scoping
});
```

**Hooks:**

- `pre('save')` — Encrypt specified fields before write
- `post('find')`, `post('findOne')`, `post('findOneAndUpdate')` — Decrypt after read

### Three Encryption Versions

```
+--------+---------------------+----------------------------+------------------+
| Version| Key Management      | Stored Metadata            | When Used        |
+--------+---------------------+----------------------------+------------------+
| v1     | Master key CEK      | ire='v1', iv, cek (base64) | Legacy docs      |
|        | (PBKDF2 derived)    |                            |                  |
+--------+---------------------+----------------------------+------------------+
| v2     | KMS-wrapped CEK     | ire='v2', cek, kmsKeyId    | Cloud KMS active |
|        | (AWS/Azure/GCP)     |                            |                  |
+--------+---------------------+----------------------------+------------------+
| v3     | Tenant-scoped HKDF  | ire='v3', field values as  | Default (modern) |
|        | (no per-doc CEK)    | hex iv:authTag:ciphertext  |                  |
+--------+---------------------+----------------------------+------------------+
```

### Version Detection on Read

```
Read document from MongoDB
  |
  +-- ire='v3'? --> decryptForTenant(fieldValue, tenantId)
  |
  +-- ire='v2'? --> unwrapKey(kmsKeyId, cek) --> decrypt fields with CEK
  |
  +-- ire='v1'? --> unwrapCEK(masterKey, cek, iv) --> decrypt fields with CEK
  |                   |
  |                   +-- unwrap fails? --> try legacy route decryption
  |
  +-- no ire?   --> try v3 hex format detection
                      |
                      +-- looks like hex iv:authTag:ct? --> v3 decrypt
                      +-- otherwise --> return as-is (unencrypted)
```

### Encrypted Models

| Model                 | Encrypted Fields                             | Version |
| --------------------- | -------------------------------------------- | ------- |
| `EnvironmentVariable` | `value`                                      | v3      |
| `ChannelConnection`   | `credentials`, `accessToken`, `refreshToken` | v3      |
| `MCPServerConfig`     | `authConfig`                                 | v3      |
| `WebhookSubscription` | `secret`                                     | v3      |
| `OrgProxyConfig`      | 6 credential fields                          | v3      |
| `ToolSecret`          | `value`                                      | v3      |
| `EndUserOAuthToken`   | `accessToken`, `refreshToken`                | v3      |

---

## 5. ClickHouse Encryption

### Architecture

ClickHouse has no native field-level encryption. The platform encrypts at the application layer before insert and decrypts after read.

```
Application Data
  --> JSON.stringify()
  --> Zstd compress (if >= 64 bytes, level 3)
  --> AES-256-GCM encrypt (tenant-scoped key)
  --> Format: "Z1:iv:authTag:ciphertext"  (compressed)
         or   "N0:iv:authTag:ciphertext"  (not compressed)
  --> INSERT into ClickHouse as TEXT column
```

### Store Encryption Matrix

| Store                    | File                          | Encrypted? | Method                                          |
| ------------------------ | ----------------------------- | ---------- | ----------------------------------------------- |
| `ClickHouseMessageStore` | `clickhouse-message-store.ts` | Yes        | `compressAndEncryptForTenant()` on `content`    |
| `ClickHouseTraceStore`   | `clickhouse-trace-store.ts`   | Yes        | `compressAndEncryptForTenant()` on `data`       |
| `ClickHouseMetricsStore` | `clickhouse-metrics-store.ts` | No         | Token counts/costs are not PII                  |
| `ClickHouseAuditStore`   | `clickhouse-audit-store.ts`   | No         | Plaintext for compliance querying               |
| `ClickHouseFactStore`    | `clickhouse-fact-store.ts`    | No         | Gap — see [Known Gaps](#13-known-gaps--roadmap) |

### Wiring

```typescript
// clickhouse-store-factory.ts
const factory = await createClickHouseStoreFactory({
  tenantId,
  encryptionService: getEncryptionService(), // Same singleton
});
```

Each store receives `encryptionService: EncryptionService` via constructor injection from the factory.

### Backward Compatibility

Rows include an `encrypted` column (0 or 1). On read:

- `encrypted=1` → decrypt and decompress
- `encrypted=0` → return raw content (pre-encryption data)

---

## 6. Redis Encryption

### Current State

Redis does **not** have a universal encryption wrapper. Encryption is applied at the application layer for specific flows only.

### What's Encrypted

| Flow                | Where                          | How                                        |
| ------------------- | ------------------------------ | ------------------------------------------ |
| Message persistence | `message-persistence-queue.ts` | `encryptForTenant()` before BullMQ enqueue |
| Session state       | Session store                  | `encryptForTenant()` before Redis SET      |

### What's NOT Encrypted

| Data                  | Risk                               |
| --------------------- | ---------------------------------- |
| Circuit breaker state | Low — operational flags only       |
| Rate limiter counters | Low — numeric counters only        |
| Verification tokens   | Medium — short-lived but sensitive |
| BullMQ job metadata   | Low — job IDs and timestamps       |

### Transport Security

Redis TLS is available via `config.redis.tls` flag, but certificate validation options are limited — see [Known Gaps](#13-known-gaps--roadmap).

---

## 7. KMS Architecture

### Provider Interface

**File:** `packages/database/src/kms/types.ts`

```typescript
interface KMSProvider {
  // Lifecycle
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  healthCheck(): Promise<HealthStatus>;

  // Core operations
  generateDataKey(keyId: string): Promise<{ plaintext: Buffer; ciphertext: Buffer }>;
  wrapKey(keyId: string, plaintext: Buffer): Promise<{ ciphertext: Buffer }>;
  unwrapKey(keyId: string, ciphertext: Buffer): Promise<Buffer>;
  encrypt(keyId: string, plaintext: Buffer): Promise<Buffer>;
  decrypt(keyId: string, ciphertext: Buffer): Promise<Buffer>;

  // Key management
  createKey(options: CreateKeyOptions): Promise<KeyMetadata>;
  describeKey(keyId: string): Promise<KeyMetadata>;
  enableKeyRotation(keyId: string): Promise<void>;
  scheduleKeyDeletion(keyId: string, days: number): Promise<void>;

  // BYOK (optional)
  getWrappingPublicKey?(keyId: string): Promise<Buffer>;
  importKeyMaterial?(keyId: string, material: Buffer): Promise<void>;
}
```

### Provider Implementations

```
+---------------------+------------------+-------------------+------------------+
| Provider            | SDK              | Protection Level  | Production Ready |
+---------------------+------------------+-------------------+------------------+
| LocalKMSProvider    | None (in-process)| Software          | Dev/test only    |
| AWSKMSProvider      | @aws-sdk/kms     | Software + HSM    | Yes              |
| AzureKeyVault       | @azure/keyvault  | Software          | Yes              |
| AzureManagedHSM     | @azure/keyvault  | HSM (FIPS 140-3)  | Yes              |
| GCPCloudKMS         | @google-cloud/kms| Software + HSM    | Yes              |
| ExternalKMS (BYOP)  | REST/JSON        | Customer-managed  | Yes              |
+---------------------+------------------+-------------------+------------------+
```

All providers are **real implementations** with actual SDK calls (not stubs). Cloud SDKs are lazy-loaded via dynamic `import()` to avoid bundling unused dependencies.

### Provider Factory

**File:** `packages/database/src/kms/providers/index.ts`

```typescript
const provider = await createKMSProvider({
  type: 'aws-kms', // or 'azure-keyvault', 'gcp-cloud-kms', 'external', 'local'
  region: 'us-east-1',
  keyId: 'arn:aws:kms:...',
});
await provider.initialize();
```

### Registry (Singleton + Pool)

**File:** `packages/database/src/kms/kms-registry.ts`

```
// Pool-based (preferred — used since 2026-03-08):
setKMSProviderPool(pool)           // Set pool at startup (also sets legacy provider)
getKMSProviderPool()               // Get pool (throws if not set)
isKMSProviderPoolAvailable()       // Safe check

// Legacy singleton (still supported for backward compat):
setPlatformKMSProvider(provider)   // Set at startup
getPlatformKMSProvider()           // Returns pool.getLocalProvider() when pool is set
isPlatformKMSAvailable()           // Safe check

shutdownKMSRegistry()              // Graceful shutdown + zero-fill (pool or singleton)
```

### Provider Pool

**File:** `packages/database/src/kms/kms-provider-pool.ts`

```
KMSProviderPool
  |
  +-- providers: Map<fingerprint, PooledProvider>
  |     +-- "local:default" --> LocalKMSProvider
  |     +-- "aws-kms:us-east-1:arn:..." --> AWSKMSProvider (lazy)
  |     +-- "azure-keyvault:https://vault..." --> AzureKeyVaultProvider (lazy)
  |
  +-- getProvider(resolvedConfig) --> KMSProvider   (cached by fingerprint)
  +-- getLocalProvider() --> LocalKMSProvider       (always available)
  +-- healthCheck(config) --> HealthStatus
  +-- evict(fingerprint) --> void (zero-fill + remove)
  +-- shutdown() --> void (evict all)
```

| Parameter       | Value  | Rationale                                   |
| --------------- | ------ | ------------------------------------------- |
| Max pool size   | 50     | Bound memory; most deployments < 10 configs |
| Idle timeout    | 30 min | Release unused SDK clients                  |
| Eviction policy | LRU    | Evict least-recently-used on pool full      |

### Multi-Tenant KMS Configuration

```
Tenant KMS Config (5-level inheritance)
  |
  +-- projects[projectId].environments[env].provider    (most specific)
  +-- projects[projectId].defaultProvider
  +-- environments[env].provider
  +-- defaultProvider                                    (tenant-wide)
  +-- Platform default (local)                           (least specific)
```

**Models:**

- `TenantKMSConfig` — Source of truth with inheritance chain
- `MaterializedKMSConfig` — Pre-resolved O(1) lookup cache (one per `{tenantId, projectId, environment}`)
- `DEKEntry` — Data Encryption Key registry tracking lifecycle states

### External KMS (BYOP)

The `ExternalKMSProvider` enables customers to bring their own KMS via a REST API:

```
Endpoints:
  POST /generate-data-key
  POST /wrap
  POST /unwrap
  POST /encrypt
  POST /decrypt
  GET  /health
  POST /keys
  POST /keys/{id}/rotation

Auth Methods:
  - api-key (header injection)
  - oauth2 (client_credentials with token caching)
  - hmac-sha256 (signature with timestamp/nonce)
  - mtls (client certificate)

Security:
  - HTTPS required (TLS 1.2+)
  - 10s timeout per request
  - 64KB max response size
  - Fail-closed on all errors
```

### Circuit Breaker

**File:** `apps/runtime/src/services/kms/kms-circuit-breaker.ts`

Wraps KMS provider calls with failure detection. On repeated failures, opens circuit and falls back to configured failure policy:

- `fail-closed` (default) — reject operation
- `graceful-degradation` — fall back to v1 master key encryption

---

## 8. Key Rotation

### Three-Tier Rotation Architecture

```
+---------------------------+     +-------------------------+     +------------------+
| Automatic Rotation Job    |     | Re-encryption Queue     |     | Admin API        |
| (every 60 min)            | --> | (BullMQ worker)         | <-- | (manual trigger)  |
+---------------------------+     +-------------------------+     +------------------+
| Phase 1: Epoch transition |     | Unwrap DEK (old KEK)    |     | POST /kms/keys/  |
|   active --> decrypt_only |     | Re-wrap DEK (new KEK)   |     |   rotate         |
| Phase 2: DEK destruction  |     | Atomic update + verify  |     |                  |
|   decrypt_only --> destroy |     | Batch: 50 DEKs/batch    |     | Force-rotates    |
|   (zero-fill wrappedDek)  |     | Deduplicated per tenant |     | all active DEKs  |
| Phase 3: KEK age check    |     | Progress tracking       |     | for a tenant     |
|   >365 days --> re-encrypt|     |                         |     |                  |
+---------------------------+     +-------------------------+     +------------------+
```

### Rotation Job

**File:** `apps/runtime/src/services/kms/kms-rotation-job.ts`

Runs every `KMS_ROTATION_INTERVAL_MINUTES` (default: 60):

1. **Epoch transitions** — DEKs past their cryptoperiod (`KMS_DEK_EPOCH_INTERVAL_HOURS`, default: 24h) move from `active` to `decrypt_only`
2. **DEK destruction** — DEKs in `decrypt_only` past retention (`KMS_DEK_RETENTION_DAYS`, default: 90) get status `destroyed` and `wrappedDek` is zero-filled
3. **KEK age check** — Tenant configs not updated for `KMS_KEK_ROTATION_PERIOD_DAYS` (default: 365) trigger automatic re-encryption

### Re-encryption Queue

**File:** `apps/runtime/src/services/kms/reencryption-queue.ts`

BullMQ-based worker with deduplication:

```
Job ID format: reencrypt:{tenantId}:{reason}:{YYYY-MM-DD}

Reasons:
  - kek-age-exceeded   (automatic from rotation job)
  - manual-rotation    (admin-triggered via API)
  - key-compromise     (emergency rotation)

Processing:
  1. Load all active/decrypt_only DEKs for tenant
  2. Batch: 50 DEKs at a time
  3. For each DEK:
     unwrapKey(oldKEK, wrappedDek) --> plaintext
     zero-fill plaintext immediately
     wrapKey(newKEK, plaintext) --> new ciphertext
     atomic update with optimistic concurrency (kekKeyVersion check)
  4. Audit log final counts
```

### Admin API

**File:** `apps/runtime/src/routes/kms-admin.ts`

| Method | Endpoint                            | Purpose                                      |
| ------ | ----------------------------------- | -------------------------------------------- |
| GET    | `/api/tenants/:tid/kms/config`      | Get KMS configuration                        |
| PUT    | `/api/tenants/:tid/kms/config`      | Update KMS config (triggers materialization) |
| POST   | `/api/tenants/:tid/kms/validate`    | Validate external KMS endpoint               |
| GET    | `/api/tenants/:tid/kms/keys`        | List DEKs by status                          |
| POST   | `/api/tenants/:tid/kms/keys/rotate` | Force rotate all active DEKs                 |
| GET    | `/api/tenants/:tid/kms/audit`       | Query KMS audit log (ClickHouse)             |
| GET    | `/api/tenants/:tid/kms/health`      | Health check (provider + DEK counts)         |

Auth: `requirePermission('kms:admin')` + `requireFeature('kms_byok')`

### Rotation per Encryption Version

| Version            | What Rotates                   | How                              | Automatic? |
| ------------------ | ------------------------------ | -------------------------------- | ---------- |
| v1 (master key)    | Nothing                        | Requires data migration to v2/v3 | No         |
| v2 (KMS-wrapped)   | DEK re-wrapped with new KEK    | Re-encryption queue              | Yes        |
| v3 (tenant-scoped) | Derived key follows master key | EncryptionService key derivation | Yes        |

---

## 9. Transport Security

| Connection           | TLS Support                 | Current State                 |
| -------------------- | --------------------------- | ----------------------------- |
| App --> MongoDB      | Yes (via connection string) | Configurable                  |
| App --> Redis        | Yes (`config.redis.tls`)    | Optional, no cert validation  |
| App --> ClickHouse   | Yes (HTTPS)                 | Not enforced in client config |
| App --> Cloud KMS    | Yes (SDK default)           | Always on                     |
| App --> External KMS | Yes (required)              | HTTPS enforced                |

---

## 10. Server Startup Wiring

**File:** `apps/runtime/src/server.ts`

```
1. initMongoBackend()
     |
2. setMasterKey(ENCRYPTION_MASTER_KEY)          --> v1 ready (MongoDB plugin)
     |                                              validates /^[0-9a-f]{64}$/i
3. pool = new KMSProviderPool({ masterKeyHex })
   await pool.initialize()
   setKMSProviderPool(pool)                      --> KMS pool ready
     |                                              (also sets legacy getPlatformKMSProvider)
4. resolver = new KMSResolver()
   globalThis.__kmsResolver = resolver           --> Per-tenant config resolution ready
     |
5. setKMSResolverFn(async (tenantId) => {       --> v2 per-tenant wired into plugin
     const config = await resolver.resolve(tenantId);
     const provider = await pool.getProvider(config.provider);
     return { provider, keyId: config.provider.keyId };
   })
     |
6. enc = getEncryptionService()
   setTenantEncryption({
     encryptForTenant:  enc.encryptForTenant,
     decryptForTenant:  enc.decryptForTenant,
   })                                             --> v3 ready (MongoDB plugin)
     |
7. initializeRedis()                              --> Redis client
     |                                              resolver subscribes to cache invalidation
8. getClickHouseClient()                          --> ClickHouse client
   setKMSAuditClickHouseAvailable(true)           --> Audit logging to ClickHouse active
     |
9. startKMSRotationJob({
     intervalMinutes, dekRetentionDays,
     kekRotationPeriodDays, enableReencryption,
   })                                             --> 3-phase auto-rotation started
```

Verified startup chain in logs (grep-confirmed):
`master key set` -> `Provider Pool initialized` -> `resolver wired` -> `invalidation subscriber` -> `v3 tenant encryption wired` -> `ClickHouse initialized` -> `KMS rotation job started`

---

## 11. Environment Variables

### Platform Secrets (env vars)

| Variable                | Example                          | Purpose                               |
| ----------------------- | -------------------------------- | ------------------------------------- |
| `ENCRYPTION_MASTER_KEY` | `507f048e...0d66` (64 hex chars) | Master key used by `LocalKMSProvider` |

> **No other KMS env vars exist.** KMS provider type, credentials, key IDs, and rotation
> settings are all stored **per-tenant** in the database (`TenantKMSConfig` /
> `MaterializedKMSConfig`). The platform env only provides the local master key — tenants
> that choose `local` as their KMS provider use this key; tenants that choose AWS/Azure/GCP
> use their own credentials stored in their tenant config.

### Per-Tenant KMS Configuration (database)

Each tenant's KMS settings are stored in `TenantKMSConfig` with a 5-level inheritance chain:

```
Platform Default → Tenant → Project → Environment → Model Override
```

The resolved config is materialized into `MaterializedKMSConfig` for O(1) lookups at runtime.

| Field                                  | Example                                               | Purpose                                       |
| -------------------------------------- | ----------------------------------------------------- | --------------------------------------------- |
| `providerType`                         | `aws-kms`, `azure-keyvault`, `gcp-cloud-kms`, `local` | Which KMS provider to use                     |
| `region`                               | `us-east-1`                                           | Cloud region (AWS/GCP)                        |
| `keyId`                                | `arn:aws:kms:...`                                     | KMS key ARN/ID                                |
| `vaultUrl`                             | `https://{name}.vault.azure.net`                      | Azure Key Vault/HSM URL                       |
| `credentials`                          | _(encrypted in DB)_                                   | Provider-specific auth credentials            |
| `rotationPolicy.dekEpochIntervalHours` | `24`                                                  | DEK cryptoperiod before `decrypt_only`        |
| `rotationPolicy.dekRetentionDays`      | `90`                                                  | Days before `decrypt_only` DEKs are destroyed |
| `rotationPolicy.kekRotationPeriodDays` | `365`                                                 | KEK age trigger for auto re-encryption        |
| `rotationPolicy.dekMaxUsageCount`      | `2^30`                                                | Max encryptions per DEK                       |
| `reencryption.enabled`                 | `true`                                                | Enable re-encryption queue for this tenant    |
| `reencryption.concurrency`             | `1`                                                   | Parallel re-encryption workers                |
| `reencryption.batchSize`               | `50`                                                  | DEKs per batch                                |
| `reencryption.maxRetries`              | `3`                                                   | Retry count per batch                         |

### Platform Operational Settings (env vars)

These are infrastructure-level settings that apply to the platform process itself, not per-tenant:

| Variable                        | Default | Purpose                                                       |
| ------------------------------- | ------- | ------------------------------------------------------------- |
| `KMS_ROTATION_INTERVAL_MINUTES` | 60      | How often the rotation job polls for tenants needing rotation |

### Removed Env Vars (2026-03-08)

The following env vars were removed as dead code. All KMS config is now per-tenant in the database:

- ~~`KMS_PROVIDER`~~ — replaced by `TenantKMSConfig.defaultProvider.providerType`
- ~~`KMS_REGION`~~ — replaced by `TenantKMSConfig.defaultProvider.region`
- ~~`KMS_KEY_ID`~~ — replaced by `TenantKMSConfig.defaultProvider.keyId`
- ~~`KMS_VAULT_URL`~~ — replaced by `TenantKMSConfig.defaultProvider.vaultUrl`
- ~~`KMS_DEK_RETENTION_DAYS`~~ — replaced by `TenantKMSConfig.dekRetentionDays`
- ~~`KMS_DEK_EPOCH_INTERVAL_HOURS`~~ — replaced by `TenantKMSConfig.dekEpochIntervalHours`
- ~~`KMS_KEK_ROTATION_PERIOD_DAYS`~~ — replaced by `TenantKMSConfig.kekRotationPeriodDays`

---

## 12. Compliance & GDPR

### Crypto-Shredding

Contact-scoped encryption enables GDPR "right to erasure" without scanning all records:

```
encryptContactPII(plaintext, contactId)
  --> HKDF(master, "contact:{contactId}") --> contact DEK
  --> AES-256-GCM encrypt

To "erase" a contact:
  --> Delete the contact key derivation input
  --> All encrypted PII becomes irrecoverable
```

### Audit Trail

**File:** `apps/runtime/src/services/kms/kms-audit-logger.ts`

All KMS operations logged to ClickHouse:

| Operation            | Trigger                        |
| -------------------- | ------------------------------ |
| `config_update`      | PUT /kms/config                |
| `force_rotate`       | POST /kms/keys/rotate          |
| `epoch_transition`   | Rotation job phase 1           |
| `dek_destruction`    | Rotation job phase 2           |
| `batch_reencryption` | Re-encryption queue completion |

Each log includes: actor, tenantId, operation, success/failure, latency, metadata.

### Key Material Safety

- Master key loaded from env, never logged or serialized
- Plaintext DEK never stored in database — only KMS-wrapped form
- DEK cache uses LRU with TTL + zero-fill on eviction
- Re-encryption zero-fills plaintext immediately after re-wrap
- `shutdownKMSRegistry()` zero-fills all in-memory key material

---

## 13. Known Gaps, Limitations & Roadmap

> Last updated: 2026-03-08 after full E2E verification

### Current Limitations (Architectural)

| #   | Limitation                                     | Impact                                                                                                                                                                       | Mitigation                                                                                     |
| --- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| L1  | **Cloud KMS providers untested in production** | AWS, Azure, GCP, External providers are fully implemented with real SDK calls but have only been tested via unit tests against mocks — no live cloud integration test exists | Add integration test suite with cloud KMS sandbox accounts; local provider is production-ready |
| L2  | **Re-encryption queue requires Redis**         | BullMQ-based re-encryption worker only operates when Redis is available; without Redis, `POST /keys/rotate` rotates DEK status but skips re-wrapping                         | Document Redis as required for KEK rotation; manual re-encryption script as fallback           |
| L3  | **Single master key, no versioning**           | v1/v2/v3 tracks encryption format but not which master key version was used; rotating the `ENCRYPTION_MASTER_KEY` env var requires all pods to restart simultaneously        | Add `masterKeyVersion` field for zero-downtime master key rotation                             |
| L4  | **Cross-tenant path param not validated**      | Auth middleware validates JWT but does not check `req.params.tenantId` matches token's `tenantId` — pre-existing platform issue, not KMS-specific                            | Needs tenant path middleware at platform level                                                 |
| L5  | **Decrypt failure is silent**                  | When all decrypt paths fail, the plugin logs a warning and leaves the field encrypted rather than throwing — prevents breaking reads for corrupt docs but may mask issues    | Consider configurable `failOnDecryptError` option per model                                    |
| L6  | **`ire` field not schema-immutable**           | Setting `immutable: true` on `ire` would break re-encryption flows that upgrade v1->v3; currently protected by pre-save logic only                                           | Acceptable — raw MongoDB access is already privileged                                          |

### High Priority Gaps

| #   | Gap                                         | Impact                                                           | Recommendation                                                                   |
| --- | ------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | **ClickHouse FactStore not encrypted**      | Facts may contain sensitive user data stored in plaintext        | Wire `encryptionService` into `ClickHouseFactStore` like MessageStore/TraceStore |
| 2   | **Redis verification tokens not encrypted** | Short-lived but sensitive tokens stored in plaintext             | Encrypt via `encryptForTenant()` before Redis SET                                |
| 3   | **No cloud KMS live integration tests**     | Cannot verify AWS/Azure/GCP providers work against real services | Create test harness with sandbox KMS accounts and CI job                         |

### Medium Priority Gaps

| #   | Gap                                       | Impact                                                                                                         | Recommendation                                           |
| --- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 4   | **ClickHouse client: no TLS config**      | Data in transit between app and ClickHouse unencrypted on non-localhost                                        | Add TLS options to `packages/database/src/clickhouse.ts` |
| 5   | **Redis TLS: no cert validation options** | `tls` flag exists but no `ca`, `cert`, `key`, `rejectUnauthorized`                                             | Extend `redis.schema.ts` with full TLS options           |
| 6   | **v1 has no rotation path**               | Documents encrypted with v1 (master key CEK) cannot be auto-rotated                                            | Build migration utility to re-encrypt v1 docs as v3      |
| 7   | **Blind indexing not wired**              | `blindIndex()` exists in EncryptionService but unused in queries                                               | Wire into credential/secret search operations            |
| 8   | **KMS audit actor_id always "unknown"**   | PUT /config and POST /rotate log `actorId: 'unknown'` because `req.userId` is not populated by auth middleware | Wire `req.user.sub` from JWT into audit events           |

### Low Priority Gaps

| #   | Gap                                           | Impact                                                                                             | Recommendation                                                         |
| --- | --------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 9   | **No master key version tracking**            | See L3 above                                                                                       | Add `masterKeyVersion` for zero-downtime master key rotation           |
| 10  | **No field-level access control**             | Encryption is transparent — no per-role field visibility                                           | Consider RBAC overlay for decrypted field access                       |
| 11  | **Double-encryption detection regex fragile** | `isHex3Part()` matches any 3-part hex string, not specifically encrypted values                    | Low risk — false positives caught by decrypt try/catch                 |
| 12  | **ClickHouse DateTime64 format sensitivity**  | ClickHouse `DateTime64(3)` rejects ISO 8601 `Z` suffix — requires `YYYY-MM-DD HH:MM:SS.sss` format | Fixed in `kms-audit-logger.ts`; document for future ClickHouse writers |

### What Works (Verified 2026-03-08)

| Component                  | Status  | Evidence                                                                                 |
| -------------------------- | ------- | ---------------------------------------------------------------------------------------- |
| KMS Provider Pool          | Working | 6 provider types, fingerprint-based LRU, lazy instantiation                              |
| Per-tenant KMS resolution  | Working | `KMSResolver` with 5-level inheritance, L1 cache, materialized configs                   |
| Encryption plugin v1/v2/v3 | Working | Round-trip: plaintext -> MongoDB ciphertext -> Mongoose decrypts                         |
| Bulk operation blocking    | Working | `insertMany`/`updateMany` with plaintext encrypted fields throws                         |
| Serialization safety       | Working | `toJSON`/`toObject` strip `ire`, `cek`, `iv`, `kmsKeyId`                                 |
| Atomic encryption          | Working | Pre-encrypt to Map, apply all at once                                                    |
| v3 downgrade prevention    | Working | Pre-save throws if doc has `ire='v3'` and tenant encryption unavailable                  |
| DEK lifecycle              | Working | active -> decrypt_only (epoch expiry) -> destroyed (retention expiry, wrappedDek zeroed) |
| 3-phase rotation job       | Working | Epoch transition, per-tenant retention destruction, KEK age check                        |
| ClickHouse audit logging   | Working | `config_update`, `force_rotate` events written and queryable via GET /audit              |
| Admin API (7 endpoints)    | Working | config, keys, rotate, validate, audit, health — all tested                               |
| Feature gate               | Working | `requireFeature('kms_byok')` checks Deal features + ENTERPRISE plan tier                 |
| Cache invalidation         | Working | `resolver.evictTenant()` local + `publishInvalidation()` via Redis Pub/Sub               |
| findOne+save re-encryption | Working | Updating encrypted field re-encrypts at rest, decrypts correctly on read                 |

---

## 14. Key Files Reference

### Core Encryption

| File                                       | Purpose                                             |
| ------------------------------------------ | --------------------------------------------------- |
| `packages/shared/src/encryption/engine.ts` | EncryptionService — all crypto primitives           |
| `packages/shared/src/encryption/index.ts`  | Public exports + `getEncryptionService()` singleton |

### MongoDB

| File                                                       | Purpose                               |
| ---------------------------------------------------------- | ------------------------------------- |
| `packages/database/src/mongo/plugins/encryption.plugin.ts` | Mongoose encryption plugin (v1/v2/v3) |

### ClickHouse

| File                                                           | Purpose                               |
| -------------------------------------------------------------- | ------------------------------------- |
| `packages/database/src/clickhouse.ts`                          | ClickHouse client                     |
| `apps/runtime/src/services/stores/clickhouse-message-store.ts` | Encrypted message store               |
| `apps/runtime/src/services/stores/clickhouse-trace-store.ts`   | Encrypted trace store                 |
| `apps/runtime/src/services/stores/clickhouse-store-factory.ts` | Factory wiring encryption into stores |

### Redis

| File                                                     | Purpose                    |
| -------------------------------------------------------- | -------------------------- |
| `apps/runtime/src/services/redis/redis-client.ts`        | Redis client               |
| `apps/runtime/src/services/message-persistence-queue.ts` | Encrypted message queueing |

### KMS

| File                                                                | Purpose                                    |
| ------------------------------------------------------------------- | ------------------------------------------ |
| `packages/database/src/kms/types.ts`                                | KMSProvider interface                      |
| `packages/database/src/kms/kms-provider-pool.ts`                    | Provider pool (fingerprint LRU, lazy init) |
| `packages/database/src/kms/kms-registry.ts`                         | Global singleton + pool registry           |
| `packages/database/src/kms/local-kms-provider.ts`                   | Local (dev) KMS                            |
| `packages/database/src/kms/providers/aws-kms-provider.ts`           | AWS KMS                                    |
| `packages/database/src/kms/providers/azure-keyvault-provider.ts`    | Azure Key Vault                            |
| `packages/database/src/kms/providers/azure-managed-hsm-provider.ts` | Azure Managed HSM                          |
| `packages/database/src/kms/providers/gcp-cloud-kms-provider.ts`     | GCP Cloud KMS                              |
| `packages/database/src/kms/providers/external-kms-provider.ts`      | External BYOP KMS                          |
| `packages/database/src/kms/providers/index.ts`                      | Provider factory                           |

### Key Rotation

| File                                                   | Purpose                            |
| ------------------------------------------------------ | ---------------------------------- |
| `apps/runtime/src/services/kms/kms-rotation-job.ts`    | Automatic rotation (3-phase)       |
| `apps/runtime/src/services/kms/reencryption-queue.ts`  | BullMQ re-encryption worker        |
| `apps/runtime/src/routes/kms-admin.ts`                 | Admin API (7 endpoints)            |
| `apps/runtime/src/services/kms/kms-audit-logger.ts`    | Audit logging to ClickHouse        |
| `apps/runtime/src/services/kms/kms-circuit-breaker.ts` | KMS failure detection              |
| `apps/runtime/src/services/kms/kms-resolver.ts`        | Multi-tenant config resolution     |
| `apps/runtime/src/services/kms/kms-materializer.ts`    | Config inheritance materialization |

### Models

| File                                                            | Purpose                                 |
| --------------------------------------------------------------- | --------------------------------------- |
| `packages/database/src/models/tenant-kms-config.model.ts`       | Tenant KMS config (5-level inheritance) |
| `packages/database/src/models/materialized-kms-config.model.ts` | Pre-resolved config cache               |
| `packages/database/src/models/dek-registry.model.ts`            | DEK lifecycle tracking                  |

### Tests

| File                                                                  | Purpose                                      |
| --------------------------------------------------------------------- | -------------------------------------------- |
| `packages/database/src/__tests__/encryption-plugin-kms.test.ts`       | Plugin v1/v2 round-trips                     |
| `packages/database/src/__tests__/local-kms-provider.test.ts`          | LocalKMS operations                          |
| `packages/database/src/__tests__/kms-providers.test.ts`               | Provider factory                             |
| `packages/database/src/__tests__/kms-provider-pool-edge.test.ts`      | Pool LRU eviction, fingerprint, shutdown     |
| `apps/runtime/src/__tests__/clickhouse-enterprise.test.ts`            | ClickHouse encryption + tenant isolation     |
| `apps/runtime/src/__tests__/clickhouse-stores.test.ts`                | Store encrypt/decrypt round-trips            |
| `apps/runtime/src/__tests__/kms-admin-authz.test.ts`                  | Admin API authorization                      |
| `apps/runtime/src/services/kms/__tests__/dek-manager.test.ts`         | DEK acquire/unwrap/batch/cache               |
| `apps/runtime/src/services/kms/__tests__/dek-cache.test.ts`           | DEK cache LRU + zero-fill                    |
| `apps/runtime/src/services/kms/__tests__/kms-resolver.test.ts`        | 5-level inheritance resolution               |
| `apps/runtime/src/services/kms/__tests__/kms-materializer.test.ts`    | Config materialization                       |
| `apps/runtime/src/services/kms/__tests__/kms-rotation-job.test.ts`    | 3-phase rotation (epoch, destroy, KEK check) |
| `apps/runtime/src/services/kms/__tests__/kms-circuit-breaker.test.ts` | Circuit breaker open/close/half-open         |
| `apps/runtime/src/services/kms/__tests__/kms-audit-logger.test.ts`    | Audit event formatting                       |
| `apps/runtime/src/services/kms/__tests__/reencryption-queue.test.ts`  | BullMQ re-encryption worker                  |

### Live Test Scripts

| File                                  | Purpose                                                               |
| ------------------------------------- | --------------------------------------------------------------------- |
| `scripts/kms-live-test.sh`            | Full KMS API + security + log verification (14 tests)                 |
| `scripts/kms-encryption-roundtrip.ts` | Mongoose encryption E2E: create, raw check, decrypt, update (9 tests) |

### Schema Reference

| File                        | Purpose                                       |
| --------------------------- | --------------------------------------------- |
| `docs/db/mongo-security.md` | MongoDB collection schemas for encrypted data |
