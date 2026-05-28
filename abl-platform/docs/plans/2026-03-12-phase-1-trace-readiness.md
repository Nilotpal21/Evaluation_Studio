# Phase 1: Platform Trace Readiness — Consolidated Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Establish a unified W3C-compatible `traceId` flowing through every code path — per-turn on WebSocket, per-request on HTTP — from channel entry to channel exit, across service boundaries, and into ClickHouse, so every interaction is individually addressable.

**Status:** Phase 1 of 4. No dependencies on other phases. All subsequent phases depend on this.

**Source documents:**

- `2026-03-11-platform-trace-readiness-merged.md` (17 tasks — primary source)
- `2026-03-11-platform-trace-readiness-plan.md` (16 tasks — alternate version)
- `2026-03-11-sti-phase-minus-1-implementation.md` (10 tasks — earlier draft)

**Architecture:** Mount the existing `createObservabilityMiddleware` (implemented in `@agent-platform/shared-observability`, never wired) on all Express servers, wiring it to the compiler's `runWithObservabilityContext` ALS. For WebSocket channels (which bypass Express middleware), generate per-turn traceId and enter the same ALS. Stamp every `TraceEvent` via `createCentralizedTraceHandler` in runtime-executor.ts, reading `getCurrentTraceId()` from ALS. Thread `traceId` through BullMQ job payloads and outbound HTTP headers.

**Tech Stack:** `@agent-platform/shared-observability` (W3C traceparent middleware, `ObservabilityContext`, `requestIdMiddleware`, `createLogger`), `@abl/compiler/platform` (AsyncLocalStorage via `runWithObservabilityContext`, `getCurrentTraceId`, `getObservabilityContext`), Express, ClickHouse, BullMQ, WebSocket

**Key Discovery — Infrastructure Already Exists:**

- `PlatformEvent.trace_id` field: `packages/eventstore/src/schema/platform-event.ts:30`
- ClickHouse `platform_events.trace_id` column: `packages/database/src/clickhouse-schemas/init.ts:291`
- ClickHouse `idx_trace` bloom filter: `packages/database/src/clickhouse-schemas/init.ts:317`
- Row mapper write/read: `packages/eventstore/src/stores/clickhouse/clickhouse-row-mapper.ts:56,90`
- `TraceEventWithId.traceId` optional field: `apps/runtime/src/types/index.ts:444`
- Voice traces already generate per-turn traceId: `apps/runtime/src/observability/voice-trace.ts:163`

**Design Decisions:**

1. **W3C 32-hex traceId format** (not UUID v4) — aligns with OTEL and the span-model-fix in Phase 2
2. **Two ALS systems coexist**: `observabilityStorage` (request-level, from shared-observability middleware) and `requestIdStorage` (from requestIdMiddleware). Phase 2 adds a third (`spanStorage` for span-level context). All carry the same `traceId`.
3. **`requestIdMiddleware` stays**: It serves a different purpose (correlation ID for logs). Both middlewares run in parallel.
4. **Existing closure-based span stack unchanged**: Phase 1 only wires traceId. Phase 2 (Span Model Fix) replaces the broken span stack with ALS-based Tracer/Span.

---

## Task 1: Add `exposedHeaders` to CORS Schema

Independent change. Without this, browser clients silently cannot read `X-Trace-Id` from cross-origin responses.

**Files:**

- Modify: `packages/config/src/schemas/cors.schema.ts`
- Modify: `apps/runtime/src/server.ts` (wire `exposedHeaders` in CORS setup)

**Steps:**

1. Add `exposedHeaders: z.array(z.string()).default(['X-Request-Id', 'X-Trace-Id'])` to `CORSConfigSchema`
2. Wire `exposedHeaders: config.cors.exposedHeaders` in runtime CORS setup (~line 200)
3. Repeat for any other service that uses `config.cors` in its CORS setup
4. Build: `pnpm build --filter=@agent-platform/config`
5. Commit: `feat: add exposedHeaders to CORS schema for X-Trace-Id browser access`

---

## Task 2: Mount Observability Middleware on Runtime

Core change — wires `createObservabilityMiddleware` to the compiler's `runWithObservabilityContext` ALS, making `getCurrentTraceId()` available in every downstream async call.

**Files:**

- Modify: `apps/runtime/src/server.ts:229`
- Read first: `packages/shared-observability/src/middleware/observability.ts`
- Read first: `packages/compiler/src/platform/observability/context.ts`

**Steps:**

1. Write test `apps/runtime/src/__tests__/trace-id-middleware.test.ts` — verify `X-Trace-Id` header on response, traceparent honor, coexistence with X-Request-ID
2. Run test, verify it fails
3. Mount middleware after `requestIdMiddleware()`:

```typescript
import {
  requestIdMiddleware,
  createObservabilityMiddleware,
} from '@agent-platform/shared-observability';
import { runWithObservabilityContext } from '@abl/compiler/platform';

app.use(requestIdMiddleware());
app.use(
  createObservabilityMiddleware({
    runWithContext: (ctx, fn) => runWithObservabilityContext(ctx, fn),
  }),
);
```

4. Run test, verify it passes
5. Commit: `feat(runtime): mount observability middleware for unified trace ID`

---

## Task 3: Mount Observability Middleware on All Other Services

Same pattern as Task 2, applied to the remaining 4 services.

**Files:**

- Modify: `apps/search-ai/src/server.ts:95` (imports from `@agent-platform/shared-observability`)
- Modify: `apps/search-ai-runtime/src/server.ts:76` (imports from `@agent-platform/shared-observability`)
- Modify: `apps/workflow-engine/src/index.ts:94` (imports from `@agent-platform/shared-observability`)
- Modify: `apps/multimodal-service/src/server.ts:89` (imports from `@agent-platform/shared` — needs `@agent-platform/shared-observability` import added)

**Steps:**

1. Mount on each service after its existing `requestIdMiddleware()`. Same import pattern as Task 2.
2. **Note:** `multimodal-service` imports `requestIdMiddleware` from `@agent-platform/shared` (not `shared-observability`). Add direct import of `createObservabilityMiddleware` from `@agent-platform/shared-observability` for this service. The other 3 services already import from `@agent-platform/shared-observability`.
3. If any service doesn't have `@abl/compiler` as a dependency, add it to `package.json`.
4. Build: `pnpm build --filter=search-ai --filter=search-ai-runtime --filter=workflow-engine --filter=multimodal-service`
5. Commit: `feat: mount observability middleware on all services for unified trace ID`

---

## Task 4: Add `channel_response_sent` Trace Event Type

Add the new event type to the union before any handler code references it.

**Files:**

- Modify: `apps/runtime/src/types/index.ts` (TraceEventType union)

**Steps:**

1. Add `| 'channel_response_sent'` to the `TraceEventType` union
2. Build: `pnpm build --filter=runtime`
3. Commit: `feat(runtime): add channel_response_sent trace event type`

---

## Task 5: Stamp traceId in createCentralizedTraceHandler

Highest-impact single change — fills the empty `platform_events.trace_id` ClickHouse column for ALL channels.

**Files:**

- Modify: `apps/runtime/src/services/runtime-executor.ts:1426`

**Steps:**

1. Add `traceId?: string` parameter to `createCentralizedTraceHandler`
2. Stamp `traceId` on every constructed `TraceEventWithId`
3. At each call site, pass `getCurrentTraceId()` from `@abl/compiler/platform`
4. For WebSocket paths where middleware ALS may not be active, pass `traceId` from `ClientState` (set up in Task 10)
5. Build and test: `pnpm build --filter=runtime && pnpm --filter=runtime test`
6. Commit: `feat(runtime): stamp traceId on every TraceEvent via centralized handler`

---

## Task 6: Add traceId to BullMQ Job Payload Types

Type-only change. Add `traceId` field to all job payload interfaces.

**Files:**

- Modify: `apps/runtime/src/channels/types.ts:128-147` (InboundJobPayload, DeliveryJobPayload)
- Modify: `apps/runtime/src/services/llm/llm-queue.ts:28-35` (LLMJobData)

**Steps:**

1. Add `traceId?: string` to `InboundJobPayload`, `DeliveryJobPayload`, `LLMJobData`
2. Build: `pnpm build --filter=runtime` (no call sites break — field is optional)
3. Commit: `feat(runtime): add traceId field to BullMQ job payload types`

---

## Task 7: Thread traceId at BullMQ Enqueue Sites

Pass `getCurrentTraceId()` into job payloads when enqueueing BullMQ jobs.

**Files:**

- Modify: All files constructing `InboundJobPayload`, `DeliveryJobPayload`, or `LLMJobData`

**Steps:**

1. Find all enqueue sites (search for payload type construction)
2. At each site, add `traceId: getCurrentTraceId()` to the payload
3. Build and test: `pnpm build --filter=runtime && pnpm --filter=runtime test`
4. Commit: `feat(runtime): thread traceId into BullMQ job payloads at enqueue sites`

---

## Task 8: BullMQ Workers Set Up ObservabilityContext

Worker-side: wrap execution in `runWithObservabilityContext` so all downstream code can access `getCurrentTraceId()`.

**Files:**

- Modify: `apps/runtime/src/services/queues/inbound-worker.ts` (~line 944)
- Modify: Any other BullMQ worker files that process jobs with traceId

**Steps:**

1. Extract `traceId` from job payload (fallback: generate fresh 32-hex)
2. Wrap `executor.executeMessage()` in `runWithObservabilityContext({ traceId, spanId }, () => ...)`
3. Build and test: `pnpm build --filter=runtime && pnpm --filter=runtime test`
4. Commit: `feat(runtime): wrap BullMQ worker execution in ObservabilityContext for traceId`

---

## Task 9: SearchAI Client Trace Header Injection

Thread trace context from runtime → SearchAI via W3C `traceparent` header.

**Files:**

- Modify: `packages/search-ai-sdk/src/client.ts:350` (buildHeaders method)

**Steps:**

1. Write test verifying `traceparent` and `X-Trace-Id` headers when ObservabilityContext is active
2. In `buildHeaders()`, read `getObservabilityContext()` and inject `traceparent: 00-{traceId}-{spanId}-01` + `X-Trace-Id: {traceId}`
3. Add `@abl/compiler` to `packages/search-ai-sdk/package.json` if not present
4. Build and test: `pnpm build --filter=@agent-platform/search-ai-sdk && pnpm --filter=@agent-platform/search-ai-sdk test`
5. Commit: `feat(search-ai-sdk): inject W3C traceparent header for cross-service trace propagation`

---

## Task 10: WS Handlers Generate and Store traceId

WebSocket connections bypass Express middleware — traceId must be generated explicitly.

**Files:**

- Modify: `apps/runtime/src/websocket/handler.ts:141`
- Modify: `apps/runtime/src/websocket/sdk-handler.ts`

**Steps:**

1. Add `traceId?: string` to `ClientState` interface
2. Generate `traceId = crypto.randomUUID().replace(/-/g, '')` at connection/agent-load time
3. Store in `state.traceId`
4. Wrap each `executeMessage` call in `runWithObservabilityContext({ traceId: state.traceId!, spanId }, () => ...)`
5. Apply same pattern to `sdk-handler.ts`
6. Build and test
7. Commit: `feat(runtime): generate and propagate traceId in WebSocket handlers`

---

## Task 11: Emit `channel_response_sent` Exit Events

Add exit trace event to all channel handlers. This event marks response exit and will serve as the STI STR flush trigger in Phase 4.

**Files:**

- Modify: `apps/runtime/src/routes/channel-vxml.ts`
- Modify: `apps/runtime/src/routes/channel-genesys.ts`
- Modify: `apps/runtime/src/routes/channel-audiocodes.ts`
- Modify: `apps/runtime/src/routes/chat.ts`
- Modify: `apps/runtime/src/websocket/sdk-handler.ts`

**Steps:**

1. Create helper `emitChannelResponseSent(sessionId, channel, durationMs, opts?)` in trace-emitter or utility
2. Add to each channel handler after response send, capturing `startTime` at handler entry
3. Build and test
4. Commit: `feat(runtime): emit channel_response_sent exit events on all channels`

---

## Task 12: WS Session Messages Include traceId

Add `traceId` to `session_start` and `agent_loaded` WS messages so SDK consumers can correlate.

**Files:**

- Modify: `apps/runtime/src/websocket/sdk-handler.ts:358-363` (`session_start` message)
- Modify: `apps/runtime/src/websocket/handler.ts:1114` (`ServerMessages.agentLoaded()` call site)
- Modify: `apps/runtime/src/websocket/events.ts:164-165` (`agentLoaded` factory)

**Steps:**

1. Add `traceId: state.traceId` to `session_start` message in `sdk-handler.ts`
2. Add `traceId` parameter to `agentLoaded` factory in `events.ts`
3. Update the `ServerMessages.agentLoaded()` call site in `handler.ts:1114` to pass `state.traceId`
4. **Note:** `agent_loaded` is sent by `handler.ts` (debug WS handler), NOT `sdk-handler.ts`. The sdk-handler sends `session_start` directly without using `ServerMessages`.
5. Build and test
6. Commit: `feat(runtime): include traceId in WS session_start and agent_loaded messages`

---

## Task 13: API Response Envelope traceId

Add `traceId` to the standard `{ success, data/error }` response envelope.

**Files:**

- Create: `apps/runtime/src/middleware/trace-response.ts`
- Modify: `apps/runtime/src/server.ts` (global error handler)

**Steps:**

1. Create `sendWithTrace(res, statusCode, body)` helper that injects `traceId` from ALS
2. Apply to global error handler first (highest support value)
3. Build and test
4. Commit: `feat(runtime): add traceId to API response envelopes for support correlation`

---

## Task 14: Studio Proxy Forwards X-Trace-Id

**Files:**

- Modify: `apps/studio/src/proxy.ts:182-185`

**Steps:**

1. Check if upstream headers (including `X-Trace-Id`) are already forwarded by `NextResponse.rewrite()`
2. If proxy strips response headers, add explicit forwarding
3. Build: `pnpm build --filter=studio`
4. Commit: `feat(studio): forward X-Trace-Id header from upstream API responses`

---

## Task 15: Remove Kafka Trace Header Feature Flag

**Files:**

- Modify: `apps/runtime/src/services/event-bus/kafka-subscriber.ts`

**Steps:**

1. Remove `this.traceHeadersEnabled = process.env.OBS_EVENTBUS_TRACE_HEADERS === 'true'`
2. Remove `traceHeadersEnabled` field from class
3. Remove `if (this.traceHeadersEnabled)` guards, keep inner code
4. Build and test
5. Commit: `feat(runtime): make Kafka trace header injection always-on (remove feature flag)`

---

## Task 16: Verification — End-to-End Trace ID Flow

**Steps:**

1. Build everything: `pnpm build`
2. Run all tests: `pnpm test`
3. Manual verification (if local env available):
   - HTTP: `curl -v http://localhost:3112/health` → verify `X-Trace-Id` header (32 hex chars)
   - Traceparent honor: send `traceparent` header → verify same traceId echoed back
   - WS: Connect, load agent → verify `traceId` in `agent_loaded` message
   - ClickHouse: Query `SELECT trace_id FROM platform_events WHERE timestamp > now() - INTERVAL 5 MINUTE LIMIT 10` → verify non-empty

---

## Dependency Graph

```
Task 1 (CORS) ─────────────────────────────────────────────────────┐
Task 2 (Mount middleware on runtime) ──┬── Task 5 (stamp traceId) ─┤
Task 3 (Mount on other services) ──────┤                           │
Task 4 (event type) ───────────────────┼── Task 11 (exit events) ──┤
Task 6 (BullMQ payload types) ────┬────┤                           │
Task 7 (BullMQ enqueue sites) ────┤    │                           ├── Task 16 (verification)
Task 8 (BullMQ worker ALS) ───────┘    │                           │
Task 9 (SearchAI client) ──────────────┘                           │
Task 10 (WS handlers traceId) ─── Task 12 (WS messages) ──────────┤
Task 13 (API envelope) ────────────────────────────────────────────┤
Task 14 (Studio proxy) ───────────────────────────────────────────┤
Task 15 (Kafka flag removal) ──────────────────────────────────────┘
```

**Parallelizable groups:**

- **Group A** (independent, start first): Tasks 1, 4, 6
- **Group B** (depends on middleware mount): Tasks 2, 3 → 5, 7, 8, 9, 10
- **Group C** (depends on Group B): Tasks 11, 12, 13, 14, 15
- **Group D** (final): Task 16

**Estimated scope: ~25 files touched, 16 tasks**

---

## Relationship to Other Phases

- **Phase 2 (Span Model Fix)** builds on top of this — replaces the closure-based span stack with ALS-based `Tracer`/`Span`, but the traceId plumbing from Phase 1 stays intact. Phase 2 modifies some of the same files (trace-emitter, trace-forwarder, WS handlers) but the changes are additive.
- **Phase 3 (Trace Event Consolidation)** depends on `getCurrentTraceId()` being available everywhere (Task 2-3, 8, 10).
- **Phase 4 (STI)** depends on all of Phase 1 — `tracePath()` reads `traceId` from the ALS that Phase 1 wires.

---

## Plan Review Notes

**Review date:** 2026-03-12

### Pass 1: Technical Accuracy

**Fixes applied:**

1. **Task 5 line number:** Changed `runtime-executor.ts:1418` to `runtime-executor.ts:1426` — the actual `createCentralizedTraceHandler` method definition is at line 1426.
2. **Task 3 import annotations:** Added per-service notes clarifying which package each service imports `requestIdMiddleware` from. Three services (search-ai, search-ai-runtime, workflow-engine) already import from `@agent-platform/shared-observability`. Only `multimodal-service` imports from `@agent-platform/shared` and needs the direct `@agent-platform/shared-observability` import added.
3. **Task 12 file attribution:** `agent_loaded` message is sent by `handler.ts:1114` (debug WS handler via `ServerMessages.agentLoaded()`), NOT by `sdk-handler.ts`. The sdk-handler only sends `session_start` directly. Fixed file list and steps to reference the correct files.

**Verified correct:**

- All file paths exist on disk
- `ObservabilityMiddlewareConfig` interface shape matches plan description (line 27-47 of `observability.ts`)
- `runWithObservabilityContext` signature: `<T>(context: ObservabilityContext, fn: () => T): T` — compatible with the `runWithContext(ctx, fn)` wrapper in the plan
- `getCurrentTraceId()`, `getObservabilityContext()` signatures match plan usage
- `createCentralizedTraceHandler` signature: 7 params (sessionId, tenantId, agentName, projectId, channelType, originalOnTraceEvent?, sessionRef?) — matches plan
- 1 call site for `createCentralizedTraceHandler` at line 1682 — confirmed
- `TraceEventWithId.traceId` optional field at `types/index.ts:444` — confirmed
- `InboundJobPayload` (lines 128-139), `DeliveryJobPayload` (141-147), `LLMJobData` (llm-queue.ts:28-35) — all confirmed
- `ClientState` interface at `handler.ts:141` — confirmed, no existing `traceId` field
- `buildHeaders()` at `search-ai-sdk/src/client.ts:350` — confirmed
- CORS schema at `packages/config/src/schemas/cors.schema.ts` — no `exposedHeaders` field yet, confirming Task 1 is needed
- Kafka `traceHeadersEnabled` feature flag confirmed at `kafka-subscriber.ts:100,111,121,263`
- Key Discovery infrastructure references (ClickHouse schema, row mapper, PlatformEvent) — all line numbers correct

### Pass 2: Completeness

**Observations (no plan changes needed for these — noted for implementor awareness):**

1. **SDK handler TraceEventWithId bypass:** `sdk-handler.ts:1532-1538` constructs `TraceEventWithId` objects directly (not via `createCentralizedTraceHandler`). These manually-built events in the SDK WS path will NOT get `traceId` stamped by Task 5's centralized change. The plan acknowledges this gap implicitly — Task 10 wraps `executeMessage` calls in `runWithObservabilityContext`, and the executor's `createCentralizedTraceHandler` reads from ALS. But the `onTraceEvent` callback in sdk-handler also creates its own `TraceEventWithId` for WS forwarding at line 1532. Implementors should stamp `traceId` on these manually constructed events too (e.g., `traceId: getCurrentTraceId()`).
2. **BullMQ enqueue sites for InboundJobPayload:** Three enqueue sites found — `routes/channel-webhooks.ts:352`, `routes/http-async-channel.ts:559`, `services/email/smtp-server.ts:301`. Task 7 says "Find all enqueue sites" which covers these, but implementors should verify no others were added.
3. **No missing services:** Admin is a Next.js app with only a `proxy.ts` middleware — no Express server or `requestIdMiddleware`. The 4 services listed in Task 3 are the complete set.
4. **Dependency graph is accurate.** Task ordering and parallelization groups are correct.
