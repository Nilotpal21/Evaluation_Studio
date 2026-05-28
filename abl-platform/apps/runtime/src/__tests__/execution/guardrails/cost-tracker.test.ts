import { describe, it, expect, beforeEach } from 'vitest';
import {
  GuardrailCostTracker,
  type CostRedisLike,
  type CostBudget,
  usdToMicro,
  microToUsd,
} from '../../../services/guardrails/cost-tracker';

// ---------------------------------------------------------------------------
// MockCostRedis -- in-memory implementation of CostRedisLike for testing
// ---------------------------------------------------------------------------

class MockCostRedis implements CostRedisLike {
  private store = new Map<string, number>();
  expireCalls: Array<{ key: string; seconds: number }> = [];

  async get(key: string): Promise<string | null> {
    const val = this.store.get(key);
    return val !== undefined ? String(val) : null;
  }

  async incrby(key: string, amount: number): Promise<number> {
    const current = this.store.get(key) ?? 0;
    const newVal = current + amount;
    this.store.set(key, newVal);
    return newVal;
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.expireCalls.push({ key, seconds });
    return 1;
  }

  /** Expose raw store value for assertions */
  getRaw(key: string): number | undefined {
    return this.store.get(key);
  }
}

/**
 * MockCostRedis that throws on every operation -- used to test fail-open behavior.
 */
class FailingCostRedis implements CostRedisLike {
  async get(): Promise<string | null> {
    throw new Error('Redis connection lost');
  }
  async incrby(): Promise<number> {
    throw new Error('Redis connection lost');
  }
  async expire(): Promise<number> {
    throw new Error('Redis connection lost');
  }
}

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TENANT_ID = 'tenant-1';
const PROJECT_ID = 'project-1';
const USD_TO_MICRODOLLARS = 1_000_000;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GuardrailCostTracker', () => {
  let redis: MockCostRedis;
  let tracker: GuardrailCostTracker;

  beforeEach(() => {
    redis = new MockCostRedis();
    tracker = new GuardrailCostTracker(redis);
  });

  // -----------------------------------------------------------------------
  // 1. Record cost in microdollars using INCRBY
  // -----------------------------------------------------------------------
  it('should record cost in microdollars using INCRBY', async () => {
    const costUsd = 0.005; // $0.005
    const expectedMicro = Math.round(costUsd * USD_TO_MICRODOLLARS); // 5000

    const newTotal = await tracker.recordCost(TENANT_ID, PROJECT_ID, costUsd);

    expect(newTotal).toBe(expectedMicro);

    // Verify the raw Redis value is an integer
    const key = tracker.buildKey(TENANT_ID, PROJECT_ID);
    const rawValue = redis.getRaw(key);
    expect(rawValue).toBe(expectedMicro);
    expect(Number.isInteger(rawValue)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 2. Accumulate costs across multiple calls
  // -----------------------------------------------------------------------
  it('should accumulate costs across multiple calls', async () => {
    await tracker.recordCost(TENANT_ID, PROJECT_ID, 0.001); // 1000 micro
    await tracker.recordCost(TENANT_ID, PROJECT_ID, 0.002); // 2000 micro
    const total = await tracker.recordCost(TENANT_ID, PROJECT_ID, 0.003); // 3000 micro

    // Total should be 6000 microdollars
    expect(total).toBe(6000);
  });

  // -----------------------------------------------------------------------
  // 3. Return 0 when no Redis client provided
  // -----------------------------------------------------------------------
  it('should return 0 when no Redis client provided', async () => {
    const noRedisTracker = new GuardrailCostTracker(null);

    const result = await noRedisTracker.recordCost(TENANT_ID, PROJECT_ID, 0.01);
    expect(result).toBe(0);

    const spend = await noRedisTracker.getCurrentSpend(TENANT_ID, PROJECT_ID);
    expect(spend).toBe(0);
  });

  // -----------------------------------------------------------------------
  // 4. Skip recording when cost is 0 or negative
  // -----------------------------------------------------------------------
  it('should skip recording when cost is 0 or negative', async () => {
    const zeroResult = await tracker.recordCost(TENANT_ID, PROJECT_ID, 0);
    expect(zeroResult).toBe(0);

    const negativeResult = await tracker.recordCost(TENANT_ID, PROJECT_ID, -0.01);
    expect(negativeResult).toBe(0);

    // Verify nothing was written to Redis
    const key = tracker.buildKey(TENANT_ID, PROJECT_ID);
    const rawValue = redis.getRaw(key);
    expect(rawValue).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // 5. Check budget and report not exceeded
  // -----------------------------------------------------------------------
  it('should check budget and report not exceeded', async () => {
    // Record $5 of spend
    await tracker.recordCost(TENANT_ID, PROJECT_ID, 5.0);

    const budget: CostBudget = {
      monthlyBudgetUsd: 100,
      onExceed: 'downgrade',
    };

    const result = await tracker.checkBudget(TENANT_ID, PROJECT_ID, budget);

    expect(result.exceeded).toBe(false);
    expect(result.action).toBe('none');
    expect(result.currentSpendMicro).toBe(5_000_000);
    expect(result.currentSpendUsd).toBe(5.0);
    expect(result.budgetMicro).toBe(100_000_000);
  });

  // -----------------------------------------------------------------------
  // 6. Check budget and report exceeded with downgrade action
  // -----------------------------------------------------------------------
  it('should check budget and report exceeded with downgrade action', async () => {
    // Record $101 of spend (over $100 budget)
    await tracker.recordCost(TENANT_ID, PROJECT_ID, 101.0);

    const budget: CostBudget = {
      monthlyBudgetUsd: 100,
      onExceed: 'downgrade',
    };

    const result = await tracker.checkBudget(TENANT_ID, PROJECT_ID, budget);

    expect(result.exceeded).toBe(true);
    expect(result.action).toBe('downgrade');
    expect(result.currentSpendUsd).toBe(101.0);
  });

  // -----------------------------------------------------------------------
  // 7. Check budget and report exceeded with allow action
  // -----------------------------------------------------------------------
  it('should check budget and report exceeded with allow action', async () => {
    // Record $150 of spend (over $100 budget)
    await tracker.recordCost(TENANT_ID, PROJECT_ID, 150.0);

    const budget: CostBudget = {
      monthlyBudgetUsd: 100,
      onExceed: 'allow',
    };

    const result = await tracker.checkBudget(TENANT_ID, PROJECT_ID, budget);

    expect(result.exceeded).toBe(true);
    expect(result.action).toBe('allow');
  });

  // -----------------------------------------------------------------------
  // 8. Check budget and report exceeded with disable_model_checks action
  // -----------------------------------------------------------------------
  it('should check budget and report exceeded with disable_model_checks action', async () => {
    await tracker.recordCost(TENANT_ID, PROJECT_ID, 150.0);

    const budget: CostBudget = {
      monthlyBudgetUsd: 100,
      onExceed: 'disable_model_checks',
    };

    const result = await tracker.checkBudget(TENANT_ID, PROJECT_ID, budget);

    expect(result.exceeded).toBe(true);
    expect(result.action).toBe('disable_model_checks');
  });

  // -----------------------------------------------------------------------
  // 9. Return no-action when no budget configured
  // -----------------------------------------------------------------------
  it('should return no-action when no budget configured', async () => {
    const result = await tracker.checkBudget(TENANT_ID, PROJECT_ID, undefined);

    expect(result.exceeded).toBe(false);
    expect(result.action).toBe('none');
    expect(result.currentSpendMicro).toBe(0);
    expect(result.budgetMicro).toBe(0);
  });

  // -----------------------------------------------------------------------
  // 10. Fail-open on Redis error during budget check
  // -----------------------------------------------------------------------
  it('should fail-open on Redis error during budget check', async () => {
    const failingTracker = new GuardrailCostTracker(new FailingCostRedis());

    const budget: CostBudget = {
      monthlyBudgetUsd: 100,
      onExceed: 'downgrade',
    };

    const result = await failingTracker.checkBudget(TENANT_ID, PROJECT_ID, budget);

    // Fail-open: should NOT report exceeded, should allow execution
    expect(result.exceeded).toBe(false);
    expect(result.action).toBe('none');
    expect(result.budgetMicro).toBe(100_000_000);
  });

  // -----------------------------------------------------------------------
  // 11. Fail-open on Redis error during cost recording
  // -----------------------------------------------------------------------
  it('should fail-open on Redis error during cost recording', async () => {
    const failingTracker = new GuardrailCostTracker(new FailingCostRedis());

    // Should not throw, should return 0
    const result = await failingTracker.recordCost(TENANT_ID, PROJECT_ID, 0.01);
    expect(result).toBe(0);
  });

  // -----------------------------------------------------------------------
  // 11. Build key with correct year-month format
  // -----------------------------------------------------------------------
  it('should build key with correct year-month format', () => {
    const key = tracker.buildKey(TENANT_ID, PROJECT_ID);

    // Key format: guardrail:cost:{tenantId}:{projectId}:{YYYY-MM}
    const parts = key.split(':');
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe('guardrail');
    expect(parts[1]).toBe('cost');
    expect(parts[2]).toBe(TENANT_ID);
    expect(parts[3]).toBe(PROJECT_ID);

    // Year-month should match YYYY-MM pattern
    expect(parts[4]).toMatch(/^\d{4}-\d{2}$/);

    // Verify it matches the current date
    const now = new Date();
    const expectedYearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    expect(parts[4]).toBe(expectedYearMonth);
  });

  // -----------------------------------------------------------------------
  // 12. Isolate costs by tenant and project
  // -----------------------------------------------------------------------
  it('should isolate costs by tenant and project', async () => {
    // Record costs for different tenants/projects
    await tracker.recordCost('tenant-A', 'project-1', 1.0);
    await tracker.recordCost('tenant-B', 'project-1', 2.0);
    await tracker.recordCost('tenant-A', 'project-2', 3.0);

    // Each should have independent spend
    const spendA1 = await tracker.getCurrentSpend('tenant-A', 'project-1');
    const spendB1 = await tracker.getCurrentSpend('tenant-B', 'project-1');
    const spendA2 = await tracker.getCurrentSpend('tenant-A', 'project-2');

    expect(spendA1).toBe(1.0);
    expect(spendB1).toBe(2.0);
    expect(spendA2).toBe(3.0);
  });

  // -----------------------------------------------------------------------
  // 13. Convert USD to microdollars correctly
  // -----------------------------------------------------------------------
  it('should convert USD to microdollars correctly', () => {
    expect(usdToMicro(1.0)).toBe(1_000_000);
    expect(usdToMicro(0.001)).toBe(1_000);
    expect(usdToMicro(0.000001)).toBe(1);
    expect(usdToMicro(0)).toBe(0);
    expect(usdToMicro(99.99)).toBe(99_990_000);

    // Inverse
    expect(microToUsd(1_000_000)).toBe(1.0);
    expect(microToUsd(1_000)).toBe(0.001);
    expect(microToUsd(1)).toBe(0.000001);
    expect(microToUsd(0)).toBe(0);
  });

  // -----------------------------------------------------------------------
  // 14. Get current spend for reporting
  // -----------------------------------------------------------------------
  it('should get current spend for reporting', async () => {
    // No spend yet
    const initial = await tracker.getCurrentSpend(TENANT_ID, PROJECT_ID);
    expect(initial).toBe(0);

    // Record some costs
    await tracker.recordCost(TENANT_ID, PROJECT_ID, 0.05);
    await tracker.recordCost(TENANT_ID, PROJECT_ID, 0.1);

    const spend = await tracker.getCurrentSpend(TENANT_ID, PROJECT_ID);
    expect(spend).toBe(0.15);
  });

  // -----------------------------------------------------------------------
  // 15. TTL set on first write only
  // -----------------------------------------------------------------------
  it('should set TTL on first write and not on subsequent writes', async () => {
    await tracker.recordCost(TENANT_ID, PROJECT_ID, 0.01);

    // First write should set expire
    expect(redis.expireCalls).toHaveLength(1);
    expect(redis.expireCalls[0].seconds).toBe(35 * 24 * 60 * 60);

    // Subsequent writes should NOT set expire (newTotal !== microCost)
    await tracker.recordCost(TENANT_ID, PROJECT_ID, 0.02);
    await tracker.recordCost(TENANT_ID, PROJECT_ID, 0.03);

    expect(redis.expireCalls).toHaveLength(1); // Still 1
  });
});
