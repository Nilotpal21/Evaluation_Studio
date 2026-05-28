# SDLC Log: Test Spec — Analytics Insights Dashboard

**Date**: 2026-03-23
**Phase**: 2 — Test Spec
**Status**: DONE

## Decisions

| #   | Classification | Decision                                                                                       |
| --- | -------------- | ---------------------------------------------------------------------------------------------- |
| D-1 | DECIDED        | 15 unit tests covering all 21 FRs across 4 page components + 1 hook                            |
| D-2 | DECIDED        | 7 integration tests covering pipeline-analytics API, cache, proxy, and auth                    |
| D-3 | DECIDED        | 10 E2E tests covering full render, navigation, empty/error states, isolation, and performance  |
| D-4 | DECIDED        | E2E tests use real Express servers with full middleware chain — no mocking codebase components |
| D-5 | DECIDED        | Test data seeded via ClickHouse DDL and insert scripts — no direct MongoDB access in E2E       |

## Key Findings

- **No existing tests for InsightsDashboardPage** — current UI has zero test coverage
- **Pipeline-analytics route tests exist** (`pipeline-analytics.test.ts`) but only cover route handler logic, not integration with real ClickHouse
- **AnalyticsCache has good unit test coverage** (`analytics-cache.test.ts`) but no integration test with real Redis
- **E2E tests need ClickHouse seeding** — 7 pipeline output tables need realistic test data
- **Performance testing requires 90d dataset** — ~1M events to validate NFR-1 under load

## Audit Summary

- 21 FRs mapped to test coverage matrix
- 15 unit tests, 7 integration tests, 10 E2E tests = 32 total test scenarios
- E2E tests use real servers (no mocking) per CLAUDE.md E2E standards
- Performance and accessibility tests included
- Test data requirements specified with volumes and table sources
