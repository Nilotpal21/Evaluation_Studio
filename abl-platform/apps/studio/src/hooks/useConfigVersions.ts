/**
 * useConfigVersions Hook
 *
 * SWR hook for paginated connector config version history.
 */

import { useMemo } from 'react';
import useSWR from 'swr';

export interface ConfigVersion {
  _id: string;
  connectorId: string;
  version: number;
  configSnapshot: Record<string, unknown>;
  changedFields: string[];
  changedBy: string;
  changeSource: 'user' | 'system' | 'import' | 'restore';
  summary: string;
  createdAt: string;
}

interface VersionHistoryResponse {
  data: {
    versions: ConfigVersion[];
    total: number;
    page: number;
    limit: number;
  };
}

export function useConfigVersions(
  indexId: string,
  connectorId: string,
  options?: { page?: number; limit?: number },
): {
  versions: ConfigVersion[];
  total: number;
  isLoading: boolean;
  error: string | null;
  mutate: () => void;
} {
  const params = new URLSearchParams();
  if (options?.page !== undefined) params.set('page', String(options.page));
  if (options?.limit !== undefined) params.set('limit', String(options.limit));
  const queryStr = params.toString();

  const key =
    indexId && connectorId
      ? `/api/search-ai/indexes/${indexId}/connectors/${connectorId}/config/versions${queryStr ? `?${queryStr}` : ''}`
      : null;

  const { data, error, isLoading, mutate } = useSWR<VersionHistoryResponse>(key);

  const versions = useMemo(() => data?.data?.versions ?? [], [data]);
  const total = useMemo(() => data?.data?.total ?? 0, [data]);

  return {
    versions,
    total,
    isLoading,
    error: error ? String(error) : null,
    mutate: () => mutate(),
  };
}
