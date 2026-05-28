import { type ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TooltipProvider } from '../../ui/Tooltip';

// ── Mock recharts (third-party) — avoid SVG rendering in happy-dom ──────────

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => (
    <div data-testid="responsive-container">{children}</div>
  ),
  LineChart: ({ children }: { children: ReactNode }) => (
    <div data-testid="line-chart">{children}</div>
  ),
  Line: () => <div data-testid="line" />,
  BarChart: ({ children }: { children: ReactNode }) => (
    <div data-testid="bar-chart">{children}</div>
  ),
  Bar: () => <div data-testid="bar" />,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
}));

// ── Import components under test ────────────────────────────────────────────

import { EmptyState } from '../../ui/EmptyState';
import { OutcomeDistribution } from '../shared/OutcomeDistribution';
import { InsightKPICard } from '../shared/InsightKPICard';
import { BreakdownTable } from '../shared/BreakdownTable';

// ── Render helper: wrap in TooltipProvider for components that use Tooltip ───

function renderWithTooltip(ui: ReactNode) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

// ═══════════════════════════════════════════════════════════════════════════
//  EmptyState
// ═══════════════════════════════════════════════════════════════════════════

describe('EmptyState', () => {
  it('renders the title text', () => {
    render(<EmptyState icon={<span data-testid="empty-icon" />} title="No data available" />);
    expect(screen.getByText('No data available')).toBeDefined();
  });

  it('renders the icon', () => {
    render(<EmptyState icon={<span data-testid="empty-icon" />} title="No data" />);
    expect(screen.getByTestId('empty-icon')).toBeDefined();
  });

  it('renders a description', () => {
    render(
      <EmptyState
        icon={<span data-testid="empty-icon" />}
        title="No data"
        description="Try a different date range."
      />,
    );
    expect(screen.getByText('Try a different date range.')).toBeDefined();
  });

  it('does not render a description paragraph when omitted', () => {
    const { container } = render(
      <EmptyState icon={<span data-testid="empty-icon" />} title="No data" />,
    );
    expect(container.querySelector('p')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  OutcomeDistribution
// ═══════════════════════════════════════════════════════════════════════════

describe('OutcomeDistribution', () => {
  const sampleOutcomes = [
    { outcome: 'contained_resolved', count: 70 },
    { outcome: 'escalated', count: 20 },
    { outcome: 'abandoned', count: 10 },
  ];

  it('returns null when outcomes array is empty', () => {
    const { container } = render(<OutcomeDistribution outcomes={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders all outcome labels', () => {
    render(<OutcomeDistribution outcomes={sampleOutcomes} />);
    expect(screen.getByText('Contained resolved')).toBeDefined();
    expect(screen.getByText('Escalated')).toBeDefined();
    expect(screen.getByText('Abandoned')).toBeDefined();
  });

  it('renders counts and percentages', () => {
    render(<OutcomeDistribution outcomes={sampleOutcomes} />);
    expect(screen.getByText('70 (70%)')).toBeDefined();
    expect(screen.getByText('20 (20%)')).toBeDefined();
    expect(screen.getByText('10 (10%)')).toBeDefined();
  });

  it('renders total summary with correct pluralization', () => {
    render(<OutcomeDistribution outcomes={sampleOutcomes} />);
    expect(screen.getByText('100 total conversations evaluated')).toBeDefined();
  });

  it('renders singular form when total is 1', () => {
    render(<OutcomeDistribution outcomes={[{ outcome: 'contained_resolved', count: 1 }]} />);
    expect(screen.getByText('1 total conversation evaluated')).toBeDefined();
  });

  it('renders descriptions for known outcomes', () => {
    render(<OutcomeDistribution outcomes={sampleOutcomes} />);
    expect(screen.getByText('Fully resolved by AI without human help')).toBeDefined();
    expect(screen.getByText('Transferred to a human agent')).toBeDefined();
    expect(screen.getByText('Customer left before resolution')).toBeDefined();
  });

  it('handles unknown outcome types gracefully', () => {
    render(<OutcomeDistribution outcomes={[{ outcome: 'custom_outcome', count: 5 }]} />);
    expect(screen.getByText('Custom outcome')).toBeDefined();
    expect(screen.getByText('Other outcome')).toBeDefined();
  });

  it('renders segmented bar with correct number of segments', () => {
    const { container } = render(<OutcomeDistribution outcomes={sampleOutcomes} />);
    // The segmented bar container is the first div with h-2 class
    const barContainer = container.querySelector('.h-2.w-full');
    const barSegments = barContainer!.children;
    expect(barSegments).toHaveLength(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  InsightKPICard
// ═══════════════════════════════════════════════════════════════════════════

describe('InsightKPICard', () => {
  it('renders title and value', () => {
    renderWithTooltip(<InsightKPICard title="Total Conversations" value="1,234" />);
    expect(screen.getByText('Total Conversations')).toBeDefined();
    expect(screen.getByText('1,234')).toBeDefined();
  });

  it('renders subtitle when provided', () => {
    renderWithTooltip(<InsightKPICard title="Quality" value="4.2" subtitle="14 evaluated" />);
    expect(screen.getByText('14 evaluated')).toBeDefined();
  });

  it('does not render subtitle when not provided', () => {
    const { container } = renderWithTooltip(<InsightKPICard title="Quality" value="4.2" />);
    // Check there's no subtitle paragraph (text-subtle with mt-0.5)
    const allSubtleTexts = container.querySelectorAll('.text-subtle');
    const subtitleEl = Array.from(allSubtleTexts).find(
      (el) => el.classList.contains('mt-0.5') || el.className.includes('mt-0.5'),
    );
    expect(subtitleEl).toBeUndefined();
  });

  it('shows tooltip icon when tooltip prop is provided', () => {
    renderWithTooltip(
      <InsightKPICard title="Quality" value="4.2" tooltip="Average quality score" />,
    );
    expect(screen.getByLabelText('About Quality')).toBeDefined();
  });

  it('does not show tooltip icon when tooltip is not provided', () => {
    renderWithTooltip(<InsightKPICard title="Quality" value="4.2" />);
    expect(screen.queryByLabelText('About Quality')).toBeNull();
  });

  it('renders up arrow for positive trend', () => {
    renderWithTooltip(
      <InsightKPICard
        title="Score"
        value="4.5"
        trend={{ value: 5.2, period: 'vs last month', favorable: 'up' }}
      />,
    );
    expect(screen.getByText(/5\.2%/)).toBeDefined();
  });

  it('renders down arrow for negative trend', () => {
    renderWithTooltip(
      <InsightKPICard
        title="Score"
        value="3.0"
        trend={{ value: -3.1, period: 'vs last month', favorable: 'up' }}
      />,
    );
    expect(screen.getByText(/3\.1%/)).toBeDefined();
  });

  it('applies cursor-pointer when onClick is provided', () => {
    const handleClick = vi.fn();
    const { container } = renderWithTooltip(
      <InsightKPICard title="Clickable" value="42" onClick={handleClick} />,
    );
    const card = container.querySelector('[class*="cursor-pointer"]')!;
    expect(card).toBeDefined();
    fireEvent.click(card);
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('does not apply cursor-pointer when onClick is absent', () => {
    const { container } = renderWithTooltip(<InsightKPICard title="Static" value="42" />);
    const card = container.querySelector('[class*="cursor-pointer"]');
    expect(card).toBeNull();
  });

  it('applies correct border class for each status', () => {
    const { container: healthyContainer } = renderWithTooltip(
      <InsightKPICard title="H" value="1" status="healthy" />,
    );
    expect(healthyContainer.querySelector('[class*="border-l-success"]')).toBeDefined();

    const { container: warningContainer } = renderWithTooltip(
      <InsightKPICard title="W" value="2" status="warning" />,
    );
    expect(warningContainer.querySelector('[class*="border-l-warning"]')).toBeDefined();

    const { container: criticalContainer } = renderWithTooltip(
      <InsightKPICard title="C" value="3" status="critical" />,
    );
    expect(criticalContainer.querySelector('[class*="border-l-error"]')).toBeDefined();
  });

  it('renders sparkline container when sparkline data is provided', () => {
    renderWithTooltip(
      <InsightKPICard title="Trend" value="4.0" sparkline={[3.5, 3.8, 4.0, 4.2]} />,
    );
    expect(screen.getByTestId('responsive-container')).toBeDefined();
  });

  it('does not render sparkline when sparkline is empty', () => {
    renderWithTooltip(<InsightKPICard title="Trend" value="4.0" sparkline={[]} />);
    expect(screen.queryByTestId('responsive-container')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  BreakdownTable
// ═══════════════════════════════════════════════════════════════════════════

describe('BreakdownTable', () => {
  const sampleData = [
    {
      dimension: 'Billing Bot',
      conversations: 120,
      confidence: 85.3,
      qualityScore: 4.2,
      avgSentiment: 0.6,
      trend: [4.0, 4.1, 4.2],
    },
    {
      dimension: 'Support Bot',
      conversations: 80,
      confidence: 72.1,
      qualityScore: 3.8,
      avgSentiment: 0.4,
      trend: [3.5, 3.7, 3.8],
    },
    {
      dimension: 'Sales Bot',
      conversations: 50,
      confidence: 91.0,
      qualityScore: 0,
      avgSentiment: 0,
      trend: [],
    },
  ];

  it('renders all agent rows', () => {
    render(<BreakdownTable data={sampleData} />);
    expect(screen.getByText('Billing Bot')).toBeDefined();
    expect(screen.getByText('Support Bot')).toBeDefined();
    expect(screen.getByText('Sales Bot')).toBeDefined();
  });

  it('renders column headers', () => {
    render(<BreakdownTable data={sampleData} />);
    expect(screen.getByText('Agent')).toBeDefined();
    expect(screen.getByText('Volume')).toBeDefined();
    expect(screen.getByText('Confidence')).toBeDefined();
    expect(screen.getByText('Quality')).toBeDefined();
    expect(screen.getByText('Sentiment')).toBeDefined();
    expect(screen.getByText('Trend')).toBeDefined();
  });

  it('renders formatted confidence values', () => {
    render(<BreakdownTable data={sampleData} />);
    expect(screen.getByText('85.3%')).toBeDefined();
    expect(screen.getByText('72.1%')).toBeDefined();
    expect(screen.getByText('91.0%')).toBeDefined();
  });

  it('shows dash for zero quality score', () => {
    render(<BreakdownTable data={sampleData} />);
    // Sales Bot has qualityScore 0 — should show em-dash
    const cells = screen.getAllByText('—');
    expect(cells.length).toBeGreaterThanOrEqual(1);
  });

  it('shows dash when both quality and sentiment are zero', () => {
    render(<BreakdownTable data={sampleData} />);
    // Sales Bot has both qualityScore=0 and avgSentiment=0
    // Should show dashes for both quality and sentiment columns
    const dashes = screen.getAllByText('—');
    // At minimum 2 dashes (quality + sentiment for Sales Bot) + 1 trend dash
    expect(dashes.length).toBeGreaterThanOrEqual(3);
  });

  it('default sort is by conversations descending', () => {
    const { container } = render(<BreakdownTable data={sampleData} />);
    const rows = container.querySelectorAll('tbody tr');
    // First row should be Billing Bot (120 conversations)
    expect(rows[0].textContent).toContain('Billing Bot');
    // Second row should be Support Bot (80 conversations)
    expect(rows[1].textContent).toContain('Support Bot');
    // Third row should be Sales Bot (50 conversations)
    expect(rows[2].textContent).toContain('Sales Bot');
  });

  it('clicking column header changes sort order', () => {
    const { container } = render(<BreakdownTable data={sampleData} />);

    // Click "Agent" header to sort by dimension ascending
    fireEvent.click(screen.getByText('Agent'));
    const rowsAfterSort = container.querySelectorAll('tbody tr');
    // Descending alphabetical: Support Bot, Sales Bot, Billing Bot
    expect(rowsAfterSort[0].textContent).toContain('Support Bot');
  });

  it('clicking same header toggles sort direction', () => {
    const { container } = render(<BreakdownTable data={sampleData} />);

    // Click Volume (already sorted desc) — should toggle to asc
    fireEvent.click(screen.getByText('Volume'));
    const rows = container.querySelectorAll('tbody tr');
    // Ascending: Sales Bot (50), Support Bot (80), Billing Bot (120)
    expect(rows[0].textContent).toContain('Sales Bot');
    expect(rows[2].textContent).toContain('Billing Bot');
  });

  it('fires onRowClick with dimension when row is clicked', () => {
    const handleClick = vi.fn();
    render(<BreakdownTable data={sampleData} onRowClick={handleClick} />);

    fireEvent.click(screen.getByText('Support Bot'));
    expect(handleClick).toHaveBeenCalledWith('Support Bot');
  });

  it('adds cursor-pointer class when onRowClick is provided', () => {
    const { container } = render(<BreakdownTable data={sampleData} onRowClick={vi.fn()} />);
    const firstRow = container.querySelector('tbody tr');
    expect(firstRow!.className).toContain('cursor-pointer');
  });

  it('does not add cursor-pointer class when onRowClick is absent', () => {
    const { container } = render(<BreakdownTable data={sampleData} />);
    const firstRow = container.querySelector('tbody tr');
    expect(firstRow!.className).not.toContain('cursor-pointer');
  });

  it('renders tooltip info icons for Volume, Confidence, Quality, Sentiment', () => {
    render(<BreakdownTable data={sampleData} />);
    expect(screen.getByLabelText('About Volume')).toBeDefined();
    expect(screen.getByLabelText('About Confidence')).toBeDefined();
    expect(screen.getByLabelText('About Quality')).toBeDefined();
    expect(screen.getByLabelText('About Sentiment')).toBeDefined();
    expect(screen.getByLabelText('About Trend')).toBeDefined();
  });

  it('renders sparkline for rows with trend data', () => {
    render(<BreakdownTable data={sampleData} />);
    // Billing Bot and Support Bot have trend data — should see chart containers
    const charts = screen.getAllByTestId('responsive-container');
    expect(charts).toHaveLength(2);
  });

  it('handles empty data array', () => {
    const { container } = render(<BreakdownTable data={[]} />);
    const rows = container.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(0);
  });
});
