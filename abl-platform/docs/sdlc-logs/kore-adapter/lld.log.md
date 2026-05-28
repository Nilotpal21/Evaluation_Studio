# SDLC Log: Kore Adapter — LLD Phase

**Date**: 2026-03-30
**Phase**: LLD (Phase 4 of SDLC pipeline)
**Skill**: `/lld kore-adapter`

---

## Oracle Decisions

All 15 clarifying questions answered by product-oracle. Zero AMBIGUOUS — no user escalation.

### Key Decisions

| #   | Decision                                                                      | Classification |
| --- | ----------------------------------------------------------------------------- | -------------- |
| D-1 | Test infrastructure first, code changes last (~5 lines GAP-008 fix)           | DECIDED        |
| D-2 | E2E tests in apps/runtime/ (Express not available in packages/agent-transfer) | ANSWERED       |
| D-3 | Integration tests in packages/agent-transfer/ with DI-injected mocks          | ANSWERED       |
| D-4 | SmartAssist mocked only via DI constructor injection, never vi.mock()         | ANSWERED       |
| D-5 | GAP-008 config snapshot in execute() per HLD Option A                         | DECIDED        |

## Files Created/Modified

| File                                              | Action  | Purpose                              |
| ------------------------------------------------- | ------- | ------------------------------------ |
| `docs/plans/2026-03-30-kore-adapter-impl-plan.md` | Created | Full LLD with 5 phases, 11 decisions |
| `docs/sdlc-logs/kore-adapter/lld.log.md`          | Created | This log file                        |

## Audit Rounds

### Round 1: NEEDS_CHANGES (2 CRITICAL, 3 HIGH, 5 MEDIUM, 1 LOW)

- CRITICAL: SmartAssistClient has 9 methods (not 8) — `close()` was missed
- CRITICAL: Would have created new parallel `mock-smartassist-client.ts` — existing `mock-smartassist.ts` has 6 of 9 methods
- HIGH: INT-5 needs Express, must live in apps/runtime/ (D-9)
- HIGH: INT-1 spied on private methods — use Pool.request call count instead (D-11)
- HIGH: E2E-4 auth strategy unresolved — added D-10 based on existing test patterns

**Fixes applied:**

- Added D-8 through D-11 decisions
- Fixed 9 methods, extended existing mock-smartassist.ts
- Moved INT-5 to apps/runtime/
- Added GAP-008 scope limitation note (sendUserMessage/endSession unprotected)
- Added file assignments for INT-1, INT-2, INT-7
- Renamed test tier from "Unit" to "No-Redis"
- Moved uncommitted changes to Phase 0 prerequisite
- Added FR-13 representative coverage note

### Round 2: NEEDS_CHANGES (0 CRITICAL, 3 HIGH, 4 MEDIUM, 2 LOW)

- HIGH: TransferSessionStoreHandle create() missing agentId param
- HIGH: In-memory session store duplicated 3x — extract from Five9 pattern
- HIGH: Redis test helper reinvention — use existing redis-server-harness DB-level isolation
- MEDIUM: E2E naming (.e2e.test.ts), harness naming (\*-harness.ts), INT-7 location, vi.mock() debt

**Fixes applied:**

- Added agentId to create() params
- mock-session-store extracted from Five9 test pattern, Five9 will import shared helper
- test-redis uses DB-level isolation, E2E tests use existing redis-server-harness
- Fixed naming conventions, resolved INT-7 to apps/runtime/, noted vi.mock() debt

### Round 3: NEEDS_CHANGES (1 CRITICAL, 2 HIGH, 3 MEDIUM, 1 LOW)

- CRITICAL: `kore-transfer-flow.test.ts` already exists (134 lines, 5 tests) — would overwrite
- HIGH: Wiring checklist referenced wrong mock filename
- HIGH: Test tier table put INT-5/6/7 in wrong tier (they're in apps/runtime/)
- MEDIUM: GAP-008 guard change, extendTTL concrete signature, LOC estimate

**Fixes applied:**

- Renamed INT-1 file to `kore-smartassist-retry.test.ts`
- Fixed wiring checklist filename to mock-smartassist.ts
- Split test tier table into 4 tiers: No-Redis, Runtime-Int, Redis, E2E
- Added guard change note, extendTTL signature note, increased LOC estimate

### Round 4: APPROVED (0 CRITICAL, 3 HIGH — all upstream test spec residuals)

- 3 HIGH findings are test spec file path divergences — to fix in post-impl-sync
- Full cross-phase alignment verified: HLD → LLD, Test Spec → LLD, Feature Spec → LLD

### Round 5: APPROVED (0 CRITICAL, 0 HIGH, 2 MEDIUM, 1 LOW)

- MEDIUM: INT-4 in wrong tier (needs Redis) — moved to Redis tier
- MEDIUM: Open Questions 1 and 2 were already resolved — marked as RESOLVED
- LOW: Open Question 2 already answered by task text

**Fixes applied:**

- Moved INT-4 to Redis tier
- Resolved OQ-1 (E2E auth follows runtime-api-harness.ts JWT pattern)
- Resolved OQ-2 (INT-5 uses in-memory store per task 2.5)

## Final LLD Structure

- 5 implementation phases: test infrastructure → integration tests (13) → GAP-008 fix → E2E tests (7) → unit gap closure + doc sync
- 11 design decisions (D-1 through D-11)
- 4 test execution tiers: No-Redis, Runtime-Int, Redis, E2E
- Phase 0 prerequisite: commit 22 modified source files
- FR→Task traceability matrix covering all 22 FRs
- ~17 new test files, 3 modified files
- ~650 LOC E2E, ~1500 LOC integration, ~300 LOC helpers

## Next Phase

Run `/implement kore-adapter` to execute the implementation plan phase-by-phase.
