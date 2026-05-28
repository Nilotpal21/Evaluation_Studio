# Platform Trace Readiness (Merged) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Establish a unified W3C-compatible `traceId` flowing through every code path — per-turn on WebSocket, per-request on HTTP — from channel entry to channel exit, across service boundaries, and into ClickHouse, so every interaction is individually addressable.

**Architecture:** Mount the existing `createObservabilityMiddleware` (implemented in `shared-observability`, never wired) on all Express servers, wiring it to the compiler's `runWithObservabilityContext` ALS. For WebSocket channels (which bypass Express middleware), generate per-turn traceId and enter the same ALS. Stamp every `TraceEvent` via the single `createCentralizedTraceHandler` in runtime-executor.ts, reading `getCurrentTraceId()` from ALS. Thread `traceId` through BullMQ job payloads and outbound HTTP headers.

**Tech Stack:** `@agent-platform/shared-observability` (W3C traceparent middleware, `ObservabilityContext`, `requestIdMiddleware`, `createLogger`), `@abl/compiler/platform` (AsyncLocalStorage via `runWithObservabilityContext`, `getCurrentTraceId`, `getObservabilityContext`), Express, ClickHouse, BullMQ, WebSocket

**Relationship to Span Model Fix spec** (`docs/superpowers/specs/2026-03-12-span-model-fix-design.md`): The span-model-fix adds `SpanContext`, `Span`, `Tracer`, `WritePipeline` to `@agent-platform/shared-observability/tracing` with its own ALS (`spanStorage`). It overlaps with Tasks 5-10 of this plan. **Execution order**: This plan (Tasks 1-4) mounts the observability middleware and exports compiler ALS functions first. The span-model-fix then builds on that foundation — its `TracerImpl` should seed the initial span's `traceId` from `getCurrentTraceId()` (observability ALS) to ensure both ALS systems carry the same trace ID. Tasks 5-10 of this plan may be partially or fully superseded by the span-model-fix — evaluate after Tasks 1-4 land.

**Key Discovery — Existing Infrastructure in `@agent-platform/shared-observability`:**

- `createObservabilityMiddleware(config)`: `packages/shared-observability/src/middleware/observability.ts` — W3C `traceparent` parsing, `X-Trace-Id` response header, `ObservabilityContext` injection via `config.runWithContext()`. Accepts injectable `logRequestStart`/`logRequestEnd`/`recordMetrics`/`incrementActive`/`decrementActive` callbacks. **Implemented, never mounted.**
- `requestIdMiddleware()`: `packages/shared-observability/src/middleware/request-id.ts` — `X-Request-ID` propagation via separate ALS + `getCurrentRequestId()`. **Already mounted on runtime.**
- `createLogger(module)`: `packages/shared-observability/src/logger.ts` — Pino-backed structured logger with `getCurrentRequestId()` correlation. For packages that can't depend on compiler.
- `ObservabilityContext` type: `{ traceId, spanId, tenantId?, userId?, sessionId?, correlationId? }` — shared between `@agent-platform/shared-observability` and `@abl/compiler/platform/observability`.
- `DistributedLockManager`: `packages/shared-observability/src/distributed-lock.ts` — Redis `SET NX PX` for distributed coordination.

**Key Discovery — Existing Infrastructure in `@abl/compiler/platform`:**

- `runWithObservabilityContext(ctx, fn)`: `packages/compiler/src/platform/observability/context.ts:37` — ALS `.run()` with `ObservabilityContext`. This is the callback that `createObservabilityMiddleware`'s `runWithContext` should delegate to.
- `getObservabilityContext()`: Full context retrieval from ALS
- `getCurrentTraceId()`: `packages/compiler/src/platform/observability/context.ts:55` — reads `traceId` from ALS
- `getCurrentSpanId()`: reads `spanId` from ALS
- Pino mixin (`pino-setup.ts`): Automatically injects `traceId`, `spanId`, `tenantId`, `sessionId`, `userId`, `correlationId` from ALS into every log line

**Key Discovery — Existing Infrastructure (runtime):**

- `createCentralizedTraceHandler`: `apps/runtime/src/services/runtime-executor.ts:1426` — single point constructing ALL `TraceEventWithId` objects. **1 call site (line 1682).** Does NOT stamp `traceId`.
- ClickHouse `platform_events.trace_id` column: `packages/database/src/clickhouse-schemas/init.ts:291` — exists, bloom-filtered, always empty
- `TraceEventWithId.traceId?: string`: `apps/runtime/src/types/index.ts:444` — field exists, never populated

**Key Discovery — Planned Infrastructure (span-model-fix):**

- `@agent-platform/shared-observability/tracing` (not yet implemented): `SpanContext`, `Span`, `Tracer`, `WritePipeline`, `generateTraceId`/`generateSpanId`, `formatTraceparent`/`parseTraceparent`, `injectTrace`/`extractTrace`
- Separate `spanStorage` ALS for span propagation (new, alongside existing `observabilityStorage`)
- `TracerImpl` + `TracerRegistry` + `WritePipelineImpl` in `apps/runtime/`
- Covers: auto-stamping traceId/spanId/parentSpanId on all events, BullMQ inject/extract, WebSocket per-turn spans, cross-service W3C propagation

**What's Missing (the gap this plan fills):**

1. Observability middleware never mounted on any Express app
2. `createCentralizedTraceHandler` doesn't call `getCurrentTraceId()` — so `platform_events.trace_id` is always empty
3. WebSocket handlers don't enter observability ALS context
4. BullMQ job payloads lack `traceId` field — trace context lost across job boundaries
5. No cross-service trace propagation (Runtime → SearchAI)
6. CORS `exposedHeaders` doesn't include `X-Trace-Id` — browser clients can't read it
7. No `channel_response_sent` exit event at response boundaries
8. Kafka trace header injection gated behind disabled feature flag

**Design Decisions:**

- **`@agent-platform/shared-observability` as the single observability package** — `createObservabilityMiddleware` handles W3C traceparent parsing and context injection for HTTP. WebSocket and BullMQ entry points call `runWithObservabilityContext` directly (same ALS, same `ObservabilityContext` type). The upcoming `./tracing` export (span-model-fix) adds span-level propagation on top of this foundation.
- **Two ALS systems, one traceId** — `observabilityStorage` (request-level context) and `spanStorage` (span-level context, from span-model-fix) must carry the same `traceId`. The span-model-fix's `TracerImpl.startSpan()` should seed from `getCurrentTraceId()` when no parent span exists, ensuring consistency.
- **Per-turn traceId on WebSocket** — each `send_message` generates a new traceId and enters `runWithObservabilityContext`. This means a 50-message session has 50 individually-addressable trace IDs, not one shared ID. (The span-model-fix's `tracer.withSpan()` builds on this.)
- **W3C format** (32 hex chars) everywhere — compatible with the existing middleware and external systems. NOT UUID v4 with hyphens. The span-model-fix's `generateTraceId()` uses `randomBytes(16).toString('hex')` producing the same format.
- **Centralized stamping** — one change to `createCentralizedTraceHandler` stamps traceId on ALL events, regardless of channel. No per-channel injection needed. (May be superseded by `Tracer.emit()` auto-stamping once span-model-fix lands.)
- **`VALID_TRACE_ID` validation** for client-provided IDs — alphanumeric + hyphens, 1-64 chars.
- **`requestIdMiddleware` coexistence** — `requestIdMiddleware` (already mounted, separate ALS) provides `X-Request-ID` for client correlation. `createObservabilityMiddleware` provides `X-Trace-Id` for distributed tracing. Both coexist.

**Note:** This plan is not defined in the STI design doc — it addresses the implicit prerequisite that `trace_id` is populated in `platform_events`, which Phase 0a assumes (design doc line 1066: "engineers can query by trace_id"). Both the Trace Event Consolidation plan and the STI design doc depend on this plan being complete. The span-model-fix spec depends on Tasks 1-4 of this plan for the initial observability ALS wiring.

---

### Task 1: Export Observability Functions from Compiler Platform Barrel

**Files:**

- Modify: `packages/compiler/src/platform/index.ts`
- Test: `pnpm build --filter=@abl/compiler`

**Context:** `runWithObservabilityContext`, `getCurrentTraceId`, `getObservabilityContext`, and `getCurrentSpanId` are implemented in `packages/compiler/src/platform/observability/context.ts` but NOT re-exported from the platform barrel. All downstream code imports from `@abl/compiler/platform`.

**Step 1: Add observability re-exports**

In `packages/compiler/src/platform/index.ts`, add after the existing exports:

```typescript
// Observability context (AsyncLocalStorage-based trace propagation)
export {
  runWithObservabilityContext,
  getObservabilityContext,
  getCurrentTraceId,
  getCurrentSpanId,
  type ObservabilityContext,
} from './observability/index.js';
```

**Step 2: Build to verify**

Run: `pnpm build --filter=@abl/compiler`
Expected: Clean build, no errors.

**Step 3: Commit**

```bash
npx prettier --write packages/compiler/src/platform/index.ts
git add packages/compiler/src/platform/index.ts
git commit -m "feat(compiler): re-export observability context from platform barrel"
```

---

### Task 2: Add `exposedHeaders` to CORS Schema

**Files:**

- Modify: `packages/config/src/schemas/cors.schema.ts`
- Modify: `apps/runtime/src/server.ts` (~line 200)
- Test: `pnpm build --filter=@agent-platform/config`

**Context:** Without `exposedHeaders`, browser clients silently cannot read `X-Trace-Id` from cross-origin responses. The CORS schema is in config, and runtime's `server.ts` reads from `config.cors`.

**Step 1: Read the current CORS schema**

Read: `packages/config/src/schemas/cors.schema.ts`

**Step 2: Add exposedHeaders field**

```typescript
export const CORSConfigSchema = z.object({
  origins: z
    .union([z.array(z.string()), z.string().transform((s) => s.split(',').map((o) => o.trim()))])
    .default([...DEFAULT_LOCAL_ORIGINS, 'http://127.0.0.1:5173']),
  credentials: z.boolean().default(true),
  methods: z.array(z.string()).default(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']),
  allowedHeaders: z
    .array(z.string())
    .default([
      'Content-Type',
      'Authorization',
      'X-SDK-Token',
      'X-Public-Key',
      'X-Tenant-Id',
      'X-Request-Id',
    ]),
  exposedHeaders: z.array(z.string()).default(['X-Request-Id', 'X-Trace-Id']), // ADD
});
```

**Step 3: Wire exposedHeaders in runtime CORS setup**

In `apps/runtime/src/server.ts`, find the CORS options object (~line 200-208) and add:

```typescript
const corsOptions = {
  origin: config.env === 'prod' ? config.server.frontendUrl : config.cors.origins,
  credentials: config.cors.credentials,
  methods: config.cors.methods,
  allowedHeaders: config.cors.allowedHeaders,
  exposedHeaders: config.cors.exposedHeaders, // ADD THIS LINE
};
```

**Step 4: Build to verify**

Run: `pnpm build --filter=@agent-platform/config --filter=runtime`
Expected: Clean build.

**Step 5: Commit**

```bash
npx prettier --write packages/config/src/schemas/cors.schema.ts apps/runtime/src/server.ts
git add packages/config/src/schemas/cors.schema.ts apps/runtime/src/server.ts
git commit -m "feat: add exposedHeaders to CORS schema for X-Trace-Id browser access"
```

---

### Task 3: Mount Observability Middleware on Runtime

**Files:**

- Modify: `apps/runtime/src/server.ts:229` (add middleware mount after `requestIdMiddleware`)
- Test: `apps/runtime/src/__tests__/trace-id-middleware.test.ts`

**Context:** `createObservabilityMiddleware` is fully implemented in `@agent-platform/shared-observability` (W3C traceparent parsing, X-Trace-Id response header, ALS wrapping via injectable `runWithContext` callback) but never mounted on any Express app. This task wires it to the compiler's `runWithObservabilityContext` ALS, completing the integration between the two observability packages.

**`ObservabilityMiddlewareConfig` interface** (from `@agent-platform/shared-observability`):

```typescript
{
  runWithContext(ctx: ObservabilityContext, fn: () => void): void;  // REQUIRED — delegates to compiler's ALS
  getTenantContext?(): { tenantId?: string; userId?: string } | undefined;
  logRequestStart?(method, path, userAgent?): void;
  logRequestEnd?(method, path, statusCode, durationMs): void;
  recordMetrics?(info: { method, route, statusCode, durationMs }): void;
  incrementActive?(): void;
  decrementActive?(): void;
}
```

The middleware creates an `ObservabilityContext` (`{ traceId, spanId, tenantId?, sessionId?, correlationId? }`) from W3C traceparent header + request headers (`X-Session-ID`, `X-Correlation-ID`), then calls `runWithContext()` to enter the ALS. All downstream async code can call `getCurrentTraceId()` / `getObservabilityContext()` to read the context. The `recordMetrics` callback is available for STI system plane resource vector collection.

**Codebase-verified:**

- `requestIdMiddleware()` mounted at `server.ts:229` (separate ALS for `X-Request-ID`)
- `createObservabilityMiddleware` exported from `@agent-platform/shared-observability`
- Middleware parses `traceparent` header (W3C format: `version-traceId-parentId-traceFlags`) at `observability.ts:25-40`
- Middleware sets `res.setHeader('X-Trace-Id', traceId)` at `observability.ts:86`
- Middleware calls `config.runWithContext(ctx, () => { next(); })` at `observability.ts:88`
- `createLogger` from `@agent-platform/shared-observability/logger` also available (uses `getCurrentRequestId()` for correlation)

**Step 1: Write the failing test**

```typescript
// apps/runtime/src/__tests__/trace-id-middleware.test.ts
import { describe, test, expect } from 'vitest';
import request from 'supertest';

describe('Trace ID middleware', () => {
  test('sets X-Trace-Id response header on every request', async () => {
    // Note: import app from server.ts — check existing test patterns for how
    // the runtime test suite creates/imports the Express app.
    // The key assertion is that X-Trace-Id header appears on any HTTP response.
    const traceIdPattern = /^[a-f0-9]{32}$/;
    // After middleware mount, every response should have X-Trace-Id in 32-hex format
    expect(traceIdPattern.test('abcdef1234567890abcdef1234567890')).toBe(true);
  });

  test('honors incoming W3C traceparent header', () => {
    const incomingTraceId = 'abcdef1234567890abcdef1234567890';
    const traceparent = `00-${incomingTraceId}-1234567890abcdef-01`;
    // After middleware mount, sending traceparent should echo the same traceId back
    expect(traceparent.split('-')[1]).toBe(incomingTraceId);
  });
});
```

**Step 2: Run test (baseline)**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/trace-id-middleware.test.ts`
Expected: PASS (baseline assertions)

**Step 3: Mount the middleware**

In `apps/runtime/src/server.ts`, add import and mount after `requestIdMiddleware()`:

```typescript
// At the import section (~line 138), add or extend:
import {
  requestIdMiddleware,
  createObservabilityMiddleware,
} from '@agent-platform/shared-observability';
import { runWithObservabilityContext, createLogger } from '@abl/compiler/platform';

const log = createLogger('observability');

// After the existing requestIdMiddleware() (line 229), add:
app.use(requestIdMiddleware());

// Trace context (W3C traceparent → AsyncLocalStorage)
// createObservabilityMiddleware parses traceparent, extracts X-Session-ID/X-Correlation-ID,
// calls getTenantContext() for tenant/user, then enters ALS via runWithContext.
app.use(
  createObservabilityMiddleware({
    runWithContext: (ctx, fn) => runWithObservabilityContext(ctx, fn),
    getTenantContext: () => {
      // Extract from auth middleware result (e.g., req.user populated by createUnifiedAuthMiddleware)
      // Return undefined if not yet authenticated (pre-auth routes)
      return undefined; // Wired in Step 3b below
    },
    logRequestStart: (method, path) => log.debug('Request start', { method, path }),
    logRequestEnd: (method, path, statusCode, durationMs) =>
      log.debug('Request end', { method, path, statusCode, durationMs }),
  }),
);
```

**Step 4: Build to verify**

Run: `pnpm build --filter=runtime`
Expected: Clean build. If `@abl/compiler` is not a runtime dependency, it should already be — check `apps/runtime/package.json`.

**Step 5: Run all runtime tests**

Run: `cd apps/runtime && pnpm vitest run`
Expected: All PASS — the middleware is additive (just sets a header and enters ALS context).

**Step 6: Commit**

```bash
npx prettier --write apps/runtime/src/server.ts apps/runtime/src/__tests__/trace-id-middleware.test.ts
git add apps/runtime/src/server.ts apps/runtime/src/__tests__/trace-id-middleware.test.ts
git commit -m "feat(runtime): mount observability middleware for unified trace ID"
```

---

### Task 4: Mount Observability Middleware on All Other Services

**Files:**

- Modify: `apps/search-ai/src/server.ts:95`
- Modify: `apps/search-ai-runtime/src/server.ts:76`

**Context:** Same pattern as Task 3, applied to remaining Express services that have `requestIdMiddleware`.

**Step 1: Mount on search-ai**

In `apps/search-ai/src/server.ts`, after the existing `requestIdMiddleware()` at line ~95:

```typescript
import {
  requestIdMiddleware,
  createObservabilityMiddleware,
} from '@agent-platform/shared-observability';
import { runWithObservabilityContext } from '@abl/compiler/platform';

// After requestIdMiddleware():
app.use(
  createObservabilityMiddleware({
    runWithContext: (ctx, fn) => runWithObservabilityContext(ctx, fn),
  }),
);
```

**Step 2: Mount on search-ai-runtime**

Same pattern in `apps/search-ai-runtime/src/server.ts` after line ~76.

**Step 3: Build all services**

Run: `pnpm build --filter=search-ai --filter=search-ai-runtime`
Expected: Clean builds. If any service doesn't have `@abl/compiler` as a dependency, add it to `package.json` and run `pnpm install`.

**Step 4: Commit**

```bash
npx prettier --write apps/search-ai/src/server.ts apps/search-ai-runtime/src/server.ts
git add apps/search-ai/src/server.ts apps/search-ai-runtime/src/server.ts
git commit -m "feat: mount observability middleware on search-ai services"
```

---

### Task 5: Stamp traceId in createCentralizedTraceHandler

**Files:**

- Modify: `apps/runtime/src/services/runtime-executor.ts:1426` (signature) and `:1452` (TraceEventWithId construction)
- Test: `apps/runtime/src/__tests__/trace-id-stamping.test.ts`

**Context:** This is the highest-impact single change. `createCentralizedTraceHandler` is the SINGLE function that constructs ALL `TraceEventWithId` objects (1 call site at line 1682). It currently does NOT read `getCurrentTraceId()`. Adding one line here fills the empty `platform_events.trace_id` ClickHouse column for ALL channels.

**Codebase-verified:**

- Signature at line 1426: 8 params, no `traceId`
- `TraceEventWithId` constructed at line 1452: `{ id, sessionId, type, timestamp, data, agentName }` — no `traceId`
- Single call site at line 1682: wraps every `onTraceEvent` callback
- `TraceEventWithId.traceId` is optional (types/index.ts:444)

**Step 1: Write the failing test**

```typescript
// apps/runtime/src/__tests__/trace-id-stamping.test.ts
import { describe, test, expect, vi } from 'vitest';
import { getCurrentTraceId, runWithObservabilityContext } from '@abl/compiler/platform';

describe('createCentralizedTraceHandler traceId stamping', () => {
  test('getCurrentTraceId returns value when inside ObservabilityContext', () => {
    let captured: string | undefined;
    runWithObservabilityContext(
      { traceId: 'abcdef1234567890abcdef1234567890', spanId: '1234567890abcdef' },
      () => {
        captured = getCurrentTraceId();
      },
    );
    expect(captured).toBe('abcdef1234567890abcdef1234567890');
  });

  test('getCurrentTraceId returns undefined outside context', () => {
    expect(getCurrentTraceId()).toBeUndefined();
  });
});
```

**Step 2: Run test (baseline)**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/trace-id-stamping.test.ts`
Expected: PASS

**Step 3: Modify createCentralizedTraceHandler**

In `apps/runtime/src/services/runtime-executor.ts`:

1. Add import at top:

   ```typescript
   import { getCurrentTraceId } from '@abl/compiler/platform';
   ```

2. In the `TraceEventWithId` construction at line ~1452, add `traceId`:
   ```typescript
   const traceEvent: TraceEventWithId = {
     id: crypto.randomUUID(),
     sessionId,
     traceId: getCurrentTraceId(), // ADD — reads from ObservabilityContext ALS
     type: event.type as TraceEventType,
     timestamp: new Date(),
     data: { ...event.data, tenantId },
     agentName: (event.data?.agentName as string) || agentName,
   };
   ```

That's it. No signature change needed — traceId comes from ALS, not a parameter.

**Step 4: Build and run all tests**

Run: `pnpm build --filter=runtime && cd apps/runtime && pnpm vitest run`
Expected: All PASS. This is a non-breaking addition (traceId was already optional on TraceEventWithId).

**Step 5: Commit**

```bash
npx prettier --write apps/runtime/src/services/runtime-executor.ts apps/runtime/src/__tests__/trace-id-stamping.test.ts
git add apps/runtime/src/services/runtime-executor.ts apps/runtime/src/__tests__/trace-id-stamping.test.ts
git commit -m "feat(runtime): stamp traceId on every TraceEvent via centralized handler reading from ALS"
```

---

### Task 6: WebSocket Debug Handler — Per-Turn ObservabilityContext

**Files:**

- Modify: `apps/runtime/src/websocket/handler.ts`
- Test: `apps/runtime/src/__tests__/trace-context-ws-debug.test.ts`

**Context:** WebSocket connections bypass Express middleware, so `runWithObservabilityContext` is NOT automatically active. Each `send_message` is one turn. We generate a per-turn traceId and enter the ALS context, so `createCentralizedTraceHandler` (Task 5) can read it via `getCurrentTraceId()`.

**Codebase-verified:**

- `crypto` already imported at line 11
- `case 'send_message'` dispatches to `handleSendMessage()` at line 1358
- `handleSendMessage` calls `executor.executeMessage()` which triggers `createCentralizedTraceHandler`
- The execution queue serializes turns per session (no concurrent turns on same session)

**Step 1: Write the test**

```typescript
// apps/runtime/src/__tests__/trace-context-ws-debug.test.ts
import { describe, it, expect } from 'vitest';
import crypto from 'crypto';

describe('WS debug handler per-turn traceId', () => {
  it('should generate a valid W3C trace ID (32 hex chars) per turn', () => {
    const traceId = crypto.randomUUID().replace(/-/g, '');
    expect(traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(traceId.length).toBe(32);
  });
});
```

**Step 2: Run test (baseline)**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/trace-context-ws-debug.test.ts`
Expected: PASS

**Step 3: Modify handler.ts**

In `apps/runtime/src/websocket/handler.ts`:

1. Add import at top:

   ```typescript
   import { runWithObservabilityContext } from '@abl/compiler/platform';
   ```

2. In `handleSendMessage()` (line ~1358), generate per-turn traceId and wrap execution:

   ```typescript
   // At the top of handleSendMessage, before executor.executeMessage:
   const turnTraceId = crypto.randomUUID().replace(/-/g, '');
   const turnSpanId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);

   // Wrap the entire execution in ObservabilityContext:
   await runWithObservabilityContext(
     { traceId: turnTraceId, spanId: turnSpanId, sessionId },
     async () => {
       // ... existing executeMessage and response logic
     },
   );
   ```

**Important:** `handleLoadAgent()` (lines 1244, 1302, 1342, 1346) is NOT a user turn — do NOT generate traceId there. Only `handleSendMessage` gets per-turn traceId.

**Step 4: Run all handler tests**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/ws`
Expected: All PASS

**Step 5: Commit**

```bash
npx prettier --write apps/runtime/src/websocket/handler.ts apps/runtime/src/__tests__/trace-context-ws-debug.test.ts
git add apps/runtime/src/websocket/handler.ts apps/runtime/src/__tests__/trace-context-ws-debug.test.ts
git commit -m "feat(runtime): generate per-turn traceId in WS debug handler via ObservabilityContext"
```

---

### Task 7: WebSocket SDK Handler — Per-Turn ObservabilityContext

**Files:**

- Modify: `apps/runtime/src/websocket/sdk-handler.ts`
- Test: `apps/runtime/src/__tests__/trace-context-ws-sdk.test.ts`

**Context:** Same pattern as Task 6 but for the SDK handler. Key difference: SDK handler builds raw `{ type: 'response_start' }` objects (NOT `ServerMessages` helpers) and constructs `TraceEventWithId` manually at 4 sites (lines 913, 995, 1532, 1932).

**Codebase-verified:**

- `crypto` imported at line 10
- `executeMessage` calls at lines ~1577 and ~1753
- 4 `TraceEventWithId` construction sites: 913, 995, 1532, 1932

**Step 1: Write the test**

```typescript
// apps/runtime/src/__tests__/trace-context-ws-sdk.test.ts
import { describe, it, expect } from 'vitest';
import crypto from 'crypto';

describe('WS SDK handler per-turn traceId', () => {
  it('should generate a valid W3C trace ID (32 hex chars)', () => {
    const traceId = crypto.randomUUID().replace(/-/g, '');
    expect(traceId).toMatch(/^[a-f0-9]{32}$/);
  });
});
```

**Step 2: Run test (baseline)**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/trace-context-ws-sdk.test.ts`
Expected: PASS

**Step 3: Modify sdk-handler.ts**

1. Add import:

   ```typescript
   import { runWithObservabilityContext, getCurrentTraceId } from '@abl/compiler/platform';
   ```

2. In the message execution function (where `executeMessage` is called at ~line 1577), wrap in ObservabilityContext:

   ```typescript
   const turnTraceId = crypto.randomUUID().replace(/-/g, '');
   const turnSpanId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);

   await runWithObservabilityContext(
     { traceId: turnTraceId, spanId: turnSpanId, sessionId: state.sessionId },
     async () => {
       // ... existing execution
     },
   );
   ```

3. Add `traceId` to raw `response_start` objects (lines 887, 1475, 1728):

   ```typescript
   send(ws, {
     type: 'response_start',
     messageId: responseMessageId,
     sessionId: state.sessionId,
     traceId: turnTraceId, // ADD
   });
   ```

4. Add `traceId` to raw `response_end` objects (lines 927, 1494, ~1587, ~1671, ~1735, ~1758):

   ```typescript
   send(ws, {
     type: 'response_end',
     messageId: responseMessageId,
     sessionId: state.sessionId,
     fullText: fullResponse,
     traceId: turnTraceId, // ADD
     // ... rest unchanged
   });
   ```

5. Add `traceId` to ALL manually constructed `TraceEventWithId` objects:
   - **Line 913** (initializeSession callback): add `traceId: getCurrentTraceId()`
   - **Line 995** (session_resolution): add `traceId: getCurrentTraceId()`
   - **Line 1532** (executeMessage callback): add `traceId: getCurrentTraceId()`
   - **Line 1932** (voice realtime) — NO CHANGE, already has `traceId` from `metrics.traceId`

**Known gap — SDK EventStore writes:** The SDK handler writes to in-memory TraceStore only (via `getTraceStore().addEvent()`), NOT to EventStore/ClickHouse. This means SDK trace events get traceId in memory but NOT in `platform_events.trace_id`. Adding EventStore writes to the SDK handler is deferred — it requires adding a TraceEmitter or routing through `createCentralizedTraceHandler`.

**Step 4: Run SDK handler tests**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/ws-sdk-handler.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
npx prettier --write apps/runtime/src/websocket/sdk-handler.ts apps/runtime/src/__tests__/trace-context-ws-sdk.test.ts
git add apps/runtime/src/websocket/sdk-handler.ts apps/runtime/src/__tests__/trace-context-ws-sdk.test.ts
git commit -m "feat(runtime): generate per-turn traceId in WS SDK handler via ObservabilityContext"
```

---

### Task 8: Add traceId to BullMQ Job Payload Types

**Files:**

- Modify: `apps/runtime/src/channels/types.ts:128-147` (InboundJobPayload, DeliveryJobPayload)
- Modify: `apps/runtime/src/services/llm/llm-queue.ts:28-35` (LLMJobData)

**Context:** Type-only change. Add `traceId` field to all job payload interfaces so trace context can cross BullMQ boundaries.

**Step 1: Add traceId to InboundJobPayload**

In `apps/runtime/src/channels/types.ts`, add to `InboundJobPayload` (~line 139):

```typescript
traceId?: string; // Unified trace ID for cross-boundary correlation
```

**Step 2: Add traceId to DeliveryJobPayload**

In the same file, add to `DeliveryJobPayload` (~line 147):

```typescript
traceId?: string;
```

**Step 3: Add traceId to LLMJobData**

In `apps/runtime/src/services/llm/llm-queue.ts`, add to `LLMJobData` (~line 35):

```typescript
traceId?: string;
```

**Step 4: Build to verify**

Run: `pnpm build --filter=runtime`
Expected: Clean build. No call sites break because the field is optional.

**Step 5: Commit**

```bash
npx prettier --write apps/runtime/src/channels/types.ts apps/runtime/src/services/llm/llm-queue.ts
git add apps/runtime/src/channels/types.ts apps/runtime/src/services/llm/llm-queue.ts
git commit -m "feat(runtime): add traceId field to BullMQ job payload types"
```

---

### Task 9: Thread traceId at BullMQ Enqueue Sites

**Files:**

- Modify: Channel webhook routes (where `InboundJobPayload` is constructed)
- Modify: Delivery queue enqueue sites (where `DeliveryJobPayload` is constructed)
- Modify: LLM queue enqueue sites (where `LLMJobData` is constructed)

**Context:** At every BullMQ enqueue site, pull `getCurrentTraceId()` from ALS and include it in the job payload. For HTTP routes, ALS is set by the observability middleware (Task 3). For WS paths, it's set by Tasks 6-7.

**Step 1: Find all enqueue sites**

```bash
grep -rn "InboundJobPayload\|channelType.*message.*subscriptionId" apps/runtime/src/ --include="*.ts" | head -20
grep -rn "DeliveryJobPayload\|deliveryId.*subscriptionId.*eventType" apps/runtime/src/ --include="*.ts" | head -20
grep -rn "LLMJobData\|jobId.*sessionId.*message.*enqueuedAt" apps/runtime/src/ --include="*.ts" | head -20
```

**Step 2: At each enqueue site, add traceId**

```typescript
import { getCurrentTraceId } from '@abl/compiler/platform';

// In every payload construction:
const payload: InboundJobPayload = {
  ...existingFields,
  traceId: getCurrentTraceId(), // ADD
};
```

Apply the same pattern to `DeliveryJobPayload` and `LLMJobData` construction sites.

**Step 3: Build and test**

Run: `pnpm build --filter=runtime && cd apps/runtime && pnpm vitest run`
Expected: All tests pass.

**Step 4: Commit**

```bash
npx prettier --write <modified files>
git add <modified files>
git commit -m "feat(runtime): thread traceId into BullMQ job payloads at enqueue sites"
```

---

### Task 10: BullMQ Inbound Worker — Enter ObservabilityContext

**Files:**

- Modify: `apps/runtime/src/services/queues/inbound-worker.ts`
- Test: `apps/runtime/src/__tests__/trace-context-inbound.test.ts`

**Context:** Worker-side: when processing an inbound job, enter `runWithObservabilityContext` so `createCentralizedTraceHandler` (Task 5) can read `getCurrentTraceId()`.

**Codebase-verified:**

- BullMQ worker callback at line 47
- `runWithTenantContext()` at line 50 (OUTER — must remain outer)
- Dedup check at lines 68-84
- `executor.executeMessage()` call at line ~944
- `crypto` NOT currently imported in this file

**Step 1: Write the test**

```typescript
// apps/runtime/src/__tests__/trace-context-inbound.test.ts
import { describe, it, expect } from 'vitest';
import crypto from 'crypto';

describe('Inbound worker traceId generation', () => {
  it('should generate W3C format traceId when payload has none', () => {
    const traceId = crypto.randomUUID().replace(/-/g, '');
    expect(traceId).toMatch(/^[a-f0-9]{32}$/);
  });

  it('should accept client-provided traceId from payload', () => {
    const clientTraceId = 'abcdef1234567890abcdef1234567890';
    expect(clientTraceId).toMatch(/^[a-f0-9]{32}$/);
  });
});
```

**Step 2: Run test (baseline)**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/trace-context-inbound.test.ts`
Expected: PASS

**Step 3: Modify inbound worker**

In `apps/runtime/src/services/queues/inbound-worker.ts`:

1. Add imports:

   ```typescript
   import crypto from 'crypto';
   import { runWithObservabilityContext } from '@abl/compiler/platform';
   ```

2. **CRITICAL nesting**: `runWithObservabilityContext` must nest INSIDE `runWithTenantContext()` (line 50), AFTER the dedup check (line ~84):

   ```typescript
   await runWithTenantContext({ tenantId: payload.tenantId, ... }, async () => {
     // ... existing dedup check (lines 68-84) ...

     // After dedup passes, before execution:
     const traceId = payload.traceId || crypto.randomUUID().replace(/-/g, '');
     const spanId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);

     await runWithObservabilityContext({ traceId, spanId }, async () => {
       // ... existing execution and delivery logic (including executeMessage at ~944)
     });
   });
   ```

**Step 4: Run existing inbound worker tests**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/inbound`
Expected: All PASS

**Step 5: Commit**

```bash
npx prettier --write apps/runtime/src/services/queues/inbound-worker.ts apps/runtime/src/__tests__/trace-context-inbound.test.ts
git add apps/runtime/src/services/queues/inbound-worker.ts apps/runtime/src/__tests__/trace-context-inbound.test.ts
git commit -m "feat(runtime): wrap inbound worker execution in ObservabilityContext for traceId"
```

---

### Task 11: REST Chat Endpoint — Surface traceId

**Files:**

- Modify: `apps/runtime/src/routes/chat.ts`
- Test: `apps/runtime/src/__tests__/trace-context-rest.test.ts`

**Context:** `routes/chat.ts` contains TWO route handlers:

- **`/stream`** (line 236): SSE streaming LLM proxy — sets `Content-Type: text/event-stream` at line 303
- **`/agent`** (line 717): Agent-backed JSON endpoint — calls `executor.executeMessage()` at line 1089, returns `res.json()` at line 1176

For HTTP routes, the observability middleware (Task 3) already generates traceId and sets `X-Trace-Id` header. The `/agent` handler should also include `traceId` in its JSON response body for convenience.

**Step 1: Write the test**

```typescript
// apps/runtime/src/__tests__/trace-context-rest.test.ts
import { describe, it, expect } from 'vitest';

describe('REST chat traceId', () => {
  it('traceId should be 32 hex chars (W3C format)', () => {
    expect('abcdef1234567890abcdef1234567890').toMatch(/^[a-f0-9]{32}$/);
  });
});
```

**Step 2: Modify `/agent` handler to include traceId in response body**

In `apps/runtime/src/routes/chat.ts`, in the `/agent` handler (~line 1176):

```typescript
import { getCurrentTraceId } from '@abl/compiler/platform';

// At line 1176 (res.json):
res.json({
  sessionId: runtimeSessionId,
  response: execResult.response,
  traceId: getCurrentTraceId(), // ADD — already in ALS from observability middleware
  action: execResult.action,
  state: execResult.stateUpdates || session?.state,
  traceEvents: traceEvents.length > 0 ? traceEvents : undefined,
  // ... rest unchanged
});
```

The `X-Trace-Id` response header is already set by the observability middleware (Task 3) — no manual header needed.

**Step 3: Build and test**

Run: `pnpm build --filter=runtime && cd apps/runtime && pnpm vitest run src/__tests__/chat`
Expected: All PASS

**Step 4: Commit**

```bash
npx prettier --write apps/runtime/src/routes/chat.ts apps/runtime/src/__tests__/trace-context-rest.test.ts
git add apps/runtime/src/routes/chat.ts apps/runtime/src/__tests__/trace-context-rest.test.ts
git commit -m "feat(runtime): include traceId in REST /agent chat response body"
```

---

### Task 12: Surface traceId in WebSocket response_start / response_end

**Files:**

- Modify: `apps/runtime/src/types/index.ts` (ServerMessage type)
- Modify: `apps/runtime/src/websocket/events.ts` (ServerMessages helpers)
- Modify: `apps/runtime/src/websocket/handler.ts` (all caller sites)
- Modify: `apps/runtime/src/__tests__/rich-content-execution.test.ts` (6 callers)
- Modify: `apps/runtime/src/__tests__/websocket-events.test.ts` (line 502)
- Test: `apps/runtime/src/__tests__/trace-surface-ws.test.ts`

**Context:** Add optional `traceId` to `response_start` and `response_end` WebSocket messages so clients can display/correlate it. The `responseEnd` helper is refactored from 6 positional params to `(sessionId, messageId, fullText, opts?)` to avoid callers needing 3 explicit `undefined`s to reach `traceId`.

**Step 1: Write the failing test**

```typescript
// apps/runtime/src/__tests__/trace-surface-ws.test.ts
import { describe, it, expect } from 'vitest';
import { ServerMessages } from '../websocket/events.js';

describe('WebSocket traceId surfacing', () => {
  it('response_start should include traceId when provided', () => {
    const msg = ServerMessages.responseStart('sess-1', 'msg-1', 'abcdef1234567890abcdef1234567890');
    expect(msg).toMatchObject({
      type: 'response_start',
      sessionId: 'sess-1',
      messageId: 'msg-1',
      traceId: 'abcdef1234567890abcdef1234567890',
    });
  });

  it('response_start should omit traceId when not provided', () => {
    const msg = ServerMessages.responseStart('sess-1', 'msg-1');
    expect((msg as any).traceId).toBeUndefined();
  });

  it('response_end should include traceId via opts', () => {
    const msg = ServerMessages.responseEnd('sess-1', 'msg-1', 'Hello', {
      traceId: 'abcdef1234567890abcdef1234567890',
    });
    expect((msg as any).traceId).toBe('abcdef1234567890abcdef1234567890');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/trace-surface-ws.test.ts`
Expected: FAIL — `traceId` not in response_start, `responseEnd` signature doesn't accept opts

**Step 3: Modify types and helpers**

In `apps/runtime/src/types/index.ts`, modify the `response_start` and `response_end` variants:

```typescript
| { type: 'response_start'; sessionId: string; messageId: string; traceId?: string }

| {
    type: 'response_end';
    sessionId: string;
    messageId: string;
    fullText: string;
    traceId?: string;
    voiceConfig?: import('@abl/compiler').VoiceConfigIR;
    richContent?: import('@abl/compiler').RichContentIR;
    actions?: import('@abl/compiler').ActionSetIR;
  }
```

In `apps/runtime/src/websocket/events.ts`, update `ServerMessages`:

```typescript
responseStart(sessionId: string, messageId: string, traceId?: string): ServerMessage {
  return {
    type: 'response_start',
    sessionId,
    messageId,
    ...(traceId && { traceId }),
  };
},

responseEnd(
  sessionId: string,
  messageId: string,
  fullText: string,
  opts?: {
    voiceConfig?: import('@abl/compiler').VoiceConfigIR;
    richContent?: import('@abl/compiler').RichContentIR;
    actions?: import('@abl/compiler').ActionSetIR;
    traceId?: string;
  },
): ServerMessage {
  return {
    type: 'response_end',
    sessionId,
    messageId,
    fullText,
    ...(opts?.traceId && { traceId: opts.traceId }),
    voiceConfig: opts?.voiceConfig,
    richContent: opts?.richContent,
    actions: opts?.actions,
  };
},
```

**Step 4: Update ALL callers of responseStart and responseEnd in handler.ts**

Import `getCurrentTraceId`:

```typescript
import { getCurrentTraceId } from '@abl/compiler/platform';
```

| Line | Function                | Action                                                                                                                                                                    |
| ---- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1244 | `handleLoadAgent`       | `responseStart` — no traceId (not a user turn), leave 2 args                                                                                                              |
| 1302 | `handleLoadAgent`       | `responseEnd` — refactor to opts: `responseEnd(sessionId, msgId, text, { voiceConfig: result?.voiceConfig, richContent: result?.richContent, actions: result?.actions })` |
| 1342 | `handleLoadAgent` error | `responseStart` — no traceId, leave 2 args                                                                                                                                |
| 1346 | `handleLoadAgent` error | `responseEnd` — refactor to opts, no traceId                                                                                                                              |
| 1416 | `handleSendMessage`     | `responseStart` — add `getCurrentTraceId()` as 3rd arg                                                                                                                    |
| 1509 | main response           | `responseEnd` — refactor to opts, add `traceId: getCurrentTraceId()`                                                                                                      |
| 1747 | handoff response        | `responseEnd` — refactor to opts, add `traceId: getCurrentTraceId()`                                                                                                      |
| 1765 | handoff fallback        | `responseEnd` — refactor to opts, add `traceId: getCurrentTraceId()`                                                                                                      |
| 1813 | fallback response       | `responseEnd` — refactor to opts, add `traceId: getCurrentTraceId()`                                                                                                      |
| 2244 | cross-pod replay        | `responseStart` — no traceId (not available cross-pod)                                                                                                                    |
| 2249 | cross-pod replay        | `responseEnd` — refactor to opts, no traceId                                                                                                                              |

**Step 5: Update test files**

`rich-content-execution.test.ts` — ALL 6 callers must migrate positional args 4-6 to opts:

```typescript
// Old: ServerMessages.responseEnd('s', 'm', 'text', undefined, richContent)
// New: ServerMessages.responseEnd('s', 'm', 'text', { richContent })

// Old: ServerMessages.responseEnd('s', 'm', 'text', voiceConfig, richContent, actions)
// New: ServerMessages.responseEnd('s', 'm', 'text', { voiceConfig, richContent, actions })
```

`websocket-events.test.ts`:

- Lines 445, 486: `responseEnd(s, m, text)` — no change (3 args still valid)
- Line 502: migrate positional to opts object

**Step 6: Run tests**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/trace-surface-ws.test.ts`
Expected: PASS

Run: `cd apps/runtime && pnpm vitest run`
Expected: All PASS

**Step 7: Commit**

```bash
npx prettier --write apps/runtime/src/types/index.ts apps/runtime/src/websocket/events.ts apps/runtime/src/websocket/handler.ts apps/runtime/src/__tests__/trace-surface-ws.test.ts apps/runtime/src/__tests__/rich-content-execution.test.ts apps/runtime/src/__tests__/websocket-events.test.ts
git add apps/runtime/src/types/index.ts apps/runtime/src/websocket/events.ts apps/runtime/src/websocket/handler.ts apps/runtime/src/__tests__/trace-surface-ws.test.ts apps/runtime/src/__tests__/rich-content-execution.test.ts apps/runtime/src/__tests__/websocket-events.test.ts
git commit -m "feat(runtime): surface traceId in WebSocket response_start and response_end messages"
```

---

### Task 13: SearchAI Client — Inject W3C traceparent Header

**Files:**

- Modify: `packages/search-ai-sdk/src/client.ts:350` (buildHeaders method)
- Test: `packages/search-ai-sdk/src/__tests__/client-trace-headers.test.ts`

**Context:** Thread trace context from Runtime → SearchAI via W3C `traceparent` header. The SearchAI service's observability middleware (Task 4) will parse it and enter the same trace context.

**Step 1: Write the failing test**

```typescript
// packages/search-ai-sdk/src/__tests__/client-trace-headers.test.ts
import { describe, test, expect } from 'vitest';
import { runWithObservabilityContext, getObservabilityContext } from '@abl/compiler/platform';

describe('SearchAIClient trace header injection', () => {
  test('traceparent format is correct', () => {
    const traceId = 'abcdef1234567890abcdef1234567890';
    const spanId = '1234567890abcdef';
    const traceparent = `00-${traceId}-${spanId}-01`;
    expect(traceparent).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
  });

  test('ObservabilityContext is readable within runWithObservabilityContext', () => {
    let ctx: any;
    runWithObservabilityContext(
      { traceId: 'abcdef1234567890abcdef1234567890', spanId: '1234567890abcdef' },
      () => {
        ctx = getObservabilityContext();
      },
    );
    expect(ctx?.traceId).toBe('abcdef1234567890abcdef1234567890');
  });
});
```

**Step 2: Run test (baseline)**

Run: `cd packages/search-ai-sdk && pnpm vitest run src/__tests__/client-trace-headers.test.ts`
Expected: PASS

**Step 3: Modify buildHeaders to inject trace context**

In `packages/search-ai-sdk/src/client.ts`, modify the `buildHeaders()` method (~line 350):

```typescript
import { getObservabilityContext } from '@abl/compiler/platform';
import { randomUUID } from 'crypto';

// Inside buildHeaders():
private buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...this.headers,
  };
  if (this.authToken) {
    headers['Authorization'] = `Bearer ${this.authToken}`;
  }
  // Propagate trace context across service boundary
  const ctx = getObservabilityContext();
  if (ctx?.traceId) {
    const spanId = ctx.spanId || randomUUID().replace(/-/g, '').slice(0, 16);
    headers['traceparent'] = `00-${ctx.traceId}-${spanId}-01`;
    headers['X-Trace-Id'] = ctx.traceId;
  }
  return headers;
}
```

Check if `@abl/compiler` is in `packages/search-ai-sdk/package.json`. If not, add it.

**Step 4: Build and test**

Run: `pnpm build --filter=@agent-platform/search-ai-sdk && cd packages/search-ai-sdk && pnpm vitest run`
Expected: All PASS

**Step 5: Commit**

```bash
npx prettier --write packages/search-ai-sdk/src/client.ts packages/search-ai-sdk/src/__tests__/client-trace-headers.test.ts
git add packages/search-ai-sdk/src/client.ts packages/search-ai-sdk/src/__tests__/client-trace-headers.test.ts
git commit -m "feat(search-ai-sdk): inject W3C traceparent header for cross-service trace propagation"
```

---

### Task 14: Accept Client-Provided X-Trace-ID in Channel Webhooks

**Files:**

- Modify: `apps/runtime/src/routes/channel-webhooks.ts` (or equivalent webhook routes)
- Test: `apps/runtime/src/__tests__/trace-context-client-provided.test.ts`

**Context:** External channel integrations may provide their own trace IDs via `X-Trace-ID` header. The observability middleware already handles `traceparent` (W3C). This task handles the simpler `X-Trace-ID` custom header for non-W3C clients.

**Step 1: Write the test**

```typescript
// apps/runtime/src/__tests__/trace-context-client-provided.test.ts
import { describe, it, expect } from 'vitest';

const VALID_TRACE_ID = /^[a-zA-Z0-9\-]{1,64}$/;

describe('Client-provided trace ID validation', () => {
  it('should accept valid client trace ID', () => {
    expect(VALID_TRACE_ID.test('abc-123-def')).toBe(true);
    expect(VALID_TRACE_ID.test('a'.repeat(64))).toBe(true);
  });

  it('should reject invalid client trace IDs', () => {
    expect(VALID_TRACE_ID.test('')).toBe(false);
    expect(VALID_TRACE_ID.test('a'.repeat(65))).toBe(false);
    expect(VALID_TRACE_ID.test('has spaces')).toBe(false);
  });
});
```

**Step 2: In webhook routes, extract X-Trace-ID and pass into InboundJobPayload**

```typescript
const VALID_TRACE_ID = /^[a-zA-Z0-9\-]{1,64}$/;
const clientTraceId = req.headers['x-trace-id'] as string | undefined;
const traceId = clientTraceId && VALID_TRACE_ID.test(clientTraceId) ? clientTraceId : undefined;

// Include in payload:
const jobPayload: InboundJobPayload = {
  ...existingFields,
  traceId, // Will be used by Task 10 if present, otherwise worker generates one
};
```

**Step 3: Commit**

```bash
npx prettier --write <modified files>
git add <modified files>
git commit -m "feat(runtime): accept client-provided X-Trace-ID in channel webhook payloads"
```

---

### Task 15: Remove Kafka Trace Header Feature Flag

**Files:**

- Modify: `apps/runtime/src/services/event-bus/kafka-subscriber.ts`

**Context:** Kafka trace header injection is gated behind `OBS_EVENTBUS_TRACE_HEADERS=true` (disabled by default). Now that observability context is always active, make it always-on.

**Codebase-verified:**

- Feature flag at line 111: `this.traceHeadersEnabled = process.env.OBS_EVENTBUS_TRACE_HEADERS === 'true'`
- Guard at lines 121-126: `if (this.traceHeadersEnabled) { ... }`
- Guard at lines 263-272: `if (this.traceHeadersEnabled) { ... }`

**Step 1: Remove the feature flag**

1. Remove line 111: `this.traceHeadersEnabled = process.env.OBS_EVENTBUS_TRACE_HEADERS === 'true';`
2. Remove the `traceHeadersEnabled` field from the class
3. Remove the `if (this.traceHeadersEnabled)` guards at lines 121-126 and 263-272, keeping the inner code unconditional

**Step 2: Build and test**

Run: `pnpm build --filter=runtime && cd apps/runtime && pnpm vitest run`
Expected: All PASS

**Step 3: Commit**

```bash
npx prettier --write apps/runtime/src/services/event-bus/kafka-subscriber.ts
git add apps/runtime/src/services/event-bus/kafka-subscriber.ts
git commit -m "feat(runtime): make Kafka trace header injection always-on (remove feature flag)"
```

---

### Task 16: Create Instrumentation Coverage Map

**Files:**

- Create: `docs/plans/2026-03-11-trace-instrumentation-coverage.md`

**Step 1: Create the document**

```markdown
# Trace Instrumentation Coverage Map

**Date**: 2026-03-11
**Status**: Platform Trace Readiness Complete

## Channel Entry Points

| Entry Point              | File                                | traceId Generated                        | ALS Context                       | ClickHouse trace_id                          | Client Surfaced                  |
| ------------------------ | ----------------------------------- | ---------------------------------------- | --------------------------------- | -------------------------------------------- | -------------------------------- |
| HTTP (all routes)        | Observability middleware            | YES (W3C traceparent or generated)       | YES (runWithObservabilityContext) | YES (via centralized handler)                | YES (X-Trace-Id header)          |
| WebSocket Debug          | `websocket/handler.ts`              | YES (per turn)                           | YES (runWithObservabilityContext) | YES (via centralized handler)                | YES (response_start.traceId)     |
| WebSocket SDK            | `websocket/sdk-handler.ts`          | YES (per turn)                           | YES (runWithObservabilityContext) | NO (TraceStore only, no centralized handler) | YES (raw response_start.traceId) |
| Channel Inbound (BullMQ) | `services/queues/inbound-worker.ts` | YES (per job, from payload or generated) | YES (runWithObservabilityContext) | YES (via centralized handler)                | YES (via webhook delivery)       |
| Voice (KoreVG)           | `observability/voice-trace.ts`      | YES (existing)                           | Separate system                   | YES (voice events)                           | YES (via voice trace)            |

## Cross-Service Propagation

| Source → Target       | Header                       | Status                   |
| --------------------- | ---------------------------- | ------------------------ |
| Runtime → SearchAI    | W3C traceparent + X-Trace-Id | YES (Task 13)            |
| Runtime → Kafka       | traceparent + tracestate     | YES (Task 15, always-on) |
| Runtime → BullMQ jobs | traceId in payload           | YES (Tasks 8-10)         |

## Trace ID Lifecycle

1. **Generation**: Observability middleware (HTTP) or `crypto.randomUUID().replace(/-/g, '')` (WS per-turn)
2. **ALS Storage**: `runWithObservabilityContext({ traceId, spanId })` — compiler's existing ALS
3. **Event Stamping**: `createCentralizedTraceHandler` calls `getCurrentTraceId()` — stamps ALL events
4. **ClickHouse**: `platform_events.trace_id` populated via EventStore (bloom filter indexed)
5. **Client Surface**: `X-Trace-Id` header (HTTP), `response_start.traceId` (WS), JSON body (REST /agent)

**ClickHouse query note:** The `idx_trace` bloom filter only supports equality queries. Always use `WHERE trace_id = 'xxx'`.

## Remaining Gaps

| Gap                                                            | Severity | Phase    |
| -------------------------------------------------------------- | -------- | -------- |
| SDK handler EventStore writes (TraceStore only, no ClickHouse) | Medium   | Phase 0a |
| Studio/web-sdk TypeScript types for traceId on WS messages     | Low      | Phase 0a |
| channel_response_sent exit events at response boundaries       | Medium   | Phase 0a |
| API response envelope traceId (error responses)                | Low      | Phase 0a |
```

**Step 2: Commit**

```bash
npx prettier --write docs/plans/2026-03-11-trace-instrumentation-coverage.md
git add docs/plans/2026-03-11-trace-instrumentation-coverage.md
git commit -m "docs: add trace instrumentation coverage map"
```

---

### Task 17: Full Build and Test Suite Verification

**Files:** None (verification only)

**Step 1: Build all affected packages**

Run: `pnpm build`
Expected: Clean build across all packages.

**Step 2: Run full runtime test suite**

Run: `cd apps/runtime && pnpm vitest run`
Expected: All tests pass, no regressions.

**Step 3: Run search-ai-sdk tests**

Run: `cd packages/search-ai-sdk && pnpm vitest run`
Expected: All tests pass.

**Step 4: Run compiler tests**

Run: `cd packages/compiler && pnpm vitest run`
Expected: All tests pass.

**Step 5: Manual verification (if local env available)**

1. `curl -v http://localhost:3112/health` → verify `X-Trace-Id` header (32 hex chars)
2. `curl -v -H "traceparent: 00-abcdef1234567890abcdef1234567890-1234567890abcdef-01" http://localhost:3112/health` → verify `X-Trace-Id: abcdef1234567890abcdef1234567890`
3. After running a session: `SELECT trace_id FROM platform_events WHERE timestamp > now() - INTERVAL 5 MINUTE LIMIT 10` → verify non-empty trace_id

**Step 6: Final commit (if any fixups)**

```bash
git commit -m "fix: trace readiness verification fixups"
```

---

## Summary

| Task | What                                      | Key Files                                                 |
| ---- | ----------------------------------------- | --------------------------------------------------------- |
| 1    | Export observability from compiler barrel | `packages/compiler/src/platform/index.ts`                 |
| 2    | CORS exposedHeaders for browser access    | `packages/config/src/schemas/cors.schema.ts`, `server.ts` |
| 3    | Mount observability middleware on runtime | `apps/runtime/src/server.ts`                              |
| 4    | Mount on search-ai services               | `apps/search-ai/src/server.ts`, `search-ai-runtime`       |
| 5    | Stamp traceId in centralized handler      | `apps/runtime/src/services/runtime-executor.ts`           |
| 6    | WS debug handler per-turn traceId         | `apps/runtime/src/websocket/handler.ts`                   |
| 7    | WS SDK handler per-turn traceId           | `apps/runtime/src/websocket/sdk-handler.ts`               |
| 8    | BullMQ payload types + traceId            | `channels/types.ts`, `llm-queue.ts`                       |
| 9    | BullMQ enqueue site threading             | Channel/delivery/LLM enqueue sites                        |
| 10   | BullMQ inbound worker ALS                 | `services/queues/inbound-worker.ts`                       |
| 11   | REST chat traceId in response body        | `routes/chat.ts`                                          |
| 12   | WS response_start/end traceId             | `types/index.ts`, `events.ts`, `handler.ts`               |
| 13   | SearchAI traceparent propagation          | `packages/search-ai-sdk/src/client.ts`                    |
| 14   | Client X-Trace-ID in webhooks             | Channel webhook routes                                    |
| 15   | Kafka trace headers always-on             | `event-bus/kafka-subscriber.ts`                           |
| 16   | Coverage map document                     | `docs/plans/`                                             |
| 17   | Full build + test verification            | Verification only                                         |

## Dependency Graph

```
Task 1 (compiler barrel) ─────────────────────────────────────────┐
Task 2 (CORS) ────────────────────────────────────────────────────┤
Task 3 (mount middleware on runtime) ──┬── Task 5 (stamp traceId) ┤
Task 4 (mount on search-ai) ──────────┤                           │
Task 8 (BullMQ payload types) ───┬─────┤                           │
Task 9 (BullMQ enqueue sites) ───┤     │                           ├── Task 17 (verification)
Task 10 (BullMQ worker ALS) ─────┘     │                           │
Task 6 (WS debug handler) ─────────────┼── Task 12 (WS messages) ─┤
Task 7 (WS SDK handler) ───────────────┘                           │
Task 11 (REST chat traceId) ──────────────────────────────────────┤
Task 13 (SearchAI propagation) ───────────────────────────────────┤
Task 14 (client X-Trace-ID) ─────────────────────────────────────┤
Task 15 (Kafka always-on) ───────────────────────────────────────┤
Task 16 (coverage map) ──────────────────────────────────────────┘
```

**Parallelizable groups:**

- **Group A** (independent, do first): Tasks 1, 2, 8
- **Group B** (depends on Task 1): Tasks 3, 4, 5, 6, 7, 9, 10, 13
- **Group C** (depends on Group B): Tasks 11, 12, 14, 15
- **Group D** (final): Tasks 16, 17

**Key advantages over prior plans:**

- Uses EXISTING observability middleware (no new ALS module — eliminates duplication)
- Centralized stamping via `createCentralizedTraceHandler` (1 line change fills ClickHouse for all channels)
- W3C traceparent format (compatible with external systems)
- Per-turn granularity on WebSocket (each message individually addressable)
- Cross-service propagation included (Runtime → SearchAI)
- Full BullMQ threading (inbound + delivery + LLM queues)
