/**
 * Tests for SetupGuide and HomeSection upload behavior.
 *
 * Covers direct SetupGuide delegation plus the lifted HomeSection upload dialog
 * flow that must survive the setup -> waiting state transition.
 *
 * @vitest-environment happy-dom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mock lucide-react
// ---------------------------------------------------------------------------

vi.mock('lucide-react', () => {
  const n = () => null;
  return {
    Rocket: n,
    Plug: n,
    AlertCircle: n,
    AlertTriangle: n,
    Upload: n,
    FileText: n,
    Plus: n,
    Settings: n,
    X: n,
    ChevronDown: n,
    ChevronRight: n,
    RotateCcw: n,
    Info: n,
    CheckCircle2: n,
    XCircle: n,
    Globe: n,
    Database: n,
    Building2: n,
    Search: n,
    Zap: n,
    ArrowLeft: n,
  };
});

// ---------------------------------------------------------------------------
// Mock next-intl
// ---------------------------------------------------------------------------

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) => {
    if (params && 'name' in params) return `Get started with "${params.name}"`;
    if (key === 'card_upload_title') return 'Upload files';
    if (key === 'card_connect_title') return 'Connect a data source';
    if (key === 'card_connect_action') return 'Connect a source';
    if (key === 'action_upload') return 'Upload files';
    if (key === 'action_add_source') return 'Add another source';
    if (key === 'action_configure') return 'Configure';
    if (key === 'auto_pipeline_title') return 'What happens automatically';
    if (key === 'default_source_name') return 'Uploaded Files';
    return key;
  },
}));

// ---------------------------------------------------------------------------
// Mock SWR
// ---------------------------------------------------------------------------

const mockMutate = vi.fn();

vi.mock('swr', () => ({
  default: vi.fn(() => ({
    data: { index: { llmConfig: { provider: 'openai' } } },
    error: undefined,
    isLoading: false,
    isValidating: false,
    mutate: mockMutate,
  })),
}));

// ---------------------------------------------------------------------------
// Mock API layer
// ---------------------------------------------------------------------------

const mockAddSource = vi.fn();

vi.mock('../../api/search-ai', () => ({
  addSource: (...args: unknown[]) => mockAddSource(...args),
  getIndex: vi.fn().mockResolvedValue({ index: { llmConfig: { provider: 'openai' } } }),
  renameSource: vi.fn(),
  updateCitationConfig: vi.fn().mockResolvedValue({}),
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
// Mock upload-constants
// ---------------------------------------------------------------------------

vi.mock('@/lib/upload-constants', () => ({
  isUploadableSource: (type: string) => type === 'manual' || type === 'file',
}));

// ---------------------------------------------------------------------------
// Mock HomeSection leaf components irrelevant to upload flow
// ---------------------------------------------------------------------------

vi.mock('../../components/search-ai/home/NeedsAttentionCard', () => ({
  NeedsAttentionCard: () => <div data-testid="needs-attention-card" />,
}));

vi.mock('../../components/search-ai/home/ActivityFeed', () => ({
  ActivityFeed: () => <div data-testid="activity-feed" />,
}));

// ---------------------------------------------------------------------------
// Mock Card, Button (avoid deep dependency chains)
// ---------------------------------------------------------------------------

vi.mock('../../components/ui/Card', () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div data-testid="card">{children}</div>,
}));

vi.mock('../../components/ui/Button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    variant?: string;
    size?: string;
    icon?: unknown;
  }) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

// ---------------------------------------------------------------------------
// Mock data-tab-filter-store
// ---------------------------------------------------------------------------

const mockSetPendingFilter = vi.fn();

vi.mock('../../store/data-tab-filter-store', () => ({
  useDataTabFilterStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ setPendingFilter: mockSetPendingFilter }),
}));

// ---------------------------------------------------------------------------
// Capture FileDropZone interactions
// ---------------------------------------------------------------------------

vi.mock('../../components/search-ai/home/FileDropZone', () => ({
  FileDropZone: ({
    onFilesSelected,
    disabled,
  }: {
    onFilesSelected: (files: File[]) => void;
    disabled?: boolean;
  }) => (
    <div data-testid="file-drop-zone" data-disabled={disabled}>
      <button
        data-testid="drop-files"
        onClick={() => onFilesSelected([new File(['a'], 'test.pdf')])}
      >
        Drop
      </button>
    </div>
  ),
}));

// ---------------------------------------------------------------------------
// Mock lifted upload dialog
// ---------------------------------------------------------------------------

vi.mock('../../components/search-ai/data/FileUploadDialog', () => ({
  FileUploadDialog: ({
    open,
    sourceId,
    sourceName,
    onClose,
  }: {
    open: boolean;
    onClose: () => void;
    indexId: string;
    sourceId?: string;
    sourceName?: string;
    sources: unknown[];
    initialFiles?: File[];
  }) =>
    open ? (
      <div data-testid="upload-dialog">
        <span data-testid="dialog-source-id">{sourceId}</span>
        <span data-testid="dialog-source-name">{sourceName}</span>
        <button data-testid="dialog-close" onClick={onClose}>
          Close
        </button>
      </div>
    ) : null,
}));

// ---------------------------------------------------------------------------
// Mock AddSourceButton
// ---------------------------------------------------------------------------

vi.mock('../../components/search-ai/data/AddSourceButton', () => ({
  AddSourceButton: ({ onSourceAdded }: { onSourceAdded?: () => void }) => (
    <button data-testid="add-source-btn" onClick={onSourceAdded}>
      Add Source
    </button>
  ),
}));

// ---------------------------------------------------------------------------
// Import components under test (after mocks)
// ---------------------------------------------------------------------------

import { HomeSection } from '../../components/search-ai/home/HomeSection';
import { SetupGuide } from '../../components/search-ai/home/SetupGuide';
import type { KnowledgeBaseDetail, SearchAISource } from '../../api/search-ai';

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
    connectorCount: 0,
    documentCount: 0,
    lastIndexedAt: null,
    indexError: null,
    isPublic: false,
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z',
    index: {
      _id: 'idx-1',
      tenantId: 't-1',
      projectId: 'p-1',
      slug: 'test-kb',
      name: 'Test KB',
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
      documentCount: 0,
      chunkCount: 0,
      sourceCount: 0,
      lastIndexedAt: null,
      indexError: null,
      createdAt: '2026-03-01T00:00:00Z',
      updatedAt: '2026-03-01T00:00:00Z',
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SetupGuide', () => {
  it('dropping files calls onFilesSelected with the dropped files', () => {
    const onFilesSelected = vi.fn();

    render(
      <SetupGuide
        knowledgeBase={makeKB()}
        indexId="idx-1"
        sources={[]}
        onRefreshSources={vi.fn()}
        onFilesSelected={onFilesSelected}
      />,
    );

    fireEvent.click(screen.getByTestId('drop-files'));

    expect(onFilesSelected).toHaveBeenCalledTimes(1);
    expect(onFilesSelected.mock.calls[0][0]).toHaveLength(1);
    expect(onFilesSelected.mock.calls[0][0][0].name).toBe('test.pdf');
  });

  it('does not refresh sources when files are dropped directly in SetupGuide', () => {
    const onRefreshSources = vi.fn();

    render(
      <SetupGuide
        knowledgeBase={makeKB()}
        indexId="idx-1"
        sources={[]}
        onRefreshSources={onRefreshSources}
        onFilesSelected={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('drop-files'));

    expect(onRefreshSources).not.toHaveBeenCalled();
  });

  it('disables FileDropZone when creatingSource is true', () => {
    render(
      <SetupGuide
        knowledgeBase={makeKB()}
        indexId="idx-1"
        sources={[]}
        onRefreshSources={vi.fn()}
        onFilesSelected={vi.fn()}
        creatingSource={true}
      />,
    );

    expect(screen.getByTestId('file-drop-zone').getAttribute('data-disabled')).toBe('true');
  });

  it('renders Get Started heading with KB name', () => {
    render(
      <SetupGuide
        knowledgeBase={makeKB({ name: 'My KB' })}
        indexId="idx-1"
        sources={[]}
        onRefreshSources={vi.fn()}
        onFilesSelected={vi.fn()}
      />,
    );

    expect(screen.getByText('Get started with "My KB"')).toBeInTheDocument();
  });

  it('renders Upload and Connect cards', () => {
    render(
      <SetupGuide
        knowledgeBase={makeKB()}
        indexId="idx-1"
        sources={[]}
        onRefreshSources={vi.fn()}
        onFilesSelected={vi.fn()}
      />,
    );

    expect(screen.getByText('Upload files')).toBeInTheDocument();
    expect(screen.getByText('Connect a data source')).toBeInTheDocument();
    expect(screen.getByTestId('file-drop-zone')).toBeInTheDocument();
  });

  it('clicking AddSourceButton refreshes sources after a source is added', () => {
    const onRefreshSources = vi.fn();

    render(
      <SetupGuide
        knowledgeBase={makeKB()}
        indexId="idx-1"
        sources={[]}
        onRefreshSources={onRefreshSources}
        onFilesSelected={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('add-source-btn'));

    expect(onRefreshSources).toHaveBeenCalledTimes(1);
  });

  it('"Connect a source" stays on the Home tab', () => {
    const onNavigate = vi.fn();

    render(
      <SetupGuide
        knowledgeBase={makeKB()}
        indexId="idx-1"
        sources={[]}
        onRefreshSources={vi.fn()}
        onNavigate={onNavigate}
        onFilesSelected={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('Connect a source'));

    expect(mockSetPendingFilter).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

describe('HomeSection upload flow', () => {
  it('dropping files creates a manual source and opens the upload dialog without refreshing', async () => {
    const onRefreshSources = vi.fn();

    mockAddSource.mockResolvedValue({
      source: { _id: 'src-new', name: 'Uploaded Files' },
    });

    render(
      <HomeSection
        knowledgeBase={makeKB()}
        indexId="idx-1"
        sources={[]}
        onRefreshSources={onRefreshSources}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId('drop-files'));
    });

    await waitFor(() => {
      expect(mockAddSource).toHaveBeenCalledWith('idx-1', {
        name: 'File Directory',
        sourceType: 'manual',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('upload-dialog')).toBeInTheDocument();
    });

    expect(onRefreshSources).not.toHaveBeenCalled();
  });

  it('calls onRefreshSources when the upload dialog closes', async () => {
    const onRefreshSources = vi.fn();

    mockAddSource.mockResolvedValue({
      source: { _id: 'src-new', name: 'Uploaded Files' },
    });

    render(
      <HomeSection
        knowledgeBase={makeKB()}
        indexId="idx-1"
        sources={[]}
        onRefreshSources={onRefreshSources}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId('drop-files'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('upload-dialog')).toBeInTheDocument();
    });

    expect(onRefreshSources).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByTestId('dialog-close'));
    });

    expect(onRefreshSources).toHaveBeenCalledTimes(1);
  });

  it('uses an existing manual source instead of creating a new one', async () => {
    const onRefreshSources = vi.fn();

    const existingSource: SearchAISource = {
      _id: 'src-existing',
      tenantId: 't-1',
      indexId: 'idx-1',
      name: 'Existing Manual',
      sourceType: 'manual',
      sourceConfig: {},
      status: 'active',
      extractionConfig: null,
      enrichmentConfig: null,
      syncSchedule: null,
      documentCount: 5,
      lastSyncAt: null,
      syncError: null,
      createdAt: '2026-03-01T00:00:00Z',
      updatedAt: '2026-03-01T00:00:00Z',
    };

    render(
      <HomeSection
        knowledgeBase={makeKB()}
        indexId="idx-1"
        sources={[existingSource]}
        onRefreshSources={onRefreshSources}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId('drop-files'));
    });

    expect(mockAddSource).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(screen.getByTestId('upload-dialog')).toBeInTheDocument();
      expect(screen.getByTestId('dialog-source-id').textContent).toBe('src-existing');
      expect(screen.getByTestId('dialog-source-name').textContent).toBe('Existing Manual');
    });

    expect(onRefreshSources).not.toHaveBeenCalled();
  });

  it('shows an error toast when auto-creating the manual source fails', async () => {
    const onRefreshSources = vi.fn();
    const { toast } = await import('sonner');

    mockAddSource.mockRejectedValue(new Error('Server error'));

    render(
      <HomeSection
        knowledgeBase={makeKB()}
        indexId="idx-1"
        sources={[]}
        onRefreshSources={onRefreshSources}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId('drop-files'));
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });

    expect(screen.queryByTestId('upload-dialog')).not.toBeInTheDocument();
    expect(onRefreshSources).not.toHaveBeenCalled();
  });
});
