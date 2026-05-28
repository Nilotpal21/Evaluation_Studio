/**
 * useConnector Hook
 *
 * SWR hook for a single connector detail by indexId and connectorId.
 */

import { useMemo } from 'react';
import useSWR from 'swr';

export interface ConnectorDetail {
  _id: string;
  tenantId: string;
  sourceId: string;
  connectorType: string;
  connectionConfig: Record<string, unknown>;
  syncState: {
    lastFullSyncAt: string | null;
    lastDeltaSyncAt: string | null;
    totalDocuments: number;
    processedDocuments: number;
    failedDocuments: number;
    syncInProgress: boolean;
    currentJobId: string | null;
    lastSyncError: string | null;
  };
  filterConfig: Record<string, unknown>;
  permissionConfig: {
    mode: 'enabled' | 'disabled';
    crawlSchedule: string | null;
    lastCrawlAt: string | null;
    crawlInProgress: boolean;
    documentsProcessed: number;
    averageAccuracy: number;
    lastCrawlError: string | null;
  };
  errorState: {
    consecutiveFailures: number;
    lastErrorAt: string | null;
    lastErrorMessage: string | null;
    isPaused: boolean;
    pausedAt: string | null;
    pauseReason: string | null;
  };
  oauthTokenId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ConnectorApiResponse {
  success: boolean;
  data: {
    connector: ConnectorDetail;
    source?: Record<string, unknown>;
  };
}

export interface UseConnectorReturn {
  connector: ConnectorDetail | null;
  isLoading: boolean;
  error: string | null;
  mutate: () => Promise<unknown>;
}

export function useConnector(
  indexId: string | null,
  connectorId: string | null,
): UseConnectorReturn {
  const key =
    indexId && connectorId && connectorId !== 'new'
      ? `/api/search-ai/indexes/${indexId}/connectors/${connectorId}`
      : null;

  const { data, error, isLoading, mutate } = useSWR<ConnectorApiResponse>(key);

  const connector = useMemo(() => data?.data?.connector ?? null, [data]);

  return {
    connector,
    isLoading,
    error: error ? String(error) : null,
    mutate: () => mutate(),
  };
}
