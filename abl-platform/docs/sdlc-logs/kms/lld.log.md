# SDLC Log: KMS LLD (Phase 4)

**Date**: 2026-03-22
**Phase**: LLD
**Artifact**: `docs/plans/kms.lld.md`

---

## Clarifying Questions & Decisions

### Q1: What is the preferred implementation order for remaining work?

**Classification**: DECIDED
**Rationale**: Tests first (Phase A), then hardening (Phase B), then cloud integration tests (Phase C). Test coverage is the highest-priority gap because the existing code is already implemented and functional but lacks verification of critical paths.

### Q2: Should cloud KMS integration tests be in CI?

**Classification**: DECIDED
**Rationale**: Cloud KMS integration tests (Phase C) should be opt-in in CI using environment-variable gating (`KMS_INTEGRATION_TESTS_ENABLED=true`). Cloud emulators (localstack, Azurite) add significant CI overhead. These tests are valuable for pre-release validation but not for every PR.

### Q3: What is the risk of the globalThis singleton pattern?

**Classification**: ANSWERED
**Source**: `kms-resolver.ts` uses `(globalThis as any).__kmsResolver` because ESM modules don't share module-level state across dynamic import boundaries. This is a known pattern in the codebase (also used by encryption registry). Risk is low -- the pattern works correctly, just not idiomatic. Deferring cleanup.

### Q4: What specific Zod schemas are needed for admin routes?

**Classification**: DECIDED
**Rationale**: Two schemas needed: (1) `KMSConfigUpdateSchema` for PUT /config body validating providerType enum, keyId min(1), region, vaultUrl, externalEndpoint, authMethod enum, and nested project/environment overrides. (2) `KMSValidateSchema` for POST /validate body validating endpoint URL format and authMethod. Use `z.string().min(1)` for all ID fields per CLAUDE.md rules.

### Q5: What is the auto re-materialization strategy for stale configs?

**Classification**: DECIDED
**Rationale**: When `KMSResolver.resolve()` detects a stale materialized config (via `sourceConfigVersion` mismatch with current `TenantKMSConfig._v`), it should: (1) return the stale config for the current request (don't block), (2) trigger a fire-and-forget `KMSMaterializer.materialize(tenantId)` call, (3) log a warning. This ensures the hot path is never blocked while stale configs self-heal.

---

## Key Findings

1. **All core implementation is complete**: 19 of 25 tasks in the HLD are DONE. The remaining 6 are tests, validation, and hardening.
2. **28 test files exist**: Unit test coverage is comprehensive. The gaps are all at the integration and E2E level.
3. **Three implementation phases**: Phase A (tests, 3-5 days), Phase B (hardening, 1-2 days), Phase C (cloud tests, 2-3 days optional).
4. **No data migration needed**: All new collections are additive. Existing encryption continues to work as platform default.
5. **Feature-gated rollback**: Disabling `kms_byok` reverts all tenants to local provider. The critical risk is data encrypted by cloud providers becoming unreadable if the provider is unreachable.

---

## Self-Audit

- [x] Design decisions with rationale and rejected alternatives
- [x] Key TypeScript interfaces documented
- [x] Module boundaries with responsibilities and dependencies
- [x] File-level change map with LOC estimates for all files
- [x] 3 implementation phases with exit criteria
- [x] Wiring checklist with status (all DONE for existing, TODO for Phase B)
- [x] Test plan with specific file paths and runner commands
- [x] Rollback strategy for each phase
- [x] Gap tracking with phase assignments
- [x] Complete key files reference (37 files)
