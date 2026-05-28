# Feature: Agent Governance Dashboard

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: ALPHA
**Feature Area(s)**: `governance`, `enterprise`, `observability`, `admin operations`
**Package(s)**: `apps/studio`, `apps/runtime`, `packages/database`, `packages/pipeline-engine`
**Owner(s)**: `Platform Team`
**Testing Guide**: [docs/testing/governance.md](../testing/governance.md)
**Last Updated**: 2026-04-29

---

## 1. Introduction / Overview

### Problem Statement

Enterprises deploying AI agents in regulated environments (financial services, healthcare, legal, HR) must demonstrate continuous compliance with internal policies and external regulatory requirements. Today the ABL platform computes rich post-session analytics across 11 pipeline types — quality evaluation, hallucination detection, guardrail analysis, drift detection, context preservation, knowledge gaps, friction detection, sentiment analysis, intent classification, anomaly detection, and LLM evaluation — but these signals are scattered across analytics pages with no compliance framing, no configurable policy thresholds, no breach history, and no audit-ready export artifacts.

Compliance officers and risk teams have no way to answer: "Are our agents meeting the quality and safety standards we committed to? Which agents are drifting? Can I produce a compliance report for our auditors showing we monitored PII guardrail effectiveness and quality scores over the last quarter?" The existing `GovernancePage` in Studio (`apps/studio/src/components/governance/GovernancePage.tsx`) is a stub with two empty-state tabs (Agent Registry, Compliance) and no real data.

### Goal Statement

Replace the existing `GovernancePage` stub with a fully functional Agent Governance Dashboard that surfaces existing analytics pipeline data through a regulatory compliance lens — configurable policy thresholds, per-agent compliance posture, breach history, and audit-ready CSV and PDF exports. The feature targets compliance officers and project owners who need to demonstrate ongoing agent governance to internal audit teams and external regulators.

### Summary

The Agent Governance Dashboard lives in the existing "govern" navigation group in Studio (alongside Guardrails Config). It replaces the stub with four tabs:

1. **Agent Registry** — a per-agent compliance posture table showing each agent's current score against governance policy thresholds for quality, hallucination rate, guardrail trigger rate, drift status, and knowledge gap count. An overall PASS/WARN/FAIL status per agent enables at-a-glance governance health.
2. **Compliance** — per-pipeline compliance cards showing current metric values against governance policy thresholds with trend sparklines and a "Create Alert" CTA that deep-links to the existing alerts system. Project owners configure governance policies (metric thresholds) here via an inline form.
3. **Audit Trail** — a paginated timeline of compliance events (threshold breaches and recoveries) sourced from ClickHouse, with date range filtering and export buttons (CSV and PDF) to generate audit-ready compliance reports.
4. **Frameworks** — structured compliance checklists for SOC2 Trust Service Criteria, GDPR (key articles), and EU AI Act (key articles), each showing per-control PASS/WARN/FAIL/NOT_EVALUATED status derived from governance policy evaluations and included in PDF exports.

All data is sourced from the existing `/api/projects/:projectId/pipeline-analytics` routes. New backend work is limited to: (a) governance policy CRUD (`governance_policies` MongoDB collection), and (b) a status aggregation endpoint that evaluates all governance policies against current pipeline data.

---

## 2. Scope

### Goals

- Replace the `GovernancePage` stub with three real, data-backed tabs (Agent Registry, Compliance, Audit Trail)
- Surface compliance posture for 6 primary governance pipelines: `quality_evaluation`, `hallucination_detection`, `guardrail_analysis`, `drift_detection`, `context_preservation`, `knowledge_gap`
- Allow project owners to define governance policies (metric + operator + threshold + severity) per pipeline
- Display per-agent PASS/WARN/FAIL compliance posture derived from governance policies
- Generate audit-ready CSV and PDF compliance reports from the Audit Trail tab
- Integrate with the existing alerts system via deep-link CTAs (no new notification logic)
- Follow existing Studio design patterns (SWR hooks, Recharts, i18n, Tailwind, Lucide icons)
- Provide structured compliance framework checklists (SOC2, GDPR, EU AI Act) with per-control PASS/WARN/FAIL/NOT_EVALUATED status derived from governance policy evaluations, included in PDF exports
- Produce all data-fetch via existing `/api/projects/:projectId/pipeline-analytics` endpoints plus eleven new runtime routes (5 policy CRUD + status + audit + override + report.csv + report.pdf + frameworks)

### Non-Goals (Out of Scope)

- Real-time enforcement — handled by the guardrails runtime pipeline
- Human-in-the-loop review or escalation workflows
- Alert rule creation/management — the existing alerts feature owns this; governance only provides CTAs
- Pipeline configuration UI — tracked separately as the pipeline-engine feature
- Cross-project / tenant-level governance aggregation — Phase 2 (all current analytics APIs are project-scoped)
- Custom dashboard builder or drag-and-drop widget arrangement
- NL query integration — already in the QueryExplorerTab of AnalyticsPage
- Automated agent actions (pause/rollback) triggered by threshold breaches — Phase 2
- Fine-tuning or model training based on governance signals
- Slack / PagerDuty notification channels — owned by alerts feature

---

## 3. User Stories

1. As a **compliance officer**, I want to see a per-agent compliance posture table showing PASS/WARN/FAIL status against configured governance policies so that I can identify non-compliant agents without reading raw analytics data.
2. As a **compliance officer**, I want to export a PDF compliance report covering a selectable date range so that I can provide audit evidence to internal audit teams and external regulators.
3. As a **compliance officer**, I want to download a CSV of all compliance events (breaches and recoveries) over a date range so that I can import audit data into GRC tools.
4. As a **project owner**, I want to define governance policies (e.g., "quality score must be ≥ 3.5, severity: critical") per pipeline type so that the platform knows what compliance means for my project.
5. As a **project owner**, I want to see trend sparklines on each compliance card so that I can tell whether a metric is improving or worsening before it breaches a threshold.
6. As a **project owner**, I want to see the full breach/recovery timeline in the Audit Trail tab so that I can investigate when a compliance issue started and whether it has been resolved.
7. As a **project owner**, I want "Create Alert" CTAs on compliance cards so that I can set up proactive notifications for thresholds without leaving the governance page.
8. As a **quality analyst**, I want to drill down from an agent row in the registry to see that agent's pipeline-level compliance scores so that I can identify which specific metrics are failing.
9. As a **quality analyst**, I want the Audit Trail to filter by pipeline type and agent so that I can scope a compliance review to a specific domain (e.g., hallucination only for agent X).
10. As a **platform admin**, I want governance policies to be project-scoped with tenant isolation enforced so that one project's policies do not affect another project's governance view.
11. As a **Data Protection Officer (DPO)**, I want the Audit Trail to include which model version and deployment was active when a PII guardrail breach occurred so that I can demonstrate to regulators that I identified the exact model version involved in a data handling incident.
12. As a **compliance officer**, I want to mark a FAIL event as "reviewed and accepted" with a justification note so that my audit trail contains attestation evidence of human oversight for EU AI Act Article 14 purposes.
13. As a **read-only external auditor**, I want to access the governance audit trail and download compliance reports without being granted full project-member permissions so that I can conduct independent review without the risk of data modification.

---

## 4. Functional Requirements

### Governance Policy Management

1. **FR-1**: The system must provide CRUD API routes for governance policies scoped to `tenantId + projectId`. Each policy must have: `name`, `description` (optional), one or more `rules` (`pipelineType`, `metric`, `operator` (gt/gte/lt/lte/eq), `threshold`, `severity` (critical/warning/info)), and `status` (enabled/disabled).
2. **FR-2**: The system must enforce uniqueness of policy name within the same `tenantId + projectId`. Duplicate names must be rejected with HTTP 409.
3. **FR-3**: The Compliance tab must provide a UI form for creating and editing governance policies, pre-populated with the 6 primary governance pipeline types as field options.
4. **FR-4**: The system must validate that `pipelineType` values in governance policy rules are members of `VALID_PIPELINE_TYPES` from `pipeline-analytics-helpers.ts`.

### Governance Status Aggregation

5. **FR-5**: The system must expose a `GET /api/projects/:projectId/governance/status` endpoint that evaluates all enabled governance policy rules against the most recent pipeline analytics summary for each pipelineType and returns a per-rule compliance status (PASS/WARN/FAIL) and a per-agent posture aggregation.
6. **FR-6**: The governance status endpoint must accept a `period` query parameter (`7d`, `30d`, `90d`) and pass it through to the underlying pipeline-analytics summary queries.
7. **FR-7**: The governance status endpoint must cache its response in Redis with a 5-minute TTL using a `governance:status:${tenantId}:${projectId}:${period}` key. This uses a new `governance:` cache namespace (separate from the existing `analytics:` prefix used by `AnalyticsCache`), following the same TTL and Redis client pattern as the existing analytics cache.

### Agent Registry Tab

8. **FR-8**: The Agent Registry tab must display a sortable table of all agents in the project with columns: agent name, overall compliance status (PASS/WARN/FAIL), quality score, hallucination rate, guardrail trigger rate, drift status, knowledge gap count, and context preservation score.
9. **FR-9**: Each row in the Agent Registry table must show the PASS/WARN/FAIL status badge derived from evaluating all enabled governance policy rules for that agent.
10. **FR-10**: Clicking an agent row must expand a detail panel showing per-pipeline compliance scores for that agent with trend sparklines for the selected date range.
11. **FR-11**: The Agent Registry table must support sorting by any column (ascending/descending) and date range selection (7d, 30d, 90d).

### Compliance Tab

12. **FR-12**: The Compliance tab must display a compliance card for each of the 6 primary governance pipeline types (`quality_evaluation`, `hallucination_detection`, `guardrail_analysis`, `drift_detection`, `context_preservation`, `knowledge_gap`). Each card must show: current metric value, configured threshold (if any), compliance status, and a 7/30/90-day trend sparkline.
13. **FR-13**: Each compliance card must show a "Create Alert" button that opens the alerts page pre-filled with the pipeline type, metric, and threshold from the governance policy rule.
14. **FR-14**: The Compliance tab must show a "No governance policy configured" empty state with a "Set thresholds" action when no governance policies exist for the project.
15. **FR-15**: The Compliance tab must display a policy editor form (slide-over panel) for adding/editing governance policy rules, with fields for pipeline type, metric, operator (gt/gte/lt/lte/eq), threshold (number), and severity (critical/warning/info).

### Audit Trail Tab

16. **FR-16**: The Audit Trail tab must display a paginated timeline of compliance events (threshold breaches and recoveries) in reverse-chronological order, sourced from the `GET /api/projects/:projectId/governance/audit` endpoint.
17. **FR-17**: Each audit event row must include: timestamp, pipeline type, metric name, agent name, agent version (deployment version at event time), model ID (if resolvable from deployment records), threshold, actual value, severity, event type (breach/recovery/override), and — for override events — reviewer user ID and justification text.
18. **FR-18**: The Audit Trail must support filtering by pipeline type (multi-select), agent (multi-select), severity (critical/warning/info), event type (breach/recovery), and date range.
19. **FR-19**: The system must expose a `GET /api/projects/:projectId/governance/audit` endpoint that queries the ClickHouse pipeline tables for historical rows where metric values crossed governance policy thresholds, returning paginated results with `page`, `limit`, and `total`.

### Export

20. **FR-20**: The Audit Trail tab must provide a **Export CSV** button that downloads all audit events (for the current filter/date range, up to 10,000 rows) as a UTF-8 CSV file with columns: timestamp, pipelineType, metric, agentName, agentVersion, modelId, threshold, thresholdVersion (policy version at event time), actualValue, severity, eventType, reviewedBy, reviewJustification.
21. **FR-21**: The Audit Trail tab must provide an **Export PDF** button that generates a PDF compliance report containing: (1) cover page with project name, tenant name, date range, report preparer (authenticated user), and report generation timestamp; (2) governance policy summary table; (3) per-agent compliance posture table with model IDs; (4) audit event timeline; (5) page footer with project ID, generation timestamp, page number. PDF generation must use `pdfkit` (server-side, pure Node.js — NOT `pdf-lib` which lacks layout primitives for tables, and NOT `puppeteer` which adds headless Chromium overhead). Open Question #1 about pdf-lib is resolved: use `pdfkit`.
22. **FR-28**: The system must support a "Mark as Reviewed" action on FAIL events in the Agent Registry tab that creates an `override` audit event recording the reviewer's user ID, timestamp, justification text (max 500 chars), and the original FAIL event reference. This provides human-oversight attestation evidence per EU AI Act Article 14.
23. **FR-29**: The system must expose a `POST /api/projects/:projectId/governance/audit/:eventRef/override` endpoint that creates an override audit record stored in MongoDB (`governance_overrides` collection) and returns the created record. Override records must be included in CSV/PDF exports and must be retrievable via the `/governance/audit` endpoint alongside breach/recovery events.
24. **FR-30**: Governance policy mutations (create, update, delete) must store a `policyVersion` counter incremented on each change. The `/governance/audit` endpoint must resolve and attach the `thresholdAtTime` value (the threshold that was configured when the breach row occurred) by joining audit event timestamps against the governance policy version history. This ensures the audit trail accurately reflects what threshold was in effect at the time of the event even after subsequent threshold changes.
25. **FR-31**: The system must support a read-only `auditor` access level for the governance audit and report endpoints (`GET /governance/audit`, `GET /governance/report.csv`, `GET /governance/report.pdf`). Auditors must authenticate via the platform auth system but must NOT require full project-member permissions. A new `governance:audit-read` scope must be registered in the RBAC system and be grantable via temporary invitation (external auditor workflow).
26. **FR-22**: PDF generation must be performed server-side (not client-side canvas rendering) and streamed as a download via `GET /api/projects/:projectId/governance/report.pdf?period=...&filters=...`.
27. **FR-23**: CSV export must be served directly as a streamed response via `GET /api/projects/:projectId/governance/report.csv?period=...&filters=...`.

### Compliance Framework Checklists

28. **FR-32**: The system must expose a `GET /api/projects/:projectId/governance/frameworks?period=7d` endpoint that returns per-control compliance status for three frameworks: SOC2 Trust Service Criteria, GDPR key articles, and EU AI Act key articles. Each control must have: `controlId`, `framework`, `requirement` (descriptive label), `status` (PASS/WARN/FAIL/NOT_EVALUATED), and `evidence` (which governance signal drives the status).
29. **FR-33**: The Frameworks tab must display SOC2 Trust Service Criteria checklist with per-control status derived from governance policy evaluations. Minimum controls to map: CC6.1 (logical access controls → `guardrail_analysis` PASS/FAIL), CC7.1 (change management → `drift_detection` PASS/FAIL), CC7.2 (system monitoring → `anomaly_detection` PASS/FAIL), CC8.1 (change control → governance policy `version` counter present), CC9.1 (risk assessment → at least one enabled governance policy exists). Controls with no mapped governance policy must show `NOT_EVALUATED` (not FAIL).
30. **FR-34**: The Frameworks tab must display a GDPR compliance checklist with per-article status. Articles to cover: Art. 5 (accuracy → `quality_evaluation` satisfies threshold), Art. 22 (automated decision safeguards → at least one `governance_overrides` record or zero active FAIL events), Art. 25 (data protection by design → `guardrail_analysis` policy exists and is PASS), Art. 30 (records of processing activities → audit trail has events in the period), Art. 13/14 (transparency → governance status endpoint is accessible and returning data). Status derivation logic must be documented in the `COMPLIANCE_FRAMEWORK_DEFINITIONS` constant in `governance-frameworks.ts`.
31. **FR-35**: The Frameworks tab must display an EU AI Act compliance checklist with per-article status. Articles to cover: Art. 9 (risk management system → at least one enabled governance policy covering quality or hallucination), Art. 11 (technical documentation → compliance report successfully generated in period), Art. 12 (logging → audit trail completeness — breach events within the period have event records), Art. 13 (transparency to users → governance status endpoint available), Art. 14 (human oversight → `governance_overrides` records exist for any FAIL events, or zero FAIL events in period), Art. 15 (accuracy and robustness → `quality_evaluation` and `hallucination_detection` governance policies PASS). Controls with no matching governance policy show `NOT_EVALUATED`.
32. **FR-36**: Compliance framework checklist status must be included in the PDF report as an additional section titled "Regulatory Framework Compliance Status" with three sub-tables (SOC2, GDPR, EU AI Act), each listing control ID, requirement, and status. The CSV export must include an additional sheet/section (or separate `?type=frameworks` variant) with columns: `framework`, `controlId`, `requirement`, `status`, `evidence`.

### Cross-Cutting

24. **FR-24**: All tabs must show loading skeletons during data fetch and contextual empty states when no data is available for the selected date range.
25. **FR-25**: All API errors must propagate as user-visible error banners, not silent failures.
26. **FR-26**: All user-facing strings must use i18n keys via `useTranslations('governance')`, extending the existing `governance` i18n namespace already present in the stub.
27. **FR-27**: Date range selection (7d, 30d, 90d) must persist in the Governance page URL query params and survive page reload, consistent with the `persistent-insights-analytics-filters` pattern.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                            |
| -------------------------- | ------------ | ------------------------------------------------------------------------------------------------ |
| Project lifecycle          | SECONDARY    | Governance policies are project-scoped; activated per project                                    |
| Agent lifecycle            | PRIMARY      | Per-agent compliance posture is the central surface of the feature                               |
| Customer experience        | NONE         | Governance is an operator-facing surface; not visible to end users                               |
| Integrations / channels    | NONE         | Channel-agnostic; operates on post-session analytics data                                        |
| Observability / tracing    | PRIMARY      | Consumes all 11 pipeline analytics outputs; Audit Trail is an observability artifact             |
| Governance / controls      | PRIMARY      | Core governance feature; configurable policy thresholds enable organizational compliance posture |
| Enterprise / compliance    | PRIMARY      | Audit-ready exports (CSV + PDF) directly serve regulated-industry compliance workflows           |
| Admin / operator workflows | PRIMARY      | Compliance officers and project owners are the primary actors                                    |

### Related Feature Integration Matrix

| Related Feature              | Relationship Type | Why It Matters                                                                                      | Key Touchpoints                                                                                     | Current State |
| ---------------------------- | ----------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------- |
| Analytics Insights Dashboard | shares data with  | Both consume `/pipeline-analytics` routes; governance reframes the same data with a compliance lens | `GET /api/projects/:projectId/pipeline-analytics/:type/summary` reused for all 6 governance cards   | BETA          |
| Guardrails                   | depends on        | `guardrail_analysis` pipeline data flows from the runtime guardrail infrastructure                  | `abl_platform.guardrail_evaluations` ClickHouse table                                               | BETA          |
| Alerts                       | depends on        | Governance "Create Alert" CTAs deep-link to the alerts system with pre-filled parameters            | `/alerts` Studio route; alert rules share the same ClickHouse source tables                         | ALPHA         |
| Pipeline Engine              | depends on        | All 11 pipeline types process sessions and write results to ClickHouse tables                       | `VALID_PIPELINE_TYPES`, `PIPELINE_TABLES` constants in `pipeline-analytics-helpers.ts`              | BETA          |
| PII Detection                | shares data with  | PII violations surface through `guardrail_analysis` pipeline (builtin_pii provider)                 | `abl_platform.guardrail_evaluations` filtered by `check_type = 'pii'`                               | BETA          |
| Audit Logging                | emits into        | Governance policy mutations (create/update/delete) must be audit-logged                             | `writeAuditLog()` in governance policy route handlers                                               | ALPHA         |
| Persistent Insights Filters  | extends           | Date range persistence pattern applied to governance URL params                                     | URL query param sync (custom hook to be implemented; no reusable `useUrlDateRange` hook exists yet) | BETA          |
| Deployments & Versioning     | shares data with  | Agent Registry can show deployment history per agent as supplementary metadata                      | Agent deployment records scoped to `projectId`                                                      | BETA          |

---

## 6. Design Considerations

### Tab Structure

The `GovernancePage` already has the tab shell with `registry` and `compliance` IDs. The implementation adds a third `audit` tab and replaces the two `EmptyState` components with real content:

```
GovernancePage
├── Agent Registry Tab  (id: 'registry')
│   ├── Date range selector (7d / 30d / 90d)
│   ├── AgentComplianceTable (sortable, per-agent PASS/WARN/FAIL rows)
│   └── AgentComplianceDetailPanel (expandable row → per-pipeline sparklines)
├── Compliance Tab      (id: 'compliance')
│   ├── Date range selector
│   ├── GovernancePolicyEditor (inline form / slide-over)
│   └── ComplianceCardGrid (one card per primary pipeline type)
│       └── ComplianceCard (metric value, threshold, status badge, sparkline, Create Alert CTA)
├── Audit Trail Tab     (id: 'audit')
│   ├── AuditFilters (pipeline type, agent, severity, event type, date range)
│   ├── AuditEventTimeline (paginated table)
│   └── ExportBar (Export CSV button, Export PDF button)
└── Frameworks Tab      (id: 'frameworks')
    ├── FrameworkSelector (SOC2 / GDPR / EU AI Act tabs)
    ├── FrameworkChecklist (per-control status rows)
    │   └── FrameworkControlRow (controlId, requirement, status badge, evidence link)
    └── FrameworkExportBar (Export PDF with frameworks section included)
```

### Compliance Status Logic

The PASS/WARN/FAIL status for a metric is computed by evaluating the governance policy rule for that metric:

- **PASS** — metric satisfies the threshold (e.g., quality score 3.8 ≥ threshold 3.5)
- **WARN** — metric violates a rule with severity `warning` or `info`
- **FAIL** — metric violates a rule with severity `critical`

If no governance policy is configured for a pipeline type, the card shows "No threshold" and is excluded from PASS/WARN/FAIL counts.

Per-agent overall status: FAIL if any rule is FAIL; else WARN if any rule is WARN; else PASS.

### PDF Report Structure

The PDF report must include:

1. Cover page: project name, tenant name, report generation timestamp, date range
2. Governance Policy Summary: table of all enabled policies with name, pipeline type, metric, operator, threshold, severity
3. Agent Compliance Posture: table matching the Agent Registry tab (per-agent PASS/WARN/FAIL with metric values)
4. Audit Event Timeline: table of all compliance events in the date range
5. Footer on every page: project ID, generation timestamp, page number

PDF generation via server-side `pdf-lib` or `puppeteer` (to be decided in LLD; `pdf-lib` is preferred to avoid headless browser overhead in the runtime).

---

## 7. Technical Considerations

### Data Sources

All governance metrics are read from the existing ClickHouse pipeline tables via the existing runtime `pipeline-analytics` routes. Governance does NOT introduce new ClickHouse tables or new pipeline processing.

| Pipeline Type             | ClickHouse Table                         | Key Metric Field(s)                                                                                                                                                  |
| ------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quality_evaluation`      | `abl_platform.quality_evaluations`       | `overall_score`, `flagged_rate_pct` (from pipeline-analytics.ts:160–166)                                                                                             |
| `hallucination_detection` | `abl_platform.hallucination_evaluations` | `overall_score` (avg), `flagged_rate_pct` (from pipeline-analytics.ts:176–181); note: `hallucination_rate` does NOT exist as a column                                |
| `guardrail_analysis`      | `abl_platform.guardrail_evaluations`     | `overall_score`, `false_positive_score`, `false_negative_score` (from pipeline-analytics.ts:205–206); note: `violation_rate` does NOT exist — use `flagged_rate_pct` |
| `drift_detection`         | `abl_platform.drift_detections`          | `overall_score`, `flagged_rate_pct` (from pipeline-analytics.ts:260–262)                                                                                             |
| `context_preservation`    | `abl_platform.context_evaluations`       | `overall_score`, `context_score` (session-level)                                                                                                                     |
| `knowledge_gap`           | `abl_platform.knowledge_gap_evaluations` | `overall_score`, `retrieval_precision`, `gap_detected` (from pipeline-analytics.ts:537)                                                                              |

> **Note**: The canonical metric fields are derived from the actual `SELECT` columns in `apps/runtime/src/routes/pipeline-analytics.ts`. The LLD must define the canonical `GovernancePolicyRule.metric` enum values against these actual column names. Any metric field name used in a GovernancePolicy rule must exist in the corresponding ClickHouse table's schema.

### Governance Status Endpoint Design

The `/governance/status` endpoint calls the pipeline-analytics summary route internally for each configured governance policy's pipelineType, then evaluates each rule against the returned summary. It is a fan-out aggregation of up to 6 pipeline-analytics calls. These calls should be `Promise.all()`-ed for parallelism, not serialized.

### Audit Breach Detection

The `/governance/audit` endpoint must query ClickHouse for historical rows where the metric value crossed the governance policy threshold. This requires comparing each row's metric value against the threshold defined in the governance policy — a parameter that lives in MongoDB, not ClickHouse. The implementation strategy:

1. Fetch all enabled governance policies for the project from MongoDB (single query)
2. For each rule, build a ClickHouse query with a `WHERE` clause comparing the metric column against the threshold value (using a parameterized query — threshold is a runtime parameter, not interpolated SQL)
3. UNION or collect results, attach event type (breach = metric violated threshold, recovery = metric returned to compliance)

This naive `O(rules)` approach fires one ClickHouse query per rule. **For efficiency, group rules by `pipelineType`** and issue one query per table using conditional aggregation or UNION ALL — reducing up to 20 rule queries to at most 6 table queries (one per governance pipeline type). Per-table queries can then evaluate multiple rule thresholds in a single ClickHouse round-trip.

### CSV Streaming

The CSV report endpoint must stream ClickHouse results rather than buffering them. The existing pipeline-analytics routes use `result.json()` (full buffer). The governance CSV endpoint must instead use the `@clickhouse/client` streaming API: `client.query()` → `result.stream()` → pipe through a Transform that serializes each row as a CSV line → pipe to `res`. This avoids OOM risk for 10,000-row exports. The LLD must mandate this streaming pattern.

### PDF Generation

PDF generation must be server-side in the runtime using **`pdfkit`** (MIT, pure Node.js, built-in table-aware primitives with automatic pagination, page headers/footers). Do NOT use `pdf-lib` — it is a low-level PDF manipulation library with no layout engine, no word-wrap, and no table abstraction; building the required multi-page tabular report with `pdf-lib` would require a custom layout engine. Do NOT use `puppeteer` — it spawns a headless Chromium process (~200MB RAM, 2–5s cold-start) that is unsafe in a concurrent API server. `pdfkit` is not yet in the monorepo and must be added as a dependency of `apps/runtime` during implementation.

### Rollout

The existing `GovernancePage` stub renders harmlessly; replacing it requires only UI changes to `apps/studio`. All nine new runtime routes (5 policy CRUD + `/governance/status` + `/governance/audit` + `/governance/report.csv` + `/governance/report.pdf`) are additive. No migrations are needed for existing data. The new `governance:write` RBAC scope must be registered before policy mutation routes are deployed.

---

## 8. How to Consume

### Studio UI

The Governance page is accessed via the **govern** navigation group (ShieldAlert icon) in the Studio sidebar, second item after Guardrails Config. Route: `/projects/:projectId/governance`.

- **Agent Registry tab**: Default landing tab. Shows per-agent compliance posture. Date range selector in top-right (7d/30d/90d). Click any row to expand agent detail.
- **Compliance tab**: Per-pipeline compliance cards. "Set thresholds" button opens the policy editor for projects with no policies. Existing policy rules displayed inline; "Edit" action opens the slide-over form.
- **Audit Trail tab**: Filter bar at top. Paginated event timeline below. "Export CSV" and "Export PDF" buttons in the top-right action bar.

### Surface Semantics Matrix

| Asset / Entity Type         | Source of Truth / Ownership     | Design-Time Surface(s)           | Editable or Read-Only? | Consumer Reference / Binding Model                          | Runtime Materialization / Resolution                                        | Notes / Unsupported State                         |
| --------------------------- | ------------------------------- | -------------------------------- | ---------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------- |
| GovernancePolicy            | MongoDB (`governance_policies`) | Compliance tab policy editor     | Editable               | `tenantId + projectId + name`                               | Evaluated server-side at `/governance/status`                               | No DSL representation; Studio-only design surface |
| Pipeline Analytics Data     | ClickHouse pipeline tables      | All three tabs (read-only)       | Read-only              | `pipelineType + projectId + period` via pipeline-analytics  | Aggregated at query time; no materialization beyond existing ClickHouse MVs | Cannot be edited from governance UI               |
| Compliance Events           | ClickHouse pipeline tables      | Audit Trail tab                  | Read-only              | Derived from GovernancePolicies + ClickHouse row comparison | Computed on-demand by `/governance/audit` endpoint                          | Not pre-stored; computed at query time            |
| Compliance Report (PDF/CSV) | Generated at request time       | Audit Trail tab (export buttons) | N/A — download only    | `GET /governance/report.pdf` or `/report.csv`               | Generated server-side on request; not persisted                             | Large date ranges may be slow; 10K row CSV limit  |

### Design-Time vs Runtime Behavior

- **GovernancePolicies** exist only in the control plane (MongoDB, Studio UI). They are not materialized into the agent IR or any deployment artifact. They are resolved at query time by the `/governance/status` and `/governance/audit` endpoints.
- **Pipeline analytics data** is produced by the pipeline-engine workers post-session and written to ClickHouse. Governance reads this data but does not write to it.
- **Compliance status** is computed at request time (not cached beyond the 5-minute Redis TTL). There is no persistent "compliance state" record — status is always derived from live pipeline data against current governance policies.

### API (Runtime)

| Method | Path                                                               | Purpose                                                                                |
| ------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| GET    | `/api/projects/:projectId/governance/policies`                     | List all governance policies for the project                                           |
| POST   | `/api/projects/:projectId/governance/policies`                     | Create a governance policy                                                             |
| GET    | `/api/projects/:projectId/governance/policies/:policyId`           | Get a single governance policy                                                         |
| PUT    | `/api/projects/:projectId/governance/policies/:policyId`           | Update a governance policy                                                             |
| DELETE | `/api/projects/:projectId/governance/policies/:policyId`           | Delete a governance policy                                                             |
| GET    | `/api/projects/:projectId/governance/status?period=7d`             | Evaluate all enabled policies against current pipeline data; returns per-agent posture |
| GET    | `/api/projects/:projectId/governance/audit?period=...&filters=...` | Query compliance breach/recovery events from ClickHouse                                |
| GET    | `/api/projects/:projectId/governance/report.csv?period=...`        | Stream CSV compliance report (uses ClickHouse `result.stream()` — not buffered)        |
| GET    | `/api/projects/:projectId/governance/report.pdf?period=...`        | Stream PDF compliance report (server-side `pdfkit` generation)                         |
| POST   | `/api/projects/:projectId/governance/audit/:eventRef/override`     | Create human override record for a breach event (FR-28, FR-29)                         |
| GET    | `/api/projects/:projectId/governance/frameworks?period=7d`         | Compliance framework checklists (SOC2, GDPR, EU AI Act) with per-control status        |

### API (Studio)

No Studio-side API routes needed. All data access goes through the runtime API via SWR hooks.

### Admin Portal

Not applicable for MVP. Cross-project / tenant-level governance views are Phase 2 and would surface in `apps/admin`. The existing RFC-019 admin governance surfaces are separate scope.

### Channel / SDK / Voice / A2A / MCP Integration

Not applicable. Governance is an operator-facing analytics surface. It is not channel-aware and has no interaction with the agent execution path.

---

## 9. Data Model

### Collections / Tables

```text
Collection: governance_policies
Fields:
  - _id: string (UUIDv7, generated by platform)
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed)
  - name: string (required, 1-100 chars)
  - description: string (optional, max 500 chars)
  - version: number (auto-incremented on each PUT update, starts at 1)
  - rules: Array<GovernancePolicyRule> (required, min 1, max 20)
    - pipelineType: string (must be in VALID_PIPELINE_TYPES)
    - metric: string (must be a valid column for the pipelineType; validated against a canonical metric registry — LLD defines the allowed values per pipelineType)
    - operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq'
    - threshold: number
    - severity: 'critical' | 'warning' | 'info'
  - status: 'enabled' | 'disabled' (default: 'enabled')
  - createdBy: string (userId, required)
  - createdAt: Date (auto-set)
  - updatedAt: Date (auto-updated)
Indexes:
  - { tenantId: 1, projectId: 1, name: 1 } (unique)
  - { tenantId: 1, projectId: 1, status: 1 }
  - { tenantId: 1 } (for future cross-project tenant-level aggregation in Phase 2)
Plugins:
  - tenantIsolationPlugin
```

```text
Collection: governance_overrides
Fields:
  - _id: string (UUIDv7)
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed)
  - eventRef: string (required) — composite key identifying the breach event: "{pipelineType}:{agentName}:{metricName}:{timestamp}"
  - reviewedBy: string (userId, required)
  - justification: string (required, max 500 chars)
  - originalSeverity: 'critical' | 'warning' | 'info'
  - policyVersion: number (version of the governance policy at time of override)
  - createdAt: Date (auto-set)
Indexes:
  - { tenantId: 1, projectId: 1, eventRef: 1 } (unique — one override per event)
  - { tenantId: 1, projectId: 1, createdAt: -1 }
Plugins:
  - tenantIsolationPlugin
```

> **Note**: Compliance breach/recovery events are computed on demand from ClickHouse pipeline tables — they are not pre-stored. However, human override events (FR-28/FR-29) ARE stored in MongoDB because they represent human actions, not analytics observations. The audit endpoint joins on-demand ClickHouse breach events with stored MongoDB override records to produce the complete event timeline.

> **Policy versioning**: The `version` counter on `governance_policies` allows the audit endpoint to attach `thresholdAtTime` to breach events by correlating the event timestamp against the policy's update history. A lightweight `governance_policy_versions` snapshot collection (or MongoDB change streams) may be required in the LLD to support this — see Open Question #4, now upgraded from "acceptable for MVP" to "must resolve in LLD" given regulatory requirements.

### Key Relationships

- `governance_policies.tenantId + projectId` → scoped to project; enforces tenant isolation via plugin
- `governance_policies.rules[*].pipelineType` → references `VALID_PIPELINE_TYPES`; ClickHouse table resolved via `PIPELINE_TABLES[pipelineType]`
- `governance_policies.createdBy` → references `User._id` (no FK enforced in MongoDB, but used for audit display)
- `governance_overrides.eventRef` → logical reference to a ClickHouse pipeline row (not an FK; composite string key)
- `governance_overrides.reviewedBy` → references `User._id`
- Pipeline analytics data (ClickHouse) is read-only from governance's perspective — the relationship is one-directional (governance reads, pipeline-engine writes)

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                        | Purpose                                                                                      |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/governance-status.service.ts`    | Fan-out pipeline-analytics queries + policy evaluation; returns per-agent compliance posture |
| `apps/runtime/src/services/governance-audit.service.ts`     | ClickHouse breach/recovery event query builder (grouped by table, not per-rule)              |
| `apps/runtime/src/services/governance-report.service.ts`    | CSV streaming (via ClickHouse `result.stream()`) and PDF generation (via `pdfkit`)           |
| `packages/database/src/models/governance-policy.model.ts`   | Mongoose model for `governance_policies` collection (with `version` field)                   |
| `packages/database/src/models/governance-override.model.ts` | Mongoose model for `governance_overrides` collection                                         |

### Routes / Handlers

| File                                    | Purpose                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| `apps/runtime/src/routes/governance.ts` | All governance API routes (policy CRUD + status + audit + override + reports) |
| `apps/runtime/src/server.ts`            | Mount governance router at `/api/projects/:projectId/governance`              |

### UI Components

| File                                                                   | Purpose                                                                                    |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `apps/studio/src/components/governance/GovernancePage.tsx`             | Existing stub — replace with real tab content                                              |
| `apps/studio/src/components/governance/AgentComplianceTable.tsx`       | Per-agent PASS/WARN/FAIL posture table                                                     |
| `apps/studio/src/components/governance/AgentComplianceDetailPanel.tsx` | Expandable per-agent pipeline detail with sparklines                                       |
| `apps/studio/src/components/governance/ComplianceCardGrid.tsx`         | Grid of per-pipeline compliance cards                                                      |
| `apps/studio/src/components/governance/ComplianceCard.tsx`             | Single pipeline compliance card (metric, threshold, status, sparkline, CTA)                |
| `apps/studio/src/components/governance/GovernancePolicyEditor.tsx`     | Slide-over panel form for creating/editing governance policies                             |
| `apps/studio/src/components/governance/AuditEventTimeline.tsx`         | Paginated audit event table with filter bar; shows override badge on reviewed events       |
| `apps/studio/src/components/governance/OverrideModal.tsx`              | "Mark as Reviewed" slide-over modal (justification text field + confirm)                   |
| `apps/studio/src/components/governance/ExportBar.tsx`                  | CSV + PDF export buttons with loading states                                               |
| `apps/studio/src/hooks/useGovernanceStatus.ts`                         | SWR hook for `/governance/status`                                                          |
| `apps/studio/src/hooks/useGovernanceAudit.ts`                          | SWR hook for `/governance/audit` (paginated)                                               |
| `apps/studio/src/hooks/useGovernancePolicies.ts`                       | SWR hook for governance policy CRUD                                                        |
| `apps/studio/src/hooks/useGovernanceFrameworks.ts`                     | SWR hook for `/governance/frameworks`                                                      |
| `apps/studio/src/components/governance/FrameworksTab.tsx`              | Frameworks tab container with SOC2/GDPR/EU AI Act sub-tabs                                 |
| `apps/studio/src/components/governance/FrameworkChecklist.tsx`         | Per-framework checklist table (controlId, requirement, status badge, evidence)             |
| `apps/runtime/src/services/governance-frameworks.service.ts`           | `COMPLIANCE_FRAMEWORK_DEFINITIONS` + status derivation logic per control                   |
| `apps/runtime/src/routes/governance-frameworks.ts`                     | `GET /governance/frameworks` handler (reads status + audit data, derives control statuses) |

### Jobs / Workers / Background Processes

None required. Governance is a read-on-demand system; all data is derived from existing ClickHouse analytics at query time.

### Tests (actual — post-implementation)

| File                                                                        | Type        | Coverage Focus                                                                                                                   |
| --------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/__tests__/governance-unit.test.ts`                        | unit        | evaluateRule (5 operators), computeAgentStatus, buildBreachQuery, all framework evaluators, GovernanceCache fail-open            |
| `apps/runtime/src/__tests__/contracts/governance-policies.contract.test.ts` | integration | Policy CRUD Zod contract shapes, status (no-policy), audit (no-policy), frameworks (CC9.1, 3 frameworks), cross-tenant isolation |

**Note**: The planned per-concern e2e test files (`governance-policies.e2e.test.ts`, `governance-status.e2e.test.ts`, etc.) were consolidated into a contract integration test that uses `RuntimeApiHarness + MongoMemoryServer`. ClickHouse-backed breach detection, CSV/PDF export, and Redis caching remain untested (require live ClickHouse). These are tracked as gaps below.

---

## 11. Configuration

### Environment Variables

| Variable                              | Default | Description                                                                                            |
| ------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `GOVERNANCE_ENABLED`                  | `true`  | Kill switch — set to `false` to disable the governance router in runtime (enabled by default; opt-out) |
| `GOVERNANCE_STATUS_CACHE_TTL_SECONDS` | `300`   | Redis TTL for governance status cache (default 5 minutes)                                              |
| `GOVERNANCE_REPORT_MAX_ROWS`          | `10000` | Maximum rows included in CSV/PDF exports (configurable per deployment)                                 |

### Runtime Configuration

- Governance routes are mounted unless `GOVERNANCE_ENABLED=false` in `apps/runtime/src/server.ts` (opt-out kill switch, not opt-in). This was added during implementation to allow disabling governance in environments not yet ready for it. The logic is `process.env.GOVERNANCE_ENABLED !== 'false'` — governance is active when the env var is unset.
- The status cache TTL is configurable via `GOVERNANCE_STATUS_CACHE_TTL_SECONDS` to allow operators to tune freshness vs. performance

### DSL / Agent IR / Schema

Governance policies have no DSL or IR representation. They are a Studio-only design-time concept evaluated server-side against ClickHouse data. They do not affect agent compilation or runtime execution.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Project isolation | Every `governance_policies` query must include `projectId`. Every pipeline-analytics query includes `projectId` (enforced by existing route middleware). Cross-project access returns 404. |
| Tenant isolation  | `tenantIsolationPlugin` on `governance_policies` enforces `tenantId` on every query. Cross-tenant access returns 404.                                                                      |
| User isolation    | Governance policies are project-owned, not user-owned. All project members with project-read permission can view policies; only project-write permission allows create/update/delete.      |

### Security & Compliance

- All governance routes must go through `createUnifiedAuthMiddleware`. Read routes (GET policy list/detail, status, audit, reports) must use `requireProjectWideAnalyticsAccess` (consistent with existing pipeline-analytics routes). Mutation routes (POST/PUT/DELETE governance policies) must use a new `governance:write` permission scope that must be registered in the RBAC middleware (`apps/runtime/src/middleware/rbac.ts`) and mapped to appropriate project roles (e.g., project admin, project owner) during implementation. The new `governance:write` scope must be added to the existing role-permission registry before the routes go live.
- PDF and CSV reports contain potentially sensitive operational data (agent performance, guardrail effectiveness); they must only be accessible to authenticated project members
- `writeAuditLog()` must be called on all governance policy mutations (create, update, delete, status change) with `{ resourceType: 'governance_policy', resourceId: policy._id, action, actorId }`
- ClickHouse queries for breach detection must use parameterized values for threshold numbers (`{threshold:Float64}`) — threshold values must NOT be interpolated into SQL strings. Table names (`PIPELINE_TABLES[type]`) are safe because they are hardcoded constants, consistent with the existing pattern in `pipeline-analytics-helpers.ts`
- PDF generation must not execute arbitrary code or user-provided HTML; report templates must be hardcoded server-side

### Performance & Scalability

- `/governance/status` executes up to 6 parallel pipeline-analytics summary queries; each summary query hits a ClickHouse MV (pre-aggregated). Expected P95 latency: <500ms for projects with active pipelines, <200ms for cache hits
- `/governance/audit` is an unbounded ClickHouse query; it must enforce a maximum date range of 365 days and a `LIMIT` of `GOVERNANCE_REPORT_MAX_ROWS` (default 10,000)
- PDF generation should complete within 5 seconds for reports with up to 1,000 audit events. Reports exceeding this should stream progressively (PDF-lib supports incremental writes)
- All SWR hooks must use `keepPreviousData: true` to avoid flickering on date range changes (consistent with existing analytics dashboard pattern)

### Reliability & Failure Modes

- If any pipeline-analytics summary query fails in the fan-out, the status endpoint must return a partial result with the failed pipeline type marked as `{ status: 'unavailable', error: 'pipeline data unavailable' }` rather than failing the entire response
- If ClickHouse is unavailable, the audit endpoint must return HTTP 503 with a clear error message; governance status falls back to the Redis cache if available
- Governance policy CRUD must be idempotent: PUT replaces the full policy document; partial updates are not supported (simplifies validation)

### Observability

- All governance API routes must log requests via `createLogger('governance')` at INFO level for mutations and DEBUG for reads
- The status endpoint must emit a custom trace event `governance.status.computed` with fields: `policyCount`, `agentCount`, `passCount`, `warnCount`, `failCount`, `durationMs`
- Report generation must log report type, row count, and generation duration at INFO level
- Redis cache hits/misses for governance status must be logged at DEBUG level

### Data Lifecycle

- Governance policies are deleted when their parent project is deleted (cascade via project deletion handler in `ProjectService`)
- Pipeline analytics data in ClickHouse follows the existing retention TTL configured in the pipeline-engine (no new TTL needed)
- Generated PDFs and CSVs are not persisted server-side; they are generated on demand and streamed to the client. No object storage required for MVP.

---

## 13. Delivery Plan / Work Breakdown

1. **Data model and governance policy CRUD (backend)**
   1.1 Create `packages/database/src/models/governance-policy.model.ts` with Mongoose schema (including `version` counter), indexes, `tenantIsolationPlugin`
   1.2 Create `packages/database/src/models/governance-override.model.ts` with Mongoose schema, indexes, `tenantIsolationPlugin`
   1.3 Add `pdfkit` to `apps/runtime/package.json` dependencies
   1.4 Create `apps/runtime/src/routes/governance.ts` with policy CRUD routes + override POST route
   1.5 Add `requireProjectWideAnalyticsAccess` for all read routes; add new `governance:write` + `governance:audit-read` scopes via `requireProjectPermission()`; register both scopes in RBAC role-permission map; add `writeAuditLog` calls for policy mutations
   1.6 Mount governance router in `apps/runtime/src/server.ts` at `/api/projects/:projectId/governance`
   1.7 Write E2E tests for policy CRUD: auth, tenant isolation, project isolation, validation, name uniqueness, version increment on update

2. **Governance status aggregation (backend)**
   2.1 Create `apps/runtime/src/services/governance-status.service.ts` — fan-out pipeline-analytics summary calls + policy rule evaluation logic (operator/threshold comparison) + per-agent posture aggregation
   2.2 Add `GET /api/projects/:projectId/governance/status` route with period param and Redis caching
   2.3 Write unit tests for policy rule evaluation (all 5 operators, all 3 severities, PASS/WARN/FAIL derivation, partial failure handling)
   2.4 Write E2E test for status endpoint (with and without configured policies, caching behavior)

3. **Governance audit breach detection (backend)**
   3.1 Create `apps/runtime/src/services/governance-audit.service.ts` — per-rule ClickHouse parameterized query builder for breach/recovery events; parallel execution with `Promise.all`
   3.2 Add `GET /api/projects/:projectId/governance/audit` route with pagination, filter params, and row limit enforcement
   3.3 Write unit tests for audit query builder (parameterized threshold, table safety, breach vs recovery logic)
   3.4 Write E2E test for audit endpoint (filter by pipelineType, severity, date range; pagination)

4. **Report generation (backend)**
   4.1 Create `apps/runtime/src/services/governance-report.service.ts` — CSV formatter (streams rows from audit query) and PDF builder (pdf-lib or puppeteer, TBD in LLD)
   4.2 Add `GET /api/projects/:projectId/governance/report.csv` and `/report.pdf` routes with streaming response
   4.3 Write E2E tests for CSV (column headers, row count, content-disposition header) and PDF (content-type, non-empty response, GOVERNANCE_REPORT_MAX_ROWS cap)

5. **Agent Registry tab (frontend)**
   5.1 Create `useGovernanceStatus` SWR hook calling `/governance/status`
   5.2 Create `AgentComplianceTable` component with sortable columns and PASS/WARN/FAIL badges
   5.3 Create `AgentComplianceDetailPanel` expandable row with per-pipeline sparklines (Recharts)
   5.4 Replace `AgentRegistryTab` stub in `GovernancePage.tsx` with real table
   5.5 Add date range selector (7d/30d/90d) with URL param persistence

6. **Compliance tab (frontend)**
   6.1 Create `useGovernancePolicies` SWR hook for policy CRUD
   6.2 Create `GovernancePolicyEditor` slide-over panel form with pipeline type + metric + operator + threshold + severity fields (slide-over pattern consistent with FR-15)
   6.3 Create `ComplianceCard` component (metric value, threshold, status badge, Recharts sparkline, Create Alert CTA)
   6.4 Create `ComplianceCardGrid` with "No threshold" empty state
   6.5 Replace `ComplianceTab` stub in `GovernancePage.tsx` with real card grid + policy editor

7. **Audit Trail tab (frontend)**
   7.1 Create `useGovernanceAudit` SWR hook (paginated, with filter params)
   7.2 Create `AuditEventTimeline` paginated table with filter bar (pipeline type, agent, severity, event type, date range)
   7.3 Create `ExportBar` with CSV and PDF download buttons (fetch `/report.csv` or `/report.pdf`, trigger browser download)
   7.4 Add `audit` tab to `GovernancePage.tsx`

8. **i18n and polish**
   8.1 Extend `governance` i18n namespace with all new string keys (tab labels, card labels, table headers, empty states, export button labels, error messages)
   8.2 Add loading skeletons to all three tabs
   8.3 Add error banners for all API error states
   8.4 Verify URL param persistence for date range across tab navigation

9. **Testing and audit**
   9.1 Run full test suite for affected packages (`pnpm test --filter=@abl/runtime --filter=@abl/studio`)
   9.2 Manual walkthrough: create policy → view registry → view compliance cards → browse audit trail → export CSV → export PDF
   9.3 Security check: verify cross-tenant 404, cross-project 404, unauthenticated 401, insufficient-permission 403 for all routes

10. **Compliance framework checklists (backend + frontend)**
    10.1 Create `apps/runtime/src/services/governance-frameworks.service.ts` with `COMPLIANCE_FRAMEWORK_DEFINITIONS` — hardcoded mapping of control IDs (SOC2 CC6.1/CC7.1/CC7.2/CC8.1/CC9.1, GDPR Arts. 5/22/25/30/13-14, EU AI Act Arts. 9/11/12/13/14/15) to evaluation functions that derive PASS/WARN/FAIL/NOT_EVALUATED from governance status and override data
    10.2 Add `GET /api/projects/:projectId/governance/frameworks` route with `requireProjectWideAnalyticsAccess` — calls governance-status + override count queries then evaluates each control definition
    10.3 Write unit tests for framework evaluation functions (all 3 frameworks, all control statuses, NOT_EVALUATED when no policy mapped, PASS/WARN/FAIL derivation)
    10.4 Write E2E test for frameworks endpoint: project with governance policies configured → assert SOC2 CC9.1 = PASS, CC6.1 = PASS when guardrail_analysis passing; assert EU AI Act Art. 14 = PASS when overrides exist; assert NOT_EVALUATED when pipeline has no policy
    10.5 Create `apps/studio/src/hooks/useGovernanceFrameworks.ts` SWR hook
    10.6 Create `FrameworkChecklist.tsx` component (control rows with status badge, evidence description, link to relevant Audit Trail filter)
    10.7 Create `FrameworksTab.tsx` with SOC2/GDPR/EU AI Act sub-tab switcher; add `frameworks` tab to `GovernancePage.tsx`
    10.8 Add compliance framework section to PDF report (GovernanceReportService updates) and CSV `?type=frameworks` variant
    10.9 Add i18n keys for all framework control labels, status descriptions, and evidence text

---

## 14. Success Metrics

| Metric                                               | Baseline | Target                              | How Measured                                                   |
| ---------------------------------------------------- | -------- | ----------------------------------- | -------------------------------------------------------------- |
| Governance page adoption (active Studio users/month) | 0%       | ≥ 40% within 60 days of launch      | Studio page view analytics (GovernancePage route)              |
| Compliance reports exported per month                | 0        | ≥ 1 export per active project/month | Count of `/report.pdf` + `/report.csv` requests                |
| Time to first compliance report after setup          | N/A      | ≤ 5 minutes from policy creation    | User session timing (policy create → first export)             |
| Governance status endpoint P95 latency               | N/A      | ≤ 500ms (cold), ≤ 50ms (cached)     | Runtime trace events (`governance.status.computed.durationMs`) |
| Support tickets for "is our agent compliant?"        | Baseline | ≥ 30% reduction                     | Support ticket categorization                                  |

---

## 15. Open Questions

1. ~~**PDF library choice**~~: **RESOLVED** — use `pdfkit` (pure Node.js, built-in table/pagination layout). `pdf-lib` lacks a layout engine and cannot produce the required multi-page tabular report. `puppeteer` is unsafe in a concurrent API server (headless Chromium overhead). `pdfkit` is not yet in the monorepo; add to `apps/runtime/package.json` dependencies.
2. **Metric field name registry**: The canonical set of allowed `GovernancePolicyRule.metric` values per `pipelineType` must be hardcoded (not fetched from pipeline definitions, which have no stable metric schema). The LLD must define this registry as a constant in `governance-policy.model.ts`, using the actual ClickHouse column names verified in Section 7. New pipeline types added to `VALID_PIPELINE_TYPES` will require a corresponding registry entry before they can be used in governance policies.
3. **Compliance event storage**: Currently, breach/recovery events are computed on demand from ClickHouse. For large projects with many rules and 90-day history, this may be slow (GAP-001). A future `governance_events` ClickHouse materialized view or MongoDB change-stream writer could pre-materialize events — but this requires a background worker and is Phase 2.
4. **Policy versioning implementation**: The `version` counter on `governance_policies` is required for regulatory compliance (SOC 2, HIPAA — see C2 finding from industry audit). The LLD must decide: (a) lightweight approach — store a `governance_policy_versions` snapshot on every PUT (append-only MongoDB collection); or (b) MongoDB change streams to capture diffs. The breach audit endpoint must resolve `thresholdAtTime` by looking up the policy version that was active at the event timestamp.
5. **Per-agent policy overrides**: Should governance policies support agent-level overrides (e.g., stricter quality threshold for the customer-facing agent, looser for the internal HR bot)? Currently the data model supports project-level rules only. Agent-level scoping would require adding an optional `agentId` filter to each rule.
6. **External auditor access provisioning**: FR-31 introduces a `governance:audit-read` scope for external auditors. The invitation flow (how a project admin grants temporary read-only access to an external user who is not a workspace member) is not yet designed. This must be resolved before the HLD phase, as it may require new invite-scoping features in the auth system.
7. **Model version resolution for audit events**: FR-17 requires `agentVersion` and `modelId` in audit event rows. These values are in the deployment/session records, not in the ClickHouse pipeline tables. The audit endpoint must join ClickHouse pipeline rows with MongoDB deployment records by `agentName + sessionId` to resolve these fields. Define whether this join is done at query time (adds latency) or pre-materialized (adds write-path complexity).
8. **Framework definition versioning**: The `COMPLIANCE_FRAMEWORK_DEFINITIONS` constant maps control IDs to evaluation functions. If a future regulation update changes an article's requirements, the mapping must be updated manually in code — there is no mechanism for operators to customize which governance signals map to which controls. Operator-configurable control mappings are Phase 2.

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                                                   | Severity   | Status                                                                                               |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------- |
| GAP-001 | Breach/recovery event computation is on-demand from ClickHouse — for 90-day ranges with many rules, audit queries may be slow (>2s)                                                           | Medium     | Open                                                                                                 |
| GAP-002 | PDF layout is limited if `pdf-lib` is chosen; rich formatting (charts, sparklines) requires `puppeteer` which adds process overhead                                                           | Medium     | Open (LLD decision)                                                                                  |
| GAP-003 | Governance policies record threshold at rule creation time; if threshold is changed, historical audit events don't capture the old threshold                                                  | Medium     | Open                                                                                                 |
| GAP-004 | No per-agent policy overrides in Phase 1 — all governance policies apply to the project, not per-agent                                                                                        | Low        | Open                                                                                                 |
| GAP-005 | Tenant-level / cross-project governance aggregation is out of scope for Phase 1                                                                                                               | Low        | Deferred to Phase 2                                                                                  |
| GAP-006 | ~~Compliance framework checklists (SOC2 control mappings, GDPR article references) are not in scope for Phase 1~~                                                                             | ~~Medium~~ | **RESOLVED — brought into MVP scope per FR-32 through FR-36 (SOC2, GDPR, EU AI Act checklists)**     |
| GAP-007 | Export row limit (10,000) may be insufficient for very high-volume projects with 90-day audit windows; should be configurable per tenant                                                      | Low        | Open (env var `GOVERNANCE_REPORT_MAX_ROWS` allows deployment-level tuning)                           |
| GAP-008 | Bias/fairness metrics (demographic parity, equalized odds, disparate impact) absent — required by EU AI Act Article 10 and NIST AI RMF MEASURE-2 for HR tech, lending, and clinical use cases | Medium     | Deferred to Phase 2 — requires new analytics pipelines                                               |
| GAP-009 | Automated remediation (pause deployment, rollback) on threshold breach — table-stakes for enterprise buyers per Azure AI Content Safety, AWS Bedrock, and Google Vertex AI model monitoring   | Medium     | Deferred to Phase 2 — governance status endpoint designed to emit events for future automation layer |
| GAP-010 | Data lineage and consent management signals (GDPR Articles 13-14, HIPAA data provenance) — not addressed by analytics reframing alone                                                         | Low        | Out of scope for this feature; cross-reference to future data-lineage feature                        |
| GAP-011 | FR-31 (external auditor `governance:audit-read` scope) not implemented — RBAC scope defined but invitation/provisioning flow not built; external auditors cannot be granted read-only access  | High       | Open — requires auth system invite-scoping feature (deferred from ALPHA; required for BETA)          |
| GAP-012 | ClickHouse-backed E2E tests not written — breach detection, CSV/PDF export, Redis caching, and audit filtering require live ClickHouse; all currently untested                                | High       | Open — blocked on test environment ClickHouse seeding utilities; required for BETA                   |
| GAP-013 | `governance-policy-version.model.ts` added (not in original data model) to support `thresholdAtTime` resolution — Open Question #4 resolved as lightweight snapshot approach                  | Resolved   | Mitigated — policy versions snapshoted on every PUT; thresholdAtTime lookup uses snapshot collection |
| GAP-014 | `GOVERNANCE_ENABLED` kill switch added during implementation — feature is off-by-default in production; operators must explicitly enable it                                                   | Low        | Open — intentional for controlled rollout; document in deployment runbook                            |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                              | Coverage Type | Status  | Test File                                                                                      |
| --- | ------------------------------------------------------------------------------------- | ------------- | ------- | ---------------------------------------------------------------------------------------------- |
| 1   | Create governance policy with valid rules — verify 201 + stored document              | integration   | ✅ DONE | `contracts/governance-policies.contract.test.ts`                                               |
| 2   | Create duplicate policy name in same project — verify 409                             | integration   | ✅ DONE | `contracts/governance-policies.contract.test.ts`                                               |
| 3   | Governance policy CRUD with cross-project access — verify 404                         | integration   | PARTIAL | Contract test covers GET /status cross-tenant only; CRUD endpoints cross-tenant not yet tested |
| 4   | Governance policy CRUD unauthenticated — verify 401                                   | integration   | PARTIAL | Auth verified in harness setup; explicit 401 test not in contract file                         |
| 5   | Status endpoint: PASS when metric satisfies threshold                                 | unit          | ✅ DONE | `governance-unit.test.ts` (evaluateRule + computeAgentStatus)                                  |
| 6   | Status endpoint: FAIL when metric violates critical-severity threshold                | unit          | ✅ DONE | `governance-unit.test.ts`                                                                      |
| 7   | Status endpoint: WARN when metric violates warning-severity threshold                 | unit          | ✅ DONE | `governance-unit.test.ts`                                                                      |
| 8   | Status endpoint: partial failure — one pipeline unavailable, rest succeed             | integration   | ❌ OPEN | Requires ClickHouse test data (GAP-012)                                                        |
| 9   | Status endpoint: Redis cache hit returns within 50ms                                  | integration   | ❌ OPEN | Requires live Redis (GAP-012)                                                                  |
| 10  | Audit endpoint: returns breach events for a known threshold violation in test data    | integration   | ❌ OPEN | Requires ClickHouse seeded data (GAP-012)                                                      |
| 11  | Audit endpoint: filter by pipelineType returns only matching events                   | integration   | ❌ OPEN | Requires ClickHouse seeded data (GAP-012)                                                      |
| 12  | Audit endpoint: pagination (page 2) returns correct offset                            | integration   | ❌ OPEN | Requires ClickHouse seeded data (GAP-012)                                                      |
| 13  | CSV report download: correct Content-Type, Content-Disposition, column headers        | integration   | ❌ OPEN | Requires ClickHouse seeded data (GAP-012)                                                      |
| 14  | PDF report download: correct Content-Type, non-empty response body                    | integration   | ❌ OPEN | Requires ClickHouse seeded data (GAP-012)                                                      |
| 15  | `/governance/status` cross-project access — verify 404                                | integration   | ✅ DONE | `contracts/governance-policies.contract.test.ts` (cross-tenant isolation)                      |
| 16  | `/governance/audit` unauthenticated — verify 401                                      | integration   | PARTIAL | Auth enforced in middleware; explicit 401 test not written                                     |
| 17  | `/governance/report.pdf` cross-project access — verify 404                            | integration   | ❌ OPEN | Not in contract test                                                                           |
| 18  | Policy evaluation unit: all 5 operators (gt/gte/lt/lte/eq) return correct PASS/FAIL   | unit          | ✅ DONE | `governance-unit.test.ts`                                                                      |
| 19  | Policy evaluation unit: per-agent overall status (FAIL wins over WARN wins over PASS) | unit          | ✅ DONE | `governance-unit.test.ts`                                                                      |
| 20  | Audit query builder unit: SQL injection guard (allowlist filter)                      | unit          | ✅ DONE | `governance-unit.test.ts` (buildBreachQuery tests)                                             |
| 21  | Frameworks endpoint: SOC2 CC9.1 = FAIL when no policy → contract shape verified       | integration   | ✅ DONE | `contracts/governance-policies.contract.test.ts`                                               |
| 22  | Frameworks endpoint: EU AI Act Art.14 = PASS when overrides exist                     | integration   | ❌ OPEN | Requires override seeding + ClickHouse data (GAP-012)                                          |
| 23  | Framework evaluators: all 3 frameworks, all control statuses (pure function)          | unit          | ✅ DONE | `governance-unit.test.ts`                                                                      |
| 24  | Framework evaluation: SOC2 CC9.1/CC8.1, GDPR Art.22/Art.13, EU AI Act Art.11          | unit          | ✅ DONE | `governance-unit.test.ts`                                                                      |
| 25  | PDF report includes framework compliance section                                      | integration   | ❌ OPEN | Requires ClickHouse seeded data (GAP-012)                                                      |

### Testing Notes

Implementation complete as of 2026-04-29. 36 unit tests and 12 contract integration tests pass. Remaining gaps are all ClickHouse-dependent scenarios (GAP-012). E2E tests with live ClickHouse seeding are required before BETA promotion.

> Full testing details: [docs/testing/governance.md](../testing/governance.md)

---

## 18. References

- Feature docs: [docs/features/analytics-insights-dashboard.md](analytics-insights-dashboard.md)
- Feature docs: [docs/features/guardrails.md](guardrails.md)
- Feature docs: [docs/features/alerts.md](alerts.md)
- Feature docs: [docs/features/pipeline-engine.md](pipeline-engine.md)
- Design doc: [docs/rfcs/RFC-019-admin-governance-surfaces.md](../rfcs/RFC-019-admin-governance-surfaces.md)
- Existing stub: `apps/studio/src/components/governance/GovernancePage.tsx`
- Pipeline helpers: `apps/runtime/src/routes/pipeline-analytics-helpers.ts`
- Evaluate-policy activity: `packages/pipeline-engine/src/pipeline/activity-metadata.ts`
