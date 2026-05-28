# Testing Guide: Encryption at Rest

**Feature**: [Encryption at Rest](../features/encryption-at-rest.md)
**Status**: PARTIAL
**Last Updated**: 2026-04-09

---

## 1. Coverage Matrix

| FR    | Description                                      | Unit | Integration | E2E | Manual | Status             |
| ----- | ------------------------------------------------ | ---- | ----------- | --- | ------ | ------------------ |
| FR-1  | AES-256-GCM encryption for all registered fields | YES  | YES         | NO  | NO     | Unit + Integration |
| FR-2  | Per-tenant key derivation (PBKDF2/HKDF)          | YES  | YES         | NO  | NO     | Unit + Integration |
| FR-3  | Tenant key LRU cache with secure eviction        | YES  | NO          | NO  | NO     | Unit only          |
| FR-4  | Double-encryption detection                      | YES  | NO          | NO  | NO     | Unit only          |
| FR-5  | Three Mongoose encryption versions (v1/v2/v3)    | YES  | YES         | NO  | NO     | Unit + Integration |
| FR-6  | Key rotation with previous key fallback          | YES  | NO          | NO  | NO     | Unit only          |
| FR-7  | Zstd compress-then-encrypt for ClickHouse        | YES  | NO          | NO  | NO     | Unit only          |
| FR-8  | GDPR crypto-shredding (per-contact HKDF)         | YES  | NO          | NO  | NO     | Unit only          |
| FR-9  | Null sentinel on decrypt failure                 | YES  | YES         | NO  | NO     | Unit + Integration |
| FR-10 | Block updateMany/insertMany for encrypted fields | YES  | NO          | NO  | NO     | Unit only          |
| FR-11 | KMS provider support (local, AWS, Azure, GCP)    | YES  | YES         | NO  | NO     | Unit + Integration |
| FR-12 | Master key resolution (vault/env)                | YES  | NO          | NO  | NO     | Unit only          |
| FR-13 | Blind indexing (HMAC-SHA-256)                    | YES  | NO          | NO  | NO     | Unit only          |

---

## 2. Existing Test Inventory

### Unit Tests (39 files)

#### `packages/shared/` — Core engine (17 files)

| File                                                                       | Scenarios | Coverage Area                                 |
| -------------------------------------------------------------------------- | --------- | --------------------------------------------- |
| `packages/shared/src/__tests__/encryption/engine.test.ts`                  | Core      | encrypt/decrypt user & tenant scopes          |
| `packages/shared/src/__tests__/encryption/engine-edge-cases.test.ts`       | Edges     | Invalid input, format errors                  |
| `packages/shared/src/__tests__/encryption/engine-no-zstd.test.ts`          | Fallback  | Graceful degradation without Zstd             |
| `packages/shared/src/__tests__/encryption/cross-compat-proof.test.ts`      | Compat    | Cross-version decrypt compatibility           |
| `packages/shared/src/__tests__/encryption/multi-key.test.ts`               | Rotation  | Previous key fallback decryption              |
| `packages/shared/src/__tests__/encryption/tenant-key-cache.test.ts`        | Cache     | LRU eviction, TTL expiry, zero-fill           |
| `packages/shared/src/__tests__/encryption/key-derivation.test.ts`          | KDF       | PBKDF2 and HKDF derivation                    |
| `packages/shared/src/__tests__/encryption/compress-encrypt.test.ts`        | Compress  | Zstd + AES-GCM roundtrip                      |
| `packages/shared/src/__tests__/encryption/contact-encryption.test.ts`      | Contact   | PII encryption, blind index, shredding        |
| `packages/shared/src/__tests__/encryption/errors.test.ts`                  | Errors    | Error constructor correctness                 |
| `packages/shared/src/__tests__/encryption/index-singleton.test.ts`         | Singleton | Factory lifecycle and reset                   |
| `packages/shared/src/__tests__/encryption/is-encryption-available.test.ts` | Avail     | ENCRYPTION_ENABLED and key checks             |
| `packages/shared/src/__tests__/encryption/master-key-rotation-e2e.test.ts` | Rotation  | Grace period mechanism for key rotation       |
| `packages/shared/src/encryption/__tests__/encryption-manifest.test.ts`     | Manifest  | Table/queue lookup, unregistered throws       |
| `packages/shared/src/encryption/__tests__/field-interceptor.test.ts`       | Fields    | encryptFields/decryptFields, ENC:v3:          |
| `packages/shared/src/encryption/__tests__/secure-queue.test.ts`            | Queue     | wrapJobDataForEncrypt/unwrapJobDataForDecrypt |
| `packages/shared/src/encryption/__tests__/master-key-resolver.test.ts`     | Resolver  | Vault > env fallback, production warning      |

#### `packages/shared-encryption/` — DEK envelope encryption (4 files)

| File                                                                        | Scenarios | Coverage Area                             |
| --------------------------------------------------------------------------- | --------- | ----------------------------------------- |
| `packages/shared-encryption/src/__tests__/engine.test.ts`                   | Core      | EncryptionService with DEK facade         |
| `packages/shared-encryption/src/__tests__/dek-codec.test.ts`                | Codec     | DEK ciphertext encode/decode roundtrip    |
| `packages/shared-encryption/src/__tests__/encryption-context.test.ts`       | Context   | AsyncLocalStorage environment propagation |
| `packages/shared-encryption/src/__tests__/tenant-encryption-facade.test.ts` | Facade    | TenantEncryptionFacade encrypt/decrypt    |

#### `packages/database/` — KMS and plugin (13 files)

| File                                                                        | Scenarios | Coverage Area                                   |
| --------------------------------------------------------------------------- | --------- | ----------------------------------------------- |
| `packages/database/src/__tests__/mongo-plugins.test.ts`                     | Plugin    | Mongoose encryption plugin general              |
| `packages/database/src/__tests__/encryption-plugin-dek.test.ts`             | Plugin    | DEK envelope path in Mongoose plugin            |
| `packages/database/src/__tests__/clickhouse-encryption-interceptor.test.ts` | Fields    | ClickHouse field-level encrypt/decrypt          |
| `packages/database/src/__tests__/kms-providers.test.ts`                     | KMS       | KMS provider interface implementations          |
| `packages/database/src/__tests__/kms-provider-pool.test.ts`                 | KMS       | KMS provider pool caching and lifecycle         |
| `packages/database/src/__tests__/kms-provider-pool-edge.test.ts`            | KMS       | KMS provider pool edge cases                    |
| `packages/database/src/__tests__/kms-resolver.test.ts`                      | KMS       | KMS config resolution (materialized + fallback) |
| `packages/database/src/__tests__/local-kms-provider.test.ts`                | KMS       | Local KMS provider wrap/unwrap                  |
| `packages/database/src/__tests__/cloud-kms-provider-contracts.test.ts`      | KMS       | Cloud KMS provider contracts (mocked SDKs)      |
| `packages/database/src/__tests__/dek-facade-factory.test.ts`                | DEK       | DEK facade factory init and wiring              |
| `packages/database/src/__tests__/sdk-channel-encryption.test.ts`            | Schema    | SDK channel encryption schema validation        |
| `packages/database/src/kms/__tests__/auth-config-encryption.test.ts`        | KMS       | Auth config encrypt/decrypt with KMS            |
| `packages/database/src/kms/__tests__/resolve-auth-config.test.ts`           | KMS       | Auth config resolution                          |

#### `apps/runtime/` — Runtime encryption and KMS (14 unit files)

| File                                                                              | Scenarios   | Coverage Area                                |
| --------------------------------------------------------------------------------- | ----------- | -------------------------------------------- |
| `apps/runtime/src/__tests__/auth/encryption-service.test.ts`                      | Core        | Encryption engine user-scoped                |
| `apps/runtime/src/__tests__/auth/encryption-analyzer.test.ts`                     | Diagnostics | Encryption availability analysis             |
| `apps/runtime/src/__tests__/auth/encryption-salt-lifecycle.test.ts`               | GDPR        | Contact salt assignment and cascade          |
| `apps/runtime/src/__tests__/auth/kms-admin-crud.test.ts`                          | Admin       | KMS admin route CRUD logic                   |
| `apps/runtime/src/__tests__/auth/kms-admin-authz.test.ts`                         | Admin       | KMS admin route authorization                |
| `apps/runtime/src/__tests__/auth/kms-security.test.ts`                            | Security    | Cross-tenant DEK isolation, redaction        |
| `apps/runtime/src/__tests__/execution/contexts/contact/contact-encryptor.test.ts` | Contact     | Contact PII encryption via EncryptionService |
| `apps/runtime/src/services/kms/__tests__/dek-cache.test.ts`                       | Cache       | Multi-layer DEK cache (L1 LRU + L2 Redis)    |
| `apps/runtime/src/services/kms/__tests__/dek-manager.test.ts`                     | DEK         | DEK Manager acquire/unwrap/batch/rotate      |
| `apps/runtime/src/services/kms/__tests__/kms-audit-logger.test.ts`                | Audit       | KMS audit event logging                      |
| `apps/runtime/src/services/kms/__tests__/kms-circuit-breaker.test.ts`             | Resilience  | KMS circuit breaker wrapper                  |
| `apps/runtime/src/services/kms/__tests__/kms-materializer.test.ts`                | Config      | KMS config materialization (5-level chain)   |
| `apps/runtime/src/services/kms/__tests__/kms-resolver.test.ts`                    | Config      | KMS resolver with materialized config        |
| `apps/runtime/src/services/kms/__tests__/kms-rotation-job.test.ts`                | Rotation    | KMS key rotation job logic                   |
| `apps/runtime/src/services/kms/__tests__/reencryption-queue.test.ts`              | Queue       | Re-encryption queue enqueue and shutdown     |

#### Other packages (3 files)

| File                                                                          | Scenarios | Coverage Area                          |
| ----------------------------------------------------------------------------- | --------- | -------------------------------------- |
| `packages/agent-transfer/src/__tests__/unit/session-field-encryption.test.ts` | Transfer  | Tenant-scoped session field encryption |
| `packages/compiler/src/__tests__/security/encrypted-vault.test.ts`            | Vault     | PIIVault encrypt/decrypt               |

### Integration Tests (8 files)

| File                                                                                      | Scenarios     | Coverage Area                                    |
| ----------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------ |
| `packages/database/src/__tests__/encryption-toggle-e2e.test.ts`                           | Toggle        | Encryption enable/disable toggle                 |
| `packages/database/src/__tests__/dek-credential-roundtrip.test.ts`                        | DEK Roundtrip | DEK credential roundtrip with real MongoDB       |
| `packages/database/src/__tests__/dek-full-chain.test.ts`                                  | Full Chain    | DEKManager -> Facade -> Plugin -> MongoDB        |
| `packages/database/src/__tests__/kms-e2e-full-chain.test.ts`                              | KMS Chain     | Full KMS chain with real MongoDB and LocalKMS    |
| `packages/database/src/__tests__/dek-lifecycle-cloud-e2e.test.ts`                         | Cloud DEK     | DEK lifecycle with mocked cloud KMS providers    |
| `packages/database/src/__tests__/kms-pool-cloud-integration.test.ts`                      | Cloud Pool    | KMS pool with cloud provider simulation          |
| `apps/runtime/src/__tests__/auth/kms-per-tenant-integration.test.ts`                      | Multi-tenant  | Per-tenant KMS with full stack                   |
| `packages/connectors/src/__tests__/integration/credential-encryption.integration.test.ts` | Connectors    | Connection binding model (no credential storage) |

### E2E Tests

No E2E tests exercise encryption through the full HTTP API path (GAP-005).

---

## 3. E2E Test Scenarios (Mandatory — minimum 5)

### E2E-1: LLM Credential Encryption Roundtrip

**Objective**: Verify that creating an LLM credential via HTTP API encrypts the API key at rest and returns decrypted plaintext on read.

**Prerequisites**: Running Studio/Runtime server with `ENCRYPTION_MASTER_KEY` configured, authenticated user with tenant context.

**Steps**:

1. POST `/api/tenant-credentials` with `{ provider: "openai", name: "test", apiKey: "sk-test-key-12345" }`
2. Assert 201 response returns the credential without ciphertext leaking
3. Query MongoDB directly to verify `encryptedApiKey` field contains ciphertext (not plaintext `sk-test-key-12345`)
4. Verify the `ire` field is `'v3'` on the stored document
5. GET `/api/tenant-credentials/:id` and assert the API key is returned as decrypted plaintext

**Expected Result**: API key stored as ciphertext in MongoDB, returned as plaintext via API. The ciphertext should be a hex 3-part format (iv:authTag:encrypted).

**Validates**: FR-1 (encryption before storage), FR-5 (v3 version), FR-9 (no ciphertext leak)

---

### E2E-2: Environment Variable Encryption with Tenant Isolation

**Objective**: Verify that environment variables are encrypted per-tenant and that cross-tenant access returns 404.

**Prerequisites**: Two tenants (A and B) with authenticated users, `ENCRYPTION_MASTER_KEY` configured.

**Steps**:

1. As Tenant A, POST `/api/projects/:projectId/environment-variables` with `{ key: "DB_PASSWORD", value: "secret123", isSecret: true }`
2. Assert 201, verify value is returned decrypted
3. Query MongoDB to verify `encryptedValue` is ciphertext
4. As Tenant B, attempt GET `/api/projects/:projectIdA/environment-variables/:id` — expect 404
5. As Tenant A, GET the variable — expect decrypted `"secret123"`

**Expected Result**: Encryption is tenant-scoped; cross-tenant access is blocked at 404 level (not 403).

**Validates**: FR-1, FR-2 (per-tenant key derivation), tenant isolation

---

### E2E-3: Auth Profile Secret Encryption and Update

**Objective**: Verify that auth profile secrets are encrypted on create and re-encrypted on update.

**Prerequisites**: Running server, authenticated user, OAuth2 auth profile data.

**Steps**:

1. POST `/api/projects/:projectId/auth-profiles` with OAuth2 config including `clientSecret`
2. Assert 201, verify `encryptedSecrets` is not returned as plaintext ciphertext
3. Query MongoDB to verify `encryptedSecrets` is ciphertext and `ire` is `'v3'`
4. PUT `/api/projects/:projectId/auth-profiles/:id` with updated `clientSecret`
5. Query MongoDB to verify ciphertext changed (new IV means new ciphertext even for same plaintext)
6. GET the auth profile and verify the updated secret is returned decrypted

**Expected Result**: Secrets encrypted on create and re-encrypted on update with new IV.

**Validates**: FR-1, FR-5 (v3 re-encryption on save), FR-4 (no double-encryption)

---

### E2E-4: Session State Encryption in Mongoose

**Objective**: Verify that session state data (`stateData`, `irData`, `compilationData`) is encrypted at rest.

**Prerequisites**: Running runtime with active agent, `ENCRYPTION_MASTER_KEY` configured.

**Steps**:

1. Create a new session via the runtime WebSocket/API
2. Send a message to generate agent execution (which populates session state)
3. Query MongoDB `session_states` collection to verify `stateData` and `irData` are ciphertext
4. Verify `ire` field is `'v3'` on the session state document
5. Retrieve session state via API and verify it contains decrypted JSON data

**Expected Result**: Session state stored as ciphertext, returned decrypted via API.

**Validates**: FR-1, FR-5, FR-9

---

### E2E-5: Message Content Encryption

**Objective**: Verify that conversation message content is encrypted in MongoDB.

**Prerequisites**: Running runtime with active agent session.

**Steps**:

1. Send a user message through the runtime
2. Wait for agent response
3. Query MongoDB `messages` collection to verify `content` field is ciphertext
4. Verify `ire` field is `'v3'`
5. Retrieve messages via API and verify content is decrypted plaintext

**Expected Result**: Message content stored encrypted, returned decrypted.

**Validates**: FR-1, FR-5

---

### E2E-6: Key Rotation with Fallback Decryption

**Objective**: Verify that after key rotation, old data can still be decrypted using previous key fallback.

**Prerequisites**: Two master keys (current and previous), encrypted data from previous key.

**Steps**:

1. Start server with MASTER_KEY_V1, create encrypted credential
2. Restart server with MASTER_KEY_V2 as current and MASTER_KEY_V1 as previous
3. GET the previously created credential — should decrypt via fallback
4. Create a new credential — should encrypt with V2
5. Both old and new credentials should be readable

**Expected Result**: `decryptWithFallback` successfully decrypts old data; new data uses current key.

**Validates**: FR-6 (key rotation with fallback)

---

### E2E-7: Decrypt Failure Returns Null (No Ciphertext Leak)

**Objective**: Verify that when decryption fails (wrong key, corrupted data), the API returns null rather than ciphertext.

**Prerequisites**: Encrypted data with intentionally corrupted ciphertext or mismatched key.

**Steps**:

1. Create an encrypted credential with valid key
2. Corrupt the ciphertext in MongoDB directly (modify the `encryptedApiKey` field)
3. GET the credential via API
4. Assert the API key field is `null` (not the corrupted ciphertext)
5. Verify `_decryptionFailed` is set in the internal document state

**Expected Result**: Null returned, no ciphertext leakage to API consumers.

**Validates**: FR-9 (null sentinel on decrypt failure)

---

## 4. Integration Test Scenarios (Mandatory — minimum 5)

### INT-1: Mongoose Encryption Plugin v1/v2/v3 Version Detection

**Objective**: Test that the Mongoose plugin correctly detects and decrypts documents from all three encryption versions.

**Setup**: MongoMemoryServer with encryption configured.

**Steps**:

1. Create a document with v1 encryption (set `ire: 'v1'`, master key CEK)
2. Create a document with v2 encryption (set `ire: 'v2'`, KMS CEK)
3. Create a document with v3 encryption (set `ire: 'v3'`, tenant-scoped)
4. Read all three documents and verify all decrypt correctly
5. Save a v1 document — verify it upgrades to v3 on save

**Validates**: FR-5 (multi-version support)

---

### INT-2: KMS Provider Pool Lifecycle

**Objective**: Test KMS provider pool initialization, provider caching, LRU eviction, and health checks.

**Setup**: `KMSProviderPool` with `LocalKMSProvider` and mock cloud providers.

**Steps**:

1. Initialize pool with local provider
2. Request providers for different configs — verify caching by fingerprint
3. Fill pool to max size — verify LRU eviction occurs
4. Simulate unhealthy provider — verify eviction on health check failure
5. Shutdown pool — verify all providers shut down and keys zero-filled

**Validates**: FR-11 (KMS provider support), performance (pool caching)

---

### INT-3: ClickHouse Field Interceptor with Compress-Then-Encrypt

**Objective**: Test field-level encryption for ClickHouse with Zstd compression for large payloads.

**Setup**: `EncryptionService` instance with known master key.

**Steps**:

1. Create a large JSON payload (>64 bytes) — encrypt with `compressAndEncryptForTenant`
2. Verify the encrypted output starts with `Z1:` prefix (compressed)
3. Decrypt with `decryptAndDecompressForTenant` — verify original JSON recovered
4. Create a small payload (<64 bytes) — encrypt, verify `N0:` prefix (uncompressed)
5. Test with `encryptFields`/`decryptFields` interceptor — verify `ENC:v3:` prefix

**Validates**: FR-7 (Zstd compress-then-encrypt), FR-1 (field-level encryption)

---

### INT-4: GDPR Crypto-Shredding via Contact Key Chain

**Objective**: Test that deleting a contact's encryption salt renders their PII irrecoverable.

**Setup**: `EncryptionService` with known master key, test tenant and contact salt.

**Steps**:

1. Derive contact key: `deriveContactKey(tenantId, contactSalt)`
2. Encrypt contact PII: `encryptContactPII(tenantId, "user@example.com")`
3. Decrypt and verify: `decryptContactPII(tenantId, ciphertext)` returns `"user@example.com"`
4. Create blind index: `blindIndex(tenantId, "user@example.com")`
5. Simulate shredding: attempt decrypt with `null` salt — expect `contactSaltMissing` error
6. Verify: the encrypted PII data is now irrecoverable

**Validates**: FR-8 (GDPR crypto-shredding), FR-13 (blind indexing)

---

### INT-5: BullMQ Secure Queue Encrypt/Decrypt Roundtrip

**Objective**: Test that BullMQ job data is encrypted for registered queues and passed through for non-encrypted queues.

**Setup**: `EncryptionService` instance, mock queue names from manifest.

**Steps**:

1. Wrap job data for `llm-requests` queue (encrypted) — verify `message` field is encrypted, `_enc` marker present
2. Unwrap the same data — verify `message` field is decrypted back to original
3. Wrap job data for `search-ingestion` queue (not encrypted) — verify data passes through unchanged
4. Attempt wrap for unregistered queue — expect error thrown
5. Verify `tenantId` is required for encrypted queues

**Validates**: FR-1 (Redis encryption), FR-10 (pipeline integrity)

---

### INT-6: Double-Encryption Detection Across All Layers

**Objective**: Verify that double-encryption is detected and rejected at every entry point.

**Setup**: `EncryptionService` instance, Mongoose model with encryption plugin.

**Steps**:

1. Encrypt a value with `encryptForTenant` — attempt to encrypt the result again — expect error
2. Use `encryptFields` interceptor on already-encrypted row (with `_enc` flag) — expect error
3. Use `encryptFields` on a field with `ENC:v3:` prefix — expect error
4. Save a document via Mongoose plugin — attempt save again without modifying encrypted fields — verify no re-encryption occurs

**Validates**: FR-4 (double-encryption detection)

---

### INT-7: Tenant Key Cache Eviction and Security

**Objective**: Verify that the tenant key cache correctly evicts entries and zero-fills key material.

**Setup**: `TenantKeyCache` with small max size and short TTL.

**Steps**:

1. Set cache max size to 3 and TTL to 100ms
2. Add 3 tenant keys — verify all are retrievable
3. Add 4th key — verify LRU eviction of the oldest
4. Wait 100ms — verify TTL expiry removes entries
5. Verify evicted key buffers are zero-filled (`Buffer.fill(0)`)
6. Clear cache — verify all entries zero-filled

**Validates**: FR-3 (LRU cache with secure eviction)

---

## 5. Test Environment Requirements

### Infrastructure

- **MongoDB**: MongoMemoryServer for unit/integration tests; real MongoDB for E2E
- **Redis**: Local Redis or Redis mock for BullMQ queue tests
- **ClickHouse**: Not required for current tests (interceptor tests are unit-level)
- **Environment Variables**: `ENCRYPTION_MASTER_KEY` must be set (64 hex chars)

### Test Data

- Master key: `a]` hex string (32 bytes) — generate via `crypto.randomBytes(32).toString('hex')`
- Previous master key: separate hex string for rotation tests
- Tenant IDs: UUIDs
- Contact salts: random strings for GDPR tests

### Authentication

- E2E tests require authenticated user with tenant context
- Use the normal signup flow, `--workspace-email` tenant bootstrap, or test helpers to create tenant + user

---

## 6. Test Anti-Patterns to Avoid

1. **Never mock `EncryptionService` in E2E tests** — the whole point is testing real encryption
2. **Never store plaintext "expected ciphertext" in tests** — ciphertext changes per encryption due to random IV
3. **Never skip tenant isolation checks** — always verify cross-tenant access returns 404
4. **Never use `findById` in test assertions** — use `findOne({ _id, tenantId })` per platform rules
5. **Never hardcode master keys in committed test files** — generate at test setup time

---

## 7. Gaps and Priorities

### Priority 1 (High Impact)

- **E2E-1 through E2E-5**: Basic encryption roundtrip through HTTP API — validates the most common paths
- **INT-1**: Multi-version Mongoose plugin — validates backward compatibility

### Priority 2 (Medium Impact)

- **E2E-6**: Key rotation — validates production key lifecycle
- **E2E-7**: Null sentinel — validates security property
- **INT-3**: ClickHouse compress-then-encrypt — validates analytics pipeline
- **INT-4**: GDPR crypto-shredding — validates compliance

### Priority 3 (Lower Impact)

- **INT-2**: KMS provider pool lifecycle — validates enterprise feature
- **INT-5**: BullMQ secure queue — validates queue encryption
- **INT-6**: Double-encryption detection — validates safety guard
- **INT-7**: Cache eviction — validates performance/security

### Partially Addressed (since 2026-03-22)

- Cloud KMS provider contract tests exist (`cloud-kms-provider-contracts.test.ts`, `dek-lifecycle-cloud-e2e.test.ts`, `kms-pool-cloud-integration.test.ts`) with mocked SDKs performing real AES-256-GCM crypto -- but no tests against real cloud endpoints
- Re-encryption queue infrastructure tested (`reencryption-queue.test.ts`) -- enqueue, shutdown, jobId dedup -- but no automatic background job wired yet
- DEK credential roundtrip and full KMS chain integration tests added (`dek-credential-roundtrip.test.ts`, `kms-e2e-full-chain.test.ts`, `dek-full-chain.test.ts`)

### Not Yet Scoped

- Cloud KMS integration tests against real AWS/Azure/GCP endpoints (requires credentials)
- Performance benchmarks (encrypt/decrypt latency under load)
- Migration tests (v1 -> v2 -> v3 progressive upgrade)
- HTTP API E2E tests (create credential -> verify encrypted in DB -> read decrypted via API)
