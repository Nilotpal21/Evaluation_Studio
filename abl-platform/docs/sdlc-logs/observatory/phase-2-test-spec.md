# Observatory — Phase 2: Test Spec Log

**Date:** 2026-03-23
**Phase:** Test Spec
**Status:** COMPLETE

## Clarifying Questions & Decisions

| #   | Question                                                    | Classification | Resolution                                                                                                                                                 |
| --- | ----------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Should existing E2E tests that mock DB models be rewritten? | DECIDED        | NO — existing 28 tests provide value. New tests MUST use real middleware. Document gap in test spec.                                                       |
| 2   | How to handle ClickHouse in CI (no ClickHouse available)?   | INFERRED       | Use ClickHouse mock server or skip CH-dependent tests in CI (mark as `excluded from vitest.fast.config.ts`). Real CH tests run in integration environment. |
| 3   | What is the minimum E2E test count?                         | ANSWERED       | 20 E2E scenarios defined (E2E-1 through E2E-20), meeting the >= 15 requirement from feature spec.                                                          |
| 4   | What is the minimum integration test count?                 | ANSWERED       | 10 integration scenarios defined (INT-1 through INT-10), meeting the >= 5 requirement.                                                                     |
| 5   | Should UI E2E tests use browser automation?                 | DECIDED        | NO — UI integration tests use React Testing Library + Vitest. True UI E2E is separate workstream.                                                          |

## Audit Findings

### Round 1 (Self-Audit)

- CRITICAL: None
- HIGH: Must explicitly note that existing observatory-api-e2e.test.ts mocks DB models, violating E2E standards
- MEDIUM: Test data setup instructions should be more specific about seed data structure

### Resolution

- Section 3.2 explicitly documents existing test gaps including DB model mocking
- Section 2.2 provides TypeScript-style pseudocode for test data seeding via API

## Artifacts

- `docs/testing/observatory.md` — Test specification with coverage matrix

## Cross-References

- Feature spec: `docs/features/observatory.md` — FR-1 through FR-15, NFR-1 through NFR-8
- Existing tests: `apps/runtime/src/__tests__/e2e/observatory-api-e2e.test.ts` — 28 tests
- Existing tests: `apps/studio/src/store/__tests__/observatory-span-lifecycle.test.ts`
