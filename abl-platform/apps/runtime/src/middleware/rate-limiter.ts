/**
 * Per-Tenant Rate Limiting Middleware
 *
 * Provides sliding window rate limiting scoped per tenant/organization.
 * Uses HybridRateLimiter: Redis primary (distributed) + in-memory fallback (dev/single pod).
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { getHybridRateLimiter } from '../services/resilience/hybrid-rate-limiter.js';
import { getTenantConfigService } from '../services/tenant-config.js';
import { registerTenantPlan } from '../services/resilience/tenant-cb-config.js';
import { getRedisClient } from '../services/redis/redis-client.js';
import { createLogger } from '@abl/compiler/platform';
import { runLuaScript, type LuaScript } from '@agent-platform/redis';
import { recordRateLimitRejection } from '../observability/metrics.js';

const log = createLogger('rate-limiter');

// =============================================================================
// ENV-VAR-BACKED CONFIGURATION HELPERS
// =============================================================================

/** Parse an integer from an env var, returning the fallback on missing/NaN */
function safeParseInt(val: string | undefined, fallback: number): number {
  if (!val) return fallback;
  const parsed = parseInt(val, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

// =============================================================================
// TYPES
// =============================================================================

export interface TenantRateLimitConfig {
  /** API requests per minute per tenant */
  requestsPerMinute: number;

  /** LLM tokens per minute per tenant */
  tokensPerMinute: number;

  /** Max concurrent sessions per tenant */
  concurrentSessions: number;

  /** Tool calls per minute per tenant */
  toolCallsPerMinute: number;
}

export type RateLimitOperation =
  | 'request'
  | 'llm_tokens'
  | 'session'
  | 'tool_call'
  | 'session_message';

interface SlidingWindowEntry {
  count: number;
  windowStart: number;
}

// =============================================================================
// DEFAULT LIMITS
// =============================================================================

const DEFAULT_LIMITS: TenantRateLimitConfig = {
  requestsPerMinute: safeParseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 100),
  tokensPerMinute: safeParseInt(process.env.RATE_LIMIT_MAX_TOKENS, 100000),
  concurrentSessions: safeParseInt(process.env.RATE_LIMIT_MAX_CONCURRENT_SESSIONS, 50),
  toolCallsPerMinute: safeParseInt(process.env.RATE_LIMIT_MAX_TOOL_CALLS, 200),
};

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  resetMs: number;
  limit: number;
}

function resolveOperationLimit(
  limits: TenantRateLimitConfig,
  operation: RateLimitOperation,
): number {
  switch (operation) {
    case 'request':
      return limits.requestsPerMinute;
    case 'llm_tokens':
      return limits.tokensPerMinute;
    case 'tool_call':
      return limits.toolCallsPerMinute;
    case 'session':
      return limits.concurrentSessions;
    case 'session_message':
      // session_message uses its own limit via checkSessionMessageRate();
      // fall back to requestsPerMinute if used through the middleware
      return limits.requestsPerMinute;
    default:
      return limits.requestsPerMinute;
  }
}

export function applyRateLimitHeaders(res: Response, decision: RateLimitDecision): void {
  if (decision.limit === -1) {
    return;
  }

  res.set('X-RateLimit-Limit', String(decision.limit));
  res.set('X-RateLimit-Remaining', String(decision.remaining));
  res.set('X-RateLimit-Reset', String(Math.ceil((Date.now() + decision.resetMs) / 1000)));
}

function applyRetryAfterHeader(res: Response, resetMs: number): void {
  const retryAfterSeconds = Math.max(1, Math.ceil(resetMs / 1000));
  res.set('Retry-After', String(retryAfterSeconds));
}

export async function checkTenantOperationRateLimit(params: {
  tenantId: string;
  operation?: RateLimitOperation;
  projectId?: string;
  overrideLimits?: Partial<TenantRateLimitConfig>;
}): Promise<RateLimitDecision> {
  const operation = params.operation ?? 'request';
  let limits = await getTenantRateLimits(params.tenantId, params.projectId);

  if (params.overrideLimits) {
    limits = { ...limits, ...params.overrideLimits };
  }

  const limit = resolveOperationLimit(limits, operation);
  if (limit === -1) {
    return {
      allowed: true,
      remaining: Number.POSITIVE_INFINITY,
      resetMs: 0,
      limit,
    };
  }

  const limiter = getHybridRateLimiter();
  const result = await limiter.check(`tenant:${params.tenantId}`, operation, limit);

  return {
    allowed: result.allowed,
    remaining: result.remaining,
    resetMs: result.resetMs,
    limit,
  };
}

// =============================================================================
// PLAN-AWARE LIMIT RESOLUTION
// =============================================================================

/**
 * Resolve rate limits for a tenant from plan-based config, then apply
 * tenant LLM policy override for `requestsPerMinute` (takes the stricter
 * of plan limit vs. policy `maxRequestsPerMinute`).
 *
 * Calls TenantConfigService.getConfigAsync() which reads from Redis cache,
 * then DB, then plan defaults. Falls back to DEFAULT_LIMITS on any failure.
 */
export async function getTenantRateLimits(
  tenantId: string,
  projectId?: string,
): Promise<TenantRateLimitConfig> {
  try {
    const configService = getTenantConfigService();
    const config = projectId
      ? await configService.getProjectConfig(tenantId, projectId)
      : await configService.getConfigAsync(tenantId);

    // Populate circuit breaker plan cache so tenant-specific CB thresholds apply
    registerTenantPlan(tenantId, config.plan);

    let requestsPerMinute = config.limits.requestsPerMinute;

    log.debug('Resolved tenant rate limits', {
      tenantId,
      plan: config.plan,
      requestsPerMinute,
      projectId: projectId || undefined,
    });

    // Apply tenant LLM policy override.
    // When the plan limit is -1 (unlimited), the policy becomes the effective limit.
    // When both are positive, take the stricter (lower) of the two.
    // Policy maxRequestsPerMinute 0 = no override (use plan limit as-is).
    try {
      const { findLLMPolicyOrDefaults } = await import('../repos/tenant-llm-policy-repo.js');
      const policy = await findLLMPolicyOrDefaults(tenantId);
      if (policy.maxRequestsPerMinute > 0) {
        if (requestsPerMinute === -1) {
          // Plan is unlimited — policy sets the effective cap
          requestsPerMinute = policy.maxRequestsPerMinute;
        } else {
          requestsPerMinute = Math.min(requestsPerMinute, policy.maxRequestsPerMinute);
        }
      }
    } catch (policyErr) {
      log.debug('LLM policy lookup failed, using plan-based limit only', {
        tenantId,
        error: policyErr instanceof Error ? policyErr.message : String(policyErr),
      });
    }

    return {
      requestsPerMinute,
      tokensPerMinute: config.limits.tokensPerMinute,
      concurrentSessions: config.limits.maxConcurrentSessions,
      toolCallsPerMinute: config.limits.toolCallsPerMinute,
    };
  } catch (err) {
    log.warn('Failed to load tenant config, using defaults', {
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ...DEFAULT_LIMITS };
  }
}

// =============================================================================
// IN-MEMORY RATE LIMITER (used as fallback by HybridRateLimiter)
// =============================================================================

/** Max entries in in-memory rate limiter windows Map before forced cleanup */
const MAX_RATE_LIMITER_ENTRIES = safeParseInt(process.env.RATE_LIMITER_MAX_ENTRIES, 50_000);

export class InMemoryRateLimiter {
  /**
   * Map: `${tenantId}:${operation}` -> SlidingWindowEntry
   */
  private windows: Map<string, SlidingWindowEntry> = new Map();
  private cleanupInterval: NodeJS.Timeout;
  private readonly maxEntries: number;
  private readonly cleanupGraceMs: number;

  /** Cleanup interval in ms (default: 5 minutes) */
  private static readonly CLEANUP_INTERVAL_MS = safeParseInt(
    process.env.RATE_LIMITER_CLEANUP_INTERVAL_MS,
    5 * 60 * 1000,
  );

  /** Grace period before evicting expired entries in ms (default: 2 minutes) */
  private static readonly DEFAULT_CLEANUP_GRACE_MS = safeParseInt(
    process.env.RATE_LIMITER_CLEANUP_GRACE_MS,
    120_000,
  );

  constructor(options?: { maxEntries?: number; cleanupGraceMs?: number }) {
    this.maxEntries = options?.maxEntries ?? MAX_RATE_LIMITER_ENTRIES;
    this.cleanupGraceMs = options?.cleanupGraceMs ?? InMemoryRateLimiter.DEFAULT_CLEANUP_GRACE_MS;
    // Clean up expired entries periodically
    this.cleanupInterval = setInterval(
      () => this.cleanup(),
      InMemoryRateLimiter.CLEANUP_INTERVAL_MS,
    );
    this.cleanupInterval.unref();
  }

  /**
   * Check and increment a rate limit counter.
   * Returns { allowed, remaining, resetMs }.
   */
  check(
    tenantId: string,
    operation: RateLimitOperation,
    limit: number,
    windowMs = 60000,
    increment = 1,
  ): { allowed: boolean; remaining: number; resetMs: number } {
    const key = `${tenantId}:${operation}`;
    const now = Date.now();

    // Force cleanup if Map exceeds safety cap (prevents unbounded growth between intervals)
    if (this.windows.size >= this.maxEntries) {
      this.cleanup();
    }

    let entry = this.windows.get(key);

    // If no entry or window expired, create new window
    if (!entry || now - entry.windowStart >= windowMs) {
      entry = { count: 0, windowStart: now };
      this.windows.set(key, entry);
    }

    const resetMs = entry.windowStart + windowMs - now;

    if (entry.count + increment > limit) {
      return {
        allowed: false,
        remaining: Math.max(0, limit - entry.count),
        resetMs,
      };
    }

    entry.count += increment;
    return {
      allowed: true,
      remaining: limit - entry.count,
      resetMs,
    };
  }

  /**
   * Get current count without incrementing
   */
  peek(tenantId: string, operation: RateLimitOperation, windowMs = 60000): number {
    const key = `${tenantId}:${operation}`;
    const entry = this.windows.get(key);
    if (!entry) return 0;
    if (Date.now() - entry.windowStart >= windowMs) return 0;
    return entry.count;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.windows.entries()) {
      if (now - entry.windowStart >= this.cleanupGraceMs) {
        this.windows.delete(key);
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
    this.windows.clear();
  }
}

// =============================================================================
// MIDDLEWARE
// =============================================================================

/**
 * Per-tenant rate limiting middleware.
 * Must be used AFTER authMiddleware (requires req.tenantContext).
 *
 * When no tenant context is present, falls back to IP-based limiting.
 * Uses HybridRateLimiter: Redis primary + in-memory fallback.
 */
export function tenantRateLimit(
  operation: RateLimitOperation = 'request',
  overrideLimits?: Partial<TenantRateLimitConfig>,
): RequestHandler {
  return (async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const limiter = getHybridRateLimiter();

    // Resolve plan-based limits for authenticated tenants, fall back to defaults
    // Pass projectId when available so project-level overrides are applied
    const rawTenantId = req.tenantContext?.tenantId;
    const projectId = (req.params as Record<string, string>)?.projectId;
    let limits: TenantRateLimitConfig;
    if (rawTenantId) {
      try {
        limits = await getTenantRateLimits(rawTenantId, projectId);
      } catch {
        limits = { ...DEFAULT_LIMITS };
      }
    } else {
      log.debug('No tenantId on request, using DEFAULT_LIMITS', {
        path: req.path,
        method: req.method,
        requestsPerMinute: DEFAULT_LIMITS.requestsPerMinute,
      });
      limits = { ...DEFAULT_LIMITS };
    }

    // Apply any per-route overrides on top of resolved limits
    if (overrideLimits) {
      limits = { ...limits, ...overrideLimits };
    }

    // Determine tenant key — prefixed to prevent namespace collisions
    const tenantKey = rawTenantId
      ? `tenant:${rawTenantId}`
      : req.ip
        ? `ip:${req.ip}`
        : 'anon:unknown';

    const limit = resolveOperationLimit(limits, operation);

    // Unlimited (-1) — skip rate limiting entirely
    if (limit === -1) {
      next();
      return;
    }

    // Per-API-key sub-limit: check BEFORE tenant counter to avoid consuming
    // tenant quota for requests that would be rejected at the per-key level.
    // Note: if the per-key check passes but the tenant check rejects, the
    // per-key counter is slightly pessimistic. This is acceptable because
    // tenant limits are 5x per-key limits, so the drift is negligible.
    if (req.tenantContext?.authType === 'api_key' && req.tenantContext?.apiKeyId) {
      const apiKeyDivisor = safeParseInt(process.env.RATE_LIMITER_API_KEY_DIVISOR, 5);
      const perKeyLimit = Math.max(10, Math.floor(limit / apiKeyDivisor));
      const keyResult = await limiter.check(
        `apiKey:${req.tenantContext.apiKeyId}`,
        operation,
        perKeyLimit,
      );
      if (!keyResult.allowed) {
        recordRateLimitRejection({
          tenantId: rawTenantId || 'unknown',
          operation: `apiKey:${operation}`,
        });
        res.set('X-RateLimit-Limit', String(perKeyLimit));
        res.set('X-RateLimit-Remaining', String(keyResult.remaining));
        res.set('X-RateLimit-Reset', String(Math.ceil((Date.now() + keyResult.resetMs) / 1000)));
        applyRetryAfterHeader(res, keyResult.resetMs);
        res.status(429).json({
          error: 'API key rate limit exceeded',
          operation,
          limit: perKeyLimit,
          retryAfterMs: keyResult.resetMs,
        });
        return;
      }
    }

    const result = await limiter.check(tenantKey, operation, limit);

    applyRateLimitHeaders(res, { ...result, limit });

    if (!result.allowed) {
      recordRateLimitRejection({
        tenantId: rawTenantId || 'unknown',
        operation,
      });
      applyRetryAfterHeader(res, result.resetMs);
      res.status(429).json({
        error: 'Rate limit exceeded',
        operation,
        limit,
        retryAfterMs: result.resetMs,
      });
      return;
    }

    next();
  }) as RequestHandler;
}

// =============================================================================
// PER-SESSION MESSAGE RATE LIMITING
// =============================================================================

/** Max messages per minute per session */
const SESSION_MESSAGE_RATE_LIMIT = safeParseInt(process.env.SESSION_MESSAGE_RATE_LIMIT, 30);

/**
 * Check whether a session can send another message.
 * Uses the shared HybridRateLimiter with key `session:{sessionId}`.
 */
export async function checkSessionMessageRate(
  sessionId: string,
): Promise<{ allowed: boolean; retryAfterMs?: number }> {
  const limiter = getHybridRateLimiter();
  const result = await limiter.check(
    `session:${sessionId}`,
    'session_message',
    SESSION_MESSAGE_RATE_LIMIT,
  );
  return {
    allowed: result.allowed,
    retryAfterMs: result.allowed ? undefined : result.resetMs,
  };
}

/**
 * Record token usage for rate limiting (call after LLM operations).
 * Reads plan-based tokensPerMinute from TenantConfigService.
 * If the plan limit is -1 (unlimited), skips the check entirely.
 */
export async function recordTokenUsage(
  tenantId: string,
  tokenCount: number,
  projectId?: string,
): Promise<{
  allowed: boolean;
  remaining: number;
}> {
  const limits = await getTenantRateLimits(tenantId, projectId);

  // Unlimited tokens — skip rate limiter entirely
  if (limits.tokensPerMinute === -1) {
    return { allowed: true, remaining: Infinity };
  }

  const limiter = getHybridRateLimiter();
  const result = await limiter.check(
    `tenant:${tenantId}`,
    'llm_tokens',
    limits.tokensPerMinute,
    60000,
    tokenCount,
  );
  return { allowed: result.allowed, remaining: result.remaining };
}

/**
 * Check if a tenant can start a new session.
 * Reads plan-based concurrentSessions from TenantConfigService.
 * If the plan limit is -1 (unlimited), always returns true.
 */
export async function canStartSession(tenantId: string, projectId?: string): Promise<boolean> {
  const limits = await getTenantRateLimits(tenantId, projectId);

  // Unlimited concurrent sessions
  if (limits.concurrentSessions === -1) {
    return true;
  }

  const current = await getSessionCount(tenantId);
  return current < limits.concurrentSessions;
}

// =============================================================================
// SESSION COUNTING (Redis SET — per-session membership tracking)
// =============================================================================

const SESSION_SET_PREFIX = 'sessions:active:';

/** SET key TTL in seconds (configurable, default 48h — safety net for pod crash) */
const SESSION_SET_TTL_SECONDS = safeParseInt(process.env.SESSION_SET_TTL_SECONDS, 172_800);

/**
 * Lua script for atomic check-and-add with limit enforcement.
 * KEYS[1] = set key, ARGV[1] = sessionId, ARGV[2] = limit (-1 = unlimited), ARGV[3] = TTL seconds.
 * Returns -1 if limit exceeded, otherwise the current/new member count.
 *
 * Re-claiming an already tracked session is idempotent and refreshes the set TTL.
 */
const LUA_CHECK_AND_ADD: LuaScript = {
  name: 'session-slot-check-and-add',
  body: `
local key = KEYS[1]
local sessionId = ARGV[1]
local limit = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
if redis.call('SISMEMBER', key, sessionId) == 1 then
  redis.call('EXPIRE', key, ttl)
  return redis.call('SCARD', key)
end
local current = redis.call('SCARD', key)
if limit >= 0 and current >= limit then
  return -1
end
redis.call('SADD', key, sessionId)
redis.call('EXPIRE', key, ttl)
return redis.call('SCARD', key)
`,
  numberOfKeys: 1,
};

/**
 * Lua script for removing a session from the set.
 * Returns the remaining member count.
 */
const LUA_REMOVE_MEMBER: LuaScript = {
  name: 'session-slot-remove-member',
  body: `
redis.call('SREM', KEYS[1], ARGV[1])
return redis.call('SCARD', KEYS[1])
`,
  numberOfKeys: 1,
};

interface MemorySessionSetEntry {
  sessionIds: Set<string>;
  expiresAtMs: number;
}

// In-memory fallback for when Redis is unavailable
const memorySessionSets = new Map<string, MemorySessionSetEntry>();
const MAX_MEMORY_SESSION_ENTRIES = safeParseInt(
  process.env.SESSION_COUNT_MAX_MEMORY_ENTRIES,
  10_000,
);
const SESSION_SET_TTL_MS = SESSION_SET_TTL_SECONDS * 1000;

function getActiveMemorySessionSet(
  tenantId: string,
  now = Date.now(),
): MemorySessionSetEntry | undefined {
  const entry = memorySessionSets.get(tenantId);
  if (!entry) {
    return undefined;
  }

  if (entry.expiresAtMs <= now) {
    memorySessionSets.delete(tenantId);
    return undefined;
  }

  return entry;
}

function evictExpiredMemorySessionSets(now = Date.now()): void {
  for (const [tenantId, entry] of memorySessionSets) {
    if (entry.expiresAtMs <= now) {
      memorySessionSets.delete(tenantId);
    }
  }
}

function touchMemorySessionSet(entry: MemorySessionSetEntry, now = Date.now()): void {
  entry.expiresAtMs = now + SESSION_SET_TTL_MS;
}

function memoryClaim(tenantId: string, sessionId: string, limit: number): number {
  const now = Date.now();
  let entry = getActiveMemorySessionSet(tenantId, now);
  if (!entry) {
    evictExpiredMemorySessionSets(now);
    if (memorySessionSets.size >= MAX_MEMORY_SESSION_ENTRIES) {
      const oldest = memorySessionSets.keys().next().value;
      if (oldest !== undefined) {
        memorySessionSets.delete(oldest);
      }
    }
    entry = {
      sessionIds: new Set(),
      expiresAtMs: now + SESSION_SET_TTL_MS,
    };
    memorySessionSets.set(tenantId, entry);
  }

  if (entry.sessionIds.has(sessionId)) {
    touchMemorySessionSet(entry, now);
    return entry.sessionIds.size;
  }

  if (limit >= 0 && entry.sessionIds.size >= limit) {
    return -1;
  }

  entry.sessionIds.add(sessionId);
  touchMemorySessionSet(entry, now);
  return entry.sessionIds.size;
}

function memoryRelease(tenantId: string, sessionId: string): number {
  const entry = getActiveMemorySessionSet(tenantId);
  if (!entry) {
    return 0;
  }

  entry.sessionIds.delete(sessionId);
  if (entry.sessionIds.size === 0) {
    memorySessionSets.delete(tenantId);
    return 0;
  }

  return entry.sessionIds.size;
}

function memoryCount(tenantId: string): number {
  return getActiveMemorySessionSet(tenantId)?.sessionIds.size ?? 0;
}

/**
 * Atomically check limit and claim a session slot.
 * Returns the new count, or -1 if the limit has been reached.
 */
export async function claimSessionSlot(
  tenantId: string,
  sessionId: string,
  limit = -1,
): Promise<number> {
  const redis = getRedisClient();
  if (redis) {
    try {
      const result = await runLuaScript<number>(
        redis,
        LUA_CHECK_AND_ADD,
        [`${SESSION_SET_PREFIX}${tenantId}`],
        [sessionId, String(limit), String(SESSION_SET_TTL_SECONDS)],
      );
      return result;
    } catch (err) {
      log.warn('Redis SADD failed for session slot', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return memoryClaim(tenantId, sessionId, limit);
}

/**
 * Release a session slot by removing the session ID from the set.
 */
export async function releaseSessionSlot(tenantId: string, sessionId: string): Promise<number> {
  const redis = getRedisClient();
  if (redis) {
    try {
      const result = await runLuaScript<number>(
        redis,
        LUA_REMOVE_MEMBER,
        [`${SESSION_SET_PREFIX}${tenantId}`],
        [sessionId],
      );
      return result;
    } catch (err) {
      log.warn('Redis SREM failed for session slot', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return memoryRelease(tenantId, sessionId);
}

/**
 * Get current active session count for a tenant.
 */
export async function getSessionCount(tenantId: string): Promise<number> {
  const redis = getRedisClient();
  if (redis) {
    try {
      const val = await redis.scard(`${SESSION_SET_PREFIX}${tenantId}`);
      return val ?? 0;
    } catch (err) {
      log.warn('Redis SCARD failed for session count', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return memoryCount(tenantId);
}

// Backward-compatible aliases during migration
export { claimSessionSlot as incrementSessionCount };
export { releaseSessionSlot as decrementSessionCount };
