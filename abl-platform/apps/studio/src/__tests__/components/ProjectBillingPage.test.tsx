import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('next-intl', () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));

vi.mock('../../store/navigation-store', () => ({
  useNavigationStore: vi.fn(),
}));

vi.mock('../../store/project-store', () => ({
  useProjectStore: vi.fn(),
}));

vi.mock('../../hooks/useBilling', () => ({
  useProjectBillingUsageReport: vi.fn(),
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

import { useNavigationStore } from '../../store/navigation-store';
import { useProjectStore } from '../../store/project-store';
import { useProjectBillingUsageReport } from '../../hooks/useBilling';
import { ProjectBillingPage } from '../../components/projects/ProjectBillingPage';

describe('ProjectBillingPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    (useNavigationStore as unknown as Mock).mockImplementation(
      (selector: (state: unknown) => unknown) =>
        selector({
          projectId: 'project-1',
        }),
    );

    (useProjectStore as unknown as Mock).mockImplementation(
      (selector: (state: unknown) => unknown) =>
        selector({
          currentProject: {
            id: 'project-1',
            name: 'Support Ops',
          },
        }),
    );

    (useProjectBillingUsageReport as Mock).mockReturnValue({
      report: {
        tenantId: 'tenant-123',
        projectId: 'project-1',
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
  });

  it('renders project-scoped billing metrics from the published usage report', () => {
    render(<ProjectBillingPage />);

    expect(screen.getByText('admin.billing.project_title')).toBeInTheDocument();
    expect(screen.getByText('admin.billing.summary_included_sessions')).toBeInTheDocument();
    expect(screen.getByText('admin.billing.summary_billing_units')).toBeInTheDocument();
    expect(screen.getByText('admin.billing.channel_breakdown_title')).toBeInTheDocument();
    expect(screen.queryByText('admin.billing.project_breakdown_title')).not.toBeInTheDocument();
    expect(screen.getByText('voice')).toBeInTheDocument();
    expect(useProjectBillingUsageReport).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project-1' }),
    );
  });

  it('renders an empty state when project context is missing', () => {
    (useNavigationStore as unknown as Mock).mockImplementation(
      (selector: (state: unknown) => unknown) =>
        selector({
          projectId: null,
        }),
    );

    render(<ProjectBillingPage />);

    expect(screen.getByText('admin.billing.no_project_title')).toBeInTheDocument();
    expect(screen.getByText('admin.billing.no_project_description')).toBeInTheDocument();
  });
});
