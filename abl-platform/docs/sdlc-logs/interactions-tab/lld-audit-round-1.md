# LLD Audit Round 1: Interactions Tab

**Date**: 2026-04-02
**Phase**: LLD + Implementation Plan
**Auditor**: Manual audit (lld-reviewer agent spawn failed due to model config)
**Artifact**: `docs/plans/2026-04-02-interactions-tab-impl-plan.md`
**Round**: 1 of 5
**Focus**: Architecture compliance — isolation, auth, stateless, traceability, test integrity

---

## Verdict: APPROVED with minor recommendations

All critical architecture compliance checks passed. Test integrity strong. Minor improvements recommended but not blocking.

---

## Architecture Compliance Assessment

### 1. Platform Principles — Isolation ✅

**Tenant Isolation**:

- Phase 4 Task 4.2 (SEC-1): Cross-tenant isolation test verifies 404 response (not 403)
- Exit criteria: "Cross-tenant access returns 404, no data leakage"
- ✅ **VERIFIED**: Test designed correctly, honors platform principle (return 404, not 403)

**Project Isolation**:

- Phase 4 Task 4.3 (SEC-2): Cross-project isolation test verifies 404 response
- Auth context: "Login as user with access to project_test_001 only"
- ✅ **VERIFIED**: Test designed correctly

**User Isolation**:

- Not explicitly tested (Interactions tab inherits session-level isolation from Studio)
- ✅ **ACCEPTABLE**: User isolation is at session access level (already enforced by Studio auth)

---

### 2. Centralized Auth ✅

**E2E Auth Flow**:

- Phase 3 Task 3.3: `loginAsTestUser()` uses Studio's actual auth flow
- Comment: "Use Studio's actual auth flow (POST /api/auth/login), not mocked tokens"
- Exit criteria: "Auth helpers work: loginAsTestUser() returns valid JWT token"
- ✅ **VERIFIED**: Real auth flow, not mocked

**Auth Context**:

- Phase 4 Task 4.1: Auth context includes "tenant_test_001, project_test_001, user_test_001"
- ✅ **VERIFIED**: Full tenant/project/user context for isolation verification

---

### 3. Test Integrity ✅

**Integration Tests — No Mocking Codebase Components**:

- Phase 2 Exit Criteria: "Tests use realistic fixtures (no mocked ObservatoryStore or event-processor)"
- Test Strategy: "Integration: Real event processor, real fixtures, no mocks of codebase components"
- ✅ **VERIFIED**: Honors test integrity principle

**E2E Tests — Real System Interaction**:

- Phase 4 Exit Criteria: "Tests exercise real system: Studio server running, MongoDB connected, auth middleware active"
- Test Strategy: "E2E: Real browser automation via Playwright, real Studio server, real MongoDB, real auth flow"
- Comment: "No mocks: Exercise full middleware chain (auth, rate limiting, tenant isolation, validation)"
- ✅ **VERIFIED**: No mocked infrastructure, real servers

**E2E Tests — HTTP API Only**:

- Phase 4 Test Strategy: "Tests use HTTP API only (no direct DB queries, no mocked stores)"
- ✅ **VERIFIED**: Correct E2E boundary

**Structured Content Types**:

- Phase 4 Test Strategy: "Structured content: Test data includes arrays (interactions), objects (session summary), not just plain strings"
- ✅ **VERIFIED**: Tests validate structured data, not just strings

---

### 4. Stateless Distributed ✅

**Not Applicable**: Interactions tab is client-side feature, no server-side state.

**Test DB State**:

- Phase 3 Task 3.2: Test DB seeding creates temporary data for E2E tests
- Open Question 6: "Should E2E tests clean up test data after each run?"
- ⚠️ **RECOMMENDATION**: Add cleanup strategy to Phase 3 exit criteria (see MEDIUM-1 below)

---

### 5. Traceability ✅

**Not Applicable**: Interactions tab is an observability tool itself, doesn't emit trace events.

---

## Findings

### MEDIUM-1: Test Data Cleanup Strategy

**Location**: Phase 3 Task 3.2 (Test DB seeding), Open Question 6

**Issue**: Plan mentions test DB seeding but doesn't specify cleanup strategy. E2E tests may leave orphaned test data in `abl-studio-test` database.

**Current Text** (Open Question 6):

> Should E2E tests clean up test data after each run (delete sessions/traces), or keep test data for debugging?

**Recommendation**: Add cleanup to Phase 3 exit criteria:

```markdown
- [ ] Test DB cleanup works: afterEach hook calls clearTestData(), verifies no orphaned sessions
- [ ] Option: KEEP_TEST_DATA=1 env var skips cleanup for debugging
```

**Rationale**: E2E tests should clean up by default to prevent test DB bloat. Optional flag for debugging.

---

### MEDIUM-2: Integration Test Boundary Clarity

**Location**: Phase 2 Test Strategy

**Issue**: Test strategy says "No direct DB access, no WebSocket mocking" but integration tests don't interact with DB or WebSocket. This may confuse readers about what "integration" means here.

**Current Text**:

> No direct DB access, no WebSocket mocking (integration tests are logic-level, not API-level)

**Recommendation**: Clarify integration test boundary:

```markdown
Integration tests: Logic-level service boundary. Fixtures → event-processor → assertions on output. Not API-level (no HTTP), not DB-level (no Mongoose models), not WebSocket-level (no real-time events). Tests the event processing service boundary.
```

**Rationale**: "Integration test" can mean different things. Clarify that these test the event processor integration with fixtures, not API/DB integration.

---

### LOW-1: Phase Numbering Inconsistency

**Location**: §3 Implementation Phases

**Issue**: Phase 0 is labeled "RETROACTIVE — Already Complete" but phases are typically numbered starting from 1. This is unconventional.

**Recommendation**: Either:

- **Option A**: Rename Phase 0 to "Background: Existing Implementation" (not a phase, just context)
- **Option B**: Keep Phase 0 but add clarifying note at top of §3: "Phase 0 documents existing work. Phases 1-5 are forward-looking implementation."

**Rationale**: Readers expect phases to start at 1. Phase 0 may cause confusion.

**Decision**: Phase 0 is acceptable for retroactive documentation. Add clarifying note.

---

### LOW-2: Test Fixture Validation Task Missing

**Location**: Phase 1 Task 1.3

**Issue**: Task 1.3 says "Validate fixture schema against event-processor.ts" but doesn't specify HOW to validate or what test to write.

**Current Text**:

> Test: Create minimal fixture, pass to processEventsToInteractions(), assert no errors

**Recommendation**: Make this a concrete unit test:

```markdown
1.3. Write unit test for fixture factory

- File: `apps/studio/src/__tests__/fixtures/trace-events.test.ts`
- Test: `createLLMCallEvent()` produces event with data.usage.inputTokens
- Test: `processEventsToInteractions([createUserMessageEvent(), createLLMCallEvent()])` returns 1 interaction
- Assert: No errors, token extraction works
```

**Rationale**: "Validate" is vague. Concrete unit test with assertions is clearer.

---

### LOW-3: E2E Test Flakiness Mitigation

**Location**: Phase 4 Exit Criteria

**Issue**: Exit criteria mentions "no flakiness (retry successful on first run)" but plan doesn't specify anti-flakiness strategies.

**Recommendation**: Add to Phase 3 Task 3.1 (Playwright config):

```markdown
Config: Retries (2), timeout (30s), **waitForLoadState('networkidle')**, **screenshot on failure**, **trace on first retry**
```

**Rationale**: E2E tests notoriously flaky without proper wait strategies. Be explicit.

---

## Strengths

1. **Strong test integrity**: Integration tests don't mock event-processor, E2E tests use real servers with full middleware chain.

2. **Isolation tests designed correctly**: SEC-1 and SEC-2 verify 404 (not 403), include explicit auth context (tenant/project/user).

3. **Real auth flow**: E2E tests use POST /api/auth/login, not mocked JWT tokens.

4. **Measurable exit criteria**: Most phases have concrete exit criteria (e.g., "All 3 integration tests pass", "Smoke test passes").

5. **Wiring checklist complete**: Phase-by-phase wiring verification prevents "code that nothing calls" failure mode.

6. **File paths explicit**: All new files have exact paths (e.g., `apps/studio/src/__tests__/fixtures/trace-events.ts`), not vague (e.g., "somewhere in tests").

7. **Hybrid approach documented**: Clear distinction between Phase 0 (retroactive) and Phases 1-5 (forward-looking).

---

## Recommendations for Round 2

Round 2 (pattern consistency) should focus on:

1. **Existing test patterns**: How do other Studio features structure E2E tests? Should this follow the same pattern?
2. **Fixture patterns**: Are there existing fixture factories in Studio that should be reused?
3. **Test helper patterns**: Are there existing test-db or auth helpers that can be extended instead of creating new ones?
4. **Playwright config patterns**: If Studio has other Playwright tests, should this use the same config?

---

## Next Steps

1. ✅ Optional: Address MEDIUM-1 (test data cleanup strategy)
2. ✅ Optional: Address MEDIUM-2 (integration test boundary clarity)
3. ✅ Optional: Address LOW-1 (phase numbering note), LOW-2 (fixture validation test), LOW-3 (flakiness mitigation)
4. ⏭ Proceed to Round 2 audit (pattern consistency)
