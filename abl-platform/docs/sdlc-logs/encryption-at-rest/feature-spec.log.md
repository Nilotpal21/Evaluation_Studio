# Feature Spec Log: encryption-at-rest

**Phase**: 1 — Feature Spec
**Date**: 2026-03-22
**Status**: Complete

## Clarifying Questions & Decisions

### Q1: Where does the encryption code live — `packages/shared-encryption` or elsewhere?

**Classification**: ANSWERED
**Source**: `packages/shared/src/encryption/` (index.ts barrel exports confirm)
**Decision**: The spec referenced `packages/shared-encryption` but the actual code is at `packages/shared/src/encryption/`. Updated all file paths.

### Q2: How many Mongoose models use the encryption plugin?

**Classification**: ANSWERED
**Source**: `grep encryptionPlugin *.model.ts` — 16 models found
**Decision**: Catalogued all 16 models with their exact encrypted fields in Section 9.

### Q3: What encryption versions exist and how are they detected?

**Classification**: ANSWERED
**Source**: `encryption.plugin.ts` lines 443-749 — detects via `ire` field ('v1', 'v2', 'v3') and `cek` presence
**Decision**: Documented three-version system with auto-detection.

### Q4: Does the KMS system support per-project encryption or only per-tenant?

**Classification**: ANSWERED
**Source**: `TenantKMSConfig` model has `projects[]` array with per-project overrides, `MaterializedKMSConfig` has `projectId` scope
**Decision**: KMS config supports per-project overrides but key derivation for `EncryptionService` is tenant-scoped.

### Q5: What is the key hierarchy — flat or multi-level?

**Classification**: ANSWERED
**Source**: `engine.ts` (PBKDF2/HKDF derivation), `kms/types.ts` (NIST SP 800-57: PRK -> TKEK -> DEK)
**Decision**: Documented full key hierarchy with both derivation paths.

### Q6: How does GDPR crypto-shredding work?

**Classification**: ANSWERED
**Source**: `engine.ts` lines 202-249 — `deriveContactKey` chains masterKey -> HKDF(tenant) -> HKDF(contactSalt)
**Decision**: Documented the HKDF chain and shredding mechanism.

### Q7: What KMS providers are implemented?

**Classification**: ANSWERED
**Source**: `packages/database/src/kms/providers/` — 5 providers: AWS, Azure KV, Azure HSM, GCP, External
**Decision**: Listed all providers. Noted `local` is the dev/test default.

### Q8: Does `ConnectorConnection` use the encryption plugin?

**Classification**: ANSWERED
**Source**: `connector-connection.model.ts` line 73 comment: "No encryptionPlugin — encryptedCredentials is managed by ConnectionService"
**Decision**: Added as GAP-009 — encryption managed outside the plugin.

### Q9: What wire formats exist for encrypted data?

**Classification**: ANSWERED
**Source**: `engine.ts` — hex 3-part (iv:authTag:ciphertext), base64 4-part (prefix:iv:authTag:ciphertext for compress-encrypt), binary concat (iv+authTag+encrypted for contact PII)
**Decision**: Documented all three wire formats in Technical Considerations.

### Q10: What is the PBKDF2 iteration count vs OWASP recommendation?

**Classification**: ANSWERED
**Source**: `constants.ts` line 8 — 100,000 iterations. OWASP 2023 recommends 600K for SHA-256.
**Decision**: Documented as GAP-001 (Medium severity, Open).

### Q11: Does the `DeploymentVariableSnapshot` model encrypt its data?

**Classification**: ANSWERED
**Source**: `deployment-variable-snapshot.model.ts` line 7 comment: "Does NOT use encryptionPlugin. Stores raw ciphertext copied from..."
**Decision**: Added as GAP-010 (Low severity, Mitigated — intentional design).

### Q12: How does key rotation actually work in the codebase?

**Classification**: ANSWERED
**Source**: `engine.ts` `decryptWithFallback` and `decryptForTenantWithFallback` iterate `previousKeys` array. `key-rotation-service.ts` manages version lifecycle.
**Decision**: Documented both the EncryptionService fallback mechanism and the KeyRotationService version management.

## Files Read

- `packages/shared/src/encryption/` — all 16 .ts files
- `packages/database/src/mongo/plugins/encryption.plugin.ts`
- `packages/database/src/kms/` — all 11 .ts files
- `packages/database/src/models/` — 16 model files with `encryptionPlugin`
- `apps/studio/src/services/security/key-rotation-service.ts`
- `packages/shared/src/repos/security-repo.ts`
- `docs/security/SECURITY.md`

## Key Findings

1. **Comprehensive encryption coverage**: 16 Mongoose models, 5 ClickHouse tables, 2 Redis queues encrypted
2. **Three encryption versions**: v1 (master key CEK), v2 (KMS CEK), v3 (tenant-scoped EncryptionService) — all backward-compatible
3. **Full KMS abstraction**: Provider interface + pool + per-tenant config with 5-level inheritance
4. **GDPR crypto-shredding**: Per-contact HKDF key chain enables salt deletion for PII irrecoverability
5. **Gap: No HTTP API E2E tests** (GAP-005, High severity)
6. **Gap: PBKDF2 iterations below OWASP** (GAP-001, Medium severity)
7. **Gap: No auto re-encryption** (GAP-002, Medium severity)
8. **Previous spec incorrectly referenced** `packages/shared-encryption` (does not exist) — corrected to `packages/shared/src/encryption/`
