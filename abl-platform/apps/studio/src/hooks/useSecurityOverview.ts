/**
 * useSecurityOverview Hook
 *
 * SWR hook for connector security overview data (scopes, token, access summary).
 */

import { useMemo } from 'react';
import useSWR from 'swr';

export interface ScopeJustification {
  why: string;
  usedFor: string;
  cannotDo: string;
}

export interface SecurityOverview {
  grantedScopes: Array<{
    scope: string;
    description: string;
    grantedAt: string;
    justification?: ScopeJustification;
  }>;
  tokenStatus: { expiresAt: string | null; isExpired: boolean; daysRemaining: number };
  accessSummary: { accesses: string[]; doesNotAccess: string[] };
  approvalGate: { mode: 'none' | 'pending' | 'approved'; approvedBy?: string };
}

interface SecurityOverviewResponse {
  data: SecurityOverview;
}

export function useSecurityOverview(
  indexId: string,
  connectorId: string,
): {
  data: SecurityOverview | null;
  isLoading: boolean;
  error: string | null;
  mutate: () => void;
} {
  const key =
    indexId && connectorId
      ? `/api/search-ai/indexes/${indexId}/connectors/${connectorId}/security/overview`
      : null;

  const { data, error, isLoading, mutate } = useSWR<SecurityOverviewResponse>(key);

  const overview = useMemo(() => data?.data ?? null, [data]);

  return {
    data: overview,
    isLoading,
    error: error ? String(error) : null,
    mutate: () => mutate(),
  };
}
