# SDLC Log: Agent Testing & Evals — Test Spec

**Phase:** Test Spec (Phase 2)
**Date:** 2026-03-22
**Status:** Completed

## Inputs Read

1. Feature Spec: `docs/features/agent-testing-evals.md` (Phase 1 output)
2. Existing tests: `eval-preflight.test.ts`, `eval-circuit-breaker-errors.test.ts`
3. Service interfaces: All 15 eval service files for determining testable boundaries
4. Studio API routes: 22 route files for E2E endpoint coverage
5. Database models: 6 Mongoose models for integration test seeding

## Test Inventory

| Category    | Scenarios                              | Status          |
| ----------- | -------------------------------------- | --------------- |
| E2E         | 8                                      | Spec'd          |
| Integration | 8                                      | Spec'd          |
| Unit        | 15+ functions                          | Spec'd          |
| Existing    | 2 files (preflight + circuit breakers) | Already passing |

## Key Design Decisions

1. **E2E tests use code_scorer evaluators** to avoid LLM cost in CI. LLM judge tests are integration-only with mock LLM client.
2. **Trajectory scorers are pure functions** and get dedicated unit tests without infrastructure.
3. **ClickHouse integration tests** require Docker but are separate from E2E (no full server startup).
4. **Restate workflow tests** are integration-level — they test the workflow logic with real MongoDB but mock Restate context.
5. **Test fixtures** use minimal data to keep tests fast and deterministic.

## Coverage Gaps Identified

- Studio eval React components: No components exist yet, so no UI tests
- Production eval scoring pipeline: Not implemented, so no tests
- Human review UI flow: Not implemented, so no tests
- CI trigger mechanism: Not implemented, so no tests
