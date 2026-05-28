# SDLC Log: Agent Testing & Evals — LLD

**Phase:** Low-Level Design (Phase 4)
**Date:** 2026-03-22
**Status:** Completed

## Inputs Read

1. Feature Spec: `docs/features/agent-testing-evals.md`
2. Test Spec: `docs/testing/agent-testing-evals.md`
3. HLD: `docs/specs/agent-testing-evals.hld.md`
4. All eval source code for precise function signatures and test case derivation

## Implementation Phases Defined

| Phase | Name                                   | Files                           | Dependencies              |
| ----- | -------------------------------------- | ------------------------------- | ------------------------- |
| 1     | Unit Tests (Pure Functions)            | 3 new test files                | None                      |
| 2     | Integration Tests (Service Boundaries) | 2 new test files                | None                      |
| 3     | Studio UI Components                   | 9 new component/page files      | Existing hooks/store/repo |
| 4     | E2E Tests                              | 3 new E2E test files            | Phase 3                   |
| 5     | Production Hardening                   | Pagination, CI, cost estimation | Phases 3+4                |

## Key Design Decisions

1. **Phases 1 and 2 are independent** — can run in parallel, no infrastructure overlap.
2. **Phase 3 uses existing plumbing** — hooks, store, and repo are already implemented; only UI components are missing.
3. **Phase 4 focuses on API-level testing** — avoids needing Restate in test environment by testing CRUD/API layer.
4. **Phase 5 is deferred** — production hardening items are P1 and can be planned separately.

## Test Case Count

| Phase                 | Test Cases                                             |
| --------------------- | ------------------------------------------------------ |
| Phase 1 (Unit)        | ~40+ (trajectory: 20+, aggregation: 12+, prompts: 10+) |
| Phase 2 (Integration) | ~15 (code scorers: 9+, rate limiter: 6+)               |
| Phase 4 (E2E)         | ~20 (CRUD: 10+, templates: 5+, preflight: 5+)          |
| **Total new**         | **~75 test cases**                                     |

## Wiring Gaps Identified

8 wiring points documented — the most critical being Studio navigation wiring (W1) and page route registration (W2) needed for Phase 3.
