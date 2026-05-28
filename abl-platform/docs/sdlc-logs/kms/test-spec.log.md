# SDLC Log: KMS Test Spec (Phase 2)

**Date**: 2026-03-22
**Phase**: Test Spec
**Artifact**: `docs/testing/kms.md`

---

## Clarifying Questions & Decisions

### Q1: What is the highest-risk FR?

**Classification**: DECIDED
**Rationale**: FR-10 (REST API) is highest risk because it is the only externally-facing surface with auth, rate limiting, and feature gate middleware that has only mock-based unit tests, no E2E through real middleware. FR-1 (providers) is second-highest because 4 of 6 provider types (cloud) have zero test coverage.

### Q2: What existing test infrastructure is available?

**Classification**: ANSWERED
**Source**: MongoMemoryServer is used in `packages/database/src/__tests__/encryption-plugin-kms.test.ts` and `encryption-e2e.test.ts`. BullMQ is tested with `vi.mock()` in `reencryption-queue.test.ts`. No ClickHouse test infrastructure exists. No external HTTPS mock server exists for KMS validation tests.

### Q3: What auth/permission combinations need E2E coverage?

**Classification**: ANSWERED
**Source**: `kms-admin-authz.test.ts` tests OWNER (wildcard), ADMIN (kms:admin), OPERATOR (no kms:admin -> 403), VIEWER (no kms:admin -> 403), and unauthenticated (401). These cover the permission matrix but through mocked middleware -- the E2E gap is testing with real middleware.

### Q4: Are there cross-feature interactions needing E2E testing?

**Classification**: DECIDED
**Rationale**: KMS is a low-level infrastructure feature consumed by many features (PII, sessions, credentials, contacts). The critical cross-feature test is the "full encrypt-decrypt round trip" (E2E-6) which validates that Mongoose encryption plugin + KMS resolver + DEK manager all work together when a session is created.

### Q5: What concurrent/race condition scenarios exist?

**Classification**: ANSWERED
**Source**: DEK creation has E11000 duplicate key retry logic (tested in `dek-manager.test.ts`). Re-encryption queue has BullMQ-level deduplication. KMS materializer has upsert-based idempotency. All verified in unit tests but not under real concurrent load.

---

## Test Inventory Summary

- **28 existing test files** across 3 packages (runtime: 10, database: 7, shared: 11)
- **All unit tests PASS** as of 2026-03-22
- **3 integration tests exist** in database package (encryption-plugin-kms, encryption-e2e, encryption-integration)
- **0 E2E tests** for KMS admin API
- **7 E2E scenarios planned**, **7 integration scenarios planned**

---

## Self-Audit

- [x] Coverage matrix maps all 10 FRs
- [x] 7 E2E scenarios (exceeds 5 minimum)
- [x] 7 integration scenarios (exceeds 5 minimum)
- [x] E2E scenarios specify auth context and isolation checks
- [x] E2E scenarios do NOT reference mocks or direct DB access
- [x] Integration scenarios specify service boundaries
- [x] Security & isolation section filled with status indicators
- [x] Test file mapping includes all 28 existing + 5 planned files
- [x] Coverage gaps prioritized by severity (Critical/High/Medium)
