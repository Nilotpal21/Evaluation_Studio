# Session Compaction -- Test Spec Log

**Phase**: 2 (Test Spec)
**Date**: 2026-03-22
**Status**: Complete

## Clarifying Questions & Decisions

### Test Scope & Priorities

| Question                                    | Classification | Answer                                                                                                                                                                                                               |
| ------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which FRs are highest risk?                 | DECIDED        | FR-6 (LLM abstractive summary) is untested; FR-2 (auto-compact trigger) and FR-4 (history split) are critical path. Integration with reasoning executor (line 575) is the highest-risk gap.                          |
| What is the current test coverage baseline? | ANSWERED       | 4 test files, ~22 test cases, all unit-level. Zero integration/E2E. Code evidence: `compaction-engine.test.ts`, `compaction-policy.test.ts`, `tool-result-compressor.test.ts`, `cross-turn-tool-truncation.test.ts`. |
| What external dependencies need mocking?    | DECIDED        | LLM client is the only external dependency. For unit tests: mock via DI (inject mock `llmClient` on session/thread). For E2E: use real LLM or deterministic mock HTTP server. No vi.mock() of codebase components.   |

### E2E Scenarios

| Question                             | Classification | Answer                                                                                                                                                                               |
| ------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| What are the critical user journeys? | DECIDED        | Long conversation -> auto-compaction -> continued coherence. Tool-heavy conversation -> compaction preserves tool context. Disabled-by-default -> no compaction when opt-in not set. |
| What auth/permission combinations?   | INFERRED       | Standard tenant + project + user context from existing session auth patterns. Cross-tenant isolation via 404.                                                                        |
| Data seeding strategy?               | DECIDED        | Create agents via POST API, send messages via WebSocket. No direct DB seeding.                                                                                                       |

### Integration Boundaries

| Question                  | Classification | Answer                                                                                                                                                           |
| ------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which service boundaries? | ANSWERED       | CompactionEngine <-> ReasoningExecutor, CompactionPolicy <-> RuntimeSession, ToolResultCompressor <-> CompactionPolicy, CompactionEngine <-> TieredSessionStore. |
| Concurrency scenarios?    | INFERRED       | Execution lock prevents concurrent compaction on same session. Not explicitly tested but protected by existing lock mechanism at `SessionService.acquireLock()`. |

## Files Created

- `docs/testing/session-compaction.md` -- Full test spec with 6 E2E + 6 integration scenarios
- `docs/sdlc-logs/session-compaction/test-spec.log.md` -- This log

## Review Findings

### Round 1 -- Coverage & Completeness

- 6 E2E test scenarios (exceeds minimum 5)
- 6 integration test scenarios (exceeds minimum 5)
- All 12 FRs mapped in coverage matrix
- E2E scenarios specify auth context (tenantId, projectId, userId)
- E2E scenarios do NOT reference mocks or direct DB access
- Integration scenarios specify service boundaries
- Security & isolation section filled with 6 specific checks
- Test file mapping with actual and planned paths

### Round 2 -- Alignment

- E2E scenarios cover highest-risk FRs: FR-2 (trigger), FR-4 (split), FR-6 (LLM summary), FR-12 (disabled default)
- E2E scenarios match user stories: long conversation (US-1), operator control (US-2), per-agent config (US-3)
- Integration boundaries match data flow from feature spec
