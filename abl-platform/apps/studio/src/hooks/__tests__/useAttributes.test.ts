/**
 * Tests for useAttributes hooks:
 * - useAttributes
 * - useAttributeDetail
 * - useReviewQueue
 * - useAttributeStats
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mock SWR
// ---------------------------------------------------------------------------

const mockMutate = vi.fn();
const mockSwrReturn = {
  data: undefined as unknown,
  error: undefined as unknown,
  isLoading: false,
  isValidating: false,
  mutate: mockMutate,
};

let lastSwrKey: unknown = undefined;
let lastSwrOptions: unknown = undefined;

vi.mock('swr', () => ({
  default: vi.fn((key: unknown, options?: unknown) => {
    lastSwrKey = key;
    lastSwrOptions = options;
    return mockSwrReturn;
  }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  useAttributes,
  useAttributeDetail,
  useReviewQueue,
  useAttributeStats,
} from '../useAttributes';
import useSWR from 'swr';

// ===========================================================================
// useAttributes
// ===========================================================================

describe('useAttributes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mockSwrReturn, {
      data: undefined,
      error: undefined,
      isLoading: false,
      mutate: mockMutate,
    });
  });

  it('should return null key when indexId is null', () => {
    renderHook(() => useAttributes(null));
    expect(lastSwrKey).toBeNull();
  });

  it('should return null key when indexId is empty string', () => {
    renderHook(() => useAttributes(''));
    expect(lastSwrKey).toBeNull();
  });

  it('should construct correct URL with no filters', () => {
    renderHook(() => useAttributes('idx-1'));
    expect(lastSwrKey).toBe('/api/search-ai/indexes/idx-1/attributes');
  });

  it('should construct correct URL with tier filter', () => {
    renderHook(() => useAttributes('idx-1', { tier: 'approved' }));
    expect(lastSwrKey).toBe('/api/search-ai/indexes/idx-1/attributes?tier=approved');
  });

  it('should construct correct URL with search filter', () => {
    renderHook(() => useAttributes('idx-1', { search: 'price' }));
    expect(lastSwrKey).toBe('/api/search-ai/indexes/idx-1/attributes?search=price');
  });

  it('should construct correct URL with multiple filters', () => {
    renderHook(() =>
      useAttributes('idx-1', {
        tier: 'beta',
        product: 'search',
        dataType: 'string',
        search: 'name',
      }),
    );
    const key = lastSwrKey as string;
    expect(key).toContain('tier=beta');
    expect(key).toContain('product=search');
    expect(key).toContain('dataType=string');
    expect(key).toContain('search=name');
  });

  it('should construct correct URL with pagination (page, limit)', () => {
    renderHook(() => useAttributes('idx-1', { page: 2, limit: 50 }));
    const key = lastSwrKey as string;
    expect(key).toContain('page=2');
    expect(key).toContain('limit=50');
  });

  it('should return empty data and zero total when no SWR data', () => {
    const { result } = renderHook(() => useAttributes('idx-1'));
    expect(result.current.data).toEqual([]);
    expect(result.current.total).toBe(0);
  });

  it('should transform populated SWR data correctly', () => {
    const mockItems = [
      { _id: 'a1', attributeId: 'price', displayName: 'Price' },
      { _id: 'a2', attributeId: 'color', displayName: 'Color' },
    ];
    Object.assign(mockSwrReturn, { data: { data: mockItems, total: 42 } });
    const { result } = renderHook(() => useAttributes('idx-1'));
    expect(result.current.data).toEqual(mockItems);
    expect(result.current.total).toBe(42);
  });

  it('should return error string when SWR errors', () => {
    Object.assign(mockSwrReturn, { error: { message: 'Network error' } });
    const { result } = renderHook(() => useAttributes('idx-1'));
    expect(result.current.error).toBe('Network error');
  });

  it('should return null error on success', () => {
    Object.assign(mockSwrReturn, { error: undefined });
    const { result } = renderHook(() => useAttributes('idx-1'));
    expect(result.current.error).toBeNull();
  });

  it('should pass revalidateOnFocus: false and dedupingInterval: 5000', () => {
    renderHook(() => useAttributes('idx-1'));
    expect(useSWR).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        revalidateOnFocus: false,
        dedupingInterval: 5000,
      }),
    );
  });
});

// ===========================================================================
// useAttributeDetail
// ===========================================================================

describe('useAttributeDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mockSwrReturn, {
      data: undefined,
      error: undefined,
      isLoading: false,
      mutate: mockMutate,
    });
  });

  it('should return null key when indexId is empty', () => {
    renderHook(() => useAttributeDetail('', 'attr-1'));
    expect(lastSwrKey).toBeNull();
  });

  it('should return null key when indexId is null', () => {
    renderHook(() => useAttributeDetail(null, 'attr-1'));
    expect(lastSwrKey).toBeNull();
  });

  it('should return null key when attributeId is empty', () => {
    renderHook(() => useAttributeDetail('idx-1', ''));
    expect(lastSwrKey).toBeNull();
  });

  it('should return null key when attributeId is null', () => {
    renderHook(() => useAttributeDetail('idx-1', null));
    expect(lastSwrKey).toBeNull();
  });

  it('should construct correct URL with both params', () => {
    renderHook(() => useAttributeDetail('idx-1', 'attr-42'));
    expect(lastSwrKey).toBe('/api/search-ai/indexes/idx-1/attributes/attr-42');
  });

  it('should return null data when no SWR data', () => {
    const { result } = renderHook(() => useAttributeDetail('idx-1', 'attr-1'));
    expect(result.current.data).toBeNull();
  });
});

// ===========================================================================
// useReviewQueue
// ===========================================================================

describe('useReviewQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mockSwrReturn, {
      data: undefined,
      error: undefined,
      isLoading: false,
      mutate: mockMutate,
    });
  });

  it('should return null key when indexId is empty', () => {
    renderHook(() => useReviewQueue(''));
    expect(lastSwrKey).toBeNull();
  });

  it('should return null key when indexId is null', () => {
    renderHook(() => useReviewQueue(null));
    expect(lastSwrKey).toBeNull();
  });

  it('should construct correct URL', () => {
    renderHook(() => useReviewQueue('idx-1'));
    expect(lastSwrKey).toBe('/api/search-ai/indexes/idx-1/attributes/review-queue');
  });

  it('should have 30s refresh interval in SWR options', () => {
    renderHook(() => useReviewQueue('idx-1'));
    expect(useSWR).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        refreshInterval: 30000,
      }),
    );
  });

  it('should return { total: 0 } structure when no data', () => {
    const { result } = renderHook(() => useReviewQueue('idx-1'));
    expect(result.current.total).toBe(0);
    expect(result.current.mergeConflicts).toEqual([]);
    expect(result.current.placementReview).toEqual([]);
    expect(result.current.typeConflicts).toEqual([]);
  });
});

// ===========================================================================
// useAttributeStats
// ===========================================================================

describe('useAttributeStats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mockSwrReturn, {
      data: undefined,
      error: undefined,
      isLoading: false,
      mutate: mockMutate,
    });
  });

  it('should return null key when indexId is empty', () => {
    renderHook(() => useAttributeStats(''));
    expect(lastSwrKey).toBeNull();
  });

  it('should return null key when indexId is null', () => {
    renderHook(() => useAttributeStats(null));
    expect(lastSwrKey).toBeNull();
  });

  it('should construct correct URL', () => {
    renderHook(() => useAttributeStats('idx-1'));
    expect(lastSwrKey).toBe('/api/search-ai/indexes/idx-1/attributes/stats');
  });

  it('should return null data when no SWR data', () => {
    const { result } = renderHook(() => useAttributeStats('idx-1'));
    expect(result.current.data).toBeNull();
  });

  it('should pass dedupingInterval: 10000 in SWR options', () => {
    renderHook(() => useAttributeStats('idx-1'));
    expect(useSWR).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        dedupingInterval: 10000,
      }),
    );
  });
});
