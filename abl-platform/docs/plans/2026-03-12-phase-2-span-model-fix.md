# Phase 2: Span Model Fix — Consolidated Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the broken closure-based span stack with AsyncLocalStorage-based `Tracer`/`Span` primitives, producing correct parent-child span relationships across all code paths including concurrent turns, compiler runtimes, and voice tracing.

**Status:** Phase 2 of 4. Depends on Phase 1 (Trace Readiness) being complete. Phase 3 depends on this.

**Source document:** `docs/superpowers/specs/2026-03-12-span-model-fix-design.md`

**Prerequisites (from Phase 1):**

- `createObservabilityMiddleware` mounted on all Express servers (Tasks 2-3)
- `runWithObservabilityContext` wrapping WS handlers and BullMQ workers (Tasks 8, 10)
- `getCurrentTraceId()` available in all async code paths

## Problem

The trace emitter uses a closure-based span stack (`let currentSpanId` + `let spanStack[]`) that produces broken parent-child relationships:

1. **Sparse parentSpanId**: Only 2 of 8 span-emitting functions set `parentSpanId`
2. **Direct addEvent bypass**: 8 call sites construct events with no span context
3. **Concurrency corruption**: Closure-scoped span stack (inside `createTraceEmitter`) — shared per session, so concurrent turns overwrite each other
4. **Trace forwarder duplication**: `trace-forwarder.ts` has its own broken `let currentSpan`
5. **UI heuristic matching**: Observatory uses LIFO heuristics to pair agent_enter/exit — fragile

## Decisions

- **No backward compatibility** with existing stored traces
- **AsyncLocalStorage** for in-process propagation, explicit inject/extract at serialization boundaries
- **OTEL-aligned IDs**: 128-bit hex traceId, 64-bit hex spanId/parentSpanId, W3C traceparent
- **Full pipeline scope**: trace emitter + trace forwarder + Observatory UI + voice tracing
- **Reusable primitives in `@agent-platform/shared-observability/tracing`**: interfaces + ID generation + W3C format/parse + boundary helpers
- **Runtime-specific implementations in `apps/runtime/`**: `TracerImpl`, `SpanImpl`, `WritePipelineImpl`, `TracerRegistry`

## Architecture: Two ALS Systems

After Phase 2, two ALS stores coexist:

| ALS                                   | Scope         | Set By                                                         | Read By                                            |
| ------------------------------------- | ------------- | -------------------------------------------------------------- | -------------------------------------------------- |
| `observabilityStorage` (from Phase 1) | Request-level | `createObservabilityMiddleware`, `runWithObservabilityContext` | `getCurrentTraceId()`, `getObservabilityContext()` |
| `spanStorage` (new in Phase 2)        | Span-level    | `tracer.withSpan()`, `tracer.run()`                            | `tracer.activeSpan()`, `tracer.emit()`             |

Both carry the same `traceId`. The span ALS provides finer-grained parent-child context within a request.

---

## Task 1: Add tracing primitives to `@agent-platform/shared-observability`

Create interfaces and shared utilities under a new `./tracing` export.

**New files (~150 LOC):**

- `packages/shared-observability/src/tracing/span-context.ts` — `SpanContext` interface
- `packages/shared-observability/src/tracing/span.ts` — `Span` interface
- `packages/shared-observability/src/tracing/tracer.ts` — `Tracer` interface
- `packages/shared-observability/src/tracing/write-pipeline.ts` — `WritePipeline` interface
- `packages/shared-observability/src/tracing/id.ts` — `generateTraceId()` (32 hex), `generateSpanId()` (16 hex)
- `packages/shared-observability/src/tracing/traceparent.ts` — `formatTraceparent()`, `parseTraceparent()` (stricter than existing)
- `packages/shared-observability/src/tracing/propagation.ts` — `injectTrace()`, `extractTrace()` for BullMQ/HTTP boundaries
- `packages/shared-observability/src/tracing/index.ts` — barrel export

**Steps:**

1. Read existing `packages/shared-observability/package.json` to verify export map
2. Create all files with interfaces and utilities
3. Add `"./tracing"` export to `package.json`
4. Update existing `middleware/observability.ts` to import `parseTraceparent` from `../tracing/traceparent` (replaces the private `parseTraceparent` function at line 53 of `packages/shared-observability/src/middleware/observability.ts`)
5. Build: `pnpm build --filter=@agent-platform/shared-observability`
6. Write unit tests for ID generation, traceparent format/parse
7. Commit: `feat(shared-observability): add tracing primitives (SpanContext, Span, Tracer, WritePipeline)`

**Key interfaces:**

```typescript
interface SpanContext {
  traceId: string; // 128-bit hex (32 chars)
  spanId: string; // 64-bit hex (16 chars)
  parentSpanId?: string;
}

interface Span {
  readonly name: string;
  readonly context: SpanContext;
  agentName?: string;
  attributes: Record<string, string>;
  setAttribute(key: string, value: string): void;
  addEvent(name: string, data?: Record<string, unknown>): void;
  setStatus(status: 'ok' | 'error', message?: string): void;
  end(): void;
}

interface Tracer {
  startSpan(
    name: string,
    options?: { agentName?: string; attributes?: Record<string, string> },
  ): Span;
  withSpan<T>(
    name: string,
    fn: () => T | Promise<T>,
    options?: { agentName?: string; attributes?: Record<string, string> },
  ): Promise<T>;
  runSync<T>(span: Span, fn: () => T): T;
  run<T>(span: Span, fn: () => T | Promise<T>): T | Promise<T>;
  activeSpan(): Span | null;
  emit(event: { type: string; data: Record<string, unknown>; durationMs?: number }): void;
  continueFrom(context: SpanContext, name: string): Span;
}

interface WritePipeline {
  write(event: Record<string, unknown>): void; // fire-and-forget, never throws
}
```

---

## Task 2: Add `span_end` event type

**Files:**

- Modify: `apps/runtime/src/types/index.ts` — add `'span_end'` to `TraceEventType` union
- Modify: `apps/studio/src/types/index.ts` — add `'span_end'` to `ExtendedTraceEventType`
- Modify: `apps/runtime/src/types/index.ts` — add `traceId?: string`, `tenantId?: string`, `projectId?: string` to `TraceEvent` type (currently has `spanId?` and `parentSpanId?` but NOT `traceId`, `tenantId`, or `projectId`)

**Steps:**

1. Read both type files to verify current shapes
2. Add the new type and fields
3. Build: `pnpm build --filter=runtime --filter=studio`
4. Commit: `feat(runtime): add span_end event type and trace fields to TraceEvent`

---

## Task 3: Implement `TracerImpl`, `SpanImpl`, `WritePipelineImpl`

Runtime-specific implementations.

**New files (~180 LOC):**

- `apps/runtime/src/services/tracing/tracer.ts` — `TracerImpl` with `spanStorage` ALS
- `apps/runtime/src/services/tracing/span.ts` — `SpanImpl` with idempotent `end()`
- `apps/runtime/src/services/tracing/write-pipeline.ts` — `WritePipelineImpl` wrapping TraceStore + WS broadcast + EventStore
- `apps/runtime/src/services/tracing/index.ts` — barrel export

**Steps:**

1. Read `apps/runtime/src/services/trace-store.ts` and `trace-emitter.ts` to understand current write paths
2. Implement `WritePipelineImpl.write()` — wraps `getTraceStore().addEvent()` + WS broadcast + `getEventStore().emitter.emit()`
3. Implement `SpanImpl` — lifecycle management, idempotent `end()`, `annotations` list
4. Implement `TracerImpl` — `spanStorage` ALS, `withSpan`/`run`/`runSync`, orphan-emit warning
5. Write comprehensive unit tests
6. Build: `pnpm build --filter=runtime`
7. Commit: `feat(runtime): implement TracerImpl, SpanImpl, WritePipelineImpl`

**Key implementation details:**

- `TracerImpl` constructor takes `{ sessionId, tenantId, projectId, writePipeline, defaultAttributes? }`
- `fallbackTraceId` generated once per session for orphan emits
- `emit()` reads `activeSpan()` from ALS, attaches `traceId/spanId/parentSpanId/tenantId/projectId`
- `WritePipelineImpl` is the single error-logging layer — outer catches in TracerImpl/SpanImpl do NOT log
- `SpanImpl.end()` writes directly to writePipeline (not through `tracer.emit()`)

---

## Task 4: Implement `TracerRegistry`

Session-scoped tracer lifecycle management.

**New file:**

- `apps/runtime/src/services/tracing/tracer-registry.ts`

**Steps:**

1. Implement registry with LRU eviction: 10,000 max entries, 30-minute TTL
2. Key: `sessionId`, Value: `Tracer`
3. `getOrCreate(sessionId, config)` — creates TracerImpl if not present
4. `remove(sessionId)` — cleanup on session end
5. Periodic sweep for expired entries
6. Write unit tests
7. Commit: `feat(runtime): add TracerRegistry with LRU eviction (10K max, 30min TTL)`

---

## Task 5: Refactor trace-emitter to use Tracer

The layering becomes: `TraceEmitter.logLLMCall()` → scrub/gate → `tracer.emit()` → enrich with span context → `writePipeline.write()`.

**Files:**

- Modify: `apps/runtime/src/services/trace-emitter.ts`

**Steps:**

1. Read current trace-emitter to understand all 8 span-emitting functions
2. Add `tracer: Tracer` to `TraceEmitterConfig`
3. Replace closure-based `currentSpanId` / `spanStack` with `tracer.emit()` calls
4. `logAgentEnter` → `tracer.startSpan('agent:' + agentName)` (or caller uses `withSpan`)
5. All other emit functions → `tracer.emit({ type, data })` which auto-attaches span context from ALS
6. Remove `let currentSpanId`, `let spanStack` closure variables (lines 400-401 inside `createTraceEmitter()`)
7. Build and test
8. Commit: `refactor(runtime): replace closure span stack with Tracer in trace-emitter`

**Critical: TraceEmitter retains responsibility for:**

- PII scrubbing (`scrubSecrets`, `redactPII`)
- Verbosity gating
- Custom dimensions
- Secret scrubbing

Tracer only handles span context propagation and event enrichment.

---

## Task 6: Wire Tracer into RuntimeExecutor

Create Tracer per session and wire through execution paths.

**Files:**

- Modify: `apps/runtime/src/services/runtime-executor.ts`
- Modify: `apps/runtime/src/services/execution/types.ts` (add `tracer` field to `RuntimeSession` interface, defined at line 101)

**Steps:**

1. Read `RuntimeSession` type in `apps/runtime/src/services/execution/types.ts` to verify shape
2. Add `tracer?: Tracer` to `RuntimeSession` (in `execution/types.ts`)
3. In `RuntimeExecutor`, create Tracer via `TracerRegistry.getOrCreate()` when session starts
4. Pass Tracer to `TraceEmitter` config
5. Wrap `executeMessage()` in `tracer.withSpan('turn', () => ...)` for per-turn span
6. Build and test
7. Commit: `feat(runtime): wire Tracer into RuntimeExecutor per session`

---

## Task 7: Rewrite trace-forwarder

Replace the broken `let currentSpan` with the session-scoped Tracer.

**Files:**

- Modify: `apps/runtime/src/services/execution/trace-forwarder.ts` (~220 → ~80 LOC)

**Steps:**

1. Read current trace-forwarder to understand all methods
2. Replace constructor to accept `tracer: Tracer` instead of `traceStore: TraceStore`
3. All methods → `tracer.emit({ type, data })` or `tracer.withSpan()` for compiler spans
4. Remove `let currentSpan` variable
5. Compiler-layer spans inherit runtime traceId via `tracer.startSpan()` which reads parent from ALS
6. Update all construction sites of TraceForwarder to pass the session's Tracer
7. Build and test
8. Commit: `refactor(runtime): rewrite trace-forwarder to use Tracer (~220→~80 LOC)`

---

## Task 8: Fix direct `addEvent` bypass call sites

8 call sites bypass trace-emitter and construct events with no span context.

**Files:**

- Modify: `apps/runtime/src/services/runtime-executor.ts` (2 sites)
- Modify: `apps/runtime/src/routes/feedback.ts` (line 74)
- Modify: `apps/runtime/src/websocket/sdk-handler.ts` (3 sites)
- Modify: `apps/runtime/src/services/voice/korevg/korevg-session.ts` (1 site)
- Modify: `apps/runtime/src/services/llm/llm-queue.ts` (1 site)

**Steps:**

1. Read each file to identify the direct `getTraceStore().addEvent()` calls
2. Replace with `tracer.emit({ type, data })` — span context auto-attached from ALS
3. For sites outside a span scope, the orphan-emit warning will fire — add `tracer.withSpan()` wrapper if appropriate
4. Build and test
5. Commit: `fix(runtime): route all trace event emission through Tracer for span context`

---

## Task 9: Add boundary-crossing propagation helpers

Wire `injectTrace`/`extractTrace` at BullMQ and HTTP boundaries.

**Files:**

- Modify: BullMQ enqueue sites (from Phase 1 Task 7) — use `injectTrace()` instead of raw `getCurrentTraceId()`
- Modify: BullMQ workers (from Phase 1 Task 8) — use `extractTrace()` + `tracer.continueFrom()` + `tracer.run()`
- Modify: SearchAI client (from Phase 1 Task 9) — use `formatTraceparent(activeSpan().context)` for richer span context

**Steps:**

1. At BullMQ enqueue: `injectTrace(payload)` serializes current span context into payload
2. At BullMQ worker: `const ctx = extractTrace(payload)` → `const span = tracer.continueFrom(ctx, 'worker:inbound')` → `tracer.run(span, () => execute())`
3. At HTTP client: inject `traceparent` with current span's ID (not just traceId)
4. Build and test
5. Commit: `feat(runtime): add trace context inject/extract at BullMQ and HTTP boundaries`

---

## Task 10: Voice tracing migration

**Files:**

- Modify: `apps/runtime/src/observability/voice-trace.ts`
- Modify: Voice-related trace emitter calls

**Steps:**

1. Read voice-trace.ts — it generates per-turn traceId via `randomUUID()` (line 163) and uses `@opentelemetry/api` directly for OTEL spans (`trace.getTracer()` at line 144, `tracer.startSpan()` for STT/LLM/TTS phases). It also maintains module-scoped `Map<string, VoiceTurnContext>` (line 151) and `Map<string, RealtimeVoiceTurnContext>` (line 632).
2. Replace the per-turn `randomUUID()` traceId with session Tracer context: `tracer.withSpan('voice:turn', () => ...)`
3. Voice STT/TTS/barge-in events → `tracer.emit()` — NOTE: this file also uses OTEL spans for external observability (Deepgram, ElevenLabs latency). The OTEL span usage may need to coexist with the platform Tracer spans initially.
4. Build and test
5. Commit: `refactor(runtime): migrate voice tracing to Tracer/Span model`

---

## Task 11: Observatory UI — update span tree to use server-provided span context

**Note:** The observatory store ALREADY has a `getSpanTree()` method (line 888 of `observatory-store.ts`) that builds a proper tree from `spanId`/`parentSpanId`. The `SpanTree.tsx` component already consumes this tree. The main change is removing the `activeSpanStack` LIFO heuristic used for live span tracking (lines 87, 244, 653, 684, 701, 936-938) and ensuring the existing `getSpanTree()` handles the new `span_end` event type.

**Files:**

- Modify: `apps/studio/src/store/observatory-store.ts` — remove `activeSpanStack` LIFO heuristic (lines 87, 244, 653, 684, 701, 936-938), update event processing to handle `span_end` events for accurate span duration
- Modify: `apps/studio/src/store/observatory-store.ts` — update `getSpanTree()` (line 888) to gracefully skip events without `spanId`
- Modify: `apps/studio/src/components/observatory/SpanTree.tsx` — add backward-compat indicator for old events without `spanId`
- Modify: `apps/studio/src/components/observatory/DebugTabs.tsx` — `TracesTab` (line 385) also reads `spans` and `selectedSpanId` from the store; verify compatibility
- Modify: `apps/studio/src/components/observatory/NodeDetailPanel.tsx` — minor: verify span data reads

**Steps:**

1. Update `getSpanTree()` in observatory-store to gracefully skip events without `spanId` (backward compat with old traces)
2. Add span duration tracking from `span_end` events in the store's event processing
3. Show "some events predate span tracking" indicator when `events.some(e => !e.spanId)`
4. Remove `activeSpanStack` and `getActiveSpan()` LIFO pairing logic from observatory-store
5. Build: `pnpm build --filter=studio`
6. Commit: `feat(studio): update Observatory span tree for server-provided span context`

---

## Task 12: Tests

**New test files (~240 LOC):**

- `packages/shared-observability/src/__tests__/tracing/id.test.ts`
- `packages/shared-observability/src/__tests__/tracing/traceparent.test.ts`
- `packages/shared-observability/src/__tests__/tracing/propagation.test.ts`
- `apps/runtime/src/__tests__/tracing/tracer.test.ts`
- `apps/runtime/src/__tests__/tracing/span.test.ts`
- `apps/runtime/src/__tests__/tracing/write-pipeline.test.ts`
- `apps/runtime/src/__tests__/tracing/tracer-registry.test.ts`
- `apps/studio/src/__tests__/observatory-store-span-tree.test.ts` (tests for updated `getSpanTree()` + `span_end` handling)

**Modified test files:**

- `apps/runtime/src/__tests__/trace-emitter.test.ts` — remove span stack tests, add Tracer mock
- `apps/runtime/src/__tests__/trace-forwarder.test.ts` — rewrite for new Tracer-based forwarder
- `apps/runtime/src/__tests__/trace-wiring.test.ts` — update mock shapes

**Steps:**

1. Write all new unit tests
2. Update all modified test files
3. Run full test suite: `pnpm test`
4. Commit: `test(tracing): comprehensive span model fix test coverage`

---

## Task 13: Verification

**Steps:**

1. Build everything: `pnpm build`
2. Run all tests: `pnpm test`
3. Manual verification (if local env available):
   - Run a multi-agent session with handoffs → verify correct parent-child span tree in Observatory
   - Run concurrent turns on same session → verify no span corruption (each turn has independent span tree)
   - Check ClickHouse: `SELECT span_id, parent_span_id FROM platform_events WHERE trace_id = '...' LIMIT 20` → verify non-empty, correct tree structure
4. Verify orphan-emit warnings: search logs for `emit outside span scope` — should be zero after all call sites migrated

---

## Dependency Graph

```
Task 1 (shared-observability primitives) ──┬── Task 3 (TracerImpl/SpanImpl) ──┬── Task 5 (trace-emitter refactor)
Task 2 (span_end event type) ──────────────┤                                  ├── Task 6 (RuntimeExecutor wiring)
                                           ├── Task 4 (TracerRegistry) ────────┤
                                           │                                   ├── Task 7 (trace-forwarder rewrite)
                                           │                                   ├── Task 8 (fix addEvent bypasses)
                                           │                                   ├── Task 9 (boundary propagation)
                                           │                                   └── Task 10 (voice migration)
                                           │
                                           └── Task 11 (Observatory span tree update)
Task 12 (tests) ── depends on Tasks 1-11
Task 13 (verification) ── depends on all
```

**Estimated scope: 4 new file groups (~390 LOC across Tasks 1/3/4), 19 modified files, 12 test files**

---

## Relationship to Other Phases

- **Phase 1 (Trace Readiness)**: Phase 2 builds on the traceId plumbing. Phase 1's work is preserved — the middleware mounts, BullMQ propagation, WS handler traceId generation all stay. Phase 2 replaces the _span mechanism_ while keeping the _traceId infrastructure_.
- **Phase 3 (Trace Event Consolidation)**: Phase 3's Task 7c (wire trace-forwarder through trace-emitter) is superseded by Phase 2 Task 7 (rewrite trace-forwarder to use Tracer). Phase 3's Task 5 (refactor trace-emitter direct emit) should use `tracer.emit()` path established here.
- **Phase 4 (STI)**: `tracePath()` can optionally read span context from `tracer.activeSpan()` for finer-grained coordinate attribution.

---

## Plan Review Notes

_Reviewed 2026-03-12. Two passes: accuracy verification + completeness/correctness._

### Pass 1: Accuracy Findings (Fixed)

1. **Task 1, step 4 — Wrong file path for `parseTraceparent`**: Plan said "Update existing `observability.ts`" but `packages/shared-observability/src/observability.ts` does NOT exist. The private `parseTraceparent` function is at line 53 of `packages/shared-observability/src/middleware/observability.ts`. **Fixed** — corrected path.

2. **Task 5, step 6 — "module variables" vs closure variables**: Plan said "Remove `let currentSpanId`, `let spanStack` module variables" but these are closure-local variables inside `createTraceEmitter()` (lines 400-401 of `trace-emitter.ts`), not module-scoped. **Fixed** — corrected description.

3. **Problem #3 — "Module-scoped span stack"**: Same issue as above. The span stack is closure-scoped per emitter instance, not module-scoped. Still problematic for concurrency (one emitter per session, shared across concurrent turns). **Fixed** — corrected to "Closure-scoped span stack".

4. **Task 6 — Wrong file path for `RuntimeSession`**: Plan said "Modify: `apps/runtime/src/services/runtime-session.ts`" but this file does NOT exist. `RuntimeSession` is defined in `apps/runtime/src/services/execution/types.ts` at line 101. **Fixed** — corrected path.

5. **Task 8 — Wrong file path for feedback**: Plan said "Modify: `apps/runtime/src/services/feedback.ts`" but this file does NOT exist. The direct `addEvent` call is in `apps/runtime/src/routes/feedback.ts` at line 74. **Fixed** — corrected path.

6. **Task 2 — TraceEvent fields**: Plan said "add `traceId?`, `tenantId?`, `projectId?` to TraceEvent (if not already present)". Verified: `spanId?` and `parentSpanId?` already exist (lines 137-138), but `traceId`, `tenantId`, and `projectId` do NOT. **Fixed** — clarified the "(if not already present)" to be precise.

### Pass 2: Completeness & Correctness Findings (Fixed)

7. **Task 11 — `getSpanTree()` already exists**: Plan proposed creating a new `apps/studio/src/lib/build-span-tree.ts` file, but `observatory-store.ts` already has a `getSpanTree()` method (line 888) that builds a proper parent-child tree from `spanId`/`parentSpanId`. `SpanTree.tsx` already consumes this at line 106. No new file needed — the existing `getSpanTree()` just needs updating for `span_end` event handling and backward compat. **Fixed** — rewrote Task 11 to update existing code rather than create redundant new file.

8. **Task 11 — Missing component**: `DebugTabs.tsx` contains a `TracesTab` component (line 385) that reads `spans` and `selectedSpanId` from the observatory store. This component was not listed in the plan but will be affected by span model changes. **Fixed** — added to Task 11 file list.

9. **Task 10 — Voice tracing OTEL complexity underestimated**: The plan described voice migration as straightforward ("Replace with session Tracer"), but `voice-trace.ts` uses `@opentelemetry/api` directly (`trace.getTracer()`, `tracer.startSpan()`) for external OTEL observability of Deepgram/ElevenLabs/Anthropic API calls. The OTEL spans may need to coexist with platform Tracer spans during migration. **Fixed** — added detailed notes about OTEL span coexistence.

10. **Direct `addEvent` bypass count verified**: Plan claims 8 bypass sites. Actual grep confirms 8 non-pipeline `getTraceStore().addEvent()` calls: `sdk-handler.ts` (3: lines 930, 1018, 1967), `runtime-executor.ts` (2: lines 766, 1482), `llm-queue.ts` (1: line 530), `korevg-session.ts` (1: line 378), `routes/feedback.ts` (1: line 74). Count is accurate.

11. **Task 3 interfaces match Task 1**: The `TracerImpl` constructor signature (`{ sessionId, tenantId, projectId, writePipeline, defaultAttributes? }`) is consistent with what `RuntimeExecutor` can provide from the `RuntimeSession` type (which has `id`, `tenantId?`, `projectId?`). Interface compatibility confirmed.

12. **Dependency graph is accurate**: Tasks 3/4 correctly depend on Task 1+2. Tasks 5-10 correctly depend on Tasks 3+4 (and transitively 6 depends on 5). Task 11 correctly has an independent path from Task 1 (only needs shared interfaces, not runtime implementations).

### Items Verified Correct (No Changes Needed)

- All 13 primary file paths verified to exist (after fixes above)
- `SpanTree.tsx` and `NodeDetailPanel.tsx` confirmed at expected paths
- `observatory-store.ts` `activeSpanStack` LIFO heuristic confirmed (lines 87, 936-938)
- `trace-forwarder.ts` `let currentSpan` confirmed at line 134
- `runWithObservabilityContext` import path is `@abl/compiler/platform/observability` (confirmed in `handler.ts`, `server.ts`, `inbound-worker.ts`)
- `TraceEventType` union does not include `span_end` (confirmed, Task 2 is needed)
- `ExtendedTraceEventType` in `apps/studio/src/types/index.ts` does not include `span_end` (confirmed)
- Export map in `shared-observability/package.json` has `.`, `./middleware`, `./distributed-lock`, `./logger` — no `./tracing` yet (Task 1 adds it)
