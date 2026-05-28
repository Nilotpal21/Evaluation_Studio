# Feature Spec: Diagnostics Engine

> **Feature ID:** #43
> **Status:** ALPHA
> **Owner:** Runtime Team
> **Created:** 2026-03-22
> **Last Updated:** 2026-03-22

---

## 1. Problem Statement

ABL platform operators and agent developers face difficulty diagnosing why agents produce empty responses, fail to resolve models, lose credential chains, or exhibit flow execution anomalies. Today, troubleshooting requires manual inspection of logs, database records, and runtime state across multiple services. There is no unified, automated diagnostic capability that can systematically identify root causes and suggest fixes.

The existing diagnostics infrastructure (7 analyzers, 2 API endpoints, pattern detection, MCP debug tools, platform health checks) provides a solid foundation but has critical gaps:

- **No historical diagnostics**: Analyzers only inspect live in-memory sessions; evicted sessions cannot be diagnosed.
- **No scheduled/proactive health checks**: Diagnostics are purely reactive (on-demand API calls).
- **No diagnostic history or trending**: Reports are ephemeral; there is no way to track degradation over time.
- **No Studio UI integration**: Developers must use CLI/MCP tools or raw API calls.
- **No cross-agent/cross-project diagnostics**: Each diagnostic call targets a single agent or session.
- **No remediation actions**: Findings include suggestions as text but no automated fix capabilities.
- **Limited coverage**: No analyzers for guardrail health, webhook/tool endpoint reachability, memory subsystem, or conversation quality.

## 2. Background & Context

### Current Implementation

The diagnostics subsystem lives in `apps/runtime/src/services/diagnostics/` and consists of:

**DiagnosticEngine** (`engine.ts`): Pluggable analyzer registry with depth filtering (quick/standard/deep). Singleton with lazy analyzer registration.

**7 Registered Analyzers:**

| Analyzer                  | Category   | What It Checks                                                                      |
| ------------------------- | ---------- | ----------------------------------------------------------------------------------- |
| `model-resolution`        | infra      | 5-level model resolution chain (IR, Agent DB, Project DB, Tenant Model, Credential) |
| `credential-chain`        | infra      | Active credentials, provider allowlist, provider-model match, staleness             |
| `tool-binding`            | infra      | DSL tool references vs ProjectTool DB records                                       |
| `encryption-availability` | infra      | ENCRYPTION_MASTER_KEY env var, MongoDB readyState                                   |
| `execution-status`        | execution  | Session health entries, LLM client presence, escalation state                       |
| `empty-response`          | behavioral | LLM wiring failures, missing reasoning zones, absent respond steps                  |
| `flow-state`              | execution  | Step stall detection (5min threshold), excessive backtracking (>5 count)            |

**Pattern Detection** (`diagnostic-patterns.ts`): 8 trace-event detectors for behavioral issues (memory silent noop, backtrack escalation, preference not persisted, ON_INPUT drop, validation fail-open, strategy mismatch, gather stall, ambiguous correction).

**API Routes** (`routes/diagnostics.ts`): Two endpoints mounted at `/api/projects/:projectId/diagnostics`:

- `GET /agents/:agentName` -- Quick (infra-only) diagnostic
- `GET /sessions/:sessionId?depth=quick|standard|deep` -- Full session diagnostic

**Platform Health** (`routes/platform-admin-health.ts`): System-wide service health checks (18 services in registry) with native probes (MongoDB, Redis, ClickHouse) and HTTP probes.

**MCP Debug Tools** (`packages/mcp-debug/`): `debug_diagnose` tool that calls the diagnostics API and formats results for Claude.

**Admin UI** (`apps/admin/`): System health dashboard proxying to runtime platform health endpoint.

### Gaps Identified

1. **Persistence**: DiagnosticReport is returned and discarded. No MongoDB collection for historical reports.
2. **Scheduling**: No cron/BullMQ job for periodic health checks.
3. **Aggregation**: No cross-agent/cross-project diagnostic summaries.
4. **Studio Integration**: No UI components for viewing diagnostics in the agent development workflow.
5. **Remediation**: No action framework for automated fixes (e.g., auto-retry credential validation).
6. **Coverage Gaps**: Missing analyzers for guardrails, webhooks, memory subsystem, conversation quality metrics.
7. **Alerting**: No integration with notification systems when diagnostics detect persistent issues.

## 3. Goals & Non-Goals

### Goals

- G1: Extend the diagnostic engine with persistent report storage and historical querying.
- G2: Add scheduled diagnostic runs with configurable frequency per project.
- G3: Add 4+ new analyzers covering guardrail health, webhook reachability, memory subsystem, and conversation quality.
- G4: Expose aggregate diagnostic summaries (project-level, tenant-level) via new API endpoints.
- G5: Integrate diagnostics into Studio with a diagnostic panel showing current health, historical trends, and actionable findings.
- G6: Add remediation action framework allowing findings to trigger automated or user-confirmed fixes.
- G7: Maintain backward compatibility with existing API endpoints and MCP debug tools.

### Non-Goals

- NG1: Replacing the existing platform health check system (it remains for infrastructure-level checks).
- NG2: Real-time streaming of diagnostic events via WebSocket (batch reports are sufficient).
- NG3: Building a full APM/observability platform (use ClickHouse + Coroot for that).
- NG4: Cross-tenant diagnostic access (diagnostics remain tenant-isolated).
- NG5: AI-powered root cause analysis (findings use rule-based detection, not LLM inference).

## 4. User Stories

### US-1: Agent Developer -- On-Demand Diagnosis

As an agent developer, I want to run a diagnostic check on my agent from Studio so that I can quickly identify why my agent is producing empty responses without switching to CLI tools.

**Acceptance Criteria:**

- Studio agent detail page shows a "Diagnose" button.
- Clicking it runs a standard-depth diagnostic and displays findings inline.
- Findings are color-coded by severity (error=red, warning=amber, info=blue).
- Each finding shows title, detail, suggestion, and evidence.

### US-2: Platform Operator -- Scheduled Health Checks

As a platform operator, I want diagnostic checks to run automatically every 15 minutes so that I can be alerted to degradation before users report issues.

**Acceptance Criteria:**

- Configurable schedule per project (default: 15 min, min: 5 min, max: 24h).
- Scheduled runs stored in MongoDB with TTL-based cleanup (30-day retention).
- Admin dashboard shows scheduled run history with pass/fail/degraded trends.

### US-3: Agent Developer -- Historical Trend

As an agent developer, I want to see how my agent's diagnostic health has changed over the past 7 days so that I can correlate issues with recent changes.

**Acceptance Criteria:**

- API endpoint returns time-series of diagnostic status (healthy/degraded/broken) per agent.
- Studio shows a sparkline or mini-chart of agent health over time.

### US-4: Platform Operator -- Cross-Project Summary

As a platform operator, I want a single dashboard showing diagnostic health across all projects so that I can prioritize which projects need attention.

**Acceptance Criteria:**

- Aggregation endpoint returns project-level summaries (worst status, finding counts).
- Admin dashboard shows project health grid.

### US-5: Agent Developer -- Guardrail Health Check

As an agent developer, I want the diagnostic engine to check whether my agent's guardrails are properly configured and their external providers are reachable, so that I can catch guardrail misconfigurations before they affect users.

**Acceptance Criteria:**

- New `guardrail-health` analyzer checks guardrail records, provider reachability, and policy scoping.
- Findings include specific guardrail names and configuration issues.

### US-6: Agent Developer -- Webhook/Tool Endpoint Reachability

As an agent developer, I want the diagnostic engine to verify that all tool endpoints my agent references are reachable, so that I can catch connectivity issues before runtime.

**Acceptance Criteria:**

- New `webhook-reachability` analyzer sends HTTP HEAD/OPTIONS to tool endpoints.
- Timeout and unreachable endpoints flagged as warnings.
- SSRF protection: only checks endpoints registered in ProjectTool records.

### US-7: Agent Developer -- Memory Subsystem Health

As an agent developer, I want diagnostics to check whether the memory subsystem (REMEMBER/RECALL) is properly configured and functional for my agent.

**Acceptance Criteria:**

- New `memory-health` analyzer checks FactStore availability, userId configuration, and memory-capable agent detection.
- Findings distinguish between "memory not configured" (info) and "memory configured but broken" (error).

### US-8: Platform Operator -- Remediation Actions

As a platform operator, I want diagnostic findings to include actionable remediation options that I can execute with a single click, such as re-validating a stale credential.

**Acceptance Criteria:**

- Remediation action framework with action types: `revalidate_credential`, `retry_connection`, `clear_cache`.
- Actions require explicit user confirmation before execution.
- Action execution is audit-logged.

### US-9: Agent Developer -- Conversation Quality Diagnostics

As an agent developer, I want diagnostics to analyze recent conversation quality metrics (completion rate, average turns, escalation rate) so that I can identify agents that need tuning.

**Acceptance Criteria:**

- New `conversation-quality` analyzer queries ClickHouse for recent session metrics.
- Flags agents with >30% escalation rate, <50% completion rate, or >20 average turns.

## 5. Functional Requirements

| ID    | Requirement                                                                                           | Priority | User Story |
| ----- | ----------------------------------------------------------------------------------------------------- | -------- | ---------- |
| FR-01 | Persist DiagnosticReport to MongoDB with tenantId, projectId, agentName, timestamp indexing           | P0       | US-2, US-3 |
| FR-02 | TTL-based cleanup of diagnostic reports (configurable, default 30 days)                               | P0       | US-2       |
| FR-03 | Scheduled diagnostic runs via BullMQ repeatable job per project                                       | P0       | US-2       |
| FR-04 | `GET /api/projects/:projectId/diagnostics/history` endpoint with pagination, date range, agent filter | P0       | US-3       |
| FR-05 | `GET /api/projects/:projectId/diagnostics/summary` endpoint returning aggregate health                | P0       | US-4       |
| FR-06 | `GET /api/tenants/diagnostics/summary` endpoint for cross-project summary (admin only)                | P1       | US-4       |
| FR-07 | GuardrailHealthAnalyzer: check guardrail records, provider config, external reachability              | P0       | US-5       |
| FR-08 | WebhookReachabilityAnalyzer: HTTP probe tool endpoints with SSRF protection                           | P1       | US-6       |
| FR-09 | MemoryHealthAnalyzer: FactStore availability, userId config, memory-capable detection                 | P1       | US-7       |
| FR-10 | ConversationQualityAnalyzer: query ClickHouse for session metrics, flag anomalies                     | P1       | US-9       |
| FR-11 | Remediation action framework with typed actions and confirmation flow                                 | P1       | US-8       |
| FR-12 | Remediation action: `revalidate_credential` -- re-run credential validation                           | P1       | US-8       |
| FR-13 | Remediation action: `retry_connection` -- re-probe a service endpoint                                 | P2       | US-8       |
| FR-14 | Remediation action: `clear_cache` -- invalidate IR cache or Redis entries                             | P2       | US-8       |
| FR-15 | Studio diagnostic panel component with findings list and severity indicators                          | P1       | US-1       |
| FR-16 | Studio historical health sparkline per agent                                                          | P2       | US-3       |
| FR-17 | Admin diagnostic summary dashboard with project health grid                                           | P2       | US-4       |
| FR-18 | Backward-compatible changes to existing endpoints (no breaking changes)                               | P0       | US-1       |
| FR-19 | MCP debug tools updated to use stored reports when available                                          | P1       | US-1       |
| FR-20 | Diagnostic depth configuration per project (quick/standard/deep default)                              | P1       | US-2       |

## 6. Non-Functional Requirements

| ID     | Requirement                                           | Target                                        |
| ------ | ----------------------------------------------------- | --------------------------------------------- |
| NFR-01 | Diagnostic run latency (standard depth, single agent) | < 5 seconds                                   |
| NFR-02 | Scheduled run throughput                              | 100 projects/min on single worker             |
| NFR-03 | Report storage growth                                 | < 10 KB per report average                    |
| NFR-04 | History query response time (30 days, single agent)   | < 500ms                                       |
| NFR-05 | Zero impact on agent execution hot path               | Diagnostics never block message processing    |
| NFR-06 | Tenant isolation                                      | Every query includes tenantId filter          |
| NFR-07 | Audit logging                                         | All remediation actions logged via TraceEvent |

## 7. Data Model

### DiagnosticReport (MongoDB Collection)

```typescript
interface StoredDiagnosticReport {
  _id: ObjectId;
  tenantId: string; // Partition key
  projectId: string; // Index
  agentName?: string; // Index (nullable for project-wide runs)
  sessionId?: string; // Index (nullable)
  depth: 'quick' | 'standard' | 'deep';
  trigger: 'manual' | 'scheduled' | 'mcp';
  status: 'healthy' | 'degraded' | 'broken';
  findings: DiagnosticFinding[];
  summary: {
    errors: number;
    warnings: number;
    infos: number;
    analyzersRun: string[];
  };
  config: Record<string, unknown>;
  duration: number; // ms
  createdAt: Date; // TTL index
  createdBy?: string; // userId for manual triggers
}
```

**Indexes:**

- `{ tenantId: 1, projectId: 1, createdAt: -1 }` -- History queries
- `{ tenantId: 1, projectId: 1, agentName: 1, createdAt: -1 }` -- Agent-specific history
- `{ createdAt: 1 }` -- TTL index (expireAfterSeconds: 2592000)

### DiagnosticSchedule (MongoDB Collection)

```typescript
interface DiagnosticSchedule {
  _id: ObjectId;
  tenantId: string;
  projectId: string;
  enabled: boolean;
  intervalMinutes: number; // 5-1440
  depth: 'quick' | 'standard' | 'deep';
  agents?: string[]; // null = all agents in project
  lastRunAt?: Date;
  nextRunAt?: Date;
  createdBy: string;
  updatedAt: Date;
}
```

### RemediationAction

```typescript
interface RemediationAction {
  type: 'revalidate_credential' | 'retry_connection' | 'clear_cache';
  findingCode: string; // Links to DiagnosticFinding.code
  params: Record<string, unknown>;
  requiresConfirmation: boolean;
}

interface RemediationResult {
  action: RemediationAction;
  success: boolean;
  message: string;
  executedAt: string;
  executedBy: string;
}
```

## 8. API Design

### New Endpoints

#### History

```
GET /api/projects/:projectId/diagnostics/history
  ?agentName=<name>     (optional)
  ?from=<ISO date>      (optional, default: 7 days ago)
  ?to=<ISO date>        (optional, default: now)
  &page=1&limit=50
Response: { success: true, data: { reports: StoredDiagnosticReport[], pagination: {...} } }
```

#### Summary

```
GET /api/projects/:projectId/diagnostics/summary
Response: { success: true, data: { overall: 'healthy'|'degraded'|'broken', agents: [...], lastRun: Date, findingCounts: {...} } }
```

#### Tenant Summary (Admin)

```
GET /api/tenants/diagnostics/summary
Response: { success: true, data: { projects: [{ projectId, status, lastRun, findings }] } }
```

#### Schedule Management

```
PUT /api/projects/:projectId/diagnostics/schedule
Body: { enabled, intervalMinutes, depth, agents? }
Response: { success: true, data: DiagnosticSchedule }

GET /api/projects/:projectId/diagnostics/schedule
Response: { success: true, data: DiagnosticSchedule }
```

#### Remediation

```
POST /api/projects/:projectId/diagnostics/remediate
Body: { reportId, findingCode, actionType, confirmed: boolean }
Response: { success: true, data: RemediationResult }
```

### Modified Endpoints

Existing endpoints (`GET /agents/:agentName`, `GET /sessions/:sessionId`) will be extended to optionally persist reports by adding `?persist=true` query parameter.

## 9. Security Considerations

- **Tenant isolation**: All queries include `tenantId` filter. Cross-tenant access returns 404.
- **Project isolation**: All project-scoped endpoints verify `projectId` via `requireProjectPermission`.
- **SSRF protection** (webhook analyzer): Only probe URLs from ProjectTool records; no arbitrary URL input.
- **Credential exposure**: Diagnostic reports MUST NOT include credential values (API keys, secrets). Only provider name and staleness metadata.
- **Remediation audit**: Every remediation action emits a TraceEvent with actor, action, and result.
- **Rate limiting**: Diagnostic endpoints share the existing `tenantRateLimit('request')` middleware.
- **Admin-only routes**: Tenant summary requires `requirePlatformAdmin()`.

## 10. Performance Considerations

- **Async analyzers**: All analyzers run concurrently within a depth group (not sequentially).
- **Webhook probe timeout**: 3-second timeout per endpoint to prevent stalling.
- **ClickHouse queries** (conversation quality): Use materialized views or pre-aggregated tables where possible.
- **Scheduled run staggering**: BullMQ jobs use `jobId` based on projectId to prevent duplicate runs; stagger start times across tenants.
- **Report compression**: Reports > 50KB are gzip-compressed before MongoDB storage.
- **Pagination**: History endpoint enforces max page size of 100.

## 11. Observability

- **Structured logging**: All analyzers use `createLogger('diag-<name>')`.
- **TraceEvents**: Scheduled runs emit `diagnostic_run_completed` events to ClickHouse.
- **Metrics**: Expose `diagnostics_run_duration_ms`, `diagnostics_finding_count`, `diagnostics_analyzer_failures` via Prometheus-compatible counters.
- **Health entry**: Engine failures produce `SessionHealthEntry` with category `diagnostics`.

## 12. Migration & Rollout Strategy

- **Phase 1 (ALPHA)**: Report persistence, history API, 2 new analyzers (guardrail, memory). Feature-flagged via `DIAGNOSTICS_PERSISTENCE_ENABLED`.
- **Phase 2 (ALPHA)**: Scheduled runs, webhook analyzer, conversation quality analyzer.
- **Phase 3 (BETA)**: Studio UI integration, remediation framework.
- **Phase 4 (BETA)**: Admin dashboard, tenant summary, MCP tool updates.
- **Graduation to STABLE**: After 2 weeks of production use with no critical issues.

## 13. Dependencies

| Dependency                        | Type     | Status                   |
| --------------------------------- | -------- | ------------------------ |
| DiagnosticEngine (runtime)        | Internal | Exists                   |
| BullMQ (scheduling)               | Internal | Exists                   |
| MongoDB (persistence)             | Internal | Exists                   |
| ClickHouse (conversation metrics) | Internal | Exists                   |
| Studio component library          | Internal | Exists                   |
| `@agent-platform/database/models` | Internal | Exists (needs new model) |
| `@agent-platform/shared-auth`     | Internal | Exists                   |

## 14. Testing Strategy

- **Unit tests**: Each new analyzer tested with mock contexts (min 5 test cases per analyzer).
- **Integration tests**: API endpoints tested with real Express server on random port, real middleware chain (min 5 scenarios).
- **E2E tests**: Full diagnostic flow from API call through engine to persisted report to history query (min 5 scenarios).
- **Load test**: Scheduled run with 50 concurrent projects to verify throughput NFR.

## 15. Risks & Mitigations

| Risk                       | Likelihood | Impact | Mitigation                                                              |
| -------------------------- | ---------- | ------ | ----------------------------------------------------------------------- |
| Report storage bloat       | Medium     | Medium | TTL index with 30-day default, gzip compression                         |
| Webhook probe abuse (SSRF) | Low        | High   | Only probe registered ProjectTool URLs, not user input                  |
| Analyzer failures cascade  | Low        | Medium | Each analyzer wrapped in try/catch, failure produces warning finding    |
| Scheduled run overload     | Medium     | Medium | BullMQ concurrency limit, per-tenant staggering                         |
| ClickHouse unavailability  | Medium     | Low    | Conversation quality analyzer degrades gracefully (returns no findings) |

## 16. Open Questions

- Q1: Should scheduled diagnostic runs notify via email/webhook when status degrades? (DECIDED: Defer to Phase 4, integrate with existing notification framework.)
- Q2: Should the Studio UI show diagnostics inline in the agent editor or as a separate panel? (DECIDED: Separate panel, accessible via tab in agent detail view.)
- Q3: Maximum number of diagnostic reports stored per agent? (DECIDED: TTL-based cleanup at 30 days; no per-agent cap.)

## 17. Success Metrics

| Metric                           | Target                                                  | Measurement                                                 |
| -------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------- |
| Mean time to diagnose (MTTD)     | < 30 seconds from symptom to finding                    | Telemetry: time from diagnostic API call to report delivery |
| Diagnostic coverage              | >= 11 analyzers registered                              | Count of registered analyzers in engine                     |
| Scheduled run success rate       | > 99%                                                   | BullMQ completed/failed ratio                               |
| Studio diagnostic panel adoption | > 50% of active projects use diagnostics within 30 days | Analytics event tracking                                    |

## 18. Glossary

| Term                   | Definition                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| **Analyzer**           | A pluggable diagnostic check that inspects a specific aspect of system health and produces findings |
| **DiagnosticFinding**  | A single issue detected by an analyzer, with severity, code, detail, and suggestion                 |
| **DiagnosticReport**   | The complete output of a diagnostic run, containing all findings from all applicable analyzers      |
| **DiagnosticDepth**    | Controls which analyzers run: quick (infra), standard (infra+execution), deep (all)                 |
| **Remediation Action** | An automated fix that can be triggered from a diagnostic finding                                    |
| **Pattern Detection**  | Trace-event scanning for behavioral anomaly signatures                                              |
