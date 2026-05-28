# SDLC Log: Tracing & Observability -- Test Spec

**Phase:** Test Spec (Phase 2)
**Date:** 2026-03-22
**Status:** Complete

## Process

### Inputs

- Feature spec: `docs/features/tracing-observability.md`
- Existing E2E tests: `apps/runtime/src/__tests__/e2e/observatory-api-e2e.test.ts` (28 tests)
- Existing unit tests: trace-store, session-hooks, observatory-span-lifecycle, trace-events-attachments

### Test Design Decisions

| ID  | Decision                                                                                   | Classification |
| --- | ------------------------------------------------------------------------------------------ | -------------- |
| T1  | 8 E2E scenarios covering the full REST API + WebSocket pipeline                            | DECIDED        |
| T2  | 10 integration scenarios for service boundaries (TraceStore, Redis, OTEL, EventStore)      | DECIDED        |
| T3  | 5 unit scenarios for schema utilities and protocol parsing                                 | DECIDED        |
| T4  | No mocking of codebase components in E2E tests -- real Express server with full middleware | DECIDED        |
| T5  | Redis integration tests require real Redis (or testcontainers)                             | DECIDED        |
| T6  | ClickHouse tests may use a test instance or dependency injection mock                      | INFERRED       |
| T7  | Existing 28 observatory-api E2E tests form baseline -- new tests extend, don't duplicate   | DECIDED        |

### Coverage Analysis

- **E2E scenarios:** 8 (exceeds minimum 5)
- **Integration scenarios:** 10 (exceeds minimum 5)
- **Unit scenarios:** 5
- **Total:** 23 test scenarios
- **Components covered:** 19 (see coverage matrix in spec)
- **Key gaps filled:** PII scrubbing E2E, cross-pod Redis delivery, memory pressure circuit breaker, OTEL bridge, trace forwarder

### Output

- Test spec: `docs/testing/tracing-observability.md`
- Coverage matrix mapping 19 components to test scenarios
- Infrastructure requirements documented
- Existing test baseline identified (28 E2E + unit tests)
