import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const { mockMutate, mockUseSWR, mockUseAuthStore } = vi.hoisted(() => ({
  mockMutate: vi.fn(),
  mockUseSWR: vi.fn(),
  mockUseAuthStore: vi.fn(),
}));

vi.mock('swr', () => ({
  default: mockUseSWR,
}));

vi.mock('../../store/auth-store', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) => mockUseAuthStore(selector),
}));

import useSWR from 'swr';
import { useBillingUsageReport, useProjectBillingUsageReport } from '../../hooks/useBilling';

const billingState = {
  tenantId: 'tenant-123',
  isAuthenticated: true,
  isSuperAdmin: false,
  user: { id: 'u-1', email: 'u@example.com', permissions: ['billing:read'] },
};

describe('useBillingUsageReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseSWR.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: false,
      mutate: mockMutate,
    });
    mockUseAuthStore.mockImplementation((selector: (state: unknown) => unknown) =>
      selector(billingState),
    );
  });

  it('uses a null SWR key when the user is not authenticated', () => {
    mockUseAuthStore.mockImplementation((selector: (state: unknown) => unknown) =>
      selector({
        ...billingState,
        isAuthenticated: false,
      }),
    );

    renderHook(() =>
      useBillingUsageReport({
        windowStart: '2026-03-01T00:00:00.000Z',
        windowEnd: '2026-03-08T00:00:00.000Z',
      }),
    );

    expect(useSWR).toHaveBeenCalledWith(null, expect.any(Object));
  });

  it('uses a null SWR key when the user lacks billing:read permission', () => {
    mockUseAuthStore.mockImplementation((selector: (state: unknown) => unknown) =>
      selector({
        ...billingState,
        user: { ...billingState.user, permissions: [] },
      }),
    );

    renderHook(() =>
      useBillingUsageReport({
        windowStart: '2026-03-01T00:00:00.000Z',
        windowEnd: '2026-03-08T00:00:00.000Z',
      }),
    );

    expect(useSWR).toHaveBeenCalledWith(null, expect.any(Object));
  });

  it('builds the billing usage report endpoint with window, granularity, and project filters', () => {
    renderHook(() =>
      useBillingUsageReport({
        windowStart: '2026-03-01T00:00:00.000Z',
        windowEnd: '2026-03-08T00:00:00.000Z',
        granularity: 'week',
        projectId: 'project-abc',
      }),
    );

    expect(useSWR).toHaveBeenCalledWith(
      '/api/admin/billing?endpoint=usage&windowStart=2026-03-01T00%3A00%3A00.000Z&windowEnd=2026-03-08T00%3A00%3A00.000Z&granularity=week&projectId=project-abc',
      expect.objectContaining({
        refreshInterval: 60_000,
        keepPreviousData: true,
      }),
    );
  });

  it('returns the tenant billing usage report and refresh handle', () => {
    const report = {
      success: true,
      tenantId: 'tenant-123',
      projectId: null,
      granularity: 'day' as const,
      range: {
        windowStart: '2026-03-01T00:00:00.000Z',
        windowEnd: '2026-03-08T00:00:00.000Z',
        timeZone: 'UTC' as const,
      },
      totals: {
        examinedSessionCount: 3,
        includedSessionCount: 2,
        excludedSessionCount: 1,
        durationSeconds: 900,
        userMessageCount: 5,
        assistantMessageCount: 5,
        toolMessageCount: 1,
        interactiveTurnCount: 4,
        engagedSeconds: 600,
        llmCallCount: 7,
        toolCallCount: 1,
        baseUnits: 2,
        llmAddonUnits: 1,
        toolAddonUnits: 0,
        totalUnits: 3,
      },
      windows: [],
      projectBreakdown: [],
      channelBreakdown: [],
    };

    mockUseSWR.mockReturnValue({
      data: report,
      error: undefined,
      isLoading: false,
      mutate: mockMutate,
    });

    const { result } = renderHook(() =>
      useBillingUsageReport({
        windowStart: '2026-03-01T00:00:00.000Z',
        windowEnd: '2026-03-08T00:00:00.000Z',
      }),
    );

    expect(result.current.report).toEqual({
      tenantId: 'tenant-123',
      projectId: null,
      granularity: 'day',
      range: report.range,
      totals: report.totals,
      windows: [],
      projectBreakdown: [],
      channelBreakdown: [],
    });
    expect(result.current.error).toBeNull();
    expect(result.current.refresh).toBe(mockMutate);
  });
});

describe('useProjectBillingUsageReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseSWR.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: false,
      mutate: mockMutate,
    });
    mockUseAuthStore.mockImplementation((selector: (state: unknown) => unknown) =>
      selector(billingState),
    );
  });

  it('uses a null SWR key when there is no project context', () => {
    renderHook(() =>
      useProjectBillingUsageReport({
        projectId: null,
        windowStart: '2026-03-01T00:00:00.000Z',
        windowEnd: '2026-03-08T00:00:00.000Z',
      }),
    );

    expect(useSWR).toHaveBeenCalledWith(null, expect.any(Object));
  });

  it('builds the project billing usage endpoint with window and granularity filters', () => {
    renderHook(() =>
      useProjectBillingUsageReport({
        projectId: 'project-abc',
        windowStart: '2026-03-01T00:00:00.000Z',
        windowEnd: '2026-03-08T00:00:00.000Z',
        granularity: 'week',
      }),
    );

    expect(useSWR).toHaveBeenCalledWith(
      '/api/projects/project-abc/billing/usage?windowStart=2026-03-01T00%3A00%3A00.000Z&windowEnd=2026-03-08T00%3A00%3A00.000Z&granularity=week',
      expect.objectContaining({
        refreshInterval: 60_000,
        keepPreviousData: true,
      }),
    );
  });
});
