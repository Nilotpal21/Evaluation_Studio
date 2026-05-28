/**
 * Tests for HomeSection, SetupGuide, OperationsDashboard, PipelineProgressTracker
 *
 * @vitest-environment happy-dom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { KnowledgeBaseDetail, SearchAISource } from '../../api/search-ai';

// ---------------------------------------------------------------------------
// Mock lucide-react (barrel import of 1000+ icons hangs under happy-dom)
// Must be explicit object — Proxy mocks trigger vitest ESM interop hang.
// ---------------------------------------------------------------------------

vi.mock('lucide-react', () => {
  const n = () => null;
  return {
    Check: n,
    CheckCircle2: n,
    Circle: n,
    Database: n,
    Search: n,
    Rocket: n,
    Loader2: n,
    AlertCircle: n,
    AlertTriangle: n,
    FileText: n,
    Layers: n,
    Clock: n,
    Info: n,
    RefreshCw: n,
    RotateCcw: n,
    GitBranch: n,
    BookOpen: n,
    Map: n,
    Activity: n,
    ArrowRight: n,
    Shield: n,
    ChevronDown: n,
    ChevronRight: n,
    Upload: n,
    Plug: n,
    Plus: n,
    Settings: n,
  };
});

// ---------------------------------------------------------------------------
// Mock SWR (used by OperationsDashboard and PipelineProgressTracker)
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
// Mock NeedsAttentionCard + ActivityFeed (they have their own SWR dependencies)
// ---------------------------------------------------------------------------

vi.mock('../../components/search-ai/home/NeedsAttentionCard', () => ({
  NeedsAttentionCard: ({ kbId }: { kbId: string }) => (
    <div data-testid="needs-attention-card">NeedsAttention:{kbId}</div>
  ),
}));

vi.mock('../../components/search-ai/home/ActivityFeed', () => ({
  ActivityFeed: ({ kbId }: { kbId: string }) => (
    <div data-testid="activity-feed">ActivityFeed:{kbId}</div>
  ),
}));

// ---------------------------------------------------------------------------
// Mock AddSourceButton (used in SetupGuide's dependency chain)
// ---------------------------------------------------------------------------

vi.mock('../../components/search-ai/data/AddSourceButton', () => ({
  AddSourceButton: ({
    onSourceAdded,
    open,
  }: {
    onSourceAdded: (source?: { _id: string; name: string; sourceType: string }) => void;
    open?: boolean;
  }) =>
    open ? (
      <button
        onClick={() => onSourceAdded({ _id: 'src-1', name: 'Test Source', sourceType: 'file' })}
      >
        Add Source
      </button>
    ) : null,
}));

// ---------------------------------------------------------------------------
// Mock fetchDocumentStatusSummary + other API calls
// ---------------------------------------------------------------------------

vi.mock('../../api/search-ai', () => ({
  fetchDocumentStatusSummary: vi.fn().mockResolvedValue({
    documentStatuses: [],
    docsWithChunkErrors: 0,
  }),
  fetchHealthSummary: vi.fn().mockResolvedValue({}),
  addSource: vi.fn().mockResolvedValue({ source: { _id: 'src-new', name: 'Uploaded Files' } }),
  getIndex: vi.fn().mockResolvedValue({ index: { llmConfig: null } }),
  renameSource: vi.fn(),
  updateCitationConfig: vi.fn().mockResolvedValue({}),
}));

// ---------------------------------------------------------------------------
// Mock FileDropZone (has its own dependencies)
// ---------------------------------------------------------------------------

vi.mock('../../components/search-ai/home/FileDropZone', () => ({
  FileDropZone: ({
    onFilesSelected,
    disabled,
  }: {
    onFilesSelected: (f: File[]) => void;
    disabled?: boolean;
  }) => (
    <div data-testid="file-drop-zone" data-disabled={disabled}>
      FileDropZone
    </div>
  ),
}));

// ---------------------------------------------------------------------------
// Mock FileUploadDialog
// ---------------------------------------------------------------------------

vi.mock('../../components/search-ai/data/FileUploadDialog', () => ({
  FileUploadDialog: () => <div data-testid="file-upload-dialog">FileUploadDialog</div>,
}));

// ---------------------------------------------------------------------------
// Mock stores used by WaitingForContent, SetupGuide, PipelineProgressTracker
// ---------------------------------------------------------------------------

vi.mock('../../store/navigation-store', () => ({
  useNavigationStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      setTab: vi.fn(),
      setTabAndSubSection: vi.fn(),
    }),
}));

vi.mock('../../store/data-tab-filter-store', () => ({
  useDataTabFilterStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      setPendingFilter: vi.fn(),
    }),
}));

// ---------------------------------------------------------------------------
// Mock sanitize-error
// ---------------------------------------------------------------------------

vi.mock('@/lib/sanitize-error', () => ({
  sanitizeError: (_e: unknown, fallback: string) => fallback,
}));

// ---------------------------------------------------------------------------
// Mock sonner toast
// ---------------------------------------------------------------------------

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { HomeSection } from '../../components/search-ai/home/HomeSection';
import { SetupGuide } from '../../components/search-ai/home/SetupGuide';
import { OperationsDashboard } from '../../components/search-ai/home/OperationsDashboard';
import { PipelineProgressTracker } from '../../components/search-ai/home/PipelineProgressTracker';
import { WaitingForContent } from '../../components/search-ai/home/WaitingForContent';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeKB(overrides?: Partial<KnowledgeBaseDetail>): KnowledgeBaseDetail {
  return {
    _id: 'kb-1',
    tenantId: 't-1',
    projectId: 'p-1',
    name: 'Test KB',
    description: null,
    status: 'active',
    searchIndexId: 'idx-1',
    canonicalSchemaId: null,
    connectorCount: 3,
    documentCount: 50,
    lastIndexedAt: '2026-03-17T00:00:00Z',
    indexError: null,
    isPublic: false,
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-17T00:00:00Z',
    index: {
      _id: 'idx-1',
      tenantId: 't-1',
      projectId: 'p-1',
      slug: 'test-kb',
      name: 'Test KB Index',
      description: null,
      embeddingModel: 'bge-m3',
      embeddingDimensions: 1024,
      vectorStore: { provider: 'qdrant', collectionName: 'test-kb' },
      searchDefaults: {
        topK: 10,
        similarityThreshold: 0.7,
        includeMetadata: true,
        includeContent: true,
      },
      status: 'active',
      documentCount: 50,
      chunkCount: 200,
      sourceCount: 3,
      lastIndexedAt: '2026-03-17T00:00:00Z',
      indexError: null,
      createdAt: '2026-03-01T00:00:00Z',
      updatedAt: '2026-03-17T00:00:00Z',
    },
    ...overrides,
  };
}

function makeSources(count: number): SearchAISource[] {
  return Array.from({ length: count }, (_, i) => ({
    _id: `src-${i}`,
    tenantId: 't-1',
    indexId: 'idx-1',
    name: `Source ${i}`,
    sourceType: 'file',
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
// HomeSection state machine
// ===========================================================================

describe('HomeSection', () => {
  const onRefreshSources = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mockSwrReturn, {
      data: undefined,
      error: undefined,
      isLoading: false,
    });
  });

  it('renders SetupGuide when sources=[] and documentCount=0', () => {
    const kb = makeKB({ documentCount: 0, connectorCount: 0 });
    render(
      <HomeSection
        knowledgeBase={kb}
        indexId="idx-1"
        sources={[]}
        onRefreshSources={onRefreshSources}
      />,
    );

    // SetupGuide renders "Get started with {name}" heading (name is quoted in translation)
    expect(screen.getByText(/Get started with.*Test KB/)).toBeInTheDocument();
  });

  it('renders PipelineProgressTracker when status=creating', () => {
    const kb = makeKB({ status: 'creating', documentCount: 0 });
    render(
      <HomeSection
        knowledgeBase={kb}
        indexId="idx-1"
        sources={makeSources(1)}
        onRefreshSources={onRefreshSources}
      />,
    );

    expect(screen.getByText('Processing your documents')).toBeInTheDocument();
  });

  it('renders PipelineProgressTracker when status=indexing', () => {
    const kb = makeKB({ status: 'indexing' });
    render(
      <HomeSection
        knowledgeBase={kb}
        indexId="idx-1"
        sources={makeSources(1)}
        onRefreshSources={onRefreshSources}
      />,
    );

    expect(screen.getByText('Processing your documents')).toBeInTheDocument();
  });

  it('renders SetupGuide when sources exist but documentCount=0 and status=active (#73)', () => {
    const kb = makeKB({ status: 'active', documentCount: 0, connectorCount: 1 });
    render(
      <HomeSection
        knowledgeBase={kb}
        indexId="idx-1"
        sources={makeSources(1)}
        onRefreshSources={onRefreshSources}
      />,
    );

    // Should show SetupGuide even if sources exist but no documents (new behavior)
    expect(screen.getByText(/Get started/)).toBeInTheDocument();
    expect(screen.getByText(/Add content to your knowledge base/)).toBeInTheDocument();
  });

  it('renders PipelineProgressTracker when status=rebuilding', () => {
    const kb = makeKB({ status: 'rebuilding', documentCount: 10 });
    render(
      <HomeSection
        knowledgeBase={kb}
        indexId="idx-1"
        sources={makeSources(1)}
        onRefreshSources={onRefreshSources}
      />,
    );

    expect(screen.getByText('Processing your documents')).toBeInTheDocument();
  });

  it('renders PipelineProgressTracker (not SetupGuide) when status=error with sources but 0 docs', () => {
    const kb = makeKB({ status: 'error', documentCount: 0, connectorCount: 1 });
    render(
      <HomeSection
        knowledgeBase={kb}
        indexId="idx-1"
        sources={makeSources(1)}
        onRefreshSources={onRefreshSources}
      />,
    );

    // Error status takes priority over documentCount===0 → should show PipelineProgressTracker, not SetupGuide
    expect(screen.getByText('Processing your documents')).toBeInTheDocument();
    expect(screen.queryByText(/Get started/)).not.toBeInTheDocument();
  });

  it('renders OperationsDashboard when has documents and active status', () => {
    const kb = makeKB({ status: 'active', documentCount: 50 });
    render(
      <HomeSection
        knowledgeBase={kb}
        indexId="idx-1"
        sources={makeSources(3)}
        onRefreshSources={onRefreshSources}
      />,
    );

    // OperationsDashboard renders stat cards with "Documents" label
    expect(screen.getByText('Documents')).toBeInTheDocument();
    expect(screen.getByText('Chunks')).toBeInTheDocument();
  });
});

// ===========================================================================
// SetupGuide
// ===========================================================================

describe('SetupGuide', () => {
  it('renders 2-card layout (upload + connect)', () => {
    const kb = makeKB({ status: 'active', documentCount: 0 });
    render(
      <SetupGuide knowledgeBase={kb} indexId="idx-1" sources={[]} onRefreshSources={vi.fn()} />,
    );

    // Upload card
    expect(screen.getByText('Upload files')).toBeInTheDocument();
    // Connect card
    expect(screen.getByText('Connect a data source')).toBeInTheDocument();
    // FileDropZone rendered inside upload card
    expect(screen.getByTestId('file-drop-zone')).toBeInTheDocument();
  });

  it('KB name appears in "Get started" heading', () => {
    const kb = makeKB({ name: 'My Knowledge Base', documentCount: 0 });
    render(
      <SetupGuide knowledgeBase={kb} indexId="idx-1" sources={[]} onRefreshSources={vi.fn()} />,
    );

    expect(screen.getByText('Get started with "My Knowledge Base"')).toBeInTheDocument();
  });

  it('"Connect a source" button opens dialog, adding source navigates to data tab', () => {
    const mockOnNavigate = vi.fn();
    const kb = makeKB({ status: 'active', documentCount: 0 });

    render(
      <SetupGuide
        knowledgeBase={kb}
        indexId="idx-1"
        sources={[]}
        onRefreshSources={vi.fn()}
        onNavigate={mockOnNavigate}
      />,
    );

    // Step 1: Click "Connect a source" to open the dialog
    fireEvent.click(screen.getByText('Connect a source'));
    // Step 2: Click "Add Source" in the dialog mock to simulate source creation
    fireEvent.click(screen.getByText('Add Source'));
    expect(mockOnNavigate).toHaveBeenCalledWith('data');
  });

  it('shows "What happens automatically" explainer', () => {
    const kb = makeKB({ status: 'active', documentCount: 0 });
    render(
      <SetupGuide knowledgeBase={kb} indexId="idx-1" sources={[]} onRefreshSources={vi.fn()} />,
    );

    expect(screen.getByText('What happens automatically')).toBeInTheDocument();
  });
});

// ===========================================================================
// OperationsDashboard
// ===========================================================================

describe('OperationsDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mockSwrReturn, {
      data: undefined,
      error: undefined,
      isLoading: false,
    });
  });

  it('renders 3 stat cards', () => {
    const kb = makeKB();
    render(<OperationsDashboard knowledgeBase={kb} indexId="idx-1" />);

    expect(screen.getByText('Sources')).toBeInTheDocument();
    expect(screen.getByText('Documents')).toBeInTheDocument();
    expect(screen.getByText('Chunks')).toBeInTheDocument();
  });

  it('shows stat values from knowledgeBase', () => {
    const kb = makeKB({
      documentCount: 42,
      connectorCount: 5,
      index: {
        ...makeKB().index,
        documentCount: 42,
        sourceCount: 5,
      },
    });
    render(<OperationsDashboard knowledgeBase={kb} indexId="idx-1" />);

    // Documents count should show
    expect(screen.getByText('42')).toBeInTheDocument();
    // Note: Sources count may come from SWR-fetched index data, not directly from connectorCount
  });

  it('renders NeedsAttentionCard with KB id', () => {
    const kb = makeKB({ _id: 'kb-test-123', indexError: null });
    render(<OperationsDashboard knowledgeBase={kb} indexId="idx-1" />);

    expect(screen.getByTestId('needs-attention-card')).toBeInTheDocument();
    expect(screen.getByText('NeedsAttention:kb-test-123')).toBeInTheDocument();
  });

  it('renders ActivityFeed with KB id', () => {
    const kb = makeKB({ _id: 'kb-test-456' });
    render(<OperationsDashboard knowledgeBase={kb} indexId="idx-1" />);

    expect(screen.getByTestId('activity-feed')).toBeInTheDocument();
    expect(screen.getByText('ActivityFeed:kb-test-456')).toBeInTheDocument();
  });

  it('renders Your Sources section', () => {
    const kb = makeKB();
    render(<OperationsDashboard knowledgeBase={kb} indexId="idx-1" />);

    // Dashboard shows sources section with emoji
    expect(screen.getByText(/Your Sources/)).toBeInTheDocument();
  });
});

// ===========================================================================
// PipelineProgressTracker
// ===========================================================================

describe('PipelineProgressTracker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mockSwrReturn, {
      data: undefined,
      error: undefined,
      isLoading: false,
    });
  });

  it('shows pipeline title for any processing status', () => {
    const kb = makeKB({ status: 'indexing', documentCount: 5 });
    render(<PipelineProgressTracker knowledgeBase={kb} indexId="idx-1" />);

    expect(screen.getByText('Processing your documents')).toBeInTheDocument();
  });

  it('shows action links', () => {
    const kb = makeKB({ status: 'indexing', documentCount: 5 });
    render(<PipelineProgressTracker knowledgeBase={kb} indexId="idx-1" />);

    expect(screen.getByText('Try a search')).toBeInTheDocument();
    expect(screen.getByText('View documents')).toBeInTheDocument();
  });
});
