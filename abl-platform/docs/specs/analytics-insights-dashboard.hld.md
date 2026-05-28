# HLD: Analytics Insights Dashboard

**Feature Spec**: `docs/features/analytics-insights-dashboard.md`
**Test Spec**: `docs/testing/analytics-insights-dashboard.md`
**Status**: APPROVED
**Author**: Platform team
**Date**: 2026-03-23

---

## 1. Problem Statement

The ABL platform computes rich analytics via 10 pipeline types (sentiment, intent, quality, hallucination, knowledge-gap, guardrail, context-preservation, friction, anomaly, drift) and stores results in dedicated ClickHouse tables with materialized views for aggregation. The runtime exposes a full pipeline-analytics API at `/api/projects/:projectId/pipeline-analytics/:pipelineType/summary|breakdown|conversations|conversation/:sid`. However, the Studio UI surfaces only a fraction of this data: the InsightsDashboardPage shows 5 basic KPI cards, and three insight sub-pages (agent-performance, quality-monitor, customer-insights) are "Coming Soon" stubs. Users cannot access sentiment trends, quality scores, anomaly alerts, friction signals, or intent distributions from the UI.

This HLD designs the frontend architecture to surface all pipeline analytics data across 4 interconnected pages, using existing backend APIs with no new runtime endpoints.

---

## 2. Alternatives Considered

### Option A: Extend Existing InsightsDashboardPage (Selected)

- **Description**: Enhance the existing InsightsDashboardPage with additional widgets (anomaly annotations, pipeline health scorecard, multi-metric trends) and implement the 3 stub pages (AgentPerformancePage, QualityMonitorPage, CustomerInsightsPage) as new components. All data fetched via existing SWR + proxy pattern using the pipeline-analytics API and analytics API.
- **Pros**: Follows the established Studio pattern (SWR hooks, `apiFetch`, proxy routes). Minimal infrastructure changes. Incremental enhancement of existing pages. All backend APIs already exist.
- **Cons**: The existing `useInsightsDashboard` hook fetches from `/api/runtime/analytics` which proxies to the legacy analytics endpoints, not the pipeline-analytics endpoints. New hooks needed for pipeline-specific data.
- **Effort**: M (Medium)

### Option B: New Standalone Dashboard App

- **Description**: Build a separate analytics dashboard application (e.g., using Grafana, Metabase, or a custom SPA) that connects directly to ClickHouse.
- **Pros**: Purpose-built analytics tooling. Decoupled from Studio release cycle.
- **Cons**: Fragments the user experience — users must switch between Studio and a separate app. Duplicates auth, navigation, and design system. ClickHouse direct access bypasses tenant isolation middleware. Significant new infrastructure.
- **Effort**: XL (Extra Large)

### Option C: Embed Grafana Dashboards

- **Description**: Create Grafana dashboards for each analytics page and embed them in Studio via iframes with auth token forwarding.
- **Pros**: Grafana has excellent charting. Team may already have Grafana dashboards for ops.
- **Cons**: iframe embedding has CORS, auth, and theming challenges. Grafana's look-and-feel doesn't match Studio's design system. Tenant isolation must be enforced at the Grafana datasource level. Users lose Studio's interactive features (drill-down to session, agent comparison).
- **Effort**: L (Large)

### Decision: Option A

Option A is the clear choice because it uses the existing infrastructure (SWR, proxy, pipeline-analytics API, auth middleware), maintains design system consistency, and avoids new infrastructure dependencies. The pipeline-analytics API already provides all the data endpoints needed.

---

## 3. Architecture Overview

### Data Flow

```
ClickHouse (analytics tables + MVs)
    |
    | (SQL queries)
    v
Runtime pipeline-analytics API
  /api/projects/:projectId/pipeline-analytics/:type/summary|breakdown|conversations
    |
    | AnalyticsCache (Redis, fail-open, 5-min TTL)
    |
    | (HTTP/JSON)
    v
Studio Next.js Proxy
  /api/runtime/analytics?projectId=...&endpoint=pipeline-analytics-summary&pipelineType=...
  (OR direct proxy via middleware for /api/projects/:projectId/pipeline-analytics/*)
    |
    | (HTTP/JSON)
    v
SWR Hooks (usePipelineAnalytics, useInsightsDashboard)
    |
    | (React state)
    v
Page Components (InsightsDashboardPage, AgentPerformancePage, QualityMonitorPage, CustomerInsightsPage)
    |
    | (Recharts)
    v
Browser (rendered charts, tables, KPI cards)
```

### Component Hierarchy

```
InsightsGroup (navigation group, already exists in navigation.ts)
├── InsightsDashboardPage (enhanced, replaces current)
│   ├── KPICardRow (6 cards)
│   ├── MultiMetricTrendChart (Recharts AreaChart with metric selector)
│   │   └── AnomalyAnnotation (custom Recharts dot)
│   ├── PipelineHealthScorecard (10-row status table)
│   └── DateRangeSelector (existing DropdownMenu pattern)
├── AgentPerformancePage (new, replaces ComingSoonPage)
│   ├── AgentMetricsTable (sortable)
│   ├── AgentDetailPanel (expandable/slide-out)
│   │   └── AgentTrendChart
│   └── AgentComparisonChart (up to 3 agents)
├── QualityMonitorPage (new, replaces ComingSoonPage)
│   ├── QualityScoreWidget (quality_evaluation)
│   ├── HallucinationWidget (hallucination_detection)
│   ├── GuardrailWidget (guardrail_analysis)
│   ├── KnowledgeGapWidget (knowledge_gap)
│   └── ContextPreservationWidget (context_preservation)
└── CustomerInsightsPage (new, replaces ComingSoonPage)
    ├── SentimentTrendWidget (sentiment_analysis)
    ├── IntentDistributionWidget (intent_classification)
    ├── FrictionHighlightsWidget (friction_detection)
    └── ChurnRiskWidget (predictive features)
```

---

## 4. Twelve Architectural Concerns

### 4.1 Tenant Isolation

All analytics queries are scoped by `tenantId` and `projectId`. This is enforced at two layers:

1. **Runtime middleware**: `authMiddleware` + `requireProjectScope('projectId')` on all pipeline-analytics routes (see `apps/runtime/src/routes/pipeline-analytics.ts` lines 53-55)
2. **ClickHouse queries**: Every SQL query includes `WHERE tenant_id = {tenantId:String} AND project_id = {projectId:String}`

The Studio proxy adds `X-Tenant-Id` header from the authenticated session. No new isolation mechanisms are needed.

### 4.2 Authentication & Authorization

- **Studio proxy**: `requireTenantAuth(request)` validates JWT token (see `apps/studio/src/app/api/runtime/analytics/route.ts` line 27)
- **Runtime**: `authMiddleware` validates token, `requireProjectPermission(req, res, 'session:read')` checks RBAC permission on every endpoint
- Permission `session:read` is required for all analytics endpoints — this is the existing pattern and is appropriate since analytics derive from session data

### 4.3 Data Model

No new data models. The feature reads from existing ClickHouse tables:

| Table                       | Pipeline Type           | Key Columns                                               |
| --------------------------- | ----------------------- | --------------------------------------------------------- |
| `conversation_sentiment`    | sentiment_analysis      | avg_sentiment, sentiment_trajectory, frustration_detected |
| `intent_classifications`    | intent_classification   | intent, confidence, top_intents                           |
| `quality_evaluations`       | quality_evaluation      | overall_score, helpfulness, accuracy                      |
| `hallucination_evaluations` | hallucination_detection | overall_score, severity                                   |
| `knowledge_gap_evaluations` | knowledge_gap           | gap_detected, topics                                      |
| `guardrail_evaluations`     | guardrail_analysis      | triggered, guardrail_type                                 |
| `context_evaluations`       | context_preservation    | context_score                                             |
| `friction_detections`       | friction_detection      | friction_score, friction_signals                          |
| `anomaly_detections`        | anomaly_detection       | metric, z_score, is_anomaly                               |
| `drift_detections`          | drift_detection         | metric, drift_score                                       |

Materialized views used for pre-aggregated data:

- `session_metrics_daily_mv` — daily session counts, duration, cost
- `llm_cost_hourly_mv` — hourly LLM cost by model/provider
- `mv_daily_sentiment` — daily sentiment aggregates
- `mv_daily_intent_distribution` — daily intent distribution
- `mv_daily_quality_scores` — daily quality score aggregates

### 4.4 API Design

No new API endpoints. The frontend consumes existing endpoints:

**Pipeline Analytics API** (runtime, per-pipeline type):

- `GET /api/projects/:projectId/pipeline-analytics/:pipelineType/summary?period=7d|30d|90d`
- `GET /api/projects/:projectId/pipeline-analytics/:pipelineType/breakdown?dimension=agent_name|channel&period=7d`
- `GET /api/projects/:projectId/pipeline-analytics/:pipelineType/conversations?minScore=0.5&limit=10`
- `GET /api/projects/:projectId/pipeline-analytics/:pipelineType/conversation/:sessionId`

**General Analytics API** (runtime):

- `GET /api/projects/:projectId/analytics/metrics?from=...&to=...&groupBy=...&metrics=...`
- `GET /api/projects/:projectId/analytics/session-metrics?from=...&to=...`
- `GET /api/projects/:projectId/analytics/cost-breakdown?from=...&to=...`

**Studio Proxy** (passes through to runtime):

- `GET /api/runtime/analytics?projectId=...&endpoint=...` — existing proxy route
- Pipeline-analytics routes are proxied via Studio middleware (`isRuntimeProxyPath` in `proxy.ts`) since they match `/api/projects/:projectId/pipeline-analytics/...` pattern

### 4.5 Caching

The `AnalyticsCache` in `packages/pipeline-engine/src/pipeline/services/analytics-cache.ts` provides a Redis-backed fail-open cache with per-query-type TTLs:

- summary: 300s (5 min)
- timeseries: 600s (10 min)
- breakdown: 300s (5 min)

This is already wired into the pipeline-analytics route handlers. No additional caching needed on the frontend — SWR's `keepPreviousData: true` with 30-second `refreshInterval` handles client-side staleness.

### 4.6 Performance

- **Lazy loading**: All chart-heavy page components loaded via `next/dynamic` with `ssr: false` to avoid Recharts bundle in initial page load (pattern from `AnalyticsPage.tsx`)
- **Pre-aggregated data**: Materialized views (daily_sentiment, daily_intent, daily_quality, session_metrics_daily, llm_cost_hourly) eliminate real-time aggregation for the most common queries
- **Query timeouts**: ClickHouse queries have 30-second timeouts (from NL query service pattern; pipeline-analytics uses similar defaults)
- **Minimal re-renders**: SWR `keepPreviousData: true` prevents layout shifts during revalidation

### 4.7 Error Handling

- **API errors**: Each hook returns `error: string | null`. Pages render error banners when error is present.
- **Partial data**: If one pipeline-analytics call fails but others succeed, the page shows data for successful pipelines and an error state for the failed widget (widget-level error isolation, not page-level failure).
- **Cache failures**: AnalyticsCache is fail-open — Redis errors never block the query, they fall through to ClickHouse.
- **Missing pipeline data**: Empty pipeline responses show contextual empty states ("No sentiment data. Configure the sentiment pipeline to start collecting data.") rather than generic errors.

### 4.8 Observability

- **Logging**: Each hook logs SWR fetch errors via the existing SWR error handler. The runtime pipeline-analytics route already logs query execution time and errors via `createLogger('pipeline-analytics-route')`.
- **Metrics**: ClickHouse query execution time is tracked by the AnalyticsCache (logged on set/get). SWR fetch timing is visible in browser dev tools.
- **No new trace events**: This feature only reads existing data — no new writes to ClickHouse or MongoDB.

### 4.9 Scalability

- **Data volume**: ClickHouse handles billions of rows with sub-second query times for aggregations. The materialized views pre-aggregate daily data, reducing query scope. The 90-day maximum date range limits scan depth.
- **Concurrent users**: Each page makes 3-6 SWR requests. With 30-second polling, a project with 10 concurrent users generates ~12-36 requests/minute. The AnalyticsCache absorbs repeated queries within the 5-minute TTL window, so ClickHouse sees at most 1 query per 5 minutes per unique parameter combination.
- **No state accumulation**: Pure read-only pages with no client-side state that grows over time.

### 4.10 Security

- **No new attack surface**: All data access goes through existing auth middleware (JWT validation + RBAC + project scope).
- **No PII in analytics**: Pipeline analytics tables contain aggregate scores, counts, and trends — not raw conversation text. Session IDs are references, not PII.
- **SQL injection prevention**: All ClickHouse queries use parameterized queries (`{tenantId:String}` syntax).

### 4.11 Backwards Compatibility

- **InsightsDashboardPage**: Enhanced in-place. The component is replaced, but it occupies the same navigation slot ('dashboard' in insights group). Users navigating to "Insights > Dashboard" will see the enhanced version.
- **ComingSoonPage stubs**: Replaced with real pages. No external API contract changes since these were pure UI placeholders.
- **Existing hooks**: `useInsightsDashboard` is preserved and extended. New hooks (`usePipelineAnalytics`) are additive.
- **URL stability**: All page routes remain the same (no URL changes for dashboard, agent-performance, quality-monitor, customer-insights).

### 4.12 Testing Strategy

See `docs/testing/analytics-insights-dashboard.md` for the full test specification.

- **15 unit tests**: Component rendering, sorting, drill-down, empty/error/loading states, i18n
- **7 integration tests**: API endpoint validation, cache integration, proxy passthrough, auth enforcement
- **10 E2E tests**: Full page renders, cross-page navigation, tenant isolation, performance

---

## 5. New SWR Hooks

### usePipelineAnalytics

New hook for fetching pipeline-specific analytics data via the existing pipeline-analytics API.

```typescript
// apps/studio/src/hooks/usePipelineAnalytics.ts

interface PipelineAnalyticsOptions {
  pipelineType: string;
  queryType: 'summary' | 'breakdown' | 'conversations';
  period?: string; // '7d' | '30d' | '90d'
  dimension?: string; // 'agent_name' | 'channel' (for breakdown)
  minScore?: number; // for conversations filter
  limit?: number; // for conversations pagination
}

function usePipelineAnalytics(projectId: string | null, options: PipelineAnalyticsOptions) {
  // Builds URL: /api/projects/:projectId/pipeline-analytics/:pipelineType/:queryType?period=...
  // Uses SWR with 30-second refresh, keepPreviousData: true
  // Returns { data, isLoading, error }
}
```

### usePipelineHealth

New hook aggregating summary data from all 10 pipeline types for the scorecard widget.

```typescript
// apps/studio/src/hooks/usePipelineHealth.ts

interface PipelineHealthRow {
  pipelineType: string;
  label: string;
  totalRecords: number;
  lastProcessedAt: string | null;
  status: 'active' | 'no-data';
}

function usePipelineHealth(projectId: string | null, period: string) {
  // Fetches summary for all 10 pipeline types in parallel (SWR multiplexing)
  // Returns { pipelines: PipelineHealthRow[], isLoading, error }
}
```

---

## 6. Shared Date Range State

Date range selection persists across all 4 insight pages. This is achieved via a lightweight Zustand store (not persisted to localStorage — session-only):

```typescript
// apps/studio/src/store/insights-store.ts

interface InsightsStore {
  dateRange: '7d' | '30d' | '90d';
  setDateRange: (range: '7d' | '30d' | '90d') => void;
}
```

Each page reads `dateRange` from the store and passes it to the SWR hooks. The `DateRangeSelector` component updates the store on selection change.

---

## 7. Widget Component Pattern

All analytics widgets follow a consistent pattern for loading/error/empty states:

```typescript
interface AnalyticsWidgetProps {
  title: string;
  children: React.ReactNode;
  isLoading: boolean;
  error: string | null;
  isEmpty: boolean;
  emptyMessage?: string;
}

function AnalyticsWidget({
  title,
  children,
  isLoading,
  error,
  isEmpty,
  emptyMessage,
}: AnalyticsWidgetProps) {
  // Renders:
  // - Skeleton loader when isLoading
  // - Error banner when error is present
  // - Empty state message when isEmpty
  // - children (chart/table) when data is available
}
```

---

## 8. Bundle Size Strategy

Recharts is ~80KB gzipped. The feature adds multiple chart types across 4 pages. Strategy:

1. Each page component is lazy-loaded via `next/dynamic({ ssr: false })` — only loaded when navigated to
2. Recharts is tree-shaken (only `AreaChart`, `BarChart`, `PieChart`, `Tooltip`, `ResponsiveContainer`, `XAxis`, `YAxis`, `CartesianGrid` are imported)
3. The executive dashboard page loads first (highest traffic) and subsequent pages load on navigation

Estimated bundle impact: ~15KB additional gzipped per page (chart configs + data transforms). Total: ~60KB additional across all 4 pages, but only one page is loaded at a time.

---

## 9. i18n Namespace Extension

The existing `insights` i18n namespace is extended with keys for:

- New KPI card labels (quality_score, sentiment_score, error_rate)
- Widget titles (quality_overview, hallucination_rate, guardrail_triggers, etc.)
- Table column headers (agent_name, conversations, avg_quality, etc.)
- Empty state messages per pipeline type
- Error messages

All keys follow the existing pattern: `insights.<section>.<key>`.
