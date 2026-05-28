# Low-Level Design: Encryption at Rest

**Feature**: [Encryption at Rest](../features/encryption-at-rest.md)
**HLD**: [encryption-at-rest.hld.md](../specs/encryption-at-rest.hld.md)
**Test Spec**: [encryption-at-rest.md](../testing/encryption-at-rest.md)
**Status**: Current (reflects implemented state + gap-closure plan)
**Date**: 2026-03-22

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                 | Rationale                                                                              | Alternatives Rejected                                   |
| --- | -------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| D1  | Application-layer encryption (not CSFLE or TDE)          | Covers all three stores, enables tenant isolation and GDPR shredding                   | MongoDB CSFLE (single-store), TDE (no tenant isolation) |
| D2  | Mongoose plugin for transparent MongoDB encryption       | Zero code changes in route handlers; hooks fire on all save/find paths                 | Manual encrypt/decrypt calls in every route             |
| D3  | PBKDF2 as default strategy (not HKDF)                    | Backward compatibility with existing encrypted data; HKDF added for new paths          | HKDF-only (would break existing v1/v2 data)             |
| D4  | Three encryption versions (v1/v2/v3) coexisting          | Backward compatibility during migration from master key → KMS → tenant-scoped          | Force migration (downtime risk)                         |
| D5  | Tenant key cache with LRU eviction                       | PBKDF2 is ~10-50ms; caching reduces to <1ms for 99%+ of operations                     | No caching (unacceptable latency at scale)              |
| D6  | Compress-then-encrypt (not encrypt-then-compress)        | Encrypted data is high-entropy and incompressible; must compress before encryption     | Encrypt-then-compress (zero compression ratio)          |
| D7  | Null sentinel on decrypt failure (not error propagation) | Prevents ciphertext leaking to API consumers; downstream can check `_decryptionFailed` | Throw error (would break API responses)                 |
| D8  | Per-contact HKDF key chain for GDPR shredding            | Salt deletion renders PII irrecoverable without touching encrypted records             | Delete all contact records (expensive, error-prone)     |
| D9  | KMS provider pool with fingerprint-based caching         | Avoids re-creating expensive cloud KMS connections per request                         | New connection per request (latency, rate limits)       |
| D10 | Encryption manifest as centralized registry              | Single source of truth for which fields/tables/queues are encrypted                    | Distributed configuration (hard to audit)               |

### Key Interfaces & Types

```typescript
// packages/shared/src/encryption/types.ts
type EncryptionScope = 'user' | 'tenant' | 'contact';
type KeyDerivationStrategy = 'pbkdf2' | 'hkdf';

interface EncryptionServiceConfig {
  masterKeyHex: string;
  defaultStrategy?: KeyDerivationStrategy; // default: 'pbkdf2'
  cache?: { maxSize?: number; ttlMs?: number };
  previous?: Array<{ version: number; masterKeyHex: string }>;
}

interface KeyDerivation {
  readonly name: KeyDerivationStrategy;
  deriveKey(masterKey: Buffer, salt: string): Buffer;
}

// packages/database/src/kms/types.ts
interface KMSProvider {
  readonly providerType: string;
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  healthCheck(): Promise<KMSHealthStatus>;
  generateDataKey(keyId: string): Promise<GenerateDataKeyResult>;
  wrapKey(keyId: string, plaintext: Buffer): Promise<WrapKeyResult>;
  unwrapKey(keyId: string, ciphertext: Buffer, keyVersion?: number): Promise<Buffer>;
  encrypt(keyId: string, plaintext: Buffer): Promise<Buffer>;
  decrypt(keyId: string, ciphertext: Buffer): Promise<Buffer>;
  createKey(purpose: KeyPurpose): Promise<KMSKeyMetadata>;
  describeKey(keyId: string): Promise<KMSKeyMetadata>;
  enableKeyRotation(keyId: string, intervalDays: number): Promise<void>;
  scheduleKeyDeletion(keyId: string, pendingWindowDays?: number): Promise<void>;
}

// packages/database/src/mongo/plugins/encryption.plugin.ts
interface EncryptionPluginOptions {
  fieldsToEncrypt: string[];
  tenantIdField?: string; // default: 'tenantId'
  skipTenantScoping?: boolean; // for User, ServiceNode
}
```

### Module Boundaries

| Module                                 | Responsibility                                  | Dependencies                               |
| -------------------------------------- | ----------------------------------------------- | ------------------------------------------ |
| `packages/shared/src/encryption/`      | Core encryption engine, key derivation, caching | `node:crypto`, `node:zlib`                 |
| `packages/database/src/mongo/plugins/` | Mongoose encryption plugin (v1/v2/v3)           | `mongoose`, `@agent-platform/database/kms` |
| `packages/database/src/kms/`           | KMS provider abstraction, pool, registry        | Cloud SDKs (dynamic import)                |
| `packages/database/src/models/`        | KMS config models (TenantKMSConfig, etc.)       | `mongoose`                                 |
| `apps/studio/src/services/security/`   | Key rotation service                            | `@agent-platform/shared`                   |

---

## 2. File-Level Change Map

### Existing Files (Implemented)

#### Core Encryption Engine (packages/shared/src/encryption/)

| File                        | Purpose                      | LOC  | Risk |
| --------------------------- | ---------------------------- | ---- | ---- |
| `engine.ts`                 | Core EncryptionService class | ~320 | High |
| `types.ts`                  | Type definitions             | ~23  | Low  |
| `constants.ts`              | Cryptographic constants      | ~21  | Low  |
| `key-derivation/pbkdf2.ts`  | PBKDF2 key derivation        | ~12  | Med  |
| `key-derivation/hkdf.ts`    | HKDF key derivation          | ~12  | Med  |
| `cache/tenant-key-cache.ts` | LRU tenant key cache         | ~58  | Med  |
| `encryption-manifest.ts`    | ClickHouse + Redis manifests | ~94  | Low  |
| `field-interceptor.ts`      | encryptFields/decryptFields  | ~57  | Med  |
| `secure-queue.ts`           | BullMQ job data wrappers     | ~36  | Low  |
| `master-key-resolver.ts`    | Vault/env key resolution     | ~34  | Med  |
| `errors.ts`                 | Error constructors           | ~25  | Low  |
| `index.ts`                  | Barrel exports + singleton   | ~103 | Low  |

#### Mongoose Plugin (packages/database/src/mongo/plugins/)

| File                   | Purpose                             | LOC  | Risk |
| ---------------------- | ----------------------------------- | ---- | ---- |
| `encryption.plugin.ts` | v1/v2/v3 Mongoose encryption plugin | ~785 | High |

#### KMS Layer (packages/database/src/kms/)

| File                                      | Purpose                   | LOC  | Risk |
| ----------------------------------------- | ------------------------- | ---- | ---- |
| `types.ts`                                | KMS provider interface    | ~166 | Med  |
| `kms-registry.ts`                         | Singleton + pool registry | ~134 | Med  |
| `kms-provider-pool.ts`                    | Multi-provider pool       | ~224 | Med  |
| `local-kms-provider.ts`                   | Dev/test local provider   | ~312 | Med  |
| `providers/aws-kms-provider.ts`           | AWS KMS                   | ~200 | High |
| `providers/azure-keyvault-provider.ts`    | Azure Key Vault           | ~200 | High |
| `providers/azure-managed-hsm-provider.ts` | Azure Managed HSM         | ~150 | High |
| `providers/gcp-cloud-kms-provider.ts`     | GCP Cloud KMS             | ~200 | High |
| `providers/external-kms-provider.ts`      | External KMS via REST     | ~250 | High |
| `providers/index.ts`                      | Provider factory          | ~50  | Low  |
| `index.ts`                                | Barrel exports            | ~62  | Low  |

#### Key Rotation (apps/studio/src/services/security/)

| File                      | Purpose                | LOC  | Risk |
| ------------------------- | ---------------------- | ---- | ---- |
| `key-rotation-service.ts` | Key version management | ~213 | Med  |

#### KMS Data Models (packages/database/src/models/)

| File                               | Purpose                  | LOC  | Risk |
| ---------------------------------- | ------------------------ | ---- | ---- |
| `tenant-kms-config.model.ts`       | Per-tenant KMS config    | ~189 | Med  |
| `materialized-kms-config.model.ts` | Pre-resolved KMS config  | ~110 | Med  |
| `dek-registry.model.ts`            | Epoch-scoped DEK entries | ~86  | Med  |
| `key-version.model.ts`             | Key version lifecycle    | ~61  | Low  |

### Gap-Closure: New Files Needed

| File                                                                           | Purpose                                  | LOC Estimate |
| ------------------------------------------------------------------------------ | ---------------------------------------- | ------------ |
| `packages/shared/src/__tests__/encryption/http-api-roundtrip.e2e.test.ts`      | E2E: encryption through HTTP API         | ~200         |
| `packages/database/src/__tests__/encryption-multi-version.integration.test.ts` | Integration: v1/v2/v3 Mongoose roundtrip | ~150         |
| `packages/database/src/__tests__/kms-provider-pool.integration.test.ts`        | Integration: KMS pool lifecycle          | ~120         |

### Gap-Closure: Modified Files Needed

| File                                                       | Change Description                     | Risk |
| ---------------------------------------------------------- | -------------------------------------- | ---- |
| `packages/shared/src/encryption/master-key-resolver.ts`    | Replace stub logger with createLogger  | Low  |
| `packages/database/src/mongo/plugins/encryption.plugin.ts` | Replace console.warn with createLogger | Low  |

---

## 3. Implementation Phases

Feature is fully implemented. The phases below document the gap-closure work needed to reach STABLE status.

### Phase 1: Logger Fixes (Low Risk)

**Goal**: Replace stub/console loggers with proper `createLogger` for production observability.

**Tasks**:
1.1. Replace stub logger in `master-key-resolver.ts` with `createLogger('master-key-resolver')` from `@agent-platform/shared`
1.2. Replace `console.warn` in `encryption.plugin.ts` with `createLogger('encryption-plugin')` (note: database package may need a lightweight logger to avoid circular deps)
1.3. Run `pnpm build --filter=shared --filter=database` to verify no circular dependency issues

**Files Touched**:

- `packages/shared/src/encryption/master-key-resolver.ts`
- `packages/database/src/mongo/plugins/encryption.plugin.ts`

**Exit Criteria**:

- [ ] No `console.warn` or stub loggers in encryption paths
- [ ] `pnpm build` passes for affected packages
- [ ] Existing unit tests pass (`pnpm test --filter=shared --filter=database`)

---

### Phase 2: Integration Tests (Medium Risk)

**Goal**: Add integration tests for the three highest-risk integration boundaries.

**Tasks**:
2.1. Create `encryption-multi-version.integration.test.ts`: v1/v2/v3 Mongoose roundtrip with MongoMemoryServer
2.2. Create `kms-provider-pool.integration.test.ts`: Pool lifecycle, LRU eviction, health checks
2.3. Add tests for GDPR crypto-shredding: contact key derivation, PII encrypt/decrypt, salt deletion renders irrecoverable
2.4. Add tests for BullMQ secure queue: wrap/unwrap roundtrip, non-encrypted queue passthrough
2.5. Add tests for double-encryption detection across all three layers

**Files Touched**:

- NEW: `packages/database/src/__tests__/encryption-multi-version.integration.test.ts`
- NEW: `packages/database/src/__tests__/kms-provider-pool.integration.test.ts`
- Extend: `packages/shared/src/__tests__/encryption/contact-encryption.test.ts` (add shredding scenario)
- Extend: `packages/shared/src/encryption/__tests__/secure-queue.test.ts` (add passthrough scenario)
- Extend: `packages/shared/src/encryption/__tests__/field-interceptor.test.ts` (add double-encryption scenario)

**Exit Criteria**:

- [ ] 5+ integration test scenarios passing
- [ ] Coverage matrix updated for FR-5, FR-8, FR-10, FR-11
- [ ] `pnpm test --filter=shared --filter=database` passes

---

### Phase 3: E2E Tests (High Risk)

**Goal**: Add E2E tests that exercise encryption through the full HTTP API layer.

**Tasks**:
3.1. Create test infrastructure: start Studio/Runtime Express on random port with real MongoDB and `ENCRYPTION_MASTER_KEY`
3.2. Implement E2E-1: LLM credential create → verify ciphertext in DB → read returns plaintext
3.3. Implement E2E-2: Environment variable with tenant isolation (cross-tenant 404)
3.4. Implement E2E-3: Auth profile secret encrypt on create, re-encrypt on update
3.5. Implement E2E-7: Corrupt ciphertext → verify null sentinel returned (no ciphertext leak)
3.6. Implement E2E-6: Key rotation with fallback (two master keys, old data still readable)

**Files Touched**:

- NEW: `packages/shared/src/__tests__/encryption/http-api-roundtrip.e2e.test.ts` (or appropriate location)
- Uses: Real HTTP requests to Studio/Runtime API endpoints
- Uses: Direct MongoDB queries to verify ciphertext at rest

**Exit Criteria**:

- [ ] 5+ E2E scenarios passing
- [ ] No mocking of EncryptionService (real encryption exercised)
- [ ] Cross-tenant isolation verified (404 on cross-tenant access)
- [ ] Null sentinel verified on decrypt failure
- [ ] GAP-005 resolved

---

### Phase 4: PBKDF2 Iteration Increase (Medium Risk)

**Goal**: Increase PBKDF2 iterations from 100K to 600K per OWASP 2023 recommendations.

**Tasks**:
4.1. Update `PBKDF2_ITERATIONS` in `constants.ts` from 100,000 to 600,000
4.2. Add backward compatibility: `PreviousKeyConfig` already supports old master key; need to also support old iteration count for re-derivation
4.3. Update performance budget: cache miss derivation time increases from ~10-50ms to ~60-300ms
4.4. Verify tenant key cache mitigates the impact (cache hit rate should be >99%)
4.5. Update unit tests that assert on specific iteration counts
4.6. Load test with production-like tenant count to verify acceptable latency

**Files Touched**:

- `packages/shared/src/encryption/constants.ts`
- `packages/shared/src/encryption/key-derivation/pbkdf2.ts` (add iteration count as parameter)
- `packages/shared/src/__tests__/encryption/key-derivation.test.ts`

**Exit Criteria**:

- [ ] PBKDF2 iterations at 600K
- [ ] Existing data still decryptable (backward compat with 100K-derived keys)
- [ ] Cache miss latency < 500ms under load
- [ ] GAP-001 resolved

---

### Phase 5: Auto Re-Encryption Job (Medium Risk)

**Goal**: Implement background re-encryption queue to migrate data from old to new keys.

**Tasks**:
5.1. Implement BullMQ re-encryption worker that reads documents with old key version, decrypts, re-encrypts with current key
5.2. Support batched processing with configurable concurrency (from `TenantKMSConfig.reencryption` settings)
5.3. Track progress per-collection: total documents, processed, failed
5.4. Implement distributed lock to prevent concurrent re-encryption of the same document
5.5. Add admin API to trigger re-encryption for a tenant
5.6. Add integration tests for re-encryption worker

**Files Touched**:

- NEW: `packages/shared/src/encryption/reencryption-worker.ts`
- Extend: `packages/shared/src/encryption/encryption-manifest.ts` (add reencryption-queue config)
- NEW: Admin API route for triggering re-encryption
- NEW: Integration tests

**Exit Criteria**:

- [ ] Re-encryption worker processes all documents for a tenant
- [ ] Progress tracking per-collection
- [ ] Distributed lock prevents double-processing
- [ ] GAP-002 resolved

---

## 4. Wiring Checklist

| #   | Wiring Item                                                   | Status  | File                                                       |
| --- | ------------------------------------------------------------- | ------- | ---------------------------------------------------------- |
| W1  | `getEncryptionService()` singleton initialized at app startup | DONE    | Server startup files in runtime/studio                     |
| W2  | `setTenantEncryption()` called after EncryptionService init   | DONE    | `packages/database/src/mongo/plugins/encryption.plugin.ts` |
| W3  | `setMasterKey()` called at startup                            | DONE    | Server startup files                                       |
| W4  | `setKMSProviderPool()` called at startup when KMS configured  | DONE    | `packages/database/src/kms/kms-registry.ts`                |
| W5  | Encryption plugin applied to all 16 models                    | DONE    | 16 model files in `packages/database/src/models/`          |
| W6  | ClickHouse manifests cover all 5 encrypted tables             | DONE    | `encryption-manifest.ts`                                   |
| W7  | Redis queue manifests cover all 2 encrypted queues            | DONE    | `encryption-manifest.ts`                                   |
| W8  | `ENCRYPTION_MASTER_KEY` in secrets-manifest.json              | DONE    | `scripts/secrets-manifest.json`                            |
| W9  | Production checks validate master key presence                | DONE    | `packages/config/src/validation/production-checks.ts`      |
| W10 | Logger in master-key-resolver uses createLogger               | PENDING | Phase 1 gap closure                                        |
| W11 | Logger in encryption.plugin uses createLogger                 | PENDING | Phase 1 gap closure                                        |
| W12 | E2E tests exercise HTTP API encryption path                   | PENDING | Phase 3 gap closure                                        |
| W13 | Re-encryption worker connected to BullMQ                      | PENDING | Phase 5 gap closure                                        |

---

## 5. Test Plan

### Unit Tests (Existing — all passing)

18 test files in `packages/shared/src/__tests__/encryption/` and `packages/shared/src/encryption/__tests__/`. See [Test Spec Section 2](../testing/encryption-at-rest.md#2-existing-test-inventory) for full inventory.

### Integration Tests (Gap — Phase 2)

| Scenario                            | FR Coverage | Priority |
| ----------------------------------- | ----------- | -------- |
| Mongoose v1/v2/v3 version detection | FR-5        | P1       |
| KMS provider pool lifecycle         | FR-11       | P1       |
| GDPR crypto-shredding               | FR-8        | P1       |
| BullMQ secure queue roundtrip       | FR-1, FR-10 | P2       |
| Double-encryption detection         | FR-4        | P2       |
| Tenant key cache eviction/security  | FR-3        | P2       |
| ClickHouse compress-then-encrypt    | FR-7        | P2       |

### E2E Tests (Gap — Phase 3)

| Scenario                                   | FR Coverage | Priority |
| ------------------------------------------ | ----------- | -------- |
| LLM credential encryption roundtrip        | FR-1, FR-5  | P1       |
| Environment variable with tenant isolation | FR-1, FR-2  | P1       |
| Auth profile secret encrypt/update         | FR-1, FR-4  | P1       |
| Null sentinel on decrypt failure           | FR-9        | P1       |
| Key rotation with fallback                 | FR-6        | P2       |
| Session state encryption                   | FR-1, FR-5  | P2       |
| Message content encryption                 | FR-1, FR-5  | P2       |

---

## 6. Rollback Strategy

### Phase-Level Rollback

| Phase | Rollback Action                                                  | Data Impact                  |
| ----- | ---------------------------------------------------------------- | ---------------------------- |
| 1     | Revert logger changes — no data impact                           | None                         |
| 2     | Delete new test files — no production impact                     | None                         |
| 3     | Delete new E2E test files — no production impact                 | None                         |
| 4     | Revert PBKDF2_ITERATIONS to 100K — old keys still work via cache | None (keys cached for 30min) |
| 5     | Stop re-encryption worker — data stays on old key version        | None                         |

### Full Feature Rollback

1. Set `ENCRYPTION_ENABLED=false` in environment
2. New writes are plaintext; existing encrypted data remains encrypted
3. Re-enable by setting `ENCRYPTION_ENABLED=true` and ensuring `ENCRYPTION_MASTER_KEY` is set
4. Existing encrypted data decrypts normally; new plaintext data stays plaintext until next save

### Key Compromise Response

1. Generate new master key: `crypto.randomBytes(32).toString('hex')`
2. Add compromised key to `ENCRYPTION_PREVIOUS_MASTER_KEYS` for read fallback
3. Set new key as `ENCRYPTION_MASTER_KEY`
4. Deploy — new writes use new key, old data decryptable via fallback
5. Trigger re-encryption (Phase 5) to migrate all data to new key
6. After re-encryption complete, remove compromised key from previous keys

---

## 7. Dependencies & Risks

### External Dependencies

| Dependency                     | Used By                       | Version         | Risk                  |
| ------------------------------ | ----------------------------- | --------------- | --------------------- |
| `node:crypto`                  | Core engine, all KDF, AES-GCM | Node.js builtin | None                  |
| `node:zlib` (zstdCompressSync) | Compress-then-encrypt         | Node.js 22+     | Low (fallback exists) |
| `mongoose`                     | Encryption plugin             | ^8.x            | Low                   |
| AWS SDK                        | aws-kms-provider              | Dynamic import  | Med (version pinning) |
| Azure SDK                      | azure-keyvault/hsm providers  | Dynamic import  | Med                   |
| GCP SDK                        | gcp-cloud-kms provider        | Dynamic import  | Med                   |

### Implementation Risks

| Risk                                         | Phase | Likelihood | Impact | Mitigation                                         |
| -------------------------------------------- | ----- | ---------- | ------ | -------------------------------------------------- |
| Circular dependency with createLogger        | 1     | Medium     | Low    | Use lightweight logger stub if needed              |
| MongoMemoryServer compatibility              | 2     | Low        | Med    | Tested in other integration tests                  |
| E2E test infrastructure setup                | 3     | Medium     | Med    | Follow existing E2E patterns in codebase           |
| PBKDF2 iteration change breaks existing keys | 4     | Low        | High   | Previous keys still decryptable via fallback array |
| Re-encryption worker causes load spike       | 5     | Medium     | Med    | Configurable concurrency and batch size            |
