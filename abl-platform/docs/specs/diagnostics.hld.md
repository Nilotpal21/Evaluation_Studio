# High-Level Design: Diagnostics Engine

> **Feature ID:** #43
> **Feature Spec:** `docs/features/diagnostics.md`
> **Test Spec:** `docs/testing/diagnostics.md`
> **Status:** PLANNED
> **Created:** 2026-03-22

---

## 1. Architecture Overview

The Diagnostics Engine extends the existing runtime diagnostics subsystem with four new capabilities: report persistence, scheduled execution, new analyzers, and aggregation APIs. The architecture follows the existing plugin-based analyzer pattern and integrates with the platform's standard infrastructure (MongoDB, Redis/BullMQ, Express middleware chain).

### System Context Diagram

```
                    +------------------+
                    |    Studio UI     |
                    |  (Diagnostic     |
                    |   Panel)         |
                    +--------+---------+
                             |
                    +--------v---------+
                    |  Admin Dashboard |
                    | (Health Summary) |
                    +--------+---------+
                             |
                    +--------v---------+         +------------------+
                    |   Runtime API    |<------->| MCP Debug Tools  |
                    | /diagnostics/*   |         | (debug_diagnose) |
                    +--------+---------+         +------------------+
                             |
               +-------------+-------------+
               |                           |
    +----------v----------+     +----------v----------+
    | DiagnosticEngine    |     | DiagnosticScheduler |
    | (Analyzer Registry) |     | (BullMQ Worker)     |
    +----------+----------+     +----------+----------+
               |                           |
    +----------v----------+     +----------v----------+
    | Analyzer Plugins    |     | Report Persistence  |
    | (11+ analyzers)     |     | (MongoDB + TTL)     |
    +---------------------+     +---------------------+
               |
    +----------v----------+
    | Data Sources        |
    | - MongoDB (config)  |
    | - Redis (cache)     |
    | - ClickHouse (metrics)|
    | - HTTP (webhooks)   |
    +---------------------+
```

### Component Inventory

| Component            | Location                                      | Status | Change                  |
| -------------------- | --------------------------------------------- | ------ | ----------------------- |
| DiagnosticEngine     | `runtime/services/diagnostics/engine.ts`      | Exists | Minor: add persist hook |
| Analyzer Interface   | `runtime/services/diagnostics/types.ts`       | Exists | Extend: add remediation |
| 7 Existing Analyzers | `runtime/services/diagnostics/analyzers/`     | Exists | No change               |
| 4 New Analyzers      | `runtime/services/diagnostics/analyzers/`     | New    | Create                  |
| Diagnostic Routes    | `runtime/routes/diagnostics.ts`               | Exists | Extend: add 5 endpoints |
| Report Persistence   | `runtime/services/diagnostics/persistence.ts` | New    | Create                  |
| Diagnostic Scheduler | `runtime/services/diagnostics/scheduler.ts`   | New    | Create                  |
| Summary Service      | `runtime/services/diagnostics/summary.ts`     | New    | Create                  |
| Remediation Service  | `runtime/services/diagnostics/remediation.ts` | New    | Create                  |
| DB Model             | `database/models/diagnostic-report.ts`        | New    | Create                  |
| DB Model             | `database/models/diagnostic-schedule.ts`      | New    | Create                  |

---

## 2. Architectural Concerns

### 2.1 Resource Isolation

**Tenant Isolation:**

- Every MongoDB query includes `tenantId` in the filter (both reads and writes).
- `StoredDiagnosticReport` and `DiagnosticSchedule` models have `tenantId` as a required field with compound index.
- Cross-tenant queries return empty results (HTTP 404 pattern), never 403.
- The `DiagnosticContext` already carries `tenantId`; persistence layer propagates it.

**Project Isolation:**

- All project-scoped endpoints use `requireProjectPermission(req, res, 'diagnostics:read'|'diagnostics:write')`.
- Diagnostic reports stored with `projectId` and filtered by it in all queries.
- Summary endpoint aggregates within a single project scope.

**User Isolation:**

- Manual diagnostic runs record `createdBy` (userId from auth context).
- Remediation actions record `executedBy` for audit trail.
- Viewing diagnostics requires project-level read permission (not user-scoped, as diagnostics are project-level resources).

### 2.2 Centralized Auth

- Diagnostic routes use the existing middleware chain: `authMiddleware` -> `requireProjectScope` -> `tenantRateLimit` -> `requireProjectPermission`.
- New permissions: `diagnostics:read` (view reports, history, summary), `diagnostics:write` (manage schedules, execute remediation).
- Tenant summary endpoint uses `requirePlatformAdmin()` + `requirePlatformAdminIp()`.
- No custom token verification anywhere.

### 2.3 Stateless Distributed

- DiagnosticEngine remains a singleton per runtime pod, but diagnostic state is NOT the source of truth.
- All reports are persisted to MongoDB immediately after generation.
- Scheduled runs use BullMQ with Redis-backed job queues -- no pod-local scheduling.
- Multiple runtime pods can process scheduled jobs concurrently (BullMQ handles deduplication via `jobId`).
- DiagnosticSchedule lives in MongoDB, not in-memory -- any pod can read and execute.

### 2.4 Traceability

- Scheduled diagnostic runs emit `TraceEvent` type `diagnostic_run_completed` with: tenantId, projectId, status, duration, findingCounts.
- Remediation actions emit `TraceEvent` type `diagnostic_remediation_executed` with: actor, actionType, findingCode, result.
- All analyzer failures logged via `createLogger('diag-<name>')` (existing pattern).
- Report IDs link to specific diagnostic runs for post-mortem analysis.

### 2.5 Compliance

- **Credential exposure prevention**: Reports MUST NOT contain credential values (API keys, secrets). Only provider names, staleness metadata, and availability flags.
- **Data minimization**: Reports have TTL (default 30 days) via MongoDB TTL index on `createdAt`.
- **Right to erasure**: Deleting a tenant cascades to all diagnostic reports and schedules for that tenant.
- **Audit logging**: Remediation actions are audit-logged with actor identity.

### 2.6 Performance

- **Analyzer execution**: Analyzers within a depth group run concurrently (Promise.all), not sequentially.
- **Webhook probe timeout**: 3-second timeout per endpoint to prevent stalling the diagnostic run.
- **Report compression**: Reports exceeding 50KB are gzip-compressed before storage.
- **Pagination**: History endpoint enforces max page size of 100 to prevent unbounded queries.
- **Scheduled run staggering**: BullMQ jobs use `jobId: diagnostics:${projectId}` to prevent duplicate runs; repeat option distributes load.
- **ClickHouse queries**: Conversation quality analyzer uses time-bounded queries (last 24h) to limit scan range.

### 2.7 Error Handling

- Each analyzer is wrapped in try/catch in the engine. Failures produce `ANALYZER_FAILED` warning findings (existing pattern).
- Persistence failures are logged and do not block the API response (report is still returned to caller).
- Scheduled run failures are recorded in BullMQ as failed jobs with error details.
- Remediation action failures return `{ success: false, error: { code, message } }` response envelope.
- Webhook analyzer handles network errors (timeout, DNS, connection refused) as warning findings, not thrown errors.

### 2.8 Scalability

- **Horizontal scaling**: BullMQ workers on multiple runtime pods process scheduled jobs. No single-point-of-failure.
- **MongoDB indexes**: Compound indexes on (tenantId, projectId, createdAt) and (tenantId, projectId, agentName, createdAt) ensure efficient queries.
- **TTL cleanup**: MongoDB TTL index automatically purges old reports without application-level cleanup jobs.
- **Analyzer plugin architecture**: New analyzers can be added without modifying the engine (register via `engine.register()`).

### 2.9 Observability

- **Prometheus metrics**: `diagnostics_run_duration_ms` histogram, `diagnostics_finding_count` counter (by severity), `diagnostics_analyzer_failures_total` counter.
- **ClickHouse events**: Scheduled runs produce trace events for long-term analytics.
- **Structured logging**: All components use `createLogger` from `@abl/compiler/platform`.
- **Health integration**: Diagnostic scheduler health is surfaced via the existing platform health check system.

### 2.10 Backward Compatibility

- Existing API endpoints (`GET /agents/:agentName`, `GET /sessions/:sessionId`) remain unchanged by default.
- Persistence opt-in via `?persist=true` query parameter (existing calls without it behave identically).
- DiagnosticReport shape unchanged -- new fields (`trigger`, `duration`) are additive.
- MCP `debug_diagnose` tool continues to work via the same API; enhanced to query stored reports as a fallback.
- Existing analyzer interface unchanged -- new analyzers implement the same `Analyzer` interface.

### 2.11 Deployment

- **Feature flag**: `DIAGNOSTICS_PERSISTENCE_ENABLED` (default: false) gates persistence and scheduling in Phase 1.
- **Database migration**: New MongoDB collections (`diagnostic_reports`, `diagnostic_schedules`) created on first write (Mongoose auto-creation).
- **No schema migration needed**: New collections, not modifications to existing ones.
- **BullMQ queue**: `diagnostics-scheduler` queue created on first scheduled job.
- **Rolling deployment safe**: Old pods ignore the new API endpoints; new pods handle both old and new routes.

### 2.12 Testing

- See `docs/testing/diagnostics.md` for full test spec.
- 7 E2E scenarios exercising real HTTP API with full middleware chain.
- 8 integration scenarios testing individual components with real MongoDB.
- No mocking of codebase components in E2E tests.
- SSRF protection explicitly tested.
- Tenant/project isolation verified across multiple scenarios.

---

## 3. Data Flow

### 3.1 On-Demand Diagnostic Run (with Persistence)

```
Client -> GET /api/projects/:pId/diagnostics/agents/:name?persist=true
  -> authMiddleware -> requireProjectScope -> tenantRateLimit -> requireProjectPermission
  -> Route handler:
    1. Build DiagnosticContext { tenantId, projectId, agentName, depth }
    2. engine.diagnose(context) -> runs applicable analyzers concurrently
    3. Receive DiagnosticReport
    4. If persist=true: persistence.save(report, { trigger: 'manual', createdBy: userId })
    5. Return { success: true, data: report }
```

### 3.2 Scheduled Diagnostic Run

```
BullMQ Worker processes 'diagnostics-scheduler' job:
  1. Read DiagnosticSchedule from MongoDB
  2. List agents for project (or use schedule.agents filter)
  3. For each agent:
    a. Build DiagnosticContext { tenantId, projectId, agentName, depth }
    b. engine.diagnose(context)
    c. persistence.save(report, { trigger: 'scheduled' })
  4. Update schedule.lastRunAt, schedule.nextRunAt
  5. Emit TraceEvent 'diagnostic_run_completed'
```

### 3.3 History Query

```
Client -> GET /api/projects/:pId/diagnostics/history?agentName=X&from=...&to=...&page=1&limit=50
  -> Auth middleware chain
  -> Route handler:
    1. Build MongoDB query: { tenantId, projectId, agentName?, createdAt: { $gte, $lte } }
    2. Execute with .sort({ createdAt: -1 }).skip(offset).limit(limit)
    3. Count total for pagination
    4. Return { success: true, data: { reports, pagination: { total, page, limit, pages } } }
```

### 3.4 Remediation Action

```
Client -> POST /api/projects/:pId/diagnostics/remediate
  -> Auth middleware chain (requires diagnostics:write)
  -> Route handler:
    1. Validate request body (reportId, findingCode, actionType, confirmed)
    2. Load report from persistence (verify ownership)
    3. Verify finding exists in report
    4. If !confirmed: return action preview with confirmation prompt
    5. If confirmed: execute remediation action
    6. Emit TraceEvent 'diagnostic_remediation_executed'
    7. Return { success: true, data: RemediationResult }
```

---

## 4. Alternatives Considered

### Alternative 1: ClickHouse for Report Storage (Rejected)

**Description:** Store diagnostic reports in ClickHouse instead of MongoDB.

**Pros:**

- Better time-series query performance for trending
- Natural fit for analytics queries

**Cons:**

- Reports are structured documents with nested arrays (findings, evidence) -- poor fit for columnar storage
- Would require a separate query pattern from the rest of the runtime (which uses MongoDB)
- ClickHouse is optional infrastructure (not all deployments have it)
- Reports are typically < 10KB, well within MongoDB's sweet spot

**Decision:** Use MongoDB for report storage. ClickHouse is used only for conversation quality metrics (already time-series data).

### Alternative 2: Redis Pub/Sub for Real-Time Diagnostic Streaming (Rejected)

**Description:** Stream diagnostic findings in real-time via Redis Pub/Sub to connected Studio clients.

**Pros:**

- Immediate visibility of diagnostic results
- Could integrate with existing WebSocket infrastructure

**Cons:**

- Adds complexity to the diagnostic engine (streaming vs batch)
- Diagnostics are not real-time events; they're periodic health checks
- WebSocket state management adds failure modes
- Batch reports via API polling is simpler and sufficient

**Decision:** Use polling-based API queries. Diagnostic reports are generated on-demand or on schedule and fetched via REST API.

### Alternative 3: Separate Diagnostics Microservice (Rejected)

**Description:** Extract diagnostics into a standalone service with its own database and API.

**Pros:**

- Independent scaling
- Clean separation of concerns
- Could serve multiple platform services

**Cons:**

- Analyzers need direct access to runtime internals (session state, agent IR, executor)
- Would require an RPC layer between runtime and diagnostics service
- Increases deployment complexity
- Adds network latency to diagnostic runs
- The existing plugin architecture in the runtime is sufficient for extensibility

**Decision:** Keep diagnostics within the runtime service. The plugin-based analyzer pattern provides sufficient extensibility without the overhead of a separate service.

---

## 5. New Analyzer Designs

### 5.1 GuardrailHealthAnalyzer

**Category:** infra
**What it checks:**

1. Loads agent's guardrail references from DSL/IR
2. For each referenced guardrail, checks existence in GuardrailConfig collection
3. For guardrails with external providers (OpenAI moderation, custom HTTP), probes endpoint reachability
4. Checks guardrail policy scoping (agent-level vs project-level vs tenant-level)

**Findings:**

- `GUARDRAIL_NOT_FOUND` (warning): Referenced guardrail has no DB record
- `GUARDRAIL_PROVIDER_UNREACHABLE` (warning): External provider endpoint timed out or errored
- `GUARDRAIL_MISCONFIGURED` (warning): Config exists but missing required fields
- `GUARDRAILS_OK` (info): All guardrails properly configured

### 5.2 MemoryHealthAnalyzer

**Category:** infra
**What it checks:**

1. Parses DSL for REMEMBER/RECALL directives
2. Checks FactStore availability (MongoDB collection accessibility)
3. If session context available, checks userId presence
4. Cross-references with memory_unavailable trace events

**Findings:**

- `MEMORY_NOT_CONFIGURED` (info): Agent does not use memory directives
- `MEMORY_FACTSTORE_UNAVAILABLE` (error): FactStore not accessible
- `MEMORY_NO_USER_ID` (warning): Session lacks userId for memory scoping
- `MEMORY_OK` (info): Memory subsystem healthy

### 5.3 WebhookReachabilityAnalyzer

**Category:** infra
**What it checks:**

1. Loads ProjectTool records for the project
2. Extracts HTTP endpoint URLs from tool configurations
3. Sends HEAD request with 3-second timeout to each endpoint
4. SSRF protection: blocks private IPs (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8)

**Findings:**

- `WEBHOOK_UNREACHABLE` (warning): Endpoint did not respond within timeout
- `WEBHOOK_SSRF_BLOCKED` (error): Endpoint URL resolves to private IP
- `WEBHOOK_ERROR` (warning): Endpoint returned non-2xx status
- `WEBHOOKS_OK` (info): All tool endpoints reachable

### 5.4 ConversationQualityAnalyzer

**Category:** behavioral
**What it checks:**

1. Queries ClickHouse for session metrics over the last 24 hours
2. Computes: completion rate, average turns, escalation rate, error rate
3. Flags anomalies against configurable thresholds

**Findings:**

- `HIGH_ESCALATION_RATE` (warning): >30% of sessions escalated
- `LOW_COMPLETION_RATE` (warning): <50% of sessions completed
- `EXCESSIVE_TURNS` (warning): Average turns >20 per session
- `CONVERSATION_QUALITY_OK` (info): All metrics within normal range
- `CONVERSATION_QUALITY_NO_DATA` (info): Insufficient data for analysis

---

## 6. Remediation Framework Design

### Action Registry

```typescript
interface RemediationHandler {
  type: string;
  canHandle(finding: DiagnosticFinding): boolean;
  preview(finding: DiagnosticFinding, context: DiagnosticContext): RemediationPreview;
  execute(finding: DiagnosticFinding, context: DiagnosticContext): Promise<RemediationResult>;
}
```

### Built-in Actions

| Action Type             | Trigger Finding       | What It Does                                                |
| ----------------------- | --------------------- | ----------------------------------------------------------- |
| `revalidate_credential` | `CREDENTIAL_STALE`    | Calls the credential validation API to re-check the API key |
| `retry_connection`      | `WEBHOOK_UNREACHABLE` | Re-probes the tool endpoint and updates the finding         |
| `clear_cache`           | Various               | Invalidates IR cache or Redis entries for the target agent  |

### Safety Guarantees

- All actions require `confirmed: true` in the request body.
- First call without confirmation returns a preview describing what will happen.
- Every action execution is audit-logged via TraceEvent.
- Actions are idempotent (safe to retry).
- Actions cannot modify agent DSL or configuration (read-only remediation only).

---

## 7. MongoDB Schema Design

### diagnostic_reports Collection

```javascript
{
  tenantId: String,        // Required, indexed
  projectId: String,       // Required, indexed
  agentName: String,       // Optional, indexed
  sessionId: String,       // Optional
  depth: String,           // enum: quick|standard|deep
  trigger: String,         // enum: manual|scheduled|mcp
  status: String,          // enum: healthy|degraded|broken
  findings: [{
    analyzer: String,
    severity: String,
    code: String,
    title: String,
    detail: String,
    suggestion: String,
    evidence: [{ type: String, label: String, data: Mixed }],
    remediation: {         // Optional, for remediable findings
      actionType: String,
      params: Mixed
    }
  }],
  summary: {
    errors: Number,
    warnings: Number,
    infos: Number,
    analyzersRun: [String]
  },
  config: Mixed,
  duration: Number,
  createdAt: Date,         // TTL index target
  createdBy: String        // Optional userId
}

// Indexes
db.diagnostic_reports.createIndex({ tenantId: 1, projectId: 1, createdAt: -1 })
db.diagnostic_reports.createIndex({ tenantId: 1, projectId: 1, agentName: 1, createdAt: -1 })
db.diagnostic_reports.createIndex({ createdAt: 1 }, { expireAfterSeconds: 2592000 })
```

### diagnostic_schedules Collection

```javascript
{
  tenantId: String,
  projectId: String,
  enabled: Boolean,
  intervalMinutes: Number,
  depth: String,
  agents: [String],        // null = all agents
  lastRunAt: Date,
  nextRunAt: Date,
  createdBy: String,
  updatedAt: Date
}

// Indexes
db.diagnostic_schedules.createIndex({ tenantId: 1, projectId: 1 }, { unique: true })
```

---

## 8. API Route Structure

```
/api/projects/:projectId/diagnostics/
  GET    /agents/:agentName          (existing, extended with ?persist=true)
  GET    /sessions/:sessionId        (existing, extended with ?persist=true)
  GET    /history                    (new)
  GET    /summary                    (new)
  GET    /schedule                   (new)
  PUT    /schedule                   (new)
  POST   /remediate                  (new)

/api/tenants/diagnostics/
  GET    /summary                    (new, admin only)
```

All routes share the same middleware chain: `authMiddleware` -> `requireProjectScope` -> `tenantRateLimit` -> `requireProjectPermission`.

The tenant-level route uses: `authMiddleware` -> `tenantRateLimit` -> `requirePlatformAdmin` -> `requirePlatformAdminIp`.

---

## 9. Risk Register

| ID  | Risk                                              | Likelihood | Impact | Mitigation                                                     | Owner   |
| --- | ------------------------------------------------- | ---------- | ------ | -------------------------------------------------------------- | ------- |
| R1  | Report storage growth overwhelms MongoDB          | Medium     | Medium | TTL index (30d), compression (>50KB), max page size (100)      | Runtime |
| R2  | SSRF via webhook analyzer                         | Low        | High   | Only probe ProjectTool URLs, block private IPs, DNS validation | Runtime |
| R3  | Scheduled run stampede                            | Medium     | Medium | BullMQ jobId dedup, concurrency limit per worker, stagger      | Runtime |
| R4  | ClickHouse unavailability breaks diagnostics      | Medium     | Low    | ConversationQualityAnalyzer returns empty findings on failure  | Runtime |
| R5  | Remediation action causes unintended side effects | Low        | High   | Require confirmation, preview mode, audit logging, read-only   | Runtime |
| R6  | Breaking change to DiagnosticReport shape         | Low        | High   | New fields are additive only, no field removals or renames     | Runtime |
