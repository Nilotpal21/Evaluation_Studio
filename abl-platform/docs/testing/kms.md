# Feature Test Guide: Key Management Service (KMS)

**Feature**: KMS -- multi-layer key hierarchy, provider pool, DEK lifecycle, config inheritance, audit logging
**Owner**: Platform team
**Branch**: develop
**Related Feature Doc**: [docs/features/kms.md](../features/kms.md)
**First tested**: 2026-03-15
**Last updated**: 2026-04-14
**Overall status**: PASS -- comprehensive unit coverage across all service modules plus cloud DEK lifecycle, provider readiness, and platform key scope architecture. Integration and E2E gaps remain for real cloud APIs, full runtime admin API flow, and scope-route enforcement.

---

## Coverage Matrix

| FR    | Description                                 | Unit | Integration | E2E        | Manual | Status     |
| ----- | ------------------------------------------- | ---- | ----------- | ---------- | ------ | ---------- |
| FR-1  | 6 KMS provider types                        | PASS | PASS        | N/A        | N/A    | Covered    |
| FR-2  | 5-level config resolution + materialization | PASS | NOT TESTED  | N/A        | N/A    | Partial    |
| FR-3  | Epoch-scoped DEK lifecycle                  | PASS | PASS        | N/A        | N/A    | Covered    |
| FR-4  | Multi-layer DEK cache with zero-fill        | PASS | NOT TESTED  | N/A        | N/A    | Partial    |
| FR-5  | Circuit breaker for KMS calls               | PASS | NOT TESTED  | N/A        | N/A    | Partial    |
| FR-6  | Periodic rotation job                       | PASS | NOT TESTED  | N/A        | N/A    | Partial    |
| FR-7  | BullMQ re-encryption queue                  | PASS | NOT TESTED  | N/A        | N/A    | Partial    |
| FR-8  | ClickHouse audit logging with fallback      | PASS | NOT TESTED  | N/A        | N/A    | Partial    |
| FR-9  | External KMS endpoint validation            | N/A  | NOT TESTED  | N/A        | N/A    | Not Tested |
| FR-10 | REST API for KMS admin (7 endpoints)        | PASS | NOT TESTED  | NOT TESTED | N/A    | Partial    |
| FR-11 | Platform key scope registry                 | PASS | PASS        | PASS       | N/A    | Covered    |
| FR-12 | Provider readiness verification             | PASS | N/A         | N/A        | N/A    | Partial    |

**FR-1 update**: `dek-lifecycle-cloud-e2e.test.ts` exercises mocked AWS/Azure/GCP providers with real AES-256-GCM crypto at the SDK boundary. Real cloud API tests remain absent.
**FR-3 update**: Same test covers full DEK creation, reuse, force rotation, backward compat, and cross-provider migration.
**FR-11**: Platform key scope registry has full coverage -- unit (`platform-key-scopes.test.ts`), integration (`platform-keys-api.test.ts`), E2E (`platform-keys-api.e2e.test.ts`).

---

## Current State (as of 2026-03-22)

### Quick Health Dashboard

| Area                                   | Status       | Last Verified | Notes                                                                    |
| -------------------------------------- | ------------ | ------------- | ------------------------------------------------------------------------ |
| DEK cache L1 (in-process LRU)          | PASS         | 2026-03-22    | TTL expiry, max size eviction, zero-fill on evict                        |
| DEK cache L2 (Redis HASH)              | PASS         | 2026-03-22    | Graceful degradation when Redis unavailable                              |
| MultiLayerDEKCache delegation          | PASS         | 2026-03-22    | L1 -> L2 -> miss path, set propagation to both layers                    |
| KMS resolver L1 cache                  | PASS         | 2026-03-22    | Hit/miss/eviction, 500 entries, 60s TTL                                  |
| KMS resolver MaterializedKMSConfig     | PASS         | 2026-03-22    | Lookup with tenant+project+environment                                   |
| KMS resolver platform default fallback | PASS         | 2026-03-22    | Returns local provider when no materialized config                       |
| KMS resolver tenant eviction           | PASS         | 2026-03-22    | Evicts all entries for a tenant                                          |
| DEK manager epoch calculation          | PASS         | 2026-03-22    | Deterministic epoch from timestamp and interval                          |
| DEK manager acquireDEK                 | PASS         | 2026-03-22    | Create new DEK, cache, E11000 retry                                      |
| DEK manager unwrapDEK                  | PASS         | 2026-03-22    | Unwrap from DB, cache result                                             |
| DEK manager batchUnwrapDEKs            | PASS         | 2026-03-22    | Multiple DEKs in single batch                                            |
| DEK manager forceRotateDEK             | PASS         | 2026-03-22    | Transition active -> decrypt_only                                        |
| KMS materializer 5-level walk          | PASS         | 2026-03-22    | All 5 levels: project+env, project default, tenant env, tenant, platform |
| KMS materializer upsert idempotency    | PASS         | 2026-03-22    | Re-running materialization produces same result                          |
| KMS materializer stale doc cleanup     | PASS         | 2026-03-22    | Removes materialized configs for deleted scopes                          |
| KMS materializer reconcileAll          | PASS         | 2026-03-22    | Iterates all tenants, tolerates individual failures                      |
| KMS circuit breaker CLOSED             | PASS         | 2026-03-22    | Operations pass through, success recorded                                |
| KMS circuit breaker OPEN               | PASS         | 2026-03-22    | Operations fail-fast with circuit open error                             |
| KMS circuit breaker failure recording  | PASS         | 2026-03-22    | Failures recorded even if breaker persistence fails                      |
| KMS rotation epoch transition          | PASS         | 2026-03-22    | active DEKs past expiresAt -> decrypt_only                               |
| KMS rotation DEK destruction           | PASS         | 2026-03-22    | decrypt_only DEKs past retention -> destroyed + wrappedDek zeroed        |
| KMS rotation KEK age check             | PASS         | 2026-03-22    | Stale KEKs trigger re-encryption enqueue                                 |
| KMS audit ClickHouse write             | PASS         | 2026-03-22    | Event -> row mapping, ClickHouse insert                                  |
| KMS audit fallback (no ClickHouse)     | PASS         | 2026-03-22    | Structured log emission with \_audit flag                                |
| KMS audit batch write                  | PASS         | 2026-03-22    | Multiple events in single insert                                         |
| Re-encryption queue enqueue            | PASS         | 2026-03-22    | Job deduplication by tenant+reason+date                                  |
| Re-encryption queue disabled           | PASS         | 2026-03-22    | Graceful skip when env disabled or Redis unavailable                     |
| Re-encryption queue shutdown           | PASS         | 2026-03-22    | Worker + queue closed gracefully                                         |
| KMS provider pool LRU eviction         | PASS         | 2026-03-22    | Evicts least recently used, never evicts local                           |
| KMS provider pool health check         | PASS         | 2026-03-22    | Unhealthy providers evicted and recreated                                |
| KMS provider pool fingerprint          | PASS         | 2026-03-22    | Correct fingerprint per provider type                                    |
| KMS provider pool edge cases           | PASS         | 2026-03-22    | Initialize, shutdown, max size boundary                                  |
| KMS provider factory                   | PASS         | 2026-03-22    | Creates correct provider type for each config                            |
| KMS admin authz (permission matrix)    | PASS         | 2026-03-22    | OWNER/ADMIN/OPERATOR/VIEWER roles tested on 3 endpoints                  |
| KMS admin CRUD logic                   | PASS         | 2026-03-22    | GET/PUT config, GET keys, POST rotate, GET health                        |
| EncryptionService (user-scoped)        | PASS         | 2026-03-22    | encrypt/decrypt round-trip with PBKDF2                                   |
| EncryptionService (tenant-scoped)      | PASS         | 2026-03-22    | encryptForTenant/decryptForTenant                                        |
| EncryptionService (contact-scoped)     | PASS         | 2026-03-22    | deriveContactKey for GDPR crypto-shred                                   |
| EncryptionService (compress-encrypt)   | PASS         | 2026-03-22    | Zstd compression + AES-256-GCM                                           |
| EncryptionService (multi-key fallback) | PASS         | 2026-03-22    | decryptWithFallback across key versions                                  |
| EncryptionService (cross-compat)       | PASS         | 2026-03-22    | v1/v2/v3 format cross-compatibility                                      |
| EncryptionService (edge cases)         | PASS         | 2026-03-22    | Empty input, invalid format, double-encryption guard                     |
| Field interceptor                      | PASS         | 2026-03-22    | ClickHouse/Redis field-level encryption                                  |
| Secure queue wrapper                   | PASS         | 2026-03-22    | BullMQ job data encrypt/decrypt                                          |
| Singleton factory                      | PASS         | 2026-03-22    | getEncryptionService singleton behavior                                  |
| Mongoose plugin + KMS                  | PASS         | 2026-03-22    | Field-level v1/v2 migration, KMS availability                            |
| Encryption E2E (MongoMemoryServer)     | PASS         | 2026-03-22    | Full round-trip with in-memory MongoDB                                   |
| Encryption integration                 | PASS         | 2026-03-22    | Plugin integration with real MongoDB operations                          |
| Cloud KMS DEK lifecycle (mocked SDK)   | PASS         | 2026-04-14    | AWS/Azure/GCP with real AES-256-GCM at SDK boundary                      |
| Provider readiness (health + crypto)   | PASS         | 2026-04-14    | Verifies both health check and wrap/unwrap probe                         |
| Platform key scope registry            | PASS         | 2026-04-14    | 10 scopes, 4 categories, RBAC mapping validation                         |
| Platform key ceiling check             | PASS         | 2026-04-14    | OWNER/ADMIN allowed, VIEWER denied for elevated scopes                   |
| Platform key scope expansion           | PASS         | 2026-04-14    | Scope -> RBAC permission set expansion                                   |
| Platform key API E2E (Studio routes)   | PASS         | 2026-04-14    | Key CRUD, scope validation, revocation through real routes               |
| Platform key API integration           | PASS         | 2026-04-14    | Key creation, listing, update, deletion flows                            |
| Platform key utilities                 | PASS         | 2026-04-14    | Key generation, hashing, Zod schema validation                           |
| KMS admin routes (full middleware)     | NOT VERIFIED | -             | No E2E test through real auth + rate limit + feature gate                |
| Cloud KMS providers (real APIs)        | NOT VERIFIED | -             | AWS, Azure, GCP never tested against real cloud APIs                     |
| External KMS validator                 | NOT VERIFIED | -             | No dedicated test file                                                   |
| Re-encryption worker processing        | NOT VERIFIED | -             | Worker batch processing never tested end-to-end                          |
| Studio KMS UI                          | NOT VERIFIED | -             | No Playwright E2E for admin pages                                        |
| Scope-route enforcement E2E            | NOT VERIFIED | -             | Platform key scopes -> runtime API access not tested end-to-end          |

---

## E2E Test Scenarios (MANDATORY)

### E2E-1: KMS Config CRUD with Auth and Tenant Isolation

**Preconditions**: Runtime server running on random port with full middleware chain. Two tenants (tenant-A, tenant-B) with auth tokens. Tenant-A has OWNER role.

**Steps**:

1. `GET /api/tenants/tenant-A/kms/config` with tenant-A token -> 200, `{ configured: false, usingDefault: true }`
2. `PUT /api/tenants/tenant-A/kms/config` with tenant-A token, body: `{ defaultProvider: { providerType: 'local', keyId: 'test-key' } }` -> 200
3. `GET /api/tenants/tenant-A/kms/config` with tenant-A token -> 200, `{ configured: true, defaultProvider: { providerType: 'local' } }`
4. `GET /api/tenants/tenant-A/kms/config` with tenant-B token -> 404 (cross-tenant isolation)
5. `PUT /api/tenants/tenant-A/kms/config` with no auth token -> 401
6. `PUT /api/tenants/tenant-A/kms/config` with VIEWER role token -> 403

**Expected Result**: Full CRUD works for authorized tenant; cross-tenant returns 404; missing auth returns 401; insufficient permissions returns 403.

**Auth Context**: tenant-A OWNER, tenant-B ADMIN, unauthenticated, VIEWER role.

**Isolation Check**: tenant-B cannot read tenant-A config.

### E2E-2: DEK Listing and Force Rotation

**Preconditions**: Runtime server on random port. Tenant with KMS config and at least one active DEK (created by a prior encrypt operation).

**Steps**:

1. `GET /api/tenants/:tenantId/kms/keys` -> 200, array of DEKs with status `active`, `wrappedDek` field NOT exposed
2. `POST /api/tenants/:tenantId/kms/keys/rotate` -> 200, confirmation of rotation
3. `GET /api/tenants/:tenantId/kms/keys?status=decrypt_only` -> 200, previously-active DEKs now showing `decrypt_only`
4. Verify re-encryption job was enqueued (check BullMQ queue or audit log)

**Expected Result**: DEK listing never exposes `wrappedDek`. Force rotation transitions active DEKs to `decrypt_only` and triggers re-encryption.

**Auth Context**: Platform admin with `kms:admin` permission.

**Isolation Check**: DEK listing only returns DEKs for the authenticated tenant.

### E2E-3: KMS Health Check and Provider Status

**Preconditions**: Runtime server on random port. Tenant configured with local KMS provider.

**Steps**:

1. `GET /api/tenants/:tenantId/kms/health` -> 200, `{ healthy: true, providerType: 'local', activeDekCount: N, decryptOnlyDekCount: M }`
2. Verify response includes provider health status, active DEK count, and decrypt_only DEK count

**Expected Result**: Health endpoint returns provider health and DEK statistics.

**Auth Context**: Platform admin with `kms:admin` permission.

### E2E-4: KMS Audit Log Query

**Preconditions**: Runtime server on random port. ClickHouse available. Prior KMS operations have generated audit events.

**Steps**:

1. Perform a KMS config update (PUT /config) to generate an audit event
2. `GET /api/tenants/:tenantId/kms/audit?limit=10` -> 200, array of audit events
3. Verify audit events contain: `operation`, `timestamp`, `actor_id`, `success`, `latency_ms`
4. Verify cross-tenant query returns only the current tenant's events

**Expected Result**: Audit log returns structured events for the authenticated tenant only.

**Auth Context**: Platform admin with `kms:admin` permission.

**Isolation Check**: Tenant-B cannot see tenant-A audit events.

### E2E-5: External KMS Endpoint Validation

**Preconditions**: Runtime server on random port. Mock external HTTPS server with valid TLS cert responding to KMS protocol.

**Steps**:

1. `POST /api/tenants/:tenantId/kms/validate` with valid external endpoint config -> 200, `{ valid: true, latencyMs: N }`
2. `POST /api/tenants/:tenantId/kms/validate` with HTTP (not HTTPS) endpoint -> 400, validation error
3. `POST /api/tenants/:tenantId/kms/validate` with unreachable endpoint -> 200, `{ valid: false, errors: [...] }`
4. `POST /api/tenants/:tenantId/kms/validate` with endpoint returning invalid wrap/unwrap -> 200, `{ valid: false, errors: ['round-trip failed'] }`

**Expected Result**: Validation catches HTTPS enforcement, connectivity, and round-trip correctness.

**Auth Context**: Platform admin with `kms:admin` permission.

### E2E-6: Full Encrypt-Decrypt Round Trip with KMS Provider Resolution

**Preconditions**: Runtime server on random port. Tenant with KMS config pointing to local provider. A project and environment exist.

**Steps**:

1. Configure tenant KMS with local provider via PUT /config
2. Trigger an operation that encrypts data (e.g., create a session with message content)
3. Read the encrypted data from MongoDB directly (verify it is encrypted, not plaintext)
4. Read the data via API (verify it is decrypted transparently)
5. Verify DEK was created in `dek_registry` for the correct tenant+project+environment+epoch

**Expected Result**: Data is encrypted at rest using the tenant's KMS provider. DEK is created and registered.

**Auth Context**: Tenant admin.

### E2E-7: Config Update Triggers Materialization and Cache Invalidation

**Preconditions**: Runtime server on random port (multiple pods simulated). Tenant with existing config.

**Steps**:

1. `GET /api/tenants/:tenantId/kms/config` -> 200, current config
2. `PUT /api/tenants/:tenantId/kms/config` with updated provider -> 200
3. Verify `materialized_kms_configs` collection has updated entries with new `sourceConfigVersion`
4. Verify subsequent KMS operations use the new provider (via health check or DEK creation)

**Expected Result**: Config update triggers materialization. Stale materialized configs are replaced.

---

## Integration Test Scenarios (MANDATORY)

### INT-1: DEK Manager with MongoMemoryServer and Local KMS Provider

**Boundary**: DEKManager + LocalKMSProvider + MongoMemoryServer (dek_registry collection)

**Setup**: MongoMemoryServer, `LocalKMSProvider` initialized with test master key.

**Steps**:

1. Call `acquireDEK({ tenantId: 't1', projectId: 'p1', environment: 'production' }, config)` -> returns `{ plaintext, epoch, kekKeyId }`
2. Verify DEK entry created in `dek_registry` with status `active`
3. Call `acquireDEK` again for same scope -> returns same epoch DEK (from cache or DB)
4. Call `forceRotateDEK(scope)` -> DEK status transitions to `decrypt_only`
5. Call `acquireDEK` again -> creates new DEK for next epoch
6. Zero-fill all plaintext buffers after use

**Expected Result**: Full DEK lifecycle operates correctly against real MongoDB.

**Failure Mode**: If MongoDB is unavailable, `acquireDEK` should throw (fail-closed behavior).

### INT-2: KMS Materializer with 5-Level Config Resolution

**Boundary**: KMSMaterializer + TenantKMSConfig + MaterializedKMSConfig + MongoMemoryServer

**Setup**: MongoMemoryServer with a TenantKMSConfig having project and environment overrides.

**Steps**:

1. Create TenantKMSConfig with: `defaultProvider: local`, `environments: [{ environment: 'production', provider: aws-kms }]`, `projects: [{ projectId: 'p1', defaultProvider: azure-keyvault, environments: [{ environment: 'production', provider: gcp-cloud-kms }] }]`
2. Call `materialize(tenantId)`
3. Verify MaterializedKMSConfig for `(tenant, p1, production)` -> resolves to `gcp-cloud-kms` (level 1)
4. Verify MaterializedKMSConfig for `(tenant, p1, staging)` -> resolves to `azure-keyvault` (level 2)
5. Verify MaterializedKMSConfig for `(tenant, p2, production)` -> resolves to `aws-kms` (level 3)
6. Verify MaterializedKMSConfig for `(tenant, p2, staging)` -> resolves to `local` (level 4)
7. Delete a project override, re-materialize, verify stale docs cleaned up

**Expected Result**: All 5 levels resolve correctly. Stale cleanup works.

### INT-3: KMS Rotation Job with Real DEK Data

**Boundary**: KMSRotationJob + DEKEntry + MongoMemoryServer

**Setup**: MongoMemoryServer with DEK entries in various states: active (expired), active (not expired), decrypt_only (past retention), decrypt_only (within retention).

**Steps**:

1. Insert DEKs with controlled timestamps
2. Run rotation job tick
3. Verify: active expired DEKs -> `decrypt_only`
4. Verify: active non-expired DEKs remain `active`
5. Verify: decrypt_only past retention -> `destroyed`, `wrappedDek` zeroed
6. Verify: decrypt_only within retention remain `decrypt_only`

**Expected Result**: Rotation job correctly transitions DEK states based on time boundaries.

**Failure Mode**: If MongoDB is unavailable, rotation job logs error and continues (never crashes).

### INT-4: Encryption Plugin KMS Integration

**Boundary**: Mongoose encryption plugin + LocalKMSProvider + MongoMemoryServer

**Setup**: MongoMemoryServer, Mongoose model with encrypted fields, `LocalKMSProvider`.

**Steps**:

1. Create a document with encrypted fields via Mongoose model
2. Read raw MongoDB document -> verify field values are encrypted (not plaintext)
3. Read via Mongoose model -> verify field values are decrypted
4. Update encrypted field -> verify new encryption applied
5. Verify `isAlreadyEncrypted()` guard prevents double encryption

**Expected Result**: Mongoose plugin transparently encrypts/decrypts with KMS provider.

**Failure Mode**: If KMS provider is unavailable, save operation should fail (fail-closed).

### INT-5: Re-encryption Queue Worker Processing

**Boundary**: ReencryptionQueue + DEKManager + LocalKMSProvider + MongoMemoryServer + Redis (or mock)

**Setup**: MongoMemoryServer with DEK entries wrapped by old KEK. BullMQ queue (in-memory or Redis).

**Steps**:

1. Insert DEKs wrapped by `kek-v1` with status `active`
2. Enqueue re-encryption job with reason `kek-age-exceeded`
3. Process job via worker
4. Verify DEKs are now wrapped by `kek-v2` (new KEK version)
5. Verify progress tracking via `bullJob.updateProgress()`
6. Verify plaintext is zero-filled between unwrap and re-wrap operations

**Expected Result**: Batch re-encryption successfully re-wraps all DEKs with new KEK.

**Failure Mode**: On worker failure, BullMQ retries with exponential backoff (3 attempts).

### INT-6: Circuit Breaker Integration with Failing KMS Provider

**Boundary**: KMSCircuitBreakerWrapper + KMSProvider (mock failing) + HybridCircuitBreakerRegistry

**Setup**: Mock KMS provider that fails after N calls.

**Steps**:

1. Execute KMS operations through circuit breaker -> success (CLOSED state)
2. Inject failures into mock provider
3. After failure threshold, circuit opens -> operations fail-fast without calling provider
4. Wait for half-open timeout
5. Next operation probes the provider (HALF_OPEN state)
6. If probe succeeds, circuit closes

**Expected Result**: Circuit breaker correctly transitions through CLOSED -> OPEN -> HALF_OPEN -> CLOSED states.

### INT-7: EncryptionService Tenant Key Derivation and Caching

**Boundary**: EncryptionService + TenantKeyCache + PBKDF2/HKDF key derivation

**Setup**: EncryptionService with test master key.

**Steps**:

1. `encryptForTenant('test data', 'tenant-1')` -> encrypted string
2. `decryptForTenant(encrypted, 'tenant-1')` -> 'test data'
3. `decryptForTenant(encrypted, 'tenant-2')` -> throws (different tenant key)
4. Repeat encrypt with same tenant -> verify TenantKeyCache hit (no re-derivation)
5. `deriveContactKey('tenant-1', 'contact-salt')` -> deterministic contact key
6. Verify zero-fill of intermediate key material

**Expected Result**: Tenant isolation at the cryptographic level. Cache avoids re-derivation.

---

## Security & Isolation Tests

- [x] Cross-tenant access returns 404 (tested in `kms-admin-authz.test.ts` for VIEWER/OPERATOR roles)
- [ ] Cross-tenant KMS config access returns 404 (E2E gap -- mock-based unit test exists but not real middleware)
- [ ] Cross-tenant DEK listing returns only own DEKs (not tested)
- [ ] Cross-tenant audit log query returns only own events (not tested)
- [ ] Missing auth returns 401 (tested in `kms-admin-authz.test.ts`)
- [x] Insufficient permissions returns 403 (tested for OPERATOR/VIEWER in authz test)
- [ ] Input validation rejects malformed KMS config (GAP -- no Zod schema validation)
- [ ] External KMS endpoint HTTPS enforcement (tested in `ExternalKMSProvider.validateConfig()` but not E2E)
- [x] Zero-fill on DEK cache eviction (tested in `dek-cache.test.ts`)
- [x] L2 Redis stores only wrapped DEKs (tested in `dek-cache.test.ts`)
- [ ] Header injection prevention in external KMS auth (code exists in `sanitizeHeaderValue()` but not tested)

---

## Unit Test Scenarios

### Existing (all PASS)

| Module            | Input                               | Expected Output                               | Test File                     |
| ----------------- | ----------------------------------- | --------------------------------------------- | ----------------------------- |
| DEKCacheL1        | TTL-expired entry                   | Returns null, zero-fills evicted buffer       | `dek-cache.test.ts`           |
| DEKCacheL1        | Max capacity exceeded               | Evicts LRU entry with zero-fill               | `dek-cache.test.ts`           |
| DEKCacheL2        | Redis unavailable                   | Returns null (graceful degradation)           | `dek-cache.test.ts`           |
| KMSConfigCache    | Cache hit within TTL                | Returns cached ResolvedKMSConfig              | `kms-resolver.test.ts`        |
| KMSConfigCache    | Cache miss                          | Queries MaterializedKMSConfig, caches result  | `kms-resolver.test.ts`        |
| DEKManager        | Concurrent acquireDEK               | E11000 retry reads existing DEK               | `dek-manager.test.ts`         |
| DEKManager        | Force rotate                        | Active -> decrypt_only, cache evicted         | `dek-manager.test.ts`         |
| KMSMaterializer   | 5-level config                      | Correct resolution for each scope             | `kms-materializer.test.ts`    |
| KMSCircuitBreaker | Breaker OPEN state                  | Fail-fast error without calling provider      | `kms-circuit-breaker.test.ts` |
| KMSRotationJob    | Expired active DEKs                 | Bulk update to decrypt_only                   | `kms-rotation-job.test.ts`    |
| KMSAuditLogger    | ClickHouse unavailable              | Emits structured log with \_audit flag        | `kms-audit-logger.test.ts`    |
| ReencryptionQueue | Duplicate job                       | Deduplication by jobId                        | `reencryption-queue.test.ts`  |
| KMSProviderPool   | Max capacity                        | LRU eviction, local never evicted             | `kms-provider-pool.test.ts`   |
| EncryptionService | encrypt('data', 'user1')            | Hex string: iv:authTag:ciphertext             | `engine.test.ts`              |
| EncryptionService | encryptForTenant('data', 'tenant1') | Encrypted string with tenant-derived key      | `engine.test.ts`              |
| EncryptionService | compressAndEncryptForTenant         | Z1: prefix with zstd + AES-GCM                | `compress-encrypt.test.ts`    |
| EncryptionService | decryptWithFallback (previous keys) | Tries current then previous key versions      | `multi-key.test.ts`           |
| EncryptionService | isAlreadyEncrypted guard            | Detects hex 3-part, ENC:v3:, Z1: formats      | `engine-edge-cases.test.ts`   |
| ProviderReadiness | Healthy provider + crypto probe     | Returns cryptoVerified: true                  | `provider-readiness.test.ts`  |
| ProviderReadiness | Unhealthy provider                  | Returns cryptoVerified: false, healthy: false | `provider-readiness.test.ts`  |
| ScopeRegistry     | 10 scopes across 4 categories       | All RBAC mappings reference valid permissions | `platform-key-scopes.test.ts` |
| ScopeCeiling      | OWNER requests all scopes           | Allowed (all scopes within ceiling)           | `platform-key-scopes.test.ts` |
| ScopeCeiling      | VIEWER requests elevated scopes     | Denied (scopes exceed permission ceiling)     | `platform-key-scopes.test.ts` |
| ScopeExpansion    | Expand scopes to RBAC permissions   | Correct union of required permissions         | `platform-key-scopes.test.ts` |
| PlatformKeyUtils  | Key generation + prefix validation  | abl\_ prefix, 8-char prefix, SHA-256 hash     | `platform-keys-unit.test.ts`  |

---

## Performance & Load Tests

| Scenario                       | Target               | How to Measure                                |
| ------------------------------ | -------------------- | --------------------------------------------- |
| DEK cache L1 hit latency       | <100us               | Benchmark with `performance.now()` in test    |
| KMS resolver L1 cache hit rate | >90% after warm-up   | Counter in resolver, check after N operations |
| PBKDF2 key derivation latency  | <50ms per derivation | Time `deriveKey()` call (100K iterations)     |
| Re-encryption throughput       | >100 DEKs/min        | BullMQ job progress tracking                  |
| Config materialization time    | <500ms per tenant    | Time `materialize(tenantId)` with 10 scopes   |

---

## Test Infrastructure

### Required Services

- **MongoDB**: MongoMemoryServer for integration tests, real MongoDB for E2E
- **Redis**: Required for L2 DEK cache, KMS config pub/sub invalidation, BullMQ re-encryption queue
- **ClickHouse**: Required for audit log E2E tests (can be skipped with fallback test)
- **External HTTPS server**: Mock server for external KMS endpoint validation tests

### Data Seeding Strategy

- Create test tenant with `TenantKMSConfig` via API (PUT /config) or direct model insertion for integration tests
- Generate test DEKs via `DEKManager.acquireDEK()` or direct `DEKEntry.create()` with controlled timestamps
- Use `LocalKMSProvider` with deterministic test master key for reproducible encryption

### Environment Variables

| Variable                         | Value for Tests                      |
| -------------------------------- | ------------------------------------ |
| `ENCRYPTION_MASTER_KEY`          | 64-char hex test key (deterministic) |
| `KMS_REENCRYPTION_QUEUE_ENABLED` | `true` (for queue tests) or `false`  |
| `NODE_ENV`                       | `test`                               |

### How to Run

```bash
# All KMS-related runtime tests
pnpm build --filter=runtime && pnpm test --filter=runtime -- --reporter=verbose -t "kms"

# Specific runtime KMS service tests
pnpm test --filter=runtime -- apps/runtime/src/services/kms/__tests__/dek-cache.test.ts
pnpm test --filter=runtime -- apps/runtime/src/services/kms/__tests__/kms-resolver.test.ts
pnpm test --filter=runtime -- apps/runtime/src/services/kms/__tests__/dek-manager.test.ts
pnpm test --filter=runtime -- apps/runtime/src/services/kms/__tests__/kms-materializer.test.ts
pnpm test --filter=runtime -- apps/runtime/src/services/kms/__tests__/kms-circuit-breaker.test.ts
pnpm test --filter=runtime -- apps/runtime/src/services/kms/__tests__/kms-rotation-job.test.ts
pnpm test --filter=runtime -- apps/runtime/src/services/kms/__tests__/kms-audit-logger.test.ts
pnpm test --filter=runtime -- apps/runtime/src/services/kms/__tests__/reencryption-queue.test.ts

# KMS admin route tests
pnpm test --filter=runtime -- apps/runtime/src/__tests__/kms-admin-authz.test.ts
pnpm test --filter=runtime -- apps/runtime/src/__tests__/kms-admin-crud.test.ts
pnpm test --filter=runtime -- apps/runtime/src/__tests__/kms-security.test.ts

# Database package KMS tests
pnpm build --filter=database && pnpm test --filter=database -- --reporter=verbose -t "kms"
pnpm test --filter=database -- packages/database/src/__tests__/kms-provider-pool.test.ts
pnpm test --filter=database -- packages/database/src/__tests__/kms-provider-pool-edge.test.ts
pnpm test --filter=database -- packages/database/src/__tests__/kms-providers.test.ts
pnpm test --filter=database -- packages/database/src/__tests__/local-kms-provider.test.ts
pnpm test --filter=database -- packages/database/src/__tests__/encryption-plugin-kms.test.ts
pnpm test --filter=database -- packages/database/src/__tests__/encryption-e2e.test.ts
pnpm test --filter=database -- packages/database/src/__tests__/encryption-integration.test.ts

# Shared encryption tests
pnpm build --filter=shared && pnpm test --filter=shared -- --reporter=verbose -t "encrypt"
```

---

## Test File Mapping

| Test File                                                               | Type        | Covers      |
| ----------------------------------------------------------------------- | ----------- | ----------- |
| `apps/runtime/src/services/kms/__tests__/dek-cache.test.ts`             | unit        | FR-4        |
| `apps/runtime/src/services/kms/__tests__/kms-resolver.test.ts`          | unit        | FR-2        |
| `apps/runtime/src/services/kms/__tests__/dek-manager.test.ts`           | unit        | FR-3        |
| `apps/runtime/src/services/kms/__tests__/kms-materializer.test.ts`      | unit        | FR-2        |
| `apps/runtime/src/services/kms/__tests__/kms-circuit-breaker.test.ts`   | unit        | FR-5        |
| `apps/runtime/src/services/kms/__tests__/kms-rotation-job.test.ts`      | unit        | FR-6        |
| `apps/runtime/src/services/kms/__tests__/kms-audit-logger.test.ts`      | unit        | FR-8        |
| `apps/runtime/src/services/kms/__tests__/reencryption-queue.test.ts`    | unit        | FR-7        |
| `packages/database/src/__tests__/kms-provider-pool.test.ts`             | unit        | FR-1        |
| `packages/database/src/__tests__/kms-provider-pool-edge.test.ts`        | unit        | FR-1        |
| `packages/database/src/__tests__/kms-providers.test.ts`                 | unit        | FR-1        |
| `packages/database/src/__tests__/local-kms-provider.test.ts`            | unit        | FR-1        |
| `packages/database/src/__tests__/encryption-plugin-kms.test.ts`         | integration | FR-1, FR-3  |
| `packages/database/src/__tests__/encryption-e2e.test.ts`                | integration | FR-1        |
| `packages/database/src/__tests__/encryption-integration.test.ts`        | integration | FR-1        |
| `apps/runtime/src/__tests__/kms-admin-authz.test.ts`                    | unit        | FR-10       |
| `apps/runtime/src/__tests__/kms-admin-crud.test.ts`                     | unit        | FR-10       |
| `apps/runtime/src/__tests__/kms-security.test.ts`                       | unit        | FR-1, FR-5  |
| `packages/shared/src/__tests__/encryption/engine.test.ts`               | unit        | FR-1        |
| `packages/shared/src/__tests__/encryption/engine-edge-cases.test.ts`    | unit        | FR-1        |
| `packages/shared/src/__tests__/encryption/multi-key.test.ts`            | unit        | FR-6        |
| `packages/shared/src/__tests__/encryption/contact-encryption.test.ts`   | unit        | FR-1        |
| `packages/shared/src/__tests__/encryption/compress-encrypt.test.ts`     | unit        | FR-1        |
| `packages/shared/src/__tests__/encryption/cross-compat-proof.test.ts`   | unit        | FR-1        |
| `packages/shared/src/encryption/__tests__/field-interceptor.test.ts`    | unit        | FR-8        |
| `packages/shared/src/encryption/__tests__/secure-queue.test.ts`         | unit        | FR-7        |
| **PLANNED: `apps/runtime/src/__tests__/kms-admin-e2e.test.ts`**         | e2e         | FR-10, FR-9 |
| **PLANNED: `apps/runtime/src/__tests__/kms-dek-lifecycle-e2e.test.ts`** | e2e         | FR-3, FR-6  |
| **PLANNED: `apps/runtime/src/__tests__/kms-materializer-int.test.ts`**  | integration | FR-2        |
| **PLANNED: `apps/runtime/src/__tests__/kms-rotation-int.test.ts`**      | integration | FR-6, FR-7  |
| **PLANNED: `apps/runtime/src/__tests__/kms-reencryption-int.test.ts`**  | integration | FR-7        |

---

## Coverage Gaps & Recommendations

### Critical Gaps

| ID  | Gap                                                           | Impact                                                                       | Recommendation                                                                                                   |
| --- | ------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| K-1 | No E2E test for KMS admin API through full middleware chain   | Cannot verify real auth, rate limiting, feature gate, permission enforcement | Write E2E test starting real Express server on random port, hitting all 7 endpoints with auth + tenant isolation |
| K-2 | No integration test for cloud KMS providers (AWS, Azure, GCP) | 4 of 6 provider types have no coverage against real or mock cloud APIs       | Add integration tests using localstack (AWS), Azurite (Azure), or emulator (GCP) in CI                           |

### High Gaps

| ID  | Gap                                                               | Impact                                                                   | Recommendation                                                                 |
| --- | ----------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| K-3 | No test for external KMS endpoint validator                       | HTTPS enforcement, health check, round-trip, latency validation untested | Add unit tests for `validateExternalKMSEndpoint` with mock ExternalKMSProvider |
| K-4 | No E2E test for DEK re-encryption worker processing               | Batch DEK re-wrapping logic never tested end-to-end                      | Add integration test for `processReencryptionJob` with LocalKMSProvider        |
| K-5 | No E2E for config update -> materialization -> cache invalidation | Full config change pipeline never validated end-to-end                   | Integration test for PUT /config through to resolver returning new config      |

### Medium Gaps

| ID  | Gap                                                          | Impact                                                         | Recommendation                                                              |
| --- | ------------------------------------------------------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| K-6 | No test for KMS rotation job in multi-tenant scenario        | Rotation tested with mocks but not with real DEK registry data | Integration test with MongoMemoryServer and realistic multi-tenant DEK data |
| K-7 | No Playwright E2E for Studio KMS admin UI                    | KMS config form, key listing, health, audit viewing untested   | Add Playwright E2E for KMS page 4-tab workflow                              |
| K-8 | No test for header injection prevention in external KMS auth | `sanitizeHeaderValue()` untested                               | Add unit test for CR/LF/NUL stripping in auth headers                       |

---

## Open Testing Questions

1. Should cloud KMS provider integration tests be added to CI (requires cloud emulators like localstack) or kept as manual/optional tests?
2. Should the KMS admin E2E tests use the real `requirePermission` middleware or a test-configured RBAC setup?
3. What is the expected test execution time budget for KMS tests? PBKDF2 with 100K iterations adds ~50ms per key derivation.
