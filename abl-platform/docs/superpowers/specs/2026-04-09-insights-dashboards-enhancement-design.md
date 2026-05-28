# Insights Dashboards Enhancement Design

**Date:** 2026-04-09
**Branch:** `pipeline-engine/insights-dashboards`
**Status:** Approved

## Summary

Enhance three insights tabs — Dashboard (AtAGlance), Voice Analytics, Quality Monitor — to replace mock data with real computed data, build the Quality Monitor from scratch, and add comprehensive test coverage. Each implementation phase includes seeding test data into ClickHouse to verify end-to-end.

## Decisions

| Decision                | Choice                                                  | Rationale                                                       |
| ----------------------- | ------------------------------------------------------- | --------------------------------------------------------------- |
| Quality Monitor scope   | System-wide KPIs + dimension deep-dives                 | Gives both quick health overview and investigation capability   |
| Dashboard ROI data      | Compute from existing endpoints + configurable defaults | Avoids new backend; user can tune cost assumptions on dashboard |
| Dashboard Conversations | Searchable/filterable table                             | Covers primary use case without duplicating session detail page |
| Test scope              | Hook tests + runtime route tests                        | High value; component rendering tests for charts are brittle    |
| Architecture            | Incremental — one hook + page per tab                   | Matches existing patterns; SWR deduplicates by cache key anyway |
| Test data               | Seed ClickHouse per implementation phase                | Verify real data flow, not just mocked responses                |

---

## Section 1: Dashboard (AtAGlance) Enhancements

### 1.1 ROI Sub-tab — Replace Mock Data

**Current state:** Uses `MOCK_ROI` and `MOCK_COST_TREND` from `mock-data.ts`. Has a TODO to wire to `/roi/summary`.

**Data source:** Compute from existing endpoints already fetched by `useAtAGlance`:

- `cost-breakdown` — LLM spend (`totalLlmCost`)
- `session-metrics` — conversation volume (`totalSessions`)
- `outcomes` — containment rate (`containedConversations`)

**Configurable cost settings (stored in localStorage per project):**

| Setting                    | Default        | Key                                               |
| -------------------------- | -------------- | ------------------------------------------------- |
| `humanCostPerConversation` | `$12.00`       | `roi-config-{projectId}.humanCostPerConversation` |
| `humanFteCost`             | `$4,500/month` | `roi-config-{projectId}.humanFteCost`             |
| `avgHumanHandleTime`       | `6 minutes`    | `roi-config-{projectId}.avgHumanHandleTime`       |

**UI:** Gear icon on ROI tab opens a settings popover/drawer where users can edit these values. Changes are saved to `localStorage` and immediately recompute KPIs.

**KPI formulas:**

| KPI                 | Formula                                                            |
| ------------------- | ------------------------------------------------------------------ |
| Monthly Savings     | `containedConversations * humanCostPerConversation - totalLlmCost` |
| Annual ROI          | `(monthlySavings * 12) / (totalLlmCost * 12) * 100`                |
| FTE Equivalent      | `containedConversations * avgHumanHandleTime / (160 * 60)`         |
| Cost per Resolution | `totalLlmCost / totalConversations`                                |

**Chart:** AI Cost vs Human Cost bar chart using real monthly `cost-breakdown` data for AI cost, `monthlyConversations * humanCostPerConversation` for estimated human cost.

**Cleanup:** Remove `MOCK_ROI` and `MOCK_COST_TREND` from `mock-data.ts` after wiring.

### 1.2 Conversations Sub-tab — New

**API:** Uses existing `pipeline-analytics/quality_evaluation/conversations` endpoint with query filters.

**Hook:** Add a `useConversationList` sub-section to `useAtAGlance` (or a small companion hook) with SWR call for paginated conversation data.

**UI components:**

- **Filter bar:** Outcome dropdown (all/contained/escalated/abandoned), quality range slider, flagged toggle, date range selector
- **Table columns:** Date, Agent, Outcome (color badge), Quality Score, Sentiment, Intent
- **Pagination:** 25 per page, page controls at bottom
- **Row click:** Navigate to session detail page via router

---

## Section 2: Voice Analytics Tests

**No code changes** — the implementation is 100% real data. Only tests are needed.

### 2.1 Hook Tests — `useVoiceAnalytics.test.ts`

Pattern: SWR mock with `Map<string, {data, error}>` (same as `useCustomerInsights.test.ts`).

**Test cases (~15):**

1. Returns loading state when no data
2. Computes total calls from summary
3. Computes avg MOS from summary
4. Computes ASR quality score from summary
5. Computes E2E latency from summary
6. Computes barge-in rate from summary
7. Computes DTMF fallback rate from summary
8. Handles ClickHouse raw array response format
9. Handles ClickHouse `{meta, data}` wrapper format
10. Returns hourly data array from hourly endpoint
11. Handles empty summary response gracefully
12. Handles empty hourly response gracefully
13. Returns null projectId when none set
14. Reports error string on SWR failure
15. Respects `hours` parameter in URL construction

### 2.2 Runtime Route Tests — `voice-analytics-route.test.ts`

Pattern: Express server on random port with mocked ClickHouse + auth (same as `pipeline-analytics-route.test.ts`).

**Test cases (~10):**

1. Summary endpoint returns aggregated metrics
2. Hourly endpoint returns per-hour breakdowns
3. Auth middleware enforced (401 without token)
4. Project isolation (projectId included in ClickHouse query)
5. Handles empty ClickHouse response (zero calls)
6. Default hours parameter (24h)
7. Custom hours parameter filtering
8. Response format contract (`{success, data}`)
9. Weighted average computation (MOS = sum/count)
10. Hourly data capped at 500 rows

---

## Section 3: Quality Monitor (New Page)

### 3.1 Hook — `useQualityMonitor.ts`

**SWR calls (11 total):**

| #    | Call                  | Pipeline                | Endpoint                     |
| ---- | --------------------- | ----------------------- | ---------------------------- |
| 1-5  | Summary               | All 5 quality pipelines | `summary`                    |
| 6-10 | Timeseries            | All 5 quality pipelines | `timeseries`                 |
| 11   | Flagged conversations | `quality_evaluation`    | `conversations?flagged=true` |

**Exported pure functions:**

```
computeOverallHealth(summaries) → { score, status, flaggedTotal }
  Weighted average: quality 30%, hallucination 25%, knowledge_gap 15%, guardrail 20%, context 10%

classifyScore(value, pipeline) → 'healthy' | 'warning' | 'critical'
  Respects direction (higher-is-better vs lower-is-better)
  Thresholds: quality >0.7 healthy, >0.5 warning, else critical
              hallucination <0.3 healthy, <0.5 warning, else critical

computeDimensionStats(summary, pipeline) → { score, subMetrics[], flaggedCount, status }
  Extracts pipeline-specific sub-metrics into a uniform shape
```

**Computed outputs:**

| Field                  | Type                | Description                                                |
| ---------------------- | ------------------- | ---------------------------------------------------------- |
| `overallQualityScore`  | number              | Weighted average across 5 dimensions                       |
| `totalEvaluated`       | number              | Max conversation count across pipelines                    |
| `flaggedCount`         | number              | Sum of flagged from all 5 summaries                        |
| `flaggedRate`          | number              | `flaggedCount / totalEvaluated * 100`                      |
| `dimensions`           | DimensionStats[]    | 5 entries with score, status, sub-metrics, trend sparkline |
| `dailyTrend`           | DailyQualityPoint[] | Merged timeseries by day across all 5 pipelines            |
| `flaggedConversations` | ConversationRow[]   | Paginated flagged conversation list                        |
| `isLoading`            | boolean             | True until first summary arrives                           |
| `error`                | string \| null      | First SWR error stringified                                |

### 3.2 Page — `QualityMonitorPage.tsx`

**Layout (top to bottom):**

**1. KPI Row — 5 `InsightKPICard` components:**

| Card                  | Source                                            | Direction        |
| --------------------- | ------------------------------------------------- | ---------------- |
| Overall Quality Score | `computeOverallHealth` weighted avg               | Higher is better |
| Hallucination Rate    | `hallucination_detection` summary `overall_score` | Lower is better  |
| Knowledge Gap Rate    | `knowledge_gap` summary `overall_score`           | Lower is better  |
| Safety Score          | `guardrail_analysis` summary `overall_score`      | Higher is better |
| Context Preservation  | `context_preservation` summary `overall_score`    | Higher is better |

Each card shows sparkline from timeseries and status color (healthy/warning/critical).

**2. Quality Trend Chart — `TimeSeriesChart`:**

- 5 overlaid lines (one per dimension), daily over selected period
- Date range selector: 7d / 30d / 90d
- Y-axis: 0-1 (score scale)

**3. Dimension Deep-Dive Cards — 5 expandable sections:**

| Dimension               | Sub-metrics                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------- |
| Quality Evaluation      | helpfulness, accuracy, professionalism, instruction_following                         |
| Hallucination Detection | faithfulness_score, consistency_index, contradiction_detected count                   |
| Knowledge Gap           | retrieval_precision, citation_rate, gap_detected count                                |
| Guardrails              | false_positive_score, false_negative_score, bypass_detected count, severity breakdown |
| Context Preservation    | context_score, duplication_detected count, avg handoff_count                          |

Each card: score with status color, sub-metric progress bars, flagged count badge. Click to expand shows the sub-metric detail.

**4. Flagged Conversations Table:**

- Columns: Date, Agent, Quality Score, Flagged Dimensions (badges), Sentiment
- Filters: Dimension dropdown, score range, date range
- Pagination: 25 per page
- Row click: Navigate to session detail page

### 3.3 Tests — `useQualityMonitor.test.ts`

**Pure function tests (~12):**

1. `computeOverallHealth` — weighted average with all 5 scores
2. `computeOverallHealth` — handles missing pipelines gracefully
3. `computeOverallHealth` — returns critical when any dimension is critical
4. `classifyScore` — healthy threshold for higher-is-better pipeline
5. `classifyScore` — warning threshold for higher-is-better pipeline
6. `classifyScore` — critical threshold for higher-is-better pipeline
7. `classifyScore` — healthy threshold for lower-is-better pipeline
8. `classifyScore` — critical threshold for lower-is-better pipeline
9. `computeDimensionStats` — extracts quality_evaluation sub-metrics
10. `computeDimensionStats` — extracts hallucination sub-metrics
11. `computeDimensionStats` — extracts guardrail sub-metrics with severity
12. `computeDimensionStats` — handles empty/null summary

**SWR orchestration tests (~8):** 13. Returns loading state when no data 14. Computes KPIs from all 5 summaries 15. Computes flaggedRate across pipelines 16. Merges daily trends from 5 timeseries 17. Returns flagged conversations list 18. Handles partial data (some pipelines loaded, others pending) 19. Reports error on SWR failure 20. Returns null projectId when none set

---

## Section 4: File Inventory

### New Files

| File                                                              | Purpose                           |
| ----------------------------------------------------------------- | --------------------------------- |
| `apps/studio/src/hooks/useQualityMonitor.ts`                      | Quality Monitor data hook         |
| `apps/studio/src/components/insights/QualityMonitorPage.tsx`      | Quality Monitor page              |
| `apps/studio/src/hooks/__tests__/useQualityMonitor.test.ts`       | Quality Monitor hook tests (~20)  |
| `apps/studio/src/hooks/__tests__/useAtAGlance.test.ts`            | Dashboard hook tests (~15)        |
| `apps/studio/src/hooks/__tests__/useVoiceAnalytics.test.ts`       | Voice Analytics hook tests (~15)  |
| `apps/runtime/src/__tests__/routes/voice-analytics-route.test.ts` | Voice Analytics route tests (~10) |

### Modified Files

| File                                                    | Change                                                  |
| ------------------------------------------------------- | ------------------------------------------------------- |
| `apps/studio/src/hooks/useAtAGlance.ts`                 | Add ROI computation, conversation list fetching         |
| `apps/studio/src/components/insights/AtAGlancePage.tsx` | Wire real ROI + settings popover, add Conversations tab |
| `apps/studio/src/components/insights/mock-data.ts`      | Remove `MOCK_ROI`, `MOCK_COST_TREND`                    |
| `apps/studio/src/components/navigation/AppShell.tsx`    | Swap ComingSoonPage for lazy-loaded QualityMonitorPage  |

### Unchanged Files

| File                               | Reason                                    |
| ---------------------------------- | ----------------------------------------- |
| Voice Analytics hooks + components | Already real data, no changes             |
| `pipeline-analytics.ts` route      | Quality Monitor reuses existing endpoints |
| `voice-analytics.ts` route         | Already implemented                       |

### Test Data Seeding

Each implementation phase seeds ClickHouse with representative test data:

- **Dashboard:** Verify ROI computation against real cost-breakdown + session-metrics + outcomes
- **Voice Analytics:** Verify summary/hourly aggregation against seeded `platform_events` voice events
- **Quality Monitor:** Verify all 5 quality pipeline summaries + timeseries against seeded evaluation tables

### Test Count

| Test File                       | Cases   |
| ------------------------------- | ------- |
| `useQualityMonitor.test.ts`     | ~20     |
| `useAtAGlance.test.ts`          | ~15     |
| `useVoiceAnalytics.test.ts`     | ~15     |
| `voice-analytics-route.test.ts` | ~10     |
| **Total**                       | **~60** |
