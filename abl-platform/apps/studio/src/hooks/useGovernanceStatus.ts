import useSWR from 'swr';
import { useAuthStore } from '../store/auth-store';
import type { StatusResponse } from '../lib/governance-contracts';

const SWR_OPTIONS = {
  refreshInterval: 60_000,
  keepPreviousData: true,
};

export function useGovernanceStatus(projectId: string | null, period: string = '7d') {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const key =
    isAuthenticated && projectId
      ? `/api/runtime/governance/status?projectId=${encodeURIComponent(projectId)}&period=${encodeURIComponent(period)}`
      : null;

  const { data, error, isLoading, mutate } = useSWR<StatusResponse>(key, SWR_OPTIONS);

  return {
    statusData: data?.data ?? null,
    isLoading,
    error,
    mutate,
  };
}
