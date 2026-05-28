/**
 * Redis-backed exact-match cache for guardrail evaluation results.
 *
 * Keying:
 *   guardrail:{tenantId}:{projectId}:{scopeKey}:{tier}:{guardrailName}:{sha256(content)}
 *
 * This avoids re-evaluating the same content against the same guardrail while
 * keeping same-named guardrails isolated across agent/revision scopes.
 *
 * TTL per tier:
 *   - Tier 1 (local): 24 hours — deterministic CEL checks, results don't drift
 *   - Tier 2 (model): 1 hour — model classification may drift over time
 *   - Tier 3 (llm):   NOT cached — context-dependent (conversation history)
 *
 * Fail-open: all Redis errors are caught and logged. A cache failure
 * results in a cache miss (re-evaluate), never a blocked request.
 */

import crypto from 'crypto';
import { createLogger } from '@abl/compiler/platform';
import { scanKeys, type RedisClient } from '@agent-platform/redis';

const log = createLogger('guardrail-cache');

// ---------------------------------------------------------------------------
// TTL Configuration
// ---------------------------------------------------------------------------

/** TTLs per tier in seconds */
const TIER_TTL_SECONDS: Record<string, number> = {
  local: 86400, // 24 hours for Tier 1 (deterministic CEL checks)
  model: 3600, // 1 hour for Tier 2 (model results may drift)
  // llm: intentionally absent — Tier 3 results are never cached
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CachedGuardrailResult {
  passed: boolean;
  outcome?: 'pass' | 'warning' | 'violation';
  violation?: {
    action?: string;
    resolvedAction?: unknown;
    severity?: string;
    score?: number;
    threshold?: number;
    category?: string;
    label?: string;
    message?: string;
    explanation?: string;
    priority?: number;
    provider?: string;
    modifiedContent?: string;
  };
  cachedAt: number;

  /** Legacy flat payload fields retained only for old cache replay compatibility. */
  action?: string;
  message?: string;
  modifiedContent?: string;
  score?: number;
  severity?: string;
}

export interface GuardrailCacheConfig {
  enabled: boolean;
  keyPrefix?: string;
}

export interface GuardrailCacheKeyOptions {
  /** Stable compiled-agent/revision identity. Defaults to explicit global scope. */
  scopeKey?: string;
  /** Guardrail tier namespace (`local`, `model`, etc.). */
  tier?: string;
}

/**
 * Minimal Redis-like interface for dependency injection.
 * Compatible with ioredis and node-redis.
 */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: string, duration: number): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  scan(cursor: string, ...args: (string | number)[]): Promise<[string, string[]]>;
}

const DEFAULT_SCOPE_KEY = 'global';
const DEFAULT_TIER_KEY = 'unknown';
const MAX_KEY_SEGMENT_LENGTH = 160;

function safeKeySegment(value: string | undefined, fallback: string): string {
  const raw = typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
  const normalized = raw.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, MAX_KEY_SEGMENT_LENGTH);
  return normalized.length > 0 ? normalized : fallback;
}

// ---------------------------------------------------------------------------
// GuardrailCache
// ---------------------------------------------------------------------------

export class GuardrailCache {
  private readonly redis: RedisLike | null;
  private readonly config: GuardrailCacheConfig;
  private readonly prefix: string;

  constructor(redis: RedisLike | null, config?: Partial<GuardrailCacheConfig>) {
    this.redis = redis;
    this.config = { enabled: true, ...config };
    this.prefix = config?.keyPrefix ?? 'guardrail';
  }

  /**
   * Build the cache key for a guardrail evaluation.
   *
   * Format: {prefix}:{tenantId}:{projectId}:{scopeKey}:{tier}:{guardrailName}:{sha256_16}
   *
   * The content hash is a truncated SHA-256 (first 16 hex chars = 64 bits),
   * which is sufficient for exact-match dedup within a per-guardrail namespace.
   */
  buildKey(
    tenantId: string,
    projectId: string,
    guardrailName: string,
    content: string,
    options?: GuardrailCacheKeyOptions,
  ): string {
    const contentHash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
    const safeTenantId = safeKeySegment(tenantId, 'unknown-tenant');
    const safeProjectId = safeKeySegment(projectId, 'unknown-project');
    const safeScopeKey = safeKeySegment(options?.scopeKey, DEFAULT_SCOPE_KEY);
    const safeTier = safeKeySegment(options?.tier, DEFAULT_TIER_KEY);
    const safeGuardrailName = safeKeySegment(guardrailName, 'unknown-guardrail');
    return `${this.prefix}:${safeTenantId}:${safeProjectId}:${safeScopeKey}:${safeTier}:${safeGuardrailName}:${contentHash}`;
  }

  /**
   * Get a cached result. Returns null on miss or if caching is disabled.
   *
   * Fail-open: Redis errors return null (cache miss).
   */
  async get(
    tenantId: string,
    projectId: string,
    guardrailName: string,
    content: string,
    options?: GuardrailCacheKeyOptions,
  ): Promise<CachedGuardrailResult | null> {
    if (!this.config.enabled || !this.redis) return null;

    try {
      const key = this.buildKey(tenantId, projectId, guardrailName, content, options);
      const cached = await this.redis.get(key);
      if (!cached) return null;

      return JSON.parse(cached) as CachedGuardrailResult;
    } catch (err) {
      log.warn('Guardrail cache get failed', {
        guardrailName,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Store a result in the cache. Only caches Tier 1 and Tier 2 results.
   *
   * Tier 3 (LLM) results are never cached because they are context-dependent
   * (conversation history affects evaluation outcomes).
   *
   * Fail-open: Redis errors are logged but do not throw.
   */
  async set(
    tenantId: string,
    projectId: string,
    guardrailName: string,
    content: string,
    tier: string,
    result: CachedGuardrailResult,
    ttlSecondsOverride?: number,
    options?: GuardrailCacheKeyOptions,
  ): Promise<void> {
    if (!this.config.enabled || !this.redis) return;

    // Only cache tiers with a defined TTL (local, model). Tier 3 (llm) and
    // any unknown tier values are skipped.
    const ttl =
      typeof ttlSecondsOverride === 'number' && Number.isFinite(ttlSecondsOverride)
        ? Math.max(1, Math.floor(ttlSecondsOverride))
        : TIER_TTL_SECONDS[tier];
    if (!ttl) return;

    try {
      const key = this.buildKey(tenantId, projectId, guardrailName, content, {
        ...options,
        tier: options?.tier ?? tier,
      });
      await this.redis.set(key, JSON.stringify(result), 'EX', ttl);
    } catch (err) {
      log.warn('Guardrail cache set failed', {
        guardrailName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Invalidate cached results for a specific guardrail.
   * Used when guardrail rules change (e.g., threshold updated via admin API).
   *
   * Uses SCAN + DEL pattern for safe invalidation without blocking Redis.
   *
   * @returns Number of keys deleted
   */
  async invalidate(
    tenantId: string,
    projectId: string,
    guardrailName: string,
    options?: GuardrailCacheKeyOptions,
  ): Promise<number> {
    if (!this.redis) return 0;

    try {
      const safeTenantId = safeKeySegment(tenantId, 'unknown-tenant');
      const safeProjectId = safeKeySegment(projectId, 'unknown-project');
      const safeGuardrailName = safeKeySegment(guardrailName, 'unknown-guardrail');
      const scopePattern = options?.scopeKey
        ? safeKeySegment(options.scopeKey, DEFAULT_SCOPE_KEY)
        : '*';
      const tierPattern = options?.tier ? safeKeySegment(options.tier, DEFAULT_TIER_KEY) : '*';
      const scopedPattern = `${this.prefix}:${safeTenantId}:${safeProjectId}:${scopePattern}:${tierPattern}:${safeGuardrailName}:*`;
      const legacyPattern = `${this.prefix}:${safeTenantId}:${safeProjectId}:${safeGuardrailName}:*`;

      const scopedDeleted = await this.deleteByPattern(scopedPattern);
      const legacyDeleted = options ? 0 : await this.deleteByPattern(legacyPattern);
      return scopedDeleted + legacyDeleted;
    } catch (err) {
      log.warn('Guardrail cache invalidate failed', {
        guardrailName,
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  }

  private async deleteByPattern(pattern: string): Promise<number> {
    if (!this.redis) return 0;
    const keys: string[] = [];
    // RedisLike is structurally compatible with ioredis Redis/Cluster at runtime;
    // scanKeys requires the concrete RedisClient type for cluster-safe multi-node scan.
    for await (const key of scanKeys(this.redis as unknown as RedisClient, pattern, 100)) {
      keys.push(key);
    }
    if (keys.length > 0) {
      // Keys may span different cluster slots — delete individually.
      await Promise.all(keys.map((k) => this.redis!.del(k)));
    }
    return keys.length;
  }

  /**
   * Invalidate ALL cached guardrail eval results for a tenant.
   * Used when a guardrail policy is created, updated, or deleted —
   * threshold/action changes affect every guardrail under that tenant.
   *
   * Uses SCAN + DEL pattern for safe invalidation without blocking Redis.
   *
   * @returns Number of keys deleted
   */
  async invalidateByTenant(tenantId: string): Promise<number> {
    if (!this.redis) return 0;

    try {
      const pattern = `${this.prefix}:${safeKeySegment(tenantId, 'unknown-tenant')}:*`;
      const keys: string[] = [];
      // RedisLike → RedisClient cast: see deleteByPattern comment.
      for await (const key of scanKeys(this.redis as unknown as RedisClient, pattern, 100)) {
        keys.push(key);
      }
      if (keys.length > 0) {
        // Keys may span different cluster slots — delete individually.
        await Promise.all(keys.map((k) => this.redis!.del(k)));
      }
      return keys.length;
    } catch (err) {
      log.warn('Guardrail cache tenant invalidation failed', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  }
}
