/**
 * useContentBreakdown Hook
 *
 * SWR hook for connector content breakdown: by-type and by-site aggregations.
 * Separated from useConnectorOverview because this query is slower (1-2s).
 */

import { useMemo } from 'react';
import useSWR from 'swr';

export interface ContentBreakdownData {
  byType: Array<{ type: string; count: number; percentage: number }>;
  bySite: Array<{ siteName: string; docCount: number; size: number }>;
}

interface ContentBreakdownResponse {
  success: boolean;
  data: ContentBreakdownData;
}

export interface UseContentBreakdownReturn {
  breakdown: ContentBreakdownData | null;
  isLoading: boolean;
  error: string | null;
  mutate: () => void;
}

export function useContentBreakdown(
  indexId: string | null,
  connectorId: string | null,
): UseContentBreakdownReturn {
  const key =
    indexId && connectorId
      ? `/api/search-ai/indexes/${indexId}/connectors/${connectorId}/content-breakdown`
      : null;

  const { data, error, isLoading, mutate } = useSWR<ContentBreakdownResponse>(key);

  const breakdown = useMemo(() => data?.data ?? null, [data]);

  return {
    breakdown,
    isLoading,
    error: error ? String(error) : null,
    mutate: () => mutate(),
  };
}
