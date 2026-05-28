# High-Level Design: Encryption at Rest

**Feature**: [Encryption at Rest](../features/encryption-at-rest.md)
**Status**: Current (reflects implemented state)
**Date**: 2026-03-22

---

## 1. Problem Statement

Agent platforms store sensitive data across three storage layers (MongoDB, Redis, ClickHouse) including LLM API keys, OAuth tokens, conversation history, contact PII, and configuration secrets. Without application-layer encryption, a compromised database backup, unauthorized DB access, or cloud provider breach exposes all tenant data in cleartext. Compliance frameworks (SOC2, GDPR, HIPAA, PCI-DSS) require encryption at rest with key management, rotation, and audit capabilities.

The platform needs transparent, tenant-isolated encryption that:

- Requires zero code changes in route handlers (encrypt-on-write, decrypt-on-read)
- Supports multiple storage backends (MongoDB documents, Redis queue payloads, ClickHouse rows)
- Enables key hierarchy with tenant isolation (one tenant's compromise does not affect others)
- Supports KMS integration for enterprise customers
- Enables GDPR compliance via crypto-shredding (delete key to render data irrecoverable)

---

## 2. Alternatives Considered

### Alternative A: MongoDB Native CSFLE (Client-Side Field Level Encryption)

**Description**: Use MongoDB's built-in CSFLE with automatic encryption via mongocryptd or crypt_shared.

**Pros**:

- Native to MongoDB, no custom encryption code needed
- Supports queryable encryption (range queries on encrypted fields)
- Validated by MongoDB security team

**Cons**:

- Only works for MongoDB — does not cover Redis or ClickHouse
- Requires mongocryptd sidecar process or crypt_shared library
- Limited to specific MongoDB versions and drivers
- Cannot do compress-then-encrypt for ClickHouse
- No control over key derivation strategy

**Effort**: M

### Alternative B: Application-Layer Encryption Service (Chosen)

**Description**: Shared `EncryptionService` with Mongoose plugin, ClickHouse interceptors, and Redis queue wrappers providing consistent encryption across all stores.

**Pros**:

- Covers all three storage backends with one key hierarchy
- Transparent via Mongoose plugin hooks (zero changes in route handlers)
- Full control over key derivation, compression, and wire format
- Supports multiple encryption versions for backward compatibility
- Enables GDPR crypto-shredding via per-contact key chains

**Cons**:

- Custom crypto code requires careful implementation and review
- Performance overhead for PBKDF2 key derivation (mitigated by caching)
- Three wire formats coexist (hex 3-part, base64 4-part, binary concat)
- Must manually register new models/fields for encryption

**Effort**: L

### Alternative C: Transparent Data Encryption (TDE) at Storage Layer

**Description**: Enable TDE in MongoDB Atlas, Redis Enterprise, and ClickHouse Cloud for storage-level encryption.

**Pros**:

- Zero application code changes
- Handled by cloud providers
- Performance impact minimal (SSD-level encryption)

**Cons**:

- Does not protect against authorized DB access (DBA can read plaintext)
- No tenant isolation — all tenants share the same encryption key
- No GDPR crypto-shredding capability
- Vendor-dependent; not available in self-hosted deployments
- Does not satisfy application-layer encryption requirements in some compliance frameworks

**Effort**: S

### Recommendation

**Alternative B (Application-Layer Encryption Service)** was chosen because:

1. It covers all three storage backends with a unified key hierarchy
2. It provides tenant-isolated key derivation (each tenant gets a unique DEK)
3. It enables GDPR crypto-shredding without deleting records
4. It works identically in cloud and self-hosted deployments
5. The Mongoose plugin makes it transparent for MongoDB models

Trade-offs acknowledged: custom crypto code requires more maintenance, and three wire formats increase complexity. Both are mitigated by comprehensive unit tests and the encryption manifest as a single source of truth.

---

## 3. Architecture

### System Context Diagram

```
                                    +------------------+
                                    |  ENCRYPTION_     |
                                    |  MASTER_KEY      |
                                    |  (env/vault)     |
                                    +--------+---------+
                                             |
                                    +--------v---------+
                                    | EncryptionService |
                                    | (singleton)       |
                                    +----+----+----+---+
                                         |    |    |
                        +----------------+    |    +----------------+
                        |                     |                     |
               +--------v--------+   +--------v--------+  +--------v--------+
               | Mongoose Plugin |   | Field Interceptor|  | Secure Queue    |
               | (pre-save/      |   | (encryptFields/  |  | (wrapJobData/   |
               |  post-find)     |   |  decryptFields)  |  |  unwrapJobData) |
               +--------+--------+   +--------+---------+  +--------+--------+
                        |                     |                      |
               +--------v--------+   +--------v---------+  +--------v--------+
               |    MongoDB      |   |    ClickHouse    |  |     Redis       |
               |  (16 models,    |   |  (5 tables,      |  |  (2 queues,     |
               |   28+ fields)   |   |   7 fields)      |  |   2 fields)     |
               +-----------------+   +------------------+  +-----------------+
```

### Component Diagram

```
packages/shared/src/encryption/
  ├── engine.ts                 ── EncryptionService (core AES-256-GCM)
  │   ├── encrypt/decrypt           (user-scoped, PBKDF2)
  │   ├── encryptForTenant/decryptForTenant  (tenant-scoped)
  │   ├── compressAndEncryptForTenant  (Zstd + AES-GCM)
  │   ├── deriveContactKey/encryptContactPII  (GDPR crypto-shredding)
  │   └── blindIndex                (HMAC-SHA-256 for searchable encrypted fields)
  │
  ├── key-derivation/
  │   ├── pbkdf2.ts             ── PBKDF2 (100K iterations, legacy + default)
  │   └── hkdf.ts               ── HKDF (non-iterated, new paths)
  │
  ├── cache/
  │   └── tenant-key-cache.ts   ── LRU cache (max 1000, 30min TTL, zero-fill)
  │
  ├── field-interceptor.ts      ── encryptFields/decryptFields (ClickHouse/Redis)
  ├── secure-queue.ts           ── BullMQ job data wrappers
  ├── encryption-manifest.ts    ── CLICKHOUSE + REDIS_QUEUE manifests
  ├── master-key-resolver.ts    ── Vault > env var resolution
  ├── errors.ts                 ── Error constructors
  └── index.ts                  ── Barrel exports + singleton factory

packages/database/
  ├── src/mongo/plugins/encryption.plugin.ts  ── Mongoose v1/v2/v3 plugin
  └── src/kms/
      ├── types.ts              ── KMSProvider interface (NIST SP 800-57)
      ├── kms-registry.ts       ── Singleton + pool registry
      ├── kms-provider-pool.ts  ── Multi-provider pool (LRU, health checks)
      ├── local-kms-provider.ts ── Dev/test local provider
      └── providers/            ── AWS, Azure KV, Azure HSM, GCP, External
```

### Data Flow: Mongoose Plugin (v3 — Tenant-Scoped)

```
1. Application calls Model.create({ tenantId, encryptedApiKey: "sk-..." })
2. Mongoose pre('save') hook fires:
   a. Check if tenant encryption is available (isTenantEncryptionAvailable)
   b. Get tenantId from document
   c. For each field in fieldsToEncrypt:
      - Serialize to string (JSON.stringify for non-strings)
      - Call enc.encryptForTenant(plaintext, tenantId)
        → EncryptionService.deriveTenantKey(tenantId)
          → TenantKeyCache.get(tenantId) OR
          → PBKDF2(masterKey, "tenant:<tenantId>") + cache
        → AES-256-GCM encrypt with random IV
        → Return "iv_hex:authTag_hex:ciphertext_hex"
      - Set field to ciphertext
   d. Set ire='v3', clear cek/iv/kmsKeyId
3. Document saved to MongoDB with ciphertext

4. Application calls Model.findOne({ _id, tenantId })
5. Mongoose post('findOne') hook fires:
   a. Detect version from ire field ('v3')
   b. Get tenantId, get tenant encryption functions
   c. For each field in fieldsToEncrypt:
      - Call enc.decryptForTenant(ciphertext, tenantId)
      - Replace field with plaintext
   d. On failure: set field=null, _decryptionFailed=true
6. Application receives document with plaintext fields
```

### Data Flow: ClickHouse Field Interceptor

```
1. Analytics service prepares row: { tenantId, content: "user message..." }
2. encryptFields(row, ["content"], tenantId, encryptionService):
   a. Check row._enc is not set (no double-encrypt)
   b. Check field doesn't start with ENC:v3:
   c. Call encryptionService.encryptForTenant(content, tenantId)
   d. Prefix with "ENC:v3:" → "ENC:v3:iv:authTag:ciphertext"
   e. Set row._enc = 'v3'
3. Row inserted into ClickHouse

4. Analytics service reads row
5. decryptFields(row, ["content"], tenantId, encryptionService):
   a. Check row._enc is set
   b. Strip "ENC:v3:" prefix
   c. Call encryptionService.decryptForTenant(ciphertext, tenantId)
   d. Replace field with plaintext, delete row._enc
```

### Data Flow: Compress-Then-Encrypt (ClickHouse Large Payloads)

```
1. compressAndEncryptForTenant(largejson, tenantId):
   a. Convert to Buffer
   b. If >= 64 bytes AND zstdCompressSync available:
      - Zstd compress → prefix = "Z1"
   c. Else: no compression → prefix = "N0"
   d. Derive tenant key, create AES-256-GCM cipher
   e. Encrypt compressed/raw buffer
   f. Return "Z1:iv_b64:authTag_b64:ciphertext_b64"

2. decryptAndDecompressForTenant(encrypted, tenantId):
   a. Split into 4 parts: [prefix, iv, authTag, ciphertext]
   b. Derive tenant key, create decipher
   c. Decrypt to buffer
   d. If prefix == "Z1": zstdDecompressSync(buffer)
   e. Return plaintext string
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

#### 1. Tenant Isolation

Every encryption operation derives a unique key per tenantId:

- **Tenant-scoped**: `PBKDF2(masterKey, "tenant:<tenantId>")` produces a 32-byte AES-256 key unique to each tenant
- **Contact-scoped**: `HKDF(masterKey, "tenant:<tenantId>") → HKDF(tenantKey, contactSalt)` chains tenant isolation to per-contact keys
- **Blind index**: `HKDF(masterKey, "blind:<tenantId>")` produces tenant-specific HMAC keys

Cross-tenant decryption is cryptographically impossible without the master key. A compromised tenant key does not affect other tenants.

KMS configuration supports per-tenant overrides via `TenantKMSConfig` model with 5-level inheritance chain.

#### 2. Data Access Pattern

- **MongoDB**: Mongoose plugin hooks (pre-save, post-find, post-findOneAndUpdate, post-findOneAndDelete) provide transparent encryption. No repository layer changes needed.
- **ClickHouse**: `encryptFields`/`decryptFields` interceptors called by analytics services.
- **Redis**: `wrapJobDataForEncrypt`/`unwrapJobDataForDecrypt` called by BullMQ queue producers/consumers.
- **Caching**: Derived tenant keys cached in `TenantKeyCache` (LRU, max 1000, 30min TTL). KMS provider instances cached in `KMSProviderPool` (LRU, max 50, 5min health check).

#### 3. API Contract

No direct encryption API — encryption is transparent. Key contracts:

- **Encryption plugin options**: `{ fieldsToEncrypt: string[], tenantIdField?: string, skipTenantScoping?: boolean }`
- **Encryption manifest**: `{ fieldsToEncrypt: readonly string[] }` per ClickHouse table and Redis queue
- **Wire formats**:
  - Mongoose v3: `"iv_hex:authTag_hex:ciphertext_hex"` (hex 3-part)
  - ClickHouse compressed: `"Z1|N0:iv_b64:authTag_b64:ciphertext_b64"` (base64 4-part)
  - Contact PII: `base64(iv + authTag + encrypted)` (binary concat)
  - Field interceptor: `"ENC:v3:" + tenant-encrypted value` (prefixed)

#### 4. Security Surface

- **Master key**: 32-byte hex string (64 chars), resolved from vault first, env var fallback with production warning
- **Key derivation**: PBKDF2 (100K iterations) or HKDF (SHA-256)
- **Algorithm**: AES-256-GCM with 12-byte random IV (NIST SP 800-38D), 16-byte auth tag
- **Double-encryption detection**: Hard error at all entry points
- **Ciphertext leak prevention**: Null sentinel on decrypt failure, metadata stripped from toJSON/toObject
- **Secure key disposal**: `Buffer.fill(0)` on all cache evictions, provider shutdowns, and key destructions
- **Bulk operation safety**: `updateMany`/`insertMany` with encrypted fields blocked to prevent plaintext bypass

### Behavioral Concerns

#### 5. Error Model

| Error                        | Cause                                           | Behavior                                |
| ---------------------------- | ----------------------------------------------- | --------------------------------------- |
| `masterKeyMissing()`         | ENCRYPTION_MASTER_KEY not set or too short      | Service fails to start (fail-closed)    |
| `invalidFormat()`            | Encrypted data does not match expected format   | Null sentinel returned                  |
| `contactSaltMissing()`       | Contact's encryptionSalt is null (GDPR-deleted) | Hard error thrown                       |
| `decompressionUnavailable()` | Zstd not available (Node.js < 22)               | Hard error for Z1-prefixed data         |
| Decrypt failure              | Wrong key, corrupted ciphertext                 | Null sentinel, `_decryptionFailed` flag |
| Double-encryption            | Already-encrypted data passed to encrypt        | Hard error thrown                       |
| Version downgrade            | v3 document, tenant encryption unavailable      | Hard error ("Refusing to downgrade")    |

#### 6. Failure Modes

- **Missing master key**: Fail-closed at startup — no encryption operations possible
- **KMS unavailable**: Falls back through resolution chain (per-tenant resolver → global KMS → local master key)
- **Key rotation**: `decryptWithFallback` tries current key, then iterates `previousKeys` in order
- **Corrupt ciphertext**: Null sentinel returned, field-level logging, `_decryptionFailed` flag
- **DB backup with old key**: Previous keys in `ENCRYPTION_PREVIOUS_MASTER_KEYS` enable decryption
- **Network partition to KMS**: v2 CEK unwrap fails, falls back to v3 route decryption if available, else null sentinel

#### 7. Idempotency

- Encrypt is NOT idempotent (random IV → different ciphertext each time) — by design for semantic security
- Decrypt is idempotent (same input → same output)
- Mongoose plugin tracks `isModified` and `decryptedValues` to avoid unnecessary re-encryption on save
- Double-encryption detection prevents the most common idempotency violation

#### 8. Observability

- `[encryption-plugin]` log prefix for all Mongoose plugin warnings
- Per-field and per-document logging on decrypt failure: docId, field, collection, error message, value prefix
- `_decryptionFailed` flag enables downstream monitoring
- KMS provider pool logs: evictions, health check failures, creation errors
- Master key resolver logs: vault resolution, env var fallback, production warnings
- GAP: No structured metrics (encrypt/decrypt latency, cache hit rate, failure rate)

### Operational Concerns

#### 9. Performance Budget

| Operation                   | Latency Target | Actual     | Notes                                    |
| --------------------------- | -------------- | ---------- | ---------------------------------------- |
| PBKDF2 key derivation       | <50ms          | ~10-50ms   | Only on cache miss (~1/30min per tenant) |
| HKDF key derivation         | <1ms           | ~0.01ms    | Used for contacts, blind indexes         |
| AES-256-GCM encrypt/decrypt | <1ms           | ~0.1-0.5ms | Hardware-accelerated on modern CPUs      |
| Tenant key cache lookup     | <0.1ms         | ~0.01ms    | In-memory Map.get                        |
| Zstd compression (64B+)     | <5ms           | ~1-3ms     | Saves 40-60% storage                     |
| KMS provider pool lookup    | <0.1ms         | ~0.01ms    | Fingerprint-based Map.get                |

#### 10. Migration Path

- **v1 → v3**: Mongoose plugin reads v1, writes v3 on next save. No migration needed — lazy upgrade.
- **v2 → v3**: Same as v1 → v3. KMS CEK unwrapping still works for reads.
- **Master key rotation**: Add previous key to `EncryptionServiceConfig.previous`, deploy, then optionally run re-encryption.
- **No automatic re-encryption migration** exists (GAP-002). Data upgraded lazily on next write or manually via re-encryption queue (planned).

#### 11. Rollback Plan

- **Encryption disable**: Set `ENCRYPTION_ENABLED=false` — `isEncryptionAvailable` returns false, new writes are plaintext. Existing encrypted data still decryptable when re-enabled.
- **Key rollback**: If new key is bad, revert `ENCRYPTION_MASTER_KEY` to previous value. Data encrypted with new key during the window is lost unless the new key is preserved in `previous`.
- **Version rollback**: Rolling back code preserves the Mongoose plugin's multi-version reader. v3 data is still read correctly by v1/v2 code paths if the tenant encryption functions are available.

#### 12. Feature Flags / Rollout

- `ENCRYPTION_ENABLED`: Boolean toggle (default: true). When false, `isEncryptionAvailable()` returns false and encryption is bypassed.
- `ENCRYPTION_MASTER_KEY`: Required for encryption to work. Absence means encryption is effectively disabled with fail-closed behavior.
- KMS configuration is per-tenant — can be rolled out tenant by tenant via `TenantKMSConfig`.
- No gradual rollout needed — encryption has been enabled since initial deployment.

---

## 5. Data Model

See [Feature Spec Section 9](../features/encryption-at-rest.md#9-data-model) for the complete data model including:

- Encryption metadata fields added by the Mongoose plugin
- Key hierarchy diagram
- KMS configuration models (TenantKMSConfig, MaterializedKMSConfig, DEKRegistry, KeyVersion)
- Complete encrypted fields registry (28+ fields across 16 models, 5 ClickHouse tables, 2 Redis queues)

---

## 6. API Design

No direct encryption API — encryption is transparent. See [Feature Spec Section 8](../features/encryption-at-rest.md#8-how-to-consume) for consumption patterns.

Key internal interfaces:

```typescript
// EncryptionService (packages/shared/src/encryption/engine.ts)
class EncryptionService {
  encrypt(plaintext: string, userId: string): string;
  decrypt(encryptedData: string, userId: string): string;
  encryptForTenant(plaintext: string, tenantId: string): string;
  decryptForTenant(encryptedData: string, tenantId: string): string;
  decryptWithFallback(encryptedData: string, userId: string): string;
  decryptForTenantWithFallback(encryptedData: string, tenantId: string): string;
  compressAndEncryptForTenant(plaintext: string, tenantId: string): string;
  decryptAndDecompressForTenant(encryptedData: string, tenantId: string): string;
  deriveContactKey(tenantId: string, contactSalt: string): Buffer;
  encryptContactPII(tenantId: string, plaintext: string): string;
  decryptContactPII(tenantId: string, ciphertext: string): string;
  blindIndex(tenantId: string, value: string): string;
}

// KMS Provider (packages/database/src/kms/types.ts)
interface KMSProvider {
  generateDataKey(keyId: string): Promise<GenerateDataKeyResult>;
  wrapKey(keyId: string, plaintext: Buffer): Promise<WrapKeyResult>;
  unwrapKey(keyId: string, ciphertext: Buffer): Promise<Buffer>;
  encrypt(keyId: string, plaintext: Buffer): Promise<Buffer>;
  decrypt(keyId: string, ciphertext: Buffer): Promise<Buffer>;
  createKey(purpose: KeyPurpose): Promise<KMSKeyMetadata>;
  healthCheck(): Promise<KMSHealthStatus>;
}

// Mongoose Plugin Options
interface EncryptionPluginOptions {
  fieldsToEncrypt: string[];
  tenantIdField?: string; // default: 'tenantId'
  skipTenantScoping?: boolean; // for User, ServiceNode models
}
```

---

## 7. Open Questions & Risks

### Open Questions

1. Should PBKDF2 iterations increase from 100K to 600K (OWASP 2023)? Impact: ~6x derivation time on cache miss.
2. Should new `EncryptionService` instances default to HKDF instead of PBKDF2?
3. When will the automatic re-encryption background job be implemented?
4. Should encryption metrics be exposed via the observatory pipeline?

### Technical Risks

| Risk                                             | Likelihood | Impact   | Mitigation                                                                             |
| ------------------------------------------------ | ---------- | -------- | -------------------------------------------------------------------------------------- |
| Master key compromise                            | Low        | Critical | Vault storage recommended, rotation support, re-encryption capability                  |
| PBKDF2 iterations too low                        | Medium     | Medium   | Can increase iterations and re-derive keys; cached keys unaffected                     |
| Three wire formats increase debugging complexity | Medium     | Low      | Encryption manifest as single source of truth, version prefix enables format detection |
| Cloud KMS provider outage                        | Low        | Medium   | 5-level fallback chain, local provider as backstop                                     |
| No auto re-encryption                            | Medium     | Medium   | Data upgraded lazily on next write; manual queue available                             |
