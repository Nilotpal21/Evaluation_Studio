# SDLC Log: Billing — Phase 4 (LLD)

**Date:** 2026-03-23
**Phase:** Low-Level Design & Implementation Plan
**Status:** COMPLETE

## Summary

Generated LLD at `docs/plans/2026-03-23-billing-impl-plan.md` with 5 implementation phases:

1. **Phase 1: Quota Enforcement Middleware** — Redis-cached quota checks, fail-open, feature-flagged
2. **Phase 2: Credit Consumption Pipeline** — Async credit recording after LLM calls, atomic writes
3. **Phase 3: Usage Aggregation Worker** — BullMQ hourly job, ClickHouse → UsagePeriod rollup
4. **Phase 4: Billing Events & API Endpoints** — EventStore integration, subscription/usage-summary endpoints
5. **Phase 5: Studio Usage Dashboard** — 7 components, SWR hooks, billing page

## Codebase Integration Points Verified

| Integration Point              | File                                             | Line(s)           | Verified                                               |
| ------------------------------ | ------------------------------------------------ | ----------------- | ------------------------------------------------------ |
| Metrics `.record()` call sites | `apps/runtime/src/routes/chat.ts`                | ~399, ~553, ~1164 | Yes — 3 locations where credit consumption hooks in    |
| Tenant router middleware chain | `apps/runtime/src/server.ts`                     | ~485              | Yes — quota middleware goes after `requireTenantMatch` |
| EventStore event registration  | `packages/eventstore/src/schema/events/index.ts` | imports           | Yes — needs `import './billing-events.js'`             |
| Redis client                   | `apps/runtime/src/services/redis-client.js`      | —                 | Needs verification at implementation time              |
| BullMQ availability            | N/A                                              | —                 | BullMQ used by pipeline-engine, available in runtime   |

## Key Implementation Decisions

| Decision                                                 | Rationale                                                              |
| -------------------------------------------------------- | ---------------------------------------------------------------------- |
| Feature flags for both quota enforcement and aggregation | Gradual rollout, instant rollback                                      |
| Credit entries per-period, not unbounded                 | One CreditLedger per deal per billing period prevents unbounded growth |
| Single-flight quota resolution                           | Prevents Redis cache stampede on cold start                            |
| Batch processing with inter-batch delays                 | Protects ClickHouse from query pressure during aggregation             |
| Fire-and-forget credit writes                            | LLM response latency not affected by billing                           |

## Wiring Checklist

8 wiring items identified (W1-W8). Each maps a created component to its integration point with specific file path and phase.

## Audit Findings

- [x] All phases have explicit exit criteria
- [x] All file paths grounded in actual codebase structure
- [x] Wiring checklist covers all integration points
- [x] Environment variables documented with defaults
- [x] Risk mitigations for each phase
- [x] Test execution order matches phase dependencies
- [x] No database migrations needed (models exist)
- [x] Feature flags enable safe rollout
