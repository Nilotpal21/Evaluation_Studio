# Platform Trace Readiness (STI Foundation) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Establish a unified W3C-compatible `traceId` flowing through every code path from channel entry to channel exit, across service boundaries, and into ClickHouse — prerequisite for STI Phase 0a.

**Architecture:** Mount the existing `createObservabilityMiddleware` (already implemented in `shared-observability`, never wired) on all 5 Express servers. Wire it to the compiler's `runWithObservabilityContext` ALS so `getCurrentTraceId()` works everywhere. Stamp every `TraceEvent` with `traceId` via the centralized handler. Thread `traceId` through BullMQ job payloads and outbound HTTP headers.

**Tech Stack:** Express middleware, AsyncLocalStorage, W3C traceparent, ClickHouse, Redis Streams, BullMQ, WebSocket

**Key references:**

- Design doc: `docs/plans/2026-03-11-spatial-trace-intelligence-design.md` (§ Platform Trace Readiness)
- Observability middleware: `packages/shared-observability/src/middleware/observability.ts`
- Compiler ALS: `packages/compiler/src/platform/observability/context.ts`
- Centralized trace handler: `apps/runtime/src/services/runtime-executor.ts:1418`

---

## Task 1: Add `exposedHeaders` to CORS Schema

Independent change. Without this, browser clients silently cannot read `X-Trace-Id` from cross-origin responses.

**Files:**

- Modify: `packages/config/src/schemas/cors.schema.ts`
- Test: `pnpm build --filter=@agent-platform/config`

**Step 1: Add exposedHeaders field to CORS schema**

In `packages/config/src/schemas/cors.schema.ts`, add `exposedHeaders` to the Zod schema:

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
  exposedHeaders: z.array(z.string()).default(['X-Request-Id', 'X-Trace-Id']),
});
```

**Step 2: Wire exposedHeaders in runtime CORS setup**

In `apps/runtime/src/server.ts`, the CORS middleware at line ~200 reads from `config.cors`. Add `exposedHeaders`:

```typescript
// apps/runtime/src/server.ts — around line 200-208
const corsOptions = {
  origin: config.env === 'prod' ? config.server.frontendUrl : config.cors.origins,
  credentials: config.cors.credentials,
  methods: config.cors.methods,
  allowedHeaders: config.cors.allowedHeaders,
  exposedHeaders: config.cors.exposedHeaders, // ADD THIS LINE
};
```

Repeat for any other service that uses `config.cors` in its CORS setup (search-ai, etc.).

**Step 3: Build and verify**

Run: `pnpm build --filter=@agent-platform/config`
Expected: Clean build, no errors.

**Step 4: Commit**

```bash
git add packages/config/src/schemas/cors.schema.ts apps/runtime/src/server.ts
git commit -m "feat: add exposedHeaders to CORS schema for X-Trace-Id browser access"
```

---

## Task 2: Mount Observability Middleware on Runtime

This is the core change — wires `createObservabilityMiddleware` (already implemented, never mounted) to the compiler's `runWithObservabilityContext` ALS, making `getCurrentTraceId()` available in every downstream async call.

**Files:**

- Modify: `apps/runtime/src/server.ts:229` (add middleware mount)
- Read first: `packages/shared-observability/src/middleware/observability.ts` (understand config shape)
- Read first: `packages/compiler/src/platform/observability/context.ts` (understand ALS)

**Step 1: Write a test for the middleware wiring**

Create `apps/runtime/src/__tests__/trace-id-middleware.test.ts`:

```typescript
import { describe, test, expect } from 'vitest';
import request from 'supertest';
import { app } from '../server.js';

describe('Trace ID middleware', () => {
  test('sets X-Trace-Id response header on every request', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-trace-id']).toBeDefined();
    expect(res.headers['x-trace-id']).toMatch(/^[a-f0-9]{32}$/);
  });

  test('honors incoming traceparent header', async () => {
    const incomingTraceId = 'abcdef1234567890abcdef1234567890';
    const res = await request(app)
      .get('/health')
      .set('traceparent', `00-${incomingTraceId}-1234567890abcdef-01`);
    expect(res.headers['x-trace-id']).toBe(incomingTraceId);
  });

  test('X-Request-ID header still works alongside X-Trace-Id', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-request-id']).toBeDefined();
    expect(res.headers['x-trace-id']).toBeDefined();
    // They should be different IDs
    expect(res.headers['x-request-id']).not.toBe(res.headers['x-trace-id']);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm build --filter=runtime && pnpm --filter=runtime test -- --run src/__tests__/trace-id-middleware.test.ts`
Expected: FAIL — `x-trace-id` header not present.

**Step 3: Mount the middleware in runtime server.ts**

In `apps/runtime/src/server.ts`, add import and mount after `requestIdMiddleware()`:

```typescript
// At the import section (around line 138), add:
import {
  requestIdMiddleware,
  createObservabilityMiddleware,
} from '@agent-platform/shared-observability';
import { runWithObservabilityContext } from '@abl/compiler/platform';

// After the existing requestIdMiddleware() line (~229), add:
// Request correlation ID
app.use(requestIdMiddleware());

// Trace context (W3C traceparent → AsyncLocalStorage)
app.use(
  createObservabilityMiddleware({
    runWithContext: (ctx, fn) => runWithObservabilityContext(ctx, fn),
  }),
);
```

**Step 4: Run test to verify it passes**

Run: `pnpm build --filter=runtime && pnpm --filter=runtime test -- --run src/__tests__/trace-id-middleware.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
npx prettier --write apps/runtime/src/server.ts apps/runtime/src/__tests__/trace-id-middleware.test.ts
git add apps/runtime/src/server.ts apps/runtime/src/__tests__/trace-id-middleware.test.ts
git commit -m "feat(runtime): mount observability middleware for unified trace ID"
```

---

## Task 3: Mount Observability Middleware on All Other Services

Same pattern as Task 2, applied to the remaining 4 services.

**Files:**

- Modify: `apps/search-ai/src/server.ts:95`
- Modify: `apps/search-ai-runtime/src/server.ts:76`
- Modify: `apps/workflow-engine/src/index.ts:94`
- Modify: `apps/multimodal-service/src/server.ts:89`

**Step 1: Mount on search-ai**

In `apps/search-ai/src/server.ts`, after the existing `requestIdMiddleware()` at line 95:

```typescript
// Add to imports (line ~42):
import {
  requestIdMiddleware,
  createObservabilityMiddleware,
} from '@agent-platform/shared-observability';
import { runWithObservabilityContext } from '@abl/compiler/platform';

// After requestIdMiddleware() (line ~95):
app.use(requestIdMiddleware());
app.use(
  createObservabilityMiddleware({
    runWithContext: (ctx, fn) => runWithObservabilityContext(ctx, fn),
  }),
);
```

**Step 2: Mount on search-ai-runtime**

Same pattern in `apps/search-ai-runtime/src/server.ts` after line 76.

**Step 3: Mount on workflow-engine**

In `apps/workflow-engine/src/index.ts`, the import is from `@agent-platform/shared` (line 19), not `@agent-platform/shared-observability`. Check if `createObservabilityMiddleware` is re-exported from `@agent-platform/shared`. If not, add a direct import from `@agent-platform/shared-observability`.

```typescript
// Add import:
import { createObservabilityMiddleware } from '@agent-platform/shared-observability';
import { runWithObservabilityContext } from '@abl/compiler/platform';

// After requestIdMiddleware() (line ~94):
app.use(requestIdMiddleware());
app.use(
  createObservabilityMiddleware({
    runWithContext: (ctx, fn) => runWithObservabilityContext(ctx, fn),
  }),
);
```

**Step 4: Mount on multimodal-service**

Same pattern in `apps/multimodal-service/src/server.ts` after line 89. Same import note as workflow-engine — it imports from `@agent-platform/shared`.

**Step 5: Build all services**

Run: `pnpm build --filter=search-ai --filter=search-ai-runtime --filter=workflow-engine --filter=multimodal-service`
Expected: Clean builds. If any service doesn't have `@abl/compiler` as a dependency, add it to `package.json`.

**Step 6: Commit**

```bash
npx prettier --write apps/search-ai/src/server.ts apps/search-ai-runtime/src/server.ts apps/workflow-engine/src/index.ts apps/multimodal-service/src/server.ts
git add apps/search-ai/src/server.ts apps/search-ai-runtime/src/server.ts apps/workflow-engine/src/index.ts apps/multimodal-service/src/server.ts
git commit -m "feat: mount observability middleware on all services for unified trace ID"
```

---

## Task 4: Add `channel_response_sent` Trace Event Type

Add the new event type to the union before any handler code references it.

**Files:**

- Modify: `apps/runtime/src/types/index.ts` (TraceEventType union)

**Step 1: Add the event type**

In `apps/runtime/src/types/index.ts`, add `'channel_response_sent'` to the `TraceEventType` union (around line 44-126). Add it near the end of the union alongside other channel-level events:

```typescript
  | 'status_update'
  | 'status_clear'
  | 'channel_response_sent';  // ADD — marks response exit from platform boundary
```

**Step 2: Build to verify**

Run: `pnpm build --filter=runtime`
Expected: Clean build.

**Step 3: Commit**

```bash
npx prettier --write apps/runtime/src/types/index.ts
git add apps/runtime/src/types/index.ts
git commit -m "feat(runtime): add channel_response_sent trace event type"
```

---

## Task 5: Stamp traceId in createCentralizedTraceHandler

The highest-impact single change — fills the empty `platform_events.trace_id` ClickHouse column for ALL channels.

**Files:**

- Modify: `apps/runtime/src/services/runtime-executor.ts:1418` (createCentralizedTraceHandler)

**Step 1: Write a test for traceId stamping**

Create or add to existing test file. The centralized handler should stamp every emitted TraceEventWithId with `traceId`:

```typescript
// In a relevant test file, e.g., apps/runtime/src/__tests__/trace-id-stamping.test.ts
import { describe, test, expect, vi } from 'vitest';

describe('createCentralizedTraceHandler stamps traceId', () => {
  test('every emitted TraceEventWithId has a non-empty traceId', async () => {
    // This test verifies the behavior after the handler change.
    // The exact test setup depends on how the RuntimeExecutor is instantiated in tests.
    // Key assertion: captured TraceEventWithId objects must have traceId set.
    // See existing runtime executor tests for setup patterns.
  });
});
```

Note: The exact test setup depends on existing RuntimeExecutor test patterns. Read `apps/runtime/src/__tests__/` for the fixture pattern before writing.

**Step 2: Modify createCentralizedTraceHandler to accept and stamp traceId**

In `apps/runtime/src/services/runtime-executor.ts`, modify the function signature (around line 1428) to accept `traceId`:

```typescript
private createCentralizedTraceHandler(
  sessionId: string,
  tenantId: string | undefined,
  agentName: string | undefined,
  projectId: string | undefined,
  channelType: string | undefined,
  originalOnTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  sessionRef?: { customDimensions?: Map<string, string> },
  traceId?: string,  // ADD THIS PARAMETER
): (event: { type: string; data: Record<string, unknown> }) => void {
```

Then in the returned function (around line 1452), where `traceEvent` is constructed, add `traceId`:

```typescript
const traceEvent: TraceEventWithId = {
  id: crypto.randomUUID(),
  sessionId,
  traceId, // ADD — stamps every event with the unified trace ID
  type: event.type as TraceEventType,
  timestamp: new Date(),
  data: { ...event.data, tenantId },
  agentName: (event.data?.agentName as string) || agentName,
};
```

**Step 3: Update all call sites of createCentralizedTraceHandler to pass traceId**

Search for all places `createCentralizedTraceHandler` is called in the file. At each call site, obtain the traceId from the ObservabilityContext ALS:

```typescript
import { getCurrentTraceId } from '@abl/compiler/platform';

// At each call site, pass getCurrentTraceId() as the last argument:
const handler = this.createCentralizedTraceHandler(
  sessionId,
  tenantId,
  agentName,
  projectId,
  channelType,
  originalOnTraceEvent,
  sessionRef,
  getCurrentTraceId(), // ADD — pulls from ALS set by observability middleware
);
```

Note: For WebSocket paths where the middleware ALS may not be active (WS connections don't go through Express middleware), pass the `traceId` from `ClientState` instead (set up in Task 8).

**Step 4: Build and test**

Run: `pnpm build --filter=runtime && pnpm --filter=runtime test -- --run`
Expected: All existing tests pass. New test passes.

**Step 5: Commit**

```bash
npx prettier --write apps/runtime/src/services/runtime-executor.ts
git add apps/runtime/src/services/runtime-executor.ts
git commit -m "feat(runtime): stamp traceId on every TraceEvent via centralized handler"
```

---

## Task 6: Add traceId to BullMQ Job Payload Types

Type-only change. Add `traceId` field to all job payload interfaces.

**Files:**

- Modify: `apps/runtime/src/channels/types.ts:128-147` (InboundJobPayload, DeliveryJobPayload)
- Modify: `apps/runtime/src/services/llm/llm-queue.ts:28-35` (LLMJobData)

**Step 1: Add traceId to InboundJobPayload**

In `apps/runtime/src/channels/types.ts`, add to `InboundJobPayload` (around line 128):

```typescript
export interface InboundJobPayload {
  connectionId: string;
  tenantId: string;
  projectId: string;
  agentId: string | null;
  deploymentId?: string | null;
  environment?: string | null;
  channelType: ChannelType;
  message: NormalizedIncomingMessage;
  subscriptionId: string;
  idempotencyKey: string;
  traceId?: string; // ADD — unified trace ID for cross-boundary correlation
}
```

**Step 2: Add traceId to DeliveryJobPayload**

In the same file, add to `DeliveryJobPayload` (around line 140):

```typescript
export interface DeliveryJobPayload {
  deliveryId: string;
  subscriptionId: string;
  tenantId: string;
  eventType: WebhookEventType;
  payload: string;
  traceId?: string; // ADD
}
```

**Step 3: Add traceId to LLMJobData**

In `apps/runtime/src/services/llm/llm-queue.ts`, add to `LLMJobData` (around line 28):

```typescript
interface LLMJobData {
  jobId: string;
  sessionId: string;
  message: string;
  tenantId?: string;
  enqueuedAt: number;
  execOptions?: { attachmentIds?: string[] };
  traceId?: string; // ADD
}
```

**Step 4: Build to verify**

Run: `pnpm build --filter=runtime`
Expected: Clean build. No call sites break because the field is optional (`?`).

**Step 5: Commit**

```bash
npx prettier --write apps/runtime/src/channels/types.ts apps/runtime/src/services/llm/llm-queue.ts
git add apps/runtime/src/channels/types.ts apps/runtime/src/services/llm/llm-queue.ts
git commit -m "feat(runtime): add traceId field to BullMQ job payload types"
```

---

## Task 7: Thread traceId at BullMQ Enqueue Sites

Pass `getCurrentTraceId()` into job payloads when enqueueing BullMQ jobs.

**Files:**

- Modify: Webhook route / channel enqueue code (where `InboundJobPayload` is constructed)
- Modify: Delivery queue enqueue code (where `DeliveryJobPayload` is constructed)
- Modify: LLM queue enqueue code (where `LLMJobData` is constructed)

**Step 1: Find all enqueue sites**

Search for where each payload type is constructed:

```bash
# Find InboundJobPayload construction sites
grep -rn "InboundJobPayload\|channelType.*message.*subscriptionId" apps/runtime/src/ --include="*.ts" | head -20

# Find DeliveryJobPayload construction sites
grep -rn "DeliveryJobPayload\|deliveryId.*subscriptionId.*eventType" apps/runtime/src/ --include="*.ts" | head -20

# Find LLMJobData construction sites
grep -rn "LLMJobData\|jobId.*sessionId.*message.*enqueuedAt" apps/runtime/src/ --include="*.ts" | head -20
```

**Step 2: At each enqueue site, add traceId**

At every location where a job payload is constructed, add:

```typescript
import { getCurrentTraceId } from '@abl/compiler/platform';

// In the payload construction:
const payload: InboundJobPayload = {
  ...existingFields,
  traceId: getCurrentTraceId(), // ADD
};
```

The ALS will be populated by the observability middleware (Task 2) for HTTP routes, and by the WS handler (Task 8) for WebSocket paths.

**Step 3: Build and test**

Run: `pnpm build --filter=runtime && pnpm --filter=runtime test -- --run`
Expected: All tests pass.

**Step 4: Commit**

```bash
npx prettier --write <modified files>
git add <modified files>
git commit -m "feat(runtime): thread traceId into BullMQ job payloads at enqueue sites"
```

---

## Task 8: BullMQ Workers Set Up ObservabilityContext

Worker-side: when processing a job, wrap execution in `runWithObservabilityContext` so all downstream code can access `getCurrentTraceId()`.

**Files:**

- Modify: `apps/runtime/src/services/queues/inbound-worker.ts` (around line 944)
- Modify: Any other BullMQ worker files that process jobs with traceId

**Step 1: Write a test for worker trace context**

```typescript
// In a test for inbound-worker
describe('inbound worker trace context', () => {
  test('sets ObservabilityContext from job traceId', async () => {
    // Verify that getCurrentTraceId() returns the job's traceId during execution
    // This depends on how inbound-worker is tested — check existing test patterns
  });
});
```

**Step 2: Wrap worker execution in ObservabilityContext**

In `apps/runtime/src/services/queues/inbound-worker.ts`, import and wrap the execution:

```typescript
import { runWithObservabilityContext } from '@abl/compiler/platform';
import { randomUUID } from 'crypto';

// Around the executor.executeMessage call (line ~944):
const traceId = payload.traceId || randomUUID().replace(/-/g, '');
const spanId = randomUUID().replace(/-/g, '').slice(0, 16);

const executePromise = runWithObservabilityContext({ traceId, spanId }, () =>
  executor.executeMessage(
    session.runtimeSessionId,
    payload.message.text,
    (chunk: string) => {
      chunks.push(chunk);
      if (streamBuffer) {
        streamBuffer.onChunk(chunk).catch((err) => {
          const errMsg = err instanceof Error ? err.message : String(err);
          log.error('Stream onChunk error', {
            error: errMsg,
            channelType: payload.channelType,
          });
        });
      }
    },
    undefined, // onTraceEvent — centralized handler picks up traceId from ALS
    Object.keys(execOptions).length > 0 ? execOptions : undefined,
  ),
);
```

**Step 3: Build and test**

Run: `pnpm build --filter=runtime && pnpm --filter=runtime test -- --run`
Expected: All tests pass.

**Step 4: Commit**

```bash
npx prettier --write apps/runtime/src/services/queues/inbound-worker.ts
git add apps/runtime/src/services/queues/inbound-worker.ts
git commit -m "feat(runtime): wrap BullMQ worker execution in ObservabilityContext for traceId"
```

---

## Task 9: SearchAI Client Trace Header Injection

Thread trace context from runtime → SearchAI via W3C `traceparent` header.

**Files:**

- Modify: `packages/search-ai-sdk/src/client.ts:350` (buildHeaders method)

**Step 1: Write a test for trace header injection**

```typescript
// In packages/search-ai-sdk/src/__tests__/client-trace-headers.test.ts
import { describe, test, expect } from 'vitest';
import { SearchAIClient } from '../client.js';
import { runWithObservabilityContext } from '@abl/compiler/platform';

describe('SearchAIClient trace header injection', () => {
  test('injects traceparent header when ObservabilityContext is active', () => {
    const client = new SearchAIClient({ baseUrl: 'http://localhost:3113' });

    runWithObservabilityContext(
      { traceId: 'abcdef1234567890abcdef1234567890', spanId: '1234567890abcdef' },
      () => {
        // Access the private method via any cast for testing
        const headers = (client as any).buildHeaders();
        expect(headers['traceparent']).toBe(
          '00-abcdef1234567890abcdef1234567890-1234567890abcdef-01',
        );
        expect(headers['X-Trace-Id']).toBe('abcdef1234567890abcdef1234567890');
      },
    );
  });

  test('does not inject traceparent when no ObservabilityContext', () => {
    const client = new SearchAIClient({ baseUrl: 'http://localhost:3113' });
    const headers = (client as any).buildHeaders();
    expect(headers['traceparent']).toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm build --filter=@agent-platform/search-ai-sdk && pnpm --filter=@agent-platform/search-ai-sdk test -- --run`
Expected: FAIL — traceparent not in headers.

**Step 3: Modify buildHeaders to inject trace context**

In `packages/search-ai-sdk/src/client.ts`, modify `buildHeaders()` (line 350):

```typescript
import { getObservabilityContext } from '@abl/compiler/platform';
import { randomUUID } from 'crypto';

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

Check if `@abl/compiler` is in `packages/search-ai-sdk/package.json` dependencies. If not, add it.

**Step 4: Run test to verify it passes**

Run: `pnpm build --filter=@agent-platform/search-ai-sdk && pnpm --filter=@agent-platform/search-ai-sdk test -- --run`
Expected: PASS

**Step 5: Commit**

```bash
npx prettier --write packages/search-ai-sdk/src/client.ts packages/search-ai-sdk/src/__tests__/client-trace-headers.test.ts
git add packages/search-ai-sdk/src/client.ts packages/search-ai-sdk/src/__tests__/client-trace-headers.test.ts
git commit -m "feat(search-ai-sdk): inject W3C traceparent header for cross-service trace propagation"
```

---

## Task 10: WS Handlers Generate and Store traceId

WebSocket connections don't go through Express middleware, so traceId must be generated and stored explicitly in `ClientState`.

**Files:**

- Modify: `apps/runtime/src/websocket/handler.ts:141` (ClientState interface + agent load)
- Modify: `apps/runtime/src/websocket/sdk-handler.ts` (SDK ClientState equivalent)

**Step 1: Add traceId to ClientState in debug WS handler**

In `apps/runtime/src/websocket/handler.ts`, add `traceId` to `ClientState` (line ~141):

```typescript
interface ClientState {
  ws: WebSocket;
  traceId?: string; // ADD — unified trace ID for this WS session
  sessionId?: string;
  runtimeSession?: RuntimeSession;
  // ... rest of fields
}
```

**Step 2: Generate traceId at connection/agent-load time**

Find where `sessionId` is pre-generated (around line 860: `const preGeneratedSessionId = crypto.randomUUID()`). Generate `traceId` alongside it:

```typescript
const preGeneratedSessionId = crypto.randomUUID();
const traceId = crypto.randomUUID().replace(/-/g, ''); // ADD — 32 hex chars, W3C format
```

Store it in the client state:

```typescript
state.traceId = traceId;
```

**Step 3: Wrap executeMessage calls in ObservabilityContext**

At each `executeMessage` call in the WS handler, wrap with:

```typescript
import { runWithObservabilityContext } from '@abl/compiler/platform';

runWithObservabilityContext(
  { traceId: state.traceId!, spanId: crypto.randomUUID().replace(/-/g, '').slice(0, 16) },
  () => executor.executeMessage(...)
);
```

This ensures `getCurrentTraceId()` works inside the execution path, and `createCentralizedTraceHandler` (Task 5) can pick it up.

**Step 4: Same pattern for SDK handler**

Apply the same changes to `apps/runtime/src/websocket/sdk-handler.ts`:

- Add `traceId` to its client state
- Generate at session start
- Wrap `executeMessage` calls in `runWithObservabilityContext`

**Step 5: Build and test**

Run: `pnpm build --filter=runtime && pnpm --filter=runtime test -- --run`
Expected: All tests pass.

**Step 6: Commit**

```bash
npx prettier --write apps/runtime/src/websocket/handler.ts apps/runtime/src/websocket/sdk-handler.ts
git add apps/runtime/src/websocket/handler.ts apps/runtime/src/websocket/sdk-handler.ts
git commit -m "feat(runtime): generate and propagate traceId in WebSocket handlers"
```

---

## Task 11: Emit `channel_response_sent` Exit Events

Add the exit trace event to all channel handlers that currently lack one. This event marks response exit and will serve as the STI STR flush trigger.

**Files:**

- Modify: `apps/runtime/src/routes/channel-vxml.ts` (after XML response send)
- Modify: `apps/runtime/src/routes/channel-genesys.ts` (after JSON response send)
- Modify: `apps/runtime/src/routes/channel-audiocodes.ts` (after WS push)
- Modify: `apps/runtime/src/websocket/sdk-handler.ts` (after response_end equivalent)
- Modify: `apps/runtime/src/routes/chat.ts` (after SSE stream close)

**Step 1: Create a helper for emitting channel_response_sent**

In `apps/runtime/src/services/trace-emitter.ts` or a new small utility:

```typescript
import { getTraceStore } from './trace-store.js';
import { getCurrentTraceId } from '@abl/compiler/platform';

export function emitChannelResponseSent(
  sessionId: string,
  channel: string,
  durationMs: number,
  opts?: { responseSize?: number; statusCode?: number },
): void {
  const traceStore = getTraceStore();
  traceStore.addEvent(sessionId, {
    id: crypto.randomUUID(),
    sessionId,
    traceId: getCurrentTraceId(),
    type: 'channel_response_sent',
    timestamp: new Date(),
    data: {
      channel,
      durationMs,
      responseSize: opts?.responseSize,
      statusCode: opts?.statusCode,
    },
  });
}
```

**Step 2: Add to VXML handler**

In `apps/runtime/src/routes/channel-vxml.ts`, after the `res.type('text/xml').send(vxml)` at line 184:

```typescript
emitChannelResponseSent(session.runtimeSessionId, 'vxml', Date.now() - startTime, {
  statusCode: 200,
});
return res.type('text/xml').send(vxml);
```

Capture `startTime = Date.now()` at the beginning of the handler.

**Step 3: Add to Genesys handler**

Same pattern in `apps/runtime/src/routes/channel-genesys.ts` after `res.json(genesysResponse)` at line 154.

**Step 4: Add to other channel handlers**

Apply the same pattern to:

- `channel-audiocodes.ts` — after the WS activity push
- `chat.ts` — in the SSE stream `close` handler
- `sdk-handler.ts` — after response is sent to SDK client

**Step 5: Build and test**

Run: `pnpm build --filter=runtime && pnpm --filter=runtime test -- --run`
Expected: All tests pass.

**Step 6: Commit**

```bash
npx prettier --write apps/runtime/src/routes/channel-vxml.ts apps/runtime/src/routes/channel-genesys.ts apps/runtime/src/routes/channel-audiocodes.ts apps/runtime/src/routes/chat.ts apps/runtime/src/websocket/sdk-handler.ts
git add <all modified files>
git commit -m "feat(runtime): emit channel_response_sent exit events on all channels"
```

---

## Task 12: WS Session Messages Include traceId (P1 — Customer Value)

Add `traceId` to `session_start` and `agent_loaded` WS messages so SDK consumers can correlate.

**Files:**

- Modify: `apps/runtime/src/websocket/sdk-handler.ts:357-363` (session_start)
- Modify: `apps/runtime/src/websocket/events.ts:164-165` (agentLoaded factory)

**Step 1: Add traceId to session_start message**

In `apps/runtime/src/websocket/sdk-handler.ts`, around line 357:

```typescript
send(ws, {
  type: 'session_start',
  sessionId: tokenState.sessionId,
  traceId: state.traceId, // ADD
  projectId: tokenState.projectId,
  permissions: tokenState.permissions,
});
```

**Step 2: Add traceId to agent_loaded message**

In `apps/runtime/src/websocket/events.ts`, modify the `agentLoaded` factory at line 164:

```typescript
agentLoaded(sessionId: string, agent: AgentDetails, traceId?: string): ServerMessage {
  return { type: 'agent_loaded', sessionId, traceId, agent };
},
```

Update all call sites of `ServerMessages.agentLoaded()` to pass `state.traceId`.

**Step 3: Build and test**

Run: `pnpm build --filter=runtime && pnpm --filter=runtime test -- --run`
Expected: All tests pass.

**Step 4: Commit**

```bash
npx prettier --write apps/runtime/src/websocket/sdk-handler.ts apps/runtime/src/websocket/events.ts apps/runtime/src/websocket/handler.ts
git add apps/runtime/src/websocket/sdk-handler.ts apps/runtime/src/websocket/events.ts apps/runtime/src/websocket/handler.ts
git commit -m "feat(runtime): include traceId in WS session_start and agent_loaded messages"
```

---

## Task 13: API Response Envelope traceId (P1 — Customer Value)

Add `traceId` to the standard `{ success, data/error }` response envelope.

**Files:**

- Create: `apps/runtime/src/middleware/trace-response.ts` (response helper)
- Modify: Key routes that return error responses

**Step 1: Create response helper**

```typescript
// apps/runtime/src/middleware/trace-response.ts
import { Response } from 'express';
import { getCurrentTraceId } from '@abl/compiler/platform';

/**
 * Send a JSON response with traceId injected into the envelope.
 * Falls back gracefully if no trace context is active.
 */
export function sendWithTrace(
  res: Response,
  statusCode: number,
  body: Record<string, unknown>,
): void {
  const traceId = getCurrentTraceId();
  if (traceId) {
    body.traceId = traceId;
  }
  res.status(statusCode).json(body);
}
```

**Step 2: Apply to error responses first (highest support value)**

The most valuable place is error responses — when things go wrong, support needs the trace ID. Apply `sendWithTrace` to the global error handler and key route error paths. Start with the global error handler in `apps/runtime/src/server.ts`.

**Step 3: Build and test**

Run: `pnpm build --filter=runtime && pnpm --filter=runtime test -- --run`
Expected: All tests pass.

**Step 4: Commit**

```bash
npx prettier --write apps/runtime/src/middleware/trace-response.ts apps/runtime/src/server.ts
git add apps/runtime/src/middleware/trace-response.ts apps/runtime/src/server.ts
git commit -m "feat(runtime): add traceId to API response envelopes for support correlation"
```

---

## Task 14: Studio Proxy Forwards X-Trace-Id (P1 — Customer Value)

**Files:**

- Modify: `apps/studio/src/proxy.ts:182-185`

**Step 1: Forward X-Trace-Id from upstream**

In `apps/studio/src/proxy.ts`, the `addSecurityHeaders` function generates a fresh `x-request-id`. It should also forward `X-Trace-Id` if present from the upstream response. However, since Studio uses `NextResponse.rewrite()`, the upstream headers are automatically forwarded. The main change is ensuring `X-Trace-Id` is also set on non-proxied responses (e.g., Studio-rendered pages):

```typescript
function addSecurityHeaders(response: NextResponse): void {
  const requestId = crypto.randomUUID();
  response.headers.set('x-request-id', requestId);
  // Note: X-Trace-Id is set by the runtime/backend; for direct Studio responses
  // there is no trace context to propagate.
}
```

If the proxy strips response headers from upstream, add explicit forwarding. Check the actual proxy behavior first.

**Step 2: Build**

Run: `pnpm build --filter=studio`
Expected: Clean build.

**Step 3: Commit**

```bash
npx prettier --write apps/studio/src/proxy.ts
git add apps/studio/src/proxy.ts
git commit -m "feat(studio): forward X-Trace-Id header from upstream API responses"
```

---

## Task 15: Remove Kafka Trace Header Feature Flag (P3 — Cleanup)

**Files:**

- Modify: `apps/runtime/src/services/event-bus/kafka-subscriber.ts`

**Step 1: Remove the feature flag check**

In `apps/runtime/src/services/event-bus/kafka-subscriber.ts`:

1. Remove the constructor flag (line 111): `this.traceHeadersEnabled = process.env.OBS_EVENTBUS_TRACE_HEADERS === 'true';`
2. Remove the `traceHeadersEnabled` field from the class.
3. Remove the `if (this.traceHeadersEnabled)` guards at lines 121-126 and 263-272, keeping the inner code.

The trace header injection code should always run.

**Step 2: Build and test**

Run: `pnpm build --filter=runtime && pnpm --filter=runtime test -- --run`
Expected: All tests pass.

**Step 3: Commit**

```bash
npx prettier --write apps/runtime/src/services/event-bus/kafka-subscriber.ts
git add apps/runtime/src/services/event-bus/kafka-subscriber.ts
git commit -m "feat(runtime): make Kafka trace header injection always-on (remove feature flag)"
```

---

## Task 16: Verification — End-to-End Trace ID Flow

Final validation that the unified trace ID flows through the entire system.

**Step 1: Build everything**

Run: `pnpm build`
Expected: Clean build across all packages.

**Step 2: Run all tests**

Run: `pnpm test`
Expected: All existing tests pass, no regressions.

**Step 3: Manual verification checklist**

If a local environment is available:

1. **HTTP**: `curl -v http://localhost:3112/health` → verify `X-Trace-Id` header in response (32 hex chars)
2. **Traceparent honor**: `curl -v -H "traceparent: 00-abcdef1234567890abcdef1234567890-1234567890abcdef-01" http://localhost:3112/health` → verify `X-Trace-Id: abcdef1234567890abcdef1234567890`
3. **WS**: Connect to `ws://localhost:3112/ws`, load an agent → verify `traceId` in `agent_loaded` message
4. **ClickHouse**: After running a session, query `SELECT trace_id FROM platform_events WHERE timestamp > now() - INTERVAL 5 MINUTE LIMIT 10` → verify non-empty trace_id values

**Step 4: Final commit (if any fixups needed)**

```bash
git add <any fixup files>
git commit -m "fix: trace readiness verification fixups"
```

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

- **Group A** (independent, can run first): Tasks 1, 4, 6
- **Group B** (depends on middleware mount): Tasks 2, 3, then 5, 7, 8, 9, 10 in order
- **Group C** (depends on Group B): Tasks 11, 12, 13, 14, 15
- **Group D** (final): Task 16

**Estimated total: ~25 files touched, 16 tasks, ~4-6 hours of focused implementation.**
