/**
 * useAttributes Hooks
 *
 * SWR hooks for attribute registry management and review queue.
 */

import useSWR from 'swr';
import type {
  AttributeRegistryItem,
  AttributeFilters,
  ReviewQueueResult,
  AttributeStatsResult,
} from '../api/search-ai';

export function useAttributes(indexId: string | null, filters?: AttributeFilters) {
  const params = new URLSearchParams();
  if (filters?.tier) params.set('tier', filters.tier);
  if (filters?.product) params.set('product', filters.product);
  if (filters?.dataType) params.set('dataType', filters.dataType);
  if (filters?.search) params.set('search', filters.search);
  if (filters?.page) params.set('page', String(filters.page ?? 1));
  if (filters?.limit) params.set('limit', String(filters.limit ?? 20));
  const qs = params.toString() ? `?${params}` : '';
  const key = indexId ? `/api/search-ai/indexes/${indexId}/attributes${qs}` : null;
  const { data, error, isLoading, mutate } = useSWR<{
    data: AttributeRegistryItem[];
    total: number;
  }>(key, { revalidateOnFocus: false, dedupingInterval: 5000 });
  return {
    data: data?.data ?? [],
    total: data?.total ?? 0,
    isLoading,
    error: error?.message ?? null,
    mutate,
  };
}

export function useAttributeDetail(indexId: string | null, id: string | null) {
  const key = indexId && id ? `/api/search-ai/indexes/${indexId}/attributes/${id}` : null;
  const { data, error, isLoading, mutate } = useSWR<{
    data: AttributeRegistryItem;
  }>(key, { revalidateOnFocus: false });
  return {
    data: data?.data ?? null,
    isLoading,
    error: error?.message ?? null,
    mutate,
  };
}

export function useReviewQueue(indexId: string | null) {
  const key = indexId ? `/api/search-ai/indexes/${indexId}/attributes/review-queue` : null;
  const { data, error, isLoading, mutate } = useSWR<ReviewQueueResult>(key, {
    revalidateOnFocus: false,
    refreshInterval: 30000,
  });
  return {
    ...(data ?? {
      mergeConflicts: [],
      placementReview: [],
      typeConflicts: [],
      total: 0,
    }),
    isLoading,
    error: error?.message ?? null,
    mutate,
  };
}

export function useAttributeStats(indexId: string | null) {
  const key = indexId ? `/api/search-ai/indexes/${indexId}/attributes/stats` : null;
  const { data, error, isLoading, mutate } = useSWR<AttributeStatsResult>(key, {
    revalidateOnFocus: false,
    dedupingInterval: 10000,
  });
  return {
    data: data ?? null,
    isLoading,
    error: error?.message ?? null,
    mutate,
  };
}
