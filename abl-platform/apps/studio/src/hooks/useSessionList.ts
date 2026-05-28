/**
 * useSessionList Hook
 *
 * Fetches /api/sessions with SWR (15s polling, dedup, stale-while-revalidate).
 * Groups sessions by agent name.
 *
 * Note: The runtime session list endpoint defaults to limit=50 (max 200),
 * so this hook is bounded server-side even without an explicit limit param.
 */

import { useMemo } from 'react';
import useSWR from 'swr';
import { useAuthStore } from '../store/auth-store';
import type { SessionListItem } from '../types';

export interface SessionListFilters {
  q?: string;
  agentName?: string | string[];
  environment?: string | string[];
  channel?: string | string[];
  status?: string | string[];
  disposition?: string;
  outcome?: string;
  range?: string;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

interface SessionListResponse {
  success?: boolean;
  sessions: SessionListItem[];
  total?: number;
  offset?: number;
  limit?: number;
}

const SESSION_LIST_REFRESH_INTERVAL_MS = 15_000;

export function useSessionList(projectId?: string | null, filters: SessionListFilters = {}) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  const params = projectId ? `?${buildSessionQuery(projectId, filters).toString()}` : '';
  const key = isAuthenticated && projectId ? `/api/runtime/sessions${params}` : null;

  const { data, error, isLoading, isValidating, mutate } = useSWR<SessionListResponse>(key, {
    refreshInterval: SESSION_LIST_REFRESH_INTERVAL_MS,
    // Keep previous data while revalidating to avoid flicker
    keepPreviousData: true,
  });

  // Show all sessions - voice calls naturally end with caller hangup (disposition='abandoned')
  // but should still appear in the session list as valid history.
  const sessions: SessionListItem[] = data?.sessions ?? [];

  // Group sessions by agent name
  const sessionsByAgent = useMemo(() => {
    const grouped: Record<string, SessionListItem[]> = {};
    for (const session of sessions) {
      const key = session.agentName || 'unknown';
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(session);
    }
    // Sort sessions within each group by lastActivityAt desc
    for (const key of Object.keys(grouped)) {
      grouped[key].sort(
        (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
      );
    }
    return grouped;
  }, [sessions]);

  return {
    sessions,
    total: data?.total ?? sessions.length,
    sessionsByAgent,
    isLoading,
    isValidating,
    error: error ? String(error) : null,
    refresh: () => mutate(),
  };
}

function buildSessionQuery(projectId: string, filters: SessionListFilters): URLSearchParams {
  const params = new URLSearchParams({ projectId });
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      const filtered = value.map((item) => item.trim()).filter(Boolean);
      if (filtered.length > 0) params.set(key, filtered.join(','));
      continue;
    }
    params.set(key, String(value));
  }
  return params;
}
