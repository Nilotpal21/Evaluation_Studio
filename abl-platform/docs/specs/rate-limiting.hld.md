# High-Level Design: Rate Limiting

**Feature Spec**: [docs/features/rate-limiting.md](../features/rate-limiting.md)
**Test Spec**: [docs/testing/rate-limiting.md](../testing/rate-limiting.md)
**Status**: APPROVED
**Date**: 2026-03-22

---

## 1. Problem Statement

The ABL platform serves multiple tenants across Runtime, SearchAI, Studio, connector, eval, and agent-transfer surfaces. Each surface handles different traffic patterns: high-frequency HTTP/WebSocket requests (Runtime), heavy batch operations (SearchAI), UI-driven API calls (Studio), provider API pacing (connectors), long-running compute (evals), and inter-agent communication (agent-transfer). Without consistent, plan-aware throttling across all surfaces, one tenant or consumer can monopolize shared compute, exhaust external provider quotas, or destabilize session infrastructure, leading to DDoS vulnerability, noisy-neighbor starvation, and cascading outages.

The existing implementation already covers six distinct limiter surfaces with production-grade Redis Lua scripts, in-memory fallbacks, and tier-based plan resolution. The primary architectural gap is not in the core enforcement logic but in proving distributed correctness (no Redis-backed E2E tests), test coverage for all surfaces (eval limiter untested), and operator visibility (no unified dashboard).

---

## 2. Alternatives Considered

### Alternative A: Unified Rate-Limit Service (Centralized)

**Description**: Extract all rate-limiting logic into a shared `@abl/rate-limiter` package with a single Redis-backed implementation. All services import and configure the same class.

**Pros**:

- Single algorithm to test and maintain
- Consistent behavior across all services
- One place for operator dashboards

**Cons**:

- Different services have fundamentally different workload patterns (high-frequency sliding window vs. token bucket vs. tier-based counters)
- Forces eval engine to take a Redis dependency (currently intentionally local)
- Breaking change to all services simultaneously
- Token-bucket for connectors cannot be expressed as a sliding window

**Effort**: L (large)

---

### Alternative B: Purpose-Built Limiter per Surface (Current Architecture)

**Description**: Each service owns its rate-limiting implementation, purpose-built for its workload. Runtime uses Redis sorted-set sliding windows. SearchAI uses Redis INCR fixed windows. Connectors use token buckets. Evals use in-memory counters. Agent-transfer uses Redis sorted-set with conditional ZADD.

**Pros**:

- Each limiter is tuned for its workload (algorithm, storage, Redis dependency)
- Changes to one surface don't affect others
- Eval engine stays Redis-free (intentional design)
- Existing implementation is production-proven

**Cons**:

- Code duplication across services (Lua scripts, fallback patterns)
- Operator must understand 6 different limiter behaviors
- No unified API for budget inspection

**Effort**: S (already implemented)

---

### Alternative C: Hybrid — Shared Core with Surface Adapters

**Description**: Extract the common patterns (Redis fallback, bounded in-memory maps, Lua script loading, observability hooks) into a shared `@abl/rate-limiter-core` package. Each surface provides a thin adapter that configures the algorithm and parameters.

**Pros**:

- Reduces code duplication while preserving per-surface tuning
- Common fallback/recovery/observability patterns tested once
- Surfaces can still use different algorithms (sliding window, fixed window, token bucket)
- Incremental migration path from current architecture

**Cons**:

- Adds a new package dependency
- Adapter complexity for surfaces with unique requirements (eval's 3-dimension counters)
- Token bucket is architecturally different from window-based limiters

**Effort**: M (medium)

---

### Recommendation

**Continue with Alternative B (current architecture)** for the immediate term. The existing purpose-built limiter approach is production-proven and correct for the diverse workload patterns across services. The primary investment should be in:

1. Closing the test coverage gap (Redis-backed E2E, eval tests)
2. Improving operator visibility (usage inspection APIs)
3. Documenting the architectural rationale for per-surface implementations

Alternative C (shared core) is a reasonable future evolution if code duplication becomes a maintenance burden, but it should not block the current quality improvements.

---

## 3. Architecture

### System Context Diagram

```
┌─────────────────────────────────────────────────────────┐
│                     External Clients                     │
│  (SDK, Chat, Admin, A2A, MCP, Browsers, Provider APIs)  │
└───────────┬──────────┬──────────┬───────────┬───────────┘
            │          │          │           │
            ▼          ▼          ▼           ▼
     ┌──────────┐ ┌──────────┐ ┌─────────┐ ┌──────────────┐
     │ Runtime  │ │ SearchAI │ │ Studio  │ │ Connectors   │
     │ (HTTP/WS)│ │ (HTTP)   │ │ (HTTP)  │ │ (Provider)   │
     └────┬─────┘ └────┬─────┘ └────┬────┘ └──────┬───────┘
          │            │            │              │
          ▼            ▼            ▼              ▼
     ┌──────────┐ ┌──────────┐ ┌─────────┐ ┌──────────────┐
     │ Hybrid   │ │ Fixed    │ │ Sliding │ │ Token Bucket │
     │ Sliding  │ │ Window   │ │ Window  │ │ (in-memory)  │
     │ Window   │ │ Limiter  │ │ + Redis │ │              │
     └────┬─────┘ └────┬─────┘ └────┬────┘ └──────────────┘
          │            │            │
          ▼            ▼            ▼
     ┌────────────────────────────────┐
     │         Redis (shared)         │
     │  - Sorted sets (sliding)       │
     │  - Counters (fixed window)     │
     │  - Sets (session tracking)     │
     └────────────────────────────────┘
          │
          ▼ (fallback)
     ┌────────────────────────────────┐
     │    In-Memory Maps (bounded)    │
     │  - Per-service fallback        │
     │  - Auto-recovery to Redis      │
     └────────────────────────────────┘

     ┌──────────────┐  ┌────────────────┐
     │ Eval Engine  │  │ Agent Transfer │
     │ (in-memory   │  │ (Redis sorted  │
     │  counters)   │  │  set, no       │
     │              │  │  fallback)     │
     └──────────────┘  └────────────────┘
```

### Component Diagram

```
Runtime Rate Limiting Stack:
┌─────────────────────────────────────────┐
│           tenantRateLimit()             │ ← Express middleware
│  - Resolves plan limits                 │
│  - Per-API-key sub-limit check          │
│  - Tenant limit check                  │
│  - 429 + headers on rejection           │
├─────────────────────────────────────────┤
│       checkSessionMessageRate()         │ ← Per-session helper
│       recordTokenUsage()                │ ← Post-LLM helper
│       claimSessionSlot()                │ ← Concurrent session
│       WSConnectionRateLimiter           │ ← WebSocket flood
├─────────────────────────────────────────┤
│         HybridRateLimiter               │ ← Orchestrator
│  ┌─────────────┐  ┌─────────────────┐  │
│  │ Redis       │  │ InMemory        │  │
│  │ RateLimiter │  │ RateLimiter     │  │
│  │ (Lua ZSET)  │  │ (Map, 50k cap)  │  │
│  └─────────────┘  └─────────────────┘  │
│  - Auto-recovery timer (30s)            │
│  - Fallback metrics                     │
├─────────────────────────────────────────┤
│         TenantConfigService             │ ← Plan resolution
│  - Redis cache → DB → plan defaults    │
└─────────────────────────────────────────┘
```

### Data Flow: Runtime Request Rate Limiting

```
1. HTTP Request arrives at Runtime route
2. Auth middleware sets req.tenantContext (tenantId, apiKeyId, authType)
3. tenantRateLimit('request') middleware executes:
   a. Resolve plan-based limits via TenantConfigService.getConfigAsync(tenantId)
   b. Apply per-route overrides if configured
   c. Check if limit === -1 (unlimited) → skip, call next()
   d. If authType === 'api_key':
      - Compute perKeyLimit = max(10, floor(limit / API_KEY_DIVISOR))
      - HybridRateLimiter.check(apiKey:{keyId}, operation, perKeyLimit)
      - If rejected → 429 with per-key headers
   e. HybridRateLimiter.check(tenant:{tenantId}, operation, limit)
      - Try Redis (Lua ZSET sliding window):
        ZREMRANGEBYSCORE → ZCARD → ZADD (if under limit) → EXPIRE
      - On Redis error: fall back to InMemoryRateLimiter.check()
   f. Set X-RateLimit-* headers
   g. If rejected → 429 with tenant headers + recordRateLimitRejection()
   h. If allowed → call next()
```

### Sequence Diagram: Redis Fallback and Recovery

```
Runtime Pod          HybridRateLimiter        Redis           InMemoryLimiter
    │                      │                    │                    │
    │──check()────────────>│                    │                    │
    │                      │──evalsha(LUA)──────>│                    │
    │                      │<──[allowed,rem,ms]──│                    │
    │<──{allowed:true}─────│                    │                    │
    │                      │                    │                    │
    │  ... Redis goes down ...                  X                    │
    │                      │                    │                    │
    │──check()────────────>│                    │                    │
    │                      │──evalsha(LUA)──────>│                    │
    │                      │<──CONNECTION ERROR───│                    │
    │                      │                    │                    │
    │                      │  usingRedis=false  │                    │
    │                      │  recordFallback()  │                    │
    │                      │  startRecoveryTimer│                    │
    │                      │                    │                    │
    │                      │──check()──────────────────────────────>│
    │                      │<──{allowed,rem,ms}────────────────────│
    │<──{allowed:true}─────│                    │                    │
    │                      │                    │                    │
    │  ... 30s recovery timer fires ...         │                    │
    │                      │──ping()────────────>│                    │
    │                      │<──OK────────────────│                    │
    │                      │  usingRedis=true   │                    │
    │                      │  recordRecovery()  │                    │
    │                      │                    │                    │
    │──check()────────────>│                    │                    │
    │                      │──evalsha(LUA)──────>│                    │
    │                      │<──[allowed,rem,ms]──│                    │
    │<──{allowed:true}─────│                    │                    │
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

#### 1. Tenant Isolation

All rate-limit state is keyed by tenant:

- **Runtime**: `rl:tenant:{tenantId}:{operation}` for request/token/tool limits
- **SearchAI**: `search-ai:rl:{tenantId}` for request limits
- **Studio**: `rl:studio:{routePath}:t:{tenantId}` for tenant-scoped routes
- **Agent Transfer**: `at_ratelimit:{tenantId}` for transfer operations
- **Session slots**: `sessions:active:{tenantId}` (Redis SET per tenant)

One tenant's consumption cannot affect another tenant's budget. Each tenant's counters are in separate Redis keys with independent TTLs.

#### 2. Data Access Pattern

- **Primary**: Redis Lua scripts for atomic check-and-increment (EVALSHA with SHA caching)
- **Fallback**: In-memory Maps with bounded size (50k Runtime, 10k SearchAI/Studio, 1k Eval)
- **Caching**: TenantConfigService caches plan limits in Redis L1, then MongoDB
- **Pattern**: No repository layer — direct Redis interaction via Lua scripts for atomicity

#### 3. API Contract

**Request**: Rate limiting is transparent middleware. No request changes needed.

**Response on rejection** (consistent across Runtime and SearchAI):

```json
{
  "error": "Rate limit exceeded",
  "operation": "request",
  "limit": 100,
  "retryAfterMs": 45000
}
```

**Headers** (all surfaces):

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1711152000
```

Status code: `429 Too Many Requests`.

**Per-key rejection** (Runtime only):

```json
{
  "error": "API key rate limit exceeded",
  "operation": "request",
  "limit": 20,
  "retryAfterMs": 45000
}
```

#### 4. Security Surface

- **Auth required**: Rate limiting runs AFTER auth middleware. Unauthenticated requests fall back to IP-based keys.
- **Key namespace isolation**: Each service uses distinct key prefixes (`rl:`, `search-ai:rl:`, `rl:studio:`, `at_ratelimit:`, `sessions:active:`) to prevent collisions.
- **Per-key sub-limits**: Prevent one leaked API key from exhausting entire tenant budget.
- **Conditional ZADD**: Agent-transfer Lua script prevents memory amplification from rejected-request floods.
- **Bounded maps**: All in-memory fallbacks have max-entry caps with eviction to prevent memory exhaustion attacks.

### Behavioral Concerns

#### 5. Error Model

| Failure Scenario          | Behavior                                    | User Experience                             |
| ------------------------- | ------------------------------------------- | ------------------------------------------- |
| Rate limit exceeded       | 429 with headers and retryAfterMs           | Client retries after specified interval     |
| Redis unavailable         | Silent fallback to in-memory; auto-recovery | No user-visible error; single-pod semantics |
| TenantConfigService fails | Falls back to DEFAULT_LIMITS                | Slightly different limits; no error         |
| Lua script NOSCRIPT       | Falls back to EVAL + re-caches SHA          | No user-visible delay                       |
| In-memory map at capacity | Evicts oldest/expired entry                 | Possible brief counter reset                |

#### 6. Failure Modes

- **Redis partition**: HybridRateLimiter falls back to memory. Recovery timer polls every 30s. During partition, limits are per-pod, not distributed.
- **Redis latency spike**: Lua script executes atomically server-side; client timeout would trigger fallback.
- **Memory pressure**: All in-memory maps are bounded. Cleanup intervals prevent unbounded growth.
- **Agent-transfer Redis unavailable**: No fallback; transfer operations fail. This is a known GAP-006.

#### 7. Idempotency

- Rate-limit checks are inherently non-idempotent (each check increments the counter).
- The per-key check before tenant check can cause slight pessimism (key counter incremented even if tenant check later rejects), but this is acceptable because tenant limits are 5x per-key limits.
- Session slot claim/release uses Redis SET (SADD is idempotent for the same sessionId).

#### 8. Observability

- **Metrics**: `recordRateLimitRejection({ tenantId, operation })` via OpenTelemetry counters
- **Fallback metrics**: `recordRateLimiterFallback('redis_to_memory' | 'memory_to_redis')`
- **Eval metrics**: `rateLimitRejections` counter and `rateLimitQueueDepth` gauge per tenant
- **Structured logging**: All services use `createLogger()` for rejection, fallback, and error events
- **Admin inspection**: `getTenantEvalUsage()` for eval; no equivalent for Runtime/SearchAI yet (GAP-004)

### Operational Concerns

#### 9. Performance Budget

| Operation                           | Target Latency | Notes                                 |
| ----------------------------------- | -------------- | ------------------------------------- |
| Redis Lua sliding window check      | < 1ms p99      | Single atomic Redis round-trip        |
| Redis INCR fixed window check       | < 0.5ms p99    | Simpler Lua script                    |
| In-memory sliding window check      | < 0.1ms p99    | Map lookup + array manipulation       |
| Token bucket acquire (no wait)      | < 0.01ms       | Pure arithmetic                       |
| TenantConfigService plan resolution | < 5ms p99      | Redis cache hit; 50ms+ on DB fallback |
| Session slot claim (Redis)          | < 1ms p99      | Single Lua EVAL                       |

**Payload sizes**: Rate-limit state is small (ZSET with ~100 members per tenant per window). Session sets are bounded by concurrent session cap.

#### 10. Migration Path

No data migration needed. The current architecture is production-deployed. Future improvements are additive:

1. **Phase 1**: Add Redis-backed E2E tests (no code changes)
2. **Phase 2**: Add eval rate limiter tests (no code changes)
3. **Phase 3**: Add tenant budget inspection APIs (new endpoints)
4. **Phase 4** (future): Consider shared core extraction if duplication becomes a burden

#### 11. Rollback Plan

Rate limiting is middleware — it can be bypassed per-route by:

1. Removing `tenantRateLimit()` from route registration
2. Setting plan limit to `-1` (unlimited) for affected tenants
3. Setting `RATE_LIMITER_MAX_ENTRIES=0` to effectively disable enforcement (forced cleanup on every request)

For SearchAI: Set `SEARCH_AI_RATE_LIMIT` to a very high number.

Each surface's limiter is independent, so rolling back one does not affect others.

#### 12. Test Strategy

| Level       | Count | Focus                                                           |
| ----------- | ----- | --------------------------------------------------------------- |
| Unit        | 12+   | Individual limiter algorithms, plan mapping, key building       |
| Integration | 7     | Redis Lua atomicity, fallback transitions, session slots, evals |
| E2E         | 7     | Full HTTP flow with real servers, tenant isolation, 429 headers |
| Load        | 4     | Concurrent requests, multi-pod fairness, memory bounds          |

**Coverage target**: 80% of FRs covered at integration+ level. All FRs covered at unit level (current state).

**Test infrastructure**: Real Redis via Docker for integration/E2E. Real Express servers on random ports for E2E. No mocking of codebase components in E2E.

---

## 5. Data Model

No new collections or tables are needed. The feature uses ephemeral Redis data structures:

| Store Type    | Key Pattern                      | Service        | TTL / Lifecycle                  |
| ------------- | -------------------------------- | -------------- | -------------------------------- |
| Redis ZSET    | `rl:{scope}:{operation}`         | Runtime        | `ceil(windowMs/1000) + 10s`      |
| Redis ZSET    | `rl:studio:{route}:{scope}:{id}` | Studio         | `ceil(windowMs/1000) + 10s`      |
| Redis ZSET    | `at_ratelimit:{tenantId}`        | Agent Transfer | PEXPIRE with windowMs            |
| Redis Counter | `search-ai:rl:{key}`             | SearchAI       | PEXPIRE with windowMs            |
| Redis SET     | `sessions:active:{tenantId}`     | Runtime        | SESSION_SET_TTL_SECONDS (48h)    |
| In-Memory Map | Various per-service              | All            | Bounded by MAX_ENTRIES + cleanup |

---

## 6. API Design

### Existing Endpoints (no changes needed)

Rate limiting is applied as middleware on existing endpoints. No new CRUD endpoints are planned in the current phase.

### Planned Endpoints (future Phase 3)

| Method | Path                              | Purpose                          | Auth                |
| ------ | --------------------------------- | -------------------------------- | ------------------- |
| GET    | `/api/v1/admin/rate-limits/usage` | Tenant budget consumption report | platform-admin      |
| GET    | `/api/v1/rate-limits/status`      | Current tenant's usage snapshot  | tenant-admin or SDK |

### Error Responses

All rate-limit rejections return:

```json
{
  "error": "Rate limit exceeded" | "API key rate limit exceeded",
  "operation": "request" | "llm_tokens" | "tool_call" | "session" | "session_message",
  "limit": <number>,
  "retryAfterMs": <number>
}
```

Status: `429 Too Many Requests`
Headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`

---

## 7. Cross-Cutting Concerns

### Audit Logging

Rate-limit rejections are logged via structured logging (`createLogger()`). No audit trail to MongoDB is needed for ephemeral rate-limit state. If tenant budget inspection APIs are added (future), those should produce audit events.

### Rate Limiting (Meta)

The rate-limiting system itself is not rate-limited (that would create infinite recursion). However, the plan resolution path through `TenantConfigService` is cached in Redis to prevent excessive DB reads.

### Caching

- **Plan limits**: Cached in Redis by TenantConfigService (L1 cache with TTL)
- **Lua script SHA**: Cached per RedisRateLimiter instance (EVALSHA optimization)
- **Rate-limit state**: Redis is the cache (ephemeral by design)

### Encryption

- Redis connections use TLS in production (configured at infrastructure level)
- No PII in rate-limit keys (tenant IDs, API key IDs, session IDs, IPs)
- No encryption at rest needed for ephemeral counters

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency          | Risk     | Mitigation                                                |
| ------------------- | -------- | --------------------------------------------------------- |
| Redis               | Medium   | In-memory fallback for all services except agent-transfer |
| TenantConfigService | Low      | Falls back to DEFAULT_LIMITS on failure                   |
| Auth middleware     | Low      | Falls back to IP-based keys if no tenant context          |
| OpenTelemetry       | Very Low | Metrics are optional; logging is always available         |

### Downstream (depends on this feature)

| Dependent          | Impact | Notes                                          |
| ------------------ | ------ | ---------------------------------------------- |
| SDK init/refresh   | High   | Bootstrap flow is rate-limited                 |
| Chat/WebSocket     | High   | Session messages and connections are throttled |
| SearchAI ingestion | Medium | Search queries are throttled per tenant        |
| Connector sync     | Medium | Provider API calls are paced                   |
| Eval pipeline      | Medium | LLM calls and concurrent runs are capped       |
| Agent transfer     | Low    | Transfer operations are throttled              |
| Studio API routes  | Low    | Auth and admin routes are throttled            |

---

## 9. Open Questions & Decisions Needed

1. **Studio implementation convergence**: Should the two Studio rate-limit implementations (`rate-limit.ts` and `rate-limiter.ts`) be merged? The current split serves different use cases but increases maintenance burden.

2. **Eval Redis adoption**: Should the eval rate limiter migrate to Redis for multi-worker fairness? Currently intentionally local. The trade-off is correctness under multi-worker deployments vs. added Redis dependency.

3. **Operator dashboard**: What form should the unified rate-limit usage dashboard take? Options: Grafana dashboard from OTEL metrics, dedicated admin API endpoints, or Coroot integration.

4. **Agent-transfer fallback**: Should agent-transfer add an in-memory fallback, or is Redis availability a hard requirement for transfer security?

---

## 10. References

- Feature spec: [docs/features/rate-limiting.md](../features/rate-limiting.md)
- Test spec: [docs/testing/rate-limiting.md](../testing/rate-limiting.md)
- Prior audit: `docs/archive/plans-2026-02/2026-02-25-rate-limits-circuit-breakers-audit.md`
- Gap fixes: `docs/archive/plans-2026-02/2026-02-28-rate-limits-circuit-breakers-gap-fixes.md`
- Config schema: `packages/config/src/schemas/rate-limit.schema.ts`
