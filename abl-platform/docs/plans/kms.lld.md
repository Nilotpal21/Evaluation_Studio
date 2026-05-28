# Key Management Service (KMS) -- Low-Level Design

**Status**: Implemented (BETA) -- remaining work is real cloud API tests, runtime admin E2E, and scope-route enforcement E2E
**Feature Spec**: [docs/features/kms.md](../features/kms.md)
**HLD**: [docs/specs/kms.hld.md](../specs/kms.hld.md)
**Testing Guide**: [docs/testing/kms.md](../testing/kms.md)
**Last Updated**: 2026-04-14

---

## 1. Design Decisions

### Decision Log

| Decision                                     | Rationale                                                                                | Alternatives Rejected                                             |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| PBKDF2 as default key derivation             | Backward compat with existing encrypted data. HKDF available for new paths.              | HKDF-only (breaks existing data)                                  |
| Dynamic imports for cloud SDKs               | Avoid bundling unused `@aws-sdk`, `@azure/*`, `@google-cloud/*` -- each adds 10-50MB     | Static imports (bundle bloat)                                     |
| globalThis for KMS resolver singleton        | Cross-module singleton sharing in ESM (no shared module state across dynamic imports)    | Module-level variable (doesn't survive dynamic import boundaries) |
| Separate L1 and L2 DEK caches                | L1 stores plaintext (fast, zero-fill on evict). L2 stores wrapped (shared, secure).      | Single cache layer (either too slow or insecure)                  |
| Fire-and-forget audit logging                | Audit writes must never block encrypt/decrypt on hot path                                | Synchronous audit (blocks hot path)                               |
| setInterval for rotation job                 | Simple, idempotent, runs on all pods. MongoDB atomic updates handle coordination.        | Distributed lock (complexity for no benefit)                      |
| BullMQ separate connections                  | Worker requires `maxRetriesPerRequest: null` (different from Queue connection)           | Shared connection (breaks BullMQ requirement)                     |
| Mongoose tenantIsolationPlugin on all models | Automatic tenantId filtering at query level -- consistent with all other platform models | Manual tenantId filtering (error-prone)                           |

### Key Interfaces & Types

#### KMSProvider Interface (`packages/database/src/kms/types.ts`)

```typescript
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
  // Optional BYOK
  getWrappingPublicKey?(keyId: string): Promise<Buffer>;
  importKeyMaterial?(keyId: string, wrapped: Buffer): Promise<void>;
}
```

#### ResolvedKMSConfig (`apps/runtime/src/services/kms/kms-resolver.ts`)

```typescript
interface ResolvedKMSConfig {
  provider: IResolvedProviderRef;
  tier: string;
  keyId: string;
  dekEpochIntervalHours: number;
  dekMaxUsageCount: number;
  failurePolicy: string;
  sourceConfigVersion: number;
}
```

#### DEKScope & AcquiredDEK (`apps/runtime/src/services/kms/dek-manager.ts`)

```typescript
interface DEKScope {
  tenantId: string;
  projectId: string;
  environment: string;
}

interface AcquiredDEK {
  plaintext: Buffer;
  epoch: string;
  kekKeyId: string;
  kekKeyVersion: number;
}
```

### Module Boundaries

| Module                        | Responsibility                                          | Dependencies                                  |
| ----------------------------- | ------------------------------------------------------- | --------------------------------------------- |
| `packages/database/kms`       | Provider interface, implementations, pool, readiness    | Node crypto, cloud SDKs (dynamic)             |
| `packages/database/models`    | MongoDB schemas for KMS data                            | Mongoose, tenant isolation plugin             |
| `packages/shared/encryption`  | Core AES-256-GCM engine, key derivation                 | Node crypto, zlib (zstd)                      |
| `packages/shared-encryption`  | DEK codec, tenant facade, encryption registry, envelope | Node crypto, shared/encryption                |
| `packages/shared-auth/scopes` | Platform key scope registry, ceiling check, expansion   | shared-auth/rbac                              |
| `apps/runtime/services/kms`   | Config resolution, DEK lifecycle, caching               | database/kms, database/models, Redis, BullMQ  |
| `apps/runtime/routes`         | REST API endpoints                                      | services/kms, shared-auth, Express middleware |
| `apps/studio/components`      | Admin UI for KMS management                             | React, hooks, runtime API                     |
| `apps/studio/api/keys`        | Platform key CRUD API routes                            | shared-auth/scopes, database/models           |
| `apps/studio/api/admin/kms`   | Studio proxy to runtime KMS API                         | runtime API, tenant auth                      |

---

## 2. File-Level Change Map

### Existing Files (Implemented -- DONE)

#### Provider Layer (`packages/database/src/kms/`)

| File                                      | LOC  | Purpose                                         |
| ----------------------------------------- | ---- | ----------------------------------------------- |
| `types.ts`                                | ~166 | KMSProvider interface, key types, result types  |
| `local-kms-provider.ts`                   | ~312 | Local AES-256-GCM provider (dev/default)        |
| `kms-provider-pool.ts`                    | ~200 | LRU provider pool (max 50, fingerprint, health) |
| `kms-registry.ts`                         | ~60  | Singleton registry                              |
| `providers/index.ts`                      | ~80  | Factory with dynamic imports                    |
| `providers/aws-kms-provider.ts`           | ~250 | AWS KMS via @aws-sdk/client-kms                 |
| `providers/azure-keyvault-provider.ts`    | ~200 | Azure Key Vault via @azure/keyvault-keys        |
| `providers/azure-managed-hsm-provider.ts` | ~200 | Azure Managed HSM (FIPS 140-3)                  |
| `providers/gcp-cloud-kms-provider.ts`     | ~200 | GCP Cloud KMS via @google-cloud/kms             |
| `providers/external-kms-provider.ts`      | ~426 | External BYOP (HTTPS + 4 auth)                  |

#### Database Models (`packages/database/src/models/`)

| File                               | LOC  | Purpose                    |
| ---------------------------------- | ---- | -------------------------- |
| `tenant-kms-config.model.ts`       | ~200 | Source of truth config     |
| `materialized-kms-config.model.ts` | ~120 | Pre-resolved O(1) lookup   |
| `dek-registry.model.ts`            | ~100 | Epoch-scoped DEK lifecycle |

#### Shared Encryption (`packages/shared/src/encryption/`)

| File                        | LOC  | Purpose                                |
| --------------------------- | ---- | -------------------------------------- |
| `engine.ts`                 | ~350 | EncryptionService (AES-256-GCM)        |
| `index.ts`                  | ~100 | Singleton factory + re-exports         |
| `constants.ts`              | ~30  | Crypto constants                       |
| `types.ts`                  | ~40  | EncryptionServiceConfig, KeyDerivation |
| `errors.ts`                 | ~20  | Error factories                        |
| `master-key-resolver.ts`    | ~35  | Vault-first key resolution             |
| `field-interceptor.ts`      | ~100 | ClickHouse/Redis field encryption      |
| `secure-queue.ts`           | ~60  | BullMQ job data encryption             |
| `encryption-manifest.ts`    | ~80  | Field encryption manifests             |
| `key-derivation/hkdf.ts`    | ~30  | HKDF strategy                          |
| `key-derivation/pbkdf2.ts`  | ~30  | PBKDF2 strategy (legacy compat)        |
| `cache/tenant-key-cache.ts` | ~60  | LRU derived key cache                  |

#### Runtime Services (`apps/runtime/src/services/kms/`)

| File                        | LOC  | Purpose                                    |
| --------------------------- | ---- | ------------------------------------------ |
| `kms-resolver.ts`           | ~150 | 5-level config resolution + L1 cache       |
| `dek-manager.ts`            | ~200 | DEK lifecycle: acquire, unwrap, rotate     |
| `dek-cache.ts`              | ~180 | Multi-layer cache (L1 LRU + L2 Redis)      |
| `kms-materializer.ts`       | ~200 | Inheritance -> pre-resolved configs        |
| `kms-circuit-breaker.ts`    | ~80  | Circuit breaker wrapper                    |
| `kms-rotation-job.ts`       | ~150 | Periodic rotation (epoch, destroy, KEK)    |
| `kms-audit-logger.ts`       | ~120 | ClickHouse audit + structured log fallback |
| `external-kms-validator.ts` | ~100 | Pre-save endpoint validation               |
| `reencryption-queue.ts`     | ~200 | BullMQ DEK re-wrapping                     |

#### Routes & UI

| File                                                 | LOC  | Purpose                |
| ---------------------------------------------------- | ---- | ---------------------- |
| `apps/runtime/src/routes/kms-admin.ts`               | ~300 | REST API (7 endpoints) |
| `apps/studio/src/components/admin/KMSPage.tsx`       | ~200 | 4-tab admin page       |
| `apps/studio/src/components/admin/KMSConfigForm.tsx` | ~150 | Config form component  |
| `apps/studio/src/hooks/useKMS.ts`                    | ~80  | React hook for KMS API |

### Completed Since Last Update (2026-03-22 -> 2026-04-14)

| File                                                              | Purpose                                                                         | Ticket   |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------- |
| `packages/database/src/__tests__/dek-lifecycle-cloud-e2e.test.ts` | Full DEK lifecycle with mocked AWS/Azure/GCP (real AES-256-GCM at SDK boundary) | PR #671  |
| `packages/database/src/__tests__/provider-readiness.test.ts`      | Provider readiness verification (health + crypto probe)                         | PR #671  |
| `packages/database/src/kms/provider-readiness.ts`                 | Crypto-verified readiness check for migration safety                            | PR #671  |
| `apps/studio/src/components/admin/KMSAuditTab.tsx`                | Dedicated audit log tab component                                               | PR #671  |
| `apps/studio/src/components/admin/KMSKeysTab.tsx`                 | Dedicated DEK keys tab component                                                | PR #671  |
| `apps/studio/src/app/api/admin/kms/route.ts`                      | Studio KMS admin proxy API route                                                | PR #671  |
| `tools/normalize-kms-dek-status.ts`                               | DEK status normalization tool                                                   | PR #671  |
| `packages/shared-auth/src/scopes/platform-key-scopes.ts`          | Scope registry (10 scopes, 4 categories)                                        | ABLP-315 |
| `packages/shared-auth/src/scopes/scope-validation.ts`             | Ceiling check, expansion, validation                                            | ABLP-315 |
| `packages/shared-auth/src/__tests__/platform-key-scopes.test.ts`  | Scope registry and ceiling check tests                                          | ABLP-315 |
| `apps/studio/src/__tests__/platform-keys-api.e2e.test.ts`         | Platform key API E2E                                                            | ABLP-315 |
| `apps/studio/src/__tests__/platform-keys-api.test.ts`             | Platform key API integration tests                                              | ABLP-315 |
| `apps/studio/src/app/api/keys/scopes/route.ts`                    | Scope registry API                                                              | ABLP-315 |

### Remaining Work (TODO)

#### Phase A: Test Coverage (Priority: High)

| File (New)                                                               | LOC Est. | Purpose                                            |
| ------------------------------------------------------------------------ | -------- | -------------------------------------------------- |
| `apps/runtime/src/__tests__/kms-admin-e2e.test.ts`                       | ~300     | E2E: 7 KMS admin endpoints through real middleware |
| `apps/runtime/src/__tests__/kms-materializer-int.test.ts`                | ~200     | Integration: Materializer + real MongoDB           |
| `apps/runtime/src/__tests__/kms-reencryption-int.test.ts`                | ~200     | Integration: Re-encryption worker + LocalKMS       |
| `apps/runtime/src/services/kms/__tests__/external-kms-validator.test.ts` | ~150     | Unit: External endpoint validation                 |
| `apps/runtime/src/__tests__/scope-route-enforcement-e2e.test.ts`         | ~250     | E2E: Platform key scopes -> runtime API access     |

#### Phase B: Hardening (Priority: Medium)

| File (Modified)                                 | Change                                  | Risk |
| ----------------------------------------------- | --------------------------------------- | ---- |
| `apps/runtime/src/routes/kms-admin.ts`          | Add Zod request body validation schemas | Low  |
| `apps/runtime/src/services/kms/kms-resolver.ts` | Auto re-materialization on stale detect | Med  |

#### Phase C: Cloud Integration Tests (Priority: Medium-Low)

| File (New)                                                            | LOC Est. | Purpose                     |
| --------------------------------------------------------------------- | -------- | --------------------------- |
| `packages/database/src/__tests__/aws-kms-provider-int.test.ts`        | ~200     | AWS KMS via localstack      |
| `packages/database/src/__tests__/azure-keyvault-provider-int.test.ts` | ~200     | Azure Key Vault via Azurite |
| `packages/database/src/__tests__/gcp-cloud-kms-provider-int.test.ts`  | ~200     | GCP Cloud KMS via emulator  |

---

## 3. Implementation Phases

### Phase A: Test Coverage (Estimated: 3-5 days)

**Objective**: Close the critical and high test gaps identified in the test spec.

**Exit Criteria**:

- [ ] KMS admin E2E test passes with real Express server, auth middleware, and tenant isolation
- [ ] DEK lifecycle integration test passes with MongoMemoryServer
- [ ] Materializer integration test validates all 5 levels with real MongoDB
- [ ] Rotation job integration test verifies epoch transitions with real DEK data
- [ ] Re-encryption integration test verifies batch re-wrapping with LocalKMSProvider
- [ ] External KMS validator unit tests cover HTTPS enforcement, round-trip, and latency
- [ ] `pnpm build` passes for all affected packages
- [ ] `pnpm test --filter=runtime` passes (all existing tests still green)

**Files to Create**:

1. `apps/runtime/src/__tests__/kms-admin-e2e.test.ts` -- E2E test for all 7 admin endpoints
   - Start real Express server on random port with full middleware chain
   - Test with OWNER, ADMIN, OPERATOR, VIEWER roles and unauthenticated
   - Verify cross-tenant isolation (404)
   - Verify config CRUD, key listing, force rotation, health, audit
   - Use MongoMemoryServer for database

2. `apps/runtime/src/__tests__/kms-dek-lifecycle-int.test.ts` -- Integration test
   - `DEKManager` + `LocalKMSProvider` + MongoMemoryServer
   - Test: acquireDEK, forceRotateDEK, unwrapDEK, batchUnwrapDEKs
   - Verify DEK entry states in MongoDB
   - Verify zero-fill of plaintext after use

3. `apps/runtime/src/__tests__/kms-materializer-int.test.ts` -- Integration test
   - `KMSMaterializer` + MongoMemoryServer
   - Create TenantKMSConfig with overrides at all 5 levels
   - Materialize and verify all MaterializedKMSConfig docs
   - Test stale cleanup after config changes

4. `apps/runtime/src/__tests__/kms-rotation-int.test.ts` -- Integration test
   - Insert DEKs with controlled timestamps into MongoMemoryServer
   - Run rotation tick
   - Verify state transitions and wrappedDek zeroing

5. `apps/runtime/src/__tests__/kms-reencryption-int.test.ts` -- Integration test
   - Insert DEKs wrapped by "old" KEK
   - Process re-encryption job with LocalKMSProvider
   - Verify DEKs re-wrapped with "new" KEK version
   - Verify progress tracking

6. `apps/runtime/src/services/kms/__tests__/external-kms-validator.test.ts` -- Unit test
   - HTTPS enforcement (reject http://)
   - Health check success and failure
   - Round-trip wrap/unwrap correctness
   - Latency threshold enforcement
   - Provider cleanup after validation

### Phase B: Hardening (Estimated: 1-2 days)

**Objective**: Address medium-severity gaps in the existing implementation.

**Exit Criteria**:

- [ ] All KMS admin route request bodies validated by Zod schemas
- [ ] Stale materialized config auto-triggers re-materialization
- [ ] `pnpm build` passes
- [ ] All existing and new tests pass

**Files to Modify**:

1. `apps/runtime/src/routes/kms-admin.ts` -- Add Zod validation
   - Define `KMSConfigUpdateSchema` with Zod for PUT /config body
   - Define `KMSValidateSchema` for POST /validate body
   - Use `z.string().min(1)` for ID fields (not `.cuid()` per CLAUDE.md)
   - Return `{ success: false, error: { code: 'VALIDATION_ERROR', message } }` on failure

2. `apps/runtime/src/services/kms/kms-resolver.ts` -- Auto re-materialization
   - When `sourceConfigVersion` mismatch detected on read, trigger async re-materialization
   - Return stale config for current request (don't block)
   - Log warning about stale config

### Phase C: Cloud Integration Tests (Estimated: 2-3 days, optional for CI)

**Objective**: Verify cloud KMS providers work against emulators.

**Exit Criteria**:

- [ ] AWS KMS integration test passes against localstack
- [ ] Azure Key Vault integration test passes against Azurite (or test server)
- [ ] GCP Cloud KMS integration test passes against emulator
- [ ] Tests are skippable in CI when emulators are not available

---

## 4. Wiring Checklist

All wiring is complete for the existing implementation. The following is the verification checklist:

| Wiring Point                                     | Status | File                                                                         |
| ------------------------------------------------ | ------ | ---------------------------------------------------------------------------- |
| KMS admin routes mounted in Express app          | DONE   | `apps/runtime/src/server.ts`                                                 |
| KMS provider pool initialized at startup         | DONE   | `apps/runtime/src/server.ts`                                                 |
| KMS rotation job started at server startup       | DONE   | `apps/runtime/src/server.ts`                                                 |
| KMS re-encryption queue started at startup       | DONE   | `apps/runtime/src/server.ts`                                                 |
| KMS audit logger ClickHouse flag set at startup  | DONE   | `apps/runtime/src/server.ts`                                                 |
| KMS materializer reconcileAll at startup         | DONE   | `apps/runtime/src/server.ts`                                                 |
| Mongoose encryption plugin uses KMS provider     | DONE   | `packages/database/src/mongo/plugins/encryption.plugin.ts`                   |
| EncryptionService singleton initialized from env | DONE   | `packages/shared/src/encryption/index.ts`                                    |
| Studio KMS page in navigation                    | DONE   | `apps/studio/src/components/navigation/AppShell.tsx`                         |
| Studio useKMS hook connects to runtime API       | DONE   | `apps/studio/src/hooks/useKMS.ts`                                            |
| Encryption availability diagnostic registered    | DONE   | `apps/runtime/src/services/diagnostics/analyzers/encryption-availability.ts` |

### Wiring for Phase B Changes

| Wiring Point                                  | Status | Notes                                         |
| --------------------------------------------- | ------ | --------------------------------------------- |
| Zod schemas imported in kms-admin.ts          | TODO   | Add import and use `schema.parse(req.body)`   |
| Auto-rematerialize trigger in kms-resolver.ts | TODO   | Fire-and-forget call to materializer on stale |

---

## 5. Test Plan

### Phase A Tests

| Test File                        | Type        | Covers      | Runner Command                                       |
| -------------------------------- | ----------- | ----------- | ---------------------------------------------------- |
| `kms-admin-e2e.test.ts`          | E2E         | FR-10, FR-9 | `pnpm test --filter=runtime -- kms-admin-e2e`        |
| `kms-dek-lifecycle-int.test.ts`  | Integration | FR-3, FR-4  | `pnpm test --filter=runtime -- kms-dek-lifecycle`    |
| `kms-materializer-int.test.ts`   | Integration | FR-2        | `pnpm test --filter=runtime -- kms-materializer-int` |
| `kms-rotation-int.test.ts`       | Integration | FR-6        | `pnpm test --filter=runtime -- kms-rotation-int`     |
| `kms-reencryption-int.test.ts`   | Integration | FR-7        | `pnpm test --filter=runtime -- kms-reencryption`     |
| `external-kms-validator.test.ts` | Unit        | FR-9        | `pnpm test --filter=runtime -- external-kms-valid`   |

### Phase B Tests

| Test File                           | Type | Covers            | Notes                                              |
| ----------------------------------- | ---- | ----------------- | -------------------------------------------------- |
| `kms-admin-crud.test.ts` (modified) | Unit | FR-10 (Zod)       | Add tests for Zod validation rejection             |
| `kms-resolver.test.ts` (modified)   | Unit | FR-2 (auto-remat) | Add test for stale config triggering rematerialize |

### Full Test Suite Run

```bash
# Build all affected packages
pnpm build --filter=database --filter=shared --filter=runtime

# Run all KMS tests
pnpm test --filter=runtime -- --reporter=verbose -t "kms"
pnpm test --filter=database -- --reporter=verbose -t "kms"
pnpm test --filter=shared -- --reporter=verbose -t "encrypt"
```

---

## 6. Rollback Strategy

### Phase A (Tests Only)

No rollback needed -- adding test files does not affect production behavior. If tests fail, fix or remove the failing test files.

### Phase B (Code Changes)

**Zod validation rollback**: Revert `kms-admin.ts` to the version without Zod `parse()` calls. Existing tests verify both the current (no Zod) and new (with Zod) behaviors.

**Auto re-materialization rollback**: Revert `kms-resolver.ts` to remove the fire-and-forget re-materialize call. The stale detection logging remains as a diagnostic signal.

### Phase C (Cloud Tests)

No rollback needed -- test files only. Cloud emulator dependencies are optional in CI.

### General Rollback

All KMS functionality is feature-gated behind `kms_byok`. Disabling the feature flag causes all tenants to fall back to the platform default (local provider using `ENCRYPTION_MASTER_KEY`). DEKs created by cloud providers remain in `dek_registry` but are not used.

**Critical risk**: If a tenant has data encrypted by a cloud KMS provider and the provider becomes unreachable, that data is unreadable until the provider is restored. There is no automatic fallback to local encryption for existing data.

---

## 7. Known Gaps (from Feature Spec and HLD)

| ID      | Description                                          | Phase to Address | Priority |
| ------- | ---------------------------------------------------- | ---------------- | -------- |
| GAP-001 | Cloud KMS providers have no integration tests        | Phase C          | Medium   |
| GAP-002 | KMS admin routes lack Zod request body validation    | Phase B          | Medium   |
| GAP-003 | KMS resolver uses globalThis for singleton           | Deferred         | Low      |
| GAP-004 | No auto re-materialization on stale config detection | Phase B          | Medium   |
| GAP-005 | External KMS validator not tested                    | Phase A          | High     |
| GAP-006 | Re-encryption worker not tested E2E                  | Phase A          | High     |
| GAP-007 | ClickHouse kms_audit_log DDL not in migrations       | Deferred         | Low      |
| GAP-008 | BYOK importKeyMaterial not implemented               | Deferred         | Low      |
| GAP-009 | DEK usageCount tracking not wired                    | Deferred         | Low      |
| GAP-010 | No Playwright E2E for Studio KMS UI                  | Deferred         | Medium   |

---

## 8. Key Files Reference

| File                                                                | Purpose                                                   |
| ------------------------------------------------------------------- | --------------------------------------------------------- |
| `packages/database/src/kms/types.ts`                                | KMSProvider interface, NIST key types, result types       |
| `packages/database/src/kms/local-kms-provider.ts`                   | Local AES-256-GCM provider (dev/platform default)         |
| `packages/database/src/kms/kms-provider-pool.ts`                    | LRU provider pool (max 50, fingerprint, health check)     |
| `packages/database/src/kms/kms-registry.ts`                         | Singleton registry for platform KMS provider + pool       |
| `packages/database/src/kms/providers/index.ts`                      | Provider factory with dynamic imports for 6 types         |
| `packages/database/src/kms/providers/aws-kms-provider.ts`           | AWS KMS provider                                          |
| `packages/database/src/kms/providers/azure-keyvault-provider.ts`    | Azure Key Vault provider                                  |
| `packages/database/src/kms/providers/azure-managed-hsm-provider.ts` | Azure Managed HSM provider (FIPS 140-3)                   |
| `packages/database/src/kms/providers/gcp-cloud-kms-provider.ts`     | GCP Cloud KMS provider                                    |
| `packages/database/src/kms/providers/external-kms-provider.ts`      | External BYOP provider (HTTPS + multi-auth)               |
| `packages/database/src/models/tenant-kms-config.model.ts`           | TenantKMSConfig model (source of truth)                   |
| `packages/database/src/models/materialized-kms-config.model.ts`     | MaterializedKMSConfig pre-resolved model                  |
| `packages/database/src/models/dek-registry.model.ts`                | DEKEntry epoch-scoped lifecycle model                     |
| `packages/shared/src/encryption/engine.ts`                          | EncryptionService (AES-256-GCM, multi-scope, compress)    |
| `packages/shared/src/encryption/index.ts`                           | Singleton factory, re-exports                             |
| `packages/shared/src/encryption/constants.ts`                       | Crypto constants (algorithm, lengths, iterations)         |
| `packages/shared/src/encryption/master-key-resolver.ts`             | Vault-first master key resolution                         |
| `packages/shared/src/encryption/field-interceptor.ts`               | ClickHouse/Redis field-level encryption                   |
| `packages/shared/src/encryption/secure-queue.ts`                    | BullMQ job data encryption                                |
| `packages/shared/src/encryption/key-derivation/hkdf.ts`             | HKDF key derivation (SHA-256)                             |
| `packages/shared/src/encryption/key-derivation/pbkdf2.ts`           | PBKDF2 key derivation (100K iterations, legacy compat)    |
| `packages/shared/src/encryption/cache/tenant-key-cache.ts`          | LRU tenant key cache (1000 entries, 30min TTL)            |
| `apps/runtime/src/services/kms/kms-resolver.ts`                     | 5-level config resolution + L1 cache + Redis pub/sub      |
| `apps/runtime/src/services/kms/dek-manager.ts`                      | DEK lifecycle: acquire, unwrap, batch, force-rotate       |
| `apps/runtime/src/services/kms/dek-cache.ts`                        | Multi-layer DEK cache (L1 LRU + L2 Redis)                 |
| `apps/runtime/src/services/kms/kms-materializer.ts`                 | Materialize inheritance -> pre-resolved configs           |
| `apps/runtime/src/services/kms/kms-circuit-breaker.ts`              | Circuit breaker for KMS provider calls                    |
| `apps/runtime/src/services/kms/kms-rotation-job.ts`                 | Periodic rotation: epoch transition, destruction, KEK age |
| `apps/runtime/src/services/kms/kms-audit-logger.ts`                 | ClickHouse audit logging with structured log fallback     |
| `apps/runtime/src/services/kms/external-kms-validator.ts`           | External KMS endpoint validation (HTTPS, round-trip)      |
| `apps/runtime/src/services/kms/reencryption-queue.ts`               | BullMQ re-encryption queue with dedup and progress        |
| `apps/runtime/src/routes/kms-admin.ts`                              | REST API for KMS admin (7 endpoints)                      |
| `apps/studio/src/components/admin/KMSPage.tsx`                      | Studio KMS admin page (4 tabs)                            |
| `apps/studio/src/components/admin/KMSConfigForm.tsx`                | KMS config form component                                 |
| `apps/studio/src/hooks/useKMS.ts`                                   | React hook for KMS API                                    |
