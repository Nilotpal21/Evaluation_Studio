/**
 * useSearchAIMappings Hook
 *
 * SWR hook for field mappings by canonical schema ID.
 */

import { useMemo } from 'react';
import useSWR from 'swr';
import type { FieldMappingData } from '../api/search-ai';

interface MappingsResponse {
  mappings: FieldMappingData[];
  total: number;
}

interface UseSearchAIMappingsOptions {
  status?: 'suggested' | 'confirmed' | 'active';
  includeSystemFields?: boolean;
}

interface UseSearchAIMappingsReturn {
  mappings: FieldMappingData[];
  total: number;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useSearchAIMappings(
  schemaId: string | null,
  options?: UseSearchAIMappingsOptions,
): UseSearchAIMappingsReturn {
  const key = useMemo(() => {
    if (!schemaId) return null;
    const params = new URLSearchParams({ schemaId });
    if (options?.status) params.set('status', options.status);
    if (options?.includeSystemFields) params.set('includeSystemFields', 'true');
    return `/api/search-ai/mappings?${params.toString()}`;
  }, [schemaId, options?.status, options?.includeSystemFields]);

  const { data, error, isLoading, mutate } = useSWR<MappingsResponse>(key);

  const mappings = useMemo(() => data?.mappings ?? [], [data]);

  return {
    mappings,
    total: data?.total ?? 0,
    isLoading,
    error: error ? String(error) : null,
    refresh: () => mutate(),
  };
}
