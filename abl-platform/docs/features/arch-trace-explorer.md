# Feature: Arch AI Trace Explorer

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: PLANNED
**Feature Area(s)**: `observability`, `admin operations`
**Package(s)**: `packages/arch-ai`, `packages/observatory`, `packages/database`, `packages/shared-observability`, `apps/studio`
**Owner(s)**: Platform team
**Testing Guide**: [../testing/arch-trace-explorer.md](../testing/arch-trace-explorer.md)
**Last Updated**: 2026-04-14
**Supersedes**: [Arch AI Audit Logs (ALPHA)](arch-audit-logs.md)

---

## 1. Introduction / Overview

### Problem Statement

Arch AI's existing audit log system (`arch-audit-logs`, ALPHA) has typed payloads for 7 event categories but suffers from four structural gaps that block debugging and observability:

1. **Emitter not wired** — `AuditLogEmitter` is defined but only emits at session creation. LLM calls, tool executions, phase transitions, and errors are not captured during execution because the emitter is not passed through the execution chain.
2. **Flat events, no hierarchy** — audit logs are rows in a table. You cannot reconstruct the execution path (which tool call happened inside which LLM response, inside which turn, inside which phase). Debugging requires correlating timestamps across a flat list.
3. **No callstack view** — the timeline modal lists events chronologically. There is no tree, no nesting, no click-to-expand detail panels.
4. **Duplicate trace contract** — the platform has canonical trace contracts in `packages/observatory/` (`ExtendedTraceEvent`, `Span`, `TraceTree`) and `packages/shared-observability/tracing/` (`Tracer`, `Span`, `SpanContext`, `WritePipeline`). Arch-ai ignores all of them and uses a bespoke `AuditLogEmitter`, so traces cannot be shared with runtime tooling or migrated to OpenTelemetry/ClickHouse without a full rewrite.

When a user reports "Arch produced a bad blueprint" or "build failed silently", a developer currently has no way to see the execution tree, drill into specific LLM calls or tool executions, or identify which span inside which phase actually failed.

### Goal Statement

Replace the flat audit log system with a hierarchical trace explorer that renders every Arch AI session as a callstack (Session → Phase → Turn → LLM Call → Tool Execution), reuses canonical platform trace contracts so it is portable across storage backends, and captures running span state for live diagnosis. Errors bubble up the tree; clicking any span reveals a compact detail panel with full expandable input/output. All storage is pluggable via the `WritePipeline` contract — MongoDB today, ClickHouse / OpenTelemetry later with zero changes to emission code.

### Summary

The feature introduces:

1. **`packages/arch-ai/src/tracing/`** — a new module that implements the shared `Tracer` + `WritePipeline` contracts for Arch AI, with `AsyncLocalStorage`-based parent span propagation (same pattern as the runtime).
2. **New MongoDB collections** — `arch_trace_spans` (one doc per span, mutable) and `arch_trace_sessions` (monotonic revision counter per session for reliable incremental polling).
3. **Redaction boundary** — default-on payload scrubbing using existing `scrubTraceEvent()` / `scrubToolCallData()` / `redactPII()` utilities from `@abl/compiler`. Raw payload capture is opt-in via `ARCH_TRACE_RAW_PAYLOADS=true`.
4. **Event type extensions** — new arch-specific types (`arch_phase_transition`, `arch_build_event`, `arch_gate_response`, `arch_session_event`, `arch_spec_update`) added additively to `packages/observatory`'s `TraceEventType` union. LLM calls and tool calls reuse existing `llm_call` / `tool_call` types.
5. **Scoped API routes** — `/api/projects/:projectId/arch-ai/traces/...` for IN_PROJECT sessions (project-scoped) and `/api/arch-ai/traces/onboarding/...` for ONBOARDING sessions (user-scoped). Cross-scope access returns 404.
6. **Trace Explorer UI** — master-detail layout inside the arch settings page: left panel lists sessions (named from first user message), right panel renders the hierarchical trace tree plus a span detail panel with type-specific metric cards (LLM tokens/model/finish reason; tool input summary/output summary/retries).
7. **Session-wide revision polling** — atomic revision counter guarantees in-flight span updates, status changes, and error-bubbled parents are caught by incremental polls.

The predecessor `arch-audit-logs` feature is deprecated. Old data in `arch_audit_logs` remains queryable via direct DB access until its 90-day TTL expires; new sessions write only to `arch_trace_spans`.

---

## 2. Scope

### Goals

- Hierarchical trace tree with status, duration, and key metrics at every node (Session → Phase → Turn → LLM Call → Tool Execution → nested LLM/tool)
- Reuse canonical shared trace contracts (`Tracer`, `Span`, `SpanContext`, `WritePipeline`) so the storage backend is pluggable and the data model is W3C-compatible from day one
- Error bubbling: a failed tool call marks its parent LLM call, turn, phase, and session as `error`, visible at every level
- Scoped access: project routes include `{ tenantId, projectId }`; onboarding routes include `{ tenantId, userId }`; cross-scope returns 404
- Redaction by default; raw capture opt-in with shorter TTL
- Session list named from first user message for scannability
- Live diagnosis via monotonic session-revision polling at 5 s intervals while a session is active
- Capture LLM token usage (input/output/total) and estimated cost per call via Vercel AI SDK `onStepFinish`
- Replace `ArchAuditLogsTab` with the new `TraceExplorer` component

### Non-Goals (Out of Scope)

- Real-time WebSocket streaming of trace events (5 s poll only)
- Multi-session history UI for switching between sessions inside the chat (read [Arch-AI Planned Changes — Multi-Session](../../.claude/projects/-Users-sriharshanalluri-abl-platform/memory/arch-multi-session-plan.md)). The trace explorer already lists multiple sessions; the multi-session chat UX is tracked separately.
- Full OpenTelemetry export pipeline (W3C-compatible IDs are used, but no exporter in v1)
- Cross-session comparison / diff view
- CSV/JSON export of trace data (carry over from arch-audit-logs deferred to post-v1)
- Full-text search on span names or attributes (structured filters only)
- Dual-emit to ClickHouse EventStore (future plugin swap, not parallel)
- Backfilling old `arch_audit_logs` rows into the new span schema
- Storing full LLM prompts/responses by default (only token counts + summary + scrubbed input/output; raw mode is opt-in)
- Trend charts over time (summary cards show current-period totals only)
- Observatory-package-level read API consolidation (arch-ai owns its reader for v1)

---

## 3. User Stories

1. As a **developer diagnosing a bad blueprint**, I want to open the arch settings trace explorer, click the failed session, and see the full execution tree so that I can identify which tool call or LLM response produced the bad output.
2. As a **developer debugging a timeout**, I want errors to bubble up the trace tree so that I can see "BLUEPRINT phase failed" at a glance and drill down to the specific tool execution that timed out.
3. As a **developer inspecting an LLM call**, I want to click the span and see a compact summary (model, tokens, duration, finish reason) with an expandable section to see the full scrubbed input/output so that I can confirm the call shape without being overwhelmed by raw payload.
4. As a **workspace admin watching AI spend**, I want the trace explorer stats endpoint to aggregate token usage and estimated cost by model and phase so that I can understand which sessions and phases are most expensive.
5. As a **developer watching an active session**, I want the trace tree to auto-refresh every 5 seconds and show in-flight spans (running state) so that I can diagnose live rather than waiting for the session to complete.
6. As a **security/compliance reviewer**, I want payloads scrubbed by default so that no secrets, PII, or raw user content end up in the trace store without explicit opt-in.
7. As a **platform engineer planning a ClickHouse migration**, I want arch-ai trace emission to use the canonical `WritePipeline` interface so that swapping in a `ClickHouseWritePipeline` provider does not require touching a single line of execution code.
8. As a **developer working in an onboarding session**, I want my onboarding session traces to be visible only to me, not to other workspace members, so that my pre-project exploration remains private until I create a project.

---

## 4. Functional Requirements

1. **FR-1**: The system must capture every Arch AI session as a root span with `traceId = sessionId`, and every subsequent event (phase, turn, LLM call, tool execution, phase transition) as a child span linked by `parentSpanId`.
2. **FR-2**: The system must implement the canonical write-side `Tracer` and `Span` interfaces from `@agent-platform/shared-observability/tracing` so execution code calls `tracer.startSpan()`, `span.setAttribute()`, `span.setStatus()`, and `span.end()` — not a bespoke emitter API.
3. **FR-3**: The system must use `AsyncLocalStorage` for automatic parent span propagation across the execution chain (coordinator → specialist → LLM client → tool executor), mirroring the runtime `TracerImpl` pattern.
4. **FR-4**: The `WritePipeline` implementation must persist spans in three lifecycle events: `span_start` (INSERT with `status: 'running'` and `startTime`), `span_update` (batched UPDATE of attributes and events, flushed every 2 s), and `span_end` (UPSERT with final status, `endTime`, `durationMs`, full attributes, and full events).
5. **FR-5**: `span_end` writes must use `updateOne({ spanId }, ..., { upsert: true })` with `$setOnInsert` populating `traceId`, `parentSpanId`, `name`, `startTime`, and scope fields (`tenantId`, `userId`, `sessionId`, `projectId`) so that a dropped `span_start` never causes data loss.
6. **FR-6**: Every span write (insert or update) must increment a session-wide monotonic revision counter in the `arch_trace_sessions` collection and stamp the span document with that revision. Flush cycles must atomically claim a contiguous revision range via `findOneAndUpdate({ $inc: { revision: batchSize } })` and commit writes via `bulkWrite({ ordered: true })`.
7. **FR-7**: The system must register the following new arch-specific event types additively in `packages/observatory/src/schema/trace-events.ts`: `arch_phase_transition`, `arch_build_event`, `arch_gate_response`, `arch_session_event`, `arch_spec_update`, `arch_system_event`. Existing `llm_call` and `tool_call` types must be reused without modification. Additions are pure union-widening (no removals) so consumers continue to compile.
8. **FR-8**: The write-side `'ok' | 'error'` span status (from shared-observability) must be mapped to the read-side `'running' | 'completed' | 'error'` status (observatory `SpanStatus`) at write time inside `MongoWritePipeline`. `ok` maps to `completed`. `running` is set at `span_start`.
9. **FR-9**: Every trace event must pass through a redaction boundary before hitting the `WritePipeline`. Default mode scrubs secrets (via `scrubSecrets()`), PII (via `redactPII()`), and truncates tool input/output to a 4KB summary. LLM input messages and output bodies must not be stored by default — only token counts, finish reason, and a one-line summary.
10. **FR-10**: The system must expose an opt-in raw-payload mode via `ARCH_TRACE_RAW_PAYLOADS=true`. Spans written in raw mode must include full tool input/output and full LLM input/output (still secret- and PII-scrubbed), must be tagged with `attributes['trace.rawCapture'] = 'true'`, and must be subject to a shorter TTL override (`ARCH_TRACE_RAW_TTL_DAYS`, default 7).
11. **FR-11**: When a span ends with `status: 'error'`, the `ArchTracer` must walk up to the parent span and upgrade its status to `error` (if not already `error`), propagating until reaching the root span or an ancestor already in `error` state. Each upgrade is a span update → increments session revision → caught by the next poll.
12. **FR-12**: The system must expose **project-scoped** HTTP routes (Next.js App Router under `apps/studio/src/app/api/projects/[id]/arch-ai/traces/...`, following the repo's `[id]` convention) that include `projectId` in every query: `GET /api/projects/[id]/arch-ai/traces/sessions`, `GET /api/projects/[id]/arch-ai/traces/sessions/[sessionId]`, `GET /api/projects/[id]/arch-ai/traces/sessions/[sessionId]/poll?sinceRevision=N`, `GET /api/projects/[id]/arch-ai/traces/spans/[spanId]`, `GET /api/projects/[id]/arch-ai/traces/stats`. Auth: wrap each handler with `withRouteHandler({ requireProject: true, permissions: 'arch:traces:read' }, handler)` from `apps/studio/src/lib/route-handler.ts`. Cross-project access returns **404** (project existence leakage prevented by the wrapper).
13. **FR-13**: The system must expose **user-scoped** HTTP routes for ONBOARDING sessions (Next.js App Router under `apps/studio/src/app/api/arch-ai/traces/onboarding/...`) that include `userId` + `projectId: null` in every query: `GET /api/arch-ai/traces/onboarding/sessions`, `GET /api/arch-ai/traces/onboarding/sessions/[id]`, `GET /api/arch-ai/traces/onboarding/sessions/[id]/poll?sinceRevision=N`, `GET /api/arch-ai/traces/onboarding/spans/[id]`. Auth: wrap each handler with `withRouteHandler({}, handler)` (default auth via `requireAuth`) and derive `userId` from the authenticated user. Cross-user access returns **404**.
14. **FR-14**: The MongoDB schema must include indexes split by access context: `{ tenantId, projectId, sessionId, startTime }` for project tree fetch, `{ tenantId, projectId, sessionId, revision }` for project poll, `{ tenantId, userId, sessionId, startTime }` for onboarding tree fetch, `{ tenantId, userId, sessionId, revision }` for onboarding poll, plus `{ spanId }` unique and a TTL index on the pre-computed `expiresAt` field (`expireAfterSeconds: 0` — MongoDB deletes docs when `expiresAt < now`).
15. **FR-15**: The system must capture LLM call attributes from the Vercel AI SDK `onStepFinish` callback: `llm.model`, `llm.inputTokens`, `llm.outputTokens`, `llm.totalTokens`, `llm.finishReason`, and `llm.estimatedCost`. Cost calculation must reuse the existing `estimateCost(model, inputTokens, outputTokens)` function and `MODEL_PRICING` map from `@agent-platform/shared-kernel` (see `packages/shared-kernel/src/model-pricing.ts`). A local `pricing.ts` must NOT be created — duplicate pricing tables are a maintenance hazard.
16. **FR-16**: The system must capture tool execution attributes: `tool.name`, `tool.callId`, `tool.resultStatus` (`success | error | timeout | partial`), `tool.retryCount`, `tool.inputSummary` (scrubbed, truncated), and `tool.durationMs`.
17. **FR-17**: The root session span must be created at session creation (`POST /api/arch-ai/sessions`) with placeholder name `"New Session"`. On the first user message, the root span `name` must be backfilled to the truncated (≤50 char) user message text, and the session document's `name` field must be updated in parallel. The backfill increments the session revision.
18. **FR-18**: The Trace Explorer UI must render a master-detail layout inside the arch settings page: left panel shows a sorted-by-recency session list (name from first message, status badge, phase, span count, error/warning count, total tokens, time-ago); right panel shows the expandable trace tree plus a span detail panel below. Auto-poll every 5 seconds using `sinceRevision` while a session is active.
19. **FR-19**: The span detail panel must render type-specific compact views: LLM Call (summary line + model/duration/input tokens/output tokens/finish reason cards + expandable Input Messages, Output, Tool Calls Made); Tool Execution (error banner if failed + tool name/duration/retries/specialist cards + expandable Input Arguments, Output, Error Stack); Phase Transition (from→to + trigger + duration). Every detail panel must show span breadcrumb (e.g. `span_a2c1 · LLM Call → Turn 4 → BLUEPRINT`), status badge, and start/end timestamps.
20. **FR-20**: A new permission string `arch:traces:read` must be registered in `apps/studio/src/lib/permissions.ts` (the Studio permission catalog consumed by `withRouteHandler({ permissions })`). Workspace owners, admins, and project members with read access must be granted by default. The permission is required only by project-scoped routes; onboarding routes do not require it (user-scope filter is the gate).
21. **FR-21**: On tenant deletion, a cascade hook must run `ArchTraceSpan.deleteMany({ tenantId })` and `ArchTraceSession.deleteMany({ tenantId })`. The existing isolation plugins only scope reads/writes — they do NOT perform deletion cascades. (Carry-over from `arch-audit-logs` §12.)
22. **FR-22**: The system must enforce an upper bound of 2,000 spans per session. Beyond this, the tracer must emit a single `arch_system_event` span with status `error` and attribute `arch.systemEvent = 'span_cap_exceeded'`, then drop further span emissions for that session (with a structured log entry). Polling must also enforce a 500-span cap per poll response, returning a continuation revision for the next poll.
23. **FR-23**: The UI must be gated behind the `NEXT_PUBLIC_FEATURE_ARCH_TRACE_EXPLORER` feature flag (default `false` during rollout). When disabled, the arch settings page renders the legacy `ArchAuditLogsTab` so historical data remains accessible. When enabled, `ArchAuditLogsTab` is removed from the page.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                 |
| -------------------------- | ------------ | --------------------------------------------------------------------- |
| Project lifecycle          | NONE         | Observability layer — does not affect project operations              |
| Agent lifecycle            | NONE         | Observability layer — does not affect agent operations                |
| Customer experience        | NONE         | End users do not interact with the trace explorer                     |
| Integrations / channels    | NONE         | Not channel-aware                                                     |
| Observability / tracing    | PRIMARY      | Core purpose: debugging and observability for Arch AI execution       |
| Governance / controls      | SECONDARY    | Redaction boundary and scoped routes enforce governance               |
| Enterprise / compliance    | SECONDARY    | Secret/PII scrubbing, TTL retention, raw-mode opt-in with shorter TTL |
| Admin / operator workflows | PRIMARY      | New Trace Explorer replaces Audit Logs tab in arch settings           |

### Related Feature Integration Matrix

| Related Feature                                  | Relationship Type | Why It Matters                                                                                                                           | Key Touchpoints                                                                                        | Current State                                       |
| ------------------------------------------------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| [Arch AI Assistant](arch-ai-assistant.md)        | extends           | Trace Explorer instruments the Arch AI message route, session lifecycle, and phase machine                                               | `message/route.ts`, `sessions/route.ts`, `phase-transition.ts`, `VercelLLMStreamClient`, tool executor | BETA — all emission points exist                    |
| [Arch AI Audit Logs](arch-audit-logs.md)         | supersedes        | Trace Explorer replaces the flat audit log UI and emitter with hierarchical span model                                                   | `AuditLogEmitter`, `ArchAuditLogsTab`, `IArchAuditLog` model, `arch-audit-store.ts`                    | ALPHA — deprecated by this feature                  |
| [Audit Logging (Platform)](audit-logging.md)     | shares data with  | Platform audit (ClickHouse) is compliance-grade; Arch Trace (MongoDB) is operational telemetry. Separate stores, complementary purposes. | Both use fire-and-forget semantics, both tenant-isolated                                               | BETA — no overlap, no dependency                    |
| [Model Hub](model-hub.md)                        | configured by     | Model selection in Arch settings determines `llm.model` attribute on LLM spans                                                           | `resolveArchVercelModel()`, `ModelResolutionService`                                                   | BETA — model ID available at call site              |
| [Arch AI Tool Lifecycle](arch-tool-lifecycle.md) | emits into        | Tool executions become `tool_execution` spans nested under LLM call spans                                                                | Tool executor, tool binding                                                                            | BETA — tool calls already instrumented at call site |

---

## 6. Design Considerations

### UI Location

- **Route**: Arch settings page (workspace level). The Trace Explorer replaces the "Audit Logs" tab. During rollout, the feature flag `NEXT_PUBLIC_FEATURE_ARCH_TRACE_EXPLORER` toggles between the new tab and the legacy audit logs tab.

### Layout Structure (Master-Detail)

| Region             | Width | Content                                                                                                                                                                                 |
| ------------------ | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Left panel         | 260px | Session list — sorted by recency, named from first message, status badge (ACTIVE blue / DONE green / ERROR red), quick stats (phase, span count, time ago, tokens, error/warning count) |
| Right panel top    | flex  | Hierarchical trace tree with expand/collapse arrows, colored status dots, inline metrics, filter chips (All / Errors / Slow)                                                            |
| Right panel bottom | flex  | Span detail panel — renders by span type with summary line, metric cards, expandable raw sections                                                                                       |

### Session Naming

Session name derives from the first user message (truncated to 50 chars with ellipsis). Stored on the session model AND backfilled to the root span. The trace system reads the root span name for display.

### Status Visual Design

| Status      | Color Token            | Icon        |
| ----------- | ---------------------- | ----------- |
| `running`   | Blue accent (primary)  | Pulsing dot |
| `completed` | Green accent (success) | Solid dot   |
| `error`     | Red accent (error)     | Filled ring |

The UI may render an additional amber "attention" indicator on `completed` spans whose descendants contain `tool_call_retry` events — this is a purely visual affordance derived at render time, not a persisted span status.

### Span-Type Icons (in tree)

| Span Type        | Icon            |
| ---------------- | --------------- |
| session (root)   | `Layers`        |
| phase            | `GitBranch`     |
| turn             | `MessageSquare` |
| llm_call         | `Brain`         |
| tool_execution   | `Wrench`        |
| phase_transition | `ArrowRight`    |

---

## 7. Technical Considerations

### Write-Side vs Read-Side Contract Split

The platform has two distinct `Span` types. Arch-AI uses them for their intended purpose:

- **Write-side** (execution code): `Span`, `Tracer`, `SpanContext`, `WritePipeline` from `@agent-platform/shared-observability/tracing`. Executable interface: `setAttribute()`, `setStatus()`, `end()`.
- **Read-side** (UI and API routes): `Span` data record, `TraceTree`, event types from `@agent-platform/observatory`. Passive: `spanId`, `traceId`, `events[]`, `attributes`.

The `MongoWritePipeline` is the only translation layer — it persists write-side lifecycle events into MongoDB documents that conform to the observatory read-side `Span` schema.

### Span Lifecycle Pipeline

```
tracer.startSpan()                → emit span_start  → INSERT doc (status: 'running', startTime, initial attrs)
span.setAttribute() / addEvent()  → emit span_update → UPDATE doc ($set attrs, $push events) [batched 2s]
span.setStatus(status); span.end() → emit span_end   → UPSERT doc (final status, endTime, full attrs, full events)
```

`span_end` is an **upsert** with `$setOnInsert` — if `span_start` was dropped, `span_end` creates the document with all required fields.

### Atomic Revision Assignment

Single-writer-per-session guarantee (enforced by the existing SSE request lifecycle + session state machine IDLE→ACTIVE atomicity):

```typescript
// Inside MongoWritePipeline.flush():
const batchSize = pendingWrites.length;
const { revision: max } = await ArchTraceSessionModel.findOneAndUpdate(
  { sessionId },
  { $inc: { revision: batchSize } },
  { returnDocument: 'after', upsert: true },
);
const base = max - batchSize;
const ops = pendingWrites.map((w, i) => ({ ...w, revision: base + i + 1 }));
await SpanModel.bulkWrite(ops, { ordered: true });
```

Ordered `bulkWrite` guarantees revision N commits before N+1. Gaps from partial failure are harmless (cursor is `$gt`).

### Scrubbing / Redaction Reuse

| Utility               | Source                                                    | Usage                                                   |
| --------------------- | --------------------------------------------------------- | ------------------------------------------------------- |
| `scrubSecrets()`      | `packages/compiler/.../scrub-patterns.ts`                 | Regex-based secret removal (API keys, tokens, PEM keys) |
| `scrubTraceEvent()`   | `packages/compiler/.../trace-scrubber.ts`                 | Universal event scrubbing                               |
| `scrubToolCallData()` | `packages/compiler/.../trace-scrubber.ts`                 | Tool input/output scrubbing                             |
| `redactPII()`         | `packages/compiler/src/platform/security/pii-detector.ts` | Email, phone, SSN, credit card detection                |

### Plugin Architecture

`TraceConfig.provider` resolves the pipeline implementation:

```typescript
function createArchTracer(config: ArchTracerConfig): ArchTracer {
  const pipeline = createWritePipeline(config); // 'mongo' today; 'clickhouse' / 'otel' later
  const redacted = new ArchRedactionBoundary(pipeline, config);
  return new ArchTracer({ ...config, writePipeline: redacted });
}
```

Swapping storage backends requires adding a new provider under `packages/arch-ai/src/tracing/providers/` and updating `createWritePipeline()`. Zero changes to execution code.

### Rollout Strategy — Per-Session-Era, Not Dual-Write

During the feature-flag rollout, the system is **not dual-write**. Each session is written to exactly one store for its entire lifetime:

- New sessions (created after the feature flag is on for the tenant/user): spans write only to `arch_trace_spans`.
- Existing sessions (created before the flag): continue to emit to `arch_audit_logs` via the legacy `AuditLogEmitter` wiring, which stays in place until the flag is globally on.
- The decision is made once at session creation based on the active flag value for that tenant. A session does not cross the store boundary mid-flight.

This keeps trees coherent (no split spans between stores) and simplifies the UI — it infers which store to query based on the session's creation era.

### Existing Integration Points

| Hook Site                                                                                      | Span Type Emitted                                      |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `POST /api/arch-ai/sessions` entry                                                             | root `session` span (`startTrace`)                     |
| `transitionPhase(session, targetPhase)` in `packages/arch-ai/src/coordinator/phase-machine.ts` | `phase` span start/end + `arch_phase_transition` event |
| Message route per-turn entry                                                                   | `turn` span                                            |
| `VercelLLMStreamClient` after stream completes                                                 | `llm_call` span with `onStepFinish` attributes         |
| Tool executor per invocation                                                                   | `tool_execution` span                                  |
| Phase gate resolution                                                                          | `arch_gate_response` event on current phase span       |
| Any catch block in the execution chain                                                         | `span.setStatus('error', message); span.end()`         |

---

## 8. How to Consume

### Studio UI

- **Route**: Arch settings page → "Traces" tab (replaces "Audit Logs")
- **Access**: Workspace members with `arch:traces:read` permission; project-scoped traces require project permission; onboarding traces are user-private
- **Interaction**: Select session → expand tree → click span → inspect detail. Auto-poll at 5 s while session is active.

### API (Runtime)

N/A — Arch AI runs entirely in Studio.

### API (Studio)

**Project-scoped (IN_PROJECT sessions)** — auth: `withRouteHandler({ requireProject: true, permissions: 'arch:traces:read' }, handler)` from `apps/studio/src/lib/route-handler.ts`:

| Method | Path                                                                          | Purpose                                                    |
| ------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------- |
| GET    | `/api/projects/[id]/arch-ai/traces/sessions`                                  | List sessions with summary stats for project               |
| GET    | `/api/projects/[id]/arch-ai/traces/sessions/[sessionId]`                      | Full span tree for one session                             |
| GET    | `/api/projects/[id]/arch-ai/traces/sessions/[sessionId]/poll?sinceRevision=N` | Changed spans since revision N (incremental)               |
| GET    | `/api/projects/[id]/arch-ai/traces/spans/[spanId]`                            | Single span detail                                         |
| GET    | `/api/projects/[id]/arch-ai/traces/stats`                                     | Aggregate stats (tokens, cost, errors, by model, by phase) |

**User-scoped (ONBOARDING sessions)** — auth: `withRouteHandler({}, handler)` (default `requireAuth`); results filtered by `userId` from the authenticated context:

| Method | Path                                                                | Purpose                                      |
| ------ | ------------------------------------------------------------------- | -------------------------------------------- |
| GET    | `/api/arch-ai/traces/onboarding/sessions`                           | List current user's onboarding sessions      |
| GET    | `/api/arch-ai/traces/onboarding/sessions/[id]`                      | Full span tree for one onboarding session    |
| GET    | `/api/arch-ai/traces/onboarding/sessions/[id]/poll?sinceRevision=N` | Changed spans since revision N (incremental) |
| GET    | `/api/arch-ai/traces/onboarding/spans/[id]`                         | Single span detail                           |

All routes return 404 (not 403) on cross-scope access — `withRouteHandler`'s project-access check runs before permissions precisely to prevent existence leakage.

**Legacy `/api/arch-ai/audit-logs/*` routes**: Remain in place during rollout so historical data in `arch_audit_logs` is still queryable. When `NEXT_PUBLIC_FEATURE_ARCH_TRACE_EXPLORER=true` is the default for all tenants (post-BETA), these legacy routes are removed in the same PR that deletes `packages/arch-ai/src/audit/`. Tracked as a post-v1 cleanup step (see GAP-004).

### Admin Portal

Trace Explorer lives inside the workspace-level arch settings page. No separate admin portal page.

### Channel / SDK / Voice / A2A / MCP Integration

N/A — Not channel-aware. Arch AI trace data is internal operational telemetry.

---

## 9. Data Model

### Collections / Tables

```text
Collection: arch_trace_spans
Fields:
  - _id: string (uuid7)
  - traceId: string (required)          # = sessionId
  - spanId: string (required, unique)
  - parentSpanId: string | null
  - name: string (required)
  - status: string (required, enum: running | completed | error, default: running)
  - startTime: Date (required)
  - endTime: Date | null
  - durationMs: number | null
  - events: [Mixed]                     # trace events emitted during span lifetime
  - attributes: Map<string, string>     # arch-specific + standard attrs (llm.model, tool.name, etc.)
  - tenantId: string (required)
  - userId: string (required)
  - sessionId: string (required)
  - projectId: string | null            # null for ONBOARDING
  - revision: number (required, default: 0)  # from arch_trace_sessions counter
  - expiresAt: Date (required)           # pre-computed at insert: now + (raw ? 7d : 90d)
  - createdAt: Date (auto)
  - updatedAt: Date (auto)

Indexes:
  - { tenantId: 1, projectId: 1, sessionId: 1, startTime: 1 }   # project tree fetch
  - { tenantId: 1, projectId: 1, sessionId: 1, revision: 1 }    # project poll
  - { tenantId: 1, userId: 1, sessionId: 1, startTime: 1 }      # onboarding tree fetch
  - { tenantId: 1, userId: 1, sessionId: 1, revision: 1 }       # onboarding poll
  - { spanId: 1 } unique                                         # always combined with scope in query
  - { expiresAt: 1 } TTL expireAfterSeconds: 0                   # MongoDB deletes docs when expiresAt < now
```

**TTL strategy note**: MongoDB supports only one TTL index per collection. The standard pattern for per-document variable expiry is to pre-compute `expiresAt = now + ttl` at insert time and index `{ expiresAt: 1 } TTL 0`. This lets default spans use `now + 90d` and raw-capture spans use `now + 7d` from a single index. `MongoWritePipeline` sets `expiresAt` based on `ARCH_TRACE_RAW_PAYLOADS` and the `trace.rawCapture` attribute at write time.

````

```text
Collection: arch_trace_sessions
Fields:
  - sessionId: string (required, unique)
  - tenantId: string (required)
  - userId: string (required)
  - projectId: string | null
  - revision: number (required, default: 0)  # monotonic, session-wide cursor
  - createdAt: Date (auto)
  - updatedAt: Date (auto)

Indexes:
  - { sessionId: 1 } unique
  - { tenantId: 1, projectId: 1 }
  - { tenantId: 1, userId: 1 }
````

### Key Relationships

- **ArchSession** (1:1) — session record stores `name` (from first user message) and lifecycle state. `sessionId` is the join key to the trace's `traceId`. No foreign key constraint — sessions may be archived while trace spans remain until TTL.
- **ArchJournal** (parallel, no FK) — semantic decision log at a coarser granularity. Both indexed by `sessionId`; no shared writes.
- **Workspace/Tenant** — every query scoped by `tenantId`. Cross-tenant access returns 404 via scoped route filters.
- **Project** — IN_PROJECT spans include `projectId`; cross-project access returns 404.
- **User** — ONBOARDING spans include `userId` with `projectId: null`; cross-user access returns 404.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                             | Purpose                                                                                                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/arch-ai/src/tracing/arch-event-types.ts`               | New arch-specific `TraceEventType` extensions + data interfaces                                                                       |
| `packages/arch-ai/src/tracing/arch-tracer.ts`                    | `ArchTracer` implements `Tracer` from shared-observability with arch conveniences                                                     |
| `packages/arch-ai/src/tracing/arch-span-attributes.ts`           | Attribute key constants + helpers                                                                                                     |
| `packages/arch-ai/src/tracing/redaction.ts`                      | `ArchRedactionBoundary` — wraps `WritePipeline`, scrubs before forward                                                                |
| `packages/shared-kernel/src/model-pricing.ts`                    | REUSED — `estimateCost()` + `MODEL_PRICING` map (no new file; if a model is missing, add it here so runtime and arch-ai both benefit) |
| `packages/arch-ai/src/tracing/providers/mongo-write-pipeline.ts` | `MongoWritePipeline` — buffered, ordered bulkWrite, session revision                                                                  |
| `packages/arch-ai/src/tracing/providers/mongo-trace-reader.ts`   | `MongoTraceReader` — scoped queries, returns observatory Span records                                                                 |
| `packages/arch-ai/src/tracing/factory.ts`                        | `createArchTracer()` / `createArchTraceReader()` — provider resolver                                                                  |
| `packages/arch-ai/src/tracing/index.ts`                          | Public API                                                                                                                            |
| `packages/observatory/src/schema/trace-events.ts`                | MODIFIED — additive: `arch_*` event types                                                                                             |
| `packages/database/src/models/arch-trace-span.model.ts`          | Mongoose model for `arch_trace_spans`                                                                                                 |
| `packages/database/src/models/arch-trace-session.model.ts`       | Mongoose model for `arch_trace_sessions` (revision counter)                                                                           |

### Routes / Handlers

| File                                                                                      | Purpose                                                                                  |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `apps/studio/src/app/api/projects/[id]/arch-ai/traces/sessions/route.ts`                  | Project-scoped session list (`ctx.params.id` = projectId)                                |
| `apps/studio/src/app/api/projects/[id]/arch-ai/traces/sessions/[sessionId]/route.ts`      | Project tree fetch                                                                       |
| `apps/studio/src/app/api/projects/[id]/arch-ai/traces/sessions/[sessionId]/poll/route.ts` | Project incremental poll                                                                 |
| `apps/studio/src/app/api/projects/[id]/arch-ai/traces/spans/[spanId]/route.ts`            | Project span detail                                                                      |
| `apps/studio/src/app/api/projects/[id]/arch-ai/traces/stats/route.ts`                     | Project aggregate stats                                                                  |
| `apps/studio/src/app/api/arch-ai/traces/onboarding/sessions/route.ts`                     | Onboarding session list                                                                  |
| `apps/studio/src/app/api/arch-ai/traces/onboarding/sessions/[id]/route.ts`                | Onboarding tree fetch                                                                    |
| `apps/studio/src/app/api/arch-ai/traces/onboarding/sessions/[id]/poll/route.ts`           | Onboarding incremental poll                                                              |
| `apps/studio/src/app/api/arch-ai/traces/onboarding/spans/[id]/route.ts`                   | Onboarding span detail                                                                   |
| `apps/studio/src/app/api/arch-ai/sessions/route.ts`                                       | MODIFIED — create root span at session creation                                          |
| `apps/studio/src/app/api/arch-ai/message/route.ts`                                        | MODIFIED — wire `ArchTracer` through execution chain (phase, turn, llm_call, tool spans) |

### UI Components

| File                                                                       | Purpose                                                                            |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `apps/studio/src/components/arch-settings/TraceExplorer.tsx`               | Top-level container, master-detail layout                                          |
| `apps/studio/src/components/arch-settings/TraceSessionList.tsx`            | Left panel session list                                                            |
| `apps/studio/src/components/arch-settings/TraceSessionCard.tsx`            | Session card with stats                                                            |
| `apps/studio/src/components/arch-settings/TraceTree.tsx`                   | Expandable span tree (uses `TraceTree` from observatory)                           |
| `apps/studio/src/components/arch-settings/TraceTreeNode.tsx`               | Single node with expand/collapse + status + metrics                                |
| `apps/studio/src/components/arch-settings/SpanDetailPanel.tsx`             | Bottom detail panel, renders by span type                                          |
| `apps/studio/src/components/arch-settings/spans/LLMCallDetail.tsx`         | LLM-specific detail view                                                           |
| `apps/studio/src/components/arch-settings/spans/ToolExecutionDetail.tsx`   | Tool-specific detail view                                                          |
| `apps/studio/src/components/arch-settings/spans/PhaseTransitionDetail.tsx` | Phase transition detail view                                                       |
| `apps/studio/src/components/arch-settings/SpanMetricCard.tsx`              | Reusable metric card                                                               |
| `apps/studio/src/store/arch-trace-store.ts`                                | Zustand store (sessions, spanMap, maxRevision per session, selected span, filters) |
| `apps/studio/src/components/admin/ArchAuditLogsTab.tsx`                    | DEPRECATED — removed when feature flag on                                          |

### Jobs / Workers / Background Processes

| File | Purpose                                                                                |
| ---- | -------------------------------------------------------------------------------------- |
| N/A  | No background jobs. TTL index handles retention. Emitter flushes in-process every 2 s. |

### Tests

| File                                                                             | Type        | Coverage Focus                                                                        |
| -------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------- |
| `packages/arch-ai/src/tracing/__tests__/arch-tracer.test.ts`                     | unit        | ArchTracer lifecycle, AsyncLocalStorage parent propagation, convenience methods       |
| `packages/arch-ai/src/tracing/__tests__/redaction.test.ts`                       | unit        | Secret/PII scrubbing, truncation, raw-mode tagging                                    |
| `packages/arch-ai/src/tracing/__tests__/mongo-write-pipeline.test.ts`            | unit        | span_start/update/end, upsert fallback, revision assignment (against in-memory Mongo) |
| `packages/arch-ai/src/tracing/__tests__/error-bubbling.test.ts`                  | unit        | Status bubbling up parent chain                                                       |
| `packages/database/src/__tests__/arch-trace-span.model.test.ts`                  | unit        | Schema, indexes, TTL                                                                  |
| `packages/database/src/__tests__/arch-trace-session.model.test.ts`               | unit        | Revision counter schema                                                               |
| `apps/studio/src/__tests__/arch-ai/traces-project-scoped.integration.test.ts`    | integration | Project routes, 404 on cross-project                                                  |
| `apps/studio/src/__tests__/arch-ai/traces-onboarding-scoped.integration.test.ts` | integration | Onboarding routes, 404 on cross-user                                                  |
| `apps/studio/src/__tests__/arch-ai/traces-poll.integration.test.ts`              | integration | Incremental poll with revision cursor, revision ordering                              |
| `apps/studio/e2e/arch-trace-explorer.spec.ts`                                    | e2e         | Full flow: run session → open UI → see tree → inspect span                            |

---

## 11. Configuration

### Environment Variables

| Variable                                  | Default | Description                                                          |
| ----------------------------------------- | ------- | -------------------------------------------------------------------- |
| `ARCH_TRACE_TTL_DAYS`                     | `90`    | Retention period in days for trace spans (default mode)              |
| `ARCH_TRACE_RAW_TTL_DAYS`                 | `7`     | Shorter TTL for spans written in raw-payload mode                    |
| `ARCH_TRACE_BUFFER_SIZE`                  | `50`    | Flush threshold for the in-memory buffer                             |
| `ARCH_TRACE_FLUSH_INTERVAL_MS`            | `2000`  | Timer-based flush interval                                           |
| `ARCH_TRACE_ENABLED`                      | `true`  | Kill switch for trace emission                                       |
| `ARCH_TRACE_RAW_PAYLOADS`                 | `false` | Opt-in: store full scrubbed input/output (still secret/PII-scrubbed) |
| `ARCH_TRACE_PROVIDER`                     | `mongo` | Active `WritePipeline` provider (future: `clickhouse`, `otel`)       |
| `NEXT_PUBLIC_FEATURE_ARCH_TRACE_EXPLORER` | `false` | UI rollout feature flag                                              |

### Runtime Configuration

No per-project or per-tenant configuration in v1. All settings are env-var-driven.

### DSL / Agent IR / Schema

N/A — Does not affect the ABL DSL, Agent IR, or compiler schema.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant isolation  | Every span query includes an **explicit `tenantId` filter** derived from the authenticated context. Studio does not register an ALS tenant-context provider, so the Mongoose `tenantIsolationPlugin` is defense-in-depth only — route handlers must always include `{ tenantId }` in every filter. (See `apps/studio/agents.md` Studio ALS caveat.) Cross-tenant access returns 404 (not 403). Tenant-deletion cascade runs `ArchTraceSpan.deleteMany({ tenantId })` + `ArchTraceSession.deleteMany({ tenantId })`. |
| Project isolation | Project-scoped spans include `projectId`. Project routes use `withRouteHandler({ requireProject: true, permissions: 'arch:traces:read' }, handler)` AND filter every query by `{ tenantId, projectId }`. Cross-project access returns 404 (existence leakage prevented because `requireProject` check runs before permission check).                                                                                                                                                                                |
| User isolation    | Onboarding spans include `userId` with `projectId: null`. Onboarding routes filter every query by `{ tenantId, userId, projectId: null }`. Cross-user access returns 404. Workspace admins can see project-scoped traces but NOT other users' onboarding traces.                                                                                                                                                                                                                                                    |

### Security & Compliance

- **Auth**: Project routes wrap handlers with `withRouteHandler({ requireProject: true, permissions: 'arch:traces:read' }, handler)`. Onboarding routes wrap with `withRouteHandler({}, handler)` (uses `requireAuth` internally) and derive `userId` from `ctx.user.id` to filter by `{ tenantId, userId, projectId: null }`.
- **Secret scrubbing**: All payloads pass through `ArchRedactionBoundary` before reaching storage — uses `scrubSecrets()` (regex-based API keys, tokens, PEM keys) and `scrubTraceEvent()` from `@abl/compiler`.
- **PII scrubbing**: `redactPII()` detects and masks email, phone, SSN, credit card. Applied to `userMessage` in turn spans and tool input/output.
- **Raw-mode opt-in**: When `ARCH_TRACE_RAW_PAYLOADS=true`, full input/output is stored (still secret- and PII-scrubbed). Spans are tagged with `trace.rawCapture=true` and subject to shorter TTL. UI shows a warning banner on raw-mode spans.
- **Default-safe**: Without raw mode, only token counts, finish reason, and one-line summaries are stored for LLM calls. Tool input/output is truncated to a 4KB summary.
- **No cross-scope leakage**: Scoped MongoDB queries at every endpoint; span detail lookup includes scope fields in the query, not just post-fetch verification.

### Performance & Scalability

- **Write impact**: Zero SSE latency. `MongoWritePipeline` buffers in memory, flushes every 2 s or at 50-span threshold. `bulkWrite({ ordered: true })` commits per-session writes atomically.
- **Read performance**: All query patterns have covering indexes. Tree fetch returns up to 2,000 spans per session. Poll response capped at 500 spans; continuation revision returned for larger deltas.
- **Volume**: 5K–50K spans/day per tenant is the expected range (comparable to arch-audit-logs volume). MongoDB handles without sharding.
- **Memory**: In-memory buffer capped at 100 spans (~100KB). Flush on timer, threshold, or stream end.
- **Revision counter contention**: Single-writer-per-session guarantee (SSE request lifecycle + session state machine) means `findOneAndUpdate` on `arch_trace_sessions` is effectively uncontended. Worst-case `$inc` latency is ~5 ms.

### Reliability & Failure Modes

- **Fire-and-forget writes**: Pipeline errors are logged via `createLogger` but never propagated to the SSE stream or caller. Spans may be lost on write failure — this is best-effort telemetry.
- **Missing `span_start`**: `span_end` is an upsert with `$setOnInsert`. If `span_start` was dropped, `span_end` creates the document with all required fields. Span appears at completion, not while running — acceptable for debugging.
- **MongoDB down**: Emitter flush fails silently. Buffered spans are lost when the request ends. No WAL, no retry.
- **Partial flush failure**: Ordered `bulkWrite` stops at first error; remaining spans in the batch are retried on the next flush. Revision numbers claimed for failed writes become gaps — harmless because the poll cursor is `$gt`.
- **Span cap**: Beyond 2,000 spans per session, the tracer emits a single `arch_system_event` span with status `error` (attribute `arch.systemEvent = 'span_cap_exceeded'`) and drops further emissions. Prevents runaway tree size.
- **Error bubbling race**: Parent status upgrade is fire-and-forget — if a child's error bubbles at the same moment the parent is ending, the last write wins. In practice, `span.end()` sets final status and the bubble upgrade either no-ops (parent already error) or is the final state.

### Observability

- **Structured logging**: `createLogger('arch-ai:tracing')` for pipeline operations (flush success/failure, buffer stats, revision claim, upsert fallback).
- **No self-referential tracing**: The trace pipeline does NOT emit spans about its own operations. Avoids infinite recursion.
- **Metrics (future)**: Could expose buffer size, flush latency, revision-counter latency, write error rate, redaction hits as Prometheus metrics.

### Data Lifecycle

- **Retention**: 90-day default; raw-mode spans write `expiresAt = now + 7d` via `ARCH_TRACE_RAW_TTL_DAYS`. All enforced by the single `{ expiresAt: 1 }` TTL index (pre-computed at insert).
- **Tenant deletion**: Cascade hook must run `ArchTraceSpan.deleteMany({ tenantId })` and `ArchTraceSession.deleteMany({ tenantId })`.
- **User erasure**: On user deletion, `ArchTraceSpan.updateMany({ userId }, { $set: { userId: 'REDACTED' } })` anonymizes the actor for GDPR compliance.
- **Session archival**: Arch session archival does NOT cascade to trace spans. Spans remain until TTL expires. Acceptable by design.
- **No migration**: New collections. Old `arch_audit_logs` remain; they TTL-expire independently.

---

## 13. Delivery Plan / Work Breakdown

1. **Package scaffolding and observatory extensions**
   1.1 Add `arch_*` event types to `packages/observatory/src/schema/trace-events.ts` (additive) and corresponding data interfaces
   1.2 Verify all required exports from `@agent-platform/shared-observability/tracing` (`Tracer`, `Span`, `SpanContext`, `WritePipeline`, `generateTraceId`, `generateSpanId`)
   1.3 Create `packages/arch-ai/src/tracing/` module skeleton (index, types, interfaces)

2. **Data model**
   2.1 Create `ArchTraceSpan` Mongoose model in `packages/database` with schema, 4 scoped indexes + unique `spanId` + TTL
   2.2 Create `ArchTraceSession` Mongoose model with unique `sessionId` and revision counter
   2.3 Unit tests for both models (schema, indexes, TTL)
   2.4 Register tenant-deletion cascade in the same place as eventstore cascades

3. **Tracing core**
   3.1 `ArchTracer` implementing `Tracer` with AsyncLocalStorage parent propagation and arch-convenience methods (`startPhaseSpan`, `startTurnSpan`, `startLLMCallSpan`, `startToolSpan`)
   3.2 `ArchSpanImpl` implementing write-side `Span` with attribute buffering and `span_end` emission
   3.3 `ArchRedactionBoundary` — wraps `WritePipeline`, applies `scrubSecrets()`, `scrubTraceEvent()`, `redactPII()`, truncation
   3.4 Integrate `estimateCost()` from `@agent-platform/shared-kernel` for `llm.estimatedCost` attribute (add any missing models to `MODEL_PRICING` in `packages/shared-kernel/src/model-pricing.ts` rather than creating a local map)
   3.5 Factory (`createArchTracer`, `createArchTraceReader`) with provider resolution
   3.6 Unit tests (lifecycle, redaction, error bubbling)

4. **MongoDB provider**
   4.1 `MongoWritePipeline` — buffered writes, `span_start` INSERT, `span_update` batched UPDATE, `span_end` UPSERT with `$setOnInsert`, atomic revision claim
   4.2 `MongoTraceReader` — scoped query methods (project + onboarding variants for list, tree, poll, span-detail, stats)
   4.3 Unit tests with in-memory MongoDB (mongodb-memory-server)

5. **Emission wiring (execution chain)**
   5.1 Create `ArchTracer` at session creation (`POST /api/arch-ai/sessions`); emit root session span with placeholder name
   5.2 Backfill root span name on first user message (session service)
   5.3 Wire `ArchTracer` through message route execution chain (phase spans, turn spans)
   5.4 Instrument `VercelLLMStreamClient` with `onStepFinish` for `llm_call` spans (attributes: model, tokens, cost, finishReason)
   5.5 Instrument tool executor for `tool_execution` spans (attributes: name, input summary, output summary, retries, resultStatus)
   5.6 Instrument `transitionPhase()` (free function in `packages/arch-ai/src/coordinator/phase-machine.ts:95`) to emit `arch_phase_transition` events and bracket `phase` spans
   5.7 Wire catch blocks to call `span.setStatus('error', msg); span.end()` on exceptions
   5.8 Enforce 2,000-span cap per session: emit a single `arch_system_event` span with status `error` and `arch.systemEvent = 'span_cap_exceeded'`, then drop further emissions for that session

6. **API routes (project-scoped)**
   6.1 `GET /api/projects/:projectId/arch-ai/traces/sessions`
   6.2 `GET /api/projects/:projectId/arch-ai/traces/sessions/:id`
   6.3 `GET /api/projects/:projectId/arch-ai/traces/sessions/:id/poll?sinceRevision=N`
   6.4 `GET /api/projects/:projectId/arch-ai/traces/spans/:id` (scoped query, no post-verify)
   6.5 `GET /api/projects/:projectId/arch-ai/traces/stats`
   6.6 Register `arch:traces:read` permission in `apps/studio/src/lib/permissions.ts` and wire it into the default workspace-owner / admin / project-member role grants
   6.7 Integration tests (including cross-project 404)

7. **API routes (onboarding-scoped)**
   7.1 `GET /api/arch-ai/traces/onboarding/sessions`
   7.2 `GET /api/arch-ai/traces/onboarding/sessions/:id`
   7.3 `GET /api/arch-ai/traces/onboarding/sessions/:id/poll?sinceRevision=N`
   7.4 `GET /api/arch-ai/traces/onboarding/spans/:id` (scoped query)
   7.5 Integration tests (including cross-user 404)

8. **UI (Trace Explorer)**
   8.1 `useArchTraceStore` Zustand store (sessions, spanMap, maxRevision per session, selected span, filters, poll action)
   8.2 `TraceExplorer` container with feature flag gating, master-detail layout
   8.3 `TraceSessionList` + `TraceSessionCard` — sorted recency, named from first message, status + stats
   8.4 `TraceTree` + `TraceTreeNode` — expandable tree using observatory `TraceTree`
   8.5 `SpanDetailPanel` + type-specific views (`LLMCallDetail`, `ToolExecutionDetail`, `PhaseTransitionDetail`) + `SpanMetricCard`
   8.6 Auto-poll at 5 s while active session
   8.7 Raw-capture warning banner on spans with `trace.rawCapture=true`
   8.8 Replace `ArchAuditLogsTab` mount point on arch settings page (behind feature flag)

9. **E2E validation**
   9.1 Run a full IN_PROJECT session with LLM calls and tool executions; verify tree renders correctly
   9.2 Verify error bubbling: force a tool failure, verify parent spans show error status
   9.3 Verify polling: open UI during active session, verify spans appear live
   9.4 Verify scoping: attempt cross-project and cross-user access, verify 404s
   9.5 Verify redaction: seed a span with synthetic secret, verify storage contains `[REDACTED]`

---

## 14. Success Metrics

| Metric                                              | Baseline                                              | Target                                                            | How Measured                                          |
| --------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------- |
| Time to diagnose a failed Arch session              | 15-30 min (audit log trawl + server log correlate)    | < 2 min (click session → expand phase → see red span)             | Developer task timing                                 |
| Emitter coverage (spans captured / events expected) | ~10% (only session_created today — emitter not wired) | 100% of LLM calls, tool executions, phase transitions             | Span count vs instrumented call sites                 |
| Cross-scope access attempts returning 404           | N/A                                                   | 100%                                                              | Integration test matrix (project × user permutations) |
| Raw payload leakage in default mode                 | N/A                                                   | 0 secret patterns detected in stored spans                        | Automated scanning of a test session's stored spans   |
| SSE latency regression                              | Current baseline                                      | < 1 ms increase at p95                                            | Measure SSE first-byte-time with/without tracer       |
| Session span backfill correctness                   | N/A                                                   | 100% of non-empty sessions have root span `name` != "New Session" | Aggregation over `arch_trace_spans` after test runs   |
| Admin page load                                     | N/A                                                   | < 1 s for session list, < 2 s for tree                            | Frontend performance measurement                      |

---

## 15. Open Questions

1. Should the `arch:traces:read` permission be granted by default to all project roles, or require opt-in? Default recommendation: granted to OWNER/ADMIN by default; MEMBER requires explicit grant at workspace level. Needs platform-auth team review before ALPHA promotion.
2. Should tenants be able to override `ARCH_TRACE_TTL_DAYS` per-tenant (e.g., compliance regimes requiring shorter retention)? Deferred — global env var sufficient for v1.
3. Should raw-capture mode be a tenant-level toggle, user-level toggle, or global env var? Current design is global env var. Tenant-level might be required for GDPR regions — flagged for future review.
4. Should the `arch_trace_spans` TTL cascade-trigger a `span_end` for still-running spans before deletion? Currently `running` spans would orphan — expected behavior but worth confirming.
5. Should `stats` endpoint include per-user breakdown for project-scoped routes (visible to workspace admins), or only aggregate? Default: aggregate only; per-user breakdown deferred pending privacy review.

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                                                                                                                                                                                                                                                  | Severity | Status                                                                       |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------- |
| GAP-001 | Raw-capture mode is global (env var). Tenants cannot opt in/out per workspace.                                                                                                                                                                                                                                                                                                               | Medium   | Open (noted in Open Q3)                                                      |
| GAP-002 | Span cap at 2,000 per session. Beyond this, spans are dropped with a warning.                                                                                                                                                                                                                                                                                                                | Low      | Mitigated (warning span emitted; design target covers 4× typical)            |
| GAP-003 | No backfill of existing `arch_audit_logs` data into the new span schema. Historical data is read-only via direct DB.                                                                                                                                                                                                                                                                         | Low      | Open (by design; 90-day TTL handles rollover)                                |
| GAP-004 | Legacy `ArchAuditLogsTab` component and `/api/arch-ai/audit-logs/*` HTTP routes + `packages/arch-ai/src/audit/` source are hidden behind the feature flag but not deleted in v1. They remain so historical data in `arch_audit_logs` stays queryable during the 90-day TTL rollover. Full deletion (component, routes, emitter source, MongoDB collection) is a single post-BETA cleanup PR. | Low      | Open (planned post-v1 cleanup)                                               |
| GAP-005 | `MongoWritePipeline` is single-writer-per-session; if the concurrency model relaxes in the future (e.g., a background worker emits spans for the same session), revision monotonicity will need a stricter lock or Mongo transactions.                                                                                                                                                       | Medium   | Open (tracked in design §"Edge case: concurrent requests")                   |
| GAP-006 | Error bubbling is asynchronous. A child error emitted concurrently with a parent end can race. Last write wins.                                                                                                                                                                                                                                                                              | Low      | Mitigated (end-state is usually correct; acceptable for debugging telemetry) |
| GAP-007 | No observatory-level consolidation of the read API — arch-ai owns `MongoTraceReader`. Runtime trace queries remain separate. Future consolidation would require a cross-package refactor.                                                                                                                                                                                                    | Low      | Open (future platform work)                                                  |
| GAP-008 | `arch:traces:read` permission semantics (who gets it by default) not finalized — flagged in Open Q1.                                                                                                                                                                                                                                                                                         | Medium   | Open (blocker for BETA)                                                      |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                                              | Coverage Type | Status     | Test File / Note                                                             |
| --- | ----------------------------------------------------------------------------------------------------- | ------------- | ---------- | ---------------------------------------------------------------------------- |
| 1   | ArchTracer lifecycle (startSpan → setAttribute → end) and AsyncLocalStorage parent propagation        | unit          | NOT TESTED | Planned: `packages/arch-ai/src/tracing/__tests__/arch-tracer.test.ts`        |
| 2   | Error bubbling: child.setStatus('error'); end() propagates to parent                                  | unit          | NOT TESTED | Planned: `arch-tracer.test.ts` or dedicated `error-bubbling.test.ts`         |
| 3   | Redaction: secret patterns scrubbed, PII scrubbed, 4 KB truncation                                    | unit          | NOT TESTED | Planned: `redaction.test.ts`                                                 |
| 4   | `span_end` upsert recovers dropped `span_start`                                                       | unit          | NOT TESTED | Planned: `mongo-write-pipeline.test.ts` (mongodb-memory-server)              |
| 5   | Atomic revision assignment with ordered `bulkWrite` produces monotonic revisions                      | unit          | NOT TESTED | Planned: `mongo-write-pipeline.test.ts`                                      |
| 6   | Mongoose schemas validate required fields, TTL index, scope indexes                                   | unit          | NOT TESTED | Planned: `arch-trace-span.model.test.ts`, `arch-trace-session.model.test.ts` |
| 7   | Project tree route returns scoped spans; cross-project returns 404                                    | integration   | NOT TESTED | Planned: `traces-project-scoped.integration.test.ts`                         |
| 8   | Onboarding tree route returns user-scoped spans; cross-user returns 404                               | integration   | NOT TESTED | Planned: `traces-onboarding-scoped.integration.test.ts`                      |
| 9   | Poll endpoint returns only revision > N and respects scope filter                                     | integration   | NOT TESTED | Planned: `traces-poll.integration.test.ts`                                   |
| 10  | Span detail endpoint uses scoped query (no post-verify pattern)                                       | integration   | NOT TESTED | Planned: `traces-span-detail.integration.test.ts`                            |
| 11  | Stats endpoint aggregates tokens, cost, errors by model and phase                                     | integration   | NOT TESTED | Planned: `traces-stats.integration.test.ts`                                  |
| 12  | Full emit → store → tree render flow with real Arch AI session                                        | e2e           | NOT TESTED | Planned: `arch-trace-explorer.spec.ts`                                       |
| 13  | UI renders live in-flight span during active session                                                  | e2e           | NOT TESTED | Planned: `arch-trace-explorer.spec.ts`                                       |
| 14  | Error injection: force tool timeout, verify error bubbles in UI                                       | e2e           | NOT TESTED | Planned: `arch-trace-explorer.spec.ts`                                       |
| 15  | Feature flag: with flag off, legacy `ArchAuditLogsTab` renders; with flag on, `TraceExplorer` renders | e2e           | NOT TESTED | Planned: `arch-trace-explorer.spec.ts`                                       |

### Testing Notes

Per CLAUDE.md Test Architecture rules:

- **No `vi.mock()` of `@agent-platform/*` or `@abl/*`** — redaction and tracer tests use dependency injection.
- **E2E tests hit real routes** — no mocked API handlers. Real MongoDB (mongodb-memory-server for integration; dev Mongo for e2e).
- **No direct DB queries from e2e** — assertions go through API endpoints.
- **Pure function tests**: redaction, revision arithmetic, and status mapping are extracted as pure functions and tested without mocks.

> Full testing details: [../testing/arch-trace-explorer.md](../testing/arch-trace-explorer.md)

---

## 18. References

- Brainstorm design doc (historical reference — originating design): [`docs/superpowers/specs/2026-04-14-arch-trace-explorer-design.md`](../superpowers/specs/2026-04-14-arch-trace-explorer-design.md). Note: this feature spec is the authoritative source for implementation. The brainstorm doc contains earlier drafts of auth/permission patterns (`requireProjectPermission`, `PhaseMachine.transition()`) that were corrected in this spec to match actual Studio APIs. When in doubt, follow this feature spec.
- Predecessor: [Arch AI Audit Logs](arch-audit-logs.md) (ALPHA — superseded)
- Predecessor HLD: [`docs/specs/arch-audit-logs.hld.md`](../specs/arch-audit-logs.hld.md)
- Observatory trace contracts: `packages/observatory/src/schema/trace-events.ts`, `packages/observatory/src/schema/spans.ts`
- Shared tracing contracts: `packages/shared-observability/src/tracing/`
- Redaction utilities: `packages/compiler/src/platform/constructs/executors/scrub-patterns.ts`, `packages/compiler/src/platform/constructs/executors/trace-scrubber.ts`, `packages/compiler/src/platform/security/pii-detector.ts`
- Runtime reference implementation: `apps/runtime/src/services/tracing/` (`TracerImpl`, `SpanImpl`, `WritePipelineImpl`)
- CLAUDE.md: Core Invariants §1 (Resource Isolation), §4 (Traceability), §5 (Compliance)
- Platform principles skill: `platform-principles`
- Related: [Arch AI Assistant](arch-ai-assistant.md), [Model Hub](model-hub.md), [Arch AI Tool Lifecycle](arch-tool-lifecycle.md)
