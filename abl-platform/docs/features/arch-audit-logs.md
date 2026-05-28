# Feature: Arch AI Audit Logs

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: ALPHA
**Feature Area(s)**: `observability`, `admin operations`
**Package(s)**: `packages/arch-ai`, `packages/database`, `apps/studio`
**Owner(s)**: Platform team
**Testing Guide**: [../testing/arch-audit-logs.md](../testing/arch-audit-logs.md)
**Last Updated**: 2026-04-12

---

## 1. Introduction / Overview

### Problem Statement

Arch AI has two data stores today: **ArchSession** (mutable session state) and **ArchJournal** (semantic decision log). Neither captures operational telemetry. Workspace administrators cannot answer basic operational questions:

- "Why did this BUILD take 45 seconds?"
- "Which LLM call failed and was it retried?"
- "How many tokens did this session consume?"
- "What error happened before the user saw a blank screen?"
- "Which users are burning the most tokens?"
- "Is the BUILD phase cost-justified vs INTERVIEW?"

The Arch admin settings page (`/admin/arch`) configures credential source, model, and provider, but provides zero visibility into what is actually happening at runtime. When users report issues, admins have no diagnostic data beyond unstructured server logs.

### Goal Statement

Provide a workspace-level audit log system for Arch AI that captures every LLM call, tool execution, phase transition, user action, build event, error, and system event with structured metadata. Surface this data through a dedicated admin page with filtering, summary KPIs, session timeline drill-down, cost breakdown, and CSV/JSON export.

### Summary

The feature adds:

1. A new MongoDB collection (`arch_audit_logs`) storing 7 categories of operational events with 90-day TTL retention.
2. A non-blocking buffered emitter (`AuditLogEmitter`) injected into the Arch AI message route that captures events without impacting SSE streaming latency.
3. Token usage capture via Vercel AI SDK `onStepFinish` callbacks on all three `streamText()` call sites.
4. Four Studio API endpoints for listing, summarizing, timeline viewing, and cost breakdown.
5. A new "Audit Logs" tab on the existing Arch admin settings page with filtering, expandable log rows, KPI summary cards, and export.

---

## 2. Scope

### Goals

- Capture operational telemetry for all Arch AI sessions (ONBOARDING and IN_PROJECT modes)
- Provide workspace admins with a filterable, paginated audit log viewer
- Track LLM token usage and estimated cost per session, phase, user, and model
- Enable error diagnosis through structured error events with severity and recovery info
- Support CSV/JSON export of filtered audit data
- 90-day TTL retention with automatic MongoDB cleanup
- Zero impact on SSE streaming latency (fire-and-forget writes)

### Non-Goals (Out of Scope)

- Real-time WebSocket streaming of audit events (manual refresh only)
- Token budget alerts or threshold notifications
- Full-text search on log summaries (v1 uses structured filters only)
- User-level audit log visibility in the chat UI (admin-only)
- Integration with the platform-wide ClickHouse audit store (`packages/eventstore`)
- Storing full LLM prompts/responses (PII risk, storage bloat — token counts only)
- Trend/sparkline charts over time (v1 shows current-period totals only)

---

## 3. User Stories

1. As a **workspace admin**, I want to see how many LLM tokens Arch AI consumed this week so that I can monitor AI spend and justify the cost.
2. As a **workspace admin**, I want to filter audit logs by error severity so that I can quickly find and diagnose failures reported by users.
3. As a **workspace admin**, I want to click a session ID and see all events for that session in chronological order so that I can trace the full lifecycle of a problematic session.
4. As a **workspace admin**, I want to see a cost breakdown by user and phase so that I can identify which usage patterns are most expensive.
5. As a **workspace admin**, I want to export filtered audit logs as CSV so that I can share diagnostic data with the engineering team or include it in reports.
6. As a **workspace admin**, I want to see build events (compile pass/fail, enrichment, cross-validation) so that I can understand BUILD phase quality and success rates.
7. As a **workspace admin**, I want audit logs to be automatically cleaned up after 90 days so that storage doesn't grow unbounded.

---

## 4. Functional Requirements

1. **FR-1**: The system must capture audit log events in 7 categories: `llm_call`, `tool_execution`, `phase_transition`, `user_action`, `build_event`, `error`, `system_event`.
2. **FR-2**: Every audit log entry must include: `_id`, `tenantId`, `userId`, `sessionId`, `category`, `severity`, `summary`, `detail`, `timestamp`. Optional fields: `projectId`, `specialist`, `phase`, `durationMs`, `tokens`.
3. **FR-3**: LLM call events must capture: model identifier, input/output/total token counts, estimated cost (via `estimateCost()` from `@agent-platform/shared-kernel`), finish reason, and specialist/phase context.
4. **FR-4**: Token usage must be captured from all three `streamText()` call sites in `message/route.ts` via Vercel AI SDK `onStepFinish` callbacks, accumulating per-step usage as a safety net for aborted streams.
5. **FR-5**: Audit log writes must be non-blocking: the `AuditLogEmitter` must buffer events in memory (max 100) and flush via `insertMany()` on a 2-second interval, when the buffer reaches 50 entries, or when the SSE `done` event fires. Write failures must be logged but never propagated.
6. **FR-6**: The `GET /api/arch-ai/audit-logs` endpoint must support pagination (`page`, `limit`) and filtering by: `category`, `severity`, `phase`, `userId`, `sessionId`, `specialist`, and date range (`from`, `to`).
7. **FR-7**: The `GET /api/arch-ai/audit-logs/summary` endpoint must return aggregate statistics for a given date range: total events, total tokens (input/output/total), estimated total cost, error count by severity, and event count by category.
8. **FR-8**: The `GET /api/arch-ai/audit-logs/sessions/:id/timeline` endpoint must return all audit log entries for a given session, ordered by timestamp ascending.
9. **FR-9**: The `GET /api/arch-ai/audit-logs/cost-breakdown` endpoint must return cost aggregated by `userId`, `phase`, and `detail.model` for a given date range.
10. **FR-10**: All API endpoints must require `requireTenantAuth` + `requireAdminRole` (OWNER or ADMIN). Non-admin users must receive 403. Every query must include an explicit `{ tenantId: auth.tenantId }` filter from the auth context (the `tenantIsolationPlugin` is defense-in-depth only — Studio does not register an ALS tenant-context provider).
11. **FR-11**: The MongoDB collection must use a TTL index on `timestamp` with a default expiry of 90 days (7,776,000 seconds).
12. **FR-12**: The audit logs UI must provide a manual refresh button that re-fetches data from the API. No automatic polling or WebSocket streaming.
13. **FR-13**: The audit logs UI must support CSV and JSON export of the currently filtered result set. When `format=csv` or `format=json-export` is specified, the endpoint must ignore pagination (`page`/`limit`) and return all matching entries up to a hard cap of 10,000 rows. CSV uses chunked transfer encoding with `Content-Disposition: attachment`. When `format` is omitted, the endpoint returns the standard paginated response.
14. **FR-14**: Clicking a session ID in the audit log list must expand an inline timeline view showing all events for that session.
15. **FR-15**: Error events must capture: error code, message, severity (`warning` | `error` | `critical`), source (`llm` | `compiler` | `tool` | `session` | `system`), and recovery action taken (`retried` | `degraded` | `aborted` | `user_notified`).
16. **FR-16**: Build events must capture: agent name, duration, compile status, quality floor results, constructs used, and warnings.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                          |
| -------------------------- | ------------ | -------------------------------------------------------------- |
| Project lifecycle          | NONE         | Does not affect project operations                             |
| Agent lifecycle            | NONE         | Does not affect agent operations                               |
| Customer experience        | NONE         | End users don't interact with audit logs                       |
| Integrations / channels    | NONE         | No channel integration                                         |
| Observability / tracing    | PRIMARY      | Core purpose: operational observability for Arch AI            |
| Governance / controls      | SECONDARY    | Cost visibility enables governance decisions on AI spend       |
| Enterprise / compliance    | SECONDARY    | Audit trail for AI operations (not compliance-grade like FR-7) |
| Admin / operator workflows | PRIMARY      | New admin page for workspace-level AI operations monitoring    |

### Related Feature Integration Matrix

| Related Feature                           | Relationship Type   | Why It Matters                                                                                                                           | Key Touchpoints                                                                    | Current State                          |
| ----------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------- |
| [Arch AI Assistant](arch-ai-assistant.md) | extends             | Audit logs instrument the Arch AI message route                                                                                          | `message/route.ts`, `streamText()` calls, tool execution blocks, phase transitions | BETA — all emission points exist       |
| [Audit Logging](audit-logging.md)         | shares data with    | Platform audit is compliance-grade (ClickHouse). Arch audit is operational telemetry (MongoDB). Separate stores, complementary purposes. | Both use fire-and-forget semantics, both tenant-isolated                           | BETA — no overlap, no dependency       |
| [Model Hub](model-hub.md)                 | configured by       | Model selection in Arch settings determines which model IDs appear in LLM call audit events                                              | `resolveArchVercelModel()` in `arch-llm.ts`                                        | BETA — model ID available at call site |
| [EventStore](eventstore.md)               | emits into (future) | Future bridge could map Arch audit events to PlatformEvents for cross-platform analytics                                                 | `trace-bridge.ts` pattern shows the mapping approach                               | BETA — bridge not in v1 scope          |

---

## 6. Design Considerations

### UI Location

New "Audit Logs" tab on the existing Arch admin settings page at `/admin/arch`. The tab sits alongside the current credential/model/provider configuration.

### Layout Structure

1. **Search bar** with date range picker and export buttons (CSV, JSON)
2. **Summary cards** row: Total LLM Calls, Tokens Used, Estimated Cost, Error Count
3. **Filter bar**: pill-based toggleable chips for Category (7 types), Phase, Severity, User, Session, Specialist
4. **Log stream table**: paginated, compact 1-line rows with timestamp, category icon/color, summary, key metric. Click to expand detail card.
5. **Inline session timeline**: when a session ID is clicked, expand a section below showing all events for that session chronologically.
6. **Manual refresh button** in the top bar.

### Category Visual Design

| Category         | Lucide Icon     | Semantic Color Token |
| ---------------- | --------------- | -------------------- |
| LLM Call         | `Brain`         | Purple accent        |
| Tool Execution   | `Wrench`        | Blue accent          |
| Phase Transition | `ArrowRight`    | Teal accent          |
| User Action      | `User`          | Green accent         |
| Build Event      | `Hammer`        | Orange accent        |
| Error            | `AlertTriangle` | Error color          |
| System Event     | `Settings`      | Muted foreground     |

---

## 7. Technical Considerations

### Write Path Architecture

The LLM streaming loop in `message/route.ts` is the hot path. The `AuditLogEmitter` is created per-request and passed as a parameter alongside the existing `emit` (SSE emitter) function. It buffers events in memory and flushes to MongoDB asynchronously.

```
Request entry → create AuditLogEmitter(ctx, model)
  │
  streamText({ onStepFinish }) → auditEmitter.emit('llm_call', ...)
  │
  tool execution → auditEmitter.emit('tool_execution', ...)
  │
  SSE done event → auditEmitter.flush()
```

**Key design decisions:**

- Parameter passing (not AsyncLocalStorage) — matches existing `emit` pattern in the route
- `onStepFinish` (not `onFinish`) for token capture — `onFinish` doesn't fire on stream abort
- `insertMany({ ordered: false })` — partial writes succeed even if some entries fail validation
- Fire-and-forget — write errors logged via `createLogger`, never propagated to caller

### Existing Code Integration

The `message/route.ts` file is ~5,400 lines with 3 `streamText()` call sites:

- `VercelLLMStreamClient` (~L396) — IN_PROJECT mode
- `startStream()` (~L4988) — ONBOARDING interview/blueprint/build-modification
- Build agent generation (~L3642) — parallel per-agent BUILD

Each gets an `onStepFinish` callback. The emitter is also called at: request entry (user_action), phase transitions, gate actions, error catch blocks, and session lifecycle endpoints.

### Storage Decision

MongoDB over ClickHouse because:

- Studio connects to MongoDB, not ClickHouse (no new infra dependency)
- Volume is low: ~5K-50K events/day (MongoDB handles trivially)
- Immediate consistency (no 5s buffer flush lag)
- Same deployment model as ArchJournal

---

## 8. How to Consume

### Studio UI

- **Route**: `/admin/arch` → "Audit Logs" tab
- **Access**: Workspace admin role required
- **Interaction**: Filter → browse → expand → export. Manual refresh button.

### API (Runtime)

N/A — Arch AI runs entirely in Studio.

### API (Studio)

| Method | Path                                            | Purpose                                 |
| ------ | ----------------------------------------------- | --------------------------------------- |
| GET    | `/api/arch-ai/audit-logs`                       | List logs with pagination and filters   |
| GET    | `/api/arch-ai/audit-logs/summary`               | Aggregate KPI stats for date range      |
| GET    | `/api/arch-ai/audit-logs/sessions/:id/timeline` | All events for a session, chronological |
| GET    | `/api/arch-ai/audit-logs/cost-breakdown`        | Cost grouped by user, phase, model      |

**Query parameters** (all endpoints):

- `from`, `to` — ISO 8601 date range (default: last 7 days)
- `tenantId` — injected by `requireTenantAuth` (not user-supplied)

**Additional parameters** (`/audit-logs` list):

- `page`, `limit` (default: 1, 50; max limit: 200)
- `category` — comma-separated filter
- `severity` — comma-separated filter
- `phase`, `userId`, `sessionId`, `specialist` — exact match filters

### Admin Portal

The audit logs tab is part of the workspace-level Arch settings page. No separate admin portal page needed.

### Channel / SDK / Voice / A2A / MCP Integration

N/A — This feature is not channel-aware. Arch AI audit logs are internal operational telemetry.

---

## 9. Data Model

### Collections / Tables

```text
Collection: arch_audit_logs
Fields:
  - _id: string (uuidv7)
  - tenantId: string (required, indexed)
  - userId: string (required)
  - sessionId: string (required, indexed)
  - projectId: string (optional, indexed — set for IN_PROJECT mode)
  - category: string (required, enum: llm_call | tool_execution | phase_transition |
                       user_action | build_event | error | system_event)
  - severity: string (required, enum: info | warning | error | critical)
  - summary: string (required — one-line human-readable description)
  - detail: Mixed (required — category-specific structured payload)
  - specialist: string (optional — which specialist was active)
  - phase: string (optional — INTERVIEW | BLUEPRINT | BUILD | CREATE)
  - durationMs: number (optional — for timed events)
  - tokens: subdocument (optional — denormalized for fast aggregation)
    - input: number
    - output: number
    - total: number
    - estimatedCost: number
  - timestamp: Date (required)
  - createdAt: Date (auto)
  - updatedAt: Date (auto)

Indexes:
  - { tenantId: 1, timestamp: -1 }                    — primary listing
  - { tenantId: 1, sessionId: 1, timestamp: 1 }       — session timeline
  - { tenantId: 1, category: 1, timestamp: -1 }       — category filter
  - { tenantId: 1, severity: 1, timestamp: -1 }       — error spotlight
  - { tenantId: 1, projectId: 1, timestamp: -1 }      — project scope
  - { timestamp: 1 } TTL expireAfterSeconds: 7776000   — 90-day retention

Plugins:
  - tenantIsolationPlugin
```

### Key Relationships

- **ArchSession** (1:N) — `sessionId` links audit events to the session they belong to. No foreign key constraint; sessions may be archived/deleted before their audit logs expire.
- **ArchJournal** (parallel, no FK) — Both are append-only event stores for the same sessions, but at different granularity levels (semantic vs operational). No direct data sharing.
- **Workspace/Tenant** — All queries scoped by `tenantId`. Cross-tenant access returns empty results (via `tenantIsolationPlugin`).

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                              | Purpose                                                           |
| ------------------------------------------------- | ----------------------------------------------------------------- |
| `packages/arch-ai/src/audit/types.ts`             | AuditLogEntry type, category/severity enums, detail payload types |
| `packages/arch-ai/src/audit/audit-log-emitter.ts` | Buffered non-blocking emitter class                               |
| `packages/arch-ai/src/audit/index.ts`             | Re-exports                                                        |

### Routes / Handlers

| File                                                                         | Purpose                                         |
| ---------------------------------------------------------------------------- | ----------------------------------------------- |
| `apps/studio/src/app/api/arch-ai/audit-logs/route.ts`                        | GET list with filters + pagination              |
| `apps/studio/src/app/api/arch-ai/audit-logs/summary/route.ts`                | GET aggregate KPI stats                         |
| `apps/studio/src/app/api/arch-ai/audit-logs/sessions/[id]/timeline/route.ts` | GET session timeline                            |
| `apps/studio/src/app/api/arch-ai/audit-logs/cost-breakdown/route.ts`         | GET cost breakdown                              |
| `apps/studio/src/app/api/arch-ai/message/route.ts`                           | Modified — emit audit events from hot path      |
| `apps/studio/src/app/api/arch-ai/sessions/route.ts`                          | Modified — emit system events on create/archive |

### UI Components

| File                                                        | Purpose                             |
| ----------------------------------------------------------- | ----------------------------------- |
| `apps/studio/src/components/admin/ArchAuditLogsTab.tsx`     | Main audit logs tab component       |
| `apps/studio/src/components/admin/AuditLogRow.tsx`          | Expandable log row with detail card |
| `apps/studio/src/components/admin/AuditLogSummaryCards.tsx` | KPI summary cards row               |
| `apps/studio/src/components/admin/AuditLogFilters.tsx`      | Filter bar with pill chips          |
| `apps/studio/src/components/admin/AuditLogTimeline.tsx`     | Inline session timeline expansion   |
| `apps/studio/src/store/arch-audit-store.ts`                 | Zustand store for audit log state   |

### Jobs / Workers / Background Processes

| File | Purpose                                                                                    |
| ---- | ------------------------------------------------------------------------------------------ |
| N/A  | No background jobs. TTL index handles retention automatically. Emitter flushes in-process. |

### Tests

| File                                                           | Type        | Coverage Focus                                         | Status          |
| -------------------------------------------------------------- | ----------- | ------------------------------------------------------ | --------------- |
| `packages/arch-ai/src/__tests__/audit-log-emitter.test.ts`     | unit        | Buffer flush, fire-and-forget, threshold, kill switch  | 9/9 PASS        |
| `packages/arch-ai/src/__tests__/audit-log-types.test.ts`       | unit        | Category/severity enums, detail payload types          | 11/11 PASS      |
| `packages/database/src/__tests__/arch-audit-log.model.test.ts` | unit        | Schema validation, indexes, TTL, plugin                | 9/9 PASS        |
| Integration tests                                              | integration | API endpoints, filtering, pagination, tenant isolation | NOT YET WRITTEN |
| E2E tests                                                      | e2e         | Full flow: emit → store → query → export               | NOT YET WRITTEN |

---

## 11. Configuration

### Environment Variables

| Variable                           | Default | Description                                    |
| ---------------------------------- | ------- | ---------------------------------------------- |
| `ARCH_AUDIT_LOG_TTL_DAYS`          | `90`    | Retention period in days for audit log entries |
| `ARCH_AUDIT_LOG_BUFFER_SIZE`       | `50`    | Flush threshold for the in-memory buffer       |
| `ARCH_AUDIT_LOG_FLUSH_INTERVAL_MS` | `2000`  | Timer-based flush interval in milliseconds     |
| `ARCH_AUDIT_LOG_ENABLED`           | `true`  | Kill switch to disable audit log emission      |

### Runtime Configuration

No per-project or per-tenant configuration in v1. All settings are environment-variable-driven. The kill switch (`ARCH_AUDIT_LOG_ENABLED=false`) disables all emission without code changes.

### DSL / Agent IR / Schema

N/A — This feature does not affect the ABL DSL, Agent IR, or compiler schema.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant isolation  | Every query includes `tenantId` via `tenantIsolationPlugin`. Cross-tenant queries return empty results. All API endpoints use `requireTenantAuth`.                                        |
| Project isolation | `projectId` is optional (only set for IN_PROJECT mode). When present, queries can filter by it. Cross-project data is visible within the same tenant (workspace admin sees all projects). |
| User isolation    | Not applicable for the admin view — workspace admins see all users' audit logs. The `userId` field is stored for filtering/breakdown but does not restrict access.                        |

### Security & Compliance

- **Auth**: All endpoints gated by `requireTenantAuth` from `@/lib/auth`
- **PII**: No LLM prompts/responses stored. Only token counts, model IDs, tool names, and structured metadata. `userId` is an internal ID, not PII.
- **Secrets**: `detail` payloads must never contain API keys, tokens, or credentials. Tool execution events store `inputSummary` (truncated, sanitized) not raw input.
- **Export**: CSV/JSON export is scoped to the current tenant's filtered view. No cross-tenant data leakage.

### Performance & Scalability

- **Write impact**: Zero SSE latency impact. Emitter buffers in memory, flushes async. `insertMany({ ordered: false })` tolerates partial failures.
- **Read performance**: All query patterns have covering indexes. List endpoint limited to 200 results per page. Summary uses `$facet` aggregation.
- **Volume**: ~5K-50K events/day per tenant. MongoDB handles this without sharding or special configuration.
- **Memory**: In-memory buffer capped at 100 events (~50KB). Flush on timer, threshold, or stream end.

### Reliability & Failure Modes

- **Emitter failure**: Write errors caught and logged via `createLogger`. Never propagated to SSE stream. Events may be lost on write failure — audit logs are best-effort, not guaranteed delivery.
- **MongoDB down**: Emitter flush fails silently. Buffered events are lost when the request ends. No retry, no WAL. Acceptable for operational telemetry.
- **Partial writes**: `insertMany({ ordered: false })` ensures valid entries are written even if some fail schema validation.
- **Stream abort**: `onStepFinish` captures per-step usage. If the stream is aborted mid-step, that step's usage is lost but all completed steps are captured.

### Observability

- **Structured logging**: `createLogger('arch-ai:audit')` for emitter operations (flush success/failure, buffer stats).
- **No self-referential audit**: The audit log emitter does not emit audit events about its own operations (avoids infinite recursion).
- **Metrics (future)**: Could expose buffer size, flush latency, and write error rate as Prometheus metrics.

### Data Lifecycle

- **Retention**: 90-day TTL via MongoDB TTL index on `timestamp`. Configurable via `ARCH_AUDIT_LOG_TTL_DAYS`.
- **No cascade from sessions**: Audit logs are independent of ArchSession lifecycle. Sessions can be archived/deleted while their audit logs persist until TTL expiry.
- **Tenant deletion**: A cascade hook must run `ArchAuditLog.deleteMany({ tenantId })` when a tenant is deleted. The `tenantIsolationPlugin` only scopes reads/writes — it does NOT perform deletion cascades.
- **User erasure**: On user deletion, `ArchAuditLog.updateMany({ userId }, { $set: { userId: 'REDACTED' } })` anonymizes the actor. Although `userId` is an internal ID (not PII like email), GDPR erasure applies to identifiable user records.
- **No migration**: New collection, no existing data to migrate.

---

## 13. Delivery Plan / Work Breakdown

1. **Data model and emitter core**
   1.1 Create `ArchAuditLog` Mongoose model in `packages/database` with schema, indexes, TTL, and `tenantIsolationPlugin`
   1.2 Create `AuditLogEmitter` class in `packages/arch-ai/src/audit/` with buffer, flush logic, and fire-and-forget semantics
   1.3 Create audit types (`AuditLogEntry`, category/severity enums, detail payload types) in `packages/arch-ai/src/audit/types.ts`
   1.4 Unit tests for emitter (buffer flush, batch sizing, error handling) and model (schema validation, indexes)

2. **Token capture instrumentation**
   2.1 Add `onStepFinish` callback to `VercelLLMStreamClient` (~L396) for IN_PROJECT mode
   2.2 Add `onStepFinish` callback to `startStream()` (~L4988) for ONBOARDING mode
   2.3 Add `onStepFinish` callback to build agent generation (~L3642) for BUILD mode
   2.4 Integrate `estimateCost()` from `@agent-platform/shared-kernel` for cost calculation

3. **Emission point instrumentation**
   3.1 Create emitter at request entry in `message/route.ts`, pass through call chain
   3.2 Emit `user_action` on message receipt
   3.3 Emit `tool_execution` around tool execution blocks (with timing)
   3.4 Emit `phase_transition` in `phase-transition.ts`
   3.5 Emit `build_event` in agent generation block (start/compiled/error/enriched)
   3.6 Emit `error` in catch blocks
   3.7 Emit `system_event` in session create/archive routes
   3.8 Flush emitter on SSE `done` event

4. **API endpoints**
   4.1 `GET /api/arch-ai/audit-logs` — list with pagination and filters
   4.2 `GET /api/arch-ai/audit-logs/summary` — aggregate KPI stats via `$facet`
   4.3 `GET /api/arch-ai/audit-logs/sessions/:id/timeline` — session timeline
   4.4 `GET /api/arch-ai/audit-logs/cost-breakdown` — cost by user/phase/model
   4.5 Integration tests for all endpoints (filtering, pagination, tenant isolation)

5. **UI implementation**
   5.1 Create `useArchAuditStore` Zustand store (filters, pagination, entries, loading state)
   5.2 Create `ArchAuditLogsTab` main component with tab integration into `ArchSettingsPage`
   5.3 Create `AuditLogSummaryCards` — KPI cards for totals
   5.4 Create `AuditLogFilters` — pill-based filter bar
   5.5 Create `AuditLogRow` — expandable log row with detail card
   5.6 Create `AuditLogTimeline` — inline session timeline expansion
   5.7 Add CSV/JSON export functionality
   5.8 Add manual refresh button

---

## 14. Success Metrics

| Metric                             | Baseline                              | Target                               | How Measured                                          |
| ---------------------------------- | ------------------------------------- | ------------------------------------ | ----------------------------------------------------- |
| Diagnostic time for Arch AI issues | 15-30 min (unstructured log trawling) | < 2 min (filter → expand → diagnose) | Qualitative admin feedback                            |
| Token cost visibility              | None (invisible)                      | 100% of LLM calls tracked            | `count(category='llm_call')` vs known session count   |
| SSE latency regression             | Current baseline                      | < 1ms increase at p95                | Measure SSE first-byte-time with/without emitter      |
| Audit log write success rate       | N/A                                   | > 99%                                | `flush success / flush attempts` from structured logs |
| Admin page load time               | N/A                                   | < 1s for list, < 2s for summary      | Frontend performance measurement                      |

---

## 15. Open Questions

1. Should the `ARCH_AUDIT_LOG_TTL_DAYS` be configurable per-tenant in the future, or is a global env var sufficient long-term?
2. Should the cost breakdown page show a "savings opportunity" suggestion (e.g., "switch BUILD to a cheaper model")? Deferred to future iteration.
3. Should there be a notification mechanism when error rate exceeds a threshold? Deferred — user explicitly excluded token budget alerts; error alerts could be a separate future feature.

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                | Severity | Status                                                             |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------ |
| GAP-001 | `onFinish` callback does not fire on stream abort — using `onStepFinish` as workaround means the final incomplete step's tokens are lost   | Low      | Mitigated (per-step capture covers 95%+ of usage)                  |
| GAP-002 | No trend charts in v1 — summary cards show period totals only                                                                              | Low      | Open (future enhancement)                                          |
| GAP-003 | No full-text search on log summaries in v1                                                                                                 | Low      | Open (future enhancement)                                          |
| GAP-004 | Cost estimation accuracy depends on `estimateCost()` pricing table being up-to-date with model pricing                                     | Medium   | Open (pricing table maintained in `@agent-platform/shared-kernel`) |
| GAP-005 | Audit logs persist independently of session lifecycle — orphaned logs (session deleted, logs remain until TTL) are expected and acceptable | Low      | Mitigated (by design — TTL handles cleanup)                        |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                         | Coverage Type | Status     | Test File / Note                                                                     |
| --- | ------------------------------------------------ | ------------- | ---------- | ------------------------------------------------------------------------------------ |
| 1   | AuditLogEmitter buffers and flushes at threshold | unit          | PASS       | `packages/arch-ai/src/__tests__/audit-log-emitter.test.ts`                           |
| 2   | AuditLogEmitter flush on done event              | unit          | PASS       | Same file                                                                            |
| 3   | AuditLogEmitter swallows write errors            | unit          | PASS       | Same file                                                                            |
| 4   | ArchAuditLog schema validates required fields    | unit          | PASS       | `packages/database/src/__tests__/arch-audit-log.model.test.ts`                       |
| 5   | List endpoint filters + pagination               | integration   | NOT TESTED | Planned: `apps/studio/src/__tests__/arch-ai/audit-logs-list.integration.test.ts`     |
| 6   | Tenant isolation (bidirectional)                 | e2e           | NOT TESTED | Planned: `apps/studio/src/__tests__/arch-ai/audit-logs-e2e.test.ts`                  |
| 7   | Summary aggregation accuracy                     | integration   | NOT TESTED | Planned: `apps/studio/src/__tests__/arch-ai/audit-logs-summary.integration.test.ts`  |
| 8   | Session timeline chronological order             | integration   | NOT TESTED | Planned: `apps/studio/src/__tests__/arch-ai/audit-logs-timeline.integration.test.ts` |
| 9   | Cost breakdown grouping                          | integration   | NOT TESTED | Planned: `apps/studio/src/__tests__/arch-ai/audit-logs-cost.integration.test.ts`     |
| 10  | Full emit → store → query → export flow          | e2e           | NOT TESTED | Planned: `apps/studio/src/__tests__/arch-ai/audit-logs-e2e.test.ts`                  |
| 11  | CSV/JSON export with filters                     | e2e           | NOT TESTED | Planned                                                                              |
| 12  | Date range filtering                             | e2e           | NOT TESTED | Planned                                                                              |

### Testing Notes

**29 unit tests PASSING** across 3 test files. Integration and E2E tests not yet written (require running Studio server with real MongoDB). Test scenarios fully specified in the test spec.

Unit tests use DI (constructor accepts `Model<IArchAuditLog>`). No `vi.mock` of platform components.

> Full testing details: [../testing/arch-audit-logs.md](../testing/arch-audit-logs.md)

---

## 18. References

- Backlog: [`docs/arch/backlogs/B62-arch-audit-logs.md`](../arch/backlogs/B62-arch-audit-logs.md)
- Related: [Audit Logging (Platform)](audit-logging.md) — platform-wide compliance audit trail (separate system)
- Related: [Arch AI Assistant](arch-ai-assistant.md) — the feature being instrumented
- Related: [EventStore](eventstore.md) — ClickHouse-based event pipeline (future bridge target)
- Model pricing: `@agent-platform/shared-kernel` — `estimateCost()` function
- Vercel AI SDK: `onStepFinish` callback documentation
