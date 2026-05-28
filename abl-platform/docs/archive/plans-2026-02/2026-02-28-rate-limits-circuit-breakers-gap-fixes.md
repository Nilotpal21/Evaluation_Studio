# Rate Limits & Circuit Breakers — Gap Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close all 15 remaining HIGH/MEDIUM/LOW gaps from the 2026-02-25 audit, PLUS address cross-cutting concerns discovered during plan review: config externalization, structured logging migration, OTEL metrics activation, scaling/memory safety, and trace event coverage.

**Architecture:** Organized into 5 phases: (1) HIGH reliability gaps, (2) MEDIUM observability gaps, (3) LOW hardening, (4) cross-cutting config/logging/metrics, (5) scaling & memory safety. Each task is independently testable. All new constants externalized via env vars with sensible defaults.

**Tech Stack:** Vitest, undici (bundled), OTEL metrics API (`@opentelemetry/api`), Redis Lua scripts, Vercel AI SDK `abortSignal`, ClickHouse client `query()`, Mongoose pool events, `createLogger` from `@abl/compiler/platform`.

---

## Phase 1 — HIGH Priority (Reliability / Resilience)

### Task 1: LLM Call-Level Timeout (Gap 10)

**Files:**

- Modify: `apps/runtime/src/services/llm/session-llm-client.ts`
- Modify: `apps/runtime/src/config/index.ts`
- Create: `apps/runtime/src/__tests__/session-llm-client-timeout.test.ts`

**Context:** `generateText()` and `streamText()` from Vercel AI SDK accept an `abortSignal` option. Currently no timeout wraps these calls — a hung LLM provider blocks the session indefinitely. The job-level timeout (60s) is a coarse safety net but doesn't surface a clean error.

**Step 1: Add config constant**

In `apps/runtime/src/config/index.ts`, add to the config object (near the existing `llmQueue` section):

```typescript
llmCallTimeoutMs: parseInt(process.env.LLM_CALL_TIMEOUT_MS || '120000', 10),
```

**Step 2: Write the failing test**

Create `apps/runtime/src/__tests__/session-llm-client-timeout.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGenerateText = vi.fn();
const mockStreamText = vi.fn();

vi.mock('ai', () => ({
  generateText: (...args: any[]) => mockGenerateText(...args),
  streamText: (...args: any[]) => mockStreamText(...args),
}));

describe('SessionLLMClient timeout', () => {
  beforeEach(() => {
    mockGenerateText.mockReset();
    mockStreamText.mockReset();
  });

  it('generateText receives an abortSignal', async () => {
    mockGenerateText.mockResolvedValue({
      text: 'response',
      toolCalls: [],
      usage: { promptTokens: 10, completionTokens: 5 },
    });

    const { SessionLLMClient } = await import('../services/llm/session-llm-client.js');
    // ... construct client, call chatWithToolUse
    const callArgs = mockGenerateText.mock.calls[0][0];
    expect(callArgs).toHaveProperty('abortSignal');
    expect(callArgs.abortSignal).toBeInstanceOf(AbortSignal);
  });
});
```

**Step 3: Run test to verify it fails**

Run: `npx vitest run apps/runtime/src/__tests__/session-llm-client-timeout.test.ts`
Expected: FAIL — `abortSignal` not present in call args.

**Step 4: Implement the fix**

In `session-llm-client.ts`, at every `generateText()` call site (~lines 226, 385) and `streamText()` call site (~lines 284, 427):

```typescript
const abortController = new AbortController();
const timeoutMs = config.llmCallTimeoutMs ?? 120_000;
const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);
try {
  const result = await generateText({
    model,
    system: systemPrompt,
    messages: convertMessages(messages) as any,
    tools: convertTools(tools),
    maxRetries: 2,
    temperature: config.temperature,
    abortSignal: abortController.signal, // ← ADD THIS
  });
  // ... existing post-processing
} finally {
  clearTimeout(timeoutHandle);
}
```

Apply the same pattern to all `streamText()` calls.

**Step 5: Run test to verify it passes**

Run: `npx vitest run apps/runtime/src/__tests__/session-llm-client-timeout.test.ts`
Expected: PASS

**Step 6: Run full runtime tests**

Run: `pnpm --filter runtime test`
Expected: All tests pass.

**Step 7: Commit**

```bash
git add apps/runtime/src/services/llm/session-llm-client.ts apps/runtime/src/config/index.ts apps/runtime/src/__tests__/session-llm-client-timeout.test.ts
git commit -m "feat(runtime): add LLM call-level timeout with AbortSignal (120s default)"
```

---

### Task 2: HTTP Keep-Alive on Tool Executor (Gap 7)

**Files:**

- Modify: `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts`
- Create: `packages/compiler/src/platform/constructs/executors/__tests__/http-tool-executor-keepalive.test.ts`

**Context:** The executor already dynamically imports `undici` and has dispatcher support (lines 544-604). Currently, each `fetch()` call opens a new TCP connection. Adding a shared `undici.Agent` with `keepAlive: true` reuses connections, saving 20-30ms per tool call.

**Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';

describe('HttpToolExecutor keep-alive', () => {
  it('creates a shared undici Agent with keepAlive enabled', async () => {
    const { HttpToolExecutor } = await import('../http-tool-executor.js');
    const agent = HttpToolExecutor.getDefaultAgent();
    expect(agent).toBeDefined();
    const agent2 = HttpToolExecutor.getDefaultAgent();
    expect(agent).toBe(agent2);
  });
});
```

**Step 2: Implement the fix**

In `http-tool-executor.ts`, add a static default agent with keep-alive:

```typescript
private static _defaultAgent: any = null;

static getDefaultAgent(): any {
  return HttpToolExecutor._defaultAgent;
}

private static async ensureDefaultAgent(): Promise<any> {
  if (HttpToolExecutor._defaultAgent) return HttpToolExecutor._defaultAgent;
  const undici = await HttpToolExecutor.importUndici();
  if (undici) {
    HttpToolExecutor._defaultAgent = new undici.Agent({
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
      connections: parseInt(process.env.HTTP_TOOL_POOL_SIZE || '50', 10),
    });
  }
  return HttpToolExecutor._defaultAgent;
}
```

Then in `execute()`, before the fetch call (~line 625), when no proxy dispatcher is set:

```typescript
if (!dispatcher) {
  dispatcher = await HttpToolExecutor.ensureDefaultAgent();
}
```

**Step 3: Run tests and commit**

```bash
git commit -m "feat(compiler): add HTTP keep-alive via shared undici Agent on tool executor"
```

---

### Task 3: Circuit Breaker on SearchAI & Multimodal Service Calls (Gap 6)

**Files:**

- Create: `apps/runtime/src/services/search-ai/search-ai-circuit-breaker.ts`
- Modify: `apps/runtime/src/services/search-ai/search-ai-tool-executor.ts`
- Create: `apps/runtime/src/attachments/multimodal-circuit-breaker.ts`
- Modify: `apps/runtime/src/attachments/multimodal-service-client.ts`
- Create: `apps/runtime/src/__tests__/search-ai-circuit-breaker.test.ts`
- Create: `apps/runtime/src/__tests__/multimodal-circuit-breaker.test.ts`

**Context:** Follow the existing KMS circuit breaker pattern (`kms-circuit-breaker.ts:35-79`). Pattern: get registry → get breaker → check if open → execute → record success/failure.

**Step 1: Write the failing test for SearchAI CB**

```typescript
import { describe, it, expect, vi } from 'vitest';

vi.mock('../resilience/hybrid-cb-registry.js', () => ({
  getCircuitBreakerRegistry: () => ({
    getBreaker: () => ({
      isOpen: () => false,
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    }),
  }),
}));

describe('SearchAICircuitBreaker', () => {
  it('executes the operation when circuit is closed', async () => {
    const { SearchAICircuitBreaker } = await import('../search-ai/search-ai-circuit-breaker.js');
    const cb = new SearchAICircuitBreaker('tenant-1');
    const result = await cb.execute('search', async () => ({ data: 'ok' }));
    expect(result).toEqual({ data: 'ok' });
  });

  it('throws immediately when circuit is open', async () => {
    // Override mock to return isOpen: true, test fail-fast
  });

  it('records failure and re-throws on operation error', async () => {
    // Test that recordFailure is called
  });
});
```

**Step 2: Implement SearchAI circuit breaker**

Create `apps/runtime/src/services/search-ai/search-ai-circuit-breaker.ts`:

```typescript
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('search-ai-circuit-breaker');

export class SearchAICircuitBreaker {
  private readonly breakerName: string;
  private readonly tenantId: string;

  constructor(tenantId: string) {
    this.tenantId = tenantId;
    this.breakerName = `search-ai:${tenantId}`;
  }

  async execute<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    const { getCircuitBreakerRegistry } = await import('../resilience/hybrid-cb-registry.js');
    const registry = getCircuitBreakerRegistry();
    const breaker = registry.getBreaker(this.breakerName, this.tenantId);

    if (breaker.isOpen()) {
      throw new Error(`Search-AI circuit breaker is open for ${this.breakerName}`);
    }

    try {
      const result = await fn();
      breaker.recordSuccess();
      return result;
    } catch (err) {
      breaker.recordFailure(err instanceof Error ? err : new Error(String(err)));
      log.warn('Search-AI call failed, circuit breaker updated', {
        operation,
        tenantId: this.tenantId,
      });
      throw err;
    }
  }
}
```

**Step 3: Wire into SearchAIAwareToolExecutor**

In `search-ai-tool-executor.ts`, wrap the `searchHandler.execute()` call with the circuit breaker.

**Step 4: Repeat for Multimodal**

Create `multimodal-circuit-breaker.ts` with the same pattern, breaker key `multimodal:${tenantId}`. Wire into `MultimodalServiceClient` fetch calls.

**Step 5: Run tests and commit**

```bash
git commit -m "feat(runtime): add circuit breakers for SearchAI and Multimodal service calls"
```

---

### Task 4: Active ClickHouse Health Probe (Gap 9)

**Files:**

- Create: `apps/runtime/src/health/clickhouse-probe.ts`
- Modify: `apps/runtime/src/server.ts`
- Create: `apps/runtime/src/__tests__/clickhouse-health-probe.test.ts`

**Context:** Currently `clickhouseReady` is a static boolean set once at startup. The `/health` endpoint reports this flag without actively pinging ClickHouse. A stale flag hides outages.

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest';

describe('ClickHouse health probe', () => {
  it('pings ClickHouse and reports actual status', async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: 1 });
    const mockClient = { query: mockQuery };
    const { probeClickHouse } = await import('../health/clickhouse-probe.js');
    const result = await probeClickHouse(mockClient as any);
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(mockQuery).toHaveBeenCalledWith({ query: 'SELECT 1' });
  });

  it('returns not-ok when ClickHouse query fails', async () => {
    const mockClient = { query: vi.fn().mockRejectedValue(new Error('Connection refused')) };
    const { probeClickHouse } = await import('../health/clickhouse-probe.js');
    const result = await probeClickHouse(mockClient as any);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Connection refused');
  });
});
```

**Step 2: Implement the probe**

Create `apps/runtime/src/health/clickhouse-probe.ts`:

```typescript
export interface ClickHouseProbeResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export async function probeClickHouse(client: any): Promise<ClickHouseProbeResult> {
  const start = performance.now();
  try {
    await client.query({ query: 'SELECT 1' });
    return { ok: true, latencyMs: Math.round(performance.now() - start) };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - start),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
```

**Step 3: Wire into health endpoint**

In `server.ts`, replace the static `clickhouseReady` flag in the `/health` handler with an active probe call.

**Step 4: Run tests and commit**

```bash
git commit -m "feat(runtime): add active ClickHouse health probe replacing static flag"
```

---

### Task 5: Per-LLM-Provider Concurrency Cap (Gap 8)

**Files:**

- Create: `apps/runtime/src/services/llm/provider-semaphore.ts`
- Modify: `apps/runtime/src/services/llm/llm-queue.ts`
- Modify: `apps/runtime/src/config/index.ts`
- Create: `apps/runtime/src/__tests__/provider-semaphore.test.ts`

**Context:** Currently all LLM calls share a single global semaphore (10 permits). If one provider has an outage, it can exhaust all permits. A per-provider semaphore divides permits proportionally.

**Step 1: Add config constant**

In `config/index.ts`:

```typescript
llmExpectedProviders: parseInt(process.env.LLM_EXPECTED_PROVIDERS || '3', 10),
```

**Step 2: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';

describe('ProviderSemaphoreMap', () => {
  it('creates separate semaphores per provider', async () => {
    const { ProviderSemaphoreMap } = await import('../services/llm/provider-semaphore.js');
    const map = new ProviderSemaphoreMap(10, 3);
    const anthropic = map.getSemaphore('anthropic');
    const openai = map.getSemaphore('openai');
    expect(anthropic).not.toBe(openai);
    expect(anthropic.availablePermits).toBeGreaterThanOrEqual(2);
  });

  it('returns same semaphore for same provider', async () => {
    const { ProviderSemaphoreMap } = await import('../services/llm/provider-semaphore.js');
    const map = new ProviderSemaphoreMap(10, 3);
    expect(map.getSemaphore('anthropic')).toBe(map.getSemaphore('anthropic'));
  });
});
```

**Step 3: Implement ProviderSemaphoreMap**

Create `apps/runtime/src/services/llm/provider-semaphore.ts`:

```typescript
import { Semaphore } from './local-semaphore.js';

const MIN_PERMITS_PER_PROVIDER = 2;

export class ProviderSemaphoreMap {
  private readonly semaphores = new Map<string, Semaphore>();
  private readonly permitsPerProvider: number;

  constructor(globalMaxPermits: number, expectedProviders: number) {
    this.permitsPerProvider = Math.max(
      MIN_PERMITS_PER_PROVIDER,
      Math.floor(globalMaxPermits / Math.max(1, expectedProviders)),
    );
  }

  getSemaphore(provider: string): Semaphore {
    let sem = this.semaphores.get(provider);
    if (!sem) {
      sem = new Semaphore(this.permitsPerProvider);
      this.semaphores.set(provider, sem);
    }
    return sem;
  }
}
```

**Step 4: Wire into LLM queue**

In `llm-queue.ts`, acquire per-provider semaphore before global. Release in `finally`.

**Step 5: Run tests and commit**

```bash
git commit -m "feat(runtime): add per-LLM-provider concurrency cap with ProviderSemaphoreMap"
```

---

## Phase 2 — MEDIUM Priority (Operational Visibility)

### Task 6: Tool Call Rate Limit — Plan-Based (Gap 11)

**Files:**

- Modify: `apps/runtime/src/services/tenant-config.ts`
- Modify: `apps/runtime/src/middleware/rate-limiter.ts`
- Create: `apps/runtime/src/__tests__/tool-call-rate-plan.test.ts`

**Context:** `toolCallsPerMinute` is hardcoded to 200 for all plans. Should vary by tier.

**Step 1: Implement**

In `tenant-config.ts`, add `toolCallsPerMinute` to `TenantLimits` interface and each plan:

| Plan       | toolCallsPerMinute |
| ---------- | ------------------ |
| FREE       | 50                 |
| TEAM       | 200                |
| BUSINESS   | 500                |
| ENTERPRISE | -1 (unlimited)     |

In `rate-limiter.ts`, read `toolCallsPerMinute` from resolved plan limits instead of hardcoded `DEFAULT_LIMITS.toolCallsPerMinute`.

**Step 2: Test and commit**

```bash
git commit -m "feat(runtime): make toolCallsPerMinute plan-based (FREE:50, TEAM:200, BIZ:500, ENT:unlimited)"
```

---

### Task 7: Backpressure OTEL Metrics (Gap 13)

**Files:**

- Modify: `apps/runtime/src/observability/metrics.ts`
- Modify: `apps/runtime/src/services/llm/llm-queue.ts`
- Create: `apps/runtime/src/__tests__/backpressure-metrics.test.ts`

**Step 1: Add metrics**

In `metrics.ts`:

```typescript
export const backpressureCounter = meter.createCounter('llm.queue.backpressure', {
  description: 'Count of backpressure events when LLM queue depth exceeds threshold',
});
```

In `llm-queue.ts:299`, before throwing `BackpressureError`:

```typescript
backpressureCounter.add(1, {
  'queue.depth': waitingCount,
  'queue.threshold': config.backpressureThreshold,
});
```

**Step 2: Test and commit**

```bash
git commit -m "feat(runtime): emit OTEL counter on LLM queue backpressure events"
```

---

### Task 8: Redis Fallback OTEL Alerting (Gap 15)

**Files:**

- Modify: `apps/runtime/src/services/resilience/hybrid-rate-limiter.ts`
- Modify: `apps/runtime/src/observability/metrics.ts`
- Create: `apps/runtime/src/__tests__/redis-fallback-metrics.test.ts`

**Step 1: Add metric and wire**

In `metrics.ts`:

```typescript
export const rateLimiterFallbackCounter = meter.createCounter('rate_limiter.fallback', {
  description: 'Count of rate limiter backend switches',
});
```

In `hybrid-rate-limiter.ts` at fallback point (~line 57):

```typescript
rateLimiterFallbackCounter.add(1, { direction: 'redis_to_memory' });
```

At recovery point (~line 94):

```typescript
rateLimiterFallbackCounter.add(1, { direction: 'memory_to_redis' });
```

**Step 2: Test and commit**

```bash
git commit -m "feat(runtime): emit OTEL metrics on rate limiter Redis fallback and recovery"
```

---

### Task 9: WebSocket Rate Limiting — Tenant-Based (Gap 12)

**Files:**

- Modify: `apps/runtime/src/websocket/sdk-handler.ts`
- Create: `apps/runtime/src/__tests__/ws-tenant-rate-limit.test.ts`

**Step 1: Modify WSConnectionRateLimiter.check() to accept optional tenantId**

```typescript
check(ip: string, tenantId?: string): boolean {
  const key = tenantId ? `${tenantId}:${ip}` : ip;
  // ... existing sliding window logic using `key`
}
```

Update call site to pass `tenantId` after token auth resolves.

**Step 2: Test and commit**

```bash
git commit -m "feat(runtime): scope WebSocket rate limiting by tenant+IP instead of IP-only"
```

---

### Task 10: MCP Tool Executor — Verify Resilience Factory Injection (Gap 16)

**Files:**

- Check: `packages/compiler/src/platform/constructs/executors/mcp-tool-executor.ts`
- Check: All instantiation sites

**Step 1: Find all `McpToolExecutor` construction sites and verify `resilienceFactory` is provided**

If missing at any site, wire in `createToolResilienceFactory(tenantId)`.

**Step 2: Test and commit**

```bash
git commit -m "fix(runtime): ensure MCP tool executor always receives resilience factory"
```

---

### Task 11: MongoDB Pool Monitoring (Gap 17)

**Files:**

- Modify: `packages/database/src/mongo/connection.ts`
- Modify: `apps/runtime/src/observability/metrics.ts`
- Create: `packages/database/src/__tests__/pool-monitoring.test.ts`

**Step 1: Add pool monitoring**

In `connection.ts`, after the existing APM section (~line 388):

```typescript
const topology = conn.getClient().topology;
if (topology) {
  topology.on('connectionCheckOutFailed', (event: any) => {
    log.warn('MongoDB pool checkout failed', { reason: event.reason });
    poolCheckoutFailures.add(1);
  });
}
```

In `metrics.ts`:

```typescript
export const poolCheckoutFailures = meter.createCounter('mongodb.pool.checkout_failures', {
  description: 'MongoDB connection pool checkout failure count',
});
```

**Step 2: Test and commit**

```bash
git commit -m "feat(database): add MongoDB connection pool monitoring with OTEL metrics"
```

---

## Phase 3 — LOW Priority (Hardening)

### Task 12: WebSocket Message Processing Timeout (Gap 18)

**Files:**

- Modify: `apps/runtime/src/websocket/sdk-handler.ts`
- Modify: `apps/runtime/src/config/index.ts`
- Create: `apps/runtime/src/__tests__/ws-message-timeout.test.ts`

**Step 1: Add config constant**

In `config/index.ts`:

```typescript
wsMessageTimeoutMs: parseInt(process.env.WS_MESSAGE_TIMEOUT_MS || '90000', 10),
```

**Step 2: Wrap message handler with Promise.race**

In `sdk-handler.ts`, `ws.on('message')` handler (~line 449):

```typescript
const messagePromise = runWithTenantContext(buildTenantContextData(state), () =>
  handleSDKMessage(ws, data.toString()),
);
const timeoutPromise = new Promise<never>((_, reject) =>
  setTimeout(() => reject(new Error('Message processing timeout')), config.wsMessageTimeoutMs),
);
Promise.race([messagePromise, timeoutPromise]).catch((err) => {
  log.error('WS message processing failed', { error: err.message, sessionId: state.sessionId });
  send(ws, { type: 'error', message: 'Request timed out' });
});
```

**Step 3: Test and commit**

```bash
git commit -m "feat(runtime): add configurable timeout on WebSocket message processing (90s default)"
```

---

### Task 13: Dev Login Rate Limit (Gap 19)

**Files:**

- Modify: `apps/studio/src/app/api/auth/dev-login/route.ts`

**Step 1: Add rate limiting**

At the top of the handler (before `ENABLE_DEV_LOGIN` check):

```typescript
import { checkRateLimit } from '@/lib/rate-limit';

const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
const rl = await checkRateLimit(`dev-login:${ip}`, 10, 15 * 60 * 1000);
if (!rl.allowed) {
  return NextResponse.json(
    { error: 'Too many login attempts. Please try again later.' },
    { status: 429, headers: { 'Retry-After': String(Math.ceil((rl.retryAfterMs ?? 0) / 1000)) } },
  );
}
```

**Step 2: Test and commit**

```bash
git commit -m "fix(studio): add rate limiting to dev-login endpoint (10 attempts / 15 min)"
```

---

### Task 14: Client-Side Form Debounce Helper (Gap 20)

**Files:**

- Create: `apps/studio/src/lib/debounce.ts`
- Create: `apps/studio/src/lib/__tests__/debounce.test.ts`
- Modify: Key form components (identify during implementation)

**Step 1: Implement debounceAsync utility**

```typescript
export function debounceAsync<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  delayMs: number,
  options?: { leading?: boolean },
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let hasRun = false;
  return (...args: Parameters<T>) => {
    if (options?.leading && !hasRun) {
      hasRun = true;
      fn(...args);
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      fn(...args);
      hasRun = false;
    }, delayMs);
  };
}
```

**Step 2: Wire into key form submission handlers (agent creation, deployment triggers, workspace settings)**

**Step 3: Test and commit**

```bash
git commit -m "feat(studio): add debounceAsync utility and apply to form submissions"
```

---

## Phase 4 — Cross-Cutting: Config Externalization, Structured Logging, OTEL Activation

### Task 15: Externalize All Hardcoded Resilience Constants

**Files:**

- Modify: `apps/runtime/src/middleware/rate-limiter.ts`
- Modify: `apps/runtime/src/services/resilience/hybrid-rate-limiter.ts`
- Modify: `apps/runtime/src/services/resilience/hybrid-cb-registry.ts`
- Modify: `apps/runtime/src/services/llm/llm-queue.ts`
- Modify: `apps/runtime/src/websocket/sdk-handler.ts`
- Modify: `apps/runtime/src/config/index.ts`
- Modify: `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts`
- Modify: `apps/search-ai/src/middleware/rate-limit.ts`
- Modify: `apps/multimodal-service/src/security/upload-rate-limiter.ts`
- Create: `apps/runtime/src/__tests__/config-externalization.test.ts`

**Context:** 18+ hardcoded constants have no env var override path. The LLM queue config pattern (reads from config loader with defaults) is the standard to follow.

**Step 1: Add env var overrides for each constant**

Add to `config/index.ts` (all with sensible defaults matching current hardcoded values):

```typescript
rateLimiter: {
  maxEntries: parseInt(process.env.RATE_LIMITER_MAX_ENTRIES || '50000', 10),
  maxSessionEntries: parseInt(process.env.RATE_LIMITER_MAX_SESSION_ENTRIES || '10000', 10),
  sessionCountTtlSeconds: parseInt(process.env.SESSION_COUNT_TTL_SECONDS || '86400', 10),
  cleanupIntervalMs: parseInt(process.env.RATE_LIMITER_CLEANUP_INTERVAL_MS || '300000', 10),
  cleanupGraceMs: parseInt(process.env.RATE_LIMITER_CLEANUP_GRACE_MS || '120000', 10),
  sessionMessageLimit: parseInt(process.env.SESSION_MESSAGE_RATE_LIMIT || '30', 10),
  apiKeyLimitDivisor: parseInt(process.env.API_KEY_LIMIT_DIVISOR || '5', 10),
  apiKeyMinLimit: parseInt(process.env.API_KEY_MIN_LIMIT || '10', 10),
  recoveryIntervalMs: parseInt(process.env.REDIS_RECOVERY_INTERVAL_MS || '30000', 10),
},
websocket: {
  maxConnectionsPerIpPerMinute: parseInt(process.env.WS_MAX_CONNECTIONS_PER_IP || '30', 10),
  maxSdkClients: parseInt(process.env.WS_MAX_SDK_CLIENTS || '50000', 10),
  rateLimiterCleanupIntervalMs: parseInt(process.env.WS_RATE_LIMITER_CLEANUP_MS || '120000', 10),
},
httpTool: {
  maxResponseBytes: parseInt(process.env.HTTP_TOOL_MAX_RESPONSE_BYTES || String(10 * 1024 * 1024), 10),
  maxRetryCap: parseInt(process.env.HTTP_TOOL_MAX_RETRY_CAP || '10', 10),
  maxResilienceMapEntries: parseInt(process.env.HTTP_TOOL_MAX_RESILIENCE_ENTRIES || '2000', 10),
  maxRedirectHops: parseInt(process.env.HTTP_TOOL_MAX_REDIRECT_HOPS || '5', 10),
  defaultTimeoutMs: parseInt(process.env.HTTP_TOOL_DEFAULT_TIMEOUT_MS || '30000', 10),
},
```

**Step 2: Replace hardcoded constants in each file with config reads**

Replace `MAX_RATE_LIMITER_ENTRIES = 50_000` with `config.rateLimiter.maxEntries`, etc.

**Step 3: Write test verifying env var overrides work**

```typescript
describe('Config externalization', () => {
  it('rate limiter max entries reads from env var', () => {
    process.env.RATE_LIMITER_MAX_ENTRIES = '1000';
    // Re-import config, verify value is 1000
    delete process.env.RATE_LIMITER_MAX_ENTRIES;
  });
});
```

**Step 4: Also externalize Search-AI and Multimodal constants**

For `search-ai/rate-limit.ts`:

```typescript
const DEFAULT_LIMIT = parseInt(process.env.SEARCH_AI_RATE_LIMIT || '120', 10);
const DEFAULT_WINDOW_MS = parseInt(process.env.SEARCH_AI_RATE_WINDOW_MS || '60000', 10);
```

For `upload-rate-limiter.ts`:

```typescript
const DEFAULT_MAX_UPLOADS = parseInt(process.env.UPLOAD_RATE_LIMIT_MAX || '50', 10);
const DEFAULT_WINDOW_SECONDS = parseInt(process.env.UPLOAD_RATE_WINDOW_SECONDS || '60', 10);
```

**Step 5: Commit**

```bash
git commit -m "feat: externalize all hardcoded resilience constants via env vars with defaults"
```

---

### Task 16: Migrate All Resilience Code to Structured Logging

**Files (8 files, 23 console.\* calls to replace):**

- Modify: `apps/runtime/src/middleware/rate-limiter.ts` (4 calls)
- Modify: `apps/runtime/src/services/resilience/hybrid-rate-limiter.ts` (4 calls)
- Modify: `apps/runtime/src/services/resilience/hybrid-cb-registry.ts` (3 calls)
- Modify: `apps/runtime/src/services/resilience/redis-cb-store-adapter.ts` (2 calls)
- Modify: `apps/runtime/src/services/llm/llm-queue.ts` (7 calls)
- Modify: `apps/search-ai/src/middleware/rate-limit.ts` (1 call)
- Modify: `apps/studio/src/lib/rate-limit.ts` (1 call)
- Modify: `apps/multimodal-service/src/security/upload-rate-limiter.ts` (1 call)
- Create: `apps/runtime/src/__tests__/structured-logging-resilience.test.ts`

**Context:** All 23 `console.warn/log/error` calls must be replaced with `createLogger()` from `@abl/compiler/platform`. This is required by CLAUDE.md (no unstructured logging in production code).

**Step 1: Add logger to each file**

At the top of each file:

```typescript
import { createLogger } from '@abl/compiler/platform';
const log = createLogger('<module-name>');
```

**Step 2: Replace all console calls**

Pattern for each replacement:

```typescript
// BEFORE:
console.warn('[RateLimiter] Redis error, falling back to in-memory:', err);

// AFTER:
log.warn('Redis error, falling back to in-memory', {
  error: err instanceof Error ? err.message : String(err),
});
```

```typescript
// BEFORE:
console.log('[LLMQueue] BullMQ initialized (concurrency: ${config.concurrency})');

// AFTER:
log.info('BullMQ initialized', { concurrency: config.concurrency });
```

```typescript
// BEFORE:
console.error('[RedisCBStore] Failed to get state:', error);

// AFTER:
log.error('Failed to get circuit breaker state', {
  error: error instanceof Error ? error.message : String(error),
});
```

**Full replacement list:**

| File                        | Line | Before                                                           | After                                                                       |
| --------------------------- | ---- | ---------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `rate-limiter.ts`           | 81   | `console.warn('[rate-limiter] Failed to load tenant config...')` | `log.warn('Failed to load tenant config', { tenantId, error })`             |
| `rate-limiter.ts`           | 461  | `console.warn('[rate-limiter] Redis INCR failed...')`            | `log.warn('Redis INCR failed for session count', { error })`                |
| `rate-limiter.ts`           | 487  | `console.warn('[rate-limiter] Redis DECR failed...')`            | `log.warn('Redis DECR failed for session count', { error })`                |
| `rate-limiter.ts`           | 503  | `console.warn('[rate-limiter] Redis GET failed...')`             | `log.warn('Redis GET failed for session count', { error })`                 |
| `hybrid-rate-limiter.ts`    | 34   | `console.log('[RateLimiter] Using Redis-backed...')`             | `log.info('Using Redis-backed distributed rate limiter')`                   |
| `hybrid-rate-limiter.ts`    | 36   | `console.log('[RateLimiter] Using in-memory...')`                | `log.info('Using in-memory rate limiter')`                                  |
| `hybrid-rate-limiter.ts`    | 56   | `console.warn('[RateLimiter] Redis error...')`                   | `log.warn('Redis error, falling back to in-memory', { error })`             |
| `hybrid-rate-limiter.ts`    | 94   | `console.log('[RateLimiter] Redis recovered...')`                | `log.info('Redis recovered, switching to Redis limiter')`                   |
| `hybrid-cb-registry.ts`     | 38   | `console.log('[CB Registry] Using Redis-backed...')`             | `log.info('Using Redis-backed circuit breaker store')`                      |
| `hybrid-cb-registry.ts`     | 41   | `console.log('[CB Registry] Using in-memory...')`                | `log.info('Using in-memory circuit breaker store')`                         |
| `hybrid-cb-registry.ts`     | 93   | `console.log('[CB Registry] Redis recovered...')`                | `log.info('Redis recovered, switching to Redis store')`                     |
| `redis-cb-store-adapter.ts` | 36   | `console.error('[RedisCBStore] Failed to get state...')`         | `log.error('Failed to get circuit breaker state', { error })`               |
| `redis-cb-store-adapter.ts` | 54   | `console.error('[RedisCBStore] Failed to set state...')`         | `log.error('Failed to set circuit breaker state', { error })`               |
| `llm-queue.ts`              | 155  | `console.log('[LLMQueue] Redis not available...')`               | `log.info('Redis not available, using local SessionQueue fallback')`        |
| `llm-queue.ts`              | 181  | `console.warn('[LLMQueue] No callbacks found...')`               | `log.warn('No callbacks found for job, likely timed out', { jobId })`       |
| `llm-queue.ts`              | 236  | `console.error('[LLMQueue] Worker error...')`                    | `log.error('BullMQ worker error', { error })`                               |
| `llm-queue.ts`              | 240  | `console.log('[LLMQueue] BullMQ initialized...')`                | `log.info('BullMQ initialized', { concurrency })`                           |
| `llm-queue.ts`              | 243  | `console.warn('[LLMQueue] BullMQ init failed...')`               | `log.warn('BullMQ init failed, using local fallback', { error })`           |
| `llm-queue.ts`              | 362  | `console.log('[LLMQueue] Shutting down...')`                     | `log.info('LLM queue shutting down')`                                       |
| `llm-queue.ts`              | 399  | `console.log('[LLMQueue] Shutdown complete')`                    | `log.info('LLM queue shutdown complete')`                                   |
| `search-ai/rate-limit.ts`   | 135  | `console.warn('[SearchAI] Redis error...')`                      | `log.warn('Redis error, falling back to in-memory', { error })`             |
| `studio/rate-limit.ts`      | 135  | `console.warn('[RateLimit] Redis error...')`                     | `log.warn('Redis error, falling back to in-memory', { error })`             |
| `upload-rate-limiter.ts`    | 116  | `console.warn('[UploadRateLimiter] Infrastructure error...')`    | `log.warn('Infrastructure error, allowing request (fail-open)', { error })` |

**Step 3: Write test verifying no console.\* remains**

```typescript
it('no console.warn/log/error in resilience code', () => {
  // Grep resilience files for console.warn, console.log, console.error
  // Assert zero matches
});
```

**Step 4: Commit**

```bash
git commit -m "fix: migrate all 23 console.* calls in resilience code to structured logging"
```

---

### Task 17: Activate Defined-But-Unused OTEL Metrics + Add Missing Counters

**Files:**

- Modify: `apps/runtime/src/observability/metrics.ts`
- Modify: `apps/runtime/src/middleware/rate-limiter.ts`
- Modify: `apps/runtime/src/services/runtime-executor.ts`
- Modify: `apps/runtime/src/websocket/sdk-handler.ts`
- Create: `apps/runtime/src/__tests__/metrics-activation.test.ts`

**Context:** Several OTEL metrics are defined in `metrics.ts` but NEVER called in production code (only tested in `wiring.test.ts`). Additionally, critical events have no metrics at all.

**Step 1: Activate existing unused metrics**

These functions exist in `metrics.ts` but are never called in production:

- `recordHttpRequest()` — Wire into Express middleware
- `incrementActiveRequests()` / `decrementActiveRequests()` — Wire into request lifecycle
- `recordLlmCall()` — Wire into `session-llm-client.ts` after LLM calls
- `recordToolCall()` — Wire into tool executors after tool completion

**Step 2: Add missing critical metrics**

In `metrics.ts`:

```typescript
export const rateLimitRejections = meter.createCounter('rate_limit.rejections', {
  description: 'Number of rate limit rejections (429)',
});

export const activeSessionsGauge = meter.createUpDownCounter('sessions.active', {
  description: 'Current active session count per tenant',
});

export const circuitBreakerTransitions = meter.createCounter('circuit_breaker.transitions', {
  description: 'Circuit breaker state transition count',
});

export const wsRateLimitRejections = meter.createCounter('ws.rate_limit.rejections', {
  description: 'WebSocket connection rate limit rejections',
});
```

**Step 3: Wire new metrics into call sites**

In `rate-limiter.ts`, when returning 429:

```typescript
rateLimitRejections.add(1, { tenant_id: tenantKey, operation });
```

In `sdk-handler.ts`, when WS rate limit blocks connection:

```typescript
wsRateLimitRejections.add(1, { ip: clientIp });
```

In session increment/decrement:

```typescript
activeSessionsGauge.add(1, { tenant_id: tenantId }); // on increment
activeSessionsGauge.add(-1, { tenant_id: tenantId }); // on decrement
```

In `hybrid-cb-registry.ts`, on state transitions:

```typescript
circuitBreakerTransitions.add(1, { breaker: name, from: oldState, to: newState });
```

**Step 4: Commit**

```bash
git commit -m "feat(runtime): activate unused OTEL metrics and add rate limit / session / CB counters"
```

---

### Task 18: Add Trace Events for Rate Limiting and Backpressure Decisions

**Files:**

- Modify: `apps/runtime/src/middleware/rate-limiter.ts`
- Modify: `apps/runtime/src/services/llm/llm-queue.ts`

**Context:** Per CLAUDE.md Principle 4 (Full Traceability): "If it happened, there must be a trace event." Rate limit rejections, backpressure events, and session lock contention emit no `TraceEvent` — only logs. These need trace events for audit trails.

**Step 1: Emit TraceEvent on rate limit rejection**

In `rate-limiter.ts`, when returning 429, if session context is available:

```typescript
if (req.sessionId) {
  traceStore.addEvent({
    sessionId: req.sessionId,
    type: 'rate_limit_rejection',
    data: { operation, tenantId: tenantKey, limit, remaining: 0 },
  });
}
```

**Step 2: Emit TraceEvent on backpressure**

In `llm-queue.ts`, before throwing `BackpressureError`:

```typescript
traceStore.addEvent({
  sessionId: data.sessionId,
  type: 'queue_backpressure',
  data: { queueDepth: waitingCount, threshold: config.backpressureThreshold },
});
```

**Step 3: Commit**

```bash
git commit -m "feat(runtime): add trace events for rate limit rejections and backpressure"
```

---

## Phase 5 — Scaling & Memory Safety

### Task 19: Bound LLM Queue Callback Registry (CRITICAL)

**Files:**

- Modify: `apps/runtime/src/services/llm/llm-queue.ts`
- Create: `apps/runtime/src/__tests__/llm-queue-callback-bounds.test.ts`

**Context:** `callbackRegistry` (`llm-queue.ts:60`) is an unbounded `Map<string, LLMJobCallbacks>`. It has no max size, no TTL, and on pod crash all in-flight callbacks are lost. Closures in callbacks hold references to session data, preventing GC.

**Step 1: Write the failing test**

```typescript
describe('LLM queue callback registry bounds', () => {
  it('rejects new jobs when callback registry exceeds max size', async () => {
    // Fill registry to max, attempt to enqueue, expect rejection
  });

  it('cleans up stale callbacks after TTL', async () => {
    // Register callback, advance time past TTL, verify it was cleaned up
  });
});
```

**Step 2: Implement bounds**

```typescript
const MAX_CALLBACK_REGISTRY_SIZE = parseInt(process.env.LLM_MAX_CALLBACK_REGISTRY || '5000', 10);
const CALLBACK_TTL_MS = parseInt(process.env.LLM_CALLBACK_TTL_MS || '300000', 10); // 5 min

// In enqueueLLMRequest(), before registering:
if (callbackRegistry.size >= MAX_CALLBACK_REGISTRY_SIZE) {
  // Clean stale entries first
  const now = Date.now();
  for (const [id, cb] of callbackRegistry) {
    if (now - cb.registeredAt > CALLBACK_TTL_MS) {
      callbackRegistry.delete(id);
      timeoutTimers.get(id) && clearTimeout(timeoutTimers.get(id));
      timeoutTimers.delete(id);
    }
  }
  // If still full, reject
  if (callbackRegistry.size >= MAX_CALLBACK_REGISTRY_SIZE) {
    throw new BackpressureError('Callback registry full');
  }
}
```

Add `registeredAt: number` to callback entries for TTL tracking.

**Step 3: Test and commit**

```bash
git commit -m "fix(runtime): bound LLM callback registry with max size (5K) and TTL (5min)"
```

---

### Task 20: Graceful Shutdown for Recovery Timers

**Files:**

- Modify: `apps/runtime/src/services/resilience/hybrid-rate-limiter.ts`
- Modify: `apps/runtime/src/services/resilience/hybrid-cb-registry.ts`
- Modify: `apps/runtime/src/server.ts`
- Create: `apps/runtime/src/__tests__/graceful-shutdown-timers.test.ts`

**Context:** `HybridRateLimiter` and `HybridCBRegistry` both start 30-second recovery timers that are never cleared on graceful shutdown. These timers run forever if Redis stays down, burning CPU and holding references.

**Step 1: Write the failing test**

```typescript
describe('Graceful shutdown clears recovery timers', () => {
  it('HybridRateLimiter.shutdown() clears recovery timer', () => {
    const limiter = new HybridRateLimiter(/* redis unavailable */);
    // Trigger recovery timer
    limiter.shutdown();
    // Verify timer is cleared (no more polling)
  });
});
```

**Step 2: Implement shutdown methods**

In `hybrid-rate-limiter.ts`:

```typescript
shutdown(): void {
  this.stopRecoveryTimer();
  this.memoryLimiter.destroy();
}
```

In `hybrid-cb-registry.ts`:

```typescript
shutdown(): void {
  if (this.recoveryTimer) {
    clearInterval(this.recoveryTimer);
    this.recoveryTimer = null;
  }
}
```

**Step 3: Wire into server.ts graceful shutdown**

```typescript
process.on('SIGTERM', async () => {
  // ... existing shutdown
  getHybridRateLimiter()?.shutdown();
  getCircuitBreakerRegistry()?.shutdown();
});
```

**Step 4: Commit**

```bash
git commit -m "fix(runtime): clear recovery timers on graceful shutdown (rate limiter + CB registry)"
```

---

### Task 21: Fix Redis duplicate() Connection Leak

**Files:**

- Modify: `apps/runtime/src/services/llm/llm-queue.ts`
- Create: `apps/runtime/src/__tests__/redis-connection-cleanup.test.ts`

**Context:** BullMQ Queue and Worker each call `redis.duplicate()` creating new connections. If `initBullMQ()` is called multiple times (e.g., during re-initialization), old connections leak.

**Step 1: Track duplicated connections**

```typescript
let queueConnection: Redis | null = null;
let workerConnection: Redis | null = null;

function initBullMQ(redis: Redis) {
  // Clean up previous connections
  if (queueConnection) {
    queueConnection.disconnect();
  }
  if (workerConnection) {
    workerConnection.disconnect();
  }

  queueConnection = redis.duplicate({ maxRetriesPerRequest: null });
  workerConnection = redis.duplicate({ maxRetriesPerRequest: null });

  bullQueue = new Queue('llm-jobs', { connection: queueConnection });
  bullWorker = new Worker('llm-jobs', processor, { connection: workerConnection });
}
```

**Step 2: Clean up on shutdown**

```typescript
async function shutdown() {
  // ... existing cleanup
  queueConnection?.disconnect();
  workerConnection?.disconnect();
}
```

**Step 3: Commit**

```bash
git commit -m "fix(runtime): track and clean up duplicated Redis connections in LLM queue"
```

---

## Execution Order Summary

| Task | Description                          | Priority | Phase | Complexity | Files |
| ---- | ------------------------------------ | -------- | ----- | ---------- | ----- |
| 1    | LLM call-level timeout               | HIGH     | 1     | Low        | 3     |
| 2    | HTTP keep-alive                      | HIGH     | 1     | Low        | 2     |
| 3    | SearchAI/Multimodal circuit breakers | HIGH     | 1     | Medium     | 6     |
| 4    | ClickHouse health probe              | HIGH     | 1     | Low        | 3     |
| 5    | Per-provider concurrency cap         | HIGH     | 1     | Medium     | 4     |
| 6    | Plan-based tool call limits          | MEDIUM   | 2     | Low        | 3     |
| 7    | Backpressure OTEL metrics            | MEDIUM   | 2     | Low        | 3     |
| 8    | Redis fallback OTEL alerting         | MEDIUM   | 2     | Low        | 3     |
| 9    | WS tenant-based rate limiting        | MEDIUM   | 2     | Low        | 2     |
| 10   | MCP resilience factory               | MEDIUM   | 2     | Low        | 1-2   |
| 11   | MongoDB pool monitoring              | MEDIUM   | 2     | Medium     | 3     |
| 12   | WS message timeout                   | LOW      | 3     | Low        | 3     |
| 13   | Dev login rate limit                 | LOW      | 3     | Low        | 1     |
| 14   | Form debounce utility                | LOW      | 3     | Low        | 3     |
| 15   | Config externalization               | CROSS    | 4     | Medium     | 10    |
| 16   | Structured logging migration         | CROSS    | 4     | Low        | 8     |
| 17   | OTEL metrics activation              | CROSS    | 4     | Medium     | 5     |
| 18   | Trace events for rate limits         | CROSS    | 4     | Low        | 2     |
| 19   | Bound callback registry              | CRITICAL | 5     | Medium     | 2     |
| 20   | Graceful shutdown timers             | HIGH     | 5     | Low        | 4     |
| 21   | Redis connection leak fix            | MEDIUM   | 5     | Low        | 2     |

**Total: 21 tasks, ~70 files touched**

**Recommended execution: Phase 5 (tasks 19-21) first** — the unbounded callback registry is a production risk. Then Phase 1, Phase 4, Phase 2, Phase 3.

## Audit Doc Update

After all tasks are complete, update `docs/plans/2026-02-25-rate-limits-circuit-breakers-audit.md` Section 7 (Gaps & Recommendations) to mark each gap as RESOLVED with the commit hash and date.
