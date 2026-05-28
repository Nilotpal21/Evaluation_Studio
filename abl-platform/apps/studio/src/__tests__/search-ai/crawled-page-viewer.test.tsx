/**
 * @vitest-environment happy-dom
 *
 * Tests for CrawledPageViewer tab logic.
 * Validates conditional tab visibility based on rawHtmlUrl
 * and activeTab reset when tabs become unavailable.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mock lucide-react (barrel import of 1000+ icons hangs under happy-dom)
// ---------------------------------------------------------------------------

vi.mock('lucide-react', () => {
  const n = () => null;
  return {
    FileText: n,
    Globe: n,
    Columns2: n,
    BarChart3: n,
    AlertCircle: n,
    RefreshCw: n,
    Layers: n,
    X: n,
  };
});

// ---------------------------------------------------------------------------
// Mock getDocumentDetail API
// ---------------------------------------------------------------------------

const mockGetDocumentDetail = vi.fn();
vi.mock('@/api/search-ai', () => ({
  getDocumentDetail: (...args: unknown[]) => mockGetDocumentDetail(...args),
}));

// ---------------------------------------------------------------------------
// Mock animation lib
// ---------------------------------------------------------------------------

vi.mock('@/lib/animation', () => ({
  springs: { snappy: {}, gentle: {} },
  transitions: { slideRight: {}, backdrop: {} },
}));

// ---------------------------------------------------------------------------
// Mock child view components as simple divs with test IDs
// ---------------------------------------------------------------------------

vi.mock('../../components/search-ai/viewer/PageViewerHeader', () => ({
  PageViewerHeader: (props: { title: string }) => (
    <div data-testid="page-viewer-header">{props.title}</div>
  ),
}));

vi.mock('../../components/search-ai/viewer/ExtractedContentView', () => ({
  ExtractedContentView: () => <div data-testid="extracted-content-view">ExtractedContent</div>,
}));

vi.mock('../../components/search-ai/viewer/OriginalPageView', () => ({
  OriginalPageView: () => <div data-testid="original-page-view">OriginalPage</div>,
}));

vi.mock('../../components/search-ai/viewer/SideBySideView', () => ({
  SideBySideView: () => <div data-testid="side-by-side-view">SideBySide</div>,
}));

vi.mock('../../components/search-ai/viewer/MetadataView', () => ({
  MetadataView: () => <div data-testid="metadata-view">Metadata</div>,
}));

vi.mock('../../components/search-ai/viewer/ChunkNavigator', () => ({
  ChunkNavigator: () => <div data-testid="chunk-navigator">ChunkNav</div>,
}));

vi.mock('../../components/search-ai/ChunkExplorer', () => ({
  ChunkExplorerDialog: () => <div data-testid="chunk-explorer-dialog" />,
}));

// ---------------------------------------------------------------------------
// Mock SegmentedControl — render actual buttons so we can test tab switching
// ---------------------------------------------------------------------------

vi.mock('../../components/ui/SegmentedControl', () => ({
  SegmentedControl: ({
    options,
    value,
    onChange,
  }: {
    options: { id: string; label: string }[];
    value: string;
    onChange: (id: string) => void;
  }) => (
    <div data-testid="segmented-control">
      {options.map((o) => (
        <button
          key={o.id}
          data-testid={`tab-${o.id}`}
          data-active={o.id === value}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  ),
}));

// ---------------------------------------------------------------------------
// Import component under test (after mocks)
// ---------------------------------------------------------------------------

import { CrawledPageViewer } from '../../components/search-ai/viewer/CrawledPageViewer';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const docWithoutHtml = {
  _id: 'd1',
  title: 'File Upload Doc',
  url: 'file://report.pdf',
  status: 'indexed',
  contentType: 'application/pdf',
  contentSizeBytes: 2048,
  extractedText: 'Some text content.',
  sourceMetadata: {},
  createdAt: '2026-03-01T00:00:00Z',
};

const docWithHtml = {
  ...docWithoutHtml,
  _id: 'd2',
  title: 'Web Crawled Doc',
  url: 'https://example.com/page',
  contentType: 'text/html',
  rawHtmlUrl: 'https://storage.example.com/raw/d2.html',
};

const defaultChunks = [
  { _id: 'c1', content: 'First chunk', position: { order: 0 }, tokenCount: 20 },
];

function mockDocument(doc: Record<string, unknown>, chunks = defaultChunks) {
  mockGetDocumentDetail.mockResolvedValue({
    document: doc,
    chunks,
    chunkCount: chunks.length,
  });
}

const baseProps = {
  open: true,
  onClose: vi.fn(),
  indexId: 'idx-1',
  documentId: 'd1',
};

// ===========================================================================
// Tab Logic Tests
// ===========================================================================

describe('CrawledPageViewer — tab logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows only extracted and metadata tabs when document has no rawHtmlUrl', async () => {
    mockDocument(docWithoutHtml);

    render(<CrawledPageViewer {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByTestId('segmented-control')).toBeInTheDocument();
    });

    // Should have extracted and metadata tabs
    expect(screen.getByTestId('tab-extracted')).toBeInTheDocument();
    expect(screen.getByTestId('tab-metadata')).toBeInTheDocument();

    // Should NOT have original or sideBySide tabs
    expect(screen.queryByTestId('tab-original')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tab-sideBySide')).not.toBeInTheDocument();
  });

  it('shows all 4 tabs when document has rawHtmlUrl', async () => {
    mockDocument(docWithHtml);

    render(<CrawledPageViewer {...baseProps} documentId="d2" />);

    await waitFor(() => {
      expect(screen.getByTestId('segmented-control')).toBeInTheDocument();
    });

    expect(screen.getByTestId('tab-extracted')).toBeInTheDocument();
    expect(screen.getByTestId('tab-original')).toBeInTheDocument();
    expect(screen.getByTestId('tab-sideBySide')).toBeInTheDocument();
    expect(screen.getByTestId('tab-metadata')).toBeInTheDocument();
  });

  it('resets activeTab to extracted when selected tab becomes unavailable', async () => {
    // Start with a document that has rawHtmlUrl (4 tabs)
    mockDocument(docWithHtml);

    const { rerender } = render(<CrawledPageViewer {...baseProps} documentId="d2" />);

    // Wait for data to load and tabs to appear
    await waitFor(() => {
      expect(screen.getByTestId('tab-original')).toBeInTheDocument();
    });

    // Select the 'original' tab
    fireEvent.click(screen.getByTestId('tab-original'));

    // Verify original tab is active
    expect(screen.getByTestId('tab-original')).toHaveAttribute('data-active', 'true');

    // Now switch to a document without rawHtmlUrl
    mockDocument(docWithoutHtml);

    // Re-render with new documentId to trigger fetch
    await act(async () => {
      rerender(<CrawledPageViewer {...baseProps} documentId="d1" />);
    });

    // Wait for the new data to load (no rawHtmlUrl → only 2 tabs)
    await waitFor(() => {
      expect(screen.queryByTestId('tab-original')).not.toBeInTheDocument();
    });

    // The extracted tab should now be active (reset from unavailable 'original')
    expect(screen.getByTestId('tab-extracted')).toHaveAttribute('data-active', 'true');
  });
});
