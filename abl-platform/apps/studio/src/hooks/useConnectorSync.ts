/**
 * useConnectorSync Hook
 *
 * SWR hook for connector sync status with conditional polling.
 * Polls at 5s intervals while sync is in progress, stops when idle.
 */

import { useRef, useMemo } from 'react';
import useSWR from 'swr';

export interface SyncStatusResponse {
  status: string;
  syncType?: 'full' | 'delta';
  isActive: boolean;
  progress?: {
    docsProcessed: number;
    docsTotal: number;
    sizeProcessed?: number;
    sizeTotal?: number;
    percentage: number;
    etaSeconds?: number | null;
    currentDocument?: {
      name: string;
      sourceSite: string;
    };
  };
  perSiteProgress?: Array<{
    siteName: string;
    percentage: number;
    docsProcessed: number;
    docsTotal: number;
  }>;
}

export interface UseConnectorSyncReturn {
  syncStatus: SyncStatusResponse | null;
  isLoading: boolean;
  error: string | null;
  mutate: () => void;
}

const ACTIVE_SYNC_STATUSES = new Set(['syncing', 'crawling', 'processing', 'in_progress']);
const DEFAULT_POLL_INTERVAL = 5000;

export function useConnectorSync(
  connectorId: string | null,
  options?: { pollInterval?: number },
): UseConnectorSyncReturn {
  const key = connectorId ? `/api/search-ai/connectors/${connectorId}/sync/status` : null;

  const pollInterval = options?.pollInterval ?? DEFAULT_POLL_INTERVAL;
  const isSyncActiveRef = useRef(false);

  const { data, error, isLoading, mutate } = useSWR<SyncStatusResponse>(key, {
    refreshInterval: isSyncActiveRef.current ? pollInterval : 0,
    onSuccess(responseData) {
      isSyncActiveRef.current = ACTIVE_SYNC_STATUSES.has(responseData.status);
    },
  });

  // Also update ref synchronously from current data for the initial render path
  if (data) {
    isSyncActiveRef.current = ACTIVE_SYNC_STATUSES.has(data.status);
  }

  const syncStatus = useMemo(() => data ?? null, [data]);

  return {
    syncStatus,
    isLoading,
    error: error ? String(error) : null,
    mutate: () => mutate(),
  };
}
