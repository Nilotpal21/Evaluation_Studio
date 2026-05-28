# SDLC Log: Structured Error Framework — Test Spec

**Phase**: Test Spec (Phase 2)
**Date**: 2026-03-25
**Skill**: `/test-spec`

---

## Oracle Decisions

| #   | Question                            | Classification | Decision                                                                                                                     |
| --- | ----------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1   | Highest risk FRs?                   | INFERRED       | CRITICAL: FR-13 (security leaks), FR-16 (WS rejections). HIGH: FR-3 (duck-typing), FR-5 (traceId), FR-8 (tool errors).       |
| 2   | Known edge cases from production?   | ANSWERED       | Unsafe error casts (10 instances), swallowed catches (5 in paused-execution-store), 6 info leaks, 11 unhandled WS rejections |
| 3   | Current test coverage baseline?     | ANSWERED       | 16 LLM classifier tests, 13 AppError/errors tests (49 with it.each), 20 architecture fitness tests                           |
| 4   | External deps: mock vs real?        | INFERRED       | LLM providers: mock via DI. MongoDB: real (MongoMemoryServer). Redis: optional. ClickHouse: skip. OTEL: real headers.        |
| 5   | Test environment setup?             | ANSWERED       | Vitest (forks pool), RuntimeApiHarness, MongoMemoryServer, channel-e2e-bootstrap helpers                                     |
| 6   | Critical E2E user journeys?         | INFERRED       | 7 journeys: LLM error in chat, AI agent retry, Observatory search, validation error, security leak, WS error, cross-tenant   |
| 7   | Auth/permission combinations?       | INFERRED       | Expired JWT, missing credentials, cross-tenant, cross-project, SDK auth, no auth header                                      |
| 8   | Cross-feature interactions?         | ANSWERED       | Error + rate limiting, circuit breaker, guardrails, tracing, tool invocations, audit logging                                 |
| 9   | Data seeding?                       | INFERRED       | bootstrapProject(), devLogin(), authHeaders(), addMember() — established helpers                                             |
| 10  | Performance scenarios?              | DECIDED        | 1 classification benchmark (<1ms), 1 concurrent WS stress test (10 clients, 50 msgs each). No full load tests.               |
| 11  | Service boundaries for integration? | ANSWERED       | 6 boundaries: asyncHandler→handler, classifier→TraceStore, Registry→i18n, duck-typing, tool results, WS errors               |
| 12  | Event-driven flows?                 | INFERRED       | Error→ClickHouse audit, error→TraceEvents→Observatory, WS error delivery                                                     |
| 13  | Tenant/project isolation?           | ANSWERED       | Never leak tenantId, cross-tenant 404, cross-project 404, cross-user 404, KMS regression                                     |
| 14  | Race conditions?                    | INFERRED       | 10+ concurrent WS errors, asyncHandler concurrent requests, TraceStore concurrent emission                                   |
| 15  | Integration-level error paths?      | INFERRED       | Classifier fallback, TraceStore down resilience, next(err) throws, each error hierarchy duck-typing                          |

No AMBIGUOUS items — all resolved from feature spec, codebase, and established patterns.

---

## Test Spec Summary

| Category              | Count                     |
| --------------------- | ------------------------- |
| E2E scenarios         | 10 (E2E-1 through E2E-10) |
| Integration scenarios | 10 (INT-1 through INT-10) |
| Unit test scenarios   | 5 (UT-1 through UT-5)     |
| Security scenarios    | 7 (SEC-1 through SEC-7)   |
| Performance scenarios | 2 (PERF-1, PERF-2)        |
| Test files planned    | 17 (3 existing + 14 new)  |

## Audit Rounds

| Round | Status         | Findings                                                                                                                                       |
| ----- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | NEEDS_REVISION | 1 HIGH (missing cross-user isolation SEC-7), 3 MEDIUM (test counts, ErrorCodes count, missing dedup path). All fixed.                          |
| 2     | APPROVED       | 4 MEDIUM (non-blocking: architecture-fitness count 24→20, observatory API path, test file mapping gaps, stale counts in Section 8). All fixed. |

## Files Modified

| File                                                         | Action                                      |
| ------------------------------------------------------------ | ------------------------------------------- |
| `docs/testing/structured-error-framework.md`                 | Replaced placeholder with full test spec    |
| `docs/testing/README.md`                                     | Updated E2E/Integration counts (7→10, 6→10) |
| `docs/sdlc-logs/structured-error-framework/test-spec.log.md` | Created this log                            |

## Next Steps

- User runs `/hld structured-error-framework` next
