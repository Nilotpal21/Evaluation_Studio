# LLD Log: Tags & Eval Tags

**Feature**: Tags & Eval Tags
**Phase**: LLD
**Date**: 2026-03-23

---

## Oracle Decisions

### Implementation Strategy

| #   | Question                          | Answer                                                                                                                       | Classification |
| --- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 1   | Preferred implementation order?   | Data layer first (TagService + condition evaluator), then API fixes, then auto-apply, then Studio, then analytics, then E2E. | DECIDED        |
| 2   | Existing patterns to follow?      | Lazy-import for models, OpenAPI router, TenantScopedRepository, apiFetch Studio proxy pattern. All verified in source.       | ANSWERED       |
| 3   | Feature flags for phased rollout? | tags.autoApply.enabled runtime config flag for auto-apply only. Other features are independently deployable without flags.   | DECIDED        |
| 4   | Acceptable scope for phase 1?     | Data layer only -- TagService class, condition evaluator module, Zod schemas. No route changes until phase 2.                | DECIDED        |
| 5   | Hard deadlines?                   | None identified. Implementation can proceed phase-by-phase at normal cadence.                                                | INFERRED       |

### Technical Details

| #   | Question                                   | Answer                                                                                                                               | Classification |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| 1   | Which files need modification vs creation? | 3 modified (tags.ts, session.repository.ts, eval scenarios route), 15 new files (service, evaluator, schemas, tests, Studio routes). | ANSWERED       |
| 2   | Testing strategy?                          | Test-after per phase. Each phase has exit criteria requiring specific test files to pass.                                            | DECIDED        |
| 3   | Type definitions that change?              | No existing types change. New types: TagService interface, BulkTagResult, TagStatsResult, evaluateConditions signature.              | ANSWERED       |
| 4   | Database migration strategy?               | None needed. All schemas exist. Session.tags is already defined but never written. conversation_tags table exists.                   | ANSWERED       |
| 5   | Performance-sensitive paths?               | Auto-apply on session status change (must stay <10ms). ClickHouse stats aggregation (bounded by project scope + time range).         | DECIDED        |

### Risk & Dependencies

| #   | Question                     | Answer                                                                                                                                      | Classification |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 1   | Ongoing conflicting changes? | None identified. Tags routes are isolated; no other features touch tags.ts or session.repository.ts auto-apply path.                        | INFERRED       |
| 2   | Biggest implementation risk? | Dual-write consistency (MongoDB + ClickHouse). Mitigated: ClickHouse failures are logged but non-blocking. MongoDB is source of truth.      | DECIDED        |
| 3   | Team dependencies?           | None. All code is in runtime + Studio. No cross-team review needed.                                                                         | INFERRED       |
| 4   | Monitoring/alerting?         | ClickHouse write failures logged via createLogger('tag-service'). No new alerting infrastructure needed.                                    | DECIDED        |
| 5   | Definition of done?          | All 14 FRs covered, E2E tests passing, dual-write verified, Studio UI functional, auto-apply working, stats returning correct aggregations. | DECIDED        |

---

## Design Decisions Made

1. **D-1**: Extract TagService class from route handlers -- testable service layer, routes become thin delegators
2. **D-2**: Synchronous auto-apply via direct function call -- O(n<100) completes in <10ms
3. **D-3**: MongoDB $addToSet/$pull for Session.tags -- idempotent, atomic array operations
4. **D-4**: ClickHouse ALTER TABLE DELETE for tag removal -- simplest approach
5. **D-5**: Zod validation on all endpoints including PUT -- closes GAP-6
6. **D-6**: Tag cap of 50 per session enforced in TagService -- prevents unbounded growth
7. **D-7**: Studio proxy routes use apiFetch pattern -- matches existing 11 settings tabs
8. **D-8**: Condition evaluator as pure function module -- easy to unit test, no side effects

## Implementation Phases Summary

| Phase | Name                    | Files | Exit Criteria Count |
| ----- | ----------------------- | ----- | ------------------- |
| 1     | Data Layer (TagService) | 4 new | 4                   |
| 2     | API Layer (Route Fixes) | 2 mod | 4                   |
| 3     | Auto-Apply Engine       | 2 new | 4                   |
| 4     | Studio Proxy Routes     | 3 new | 3                   |
| 5     | Studio UI Components    | 3 new | 3                   |
| 6     | Analytics & Stats       | 2 new | 4                   |
| 7     | E2E Tests               | 2 new | 5                   |

## Files Created

- `docs/plans/2026-03-23-tags-impl-plan.md` -- LLD + Implementation Plan (571 lines)
- `docs/sdlc-logs/tags/lld.log.md` -- This file
