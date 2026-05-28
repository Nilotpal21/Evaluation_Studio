# Pipeline Observability & Testing — Design

**Ticket:** [ABLP-280](https://koreteam.atlassian.net/browse/ABLP-280)
**Date:** 2026-04-13
**Status:** ALPHA
**Owner:** Rakshak Kundarapu

---

## 1. Problem

Custom and built-in analytics pipelines can be created and configured in Studio, but once deployed there's no way to **observe, test, or validate** them. Users cannot:

- See which runs happened, whether they succeeded, and what errors they produced.
- Manually trigger a pipeline with sample data to verify it works before relying on real traffic.
- Preview the ClickHouse output a pipeline produced for a specific session or time window.
- See at a glance whether pipelines are healthy.

This blocks analytics deliverables (Average Handle Time, CSAT prediction, quality scoring, escalation analysis) that need trustworthy pipeline output.

## 2. Scope

**In scope (v1):**

1. Recent Runs view across all pipelines in a project, with built-in/custom/status/time filters.
2. Run Detail drawer showing step-by-step status, errors, input, and output.
3. ClickHouse data preview — filter-driven query UI scoped to a pipeline.
4. CSV export of query results.
5. Health summary endpoint and pipeline-card health badges.

**Deferred to v2:**

- Manual test interface (trigger templates + free-form JSON editor + Re-run action).
- Dedicated read-only ClickHouse user (`studio_reader`). Runtime reuses the shared `getClickHouseClient()` from `@agent-platform/database`; Studio proxies to runtime and never touches ClickHouse directly.

**Out of scope (deferred to v2):**

- Free-form SQL editor for ClickHouse.
- Saved queries / shareable links.
- Cross-pipeline JOIN queries.
- Real-time SSE streaming of run status (v1 uses polling).
- Aggregations and visualisations in the Data tab.
- Global tenant-admin view across projects.

## 3. UI Structure

### 3.1 `PipelinesListPage` — four tabs

`Built-in | Custom | Recent Runs | Data`

### 3.2 Recent Runs tab

Layout:

- **Health strip** (top): counts for last 24h — total / completed / failed / running / avg duration.
- **Filters:** Type (Built-in | Custom | All), Pipeline name, Status, Time range (default 24h), search by pipeline name.
- **Table:** status icon · pipeline name (B/C suffix) · trigger type · started · duration · actions (View · Re-run · Cancel).
- Auto-poll every 5s while any row is `running`/`pending`.
- Row click → opens Run Detail drawer.

### 3.3 Run Detail — slide-over drawer

Tabs inside: `Steps | Input | Output Data | Raw JSON`.

- **Steps:** chronological list of `PipelineRunRecord.steps`, each expandable to show input/output and inline errors. Failed step auto-expanded.
- **Input:** the trigger event JSON that started the run.
- **Output Data:** embeds the `<ClickHousePreviewTable />` pre-filtered to `runId = <current run>`.
- **Raw JSON:** full `PipelineRunRecord` for power users.
- **[Re-run with this input]** action at the bottom (disabled if `triggerInputTruncated`).

### 3.4 Test drawer — DEFERRED to v2

Manual test interface (trigger templates, JSON editor, Re-run action) deferred to v2. See §2 scope.

### 3.5 Data tab

Filter-driven ClickHouse query view:

- **Pipeline filter:** Type (Built-in | Custom | Any) → Pipeline name dropdown (only pipelines with a `store-results` node).
- **Session ID filter** (optional text input — common column across most pipelines).
- **Time range filter** (required; default last 24h).
- **`+ Add filter`** — shows columns the pipeline's schema declares `filterable: true` (ops: `=`, `in`, `contains`).
- **Project ID is implicit** — the whole surface is project-scoped; no explicit filter.
- Table: server-rendered columns with `runId` linked to Run Detail drawer.
- `[Query ▶]` and `[Export CSV]` buttons; row cap 500 (query) / 10000 (export).

### 3.6 `PipelineConfigPage` — two tabs

`Config | Runs`

- Config: existing content unchanged.
- Runs: reuses `<RecentRunsPanel>` pre-filtered to `pipelineId = current`.
- No Data tab — global Data tab with Pipeline filter covers that.

### 3.7 Pipeline-card health badge

On `BuiltinPipelinesList` / `CustomPipelinesList` cards:

- 🟢 green — last 24h >95% success
- 🟡 amber — 50–95%
- 🔴 red — <50% or last run failed
- ⚪ gray — no runs in 24h

Fed by the health summary endpoint's `byPipeline` array (single aggregation).

## 4. Backend Endpoints

### 4.1 Reuse (existing)

| Route                                     | Purpose                |
| ----------------------------------------- | ---------------------- |
| `GET /api/pipelines/runs/:runId`          | Run detail             |
| `GET /api/pipelines/:pipelineId/runs?...` | Per-pipeline runs list |
| `POST /api/pipelines/runs/:runId/cancel`  | Cancel running run     |

### 4.2 New

**A. Project-scoped runs list**

```
GET /api/projects/:projectId/pipeline-runs
  ?type=builtin|custom|all
  &pipelineId=...
  &status=pending|running|completed|failed|cancelled
  &since=<ISO-8601>  &until=<ISO-8601>
  &limit=20  &offset=0
→ { success, data: RunSummary[], pagination }
```

**B. Health summary**

```
GET /api/projects/:projectId/pipeline-runs/health?window=24h&pipelineId=?
→ { success, data: { total, completed, failed, running, cancelled, successRate, avgDurationMs, byPipeline? } }
```

**C. Manual test trigger — DEFERRED to v2**

**D. Trigger input templates — DEFERRED to v2**

**E. ClickHouse data query**

```
POST /api/projects/:projectId/pipeline-data/query
body: {
  pipelineId, sessionId?, runId?,
  timeRange: { from, to },
  filters?: [{ column, op: '='|'in'|'contains', value }],
  limit?, offset?
}
→ { success, data: { table, columns, rows }, pagination }
```

**F. ClickHouse data export** (streams `text/csv`)

```
POST /api/projects/:projectId/pipeline-data/export
body: same as E (no limit/offset)
```

**G. Pipeline output schema**

```
GET /api/pipelines/:pipelineId/output-schema
→ { success, data: { table, columns: [{ name, type, filterable, exportable, description? }] } }
```

**H. Previewable-pipelines list** (for the Data tab Pipeline dropdown)

```
GET /api/projects/:projectId/pipeline-data/previewable-pipelines
→ { success, data: [{ pipelineId, name, kind, table }] }
```

### 4.3 Ownership

Runtime (`apps/runtime`) owns all MongoDB and ClickHouse access for pipeline observability. The canonical endpoints live at `/api/projects/:projectId/pipeline-observability/*`. Studio exposes thin Next.js proxy routes at the existing client-facing paths and forwards requests to runtime — it never queries MongoDB or ClickHouse directly for observability data.

| Endpoint                  | Canonical (runtime path)                                                          | Studio proxy path                                            |
| ------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| A. Project runs list      | `GET /api/projects/:projectId/pipeline-observability/runs`                        | `GET /api/projects/:id/pipeline-runs`                        |
| B. Health summary         | `GET /api/projects/:projectId/pipeline-observability/runs/health`                 | `GET /api/projects/:id/pipeline-runs/health`                 |
| E. Data query             | `POST /api/projects/:projectId/pipeline-observability/data/query`                 | `POST /api/projects/:id/pipeline-data/query`                 |
| F. Data export (CSV)      | `POST /api/projects/:projectId/pipeline-observability/data/export`                | `POST /api/projects/:id/pipeline-data/export`                |
| G. Pipeline output schema | `GET /api/projects/:projectId/pipeline-observability/pipelines/:id/output-schema` | `GET /api/pipelines/:pipelineId/output-schema?projectId=...` |
| H. Previewable pipelines  | `GET /api/projects/:projectId/pipeline-observability/data/previewable-pipelines`  | `GET /api/projects/:id/pipeline-data/previewable-pipelines`  |

Runtime enforces: JWT auth, tenant + project scope, `analytics:read` permission, tenant rate limiting, force-injected `tenantId` + `projectId` on every ClickHouse/Mongo query. Studio proxies enforce JWT + `PROJECT_READ` + project-access check before forwarding.

## 5. Data Model Changes

### 5.1 `PipelineRunRecord` (Mongo)

Add:

- `projectId?: string` (denormalised from `PipelineConfig` at trigger time).
- `triggerInput?: Record<string, any>` (the raw trigger payload; required for Re-run).
- `triggerInputTruncated?: boolean` (true if payload >256 KB; Re-run disabled).

New indexes:

```
{ tenantId: 1, projectId: 1, startedAt: -1 }
{ tenantId: 1, projectId: 1, pipelineId: 1, startedAt: -1 }
```

Backfill: none — existing 90-day TTL rolls old records out.

### 5.2 ClickHouse output tables

- Add `runId String DEFAULT ''` column with `MinMax` index, one migration per built-in pipeline (10 files).
- Custom-pipeline save path auto-injects `runId` into `store-results` output schema if user omits it.

### 5.3 `store-results` node schema

Add `filterable: boolean` and `exportable: boolean` flags per column. Defaults: `filterable=false`, `exportable=true`. Built-in pipelines annotated per column in a single PR. Custom-pipeline editor UI gets checkboxes.

### 5.4 Migrations summary

| #   | Change                                                   | Scope      |
| --- | -------------------------------------------------------- | ---------- |
| M1  | `PipelineRunRecord.projectId` + `triggerInput` + indexes | Mongo      |
| M2  | ClickHouse `ADD COLUMN runId` (10 tables)                | ClickHouse |
| M3  | Output-schema `filterable`/`exportable` on 10 built-ins  | Code       |
| M4  | Custom-pipeline validation: auto-inject `runId`          | Code       |

## 6. Manual Trigger Path — DEFERRED to v2

The manual test trigger (Restate `manualRun` handler, `POST /api/pipelines/:pipelineId/test` route, trigger templates, Re-run action) is deferred to v2. The engine already has the `triggerManual` handler with `projectId` + `triggerInput` support; the Studio UI and route to invoke it will be added in a future iteration.

## 7. ClickHouse Preview Path

### 7.1 Query builder

All user-controlled values go through ClickHouse HTTP client parameter binding — no string concatenation.

- Column names allowlist-checked against the pipeline's `filterable: true` columns.
- Table name server-resolved from `pipelineId` + allowlist-regex-validated.
- `tenantId` and `projectId` force-injected into `WHERE` regardless of input.
- `LIMIT` clamped to 500 (query) / 10000 (export).
- `SETTINGS max_execution_time = 10, max_rows_to_read = 1000000, max_result_rows = 500` on every query.

### 7.2 Output schema resolution

Resolve `store-results` node from `PipelineDefinition.graph`. Cache in-process 60s TTL keyed by `(tenantId, pipelineId, def.version)`. Throws `NO_OUTPUT_TABLE` if the pipeline has no `store-results` node.

### 7.3 ClickHouse client

Runtime reuses the shared `getClickHouseClient()` from `@agent-platform/database`. Studio never opens a ClickHouse connection — it proxies the query/export POSTs to runtime, which runs the query and (for export) streams the CSV back. A dedicated read-only `studio_reader` user is deferred to v2; for now the query builder enforces execution time and scan caps via `SETTINGS` clauses.

### 7.4 CSV export

Same query builder. Differences: `LIMIT 10000`, columns filtered to `exportable: true`, `FORMAT CSVWithNames`, streamed response, audit-logged.

### 7.5 Count + pagination

First page runs `COUNT(*)` in parallel with a 3s cap; subsequent pages reuse a cached `countToken`. If count fails → UI shows "of many," `hasMore` derives from `rows.length === limit`.

### 7.6 Error codes

`NO_OUTPUT_TABLE`, `INVALID_FILTER`, `QUERY_TIMEOUT`, `SCAN_LIMIT`, `PAYLOAD_TOO_LARGE`, `UPSTREAM_UNAVAILABLE` — plus standard `UNAUTHORIZED`/`FORBIDDEN`/`NOT_FOUND`/`VALIDATION_ERROR`/`CONFLICT`/`RATE_LIMITED`.

## 8. Error Handling, Permissions, Observability

### 8.1 Isolation

- Every route: `requireTenantAuth` + project membership.
- Every Mongo query: `{ tenantId, projectId }` in filter.
- Cross-project access → 404 (no existence leak).
- ClickHouse queries force-inject `tenantId` + `projectId` in `WHERE`.

### 8.2 Permission matrix

| Action                      | Permission         | Audit                            |
| --------------------------- | ------------------ | -------------------------------- |
| List/view runs, view output | `pipeline:read`    | no                               |
| CSV export                  | `pipeline:read`    | **yes** (`pipeline.data.export`) |
| Cancel run                  | `pipeline:execute` | **yes** (`pipeline.run.cancel`)  |

### 8.3 Rate limits

| Route                           | Limit   |
| ------------------------------- | ------- |
| `POST .../pipeline-data/query`  | 60/min  |
| `POST .../pipeline-data/export` | 5/min   |
| `POST .../runs/:runId/cancel`   | 20/min  |
| Read endpoints                  | 600/min |

### 8.4 TraceStore events

New: `pipeline.data.queried`, `pipeline.data.exported`, `pipeline.run.cancelled`.

Existing `pipeline.run.started/completed/failed/step.*` events feed the Run Detail drawer unchanged.

### 8.5 Structured logging

`createLogger('pipeline-ui')`. Every `warn`/`error` carries `{ tenantId, projectId, userId, pipelineId?, runId? }`. No raw request bodies, no row payloads, no `triggerInput` contents — summaries only.

### 8.6 Defence-in-depth

UI constraints (filter dropdown, table dropdown) are convenience only. Every rule re-checked server-side: `column: 'rawLLMResponse'` on a non-filterable column → 400. `table: 'system.processes'` in request body → ignored. `limit: 99999999` → clamped.

## 9. Test Matrix

**E2E — minimum 5 scenarios:**

1. Cross-project isolation: project Y user cannot list runs from project X → 404.
2. Cancel running run → status transitions to `cancelled` + trace event emitted.
3. Data query with `sessionId` filter → only matching rows; unauthorised column filter → 400.
4. CSV export excludes non-exportable columns; audit log entry created.
5. Health summary returns correct counts for seeded run records.

**Integration — minimum 5 scenarios:**

1. Query builder tenant/project isolation holds even when body attempts spoof.
2. Output schema resolver handles pipelines without `store-results`.
3. Manual trigger persists `PipelineRunRecord` with `status: 'running'` and correct `projectId` denormalisation.
4. Health badge derivation over seeded run records.
5. Project-scoped runs list returns only runs for the queried project.

**Unit:** query builder (all operators, allowlist, parameter binding), schema resolver cache invalidation, Zod validation.

**No `vi.mock` of `@agent-platform/*` or `@abl/*` (CLAUDE.md).** External clients mocked via DI where needed.

## 10. Rollout

Sequence (respecting 40-file / 3-package per-commit limits, `[ABLP-280]` prefix):

1. `feat(pipeline-engine): projectId + triggerInput on RunRecord`
2. `feat(pipeline-engine): output-schema metadata on 10 built-ins + runId column`
3. `feat(database): ClickHouse migrations (10 tables)`
4. `feat(studio): Recent Runs tab + run detail drawer + APIs (A, B)`
5. `feat(studio): Data tab + ClickHouse query/export routes (E, F, G, H)`
6. `feat(studio): health summary + pipeline card badges`
7. `test(studio): E2E for data query + isolation`
8. `docs: post-impl-sync`

No feature flag — read-only for existing projects (additive). Manual test trigger + Re-run deferred to v2.

## 11. Open Questions (none currently)

All decisions converged during brainstorming (2026-04-13). If implementation uncovers gaps, log them in `docs/sdlc-logs/pipeline-observability/` and update this doc.

## 12. References

- Ticket: [ABLP-280](https://koreteam.atlassian.net/browse/ABLP-280)
- Existing pipeline package: `packages/pipeline-engine/README.md`, `packages/pipeline-engine/agents.md`
- CLAUDE.md Core Invariants (Resource Isolation, Centralized Auth, Stateless, Traceability, Compliance, Performance)
- Existing run record: `packages/pipeline-engine/src/schemas/pipeline-run-record.schema.ts`
- Existing UI: `apps/studio/src/components/pipelines/`
