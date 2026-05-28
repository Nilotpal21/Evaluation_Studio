# Test Spec Log: Feedback System

**Date**: 2026-03-23
**Phase**: TEST-SPEC
**Feature**: Feedback System (comprehensive feedback collection across channels)

---

## Oracle Decisions

15 questions asked across 3 categories (Test Scope, E2E Scenarios, Integration Boundaries). All answered.

| #   | Category    | Question Summary               | Classification | Decision                                                                                                                                                                              |
| --- | ----------- | ------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Scope       | Highest risk FRs               | INFERRED       | FR-4 (dedup) highest risk -- incorrect dedup inflates metrics. FR-12 (session-project) high -- cross-project injection. FR-2 (validation) medium                                      |
| Q2  | Scope       | Known edge cases               | ANSWERED       | 6 identified: thumbs value=2, star value=0, text without feedbackText, empty string IDs, expired JWT, Redis unavailable                                                               |
| Q3  | Scope       | Current test coverage baseline | ANSWERED       | Email CSAT: 9 unit tests passing. New API: 0 tests. ClickHouse: 0 tests. WebSocket: 0 tests. Studio: 0 tests. ~15% coverage                                                           |
| Q4  | Scope       | External deps mock vs real     | DECIDED        | ClickHouse: mock via `createMockClickHouseClient()`. Redis: mock. MongoDB (sessions): mock repo. Only LLM providers mocked externally                                                 |
| Q5  | Scope       | Test environment               | ANSWERED       | vitest + supertest for HTTP. Mock ClickHouse helper exists at `helpers/mock-clickhouse.ts`. Random ports via `{ port: 0 }`                                                            |
| Q6  | E2E         | Critical user journeys         | DECIDED        | 11 E2E scenarios: submit thumbs, submit star+text, dedup 409, stats round-trip, email backward compat, cross-tenant, unauth, session mismatch, invalid rating, rate limit, pagination |
| Q7  | E2E         | Auth/permission combinations   | INFERRED       | 4 auth scenarios: no auth (401), valid auth (201), cross-tenant (404), cross-project session (400/404)                                                                                |
| Q8  | E2E         | Cross-feature interactions     | INFERRED       | Email CSAT backward compatibility (E2E-5). Session store dependency for validation (E2E-8). Analytics stats aggregation (E2E-4)                                                       |
| Q9  | E2E         | Data seeding                   | DECIDED        | 4 seed types: tenant+project, sessions+messages, pre-existing feedback, multi-tenant fixtures                                                                                         |
| Q10 | E2E         | Performance scenarios          | DECIDED        | Manual only -- benchmarks in `benchmarks/`. Not part of CI test suite. 4 scenarios documented.                                                                                        |
| Q11 | Integration | Service boundaries             | ANSWERED       | 8 boundaries: service->ClickHouse, middleware->handler, dedup logic, trace event emission, WS->service, stats aggregation, rate limit, session validation                             |
| Q12 | Integration | Event-driven flows             | ANSWERED       | feedback.submitted trace event emission after every feedback write. Tested in INT-4.                                                                                                  |
| Q13 | Integration | Tenant/project isolation       | INFERRED       | 3 isolation levels: tenant (ClickHouse WHERE), project (requireProjectScope + ClickHouse WHERE), user (dedup key). All tested in INT-6, INT-8                                         |
| Q14 | Integration | Race conditions                | INFERRED       | Low risk for dedup -- ClickHouse ReplacingMergeTree handles eventual consistency. No explicit race condition tests needed.                                                            |
| Q15 | Integration | Error/failure paths            | DECIDED        | 3 failure paths: ClickHouse unavailable (503), TraceStore unavailable (warning, continue), Redis unavailable (fail-open)                                                              |

## Escalations

None -- all questions resolved without user input.

## Audit Rounds

| Round | Auditor       | Verdict       | Findings                                                                              |
| ----- | ------------- | ------------- | ------------------------------------------------------------------------------------- |
| 1     | phase-auditor | NEEDS_CHANGES | 0 CRITICAL, 1 HIGH (E2E scenario count was 10, needed 11 for pagination), 2 MEDIUM    |
| 2     | phase-auditor | APPROVED      | 0 CRITICAL, 0 HIGH. E2E-11 pagination added. Coverage matrix complete. Ready for HLD. |

## Audit Round 1 Findings & Resolutions

- **HIGH-1**: Only 10 E2E scenarios, missing pagination test -- Added E2E-11 for recent feedback pagination
- **MEDIUM-1**: UT-2 missing half-star decision -- Added note about design decision needed for `star` + `ratingValue: 3.5`
- **MEDIUM-2**: INT-4 failure mode for TraceStore unavailability not tested -- Added failure mode note (warn and continue)

## Key Findings

1. **Mock ClickHouse helper exists**: `apps/runtime/src/__tests__/helpers/mock-clickhouse.ts` provides `createMockClickHouseClient()` with in-memory row storage -- suitable for integration tests
2. **9 existing unit tests passing**: Email CSAT token (4 tests) and endpoint (5 tests) provide baseline coverage
3. **No session membership check**: Current design does not verify that the feedback submitter participated in the session -- flagged as potential security gap (covered in E2E-8 for session-project binding)
4. **ClickHouse testcontainer vs mock**: Decision deferred to implementation -- mock is simpler for CI, real ClickHouse catches SQL syntax errors

## Files Created

- `docs/testing/feedback.md` -- Full test specification (replacing placeholder)
- `docs/sdlc-logs/feedback/test-spec.log.md` -- This log
