# SDLC Log: HLD — Analytics Insights Dashboard

**Date**: 2026-03-23
**Phase**: 3 — HLD
**Status**: DONE

## Decisions

| #   | Classification | Decision                                                                                          |
| --- | -------------- | ------------------------------------------------------------------------------------------------- |
| D-1 | DECIDED        | Option A — extend existing InsightsDashboardPage and fill stub pages. No new backend APIs.        |
| D-2 | DECIDED        | New `usePipelineAnalytics` SWR hook for pipeline-specific data fetching                           |
| D-3 | DECIDED        | New `usePipelineHealth` hook aggregating all 10 pipeline summaries for scorecard                  |
| D-4 | DECIDED        | Lightweight Zustand store (`insights-store.ts`) for shared date range across pages                |
| D-5 | DECIDED        | `AnalyticsWidget` wrapper component for consistent loading/error/empty states                     |
| D-6 | DECIDED        | Lazy-load all page components via `next/dynamic` to control Recharts bundle impact                |
| D-7 | DECIDED        | Pipeline-analytics routes proxied via Studio middleware (already handled by `isRuntimeProxyPath`) |

## Key Findings

- **Pipeline-analytics API already has Redis caching**: `AnalyticsCache` wired into route handlers with 5-min TTL
- **Proxy already works**: `/api/projects/:projectId/pipeline-analytics/*` matches `RUNTIME_PROJECT_SUBPATH_RE` in `proxy.ts` for some paths, but may need explicit addition for `pipeline-analytics` prefix
- **Studio proxy route** (`/api/runtime/analytics`) handles generic analytics but NOT pipeline-specific endpoints — need to verify routing
- **10 pipeline ClickHouse queries are parameterized** with `{tenantId:String}` syntax — no SQL injection risk
- **3 MVs available for pre-aggregation**: daily_sentiment, daily_intent_distribution, daily_quality_scores

## Twelve Concerns Checklist

| #   | Concern          | Status | Notes                                                          |
| --- | ---------------- | ------ | -------------------------------------------------------------- |
| 1   | Tenant Isolation | OK     | Two-layer enforcement (Studio proxy + Runtime middleware)      |
| 2   | Auth & Authz     | OK     | JWT + RBAC `session:read` on all endpoints                     |
| 3   | Data Model       | OK     | Read-only from existing ClickHouse tables, no new schema       |
| 4   | API Design       | OK     | No new endpoints — consumes existing pipeline-analytics API    |
| 5   | Caching          | OK     | AnalyticsCache (Redis, fail-open, 5-min TTL) + SWR client-side |
| 6   | Performance      | OK     | Lazy-load, pre-aggregated MVs, query timeouts                  |
| 7   | Error Handling   | OK     | Widget-level error isolation, fail-open cache                  |
| 8   | Observability    | OK     | Existing runtime logging, no new trace events                  |
| 9   | Scalability      | OK     | ClickHouse handles volume, cache absorbs repeated queries      |
| 10  | Security         | OK     | No new attack surface, no PII in analytics                     |
| 11  | Backwards Compat | OK     | Same URLs, enhanced pages, preserved hooks                     |
| 12  | Testing          | OK     | 32 tests across unit/integration/E2E                           |
