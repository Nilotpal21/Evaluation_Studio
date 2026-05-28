/**
 * Bug regression tests for DataSection filter behavior (KB UX Waves 1–3).
 *
 * Tests consumeFilter priority, sourceId/sourceFilter interaction,
 * stale source cleanup, and view-switch filter preservation.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import type { SearchAISource } from '../../api/search-ai';

// ---------------------------------------------------------------------------
// Mock lucide-react — explicit factory (global Proxy mock hangs under forks)
// ---------------------------------------------------------------------------

vi.mock(import('lucide-react'), async (importOriginal) => {
  const actual = await importOriginal();
  const n = () => null;
  // Stub all icon components to avoid rendering overhead in tests
  const stubs: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stubs[key] =
      typeof actual[key as keyof typeof actual] === 'function'
        ? n
        : actual[key as keyof typeof actual];
  }
  return stubs;
});

// ---------------------------------------------------------------------------
// Mock SWR — configurable per test
// ---------------------------------------------------------------------------

const mockMutate = vi.fn();
let mockSwrReturn: Record<string, unknown> = {
  data: undefined,
  error: undefined,
  isLoading: false,
  isValidating: false,
  mutate: mockMutate,
};

vi.mock('swr', () => ({
  default: vi.fn(() => mockSwrReturn),
}));

// ---------------------------------------------------------------------------
// Mock AddSourceButton
// ---------------------------------------------------------------------------

vi.mock('../../components/search-ai/data/AddSourceButton', () => ({
  AddSourceButton: ({ onSourceAdded }: { onSourceAdded: () => void }) => (
    <button onClick={onSourceAdded}>Add Source</button>
  ),
}));

// ---------------------------------------------------------------------------
// Mock API layer
// ---------------------------------------------------------------------------

vi.mock('../../api/search-ai', () => ({
  fetchDocuments: vi.fn().mockResolvedValue({
    documents: [],
    total: 0,
    pagination: { limit: 20, offset: 0, hasMore: false },
  }),
  getDocumentDetail: vi.fn().mockResolvedValue({
    document: {
      _id: 'd1',
      title: 'test',
      url: '',
      status: 'indexed',
      contentType: 'text/html',
      contentSizeBytes: 0,
      extractedText: null,
      sourceMetadata: {},
      createdAt: '2026-03-01',
    },
    chunks: [],
    chunkCount: 0,
  }),
  fetchHealthSummary: vi.fn(),
  fetchEnterpriseConnectors: vi.fn().mockResolvedValue({ data: { connectors: [] } }),
  deleteSource: vi.fn(),
  startConnectorSync: vi.fn(),
  renameSource: vi.fn(),
  updateCitationConfig: vi.fn().mockResolvedValue({}),
}));

// ---------------------------------------------------------------------------
// Mock framer-motion — explicit factory (global Proxy mock hangs under forks)
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
// Interactive SegmentedControl mock (needed for view-switch tests)
// ---------------------------------------------------------------------------

vi.mock('../../components/ui/SegmentedControl', () => ({
  SegmentedControl: ({
    options,
    value,
    onChange,
  }: {
    options: Array<{ id: string; label: string }>;
    value: string;
    onChange: (v: string) => void;
  }) => (
    <div data-testid="segmented-control">
      {options.map((opt) => (
        <button
          key={opt.id}
          data-testid={`seg-${opt.id}`}
          aria-pressed={value === opt.id}
          onClick={() => onChange(opt.id)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  ),
}));

// ---------------------------------------------------------------------------
// Mock navigation store (NeedsAttentionCard uses it)
// ---------------------------------------------------------------------------

const mockSetTab = vi.fn();
const mockSetTabAndSubSection = vi.fn();

vi.mock('../../store/navigation-store', () => ({
  useNavigationStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ setTab: mockSetTab, setTabAndSubSection: mockSetTabAndSubSection }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { DataSection } from '../../components/search-ai/data/DataSection';
import { useDataTabFilterStore } from '../../store/data-tab-filter-store';
import { NeedsAttentionCard } from '../../components/search-ai/home/NeedsAttentionCard';
import type { HealthSummaryResponse } from '../../api/search-ai';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSources(types: string[], overrides?: Partial<SearchAISource>): SearchAISource[] {
  return types.map((sourceType, i) => ({
    _id: `src-${i}`,
    tenantId: 't-1',
    indexId: 'idx-1',
    name: `Source ${i}`,
    sourceType,
    sourceConfig: {},
    status: 'active',
    extractionConfig: null,
    enrichmentConfig: null,
    syncSchedule: null,
    documentCount: 10,
    lastSyncAt: null,
    syncError: null,
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-17T00:00:00Z',
    ...overrides,
  }));
}

function makeHealthData(
  sourceErrors: Array<{ sourceId: string; sourceName: string }> = [],
): HealthSummaryResponse {
  return {
    sources: {
      total: 5,
      syncing: 0,
      errors: sourceErrors.map((e) => ({
        ...e,
        error: 'sync failed',
        lastSyncAt: null,
      })),
    },
    pipeline: { status: 'valid', errors: [] },
    circuitBreaker: null,
    documents: { total: 100, errored: 0, processing: 0 },
    llm: { configured: true },
  };
}

// ---------------------------------------------------------------------------
// Reset store between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  useDataTabFilterStore.setState({ pendingFilter: null });
  Object.assign(mockSwrReturn, {
    data: undefined,
    error: undefined,
    isLoading: false,
  });
});

// ===========================================================================
// #61 — NeedsAttentionCard: single source error navigation
// ===========================================================================

describe('NeedsAttentionCard — source error navigation (#61)', () => {
  const mockSetPendingFilter = vi.fn();

  beforeEach(() => {
    useDataTabFilterStore.setState({
      pendingFilter: null,
      setPendingFilter: mockSetPendingFilter,
    });
  });

  it('navigates to source documents without statusFilter when single source has sync error', () => {
    const healthData = makeHealthData([{ sourceId: 'src-err-1', sourceName: 'Bad Source' }]);
    Object.assign(mockSwrReturn, { data: healthData });

    render(<NeedsAttentionCard kbId="kb-1" />);

    expect(screen.getByText(/1.*source.*sync error/i)).toBeInTheDocument();
    expect(screen.getByText('Bad Source')).toBeInTheDocument();

    const viewButton = screen.getByRole('button', { name: /view in data/i });
    act(() => viewButton.click());

    expect(mockSetPendingFilter).toHaveBeenCalledWith(
      expect.objectContaining({
        view: 'documents',
        sourceId: 'src-err-1',
      }),
    );
    const calledWith = mockSetPendingFilter.mock.calls[0][0];
    expect(calledWith.statusFilter).toBeUndefined();
  });

  it('navigates to sources list view without sourceId when multiple sources have sync errors', () => {
    const healthData = makeHealthData([
      { sourceId: 'src-err-1', sourceName: 'Bad Source 1' },
      { sourceId: 'src-err-2', sourceName: 'Bad Source 2' },
    ]);
    Object.assign(mockSwrReturn, { data: healthData });

    render(<NeedsAttentionCard kbId="kb-1" />);

    expect(screen.getByText(/2.*sources.*sync error/i)).toBeInTheDocument();

    const viewButton = screen.getByRole('button', { name: /view in data/i });
    act(() => viewButton.click());

    expect(mockSetPendingFilter).toHaveBeenCalledWith(
      expect.objectContaining({
        view: 'sources',
      }),
    );
    const calledWith = mockSetPendingFilter.mock.calls[0][0];
    expect(calledWith.sourceId).toBeUndefined();
  });
});

// ===========================================================================
// B4 — consumeFilter: sourceId takes precedence over view
// ===========================================================================

describe('consumeFilter priority — sourceId overrides view (B4)', () => {
  it('forces documents view and shows source badge when pending filter has both sourceId and view:sources', () => {
    const sources = makeSources(['file', 'web']);

    useDataTabFilterStore.setState({
      pendingFilter: { sourceId: 'src-0', view: 'sources' },
    });

    render(<DataSection indexId="idx-1" sources={sources} onRefreshSources={vi.fn()} />);

    // Source name appears in both chip and active filter badge
    expect(screen.getAllByText('Source 0').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByLabelText(/clear source filter/i)).toBeInTheDocument();
  });

  it('switches to requested view when pending filter has view but no sourceId', () => {
    const sources = makeSources(['file']);

    useDataTabFilterStore.setState({
      pendingFilter: { view: 'sources' },
    });

    render(<DataSection indexId="idx-1" sources={sources} onRefreshSources={vi.fn()} />);

    const sourcesButton = screen.getByTestId('seg-sources');
    expect(sourcesButton.getAttribute('aria-pressed')).toBe('true');
  });
});

// ===========================================================================
// B1 — sourceId must null sourceFilter in DocumentTable
// ===========================================================================

describe('sourceId nulls sourceFilter in DocumentTable (B1)', () => {
  it('shows source badge and highlights individual source chip when filtering by specific source', () => {
    const sources = makeSources(['file', 'web']);

    useDataTabFilterStore.setState({
      pendingFilter: { sourceId: 'src-0' },
    });

    render(<DataSection indexId="idx-1" sources={sources} onRefreshSources={vi.fn()} />);

    // Source filter badge visible in active filters area
    expect(screen.getByLabelText(/clear source filter/i)).toBeInTheDocument();

    // "All" chip is NOT highlighted when a specific source is selected
    const allButton = screen.getByText('All').closest('button')!;
    expect(allButton.className).not.toContain('ring-1');
  });
});

// ===========================================================================
// B2 — stale activeSourceId cleared when source removed from list
// ===========================================================================

describe('stale source filter cleanup on source removal (B2)', () => {
  it('clears source filter badge when the filtered source is deleted and list refreshes', () => {
    const sources = makeSources(['file', 'web']);

    useDataTabFilterStore.setState({
      pendingFilter: { sourceId: 'src-0' },
    });

    const { rerender } = render(
      <DataSection indexId="idx-1" sources={sources} onRefreshSources={vi.fn()} />,
    );

    // Source name appears in both chip and active filter badge
    expect(screen.getAllByText('Source 0').length).toBeGreaterThanOrEqual(1);

    const remainingSources = makeSources(['web']).map((s, i) => ({
      ...s,
      _id: `src-${i + 1}`,
      name: `Source ${i + 1}`,
    }));

    rerender(<DataSection indexId="idx-1" sources={remainingSources} onRefreshSources={vi.fn()} />);

    expect(screen.queryByLabelText(/clear source filter/i)).not.toBeInTheDocument();
  });
});

// ===========================================================================
// #58 — activeFilter (sourceType chip) preserved on view switch
// ===========================================================================

describe('sourceType chip filter preserved across view switches (#58)', () => {
  it('retains active sourceType chip after switching away from an explicitly opened documents view', () => {
    // Use >8 sources to test the sourceType chip path
    const sources = makeSources([
      'file',
      'file',
      'file',
      'file',
      'file',
      'web',
      'web',
      'web',
      'web',
    ]);

    useDataTabFilterStore.setState({
      pendingFilter: { sourceType: 'file', view: 'documents' },
    });

    render(<DataSection indexId="idx-1" sources={sources} onRefreshSources={vi.fn()} />);

    const docsButton = screen.getByTestId('seg-documents');
    expect(docsButton.getAttribute('aria-pressed')).toBe('true');

    const sourcesButton = screen.getByTestId('seg-sources');
    act(() => sourcesButton.click());
    expect(sourcesButton.getAttribute('aria-pressed')).toBe('true');

    act(() => docsButton.click());

    const fileChip = screen.getByLabelText(/filter by file/i);
    expect(fileChip.getAttribute('aria-pressed')).toBe('true');
  });

  it('clears statusFilter when switching away from documents view and back', () => {
    const sources = makeSources(['file']);

    useDataTabFilterStore.setState({
      pendingFilter: { statusFilter: 'error' },
    });

    render(<DataSection indexId="idx-1" sources={sources} onRefreshSources={vi.fn()} />);

    expect(screen.getByText('error')).toBeInTheDocument();

    const sourcesButton = screen.getByTestId('seg-sources');
    act(() => sourcesButton.click());

    const docsButton = screen.getByTestId('seg-documents');
    act(() => docsButton.click());

    expect(screen.queryByLabelText(/clear status filter/i)).not.toBeInTheDocument();
  });
});
