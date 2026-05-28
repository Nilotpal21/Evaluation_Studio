# Document Extraction — Beta Rollout Runbook (Phase 5)

**Feature**: document-extraction-integrations (ABLP-1073)
**Phase**: Phase 5 — Beta rollout, 1-week soak
**LLD reference**: §3 Phase 5 tasks 5.1–5.4
**Owner**: Workflows team
**On-call**: see PagerDuty rotation `workflows-oncall`

---

## 0. Pre-rollout checklist

| Item                                                                             | Owner     | Done? |
| -------------------------------------------------------------------------------- | --------- | ----- |
| Phase 4 commit set merged to `main` and deployed to staging                      | Workflows | ☐     |
| Grafana dashboard `Workflows → Document Extraction` rendering against staging    | SRE       | ☐     |
| Prometheus alert rules (`alerts.yaml`) loaded in staging                         | SRE       | ☐     |
| Coroot configured for `workflow-engine` + `search-ai` pods                       | SRE       | ☐     |
| Load test plan executed (`load-test-plan.md`); per-pod saturation point recorded | Workflows | ☐     |
| `DOCLING_WORKFLOW_RATE_LIMIT_PER_MIN` tuned to load-test result                  | Workflows | ☐     |
| 3 internal tenants identified (engineering, ops, support)                        | Product   | ☐     |
| Azure DI resource provisioned in engineering's Azure tenant                      | Workflows | ☐     |

## 1. Per-tenant enable procedure

For each of the 3 internal beta tenants, repeat:

```bash
# Step 1 — flip the flag for the tenant only (NOT a global default change)
pnpm jira:update -- ABLP-1073 --comment "Beta enable for tenant=<tenant-id>"
# Set the tenant-config override via your tenant-management tool. Example shape:
# tenant_config.<tenant-id>.env.WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED = "true"
# Restart workflow-engine + search-ai pods, OR use a hot-reload signal if available.

# Step 2 — confirm the tenant's Studio shows the Integrations page
#   Visit https://studio.example.com/projects/<projectId>/settings/integrations
#   The "Document Extraction" section should be visible.

# Step 3 — onboard Azure DI for tenants that need it
#   Studio: Settings → Integrations → Azure Document Intelligence → Configure
#   Fields: endpoint URL (e.g. https://<resource>.cognitiveservices.azure.com),
#           apiKey, apiVersion (default 2023-07-31), defaultModel (prebuilt-layout
#           or prebuilt-document).
#   Save → the connection lands in ConnectorConnection with status='active'.

# Step 4 — confirm the workflow canvas Integration Picker shows Docling + Azure DI
#   Studio: Workflows → New workflow → drop a connector_action node →
#   "Document Extraction" group should list both providers.

# Step 5 — smoke test
#   Build a single-step workflow: extract_document on a known small PDF.
#   Run it. Confirm step.status reaches 'completed' and step.output contains
#   a populated `envelope.content`.

# Step 6 — observability check
#   In Grafana, the tenant should appear in the `tenant` filter dropdown of
#   the dashboard within 30 seconds of the first extraction.
```

## 2. Daily soak SOP (5 business days)

Run this checklist every morning during the soak:

1. **Dashboard sweep** — open `Workflows → Document Extraction`. For each of the 3 beta tenants:
   - Panel 1: queue depths stay near zero (no backlog)
   - Panel 3: p95 wait duration ≤ SLO (25 s Docling / 20 s Azure DI)
   - Panel 4: parked promises gauge stays in single digits
   - Panel 8: callback failures broken down by `error_class` — flag any TIMESTAMP_EXPIRED spikes (clock skew between pods)
   - Panel 12: breaker state should be 0 (CLOSED); investigate any HALF_OPEN/OPEN periods
   - Panel 13: cost-cap ratio per tenant — yellow >60%, red >80%
2. **Alert review** — any alerts that fired overnight? Categorize each:
   - `DoclingIngestionQueueBacklog` / `WorkflowDoclingQueueBacklog` → check Docling pod health
   - `WorkflowDoclingCallbackFailureRate` → bisect `error_class`; if TIMESTAMP_EXPIRED, check NTP / pod clock drift
   - `WorkflowDoclingRateLimitedExcessive` → tenant is exceeding their rate budget; tune limit OR explain to tenant owner
   - `AzureDICostCapApproaching` → reach out to the project owner about raising the cap
   - `AzureDICircuitBreakerOpen` → Azure DI service health is degraded; check Azure status page
3. **Sample-trace audit** — pick 3 random successful extractions and 1 random failure. Verify:
   - Audit event has the canonical envelope shape (`actor`, `tenantId`, `projectId`, `connector`, `action`, `sourceUrl`, `sizeBytes`, `durationMs`, `status`)
   - `sourceUrl` is host-only (no path/query)
   - `step.output.envelope.content` has no raw PII / API keys (scrubber working)
4. **Cost monitoring** — pull the Azure DI usage counter for each tenant's connection. Track day-over-day growth.
5. **Issue tracking** — log any P0/P1 incident in Jira against ABLP-1073 with `beta-incident` label.

## 3. Tuning playbook

| Symptom                                        | Tune                                                                                     |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Sustained queue depth > 50 on workflow-docling | Raise `WORKFLOW_DOCLING_CONCURRENT_JOBS` (currently 2) up to the runtime cap             |
| Rate-limited > 1% for one tenant               | Raise `ConnectorConnection.limitPerMinute` for that tenant via Studio                    |
| Callback p95 latency exceeds SLO               | Check Docling pod CPU; if Docling is bottlenecked, scale the Docling Deployment          |
| Cost-cap ratio repeatedly > 80%                | Coordinate with project owner; raise hard cap via the usage routes                       |
| Breaker OPEN events on Azure DI                | Check Azure status; if persistent, fall back tenant traffic to Docling via Studio toggle |

## 4. Rollback procedure

If a P0/P1 incident occurs OR the feature is otherwise unsafe to continue:

```bash
# Step 1 — flip the flag OFF for the affected tenant(s)
# tenant_config.<tenant-id>.env.WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED = "false"

# Step 2 — restart workflow-engine + search-ai pods if hot-reload isn't wired.
# In-flight extractions complete via the unauthenticated callback route
# (the route does NOT gate on the flag — Phase 4 rollback test confirms this).

# Step 3 — confirm:
#   - New extractions fail with FEATURE_DISABLED (HTTP 404 from the Azure DI
#     usage routes; "connector unavailable" from the workflow canvas)
#   - Worker B drains within the existing job timeout window
#   - Worker A (ingestion path) is unaffected — search-docling-extraction queue
#     keeps draining normally

# Step 4 — file a Jira incident under ABLP-1073 with label "beta-rollback".
# Capture: timestamp, affected tenants, alert fingerprint, dashboard screenshots.

# Step 5 — DO NOT change global env defaults during a per-tenant rollback.
# The feature is still live for non-affected tenants.
```

Cluster-wide rollback (e.g. the encryption manifest change misbehaves):

```bash
# Revert the Phase 4 commit set OR set the env flag off for ALL tenants.
# Pre-existing encrypted BullMQ jobs will fail to dequeue if you revert the
# manifest change without restarting workers; flag-off-then-revert is the
# safer order. The `_enc`-flag absence handles the forward path (pre-fix jobs
# still work after the manifest change); the reverse path needs cleanup.
```

## 5. Phase 5 exit gate

Phase 5 is COMPLETE when:

- ☐ ≥ 100 successful extractions across the 3 beta tenants (oracle C5)
- ☐ 0 P0 / P1 incidents over 5 business days
- ☐ p95 Docling extraction < 25 s, Azure DI < 20 s (HLD §4.3 #9 targets)
- ☐ Load-test report committed at `docs/sdlc-logs/document-extraction-integrations/load-test-results-<date>.md`
- ☐ All Grafana panels populated with real traffic; alerts validated against real signal
- ☐ Feature spec status promoted PLANNED → BETA via `/post-impl-sync`

Once all five are checked, hand off to Phase 6 (GA).

## 6. Communication

| Audience               | Message                                                                                         | When         |
| ---------------------- | ----------------------------------------------------------------------------------------------- | ------------ |
| Beta tenant owners     | "Document extraction is live for your project. See <docs-url>."                                 | Day 1        |
| #workflows-engineering | Daily dashboard snapshot + any alerts fired                                                     | Each morning |
| #engineering-ops       | Cost-cap ratio if any tenant exceeds 80%                                                        | Immediate    |
| Beta tenant owners     | "Beta soak complete; feature is now in BETA status. Production rollout target: <date>."         | Day 6        |
| All staff              | "Document extraction (Docling + Azure DI) now available for self-service workflow integration." | At GA        |
