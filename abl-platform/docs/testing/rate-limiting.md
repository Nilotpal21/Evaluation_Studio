# Feature Test Guide: Rate Limiting

**Feature**: Runtime, SearchAI, Studio, connector, eval, and agent-transfer throttling controls
**Owner**: Platform team
**Branch**: develop
**Related Feature Doc**: [docs/features/rate-limiting.md](../features/rate-limiting.md)
**First audited**: 2026-03-21
**Last updated**: 2026-03-22
**Overall status**: PARTIAL

---

## Current State (as of 2026-03-22)

Rate limiting is one of the better-covered infrastructure features in the repo from a unit/integration perspective. Runtime has targeted tests for plan-aware limits, per-API-key sub-limits, session-message throttling, Redis-to-memory resilience behavior, and tenant-aware WebSocket connection buckets. SearchAI has a focused middleware suite covering 429 behavior, header population, per-tenant isolation, IP fallback, and in-memory pressure handling. Studio, connectors, and agent-transfer all have unit coverage for their local limiter implementations.

The main remaining gaps are at the production-behavior boundary. The checked-in suites do not prove the Runtime Redis Lua sliding-window path in a real Redis-backed deployment, do not prove SearchAI's Redis Lua path, do not include load/soak tests for sustained concurrency, and do not have dedicated eval-rate-limiter tests.

### Quick Health Dashboard

| Area                                  | Status     | Last Verified    | Notes                                                              |
| ------------------------------------- | ---------- | ---------------- | ------------------------------------------------------------------ |
| Runtime plan-aware limit resolution   | PASS       | checked-in tests | Covers FREE through ENTERPRISE mapping and unlimited `-1` handling |
| Runtime per-API-key sub-limits        | PASS       | checked-in tests | Verifies divisor/minimum logic and check ordering                  |
| Runtime session-message throttling    | PASS       | checked-in tests | Covers chat/SDK helper contract and 429-ready outputs              |
| Runtime Redis fallback/recovery logic | PASS       | checked-in tests | Covers in-memory cleanup and re-check behavior                     |
| Runtime WebSocket tenant+IP buckets   | PASS       | checked-in tests | Prevents tenant collisions behind shared NATs                      |
| SearchAI request throttling           | PASS       | checked-in tests | Covers 429s, headers, tenant isolation, window reset, IP fallback  |
| Studio limiter utilities              | PASS       | checked-in tests | Covers sliding-window logic, key scoping, and bounded eviction     |
| Studio Redis-backed helper            | PASS       | checked-in tests | Covers `checkRateLimit()` Redis+fallback behavior                  |
| Connector provider throttling         | PASS       | checked-in tests | Token-bucket algorithm covered at unit level                       |
| Agent transfer rate limiter           | PASS       | checked-in tests | Lua script behavior with Redis mock                                |
| Real Redis Runtime script path        | NOT TESTED | —                | No direct Redis-backed integration suite                           |
| Real Redis SearchAI script path       | NOT TESTED | —                | Current tests explicitly exercise fallback/in-memory path          |
| Eval rate limiter                     | NOT TESTED | —                | No dedicated test file exists                                      |
| Load and multi-pod behavior           | NOT TESTED | —                | No soak or concurrency benchmark suite checked in                  |

---

## Coverage Matrix

| FR   | Description                                                | Unit | Integration | E2E        | Manual | Status  |
| ---- | ---------------------------------------------------------- | ---- | ----------- | ---------- | ------ | ------- |
| FR-1 | Runtime per-tenant request budgets from plan config        | PASS | NOT TESTED  | NOT TESTED | N/A    | Partial |
| FR-2 | Per-API-key sub-limits checked before tenant counters      | PASS | NOT TESTED  | NOT TESTED | N/A    | Partial |
| FR-3 | Per-session message budgets (30/min default)               | PASS | NOT TESTED  | NOT TESTED | N/A    | Partial |
| FR-4 | Concurrent session caps + WebSocket flood protection       | PASS | NOT TESTED  | NOT TESTED | N/A    | Partial |
| FR-5 | Redis-primary with in-memory fallback + auto-recovery      | PASS | NOT TESTED  | NOT TESTED | N/A    | Partial |
| FR-6 | SearchAI, Studio, connector, eval, agent-transfer limiters | PASS | NOT TESTED  | NOT TESTED | N/A    | Partial |
| FR-7 | HTTP 429 with standard rate-limit headers                  | PASS | NOT TESTED  | NOT TESTED | N/A    | Partial |
| FR-8 | Unlimited (-1) plan values skip enforcement                | PASS | NOT TESTED  | NOT TESTED | N/A    | Partial |

---

## E2E Test Scenarios (minimum 5)

### E2E-1: Runtime per-tenant request throttling via real HTTP

**Preconditions**: Runtime server started on random port with real Redis connection. Tenant A and Tenant B created with different plan limits (e.g., Tenant A: 5 req/min, Tenant B: 10 req/min).

**Steps**:

1. POST `/api/v1/chat` with Tenant A auth headers — repeat 5 times (at limit).
2. POST `/api/v1/chat` with Tenant A auth headers — 6th request.
3. Assert 6th request returns HTTP 429 with `X-RateLimit-Limit: 5`, `X-RateLimit-Remaining: 0`, and `X-RateLimit-Reset` header.
4. Assert response body contains `{ error: 'Rate limit exceeded', operation: 'request', retryAfterMs: <number> }`.
5. POST `/api/v1/chat` with Tenant B auth headers — assert HTTP 200 (Tenant B has separate budget).

**Expected Result**: Tenant A is throttled at its plan limit. Tenant B is unaffected (tenant isolation proven). Rate-limit headers are populated correctly.

**Auth Context**: Tenant A = `tenantId: 'tenant-a'`, Tenant B = `tenantId: 'tenant-b'`. Both authenticated via `createUnifiedAuthMiddleware`.

**Isolation Check**: Tenant A's throttling must not affect Tenant B. Cross-tenant request with Tenant A's token to Tenant B's resources returns 404.

---

### E2E-2: Per-API-key sub-limit rejection before tenant quota consumption

**Preconditions**: Runtime server started on random port. Tenant created with 50 req/min plan limit. API key created for the tenant (per-key limit = 50/5 = 10).

**Steps**:

1. Send 10 requests to `/api/v1/agents` with `Authorization: Bearer <api-key>` — all should return 200.
2. Send 11th request with same API key — assert HTTP 429.
3. Assert response body contains `{ error: 'API key rate limit exceeded' }`.
4. Assert `X-RateLimit-Limit` header reflects per-key limit (10), not tenant limit (50).
5. Send request with a different API key for the same tenant — assert HTTP 200 (different key budget).

**Expected Result**: Per-key limit is enforced before tenant budget is consumed. Different keys have independent budgets. Rate-limit headers reflect the per-key limit.

**Auth Context**: `authType: 'api_key'`, `apiKeyId: 'key-1'`, `tenantId: 'tenant-1'`.

**Isolation Check**: Key-1's throttling does not affect Key-2 for the same tenant.

---

### E2E-3: Session message rate limiting via chat endpoint

**Preconditions**: Runtime server started on random port. Session created for a tenant. `SESSION_MESSAGE_RATE_LIMIT=5` (lowered for test speed).

**Steps**:

1. POST `/api/v1/chat/sessions/{sessionId}/messages` — repeat 5 times with valid message payloads.
2. POST 6th message to the same session.
3. Assert 6th message returns HTTP 429 or a rate-limit error response.
4. POST message to a different session for the same tenant — assert allowed (separate session budget).

**Expected Result**: Per-session message budget is enforced. Different sessions have independent budgets.

**Auth Context**: `tenantId: 'tenant-1'`, `sessionId: 'session-1'` and `sessionId: 'session-2'`.

**Isolation Check**: Session-1's throttling does not affect Session-2.

---

### E2E-4: SearchAI per-tenant fixed-window throttling

**Preconditions**: SearchAI server started on random port with real Redis. `SEARCH_AI_RATE_LIMIT=3` (lowered for test speed). Tenant A and Tenant B configured.

**Steps**:

1. GET `/api/search` with Tenant A auth headers — repeat 3 times.
2. GET `/api/search` with Tenant A 4th time — assert HTTP 429.
3. Assert `X-RateLimit-Limit: 3`, `X-RateLimit-Remaining: 0` headers present.
4. Assert response body: `{ error: 'Rate limit exceeded', operation: 'request', retryAfterMs: <number> }`.
5. GET `/api/search` with Tenant B auth headers — assert HTTP 200.

**Expected Result**: SearchAI enforces per-tenant fixed-window limits with standard 429 responses. Tenant isolation proven.

**Auth Context**: Tenant A = `tenantId: 'search-tenant-a'`, Tenant B = `tenantId: 'search-tenant-b'`.

**Isolation Check**: Tenant A throttling does not affect Tenant B.

---

### E2E-5: Runtime Redis-to-memory fallback and recovery

**Preconditions**: Runtime server started on random port. Redis initially available. Tenant configured with 10 req/min limit.

**Steps**:

1. Send 5 requests — all return 200 (Redis path).
2. Disconnect Redis (e.g., stop Redis container or simulate connection error).
3. Send 3 more requests — assert all return 200 (in-memory fallback, counter reset).
4. Assert structured log contains "Redis error, falling back to in-memory" or equivalent.
5. Reconnect Redis.
6. Wait for recovery interval (30s or use shorter test override).
7. Send request — assert it succeeds and distributed state is restored.

**Expected Result**: System degrades gracefully to in-memory enforcement. Logs fallback transition. Automatically recovers to Redis when available.

**Auth Context**: `tenantId: 'tenant-fallback'`.

**Isolation Check**: N/A (single-tenant scenario testing infrastructure resilience).

---

### E2E-6: Unlimited (-1) plan bypasses rate limiting

**Preconditions**: Runtime server started on random port. Tenant configured with `requestsPerMinute: -1` (unlimited).

**Steps**:

1. Send 200 requests to `/api/v1/agents` with tenant auth headers rapidly.
2. Assert all 200 return HTTP 200 (none rejected).
3. Verify `X-RateLimit-Limit` is NOT set or indicates unlimited.

**Expected Result**: Unlimited plan values bypass enforcement entirely. No 429 responses.

**Auth Context**: `tenantId: 'tenant-unlimited'`, plan: ENTERPRISE with unlimited requests.

**Isolation Check**: N/A (single-tenant unlimited scenario).

---

### E2E-7: Concurrent session cap enforcement

**Preconditions**: Runtime server started on random port. Tenant configured with `concurrentSessions: 3`.

**Steps**:

1. POST `/api/v1/sdk/init` to create session-1 — assert 200.
2. POST `/api/v1/sdk/init` to create session-2 — assert 200.
3. POST `/api/v1/sdk/init` to create session-3 — assert 200.
4. POST `/api/v1/sdk/init` to create session-4 — assert rejected (session cap exceeded).
5. Close session-1 (release slot).
6. POST `/api/v1/sdk/init` to create session-5 — assert 200 (slot freed).

**Expected Result**: Concurrent session cap is enforced atomically. Releasing a slot allows new sessions.

**Auth Context**: `tenantId: 'tenant-sessions'`.

**Isolation Check**: Different tenant's session count is independent.

---

## Integration Test Scenarios (minimum 5)

### INT-1: Redis Lua sliding-window atomicity under concurrent requests

**Boundary**: `RedisRateLimiter` + real Redis instance.

**Setup**: Real Redis container. `RedisRateLimiter` instance with limit = 10, windowMs = 60000.

**Steps**:

1. Fire 20 concurrent `check()` calls for the same tenant key.
2. Collect all results.
3. Assert exactly 10 results have `allowed: true` and 10 have `allowed: false`.
4. Assert Redis ZSET for the key has exactly 10 members.
5. Assert `remaining` values are monotonically decreasing across allowed results.

**Expected Result**: Lua script atomicity prevents race conditions. No over-admission.

**Failure Mode**: If Redis disconnects mid-batch, `HybridRateLimiter` falls back to memory and logs the transition.

---

### INT-2: SearchAI fixed-window Redis Lua INCR behavior

**Boundary**: SearchAI `redisCheck()` + real Redis instance.

**Setup**: Real Redis container. SearchAI rate-limit middleware configured with limit = 5, windowMs = 2000.

**Steps**:

1. Call `redisCheck()` 5 times for same key — all return `{ allowed: true }`.
2. Call 6th time — returns `{ allowed: false, remaining: 0 }`.
3. Wait 2.1 seconds (window expires).
4. Call again — returns `{ allowed: true, remaining: 4 }` (new window).
5. Verify Redis key has PTTL > 0 and PTTL <= 2000.

**Expected Result**: Fixed-window counter resets correctly after window expiry. PTTL is set atomically on first INCR.

**Failure Mode**: If key loses PTTL (orphaned), Lua script self-heals by re-applying PEXPIRE.

---

### INT-3: HybridRateLimiter Redis-to-memory fallback transition

**Boundary**: `HybridRateLimiter` + Redis instance (toggled).

**Setup**: Start with Redis available. Create `HybridRateLimiter` instance.

**Steps**:

1. Call `check()` — assert uses Redis path (`isUsingRedis()` returns true).
2. Disconnect Redis (close connection).
3. Call `check()` — assert falls back to memory. `isUsingRedis()` returns false.
4. Assert `recordRateLimiterFallback('redis_to_memory')` was called.
5. Reconnect Redis.
6. Wait for `REDIS_RECOVERY_INTERVAL_MS` (or trigger manually).
7. Assert `isUsingRedis()` returns true again.
8. Assert `recordRateLimiterFallback('memory_to_redis')` was called.

**Expected Result**: Seamless transition with observability signals.

**Failure Mode**: If recovery timer fails, system remains on in-memory with single-pod semantics.

---

### INT-4: Session slot claim/release atomicity with Redis SET

**Boundary**: `claimSessionSlot()` / `releaseSessionSlot()` + real Redis.

**Setup**: Real Redis container. Limit = 3 concurrent sessions.

**Steps**:

1. `claimSessionSlot('tenant-1', 'session-a', 3)` — returns 1 (count).
2. `claimSessionSlot('tenant-1', 'session-b', 3)` — returns 2.
3. `claimSessionSlot('tenant-1', 'session-c', 3)` — returns 3.
4. `claimSessionSlot('tenant-1', 'session-d', 3)` — returns -1 (at limit).
5. `releaseSessionSlot('tenant-1', 'session-a')` — returns 2.
6. `claimSessionSlot('tenant-1', 'session-d', 3)` — returns 3 (now allowed).
7. Assert Redis SCARD for `sessions:active:tenant-1` equals 3.

**Expected Result**: Atomic claim/release via Lua script. No race conditions.

**Failure Mode**: If Redis is unavailable, falls back to `memoryClaim()`/`memoryRelease()` with bounded Map.

---

### INT-5: Eval rate limiter tier-based enforcement

**Boundary**: `eval-rate-limiter` module (in-memory, no Redis).

**Setup**: Import eval rate limiter functions directly.

**Steps**:

1. `acquireRunSlot('tenant-free', 'free')` — returns true. Repeat — returns false (free tier: maxConcurrentRuns = 1).
2. `releaseRunSlot('tenant-free')` — frees slot.
3. `acquireRunSlot('tenant-enterprise', 'enterprise')` — repeat 5 times, all true. 6th returns false (enterprise: maxConcurrentRuns = 5).
4. Call `checkLLMRateLimit('tenant-free', 'free')` 10 times — all true. 11th returns false (free: 10 LLM calls/min).
5. Call `getTenantEvalUsage('tenant-free', 'free')` — assert `current.runs` and `current.llmCallsPerMinute` match expected values.

**Expected Result**: Tier limits are enforced per-tenant. Usage snapshots are accurate.

**Failure Mode**: If `tenantCounters` Map exceeds 1000 entries, oldest idle tenant is evicted.

---

### INT-6: Connector token-bucket pacing under burst

**Boundary**: `RateLimiter` class from `packages/connectors/base`.

**Setup**: Create `new RateLimiter(5, 2)` (5 max tokens, 2 refill/sec).

**Steps**:

1. `tryAcquire(1)` — 5 times in quick succession. All return true.
2. `tryAcquire(1)` — returns false (bucket empty).
3. `getAvailableTokens()` — returns 0.
4. Wait 1 second.
5. `getAvailableTokens()` — returns approximately 2 (refilled at 2/sec).
6. `acquire(3)` — resolves after waiting ~0.5s for remaining token.

**Expected Result**: Token bucket enforces burst limits and smoothly refills.

**Failure Mode**: N/A (in-memory, single-process).

---

### INT-7: Agent-transfer rate limiter conditional ZADD

**Boundary**: `checkRateLimit()` from `packages/agent-transfer/src/security/rate-limiter.ts` + real Redis.

**Setup**: Real Redis container. Config: `{ maxTransfers: 3, windowMs: 2000 }`.

**Steps**:

1. Call `checkRateLimit(redis, 'tenant-1', config)` 3 times — all return `{ allowed: true }`.
2. Call 4th time — returns `{ allowed: false, remaining: 0 }`.
3. Verify Redis ZSET for `at_ratelimit:tenant-1` has exactly 3 members (conditional ZADD prevents rejected requests from inflating the set).
4. Wait 2.1 seconds (window expires).
5. Call again — returns `{ allowed: true }` (window reset).

**Expected Result**: Conditional ZADD prevents memory amplification. Window resets correctly.

**Failure Mode**: Redis unavailable results in connection error (no in-memory fallback).

---

## Unit Test Scenarios

### UNIT-1: InMemoryRateLimiter bounded eviction

**Module**: `InMemoryRateLimiter` from `apps/runtime/src/middleware/rate-limiter.ts`.

**Input**: Create with `maxEntries: 3`. Add entries for keys A, B, C (at capacity). Add key D.

**Expected Output**: One of the expired entries (or oldest) is evicted. Key D is tracked. `windows.size` stays at 3.

---

### UNIT-2: Plan-to-limit mapping with unlimited values

**Module**: `getTenantRateLimits()`.

**Input**: Mock `TenantConfigService` returning `{ limits: { requestsPerMinute: -1, tokensPerMinute: -1, maxConcurrentSessions: -1, toolCallsPerMinute: -1 } }`.

**Expected Output**: Returns config with `-1` values. Downstream `tenantRateLimit()` skips enforcement when limit is `-1`.

---

### UNIT-3: Studio buildRateLimitKey scope variants

**Module**: `buildRateLimitKey()` from `apps/studio/src/lib/rate-limiter.ts`.

**Input**: scope=TENANT, tenantId='t1', userId='u1', ip='1.2.3.4', routePath='/api/auth'.

**Expected Output**: `rl:/api/auth:t:t1` (tenant scope ignores userId and IP). For USER scope: `rl:/api/auth:u:t1:u1`. For IP scope: `rl:/api/auth:ip:1.2.3.4`.

---

### UNIT-4: WSConnectionRateLimiter tenant+IP composite keys

**Module**: `WSConnectionRateLimiter` from `apps/runtime/src/websocket/sdk-handler.ts`.

**Input**: Tenant 'A' from IP '1.2.3.4' — 60 connection attempts in one minute (default limit).

**Expected Output**: First N attempts allowed (up to `WS_CONN_RATE_LIMIT_PER_IP`), remaining rejected. Tenant 'B' from same IP has independent bucket.

---

## Security & Isolation Tests

- [x] Cross-tenant rate-limit isolation: Tenant A at capacity does not affect Tenant B (E2E-1, E2E-4)
- [x] Cross-API-key isolation: Key-1 at limit does not block Key-2 for same tenant (E2E-2)
- [x] Cross-session isolation: Session-1 at message limit does not block Session-2 (E2E-3)
- [ ] Missing auth returns 401 before rate-limit middleware runs (auth middleware runs first)
- [ ] Insufficient permissions returns 403 (rate limiting applies after auth)
- [x] Input validation: malformed tenantId falls back to IP-based limiting (existing unit test)
- [ ] Redis key namespace isolation: verify no key collisions between services (search-ai:rl: vs rl: vs at_ratelimit:)

---

## Performance & Load Tests

- [ ] **LOAD-1**: 1000 concurrent requests from 10 tenants — verify fair distribution and no tenant starvation
- [ ] **LOAD-2**: Redis-backed sliding window under sustained 10k req/sec — verify Lua script latency stays under 1ms p99
- [ ] **LOAD-3**: In-memory fallback under 50k+ entries — verify cleanup interval keeps Map size bounded
- [ ] **LOAD-4**: Multi-pod fairness — 3 Runtime pods sharing Redis, verify aggregate limit is enforced (not 3x limit)

---

## Test Infrastructure

- **Required services**: Redis (for integration/E2E tests). Docker Compose or testcontainers.
- **Data seeding**: Create tenants with specific plan limits via Runtime API or test fixtures.
- **Environment variables**: `RATE_LIMITER_MAX_ENTRIES`, `SESSION_MESSAGE_RATE_LIMIT`, `SEARCH_AI_RATE_LIMIT` (lowered for test speed).
- **CI configuration**: Integration tests with Redis require Docker in CI. E2E tests start real servers on random ports.

---

## Test File Mapping

| Test File                                                                    | Type       | Covers           |
| ---------------------------------------------------------------------------- | ---------- | ---------------- |
| `apps/runtime/src/__tests__/middleware/rate-limiter.test.ts`                 | unit       | FR-1, FR-7       |
| `apps/runtime/src/__tests__/middleware-rate-limiter.test.ts`                 | unit       | FR-1, FR-7       |
| `apps/runtime/src/__tests__/rate-limiter-plan-aware.test.ts`                 | unit       | FR-1, FR-8       |
| `apps/runtime/src/__tests__/rate-limiter-per-api-key.test.ts`                | unit       | FR-2             |
| `apps/runtime/src/__tests__/rate-limiter-session-message.test.ts`            | unit       | FR-3             |
| `apps/runtime/src/__tests__/rate-limiter-resilience-fixes.test.ts`           | unit       | FR-5             |
| `apps/runtime/src/__tests__/ws-tenant-rate-limit.test.ts`                    | unit       | FR-4             |
| `apps/search-ai/src/__tests__/rate-limit-middleware.test.ts`                 | unit/integ | FR-6, FR-7       |
| `apps/studio/src/__tests__/rate-limiter.test.ts`                             | unit       | FR-6             |
| `apps/studio/src/lib/__tests__/rate-limit.test.ts`                           | unit       | FR-6             |
| `packages/connectors/base/src/__tests__/rate-limiter.test.ts`                | unit       | FR-6             |
| `packages/agent-transfer/src/__tests__/unit/rate-limiter.test.ts`            | unit       | FR-6             |
| `apps/runtime/src/__tests__/e2e/rate-limiter-redis.test.ts` (PLANNED)        | e2e        | FR-1, FR-5, FR-7 |
| `apps/search-ai/src/__tests__/e2e/rate-limit-redis.test.ts` (PLANNED)        | e2e        | FR-6, FR-7       |
| `packages/pipeline-engine/src/__tests__/eval-rate-limiter.test.ts` (PLANNED) | unit       | FR-6             |

---

## Open Testing Questions

1. Should Redis integration tests use testcontainers or a shared Docker Compose Redis instance in CI?
2. Should load/soak tests be in-repo or in a separate performance-testing harness?
3. What is the minimum Redis version required for the Lua scripts (EVALSHA, ZREMRANGEBYSCORE)?
4. Should multi-pod fairness tests be automated or remain as manual verification?

---

## Test Coverage Map

### Runtime

- [x] FREE / TEAM / BUSINESS / ENTERPRISE plans map to the correct Runtime budgets
- [x] Unlimited `-1` limits skip enforcement where expected
- [x] Per-API-key request limits are applied before tenant request limits
- [x] Per-key limits never drop below the configured minimum (10)
- [x] Session-message budgets are scoped to individual session IDs
- [x] WebSocket connection buckets are isolated by tenant+IP
- [x] In-memory Runtime limiter cleanup and peek semantics are exercised
- [ ] Redis Lua sliding-window behavior directly tested with real Redis instance
- [ ] Multi-pod rate-limit state convergence under concurrent traffic

### SearchAI

- [x] Default and custom request limits are enforced
- [x] 429 responses include rate-limit headers
- [x] Different tenants have independent buckets
- [x] IP fallback works when no tenant context is present
- [ ] Redis Lua fixed-window behavior directly tested with real Redis instance
- [ ] Orphaned key self-healing (PTTL === -1) tested with real Redis

### Studio / Connectors / Evals / Agent Transfer

- [x] Studio sliding-window utility enforces limits and bounded eviction
- [x] Studio Redis-backed helper `checkRateLimit()` works with fallback
- [x] Connector token-bucket pacing refills and blocks correctly
- [x] Agent transfer Lua script conditional ZADD behavior
- [ ] Eval rate limiter has dedicated tests of its own
- [ ] Studio key namespace collision prevention verified

### What the Current Coverage Actually Proves

- [x] The main Runtime throttling rules are enforced at helper/middleware level
- [x] SearchAI and Studio both have non-trivial local throttling coverage
- [x] Connector provider pacing is implemented and unit-tested
- [x] Agent transfer rate limiter Lua script behaves correctly
- [ ] Shared production behavior with real Redis and real concurrent service traffic is proven end-to-end
- [ ] Eval rate limiter correctness is directly verified

---

## Pending / Future Work

- [ ] Add Runtime Redis-backed E2E tests for `RedisRateLimiter` Lua sliding-window path
- [ ] Add SearchAI Redis-backed E2E tests for the Lua fixed-window limiter
- [ ] Add dedicated unit tests for `eval-rate-limiter.ts`
- [ ] Add load/concurrency tests for Runtime and SearchAI throttled routes
- [ ] Add multi-pod fairness validation tests
- [ ] Add Redis key namespace collision tests across services
- [ ] Add agent-transfer integration tests with real Redis

---

## References

- Related feature doc: [docs/features/rate-limiting.md](../features/rate-limiting.md)
- Prior audit: `docs/archive/plans-2026-02/2026-02-25-rate-limits-circuit-breakers-audit.md`
