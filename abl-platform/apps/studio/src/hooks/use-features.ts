/**
 * Feature Flag Hook
 *
 * Client-side hook for checking feature availability.
 * Uses SWR for caching and deduplication.
 *
 * Fails closed: if the API is unreachable, all features default to false.
 */

import useSWR from 'swr';
import { apiFetch } from '@/lib/api-client';

interface FeatureFlags {
  reusable_modules: boolean;
  code_tools: boolean;
  governance: boolean;
}

interface UseFeatures {
  hasModules: boolean;
  hasCodeTools: boolean;
  hasGovernance: boolean;
  isLoading: boolean;
}

const FALLBACK: FeatureFlags = { reusable_modules: false, code_tools: false, governance: false };

const fetcher = async (url: string): Promise<FeatureFlags> => {
  try {
    const res = await apiFetch(url);
    if (!res.ok) {
      // Fail closed — return all features disabled
      return FALLBACK;
    }
    const json = await res.json();
    return json.data ?? FALLBACK;
  } catch {
    return FALLBACK;
  }
};

/**
 * Hook to check feature availability for the current tenant.
 * Fails closed: if the API is unreachable, all features default to false.
 */
export function useFeatures(): UseFeatures {
  const { data, isLoading } = useSWR<FeatureFlags>('/api/features', fetcher, {
    refreshInterval: 60_000,
    dedupingInterval: 30_000,
    fallbackData: FALLBACK,
    onErrorRetry: (_error, _key, _config, revalidate, { retryCount }) => {
      // Only retry 3 times, then stop
      if (retryCount >= 3) return;
      setTimeout(() => revalidate({ retryCount }), 5_000);
    },
  });

  return {
    hasModules: data?.reusable_modules ?? false,
    hasCodeTools: data?.code_tools ?? false,
    hasGovernance: data?.governance ?? false,
    isLoading,
  };
}
