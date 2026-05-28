# HLD: DEK Envelope Encryption

**Feature Spec**: `docs/features/dek-envelope-encryption.md`
**Design Decisions**: `docs/specs/dek-encryption-design-decisions.md`
**Test Spec**: `docs/testing/dek-envelope-encryption.md`
**Status**: BETA — IMPLEMENTATION COMPLETE (unit ~165, integration 16, E2E 8, 6 live sessions 90+ verifications, 11 bugs found+fixed, 5 enterprise review fixes + 6 follow-up fixes, all direct call sites verified)
**Author**: Platform team
**Date**: 2026-03-25

---

## 1. Problem Statement

The platform uses v3 encryption (PBKDF2-derived tenant keys from a shared master key) across 4 encryption layers: Mongoose plugin (18 models, 28+ fields), ClickHouse field interceptor (5 tables), BullMQ secure queue (2 queues), and 12+ direct call sites. This architecture cannot rotate keys without re-encrypting all data, cannot isolate tenant/project/environment keys, cannot crypto-shred, and cannot support BYOK — failing SOC 2, HIPAA, PCI-DSS, and ISO 27001 A.10 compliance.

The DEK KMS infrastructure is already ~70% built (DEKManager, KMSProviderPool, 6 KMS providers, DEKCache, KMSResolver, rotation jobs, admin API — 17 components, 81 tests). This HLD covers:

1. Fixing critical bugs from PR #505 review (cross-tenant DEK leakage, duplicate format detection, auth config fallback, sync decrypt, double-encryption guard)
2. Restoring 3-dimensional DEK scope `(tenantId, projectId, environment)` with per-model scope declarations
3. Restoring epoch-based rotation with opaque nanoid DEK IDs
4. Wiring the Mongoose encryption plugin with hybrid doc-field + AsyncLocalStorage scope resolution
5. Threading project/environment through all encryption call sites

**Design constraints** (see `docs/specs/dek-encryption-design-decisions.md` for full rationale):

- No existing DEK data in any environment — greenfield schema (Decision 1)
- DEK scope is `(tenantId, projectId, environment)` — not tenant-only (Decisions 2, 7)
- DEK IDs are opaque `nanoid(16)` — no parsing, no scope in decrypt path (Decision 3)
- Epoch is a dedup key for concurrent creation, not part of the dekId (Decision 4)
- `expiresAt` precomputed for hot-path rotation checks (Decision 5)
- Fire-and-forget `$inc` for usage count (Decision 6)
- `'_shared'` default environment for models without environment context (Decision 7)
- Decryption failure returns encrypted value as-is with warning log (Decision 14)

---

## 2. Alternatives Considered

### Option A: Thin Facade + Plugin Rewrite (Recommended)

- **Description**: Create a `TenantEncryptionFacade` wrapping `DEKManager` and a minimal `dek-codec.ts`. Rewrite the Mongoose plugin to use per-model scope declarations with hybrid doc-field + AsyncLocalStorage resolution. Update field interceptor and secure queue to use facade. Migrate data with a BullMQ background worker.
- **Pros**:
  - Minimal new code — leverages existing DEKManager/KMSProviderPool fully
  - Massive code reduction (~500+ lines deleted)
  - Single encrypt/decrypt path for all 4 layers
  - Migration worker leverages Mongoose hooks (read triggers legacy decrypt, save triggers DEK encrypt)
  - Rollback safe — stop migration anytime, legacy reads still work
- **Cons**:
  - Migration worker touches production data (risk)
  - Dual-read period keeps legacy code alive temporarily
- **Effort**: M (2-3 weeks)

### Option B: Adapter Layer (Keep Legacy Plugin)

- **Description**: Add an adapter between the existing plugin and DEKManager. Plugin continues to manage per-document metadata but delegates key resolution to DEKManager.
- **Pros**: Less risky, smaller diff in plugin file
- **Cons**: Per-document metadata overhead persists, plugin remains ~830 lines, old format handling + new DEK integration, still needs migration
- **Effort**: M (2-3 weeks, but tech debt persists)

### Option C: New Encryption Package + Shadow Mode

- **Description**: Build entirely new encryption package. Run both legacy and DEK in parallel, write to both, read from DEK, verify match, then cut over.
- **Pros**: Zero-risk migration, clean separation
- **Cons**: Double writes, two packages to maintain, overkill given DEK infra is already battle-tested
- **Effort**: L (4-6 weeks)

### Recommendation: Option A — Thin Facade + Plugin Rewrite

**Rationale**: The DEK infrastructure is already built and well-tested. The risk is in the wiring, not the crypto. A thin facade minimizes new code while maximizing code removal. The migration worker leverages Mongoose's own hooks. Option B preserves unnecessary complexity. Option C is overengineered given existing test coverage.

---

## 3. Architecture

### System Context Diagram

```
+-----------------------------------------------------------------------+
|                           ABL Platform                                  |
|                                                                         |
|  +-----------+  +-----------+  +------------+  +-------------------+   |
|  |  Studio   |  |  Runtime  |  |  Search-AI |  | Workflow Engine   |   |
|  |  (5173)   |  |  (3112)   |  |  (3005)    |  |                   |   |
|  +-----+-----+  +-----+-----+  +------+-----+  +--------+----------+   |
|        |              |               |                   |              |
|        +------+-------+-------+-------+-------------------+              |
|               |                                                          |
|    +----------v-----------+                                              |
|    | Encryption Context   |  <-- AsyncLocalStorage middleware            |
|    | { environment }      |      (two-layer: global + project routes)    |
|    +----------+-----------+                                              |
|               |                                                          |
|    +----------v-----------+                                              |
|    | TenantEncryption     |  <-- Single entry point for all              |
|    | Facade               |      encrypt/decrypt operations              |
|    | encrypt() / decrypt()|                                              |
|    +----------+-----------+                                              |
|               |                                                          |
|    +----------v-----------+                                              |
|    |     DEKManager        |  <-- EXISTING                               |
|    | acquireDEK(scope)     |      scope = { tenantId, projectId, env }   |
|    | unwrapDEK(dekId)      |      dekId = opaque nanoid(16)              |
|    +-----+--------+-------+                                              |
|          |        |                                                      |
|  +-------v----+ +-v--------------+                                       |
|  | DEK Cache  | | KMSProviderPool |  <-- EXISTING                        |
|  | (L1 LRU)   | | (local/aws/azure|     6 providers                      |
|  | key=dekId  | |  /gcp/hsm/ext)  |                                      |
|  +-------+----+ +-------+--------+                                       |
|          |              |                                                |
|  +-------v--------------v------+                                         |
|  |      DEK Registry           |                                         |
|  |  (MongoDB: dek_registry)    |      Per (tenant, project, environment) |
|  +-----------------------------+                                         |
|                                                                          |
|  +------------------------------------------------------------------+   |
|  |                    4 Encryption Layers                             |   |
|  |  +----------------+ +----------------+ +---------+ +-----------+  |   |
|  |  | Mongoose Plugin| | ClickHouse     | | BullMQ  | | Direct    |  |   |
|  |  | (18 models)    | | Interceptor    | | Secure  | | Call      |  |   |
|  |  | per-model scope| | (5 tables)     | | Queue   | | Sites     |  |   |
|  |  +----------------+ +----------------+ +---------+ +-----------+  |   |
|  +------------------------------------------------------------------+   |
+-------------------------------------------------------------------------+
```

### Component Diagram

```
+------------------------------------------------------------+
|                packages/shared-encryption                    |
|                                                              |
|  +----------------------+   +----------------------------+   |
|  | dek-codec.ts         |   | tenant-encryption-         |   |
|  | -------------------- |   | facade.ts                  |   |
|  | encrypt(plain, dek,  |<--| ----------------------     |   |
|  |   dekId)             |   | encrypt(plain, scope)      |   |
|  | decrypt(cipher)      |   | decrypt(cipher)            |   |
|  | extractDekId(cipher) |   | encryptJson(val, scope)    |   |
|  +----------------------+   | decryptJson(cipher)        |   |
|                              +-------------+--------------+   |
|  +----------------------+                  |                  |
|  | encryption-context.ts|   +--------------v--------------+  |
|  | (NEW)                |   | legacy-format-detection.ts  |  |
|  | AsyncLocalStorage    |   | -------------------------   |  |
|  | { environment }      |   | isLegacyFormat()            |  |
|  +----------------------+   | isDEKEnvelopeFormat()       |  |
|                              | (SINGLE SOURCE OF TRUTH)    |  |
|  +----------------------+   +-----------------------------+  |
|  | facade-accessor.ts   |                                    |
|  | Global singleton ref |   +-----------------------------+  |
|  +----------------------+   | engine.ts (MODIFIED)         |  |
|                              | Contact PII (HKDF) KEPT     |  |
|                              | Blind index KEPT             |  |
|                              +-----------------------------+  |
+--------------------------------------------------------------+

+--------------------------------------------------------------+
|                    packages/database                           |
|                                                                |
|  +----------------------------+                                |
|  | mongo/plugins/              |                                |
|  |   encryption.plugin.ts     |  <-- REWRITTEN                 |
|  |   Per-model scope:         |      scope: 'tenant'|'project' |
|  |     - tenantId from doc    |      scopeFields: { ... }      |
|  |     - projectId from doc   |                                |
|  |     - environment from     |      Environment resolution:   |
|  |       doc | ALS | '_shared'|      1. doc field              |
|  +----------------------------+      2. AsyncLocalStorage       |
|                                      3. '_shared' default      |
|  +----------------------------+                                |
|  | kms/                        |                                |
|  |   dek-manager.ts (MODIFIED) |  acquireDEK({ tenantId,       |
|  |   kms-resolver.ts (MODIFIED)|    projectId, environment })  |
|  |   kms-resolver-accessor.ts  |  resolves via MaterializedKMS |
|  |   kms-provider-pool.ts      |                                |
|  |   dek-facade-factory.ts NEW |  Shared init for 4 servers    |
|  +----------------------------+                                |
|                                                                |
|  +----------------------------+                                |
|  | models/                     |                                |
|  |   dek-registry.model.ts     |  dekId, projectId, environment|
|  |   tenant-kms-config.model.ts|  epoch config per tenant      |
|  |   materialized-kms-config   |  pre-resolved per scope       |
|  +----------------------------+                                |
+----------------------------------------------------------------+

+--------------------------------------------------------------+
|                      apps/runtime                              |
|                                                                |
|  +----------------------------+  +---------------------------+ |
|  | server.ts (MODIFIED)       |  | services/kms/             | |
|  | - initDEKFacade() call     |  | - dek-manager.ts (EXIST)  | |
|  | - Two-layer middleware:    |  | - kms-resolver.ts (EXIST) | |
|  |   1. Global: env=null     |  | - kms-materializer.ts     | |
|  |   2. Project: env from    |  | - kms-rotation-job.ts     | |
|  |      deployment context   |  | - reencryption-queue.ts   | |
|  +----------------------------+  | - kms-audit-logger.ts     | |
|                                  +---------------------------+ |
|  +----------------------------+                                |
|  | routes/kms-admin.ts        |  Separate endpoints:           |
|  | PUT /kms/config             |  tenant-level config           |
|  | PUT .../projects/:pid       |  project-level override        |
|  | PUT .../projects/:pid/      |  project+environment override  |
|  |     environments/:env       |                                |
|  | POST /kms/keys/rotate       |  optional projectId/env params |
|  +----------------------------+                                |
+----------------------------------------------------------------+
```

### Data Flow — Encrypt (DEK Path)

```
1. Caller saves document (e.g., Message with encrypted 'content' field)

2. Mongoose pre-save hook triggers encryption plugin
   Plugin reads scope from model registration config:
     - scope: 'project'
     - scopeFields: { tenantId: 'tenantId', projectId: 'projectId' }

3. Plugin resolves scope from document + context:
     tenantId  = doc.tenantId           (from document field)
     projectId = doc.projectId          (from document field)
     environment = doc.environment      (if scopeFields.environment configured)
                 | ALS.get().environment (from AsyncLocalStorage middleware)
                 | '_shared'            (default fallback)

4. Plugin calls facade.encrypt(plaintext, { tenantId, projectId, environment })

5. Facade -> DEKManager.acquireDEK({ tenantId, projectId, environment })
   5a. Check cache for active DEK for this scope
       Cache key: scope hash -> dekId -> unwrapped DEK
   5b. Cache miss -> dek_registry.findOne({
         tenantId, projectId, environment, status: 'active'
       })
   5c. Check: activeEntry.expiresAt < now  OR  usageCount >= maxUsageCount
       If expired/exhausted -> transition to 'decrypt_only', create new DEK
   5d. Not found -> create new DEK:
       - dekId = nanoid(16)
       - epoch = calculateEpoch(intervalHours)   // e.g., "2026-03-25T12"
       - KMSProvider.generateDataKey() -> { wrappedDek, plaintextDek }
       - Insert with unique index on (tenantId, projectId, environment, epoch)
       - Concurrent creation: unique index causes loser to fail -> retry -> find winner
   5e. Return { dekId, plaintextDek }

6. Facade -> dek-codec.encrypt(plaintext, plaintextDek, dekId)
   6a. iv = crypto.randomBytes(12)
   6b. cipher = AES-256-GCM(plaintextDek, iv, plaintext)
   6c. authTag = cipher.getAuthTag()
   6d. idLen = Buffer.from([dekId.length])
   6e. return base64(idLen[1] + dekId[N] + iv[12] + authTag[16] + ciphertext)

7. Fire-and-forget: DEKEntry.updateOne({ dekId }, { $inc: { usageCount: 1 } })
   (Non-blocking, eventually consistent — maxUsageCount is a safety ceiling)

8. Plugin stores base64 string in document field
```

### Data Flow — Decrypt (DEK Path)

```
1. Layer reads base64 string from DB field

2. Plugin post-find hook detects format:
   isDEKEnvelopeFormat(value) -> checks base64-decoded buffer has valid idLen header

3. Plugin calls facade.decrypt(ciphertext)
   NOTE: No scope needed for decrypt — dekId is globally unique

4. Facade -> dek-codec.extractDekId(ciphertext)
   4a. buf = base64decode(ciphertext)
   4b. idLen = buf[0]
   4c. dekId = buf.slice(1, 1 + idLen).toString('utf8')

5. Facade -> DEKManager.unwrapDEK(dekId)
   5a. L1 cache lookup by dekId (globally unique, no scope prefix)
   5b. Cache miss -> dek_registry.findOne({ dekId })
       (Single-field unique index — fastest possible lookup)
   5c. KMSProvider.unwrapKey(entry.wrappedDek, entry.kekKeyId) -> plaintextDek
   5d. Cache: set(dekId, plaintextDek)

6. Facade -> dek-codec.decrypt(ciphertext, plaintextDek)
   6a. buf = base64decode(ciphertext)
   6b. idLen = buf[0]
   6c. iv = buf.slice(1 + idLen, 1 + idLen + 12)
   6d. authTag = buf.slice(1 + idLen + 12, 1 + idLen + 28)
   6e. encrypted = buf.slice(1 + idLen + 28)
   6f. AES-256-GCM decrypt with authTag verification -> plaintext

7. On decrypt failure:
   log.warn('[encryption-plugin] Decryption failed, returning ciphertext', {
     model, field, tenantId, dekId, error
   })
   return encryptedValue  // Return as-is (Decision 14)

8. Plugin returns plaintext to caller
```

### Data Flow — Decrypt (Legacy v3 Fallback)

```
1. Layer reads value from DB

2. isLegacyFormat(value) detects hex 3-part, ENC:v3:, or Z1:/N0: format
   (Single source of truth: legacy-format-detection.ts)

3. Layer calls legacyService.decryptForTenantWithFallback(value, tenantId)
   3a. PBKDF2(masterKey, tenantId) -> derived key
   3b. Parse hex format -> AES-GCM decrypt -> plaintext

4. Layer returns plaintext
   (On next save, plaintext re-encrypted via DEK path — automatic upgrade)
```

### Data Flow — KMS Config Resolution

```
1. Admin updates KMS config via PUT /kms/config/projects/:pid/environments/:env

2. Route handler saves config to TenantKMSConfig

3. Synchronously triggers KMSMaterializer.materialize(tenantId)  (Decision 11)
   3a. Load TenantKMSConfig for tenant
   3b. For each (projectId, environment) combination:
       Resolve 5-level inheritance chain:
         Level 1: project+environment override
         Level 2: project default override
         Level 3: tenant environment override
         Level 4: tenant default config
         Level 5: platform default (env vars)
   3c. Upsert MaterializedKMSConfig per (tenantId, projectId, environment)

4. KMSResolver.resolve(tenantId, projectId, environment)
   reads MaterializedKMSConfig — O(1) lookup, no inheritance chain walk

5. Response returned to admin — config takes effect immediately
```

### Data Flow — DEK Rotation

```
1. Rotation job runs periodically (cron)
   Queries: dek_registry.find({ status: 'active' })

2. For each active DEK:
   2a. Check expiresAt < now  -> time-based rotation needed
   2b. Check usageCount >= maxUsageCount  -> usage-based rotation needed
   2c. If neither -> skip

3. If rotation needed:
   3a. Transition current DEK: status = 'decrypt_only'
   3b. New DEK auto-created on next acquireDEK() call for that scope
       (Lazy creation — no preemptive DEK generation)

4. Force rotation (admin API):
   POST /kms/keys/rotate
   Body: { projectId?, environment? }
   4a. If projectId/environment provided -> rotate specific scope
   4b. If omitted -> rotate ALL active DEKs for the tenant  (Decision 8)
   4c. Set status = 'decrypt_only' on targeted DEKs
```

### Sequence Diagram — Concurrent DEK Creation (Dedup)

```
Pod A                    Pod B                    MongoDB (dek_registry)
  |                        |                           |
  | acquireDEK(scope)      | acquireDEK(scope)        |
  |                        |                           |
  | findOne({scope,        | findOne({scope,           |
  |   status:'active'})    |   status:'active'})       |
  |----------------------->|-------------------------->|
  |<-- null                |<-- null                   |
  |                        |                           |
  | Both calculate same epoch: "2026-03-25T12"         |
  | Both generate different nanoid dekIds              |
  |                        |                           |
  | insertOne({            | insertOne({               |
  |   dekId: 'aB3x...',   |   dekId: 'Yz9w...',      |
  |   scope, epoch,        |   scope, epoch,           |
  |   status: 'active'})   |   status: 'active'})     |
  |----------------------->|-------------------------->|
  |<-- OK (winner)         |<-- DuplicateKeyError      |
  |                        |   (unique index on         |
  |                        |    scope + epoch)          |
  |                        |                           |
  |                        | Retry: findOne({scope,    |
  |                        |   status:'active'})        |
  |                        |-------------------------->|
  |                        |<-- { dekId: 'aB3x...' }  |
  |                        |   (Pod A's DEK)           |
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | Each tenant has unique random DEKs in `dek_registry` scoped by `tenantId`. Cross-tenant decryption is cryptographically impossible — different random 256-bit keys. DEKs are further isolated by `projectId` and `environment`. Tenant-scoped models (8 models without projectId) have DEKs at `(tenantId, '_tenant', '_tenant')` scope. Project-scoped models (10 models) have DEKs at `(tenantId, projectId, environment)`.                                                                                                                                                                                                                                                                                                          |
| 2   | **Data Access Pattern** | No new repository layer. Existing Mongoose models with encryption plugin handle all data access. DEK access: `DEKManager` with L1 in-process LRU cache (100 entries, 5min TTL, zero-fill on eviction). Cache key is `dekId` (globally unique — no scope prefix needed). DEK cache uses Redis pub/sub for cross-pod invalidation on rotation, following the same `InvalidationTransport` injection pattern as `KMSResolver` — `packages/database` remains Redis-free with transport injected via `setInvalidationTransport()`. DEK registry uses `{ dekId: 1 }` unique index for O(1) decrypt lookups. KMS config resolved via `MaterializedKMSConfig` — pre-resolved per `(tenantId, projectId, environment)` for O(1) hot-path reads. |
| 3   | **API Contract**        | No changes to existing APIs — encryption is transparent. New admin API endpoints for KMS config management: `PUT /kms/config` (tenant), `PUT /kms/config/projects/:pid` (project), `PUT /kms/config/projects/:pid/environments/:env` (project+env), `POST /kms/keys/rotate` (force rotation with optional scope params), `GET /kms/health`, `GET /kms/keys`, `GET /kms/audit`. Standard `{ success, data?, error? }` envelope.                                                                                                                                                                                                                                                                                                         |
| 4   | **Security Surface**    | **Encryption**: AES-256-GCM with random 12-byte IV per operation. **Key isolation**: Per-scope DEK (tenant+project+environment), wrapped by KMS provider. Raw DEK never persisted — only wrapped form. **Memory**: Zero-fill on L1 cache eviction. **Double-encrypt guard**: `rejectIfAlreadyEncrypted` in all encrypt paths including `insertMany`. **Admin API**: Requires `admin:encryption:manage` permission. **Fail-closed**: Auth config decrypt failure throws, not silent fallback. **Scope validation**: Plugin throws if required scope fields (tenantId, projectId) missing from document.                                                                                                                                 |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | **Encrypt failure**: Throws — save operation fails, user gets error. No silent data loss. **Decrypt failure**: Returns encrypted value as-is with warning log (Decision 14). Preserves data — callers can retry later or surface as "encrypted/unavailable". Warning log includes model name, field, tenantId, and dekId for investigation. **Auth config failure**: Fail-closed — throws if per-tenant auth config can't be decrypted (Decision 14 exception for security-critical paths).                                               |
| 6   | **Failure Modes** | **KMS provider down**: Circuit breaker per-provider per-tenant (existing). After 5 failures in 60s, circuit opens for 30s. **MongoDB down**: Encrypt/decrypt fails (DEK unavailable). Application-level error handling applies. **Corrupted ciphertext**: GCM auth tag verification fails → return encrypted value + warning. **Missing scope**: Plugin throws with model name if required scope fields missing on document. **Cold cache sync decrypt**: Detects DEK envelope format, throws clear error directing caller to async path. |
| 7   | **Idempotency**   | **DEK creation**: Epoch-based idempotency key with unique compound index `(tenantId, projectId, environment, epoch)`. Concurrent pods creating for same scope in same epoch: one wins, others retry and find the winner's DEK. **Encrypt/decrypt**: Stateless — same input + same DEK = same behavior (different ciphertext due to random IV). **Format detection**: `isDEKEnvelopeFormat()` and `isLegacyFormat()` are pure functions, idempotent.                                                                                       |
| 8   | **Observability** | **Logging**: `[encryption-plugin]` prefix for all plugin operations. Warning logs on decrypt failure with model, field, tenantId, dekId. **Metrics**: DEK cache hit/miss rates, usage count per DEK, rotation job transitions (expired, usage). **Audit**: ClickHouse audit log via `kms-audit-logger.ts` — all DEK operations with scope, dekId, action. **Tracing**: TraceEvents emitted for DEK acquisition and rotation via existing TraceStore.                                                                                      |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | **Cache hit encrypt/decrypt**: <0.1ms overhead (1x AES-GCM). **Cache miss**: DEK is faster — MongoDB read + KMS unwrap ~10-20ms vs PBKDF2 ~50-100ms. **Ciphertext size**: base64 1.33x expansion (smaller than hex 2x). **Decrypt lookup**: Single-field unique index on `dekId` — sub-millisecond. **Usage count**: Fire-and-forget `$inc` — zero latency on encrypt hot path. **Rotation check**: `expiresAt < now` comparison — no config lookup needed. **DEK cache**: L1 LRU 100 entries, 5min TTL. >99% hit rate in steady state (one active DEK per scope).                                                                                                                                                                                                     |
| 10  | **Migration Path**     | **Phase 1**: Deploy new code — all new writes use DEK envelope format, reads detect legacy format and fallback to v3 decrypt. **Phase 2**: Run migration worker per-tenant per-collection. BullMQ background jobs, batch processing, progress tracking. **Phase 3**: Verify zero legacy data. **Phase 4**: Delete legacy code (~500+ lines). **`'_shared'` migration**: When models later become environment-specific, opaque dekId means old `'_shared'` ciphertext decrypts from any context. Re-encryption via existing queue to new scope. Plugin config change only.                                                                                                                                                                                              |
| 11  | **Rollback Plan**      | **Phase 1 rollback**: Revert deploy — v3 code reads v3 data. DEK-encrypted data written during brief window requires forward-fix. Forward-fix procedure: temporarily re-deploy DEK code, run the decrypt-and-re-encrypt utility to convert DEK-encrypted values back to v3 format, then remove DEK code. Alternatively, retain a minimal DEK decrypt-only utility script. **Phase 2 rollback**: Stop migration worker. Mixed state is safe — both formats readable by current code. **Phase 3/4**: Only proceeds after 100% verification. Phase 4 (code deletion) is one-way — cannot roll back after legacy code removed. **Config rollback**: MaterializedKMSConfig is re-generated on any config change — instant.                                                  |
| 12  | **Test Strategy**      | **Unit tests**: Codec roundtrip, facade delegation, legacy format detection, plugin scope resolution (tenant vs project), AsyncLocalStorage environment propagation, `'_shared'` default, epoch dedup, fire-and-forget usage count, decrypt failure return-encrypted policy. **Integration tests**: Real MongoDB — plugin roundtrip with per-model scope, 5-level KMS config inheritance, materializer sync trigger, force rotation per-scope and tenant-wide, concurrent DEK creation, cross-scope isolation. **E2E tests**: Real HTTP API — credential CRUD with encryption, admin API project/environment endpoints, cross-tenant 404, environment-scoped DEK isolation. No mocking codebase components. Only external KMS providers (AWS/Azure/GCP) mocked via DI. |

---

## 5. Data Model

### DEK Registry (updated from PR #505)

```
Collection: dek_registry
Purpose: Store wrapped DEKs per (tenantId, projectId, environment) scope

Fields:
  dekId:            string       nanoid(16), globally unique, embedded in ciphertext
  tenantId:         string       required
  projectId:        string       required
  environment:      string       required (e.g., 'dev', 'staging', 'production', '_shared', '_tenant')
  epoch:            string       e.g., "2026-03-25T12" — idempotency key for concurrent creation
  status:           enum         'active' | 'decrypt_only' | 'destroyed'
  wrappedDek:       string       base64-encoded wrapped DEK material
  kekKeyId:         string       KMS key identifier used for wrapping
  kekKeyVersion:    number       KMS key version
  usageCount:       number       fire-and-forget $inc on each encrypt
  maxUsageCount:    number       safety ceiling (~2^30), from TenantKMSConfig
  expiresAt:        Date         precomputed epoch boundary + intervalMs
  destroyedAt:      Date | null
  createdAt:        Date
  updatedAt:        Date

Indexes:
  { dekId: 1 }                                            unique — decrypt lookup (O(1))
  { tenantId: 1, projectId: 1, environment: 1, epoch: 1 } partial unique (status: 'active') — creation dedup
  { tenantId: 1, projectId: 1, environment: 1, status: 1 } — find active DEK
  { status: 1 }                                            — rotation job queries
  { kekKeyId: 1, status: 1 }                               — re-encryption queries
```

### MaterializedKMSConfig (restored)

```
Collection: materialized_kms_configs
Purpose: Pre-resolved KMS config per (tenantId, projectId, environment) — O(1) hot-path reads
Trigger: Synchronously materialized on any TenantKMSConfig write (Decision 11)

Fields:
  tenantId:              string
  projectId:             string
  environment:           string
  resolvedProvider:      IResolvedProviderRef  (providerType, keyId, keyVersion)
  resolvedTier:          string                (which level of inheritance was used)
  resolvedKeyId:         string
  dekEpochIntervalHours: number                (from TenantKMSConfig, per-tenant)
  dekMaxUsageCount:      number                (from TenantKMSConfig, per-tenant)
  failurePolicy:         string
  sourceConfigVersion:   number

Indexes:
  { tenantId: 1, projectId: 1, environment: 1 } unique
```

### TenantKMSConfig (updated)

```
Collection: tenant_kms_configs
Purpose: Per-tenant KMS settings with project/environment overrides

Fields (additions to existing):
  dekEpochIntervalHours: number    default: 24, minimum: 12 (Decision 9, 13)
  dekMaxUsageCount:      number    default: 2^30 (Decision 9)
  environments:          IKMSEnvironmentOverride[]   per-environment provider overrides
  projects:              IKMSProjectOverride[]        per-project provider and env overrides
```

### Key Relationships

```
TenantKMSConfig (1) ---- per-tenant KMS settings with project/env overrides
       |                   dekEpochIntervalHours, dekMaxUsageCount per tenant
       v (materialized by KMSMaterializer synchronously on config change)
MaterializedKMSConfig (N) ---- pre-resolved per (tenant, project, environment)
       |                         O(1) lookup by KMSResolver.resolve()
       v (read by DEKManager to determine KMS provider for scope)
DEKEntry (N) ---- per-scope DEKs in dek_registry
       |            dekId = nanoid(16), globally unique
       |            epoch = time-based dedup key
       v (dekId embedded in ciphertext wire format)
All 18 Mongoose models ---- encrypted fields use scope-specific DEK
  |                           8 tenant-scoped, 10 project-scoped
  |                           environment from doc | ALS | '_shared'
  v
Encrypted field value = base64(idLen[1] + dekId[N] + iv[12] + authTag[16] + ciphertext)
```

### Encrypted Models — Scope Mapping

| Scope     | Model                 | projectId Source   | Environment Source |
| --------- | --------------------- | ------------------ | ------------------ |
| `tenant`  | LLMCredential         | N/A (no projectId) | N/A                |
| `tenant`  | WebhookSubscription   | N/A                | N/A                |
| `tenant`  | EndUserOAuthToken     | N/A                | N/A                |
| `tenant`  | TenantServiceInstance | N/A                | N/A                |
| `tenant`  | Organization          | N/A                | N/A                |
| `tenant`  | OrgProxyConfig        | N/A                | N/A                |
| `tenant`  | ArchWorkspaceConfig   | N/A                | N/A                |
| `tenant`  | User                  | N/A                | N/A                |
| `project` | EnvironmentVariable   | doc.projectId      | doc.environment    |
| `project` | Message               | doc.projectId      | AsyncLocalStorage  |
| `project` | SessionState          | doc.projectId      | AsyncLocalStorage  |
| `project` | SessionOAuthArtifact  | doc.projectId      | AsyncLocalStorage  |
| `project` | ChannelConnection     | doc.projectId      | `'_shared'`        |
| `project` | SDKChannel            | doc.projectId      | `'_shared'`        |
| `project` | ToolSecret            | doc.projectId      | `'_shared'`        |
| `project` | MCPServerConfig       | doc.projectId      | `'_shared'`        |
| `project` | ServiceNode           | doc.projectId      | `'_shared'`        |
| `project` | AuthProfile           | doc.projectId      | `'_shared'`        |

For tenant-scoped models, DEKManager receives `{ tenantId, projectId: '_tenant', environment: '_tenant' }` as internal sentinel values.

---

## 6. API Design

### KMS Admin API Endpoints

| Method | Path                                                            | Purpose                              | Auth               |
| ------ | --------------------------------------------------------------- | ------------------------------------ | ------------------ |
| GET    | `/api/kms/config`                                               | Read tenant KMS config               | `admin:kms:read`   |
| PUT    | `/api/kms/config`                                               | Update tenant-level KMS config       | `admin:kms:manage` |
| PUT    | `/api/kms/config/projects/:projectId`                           | Set project-level KMS override       | `admin:kms:manage` |
| PUT    | `/api/kms/config/projects/:projectId/environments/:environment` | Set project+environment KMS override | `admin:kms:manage` |
| GET    | `/api/kms/health`                                               | KMS health check                     | `admin:kms:read`   |
| GET    | `/api/kms/keys`                                                 | List DEK entries (with scope filter) | `admin:kms:read`   |
| POST   | `/api/kms/keys/rotate`                                          | Force rotation (optional scope)      | `admin:kms:manage` |
| GET    | `/api/kms/audit`                                                | Audit log                            | `admin:kms:read`   |

### Force Rotation Request/Response

```json
// Request — rotate specific scope
POST /api/kms/keys/rotate
{ "projectId": "proj-123", "environment": "production" }

// Request — rotate all DEKs for tenant
POST /api/kms/keys/rotate
{}

// Response 200
{
  "success": true,
  "data": {
    "rotated": 3,
    "scopes": [
      { "projectId": "proj-123", "environment": "production", "oldDekId": "aB3x...", "status": "decrypt_only" }
    ]
  }
}
```

### Config Update with Materialization

```json
// Request — set project+environment override
PUT /api/kms/config/projects/proj-123/environments/production
{
  "providerType": "azure-managed-hsm",
  "keyId": "hsm-key-001",
  "keyVersion": 1
}

// Response 200 (materialization happens synchronously before response)
{
  "success": true,
  "data": {
    "materialized": true,
    "affectedScopes": 1
  }
}
```

### Error Responses

| Code                   | Status | When                                   |
| ---------------------- | ------ | -------------------------------------- |
| `INVALID_PROVIDER`     | 400    | Unknown provider type in config update |
| `INVALID_ENVIRONMENT`  | 400    | Invalid environment name               |
| `CONFIG_NOT_FOUND`     | 404    | No KMS config for tenant               |
| `ROTATION_IN_PROGRESS` | 409    | Rotation already running for scope     |
| `UNAUTHORIZED`         | 401    | No auth token                          |
| `FORBIDDEN`            | 403    | Non-admin user                         |

### Modified Endpoints

None. All existing APIs continue to work unchanged — encryption is transparent.

---

## 7. Cross-Cutting Concerns

### Audit Logging

All DEK operations logged to ClickHouse via `kms-audit-logger.ts`:

- DEK creation (scope, dekId, epoch, kekKeyId)
- DEK rotation (old dekId → new dekId, trigger: time/usage/force)
- DEK destruction (scope, dekId, destroyedAt)
- KMS config changes (scope, old config, new config)
- Admin API calls (standard audit middleware)

### Rate Limiting

- KMS admin API endpoints use standard admin rate limits (existing middleware)
- Rotation job self-throttles via batch size and cron interval
- DEK creation has natural rate limiting via epoch dedup (max 1 new DEK per scope per epoch)

### Caching

| Cache                 | Type              | Size        | TTL  | Key                                  | Invalidation                                         |
| --------------------- | ----------------- | ----------- | ---- | ------------------------------------ | ---------------------------------------------------- |
| DEK cache             | L1 in-process LRU | 100 entries | 5min | `dekId` (globally unique)            | TTL + zero-fill eviction + Redis pub/sub on rotation |
| KMS config cache      | L1 LRU            | 500 entries | 60s  | `(tenantId, projectId, environment)` | TTL + Redis pub/sub                                  |
| MaterializedKMSConfig | MongoDB           | unbounded   | N/A  | `(tenantId, projectId, environment)` | Overwritten on config change                         |

### Encryption

This feature IS the encryption layer:

- **Data at rest**: AES-256-GCM with per-scope DEK, random 12-byte IV per operation
- **Data in transit**: Existing TLS
- **Key material at rest**: Wrapped by KMS provider (local PBKDF2-derived KEK or cloud KMS)
- **Key material in memory**: Zero-fill on cache eviction

### AsyncLocalStorage Context

Two-layer middleware (Decision 12):

1. **Global middleware** (after auth): `encryptionContext.run({ environment: null })`
   - Tenant-only routes don't need environment
   - Sets baseline context so ALS.get() never returns undefined

2. **Project route middleware** (`/projects/:projectId/*`): overrides with `{ environment }` from:
   - Deployment context (if request has deployment scope)
   - Request body/params (if applicable)
   - Defaults to `'_shared'` if no environment context

3. **BullMQ workers**: `encryptionContext.run({ environment: job.data.environment })`

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                                                         | Type                              | Risk                            |
| ------------------------------------------------------------------ | --------------------------------- | ------------------------------- |
| DEKManager (`packages/database/src/kms/dek-manager.ts`)            | Direct code                       | Low — 81 tests                  |
| KMSProviderPool (`packages/database/src/kms/kms-provider-pool.ts`) | Direct code                       | Low — multi-provider            |
| KMSResolver (`packages/database/src/kms/kms-resolver.ts`)          | Direct code                       | Low — config resolution         |
| LocalKMSProvider                                                   | Default provider                  | Low — in-process                |
| MongoDB                                                            | Infrastructure                    | Low — existing                  |
| Redis                                                              | Infrastructure (BullMQ, L2 cache) | Low — existing                  |
| `ENCRYPTION_MASTER_KEY` env var                                    | Configuration                     | Low — already required          |
| `nanoid` npm package                                               | Direct code                       | Low — zero-dep, well-maintained |
| AsyncLocalStorage (Node.js)                                        | Runtime API                       | Low — stable since Node 16      |

### Downstream (depends on this feature)

| Consumer                                                              | Impact                                      |
| --------------------------------------------------------------------- | ------------------------------------------- |
| 18 Mongoose models with encrypted fields                              | Transparent — plugin handles format + scope |
| ClickHouse field interceptor (5 tables)                               | Transparent — interceptor uses facade       |
| BullMQ secure queue (2 queues)                                        | Transparent — queue wrapper uses facade     |
| 12+ direct call sites (SSO, OAuth, etc.)                              | Requires code change — add scope params     |
| KMS rotation job                                                      | Compatible — uses updated DEKManager API    |
| KMS admin API                                                         | Updated — separate endpoints per scope      |
| 4 server entry points (runtime, studio, search-ai, search-ai-runtime) | Updated — shared `initDEKFacade()` factory  |

---

## 9. Open Questions & Decisions Needed

All major architectural decisions have been finalized — see `docs/specs/dek-encryption-design-decisions.md` (14 decisions).

Resolved questions (implementation complete):

1. **Tenant-scoped models internal scope**: ✅ Uses `projectId: '_tenant', environment: '_tenant'` as sentinel values for the 7 models that don't have projectId. DEK registry schema is uniform (all 3 fields always present).
2. **ClickHouse column mapping**: ✅ ClickHouse `epoch` column stores `dekId` values (legacy naming). Documented in `kms-audit-logger.ts` with `COLUMN_MAPPING` comment. Renaming deferred to separate ClickHouse migration.
3. **console.warn exception**: ✅ `packages/shared-encryption/` now uses structured JSON stderr logger (`createStderrLogger` in `stderr-logger.ts`). `packages/database/encryption.plugin.ts` still uses `console.warn` due to circular dependency. Documented with `CONSOLE_WARN_EXCEPTION` comment. See feature spec GAP-009.

Resolved by PR #505 review fixes (2026-03-26):

4. **Buffer safety**: ✅ DEKCache and TenantKeyCache now store `Buffer.from(key)` copies. Eviction zero-fills the cache's internal copy, not the caller's reference.
5. **Decrypt failure policy**: ✅ Plugin decrypt catch blocks now return ciphertext as-is (Decision 14), not `null`. `_decryptionFailed` flag preserved for consumers.
6. **Admin route tenant isolation**: ✅ KMS admin router validates `req.params.tenantId === req.tenantContext.tenantId`. Returns 404 per platform principle.
7. **Tenant-wide DEK ID eviction**: ✅ `forceRotateDEK` with sentinel scope now evicts all `_lastAcquiredDekIds` entries matching the tenant prefix.
8. **Cross-pod cache invalidation**: ✅ Redis pub/sub channel for DEK cache invalidation across pods on rotation events.

Remaining operational questions:

1. **ClickHouse legacy read retention**: Keep deprecated legacy decrypt function until data TTL expires. Recommendation: keep with clear TTL comment.
2. **Migration batch size**: CLI flags with env var fallback (`ENCRYPTION_MIGRATION_BATCH_SIZE`). Default: 100 docs/batch.
3. **Migration concurrency**: One tenant at a time initially. Configurable via CLI flag for future parallelism.
4. **Redis session store**: Currently always v3 — DEK path deferred to separate work item.

---

## 10. References

- Design decisions: `docs/specs/dek-encryption-design-decisions.md`
- Feature spec: `docs/features/dek-envelope-encryption.md`
- Test spec: `docs/testing/dek-envelope-encryption.md`
- V3 feature spec: `docs/features/encryption-at-rest.md`
- V3 HLD: `docs/specs/encryption-at-rest.hld.md`
- KMS feature spec: `docs/features/kms.md`
- KMS types: `packages/database/src/kms/types.ts`
- Encryption manifest: `packages/shared-encryption/src/encryption-manifest.ts`
