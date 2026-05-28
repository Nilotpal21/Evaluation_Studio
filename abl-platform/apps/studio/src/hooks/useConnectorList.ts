/**
 * useConnectorList Hook
 *
 * SWR hook for the list of connectors on a search index.
 */

import { useMemo } from 'react';
import useSWR from 'swr';
import type { ConnectorDetail } from './useConnector';

interface ConnectorListApiResponse {
  success: boolean;
  data: {
    connectors: ConnectorDetail[];
    total: number;
    page: number;
    limit: number;
    aggregates: Record<string, unknown>;
  };
}

export interface UseConnectorListReturn {
  connectors: ConnectorDetail[];
  total: number;
  isLoading: boolean;
  error: string | null;
  mutate: () => void;
}

export function useConnectorList(indexId: string | null): UseConnectorListReturn {
  const key = indexId ? `/api/search-ai/indexes/${indexId}/connectors` : null;

  const { data, error, isLoading, mutate } = useSWR<ConnectorListApiResponse>(key);

  const connectors = useMemo(() => data?.data?.connectors ?? [], [data]);

  return {
    connectors,
    total: data?.data?.total ?? 0,
    isLoading,
    error: error ? String(error) : null,
    mutate: () => mutate(),
  };
}
