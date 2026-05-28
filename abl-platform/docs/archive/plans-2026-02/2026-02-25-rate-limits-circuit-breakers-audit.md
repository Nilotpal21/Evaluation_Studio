# Rate Limits & Circuit Breakers — Full Platform Audit

**Date:** 2026-02-25
**Scope:** All apps (`runtime`, `studio`, `search-ai`, `multimodal-service`), all packages (`circuit-breaker`, `compiler`, `database`, `shared`, `config`)
**Dimensions:** Client, Tenant, Component, Integration, Subsystem

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Rate Limiting — What's Implemented](#2-rate-limiting--whats-implemented)
   - 2.1 Runtime Tenant Rate Limiting (Distributed)
   - 2.2 Plan-Based Limits
   - 2.3 Session Counting & Quota
   - 2.4 Token Usage Tracking
   - 2.5 Route-Level Rate Limiting
   - 2.6 Studio Auth Rate Limiting
   - 2.7 WebSocket Connection Rate Limiting
   - 2.8 Multimodal Upload Rate Limiting
   - 2.9 Tool Execution Limits
   - 2.10 HTTP Tool Execution Safeguards
   - 2.11 LLM Queue Concurrency
   - 2.12 Payload Size Limits
3. [Circuit Breakers — What's Implemented](#3-circuit-breakers--whats-implemented)
   - 3.1 Distributed Redis Circuit Breaker
   - 3.2 Hybrid Circuit Breaker Registry
   - 3.3 In-Process Circuit Breaker
   - 3.4 KMS Circuit Breaker
   - 3.5 Tool-Level Circuit Breakers
4. [Resilience Patterns — What's Implemented](#4-resilience-patterns--whats-implemented)
   - 4.1 Redis Fallback Chain
   - 4.2 Retry Logic
   - 4.3 Bulkhead / Isolation (Semaphore)
   - 4.4 Health Checks
   - 4.5 Graceful Degradation
   - 4.6 Connection Pooling
5. [Timeout Matrix](#5-timeout-matrix)
6. [Numeric Reference Tables](#6-numeric-reference-tables)
7. [Gaps & Recommendations](#7-gaps--recommendations)
8. [Coverage Matrix](#8-coverage-matrix)

---

## 1. Executive Summary

The platform has **strong distributed rate limiting** with Redis primary + in-memory fallback, **plan-aware tenant limits**, and a **mature circuit breaker infrastructure** with Lua-script-based atomic state transitions. Key strengths:

- Atomic session counting via Redis Lua scripts (TOCTOU-safe)
- Sliding-window rate limiting with sorted sets
- Plan-based limits (FREE → TEAM → BUSINESS → ENTERPRISE) across 15+ dimensions
- Auto-recovery from Redis failures (30s polling)
- SSRF protection on all outbound HTTP tool calls

Key gaps:

- **No per-API-key rate limiting** — all keys from same tenant share limits
- **No per-session message rate limiting** — unlimited messages within a session
- **Studio auth rate limiting is in-memory only** — not distributed
- **WebSocket rate limiting is IP-based, not tenant-based** — shared across tenants
- **Search-AI has no request rate limiting** — endpoints unprotected
- **Multimodal upload rate limiter is implemented but not wired into routes**
- **No circuit breaker on service-to-service calls** (Search-AI, Multimodal)
- **No active ClickHouse health probe** — static flag only
- **No HTTP keep-alive on tool executor** — connection churn per call

---

## 2. Rate Limiting — What's Implemented

### 2.1 Runtime Tenant Rate Limiting (Distributed)

**Files:**

- `apps/runtime/src/middleware/rate-limiter.ts` (main middleware)
- `apps/runtime/src/services/resilience/hybrid-rate-limiter.ts` (Redis + memory)
- `apps/runtime/src/services/resilience/redis-rate-limiter.ts` (Redis sliding window)

**Architecture:** HybridRateLimiter → Redis primary (sorted set sliding window via Lua) + InMemoryRateLimiter fallback

**Default Limits** (`rate-limiter.ts:42-47`):

```
requestsPerMinute:  100
tokensPerMinute:    100,000
concurrentSessions: 50
toolCallsPerMinute: 200
```

**Redis Sliding Window** (`redis-rate-limiter.ts:15-52`):

- Mechanism: Redis ZSET with timestamp scores
- Lua script atomically: removes expired entries → counts current → enforces limit → adds new entry
- TTL: `windowMs + 10 seconds`
- SHA caching for EVALSHA performance optimization

**In-Memory Fallback** (`rate-limiter.ts:91-174`):

- Max entries: 50,000
- Cleanup interval: 5 minutes
- Grace period: 2 minutes post-window-expiry before deletion
- Key pattern: `{tenantId}:{operation}`

**Middleware Behavior** (`rate-limiter.ts:187-265`):

- Resolves plan limits from TenantConfigService (Redis cache → DB → plan defaults)
- Falls back to DEFAULT_LIMITS on load failure
- Uses tenant ID as key prefix; falls back to IP if no tenant context
- Returns HTTP 429 with headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`
- Unlimited plans (`-1`) bypass rate limiting entirely

**Auto-Recovery** (`hybrid-rate-limiter.ts:88-101`):

- Polls `isRedisAvailable()` every 30 seconds
- Swaps back to Redis store on recovery

---

### 2.2 Plan-Based Limits

**File:** `apps/runtime/src/services/tenant-config.ts:90-160`

| Dimension           | FREE   | TEAM    | BUSINESS | ENTERPRISE     |
| ------------------- | ------ | ------- | -------- | -------------- |
| Requests/min        | 60     | 300     | 1,000    | 5,000          |
| Tokens/min          | 50,000 | 200,000 | 500,000  | Unlimited (-1) |
| Concurrent sessions | 5      | 50      | 500      | Unlimited (-1) |
| Timeout (ms)        | 10,000 | 30,000  | 45,000   | 60,000         |
| Response bytes      | 512 KB | 2 MB    | 5 MB     | 10 MB          |
| Service calls       | 3      | 10      | 25       | 50             |
| Timers              | 100    | 1,000   | 10,000   | 100,000        |
| Agents/project      | 3      | 20      | 100      | Unlimited (-1) |
| Messages/month      | 1,000  | 50,000  | 500,000  | Unlimited (-1) |
| Trace retention     | 7d     | 30d     | 90d      | 365d           |
| Session retention   | 7d     | 30d     | 90d      | 365d           |

**Note:** `toolCallsPerMinute` is **always 200** (platform default, `rate-limiter.ts:72-73`) — not plan-based.

---

### 2.3 Session Counting & Quota

**File:** `apps/runtime/src/middleware/rate-limiter.ts:315-448`

**Redis Implementation (Atomic Lua Scripts):**

- `LUA_CHECK_AND_INCR` (`rate-limiter.ts:329-340`): Checks against limit (-1 = unlimited), increments, sets TTL
- `LUA_SAFE_DECR` (`rate-limiter.ts:346-352`): Decrements, never below 0
- Key prefix: `sessions:active:{tenantId}`
- TTL: 86,400 seconds (24 hours) — safety net for pod crash counter drift

**In-Memory Fallback** (`rate-limiter.ts:355-448`):

- Map: `memorySessionCounts<tenantId, count>`
- Max entries: 10,000
- FIFO eviction when map exceeds max

**Functions:**
| Function | Purpose | Location |
|----------|---------|----------|
| `incrementSessionCount(tenantId, limit)` | Atomic check-and-increment | :386-411 |
| `decrementSessionCount(tenantId)` | Atomic decrement (floor 0) | :413-432 |
| `getSessionCount(tenantId)` | Read current count | :434-448 |
| `canStartSession(tenantId, projectId?)` | Gate: is tenant under limit? | :303-313 |

---

### 2.4 Token Usage Tracking

**Function:** `recordTokenUsage(tenantId, tokenCount, projectId?)` (`rate-limiter.ts:272-296`)

- Loads plan limits via `getTenantRateLimits()`
- If `tokensPerMinute === -1` (unlimited): returns `{ allowed: true, remaining: Infinity }` without checking
- Otherwise: calls `limiter.check()` with 60,000ms window and `increment = tokenCount`
- Used in: `apps/runtime/src/services/runtime-executor.ts:1069` (post-LLM-call)

---

### 2.5 Route-Level Rate Limiting

**All runtime routes use `router.use(tenantRateLimit('request'))`:**

| Route File                           | Middleware Applied           |
| ------------------------------------ | ---------------------------- |
| `routes/sessions.ts`                 | `tenantRateLimit('request')` |
| `routes/chat.ts`                     | `tenantRateLimit('request')` |
| `routes/project-agents.ts`           | `tenantRateLimit('request')` |
| `routes/contacts.ts`                 | `tenantRateLimit('request')` |
| `routes/workflows.ts`                | `tenantRateLimit('request')` |
| `routes/deployments.ts`              | `tenantRateLimit('request')` |
| `routes/channels.ts`                 | `tenantRateLimit('request')` |
| `routes/channel-connections.ts`      | `tenantRateLimit('request')` |
| `routes/attachments.ts`              | `tenantRateLimit('request')` |
| `routes/versions.ts`                 | `tenantRateLimit('request')` |
| `routes/tenant-models.ts`            | `tenantRateLimit('request')` |
| `routes/agent-model-config.ts`       | `tenantRateLimit('request')` |
| `routes/tenant-service-instances.ts` | `tenantRateLimit('request')` |
| `routes/kms-admin.ts`                | `tenantRateLimit('request')` |
| `routes/environment-variables.ts`    | `tenantRateLimit('request')` |
| `routes/tool-secrets.ts`             | `tenantRateLimit('request')` |
| `routes/sdk-channels.ts`             | `tenantRateLimit('request')` |
| `routes/proxy-config.ts`             | `tenantRateLimit('request')` |
| `routes/livekit.ts`                  | `tenantRateLimit('request')` |
| `routes/voice.ts`                    | `tenantRateLimit('request')` |
| `routes/model-catalog.ts`            | `tenantRateLimit('request')` |
| `routes/http-async-channel.ts`       | `tenantRateLimit('request')` |
| `routes/platform-admin-config.ts`    | `tenantRateLimit('request')` |
| `routes/platform-admin-models.ts`    | `tenantRateLimit('request')` |
| `routes/agents.ts`                   | `tenantRateLimit('request')` |

**Per-Route Overrides:**

| Route                    | Override                    | File              |
| ------------------------ | --------------------------- | ----------------- |
| `POST /api/sdk/init`     | `{ requestsPerMinute: 30 }` | `sdk-init.ts:115` |
| `POST /api/sdk/identify` | `{ requestsPerMinute: 20 }` | `sdk-init.ts:323` |

---

### 2.6 Studio Auth Rate Limiting

**File:** `apps/studio/src/lib/rate-limit.ts`

**Implementation:** Simple in-memory Map (NOT distributed)

```typescript
const attempts = new Map<string, { count: number; resetAt: number }>();
```

| Auth Endpoint                      | Key Pattern                 | Max Attempts | Window |
| ---------------------------------- | --------------------------- | ------------ | ------ |
| POST /api/auth/login               | `login:{ip}`                | 10           | 15 min |
| POST /api/auth/signup              | `signup:{ip}`               | 5            | 15 min |
| POST /api/auth/forgot-password     | `forgot-password:{email}`   | 3            | 15 min |
| POST /api/auth/verify-email        | `verify-email:{ip}`         | 10           | 15 min |
| POST /api/auth/resend-verification | `resend-verification:{ip}`  | 3            | 15 min |
| POST /api/auth/reset-password      | `reset-password:{ip}`       | 5            | 15 min |
| POST /api/auth/create-workspace    | `create-workspace:{userId}` | 5            | 1 hour |
| POST /api/auth/device/token        | `device-token:{ip}`         | 12           | 1 min  |
| POST /api/auth/refresh             | `refresh:{ip}`              | 30           | 1 min  |
| POST /api/mfa/recovery             | `mfa-recovery:{ip}`         | 5            | 15 min |
| GET /api/sso/domains               | `sso-domains:{userId}`      | 10           | 1 hour |

**Limitation:** In-memory only — limits are per-pod, not shared across instances.

---

### 2.7 WebSocket Connection Rate Limiting

**File:** `apps/runtime/src/websocket/sdk-handler.ts:539-569`

| Parameter                         | Value          |
| --------------------------------- | -------------- |
| Max connections per IP per minute | 30             |
| Window                            | 60,000ms       |
| Key                               | IP address     |
| Cleanup interval                  | 2 minutes      |
| Backend                           | In-memory only |

**Close code on limit exceeded:** `4029` ("Too many connections — try again later")

**Limitations:**

- IP-based, not tenant-based — shared across all tenants on same IP
- Not distributed — only works per-pod

---

### 2.8 Multimodal Upload Rate Limiting

**File:** `apps/multimodal-service/src/security/upload-rate-limiter.ts`

| Parameter              | Value                          |
| ---------------------- | ------------------------------ |
| Max uploads per window | 50                             |
| Window                 | 60 seconds                     |
| Key prefix             | `upload-rate:{tenantId}`       |
| Backend                | Redis primary, memory fallback |
| Library                | `rate-limiter-flexible`        |

**Status:** Class is implemented but **NOT wired into routes** — `routes/attachments.ts` does not call `consume()`.

---

### 2.9 Tool Execution Limits

**File:** `apps/runtime/src/services/execution/reasoning-executor.ts`

| Parameter                       | Default | Override Source                            | Line               |
| ------------------------------- | ------- | ------------------------------------------ | ------------------ |
| Max tool iterations             | 10      | `session.agentIR.execution.max_iterations` | :64                |
| Max consecutive empty responses | 2       | Hardcoded                                  | :67                |
| Max tool calls/min (tenant)     | 200     | Platform default (not plan-based)          | rate-limiter.ts:46 |

**Loop breaks on:** max iterations reached, LLM final response, system tool (handoff/complete/escalate), 2 consecutive empty responses.

---

### 2.10 HTTP Tool Execution Safeguards

**File:** `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts`

| Parameter                  | Value     | Line |
| -------------------------- | --------- | ---- |
| Default timeout            | 30,000ms  | :213 |
| Max retry cap              | 10        | :39  |
| Max response bytes         | 10 MB     | :33  |
| Max error body length      | 256 chars | :36  |
| Max redirect hops          | 5         | :45  |
| Max resilience map entries | 2,000     | :42  |

**Per-Tool Rate Limiting** (`:247-254`): Reads `binding.rate_limit_per_minute` from IR; acquires rate limiter slot before execution.

**SSRF Protection** (`:51-67`): Blocks private IP ranges (RFC 1918), loopback, link-local, cloud metadata endpoints, decimal/octal IP encoding, `@` userinfo in URLs. Enforces http/https only.

---

### 2.11 LLM Queue Concurrency

**File:** `apps/runtime/src/config/index.ts:59-64`

| Parameter              | Value    | Env Var                            |
| ---------------------- | -------- | ---------------------------------- |
| Enabled                | true     | `LLM_QUEUE_ENABLED`                |
| Concurrency            | 10       | `LLM_QUEUE_CONCURRENCY`            |
| Backpressure threshold | 100      | `LLM_QUEUE_BACKPRESSURE_THRESHOLD` |
| Job timeout            | 60,000ms | `LLM_QUEUE_JOB_TIMEOUT_MS`         |

**Backpressure:** Throws `BackpressureError` when queue depth > 100 (`llm-queue.ts:296-301`).

**Per-Session FIFO:** Spin-wait lock with exponential backoff (50ms → 100ms → 200ms → 400ms, cap 500ms) ensures same-session serial execution.

---

### 2.12 Payload Size Limits

| App                | JSON Body Limit | File:Line       |
| ------------------ | --------------- | --------------- |
| Runtime            | 1 MB            | `server.ts:134` |
| Search-AI          | 50 MB           | `server.ts:76`  |
| Multimodal Service | 50 MB           | `server.ts:71`  |

| Resource                          | Limit | File:Line                  |
| --------------------------------- | ----- | -------------------------- |
| Runtime attachment upload         | 20 MB | `routes/attachments.ts:30` |
| Multimodal multer upload          | 50 MB | `routes/attachments.ts:27` |
| Max multimodal file size (config) | 50 MB | `config.ts:44`             |
| Max multimodal concurrent jobs    | 5     | `config.ts:54`             |

---

## 3. Circuit Breakers — What's Implemented

### 3.1 Distributed Redis Circuit Breaker

**File:** `packages/circuit-breaker/src/redis-circuit-breaker.ts`

**State Machine:** CLOSED → OPEN (on threshold) → HALF_OPEN (after reset timeout) → CLOSED (on probe success)

**Implementation:** Lua-script-based atomic state transitions shared across all pods. Scripts: `check-state.lua`, `record-failure.lua`, `record-success.lua`, `force-reset.lua`.

**Default Thresholds by Level** (`packages/circuit-breaker/src/types.ts:36-73`):

| Level            | Failure Threshold | Success Threshold | Reset Timeout | Monitor Window | Max Concurrent (Half-Open) | Failure Rate % | Min Requests |
| ---------------- | ----------------- | ----------------- | ------------- | -------------- | -------------------------- | -------------- | ------------ |
| **tenant**       | 50                | 5                 | 30,000ms      | 60,000ms       | 3                          | 50%            | 20           |
| **app**          | 20                | 3                 | 15,000ms      | 30,000ms       | 2                          | 40%            | 10           |
| **llm_provider** | 10                | 2                 | 60,000ms      | 30,000ms       | 1                          | 30%            | 5            |
| **tool_service** | 10                | 2                 | 30,000ms      | 30,000ms       | 1                          | 40%            | 5            |

**Features:** Sliding window failure counting, concurrent request limiting in HALF_OPEN, manual `forceReset()`, event listeners for state changes.

---

### 3.2 Hybrid Circuit Breaker Registry (Runtime)

**File:** `apps/runtime/src/services/resilience/hybrid-cb-registry.ts`

**Architecture:** Redis primary + in-memory fallback with 30-second auto-recovery polling.

**Plan-Aware Overrides** (`apps/runtime/src/services/resilience/tenant-cb-config.ts:12-37`):

| Plan       | Failure Threshold | Success Threshold | Reset Timeout | Monitor Window |
| ---------- | ----------------- | ----------------- | ------------- | -------------- |
| FREE       | 15                | 3                 | 60,000ms      | 120,000ms      |
| TEAM       | 25                | 3                 | 45,000ms      | 90,000ms       |
| BUSINESS   | 35                | 3                 | 30,000ms      | 60,000ms       |
| ENTERPRISE | 50                | 5                 | 30,000ms      | 60,000ms       |

Loads tenant-specific thresholds via `TenantConfigService`. Reports OTEL metrics on state transitions. Singleton with graceful shutdown.

---

### 3.3 In-Process Circuit Breaker

**File:** `apps/runtime/src/services/resilience/circuit-breaker.ts`

Simple, single-pod breaker for development/non-distributed scenarios:

| Parameter         | Value    | Line |
| ----------------- | -------- | ---- |
| Failure threshold | 5        | :64  |
| Success threshold | 3        | :65  |
| Reset timeout     | 30,000ms | :66  |
| Monitor window    | 60,000ms | :67  |

---

### 3.4 KMS Circuit Breaker

**File:** `apps/runtime/src/services/kms/kms-circuit-breaker.ts`

- Key format: `kms:{providerType}:{tenantId}`
- Wraps KMS provider calls with HybridCircuitBreakerRegistry
- Uses tenant context for plan-based thresholds
- Fail-fast on OPEN state

---

### 3.5 Tool-Level Circuit Breakers

**File:** `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts`

- Per-tool circuit breaker via `ToolResilienceFactory`
- Token bucket rate limiter per tool (`tool-resilience-factory.ts:16-51`)
- Returns `TOOL_CIRCUIT_OPEN` when breaker is open
- Resilience map capped at 2,000 entries

---

## 4. Resilience Patterns — What's Implemented

### 4.1 Redis Fallback Chain

When Redis is down, each subsystem falls back independently:

| Subsystem          | Fallback Behavior                       | Recovery    |
| ------------------ | --------------------------------------- | ----------- |
| Rate Limiter       | In-memory sliding windows (50K entries) | 30s polling |
| Circuit Breaker    | In-memory store                         | 30s polling |
| Session Counting   | In-memory Map (10K entries)             | 30s polling |
| LLM Queue (BullMQ) | Local SessionQueue + Semaphore          | 30s polling |

All systems auto-recover when Redis comes back online.

---

### 4.2 Retry Logic

**MongoDB Retry Helper** (`packages/database/src/mongo/helpers/retry.ts:32-44`):

| Parameter   | Value                                             |
| ----------- | ------------------------------------------------- |
| Max retries | 3                                                 |
| Base delay  | 100ms                                             |
| Max delay   | 5,000ms                                           |
| Jitter      | 0.5–1.0x random multiplier                        |
| Backoff     | Exponential (100ms → 200ms → 400ms, capped at 5s) |

Retryable errors: DuplicateKey, WriteConflict, NoWritesPerformed, network timeouts, connection refused.

**LLM Queue Lock Retry** (`apps/runtime/src/services/llm/llm-queue.ts:115-129`):

- Backoff: 50ms → 100ms → 200ms → 400ms (cap 500ms)
- Timeout: respects `config.jobTimeoutMs` (60s default)

**Client-Side (SWR)** (`apps/studio/src/lib/swr-config.ts:35-42`):

- Error retry count: 2
- Deduping interval: 5,000ms
- Revalidate on focus and reconnect: true

---

### 4.3 Bulkhead / Isolation (Semaphore)

**Local Semaphore** (`apps/runtime/src/services/llm/local-semaphore.ts`):

- Default concurrency: 10 permits
- Waiters queue with FIFO ordering
- Per-session serialization: tasks for same session execute sequentially

**BullMQ Worker** (`apps/runtime/src/services/llm/llm-queue.ts`):

- Concurrency: 10 (configurable via env)
- Job removal policy: keep last 1,000 completed, last 500 failed
- Per-session lock prevents parallel execution for same session

---

### 4.4 Health Checks

**Main Health** (`apps/runtime/src/server.ts`, `GET /health`):

| Check          | Method                                  | Metrics Returned                       |
| -------------- | --------------------------------------- | -------------------------------------- |
| MongoDB        | `admin.ping()` + `admin.serverStatus()` | ok, state, latencyMs, replicaSet, host |
| Redis          | `isRedisAvailable()` ping               | available boolean                      |
| ClickHouse     | Static `clickhouseReady` flag           | ready boolean                          |
| LiveKit        | `isLiveKitWorkerRunning()`              | running boolean                        |
| Channel Queues | Initialization status                   | inbound/delivery status                |
| Memory         | `process.memoryUsage()`                 | rss, heapUsed, heapTotal (MB)          |

**Readiness** (`GET /health/ready`):

- Fails if heap used > 85% of heap limit
- Requires Redis available
- Requires MongoDB connected

---

### 4.5 Graceful Degradation

| Failure           | Behavior                                                          | Impact                                          |
| ----------------- | ----------------------------------------------------------------- | ----------------------------------------------- |
| Redis down        | Rate limiter, circuit breaker, session counting fall to in-memory | Limits per-pod only; drift possible             |
| MongoDB down      | Routes return 503; health reports degraded                        | No session persistence                          |
| LLM provider down | Circuit breaker opens at 10 failures; 60s reset                   | Fail-fast for 60s                               |
| KMS down          | Circuit breaker wraps calls; fail-fast on open                    | Encryption unavailable; 503 on dependent routes |
| ClickHouse down   | Static flag; trace writes fail silently                           | Traces lost during outage                       |

---

### 4.6 Connection Pooling

| System         | Pool Configuration                                | Notes                                        |
| -------------- | ------------------------------------------------- | -------------------------------------------- |
| MongoDB        | 100 connections (driver default)                  | Not explicitly overridden; Mongoose defaults |
| Redis (BullMQ) | `redis.duplicate({ maxRetriesPerRequest: null })` | Separate connection for blocking ops         |
| HTTP tools     | **No keep-alive configured**                      | Connection churn per tool call               |

---

## 5. Timeout Matrix

| Component                      | Timeout         | Source                         |
| ------------------------------ | --------------- | ------------------------------ |
| LLM queue job                  | 60,000ms        | `config/index.ts:63`           |
| HTTP tool call                 | 30,000ms        | `http-tool-executor.ts:213`    |
| Multimodal service fetch       | 30,000ms        | `multimodal-service-client.ts` |
| WebSocket heartbeat            | 30,000ms        | `config/index.ts:24`           |
| Session lock TTL               | 5,000ms         | `config/index.ts:46`           |
| Session TTL                    | 30 minutes      | `config/index.ts:47`           |
| Session cleanup TTL            | 720 hours (30d) | `config/index.ts:52`           |
| Message cleanup TTL            | 720 hours (30d) | `config/index.ts:54`           |
| Cleanup job interval           | 60 minutes      | `config/index.ts:56`           |
| Model resolution cooldown      | 30 seconds      | `config/index.ts:134`          |
| Circuit breaker reset (LLM)    | 60,000ms        | `types.ts:62`                  |
| Circuit breaker reset (tool)   | 30,000ms        | `types.ts:69`                  |
| Circuit breaker reset (tenant) | 30,000ms        | `types.ts:41`                  |
| Redis rate limiter TTL         | windowMs + 10s  | `redis-rate-limiter.ts:47`     |
| Session count TTL (Redis)      | 86,400s (24h)   | `rate-limiter.ts:322`          |
| In-memory cleanup interval     | 5 minutes       | `rate-limiter.ts:100`          |
| In-memory cleanup grace        | 2 minutes       | `rate-limiter.ts:163`          |
| Redis recovery polling         | 30 seconds      | `hybrid-rate-limiter.ts:91`    |
| MongoDB retry max delay        | 5,000ms         | `retry.ts:35`                  |
| Conversation window            | 40 messages     | `config/index.ts:44`           |

---

## 6. Numeric Reference Tables

### All Hardcoded Limits

| Constant                            | Value   | File:Line                             |
| ----------------------------------- | ------- | ------------------------------------- |
| `DEFAULT_LIMITS.requestsPerMinute`  | 100     | `rate-limiter.ts:43`                  |
| `DEFAULT_LIMITS.tokensPerMinute`    | 100,000 | `rate-limiter.ts:44`                  |
| `DEFAULT_LIMITS.concurrentSessions` | 50      | `rate-limiter.ts:45`                  |
| `DEFAULT_LIMITS.toolCallsPerMinute` | 200     | `rate-limiter.ts:46`                  |
| `MAX_RATE_LIMITER_ENTRIES`          | 50,000  | `rate-limiter.ts:89`                  |
| `MAX_MEMORY_SESSION_ENTRIES`        | 10,000  | `rate-limiter.ts:356`                 |
| `DEFAULT_MAX_TOOL_ITERATIONS`       | 10      | `reasoning-executor.ts:64`            |
| `MAX_CONSECUTIVE_EMPTY_RESPONSES`   | 2       | `reasoning-executor.ts:67`            |
| `DEFAULT_MAX_RESPONSE_BYTES`        | 10 MB   | `http-tool-executor.ts:33`            |
| `MAX_ERROR_BODY_LENGTH`             | 256     | `http-tool-executor.ts:36`            |
| `MAX_RETRY_CAP`                     | 10      | `http-tool-executor.ts:39`            |
| `MAX_RESILIENCE_MAP_ENTRIES`        | 2,000   | `http-tool-executor.ts:42`            |
| `MAX_REDIRECT_HOPS`                 | 5       | `http-tool-executor.ts:45`            |
| `DEFAULT_MAX_UPLOADS_PER_WINDOW`    | 50      | `upload-rate-limiter.ts:40`           |
| `MULTER_MAX_FILE_SIZE`              | 50 MB   | `multimodal routes/attachments.ts:27` |
| `MAX_UPLOAD_BYTES` (runtime)        | 20 MB   | `runtime routes/attachments.ts:30`    |
| WS max connections                  | 1,000   | `config/index.ts:25`                  |
| WS rate limit (connections/IP/min)  | 30      | `sdk-handler.ts:544`                  |
| LLM queue concurrency               | 10      | `config/index.ts:61`                  |
| LLM queue backpressure threshold    | 100     | `config/index.ts:62`                  |
| IR cache max entries                | 50      | `config/index.ts:45`                  |
| Search-AI max concurrent jobs       | 5       | `search-ai server.ts:200`             |
| Multimodal max concurrent jobs      | 5       | `multimodal config.ts:54`             |

---

## 7. Gaps & Recommendations

### CRITICAL — Security / Abuse Risk

| #   | Gap                                             | Impact                                                                                       | Recommendation                                                                                | Priority |
| --- | ----------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------- |
| 1   | **No per-API-key rate limiting**                | All API keys from same tenant share one limit bucket. One key can starve others.             | Add key-scoped limits as a fraction of tenant limits (e.g., per-key = tenant limit / N keys). | HIGH     |
| 2   | **No per-session message rate limiting**        | Unlimited messages within a session can abuse LLM costs.                                     | Add `messagesPerMinutePerSession` limit (e.g., 30/min).                                       | HIGH     |
| 3   | **Studio auth rate limiting is in-memory only** | Multi-pod deployments have independent limit counters; attacker can round-robin across pods. | Migrate to Redis-backed rate limiting (use runtime's existing `RedisRateLimiter`).            | HIGH     |
| 4   | **Search-AI has no request rate limiting**      | All `/api/indexes`, `/api/knowledge-bases` endpoints unprotected.                            | Add `tenantRateLimit('request')` middleware from shared package.                              | HIGH     |
| 5   | **Multimodal upload rate limiter not wired**    | `UploadRateLimiter` class exists but `consume()` never called in route handlers.             | Wire into `routes/attachments.ts` POST handler.                                               | HIGH     |

### HIGH — Reliability / Resilience

| #   | Gap                                                | Impact                                                                   | Recommendation                                                                                              | Priority |
| --- | -------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | -------- |
| 6   | **No circuit breaker on service-to-service calls** | Failures in Search-AI or Multimodal Service cascade to runtime sessions. | Wrap `SearchAIToolExecutor` and `MultimodalServiceClient` with circuit breaker + 30s timeout + 2-3 retries. | HIGH     |
| 7   | **No HTTP keep-alive on tool executor**            | Connection churn adds 20-30ms per external tool call.                    | Configure `http.Agent` / `https.Agent` with `keepAlive: true` in `HttpToolExecutor`.                        | HIGH     |
| 8   | **No per-LLM-provider concurrency cap**            | One provider outage can exhaust all 10 concurrency permits.              | Add per-provider semaphore; cap per-provider to `concurrency / active_providers`.                           | HIGH     |
| 9   | **No active ClickHouse health probe**              | `clickhouseReady` is a static flag; stale failures go undetected.        | Add periodic ping to ClickHouse in health check.                                                            | HIGH     |
| 10  | **No LLM call-level timeout**                      | LLM providers can hang indefinitely; job timeout is at queue level only. | Add `AbortSignal.timeout(120_000)` wrapping individual LLM API calls.                                       | HIGH     |

### MEDIUM — Operational Visibility

| #   | Gap                                                       | Impact                                                                            | Recommendation                                                                     | Priority |
| --- | --------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------- |
| 11  | **Tool call rate limit not plan-based**                   | All plans get 200 tool calls/min; no differentiation.                             | Wire `toolCallsPerMinute` into `PLAN_LIMITS` per tier.                             | MEDIUM   |
| 12  | **WebSocket rate limiting is IP-based, not tenant-based** | One tenant's users behind same IP can block another tenant. Not distributed.      | Add tenant-based WS rate limiting backed by Redis.                                 | MEDIUM   |
| 13  | **No backpressure metrics/alerts**                        | `BackpressureError` thrown but no OTEL metrics. Hard to detect queue saturation.  | Emit OTEL counter on backpressure events; alert on sustained > 50%.                | MEDIUM   |
| 14  | **No per-user/per-channel rate limiting**                 | Rate limits are tenant-wide only. No per-end-user or per-SDK-channel granularity. | Add optional `userId`/`channelId` sub-key in rate limiter.                         | MEDIUM   |
| 15  | **Redis fallback is silent**                              | When rate limiter falls to in-memory, no metric or alert is emitted.              | Add OTEL gauge for `rate_limiter_backend` (redis vs memory) and alert on fallback. | MEDIUM   |
| 16  | **No MCP tool executor resilience**                       | MCP server failures cascade to sessions with no circuit breaker or retry.         | Wrap MCP calls with tool-scoped circuit breaker (like HTTP tools).                 | MEDIUM   |
| 17  | **Connection pool exhaustion undetected**                 | MongoDB pool (100 connections) can exhaust silently; requests queue indefinitely. | Monitor pool utilization; emit metrics; configure `maxPoolSize` explicitly.        | MEDIUM   |

### LOW — Hardening

| #   | Gap                                             | Impact                                                                    | Recommendation                                             | Priority |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------- | -------- |
| 18  | **No WebSocket message processing timeout**     | Slow clients can hold connections indefinitely during message processing. | Add 60-90s timeout for message processing in WS handler.   | LOW      |
| 19  | **Dev login has no rate limit**                 | `/api/auth/dev-login` unprotected (dev-only, but should be guarded).      | Add rate limit even in dev to prevent accidental exposure. | LOW      |
| 20  | **No client-side debounce on form submissions** | Rapid clicks trigger multiple API calls before SWR dedup kicks in.        | Add debounce helper on all async form handlers in Studio.  | LOW      |

---

## 8. Coverage Matrix

### Rate Limiting Coverage

| Dimension             | Scope                      | Distributed? | Backend        | Status                        |
| --------------------- | -------------------------- | ------------ | -------------- | ----------------------------- |
| Request rate          | Per-tenant                 | Yes          | Redis + memory | ✅ Implemented                |
| Token rate            | Per-tenant                 | Yes          | Redis + memory | ✅ Implemented                |
| Concurrent sessions   | Per-tenant                 | Yes          | Redis + memory | ✅ Implemented                |
| Tool calls/min        | Per-tenant (hardcoded 200) | Yes          | Redis + memory | ⚠️ Not plan-based             |
| File uploads          | Per-tenant                 | Yes          | Redis + memory | ⚠️ Implemented but not wired  |
| WebSocket connections | Per-IP                     | No           | In-memory      | ⚠️ Not distributed, IP-shared |
| Auth attempts         | Per-IP/user                | No           | In-memory      | ⚠️ Not distributed            |
| Per-API-key           | —                          | —            | —              | ❌ Missing                    |
| Per-user/channel      | —                          | —            | —              | ❌ Missing                    |
| Per-session messages  | —                          | —            | —              | ❌ Missing                    |
| Search-AI requests    | —                          | —            | —              | ❌ Missing                    |

### Circuit Breaker Coverage

| Integration        | Level                 | Distributed? | Status         |
| ------------------ | --------------------- | ------------ | -------------- |
| LLM providers      | `llm_provider`        | Yes (Redis)  | ✅ Implemented |
| HTTP tool calls    | `tool_service`        | Yes (Redis)  | ✅ Implemented |
| KMS providers      | `kms:{type}:{tenant}` | Yes (Redis)  | ✅ Implemented |
| Tenant-level       | `tenant`              | Yes (Redis)  | ✅ Implemented |
| App-level          | `app`                 | Yes (Redis)  | ✅ Implemented |
| Search-AI service  | —                     | —            | ❌ Missing     |
| Multimodal service | —                     | —            | ❌ Missing     |
| MCP tool calls     | —                     | —            | ❌ Missing     |
| ClickHouse writes  | —                     | —            | ❌ Missing     |

### Resilience Pattern Coverage

| Pattern                         | Status | Notes                                                   |
| ------------------------------- | ------ | ------------------------------------------------------- |
| Redis → memory fallback         | ✅     | Rate limiter, circuit breaker, session count, LLM queue |
| Auto-recovery (Redis)           | ✅     | 30s polling on all subsystems                           |
| MongoDB retry                   | ✅     | 3 retries, exponential backoff, jitter                  |
| LLM queue backpressure          | ✅     | Threshold 100, throws BackpressureError                 |
| Per-session FIFO                | ✅     | Spin-lock with exponential backoff                      |
| Health checks (MongoDB)         | ✅     | ping + serverStatus                                     |
| Health checks (Redis)           | ✅     | ping-based availability                                 |
| Health checks (ClickHouse)      | ⚠️     | Static flag only — no active probe                      |
| Health checks (memory pressure) | ✅     | 85% heap threshold on readiness                         |
| HTTP keep-alive                 | ❌     | Not configured on tool executor                         |
| Per-provider concurrency cap    | ❌     | Global only                                             |
| Call-level LLM timeout          | ❌     | Job-level only (60s)                                    |
| Service-to-service resilience   | ❌     | No circuit breaker on Search-AI, Multimodal             |
| Pool exhaustion detection       | ❌     | No alerts or backpressure signals                       |
