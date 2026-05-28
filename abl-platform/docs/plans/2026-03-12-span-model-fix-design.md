# Span Model Fix — Design Spec

## Problem

The trace emitter uses a closure-based span stack (`let currentSpanId` + `let spanStack[]`) that produces broken parent-child relationships:

1. **Sparse parentSpanId**: Only 2 of 8 span-emitting functions (`logAgentEnter`, `emitDecision`) set `parentSpanId`. The remaining 6 (`logAgentExit`, `logFlowStepEnter/Exit`, `logFlowTransition`, `logDelegateStart/Complete`) set `spanId: currentSpanId` but never `parentSpanId`. LLM calls and tool calls set neither.
2. **Direct addEvent bypass**: `runtime-executor.ts` (2 sites), `feedback.ts`, `sdk-handler.ts` (3 sites), `korevg-session.ts` (1 site), and `llm-queue.ts` (1 site) call `getTraceStore().addEvent()` directly, constructing events with no span context at all.
3. **Concurrency corruption**: The span stack is module-scoped. Concurrent turns on the same session overwrite each other's `currentSpanId`.
4. **Trace forwarder duplication**: `trace-forwarder.ts` has its own broken `let currentSpan` variable — same problem.
5. **UI heuristic matching**: Observatory store maintains its own `activeSpanStack` and uses LIFO heuristics to pair agent_enter/exit — fragile, breaks on out-of-order events.

## Decisions

- **No backward compatibility** with existing stored traces — old sessions render with whatever they have.
- **AsyncLocalStorage** for in-process propagation, explicit inject/extract at serialization boundaries (hybrid model).
- **OTEL-aligned IDs**: 128-bit hex traceId, 64-bit hex spanId/parentSpanId, W3C traceparent format.
- **Full pipeline scope**: trace emitter + trace forwarder + Observatory UI + voice tracing subsystem.
- **Reusable primitives in `@agent-platform/shared-observability`**: `SpanContext`, `Span` interface, `Tracer` interface, `WritePipeline` interface, ID generation, W3C traceparent format/parse, and boundary-crossing helpers live in `shared-observability/tracing` — shared across runtime and future services. Runtime-specific `TracerImpl`, `SpanImpl`, `WritePipelineImpl`, and `TracerRegistry` live in `apps/runtime/`. (Search-AI has no tracing today; shared primitives enable future adoption.)
- **Compiler-layer spans inherit runtime traceId** — the forwarder receives the session-scoped `Tracer` and calls `tracer.startSpan()`, which inherits the current `traceId` from ALS. Compiler-layer spans are children under the same trace tree as runtime-layer spans. The forwarder generates new 64-bit hex `spanId` values to replace compiler UUIDs, but does **not** generate independent `traceId` values.
- **TypeScript types stay optional** — `TraceEvent.spanId?`, `TraceEvent.parentSpanId?`, and `TraceEventWithId.traceId?` remain optional to handle old events during rolling deploys. Additionally, `traceId?: string`, `tenantId?: string`, and `projectId?: string` must be **added** to `TraceEvent` in `trace-store.ts` (and `RedisTraceStore`'s local `TraceEvent` type) since `traceId` currently only exists on `TraceEventWithId`, and `tenantId`/`projectId` are emitted by `TracerImpl.emit()` but absent from the type. The `Tracer.emit()` guarantees all five are always populated on new events. `buildSpanTree()` gracefully skips events without `spanId`.
- **`span_end` event type** — `SpanImpl.end()` emits a `span_end` event containing `{ name, status, annotations, attributes }`. `span_end` must be added to: (1) `TraceEventType` union in `apps/runtime/src/types/index.ts` (the canonical event type union — note: `trace-store.ts` uses `type: string`, not the union), and (2) `ExtendedTraceEventType` in `apps/studio/src/types/index.ts` (the Studio-side event type union). Without these additions, TypeScript callers that switch on `event.type` will not recognize `span_end`, and `buildSpanTree()`'s `event.type === 'span_end'` branch will emit a type error.
- **Event `id` stays `crypto.randomUUID()`** — the `emit()` function uses `crypto.randomUUID()` (not `randomBytes(8).toString('hex')`) for event IDs to preserve backward compatibility. Existing code (ClickHouse schema, Studio store, mcp-debug) expects 36-char UUID format. Span IDs are 16-char hex; event IDs are 36-char UUID. These are different fields with different purposes.
- **Orphan-span emit logs a warning** — calling `tracer.emit()` outside any `withSpan()` scope generates a fresh traceId/spanId and logs `log.warn('emit outside span scope')`. All 23 modified files are deployed atomically. After deployment, orphan warnings indicate a missed call site and should be treated as bugs. No rate-limiting or suppression mechanism is needed since the migration is atomic.
- **Rolling deploy display strategy**: During the deploy window, sessions may contain a mix of old-format events (no `spanId`) and new-format events (with `spanId`). `buildSpanTree()` trees new-format events; old-format events appear only in the flat timeline view, not the span tree. The Observatory UI shows a "some events from this session predate span tracking" indicator when `events.some(e => !e.spanId)` is true. This is acceptable because the deploy window is short and the timeline view is unaffected.
- **OTEL divergences are intentional**: We use OTEL ID formats and W3C traceparent propagation but custom TypeScript interfaces (not `@opentelemetry/api`). Intentional divergences: no `traceFlags`/`traceState` on `SpanContext`; `recordException` omitted (callers use `setStatus('error', message)`); `inject`/`extract` are standalone helpers in `propagation.ts` (not a separate `TextMapPropagator` seam) since we have exactly one propagation format; `emit()` is a platform-specific extension (see Section 4).

## Design

### 1. Core Primitives

All interfaces and shared utilities live in `@agent-platform/shared-observability` under a new `./tracing` export. This extends the existing package (which already has W3C traceparent parsing in `observability.ts`, AsyncLocalStorage patterns in `request-id.ts`, and logger integration) without breaking existing exports.

#### SpanContext (propagation identity)

`SpanContext` is a minimal propagation value object — it carries only the fields needed to link spans across boundaries. Domain metadata (`agentName`, arbitrary attributes) lives on `Span`, not on `SpanContext`. This aligns with OTEL's separation (minus `traceFlags`/`traceState` which we don't need).

```ts
// packages/shared-observability/src/tracing/span-context.ts

interface SpanContext {
  traceId: string; // 128-bit hex (32 chars) — same across entire request tree
  spanId: string; // 64-bit hex (16 chars) — unique to this span
  parentSpanId?: string; // 64-bit hex — links to parent span
}
```

#### Span (active span with lifecycle)

```ts
// packages/shared-observability/src/tracing/span.ts

interface Span {
  readonly name: string; // human-readable label (e.g., 'agent:billing', 'voice:turn')
  readonly context: SpanContext;
  agentName?: string; // which agent owns this span
  attributes: Record<string, string>; // metadata (deployment, environment, etc.)
  setAttribute(key: string, value: string): void;
  addEvent(name: string, data?: Record<string, unknown>): void;
  setStatus(status: 'ok' | 'error', message?: string): void;
  end(): void;
}
```

**`name`**: The span name is stored on `SpanImpl`, passed through from `startSpan(name)` / `withSpan(name)` / `continueFrom(ctx, name)`. It is included in the span-end event written by `end()` and appears in `SpanNode` for Observatory display. Span names are the primary label in trace waterfall views.

**`addEvent()` vs `tracer.emit()`**: `span.addEvent(name, data)` appends to an internal `annotations: Array<{ name, data, timestamp }>` list on `SpanImpl`. These annotations are included in the span-end event's `data.annotations` field written by `end()`, making them visible in the Observatory span detail view. `tracer.emit({ type, data })` creates a full `TraceEvent` with span context auto-attached and writes it to the `WritePipeline` (Observatory, ClickHouse). All domain events (`agent_enter`, `llm_call`, `tool_call`) use `tracer.emit()`. `span.addEvent()` is for lightweight diagnostic annotations within a span (e.g., "cache hit", "retry attempt 2").

**`setStatus()` and `setAttribute()`**: Both are synchronous property mutations on `SpanImpl` with no external side effects. They must not throw. `setAttribute` updates the `attributes` record; these are included in events emitted within the span via `tracer.emit()` (which reads `span.attributes`) and in the span-end event.

**`end()` is idempotent**: Calling `end()` more than once has no effect. The implementation uses an `ended` guard flag:

```ts
private ended = false;
end(): void {
  if (this.ended) return;
  this.ended = true;
  try {
    this.writePipeline.write({
      id: crypto.randomUUID(),
      type: 'span_end',
      timestamp: new Date(),
      traceId: this.context.traceId,
      spanId: this.context.spanId,
      parentSpanId: this.context.parentSpanId,
      agentName: this.agentName,
      data: {
        name: this.name, // used by buildSpanTree() to populate SpanNode.name
        status: this.status,
        annotations: this.annotations,
        attributes: this.attributes,
      },
    });
  } catch (err) {
    log.error('span end write failed', { err: err instanceof Error ? err.message : String(err) });
  }
}
```

**Implementation constraint**: `Span.end()` must be internally non-throwing. It wraps write-pipeline errors in a `try/catch` and logs them, so that `withSpan()`'s `finally` block never swallows the original exception from the caller's function. `end()` writes directly to `writePipeline` — it does **not** go through `tracer.emit()`, so it does not require ALS context.

#### WritePipeline (fire-and-forget event sink)

```ts
// packages/shared-observability/src/tracing/write-pipeline.ts

/**
 * Generic event sink interface. Lives in shared-observability so it can be
 * referenced by Span.end() without importing runtime-specific TraceEventWithId.
 * The runtime's WritePipelineImpl narrows this to TraceEventWithId internally.
 */
interface WritePipeline {
  // Fire-and-forget: errors are caught internally and logged.
  // Never throws. Never awaited at call site.
  write(event: Record<string, unknown>): void;
}
```

**Why `Record<string, unknown>` instead of `TraceEventWithId`**: `TraceEventWithId` is defined in `apps/runtime/src/services/trace-store.ts` — importing it from `@agent-platform/shared-observability` would create a circular dependency (shared → runtime). The `WritePipeline` interface uses a generic record type; `WritePipelineImpl` (in `apps/runtime/`) casts to the concrete `TraceEventWithId` at its boundary. This keeps the shared package dependency-free from runtime types.

`WritePipelineImpl` wraps `getTraceStore().addEvent()`, the WebSocket broadcast, and `getEventStore().writeEvent()`, all fire-and-forget with internal error logging. `emit()` must remain `void` (never `Promise<void>`) because it is called in hot paths (every LLM call, every tool call) and from `Span.end()` inside `finally` blocks.

**Error logging ownership**: `WritePipelineImpl.write()` is the authoritative error logging layer — it catches and logs all write failures internally. The outer `try/catch` in `TracerImpl.emit()` and `SpanImpl.end()` exists only as a safety net to prevent propagation; these outer catches should NOT log (they trust the inner layer already logged). This avoids duplicate log entries for the same failure.

#### Tracer (session-scoped, single entry point)

```ts
// packages/shared-observability/src/tracing/tracer.ts

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
  runSync<T>(span: Span, fn: () => T): T; // synchronous ALS entry (Express middleware)
  run<T>(span: Span, fn: () => T | Promise<T>): T | Promise<T>; // ALS entry, returns fn()'s return directly
  activeSpan(): Span | null;
  emit(event: { type: string; data: Record<string, unknown>; durationMs?: number }): void;
  continueFrom(context: SpanContext, name: string): Span;
}
```

**Usage rule**: Use `withSpan()` for all in-process spans. Use `startSpan()` + `tracer.run(span, fn)` only after `continueFrom()` at a serialization boundary where you need manual lifetime control. Never use `startSpan()` alone or `continueFrom()` alone for in-process work — downstream `tracer.emit()` calls will not see the span and will fire orphan warnings.

**ALS context loss**: Node.js `AsyncLocalStorage` propagates through `Promise`, `setTimeout`, `setImmediate`, and `process.nextTick` (Node 16+). However, context is lost if code escapes the `fn` scope — e.g., a `setTimeout` callback that fires _after_ `withSpan()`'s `fn` has resolved. For retry backoff patterns (e.g., `llm-queue.ts` retry with `setTimeout`), capture the span explicitly in a closure and call `tracer.run(span, retryFn)` to re-enter ALS. Orphan warnings in production indicate this class of context loss and should be fixed by explicit `run()` re-entry.

**`run(span, fn)` vs `runSync(span, fn)`**: Both enter `span` into AsyncLocalStorage for the duration of `fn`. `run()` is async (`Promise<T>`) and used in BullMQ workers. `runSync()` is synchronous (`T`) and used in Express middleware where `next()` is synchronous — calling `await` on `next()` would drop the returned `Promise` and break Express error handling. `propagation.ts` uses `tracer.runSync()` for `traceMiddleware` and `tracer.run()` for BullMQ workers.

One `Tracer` instance per session, stored on the `RuntimeSession` object and registered in a `TracerRegistry` (see Section 11).

#### TracerImpl Constructor (runtime-specific)

```ts
// apps/runtime/src/services/tracing/tracer.ts

class TracerImpl implements Tracer {
  private fallbackTraceId = generateTraceId(); // stable per-session orphan traceId

  constructor(config: {
    sessionId: string;
    tenantId: string;
    projectId: string;
    writePipeline: WritePipeline;
    defaultAttributes?: Record<string, string>; // deploymentId, environment, etc.
  });
}
```

The `TraceEmitter` layer (Section 6) handles PII scrubbing, secret scrubbing, verbosity gating, and custom dimensions. `TracerImpl` is a lower layer responsible only for span context propagation and event enrichment with `traceId`/`spanId`/`parentSpanId`/`tenantId`/`projectId`. The layering is: `TraceEmitter.logLLMCall()` → scrub/gate → `tracer.emit()` → enrich with span context → `writePipeline.write()`.

### 2. ID Generation

```ts
// packages/shared-observability/src/tracing/id.ts

import { randomBytes } from 'crypto';

function generateTraceId(): string {
  return randomBytes(16).toString('hex'); // 32 chars
}

function generateSpanId(): string {
  return randomBytes(8).toString('hex'); // 16 chars
}
```

**Performance**: `randomBytes(8/16)` is called synchronously per span and per orphan emit. Under normal load (~5 spans + ~15 emits per turn), this is ~20 synchronous entropy pool reads per turn. Node.js crypto is not a known bottleneck at this call frequency. If profiling shows contention (e.g., >1000 concurrent sessions), replace with a pre-filled pool using `randomFillSync` on a rotating `Buffer`. No pre-optimization is needed at launch.

**AsyncLocalStorage overhead**: ALS context propagation through `withSpan()` adds one `AsyncResource` allocation per span. For 5 nested `withSpan()` calls per turn this is negligible. ALS lookup (`getStore()`) is O(1).

**Note**: The existing `shared-observability/middleware/observability.ts` uses `randomUUID()` for trace IDs. The new hex-based generators replace this for OTEL alignment. The existing middleware's `ObservabilityContext.traceId` should be updated to use `generateTraceId()` for consistency.

### 3. W3C Traceparent Format

Used for inject/extract at serialization boundaries. Enhances the existing W3C parsing in `shared-observability/middleware/observability.ts` (lines 53-62) with a standalone format function:

```
traceparent: 00-{traceId}-{spanId}-01
```

Parse/format:

```ts
// packages/shared-observability/src/tracing/traceparent.ts

function formatTraceparent(ctx: SpanContext): string {
  return `00-${ctx.traceId}-${ctx.spanId}-01`;
}

function parseTraceparent(header: string): SpanContext | null {
  const parts = header.split('-');
  if (parts.length !== 4 || parts[0] !== '00') return null;
  const [, traceId, spanId] = parts;
  // W3C spec: traceId must be 32 hex chars, spanId must be 16 hex chars
  // Case-insensitive: W3C spec requires lowercase, but some SDKs (Java OTEL) emit uppercase.
  // Normalize to lowercase on parse for consistent downstream comparison.
  if (!/^[0-9a-fA-F]{32}$/.test(traceId) || !/^[0-9a-fA-F]{16}$/.test(spanId)) return null;
  return { traceId: traceId.toLowerCase(), spanId: spanId.toLowerCase() };
}
```

The returned `SpanContext` has `parentSpanId: undefined` by design — it represents the remote span's identity. `continueFrom()` promotes its `spanId` to the `parentSpanId` of the newly created child span.

**Note on existing `observability.ts`**: The private `parseTraceparent` in `shared-observability/middleware/observability.ts` (lines 53-62) does not validate hex format. The new version in `traceparent.ts` is stricter (validates hex length and normalizes to lowercase). The existing middleware should be updated to import from `./tracing/traceparent` for consistency (added to Modified Files). After the import, `ctx.spanId` from `parseTraceparent()` maps to the existing `ObservabilityContext.spanId` field — this is the incoming remote span's ID. For span-aware services, `traceMiddleware` in `propagation.ts` supersedes the middleware's manual trace context handling.

### 4. AsyncLocalStorage Propagation

```ts
// apps/runtime/src/services/tracing/tracer.ts

import { AsyncLocalStorage } from 'async_hooks';
import {
  type Span,
  type SpanContext,
  type Tracer,
  type WritePipeline,
  generateTraceId,
  generateSpanId,
} from '@agent-platform/shared-observability/tracing';

const spanStorage = new AsyncLocalStorage<Span>();

class TracerImpl implements Tracer {
  private sessionId: string;
  private tenantId: string;
  private projectId: string;
  private writePipeline: WritePipeline;
  private defaultAttributes: Record<string, string>;
  private fallbackTraceId: string; // stable per-session, used for orphan emits

  activeSpan(): Span | null {
    return spanStorage.getStore() ?? null;
  }

  startSpan(
    name: string,
    options?: { agentName?: string; attributes?: Record<string, string> },
  ): Span {
    const parent = this.activeSpan();
    const context: SpanContext = {
      traceId: parent?.context.traceId ?? generateTraceId(),
      spanId: generateSpanId(),
      parentSpanId: parent?.context.spanId,
    };
    return new SpanImpl(name, context, this.writePipeline, {
      agentName: options?.agentName,
      attributes: { ...this.defaultAttributes, ...options?.attributes },
    });
  }

  continueFrom(context: SpanContext, name: string): Span {
    // Reuses the incoming traceId — preserves distributed trace link.
    // Does NOT enter ALS — caller must use tracer.run(span, fn).
    const newCtx: SpanContext = {
      traceId: context.traceId,
      spanId: generateSpanId(),
      parentSpanId: context.spanId,
    };
    return new SpanImpl(name, newCtx, this.writePipeline, {
      attributes: { ...this.defaultAttributes },
    });
  }

  runSync<T>(span: Span, fn: () => T): T {
    return spanStorage.run(span, fn);
  }

  run<T>(span: Span, fn: () => T | Promise<T>): T | Promise<T> {
    // Not async — avoids extra microtask wrapping. spanStorage.run() returns
    // whatever fn() returns (T or Promise<T>) directly.
    return spanStorage.run(span, fn);
  }

  async withSpan<T>(
    name: string,
    fn: () => T | Promise<T>,
    options?: { agentName?: string; attributes?: Record<string, string> },
  ): Promise<T> {
    const span = this.startSpan(name, options);
    try {
      return await spanStorage.run(span, fn);
    } catch (err) {
      span.setStatus('error', err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      // span.end() is internally non-throwing and idempotent.
      span.end();
    }
  }

  emit(event: { type: string; data: Record<string, unknown>; durationMs?: number }): void {
    const span = this.activeSpan();

    // Warn when emitting outside a span scope — should not occur after atomic deploy.
    if (!span) {
      log.warn('emit outside span scope', { type: event.type, sessionId: this.sessionId });
    }

    try {
      // Orphan path: use a deterministic session-level traceId so all orphan
      // events from the same session share a traceId and can be queried together.
      // The spanId is still random per-emit (each orphan is its own span).
      const traceEvent = {
        id: crypto.randomUUID(), // 36-char UUID — backward compatible with existing stores
        sessionId: this.sessionId,
        tenantId: this.tenantId,
        projectId: this.projectId,
        type: event.type,
        timestamp: new Date(),
        durationMs: event.durationMs,
        data: event.data,
        traceId: span?.context.traceId ?? this.fallbackTraceId,
        spanId: span?.context.spanId ?? generateSpanId(),
        parentSpanId: span?.context.parentSpanId,
        agentName: span?.agentName,
      };
      this.writePipeline.write(traceEvent);
    } catch (err) {
      // Fire-and-forget: never let write failures propagate to callers
      log.error('tracer emit failed', { err: err instanceof Error ? err.message : String(err) });
    }
  }
}
```

**Nested `withSpan()` behavior**: Each `spanStorage.run(span, fn)` creates a child ALS context that shadows the parent for the duration of `fn`. When `fn` resolves, ALS automatically restores the parent context — no manual stack management needed. Concurrent child spans via `Promise.all()` each inherit the parent context independently.

### 5. Boundary Crossing

#### HTTP (Express middleware)

Outgoing requests:

```ts
// packages/shared-observability/src/tracing/propagation.ts

function injectTraceHeaders(headers: Record<string, string>, tracer: Tracer): void {
  const span = tracer.activeSpan();
  if (span) {
    headers['traceparent'] = formatTraceparent(span.context);
  }
}
```

Incoming requests:

```ts
// continueFrom() creates a child span linked to the extracted context.
// It does NOT set AsyncLocalStorage — tracer.runSync() is used to make it active.
function traceMiddleware(tracer: Tracer) {
  return (req, res, next) => {
    const traceparent = req.headers['traceparent'] as string | undefined;
    if (traceparent) {
      const ctx = parseTraceparent(traceparent);
      if (ctx) {
        const span = tracer.continueFrom(ctx, `http:${req.method} ${req.path}`);
        res.on('finish', () => span.end());
        // runSync: synchronous ALS entry — Express next() is synchronous.
        // Using async run() here would drop the Promise and break error handling.
        tracer.runSync(span, () => next());
        return;
      }
    }
    next();
  };
}
```

#### BullMQ Jobs

Producer (inject) — the `_trace` key is the propagation field for BullMQ job data:

```ts
// packages/shared-observability/src/tracing/propagation.ts

// Carrier is Record<string, unknown> to support BullMQ job data (which is not
// Record<string, string>). The _trace value is always a string.
function injectTrace(carrier: Record<string, unknown>, tracer: Tracer): void {
  const span = tracer.activeSpan();
  if (span) {
    carrier._trace = formatTraceparent(span.context);
  }
}

function extractTrace(carrier: Record<string, unknown>): SpanContext | null {
  const trace = carrier._trace;
  return typeof trace === 'string' ? parseTraceparent(trace) : null;
}
```

```ts
const jobData = { sessionId, content, tenantId };
injectTrace(jobData, tracer);
queue.add('persist', jobData);
```

Worker (extract) — must set ALS so downstream `emit()` calls see the span:

```ts
async function workerHandler(job) {
  const ctx = extractTrace(job.data);
  if (ctx) {
    const span = tracer.continueFrom(ctx, 'bullmq:persist-message');
    await tracer.run(span, async () => {
      try {
        // ... do work — tracer.emit() here sees span via AsyncLocalStorage
      } finally {
        span.end();
      }
    });
  }
}
```

#### Redis Pub/Sub (cross-pod traces)

No change needed. Trace events carry `traceId`, `spanId`, `parentSpanId` as serialized JSON fields. The span tree is in the data, not in process-local context.

#### WebSocket (SDK)

SDK can send `traceparent` in the WebSocket handshake headers or first message payload. Handler extracts and creates a linked span.

### 6. Trace Emitter Refactor

The emitter becomes a thin session-scoped wrapper around `Tracer`:

- **Deleted**: `let currentSpanId`, `let spanStack[]`, manual `spanId: currentSpanId` on every emit, and the internal `emit()` function (`trace-emitter.ts:113`) which is superseded by `WritePipelineImpl.write()`.
- **Kept**: `logLLMCall()`, `logToolCall()`, `logAgentEnter()` etc. — same signatures
- **Kept**: PII scrubbing, secret scrubbing, verbosity gating, custom dimensions
- **Changed**: All `logXxx()` functions call `tracer.emit()` instead of constructing events manually

**Call-site layering**: The WebSocket handler (`handler.ts`) wraps the entire turn in `tracer.withSpan('turn:message', fn)`. Within that scope:

- `logAgentEnter()` calls `tracer.emit({ type: 'agent_enter', data: { ... } })` — it emits an event within the existing span, it does NOT create a new span. The agent-level span is created by the handler or runtime-executor via `tracer.withSpan('agent:<name>', fn)`.
- `logAgentExit()`, `logFlowStepEnter/Exit()`, `logFlowTransition()`, `logDelegateStart/Complete()` — all become `tracer.emit()` calls within the current span scope.
- `logLLMCall()`, `logToolCall()` — `tracer.emit()` calls; these inherit span context from ALS.

Direct `addEvent()` callers (`runtime-executor.ts` (2 sites), `feedback.ts`, `sdk-handler.ts` (3 sites), `korevg-session.ts`, `llm-queue.ts`) are replaced with `tracer.emit()` — span context auto-attached from AsyncLocalStorage.

**Note**: The existing `TraceEmitter` has an internal `emit()` function with signature `(event: TraceEvent) => void` at `trace-emitter.ts:113`. The new `Tracer.emit()` has a different signature: `{ type, data, durationMs? }`. The old internal `emit()` and the `getTraceStore().addEvent()` call it wraps are both deleted — `WritePipelineImpl.write()` replaces them.

### 7. Trace Forwarder Refactor

The forwarder stops managing spans. It receives the session-scoped `Tracer` and delegates:

- **Deleted**: `let currentSpan`, `startSpan()`/`getCurrentSpan()` with own state, the no-traceEmitter fallback path (`void traceStore.addEvent()` at line 153), and the positional-args overload — all callers now provide a `Tracer`.
- **Changed**: `logLLMCall()`, `logToolCall()`, etc. call `tracer.emit()` with `source: 'construct-layer'`
- **Changed**: `startSpan()` calls `tracer.startSpan()` — inherits the current `traceId` from ALS context. Compiler-layer spans are children under the same trace tree as runtime-layer spans. The forwarder only generates new `spanId` values (64-bit hex) to replace compiler UUIDs; it does **not** generate independent `traceId` values.

Shrinks from ~220 LOC to ~80 LOC.

### 8. Observatory UI Refactor

The Studio's `observatory-store.ts` drops its heuristic span matching:

- **Deleted**: `activeSpanStack: string[]`, `startSpan()`, `endSpan()`, `addEventToSpan()`, LIFO matching logic, synthetic `span-step-${stepName}-${Date.now()}` IDs for flow steps
- **Replaced with**: Pure `buildSpanTree(events)` function that builds a tree from `parentSpanId` relationships

```ts
interface SpanNode {
  spanId: string;
  parentSpanId?: string;
  name?: string; // span name from span-end event (e.g., 'agent:billing')
  agentName?: string;
  startTime?: Date; // min(events[].timestamp)
  endTime?: Date; // max(events[].timestamp)
  durationMs?: number; // endTime - startTime
  events: TraceEventWithId[];
  children: SpanNode[];
}

function buildSpanTree(events: TraceEventWithId[]): SpanNode[] {
  const spans = new Map<string, SpanNode>();

  for (const event of events) {
    if (!event.spanId) continue;
    let node = spans.get(event.spanId);
    if (!node) {
      node = {
        spanId: event.spanId,
        parentSpanId: event.parentSpanId,
        agentName: event.agentName,
        events: [],
        children: [],
      };
      spans.set(event.spanId, node);
    }
    node.events.push(event);

    // Populate span name from span_end event data
    if (event.type === 'span_end' && event.data?.name) {
      node.name = event.data.name as string;
    }
  }

  // Derive timing from events and sort events within each span.
  //
  // TIMEZONE HANDLING: Events arrive from two paths with different timestamp formats:
  //   1. Live WebSocket: `timestamp` is a JS Date object (UTC) — no conversion needed.
  //   2. Historical ClickHouse load: `timestamp` is a bare string "2026-03-12 14:30:00.292"
  //      (no T separator, no Z suffix, no timezone offset). ClickHouse stores DateTime64
  //      columns as UTC, but the @clickhouse/client returns them as bare strings. If passed
  //      directly to `new Date()`, JavaScript interprets them as LOCAL time, causing spans
  //      to shift by the server/browser timezone offset.
  //
  // Solution: Inline the same logic used by `parseClickHouseTimestamp()` from
  // `@agent-platform/database` (packages/database/src/clickhouse.ts:81-87).
  // We cannot import that function here because clickhouse.ts has server-only
  // top-level imports (@clickhouse/client), and buildSpanTree runs client-side
  // in the browser (Zustand store in apps/studio/).
  //
  // NOTE: The existing `parseClickHouseTimestamp` handles three cases:
  //   - Date objects → returned as-is
  //   - Strings with timezone info (Z or ±HH:MM suffix) → parsed as-is
  //   - Bare strings → space→T replacement + 'Z' suffix → parsed as UTC
  //
  // Future improvement: Extract `parseClickHouseTimestamp` to a browser-safe
  // shared utility (e.g., `@agent-platform/shared-observability/timestamps`)
  // so both server stores and client buildSpanTree can import the same function.
  function parseTimestamp(ts: string | Date): Date {
    if (ts instanceof Date) return isNaN(ts.getTime()) ? new Date(0) : ts;
    let d: Date;
    if (ts.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(ts)) {
      d = new Date(ts);
    } else {
      // ClickHouse bare format: "2026-03-12 14:30:00.292" → treat as UTC
      d = new Date(ts.replace(' ', 'T') + 'Z');
    }
    // Guard against malformed timestamps propagating NaN into React rendering.
    // Epoch fallback ensures sort stability and visible "something is wrong" in UI.
    return isNaN(d.getTime()) ? new Date(0) : d;
  }

  for (const node of spans.values()) {
    node.events.sort(
      (a, b) => parseTimestamp(a.timestamp).getTime() - parseTimestamp(b.timestamp).getTime(),
    );
    if (node.events.length > 0) {
      node.startTime = parseTimestamp(node.events[0].timestamp);
      node.endTime = parseTimestamp(node.events[node.events.length - 1].timestamp);
      node.durationMs = node.endTime.getTime() - node.startTime.getTime();
    }
  }

  // Break cycles before building parent-child links.
  // Cyclic parentSpanId (A→B→A) would cause infinite render loops in React.
  // The back-edge is broken at the CHILD (the node whose parentSpanId points
  // back into the ancestor chain), not at the ancestor. For A→B→A: B's
  // parentSpanId ('A') is in the stack, so B is demoted to root.
  const visited = new Set<string>();
  const inStack = new Set<string>();
  function breakCycles(spanId: string): void {
    if (inStack.has(spanId)) return; // cycle target — caller breaks the edge
    if (visited.has(spanId)) return;
    visited.add(spanId);
    inStack.add(spanId);
    const node = spans.get(spanId);
    if (node?.parentSpanId) {
      const parentId = node.parentSpanId;
      if (inStack.has(parentId)) {
        // Back edge detected: this node points to an ancestor in the DFS stack.
        // Break the edge here at the child, not at the ancestor.
        node.parentSpanId = undefined;
      } else if (spans.has(parentId)) {
        breakCycles(parentId);
      }
    }
    inStack.delete(spanId);
  }
  for (const spanId of spans.keys()) breakCycles(spanId);

  const roots: SpanNode[] = [];
  for (const node of spans.values()) {
    if (node.parentSpanId && spans.has(node.parentSpanId)) {
      spans.get(node.parentSpanId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}
```

Works identically for live WebSocket events and historical ClickHouse loads.

**`span_end` event delivery**: `SpanImpl.end()` writes `span_end` events through `WritePipeline`, which includes the WebSocket broadcast path. The Studio store's `addEvent()` action must not filter out `span_end` events — they carry the span `name`, `status`, and `annotations` needed by `buildSpanTree()`. If the existing `addEvent()` has a type whitelist, `span_end` must be added to it.

**`span_end` ClickHouse storage**: `span_end` event data (`name`, `status`, `annotations`, `attributes`) is stored in the unindexed `data` JSON blob column — same as all other event types. No DDL change is needed. The span `name` is queryable via `JSONExtractString(data, 'name')` for ad-hoc analysis. If span-level queries become common, a materialized column can be added later.

**Old-format session rendering**: When `buildSpanTree()` returns an empty `roots` array (all events lack `spanId` — pure old-format session), the Observatory UI must show the flat timeline view as the primary display, with the "some events from this session predate span tracking" indicator. The span tree panel should show "No span data available" rather than a blank panel. The indicator check (`events.some(e => !e.spanId)`) must be evaluated before the span tree render path to gate the correct view.

**`addEvent()` migration scope**: The `addEvent()` action body currently has two categories of logic:

1. **Span lifecycle management** (`startSpan`, `endSpan`, `addEventToSpan`, synthetic step span IDs, `activeSpanStack`) — **all removed**, replaced by `buildSpanTree()`.
2. **Side-effect tracking** (flow node creation/updates, static graph execution state via `updateNodeExecutionState`/`updateAppNodeExecutionState`, step metrics, token counts, constraint history, client timing) — **all kept unchanged**. These are event-type-driven side effects that do not depend on the span stack.

The synthetic `stepSpanId` pattern (`span-step-${stepName}-${Date.now()}`) for `flow_step_enter` is removed; the span tree for flow steps is built from the `parentSpanId` on the runtime-emitted event.

The migration must also update:

1. Replace the Studio `Span` type (`apps/studio/src/types/index.ts`, with `status`, `startTime`, `endTime`, `events[]`) with `SpanNode` (built from `buildSpanTree()`).
2. Replace `SpanTreeNode` type (`apps/studio/src/types/index.ts`, with `{ span: Span; children: SpanTreeNode[]; depth: number }`) — call sites destructuring `node.span.spanId` change to `node.spanId`.
3. Remove `activeSpanStack`, `startSpan()`, `endSpan()`, `addEventToSpan()` from Zustand state.
4. Rewrite the `addEvent()` action to simply append the event to a flat list; `buildSpanTree()` is called as a computed/derived value when the UI renders the span tree.
5. The existing `getSpanTree(): SpanTreeNode[]` computed method delegates to `buildSpanTree()` instead of walking the `spans` Map.
6. The `session_ended` sweep that calls `endSpan()` on running spans is removed. `buildSpanTree()` derives timing from event timestamps — spans without explicit `span_end` events are treated as ended at their last event's timestamp. No manual cleanup is needed on session close.

### 9. Voice Tracing Subsystem

The voice subsystem has a parallel tracing path in `voice-trace.ts` and `livekit-trace-hooks.ts` that creates its own `traceId`/`spanId` using `randomUUID()` and creates OTEL spans directly via `@opentelemetry/api`.

This must be migrated to accept a `Tracer` instance:

- `voice-trace.ts`: Replace manual `VoiceTurnContext` with `tracer.withSpan('voice:turn', ...)`. Voice-specific attributes (ASR quality, TTS latency, barge-in) become span attributes.
- `livekit-trace-hooks.ts`: Replace `startVoiceTurn({ traceId: undefined, spanId: undefined })` with `tracer.startSpan('livekit:turn')`. Hooks receive the `Tracer` from the voice session.
- `realtime-voice-executor.ts` and `agent-worker.ts`: Thread the `Tracer` through to voice execution.

Without this, voice events appear as disconnected orphan roots in `buildSpanTree()`.

**Voice `agentName`**: Voice sessions must pass `agentName` when creating spans (e.g., `tracer.startSpan('voice:turn', { agentName })`). The agent name is available from the voice session's agent configuration. Without this, voice spans will have `agentName: undefined` and won't group correctly in Observatory's agent-filtered views.

### 10. OtelTraceStore Bridge

The `OtelTraceStore` bridge (`observability/otel-trace-bridge.ts`) creates child OTEL spans under a root span from `startTrace()`. Note: this bridge operates on the **compiler-layer** `TraceStore`/`TraceContextManager` abstraction, not the runtime's `TraceEvent` system — it has no shared interface with the runtime event pipeline today. After this refactor, trace events carry OTEL-aligned `traceId` values. The bridge should be updated to use the `traceId` from the event when creating OTEL spans, so they correlate to the same distributed trace in Jaeger/Tempo. This is a deferred improvement — the bridge is guarded by `OTEL_EXPORTER_OTLP_ENDPOINT` (off by default) and is non-blocking.

### 11. Tracer Session Registry

HTTP route handlers (`feedback.ts`) and BullMQ workers (`message-persistence-queue.ts`) need to access the correct `Tracer` for a session but have no WebSocket reference. A session-scoped registry provides lookup:

```ts
// apps/runtime/src/services/tracing/tracer-registry.ts

class TracerRegistry {
  private tracers = new Map<string, { tracer: Tracer; lastAccessed: number }>();
  private sweepInterval: NodeJS.Timeout | null = null;
  private readonly maxSize = 10_000;
  private readonly ttlMs = 30 * 60 * 1000; // 30 min

  // Idempotent: calling start() when already started is a no-op (prevents double setInterval).
  start(): void {
    if (this.sweepInterval) return;
    this.sweepInterval = setInterval(() => this.sweep(), 5 * 60 * 1000);
  }

  // Idempotent: calling stop() when already stopped is a no-op.
  stop(): void {
    if (this.sweepInterval) {
      clearInterval(this.sweepInterval);
      this.sweepInterval = null;
    }
  }

  // Last-writer-wins: if a second connection registers the same sessionId (e.g.,
  // browser reconnect during network blip), the new Tracer replaces the old one.
  // The old Tracer's in-flight async chains continue emitting via their captured
  // reference — they do NOT look up the registry. Only HTTP routes and BullMQ
  // workers use the registry for lookup, and they should get the newest Tracer.
  register(sessionId: string, tracer: Tracer): void;
  get(sessionId: string): Tracer | null;
  unregister(sessionId: string): void;

  // For tests: resets singleton. Not exported from production barrel.
  static _resetForTest(): void {
    registryInstance = null;
  }
}

// Module-level singleton, same pattern as getTraceStore()
let registryInstance: TracerRegistry | null = null;
export function getTracerRegistry(): TracerRegistry {
  if (!registryInstance) {
    registryInstance = new TracerRegistry();
    registryInstance.start();
  }
  return registryInstance;
}
```

- **Registered** in the WebSocket handler when a session starts.
- **Unregistered** on session close.
- **TTL eviction**: entries older than 30 min are evicted on access (lazy) and via a periodic sweep (every 5 min).
- **Max size**: 10,000 entries. If exceeded, oldest-accessed entries are evicted first.
- **Lifecycle**: `start()` sets up the periodic sweep `setInterval`. `stop()` clears it — must be called during graceful shutdown and in test `afterAll` to prevent process hangs.
- HTTP routes call `getTracerRegistry().get(sessionId)` — if null (session closed or evicted), they create a standalone `Tracer` for the request scope (using `sessionId`, `tenantId`, `projectId` from the request/session record).

## Rollback

If the new tracing has a production defect:

- **Runtime-only rollback**: Roll back all runtime pods to the previous image. Old code ignores the extra `traceId`/`spanId`/`parentSpanId` fields on stored events. In-flight sessions during rollback will have a mixed event stream (new-format followed by old-format). If Studio is NOT rolled back, `buildSpanTree()` silently skips old-format events (no `spanId`); they remain visible in the flat timeline view only, consistent with the rolling-deploy display strategy. This is acceptable for the rollback window.
- **Full rollback (runtime + Studio)**: Roll back both. The old `observatory-store.ts` LIFO logic handles events with or without `spanId`. Old-format events render normally in the heuristic span tree.
- **Recommendation**: Roll back runtime and Studio together to avoid the split-view experience.
- The rollback window is the K8s rolling update duration (~2 min). No database rollback is required.

## Migration Monitoring

**Tracking migration completeness**:

1. The orphan warning counter (`log.warn('emit outside span scope')`) should be wired to a metric: `trace.emit.orphan_count` (tagged by `event_type`). Alert if this exceeds 0 in steady state post-deploy.
2. A ClickHouse query for migration progress: `SELECT count() FROM abl_platform.platform_events WHERE span_id = '' AND timestamp > {deploy_time}`. This count should trend to zero as old-pod events age out.
3. Migration is complete when: (a) all pods run new image, (b) `trace.emit.orphan_count` = 0 for 24 hours, (c) ClickHouse orphan rate for new events < 0.1%.

## File Changes

### New Files (10)

| File                                                          | Purpose                                                                                                                                                                                                                                                                                                                                                | ~LOC |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| `packages/shared-observability/src/tracing/index.ts`          | Barrel re-exports: `SpanContext` from `./span-context`, `Span` from `./span`, `WritePipeline` from `./write-pipeline`, `Tracer` from `./tracer`, `generateTraceId`/`generateSpanId` from `./id`, `formatTraceparent`/`parseTraceparent` from `./traceparent`, `injectTrace`/`extractTrace`/`injectTraceHeaders`/`traceMiddleware` from `./propagation` | ~20  |
| `packages/shared-observability/src/tracing/span-context.ts`   | `SpanContext` type                                                                                                                                                                                                                                                                                                                                     | ~15  |
| `packages/shared-observability/src/tracing/id.ts`             | `generateTraceId`/`generateSpanId` (hex crypto)                                                                                                                                                                                                                                                                                                        | ~15  |
| `packages/shared-observability/src/tracing/span.ts`           | `Span` interface                                                                                                                                                                                                                                                                                                                                       | ~25  |
| `packages/shared-observability/src/tracing/write-pipeline.ts` | `WritePipeline` interface (generic `Record<string, unknown>` to avoid circular dep)                                                                                                                                                                                                                                                                    | ~10  |
| `packages/shared-observability/src/tracing/tracer.ts`         | `Tracer` interface (shared contract for TracerImpl)                                                                                                                                                                                                                                                                                                    | ~25  |
| `packages/shared-observability/src/tracing/traceparent.ts`    | W3C traceparent `formatTraceparent`/`parseTraceparent`                                                                                                                                                                                                                                                                                                 | ~30  |
| `packages/shared-observability/src/tracing/propagation.ts`    | `injectTrace`/`extractTrace` helpers, Express `traceMiddleware` (uses `import type` for Express types to avoid runtime dep in non-Express consumers)                                                                                                                                                                                                   | ~60  |
| `apps/runtime/src/services/tracing/tracer.ts`                 | `TracerImpl`, `SpanImpl`, `WritePipelineImpl` — runtime-specific                                                                                                                                                                                                                                                                                       | ~250 |
| `apps/runtime/src/services/tracing/tracer-registry.ts`        | `TracerRegistry` + `getTracerRegistry()` singleton — separate file for testability                                                                                                                                                                                                                                                                     | ~80  |

**Note on `WritePipelineImpl`**: The runtime's `WritePipelineImpl` wraps the process-level `getTraceStore()` singleton (not a per-session store). The `Tracer` is session-scoped and carries `sessionId` which is passed to `addEvent()` — the store itself is shared. `WritePipelineImpl` is also responsible for the `TraceEvent` (camelCase) → `PlatformEvent` (snake_case) field name mapping before writing to ClickHouse via the EventStore.

### Modified Files (23)

| File                                                             | Change                                                                                                                                                                                                                                                                                                                    | Risk   |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `packages/shared-observability/package.json`                     | Add `./tracing` export: `"./tracing": { "import": "./dist/tracing/index.js", "types": "./dist/tracing/index.d.ts" }`. **Build blocker** — all runtime/studio imports from `@agent-platform/shared-observability/tracing` fail with `ERR_PACKAGE_PATH_NOT_EXPORTED` without this. Must be built before dependent packages. | Medium |
| `packages/shared-observability/src/middleware/observability.ts`  | Import `parseTraceparent`/`generateTraceId` from `./tracing` for consistency                                                                                                                                                                                                                                              | Low    |
| `apps/runtime/src/services/trace-emitter.ts`                     | Delete span stack, delegate to Tracer. ~600 to ~300 LOC                                                                                                                                                                                                                                                                   | Medium |
| `apps/runtime/src/services/execution/trace-forwarder.ts`         | Delete own state, accept Tracer. ~220 to ~80 LOC                                                                                                                                                                                                                                                                          | Low    |
| `apps/runtime/src/websocket/handler.ts`                          | Create Tracer per session, register in TracerRegistry, wrap turns in withSpan. 3 sites                                                                                                                                                                                                                                    | Medium |
| `apps/runtime/src/services/runtime-executor.ts`                  | Replace direct addEvent with tracer.emit. 2 sites                                                                                                                                                                                                                                                                         | Low    |
| `apps/runtime/src/routes/feedback.ts`                            | Replace direct addEvent with tracer.emit (lookup via TracerRegistry)                                                                                                                                                                                                                                                      | Low    |
| `apps/runtime/src/websocket/sdk-handler.ts`                      | Replace direct addEvent with tracer.emit. 3 sites                                                                                                                                                                                                                                                                         | Low    |
| `apps/runtime/src/services/voice/korevg/korevg-session.ts`       | Replace direct addEvent with tracer.emit. 1 site                                                                                                                                                                                                                                                                          | Low    |
| `apps/runtime/src/services/llm/llm-queue.ts`                     | Replace direct addEvent with tracer.emit. 1 site                                                                                                                                                                                                                                                                          | Low    |
| `apps/runtime/src/services/message-persistence-queue.ts`         | Add inject on enqueue, extract+continueFrom in worker                                                                                                                                                                                                                                                                     | Low    |
| `apps/runtime/src/observability/voice-trace.ts`                  | Replace VoiceTurnContext with tracer.withSpan, voice attributes as span attrs                                                                                                                                                                                                                                             | Medium |
| `apps/runtime/src/services/voice/livekit/livekit-trace-hooks.ts` | Replace manual traceId/spanId with tracer.startSpan                                                                                                                                                                                                                                                                       | Medium |
| `apps/runtime/src/services/voice/realtime-voice-executor.ts`     | Thread Tracer to voice execution                                                                                                                                                                                                                                                                                          | Low    |
| `apps/runtime/src/services/voice/livekit/agent-worker.ts`        | Thread Tracer to agent worker                                                                                                                                                                                                                                                                                             | Low    |
| `apps/runtime/src/types/index.ts`                                | Add `span_end` to `TraceEventType` union; add `tenantId?`, `projectId?` to `TraceEventWithId`; spanId/parentSpanId stay optional                                                                                                                                                                                          | Low    |
| `apps/runtime/src/services/trace-store.ts`                       | Add `traceId?`, `tenantId?`, `projectId?` to `TraceEvent` (note: this file uses `type: string`, not the union — no `span_end` addition needed here)                                                                                                                                                                       | Low    |
| `apps/runtime/src/services/trace/redis-trace-store.ts`           | Add `traceId?`, `tenantId?`, `projectId?` to local `TraceEvent` type                                                                                                                                                                                                                                                      | Low    |
| `apps/runtime/src/services/agent-transfer/index.ts`              | Update wiring to pass Tracer instead of raw `getTraceStore()` to trace-store-adapter                                                                                                                                                                                                                                      | Low    |
| `apps/studio/src/store/observatory-store.ts`                     | Delete heuristic matcher, add buildSpanTree, add "predate span tracking" indicator                                                                                                                                                                                                                                        | Medium |
| `apps/studio/src/types/index.ts`                                 | Replace Studio `Span` and `SpanTreeNode` types with `SpanNode`; add `span_end` to `ExtendedTraceEventType`; add `spanId?`, `parentSpanId?`, `traceId?`, `agentName?` to Studio `TraceEvent` (required by `buildSpanTree()`)                                                                                               | Medium |
| `apps/studio/src/components/observatory/WaterfallPanel.tsx`      | Update `SpanSummary` type from old `Span` to `SpanNode`; update prop destructuring                                                                                                                                                                                                                                        | Medium |
| `apps/studio/src/components/observatory/SpanTree.tsx`            | Update props from old `Span`/`SpanTreeNode` to `SpanNode`; update `node.span.spanId` → `node.spanId`                                                                                                                                                                                                                      | Medium |

### Deferred Files (out of scope, documented for future)

| File                                                               | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/components/analytics/TracesExplorerTab.tsx`       | Has its own local `SpanNode` type (different shape: `{ trace, children, depth }`) and stack-based `buildSpanTree` (lines 280-329). After this migration, the runtime emits real `spanId`/`parentSpanId` fields, but this component still uses heuristic stack matching — its trace view will be stale/incorrect for new sessions. **Must be migrated in a fast-follow** to use the shared `buildSpanTree` with `parentSpanId`-based linking. |
| `packages/observatory/src/schema/spans.ts`                         | Contains `Span`, `SpanManager`, `TraceTree` types with a parallel `activeSpanStack` heuristic. Used only by `packages/mcp-debug`. Migrate or deprecate in a follow-up.                                                                                                                                                                                                                                                                       |
| `packages/agent-transfer/src/observability/trace-store-adapter.ts` | Currently accepts `TraceStoreHandle` (duck-typed `addEvent()`). The adapter's callers in `agent-transfer/index.ts` are updated above; the adapter interface itself can remain unchanged for now since agent-transfer trace events flow through the runtime wiring.                                                                                                                                                                           |

### Test Impact (~13 files)

| Test File                                                     | Change                                                                                                                                                                            |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared-observability/src/__tests__/tracing.test.ts` | **New file** — test SpanContext, ID gen, traceparent, propagation                                                                                                                 |
| `trace-emitter.test.ts`                                       | Rewrite — mock Tracer instead of asserting span stack; add orphan emit test (assert `log.warn` fires, `fallbackTraceId` is stable across multiple orphan emits from same session) |
| `trace-forwarder.test.ts`                                     | Simplify — forwarder is stateless adapter                                                                                                                                         |
| `trace-forwarder-integration.test.ts`                         | Verify spans link via parentSpanId                                                                                                                                                |
| `observatory-span-lifecycle.test.ts`                          | **New file** — test buildSpanTree (cycle detection, timing, mixed events, malformed timestamps returning epoch fallback, uppercase hex traceparent)                               |
| `trace-store-limits.test.ts`                                  | Events gain required traceId/spanId fields                                                                                                                                        |
| `session-tracing-logging.test.ts`                             | Update event fixtures                                                                                                                                                             |
| `ws-handler.test.ts`                                          | Tracer creation + TracerRegistry in handler setup                                                                                                                                 |
| `trace-profile-resolution.test.ts`                            | Verify tracer.emit instead of direct addEvent                                                                                                                                     |
| `trace-store-adapter.test.ts`                                 | **New file** — test Tracer interface integration                                                                                                                                  |
| `sessions-platform-events.test.ts`                            | Events now always have span fields                                                                                                                                                |
| `tracer-registry.test.ts`                                     | **New file** — test TTL eviction, max size, start/stop lifecycle                                                                                                                  |
| `redis-trace-store.test.ts`                                   | Update TraceEvent fixtures with traceId field                                                                                                                                     |

### Unchanged

| Area                                                | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TraceStore` / `RedisTraceStore`                    | Dumb buffers — store whatever event object is passed in. No schema change needed (type change only, covered in Modified Files).                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `EventStore` / ClickHouse writes                    | Already maps `span_id` and `parent_span_id` columns. Today mostly empty, now populated. No DDL change. ClickHouse `DateTime64(3, 'UTC')` columns store all timestamps in UTC. `TracerImpl.emit()` uses `new Date()` which is always UTC internally. The `@clickhouse/client` returns query results as bare strings without timezone suffix — `buildSpanTree()` handles this with `parseTimestamp()` (see Section 8). **Deferred**: add `INDEX idx_trace_id trace_id TYPE bloom_filter(0.01) GRANULARITY 4` when cross-session trace queries are needed (current queries filter by `session_id`). |
| `packages/compiler/` TraceStore/TraceContextManager | Independent from runtime. Bridge is the trace forwarder (which we are changing).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `packages/mcp-debug/`                               | Consumer only — receives events via WebSocket, stores as-is. Gets richer data for free.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `OtelTraceStore` bridge                             | Deferred — update to use traceId from events. Off by default (OTEL_EXPORTER_OTLP_ENDPOINT).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `shared-observability/tsconfig.json`                | No change needed — existing `"include": ["src/**/*.ts"]` already covers `src/tracing/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Net Impact

- **~520 LOC deleted** (trace-emitter ~300, trace-forwarder ~140, observatory heuristic matcher ~80)
- **~470 LOC created** (shared-observability tracing primitives + runtime TracerImpl/SpanImpl/Registry)
- **~50 LOC net decrease** with significantly cleaner, reusable architecture
- Every trace event gets proper `traceId` + `spanId` + `parentSpanId`
- Concurrency-safe via AsyncLocalStorage
- Cross-boundary propagation via W3C traceparent (HTTP, BullMQ, WebSocket)
- UI builds span tree from data, not heuristics
- Compiler-layer spans linked under the same trace tree as runtime-layer spans
- Tracing primitives shared across runtime, search-ai, and future services via `@agent-platform/shared-observability/tracing`
