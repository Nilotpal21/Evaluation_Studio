# High-Level Design: Circuit Breaker — Resilience Patterns for External Service Calls

**Feature ID:** #44
**Status:** PLANNED
**Created:** 2026-03-22
**Feature Spec:** `docs/features/circuit-breaker.md`
**Test Spec:** `docs/testing/circuit-breaker.md`

---

## 1. Architecture Overview

The circuit breaker system uses the existing `@agent-platform/circuit-breaker` package (Redis-backed, Lua-script atomic transitions) as the core engine, integrated into the platform's four external call boundaries:

```
                         ┌──────────────────────┐
                         │  CircuitBreakerRegistry │
                         │  (Redis-backed, shared) │
                         └──────────┬───────────┘
                                    │
            ┌───────────────────────┼───────────────────────┐
            │                       │                       │
   ┌────────▼────────┐   ┌─────────▼─────────┐   ┌────────▼────────┐
   │  LLM Provider   │   │  Tool Service     │   │  MCP Server     │
   │  (llm_provider) │   │  (tool_service)   │   │  (tool_service) │
   └────────┬────────┘   └─────────┬─────────┘   └────────┬────────┘
            │                       │                       │
   ┌────────▼────────┐   ┌─────────▼─────────┐   ┌────────▼────────┐
   │ SessionLLMClient│   │ HTTP Tool Executor│   │ MCP Providers   │
   │ generateText()  │   │ executeTool()     │   │ callTool()      │
   │ streamText()    │   │                   │   │                 │
   └─────────────────┘   └───────────────────┘   └─────────────────┘
```

**Key design principle:** The `CircuitBreakerRegistry` is a **process-level singleton** initialized once per pod with the shared Redis connection. Each call boundary obtains a `BreakerHandle` from the registry using the appropriate level (`llm_provider` or `tool_service`) and key (`{tenantId}:{provider}` or `{tenantId}:{serviceName}`).

---

## 2. Component Architecture

### 2.1 Circuit Breaker Singleton

A new module `apps/runtime/src/services/circuit-breaker-singleton.ts` creates and exports a singleton `CircuitBreakerRegistry`:

```typescript
// Lazy initialization — only created when first accessed
let registry: CircuitBreakerRegistry | null = null;

export function getCircuitBreakerRegistry(): CircuitBreakerRegistry {
  if (!registry) {
    const redis = getRedisClient(); // existing runtime Redis
    registry = new CircuitBreakerRegistry(redis, {
      defaults: {
        /* level-specific overrides from config */
      },
    });
    // Register global event listener for TraceEvent emission
    registry.onEvent(emitBreakerTraceEvent);
  }
  return registry;
}
```

### 2.2 SessionLLMClient Integration

The `SessionLLMClient` wraps `generateText()` and `streamText()` calls in the circuit breaker:

```
SessionLLMClient.generate()
  → registry.llmProvider(tenantId, providerName).execute(() => generateText(...))
  → catch CircuitOpenError → attempt fallback provider
  → catch CircuitOpenError (fallback) → return structured error
```

### 2.3 HTTP Tool Executor Integration

Tool execution wraps the HTTP call:

```
executeTool(toolDef, args)
  → registry.toolService(tenantId, toolServiceKey).execute(() => httpCall(...))
  → catch CircuitOpenError → return tool error result with retryAfterMs
```

The `toolServiceKey` is derived from the tool's endpoint hostname (e.g., `api.example.com`) to share circuit state across tools pointing to the same service.

### 2.4 Health API

New route: `GET /api/projects/:projectId/circuit-breakers/health`

```typescript
router.get(
  '/circuit-breakers/health',
  requireProjectPermission('circuit_breaker:read'),
  async (req, res) => {
    const registry = getCircuitBreakerRegistry();
    const health = await registry.getTenantHealth(req.tenantId);
    return res.json({ success: true, data: health });
  },
);
```

### 2.5 Admin Reset API

New route: `POST /api/admin/circuit-breakers/:tenantId/reset`

```typescript
router.post(
  '/circuit-breakers/:tenantId/reset',
  requirePermission('admin:circuit_breaker:reset'),
  async (req, res) => {
    const { level, key, targetState } = req.body;
    const registry = getCircuitBreakerRegistry();
    // ... validation ...
    const result = await registry.forceResetTenant(tenantId, targetState);
    // emit audit TraceEvent
    return res.json({ success: true, data: result });
  },
);
```

---

## 3. 12 Architectural Concerns

### 3.1 Security

- **Auth:** Health and reset APIs use existing `requireProjectPermission` and `requirePermission` middleware
- **Tenant isolation:** Circuit breaker keys are prefixed with `tenantId` — no cross-tenant state leakage possible
- **Admin reset audit:** Every force-reset emits an audit TraceEvent with operator identity
- **Redis key namespace:** All breaker keys use `breaker:{level}:{tenantId}:{service}:*` pattern, preventing key collision

### 3.2 Performance

- **Overhead:** < 5ms per external call (single Redis Lua script round-trip)
- **No hot path blocking:** Lua scripts are O(1) with sorted set operations bounded by monitor window size
- **Connection reuse:** Registry uses the existing runtime Redis connection pool
- **Lazy initialization:** Registry created on first access, not at boot time
- **Metric collection:** `getMetrics()` uses Redis pipeline (single round-trip for 5 keys)

### 3.3 Scalability

- **Horizontal scaling:** Redis-backed state shared across all pods — adding pods does not fragment circuit state
- **Key cardinality:** Bounded by `tenants * (providers + tools)` — typically < 10,000 keys for large deployments
- **Memory:** Each breaker uses 5 Redis keys with TTLs — memory is bounded by active windows
- **Sorted set pruning:** Failures/successes outside the monitor window are pruned on every operation

### 3.4 Reliability

- **Redis unavailability:** Fallback to allow-all mode (no circuit protection but no cascading failure from Redis)
- **Atomic transitions:** Lua scripts ensure state machine transitions are atomic even under concurrent access
- **Half-open probe limiting:** `halfOpenMaxConcurrent` prevents thundering herd on recovery
- **No single point of failure:** Redis unavailability degrades to unprotected mode, does not block

### 3.5 Data Model

No new MongoDB models. All circuit breaker state lives in Redis with the following key structure:

```
breaker:{level}:{key}:state          → string: CLOSED | OPEN | HALF_OPEN
breaker:{level}:{key}:failures       → sorted set (score=timestamp)
breaker:{level}:{key}:successes      → sorted set (score=timestamp)
breaker:{level}:{key}:opened_at      → string: timestamp ms
breaker:{level}:{key}:half_open_count → string: counter
```

TTL: All keys expire after `monitorWindow + resetTimeout` to prevent stale data accumulation.

### 3.6 Observability

- **Logging:** Every state transition logged via `createLogger('circuit-breaker')` with `{ level, key, from, to, failureCount }`
- **TraceEvents:** State changes emitted as `circuit_breaker_state_change` TraceEvents via `TraceStore`
- **Metrics (future):** OpenTelemetry counters for circuit opens, closes, rejections per level/key
- **Health API:** `GET /circuit-breakers/health` for dashboard integration

### 3.7 Error Handling

- **CircuitOpenError:** Extends `AppError` with `statusCode: 503`, includes `level`, `key`, `retryAfterMs`
- **Structured response:** `{ success: false, error: { code: 'CIRCUIT_OPEN', message: '...', retryAfterMs: N } }`
- **LLM fallback chain:** Primary → Fallback → Structured error (never unhandled)
- **Tool error format:** Circuit open errors are formatted as tool execution errors, not generic 500s
- **Redis errors:** Caught and swallowed — circuit breaker degrades to allow-all, error logged

### 3.8 Tenant Isolation

- **Key scoping:** Every breaker key includes `tenantId` as prefix
- **No shared state:** `breaker:llm_provider:tenant-A:openai:state` is completely independent of `breaker:llm_provider:tenant-B:openai:state`
- **Per-tenant overrides:** `CircuitBreakerRegistry.setTenantOverride()` allows custom thresholds without affecting other tenants
- **Health API scoping:** Returns only the requesting tenant's circuit state

### 3.9 Compliance

- **No PII in Redis:** Breaker keys use tenant IDs and provider names — no user data stored
- **TTL enforcement:** All Redis keys auto-expire — no long-term data retention
- **Audit trail:** Force-reset operations logged as TraceEvents with operator identity

### 3.10 Testing

- **E2E:** 8 scenarios covering LLM, tool, fallback, health API, admin reset, half-open, tenant isolation
- **Integration:** 7 scenarios covering registry wiring, DSL config, events, Redis fallback, metrics, health aggregation, concurrent probes
- **Existing:** `packages/circuit-breaker/src/__tests__/` already has comprehensive state machine tests
- **No mocking policy:** E2E tests use real Express servers; only external services are mocked

### 3.11 Backward Compatibility

- **Additive change:** Circuit breaker wrapping is added around existing call paths — no API contract changes
- **Error format:** `CircuitOpenError` is a subclass of `AppError` — existing error handlers will process it correctly
- **Pipeline breaker:** Existing in-memory pipeline breaker continues working (P2 consolidation)
- **DSL compatibility:** `circuit_breaker:` block is already parsed — runtime consumption is a new feature, not a breaking change

### 3.12 Deployment & Migration

- **Redis dependency:** Runtime already requires Redis — no new infrastructure
- **Feature flag:** `CIRCUIT_BREAKER_ENABLED=true|false` env var to enable/disable at boot (default: true)
- **Rollback:** Disable via feature flag — all calls pass through unprotected (same as current behavior)
- **No data migration:** Redis keys are created on first use and auto-expire
- **Canary deployment:** Enable on a single pod first, verify via health API, then roll out

---

## 4. Alternatives Considered

### Alternative A: Standalone In-Memory Circuit Breaker Per Pod (Rejected)

**Description:** Keep the existing pattern of in-memory circuit breakers (like the pipeline breaker) and create new ones for LLM and tool calls.

**Pros:**

- Zero Redis dependency for circuit breaking
- Simpler implementation (no Lua scripts, no distributed state)
- No network round-trip overhead

**Cons:**

- **No cross-pod consistency** — pod A's circuit state is invisible to pod B
- **State lost on restart** — circuit resets on pod deploy/crash
- **Thundering herd** — when a circuit opens on one pod, other pods keep sending requests to the failing service
- **Memory management** — each pod needs its own LRU eviction, TTL management

**Decision:** REJECTED. The platform runs multiple replicas per service. In-memory circuit breakers create a false sense of protection — the overall system still hammers failing services at (N-1)/N of the original rate when one pod's circuit opens.

### Alternative B: External Circuit Breaker Service (e.g., Envoy, Istio) (Rejected)

**Description:** Use service mesh (Istio) or API gateway (Envoy) circuit breaking for external calls.

**Pros:**

- Language-agnostic — works for any service
- No application code changes
- Infra team manages circuit breaker policy

**Cons:**

- **No tenant isolation** — service mesh operates at connection level, not tenant level
- **No application-level fallback** — cannot trigger LLM provider fallback from a mesh-level circuit
- **Deployment complexity** — requires Istio sidecar injection, custom DestinationRules per external service
- **Less control** — cannot customize behavior per tool or per DSL config
- **Existing infrastructure gap** — platform does not currently use Istio

**Decision:** REJECTED. The platform needs tenant-level isolation and application-level fallback logic that service mesh circuit breakers cannot provide. The existing `@agent-platform/circuit-breaker` Redis-backed package already solves this correctly.

### Alternative C: Hybrid — Redis for LLM, In-Memory for Tools (Considered)

**Description:** Use Redis-backed circuit breakers only for LLM providers (high-value, limited providers) and keep in-memory breakers for tool services (many tools, lower blast radius per tool).

**Pros:**

- Reduces Redis operations for the high-cardinality tool call path
- In-memory tools CB has near-zero overhead
- LLM providers (the critical path) still get cross-pod consistency

**Cons:**

- **Two circuit breaker systems** — increases cognitive load and maintenance burden
- **Tool failures still fragment** across pods
- **The Redis-backed package already handles high cardinality** — sorted set pruning keeps memory bounded

**Decision:** NOT SELECTED for initial implementation, but acknowledged as a valid optimization if Redis circuit check latency becomes measurable. The initial implementation uses Redis for all levels uniformly.

---

## 5. Data Flow

### LLM Call with Circuit Breaker

```
1. Agent receives user message
2. RuntimeExecutor calls SessionLLMClient.generate()
3. SessionLLMClient:
   a. Extracts tenantId + providerName from session context
   b. Calls registry.llmProvider(tenantId, providerName).execute(() => {
        return generateText({ model, messages, tools, ... })
      })
4. RedisCircuitBreaker:
   a. Lua script: breakerCheckState(keys...) → {state, canExecute, retryAfterMs}
   b. If canExecute=false → throw CircuitOpenError
   c. Execute fn() → generateText()
   d. On success: Lua script: breakerRecordSuccess(keys...)
   e. On failure: Lua script: breakerRecordFailure(keys...)
5. On CircuitOpenError:
   a. SessionLLMClient checks if fallback provider is configured
   b. If yes: retry with registry.llmProvider(tenantId, fallbackProvider).execute(...)
   c. If no: return structured error {code: 'CIRCUIT_OPEN', retryAfterMs}
6. Response flows back to RuntimeExecutor → WebSocket → client
```

### Tool Call with Circuit Breaker

```
1. LLM returns tool_call in response
2. RuntimeExecutor dispatches to tool executor
3. Tool executor:
   a. Extracts tenantId + toolServiceKey from tool definition
   b. toolServiceKey = hostname of tool endpoint (e.g., "api.weather.com")
   c. Checks DSL circuit_breaker config → override threshold/resetMs if specified
   d. Calls registry.toolService(tenantId, toolServiceKey).execute(() => {
        return httpCall(endpoint, method, headers, body)
      })
4. RedisCircuitBreaker: same flow as LLM
5. On CircuitOpenError:
   a. Return tool error result: { error: 'Tool service temporarily unavailable', retryAfterMs }
   b. LLM can decide to use alternative tool or respond to user
```

---

## 6. Configuration

### Default Thresholds (from `@agent-platform/circuit-breaker`)

| Level        | failureThreshold | successThreshold | resetTimeout | monitorWindow | halfOpenMaxConcurrent | failureRateThreshold | minimumRequestCount |
| ------------ | ---------------: | ---------------: | -----------: | ------------: | --------------------: | -------------------: | ------------------: |
| tenant       |               50 |                5 |     30,000ms |      60,000ms |                     3 |                  50% |                  20 |
| app          |               20 |                3 |     15,000ms |      30,000ms |                     2 |                  40% |                  10 |
| llm_provider |               10 |                2 |     60,000ms |      30,000ms |                     1 |                  30% |                   5 |
| tool_service |               10 |                2 |     30,000ms |      30,000ms |                     1 |                  40% |                   5 |

### Environment Variables

| Variable                    | Default | Description                                          |
| --------------------------- | ------- | ---------------------------------------------------- |
| `CIRCUIT_BREAKER_ENABLED`   | `true`  | Master switch to enable/disable all circuit breakers |
| `CB_LLM_FAILURE_THRESHOLD`  | `10`    | Override llm_provider failure threshold              |
| `CB_LLM_RESET_TIMEOUT_MS`   | `60000` | Override llm_provider reset timeout                  |
| `CB_TOOL_FAILURE_THRESHOLD` | `10`    | Override tool_service failure threshold              |
| `CB_TOOL_RESET_TIMEOUT_MS`  | `30000` | Override tool_service reset timeout                  |

### DSL Override (per-tool)

```yaml
TOOL: weather-lookup
  endpoint: https://api.weather.com/v1/forecast
  method: GET
  circuit_breaker:
    threshold: 5
    reset_ms: 10000
```

---

## 7. API Surface

### Health Endpoint

```
GET /api/projects/:projectId/circuit-breakers/health
Authorization: Bearer <token>

Response 200:
{
  "success": true,
  "data": {
    "tenantId": "tenant-123",
    "tenant": { "state": "CLOSED", "failureCount": 0, ... },
    "apps": [],
    "llmProviders": [
      { "key": "tenant-123:openai", "metrics": { "state": "OPEN", "failureCount": 12, "failureRate": 80, "openedAt": 1711152000000 } }
    ],
    "toolServices": [
      { "key": "tenant-123:api.weather.com", "metrics": { "state": "CLOSED", "failureCount": 2, ... } }
    ],
    "hasOpenCircuits": true
  }
}
```

### Admin Reset Endpoint

```
POST /api/admin/circuit-breakers/:tenantId/reset
Authorization: Bearer <admin-token>
Content-Type: application/json

Body:
{
  "targetState": "CLOSED"
}

Response 200:
{
  "success": true,
  "data": {
    "tenantId": "tenant-123",
    "resetLevels": ["tenant", "app", "llm_provider", "tool_service"],
    "targetState": "CLOSED"
  }
}
```

---

## 8. Dependencies

### Existing (No Changes Needed)

| Dependency                        | Version      | Purpose                           |
| --------------------------------- | ------------ | --------------------------------- |
| `@agent-platform/circuit-breaker` | workspace:\* | Redis-backed circuit breaker core |
| `ioredis`                         | ^5.7.0       | Redis client (already in runtime) |
| `@agent-platform/shared`          | workspace:\* | `AppError`, `ErrorCodes`          |

### New Dependencies: None

The `@agent-platform/circuit-breaker` package needs to be added to `apps/runtime/package.json` dependencies, but the package itself already exists.
