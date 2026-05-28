# SDLC Log: KMS HLD (Phase 3)

**Date**: 2026-03-22
**Phase**: HLD
**Artifact**: `docs/specs/kms.hld.md`

---

## Clarifying Questions & Decisions

### Q1: What architecture pattern does this follow?

**Classification**: ANSWERED
**Source**: KMS follows the "service within monorepo" pattern -- not a separate microservice. Provider layer in `packages/database`, encryption in `packages/shared`, runtime services in `apps/runtime`, UI in `apps/studio`. This is consistent with other platform features (auth-profiles, guardrails).

### Q2: What is the expected request scale for encryption?

**Classification**: INFERRED
**Basis**: Every Mongoose save/find on encrypted models triggers encrypt/decrypt. With conversation history, credentials, and PII, this is on the hot path of every agent execution. Multi-layer caching (L1 sub-us, L2 sub-ms, materialized O(1)) is critical for latency.

### Q3: Is there existing data that needs migration?

**Classification**: ANSWERED
**Source**: No migration needed. New collections (`tenant_kms_configs`, `materialized_kms_configs`, `dek_registry`) are additive. Existing encryption (EncryptionService + PBKDF2 from master key) continues as the platform default (local provider). The Mongoose encryption plugin supports v1/v2/v3 format auto-detection on read.

### Q4: What is the rollback strategy?

**Classification**: DECIDED
**Rationale**: Feature-gated behind `kms_byok`. If disabled, all tenants fall back to platform default (local provider using `ENCRYPTION_MASTER_KEY`). DEKs created by cloud providers would need manual re-encryption back to local -- this is the primary risk.

### Q5: What are the cross-pod considerations?

**Classification**: ANSWERED
**Source**: Redis pub/sub `kms:invalidate` channel propagates config changes. Rotation job is idempotent (MongoDB atomic updates, no distributed lock needed). Re-encryption uses BullMQ for cross-pod work distribution. L1 caches have TTL fallback (60s for config, 5min for DEK).

---

## Architecture Decisions Summary

1. **Materialized configs over runtime resolution** -- O(1) vs O(5) per encrypt/decrypt on hot path
2. **Epoch-scoped DEKs** -- time-bounded exposure, sustainable key count (vs per-session)
3. **Multi-layer cache with wrapped-only L2** -- latency + security balance
4. **ClickHouse for audit** -- write-heavy time-series with native TTL (vs MongoDB)
5. **Per-tenant circuit breaker** -- fault isolation (vs global cascade)
6. **BullMQ re-encryption** -- async background (vs blocking inline)
7. **Provider pool with LRU** -- connection reuse (vs per-tenant instances)

---

## Self-Audit

- [x] Problem statement refined from feature spec
- [x] 3 alternatives considered with pros/cons/effort
- [x] System context diagram (ASCII)
- [x] Component diagram showing all packages
- [x] Data flow for write path, read path, and rotation
- [x] All 12 architectural concerns addressed
- [x] Decisions table with rationale and rejected alternatives
- [x] Security section covers NIST, zero-fill, TLS, BYOK
- [x] Observability section covers audit, metrics, diagnostics
- [x] Task decomposition with 25 items and status
