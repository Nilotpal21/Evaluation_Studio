# SDLC Log: Billing — Phase 3 (HLD)

**Date:** 2026-03-23
**Phase:** High-Level Design
**Status:** COMPLETE

## Summary

Generated HLD at `docs/specs/billing.hld.md` covering:

- Architecture overview with 4-layer diagram (Studio, Runtime API, Background Workers, Data Stores)
- 5 component designs: Quota Enforcement, Credit Consumption, Usage Aggregation, Billing Events, Studio UI
- 12 architectural concerns addressed
- 4 alternatives considered (3 rejected, 1 deferred)
- 4 open questions with decisions

## Key Architectural Decisions

| Decision                   | Choice                                       | Rationale                                          |
| -------------------------- | -------------------------------------------- | -------------------------------------------------- |
| Quota enforcement strategy | Redis cache (60s TTL) + fail-open            | < 5ms latency target; matches feature-gate pattern |
| Credit write pattern       | Atomic `$push` + `$inc` on CreditLedger      | Avoids read-modify-write race conditions           |
| Aggregation scheduling     | BullMQ repeatable job (hourly)               | Platform convention; auto-recovery                 |
| Event emission             | EventStore (fire-and-forget)                 | Events are informational, not transactional        |
| Middleware chain position  | After auth, after rate limit, before handler | Needs tenantContext from auth                      |
| Phase 2 extraction         | Deferred dedicated billing microservice      | Service layer separation enables future extraction |

## Codebase Verification

All referenced components verified to exist:

- EventStore: `packages/eventstore/src/` — IEventEmitter interface, EventRegistry, event categories
- No existing `billing-events.ts` in eventstore schema — new file needed
- ClickHouseMetricsStore: `apps/runtime/src/services/stores/clickhouse-metrics-store.ts` — all 4 tenant methods exist
- Server route mounting: `apps/runtime/src/server.ts` — billing routes at lines 487-505
- Feature gate: `apps/runtime/src/middleware/feature-gate.ts` — PLAN_FEATURES constant verified

## Audit Findings

- [x] All 12 architectural concerns addressed
- [x] Component designs include key types and data flow
- [x] Middleware chain placement documented with rationale
- [x] Failure modes for each dependency documented
- [x] Redis cache schema with TTL values specified
- [x] No new database migrations required (models exist)
- [x] Rollout strategy with feature flag for gradual enablement
