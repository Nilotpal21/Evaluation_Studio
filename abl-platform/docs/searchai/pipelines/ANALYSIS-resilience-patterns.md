# Resilience Patterns Analysis

**Task:** Pre-Check #61 - Explore existing resilience patterns (circuit breaker, retry, fallback)
**Status:** Complete
**Date:** 2026-03-07

## Executive Summary

The ABL Platform has **comprehensive resilience infrastructure** spanning circuit breakers, retry logic, fallback mechanisms, rate limiting, and timeout patterns. A dedicated `@agent-platform/circuit-breaker` package provides Redis-backed distributed circuit breakers with hierarchical isolation (tenant → app → llm_provider → tool_service).

**Key Finding:** Production-ready circuit breaker implementation exists with Lua atomic state transitions, hierarchical breaker registry, and fallback support. Pipeline circuit breaker should leverage this existing infrastructure.

---

## 1. Circuit Breaker Implementations

### 1.1 Redis Circuit Breaker (Production)

**Package:** `@agent-platform/circuit-breaker`
**Location:** `packages/circuit-breaker/src/redis-circuit-breaker.ts`

#### Features

- **Redis-backed distributed state** (shared across platform instances)
- **Atomic state transitions** via Lua scripts
- **State machine:** CLOSED ↔ HALF_OPEN ↔ OPEN
- **Rolling window metrics** (sorted sets with timestamps)
- **Hierarchical levels:** tenant, app, llm_provider, tool_service
- **Event listeners** for monitoring/alerting

#### Configuration Per Level

```typescript
export const BREAKER_DEFAULTS: Record<BreakerLevel, CircuitBreakerConfig> = {
  tenant: {
    failureThreshold: 50,
    successThreshold: 5,
    resetTimeout: 30_000, // 30s
    monitorWindow: 60_000, // 1 min
    halfOpenMaxConcurrent: 3,
    failureRateThreshold: 50, // %
    minimumRequestCount: 20,
  },
  app: {
    failureThreshold: 20,
    successThreshold: 3,
    resetTimeout: 15_000, // 15s
    monitorWindow: 30_000, // 30s
    halfOpenMaxConcurrent: 2,
    failureRateThreshold: 40,
    minimumRequestCount: 10,
  },
  llm_provider: {
    failureThreshold: 10,
    successThreshold: 2,
    resetTimeout: 60_000, // 1 min (longer for external services)
    monitorWindow: 30_000,
    halfOpenMaxConcurrent: 1,
    failureRateThreshold: 30,
    minimumRequestCount: 5,
  },
  tool_service: {
    failureThreshold: 10,
    successThreshold: 2,
    resetTimeout: 30_000,
    monitorWindow: 30_000,
    halfOpenMaxConcurrent: 1,
    failureRateThreshold: 40,
    minimumRequestCount: 5,
  },
};
```

**Pattern:** Lower failure thresholds and longer reset timeouts for external dependencies (LLM providers).

#### State Machine

```
CLOSED ──(failures >= threshold)──► OPEN
  ▲                                   │
  │                              (reset timeout)
  │                                   │
  │                                   ▼
  └──(successes >= threshold)── HALF_OPEN
                                      │
                               (failure in half-open)
                                      │
                                      ▼
                                    OPEN
```

**CLOSED:** Normal operation, track failures
**OPEN:** Reject requests immediately, wait for reset timeout
**HALF_OPEN:** Allow limited probes (halfOpenMaxConcurrent), transition to CLOSED on success

#### Usage Example

```typescript
import { RedisCircuitBreaker } from '@agent-platform/circuit-breaker';
import Redis from 'ioredis';

const redis = new Redis({ host: 'localhost', port: 6379 });
const breaker = new RedisCircuitBreaker(redis, 'llm_provider', {
  failureThreshold: 10,
  resetTimeout: 60_000,
});

// Execute with protection
try {
  const result = await breaker.execute('anthropic', async () => {
    return await callClaude(messages);
  });
} catch (error) {
  if (error instanceof CircuitOpenError) {
    // Circuit open — try fallback
    console.log(`Circuit open, retry after ${error.retryAfterMs}ms`);
    return await callOpenAI(messages);
  }
  throw error;
}

// Check state without executing
const checkResult = await breaker.checkState('anthropic');
if (!checkResult.canExecute) {
  console.log(`Cannot execute, retry after ${checkResult.retryAfterMs}ms`);
}

// Get metrics
const metrics = await breaker.getMetrics('anthropic');
console.log(`Failure rate: ${metrics.failureRate}%`);
```

#### Redis Key Layout

```
breaker:{level}:{key}:state          → string: CLOSED | OPEN | HALF_OPEN
breaker:{level}:{key}:failures       → sorted set (score=timestamp)
breaker:{level}:{key}:successes      → sorted set (score=timestamp)
breaker:{level}:{key}:opened_at      → string: timestamp ms
breaker:{level}:{key}:half_open_count → string: counter
```

#### Lua Scripts (Atomic Operations)

**check-state.lua:**

- Check current state
- Auto-transition OPEN → HALF_OPEN if reset timeout elapsed
- Track half-open concurrent requests
- Return: [state, canExecute, retryAfterMs]

**record-failure.lua:**

- Increment failure count in rolling window
- Calculate failure rate
- Transition to OPEN if threshold exceeded
- Return: [state, failureCount, totalCount, failureRate]

**record-success.lua:**

- Increment success count
- Transition HALF_OPEN → CLOSED if successThreshold met
- Reset failure count on success
- Return: [state, successCount]

**force-reset.lua:**

- Manually override circuit state (ops team)
- Clear counters
- Return: [state, action]

**Pattern:** All state transitions are atomic to avoid race conditions across platform instances.

---

### 1.2 Circuit Breaker Registry (Hierarchical)

**Location:** `packages/circuit-breaker/src/registry.ts`

#### Hierarchy

```
Tenant
  ├─ App 1
  │   ├─ LLM Provider (anthropic)
  │   └─ Tool Service (hotel-search)
  ├─ App 2
  │   ├─ LLM Provider (openai)
  │   └─ Tool Service (flight-search)
  ...
```

#### Usage

```typescript
import { CircuitBreakerRegistry } from '@agent-platform/circuit-breaker';

const registry = new CircuitBreakerRegistry(redis);

// Tenant-level protection
await registry.tenant('acme-corp').execute(async () => {
  return await processRequest();
});

// LLM provider protection with fallback
try {
  await registry.llmProvider('acme-corp', 'anthropic').execute(async () => {
    return await callClaude(messages);
  });
} catch (error) {
  if (error instanceof CircuitOpenError) {
    // Anthropic circuit open — try OpenAI fallback
    return await registry.llmProvider('acme-corp', 'openai').execute(async () => {
      return await callOpenAI(messages);
    });
  }
  throw error;
}

// Tool service protection
await registry.toolService('acme-corp', 'hotel-search').execute(async () => {
  return await callHotelSearchAPI();
});

// Monitor tenant health
const health = await registry.getTenantHealth('acme-corp');
console.log(health);
```

#### Tenant Health Response

```typescript
interface TenantHealth {
  tenantId: string;
  tenant: {
    state: BreakerState;
    failureRate: number;
  };
  apps: Array<{
    key: string;
    state: BreakerState;
    failureRate: number;
  }>;
  llmProviders: Array<{
    key: string;
    state: BreakerState;
    failureRate: number;
  }>;
  toolServices: Array<{
    key: string;
    state: BreakerState;
    failureRate: number;
  }>;
  hasOpenCircuits: boolean;
  timestamp: number;
}
```

---

### 1.3 In-Memory Circuit Breaker (Simple)

**Location:** `packages/compiler/src/platform/constructs/executors/http-resilience.ts`

**Use Case:** Pod-local tool/service protection (no shared state needed)

```typescript
export class CircuitBreaker {
  private state: CircuitBreakerState = {
    failures: 0,
    lastFailure: 0,
    state: 'closed',
  };
  private probeInProgress = false;

  constructor(
    private threshold: number, // Failures before opening
    private resetMs: number, // Wait time before half-open
  ) {}

  isOpen(): boolean {
    if (this.state.state === 'closed') {
      return false;
    }

    if (this.state.state === 'open') {
      // Check if reset time has passed
      if (Date.now() - this.state.lastFailure > this.resetMs) {
        this.state.state = 'half-open';
        this.probeInProgress = true;
        return false;
      }
      return true;
    }

    // half-open: only allow one probe request through
    if (this.probeInProgress) {
      return true;
    }
    this.probeInProgress = true;
    return false;
  }

  recordSuccess(): void {
    this.state.failures = 0;
    this.state.state = 'closed';
    this.probeInProgress = false;
  }

  recordFailure(): void {
    this.state.failures++;
    this.state.lastFailure = Date.now();
    this.probeInProgress = false;

    if (this.state.failures >= this.threshold) {
      this.state.state = 'open';
    }
  }
}
```

**Pattern:** Simple in-memory breaker for non-critical services or when Redis unavailable.

---

### 1.4 NLU Circuit Breaker (Layer-Specific)

**Location:** `packages/compiler/src/platform/nlu/enterprise/circuit-breaker.ts`

**Use Case:** Per-layer circuit breaking in NLU pipeline (fallback to next layer on failure)

```typescript
export class NLUCircuitBreaker {
  private circuits = new Map<string, LayerCircuit>();
  private failureThreshold: number;
  private resetTimeoutMs: number;
  private enabled: boolean;

  async wrapLLMCall<T>(layerName: string, fn: () => Promise<T>): Promise<T | null> {
    if (!this.enabled) return fn();

    const circuit = this.getOrCreate(layerName);

    switch (circuit.state) {
      case 'open':
        // Check if reset timeout has elapsed
        if (Date.now() - circuit.lastFailureTime >= this.resetTimeoutMs) {
          circuit.state = 'half-open';
          circuit.successCount = 0;
        } else {
          // Circuit is open — skip this layer
          return null;
        }
        break;

      case 'half-open':
      case 'closed':
        // Allow through
        break;
    }

    try {
      const result = await fn();
      this.onSuccess(layerName);
      return result;
    } catch (error) {
      this.onFailure(layerName);
      throw error;
    }
  }
}
```

**Pattern:** Return `null` when circuit open (signal to pipeline: skip to next layer).

---

## 2. Retry Patterns

### 2.1 Exponential Backoff with Jitter

**Location:** `packages/database/src/mongo/helpers/retry.ts`

```typescript
export interface RetryOptions {
  maxRetries?: number; // Default: 3
  baseDelayMs?: number; // Default: 100ms
  maxDelayMs?: number; // Default: 5000ms
  jitter?: boolean; // Default: true
  shouldRetry?: (error: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

export async function withRetry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 100,
    maxDelayMs = 5000,
    jitter = true,
    shouldRetry = isRetryableError,
    onRetry,
  } = options ?? {};

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt >= maxRetries || !shouldRetry(error)) {
        throw error;
      }

      // Exponential backoff: baseDelay * 2^attempt
      let delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);

      // Add jitter: random value between 0.5x and 1x of delay
      if (jitter) {
        delay = Math.floor(delay * (0.5 + Math.random() * 0.5));
      }

      onRetry?.(error, attempt + 1, delay);

      await sleep(delay);
    }
  }

  throw lastError;
}
```

**Backoff Schedule:**

- Attempt 1: 100ms (+ jitter 50-100ms)
- Attempt 2: 200ms (+ jitter 100-200ms)
- Attempt 3: 400ms (+ jitter 200-400ms)
- Attempt 4: 800ms (+ jitter 400-800ms)
- ...
- Max: 5000ms

**Jitter:** Prevents thundering herd when many clients retry simultaneously.

**Retryable Errors:**

```typescript
export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  // MongoDB error codes
  const code = (error as any).code;
  if (code === MongoErrorCode.WRITE_CONCERN_FAILED) return true;
  if (code === MongoErrorCode.NETWORK_TIMEOUT) return true;
  if (code === MongoErrorCode.INTERRUPTED_AT_SHUTDOWN) return true;

  // Network errors
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ENOTFOUND') return true;

  return false;
}
```

---

### 2.2 Connector Retry Handler

**Location:** `packages/connectors/base/src/client/retry-handler.ts`

```typescript
export interface RetryOptions {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  retryableStatusCodes: number[];
  retryableErrorCodes?: string[];
}

export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  retryableStatusCodes: [408, 429, 500, 502, 503, 504],
};

export class RetryHandler {
  async execute<T>(fn: () => Promise<T>, onRetry?: (context: RetryContext) => void): Promise<T> {
    let lastError: any;

    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error: any) {
        lastError = error;

        // Check if error is retryable
        if (!this.isRetryable(error)) {
          throw error;
        }

        // Don't retry on last attempt
        if (attempt === this.options.maxAttempts) {
          throw error;
        }

        // Calculate delay with exponential backoff
        const delayMs = this.calculateDelay(attempt, error);

        onRetry?.({
          attempt,
          maxAttempts: this.options.maxAttempts,
          delayMs,
          error,
        });

        await this.sleep(delayMs);
      }
    }

    throw lastError;
  }

  private calculateDelay(attempt: number, error: any): number {
    // Check for Retry-After header (429 Too Many Requests)
    if (error.headers?.['retry-after']) {
      const retryAfter = error.headers['retry-after'];
      // Can be seconds (number) or HTTP date (string)
      if (/^\d+$/.test(retryAfter)) {
        return parseInt(retryAfter, 10) * 1000;
      } else {
        const retryDate = new Date(retryAfter);
        const now = new Date();
        return Math.max(0, retryDate.getTime() - now.getTime());
      }
    }

    // Exponential backoff
    const exponentialDelay =
      this.options.initialDelayMs * Math.pow(this.options.backoffMultiplier, attempt - 1);

    // Add jitter (±25%)
    const jitter = exponentialDelay * 0.25 * (Math.random() * 2 - 1);
    const delayWithJitter = exponentialDelay + jitter;

    // Cap at max delay
    return Math.min(this.options.maxDelayMs, Math.max(0, delayWithJitter));
  }
}
```

**Pattern:**

- Respect `Retry-After` header (rate limit responses)
- Exponential backoff with ±25% jitter
- Retry on 408, 429, 500, 502, 503, 504
- Retry on network errors (ECONNRESET, ETIMEDOUT, ENOTFOUND)

---

### 2.3 BullMQ Job Retry

**Already Documented:** See `docs/searchai/rfcs/ANALYSIS-bullmq-usage.md` §8

```typescript
export const STANDARD_JOB_OPTIONS = {
  attempts: 3,
  backoff: {
    type: 'exponential' as const,
    delay: 5_000, // 5s initial delay
  },
};
```

**Backoff Schedule:**

- Attempt 1: 5s
- Attempt 2: 10s (5s × 2)
- Attempt 3: 20s (5s × 4)

---

## 3. Fallback Patterns

### 3.1 Primary/Fallback Executor

**Location:** `packages/agent-transfer/src/adapters/fallback-executor.ts`

```typescript
export async function executeWithFallback(
  primary: FallbackAdapter,
  fallback: FallbackAdapter | undefined,
  payload: TransferPayload,
): Promise<TransferResult> {
  metrics.primaryAttempts++;
  const primaryResult = await primary.execute(payload);
  if (primaryResult.success) return primaryResult;

  metrics.primaryFailures++;
  if (!fallback) return primaryResult;

  log.warn('Primary adapter failed, falling back', {
    tenantId: payload.tenantId,
    status: primaryResult.status,
    error: primaryResult.error?.code,
  });

  metrics.fallbackAttempts++;
  const fallbackResult = await fallback.execute(payload);
  if (!fallbackResult.success) {
    metrics.fallbackFailures++;
  }
  return fallbackResult;
}
```

**Pattern:**

- Try primary adapter first
- If primary fails, try fallback
- Log fallback usage
- Track metrics (primary/fallback attempts/failures)

**Metrics Tracked:**

- `primaryAttempts`: Total attempts on primary
- `fallbackAttempts`: Total fallbacks triggered
- `primaryFailures`: Primary failures
- `fallbackFailures`: Fallback failures

**Fallback Ratio:** `fallbackAttempts / primaryAttempts` (should be low <5%)

---

### 3.2 Tool Executor Fallback

**Location:** `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts`

```typescript
async dispatch(toolName: string, tool: ToolDefinition, params: Record<string, unknown>, timeoutMs: number): Promise<any> {
  const binding = tool.binding;

  if (!binding) {
    if (this.fallback) {
      return this.fallback.execute(toolName, params, timeoutMs);
    }
    throw new Error(`No binding for tool ${toolName} and no fallback provided`);
  }

  try {
    switch (binding.type) {
      case 'http':
        return await this.httpExecutor.execute(toolName, params, timeoutMs);

      case 'mcp':
        return this.mcpExecutor.execute(toolName, params, timeoutMs);

      case 'sandbox':
        return this.sandboxExecutor.execute(toolName, params, timeoutMs);

      default:
        if (this.fallback) {
          return this.fallback.execute(toolName, params, timeoutMs);
        }
        throw new Error(`Unknown binding type: ${(binding as any).type}`);
    }
  } catch (error) {
    if (this.fallback) {
      return this.fallback.execute(toolName, params, timeoutMs);
    }
    throw error;
  }
}
```

**Pattern:**

- Try binding-specific executor
- If no binding or unknown type → fallback
- If execution fails → fallback
- If no fallback → throw error

---

### 3.3 LLM Provider Fallback (Circuit Breaker)

**Pattern:** Use circuit breaker registry to automatically fall back to secondary provider.

```typescript
async function callLLMWithFallback(tenantId: string, messages: Message[]): Promise<LLMResponse> {
  const registry = getCircuitBreakerRegistry();

  // Try primary provider (Anthropic)
  try {
    return await registry.llmProvider(tenantId, 'anthropic').execute(async () => {
      return await callClaude(messages);
    });
  } catch (error) {
    if (error instanceof CircuitOpenError) {
      // Circuit open — try fallback provider (OpenAI)
      return await registry.llmProvider(tenantId, 'openai').execute(async () => {
        return await callOpenAI(messages);
      });
    }
    throw error;
  }
}
```

**Pattern:**

- Circuit breaker throws `CircuitOpenError` when open
- Catch and try fallback provider
- Fallback provider has its own circuit breaker

---

## 4. Timeout Patterns

### 4.1 Tool Execution Timeout

**Location:** `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts`

```typescript
interface ToolBindingExecutorConfig {
  defaultTimeoutMs?: number; // Default: 30000ms
}

async dispatch(toolName: string, tool: ToolDefinition, params: Record<string, unknown>, timeoutMs: number): Promise<any> {
  // Per-tool timeout: use the tool's configured timeout if it's shorter than the global default
  const effectiveTimeout = Math.min(timeoutMs, tool.hints?.timeout ?? timeoutMs);

  // Execute with timeout
  return await executeWithTimeout(
    () => this.httpExecutor.execute(toolName, params, effectiveTimeout),
    effectiveTimeout,
  );
}
```

**Pattern:**

- Global default timeout (30s)
- Per-tool override via `tool.hints.timeout`
- Effective timeout = min(globalTimeout, toolTimeout)

---

### 4.2 MCP Tool Timeout

**Location:** `packages/compiler/src/platform/constructs/executors/mcp-tool-executor.ts`

```typescript
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

async execute(toolName: string, params: Record<string, unknown>, timeoutMs?: number): Promise<any> {
  const effectiveTimeout = timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
    };

    timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(`MCP tool ${toolName} timed out after ${effectiveTimeout}ms`),
      );
    }, effectiveTimeout);

    this.mcpClient
      .callTool(toolName, params)
      .then((result) => {
        cleanup();
        resolve(result);
      })
      .catch((error) => {
        cleanup();
        reject(error);
      });
  });
}
```

**Pattern:**

- Promise race between execution and timeout
- Clear timeout on success/failure
- Throw descriptive error on timeout

---

### 4.3 MongoDB Circuit Breaker with Retry

**Location:** `packages/database/src/mongo/helpers/retry.ts`

```typescript
export class CircuitBreaker {
  private _state: CircuitBreakerState = 'closed';
  private failureCount = 0;
  private halfOpenAttempts = 0;
  private lastFailureTime = 0;

  constructor(options?: CircuitBreakerOptions) {
    this.failureThreshold = options?.failureThreshold ?? 5;
    this.resetTimeoutMs = options?.resetTimeoutMs ?? 30_000;
    this.halfOpenMaxAttempts = options?.halfOpenMaxAttempts ?? 3;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const currentState = this.state;

    if (currentState === 'open') {
      throw new CircuitBreakerOpenError(
        `Circuit breaker is open. Retry after ${this.resetTimeoutMs}ms.`,
      );
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    if (this._state === 'half-open') {
      this.halfOpenAttempts++;
      if (this.halfOpenAttempts >= this.halfOpenMaxAttempts) {
        this.transitionTo('closed');
        this.failureCount = 0;
        this.halfOpenAttempts = 0;
      }
    } else {
      this.failureCount = 0;
    }
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this._state === 'half-open') {
      this.transitionTo('open');
      this.halfOpenAttempts = 0;
    } else if (this.failureCount >= this.failureThreshold) {
      this.transitionTo('open');
    }
  }
}
```

---

## 5. Rate Limiting

### 5.1 Token Bucket Rate Limiter

**Location:** `packages/compiler/src/platform/constructs/executors/http-resilience.ts`

```typescript
export class RateLimiter {
  private state: RateLimitState;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per ms

  constructor(requestsPerMinute: number) {
    this.maxTokens = requestsPerMinute;
    this.refillRate = requestsPerMinute / 60000; // Convert to per ms
    this.state = {
      tokens: this.maxTokens,
      lastRefill: Date.now(),
    };
  }

  async acquire(): Promise<void> {
    this.refill();

    if (this.state.tokens < 1) {
      // Calculate wait time for next token
      const waitMs = Math.ceil((1 - this.state.tokens) / this.refillRate);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      this.refill();
    }

    this.state.tokens -= 1;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.state.lastRefill;
    const tokensToAdd = elapsed * this.refillRate;

    this.state.tokens = Math.min(this.maxTokens, this.state.tokens + tokensToAdd);
    this.state.lastRefill = now;
  }
}
```

**Pattern:**

- Token bucket refills at constant rate
- Block when no tokens available
- Wait for next token to become available

---

### 5.2 Per-Tenant Rate Limiting (Redis)

**Already Documented:** See `docs/searchai/rfcs/ANALYSIS-rest-api-patterns.md` §9

```typescript
export function searchAiRateLimit(options?: SearchAiRateLimitOptions): RequestHandler {
  const limit = options?.limit ?? DEFAULT_LIMIT; // 120 req/min
  const windowMs = options?.windowMs ?? DEFAULT_WINDOW_MS; // 60000ms

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const tenantId = req.tenantContext?.tenantId;
    const key = tenantId || req.ip || 'anon';

    // Try Redis first, fall back to memory
    let result = await redisCheck(key, limit, windowMs);
    if (!result) {
      result = memoryCheck(key, limit, windowMs);
    }

    // Set standard rate-limit headers
    res.set('X-RateLimit-Limit', String(limit));
    res.set('X-RateLimit-Remaining', String(result.remaining));
    res.set('X-RateLimit-Reset', String(Math.ceil((Date.now() + result.resetMs) / 1000)));

    if (!result.allowed) {
      res.status(429).json({
        error: 'Rate limit exceeded',
        operation: 'request',
        limit,
        retryAfterMs: result.resetMs,
      });
      return;
    }

    next();
  };
}
```

**Pattern:** Redis-backed fixed-window rate limiting with in-memory fallback.

---

## 6. Recommendations for Pipeline Circuit Breaker

Based on existing patterns, the pipeline flow circuit breaker should:

### 6.1 Use Redis Circuit Breaker Package

```typescript
import { CircuitBreakerRegistry } from '@agent-platform/circuit-breaker';

const registry = new CircuitBreakerRegistry(redis, {
  defaults: {
    tool_service: {
      failureThreshold: 15, // Higher for pipeline flows (more complex)
      successThreshold: 3,
      resetTimeout: 45_000, // 45s (longer than individual tools)
      monitorWindow: 60_000, // 1 min
      halfOpenMaxConcurrent: 2,
      failureRateThreshold: 40,
      minimumRequestCount: 10,
    },
  },
});

// Per-flow protection
async function executePipelineFlow(
  tenantId: string,
  indexId: string,
  flowId: string,
  document: Document,
) {
  const flowKey = `${tenantId}:${indexId}:${flowId}`;

  try {
    return await registry.toolService(tenantId, flowKey).execute(async () => {
      return await executeFlow(flowId, document);
    });
  } catch (error) {
    if (error instanceof CircuitOpenError) {
      // Circuit open — fall back to legacy pipeline
      console.warn(`Flow ${flowId} circuit open, falling back to legacy`, {
        tenantId,
        indexId,
        flowId,
        retryAfterMs: error.retryAfterMs,
      });
      return await executeLegacyPipeline(document);
    }
    throw error;
  }
}
```

### 6.2 Hierarchy

```
Tenant (acme-corp)
  └─ Tool Service (pipeline flows)
      ├─ acme-corp:index-1:flow-pdf
      ├─ acme-corp:index-1:flow-webpage
      └─ acme-corp:index-2:flow-spreadsheet
```

### 6.3 Configuration

```typescript
const PIPELINE_FLOW_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 15, // 15 consecutive failures
  successThreshold: 3, // 3 successes in half-open
  resetTimeout: 45_000, // 45s wait before retry
  monitorWindow: 60_000, // 1 min rolling window
  halfOpenMaxConcurrent: 2, // Allow 2 probes
  failureRateThreshold: 40, // 40% failure rate
  minimumRequestCount: 10, // At least 10 requests before rate applies
};
```

**Reasoning:**

- **Higher failure threshold (15):** Flows are more complex than individual tools
- **Longer reset timeout (45s):** More time for transient issues to resolve
- **Moderate failure rate (40%):** Allow some failures due to document variability

### 6.4 Fallback Strategy

```typescript
// Circuit breaker at flow level
async function executeFlowWithFallback(
  tenantId: string,
  indexId: string,
  flowId: string,
  document: Document,
): Promise<ProcessingResult> {
  const registry = getCircuitBreakerRegistry();
  const flowKey = `${tenantId}:${indexId}:${flowId}`;

  try {
    // Try BullMQ Flow execution
    return await registry.toolService(tenantId, flowKey).execute(async () => {
      return await executeBullMQFlow(flowId, document);
    });
  } catch (error) {
    if (error instanceof CircuitOpenError) {
      // Circuit open — fall back to legacy pipeline
      return await executeLegacyPipeline(document);
    }
    throw error;
  }
}
```

### 6.5 Monitoring Integration

```typescript
const registry = new CircuitBreakerRegistry(redis);

// Subscribe to circuit breaker events
registry.onEvent((event) => {
  if (event.from && event.to) {
    // State change event
    console.log(`Circuit ${event.level}:${event.key} transitioned ${event.from} → ${event.to}`, {
      failureCount: event.failureCount,
      totalCount: event.totalCount,
      failureRate: event.failureRate,
    });

    // Alert on circuit open
    if (event.to === 'OPEN') {
      sendAlert({
        severity: 'HIGH',
        message: `Pipeline flow circuit opened: ${event.key}`,
        failureRate: event.failureRate,
      });
    }
  } else {
    // Execution event
    if (event.action === 'rejected') {
      console.warn(`Circuit ${event.level}:${event.key} rejected request (state: ${event.state})`);
    }
  }
});
```

---

## 7. Comparison of Circuit Breaker Implementations

| Feature                    | Redis Circuit Breaker                        | In-Memory Circuit Breaker               | NLU Circuit Breaker           |
| -------------------------- | -------------------------------------------- | --------------------------------------- | ----------------------------- |
| **State Storage**          | Redis (distributed)                          | In-memory (pod-local)                   | In-memory (pod-local)         |
| **Shared State**           | ✅ Yes (across instances)                    | ❌ No (per-pod)                         | ❌ No (per-pod)               |
| **Atomic Transitions**     | ✅ Yes (Lua scripts)                         | ❌ No (local state)                     | ❌ No (local state)           |
| **Hierarchical Levels**    | ✅ Yes (tenant/app/llm_provider/tool_service | ❌ No                                   | ✅ Yes (per-layer)            |
| **Rolling Window Metrics** | ✅ Yes (sorted sets)                         | ❌ No (simple counter)                  | ❌ No (simple counter)        |
| **Failure Rate Tracking**  | ✅ Yes                                       | ❌ No                                   | ❌ No                         |
| **Half-Open Concurrency**  | ✅ Yes (configurable)                        | ✅ Yes (single probe)                   | ✅ Yes (single probe)         |
| **Event Listeners**        | ✅ Yes                                       | ❌ No                                   | ❌ No                         |
| **Force Reset**            | ✅ Yes (ops team)                            | ✅ Yes (reset() method)                 | ✅ Yes (reset() method)       |
| **Best For**               | Production (distributed, high-scale)         | Simple use cases (pod-local protection) | NLU pipeline (layer fallback) |

**Recommendation:** Use Redis Circuit Breaker for pipeline flows (distributed state, metrics, monitoring).

---

## 8. Key Patterns Summary

| Pattern             | Implementation                                 | Use Case                         |
| ------------------- | ---------------------------------------------- | -------------------------------- |
| **Circuit Breaker** | Redis-backed with Lua atomic transitions       | LLM providers, external services |
| **Retry**           | Exponential backoff with jitter                | Transient failures               |
| **Fallback**        | Primary → Fallback adapter pattern             | Multi-provider resilience        |
| **Timeout**         | Promise race with cleanup                      | Long-running operations          |
| **Rate Limiting**   | Token bucket (in-memory) or Redis fixed-window | Per-tenant/per-service limits    |
| **Health Check**    | State + metrics aggregation                    | Monitoring dashboards            |
| **Force Reset**     | Manual circuit override (ops team)             | Emergency recovery               |
| **Event Listeners** | Subscribe to state changes                     | Alerting, metrics                |

---

## Conclusion

**Key Takeaways:**

1. ✅ **Production-ready circuit breaker** package exists (`@agent-platform/circuit-breaker`)
2. ✅ **Redis-backed distributed state** with atomic Lua script transitions
3. ✅ **Hierarchical isolation** (tenant → app → llm_provider → tool_service)
4. ✅ **Comprehensive retry patterns** with exponential backoff + jitter
5. ✅ **Fallback mechanisms** (primary/fallback adapters, circuit-aware)
6. ✅ **Timeout patterns** with per-tool overrides
7. ✅ **Rate limiting** (token bucket, Redis fixed-window)
8. ✅ **Monitoring integration** (event listeners, health checks, force reset)

**For Pipeline Circuit Breaker:**

- Use `CircuitBreakerRegistry` from `@agent-platform/circuit-breaker`
- Configure as `tool_service` level with custom thresholds
- Key: `{tenantId}:{indexId}:{flowId}`
- Fallback to legacy pipeline on circuit open
- Monitor state transitions and failure rates
- Alert on circuit open (HIGH severity)

**Next:** Proceed to Task #44 (Backend Design: Circuit breaker service) using this infrastructure.

---

**Analysis complete.** Ready for pipeline circuit breaker design implementation.
