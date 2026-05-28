# LLD: Analytics Insights Dashboard

**Feature Spec**: `docs/features/analytics-insights-dashboard.md`
**HLD**: `docs/specs/analytics-insights-dashboard.hld.md`
**Test Spec**: `docs/testing/analytics-insights-dashboard.md`
**Status**: PLANNED
**Date**: 2026-03-23

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                             | Rationale                                                                                                                                                                           | Alternatives Rejected                                                                   |
| --- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| D-1 | Phase order: proxy → store → hooks → widgets → pages → i18n → tests  | Bottom-up: each layer depends on the previous                                                                                                                                       | Top-down (pages first) — blocked on missing hooks                                       |
| D-2 | Add `pipeline-analytics` to `RUNTIME_PROJECT_SUBPATH_RE` in proxy.ts | The regex currently only includes `deployments\|channels\|channel-connections\|env-vars\|voice-analytics\|pipeline-config`. Pipeline-analytics requests would 404 at Studio layer.  | Create a new dedicated Studio API route for pipeline-analytics — duplicates proxy logic |
| D-3 | New `usePipelineAnalytics` hook (not extending `useAnalytics`)       | Pipeline-analytics API has different URL pattern (`/:pipelineType/:queryType`) than the general analytics API (`/analytics/:endpoint`). Mixing them in one hook would be confusing. | Extend `useAnalytics` with a `pipelineType` parameter — muddy abstraction               |
| D-4 | Zustand `insights-store.ts` for shared date range                    | Date range must persist across 4 pages in the same navigation group. URL query params would be lost on page switch (client-side navigation via `navigate()`).                       | URL search params — lost on client nav. Props — no shared parent.                       |
| D-5 | `AnalyticsWidget` wrapper for loading/error/empty                    | 15+ widgets across 4 pages. Without a shared wrapper, each widget duplicates skeleton/error/empty logic.                                                                            | Inline per widget — DRY violation, inconsistent states                                  |
| D-6 | Lazy-load page components via `next/dynamic`                         | Recharts is ~80KB gzipped. Loading all 4 pages eagerly would add ~60KB to initial bundle.                                                                                           | Eager import — unnecessary bundle bloat                                                 |
| D-7 | Agent detail as expandable panel (not separate page)                 | Keeps the agent table context visible. Users can compare agents visually while viewing detail.                                                                                      | Separate page — loses context, adds router complexity                                   |
| D-8 | Shared `DateRangeSelector` component                                 | Used identically on all 4 pages. Extract once to avoid duplication.                                                                                                                 | Inline per page — code duplication                                                      |

### Key Interfaces & Types

```typescript
// === Store: insights-store.ts ===
type DateRange = '7d' | '30d' | '90d';

interface InsightsStore {
  dateRange: DateRange;
  setDateRange: (range: DateRange) => void;
  selectedAgents: string[]; // for agent comparison (max 3)
  toggleAgent: (agentName: string) => void;
  clearSelectedAgents: () => void;
}

// === Hook: usePipelineAnalytics.ts ===
interface PipelineAnalyticsOptions {
  pipelineType: string;
  queryType: 'summary' | 'breakdown' | 'conversations';
  period?: string;
  dimension?: string;
  minScore?: number;
  limit?: number;
}

interface PipelineAnalyticsResult<T = Record<string, unknown>> {
  data: T | null;
  isLoading: boolean;
  error: string | null;
}

// === Hook: usePipelineHealth.ts ===
interface PipelineHealthRow {
  pipelineType: string;
  label: string;
  totalRecords: number;
  status: 'active' | 'no-data';
}

interface PipelineHealthResult {
  pipelines: PipelineHealthRow[];
  isLoading: boolean;
  error: string | null;
}

// === Component: AnalyticsWidget ===
interface AnalyticsWidgetProps {
  title: string;
  description?: string;
  children: React.ReactNode;
  isLoading: boolean;
  error: string | null;
  isEmpty: boolean;
  emptyMessage?: string;
  className?: string;
}
```

---

## 2. Implementation Phases

### Phase 1: Proxy & Store Foundation

**Goal**: Enable Studio to proxy pipeline-analytics requests and create shared state.

**Changes**:

1. **`apps/studio/src/proxy.ts`** — Add `pipeline-analytics` to `RUNTIME_PROJECT_SUBPATH_RE`:

   ```typescript
   const RUNTIME_PROJECT_SUBPATH_RE =
     /^\/api\/projects\/[^/]+\/(deployments|channels|channel-connections|env-vars|voice-analytics|pipeline-config|pipeline-analytics|analytics|nl-analytics|alerts|custom-events|tags)(\/|$)/;
   ```

   Also add `analytics`, `nl-analytics`, `alerts`, `custom-events`, and `tags` since these runtime routes should be proxied directly (they currently go through the legacy `/api/runtime/analytics` proxy).

2. **`apps/studio/src/store/insights-store.ts`** — New Zustand store:
   ```typescript
   export const useInsightsStore = create<InsightsStore>((set) => ({
     dateRange: '30d',
     setDateRange: (dateRange) => set({ dateRange }),
     selectedAgents: [],
     toggleAgent: (agentName) =>
       set((state) => {
         const selected = state.selectedAgents;
         if (selected.includes(agentName)) {
           return { selectedAgents: selected.filter((n) => n !== agentName) };
         }
         if (selected.length >= 3) return state; // max 3
         return { selectedAgents: [...selected, agentName] };
       }),
     clearSelectedAgents: () => set({ selectedAgents: [] }),
   }));
   ```

**Exit Criteria**:

- Pipeline-analytics requests from Studio browser reach the runtime and return 200
- `useInsightsStore` correctly manages date range and selected agents

**Files Created/Modified**:

- Modified: `apps/studio/src/proxy.ts`
- Created: `apps/studio/src/store/insights-store.ts`

---

### Phase 2: SWR Hooks

**Goal**: Create data fetching hooks for pipeline analytics.

**Changes**:

1. **`apps/studio/src/hooks/usePipelineAnalytics.ts`** — New SWR hook:
   - Builds URL: `/api/projects/${projectId}/pipeline-analytics/${pipelineType}/${queryType}?period=${period}`
   - Uses `apiFetch` from `lib/api-client` as the SWR fetcher
   - SWR options: `refreshInterval: 30_000`, `keepPreviousData: true`, `revalidateOnFocus: false`
   - Returns `{ data, isLoading, error }`

2. **`apps/studio/src/hooks/usePipelineHealth.ts`** — New hook aggregating 10 pipeline summaries:
   - Uses `useSWR` with a composite key that encodes all 10 pipeline types
   - Fetches summary for each pipeline type via the pipeline-analytics summary endpoint
   - Maps responses to `PipelineHealthRow[]`
   - Uses `Promise.allSettled` to handle individual pipeline failures gracefully

3. **Extend `apps/studio/src/hooks/useInsightsDashboard.ts`**:
   - Add `avgQualityScore`, `avgSentiment`, and `errorRate` to `InsightsSummary`
   - Fetch quality and sentiment summary data via `usePipelineAnalytics`
   - Compute error rate from session metrics data

**Exit Criteria**:

- `usePipelineAnalytics('sentiment_analysis', { queryType: 'summary', period: '30d' })` returns data
- `usePipelineHealth` returns 10 rows (some with `status: 'no-data'`)
- `useInsightsDashboard` returns extended summary with quality and sentiment

**Files Created/Modified**:

- Created: `apps/studio/src/hooks/usePipelineAnalytics.ts`
- Created: `apps/studio/src/hooks/usePipelineHealth.ts`
- Modified: `apps/studio/src/hooks/useInsightsDashboard.ts`

---

### Phase 3: Shared UI Components

**Goal**: Create reusable widgets and shared components for the insights pages.

**Changes**:

1. **`apps/studio/src/components/insights/AnalyticsWidget.tsx`** — Widget wrapper:
   - Renders loading skeleton (using existing `Skeleton` component)
   - Renders error banner (red border, error text)
   - Renders empty state (muted text, optional CTA)
   - Renders children when data is available
   - Consistent card styling: `bg-background-elevated rounded-xl border border-default p-6`

2. **`apps/studio/src/components/insights/DateRangeSelector.tsx`** — Shared date range dropdown:
   - Reads/writes from `useInsightsStore`
   - Uses existing `DropdownMenu` + `DropdownMenuItem` pattern from InsightsDashboardPage
   - i18n-aware labels

3. **`apps/studio/src/components/insights/KPICard.tsx`** — Enhanced KPI card:
   - Supports trend indicator (up/down/neutral)
   - Supports optional tooltip with detail text
   - Reuses the existing `MetricCard` pattern but extracts it to a shared file

4. **`apps/studio/src/components/insights/PipelineHealthScorecard.tsx`** — Scorecard table:
   - 10 rows, one per pipeline type
   - Columns: Pipeline Name, Status badge, Record Count, Last Updated
   - Uses `usePipelineHealth` hook

**Exit Criteria**:

- `AnalyticsWidget` renders skeleton/error/empty/data states correctly
- `DateRangeSelector` updates `useInsightsStore` on selection
- `PipelineHealthScorecard` renders 10 rows from hook data

**Files Created**:

- `apps/studio/src/components/insights/AnalyticsWidget.tsx`
- `apps/studio/src/components/insights/DateRangeSelector.tsx`
- `apps/studio/src/components/insights/KPICard.tsx`
- `apps/studio/src/components/insights/PipelineHealthScorecard.tsx`

---

### Phase 4: Executive Dashboard Enhancement

**Goal**: Enhance InsightsDashboardPage with multi-metric trend, anomaly annotations, and pipeline scorecard.

**Changes**:

1. **`apps/studio/src/components/insights/InsightsDashboardPage.tsx`** — Rewrite:
   - Replace 5 KPI cards with 6 KPICards (add Quality Score, Sentiment Score; replace one with Error Rate)
   - Replace single AreaChart with `MultiMetricTrendChart` (selectable metrics: conversations, cost, quality, sentiment)
   - Add `AnomalyAnnotation` custom Recharts dot for anomaly points on the trend
   - Add `PipelineHealthScorecard` section below the trend chart
   - Use `DateRangeSelector` component (reads from insights-store)
   - Remove inline `MetricCard` component (extracted to shared `KPICard`)

2. **`apps/studio/src/components/insights/MultiMetricTrendChart.tsx`** — New chart component:
   - Recharts `AreaChart` with up to 4 overlaid metrics
   - Metric toggle buttons (chip-style) to show/hide each metric
   - Custom dot component for anomaly annotations (red circle with tooltip)
   - Lazy-loaded via `next/dynamic`

**Exit Criteria**:

- Dashboard renders 6 KPI cards with data
- Multi-metric trend chart renders with at least 1 metric visible
- Anomaly dots appear at data points flagged by anomaly pipeline
- Pipeline health scorecard shows 10 rows

**Files Modified/Created**:

- Modified: `apps/studio/src/components/insights/InsightsDashboardPage.tsx`
- Created: `apps/studio/src/components/insights/MultiMetricTrendChart.tsx`

---

### Phase 5: Agent Performance Page

**Goal**: Replace ComingSoonPage with a real agent performance page.

**Changes**:

1. **`apps/studio/src/components/insights/AgentPerformancePage.tsx`** — New page component:
   - Uses `usePipelineAnalytics` with `queryType: 'breakdown'` and `dimension: 'agent_name'` for multiple pipeline types
   - Sortable table columns: Agent Name, Conversations, Avg Quality, Containment Rate, Avg Cost, Avg Sentiment, Error Rate
   - Sort state managed locally (useState)
   - Checkbox column for agent comparison (max 3, managed by insights-store)
   - Click row to expand `AgentDetailPanel`

2. **`apps/studio/src/components/insights/AgentDetailPanel.tsx`** — Expandable detail:
   - Shows agent name and key metrics
   - Trend chart (Recharts LineChart) for the selected agent's metrics over time
   - Uses `usePipelineAnalytics` with agent-specific filters

3. **`apps/studio/src/components/insights/AgentComparisonChart.tsx`** — Comparison view:
   - Renders when `selectedAgents.length > 0`
   - Recharts LineChart with one line per selected agent
   - Metric selector dropdown (quality, sentiment, cost, conversations)
   - Uses multiple `usePipelineAnalytics` calls (one per agent)

4. **Update `apps/studio/src/components/navigation/AppShell.tsx`**:
   - Replace `case 'agent-performance': return <ComingSoonPage ...>` with `return <AgentPerformancePage />`
   - Add import (lazy-loaded via `next/dynamic`)

**Exit Criteria**:

- Agent table renders with at least 1 row
- Column sorting works (click header toggles asc/desc)
- Click row shows detail panel with trend chart
- Selecting 2-3 agents shows comparison chart

**Files Created/Modified**:

- Created: `apps/studio/src/components/insights/AgentPerformancePage.tsx`
- Created: `apps/studio/src/components/insights/AgentDetailPanel.tsx`
- Created: `apps/studio/src/components/insights/AgentComparisonChart.tsx`
- Modified: `apps/studio/src/components/navigation/AppShell.tsx`

---

### Phase 6: Quality Monitor Page

**Goal**: Replace ComingSoonPage with a real quality monitor page.

**Changes**:

1. **`apps/studio/src/components/insights/QualityMonitorPage.tsx`** — New page component:
   - 2x2+1 grid layout (5 widgets)
   - Each widget uses `AnalyticsWidget` wrapper
   - `DateRangeSelector` in page header

2. **Quality widgets** (each in its own file under `apps/studio/src/components/insights/`):
   - **`QualityScoreWidget.tsx`**: Recharts AreaChart of daily quality scores from `quality_evaluation` pipeline summary. Shows avg_overall_score, avg_helpfulness, avg_accuracy lines.
   - **`HallucinationWidget.tsx`**: Recharts BarChart of hallucination severity distribution from `hallucination_detection` breakdown.
   - **`GuardrailWidget.tsx`**: Horizontal bar chart of guardrail trigger counts by type from `guardrail_analysis` breakdown.
   - **`KnowledgeGapWidget.tsx`**: Ranked list/table of top knowledge gap topics from `knowledge_gap` summary (topK).
   - **`ContextPreservationWidget.tsx`**: Recharts AreaChart of daily context preservation scores from `context_preservation` summary.

3. **Update AppShell.tsx**:
   - Replace `case 'quality-monitor': return <ComingSoonPage ...>` with `return <QualityMonitorPage />`

**Exit Criteria**:

- Page renders 5 widgets (or empty states if no pipeline data)
- Each widget shows correct chart type with data from the correct pipeline
- Date range selection updates all widgets

**Files Created/Modified**:

- Created: `apps/studio/src/components/insights/QualityMonitorPage.tsx`
- Created: `apps/studio/src/components/insights/QualityScoreWidget.tsx`
- Created: `apps/studio/src/components/insights/HallucinationWidget.tsx`
- Created: `apps/studio/src/components/insights/GuardrailWidget.tsx`
- Created: `apps/studio/src/components/insights/KnowledgeGapWidget.tsx`
- Created: `apps/studio/src/components/insights/ContextPreservationWidget.tsx`
- Modified: `apps/studio/src/components/navigation/AppShell.tsx`

---

### Phase 7: Customer Insights Page

**Goal**: Replace ComingSoonPage with a real customer insights page.

**Changes**:

1. **`apps/studio/src/components/insights/CustomerInsightsPage.tsx`** — New page component:
   - 2x2 grid layout (4 widgets)
   - `DateRangeSelector` in page header

2. **Customer widgets**:
   - **`SentimentTrendWidget.tsx`**: Stacked Recharts AreaChart showing positive/neutral/negative sentiment distribution over time from `sentiment_analysis` summary. Uses `improving_count`, `declining_count`, `stable_count`.
   - **`IntentDistributionWidget.tsx`**: Recharts PieChart (or horizontal BarChart) of top intent categories from `intent_classification` summary. Uses `top_intents` array.
   - **`FrictionHighlightsWidget.tsx`**: Table of top-friction sessions from `friction_detection` conversations endpoint (sorted by friction_score desc, limit 10). Clickable rows navigate to session detail via `navigate('sessions', sessionId)`.
   - **`ChurnRiskWidget.tsx`**: Summary cards showing count of high/medium/low risk customers. Data from predictive-features service (via custom query or a new summary endpoint). If no data, show empty state with explanation.

3. **Update AppShell.tsx**:
   - Replace `case 'customer-insights': return <ComingSoonPage ...>` with `return <CustomerInsightsPage />`

**Exit Criteria**:

- Page renders 4 widgets (or empty states)
- Sentiment chart shows stacked areas
- Intent chart shows top categories
- Friction table is clickable (navigates to session)
- Churn risk shows counts or empty state

**Files Created/Modified**:

- Created: `apps/studio/src/components/insights/CustomerInsightsPage.tsx`
- Created: `apps/studio/src/components/insights/SentimentTrendWidget.tsx`
- Created: `apps/studio/src/components/insights/IntentDistributionWidget.tsx`
- Created: `apps/studio/src/components/insights/FrictionHighlightsWidget.tsx`
- Created: `apps/studio/src/components/insights/ChurnRiskWidget.tsx`
- Modified: `apps/studio/src/components/navigation/AppShell.tsx`

---

### Phase 8: i18n

**Goal**: Add all user-facing strings to i18n namespace.

**Changes**:

1. **`packages/i18n/locales/en/studio.json`** — Extend `insights` namespace:
   ```json
   {
     "insights": {
       // ... existing keys preserved ...
       "metrics": {
         // ... existing keys preserved ...
         "quality_score": "Quality Score",
         "sentiment_score": "Sentiment Score",
         "error_rate": "Error Rate"
       },
       "pipeline_health": {
         "title": "Pipeline Health",
         "pipeline_name": "Pipeline",
         "status": "Status",
         "records": "Records",
         "last_updated": "Last Updated",
         "active": "Active",
         "no_data": "No Data"
       },
       "agent_performance": {
         "title": "Agent Performance",
         "subtitle": "Per-agent metrics and comparison",
         "columns": {
           "agent_name": "Agent",
           "conversations": "Conversations",
           "avg_quality": "Avg Quality",
           "containment_rate": "Containment",
           "avg_cost": "Avg Cost",
           "avg_sentiment": "Sentiment",
           "error_rate": "Errors"
         },
         "compare": "Compare",
         "clear_comparison": "Clear",
         "max_comparison": "Maximum 3 agents can be compared"
       },
       "quality_monitor": {
         "title": "Quality Monitor",
         "subtitle": "Quality evaluation, hallucination, guardrails, and knowledge gaps",
         "quality_score": "Quality Score Trend",
         "hallucination_rate": "Hallucination Rate",
         "guardrail_triggers": "Guardrail Triggers",
         "knowledge_gaps": "Knowledge Gaps",
         "context_preservation": "Context Preservation"
       },
       "customer_insights": {
         "title": "Customer Insights",
         "subtitle": "Sentiment, intents, friction, and churn risk",
         "sentiment_trend": "Sentiment Trend",
         "intent_distribution": "Intent Distribution",
         "friction_highlights": "Friction Highlights",
         "churn_risk": "Churn Risk"
       },
       "empty_states": {
         "no_pipeline_data": "No analytics data yet. Configure pipelines to start collecting data.",
         "no_sentiment_data": "No sentiment data available. Enable the sentiment analysis pipeline.",
         "no_quality_data": "No quality data available. Enable the quality evaluation pipeline.",
         "no_intent_data": "No intent data available. Enable the intent classification pipeline.",
         "no_friction_data": "No friction data available.",
         "no_churn_data": "No churn risk data available.",
         "no_hallucination_data": "No hallucination data available.",
         "no_guardrail_data": "No guardrail data available.",
         "no_knowledge_gap_data": "No knowledge gap data available.",
         "no_context_data": "No context preservation data available."
       }
     }
   }
   ```

**Exit Criteria**:

- All hardcoded English strings replaced with `t()` calls
- No missing i18n key warnings in browser console
- `pnpm build --filter=@agent-platform/i18n` passes

**Files Modified**:

- `packages/i18n/locales/en/studio.json`

---

### Phase 9: Unit Tests

**Goal**: Implement unit tests for all components and hooks.

**Changes**: Create test files as specified in test spec (UT-1 through UT-15).

**Key test files**:

- `apps/studio/src/components/insights/__tests__/InsightsDashboardPage.test.tsx`
- `apps/studio/src/components/insights/__tests__/AgentPerformancePage.test.tsx`
- `apps/studio/src/components/insights/__tests__/QualityMonitorPage.test.tsx`
- `apps/studio/src/components/insights/__tests__/CustomerInsightsPage.test.tsx`
- `apps/studio/src/hooks/__tests__/usePipelineAnalytics.test.ts`

**Exit Criteria**:

- All 15 unit tests pass
- `pnpm test --filter=studio` passes

---

### Phase 10: Integration & E2E Tests

**Goal**: Implement integration and E2E tests as specified in test spec.

**Changes**: Create test files for IT-1 through IT-7 and E2E-1 through E2E-10.

**Exit Criteria**:

- All 7 integration tests pass
- E2E test infrastructure set up with ClickHouse seeding
- At least E2E-1 (dashboard full render) and E2E-6 (empty state) pass

---

## 3. Wiring Checklist

| #   | Wiring Point                 | Location                                             | Action                                                   |
| --- | ---------------------------- | ---------------------------------------------------- | -------------------------------------------------------- |
| W-1 | Proxy regex                  | `apps/studio/src/proxy.ts`                           | Add `pipeline-analytics` to `RUNTIME_PROJECT_SUBPATH_RE` |
| W-2 | AppShell — agent-performance | `apps/studio/src/components/navigation/AppShell.tsx` | Replace `ComingSoonPage` with `AgentPerformancePage`     |
| W-3 | AppShell — quality-monitor   | `apps/studio/src/components/navigation/AppShell.tsx` | Replace `ComingSoonPage` with `QualityMonitorPage`       |
| W-4 | AppShell — customer-insights | `apps/studio/src/components/navigation/AppShell.tsx` | Replace `ComingSoonPage` with `CustomerInsightsPage`     |
| W-5 | AppShell — dashboard import  | `apps/studio/src/components/navigation/AppShell.tsx` | Verify import of enhanced `InsightsDashboardPage`        |
| W-6 | i18n keys                    | `packages/i18n/locales/en/studio.json`               | Add ~50 new keys under `insights` namespace              |
| W-7 | Insights store               | `apps/studio/src/store/insights-store.ts`            | Create and import in all 4 page components               |

---

## 4. Risk Mitigation

| Risk                                                      | Mitigation                                                   | Phase   |
| --------------------------------------------------------- | ------------------------------------------------------------ | ------- |
| Pipeline-analytics proxy not matching                     | Test with curl from Studio URL before building UI            | Phase 1 |
| Pipeline data empty for most projects                     | Implement clear empty states with CTA to pipeline config     | Phase 3 |
| Recharts bundle too large                                 | Verify bundle size with `next build --analyze` after Phase 4 | Phase 4 |
| Agent comparison with many agents causes N+1 queries      | Limit to 3 agents max; consider batch endpoint in future     | Phase 5 |
| ChurnRiskWidget has no direct pipeline-analytics endpoint | Fall back to NL query or show "Coming Soon" with explanation | Phase 7 |

---

## 5. File Inventory

### New Files (19)

| File                                                                | Phase | Type      |
| ------------------------------------------------------------------- | ----- | --------- |
| `apps/studio/src/store/insights-store.ts`                           | 1     | Store     |
| `apps/studio/src/hooks/usePipelineAnalytics.ts`                     | 2     | Hook      |
| `apps/studio/src/hooks/usePipelineHealth.ts`                        | 2     | Hook      |
| `apps/studio/src/components/insights/AnalyticsWidget.tsx`           | 3     | Component |
| `apps/studio/src/components/insights/DateRangeSelector.tsx`         | 3     | Component |
| `apps/studio/src/components/insights/KPICard.tsx`                   | 3     | Component |
| `apps/studio/src/components/insights/PipelineHealthScorecard.tsx`   | 3     | Component |
| `apps/studio/src/components/insights/MultiMetricTrendChart.tsx`     | 4     | Component |
| `apps/studio/src/components/insights/AgentPerformancePage.tsx`      | 5     | Page      |
| `apps/studio/src/components/insights/AgentDetailPanel.tsx`          | 5     | Component |
| `apps/studio/src/components/insights/AgentComparisonChart.tsx`      | 5     | Component |
| `apps/studio/src/components/insights/QualityMonitorPage.tsx`        | 6     | Page      |
| `apps/studio/src/components/insights/QualityScoreWidget.tsx`        | 6     | Widget    |
| `apps/studio/src/components/insights/HallucinationWidget.tsx`       | 6     | Widget    |
| `apps/studio/src/components/insights/GuardrailWidget.tsx`           | 6     | Widget    |
| `apps/studio/src/components/insights/KnowledgeGapWidget.tsx`        | 6     | Widget    |
| `apps/studio/src/components/insights/ContextPreservationWidget.tsx` | 6     | Widget    |
| `apps/studio/src/components/insights/CustomerInsightsPage.tsx`      | 7     | Page      |
| `apps/studio/src/components/insights/SentimentTrendWidget.tsx`      | 7     | Widget    |

Additional widget files in Phase 7:

- `apps/studio/src/components/insights/IntentDistributionWidget.tsx`
- `apps/studio/src/components/insights/FrictionHighlightsWidget.tsx`
- `apps/studio/src/components/insights/ChurnRiskWidget.tsx`

Total new files: **22**

### Modified Files (4)

| File                                                 | Phase | Change                                |
| ---------------------------------------------------- | ----- | ------------------------------------- |
| `apps/studio/src/proxy.ts`                           | 1     | Add pipeline-analytics to proxy regex |
| `apps/studio/src/hooks/useInsightsDashboard.ts`      | 2     | Extend summary with quality/sentiment |
| `apps/studio/src/components/navigation/AppShell.tsx` | 5-7   | Replace 3 ComingSoonPage stubs        |
| `packages/i18n/locales/en/studio.json`               | 8     | Add ~50 i18n keys                     |
