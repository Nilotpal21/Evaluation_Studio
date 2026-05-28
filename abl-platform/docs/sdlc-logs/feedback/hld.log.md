# HLD Log: Feedback System

**Date**: 2026-03-23
**Phase**: HLD
**Feature**: Feedback System (comprehensive feedback collection across channels)

---

## Oracle Decisions

15 questions asked across 3 categories (Architecture & Data Flow, Integration & Dependencies, Risk & Migration). All answered.

| #   | Category     | Question Summary                     | Classification | Decision                                                                                                                                             |
| --- | ------------ | ------------------------------------ | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Architecture | Preferred architecture pattern       | DECIDED        | Service layer + route handler. FeedbackService (write) + FeedbackQueryService (read). Same pattern as analytics routes.                              |
| Q2  | Architecture | Data flow -- request vs event-driven | ANSWERED       | Request-driven for write (REST/WS -> service -> ClickHouse). Event-driven for trace (service -> TraceStore). Read queries ClickHouse directly.       |
| Q3  | Architecture | Expected scale                       | INFERRED       | Low relative to messages. ~1-10% of sessions generate feedback. At 100K sessions/month, expect ~10K feedback/month. Well within ClickHouse capacity. |
| Q4  | Architecture | Existing patterns to follow          | ANSWERED       | `llm_metrics` + `llm_metrics_hourly_dest` pattern for ClickHouse + MV. Analytics route pattern for project-scoped queries with auth middleware.      |
| Q5  | Architecture | Deployment topology                  | ANSWERED       | Single service (runtime). No new workers or queues. ClickHouse MV handles aggregation automatically.                                                 |
| Q6  | Integration  | Existing service dependencies        | ANSWERED       | ClickHouse (via database package), TraceStore, Redis (email only), MongoDB (session validation), auth middleware, rate limiter.                      |
| Q7  | Integration  | New external dependencies            | ANSWERED       | None. All infrastructure already deployed.                                                                                                           |
| Q8  | Integration  | API contract with consumers          | DECIDED        | Standard envelope format. Zod validation. Paginated responses with `{ items, total, hasMore }`.                                                      |
| Q9  | Integration  | Breaking changes                     | ANSWERED       | None. All new routes. Email CSAT unchanged. Bridge to ClickHouse is additive.                                                                        |
| Q10 | Integration  | DSL/compile/deploy lifecycle         | ANSWERED       | No DSL impact. Feedback is runtime-only. No compilation step.                                                                                        |
| Q11 | Risk         | Biggest technical risk               | INFERRED       | Agent name resolution -- deriving which agent produced the target message requires trace data lookup. May be slow or unavailable.                    |
| Q12 | Risk         | Existing data migration              | ANSWERED       | None. New tables only. Existing email CSAT trace events remain in platform_events.                                                                   |
| Q13 | Risk         | Rollback strategy                    | DECIDED        | 3-phase independent rollback: DROP tables, remove routes, remove Studio tab. Each phase reversible independently.                                    |
| Q14 | Risk         | Feature flags                        | DECIDED        | None needed. Additive feature -- new routes don't affect existing behavior. Email CSAT unchanged.                                                    |
| Q15 | Risk         | Blast radius                         | INFERRED       | Low. ClickHouse table creation is independent. Route registration is additive. Studio tab is a new component. No existing behavior modified.         |

## Escalations

None -- all questions resolved without user input.

## Audit Rounds

| Round | Auditor       | Verdict       | Findings                                                                                |
| ----- | ------------- | ------------- | --------------------------------------------------------------------------------------- |
| 1     | phase-auditor | NEEDS_CHANGES | 0 CRITICAL, 2 HIGH (missing MV DDL, incomplete error model), 3 MEDIUM                   |
| 2     | phase-auditor | NEEDS_CHANGES | 0 CRITICAL, 1 HIGH (missing feedbackText max length in performance budget), 2 MEDIUM    |
| 3     | phase-auditor | APPROVED      | 0 CRITICAL, 0 HIGH. All findings resolved. Complete 12-concern coverage. Ready for LLD. |

## Audit Round 1 Findings & Resolutions

- **HIGH-1**: Materialized view DDL missing -- Added `feedback_daily_mv` CREATE MATERIALIZED VIEW statement
- **HIGH-2**: Error model incomplete -- Added full error code table (VALIDATION_ERROR, SESSION_NOT_FOUND, DUPLICATE_FEEDBACK, RATE_LIMIT_EXCEEDED, SERVICE_UNAVAILABLE) with HTTP status codes
- **MEDIUM-1**: No ReplicatedMergeTree path for feedback table -- Added full ENGINE clause with shard/replica paths
- **MEDIUM-2**: Cross-cutting audit logging not addressed -- Added explanation (not required for end-user actions, trace events provide audit trail)
- **MEDIUM-3**: Studio proxy auth pattern not specified -- Added open question Q5 about apiFetch vs SWR pattern

## Audit Round 2 Findings & Resolutions

- **HIGH-1**: Performance budget missing feedbackText size limit -- Added 5000 char max, <10KB payload constraint, added open question Q4
- **MEDIUM-1**: Stats byAgent array not in response schema -- Added `byAgent` array to GET /feedback/stats response schema
- **MEDIUM-2**: MV GROUP BY missing tenant_id/project_id -- Fixed MV query to include tenant_id, project_id in GROUP BY

## Key Design Decisions

1. **D-1: Option B chosen** -- Dedicated ClickHouse table over event-only (Option A) or MongoDB dual-write (Option C)
2. **D-2: No feature flags** -- Additive feature, no existing behavior modified
3. **D-3: 3-phase independent rollback** -- Tables, routes, and Studio tab each independently reversible
4. **D-4: Email bridge deferred** -- Open question Q3 about timing
5. **D-5: TraceStore fail-open** -- ClickHouse is primary store, trace event is secondary
6. **D-6: No circuit breaker** -- ClickHouse client handles retries; single dependency doesn't warrant circuit breaker complexity

## Files Created

- `docs/specs/feedback.hld.md` -- High-Level Design document
- `docs/sdlc-logs/feedback/hld.log.md` -- This log
