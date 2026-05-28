# Workflows → Document Extraction — Grafana Dashboard

**Source**: `docs/sdlc-logs/document-extraction-integrations/dashboard.json` (this repo)
**Deploy target**: `abl-platform-deploy:grafana/dashboards/workflows-document-extraction.json`
**Owner**: Workflows team
**Stage gate**: Phase 4 exit — "Grafana dashboard renders in dev environment".

## Metric → Panel map

| HLD §4.2 metric                                                                     | Panel ID | Emit site (file:line)                                                                        |
| ----------------------------------------------------------------------------------- | -------: | -------------------------------------------------------------------------------------------- |
| `bullmq_queue_depth{queue}`                                                         |        1 | `apps/search-ai/src/workers/docling-extraction-worker.ts` (15s tick)                         |
| `worker_active_jobs{queue}`                                                         |        2 | `apps/search-ai/src/workers/docling-extraction-worker.ts` (active/completed/failed)          |
| `workflow_docling_wait_duration_seconds{tenant,status}`                             |        3 | `apps/workflow-engine/src/handlers/workflow-handler.ts` (suspension block exit paths)        |
| `workflow_docling_parked_promises_gauge{tenant}`                                    |        4 | `apps/workflow-engine/src/handlers/workflow-handler.ts` (incrementParked/decrementParked)    |
| `workflow_docling_errors_total{tenant,error_class}`                                 |        5 | `apps/search-ai/src/workers/branches/extraction-only.ts:125`                                 |
| `workflow_extraction_envelope_bytes{provider}` (Round 7)                            |        6 | `apps/search-ai/src/workers/branches/extraction-only.ts` (post-normalize)                    |
| `workflow_docling_callback_post_attempts_total{tenant,attempt}`                     |        7 | `apps/search-ai/src/workers/callback-poster.ts:76`                                           |
| `workflow_docling_callback_post_failures_total{tenant,error_class}` (Round 7 split) |        8 | `apps/search-ai/src/workers/callback-poster.ts:107`                                          |
| `workflow_docling_rate_limited_total{tenant,provider}`                              |        9 | `apps/workflow-engine/src/observability/extraction-metrics.ts` (recordExtractionRateLimited) |
| `workflow_extraction_too_large_total{provider,tenantId}`                            |       10 | `apps/search-ai/src/workers/branches/extraction-only.ts:112`                                 |
| `azure_di_extractions_total{tenant,project,status}`                                 |       11 | `apps/workflow-engine/src/observability/extraction-metrics.ts` (recordAzureDIExtraction)     |
| `azure_di_circuit_breaker_state{tenant}`                                            |       12 | breaker `onEvent` listener in `apps/workflow-engine/src/index.ts`                            |
| `azure_di_cost_cap_used_ratio{tenant,project,cap_kind}`                             |       13 | `apps/workflow-engine/src/services/azure-di-usage-counter.ts:emitCapMetric`                  |

## Backing data sources

- **OTel-meter metrics**: workflow-engine pod. `OTLPMetricExporter` ships to the OTel Collector, which Prometheus scrapes.
- **Log-line metrics**: search-ai pod. Emitted as `metric` log records (see `extraction-metrics.ts`). The log-scraper pipeline (Promtail → Loki → Recording Rules) derives Prometheus series from these lines until search-ai boots an OTel SDK.

## Variables

- `$tenant` — `label_values(workflow_docling_callback_post_attempts_total, tenant)` (multi)
- `$project` — `label_values(azure_di_extractions_total{tenant=~"$tenant"}, project)` (multi)

## Deploying

1. Copy `dashboard.json` to `abl-platform-deploy:grafana/dashboards/workflows-document-extraction.json`.
2. Run the deploy repo's dashboard sync (`make grafana-apply` or equivalent).
3. Verify the panels render in staging. The dashboard intentionally references metric names that may have zero series before the first traffic hits — the panels render empty until the feature flag is on.

## Out-of-band acceptance check

For Phase 4 exit criterion verification, run a single extraction against staging with the feature flag on and verify panels 1, 3, 4, 7, and 11 all show at least one data point in the next refresh window. The remaining panels (`worker_active_jobs`, `bullmq_queue_depth`, breaker state, cost-cap ratio, envelope size, rate-limited, too-large) populate as traffic patterns exercise their respective code paths.
