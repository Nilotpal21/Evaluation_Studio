# Test Spec Log: Tags & Eval Tags

**Feature**: Tags & Eval Tags
**Phase**: TEST-SPEC
**Date**: 2026-03-23

---

## Oracle Decisions

### Test Scope & Priorities

| #   | Question                             | Answer                                                                                                                                                                                 | Classification |
| --- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 1   | Highest risk requirements?           | FR-3/FR-4 dual-write (MongoDB + ClickHouse consistency), FR-12 tenant/project isolation, FR-7 auto-apply engine.                                                                       | DECIDED        |
| 2   | Known edge cases?                    | ClickHouse ReplacingMergeTree eventual consistency (FINAL keyword needed for reads after recent writes), bulk operations with partial failures, tag removal from immutable ClickHouse. | INFERRED       |
| 3   | Current coverage baseline?           | Zero -- no existing tests for tags routes, TagRuleModel, or conversation_tags.                                                                                                         | ANSWERED       |
| 4   | External dependencies needing mocks? | None -- all deps (MongoDB, ClickHouse) should be real in integration/E2E. Only mock if ClickHouse unavailable in CI.                                                                   | DECIDED        |
| 5   | Test environment?                    | Docker for MongoDB/ClickHouse, vitest with port 0 for Express. Existing CI pipeline.                                                                                                   | ANSWERED       |

### E2E Scenarios

| #   | Question                      | Answer                                                                                                            | Classification |
| --- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------- |
| 1   | Critical user journeys?       | CRUD lifecycle, apply/remove with dual-write verification, cross-tenant 404, bulk ops, stats analytics.           | DECIDED        |
| 2   | Auth/permission combinations? | project:write for rules CRUD, session:write for apply/remove, session:read for list/stats. viewer vs admin roles. | ANSWERED       |
| 3   | Cross-feature interactions?   | Eval scenario tag filtering via Studio API, session lifecycle triggering auto-apply.                              | DECIDED        |
| 4   | Data seeding?                 | Via HTTP API calls (POST /auth, POST /projects, POST sessions) -- no direct DB.                                   | DECIDED        |
| 5   | Performance scenarios?        | 100 rules list latency, 50 concurrent applies, 1M row ClickHouse stats query.                                     | INFERRED       |

### Integration Boundaries

| #   | Question             | Answer                                                                                                                   | Classification |
| --- | -------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------- |
| 1   | Service boundaries?  | Condition evaluator <-> session data, tag service <-> MongoDB + ClickHouse dual-write, auto-apply <-> session lifecycle. | DECIDED        |
| 2   | Event-driven flows?  | Session status change events trigger auto-apply evaluation.                                                              | DECIDED        |
| 3   | Isolation scenarios? | ClickHouse project_id scoping in aggregation queries, MongoDB tenantId in all queries.                                   | ANSWERED       |
| 4   | Race conditions?     | Concurrent tag apply to same session (should be idempotent), bulk apply with overlapping sessions.                       | INFERRED       |
| 5   | Error/failure paths? | ClickHouse write failure during dual-write, invalid session ID in bulk ops, auto-apply engine crash isolation.           | DECIDED        |

---

## Summary

- 10 E2E test scenarios covering CRUD, apply/remove, isolation, bulk ops, stats, validation, permissions, eval filtering
- 7 integration test scenarios covering condition evaluation, dual-write, auto-apply, ClickHouse stats, bulk partial failure, rule update behavior
- 4 unit test scenarios covering edge cases, normalization, validation schemas, query builders
- 13 test files planned across E2E, integration, and unit categories
- All 14 functional requirements mapped in coverage matrix

## Files Created/Updated

- `docs/testing/tags.md` -- Full test specification (overwrite of placeholder)
- `docs/sdlc-logs/tags/test-spec.log.md` -- This file
