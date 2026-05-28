# Key Management Service (KMS) -- High-Level Design

**Status**: Implemented (BETA)
**Feature Spec**: [docs/features/kms.md](../features/kms.md)
**Test Spec**: [docs/testing/kms.md](../testing/kms.md)
**LLD**: [docs/plans/kms.lld.md](../plans/kms.lld.md)
**Last Updated**: 2026-04-14

---

## 1. Problem Statement

Enterprise agent platforms handle sensitive data (LLM credentials, OAuth tokens, session histories, PII vaults, contact identities) that must be encrypted at rest. The existing encryption architecture uses a single `ENCRYPTION_MASTER_KEY` environment variable with per-tenant key derivation (PBKDF2/HKDF). This approach has limitations for enterprise compliance:

1. **No tenant key isolation** -- all tenants share the same root key; compromise affects everyone
2. **No BYOK/BYOP** -- regulated tenants cannot bring their own key management infrastructure
3. **No key rotation without downtime** -- rotating the master key requires re-encrypting all data
4. **No audit trail** -- cryptographic operations are not logged for compliance evidence
5. **No per-project/environment override** -- production and staging use the same encryption config

The KMS addresses these gaps by introducing a NIST SP 800-57 key hierarchy, multi-provider support, epoch-scoped DEK lifecycle, and comprehensive audit logging.

---

## 2. Alternatives Considered

### Alternative A: Extend Existing EncryptionService Only

**Description**: Add key rotation and multi-key support to the existing `EncryptionService` singleton without introducing a provider abstraction or separate DEK lifecycle.

**Pros**:

- Minimal code change (extend existing class)
- No new MongoDB collections
- No external dependencies

**Cons**:

- Cannot support cloud KMS providers (AWS, Azure, GCP)
- No per-tenant provider isolation
- Key rotation requires re-encrypting all data at once
- No epoch-scoped key bounding

**Effort**: Small

### Alternative B: External KMS Proxy Service

**Description**: Deploy a separate microservice that handles all key management and expose it via HTTP API. All encryption goes through the proxy.

**Pros**:

- Clean separation of concerns
- Can be deployed independently with its own scaling
- Language-agnostic (other services can use it)

**Cons**:

- Added network hop on every encrypt/decrypt (latency concern for hot path)
- Operational complexity (another service to deploy, monitor, maintain)
- Single point of failure for all encryption
- Inconsistent with the monorepo architecture pattern

**Effort**: Large

### Alternative C: Provider Abstraction + Epoch-Scoped DEK Lifecycle (CHOSEN)

**Description**: Introduce a `KMSProvider` interface with 6 implementations, a 5-level config resolution chain with materialized configs, and epoch-scoped DEK management with multi-layer caching. Integrate into the existing monorepo as services within `packages/database` and `apps/runtime`.

**Pros**:

- Supports all cloud KMS providers + BYOP
- Per-tenant/project/environment key management
- Epoch-scoped DEKs bound key exposure to configurable time windows
- O(1) hot-path via materialized configs
- Multi-layer cache minimizes KMS calls
- Fits the existing monorepo architecture
- Zero-downtime key rotation via epoch transitions

**Cons**:

- More complex than Alternative A (new collections, services, caching layers)
- Requires careful zero-fill discipline for security
- Cloud KMS providers add external dependencies

**Effort**: Large

**Recommendation**: Alternative C is chosen because it meets all enterprise compliance requirements (BYOK, audit, rotation), follows NIST standards, and integrates naturally into the existing architecture. The complexity is justified by the compliance and security requirements.

---

## 3. Architecture

### System Context Diagram

```
+------------------------------------------------------------------+
|                       PLATFORM OPERATOR                          |
|  (Studio KMS Admin UI: Config, Keys, Health, Audit)              |
+---+--------------------------------------------------------------+
    |  REST API (7 endpoints)
    v
+---+--------------------------------------------------------------+
|                    RUNTIME SERVER (Express)                       |
|                                                                  |
|  +-----------+  +-----------+  +-----------+  +-----------+     |
|  | KMS Admin |  | KMS       |  | DEK       |  | Encryption|     |
|  | Routes    |  | Resolver  |  | Manager   |  | Service   |     |
|  | (7 endpts)|  | (5-level  |  | (epoch    |  | (AES-256  |     |
|  |           |  |  + L1     |  |  scoped)  |  |  -GCM)    |     |
|  |           |  |  cache)   |  |           |  |           |     |
|  +-----------+  +-----+-----+  +-----+-----+  +-----------+     |
|        |              |              |                            |
|  +-----+-----+  +----+----+  +------+------+                    |
|  | Material- |  | DEK     |  | Circuit     |                    |
|  | izer      |  | Cache   |  | Breaker     |                    |
|  | (5-level  |  | (L1+L2) |  | (per tenant)|                    |
|  |  walk)    |  |         |  |             |                    |
|  +-----------+  +---------+  +------+------+                    |
|        |              |              |                            |
|  +-----+-----+  +----+----+  +------+------+  +-----------+     |
|  | Rotation  |  | Reencrypt|  | Audit      |  | External  |     |
|  | Job (60m) |  | Queue   |  | Logger     |  | Validator |     |
|  |           |  | (BullMQ)|  | (ClickHse) |  |           |     |
|  +-----------+  +---------+  +-------------+  +-----------+     |
+------------------------------------------------------------------+
    |              |              |
    v              v              v
+--------+   +---------+   +----------+   +-------------------+
|MongoDB |   |  Redis  |   |ClickHouse|   | External KMS      |
|        |   |         |   |          |   | Providers         |
|tenant_ |   |L2 DEK   |   |kms_audit_|   | (AWS/Azure/GCP/   |
|kms_    |   |cache    |   |log       |   |  External BYOP)   |
|configs |   |config   |   |(3yr TTL) |   |                   |
|material|   |pub/sub  |   |          |   |                   |
|ized_kms|   |BullMQ   |   |          |   |                   |
|dek_    |   |queues   |   |          |   |                   |
|registry|   |         |   |          |   |                   |
+--------+   +---------+   +----------+   +-------------------+
```

### Component Diagram

```
packages/database/src/kms/
  types.ts                      <- KMSProvider interface contract
  local-kms-provider.ts         <- Local AES-256-GCM (dev/default)
  kms-provider-pool.ts          <- LRU pool (max 50, fingerprint)
  kms-registry.ts               <- Singleton registry
  providers/
    index.ts                    <- Factory with dynamic imports
    aws-kms-provider.ts         <- AWS KMS (@aws-sdk/client-kms)
    azure-keyvault-provider.ts  <- Azure Key Vault (@azure/keyvault-keys)
    azure-managed-hsm-provider.ts <- Azure HSM (FIPS 140-3)
    gcp-cloud-kms-provider.ts   <- GCP Cloud KMS (@google-cloud/kms)
    external-kms-provider.ts    <- External BYOP (HTTPS + 4 auth)

packages/database/src/models/
  tenant-kms-config.model.ts    <- Source of truth config
  materialized-kms-config.model.ts <- Pre-resolved O(1) lookup
  dek-registry.model.ts         <- Epoch-scoped DEK lifecycle

packages/shared/src/encryption/
  engine.ts                     <- EncryptionService (AES-256-GCM)
  index.ts                      <- Singleton factory
  master-key-resolver.ts        <- Vault-first key resolution
  field-interceptor.ts          <- ClickHouse/Redis field encryption
  secure-queue.ts               <- BullMQ job encryption
  key-derivation/               <- HKDF + PBKDF2 strategies
  cache/tenant-key-cache.ts     <- LRU derived key cache

apps/runtime/src/services/kms/
  kms-resolver.ts               <- 5-level resolution + L1 cache
  dek-manager.ts                <- DEK acquire/unwrap/rotate
  dek-cache.ts                  <- L1 LRU + L2 Redis HASH
  kms-materializer.ts           <- Inheritance -> pre-resolved
  kms-circuit-breaker.ts        <- Fault isolation wrapper
  kms-rotation-job.ts           <- Periodic epoch transitions
  kms-audit-logger.ts           <- ClickHouse audit + fallback
  external-kms-validator.ts     <- Pre-save endpoint validation
  reencryption-queue.ts         <- BullMQ DEK re-wrapping
```

### Data Flow

#### Admin Config Save (Write Path)

```
PUT /api/tenants/:tenantId/kms/config
    |
    v
[Validation] -- basic typeof check (no Zod schema yet -- GAP-002)
    |
    v
[TenantKMSConfig.findOneAndUpdate({tenantId}, body, {upsert: true})]
    |-- Increment _v (config version)
    |
    v
[KMSMaterializer.materialize(tenantId)]
    |-- Load TenantKMSConfig
    |-- Enumerate active scopes (from Deployment + ProjectAgent)
    |-- Walk 5-level chain per scope via resolveScope()
    |-- Upsert MaterializedKMSConfig docs (one per scope)
    |-- Delete stale docs for removed scopes
    |
    v
[Redis Pub/Sub kms:invalidate] -- evict KMS resolver L1 cache on all pods
    |
    v
[KMS Audit Logger] -- log config_update event to ClickHouse
```

#### Encrypt/Decrypt Hot Path (Read Path)

```
Service calls encryptForTenant(plaintext, tenantId) or Mongoose plugin pre-save
    |
    v
[KMSResolver.resolve(tenantId, projectId, environment)]
    |-- L1 in-process cache (500 entries, 60s TTL)
    |-- On miss: MaterializedKMSConfig.findOne({tenantId, projectId, environment})
    |-- On no result: Platform default (local provider)
    |
    v
[DEKManager.acquireDEK(scope, config)]
    |-- Epoch: Math.floor(Date.now() / (epochIntervalHours * 3600000))
    |-- Cache check: L1 (100, 5min) -> L2 Redis HASH (30min) -> L3 MongoDB
    |-- On miss: KMSProvider.generateDataKey(keyId) via circuit breaker
    |-- DEKEntry.create() with unique index (E11000 retry)
    |-- Cache in L1 (plaintext) + L2 (wrapped only)
    |
    v
[AES-256-GCM encrypt with DEK plaintext]
    |
    v
[Zero-fill DEK plaintext buffer]
```

#### Periodic Rotation (Background)

```
setInterval (60min, unref'd, all pods, idempotent)
    |
    v
Phase 1: DEKEntry.updateMany(
    {status: 'active', expiresAt: {$lt: now}},
    {$set: {status: 'decrypt_only'}}
  )
    |
    v
Phase 2: Per-tenant retention check, then
  DEKEntry.updateMany(
    {status: 'decrypt_only', expiresAt: {$lt: retentionCutoff}},
    {$set: {status: 'destroyed', wrappedDek: '', destroyedAt: now}}
  )
    |
    v
Phase 3: TenantKMSConfig.find where lastKekRotatedAt < cutoff
    |-- Enqueue re-encryption job (BullMQ) for each stale tenant
    |
    v
[Re-encryption Worker]
    |-- Batch unwrap DEKs with old KEK
    |-- Re-wrap with new KEK
    |-- Zero-fill plaintext between operations
    |-- Atomic update with kekKeyVersion check
    |-- bullJob.updateProgress(percentage)
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                | How It Is Addressed                                                                                                                                                                                                                                                                                                                                                 |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**   | Every query includes `tenantId`. `tenant_kms_configs` has unique index on `tenantId`. `materialized_kms_configs` unique on `{tenantId, projectId, environment}`. DEKs scoped to `{tenantId, projectId, environment}`. Mongoose `tenantIsolationPlugin` on all models. Admin routes use `requirePermission('kms:admin')`. Cross-tenant access returns 404 (not 403). |
| 2   | **Project Isolation**  | 5-level config inheritance allows per-project overrides. Materialized configs are per-project. DEKs are per-project. KMS admin routes are tenant-scoped, not project-scoped (admin manages all projects in a tenant).                                                                                                                                               |
| 3   | **User Isolation**     | N/A -- KMS operates at admin level. User-scoped encryption uses `EncryptionService.encrypt(plaintext, userId)` with per-user PBKDF2 derivation (not KMS-managed).                                                                                                                                                                                                   |
| 4   | **Auth & Permissions** | Full middleware chain: `authMiddleware -> tenantRateLimit -> requireFeature('kms_byok') -> requirePermission('kms:admin')`. Feature gate requires ENTERPRISE tier.                                                                                                                                                                                                  |

### Runtime Concerns

| #   | Concern           | How It Is Addressed                                                                                                                                                                                             |
| --- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Performance**   | Multi-layer caching: L1 in-process (sub-us), L2 Redis (sub-ms), materialized configs (O(1) indexed). Tenant key cache avoids PBKDF2 re-derivation. Provider pool reuses cloud connections.                      |
| 6   | **Reliability**   | Circuit breaker per-tenant isolates provider failures. Audit logging is fire-and-forget. Rotation job failures logged but never crash. Redis unavailability has TTL fallback. BullMQ retries with backoff.      |
| 7   | **Scalability**   | All caches have bounded size (L1: 100/500, pool: 50). Rotation job is idempotent across pods. Re-encryption queue distributes work via BullMQ. Config invalidation via Redis pub/sub scales to N pods.          |
| 8   | **Observability** | ClickHouse audit log for all KMS operations (3-year retention). Fallback to structured log with `_audit: true`. Circuit breaker metrics. Materializer/rotation job logging. Encryption availability diagnostic. |

### Operational Concerns

| #   | Concern        | How It Is Addressed                                                                                                                                                                                           |
| --- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Deployment** | No separate service -- runs within runtime. Feature-gated behind `kms_byok`. Cloud SDK dependencies are dynamic imports (no bundle bloat). ClickHouse table DDL is out-of-band (GAP-007).                     |
| 10  | **Migration**  | No data migration needed -- new collections (`tenant_kms_configs`, `materialized_kms_configs`, `dek_registry`) are additive. Existing encryption (master key + PBKDF2) continues to work as platform default. |
| 11  | **Security**   | NIST SP 800-57 key hierarchy. AES-256-GCM with 96-bit IV. Zero-fill all plaintext key material. L2 stores only wrapped DEKs. HTTPS enforcement for external providers. Auth config stored encrypted.          |
| 12  | **Compliance** | PCI DSS 3.6: 3-year audit trail in ClickHouse. HIPAA: per-tenant key isolation. FIPS 140-3: Azure Managed HSM support. SOC2: audit logging with structured events. GDPR: crypto-shredding via contact keys.   |

---

## 5. Decisions & Tradeoffs

| Decision              | Choice                      | Rationale                                                                                       | Alternatives Rejected                    |
| --------------------- | --------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Config resolution     | Materialized (O(1) read)    | Every encrypt/decrypt on hot path; 5-level walk too expensive at request time                   | Runtime walk (O(5) per request)          |
| DEK scoping           | Epoch-based (time-windowed) | Bounds key exposure to configurable window; per-session DEKs create unsustainable counts        | Per-session DEK, per-record DEK          |
| DEK cache L2          | Wrapped-only in Redis       | Never store plaintext key material in shared cache (security)                                   | Plaintext in Redis (faster but insecure) |
| Audit storage         | ClickHouse (not MongoDB)    | Write-heavy, time-series, 3-year retention with native TTL; MongoDB not suited for this pattern | MongoDB capped collection, S3 logs       |
| Circuit breaker scope | Per tenant+provider         | Isolates one tenant's provider failure; global breaker would cascade                            | Global breaker, no breaker               |
| Re-encryption         | BullMQ queue (async)        | Thousands of DEKs after KEK rotation; must not block request path                               | Inline re-encryption (blocks requests)   |
| Provider pool         | LRU (max 50)                | Cloud connections expensive; reuse keyed by fingerprint; bounded memory                         | Per-tenant instance, no pool             |

---

## 6. Security

- AES-256-GCM with 96-bit IV (NIST SP 800-38D)
- Zero-fill all plaintext key material immediately after use (`Buffer.fill(0)`)
- L2 Redis cache stores only wrapped DEKs (never plaintext)
- External KMS endpoints require HTTPS with TLS 1.2+
- BYOK/BYOP feature-gated behind enterprise tier
- Auth config stored encrypted in MongoDB (`authConfigEncrypted` field)
- Double encryption prevention via `isAlreadyEncrypted()` guard
- Sandboxed key operations via circuit breaker (prevent cascading failures)
- `wrappedDek` zeroed on DEK destruction (NIST SP 800-57 state: destroyed)
- External KMS: 10s timeout, 64KB max response, header injection prevention
- HMAC-SHA256 auth: nonce + timestamp to prevent replay attacks

---

## 7. Observability

- **Audit events**: ClickHouse `abl_platform.kms_audit_log` with 3-year TTL retention. Events include: operation, key_id, key_version, provider_type, actor, latency_ms, success/failure.
- **Audit fallback**: Structured application log with `_audit: true` flag when ClickHouse is unavailable (SOC2 compliance via log aggregator).
- **Circuit breaker**: `recordCBPersistenceFailure('kms', ...)` metric on breaker state persistence failure.
- **Materializer logs**: Scope count, upserted count, stale deleted, duration.
- **Rotation job logs**: Transitioned count, destroyed count, re-encryption jobs queued.
- **Provider pool**: Health check logging on unhealthy eviction + recreation.
- **Encryption diagnostic**: `apps/runtime/src/services/diagnostics/analyzers/encryption-availability.ts` checks KMS health at startup.

---

## 8. Task Decomposition

| Task                                                   | Package(s)        | Independent?  | Status |
| ------------------------------------------------------ | ----------------- | ------------- | ------ |
| T-1: KMS Provider interface + types                    | packages/database | Yes           | DONE   |
| T-2: Local KMS provider                                | packages/database | No (T-1)      | DONE   |
| T-3: Cloud KMS providers (AWS, Azure x2, GCP)          | packages/database | No (T-1)      | DONE   |
| T-4: External KMS provider (BYOP)                      | packages/database | No (T-1)      | DONE   |
| T-5: Provider pool + registry                          | packages/database | No (T-1,T-2)  | DONE   |
| T-6: DB models (TenantKMSConfig, MaterializedKMS, DEK) | packages/database | Yes           | DONE   |
| T-7: EncryptionService + key derivation                | packages/shared   | Yes           | DONE   |
| T-8: Encryption registry + manifest                    | packages/shared   | No (T-7)      | DONE   |
| T-9: Field interceptor + secure queue                  | packages/shared   | No (T-7)      | DONE   |
| T-10: KMS resolver (5-level chain + L1 cache)          | apps/runtime      | No (T-6)      | DONE   |
| T-11: DEK manager + multi-layer cache                  | apps/runtime      | No (T-5,T-6)  | DONE   |
| T-12: KMS materializer                                 | apps/runtime      | No (T-6)      | DONE   |
| T-13: Circuit breaker wrapper                          | apps/runtime      | No (T-5)      | DONE   |
| T-14: Rotation job                                     | apps/runtime      | No (T-6,T-11) | DONE   |
| T-15: Re-encryption queue                              | apps/runtime      | No (T-5,T-11) | DONE   |
| T-16: Audit logger                                     | apps/runtime      | Yes           | DONE   |
| T-17: External KMS validator                           | apps/runtime      | No (T-4)      | DONE   |
| T-18: Admin routes                                     | apps/runtime      | No (T-10-17)  | DONE   |
| T-19: Studio admin UI                                  | apps/studio       | No (T-18)     | DONE   |
| T-20: Zod request validation for admin routes          | apps/runtime      | No (T-18)     | TODO   |
| T-21: Cloud KMS integration tests                      | packages/database | No (T-3)      | TODO   |
| T-22: KMS admin E2E tests                              | apps/runtime      | No (T-18)     | TODO   |
| T-23: External KMS validator tests                     | apps/runtime      | No (T-17)     | TODO   |
| T-24: Re-encryption worker E2E                         | apps/runtime      | No (T-15)     | TODO   |
| T-25: Auto re-materialization on stale detection       | apps/runtime      | No (T-12)     | TODO   |

---

## 9. Out of Scope

- Client-side encryption
- Key escrow or multi-party key ceremonies
- HSM integration for local provider
- Cross-tenant key sharing
- Encryption key backup/restore UI
- BYOK `importKeyMaterial` (interface exists, no implementation)
- DEK `usageCount` tracking wiring (field exists, not incremented)
