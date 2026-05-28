# Document Extraction — Load Test Plan (Phase 5)

**Feature**: document-extraction-integrations (ABLP-1073)
**Phase**: Phase 5 — Beta rollout / saturation soak
**LLD task**: 5.4 — "Add capacity report via the `load-test-analysis` skill (k6 + Coroot saturation analysis)."
**Owner**: Workflows team

---

## 1. Goal

Validate that the document-extraction integration meets HLD §4.3 latency targets and queue-saturation budgets under realistic concurrent load, and identify the per-pod saturation point before defaulting the feature flag on (Phase 6).

## 2. SLO targets (HLD §4.3 #9)

| Provider | p50 e2e | p95 e2e | p99 e2e | Failure budget                  |
| -------- | ------- | ------- | ------- | ------------------------------- |
| Docling  | ≤ 10 s  | ≤ 25 s  | ≤ 60 s  | < 1% callback delivery failures |
| Azure DI | ≤ 8 s   | ≤ 20 s  | ≤ 60 s  | < 1% callback delivery failures |

Trigger latency (engine accepts `POST /execute`) must stay ≤ 500 ms p95 — the heavy work belongs to the worker.

## 3. Saturation matrix

| Run       | MAX_VUS                    | DURATION_MINUTES | Doc mix                              | Notes                                      |
| --------- | -------------------------- | ---------------- | ------------------------------------ | ------------------------------------------ |
| Smoke     | 5                          | 5                | 1 × 500 KB PDF                       | Sanity check the wiring, dashboard, alerts |
| Light     | 20                         | 15               | 50/50 Docling/Azure DI, 1 MB PDFs    | Baseline — should be well under SLO        |
| Sustained | 50                         | 30               | 60/40 Docling/Azure DI, 1–5 MB mixed | The realistic-beta load profile            |
| Stress    | 100                        | 20               | 60/40, 1–25 MB mixed                 | Find the per-pod saturation point          |
| Burst     | 200 (ramp 0→200 over 60 s) | 10               | 60/40, 1–10 MB mixed                 | Validate two-queue isolation under skew    |

Per-pod saturation = the VU count at which p95 e2e exceeds the target AND/OR callback failure rate exceeds 1% AND/OR the `bullmq_queue_depth{queue="workflow-docling-extraction"}` alert fires for 10 min.

## 4. Pre-flight (manual)

| #   | Step                                                                                                                                                       | Owner    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | Rotate Azure DI subscription key; place rotated key in operator's local `.env` (NEVER commit; NEVER paste in chat).                                        | Operator |
| 2   | Provision the Azure DI `ConnectorConnection` for the bench project via the Studio integrations page.                                                       | Operator |
| 3   | Deploy 2 single-step extraction workflows (`bench-docling-extract`, `bench-azure-di-extract`). Each contains one `extract_document` connector_action node. | Operator |
| 4   | Capture the workflow IDs into env vars `BENCH_DOCLING_WORKFLOW_ID` / `BENCH_AZURE_DI_WORKFLOW_ID`.                                                         | Operator |
| 5   | Provision a CSV of test-document URLs (sub-1MB to 25MB PDFs) in `BENCH_TEST_DOCUMENT_URLS`.                                                                | Operator |
| 6   | Enable `WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED=true` for the bench tenant.                                                                           | Operator |
| 7   | Confirm Grafana dashboard "Workflows → Document Extraction" renders panels 1, 3, 4, 7.                                                                     | Operator |
| 8   | Confirm Coroot is collecting metrics for `workflow-engine` and `search-ai` pods.                                                                           | Operator |

## 5. Run

```bash
# Smoke
k6 run benchmarks/saturation/document-extraction.ts \
  -e WORKFLOW_ENGINE_URL=https://staging.example.com/api/workflow-engine \
  -e PROJECT_ID=p-bench-1 \
  -e BENCH_DOCLING_WORKFLOW_ID=$DOCLING_WF \
  -e BENCH_AZURE_DI_WORKFLOW_ID=$AZURE_WF \
  -e BENCH_TEST_DOCUMENT_URLS="$URLS" \
  -e MAX_VUS=5 -e DURATION_MINUTES=5

# Sustained (the headline run)
k6 run benchmarks/saturation/document-extraction.ts \
  -e WORKFLOW_ENGINE_URL=https://staging.example.com/api/workflow-engine \
  -e PROJECT_ID=p-bench-1 \
  -e BENCH_DOCLING_WORKFLOW_ID=$DOCLING_WF \
  -e BENCH_AZURE_DI_WORKFLOW_ID=$AZURE_WF \
  -e BENCH_TEST_DOCUMENT_URLS="$URLS" \
  -e MAX_VUS=50 -e DURATION_MINUTES=30 \
  -e K6_CLOUD_PROJECT_ID=$K6_CLOUD_PROJECT_ID
```

For Grafana Cloud k6 runs, prepend `k6 cloud` instead of `k6 run`. Each run emits a JSON summary; capture it into `summary-<run>.json` and the Coroot CSV snapshot.

## 6. Coroot capture window

For each k6 run, capture the following Coroot metric series for the duration of the run:

- `workflow-engine` pod — CPU%, memory, p95 HTTP latency, BullMQ wait/active gauges, OTel scrape interval timing
- `search-ai` pod — CPU%, memory, worker concurrency, queue depth (both queues), p95 callback poster latency
- MongoDB — `WorkflowExecution` read/write latency, lock contention
- Redis — BullMQ queue depths, command latency, eviction count (the new at-rest-encrypted `callbackSecret` adds ciphertext bytes per job)
- Docling pod — p95 HTTP latency, CPU%, GPU memory if applicable
- Network — internal east-west bandwidth between workflow-engine and search-ai

The `load-test-analysis` skill stitches these together into a saturation report.

## 7. Pass/fail criteria

A run PASSES when:

- `extraction_docling_e2e_ms` p95 ≤ 25,000
- `extraction_azure_di_e2e_ms` p95 ≤ 20,000
- `extraction_trigger_ms` p95 ≤ 500
- `extraction_success_rate` ≥ 0.95
- `http_req_failed` rate < 0.05
- No P0/P1 alert fires during the run (queue-depth thresholds, callback failure ratio, breaker OPEN)
- No pod restarts

A run FAILS when any of the above is violated; the result is then characterized:

- Sustained / Stress with FAIL → that VU count is past saturation; document the actual per-pod limit
- Burst with FAIL on the workflow queue alone → two-queue isolation is working (ingestion path untouched)
- Burst with FAIL on both queues → the two-queue topology is starving (GAP-005); raise reserved-slot config

## 8. Reporting

After all runs complete, the operator hands the JSON summaries + Coroot CSVs back to the analysis pipeline. The output is committed at:

```
docs/sdlc-logs/document-extraction-integrations/load-test-results-<YYYY-MM-DD>.md
```

Template sections:

- Run matrix (smoke/light/sustained/stress/burst) with PASS/FAIL per row
- p95/p99 latency per provider per run
- Per-pod saturation point (VU count at first SLO breach)
- Coroot resource-utilization peaks per service
- Recommended `DOCLING_WORKFLOW_RATE_LIMIT_PER_MIN` adjustment based on the observed per-tenant peak
- Recommended Phase 6 GA gate decision (proceed / hold)

## 9. Rollback during the test

If at any point during a run the system shows production-incident symptoms (alerts on real-tenant queues, breaker OPEN on a non-bench tenant), abort the run with `Ctrl-C` AND immediately:

1. Flip `WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED=false` for the bench tenant via tenant-config override.
2. Confirm the Grafana dashboard shows the bench-queue draining to zero.
3. Restart the workflow-engine deployment to clear in-memory metric caches (defensive — they're capped at 10k but the restart is cleaner).

In-flight non-bench tenant extractions continue to drain via the unauthenticated callback route (verified by the `document-extraction-rollback.test.ts` flag-off in-flight scenario).
