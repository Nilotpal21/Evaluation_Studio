# SDLC Log: ROI Tracking -- Phase 2: Test Spec

**Date**: 2026-03-23
**Phase**: Test Spec
**Artifact**: `docs/testing/roi-tracking.md`

## Decisions Log

| ID  | Question                                    | Classification | Decision                                                                                                                      |
| --- | ------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| D1  | How to handle ClickHouse in E2E tests?      | DECIDED        | ClickHouse is external infrastructure -- allowed to inject test adapter via DI. Not a codebase component mock.                |
| D2  | Should UI E2E tests use browser automation? | DECIDED        | Basic rendering tests can use component-level rendering (jsdom). Full interaction tests deferred to browser automation phase. |
| D3  | How many isolation tests needed?            | DECIDED        | 5 isolation tests covering: cross-tenant read, cross-project read, cross-project write, unauthenticated, unauthorized         |
| D4  | Should existing ROICalculator tests count?  | DECIDED        | Yes -- 7 existing tests in `roi-calculator.test.ts` count as unit coverage. Add 3 more edge cases.                            |
| D5  | Redis cache testing approach?               | DECIDED        | Integration tests with real Redis instance. Verify cache key creation, TTL, and invalidation.                                 |

## Coverage Summary

- **30 E2E tests** across 9 test suites
- **13 integration tests** across 5 test suites
- **16 unit tests** across 8 test suites (plus 7 existing)
- **Total: 59 new tests + 7 existing = 66 tests**
- All E2E tests use real HTTP API, full middleware chain, no codebase mocks
- Test infrastructure leverages existing patterns from `variable-namespaces-tool-auto-tagging` test spec

## Audit Round 1

- Verified E2E tests do NOT mock codebase components
- Verified all scenarios interact via HTTP API
- Verified tenant/project isolation tests return 404 (not 403) per platform invariants
- Verified test infrastructure requirements align with existing test patterns
