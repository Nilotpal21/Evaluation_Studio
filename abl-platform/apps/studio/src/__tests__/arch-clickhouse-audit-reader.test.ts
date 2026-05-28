import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockClickHouseQuery,
  mockGetClickHouseClient,
  mockIsInMemoryAuditTestBackendEnabled,
  mockQueryInMemoryAuditTestLogs,
} = vi.hoisted(() => ({
  mockClickHouseQuery: vi.fn(),
  mockGetClickHouseClient: vi.fn(),
  mockIsInMemoryAuditTestBackendEnabled: vi.fn(),
  mockQueryInMemoryAuditTestLogs: vi.fn(),
}));

vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: (...args: unknown[]) => mockGetClickHouseClient(...args),
  parseClickHouseTimestamp: (value: string) => new Date(value.replace(' ', 'T') + 'Z'),
  toClickHouseDateTime: (value: Date) => value.toISOString(),
}));

vi.mock('@abl/compiler/platform/stores', () => ({
  isInMemoryAuditTestBackendEnabled: (...args: unknown[]) =>
    mockIsInMemoryAuditTestBackendEnabled(...args),
  queryInMemoryAuditTestLogs: (...args: unknown[]) => mockQueryInMemoryAuditTestLogs(...args),
}));

vi.mock('@agent-platform/arch-ai', () => ({
  AUDIT_LOG_CATEGORIES: ['llm_call', 'system_event'],
  AUDIT_LOG_SEVERITIES: ['info', 'warning', 'error', 'critical'],
}));

describe('arch-clickhouse-audit-reader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsInMemoryAuditTestBackendEnabled.mockReturnValue(false);
    mockGetClickHouseClient.mockReturnValue({
      query: mockClickHouseQuery,
    });
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('queries Arch audit entries from ClickHouse with the expected filters', async () => {
    mockClickHouseQuery
      .mockResolvedValueOnce({
        json: async () => [{ cnt: '1' }],
      })
      .mockResolvedValueOnce({
        json: async () => [
          {
            tenant_id: 'tenant-1',
            user_id: 'user-1',
            session_id: 'session-1',
            project_id: 'project-1',
            timestamp: '2026-04-22 10:00:00.000',
            event_id: 'arch-1',
            category: 'llm_call',
            severity: 'info',
            summary: 'LLM step completed',
            detail: JSON.stringify({ model: 'gpt-5.4', stepIndex: 2 }),
            specialist: 'planner',
            phase: 'build',
            duration_ms: '1234',
            input_tokens: '10',
            output_tokens: '15',
            total_tokens: '25',
            estimated_cost: '0.42',
            metadata: '{}',
          },
        ],
      });

    const { queryArchAuditLogs } = await import('@/lib/arch-clickhouse-audit-reader');
    const result = await queryArchAuditLogs({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      categories: ['llm_call'],
      severities: ['info'],
      phase: 'build',
      userId: 'user-1',
      sessionId: 'session-1',
      specialist: 'planner',
      from: new Date('2026-04-22T00:00:00.000Z'),
      to: new Date('2026-04-23T00:00:00.000Z'),
      limit: 10,
      offset: 20,
    });

    expect(result.total).toBe(1);
    expect(result.entries).toEqual([
      expect.objectContaining({
        _id: 'arch-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        sessionId: 'session-1',
        projectId: 'project-1',
        category: 'llm_call',
        severity: 'info',
        summary: 'LLM step completed',
        specialist: 'planner',
        phase: 'build',
        durationMs: 1234,
        tokens: {
          input: 10,
          output: 15,
          total: 25,
          estimatedCost: 0.42,
        },
        detail: { model: 'gpt-5.4', stepIndex: 2 },
      }),
    ]);

    expect(mockClickHouseQuery).toHaveBeenCalledTimes(2);
    const countQuery = mockClickHouseQuery.mock.calls[0][0];
    const rowsQuery = mockClickHouseQuery.mock.calls[1][0];

    expect(countQuery.query).toContain('category IN ({categories:Array(String)})');
    expect(countQuery.query).toContain('project_id = {projectId:String}');
    expect(countQuery.query).toContain('severity IN ({severities:Array(String)})');
    expect(countQuery.query).toContain('phase = {phase:String}');
    expect(countQuery.query).toContain('user_id = {userId:String}');
    expect(countQuery.query).toContain('session_id = {sessionId:String}');
    expect(countQuery.query).toContain('specialist = {specialist:String}');
    expect(rowsQuery.query_params).toMatchObject({
      limit: 10,
      offset: 20,
      tenantId: 'tenant-1',
      projectId: 'project-1',
    });
  });

  it('summarizes Arch audit rows from the in-memory pipeline test backend', async () => {
    mockIsInMemoryAuditTestBackendEnabled.mockReturnValue(true);
    mockQueryInMemoryAuditTestLogs.mockResolvedValue({
      logs: [
        {
          id: 'arch-1',
          tenantId: 'tenant-1',
          actor: 'user-1',
          projectId: 'project-1',
          resourceType: 'arch_session',
          resourceId: 'session-1',
          metadata: {
            category: 'llm_call',
            severity: 'warning',
            summary: 'A warning',
            detail: { model: 'gpt-5.4' },
            phase: 'build',
            tokens: { input: 10, output: 5, total: 15, estimatedCost: 0.25 },
          },
          timestamp: new Date('2026-04-22T10:00:00.000Z'),
        },
        {
          id: 'arch-2',
          tenantId: 'tenant-1',
          actor: 'user-2',
          projectId: 'project-1',
          resourceType: 'arch_session',
          resourceId: 'session-2',
          metadata: {
            category: 'system_event',
            severity: 'info',
            summary: 'Created',
            detail: { event: 'session_created' },
          },
          timestamp: new Date('2026-04-22T11:00:00.000Z'),
        },
      ],
      total: 2,
    });

    const { summarizeArchAuditLogs } = await import('@/lib/arch-clickhouse-audit-reader');
    const summary = await summarizeArchAuditLogs({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      from: new Date('2026-04-22T00:00:00.000Z'),
      to: new Date('2026-04-23T00:00:00.000Z'),
    });

    expect(mockQueryInMemoryAuditTestLogs).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      resourceType: 'arch_session',
      startTime: new Date('2026-04-22T00:00:00.000Z'),
      endTime: new Date('2026-04-23T00:00:00.000Z'),
      limit: Number.MAX_SAFE_INTEGER,
      offset: 0,
    });
    expect(summary).toEqual({
      totalEvents: 2,
      totalTokens: { input: 10, output: 5, total: 15 },
      estimatedCost: 0.25,
      errorCount: { total: 1, critical: 0, error: 0, warning: 1 },
      byCategory: { llm_call: 1, system_event: 1 },
    });
  });

  it('builds the Arch cost breakdown from ClickHouse rows', async () => {
    mockClickHouseQuery.mockResolvedValueOnce({
      json: async () => [
        {
          userId: 'user-1',
          phase: 'build',
          model: 'gpt-5.4',
          totalCost: '1.5',
          totalTokens: '120',
          callCount: '3',
        },
      ],
    });

    const { getArchAuditCostBreakdown } = await import('@/lib/arch-clickhouse-audit-reader');
    const groups = await getArchAuditCostBreakdown({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      from: new Date('2026-04-22T00:00:00.000Z'),
      to: new Date('2026-04-23T00:00:00.000Z'),
    });

    expect(groups).toEqual([
      {
        userId: 'user-1',
        phase: 'build',
        model: 'gpt-5.4',
        totalCost: 1.5,
        totalTokens: 120,
        callCount: 3,
      },
    ]);
    expect(mockClickHouseQuery).toHaveBeenCalledOnce();
    expect(mockClickHouseQuery.mock.calls[0][0].query).toContain('project_id = {projectId:String}');
    expect(mockClickHouseQuery.mock.calls[0][0].query_params).toMatchObject({
      tenantId: 'tenant-1',
      projectId: 'project-1',
    });
  });
});
