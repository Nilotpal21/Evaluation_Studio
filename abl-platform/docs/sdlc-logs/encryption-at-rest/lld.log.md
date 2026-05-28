# LLD Log: encryption-at-rest

**Phase**: 4 — Low-Level Design
**Date**: 2026-03-22
**Status**: Complete

## Clarifying Questions & Decisions

### Q1: What is the preferred implementation order for gap closure?

**Classification**: DECIDED
**Decision**: Logger fixes first (lowest risk, immediate observability improvement), then integration tests (build confidence), then E2E tests (validate full path), then PBKDF2 increase (security improvement), then auto re-encryption (operational improvement).

### Q2: Which specific files need modification vs creation?

**Classification**: ANSWERED
**Source**: Comprehensive file inventory from Phase 1 codebase search. All core files exist. Gap closure requires 3 new test files and 2 modified files.
**Decision**: Documented complete file-level change map with existing files (implemented) and new files (gap closure).

### Q3: What is the PBKDF2 backward compatibility strategy?

**Classification**: DECIDED
**Decision**: Previous keys with 100K iterations remain decryptable via `EncryptionServiceConfig.previous` array. New derivations use 600K iterations. The tenant key cache (30-min TTL) means derivation overhead only affects cache misses.

### Q4: What is the re-encryption worker architecture?

**Classification**: DECIDED
**Decision**: BullMQ worker that reads documents by collection, decrypts with old key (via fallback), re-encrypts with current key. Configurable via `TenantKMSConfig.reencryption` settings (concurrency, batchSize, maxRetries). Distributed lock prevents concurrent processing of same document.

### Q5: What is the rollback strategy per phase?

**Classification**: DECIDED
**Decision**: All 5 phases are independently rollbackable. Phases 1-3 have zero data impact (logger/test changes). Phase 4 (PBKDF2) has minimal impact due to caching. Phase 5 (re-encryption) can be stopped without data loss. Full feature rollback via ENCRYPTION_ENABLED=false toggle.

## Key Findings

1. **Feature is fully implemented** — LLD documents gap-closure plan, not initial implementation
2. **5 phases of gap closure**: logger fixes, integration tests, E2E tests, PBKDF2 iteration increase, auto re-encryption
3. **10 design decisions documented** with alternatives rejected and rationale
4. **13 wiring items tracked**: 9 complete, 4 pending (loggers, E2E tests, re-encryption worker)
5. **All phases independently deployable and rollbackable** — follows platform's phase-isolation principle

## Package Learnings

### packages/shared (encryption module)

- Three wire formats coexist — any new integration must choose the correct one
- `TenantKeyCache` has `Buffer.fill(0)` on eviction — any new cache must follow same secure disposal pattern
- `isEncryptionAvailable()` is the safe check — returns false when master key is absent OR ENCRYPTION_ENABLED=false

### packages/database (encryption plugin + KMS)

- Mongoose plugin is 785 LOC with 3 code paths (v1/v2/v3) — high complexity, requires careful testing
- `encryption.plugin.ts` uses `console.warn` intentionally to avoid circular dependency with shared logger
- KMS provider pool uses dynamic import for cloud SDKs to avoid bundling unused dependencies
- `updateMany` and `insertMany` are intentionally blocked for encrypted fields — tests must verify this
