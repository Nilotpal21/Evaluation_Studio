# Feature: Key Management Service (KMS)

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: BETA
**Feature Area(s)**: `governance`, `enterprise`, `compliance`, `security`
**Package(s)**: `packages/database`, `packages/shared` (encryption), `packages/shared-encryption`, `packages/shared-auth` (scopes), `apps/runtime`, `apps/studio`
**Owner(s)**: `Platform Team`
**Testing Guide**: `../testing/kms.md`
**Design Decisions**: [`../specs/dek-encryption-design-decisions.md`](../specs/dek-encryption-design-decisions.md) (14 binding decisions for DEK implementation)
**Last Updated**: 2026-04-14

---

## 1. Introduction / Overview

### Problem Statement

Enterprise agent platforms handle sensitive data (LLM credentials, OAuth tokens, session histories, PII vaults, contact identities) that must be encrypted at rest and in transit. A single platform-wide master key creates compliance risk: no tenant isolation for encryption, no ability for regulated tenants to bring their own keys (BYOK), no key rotation without downtime, and no audit trail for cryptographic operations. Without a proper key hierarchy, meeting PCI DSS 3.6, HIPAA, FIPS 140-3, and SOC2 requirements is impossible.

### Goal Statement

Provide a multi-layered Key Management Service that supports a NIST SP 800-57 key hierarchy (PRK -> TKEK -> DEK), per-tenant KMS provider configuration with 5-level inheritance, epoch-scoped Data Encryption Keys with automatic rotation and lifecycle management, multi-cloud KMS provider support (local, AWS KMS, Azure Key Vault, Azure Managed HSM, GCP Cloud KMS, external/BYOP), and a comprehensive audit trail for all cryptographic operations.

### Summary

KMS is a cross-cutting encryption infrastructure feature spanning `packages/database` (KMS provider interface, provider implementations, Mongoose models, provider readiness), `packages/shared` (EncryptionService, key derivation, field interceptor, secure queue), `packages/shared-encryption` (DEK codec, tenant encryption facade, encryption registry, envelope format), `packages/shared-auth` (platform key scope registry, scope-to-permission expansion, ceiling checks), `apps/runtime` (resolver, DEK manager, cache, materializer, circuit breaker, rotation, audit, re-encryption, admin routes), and `apps/studio` (admin UI with KMS config, keys, audit, and health tabs; platform keys management) packages.

The system consists of:

1. A `KMSProvider` interface (`packages/database/src/kms/types.ts`) implemented by 6 provider types with an LRU provider pool (`kms-provider-pool.ts`) for connection reuse
2. A 5-level KMS config resolution chain (project+environment -> project default -> tenant environment -> tenant default -> platform default) with materialized pre-resolved configs for O(1) hot-path lookups
3. Per-scope DEK management with opaque `nanoid(16)` identifiers, 3-dimensional scope `(tenantId, projectId, environment)`, lifecycle states (active -> decrypt_only -> destroyed), epoch-based concurrent creation dedup, and L1 in-process LRU cache keyed by `dekId`
4. Circuit breaker protection for external KMS calls via `HybridCircuitBreakerRegistry`
5. Periodic rotation jobs for DEK epoch transitions and KEK age enforcement
6. BullMQ-based re-encryption queue for batch DEK re-wrapping after KEK rotation
7. ClickHouse-based audit logging with 3-year retention for PCI DSS compliance
8. A Studio admin UI (`KMSPage.tsx`, `KMSConfigForm.tsx`) for KMS configuration, key management, health monitoring, and audit log viewing

---

## 2. Scope

### Goals

- NIST SP 800-57 key hierarchy: Platform Root Key (PRK) -> Tenant KEK (TKEK) -> Data Encryption Key (DEK)
- 6 KMS provider types: local (in-process AES-256-GCM), aws-kms, azure-keyvault, azure-managed-hsm, gcp-cloud-kms, external (BYOP via HTTPS API)
- 5-level config inheritance: project+environment, project default, tenant environment, tenant default, platform default
- Materialized config for O(1) hot-path reads (no inheritance walk on encrypt/decrypt)
- Per-scope DEKs with opaque `nanoid(16)` identifiers, epoch-based dedup for concurrent creation (12h minimum granularity), configurable cryptoperiod (default 24h), max usage count (fire-and-forget `$inc`), and retention
- DEK cache with zero-fill on eviction: L1 in-process LRU (100 entries, 5min TTL) keyed by `dekId` (globally unique — no scope prefix needed)
- Circuit breaker for external KMS provider fault isolation
- Periodic rotation job: epoch transitions, DEK destruction, KEK age monitoring
- BullMQ re-encryption queue for batch DEK re-wrapping with deduplication
- ClickHouse audit logging with structured events and 3-year retention
- External KMS endpoint validation (HTTPS, health, round-trip wrap/unwrap, latency)
- Studio admin UI with 4 tabs: Configuration, Encryption Keys, Health, Audit
- BYOK/BYOP support (feature-gated behind `kms_byok`)

### Non-Goals (Out of Scope)

- Client-side encryption (all encryption happens server-side)
- Key escrow or multi-party key ceremonies
- HSM integration for the local provider (dev/test only)
- Cross-tenant key sharing or key federation
- Encryption key backup/restore UI (admin handles via cloud provider console)
- BYOK `importKeyMaterial` flow (interface exists in `KMSProvider` but no provider implements it)

---

## 3. User Stories

1. As a **platform admin**, I want to configure a tenant's KMS provider (local, AWS, Azure, GCP, or external) so that encryption uses the appropriate key management infrastructure.
2. As a **platform admin**, I want to override KMS config per project or environment so that production uses HSM-backed keys while staging uses software-protected keys.
3. As a **compliance officer**, I want all encryption key operations audit-logged with 3-year retention so that we can demonstrate PCI DSS 3.6 compliance.
4. As a **security engineer**, I want DEKs to automatically rotate on epoch boundaries (e.g., every 24 hours) so that cryptographic material has bounded exposure.
5. As a **platform admin**, I want to force-rotate keys and trigger re-encryption so that compromised keys are replaced without data loss.
6. As a **tenant admin**, I want to bring my own KMS provider (BYOP) with external endpoints so that encryption keys never leave our infrastructure.
7. As a **platform admin**, I want to validate external KMS endpoints before saving configuration so that misconfigured endpoints are caught early.
8. As an **operations engineer**, I want KMS health checks and circuit breakers so that external KMS failures are isolated and don't cascade to all tenants.
9. As a **developer**, I want a transparent encryption layer so that services call `encryptForTenant`/`decryptForTenant` without knowing which KMS provider backs the tenant.

---

## 4. Functional Requirements

1. **FR-1**: The system must support 6 KMS provider types: local (in-process AES-256-GCM via `LocalKMSProvider`), AWS KMS (`AWSKMSProvider`), Azure Key Vault (`AzureKeyVaultProvider`), Azure Managed HSM (`AzureManagedHSMProvider`), GCP Cloud KMS (`GCPCloudKMSProvider`), and external BYOP (`ExternalKMSProvider` via HTTPS API with 4 auth methods: api-key, oauth2, hmac-sha256, mtls).
2. **FR-2**: The system must resolve KMS config through a 5-level inheritance chain (`KMSResolver` in `apps/runtime/src/services/kms/kms-resolver.ts`) and materialize pre-resolved configs (`KMSMaterializer` in `kms-materializer.ts`) for O(1) lookups via `MaterializedKMSConfig.findOne({tenantId, projectId, environment})`.
3. **FR-3**: The system must manage epoch-scoped DEKs (`DEKManager` in `dek-manager.ts`) with lifecycle states: active (encrypt+decrypt), decrypt_only (past cryptoperiod), destroyed (zero-filled via `wrappedDek: ''`).
4. **FR-4**: The system must cache unwrapped DEKs in a multi-layer cache (`dek-cache.ts`): L1 in-process LRU (100 entries, 5min TTL, zero-fill on eviction), L2 Redis HASH (30min TTL, wrapped DEKs only — never plaintext in Redis).
5. **FR-5**: The system must wrap external KMS calls in a circuit breaker (`kms-circuit-breaker.ts`) using `HybridCircuitBreakerRegistry` with states CLOSED -> OPEN -> HALF_OPEN, scoped as `kms:<providerType>:<tenantId>`.
6. **FR-6**: The system must periodically (default 60min, `kms-rotation-job.ts`) transition expired DEKs to decrypt_only, destroy retained DEKs (zero wrappedDek), and check KEK rotation age.
7. **FR-7**: The system must support batch DEK re-encryption via BullMQ queue (`reencryption-queue.ts`) with deduplication (`reencrypt:${tenantId}:${reason}:${YYYY-MM-DD}`), progress tracking, and graceful shutdown.
8. **FR-8**: The system must audit-log all KMS operations to ClickHouse (`kms-audit-logger.ts`) with structured events and 3-year retention, falling back to structured application logs (`_audit: true` flag) when ClickHouse is unavailable.
9. **FR-9**: The system must validate external KMS endpoints (`external-kms-validator.ts`) for HTTPS enforcement, health check, round-trip wrap/unwrap correctness with ephemeral 32-byte key, and latency threshold (default 2000ms) before saving configuration.
10. **FR-10**: The system must provide a REST API (`apps/runtime/src/routes/kms-admin.ts`) for KMS config CRUD (GET/PUT `/config`), endpoint validation (POST `/validate`), DEK listing (GET `/keys`), force rotation (POST `/keys/rotate`), audit log querying (GET `/audit`), and health checks (GET `/health`), all gated by `authMiddleware -> tenantRateLimit -> requireFeature('kms_byok') -> requirePermission('kms:admin')`.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                    |
| -------------------------- | ------------ | ------------------------------------------------------------------------ |
| Project lifecycle          | SECONDARY    | DEKs scoped to project+environment, per-project KMS config overrides     |
| Agent lifecycle            | SECONDARY    | DEKs scoped to project+environment, used during agent execution          |
| Customer experience        | NONE         | Transparent to end users — impacts admin UX only                         |
| Integrations / channels    | SECONDARY    | Encryption of channel credentials, session data, tool secrets            |
| Observability / tracing    | SECONDARY    | KMS audit events in ClickHouse, circuit breaker metrics                  |
| Governance / controls      | PRIMARY      | Core encryption infrastructure for all sensitive data                    |
| Enterprise / compliance    | PRIMARY      | PCI DSS 3.6, HIPAA, FIPS 140-3, SOC2 compliance                          |
| Admin / operator workflows | PRIMARY      | Studio KMS admin UI, config management, health monitoring, audit viewing |

### Related Feature Integration Matrix

| Related Feature      | Relationship Type | Why It Matters                                                                                                                   | Key Touchpoints                                                              | Current State |
| -------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------- |
| Encryption at Rest   | extends           | KMS extends the base encryption-at-rest capability with multi-provider, per-tenant key management                                | `EncryptionService` (engine.ts), Mongoose encryption plugin                  | Implemented   |
| PII Detection        | depends on        | PIIVault encrypted persistence uses `EncryptionService` for AES-256-GCM                                                          | `packages/shared/src/encryption/engine.ts`                                   | Implemented   |
| Session Management   | shares data with  | Session conversation history encrypted via tenant-scoped keys                                                                    | Mongoose encryption plugin v3                                                | Implemented   |
| LLM Credentials      | depends on        | API keys encrypted at rest via Mongoose encryption plugin                                                                        | `packages/database/src/mongo/plugins/encryption.plugin.ts`                   | Implemented   |
| Tool Secrets         | depends on        | Tool secret values encrypted via Mongoose encryption plugin                                                                      | Same encryption plugin                                                       | Implemented   |
| Auth Profiles        | depends on        | OAuth client secrets encrypted via Mongoose encryption plugin                                                                    | Same encryption plugin                                                       | Implemented   |
| Contact Management   | depends on        | GDPR crypto-shredding uses HKDF-derived contact keys via `deriveContactKey(tenantId, contactSalt)`                               | `engine.ts` contact-scoped encryption                                        | Implemented   |
| ClickHouse Analytics | depends on        | Field-level encryption for messages.content, traces.data, events.data via `encryptFields`/`decryptFields` in `field-interceptor` | `packages/shared/src/encryption/field-interceptor.ts`                        | Implemented   |
| BullMQ Queues        | depends on        | Secure queue encryption for LLM requests and message persistence via `wrapJobDataForEncrypt`/`unwrapJobDataForDecrypt`           | `packages/shared/src/encryption/secure-queue.ts`                             | Implemented   |
| Circuit Breaker      | uses              | KMS wraps provider calls in `HybridCircuitBreakerRegistry` for fault isolation                                                   | `apps/runtime/src/services/kms/kms-circuit-breaker.ts`                       | Implemented   |
| Audit Logging        | emits into        | KMS audit events emitted to ClickHouse `kms_audit_log` table with 3-year retention                                               | `apps/runtime/src/services/kms/kms-audit-logger.ts`                          | Implemented   |
| Diagnostics          | tested with       | Encryption availability analyzer checks KMS health at runtime startup                                                            | `apps/runtime/src/services/diagnostics/analyzers/encryption-availability.ts` | Implemented   |
| Platform Keys        | extends           | Platform API keys use scope registry from shared-auth for RBAC-based access control                                              | `packages/shared-auth/src/scopes/`, `apps/studio/src/app/api/keys/`          | Implemented   |
| Shared Encryption    | extracted from    | Standalone encryption package with DEK codec, tenant facade, encryption registry, envelope format                                | `packages/shared-encryption/src/`                                            | Implemented   |

---

## 6. Design Considerations

### Key Hierarchy

```
Platform Root Key (PRK)
    |
    v
HKDF/PBKDF2 derivation per tenant (in packages/shared/src/encryption/engine.ts)
    |
    v
Tenant KEK (TKEK) -- or cloud KMS key (AWS/Azure/GCP)
    |
    v
Data Encryption Keys (DEKs) -- epoch-scoped, wrapped by TKEK (in dek_registry collection)
    |
    v
Application Data (AES-256-GCM with 96-bit IV)
```

### 5-Level Config Resolution (KMSResolver + KMSMaterializer)

```
1. projects[projectId].environments[environment]  (most specific)
2. projects[projectId].defaultProvider
3. environments[environment]                       (tenant level)
4. defaultProvider                                 (tenant level)
5. Platform default (local provider)               (least specific)
```

### DEK Lifecycle (managed by KMSRotationJob)

```
[active] --epoch expires--> [decrypt_only] --retention expires--> [destroyed]
                                                                     |
                                                            wrappedDek zeroed
                                                            (NIST SP 800-57)
```

### DEK Cache

```
L1: In-process LRU (100 entries, 5min TTL, zero-fill on eviction)
    Key: dekId (globally unique nanoid — no scope prefix needed)
    Value: unwrapped plaintext DEK
      |
      v (miss)
    MongoDB DEK Registry: findOne({ dekId }) — single-field unique index, O(1)
      |
      v (wrapped DEK found, needs unwrap)
    KMS Provider unwrapKey() — circuit breaker protected
      |
      v (unwrapped DEK cached in L1)
```

Note: Decrypt needs no scope — the opaque dekId is extracted from ciphertext and used as the sole lookup key (Decision 3).

---

## 7. Technical Considerations

- **Zero-fill**: All plaintext key material is zero-filled immediately after use (`Buffer.fill(0)`). L1 cache zero-fills on eviction. L2 cache stores only wrapped (encrypted) DEKs. Verified in `LocalKMSProvider.shutdown()` (line 68-83 of `local-kms-provider.ts`) and `DEKCache` eviction logic.
- **DEK identifiers**: Opaque `nanoid(16)` strings embedded in ciphertext wire format. Decrypt lookup is a single-field unique index on `dekId` — no scope needed for decryption. See [Design Decision 3](../specs/dek-encryption-design-decisions.md#decision-3-opaque-dek-id-nanoid).
- **Epoch calculation**: DEK epochs use `calculateEpoch(intervalHours)` producing strings like `"2026-03-25T12"` with 12-hour minimum granularity: `new Date(Math.floor(Date.now() / intervalMs) * intervalMs).toISOString().slice(0, 13)`. The epoch string is only used for dedup (unique index) and operational visibility — it is NOT embedded in ciphertext.
- **Deduplication**: DEK creation uses MongoDB unique index `{tenantId, projectId, environment, epoch}` with E11000 retry for concurrent requests. Without epoch, two pods could create two different nanoid DEKs for the same scope.
- **Usage count**: Fire-and-forget `$inc` on each encrypt — non-blocking, eventually consistent. `maxUsageCount` default is 2^30 (~1 billion), a safety ceiling not a precise threshold. See [Design Decision 6](../specs/dek-encryption-design-decisions.md#decision-6-usage-count--fire-and-forget-inc).
- **Circuit breaker**: Uses `HybridCircuitBreakerRegistry` with states CLOSED -> OPEN -> HALF_OPEN. Tenant-scoped breaker names: `kms:<providerType>:<tenantId>`.
- **Materialization**: Synchronous in the PUT/POST config handler — admin expects changes to take effect immediately. Config changes are rare, so latency on admin request is acceptable. See [Design Decision 11](../specs/dek-encryption-design-decisions.md#decision-11-materializer-trigger--sync-on-config-change). Stale configs detected at read time via `sourceConfigVersion` mismatch as safety net.
- **Redis pub/sub**: KMS config invalidation propagated across pods via Redis pub/sub `kms:invalidate` channel. Falls back to TTL expiry (60s) when Redis is unavailable.
- **BYOK/BYOP**: Feature-gated behind `kms_byok` feature flag via `requireFeature('kms_byok')` middleware.
- **ClickHouse fallback**: When ClickHouse is unavailable, audit events are emitted as structured log entries with `_audit: true` flag for log aggregator capture.
- **Dynamic imports**: Cloud KMS SDKs (`@aws-sdk/client-kms`, `@azure/keyvault-keys`, `@google-cloud/kms`) are loaded via dynamic `import()` to avoid bundling unused SDKs.
- **Provider pool**: `KMSProviderPool` caches provider instances keyed by config fingerprint (e.g., `aws-kms:<region>:<keyId>`), max 50, LRU eviction with local provider protected from eviction.
- **EncryptionService singleton**: `getEncryptionService()` in `packages/shared/src/encryption/index.ts` provides a global singleton reading `ENCRYPTION_MASTER_KEY` from env on first call.

---

## 8. How to Consume

### Project Runtime Config

KMS is configured per tenant via the admin API. The platform default provider is selected from environment configuration (`KMS_PROVIDER`, provider-specific `KMS_*` settings). If no cloud provider is configured, it falls back to the local provider backed by `ENCRYPTION_MASTER_KEY`.

### API (Runtime)

| Method | Path                                             | Purpose                                   |
| ------ | ------------------------------------------------ | ----------------------------------------- |
| GET    | `/api/tenants/:tenantId/kms/config`              | Get tenant KMS config                     |
| PUT    | `/api/tenants/:tenantId/kms/config`              | Update tenant-level KMS config            |
| PUT    | `.../kms/config/projects/:projectId`             | Set project-level KMS override            |
| PUT    | `.../kms/config/projects/:pid/environments/:env` | Set project+environment KMS override      |
| POST   | `/api/tenants/:tenantId/kms/validate`            | Validate external KMS endpoint            |
| GET    | `/api/tenants/:tenantId/kms/keys`                | List DEKs for tenant (with scope filter)  |
| POST   | `/api/tenants/:tenantId/kms/keys/rotate`         | Force-rotate DEKs (optional scope params) |
| GET    | `/api/tenants/:tenantId/kms/audit`               | Query KMS audit log                       |
| GET    | `/api/tenants/:tenantId/kms/health`              | KMS health for tenant                     |

Note: Separate endpoints per scope (Decision 10). Force rotation accepts optional `projectId`/`environment` — if provided, rotate that scope; if omitted, rotate all for tenant (Decision 8).

Source: `apps/runtime/src/routes/kms-admin.ts`

Middleware chain: `authMiddleware` -> `tenantRateLimit('request')` -> `requireFeature('kms_byok')` -> `requirePermission('kms:admin')`

### API (Studio)

| Method | Path                | Purpose                                                      |
| ------ | ------------------- | ------------------------------------------------------------ |
| GET    | `/api/admin/kms`    | Proxy to runtime KMS config/keys/audit/health (query-routed) |
| POST   | `/api/admin/kms`    | Proxy to runtime KMS validate/rotate                         |
| PUT    | `/api/admin/kms`    | Proxy to runtime KMS config update                           |
| GET    | `/api/keys`         | List platform API keys for the tenant                        |
| POST   | `/api/keys`         | Create a new platform API key with scopes                    |
| PATCH  | `/api/keys/[keyId]` | Update platform key (name, scopes, project access)           |
| DELETE | `/api/keys/[keyId]` | Revoke a platform API key                                    |
| GET    | `/api/keys/scopes`  | List available platform key scopes from the scope registry   |

Source: `apps/studio/src/app/api/admin/kms/route.ts`, `apps/studio/src/app/api/keys/route.ts`, `apps/studio/src/app/api/keys/[keyId]/route.ts`, `apps/studio/src/app/api/keys/scopes/route.ts`

### Admin Portal

Studio KMS admin page (`apps/studio/src/components/admin/KMSPage.tsx`) with 4 tabs, each in its own component:

1. **Configuration** (`KMSConfigForm.tsx`) — Provider type selection, provider-specific config fields, BYOK toggle
2. **Encryption Keys** (`KMSKeysTab.tsx`) — DEK listing with status/project/environment filters, summary statistics, force rotation
3. **Health** (inline in `KMSPage.tsx`) — Provider health status, active/decrypt_only DEK counts
4. **Audit** (`KMSAuditTab.tsx`) — ClickHouse audit log viewer with operation/time filters

Studio Platform Keys page (`apps/studio/src/components/settings/PlatformKeysTab.tsx`) — CRUD management of `abl_` API keys with scope-based access control. Scopes are fetched from the centralized scope registry in `packages/shared-auth`.

### Channel / SDK / Voice / A2A / MCP Integration

KMS is transparent to channels and SDKs. Encryption occurs at the data persistence layer (Mongoose plugin, ClickHouse interceptor, Redis queue wrapper) before data reaches any external integration point. No channel-specific KMS behavior.

---

## 9. Data Model

### Collections / Tables

```text
Collection: tenant_kms_configs (MongoDB)
Model: packages/database/src/models/tenant-kms-config.model.ts
Fields:
  - _id: string (UUIDv7)
  - tenantId: string (required, unique index)
  - defaultProvider: KMSProviderRef {providerType, keyId, region, vaultUrl, externalEndpoint, authMethod, authConfigEncrypted}
  - environments: [{environment, provider: KMSProviderRef, tier}]
  - projects: [{projectId, defaultProvider: KMSProviderRef | null, environments: [{...}]}]
  - dekEpochIntervalHours: number (default: 24)
  - dekMaxUsageCount: number (default: 2^30)
  - dekRetentionDays: number (default: 90)
  - kekRotationPeriodDays: number (default: 365)
  - reencryption: {enabled: boolean, concurrency: number, batchSize: number, maxRetries: number}
  - lastKekRotatedAt: Date | null
  - byokEnabled: boolean (default: false)
  - byopEnabled: boolean (default: false)
  - complianceLevel: enum (standard, pci-dss, hipaa, fips-140-3)
  - failurePolicy: enum (fail-closed, graceful-degradation)
  - _v: number (config version, incremented on update)
Plugins: tenantIsolationPlugin, auditTrailPlugin
Indexes:
  - { tenantId: 1 } (unique)

Collection: materialized_kms_configs (MongoDB)
Model: packages/database/src/models/materialized-kms-config.model.ts
Fields:
  - _id: string (UUIDv7)
  - tenantId: string (required)
  - projectId: string (required)
  - environment: string (required)
  - resolvedProvider: ResolvedProviderRef
  - resolvedTier: enum (hsm, software-protected, platform-shared, local, ephemeral)
  - resolvedKeyId: string
  - dekEpochIntervalHours, dekMaxUsageCount, dekRetentionDays, kekRotationPeriodDays: number
  - failurePolicy: enum (fail-closed, graceful-degradation)
  - sourceConfigVersion: number (tracks which TenantKMSConfig._v was materialized)
  - materializedAt: Date
Plugins: tenantIsolationPlugin
Indexes:
  - { tenantId: 1, projectId: 1, environment: 1 } (unique)
  - { tenantId: 1, sourceConfigVersion: 1 }

Collection: dek_registry (MongoDB)
Model: packages/database/src/models/dek-registry.model.ts
Fields:
  - _id: string (UUIDv7)
  - dekId: string (nanoid(16), globally unique, embedded in ciphertext wire format)
  - tenantId: string (required)
  - projectId: string (required — '_tenant' for tenant-scoped models)
  - environment: string (required — '_tenant' for tenant-scoped, '_shared' for project models without env)
  - epoch: string (e.g., "2026-03-25T12" — idempotency key for concurrent creation, 12h min granularity)
  - wrappedDek: string (base64 wrapped key material, zeroed on destroy)
  - kekKeyId: string
  - kekKeyVersion: number
  - status: enum (active, decrypt_only, destroyed)
  - usageCount: number (fire-and-forget $inc on each encrypt)
  - maxUsageCount: number (safety ceiling ~2^30, from TenantKMSConfig)
  - expiresAt: Date (precomputed epoch boundary + intervalMs for hot-path rotation check)
  - destroyedAt: Date | null
  - createdAt: Date
  - updatedAt: Date
Plugins: tenantIsolationPlugin
Indexes:
  - { dekId: 1 } (unique — decrypt lookup, O(1))
  - { tenantId: 1, projectId: 1, environment: 1, epoch: 1 } (unique — creation dedup)
  - { tenantId: 1, projectId: 1, environment: 1, status: 1 } (find active DEK)
  - { status: 1 } (rotation job queries)
  - { kekKeyId: 1, status: 1 } (re-encryption queries)
Note: See Design Decision 3 (opaque nanoid) and Decision 4 (epoch for dedup) in dek-encryption-design-decisions.md

Table: abl_platform.kms_audit_log (ClickHouse)
Written by: apps/runtime/src/services/kms/kms-audit-logger.ts
Fields:
  - tenant_id: String
  - timestamp: DateTime64(3)
  - event_id: String (UUID)
  - operation: String
  - key_id: String
  - key_version: UInt32
  - key_purpose: String
  - provider_type: String
  - project_id: String
  - environment: String
  - epoch: String
  - actor_id: String
  - actor_type: String (system|user)
  - actor_ip: String
  - success: UInt8
  - error_message: String
  - latency_ms: UInt32
  - metadata: String (JSON)
Retention: 3 years (ClickHouse TTL)
```

### Key Relationships

- `tenant_kms_configs.tenantId` -> tenant identity (source of truth for KMS config)
- `materialized_kms_configs.sourceConfigVersion` -> `tenant_kms_configs._v` (stale detection)
- `dek_registry.kekKeyId` -> KMS provider key used for wrapping (links DEKs to their KEK)
- `kms_audit_log.tenant_id` -> tenant, `key_id` -> DEK or KEK identifier

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                             | Purpose                                                              |
| ---------------------------------------------------------------- | -------------------------------------------------------------------- |
| `packages/database/src/kms/types.ts`                             | KMSProvider interface, NIST key types, result types (166 LOC)        |
| `packages/database/src/kms/local-kms-provider.ts`                | Local in-process AES-256-GCM provider (312 LOC)                      |
| `packages/database/src/kms/kms-provider-pool.ts`                 | LRU-cached provider pool (max 50, fingerprint, health check)         |
| `packages/database/src/kms/kms-registry.ts`                      | Singleton registry for platform KMS provider + pool                  |
| `packages/database/src/kms/providers/index.ts`                   | Provider factory with dynamic imports for 6 types                    |
| `packages/database/src/kms/providers/aws-kms-provider.ts`        | AWS KMS provider (dynamic `@aws-sdk/client-kms`)                     |
| `packages/database/src/kms/providers/azure-keyvault-provider.ts` | Azure Key Vault provider (dynamic `@azure/keyvault-keys`)            |
| `packages/database/src/kms/providers/gcp-cloud-kms-provider.ts`  | GCP Cloud KMS provider (dynamic `@google-cloud/kms`)                 |
| `packages/database/src/kms/providers/external-kms-provider.ts`   | External BYOP provider (HTTPS + 4 auth methods, 426 LOC)             |
| `packages/shared/src/encryption/engine.ts`                       | EncryptionService: AES-256-GCM, tenant/user/contact scoping          |
| `packages/shared/src/encryption/index.ts`                        | Singleton factory, `getEncryptionService()`, `isEncryptionAvailable` |
| `packages/shared/src/encryption/master-key-resolver.ts`          | Vault-first master key resolution                                    |
| `packages/shared/src/encryption/field-interceptor.ts`            | ClickHouse/Redis field-level encryption                              |
| `packages/shared/src/encryption/secure-queue.ts`                 | BullMQ job data encryption wrapper                                   |
| `packages/shared/src/encryption/key-derivation/hkdf.ts`          | HKDF key derivation strategy (SHA-256)                               |
| `packages/shared/src/encryption/key-derivation/pbkdf2.ts`        | PBKDF2 key derivation strategy (100K iterations, legacy compat)      |
| `packages/shared/src/encryption/cache/tenant-key-cache.ts`       | LRU cache for derived tenant keys                                    |

### Shared Encryption Package (`packages/shared-encryption/src/`)

| File                          | Purpose                                                   |
| ----------------------------- | --------------------------------------------------------- |
| `dek-codec.ts`                | DEK wire-format encode/decode (header + ciphertext)       |
| `tenant-encryption-facade.ts` | Single interface for tenant-scoped envelope encryption    |
| `encryption-registry.ts`      | Registry of encryption-capable models and field manifests |
| `envelope-format.ts`          | DEK envelope format detection (`isDEKEnvelopeFormat`)     |
| `facade-accessor.ts`          | Global accessor for TenantEncryptionFacade singleton      |
| `engine.ts`                   | Core AES-256-GCM encryption engine                        |
| `encryption-manifest.ts`      | Field encryption manifest definitions                     |
| `encryption-context.ts`       | Encryption context (AAD) for tenant binding               |
| `field-interceptor.ts`        | ClickHouse/Redis field-level encryption                   |
| `secure-queue.ts`             | BullMQ job data encryption wrapper                        |
| `master-key-resolver.ts`      | Vault-first master key resolution                         |
| `constants.ts`                | Crypto constants (algorithm, IV size, auth tag length)    |

### Shared Auth Scopes (`packages/shared-auth/src/scopes/`)

| File                     | Purpose                                                                    |
| ------------------------ | -------------------------------------------------------------------------- |
| `platform-key-scopes.ts` | Scope registry: 10 scopes across 4 categories with RBAC permission mapping |
| `scope-validation.ts`    | Ceiling check, scope-to-permission expansion, registry validation          |
| `index.ts`               | Re-exports for `@agent-platform/shared-auth`                               |

### Routes / Handlers

| File                                                 | Purpose                                                |
| ---------------------------------------------------- | ------------------------------------------------------ |
| `apps/runtime/src/routes/kms-admin.ts`               | REST API for KMS admin operations (7 endpoints)        |
| `apps/studio/src/app/api/admin/kms/route.ts`         | Studio proxy to runtime KMS API with tenant auth       |
| `apps/studio/src/app/api/keys/route.ts`              | Platform key CRUD (list, create)                       |
| `apps/studio/src/app/api/keys/[keyId]/route.ts`      | Platform key update and revoke                         |
| `apps/studio/src/app/api/keys/scopes/route.ts`       | Scope registry API (list available scopes)             |
| `apps/studio/src/app/api/keys/platform-key-utils.ts` | Key generation, hashing, Zod schemas, scope validation |

### UI Components

| File                                                      | Purpose                                                 |
| --------------------------------------------------------- | ------------------------------------------------------- |
| `apps/studio/src/components/admin/KMSPage.tsx`            | Studio admin KMS page (4 tabs) with health tab inline   |
| `apps/studio/src/components/admin/KMSConfigForm.tsx`      | KMS configuration form component                        |
| `apps/studio/src/components/admin/KMSKeysTab.tsx`         | DEK listing with filters, summary stats, force rotation |
| `apps/studio/src/components/admin/KMSAuditTab.tsx`        | Audit log viewer with operation/time filters            |
| `apps/studio/src/components/settings/PlatformKeysTab.tsx` | Platform API key CRUD with scope-based access control   |
| `apps/studio/src/hooks/useKMS.ts`                         | React hook for KMS API interactions                     |

### Jobs / Workers / Background Processes

| File                                                  | Purpose                                                         |
| ----------------------------------------------------- | --------------------------------------------------------------- |
| `apps/runtime/src/services/kms/kms-rotation-job.ts`   | Periodic job: epoch transitions, DEK destruction, KEK age check |
| `apps/runtime/src/services/kms/reencryption-queue.ts` | BullMQ queue for batch DEK re-wrapping                          |

### Services

| File                                                        | Purpose                                                        |
| ----------------------------------------------------------- | -------------------------------------------------------------- |
| `apps/runtime/src/services/kms/kms-resolver.ts`             | 5-level config resolution with L1 cache (500 entries, 60s TTL) |
| `apps/runtime/src/services/kms/dek-manager.ts`              | DEK lifecycle: acquire, unwrap, batch, force-rotate            |
| `apps/runtime/src/services/kms/dek-cache.ts`                | Multi-layer DEK cache (L1 LRU + L2 Redis)                      |
| `apps/runtime/src/services/kms/kms-materializer.ts`         | Materialize 5-level inheritance into pre-resolved configs      |
| `apps/runtime/src/services/kms/kms-circuit-breaker.ts`      | Circuit breaker wrapper for KMS provider calls                 |
| `apps/runtime/src/services/kms/kms-audit-logger.ts`         | Fire-and-forget ClickHouse audit logging with fallback         |
| `apps/runtime/src/services/kms/external-kms-validator.ts`   | Validate external KMS endpoints (HTTPS, health, round-trip)    |
| `apps/studio/src/services/security/key-rotation-service.ts` | Studio-side key rotation service                               |
| `packages/database/src/kms/provider-readiness.ts`           | Crypto-verified readiness check (health + wrap/unwrap probe)   |

### Tests

| File                                                                  | Type        | Coverage Focus                                     |
| --------------------------------------------------------------------- | ----------- | -------------------------------------------------- |
| `apps/runtime/src/services/kms/__tests__/dek-cache.test.ts`           | unit        | L1 TTL, eviction, zero-fill; L2 Redis; MultiLayer  |
| `apps/runtime/src/services/kms/__tests__/kms-resolver.test.ts`        | unit        | L1 cache, MaterializedKMSConfig lookup, fallback   |
| `apps/runtime/src/services/kms/__tests__/dek-manager.test.ts`         | unit        | Epoch calc, acquire, unwrap, batch, E11000 retry   |
| `apps/runtime/src/services/kms/__tests__/kms-materializer.test.ts`    | unit        | 5-level walk, upsert, stale cleanup, reconcileAll  |
| `apps/runtime/src/services/kms/__tests__/kms-circuit-breaker.test.ts` | unit        | CLOSED/OPEN, success/failure recording             |
| `apps/runtime/src/services/kms/__tests__/kms-rotation-job.test.ts`    | unit        | Epoch transition, DEK destruction, KEK age         |
| `apps/runtime/src/services/kms/__tests__/kms-audit-logger.test.ts`    | unit        | ClickHouse write, batch, fallback                  |
| `apps/runtime/src/services/kms/__tests__/reencryption-queue.test.ts`  | unit        | Enqueue, deduplication, shutdown                   |
| `packages/database/src/__tests__/kms-provider-pool.test.ts`           | unit        | LRU eviction, health check, fingerprint            |
| `packages/database/src/__tests__/kms-provider-pool-edge.test.ts`      | unit        | Initialize, max size, concurrent access            |
| `packages/database/src/__tests__/kms-providers.test.ts`               | unit        | Provider factory, correct type creation            |
| `packages/database/src/__tests__/local-kms-provider.test.ts`          | unit        | Local provider encrypt/decrypt round-trip          |
| `packages/database/src/__tests__/encryption-plugin-kms.test.ts`       | integration | Mongoose plugin v1->v2 migration, KMS availability |
| `packages/database/src/__tests__/encryption-e2e.test.ts`              | integration | Full encryption round-trip with MongoMemoryServer  |
| `packages/database/src/__tests__/encryption-integration.test.ts`      | integration | Encryption plugin integration with real MongoDB    |
| `packages/database/src/__tests__/dek-lifecycle-cloud-e2e.test.ts`     | integration | Full DEK lifecycle with mocked cloud KMS providers |
| `packages/database/src/__tests__/provider-readiness.test.ts`          | unit        | Provider readiness verification (health + crypto)  |
| `apps/runtime/src/__tests__/kms-admin-authz.test.ts`                  | unit        | Authorization enforcement on KMS admin routes      |
| `apps/runtime/src/__tests__/kms-admin-crud.test.ts`                   | unit        | CRUD business logic on KMS admin routes            |
| `apps/runtime/src/__tests__/kms-security.test.ts`                     | unit        | KMS security scenarios                             |
| `packages/shared-auth/src/__tests__/platform-key-scopes.test.ts`      | unit        | Scope registry, ceiling check, expansion, grouping |
| `apps/studio/src/__tests__/platform-keys-api.e2e.test.ts`             | e2e         | Platform key API E2E through Studio routes         |
| `apps/studio/src/__tests__/platform-keys-api.test.ts`                 | integration | Platform key API integration tests                 |
| `apps/studio/src/__tests__/platform-keys-unit.test.ts`                | unit        | Platform key utilities and validation              |
| `packages/shared/src/__tests__/encryption/engine.test.ts`             | unit        | EncryptionService encrypt/decrypt                  |
| `packages/shared/src/__tests__/encryption/engine-edge-cases.test.ts`  | unit        | Edge cases in encryption engine                    |
| `packages/shared/src/__tests__/encryption/multi-key.test.ts`          | unit        | Multi-key rotation fallback                        |
| `packages/shared/src/__tests__/encryption/contact-encryption.test.ts` | unit        | Contact-scoped GDPR crypto-shredding               |
| `packages/shared/src/__tests__/encryption/compress-encrypt.test.ts`   | unit        | Compress-then-encrypt (zstd)                       |
| `packages/shared/src/__tests__/encryption/cross-compat-proof.test.ts` | unit        | Cross-version compatibility                        |
| `packages/shared/src/encryption/__tests__/field-interceptor.test.ts`  | unit        | ClickHouse field-level encryption                  |
| `packages/shared/src/encryption/__tests__/secure-queue.test.ts`       | unit        | BullMQ job data encryption                         |
| `scripts/kms-encryption-roundtrip.ts`                                 | script      | Manual round-trip validation script                |

---

## 11. Configuration

### Environment Variables

| Variable                         | Required | Default | Notes                                                     |
| -------------------------------- | -------- | ------- | --------------------------------------------------------- |
| `ENCRYPTION_MASTER_KEY`          | Yes      | -       | 64-char hex (256-bit AES key). Vault-sourced recommended. |
| `KMS_REENCRYPTION_QUEUE_ENABLED` | No       | `true`  | Disable re-encryption BullMQ queue                        |
| `ENCRYPTION_ENABLED`             | No       | `true`  | Set `false` to disable encryption entirely (dev only)     |

### Runtime Configuration

- **Tenant KMS Config** (MongoDB `tenant_kms_configs`):
  - `dekEpochIntervalHours` (default: 24) — DEK cryptoperiod window
  - `dekMaxUsageCount` (default: 2^30) — max encryptions per DEK
  - `dekRetentionDays` (default: 90) — retention for decrypt_only DEKs before destruction
  - `kekRotationPeriodDays` (default: 365) — KEK age threshold for triggering re-encryption
  - `failurePolicy` (default: fail-closed) — behavior on KMS provider failure
  - `complianceLevel` (default: standard) — compliance tier (standard, pci-dss, hipaa, fips-140-3)
  - `byokEnabled`, `byopEnabled` — per-tenant BYOK/BYOP flags
- **Feature gate**: `kms_byok` — requires ENTERPRISE tier or deal-level feature flag
- **Provider pool**: max 50 providers, 30min idle timeout, 5min health check interval

### DSL / Agent IR / Schema

KMS is infrastructure-level and not directly configurable in the ABL DSL or Agent IR. It operates at the platform/tenant/project level via the admin API.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement                                                                                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant isolation  | KMS config is per-tenant (`tenantId` unique index). DEKs scoped to `{tenantId, projectId, environment}`. Provider pool keyed by config fingerprint (not tenant). |
| Project isolation | 5-level inheritance allows per-project override. Materialized configs are per-(tenant, project, environment). DEKs are per-scope.                                |
| User isolation    | N/A — KMS operates at admin level; user-scoped encryption uses EncryptionService's `encrypt(plaintext, userId)` with PBKDF2 per-user derivation.                 |

### Security & Compliance

- AES-256-GCM with 96-bit IV (NIST SP 800-38D) — constants in `packages/shared/src/encryption/constants.ts`
- Zero-fill all plaintext key material immediately after use (verified in `LocalKMSProvider.shutdown()`, `DEKCacheL1` eviction)
- L2 Redis cache stores only wrapped (encrypted) DEKs — never plaintext
- External KMS endpoints require HTTPS with TLS 1.2+ (enforced in `ExternalKMSProvider.validateConfig()`)
- PCI DSS 3.6 compliance via 3-year ClickHouse audit trail
- NIST SP 800-57 key lifecycle: active -> decrypt_only -> destroyed
- BYOK/BYOP support for regulated tenants (feature-gated behind `kms_byok`)
- Double encryption detection via `isAlreadyEncrypted()` guard in encryption registry
- Auth config stored encrypted (`authConfigEncrypted`) in KMS provider refs
- External KMS requests enforce 10s timeout, 64KB max response (`ExternalKMSProvider`)
- HMAC-SHA256 signature with nonce+timestamp for external BYOP auth
- Header injection prevention via `sanitizeHeaderValue()` removing CR/LF/NUL

### Performance & Scalability

- L1 cache: 100 entries, 5min TTL, sub-microsecond DEK retrieval (in-process Map)
- L2 Redis cache: 30min TTL, avoids MongoDB read on cache hit
- Materialized configs: O(1) indexed lookup via `{tenantId, projectId, environment}` unique index
- Provider pool: max 50, LRU eviction, 5min health check interval
- KMS resolver L1 cache: 500 entries, 60s TTL, Redis pub/sub invalidation across pods
- Rotation job: setInterval with `unref()`, runs on all pods (idempotent via MongoDB atomic updates)
- Re-encryption: BullMQ with configurable concurrency (default 1), batch size (default 50)
- Derived key cache: `TenantKeyCache` LRU (default 1000 entries, 30min TTL) in EncryptionService
- Local provider derived key cache: max 100 entries with LRU eviction and zero-fill

### Reliability & Failure Modes

- Circuit breaker isolates external KMS failures (CLOSED -> OPEN -> HALF_OPEN)
- Audit logging is fire-and-forget — failures never block encrypt/decrypt operations
- Materialization failures are detected at read time via `sourceConfigVersion` mismatch (but no auto-retry — GAP-006)
- Re-encryption queue supports retry with exponential backoff (3 attempts, 5s base, via BullMQ)
- Rotation job failures are logged but never crash the process
- ClickHouse unavailability degrades to structured log audit trail (`_audit: true`)
- Redis unavailability: KMS config propagation delayed up to 60s (TTL fallback); L2 DEK cache returns null gracefully
- DEK creation handles concurrent requests via E11000 duplicate key retry (reads existing on conflict)

### Observability

- KMS audit events to ClickHouse with structured operation, key, actor, latency metadata
- ClickHouse fallback: structured log with `_audit: true` flag for log aggregator capture
- Circuit breaker persistence failure metric via `recordCBPersistenceFailure('kms', ...)`
- Materializer logs: scope count, upserted count, stale deleted, duration
- Rotation job logs: transitioned count, destroyed count, re-encryption jobs queued
- Provider pool health check logging on unhealthy eviction
- Encryption availability diagnostic analyzer at startup

### Data Lifecycle

- DEK cryptoperiod: configurable (default 24h), after which DEK transitions to decrypt_only
- DEK retention: configurable (default 90 days), after which decrypt_only DEKs are destroyed (wrappedDek zeroed)
- KEK rotation period: configurable (default 365 days), triggers batch DEK re-wrapping
- ClickHouse audit log: 3-year TTL retention via ClickHouse TTL clause
- Re-encryption job retention: BullMQ `removeOnComplete: 500`, `removeOnFail: 200`

---

## 13. Delivery Plan / Work Breakdown

1. **Provider Layer** (`packages/database/src/kms/`)
   1.1 KMS Provider interface + types (`types.ts`) -- DONE
   1.2 Local KMS provider (`local-kms-provider.ts`) -- DONE
   1.3 Cloud KMS providers (AWS, Azure x2, GCP) -- DONE (code exists, no integration tests)
   1.4 External KMS provider (BYOP) -- DONE
   1.5 Provider pool + registry -- DONE

2. **Database Models** (`packages/database/src/models/`)
   2.1 TenantKMSConfig model -- DONE
   2.2 MaterializedKMSConfig model -- DONE
   2.3 DEKEntry model -- DONE

3. **Shared Encryption** (`packages/shared/src/encryption/`)
   3.1 EncryptionService engine (AES-256-GCM, multi-scope) -- DONE
   3.2 Key derivation (HKDF, PBKDF2) -- DONE
   3.3 Tenant key cache -- DONE
   3.4 Encryption registry + manifest -- DONE
   3.5 Field interceptor + secure queue -- DONE
   3.6 Master key resolver -- DONE

4. **Runtime Services** (`apps/runtime/src/services/kms/`)
   4.1 KMS resolver (5-level chain + L1 cache) -- DONE
   4.2 DEK manager + cache -- DONE
   4.3 KMS materializer -- DONE
   4.4 Circuit breaker wrapper -- DONE
   4.5 Rotation job -- DONE
   4.6 Re-encryption queue -- DONE
   4.7 Audit logger -- DONE
   4.8 External KMS validator -- DONE

5. **Admin API** (`apps/runtime/src/routes/`)
   5.1 KMS admin routes (7 endpoints) -- DONE
   5.2 Zod request body validation -- NOT DONE (GAP-008)

6. **Studio UI** (`apps/studio/src/`)
   6.1 KMS admin page (4 tabs) -- DONE
   6.2 KMS config form -- DONE
   6.3 useKMS hook -- DONE

7. **Platform Keys Scope Architecture** (`packages/shared-auth/src/scopes/`)
   7.1 Scope registry (10 scopes, 4 categories, RBAC mappings) -- DONE (ABLP-315)
   7.2 Creation-time ceiling check (`checkScopeCeiling`) -- DONE (ABLP-315)
   7.3 Scope-to-permission expansion (`expandScopesToPermissions`) -- DONE (ABLP-315)
   7.4 Registry validation (`validateRegistryScopes`) -- DONE (ABLP-315)
   7.5 Scope API route (`/api/keys/scopes`) -- DONE (ABLP-315)
   7.6 Studio PlatformKeysTab scope-aware UI -- DONE (ABLP-315)
   7.7 RBAC middleware scope enforcement in runtime -- DONE (ABLP-315)

8. **Shared Encryption Package** (`packages/shared-encryption/`)
   8.1 DEK codec (wire-format encode/decode) -- DONE
   8.2 Tenant encryption facade -- DONE
   8.3 Encryption registry and manifest -- DONE
   8.4 Envelope format detection -- DONE
   8.5 AAD tenant binding in encryption context -- DONE

9. **KMS Hardening** (PR #671)
   9.1 Provider readiness verification (health + crypto probe) -- DONE
   9.2 Cloud provider DEK lifecycle E2E test (AWS/Azure/GCP mocked) -- DONE
   9.3 Studio KMS UI refactored into separate tab components -- DONE
   9.4 Studio KMS admin proxy API route -- DONE
   9.5 DEK status normalization tool (`tools/normalize-kms-dek-status.ts`) -- DONE

10. **Testing Gaps** (remaining work)
    10.1 Cloud KMS provider integration tests against real APIs -- NOT DONE
    10.2 KMS admin API E2E through full runtime middleware chain -- NOT DONE
    10.3 External KMS validator unit tests -- NOT DONE
    10.4 Re-encryption worker E2E -- NOT DONE
    10.5 Studio KMS UI Playwright tests -- NOT DONE
    10.6 Scope-route enforcement E2E (platform key -> runtime route) -- NOT DONE

---

## 14. Success Metrics

| Metric                      | Baseline | Target   | How Measured                                                |
| --------------------------- | -------- | -------- | ----------------------------------------------------------- |
| Encrypt/decrypt latency     | <5ms     | <2ms     | P99 via ClickHouse kms_audit_log latency_ms                 |
| DEK cache hit rate (L1)     | N/A      | >90%     | Custom metric from DEKCacheL1 hit/miss counts               |
| Config resolution latency   | N/A      | <1ms     | KMS resolver L1 cache hit rate + MongoDB query time on miss |
| Key rotation downtime       | N/A      | 0s       | Epoch-based rotation is seamless (no decrypt gap)           |
| Audit log capture rate      | N/A      | >99.9%   | ClickHouse insert success + fallback log count              |
| Circuit breaker activations | N/A      | <1/day   | Circuit breaker state change logs per tenant                |
| Re-encryption throughput    | N/A      | >100/min | BullMQ job progress tracking for batch DEK re-wrapping      |

---

## 15. Open Questions

1. Should the platform provide a managed KEK rotation workflow (admin triggers rotation -> batch re-wrap -> verify -> commit) or continue with the current automatic age-based trigger?
2. What is the expected cardinality of DEKs per tenant? With 24h epochs across N projects x M environments, large tenants could accumulate millions of DEK records. Is there a need for a DEK archival strategy beyond the current retention+destroy lifecycle?
3. Should the external KMS validator run periodic health checks (not just pre-save validation) to detect external endpoint degradation proactively?
4. Should the ClickHouse `kms_audit_log` table DDL be managed by a migration system rather than assumed to exist (GAP-007)?
5. How should the platform handle the case where a tenant's external KMS provider becomes permanently unreachable? The current circuit breaker isolates the failure, but there is no admin notification or automatic fallback to local encryption.

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                             | Severity | Status    |
| ------- | ------------------------------------------------------------------------------------------------------- | -------- | --------- |
| GAP-001 | Cloud KMS providers (AWS, Azure, GCP) have no integration tests against real cloud APIs                 | High     | Mitigated |
| GAP-002 | KMS admin routes lack Zod request body validation — only minimal `typeof` check                         | Medium   | Open      |
| GAP-003 | KMS resolver uses `globalThis` for cross-module singleton sharing (`(globalThis as any).__kmsResolver`) | Medium   | Known     |
| GAP-004 | No automatic re-materialization on stale config detection at read time                                  | Medium   | Open      |
| GAP-005 | External KMS validator not independently tested                                                         | Medium   | Open      |
| GAP-006 | Re-encryption worker process logic not tested E2E                                                       | Medium   | Open      |
| GAP-007 | ClickHouse `kms_audit_log` table DDL not managed by migrations                                          | Low      | Open      |
| GAP-008 | BYOK `importKeyMaterial` flow not implemented (interface exists, no provider implements)                | Low      | Open      |
| GAP-009 | DEK `usageCount` tracking not wired into encrypt path — RESOLVED: fire-and-forget `$inc` (Decision 6)   | Low      | Resolved  |
| GAP-010 | No Playwright E2E tests for Studio KMS admin UI                                                         | Medium   | Open      |
| GAP-011 | Scope-route enforcement E2E not yet tested (platform key scopes -> runtime API access)                  | Medium   | Open      |

**GAP-001 Mitigation**: `dek-lifecycle-cloud-e2e.test.ts` exercises the full DEK lifecycle through mocked AWS/Azure/GCP cloud SDKs with real AES-256-GCM crypto at the SDK boundary. This covers the DEK creation, reuse, rotation, backward compatibility, and cross-provider migration paths. Real cloud API integration tests remain absent.

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                               | Coverage Type | Status     | Test File                                               |
| --- | ------------------------------------------------------ | ------------- | ---------- | ------------------------------------------------------- |
| 1   | DEK cache L1 (TTL, eviction, zero-fill)                | unit          | PASS       | `runtime/.../kms/__tests__/dek-cache.test.ts`           |
| 2   | DEK cache L2 (Redis, graceful degradation)             | unit          | PASS       | same                                                    |
| 3   | KMS resolver (L1 cache, fallback, eviction)            | unit          | PASS       | `runtime/.../kms/__tests__/kms-resolver.test.ts`        |
| 4   | DEK manager (epoch, acquire, unwrap, batch, rotate)    | unit          | PASS       | `runtime/.../kms/__tests__/dek-manager.test.ts`         |
| 5   | KMS materializer (5-level walk, upsert, stale cleanup) | unit          | PASS       | `runtime/.../kms/__tests__/kms-materializer.test.ts`    |
| 6   | KMS circuit breaker (open/closed, success/failure)     | unit          | PASS       | `runtime/.../kms/__tests__/kms-circuit-breaker.test.ts` |
| 7   | KMS rotation job (epoch transitions, destruction)      | unit          | PASS       | `runtime/.../kms/__tests__/kms-rotation-job.test.ts`    |
| 8   | KMS audit logger (ClickHouse, fallback)                | unit          | PASS       | `runtime/.../kms/__tests__/kms-audit-logger.test.ts`    |
| 9   | Re-encryption queue (enqueue, deduplication, shutdown) | unit          | PASS       | `runtime/.../kms/__tests__/reencryption-queue.test.ts`  |
| 10  | KMS provider pool (LRU, health check, eviction)        | unit          | PASS       | `database/.../kms-provider-pool.test.ts`                |
| 11  | KMS provider factory                                   | unit          | PASS       | `database/.../kms-providers.test.ts`                    |
| 12  | KMS admin authz (permission matrix)                    | unit          | PASS       | `runtime/.../kms-admin-authz.test.ts`                   |
| 13  | KMS admin CRUD (business logic)                        | unit          | PASS       | `runtime/.../kms-admin-crud.test.ts`                    |
| 14  | EncryptionService (encrypt/decrypt round-trip)         | unit          | PASS       | `shared/.../encryption/engine.test.ts`                  |
| 15  | Contact encryption (GDPR crypto-shred)                 | unit          | PASS       | `shared/.../encryption/contact-encryption.test.ts`      |
| 16  | Compress-then-encrypt (zstd)                           | unit          | PASS       | `shared/.../encryption/compress-encrypt.test.ts`        |
| 17  | Cloud KMS DEK lifecycle (mocked SDK, real crypto)      | integration   | PASS       | `database/.../dek-lifecycle-cloud-e2e.test.ts`          |
| 18  | Provider readiness verification                        | unit          | PASS       | `database/.../provider-readiness.test.ts`               |
| 19  | Platform key scope registry and ceiling check          | unit          | PASS       | `shared-auth/.../platform-key-scopes.test.ts`           |
| 20  | Platform key API (Studio routes)                       | e2e           | PASS       | `studio/.../platform-keys-api.e2e.test.ts`              |
| 21  | Platform key API (integration)                         | integration   | PASS       | `studio/.../platform-keys-api.test.ts`                  |
| 22  | Platform key utilities (unit)                          | unit          | PASS       | `studio/.../platform-keys-unit.test.ts`                 |
| 23  | Cloud KMS provider real API integration tests          | integration   | NOT TESTED | -                                                       |
| 24  | KMS admin API E2E (full runtime middleware chain)      | e2e           | NOT TESTED | -                                                       |
| 25  | External KMS validator                                 | unit          | NOT TESTED | -                                                       |
| 26  | Re-encryption worker E2E                               | integration   | NOT TESTED | -                                                       |
| 27  | Studio KMS UI (Playwright)                             | e2e           | NOT TESTED | -                                                       |
| 28  | Scope-route enforcement E2E                            | e2e           | NOT TESTED | -                                                       |

### Testing Notes

KMS has comprehensive unit test coverage across all 9 runtime service modules, 4+ database-level provider/pool/readiness modules, the admin route authz and CRUD logic, the shared EncryptionService, and the platform key scope architecture. Since the last update (2026-03-22), the following test coverage was added:

- **Cloud KMS DEK lifecycle** (`dek-lifecycle-cloud-e2e.test.ts`): Full encrypt-decrypt roundtrip through mocked AWS/Azure/GCP cloud SDKs with real AES-256-GCM crypto, including DEK creation, reuse, force rotation, backward compatibility, and cross-provider migration.
- **Provider readiness** (`provider-readiness.test.ts`): Verifies both health check and crypto wrap/unwrap probe for migration safety.
- **Platform key scope architecture** (`platform-key-scopes.test.ts`): Scope registry completeness, category grouping, ceiling check (OWNER/ADMIN/VIEWER), scope-to-permission expansion, unknown scope handling.
- **Platform key API E2E** (`platform-keys-api.e2e.test.ts`): Full Studio API E2E through real routes for key CRUD, scope validation, revocation.
- **Platform key API integration** (`platform-keys-api.test.ts`): Integration tests for key creation, listing, update, and deletion flows.

Remaining gaps: (1) no real cloud API integration tests, (2) no E2E for runtime KMS admin endpoints through full middleware chain, (3) no external KMS validator tests, (4) no Studio KMS UI Playwright tests, (5) no scope-route enforcement E2E.

> Full testing details: `../testing/kms.md`

---

## 18. References

- DEK Design Decisions: `docs/specs/dek-encryption-design-decisions.md` (14 binding decisions)
- DEK Feature Spec: `docs/features/dek-envelope-encryption.md`
- DEK HLD: `docs/specs/dek-envelope-encryption.hld.md`
- NIST SP 800-57: Key Management Recommendations
- NIST SP 800-38D: AES-GCM
- PCI DSS 3.6: Cryptographic Key Management
- Architecture doc: `docs/architecture/encryption-architecture.md`
- Enterprise KMS design: `docs/archive/plans-2026-03-early/2026-03-07-enterprise-kms-encryption-design.md`
- Enterprise KMS impl plan: `docs/archive/plans-2026-03-early/2026-03-07-enterprise-kms-implementation.md`
- KMS provider types: `packages/database/src/kms/types.ts`
- Encryption registry: `packages/shared/src/encryption/index.ts`
- Security doc: `docs/security/SECURITY.md`
