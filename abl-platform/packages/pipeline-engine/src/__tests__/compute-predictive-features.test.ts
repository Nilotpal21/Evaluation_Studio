import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { PipelineStepContext, StepOutput } from '../pipeline/types.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockQuery = vi.fn();
const mockInsert = vi.fn();
vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: () => ({ query: mockQuery, insert: mockInsert }),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { computePredictiveFeaturesService, computeChurnRisk } =
  await import('../pipeline/services/compute-predictive-features.service.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ctx(): any {
  return {
    run: async (_label: string, fn: () => any) => fn(),
    console: { log: () => {} },
  };
}

function getExecute(svc: any): (ctx: any, input: PipelineStepContext) => Promise<StepOutput> {
  return (svc as any).service.execute;
}

const execute = getExecute(computePredictiveFeaturesService);

function makeInput(overrides: Partial<PipelineStepContext> = {}): PipelineStepContext {
  return {
    tenantId: 'acme-corp',
    projectId: 'support-bot',
    sessionId: 'sess-001',
    config: {},
    previousSteps: {},
    pipelineInput: {
      tenantId: 'acme-corp',
      projectId: 'support-bot',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

describe('computeChurnRisk', () => {
  test('low sentiment contributes to churn risk', () => {
    const result = computeChurnRisk({
      avgSentiment: 0.1,
      escalationRate: 0,
      repeatContactCount: 0,
      qualityTrend: 0,
    });
    // lowSentiment weight = 0.3, contribution = 0.3 * (1 - 0.1) = 0.27
    expect(result.score).toBeCloseTo(0.27, 2);
    expect(result.riskLevel).toBe('low');
  });

  test('high escalation rate contributes to churn risk', () => {
    const result = computeChurnRisk({
      avgSentiment: 0.5,
      escalationRate: 0.8,
      repeatContactCount: 0,
      qualityTrend: 0,
    });
    // highEscalation weight = 0.25, contribution = 0.25 * min(0.8, 1) = 0.2
    expect(result.score).toBeCloseTo(0.2, 2);
    expect(result.riskLevel).toBe('low');
  });

  test('repeat contacts contribute to churn risk', () => {
    const result = computeChurnRisk({
      avgSentiment: 0.5,
      escalationRate: 0,
      repeatContactCount: 5,
      qualityTrend: 0,
    });
    // repeatContact weight = 0.25, contribution = 0.25 * min(5/10, 1) = 0.125
    expect(result.score).toBeCloseTo(0.125, 2);
    expect(result.riskLevel).toBe('low');
  });

  test('declining quality trend contributes to churn risk', () => {
    const result = computeChurnRisk({
      avgSentiment: 0.5,
      escalationRate: 0,
      repeatContactCount: 0,
      qualityTrend: -0.3,
    });
    // qualityTrend weight = 0.2, contribution = 0.2 * min(0.3, 1) = 0.06
    expect(result.score).toBeCloseTo(0.06, 2);
    expect(result.riskLevel).toBe('low');
  });

  test('all features low returns low risk', () => {
    const result = computeChurnRisk({
      avgSentiment: 0.8,
      escalationRate: 0.1,
      repeatContactCount: 1,
      qualityTrend: 0.02,
    });
    expect(result.score).toBe(0);
    expect(result.riskLevel).toBe('low');
  });

  test('mixed features return medium risk', () => {
    const result = computeChurnRisk({
      avgSentiment: 0.1,
      escalationRate: 0.5,
      repeatContactCount: 5,
      qualityTrend: -0.1,
    });
    // lowSentiment: 0.3 * 0.9 = 0.27
    // highEscalation: 0.25 * 0.5 = 0.125
    // repeatContact: 0.25 * 0.5 = 0.125
    // qualityTrend: 0.2 * 0.1 = 0.02
    // total = 0.54
    expect(result.score).toBeGreaterThanOrEqual(0.3);
    expect(result.score).toBeLessThan(0.6);
    expect(result.riskLevel).toBe('medium');
  });

  test('all features high returns high risk', () => {
    const result = computeChurnRisk({
      avgSentiment: 0.0,
      escalationRate: 1.0,
      repeatContactCount: 10,
      qualityTrend: -1.0,
    });
    // lowSentiment: 0.3 * 1.0 = 0.3
    // highEscalation: 0.25 * 1.0 = 0.25
    // repeatContact: 0.25 * 1.0 = 0.25
    // qualityTrend: 0.2 * 1.0 = 0.2
    // total = 1.0
    expect(result.score).toBeGreaterThanOrEqual(0.6);
    expect(result.riskLevel).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// Service tests
// ---------------------------------------------------------------------------

describe('ComputePredictiveFeatures service', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockInsert.mockReset();
    mockInsert.mockResolvedValue(undefined);
  });

  test('computes predictive features and writes to ClickHouse', async () => {
    mockQuery.mockResolvedValueOnce({
      json: async () => ({
        data: [
          {
            customer_id: 'cust-1',
            avg_sentiment: 0.1,
            escalation_rate: 0.5,
            contact_count: 5,
            quality_trend: -0.1,
          },
          {
            customer_id: 'cust-2',
            avg_sentiment: 0.8,
            escalation_rate: 0.0,
            contact_count: 1,
            quality_trend: 0.02,
          },
        ],
      }),
    });

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('success');
    expect(result.data.customersAnalyzed).toBe(2);
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsert.mock.calls[0][0].table).toBe('abl_platform.customer_predictive_features');

    const rows = mockInsert.mock.calls[0][0].values;
    expect(rows).toHaveLength(2);
    expect(rows[0].tenant_id).toBe('acme-corp');
    expect(rows[0].customer_id).toBe('cust-1');
  });

  test('handles no data from ClickHouse', async () => {
    mockQuery.mockResolvedValueOnce({
      json: async () => ({ data: [] }),
    });

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('success');
    expect(result.data.customersAnalyzed).toBe(0);
    expect(result.data.highRisk).toBe(0);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  test('fails when tenantId is missing', async () => {
    const result = await execute(ctx(), makeInput({ tenantId: '' }));
    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('Missing tenantId or projectId');
  });

  test('fails when projectId is missing', async () => {
    const result = await execute(ctx(), makeInput({ projectId: undefined }));
    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('Missing tenantId or projectId');
  });

  test('handles ClickHouse query errors gracefully', async () => {
    mockQuery.mockRejectedValueOnce(new Error('Connection refused'));

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('Connection refused');
  });

  test('respects custom lookbackDays config', async () => {
    mockQuery.mockResolvedValueOnce({
      json: async () => ({ data: [] }),
    });

    await execute(ctx(), makeInput({ config: { lookbackDays: 7 } }));

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const queryArg = mockQuery.mock.calls[0][0];
    expect(queryArg.query).toContain('INTERVAL 7 DAY');
  });

  test('categorizes risk levels in output', async () => {
    mockQuery.mockResolvedValueOnce({
      json: async () => ({
        data: [
          {
            customer_id: 'high-risk',
            avg_sentiment: 0.0,
            escalation_rate: 1.0,
            contact_count: 10,
            quality_trend: -1.0,
          },
          {
            customer_id: 'med-risk',
            avg_sentiment: 0.1,
            escalation_rate: 0.5,
            contact_count: 5,
            quality_trend: -0.1,
          },
          {
            customer_id: 'low-risk',
            avg_sentiment: 0.8,
            escalation_rate: 0.0,
            contact_count: 1,
            quality_trend: 0.02,
          },
        ],
      }),
    });

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('success');
    expect(result.data.highRisk).toBe(1);
    expect(result.data.mediumRisk).toBe(1);
    expect(result.data.lowRisk).toBe(1);
  });
});
