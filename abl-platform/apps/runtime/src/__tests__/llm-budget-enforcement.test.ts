/**
 * Unit tests for LLM Budget Enforcement
 *
 * Tests the HybridBudgetEnforcer which uses Redis Lua scripts for atomic
 * check-and-increment, with in-memory fallback. Tests both paths:
 *   1. Redis-backed: atomic EVAL for daily/monthly keys
 *   2. In-memory fallback: Map-based counters when Redis is unavailable
 *   3. Recovery: auto-switches back to Redis when it comes back
 *
 * Pure dependency-injection tests — no vi.mock.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  HybridBudgetEnforcer,
  clearBudgetCounters,
  dailyKeyDate,
  monthlyKeyDate,
  type BudgetRedisClient,
} from '../services/llm/budget-enforcement.js';

// ─── Fake Redis Client (simulates Lua EVAL atomically) ──────────────────

function createFakeRedis(): BudgetRedisClient & {
  store: Map<string, number>;
  ttls: Map<string, number>;
  evalCalls: number;
} {
  const store = new Map<string, number>();
  const ttls = new Map<string, number>();
  let evalCalls = 0;

  return {
    store,
    ttls,
    get evalCalls() {
      return evalCalls;
    },
    async incrby(key: string, increment: number): Promise<number> {
      const current = store.get(key) ?? 0;
      const next = current + increment;
      store.set(key, next);
      return next;
    },
    async get(key: string): Promise<string | null> {
      const val = store.get(key);
      return val !== undefined ? String(val) : null;
    },
    async expire(key: string, seconds: number): Promise<number> {
      ttls.set(key, seconds);
      return 1;
    },
    async ttl(key: string): Promise<number> {
      return ttls.has(key) ? ttls.get(key)! : -1;
    },
    async eval(script: string, _numkeys: number, ...args: (string | number)[]): Promise<unknown> {
      evalCalls++;
      const key = args[0] as string;

      // Detect which Lua script by checking for the "limit" arg (check-and-increment has 3 args after key)
      if (args.length === 4) {
        // LUA_CHECK_AND_INCREMENT: key, tokens, limit, ttlSeconds
        const tokens = Number(args[1]);
        const limit = Number(args[2]);
        const ttlSeconds = Number(args[3]);

        const current = store.get(key) ?? 0;
        if (current + tokens > limit) {
          return [0, current]; // blocked
        }
        store.set(key, current + tokens);

        // Set TTL if not already set
        if (!ttls.has(key)) {
          ttls.set(key, ttlSeconds);
        }

        return [1, current + tokens]; // allowed
      }

      // LUA_ADJUST_CLAMPED: key, delta
      const delta = Number(args[1]);
      const current = store.get(key) ?? 0;
      const newVal = Math.max(0, current + delta);
      if (newVal !== current) {
        store.set(key, newVal);
      }
      return newVal;
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('LLM Budget Enforcement', () => {
  afterEach(() => {
    clearBudgetCounters();
    vi.restoreAllMocks();
  });

  describe('date key helpers', () => {
    it('formats daily key as YYYYMMDD', () => {
      const date = new Date(Date.UTC(2026, 2, 28, 14, 30, 0)); // March 28, 2026
      expect(dailyKeyDate(date)).toBe('20260328');
    });

    it('formats monthly key as YYYYMM', () => {
      const date = new Date(Date.UTC(2026, 2, 28));
      expect(monthlyKeyDate(date)).toBe('202603');
    });

    it('pads single-digit months and days', () => {
      const date = new Date(Date.UTC(2026, 0, 5)); // Jan 5
      expect(dailyKeyDate(date)).toBe('20260105');
      expect(monthlyKeyDate(date)).toBe('202601');
    });
  });

  describe('Redis-backed path (atomic Lua scripts)', () => {
    let redis: ReturnType<typeof createFakeRedis>;
    let enforcer: HybridBudgetEnforcer;

    beforeEach(() => {
      redis = createFakeRedis();
      enforcer = new HybridBudgetEnforcer(redis);
    });

    afterEach(() => {
      enforcer.shutdown();
    });

    it('allows requests when both budgets are 0 (unlimited)', async () => {
      const result = await enforcer.checkAndRecord('tenant-1', 5000, 0, 0);
      expect(result.allowed).toBe(true);
      expect(result.reservation).toBeUndefined();
      expect(redis.store.size).toBe(0); // No Redis writes for unlimited
    });

    it('allows requests within daily budget', async () => {
      const result = await enforcer.checkAndRecord('tenant-1', 500, 10_000, 0);
      expect(result.allowed).toBe(true);
    });

    it('uses Lua EVAL for atomic check-and-increment', async () => {
      await enforcer.checkAndRecord('tenant-1', 500, 10_000, 0);
      expect(redis.evalCalls).toBeGreaterThanOrEqual(1);
    });

    it('stores daily counter in Redis with date-based key', async () => {
      await enforcer.checkAndRecord('tenant-1', 500, 10_000, 0);
      const dailyKey = `budget:tenant-1:daily:${dailyKeyDate()}`;
      expect(redis.store.get(dailyKey)).toBe(500);
    });

    it('stores monthly counter in Redis with month-based key', async () => {
      await enforcer.checkAndRecord('tenant-1', 500, 0, 100_000);
      const monthlyKey = `budget:tenant-1:monthly:${monthlyKeyDate()}`;
      expect(redis.store.get(monthlyKey)).toBe(500);
    });

    it('sets TTL on daily key via Lua script', async () => {
      await enforcer.checkAndRecord('tenant-1', 500, 10_000, 0);
      const dailyKey = `budget:tenant-1:daily:${dailyKeyDate()}`;
      expect(redis.ttls.has(dailyKey)).toBe(true);
      const ttl = redis.ttls.get(dailyKey)!;
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(86401);
    });

    it('sets TTL on monthly key via Lua script', async () => {
      await enforcer.checkAndRecord('tenant-1', 500, 0, 100_000);
      const monthlyKey = `budget:tenant-1:monthly:${monthlyKeyDate()}`;
      expect(redis.ttls.has(monthlyKey)).toBe(true);
      const ttl = redis.ttls.get(monthlyKey)!;
      expect(ttl).toBeGreaterThan(0);
    });

    it('blocks requests exceeding daily budget', async () => {
      await enforcer.checkAndRecord('tenant-1', 8000, 10_000, 0);
      const result = await enforcer.checkAndRecord('tenant-1', 3000, 10_000, 0);
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('DAILY_BUDGET_EXCEEDED');
      expect(result.currentUsage).toBe(8000);
      expect(result.limit).toBe(10_000);
    });

    it('blocks requests exceeding monthly budget', async () => {
      await enforcer.checkAndRecord('tenant-1', 90_000, 0, 100_000);
      const result = await enforcer.checkAndRecord('tenant-1', 20_000, 0, 100_000);
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('MONTHLY_BUDGET_EXCEEDED');
      expect(result.currentUsage).toBe(90_000);
      expect(result.limit).toBe(100_000);
    });

    it('checks daily before monthly — daily blocks first', async () => {
      await enforcer.checkAndRecord('tenant-1', 9000, 10_000, 100_000);
      const result = await enforcer.checkAndRecord('tenant-1', 2000, 10_000, 100_000);
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('DAILY_BUDGET_EXCEEDED');
    });

    it('rolls back daily increment when monthly exceeds', async () => {
      // Daily: 100k (huge), Monthly: 10k. Use 9k, then request 2k.
      // Daily passes, monthly blocks. Daily should roll back.
      await enforcer.checkAndRecord('tenant-1', 9000, 100_000, 10_000);
      const result = await enforcer.checkAndRecord('tenant-1', 2000, 100_000, 10_000);
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('MONTHLY_BUDGET_EXCEEDED');

      // Daily should have been rolled back to 9000 (not 11000)
      const dailyKey = `budget:tenant-1:daily:${dailyKeyDate()}`;
      expect(redis.store.get(dailyKey)).toBe(9000);
    });

    it('accumulates tokens across calls', async () => {
      await enforcer.checkAndRecord('tenant-1', 5000, 10_000, 0);
      await enforcer.checkAndRecord('tenant-1', 4000, 10_000, 0);
      const blocked = await enforcer.checkAndRecord('tenant-1', 1001, 10_000, 0);
      expect(blocked.allowed).toBe(false);
    });

    it('isolates counters per tenant', async () => {
      await enforcer.checkAndRecord('tenant-1', 9000, 10_000, 0);
      const result = await enforcer.checkAndRecord('tenant-2', 9000, 10_000, 0);
      expect(result.allowed).toBe(true);
    });

    it('allows exactly at budget boundary', async () => {
      await enforcer.checkAndRecord('tenant-1', 5000, 10_000, 0);
      const result = await enforcer.checkAndRecord('tenant-1', 5000, 10_000, 0);
      expect(result.allowed).toBe(true);
    });

    it('reports using Redis', () => {
      expect(enforcer.isUsingRedis()).toBe(true);
    });

    it('records actual usage positive delta via Redis INCRBY', async () => {
      const result = await enforcer.checkAndRecord('tenant-1', 1000, 5000, 50_000);
      await enforcer.recordActualUsage(result.reservation, 500);
      const dailyKey = `budget:tenant-1:daily:${dailyKeyDate()}`;
      expect(redis.store.get(dailyKey)).toBe(1500);
    });

    it('records actual usage negative delta via atomic Lua (clamped to 0)', async () => {
      const result = await enforcer.checkAndRecord('tenant-1', 1000, 5000, 50_000);
      await enforcer.recordActualUsage(result.reservation, -5000);
      const dailyKey = `budget:tenant-1:daily:${dailyKeyDate()}`;
      expect(redis.store.get(dailyKey)).toBe(0);
    });

    it('skips recordActualUsage when delta is 0', async () => {
      const result = await enforcer.checkAndRecord('tenant-1', 1000, 5000, 50_000);
      const evalBefore = redis.evalCalls;
      await enforcer.recordActualUsage(result.reservation, 0);
      expect(redis.evalCalls).toBe(evalBefore); // No Redis calls
    });

    it('does not create counters when no budget reservation exists', async () => {
      await enforcer.recordActualUsage(undefined, 500);
      expect(redis.store.size).toBe(0);
      expect(redis.ttls.size).toBe(0);
    });

    it('reconciles against the original UTC day and month buckets', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date(Date.UTC(2026, 2, 31, 23, 59, 59, 500)));

        const result = await enforcer.checkAndRecord('tenant-1', 1000, 5000, 50_000);
        const originalDailyKey = `budget:tenant-1:daily:${dailyKeyDate(new Date(Date.UTC(2026, 2, 31)))}`;
        const nextDailyKey = `budget:tenant-1:daily:${dailyKeyDate(new Date(Date.UTC(2026, 3, 1)))}`;

        vi.setSystemTime(new Date(Date.UTC(2026, 3, 1, 0, 0, 0, 500)));
        await enforcer.recordActualUsage(result.reservation, 500);

        expect(redis.store.get(originalDailyKey)).toBe(1500);
        expect(redis.store.get(nextDailyKey)).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('in-memory fallback path', () => {
    let enforcer: HybridBudgetEnforcer;

    beforeEach(() => {
      clearBudgetCounters();
      enforcer = new HybridBudgetEnforcer(null);
    });

    afterEach(() => {
      enforcer.shutdown();
    });

    it('allows requests when both budgets are unlimited', async () => {
      const result = await enforcer.checkAndRecord('tenant-1', 5000, 0, 0);
      expect(result.allowed).toBe(true);
    });

    it('allows requests within daily budget', async () => {
      const result = await enforcer.checkAndRecord('tenant-1', 500, 10_000, 0);
      expect(result.allowed).toBe(true);
    });

    it('blocks requests exceeding daily budget', async () => {
      await enforcer.checkAndRecord('tenant-1', 8000, 10_000, 0);
      const result = await enforcer.checkAndRecord('tenant-1', 3000, 10_000, 0);
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('DAILY_BUDGET_EXCEEDED');
    });

    it('blocks requests exceeding monthly budget', async () => {
      await enforcer.checkAndRecord('tenant-1', 90_000, 0, 100_000);
      const result = await enforcer.checkAndRecord('tenant-1', 20_000, 0, 100_000);
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('MONTHLY_BUDGET_EXCEEDED');
    });

    it('isolates counters per tenant', async () => {
      await enforcer.checkAndRecord('tenant-1', 9000, 10_000, 0);
      const result = await enforcer.checkAndRecord('tenant-2', 9000, 10_000, 0);
      expect(result.allowed).toBe(true);
    });

    it('reports not using Redis', () => {
      expect(enforcer.isUsingRedis()).toBe(false);
    });

    it('records actual usage in memory', async () => {
      const initial = await enforcer.checkAndRecord('tenant-1', 3000, 5000, 0);
      await enforcer.recordActualUsage(initial.reservation, -1000);
      const next = await enforcer.checkAndRecord('tenant-1', 3000, 5000, 0);
      expect(next.allowed).toBe(true);
    });

    it('clamps memory counter to zero on large negative delta', async () => {
      const initial = await enforcer.checkAndRecord('tenant-1', 1000, 5000, 0);
      await enforcer.recordActualUsage(initial.reservation, -5000);
      const next = await enforcer.checkAndRecord('tenant-1', 5000, 5000, 0);
      expect(next.allowed).toBe(true);
    });

    it('no-ops recordActualUsage when no reservation exists', async () => {
      await expect(enforcer.recordActualUsage(undefined, 1000)).resolves.not.toThrow();
    });
  });

  describe('Redis failure → in-memory fallback', () => {
    it('falls back to memory when Redis throws', async () => {
      const failingRedis: BudgetRedisClient = {
        async incrby(): Promise<number> {
          throw new Error('Connection refused');
        },
        async get(): Promise<string | null> {
          throw new Error('Connection refused');
        },
        async expire(): Promise<number> {
          throw new Error('Connection refused');
        },
        async ttl(): Promise<number> {
          throw new Error('Connection refused');
        },
        async eval(): Promise<unknown> {
          throw new Error('Connection refused');
        },
      };

      const enforcer = new HybridBudgetEnforcer(failingRedis);

      // First call triggers fallback
      const result = await enforcer.checkAndRecord('tenant-1', 500, 10_000, 0);
      expect(result.allowed).toBe(true);
      expect(enforcer.isUsingRedis()).toBe(false);

      // Subsequent calls use memory
      await enforcer.checkAndRecord('tenant-1', 9000, 10_000, 0);
      const blocked = await enforcer.checkAndRecord('tenant-1', 2000, 10_000, 0);
      expect(blocked.allowed).toBe(false);

      enforcer.shutdown();
    });
  });

  describe('Redis recovery', () => {
    it('switches back to Redis when recovery detects availability', async () => {
      vi.useFakeTimers();

      let redisAvailable = false;
      const redis = createFakeRedis();

      const enforcer = new HybridBudgetEnforcer(null, {
        getRedisClient: () => (redisAvailable ? redis : null),
        isRedisAvailable: () => redisAvailable,
      });

      expect(enforcer.isUsingRedis()).toBe(false);

      // Simulate Redis becoming available
      redisAvailable = true;
      vi.advanceTimersByTime(30_000); // Recovery interval

      expect(enforcer.isUsingRedis()).toBe(true);

      enforcer.shutdown();
      vi.useRealTimers();
    });
  });

  describe('clearBudgetCounters', () => {
    it('clears all memory counters when no tenantId provided', async () => {
      const enforcer = new HybridBudgetEnforcer(null);
      await enforcer.checkAndRecord('tenant-1', 9000, 10_000, 0);
      await enforcer.checkAndRecord('tenant-2', 9000, 10_000, 0);
      clearBudgetCounters();
      expect((await enforcer.checkAndRecord('tenant-1', 9000, 10_000, 0)).allowed).toBe(true);
      expect((await enforcer.checkAndRecord('tenant-2', 9000, 10_000, 0)).allowed).toBe(true);
      enforcer.shutdown();
    });

    it('clears only specified tenant counters', async () => {
      const enforcer = new HybridBudgetEnforcer(null);
      await enforcer.checkAndRecord('tenant-1', 9000, 10_000, 0);
      await enforcer.checkAndRecord('tenant-2', 9000, 10_000, 0);
      clearBudgetCounters('tenant-1');
      expect((await enforcer.checkAndRecord('tenant-1', 9000, 10_000, 0)).allowed).toBe(true);
      expect((await enforcer.checkAndRecord('tenant-2', 2000, 10_000, 0)).allowed).toBe(false);
      enforcer.shutdown();
    });
  });
});
