/**
 * Tests for QueryPlaygroundTab and QueryDiagnosticCard
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mock lucide-react (MUST override setup's Proxy mock — Proxy causes hang)
// ---------------------------------------------------------------------------

vi.mock('lucide-react', () => {
  const n = () => null;
  return {
    Play: n,
    Zap: n,
    BookOpen: n,
    Copy: n,
    Terminal: n,
    Search: n,
    Loader2: n,
    ChevronDown: n,
    ChevronRight: n,
    Database: n,
    Sparkles: n,
    Activity: n,
    ExternalLink: n,
    Check: n,
  };
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
// Mock API
// ---------------------------------------------------------------------------

const mockExecuteQuery = vi.fn();
const mockResolveVocabulary = vi.fn();

vi.mock('../../api/search-ai', () => ({
  executeQuery: (...args: unknown[]) => mockExecuteQuery(...args),
  resolveVocabulary: (...args: unknown[]) => mockResolveVocabulary(...args),
  renameSource: vi.fn(),
  updateCitationConfig: vi.fn().mockResolvedValue({}),
}));

// ---------------------------------------------------------------------------
// Mock sonner toast
// ---------------------------------------------------------------------------

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// ---------------------------------------------------------------------------
// Mock sanitize-error (alias path matches @/lib/sanitize-error in components)
// ---------------------------------------------------------------------------

vi.mock('@/lib/sanitize-error', () => ({
  sanitizeError: (_err: unknown, fallback: string) => fallback,
}));

// ---------------------------------------------------------------------------
// Mock navigation store
// ---------------------------------------------------------------------------

const mockSetTab = vi.fn();
const mockSetSubSection = vi.fn();

vi.mock('../../store/navigation-store', () => ({
  useNavigationStore: (selector?: (s: any) => any) => {
    const state = { setTab: mockSetTab, setSubSection: mockSetSubSection };
    return selector ? selector(state) : state;
  },
}));

// ---------------------------------------------------------------------------
// Mock Radix-backed Select (registers DOM listeners that hang happy-dom)
// ---------------------------------------------------------------------------

vi.mock('../../components/ui/Select', () => ({
  Select: ({ label, value, onChange, options }: any) => (
    <div>
      {label && <label>{label}</label>}
      <select
        value={value}
        onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onChange?.(e.target.value)}
        data-testid={`select-${label?.toLowerCase().replace(/\s+/g, '-') ?? 'unknown'}`}
      >
        {options?.map((o: any) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  ),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { QueryPlaygroundTab } from '../../components/search-ai/QueryPlaygroundTab';
import { QueryDiagnosticCard } from '../../components/search-ai/search/QueryDiagnosticCard';
import { useSearchTabStore } from '../../store/search-tab-store';

// ===========================================================================
// QueryPlaygroundTab
// ===========================================================================

describe('QueryPlaygroundTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSearchTabStore.getState().reset();
    Object.assign(mockSwrReturn, {
      data: undefined,
      error: undefined,
      isLoading: false,
      isValidating: false,
    });
  });

  it('renders query input and search button', () => {
    render(<QueryPlaygroundTab indexId="idx-1" />);

    expect(screen.getByPlaceholderText('Enter a search query...')).toBeInTheDocument();
    expect(screen.getByText('Search')).toBeInTheDocument();
  });

  it('search button is disabled when query is empty', () => {
    render(<QueryPlaygroundTab indexId="idx-1" />);

    const searchButton = screen.getByText('Search').closest('button')!;
    expect(searchButton).toBeDisabled();
  });

  it('search button enabled when query has text', () => {
    render(<QueryPlaygroundTab indexId="idx-1" />);

    const input = screen.getByPlaceholderText('Enter a search query...');
    fireEvent.change(input, { target: { value: 'test query' } });

    const searchButton = screen.getByText('Search').closest('button')!;
    expect(searchButton).not.toBeDisabled();
  });

  it('shows error on search failure', async () => {
    mockExecuteQuery.mockRejectedValueOnce(new Error('Network error')).mockResolvedValueOnce({
      queryId: 'debug-1',
      results: [],
      latency: {
        totalMs: 0,
        vocabularyResolveMs: 0,
        vectorSearchMs: 0,
        structuredFilterMs: 0,
        rerankMs: 0,
      },
      debugTrace: {
        stages: {},
        totalDurationMs: 0,
      },
    });

    render(<QueryPlaygroundTab indexId="idx-1" />);

    const input = screen.getByPlaceholderText('Enter a search query...');
    fireEvent.change(input, { target: { value: 'test query' } });

    const searchButton = screen.getByText('Search').closest('button')!;
    fireEvent.click(searchButton);

    await waitFor(() => {
      expect(screen.getByText('Search failed')).toBeInTheDocument();
    });
  });

  it('renders empty state when no search performed', () => {
    render(<QueryPlaygroundTab indexId="idx-1" />);

    expect(screen.getByText('Test your search index')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Enter a query above and click Search to see results with latency breakdown and vocabulary resolution.',
      ),
    ).toBeInTheDocument();
  });

  it('disables all action buttons when query is empty', () => {
    render(<QueryPlaygroundTab indexId="idx-1" />);

    const resolveBtn = screen.getByText('Resolve Vocabulary').closest('button')!;
    const copyApiBtn = screen.getByText('Copy API Call').closest('button')!;
    const copyCurlBtn = screen.getByText('Copy as cURL').closest('button')!;

    expect(resolveBtn).toBeDisabled();
    expect(copyApiBtn).toBeDisabled();
    expect(copyCurlBtn).toBeDisabled();
  });
});

// ===========================================================================
// QueryDiagnosticCard
// ===========================================================================

describe('QueryDiagnosticCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mockSwrReturn, {
      data: undefined,
      error: undefined,
      isLoading: false,
      isValidating: false,
      mutate: mockMutate,
    });
  });

  it('shows loading state', () => {
    Object.assign(mockSwrReturn, { isLoading: true });

    render(<QueryDiagnosticCard indexId="idx-1" knowledgeBaseId="kb-1" />);

    expect(screen.getByText('Loading diagnostics...')).toBeInTheDocument();
  });

  it('shows error state', () => {
    Object.assign(mockSwrReturn, { error: new Error('Server error') });

    render(<QueryDiagnosticCard indexId="idx-1" knowledgeBaseId="kb-1" />);

    expect(screen.getByText('Failed to load diagnostics')).toBeInTheDocument();
  });

  it('renders diagnostic sections when data loaded', () => {
    Object.assign(mockSwrReturn, {
      data: {
        index: {
          _id: 'idx-1',
          documentCount: 42,
          chunkCount: 150,
          lastIndexedAt: '2026-03-15T10:00:00Z',
          embeddingModel: 'text-embedding-3-small',
          status: 'active',
          indexError: null,
        },
      },
      isLoading: false,
      error: undefined,
    });

    render(<QueryDiagnosticCard indexId="idx-1" knowledgeBaseId="kb-1" />);

    expect(screen.getByText('Data & Indexing')).toBeInTheDocument();
    expect(screen.getByText('Enrichment')).toBeInTheDocument();
    expect(screen.getByText('Pipeline Health')).toBeInTheDocument();
  });

  it('sections expand on click', () => {
    Object.assign(mockSwrReturn, {
      data: {
        index: {
          _id: 'idx-1',
          documentCount: 42,
          chunkCount: 150,
          lastIndexedAt: '2026-03-15T10:00:00Z',
          embeddingModel: 'text-embedding-3-small',
          status: 'active',
          indexError: null,
        },
      },
      isLoading: false,
      error: undefined,
    });

    render(<QueryDiagnosticCard indexId="idx-1" knowledgeBaseId="kb-1" />);

    // Enrichment is collapsed by default
    expect(screen.queryByText('Vocabulary')).not.toBeInTheDocument();

    // Click to expand
    fireEvent.click(screen.getByText('Enrichment'));

    expect(screen.getByText('Vocabulary')).toBeInTheDocument();
    expect(screen.getByText('Field mappings')).toBeInTheDocument();
  });

  it('displays correct document count from SWR data', () => {
    Object.assign(mockSwrReturn, {
      data: {
        index: {
          _id: 'idx-1',
          documentCount: 42,
          chunkCount: 150,
          lastIndexedAt: '2026-03-15T10:00:00Z',
          embeddingModel: 'text-embedding-3-small',
          status: 'active',
          indexError: null,
        },
      },
      isLoading: false,
      error: undefined,
    });

    render(<QueryDiagnosticCard indexId="idx-1" knowledgeBaseId="kb-1" />);

    // Data & Indexing is defaultOpen
    expect(screen.getByText('Documents')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('Chunks')).toBeInTheDocument();
    expect(screen.getByText('150')).toBeInTheDocument();
  });

  it('displays diagnostics title', () => {
    Object.assign(mockSwrReturn, {
      data: {
        index: {
          _id: 'idx-1',
          documentCount: 0,
          chunkCount: 0,
          lastIndexedAt: null,
          embeddingModel: 'text-embedding-3-small',
          status: 'active',
          indexError: null,
        },
      },
      isLoading: false,
      error: undefined,
    });

    render(<QueryDiagnosticCard indexId="idx-1" knowledgeBaseId="kb-1" />);

    expect(screen.getByText('Diagnostics')).toBeInTheDocument();
  });
});
