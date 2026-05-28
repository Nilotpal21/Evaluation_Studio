# Complete Trace Lifecycle — End-to-End Code Flow

This document traces the complete lifecycle of a trace through the platform, from HTTP request entry to final persistence.

---

## 1. HTTP Request Entry

### 1.1 Traceparent Parsing & ALS Context Creation

**File**: `packages/shared-observability/src/middleware/observability.ts`
**Key Lines**: 57–70

```
parseTraceparent() reads W3C traceparent header (format: 00-{traceId}-{spanId}-{flags})
  └─ Returns: { traceId, spanId, traceFlags } or null
  └─ Falls back to randomUUID().replace(/-/g, '') if header missing

ObservabilityContext created with:
  ├─ traceId (inherited from header or generated)
  ├─ spanId (inherited from header or generated)
  ├─ tenantId (from getTenantContext callback)
  ├─ userId (from getTenantContext callback)
  ├─ sessionId (from x-session-id header)
  └─ correlationId (from x-correlation-id header)
```

**File**: `packages/shared-observability/src/tracing/traceparent.ts`
**Key Lines**: 25–33

```
parseTraceparent(header):
  ├─ Regex: /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/
  ├─ Validates: not all-zeros traceId or spanId
  └─ Returns null if malformed → random IDs generated in middleware
```

### 1.2 runWithContext (AsyncLocalStorage)

**File**: `packages/shared-observability/src/middleware/observability.ts`
**Key Lines**: 74–95

```
config.runWithContext(ctx, () => {
  // Executes the callback with observability context bound to ALS
  // All downstream code can call getCurrentTraceId() to read it
})

This is parameterized — Runtime/Studio provide their own implementation
```

**File**: `packages/compiler/platform/src/observability.ts` (mentioned but not full path)
**Pattern**:

```
- runWithObservabilityContext(ctx, fn)
- getCurrentTraceId() reads from ALS
- getObservabilityContext() returns full context
```

### 1.3 Response Header

**File**: `packages/shared-observability/src/middleware/observability.ts`
**Line**: 72

```
res.setHeader('X-Trace-Id', traceId)
└─ Client receives trace ID for correlation
```

---

## 2. WebSocket Entry Points

### 2.1 Agent Load (handler.ts)

**File**: `apps/runtime/src/websocket/handler.ts`
**Large file — key pattern**:

```
When client connects with agentId:
  ├─ Generate traceId (from header or new UUID)
  ├─ Create ObservabilityContext
  ├─ Call runWithObservabilityContext() to bind ALS
  └─ Code executed within that context can read getCurrentTraceId()
```

### 2.2 SDK Connection (sdk-handler.ts)

**File**: `apps/runtime/src/websocket/sdk-handler.ts`
**Large file — key pattern**:

```
Similar to handler.ts:
  ├─ Validate public API key
  ├─ Generate traceId
  ├─ runWithObservabilityContext() for session lifecycle
  └─ Emit trace events over WebSocket
```

Both use `getCurrentTraceId()` from `@abl/compiler/platform/observability` to read active trace.

---

## 3. Span Creation & Management

### 3.1 TracerImpl — Span Factory

**File**: `apps/runtime/src/services/tracing/tracer.ts`
**Key Lines**: 28–78

```typescript
class TracerImpl {
  spanStorage = new AsyncLocalStorage<Span>()  // Line 34
  fallbackTraceId = generateTraceId()           // Line 44

  startSpan(name, options):
    ├─ Get parent = activeSpan() via ALS       // Line 51
    ├─ Inherit traceId from parent or generate // Line 52
    ├─ Generate new spanId                      // Line 53
    ├─ Create SpanContext { traceId, spanId, parentSpanId }
    └─ Return SpanImpl instance

  withSpan(name, fn, options):                  // Line 81
    ├─ startSpan(name, options)
    ├─ spanStorage.run(span, fn)               // Line 88 — run fn in span context
    │  └─ All nested activeSpan() calls see this span
    ├─ await fn()
    ├─ span.setStatus('ok' or 'error')         // Line 89 or 92
    └─ span.end()                              // Line 95

  activeSpan():                                 // Line 107
    └─ Return spanStorage.getStore() via ALS

  emit(event):                                  // Line 111
    ├─ Get active span or fallback traceId
    ├─ Write event with traceId, spanId, parentSpanId
    └─ writePipeline.write()
```

### 3.2 SpanImpl — Span Lifecycle

**File**: `apps/runtime/src/services/tracing/span.ts`
**Key Lines**: 26–103

```typescript
class SpanImpl {
  startTime = Date.now()                        // Line 47
  ended = false                                 // Line 37

  setAttribute(key, value):
    └─ Store in attributes map

  addEvent(name, data):                         // Line 54
    └─ writePipeline.write({
         type: name,
         timestamp: new Date(),
         sessionId, traceId, spanId, parentSpanId,
         data
       })

  setStatus(status, message):                   // Line 69
    └─ Set span.status and span.status_message attributes

  end():                                        // Line 76
    ├─ Idempotent check: return if already ended
    ├─ Calculate durationMs = Date.now() - startTime
    └─ writePipeline.write({
         type: 'span_end',
         timestamp: new Date(),
         durationMs,
         sessionId, traceId, spanId, parentSpanId,
         data: { spanName, attributes }
       })
```

---

## 4. RuntimeExecutor Wiring

### 4.1 TracerRegistry Access

**File**: `apps/runtime/src/services/runtime-executor.ts`
**Lines**: 1–200 (excerpt)

```typescript
// Line 52: import { getCurrentTraceId } from '@abl/compiler/platform/observability'
// Line 55: import { tracePath, getSharedSTRBuffer } from '@agent-platform/sti'

// Pattern: RuntimeExecutor is called with WritePipeline injected
// It creates a Tracer and wraps execution in tracer.withSpan('turn', ...)
```

### 4.2 Tracer Wiring (Pattern)

**Implied from trace-emitter.ts and RuntimeExecutor**:

```typescript
// In RuntimeExecutor initialization:
const writePipeline = new WritePipelineImpl({...})
const tracer = new TracerImpl({
  sessionId,
  tenantId,
  projectId,
  writePipeline,
  defaultAttributes: { /* ... */ }
})

// When executing a turn:
await tracer.withSpan('turn', async () => {
  // All spans created here inherit this trace
  // All emit() calls use tracer.emit() which reads activeSpan()
})
```

---

## 5. Trace Event Emission

### 5.1 TracerImpl.emit() → WritePipeline

**File**: `apps/runtime/src/services/tracing/tracer.ts`
**Lines**: 111–143

```typescript
emit(event):
  └─ writePipeline.write({
       ...event,
       timestamp: new Date(),
       sessionId,
       traceId,           // from activeSpan() or fallback
       spanId,            // from activeSpan()
       parentSpanId,      // from activeSpan()
       tenantId,
       projectId
     })
```

### 5.2 WritePipeline — Multi-Destination Sink

**File**: `apps/runtime/src/services/tracing/write-pipeline.ts`
**Key Lines**: 25–80

```typescript
class WritePipelineImpl implements WritePipeline {
  write(event):
    ├─ TraceStore.addEvent()              // Line 32
    │  └─ In-memory session trace buffer (single authority)
    │
    ├─ WS broadcast: broadcastToSession() // Line 43
    │  └─ Send { type: 'trace_event', sessionId, event } over WebSocket
    │
    └─ EventStore.emitter.emit()          // Line 59
       └─ Fire-and-forget to platform_events (ClickHouse)
          └─ Includes: event_id, event_type, category, tenant_id,
                       project_id, session_id, span_id, parent_span_id
```

### 5.3 TraceEmitter — High-Level Event Factory

**File**: `apps/runtime/src/services/trace-emitter.ts`
**Key Lines**: 65–692

```typescript
function createTraceEmitter(config):
  ├─ tracer (optional Tracer instance)      // Line 408
  ├─ Functions:
  │  ├─ emit(event)                         // Line 105
  │  │  ├─ Create TraceEventWithId with id
  │  │  ├─ getTraceStore().addEvent()       // Line 118
  │  │  ├─ Send WebSocket message           // Line 135
  │  │  └─ eventStore.emitter.emit()        // Line 156
  │  │     └─ Includes span_id, parent_span_id from storedEvent
  │  │
  │  ├─ logLLMCall(params)                  // Line 188
  │  ├─ logToolCall(params)                 // Line 219
  │  ├─ logAgentEnter(params)               // Line 441
  │  │  ├─ If tracer: tracer.startSpan()   // Line 454
  │  │  │  └─ Store span in tracerSpanMap by spanId
  │  │  ├─ Emit agent_enter event
  │  │  └─ Return spanId, parentSpanId
  │  │
  │  ├─ logAgentExit(params)                // Line 493
  │  │  ├─ If tracer: lookup span in tracerSpanMap[spanId]
  │  │  ├─ span.setStatus() and span.end() // Line 505–506
  │  │  └─ Emit agent_exit event
  │  │
  │  └─ emitDecision(kind, metadata)        // Line 640
  │     └─ Gate by verbosity, then emit
  │
  └─ getActiveSpanId() / getActiveParentSpanId() read from tracer.activeSpan()
```

---

## 6. Boundary Crossing — Trace Context Propagation

### 6.1 Trace Context Injection/Extraction

**File**: `packages/shared-observability/src/tracing/propagation.ts`
**Key Lines**: 14–40

```typescript
const TRACE_ID_KEY = '__traceId'
const SPAN_ID_KEY = '__spanId'
const PARENT_SPAN_ID_KEY = '__parentSpanId'

injectTrace(carrier, context):
  └─ carrier.__traceId = context.traceId
  └─ carrier.__spanId = context.spanId
  └─ carrier.__parentSpanId = context.parentSpanId

extractTrace(carrier):
  ├─ Read __traceId, __spanId, __parentSpanId
  └─ Return SpanContext | null
```

### 6.2 BullMQ Enqueue — LLM Queue

**File**: `apps/runtime/src/services/llm/llm-queue.ts`
**Lines**: 1–100 (excerpt)

```typescript
interface LLMJobData {
  jobId: string
  sessionId: string
  message: string
  tenantId?: string
  traceId?: string        // Line 41 — trace context stored in job payload
}

enqueueLLMRequest():
  ├─ Get traceId = getCurrentTraceId()
  ├─ Create job data with traceId
  ├─ BullMQ.queue.add(jobData)
  └─ Pass callback registry (in-process, not serialized)
```

### 6.3 BullMQ Worker — Inbound Channel

**File**: `apps/runtime/src/services/queues/inbound-worker.ts`
**Lines**: 1–100 (excerpt)

```typescript
startInboundWorker():
  └─ new bullmq.Worker('channel-inbound', async (job) => {
       const payload = job.data

       await runWithTenantContext(
         { tenantId: payload.tenantId, ... },
         async () => {
           // Extract trace context from job payload
           const traceContext = extractTrace(payload)

           await runWithObservabilityContext({
             traceId: traceContext?.traceId || generateTraceId(),
             ...
           }, async () => {
             // Execute within inherited trace context
             await executeMessage()
           })
         }
       )
     })
```

**Pattern**: Job payload carries `__traceId`, `__spanId` → extracted → used to initialize worker's ALS context.

### 6.4 Cross-Service — TraceparentHeader

**File**: `packages/search-ai-sdk/src/client.ts` (inferred pattern)

```typescript
// When making HTTP calls to SearchAI from Runtime:
const traceId = getCurrentTraceId();
const traceparent = formatTraceparent(traceId, generateSpanId());

fetch(url, {
  headers: {
    traceparent: traceparent,
  },
});
// → SearchAI receives header in its middleware
//   → parseTraceparent() extracts it
//   → Creates its own span hierarchy under the same traceId
```

---

## 7. Spatial Trace Intelligence (STI)

### 7.1 tracePath — Transparent Instrumentation

**File**: `packages/sti/src/trace-path.ts`
**Key Lines**: 66–106

```typescript
function tracePath(path, fn, depth = 0):
  ├─ If STI_ENABLED !== 'true': return fn unchanged (zero overhead)
  │
  ├─ Return async wrapper:
  │  ├─ Read traceId = getCurrentTraceId()
  │  ├─ If no traceId or ALS fails: call fn directly (fail-safe)
  │  │
  │  ├─ buffer = getSharedSTRBuffer()
  │  ├─ entry = buffer.recordEntry(traceId, path, depth)
  │  │  └─ Creates STREntry { path, timestamp, outcome: 'pending', depth }
  │  │
  │  ├─ start = process.hrtime.bigint()
  │  ├─ await fn()
  │  ├─ entry.markSuccess() or entry.markError()
  │  └─ durationUs = (process.hrtime.bigint() - start) / 1000
  │     entry.recordDuration(durationUs)
  │
  └─ Called at every I/O boundary for path tracing
```

### 7.2 STRBuffer — Ring Buffer Management

**File**: `packages/sti/src/str-buffer.ts`
**Key Lines**: 55–195

```typescript
class STRBuffer {
  traces = new Map<traceId, TraceSlot>()

  recordEntry(traceId, path, depth):           // Line 64
    ├─ Check circuit breaker (failed flushes)
    ├─ Evict stale traces (TTL_MS = 5 min)
    ├─ Create/get slot for traceId
    ├─ Create STREntry { path, timestamp, durationUs: 0, outcome: 'pending', depth }
    ├─ Ring-buffer: drop oldest if >= MAX_ENTRIES_PER_TRACE (10k)
    └─ Return EntryHandle { markSuccess, markError, recordDuration }

  flush(traceId):                              // Line 110
    ├─ Get slot by traceId
    ├─ Remove from buffer
    └─ Return entries array

  isCircuitOpen():                             // Line 139
    └─ If consecutive flush failures >= 5: open for 30s, then half-open
```

---

## 8. Trace End — Channel Response Boundary

### 8.1 emitChannelResponseSent

**File**: `apps/runtime/src/services/channel-trace-utils.ts`
**Key Lines**: 22–69

```typescript
function emitChannelResponseSent(sessionId, channel, durationMs, opts):
  ├─ Get current traceId = getCurrentTraceId()
  │
  ├─ eventStore.emitter.emit({
  │    event_type: 'channel.response.sent',
  │    category: 'channel',
  │    trace_id: traceId,
  │    ...
  │  })
  │
  └─ **STI FLUSH TRIGGER**:
     ├─ getSharedSTRBuffer().flush(traceId)    // Line 57
     │  └─ Removes all STR entries for this traceId from buffer
     │  └─ Returns entries array
     │
     └─ Fire-and-forget: entries flow to STRWriter → ClickHouse
        (STRWriter is wired externally, not in trace-emitter)
```

**This is the critical boundary**: When the HTTP/WS response is sent, we signal "this trace is complete" and flush the STR buffer.

### 8.2 Span.end() — Emit span_end Event

**File**: `apps/runtime/src/services/tracing/span.ts`
**Lines**: 76–103

```typescript
end():
  ├─ Idempotent: ignore if already ended
  ├─ durationMs = Date.now() - startTime
  └─ writePipeline.write({
       type: 'span_end',
       timestamp: new Date(),
       durationMs,
       sessionId, traceId, spanId, parentSpanId,
       data: {
         spanName,
         attributes: { 'span.status', 'span.status_message', ... }
       }
     })
     └─ Routed to TraceStore, WS, EventStore
```

---

## 9. Tracer Lifecycle & Cleanup

### 9.1 TracerRegistry — Session-Scoped Pooling

**File**: `apps/runtime/src/services/tracing/tracer-registry.ts`
**Key Lines**: 35–140

```typescript
class TracerRegistry {
  entries = new Map<sessionId, RegistryEntry>()
  sweepInterval = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS)

  getOrCreate(sessionId, config):               // Line 48
    ├─ Check entries.get(sessionId)
    ├─ If exists: update lastAccess, return
    ├─ Evict LRU if size >= MAX_REGISTRY_ENTRIES (10k)
    ├─ Create new TracerImpl with WritePipelineImpl
    └─ Store and return

  remove(sessionId):                            // Line 79
    └─ entries.delete(sessionId)

  sweep():                                      // Line 86
    ├─ Remove expired entries (lastAccess > TRACER_TTL_MS = 30 min)
    ├─ While size > MAX_REGISTRY_ENTRIES: evict LRU
    └─ Log cleanup stats

  destroy():                                    // Line 113
    └─ clearInterval(sweepInterval)
    └─ Called at server shutdown
```

**Pattern**:

- Session starts → `TracerRegistry.getOrCreate(sessionId)` → creates fresh `TracerImpl`
- Subsequent turns → `getOrCreate()` returns same tracer (same trace hierarchy)
- Session idle 30 min → swept by background task
- Server shutdown → `destroy()` stops sweep

---

## 10. Full Flow Diagram

```
┌─ HTTP/WS Request Arrives
│
├─ parseTraceparent() reads W3C header
├─ ObservabilityContext created (traceId, spanId, tenantId, userId, ...)
├─ runWithObservabilityContext(ctx, callback) binds to ALS
│
├─ TracerRegistry.getOrCreate(sessionId) creates/reuses tracer
├─ tracer.withSpan('turn', executeMessage)
│  │
│  ├─ tracer.startSpan(name) creates span
│  ├─ spanStorage.run(span, fn) enters span context
│  │
│  ├─ During execution:
│  │  ├─ traceEmitter.logAgentEnter(agent)
│  │  │  └─ tracer.startSpan('agent:X')
│  │  │     └─ writePipeline.write() → {type: 'agent_enter', spanId, parentSpanId, ...}
│  │  │
│  │  ├─ tracer.emit(custom_event)
│  │  │  └─ writePipeline.write()
│  │  │
│  │  ├─ tracePath(path, fn) wraps I/O
│  │  │  └─ STRBuffer.recordEntry(traceId, path)
│  │  │
│  │  └─ traceEmitter.logAgentExit(agent)
│  │     └─ span.end() → writePipeline.write({type: 'span_end'})
│  │
│  ├─ Cross-boundary job enqueue:
│  │  ├─ injectTrace(jobPayload, spanContext)
│  │  └─ BullMQ enqueues with __traceId, __spanId
│  │
│  └─ Worker extracts and continues:
│     ├─ extractTrace(jobPayload)
│     ├─ runWithObservabilityContext(traceContext, ...)
│     └─ Preserves traceId, creates new spans
│
├─ WritePipeline routes every event to 3 destinations:
│  ├─ TraceStore (in-memory session buffer)
│  ├─ WebSocket (live tracing dashboard)
│  └─ EventStore (ClickHouse platform_events)
│
├─ HTTP/WS Response sent → emitChannelResponseSent()
│  └─ getSharedSTRBuffer().flush(traceId)
│     └─ STRBuffer.flush() returns entries
│     └─ STRWriter (external) persists to ClickHouse STR table
│
└─ Session idle 30 min or explicit cleanup
   └─ TracerRegistry.sweep() evicts stale tracer
   └─ Tracer removed from registry
```

---

## 11. Key Implementation Details

### 11.1 AsyncLocalStorage (ALS) Context Propagation

- **Parent**: `observability.ts` middleware creates ALS binding via `runWithContext()`
- **Child**: `@abl/compiler/platform/observability` provides `getCurrentTraceId()` reader
- **Async-safe**: ALS automatically propagates across Promise chains
- **Span hierarchy**: `TracerImpl.spanStorage` stores active span, enabling parent-child linking

### 11.2 Write Pipeline Destinations

| Destination | Purpose                                      | Fire-and-forget? | Loss-tolerant?  |
| ----------- | -------------------------------------------- | ---------------- | --------------- |
| TraceStore  | Single trace authority for session queries   | No               | No — in-memory  |
| WebSocket   | Real-time dashboard updates                  | No               | Yes — UI only   |
| EventStore  | Analytics (platform_events ClickHouse table) | Yes              | Yes — analytics |

### 11.3 Trace Context Carriers

| Carrier                 | Format                                       | Extracted By          |
| ----------------------- | -------------------------------------------- | --------------------- |
| HTTP Headers            | `traceparent: 00-{traceId}-{spanId}-{flags}` | `parseTraceparent()`  |
| W3C Trace Context       | Same as above                                | Same                  |
| BullMQ Job Payload      | `__traceId`, `__spanId`, `__parentSpanId`    | `extractTrace()`      |
| ALS (AsyncLocalStorage) | SpanContext in async context                 | `tracer.activeSpan()` |

### 11.4 Idempotency & Deduplication

- **Spans**: `span.end()` is idempotent — logged warning if called twice
- **Events**: Each `writePipeline.write()` creates unique event (no dedup)
- **Jobs**: Channel inbound deduped via Redis SET NX on idempotencyKey (not trace-level)

### 11.5 Memory Bounds

| Component             | Limit        | Eviction               | TTL                |
| --------------------- | ------------ | ---------------------- | ------------------ |
| TracerRegistry        | 10k tracers  | LRU                    | 30 min             |
| STRBuffer (per trace) | 10k entries  | Ring buffer (FIFO)     | 5 min (trace slot) |
| STRBuffer (global)    | 50k traces   | LRU                    | —                  |
| Callback Registry     | 5k callbacks | LRU + timeout sweep    | 5 min              |
| TraceStore            | Per-session  | Cleared on session end | —                  |

### 11.6 Fault Tolerance

- **Circuit breaker**: STRBuffer stops accepting writes after 5 consecutive flush failures, resets after 30s
- **Fail-safe**: `tracePath()` and ALS reads have try-catch; if internals fail, call original function
- **Non-blocking**: STI flush is best-effort; never blocks channel response
- **Fire-and-forget**: EventStore writes are async, not awaited

---

## 12. Entry Points by Request Type

### 12.1 HTTP Request (e.g., Studio API)

```
Request → observability middleware
  ├─ parseTraceparent() from request header
  ├─ runWithObservabilityContext(ctx) binds ALS
  ├─ Next middleware/route handler executes
  ├─ res.on('finish'): log metrics, unwind ALS
  └─ Response sent
```

### 12.2 WebSocket Connection (Agent Handler)

```
WebSocket upgrade → handler.ts
  ├─ Generate traceId from header or new UUID
  ├─ runWithObservabilityContext(ctx)
  ├─ Client message loop
  │  ├─ parseMessage()
  │  ├─ getRuntimeExecutor().executeMessage()
  │  │  └─ tracer.withSpan('turn', ...)
  │  └─ Send response
  └─ Connection close
```

### 12.3 WebSocket Connection (SDK Handler)

```
Similar to agent handler, but:
  ├─ Validate public API key
  ├─ Find project by key
  └─ Create runtime session from project agents
```

### 12.4 BullMQ Worker (Async Queue)

```
Job dequeued → inbound-worker.ts
  ├─ extractTrace(job.data)
  ├─ runWithObservabilityContext(traceContext)
  ├─ runWithTenantContext()
  ├─ executeMessage()
  ├─ Create delivery record
  └─ Enqueue to webhook-delivery queue
```

---

## 13. Debugging Checklist

1. **Is traceId visible in logs?**
   - Check `getCurrentTraceId()` returns a value
   - Verify ALS context was set by `runWithObservabilityContext()`

2. **Are events reaching the trace store?**
   - Check `TraceStore.addEvent()` calls
   - Verify sessionId is not null (required for TraceStore)

3. **Are spans being created?**
   - Check `tracer.startSpan()` returns a span
   - Verify `tracer.withSpan()` awaits the function

4. **Are span IDs present in events?**
   - Check `tracer.activeSpan()` returns a span
   - Verify `span.context.spanId` is populated in `emit()` call

5. **Is STI flushing?**
   - Check `STI_ENABLED=true` environment variable
   - Check `emitChannelResponseSent()` is called at response boundary
   - Check `STRBuffer.flush()` removes entries (not `getSize()`)

6. **Cross-boundary: is trace inherited?**
   - Check `injectTrace()` called before enqueue
   - Check worker calls `extractTrace()` on job payload
   - Check worker calls `runWithObservabilityContext(extractedContext, ...)`

---

## References

- W3C Trace Context: https://www.w3.org/TR/trace-context/
- AsyncLocalStorage: https://nodejs.org/docs/latest/api/async_context.html#async_contextasynclocalstorage
- BullMQ: https://docs.bullmq.io/
- ClickHouse: https://clickhouse.com/docs/en/intro
