# SDLC Log: Feature Spec — Analytics Insights Dashboard

**Date**: 2026-03-23
**Phase**: 1 — Feature Spec
**Status**: DONE

## Decisions

| #   | Classification | Decision                                                                                         |
| --- | -------------- | ------------------------------------------------------------------------------------------------ |
| D-1 | DECIDED        | Surface all 10 pipeline types via existing pipeline-analytics API — no new backend routes needed |
| D-2 | DECIDED        | Replace InsightsDashboardPage (not additive new page) to avoid navigation confusion              |
| D-3 | DECIDED        | Fill 3 "Coming Soon" placeholders (agent-performance, quality-monitor, customer-insights)        |
| D-4 | DECIDED        | Date range options 7d/30d/90d matching existing InsightsDashboardPage pattern                    |
| D-5 | DECIDED        | Use SWR polling at 30s (existing pattern) instead of real-time streaming                         |
| D-6 | DECIDED        | Lazy-load Recharts via dynamic() to control bundle size                                          |

## Key Findings

- **Rich backend, thin frontend**: 10 analytics pipelines computed and stored in ClickHouse, but only 5 KPIs shown in Studio UI
- **All backend APIs exist**: `pipeline-analytics` route supports summary, breakdown, conversations, conversation/:sid for all 10 types
- **3 placeholder pages**: agent-performance, quality-monitor, customer-insights are `ComingSoonPage` stubs
- **Existing hooks adequate**: `useInsightsDashboard`, `useAnalytics`, `useAnalyticsQuery` provide the data fetching patterns
- **NL query service**: available but out of scope for this feature (already has its own QueryExplorerTab)

## Audit Summary

Self-audited against feature spec quality gates:

- Problem statement grounded in real code paths (InsightsDashboardPage.tsx, ComingSoonPage stubs, pipeline-analytics route)
- 15 user stories covering 4 user personas
- 21 functional requirements mapped to specific pipeline types
- Dependencies verified against actual codebase files
- Non-goals explicitly exclude custom dashboard builder, NL query, pipeline config, and alerts
