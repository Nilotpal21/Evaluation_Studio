# LLD Log: A2A Integration

**Date**: 2026-03-22
**Phase**: 4 - LLD
**Feature**: a2a-integration

## Clarifying Questions & Decision Protocol

### Implementation Strategy

| Question                     | Classification | Answer                                                                                                           |
| ---------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------- |
| Implementation order?        | DECIDED        | Test-first (Phases 1-3 add tests for existing gaps), then refactor (Phase 4), then verify (Phase 5)              |
| Existing patterns to follow? | ANSWERED       | Existing test files in `packages/a2a/src/__tests__/` use vitest with mock Redis clients and mock execution ports |
| Feature flags needed?        | DECIDED        | No -- test-only phases have no production impact; Phase 4 refactoring is an in-place replacement                 |
| Phase 1 scope?               | DECIDED        | Cross-tenant isolation tests only -- highest severity gap, establishes test pattern for remaining phases         |

### Technical Details

| Question                    | Classification | Answer                                                                                                                        |
| --------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Files needing modification? | ANSWERED       | Only `authenticated-client-factory.ts` and `client-factory.ts` for production code (Phase 4). All other phases are test-only. |
| Test infrastructure?        | ANSWERED       | Existing tests use mock Redis clients (`packages/a2a/src/__tests__/redis-task-store.test.ts`). Same pattern for new tests.    |
| Type definitions to change? | DECIDED        | `createA2AClientWithAuth` return type unchanged. Only internal implementation changes.                                        |

### Risk & Dependencies

| Question                     | Classification | Answer                                                                                                                  |
| ---------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Biggest implementation risk? | DECIDED        | Phase 4 (authenticated client refactoring) -- could break outbound A2A calls if SDK client doesn't support custom fetch |
| Conflicting changes?         | ANSWERED       | No other active PRs touching `packages/a2a/` infrastructure                                                             |
| Definition of done?          | DECIDED        | All 5 phases complete, all acceptance criteria met, feature spec updated with closed gaps                               |

## Files Created

- `docs/plans/2026-03-22-a2a-integration-impl-plan.md` -- 5 phases, file-level change map, wiring checklist, acceptance criteria

## Review Summary

### Round 1 -- Architecture Compliance

- All phases use platform patterns (tenant isolation at query level, SSRF validation, structured tracing)
- No new patterns introduced that conflict with platform conventions
- Test phases respect E2E test standards (no mocks in E2E, real Express routers in integration)

### Round 2 -- Pattern Consistency

- New test files follow existing patterns in `packages/a2a/src/__tests__/` (vitest, mock Redis, mock execution ports)
- Phase 4 refactoring follows existing client-factory pattern with DI
- Exit criteria use measurable conditions (pnpm test passes, pnpm build succeeds, specific test count)

### Round 3 -- Completeness

- Every FR from feature spec is covered by at least one implementation phase
- File paths verified against actual filesystem
- No missing dependencies or imports

### Round 4 -- Cross-Phase Consistency

- LLD phases map to HLD migration path (GAP-001, GAP-002, GAP-003, GAP-010)
- Test strategy per phase aligns with test spec scenarios (INT-1 through INT-7, E2E-1 through E2E-7)
- Wiring checklist verified against existing exports and imports

### Round 5 -- Final Sweep

- Each phase is independently deployable (Phases 1-3 are test-only, Phase 4 is backward-compatible, Phase 5 is doc-only)
- Every task is completable in one session
- Rollback strategy defined per phase
- No TODO stubs -- all deferred items are logged in Open Questions section
