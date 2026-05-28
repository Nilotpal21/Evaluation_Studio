import React from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const mockUseAnalyticsFlushStatus = vi.fn();

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    switch (key) {
      case 'title':
        return 'Analytics';
      case 'description':
        return 'Monitor event volume, LLM performance, and session metrics.';
      case 'tabs.overview':
        return 'Overview';
      case 'tabs.llm':
        return 'LLM Performance';
      case 'tabs.sessions_explorer':
        return 'Sessions Explorer';
      case 'tabs.traces_explorer':
        return 'Traces Explorer';
      case 'tabs.query':
        return 'Query';
      case 'live_sessions_notice.title':
        return 'Live sessions may still be flushing';
      case 'live_sessions_notice.body':
        return `live=${values?.liveSessionCount};unflushed=${values?.unflushedLiveSessionCount}`;
      case 'live_sessions_notice.pending_ids':
        return `Pending session IDs: ${values?.sessionIds}`;
      default:
        return key;
    }
  },
}));

vi.mock('next/dynamic', () => ({
  default: () => {
    const DynamicComponent = () => null;
    return DynamicComponent;
  },
}));

vi.mock('../../store/navigation-store', () => ({
  useNavigationStore: () => ({ projectId: 'project-1' }),
}));

vi.mock('../../hooks/useAnalytics', () => ({
  useAnalyticsFlushStatus: (...args: unknown[]) => mockUseAnalyticsFlushStatus(...args),
}));

vi.mock('../../components/analytics/SessionsExplorerTab', () => ({
  SessionsExplorerTab: () => null,
}));

vi.mock('../../components/analytics/TracesExplorerTab', () => ({
  TracesExplorerTab: () => null,
}));

vi.mock('../../components/analytics/QueryExplorerTab', () => ({
  QueryExplorerTab: () => null,
}));

import { AnalyticsPage } from '../../components/analytics/AnalyticsPage';

describe('AnalyticsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAnalyticsFlushStatus.mockReturnValue({
      liveSessionCount: 0,
      visibleLiveSessionCount: 0,
      unflushedLiveSessionCount: 0,
      pendingSessionIds: [],
      lastCheckedAt: null,
      isLoading: false,
      error: null,
    });
  });

  test('shows the live-session flush notice when runtime sessions are still pending', () => {
    mockUseAnalyticsFlushStatus.mockReturnValue({
      liveSessionCount: 3,
      visibleLiveSessionCount: 1,
      unflushedLiveSessionCount: 2,
      pendingSessionIds: ['sess-a', 'sess-b'],
      lastCheckedAt: '2026-04-22T12:00:00.000Z',
      isLoading: false,
      error: null,
    });

    render(<AnalyticsPage />);

    expect(screen.getByText('Live sessions may still be flushing')).toBeInTheDocument();
    expect(screen.getByText('live=3;unflushed=2')).toBeInTheDocument();
    expect(screen.getByText('Pending session IDs: sess-a, sess-b')).toBeInTheDocument();
  });

  test('hides the live-session flush notice when there are no live runtime sessions', () => {
    render(<AnalyticsPage />);

    expect(screen.queryByText('Live sessions may still be flushing')).not.toBeInTheDocument();
  });
});
