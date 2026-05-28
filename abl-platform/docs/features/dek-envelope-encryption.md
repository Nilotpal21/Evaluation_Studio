# Feature: DEK Envelope Encryption

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A (supersedes [Encryption at Rest](encryption-at-rest.md) v3 implementation)
**Status**: BETA (production-ready for local KMS; cloud KMS needs staging validation)
**Feature Area(s)**: `enterprise`, `governance`, `security`
**Package(s)**: `packages/shared-encryption`, `packages/database`, `apps/runtime`, `apps/search-ai`, `apps/search-ai-runtime`, `apps/studio`
**Owner(s)**: Platform team
**Testing Guide**: [../testing/dek-envelope-encryption.md](../testing/dek-envelope-encryption.md)
**Design Decisions**: [../specs/dek-encryption-design-decisions.md](../specs/dek-encryption-design-decisions.md)
**Last Updated**: 2026-03-26

---

## 1. Introduction / Overview

### Problem Statement

The platform currently uses v3 encryption (PBKDF2-derived tenant keys from a shared master key). This architecture has fundamental limitations that block enterprise compliance and operational security:

1. **No key rotation without full re-encryption** — rotating the master key requires re-encrypting ALL data across ALL tenants.
2. **No per-tenant key isolation** — all tenant keys are deterministically derived from the same master key. Compromising the master key exposes every tenant immediately.
3. **No per-project/environment isolation** — projects within a tenant share the same derived key. A staging environment uses the same key as production.
4. **No crypto-shredding** — tenant keys are re-derivable from the master key, so deleting a tenant's data requires finding and deleting every record across every store.
5. **No BYOK (Bring Your Own Key)** — impossible without a full rewrite.
6. **Fails compliance audits** — SOC 2 Type II, HIPAA, PCI-DSS, and ISO 27001 A.10 all require envelope encryption with key lifecycle management.

### Goal Statement

Replace all v3 encryption paths with per-scope DEK + KMS envelope encryption. DEKs are scoped to `(tenantId, projectId, environment)` — each project in each environment can use a different KMS provider and has independent DEKs. Maintain backward-compatible reads for existing v3-encrypted data during migration.

### Summary

DEK-based encryption uses a 2-layer envelope architecture:

1. **KMS provider** (local, AWS KMS, Azure Key Vault, Azure Managed HSM, GCP Cloud KMS, or external) wraps a random DEK per scope.
2. **The DEK** encrypts data. Each DEK is identified by an opaque `nanoid(16)` string embedded in the ciphertext.

**Wire format**: `base64(idLen[1] + dekId[N] + iv[12] + authTag[16] + ciphertext[...])`

**DEK scope**: `(tenantId, projectId, environment)` — each unique combination has its own set of DEKs and can use a different KMS provider via the 5-level config inheritance chain.

**Encryption plugin scope model** (hybrid doc-fields + AsyncLocalStorage):

- `tenantId` and `projectId` are read from the document being encrypted (explicit, debuggable)
- `environment` is read from the document if the model has the field, otherwise from AsyncLocalStorage (set by middleware or BullMQ worker), otherwise defaults to `'_shared'`
- Each model declares a scope level at plugin registration: `tenant` (tenantId only) or `project` (tenantId + projectId + environment)

**Decrypt path**: Extract opaque `dekId` from ciphertext → single-field unique index lookup → unwrap DEK → decrypt. No scope needed for decryption — dekId is globally unique.

The DEK infrastructure is built: DEKManager, KMSProviderPool, 6 providers, DEKCache, KMSResolver, rotation jobs, admin API. This feature covers:

- Fixing critical bugs from PR #505 review
- Restoring 3-dimensional DEK scope `(tenant, project, environment)`
- Restoring epoch-based rotation with configurable time + usage limits
- Wiring the Mongoose encryption plugin with per-model scope declarations
- Threading project/environment through all encryption call sites

---

## 2. Scope

### Goals

- Fix all critical/high bugs from PR #505 review (cross-tenant DEK leakage, duplicate format detection, auth fallback, sync decrypt, double-encryption guard)
- Restore `DEKScope = { tenantId, projectId, environment }` across DEK registry, DEKManager, cache, facade
- Restore 5-level KMS config inheritance: project+env → project default → tenant env → tenant default → platform default
- Restore KMS Materializer for pre-resolved O(1) config lookups
- Implement opaque `nanoid(16)` DEK identifiers (globally unique, no parsing)
- Implement epoch-based rotation: `dekEpochIntervalHours` (12h minimum) + `dekMaxUsageCount` per tenant
- Implement hybrid encryption plugin scope: per-model scope declaration + doc fields + AsyncLocalStorage for environment
- Implement `'_shared'` default environment for models without environment context
- Implement `AsyncLocalStorage`-based encryption context for environment propagation
- Implement separate admin API endpoints for project/environment KMS config overrides
- Implement fire-and-forget usage count increment
- Wire `TenantEncryptionFacade` into all encryption layers with scope params
- Maintain backward-compatible v3 reads via `isLegacyFormat()` detection

### Non-Goals (Out of Scope)

- Contact PII encryption (HKDF chain) — different threat model, stays unchanged
- Blind indexing (HMAC-SHA256) — deterministic hash, unaffected by DEK changes
- Building new KMS providers — all 6 already exist
- ClickHouse ETL migration of old rows — old data keeps minimal legacy decrypt until TTL expires
- A2A additions in server.ts — separate PR
- Studio UI changes bundled in current branch — separate PR
- Platform-level encryption scope — KMS resolver handles platform fallback internally

---

## 3. User Stories

1. As a **platform operator**, I want to deploy DEK-based encryption so that new writes use envelope encryption with per-scope DEKs, while existing v3-encrypted data remains readable.
2. As a **security engineer**, I want each project+environment combination to have independent DEKs so that a key compromise in staging does not affect production data.
3. As a **compliance officer**, I want envelope encryption with key rotation and crypto-shredding so that the platform passes SOC 2 / HIPAA / PCI-DSS audits.
4. As an **enterprise customer**, I want to configure my own KMS provider (AWS, Azure, GCP) per project and environment so that production uses HSM-backed keys while development uses local keys.
5. As a **developer**, I want encryption to remain transparent via the Mongoose plugin so that no application code changes are needed — the plugin reads scope from document fields and async context.
6. As an **operator**, I want to rotate the KMS wrapping key in minutes (re-wrap DEKs) without touching any encrypted data.
7. As an **operator**, I want tenant crypto-shredding by deleting DEK records so that a tenant's data becomes irrecoverable.
8. As an **operator**, I want configurable DEK rotation intervals per tenant (time-based and usage-based) so that high-security tenants can rotate more frequently.
9. As an **operator**, I want to force-rotate DEKs for a specific project+environment scope or for an entire tenant in case of key compromise.

---

## 4. Functional Requirements

1. **FR-1**: DEKs must be scoped to `(tenantId, projectId, environment)`. Each scope has independent DEKs and can use a different KMS provider.
2. **FR-2**: DEK identifiers must be opaque `nanoid(16)` strings, globally unique. The dekId is embedded in ciphertext for decrypt lookup via single-field unique index.
3. **FR-3**: The DEK registry must use `epoch` (time-based string, 12h minimum granularity) as an idempotency key for concurrent DEK creation across pods.
4. **FR-4**: DEK rotation must be driven by `expiresAt` (precomputed epoch boundary) and `maxUsageCount` (fire-and-forget `$inc`), both configurable per tenant via `TenantKMSConfig`.
5. **FR-5**: The Mongoose encryption plugin must support per-model scope declaration: `scope: 'tenant'` (tenantId only) or `scope: 'project'` (tenantId + projectId + environment).
6. **FR-6**: The plugin must read `tenantId` and `projectId` from document fields (explicit). Environment must be read from the document field if configured, else from AsyncLocalStorage, else default to `'_shared'`.
7. **FR-7**: Decryption must not require scope — opaque dekId lookup only. This applies to both async and sync decrypt paths.
8. **FR-8**: The system must detect legacy v3 formats on read and decrypt them using the PBKDF2 path during migration.
9. **FR-9**: KMS config must support 5-level inheritance: project+env override → project default → tenant env override → tenant default → platform default. Resolution must be pre-materialized for O(1) hot-path lookups.
10. **FR-10**: Materialization must happen synchronously on config change (in the PUT/POST admin handler).
11. **FR-11**: Admin API must provide separate endpoints for managing project-level and environment-level KMS config overrides.
12. **FR-12**: `forceRotateDEK` must accept optional `projectId`/`environment` params — if provided, rotate that scope; if omitted, rotate all DEKs for the tenant.
13. **FR-13**: Decryption failure must return the encrypted value as-is with a warning log (not throw, not return null).
14. **FR-14**: Per-tenant auth config decrypt failure in `resolveAuthConfig` must fail-closed (throw), not silently fall back to platform env vars.
15. **FR-15**: `isDEKEnvelopeFormat` must exist in exactly one location — `legacy-format-detection.ts` — with no duplicates.
16. **FR-16**: `_lastAcquiredDekId` must be scoped per `(tenantId, projectId, environment)` — not a shared singleton.
17. **FR-17**: The `insertMany` facade path must include the `rejectIfAlreadyEncrypted` double-encryption guard.
18. **FR-18**: DEK facade initialization must be extracted into a shared factory (`initDEKFacade`) to eliminate duplication across 4 server entry points.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                               |
| -------------------------- | ------------ | ----------------------------------------------------------------------------------- |
| Project lifecycle          | PRIMARY      | Encryption is now project+environment scoped — DEKs are per-project                 |
| Agent lifecycle            | SECONDARY    | Agent credentials (LLM keys, tool secrets) encrypted via project-scoped DEK         |
| Customer experience        | NONE         | Transparent — no user-facing changes                                                |
| Integrations / channels    | SECONDARY    | Channel connection credentials encrypted via project-scoped DEK                     |
| Observability / tracing    | SECONDARY    | KMS audit logging tracks DEK operations per scope                                   |
| Governance / controls      | PRIMARY      | Core compliance upgrade — envelope encryption, per-scope key rotation               |
| Enterprise / compliance    | PRIMARY      | Enables SOC 2, HIPAA, PCI-DSS, GDPR Art 17 compliance                               |
| Admin / operator workflows | PRIMARY      | KMS config per project/environment, key rotation, force rotation, health monitoring |

### Related Feature Integration Matrix

| Related Feature                                   | Relationship Type | Why It Matters                                                               | Key Touchpoints                  | Current State |
| ------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------- | -------------------------------- | ------------- |
| [Encryption at Rest](encryption-at-rest.md)       | supersedes        | This replaces the v3 implementation                                          | All encryption layers            | BETA          |
| [KMS (Key Management)](kms.md)                    | depends on        | DEKManager, KMSProviderPool, KMSResolver, Materializer are the foundation    | `apps/runtime/src/services/kms/` | BETA          |
| [Model Hub](model-hub.md)                         | depends on        | LLM credentials encrypted via Mongoose plugin                                | `llm-credential.model.ts`        | STABLE        |
| [Auth Profiles](auth-profiles.md)                 | depends on        | OAuth secrets encrypted via Mongoose plugin                                  | `auth-profile.model.ts`          | STABLE        |
| [Environment Variables](environment-variables.md) | depends on        | Env var values encrypted via Mongoose plugin — has environment on doc        | `environment-variable.model.ts`  | ALPHA         |
| [Session Management](memory-sessions.md)          | depends on        | Session state encrypted via project-scoped DEK with environment from context | `session-state.model.ts`         | STABLE        |
| [Channels](channels.md)                           | depends on        | Channel connection credentials encrypted via project-scoped DEK              | `channel-connection.model.ts`    | TBD           |

---

## 6. Design Considerations

N/A — Backend-only feature. No UI components.

---

## 7. Technical Considerations

### Encryption Plugin Scope Model

The Mongoose encryption plugin uses a **hybrid approach** for determining DEK scope:

**Per-model scope declaration** at plugin registration:

```typescript
// Tenant-scoped model (no projectId):
schema.plugin(encryptionPlugin, {
  fieldsToEncrypt: ['encryptedKey'],
  scope: 'tenant',
  scopeFields: { tenantId: 'tenantId' },
});

// Project-scoped model with environment on doc:
schema.plugin(encryptionPlugin, {
  fieldsToEncrypt: ['encryptedValue'],
  scope: 'project',
  scopeFields: { tenantId: 'tenantId', projectId: 'projectId', environment: 'environment' },
});

// Project-scoped model without environment on doc:
schema.plugin(encryptionPlugin, {
  fieldsToEncrypt: ['content'],
  scope: 'project',
  scopeFields: { tenantId: 'tenantId', projectId: 'projectId' },
  // environment from AsyncLocalStorage, falls back to '_shared'
});
```

**Environment resolution order** (for project-scoped models):

1. `scopeFields.environment` configured and field exists on doc → use doc value
2. Else → read from `AsyncLocalStorage` (set by middleware or BullMQ worker)
3. Else → `'_shared'`

**Fail-closed validation**: If scope is `project` and `tenantId` or `projectId` is missing on the document → throw with model name in error.

### Encrypted Models by Scope Level

| Scope Level | Models                                                                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenant`    | LLMCredential, WebhookSubscription, EndUserOAuthToken, TenantServiceInstance, Organization, OrgProxyConfig, ArchWorkspaceConfig, User                    |
| `project`   | SessionState, SDKChannel, EnvironmentVariable\*, ServiceNode, ChannelConnection, ToolSecret, Message, SessionOAuthArtifact, MCPServerConfig, AuthProfile |

\*EnvironmentVariable has `environment` on the document; all others use AsyncLocalStorage or `'_shared'` default.

### AsyncLocalStorage for Environment

```typescript
// packages/shared-encryption/src/encryption-context.ts
import { AsyncLocalStorage } from 'node:async_hooks';

export interface EncryptionContext {
  environment: string | null;
}

export const encryptionContext = new AsyncLocalStorage<EncryptionContext>();
```

**Set by**:

- Express middleware (two-layer): global sets `{ environment: null }`, project routes override with deployment environment
- BullMQ workers: wrap handler in `encryptionContext.run({ environment: job.data.environment })`

### DEK Registry Schema

```typescript
{
  dekId: string,          // nanoid(16), globally unique, embedded in ciphertext
  tenantId: string,       // required
  projectId: string,      // required
  environment: string,    // required
  epoch: string,          // "2026-03-25T12" — idempotency key for concurrent creation
  status: 'active' | 'decrypt_only' | 'destroyed',
  wrappedDek: string,     // encrypted DEK material
  kekKeyId: string,
  kekKeyVersion: number,
  usageCount: number,
  maxUsageCount: number,
  expiresAt: Date,        // precomputed epoch boundary
  destroyedAt: Date | null,
  createdAt: Date,
  updatedAt: Date,
}
```

**Indexes**:

- `{ dekId: 1 }` unique — decrypt lookup (single-field, fastest possible)
- `{ tenantId: 1, projectId: 1, environment: 1, epoch: 1 }` partial unique (`{ status: 'active' }`) — creation dedup (only constrains active DEKs; after rotation, same epoch can have new active DEK)
- `{ tenantId: 1, projectId: 1, environment: 1, status: 1 }` — find active DEK
- `{ status: 1 }` — rotation job
- `{ kekKeyId: 1, status: 1 }` — re-encryption queries

### Opaque DEK IDs

DEK identifiers are `nanoid(16)` strings (e.g., `"V1StGXR8_Z5jdHi6"`). They carry no semantic meaning — epoch, rotation sequence, and scope are stored as separate database fields. This design:

- Eliminates scope from the decrypt path entirely (dekId is globally unique)
- Removes regex queries and string parsing from the hot path
- Simplifies the cache key to just `dekId` (no scope prefix needed)
- Enables cross-project reads if ever needed (dekId lookup is scope-free)

### `'_shared'` Environment Default

Models without environment context (channel connections, SDK channels, tool secrets, MCP configs, service nodes, auth profiles) use `'_shared'` as the environment value. This provides:

- Clean migration path when these models become environment-specific in future deployment snapshots
- No re-encryption needed for reads (opaque dekId means old `'_shared'` ciphertext decrypts from any context)
- Active migration via re-encryption queue when models gain environment fields
- Plugin config change only (add `environment` to `scopeFields`) — no plugin logic change

### Performance

- **Cache hit encrypt/decrypt**: <0.1ms overhead (1x AES-GCM)
- **Cache miss**: MongoDB read + KMS unwrap ~10-20ms (faster than PBKDF2 ~50-100ms)
- **Ciphertext size**: base64 1.33x expansion (smaller than hex 2x)
- **Usage count**: Fire-and-forget `$inc` — zero latency impact on encrypt hot path
- **Decrypt lookup**: Single-field unique index on `dekId` — sub-millisecond
- **DEK cache**: L1 in-process LRU (100 entries, 5min TTL, zero-fill eviction). Key is just `dekId`.

---

## 8. How to Consume

### Studio UI

N/A — Encryption is transparent. Studio passes plaintext to API; encryption happens server-side.

### API (Runtime)

No direct encryption API changes. Encryption is applied transparently by:

- **Mongoose plugin** on save/read for all 18 encrypted models (with per-model scope)
- **Direct call sites** via `encryptForTenantAuto(plaintext, tenantId, projectId?, environment?)` / `decryptForTenantAuto(encrypted, tenantId, projectId?, environment?)`

### KMS Admin API

| Method | Path                                                            | Purpose                                         |
| ------ | --------------------------------------------------------------- | ----------------------------------------------- |
| GET    | `/api/kms/config`                                               | Read tenant KMS config                          |
| PUT    | `/api/kms/config`                                               | Update tenant-level KMS config                  |
| PUT    | `/api/kms/config/projects/:projectId`                           | Set project-level KMS override                  |
| PUT    | `/api/kms/config/projects/:projectId/environments/:environment` | Set project+environment KMS override            |
| GET    | `/api/kms/health`                                               | KMS health check                                |
| GET    | `/api/kms/keys`                                                 | List DEK entries                                |
| POST   | `/api/kms/keys/rotate`                                          | Force rotation (optional projectId/environment) |
| GET    | `/api/kms/audit`                                                | Audit log                                       |

---

## 9. Data Model

### DEK Registry (updated)

```text
Collection: dek_registry
Fields:
  - dekId: string (nanoid(16), globally unique)
  - tenantId: string (required)
  - projectId: string (required)
  - environment: string (required)
  - epoch: string (e.g., '2026-03-25T12', idempotency key)
  - wrappedDek: string (base64-encoded wrapped DEK)
  - kekKeyId: string
  - kekKeyVersion: number
  - status: 'active' | 'decrypt_only' | 'destroyed'
  - usageCount: number
  - maxUsageCount: number
  - expiresAt: Date (precomputed epoch boundary)
  - destroyedAt: Date | null
  - createdAt: Date
  - updatedAt: Date
Indexes:
  - { dekId: 1 } unique
  - { tenantId: 1, projectId: 1, environment: 1, epoch: 1 } partial unique (status: 'active')
  - { tenantId: 1, projectId: 1, environment: 1, status: 1 }
  - { status: 1 }
  - { kekKeyId: 1, status: 1 }
```

### TenantKMSConfig (updated)

```text
Collection: tenant_kms_configs
Fields (additions):
  - environments: IKMSEnvironmentOverride[] (per-environment provider overrides)
  - projects: IKMSProjectOverride[] (per-project provider and environment overrides)
  - dekEpochIntervalHours: number (default: 24, minimum: 12)
  - dekMaxUsageCount: number (default: 2^30)
```

### MaterializedKMSConfig (restored)

```text
Collection: materialized_kms_configs
Purpose: Pre-resolved KMS config per (tenantId, projectId, environment) — O(1) hot-path reads
Fields:
  - tenantId: string
  - projectId: string
  - environment: string
  - resolvedProvider: IResolvedProviderRef
  - resolvedTier: string
  - resolvedKeyId: string
  - dekEpochIntervalHours: number
  - dekMaxUsageCount: number
  - failurePolicy: string
  - sourceConfigVersion: number
Indexes:
  - { tenantId: 1, projectId: 1, environment: 1 } unique
```

### Key Relationships

```
TenantKMSConfig (1) ──── per-tenant KMS settings with project/env overrides
       │
       ▼ (materialized by KMSMaterializer on config change)
MaterializedKMSConfig (N) ──── pre-resolved per (tenant, project, environment)
       │
       ▼ (read by KMSResolver.resolve())
DEKEntry (N) ──── per-scope DEKs in dek_registry
       │
       ▼ (dekId embedded in ciphertext)
All 18 Mongoose models ──── encrypted fields use scope-specific DEK
```

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                         | Purpose                                                                 |
| ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `packages/shared-encryption/src/dek-codec.ts`                | Wire format: encrypt/decrypt with DEK + dekId header                    |
| `packages/shared-encryption/src/tenant-encryption-facade.ts` | Single interface for all encryption paths                               |
| `packages/shared-encryption/src/encryption-context.ts`       | **NEW** — AsyncLocalStorage for environment                             |
| `packages/shared-encryption/src/legacy-format-detection.ts`  | Single source for `isDEKEnvelopeFormat` + `isLegacyFormat`              |
| `packages/shared-encryption/src/engine.ts`                   | Sync encrypt/decrypt with scope params                                  |
| `packages/shared-encryption/src/index.ts`                    | Async `encryptForTenantAuto` / `decryptForTenantAuto` with scope params |
| `packages/database/src/kms/dek-manager.ts`                   | DEK lifecycle: acquire (with nanoid), unwrap, rotate                    |
| `packages/database/src/kms/kms-resolver.ts`                  | 3-dimensional resolve(tenantId, projectId, environment)                 |
| `packages/database/src/kms/kms-provider-pool.ts`             | Multi-provider KMS pool with fail-closed auth                           |
| `packages/database/src/kms/dek-facade-factory.ts`            | **NEW** — Shared facade initialization helper                           |

### Mongoose Plugin

| File                                                       | Purpose                                                                      |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `packages/database/src/mongo/plugins/encryption.plugin.ts` | Per-model scope declaration + doc-field + AsyncLocalStorage scope resolution |

### Models

| File                                                            | Purpose                                                |
| --------------------------------------------------------------- | ------------------------------------------------------ |
| `packages/database/src/models/dek-registry.model.ts`            | DEK registry with dekId, projectId, environment, epoch |
| `packages/database/src/models/tenant-kms-config.model.ts`       | Tenant config with project/environment overrides       |
| `packages/database/src/models/materialized-kms-config.model.ts` | Pre-resolved config per scope                          |

### Runtime Services

| File                                                  | Purpose                                  |
| ----------------------------------------------------- | ---------------------------------------- |
| `apps/runtime/src/services/kms/kms-materializer.ts`   | 5-level config inheritance resolver      |
| `apps/runtime/src/services/kms/kms-rotation-job.ts`   | Time + usage based DEK rotation          |
| `apps/runtime/src/services/kms/reencryption-queue.ts` | Batch DEK re-wrapping after KEK rotation |
| `apps/runtime/src/services/kms/kms-audit-logger.ts`   | ClickHouse audit logging                 |

### Routes / Handlers

| File                                   | Purpose                                      |
| -------------------------------------- | -------------------------------------------- |
| `apps/runtime/src/routes/kms-admin.ts` | Admin API with project/environment endpoints |
| `apps/runtime/src/server.ts`           | Facade init + encryption context middleware  |

---

## 11. Configuration

### Environment Variables

| Variable                | Default    | Description                                                       |
| ----------------------- | ---------- | ----------------------------------------------------------------- |
| `ENCRYPTION_MASTER_KEY` | (required) | 64-character hex string — used by LocalKMSProvider to derive KEKs |
| `ENCRYPTION_ENABLED`    | `true`     | Set to `false` to disable encryption (dev/test only)              |

### Runtime Configuration (per-tenant via TenantKMSConfig)

| Config                                  | Default | Description                                  |
| --------------------------------------- | ------- | -------------------------------------------- |
| `defaultProvider.providerType`          | `local` | KMS provider type                            |
| `dekEpochIntervalHours`                 | `24`    | DEK auto-rotation interval (12h minimum)     |
| `dekMaxUsageCount`                      | `2^30`  | Max encryptions per DEK before rotation      |
| `dekRetentionDays`                      | `90`    | DEK retention before destruction eligibility |
| `projects[].projectId`                  | —       | Project-level KMS override                   |
| `projects[].environments[].environment` | —       | Project+environment KMS override             |
| `environments[].environment`            | —       | Tenant-level environment KMS override        |

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern               | Requirement / Expectation                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant isolation      | Every tenant has unique random DEKs, not derivable from other tenants' DEKs. Cross-tenant decryption is cryptographically impossible. |
| Project isolation     | Each project within a tenant has independent DEKs. Project A's DEK cannot decrypt project B's data.                                   |
| Environment isolation | Each environment (dev/staging/production) has independent DEKs. A staging DEK cannot decrypt production data.                         |
| `_shared` environment | Models without environment context use `'_shared'` environment — isolated from named environments.                                    |

### Security & Compliance

- **Envelope encryption**: KMS provider wraps DEK. Data never touches the master key directly.
- **Key rotation**: Re-wrap DEKs with new KEK version in minutes. Data untouched.
- **Time-based rotation**: `expiresAt` drives automatic DEK rotation at epoch boundaries.
- **Usage-based rotation**: `maxUsageCount` triggers rotation when usage ceiling is reached.
- **Crypto-shredding**: Delete DEK records from `dek_registry` → all data for that scope becomes irrecoverable.
- **BYOK**: Per-project+environment KMS provider config via admin API.
- **FIPS 140-3**: Azure Managed HSM and AWS CloudHSM providers support Level 3.
- **Fail-closed**: Per-tenant auth config decrypt failure throws (not silent fallback to platform).
- **Double-encryption guard**: `rejectIfAlreadyEncrypted` in all encrypt paths including `insertMany`.
- **Decryption failure**: Returns encrypted value with warning log (preserves data, enables retry).

### Performance & Scalability

- **Encrypt hot path**: acquireDEK → check expiresAt → AES-GCM encrypt → fire-and-forget $inc usageCount
- **Decrypt hot path**: extract dekId from ciphertext → L1 cache lookup → AES-GCM decrypt (no scope resolution needed)
- **DEK cache**: L1 in-process LRU (100 entries, 5min TTL, zero-fill eviction). Key is `dekId` only.
- **KMS config cache**: L1 LRU (500 entries, 60s TTL) keyed by `(tenantId, projectId, environment)`.
- **Concurrent DEK creation**: Epoch-based idempotency key prevents duplicate DEKs across pods.

### Reliability & Failure Modes

- **Decrypt failure**: Return encrypted value as-is + warning log. Never throw on decrypt failure.
- **Auth config failure**: Fail-closed — throw if per-tenant auth config can't be decrypted.
- **KMS unavailable**: Circuit breaker per-provider per-tenant.
- **Cold cache sync decrypt**: Detect DEK envelope format, throw clear error directing caller to async path.
- **Missing encryption context**: Plugin throws with model name if required scope fields are missing.

### Observability

- KMS audit logging (ClickHouse): all DEK operations with scope, dekId, action
- DEK cache hit/miss rates
- Usage count tracking per DEK
- Rotation job metrics (expired transitions, usage transitions)
- Warning logs for decrypt failures with model, field, tenantId, dekId

---

## 13. Delivery Plan / Work Breakdown

See [implementation plan](../plans/2026-03-24-dek-envelope-encryption-impl-plan.md) for detailed phased tasks.

**Phases**:

1. **Phase A: Critical Bug Fixes** — Cross-tenant fix, format unification, auth hardening, sync decrypt, double-encrypt guard
2. **Phase B: Epoch + Rotation Restoration** — Time + usage DEK rotation with configurable per-tenant settings
3. **Phase C: Scope Restoration** — 3-dimensional DEKScope, KMS resolver, materializer, facade, admin API, caller threading
4. **Phase D: Infrastructure** — AsyncLocalStorage context, plugin scope model, shared facade factory, validation, caching, docs

---

## 14. Success Metrics

| Metric                      | Target                               | How Measured                                                   |
| --------------------------- | ------------------------------------ | -------------------------------------------------------------- |
| Cross-tenant DEK isolation  | 0 cross-tenant decrypt possible      | Unit test: encrypt with scope A, fail decrypt with scope B     |
| Cross-project DEK isolation | 0 cross-project decrypt possible     | Unit test: encrypt with project A, fail decrypt with project B |
| Environment DEK isolation   | 0 cross-environment decrypt possible | Unit test: encrypt with production, fail decrypt with staging  |
| Decrypt failure rate        | < 0.01%                              | Warning log monitoring                                         |
| Cache hit rate              | >95%                                 | DEK cache hit rate metric                                      |
| Encrypt latency (cache hit) | < 1ms                                | Benchmark                                                      |
| Decrypt latency (cache hit) | < 1ms                                | Benchmark                                                      |
| DEK rotation time           | < 1s per scope                       | Rotation job timing                                            |
| KEK rotation time           | Minutes (re-wrap only)               | Re-encryption job timing                                       |

---

## 15. Open Questions

1. **ClickHouse legacy reads**: Keep minimal deprecated decrypt function until data TTL expires.
2. **Migration tooling**: Bulk re-encryption worker for v3→DEK migration — planned as separate phase.
3. **Redis session store**: Currently always v3 — DEK path deferred.

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                                                                                                                                                 | Severity | Status   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------- |
| GAP-001 | ClickHouse immutable rows with v3 format cannot be migrated in-place. ClickHouse event store does not use Mongoose plugin — events expire via TTL (730 days). New events written post-DEK adoption use envelope format. No action needed.                                                   | Medium   | Accepted |
| GAP-002 | Cloud KMS providers verified via 81 tests across 3 files: contract tests (51, all 5 providers), pool integration (12), DEK lifecycle E2E (18, Facade→DEKManager→Pool→provider). SDK-boundary mocks with real AES-256-GCM crypto.                                                            | Medium   | Resolved |
| GAP-003 | No admin UI for KMS config per project/environment                                                                                                                                                                                                                                          | Low      | Open     |
| GAP-004 | ConnectorConnection encryption managed outside Mongoose plugin                                                                                                                                                                                                                              | Medium   | Open     |
| GAP-005 | E2E tests: `dek-credential-roundtrip.test.ts` (8 tests: E2E-1, E2E-3, E2E-8) + `dek-full-chain.test.ts` (7 tests: INT-1, INT-5, INT-10). Real LLMCredential model, real DEKManager, real MongoMemoryServer. Plus 6 live test sessions (90+ passing tests total).                            | High     | Resolved |
| GAP-008 | All ~10 direct decrypt call sites (`decryptForTenantAuto`) verified: channel connections, OAuth tokens, secrets-provider, model-resolution, delivery worker, voice session. Standalone + code trace confirmed.                                                                              | High     | Resolved |
| GAP-006 | Redis session store still uses v3 encryption                                                                                                                                                                                                                                                | Low      | Open     |
| GAP-007 | BullMQ workers inherit process-level DEK facade from their host server (runtime, search-ai). No separate wiring needed — workers access encrypted Mongoose models via the shared facade. Workers that need environment-specific DEKs can use `encryptionContext.run()` (deferred).          | Low      | Accepted |
| GAP-009 | `console.warn` in `encryption.plugin.ts` — cannot use `createLogger` due to circular dep (`@abl/compiler` → `database` → `shared-encryption`). `shared-encryption` now uses structured JSON stderr logger; database plugin still uses `console.warn` with `CONSOLE_WARN_EXCEPTION` comment. | Medium   | Accepted |
| GAP-010 | `isDEKEnvelopeFormat` heuristic may false-positive on arbitrary base64 strings whose decoded form happens to have a valid `idLen` byte. Low risk: false-positives fall through to DEK decrypt which fails gracefully (returns ciphertext as-is).                                            | Low      | Accepted |
| GAP-011 | No TTL/cleanup job for `destroyed` DEK entries. Crypto-shredded DEK rows remain in `dek_registry` indefinitely. Add a periodic cleanup job with configurable retention (e.g., 90 days).                                                                                                     | Medium   | Open     |
| GAP-012 | No audit trail for DEK lifecycle events beyond ClickHouse. ClickHouse audit logger tracks operations but there's no structured event bus for DEK creation/rotation/destruction that other systems can subscribe to.                                                                         | Medium   | Open     |
| GAP-013 | `_decryptionFailed` flag on documents has no consumer — no UI, no alerting, no query endpoint surfaces documents with failed decryption. Add admin endpoint or metric.                                                                                                                      | Low      | Open     |
| GAP-014 | Health endpoint (`GET /kms/health`) doesn't check DEK availability — only checks KMS provider connectivity. Should verify active DEK exists for at least one scope.                                                                                                                         | Low      | Open     |

---

## 17. Testing & Validation

See [test specification](../testing/dek-envelope-encryption.md) for detailed scenarios and 6 live test session results (90+ tests total).

### Actual Test Coverage (as of 2026-03-26)

**Unit tests**: ~165 across 14 test files (codec, facade, detection, plugin, DEK manager, cache, resolver, rotation, reencryption, audit, materializer, admin CRUD, encryption context)

**Cloud KMS provider tests**: 81 across 3 test files — contract tests (51: AWS, Azure KV, Azure HSM, GCP, External), pool integration (12: mixed providers, LRU, fingerprinting), DEK lifecycle E2E (18: Facade→DEKManager→KMSResolver→Pool→provider). SDK-boundary mocks with real AES-256-GCM crypto — no real credentials needed.

**Integration/E2E tests**: 15 (dek-credential-roundtrip 8, dek-full-chain 7) + integration test file (9 tests)

**Live API test sessions**: 6 sessions, 90+ individual test verifications — DEK encrypt/decrypt roundtrip, legacy v3 fallback, key rotation lifecycle, epoch rotation, 5-level KMS config, scoped rotation, cross-DEK decrypt, model-resolution credential decrypt, direct call site verification (channel connections, OAuth, secrets-provider)

### Coverage Status

| Area                                                 | Target          | Actual                        | Status       |
| ---------------------------------------------------- | --------------- | ----------------------------- | ------------ |
| Cross-scope isolation (tenant, project, environment) | 3+ E2E, 3+ unit | E2E-1,3,8 + SEC-1 + live T9   | **Met**      |
| Opaque dekId encrypt/decrypt roundtrip               | 5+ unit         | UT-1..8 + live T1,T2          | **Met**      |
| Epoch-based concurrent DEK creation                  | 2+ integration  | UT-39 + live T5,T11           | **Met**      |
| Plugin scope resolution (tenant vs project)          | 5+ unit         | UT-42..44 + E2E-3             | **Met**      |
| AsyncLocalStorage environment propagation            | 3+ integration  | encryption-context.test 11    | **Met**      |
| `'_shared'` default environment                      | 2+ unit         | UT-44 + live verified         | **Met**      |
| Usage-based rotation trigger                         | 2+ unit         | UT-41 + live E3               | **Met**      |
| Time-based rotation (expiresAt)                      | 2+ unit         | UT-40 + live E2               | **Met**      |
| 5-level KMS config inheritance                       | 5+ integration  | Live T17-T21 (4 levels)       | **Partial**  |
| Force rotation (per-scope and tenant-wide)           | 3+ integration  | Live T8,T9,T11,T12            | **Met**      |
| Fail-closed auth config                              | 2+ unit         | UT-46                         | **Met**      |
| Double-encryption guard (save + insertMany)          | 2+ unit         | UT-48 + live R7               | **Met**      |
| Decrypt failure returns encrypted value              | 2+ unit         | UT-45 + plugin fix verified   | **Met**      |
| Legacy v3 fallback decryption                        | 3+ integration  | Live T3,T4,T5 + many sessions | **Met**      |
| Admin API project/environment endpoints              | 5+ E2E          | Live T1-T14 (14 tests)        | **Met**      |
| Materializer sync trigger                            | 2+ integration  | Live T6 (no deployments=0)    | **Partial**  |
| Cloud KMS providers (AWS, Azure, GCP, External)      | 5+ per provider | 81 tests (contracts+pool+E2E) | **Met**      |
| Direct call site decrypt (channel, OAuth, secrets)   | —               | Live T1-T4 + code trace       | **Verified** |

---

## 18. PR #505 Review Fixes (2026-03-26)

Enterprise readiness review of PR #505 identified 5 must-fix/should-fix findings. All were implemented:

| ID         | Severity | Fix                                                                                                | Commit      |
| ---------- | -------- | -------------------------------------------------------------------------------------------------- | ----------- |
| CRITICAL-1 | CRITICAL | Buffer copy in DEKCache.set() and TenantKeyCache.set() — prevents zero-fill corruption on eviction | `6b2e086f1` |
| HIGH-2     | HIGH     | Plugin decrypt failure returns ciphertext as-is (not null) per Decision 14                         | `fa99d72b8` |
| MEDIUM-2   | MEDIUM   | KMS admin route validates req.params.tenantId === auth tenantId (returns 404)                      | `30947563e` |
| HIGH-3     | HIGH     | Structured JSON stderr logger for shared-encryption (replaces process.stderr.write)                | `2684579a1` |
| MEDIUM-1   | MEDIUM   | Tenant-wide forceRotateDEK evicts all scoped \_lastAcquiredDekIds entries                          | `c98c90890` |

Additional fixes from follow-up review:

| Fix                                                             | Commit      |
| --------------------------------------------------------------- | ----------- |
| Removed stub test files with no real assertions                 | `0f8d828e6` |
| Standardized KMS admin API responses to envelope pattern        | `3bda58f75` |
| Log silent encryption downgrades + validate DEK scope input     | `ca0963769` |
| Log all swallowed catches in KMS admin routes                   | `3fd9774c2` |
| tenantId required in resolveConnectionById for tenant isolation | `a8252e2ad` |
| Cross-pod DEK cache invalidation via Redis pub/sub              | `7a46525cd` |

A second enterprise readiness review after these fixes found 0 CRITICAL, 7 HIGH, 9 MEDIUM, 4 LOW items — none are production blockers. See GAP-009 through GAP-014 for tracked items.

---

## 19. References

- Design decisions: [`docs/specs/dek-encryption-design-decisions.md`](../specs/dek-encryption-design-decisions.md)
- HLD: [`docs/specs/dek-envelope-encryption.hld.md`](../specs/dek-envelope-encryption.hld.md)
- PR #505 fix plan: [`docs/superpowers/plans/2026-03-26-dek-pr505-review-fixes.md`](../superpowers/plans/2026-03-26-dek-pr505-review-fixes.md)
- V3 feature spec: [`docs/features/encryption-at-rest.md`](encryption-at-rest.md)
- KMS feature spec: [`docs/features/kms.md`](kms.md)
- KMS types and provider interface: `packages/database/src/kms/types.ts`
- SDLC pipeline: [`docs/sdlc/pipeline.md`](../sdlc/pipeline.md)
