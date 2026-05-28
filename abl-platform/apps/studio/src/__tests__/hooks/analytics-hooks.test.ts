import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const { mockUseSWR, mockUseAuthStore, mockApiFetch } = vi.hoisted(() => ({
  mockUseSWR: vi.fn(),
  mockUseAuthStore: vi.fn(),
  mockApiFetch: vi.fn(),
}));

vi.mock('swr', () => ({
  default: mockUseSWR,
}));

vi.mock('../../store/auth-store', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) => mockUseAuthStore(selector),
}));

vi.mock('../../lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

import useSWR from 'swr';
import { useAnalyticsQuery } from '../../hooks/useAnalyticsQuery';
import {
  useAggregateMetrics,
  useAnalyticsEvents,
  useAnalyticsGenerations,
  useAnalyticsSessions,
  useCostBreakdown,
  useEventCounts,
  useSessionMetrics,
  useTenantUsage,
  useTenantUsageAnalytics,
} from '../../hooks/useAnalytics';

describe('tenant usage analytics hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseSWR.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: false,
    });
    mockUseAuthStore.mockImplementation((selector: (state: unknown) => unknown) =>
      selector({
        tenantId: 'tenant-123',
        isAuthenticated: true,
      }),
    );
    mockApiFetch.mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        success: true,
        data: { columns: [], rows: [], rowCount: 0 },
        executionTimeMs: 12,
      }),
    });
  });

  it('uses a null SWR key when the user is not authenticated', () => {
    mockUseAuthStore.mockImplementation((selector: (state: unknown) => unknown) =>
      selector({
        tenantId: 'tenant-123',
        isAuthenticated: false,
      }),
    );

    renderHook(() =>
      useTenantUsageAnalytics('project-abc', {
        from: '2026-03-01T00:00:00.000Z',
        to: '2026-03-08T00:00:00.000Z',
      }),
    );

    expect(useSWR).toHaveBeenCalledWith(null, expect.any(Object));
  });

  it('uses a null SWR key when there is no project context', () => {
    renderHook(() =>
      useTenantUsageAnalytics(null, {
        from: '2026-03-01T00:00:00.000Z',
        to: '2026-03-08T00:00:00.000Z',
      }),
    );

    expect(useSWR).toHaveBeenCalledWith(null, expect.any(Object));
  });

  it('targets the analytics-specific tenant usage proxy path', () => {
    renderHook(() =>
      useTenantUsageAnalytics('project-abc', {
        from: '2026-03-01T00:00:00.000Z',
        to: '2026-03-08T00:00:00.000Z',
      }),
    );

    expect(useSWR).toHaveBeenCalledWith(
      '/api/analytics/tenant-usage?startDate=2026-03-01T00%3A00%3A00.000Z&endDate=2026-03-08T00%3A00%3A00.000Z&projectId=project-abc',
      expect.objectContaining({
        refreshInterval: 30_000,
        keepPreviousData: true,
      }),
    );
  });

  it('keeps the legacy export alias wired to the analytics path and maps breakdown rows', () => {
    mockUseSWR.mockReturnValue({
      data: {
        success: true,
        summary: null,
        breakdown: [
          {
            modelId: 'gpt-5.4',
            provider: 'openai',
            requests: 4,
            inputTokens: 10,
            outputTokens: 20,
            totalTokens: 30,
            estimatedCost: 1.25,
          },
        ],
        daily: [],
        projects: [],
      },
      error: undefined,
      isLoading: false,
    });

    const { result } = renderHook(() =>
      useTenantUsage('project-abc', {
        from: '2026-03-01T00:00:00.000Z',
        to: '2026-03-08T00:00:00.000Z',
      }),
    );

    expect(useSWR).toHaveBeenCalledWith(
      '/api/analytics/tenant-usage?startDate=2026-03-01T00%3A00%3A00.000Z&endDate=2026-03-08T00%3A00%3A00.000Z&projectId=project-abc',
      expect.any(Object),
    );
    expect(result.current.breakdown).toEqual([
      {
        model: 'gpt-5.4',
        provider: 'openai',
        callCount: 4,
        totalTokens: 30,
        totalCost: 1.25,
      },
    ]);
  });
});

describe('analytics dashboard hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseSWR.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: false,
    });
    mockUseAuthStore.mockImplementation((selector: (state: unknown) => unknown) =>
      selector({
        isAuthenticated: true,
      }),
    );
  });

  it('wires Overview KPI and error hooks to the project-scoped runtime analytics proxy', () => {
    const timeRange = {
      from: '2026-04-20T00:00:00.000Z',
      to: '2026-04-20T03:00:00.000Z',
    };

    renderHook(() => useEventCounts('project-abc', timeRange));
    renderHook(() => useSessionMetrics('project-abc', timeRange));
    renderHook(() => useCostBreakdown('project-abc', timeRange));
    renderHook(() =>
      useAnalyticsEvents('project-abc', timeRange, {
        hasError: true,
        limit: 10,
      }),
    );

    expect(useSWR).toHaveBeenNthCalledWith(
      1,
      '/api/runtime/analytics?projectId=project-abc&endpoint=event-counts&from=2026-04-20T00%3A00%3A00.000Z&to=2026-04-20T03%3A00%3A00.000Z',
      expect.any(Object),
    );
    expect(useSWR).toHaveBeenNthCalledWith(
      2,
      '/api/runtime/analytics?projectId=project-abc&endpoint=session-metrics&from=2026-04-20T00%3A00%3A00.000Z&to=2026-04-20T03%3A00%3A00.000Z',
      expect.any(Object),
    );
    expect(useSWR).toHaveBeenNthCalledWith(
      3,
      '/api/runtime/analytics?projectId=project-abc&endpoint=cost-breakdown&from=2026-04-20T00%3A00%3A00.000Z&to=2026-04-20T03%3A00%3A00.000Z',
      expect.any(Object),
    );
    expect(useSWR).toHaveBeenNthCalledWith(
      4,
      '/api/runtime/analytics?projectId=project-abc&endpoint=events&from=2026-04-20T00%3A00%3A00.000Z&to=2026-04-20T03%3A00%3A00.000Z&hasError=true&limit=10',
      expect.any(Object),
    );
  });

  it('wires Sessions and Traces Explorer list hooks to ClickHouse-backed runtime analytics endpoints', () => {
    const timeRange = {
      from: '2026-04-20T00:00:00.000Z',
      to: '2026-04-20T03:00:00.000Z',
    };

    renderHook(() => useAnalyticsSessions('project-abc', timeRange, { limit: 1000 }));
    renderHook(() =>
      useAnalyticsGenerations('project-abc', timeRange, {
        sessionId: 'session-1',
        limit: 1000,
      }),
    );

    expect(useSWR).toHaveBeenNthCalledWith(
      1,
      '/api/runtime/analytics?projectId=project-abc&endpoint=sessions&from=2026-04-20T00%3A00%3A00.000Z&to=2026-04-20T03%3A00%3A00.000Z&limit=1000',
      expect.any(Object),
    );
    expect(useSWR).toHaveBeenNthCalledWith(
      2,
      '/api/runtime/analytics?projectId=project-abc&endpoint=generations&from=2026-04-20T00%3A00%3A00.000Z&to=2026-04-20T03%3A00%3A00.000Z&sessionId=session-1&limit=1000',
      expect.any(Object),
    );
  });

  it('wires aggregate chart hooks with grouping, metric, and category parameters', () => {
    const timeRange = {
      from: '2026-04-20T00:00:00.000Z',
      to: '2026-04-20T03:00:00.000Z',
    };

    renderHook(() =>
      useAggregateMetrics('project-abc', timeRange, {
        groupBy: ['hour'],
        metrics: ['count', 'avg_duration', 'p95_duration'],
        category: 'llm',
      }),
    );

    expect(useSWR).toHaveBeenCalledWith(
      '/api/runtime/analytics?projectId=project-abc&endpoint=metrics&from=2026-04-20T00%3A00%3A00.000Z&to=2026-04-20T03%3A00%3A00.000Z&groupBy=hour&metrics=count%2Cavg_duration%2Cp95_duration&category=llm',
      expect.any(Object),
    );
  });
});

describe('analytics SQL query hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiFetch.mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        success: true,
        data: { columns: ['event_type'], rows: [['session.started']], rowCount: 1 },
        executionTimeMs: 12,
      }),
    });
  });

  it('sends the selected analytics time range with SQL execution requests', async () => {
    const timeRange = {
      from: '2026-04-20T00:00:00.000Z',
      to: '2026-04-20T03:00:00.000Z',
    };
    const { result } = renderHook(() => useAnalyticsQuery('project-abc', timeRange));

    await act(async () => {
      await result.current.executeQuery(
        'SELECT event_type FROM abl_platform.platform_events WHERE tenant_id = {tenantId:String} AND project_id = {projectId:String}',
      );
    });

    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/runtime/analytics?projectId=project-abc&endpoint=sql-query',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          sql: 'SELECT event_type FROM abl_platform.platform_events WHERE tenant_id = {tenantId:String} AND project_id = {projectId:String}',
          timeRange,
        }),
      }),
    );
    expect(result.current.result).toEqual({
      columns: ['event_type'],
      rows: [['session.started']],
      rowCount: 1,
    });
    expect(result.current.executionTimeMs).toBe(12);
  });

  it('renders structured SQL errors as their message instead of a raw object', async () => {
    mockApiFetch.mockResolvedValueOnce({
      json: vi.fn().mockResolvedValue({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Query must include a project_id filter',
        },
      }),
    });
    const { result } = renderHook(() => useAnalyticsQuery('project-abc'));

    await act(async () => {
      await result.current.executeQuery('SELECT event_type FROM abl_platform.platform_events');
    });

    expect(result.current.error).toBe('Query must include a project_id filter');
  });
});
