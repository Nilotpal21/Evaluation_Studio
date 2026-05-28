/**
 * Tests for empty indexId guard in KBDetailLayout.
 *
 * When indexId is null and active tab requires it (data, intelligence, search),
 * a placeholder should render instead of the full tab UI.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mock lucide-react (MUST override setup's Proxy mock — Proxy causes hang)
// ---------------------------------------------------------------------------

vi.mock('lucide-react', () => {
  const n = () => null;
  return {
    AlertTriangle: n,
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
    Settings: n,
    ArrowLeft: n,
    Home: n,
    FileText: n,
    Brain: n,
    LayoutGrid: n,
    Plus: n,
    RefreshCw: n,
    Filter: n,
    ChevronUp: n,
    MoreHorizontal: n,
    FileJson: n,
    FileCode: n,
    Maximize2: n,
    Minimize2: n,
    Lock: n,
    Trash2: n,
    Upload: n,
    MonitorSmartphone: n,
    Globe: n,
    Link: n,
    Key: n,
    X: n,
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

vi.mock('../../api/search-ai', () => ({
  executeQuery: vi.fn(),
  resolveVocabulary: vi.fn(),
  getIndex: vi.fn(),
  renameSource: vi.fn(),
  updateCitationConfig: vi.fn().mockResolvedValue({}),
}));

// ---------------------------------------------------------------------------
// Mock sonner
// ---------------------------------------------------------------------------

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// ---------------------------------------------------------------------------
// Mock sanitize-error
// ---------------------------------------------------------------------------

vi.mock('@/lib/sanitize-error', () => ({
  sanitizeError: (_err: unknown, fallback: string) => fallback,
}));

// ---------------------------------------------------------------------------
// Mock Radix-backed Select
// ---------------------------------------------------------------------------

vi.mock('../../components/ui/Select', () => ({
  Select: ({ label, value, onChange, options }: any) => (
    <div>
      {label && <label>{label}</label>}
      <select
        value={value}
        onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onChange?.(e.target.value)}
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
// Mock navigation store
// ---------------------------------------------------------------------------

let mockTab: string | null = null;
const mockSetTab = vi.fn();
const mockSetTabAndSubSection = vi.fn();
const mockNavigate = vi.fn();
const mockSetSubPageLabel = vi.fn();

vi.mock('../../store/navigation-store', () => ({
  useNavigationStore: (selector: (s: any) => any) => {
    const state = {
      projectId: 'proj-1',
      subPage: 'kb-1',
      tab: mockTab,
      navigate: mockNavigate,
      setTab: mockSetTab,
      setTabAndSubSection: mockSetTabAndSubSection,
      setSubPageLabel: mockSetSubPageLabel,
    };
    return selector(state);
  },
}));

// ---------------------------------------------------------------------------
// Mock child components to avoid deep renders
// ---------------------------------------------------------------------------

vi.mock('../../components/search-ai/layout/KBHeader', () => ({
  KBHeader: () => <div data-testid="kb-header">Header</div>,
}));

vi.mock('../../components/search-ai/layout/KBSectionNav', () => ({
  KBSectionNav: ({
    activeSection,
    onSectionChange,
  }: {
    activeSection: string;
    onSectionChange: (s: string) => void;
  }) => (
    <div data-testid="section-nav">
      <button onClick={() => onSectionChange('data')}>Data</button>
      <button onClick={() => onSectionChange('search')}>Search</button>
      <button onClick={() => onSectionChange('home')}>Home</button>
    </div>
  ),
}));

vi.mock('../../components/search-ai/home', () => ({
  HomeSection: () => <div data-testid="home-section">Home Section</div>,
}));

vi.mock('../../components/search-ai/data', () => ({
  DataSection: () => <div data-testid="data-section">Data Section</div>,
}));

vi.mock('../../components/search-ai/intelligence', () => ({
  IntelligenceSection: () => <div data-testid="intelligence-section">Intelligence Section</div>,
}));

vi.mock('../../components/search-ai/search', () => ({
  SearchTestSection: () => <div data-testid="search-section">Search Section</div>,
}));

vi.mock('../../components/search-ai/settings', () => ({
  SettingsPanel: () => null,
}));

vi.mock('../../components/search-ai/hooks/useKBShortcuts', () => ({
  useKBShortcuts: () => {},
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { KBDetailLayout } from '../../components/search-ai/layout/KBDetailLayout';

const baseKB = {
  _id: 'kb-1',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  name: 'Test KB',
  description: null,
  status: 'active',
  searchIndexId: null as string | null,
  canonicalSchemaId: null,
  connectorCount: 0,
  documentCount: 0,
  lastIndexedAt: null,
  indexError: null,
  isPublic: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  index: null,
};

describe('KBDetailLayout — indexId guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTab = null;
    Object.assign(mockSwrReturn, {
      data: undefined,
      error: undefined,
      isLoading: false,
    });
  });

  it('renders home section normally when indexId is null', () => {
    render(
      <KBDetailLayout
        knowledgeBase={baseKB as any}
        sources={[]}
        isLoading={false}
        onRefresh={vi.fn()}
        onRefreshSources={vi.fn()}
      />,
    );

    expect(screen.getByTestId('home-section')).toBeInTheDocument();
  });

  it('shows index-not-ready placeholder for search tab when indexId is null', () => {
    mockTab = 'search';

    render(
      <KBDetailLayout
        knowledgeBase={baseKB as any}
        sources={[]}
        isLoading={false}
        onRefresh={vi.fn()}
        onRefreshSources={vi.fn()}
      />,
    );

    expect(screen.getByText('Index not ready')).toBeInTheDocument();
    expect(screen.queryByTestId('search-section')).not.toBeInTheDocument();
  });

  it('shows index-not-ready placeholder for data tab when indexId is null', () => {
    mockTab = 'data';

    render(
      <KBDetailLayout
        knowledgeBase={baseKB as any}
        sources={[]}
        isLoading={false}
        onRefresh={vi.fn()}
        onRefreshSources={vi.fn()}
      />,
    );

    expect(screen.getByText('Index not ready')).toBeInTheDocument();
    expect(screen.queryByTestId('data-section')).not.toBeInTheDocument();
  });

  it('shows index-not-ready placeholder for intelligence tab when indexId is null', () => {
    mockTab = 'intelligence';

    render(
      <KBDetailLayout
        knowledgeBase={baseKB as any}
        sources={[]}
        isLoading={false}
        onRefresh={vi.fn()}
        onRefreshSources={vi.fn()}
      />,
    );

    expect(screen.getByText('Index not ready')).toBeInTheDocument();
    expect(screen.queryByTestId('intelligence-section')).not.toBeInTheDocument();
  });

  it('renders data section when indexId is present', () => {
    mockTab = 'data';
    const kbWithIndex = { ...baseKB, searchIndexId: 'idx-123' };

    render(
      <KBDetailLayout
        knowledgeBase={kbWithIndex as any}
        sources={[]}
        isLoading={false}
        onRefresh={vi.fn()}
        onRefreshSources={vi.fn()}
      />,
    );

    expect(screen.getByTestId('data-section')).toBeInTheDocument();
    expect(screen.queryByText('Index not ready')).not.toBeInTheDocument();
  });

  it('renders search section when indexId is present', () => {
    mockTab = 'search';
    const kbWithIndex = { ...baseKB, searchIndexId: 'idx-123' };

    render(
      <KBDetailLayout
        knowledgeBase={kbWithIndex as any}
        sources={[]}
        isLoading={false}
        onRefresh={vi.fn()}
        onRefreshSources={vi.fn()}
      />,
    );

    expect(screen.getByTestId('search-section')).toBeInTheDocument();
    expect(screen.queryByText('Index not ready')).not.toBeInTheDocument();
  });
});
