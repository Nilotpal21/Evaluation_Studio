import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { PipelineStepContext, StepOutput } from '../pipeline/types.js';
import type { InsightResult } from '../pipeline/insight-types.js';

// Mock ClickHouse client
const mockQuery = vi.fn();
vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: () => ({
    query: mockQuery,
  }),
}));

const { computeToolEffectivenessService } =
  await import('../pipeline/services/compute-tool-effectiveness.service.js');

function ctx(): any {
  return {
    run: async (_label: string, fn: () => any) => fn(),
    console: { log: () => {} },
  };
}

function getExecute(svc: any): (ctx: any, input: PipelineStepContext) => Promise<StepOutput> {
  return (svc as any).service.execute;
}

const execute = getExecute(computeToolEffectivenessService);

function makeInput(overrides: Partial<PipelineStepContext> = {}): PipelineStepContext {
  return {
    tenantId: 'acme-corp',
    projectId: 'support-bot',
    sessionId: 'sess-001',
    config: {
      params: {},
    },
    previousSteps: {},
    pipelineInput: {
      tenantId: 'acme-corp',
      projectId: 'support-bot',
      sessionId: 'sess-001',
    },
    ...overrides,
  };
}

/** Helper to create a mock ClickHouse JSON result set */
function chResult(rows: Record<string, unknown>[]) {
  return {
    json: async () => ({ data: rows }),
  };
}

describe('ComputeToolEffectiveness service', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  test('computes tool effectiveness from successful tool calls', async () => {
    mockQuery.mockResolvedValue(
      chResult([
        {
          tool_name: 'searchKB',
          total_calls: 10,
          successful_calls: 9,
          retried_calls: 1,
          avg_duration_ms: 150,
        },
        {
          tool_name: 'createTicket',
          total_calls: 5,
          successful_calls: 5,
          retried_calls: 0,
          avg_duration_ms: 200,
        },
      ]),
    );

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('success');
    const insight = result.data as InsightResult;
    expect(insight.insightType).toBe('tool-effectiveness');
    expect(insight.granularity).toBe('session');
    expect(insight.score).toBeGreaterThan(0);
    expect(insight.dimensions).toHaveProperty('selectionAccuracy');
    expect(insight.dimensions).toHaveProperty('retryRate');
    expect(insight.dimensions).toHaveProperty('totalToolCalls');
  });

  test('returns per-tool records', async () => {
    mockQuery.mockResolvedValue(
      chResult([
        {
          tool_name: 'searchKB',
          total_calls: 10,
          successful_calls: 8,
          retried_calls: 2,
          avg_duration_ms: 150,
        },
        {
          tool_name: 'createTicket',
          total_calls: 3,
          successful_calls: 3,
          retried_calls: 0,
          avg_duration_ms: 200,
        },
      ]),
    );

    const result = await execute(ctx(), makeInput());
    const insight = result.data as InsightResult;

    expect(insight.records).toHaveLength(2);
    expect(insight.records![0].dimensions).toHaveProperty('toolName', 'searchKB');
    expect(insight.records![1].dimensions).toHaveProperty('toolName', 'createTicket');
  });

  test('filters to specific tools when tools param provided', async () => {
    mockQuery.mockResolvedValue(
      chResult([
        {
          tool_name: 'searchKB',
          total_calls: 5,
          successful_calls: 5,
          retried_calls: 0,
          avg_duration_ms: 100,
        },
      ]),
    );

    const input = makeInput({
      config: { params: { tools: ['searchKB', 'lookupOrder'] } },
    });

    await execute(ctx(), input);

    const queryCall = mockQuery.mock.calls[0][0];
    expect(queryCall.query).toContain('tool_name');
  });

  test('handles zero tool calls gracefully', async () => {
    mockQuery.mockResolvedValue(chResult([]));

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('success');
    const insight = result.data as InsightResult;
    expect(insight.score).toBe(1.0);
    expect(insight.status).toBe('pass');
    expect(insight.dimensions.totalToolCalls).toBe(0);
    expect(insight.records).toHaveLength(0);
  });

  test('fails when sessionId is missing', async () => {
    const input = makeInput({ sessionId: undefined });

    const result = await execute(ctx(), input);
    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('sessionId');
  });

  test('queries ClickHouse with tenant_id and session_id params', async () => {
    mockQuery.mockResolvedValue(chResult([]));

    await execute(ctx(), makeInput());

    const queryCall = mockQuery.mock.calls[0][0];
    expect(queryCall.query_params.tenantId).toBe('acme-corp');
    expect(queryCall.query_params.sessionId).toBe('sess-001');
  });

  test('high retry rate results in lower score', async () => {
    mockQuery.mockResolvedValue(
      chResult([
        {
          tool_name: 'searchKB',
          total_calls: 10,
          successful_calls: 5,
          retried_calls: 5,
          avg_duration_ms: 300,
        },
      ]),
    );

    const result = await execute(ctx(), makeInput());
    const insight = result.data as InsightResult;

    expect(insight.score).toBeLessThan(0.8);
    expect(insight.dimensions.retryRate).toBeGreaterThan(0.3);
  });

  test('perfect tool calls result in score near 1.0', async () => {
    mockQuery.mockResolvedValue(
      chResult([
        {
          tool_name: 'searchKB',
          total_calls: 10,
          successful_calls: 10,
          retried_calls: 0,
          avg_duration_ms: 100,
        },
        {
          tool_name: 'createTicket',
          total_calls: 5,
          successful_calls: 5,
          retried_calls: 0,
          avg_duration_ms: 50,
        },
      ]),
    );

    const result = await execute(ctx(), makeInput());
    const insight = result.data as InsightResult;

    expect(insight.score).toBeGreaterThanOrEqual(0.9);
    expect(insight.status).toBe('pass');
  });
});
