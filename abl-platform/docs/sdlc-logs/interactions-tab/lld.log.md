# LLD Log: Interactions Tab

**Feature**: Interactions Tab
**Phase**: LLD (Low-Level Design + Implementation Plan)
**Date Started**: 2026-04-02
**Date Completed**: _In Progress_
**Status**: In Progress

---

## Phase Summary

Generating Low-Level Design and implementation plan for Interactions Tab. This is a **hybrid LLD**:

- **Retroactive**: Documents existing implementation (7 phases completed, 27 components built)
- **Forward-looking**: Plans test implementation work (integration + E2E tests missing)

**Goal**: Enable BETA promotion by implementing minimum test coverage (3 integration + 3 E2E tests).

---

## Clarifying Questions & Decisions

### Implementation Strategy (5 questions)

1. **Since the feature is already implemented, what's the implementation order for the MISSING tests?**
   - **Classification**: INFERRED
   - **Answer**: Integration tests first, then E2E tests. Integration tests have lower complexity (no Playwright setup, no test DB seeding, just unit-test-like fixtures with correct schema).
   - **Evidence**: Test-spec log lines 155-180 document integration test blockers as "schema mismatch" (fixable), E2E test blockers as "infrastructure not set up" (larger effort)

2. **Should integration tests be added to existing test files or new files?**
   - **Classification**: DECIDED
   - **Answer**: New files. Create `apps/studio/src/__tests__/interactions-integration.test.ts` for integration tests. Keep unit tests separate (different test scope).
   - **Rationale**: Integration tests test service boundaries (ObservatoryStore integration, event processing with realistic fixtures), not isolated units

3. **Should E2E tests use Playwright or another framework?**
   - **Classification**: ANSWERED
   - **Answer**: Playwright (mentioned in test spec). Not set up yet — needs config, test env, browser automation.
   - **Evidence**: Test-spec log line 183: "Playwright not set up in Studio yet"

4. **What's the acceptable scope for test implementation phase 1?**
   - **Classification**: INFERRED
   - **Answer**: Minimum 3 integration + 3 E2E for BETA promotion. Prioritize INT-1, INT-2, INT-6 and E2E-1, SEC-1, SEC-2 (per test-spec log recommendations).
   - **Evidence**: Test-spec log lines 130-180 "Path to BETA" section

5. **Is there a hard deadline for BETA promotion?**
   - **Classification**: INFERRED
   - **Answer**: No hard deadline mentioned. Feature is internal tooling. Can phase test implementation incrementally.
   - **Evidence**: Feature spec §1 "internal tooling for agent developers", no timeline driver in feature-spec log

### Technical Details (5 questions)

1. **Which specific integration test scenarios should be prioritized?**
   - **Classification**: ANSWERED
   - **Answer**: INT-1 (event grouping), INT-2 (token totals), INT-6 (agent path construction) — recommended in test-spec log as P0 scenarios.
   - **Evidence**: Test-spec log lines 136-150

2. **Which specific E2E test scenarios should be prioritized?**
   - **Classification**: ANSWERED
   - **Answer**: E2E-1 (load session), SEC-1 (cross-tenant isolation), SEC-2 (cross-project isolation) — recommended in test-spec log.
   - **Evidence**: Test-spec log lines 165-178

3. **For integration tests, what test fixtures are needed?**
   - **Classification**: ANSWERED
   - **Answer**: Realistic trace event schemas with tokens in `data.usage.inputTokens` (NOT `metadata.inputTokens`). Need to match actual Runtime emission structure.
   - **Evidence**: Test-spec log lines 45-50 documents schema mismatch from attempted integration test; event-processor.ts lines 216-221 show actual token extraction logic

4. **For E2E tests, what infrastructure is needed?**
   - **Classification**: ANSWERED
   - **Answer**: Playwright config, test database seeding scripts, WebSocket test harness (or mock WebSocket server), authentication flow for test users (tenant/project/user context).
   - **Evidence**: Test-spec log lines 70-75 "Infrastructure Required"

5. **What's the testing strategy?**
   - **Classification**: DECIDED
   - **Answer**: Test-after approach. Feature already works in production. Tests document existing behavior and prevent regressions. Not TDD (tests don't drive implementation).
   - **Rationale**: Retroactive testing for already-implemented feature

### Risk & Dependencies (5 questions)

1. **What's the biggest implementation risk for test writing?**
   - **Classification**: ANSWERED
   - **Answer**: Schema mismatches. Trace event structure in tests must match Runtime emission. Previous attempt failed with 6/13 tests due to incorrect fixture structure.
   - **Evidence**: Test-spec log lines 45-60 documents failed attempt

2. **Are there other ongoing changes that could conflict?**
   - **Classification**: INFERRED
   - **Answer**: No evidence of conflicting changes. Interactions tab is stable (no active development). Trace event schema is extensible (backward compatible).
   - **Evidence**: No conflicting branches or PRs mentioned in logs

3. **What team dependencies exist?**
   - **Classification**: INFERRED
   - **Answer**: No explicit team dependencies. Internal tooling, no QA sign-off needed. Code review via pr-reviewer agent (5 rounds).
   - **Evidence**: SDLC pipeline uses automated pr-reviewer agent, not human reviewers

4. **What monitoring/alerting needs to be in place before BETA?**
   - **Classification**: INFERRED
   - **Answer**: None. BETA criteria focus on test coverage, not monitoring. Interactions tab is client-side, errors caught by browser error boundary.
   - **Evidence**: AUTHORING_GUIDE.md BETA criteria list tests + PR review, not monitoring

5. **What's the definition of done for BETA promotion?**
   - **Classification**: ANSWERED
   - **Answer**: (1) Minimum 3 integration tests passing, (2) Minimum 3 E2E tests passing, (3) GAP-001 resolved, (4) 5 PR review rounds, (5) No regressions in existing tests, (6) Docs updated.
   - **Evidence**: AUTHORING_GUIDE.md BETA criteria (from test-spec log lines 105-115), test-spec log "Path to BETA"

---

## Oracle Decisions

Product-oracle agent spawn failed due to model configuration (same as feature-spec and HLD phases). All clarifying questions answered manually based on docs/code analysis.

**Classification Summary**:

- ANSWERED: 9 questions (explicit evidence in docs/logs)
- INFERRED: 5 questions (reasoned from patterns/context)
- DECIDED: 2 questions (judgment calls with rationale)
- AMBIGUOUS: 0 questions

No AMBIGUOUS items requiring user escalation. Proceeding with LLD generation.

---

## Files To Create

1. `docs/plans/2026-04-02-interactions-tab-impl-plan.md` — LLD + Implementation Plan

---

## Audit Rounds

**Round 1**: APPROVED with minor recommendations

- Verdict: APPROVED
- Findings: 2 MEDIUM (test data cleanup, integration test boundary clarity), 3 LOW (phase numbering, fixture validation, flakiness mitigation)
- All findings addressed:
  - MEDIUM-1: Added test data cleanup to Phase 3 exit criteria (clearTestData() + KEEP_TEST_DATA flag)
  - MEDIUM-2: Clarified integration test boundary (logic-level, not API/DB/WebSocket)
  - LOW-1: Added note about Phase 0 numbering (retroactive vs forward-looking)
  - LOW-2: Made fixture validation task 1.3 concrete (unit test file with assertions)
  - LOW-3: Added anti-flakiness strategies to Playwright config (networkidle, screenshot, trace)
- Full report: `docs/sdlc-logs/interactions-tab/lld-audit-round-1.md`

**Round 2**: APPROVED with recommendations to align with existing patterns

- Verdict: APPROVED
- Findings: 2 HIGH (reuse auth helpers, reuse Playwright config), 2 MEDIUM (integration test DB strategy, E2E test DB note), 1 LOW (exit criteria checkboxes)
- All HIGH findings addressed:
  - HIGH-1: Updated Phase 3 Task 3.3 to reuse existing `e2e/helpers/auth.ts` (loginViaDevApi, getDevAccessToken)
  - HIGH-2: Updated Phase 3 Task 3.1 to verify (not create) existing Playwright config
  - MEDIUM-1: Clarified integration tests use in-memory fixtures only (no DB)
  - MEDIUM-2: Added note that E2E tests use real MongoDB (intentionally different from MongoMemoryServer)
  - LOW-1: Updated exit criteria to mark Playwright/config as "already done"
- Full report: `docs/sdlc-logs/interactions-tab/lld-audit-round-2.md`

**Round 3**: APPROVED with minor file list corrections

- Verdict: APPROVED
- Findings: 2 LOW (file-level change map incomplete, package.json modification clarification)
- All LOW findings addressed:
  - LOW-1: Added 3 missing files to §2 "New Files" (test-utils.ts, trace-events.test.ts, smoke.spec.ts), removed 2 existing files (playwright.config.ts, auth.ts)
  - LOW-2: Removed package.json from "Modified Files" table, added note that Playwright already exists
- Quality Score: 9.5/10
- Full report: `docs/sdlc-logs/interactions-tab/lld-audit-round-3.md`

**Round 4**: APPROVED with minor test spec alignment note

- Verdict: APPROVED
- Findings: 1 MEDIUM (INT-6 not in test spec)
- MEDIUM-1 finding: LLD implements INT-6 (Agent Path Construction) which is not in test spec - should be added to test spec during Phase 5 Task 5.2 doc updates
- HLD alignment: Perfect (D-1 chooses HLD Option B correctly)
- GAP-001 resolution: Correct (Phase 5 Task 5.1 marks as resolved)
- BETA criteria: 100% alignment with AUTHORING_GUIDE.md
- Quality Score: 9.5/10
- Full report: `docs/sdlc-logs/interactions-tab/lld-audit-round-4.md`

**Round 5**: APPROVED — READY FOR IMPLEMENTATION

- Verdict: APPROVED
- Findings: 0 BLOCKING
- All 5 rounds complete: 2 HIGH (addressed), 5 MEDIUM (4 addressed, 1 deferred to Phase 5), 6 LOW (addressed)
- Task independence verified: All dependencies are correct, no unnecessary blocking
- Wiring checklist verified: All new components wired into callers
- Domain rules verified: All platform principles honored (isolation 404, real auth, test integrity)
- Exit criteria verified: All criteria concrete and measurable
- Quality Score: 9.5/10
- Full report: `docs/sdlc-logs/interactions-tab/lld-audit-round-5.md`
- **Status: READY FOR IMPLEMENTATION**

---

## Next Steps

1. Generate LLD with implementation phases:
   - Phase 0: Existing Implementation (retroactive documentation)
   - Phase 1: Test Infrastructure & Fixtures
   - Phase 2: Integration Tests (INT-1, INT-2, INT-6)
   - Phase 3: E2E Test Infrastructure (Playwright, test DB, auth)
   - Phase 4: E2E Tests (E2E-1, SEC-1, SEC-2)
   - Phase 5: BETA Promotion (resolve GAP-001, PR review, status update)
2. Spawn lld-reviewer for Rounds 1-3, 5
3. Spawn phase-auditor for Round 4
4. Fix CRITICAL/HIGH findings each round
5. Commit LLD and logs
6. User runs `/implement interactions-tab` next
