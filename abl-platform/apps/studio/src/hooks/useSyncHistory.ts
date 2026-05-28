/**
 * useSyncHistory Hook
 *
 * SWR hook for paginated connector sync history.
 */

import { useState, useMemo } from 'react';
import useSWR from 'swr';

export interface SyncHistoryEntry {
  date: string;
  type: 'full' | 'delta';
  docsAdded: number;
  docsRemoved: number;
  docsModified: number;
  duration: number; // seconds
  status: 'done' | 'failed' | 'cancelled';
}

interface SyncHistoryResponse {
  success: boolean;
  data: {
    history: SyncHistoryEntry[];
    total: number;
    page: number;
    limit: number;
  };
}

export interface UseSyncHistoryReturn {
  history: SyncHistoryEntry[];
  total: number;
  page: number;
  isLoading: boolean;
  error: string | null;
  mutate: () => void;
  setPage: (page: number) => void;
}

export function useSyncHistory(
  indexId: string | null,
  connectorId: string | null,
  options?: { page?: number; limit?: number },
): UseSyncHistoryReturn {
  const [page, setPage] = useState(options?.page ?? 1);
  const limit = options?.limit ?? 20;

  const key =
    indexId && connectorId
      ? `/api/search-ai/indexes/${indexId}/connectors/${connectorId}/sync-history?page=${page}&limit=${limit}`
      : null;

  const { data, error, isLoading, mutate } = useSWR<SyncHistoryResponse>(key);

  const history = useMemo(() => data?.data?.history ?? [], [data]);
  const total = useMemo(() => data?.data?.total ?? 0, [data]);

  return {
    history,
    total,
    page,
    isLoading,
    error: error ? String(error) : null,
    mutate: () => mutate(),
    setPage,
  };
}
