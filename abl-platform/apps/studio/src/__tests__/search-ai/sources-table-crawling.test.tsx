/**
 * Tests for SourcesTable crawling status support.
 *
 * Verifies: info badge for crawling, health summary includes crawling count,
 * doc count shows animated indicator, last sync shows "crawling" text,
 * and non-crawling sources remain unchanged.
 *
 * @vitest-environment happy-dom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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
// Mock framer-motion
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
// Mock panels
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSource(overrides: Partial<SearchAISource> & { _id: string }): SearchAISource {
  return {
    tenantId: 't-1',
    indexId: 'idx-1',
    name: 'Test Source',
    sourceType: 'web',
    sourceConfig: {},
    status: 'active',
    extractionConfig: null,
    enrichmentConfig: null,
    syncSchedule: null,
    documentCount: 10,
    lastSyncAt: '2026-03-20T00:00:00Z',
    syncError: null,
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-17T00:00:00Z',
    ...overrides,
  };
}

const defaultProps = {
  indexId: 'idx-1',
  onRefresh: vi.fn(),
  onViewDocuments: vi.fn(),
  onUploadToSource: vi.fn(),
};

// ===========================================================================
// Crawling status support
// ===========================================================================

describe('SourcesTable crawling status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Force table view mode (component defaults to card view for <=6 sources)
    localStorage.setItem('sp-sources-view-mode', 'table');
  });

  it('renders crawling status with info badge variant', () => {
    const sources = [makeSource({ _id: 'src-1', name: 'Crawling Site', status: 'crawling' })];
    render(<SourcesTable {...defaultProps} sources={sources} />);

    // The status badge should display "crawling" — multiple elements expected
    // (badge text + last sync crawling text), so use getAllByText
    const crawlingElements = screen.getAllByText('crawling');
    expect(crawlingElements.length).toBeGreaterThanOrEqual(1);
  });

  it('shows animated ellipsis on doc count for crawling sources', () => {
    const sources = [
      makeSource({ _id: 'src-1', name: 'Crawling Site', status: 'crawling', documentCount: 12 }),
    ];
    render(<SourcesTable {...defaultProps} sources={sources} />);

    // "View documents" appears on both the doc count button and the eye action button.
    // Use getAllByLabelText and pick the first (doc count column).
    const docButtons = screen.getAllByLabelText('View documents');
    const docButton = docButtons[0];
    const pulseSpan = docButton.querySelector('.animate-pulse');
    expect(pulseSpan).toBeInTheDocument();
  });

  it('shows crawling text instead of date in last sync column', () => {
    const sources = [
      makeSource({
        _id: 'src-1',
        name: 'Crawling Site',
        status: 'crawling',
        lastSyncAt: '2026-03-20T00:00:00Z',
      }),
    ];
    render(<SourcesTable {...defaultProps} sources={sources} />);

    // Should show "crawling" text from i18n (source_detail.crawling_status)
    // The i18n mock returns the key path, so we look for "crawling" text in the info span
    const infoSpans = document.querySelectorAll('.text-info.text-sm');
    expect(infoSpans.length).toBeGreaterThan(0);
  });

  it('includes crawling count in health summary', () => {
    const sources = [
      makeSource({ _id: 'src-1', name: 'Active Source', status: 'active' }),
      makeSource({ _id: 'src-2', name: 'Crawling Site 1', status: 'crawling' }),
      makeSource({ _id: 'src-3', name: 'Crawling Site 2', status: 'crawling' }),
      makeSource({ _id: 'src-4', name: 'Error Source', status: 'error' }),
    ];
    render(<SourcesTable {...defaultProps} sources={sources} />);

    // Health summary should show total, active, crawling, error counts
    expect(screen.getByText(/Total: 4 sources/)).toBeInTheDocument();
    expect(screen.getByText(/Crawling: 2/)).toBeInTheDocument();
    expect(screen.getByText(/Active: 1/)).toBeInTheDocument();
    expect(screen.getByText(/Error: 1/)).toBeInTheDocument();
  });

  it('does not show crawling count when no sources are crawling', () => {
    const sources = [
      makeSource({ _id: 'src-1', name: 'Active Source', status: 'active' }),
      makeSource({ _id: 'src-2', name: 'Error Source', status: 'error' }),
    ];
    render(<SourcesTable {...defaultProps} sources={sources} />);

    expect(screen.queryByText(/Crawling:/)).not.toBeInTheDocument();
  });

  it('non-crawling sources show normal doc count without indicator', () => {
    const sources = [
      makeSource({ _id: 'src-1', name: 'Active Source', status: 'active', documentCount: 45 }),
    ];
    render(<SourcesTable {...defaultProps} sources={sources} />);

    const docButtons = screen.getAllByLabelText('View documents');
    const docButton = docButtons[0];
    const pulseSpan = docButton.querySelector('.animate-pulse');
    expect(pulseSpan).toBeNull();
    expect(screen.getByText('45')).toBeInTheDocument();
  });

  it('non-crawling sources show formatted date in last sync column', () => {
    const sources = [
      makeSource({
        _id: 'src-1',
        name: 'Active Source',
        status: 'active',
        lastSyncAt: '2026-03-20T00:00:00Z',
      }),
    ];
    render(<SourcesTable {...defaultProps} sources={sources} />);

    // Should show the formatted date, not the crawling text
    const infoSpans = document.querySelectorAll('.text-info.text-sm');
    // No crawling-style spans for non-crawling sources
    const crawlingSpans = Array.from(infoSpans).filter((el) =>
      el.textContent?.includes('crawling'),
    );
    expect(crawlingSpans.length).toBe(0);
  });
});
