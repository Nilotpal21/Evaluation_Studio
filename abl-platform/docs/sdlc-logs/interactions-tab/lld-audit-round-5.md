# LLD Audit Round 5: Interactions Tab

**Date**: 2026-04-05
**Phase**: LLD + Implementation Plan
**Auditor**: Manual audit (lld-reviewer agent spawn failed due to model config)
**Artifact**: `docs/plans/2026-04-02-interactions-tab-impl-plan.md`
**Round**: 5 of 5 (FINAL)
**Focus**: Final sweep — task independence, wiring checklist, domain rules, exit criteria, open questions

---

## Verdict: APPROVED — READY FOR IMPLEMENTATION

All 5 audit rounds complete with no blocking findings. LLD is comprehensive, architecturally sound, and ready for phased implementation. Minor findings from Rounds 1-4 have been addressed or logged for Phase 5 resolution.

---

## Final Sweep Verification

### 1. Task Independence

**Verification**: Can each task be completed without blocking on other in-flight tasks?

**Phase 1 Dependencies:**

| Task | Depends On                | Independent? |
| ---- | ------------------------- | ------------ |
| 1.1  | None (creates fixtures)   | ✅ YES       |
| 1.2  | None (creates helpers)    | ✅ YES       |
| 1.3  | Task 1.1 (tests fixtures) | ⚠️ BLOCKS    |

**Phase 2 Dependencies:**

| Task | Depends On                       | Independent? |
| ---- | -------------------------------- | ------------ |
| 2.1  | Phase 1 Task 1.1 (uses fixtures) | ⚠️ BLOCKS    |
| 2.2  | Phase 1 Task 1.1 (uses fixtures) | ⚠️ BLOCKS    |
| 2.3  | Phase 1 Task 1.1 (uses fixtures) | ⚠️ BLOCKS    |

**Phase 3 Dependencies:**

| Task | Depends On                          | Independent? |
| ---- | ----------------------------------- | ------------ |
| 3.1  | None (verification only)            | ✅ YES       |
| 3.2  | None (creates test DB helpers)      | ✅ YES       |
| 3.3  | None (extends existing auth)        | ✅ YES       |
| 3.4  | None (creates E2E fixtures)         | ✅ YES       |
| 3.5  | Tasks 3.1-3.4 (smoke test uses all) | ⚠️ BLOCKS    |

**Phase 4 Dependencies:**

| Task | Depends On                                         | Independent? |
| ---- | -------------------------------------------------- | ------------ | --------- |
| 4.1  | Phase 3 Tasks 3.2-3.4 (uses seeding, auth, fixture | s)           | ⚠️ BLOCKS |
| 4.2  | Phase 3 Tasks 3.2-3.3 (uses seeding, auth)         | ⚠️ BLOCKS    |
| 4.3  | Phase 3 Tasks 3.2-3.3 (uses seeding, auth)         | ⚠️ BLOCKS    |

**Phase 5 Dependencies:**

| Task | Depends On                              | Independent? |
| ---- | --------------------------------------- | ------------ |
| 5.1  | Phase 2, 4 complete (verifies tests)    | ⚠️ BLOCKS    |
| 5.2  | Phase 2, 4 complete (updates test spec) | ⚠️ BLOCKS    |
| 5.3  | Phases 2, 4 complete (updates README)   | ⚠️ BLOCKS    |
| 5.4  | Phases 1-4 complete (PR review)         | ⚠️ BLOCKS    |
| 5.5  | Task 5.4 complete (promotes to BETA)    | ⚠️ BLOCKS    |
| 5.6  | Task 5.5 complete (updates README)      | ⚠️ BLOCKS    |

**Assessment**: ✅ **TASK DEPENDENCIES ARE CORRECT**

- Phase 1 tasks are independent except 1.3 (which tests 1.1 output)
- Phase 2 tasks all depend on Phase 1 completion (correct — need fixtures)
- Phase 3 tasks are independent except 3.5 (smoke test, which validates all)
- Phase 4 tasks all depend on Phase 3 completion (correct — need infrastructure)
- Phase 5 tasks are sequential (correct — doc updates after implementation)

**No unnecessary blocking**: All dependencies are genuine (a task cannot start until its prerequisite output exists).

**Parallelism opportunities**:

- Phase 1: Tasks 1.1 and 1.2 can run in parallel (both create files independently)
- Phase 3: Tasks 3.1-3.4 can run in parallel (all independent)

---

### 2. Wiring Checklist Final Verification

**Section §4 Wiring Checklist** — verify all new components are wired:

| Phase   | New Component                 | Wired Into                            | Verified                        |
| ------- | ----------------------------- | ------------------------------------- | ------------------------------- | ------ |
| Phase 1 | `fixtures/trace-events.ts`    | Phase 2 integration tests import      | ✅ YES                          |
| Phase 1 | `helpers/test-utils.ts`       | Phase 2 integration tests import      | ✅ YES                          |
| Phase 2 | `interactions-integration.ts` | Test runner (\*.test.ts in **tests**) | ✅ YES                          |
| Phase 3 | `e2e/helpers/test-db.ts`      | Phase 4 E2E tests import (seeding)    | ✅ YES                          |
| Phase 3 | `e2e/helpers/auth.ts`         | Phase 4 E2E tests import (login)      | ✅ YES                          |
| Phase 3 | `e2e/fixtures/sessions.ts`    | Phase 4 E2E tests import (test data)  | ✅ YES                          |
| Phase 3 | `e2e/smoke.spec.ts`           | Playwright (\*.spec.ts in e2e/)       | ✅ YES                          |
| Phase 4 | `e2e/interactions-tab.spec.ts | `                                     | Playwright (\*.spec.ts in e2e/) | ✅ YES |

**Assessment**: ✅ **ALL NEW COMPONENTS WIRED**

- Test fixtures are imported by integration tests
- E2E helpers are imported by E2E tests
- Test files are discovered by test runners (naming convention)
- No "code that nothing calls" risk

**Verification method**: Wiring checklist §4 explicitly lists all imports and discovery mechanisms per phase.

---

### 3. Domain Rules (Platform Principles)

**Verification**: Does LLD honor platform principles from CLAUDE.md?

#### 3.1 Isolation (Tenant, Project, User)

| Principle                         | LLD Coverage                                                         | Verified                                                           |
| --------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------ | ------ |
| Cross-tenant returns 404 (not 403 | )                                                                    | Phase 4 Task 4.2 (SEC-1): "Verify access is denied with 404 error" | ✅ YES |
| Cross-project returns 404         | Phase 4 Task 4.3 (SEC-2): "Verify access is denied with 404 error"   | ✅ YES                                                             |
| Every query scoped to tenantId    | Inherited from ObservatoryStore (Phase 0 note)                       | ✅ YES                                                             |
| Auth context in E2E tests         | Phase 4 Task 4.1: "tenant_test_001, project_test_001, user_test_001" | ✅ YES                                                             |

#### 3.2 Centralized Auth

| Principle                         | LLD Coverage                                                  | Verified |
| --------------------------------- | ------------------------------------------------------------- | -------- |
| Use requireAuth, no custom tokens | Phase 3 Task 3.3: "Use Studio's actual auth flow, not mocked" | ✅ YES   |
| E2E tests use real auth           | Phase 3 Task 3.3: "loginViaDevApi(), getDevAccessToken()"     | ✅ YES   |
| No JWT mocking                    | Phase 3 Task 3.3: "POST /api/auth/dev-login, injects cookies" | ✅ YES   |

#### 3.3 Test Integrity (No Mocking Codebase Components)

| Principle                           | LLD Coverage                                                                                     | Verified                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | ------------------ | ------ |
| Integration tests: real components  | Phase 2 Exit Criteria: "Tests use realistic fixtures (no mocked ObservatoryStore or event-proces | sor)"                                                             | ✅ YES             |
| E2E tests: real servers             | Phase 4 Exit Criteria: "Tests exercise real system: Studio server running, MongoDB connected, au | th                                                                | middleware active" | ✅ YES |
| E2E tests: HTTP API only            | Phase 4 Test Strategy: "Tests use HTTP API only (no direct DB queries, no mocked stores)"        | ✅ YES                                                            |
| Only external services may be mocke | d                                                                                                | Phase 4 Test Strategy: "No mocks: Exercise full middleware chain" | ✅ YES             |

#### 3.4 Stateless Distributed

| Principle          | LLD Coverage                                        | Verified |
| ------------------ | --------------------------------------------------- | -------- |
| No pod-local state | Phase 0 note: "Client-side processing, no backend"  | ✅ YES   |
| Test DB cleanup    | Phase 3 Exit Criteria: "clearTestData() removes it" | ✅ YES   |

#### 3.5 Traceability

| Principle      | LLD Coverage                                                     | Verified |
| -------------- | ---------------------------------------------------------------- | -------- |
| No requirement | Feature is observability tool itself, does not emit trace events | ✅ N/A   |

#### 3.6 Compliance

| Principle      | LLD Coverage                                                  | Verified                                                   |
| -------------- | ------------------------------------------------------------- | ---------------------------------------------------------- | ------ |
| No PII redacti | on                                                            | Feature spec §12.3: "Tab surfaces PII but does not redact" | ✅ N/A |
| TTL on traces  | Feature spec §12.6: "Traces have TTL configured in TraceStore | "                                                          | ✅ N/A |

**Assessment**: ✅ **ALL PLATFORM PRINCIPLES HONORED**

- Isolation: SEC-1, SEC-2 verify 404 (not 403)
- Auth: Real auth flow, no mocking
- Test integrity: No mocked codebase components, real servers
- Stateless: Client-side processing, test cleanup
- Traceability: N/A (observability tool)
- Compliance: N/A (no data mutations)

---

### 4. Exit Criteria Verification

**Verification**: Are all exit criteria concrete and measurable? (Already verified in Round 3, but double-checking)

**Phase 1 Exit Criteria:**

| Criterion                                                                    | Measurable? |
| ---------------------------------------------------------------------------- | ----------- | ------- | ------ |
| "Fixture factory creates trace events with correct schema (data.usage.inputT | okens)"     | ✅ YES  |
| "`processEventsToInteractions(fixtureEvents)` returns valid interactions wit | hout        | errors" | ✅ YES |
| "Token extraction works: `buildSummary()` calculates non-zero token totals"  | ✅ YES      |
| "Helper utilities build successfully: `pnpm build --filter=apps/studio` succ | eeds"       | ✅ YES  |

**Phase 2 Exit Criteria:**

| Criterion                                                                  | Measurable? |
| -------------------------------------------------------------------------- | ----------- | ------------- | ------ |
| "All 3 integration tests pass: `pnpm test --filter=apps/studio interaction | s-          | integration`" | ✅ YES |
| "Tests use realistic fixtures (no mocked ObservatoryStore or event-process | or)"        | ✅ VERIFIABLE |
| "Code coverage for event-processor.ts increases to 85%+"                   | ✅ YES      |
| "`pnpm build && pnpm test` passes with no regressions"                     | ✅ YES      |

**Phase 3 Exit Criteria:**

| Criterion                                                                  | Measurable? |
| -------------------------------------------------------------------------- | ----------- | ----------- | ----------- | ------ |
| "Playwright already installed: `pnpm playwright --version` succeeds"       | ✅ YES      |
| "Smoke test passes: `pnpm test:e2e smoke` launches browser, navigates to S | tudio,      | page loads" | ✅ YES      |
| "Test DB seeding works: `seedTestSession()` creates session in MongoDB, `c | learTestDat | a()`        | removes it" | ✅ YES |
| "Auth helpers work: `loginViaDevApi()` logs in test user"                  | ✅ YES      |

**Phase 4 Exit Criteria:**

| Criterion                                                                 | Measurable? |
| ------------------------------------------------------------------------- | ----------- | ----------- | ------ |
| "All 3 E2E tests pass: `pnpm test:e2e interactions-tab`"                  | ✅ YES      |
| "Isolation tests verify 404 (not 403) for cross-tenant/project access"    | ✅ YES      |
| "`pnpm test:e2e` passes all E2E tests without flakiness (retry successful | on          | first run)" | ✅ YES |

**Phase 5 Exit Criteria:**

| Criterion                                                              | Measurable? |
| ---------------------------------------------------------------------- | ----------- |
| "GAP-001 resolved in feature spec"                                     | ✅ YES      |
| "PR review completed (5 rounds, all CRITICAL/HIGH findings addressed)" | ✅ YES      |
| "Feature status updated to BETA in all docs"                           | ✅ YES      |
| "`pnpm build && pnpm test` passes with no regressions"                 | ✅ YES      |

**Assessment**: ✅ **ALL EXIT CRITERIA ARE CONCRETE AND MEASURABLE**

- No vague placeholders like "it works" or "tests pass"
- All criteria specify exact commands or file changes
- Coverage targets are numeric (e.g., 85%+, 3 tests, 5 rounds)

---

### 5. Open Questions Actionability

**Section §7 Open Questions** — verify questions have enough context for future decision-making:

| #   | Question                                                                       | Actionable? | Context Sufficient?            |
| --- | ------------------------------------------------------------------------------ | ----------- | ------------------------------ | --------------- | --------- | ---------------- |
| 1   | Playwright vs Cypress — is Playwright decision final?                          | ✅ YES      | ✅ YES (test spec              |
|     |                                                                                | mentions    | Playwright)                    |
| 2   | Test DB seeding strategy — inline or shared scripts?                           | ✅ YES      | ✅ YES (options                |
|     |                                                                                | clear)      |                                |
| 3   | WebSocket mocking for real-time tests — mock or real Runtime?                  | ✅ YES      | ✅ YES (E2E-2                  |
|     |                                                                                | scenario)   |                                |
| 4   | Remaining integration scenarios (INT-3 through INT-8) — immediate or post-BETA | ?           | ✅ YES                         | ✅ YES (BETA vs | post-BETA | trade-off clear) |
| 5   | Remaining E2E scenarios (E2E-2 through E2E-5) — immediate or post-BETA?        | ✅ YES      | ✅ YES (BETA vs                |
|     |                                                                                | post-BETA   | trade-off clear)               |
| 6   | Test data cleanup — delete after each run or keep for debugging?               | ✅ YES      | ✅ YES (Phase 3                |
|     |                                                                                | Exit        | Criteria: KEEP_TEST_DATA flag) |
| 7   | CI integration — run E2E in GitHub Actions or only locally?                    | ✅ YES      | ✅ YES (CI vs local            |
|     |                                                                                | trade-off)  |                                |

**Assessment**: ✅ **ALL OPEN QUESTIONS ARE ACTIONABLE**

- Each question has clear options (A vs B)
- Context is sufficient for decision-making
- No vague "how should we approach X?" questions

---

## Final Quality Assessment

### Completeness (100%)

- ✅ 100% FR coverage (all 15 FRs documented in Phase 0)
- ✅ All phases have measurable exit criteria
- ✅ All new files listed in §2 File-Level Change Map
- ✅ All dependencies listed in §5 Cross-Phase Concerns
- ✅ All acceptance criteria listed in §6
- ✅ All open questions listed in §7

### Consistency (100%)

- ✅ HLD alignment: LLD D-1 chooses HLD Option B (verified in Round 4)
- ✅ Test spec alignment: LLD implements minimum 3+3 scenarios (verified in Round 4)
- ✅ GAP-001 resolution: Phase 5 Task 5.1 correctly resolves (verified in Round 4)
- ✅ BETA criteria: §6 matches AUTHORING_GUIDE.md (verified in Round 4)

### Correctness (100%)

- ✅ Platform principles honored: isolation (404), auth (real), test integrity (no mocks)
- ✅ Task dependencies correct: no unnecessary blocking
- ✅ Wiring checklist complete: all new components wired into callers
- ✅ Exit criteria measurable: no vague placeholders

### Readability (95%)

- ✅ Clear phase numbering (Phase 0 = retroactive, Phases 1-5 = forward-looking)
- ✅ Explicit file paths (not "somewhere in tests")
- ✅ Decision rationale documented (§1 Decision Log)
- ⚠️ Minor: INT-6 not in test spec (logged in Round 4, will be fixed in Phase 5)

---

## Summary of All 5 Rounds

| Round | Focus                   | Findings          | Status   |
| ----- | ----------------------- | ----------------- | -------- | -------- |
| 1     | Architecture compliance | 2 MEDIUM, 3 LOW   | APPROVED |
| 2     | Pattern consistency     | 2 HIGH, 2 MEDIUM, | 1 LOW    | APPROVED |
| 3     | Completeness            | 2 LOW             | APPROVED |
| 4     | Cross-phase consistency | 1 MEDIUM          | APPROVED |
| 5     | Final sweep             | 0 BLOCKING        | APPROVED |

**Total Findings**: 2 HIGH (addressed), 5 MEDIUM (4 addressed, 1 deferred to Phase 5), 6 LOW (addressed)

**Blockers**: 0

**All HIGH findings addressed**:

- Round 2 HIGH-1: Reuse existing auth helpers ✅
- Round 2 HIGH-2: Reuse existing Playwright config ✅

**All MEDIUM findings addressed or deferred**:

- Round 1 MEDIUM-1: Test data cleanup strategy ✅
- Round 1 MEDIUM-2: Integration test boundary clarity ✅
- Round 2 MEDIUM-1: Integration test DB strategy (no DB) ✅
- Round 2 MEDIUM-2: E2E test DB strategy (real MongoDB) ✅
- Round 4 MEDIUM-1: INT-6 not in test spec ⏭ (deferred to Phase 5 Task 5.2)

---

## Final Recommendations

**For Implementation:**

1. Follow phase order: 1 → 2 → 3 → 4 → 5 (dependencies are correct)
2. Phase 1 Tasks 1.1 and 1.2 can run in parallel (both independent)
3. Phase 3 Tasks 3.1-3.4 can run in parallel (all independent)
4. Run `pnpm build --filter=apps/studio` after each file change (incremental typechecking)
5. Run `npx prettier --write <files>` before every commit
6. During Phase 5 Task 5.2 (Update test spec), add INT-6 to test spec §5 to resolve Round 4 MEDIUM-1

**For Future Enhancements:**

1. Post-BETA: Implement remaining integration tests (INT-3, INT-4, INT-5 from test spec)
2. Post-BETA: Implement remaining E2E tests (E2E-2 through E2E-5 from test spec)
3. Post-BETA: Consider virtualization for sessions with 500+ interactions (GAP-003)

---

## Verdict: APPROVED — READY FOR IMPLEMENTATION

**Quality Score**: 9.5/10

**All 5 audit rounds complete**. No blocking findings. All HIGH and MEDIUM findings addressed or deferred to Phase 5. LLD is comprehensive, architecturally sound, and honors all platform principles.

**Recommendation**: Proceed with implementation. User should run `/implement interactions-tab` to execute Phases 1-5 of this implementation plan.

**Next Step**: Commit LLD and all audit logs, then begin implementation.
