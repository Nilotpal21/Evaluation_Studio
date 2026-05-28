/**
 * useConnections Hook
 *
 * Fetches and manages the connections list for a project.
 * Uses SWR for dedup, stale-while-revalidate, and background refresh.
 */

'use client';

import { useMemo } from 'react';
import useSWR from 'swr';
import { type ConnectionSummary, normalizeConnection } from '../api/connections';

interface ConnectionsResponse {
  success: boolean;
  // Raw API shape uses _id; normalizeConnection maps to id
  data: Array<Record<string, unknown>>;
}

interface UseConnectionsReturn {
  connections: ConnectionSummary[];
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useConnections(projectId: string | null): UseConnectionsReturn {
  const key = projectId ? `/api/projects/${encodeURIComponent(projectId)}/connections` : null;

  const { data, error, isLoading, mutate } = useSWR<ConnectionsResponse>(key, {
    keepPreviousData: true,
  });

  const connections: ConnectionSummary[] = useMemo(
    () =>
      (data?.data ?? []).map((raw) =>
        normalizeConnection(raw as unknown as Parameters<typeof normalizeConnection>[0]),
      ),
    [data],
  );

  return {
    connections,
    isLoading,
    error: error ? String(error) : null,
    refresh: () => mutate(),
  };
}
