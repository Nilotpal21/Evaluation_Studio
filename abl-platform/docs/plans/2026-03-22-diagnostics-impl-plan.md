# LLD + Implementation Plan: Diagnostics Engine

> **Feature ID:** #43
> **Feature Spec:** `docs/features/diagnostics.md`
> **Test Spec:** `docs/testing/diagnostics.md`
> **HLD:** `docs/specs/diagnostics.hld.md`
> **Status:** PLANNED
> **Created:** 2026-03-22

---

## Implementation Phases

The implementation is organized into 5 phases, each with clear exit criteria. Phases are ordered by dependency chain and risk profile (highest-risk first).

---

## Phase 1: Report Persistence and History API

**Goal:** Persist diagnostic reports to MongoDB and expose a history query endpoint.

**FR Coverage:** FR-01, FR-02, FR-04, FR-18

### Task 1.1: Create DiagnosticReport Mongoose Model

**Files to create:**

- `packages/database/src/models/diagnostic-report.ts`

**Implementation:**

1. Define Mongoose schema matching the `StoredDiagnosticReport` interface from the feature spec.
2. Required fields: `tenantId`, `projectId`, `status`, `findings`, `summary`, `depth`, `trigger`, `createdAt`.
3. Optional fields: `agentName`, `sessionId`, `config`, `duration`, `createdBy`.
4. Indexes:
   - `{ tenantId: 1, projectId: 1, createdAt: -1 }` -- compound for history queries
   - `{ tenantId: 1, projectId: 1, agentName: 1, createdAt: -1 }` -- agent-specific history
   - `{ createdAt: 1 }` with `expireAfterSeconds: 2592000` -- TTL (30 days)
5. Export model from `packages/database/src/models/index.ts`.

**Validation:**

- `z.string().min(1)` for tenantId, projectId (per CLAUDE.md: never `.cuid()`)
- `z.enum(['quick', 'standard', 'deep'])` for depth
- `z.enum(['manual', 'scheduled', 'mcp'])` for trigger
- `z.enum(['healthy', 'degraded', 'broken'])` for status

### Task 1.2: Create Report Persistence Service

**Files to create:**

- `apps/runtime/src/services/diagnostics/persistence.ts`

**Implementation:**

1. `saveReport(report: DiagnosticReport, meta: { trigger, createdBy?, tenantId, projectId, agentName?, sessionId?, depth, duration }): Promise<string>` -- returns report ID.
2. `getHistory(query: { tenantId, projectId, agentName?, from?, to?, page, limit }): Promise<{ reports: StoredDiagnosticReport[], pagination }>`.
3. `getReportById(tenantId: string, reportId: string): Promise<StoredDiagnosticReport | null>` -- with tenantId for isolation.
4. Feature flag check: `process.env.DIAGNOSTICS_PERSISTENCE_ENABLED !== 'false'` (default enabled once deployed).
5. Use `createLogger('diagnostics-persistence')` for structured logging.
6. Compress findings array if serialized size > 50KB (use `zlib.gzip`).

### Task 1.3: Extend Existing Diagnostic Routes with Persistence

**Files to modify:**

- `apps/runtime/src/routes/diagnostics.ts`

**Implementation:**

1. Add `?persist=true` query parameter handling to both existing routes.
2. When `persist=true`, after `engine.diagnose()` succeeds, call `persistence.saveReport()`.
3. Include `reportId` in the response when persisted.
4. Persistence failure must NOT block the API response -- log error and continue.

### Task 1.4: Add History Endpoint

**Files to modify:**

- `apps/runtime/src/routes/diagnostics.ts`

**Implementation:**

1. `GET /history` route with query params: `agentName?`, `from?`, `to?`, `page?` (default 1), `limit?` (default 50, max 100).
2. Requires `diagnostics:read` permission via `requireProjectPermission`.
3. Parse and validate date range (default: 7 days ago to now).
4. Call `persistence.getHistory()`.
5. Return `{ success: true, data: { reports, pagination: { total, page, limit, pages } } }`.

### Task 1.5: Unit and Integration Tests for Phase 1

**Files to create:**

- `apps/runtime/src/services/diagnostics/__tests__/persistence.test.ts`
- `apps/runtime/src/routes/__tests__/diagnostics-history.test.ts`

**Tests (aligned with test spec INT-2, INT-3):**

1. Persistence: save and retrieve report, verify all fields.
2. Persistence: TTL index verification.
3. Persistence: pagination (limit, skip) with 20+ reports.
4. Persistence: cross-tenant isolation (tenant-A cannot see tenant-B reports).
5. History endpoint: valid query returns reports.
6. History endpoint: date range filtering.
7. History endpoint: agent name filtering.
8. History endpoint: auth required (401 without token).
9. History endpoint: project isolation (wrong project returns 404).
10. History endpoint: max page size enforcement (limit > 100 capped to 100).

### Exit Criteria Phase 1

- [ ] DiagnosticReport Mongoose model created with correct indexes and TTL
- [ ] Persistence service: saveReport, getHistory, getReportById all functional
- [ ] Existing diagnostic endpoints support `?persist=true` without breaking default behavior
- [ ] History endpoint returns paginated results with proper isolation
- [ ] All Phase 1 tests pass
- [ ] `pnpm build --filter=@agent-platform/database --filter=runtime` succeeds
- [ ] `pnpm test --filter=runtime` passes (existing + new tests)

---

## Phase 2: New Analyzers (Guardrail and Memory)

**Goal:** Add 2 new analyzers expanding diagnostic coverage to guardrails and memory subsystem.

**FR Coverage:** FR-07, FR-09

### Task 2.1: GuardrailHealthAnalyzer

**Files to create:**

- `apps/runtime/src/services/diagnostics/analyzers/guardrail-health.ts`

**Implementation:**

1. Implements `Analyzer` interface with `name = 'guardrail-health'`, `category = 'infra'`.
2. Load agent DSL from ProjectAgent record (same pattern as ToolBindingAnalyzer).
3. Extract guardrail references from DSL content (regex or IR if available).
4. For each reference, query `GuardrailConfig` collection: `findOne({ tenantId, projectId, name })`.
5. If guardrail has external provider config, attempt HTTP HEAD to provider endpoint (3s timeout).
6. SSRF protection: validate URL does not resolve to private IP ranges before probing.
7. Findings:
   - `GUARDRAIL_NOT_FOUND` (warning): No matching GuardrailConfig record
   - `GUARDRAIL_PROVIDER_UNREACHABLE` (warning): Provider endpoint timeout/error
   - `GUARDRAIL_MISCONFIGURED` (warning): Missing required config fields
   - `GUARDRAILS_OK` (info): All guardrails healthy

**Before implementation:** Read `GuardrailConfig` model source to verify actual field names and schema.

### Task 2.2: MemoryHealthAnalyzer

**Files to create:**

- `apps/runtime/src/services/diagnostics/analyzers/memory-health.ts`

**Implementation:**

1. Implements `Analyzer` interface with `name = 'memory-health'`, `category = 'infra'`.
2. Load agent DSL from ProjectAgent record.
3. Check for REMEMBER/RECALL directives in DSL content (regex: `/REMEMBER|RECALL/i`).
4. If no memory directives: return `MEMORY_NOT_CONFIGURED` (info).
5. If memory directives present:
   a. Check MongoDB connection readyState (FactStore backing).
   b. If session context available, check userId presence.
6. Findings:
   - `MEMORY_NOT_CONFIGURED` (info): Agent does not use memory
   - `MEMORY_FACTSTORE_UNAVAILABLE` (error): MongoDB disconnected
   - `MEMORY_NO_USER_ID` (warning): Session context lacks userId
   - `MEMORY_OK` (info): Memory subsystem healthy

### Task 2.3: Register New Analyzers in Engine

**Files to modify:**

- `apps/runtime/src/services/diagnostics/engine.ts`

**Implementation:**

1. Add lazy imports for GuardrailHealthAnalyzer and MemoryHealthAnalyzer in `registerAnalyzers()`.
2. Follow existing error handling pattern (try/catch with log.warn on failure).

### Task 2.4: Tests for New Analyzers

**Files to create:**

- `apps/runtime/src/services/diagnostics/__tests__/guardrail-health.test.ts`
- `apps/runtime/src/services/diagnostics/__tests__/memory-health.test.ts`

**Tests (aligned with test spec INT-5, INT-6):**

GuardrailHealthAnalyzer:

1. All guardrails present and configured -- expect info findings.
2. Referenced guardrail missing from DB -- expect `GUARDRAIL_NOT_FOUND` warning.
3. Guardrail present but provider unreachable -- expect `GUARDRAIL_PROVIDER_UNREACHABLE` warning.
4. No guardrails referenced -- expect info "no guardrails".
5. Database error -- expect `ANALYSIS_ERROR` warning.

MemoryHealthAnalyzer:

1. Agent with REMEMBER/RECALL, FactStore available -- expect `MEMORY_OK` info.
2. Agent with REMEMBER/RECALL, FactStore unavailable -- expect `MEMORY_FACTSTORE_UNAVAILABLE` error.
3. Agent without memory directives -- expect `MEMORY_NOT_CONFIGURED` info.
4. Agent with memory, no userId on session -- expect `MEMORY_NO_USER_ID` warning.
5. Database error -- expect `ANALYSIS_ERROR` warning.

### Exit Criteria Phase 2

- [ ] GuardrailHealthAnalyzer produces correct findings for all 5 test scenarios
- [ ] MemoryHealthAnalyzer produces correct findings for all 5 test scenarios
- [ ] Both analyzers registered in engine and execute during appropriate depth levels
- [ ] SSRF protection in GuardrailHealthAnalyzer blocks private IPs
- [ ] Total registered analyzers = 9 (7 existing + 2 new)
- [ ] All existing tests still pass (no regressions)
- [ ] `pnpm build --filter=runtime` succeeds

---

## Phase 3: Scheduled Diagnostics and Summary API

**Goal:** Add BullMQ-based scheduled diagnostic runs and project-level summary aggregation.

**FR Coverage:** FR-03, FR-05, FR-06, FR-20

### Task 3.1: Create DiagnosticSchedule Mongoose Model

**Files to create:**

- `packages/database/src/models/diagnostic-schedule.ts`

**Implementation:**

1. Schema: `tenantId`, `projectId`, `enabled`, `intervalMinutes`, `depth`, `agents?`, `lastRunAt?`, `nextRunAt?`, `createdBy`, `updatedAt`.
2. Unique compound index on `{ tenantId: 1, projectId: 1 }` (one schedule per project).
3. Validation: `intervalMinutes` between 5 and 1440 (5 min to 24h).
4. Export from `packages/database/src/models/index.ts`.

### Task 3.2: Create Diagnostic Scheduler Service

**Files to create:**

- `apps/runtime/src/services/diagnostics/scheduler.ts`

**Implementation:**

1. BullMQ worker for queue `diagnostics-scheduler`.
2. Job processor:
   a. Load DiagnosticSchedule from MongoDB.
   b. List agents for project (from ProjectAgent collection, filtered by tenantId + projectId).
   c. If `schedule.agents` is set, filter to only those agents.
   d. For each agent: run `engine.diagnose()`, then `persistence.saveReport({ trigger: 'scheduled' })`.
   e. Update `schedule.lastRunAt` and `schedule.nextRunAt`.
   f. Emit TraceEvent `diagnostic_run_completed`.
3. Use `jobId: diagnostics:${tenantId}:${projectId}` for deduplication.
4. BullMQ repeat option based on `intervalMinutes`.
5. Concurrency limit: 5 concurrent diagnostic runs per worker.

### Task 3.3: Add Schedule Management Endpoints

**Files to modify:**

- `apps/runtime/src/routes/diagnostics.ts`

**Implementation:**

1. `GET /schedule` -- return current schedule for project (or 404 if none).
2. `PUT /schedule` -- create or update schedule. Requires `diagnostics:write` permission.
3. Zod validation:
   - `enabled: z.boolean()`
   - `intervalMinutes: z.number().min(5).max(1440)`
   - `depth: z.enum(['quick', 'standard', 'deep'])`
   - `agents: z.array(z.string().min(1)).optional()`
4. On PUT: upsert DiagnosticSchedule record, start/stop BullMQ repeatable job accordingly.

### Task 3.4: Create Summary Service

**Files to create:**

- `apps/runtime/src/services/diagnostics/summary.ts`

**Implementation:**

1. `getProjectSummary(tenantId, projectId): Promise<ProjectDiagnosticSummary>`:
   a. Query latest report per agent in the project.
   b. Compute overall status (worst of all agents).
   c. Aggregate finding counts.
   d. Return `{ overall, agents: [{ agentName, status, errors, warnings, lastRun }], lastRun }`.
2. `getTenantSummary(tenantId): Promise<TenantDiagnosticSummary>`:
   a. Query latest report per project in the tenant.
   b. Return `{ projects: [{ projectId, status, lastRun, findings }] }`.

### Task 3.5: Add Summary Endpoints

**Files to modify:**

- `apps/runtime/src/routes/diagnostics.ts`

**New route file:**

- `apps/runtime/src/routes/diagnostics-tenant.ts` (for tenant-level summary)

**Implementation:**

1. `GET /summary` in existing diagnostics router -- calls `summary.getProjectSummary()`.
2. New tenant-level router at `/api/tenants/diagnostics/summary` with admin-only middleware chain.
3. Mount tenant diagnostics router in `server.ts`.

### Task 3.6: Tests for Phase 3

**Files to create:**

- `apps/runtime/src/services/diagnostics/__tests__/scheduler.test.ts`
- `apps/runtime/src/services/diagnostics/__tests__/summary.test.ts`
- `apps/runtime/src/routes/__tests__/diagnostics-schedule.test.ts`

**Tests (aligned with test spec INT-4, INT-8, E2E-2, E2E-3):**

Schedule CRUD:

1. Create schedule -- verify persisted.
2. Read schedule -- verify fields match.
3. Update schedule -- verify interval and depth updated.
4. Disable schedule -- verify enabled=false.
5. Validation: intervalMinutes < 5 rejected.
6. Validation: intervalMinutes > 1440 rejected.

Summary:

1. Multiple agents, mixed status -- overall = worst.
2. Per-agent breakdowns correct.
3. Finding counts aggregate correctly.
4. lastRun reflects most recent report.
5. Empty project (no reports) returns appropriate response.

### Exit Criteria Phase 3

- [ ] DiagnosticSchedule Mongoose model with unique compound index
- [ ] BullMQ scheduler creates and processes repeatable jobs
- [ ] Schedule CRUD endpoints with validation (5-1440 min range)
- [ ] Project summary aggregation returns correct overall status
- [ ] Tenant summary endpoint with admin-only access
- [ ] Tenant-level router mounted in server.ts
- [ ] All Phase 3 tests pass
- [ ] Scheduled run produces persisted report with `trigger: 'scheduled'`
- [ ] `pnpm build --filter=@agent-platform/database --filter=runtime` succeeds

---

## Phase 4: Webhook Analyzer and Conversation Quality

**Goal:** Add 2 more analyzers for tool endpoint reachability and conversation quality metrics.

**FR Coverage:** FR-08, FR-10

### Task 4.1: WebhookReachabilityAnalyzer

**Files to create:**

- `apps/runtime/src/services/diagnostics/analyzers/webhook-reachability.ts`

**Implementation:**

1. Implements `Analyzer` interface with `name = 'webhook-reachability'`, `category = 'infra'`.
2. Load ProjectTool records for the project.
3. Extract HTTP endpoint URLs from tool configurations.
4. SSRF protection:
   a. Parse URL hostname.
   b. Resolve DNS to IP address.
   c. Block private ranges: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`, `::1`.
   d. Block link-local: `169.254.0.0/16`.
5. For allowed URLs, send HTTP HEAD request with 3-second timeout.
6. Findings:
   - `WEBHOOK_UNREACHABLE` (warning): Timeout or connection error.
   - `WEBHOOK_SSRF_BLOCKED` (error): URL resolves to private IP.
   - `WEBHOOK_ERROR` (warning): Non-2xx response.
   - `WEBHOOKS_OK` (info): All reachable.
   - `NO_WEBHOOK_TOOLS` (info): No HTTP tools configured.

**Before implementation:** Read `ProjectTool` model source to verify actual field names for endpoint URL.

### Task 4.2: ConversationQualityAnalyzer

**Files to create:**

- `apps/runtime/src/services/diagnostics/analyzers/conversation-quality.ts`

**Implementation:**

1. Implements `Analyzer` interface with `name = 'conversation-quality'`, `category = 'behavioral'`.
2. Query ClickHouse for session metrics (last 24 hours):
   - Total sessions, completed sessions, escalated sessions, average turns.
3. If ClickHouse unavailable: return `CONVERSATION_QUALITY_NO_DATA` (info), not error.
4. Threshold checks:
   - Escalation rate > 30%: `HIGH_ESCALATION_RATE` (warning)
   - Completion rate < 50%: `LOW_COMPLETION_RATE` (warning)
   - Average turns > 20: `EXCESSIVE_TURNS` (warning)
5. If insufficient data (< 10 sessions): return `CONVERSATION_QUALITY_NO_DATA` (info).

**Before implementation:** Read ClickHouse schema and client API to verify table names and query patterns.

### Task 4.3: Register New Analyzers

**Files to modify:**

- `apps/runtime/src/services/diagnostics/engine.ts`

**Implementation:**

1. Add lazy imports for WebhookReachabilityAnalyzer and ConversationQualityAnalyzer.
2. Follow existing registration pattern.

### Task 4.4: Tests for Phase 4

**Files to create:**

- `apps/runtime/src/services/diagnostics/__tests__/webhook-reachability.test.ts`
- `apps/runtime/src/services/diagnostics/__tests__/conversation-quality.test.ts`

**Tests (aligned with test spec INT-7):**

WebhookReachabilityAnalyzer:

1. Reachable endpoint -- expect info finding.
2. Unreachable endpoint -- expect `WEBHOOK_UNREACHABLE` warning.
3. Private IP blocked -- expect `WEBHOOK_SSRF_BLOCKED` error.
4. Timeout behavior -- expect warning finding.
5. No webhook tools configured -- expect `NO_WEBHOOK_TOOLS` info.

ConversationQualityAnalyzer:

1. Normal metrics -- expect `CONVERSATION_QUALITY_OK` info.
2. High escalation rate -- expect `HIGH_ESCALATION_RATE` warning.
3. Low completion rate -- expect `LOW_COMPLETION_RATE` warning.
4. Excessive turns -- expect `EXCESSIVE_TURNS` warning.
5. ClickHouse unavailable -- expect `CONVERSATION_QUALITY_NO_DATA` info (graceful degradation).

### Exit Criteria Phase 4

- [ ] WebhookReachabilityAnalyzer with full SSRF protection
- [ ] ConversationQualityAnalyzer with graceful ClickHouse degradation
- [ ] Both analyzers registered and execute at appropriate depth levels
- [ ] Total registered analyzers = 11 (7 existing + 4 new)
- [ ] SSRF blocks private IPs, link-local, and loopback
- [ ] All Phase 4 tests pass
- [ ] `pnpm build --filter=runtime` succeeds

---

## Phase 5: Remediation Framework

**Goal:** Add the remediation action framework with the initial `revalidate_credential` action.

**FR Coverage:** FR-11, FR-12

### Task 5.1: Remediation Service

**Files to create:**

- `apps/runtime/src/services/diagnostics/remediation.ts`

**Implementation:**

1. `RemediationHandler` interface:
   ```typescript
   interface RemediationHandler {
     type: string;
     canHandle(finding: DiagnosticFinding): boolean;
     preview(finding: DiagnosticFinding, context: DiagnosticContext): RemediationPreview;
     execute(finding: DiagnosticFinding, context: DiagnosticContext): Promise<RemediationResult>;
   }
   ```
2. `RemediationService` class:
   - Registry of handlers (Map<string, RemediationHandler>)
   - `register(handler: RemediationHandler)`: add handler to registry
   - `getAvailableActions(finding: DiagnosticFinding): RemediationHandler[]`: find handlers that canHandle
   - `preview(actionType, finding, context): RemediationPreview`: describe what will happen
   - `execute(actionType, finding, context): Promise<RemediationResult>`: run the action
3. Audit logging: every execution emits TraceEvent `diagnostic_remediation_executed`.

### Task 5.2: RevalidateCredentialHandler

**Files to create:**

- `apps/runtime/src/services/diagnostics/handlers/revalidate-credential.ts`

**Implementation:**

1. Handles finding code `CREDENTIAL_STALE`.
2. Preview: "Will re-validate the LLM credential for provider X by making a test API call."
3. Execute:
   a. Load LLMCredential from database.
   b. Decrypt credential using encryption service.
   c. Make a minimal API call (e.g., list models) to validate.
   d. Update `lastValidatedAt` timestamp on success.
   e. Return `{ success: true/false, message }`.

**Before implementation:** Read LLMCredential model and encryption service to verify actual API.

### Task 5.3: Add Remediation Endpoint

**Files to modify:**

- `apps/runtime/src/routes/diagnostics.ts`

**Implementation:**

1. `POST /remediate` route.
2. Requires `diagnostics:write` permission.
3. Zod validation:
   - `reportId: z.string().min(1)`
   - `findingCode: z.string().min(1)`
   - `actionType: z.string().min(1)`
   - `confirmed: z.boolean()`
4. Load report, verify ownership (tenantId + projectId).
5. Find the finding in the report by code.
6. If `!confirmed`: return preview from handler.
7. If `confirmed`: execute handler, return result.

### Task 5.4: Tests for Phase 5

**Files to create:**

- `apps/runtime/src/services/diagnostics/__tests__/remediation.test.ts`

**Tests (aligned with test spec E2E-6):**

1. Preview mode: returns action description without executing.
2. Confirmed execution: runs handler and returns result.
3. Unknown action type: returns error response.
4. Finding not found in report: returns error response.
5. Report ownership verification: wrong tenant returns 404.

### Exit Criteria Phase 5

- [ ] Remediation service with handler registry
- [ ] RevalidateCredentialHandler functional
- [ ] POST /remediate endpoint with preview/confirm flow
- [ ] Audit logging for every remediation execution
- [ ] Remediation does NOT modify agent DSL or config (read-only)
- [ ] All Phase 5 tests pass
- [ ] `pnpm build --filter=runtime` succeeds

---

## Wiring Checklist

Before declaring the feature complete, verify all wiring connections:

- [ ] DiagnosticReport model exported from `packages/database/src/models/index.ts`
- [ ] DiagnosticSchedule model exported from `packages/database/src/models/index.ts`
- [ ] Persistence service imported and used in `routes/diagnostics.ts`
- [ ] History endpoint registered in diagnostics router
- [ ] Summary endpoint registered in diagnostics router
- [ ] Schedule endpoints registered in diagnostics router
- [ ] Remediate endpoint registered in diagnostics router
- [ ] Tenant summary router mounted in `server.ts`
- [ ] Scheduler service initialized on runtime startup (conditionally, if scheduling enabled)
- [ ] All 4 new analyzers registered in `registerAnalyzers()` function
- [ ] Feature flag `DIAGNOSTICS_PERSISTENCE_ENABLED` checked at persistence layer
- [ ] Prettier run on all changed files before each commit

---

## Implementation Order and Dependencies

```
Phase 1 (Persistence + History)
  |
  +-- Phase 2 (Guardrail + Memory Analyzers) [independent of Phase 1 API]
  |
  +-- Phase 3 (Scheduling + Summary) [depends on Phase 1 persistence]
  |     |
  |     +-- Phase 4 (Webhook + Quality Analyzers) [independent]
  |
  +-- Phase 5 (Remediation) [depends on Phase 1 persistence]
```

Phases 2 and 4 (analyzer additions) can be developed in parallel with Phases 3 and 5 respectively, as they only add new analyzers to the existing engine without depending on persistence/scheduling infrastructure.

---

## Risk Mitigation During Implementation

| Risk                                         | Mitigation                                                                   | Phase |
| -------------------------------------------- | ---------------------------------------------------------------------------- | ----- |
| Breaking existing tests                      | Run `pnpm test --filter=runtime` after every phase                           | All   |
| MongoDB model conflicts with existing models | Use distinct collection names (`diagnostic_reports`, `diagnostic_schedules`) | 1, 3  |
| BullMQ queue naming conflicts                | Use unique queue name `diagnostics-scheduler`                                | 3     |
| Circular imports from lazy analyzer loading  | Follow existing dynamic import pattern in `registerAnalyzers`                | 2, 4  |
| SSRF in webhook analyzer                     | Block private IPs via DNS resolution before HTTP request                     | 4     |

---

## Estimated Effort

| Phase                                 | Tasks        | Estimated Effort | Risk Level                                     |
| ------------------------------------- | ------------ | ---------------- | ---------------------------------------------- |
| Phase 1: Persistence + History        | 5 tasks      | 2-3 days         | Medium (new MongoDB model, new API endpoints)  |
| Phase 2: Guardrail + Memory Analyzers | 4 tasks      | 1-2 days         | Low (follows existing pattern)                 |
| Phase 3: Scheduling + Summary         | 6 tasks      | 2-3 days         | Medium (BullMQ integration, aggregation logic) |
| Phase 4: Webhook + Quality Analyzers  | 4 tasks      | 1-2 days         | Medium (SSRF protection, ClickHouse queries)   |
| Phase 5: Remediation Framework        | 4 tasks      | 1-2 days         | Medium (credential handling, audit logging)    |
| **Total**                             | **23 tasks** | **7-12 days**    |                                                |
