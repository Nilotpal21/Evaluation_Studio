import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { PipelineStepContext, StepOutput } from '../pipeline/types.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockQuery = vi.fn();
vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: () => ({ query: mockQuery }),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockFind = vi.fn();
const mockUpdateOne = vi.fn();
vi.mock('../schemas/alert-rule.schema.js', () => ({
  AlertRuleModel: {
    find: (...args: any[]) => mockFind(...args),
    updateOne: (...args: any[]) => mockUpdateOne(...args),
  },
}));

const { alertEvaluatorService, evaluateCondition } =
  await import('../pipeline/services/alert-evaluator.service.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ctx(): any {
  return {
    run: async (_label: string, fn: () => any) => fn(),
  };
}

function getExecute(
  svc: any,
): (
  ctx: any,
  input: { stepContext: PipelineStepContext; config: { tenantId: string; projectId: string } },
) => Promise<StepOutput> {
  return (svc as any).service.execute;
}

const execute = getExecute(alertEvaluatorService);

function makeInput(overrides: Partial<{ tenantId: string; projectId: string }> = {}): {
  stepContext: PipelineStepContext;
  config: { tenantId: string; projectId: string };
} {
  const tenantId = overrides.tenantId ?? 'acme-corp';
  const projectId = overrides.projectId ?? 'support-bot';
  return {
    stepContext: {
      tenantId,
      projectId,
      config: {},
      previousSteps: {},
      pipelineInput: {},
    },
    config: { tenantId, projectId },
  };
}

function makeRule(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    _id: 'rule-001',
    tenantId: 'acme-corp',
    projectId: 'support-bot',
    name: 'High Avg Sentiment',
    enabled: true,
    metric: 'avg_sentiment',
    sourceTable: 'abl_platform.conversation_sentiment',
    aggregation: 'avg',
    windowMinutes: 60,
    condition: 'gt',
    threshold: 0.8,
    cooldownMinutes: 30,
    channels: [{ type: 'slack', config: { webhook: 'https://hooks.slack.com/test' } }],
    lastEvaluatedAt: undefined,
    lastFiredAt: undefined,
    status: 'ok',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

describe('evaluateCondition', () => {
  test('gt returns true when value > threshold', () => {
    expect(evaluateCondition(10, 'gt', 5)).toBe(true);
    expect(evaluateCondition(5, 'gt', 5)).toBe(false);
    expect(evaluateCondition(3, 'gt', 5)).toBe(false);
  });

  test('lt returns true when value < threshold', () => {
    expect(evaluateCondition(3, 'lt', 5)).toBe(true);
    expect(evaluateCondition(5, 'lt', 5)).toBe(false);
    expect(evaluateCondition(10, 'lt', 5)).toBe(false);
  });

  test('gte returns true when value >= threshold', () => {
    expect(evaluateCondition(10, 'gte', 5)).toBe(true);
    expect(evaluateCondition(5, 'gte', 5)).toBe(true);
    expect(evaluateCondition(3, 'gte', 5)).toBe(false);
  });

  test('lte returns true when value <= threshold', () => {
    expect(evaluateCondition(3, 'lte', 5)).toBe(true);
    expect(evaluateCondition(5, 'lte', 5)).toBe(true);
    expect(evaluateCondition(10, 'lte', 5)).toBe(false);
  });

  test('returns false for NaN value', () => {
    expect(evaluateCondition(NaN, 'gt', 5)).toBe(false);
    expect(evaluateCondition(NaN, 'lt', 5)).toBe(false);
  });

  test('returns false for unknown condition', () => {
    expect(evaluateCondition(10, 'unknown', 5)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Service tests
// ---------------------------------------------------------------------------

describe('AlertEvaluator service', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockFind.mockReset();
    mockUpdateOne.mockReset();
    mockUpdateOne.mockResolvedValue(undefined);
  });

  test('fires alert when metric exceeds threshold', async () => {
    const rule = makeRule();
    mockFind.mockResolvedValueOnce([rule]);
    mockQuery.mockResolvedValueOnce({
      json: async () => [{ value: 0.95 }],
    });

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('success');
    expect(result.data.alerts).toHaveLength(1);
    expect(result.data.alerts[0].ruleId).toBe('rule-001');
    expect(result.data.alerts[0].ruleName).toBe('High Avg Sentiment');
    expect(result.data.alerts[0].actualValue).toBe(0.95);
    expect(result.data.summary.fired).toBe(1);
    expect(result.data.summary.ok).toBe(0);

    // Should update lastEvaluatedAt and firing status
    expect(mockUpdateOne).toHaveBeenCalled();
  });

  test('respects cooldown period', async () => {
    const recentFire = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago, within 30 min cooldown
    const rule = makeRule({
      lastFiredAt: recentFire,
      status: 'firing',
    });
    mockFind.mockResolvedValueOnce([rule]);
    mockQuery.mockResolvedValueOnce({
      json: async () => [{ value: 0.95 }],
    });

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('success');
    expect(result.data.alerts).toHaveLength(0);
    expect(result.data.summary.cooldown).toBe(1);
    expect(result.data.summary.fired).toBe(0);
  });

  test('handles no enabled rules', async () => {
    mockFind.mockResolvedValueOnce([]);

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('success');
    expect(result.data.alerts).toHaveLength(0);
    expect(result.data.summary.totalRules).toBe(0);
    expect(result.data.summary.fired).toBe(0);
    expect(result.data.summary.ok).toBe(0);
  });

  test('handles ClickHouse query returning no data', async () => {
    const rule = makeRule();
    mockFind.mockResolvedValueOnce([rule]);
    mockQuery.mockResolvedValueOnce({
      json: async () => [],
    });

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('success');
    expect(result.data.alerts).toHaveLength(0);
    // No data means ok (skipped), not fired
    expect(result.data.summary.ok).toBe(1);
    expect(result.data.summary.fired).toBe(0);
  });

  test('multiple rules with mixed results', async () => {
    const firingRule = makeRule({
      _id: 'rule-fire',
      name: 'Fires',
      condition: 'gt',
      threshold: 0.5,
    });
    const okRule = makeRule({
      _id: 'rule-ok',
      name: 'OK',
      condition: 'gt',
      threshold: 0.99,
    });
    const cooldownRule = makeRule({
      _id: 'rule-cd',
      name: 'Cooldown',
      condition: 'gt',
      threshold: 0.5,
      lastFiredAt: new Date(Date.now() - 5 * 60 * 1000), // 5 min ago, within 30 min cooldown
    });

    mockFind.mockResolvedValueOnce([firingRule, okRule, cooldownRule]);

    // First rule: value 0.8 > 0.5 threshold → fires
    mockQuery.mockResolvedValueOnce({ json: async () => [{ value: 0.8 }] });
    // Second rule: value 0.8 < 0.99 threshold → ok
    mockQuery.mockResolvedValueOnce({ json: async () => [{ value: 0.8 }] });
    // Third rule: value 0.8 > 0.5 threshold but in cooldown → cooldown
    mockQuery.mockResolvedValueOnce({ json: async () => [{ value: 0.8 }] });

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('success');
    expect(result.data.alerts).toHaveLength(1);
    expect(result.data.alerts[0].ruleId).toBe('rule-fire');
    expect(result.data.summary.totalRules).toBe(3);
    expect(result.data.summary.fired).toBe(1);
    expect(result.data.summary.ok).toBe(1);
    expect(result.data.summary.cooldown).toBe(1);
  });

  test('fails when tenantId is missing', async () => {
    const result = await execute(ctx(), {
      stepContext: {
        tenantId: '',
        config: {},
        previousSteps: {},
        pipelineInput: {},
      },
      config: { tenantId: '', projectId: 'support-bot' },
    });

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('tenantId');
  });

  test('marks rule as ok when condition is not met', async () => {
    const rule = makeRule({
      condition: 'gt',
      threshold: 0.9,
    });
    mockFind.mockResolvedValueOnce([rule]);
    mockQuery.mockResolvedValueOnce({
      json: async () => [{ value: 0.5 }], // 0.5 is NOT > 0.9
    });

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('success');
    expect(result.data.alerts).toHaveLength(0);
    expect(result.data.summary.ok).toBe(1);
    expect(result.data.summary.fired).toBe(0);

    // Verify status was set to 'ok'
    const updateCalls = mockUpdateOne.mock.calls;
    const statusUpdate = updateCalls.find((call: any[]) => call[1]?.$set?.status === 'ok');
    expect(statusUpdate).toBeDefined();
  });
});
