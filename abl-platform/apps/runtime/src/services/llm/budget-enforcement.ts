/**
 * LLM Budget Enforcement
 *
 * Checks whether a tenant has exceeded their daily or monthly token budget
 * as defined in tenant_llm_policies. Uses Redis INCRBY counters for accurate
 * cross-pod budget tracking, with in-memory fallback when Redis is unavailable.
 *
 * Key layout:
 *   `budget:{tenantId}:daily:{YYYYMMDD}`   — resets daily via EXPIRE
 *   `budget:{tenantId}:monthly:{YYYYMM}`   — resets monthly via EXPIRE
 *
 * Follows the HybridRateLimiter pattern: Redis primary, in-memory fallback,
 * automatic recovery when Redis comes back.
 *
 * Atomic check-and-increment uses Lua scripts (same pattern as RedisRateLimiter)
 * to prevent TOCTOU races under concurrent load.
 *
 * When the feature flag is off or all backends unavailable, enforcement is
 * fail-open (allows the request).
 */

import { createLogger } from '@agent-platform/shared-observability';
import type { RedisClient } from '@agent-platform/redis';
import { runLuaScript, type LuaScript } from '@agent-platform/redis';

const log = createLogger('llm-budget-enforcement');

// ─── Types ──────────────────────────────────────────────────────────────

export interface BudgetCheckResult {
  allowed: boolean;
  reason?: string;
  code?: 'DAILY_BUDGET_EXCEEDED' | 'MONTHLY_BUDGET_EXCEEDED';
  currentUsage?: number;
  limit?: number;
  reservation?: BudgetReservation;
}

export interface BudgetPeriodReservation {
  key: string;
  periodKey: string;
  expiresAtMs: number;
}

export interface BudgetReservation {
  tenantId: string;
  estimatedTokens: number;
  backend: 'redis' | 'memory';
  daily?: BudgetPeriodReservation;
  monthly?: BudgetPeriodReservation;
}

/** Dependency-injected Redis client interface (subset of ioredis). */
export interface BudgetRedisClient {
  incrby(key: string, increment: number): Promise<number>;
  get(key: string): Promise<string | null>;
  expire(key: string, seconds: number): Promise<number>;
  ttl(key: string): Promise<number>;
  eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>;
}

// ─── Constants ──────────────────────────────────────────────────────────

const MAX_MEMORY_ENTRIES = 10_000;
const REDIS_RECOVERY_INTERVAL_MS = 30_000;

/**
 * Default token estimate per LLM call for budget pre-checks.
 * Used in ModelResolutionService.enforceBudget() to pre-debit before
 * the actual call. SessionLLMClient calls `recordActualUsage()` after
 * each generateText/streamText to correct the estimate with real token counts.
 */
export const ESTIMATED_TOKENS_PER_CALL = 1000;

// ─── Lua Scripts ────────────────────────────────────────────────────────

/**
 * Atomic check-and-increment for a single budget counter.
 * KEYS[1] = budget key
 * ARGV[1] = tokens to add
 * ARGV[2] = budget limit
 * ARGV[3] = TTL in seconds (set only if key has no expiry)
 *
 * Returns: [allowed (0/1), currentUsage (before increment)]
 */
const LUA_CHECK_AND_INCREMENT: LuaScript = {
  name: 'budget-check-and-increment',
  body: `
local key = KEYS[1]
local tokens = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local ttlSeconds = tonumber(ARGV[3])

local current = tonumber(redis.call('GET', key) or '0')

if current + tokens > limit then
  return {0, current}
end

redis.call('INCRBY', key, tokens)

-- Set TTL if key has no expiry (-1 = no TTL, -2 = key doesn't exist before INCRBY created it)
local currentTtl = redis.call('TTL', key)
if currentTtl < 0 then
  redis.call('EXPIRE', key, ttlSeconds)
end

return {1, current + tokens}
`,
  numberOfKeys: 1,
};

/**
 * Atomic adjust-with-floor for recordActualUsage negative deltas.
 * KEYS[1] = budget key
 * ARGV[1] = delta (can be negative)
 *
 * Clamps result to 0. Returns new value.
 */
const LUA_ADJUST_CLAMPED: LuaScript = {
  name: 'budget-adjust-clamped',
  body: `
local key = KEYS[1]
local delta = tonumber(ARGV[1])

local current = tonumber(redis.call('GET', key) or '0')
local newVal = current + delta
if newVal < 0 then newVal = 0 end

if newVal ~= current then
  -- Use absolute set via INCRBY of the difference
  redis.call('INCRBY', key, newVal - current)
end

return newVal
`,
  numberOfKeys: 1,
};

// ─── Date Key Helpers ───────────────────────────────────────────────────

/** Format: YYYYMMDD — used as daily Redis key suffix. */
export function dailyKeyDate(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/** Format: YYYYMM — used as monthly Redis key suffix. */
export function monthlyKeyDate(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}${m}`;
}

function dailyRedisKey(tenantId: string, now: Date = new Date()): string {
  return `budget:${tenantId}:daily:${dailyKeyDate(now)}`;
}

function monthlyRedisKey(tenantId: string, now: Date = new Date()): string {
  return `budget:${tenantId}:monthly:${monthlyKeyDate(now)}`;
}

/** Seconds remaining until the end of the current UTC day. */
function secondsUntilEndOfDay(now: Date = new Date()): number {
  const endOfDay = new Date(now);
  endOfDay.setUTCHours(23, 59, 59, 999);
  return Math.ceil((endOfDay.getTime() - now.getTime()) / 1000) + 1;
}

/** Seconds remaining until the end of the current UTC month. */
function secondsUntilEndOfMonth(now: Date = new Date()): number {
  const endOfMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999),
  );
  return Math.ceil((endOfMonth.getTime() - now.getTime()) / 1000) + 1;
}

// ─── In-Memory Fallback ─────────────────────────────────────────────────

interface MemoryBudgetEntry {
  count: number;
}

const memoryDaily = new Map<string, MemoryBudgetEntry>();
const memoryMonthly = new Map<string, MemoryBudgetEntry>();

function memoryStoreKey(tenantId: string, periodKey: string): string {
  return `${tenantId}:${periodKey}`;
}

function getMemoryCounter(
  store: Map<string, MemoryBudgetEntry>,
  tenantId: string,
  periodKey: string,
): MemoryBudgetEntry {
  const storeKey = memoryStoreKey(tenantId, periodKey);
  const existing = store.get(storeKey);
  if (existing) {
    return existing;
  }
  if (store.size >= MAX_MEMORY_ENTRIES) {
    const firstKey = store.keys().next().value;
    if (firstKey) store.delete(firstKey);
  }
  const entry: MemoryBudgetEntry = { count: 0 };
  store.set(storeKey, entry);
  return entry;
}

function getExistingMemoryCounter(
  store: Map<string, MemoryBudgetEntry>,
  tenantId: string,
  periodKey: string,
): MemoryBudgetEntry | undefined {
  return store.get(memoryStoreKey(tenantId, periodKey));
}

function adjustMemoryCounter(
  store: Map<string, MemoryBudgetEntry>,
  tenantId: string,
  periodKey: string,
  deltaTokens: number,
): void {
  const entry = getExistingMemoryCounter(store, tenantId, periodKey);
  if (!entry) return;
  entry.count = Math.max(0, entry.count + deltaTokens);
}

function buildBudgetReservation(
  tenantId: string,
  estimatedTokens: number,
  backend: 'redis' | 'memory',
  now: Date,
  dailyBudget: number,
  monthlyBudget: number,
): BudgetReservation | undefined {
  const reservation: BudgetReservation = {
    tenantId,
    estimatedTokens,
    backend,
  };

  if (dailyBudget > 0) {
    reservation.daily = {
      key: dailyRedisKey(tenantId, now),
      periodKey: dailyKeyDate(now),
      expiresAtMs: now.getTime() + secondsUntilEndOfDay(now) * 1000,
    };
  }

  if (monthlyBudget > 0) {
    reservation.monthly = {
      key: monthlyRedisKey(tenantId, now),
      periodKey: monthlyKeyDate(now),
      expiresAtMs: now.getTime() + secondsUntilEndOfMonth(now) * 1000,
    };
  }

  return reservation.daily || reservation.monthly ? reservation : undefined;
}

function secondsUntilReservationExpiry(expiresAtMs: number): number {
  return Math.max(0, Math.ceil((expiresAtMs - Date.now()) / 1000));
}

// ─── Hybrid Budget Enforcer ─────────────────────────────────────────────

export class HybridBudgetEnforcer {
  private redis: BudgetRedisClient | null;
  private usingRedis: boolean;
  private recoveryTimer: ReturnType<typeof setInterval> | null = null;
  private getRedisClientFn: (() => BudgetRedisClient | null) | null;
  private isRedisAvailableFn: (() => boolean) | null;

  constructor(
    redis: BudgetRedisClient | null,
    options?: {
      getRedisClient?: () => BudgetRedisClient | null;
      isRedisAvailable?: () => boolean;
    },
  ) {
    this.redis = redis;
    this.usingRedis = redis !== null;
    this.getRedisClientFn = options?.getRedisClient ?? null;
    this.isRedisAvailableFn = options?.isRedisAvailable ?? null;

    if (!this.usingRedis && this.getRedisClientFn) {
      this.startRecoveryTimer();
    }
  }

  /**
   * Check and record token usage against daily/monthly budgets.
   * Redis-primary with in-memory fallback.
   */
  async checkAndRecord(
    tenantId: string,
    estimatedTokens: number,
    dailyBudget: number,
    monthlyBudget: number,
  ): Promise<BudgetCheckResult> {
    if (dailyBudget <= 0 && monthlyBudget <= 0) {
      return { allowed: true };
    }

    if (this.usingRedis && this.redis) {
      try {
        return await this.checkAndRecordRedis(
          tenantId,
          estimatedTokens,
          dailyBudget,
          monthlyBudget,
        );
      } catch (err) {
        log.warn('Redis budget check failed, falling back to in-memory', {
          error: err instanceof Error ? err.message : String(err),
        });
        this.usingRedis = false;
        this.startRecoveryTimer();
      }
    }

    return this.checkAndRecordMemory(tenantId, estimatedTokens, dailyBudget, monthlyBudget);
  }

  /**
   * Record actual token usage delta after an LLM call completes.
   * Corrects the pre-debit estimate with real token counts using the same
   * counters that were reserved during checkAndRecord().
   */
  async recordActualUsage(
    reservation: BudgetReservation | null | undefined,
    deltaTokens: number,
  ): Promise<void> {
    if (!reservation || deltaTokens === 0) return;

    if (reservation.backend === 'redis' && this.redis) {
      try {
        await this.recordActualUsageRedis(reservation, deltaTokens);
        return;
      } catch (err) {
        log.warn('Redis recordActualUsage failed for reserved counters', {
          error: err instanceof Error ? err.message : String(err),
          tenantId: reservation.tenantId,
        });
        return;
      }
    }

    if (reservation.backend !== 'memory') return;

    if (reservation.daily) {
      adjustMemoryCounter(
        memoryDaily,
        reservation.tenantId,
        reservation.daily.periodKey,
        deltaTokens,
      );
    }
    if (reservation.monthly) {
      adjustMemoryCounter(
        memoryMonthly,
        reservation.tenantId,
        reservation.monthly.periodKey,
        deltaTokens,
      );
    }
  }

  /** Check if currently using Redis or in-memory. */
  isUsingRedis(): boolean {
    return this.usingRedis;
  }

  /** Shutdown: stop recovery timer. */
  shutdown(): void {
    this.stopRecoveryTimer();
  }

  // ─── Redis Path ─────────────────────────────────────────────────────

  private async checkAndRecordRedis(
    tenantId: string,
    estimatedTokens: number,
    dailyBudget: number,
    monthlyBudget: number,
  ): Promise<BudgetCheckResult> {
    // Cast to RedisClient for runLuaScript — BudgetRedisClient is a structural
    // subset that ioredis Redis|Cluster satisfies at runtime.
    const redis = this.redis! as unknown as RedisClient;
    const now = new Date();
    const reservation = buildBudgetReservation(
      tenantId,
      estimatedTokens,
      'redis',
      now,
      dailyBudget,
      monthlyBudget,
    );

    // Atomic check-and-increment for daily budget
    if (dailyBudget > 0) {
      const dKey = dailyRedisKey(tenantId, now);
      const ttlSeconds = secondsUntilEndOfDay(now);
      const result = await runLuaScript<number[]>(
        redis,
        LUA_CHECK_AND_INCREMENT,
        [dKey],
        [estimatedTokens, dailyBudget, ttlSeconds],
      );

      const allowed = result[0] === 1;
      const currentUsage = result[1];

      if (!allowed) {
        log.warn('Daily token budget exceeded', {
          tenantId,
          currentUsage,
          requested: estimatedTokens,
          limit: dailyBudget,
        });
        return {
          allowed: false,
          reason: `Daily token budget exceeded (${currentUsage}/${dailyBudget} tokens used)`,
          code: 'DAILY_BUDGET_EXCEEDED',
          currentUsage,
          limit: dailyBudget,
        };
      }
    }

    // Atomic check-and-increment for monthly budget
    if (monthlyBudget > 0) {
      const mKey = monthlyRedisKey(tenantId, now);
      const ttlSeconds = secondsUntilEndOfMonth(now);
      const result = await runLuaScript<number[]>(
        redis,
        LUA_CHECK_AND_INCREMENT,
        [mKey],
        [estimatedTokens, monthlyBudget, ttlSeconds],
      );

      const allowed = result[0] === 1;
      const currentUsage = result[1];

      if (!allowed) {
        // Rollback daily increment since we already committed it
        if (dailyBudget > 0) {
          const dKey = dailyRedisKey(tenantId, now);
          await runLuaScript(redis, LUA_ADJUST_CLAMPED, [dKey], [-estimatedTokens]);
        }

        log.warn('Monthly token budget exceeded', {
          tenantId,
          currentUsage,
          requested: estimatedTokens,
          limit: monthlyBudget,
        });
        return {
          allowed: false,
          reason: `Monthly token budget exceeded (${currentUsage}/${monthlyBudget} tokens used)`,
          code: 'MONTHLY_BUDGET_EXCEEDED',
          currentUsage,
          limit: monthlyBudget,
        };
      }
    }

    return { allowed: true, reservation };
  }

  // ─── In-Memory Fallback Path ────────────────────────────────────────

  private checkAndRecordMemory(
    tenantId: string,
    estimatedTokens: number,
    dailyBudget: number,
    monthlyBudget: number,
  ): BudgetCheckResult {
    const now = new Date();
    const reservation = buildBudgetReservation(
      tenantId,
      estimatedTokens,
      'memory',
      now,
      dailyBudget,
      monthlyBudget,
    );

    if (dailyBudget > 0) {
      const entry = getMemoryCounter(memoryDaily, tenantId, dailyKeyDate(now));
      if (entry.count + estimatedTokens > dailyBudget) {
        return {
          allowed: false,
          reason: `Daily token budget exceeded (${entry.count}/${dailyBudget} tokens used)`,
          code: 'DAILY_BUDGET_EXCEEDED',
          currentUsage: entry.count,
          limit: dailyBudget,
        };
      }
    }

    if (monthlyBudget > 0) {
      const entry = getMemoryCounter(memoryMonthly, tenantId, monthlyKeyDate(now));
      if (entry.count + estimatedTokens > monthlyBudget) {
        return {
          allowed: false,
          reason: `Monthly token budget exceeded (${entry.count}/${monthlyBudget} tokens used)`,
          code: 'MONTHLY_BUDGET_EXCEEDED',
          currentUsage: entry.count,
          limit: monthlyBudget,
        };
      }
    }

    // Within budget — record
    if (dailyBudget > 0) {
      const entry = getMemoryCounter(memoryDaily, tenantId, dailyKeyDate(now));
      entry.count += estimatedTokens;
    }
    if (monthlyBudget > 0) {
      const entry = getMemoryCounter(memoryMonthly, tenantId, monthlyKeyDate(now));
      entry.count += estimatedTokens;
    }

    return { allowed: true, reservation };
  }

  private async recordActualUsageRedis(
    reservation: BudgetReservation,
    deltaTokens: number,
  ): Promise<void> {
    // Cast to RedisClient for runLuaScript — BudgetRedisClient is a structural
    // subset that ioredis Redis|Cluster satisfies at runtime.
    const redis = this.redis! as unknown as RedisClient;

    if (reservation.daily) {
      await this.adjustRedisPeriod(redis, reservation.daily, deltaTokens);
    }

    if (reservation.monthly) {
      await this.adjustRedisPeriod(redis, reservation.monthly, deltaTokens);
    }
  }

  private async adjustRedisPeriod(
    redis: BudgetRedisClient,
    reservation: BudgetPeriodReservation,
    deltaTokens: number,
  ): Promise<void> {
    if (deltaTokens > 0) {
      const ttlSeconds = secondsUntilReservationExpiry(reservation.expiresAtMs);
      if (ttlSeconds <= 0) {
        log.debug('Skipping positive budget reconciliation for expired period', {
          key: reservation.key,
        });
        return;
      }

      await redis.incrby(reservation.key, deltaTokens);
      const currentTtl = await redis.ttl(reservation.key);
      if (currentTtl < 0) {
        await redis.expire(reservation.key, ttlSeconds);
      }
      return;
    }

    await runLuaScript(
      redis as unknown as RedisClient,
      LUA_ADJUST_CLAMPED,
      [reservation.key],
      [deltaTokens],
    );
  }

  // ─── Recovery ───────────────────────────────────────────────────────

  private startRecoveryTimer(): void {
    if (this.recoveryTimer) return;

    this.recoveryTimer = setInterval(() => {
      if (this.isRedisAvailableFn && this.getRedisClientFn) {
        if (this.isRedisAvailableFn()) {
          const client = this.getRedisClientFn();
          if (client) {
            log.info('Redis recovered — switching budget enforcement to Redis');
            this.redis = client;
            this.usingRedis = true;
            this.stopRecoveryTimer();
          }
        }
      }
    }, REDIS_RECOVERY_INTERVAL_MS);

    if (this.recoveryTimer.unref) {
      this.recoveryTimer.unref();
    }
  }

  private stopRecoveryTimer(): void {
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────

let instance: HybridBudgetEnforcer | null = null;

/**
 * Get or create the singleton budget enforcer.
 * Uses runtime Redis client with auto-recovery.
 */
export function getBudgetEnforcer(): HybridBudgetEnforcer {
  if (instance) return instance;

  // Lazy import to avoid circular deps at module load time
  let redis: BudgetRedisClient | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getRedisClient, isRedisAvailable } = require('../../services/redis/redis-client.js');
    const client = getRedisClient();
    if (client && isRedisAvailable()) {
      redis = client as BudgetRedisClient;
    }
    instance = new HybridBudgetEnforcer(redis, {
      getRedisClient: () => {
        const c = getRedisClient();
        return c && isRedisAvailable() ? (c as BudgetRedisClient) : null;
      },
      isRedisAvailable,
    });
  } catch {
    // Redis client not available — pure in-memory
    instance = new HybridBudgetEnforcer(null);
  }

  return instance;
}

/** Reset singleton (for testing). */
export function resetBudgetEnforcer(): void {
  if (instance) {
    instance.shutdown();
    instance = null;
  }
}

// ─── Backward-Compatible API ────────────────────────────────────────────

/**
 * Check whether a tenant's LLM call is within budget, and record the tokens.
 * Delegates to the singleton HybridBudgetEnforcer.
 *
 * NOTE: This is now async (returns Promise<BudgetCheckResult>) because Redis
 * operations are async. The caller (enforceBudget in model-resolution.ts)
 * must await this.
 */
export async function checkAndRecordBudget(
  tenantId: string,
  estimatedTokens: number,
  dailyBudget: number,
  monthlyBudget: number,
): Promise<BudgetCheckResult> {
  const enforcer = getBudgetEnforcer();
  return enforcer.checkAndRecord(tenantId, estimatedTokens, dailyBudget, monthlyBudget);
}

/**
 * Record actual token usage after an LLM call completes.
 */
export async function recordActualUsage(
  reservation: BudgetReservation | null | undefined,
  deltaTokens: number,
): Promise<void> {
  const enforcer = getBudgetEnforcer();
  return enforcer.recordActualUsage(reservation, deltaTokens);
}

/** Clear budget counters (for testing). */
export function clearBudgetCounters(tenantId?: string): void {
  if (!tenantId) {
    memoryDaily.clear();
    memoryMonthly.clear();
    return;
  }
  for (const key of Array.from(memoryDaily.keys())) {
    if (key.startsWith(`${tenantId}:`)) {
      memoryDaily.delete(key);
    }
  }
  for (const key of Array.from(memoryMonthly.keys())) {
    if (key.startsWith(`${tenantId}:`)) {
      memoryMonthly.delete(key);
    }
  }
}
