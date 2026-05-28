import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('next-intl', () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));

vi.mock('../../store/auth-store', () => ({
  useAuthStore: vi.fn(),
}));

vi.mock('../../lib/api-client', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('../../hooks/useBilling', () => ({
  useBillingDeals: vi.fn(),
  useBillingCredits: vi.fn(),
  useTenantFeatures: vi.fn(),
  useBillingUsageReport: vi.fn(),
  requestUpgrade: vi.fn(),
  requestTopup: vi.fn(),
}));

vi.mock('../../hooks/useAlerts', () => ({
  useAlertConfigs: vi.fn(),
}));

vi.mock('../../components/ui/PageHeader', () => ({
  PageHeader: ({ title, description }: { title: string; description?: string }) => (
    <div>
      <h1>{title}</h1>
      {description ? <p>{description}</p> : null}
    </div>
  ),
}));

vi.mock('../../components/ui/EmptyState', () => ({
  EmptyState: ({ title, description }: { title: string; description?: string }) => (
    <div>
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
    </div>
  ),
}));

vi.mock('../../components/ui/Badge', () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock('../../components/ui/Select', () => ({
  Select: ({
    options,
    value,
    onChange,
  }: {
    options: Array<{ value: string; label: string }>;
    value: string;
    onChange: (value: string) => void;
  }) => (
    <select
      data-testid="billing-select"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => (
    <div data-testid="chart-container">{children}</div>
  ),
  AreaChart: () => <div data-testid="area-chart" />,
  Area: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
}));

import { useAuthStore } from '../../store/auth-store';
import { apiFetch } from '../../lib/api-client';
import {
  useBillingDeals,
  useBillingCredits,
  useTenantFeatures,
  useBillingUsageReport,
} from '../../hooks/useBilling';
import { useAlertConfigs } from '../../hooks/useAlerts';
import { BillingPage } from '../../components/admin/BillingPage';

describe('BillingPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    (useAuthStore as unknown as Mock).mockImplementation((selector: (state: unknown) => unknown) =>
      selector({
        tenantId: 'tenant-123',
      }),
    );

    (useBillingDeals as Mock).mockReturnValue({
      deals: [],
      isLoading: false,
      error: null,
      mutate: vi.fn(),
    });

    (useBillingCredits as Mock).mockReturnValue({
      credits: null,
      isLoading: false,
      error: null,
      mutate: vi.fn(),
    });

    (useTenantFeatures as Mock).mockReturnValue({
      features: {},
      planTier: 'TEAM',
      isLoading: false,
      error: null,
      mutate: vi.fn(),
    });

    (useBillingUsageReport as Mock).mockReturnValue({
      report: {
        tenantId: 'tenant-123',
        projectId: null,
        granularity: 'day',
        range: {
          windowStart: '2026-03-01T00:00:00.000Z',
          windowEnd: '2026-03-08T00:00:00.000Z',
          timeZone: 'UTC',
        },
        totals: {
          examinedSessionCount: 3,
          includedSessionCount: 2,
          excludedSessionCount: 1,
          durationSeconds: 1_200,
          userMessageCount: 7,
          assistantMessageCount: 6,
          toolMessageCount: 1,
          interactiveTurnCount: 5,
          engagedSeconds: 900,
          llmCallCount: 8,
          toolCallCount: 1,
          baseUnits: 2,
          llmAddonUnits: 1,
          toolAddonUnits: 0,
          totalUnits: 3,
        },
        windows: [
          {
            windowStart: '2026-03-01T00:00:00.000Z',
            windowEnd: '2026-03-02T00:00:00.000Z',
            examinedSessionCount: 1,
            includedSessionCount: 1,
            excludedSessionCount: 0,
            durationSeconds: 600,
            userMessageCount: 3,
            assistantMessageCount: 3,
            toolMessageCount: 0,
            interactiveTurnCount: 2,
            engagedSeconds: 450,
            llmCallCount: 4,
            toolCallCount: 0,
            baseUnits: 1,
            llmAddonUnits: 0,
            toolAddonUnits: 0,
            totalUnits: 1,
          },
        ],
        projectBreakdown: [
          {
            projectId: 'project-1',
            examinedSessionCount: 3,
            includedSessionCount: 2,
            excludedSessionCount: 1,
            durationSeconds: 1_200,
            userMessageCount: 7,
            assistantMessageCount: 6,
            toolMessageCount: 1,
            interactiveTurnCount: 5,
            engagedSeconds: 900,
            llmCallCount: 8,
            toolCallCount: 1,
            baseUnits: 2,
            llmAddonUnits: 1,
            toolAddonUnits: 0,
            totalUnits: 3,
          },
        ],
        channelBreakdown: [
          {
            channel: 'voice',
            examinedSessionCount: 3,
            includedSessionCount: 2,
            excludedSessionCount: 1,
            durationSeconds: 1_200,
            userMessageCount: 7,
            assistantMessageCount: 6,
            toolMessageCount: 1,
            interactiveTurnCount: 5,
            engagedSeconds: 900,
            llmCallCount: 8,
            toolCallCount: 1,
            baseUnits: 2,
            llmAddonUnits: 1,
            toolAddonUnits: 0,
            totalUnits: 3,
          },
        ],
      },
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    });

    (useAlertConfigs as Mock).mockReturnValue({
      configs: [],
      loading: false,
      error: null,
      createAlert: vi.fn(),
      updateAlert: vi.fn(),
      deleteAlert: vi.fn(),
    });

    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        projects: [{ id: 'project-1', name: 'Support Ops' }],
      }),
    } as Response);
  });

  it('renders billing-unit metrics and breakdowns from the published usage report', async () => {
    render(<BillingPage />);

    expect(screen.getByText('admin.billing.summary_included_sessions')).toBeInTheDocument();
    expect(screen.getByText('admin.billing.summary_billing_units')).toBeInTheDocument();
    expect(screen.getByText('admin.billing.summary_llm_calls')).toBeInTheDocument();
    expect(screen.getByText('admin.billing.summary_interactive_turns')).toBeInTheDocument();
    expect(screen.queryByText('admin.billing.summary_estimated_cost')).not.toBeInTheDocument();
    expect(screen.getByText('admin.billing.channel_breakdown_title')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getAllByText('Support Ops').length).toBeGreaterThan(0);
    });

    expect(screen.getByText('voice')).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith('/api/projects?tenantId=tenant-123');
  });
});
