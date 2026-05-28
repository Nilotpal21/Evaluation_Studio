# Feature: Encryption at Rest

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: BETA
**Feature Area(s)**: `enterprise`, `governance`, `security`
**Package(s)**: `packages/shared-encryption` (encryption engine, DEK envelope, facade), `packages/shared` (re-exports for backward compat), `packages/database` (Mongoose plugin + KMS), `packages/agent-transfer` (session field encryption), `packages/compiler` (encrypted vault), `apps/studio`, `apps/runtime`, `apps/workflow-engine`
**Owner(s)**: Platform team
**Testing Guide**: [../testing/encryption-at-rest.md](../testing/encryption-at-rest.md)
**Last Updated**: 2026-04-15

---

## 1. Introduction / Overview

### Problem Statement

Agent platforms handle sensitive data across multiple storage layers: LLM API keys, OAuth tokens, session conversation history, contact PII, environment variable secrets, and analytics traces. Storing this data in plaintext across MongoDB, Redis, and ClickHouse creates compliance risk (SOC2, GDPR, HIPAA) and expands the blast radius of data breaches. Without application-layer encryption, a compromised database backup or unauthorized DB access exposes all tenant secrets in cleartext.

### Goal Statement

Provide transparent, tenant-isolated, application-layer AES-256-GCM encryption for all sensitive data at rest across MongoDB, Redis, and ClickHouse, with support for key hierarchy management, KMS integration (AWS, Azure, GCP), key rotation with fallback decryption, GDPR crypto-shredding, and backward-compatible multi-version decryption.

### Summary

The platform implements AES-256-GCM encryption at the application layer through a shared `EncryptionService` singleton (`packages/shared/src/encryption/`). Sensitive fields are encrypted before storage and decrypted on read, with three integration layers:

1. **Mongoose plugin** (`packages/database/src/mongo/plugins/encryption.plugin.ts`) — transparent pre-save/post-find hooks supporting three encryption versions (v1: master key CEK, v2: KMS CEK, v3: tenant-scoped EncryptionService)
2. **Field interceptors** for ClickHouse — `encryptFields`/`decryptFields` with `ENC:v3:` prefix detection and compress-then-encrypt (Zstd + AES-GCM)
3. **Secure queue wrappers** for Redis/BullMQ — `wrapJobDataForEncrypt`/`unwrapJobDataForDecrypt` using per-queue encryption manifests

Key derivation uses PBKDF2 (100K iterations) or HKDF (SHA-256) scoped to tenants, users, or contacts, ensuring cross-tenant key isolation. A centralized encryption manifest (`encryption-manifest.ts`) documents every encrypted field across ClickHouse tables and Redis queues.

---

## 2. Scope

### Goals

- AES-256-GCM encryption for all sensitive fields across MongoDB, Redis, and ClickHouse
- Tenant-isolated key derivation — each tenant's data encrypted with a unique derived key
- Transparent Mongoose plugin (v1/v2/v3) for zero-change encryption of model fields
- KMS provider integration (local, AWS KMS, Azure Key Vault, Azure Managed HSM, GCP Cloud KMS, external)
- Key rotation support with previous key fallback decryption (`decryptWithFallback`)
- GDPR crypto-shredding via per-contact HKDF key derivation chain
- Compress-then-encrypt for ClickHouse payloads (Zstd + AES-256-GCM for payloads >= 64 bytes)
- Double-encryption detection guards at every encrypt call site
- Centralized encryption manifests for ClickHouse and Redis queue field mappings
- Blind indexing for encrypted field search (HMAC-SHA-256)

### Non-Goals (Out of Scope)

- Client-side (browser) encryption — encryption is always server-side
- MongoDB-native CSFLE (Client-Side Field Level Encryption) — the platform uses application-layer encryption instead
- Encryption of Qdrant search index vectors
- Per-tenant configurable encryption algorithms (AES-256-GCM is the only supported algorithm)
- Hardware Security Module (HSM) for non-KMS deployments
- Automatic background re-encryption migration (currently manual/queue-triggered)

---

## 3. User Stories

1. As a **platform operator**, I want all sensitive data encrypted at rest so that a database breach does not expose tenant secrets.
2. As a **tenant admin**, I want my data encrypted with a key unique to my tenant so that a compromise of another tenant does not affect mine.
3. As a **compliance officer**, I want an encryption manifest that documents every encrypted field so that I can audit encryption coverage during SOC2/HIPAA reviews.
4. As a **security engineer**, I want key rotation support so that I can rotate the master key without downtime or data loss.
5. As a **data protection officer**, I want GDPR crypto-shredding so that deleting a contact's encryption salt renders their PII irrecoverable.
6. As an **enterprise customer**, I want to use my own KMS (AWS, Azure, GCP) so that I maintain control over the key encryption keys.
7. As a **developer**, I want encryption to be transparent via a Mongoose plugin so that I do not need to call encrypt/decrypt manually for each model.
8. As an **operator**, I want ciphertext to never leak to API consumers so that even if decryption fails, the response contains null rather than raw ciphertext.

---

## 4. Functional Requirements

1. **FR-1**: The system must encrypt all fields registered in `encryptionPlugin` options and the `CLICKHOUSE_ENCRYPTION_MANIFEST`/`REDIS_QUEUE_ENCRYPTION_MANIFEST` using AES-256-GCM before persisting to any data store.
2. **FR-2**: The system must derive per-tenant encryption keys from the master key using PBKDF2 (100,000 iterations, SHA-256) or HKDF (SHA-256) with a tenant-specific salt (`tenant:<tenantId>`).
3. **FR-3**: The system must cache derived tenant keys in an LRU cache with configurable max size (default: 1,000) and TTL (default: 30 minutes), with secure zero-fill (`Buffer.fill(0)`) on eviction.
4. **FR-4**: The system must detect and reject double-encryption attempts — the `encryptFields` interceptor throws on `ENC:v3:` prefix, and the Mongoose plugin throws when `_enc`/`ire` is already set.
5. **FR-5**: The system must support three Mongoose encryption versions (v1: master key CEK wrapping, v2: KMS CEK wrapping via `wrapKey`/`unwrapKey`, v3: tenant-scoped `EncryptionService.encryptForTenant`) with automatic version detection on read based on the `ire` field.
6. **FR-6**: The system must support key rotation by accepting previous master keys via `EncryptionServiceConfig.previous` array and attempting decryption with previous keys in order via `decryptWithFallback` and `decryptForTenantWithFallback`.
7. **FR-7**: The system must apply Zstd compression before encryption for ClickHouse payloads >= 64 bytes (`MIN_COMPRESS_BYTES`), with `Z1` prefix for compressed and `N0` for uncompressed, falling back gracefully when Zstd is unavailable.
8. **FR-8**: The system must provide GDPR crypto-shredding via per-contact HKDF key derivation chained from tenant keys (`masterKey -> HKDF(tenant) -> HKDF(contactSalt)`), where deleting the contact's `encryptionSalt` renders their PII irrecoverable.
9. **FR-9**: The system must null out encrypted fields (not return ciphertext) when decryption fails, setting `_decryptionFailed = true` to prevent ciphertext leakage to API consumers.
10. **FR-10**: The system must block `updateMany` with encrypted fields and `insertMany` for `skipTenantScoping` models to prevent plaintext bypass of the encryption pipeline.
11. **FR-11**: The system must support KMS providers (local, aws-kms, azure-keyvault, azure-managed-hsm, gcp-cloud-kms, external) via the `KMSProvider` interface with `wrapKey`/`unwrapKey`/`generateDataKey` operations.
12. **FR-12**: The system must resolve the master key from a vault provider first, falling back to the `ENCRYPTION_MASTER_KEY` environment variable, with a warning when env var is used in production.
13. **FR-13**: The system must provide blind indexing via HMAC-SHA-256 (`blindIndex` method) for searchable encrypted fields using a tenant-scoped blind index key derived via HKDF.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                          |
| -------------------------- | ------------ | -------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Encryption keys derived per-tenant, not per-project            |
| Agent lifecycle            | SECONDARY    | Agent credentials (LLM keys, tool secrets) encrypted           |
| Customer experience        | NONE         | Transparent — no user-facing UX changes                        |
| Integrations / channels    | SECONDARY    | Channel connection credentials encrypted                       |
| Observability / tracing    | SECONDARY    | Trace data encrypted in ClickHouse                             |
| Governance / controls      | PRIMARY      | Core compliance feature for SOC2, GDPR, HIPAA                  |
| Enterprise / compliance    | PRIMARY      | KMS integration, key rotation, crypto-shredding                |
| Admin / operator workflows | SECONDARY    | Operators manage master key, KMS config, key rotation policies |

### Related Feature Integration Matrix

| Related Feature       | Relationship Type | Why It Matters                                                      | Key Touchpoints                                 | Current State |
| --------------------- | ----------------- | ------------------------------------------------------------------- | ----------------------------------------------- | ------------- |
| Model Hub             | depends on        | LLM credentials (`encryptedApiKey`, `encryptedEndpoint`)            | `llm-credential.model.ts`                       | STABLE        |
| Auth Profiles         | depends on        | OAuth secrets (`encryptedSecrets`, `previousEncryptedSecrets`)      | `auth-profile.model.ts`                         | STABLE        |
| Environment Variables | depends on        | Env var values (`encryptedValue`)                                   | `environment-variable.model.ts`                 | STABLE        |
| Session Management    | depends on        | Conversation history and session state (`stateData`, `irData`)      | `session-state.model.ts`                        | STABLE        |
| Analytics Pipeline    | depends on        | Trace/event data encrypted in ClickHouse                            | `CLICKHOUSE_ENCRYPTION_MANIFEST`                | STABLE        |
| Audit Logging         | depends on        | Audit event metadata encrypted in ClickHouse                        | `audit_events` table manifest                   | STABLE        |
| GDPR / Contact PII    | extends           | Crypto-shredding via per-contact HKDF key derivation                | `deriveContactKey`, `encryptContactPII`         | BETA          |
| SSO Enterprise Auth   | depends on        | SSO config secrets encrypted                                        | `apps/studio/src/lib/sso-helpers.ts`            | STABLE        |
| MCP Support           | depends on        | MCP server config encrypted (`encryptedEnv`, `encryptedAuthConfig`) | `mcp-server-config.model.ts`                    | STABLE        |
| Channels              | depends on        | Channel connection credentials encrypted                            | `channel-connection.model.ts`                   | STABLE        |
| Webhook System        | depends on        | Webhook delivery secret encrypted                                   | `webhook-subscription.model.ts`                 | STABLE        |
| Tool Invocations      | depends on        | Tool secret values encrypted                                        | `tool-secret.model.ts`                          | STABLE        |
| Workflow Engine       | depends on        | Workflow connection secrets encrypted                               | `apps/workflow-engine/src/services/database.ts` | STABLE        |

---

## 6. Design Considerations (Optional)

N/A — Encryption at rest is a backend-only feature with no UI components. Operators interact via environment variables (`ENCRYPTION_MASTER_KEY`) and per-tenant KMS configuration via the `TenantKMSConfig` model.

---

## 7. Technical Considerations (Optional)

- **Backward compatibility**: Three encryption versions (v1, v2, v3) coexist. The Mongoose plugin auto-detects version via the `ire` field on read and can decrypt all three. New writes default to v3 (tenant-scoped) when `setTenantEncryption()` is configured, falling back to v2 (KMS) or v1 (master key CEK).
- **Performance**: PBKDF2 with 100K iterations is CPU-expensive (~10-50ms per derivation). Derived keys are cached per-tenant in `TenantKeyCache` (LRU, max 1000, 30-min TTL). HKDF is used for new paths (contacts, blind indexes) as it is non-iterated (~microseconds).
- **Compression**: Zstd compression before encryption for ClickHouse saves ~40-60% storage for large JSON payloads. Requires Node.js 22+ for native `zlib.zstdCompressSync`; falls back to uncompressed (`N0` prefix) otherwise.
- **Legacy IV lengths**: The system accepts both 12-byte (current NIST SP 800-38D recommended) and 16-byte (legacy) IVs for backward compatibility in `aesGcmDecryptHex` and `decryptContactPII`.
- **Wire formats**: Two formats coexist — hex 3-part (`iv:authTag:ciphertext` in hex) for Mongoose plugin path, and base64 4-part (`prefix:iv:authTag:ciphertext` in base64) for compress-then-encrypt. Contact PII uses binary concatenation (`iv + authTag + encrypted` in base64).
- **KMS resolution chain**: 5-level inheritance for per-tenant KMS config: project+environment -> project default -> tenant+environment -> tenant default -> platform default. Resolved via `MaterializedKMSConfig` (pre-computed, O(1) lookup).

---

## 8. How to Consume

### Studio UI

N/A — Encryption is transparent. Studio passes plaintext to API; encryption happens server-side via Mongoose plugin hooks.

### API (Runtime)

No direct encryption API. Encryption is applied transparently by:

- **Mongoose plugin** on save/read for all models with `encryptionPlugin` (16 models, see Section 9)
- **ClickHouse interceptor** on insert/select via `encryptFields`/`decryptFields`
- **Secure queue wrappers** on BullMQ job add/process via `wrapJobDataForEncrypt`/`unwrapJobDataForDecrypt`

### API (Studio)

Studio encrypts directly for specific routes:

| Method | Path                               | Purpose                        |
| ------ | ---------------------------------- | ------------------------------ |
| PUT    | `/api/sso/config`                  | SSO config secret encryption   |
| POST   | `/api/projects/[id]/connections`   | Connection API key encryption  |
| POST   | `/api/tenant-credentials`          | Tenant credential encryption   |
| POST   | `/api/projects/[id]/auth-profiles` | Auth profile secret encryption |
| POST   | `/api/projects/[id]/mcp-servers`   | MCP server config encryption   |

### Admin Portal

KMS configuration is managed via the `TenantKMSConfig` model (per-tenant). No admin UI exists yet — configuration is via API or direct DB seeding.

### Channel / SDK / Voice / A2A / MCP Integration

Not channel-aware. All channel data flows through the runtime, where encryption is applied transparently by the Mongoose plugin and secure queue wrappers.

---

## 9. Data Model

### Encryption Metadata (Mongoose Plugin)

```text
Schema Fields (added by encryptionPlugin to each encrypted model):
  - ire: string ('v1' | 'v2' | 'v3')          — encryption version marker
  - iv: string (base64)                        — initialization vector (v1 only)
  - cek: string (base64)                       — wrapped content encryption key (v1/v2)
  - kmsKeyId: string                           — KMS key ID used for CEK wrapping (v2)
  - fieldsToEncrypt: string[]                  — list of encrypted field names

Note: These metadata fields are stripped from toJSON/toObject output via schema transform.
```

### Key Hierarchy

```text
ENCRYPTION_MASTER_KEY (env var, 32 bytes / 64 hex chars)
  |
  ├── PBKDF2(masterKey, "tenant:<tenantId>")  → tenant DEK (v3 Mongoose path)
  ├── HKDF(masterKey, "tenant:<tenantId>", "encryption-key") → contact encryption key
  │     └── HKDF(contactEncKey, contactSalt, "contact-encryption") → per-contact key
  ├── HKDF(masterKey, "blind:<tenantId>", "blind-index-key") → blind index key (HMAC)
  ├── PBKDF2(masterKey, userId) → per-user key (legacy v1 user-scoped path)
  └── KMS wrapKey(keyId, randomCEK) → per-document CEK (v2 KMS path)
```

### KMS Models

```text
Collection: tenant_kms_configs
Fields:
  - _id: string (uuidv7)
  - tenantId: string (required, unique index)
  - defaultProvider: KMSProviderRef (providerType, keyId, region, vaultUrl, etc.)
  - environments: [{ environment, provider, tier }]
  - projects: [{ projectId, defaultProvider, environments }]
  - dekEpochIntervalHours: number (default: 24)
  - dekMaxUsageCount: number (default: 2^30)
  - dekRetentionDays: number (default: 90)
  - kekRotationPeriodDays: number (default: 365)
  - reencryption: { enabled, concurrency, batchSize, maxRetries }
  - complianceLevel: 'standard' | 'pci-dss' | 'hipaa' | 'fips-140-3'
  - failurePolicy: 'fail-closed' | 'graceful-degradation'
Indexes:
  - { tenantId: 1 } (unique)

Collection: materialized_kms_configs
Fields:
  - tenantId, projectId, environment (scope tuple)
  - resolvedProvider: IResolvedProviderRef
  - resolvedTier, resolvedKeyId
  - DEK policy fields, sourceConfigVersion, materializedAt
Indexes:
  - { tenantId: 1, projectId: 1, environment: 1 } (unique)

Collection: dek_registry
Fields:
  - tenantId, projectId, environment, epoch
  - wrappedDek, kekKeyId, kekKeyVersion
  - status: 'active' | 'decrypt_only' | 'destroyed'
  - usageCount, maxUsageCount, expiresAt
Indexes:
  - { tenantId: 1, projectId: 1, environment: 1, epoch: 1 } (unique)
  - { status: 1, expiresAt: 1 } (epoch transition)
  - { kekKeyId: 1, status: 1 } (re-encryption)

Collection: key_versions
Fields:
  - tenantId, version, status ('active' | 'decrypt_only' | 'destroyed')
  - algorithm, rotatedAt, destroyedAt
Indexes:
  - { tenantId: 1, version: 1 } (unique)
```

### Encrypted Fields Registry (28 entries across 16 Mongoose models)

| Model                 | Encrypted Fields                                                                                                                                 | Scope  | Layer                               | Store   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | ----------------------------------- | ------- |
| LLMCredential         | `encryptedApiKey`, `encryptedEndpoint`                                                                                                           | tenant | mongoose-plugin                     | MongoDB |
| ToolSecret            | `encryptedValue`                                                                                                                                 | tenant | mongoose-plugin                     | MongoDB |
| AuthProfile           | `encryptedSecrets`, `previousEncryptedSecrets`                                                                                                   | tenant | mongoose-plugin                     | MongoDB |
| EndUserOAuthToken     | `encryptedAccessToken`, `encryptedRefreshToken`                                                                                                  | tenant | mongoose-plugin                     | MongoDB |
| EnvironmentVariable   | `encryptedValue`                                                                                                                                 | tenant | mongoose-plugin                     | MongoDB |
| MCPServerConfig       | `encryptedEnv`, `encryptedAuthConfig`                                                                                                            | tenant | mongoose-plugin                     | MongoDB |
| SessionState          | `stateData`, `irData`, `compilationData`                                                                                                         | tenant | mongoose-plugin                     | MongoDB |
| Message               | `content`                                                                                                                                        | tenant | mongoose-plugin                     | MongoDB |
| Organization          | `billingConfig`                                                                                                                                  | tenant | mongoose-plugin                     | MongoDB |
| ChannelConnection     | `encryptedCredentials`                                                                                                                           | tenant | mongoose-plugin                     | MongoDB |
| WebhookSubscription   | `encryptedSecret`                                                                                                                                | tenant | mongoose-plugin                     | MongoDB |
| TenantServiceInstance | `encryptedApiKey`, `encryptedConfig`                                                                                                             | tenant | mongoose-plugin                     | MongoDB |
| ArchWorkspaceConfig   | `encryptedApiKey`, `encryptedEndpoint`                                                                                                           | tenant | mongoose-plugin                     | MongoDB |
| OrgProxyConfig        | `encryptedProxyUsername`, `encryptedProxyPassword`, `encryptedProxyToken`, `encryptedCaCertificate`, `encryptedClientCert`, `encryptedClientKey` | tenant | mongoose-plugin                     | MongoDB |
| User                  | `passwordHash`                                                                                                                                   | user   | mongoose-plugin (skipTenantScoping) | MongoDB |
| ServiceNode           | `encryptedSecrets`                                                                                                                               | user   | mongoose-plugin (skipTenantScoping) | MongoDB |

**ClickHouse Encrypted Tables (5 tables, 7 fields)**:

| Table           | Encrypted Fields                     |
| --------------- | ------------------------------------ |
| messages        | `content`                            |
| traces          | `data`                               |
| platform_events | `data`                               |
| audit_events    | `metadata`, `old_value`, `new_value` |
| insight_results | `dimensions`                         |

**Redis Queue Encrypted Queues (2 queues, 2 fields)**:

| Queue               | Encrypted Fields |
| ------------------- | ---------------- |
| llm-requests        | `message`        |
| message-persistence | `content`        |

---

## 10. Key Implementation Files

### Domain / Core Logic (`packages/shared-encryption/`)

> **Note**: The encryption engine was migrated from `packages/shared/src/encryption/` to the dedicated `packages/shared-encryption/` package. `packages/shared/src/encryption/` now re-exports from `@agent-platform/shared-encryption` for backward compatibility.

| File                                                         | Purpose                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `packages/shared-encryption/src/engine.ts`                   | Core `EncryptionService` — AES-256-GCM encrypt/decrypt, user/contact scopes     |
| `packages/shared-encryption/src/tenant-encryption-facade.ts` | `TenantEncryptionFacade` — DEK envelope encryption for tenant-scoped operations |
| `packages/shared-encryption/src/dek-codec.ts`                | DEK ciphertext codec (encode/decode envelope format)                            |
| `packages/shared-encryption/src/envelope-format.ts`          | DEK envelope format detection (`isDEKEnvelopeFormat`)                           |
| `packages/shared-encryption/src/encryption-context.ts`       | AsyncLocalStorage-based encryption environment propagation                      |
| `packages/shared-encryption/src/facade-accessor.ts`          | Typed `globalThis` bridge for `TenantEncryptionFacade` singleton access         |
| `packages/shared-encryption/src/types.ts`                    | Type definitions: `EncryptionScope`, `EncryptionServiceConfig`, `DEKScope`      |
| `packages/shared-encryption/src/encryption-manifest.ts`      | ClickHouse and Redis queue encryption manifests (field declarations)            |
| `packages/shared-encryption/src/encryption-registry.ts`      | Double-encryption detection registry (`isAlreadyEncrypted`)                     |
| `packages/shared-encryption/src/field-interceptor.ts`        | ClickHouse/Redis field-level encrypt/decrypt with `ENC:v3:` prefix              |
| `packages/shared-encryption/src/secure-queue.ts`             | BullMQ job data encrypt/decrypt wrappers                                        |
| `packages/shared-encryption/src/index.ts`                    | Barrel exports for engine, facade, codec, context, and accessor                 |
| `packages/shared/src/encryption/index.ts`                    | Backward-compatible re-exports from `@agent-platform/shared-encryption`         |

### Cross-Package Encryption Consumers

| File                                                                  | Purpose                                                   |
| --------------------------------------------------------------------- | --------------------------------------------------------- |
| `packages/agent-transfer/src/security/session-field-encryption.ts`    | Tenant-scoped session field encryption for agent transfer |
| `packages/compiler/src/platform/security/encrypted-vault.ts`          | PIIVault encryption/decryption for compiler constructs    |
| `apps/studio/src/services/auth/mfa-encryption.ts`                     | MFA secret encryption in Studio                           |
| `apps/runtime/src/services/stores/clickhouse-encryption-singleton.ts` | ClickHouse encryption interceptor singleton for runtime   |

### Mongoose Plugin

| File                                                       | Purpose                                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `packages/database/src/mongo/plugins/encryption.plugin.ts` | Mongoose plugin: v1/v2/v3 pre-save/post-find encryption with multi-version decryption |

### KMS Providers & DEK Management

| File                                                                | Purpose                                                        |
| ------------------------------------------------------------------- | -------------------------------------------------------------- |
| `packages/database/src/kms/types.ts`                                | KMS provider interface (NIST SP 800-57 key hierarchy)          |
| `packages/database/src/kms/kms-registry.ts`                         | Global KMS provider singleton + pool registry                  |
| `packages/database/src/kms/kms-provider-pool.ts`                    | Multi-provider KMS pool with LRU eviction and health checks    |
| `packages/database/src/kms/local-kms-provider.ts`                   | Local (in-process) KMS for dev/test                            |
| `packages/database/src/kms/dek-manager.ts`                          | Per-scope DEK lifecycle (acquire, unwrap, batch, force-rotate) |
| `packages/database/src/kms/dek-facade-factory.ts`                   | Shared init for DEKManager + TenantEncryptionFacade            |
| `packages/database/src/kms/auth-config-crypto.ts`                   | Auth config encrypt/decrypt using KMS providers                |
| `packages/database/src/kms/provider-readiness.ts`                   | KMS provider readiness verification (crypto probe)             |
| `packages/database/src/kms/providers/aws-kms-provider.ts`           | AWS KMS provider                                               |
| `packages/database/src/kms/providers/azure-keyvault-provider.ts`    | Azure Key Vault provider                                       |
| `packages/database/src/kms/providers/azure-managed-hsm-provider.ts` | Azure Managed HSM provider                                     |
| `packages/database/src/kms/providers/gcp-cloud-kms-provider.ts`     | GCP Cloud KMS provider                                         |
| `packages/database/src/kms/providers/external-kms-provider.ts`      | Generic external KMS provider via REST API                     |

### Key Rotation

| File                                                        | Purpose                                                          |
| ----------------------------------------------------------- | ---------------------------------------------------------------- |
| `apps/studio/src/services/security/key-rotation-service.ts` | Master key version management, rotation policies, API key expiry |

### KMS Data Models

| File                                                            | Purpose                                                        |
| --------------------------------------------------------------- | -------------------------------------------------------------- |
| `packages/database/src/models/tenant-kms-config.model.ts`       | Per-tenant KMS config with 5-level resolution chain            |
| `packages/database/src/models/materialized-kms-config.model.ts` | Pre-resolved KMS config for O(1) hot-path lookup               |
| `packages/database/src/models/dek-registry.model.ts`            | Epoch-scoped DEK entries with lifecycle management             |
| `packages/database/src/models/key-version.model.ts`             | Key version lifecycle tracking (active/decrypt_only/destroyed) |

### Tests (48 files)

#### `packages/shared/` — Core engine unit tests (16 files)

| File                                                                       | Type | Coverage Focus                            |
| -------------------------------------------------------------------------- | ---- | ----------------------------------------- |
| `packages/shared/src/__tests__/encryption/engine.test.ts`                  | unit | Core EncryptionService encrypt/decrypt    |
| `packages/shared/src/__tests__/encryption/engine-edge-cases.test.ts`       | unit | Edge cases and error handling             |
| `packages/shared/src/__tests__/encryption/engine-no-zstd.test.ts`          | unit | Graceful fallback without Zstd            |
| `packages/shared/src/__tests__/encryption/cross-compat-proof.test.ts`      | unit | Cross-version compatibility proof         |
| `packages/shared/src/__tests__/encryption/multi-key.test.ts`               | unit | Multi-key rotation and fallback           |
| `packages/shared/src/__tests__/encryption/tenant-key-cache.test.ts`        | unit | LRU cache behavior and secure eviction    |
| `packages/shared/src/__tests__/encryption/key-derivation.test.ts`          | unit | PBKDF2 and HKDF key derivation            |
| `packages/shared/src/__tests__/encryption/compress-encrypt.test.ts`        | unit | Compress-then-encrypt (Zstd + AES-GCM)    |
| `packages/shared/src/__tests__/encryption/contact-encryption.test.ts`      | unit | Contact PII encryption and blind indexing |
| `packages/shared/src/__tests__/encryption/errors.test.ts`                  | unit | Error constructor behavior                |
| `packages/shared/src/__tests__/encryption/index-singleton.test.ts`         | unit | Singleton lifecycle                       |
| `packages/shared/src/__tests__/encryption/is-encryption-available.test.ts` | unit | Availability check logic                  |
| `packages/shared/src/__tests__/encryption/master-key-rotation-e2e.test.ts` | unit | Grace period mechanism for key rotation   |
| `packages/shared/src/encryption/__tests__/encryption-manifest.test.ts`     | unit | Manifest registry and lookup              |
| `packages/shared/src/encryption/__tests__/field-interceptor.test.ts`       | unit | Field encrypt/decrypt with prefix         |
| `packages/shared/src/encryption/__tests__/secure-queue.test.ts`            | unit | BullMQ job data wrappers                  |
| `packages/shared/src/encryption/__tests__/master-key-resolver.test.ts`     | unit | Vault/env key resolution                  |

#### `packages/shared-encryption/` — DEK envelope encryption unit tests (4 files)

| File                                                                        | Type | Coverage Focus                              |
| --------------------------------------------------------------------------- | ---- | ------------------------------------------- |
| `packages/shared-encryption/src/__tests__/engine.test.ts`                   | unit | EncryptionService with DEK facade delegates |
| `packages/shared-encryption/src/__tests__/dek-codec.test.ts`                | unit | DEK ciphertext encode/decode roundtrip      |
| `packages/shared-encryption/src/__tests__/encryption-context.test.ts`       | unit | AsyncLocalStorage environment propagation   |
| `packages/shared-encryption/src/__tests__/tenant-encryption-facade.test.ts` | unit | TenantEncryptionFacade encrypt/decrypt      |

#### `packages/database/` — Mongoose plugin, KMS, DEK tests (18 files)

| File                                                                        | Type        | Coverage Focus                                        |
| --------------------------------------------------------------------------- | ----------- | ----------------------------------------------------- |
| `packages/database/src/__tests__/mongo-plugins.test.ts`                     | unit        | Mongoose encryption plugin general                    |
| `packages/database/src/__tests__/encryption-plugin-dek.test.ts`             | unit        | DEK envelope path in Mongoose plugin                  |
| `packages/database/src/__tests__/clickhouse-encryption-interceptor.test.ts` | unit        | ClickHouse field-level encrypt/decrypt interceptor    |
| `packages/database/src/__tests__/kms-providers.test.ts`                     | unit        | KMS provider interface implementations                |
| `packages/database/src/__tests__/kms-provider-pool.test.ts`                 | unit        | KMS provider pool caching and lifecycle               |
| `packages/database/src/__tests__/kms-provider-pool-edge.test.ts`            | unit        | KMS provider pool edge cases                          |
| `packages/database/src/__tests__/kms-resolver.test.ts`                      | unit        | KMS config resolution (materialized + fallback)       |
| `packages/database/src/__tests__/local-kms-provider.test.ts`                | unit        | Local KMS provider wrap/unwrap                        |
| `packages/database/src/__tests__/cloud-kms-provider-contracts.test.ts`      | unit        | Cloud KMS provider interface contracts (mocked SDKs)  |
| `packages/database/src/__tests__/dek-facade-factory.test.ts`                | unit        | DEK facade factory init and wiring                    |
| `packages/database/src/__tests__/sdk-channel-encryption.test.ts`            | unit        | SDK channel encryption schema validation              |
| `packages/database/src/kms/__tests__/auth-config-encryption.test.ts`        | unit        | Auth config encrypt/decrypt with KMS                  |
| `packages/database/src/kms/__tests__/resolve-auth-config.test.ts`           | unit        | Auth config resolution                                |
| `packages/database/src/__tests__/encryption-toggle-e2e.test.ts`             | integration | Encryption enable/disable toggle                      |
| `packages/database/src/__tests__/dek-credential-roundtrip.test.ts`          | integration | DEK credential roundtrip with real MongoDB            |
| `packages/database/src/__tests__/dek-full-chain.test.ts`                    | integration | Full DEK chain (DEKManager -> Facade -> Plugin -> DB) |
| `packages/database/src/__tests__/kms-e2e-full-chain.test.ts`                | integration | Full KMS chain with real MongoDB and LocalKMS         |
| `packages/database/src/__tests__/dek-lifecycle-cloud-e2e.test.ts`           | integration | DEK lifecycle with mocked cloud KMS providers         |
| `packages/database/src/__tests__/kms-pool-cloud-integration.test.ts`        | integration | KMS pool with cloud provider simulation               |

#### `apps/runtime/` — Runtime encryption and KMS tests (16 files)

| File                                                                              | Type        | Coverage Focus                                      |
| --------------------------------------------------------------------------------- | ----------- | --------------------------------------------------- |
| `apps/runtime/src/__tests__/auth/encryption-service.test.ts`                      | unit        | Encryption engine user-scoped encrypt/decrypt       |
| `apps/runtime/src/__tests__/auth/encryption-analyzer.test.ts`                     | unit        | Encryption availability diagnostics                 |
| `apps/runtime/src/__tests__/auth/encryption-salt-lifecycle.test.ts`               | unit        | Contact encryption salt assignment and GDPR cascade |
| `apps/runtime/src/__tests__/auth/kms-admin-crud.test.ts`                          | unit        | KMS admin route CRUD logic                          |
| `apps/runtime/src/__tests__/auth/kms-admin-authz.test.ts`                         | unit        | KMS admin route authorization enforcement           |
| `apps/runtime/src/__tests__/auth/kms-security.test.ts`                            | unit        | Cross-tenant DEK isolation, credential redaction    |
| `apps/runtime/src/__tests__/auth/kms-per-tenant-integration.test.ts`              | integration | Multi-tenant KMS with full stack                    |
| `apps/runtime/src/__tests__/execution/contexts/contact/contact-encryptor.test.ts` | unit        | Contact PII encryption via EncryptionService        |
| `apps/runtime/src/services/kms/__tests__/dek-cache.test.ts`                       | unit        | Multi-layer DEK cache (L1 LRU + L2 Redis)           |
| `apps/runtime/src/services/kms/__tests__/dek-manager.test.ts`                     | unit        | DEK Manager acquire/unwrap/batch/rotate             |
| `apps/runtime/src/services/kms/__tests__/kms-audit-logger.test.ts`                | unit        | KMS audit event logging                             |
| `apps/runtime/src/services/kms/__tests__/kms-circuit-breaker.test.ts`             | unit        | KMS provider circuit breaker wrapper                |
| `apps/runtime/src/services/kms/__tests__/kms-materializer.test.ts`                | unit        | KMS config materialization (5-level inheritance)    |
| `apps/runtime/src/services/kms/__tests__/kms-resolver.test.ts`                    | unit        | KMS resolver with materialized config               |
| `apps/runtime/src/services/kms/__tests__/kms-rotation-job.test.ts`                | unit        | KMS key rotation job logic                          |
| `apps/runtime/src/services/kms/__tests__/reencryption-queue.test.ts`              | unit        | Re-encryption queue enqueue and shutdown            |

#### Other packages (3 files)

| File                                                                                      | Type        | Coverage Focus                                   |
| ----------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------ |
| `packages/agent-transfer/src/__tests__/unit/session-field-encryption.test.ts`             | unit        | Tenant-scoped session field encryption           |
| `packages/compiler/src/__tests__/security/encrypted-vault.test.ts`                        | unit        | PIIVault encrypt/decrypt for compiler constructs |
| `packages/connectors/src/__tests__/integration/credential-encryption.integration.test.ts` | integration | Connection binding model (no credential storage) |
| `packages/database/src/__tests__/encryption-toggle-e2e.test.ts`                           | e2e         | Encryption enable/disable toggle                 |

---

## 11. Configuration

### Environment Variables

| Variable                | Default    | Description                                                  |
| ----------------------- | ---------- | ------------------------------------------------------------ |
| `ENCRYPTION_MASTER_KEY` | (required) | 64-character hex string (32 bytes) — the root encryption key |
| `ENCRYPTION_ENABLED`    | `true`     | Set to `false` to disable encryption (dev/test only)         |

### Runtime Configuration

- `EncryptionServiceConfig.defaultStrategy`: `'pbkdf2'` (default) or `'hkdf'` — key derivation strategy
- `EncryptionServiceConfig.cache.maxSize`: Max tenant keys in LRU cache (default: 1,000)
- `EncryptionServiceConfig.cache.ttlMs`: Tenant key TTL in ms (default: 1,800,000 / 30 min)
- `EncryptionServiceConfig.previous`: Array of `{ version, masterKeyHex }` for key rotation fallback
- KMS provider configuration is per-tenant via `TenantKMSConfig` model (providerType, keyId, region, vaultUrl, authMethod)

### Key Rotation Policy (KeyRotationService)

- `masterKeyRotationDays`: 90 (default)
- `tenantKeyRotationDays`: 180 (default)
- `apiKeyMaxAgeDays`: 365 (default)
- `apiKeyGracePeriodHours`: 24 (default)

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tenant isolation  | Every encryption operation derives a unique key per tenantId via `PBKDF2(masterKey, "tenant:<tenantId>")`. Cross-tenant decryption is cryptographically impossible without the master key. |
| Project isolation | KMS config supports project-level overrides via `TenantKMSConfig.projects[].defaultProvider`, but encryption keys are tenant-scoped by default.                                            |
| User isolation    | User-scoped encryption (v1 legacy) uses `userId` as salt. Contact-scoped uses per-contact `encryptionSalt` for GDPR shredding.                                                             |

### Security & Compliance

- **Algorithm**: AES-256-GCM (NIST SP 800-38D) with 12-byte IV (NIST-recommended) and 16-byte auth tag
- **Key derivation**: PBKDF2 with 100K iterations (OWASP 2023 minimum is 600K for SHA-256 — **gap noted in GAP-001**); HKDF for new paths
- **Double-encryption detection**: Throws hard error to prevent data corruption — checks `_enc` flag, `ire` field, and `ENC:v3:` prefix
- **Ciphertext leak prevention**: Null sentinel on decrypt failure, `_decryptionFailed` flag set, encryption metadata stripped from toJSON/toObject
- **KMS support**: FIPS 140-3 Level 3 compliance via HSM-backed keys (Azure Managed HSM, AWS CloudHSM)
- **Secure key eviction**: `Buffer.fill(0)` on all cache evictions and provider shutdown
- **Master key resolution**: Vault provider first, env var fallback with production warning

### Performance & Scalability

- Tenant key cache reduces PBKDF2 derivation to ~1 per 30 minutes per tenant (LRU hit rate should be >99% in steady state)
- HKDF (non-iterated) used for new paths — microsecond derivation vs ~10-50ms for PBKDF2
- Zstd compression saves 40-60% on ClickHouse writes for large JSON payloads (requires Node.js 22+)
- AES-GCM hardware acceleration on modern CPUs — encrypt/decrypt adds ~0.1-0.5ms per field
- KMS provider pool with LRU eviction (max 50 providers), 5-minute health check interval

### Reliability & Failure Modes

- **Missing master key**: `masterKeyMissing()` error at startup (fail-closed) — service cannot start without valid key
- **Decrypt failure**: Null sentinel returned, `_decryptionFailed` flag set on document — never leaks ciphertext
- **Key rotation**: `decryptWithFallback`/`decryptForTenantWithFallback` try current key then iterate `previousKeys` array
- **KMS unavailable**: Falls back through KMS resolver chain; if all fail and v1 master key is available, falls back to v1 CEK decryption
- **Double-encryption**: Hard error thrown, prevents silent data corruption
- **Version downgrade prevention**: v3 documents refuse to save if tenant encryption becomes unavailable ("Refusing to downgrade")
- **Bulk operation safety**: `updateMany` with encrypted fields throws; `insertMany` for `skipTenantScoping` models with encrypted fields throws

### Observability

- `[encryption-plugin]` log prefix for all Mongoose plugin warnings
- Warnings logged for: decrypt failure (per-field and per-document), missing tenantId, CEK unwrap failure, route decryption fallback, string coercion failure
- `_decryptionFailed` flag on documents enables downstream monitoring
- KMS provider pool logs evictions, health check failures, and LRU evictions

### Data Lifecycle

- Encrypted data retained as long as the document/row exists
- Key rotation: previous keys must remain available in `EncryptionServiceConfig.previous` until all data is re-encrypted to the current key version
- GDPR crypto-shredding: delete the contact's `encryptionSalt` to render their PII irrecoverable — no need to find and delete individual records
- DEK lifecycle: active -> decrypt_only -> destroyed (NIST SP 800-57 compliant)
- DEK epoch interval configurable per-tenant (default: 24 hours), with max usage count (default: 2^30)
- DEK retention: 90 days default before destruction eligibility

---

## 13. Delivery Plan / Work Breakdown

Feature is fully implemented. Implementation phases were:

1. Core EncryptionService (`packages/shared/src/encryption/`)
   1.1 AES-256-GCM engine with PBKDF2/HKDF key derivation
   1.2 Tenant key cache with LRU eviction and secure zero-fill
   1.3 Singleton factory with env var configuration
   1.4 Previous key fallback for key rotation
2. Mongoose Integration (`packages/database/src/mongo/plugins/encryption.plugin.ts`)
   2.1 v1 encryption plugin (master key CEK wrapping)
   2.2 v2 encryption plugin (KMS CEK wrapping via `wrapKey`/`unwrapKey`)
   2.3 v3 encryption plugin (tenant-scoped `EncryptionService`)
   2.4 Backward-compatible multi-version decryption (v1/v2/v3 auto-detection)
   2.5 Bulk operation safety guards (`updateMany`, `insertMany`)
3. ClickHouse Integration
   3.1 Encryption manifest for table/field mapping (`CLICKHOUSE_ENCRYPTION_MANIFEST`)
   3.2 Field interceptor with `ENC:v3:` prefix detection
   3.3 Compress-then-encrypt (Zstd + AES-GCM, `Z1`/`N0` prefix)
4. Redis Integration
   4.1 Secure queue wrappers for BullMQ job data (`REDIS_QUEUE_ENCRYPTION_MANIFEST`)
5. KMS Integration
   5.1 KMS provider interface and types (NIST SP 800-57)
   5.2 Provider implementations (local, AWS, Azure KV, Azure HSM, GCP, external)
   5.3 KMS registry (singleton) and provider pool (LRU + health checks)
   5.4 Per-tenant KMS configuration (`TenantKMSConfig` -> `MaterializedKMSConfig`)
   5.5 DEK registry with epoch-scoped lifecycle
6. Compliance Features
   6.1 GDPR crypto-shredding via per-contact HKDF key chain
   6.2 Blind indexing for encrypted field search (HMAC-SHA-256)
   6.3 Key rotation service with version lifecycle management
   6.4 Double-encryption detection guards

---

## 14. Success Metrics

| Metric                 | Baseline  | Target                 | How Measured                                            |
| ---------------------- | --------- | ---------------------- | ------------------------------------------------------- |
| Encryption coverage    | 0% fields | 100% registered fields | Encrypted fields registry completeness                  |
| Decrypt failure rate   | N/A       | < 0.01%                | Log monitoring for `_decryptionFailed` flag             |
| Key derivation latency | N/A       | < 1ms (cached)         | Tenant key cache hit rate (target: >99%)                |
| Compliance audit pass  | N/A       | SOC2 + GDPR + HIPAA    | External audit certification                            |
| Key rotation success   | N/A       | Zero data loss         | Re-encryption job completion with `decryptWithFallback` |

---

## 15. Open Questions

1. Should PBKDF2 iterations be increased from 100K to 600K per OWASP 2023 recommendations for SHA-256? This would increase derivation time ~6x but only affects cache misses.
2. Should new paths default to HKDF instead of PBKDF2 for performance? The `EncryptionService` constructor currently defaults to `'pbkdf2'`.
3. Is there a plan for an automatic background re-encryption migration job to re-encrypt all data after key rotation, or will the `reencryption-queue` in the manifest be implemented?
4. Should the `master-key-resolver.ts` stub logger be replaced with `createLogger` from `@abl/compiler/platform` for production observability?
5. What is the timeline for implementing E2E tests that exercise encryption through the full HTTP API layer (GAP-005)?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                                                                                                                                       | Severity | Status    |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------- |
| GAP-001 | PBKDF2 iterations (100K) below OWASP 2023 minimum (600K) for SHA-256                                                                                                                                                                                                              | Medium   | Open      |
| GAP-002 | No automatic re-encryption migration job — key rotation requires data to be naturally touched or manually re-encrypted. Re-encryption queue infrastructure exists (`reencryption-queue.test.ts`) but the background job is not yet wired to run automatically.                    | Medium   | Mitigated |
| GAP-003 | Zstd compression requires Node.js 22+ — silently falls back to uncompressed on older versions                                                                                                                                                                                     | Low      | Mitigated |
| GAP-004 | `master-key-resolver.ts` uses a stub logger (no-op) instead of `createLogger`                                                                                                                                                                                                     | Low      | Open      |
| GAP-005 | No E2E tests that exercise encryption through the full HTTP API layer. Integration-level roundtrip tests exist (`dek-credential-roundtrip.test.ts`, `kms-e2e-full-chain.test.ts`) but stop at Mongoose, not HTTP.                                                                 | High     | Open      |
| GAP-006 | Search index vectors (Qdrant) are not encrypted at the application layer                                                                                                                                                                                                          | Medium   | Open      |
| GAP-007 | `encryption.plugin.ts` uses `console.warn` instead of `createLogger` for logging                                                                                                                                                                                                  | Low      | Open      |
| GAP-008 | Cloud KMS providers lack integration tests against real cloud endpoints. Contract tests with mocked SDKs exist (`cloud-kms-provider-contracts.test.ts`, `dek-lifecycle-cloud-e2e.test.ts`, `kms-pool-cloud-integration.test.ts`) but no tests use real AWS/Azure/GCP credentials. | Medium   | Mitigated |
| GAP-009 | `ConnectorConnection` model has encryption managed by `ConnectionService` outside the plugin, not via `encryptionPlugin` — potential consistency gap. `credential-encryption.integration.test.ts` confirms connections are binding-only (no credential storage at this layer).    | Medium   | Mitigated |
| GAP-010 | `DeploymentVariableSnapshot` model stores raw ciphertext without `encryptionPlugin` — documented intentional behavior                                                                                                                                                             | Low      | Mitigated |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                       | Coverage Type | Status     | Test File / Note                                                         |
| --- | ---------------------------------------------- | ------------- | ---------- | ------------------------------------------------------------------------ |
| 1   | Core engine encrypt/decrypt roundtrip          | unit          | PASS       | `engine.test.ts` (shared + shared-encryption)                            |
| 2   | Engine edge cases and error handling           | unit          | PASS       | `engine-edge-cases.test.ts`                                              |
| 3   | Zstd fallback without native support           | unit          | PASS       | `engine-no-zstd.test.ts`                                                 |
| 4   | Cross-version compatibility proof              | unit          | PASS       | `cross-compat-proof.test.ts`                                             |
| 5   | Multi-key rotation and fallback                | unit          | PASS       | `multi-key.test.ts`                                                      |
| 6   | Tenant key cache LRU and eviction              | unit          | PASS       | `tenant-key-cache.test.ts`                                               |
| 7   | PBKDF2 and HKDF key derivation                 | unit          | PASS       | `key-derivation.test.ts`                                                 |
| 8   | Compress-then-encrypt (ClickHouse)             | unit          | PASS       | `compress-encrypt.test.ts`                                               |
| 9   | Contact PII encryption and blind indexing      | unit          | PASS       | `contact-encryption.test.ts`, `contact-encryptor.test.ts`                |
| 10  | Error constructors                             | unit          | PASS       | `errors.test.ts`                                                         |
| 11  | Singleton lifecycle                            | unit          | PASS       | `index-singleton.test.ts`                                                |
| 12  | Encryption availability check                  | unit          | PASS       | `is-encryption-available.test.ts`, `encryption-analyzer.test.ts`         |
| 13  | ClickHouse/Redis encryption manifest           | unit          | PASS       | `encryption-manifest.test.ts`                                            |
| 14  | Field interceptor with ENC:v3: prefix          | unit          | PASS       | `field-interceptor.test.ts`, `clickhouse-encryption-interceptor.test.ts` |
| 15  | BullMQ secure queue wrappers                   | unit          | PASS       | `secure-queue.test.ts`                                                   |
| 16  | Master key vault/env resolution                | unit          | PASS       | `master-key-resolver.test.ts`                                            |
| 17  | Mongoose plugin general tests                  | unit          | PASS       | `mongo-plugins.test.ts`, `encryption-plugin-dek.test.ts`                 |
| 18  | Encryption enable/disable toggle               | integration   | PASS       | `encryption-toggle-e2e.test.ts`                                          |
| 19  | DEK codec encode/decode                        | unit          | PASS       | `dek-codec.test.ts`                                                      |
| 20  | TenantEncryptionFacade encrypt/decrypt         | unit          | PASS       | `tenant-encryption-facade.test.ts`                                       |
| 21  | Encryption context (AsyncLocalStorage)         | unit          | PASS       | `encryption-context.test.ts`                                             |
| 22  | DEK credential roundtrip with real MongoDB     | integration   | PASS       | `dek-credential-roundtrip.test.ts`                                       |
| 23  | Full DEK chain (Manager -> Facade -> Plugin)   | integration   | PASS       | `dek-full-chain.test.ts`                                                 |
| 24  | Full KMS chain (Pool -> Resolver -> DEK -> DB) | integration   | PASS       | `kms-e2e-full-chain.test.ts`                                             |
| 25  | DEK lifecycle with cloud KMS simulation        | integration   | PASS       | `dek-lifecycle-cloud-e2e.test.ts`                                        |
| 26  | Cloud KMS provider contracts (mocked SDKs)     | unit          | PASS       | `cloud-kms-provider-contracts.test.ts`                                   |
| 27  | KMS provider pool caching and lifecycle        | unit          | PASS       | `kms-provider-pool.test.ts`, `kms-provider-pool-edge.test.ts`            |
| 28  | KMS resolver (materialized + fallback)         | unit          | PASS       | `kms-resolver.test.ts` (database + runtime)                              |
| 29  | Local KMS provider wrap/unwrap                 | unit          | PASS       | `local-kms-provider.test.ts`                                             |
| 30  | DEK facade factory init and wiring             | unit          | PASS       | `dek-facade-factory.test.ts`                                             |
| 31  | Multi-layer DEK cache (L1 + L2)                | unit          | PASS       | `dek-cache.test.ts`                                                      |
| 32  | DEK Manager acquire/unwrap/batch/rotate        | unit          | PASS       | `dek-manager.test.ts`                                                    |
| 33  | KMS admin CRUD routes                          | unit          | PASS       | `kms-admin-crud.test.ts`                                                 |
| 34  | KMS admin authorization enforcement            | unit          | PASS       | `kms-admin-authz.test.ts`                                                |
| 35  | Cross-tenant DEK isolation and security        | unit          | PASS       | `kms-security.test.ts`                                                   |
| 36  | KMS config materialization (5-level chain)     | unit          | PASS       | `kms-materializer.test.ts`                                               |
| 37  | KMS circuit breaker wrapper                    | unit          | PASS       | `kms-circuit-breaker.test.ts`                                            |
| 38  | KMS audit event logging                        | unit          | PASS       | `kms-audit-logger.test.ts`                                               |
| 39  | KMS key rotation job                           | unit          | PASS       | `kms-rotation-job.test.ts`                                               |
| 40  | Re-encryption queue enqueue and shutdown       | unit          | PASS       | `reencryption-queue.test.ts`                                             |
| 41  | Auth config encrypt/decrypt with KMS           | unit          | PASS       | `auth-config-encryption.test.ts`                                         |
| 42  | Encryption salt lifecycle (GDPR cascade)       | unit          | PASS       | `encryption-salt-lifecycle.test.ts`                                      |
| 43  | Per-tenant KMS multi-tenant integration        | integration   | PASS       | `kms-per-tenant-integration.test.ts`                                     |
| 44  | KMS pool cloud integration                     | integration   | PASS       | `kms-pool-cloud-integration.test.ts`                                     |
| 45  | Session field encryption (agent transfer)      | unit          | PASS       | `session-field-encryption.test.ts`                                       |
| 46  | Encrypted vault (compiler PIIVault)            | unit          | PASS       | `encrypted-vault.test.ts`                                                |
| 47  | Master key rotation grace period               | unit          | PASS       | `master-key-rotation-e2e.test.ts`                                        |
| 48  | HTTP API encryption roundtrip                  | e2e           | NOT TESTED | GAP-005                                                                  |

### Testing Notes

The encryption module has comprehensive test coverage with **48 test files** across 6 packages:

- **Unit tests**: 39 files covering core engine, DEK envelope encryption, KMS providers, admin routes, circuit breakers, audit logging, cache layers, and cross-tenant isolation
- **Integration tests**: 8 files covering DEK credential roundtrips with real MongoDB, full KMS chains with LocalKMSProvider, per-tenant KMS isolation, cloud KMS provider simulation, and encryption toggle
- **E2E tests**: 0 files — no tests exercise encryption through the full HTTP API layer

Key progress since last update:

- `packages/shared-encryption/` — new dedicated package with 4 test files (DEK codec, encryption context, facade, engine)
- `apps/runtime/src/services/kms/__tests__/` — 8 new KMS infrastructure tests (DEK cache, manager, resolver, materializer, circuit breaker, audit logger, rotation job, re-encryption queue)
- `packages/database/src/__tests__/` — 8 new DEK/KMS integration tests (credential roundtrip, full chain, cloud lifecycle, provider contracts)
- Cloud KMS provider contracts tested with mocked SDKs (GAP-008 partially mitigated)
- Re-encryption queue infrastructure tested (GAP-002 partially mitigated)

Remaining gaps:

- No E2E tests exercising encryption through the full HTTP API (create credential -> read credential -> verify encrypted in DB) — GAP-005
- No integration tests for cloud KMS providers against real AWS/Azure/GCP endpoints (only mocked SDK contracts)

> Full testing details: [../testing/encryption-at-rest.md](../testing/encryption-at-rest.md)

---

## 18. References

- KMS types and provider interface: `packages/database/src/kms/types.ts`
- Encryption manifest: `packages/shared/src/encryption/encryption-manifest.ts`
- KMS roundtrip script: `scripts/kms-encryption-roundtrip.ts`
- Security architecture: `docs/security/SECURITY.md`
