import React from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { SessionListItem } from '../../types';
import type { SessionTrace } from '../../hooks/useSessionTraces';

const mockUseAnalyticsSessions = vi.fn();
const mockUseAnalyticsGenerations = vi.fn();
const mockUseSessionTraces = vi.fn();

vi.mock('../../hooks/useAnalytics', () => ({
  useAnalyticsSessions: (...args: unknown[]) => mockUseAnalyticsSessions(...args),
  useAnalyticsGenerations: (...args: unknown[]) => mockUseAnalyticsGenerations(...args),
}));

vi.mock('../../hooks/useSessionTraces', () => ({
  useSessionTraces: (...args: unknown[]) => mockUseSessionTraces(...args),
}));

import { TracesExplorerTab } from '../../components/analytics/TracesExplorerTab';

function makeSession(overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id: 'session-1',
    agentId: 'agent-1',
    agentName: 'Travel Agent',
    status: 'completed',
    durationMs: 900,
    messageCount: 3,
    traceEventCount: 4,
    tokenCount: 0,
    estimatedCost: 0,
    errorCount: 0,
    createdAt: '2026-03-22T00:00:00.000Z',
    lastActivityAt: '2026-03-22T00:15:00.000Z',
    ...overrides,
  };
}

function makeTrace(overrides: Partial<SessionTrace> = {}): SessionTrace {
  return {
    id: 'trace-1',
    event_type: 'llm_call',
    timestamp: '2026-03-22T00:00:00.000Z',
    duration_ms: 50,
    agent_name: 'planner',
    data: {},
    ...overrides,
  };
}

describe('TracesExplorerTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockUseAnalyticsSessions.mockReturnValue({
      sessions: [makeSession()],
      total: 1,
      isLoading: false,
    });
    mockUseAnalyticsGenerations.mockReturnValue({
      generations: [],
      total: 0,
      isLoading: false,
      error: null,
    });

    mockUseSessionTraces.mockReturnValue({
      traces: [
        makeTrace({
          id: 'evt-root',
          event_type: 'agent_enter',
          span_id: 'span-root',
          timestamp: '2026-03-22T00:00:00.000Z',
          duration_ms: 400,
          agent_name: 'planner',
        }),
        makeTrace({
          id: 'evt-step-enter',
          event_type: 'flow_step_enter',
          span_id: 'span-step',
          parent_span_id: 'span-root',
          timestamp: '2026-03-22T00:00:00.050Z',
          duration_ms: 50,
          agent_name: 'planner',
          data: {
            stepName: 'collect_destination',
          },
        }),
        makeTrace({
          id: 'evt-step-llm-1',
          event_type: 'llm_call',
          span_id: 'span-step',
          parent_span_id: 'span-root',
          timestamp: '2026-03-22T00:00:00.120Z',
          duration_ms: 80,
          agent_name: 'planner',
          data: {
            model: 'gpt-4.1',
            promptTokens: 10,
            completionTokens: 4,
            cost: 0.03,
          },
        }),
        makeTrace({
          id: 'evt-step-llm-2',
          event_type: 'llm_call',
          span_id: 'span-step',
          parent_span_id: 'span-root',
          timestamp: '2026-03-22T00:00:00.220Z',
          duration_ms: 40,
          agent_name: 'planner',
          data: {
            model: 'gpt-4.1',
            promptTokens: 2,
            completionTokens: 1,
            cost: 0.01,
          },
        }),
      ],
      total: 4,
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    });
  });

  test('groups repeated span events and keeps selection visible when collapsing a branch', () => {
    render(
      <TracesExplorerTab
        projectId="proj-travel"
        timeRange={{
          from: '2026-03-21T00:00:00.000Z',
          to: '2026-03-23T00:00:00.000Z',
        }}
        initialSessionId="session-1"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Waterfall' }));

    expect(screen.getAllByText('Flow Step Enter')).toHaveLength(1);
    expect(screen.getByText('Agent Enter')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Flow Step Enter'));

    expect(screen.getByText('span-step')).toBeInTheDocument();
    expect(screen.getAllByText(/collect_destination/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('$0.0400').length).toBeGreaterThanOrEqual(1);

    fireEvent.click(screen.getByRole('button', { name: 'Collapse span children' }));

    expect(screen.queryByText('Flow Step Enter')).not.toBeInTheDocument();
    expect(screen.getByText('span-root')).toBeInTheDocument();
  });

  test('keeps selected waterfall details collapsed until explicitly expanded', () => {
    render(
      <TracesExplorerTab
        projectId="proj-travel"
        timeRange={{
          from: '2026-03-21T00:00:00.000Z',
          to: '2026-03-23T00:00:00.000Z',
        }}
        initialSessionId="session-1"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Waterfall' }));
    fireEvent.click(screen.getByText('Flow Step Enter'));

    expect(screen.getByText('Show details')).toBeInTheDocument();
    expect(screen.queryByText('Parent Span')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Show details'));
    expect(screen.getByText('Parent Span')).toBeInTheDocument();
  });
});
