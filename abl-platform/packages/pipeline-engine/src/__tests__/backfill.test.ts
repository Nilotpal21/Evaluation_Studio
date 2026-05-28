import { describe, test, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockQuery = vi.fn();
vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: () => ({
    query: mockQuery,
  }),
}));

const mockFindOne = vi.fn();
const mockUpdateOne = vi.fn();
vi.mock('../schemas/pipeline-config.schema.js', () => ({
  PipelineConfigModel: {
    findOne: (...args: any[]) => mockFindOne(...args),
    updateOne: (...args: any[]) => mockUpdateOne(...args),
  },
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { BackfillService } = await import('../pipeline/services/backfill.service.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BackfillService', () => {
  let service: InstanceType<typeof BackfillService>;

  beforeEach(() => {
    service = new BackfillService();
    mockQuery.mockReset();
    mockFindOne.mockReset();
    mockUpdateOne.mockReset();
  });

  test('findUnprocessedSessions returns session IDs', async () => {
    mockQuery.mockResolvedValueOnce({
      json: async () => ({
        data: [{ session_id: 'sess-1' }, { session_id: 'sess-2' }, { session_id: 'sess-3' }],
      }),
    });

    const sessions = await service.findUnprocessedSessions({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      pipelineType: 'sentiment_analysis',
    });

    expect(sessions).toEqual(['sess-1', 'sess-2', 'sess-3']);
    expect(mockQuery).toHaveBeenCalledTimes(1);

    // Verify query includes tenant isolation
    const queryArg = mockQuery.mock.calls[0][0];
    expect(queryArg.query).toContain('tenant_id');
    expect(queryArg.query_params.tenantId).toBe('tenant-1');
  });

  test('findUnprocessedSessions returns empty for unknown pipeline type', async () => {
    const sessions = await service.findUnprocessedSessions({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      pipelineType: 'unknown_type' as any,
    });

    expect(sessions).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('countUnprocessedSessions returns count', async () => {
    mockQuery.mockResolvedValueOnce({
      json: async () => ({ data: [{ total: 42 }] }),
    });

    const count = await service.countUnprocessedSessions({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      pipelineType: 'intent_classification',
    });

    expect(count).toBe(42);
  });

  test('updateBackfillStatus updates MongoDB', async () => {
    mockUpdateOne.mockResolvedValueOnce({ modifiedCount: 1 });

    await service.updateBackfillStatus('tenant-1', 'proj-1', 'quality_evaluation', 'running');

    expect(mockUpdateOne).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', pipelineType: 'quality_evaluation', projectId: 'proj-1' },
      expect.objectContaining({
        $set: expect.objectContaining({
          backfillStatus: 'running',
          lastBackfillAt: expect.any(Date),
        }),
      }),
    );
  });

  test('getBackfillStatus combines config and count', async () => {
    mockFindOne.mockResolvedValueOnce({
      backfillStatus: 'completed',
      lastBackfillAt: new Date('2026-03-01'),
    });
    mockQuery.mockResolvedValueOnce({
      json: async () => ({ data: [{ total: 5 }] }),
    });

    const status = await service.getBackfillStatus('tenant-1', 'proj-1', 'sentiment_analysis');

    expect(status.status).toBe('completed');
    expect(status.lastBackfillAt).toEqual(new Date('2026-03-01'));
    expect(status.unprocessedCount).toBe(5);
  });

  test('getBackfillStatus returns defaults when no config exists', async () => {
    mockFindOne.mockResolvedValueOnce(null);
    mockQuery.mockResolvedValueOnce({
      json: async () => ({ data: [{ total: 0 }] }),
    });

    const status = await service.getBackfillStatus('tenant-1', 'proj-1', 'sentiment_analysis');

    expect(status.status).toBe('idle');
    expect(status.lastBackfillAt).toBeNull();
    expect(status.unprocessedCount).toBe(0);
  });
});
