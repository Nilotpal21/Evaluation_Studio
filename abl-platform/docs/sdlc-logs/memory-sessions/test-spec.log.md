# SDLC Log: memory-sessions / Test Spec (Phase 2)

**Date**: 2026-03-22
**Phase**: Test Spec
**Artifact**: `docs/testing/memory-sessions.md`

---

## Clarifying Questions & Decisions

### Test Scope & Priorities

| #   | Question                                 | Classification | Answer                                                                                                                                                                                                                    |
| --- | ---------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Which FRs are highest risk?              | ANSWERED       | FR-1 (tiered storage) and FR-6 (API auth) — GAP-006 (cross-tenant E2E) and GAP-007 (messageType bypass) are HIGH severity.                                                                                                |
| 2   | Current test coverage baseline?          | ANSWERED       | 57+ test files, ~1,198+ tests passing. Extensive unit and integration coverage.                                                                                                                                           |
| 3   | What external dependencies need mocking? | DECIDED        | Redis and MongoDB should use real instances for integration tests. Only external third-party services (e.g., LLM providers for compaction) should be mocked. MemorySessionStore is an acceptable fallback for unit tests. |

### E2E Scenarios

| #   | Question                         | Classification | Answer                                                                                                                                                                               |
| --- | -------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 4   | What critical journeys need E2E? | INFERRED       | Session CRUD, cold restore, cross-tenant isolation, ownership tiers, cleanup retention, memory REMEMBER/RECALL, channel artifact resolution. Based on FRs and gap analysis.          |
| 5   | What auth combinations need E2E? | ANSWERED       | SDK session tokens (Tier 0), channel artifacts (Tier 1), verified contacts (Tier 2), admin (tenant:manage_settings). From `session-ownership.ts` and `sessions.ts` route middleware. |

### Integration Boundaries

| #   | Question                                         | Classification | Answer                                                                                                                                                      |
| --- | ------------------------------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6   | Which service boundaries need integration tests? | ANSWERED       | Redis store operations, TieredSessionStore cold fallback, session routes with full middleware chain, admin dashboard, memory bridge. All currently covered. |
| 7   | Concurrency scenarios?                           | ANSWERED       | Optimistic concurrency via Lua version check (tested in redis-e2e). Execution lock via SET NX PX (tested in session-service).                               |

---

## Self-Audit Checklist

- [x] Coverage matrix maps all 9 FRs to test types
- [x] 7 E2E test scenarios (exceeds minimum 5)
- [x] 7 integration test scenarios (exceeds minimum 5)
- [x] Complete test file inventory (59 files)
- [x] Open gaps documented with severity and recommendations
- [x] Test environment requirements specified
- [x] Running instructions provided
- [x] Pending work items listed
