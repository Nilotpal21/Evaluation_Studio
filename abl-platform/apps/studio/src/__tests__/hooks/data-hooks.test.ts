/**
 * Tests for data / infrastructure hooks:
 * - useKnowledgeBases
 * - useKnowledgeBase
 * - useSearchAIMappings
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

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

// Track SWR calls to distinguish between multiple useSWR in the same hook
const swrCallsByKey: Map<string | null, Record<string, unknown>> = new Map();

vi.mock('swr', () => ({
  default: vi.fn((key: unknown) => {
    const keyStr = key === null ? null : JSON.stringify(key);
    if (swrCallsByKey.has(keyStr)) {
      return swrCallsByKey.get(keyStr);
    }
    return mockSwrReturn;
  }),
  useSWRConfig: vi.fn(() => ({ mutate: vi.fn() })),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { useKnowledgeBases } from '../../hooks/useKnowledgeBases';
import { useKnowledgeBase } from '../../hooks/useKnowledgeBase';
import { useSearchAIMappings } from '../../hooks/useSearchAIMappings';
import useSWR from 'swr';

// ===========================================================================
// useKnowledgeBases
// ===========================================================================

describe('useKnowledgeBases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    swrCallsByKey.clear();
    Object.assign(mockSwrReturn, {
      data: undefined,
      error: undefined,
      isLoading: false,
      mutate: mockMutate,
    });
  });

  it('should pass null key when projectId is null', () => {
    renderHook(() => useKnowledgeBases(null));

    expect(useSWR).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        shouldRetryOnError: false,
        errorRetryCount: 0,
      }),
    );
  });

  it('should construct correct SWR key with projectId', () => {
    renderHook(() => useKnowledgeBases('proj-123'));

    expect(useSWR).toHaveBeenCalledWith(
      '/api/search-ai/knowledge-bases?projectId=proj-123',
      expect.objectContaining({
        shouldRetryOnError: false,
        errorRetryCount: 0,
      }),
    );
  });

  it('should return empty knowledge bases when no data', () => {
    const { result } = renderHook(() => useKnowledgeBases('proj-1'));

    expect(result.current.knowledgeBases).toEqual([]);
    expect(result.current.total).toBe(0);
  });

  it('should return knowledge bases from response data', () => {
    const kbs = [
      {
        _id: 'kb-1',
        tenantId: 't1',
        projectId: 'proj-1',
        name: 'FAQ Base',
        description: 'Frequently asked questions',
        status: 'active',
        searchIndexId: 'idx-1',
        canonicalSchemaId: null,
        connectorCount: 2,
        documentCount: 50,
        lastIndexedAt: '2025-01-01T00:00:00Z',
        indexError: null,
      },
    ];

    Object.assign(mockSwrReturn, {
      data: { knowledgeBases: kbs, total: 1 },
    });

    const { result } = renderHook(() => useKnowledgeBases('proj-1'));

    expect(result.current.knowledgeBases).toHaveLength(1);
    expect(result.current.knowledgeBases[0].name).toBe('FAQ Base');
    expect(result.current.total).toBe(1);
  });

  it('should return isLoading true during fetch', () => {
    Object.assign(mockSwrReturn, { isLoading: true });

    const { result } = renderHook(() => useKnowledgeBases('proj-1'));

    expect(result.current.isLoading).toBe(true);
  });

  it('should return error string when SWR errors', () => {
    Object.assign(mockSwrReturn, { error: new Error('Fetch failed') });

    const { result } = renderHook(() => useKnowledgeBases('proj-1'));

    expect(result.current.error).toBe('Error: Fetch failed');
  });

  it('should return null error when no error', () => {
    Object.assign(mockSwrReturn, { error: undefined });

    const { result } = renderHook(() => useKnowledgeBases('proj-1'));

    expect(result.current.error).toBeNull();
  });

  it('should expose refresh function', () => {
    const { result } = renderHook(() => useKnowledgeBases('proj-1'));

    result.current.refresh();
    expect(mockMutate).toHaveBeenCalled();
  });
});

// ===========================================================================
// useKnowledgeBase
// ===========================================================================

describe('useKnowledgeBase', () => {
  const mockKBMutate = vi.fn();
  const mockSourcesMutate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    swrCallsByKey.clear();

    // Default: both SWR calls return empty
    Object.assign(mockSwrReturn, {
      data: undefined,
      error: undefined,
      isLoading: false,
      mutate: mockKBMutate,
    });
  });

  it('should pass null keys when kbId is null', () => {
    renderHook(() => useKnowledgeBase(null));

    // First call for KB, second for sources — both null with shared options
    expect(useSWR).toHaveBeenNthCalledWith(
      1,
      null,
      expect.objectContaining({ revalidateOnFocus: true }),
    );
    expect(useSWR).toHaveBeenNthCalledWith(
      2,
      null,
      expect.objectContaining({ revalidateOnFocus: true }),
    );
  });

  it('should construct correct SWR key for KB detail', () => {
    renderHook(() => useKnowledgeBase('kb-123'));

    expect(useSWR).toHaveBeenNthCalledWith(
      1,
      '/api/search-ai/knowledge-bases/kb-123',
      expect.objectContaining({ revalidateOnFocus: true }),
    );
    expect(useSWR).toHaveBeenNthCalledWith(
      2,
      null,
      expect.objectContaining({ revalidateOnFocus: true }),
    );
  });

  it('should return null knowledgeBase when no data', () => {
    const { result } = renderHook(() => useKnowledgeBase('kb-1'));

    expect(result.current.knowledgeBase).toBeNull();
    expect(result.current.sources).toEqual([]);
    expect(result.current.sourceCount).toBe(0);
  });

  it('should return knowledge base detail from response', () => {
    const kbDetail = {
      _id: 'kb-1',
      tenantId: 't1',
      projectId: 'proj-1',
      name: 'FAQ Base',
      description: null,
      status: 'active',
      searchIndexId: 'idx-1',
      canonicalSchemaId: null,
      connectorCount: 1,
      documentCount: 10,
      lastIndexedAt: null,
      indexError: null,
      index: null,
    };

    // Use the SWR return for the KB call
    Object.assign(mockSwrReturn, {
      data: { knowledgeBase: kbDetail },
      isLoading: false,
    });

    const { result } = renderHook(() => useKnowledgeBase('kb-1'));

    expect(result.current.knowledgeBase).toEqual(kbDetail);
  });

  it('should return error from kb fetch', () => {
    Object.assign(mockSwrReturn, {
      error: new Error('KB not found'),
    });

    const { result } = renderHook(() => useKnowledgeBase('kb-1'));

    expect(result.current.error).toBe('Error: KB not found');
  });

  it('should combine isLoading from kb and sources', () => {
    Object.assign(mockSwrReturn, { isLoading: true });

    const { result } = renderHook(() => useKnowledgeBase('kb-1'));

    expect(result.current.isLoading).toBe(true);
  });

  it('should expose refresh and refreshSources functions', () => {
    const { result } = renderHook(() => useKnowledgeBase('kb-1'));

    result.current.refresh();
    result.current.refreshSources();
    // Both should call their respective mutates
    expect(mockKBMutate).toHaveBeenCalled();
  });
});

// ===========================================================================
// useSearchAIMappings
// ===========================================================================

describe('useSearchAIMappings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    swrCallsByKey.clear();
    Object.assign(mockSwrReturn, {
      data: undefined,
      error: undefined,
      isLoading: false,
      mutate: mockMutate,
    });
  });

  it('should pass null key when schemaId is null', () => {
    renderHook(() => useSearchAIMappings(null));

    expect(useSWR).toHaveBeenCalledWith(null);
  });

  it('should construct correct SWR key with schemaId', () => {
    renderHook(() => useSearchAIMappings('schema-456'));

    expect(useSWR).toHaveBeenCalledWith('/api/search-ai/mappings?schemaId=schema-456');
  });

  it('should return empty mappings when no data', () => {
    const { result } = renderHook(() => useSearchAIMappings('schema-1'));

    expect(result.current.mappings).toEqual([]);
    expect(result.current.total).toBe(0);
  });

  it('should return mappings from response data', () => {
    const mappings = [
      {
        _id: 'map-1',
        tenantId: 't1',
        canonicalSchemaId: 'schema-1',
        canonicalField: 'title',
        connectorId: 'conn-1',
        sourcePath: 'doc.title',
        transform: { type: 'direct' },
        confidence: 0.95,
        status: 'approved',
        suggestedBy: 'ai',
        reviewedBy: null,
        reviewedAt: null,
      },
    ];

    Object.assign(mockSwrReturn, {
      data: { mappings, total: 1 },
    });

    const { result } = renderHook(() => useSearchAIMappings('schema-1'));

    expect(result.current.mappings).toHaveLength(1);
    expect(result.current.mappings[0].canonicalField).toBe('title');
    expect(result.current.total).toBe(1);
  });

  it('should return isLoading true during fetch', () => {
    Object.assign(mockSwrReturn, { isLoading: true });

    const { result } = renderHook(() => useSearchAIMappings('schema-1'));

    expect(result.current.isLoading).toBe(true);
  });

  it('should return error string when SWR errors', () => {
    Object.assign(mockSwrReturn, { error: 'Server error' });

    const { result } = renderHook(() => useSearchAIMappings('schema-1'));

    expect(result.current.error).toBe('Server error');
  });

  it('should return null error when no error', () => {
    Object.assign(mockSwrReturn, { error: undefined });

    const { result } = renderHook(() => useSearchAIMappings('schema-1'));

    expect(result.current.error).toBeNull();
  });

  it('should expose refresh function', () => {
    const { result } = renderHook(() => useSearchAIMappings('schema-1'));

    result.current.refresh();
    expect(mockMutate).toHaveBeenCalled();
  });
});
