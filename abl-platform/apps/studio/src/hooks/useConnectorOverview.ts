/**
 * useConnectorOverview Hook
 *
 * SWR hook for connector overview data: KPIs, config summary, content freshness,
 * and permission sync status.
 */

import { useMemo } from 'react';
import useSWR from 'swr';

export interface OverviewData {
  connectorName: string;
  status: 'healthy' | 'syncing' | 'error' | 'paused' | 'disconnected';
  connectedDate: string;
  authenticatedBy: string;
  totalDocuments: number;
  totalSize: number;
  siteCount: number;
  libraryCount: number;
  configSummary: {
    scope: string;
    filters: string;
    schedule: string;
    permissionMode: string;
  };
  contentFreshness: {
    lastSuccessfulSync: string | null;
    scheduledInterval: string | null;
    recentFailedAttempts: number;
  };
  permissionSync: {
    permissionMode: string;
    lastCrawled: string | null;
    coverageTotal: number;
    coverageMapped: number;
    stalenessWarning: boolean;
    nextCrawl: string | null;
  };
}

interface OverviewResponse {
  success: boolean;
  data: OverviewData;
}

export interface UseConnectorOverviewReturn {
  overview: OverviewData | null;
  isLoading: boolean;
  error: string | null;
  mutate: () => void;
}

export function useConnectorOverview(
  indexId: string | null,
  connectorId: string | null,
): UseConnectorOverviewReturn {
  const key =
    indexId && connectorId
      ? `/api/search-ai/indexes/${indexId}/connectors/${connectorId}/overview`
      : null;

  const { data, error, isLoading, mutate } = useSWR<OverviewResponse>(key);

  const overview = useMemo(() => data?.data ?? null, [data]);

  return {
    overview,
    isLoading,
    error: error ? String(error) : null,
    mutate: () => mutate(),
  };
}
