/**
 * Tests for WaitingForContent component
 *
 * @vitest-environment happy-dom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { KnowledgeBaseDetail, SearchAISource } from '../../api/search-ai';

// ---------------------------------------------------------------------------
// Mock lucide-react — explicit object (Proxy mock from setup.tsx hangs)
// ---------------------------------------------------------------------------

vi.mock('lucide-react', () => {
  const n = () => null;
  return { Upload: n, Plus: n, Settings: n };
});

// ---------------------------------------------------------------------------
// Mock stores
// ---------------------------------------------------------------------------

const mockSetPendingFilter = vi.fn();

vi.mock('../../store/data-tab-filter-store', () => ({
  useDataTabFilterStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      setPendingFilter: mockSetPendingFilter,
    }),
}));

// Import component under test (after mocks)
// ---------------------------------------------------------------------------

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
    connectorCount: 2,
    documentCount: 0,
    lastIndexedAt: null,
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
      documentCount: 0,
      chunkCount: 0,
      sourceCount: 2,
      lastIndexedAt: null,
      indexError: null,
      createdAt: '2026-03-01T00:00:00Z',
      updatedAt: '2026-03-17T00:00:00Z',
    },
    ...overrides,
  };
}

function makeSources(configs: Array<Partial<SearchAISource>>): SearchAISource[] {
  return configs.map((cfg, i) => ({
    _id: `src-${i}`,
    tenantId: 't-1',
    indexId: 'idx-1',
    name: cfg.name ?? `Source ${i}`,
    sourceType: cfg.sourceType ?? 'sharepoint',
    sourceConfig: {},
    status: cfg.status ?? 'active',
    extractionConfig: null,
    enrichmentConfig: null,
    syncSchedule: null,
    documentCount: cfg.documentCount ?? 0,
    lastSyncAt: null,
    syncError: null,
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-17T00:00:00Z',
    ...cfg,
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WaitingForContent', () => {
  const onRefreshSources = vi.fn();
  const onNavigate = vi.fn();
  const onUploadFiles = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders source mini-table with source names', () => {
    const sources = makeSources([
      { name: 'SharePoint Docs', sourceType: 'sharepoint' },
      { name: 'Web Crawler', sourceType: 'crawler' },
    ]);
    render(
      <WaitingForContent
        knowledgeBase={makeKB()}
        indexId="idx-1"
        sources={sources}
        onRefreshSources={onRefreshSources}
        onNavigate={onNavigate}
      />,
    );

    expect(screen.getByText('SharePoint Docs')).toBeInTheDocument();
    expect(screen.getByText('Web Crawler')).toBeInTheDocument();
  });

  it('shows correct status badges', () => {
    const sources = makeSources([
      { name: 'Active Source', status: 'active' },
      { name: 'Syncing Source', status: 'syncing' },
    ]);
    render(
      <WaitingForContent
        knowledgeBase={makeKB()}
        indexId="idx-1"
        sources={sources}
        onRefreshSources={onRefreshSources}
      />,
    );

    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText('syncing')).toBeInTheDocument();
  });

  it('upload button navigates to Data tab when no manual source exists', () => {
    const sources = makeSources([{ name: 'SharePoint', sourceType: 'sharepoint' }]);
    render(
      <WaitingForContent
        knowledgeBase={makeKB()}
        indexId="idx-1"
        sources={sources}
        onRefreshSources={onRefreshSources}
        onNavigate={onNavigate}
      />,
    );

    fireEvent.click(screen.getByText('Upload files'));

    expect(mockSetPendingFilter).toHaveBeenCalledWith({
      view: 'documents',
      autoOpenAddSource: true,
    });
    expect(onNavigate).toHaveBeenCalledWith('data');
  });

  it('upload button delegates to the parent upload handler when manual source exists', () => {
    const sources = makeSources([{ name: 'Manual Files', sourceType: 'manual' }]);
    render(
      <WaitingForContent
        knowledgeBase={makeKB()}
        indexId="idx-1"
        sources={sources}
        onRefreshSources={onRefreshSources}
        onNavigate={onNavigate}
        onUploadFiles={onUploadFiles}
      />,
    );

    fireEvent.click(screen.getByText('Upload files'));

    // Should NOT navigate away — delegates to parent via onUploadFiles
    expect(onNavigate).not.toHaveBeenCalled();
    expect(onUploadFiles).toHaveBeenCalledTimes(1);
  });

  it('add source button calls setPendingFilter + onNavigate', () => {
    const sources = makeSources([{ name: 'Source A' }]);
    render(
      <WaitingForContent
        knowledgeBase={makeKB()}
        indexId="idx-1"
        sources={sources}
        onRefreshSources={onRefreshSources}
        onNavigate={onNavigate}
      />,
    );

    fireEvent.click(screen.getByText('Add another source'));

    expect(mockSetPendingFilter).toHaveBeenCalledWith({ autoOpenAddSource: true });
    expect(onNavigate).toHaveBeenCalledWith('data');
  });

  it('configure button navigates to intelligence tab', () => {
    const sources = makeSources([{ name: 'Source A' }]);
    render(
      <WaitingForContent
        knowledgeBase={makeKB()}
        indexId="idx-1"
        sources={sources}
        onRefreshSources={onRefreshSources}
        onNavigate={onNavigate}
      />,
    );

    fireEvent.click(screen.getByText('Configure'));

    expect(onNavigate).toHaveBeenCalledWith('intelligence');
  });
});
