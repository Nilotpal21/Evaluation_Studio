# Quality Monitor Wiring Data-Flow Audit

## Scope

Audited the Insights > Quality Monitor flow from runtime pipeline analytics responses through the Studio hook and final UI consumption.

## Layer Map

| Layer         | Files                                                                                                                                                                                                 | Direction                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Runtime route | `apps/runtime/src/routes/pipeline-analytics.ts`, `apps/runtime/src/services/pipeline-analytics-summary.service.ts`                                                                                    | READ from ClickHouse, PASS-THROUGH as API response        |
| Studio hook   | `apps/studio/src/hooks/useQualityMonitor.ts`                                                                                                                                                          | READ API responses, TRANSFORM to UI model                 |
| Studio UI     | `apps/studio/src/components/insights/QualityMonitorPage.tsx`                                                                                                                                          | PRESENT health KPIs, trend, dimension rows, flagged table |
| Tests         | `apps/runtime/src/__tests__/routes/pipeline-analytics-route.test.ts`, `apps/studio/src/hooks/__tests__/useQualityMonitor.test.ts`, `apps/studio/src/hooks/__tests__/useQualityMonitor.parity.test.ts` | VERIFY route filters and hook parity                      |

## Propagation Matrix

| Field / semantic                        | Runtime route                                                 | Studio hook                                         | Studio UI                                  | Test evidence                      |
| --------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------ | ---------------------------------- |
| Quality score scale `0-5 -> 0-1`        | Y, returns `avg_overall_score` / `overall_score`              | Y, `normalizeScore(..., quality_evaluation)`        | Y, shared `formatPercent` health display   | `useQualityMonitor.parity.test.ts` |
| Other quality dimensions `0-1`          | Y, returns `avg_score` / `overall_score`                      | Y, no inversion for health scores                   | Y, labels describe higher-is-better health | `useQualityMonitor.test.ts`        |
| Hallucination faithfulness semantics    | Y, pipeline summary is score-style data                       | Y, treated as higher-is-better `Faithfulness Score` | Y, KPI label no longer says rate           | `useQualityMonitor.test.ts`        |
| Count sub-metrics                       | Y, count fields remain numeric                                | Y, `kind: "count"` preserves counts                 | Y, counts render without progress bars     | `useQualityMonitor.parity.test.ts` |
| Flagged conversations across dimensions | Y, `flagged:true` supported for all quality monitor pipelines | Y, fan-out and merge by `session_id`                | Y, table copy says all quality dimensions  | Route and hook tests               |
| Flag reasons                            | Y, selected for quality monitor pipelines                     | Y, `flag_reasons` fallback to pipeline id           | Y, rendered as dimension badges            | Route and hook tests               |
| Trend chart scale                       | Y, route returns raw pipeline values                          | Y, all trend values normalized to `0-1`             | Y, chart series comparable                 | `useQualityMonitor.parity.test.ts` |
| Session-level source scope              | Y, batch/empty `source` only for Quality Monitor dimensions   | Y, consumes conversation-level health rows          | Y, no realtime per-message rows mixed in   | Route tests                        |
| Replacement-aware quality trend         | Y, raw latest-row rollup avoids MV over-counting              | Y, consumes deduped `avg_overall_score`             | Y, trend reflects latest session rows      | Route tests                        |
| Context handoff count                   | Y, summary returns `sum(handoff_count)`                       | Y, preserves canonical `handoff_count`              | Y, renders as count                        | Hook tests                         |

## Concrete Trace

| Example                | Input                                          | Expected UI model                                      | Status |
| ---------------------- | ---------------------------------------------- | ------------------------------------------------------ | ------ |
| Quality trend point    | `avg_overall_score: 3.812`                     | `quality_evaluation: 0.7624`                           | OK     |
| Hallucination summary  | `avg_score: 0.85`, `avg_faithfulness: 0.85`    | Healthy score `0.85`, faithfulness score `0.85`        | OK     |
| Knowledge-gap count    | `gap_count: 82`                                | `{ key: "gap_detected", kind: "count", value: 82 }`    | OK     |
| Shared flagged session | quality score `3/5`, hallucination score `0.2` | merged row with health score `0.2` and both dimensions | OK     |
| Context handoffs       | `handoff_count: 12`                            | `{ key: "handoff_count", kind: "count", value: 12 }`   | OK     |

## Parallel Paths Checked

- `summary` endpoints normalize `avg_overall_score` for quality and `avg_score` for the other four Quality Monitor pipelines.
- `summary`, `timeseries`, and `conversations` for the five Quality Monitor dimensions filter to session-level rows with `source = 'batch' OR source = ''`.
- `timeseries` endpoints use the same scale normalization as summary/sparkline.
- `quality_evaluation/timeseries` intentionally bypasses `mv_daily_quality_scores` and rolls up latest raw rows by `session_id` with `argMax(..., processed_at)` so replacement/backfill inserts do not double-count the trend.
- `conversations?filter=flagged:true` is no longer quality-only; the route applies the flagged filter to all Quality Monitor pipelines and returns `flag_reasons`.
- The Studio hook still tolerates legacy `flagged_dimensions` and wrapper `{ conversations: [...] }` response shapes.

## Verdict

No remaining propagation gaps found in the Quality Monitor ClickHouse-to-route-to-hook-to-UI path. The route tests lock source scoping and replacement-aware trend SQL; the hook parity tests lock the user-facing semantics that triggered the review: health-score direction, scale normalization, count preservation, flagged fan-out, and merged flagged rows.
