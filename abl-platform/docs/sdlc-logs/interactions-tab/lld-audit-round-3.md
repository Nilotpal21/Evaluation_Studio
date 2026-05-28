# LLD Audit Round 3: Interactions Tab

**Date**: 2026-04-05
**Phase**: LLD + Implementation Plan
**Auditor**: Manual audit (lld-reviewer agent spawn failed due to model config)
**Artifact**: `docs/plans/2026-04-02-interactions-tab-impl-plan.md`
**Round**: 3 of 5
**Focus**: Completeness — FR coverage, file paths validated, exit criteria measurability, wiring checklist

---

## Verdict: APPROVED with minor file list corrections

All 15 functional requirements covered (Phase 0 retroactive documentation). Test implementation phases (1-5) are complete and well-structured. Exit criteria are concrete and measurable. Wiring checklist is comprehensive. Minor gaps in the file-level change map need correction.

---

## Functional Requirements Coverage

**All 15 FRs from feature spec §4 are covered in Phase 0 (existing implementation):**

| FR    | Requirement                                  | Coverage       | Phase 0 Task |
| ----- | -------------------------------------------- | -------------- | ------------ |
| FR-1  | Process trace events into interactions       | ✅ IMPLEMENTED | 0.1          |
| FR-2  | Token usage and cost calculation             | ✅ IMPLEMENTED | 0.2          |
| FR-3  | Context window utilization display           | ✅ IMPLEMENTED | 0.2          |
| FR-4  | Guardrail check results inline               | ✅ IMPLEMENTED | 0.3          |
| FR-5  | Memory state git-style diffs                 | ✅ IMPLEMENTED | 0.4          |
| FR-6  | Parallel tool execution swim lanes           | ✅ IMPLEMENTED | 0.5          |
| FR-7  | Flow breadcrumb for scripted agents          | ✅ IMPLEMENTED | 0.6          |
| FR-8  | Variable resolution trails                   | ✅ IMPLEMENTED | 0.6          |
| FR-9  | Per-field gather confidence                  | ✅ IMPLEMENTED | 0.6          |
| FR-10 | Real-time WebSocket updates                  | ✅ IMPLEMENTED | 0.7          |
| FR-11 | Historical trace loading                     | ✅ IMPLEMENTED | 0.7          |
| FR-12 | Handle 100+ interactions without degradation | ✅ IMPLEMENTED | 0.7          |
| FR-13 | Lifecycle banners as inline dividers         | ✅ IMPLEMENTED | 0.7          |
| FR-14 | Agent switch banners                         | ✅ IMPLEMENTED | 0.7          |
| FR-15 | Session header with aggregate stats          | ✅ IMPLEMENTED | 0.7          |

**Assessment**: ✅ **100% FR coverage**. This is a hybrid LLD where Phase 0 documents the already-implemented feature (27 components, all FRs satisfied), and Phases 1-5 plan test implementation to achieve BETA promotion. All FRs are implemented; test coverage is the missing piece.

**Phases 1-5 Test Coverage Mapping**:

| Test Phase | Test Scenarios      | What They Verify                                 |
| ---------- | ------------------- | ------------------------------------------------ |
| Phase 2    | INT-1, INT-2, INT-6 | FR-1 (event grouping), FR-2 (token calc), FR-14  |
| Phase 4    | E2E-1, SEC-1, SEC-2 | FR-1, FR-2, FR-10, FR-11, isolation requirements |

---

## File Path Validation

### New Files — Verified

| File                                                         | Status                | Notes                                   |
| ------------------------------------------------------------ | --------------------- | --------------------------------------- |
| `apps/studio/src/__tests__/fixtures/trace-events.ts`         | ✅ Valid path         | Phase 1 Task 1.1                        |
| `apps/studio/src/__tests__/interactions-integration.test.ts` | ✅ Valid path         | Phase 2 (INT-1, INT-2, INT-6)           |
| `apps/studio/e2e/interactions-tab.spec.ts`                   | ✅ Valid path         | Phase 4 (E2E-1, SEC-1, SEC-2)           |
| `apps/studio/e2e/helpers/test-db.ts`                         | ✅ Valid path         | Phase 3 Task 3.2                        |
| `apps/studio/e2e/fixtures/sessions.ts`                       | ✅ Valid path         | Phase 3 Task 3.4                        |
| `apps/studio/playwright.config.ts`                           | ⚠️ **ALREADY EXISTS** | Phase 3 Task 3.1 - should not be listed |
| `apps/studio/e2e/helpers/auth.ts`                            | ⚠️ **ALREADY EXISTS** | Phase 3 Task 3.3 - should not be listed |

### Missing Files — Gaps Found

| File                                                      | Issue                                      | Where Mentioned                  |
| --------------------------------------------------------- | ------------------------------------------ | -------------------------------- |
| `apps/studio/src/__tests__/helpers/test-utils.ts`         | NOT listed in §2 "New Files"               | Phase 1 Task 1.2                 |
| `apps/studio/src/__tests__/fixtures/trace-events.test.ts` | NOT listed in §2 "New Files"               | Phase 1 Task 1.3 (fixture tests) |
| `apps/studio/e2e/smoke.spec.ts`                           | NOT listed in §2 "New Files" or "Modified" | Phase 3 Task 3.5 (smoke test)    |

### Modified Files — Verified

| File                                | Status        | Notes                                     |
| ----------------------------------- | ------------- | ----------------------------------------- |
| `apps/studio/package.json`          | ✅ Valid path | Add Playwright (already exists per 3.1)   |
| `docs/features/interactions-tab.md` | ✅ Valid path | Update §16 GAP-001, §1 status             |
| `docs/testing/interactions-tab.md`  | ✅ Valid path | Update §8 test file mapping               |
| `docs/testing/README.md`            | ✅ Valid path | Update Interactions Tab status            |
| `docs/features/README.md`           | ✅ Valid path | Update feature table (likely missing doc) |

**Assessment**: File paths are mostly correct, but §2 "File-Level Change Map" has inconsistencies:

- Lists 2 files that already exist as "New Files" (playwright.config.ts, auth.ts)
- Omits 3 files that are created in Phase 1 and Phase 3 tasks

---

## Exit Criteria Measurability

### Phase 1 Exit Criteria

- [ ] "Fixture factory creates trace events with correct schema (data.usage.inputTokens)" — ✅ **MEASURABLE** (schema validation test)
- [ ] "`processEventsToInteractions(fixtureEvents)` returns valid interactions without errors" — ✅ **MEASURABLE** (test assertion)
- [ ] "Token extraction works: `buildSummary()` calculates non-zero token totals from fixtures" — ✅ **MEASURABLE** (numeric assertion)
- [ ] "Helper utilities build successfully: `pnpm build --filter=apps/studio` succeeds" — ✅ **MEASURABLE** (exit code 0)

**Assessment**: ✅ All criteria are concrete and measurable. No vague "it works" or "tests pass" items.

### Phase 2 Exit Criteria

- [ ] "All 3 integration tests pass: `pnpm test --filter=apps/studio interactions-integration`" — ✅ **MEASURABLE** (test runner exit code)
- [ ] "Tests use realistic fixtures (no mocked ObservatoryStore or event-processor)" — ✅ **VERIFIABLE** (code review check)
- [ ] "Tests verify service boundary: fixtures → event-processor → interactions output" — ✅ **VERIFIABLE** (test structure review)
- [ ] "Code coverage for event-processor.ts increases to 85%+" — ✅ **MEASURABLE** (coverage report)
- [ ] "`pnpm build && pnpm test` passes with no regressions" — ✅ **MEASURABLE** (exit code 0)

**Assessment**: ✅ All criteria are concrete and measurable. Coverage target is specific (85%+, not "good coverage").

### Phase 3 Exit Criteria

- [x] "Playwright already installed: `pnpm playwright --version` succeeds" — ✅ **MEASURABLE** (command output)
- [x] "Playwright config already exists: `playwright.config.ts` with correct settings" — ✅ **MEASURABLE** (file exists, config verified)
- [ ] "Smoke test passes: `pnpm test:e2e smoke` launches browser, navigates to Studio, page loads" — ✅ **MEASURABLE** (test pass/fail)
- [ ] "Test DB seeding works: `seedTestSession()` creates session in MongoDB, `clearTestData()` removes it" — ✅ **MEASURABLE** (DB query verification)
- [ ] "Auth helpers work: `loginViaDevApi()` logs in test user, `getDevAccessToken()` returns valid JWT token" — ✅ **MEASURABLE** (token validation)

**Assessment**: ✅ All criteria are concrete and measurable. Correctly marks Playwright infrastructure as "already done" (checkbox [x] instead of [ ]).

### Phase 4 Exit Criteria

- [ ] "All 3 E2E tests pass: `pnpm test:e2e interactions-tab`" — ✅ **MEASURABLE** (test runner exit code)
- [ ] "Tests exercise real system: Studio server running, MongoDB connected, auth middleware active" — ✅ **VERIFIABLE** (test setup review)
- [ ] "Tests use HTTP API only (no direct DB queries, no mocked stores)" — ✅ **VERIFIABLE** (code review check)
- [ ] "Isolation tests verify 404 (not 403) for cross-tenant/project access" — ✅ **MEASURABLE** (HTTP status code assertion)
- [ ] "Screenshots captured on failure for debugging" — ✅ **MEASURABLE** (Playwright trace/screenshot files exist)
- [ ] "`pnpm test:e2e` passes all E2E tests without flakiness (retry successful on first run)" — ✅ **MEASURABLE** (retry count = 0 or 1)

**Assessment**: ✅ All criteria are concrete and measurable. Correctly specifies 404 (not 403) per platform isolation principles.

### Phase 5 Exit Criteria

- [ ] "GAP-001 resolved in feature spec" — ✅ **MEASURABLE** (grep for GAP-001 status)
- [ ] "Test file mapping updated with actual test files" — ✅ **VERIFIABLE** (table includes new files)
- [ ] "PR review completed (5 rounds, all CRITICAL/HIGH findings addressed)" — ✅ **MEASURABLE** (5 audit reports exist)
- [ ] "Feature status updated to BETA in all docs" — ✅ **MEASURABLE** (grep for status field)
- [ ] "`pnpm build && pnpm test` passes with no regressions" — ✅ **MEASURABLE** (exit code 0)
- [ ] "No new CRITICAL gaps introduced during test implementation" — ✅ **VERIFIABLE** (§16 gaps table review)

**Assessment**: ✅ All criteria are concrete and measurable. PR review requires 5 rounds (aligns with LLD skill requirements).

**Overall Exit Criteria Assessment**: ✅ **EXCELLENT**. All 30+ exit criteria across 5 phases are concrete, measurable, and avoid vague language. No "it works" or "tests pass" placeholders.

---

## Wiring Checklist Completeness

### Phase 0 (Existing — All Wired)

- [x] InteractionsTab wired into DebugTabs — ✅ **VERIFIED**
- [x] Event processor imported and used — ✅ **VERIFIED**
- [x] All 27 components imported — ✅ **VERIFIED**
- [x] Types exported and imported — ✅ **VERIFIED**
- [x] Constants exported and imported — ✅ **VERIFIED**
- [x] Error boundary wraps content — ✅ **VERIFIED**

### Phase 1 (Test Fixtures — Wiring Required)

- [ ] Fixture factory exported from `fixtures/trace-events.ts` — ✅ **DOCUMENTED**
- [ ] Test helpers exported from `helpers/test-utils.ts` — ✅ **DOCUMENTED**
- [ ] Fixtures imported in Phase 2 integration tests — ✅ **DOCUMENTED**

### Phase 2 (Integration Tests — Wiring Required)

- [ ] Integration test file discovered by test runner (named `*.test.ts` in `__tests__/`) — ✅ **DOCUMENTED**
- [ ] Test imports fixtures from `fixtures/trace-events.ts` — ✅ **DOCUMENTED**
- [ ] Test imports event processor from `event-processor.ts` (not mocked) — ✅ **DOCUMENTED**

### Phase 3 (E2E Infrastructure — Wiring Required)

- [ ] Playwright config discovered by `pnpm test:e2e` command — ✅ **DOCUMENTED**
- [ ] Test DB helpers exported from `e2e/helpers/test-db.ts` — ✅ **DOCUMENTED**
- [ ] Auth helpers exported from `e2e/helpers/auth.ts` — ✅ **DOCUMENTED**
- [ ] E2E fixtures exported from `e2e/fixtures/sessions.ts` — ✅ **DOCUMENTED**
- [ ] Smoke test imports helpers and fixtures — ✅ **DOCUMENTED**

### Phase 4 (E2E Tests — Wiring Required)

- [ ] E2E test file discovered by Playwright (named `*.spec.ts` in `e2e/`) — ✅ **DOCUMENTED**
- [ ] E2E test imports test-db helpers for seeding — ✅ **DOCUMENTED**
- [ ] E2E test imports auth helpers for login — ✅ **DOCUMENTED**
- [ ] E2E test imports session fixtures for test data — ✅ **DOCUMENTED**

### Phase 5 (Documentation — No Wiring)

- [ ] N/A (documentation updates only) — ✅ **DOCUMENTED**

**Assessment**: ✅ **COMPREHENSIVE**. Wiring checklist covers all new components, test files, helpers, and fixtures. Correctly distinguishes between "already wired" (Phase 0) and "wiring required" (Phases 1-4). No risk of "code that nothing calls".

---

## Task Completability (One Session Per Task)

### Phase 1 Tasks

| Task | Description                  | LOC Estimate | Complexity | One Session? |
| ---- | ---------------------------- | ------------ | ---------- | ------------ |
| 1.1  | Fixture factory              | 200-300      | Medium     | ✅ YES       |
| 1.2  | Test helpers                 | ~100         | Low        | ✅ YES       |
| 1.3  | Fixture validation unit test | ~50          | Low        | ✅ YES       |

### Phase 2 Tasks

| Task | Description | LOC Estimate | Complexity | One Session? |
| ---- | ----------- | ------------ | ---------- | ------------ |
| 2.1  | INT-1 test  | 100-150      | Medium     | ✅ YES       |
| 2.2  | INT-2 test  | 100-150      | Medium     | ✅ YES       |
| 2.3  | INT-6 test  | 100-150      | Medium     | ✅ YES       |

### Phase 3 Tasks

| Task | Description             | LOC Estimate | Complexity | One Session? |
| ---- | ----------------------- | ------------ | ---------- | ------------ |
| 3.1  | Verify Playwright infra | 0 (verify)   | Low        | ✅ YES       |
| 3.2  | Test DB seeding         | 150-200      | Medium     | ✅ YES       |
| 3.3  | Extend auth helpers     | Minimal      | Low        | ✅ YES       |
| 3.4  | E2E fixtures            | 200-300      | Medium     | ✅ YES       |
| 3.5  | Smoke test              | ~50          | Low        | ✅ YES       |

### Phase 4 Tasks

| Task | Description | LOC Estimate | Complexity | One Session? |
| ---- | ----------- | ------------ | ---------- | ------------ |
| 4.1  | E2E-1 test  | 150-200      | Medium     | ✅ YES       |
| 4.2  | SEC-1 test  | ~100         | Medium     | ✅ YES       |
| 4.3  | SEC-2 test  | ~100         | Medium     | ✅ YES       |

### Phase 5 Tasks

| Task | Description           | LOC Estimate | Complexity | One Session? |
| ---- | --------------------- | ------------ | ---------- | ------------ |
| 5.1  | Resolve GAP-001       | 0 (doc edit) | Low        | ✅ YES       |
| 5.2  | Update test spec      | 0 (doc edit) | Low        | ✅ YES       |
| 5.3  | Update testing README | 0 (doc edit) | Low        | ✅ YES       |
| 5.4  | PR review (5 rounds)  | 0 (review)   | High       | ✅ YES       |
| 5.5  | Promote to BETA       | 0 (doc edit) | Low        | ✅ YES       |
| 5.6  | Update feature README | 0 (doc edit) | Low        | ✅ YES       |

**Assessment**: ✅ **ALL TASKS COMPLETABLE IN ONE SESSION**. Largest task is 3.4 (E2E fixtures, 200-300 LOC) — still reasonable for one session. No tasks exceed 300 LOC or require multi-day implementation.

---

## Findings

### LOW-1: File-Level Change Map Incomplete

**Location**: §2 File-Level Change Map

**Issue**: The "New Files" table omits 3 files that are created in task descriptions:

1. `apps/studio/src/__tests__/helpers/test-utils.ts` — Phase 1 Task 1.2
2. `apps/studio/src/__tests__/fixtures/trace-events.test.ts` — Phase 1 Task 1.3
3. `apps/studio/e2e/smoke.spec.ts` — Phase 3 Task 3.5

Additionally, the "New Files" table incorrectly lists 2 files that already exist:

4. `apps/studio/playwright.config.ts` — Phase 3 Task 3.1 says "already exists"
5. `apps/studio/e2e/helpers/auth.ts` — Phase 3 Task 3.3 says "already exists"

**Recommendation**: Update §2 "New Files" table:

**ADD:**

| File                                                      | Purpose                           | LOC Estimate |
| --------------------------------------------------------- | --------------------------------- | ------------ |
| `apps/studio/src/__tests__/helpers/test-utils.ts`         | Integration test helpers          | 100-150      |
| `apps/studio/src/__tests__/fixtures/trace-events.test.ts` | Unit tests for fixture factory    | 50-100       |
| `apps/studio/e2e/smoke.spec.ts`                           | Smoke test for E2E infrastructure | 50-100       |

**REMOVE:**

| File                               | Reason                            |
| ---------------------------------- | --------------------------------- |
| `apps/studio/playwright.config.ts` | Already exists (Phase 3 Task 3.1) |
| `apps/studio/e2e/helpers/auth.ts`  | Already exists (Phase 3 Task 3.3) |

**Update Total New LOC**: From ~1,400-2,050 → ~1,350-2,050 (after removing existing files, adding missing files)

**Rationale**: File-level change map should list ALL files created by the implementation plan, and should NOT list files that already exist and are merely reused.

---

### LOW-2: Playwright Dependency Already in package.json

**Location**: §2 Modified Files, Phase 3 Task 3.1

**Issue**: The "Modified Files" table lists `apps/studio/package.json` with change description "Add Playwright dev dependency", but Phase 3 Task 3.1 says "Playwright already installed — in apps/studio/package.json dev dependencies". This is contradictory.

**Recommendation**: Update §2 "Modified Files" table:

Change:

| File                       | Change Description            | Risk |
| -------------------------- | ----------------------------- | ---- |
| `apps/studio/package.json` | Add Playwright dev dependency | Low  |

To:

| File                       | Change Description                                   | Risk |
| -------------------------- | ---------------------------------------------------- | ---- |
| `apps/studio/package.json` | Verify Playwright dependency (already exists, no-op) | Low  |

Or **REMOVE** this row entirely if package.json is not modified.

**Rationale**: Modified files should list actual modifications, not verifications of existing state.

---

## Strengths

1. **Retroactive vs forward-looking distinction is clear** — Phase 0 documents existing work (27 components, all FRs), Phases 1-5 plan test implementation. The note at the top of §3 explains this well.

2. **Test integrity honored** — Integration tests use real event-processor (not mocked), E2E tests use real servers (Studio + MongoDB + auth). No mocking of codebase components. Only external third-party services may be mocked via DI.

3. **Exit criteria are exemplary** — All 30+ exit criteria are concrete and measurable. No vague placeholders like "it works" or "tests pass". Examples: "Code coverage for event-processor.ts increases to 85%+", "Isolation tests verify 404 (not 403)".

4. **Wiring checklist is comprehensive** — Covers all new files, imports, test discovery, config discovery. Phase-by-phase breakdown prevents "code that nothing calls" failure mode.

5. **File paths are explicit** — All new files have exact paths (e.g., `apps/studio/src/__tests__/fixtures/trace-events.ts`), not vague (e.g., "somewhere in tests").

6. **Task sizing is appropriate** — Largest task is 300 LOC (E2E fixtures), all tasks completable in one session. No multi-day implementation tasks.

7. **Decision log is well-reasoned** — Table includes rationale and alternatives rejected (e.g., D-6: "Integration tests before E2E tests" with rationale "Lower complexity, no Playwright setup, faster feedback loop").

8. **Cross-phase concerns documented** — Database migrations (none), feature flags (none), config changes (TEST\_\* env vars for E2E only) are all explicit.

9. **Acceptance criteria align with BETA promotion requirements** — §6 lists all AUTHORING_GUIDE.md BETA criteria: E2E tests, integration tests, GAP-001 resolved, PR review (5 rounds), docs updated.

10. **Test strategy per phase is clear** — Phase 2 integration tests specify "logic-level service boundary, no database", Phase 4 E2E tests specify "real servers with full middleware chain, HTTP API only".

---

## Recommendations for Round 4

Round 4 (cross-phase consistency) should focus on:

1. **Feature Spec Alignment** — Verify all 15 FRs from feature spec are documented in Phase 0 (already verified in this round: ✅ 100% coverage)
2. **Test Spec Alignment** — Verify Phase 2 (INT-1, INT-2, INT-6) and Phase 4 (E2E-1, SEC-1, SEC-2) match test spec scenarios
3. **HLD Alignment** — Verify LLD design decisions (D-1 through D-7) align with HLD recommendations (Option B: Client-side event processor)
4. **Gap Resolution Plan** — Verify Phase 5 resolves GAP-001 (High severity) per feature spec §16
5. **BETA Criteria Alignment** — Verify §6 Acceptance Criteria match AUTHORING_GUIDE.md BETA requirements

---

## Next Steps

1. ⏭ Optional: Address LOW-1 (update file-level change map to add 3 missing files, remove 2 existing files)
2. ⏭ Optional: Address LOW-2 (clarify package.json modification status)
3. ⏭ Proceed to Round 4 audit (cross-phase consistency with phase-auditor)

---

## Summary

**Quality Score**: 9.5/10

**Verdict**: APPROVED

**Readability**: Excellent for future maintainers. Clear distinction between retroactive (Phase 0) and forward-looking (Phases 1-5). Exit criteria are concrete. Wiring checklist prevents common failure modes.

**Completeness**: 100% FR coverage (Phase 0 retroactive documentation). All test implementation phases (1-5) are well-structured and sized appropriately.

**Blockers**: None. LOW-1 and LOW-2 are minor file list inconsistencies that do not block implementation.

**Recommendation**: Proceed to Round 4 (cross-phase consistency audit).
