/**
 * Tests for CrawledPageViewer and its sub-components.
 *
 * Validates i18n key usage, loading/error/success states,
 * keyboard interaction, and tab content rendering.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mock lucide-react (barrel import of 1000+ icons hangs under happy-dom)
// Must override the Proxy-based mock from setup.tsx with a plain object
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
vi.mock('../../api/search-ai', () => ({
  updateCitationConfig: vi.fn().mockResolvedValue({}),
  getDocumentDetail: (...args: unknown[]) => mockGetDocumentDetail(...args),
  renameSource: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock animation lib (CrawledPageViewer imports springs + transitions)
// ---------------------------------------------------------------------------

vi.mock('../../lib/animation', () => ({
  springs: { snappy: {}, gentle: {} },
  transitions: { slideRight: {}, backdrop: {} },
}));

// ---------------------------------------------------------------------------
// Mock SegmentedControl — render interactive buttons for tab switching
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
        <button key={o.id} onClick={() => onChange(o.id)} data-active={o.id === value}>
          {o.label}
        </button>
      ))}
    </div>
  ),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { CrawledPageViewer } from '../../components/search-ai/viewer/CrawledPageViewer';
import { ExtractedContentView } from '../../components/search-ai/viewer/ExtractedContentView';
import { MetadataView } from '../../components/search-ai/viewer/MetadataView';
import { ChunkNavigator } from '../../components/search-ai/viewer/ChunkNavigator';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultDoc = {
  _id: 'd1',
  title: 'Test Document',
  url: 'https://example.com/test',
  rawHtmlUrl: 'https://example.com/test.html',
  status: 'indexed',
  contentType: 'text/html',
  contentSizeBytes: 5120,
  extractedText: 'Some extracted content.',
  sourceMetadata: {},
  createdAt: '2026-03-01T00:00:00Z',
  updatedAt: '2026-03-02T00:00:00Z',
};

const defaultChunks = [
  { _id: 'c1', content: 'First chunk text', position: { order: 0 }, tokenCount: 42 },
  { _id: 'c2', content: 'Second chunk text', position: { order: 1 }, tokenCount: 38 },
];

function mockResolvedDocument(
  doc = defaultDoc,
  chunks = defaultChunks,
  chunkCount = chunks.length,
) {
  mockGetDocumentDetail.mockResolvedValue({
    document: doc,
    chunks,
    chunkCount,
  });
}

// ===========================================================================
// CrawledPageViewer
// ===========================================================================

describe('CrawledPageViewer', () => {
  const baseProps = {
    open: true,
    onClose: vi.fn(),
    indexId: 'idx-1',
    documentId: 'd1',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolvedDocument();
  });

  it('does not render dialog content when open is false', () => {
    render(<CrawledPageViewer {...baseProps} open={false} />);

    // The dialog role should not exist when closed
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows loading skeleton when fetching', () => {
    // Make the API call never resolve so the component stays in loading state
    mockGetDocumentDetail.mockReturnValue(new Promise(() => {}));

    const { container } = render(<CrawledPageViewer {...baseProps} />);

    // ViewerSkeleton renders Skeleton components
    const skeletons = container.querySelectorAll('.skeleton');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('shows document title after successful load', async () => {
    render(<CrawledPageViewer {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByText('Test Document')).toBeInTheDocument();
    });
  });

  it('renders dialog with correct aria-label using i18n key', async () => {
    render(<CrawledPageViewer {...baseProps} />);

    await waitFor(() => {
      const dialog = screen.getByRole('dialog');
      // aria_label = "Document viewer" from i18n
      expect(dialog).toHaveAttribute('aria-label', 'Document viewer');
    });
  });

  it('shows error state with retry button on API failure', async () => {
    mockGetDocumentDetail.mockRejectedValue(new Error('Network error'));

    render(<CrawledPageViewer {...baseProps} />);

    await waitFor(() => {
      // error_title i18n key = "Failed to load document"
      expect(screen.getByText('Failed to load document')).toBeInTheDocument();
    });

    // Error message from the thrown error
    expect(screen.getByText('Network error')).toBeInTheDocument();

    // Retry button uses i18n key "retry" = "Retry"
    expect(screen.getByText('Retry')).toBeInTheDocument();
  });

  it('retry button calls fetchDocument again', async () => {
    mockGetDocumentDetail.mockRejectedValueOnce(new Error('fail'));

    render(<CrawledPageViewer {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByText('Retry')).toBeInTheDocument();
    });

    // Now resolve on retry
    mockResolvedDocument();
    fireEvent.click(screen.getByText('Retry'));

    await waitFor(() => {
      expect(screen.getByText('Test Document')).toBeInTheDocument();
    });

    // Called twice: initial + retry
    expect(mockGetDocumentDetail).toHaveBeenCalledTimes(2);
  });

  it('escape key closes the viewer', async () => {
    render(<CrawledPageViewer {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByText('Test Document')).toBeInTheDocument();
    });

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(baseProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('shows all tab options when rawHtmlUrl is present', async () => {
    // Original/Side-by-Side tabs only appear when rawHtmlUrl is present
    mockGetDocumentDetail.mockResolvedValue({
      document: { ...defaultDoc, rawHtmlUrl: 'https://example.com/raw' },
      chunks: defaultChunks,
      chunkCount: defaultChunks.length,
    });
    render(<CrawledPageViewer {...baseProps} />);

    await waitFor(() => {
      // Tab labels from i18n: "Extracted", "Original", "Side by Side", "Metadata"
      expect(screen.getByText('Extracted')).toBeInTheDocument();
      expect(screen.getByText('Original')).toBeInTheDocument();
      expect(screen.getByText('Side by Side')).toBeInTheDocument();
      expect(screen.getByText('Metadata')).toBeInTheDocument();
    });
  });

  it('hides Original and Side by Side tabs when rawHtmlUrl is absent', async () => {
    // Non-web documents (file uploads, DB records) don't have rawHtmlUrl
    const { rawHtmlUrl: _, ...docWithoutRawHtml } = defaultDoc;
    mockGetDocumentDetail.mockResolvedValue({
      document: docWithoutRawHtml,
      chunks: defaultChunks,
      chunkCount: defaultChunks.length,
    });
    render(<CrawledPageViewer {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByText('Extracted')).toBeInTheDocument();
      expect(screen.getByText('Metadata')).toBeInTheDocument();
    });

    // Original and Side by Side should NOT be rendered
    expect(screen.queryByText('Original')).not.toBeInTheDocument();
    expect(screen.queryByText('Side by Side')).not.toBeInTheDocument();
  });

  it('shows chunk navigator when on extracted tab with chunks', async () => {
    render(<CrawledPageViewer {...baseProps} />);

    await waitFor(() => {
      // chunks_label i18n = "Chunks:"
      expect(screen.getByText('Chunks:')).toBeInTheDocument();
    });
  });
});

// ===========================================================================
// ExtractedContentView
// ===========================================================================

describe('ExtractedContentView', () => {
  it('shows empty state when no chunks and no text', () => {
    render(
      <ExtractedContentView
        chunks={[]}
        extractedText={null}
        activeChunkIndex={0}
        onChunkClick={vi.fn()}
      />,
    );

    // no_extracted_content = "No extracted content available"
    expect(screen.getByText('No extracted content available')).toBeInTheDocument();
  });

  it('renders chunk buttons with correct i18n labels', () => {
    const chunks = [
      { _id: 'c1', content: 'Hello', position: { order: 0 }, tokenCount: 10 },
      { _id: 'c2', content: 'World', position: { order: 1 }, tokenCount: 20 },
    ];

    render(
      <ExtractedContentView
        chunks={chunks}
        extractedText={null}
        activeChunkIndex={0}
        onChunkClick={vi.fn()}
      />,
    );

    // chunk_label = "Chunk {n}" => "Chunk 1", "Chunk 2"
    expect(screen.getByText('Chunk 1')).toBeInTheDocument();
    expect(screen.getByText('Chunk 2')).toBeInTheDocument();

    // token_count = "{count} tokens" => "10 tokens", "20 tokens"
    expect(screen.getByText('10 tokens')).toBeInTheDocument();
    expect(screen.getByText('20 tokens')).toBeInTheDocument();
  });

  it('renders extracted text when no chunks but text exists', () => {
    render(
      <ExtractedContentView
        chunks={[]}
        extractedText="Full document text here"
        activeChunkIndex={0}
        onChunkClick={vi.fn()}
      />,
    );

    expect(screen.getByText('Full document text here')).toBeInTheDocument();
  });

  it('calls onChunkClick when a chunk button is clicked', () => {
    const onChunkClick = vi.fn();
    const chunks = [
      { _id: 'c1', content: 'Hello', position: { order: 0 }, tokenCount: 10 },
      { _id: 'c2', content: 'World', position: { order: 1 }, tokenCount: 20 },
    ];

    render(
      <ExtractedContentView
        chunks={chunks}
        extractedText={null}
        activeChunkIndex={0}
        onChunkClick={onChunkClick}
      />,
    );

    // Click the second chunk
    fireEvent.click(screen.getByText('World'));
    expect(onChunkClick).toHaveBeenCalledWith(1);
  });
});

// ===========================================================================
// MetadataView
// ===========================================================================

describe('MetadataView', () => {
  it('renders document info fields with i18n labels', () => {
    render(
      <MetadataView
        sourceMetadata={{ author: 'test' }}
        status="indexed"
        createdAt="2026-03-01T00:00:00Z"
        contentSizeBytes={5120}
      />,
    );

    // document_info = "Document Info"
    expect(screen.getByText('Document Info')).toBeInTheDocument();
    // status = "Status"
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('indexed')).toBeInTheDocument();
    // size = "Size"
    expect(screen.getByText('Size')).toBeInTheDocument();
    expect(screen.getByText('5.0 KB')).toBeInTheDocument();
    // crawled = "Crawled"
    expect(screen.getByText('Crawled')).toBeInTheDocument();
  });

  it('shows updated field when updatedAt is provided', () => {
    render(
      <MetadataView
        sourceMetadata={{}}
        status="indexed"
        createdAt="2026-03-01T00:00:00Z"
        updatedAt="2026-03-02T00:00:00Z"
        contentSizeBytes={100}
      />,
    );

    // updated = "Updated"
    expect(screen.getByText('Updated')).toBeInTheDocument();
  });

  it('does not show updated field when updatedAt is undefined', () => {
    render(
      <MetadataView
        sourceMetadata={{}}
        status="indexed"
        createdAt="2026-03-01T00:00:00Z"
        contentSizeBytes={100}
      />,
    );

    expect(screen.queryByText('Updated')).not.toBeInTheDocument();
  });

  it('renders source metadata as JSON', () => {
    render(
      <MetadataView
        sourceMetadata={{ author: 'John', version: 2 }}
        status="indexed"
        createdAt="2026-03-01T00:00:00Z"
        contentSizeBytes={100}
      />,
    );

    // source_metadata = "Source Metadata"
    expect(screen.getByText('Source Metadata')).toBeInTheDocument();
    // JSON content
    expect(screen.getByText(/"author": "John"/)).toBeInTheDocument();
  });
});

// ===========================================================================
// ChunkNavigator
// ===========================================================================

describe('ChunkNavigator', () => {
  const chunks = [
    { _id: 'c1', content: 'A', position: { order: 0 }, tokenCount: 5 },
    { _id: 'c2', content: 'B', position: { order: 1 }, tokenCount: 10 },
    { _id: 'c3', content: 'C', position: { order: 2 }, tokenCount: 15 },
  ];

  it('renders chunk buttons numbered 1 through N', () => {
    render(<ChunkNavigator chunks={chunks} activeIndex={0} onSelect={vi.fn()} />);

    // chunks_label = "Chunks:"
    expect(screen.getByText('Chunks:')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('shows chunk position using i18n key', () => {
    render(<ChunkNavigator chunks={chunks} activeIndex={1} onSelect={vi.fn()} />);

    // chunk_position = "{n} / {total}" => "2 / 3"
    expect(screen.getByText('2 / 3')).toBeInTheDocument();
  });

  it('calls onSelect when a chunk button is clicked', () => {
    const onSelect = vi.fn();
    render(<ChunkNavigator chunks={chunks} activeIndex={0} onSelect={onSelect} />);

    fireEvent.click(screen.getByText('3'));
    expect(onSelect).toHaveBeenCalledWith(2);
  });
});
