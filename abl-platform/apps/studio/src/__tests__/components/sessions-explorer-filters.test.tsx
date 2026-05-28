import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionsExplorerTab } from '../../components/analytics/SessionsExplorerTab';
import { DEFAULT_INSIGHTS_ANALYTICS_FILTERS } from '../../lib/preferences/insights-analytics-filters';
import { usePreferencesStore } from '../../store/preferences-store';

vi.mock('next-intl', () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));

vi.mock('../../hooks/useAnalytics', () => ({
  useAnalyticsSessions: vi.fn(() => ({
    isLoading: false,
    sessions: [
      {
        id: 'session-web',
        agentId: 'agent-1',
        agentName: 'Web Agent',
        status: 'active',
        durationMs: 1000,
        messageCount: 3,
        traceEventCount: 5,
        tokenCount: 120,
        estimatedCost: 0.02,
        errorCount: 0,
        channel: 'web_chat',
        environment: 'production',
        createdAt: '2026-04-10T10:00:00.000Z',
        lastActivityAt: '2026-04-10T10:01:00.000Z',
      },
      {
        id: 'session-voice',
        agentId: 'agent-2',
        agentName: 'Voice Agent',
        status: 'completed',
        durationMs: 2000,
        messageCount: 4,
        traceEventCount: 6,
        tokenCount: 200,
        estimatedCost: 0.03,
        errorCount: 0,
        channel: 'voice_pipeline',
        environment: 'staging',
        createdAt: '2026-04-10T11:00:00.000Z',
        lastActivityAt: '2026-04-10T11:01:00.000Z',
      },
      {
        id: 'session-long-running',
        agentId: 'agent-3',
        agentName: 'Long Running Agent',
        status: 'completed',
        durationMs: 5000,
        messageCount: 7,
        traceEventCount: 9,
        tokenCount: 320,
        estimatedCost: 0.05,
        errorCount: 0,
        channel: 'web_chat',
        environment: 'production',
        createdAt: '2026-03-31T20:00:00.000Z',
        lastActivityAt: '2026-04-10T12:01:00.000Z',
      },
    ],
    total: 2,
  })),
}));

vi.mock('../../components/analytics/shared', () => ({
  KPICard: ({ title, value }: { title: string; value: string }) => (
    <div>
      <span>{title}</span>
      <span>{value}</span>
    </div>
  ),
  formatNumber: (value: number) => String(value),
  formatDuration: (value: number) => `${value}ms`,
  formatCost: (value: number) => `$${value}`,
}));

vi.mock('../../components/ui/Badge', () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock('../../components/ui/Pagination', () => ({
  Pagination: () => null,
}));

vi.mock('../../components/ui/EmptyState', () => ({
  EmptyState: ({ title, description }: { title: string; description: string }) => (
    <div>
      <span>{title}</span>
      <span>{description}</span>
    </div>
  ),
}));

vi.mock('../../components/shared/AdvancedFilterPanel', () => ({
  AdvancedFilterPanel: () => null,
  FilterTags: () => null,
  applyAdvancedFilters: (sessions: unknown[]) => sessions,
}));

vi.mock('../../components/shared/ColumnCustomizer', () => ({
  ColumnCustomizer: () => null,
  useColumnConfig: (_key: string, defaultColumns: Array<Record<string, unknown>>) => ({
    columns: defaultColumns,
    setColumns: vi.fn(),
    visibleColumns: defaultColumns.filter((column) => column.visible),
    reset: vi.fn(),
  }),
}));

vi.mock('../../components/shared/CsvExport', () => ({
  CsvExport: () => <button type="button">Export</button>,
}));

vi.mock('../../components/shared/SearchInput', () => ({
  SearchInput: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
  }) => (
    <input
      aria-label={placeholder}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

vi.mock('../../components/ui/Select', () => ({
  Select: ({
    label,
    options,
    value,
    onChange,
  }: {
    label?: string;
    options: Array<{ value: string; label: string }>;
    value?: string;
    onChange?: (value: string) => void;
  }) => (
    <select aria-label={label} value={value} onChange={(event) => onChange?.(event.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

describe('SessionsExplorerTab quick filters', () => {
  beforeEach(() => {
    window.localStorage.removeItem('kore-preferences-storage');
    usePreferencesStore.setState({
      pinnedProjectIds: [],
      insightsAnalyticsFilters: DEFAULT_INSIGHTS_ANALYTICS_FILTERS,
      pendingSync: { pinnedProjectIds: false, filterSurfaces: [] },
      isLoading: false,
      hasAttemptedLoad: true,
    });
  });

  it('filters sessions by channel and environment', () => {
    render(
      <SessionsExplorerTab
        projectId="project-1"
        timeRange={{
          from: '2026-04-01T00:00:00.000Z',
          to: '2026-04-30T23:59:59.000Z',
        }}
      />,
    );

    expect(screen.getByText('Web Agent')).toBeInTheDocument();
    expect(screen.getByText('Voice Agent')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('analytics.sessions_explorer.channel_filter_label'), {
      target: { value: 'voice_pipeline' },
    });
    fireEvent.change(
      screen.getByLabelText('analytics.sessions_explorer.environment_filter_label'),
      {
        target: { value: 'staging' },
      },
    );

    expect(screen.queryByText('Web Agent')).not.toBeInTheDocument();
    expect(screen.getByText('Voice Agent')).toBeInTheDocument();
  });

  it('filters the visible window by last activity instead of created time', () => {
    render(
      <SessionsExplorerTab
        projectId="project-1"
        timeRange={{
          from: '2026-04-01T00:00:00.000Z',
          to: '2026-04-30T23:59:59.000Z',
        }}
      />,
    );

    expect(screen.getByText('Long Running Agent')).toBeInTheDocument();
  });
});
