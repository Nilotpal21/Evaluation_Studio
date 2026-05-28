# HLD: Agent Governance Dashboard

**Feature Spec**: `docs/features/governance.md`
**Test Spec**: `docs/testing/governance.md`
**Status**: APPROVED
**Author**: Platform Team
**Date**: 2026-04-29

---

## 1. Problem Statement

Enterprises deploying AI agents in regulated environments (financial services, healthcare, legal, HR) must demonstrate continuous compliance with internal policies and external regulations including SOC2, GDPR, and the EU AI Act. The ABL platform computes rich post-session analytics across 11 pipeline types stored in ClickHouse, but these signals are scattered across analytics pages with no compliance framing, no configurable policy thresholds, no breach history, and no audit-ready exports.

The existing `GovernancePage` (`apps/studio/src/components/governance/GovernancePage.tsx`) is a stub with two empty-state tabs. This HLD designs the end-to-end architecture for a governance dashboard that: (1) evaluates analytics data against operator-configured policy thresholds, (2) surfaces per-agent compliance posture, (3) provides a paginated breach/recovery audit trail, (4) generates audit-ready CSV and PDF reports, and (5) maps governance signals onto SOC2, GDPR, and EU AI Act compliance framework checklists.

---

## 2. Alternatives Considered

### Option A: Read-Only Governance View (Selected Partially)

- **Description**: Surface existing analytics data through a compliance lens with no persistent governance state — status computed 100% on-demand from ClickHouse, no MongoDB governance policies.
- **Pros**: Zero new backend storage; pure read system; no migration risk.
- **Cons**: Cannot express project-specific policy thresholds (what does "compliant" mean for this project?). Cannot record human override attestations (required for EU AI Act Art. 14). Cannot produce audit-ready exports that reference configured thresholds.
- **Effort**: S

### Option B: Full Governance Service with Policy CRUD + Status Aggregation + Audit Trail (Selected)

- **Description**: New `governance_policies` and `governance_overrides` MongoDB collections. Status aggregated at query time from ClickHouse against MongoDB policies. Audit trail computed on-demand; override events persisted. PDF via pdfkit server-side. Compliance framework checklists derived from governance status.
- **Pros**: Captures operator-defined thresholds for meaningful compliance status. Human oversight attestations are persisted for regulatory evidence. PDF/CSV reports include policy context. Compliance framework checklists map governance signals to regulatory controls.
- **Cons**: New storage (two MongoDB collections). Fan-out to up to 6 ClickHouse queries per status request (mitigated by Redis cache). PDF generation on the event loop (mitigated by row limit + streaming).
- **Effort**: L

### Option C: Event-Materialized Compliance Store

- **Description**: Background worker pre-materializes breach/recovery events into a dedicated ClickHouse `governance_events` table as sessions complete. The audit endpoint reads from this materialized store.
- **Pros**: Eliminates on-demand ClickHouse query latency. Audit endpoint becomes a simple paginated read.
- **Cons**: Requires a background worker, additional ClickHouse table, and write-path integration into the pipeline engine. Significantly increases implementation scope. GAP-001 notes this as a Phase 2 option if on-demand latency proves problematic.
- **Effort**: XL

### Recommendation: Option B

Option B provides the full compliance posture (configurable thresholds, human override attestations, regulatory checklists) that regulators and auditors require, while remaining architecturally feasible within the MVP timeline. The 5-minute Redis cache on status requests makes the fan-out acceptable. The on-demand audit breach detection is bounded by the 10,000-row export cap and 365-day maximum range. Option A lacks the threshold configuration required for compliance status to be meaningful. Option C is premature optimization.

---

## 3. Architecture

### System Context Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Studio (Next.js)                           │
│  GovernancePage (4 tabs: Registry | Compliance | Audit Trail | Frameworks)│
│  SWR Hooks: useGovernanceStatus, useGovernancePolicies,                │
│             useGovernanceAudit, useGovernanceFrameworks                 │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ HTTP JSON / stream
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                            Runtime (Express)                             │
│  /api/projects/:projectId/governance/...                                │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │ governance.ts (router)                                           │   │
│  │  Policy CRUD        → GovernancePolicyModel (MongoDB)            │   │
│  │  Status aggregation → GovernanceStatusService                    │   │
│  │  Audit trail        → GovernanceAuditService                     │   │
│  │  Override POST      → GovernanceOverrideModel (MongoDB)          │   │
│  │  CSV/PDF reports    → GovernanceReportService (pdfkit + stream)  │   │
│  │  Framework checks   → GovernanceFrameworksService                │   │
│  └──────────┬─────────────────────────────────────────┬────────────┘   │
│             │ reads                                    │ reads           │
│             ▼                                          ▼                │
│  ┌─────────────────────┐              ┌───────────────────────────┐    │
│  │   GovernanceCache   │              │   ClickHouse              │    │
│  │  Redis governance:  │◄─────────────│   (11 pipeline tables)   │    │
│  │  status:* (5m TTL)  │ status cache │   abl_platform.*          │    │
│  └─────────────────────┘              └───────────────────────────┘    │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │   MongoDB                                                         │   │
│  │   governance_policies   (CRUD + version counter)                 │   │
│  │   governance_overrides  (human override attestations)            │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

### Component Diagram

```
apps/runtime/src/routes/
├── governance.ts                        ← main router (10 endpoints: policy CRUD + status + audit + override + reports)
└── governance-frameworks.ts             ← sub-module for GET /governance/frameworks (imported into governance.ts)

apps/runtime/src/services/
├── governance-status.service.ts         ← fan-out + rule evaluation
├── governance-audit.service.ts          ← breach query builder
├── governance-report.service.ts         ← CSV streaming + PDF via pdfkit
└── governance-frameworks.service.ts     ← regulatory control mapping (pure functions)

packages/database/src/models/
├── governance-policy.model.ts           ← governance_policies collection
├── governance-override.model.ts         ← governance_overrides collection
└── governance-policy-version.model.ts   ← governance_policy_versions snapshot collection (FR-30)

apps/runtime/src/cache/
└── governance-cache.ts                  ← GovernanceCache (Redis wrapper, governance: namespace)

apps/studio/src/components/governance/
├── GovernancePage.tsx                   ← 4-tab container (existing stub → real)
├── AgentComplianceTable.tsx
├── AgentComplianceDetailPanel.tsx
├── ComplianceCardGrid.tsx / ComplianceCard.tsx
├── GovernancePolicyEditor.tsx           ← slide-over form
├── AuditEventTimeline.tsx / OverrideModal.tsx
├── ExportBar.tsx
└── FrameworksTab.tsx / FrameworkChecklist.tsx

apps/studio/src/hooks/
├── useGovernanceStatus.ts
├── useGovernancePolicies.ts
├── useGovernanceAudit.ts
└── useGovernanceFrameworks.ts
```

### Data Flow: Governance Status Request

```
1. Studio: GET /api/projects/:projectId/governance/status?period=7d
2. Runtime: authMiddleware → requireProjectWideAnalyticsAccess (concealNotMember=true)
3. GovernanceCache.get('governance:status:{tenantId}:{projectId}:7d')
   → HIT: return cached response (P95 < 50ms)
   → MISS: continue
4. Fetch all enabled governance_policies for projectId from MongoDB
5. Group rules by pipelineType → up to 6 groups
6. Promise.allSettled([
     callPipelineAnalyticsSummary('quality_evaluation', period),
     callPipelineAnalyticsSummary('hallucination_detection', period),
     ...
   ]) — each with 5s per-call timeout
7. For each rule: evaluateRule(metricValue, operator, threshold) → PASS|WARN|FAIL
8. Per-agent posture: FAIL > WARN > PASS (severity wins)
9. GovernanceCache.set('governance:status:...', result, TTL=300s)
10. Return { policies: [...], agents: [...], summary: { pass, warn, fail } }
```

### Data Flow: Audit Trail Request

```
1. Studio: GET /api/projects/:projectId/governance/audit?period=30d&page=1&limit=50
2. authMiddleware → requireProjectWideAnalyticsAccess OR governance:audit-read scope
3. Fetch enabled governance_policies from MongoDB
4. Group rules by pipelineType → build parameterized ClickHouse WHERE clauses
5. Promise.allSettled(breachQueries) → collect breach/recovery events per pipeline type
6. Query governance_overrides for matching eventRefs: O(1) MongoDB query
7. Merge: attach overrideId + reviewStatus to matching breach events
8. Sort by timestamp DESC, paginate, return { events: [...], total, page }
```

### Data Flow: PDF Report Generation

```
1. Studio: GET /api/projects/:projectId/governance/report.pdf?period=7d
2. authMiddleware → requireProjectWideAnalyticsAccess
3. res.setHeader('Content-Type', 'application/pdf')
4. res.setHeader('Content-Disposition', 'attachment; filename="governance-report-*.pdf"')
5. const doc = new PDFDocument({ autoFirstPage: true })
6. doc.pipe(res)  — stream to client as generated
7. Generate: cover page → policy summary table → agent posture table →
             audit event timeline → regulatory frameworks section → page footers
8. doc.end() — triggers final stream flush
```

### Data Flow: Framework Checklist Request

```
1. Studio: GET /api/projects/:projectId/governance/frameworks?period=7d
2. authMiddleware → requireProjectWideAnalyticsAccess
3. Fetch governance status (from cache or recompute)
4. Count governance_overrides for project in period: O(1) MongoDB count
5. GovernanceFrameworksService.evaluate(governanceStatus, overrideCount, enabledPolicies)
   — pure function, no external calls
   → SOC2Controls: { CC6.1: PASS, CC7.1: NOT_EVALUATED, CC9.1: PASS, ... }
   → GDPRControls: { Art_5: PASS, Art_22: WARN, Art_25: PASS, ... }
   → EUAIActControls: { Art_9: PASS, Art_14: WARN, Art_15: NOT_EVALUATED, ... }
6. Return { frameworks: [{ id: 'SOC2', controls: [...] }, { id: 'GDPR', ... }, { id: 'EU_AI_ACT', ... }] }
```

### Sequence Diagram: Policy CRUD with Audit Logging

```
Studio        governance.ts    GovernancePolicyModel    writeAuditLog
  │                │                    │                    │
  │  POST /policies│                    │                    │
  │───────────────▶│                    │                    │
  │                │ validateBody(Zod)  │                    │
  │                │ checkUniqueness()  │                    │
  │                │───────────────────▶│                    │
  │                │◀──────────────────│ { exists: false }  │
  │                │ create({ tenantId, projectId, ...body, version: 1 })
  │                │───────────────────▶│                    │
  │                │◀──────────────────│ { _id, ...policy } │
  │                │ writeAuditLog({ action: 'governance_policy.create', ... })
  │                │────────────────────────────────────────▶│
  │                │                    │                    │ (fire-and-forget)
  │  201 { _id }  │                    │                    │
  │◀──────────────│                    │                    │
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | All governance routes extract `tenantId` from `req.tenantContext.tenantId` (set by `createUnifiedAuthMiddleware`). Every MongoDB query includes `{ tenantId, projectId }`. `tenantIsolationPlugin` on both Mongoose models rejects queries missing `tenantId`. ClickHouse queries use `WHERE tenant_id = {tenantId:String}` (parameterized). Cross-tenant access returns 404 (not 403) via `requireProjectWideAnalyticsAccess` with `concealNotMember: true`.                                                                                                                                                                                                                                       |
| 2   | **Data Access Pattern** | Policy CRUD: direct Mongoose model access via route handler (thin handler, no repo layer — consistent with alerts.ts pattern). Status aggregation: `GovernanceStatusService` class with lazy ClickHouse + Redis clients. Audit/reports: `GovernanceAuditService` builds parameterized ClickHouse queries. Override records: direct Mongoose model (simple CRUD). All services use `async/await` with structured error logging.                                                                                                                                                                                                                                                                      |
| 3   | **API Contract**        | All success responses: `{ success: true, data: ... }`. All error responses: `{ success: false, error: { code: 'GOVERNANCE_*', message: '...' } }`. Status endpoint returns: `{ policies, agents: [{ agentId, agentName, status, rules: [{ pipelineType, metric, status, metricValue, threshold }] }], summary: { pass, warn, fail, unavailable } }`. Audit endpoint returns: `{ events: [{ eventRef, timestamp, pipelineType, metric, agentName, agentVersion, threshold, thresholdAtTime, actualValue, severity, eventType, overrideId?, reviewStatus? }], total, page, limit }`. No breaking changes to existing pipeline-analytics API.                                                          |
| 4   | **Security Surface**    | (a) All routes behind `createUnifiedAuthMiddleware`. (b) Read routes (status, audit, reports, frameworks) use `requireProjectWideAnalyticsAccess` (analytics:read scope, concealNotMember). (c) Write routes (policy CRUD) use `requireProjectPermission('governance:write')`. (d) Override POST uses `requireProjectPermission('governance:write')`. (e) External auditor read routes accept `governance:audit-read` scope. (f) ClickHouse threshold values use parameterized queries (`{threshold:Float64}` — NOT interpolated). (g) PDF templates are hardcoded server-side; no user-controlled HTML or code execution in report generation. (h) `writeAuditLog` called on all policy mutations. |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | Policy validation errors: HTTP 400 `{ code: 'GOVERNANCE_VALIDATION_ERROR', message: '...' }`. Duplicate policy name: HTTP 409 `{ code: 'GOVERNANCE_POLICY_EXISTS' }`. Not found: HTTP 404 `{ code: 'GOVERNANCE_POLICY_NOT_FOUND' }`. Unauthorized: HTTP 401/403 (handled by shared auth middleware). ClickHouse unavailable on status request: partial result with `{ status: 'unavailable' }` for affected pipeline types; HTTP 200 (partial success). ClickHouse unavailable on audit/report request: HTTP 503 `{ code: 'GOVERNANCE_DATA_UNAVAILABLE' }`. Redis unavailable: fail-open (status computed fresh, no cache write). PDF generation timeout (>30s): HTTP 503.                                                                                                                                |
| 6   | **Failure Modes** | Status fan-out failure: `Promise.allSettled` returns fulfilled/rejected per pipeline; rejected pipelines return `{ status: 'unavailable' }` in response. Individual pipeline query timeout: 5s per-call `Promise.race` timeout. Redis down: fail-open (AnalyticsCache pattern — `AnalyticsCache(null)` returns null on get, skip set). MongoDB down: HTTP 503 on policy CRUD; governance status returns empty policy list + no rules evaluated. ClickHouse down on audit: HTTP 503 with clear error. pdfkit hang: 30-second route-level timeout.                                                                                                                                                                                                                                                          |
| 7   | **Idempotency**   | Policy CRUD: PUT is full-replace idempotent (same body → same result). POST is not idempotent (409 on duplicate name). DELETE is idempotent (second delete returns 404). Override POST is idempotent by unique index on `(tenantId, projectId, eventRef)` — duplicate override returns 409 `{ code: 'GOVERNANCE_OVERRIDE_EXISTS' }`. Status and audit GETs are idempotent by definition. CSV/PDF GETs are idempotent (same params → same report content; generated fresh each time).                                                                                                                                                                                                                                                                                                                      |
| 8   | **Observability** | `createLogger('governance')` for all routes. INFO level on mutations (policy create/update/delete, override create). DEBUG level on reads. `governance.status.computed` trace event: `{ policyCount, agentCount, passCount, warnCount, failCount, unavailableCount, durationMs, cacheHit }`. `governance.audit.queried` trace event: `{ eventCount, pipelineTypes, period, durationMs }`. `governance.report.generated` trace event: `{ reportType: 'csv'/'pdf', rowCount, durationMs }`. Redis cache hits/misses logged at DEBUG. Breach SQL queries logged at DEBUG with parameterized query string (not interpolated values). `writeAuditLog` on all policy mutations (`action: 'governance_policy.create'/'update'/'delete'`, `metadata: { resourceType: 'governance_policy', resourceId, action }`). |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | Status endpoint: P95 < 500ms cold (6 parallel ClickHouse queries — 4 against materialized views: `sentiment_analysis`, `intent_classification`, `quality_evaluation`, `llm_evaluate`; 2 against raw tables: all other types), P95 < 50ms cached (Redis). Raw table queries may be slower than MV queries on high-volume projects; the 5s per-call timeout bounds worst-case latency. Audit endpoint: P95 < 2s for 30d range with ≤50 rules (6 parallel parameterized ClickHouse queries). CSV export: streamed (no buffering); first byte within 2s, full 10K-row export within 10s. PDF export: < 5s for ≤1,000 audit events; row limit enforced at `GOVERNANCE_REPORT_MAX_ROWS` (default 10,000). Frameworks endpoint: < 200ms (reads cached status + one MongoDB count). All ClickHouse queries use parameterized values, NOT interpolated. Individual ClickHouse query timeout: 5s. Route-level timeout (PDF): 30s. |
| 10  | **Migration Path**     | No data migrations. New collections (`governance_policies`, `governance_overrides`, `governance_policy_versions`) are created empty. MongoDB creates collections on first write. RBAC scopes (`governance:write`, `governance:audit-read`) added to `packages/shared-auth/src/rbac/role-permissions.ts` in the same PR as route registration. GovernancePage stub in Studio is replaced by the real implementation — no backwards compatibility with the stub needed. **Cascade delete**: both `governance_policies` and `governance_overrides` (and `governance_policy_versions`) must be added to `deleteProject()` and `deleteTenant()` in `packages/database/src/cascade/cascade-delete.ts` — per `packages/database/agents.md` pattern, every new project-scoped model requires cascade-delete registration in both functions.                                                                                     |
| 11  | **Rollback Plan**      | The governance router is always-on (no feature flag) but purely additive. Rollback: (a) Remove `app.use('/api/projects/:projectId/governance', governanceRouter)` from `server.ts` and remove the RBAC scope additions from `role-permissions.ts`. (b) Studio: revert `GovernancePage.tsx` to the stub. (c) MongoDB: `governance_policies`, `governance_overrides`, and `governance_policy_versions` collections can be dropped without affecting any other data. No ClickHouse changes to revert. Rollback requires one deploy; no data migration. The existing `GovernancePage` stub can be preserved in version control as a fallback.                                                                                                                                                                                                                                                                               |
| 12  | **Test Strategy**      | Unit: Pure functions only — `GovernanceStatusService.evaluateRule()`, `computeAgentStatus()`, `GovernanceAuditService.buildBreachQuery()`, `GovernanceFrameworksService.evaluate*()`. Zero mocks in unit tests (pure input→output). Integration: Policy model tenant isolation plugin, version increment on PUT, audit query grouping by pipelineType, CSV row limit cap. E2E: 15 scenarios via real Express server + real ClickHouse/MongoDB/Redis (no vi.mock). See `docs/testing/governance.md` for full scenario list. Coverage target: all 36 FRs in coverage matrix. Security: cross-tenant 404, unauthenticated 401, insufficient-permission 403 for all route groups.                                                                                                                                                                                                                                           |

---

## 5. Data Model

### New Collections

#### `governance_policies`

```typescript
{
  _id: string;              // UUIDv7
  tenantId: string;         // required, indexed
  projectId: string;        // required, indexed
  name: string;             // required, 1-100 chars
  description?: string;     // optional, max 500 chars
  version: number;          // auto-incremented on each PUT, starts at 1
  rules: Array<{
    pipelineType: string;   // in VALID_PIPELINE_TYPES
    metric: string;         // in canonical metric registry per pipelineType
    operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq';
    threshold: number;
    severity: 'critical' | 'warning' | 'info';
  }>;                       // min 1, max 20 rules
  status: 'enabled' | 'disabled';  // default: 'enabled'
  createdBy: string;        // userId
  createdAt: Date;
  updatedAt: Date;
}

Indexes:
  { tenantId: 1, projectId: 1, name: 1 }  UNIQUE
  { tenantId: 1, projectId: 1, status: 1 }
  { tenantId: 1 }

Plugin: tenantIsolationPlugin
```

#### `governance_overrides`

```typescript
{
  _id: string;              // UUIDv7
  tenantId: string;         // required, indexed
  projectId: string;        // required, indexed
  eventRef: string;         // composite: "{pipelineType}:{agentName}:{metricName}:{timestamp}"
  reviewedBy: string;       // userId
  justification: string;    // required, max 500 chars
  originalSeverity: 'critical' | 'warning' | 'info';
  policyVersion: number;    // version of the governance policy at time of override
  createdAt: Date;
}

Indexes:
  { tenantId: 1, projectId: 1, eventRef: 1 }  UNIQUE (one override per event)
  { tenantId: 1, projectId: 1, createdAt: -1 }

Plugin: tenantIsolationPlugin
```

#### `governance_policy_versions` (append-only snapshot — required for FR-30 thresholdAtTime)

> Schema defined below. Open Question #1 is DECIDED (Option a). LLD must resolve atomicity strategy for snapshot writes (compensating delete on snapshot write failure after policy write succeeds).

```typescript
{
  _id: string;           // UUIDv7
  tenantId: string;      // required, indexed
  projectId: string;     // required, indexed
  policyId: string;      // FK to governance_policies._id
  version: number;       // the version number of this snapshot (matches governance_policies.version)
  rules: Array<{...}>;   // full rules snapshot at this version (identical shape to governance_policies.rules)
  createdAt: Date;       // timestamp of the PUT that produced this version
}

Indexes:
  { tenantId: 1, policyId: 1, version: 1 }  UNIQUE
  { tenantId: 1, policyId: 1, createdAt: -1 }

Plugin: tenantIsolationPlugin
```

**Usage**: The `/governance/audit` endpoint resolves `thresholdAtTime` by finding the policy version with the greatest `createdAt` ≤ breach event timestamp via `governance_policy_versions.findOne({ policyId, createdAt: { $lte: eventTimestamp } }, { sort: { createdAt: -1 } })`. The `{ tenantId: 1, policyId: 1, createdAt: -1 }` index supports this query directly.

### Modified Collections

None. No changes to existing MongoDB collections or ClickHouse tables.

### Key Relationships

```
governance_policies.tenantId + projectId
  → scoped to project; tenantIsolationPlugin enforces tenantId

governance_policies.rules[*].pipelineType
  → must be member of VALID_PIPELINE_TYPES (11 entries)
  → determines which PIPELINE_TABLES[pipelineType] ClickHouse table is queried

governance_policies.rules[*].metric
  → must be member of METRIC_REGISTRY[pipelineType] (canonical per-table column names)
  → defined in governance-policy.model.ts as a hardcoded constant

governance_overrides.eventRef
  → logical FK to a ClickHouse pipeline row (composite string key)
  → no DB FK enforced; joined in service layer at query time

governance_policies.version
  → incremented atomically on every PUT
  → used to attach thresholdAtTime to breach events (compare event.timestamp to policy.updatedAt)
```

### Canonical Metric Registry

**Important distinction**: Governance policy rules reference **raw ClickHouse table column names** (used in breach detection `WHERE` clauses against individual pipeline rows). These are different from the aliased field names returned by the summary query (e.g., `avg_drift_score` is the summary alias; `drift_score` is the raw column). The LLD must map between these at query time.

Verified against the actual `SELECT` columns in `apps/runtime/src/routes/pipeline-analytics.ts`:

```typescript
// Raw ClickHouse column names for breach detection WHERE clauses
export const METRIC_REGISTRY: Record<string, string[]> = {
  // 6 primary governance pipelines:
  quality_evaluation: ['overall_score', 'helpfulness', 'accuracy'],
  hallucination_detection: ['overall_score', 'faithfulness_score'],
  guardrail_analysis: ['overall_score', 'false_positive_score', 'false_negative_score'],
  drift_detection: ['drift_score'], // NOT overall_score (no such col)
  context_preservation: ['overall_score', 'context_score'],
  knowledge_gap: ['overall_score', 'retrieval_precision', 'gap_detected'],
  // 5 secondary pipeline types (usable but not primary governance targets):
  friction_detection: ['friction_score'], // NOT overall_score
  anomaly_detection: ['z_score'], // NOT overall_score; flag col is anomaly_flag
  sentiment_analysis: ['avg_sentiment'], // table-level col name for sessions
  intent_classification: ['confidence'], // NOT overall_score
  llm_evaluate: ['overall_score'],
};

// Summary response field aliases (for status aggregation — what /governance/status reads)
export const METRIC_SUMMARY_ALIAS: Record<string, Record<string, string>> = {
  quality_evaluation: { overall_score: 'avg_overall_score' },
  hallucination_detection: { overall_score: 'avg_score', faithfulness_score: 'avg_faithfulness' },
  guardrail_analysis: {
    overall_score: 'avg_score',
    false_positive_score: 'avg_false_positive',
    false_negative_score: 'avg_false_negative',
  },
  drift_detection: { drift_score: 'avg_drift_score' },
  context_preservation: { overall_score: 'avg_score', context_score: 'avg_context_score' },
  knowledge_gap: {
    overall_score: 'avg_score',
    retrieval_precision: 'avg_retrieval_precision',
    gap_detected: 'gap_count',
  },
  friction_detection: { friction_score: 'avg_friction_score' },
  anomaly_detection: { z_score: 'avg_z_score' },
  sentiment_analysis: { avg_sentiment: 'avg_sentiment' },
  intent_classification: { confidence: 'avg_confidence' },
  llm_evaluate: { overall_score: 'avg_score' }, // summary returns avg_score not avg_overall_score
};
```

`flagged_rate_pct` is computed by the summary query (`sum(flagged)/count() * 100`) — it is not a raw column name and must NOT appear in `METRIC_REGISTRY`. Breach detection uses the raw boolean/numeric flag columns (`flagged`, `anomaly_flag`) directly.

---

## 6. API Design

### New Endpoints

| Method | Path                                                                   | Purpose                                  | Auth                                        |
| ------ | ---------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------- |
| GET    | `/api/projects/:projectId/governance/policies`                         | List governance policies                 | `analytics:read`                            |
| POST   | `/api/projects/:projectId/governance/policies`                         | Create governance policy                 | `governance:write`                          |
| GET    | `/api/projects/:projectId/governance/policies/:policyId`               | Get single policy                        | `analytics:read`                            |
| PUT    | `/api/projects/:projectId/governance/policies/:policyId`               | Full-replace policy (increments version) | `governance:write`                          |
| DELETE | `/api/projects/:projectId/governance/policies/:policyId`               | Delete policy                            | `governance:write`                          |
| GET    | `/api/projects/:projectId/governance/status?period=7d`                 | Evaluate policies against pipeline data  | `analytics:read`                            |
| GET    | `/api/projects/:projectId/governance/audit?period=...&page=1&limit=50` | Breach/recovery event timeline           | `analytics:read` OR `governance:audit-read` |
| POST   | `/api/projects/:projectId/governance/audit/:eventRef/override`         | Create human override attestation        | `governance:write`                          |
| GET    | `/api/projects/:projectId/governance/report.csv?period=...`            | Stream CSV compliance report             | `analytics:read` OR `governance:audit-read` |
| GET    | `/api/projects/:projectId/governance/report.pdf?period=...`            | Stream PDF compliance report             | `analytics:read` OR `governance:audit-read` |
| GET    | `/api/projects/:projectId/governance/frameworks?period=7d`             | Compliance framework checklists          | `analytics:read`                            |

### Modified Endpoints

None. All endpoints are new additions under the `/governance/` path prefix.

### Error Responses

| Code                          | HTTP | Description                                          |
| ----------------------------- | ---- | ---------------------------------------------------- |
| `GOVERNANCE_POLICY_NOT_FOUND` | 404  | Policy does not exist in this project                |
| `GOVERNANCE_POLICY_EXISTS`    | 409  | Policy name already in use in this project           |
| `GOVERNANCE_VALIDATION_ERROR` | 400  | Invalid pipelineType, metric, operator, or threshold |
| `GOVERNANCE_OVERRIDE_EXISTS`  | 409  | Override record already exists for this eventRef     |
| `GOVERNANCE_DATA_UNAVAILABLE` | 503  | ClickHouse unavailable for audit/report query        |
| `GOVERNANCE_REPORT_TIMEOUT`   | 503  | PDF generation exceeded 30s timeout                  |

### Request/Response Shapes

**POST /governance/policies request body**:

```json
{
  "name": "Quality Threshold Policy",
  "description": "Minimum quality for customer-facing agents",
  "rules": [
    {
      "pipelineType": "quality_evaluation",
      "metric": "overall_score",
      "operator": "gte",
      "threshold": 3.5,
      "severity": "critical"
    }
  ],
  "status": "enabled"
}
```

**GET /governance/status response**:

```json
{
  "success": true,
  "data": {
    "period": "7d",
    "policies": [{ "_id": "...", "name": "...", "status": "enabled" }],
    "agents": [
      {
        "agentName": "customer-support",
        "overallStatus": "FAIL",
        "rules": [
          {
            "pipelineType": "quality_evaluation",
            "metric": "overall_score",
            "status": "FAIL",
            "metricValue": 3.2,
            "threshold": 3.5,
            "severity": "critical"
          }
        ]
      }
    ],
    "summary": { "pass": 3, "warn": 1, "fail": 2, "unavailable": 0 }
  }
}
```

**GET /governance/frameworks response**:

```json
{
  "success": true,
  "data": {
    "frameworks": [
      {
        "id": "SOC2",
        "label": "SOC2 Trust Service Criteria",
        "controls": [
          {
            "controlId": "CC9.1",
            "requirement": "Risk assessment: at least one enabled governance policy exists",
            "status": "PASS",
            "evidence": "3 enabled policies"
          },
          {
            "controlId": "CC6.1",
            "requirement": "Logical access controls: guardrail_analysis policy PASS",
            "status": "FAIL",
            "evidence": "guardrail_analysis overall_score = 0.62 < threshold 0.90"
          },
          {
            "controlId": "CC7.2",
            "requirement": "System monitoring: anomaly_detection policy PASS",
            "status": "NOT_EVALUATED",
            "evidence": "No anomaly_detection governance policy configured"
          }
        ]
      },
      {
        "id": "GDPR",
        "label": "GDPR Key Articles",
        "controls": [...]
      },
      {
        "id": "EU_AI_ACT",
        "label": "EU AI Act Key Articles",
        "controls": [...]
      }
    ]
  }
}
```

---

## 7. Cross-Cutting Concerns

### Audit Logging

`writeAuditLog` (from `apps/runtime/src/repos/auth-repo.ts`) signature: `writeAuditLog({ action, userId, tenantId, metadata })`. Called on:

- `governance_policy.create` — `writeAuditLog({ action: 'governance_policy.create', userId: req.user.id, tenantId: req.tenantContext.tenantId, metadata: { resourceType: 'governance_policy', resourceId: policy._id, name: policy.name } })`
- `governance_policy.update` — `writeAuditLog({ action: 'governance_policy.update', userId, tenantId, metadata: { resourceType: 'governance_policy', resourceId, version: policy.version } })`
- `governance_policy.delete` — `writeAuditLog({ action: 'governance_policy.delete', userId, tenantId, metadata: { resourceType: 'governance_policy', resourceId } })`
- `governance_override.create` — `writeAuditLog({ action: 'governance_override.create', userId, tenantId, metadata: { resourceType: 'governance_override', resourceId: override._id, eventRef: override.eventRef, reviewedBy: override.reviewedBy } })`

### Rate Limiting

Governance routes participate in the existing `tenantRateLimit` middleware applied globally in `server.ts`. No governance-specific rate limits for MVP. PDF/CSV report generation may warrant a dedicated limit in Phase 2 (one concurrent report per tenant).

### Caching

- **GovernanceCache**: Thin wrapper around the Redis client from `getRedisClient()`. Writes `governance:status:{tenantId}:{projectId}:{period}` keys with TTL from `GOVERNANCE_STATUS_CACHE_TTL_SECONDS` (default 300s). Fail-open (if Redis is unavailable, cache gets/sets are no-ops). Does NOT use `AnalyticsCache` (which has a hardcoded `analytics:` prefix incompatible with the governance namespace).
- No caching on audit trail, reports, or frameworks endpoint (data changes on every policy update or override create).

### Encryption

- Data at rest: MongoDB collections use the platform's existing MongoDB Atlas encryption (TLS + storage encryption). No additional field-level encryption needed for governance policies (thresholds are non-PII operational metadata).
- Data in transit: All routes served over HTTPS via the existing runtime TLS configuration.
- ClickHouse queries: Parameterized values prevent SQL injection. No PII is written into ClickHouse breach queries (threshold values are runtime parameters, not string interpolations).

### i18n

All user-facing Studio strings use `useTranslations('governance')` (the existing i18n namespace already in the GovernancePage stub). New keys added for all tab labels, card labels, table headers, empty states, error messages, and framework control labels. No server-side i18n required (API returns machine-readable codes; Studio handles display).

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                                 | Type                  | Risk                                                                                               |
| ------------------------------------------ | --------------------- | -------------------------------------------------------------------------------------------------- |
| `pipeline-analytics.ts` query logic        | Internal (in-process) | Medium — extracting shared query functions from the 901-line route file may expose hidden coupling |
| `AnalyticsCache` pattern                   | Internal reference    | Low — GovernanceCache follows the same Redis client pattern                                        |
| `requireProjectWideAnalyticsAccess`        | Internal middleware   | Low — reusing existing function as-is                                                              |
| `writeAuditLog`                            | Internal function     | Low — stable API, existing usage in auth.ts                                                        |
| `tenantIsolationPlugin`                    | Internal plugin       | Low — applied to both new models identically to existing models                                    |
| `VALID_PIPELINE_TYPES` / `PIPELINE_TABLES` | Internal constants    | Low — stable; governance validates against them                                                    |
| `@clickhouse/client`                       | External              | Low — already in project; governance adds streaming usage                                          |
| `pdfkit`                                   | External (new)        | Medium — new dependency; must be added to apps/runtime/package.json                                |
| Redis                                      | Infrastructure        | Low — governance uses same Redis instance as AnalyticsCache                                        |
| MongoDB                                    | Infrastructure        | Low — governance adds two new collections to existing instance                                     |

### Downstream (depends on this feature)

| Consumer                                          | Impact                                                                 |
| ------------------------------------------------- | ---------------------------------------------------------------------- |
| Studio GovernancePage                             | Directly replaced by this implementation                               |
| External auditors (`governance:audit-read` scope) | New access path — must be provisioned before external auditors can use |
| Alerts feature (deep-link CTAs)                   | No code dependency; governance only provides navigation deep-links     |

---

## 9. Open Questions & Decisions Needed

1. ~~**Policy version → thresholdAtTime join strategy**~~ **DECIDED**: Option (a) — `governance_policy_versions` append-only snapshot collection (see Section 5 Data Model). Schema defined, indexes specified, usage query specified. The LLD must implement the snapshot write atomically with the policy PUT (same request handler, sequential MongoDB writes). Open detail for LLD: atomicity strategy if the snapshot write fails after the policy write succeeds (compensating delete or idempotent re-insert on version conflict).

2. **Override DELETE for E2E test teardown**: E2E-13 requires deleting a `governance_overrides` record mid-test. Options: (a) add `DELETE /governance/audit/:eventRef/override` endpoint (production API), or (b) use a test teardown utility that directly drops override records by projectId (acceptable in tests since E2E tests must use API-only interaction per CLAUDE.md). **Decision**: The test teardown must use API-only interaction per CLAUDE.md standards — if `DELETE` is not a production endpoint, the test setup should create a separate project per test case with no prior overrides, making teardown unnecessary. LLD must address this.

3. **External auditor invitation flow**: FR-31 adds `governance:audit-read` scope. The invitation mechanism (how a project admin grants this scope to an external user not yet in the workspace) is not yet designed. The LLD can implement the scope and permission check, but the invitation UI is a Phase 2 concern.

4. **Pipeline-analytics shared query functions**: GovernanceStatusService calls the same ClickHouse query logic as the pipeline-analytics route. The cleanest approach is to extract `getPipelineSummary(projectId, pipelineType, period, tenantId)` from `pipeline-analytics.ts` into a shared service module. This refactor is required before implementing `GovernanceStatusService`. The LLD must plan this extraction as Phase 0.

5. **Redis cache bust for E2E tests**: Short TTL (`GOVERNANCE_STATUS_CACHE_TTL_SECONDS=5`) vs `?nocache=true` param. The LLD should choose one approach and document it in the test infrastructure setup. Short TTL is simpler (no prod-code change for testing); `?nocache=true` is more explicit but adds test-only code paths.

---

## 10. FR Traceability

| FR Group             | FRs                        | HLD Address                                                                                                                                                                                                                     |
| -------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Policy CRUD          | FR-1, FR-2, FR-4           | Section 6 API (POST/PUT/DELETE /governance/policies), Section 5 Data Model (`governance_policies` schema, METRIC_REGISTRY validation), Section 4 Concern #3 (error codes GOVERNANCE_POLICY_EXISTS, GOVERNANCE_VALIDATION_ERROR) |
| Policy UI            | FR-3, FR-15                | Section 3 Component Diagram (`GovernancePolicyEditor.tsx` slide-over), Section 4 Concern #12 (Studio test strategy)                                                                                                             |
| Status aggregation   | FR-5, FR-6, FR-7, FR-9     | Section 3 Data Flow (Governance Status Request), Section 6 API (GET /governance/status), Section 4 Concern #1 (GovernanceCache, 5-min TTL, `governance:` namespace), Concern #9 (P95 targets)                                   |
| Agent Registry       | FR-8, FR-10, FR-11         | Section 3 Component Diagram (`AgentComplianceTable`, `AgentComplianceDetailPanel`), Section 6 status response shape                                                                                                             |
| Compliance Tab       | FR-12, FR-13, FR-14        | Section 3 Component Diagram (`ComplianceCardGrid`, `ComplianceCard`), Section 6 status response                                                                                                                                 |
| Audit Trail          | FR-16, FR-17, FR-18, FR-19 | Section 3 Data Flow (Audit Trail Request), Section 6 API (GET /governance/audit), Section 5 Data Model (`governance_overrides` for merge), Concern #4 (SQL injection prevention)                                                |
| Export               | FR-20, FR-21, FR-22, FR-23 | Section 6 API (GET /governance/report.csv, /report.pdf), Section 3 Data Flow (PDF), Section 4 Concern #13 (pdfkit on event loop), Concern #9 (PDF latency, CSV streaming)                                                       |
| UX                   | FR-24, FR-25, FR-26, FR-27 | Section 3 Component Diagram (ExportBar, loading states in SWR hooks), Section 7 (i18n), Section 4 Concern #8 (error banners)                                                                                                    |
| Human override       | FR-28, FR-29               | Section 6 API (POST /governance/audit/:eventRef/override), Section 5 Data Model (`governance_overrides`), Section 4 Concern #7 (idempotency: 409 on duplicate eventRef)                                                         |
| Policy versioning    | FR-30                      | Section 5 Data Model (`governance_policy_versions` schema), Section 9 Open Question #1 (thresholdAtTime resolution strategy — MUST resolve in LLD)                                                                              |
| External auditor     | FR-31                      | Section 4 Concern #4 (`governance:audit-read` scope), Section 6 API (audit/report endpoints accept `governance:audit-read`), Section 9 Open Question #3                                                                         |
| Framework checklists | FR-32, FR-33, FR-34, FR-35 | Section 3 Data Flow (Framework Checklist Request), Section 3 Component Diagram (`governance-frameworks.ts`, `GovernanceFrameworksService`), Section 6 API (GET /governance/frameworks + response shape)                         |
| Framework in exports | FR-36                      | Section 3 Data Flow (PDF includes frameworks section), Section 6 API (report endpoints), Section 4 Concern #12 (E2E-15 validates PDF)                                                                                           |

## 11. References

- Feature spec: `docs/features/governance.md`
- Test spec: `docs/testing/governance.md`
- Analytics insights HLD (data flow pattern): `docs/specs/analytics-insights-dashboard.hld.md`
- Alerts HLD (RBAC, ClickHouse, MongoDB patterns): `docs/specs/alerts.hld.md`
- Pipeline analytics route: `apps/runtime/src/routes/pipeline-analytics.ts`
- Pipeline analytics helpers: `apps/runtime/src/routes/pipeline-analytics-helpers.ts`
- RBAC middleware: `apps/runtime/src/middleware/rbac.ts`
- Audit log function: `apps/runtime/src/repos/auth-repo.ts`
- GovernancePage stub: `apps/studio/src/components/governance/GovernancePage.tsx`
- Server mount patterns: `apps/runtime/src/server.ts`
