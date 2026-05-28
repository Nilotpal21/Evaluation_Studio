# HLD: Arch AI Trace Explorer

**Feature Spec**: `docs/features/arch-trace-explorer.md`
**Test Spec**: `docs/testing/arch-trace-explorer.md`
**Status**: DRAFT
**Author**: Platform team
**Date**: 2026-04-15
**Ticket**: ABLP-162
**Supersedes**: `docs/specs/arch-audit-logs.hld.md`

---

## 1. Problem Statement

Arch AI's existing audit log system (`arch-audit-logs`, ALPHA) captures 7 typed event categories but suffers from four structural gaps that block debugging and observability:

1. **Emitter not wired through execution** — `AuditLogEmitter` only emits at session creation; LLM calls, tool executions, phase transitions, and errors are not captured because the emitter is not passed down the execution chain (`sessions/route.ts:91-110` wires it, but `message/route.ts` never receives it).
2. **Flat events, no hierarchy** — audit logs are rows, so debuggers cannot reconstruct "which tool call happened inside which LLM response inside which turn inside which phase."
3. **No callstack view** — the timeline modal is chronologically flat; no tree, no nesting, no click-to-expand detail panels.
4. **Duplicate trace contract** — the platform has canonical trace contracts in `packages/observatory/` and `packages/shared-observability/tracing/` (verified fully exported at `packages/shared-observability/src/tracing/index.ts:6-18`). Arch-ai ignores both and uses a bespoke `AuditLogEmitter`, blocking any future migration to OpenTelemetry/ClickHouse without a full rewrite.

This HLD specifies a hierarchical trace explorer that replaces the flat audit log system. It renders every Arch AI session as a callstack (Session → Phase → Turn → LLM Call → Tool Execution), implements the canonical platform `Tracer` + `WritePipeline` contracts, and persists spans to MongoDB via a pluggable provider so future swaps to ClickHouse / OpenTelemetry require zero execution-code changes.

---

## 2. Alternatives Considered

### Option A: Extend `arch-audit-logs` with a `parentId` column

- **Description**: Add `parentId`, `spanId`, `traceId`, `startTime`, `endTime`, `status` fields to the existing `arch_audit_logs` collection; retrofit the UI with a tree-builder over the same documents.
- **Pros**: Smallest surface change; reuses the emitter; no new module.
- **Cons**: Still coupled to the bespoke `AuditLogEmitter` API — does **not** satisfy FR-2 (canonical `Tracer` + `Span` contracts), FR-3 (`AsyncLocalStorage` parent propagation), or FR-7 (additive observatory event types). The duplicate-contract problem (problem statement bullet 4) persists; ClickHouse/OTel portability remains blocked.
- **Effort**: S
- **Verdict**: **Rejected** — re-entrenches the structural problem this feature exists to solve.

### Option B: Reuse runtime `TracerImpl` directly via cross-app import

- **Description**: Import `apps/runtime/src/services/tracing/*` (`TracerImpl`, `SpanImpl`, `WritePipelineImpl`) from Studio.
- **Pros**: Zero new code; battle-tested pattern.
- **Cons**: Runtime's `WritePipelineImpl` (`apps/runtime/src/services/tracing/write-pipeline.ts:23-107`) is hard-wired to `TraceStore`, `broadcastToSession`, and the ClickHouse EventStore — none of which exist in Studio. Importing would drag ClickHouse into Studio's deployment (violates feature spec §2 Non-Goals "Dual-emit to ClickHouse EventStore"). Also violates the app-separation rule: Studio must not depend on `apps/runtime/*`.
- **Effort**: S (but structurally wrong)
- **Verdict**: **Rejected** — couples Studio to runtime-specific sinks and infrastructure.

### Option C: New `packages/arch-ai/src/tracing/` module implementing shared contracts (**Recommended**)

- **Description**: Build a new module under `packages/arch-ai/src/tracing/` that implements `Tracer` + `WritePipeline` from `@agent-platform/shared-observability/tracing`, with arch-specific conveniences (`MongoWritePipeline`, `ArchRedactionBoundary`, `startPhaseSpan`/`startTurnSpan`/`startLLMCallSpan`/`startToolSpan`) and `AsyncLocalStorage` parent propagation. Mirrors the _pattern_ used by runtime (`apps/runtime/src/services/tracing/tracer.ts`) without coupling to its storage sinks.
- **Pros**: Satisfies FR-2, FR-3, FR-7; preserves the pluggable-storage property (feature spec §7 Plugin Architecture) — swapping to `ClickHouseWritePipeline` later is a provider addition, not an execution-code change; zero runtime-app coupling; matches the `Tracer` + `WritePipeline` contract validated in runtime.
- **Cons**: One new module (~10 files in `packages/arch-ai/src/tracing/`). New code requires careful rollout.
- **Effort**: M
- **Verdict**: **Recommended**.

### Option D: OpenTelemetry / OTLP exporter from day one

- **Description**: Ship with an OTel-compatible exporter; run an OTel collector in Studio's deployment and query spans from a collector-backed store.
- **Pros**: Industry standard; no custom data model.
- **Cons**: Requires new infrastructure (OTel collector in Studio's deployment); no Studio UI today speaks OTLP; W3C-compatible span IDs already give day-one portability without a collector. Feature spec §2 Non-Goals explicitly scopes this out: "Full OpenTelemetry export pipeline (W3C-compatible IDs are used, but no exporter in v1)."
- **Effort**: L (new infrastructure + schema migration)
- **Verdict**: **Rejected for v1** — out of scope; becomes viable post-v1 as a provider plugin under Option C.

### Recommendation: Option C — `packages/arch-ai/src/tracing/`

**Rationale**: C is the only option that satisfies FR-2/FR-3/FR-7 (canonical contracts), preserves pluggable storage (feature spec §7, future ClickHouse/OTel swap), and keeps Studio independent of runtime's deployment. A re-entrenches the very problem this feature exists to fix. B couples Studio to runtime's ClickHouse/EventStore. D is out of v1 scope. The pattern is already proven in `apps/runtime/src/services/tracing/` — we port the approach, not the code.

---

## 3. Architecture

### System Context Diagram

```
                 ┌────────────────────────────────────────────────────────────┐
                 │                    Studio (Next.js App Router)              │
                 │                                                            │
   User  ──────> │  POST /api/arch-ai/sessions     (create root span)         │
   (Chat)        │  POST /api/arch-ai/message      (turn + llm + tool spans)  │
                 │       │                                                    │
                 │       │   ArchTracer (AsyncLocalStorage)                   │
                 │       ▼                                                    │
                 │   ArchRedactionBoundary  ──> MongoWritePipeline            │
                 │                                    │                       │
   Admin ──────> │  GET /api/projects/:id/arch-ai/    │ buffered (2 s / 50)   │
   (Settings)    │     traces/... (project-scoped)    │                       │
                 │  GET /api/arch-ai/traces/          ▼                       │
                 │     onboarding/... (user-scoped)  ┌──────────────────┐     │
                 │       │                           │   MongoDB         │    │
                 │       ▼                           │  arch_trace_spans │    │
                 │  MongoTraceReader ─────────────>  │  arch_trace_      │    │
                 │  (scoped queries)                 │    sessions       │    │
                 │                                   │  (TTL 90d / 7d)   │    │
                 │                                   └──────────────────┘     │
                 └────────────────────────────────────────────────────────────┘

Future providers (out of v1 scope, but design supports):
   MongoWritePipeline  ──  can be swapped for  ──>  ClickHouseWritePipeline
                                                     OTelWritePipeline
   (same Tracer + WritePipeline contract; no execution-code change)
```

### Component Diagram

```
┌─ packages/shared-observability/src/tracing/  (EXISTING — no change) ────┐
│                                                                         │
│  tracer.ts       ── Tracer interface                                    │
│  span.ts         ── Span interface (write-side)                         │
│  span-context.ts ── SpanContext                                         │
│  write-pipeline.ts ── WritePipeline interface                           │
│  id.ts           ── generateTraceId / generateSpanId (W3C-compatible)   │
│  propagation.ts  ── injectTrace / extractTrace                          │
│  index.ts        ── all of the above re-exported (verified L6-18)       │
└─────────────────────────────────────────────────────────────────────────┘
                                │  implemented by
                                ▼
┌─ packages/arch-ai/src/tracing/  (NEW MODULE) ───────────────────────────┐
│                                                                         │
│  arch-event-types.ts      ── arch_phase_transition, arch_build_event,   │
│                              arch_gate_response, arch_session_event,    │
│                              arch_spec_update  (normal-path events),    │
│                              arch_system_event (emitted ONLY for        │
│                              span-cap-exceeded & system conditions      │
│                              per FR-22, not normal execution)           │
│  arch-span-attributes.ts  ── attribute key constants                    │
│                                                                         │
│  arch-tracer.ts           ── ArchTracer (implements Tracer)             │
│                              - AsyncLocalStorage parent propagation     │
│                              - startPhaseSpan / startTurnSpan /         │
│                                startLLMCallSpan / startToolSpan         │
│                              - error bubble-up                          │
│                                                                         │
│  redaction.ts             ── ArchRedactionBoundary                      │
│                              - wraps WritePipeline                      │
│                              - scrubSecrets + redactPII                 │
│                              - 4 KB truncation (default)                │
│                              - fail-closed ([REDACTION_FAILED])         │
│                                                                         │
│  providers/                                                             │
│    mongo-write-pipeline.ts ── buffered writes, revision claim,          │
│                               $setOnInsert upsert on span_end           │
│    mongo-trace-reader.ts  ── scoped reads (project + onboarding)        │
│                                                                         │
│  factory.ts               ── createArchTracer / createArchTraceReader   │
│                              - provider resolution                      │
│                              - kill-switch (ARCH_TRACE_ENABLED=false    │
│                                returns no-op tracer)                    │
│                                                                         │
│  index.ts                 ── public API                                 │
└─────────────────────────────────────────────────────────────────────────┘
                                │  used by
                                ▼
┌─ packages/arch-ai/src/coordinator/  (MODIFIED) ────────────────────────┐
│                                                                        │
│  phase-machine.ts (line 95: transitionPhase)  ── instrument            │
│    ── ends old phase span + startPhaseSpan + arch_phase_transition     │
└────────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─ apps/studio/  (MODIFIED + NEW ROUTES + NEW UI) ──────────────────────┐
│                                                                       │
│  MODIFIED:                                                            │
│    src/app/api/arch-ai/sessions/route.ts   ── create root span        │
│    src/app/api/arch-ai/message/route.ts    ── two streamText sites    │
│                                               (L422, L6836) + tool    │
│                                               executor wiring         │
│                                                                       │
│  NEW ROUTES (project-scoped):                                         │
│    src/app/api/projects/[id]/arch-ai/traces/sessions/route.ts         │
│    .../traces/sessions/[sessionId]/route.ts                           │
│    .../traces/sessions/[sessionId]/poll/route.ts                      │
│    .../traces/spans/[spanId]/route.ts                                 │
│    .../traces/stats/route.ts                                          │
│                                                                       │
│  NEW ROUTES (onboarding-scoped):                                      │
│    src/app/api/arch-ai/traces/onboarding/sessions/route.ts            │
│    .../traces/onboarding/sessions/[id]/route.ts                       │
│    .../traces/onboarding/sessions/[id]/poll/route.ts                  │
│    .../traces/onboarding/spans/[id]/route.ts                          │
│                                                                       │
│  NEW UI:                                                              │
│    components/arch-settings/TraceExplorer.tsx (master-detail)         │
│    components/arch-settings/TraceSessionList + SessionCard            │
│    components/arch-settings/TraceTree + TreeNode                      │
│    components/arch-settings/SpanDetailPanel + LLMCallDetail /         │
│      ToolExecutionDetail / PhaseTransitionDetail                      │
│    store/arch-trace-store.ts (Zustand)                                │
└───────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─ packages/observatory/src/schema/trace-events.ts  (MODIFIED — additive) ┐
│                                                                         │
│  L241-268: TraceEventType union — widened with new ArchTraceEventType   │
│            sub-union (no removals)                                      │
│  L276-464: ALL_TRACE_EVENT_TYPES runtime array — new string values      │
│            appended                                                     │
│  L538-561: TraceEventData union — optional arch-specific data shapes    │
│            (can defer to follow-up)                                     │
└─────────────────────────────────────────────────────────────────────────┘

┌─ packages/database/src/models/  (NEW MODELS) ──────────────────────────┐
│                                                                        │
│  arch-trace-span.model.ts    ── ArchTraceSpan Mongoose model           │
│                                 4 scoped indexes + TTL on expiresAt    │
│  arch-trace-session.model.ts ── ArchTraceSession (revision counter)    │
│                                                                        │
│  Tenant-deletion cascade:                                              │
│    ArchTraceSpan.deleteMany({ tenantId }) +                            │
│    ArchTraceSession.deleteMany({ tenantId })                           │
└────────────────────────────────────────────────────────────────────────┘

UNTOUCHED (hidden behind flag per GAP-004 — post-BETA cleanup):
   packages/arch-ai/src/audit/  (AuditLogEmitter + types)
   packages/database/src/models/arch-audit-log.model.ts
   apps/studio/src/app/api/arch-ai/audit-logs/*   — 4 production routes:
     - route.ts               (list)
     - summary/route.ts       (aggregate KPIs)
     - sessions/[id]/timeline/route.ts
     - cost-breakdown/route.ts
   (the _seed/ test-only route is excluded from this count)
   apps/studio/src/components/admin/ArchAuditLogsTab.tsx
```

### Data Flow — Write Path (Hot)

```
┌─ USER CHAT MESSAGE: POST /api/arch-ai/message ─────────────────────────┐
│                                                                        │
│  1. Route handler picks up request                                     │
│     (force-dynamic at line 14 — required for AsyncLocalStorage)        │
│                                                                        │
│  2. Session state machine: IDLE → ACTIVE (line 579)                    │
│     - Atomic transition; losing concurrent request → 409 SESSION_BUSY  │
│     - ArchTracer instance resolved from factory (per-session)          │
│     - Root span name backfilled from first user message (FR-17)        │
│                                                                        │
│  3. tracer.startSpan('turn')  ──┐                                      │
│                                  │ AsyncLocalStorage stores span       │
│                                  │ Nested startSpan() reads parent     │
│                                  │ via getStore()                      │
│  4. coordinator executes phase logic                                   │
│     (no phase transition this turn — phase span already active)        │
│                                                                        │
│  5. streamText({ model, messages, tools, onStepFinish, onStepStart }) │
│     two call sites: L422 (onboarding) + L6836 (BUILD) — both wired    │
│                                                                        │
│     5a. tracer.startSpan('llm_call') wrapping streamText              │
│     5b. onStepFinish({ usage, finishReason, response.modelId })       │
│         ── span.setAttribute('llm.model', modelId)                    │
│         ── span.setAttribute('llm.inputTokens', usage.promptTokens)   │
│         ── span.setAttribute('llm.outputTokens', usage.completionTok)│
│         ── span.setAttribute('llm.totalTokens', usage.totalTokens)    │
│         ── span.setAttribute('llm.finishReason', finishReason)        │
│         ── span.setAttribute('llm.estimatedCost',                    │
│                               estimateCost(model, in, out))           │
│         ── (import estimateCost from @agent-platform/shared-kernel)   │
│                                                                        │
│  6. Tool invocation (per tool call from LLM):                         │
│     6a. tracer.startSpan('tool_execution')                            │
│     6b. execute callback runs                                         │
│     6c. span.setAttribute('tool.name', ...)                           │
│         span.setAttribute('tool.callId', ...)                         │
│         span.setAttribute('tool.resultStatus', 'success'|'error'|...) │
│         span.setAttribute('tool.retryCount', n)                       │
│         span.setAttribute('tool.inputSummary', scrubbed, ≤4KB)        │
│     6d. If throw:                                                     │
│         span.setStatus('error', msg); span.end();                     │
│         → ArchTracer walks parents, upgrades each to 'error'          │
│           until root or ancestor already error (FR-11)                │
│                                                                        │
│  7. span.end() on each — emits span_end to WritePipeline              │
│                                                                        │
│  8. ArchRedactionBoundary.write(event):                               │
│     - if ARCH_TRACE_ENABLED=false: drop (no-op)                       │
│     - else: scrubSecrets + redactPII + truncate(4KB) ON ATTRIBUTES    │
│     - raw mode: skip 4KB truncation; still scrub secrets              │
│     - IF scrubber throws: fail CLOSED — replace value with            │
│       '[REDACTION_FAILED]' marker; emit span; log warning             │
│                                                                        │
│  9. MongoWritePipeline.write(event):                                  │
│     - span_start  → bufferedInsert (status='running', startTime)      │
│     - span_update → bufferedUpdate ($set attrs, $push events)         │
│     - span_end    → bufferedUpsert ($setOnInsert scope fields,       │
│                                     $set final status/endTime/attrs) │
│                                                                        │
│ 10. Buffer flush (2 s timer OR 50-span threshold OR SSE close):       │
│     10a. batchSize = pendingWrites.length                             │
│     10b. findOneAndUpdate({ sessionId },                              │
│           { $inc: { revision: batchSize } },                          │
│           { returnDocument: 'after', upsert: true })                  │
│         → returns new max revision; base = max − batchSize            │
│     10c. pendingWrites.map((w, i) => ({ ...w, revision: base+i+1 }))  │
│     10d. SpanModel.bulkWrite(ops, { ordered: true })                  │
│         → revision N commits before N+1; gaps from partial failure    │
│           are harmless ($gt cursor)                                   │
│                                                                        │
│ 11. Errors from flush logged via createLogger('arch-ai:tracing')      │
│     — NEVER propagated to SSE stream or caller (fire-and-forget)      │
│                                                                        │
│ 12. SSE stream closes; session state ACTIVE → IDLE or DONE            │
└────────────────────────────────────────────────────────────────────────┘
```

### Data Flow — Read Path (Cool)

```
┌─ ADMIN OPENS TRACE EXPLORER ───────────────────────────────────────────┐
│                                                                        │
│  1. UI: /arch-settings → "Traces" tab (feature flag gated)            │
│     NEXT_PUBLIC_FEATURE_ARCH_TRACE_EXPLORER=true → TraceExplorer       │
│     (else legacy ArchAuditLogsTab — FR-23)                             │
│                                                                        │
│  2. Left panel: GET /api/projects/:projectId/arch-ai/traces/sessions  │
│     withRouteHandler({ requireProject, permissions: ARCH_TRACES_READ })│
│     Middleware chain:                                                  │
│        - requireAuth         (401 if unauthenticated)                 │
│        - requireProject      (404 if cross-tenant/cross-project)      │
│        - requirePermission   (403 if no arch:traces:read)             │
│     Query: MongoTraceReader.listSessions({ tenantId, projectId,       │
│             page, limit })                                            │
│     Response: sorted by recency, name from root span, stats           │
│                                                                        │
│  3. User clicks session → GET .../sessions/[sessionId]                │
│     Query: ArchTraceSpan.find({ tenantId, projectId, sessionId })     │
│              .sort({ startTime: 1 }).lean()                           │
│     Response: flat list of spans                                      │
│                                                                        │
│  4. UI assembles TraceTree from parentSpanId chains                   │
│     (observatory TraceTree type at spans.ts is the read shape)        │
│                                                                        │
│  5. Auto-poll (5 s while session.status === 'running'):               │
│     GET .../sessions/[sessionId]/poll?sinceRevision=<maxSeen>         │
│     Query: ArchTraceSpan.find({ tenantId, projectId, sessionId,       │
│                                  revision: { $gt: sinceRevision } })  │
│             .sort({ revision: 1 }).limit(500)                         │
│     Response: deltas + nextRevision (if truncated)                    │
│     UI merges deltas into existing spanMap                            │
│                                                                        │
│  6. User clicks a span → GET .../spans/[spanId]                       │
│     Query: ArchTraceSpan.findOne({ tenantId, projectId, spanId })     │
│     (scope in query — NOT post-verify)                                │
│     Response: single span                                             │
│     UI renders type-specific detail panel:                            │
│       LLMCallDetail / ToolExecutionDetail / PhaseTransitionDetail     │
│                                                                        │
│  Cross-scope access at every step returns 404 (never 403, never 200   │
│  with empty list) — requireProject rejects before query execution.    │
│                                                                        │
│  Onboarding read path is identical but uses withRouteHandler({})      │
│  (no requireProject; userId from ctx; projectId:null in every filter).│
└────────────────────────────────────────────────────────────────────────┘
```

### Sequence Diagram — Error Bubbling

```
Coordinator              Tool Span      Turn Span      Phase Span    Session Span
     │                       │              │              │              │
     ├──startToolSpan()─────>│              │              │              │
     │  (parent=turn)        │              │              │              │
     │                       │              │              │              │
     ├──tool throws──────────│              │              │              │
     │                       │              │              │              │
     ├──setStatus('error')──>│              │              │              │
     │                       │              │              │              │
     ├──span.end()──────────>│              │              │              │
     │                       │              │              │              │
     │                       ├─bubble──────>│              │              │
     │                       │  (parent status upgrade:    │              │
     │                       │   turn already 'running'    │              │
     │                       │   → now 'error')            │              │
     │                       │              │              │              │
     │                       │              ├─bubble──────>│              │
     │                       │              │              │              │
     │                       │              │              ├─bubble──────>│
     │                       │              │              │              │
     │  Each bubble-up is a span_update → new revision     │              │
     │  → next poll catches all four: tool, turn, phase, session          │
     │                                                                    │
     │  If an ancestor is already 'error', bubbling stops there.          │
     │  If an ancestor has already ended, bubble is logged as late-bubble │
     │  (UT-3b regression test).                                           │
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | **Every** query includes an explicit `{ tenantId }` filter derived from the authenticated context — this is the **primary** isolation mechanism. Studio does NOT register an ALS tenant-context provider (predecessor HLD §4 concern 1; feature spec §12). Therefore `tenantIsolationPlugin` on the Mongoose schema is defense-in-depth only. Cross-tenant access returns **404** (not 403) — achieved because `withRouteHandler`'s `requireProject` middleware (`route-handler.ts:174-205`) runs before `requirePermission`, rejecting at the project-access layer without leaking existence. Tenant-deletion cascade runs `ArchTraceSpan.deleteMany({ tenantId }) + ArchTraceSession.deleteMany({ tenantId })` — the plugin does not do deletions (FR-21). **Project isolation**: project-scoped routes filter `{ tenantId, projectId }` in every query; cross-project returns 404. **User isolation**: onboarding routes filter `{ tenantId, userId, projectId: null }`; cross-user returns 404 even within the same tenant. **Span detail** must use scope in the query (`findOne({ tenantId, projectId, spanId })`), **not** post-verify — post-verify leaks existence (INT-1 step 2 is the regression guard).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2   | **Data Access Pattern** | Direct Mongoose model access in route handlers (same pattern as ArchJournal / predecessor arch-audit-logs). No repository layer. `MongoTraceReader` is a thin helper that composes scoped queries; it accepts `{ tenantId, projectId?, userId?, sessionId? }` and is injected via DI into tests. Reads use `.lean()` for performance. Writes go through `MongoWritePipeline` — not direct `insertMany` — which handles revision assignment + batched bulkWrite. **Test-only seed endpoint** (`POST /api/arch-ai/traces/_seed`, NODE_ENV=test) writes through the **real** pipeline so FR-6/FR-9/FR-22 are exercised from seeded data (test spec §7).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 3   | **API Contract**        | Standard Studio API envelope: `{ success: true, data: T } \| { success: false, error: { code, message } }`. Pagination via `page` + `limit` (max 200) on session list; tree endpoints return the full tree (capped at 2,000 spans by FR-22). Poll endpoint returns `{ data: Span[], nextRevision: number \| null }` — `nextRevision` non-null when the 500-span poll cap truncated. Query params validated via Zod at `withRouteHandler({ bodySchema, querySchema })`. Response shapes defined in `packages/observatory/src/schema/spans.ts` (read-side) — UI consumes `Span[]` directly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 4   | **Security Surface**    | **Auth**: project routes wrap with `withRouteHandler({ requireProject: true, permissions: StudioPermission.ARCH_TRACES_READ }, handler)` (options already supported at `route-handler.ts:77-98`); onboarding routes wrap with `withRouteHandler({}, handler)` (default `requireAuth`). **Permission**: new `StudioPermission.ARCH_TRACES_READ = 'arch:traces:read'` registered in `apps/studio/src/lib/permissions.ts:15-63`. Default grants (Open Q1 — deferred to platform-auth team): OWNER/ADMIN by default; MEMBER opt-in. **Runtime constraint (FIRM)**: every route handler — message route, sessions route, and all 9 new trace routes — MUST run on the **Node runtime**, NEVER the Edge runtime. `export const runtime = 'edge'` is prohibited. Edge runtime lacks `AsyncLocalStorage` (from `node:async_hooks`); declaring it would silently break parent-span propagation and collapse every trace into a flat list. Pair with `export const dynamic = 'force-dynamic'` (existing at `message/route.ts:14`) to prevent Next.js from buffering responses and losing async context across suspensions. **Redaction**: every event passes through `ArchRedactionBoundary` before reaching storage — `scrubSecrets()` (regex at `scrub-patterns.ts:22-41`), `redactPII()`, 4 KB truncation. **Raw mode** (`ARCH_TRACE_RAW_PAYLOADS=true`) skips truncation but still scrubs secrets/PII; tags spans with `trace.rawCapture=true`; shorter TTL (`ARCH_TRACE_RAW_TTL_DAYS=7`). **Fail-closed redaction**: if a scrubber throws, the attribute is replaced with `[REDACTION_FAILED]` marker and the span is emitted; no raw leakage (INT-5b regression guard). **Input validation**: Zod schemas on query params (`sinceRevision` non-negative integer, `page`/`limit` bounded). |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | **Write path**: all errors swallowed and logged via `createLogger('arch-ai:tracing').warn({ sessionId, tenantId, error, bufferSize })`. Tracer exceptions NEVER propagate to the coordinator, SSE stream, or caller. **Redaction failure**: fails closed — replace attribute with `[REDACTION_FAILED]` marker (INT-5b). **Flush failure**: buffer cleared, warning logged, next flush attempts the new batch (UT-11 regression guard). **Read path**: standard API error responses — 400 (invalid params), 401 (unauthenticated), 403 (missing permission within accessible scope), 404 (cross-scope access — never 403 for cross-tenant/cross-project), 500 (unexpected MongoDB failure) with `{ success: false, error: { code, message } }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 6   | **Failure Modes** | **MongoDB down (write)**: emitter flush fails silently; buffered spans lost when request ends; no WAL, no retry — best-effort telemetry (feature spec §12 Reliability; copied from predecessor HLD §4 concern 6). **MongoDB down (read)**: API returns 500; UI shows error state. **Span_start dropped**: `span_end` is an **upsert** with `$setOnInsert` populating scope fields, `traceId`, `parentSpanId`, `name`, `startTime` (derived: `endTime − durationMs` if present, else `endTime` — firm rule pinned in test spec INT-4). Span appears at completion. **Partial bulkWrite failure**: `ordered: true` stops at first error; remaining writes retried on next flush; revision gaps harmless ($gt cursor). **Error bubble race**: parent status upgrade is fire-and-forget; if a child errors at the exact moment the parent is ending, last write wins (feature spec §16 GAP-006 — acceptable for debugging telemetry). **Tracer exception in hot path**: runtime pattern (`apps/runtime/src/services/tracing/write-pipeline.ts:30-106`) wraps every storage call in its own try/catch that logs but does not rethrow — port this discipline to `MongoWritePipeline` and `ArchRedactionBoundary`. **Span cap exceeded** (>2,000 per session): tracer emits exactly one `arch_system_event` with `arch.systemEvent = 'span_cap_exceeded'`, then drops further emissions for that session (FR-22); this is correctness, not back-pressure. |
| 7   | **Idempotency**   | **`span_end` is idempotent via upsert**. `$setOnInsert` populates once; subsequent `span_update` events `$set` mutable fields without re-deriving `startTime`. **`span.end()` is idempotent at the tracer level** — double-end is a no-op + warning (UT-2 regression guard). **Revision counter is monotonic** — `$inc` is atomic in MongoDB; ordered bulkWrite commits N before N+1 (INT-6 regression guard). **No retry on write failure** — spans are append-mostly, best-effort; retrying would create duplicates without offsetting benefit. **Read endpoints** are naturally idempotent (GETs).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 8   | **Observability** | `createLogger('arch-ai:tracing')` for pipeline operations: flush success (debug — batch size + duration), flush failure (warn — error + batch size), revision-counter claim (debug — claimed range), upsert-fallback (warn — span_start was missing, upsert succeeded), span-cap-exceeded (warn — session context), redaction failure (warn — scrubber threw). **No self-referential tracing** — the trace pipeline does NOT emit spans about its own operations (avoids infinite recursion). **Metrics (future, post-v1)**: buffer size, flush latency, revision-claim latency, write error rate, redaction-hit rate exposed as Prometheus metrics. **Alerting (future)**: none in v1; fire-and-forget means alerting on write failures requires log-based alerts in the ops platform.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | **Write**: `tracer.startSpan` / `setAttribute` — <0.01 ms (synchronous buffer push). `flush()` — ~2–10 ms for 50 spans (bulkWrite) — fire-and-forget. Revision-counter $inc — ~5 ms (uncontended). **SSE latency impact target**: < 1 ms at p95 (feature spec §14 Success Metrics). **Read**: session list < 1 s; tree fetch < 2 s for 2,000 spans (feature spec §14). Covering indexes: 4 scope indexes + `spanId` unique + TTL. **Volume**: 5K–50K spans/day per tenant (feature spec §12); typical session 200–500 spans; BUILD burst 5–10 spans/sec per session; MongoDB handles without sharding. **In-memory buffer**: capped at 100 spans (~100 KB); overflow drops oldest with warning (UT-10 regression guard). **2,000-span session cap + 500-span poll cap** (FR-22) — correctness bounds, not throughput bounds. **No virtualization** of the 2,000-span UI tree in v1 (GAP-T01); expand-collapse + client-side lazy fetch covers typical sessions; if 2,000-span renders freeze a tab (checked in manual verification §10), virtualization becomes a follow-up.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 10  | **Migration Path**     | **No data migration. No dual-write.** New collections (`arch_trace_spans`, `arch_trace_sessions`) created on first write (Mongoose auto-creates). Old `arch_audit_logs` collection remains untouched and TTL-expires independently over 90 days. **Per-session-era rollout** (feature spec §7 "Rollout Strategy"): at `POST /api/arch-ai/sessions`, the feature flag `NEXT_PUBLIC_FEATURE_ARCH_TRACE_EXPLORER` is checked once; the decision pins the session's store (either `arch_trace_spans` via new pipeline OR `arch_audit_logs` via legacy emitter) for the session's entire lifetime. Sessions never cross stores mid-flight. UI reads from the store the session was created against (inferred from the session's creation era). **Legacy code remains in place** (per GAP-004): `packages/arch-ai/src/audit/`, `arch-audit-log.model.ts`, 4 legacy production routes (`audit-logs/route.ts`, `audit-logs/summary/`, `audit-logs/sessions/[id]/timeline/`, `audit-logs/cost-breakdown/`; the `audit-logs/_seed/` test-only route is excluded), `ArchAuditLogsTab.tsx` — all untouched in v1; deleted in a post-BETA single cleanup PR once the 90-day TTL has drained the old collection.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 11  | **Rollback Plan**      | **Two independent kill switches with different reload semantics**: (a) **`ARCH_TRACE_ENABLED=false` (server-side, runtime-reloadable)** — factory returns a no-op tracer; every `startSpan`/`setAttribute`/`end`/`write` is a no-op with zero per-emission overhead. Also evaluated per-emission in the live tracer as defense-in-depth against runtime config reloads (SIGHUP); in-memory buffer at flip moment is dropped with a warning log. Takes effect on next request after config reload. This stops emission but does NOT re-enable the legacy emitter. (b) **`NEXT_PUBLIC_FEATURE_ARCH_TRACE_EXPLORER=false` (client-side, REQUIRES Studio rebuild + redeploy)** — per `docs/arch/features/CC-F04-feature-flag.md:38`, `NEXT_PUBLIC_*` env vars are build-time-inlined by Next.js and cannot be toggled by a config reload; operational playbook must redeploy Studio with the flag flipped. Once rebuilt: flips UI back to `ArchAuditLogsTab` over the existing `arch_audit_logs` data; flips new sessions back to the legacy emitter (since the store choice is made at session creation based on this flag). **Full revert**: if both kill switches fail to mitigate, revert the code changes to `message/route.ts` and `sessions/route.ts` (remove tracer calls), leave the new collections + routes deployed (they return empty results on an empty collection). **Rollback does not require a database change** — the new collections are additive; the legacy `arch_audit_logs` collection is unaffected. **Tenant-deletion cascade** must be registered with the same lifecycle hook as eventstore cascades to prevent orphans.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 12  | **Test Strategy**      | See `docs/testing/arch-trace-explorer.md` (detailed test spec). **Totals**: **12 unit scenarios** (UT-1 tracer lifecycle, UT-2 double-end no-op, UT-3 error-bubbling parent chain, UT-3b late-bubble to already-ended parent is non-throwing, UT-4 redaction scrub, UT-5 ok→completed status mapping, UT-6 pricing coverage, UT-7 monotonic revision claims, UT-8 required scope fields, UT-9 index existence, UT-10 buffer overflow cap, UT-11 flush-failure fire-and-forget); **11 integration scenarios** (INT-1 project scope + 401/403/404 matrix, INT-2 onboarding scope, INT-3 poll ordering with relative revisions, INT-4 upsert fallback with pinned `startTime` derivation, INT-5 redaction scrubs before storage, INT-5b redaction-failure-isolated-fail-closed, INT-6 revision atomicity, INT-7 LLM instrument at both `streamText()` sites, INT-8 phase-transition instrument, INT-9 2,000-span and 500-span caps, INT-10 tenant-delete cascade); **6 E2E scenarios** (E2E-1 full 5-level tree, E2E-2 error bubbling visible in UI, E2E-3 live polling running→completed, E2E-4 cross-scope 404 matrix, E2E-5 feature-flag toggle, E2E-6 redaction at HTTP). **Two E2E tiers**: vitest in-process (`src/__tests__/e2e/arch-trace-explorer.e2e.test.ts` — fast, deterministic) + Playwright (`apps/studio/e2e/arch-trace-explorer.spec.ts` — browser UI + visual regression). **No `vi.mock` of `@agent-platform/*` or `@abl/*`** — only external third-party (`ai`, `openai`) via DI. **Real MongoDB** — `MongoMemoryServer` for integration/vitest-e2e; dev MongoDB for Playwright. **Test-only seed endpoint** writes through the real pipeline so redaction + revision + span-cap are exercised from fixtures (not bypassed via direct `insertMany`). **23/23 FRs** covered across the matrix (test spec §1 Coverage Matrix). Coverage is additive on top of predecessor gaps — **regression guards** for: (a) BUILD `streamText()` site instrumentation (INT-7), (b) `transitionPhase()` instrumentation (INT-8), (c) tenant-delete cascade (INT-10), (d) full 5-level span hierarchy from real flow (E2E-1). |

---

## 5. Data Model

### New Collections

```
Collection: arch_trace_spans
Engine: MongoDB (same cluster as arch_sessions, arch_journal, arch_audit_logs)

Document shape:
{
  _id:          String (uuid7, primary key)
  traceId:      String (required)       # = sessionId (FR-1)
  spanId:       String (required, unique)
  parentSpanId: String | null           # null for root session span
  name:         String (required)       # session: user's first message (truncated 50)
                                        # phase: 'INTERVIEW'|'BLUEPRINT'|'BUILD'|'CREATE'
                                        # turn: 'Turn N' or similar
                                        # llm_call: model ID or specialist name
                                        # tool_execution: tool name
  status:       String (required, enum: running | completed | error, default: running)
  startTime:    Date (required)
  endTime:      Date | null
  durationMs:   Number | null
  events:       [Mixed]                 # inline trace events emitted during span lifetime
  attributes:   Map<string, string>     # llm.model, llm.inputTokens, tool.name, etc.
  tenantId:     String (required)
  userId:       String (required)
  sessionId:    String (required)
  projectId:    String | null           # null for ONBOARDING
  revision:     Number (required, default: 0)  # from arch_trace_sessions counter
  expiresAt:    Date (required)         # pre-computed: now + (raw ? 7d : 90d)
  createdAt:    Date (auto)
  updatedAt:    Date (auto)
}

Indexes:
  1. { tenantId: 1, projectId: 1, sessionId: 1, startTime: 1 }  — project tree fetch
  2. { tenantId: 1, projectId: 1, sessionId: 1, revision: 1 }   — project poll
  3. { tenantId: 1, userId: 1, sessionId: 1, startTime: 1 }     — onboarding tree fetch
  4. { tenantId: 1, userId: 1, sessionId: 1, revision: 1 }      — onboarding poll
  5. { spanId: 1 } unique                                        — always combined with scope
  6. { expiresAt: 1 } TTL expireAfterSeconds: 0                  — per-doc variable expiry
                                                                   (single TTL index supports
                                                                    90d default + 7d raw mode)

Plugins:
  - tenantIsolationPlugin  (defense-in-depth; Studio does NOT register ALS tenant context,
                            so explicit { tenantId } filter from auth context is required
                            in every query)
```

**TTL mechanics**: MongoDB supports only one TTL index per collection. The standard pattern for variable per-document expiry is to pre-compute `expiresAt = now + ttl` at insert time and index `{ expiresAt: 1 } TTL 0` — MongoDB deletes documents when `expiresAt < now`. `MongoWritePipeline` computes `expiresAt` based on `ARCH_TRACE_RAW_PAYLOADS` and `trace.rawCapture` attribute.

```
Collection: arch_trace_sessions
Engine: MongoDB

Document shape:
{
  sessionId:   String (required, unique)
  tenantId:    String (required)
  userId:      String (required)
  projectId:   String | null
  revision:    Number (required, default: 0)  # monotonic, session-wide cursor
  createdAt:   Date (auto)
  updatedAt:   Date (auto)
}

Indexes:
  1. { sessionId: 1 } unique
  2. { tenantId: 1, projectId: 1 }
  3. { tenantId: 1, userId: 1 }
```

The session document is distinct from `ArchSession` (which owns lifecycle state). This collection's sole purpose is the atomic revision counter: `findOneAndUpdate({ sessionId }, { $inc: { revision: batchSize } })`.

### Modified Collections

None. The existing `arch_audit_logs` collection is untouched; it TTL-expires independently over 90 days.

### Key Relationships

```
arch_trace_spans.traceId     == arch_trace_sessions.sessionId  (1:1 session)
arch_trace_spans.sessionId   == ArchSession._id                (no FK; session may be
                                                                archived while spans remain)
arch_trace_spans.tenantId    scoped by tenant (cascade on tenant delete)
arch_trace_spans.projectId   scoped by project (nullable for onboarding)
arch_trace_spans.userId      scoped by user (cascade on user erasure = anonymize,
                                             not delete)
ArchJournal                  parallel by sessionId; no shared writes
```

---

## 6. API Design

### New Endpoints — Project-scoped (IN_PROJECT sessions)

Auth: `withRouteHandler({ requireProject: true, permissions: StudioPermission.ARCH_TRACES_READ }, handler)` (already supported at `route-handler.ts:77-98`).

| Method | Path                                                                          | Purpose                                  | Status codes            |
| ------ | ----------------------------------------------------------------------------- | ---------------------------------------- | ----------------------- |
| GET    | `/api/projects/[id]/arch-ai/traces/sessions`                                  | List sessions w/ summary stats           | 200, 400, 401, 404      |
| GET    | `/api/projects/[id]/arch-ai/traces/sessions/[sessionId]`                      | Full span tree for one session           | 200, 401, 403, 404      |
| GET    | `/api/projects/[id]/arch-ai/traces/sessions/[sessionId]/poll?sinceRevision=N` | Deltas since revision N (incremental)    | 200, 400, 401, 403, 404 |
| GET    | `/api/projects/[id]/arch-ai/traces/spans/[spanId]`                            | Single span detail                       | 200, 401, 403, 404      |
| GET    | `/api/projects/[id]/arch-ai/traces/stats`                                     | Aggregate stats (tokens, cost, by model) | 200, 401, 403, 500      |

### New Endpoints — User-scoped (ONBOARDING sessions)

Auth: `withRouteHandler({}, handler)` (default `requireAuth`); `userId` derived from `ctx.user.id`; every query includes `{ tenantId, userId, projectId: null }`.

| Method | Path                                                                | Purpose                                 | Status codes       |
| ------ | ------------------------------------------------------------------- | --------------------------------------- | ------------------ |
| GET    | `/api/arch-ai/traces/onboarding/sessions`                           | List current user's onboarding sessions | 200, 401, 500      |
| GET    | `/api/arch-ai/traces/onboarding/sessions/[id]`                      | Full span tree                          | 200, 401, 404      |
| GET    | `/api/arch-ai/traces/onboarding/sessions/[id]/poll?sinceRevision=N` | Deltas since revision N                 | 200, 400, 401, 404 |
| GET    | `/api/arch-ai/traces/onboarding/spans/[id]`                         | Single span detail                      | 200, 401, 404      |

### Modified Endpoints

| Method | Path                    | Change                                                                                                                                                                                                                                             |
| ------ | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/arch-ai/sessions` | Create `ArchTracer`, emit root session span with placeholder name `"New Session"`, status=running (FR-17)                                                                                                                                          |
| POST   | `/api/arch-ai/message`  | Wire `ArchTracer` through execution chain: turn span at entry; phase spans bracketed by coordinator; LLM spans wrapping both `streamText()` sites (L422 + L6836); tool spans per tool execution; catch-block `span.setStatus('error'); span.end()` |

### Test-only Endpoint (guarded by `NODE_ENV=test` + admin role)

| Method | Path                        | Purpose                                                                                                                    |
| ------ | --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/arch-ai/traces/_seed` | Discriminated-union body: `seedSpans` / `updateStatus` / `bubbleError` / `reset`. Writes through the real tracer pipeline. |

### Response Envelope

```typescript
// Success
{ success: true, data: T }

// List responses
{ success: true, data: { entries: T[], total: number, page: number, hasMore: boolean } }

// Poll response
{ success: true, data: { spans: Span[], nextRevision: number | null } }

// Error
{ success: false, error: { code: string, message: string } }
```

### Error Codes

| Status | Code             | When                                                            |
| ------ | ---------------- | --------------------------------------------------------------- |
| 400    | `INVALID_PARAMS` | Non-integer `sinceRevision`, out-of-range `page`/`limit`        |
| 401    | `UNAUTHORIZED`   | Missing or invalid auth token                                   |
| 403    | `FORBIDDEN`      | Authenticated, has project access, but lacks `arch:traces:read` |
| 404    | `NOT_FOUND`      | Cross-tenant, cross-project, cross-user, or unknown resource    |
| 500    | `INTERNAL_ERROR` | MongoDB query failure                                           |

---

## 7. Cross-Cutting Concerns

- **Audit Logging**: This feature is itself Arch AI's operational telemetry (mirror of the predecessor). It does **not** replace platform-wide audit logging (ClickHouse AuditStore), which is a separate system for compliance events. The two are complementary; no overlap, no dependency.
- **Rate Limiting**: No new rate limiter needed. Read endpoints are admin-only and low-frequency; they inherit Studio's global rate limiter. Write emission is fire-and-forget per-request (no external throttling required).
- **Caching**: None. Data freshness is important for diagnostics. No Redis dependency (verified: arch-ai tracing has zero Redis imports).
- **Encryption**: Data at rest encrypted by MongoDB's storage engine (same as every other collection). No field-level encryption needed — PII and secrets are scrubbed before storage, and LLM prompts/responses are not stored by default (only metadata + summary). Data in transit via HTTPS.
- **GDPR / Erasure**:
  - **Tenant deletion**: cascade hook runs `ArchTraceSpan.deleteMany({ tenantId }) + ArchTraceSession.deleteMany({ tenantId })`. Must be registered in the same place as eventstore cascades (FR-21; regression guard at INT-10). The `tenantIsolationPlugin` does **not** perform deletions — it only scopes reads/writes.
  - **User erasure**: `ArchTraceSpan.updateMany({ userId }, { $set: { userId: 'REDACTED' } })` anonymizes the actor rather than deleting the rows (preserves trace integrity for workspace-level debugging while satisfying right-to-erasure).
  - **TTL as complement**: 90-day default TTL handles routine cleanup; shorter 7-day TTL on raw-mode spans (`ARCH_TRACE_RAW_TTL_DAYS`). TTL is not a substitute for on-demand erasure.
- **Feature Flag Rollout**: `NEXT_PUBLIC_FEATURE_ARCH_TRACE_EXPLORER` is a plain Next.js boolean env var (not GrowthBook / LaunchDarkly — Studio has no flag registry; `.env.example:160-163` pattern; `CC-F04-feature-flag.md:13,35` idiom). Per-session-era: decision pinned at session creation based on current flag value. **Per-tenant rollout is GAP-001** (feature spec §16) — explicitly out of scope for v1.
- **Compile → Deploy → Execute Lifecycle**: This feature is **Studio-internal observability only**. Arch-AI runs entirely in Studio; runtime agent execution uses its **own separate** `TracerImpl` + `TraceStore`. No cross-contamination between `arch_trace_spans` and runtime's trace data — the only boundary is the "Create Project" step, which hands off a compiled agent to the runtime service but does NOT export trace data.
- **Model Resolution Contract**: `llm.model` attribute comes from the Vercel AI SDK `response.modelId` in `onStepFinish`. `llm.estimatedCost` computed via `estimateCost(model, inputTokens, outputTokens)` from `@agent-platform/shared-kernel/model-pricing.ts:17-71` (canonical map). **No local pricing duplication** — if a model is missing, add it to `MODEL_PRICING` so runtime and arch-ai both benefit (UT-6 regression guard asserts coverage for all models from `ModelResolutionService`'s known list).

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                                                                                                                             | Type           | Current State                                                                            | Risk                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `@agent-platform/shared-observability/tracing` (`Tracer`, `Span`, `SpanContext`, `WritePipeline`, `generateTraceId`, `generateSpanId`) | Types / utils  | All exported (L6-18)                                                                     | Low — no pre-req work                                                                                  |
| `@agent-platform/observatory` (`TraceEventType`, `Span` read-side, `TraceTree`)                                                        | Types          | Exported                                                                                 | Low — change is additive (widen union)                                                                 |
| `@agent-platform/database` (Mongoose, MongoDB)                                                                                         | Infrastructure | Stable                                                                                   | Low — already used by every arch-ai collection                                                         |
| `@agent-platform/shared-kernel/model-pricing.ts` (`estimateCost`, `MODEL_PRICING`)                                                     | Utility        | Stable                                                                                   | Low — stable; UT-6 guards coverage                                                                     |
| `@abl/compiler` (`scrubSecrets`, `scrubTraceEvent`, `scrubToolCallData`, `redactPII`)                                                  | Utility        | Stable                                                                                   | Low — already used by runtime tracer                                                                   |
| `apps/studio/src/lib/route-handler.ts` (`withRouteHandler`, `requireProject`, `permissions`)                                           | Auth           | Supports all needed options (L77-98, L174-205)                                           | Low — no new middleware                                                                                |
| `apps/studio/src/lib/permissions.ts` (`StudioPermission` enum)                                                                         | Auth catalog   | Needs new entry                                                                          | Low — additive enum member `ARCH_TRACES_READ = 'arch:traces:read'`                                     |
| Vercel AI SDK `onStepFinish` + tool `execute` callbacks                                                                                | External       | Stable; awaited                                                                          | Medium — AsyncLocalStorage propagation across these callbacks must hold; INT-7 is the regression guard |
| `packages/arch-ai/src/coordinator/phase-machine.ts:95` (`transitionPhase`)                                                             | Internal       | Exists; un-instrumented today                                                            | Low — additive hook (INT-8 regression guard)                                                           |
| Session state machine single-writer invariant                                                                                          | Internal       | Enforced by `session-state-machine.ts:19-30` + `message/route.ts:800` (409 SESSION_BUSY) | Medium — GAP-005 if a future background worker ever writes spans for the same session                  |

### Downstream (depends on this feature)

| Consumer                                      | Impact                                                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Studio UI (`TraceExplorer` + children)        | Sole consumer of HTTP routes in v1 (feature spec §8 confirms no Runtime / Admin Portal / CLI / MCP consumer)                    |
| Future ClickHouse / OTel exporter provider    | Will plug in at `packages/arch-ai/src/tracing/providers/` (MongoWritePipeline is interchangeable; zero execution-code change)   |
| Future observatory-level reader consolidation | `MongoTraceReader` could be upstreamed to observatory when runtime + arch-ai + search-ai all share a reader (GAP-007 — post-v1) |
| Future per-tenant rollout flag                | Plugs into factory resolution (GAP-001 — post-v1, requires Studio flag registry)                                                |

---

## 9. Open Questions & Decisions Needed

1. **`arch:traces:read` permission default grant matrix** — OWNER/ADMIN auto-grant yes; MEMBER auto-grant pending platform-auth team review. Blocks BETA promotion (feature spec §15 Open Q1, GAP-008). Tests use explicit grants and are not blocked.
2. **Next.js App Router AsyncLocalStorage across Vercel AI SDK callbacks** — inferred to hold based on awaited-promise semantics; runtime pattern proven in Express. Node-runtime constraint (firm, see Concern 4) prevents the Edge-runtime failure case. HLD recommends an integration test per LLM call site (INT-7) as the regression guard and a brief experiment (optional, half-day) to confirm before production if the team wants certainty. If it fails, fall back to explicit `tracer.run(span, fn)` wrapping each `streamText()` call (pattern from `apps/runtime/src/services/tracing/tracer.ts:99-105`).
3. **Kill switch evaluation strategy** — HLD pins both: startup-time factory check (returns no-op tracer; zero per-emission overhead) + per-emission guard (defense-in-depth against config reloads). Pending team review if single-check is preferred for simplicity.
4. **Per-tenant raw-capture toggle** — global env var for v1 (GAP-001, Open Q3). Tenant-level toggle likely required for GDPR regions; post-v1 work.
5. **`stats` endpoint per-user breakdown** — aggregate only in v1 (feature spec §15 Open Q5); per-user breakdown deferred pending privacy review.
6. **`arch_trace_spans` TTL cascade** for still-running spans — currently `running` spans orphan at TTL expiry (feature spec §15 Open Q4). Expected behavior, but worth confirming during ALPHA.
7. **Observatory read-API consolidation** — arch-ai owns `MongoTraceReader` in v1 (GAP-007). Future platform work may merge readers across runtime + arch-ai + search-ai.

---

## 10. References

- Feature spec: [`../features/arch-trace-explorer.md`](../features/arch-trace-explorer.md)
- Test spec: [`../testing/arch-trace-explorer.md`](../testing/arch-trace-explorer.md)
- Oracle decisions log: [`../sdlc-logs/arch-trace-explorer/hld.log.md`](../sdlc-logs/arch-trace-explorer/hld.log.md)
- Predecessor HLD (pattern reference): [`arch-audit-logs.hld.md`](arch-audit-logs.hld.md)
- Related HLDs: [`arch-ai-assistant.hld.md`](arch-ai-assistant.hld.md), [`audit-logging.hld.md`](audit-logging.hld.md) (platform-wide audit — separate system)
- Canonical tracing primitives: `packages/shared-observability/src/tracing/` (L6-18 all exports verified)
- Runtime reference implementation (pattern source, not import source): `apps/runtime/src/services/tracing/` — `tracer.ts:34,99-109`, `write-pipeline.ts:30-106`, `tracer-registry.ts`
- Observatory read-side schema: `packages/observatory/src/schema/trace-events.ts:241-268, 276-464, 538-561`, `spans.ts:18-60`
- Route handler pattern: `apps/studio/src/lib/route-handler.ts:77-98, 174-205`
- Permissions catalog: `apps/studio/src/lib/permissions.ts:15-63`
- Redaction utilities: `packages/compiler/src/platform/constructs/executors/scrub-patterns.ts:22-41`, `trace-scrubber.ts:18-60`, `security/pii-detector.ts`
- Model pricing (canonical): `packages/shared-kernel/src/model-pricing.ts:17-71`
- Coordinator phase machine: `packages/arch-ai/src/coordinator/phase-machine.ts:95`
- Session state machine (single-writer invariant): `packages/arch-ai/src/coordinator/session-state-machine.ts:19-30`; `apps/studio/src/app/api/arch-ai/message/route.ts:547-582, 800`
- Instrumentation targets: `apps/studio/src/app/api/arch-ai/message/route.ts:{14, 422, 547-582, 800, 6836}`, `apps/studio/src/app/api/arch-ai/sessions/route.ts:{36-123, 91-110}`
- Feature-flag idiom: `docs/arch/features/CC-F04-feature-flag.md:13, 35`, `apps/studio/.env.example:160-163`
- CLAUDE.md: Core Invariants §1 (Resource Isolation), §4 (Traceability), §5 (Compliance), Test Architecture, E2E Test Standards
- Platform principles skill, design-quality-gate skill (12 concerns)
