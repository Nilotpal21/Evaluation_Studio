# HLD: Arch AI Audit Logs

**Feature Spec**: `docs/features/arch-audit-logs.md`
**Test Spec**: `docs/testing/arch-audit-logs.md`
**Status**: APPROVED
**Author**: Sri Harsha
**Date**: 2026-04-12

---

## 1. Problem Statement

Arch AI's operational behavior is opaque. The two existing data stores — ArchSession (mutable state) and ArchJournal (semantic decisions) — capture what Arch decided, but not how it performed. Workspace administrators cannot diagnose LLM failures, measure token spend, trace error chains, or understand build phase latency without trawling unstructured server logs.

The goal is to add a structured, queryable audit log system that captures every LLM call, tool execution, phase transition, user action, build event, error, and system event — surfaced through an admin-only UI with filtering, aggregation, and export.

---

## 2. Alternatives Considered

### Option A: MongoDB Collection (Recommended)

- **Description**: New `arch_audit_logs` MongoDB collection in `packages/database`. Non-blocking buffered emitter in `packages/arch-ai`. API routes in `apps/studio`. TTL-managed retention.
- **Pros**: Zero new infrastructure. Same deployment model as ArchJournal. Immediate consistency. MongoDB aggregation pipeline handles all dashboard queries. Studio already connects to MongoDB.
- **Cons**: Not integrated with the platform-wide ClickHouse EventStore. No columnar analytics for large-scale cross-platform queries.
- **Effort**: M

### Option B: EventStore / ClickHouse via Platform Pipeline

- **Description**: Wire up `initializeEventStore()` in Studio's server startup. Emit `PlatformEvent` payloads with `arch.*` event types. Query via existing ClickHouse EventStore infrastructure.
- **Pros**: Unified analytics platform. Cross-platform LLM cost comparison (Arch vs Runtime). Existing buffered writer, WAL recovery, GDPR cascade hooks.
- **Cons**: Studio currently has no ClickHouse dependency — adds a new infrastructure requirement to Studio's deployment. 5-second buffer flush lag for ClickHouse writes means admin page may not see the latest events. Requires Studio server startup changes and ClickHouse connection pooling. Over-engineered for 5K-50K events/day.
- **Effort**: L

### Option C: Structured Logger with Log Aggregation

- **Description**: Emit structured JSON logs via `createLogger`. Query via external log aggregation (ELK, Loki, CloudWatch).
- **Pros**: Near-zero code. Existing logging infrastructure.
- **Cons**: Not queryable from Studio UI without external service integration. No aggregation pipeline for KPI cards. No tenant isolation at the query layer — log aggregation tools need per-tenant access controls. No TTL management. No export API. Doesn't meet FR-6 through FR-9.
- **Effort**: S (but doesn't meet requirements)

### Recommendation: Option A — MongoDB Collection

**Rationale**: Option A meets all 16 functional requirements with the smallest blast radius and zero new infrastructure. The volume (5K-50K events/day) is well within MongoDB's comfort zone. Option B would be justified if Arch audit data needed to be correlated with Runtime trace data across ClickHouse, but that's a future bridge — not a v1 requirement. Option C fails to meet the core requirement of an in-app queryable UI.

---

## 3. Architecture

### System Context Diagram

```
                    ┌─────────────────────────────────────────────┐
                    │                 Studio (Next.js)             │
                    │                                             │
   User ──HTTP──>   │  ┌─────────────────────────────────────┐   │
   (Chat)           │  │    POST /api/arch-ai/message        │   │
                    │  │                                     │   │
                    │  │  streamText() ──onStepFinish──┐     │   │
                    │  │  tool exec ───────────────────┤     │   │
                    │  │  phase transition ────────────┤     │   │
                    │  │  error catch ─────────────────┤     │   │
                    │  │                               ▼     │   │
                    │  │              ┌──────────────────┐   │   │
                    │  │              │ AuditLogEmitter   │   │   │
                    │  │              │ (in-memory buffer)│   │   │
                    │  │              └────────┬─────────┘   │   │
                    │  │                      │flush         │   │
                    │  └──────────────────────┼─────────────┘   │
                    │                         │                  │
   Admin ──HTTP──>  │  ┌──────────────────────┼─────────────┐   │
   (Settings)       │  │  GET /api/arch-ai/   │             │   │
                    │  │    audit-logs/*       ▼             │   │
                    │  │              ┌──────────────────┐   │   │
                    │  │              │    MongoDB        │   │   │
                    │  │              │ arch_audit_logs   │   │   │
                    │  │              │ (90-day TTL)      │   │   │
                    │  │              └──────────────────┘   │   │
                    │  └────────────────────────────────────┘   │
                    └─────────────────────────────────────────────┘
```

### Component Diagram

```
┌─ packages/arch-ai ───────────────────────────────┐
│                                                   │
│  src/audit/                                       │
│    types.ts ─── AuditLogCategory, Severity,       │
│    │             LLMCallDetail, ErrorDetail, etc.  │
│    │                                              │
│    audit-log-emitter.ts ─── AuditLogEmitter       │
│    │  - buffer: AuditLogEntry[]                   │
│    │  - emit(entry) → push to buffer              │
│    │  - flush() → insertMany (fire-and-forget)    │
│    │  - scheduleFlush() → 2s timer                │
│    │                                              │
│    index.ts ─── re-exports                        │
└───────────────────────────────────────────────────┘

┌─ packages/database ──────────────────────────────┐
│                                                   │
│  src/models/                                      │
│    arch-audit-log.model.ts                        │
│    │  - IArchAuditLog interface                   │
│    │  - ArchAuditLogSchema                        │
│    │  - 6 indexes + TTL                           │
│    │  - tenantIsolationPlugin                     │
│    │                                              │
│    index.ts ─── re-export ArchAuditLog            │
└───────────────────────────────────────────────────┘

┌─ apps/studio ────────────────────────────────────┐
│                                                   │
│  API routes (read path):                          │
│    /api/arch-ai/audit-logs/route.ts       (list)  │
│    /api/arch-ai/audit-logs/summary/route.ts       │
│    /api/arch-ai/audit-logs/sessions/[id]/         │
│      timeline/route.ts                            │
│    /api/arch-ai/audit-logs/cost-breakdown/        │
│      route.ts                                     │
│                                                   │
│  Emission points (write path):                    │
│    /api/arch-ai/message/route.ts (modified)       │
│    /api/arch-ai/sessions/route.ts (modified)      │
│                                                   │
│  UI components:                                   │
│    components/admin/ArchAuditLogsTab.tsx           │
│    components/admin/AuditLogSummaryCards.tsx       │
│    components/admin/AuditLogFilters.tsx            │
│    components/admin/AuditLogRow.tsx                │
│    components/admin/AuditLogTimeline.tsx           │
│    store/arch-audit-store.ts                      │
└───────────────────────────────────────────────────┘
```

### Data Flow

**Write path** (hot — SSE streaming):

```
1. User sends message → POST /api/arch-ai/message
2. Route creates AuditLogEmitter(ctx, ArchAuditLogModel)
3. Route emits user_action event → emitter.emit()
4. streamText() starts → onStepFinish fires per LLM step
   → emitter.emit({ category: 'llm_call', tokens, cost })
5. Tool execution completes → emitter.emit({ category: 'tool_execution' })
6. Phase transition occurs → emitter.emit({ category: 'phase_transition' })
7. Error caught → emitter.emit({ category: 'error' })
8. SSE done event fires → emitter.flush() (drain remaining buffer)
9. Buffer writes to MongoDB via insertMany({ ordered: false })
```

**Read path** (cool — admin page):

```
1. Admin opens /admin/arch → "Audit Logs" tab
2. UI loads → store dispatches fetchLogs()
3. GET /api/arch-ai/audit-logs?category=...&severity=...&page=1
4. Route: requireTenantAuth → parse filters → MongoDB find() with indexes
5. Response: { success, entries, total, page, hasMore }
6. Admin clicks "Summary" cards → GET /api/arch-ai/audit-logs/summary
7. Route: MongoDB $facet aggregation → totals, errorCounts, byCategory
8. Admin clicks session ID → GET /api/arch-ai/audit-logs/sessions/:id/timeline
9. Route: MongoDB find({ sessionId }).sort({ timestamp: 1 })
10. Admin clicks "Export CSV" → GET /api/arch-ai/audit-logs?format=csv
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | Every query and aggregation pipeline must include an explicit `{ tenantId: auth.tenantId }` filter injected from the auth context — this is the **primary** isolation mechanism. The `tenantIsolationPlugin` is applied to the schema as **defense-in-depth**, but Studio does not register an ALS tenant-context provider (unlike Runtime/SearchAI), so the plugin alone cannot be relied upon. Cross-tenant queries return empty results — not 404, since audit logs are list endpoints (empty list is the correct empty state).                                                                         |
| 2   | **Data Access Pattern** | Direct Mongoose model access from API routes — no repository layer. Same pattern as ArchJournal routes. The emitter accepts `Model<IArchAuditLog>` via DI for testability. Read queries use lean() for performance. Aggregation uses native MongoDB pipelines ($facet, $group).                                                                                                                                                                                                                                                                                                                            |
| 3   | **API Contract**        | Standard Studio API envelope: `{ success: boolean, entries?: T[], total?: number, page?: number, hasMore?: boolean, error?: { code: string, message: string } }`. Query params for filtering (no request body on GET). Pagination via `page` + `limit` (max 200). Date range via `from`/`to` ISO 8601. CSV export via `?format=csv` query param on the list endpoint.                                                                                                                                                                                                                                      |
| 4   | **Security Surface**    | Auth: `requireTenantAuth` + `requireAdminRole(auth.id, auth.tenantId)` on all 4 read endpoints. `requireAdminRole` (at `apps/studio/src/lib/auth.ts:143`) returns 403 for non-OWNER/ADMIN users, ensuring only workspace admins can access audit data. The UI tab also guards with an admin-role check before rendering. Input validation: Zod schemas validate all query params — category enum, severity enum, date format, numeric page/limit. No user-supplied content stored verbatim in `detail` (tool inputs truncated, no LLM prompts). Export: CSV/JSON scoped to current tenant's filtered view. |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | **Write path**: all errors swallowed. `AuditLogEmitter.flush()` wraps `insertMany` in try/catch, logs via `createLogger('arch-ai:audit')`, never propagates. The SSE stream is never affected by audit log failures. **Read path**: standard API error responses — 400 for bad params, 401 for missing auth, 500 for unexpected errors with `{ success: false, error: { code, message } }`.                      |
| 6   | **Failure Modes** | **MongoDB down during write**: Emitter flush fails silently. Buffered events are lost when the request ends. No retry, no WAL. Acceptable for best-effort operational telemetry. **MongoDB down during read**: API returns 500 with a descriptive error. Admin page shows an error state. **Stream abort**: `onStepFinish` captures per-completed-step usage. Final incomplete step's tokens are lost (GAP-001). |
| 7   | **Idempotency**   | Not required. Audit log entries are append-only, each with a `uuidv7` `_id`. There's no update or upsert. Duplicate writes from a retry scenario would create duplicate entries — acceptable since the emitter never retries. Read endpoints are naturally idempotent (GET queries).                                                                                                                             |
| 8   | **Observability** | `createLogger('arch-ai:audit')` for: flush success (debug — batch size), flush failure (warn — error message, batch size), emitter creation (debug — session context). No self-referential audit events (the emitter doesn't audit itself). Future: Prometheus metrics for buffer size, flush latency, write error rate.                                                                                         |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 9   | **Performance Budget** | **Write**: `emit()` is a synchronous array push — <0.01ms per call. `flush()` is async `insertMany` — ~2-10ms for 50 entries, fire-and-forget. Target: <1ms SSE latency increase at p95. **Read**: List endpoint target <200ms (covering indexes). Summary aggregation target <500ms for 10K entries ($facet). Max response payload: 200 entries x ~500 bytes = ~100KB.                                                                                                                                                                    |
| 10  | **Migration Path**     | No migration needed. New collection `arch_audit_logs` created on first write (Mongoose auto-creates). No existing data. Indexes created at model registration time. TTL index starts expiring entries 90 days after creation.                                                                                                                                                                                                                                                                                                              |
| 11  | **Rollback Plan**      | Set `ARCH_AUDIT_LOG_ENABLED=false` → emitter becomes a no-op (check env at construction time). All `onStepFinish` callbacks guarded by `if (emitter)` null check. API routes can remain deployed — they return empty results from an empty collection. For full removal: revert the code changes to `message/route.ts` (remove callbacks), drop the collection.                                                                                                                                                                            |
| 12  | **Test Strategy**      | **Unit** (11 scenarios): Emitter buffer/flush logic, schema validation, type correctness. Emitter unit tests use DI (inject mock model interface). **Integration** (8 scenarios): Route handlers against real MongoDB — filter combinations, aggregation accuracy, tenant isolation, CSV serialization. **E2E** (10 scenarios): Full HTTP API calls with auth headers — lifecycle flow, tenant isolation (bidirectional), pagination, timeline, summary, cost breakdown, export, date range. No `vi.mock` of platform components anywhere. |

---

## 5. Data Model

### New Collections

```
Collection: arch_audit_logs
Engine: MongoDB (same cluster as arch_sessions, arch_journal)

Document shape:
{
  _id:         String (uuidv7, primary key)
  tenantId:    String (required)
  userId:      String (required)
  sessionId:   String (required)
  projectId:   String (optional — set for IN_PROJECT mode)
  category:    String (enum: llm_call | tool_execution | phase_transition |
                              user_action | build_event | error | system_event)
  severity:    String (enum: info | warning | error | critical)
  summary:     String (required — one-line human-readable)
  detail:      Mixed  (required — category-specific payload, see §5.1)
  specialist:  String (optional)
  phase:       String (optional — INTERVIEW | BLUEPRINT | BUILD | CREATE)
  durationMs:  Number (optional)
  tokens: {                    // optional — denormalized for aggregation
    input:         Number
    output:        Number
    total:         Number
    estimatedCost: Number
  }
  timestamp:   Date (required)
  createdAt:   Date (auto — Mongoose timestamps)
  updatedAt:   Date (auto — Mongoose timestamps)
}

Indexes:
  1. { tenantId: 1, timestamp: -1 }                 — primary listing (admin page)
  2. { tenantId: 1, sessionId: 1, timestamp: 1 }    — session timeline
  3. { tenantId: 1, category: 1, timestamp: -1 }    — category filter
  4. { tenantId: 1, severity: 1, timestamp: -1 }    — error spotlight
  5. { tenantId: 1, projectId: 1, timestamp: -1 }   — project scope
  6. { timestamp: 1 } TTL expireAfterSeconds: 7776000  — 90-day retention

Plugins:
  - tenantIsolationPlugin (defense-in-depth — Studio does NOT register ALS tenant
    context, so all queries MUST include explicit { tenantId } filter from auth context)
```

**CRITICAL**: Every `find()`, `aggregate()`, `insertMany()`, and `countDocuments()` call must include `tenantId` from the auth context. The `tenantIsolationPlugin` is applied as a safety net but cannot be the primary isolation mechanism in Studio because Studio does not call `registerTenantContextProvider()` or `withTenantContext()` at startup.

### 5.1 Category Detail Payloads

```typescript
// llm_call
{ model: string, inputTokens: number, outputTokens: number,
  totalTokens: number, estimatedCost: number,
  finishReason: 'end_turn' | 'max_tokens' | 'tool_use',
  specialist: string, stepIndex: number, totalSteps?: number }

// tool_execution
{ toolCallId: string, toolName: string,
  inputSummary: string,  // truncated to 200 chars, no secrets
  resultStatus: 'success' | 'error', durationMs: number,
  retryCount: number, agentName?: string }

// phase_transition
{ from: string, to: string,
  trigger: 'auto' | 'user_action' | 'gate_pass',
  durationInPreviousPhasMs: number, messageCountInPhase: number }

// user_action
{ action: string,  // enum: message_sent, gate_approved, etc.
  detail: string }

// build_event
{ event: string,  // enum: agent_generation_start, agent_compiled, etc.
  agentName: string, status: 'pass' | 'warning' | 'error',
  constructsUsed?: string[], qualityFloor?: Record<string, boolean>,
  warnings?: string[] }

// error
{ errorCode: string, message: string,
  source: 'llm' | 'compiler' | 'tool' | 'session' | 'system',
  recoveryAction?: 'retried' | 'degraded' | 'aborted' | 'user_notified' }

// system_event
{ event: string,  // enum: session_created, session_archived, etc.
  detail: string, previousValue?: unknown, newValue?: unknown }
```

### Modified Collections

None. No changes to `arch_sessions` or `arch_journal`.

### Key Relationships

```
arch_audit_logs.sessionId ──references──> arch_sessions._id
  (no foreign key constraint — audit logs outlive sessions via independent TTL)

arch_audit_logs.tenantId ──scoped by──> tenant (via tenantIsolationPlugin)

arch_audit_logs.projectId ──optional reference──> projects._id
  (set for IN_PROJECT mode sessions only)
```

---

## 6. API Design

### New Endpoints

| Method | Path                                             | Purpose                        | Auth                                     | Response Shape                                                                           |
| ------ | ------------------------------------------------ | ------------------------------ | ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| GET    | `/api/arch-ai/audit-logs`                        | List with filters + pagination | `requireTenantAuth` + `requireAdminRole` | `{ success, entries[], total, page, hasMore }`                                           |
| GET    | `/api/arch-ai/audit-logs/summary`                | Aggregate KPI stats            | `requireTenantAuth` + `requireAdminRole` | `{ success, data: { totalEvents, totalTokens, estimatedCost, errorCount, byCategory } }` |
| GET    | `/api/arch-ai/audit-logs/sessions/[id]/timeline` | Session timeline               | `requireTenantAuth` + `requireAdminRole` | `{ success, entries[] }`                                                                 |
| GET    | `/api/arch-ai/audit-logs/cost-breakdown`         | Cost by user/phase/model       | `requireTenantAuth` + `requireAdminRole` | `{ success, data: { groups[] } }`                                                        |

### Query Parameters (all endpoints)

```
from:       ISO 8601 date (default: 7 days ago)
to:         ISO 8601 date (default: now)
```

### Additional Parameters (list endpoint)

```
page:       number (default: 1)
limit:      number (default: 50, max: 200)
category:   comma-separated enum values
severity:   comma-separated enum values
phase:      exact match
userId:     exact match
sessionId:  exact match
specialist: exact match
format:     'csv' | 'json-export'  (optional — omit for normal paginated list)

Export behavior: When format=csv or format=json-export is explicitly set,
the endpoint ignores `page` and `limit` and streams ALL matching entries
(up to a hard cap of 10,000 rows to prevent OOM). The response uses
Content-Disposition: attachment and chunked transfer encoding for CSV.
When `format` is omitted (the default), the endpoint returns the standard
paginated envelope `{ success, entries[], total, page, hasMore }`.
This avoids ambiguity between the normal JSON list response and the
full-export JSON response.
```

### Error Responses

| Status | Code             | When                                               |
| ------ | ---------------- | -------------------------------------------------- |
| 400    | `INVALID_PARAMS` | Invalid filter value, bad date format, limit > 200 |
| 401    | `UNAUTHORIZED`   | Missing or invalid auth token                      |
| 403    | `FORBIDDEN`      | Authenticated but not OWNER/ADMIN role             |
| 500    | `INTERNAL_ERROR` | MongoDB query failure                              |

---

## 7. Cross-Cutting Concerns

- **Audit Logging**: This feature IS the audit logging system for Arch AI. The emitter does not audit itself (no infinite recursion). Platform-level audit logging (ClickHouse AuditStore) is unaffected — separate system for compliance events.
- **Rate Limiting**: Not applied to audit log read endpoints. These are admin-only, low-frequency queries. The existing Studio rate limiter applies at the global level.
- **Caching**: No caching on read endpoints. Data freshness is important for diagnostics. No Redis dependency.
- **Encryption**: Data at rest encrypted by MongoDB's storage engine (same as all other collections). No field-level encryption needed — no PII or secrets stored. Data in transit via HTTPS.
- **PII**: No LLM prompts/responses stored. Tool inputs truncated to 200 chars with secret scrubbing. `userId` is an internal ID, not PII. No email, name, or phone in audit log entries.
- **GDPR / Erasure**: Although audit logs minimize PII (no email/name, only internal `userId`), proper erasure requires explicit cascade hooks:
  - **Tenant deletion**: Register a cascade hook (`registerEventCascadeHook` pattern from Runtime's `eventstore-singleton.ts`) that runs `ArchAuditLog.deleteMany({ tenantId })` when a tenant is deleted. The `tenantIsolationPlugin` only scopes reads/writes — it does NOT perform deletions.
  - **User erasure**: On user deletion, run `ArchAuditLog.updateMany({ userId }, { $set: { userId: 'REDACTED' } })` to anonymize the actor. Alternatively, if user deletion is not a current platform capability, document this as a known gap.
  - **TTL as complement**: The 90-day TTL index handles routine cleanup but is not a substitute for on-demand erasure requests.

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                                         | Type           | Risk                                                                |
| -------------------------------------------------- | -------------- | ------------------------------------------------------------------- |
| `@agent-platform/database` (Mongoose, MongoDB)     | Infrastructure | Low — already used by ArchSession, ArchJournal                      |
| `@agent-platform/shared-kernel` (`estimateCost()`) | Utility        | Low — stable, no changes needed                                     |
| `@/lib/auth` (`requireTenantAuth`)                 | Auth           | Low — standard Studio auth pattern                                  |
| Vercel AI SDK (`onStepFinish`)                     | External       | Medium — callback behavior on stream abort is a known gap (GAP-001) |
| `packages/arch-ai` (new `audit/` module)           | Internal       | Low — new code, no conflicts                                        |

### Downstream (depends on this feature)

| Consumer                         | Impact                                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------------------- |
| Future ClickHouse bridge         | Can map `arch_audit_logs` → PlatformEvents via a background job following `trace-bridge.ts` pattern |
| Future token budget alerts       | Can query `arch_audit_logs` for threshold-based alerting                                            |
| Future user-facing token counter | Can aggregate `tokens.total` per session for chat UI display                                        |

---

## 9. Open Questions & Decisions Needed

1. **Vercel AI SDK `onStepFinish` timing**: Does the callback fire before or after the step's chunks are emitted to the SSE stream? If after, there's no latency impact. If before, it could introduce a micro-delay. Need to verify in Vercel AI SDK source.
2. **Index selection for multi-filter queries**: When both `category` and `severity` are filtered, MongoDB must choose between index 3 (`tenantId, category, timestamp`) and index 4 (`tenantId, severity, timestamp`). A compound index `{ tenantId, category, severity, timestamp }` could be more efficient for the common "show me errors of type X" query. Monitor query plans post-implementation and add if needed.
3. **`insertMany` partial failure semantics**: With `{ ordered: false }`, MongoDB writes all valid documents and returns errors for invalid ones. Should the emitter log the count of failed/succeeded documents in the warning, or just log the error?

---

## 10. References

- Feature spec: `docs/features/arch-audit-logs.md`
- Test spec: `docs/testing/arch-audit-logs.md`
- Backlog: `docs/arch/backlogs/B62-arch-audit-logs.md`
- Related HLD: `docs/specs/audit-logging.hld.md` (platform-wide audit — separate system)
- ArchJournal model: `packages/database/src/models/arch-journal.model.ts` (pattern reference)
- EventStore trace bridge: `packages/eventstore/src/migration/trace-bridge.ts` (future bridge pattern)
- Model pricing: `packages/shared-kernel/src/model-pricing.ts` (`estimateCost()`)
- Vercel AI SDK: `onStepFinish` callback in `streamText()`
