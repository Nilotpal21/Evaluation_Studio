/**
 * useAuditLog Hook
 *
 * SWR hook for paginated connector audit log entries.
 */

import { useMemo } from 'react';
import useSWR from 'swr';

export interface AuditLogEntry {
  _id: string;
  connectorId: string;
  actor: string;
  actorType: string;
  event: string;
  category: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

interface AuditLogResponse {
  data: {
    entries: AuditLogEntry[];
    total: number;
    page: number;
    limit: number;
  };
}

export function useAuditLog(
  indexId: string,
  connectorId: string,
  options: { category?: string; page?: number; limit?: number },
): {
  entries: AuditLogEntry[];
  total: number;
  isLoading: boolean;
  error: string | null;
} {
  const params = new URLSearchParams();
  if (options.category) params.set('category', options.category);
  if (options.page !== undefined) params.set('page', String(options.page));
  if (options.limit !== undefined) params.set('limit', String(options.limit));

  const queryStr = params.toString();
  const key =
    indexId && connectorId
      ? `/api/search-ai/indexes/${indexId}/connectors/${connectorId}/audit-log?${queryStr}`
      : null;

  const { data, error, isLoading } = useSWR<AuditLogResponse>(key);

  const entries = useMemo(() => data?.data?.entries ?? [], [data]);
  const total = useMemo(() => data?.data?.total ?? 0, [data]);

  return {
    entries,
    total,
    isLoading,
    error: error ? String(error) : null,
  };
}
