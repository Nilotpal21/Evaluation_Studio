# Test Spec Log: encryption-at-rest

**Phase**: 2 — Test Spec
**Date**: 2026-03-22
**Status**: Complete

## Clarifying Questions & Decisions

### Q1: What is the current test coverage baseline?

**Classification**: ANSWERED
**Source**: `grep -r "encrypt" --include="*.test.ts"` — 18 test files found, all in `packages/shared/src/__tests__/encryption/` and `packages/shared/src/encryption/__tests__/`
**Decision**: Documented full inventory of 18 unit test files. Zero integration tests, zero HTTP API E2E tests.

### Q2: Which functional requirements are highest risk?

**Classification**: DECIDED
**Decision**: FR-1 (all fields encrypted), FR-5 (multi-version), FR-6 (key rotation), and FR-9 (no ciphertext leak) are highest risk because they affect all data paths and have security implications.

### Q3: What external dependencies need mocking vs real integration?

**Classification**: DECIDED
**Decision**: E2E tests should use real encryption (never mock EncryptionService). Cloud KMS providers may use mocked endpoints. MongoDB via MongoMemoryServer for integration tests, real MongoDB for E2E.

### Q4: What E2E scenarios cover the critical user journeys?

**Classification**: DECIDED
**Decision**: 7 E2E scenarios covering: credential roundtrip, tenant isolation, auth profile update, session state, messages, key rotation, and null sentinel. These cover the 5 most common encrypted data types.

### Q5: What integration boundaries need testing?

**Classification**: DECIDED
**Decision**: 7 integration scenarios covering: Mongoose multi-version plugin, KMS provider pool, ClickHouse interceptor, GDPR crypto-shredding, BullMQ queue wrappers, double-encryption detection, and cache eviction.

## Key Findings

1. **Strong unit coverage**: 18 test files cover all core encryption functions
2. **Zero integration tests**: No tests at service-boundary level
3. **Zero HTTP API E2E tests**: No tests that exercise the full request -> encrypt -> store -> decrypt -> respond path
4. **No cloud KMS tests**: All KMS tests use `LocalKMSProvider`
5. **Test anti-patterns identified**: Must not mock EncryptionService in E2E, must not hardcode expected ciphertext (random IV makes it non-deterministic)
