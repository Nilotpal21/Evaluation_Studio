import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { PipelineStepContext, StepOutput } from '../pipeline/types.js';
import type { InsightResult } from '../pipeline/insight-types.js';

// Mock the ClickHouse client before importing the service
const mockInsert = vi.fn().mockResolvedValue(undefined);
vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: () => ({
    insert: mockInsert,
  }),
}));

// Import after mock setup
const { storeInsightService } = await import('../pipeline/services/store-insight.service.js');

function ctx(): any {
  return {
    run: async (_label: string, fn: () => any) => fn(),
    console: { log: () => {} },
  };
}

function getExecute(svc: any): (ctx: any, input: PipelineStepContext) => Promise<StepOutput> {
  return (svc as any).service.execute;
}

const execute = getExecute(storeInsightService);

function makeInput(overrides: Partial<PipelineStepContext> = {}): PipelineStepContext {
  const toxicityResult: InsightResult = {
    insightType: 'toxicity',
    granularity: 'session',
    score: 0.85,
    status: 'pass',
    dimensions: { avgToxicity: 0.12, messageCount: 5 },
  };
  return {
    tenantId: 'acme-corp',
    projectId: 'support-bot',
    sessionId: 'sess-001',
    config: {
      sourceStep: 'compute-toxicity',
    },
    previousSteps: {
      'compute-toxicity': {
        status: 'success',
        data: toxicityResult,
      },
    },
    pipelineInput: {
      tenantId: 'acme-corp',
      projectId: 'support-bot',
      sessionId: 'sess-001',
      pipelineId: 'pipeline-001',
      runId: 'run-001',
    },
    ...overrides,
  };
}

describe('StoreInsight service', () => {
  beforeEach(() => {
    mockInsert.mockClear();
  });

  test('writes single InsightResult row to ClickHouse', async () => {
    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('success');
    expect(result.data.recordsWritten).toBe(1);
    expect(mockInsert).toHaveBeenCalledOnce();

    const insertCall = mockInsert.mock.calls[0][0];
    expect(insertCall.table).toBe('abl_platform.insight_results');
    expect(insertCall.format).toBe('JSONEachRow');
    expect(insertCall.values).toHaveLength(1);

    const row = insertCall.values[0];
    expect(row.tenant_id).toBe('acme-corp');
    expect(row.project_id).toBe('support-bot');
    expect(row.insight_type).toBe('toxicity');
    expect(row.granularity).toBe('session');
    expect(row.score).toBe(0.85);
    expect(row.status).toBe('pass');
    expect(row.session_id).toBe('sess-001');
    expect(JSON.parse(row.dimensions)).toEqual({
      avgToxicity: 0.12,
      messageCount: 5,
    });
  });

  test('writes batch records as separate rows', async () => {
    const batchResult: InsightResult = {
      insightType: 'toxicity',
      granularity: 'message',
      score: 0.6,
      status: 'warn',
      dimensions: { messageCount: 2 },
      records: [
        {
          messageId: 'msg-1',
          score: 0.1,
          status: 'pass',
          dimensions: { text: 'hello' },
          eventTimestamp: '2026-03-01T10:00:00.000Z',
        },
        {
          messageId: 'msg-2',
          score: 0.9,
          status: 'fail',
          dimensions: { text: 'toxic' },
          eventTimestamp: '2026-03-01T10:01:00.000Z',
        },
      ],
    };

    const input = makeInput({
      previousSteps: {
        'compute-toxicity': { status: 'success', data: batchResult },
      },
    });

    const result = await execute(ctx(), input);

    expect(result.status).toBe('success');
    expect(result.data.recordsWritten).toBe(2);
    expect(mockInsert.mock.calls[0][0].values).toHaveLength(2);

    const rows = mockInsert.mock.calls[0][0].values;
    expect(rows[0].message_id).toBe('msg-1');
    expect(rows[0].score).toBe(0.1);
    expect(rows[1].message_id).toBe('msg-2');
    expect(rows[1].score).toBe(0.9);
  });

  test('auto-detects source step when sourceStep config not provided', async () => {
    const input = makeInput({
      config: {},
      previousSteps: {
        'compute-toxicity': {
          status: 'success',
          data: {
            insightType: 'toxicity',
            granularity: 'session',
            score: 0.85,
            status: 'pass',
            dimensions: {},
          } satisfies InsightResult,
        },
      },
    });

    const result = await execute(ctx(), input);
    expect(result.status).toBe('success');
    expect(result.data.recordsWritten).toBe(1);
  });

  test('fails when no InsightResult found in previousSteps', async () => {
    const input = makeInput({
      config: { sourceStep: 'nonexistent-step' },
      previousSteps: {},
    });

    const result = await execute(ctx(), input);
    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('nonexistent-step');
  });

  test('fails when source step output lacks insightType', async () => {
    const input = makeInput({
      config: { sourceStep: 'compute-toxicity' },
      previousSteps: {
        'compute-toxicity': {
          status: 'success',
          data: { someOtherField: 42 },
        },
      },
    });

    const result = await execute(ctx(), input);
    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('insightType');
  });

  test('skips when source step failed', async () => {
    const input = makeInput({
      previousSteps: {
        'compute-toxicity': {
          status: 'fail',
          data: { error: 'upstream error' },
        },
      },
    });

    const result = await execute(ctx(), input);
    expect(result.status).toBe('skipped');
  });

  test('sets default expires_at 90 days from now when not configured', async () => {
    const result = await execute(ctx(), makeInput());

    const row = mockInsert.mock.calls[0][0].values[0];
    const expiresAt = new Date(row.expires_at);
    const now = new Date();
    const diffDays = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(88);
    expect(diffDays).toBeLessThan(92);
  });

  test('uses configured retentionDays for expires_at', async () => {
    const input = makeInput({
      config: { sourceStep: 'compute-toxicity', retentionDays: 30 },
    });

    const result = await execute(ctx(), input);

    const row = mockInsert.mock.calls[0][0].values[0];
    const expiresAt = new Date(row.expires_at);
    const now = new Date();
    const diffDays = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(28);
    expect(diffDays).toBeLessThan(32);
  });
});
