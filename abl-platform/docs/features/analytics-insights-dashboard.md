# Feature: Analytics Insights Dashboard

**Doc Type**: FEATURE
**Status**: BETA
**Feature Area(s)**: `analytics`, `observability`, `customer experience`
**Package(s)**: `apps/studio`, `apps/runtime`, `packages/pipeline-engine`
**Owner(s)**: `Platform team`
**Testing Guide**: [docs/testing/analytics-insights-dashboard.md](../testing/analytics-insights-dashboard.md)
**Last Updated**: 2026-03-23

---

## 1. Introduction / Overview

### Problem Statement

The ABL platform has a rich analytics backend — 10 built-in pipeline types (sentiment, intent, quality, hallucination, knowledge-gap, guardrail, context-preservation, friction, anomaly, drift), ClickHouse materialized views for session metrics and LLM cost aggregation, a Redis-backed analytics cache, and an NL-to-SQL query service. However, the Studio UI surfaces only a fraction of this data:

- The **InsightsDashboardPage** shows 5 KPI cards (conversations, containment rate, cost savings, CSAT, escalation rate), a single area chart for conversation volume, and an agent cost breakdown table. It does not surface sentiment, quality, intent, anomaly, drift, or friction analytics.
- The **agent-performance**, **quality-monitor**, and **customer-insights** pages are stub "Coming Soon" placeholders (`ComingSoonPage` in `AppShell.tsx`).
- The **AnalyticsPage** (deprecated, redirected to dashboard) has an overview tab, LLM performance tab, sessions explorer, traces explorer, and SQL query explorer — but these are disconnected from the pipeline analytics data.
- The runtime exposes a full **pipeline-analytics API** (`/api/projects/:projectId/pipeline-analytics/:pipelineType/summary|breakdown|conversations|conversation/:sid`) for all 10 pipeline types, but the Studio UI never calls these endpoints.

The result: the platform computes and stores rich analytics data that users cannot see, making them unaware of sentiment trends, quality degradation, anomalies, or customer friction signals.

### Goal Statement

Replace the existing InsightsDashboardPage with a comprehensive analytics insights dashboard that surfaces data from all 10 analytics pipelines, provides drill-down from executive KPIs to per-pipeline detail, and fills the three "Coming Soon" placeholder pages (agent-performance, quality-monitor, customer-insights) with real data visualizations.

### Summary

The Analytics Insights Dashboard is a set of 4 interconnected pages within the existing "Insights" navigation group:

1. **Executive Dashboard** (replaces InsightsDashboardPage) — top-line KPIs, multi-metric trend chart, anomaly annotations, and pipeline health scorecard
2. **Agent Performance** (replaces ComingSoonPage) — per-agent metrics table with cost, quality, containment, and conversation volume; drill-down to individual agent detail
3. **Quality Monitor** (replaces ComingSoonPage) — quality evaluation trends, hallucination rates, guardrail trigger rates, knowledge gap frequency, context preservation scores
4. **Customer Insights** (replaces ComingSoonPage) — sentiment trends, intent distribution, friction detection highlights, predictive churn risk indicators

All pages pull data from the existing pipeline-analytics API routes and the existing analytics API routes. No new backend APIs are required — the backend is already built.

---

## 2. Scope

### Goals

- Surface all 10 analytics pipeline types in the Studio UI via existing pipeline-analytics API
- Replace the InsightsDashboardPage with an enhanced dashboard showing multi-metric trends, anomaly annotations, and pipeline health
- Implement the Agent Performance page with per-agent metrics table and drill-down
- Implement the Quality Monitor page with quality, hallucination, guardrail, knowledge-gap, and context-preservation visualizations
- Implement the Customer Insights page with sentiment, intent, friction, and predictive churn data
- Support date range selection (7d/30d/90d) consistent with existing UI patterns
- Support agent-level and channel-level filtering/breakdown dimensions
- Follow existing Studio design patterns (Recharts, SWR hooks, i18n, Tailwind, Lucide icons)
- Add loading skeletons, error states, and empty states for all data widgets

### Non-Goals (Out of Scope)

- New backend API routes — all data comes from existing `/api/projects/:projectId/pipeline-analytics` and `/api/projects/:projectId/analytics` endpoints
- Real-time streaming updates — SWR polling at 30-second intervals (existing pattern) is sufficient
- Custom dashboard builder (drag-and-drop widget arrangement) — fixed layouts per page
- Export/download of analytics data as CSV/PDF — can be added in a future iteration
- NL query UI integration on the dashboard — the existing QueryExplorerTab in AnalyticsPage already provides this
- Pipeline configuration UI — tracked separately as "pipelines" page
- Alert rule creation from the dashboard — the existing alerts page handles this
- Mobile-responsive layouts — Studio is desktop-first

---

## 3. User Stories

1. As a **project manager**, I want to see executive KPIs (conversations, containment, cost, CSAT, error rate) with trend indicators so that I can assess the overall health of my AI agent program at a glance.
2. As a **project manager**, I want to see a multi-metric trend chart showing conversation volume, cost, and quality over time so that I can identify patterns and regressions.
3. As a **project manager**, I want anomaly annotations on the trend chart (from the anomaly-detection pipeline) so that I can quickly spot and investigate unusual patterns.
4. As a **project manager**, I want a pipeline health scorecard showing which analytics pipelines are active and their latest processing status so that I know my analytics data is up to date.
5. As an **operations lead**, I want a per-agent metrics table showing cost, conversation volume, containment rate, and quality score for each agent so that I can identify underperforming agents.
6. As an **operations lead**, I want to filter/sort the agent metrics table by any column so that I can prioritize agents that need attention.
7. As an **operations lead**, I want to drill down from an agent row to see that agent's performance trends over time so that I can investigate degradation.
8. As a **quality analyst**, I want to see quality evaluation trends (overall quality score distribution over time) so that I can track whether agent responses are improving.
9. As a **quality analyst**, I want to see hallucination rates over time so that I can detect and respond to increases in hallucinated content.
10. As a **quality analyst**, I want to see guardrail trigger rates by guardrail type so that I can understand which safety rules are firing most often.
11. As a **quality analyst**, I want to see knowledge gap frequency and topics so that I can prioritize knowledge base improvements.
12. As a **customer experience lead**, I want to see sentiment trends over time (positive/neutral/negative distribution) so that I can track customer satisfaction.
13. As a **customer experience lead**, I want to see the top intent categories and their distribution so that I can understand what customers are asking about.
14. As a **customer experience lead**, I want to see friction detection highlights (sessions with high friction scores) so that I can investigate and fix pain points.
15. As a **customer experience lead**, I want to see predictive churn risk indicators so that I can proactively intervene with at-risk customers.

---

## 4. Functional Requirements

### Executive Dashboard (replaces InsightsDashboardPage)

1. **FR-1**: The dashboard must display 6 KPI cards: Total Conversations, Containment Rate, Avg Cost/Conversation, Avg Quality Score, Sentiment Score (avg), and Error Rate — each with a trend indicator (up/down/neutral vs. previous period).
2. **FR-2**: The dashboard must display a multi-metric trend chart (Recharts AreaChart) with selectable metrics (conversations, cost, quality, sentiment) over the selected date range.
3. **FR-3**: The dashboard must annotate anomaly detection results on the trend chart as visual markers (dots/icons at anomaly points with tooltip detail).
4. **FR-4**: The dashboard must display a pipeline health scorecard showing each pipeline type's status (active/inactive), last run timestamp, and record count.
5. **FR-5**: The dashboard must support date range selection (7d, 30d, 90d) via the existing `DropdownMenu` pattern.

### Agent Performance Page

6. **FR-6**: The page must display a sortable table of per-agent metrics: agent name, conversation count, avg quality score, containment rate, avg cost, avg sentiment, error rate.
7. **FR-7**: The page must support sorting by any column (ascending/descending).
8. **FR-8**: The page must support drill-down from an agent row to an agent detail view showing that agent's metrics trends over the selected date range.
9. **FR-9**: The page must display a comparison chart allowing side-by-side comparison of up to 3 agents on a selected metric.

### Quality Monitor Page

10. **FR-10**: The page must display a quality score distribution chart (histogram or area chart) over time from the `quality_evaluation` pipeline.
11. **FR-11**: The page must display a hallucination rate trend chart from the `hallucination_detection` pipeline.
12. **FR-12**: The page must display guardrail trigger rates broken down by guardrail type from the `guardrail_analysis` pipeline.
13. **FR-13**: The page must display knowledge gap topics from the `knowledge_gap` pipeline, ranked by frequency.
14. **FR-14**: The page must display a context preservation score trend from the `context_preservation` pipeline.

### Customer Insights Page

15. **FR-15**: The page must display a sentiment trend chart showing the distribution of positive/neutral/negative sentiment over time from the `sentiment_analysis` pipeline.
16. **FR-16**: The page must display an intent distribution chart (pie/donut or horizontal bar) from the `intent_classification` pipeline showing top intent categories.
17. **FR-17**: The page must display a friction highlights table showing sessions with the highest friction scores from the `friction_detection` pipeline, with drill-down to session detail.
18. **FR-18**: The page must display a churn risk summary from the `compute-predictive-features` service, showing the count of high/medium/low risk customers.

### Cross-Cutting

19. **FR-19**: All pages must show loading skeletons during data fetch and a contextual empty state when no data is available for the selected date range.
20. **FR-20**: All pages must propagate API errors as user-visible error banners (not silent failures).
21. **FR-21**: All user-facing strings must use i18n keys via `useTranslations('insights')`, extending the existing i18n namespace.

---

## 5. Non-Functional Requirements

1. **NFR-1**: Initial page load must render the first meaningful paint (KPI cards with data) within 2 seconds on a 4G connection.
2. **NFR-2**: Chart rendering (Recharts) must complete within 500ms for datasets up to 90 data points (one per day for 90d range).
3. **NFR-3**: SWR polling interval must be 30 seconds (matching existing `useAnalytics` pattern) with `keepPreviousData: true` to avoid flickering.
4. **NFR-4**: All data requests must include `tenantId` and `projectId` scoping (enforced by the existing auth middleware chain in the runtime analytics routes).
5. **NFR-5**: Charts must use lazy loading (Next.js `dynamic()` with `ssr: false`) for Recharts components to avoid inflating the initial JS bundle — matching the existing pattern in `AnalyticsPage.tsx`.

---

## 6. Dependencies

| Dependency                        | Type            | Status  | Notes                                                                                 |
| --------------------------------- | --------------- | ------- | ------------------------------------------------------------------------------------- |
| `pipeline-analytics` API routes   | Backend API     | DONE    | `/api/projects/:projectId/pipeline-analytics/:type/summary\|breakdown\|conversations` |
| `analytics` API routes            | Backend API     | DONE    | `/api/projects/:projectId/analytics/metrics\|events\|cost-breakdown\|session-metrics` |
| Pipeline engine ClickHouse tables | Data store      | DONE    | 10 analytics tables + 2 MVs (session_metrics_daily, llm_cost_hourly)                  |
| `AnalyticsCache` (Redis)          | Caching         | DONE    | `packages/pipeline-engine/src/pipeline/services/analytics-cache.ts`                   |
| `useInsightsDashboard` hook       | Frontend hook   | DONE    | `apps/studio/src/hooks/useInsightsDashboard.ts` — will be extended                    |
| `useAnalytics` hooks              | Frontend hooks  | DONE    | `apps/studio/src/hooks/useAnalytics.ts` — session metrics, cost, events               |
| Navigation config                 | Frontend config | DONE    | `apps/studio/src/config/navigation.ts` — insights group with 5 pages                  |
| Recharts library                  | UI library      | DONE    | Already used in InsightsDashboardPage, AnalyticsPage                                  |
| i18n namespace `insights`         | Localization    | PARTIAL | Exists for current InsightsDashboardPage, needs extension                             |

---

## 7. Risks and Mitigations

| Risk                                                                                | Impact                                  | Likelihood | Mitigation                                                                             |
| ----------------------------------------------------------------------------------- | --------------------------------------- | ---------- | -------------------------------------------------------------------------------------- |
| Pipeline-analytics API returns empty data for projects without configured pipelines | High — empty dashboards frustrate users | Medium     | Show contextual empty states with "Enable pipelines" CTA linking to pipeline config    |
| ClickHouse query latency on large datasets (90d range with many sessions)           | Medium — slow page loads                | Low        | AnalyticsCache with 5-minute TTL already in place; MVs provide pre-aggregated data     |
| Recharts bundle size increase from adding multiple chart types                      | Medium — bundle bloat                   | Low        | Lazy-load all chart pages via `dynamic()` with `ssr: false` (existing pattern)         |
| Pipeline types evolve (new pipelines added)                                         | Low — dashboard becomes stale           | Low        | Use `VALID_PIPELINE_TYPES` set from pipeline-analytics route as single source of truth |

---

## 8. Success Metrics

1. **Adoption**: >60% of active Studio users visit the insights dashboard within 30 days of launch
2. **Engagement**: Average session duration on insights pages >90 seconds (indicating actual data consumption, not just a glance)
3. **Coverage**: All 10 pipeline types surfaced in the UI with non-empty data for projects that have active pipelines
4. **Performance**: P95 page load time <2 seconds for the executive dashboard

---

## 9. Feature Lifecycle

| Phase   | Status  | Criteria                                                         |
| ------- | ------- | ---------------------------------------------------------------- |
| PLANNED | CURRENT | Feature spec approved, HLD approved                              |
| ALPHA   | —       | Executive dashboard + 1 sub-page implemented, unit tests passing |
| BETA    | —       | All 4 pages implemented, E2E tests passing, i18n complete        |
| STABLE  | —       | 2 weeks in production with no P0/P1 bugs, >60% adoption          |
