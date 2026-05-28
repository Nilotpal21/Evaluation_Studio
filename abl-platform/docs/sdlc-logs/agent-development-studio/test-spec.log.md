# SDLC Log: agent-development-studio -- Test Spec (Phase 2)

**Date**: 2026-03-22
**Phase**: Test Spec
**Status**: Complete

## Clarifying Questions & Decisions

| #   | Question                                            | Classification | Answer                                                                                                                                                                                                                     |
| --- | --------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | What is the existing test coverage baseline?        | ANSWERED       | 100+ unit/integration tests across `apps/studio/src/__tests__/`, 6 E2E specs in `apps/studio/e2e/`, plus `packages/project-io` and `apps/runtime` coverage. See test file mapping.                                         |
| 2   | Which FRs are highest risk?                         | DECIDED        | FR-2 (surgical editing round-trip), FR-7 (git sync with conflicts), FR-9 (permission gating). Editing is high-frequency and mutation-sensitive; git sync has external dependencies; permission gaps are security-critical. |
| 3   | What E2E infrastructure is available?               | ANSWERED       | Playwright for browser E2E (`apps/studio/e2e/`), API-level E2E via direct HTTP against real servers. MongoMemoryServer for integration tests.                                                                              |
| 4   | Should topology be tested visually or structurally? | DECIDED        | Both -- component unit tests for layout algorithm correctness, visual regression screenshots for rendering fidelity. Left as open question for team input.                                                                 |
| 5   | What external dependencies need mocking?            | DECIDED        | Git providers should be mocked for integration tests (no real GitHub API calls in CI). MCP servers need a test fixture (mock server or recorded responses).                                                                |

## Files Created

- `docs/testing/agent-development-studio.md` -- Full test spec with 7 E2E scenarios, 7 integration scenarios
- `docs/sdlc-logs/agent-development-studio/test-spec.log.md` -- This log

## Review Summary

### Round 1 -- Coverage & Completeness

- [x] 7 E2E test scenarios (exceeds minimum 5)
- [x] 7 integration test scenarios (exceeds minimum 5)
- [x] Every FR from feature spec appears in coverage matrix (FR-1 through FR-14)
- [x] E2E scenarios specify auth context
- [x] E2E scenarios do NOT reference mocks or direct DB access
- [x] Integration scenarios specify service boundaries
- [x] Security & isolation section filled
- [x] Test file mapping has actual paths

### Round 2 -- Alignment

- [x] Scenarios cover highest-risk FRs (FR-2, FR-7, FR-9)
- [x] E2E scenarios match user stories from feature spec
- [x] Integration boundaries match data flow from feature spec
