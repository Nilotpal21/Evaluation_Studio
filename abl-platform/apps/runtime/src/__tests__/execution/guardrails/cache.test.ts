import { describe, it, expect, beforeEach } from 'vitest';
import {
  GuardrailCache,
  type RedisLike,
  type CachedGuardrailResult,
  type GuardrailCacheConfig,
} from '../../../services/guardrails/cache';

// ---------------------------------------------------------------------------
// MockRedis — in-memory implementation of RedisLike for testing
// ---------------------------------------------------------------------------

class MockRedis implements RedisLike {
  private store = new Map<string, { value: string; expiresAt?: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, mode: string, duration: number): Promise<'OK'> {
    this.store.set(key, {
      value,
      expiresAt: mode === 'EX' ? Date.now() + duration * 1000 : undefined,
    });
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      if (this.store.delete(key)) count++;
    }
    return count;
  }

  async scan(cursor: string, ...args: (string | number)[]): Promise<[string, string[]]> {
    const matchIdx = args.indexOf('MATCH');
    const pattern = matchIdx >= 0 ? String(args[matchIdx + 1]) : '*';
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    const keys = [...this.store.keys()].filter((k) => regex.test(k));
    return ['0', keys];
  }

  /** Expose store size for assertions */
  get size(): number {
    return this.store.size;
  }
}

/**
 * MockRedis that throws on every operation — used to test error resilience.
 */
class FailingRedis implements RedisLike {
  async get(): Promise<string | null> {
    throw new Error('Redis connection lost');
  }
  async set(): Promise<unknown> {
    throw new Error('Redis connection lost');
  }
  async del(): Promise<number> {
    throw new Error('Redis connection lost');
  }
  async scan(): Promise<[string, string[]]> {
    throw new Error('Redis connection lost');
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TENANT_ID = 'tenant-1';
const PROJECT_ID = 'project-1';
const GUARDRAIL_NAME = 'pii_check';
const CONTENT = 'Please process my order for John Doe';

function makeCachedResult(overrides?: Partial<CachedGuardrailResult>): CachedGuardrailResult {
  return {
    passed: true,
    outcome: 'pass',
    cachedAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GuardrailCache', () => {
  let redis: MockRedis;
  let cache: GuardrailCache;

  beforeEach(() => {
    redis = new MockRedis();
    cache = new GuardrailCache(redis);
  });

  // -----------------------------------------------------------------------
  // 1. Cache miss
  // -----------------------------------------------------------------------
  it('should return null on cache miss', async () => {
    const result = await cache.get(TENANT_ID, PROJECT_ID, GUARDRAIL_NAME, CONTENT);
    expect(result).toBeNull();
  });

  // -----------------------------------------------------------------------
  // 2. Tier 1 (local) — 24h TTL
  // -----------------------------------------------------------------------
  it('should store and retrieve Tier 1 (local) result with 24h TTL', async () => {
    const cachedResult = makeCachedResult({ passed: true });

    await cache.set(TENANT_ID, PROJECT_ID, GUARDRAIL_NAME, CONTENT, 'local', cachedResult);

    const retrieved = await cache.get(TENANT_ID, PROJECT_ID, GUARDRAIL_NAME, CONTENT, {
      tier: 'local',
    });
    expect(retrieved).not.toBeNull();
    expect(retrieved!.passed).toBe(true);
    expect(retrieved!.cachedAt).toBe(cachedResult.cachedAt);
  });

  // -----------------------------------------------------------------------
  // 3. Tier 2 (model) — 1h TTL
  // -----------------------------------------------------------------------
  it('should store and retrieve Tier 2 (model) result with 1h TTL', async () => {
    const cachedResult = makeCachedResult({
      passed: false,
      outcome: 'violation',
      violation: {
        action: 'block',
        message: 'Toxic content detected',
        score: 0.95,
        severity: 'critical',
      },
    });

    await cache.set(TENANT_ID, PROJECT_ID, GUARDRAIL_NAME, CONTENT, 'model', cachedResult);

    const retrieved = await cache.get(TENANT_ID, PROJECT_ID, GUARDRAIL_NAME, CONTENT, {
      tier: 'model',
    });
    expect(retrieved).not.toBeNull();
    expect(retrieved!.passed).toBe(false);
    expect(retrieved!.outcome).toBe('violation');
    expect(retrieved!.violation?.action).toBe('block');
    expect(retrieved!.violation?.message).toBe('Toxic content detected');
    expect(retrieved!.violation?.score).toBe(0.95);
    expect(retrieved!.violation?.severity).toBe('critical');
  });

  // -----------------------------------------------------------------------
  // 4. Tier 3 (LLM) — NEVER cached
  // -----------------------------------------------------------------------
  it('should NOT cache Tier 3 (llm) results', async () => {
    const cachedResult = makeCachedResult({ passed: true });

    await cache.set(TENANT_ID, PROJECT_ID, GUARDRAIL_NAME, CONTENT, 'llm', cachedResult);

    const retrieved = await cache.get(TENANT_ID, PROJECT_ID, GUARDRAIL_NAME, CONTENT, {
      tier: 'llm',
    });
    expect(retrieved).toBeNull();
    expect(redis.size).toBe(0);
  });

  // -----------------------------------------------------------------------
  // 5. Cache key consistency with SHA256
  // -----------------------------------------------------------------------
  it('should build consistent cache keys using SHA256', () => {
    const key1 = cache.buildKey(TENANT_ID, PROJECT_ID, GUARDRAIL_NAME, CONTENT);
    const key2 = cache.buildKey(TENANT_ID, PROJECT_ID, GUARDRAIL_NAME, CONTENT);
    expect(key1).toBe(key2);

    // Different content produces different key
    const key3 = cache.buildKey(TENANT_ID, PROJECT_ID, GUARDRAIL_NAME, 'different content');
    expect(key3).not.toBe(key1);

    // Key format: prefix:tenantId:projectId:scopeKey:tier:guardrailName:hash
    const parts = key1.split(':');
    expect(parts).toHaveLength(7);
    expect(parts[0]).toBe('guardrail');
    expect(parts[1]).toBe(TENANT_ID);
    expect(parts[2]).toBe(PROJECT_ID);
    expect(parts[3]).toBe('global');
    expect(parts[4]).toBe('unknown');
    expect(parts[5]).toBe(GUARDRAIL_NAME);
    // Hash should be 16 hex characters (truncated SHA256)
    expect(parts[6]).toMatch(/^[0-9a-f]{16}$/);
  });

  it('should isolate same-named guardrail entries by execution scope and tier', async () => {
    const agentAResult = makeCachedResult({
      passed: false,
      outcome: 'violation',
      violation: { action: 'block', message: 'Agent A blocked' },
    });
    const agentBResult = makeCachedResult({
      passed: true,
      outcome: 'pass',
    });

    await cache.set(
      TENANT_ID,
      PROJECT_ID,
      GUARDRAIL_NAME,
      CONTENT,
      'model',
      agentAResult,
      undefined,
      { scopeKey: 'agent-a-rev-1' },
    );
    await cache.set(
      TENANT_ID,
      PROJECT_ID,
      GUARDRAIL_NAME,
      CONTENT,
      'model',
      agentBResult,
      undefined,
      { scopeKey: 'agent-b-rev-1' },
    );
    await cache.set(
      TENANT_ID,
      PROJECT_ID,
      GUARDRAIL_NAME,
      CONTENT,
      'local',
      makeCachedResult({ passed: true, outcome: 'pass' }),
      undefined,
      { scopeKey: 'agent-a-rev-1' },
    );

    const agentA = await cache.get(TENANT_ID, PROJECT_ID, GUARDRAIL_NAME, CONTENT, {
      scopeKey: 'agent-a-rev-1',
      tier: 'model',
    });
    const agentB = await cache.get(TENANT_ID, PROJECT_ID, GUARDRAIL_NAME, CONTENT, {
      scopeKey: 'agent-b-rev-1',
      tier: 'model',
    });
    const agentALocal = await cache.get(TENANT_ID, PROJECT_ID, GUARDRAIL_NAME, CONTENT, {
      scopeKey: 'agent-a-rev-1',
      tier: 'local',
    });

    expect(agentA?.violation?.message).toBe('Agent A blocked');
    expect(agentB?.passed).toBe(true);
    expect(agentB?.outcome).toBe('pass');
    expect(agentALocal?.outcome).toBe('pass');
    expect(redis.size).toBe(3);
  });

  // -----------------------------------------------------------------------
  // 6. Redis error resilience — get
  // -----------------------------------------------------------------------
  it('should handle Redis errors gracefully on get (fail-open)', async () => {
    const failingCache = new GuardrailCache(new FailingRedis());

    // Should return null (cache miss) instead of throwing
    const result = await failingCache.get(TENANT_ID, PROJECT_ID, GUARDRAIL_NAME, CONTENT);
    expect(result).toBeNull();
  });

  // -----------------------------------------------------------------------
  // 7. Redis error resilience — set
  // -----------------------------------------------------------------------
  it('should handle Redis errors gracefully on set (fail-open)', async () => {
    const failingCache = new GuardrailCache(new FailingRedis());

    // Should not throw — silently fail
    await expect(
      failingCache.set(TENANT_ID, PROJECT_ID, GUARDRAIL_NAME, CONTENT, 'local', makeCachedResult()),
    ).resolves.toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // 8. Caching disabled via config
  // -----------------------------------------------------------------------
  it('should return null when caching is disabled', async () => {
    const disabledCache = new GuardrailCache(redis, { enabled: false });

    await disabledCache.set(
      TENANT_ID,
      PROJECT_ID,
      GUARDRAIL_NAME,
      CONTENT,
      'local',
      makeCachedResult(),
    );

    const result = await disabledCache.get(TENANT_ID, PROJECT_ID, GUARDRAIL_NAME, CONTENT);
    expect(result).toBeNull();
    expect(redis.size).toBe(0);
  });

  // -----------------------------------------------------------------------
  // 9. No Redis client provided
  // -----------------------------------------------------------------------
  it('should return null when no Redis client is provided', async () => {
    const noRedisCache = new GuardrailCache(null);

    await noRedisCache.set(
      TENANT_ID,
      PROJECT_ID,
      GUARDRAIL_NAME,
      CONTENT,
      'local',
      makeCachedResult(),
    );

    const result = await noRedisCache.get(TENANT_ID, PROJECT_ID, GUARDRAIL_NAME, CONTENT);
    expect(result).toBeNull();
  });

  // -----------------------------------------------------------------------
  // 10. Invalidation by pattern
  // -----------------------------------------------------------------------
  it('should invalidate cached results by guardrail name pattern', async () => {
    const result1 = makeCachedResult({ passed: true });
    const result2 = makeCachedResult({
      passed: false,
      outcome: 'violation',
      violation: { action: 'block' },
    });

    // Cache two different content strings for the same guardrail
    await cache.set(TENANT_ID, PROJECT_ID, GUARDRAIL_NAME, 'content A', 'local', result1);
    await cache.set(TENANT_ID, PROJECT_ID, GUARDRAIL_NAME, 'content B', 'local', result2);

    // Cache a different guardrail that should NOT be invalidated
    await cache.set(TENANT_ID, PROJECT_ID, 'toxicity_check', 'content A', 'model', result1);

    expect(redis.size).toBe(3);

    // Invalidate pii_check guardrail
    const deleted = await cache.invalidate(TENANT_ID, PROJECT_ID, GUARDRAIL_NAME);
    expect(deleted).toBe(2);

    // The pii_check entries should be gone
    const miss1 = await cache.get(TENANT_ID, PROJECT_ID, GUARDRAIL_NAME, 'content A', {
      tier: 'local',
    });
    const miss2 = await cache.get(TENANT_ID, PROJECT_ID, GUARDRAIL_NAME, 'content B', {
      tier: 'local',
    });
    expect(miss1).toBeNull();
    expect(miss2).toBeNull();

    // The toxicity_check entry should still exist
    const hit = await cache.get(TENANT_ID, PROJECT_ID, 'toxicity_check', 'content A', {
      tier: 'model',
    });
    expect(hit).not.toBeNull();
    expect(hit!.passed).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 11. Invalidation with no Redis client
  // -----------------------------------------------------------------------
  it('should return 0 when invalidating without Redis client', async () => {
    const noRedisCache = new GuardrailCache(null);
    const deleted = await noRedisCache.invalidate(TENANT_ID, PROJECT_ID, GUARDRAIL_NAME);
    expect(deleted).toBe(0);
  });

  // -----------------------------------------------------------------------
  // 12. Invalidation error resilience
  // -----------------------------------------------------------------------
  it('should handle Redis errors gracefully on invalidate', async () => {
    const failingCache = new GuardrailCache(new FailingRedis());
    const deleted = await failingCache.invalidate(TENANT_ID, PROJECT_ID, GUARDRAIL_NAME);
    expect(deleted).toBe(0);
  });

  // -----------------------------------------------------------------------
  // 13. Custom key prefix
  // -----------------------------------------------------------------------
  it('should support custom key prefix', () => {
    const customCache = new GuardrailCache(redis, { enabled: true, keyPrefix: 'gr-v2' });
    const key = customCache.buildKey(TENANT_ID, PROJECT_ID, GUARDRAIL_NAME, CONTENT);
    expect(key.startsWith('gr-v2:')).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 14. Tenant isolation — different tenants get different keys
  // -----------------------------------------------------------------------
  it('should isolate cache entries by tenant', async () => {
    const resultA = makeCachedResult({ passed: true });
    const resultB = makeCachedResult({
      passed: false,
      outcome: 'violation',
      violation: { action: 'block' },
    });

    await cache.set('tenant-A', PROJECT_ID, GUARDRAIL_NAME, CONTENT, 'local', resultA);
    await cache.set('tenant-B', PROJECT_ID, GUARDRAIL_NAME, CONTENT, 'local', resultB);

    const retrievedA = await cache.get('tenant-A', PROJECT_ID, GUARDRAIL_NAME, CONTENT, {
      tier: 'local',
    });
    const retrievedB = await cache.get('tenant-B', PROJECT_ID, GUARDRAIL_NAME, CONTENT, {
      tier: 'local',
    });

    expect(retrievedA!.passed).toBe(true);
    expect(retrievedB!.passed).toBe(false);
    expect(retrievedB!.violation?.action).toBe('block');
  });

  // -----------------------------------------------------------------------
  // 15. Project isolation — different projects get different keys
  // -----------------------------------------------------------------------
  it('should isolate cache entries by project', async () => {
    const resultA = makeCachedResult({ passed: true });
    const resultB = makeCachedResult({
      passed: false,
      outcome: 'violation',
      violation: { action: 'block' },
    });

    await cache.set(TENANT_ID, 'project-A', GUARDRAIL_NAME, CONTENT, 'local', resultA);
    await cache.set(TENANT_ID, 'project-B', GUARDRAIL_NAME, CONTENT, 'local', resultB);

    const retrievedA = await cache.get(TENANT_ID, 'project-A', GUARDRAIL_NAME, CONTENT, {
      tier: 'local',
    });
    const retrievedB = await cache.get(TENANT_ID, 'project-B', GUARDRAIL_NAME, CONTENT, {
      tier: 'local',
    });

    expect(retrievedA!.passed).toBe(true);
    expect(retrievedB!.passed).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 16. Unknown tier — not cached (future safety)
  // -----------------------------------------------------------------------
  it('should not cache results for unknown tier values', async () => {
    const cachedResult = makeCachedResult({ passed: true });

    await cache.set(TENANT_ID, PROJECT_ID, GUARDRAIL_NAME, CONTENT, 'unknown_tier', cachedResult);

    const retrieved = await cache.get(TENANT_ID, PROJECT_ID, GUARDRAIL_NAME, CONTENT, {
      tier: 'unknown_tier',
    });
    expect(retrieved).toBeNull();
    expect(redis.size).toBe(0);
  });
});
