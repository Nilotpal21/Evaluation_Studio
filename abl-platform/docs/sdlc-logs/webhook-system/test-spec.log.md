# SDLC Log: Webhook System — Test Spec

**Phase:** Test Spec
**Date:** 2026-03-22
**Status:** Complete

## Sources Explored

1. `apps/runtime/src/__tests__/http-async-events.test.ts` — Existing event type contract test
2. `apps/runtime/src/__tests__/inbound-worker.test.ts` — Existing inbound worker unit test
3. `packages/shared-kernel/src/security/__tests__/webhook-signature.test.ts` — Existing signature tests
4. `apps/runtime/src/routes/http-async-channel.ts` — Routes to test
5. `apps/runtime/src/services/queues/delivery-worker.ts` — Worker to test
6. `apps/runtime/src/channels/security/callback-url-policy.ts` — SSRF policy to test
7. `docs/testing/README.md` — Test spec format reference

## Test Scenario Summary

| Category              | Count   | Priority     |
| --------------------- | ------- | ------------ |
| E2E scenarios         | 7       | P0: 4, P1: 3 |
| Integration scenarios | 7       | P0: 4, P1: 3 |
| Existing unit tests   | 4 files | Passing      |
| **Total planned**     | **14**  | -            |

## Key Design Decisions

| ID  | Classification | Decision                                                                         |
| --- | -------------- | -------------------------------------------------------------------------------- |
| T1  | DECIDED        | E2E tests use local HTTP servers (ephemeral ports) to receive webhook deliveries |
| T2  | DECIDED        | Controlled HTTP server responses (configurable 5xx/410/200) for retry testing    |
| T3  | DECIDED        | Two separate tenant auth contexts for isolation testing                          |
| T4  | DECIDED        | Integration tests use real Redis + MongoDB (MongoMemoryServer acceptable)        |
| T5  | ANSWERED       | No mocking of codebase components in E2E tests (per CLAUDE.md E2E standards)     |

## Gaps from Feature Spec

- `session.completed` and `session.escalated` event delivery not testable yet (not wired)
- Circuit breaker / auto-disable threshold testing deferred (open question in feature spec)
- Dead letter queue testing N/A (out of scope)

## Output

- `docs/testing/webhook-system.md` — 7 E2E + 7 integration test scenarios
