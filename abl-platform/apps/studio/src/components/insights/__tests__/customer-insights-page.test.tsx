import { type ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const mockUseCustomerInsights = vi.fn();
const mockUpdateFilters = vi.fn();

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => (
    <div data-testid="responsive-container">{children}</div>
  ),
  AreaChart: ({ children }: { children: ReactNode }) => (
    <div data-testid="area-chart">{children}</div>
  ),
  Area: ({ name, stroke }: { name?: string; stroke?: string }) => (
    <div data-testid="area-series" data-stroke={stroke}>
      {name}
    </div>
  ),
  Line: ({ name, stroke }: { name?: string; stroke?: string }) => (
    <div data-testid="line-series" data-stroke={stroke}>
      {name}
    </div>
  ),
  XAxis: () => null,
  YAxis: ({ yAxisId }: { yAxisId?: string }) => <div data-testid="y-axis" data-axis-id={yAxisId} />,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
}));

vi.mock('../../../hooks/useCustomerInsights', () => ({
  useCustomerInsights: (...args: unknown[]) => mockUseCustomerInsights(...args),
}));

vi.mock('../../../hooks/usePersistedSurfaceFilters', () => ({
  usePersistedSurfaceFilters: () => ({
    state: { dateRange: '7d' },
    updateState: mockUpdateFilters,
  }),
}));

import { CustomerInsightsPage } from '../CustomerInsightsPage';

describe('CustomerInsightsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseCustomerInsights.mockReturnValue({
      totalConversations: 89,
      intentConversationCount: 39,
      sentimentConversationCount: 89,
      uniqueIntents: 6,
      avgSentiment: 0.27,
      frustrationRate: 50.6,
      resolutionRate: 5.6,
      evaluatedCount: 36,
      intentDistribution: [
        {
          intent: 'account_balance_inquiry',
          count: 21,
          confidence: 0.955,
          resolutionRate: 0.1,
          partialRate: 0,
          evaluatedCount: 21,
        },
      ],
      sentimentTrajectory: { improving: 34, stable: 31, declining: 24, total: 89 },
      dailyTrend: [
        {
          day: '2026-05-04',
          conversations: 89,
          intentConversations: 39,
          sentimentConversations: 89,
          avgSentiment: 0.1,
          frustratedCount: 1,
          uniqueIntents: 2,
          avgConfidence: 0.95,
          resolutionRate: 5.6,
          partialRate: 0,
        },
      ],
      topIntents: [
        {
          intent: 'account_balance_inquiry',
          volume: 21,
          confidence: 0.955,
          resolutionRate: 0.1,
          partialRate: 0,
          evaluatedCount: 21,
        },
      ],
      isLoading: false,
      error: null,
      projectId: 'proj-1',
    });
  });

  test('renders explicit sentiment and intent pipeline populations', () => {
    render(<CustomerInsightsPage />);

    expect(screen.getByText('Analyzed Conversations')).toBeInTheDocument();
    expect(screen.getByText('39 intent · 89 sentiment')).toBeInTheDocument();
    expect(screen.getByText(/89 analyzed conversations/)).toBeInTheDocument();
    expect(screen.getAllByText(/39 intent-classified/)).toHaveLength(2);
    expect(screen.getByText(/89 sentiment-scored/)).toBeInTheDocument();
    expect(
      screen.getByText(/21 classified intent assignments across 1 intent/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Resolution rate based on 36 of 39 intent-classified conversations/),
    ).toBeInTheDocument();
  });

  test('renders trend series on separate volume and rate axes', () => {
    render(<CustomerInsightsPage />);

    const axisIds = screen.getAllByTestId('y-axis').map((node) => node.dataset.axisId);
    expect(axisIds).toEqual(expect.arrayContaining(['volume', 'rate']));
    const areaSeries = screen.getAllByTestId('area-series').map((node) => node.textContent);
    const lineSeries = screen.getAllByTestId('line-series').map((node) => node.textContent);
    expect(areaSeries).toEqual(['Intent Classified', 'Sentiment Scored']);
    expect(lineSeries).toEqual(['Sentiment Index', 'Confidence', 'Resolution Rate']);
  });

  test('all chart series have unique stroke colors', () => {
    render(<CustomerInsightsPage />);

    const areaStrokes = screen
      .getAllByTestId('area-series')
      .map((node) => node.dataset.stroke)
      .filter(Boolean) as string[];
    const lineStrokes = screen
      .getAllByTestId('line-series')
      .map((node) => node.dataset.stroke)
      .filter(Boolean) as string[];
    const allStrokes = [...areaStrokes, ...lineStrokes];
    const uniqueStrokes = new Set(allStrokes);
    expect(uniqueStrokes.size).toBe(allStrokes.length);
  });

  test('hides avg sentiment and frustration values when sentimentConversationCount is 0', () => {
    mockUseCustomerInsights.mockReturnValue({
      ...mockUseCustomerInsights(),
      avgSentiment: 0,
      frustrationRate: 0,
      sentimentConversationCount: 0,
    });
    render(<CustomerInsightsPage />);
    // Formatted values must not appear — pipeline has not run
    expect(screen.queryByText('0.00')).not.toBeInTheDocument();
    expect(screen.queryByText('0.0%')).not.toBeInTheDocument();
  });

  test('shows 0.00 and 0.0% when sentiment pipeline ran and both values are genuinely zero', () => {
    mockUseCustomerInsights.mockReturnValue({
      ...mockUseCustomerInsights(),
      avgSentiment: 0,
      frustrationRate: 0,
      sentimentConversationCount: 50,
    });
    render(<CustomerInsightsPage />);
    // Pipeline ran with 50 scored conversations — zero is a real result, not missing data
    expect(screen.getByText('0.00')).toBeInTheDocument();
    expect(screen.getByText('0.0%')).toBeInTheDocument();
  });
});
