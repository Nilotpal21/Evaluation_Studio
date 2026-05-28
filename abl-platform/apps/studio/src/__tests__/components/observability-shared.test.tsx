/**
 * Observability Shared Component Tests
 *
 * Tests for TimeRangeSelector, SearchInput, CsvExport, Skeletons, and SpanTree.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { TimeRangeSelector, type TimeRange } from '../../components/shared/TimeRangeSelector';
import { SearchInput } from '../../components/shared/SearchInput';
import { CsvExport } from '../../components/shared/CsvExport';
import {
  TableSkeleton,
  TreeSkeleton,
  NodeDetailSkeleton,
  InlineSkeleton,
} from '../../components/shared/Skeletons';
import { SpanTree } from '../../components/observatory/SpanTree';
import type { SpanTreeNode, Span } from '../../types';

// ---------------------------------------------------------------------------
// Mock observatory store for SpanTree tests
// ---------------------------------------------------------------------------

const mockSelectSpan = vi.fn();
const mockGetSpanTree = vi.fn<() => SpanTreeNode[]>(() => []);

vi.mock('../../store/observatory-store', () => {
  const state = {
    getSpanTree: (...args: any[]) => mockGetSpanTree(...(args as [])),
    selectSpan: (...args: any[]) => mockSelectSpan(...(args as [])),
    selection: {
      executionNodeId: null as string | null,
      spanId: null as string | null,
    },
    spans: new Map<string, Span>(),
    events: [] as Array<{
      id: string;
      type: string;
      timestamp: Date;
      traceId: string;
      spanId: string;
      sessionId: string;
      agentName: string;
      data: Record<string, unknown>;
    }>,
  };
  const hook = (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state);
  hook.getState = () => state;
  hook.subscribe = () => () => {};
  return { useObservatoryStore: hook };
});

// Mock the analytics shared module used by SpanTree
vi.mock('../../components/analytics/shared', () => ({
  formatDuration: (ms: number) => `${ms}ms`,
  formatCost: (cost: number) => `$${cost.toFixed(4)}`,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTimeRange(preset: TimeRange['preset'] = '24h'): TimeRange {
  const end = new Date();
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  return { preset, start, end };
}

function makeSpan(overrides: Partial<Span> = {}): Span {
  return {
    spanId: 'span-1',
    traceId: 'trace-1',
    name: 'Agent Enter',
    startTime: new Date(),
    durationMs: 150,
    status: 'completed',
    agentName: 'test-agent',
    sessionId: 'sess-1',
    events: [],
    attributes: {},
    ...overrides,
  };
}

function makeSpanTreeNode(span: Span, children: SpanTreeNode[] = [], depth = 0): SpanTreeNode {
  return { span, children, depth };
}

// ---------------------------------------------------------------------------
// TimeRangeSelector
// ---------------------------------------------------------------------------

describe('TimeRangeSelector', () => {
  it('renders all preset buttons', () => {
    const onChange = vi.fn();
    render(<TimeRangeSelector value={makeTimeRange()} onChange={onChange} />);

    expect(screen.getByText('1h')).toBeInTheDocument();
    expect(screen.getByText('24h')).toBeInTheDocument();
    expect(screen.getByText('7d')).toBeInTheDocument();
    expect(screen.getByText('30d')).toBeInTheDocument();
    expect(screen.getByText('90d')).toBeInTheDocument();
  });

  it('calls onChange when a preset is clicked', () => {
    const onChange = vi.fn();
    render(<TimeRangeSelector value={makeTimeRange()} onChange={onChange} />);

    fireEvent.click(screen.getByText('7d'));
    expect(onChange).toHaveBeenCalledTimes(1);
    const arg = onChange.mock.calls[0][0] as TimeRange;
    expect(arg.preset).toBe('7d');
    expect(arg.start).toBeInstanceOf(Date);
    expect(arg.end).toBeInstanceOf(Date);
  });

  it('shows custom date picker when Custom is clicked', () => {
    const onChange = vi.fn();
    render(<TimeRangeSelector value={makeTimeRange()} onChange={onChange} />);

    // The "Custom" text comes from the i18n key observability.timeRange.custom
    fireEvent.click(screen.getByText('Custom'));
    // Custom picker should reveal From / To labels
    expect(screen.getByText('From')).toBeInTheDocument();
    expect(screen.getByText('To')).toBeInTheDocument();
  });

  it('does not call onChange when Custom is clicked (only opens picker)', () => {
    const onChange = vi.fn();
    render(<TimeRangeSelector value={makeTimeRange()} onChange={onChange} />);

    fireEvent.click(screen.getByText('Custom'));
    expect(onChange).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SearchInput
// ---------------------------------------------------------------------------

describe('SearchInput', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('renders with translated placeholder', () => {
    render(<SearchInput value="" onChange={vi.fn()} placeholder="Search..." />);
    expect(screen.getByPlaceholderText('Search...')).toBeInTheDocument();
  });

  it('shows clear button when value is non-empty', () => {
    render(<SearchInput value="hello" onChange={vi.fn()} placeholder="Search..." />);
    const input = screen.getByPlaceholderText('Search...');
    expect(input).toHaveValue('hello');
    // Clear button (X icon) should be present
    const clearBtn = screen.getByRole('button');
    expect(clearBtn).toBeInTheDocument();
  });

  it('calls onChange immediately when clear button is clicked', () => {
    const onChange = vi.fn();
    render(<SearchInput value="hello" onChange={onChange} placeholder="Search..." />);
    const clearBtn = screen.getByRole('button');
    fireEvent.click(clearBtn);
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('debounces onChange on text input', () => {
    const onChange = vi.fn();
    render(<SearchInput value="" onChange={onChange} placeholder="Search..." debounceMs={300} />);
    const input = screen.getByPlaceholderText('Search...');

    fireEvent.change(input, { target: { value: 'test' } });

    // Not called immediately (debounce)
    expect(onChange).not.toHaveBeenCalled();

    // Advance past debounce delay
    act(() => {
      vi.advanceTimersByTime(350);
    });

    expect(onChange).toHaveBeenCalledWith('test');

    vi.useRealTimers();
  });

  it('renders mode toggle when showModeToggle is true', () => {
    const onModeChange = vi.fn();
    render(
      <SearchInput
        value=""
        onChange={vi.fn()}
        placeholder="Search..."
        showModeToggle
        mode="fulltext"
        onModeChange={onModeChange}
      />,
    );

    expect(screen.getByText('Full text')).toBeInTheDocument();
    expect(screen.getByText('Metadata')).toBeInTheDocument();
  });

  it('calls onModeChange when mode button is clicked', () => {
    const onModeChange = vi.fn();
    render(
      <SearchInput
        value=""
        onChange={vi.fn()}
        placeholder="Search..."
        showModeToggle
        mode="fulltext"
        onModeChange={onModeChange}
      />,
    );

    fireEvent.click(screen.getByText('Metadata'));
    expect(onModeChange).toHaveBeenCalledWith('metadata');

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// CsvExport
// ---------------------------------------------------------------------------

describe('CsvExport', () => {
  it('renders export button with label', () => {
    render(<CsvExport onExport={vi.fn()} />);
    // Default label comes from i18n: observability.export.button -> "Export"
    expect(screen.getByRole('button', { name: /export/i })).toBeInTheDocument();
  });

  it('renders with custom label', () => {
    render(<CsvExport onExport={vi.fn()} label="Download CSV" />);
    expect(screen.getByRole('button', { name: /Download CSV/ })).toBeInTheDocument();
  });

  it('button is disabled when disabled prop is true', () => {
    render(<CsvExport onExport={vi.fn()} disabled />);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('calls onExport when clicked', async () => {
    const blob = new Blob(['a,b\n1,2'], { type: 'text/csv' });
    const onExport = vi.fn().mockResolvedValue(blob);

    render(<CsvExport onExport={onExport} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });

    expect(onExport).toHaveBeenCalledTimes(1);
  });

  it('shows error message when export fails', async () => {
    const onExport = vi.fn().mockRejectedValue(new Error('Network error'));

    render(<CsvExport onExport={onExport} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });

    expect(screen.getByText('Network error')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Skeletons
// ---------------------------------------------------------------------------

describe('Skeletons', () => {
  it('TableSkeleton renders shimmer elements for rows and cols', () => {
    const { container } = render(<TableSkeleton rows={3} cols={4} />);
    const shimmers = container.querySelectorAll('.animate-pulse');
    // header row (4 cols) + 3 data rows * 4 cols = 16 shimmer elements
    expect(shimmers.length).toBe(16);
  });

  it('TableSkeleton uses default rows=5 and cols=6', () => {
    const { container } = render(<TableSkeleton />);
    const shimmers = container.querySelectorAll('.animate-pulse');
    // header row (6 cols) + 5 data rows * 6 cols = 36 shimmer elements
    expect(shimmers.length).toBe(36);
  });

  it('TreeSkeleton renders shimmer elements for specified depth', () => {
    const { container } = render(<TreeSkeleton depth={5} />);
    const shimmers = container.querySelectorAll('.animate-pulse');
    // Each row has 4 shimmer divs (circle + 3 bars) = 5 * 4 = 20
    expect(shimmers.length).toBe(20);
  });

  it('NodeDetailSkeleton renders shimmer elements', () => {
    const { container } = render(<NodeDetailSkeleton />);
    const shimmers = container.querySelectorAll('.animate-pulse');
    // title (1) + 4 grid items (label + value each = 8) + 2 bottom bars = 11
    expect(shimmers.length).toBeGreaterThan(0);
  });

  it('InlineSkeleton renders a single inline shimmer', () => {
    const { container } = render(<InlineSkeleton width="w-32" />);
    const shimmers = container.querySelectorAll('.animate-pulse');
    expect(shimmers.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// SpanTree
// ---------------------------------------------------------------------------

describe('SpanTree', () => {
  beforeEach(() => {
    mockGetSpanTree.mockReset();
    mockSelectSpan.mockReset();
  });

  it('renders empty state when no spans', () => {
    mockGetSpanTree.mockReturnValue([]);
    render(<SpanTree />);
    expect(screen.getByText('No spans recorded yet.')).toBeInTheDocument();
  });

  it('renders span rows for provided spans', () => {
    const span = makeSpan({ name: 'Root Agent' });
    mockGetSpanTree.mockReturnValue([makeSpanTreeNode(span)]);
    render(<SpanTree />);
    expect(screen.getByText('Root Agent')).toBeInTheDocument();
  });

  it('renders nested children', () => {
    const parent = makeSpan({ spanId: 'p1', name: 'Parent' });
    const child = makeSpan({ spanId: 'c1', name: 'Child', parentSpanId: 'p1' });
    const tree: SpanTreeNode[] = [makeSpanTreeNode(parent, [makeSpanTreeNode(child, [], 1)], 0)];
    mockGetSpanTree.mockReturnValue(tree);
    render(<SpanTree />);
    expect(screen.getByText('Parent')).toBeInTheDocument();
    expect(screen.getByText('Child')).toBeInTheDocument();
  });

  it('displays event count for spans', () => {
    const span = makeSpan({
      events: [
        {
          id: 'e1',
          type: 'llm_call',
          timestamp: new Date(),
          traceId: 'trace-1',
          spanId: 'span-1',
          sessionId: 'sess-1',
          agentName: 'test-agent',
          data: {},
        },
        {
          id: 'e2',
          type: 'tool_call',
          timestamp: new Date(),
          traceId: 'trace-1',
          spanId: 'span-1',
          sessionId: 'sess-1',
          agentName: 'test-agent',
          data: {},
        },
      ],
    });
    mockGetSpanTree.mockReturnValue([makeSpanTreeNode(span)]);
    render(<SpanTree />);
    expect(screen.getByText('2 events')).toBeInTheDocument();
  });

  it('displays duration when available', () => {
    const span = makeSpan({ durationMs: 250 });
    mockGetSpanTree.mockReturnValue([makeSpanTreeNode(span)]);
    render(<SpanTree />);
    expect(screen.getByText('250ms')).toBeInTheDocument();
  });

  it('has tree role for accessibility', () => {
    const span = makeSpan();
    mockGetSpanTree.mockReturnValue([makeSpanTreeNode(span)]);
    render(<SpanTree />);
    expect(screen.getByRole('tree')).toBeInTheDocument();
  });
});
