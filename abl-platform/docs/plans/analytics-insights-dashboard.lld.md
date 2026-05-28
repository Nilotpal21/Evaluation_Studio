# Analytics & Insights Dashboard -- Low-Level Design

## Implementation Structure

### Route Modules (apps/runtime/src/routes/)

**analytics.ts** -- 916 lines, mounted at `/api/projects/:projectId/analytics`

- `GET /metrics` -- Aggregated metrics via `queryService.aggregate()` with configurable groupBy/metrics
- `GET /events` -- Event listing with filters, pagination (max 10,000), session access control
- `GET /agents/:agentName` -- Per-agent rollup: 3 parallel queries (eventCounts, costBreakdown, errorAgg)
- `GET /cost-breakdown` -- LLM cost via `queryService.getCostBreakdown()`
- `GET /session-metrics` -- Session completion rate, avg duration, avg cost via `queryService.getSessionMetrics()`
- `GET /event-counts` -- Counts grouped by dimension via `queryService.getEventCounts()`
- `POST /query` -- Ad-hoc event query with Zod-validated body (timeRange, filters, pagination)
- `POST /aggregate` -- Ad-hoc GROUP BY with configurable dimensions and metrics
- `POST /sql-query` -- Direct ClickHouse SQL with multi-layer security validation

**insights.ts** -- 206 lines, mounted at `/api/projects/:projectId/insights`

- `GET /timeseries` -- 4 parallel ClickHouse queries merged into daily array (sentiment, quality, outcomes, session volume)
- `GET /outcomes` -- Outcome distribution totals for configurable date range

**nl-analytics.ts** -- 107 lines, mounted at `/api/projects/:projectId/nl-analytics`

- `POST /ask` -- Natural language question -> NLQueryService -> validated SQL -> results

### SQL Validation Pipeline (analytics.ts)

1. Comment detection (`--`, `/*`, `#`)
2. Single SELECT enforcement (count SELECT keywords)
3. Complexity check (UNION, JOIN, WITH, INTERSECT, EXCEPT)
4. FROM clause extraction + whitelist check (`abl_platform.platform_events`, `abl_platform.llm_metrics`)
5. WHERE clause extraction + mandatory parameterized filters
6. OR condition rejection
7. Forbidden keyword regex (INSERT, UPDATE, DELETE, DROP, etc.)
8. Automatic LIMIT append (1000 max) + execution timeout (10s)

### Studio UI (apps/studio/src/components/)

**analytics/** -- 8 files

| File                      | Purpose                                                       |
| ------------------------- | ------------------------------------------------------------- |
| `AnalyticsPage.tsx`       | Container with Grafana-style date picker + 5 lazy-loaded tabs |
| `OverviewTab.tsx`         | KPI cards + time-series charts (recharts)                     |
| `LLMPerformanceTab.tsx`   | Model-specific metrics and cost breakdown                     |
| `SessionsExplorerTab.tsx` | Searchable session list with drill-through                    |
| `TracesExplorerTab.tsx`   | Event-level trace viewer for a session                        |
| `QueryExplorerTab.tsx`    | SQL query editor with results table                           |
| `SessionsTab.tsx`         | Alternate session tab variant                                 |
| `shared.tsx`              | Shared chart components, formatDuration, formatCost           |

**insights/** -- 5 files + shared/

| File                         | Purpose                         |
| ---------------------------- | ------------------------------- |
| `InsightsDashboardPage.tsx`  | At-a-glance dashboard container |
| `AtAGlancePage.tsx`          | At-a-glance KPI page            |
| `mock-data.ts`               | Development mock data           |
| `shared/TimeSeriesChart.tsx` | Reusable time-series chart      |
| `shared/BreakdownTable.tsx`  | Metric breakdown table          |
| `shared/InsightKPICard.tsx`  | KPI card for insights           |

### Query Service (packages/eventstore/src/query/)

**event-query-service.ts** -- Core abstraction over ClickHouse

- `query(params)` -- Raw event retrieval with filtering + pagination
- `aggregate(params)` -- GROUP BY with computed metrics (count, avg_duration, error_rate, p95, tokens, cost)
- `count(params)` -- Simplified groupBy count
- `getCostBreakdown(tenantId, projectId, timeRange)` -- LLM cost by model/provider
- `getSessionMetrics(tenantId, projectId, timeRange)` -- Session completion metrics
- `getEventCounts(tenantId, projectId, timeRange)` -- Category-grouped counts

### Key Files

| File                                                            | Purpose                       |
| --------------------------------------------------------------- | ----------------------------- |
| `apps/runtime/src/routes/analytics.ts`                          | Analytics API (9 endpoints)   |
| `apps/runtime/src/routes/insights.ts`                           | Insights API (2 endpoints)    |
| `apps/runtime/src/routes/nl-analytics.ts`                       | NL analytics API (1 endpoint) |
| `apps/runtime/src/services/eventstore-singleton.ts`             | Lazy EventStore singleton     |
| `packages/eventstore/src/query/event-query-service.ts`          | Query service implementation  |
| `packages/eventstore/src/interfaces/types.ts`                   | Shared query/aggregate types  |
| `apps/studio/src/components/analytics/AnalyticsPage.tsx`        | Main analytics UI             |
| `apps/studio/src/components/insights/InsightsDashboardPage.tsx` | Insights UI                   |

### Known Gaps

| ID    | Description                                                                         | Severity |
| ----- | ----------------------------------------------------------------------------------- | -------- |
| GAP-1 | SQL validation uses regex, not a proper SQL parser; may miss edge cases             | Medium   |
| GAP-2 | No caching layer; every request hits ClickHouse                                     | Medium   |
| GAP-3 | NLQueryService availability not guaranteed (pipeline-engine dependency)             | Medium   |
| GAP-4 | Insights mock-data.ts exists, suggesting some Studio charts may still use mock data | Low      |
| GAP-5 | No test coverage for SQL validation logic                                           | High     |
| GAP-6 | No E2E tests for any analytics endpoint                                             | High     |
