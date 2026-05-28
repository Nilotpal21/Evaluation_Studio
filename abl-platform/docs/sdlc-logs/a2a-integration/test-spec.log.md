# Test Spec Log: A2A Integration

**Date**: 2026-03-22
**Phase**: 2 - Test Spec
**Feature**: a2a-integration

## Clarifying Questions & Decision Protocol

### Test Scope & Priorities

| Question                             | Classification | Answer                                                                                                            |
| ------------------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------- |
| Which FRs are highest risk?          | DECIDED        | FR-3 (outbound cancel not E2E tested), FR-4 (restart persistence untested), FR-9 (push notification E2E untested) |
| What is current test coverage?       | ANSWERED       | 13 unit test files in `packages/a2a/src/__tests__/`, 35 E2E tests passing (documented in existing test doc)       |
| External dependencies needing mocks? | DECIDED        | LLM backends (real in E2E), Redis (real or in-memory), A2A SDK client (mockable via dependency injection)         |

### E2E Scenarios

| Question                        | Classification | Answer                                                                                                |
| ------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------- |
| Critical user journeys?         | ANSWERED       | Agent card discovery -> message lifecycle -> multi-turn -> auth. All covered in existing 35 E2E tests |
| Auth/permission combos for E2E? | ANSWERED       | Per-connection Bearer auth (set/unset/wrong token), project-scoped connection CRUD                    |
| Cross-feature interactions?     | INFERRED       | A2A -> RoutingExecutor (outbound), Channels (connection CRUD), Session Management (contextId mapping) |

### Integration Boundaries

| Question                    | Classification | Answer                                                                             |
| --------------------------- | -------------- | ---------------------------------------------------------------------------------- |
| Webhook/event-driven flows? | ANSWERED       | Push notification callbacks (`/a2a/callbacks/:callbackId`), BullMQ resume queue    |
| Race conditions?            | ANSWERED       | Session atomicity on concurrent first-turns -- already tested with SET NX          |
| Error/failure paths?        | DECIDED        | Queue failure -> callback re-registration, SSRF rejection, JSON-RPC error wrapping |

## Files Created

- `docs/testing/a2a-integration.md` -- 7 E2E scenarios, 7 integration scenarios, 4 unit scenarios, coverage matrix for all 10 FRs

## Review Summary

### Round 1 -- Coverage & Completeness

- 7 E2E test scenarios (minimum 5 required)
- 7 integration test scenarios (minimum 5 required)
- All 10 FRs from feature spec appear in coverage matrix
- E2E scenarios specify auth context and isolation checks
- E2E scenarios do NOT reference mocks or direct DB access
- Integration scenarios specify service boundaries and failure modes
- Security & isolation section filled with specific checks

### Round 2 -- Alignment

- E2E-1 through E2E-5 cover the 5 highest-risk FRs
- E2E scenarios match user stories from feature spec (US-1: discovery, US-2: outbound, US-3: tracing, US-4: async, US-5: auth)
- Integration boundaries match the hexagonal architecture from feature spec
