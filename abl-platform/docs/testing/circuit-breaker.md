# Test Spec: Circuit Breaker — Resilience Patterns for External Service Calls

**Feature ID:** #44
**Status:** PLANNED
**Created:** 2026-03-22
**Last Updated:** 2026-03-22
**Feature Spec:** `docs/features/circuit-breaker.md`

---

## 1. Test Strategy

The circuit breaker feature has **three distinct integration surfaces**:

1. **Redis-backed state machine** — Already tested in `packages/circuit-breaker/src/__tests__/` (unit + Redis mock)
2. **Runtime integration points** — `SessionLLMClient`, HTTP tool executor, MCP providers (NEW, primary focus)
3. **API surface** — Health endpoint, admin reset endpoint (NEW)

**Testing approach:**

- **E2E tests** exercise the full HTTP path: client request -> Express middleware -> circuit breaker -> external call mock -> response
- **Integration tests** exercise the circuit breaker registry wired into real service classes with a Redis test instance
- **No mocking of codebase components** in E2E tests — only external third-party services (LLM providers, tool endpoints) are mocked via HTTP interceptors
- **Real Express servers** started on random ports with full middleware chain

---

## 2. E2E Test Scenarios

### E2E-CB-1: LLM Provider Circuit Opens After Failure Threshold

**Covers:** FR-CB-1, FR-CB-6, FR-CB-13
**Priority:** P0

**Setup:**

- Start runtime Express server on random port with real middleware chain (auth, tenant isolation, rate limiting)
- Configure Redis-backed `CircuitBreakerRegistry` with `llm_provider` defaults (failureThreshold: 10, resetTimeout: 60_000)
- Mock LLM provider HTTP endpoint to return 503 errors
- Seed a tenant with a valid agent configuration pointing to the mock LLM

**Steps:**

1. Send 10 consecutive agent chat messages via `POST /api/v1/sessions/:sessionId/messages`
2. Each message triggers an LLM call that returns 503 from the mocked provider
3. Verify the first 10 responses contain the original 503-derived error
4. Send an 11th message
5. Verify the 11th response returns immediately with `CircuitOpenError` (503 status, `CIRCUIT_OPEN` error code, `retryAfterMs > 0`)
6. Verify no HTTP call was made to the mocked LLM provider for the 11th request

**Expected:**

- Circuit opens after failure threshold
- Subsequent requests fail fast with structured error
- `retryAfterMs` is present in error response

---

### E2E-CB-2: LLM Provider Fallback on Circuit Open

**Covers:** FR-CB-5, FR-CB-6
**Priority:** P0

**Setup:**

- Start runtime server with real middleware
- Configure tenant with primary provider (OpenAI, mocked to 503) and secondary provider (Anthropic, mocked to 200)
- `CircuitBreakerRegistry` with `llm_provider` level

**Steps:**

1. Trip the OpenAI circuit by sending requests that cause 10 consecutive failures
2. Verify circuit is OPEN for `{tenantId}:openai`
3. Send a new chat message
4. Verify the system falls back to Anthropic provider
5. Verify the Anthropic circuit is CLOSED and the response is successful
6. Verify the response includes metadata indicating fallback was used

**Expected:**

- Primary provider circuit opens
- Fallback provider is attempted automatically
- Successful response from fallback provider

---

### E2E-CB-3: HTTP Tool Circuit Opens and Returns Structured Error

**Covers:** FR-CB-2, FR-CB-7, FR-CB-13
**Priority:** P0

**Setup:**

- Start runtime server with real middleware
- Create an agent with an HTTP tool pointing to a mock endpoint
- Mock endpoint returns 500 errors
- `CircuitBreakerRegistry` with `tool_service` defaults (failureThreshold: 10)

**Steps:**

1. Trigger 10 tool invocations that hit the failing mock endpoint
2. Verify each returns the tool execution error
3. Trigger an 11th tool invocation
4. Verify the 11th invocation returns immediately with a structured error indicating the tool service circuit is open
5. Verify the tool error includes the tool name and `retryAfterMs`
6. Verify other tools for the same agent (pointing to healthy endpoints) continue working

**Expected:**

- Per-tool circuit isolation works
- Other tools unaffected by one tool's circuit opening
- Structured error includes retry information

---

### E2E-CB-4: Circuit Health API Returns Correct State

**Covers:** FR-CB-8
**Priority:** P1

**Setup:**

- Start runtime server with real middleware and auth
- Configure `CircuitBreakerRegistry` with Redis
- Trip one LLM provider circuit and one tool service circuit

**Steps:**

1. Authenticate as tenant admin
2. Trip the OpenAI LLM circuit (cause failures)
3. Trip a tool service circuit (cause failures)
4. Call `GET /api/projects/:projectId/circuit-breakers/health`
5. Verify response includes:
   - `hasOpenCircuits: true`
   - LLM provider entry with `state: 'OPEN'`, `failureCount >= threshold`, `failureRate > 0`
   - Tool service entry with `state: 'OPEN'`
   - Other entries in `CLOSED` state
6. Reset the LLM circuit via admin API
7. Re-check health: LLM provider should be `CLOSED`

**Expected:**

- Health API returns accurate per-level state
- `hasOpenCircuits` flag reflects aggregated state
- Force reset correctly transitions breaker state

---

### E2E-CB-5: Admin Force-Reset Recovers Stuck Circuit

**Covers:** FR-CB-9
**Priority:** P1

**Setup:**

- Start runtime server with admin auth middleware
- Trip a tenant's LLM provider circuit

**Steps:**

1. Authenticate as platform admin
2. Verify circuit is OPEN via health API
3. Call `POST /api/admin/circuit-breakers/:tenantId/reset` with `{ level: 'llm_provider', key: '{tenantId}:openai', targetState: 'CLOSED' }`
4. Verify response confirms reset (state: CLOSED, action: forced)
5. Send a new agent chat message
6. Verify the message reaches the LLM provider (no longer blocked by circuit)

**Expected:**

- Admin can force-reset any circuit
- Reset takes effect immediately (no stale cache)
- Next request goes through normally

---

### E2E-CB-6: Half-Open Probe After Reset Timeout

**Covers:** FR-CB-1, FR-CB-13
**Priority:** P0

**Setup:**

- Start runtime server
- Configure `CircuitBreakerRegistry` with a short `resetTimeout` (e.g., 2000ms for test speed)
- Trip the LLM circuit

**Steps:**

1. Trip the LLM circuit by causing failures past threshold
2. Verify circuit is OPEN
3. Wait for `resetTimeout` to elapse (2000ms)
4. Send a new chat message
5. Mock LLM provider now returns 200
6. Verify the probe request succeeds
7. Verify circuit transitions to CLOSED
8. Send another message — verify it succeeds normally

**Expected:**

- Circuit transitions from OPEN to HALF_OPEN after timeout
- Successful probe closes the circuit
- Normal operation resumes

---

### E2E-CB-7: Half-Open Probe Failure Re-Opens Circuit

**Covers:** FR-CB-1
**Priority:** P1

**Setup:**

- Same as E2E-CB-6 but mock provider still returns 503 after timeout

**Steps:**

1. Trip the LLM circuit
2. Wait for `resetTimeout`
3. Send probe request — mock still returns 503
4. Verify circuit re-opens (state: OPEN, new `openedAt`)
5. Subsequent requests fail fast again

**Expected:**

- Failed half-open probe re-opens the circuit
- `openedAt` is updated to the probe failure time

---

### E2E-CB-8: Tenant Isolation — Cross-Tenant Circuit Independence

**Covers:** FR-CB-6, FR-CB-7
**Priority:** P0

**Setup:**

- Start runtime server
- Configure two tenants: tenant-A (OpenAI failing) and tenant-B (OpenAI healthy)

**Steps:**

1. Trip tenant-A's OpenAI circuit by causing 10 failures
2. Verify tenant-A's circuit is OPEN
3. Send a chat message for tenant-B using OpenAI
4. Verify tenant-B's request succeeds (circuit is CLOSED for tenant-B)
5. Verify tenant-B's OpenAI circuit state is CLOSED via health API

**Expected:**

- Circuits are isolated per-tenant per-provider
- One tenant's outage does not affect another tenant

---

## 3. Integration Test Scenarios

### INT-CB-1: CircuitBreakerRegistry Wired Into SessionLLMClient

**Covers:** FR-CB-1, FR-CB-6
**Priority:** P0

**Setup:**

- Create `CircuitBreakerRegistry` with real Redis (or ioredis-mock)
- Create `SessionLLMClient` instance with the registry injected
- Mock the Vercel AI SDK `generateText` to simulate failures

**Steps:**

1. Call `SessionLLMClient.generate()` with a request that triggers LLM failure
2. Repeat past the failure threshold
3. Verify the next `generate()` call throws `CircuitOpenError` without calling the AI SDK
4. Verify circuit state in Redis matches expected key pattern: `breaker:llm_provider:{tenantId}:{provider}:state`

**Expected:**

- `SessionLLMClient` correctly wraps LLM calls in circuit breaker
- Redis key structure follows the `breakerKeys()` pattern

---

### INT-CB-2: DSL Circuit Breaker Config Override

**Covers:** FR-CB-11
**Priority:** P1

**Setup:**

- Parse a tool DSL with `circuit_breaker: { threshold: 3, reset_ms: 5000 }`
- Create a `CircuitBreakerRegistry` with default `tool_service` config (threshold: 10)

**Steps:**

1. Parse the DSL tool config
2. Extract `circuitBreaker` from the parsed form data
3. Create a tool-specific breaker with the DSL-specified thresholds
4. Trigger 3 failures (DSL threshold, not default 10)
5. Verify circuit opens after 3 failures, not 10

**Expected:**

- DSL config takes precedence over platform defaults
- The `dsl-property-parser` output flows to runtime breaker configuration

---

### INT-CB-3: CircuitBreakerRegistry Event System

**Covers:** FR-CB-10
**Priority:** P1

**Setup:**

- Create `CircuitBreakerRegistry` with Redis
- Register event listener via `registry.onEvent()`

**Steps:**

1. Execute a call through `registry.llmProvider(tenant, 'openai').execute(fn)`
2. Cause enough failures to open the circuit
3. Verify event listener received:
   - `BreakerExecutionEvent` with `action: 'failed'` for each failure
   - `BreakerStateChangeEvent` with `from: 'CLOSED', to: 'OPEN'` when circuit opens
4. Wait for reset timeout, cause a success
5. Verify `BreakerStateChangeEvent` with `from: 'HALF_OPEN', to: 'CLOSED'`

**Expected:**

- Events fire for all state transitions
- Events include all metadata (level, key, timestamps, counts)

---

### INT-CB-4: Redis Unavailability Fallback

**Covers:** NFR-CB-5
**Priority:** P1

**Setup:**

- Create `CircuitBreakerRegistry` with a Redis client that will disconnect
- Wrap an external call in the circuit breaker

**Steps:**

1. Disconnect the Redis client (simulate unavailability)
2. Attempt to execute a call through the circuit breaker
3. Verify the call proceeds (allow-all fallback) rather than throwing a Redis error
4. Reconnect Redis
5. Verify circuit breaker resumes normal operation

**Expected:**

- Redis failures do not cascade into application failures
- Circuit breaker degrades to allow-all mode

---

### INT-CB-5: BreakerHandle getMetrics Returns Accurate State

**Covers:** FR-CB-8
**Priority:** P1

**Setup:**

- Create `CircuitBreakerRegistry` with Redis
- Execute multiple calls (mix of success and failure)

**Steps:**

1. Record 5 successes and 3 failures within the monitor window
2. Call `registry.llmProvider(tenant, 'openai').getMetrics()`
3. Verify: `{ state: 'CLOSED', failureCount: 3, successCount: 5, totalCount: 8, failureRate: 37 }`
4. Record enough failures to open the circuit
5. Call `getMetrics()` again
6. Verify: `{ state: 'OPEN', openedAt: <timestamp>, failureRate: >threshold }`

**Expected:**

- Metrics reflect windowed counters accurately
- `failureRate` calculation matches `floor(failures/total * 100)`

---

### INT-CB-6: TenantHealth Aggregation

**Covers:** FR-CB-8
**Priority:** P1

**Setup:**

- Create `CircuitBreakerRegistry` with Redis
- Create breakers at multiple levels for the same tenant

**Steps:**

1. Open the `llm_provider` circuit for `{tenantId}:openai`
2. Open the `tool_service` circuit for `{tenantId}:weather-api`
3. Keep the `tenant` level circuit CLOSED
4. Call `registry.getTenantHealth(tenantId)`
5. Verify: `hasOpenCircuits: true`, `llmProviders` array includes OpenAI as OPEN, `toolServices` includes weather-api as OPEN, `tenant` is CLOSED

**Expected:**

- Health aggregation scans all levels for a tenant
- `hasOpenCircuits` is true if any sub-level is open

---

### INT-CB-7: Concurrent Half-Open Probe Limiting

**Covers:** FR-CB-1
**Priority:** P1

**Setup:**

- `CircuitBreakerRegistry` with `halfOpenMaxConcurrent: 1` (default for `llm_provider`)
- Trip the circuit, wait for reset timeout

**Steps:**

1. Open the circuit
2. Wait for `resetTimeout`
3. Send 5 concurrent requests
4. Verify only 1 request is allowed through (half-open probe)
5. Verify the other 4 receive `CircuitOpenError`

**Expected:**

- `halfOpenMaxConcurrent` enforced via Redis atomic counter
- Only the configured number of probes pass through

---

## 4. Unit Test Scenarios (Existing Coverage)

The following unit test suites already exist and cover the core state machine logic:

| Suite                    | Location                                                               | Status            |
| ------------------------ | ---------------------------------------------------------------------- | ----------------- |
| `RedisCircuitBreaker`    | `packages/circuit-breaker/src/__tests__/redis-circuit-breaker.test.ts` | Existing, passing |
| `CircuitBreakerRegistry` | `packages/circuit-breaker/src/__tests__/registry.test.ts`              | Existing, passing |
| `GitCircuitBreaker`      | `packages/project-io/src/__tests__/git-circuit-breaker.test.ts`        | Existing, passing |
| `EvalCircuitBreakers`    | Inline in eval test files                                              | Existing, passing |
| `PipelineCircuitBreaker` | (needs creation)                                                       | Gap               |

**New unit tests needed:**

- `SessionLLMClient` circuit breaker wrapping logic
- HTTP tool executor circuit breaker wrapping logic
- MCP provider circuit breaker wrapping logic
- Circuit breaker health API route handler
- Admin force-reset API route handler

---

## 5. Coverage Matrix

| Functional Requirement          | E2E                          | Integration        | Unit     |
| ------------------------------- | ---------------------------- | ------------------ | -------- |
| FR-CB-1 (LLM circuit breaker)   | E2E-CB-1, E2E-CB-6, E2E-CB-7 | INT-CB-1           | New      |
| FR-CB-2 (HTTP tool CB)          | E2E-CB-3                     | INT-CB-2           | New      |
| FR-CB-3 (MCP CB)                | (future)                     | (future)           | New      |
| FR-CB-4 (SearchAI CB)           | (future)                     | (future)           | (future) |
| FR-CB-5 (LLM fallback)          | E2E-CB-2                     | INT-CB-1           | New      |
| FR-CB-6 (Tenant isolation)      | E2E-CB-1, E2E-CB-8           | INT-CB-1           | Existing |
| FR-CB-7 (Tool isolation)        | E2E-CB-3, E2E-CB-8           | INT-CB-2           | Existing |
| FR-CB-8 (Health API)            | E2E-CB-4                     | INT-CB-5, INT-CB-6 | New      |
| FR-CB-9 (Admin reset)           | E2E-CB-5                     | INT-CB-3           | New      |
| FR-CB-10 (TraceEvents)          | (verified via logs)          | INT-CB-3           | New      |
| FR-CB-11 (DSL config)           | (future)                     | INT-CB-2           | Existing |
| FR-CB-12 (Config overrides)     | (P2)                         | (P2)               | Existing |
| FR-CB-13 (Structured errors)    | E2E-CB-1, E2E-CB-3, E2E-CB-6 | INT-CB-1           | New      |
| FR-CB-14 (Consolidate pipeline) | (P2)                         | (P2)               | (P2)     |
| FR-CB-15 (Studio UI)            | (P2)                         | (P2)               | (P2)     |

---

## 6. Test Infrastructure Requirements

### E2E Tests

- **Express server:** Real runtime server started on port 0 (random)
- **Redis:** Real Redis or `ioredis-mock` for circuit state
- **External service mocks:** HTTP interceptors (e.g., `msw`, `nock`) for LLM provider and tool endpoint responses
- **Auth:** Real auth middleware with test JWT tokens
- **Tenant seeding:** Via POST API endpoints, not direct DB access
- **Cleanup:** After each test, force-reset all circuits via `registry.forceResetTenant()`

### Integration Tests

- **Redis:** `ioredis-mock` for deterministic state machine testing
- **No Express server needed** — direct class instantiation
- **Time control:** `vi.useFakeTimers()` for reset timeout testing in half-open scenarios

### What Must NOT Be Mocked

- Express middleware chain (auth, tenant isolation, validation)
- `CircuitBreakerRegistry` / `RedisCircuitBreaker` — these are the system under test
- `SessionLLMClient` integration with the registry — test the actual wiring
- Route handlers and their error response formatting

### What May Be Mocked

- LLM provider HTTP endpoints (external third-party)
- HTTP tool endpoints (external user-configured)
- MCP server connections (external user-configured)
- Redis connection (only for Redis-unavailability fallback test INT-CB-4)
