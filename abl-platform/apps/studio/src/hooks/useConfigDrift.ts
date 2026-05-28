/**
 * useConfigDrift Hook
 *
 * SWR hook for connector config drift detection against template.
 */

import { useMemo } from 'react';
import useSWR from 'swr';

export interface ConfigDrift {
  hasDrift: boolean;
  templateName: string | null;
  templateAppliedAtVersion: string | null;
  deviations: Array<{
    field: string;
    templateValue: unknown;
    currentValue: unknown;
    deviatedAtVersion: string;
  }>;
}

interface DriftResponse {
  data: ConfigDrift;
}

export function useConfigDrift(
  indexId: string,
  connectorId: string,
): {
  drift: ConfigDrift | null;
  isLoading: boolean;
  error: string | null;
  mutate: () => void;
} {
  const key =
    indexId && connectorId
      ? `/api/search-ai/indexes/${indexId}/connectors/${connectorId}/config/drift`
      : null;

  const { data, error, isLoading, mutate } = useSWR<DriftResponse>(key);

  const drift = useMemo(() => data?.data ?? null, [data]);

  return {
    drift,
    isLoading,
    error: error ? String(error) : null,
    mutate: () => mutate(),
  };
}
