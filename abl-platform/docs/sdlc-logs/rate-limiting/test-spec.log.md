# SDLC Log: Rate Limiting — Test Spec (Phase 2)

**Date**: 2026-03-22
**Phase**: Test Spec
**Artifact**: `docs/testing/rate-limiting.md`

## Decision Log

| #   | Question                                         | Classification | Resolution                                                                                                                              |
| --- | ------------------------------------------------ | -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Which FRs are highest risk for production?       | DECIDED        | FR-1 (tenant budgets) and FR-5 (Redis fallback) are highest risk — they affect all request traffic.                                     |
| 2   | What test infrastructure is available for Redis? | INFERRED       | Docker Compose Redis is used by other services. Testcontainers is also viable for isolation.                                            |
| 3   | Should eval tests be unit or integration?        | DECIDED        | Unit tests first — eval limiter is in-memory only, no Redis dependency. Integration test for INT-5 validates tier enforcement.          |
| 4   | How to test Redis-to-memory fallback in E2E?     | DECIDED        | Start with Redis, disconnect container, verify graceful degradation in logs and continued availability. E2E-5 scenario.                 |
| 5   | Should multi-pod tests be automated?             | AMBIGUOUS      | Left as open testing question. Multi-pod simulation is complex and may belong in a separate perf-testing harness.                       |
| 6   | What should E2E test file paths be?              | DECIDED        | `apps/runtime/src/__tests__/e2e/rate-limiter-redis.test.ts` and `apps/search-ai/src/__tests__/e2e/rate-limit-redis.test.ts`.            |
| 7   | How many E2E scenarios are needed?               | DECIDED        | 7 E2E scenarios covering all major surfaces: tenant throttling, per-key, session messages, SearchAI, fallback, unlimited, session caps. |

## Files Created/Modified

- `docs/testing/rate-limiting.md` — Complete rewrite with 7 E2E, 7 integration, 4 unit scenarios
- `docs/sdlc-logs/rate-limiting/test-spec.log.md` — This file

## Review Summary

**Round 1 — Coverage**: 7 E2E scenarios (minimum 5). 7 integration scenarios (minimum 5). All 8 FRs mapped in coverage matrix. Auth context specified for all E2E scenarios. No mocks or direct DB access in E2E scenarios. Service boundaries specified for all integration scenarios.

**Round 2 — Alignment**: E2E scenarios cover all high-risk FRs (FR-1, FR-2, FR-5). E2E scenarios match user stories (operator budgets, SDK throttling, SearchAI pacing). Integration boundaries match data flow from feature spec (Redis Lua scripts, HybridRateLimiter, session slots, eval counters, connector token bucket, agent-transfer conditional ZADD).
