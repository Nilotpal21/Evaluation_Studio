# SDLC Log: KMS Feature Spec (Phase 1)

**Date**: 2026-03-22
**Phase**: Feature Spec
**Artifact**: `docs/features/kms.md`

---

## Clarifying Questions & Decisions

### Q1: What packages contain the encryption infrastructure?

**Classification**: ANSWERED
**Source**: Codebase search reveals `packages/shared/src/encryption/` (not `packages/shared-encryption/` as some earlier docs reference). The existing feature spec incorrectly listed the package as `packages/shared-encryption`; the actual path is `packages/shared/src/encryption/`.

### Q2: How many KMS provider implementations exist and where?

**Classification**: ANSWERED
**Source**: 6 providers verified in `packages/database/src/kms/`:

- `local-kms-provider.ts` (312 LOC, AES-256-GCM in-process)
- `providers/aws-kms-provider.ts` (dynamic `@aws-sdk/client-kms`)
- `providers/azure-keyvault-provider.ts` (dynamic `@azure/keyvault-keys`)
- `providers/azure-managed-hsm-provider.ts` (separate from Key Vault for FIPS 140-3)
- `providers/gcp-cloud-kms-provider.ts` (dynamic `@google-cloud/kms`)
- `providers/external-kms-provider.ts` (426 LOC, HTTPS + 4 auth methods)

### Q3: What is the actual KMSProvider interface surface?

**Classification**: ANSWERED
**Source**: `packages/database/src/kms/types.ts` (166 LOC). Defines: `initialize()`, `shutdown()`, `healthCheck()`, `generateDataKey(keyId)`, `wrapKey(keyId, plaintext)`, `unwrapKey(keyId, ciphertext, keyVersion?)`, `encrypt(keyId, plaintext)`, `decrypt(keyId, ciphertext)`, `createKey(purpose)`, `describeKey(keyId)`, `enableKeyRotation(keyId, intervalDays)`, `scheduleKeyDeletion(keyId, pendingWindowDays?)`, plus optional BYOK methods.

### Q4: What tests exist for the shared EncryptionService?

**Classification**: ANSWERED
**Source**: `packages/shared/src/__tests__/encryption/` contains 8 test files: `engine.test.ts`, `engine-edge-cases.test.ts`, `engine-no-zstd.test.ts`, `multi-key.test.ts`, `compress-encrypt.test.ts`, `contact-encryption.test.ts`, `cross-compat-proof.test.ts`, `index-singleton.test.ts`. Plus `packages/shared/src/encryption/__tests__/field-interceptor.test.ts` and `secure-queue.test.ts`. The previous spec's claim of "no dedicated tests for shared-encryption" was INCORRECT.

### Q5: Do KMS admin route tests exist?

**Classification**: ANSWERED
**Source**: Two test files found:

- `apps/runtime/src/__tests__/kms-admin-authz.test.ts` — permission matrix tests (OWNER, ADMIN, OPERATOR, VIEWER roles)
- `apps/runtime/src/__tests__/kms-admin-crud.test.ts` — CRUD business logic tests
  Both use `vi.mock()` for middleware isolation. These are unit tests, not E2E.

### Q6: What is the EncryptionService's key derivation strategy?

**Classification**: ANSWERED
**Source**: `packages/shared/src/encryption/engine.ts` line 46: `this.strategy = strategies[config.defaultStrategy ?? 'pbkdf2']`. Default is PBKDF2 with 100K iterations. HKDF available as alternative. Tenant key cache (`TenantKeyCache`) avoids re-derivation (default 1000 entries, 30min TTL).

### Q7: How does the external KMS provider handle authentication?

**Classification**: ANSWERED
**Source**: `packages/database/src/kms/providers/external-kms-provider.ts` implements 4 auth methods: `api-key` (custom header), `oauth2` (client_credentials with token caching), `hmac-sha256` (signature + nonce + timestamp), `mtls` (undici Agent with client cert/key). All enforce HTTPS, 10s timeout, 64KB max response.

### Q8: Is the KMS resolver cache invalidation working across pods?

**Classification**: ANSWERED
**Source**: `apps/runtime/src/services/kms/kms-resolver.ts` has `publishInvalidation(tenantId)` via Redis pub/sub `kms:invalidate` channel. Subscribes on construction. Falls back to TTL expiry (60s) when Redis unavailable.

### Q9: What diagnostics exist for KMS at startup?

**Classification**: ANSWERED
**Source**: `apps/runtime/src/services/diagnostics/analyzers/encryption-availability.ts` checks KMS health at runtime startup. Also `apps/runtime/src/contexts/identity/infrastructure/resolution-key-store.ts` uses KMS for identity key resolution.

### Q10: Are there existing KMS-related scripts?

**Classification**: ANSWERED
**Source**: `scripts/kms-encryption-roundtrip.ts` — manual encryption round-trip validation. `scripts/kms-live-test.sh` — live test script.

### Q11: What security measures exist in the ExternalKMSProvider?

**Classification**: ANSWERED
**Source**: `external-kms-provider.ts` enforces: HTTPS-only endpoints, 10s max timeout, 64KB max response, `AbortController`-based timeout, `sanitizeHeaderValue()` removing CR/LF/NUL for header injection prevention, and fail-closed on all errors.

### Q12: Is the DEK usage count tracking actually wired?

**Classification**: ANSWERED
**Source**: `dek_registry` model has `usageCount` and `maxUsageCount` fields, but no code in the encrypt path increments `usageCount`. This is GAP-009.

---

## Key Findings

1. **Package name correction**: The actual package is `packages/shared` (with encryption at `src/encryption/`), not `packages/shared-encryption` as referenced in some older docs.

2. **Test coverage better than reported**: The previous spec claimed "no dedicated tests for shared-encryption". In fact, there are 8 test files in `packages/shared/src/__tests__/encryption/` covering the engine, edge cases, multi-key, compression, contact encryption, cross-compat, and singleton. Plus 2 test files in `packages/shared/src/encryption/__tests__/` for field-interceptor and secure-queue.

3. **Admin route tests exist**: Two test files (`kms-admin-authz.test.ts`, `kms-admin-crud.test.ts`) exist and test the route handlers, though they use `vi.mock()` for middleware isolation (unit-level, not E2E).

4. **10 gaps identified**: Updated gap list reflects actual code state — removed the "no shared-encryption tests" gap and added more specific gaps around Zod validation, stale config re-materialization, and DEK usage count tracking.

---

## Self-Audit

- [x] All 18 template sections populated
- [x] All FRs reference specific source files
- [x] Package name corrected to `packages/shared`
- [x] Test inventory includes ALL discovered test files (28 files)
- [x] Gaps list updated from code evidence
- [x] No ungrounded claims
- [x] Data model verified against actual Mongoose model files
- [x] API endpoints verified against `kms-admin.ts` route file
- [x] Studio components verified via grep results
