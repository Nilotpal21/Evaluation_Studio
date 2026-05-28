'use client';

import useSWR, { type SWRConfiguration } from 'swr';
import { swrConfig } from '../lib/swr-config';

async function fetcher<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'Request failed' }));
    const rawError = (body as { error?: string | { message?: string } }).error;
    const errorMsg =
      typeof rawError === 'string'
        ? rawError
        : rawError && typeof rawError === 'object' && 'message' in rawError
          ? rawError.message
          : `HTTP ${res.status}`;
    throw new Error(errorMsg || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function useApi<T>(url: string | null, options?: SWRConfiguration) {
  const { data, error, isLoading, mutate } = useSWR<T>(url, fetcher, {
    ...swrConfig,
    ...options,
  });

  return {
    data: data ?? null,
    loading: isLoading,
    error: error
      ? error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : typeof error === 'object' && error !== null && 'message' in error
            ? String((error as { message: unknown }).message)
            : 'An unexpected error occurred'
      : null,
    refetch: () => mutate(),
  };
}
