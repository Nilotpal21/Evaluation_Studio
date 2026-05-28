# Studio--Runtime Isolation Plan

**Date**: 2026-03-14
**Status**: Consolidated from 3 implementation plans + 3 audit reports

---

## 1. Problem Statement

The platform runs a single `apps/runtime` process serving two fundamentally different consumer classes:

- **Studio IDE traffic** (`web_debug` channel): WebSocket connections from the Studio debug panel, HTTP API calls proxied from Studio's Next.js middleware, session lifecycle for iterative agent testing
- **Production channel traffic**: Inbound webhooks (Slack, WhatsApp, Teams, email), real-time WebSocket (SDK, voice), async HTTP channels

Both share the same Express process, the same BullMQ queues, the same LLM token budget, and the same rate limit counters. A developer hammering the Studio debug panel starves production end-users of LLM capacity and queue throughput. There is no separation.

**Specific failure modes today:**

1. A Studio load test saturates the `llm-requests` BullMQ queue. Production Slack messages wait behind hundreds of debug jobs.
2. Debug traffic depletes the tenant's `tokensPerMinute` budget. Production voice calls fail with backpressure errors.
3. Rate limit key `rl:tenant:{tenantId}:request` is shared -- debug and production requests consume from the same counter.

This plan addresses all three via layered isolation: channel classification, separate deployments, LLM quota separation, and tiered rate limiting.

---

## 2. Solution Architecture

Four layers work together, each independently deployable and rollback-safe:

```
                    ┌──────────────────────────────────────────────┐
                    │              STUDIO BROWSER                  │
                    └──────────────┬───────────────────────────────┘
                                   │ WebSocket (web_debug)
                    ┌──────────────▼───────────────────────────────┐
                    │         DEBUG RUNTIME (port 3115)            │
                    │   RUNTIME_MODE=debug                         │
                    │   BULLMQ_QUEUE_PREFIX=debug:                 │
                    │   ┌───────────────┐  ┌────────────────────┐  │
                    │   │ Rate Limiter  │  │ LLM Quota Tracker  │  │
                    │   │ tier=debug    │  │ pool=debug (10%)   │  │
                    │   │ 20% of plan   │  │                    │  │
                    │   └───────┬───────┘  └────────┬───────────┘  │
                    │           │                    │              │
                    │   ┌───────▼────────────────────▼───────────┐  │
                    │   │  debug:llm-requests (priority 10)     │  │
                    │   │  debug:channel-inbound                 │  │
                    │   └───────────────────────────────────────┘  │
                    └──────────────────────────────────────────────┘

     ┌─────────┐  ┌─────────┐  ┌──────────┐  ┌──────────┐
     │  Slack  │  │  Teams  │  │ WhatsApp │  │ SDK/a2a  │  ...
     └────┬────┘  └────┬────┘  └────┬─────┘  └────┬─────┘
          │            │            │              │
     ┌────▼────────────▼────────────▼──────────────▼──────┐
     │       PRODUCTION RUNTIME (port 3112)               │
     │   RUNTIME_MODE=production                          │
     │   ┌───────────────┐  ┌────────────────────┐        │
     │   │ Rate Limiter  │  │ LLM Quota Tracker  │        │
     │   │ tier=prod     │  │ pool=production     │        │
     │   │ 100% of plan  │  │ (90% of budget)     │        │
     │   └───────┬───────┘  └────────┬───────────┘        │
     │           │                    │                    │
     │   ┌───────▼────────────────────▼───────────┐        │
     │   │  llm-requests (priority 1)             │        │
     │   │  channel-inbound                       │        │
     │   └────────────────────────────────────────┘        │
     └─────────────────────────────────────────────────────┘
                    │                  │
              ┌─────▼──────┐    ┌──────▼──────┐
              │   Redis    │    │   MongoDB   │
              │  (shared)  │    │  (shared)   │
              └────────────┘    └─────────────┘
```

**Layer summary:**

| Layer          | Strategy                     | What It Solves                       |
| -------------- | ---------------------------- | ------------------------------------ |
| Foundation     | Channel tier classification  | Shared taxonomy for all other layers |
| Infrastructure | Separate Runtime deployments | Process/queue isolation              |
| Resource       | LLM quota separation         | Token budget isolation per pool      |
| Enforcement    | Channel-scoped rate limiting | Request rate isolation per tier      |

---

## 3. Channel Tier Model

Every channel is classified into one of three tiers. This classification is the foundation for rate limiting (tier multipliers), BullMQ priority (job ordering), and LLM quota (pool assignment).

### Resolution: `a2a` and `ag_ui` Classification

The architecture audit identified that `a2a` and `ag_ui` were classified as SDK tier (80% limit, priority 5) in the rate limiting plan but as production pool in the quota/deployment plans. Since `a2a` is an agent-to-agent protocol used for production workloads and `ag_ui` is a production-facing protocol, both are classified as **production tier** everywhere in this consolidated plan. This ensures production `a2a` workloads are never throttled at 80%.

### Tier Definitions

**Tier 1 -- Debug (lowest priority)**

- Channels: `web_debug`
- Rate limit: 20% of tenant plan limit
- BullMQ priority: 10 (processed last)
- LLM quota pool: `debug`
- Runtime: debug deployment only

**Tier 2 -- SDK (medium priority)**

- Channels: `web_chat`, `sdk_websocket`
- Rate limit: 80% of tenant plan limit
- BullMQ priority: 5
- LLM quota pool: `production`
- Runtime: production deployment

**Tier 3 -- Production (highest priority)**

- Channels: all webhook channels (`slack`, `msteams`, `whatsapp`, `messenger`, `instagram`, `twilio_sms`, `zendesk`, `telegram`, `line`, `email`, `http_async`, `genesys`), all voice channels (`vxml`, `korevg`, `audiocodes`, `voice_pipeline`, `voice`, `voice_twilio`, `voice_livekit`), synchronous API channels (`api`, `http`), and protocol channels (`a2a`, `ag_ui`)
- Rate limit: 100% of tenant plan limit
- BullMQ priority: 1 (processed first)
- LLM quota pool: `production`
- Runtime: production deployment
- Unknown future channels default to Tier 3 (fail-safe)

### Core Module: `channel-priority.ts`

New file: `apps/runtime/src/channels/channel-priority.ts`

```typescript
import { createLogger } from '@abl/compiler/platform';
const log = createLogger('channel-priority');

export type ChannelTier = 1 | 2 | 3;

const DEBUG_CHANNELS: ReadonlySet<string> = new Set(['web_debug']);
const SDK_CHANNELS: ReadonlySet<string> = new Set(['web_chat', 'sdk_websocket']);

// Everything not debug or SDK is production (tier 3), including a2a and ag_ui

export function getChannelTier(channelType: string | undefined): ChannelTier {
  // SECURITY INVARIANT (S2): When RUNTIME_MODE=debug, ALWAYS return tier 1
  // regardless of channelType to prevent channel type spoofing.
  if (process.env.RUNTIME_MODE === 'debug') return 1;
  if (!channelType) return 3;
  if (DEBUG_CHANNELS.has(channelType)) return 1;
  if (SDK_CHANNELS.has(channelType)) return 2;
  return 3;
}

// S6: Clamp priority values to [1, 100] range; log warning if clamped.
function clampPriority(val: number): number {
  const clamped = Math.max(1, Math.min(100, Math.round(val)));
  if (clamped !== val) log.warn('Channel queue priority clamped', { original: val, clamped });
  return clamped;
}

const TIER_PRIORITY: Record<ChannelTier, number> = {
  1: clampPriority(Number(process.env.CHANNEL_DEBUG_QUEUE_PRIORITY ?? '10')),
  2: clampPriority(Number(process.env.CHANNEL_SDK_QUEUE_PRIORITY ?? '5')),
  3: clampPriority(Number(process.env.CHANNEL_PRODUCTION_QUEUE_PRIORITY ?? '1')),
};

// S6: Clamp multiplier values to [0.0, 1.0] range; log warning if clamped.
function clampMultiplier(val: number): number {
  const clamped = Math.max(0, Math.min(1, val));
  if (clamped !== val)
    log.warn('Channel rate limit multiplier clamped', { original: val, clamped });
  return clamped;
}

const TIER_MULTIPLIER: Record<ChannelTier, number> = {
  1: clampMultiplier(Number(process.env.CHANNEL_DEBUG_RATE_LIMIT_MULTIPLIER ?? '0.2')),
  2: clampMultiplier(Number(process.env.CHANNEL_SDK_RATE_LIMIT_MULTIPLIER ?? '0.8')),
  3: 1.0,
};

const TIER_SEGMENT: Record<ChannelTier, string> = {
  1: 'debug',
  2: 'sdk',
  3: 'prod',
};

/** Returns BullMQ priority number: 1 = highest (prod), 5 = SDK, 10 = debug (lowest). */
export function getJobPriority(channelType: string | undefined): number {
  return TIER_PRIORITY[getChannelTier(channelType)];
}

/**
 * Applies the tier multiplier to `baseLimit`.
 * Reads multiplier from config env vars (`CHANNEL_DEBUG_RATE_LIMIT_MULTIPLIER`, etc.).
 * Always returns at least 1 to prevent fully blocking a tier.
 */
export function applyTierLimit(baseLimit: number, channelType: string | undefined): number {
  if (baseLimit === -1) return -1; // unlimited plans stay unlimited
  const multiplier = TIER_MULTIPLIER[getChannelTier(channelType)];
  return Math.max(1, Math.floor(baseLimit * multiplier));
}

/** Returns the tier string used for Redis rate-limit key namespacing. */
export function tierRateLimitSegment(channelType: string | undefined): string {
  return TIER_SEGMENT[getChannelTier(channelType)];
}
```

Default tier constants:

| Tier      | BullMQ Priority | Rate Limit Multiplier | Redis Segment |
| --------- | --------------- | --------------------- | ------------- |
| Debug (1) | 10              | 0.2                   | `debug`       |
| SDK (2)   | 5               | 0.8                   | `sdk`         |
| Prod (3)  | 1               | 1.0                   | `prod`        |

### LLM Quota Pool Mapping

Two pools (not three) -- SDK channels use the production pool:

```typescript
export type QuotaPool = 'debug' | 'production';

export function resolveQuotaPool(channelType: string | undefined): QuotaPool {
  // SECURITY INVARIANT (S2): When RUNTIME_MODE=debug, ALWAYS return 'debug'
  // regardless of channelType to prevent channel type spoofing.
  if (process.env.RUNTIME_MODE === 'debug') return 'debug';
  return channelType === 'web_debug' ? 'debug' : 'production';
}
```

### Config Schema Addition

Add `ChannelPriorityConfigSchema` to `apps/runtime/src/config/index.ts` (config schema definitions go in `config/index.ts` which re-exports from `config/loader.ts`):

| Environment Variable                  | Default | Purpose                                |
| ------------------------------------- | ------- | -------------------------------------- |
| `CHANNEL_DEBUG_RATE_LIMIT_MULTIPLIER` | `0.2`   | Fraction of plan limit for `web_debug` |
| `CHANNEL_SDK_RATE_LIMIT_MULTIPLIER`   | `0.8`   | Fraction of plan limit for SDK         |
| `CHANNEL_DEBUG_QUEUE_PRIORITY`        | `10`    | BullMQ priority for debug tier         |
| `CHANNEL_SDK_QUEUE_PRIORITY`          | `5`     | BullMQ priority for SDK tier           |
| `CHANNEL_PRODUCTION_QUEUE_PRIORITY`   | `1`     | BullMQ priority for production tier    |

---

## 4. Separate Runtime Deployments

### Design Decision

Same Docker image, mode-gated via `RUNTIME_MODE` env var, separate Helm release per mode. No code fork or separate Dockerfile.

### Runtime Mode

```
RUNTIME_MODE=debug        # Accepts only web_debug WebSocket; rejects channel webhooks
RUNTIME_MODE=production   # Accepts all production channels; rejects web_debug WebSocket
RUNTIME_MODE=all          # Default: backward-compatible, accepts everything
```

`RUNTIME_MODE=all` is the unchanged default. Existing deployments behave identically.

> **Requirement (security audit S11):** After Phase 2 is stable, change the default from `all` to `production`. In Phase 3, make `RUNTIME_MODE` a required env var (fail startup if unset). Add a startup warning log if `RUNTIME_MODE` is unset during the transition period.

### Mode Guard

New file: `apps/runtime/src/middleware/runtime-mode-guard.ts`

Two exports:

- `createWebSocketModeGuard(mode)` -- returns a function that checks the WS path against allowed channels for the mode. Debug mode allows only `/ws` (web_debug). Production mode allows `/ws/sdk`, `/voice/*`, `/ws/audiocodes/*`, `/ws/korevg/*`.
- `createChannelWebhookGuard(mode)` -- Express middleware that returns 503 for channel webhook routes when in debug mode.

> **Requirement (security audit):** The `createChannelWebhookGuard` must fail-closed on unexpected errors. If the mode value is unrecognized, reject the request rather than passing it through.

### BullMQ Queue Isolation

Debug Runtime uses `BULLMQ_QUEUE_PREFIX=debug:` for all queue names. Queue names become `debug:llm-requests`, `debug:channel-inbound`, `debug:webhook-delivery`. Each Runtime's workers only consume from their own prefixed queues. Zero cross-Runtime queue contention.

### Docker Compose

The runtime currently runs on the host during development via `pnpm dev`. These are NEW additions to `docker-compose.yml`, not replacements. Add `extra_hosts: ['host.docker.internal:host-gateway']` if the containerized runtimes need to reach host-based services (following the `pipeline-engine` pattern).

Two new services:

```yaml
runtime-debug:
  build: { context: ., dockerfile: apps/runtime/Dockerfile }
  ports: ['3115:3112']
  environment:
    PORT: 3112
    RUNTIME_MODE: debug
    BULLMQ_QUEUE_PREFIX: 'debug:'
    LLM_QUEUE_CONCURRENCY: '5'
    ENABLE_SESSION_CLEANUP: 'false'
  networks: [backend, data]
  depends_on: [mongo, redis]

runtime-prod:
  build: { context: ., dockerfile: apps/runtime/Dockerfile }
  ports: ['3112:3112']
  environment:
    PORT: 3112
    RUNTIME_MODE: production
  networks: [backend, data]
  depends_on: [mongo, redis]
```

Port constant `DEFAULT_RUNTIME_DEBUG_PORT = 3115` added to `packages/config/src/constants.ts`. Note: port 3113 is already allocated to SearchAI and port 3114 to SearchAI-Runtime.

### Helm Configuration

New templates in `deploy/helm/agent-platform/templates/runtime-debug/`:

- `configmap.yaml`, `deployment.yaml`, `service.yaml`, `ingress.yaml` (internal, guarded), `network-policy.yaml`
- Guarded by `{{- if .Values.runtimeDebug.enabled }}`

> **Note:** Production Runtime Helm templates (`templates/runtime/`) are **untouched**. The only addition to the top-level `values.yaml` is `runtimeDebug.enabled: false` (defaults off). No changes to existing production deployment, service, ingress, or HPA templates.

Key `values.yaml` additions under `runtimeDebug`:

```yaml
runtimeDebug:
  enabled: false
  replicaCount: 1
  hpa:
    enabled: false
  resources:
    requests: { cpu: 500m, memory: 512Mi }
    limits: { cpu: '2', memory: 2Gi }
  env:
    RUNTIME_MODE: debug
    BULLMQ_QUEUE_PREFIX: 'debug:'
    LLM_QUEUE_CONCURRENCY: '5'
    ENABLE_SESSION_CLEANUP: 'false'
    OTEL_SERVICE_NAME: agent-platform-runtime-debug
```

Studio ConfigMap additions:

```yaml
DEBUG_RUNTIME_URL: "http://{{ include "agent-platform.fullname" . }}-runtime-debug:3112"
DEBUG_RUNTIME_WS_URL: "ws://{{ include "agent-platform.fullname" . }}-runtime-debug:3112/ws"
```

No public ingress for the debug Runtime -- reachable only from Studio pods within the namespace.

### Network Policy

`templates/runtime-debug/network-policy.yaml`:

- Ingress: allow only from Studio pods (`app.kubernetes.io/component: studio`) on port 3112
- Egress: DNS (53), MongoDB (27017), Redis (6379), OTEL (4317), HTTPS (443 to external)

> **Note (security audit S9):** Accepted risk: debug Runtime egress to any HTTPS is required for LLM API calls. Compensating control: add OTEL egress traffic monitoring with alerting on unexpected destinations. Future enhancement: restrict egress to known LLM provider IP ranges.

> **Requirement (security audit, H5):** Debug Runtime must include a `nodeSelector` or node affinity rule restricting it to the same node pool as production Runtime (e.g., `nodeSelector: { node-pool: runtime }`). Both Runtimes share secrets (JWT, MongoDB credentials, LLM API keys), so their security posture must be equivalent.

### Studio Proxy Changes

`apps/studio/src/config/runtime.ts` gains `getDebugRuntimeUrl()` with fallback chain: `DEBUG_RUNTIME_URL` -> `NEXT_PUBLIC_DEBUG_RUNTIME_URL` -> `getRuntimeUrl()`. The fallback ensures zero behavioral change if neither new env var is set.

**Browser WebSocket connectivity:** The debug Runtime WS URL must be exposed as `NEXT_PUBLIC_DEBUG_RUNTIME_WS_URL` in Studio's env config so the browser-side WebSocket client can connect directly.

> **Requirement (security audit S5):** The debug Runtime WS endpoint requires an authenticated ingress path. Options: (a) path-based ingress through Studio's API gateway with auth subrequest, (b) full `createUnifiedAuthMiddleware` verification in the WS upgrade handler (not just `extractUserIdFromToken`). The implementation must specify which option is used. The HTTP proxy in `proxy.ts` handles REST calls to the debug Runtime; however, WS connections go directly from the browser to the debug Runtime WS endpoint (WebSocket upgrade requests cannot be reverse-proxied by Next.js middleware). In Docker Compose, this defaults to `ws://localhost:3115/ws`. In Kubernetes, the Helm ConfigMap sets it to the internal service URL. The Studio `RuntimeConfigContext` must read `NEXT_PUBLIC_DEBUG_RUNTIME_WS_URL` and expose it as `debugWsUrl`. **Note:** `DebugSessionProvider` does not exist yet and must be created, OR the existing WebSocket connection logic in `apps/studio/src/lib/` should receive the `debugWsUrl`. Add `debugWsUrl` to the `RuntimeConfig` interface as a new field.

> **Requirement (architecture audit):** Studio management API calls (deployments, tool-secrets, platform-admin) are currently all proxied through the same Runtime target. If the debug Runtime is unavailable, Studio loses management API access. Add control-plane fallback: `proxy.ts` must route management paths (`/api/projects/*`, `/api/tenants/*`, `/api/platform/admin/*`) to `getRuntimeUrl()` (production) rather than `getDebugRuntimeUrl()`. Only execution-plane paths (`/ws`, `/api/v1/execute/*`) route to the debug Runtime.

### CSP Headers

The inline CSP construction block in `proxy.ts` (around line 255) that builds `connectSources` must include `NEXT_PUBLIC_DEBUG_RUNTIME_WS_URL` in `Content-Security-Policy: connect-src`. Only the public-facing WS URL goes in the browser CSP -- internal K8s service URLs (e.g., `DEBUG_RUNTIME_URL` pointing to `http://...-runtime-debug:3112`) must NOT be added to CSP, as they are server-side only and not reachable from the browser. Without the public WS URL in CSP, browsers silently block WebSocket connections to the debug Runtime.

### Health Check

Both Runtimes expose `/health` returning `{ mode: "debug"|"production"|"all", status: "healthy" }`.

> **Requirement (security audit S4):** Add `runtimeMode: 'debug' | 'production'` field to session documents. Debug Runtime sets `runtimeMode: 'debug'` on creation. All session queries on the debug Runtime must filter by `runtimeMode: 'debug'`. Add a TTL index for debug sessions (24-hour auto-expiry) regardless of `ENABLE_SESSION_CLEANUP` setting.

> **Requirement (operations audit):** Add a non-paging Slack alert for `runtime-debug` pod restarts > 2 in 10 minutes. This is a developer experience issue (not production incident), severity: warning.

---

## 5. LLM Quota Separation

### Quota Pools

| Pool         | Assignment                                  | Budget                                        |
| ------------ | ------------------------------------------- | --------------------------------------------- |
| `debug`      | `channelType === 'web_debug'`               | `debugTokenFractionPercent`% of total         |
| `production` | Everything else (SDK, webhooks, voice, a2a) | `(100 - debugTokenFractionPercent)`% of total |

New field `debugTokenFractionPercent` (integer 0-100, default 10) must be added to BOTH `TenantLimits` (in `packages/config/src/tenant-config-types.ts`) AND `TenantRateLimitConfig` (in `apps/runtime/src/middleware/rate-limiter.ts`). `getTenantRateLimits()` must map between them. Enterprise plans default to 5%. Add `debugTokenFractionPercent: 10` to the `DEFAULT_LIMITS` constant in `rate-limiter.ts` as a fallback.

Example with `tokensPerMinute: 200,000` and `debugTokenFractionPercent: 10`:

- Debug pool: 20,000 tokens/minute
- Production pool: 180,000 tokens/minute (guaranteed floor)

### Redis Counter Schema

Six Redis keys per tenant per minute window:

```
llm:quota:{{tenantId}}:debug:tokens:{minute}        # token count, TTL 120s
llm:quota:{{tenantId}}:production:tokens:{minute}    # token count, TTL 120s
llm:quota:{{tenantId}}:debug:cost:{YYYY-MM}          # microdollars, TTL 35 days
llm:quota:{{tenantId}}:production:cost:{YYYY-MM}     # microdollars, TTL 35 days
llm:quota:{{tenantId}}:debug:calls:{minute}          # call count, TTL 120s
llm:quota:{{tenantId}}:production:calls:{minute}     # call count, TTL 120s
```

`{minute}` = `Math.floor(Date.now() / 60_000)`. All increments use atomic `INCRBY`.

> **Note (security audit S1):** Double braces `{{tenantId}}` are Redis hash tags. They ensure all keys for a tenant land on the same Redis Cluster slot, which is required for the atomic Lua scripts to operate across multiple keys.

### ChannelQuotaTracker

New file: `apps/runtime/src/services/llm/channel-quota-tracker.ts`

Key methods:

- `checkQuota(tenantId, pool, debugFractionPercent, totalTokensPerMinute)` -- atomic Redis Lua script (INCRBY-and-compare in a single round-trip), returns `{ allowed, retryAfterSeconds, currentUsage, limit }`
- `recordUsage(tenantId, pool, inputTokens, outputTokens, costUsd)` -- atomic `INCRBY` x4, fire-and-forget
- `getUsageStats(tenantId)` -- reads all 6 keys for admin API

**Atomic quota check Lua script** (same pattern as `LUA_CHECK_AND_ADD` in the existing rate limiter). This prevents the race condition where a non-atomic GET-then-INCRBY allows concurrent requests to both pass before either increments:

```lua
-- KEYS[1] = llm:quota:{{tenantId}}:{pool}:tokens:{minute}
-- ARGV[1] = estimated token count for this request
-- ARGV[2] = pool limit (tokens per minute)
-- ARGV[3] = TTL in seconds (120)
-- Returns: [currentAfterIncr, limit]
local current = redis.call('INCRBY', KEYS[1], ARGV[1])
if current == tonumber(ARGV[1]) then
  -- First write this window — set TTL
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
end
local limit = tonumber(ARGV[2])
if current > limit then
  -- Over quota — rollback the increment so counter stays accurate
  redis.call('DECRBY', KEYS[1], ARGV[1])
  return {0, current - tonumber(ARGV[1]), limit}
end
return {1, current, limit}
```

The TypeScript wrapper interprets the return tuple: `[0, current, limit]` maps to `{ allowed: false, retryAfterSeconds: <seconds until window rolls>, currentUsage: current, limit }`, `[1, current, limit]` maps to `{ allowed: true, ... }`.

**Unlimited plan guard:** If `totalTokensPerMinute === -1`, `checkQuota()` returns `{ allowed: true }` immediately without touching Redis (same pattern as `if (limit === -1) { next(); return; }` in the rate limiter).

Fail-open: if Redis is unavailable, `checkQuota` returns `{ allowed: true }`. Matches `GuardrailCostTracker` pattern.

### Enforcement Point

Inside `SessionLLMClient`, checked before each `generateText()`/`streamText()` call. This is the correct location because all LLM calls from all code paths converge here, and voice LLM calls bypass the BullMQ queue entirely.

> **Requirement (C1 -- RESOLVED):** No server-side wait queue. When the debug pool is exhausted, `checkQuota()` returns `{ allowed: false, retryAfterSeconds }` and the handler returns HTTP 429 with `Retry-After`. The Studio client handles countdown and retry. No `DebugQuotaWaitQueue` exists -- it was removed as it would hold pod-local Promise state violating Platform Principle 3 (stateless distributed).

Pre-call guard:

```typescript
if (this.quotaTracker && this.context.tenantId) {
  const pool = resolveQuotaPool(this.context.channelType);
  const limits = await getTenantRateLimits(this.context.tenantId);
  const check = await this.quotaTracker.checkQuota(
    this.context.tenantId,
    pool,
    limits.debugTokenFractionPercent,
    limits.tokensPerMinute,
  );
  if (!check.allowed) {
    throw new QuotaExceededError(pool, check.retryAfterSeconds);
  }
}
```

> **Note (security audit S8):** Pre-call estimate should use the `max_tokens` parameter from the LLM request config. Post-call `recordUsage()` must atomically adjust: `INCRBY(actual - estimate)` so the counter reflects real consumption rather than pessimistic estimates.

Post-call recording (in `finally` block, fire-and-forget):

```typescript
if (this.quotaTracker && this.context.tenantId && result?.usage) {
  const pool = resolveQuotaPool(this.context.channelType);
  this.quotaTracker
    .recordUsage(tenantId, pool, inputTokens, outputTokens, costUsd)
    .catch((err: unknown) => {
      log.warn('Failed to record LLM usage', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
}
```

> **Requirement (operations audit):** Add `LLM_QUOTA_ENFORCEMENT_ENABLED` env var (default `false` on initial Phase 3 deploy, switched to `true` incrementally). Gates the `checkQuota()` call in `SessionLLMClient`. Setting to `false` disables enforcement without a redeploy. This is a critical safety net.

> **Requirement (operations audit):** Audit log target for `recordUsage()` must be ClickHouse (the existing analytics sink), not MongoDB per-call writes. A medium-traffic tenant with 1,000 LLM calls/hour would generate unacceptable MongoDB write amplification. Alternatively, batch audit writes with a micro-buffer (flush every 10 seconds, max buffer size 1000 events, drop-oldest eviction on overflow).

### Error Handling

`QuotaExceededError` carries `pool` and `retryAfterSeconds`:

- WebSocket debug handler: serialized as `{ type: "error", code: "QUOTA_EXHAUSTED", retryAfterSeconds: N }`. Do NOT use pool-specific error codes (e.g., `DEBUG_QUOTA_EXHAUSTED`) as they leak pool information.
- REST endpoints: HTTP 429 with `Retry-After` header and `{ success: false, error: { code: "QUOTA_EXHAUSTED", message, retryAfterSeconds } }`

> **Requirement (security audit S10):** Client-facing 429 response includes only `retryAfterSeconds` and generic error code. Do NOT expose `currentUsage`, `limit`, or `pool` in the response body.

### Admin API

`GET /api/tenants/:tenantId/llm-quota/stats` -- current usage for both pools. Requires `requirePermission('tenant:admin')`. The GET stats response MUST NOT include `tenantId` in the body to prevent info leakage if responses are logged.

`PATCH /api/tenants/:tenantId/llm-quota/config` -- set `debugTokenFractionPercent` (Zod-validated integer 0-50, upper-bounded to prevent debug consuming majority share). Requires `requirePermission('tenant:admin')`.

> **Requirement (C3 -- RESOLVED):** Tenant cross-check on `PATCH /config`: `if (req.tenantContext.tenantId !== req.params.tenantId) return res.status(404).json(...)`. Without this, an authenticated user from tenant A could modify tenant B's quota.

> **Requirement (security audit, H2):** Both routes require `requirePermission('tenant:admin')`. The plan originally left the permission unspecified -- this must be `tenant:admin` to prevent non-admin members from manipulating production LLM pool allocation.
>
> **Prerequisite:** `tenant:admin` permission does not currently exist in the RBAC permission registry. Either define `tenant:admin` in the RBAC permission registry and assign it to platform admin roles, or use an existing admin check pattern (e.g., `requirePlatformAdmin()` or equivalent) if one already covers this use case.

### Observability

New OTEL metrics:

- `llm.quota.utilization` (gauge) -- polled every 30s, `currentUsage / limit` per tenant per pool
- `llm.quota.throttled` (counter) -- 429 rejections by pool

Trace event `llm_quota_throttled` emitted on rejection, visible in Observatory.

Alert thresholds:

| Condition                                          | Severity | Action                    |
| -------------------------------------------------- | -------- | ------------------------- |
| `llm.quota.utilization{pool="production"} > 0.85`  | Warning  | Production pool at 85%    |
| `llm.quota.utilization{pool="production"} > 0.95`  | Critical | Near exhaustion           |
| `llm.quota.throttled{pool="debug"} > 50` per 5 min | Info     | Consider increasing split |

---

## 6. Channel Rate Limiting

### Rate Limit Key Namespacing

Before:

```
rl:tenant:{tenantId}:request        (all channels share this counter)
```

After:

```
rl:tenant:{tenantId}:debug:request  (web_debug only)
rl:tenant:{tenantId}:sdk:request    (web_chat, sdk_websocket)
rl:tenant:{tenantId}:prod:request   (all production channels)
```

A debug storm depletes `:debug:request` only. The `:prod:request` counter is untouched.

> **Requirement (security audit S3):** Add a shared tenant-level counter (`rl:tenant:{tenantId}:all:request`) that counts ALL requests regardless of tier, enforced at 100% of plan limit. Tier-specific counters are sub-limits within this global cap. Check order: tier-specific first (fast rejection), then global (aggregate enforcement). This prevents the sum of all tier sub-limits from exceeding the plan's absolute cap.

### Implementation

`tenantRateLimit` middleware gains `channelType?: string` parameter. For REST webhook routes, `channelType` is a static parameter set at route registration time (e.g., `tenantRateLimit('request', undefined, 'slack')` on the Slack webhook route). For WebSocket handlers, derive from the session's stored `channelType`.

1. Tier segment inserted into Redis key
2. `applyTierLimit(baseLimit, channelType)` applies multiplier before `limiter.check()`
3. Unlimited plans (`limit === -1`) unaffected
4. Minimum enforced value is always 1 (never fully blocks a tier)

Session message rate: `checkSessionMessageRateForChannel(sessionId, channelType)` is the new function. For backward compatibility, keep `checkSessionMessageRate(sessionId)` as a delegate: it calls `checkSessionMessageRateForChannel(sessionId, 'production')` as the default. Call sites that need updating: `sdk-handler.ts`, `chat.ts` (lines 267, 497, 1019).

**In-memory fallback parity:** Simpler strategy: compose the tier into `tenantKey` in the middleware: `tenant:${rawTenantId}:${tier}`. Pass as the existing `tenantId` parameter to `check()`. This avoids changing `InMemoryRateLimiter`, `RedisRateLimiter`, and `HybridRateLimiter` signatures. The cache key naturally becomes `tenant:${rawTenantId}:${tier}:${operation}`, maintaining tier isolation at every layer including during Redis outages.

### BullMQ Priority

All three queues (`llm-requests`, `channel-inbound`, `webhook-delivery`) gain per-job `priority` from `getJobPriority(channelType)`. No queue restructuring or BullMQ Pro license required.

New helper `enqueueInboundJob(payload, idempotencyKey?)` in `channel-queues.ts` wraps `queue.add()` with channel-derived priority. All webhook route call sites migrated to use this helper.

`enqueueLLMRequest` extended with `channelType?: string`. `LLMJobData` gains `channelType`. Backward compatible -- omitting `channelType` defaults to tier 3.

> **Note (architecture audit #1):** `enqueueLLMRequest` already has 6 positional parameters; adding `channelType` makes 7. Convert to an options-object pattern (`enqueueLLMRequest(opts: EnqueueLLMRequestOptions)`) instead of a 7th positional arg. This improves readability and makes future extensions non-breaking.

### Effective Limits (TEAM plan, 300 RPM)

| Channel     | Tier       | Effective RPM   |
| ----------- | ---------- | --------------- |
| `web_debug` | Debug      | 60 (300 x 0.2)  |
| `web_chat`  | SDK        | 240 (300 x 0.8) |
| `slack`     | Production | 300 (300 x 1.0) |

### Rollback

Set `CHANNEL_DEBUG_RATE_LIMIT_MULTIPLIER=1.0` and `CHANNEL_SDK_RATE_LIMIT_MULTIPLIER=1.0` to restore 100% of plan limit to all tiers without code redeploy. Tier-scoped keys differ from original keys, so no counter corruption on rollback.

### Metrics

| Metric                               | Type      | Labels                                           |
| ------------------------------------ | --------- | ------------------------------------------------ |
| `channel.tier.rate_limit.rejections` | Counter   | `tenant_id`, `operation`, `channel_type`, `tier` |
| `channel.tier.job.wait`              | Histogram | `channel_tier`                                   |

---

## 7. Implementation Phases

Plans 1 and 3 share `channelType` threading work in `llm-queue.ts`, `llm-wiring.ts`, and `session-llm-client.ts`. These must be coordinated in the same branch or strictly sequenced. The phases below merge all three strategies into a single sequence.

### Phase 1: Foundation (zero behavior change)

Goal: Ship new modules and config schemas. No runtime behavior change. Safe to deploy to production.

| Task                                                                                                                              | Source Plan   | Files                                                 |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------- |
| Create `channel-priority.ts` with tier classification                                                                             | Rate Limiting | `apps/runtime/src/channels/channel-priority.ts`       |
| Add `ChannelPriorityConfigSchema` + env var mappings                                                                              | Rate Limiting | `apps/runtime/src/config/index.ts`                    |
| Add `RUNTIME_MODE`, `BULLMQ_QUEUE_PREFIX` to config                                                                               | Deployments   | `apps/runtime/src/config/index.ts`                    |
| Add `ENABLE_SESSION_CLEANUP` boolean to `RuntimeConfigSchema` (default `true`, env mapping: `ENABLE_SESSION_CLEANUP`)             | Deployments   | `apps/runtime/src/config/index.ts`                    |
| Modify `session-cleanup-job.ts` to check `ENABLE_SESSION_CLEANUP` config and skip scheduling the cleanup cron when set to `false` | Deployments   | `apps/runtime/src/jobs/session-cleanup-job.ts`        |
| Create `runtime-mode-guard.ts`                                                                                                    | Deployments   | `apps/runtime/src/middleware/runtime-mode-guard.ts`   |
| Add `debugTokenFractionPercent` to `TenantLimits` (after adding, run `pnpm build` to catch type errors in downstream consumers)   | Quota         | `packages/config/src/tenant-config-types.ts`          |
| Add `debugTokenFractionPercent` to `TenantRateLimitConfig` and populate in `getTenantRateLimits()`                                | Quota         | `apps/runtime/src/middleware/rate-limiter.ts`         |
| Add `debugTokenFractionPercent` defaults to all `PLAN_LIMITS` entries: FREE: 20%, TEAM: 10%, BUSINESS: 10%, ENTERPRISE: 5%        | Quota         | `apps/runtime/src/services/tenant-config.ts`          |
| Add `channelType` to `SessionLLMClient` context                                                                                   | Quota         | `apps/runtime/src/services/llm/session-llm-client.ts` |
| Wire `session.channelType` at all `new SessionLLMClient()` sites                                                                  | Shared        | `apps/runtime/src/services/execution/llm-wiring.ts`   |

> **Detail (architecture audit #2):** `channelType` flow to `SessionLLMClient`: `RuntimeSession` needs a `channelType` field, populated at session creation from `SessionCreationContext`. `llm-wiring.ts wireSessionLLM()` must read `session.channelType` and pass it to the `SessionLLMClient` constructor context. Explicit call sites: `llm-wiring.ts:990`, `chat.ts:291`, `chat.ts:520`. Test files constructing `SessionLLMClient` will also need the new field.

| Create `channel-pool.ts` with `resolveQuotaPool()` and key builders | Quota | `apps/runtime/src/services/llm/channel-pool.ts` |
| Add channel-tier metrics stubs | Rate Limiting | `apps/runtime/src/observability/metrics.ts` |
| Add `DEFAULT_RUNTIME_DEBUG_PORT` constant | Deployments | `packages/config/src/constants.ts` |
| Unit tests for `channel-priority.ts` and `runtime-mode-guard.ts` | All | `apps/runtime/src/__tests__/` |

**Gate:** `pnpm build --filter=@agent-platform/runtime && pnpm test --filter=@agent-platform/runtime` passes clean. Deploy to production. No behavior change.

### Phase 2: Infrastructure (isolation deployed, no enforcement)

Goal: Debug Runtime running as separate deployment. BullMQ priorities active. Quota tracker created but not enforcing.

| Task                                                                                                                                                         | Source Plan   | Files                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | ------------------------------------------------------------------------------ |
| Wire mode guard into `server.ts` (WS upgrade + channel webhook routers)                                                                                      | Deployments   | `apps/runtime/src/server.ts`                                                   |
| BullMQ queue prefix parameterization (see spec below)                                                                                                        | Deployments   | `apps/runtime/src/server.ts`, queue files                                      |
| Docker Compose: `runtime-debug` (3115) + `runtime-prod` (3112)                                                                                               | Deployments   | `docker-compose.yml`                                                           |
| Helm templates for `runtime-debug`                                                                                                                           | Deployments   | `deploy/helm/agent-platform/templates/runtime-debug/`                          |
| Studio proxy: `getDebugRuntimeUrl()` with control-plane fallback                                                                                             | Deployments   | `apps/studio/src/config/runtime.ts`, `proxy.ts`                                |
| `debugWsUrl` in `RuntimeConfigContext` + `layout.tsx`                                                                                                        | Deployments   | `apps/studio/src/contexts/`, `apps/studio/src/app/layout.tsx`                  |
| CSP header update for debug Runtime URL                                                                                                                      | Deployments   | `apps/studio/src/proxy.ts`                                                     |
| Extend `LLMJobData` and `enqueueLLMRequest` with `channelType`                                                                                               | Rate Limiting | `apps/runtime/src/services/llm/llm-queue.ts`                                   |
| Refactor `enqueueLLMRequest` from positional args to options object pattern when adding `channelType`. Affected call sites: `message-pipeline.ts`, `chat.ts` | Rate Limiting | `apps/runtime/src/services/llm/llm-queue.ts`, `message-pipeline.ts`, `chat.ts` |
| Thread `channelType` through `ExecuteAndPersistOptions`                                                                                                      | Rate Limiting | `apps/runtime/src/channels/pipeline/types.ts`, `message-pipeline.ts`           |
| Pass `'web_debug'` in `handler.ts`, `state.channel` in `sdk-handler.ts`                                                                                      | Rate Limiting | WS handler files                                                               |
| Create `enqueueInboundJob` helper, migrate webhook routes                                                                                                    | Rate Limiting | `apps/runtime/src/services/queues/channel-queues.ts`, route files              |
| Create `ChannelQuotaTracker` + `QuotaExceededError`                                                                                                          | Quota         | `apps/runtime/src/services/llm/channel-quota-tracker.ts`, `quota-errors.ts`    |

**BullMQ queue prefix parameterization spec:** Create a utility function `getQueueName(base: string): string` in `apps/runtime/src/services/queues/queue-utils.ts`:

```typescript
/**
 * Prepends BULLMQ_QUEUE_PREFIX to the base queue name.
 * Debug Runtime sets BULLMQ_QUEUE_PREFIX='debug:', producing 'debug:llm-requests', etc.
 * Production Runtime leaves it unset (empty string), producing 'llm-requests' unchanged.
 */
export function getQueueName(base: string): string {
  const prefix = process.env.BULLMQ_QUEUE_PREFIX ?? '';
  return `${prefix}${base}`;
}
```

All queue instantiation files must call `getQueueName()` instead of hardcoding queue names: `llm-queue.ts`, `channel-queues.ts` (which includes webhook delivery), `agent-transfer/event-queue-factory.ts`, `agent-transfer/timeout-queue-factory.ts`, `kms/reencryption-queue.ts`, and their corresponding worker files. Agent-transfer queues should be prefixed since debug sessions may trigger transfers. This ensures debug and production workers subscribe only to their own prefixed queues.

**Gate:** Docker Compose validation -- Studio WS connects to 3115, production webhooks succeed on 3112, webhooks to 3115 return 503. Production Helm rollout: deploy Phase 1 image first, then debug Runtime, then Studio ConfigMap update. BullMQ jobs carry priorities. No rate limit or quota enforcement change. **Verification step:** confirm that debug workers subscribe only to `debug:`-prefixed queues and production workers subscribe only to unprefixed queues by inspecting BullMQ dashboard or Redis `KEYS bull:*` output.

### Phase 3: Enforcement (behavior change, behind feature flags)

Goal: Rate limits and LLM quotas actively enforced for debug traffic.

| Task                                                                                                                                                   | Source Plan   | Files                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | --------------------------------------------- |
| Add `channelType` to `tenantRateLimit` middleware                                                                                                      | Rate Limiting | `apps/runtime/src/middleware/rate-limiter.ts` |
| Add `checkSessionMessageRateForChannel`                                                                                                                | Rate Limiting | `apps/runtime/src/middleware/rate-limiter.ts` |
| Wire debug/SDK rate limit checks in WS handlers                                                                                                        | Rate Limiting | `handler.ts`, `sdk-handler.ts`                |
| Inject `ChannelQuotaTracker` into `SessionLLMClient`                                                                                                   | Quota         | `session-llm-client.ts`, `llm-wiring.ts`      |
| Pre-call quota check in `chatWithToolUse`, `chatWithToolUseStreamable`, and `streamChatWithToolUse`                                                    | Quota         | `session-llm-client.ts`                       |
| Post-call `recordUsage()` (fire-and-forget)                                                                                                            | Quota         | `session-llm-client.ts`                       |
| `pool` label in `recordLlmCall()` (make `pool` optional with default `'production'` for backward compat; update call sites in `session-llm-client.ts`) | Quota         | `observability/metrics.ts`                    |
| `LLM_QUOTA_ENFORCEMENT_ENABLED` kill switch                                                                                                            | Quota         | `session-llm-client.ts`                       |
| `QuotaExceededError` handling in WS debug handler                                                                                                      | Quota         | `handler.ts`                                  |

**Gate:** Deploy to staging. Load test: 100 concurrent debug sessions + 10 production sessions. Verify production sessions not throttled. `LLM_QUOTA_ENFORCEMENT_ENABLED=false` on initial deploy, enable incrementally starting with low-traffic tenants. Monitor `channel.tier.rate_limit.rejections{channel_tier="prod"}` -- must remain 0.

**Rollback:** Rate limiting: set multiplier env vars to 1.0. Quota: set `LLM_QUOTA_ENFORCEMENT_ENABLED=false`.

### Phase 4: Observability and Admin UI

Goal: Full visibility, admin configuration, Studio quota settings.

| Task                                                | Source Plan   | Files                                  |
| --------------------------------------------------- | ------------- | -------------------------------------- |
| OTEL gauges and counters for quota                  | Quota         | `observability/metrics.ts`             |
| `llm_quota_throttled` trace event                   | Quota         | trace event types, quota guard         |
| `GET /api/tenants/:tenantId/llm-quota/stats`        | Quota         | `apps/runtime/src/routes/llm-quota.ts` |
| `PATCH /api/tenants/:tenantId/llm-quota/config`     | Quota         | `apps/runtime/src/routes/llm-quota.ts` |
| Grafana dashboard queries for tier metrics          | Rate Limiting | Documentation                          |
| Alert rules: production throttling, debug quota     | Both          | Alert configuration                    |
| Debug Runtime pod health Slack alert                | Deployments   | Alert configuration                    |
| `LlmQuotaSettings.tsx` Studio settings panel        | Quota         | `apps/studio/src/components/settings/` |
| SWR hook `useQuotaStats(tenantId)`                  | Quota         | `apps/studio/src/lib/api/quota.ts`     |
| Studio WS handling for `llm_quota_throttled` events | Quota         | Studio WS client                       |
| i18n strings for quota UI                           | Quota         | Locale files                           |

---

## 8. Open Items and Requirements

### RESOLVED

| ID  | Item                                                                                           | Resolution                                                               |
| --- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| C1  | `DebugQuotaWaitQueue` holds pod-local Promise state, violating stateless distributed principle | Removed. Approach is 429 + `Retry-After`. Client handles retry.          |
| C3  | Tenant cross-check missing on `PATCH /config`                                                  | Added: `req.tenantContext.tenantId !== req.params.tenantId` returns 404. |
| --  | `a2a`/`ag_ui` tier inconsistency between plans                                                 | Resolved: both classified as production tier everywhere.                 |

### REQUIRED (must be resolved before deploying the relevant phase)

| Priority | ID  | Phase | Item                                                                                                                                                                                                                                       |
| -------- | --- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| High     | R1  | 3     | Add `LLM_QUOTA_ENFORCEMENT_ENABLED` kill switch before activating quota enforcement. Without it, a misconfigured quota requires a full Runtime redeploy to recover.                                                                        |
| High     | R2  | 2     | Add control-plane fallback in Studio `proxy.ts` -- management API routes (`/api/projects/*`, `/api/tenants/*`, `/api/platform/admin/*`) must route to production Runtime, not debug Runtime. Only execution paths route to debug.          |
| High     | R3  | 2     | Debug Runtime Helm deployment must include `nodeSelector: { node-pool: runtime }` (or equivalent node affinity) to match production Runtime's security posture, since both share secrets.                                                  |
| High     | R4  | 3     | Audit log target for `recordUsage()` must be ClickHouse (existing analytics sink), not MongoDB per-call writes. Alternatively, batch with micro-buffer (flush every 10s, max size 1000 events, drop-oldest eviction on overflow).          |
| High     | R5  | 4     | `PATCH /api/tenants/:tenantId/llm-quota/config` requires `requirePermission('tenant:admin')`. Without this, non-admin tenant members could starve production LLM pool.                                                                     |
| High     | R6  | 1-2   | `channelType` threading work in `llm-queue.ts`, `llm-wiring.ts`, `session-llm-client.ts` is shared between rate limiting and quota plans. Must be coordinated in same branch or strictly sequenced (Phase 1 merged before Phase 2 begins). |
| Medium   | R7  | 4     | Add non-paging Slack alert for `runtime-debug` pod restarts > 2 in 10 minutes.                                                                                                                                                             |
| Medium   | R8  | 3     | `createChannelWebhookGuard` must fail-closed on unexpected errors (unrecognized mode value rejects request).                                                                                                                               |
| Medium   | R9  | 2     | Deployment runbook: note ~60-second "free quota" window during rate limit key namespace migration (old keys expire, new keys start at zero). Not a bug -- inform on-call to prevent false alarm.                                           |
| Low      | R10 | 2     | In-flight BullMQ jobs with no priority (from before migration) process in FIFO order alongside new prioritized jobs. No action needed -- naturally drains.                                                                                 |
| Low      | R11 | 4     | `getUsageStats()` display has non-atomic read race (Redis `INCRBY` vs `GET` not atomic). Acceptable for dashboard display -- document as known limitation.                                                                                 |
| Low      | R12 | 4     | Background quota polling should filter to tenants with non-zero usage (`EXISTS` before `GET`) to avoid unnecessary Redis reads at scale.                                                                                                   |

---

## 9. Rollback Procedures

### Phase 1 Rollback

Phase 1 is purely additive (new modules and config with no behavior change). Rollback: deploy previous image. No data cleanup needed.

### Phase 2 Rollback

**Rate limiting (BullMQ priorities):** Deploy previous image. BullMQ ignores unknown job option fields -- in-flight prioritized jobs drain without error. No queue flush required. Alternatively, remove `channelType` from enqueue call sites in a forward-fix deploy; in-flight prioritized jobs drain naturally with no queue corruption.

**Separate deployments:** Revert Studio ConfigMap to remove `DEBUG_RUNTIME_URL`. Studio falls back to production Runtime via `getRuntimeUrl()`. Debug Runtime pod can be left running (harmless) or deleted. Zero-downtime -- Studio pod restart picks up new ConfigMap.

### Phase 3 Rollback

**Rate limits:** Set `CHANNEL_DEBUG_RATE_LIMIT_MULTIPLIER=1.0` and `CHANNEL_SDK_RATE_LIMIT_MULTIPLIER=1.0` via env var. Restores 100% of plan limit to all tiers without code redeploy. Tier-scoped Redis keys are different from original keys -- no counter corruption.

**LLM quotas:** Set `LLM_QUOTA_ENFORCEMENT_ENABLED=false`. Disables `checkQuota()` call in `SessionLLMClient` without redeploy. Orphaned Redis quota keys expire naturally (120s for per-minute, 35 days for monthly cost). No manual cleanup.

### Phase 4 Rollback

Admin API routes and UI are additive. Remove routes from `server.ts` mount or deploy previous image. Stats display is read-only and has no side effects.
