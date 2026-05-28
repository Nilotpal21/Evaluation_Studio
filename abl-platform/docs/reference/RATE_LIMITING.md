# Rate Limiting Reference

> Comprehensive documentation of all rate limiting implementations, environment variables, plan-based limits, and database seed data across the ABL platform.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Plan-Based Limits](#plan-based-limits)
- [Service-Specific Rate Limiters](#service-specific-rate-limiters)
  - [Runtime](#1-runtime-appsruntime)
  - [Search-AI](#2-search-ai-appssearch-ai)
  - [Agent Transfer](#3-agent-transfer-packagesagent-transfer)
  - [Studio](#4-studio-appsstudio)
  - [Multimodal Service](#5-multimodal-service-appsmultimodal-service)
- [Database Models](#database-models)
- [Database Seed Data](#database-seed-data)
- [Configuration Resolution Chain](#configuration-resolution-chain)
- [Environment Variables — Complete Reference](#environment-variables--complete-reference)
- [HTTP Response Format](#http-response-format)

---

## Architecture Overview

All rate limiters share these design principles:

- **Redis primary + in-memory fallback** — every implementation degrades gracefully when Redis is unavailable
- **Per-tenant scoping** — tenant isolation is the default boundary
- **Sliding or fixed window** — 60-second windows across all services
- **Lua scripts** — atomic Redis operations prevent race conditions in distributed deployments
- **Standard HTTP headers** — `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`
- **429 Too Many Requests** — consistent error response with `retryAfterMs`

---

## Plan-Based Limits

Defined in `apps/runtime/src/services/tenant-config.ts` → `PLAN_LIMITS`.

Types defined in `packages/config/src/tenant-config-types.ts` → `TenantLimits`.

### Rate Limits by Plan

| Limit                   | FREE   | TEAM    | BUSINESS | ENTERPRISE         |
| ----------------------- | ------ | ------- | -------- | ------------------ |
| `requestsPerMinute`     | 60     | 300     | 1,000    | 5,000              |
| `tokensPerMinute`       | 50,000 | 200,000 | 500,000  | **-1** (unlimited) |
| `toolCallsPerMinute`    | 50     | 200     | 500      | **-1** (unlimited) |
| `maxConcurrentSessions` | 5      | 50      | 500      | **-1** (unlimited) |
| `messagesPerMonth`      | 1,000  | 50,000  | 500,000  | **-1** (unlimited) |

### Resource Limits by Plan

| Limit                       | FREE            | TEAM            | BUSINESS        | ENTERPRISE         |
| --------------------------- | --------------- | --------------- | --------------- | ------------------ |
| `maxServiceTimeoutMs`       | 10,000 (10s)    | 30,000 (30s)    | 45,000 (45s)    | 60,000 (60s)       |
| `maxResponseBodyBytes`      | 524,288 (512KB) | 2,097,152 (2MB) | 5,242,880 (5MB) | 10,485,760 (10MB)  |
| `maxConcurrentServiceCalls` | 3               | 10              | 25              | 50                 |
| `maxPendingTimers`          | 100             | 1,000           | 10,000          | 100,000            |
| `maxAgentsPerProject`       | 3               | 20              | 100             | **-1** (unlimited) |
| `maxEventTypesPerApp`       | 10              | 50              | 100             | 200                |
| `maxProjectsPerOrg`         | 3               | 20              | 100             | **-1** (unlimited) |

### Retention Limits by Plan

| Limit                   | FREE | TEAM | BUSINESS | ENTERPRISE      |
| ----------------------- | ---- | ---- | -------- | --------------- |
| `traceRetentionDays`    | 7    | 30   | 90       | 365             |
| `sessionRetentionDays`  | 7    | 30   | 90       | 365             |
| `auditLogRetentionDays` | 30   | 90   | 365      | 2,555 (7 years) |
| `messageRetentionDays`  | 30   | 90   | 365      | 730 (2 years)   |

### Security Settings by Plan

| Setting                | FREE           | TEAM           | BUSINESS      | ENTERPRISE    |
| ---------------------- | -------------- | -------------- | ------------- | ------------- |
| `sessionMaxAgeSeconds` | 3,600 (1h)     | 28,800 (8h)    | 28,800 (8h)   | 86,400 (24h)  |
| `sessionIdleSeconds`   | 600 (10m)      | 1,800 (30m)    | 3,600 (1h)    | 7,200 (2h)    |
| `apiKeyMaxAgeDays`     | 90             | 180            | 365           | 365           |
| `requireMfa`           | false          | false          | true          | true          |
| `scrubPII`             | env-controlled | env-controlled | **always on** | **always on** |

### Feature Flags by Plan

| Feature             | FREE | TEAM | BUSINESS | ENTERPRISE |
| ------------------- | ---- | ---- | -------- | ---------- |
| `customModels`      | -    | yes  | yes      | yes        |
| `ssoEnabled`        | -    | -    | yes      | yes        |
| `mfaEnabled`        | -    | yes  | yes      | yes        |
| `auditLogExport`    | -    | -    | yes      | yes        |
| `dataResidency`     | -    | -    | -        | yes        |
| `customDomains`     | -    | -    | yes      | yes        |
| `prioritySupport`   | -    | -    | yes      | yes        |
| `advancedAnalytics` | -    | -    | yes      | yes        |
| `advancedNlu`       | -    | -    | -        | yes        |
| `archiveEnabled`    | -    | -    | yes      | yes        |

> **Note:** `-1` means unlimited. The `checkLimit()` method treats `-1` as always passing.

---

## Service-Specific Rate Limiters

### 1. Runtime (`apps/runtime`)

**Source files:**

- `apps/runtime/src/middleware/rate-limiter.ts` — middleware, types, in-memory fallback
- `apps/runtime/src/services/resilience/hybrid-rate-limiter.ts` — Redis + in-memory hybrid
- `apps/runtime/src/services/resilience/redis-rate-limiter.ts` — Redis ZSET sliding window

**The most comprehensive rate limiter in the platform.** Tracks 5 operation types per tenant.

#### Operation Types

| Operation         | Description                | Default Limit (fallback) | Window |
| ----------------- | -------------------------- | ------------------------ | ------ |
| `request`         | General API requests       | 100/min                  | 60s    |
| `llm_tokens`      | LLM token consumption      | 100,000/min              | 60s    |
| `session`         | Concurrent active sessions | 50                       | —      |
| `tool_call`       | Tool invocations           | 200/min                  | 60s    |
| `session_message` | Messages per session       | 30/min                   | 60s    |

> These fallback defaults (`DEFAULT_LIMITS`) are used only when plan-based resolution fails. Normal operation uses `PLAN_LIMITS` above.

#### Per-API-Key Sub-Limiting

When `authType === 'api_key'`, the system applies a stricter per-key limit **before** checking the tenant limit to avoid quota consumption:

```
per_key_limit = max(tenant_limit / RATE_LIMITER_API_KEY_DIVISOR, 10)
```

Default divisor: **5** (configurable via `RATE_LIMITER_API_KEY_DIVISOR`).

#### Session Management

- Active sessions tracked via Redis SETs with Lua scripts (atomic check-and-add)
- Key format: `sessions:active:{tenantId}`
- TTL safety net: 48 hours (configurable via `SESSION_SET_TTL_SECONDS`)
- In-memory fallback with LRU eviction when Redis unavailable

#### Redis Key Format

- Rate limits: `rl:{tenantId}:{operation}` (ZSET, score = timestamp)
- Sessions: `sessions:active:{tenantId}` (SET)
- Config cache: `cfg:{tenantId}` (STRING, TTL 300s)

#### Environment Variables

| Variable                           | Default          | Description                                                |
| ---------------------------------- | ---------------- | ---------------------------------------------------------- |
| `RATE_LIMITER_MAX_ENTRIES`         | `50000`          | Max entries in in-memory rate limiter Map                  |
| `RATE_LIMITER_CLEANUP_INTERVAL_MS` | `300000` (5 min) | Interval for expired entry cleanup                         |
| `RATE_LIMITER_CLEANUP_GRACE_MS`    | `120000` (2 min) | Grace period before evicting expired entries               |
| `RATE_LIMITER_API_KEY_DIVISOR`     | `5`              | Divisor for per-API-key sub-limits (min limit: 10)         |
| `SESSION_MESSAGE_RATE_LIMIT`       | `30`             | Max messages per session per minute                        |
| `SESSION_SET_TTL_SECONDS`          | `172800` (48h)   | TTL for active session set in Redis (pod crash safety net) |
| `SESSION_COUNT_MAX_MEMORY_ENTRIES` | `10000`          | Max in-memory session tracking entries                     |
| `REDIS_RECOVERY_INTERVAL_MS`       | `30000` (30s)    | How often hybrid limiter checks if Redis has recovered     |

---

### 2. Search-AI (`apps/search-ai`)

**Source file:** `apps/search-ai/src/middleware/rate-limit.ts`

Per-tenant **fixed-window** rate limiting with self-healing Lua script.

#### Defaults

| Setting            | Default   |
| ------------------ | --------- |
| Requests/minute    | 120       |
| Window             | 60,000 ms |
| Max memory entries | 10,000    |

#### Redis Key Format

`search-ai:rl:{tenantId}` (STRING with PEXPIRE)

#### Lua Script Features

- Atomic `INCR` + conditional `PEXPIRE` on first request in window
- Self-heals orphaned keys where `PTTL = -1` (TTL lost due to crash)
- Returns `{count, ttl_ms}`

#### Tenant Resolution

Extracts `tenantId` from request context. Falls back to IP address, then `"anon"` if no tenant context.

#### Environment Variables

| Variable                               | Default | Description                           |
| -------------------------------------- | ------- | ------------------------------------- |
| `SEARCH_AI_RATE_LIMIT`                 | `120`   | Requests per window per tenant        |
| `SEARCH_AI_RATE_WINDOW_MS`             | `60000` | Window duration in milliseconds       |
| `SEARCH_AI_RATE_MAX_MEMORY_ENTRIES`    | `10000` | Max entries in in-memory fallback Map |
| `SEARCH_AI_REDIS_RECOVERY_INTERVAL_MS` | `30000` | Redis recovery check interval         |

---

### 3. Agent Transfer (`packages/agent-transfer`)

**Source files:**

- `packages/agent-transfer/src/security/rate-limiter.ts` — implementation
- `packages/agent-transfer/src/config/schema.ts` — Zod config schema

Per-tenant **sliding-window** rate limiting for agent-to-agent transfers.

#### Defaults

| Setting              | Default   |
| -------------------- | --------- |
| Max transfers/minute | 100       |
| Window               | 60,000 ms |

#### Zod Config Schema

```typescript
const RateLimitConfigSchema = z.object({
  maxTransfers: z.number().default(100),
  windowMs: z.number().default(60000),
});
```

#### Redis Key Format

`at_ratelimit:{tenantId}` (ZSET, member = `{timestamp}:{random}`)

#### Lua Script Features

- Prunes expired entries via `ZREMRANGEBYSCORE`
- Counts remaining via `ZCARD`
- Only adds entry if under limit (no memory amplification from rejected requests)
- Returns: `count+1` if allowed, `-1` if rejected

#### Environment Variables

No direct environment variables. Configuration passed via `RateLimitConfig` object (typically loaded from app config).

---

### 4. Studio (`apps/studio`)

**Source files:**

- `apps/studio/src/lib/rate-limit.ts` — Redis-backed async helper
- `apps/studio/src/lib/rate-limiter.ts` — in-memory singleton class

Two implementations: one Redis-backed (async), one in-memory (sync).

#### Scoping Options

```typescript
enum RateLimitScope {
  TENANT = 'tenant', // One bucket per tenant (all users share)
  USER = 'user', // One bucket per user within tenant (default)
  IP = 'ip', // One bucket per source IP
}
```

#### Key Format

`rl:{routePath}:{scope_prefix}:{identifiers}`

Examples:

- Tenant: `rl:/api/agents:t:tenant-123`
- User: `rl:/api/agents:u:tenant-123:user-456`
- IP: `rl:/api/agents:ip:192.168.1.1`

#### Redis Helper

- Key prefix: `rl:studio:{key}`
- ZSET sliding window with Lua script
- TTL: `ceil(windowMs / 1000) + 10` seconds

#### In-Memory Singleton

- Class: `SlidingWindowRateLimiter`
- Max entries: 10,000 (hard-coded)
- LRU eviction when capacity reached
- Default window: 60,000 ms

#### Environment Variables

No environment variables. All configuration is hard-coded or per-route.

---

### 5. Multimodal Service (`apps/multimodal-service`)

**Source file:** `apps/multimodal-service/src/security/upload-rate-limiter.ts`

Per-tenant rate limiting for file uploads using the `rate-limiter-flexible` library.

#### Defaults

| Setting        | Default    |
| -------------- | ---------- |
| Uploads/minute | 50         |
| Window         | 60 seconds |

#### Fail-Open Policy

Returns `{ allowed: true }` on Redis infrastructure errors. Distinguishes infrastructure errors from actual rate limit rejections — uploads are never blocked by Redis outages.

#### Redis Key Prefix

`upload-rate`

#### Environment Variables

| Variable                           | Default | Description                           |
| ---------------------------------- | ------- | ------------------------------------- |
| `UPLOAD_RATE_LIMIT_MAX_PER_WINDOW` | `50`    | Maximum uploads per window per tenant |
| `UPLOAD_RATE_LIMIT_WINDOW_SECONDS` | `60`    | Window duration in seconds            |

---

## Database Models

### TenantLLMPolicy

**Source:** `packages/database/src/models/tenant-llm-policy.model.ts`

Rate-limit-relevant fields:

| Field                     | Type       | Description                                        |
| ------------------------- | ---------- | -------------------------------------------------- |
| `maxRequestsPerMinute`    | `number`   | LLM API request cap per tenant per minute          |
| `monthlyTokenBudget`      | `number`   | Monthly token spending cap                         |
| `dailyTokenBudget`        | `number`   | Daily token spending cap                           |
| `allowedProviders`        | `string[]` | Allowed LLM providers (empty = all)                |
| `credentialPolicy`        | `string`   | `org_first`, `user_first`, `org_only`, `user_only` |
| `allowProjectCredentials` | `boolean`  | Whether projects can use their own credentials     |

**MongoDB collection:** `tenant_llm_policies`
**Unique index:** `tenantId`

### TenantCrawlPolicy

**Source:** `packages/database/src/models/tenant-crawl-policy.model.ts`

Rate-limit-relevant fields:

| Field                             | Type      | Description                         |
| --------------------------------- | --------- | ----------------------------------- |
| `compliance.maxRequestsPerSecond` | `number`  | Web crawl rate per domain pattern   |
| `compliance.respectRobotsTxt`     | `boolean` | robots.txt compliance               |
| `limits.maxBatchSize`             | `number`  | Max batch size for crawl operations |
| `limits.maxConcurrency`           | `number`  | Max concurrent crawl workers        |
| `limits.maxMemoryMB`              | `number`  | Memory cap per crawl batch          |
| `limits.maxDurationMinutes`       | `number`  | Timeout for crawl operations        |

### Subscription (Plan Resolution)

Rate limits are resolved from the `Subscription` model:

| Field                                            | Description                                         |
| ------------------------------------------------ | --------------------------------------------------- |
| `planTier`                                       | Plan name: `FREE`, `TEAM`, `BUSINESS`, `ENTERPRISE` |
| `tenantQuotas[].allocatedLimits`                 | Per-tenant overrides (any `TenantLimits` field)     |
| `tenantQuotas[].projectQuotas[].allocatedLimits` | Per-project overrides                               |

---

## Database Seed Data

### Seed Script

**File:** `packages/database/seed-mongo.ts`

**Platform/core only:** `pnpm seed:core`

**Local dev fixtures:** `pnpm seed:dev`

**Fresh dev mode (drops DB):** `pnpm tsx packages/database/seed-mongo.ts --fresh --dev`

### Seeded TenantLLMPolicy

Tenant bootstrap now ensures a `TenantLLMPolicy` for any workspace seeded via `--tenant`, `--workspace-email`, or `--dev`. In local development, `pnpm seed:dev` creates the following policy for the dev tenant (`tenant-dev-001`):

```javascript
{
  _id: 'policy-dev-001',
  tenantId: 'tenant-dev-001',
  allowedProviders: [],           // empty = all providers allowed
  credentialPolicy: 'org_first',
  monthlyTokenBudget: 10_000_000, // 10M tokens/month
  dailyTokenBudget: 1_000_000,    // 1M tokens/day
  defaultModel: null,
  defaultFastModel: null,
  maxRequestsPerMinute: 100,
  allowProjectCredentials: true,
  platformDemoEnabled: false,
}
```

### Seeded Tenant

```javascript
{
  _id: 'tenant-dev-001',
  name: 'Dev Workspace',
  slug: 'dev-workspace',
  ownerId: 'user-dev-001',
  retentionDays: 30,
  settings: { features: { voice: true, sso: false } },
  status: 'active',
}
```

### Effective Dev Limits

Since there is no `Subscription` record for `tenant-dev-001` in the seed, the `TenantConfigService` falls back to **TEAM plan defaults** (safe fail-open — TEAM is chosen over FREE because FREE's aggressive idle timeouts and 7-day retention risk data loss):

| Limit                               | Effective Value | Source                        |
| ----------------------------------- | --------------- | ----------------------------- |
| `requestsPerMinute`                 | 300             | TEAM plan default             |
| `tokensPerMinute`                   | 200,000         | TEAM plan default             |
| `toolCallsPerMinute`                | 200             | TEAM plan default             |
| `maxConcurrentSessions`             | 50              | TEAM plan default             |
| `messagesPerMonth`                  | 50,000          | TEAM plan default             |
| `maxRequestsPerMinute` (LLM policy) | 100             | Seeded TenantLLMPolicy        |
| `monthlyTokenBudget`                | 10,000,000      | Seeded TenantLLMPolicy        |
| `dailyTokenBudget`                  | 1,000,000       | Seeded TenantLLMPolicy        |
| `sessionRetentionDays`              | 30              | Tenant.retentionDays override |

### Custom Seed for Production

To seed a production-like tenant with specific rate limits, create a `Subscription` document:

```javascript
// Example: seed an ENTERPRISE subscription with custom quotas
db.subscriptions.insertOne({
  tenantId: 'tenant-prod-001',
  planTier: 'ENTERPRISE',
  status: 'active',
  tenantQuotas: [
    {
      tenantId: 'tenant-prod-001',
      allocatedLimits: {
        requestsPerMinute: 10000, // Custom override (default: 5000)
        tokensPerMinute: -1, // Unlimited
        maxConcurrentSessions: -1, // Unlimited
      },
      projectQuotas: [
        {
          projectId: 'proj-critical-001',
          allocatedLimits: {
            requestsPerMinute: 2000, // Project-level cap
            toolCallsPerMinute: 1000,
          },
        },
      ],
    },
  ],
});
```

---

## Configuration Resolution Chain

Rate limits resolve in this order (later overrides earlier):

```
1. PLAN_LIMITS[plan]                     ← Plan defaults (tenant-config.ts)
2. Subscription.tenantQuotas[].allocatedLimits  ← Subscription-level overrides (DB)
3. Tenant.settings / Tenant.retentionDays       ← Tenant model overrides (DB)
4. TenantConfigService.setOverrides()            ← In-memory overrides (ephemeral)
5. Subscription.tenantQuotas[].projectQuotas[]   ← Project-level overrides (DB)
```

**Redis cache:** `cfg:{tenantId}`, TTL 300 seconds (5 minutes).

**Fail-open default:** If DB is unreachable, falls back to **TEAM plan** (not FREE — to avoid aggressive timeouts and short retention).

**Plan resolution:** Unknown or missing `planTier` defaults to `TEAM`.

---

## Environment Variables — Complete Reference

### Runtime Service (`apps/runtime`)

| Variable                           | Default  | Type    | Description                                  |
| ---------------------------------- | -------- | ------- | -------------------------------------------- |
| `RATE_LIMITER_MAX_ENTRIES`         | `50000`  | number  | Max entries in in-memory rate limiter        |
| `RATE_LIMITER_CLEANUP_INTERVAL_MS` | `300000` | ms      | Cleanup interval for expired entries         |
| `RATE_LIMITER_CLEANUP_GRACE_MS`    | `120000` | ms      | Grace period before eviction                 |
| `RATE_LIMITER_API_KEY_DIVISOR`     | `5`      | number  | Per-API-key limit divisor (min limit: 10)    |
| `SESSION_MESSAGE_RATE_LIMIT`       | `30`     | number  | Max messages per session per minute          |
| `SESSION_SET_TTL_SECONDS`          | `172800` | seconds | Redis TTL for active session sets            |
| `SESSION_COUNT_MAX_MEMORY_ENTRIES` | `10000`  | number  | Max in-memory session tracking entries       |
| `REDIS_RECOVERY_INTERVAL_MS`       | `30000`  | ms      | Hybrid limiter Redis recovery probe interval |
| `ENABLE_STRICT_PII_MODE`           | `false`  | boolean | Force PII scrubbing on FREE/TEAM plans       |

### Search-AI Service (`apps/search-ai`)

| Variable                               | Default | Type   | Description                    |
| -------------------------------------- | ------- | ------ | ------------------------------ |
| `SEARCH_AI_RATE_LIMIT`                 | `120`   | number | Requests per window per tenant |
| `SEARCH_AI_RATE_WINDOW_MS`             | `60000` | ms     | Rate limit window duration     |
| `SEARCH_AI_RATE_MAX_MEMORY_ENTRIES`    | `10000` | number | Max in-memory fallback entries |
| `SEARCH_AI_REDIS_RECOVERY_INTERVAL_MS` | `30000` | ms     | Redis recovery check interval  |

### Multimodal Service (`apps/multimodal-service`)

| Variable                           | Default | Type    | Description                            |
| ---------------------------------- | ------- | ------- | -------------------------------------- |
| `UPLOAD_RATE_LIMIT_MAX_PER_WINDOW` | `50`    | number  | Max file uploads per window per tenant |
| `UPLOAD_RATE_LIMIT_WINDOW_SECONDS` | `60`    | seconds | Upload rate limit window duration      |

### Redis (shared across services)

| Variable     | Default | Description                         |
| ------------ | ------- | ----------------------------------- |
| `REDIS_URL`  | —       | Full Redis connection URL           |
| `REDIS_HOST` | —       | Redis host (if not using REDIS_URL) |
| `REDIS_PORT` | `6379`  | Redis port (if not using REDIS_URL) |

---

## HTTP Response Format

### Rate Limit Headers (all services)

```
X-RateLimit-Limit: 300
X-RateLimit-Remaining: 287
X-RateLimit-Reset: 1710518400
```

### 429 Response Body

```json
{
  "error": "Rate limit exceeded",
  "operation": "request",
  "limit": 300,
  "retryAfterMs": 42000
}
```

### Session Limit Response (Runtime)

```json
{
  "error": "Concurrent session limit reached",
  "limit": 50,
  "retryAfterMs": 0
}
```
