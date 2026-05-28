/**
 * useTransferSessions Hook
 *
 * Fetches active transfer sessions for the current project.
 * Uses SWR with 30-second polling for near-real-time monitoring.
 */

'use client';

import useSWR from 'swr';
import { listTransferSessions, type TransferSession } from '../api/agent-transfer';
import { useNavigationStore } from '../store/navigation-store';

export function useTransferSessions(filters?: {
  provider?: string;
  state?: string;
  channel?: string;
}) {
  const { projectId } = useNavigationStore();

  const { data, error, isLoading, mutate } = useSWR<TransferSession[]>(
    projectId ? ['transfer-sessions', projectId, JSON.stringify(filters)] : null,
    () => listTransferSessions(projectId!, filters),
    { refreshInterval: 30_000, keepPreviousData: true },
  );

  return {
    sessions: data ?? [],
    isLoading,
    error: error ? String(error) : null,
    refresh: () => mutate(),
  };
}
