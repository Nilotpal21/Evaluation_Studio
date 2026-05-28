# Test Specification: Analytics Insights Dashboard

**Feature Spec**: `docs/features/analytics-insights-dashboard.md`
**HLD**: `docs/specs/analytics-insights-dashboard.hld.md`
**Status**: PLANNED
**Last Updated**: 2026-03-23

---

## 1. Coverage Matrix

| FR    | Description                               | Unit | Integration | E2E | Status  |
| ----- | ----------------------------------------- | ---- | ----------- | --- | ------- |
| FR-1  | 6 KPI cards with trend indicators         | --   | --          | --  | PLANNED |
| FR-2  | Multi-metric trend chart                  | --   | --          | --  | PLANNED |
| FR-3  | Anomaly annotations on trend chart        | --   | --          | --  | PLANNED |
| FR-4  | Pipeline health scorecard                 | --   | --          | --  | PLANNED |
| FR-5  | Date range selection (7d/30d/90d)         | --   | --          | --  | PLANNED |
| FR-6  | Agent metrics sortable table              | --   | --          | --  | PLANNED |
| FR-7  | Column sorting (asc/desc)                 | --   | --          | --  | PLANNED |
| FR-8  | Agent drill-down detail view              | --   | --          | --  | PLANNED |
| FR-9  | Agent comparison chart (up to 3)          | --   | --          | --  | PLANNED |
| FR-10 | Quality score distribution chart          | --   | --          | --  | PLANNED |
| FR-11 | Hallucination rate trend chart            | --   | --          | --  | PLANNED |
| FR-12 | Guardrail trigger rates by type           | --   | --          | --  | PLANNED |
| FR-13 | Knowledge gap topics ranked               | --   | --          | --  | PLANNED |
| FR-14 | Context preservation score trend          | --   | --          | --  | PLANNED |
| FR-15 | Sentiment trend chart (pos/neutral/neg)   | --   | --          | --  | PLANNED |
| FR-16 | Intent distribution chart                 | --   | --          | --  | PLANNED |
| FR-17 | Friction highlights table with drill-down | --   | --          | --  | PLANNED |
| FR-18 | Churn risk summary (high/medium/low)      | --   | --          | --  | PLANNED |
| FR-19 | Loading skeletons and empty states        | --   | --          | --  | PLANNED |
| FR-20 | Error banners on API failure              | --   | --          | --  | PLANNED |
| FR-21 | i18n for all user-facing strings          | --   | --          | --  | PLANNED |

### Existing Coverage (Pre-Feature)

The following existing tests are relevant but insufficient for the new feature:

- `apps/runtime/src/routes/__tests__/pipeline-analytics.test.ts` — Tests the pipeline-analytics API route handlers (GET summary, breakdown, conversations). These validate the backend data layer but not the Studio UI.
- `packages/pipeline-engine/src/__tests__/analytics-cache.test.ts` — Tests AnalyticsCache get/set/invalidate operations.
- `apps/studio/src/components/insights/` — No existing tests for `InsightsDashboardPage`.
- `apps/studio/src/hooks/` — No existing tests for `useInsightsDashboard`, `useAnalytics`, or `useAnalyticsQuery`.

---

## 2. Unit Tests

### UT-1: Executive Dashboard KPI Rendering

**FR**: FR-1
**Description**: Verify that the executive dashboard renders 6 KPI cards with correct values and trend indicators from mock hook data.
**Location**: `apps/studio/src/components/insights/__tests__/InsightsDashboardPage.test.tsx`
**Approach**: Render `InsightsDashboardPage` with a mocked `useInsightsDashboard` hook returning known summary data. Assert 6 metric cards present with expected values and trend direction icons.

### UT-2: Multi-Metric Trend Chart Renders

**FR**: FR-2
**Description**: Verify the trend chart renders with Recharts AreaChart and supports metric selection.
**Location**: `apps/studio/src/components/insights/__tests__/InsightsDashboardPage.test.tsx`
**Approach**: Render with mock trend data containing 7 data points. Assert Recharts `AreaChart` SVG is rendered. Assert metric toggle buttons are present.

### UT-3: Anomaly Annotations Display

**FR**: FR-3
**Description**: Verify anomaly markers appear on the trend chart at the correct data points.
**Location**: `apps/studio/src/components/insights/__tests__/InsightsDashboardPage.test.tsx`
**Approach**: Provide mock trend data with 2 anomaly points. Assert custom dot markers are rendered at anomaly indices.

### UT-4: Pipeline Health Scorecard

**FR**: FR-4
**Description**: Verify pipeline health scorecard renders a row for each pipeline type with status, last run, and record count.
**Location**: `apps/studio/src/components/insights/__tests__/InsightsDashboardPage.test.tsx`
**Approach**: Mock pipeline health data for 10 pipeline types. Assert 10 rows with correct labels and status badges.

### UT-5: Date Range Selection

**FR**: FR-5
**Description**: Verify date range dropdown changes the hook parameter and triggers data refresh.
**Location**: `apps/studio/src/components/insights/__tests__/InsightsDashboardPage.test.tsx`
**Approach**: Render component, click dropdown, select "7d". Assert `useInsightsDashboard` is called with `'7d'` parameter.

### UT-6: Agent Performance Table Sort

**FR**: FR-6, FR-7
**Description**: Verify agent metrics table renders with correct columns and supports ascending/descending sort.
**Location**: `apps/studio/src/components/insights/__tests__/AgentPerformancePage.test.tsx`
**Approach**: Mock 5 agents with varying metrics. Click column headers. Assert row order changes correctly.

### UT-7: Agent Drill-Down Navigation

**FR**: FR-8
**Description**: Verify clicking an agent row shows the agent detail view with trend charts.
**Location**: `apps/studio/src/components/insights/__tests__/AgentPerformancePage.test.tsx`
**Approach**: Mock agent data. Click agent row. Assert detail panel appears with agent name and trend chart.

### UT-8: Agent Comparison Chart

**FR**: FR-9
**Description**: Verify comparison mode allows selecting up to 3 agents and renders a comparison chart.
**Location**: `apps/studio/src/components/insights/__tests__/AgentPerformancePage.test.tsx`
**Approach**: Mock 5 agents. Select 3 via checkboxes. Assert comparison chart renders with 3 lines. Attempt to select 4th — assert rejected.

### UT-9: Quality Monitor Widgets

**FR**: FR-10, FR-11, FR-12, FR-13, FR-14
**Description**: Verify Quality Monitor page renders all 5 quality-related widgets.
**Location**: `apps/studio/src/components/insights/__tests__/QualityMonitorPage.test.tsx`
**Approach**: Mock pipeline-analytics summary data for quality_evaluation, hallucination_detection, guardrail_analysis, knowledge_gap, and context_preservation. Assert each widget renders with a chart or data table.

### UT-10: Customer Insights Widgets

**FR**: FR-15, FR-16, FR-17, FR-18
**Description**: Verify Customer Insights page renders sentiment, intent, friction, and churn widgets.
**Location**: `apps/studio/src/components/insights/__tests__/CustomerInsightsPage.test.tsx`
**Approach**: Mock pipeline-analytics data for sentiment_analysis, intent_classification, friction_detection, and predictive features. Assert 4 widgets render.

### UT-11: Loading Skeletons

**FR**: FR-19
**Description**: Verify all 4 pages show skeleton loaders while data is loading.
**Location**: `apps/studio/src/components/insights/__tests__/loading-states.test.tsx`
**Approach**: Mock hooks to return `isLoading: true`. Assert Skeleton components are rendered. Assert no data content is shown.

### UT-12: Error Banners

**FR**: FR-20
**Description**: Verify API error states are displayed as user-visible banners.
**Location**: `apps/studio/src/components/insights/__tests__/error-states.test.tsx`
**Approach**: Mock hooks to return error strings. Assert error banner divs are visible with error messages.

### UT-13: Empty States

**FR**: FR-19
**Description**: Verify contextual empty states appear when no data is available.
**Location**: `apps/studio/src/components/insights/__tests__/empty-states.test.tsx`
**Approach**: Mock hooks to return empty arrays/null summaries with `isLoading: false`. Assert empty state messages are displayed.

### UT-14: i18n Key Coverage

**FR**: FR-21
**Description**: Verify all user-facing strings use i18n keys from the `insights` namespace.
**Location**: `apps/studio/src/components/insights/__tests__/i18n-coverage.test.tsx`
**Approach**: Render each page with `next-intl` mock. Collect all `t()` calls. Assert no hardcoded English strings remain.

### UT-15: usePipelineAnalytics Hook

**FR**: FR-1, FR-4
**Description**: Verify the new `usePipelineAnalytics` hook correctly constructs SWR keys and maps response data.
**Location**: `apps/studio/src/hooks/__tests__/usePipelineAnalytics.test.ts`
**Approach**: Mock SWR. Call hook with various pipeline types and date ranges. Assert correct URL construction and data mapping.

---

## 3. Integration Tests

### IT-1: Pipeline Analytics API — Summary Endpoint

**FR**: FR-1, FR-4
**Description**: Verify the pipeline-analytics summary endpoint returns correct shape with tenant/project isolation.
**Location**: `apps/runtime/src/routes/__tests__/pipeline-analytics-summary.integration.test.ts`
**Approach**: Start Express server with real auth middleware. Seed ClickHouse with test data for multiple tenants. Call `GET /api/projects/:projectId/pipeline-analytics/sentiment_analysis/summary`. Assert tenant isolation (cannot see other tenant's data). Assert response shape matches `{ success, data: { count, avg*, min*, max* } }`.

### IT-2: Pipeline Analytics API — Breakdown Endpoint

**FR**: FR-6, FR-10, FR-15
**Description**: Verify breakdown by agent and channel dimensions returns correct aggregations.
**Location**: `apps/runtime/src/routes/__tests__/pipeline-analytics-breakdown.integration.test.ts`
**Approach**: Seed ClickHouse with data across 3 agents and 2 channels. Call `GET /:pipelineType/breakdown?dimension=agent_name`. Assert correct per-agent aggregations. Verify `dimension=channel` groups by channel.

### IT-3: Pipeline Analytics API — Conversations Endpoint

**FR**: FR-17
**Description**: Verify conversations list endpoint with score filters returns paginated results.
**Location**: `apps/runtime/src/routes/__tests__/pipeline-analytics-conversations.integration.test.ts`
**Approach**: Seed 20 session records with varying scores. Call `GET /:pipelineType/conversations?minScore=0.5&limit=10`. Assert pagination (10 results, `hasMore: true`). Assert all returned scores >= 0.5.

### IT-4: Pipeline Analytics API — All 10 Pipeline Types

**FR**: FR-4
**Description**: Verify all 10 pipeline types are queryable and return valid responses (even if empty).
**Location**: `apps/runtime/src/routes/__tests__/pipeline-analytics-all-types.integration.test.ts`
**Approach**: Iterate `VALID_PIPELINE_TYPES` set. Call summary endpoint for each type. Assert HTTP 200 with `{ success: true }` for all 10.

### IT-5: Analytics Cache Integration

**FR**: NFR-1
**Description**: Verify AnalyticsCache reduces ClickHouse query load on repeated requests.
**Location**: `packages/pipeline-engine/src/__tests__/analytics-cache.integration.test.ts`
**Approach**: Create AnalyticsCache with real Redis client. Set a value. Get it. Assert cache hit. Wait for TTL expiry. Assert cache miss.

### IT-6: Studio Proxy — Analytics Passthrough

**FR**: FR-1, FR-6, FR-10, FR-15
**Description**: Verify Studio proxy route correctly forwards analytics requests to runtime with auth headers.
**Location**: `apps/studio/src/app/api/runtime/__tests__/analytics-proxy.integration.test.ts`
**Approach**: Start Studio API server. Mock runtime endpoint. Call Studio proxy URL. Assert request forwarded with correct auth headers and project ID.

### IT-7: Auth Middleware — Project Scope Enforcement

**FR**: NFR-4
**Description**: Verify analytics routes reject requests without valid project scope.
**Location**: `apps/runtime/src/routes/__tests__/pipeline-analytics-auth.integration.test.ts`
**Approach**: Call pipeline-analytics endpoint without auth token (expect 401). Call with wrong projectId (expect 404). Call with correct auth (expect 200).

---

## 4. E2E Tests

### E2E-1: Executive Dashboard Full Render

**FR**: FR-1, FR-2, FR-5
**Description**: Verify executive dashboard loads and displays KPI cards, trend chart, and pipeline scorecard with real data.
**Preconditions**: Running runtime with seeded ClickHouse analytics data.
**Steps**:

1. Authenticate as a project member
2. Navigate to the insights dashboard page
3. Assert 6 KPI cards are visible with numeric values
4. Assert trend chart SVG is rendered
5. Assert pipeline health scorecard shows at least 1 pipeline type
6. Switch date range to "7d" — assert KPI values update
   **Expected**: All visual elements render, data updates on date range change.

### E2E-2: Agent Performance Table

**FR**: FR-6, FR-7, FR-8
**Description**: Verify agent performance page shows sortable table and drill-down.
**Preconditions**: Running runtime with at least 2 agents having session data.
**Steps**:

1. Navigate to agent-performance page
2. Assert table with 2+ agent rows is visible
3. Click "Cost" column header — assert sort order changes
4. Click first agent row — assert detail panel appears with agent name
   **Expected**: Table renders with real agent data. Sort and drill-down work.

### E2E-3: Quality Monitor Widgets

**FR**: FR-10, FR-11, FR-12, FR-13, FR-14
**Description**: Verify quality monitor page loads all 5 quality widgets.
**Preconditions**: Running runtime with quality pipeline data seeded.
**Steps**:

1. Navigate to quality-monitor page
2. Assert quality score chart widget is visible
3. Assert hallucination rate widget is visible
4. Assert guardrail triggers widget is visible
5. Assert knowledge gap widget is visible
6. Assert context preservation widget is visible
   **Expected**: All 5 widgets render (with data or contextual empty states).

### E2E-4: Customer Insights Widgets

**FR**: FR-15, FR-16, FR-17, FR-18
**Description**: Verify customer insights page loads sentiment, intent, friction, and churn widgets.
**Preconditions**: Running runtime with sentiment, intent, and friction pipeline data.
**Steps**:

1. Navigate to customer-insights page
2. Assert sentiment trend chart is visible
3. Assert intent distribution chart is visible
4. Assert friction highlights table is visible (or empty state)
5. Assert churn risk summary is visible (or empty state)
   **Expected**: All 4 widgets render with appropriate data or empty states.

### E2E-5: Cross-Page Navigation

**FR**: FR-5
**Description**: Verify navigation between all 4 insight pages preserves date range selection.
**Steps**:

1. On executive dashboard, set date range to "90d"
2. Navigate to agent-performance — assert date range stays "90d"
3. Navigate to quality-monitor — assert date range stays "90d"
4. Navigate to customer-insights — assert date range stays "90d"
5. Navigate back to dashboard — assert date range stays "90d"
   **Expected**: Date range persists across page navigations.

### E2E-6: Empty State Handling

**FR**: FR-19
**Description**: Verify empty states render gracefully for a project with no pipeline data.
**Preconditions**: Create a new project with no sessions/pipeline runs.
**Steps**:

1. Navigate to insights dashboard for empty project
2. Assert KPI cards show zero values (not errors)
3. Assert trend chart shows empty state message
4. Assert pipeline scorecard shows "No data" or "Enable pipelines" CTA
   **Expected**: No crashes, graceful empty states throughout.

### E2E-7: Error Recovery

**FR**: FR-20
**Description**: Verify error banners appear on API failure and data recovers on retry.
**Preconditions**: Ability to simulate API failure (e.g., stop runtime mid-request).
**Steps**:

1. Navigate to insights dashboard
2. Simulate API failure (runtime returns 500)
3. Assert error banner is displayed
4. Restore API
5. Wait for SWR revalidation (30s) or trigger manual refresh
6. Assert error banner disappears and data loads
   **Expected**: Error state is visible and recoverable.

### E2E-8: Tenant Isolation

**FR**: NFR-4
**Description**: Verify one tenant cannot see another tenant's analytics data.
**Preconditions**: Two tenants with separate analytics data seeded.
**Steps**:

1. Authenticate as tenant A
2. Navigate to insights dashboard — note KPI values
3. Authenticate as tenant B
4. Navigate to insights dashboard — assert different KPI values
5. Attempt to query tenant A's project ID via API — assert 404
   **Expected**: Complete tenant data isolation.

### E2E-9: Friction Drill-Down to Session

**FR**: FR-17
**Description**: Verify clicking a friction highlight row navigates to the session detail page.
**Preconditions**: At least 1 session with high friction score.
**Steps**:

1. Navigate to customer-insights page
2. Find friction highlights table
3. Click on a session row
4. Assert navigation to session detail page with correct session ID
   **Expected**: Drill-down navigates to the correct session.

### E2E-10: Performance — Dashboard Load Time

**FR**: NFR-1, NFR-2
**Description**: Verify dashboard first meaningful paint within 2 seconds.
**Steps**:

1. Clear browser cache
2. Navigate to insights dashboard
3. Measure time until KPI cards show numeric values (not skeleton loaders)
4. Assert <2 seconds
   **Expected**: Performance SLA met under normal data load conditions.

---

## 5. Performance Tests

### PT-1: Large Dataset Dashboard Load

**Description**: Measure dashboard load time with 90 days of analytics data (~1M events).
**Approach**: Seed ClickHouse with 1M events spread across 90 days. Load executive dashboard with 90d range. Measure API response times and render time.
**Pass Criteria**: API response <1s, render <500ms, total <2s.

### PT-2: Agent Performance Table with Many Agents

**Description**: Verify agent performance table handles 50+ agents without performance degradation.
**Approach**: Seed data for 100 agents. Load agent performance page. Measure table render time and sort operation time.
**Pass Criteria**: Initial render <1s, sort operation <200ms.

---

## 6. Accessibility Tests

### A11Y-1: Keyboard Navigation

**Description**: Verify all dashboard interactive elements (date range dropdown, table sorting, drill-down, comparison checkboxes) are keyboard-accessible.
**Pass Criteria**: Tab order follows visual layout. Enter/Space activates controls. Esc closes dropdowns.

### A11Y-2: Screen Reader Compatibility

**Description**: Verify chart data is accessible via ARIA labels or tabular alternatives.
**Pass Criteria**: Each chart has a descriptive `aria-label`. KPI cards have semantic heading structure.

---

## 7. Test Data Requirements

| Dataset                   | Source                              | Volume                       | Notes                                |
| ------------------------- | ----------------------------------- | ---------------------------- | ------------------------------------ |
| Session events            | ClickHouse `platform_events`        | 500+ sessions across 30 days | Spread across 3+ agents, 2+ channels |
| Sentiment pipeline output | ClickHouse `conversation_sentiment` | 200+ records                 | Mix of positive/neutral/negative     |
| Intent pipeline output    | ClickHouse `intent_classifications` | 200+ records                 | 5+ distinct intent categories        |
| Quality pipeline output   | ClickHouse `quality_evaluations`    | 200+ records                 | Scores ranging 0.2–0.95              |
| Friction pipeline output  | ClickHouse `friction_detections`    | 50+ records                  | Mix of high/low friction scores      |
| Anomaly pipeline output   | ClickHouse `anomaly_detections`     | 10+ records                  | At least 2 anomaly flags             |
| LLM cost data             | ClickHouse MV `llm_cost_hourly_mv`  | 200+ hourly buckets          | Multiple models and providers        |

---

## 8. Test Environment Requirements

- **Runtime**: Express server on random port with full middleware chain (auth, rate limiting, project scope)
- **ClickHouse**: Test instance with seeded analytics tables (can use `init-analytics-tables.ts` DDL)
- **Redis**: Test instance for AnalyticsCache
- **Studio**: Next.js dev server for E2E UI tests
- **Auth**: Test JWT tokens with valid tenant/project context
