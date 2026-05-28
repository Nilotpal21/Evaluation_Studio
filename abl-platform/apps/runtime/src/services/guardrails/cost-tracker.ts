/**
 * Redis-backed cost tracker for guardrail evaluations.
 *
 * Uses integer microdollars (1 USD = 1,000,000) with Redis INCRBY
 * for atomic, race-condition-free cost accumulation.
 *
 * Key format: guardrail:cost:{tenantId}:{projectId}:{YYYY-MM}
 * TTL: auto-expires 35 days after creation (covers month + buffer).
 *
 * Fail-open: all Redis errors are caught and logged. A tracking failure
 * never blocks request processing — it returns 0 and continues.
 */

import { createLogger } from '@abl/compiler/platform';

const log = createLogger('guardrail-cost-tracker');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 1 USD = 1,000,000 microdollars */
const USD_TO_MICRODOLLARS = 1_000_000;

/** TTL for monthly cost keys: 35 days in seconds (covers any month + buffer) */
const MONTHLY_KEY_TTL_SECONDS = 35 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CostBudget {
  /** Monthly budget in USD */
  monthlyBudgetUsd: number;
  /** What to do when budget exceeded: 'downgrade' or 'disable_model_checks' skips expensive tiers, 'allow' continues */
  onExceed: 'downgrade' | 'disable_model_checks' | 'allow';
}

export interface CostCheckResult {
  /** Current month spend in microdollars */
  currentSpendMicro: number;
  /** Current month spend in USD */
  currentSpendUsd: number;
  /** Monthly budget in microdollars */
  budgetMicro: number;
  /** Whether budget is exceeded */
  exceeded: boolean;
  /** What action to take */
  action: 'downgrade' | 'disable_model_checks' | 'allow' | 'none';
}

/** Minimal Redis interface for cost tracking */
export interface CostRedisLike {
  get(key: string): Promise<string | null>;
  incrby(key: string, amount: number): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

// ---------------------------------------------------------------------------
// GuardrailCostTracker
// ---------------------------------------------------------------------------

/**
 * Redis-backed cost tracker for guardrail evaluations.
 *
 * Uses integer microdollars (1 USD = 1,000,000) with Redis INCRBY
 * for atomic, race-condition-free cost accumulation.
 *
 * Key format: guardrail:cost:{tenantId}:{projectId}:{YYYY-MM}
 * TTL: auto-expires 35 days after creation (covers month + buffer).
 */
export class GuardrailCostTracker {
  private redis: CostRedisLike | null;

  constructor(redis: CostRedisLike | null) {
    this.redis = redis;
  }

  /**
   * Build the Redis key for the current month's cost counter.
   *
   * Format: guardrail:cost:{tenantId}:{projectId}:{YYYY-MM}
   */
  buildKey(tenantId: string, projectId: string): string {
    const now = new Date();
    const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    return `guardrail:cost:${tenantId}:${projectId}:${yearMonth}`;
  }

  /**
   * Record a cost in microdollars. Uses INCRBY for atomic increment.
   *
   * Returns the new total spend in microdollars, or 0 on failure/skip.
   */
  async recordCost(tenantId: string, projectId: string, costUsd: number): Promise<number> {
    if (!this.redis || costUsd <= 0) return 0;

    const microCost = Math.round(costUsd * USD_TO_MICRODOLLARS);
    if (microCost <= 0) return 0;

    try {
      const key = this.buildKey(tenantId, projectId);
      const newTotal = await this.redis.incrby(key, microCost);

      // Set TTL on first write (35 days covers any month + buffer).
      // We check if total equals the amount we just added — means it's a new key.
      if (newTotal === microCost) {
        await this.redis.expire(key, MONTHLY_KEY_TTL_SECONDS);
      }

      return newTotal;
    } catch (err) {
      log.warn('Failed to record guardrail cost', {
        tenantId,
        projectId,
        costUsd,
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  }

  /**
   * Check current spend against budget. Returns whether Tier 2/3 should be skipped.
   *
   * Fail-open: if Redis is unavailable, returns `exceeded: false` and `action: 'none'`
   * so guardrail evaluation proceeds normally.
   */
  async checkBudget(
    tenantId: string,
    projectId: string,
    budget?: CostBudget,
  ): Promise<CostCheckResult> {
    if (!budget || !this.redis) {
      return {
        currentSpendMicro: 0,
        currentSpendUsd: 0,
        budgetMicro: 0,
        exceeded: false,
        action: 'none',
      };
    }

    const budgetMicro = Math.round(budget.monthlyBudgetUsd * USD_TO_MICRODOLLARS);

    try {
      const key = this.buildKey(tenantId, projectId);
      const currentStr = await this.redis.get(key);
      const currentSpendMicro = currentStr ? parseInt(currentStr, 10) : 0;
      const exceeded = currentSpendMicro >= budgetMicro;

      return {
        currentSpendMicro,
        currentSpendUsd: currentSpendMicro / USD_TO_MICRODOLLARS,
        budgetMicro,
        exceeded,
        action: exceeded ? budget.onExceed : 'none',
      };
    } catch (err) {
      log.warn('Failed to check guardrail budget', {
        tenantId,
        projectId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Fail-open: if we can't check budget, allow execution
      return {
        currentSpendMicro: 0,
        currentSpendUsd: 0,
        budgetMicro,
        exceeded: false,
        action: 'none',
      };
    }
  }

  /**
   * Get current month spend in USD for reporting.
   *
   * Returns 0 if Redis is unavailable or no spend recorded.
   */
  async getCurrentSpend(tenantId: string, projectId: string): Promise<number> {
    if (!this.redis) return 0;

    try {
      const key = this.buildKey(tenantId, projectId);
      const val = await this.redis.get(key);
      return val ? parseInt(val, 10) / USD_TO_MICRODOLLARS : 0;
    } catch {
      return 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/** Convert USD to microdollars (integer) */
export function usdToMicro(usd: number): number {
  return Math.round(usd * USD_TO_MICRODOLLARS);
}

/** Convert microdollars to USD */
export function microToUsd(micro: number): number {
  return micro / USD_TO_MICRODOLLARS;
}
