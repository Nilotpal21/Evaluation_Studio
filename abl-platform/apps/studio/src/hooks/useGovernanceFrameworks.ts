import useSWR from 'swr';
import { useAuthStore } from '../store/auth-store';
import type { FrameworksResponse } from '../lib/governance-contracts';

const SWR_OPTIONS = {
  refreshInterval: 120_000,
  keepPreviousData: true,
};

export function useGovernanceFrameworks(projectId: string | null, period: string = '7d') {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const key =
    isAuthenticated && projectId
      ? `/api/runtime/governance/frameworks?projectId=${encodeURIComponent(projectId)}&period=${encodeURIComponent(period)}`
      : null;

  const { data, error, isLoading, mutate } = useSWR<FrameworksResponse>(key, SWR_OPTIONS);

  return {
    frameworks: data?.data ?? null,
    isLoading,
    error,
    mutate,
  };
}
