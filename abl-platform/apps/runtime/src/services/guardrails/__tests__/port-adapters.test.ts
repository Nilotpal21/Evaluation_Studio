import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CacheAdapter, CostCheckerAdapter, WebhookAdapter } from '../port-adapters.js';

describe('CacheAdapter', () => {
  const mockCache = {
    get: vi.fn(),
    set: vi.fn(),
    buildKey: vi.fn(),
    invalidate: vi.fn(),
    invalidateByTenant: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates get() with bound tenantId and projectId', async () => {
    mockCache.get.mockResolvedValue({ passed: true, cachedAt: Date.now() });
    const adapter = new CacheAdapter(mockCache as any, 'tenant-1', 'project-1');

    const result = await adapter.get('pii-check', 'hello world', 'local');

    expect(mockCache.get).toHaveBeenCalledWith(
      'tenant-1',
      'project-1',
      'pii-check',
      'hello world',
      {
        tier: 'local',
        scopeKey: 'global',
      },
    );
    expect(result).toEqual({ passed: true, cachedAt: expect.any(Number) });
  });

  it('returns null on cache miss', async () => {
    mockCache.get.mockResolvedValue(null);
    const adapter = new CacheAdapter(mockCache as any, 'tenant-1', 'project-1');

    const result = await adapter.get('pii-check', 'test', 'model');

    expect(result).toBeNull();
  });

  it('delegates set() with bound tenantId, projectId, and tier', async () => {
    mockCache.set.mockResolvedValue(undefined);
    const adapter = new CacheAdapter(mockCache as any, 'tenant-1', 'project-1');
    const evalResult = { passed: true, cachedAt: Date.now() };

    await adapter.set('pii-check', 'hello world', 'local', evalResult);

    expect(mockCache.set).toHaveBeenCalledWith(
      'tenant-1',
      'project-1',
      'pii-check',
      'hello world',
      'local',
      evalResult,
      undefined,
      { tier: 'local', scopeKey: 'global' },
    );
  });

  it('delegates get() and set() with an explicit cache scope key', async () => {
    mockCache.get.mockResolvedValue({ passed: false, outcome: 'violation', cachedAt: Date.now() });
    mockCache.set.mockResolvedValue(undefined);
    const adapter = new CacheAdapter(mockCache as any, 'tenant-1', 'project-1', {
      scopeKey: 'agent-a-rev-1',
      defaultTtlSeconds: 123,
    });

    await adapter.get('pii-check', 'hello world', 'model');
    await adapter.set('pii-check', 'hello world', 'model', {
      passed: true,
      outcome: 'pass',
      cachedAt: Date.now(),
    });

    expect(mockCache.get).toHaveBeenCalledWith(
      'tenant-1',
      'project-1',
      'pii-check',
      'hello world',
      {
        tier: 'model',
        scopeKey: 'agent-a-rev-1',
      },
    );
    expect(mockCache.set).toHaveBeenCalledWith(
      'tenant-1',
      'project-1',
      'pii-check',
      'hello world',
      'model',
      expect.objectContaining({ outcome: 'pass' }),
      123,
      { tier: 'model', scopeKey: 'agent-a-rev-1' },
    );
  });

  it('uses different tenantId/projectId per adapter instance', async () => {
    mockCache.get.mockResolvedValue(null);
    const adapter1 = new CacheAdapter(mockCache as any, 'tenant-a', 'project-a');
    const adapter2 = new CacheAdapter(mockCache as any, 'tenant-b', 'project-b');

    await adapter1.get('guard', 'content', 'local');
    await adapter2.get('guard', 'content', 'local');

    expect(mockCache.get).toHaveBeenCalledWith('tenant-a', 'project-a', 'guard', 'content', {
      tier: 'local',
      scopeKey: 'global',
    });
    expect(mockCache.get).toHaveBeenCalledWith('tenant-b', 'project-b', 'guard', 'content', {
      tier: 'local',
      scopeKey: 'global',
    });
  });
});

describe('CostCheckerAdapter', () => {
  const mockTracker = {
    checkBudget: vi.fn(),
    recordCost: vi.fn(),
    buildKey: vi.fn(),
    getCurrentSpend: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates checkBudget() with bound tenantId, projectId, and budget', async () => {
    mockTracker.checkBudget.mockResolvedValue({
      currentSpendMicro: 500000,
      currentSpendUsd: 0.5,
      budgetMicro: 1000000,
      exceeded: false,
      action: 'none',
    });

    const budget = { monthlyBudgetUsd: 1.0, onExceed: 'downgrade' as const };
    const adapter = new CostCheckerAdapter(mockTracker as any, 'tenant-1', 'project-1', budget);

    const result = await adapter.checkBudget();

    expect(mockTracker.checkBudget).toHaveBeenCalledWith('tenant-1', 'project-1', budget);
    expect(result).toEqual({ exceeded: false, action: 'none' });
  });

  it('maps allow action to alert_only', async () => {
    mockTracker.checkBudget.mockResolvedValue({
      currentSpendMicro: 2000000,
      currentSpendUsd: 2.0,
      budgetMicro: 1000000,
      exceeded: true,
      action: 'allow',
    });

    const budget = { monthlyBudgetUsd: 1.0, onExceed: 'allow' as const };
    const adapter = new CostCheckerAdapter(mockTracker as any, 'tenant-1', 'project-1', budget);

    const result = await adapter.checkBudget();

    expect(result).toEqual({ exceeded: true, action: 'alert_only' });
  });

  it('passes through downgrade action unchanged', async () => {
    mockTracker.checkBudget.mockResolvedValue({
      currentSpendMicro: 2000000,
      currentSpendUsd: 2.0,
      budgetMicro: 1000000,
      exceeded: true,
      action: 'downgrade',
    });

    const budget = { monthlyBudgetUsd: 1.0, onExceed: 'downgrade' as const };
    const adapter = new CostCheckerAdapter(mockTracker as any, 'tenant-1', 'project-1', budget);

    const result = await adapter.checkBudget();

    expect(result).toEqual({ exceeded: true, action: 'downgrade' });
  });

  it('passes through disable_model_checks action unchanged', async () => {
    mockTracker.checkBudget.mockResolvedValue({
      currentSpendMicro: 2000000,
      currentSpendUsd: 2.0,
      budgetMicro: 1000000,
      exceeded: true,
      action: 'disable_model_checks',
    });

    const budget = { monthlyBudgetUsd: 1.0, onExceed: 'disable_model_checks' as const };
    const adapter = new CostCheckerAdapter(mockTracker as any, 'tenant-1', 'project-1', budget);

    const result = await adapter.checkBudget();

    expect(result).toEqual({ exceeded: true, action: 'disable_model_checks' });
  });

  it('delegates recordCost() with bound tenantId and projectId', async () => {
    mockTracker.recordCost.mockResolvedValue(500000);
    const adapter = new CostCheckerAdapter(mockTracker as any, 'tenant-1', 'project-1');

    await adapter.recordCost(0.5);

    expect(mockTracker.recordCost).toHaveBeenCalledWith('tenant-1', 'project-1', 0.5);
  });

  it('works without a budget (undefined)', async () => {
    mockTracker.checkBudget.mockResolvedValue({
      currentSpendMicro: 0,
      currentSpendUsd: 0,
      budgetMicro: 0,
      exceeded: false,
      action: 'none',
    });

    const adapter = new CostCheckerAdapter(mockTracker as any, 'tenant-1', 'project-1');

    const result = await adapter.checkBudget();

    expect(mockTracker.checkBudget).toHaveBeenCalledWith('tenant-1', 'project-1', undefined);
    expect(result).toEqual({ exceeded: false, action: 'none' });
  });
});

describe('WebhookAdapter', () => {
  const mockDelivery = {
    deliver: vi.fn(),
    sign: vi.fn(),
    shouldDeliver: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates deliver() to the underlying delivery service', async () => {
    mockDelivery.deliver.mockResolvedValue({ success: true, attempts: 1 });
    const adapter = new WebhookAdapter(mockDelivery as any);

    const event = {
      type: 'guardrail.warn',
      timestamp: Date.now(),
      data: { warnings: [{ name: 'pii-check' }] },
    };

    await adapter.deliver(event);

    expect(mockDelivery.deliver).toHaveBeenCalledWith(event);
  });

  it('swallows errors from delivery (logs but does not throw)', async () => {
    mockDelivery.deliver.mockRejectedValue(new Error('webhook timeout'));
    const adapter = new WebhookAdapter(mockDelivery as any);

    const event = {
      type: 'guardrail.warn',
      timestamp: Date.now(),
      data: { warnings: [] },
    };

    // Should not throw
    await expect(adapter.deliver(event)).resolves.toBeUndefined();
  });

  it('ignores WebhookDeliveryResult return value (returns void)', async () => {
    mockDelivery.deliver.mockResolvedValue({
      success: true,
      statusCode: 200,
      attempts: 1,
    });
    const adapter = new WebhookAdapter(mockDelivery as any);

    const result = await adapter.deliver({
      type: 'guardrail.violation',
      timestamp: Date.now(),
      data: {},
    });

    expect(result).toBeUndefined();
  });
});
