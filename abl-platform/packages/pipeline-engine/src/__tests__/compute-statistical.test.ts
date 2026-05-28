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

const mod = await import('../pipeline/services/compute-statistical.service.js');
const {
  computeStatisticalService,
  computeZScore,
  computeSPC,
  computeIQR,
  computeLinearRegressionSlope,
} = mod;

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

const execute = getExecute(computeStatisticalService);

function makeInput(
  analysisType: string,
  overrides: Partial<PipelineStepContext> = {},
): PipelineStepContext {
  return {
    tenantId: 'acme-corp',
    projectId: 'support-bot',
    sessionId: 'sess-001',
    config: { analysisType },
    previousSteps: {
      'read-conversation': {
        status: 'success',
        data: {
          messages: [
            {
              role: 'user',
              content: 'How do I reset my password?',
              timestamp: '2026-03-01T10:00:00Z',
            },
            {
              role: 'assistant',
              content: 'Go to settings and click reset.',
              timestamp: '2026-03-01T10:00:05Z',
            },
            {
              role: 'user',
              content: 'I said HOW DO I RESET MY PASSWORD??!',
              timestamp: '2026-03-01T10:00:30Z',
            },
            {
              role: 'assistant',
              content: 'I apologize. Go to Settings > Security > Reset Password.',
              timestamp: '2026-03-01T10:00:35Z',
            },
          ],
          transcript:
            'User: How do I reset my password?\nAssistant: Go to settings and click reset.\nUser: I said HOW DO I RESET MY PASSWORD??!\nAssistant: I apologize. Go to Settings > Security > Reset Password.',
          metadata: { agentName: 'support-bot', channel: 'web' },
        },
      },
    },
    pipelineInput: {
      tenantId: 'acme-corp',
      sessionId: 'sess-001',
      projectId: 'support-bot',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

describe('Statistical utility functions', () => {
  test('computeZScore returns correct z-score', () => {
    expect(computeZScore(9, 5, 2)).toBe(2.0);
    expect(computeZScore(5, 5, 2)).toBe(0);
    expect(computeZScore(1, 5, 2)).toBe(-2.0);
  });

  test('computeZScore returns 0 when stddev is 0', () => {
    expect(computeZScore(5, 5, 0)).toBe(0);
  });

  test('computeSPC identifies out-of-control points', () => {
    // Use many identical values so stddev is small, then one extreme value well outside 3-sigma
    const values = [
      10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 100,
    ];
    const result = computeSPC(values);
    expect(result.outOfControl).toContain(19); // index of 100
    expect(result.mean).toBeCloseTo(14.5, 0);
  });

  test('computeIQR identifies outliers', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100]; // 100 is outlier
    const result = computeIQR(values);
    expect(result.outliers).toContain(100);
    expect(result.q1).toBeDefined();
    expect(result.q3).toBeDefined();
  });

  test('computeLinearRegressionSlope returns positive slope for increasing data', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const slope = computeLinearRegressionSlope(values);
    expect(slope).toBeGreaterThan(0);
    expect(slope).toBeCloseTo(1, 1);
  });

  test('computeLinearRegressionSlope returns 0 for constant data', () => {
    const values = [5, 5, 5, 5, 5];
    const slope = computeLinearRegressionSlope(values);
    expect(slope).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Service tests
// ---------------------------------------------------------------------------

describe('ComputeStatistical service', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockInsert.mockReset();
    mockInsert.mockResolvedValue(undefined);
  });

  test('friction profile computes composite score', async () => {
    const result = await execute(ctx(), makeInput('friction_detection'));

    expect(result.status).toBe('success');
    expect(result.data.friction_score).toBeDefined();
    expect(typeof result.data.friction_score).toBe('number');
    expect(result.data.rephrase_count).toBeDefined();
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsert.mock.calls[0][0].table).toBe('abl_platform.friction_detections');
  });

  test('includes pipeline_id and pipeline_type in friction ClickHouse insert', async () => {
    const result = await execute(
      ctx(),
      makeInput('friction_detection', { pipelineId: 'test-pipe-1', pipelineType: 'custom' }),
    );

    expect(result.status).toBe('success');
    expect(mockInsert).toHaveBeenCalledTimes(1);

    const row = mockInsert.mock.calls[0][0].values[0];
    expect(row.pipeline_id).toBe('test-pipe-1');
    expect(row.pipeline_type).toBe('custom');
  });

  test('includes pipeline_id, pipeline_type, and channel in anomaly ClickHouse insert', async () => {
    mockQuery.mockResolvedValueOnce({
      json: async () => ({
        data: [
          { day: '2026-02-01', value: 10 },
          { day: '2026-02-02', value: 11 },
          { day: '2026-02-03', value: 10 },
          { day: '2026-02-04', value: 12 },
          { day: '2026-02-05', value: 10 },
          { day: '2026-02-06', value: 11 },
          { day: '2026-02-07', value: 10 },
          { day: '2026-02-08', value: 50 },
        ],
      }),
    });

    const result = await execute(
      ctx(),
      makeInput('anomaly_detection', {
        pipelineId: 'test-pipe-1',
        pipelineType: 'custom',
        config: {
          analysisType: 'anomaly_detection',
          metricTable: 'abl_platform.mv_daily_sentiment',
          metricColumn: 'avg_sentiment',
          dateColumn: 'day',
        },
      }),
    );

    expect(result.status).toBe('success');
    expect(mockInsert).toHaveBeenCalledTimes(1);

    const row = mockInsert.mock.calls[0][0].values[0];
    expect(row.pipeline_id).toBe('test-pipe-1');
    expect(row.pipeline_type).toBe('custom');
    expect(row.channel).toBeDefined();
  });

  test('includes pipeline_id, pipeline_type, and channel in drift ClickHouse insert', async () => {
    mockQuery.mockResolvedValueOnce({
      json: async () => ({
        data: [
          { day: '2026-02-01', value: 10 },
          { day: '2026-02-02', value: 11 },
          { day: '2026-02-03', value: 10 },
          { day: '2026-02-04', value: 12 },
          { day: '2026-02-05', value: 10 },
          { day: '2026-02-06', value: 11 },
          { day: '2026-02-07', value: 10 },
          { day: '2026-02-08', value: 15 },
        ],
      }),
    });

    const result = await execute(
      ctx(),
      makeInput('drift_detection', {
        pipelineId: 'test-pipe-1',
        pipelineType: 'custom',
        config: {
          analysisType: 'drift_detection',
          metricTable: 'abl_platform.mv_daily_sentiment',
          metricColumn: 'avg_sentiment',
          dateColumn: 'day',
        },
      }),
    );

    expect(result.status).toBe('success');
    expect(mockInsert).toHaveBeenCalledTimes(1);

    const row = mockInsert.mock.calls[0][0].values[0];
    expect(row.pipeline_id).toBe('test-pipe-1');
    expect(row.pipeline_type).toBe('custom');
    expect(row.channel).toBeDefined();
  });

  test('friction profile detects rephrases via similarity', async () => {
    const input = makeInput('friction_detection', {
      previousSteps: {
        'read-conversation': {
          status: 'success',
          data: {
            messages: [
              {
                role: 'user',
                content: 'how do I reset my account password',
                timestamp: '2026-03-01T10:00:00Z',
              },
              {
                role: 'assistant',
                content: 'Try the settings page.',
                timestamp: '2026-03-01T10:00:05Z',
              },
              {
                role: 'user',
                content: 'how do I reset my password',
                timestamp: '2026-03-01T10:00:30Z',
              },
              {
                role: 'assistant',
                content: 'Go to Settings > Security > Reset.',
                timestamp: '2026-03-01T10:00:35Z',
              },
            ],
            transcript: '',
            metadata: { agentName: 'bot', channel: 'web' },
          },
        },
      },
    });

    const result = await execute(ctx(), input);
    expect(result.status).toBe('success');
    expect(result.data.rephrase_count).toBeGreaterThanOrEqual(1);
  });

  test('anomaly profile flags high z-score values', async () => {
    // Mock ClickHouse query returning time series data
    mockQuery.mockResolvedValueOnce({
      json: async () => ({
        data: [
          { day: '2026-02-01', value: 10 },
          { day: '2026-02-02', value: 11 },
          { day: '2026-02-03', value: 10 },
          { day: '2026-02-04', value: 12 },
          { day: '2026-02-05', value: 10 },
          { day: '2026-02-06', value: 11 },
          { day: '2026-02-07', value: 10 },
          { day: '2026-02-08', value: 50 }, // anomaly
        ],
      }),
    });

    const input = makeInput('anomaly_detection', {
      config: {
        analysisType: 'anomaly_detection',
        metricTable: 'abl_platform.mv_daily_sentiment',
        metricColumn: 'avg_sentiment',
        dateColumn: 'day',
      },
    });

    const result = await execute(ctx(), input);
    expect(result.status).toBe('success');
    expect(result.data.anomaly_flag).toBe(true);
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsert.mock.calls[0][0].table).toBe('abl_platform.anomaly_detections');
  });

  test('fails for unknown analysis type', async () => {
    const result = await execute(ctx(), makeInput('nonexistent_type'));
    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('Unknown analysis type');
  });

  test('skips when no data available', async () => {
    const result = await execute(
      ctx(),
      makeInput('friction_detection', {
        previousSteps: {
          'read-conversation': {
            status: 'success',
            data: { messages: [], transcript: '', metadata: {} },
          },
        },
      }),
    );
    expect(result.status).toBe('skipped');
  });
});
