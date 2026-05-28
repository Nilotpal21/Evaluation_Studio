# Feature: Rate Limiting

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: STABLE
**Feature Area(s)**: `customer experience`, `observability`, `governance`, `enterprise`, `integrations`
**Package(s)**: `apps/runtime`, `apps/search-ai`, `apps/studio`, `packages/config`, `packages/connectors/base`, `packages/pipeline-engine`, `packages/agent-transfer`
**Owner(s)**: `Platform team`
**Testing Guide**: [docs/testing/rate-limiting.md](../testing/rate-limiting.md)
**Last Updated**: 2026-04-15

---

## 1. Introduction / Overview

### Problem Statement

Multi-tenant platforms face a critical availability risk when one tenant, API key, session, connector sync, or evaluation run can monopolize shared compute, exhaust external provider quotas, or destabilize session infrastructure. Without consistent, plan-aware throttling across all request surfaces (HTTP, WebSocket, background jobs), the platform is vulnerable to DDoS, noisy-neighbor starvation, accidental infinite loops, and bursty workloads that cascade into outages.

### Goal Statement

Enforce plan-aware request, token, tool-call, session, and channel budgets across Runtime, SearchAI, Studio, connectors, and eval pipelines using a distributed Redis-primary architecture with bounded in-memory fallback, so that no single tenant or consumer can degrade the platform for others.

### Summary

Rate Limiting is the platform's cross-cutting traffic-control layer. It spans five distinct limiter surfaces, each purpose-built for its workload:

1. **Runtime** (`apps/runtime/src/middleware/rate-limiter.ts` + `services/resilience/`): The most feature-rich surface. Resolves plan-aware tenant budgets from `TenantConfigService`, enforces per-tenant request/token/tool-call/session limits through a Redis-backed sliding-window Lua script (`RedisRateLimiter`) with `InMemoryRateLimiter` fallback, adds per-API-key sub-limits (tenant budget / configurable divisor, minimum 10), tracks concurrent session slots via Redis SET with Lua atomic check-and-add, gates per-session message rates for chat/SDK paths, and throttles WebSocket connection attempts via `WSConnectionRateLimiter` (tenant+IP bucketed).

2. **SearchAI** (`apps/search-ai/src/middleware/rate-limit.ts`): Fixed-window rate limiter using Redis INCR + PEXPIRE Lua script. Default: 120 requests/minute/tenant. In-memory fallback with bounded Map (10k entries). Self-heals orphaned keys (PTTL === -1).

3. **Studio** (`apps/studio/src/lib/rate-limit.ts` + `rate-limiter.ts`): Two separate implementations. `rate-limit.ts` provides Redis-backed sliding-window checks (same Lua pattern as Runtime) with in-memory fallback. `rate-limiter.ts` provides an in-process `SlidingWindowRateLimiter` class with LRU eviction and configurable scopes (tenant/user/IP).

4. **Connectors** (`packages/connectors/base/src/client/rate-limiter.ts`): Token-bucket algorithm for pacing provider API calls. Configurable `maxTokens` and `refillRate` (tokens/second). Async `acquire()` waits for tokens; sync `tryAcquire()` returns immediately.

5. **Evals** (`packages/pipeline-engine/src/pipeline/services/eval/eval-rate-limiter.ts`): In-memory per-tenant counters with tier-based limits (free/team/business/enterprise) across three dimensions: concurrent runs, concurrent conversations, and LLM calls/minute. Auto-cleanup of idle tenants every 2 minutes.

6. **Agent Transfer** (`packages/agent-transfer/src/security/rate-limiter.ts`): Redis sorted-set sliding window for transfer operations per tenant. Lua script atomically checks and conditionally adds entries to prevent memory amplification from rejected requests.

---

## 2. Scope

### Goals

- Enforce plan-aware Runtime request, token, tool-call, session, and API-key budgets per tenant, resolved from `TenantConfigService`.
- Protect SearchAI, Studio, connectors, eval execution, and agent-transfer paths with fit-for-purpose throttling strategies.
- Preserve availability by supporting Redis-primary distributed enforcement with bounded in-memory fallback and automatic Redis recovery (30s polling).
- Emit structured observability signals (metrics, logs) for rate-limit rejections, fallback transitions, and usage snapshots.

### Non-Goals (Out of Scope)

- A single unified operator dashboard for all platform rate-limit usage is not provided today.
- A dedicated Studio or admin CRUD surface for interactively editing every budget is not in scope.
- Unifying every limiter implementation into one storage algorithm is explicitly not a goal; each surface uses a purpose-built variant tuned for its workload characteristics.

---

## 3. User Stories

1. As a `platform operator`, I want plan-aware per-tenant budgets so that one tenant cannot starve shared infrastructure, and I can differentiate service tiers (FREE/TEAM/BUSINESS/ENTERPRISE).
2. As an `SDK or chat consumer`, I want per-session message throttles and per-API-key sub-limits so that runaway message loops or a leaked key are contained without affecting other sessions or keys.
3. As a `SearchAI engineer`, I want per-tenant request throttling with automatic Redis failover so that heavy ingestion workloads do not destabilize the search service.
4. As a `connector developer`, I want token-bucket pacing on provider API calls so that sync operations respect external rate limits and avoid bans.
5. As an `eval pipeline operator`, I want tier-based concurrency and LLM-call rate limits so that evaluation runs from one tenant do not monopolize shared model capacity.

---

## 4. Functional Requirements

1. **FR-1**: The system must enforce Runtime per-tenant request budgets derived from tenant plan/config state via `TenantConfigService.getConfigAsync()`, with fallback to defaults (100 req/min, 100k tokens/min, 50 concurrent sessions, 200 tool calls/min).
2. **FR-2**: The system must apply per-API-key sub-limits (tenant budget divided by configurable divisor, minimum 10) and check them before tenant counters to avoid consuming tenant quota for per-key rejections.
3. **FR-3**: The system must enforce per-session message budgets (default 30/min) for chat and SDK WebSocket message paths via `checkSessionMessageRate()`.
4. **FR-4**: The system must enforce concurrent-session caps via atomic Redis SET operations (`claimSessionSlot`/`releaseSessionSlot`) with Lua scripts, and WebSocket connection flood protection via `WSConnectionRateLimiter` (tenant+IP bucketed).
5. **FR-5**: The system must support Redis-primary enforcement with bounded in-memory fallback (max 50k entries for Runtime, 10k for SearchAI/Studio) and automatic recovery (30s polling via `HybridRateLimiter.startRecoveryTimer()`).
6. **FR-6**: The system must provide SearchAI fixed-window throttling (default 120 req/min, atomic Lua INCR+PEXPIRE), Studio Redis-or-memory helpers, connector token-bucket pacing, eval tier-based concurrency controls, and agent-transfer per-tenant sliding-window limits.
7. **FR-7**: The system must return HTTP 429 responses with standard `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers when limits are exceeded.
8. **FR-8**: The system must support unlimited (`-1`) plan values that skip rate-limit enforcement entirely for privileged tiers.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                                   |
| -------------------------- | ------------ | ------------------------------------------------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Effective budgets vary by tenant/project plan configuration but are not a project authoring surface.    |
| Agent lifecycle            | SECONDARY    | Tool-call, token, and session budgets directly affect runtime execution behavior.                       |
| Customer experience        | PRIMARY      | End users feel HTTP 429s, throttled chat sends, and rejected WebSocket connections directly.            |
| Integrations / channels    | PRIMARY      | SDK, chat, connectors, A2A, MCP, and SearchAI all depend on limiter behavior.                           |
| Observability / tracing    | PRIMARY      | Rejections, fallback transitions, and usage snapshots are core operating signals.                       |
| Governance / controls      | PRIMARY      | Plan-aware quotas and per-key isolation are core multi-tenant governance controls.                      |
| Enterprise / compliance    | SECONDARY    | Fairness, noisy-neighbor protection, and graceful degradation matter for enterprise production posture. |
| Admin / operator workflows | SECONDARY    | Operators manage budgets indirectly through plan/config state and service metrics.                      |

### Related Feature Integration Matrix

| Related Feature                                 | Relationship Type | Why It Matters                                                                       | Key Touchpoints                                                    | Current State                                           |
| ----------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------- |
| [SDK](sdk.md)                                   | depends on        | SDK init, refresh, WebSocket traffic, and session messaging all rely on throttling.  | `/api/v1/sdk/*`, `/ws/sdk`, `checkSessionMessageRate()`            | Implemented with route and WS-specific limits           |
| [Connectors](connectors.md)                     | depends on        | Provider APIs need pacing to avoid external throttling or bans.                      | `packages/connectors/base/src/client/rate-limiter.ts`              | Connector token-bucket pacing is implemented and tested |
| [Agent Testing & Evals](agent-testing-evals.md) | depends on        | Eval runs need concurrency and LLM-call controls per tenant tier.                    | `eval-rate-limiter.ts`                                             | Implemented with tier-based limits                      |
| [Agent Transfer](agent-transfer.md)             | depends on        | Transfer operations need per-tenant throttling to prevent abuse.                     | `packages/agent-transfer/src/security/rate-limiter.ts`             | Redis sorted-set sliding window implemented             |
| [Circuit Breaker](circuit-breaker.md)           | shares data with  | Circuit breakers and rate limiters share Redis infrastructure and recovery patterns. | `HybridRateLimiter` follows `HybridCircuitBreakerRegistry` pattern | Both use Redis-primary + in-memory fallback             |

---

## 6. Design Considerations (Optional)

- The feature intentionally uses different limiter strategies per surface (sliding window, fixed window, token bucket) rather than forcing every workload through a single middleware abstraction.
- Runtime takes the strictest, most distributed approach because it handles tenant-shared request traffic and session concurrency.
- All limiters return consistent 429 response shapes and rate-limit headers for operator debugging, even when algorithms differ.
- The `WSConnectionRateLimiter` is tenant+IP composite-keyed to prevent both tenant-level floods and per-IP abuse behind shared NATs.

---

## 7. Technical Considerations (Optional)

- **Runtime Redis Lua**: Sliding-window via ZSET with atomic ZREMRANGEBYSCORE + ZCARD + ZADD + EXPIRE. SHA caching via EVALSHA with NOSCRIPT fallback. Key pattern: `rl:{tenantId}:{operation}`.
- **SearchAI Redis Lua**: Fixed-window via INCR + conditional PEXPIRE. Self-heals orphaned keys where PTTL === -1. Key pattern: `search-ai:rl:{tenantOrIpKey}`.
- **Studio dual implementation**: `rate-limit.ts` uses Redis sliding-window (same Lua as Runtime). `rate-limiter.ts` is in-process only with LRU eviction. The two have different storage semantics and are used by different route handlers.
- **Eval throttling**: Intentionally local to the pipeline-engine process. No Redis dependency. Uses in-memory counters with 2-minute idle cleanup and 1000-entry cap.
- **Agent Transfer**: Uses Redis sorted-set sliding window with conditional ZADD (only adds entry if under limit) to prevent memory amplification from rejected requests.

---

## 8. How to Consume

### Studio UI

No dedicated rate-limiting page in Studio today. The feature is consumed indirectly through:

- Plan/config management that affects tenant budgets
- HTTP 429 responses surfaced in Studio or SDK flows
- Workspace/admin flows that use Studio-side helpers for route throttling

### API (Runtime)

Rate limiting is applied as middleware and helper functions.

| Method     | Path                                                      | Purpose                                                            |
| ---------- | --------------------------------------------------------- | ------------------------------------------------------------------ |
| middleware | `tenantRateLimit('request')` on many `/api/v1/...` routes | Enforce per-tenant request budgets                                 |
| POST       | `/api/v1/sdk/init`                                        | Uses stricter bootstrap request limits                             |
| POST       | `/api/v1/sdk/refresh`                                     | Uses stricter refresh request limits                               |
| helper     | `checkSessionMessageRate(sessionId)`                      | Enforce per-session message budgets for chat and WebSocket traffic |
| helper     | `recordTokenUsage(tenantId, tokenCount)`                  | Charge post-LLM token usage against tenant budgets                 |
| helper     | `claimSessionSlot()` / `releaseSessionSlot()`             | Enforce concurrent session caps via Redis SET                      |
| WS         | `/ws/sdk`                                                 | Uses `WSConnectionRateLimiter` for connection-attempt throttling   |

### API (Studio)

| Method | Path                                         | Purpose                                        |
| ------ | -------------------------------------------- | ---------------------------------------------- |
| helper | `checkRateLimit(key, maxAttempts, windowMs)` | Redis-or-memory Studio route throttling helper |
| helper | `SlidingWindowRateLimiter.check()`           | In-process Studio sliding-window utility       |

### Admin Portal

Rate limits are managed indirectly through tenant plan/config data. Platform-admin and tenant-admin Runtime routes are themselves protected by the same Runtime rate limiter.

### Channel / SDK / Voice / A2A / MCP Integration

- **SDK/chat**: Session-message and bootstrap throttling apply directly.
- **Voice**: Voice token/capability routes inherit Runtime request throttling.
- **Connectors**: Provider client calls use token-bucket pacing via `RateLimiter.acquire()`.
- **Evals**: Evaluation runs use tier-based concurrency and LLM-call budgets.
- **A2A / MCP**: Inherit Runtime request/token/tool-call limits where routed through Runtime execution surfaces.

---

## 9. Data Model

### Collections / Tables

This feature is mostly ephemeral and Redis-backed. It does not own a primary MongoDB collection.

```text
Store: Redis sorted-set sliding windows (Runtime)
Key pattern:
  - rl:{tenantOrScope}:{operation}
Purpose:
  - Runtime per-tenant/per-operation sliding-window request budgets
Payload:
  - ZSET members = "{timestamp}:{randomId}:{counter}" with score = timestamp
  - TTL = ceil(windowMs/1000) + 10 seconds
```

```text
Store: Redis session membership sets (Runtime)
Key pattern:
  - sessions:active:{tenantId}
Purpose:
  - Concurrent session slot enforcement via SADD/SREM/SCARD
Payload:
  - SET of active session IDs
  - TTL = SESSION_SET_TTL_SECONDS (default 172800s / 48h safety net)
```

```text
Store: SearchAI fixed-window counters
Key pattern:
  - search-ai:rl:{tenantOrIpKey}
Purpose:
  - SearchAI request throttling via atomic INCR
Payload:
  - Numeric counter with PEXPIRE window TTL
```

```text
Store: Studio Redis sliding window
Key pattern:
  - rl:studio:{routePath}:{scope}:{id}
Purpose:
  - Studio route-level throttling
Payload:
  - ZSET members with timestamp scores (same pattern as Runtime)
```

```text
Store: Agent Transfer Redis sorted-set
Key pattern:
  - at_ratelimit:{tenantId}
Purpose:
  - Per-tenant transfer operation throttling
Payload:
  - ZSET members = "{timestamp}:{randomId}" with score = timestamp
  - TTL = PEXPIRE with windowMs
```

```text
Store: In-memory fallback maps (all services)
Purpose:
  - Fallback when Redis is unavailable
Instances:
  - Runtime: InMemoryRateLimiter.windows (max 50k entries, 5min cleanup, 2min grace)
  - Studio: SlidingWindowRateLimiter.windows (max 10k, LRU eviction)
  - Studio: rate-limit.ts attempts Map (max 10k, LRU eviction)
  - SearchAI: memoryWindows Map (max 10k, prefer-expired eviction)
  - Eval: tenantCounters Map (max 1k, oldest-idle eviction, 2min cleanup)
  - Runtime: memorySessionSets Map (max 10k, oldest eviction)
```

### Key Relationships

- Runtime limit resolution depends on tenant/project plan configuration from `TenantConfigService`.
- SDK and chat flows consume per-session and per-API-key limits on top of per-tenant budgets.
- Connector and eval limiters are adjacent, purpose-built throttles independent of the Runtime Redis limiter.
- Agent-transfer limiter requires a Redis connection (no in-memory fallback).

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                                       | Purpose                                                                                  |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `apps/runtime/src/middleware/rate-limiter.ts`                              | Runtime middleware, InMemoryRateLimiter, session slot management, plan resolution        |
| `apps/runtime/src/services/resilience/hybrid-rate-limiter.ts`              | Redis-primary + in-memory-fallback orchestrator with auto-recovery timer                 |
| `apps/runtime/src/services/resilience/redis-rate-limiter.ts`               | Redis Lua sorted-set sliding-window implementation with EVALSHA caching                  |
| `apps/search-ai/src/middleware/rate-limit.ts`                              | SearchAI fixed-window rate limiter with Redis Lua and memory fallback                    |
| `apps/studio/src/lib/rate-limit.ts`                                        | Studio Redis-or-memory sliding-window helper                                             |
| `apps/studio/src/lib/rate-limiter.ts`                                      | Studio in-process SlidingWindowRateLimiter with LRU eviction and scope-based key builder |
| `packages/connectors/base/src/client/rate-limiter.ts`                      | Connector token-bucket throttling (acquire/tryAcquire)                                   |
| `packages/pipeline-engine/src/pipeline/services/eval/eval-rate-limiter.ts` | Eval tier-based concurrency and LLM-call throttling with auto-cleanup                    |
| `packages/agent-transfer/src/security/rate-limiter.ts`                     | Agent transfer Redis sorted-set sliding-window with conditional ZADD                     |
| `packages/config/src/schemas/rate-limit.schema.ts`                         | Zod schema for auth/API rate limit config (authWindowMs, authMax, apiWindowMs, apiMax)   |

### Routes / Handlers

| File                                        | Purpose                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------ |
| `apps/runtime/src/routes/chat.ts`           | Uses request and per-session message throttling                          |
| `apps/runtime/src/routes/sdk-init.ts`       | Uses stricter SDK bootstrap/refresh request limits                       |
| `apps/runtime/src/websocket/sdk-handler.ts` | Uses `WSConnectionRateLimiter` and per-session message throttling        |
| `apps/runtime/src/routes/*`                 | Many Runtime route modules call `router.use(tenantRateLimit('request'))` |

### UI Components

| File                                  | Purpose                                             |
| ------------------------------------- | --------------------------------------------------- |
| `apps/studio/src/lib/rate-limit.ts`   | Shared helper used by throttled Studio API routes   |
| `apps/studio/src/lib/rate-limiter.ts` | General in-memory limiter used by Studio route code |

### Jobs / Workers / Background Processes

| File                                                                       | Purpose                                                              |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `packages/pipeline-engine/src/pipeline/services/eval/eval-rate-limiter.ts` | Protects eval worker capacity and LLM call budgets                   |
| `apps/runtime/src/websocket/sdk-handler.ts`                                | Applies connection and message throttling for long-lived SDK traffic |

### Tests

| File                                                               | Type             | Coverage Focus                                           |
| ------------------------------------------------------------------ | ---------------- | -------------------------------------------------------- |
| `apps/runtime/src/__tests__/middleware/rate-limiter.test.ts`       | unit             | Core Runtime middleware behavior                         |
| `apps/runtime/src/__tests__/middleware-rate-limiter.test.ts`       | unit             | Additional Runtime middleware regressions                |
| `apps/runtime/src/__tests__/rate-limiter-plan-aware.test.ts`       | unit             | Plan-to-limit mapping and unlimited handling             |
| `apps/runtime/src/__tests__/rate-limiter-per-api-key.test.ts`      | unit             | Per-key sub-limit behavior                               |
| `apps/runtime/src/__tests__/rate-limiter-session-message.test.ts`  | unit             | Session-message helper contract                          |
| `apps/runtime/src/__tests__/rate-limiter-resilience-fixes.test.ts` | unit             | Fallback/re-check/in-memory cleanup behavior             |
| `apps/runtime/src/__tests__/ws-tenant-rate-limit.test.ts`          | unit             | WebSocket tenant+IP bucket isolation                     |
| `apps/search-ai/src/__tests__/rate-limit-middleware.test.ts`       | unit/integration | SearchAI middleware limits, headers, isolation, fallback |
| `apps/studio/src/__tests__/rate-limiter.test.ts`                   | unit             | Studio limiter utility behavior                          |
| `apps/studio/src/lib/__tests__/rate-limit.test.ts`                 | unit             | Studio Redis-or-memory helper                            |
| `packages/connectors/base/src/__tests__/rate-limiter.test.ts`      | unit             | Connector token-bucket pacing                            |
| `packages/agent-transfer/src/__tests__/unit/rate-limiter.test.ts`  | unit             | Agent transfer rate limiter Lua script behavior          |

---

## 11. Configuration

### Environment Variables

| Variable                               | Default  | Description                                             |
| -------------------------------------- | -------- | ------------------------------------------------------- |
| `RATE_LIMITER_MAX_ENTRIES`             | `50000`  | Safety cap for Runtime in-memory sliding-window entries |
| `RATE_LIMITER_CLEANUP_INTERVAL_MS`     | `300000` | Runtime in-memory cleanup cadence (5 min)               |
| `RATE_LIMITER_CLEANUP_GRACE_MS`        | `120000` | Runtime in-memory cleanup grace window (2 min)          |
| `RATE_LIMITER_API_KEY_DIVISOR`         | `5`      | Divides tenant request budgets into per-key sub-limits  |
| `SESSION_MESSAGE_RATE_LIMIT`           | `30`     | Per-session message budget per minute                   |
| `SESSION_SET_TTL_SECONDS`              | `172800` | TTL safety net for active-session Redis sets (48h)      |
| `SESSION_COUNT_MAX_MEMORY_ENTRIES`     | `10000`  | Max in-memory session tracking entries                  |
| `REDIS_RECOVERY_INTERVAL_MS`           | `30000`  | Runtime Redis recovery check interval                   |
| `SEARCH_AI_RATE_LIMIT`                 | `120`    | SearchAI default request budget per minute              |
| `SEARCH_AI_RATE_WINDOW_MS`             | `60000`  | SearchAI fixed-window duration                          |
| `SEARCH_AI_RATE_MAX_MEMORY_ENTRIES`    | `10000`  | SearchAI in-memory fallback cap                         |
| `SEARCH_AI_REDIS_RECOVERY_INTERVAL_MS` | `30000`  | SearchAI Redis recovery check interval                  |

### Runtime Configuration

- Runtime resolves tenant/project budgets through `TenantConfigService.getConfigAsync()` and `getProjectConfig()`.
- `-1` means unlimited for supported plan fields (tokens, tool calls, concurrent sessions).
- Route authors can override resolved budgets per route by passing `overrideLimits` to `tenantRateLimit()`.
- SearchAI exposes `limit` and `windowMs` overrides through `searchAiRateLimit(options)`.
- Eval tier limits are hard-coded in `TIER_LIMITS` (free/team/business/enterprise).

### DSL / Agent IR / Schema

Rate limiting is not directly authored in ABL DSL. It is applied by middleware, service helpers, and platform plan/config resolution. The `RateLimitConfigSchema` in `packages/config` defines Zod schemas for `authWindowMs`, `authMax`, `apiWindowMs`, and `apiMax`.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tenant isolation  | All budgets are keyed by tenantId. One tenant cannot consume another tenant's request, token, or session capacity. Redis keys are namespaced per tenant.           |
| Project isolation | Effective limits can vary by project/plan context via `getProjectConfig()`. Project-specific behavior is resolved inside tenant-safe plan lookups.                 |
| User isolation    | User traffic shares tenant budgets by default. Per-key sub-limits narrow blast radius for individual API keys. Studio `buildRateLimitKey()` supports user scoping. |

### Security & Compliance

- Per-key sub-limits prevent one leaked or abusive API key from exhausting a whole tenant budget.
- WebSocket `WSConnectionRateLimiter` uses composite tenant+IP keys to handle shared NATs.
- Agent-transfer Lua script conditionally adds entries only when under limit, preventing memory amplification from rejected-request floods.
- All rate-limit keys use namespaced prefixes (`rl:`, `search-ai:rl:`, `rl:studio:`, `at_ratelimit:`, `sessions:active:`) to prevent key collisions.

### Performance & Scalability

- Runtime uses Lua-backed atomic Redis operations and caches script SHA via EVALSHA to reduce network overhead.
- In-memory implementations bound their maps/sets with configurable caps and eviction strategies.
- Connector token-bucket pacing smooths bursts without hammering provider APIs.
- Runtime scales horizontally when Redis is available because rate-limit state is shared across pods.
- Fallback to memory keeps the system available in degraded mode with single-pod semantics.

### Reliability & Failure Modes

- `HybridRateLimiter` supports Redis-to-memory fallback with automatic recovery (30s polling). Transitions are logged and metricked via `recordRateLimiterFallback()`.
- SearchAI manages its own Redis connection lifecycle with reconnection after `SEARCH_AI_REDIS_RECOVERY_INTERVAL_MS`.
- Runtime session counting falls back to in-memory `Set` when Redis is unavailable.
- The Redis sliding-window Lua script sets TTL slightly longer than the window (`ceil(windowMs/1000) + 10s`) to auto-cleanup abandoned keys.
- Agent-transfer rate limiter has no in-memory fallback; it requires Redis.

### Observability

- Runtime records rejections via `recordRateLimitRejection({ tenantId, operation })` in OpenTelemetry metrics.
- Fallback transitions logged via `recordRateLimiterFallback('redis_to_memory' | 'memory_to_redis')`.
- Eval limiter exposes `getTenantEvalUsage()` for admin/health endpoints and emits `rateLimitRejections` and `rateLimitQueueDepth` metrics.
- All services use structured logging via `createLogger()` for rejection and error events.

### Data Lifecycle

- All limiter state is ephemeral (Redis with TTL or in-memory with cleanup/eviction).
- Runtime in-memory cleanup runs every 5 minutes with 2-minute grace period.
- Eval counter cleanup runs every 2 minutes, removing idle tenants after 2 minutes of inactivity.
- Session SET TTL defaults to 48 hours as a safety net against pod crashes leaving orphaned entries.
- SearchAI Lua script self-heals orphaned keys (PTTL === -1) by re-applying PEXPIRE.

---

## 13. Delivery Plan / Work Breakdown

1. Close production-behavior gaps
   1.1 Add real Redis Runtime integration tests for the Lua sliding-window path
   1.2 Add SearchAI Redis-backed tests for the fixed-window Lua path
   1.3 Add agent-transfer rate limiter integration tests with real Redis
2. Improve service consistency
   2.1 Reconcile or document the differences between Studio helper implementations
   2.2 Add dedicated eval limiter test coverage
   2.3 Evaluate whether Studio should converge on one limiter implementation
3. Strengthen operator visibility
   3.1 Add usage and rejection dashboard visibility across Runtime, SearchAI, and Studio
   3.2 Add load and multi-pod behavior validation for fairness under concurrency
   3.3 Consider admin API endpoints for live tenant budget inspection

---

## 14. Success Metrics

| Metric                             | Baseline                                | Target                                                   | How Measured                                              |
| ---------------------------------- | --------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------- |
| Runtime distributed limiter proof  | Missing real Redis integration coverage | Redis-backed Runtime limiter covered by checked-in tests | Integration test inventory                                |
| SearchAI distributed limiter proof | Fallback path covered, Redis path not   | Real Redis SearchAI path covered                         | SearchAI integration tests                                |
| Fairness under concurrency         | Not explicitly proven                   | Load/concurrency validation exists for major services    | Soak/load test artifacts or checked-in regression harness |
| Eval limiter test coverage         | No dedicated test file                  | Eval rate limiter has dedicated passing tests            | Test file in pipeline-engine test inventory               |
| Zero rate-limit key collisions     | No known collisions                     | Namespaced keys verified in integration tests            | Key pattern validation in test suite                      |

---

## 15. Open Questions

1. Should Studio converge on one limiter implementation (`rate-limit.ts` vs `rate-limiter.ts`), or is the current split intentional long-term?
2. Should eval throttling eventually share distributed state through Redis for multi-worker fairness?
3. What operator surface should expose live tenant budget consumption across Runtime, SearchAI, and Studio?
4. Should agent-transfer rate limiter add an in-memory fallback for Redis-unavailable scenarios?
5. Should the platform provide a unified rate-limit configuration schema that all services consume, rather than per-service env vars?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                             | Severity | Status |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | No black-box multi-pod or real-Redis E2E suite proving the Runtime Lua sliding-window path under production-like conditions.            | High     | Open   |
| GAP-002 | SearchAI tests currently focus on the in-memory fallback path and do not directly verify the Redis Lua fixed-window branch.             | High     | Open   |
| GAP-003 | Studio has two separate rate-limiting helpers with different storage/backoff semantics; no documented rationale for the split.          | Medium   | Open   |
| GAP-004 | No unified operator dashboard showing current tenant request budget usage across Runtime, SearchAI, and Studio.                         | Medium   | Open   |
| GAP-005 | Eval rate limiter has no dedicated test file; coverage is incidental through higher-level eval tests.                                   | Medium   | Open   |
| GAP-006 | Agent-transfer rate limiter has no in-memory fallback; Redis unavailability blocks all transfer operations.                             | Low      | Open   |
| GAP-007 | `console.warn` used in `apps/studio/src/lib/rate-limit.ts` instead of `createLogger()` (Studio is Next.js, logger availability varies). | Low      | Open   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                         | Coverage Type    | Status     | Test File / Note                                                   |
| --- | -------------------------------------------------------------------------------- | ---------------- | ---------- | ------------------------------------------------------------------ |
| 1   | SDK WebSocket connection buckets stay isolated by tenant+IP                      | unit             | PASS       | `apps/runtime/src/__tests__/ws-tenant-rate-limit.test.ts`          |
| 2   | SearchAI rejects requests with 429 when tenant limit is exceeded                 | unit/integration | PASS       | `apps/search-ai/src/__tests__/rate-limit-middleware.test.ts`       |
| 3   | Real Redis Runtime sliding-window behavior under live server load                | integration      | NOT TESTED | Missing Redis-backed suite                                         |
| 4   | Plan-aware Runtime limits resolve from tenant config, including unlimited values | unit             | PASS       | `apps/runtime/src/__tests__/rate-limiter-plan-aware.test.ts`       |
| 5   | Per-API-key sub-limits reject before tenant counters are consumed                | unit             | PASS       | `apps/runtime/src/__tests__/rate-limiter-per-api-key.test.ts`      |
| 6   | Session message throttling gates chat/SDK message paths                          | unit             | PASS       | `apps/runtime/src/__tests__/rate-limiter-session-message.test.ts`  |
| 7   | Runtime limiter resilience handles memory fallback and re-check semantics        | unit             | PASS       | `apps/runtime/src/__tests__/rate-limiter-resilience-fixes.test.ts` |
| 8   | Connector token-bucket pacing refills and blocks correctly                       | unit             | PASS       | `packages/connectors/base/src/__tests__/rate-limiter.test.ts`      |
| 9   | Studio sliding-window utility enforces limits and bounded eviction               | unit             | PASS       | `apps/studio/src/__tests__/rate-limiter.test.ts`                   |
| 10  | Agent transfer rate limiter enforces per-tenant limits via Redis                 | unit             | PASS       | `packages/agent-transfer/src/__tests__/unit/rate-limiter.test.ts`  |

### Testing Notes

Current coverage is strong at the helper and middleware level across Runtime, SearchAI, Studio, connectors, and agent-transfer. The main missing proof remains the real distributed behavior boundary: Redis-backed paths, load, and multi-pod fairness. Eval rate limiter lacks dedicated tests.

> Full testing details: [docs/testing/rate-limiting.md](../testing/rate-limiting.md)

---

## 18. References

- Prior audit: `docs/archive/plans-2026-02/2026-02-25-rate-limits-circuit-breakers-audit.md`
- Gap fixes: `docs/archive/plans-2026-02/2026-02-28-rate-limits-circuit-breakers-gap-fixes.md`
- Config schema: `packages/config/src/schemas/rate-limit.schema.ts`
- Testing guide: [docs/testing/rate-limiting.md](../testing/rate-limiting.md)
- Related features: [SDK](sdk.md), [Connectors](connectors.md), [Agent Testing & Evals](agent-testing-evals.md), [Agent Transfer](agent-transfer.md), [Circuit Breaker](circuit-breaker.md)
