# Feature: Pipeline Observability

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Pipeline Engine](./pipeline-engine.md)
**Status**: ALPHA
**Feature Area(s)**: `observability`, `agent lifecycle`
**Package(s)**: `packages/pipeline-engine`, `packages/database`, `apps/studio`
**Owner(s)**: Platform team
**Testing Guide**: `../testing/pipeline-engine.md`
**Last Updated**: 2026-04-25

---

## 1. Introduction / Overview

### Problem Statement

Custom and built-in analytics pipelines can be created and configured in Studio, but once deployed there is no way to observe, test, or validate them. Operators cannot see which runs happened, whether they succeeded, or what errors they produced. There is no way to manually trigger a pipeline with sample data before relying on real traffic. ClickHouse output produced by a pipeline for a specific session or time window is invisible in Studio. There is no at-a-glance health indicator on pipeline cards.

This blocks analytics deliverables (Average Handle Time, CSAT prediction, quality scoring, escalation analysis) that depend on trustworthy pipeline output.

### Goal Statement

Provide a complete observability and testing surface for pipelines: recent runs with filtering, run detail drill-down, manual test execution with templates, ClickHouse data preview with CSV export, and per-pipeline health badges. All scoped by project and tenant, all integrated into the existing Studio Pipelines page.

### Summary

Pipeline Observability adds three capabilities to the Studio Pipelines page:

1. **Recent Runs** -- A filterable, auto-polling table of pipeline runs across all pipelines in a project, with a health strip showing aggregate counts and a slide-over drawer for run detail (steps, input, output data, raw JSON).
2. **ClickHouse Data Preview** -- A filter-driven query UI scoped to a pipeline's declared output schema, with column allowlist enforcement, parameterized queries, and CSV export. No free-form SQL.
3. **Health Badges** -- Per-pipeline health dots on cards (green/amber/red/gray) driven by aggregated run success rates from the health endpoint.

Backend changes include schema denormalization (`projectId`, `triggerInput` on `PipelineRunRecord`), ClickHouse column additions (`run_id`, `pipeline_id` on all 18 analytics tables), and trigger input validation.

> **Deferred to v2:** Manual Test Drawer (trigger selector, template-driven JSON editor, Re-run action) and dedicated read-only ClickHouse user (`studio_reader`). Studio currently reuses the shared ClickHouse client from `@agent-platform/database`.

---

## 2. Scope

### Goals

- Show recent pipeline runs across all pipelines in a project with built-in/custom/status/time filters
- Provide run detail drawer with step-by-step status, errors, input, and output data
- Provide ClickHouse data preview filtered by pipeline output schema columns
- Export query results as CSV (10 000-row cap)
- Show at-a-glance health badges on pipeline cards

### Non-Goals (Out of Scope)

- **Manual Test Drawer** — trigger selector, template-driven JSON editor, Re-run action (deferred to v2)
- **Dedicated ClickHouse reader user** — `studio_reader` with readonly profile (deferred to v2; reusing shared client)
- Free-form SQL editor for ClickHouse
- Saved queries or shareable links
- Cross-pipeline JOIN queries
- Real-time SSE streaming of run status (v1 uses polling)
- Aggregations and visualizations in the Data tab
- Global tenant-admin view across projects
- **Session-page pipeline analytics** — inline display of pipeline results (sentiment, intent, quality, friction, etc.) on the session detail page (`/projects/:projectId/sessions/:sessionId`). Planned for a follow-up phase (see Phase 12 below).

---

## 3. User Stories

1. As a **pipeline operator**, I want to see which pipeline runs happened in the last 24 hours so that I can verify pipelines are executing on schedule.
2. As a **pipeline operator**, I want to drill into a failed run and see which step failed and why so that I can diagnose and fix the pipeline definition.
3. As a **data analyst**, I want to preview the ClickHouse output of a pipeline with filters so that I can verify data quality without switching to a ClickHouse client.
4. As a **data analyst**, I want to export filtered query results as CSV so that I can analyze pipeline output in external tools.
5. As a **project manager**, I want to see a green/amber/red health indicator on each pipeline card so that I can spot problems at a glance.

---

## 4. Functional Requirements

1. **FR-1**: The system must provide a `GET /api/projects/:projectId/pipeline-runs` endpoint returning paginated, filterable run records scoped by tenant and project.
2. **FR-2**: The system must provide a `GET /api/projects/:projectId/pipeline-runs/health` endpoint returning aggregate run counts (total, completed, failed, running) for configurable time windows (1h, 24h, 7d) and per-pipeline breakdowns.
3. **FR-3**: The system must provide a `POST /api/projects/:projectId/pipeline-data/query` endpoint that executes parameterized ClickHouse queries with column allowlist enforcement, operator allowlist (=, in, contains), 500-row cap, and 10s timeout.
4. **FR-4**: The system must provide a `POST /api/projects/:projectId/pipeline-data/export` endpoint that streams CSV with a 10 000-row cap, 5/min rate limit, and audit logging.
5. **FR-5**: The system must provide a `GET /api/pipelines/:pipelineId/output-schema` endpoint that reads the `store-results` node from the pipeline definition and returns column metadata including filterable flags.
6. **FR-6**: The system must denormalize `projectId` and `triggerInput` onto `PipelineRunRecord` at creation time to enable project-scoped queries without joins.
7. **FR-7**: The system must add `run_id` and `pipeline_id` columns with minmax indexes to all 18 ClickHouse analytics tables and write these fields from all compute services and store-results.
8. **FR-8**: Custom pipeline Store Results must support a shared analytics table strategy: ClickHouse stores one numeric score projection (`score_name`, `score_path`, `score_value`) plus metadata for filtering, while MongoDB stores full document payloads for nested audit/debug data.

> **Deferred FRs (v2):** Manual test trigger endpoint (`POST /api/pipelines/:pipelineId/test`), trigger input validation, trigger template JSON files.
>
> **Removed after design:** A stuck-run watchdog (`promoteStuckRuns`) was specified but the bootstrap call was never wired, and Restate's own delivery guarantees already cover the fire-and-forget trigger path. Removed in 2026-04-15 ABLP-280 cleanup; revive from git history if orphan `status: 'running'` rows appear in production.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                            |
| -------------------------- | ------------ | ---------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Runs and data are project-scoped                                 |
| Agent lifecycle            | NONE         |                                                                  |
| Customer experience        | NONE         | Internal operator tooling                                        |
| Integrations / channels    | NONE         |                                                                  |
| Observability / tracing    | PRIMARY      | Core purpose: observe pipeline execution                         |
| Governance / controls      | SECONDARY    | Rate limits, permission checks, audit logging on test and export |
| Enterprise / compliance    | SECONDARY    | Tenant isolation on all queries, parameterized ClickHouse access |
| Admin / operator workflows | PRIMARY      | Operators use this to validate and debug pipelines               |

### Related Feature Integration Matrix

| Related Feature                                       | Relationship Type | Why It Matters                                    | Key Touchpoints                    | Current State |
| ----------------------------------------------------- | ----------------- | ------------------------------------------------- | ---------------------------------- | ------------- |
| [Pipeline Engine](./pipeline-engine.md)               | extends           | Adds observability to the core pipeline framework | PipelineRunRecord, PipelineTrigger | BETA          |
| [Tracing & Observability](./tracing-observability.md) | shares data with  | Run data complements trace events                 | run_id correlates across both      | STABLE        |

---

## 6. Design Considerations

- **Recent Runs tab** and **Data tab** are new tabs on the existing `PipelinesListPage`, alongside Built-in and Custom tabs.
- **Run Detail** is a slide-over drawer (not a full page) to allow quick inspection without losing list context.
- **Data preview** is filter-driven with no free-form SQL to enforce security invariants (column allowlist, parameterized queries, tenant isolation).
- **Health badges** use a color scheme: green (>95% success), amber (50-95%), red (<50%), gray (no runs in window).

---

## 7. Technical Considerations

- ClickHouse queries always include `tenant_id`, `project_id`, and `pipeline_id` in WHERE clauses (enforced by query builder).
- Studio reuses the shared `getClickHouseClient()` from `@agent-platform/database`. Query safety enforced server-side via `SETTINGS max_execution_time=10, max_result_rows=500`.
- Schema resolution caches pipeline output schemas for 60 seconds to avoid repeated MongoDB lookups.
- Stuck-run cleanup relies on Restate's own delivery guarantees plus the 90-day `PipelineRunRecord` TTL; no periodic watchdog runs.

---

## 8. How to Consume

### Studio UI

- **Pipelines page > Recent Runs tab**: View all pipeline runs for the current project. Filter by type, pipeline, status, and time window. Click a row to open Run Detail drawer.
- **Pipelines page > Data tab**: Select a pipeline, apply column filters, preview ClickHouse output. Export as CSV.
- **Pipeline cards**: Health dot (green/amber/red/gray) indicating recent run success rate.
- **PipelineConfigPage > Runs tab**: Embedded recent runs panel filtered to the current pipeline.

### API (Studio)

| Method | Path                                                           | Purpose                                          |
| ------ | -------------------------------------------------------------- | ------------------------------------------------ |
| GET    | `/api/projects/:projectId/pipeline-runs`                       | List paginated, filterable pipeline runs         |
| GET    | `/api/projects/:projectId/pipeline-runs/health`                | Aggregate run health with per-pipeline breakdown |
| GET    | `/api/pipelines/:pipelineId/output-schema`                     | Get pipeline output schema for data preview      |
| GET    | `/api/projects/:projectId/pipeline-data/previewable-pipelines` | List pipelines with store-results nodes          |
| POST   | `/api/projects/:projectId/pipeline-data/query`                 | Execute parameterized ClickHouse query           |
| POST   | `/api/projects/:projectId/pipeline-data/export`                | Stream CSV export (rate-limited, audit-logged)   |

### Admin Portal

Not applicable. Pipeline observability is project-scoped.

### Channel / SDK / Voice / A2A / MCP Integration

Not applicable. This is an internal operator tooling feature.

---

## 9. Data Model

### Collections / Tables

```text
Collection: pipeline_run_records (MongoDB)
Fields (new/modified):
  - projectId: string (optional, indexed — denormalized from PipelineConfig)
  - triggerInput: Mixed (optional — raw trigger payload for Re-run)
  - triggerInputTruncated: boolean (optional — true if input exceeded storage limit)
Indexes (new):
  - { tenantId: 1, projectId: 1, startedAt: -1 }
  - { tenantId: 1, projectId: 1, pipelineId: 1, startedAt: -1 }
```

```text
Tables: All 18 ClickHouse analytics tables
Columns (new):
  - run_id: String (with minmax index)
  - pipeline_id: String (with minmax index)
```

```text
Table: abl_platform.custom_pipeline_results
Purpose:
  Shared Store Results target for custom pipeline analytics scores.
Columns:
  - tenant_id: String
  - project_id: String
  - pipeline_id: String
  - pipeline_name: String
  - run_id: String
  - step_id: String
  - source_step: String
  - score_name: LowCardinality(String)
  - score_path: String
  - score_value: Nullable(Float64)
  - output_json: String (minimal audit payload, not the primary analytics surface)
Indexes:
  - minmax indexes for tenant/project/pipeline/run metadata
  - set index on score_name
```

```text
Collection: custom_pipeline_results (MongoDB)
Purpose:
  Shared Store Results target for nested custom pipeline documents.
Document shape:
  - tenantId, projectId, pipelineId, pipelineName, runId, stepId, sourceStep
  - storageStrategy: score_and_document | document_only
  - output: Mixed (full selected document payload)
  - createdAt / updatedAt
```

### Key Relationships

- `PipelineRunRecord.pipelineId` references `PipelineDefinition._id`
- `PipelineRunRecord.projectId` denormalized from `PipelineConfig.projectId`
- ClickHouse `run_id` correlates with `PipelineRunRecord._id`
- ClickHouse `pipeline_id` correlates with `PipelineDefinition._id`
- Shared custom pipeline ClickHouse rows use `pipeline_id` plus `score_name` / `score_value` for analytics filters.
- Shared MongoDB custom pipeline documents use `pipelineId` plus `sourceStep` when nested output inspection is needed.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                                         | Purpose                                      |
| ---------------------------------------------------------------------------- | -------------------------------------------- |
| `packages/pipeline-engine/src/schemas/pipeline-run-record.schema.ts`         | Extended schema with projectId, triggerInput |
| `packages/pipeline-engine/src/pipeline/handlers/pipeline-trigger.service.ts` | Manual trigger with input validation         |
| `packages/pipeline-engine/src/pipeline/handlers/pipeline-scheduler.ts`       | Cron scheduler (watchdog handler removed)    |

### Routes / Handlers

| File                                                                                        | Purpose                    |
| ------------------------------------------------------------------------------------------- | -------------------------- |
| `apps/studio/src/app/api/projects/[projectId]/pipeline-runs/route.ts`                       | List runs, health endpoint |
| `apps/studio/src/app/api/projects/[projectId]/pipeline-runs/health/route.ts`                | Health aggregation         |
| `apps/studio/src/app/api/pipelines/[pipelineId]/output-schema/route.ts`                     | Output schema resolver     |
| `apps/studio/src/app/api/projects/[projectId]/pipeline-data/query/route.ts`                 | ClickHouse query           |
| `apps/studio/src/app/api/projects/[projectId]/pipeline-data/export/route.ts`                | CSV export                 |
| `apps/studio/src/app/api/projects/[projectId]/pipeline-data/previewable-pipelines/route.ts` | Previewable pipeline list  |

### UI Components

| File                                                                   | Purpose                                         |
| ---------------------------------------------------------------------- | ----------------------------------------------- |
| `apps/studio/src/components/pipelines/runs/RecentRunsPanel.tsx`        | Recent runs table with health strip and filters |
| `apps/studio/src/components/pipelines/runs/RunDetailDrawer.tsx`        | Run detail slide-over with tabs                 |
| `apps/studio/src/components/pipelines/runs/HealthStrip.tsx`            | Aggregate health bar                            |
| `apps/studio/src/components/pipelines/runs/RunFilters.tsx`             | Type/pipeline/status/window filters             |
| `apps/studio/src/components/pipelines/data/PipelineDataPanel.tsx`      | Data tab container with filter UI               |
| `apps/studio/src/components/pipelines/data/ClickHousePreviewTable.tsx` | Query results table with export                 |
| `apps/studio/src/components/pipelines/data/DataFilterRow.tsx`          | Individual column filter                        |

### Jobs / Workers / Background Processes

_None._ Stuck-run cleanup previously handled by a Restate virtual-object watchdog was removed in 2026-04-15 ABLP-280 cleanup; the 90-day `PipelineRunRecord` TTL is the sole garbage-collection path for orphaned records.

### Tests

| File                                                                          | Type        | Coverage Focus                                           |
| ----------------------------------------------------------------------------- | ----------- | -------------------------------------------------------- |
| `apps/studio/src/lib/pipeline-data/schema-resolver.test.ts`                   | integration | Schema resolution from MongoDB (8 tests)                 |
| `apps/studio/src/lib/pipeline-data/query-builder.test.ts`                     | unit        | SQL construction, allowlist, parameterization (18 tests) |
| `apps/studio/src/__tests__/pipelines/pipeline-project-isolation.test.ts`      | integration | Project-scoped run queries (3 tests)                     |
| `packages/pipeline-engine/src/__tests__/run-record-project-isolation.test.ts` | integration | Run record project isolation                             |

---

## 11. Configuration

### Environment Variables

| Variable              | Default | Description                                                   |
| --------------------- | ------- | ------------------------------------------------------------- |
| `RESTATE_INGRESS_URL` | —       | Restate ingress URL for schedule triggers                     |
| `CLICKHOUSE_URL`      | —       | ClickHouse URL for data queries (shared with pipeline-engine) |

### Runtime Configuration

- Export route rate limit: 5 requests/minute per user
- Query row cap: 500 rows
- Export row cap: 10 000 rows
- Query timeout: 10 seconds
- Schema cache TTL: 60 seconds
- Health endpoint time windows: 1h, 24h, 7d

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| Project isolation | Every pipeline-runs and data query includes `projectId`. Cross-project access returns 404.               |
| Tenant isolation  | Every query includes `tenantId`. ClickHouse queries enforce `tenant_id` via query builder WHERE clauses. |
| User isolation    | Test and export actions require `pipeline:execute` permission. Audit-logged per user.                    |

### Security & Compliance

- ClickHouse queries use parameterized `query_params` — no string concatenation of user input.
- Column allowlist checked against `schema.columns.filterable` — users cannot query arbitrary columns.
- Table name resolved server-side from `pipelineId` — never from request body.
- Query safety enforced server-side via `SETTINGS max_execution_time=10, max_result_rows=500`.
- Export actions audit-logged with user context.

### Performance & Scalability

- Recent Runs auto-polls every 5 seconds (only while running/pending rows exist).
- Health endpoint uses MongoDB aggregation for efficient counting.
- ClickHouse queries have 10-second timeout and 500-row cap for interactive use.
- Schema resolution cached for 60 seconds to avoid MongoDB round-trips.

### Reliability & Failure Modes

- Stuck-run cleanup relies on Restate's delivery guarantees for the fire-and-forget trigger path plus the 90-day `PipelineRunRecord` TTL. A periodic watchdog was specified but removed during implementation cleanup — no dedicated sweeper runs.
- ClickHouse query failures return structured errors with the specific failure code.
- Rate limiting prevents abuse of test and export endpoints.
- Schema resolution fails gracefully if the pipeline has no `store-results` node.

### Observability

- Run records are the primary observability artifact — queryable by status, pipeline, type, and time window.
- ClickHouse `run_id` and `pipeline_id` columns enable correlation between run records and analytics output.
- Audit logs capture test execution and CSV export events.

### Data Lifecycle

- Run records follow the existing `PipelineRunRecord` retention policy.
- ClickHouse analytics data follows existing table-level TTL policies.
- Schema cache expires after 60 seconds (in-memory, per-process).

---

## 13. Delivery Plan / Work Breakdown

This feature has already been implemented across 11 phases under ABLP-280:

1. Schema denormalization (Phase 1) — 2026-04-13
2. Trigger validation + scheduler projectId (Phase 2) — 2026-04-13
3. ClickHouse column additions (Phase 3) — 2026-04-13
4. Studio API routes (Phase 4) — 2026-04-13
5. ClickHouse data query + export + schema resolver (Phase 5) — 2026-04-13
6. Recent Runs tab + Health strip (Phase 6) — 2026-04-13
7. Data tab + ClickHouse preview table (Phase 7) — 2026-04-13
8. Health badges + PipelineConfigPage Runs tab (Phase 8) — 2026-04-13
9. ~~Stuck-run watchdog (Phase 9)~~ — REMOVED 2026-04-15. Handler was defined but never bootstrapped; Restate delivery guarantees + 90-day TTL cover the failure mode.
10. **Test drawer + Re-run wiring (Phase 10)** — DEFERRED to v2. Trigger templates, manual test route, Re-run action.
11. **Dedicated ClickHouse reader user (Phase 11)** — DEFERRED to v2. `studio_reader` with readonly profile.
12. **Session-page pipeline analytics (Phase 12)** — PLANNED. Query ClickHouse analytics tables by `session_id` and display inline pipeline results (sentiment scores, intent classifications, quality evaluations, friction detections, etc.) on the session detail page. Requires a new API endpoint and a `SessionPipelineInsights` component.

---

## 14. Success Metrics

| Metric                  | Baseline | Target        | How Measured                                    |
| ----------------------- | -------- | ------------- | ----------------------------------------------- |
| Pipeline debugging time | Unknown  | 50% reduction | Time from failure alert to root cause in Studio |
| Data export usage       | 0        | Weekly use    | Audit log count of CSV exports                  |

---

## 15. Open Questions

1. Should the Data tab support time-series aggregation queries in v2?
2. Should health badges aggregate across all projects for tenant-admin views?
3. Should test runs be rate-limited per-project or per-user?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                          | Severity | Status |
| ------- | -------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | No E2E tests for the full UI flow (runs, test, data preview)                                                         | Medium   | Open   |
| GAP-002 | No i18n for pipeline observability UI strings                                                                        | Medium   | Open   |
| GAP-003 | Health badge thresholds (90%/70%) are hardcoded, not configurable                                                    | Low      | Open   |
| GAP-004 | CSV export does not support custom column ordering                                                                   | Low      | Open   |
| GAP-005 | Real-time SSE streaming deferred to v2 (using 5s polling)                                                            | Low      | Open   |
| GAP-006 | Session detail page has no pipeline analytics — users must navigate to Pipelines page to see run results per session | Medium   | Open   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                  | Coverage Type | Status     | Test File / Note                               |
| --- | --------------------------------------------------------- | ------------- | ---------- | ---------------------------------------------- |
| 1   | Schema resolution from pipeline definition                | integration   | PASS       | `schema-resolver.test.ts` (8 tests)            |
| 2   | Query builder SQL construction + allowlist                | unit          | PASS       | `query-builder.test.ts` (18 tests)             |
| 3   | Project isolation for run queries                         | integration   | PASS       | `pipeline-project-isolation.test.ts` (3 tests) |
| 4   | Run record project isolation                              | integration   | PASS       | `run-record-project-isolation.test.ts`         |
| 5   | Recent Runs UI rendering                                  | —             | NOT TESTED | No component tests yet (GAP-001)               |
| 6   | Data tab filter + query UI                                | —             | NOT TESTED | No component tests yet (GAP-001)               |
| 7   | Full E2E: create run -> view in list -> drill into detail | e2e           | NOT TESTED | Requires running Restate + ClickHouse          |

### Testing Notes

29 automated tests cover the backend routes, schema resolution, query building, and run-record isolation. Integration tests use MongoMemoryServer for real MongoDB and a fake HTTP server for Restate ingress. The primary gap is UI component tests and full E2E tests that exercise the complete user flow through the browser.

> Full testing details: `../testing/pipeline-engine.md`

---

## 18. References

- Design doc: `docs/superpowers/specs/2026-04-13-pipeline-observability-design.md`
- Implementation plan: `docs/superpowers/plans/2026-04-13-pipeline-observability-plan.md`
- Parent feature: `docs/features/pipeline-engine.md`
- Change manifests: `docs/specs/pipeline-observability*.changes.md`
- JIRA ticket: [ABLP-280](https://koreteam.atlassian.net/browse/ABLP-280)
