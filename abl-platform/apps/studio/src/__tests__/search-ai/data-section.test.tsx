/**
 * Tests for DataSection, SourceFilterBar, DocumentTable
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { SearchAISource } from '../../api/search-ai';

// ---------------------------------------------------------------------------
// Mock lucide-react (barrel import of 1000+ icons hangs under happy-dom)
// ---------------------------------------------------------------------------

vi.mock(import('lucide-react'), async (importOriginal) => {
  const actual = await importOriginal();
  const n = () => null;
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
// Mock SWR
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
// Mock AddSourceButton (renders a simple button)
// ---------------------------------------------------------------------------

vi.mock('../../components/search-ai/data/AddSourceButton', () => ({
  AddSourceButton: ({ onSourceAdded }: { onSourceAdded: () => void }) => (
    <button onClick={onSourceAdded}>Add Source</button>
  ),
}));

// ---------------------------------------------------------------------------
// Mock fetchDocuments (imported by DocumentTable)
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
  renameSource: vi.fn(),
  updateCitationConfig: vi.fn().mockResolvedValue({}),
}));

// ---------------------------------------------------------------------------
// Mock framer-motion (CrawledPageViewer uses AnimatePresence + motion.div)
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

// ---------------------------------------------------------------------------
// Mock @/lib/animation (CrawledPageViewer imports springs + transitions)
// ---------------------------------------------------------------------------

vi.mock('../../lib/animation', () => ({
  springs: { snappy: {}, gentle: {} },
  transitions: { slideRight: {}, backdrop: {} },
}));

// ---------------------------------------------------------------------------
// Mock SegmentedControl (CrawledPageViewer uses it for tabs)
// ---------------------------------------------------------------------------

vi.mock('../../components/ui/SegmentedControl', () => ({
  SegmentedControl: () => null,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { DataSection } from '../../components/search-ai/data/DataSection';
import { SourceFilterBar } from '../../components/search-ai/data/SourceFilterBar';
import { DocumentTable } from '../../components/search-ai/data/DocumentTable';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSources(types: string[]): SearchAISource[] {
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
  }));
}

// ===========================================================================
// DataSection
// ===========================================================================

describe('DataSection', () => {
  const onRefreshSources = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mockSwrReturn, {
      data: undefined,
      error: undefined,
      isLoading: false,
    });
  });

  it('renders the sources view search input and default filters', () => {
    const sources = makeSources(['file', 'web']);
    render(<DataSection indexId="idx-1" sources={sources} onRefreshSources={onRefreshSources} />);

    expect(screen.getByPlaceholderText('Search sources...')).toBeInTheDocument();
    // Sources view shows the default "All" quick filter.
    expect(screen.getByText('All')).toBeInTheDocument();
  });

  it('"All" badge is active by default', () => {
    const sources = makeSources(['file']);
    render(<DataSection indexId="idx-1" sources={sources} onRefreshSources={onRefreshSources} />);

    // The active quick filter pill uses the highlighted ring style.
    const allButton = screen.getByText('All').closest('button')!;
    expect(allButton.className).toContain('ring-2');
  });
});

// ===========================================================================
// SourceFilterBar
// ===========================================================================

describe('SourceFilterBar', () => {
  const onFilterChange = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows "All" badge with total count', () => {
    const sources = makeSources(['file', 'file', 'web']);
    render(
      <SourceFilterBar sources={sources} activeFilter={null} onFilterChange={onFilterChange} />,
    );

    expect(screen.getByText('All')).toBeInTheDocument();
    // Badge shows total count (3)
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('shows individual source chips when <=8 sources', () => {
    const sources = makeSources(['file', 'file', 'web']);
    render(
      <SourceFilterBar sources={sources} activeFilter={null} onFilterChange={onFilterChange} />,
    );

    // Individual source chips show source names with doc counts
    expect(screen.getByText('Source 0')).toBeInTheDocument();
    expect(screen.getByText('Source 1')).toBeInTheDocument();
    expect(screen.getByText('Source 2')).toBeInTheDocument();
  });

  it('shows per-sourceType badges when >8 sources', () => {
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
    render(
      <SourceFilterBar sources={sources} activeFilter={null} onFilterChange={onFilterChange} />,
    );

    expect(screen.getByText('File')).toBeInTheDocument();
    expect(screen.getByText('Web')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument(); // file count
    expect(screen.getByText('4')).toBeInTheDocument(); // web count
  });

  it('clicking individual source chip calls onSelectSource', () => {
    const onSelectSource = vi.fn();
    const sources = makeSources(['file', 'web']);
    render(
      <SourceFilterBar
        sources={sources}
        activeFilter={null}
        onFilterChange={onFilterChange}
        onSelectSource={onSelectSource}
      />,
    );

    fireEvent.click(screen.getByText('Source 0'));
    expect(onSelectSource).toHaveBeenCalledWith('src-0');
    expect(onFilterChange).toHaveBeenCalledWith(null);
  });

  it('clicking active source chip calls onClearSourceId', () => {
    const onClearSourceId = vi.fn();
    const sources = makeSources(['file', 'web']);
    render(
      <SourceFilterBar
        sources={sources}
        activeFilter={null}
        onFilterChange={onFilterChange}
        activeSourceId="src-0"
        onClearSourceId={onClearSourceId}
      />,
    );

    fireEvent.click(screen.getByText('Source 0'));
    expect(onClearSourceId).toHaveBeenCalled();
  });

  it('clicking type filter calls onFilterChange (>8 sources mode)', () => {
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
    render(
      <SourceFilterBar sources={sources} activeFilter={null} onFilterChange={onFilterChange} />,
    );

    fireEvent.click(screen.getByText('File'));
    expect(onFilterChange).toHaveBeenCalledWith('file');
  });
});

// ===========================================================================
// DocumentTable
// ===========================================================================

describe('DocumentTable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mockSwrReturn, {
      data: undefined,
      error: undefined,
      isLoading: false,
    });
  });

  it('shows loading skeleton when isLoading', () => {
    Object.assign(mockSwrReturn, { isLoading: true });

    const { container } = render(
      <DocumentTable indexId="idx-1" sourceFilter={null} searchQuery="" />,
    );

    // Loading skeleton uses animate-pulse
    const skeleton = container.querySelector('.animate-pulse');
    expect(skeleton).toBeInTheDocument();
  });

  it('shows error message when fetch fails', () => {
    Object.assign(mockSwrReturn, { error: new Error('Server error') });

    render(<DocumentTable indexId="idx-1" sourceFilter={null} searchQuery="" />);

    expect(screen.getByText('Failed to load documents. Please try again.')).toBeInTheDocument();
  });

  it('shows empty state when no documents', () => {
    Object.assign(mockSwrReturn, {
      data: { documents: [], total: 0, pagination: { limit: 20, offset: 0, hasMore: false } },
    });

    render(<DocumentTable indexId="idx-1" sourceFilter={null} searchQuery="" />);

    expect(screen.getByText('No documents yet')).toBeInTheDocument();
  });

  it('shows "No matching documents" when search returns empty', () => {
    Object.assign(mockSwrReturn, {
      data: { documents: [], total: 0, pagination: { limit: 20, offset: 0, hasMore: false } },
    });

    render(<DocumentTable indexId="idx-1" sourceFilter={null} searchQuery="nonexistent" />);

    expect(screen.getByText('No matching documents')).toBeInTheDocument();
  });

  it('renders document rows with title, file type, status badge, date, size', () => {
    Object.assign(mockSwrReturn, {
      data: {
        documents: [
          {
            _id: 'doc-1',
            title: 'Getting Started Guide',
            status: 'indexed',
            chunkCount: 12,
            contentType: 'application/pdf',
            sourceMetadata: { sourceType: 'file' },
            contentSizeBytes: 5120,
            createdAt: '2026-03-15T10:00:00Z',
          },
        ],
        total: 1,
        pagination: { limit: 20, offset: 0, hasMore: false },
      },
    });

    render(<DocumentTable indexId="idx-1" sourceFilter={null} searchQuery="" />);

    expect(screen.getByText('Getting Started Guide')).toBeInTheDocument();
    expect(screen.getByText('PDF')).toBeInTheDocument();
    expect(screen.getByText('Indexed')).toBeInTheDocument();
    expect(screen.getByText('5.0 KB')).toBeInTheDocument();
  });

  it('reopens field configuration from pending field selection status', () => {
    const onConfigureFields = vi.fn();

    Object.assign(mockSwrReturn, {
      data: {
        documents: [
          {
            _id: 'doc-json-1',
            title: 'Customers.json',
            status: 'pending_field_selection',
            chunkCount: 0,
            contentType: 'application/json',
            sourceMetadata: { sourceType: 'file' },
            contentSizeBytes: 1024,
            createdAt: '2026-03-15T10:00:00Z',
          },
        ],
        total: 1,
        pagination: { limit: 20, offset: 0, hasMore: false },
      },
    });

    render(
      <DocumentTable
        indexId="idx-1"
        projectId="proj-1"
        kbId="kb-1"
        sourceFilter={null}
        searchQuery=""
        onConfigureFields={onConfigureFields}
      />,
    );

    fireEvent.click(screen.getByText('Pending Field Selection'));

    expect(onConfigureFields).toHaveBeenCalledTimes(1);
  });

  it('pagination controls: prev disabled on first page, next disabled when no more', () => {
    Object.assign(mockSwrReturn, {
      data: {
        documents: [
          {
            _id: 'doc-1',
            title: 'Doc 1',
            status: 'indexed',
            chunkCount: 1,
            sourceMetadata: {},
            contentSizeBytes: 100,
            createdAt: '2026-03-15T10:00:00Z',
          },
        ],
        total: 1,
        pagination: { limit: 20, offset: 0, hasMore: false },
      },
    });

    const { container } = render(
      <DocumentTable indexId="idx-1" sourceFilter={null} searchQuery="" />,
    );

    // Both prev and next should be disabled (single page, no more)
    const buttons = container.querySelectorAll('button[disabled]');
    expect(buttons.length).toBe(2);
  });

  it('pagination: next enabled when hasMore', () => {
    Object.assign(mockSwrReturn, {
      data: {
        documents: Array.from({ length: 20 }, (_, i) => ({
          _id: `doc-${i}`,
          title: `Doc ${i}`,
          status: 'indexed',
          chunkCount: 1,
          sourceMetadata: {},
          contentSizeBytes: 100,
          createdAt: '2026-03-15T10:00:00Z',
        })),
        total: 40,
        pagination: { limit: 20, offset: 0, hasMore: true },
      },
    });

    const { container } = render(
      <DocumentTable indexId="idx-1" sourceFilter={null} searchQuery="" />,
    );

    // prev is disabled (offset=0), but next is enabled (hasMore=true)
    const disabledButtons = container.querySelectorAll('button[disabled]');
    expect(disabledButtons.length).toBe(1); // only prev
  });
});
