# NLU Test Spec — SDLC Log

**Phase**: 2 — Test Spec
**Date**: 2026-03-22
**Status**: Complete

## Clarifying Questions & Decisions

| #   | Question                                                     | Classification | Answer                                                                                                                                                                     |
| --- | ------------------------------------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | What is the current test coverage baseline?                  | ANSWERED       | 35+ unit test files, 3 integration test files, 0 E2E test files. All unit/integration tests PASS.                                                                          |
| 2   | What external dependencies need mocking vs real integration? | DECIDED        | For E2E: NLU sidecar should use a minimal HTTP test double (not Docker container) for speed. Classifier LLM should be the real pipeline model for E2E but mocked for unit. |
| 3   | What auth/permission combinations need E2E coverage?         | INFERRED       | Based on platform patterns: tenant isolation (cross-tenant 404), Enterprise plan gating (403), and RBAC permissions.                                                       |
| 4   | Are there known edge cases from production?                  | DECIDED        | No production data available. Key edge cases from code: malformed classifier JSON, sidecar timeout, circuit breaker state transitions, intent queue overflow.              |
| 5   | What data seeding is required?                               | ANSWERED       | Tenant records with plan tiers, project records, agent IR with pipeline config, project runtime config documents. All seeded via API.                                      |

## Files Created/Modified

- `docs/testing/nlu.md` — Full re-generation with code-grounded E2E + integration scenarios
- `docs/sdlc-logs/nlu/test-spec.log.md` — This log file

## Key Improvements from Previous Spec

1. **Added 7 E2E scenarios**: Single-intent routing, multi-intent fan-out, sidecar extraction, classifier fallback, keyword veto, circuit breaker, tenant isolation.
2. **Added 7 integration scenarios**: Config cascade, sidecar CB lifecycle, strategy resolution, queue serialization, tenant CB isolation, plan gating, nl-parser Zod validation.
3. **Added coverage matrix**: All 12 FRs mapped to test types.
4. **Added test file mapping**: Each test file mapped to FRs it covers.
5. **Corrected health dashboard**: Added pipeline orchestrator, config, circuit breaker, tool filter, post-extraction modules.
6. **Added test infrastructure section**: Services, seeding, env vars needed.

## Review Findings

### Round 1 — Coverage & Completeness

- [x] 7 E2E test scenarios (exceeds minimum 5)
- [x] 7 integration test scenarios (exceeds minimum 5)
- [x] Every FR from feature spec appears in coverage matrix
- [x] E2E scenarios specify auth context
- [x] E2E scenarios do NOT reference mocks or direct DB access
- [x] Integration scenarios specify service boundaries
- [x] Security & isolation section filled
- [x] Test file mapping has actual paths

### Round 2 — Alignment

- [x] Scenarios cover highest-risk FRs (pipeline routing, sidecar CB, tenant isolation)
- [x] E2E scenarios match user stories from feature spec
- [x] Integration boundaries match data flow from feature spec
