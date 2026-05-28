# HLD Log: encryption-at-rest

**Phase**: 3 — High-Level Design
**Date**: 2026-03-22
**Status**: Complete

## Clarifying Questions & Decisions

### Q1: What architecture pattern was chosen and why?

**Classification**: ANSWERED
**Source**: Codebase analysis — `packages/shared/src/encryption/` (shared service) + `packages/database/src/mongo/plugins/encryption.plugin.ts` (Mongoose plugin) + `packages/database/src/kms/` (KMS abstraction)
**Decision**: Application-layer encryption with three integration points (Mongoose plugin, ClickHouse interceptor, Redis queue wrappers). This was chosen over MongoDB CSFLE (single-store) and TDE (no tenant isolation).

### Q2: What is the data flow for encryption and decryption?

**Classification**: ANSWERED
**Source**: `encryption.plugin.ts` pre-save hook (lines 443-538), post-find hook (lines 541-767); `field-interceptor.ts` `encryptFields`/`decryptFields`; `secure-queue.ts` `wrapJobDataForEncrypt`/`unwrapJobDataForDecrypt`
**Decision**: Documented three data flows: Mongoose plugin (v3 tenant-scoped), ClickHouse field interceptor, and compress-then-encrypt.

### Q3: What are the failure modes and how are they handled?

**Classification**: ANSWERED
**Source**: `errors.ts` (4 error constructors), `encryption.plugin.ts` (null sentinel behavior, lines 554-566, 596-608, 698-703), `engine.ts` (fallback decryption, lines 80-94)
**Decision**: Documented 7 error scenarios with specific behaviors. Key finding: fail-closed for missing master key, null sentinel for decrypt failures, hard error for double-encryption.

### Q4: What is the KMS fallback chain?

**Classification**: ANSWERED
**Source**: `encryption.plugin.ts` lines 170-236 (KMS resolver → global provider → master key), `kms-provider-pool.ts` (fingerprint-based caching), `kms-registry.ts` (singleton + pool)
**Decision**: 5-level resolution: project+environment → project default → tenant+environment → tenant default → platform default (local).

### Q5: What is the rollback strategy?

**Classification**: DECIDED
**Decision**: Three rollback mechanisms: ENCRYPTION_ENABLED toggle, master key revert (with previous key preservation), and code version rollback (multi-version reader). No automatic rollback exists — manual intervention required.

## Alternatives Evaluation

| Alternative                | Coverage     | Tenant Isolation | GDPR Shredding | Effort |
| -------------------------- | ------------ | ---------------- | -------------- | ------ |
| MongoDB CSFLE              | MongoDB only | Limited          | No             | M      |
| Application-Layer (chosen) | All stores   | Full             | Yes            | L      |
| TDE (Storage-level)        | All stores   | No               | No             | S      |

## Key Findings

1. **Three wire formats coexist**: hex 3-part (Mongoose), base64 4-part (compress-encrypt), binary concat (contact PII). All are prefix-detectable.
2. **5-level KMS resolution**: TenantKMSConfig → MaterializedKMSConfig (pre-computed) ensures O(1) hot-path lookup.
3. **Lazy version upgrade**: v1/v2 documents automatically upgrade to v3 on next save — no migration needed.
4. **No structured metrics**: Encrypt/decrypt latency, cache hit rate, and failure rate are not exposed via the observatory pipeline.
