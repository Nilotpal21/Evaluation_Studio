/**
 * Tests for SourcesTable search filtering and SourceFilterBar sourceId visual state.
 *
 * @vitest-environment happy-dom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { SearchAISource } from '../../api/search-ai';

// ---------------------------------------------------------------------------
// Mock lucide-react
// ---------------------------------------------------------------------------

vi.mock('lucide-react', () => {
  const n = () => null;
  return {
    Search: n,
    Upload: n,
    Eye: n,
    Trash2: n,
    Plus: n,
    AlertTriangle: n,
    X: n,
    ChevronUp: n,
    ChevronDown: n,
    ChevronsUpDown: n,
    LayoutGrid: n,
    List: n,
    Pause: n,
    Play: n,
    RefreshCw: n,
    KeyRound: n,
    Calendar: n,
    Download: n,
    MoreHorizontal: n,
    FileText: n,
    ChevronLeft: n,
    ChevronRight: n,
    RotateCcw: n,
    Globe: n,
    Clock: n,
    Activity: n,
    Layers: n,
  };
});

// ---------------------------------------------------------------------------
// Mock SWR
// ---------------------------------------------------------------------------

vi.mock('swr', () => ({
  default: vi.fn(() => ({
    data: undefined,
    error: undefined,
    isLoading: false,
    mutate: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Mock API layer
// ---------------------------------------------------------------------------

vi.mock('../../api/search-ai', () => ({
  fetchEnterpriseConnectors: vi.fn().mockResolvedValue({ data: { connectors: [] } }),
  deleteSource: vi.fn(),
  renameSource: vi.fn(),
  updateCitationConfig: vi.fn().mockResolvedValue({}),
}));

// ---------------------------------------------------------------------------
// Mock framer-motion (SourceDetailPanel may use it)
// ---------------------------------------------------------------------------

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: {
    div: ({ children, ...props }: Record<string, unknown>) => {
      const { initial, animate, exit, transition, ...rest } = props;
      return (
        <div {...(rest as React.HTMLAttributes<HTMLDivElement>)}>{children as React.ReactNode}</div>
      );
    },
  },
}));

vi.mock('../../lib/animation', () => ({
  springs: { snappy: {}, gentle: {} },
  transitions: { slideRight: {}, backdrop: {} },
}));

// ---------------------------------------------------------------------------
// Mock panels (we don't test panel behavior here)
// ---------------------------------------------------------------------------

vi.mock('../../components/search-ai/ConnectorDetailPanel', () => ({
  ConnectorDetailPanel: () => null,
}));

vi.mock('../../components/search-ai/data/SourceDetailPanel', () => ({
  SourceDetailPanel: () => null,
}));

// ---------------------------------------------------------------------------
// Mock sanitize-error
// ---------------------------------------------------------------------------

vi.mock('@/lib/sanitize-error', () => ({
  sanitizeError: (_e: unknown, f: string) => f,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { SourcesTable } from '../../components/search-ai/data/SourcesTable';
import { SourceFilterBar } from '../../components/search-ai/data/SourceFilterBar';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSources(names: string[], types?: string[]): SearchAISource[] {
  return names.map((name, i) => ({
    _id: `src-${i}`,
    tenantId: 't-1',
    indexId: 'idx-1',
    name,
    sourceType: types?.[i] ?? 'file',
    sourceConfig: {},
    status: 'active',
    extractionConfig: null,
    enrichmentConfig: null,
    syncSchedule: null,
    documentCount: 10 + i,
    lastSyncAt: null,
    syncError: null,
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-17T00:00:00Z',
  }));
}

// ===========================================================================
// SourcesTable Search
// ===========================================================================

describe('SourcesTable search', () => {
  const onRefresh = vi.fn();
  const onViewDocuments = vi.fn();
  const onUploadToSource = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Force table view mode (component defaults to card view for <=6 sources)
    localStorage.setItem('sp-sources-view-mode', 'table');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders search input above the table', () => {
    const sources = makeSources(['Alpha Source', 'Beta Source']);
    render(
      <SourcesTable
        indexId="idx-1"
        sources={sources}
        onRefresh={onRefresh}
        onViewDocuments={onViewDocuments}
        onUploadToSource={onUploadToSource}
      />,
    );

    expect(screen.getByPlaceholderText('Search sources...')).toBeInTheDocument();
  });

  it('filters sources by name (case-insensitive) after debounce', () => {
    const sources = makeSources(['Alpha Source', 'Beta Source', 'Gamma Source']);
    render(
      <SourcesTable
        indexId="idx-1"
        sources={sources}
        onRefresh={onRefresh}
        onViewDocuments={onViewDocuments}
        onUploadToSource={onUploadToSource}
      />,
    );

    // All sources visible initially
    expect(screen.getByText('Alpha Source')).toBeInTheDocument();
    expect(screen.getByText('Beta Source')).toBeInTheDocument();
    expect(screen.getByText('Gamma Source')).toBeInTheDocument();

    // Type search query
    const input = screen.getByPlaceholderText('Search sources...');
    fireEvent.change(input, { target: { value: 'alpha' } });

    // Debounce hasn't fired yet — all still visible
    expect(screen.getByText('Beta Source')).toBeInTheDocument();

    // Advance timers for debounce
    act(() => {
      vi.advanceTimersByTime(300);
    });

    // Now only Alpha should remain
    expect(screen.getByText('Alpha Source')).toBeInTheDocument();
    expect(screen.queryByText('Beta Source')).not.toBeInTheDocument();
    expect(screen.queryByText('Gamma Source')).not.toBeInTheDocument();
  });

  it('shows empty state when search has no matches', () => {
    const sources = makeSources(['Alpha Source', 'Beta Source']);
    render(
      <SourcesTable
        indexId="idx-1"
        sources={sources}
        onRefresh={onRefresh}
        onViewDocuments={onViewDocuments}
        onUploadToSource={onUploadToSource}
      />,
    );

    const input = screen.getByPlaceholderText('Search sources...');
    fireEvent.change(input, { target: { value: 'nonexistent' } });
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(screen.getByText(/No sources matching/)).toBeInTheDocument();
  });

  it('health summary uses FULL source list, not filtered', () => {
    const sources = makeSources(['Alpha Source', 'Beta Source', 'Gamma Source']);
    render(
      <SourcesTable
        indexId="idx-1"
        sources={sources}
        onRefresh={onRefresh}
        onViewDocuments={onViewDocuments}
        onUploadToSource={onUploadToSource}
      />,
    );

    // Health bar shows total of 3
    expect(screen.getByText(/Total: 3 sources/)).toBeInTheDocument();

    // Filter to 1 source
    const input = screen.getByPlaceholderText('Search sources...');
    fireEvent.change(input, { target: { value: 'alpha' } });
    act(() => {
      vi.advanceTimersByTime(300);
    });

    // Health bar STILL shows 3 (full list)
    expect(screen.getByText(/Total: 3 sources/)).toBeInTheDocument();
  });

  it('empty search shows all sources', () => {
    const sources = makeSources(['Alpha Source', 'Beta Source']);
    render(
      <SourcesTable
        indexId="idx-1"
        sources={sources}
        onRefresh={onRefresh}
        onViewDocuments={onViewDocuments}
        onUploadToSource={onUploadToSource}
      />,
    );

    const input = screen.getByPlaceholderText('Search sources...');

    // Filter first
    fireEvent.change(input, { target: { value: 'alpha' } });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByText('Beta Source')).not.toBeInTheDocument();

    // Clear search
    fireEvent.change(input, { target: { value: '' } });
    act(() => {
      vi.advanceTimersByTime(300);
    });

    // Both visible again
    expect(screen.getByText('Alpha Source')).toBeInTheDocument();
    expect(screen.getByText('Beta Source')).toBeInTheDocument();
  });
});

// ===========================================================================
// SourceFilterBar — sourceId visual state
// ===========================================================================

describe('SourceFilterBar sourceId visual state', () => {
  const onFilterChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not highlight "All" when activeSourceId is set', () => {
    const sources = makeSources(['Source A', 'Source B']);
    render(
      <SourceFilterBar
        sources={sources}
        activeFilter={null}
        onFilterChange={onFilterChange}
        activeSourceId="src-0"
      />,
    );

    const allButton = screen.getByText('All').closest('button')!;
    expect(allButton.className).not.toContain('ring-1');
  });

  it('highlights "All" when no sourceId and no activeFilter', () => {
    const sources = makeSources(['Source A', 'Source B']);
    render(
      <SourceFilterBar sources={sources} activeFilter={null} onFilterChange={onFilterChange} />,
    );

    const allButton = screen.getByText('All').closest('button')!;
    expect(allButton.className).toContain('ring-1');
  });

  it('clicking "All" clears sourceId via onClearSourceId', () => {
    const onClearSourceId = vi.fn();
    const sources = makeSources(['Source A', 'Source B']);
    render(
      <SourceFilterBar
        sources={sources}
        activeFilter={null}
        onFilterChange={onFilterChange}
        activeSourceId="src-0"
        onClearSourceId={onClearSourceId}
      />,
    );

    fireEvent.click(screen.getByText('All'));
    expect(onClearSourceId).toHaveBeenCalled();
    expect(onFilterChange).toHaveBeenCalledWith(null);
  });

  it('highlights the individual source chip matching activeSourceId', () => {
    const sources = makeSources(['Source A', 'Source B']);
    render(
      <SourceFilterBar
        sources={sources}
        activeFilter={null}
        onFilterChange={onFilterChange}
        activeSourceId="src-0"
      />,
    );

    // Source A chip should be highlighted (ring-1)
    const sourceAChip = screen.getByText('Source A').closest('button')!;
    expect(sourceAChip.className).toContain('ring-1');

    // Source B chip should NOT be highlighted
    const sourceBChip = screen.getByText('Source B').closest('button')!;
    expect(sourceBChip.className).not.toContain('ring-1');
  });
});
