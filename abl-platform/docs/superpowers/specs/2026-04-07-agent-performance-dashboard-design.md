# Agent Performance Dashboard — Design Spec

**Date:** 2026-04-07
**Status:** Draft
**Author:** Rakshak + Claude
**Related:** Customer Insights page (ABLP-213), Pipeline Analytics endpoints

## Problem

The Studio "Insights" nav group has three pages. Customer Insights was built first (ABLP-213). The Agent Performance page is still a "Coming Soon" placeholder. Operations leads, product analysts, and AI engineers need a single dashboard to understand how their agents are performing across quality, trustworthiness, knowledge coverage, safety, and context handling — and to quickly identify which agents need attention.

## Scope

### In scope

- Agent Performance dashboard page in Studio
- 5 pipeline types: quality_evaluation, hallucination_detection, knowledge_gap, guardrail_analysis, context_preservation
- Health classification using existing pipeline config thresholds
- Per-agent comparison table with sorting, filtering, search
- Aggregate KPI sparklines with period-over-period comparison
- Time range selector (7d/30d/90d) with comparison toggle
- Empty states for missing pipeline data

### Out of scope

- No new backend endpoints (all 5 pipeline types already have summary, breakdown, timeseries, conversations endpoints)
- No agent drill-down / detail view (v2)
- No composite health score (threshold-based classification instead)
- Friction detection, anomaly detection, drift detection (reserved for Quality Monitor page)
- No alerting or notifications
- No pipeline configuration from this page

## Design Decisions

| Decision              | Choice                                       | Rationale                                                                                                    |
| --------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Layout                | Health Banner + Smart Table                  | Scales to 5-25 agents. Worst-first sorting surfaces problems. Filter chips for quick triage.                 |
| Health classification | Threshold-based (Healthy/Warning/Critical)   | Honest — no misleading composite score. Reuses existing `flagThreshold` from pipeline configs.               |
| Threshold source      | Pipeline config `flagThreshold`              | Already exists and is configurable per project. Warning = 20% buffer above threshold.                        |
| Time ranges           | 7d/30d/90d + comparison toggle               | Consistent with Customer Insights. Comparison toggle powers trend arrows.                                    |
| Agent drill-down      | Not in v1                                    | Keep scope focused. Table with all metrics per row provides sufficient detail.                               |
| Pipelines per page    | 5 on Agent Performance, 3 on Quality Monitor | Quality/hallucination/knowledge/guardrail/context are agent-centric. Friction/anomaly/drift are operational. |

## Page Layout

```
┌─────────────────────────────────────────────────────────┐
│  PageHeader: "Agent Performance"   [7d ▾] [⇄ Compare]  │
├─────────────────────────────────────────────────────────┤
│  Health Banner                                          │
│  ● Healthy: 9  ● Warning: 2  ● Critical: 1             │
│  12 agents · 2,341 conversations · ↑ from last period   │
├──────┬──────┬──────┬──────┬─────────────────────────────┤
│Qualiy│Halluc│K.Gaps│Safety│Context   (KPI sparklines)   │
│ 3.8  │ 4.2% │  12  │ 94% │ 4.1                         │
│ ▲0.2 │▲1.8% │ ▼3   │ —   │ ▲0.1                        │
├──────┴──────┴──────┴──────┴─────────────────────────────┤
│  [🔍 Search] [Critical(1)] [Warning(2)] [All(12)]      │
│  Agent Table (sortable, filterable, paginated at 10)    │
│  Agent  │Status│Convos│Qual│Halluc│Gaps│Safe│Ctx│Trend  │
│  ───────────────────────────────────────────────────── │
│  ▌Support │Crit │ 312 │3.4 │8.3% │ 7 │89% │3.6│ ↓↓   │
│  ▌FAQ     │Warn │ 156 │3.7 │3.1% │ 5 │96% │4.0│ ↓    │
│   Booking │OK   │ 421 │4.2 │1.1% │ 2 │98% │4.3│ ↑    │
│   Billing │OK   │ 287 │3.9 │2.5% │ 3 │95% │4.1│ ↑    │
│  Showing 6 of 12 · Show all                            │
├─────────────────────────────────────────────────────────┤
│  Quality Trend (TimeSeriesChart, full width)            │
│  daily avg quality + flagged count overlay              │
└─────────────────────────────────────────────────────────┘
```

## Components

### 1. HealthBanner

Colored background reflecting overall project health (green if all healthy, yellow if any warning, red if any critical).

**Data source:** Computed client-side from per-agent classification results.

**Shows:**

- Agent count per status: `● Healthy: N  ● Warning: N  ● Critical: N`
- Total agents and conversations for period
- Period-over-period change (when comparison toggle is on)
- Sampling rate badge if any pipeline has `samplingRate < 1.0`

### 2. MetricSparklineRow

5 compact KPI cards using `InsightKPICard`:

| Card               | Source endpoint                   | Value                                   | Delta              |
| ------------------ | --------------------------------- | --------------------------------------- | ------------------ |
| Quality            | `quality_evaluation/summary`      | `avg_overall_score` (0-5)               | vs previous period |
| Hallucination Rate | `hallucination_detection/summary` | `flagged_rate_pct` (%)                  | vs previous period |
| Knowledge Gaps     | `knowledge_gap/summary`           | `gap_count` (count)                     | vs previous period |
| Safety Score       | `guardrail_analysis/summary`      | derived: `(1 - flagged_rate/100) * 100` | vs previous period |
| Context Score      | `context_preservation/summary`    | `avg_score` (0-5)                       | vs previous period |

Each card shows: current value, delta arrow with color, mini sparkline from timeseries.

### 3. AgentTable

The core component. Fetches `breakdown?dimension=agent_name` from all 5 pipelines and merges by `agent_name`.

**Columns:**
| Column | Source | Sort |
|--------|--------|------|
| Agent | `agent_name` from breakdown | Alpha |
| Status | Computed from thresholds | Severity (Critical > Warning > Healthy) |
| Conversations | `conversation_count` from quality breakdown | Numeric |
| Quality | `avg_overall_score` from quality breakdown | Numeric |
| Hallucination | `flagged_rate` from hallucination breakdown | Numeric |
| Knowledge Gaps | `gap_count` or `flagged_count` from knowledge_gap breakdown | Numeric |
| Safety | derived from guardrail `flagged_count` | Numeric |
| Context | `avg_overall_score` from context breakdown | Numeric |
| Trend | Computed delta from comparison period | Severity |

**Features:**

- Search input: client-side filter by agent name
- Status filter chips: Critical(N), Warning(N), All(N) — click to filter
- Sortable: click any column header. Default sort: status severity desc, then quality asc
- Pagination: show first 10 rows, "Show all" link expands
- Row styling: Critical rows get red left border + red tint background. Warning rows get yellow left border + subtle yellow tint.
- Cell coloring: each metric cell colored green/yellow/red based on its individual threshold classification
- Trend column: shows ↑/↓/— arrows (only visible when comparison toggle is on)

**Merging logic:**

- Fetch breakdown from all 5 pipelines
- Build a Map<agent_name, metrics> merging results
- Some agents may not have data for all pipelines (e.g., if a pipeline is disabled) — show "—" for missing metrics

### 4. QualityTrendChart

Full-width `TimeSeriesChart` (existing shared component) showing:

- Line: daily avg quality score from `quality_evaluation/timeseries`
- Bar overlay: daily flagged count

Provides time-context that the table lacks.

## Health Classification Logic

```typescript
type AgentStatus = 'healthy' | 'warning' | 'critical';

interface ThresholdConfig {
  critical: number; // from pipeline flagThreshold
  warning: number; // flagThreshold * 1.2 (20% buffer)
  direction: 'higher-better' | 'lower-better';
}

const METRIC_DIRECTIONS: Record<string, 'higher-better' | 'lower-better'> = {
  quality_evaluation: 'higher-better',
  hallucination_detection: 'lower-better', // flagged rate — lower is better
  knowledge_gap: 'lower-better', // gap count — lower is better
  guardrail_analysis: 'higher-better', // safety score — higher is better
  context_preservation: 'higher-better',
};

function classifyMetric(value: number, threshold: ThresholdConfig): AgentStatus {
  if (threshold.direction === 'higher-better') {
    if (value <= threshold.critical) return 'critical';
    if (value <= threshold.warning) return 'warning';
    return 'healthy';
  } else {
    // lower-better: above threshold is bad
    if (value >= threshold.critical) return 'critical';
    if (value >= threshold.warning) return 'warning';
    return 'healthy';
  }
}

function classifyAgent(metrics: AgentMetrics, thresholds: PipelineThresholds): AgentStatus {
  const statuses = Object.entries(metrics).map(([pipeline, value]) =>
    classifyMetric(value, thresholds[pipeline]),
  );
  if (statuses.includes('critical')) return 'critical';
  if (statuses.includes('warning')) return 'warning';
  return 'healthy';
}
```

## Data Fetching — useAgentPerformance Hook

SWR hook following the same pattern as `useCustomerInsights.ts`:

```
Inputs: projectId, period ('7d'|'30d'|'90d'), compareEnabled (boolean)

Fetches (parallel via SWR):
  1. quality_evaluation/summary         → KPI card
  2. hallucination_detection/summary    → KPI card
  3. knowledge_gap/summary              → KPI card
  4. guardrail_analysis/summary         → KPI card
  5. context_preservation/summary       → KPI card
  6. quality_evaluation/breakdown?dimension=agent_name     → table column
  7. hallucination_detection/breakdown?dimension=agent_name → table column
  8. knowledge_gap/breakdown?dimension=agent_name           → table column
  9. guardrail_analysis/breakdown?dimension=agent_name      → table column
  10. context_preservation/breakdown?dimension=agent_name    → table column
  11. quality_evaluation/timeseries      → trend chart

  If compareEnabled:
  12-16. Same 5 summary calls with doubled period → delta computation

Pipeline config (cached, fetched once):
  17. GET /pipeline-config/quality_evaluation       → flagThreshold
  18-21. Same for other 4 pipelines                 → flagThresholds

Returns:
  - kpis: { quality, hallucination, knowledgeGaps, safety, context } with value + delta
  - agents: merged per-agent rows with all metrics + computed status
  - healthSummary: { healthy: N, warning: N, critical: N, totalAgents, totalConversations }
  - dailyTrend: timeseries data for chart
  - isLoading, error
```

Uses same defensive `extractObject()` / `extractArray()` helpers from `useCustomerInsights` to handle ClickHouse response shape variations.

## Empty States

| Scenario                             | Behavior                                                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| No pipeline data at all              | Full-page empty state: "No agent performance data yet. Enable analytics pipelines in Settings to start tracking." |
| Some pipelines disabled              | Table shows "—" for disabled pipeline columns. Tooltip: "Enable [pipeline] to track this."                        |
| No agents in period                  | Empty table: "No agent activity in the selected period. Try a longer time range."                                 |
| Single agent                         | Table with 1 row. Health banner shows "1 agent". Works normally.                                                  |
| Compare toggle, insufficient history | Delta shows "—" instead of arrow. Tooltip: "Not enough data for comparison."                                      |
| Sampling active                      | Info badge in health banner: "Based on N% sample"                                                                 |

## Wiring

**AppShell.tsx** change (single line):

- Replace `case 'agent-performance': <ComingSoonPage .../>` with `case 'agent-performance': return <AgentPerformancePage />`
- Add lazy import via `next/dynamic`

## Files

| Action     | File                                                           |
| ---------- | -------------------------------------------------------------- |
| **Create** | `apps/studio/src/hooks/useAgentPerformance.ts`                 |
| **Create** | `apps/studio/src/components/insights/AgentPerformancePage.tsx` |
| **Modify** | `apps/studio/src/components/navigation/AppShell.tsx`           |

## Known Limitations

1. **No agent drill-down** — v1 is table-only. Clicking a row does nothing. Future: inline expansion or side panel.
2. **No materialized views for 4 of 5 pipelines** — Only `quality_evaluation` has an MV. The other 4 pipelines' timeseries queries hit raw tables (slower). The trend chart only uses quality timeseries for this reason.
3. **Threshold buffer is fixed at 20%** — The Warning zone is always `flagThreshold * 1.2`. Not configurable per-project yet.
4. **No per-agent timeseries** — The breakdown endpoint gives aggregate per agent, not per-agent-per-day. Can't show per-agent trend sparklines in the table.
5. **Comparison period doubles the API calls** — 11 base calls + 5 comparison calls = 16 when comparison is on. All SWR-cached with appropriate keys.
6. **Knowledge gap metric interpretation** — The breakdown returns `conversation_count` and `avg_overall_score` per agent, not `gap_count`. We use `flagged_count` as a proxy for gaps detected.
