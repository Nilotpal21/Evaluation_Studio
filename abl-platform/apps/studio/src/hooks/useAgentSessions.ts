/**
 * useAgentSessions Hook
 *
 * Fetches sessions for a specific agent within a project.
 * Uses SWR with 10s polling while there is an active/current session to watch.
 */

import { useCallback, useMemo } from 'react';
import useSWR from 'swr';
import { useAuthStore } from '../store/auth-store';
import { useSessionStore } from '../store/session-store';
import type { SessionListItem } from '../types';

const POLL_INTERVAL_MS = 10_000;

/**
 * Sessions explicitly archived by the user should be hidden from the sidebar.
 * Other "ended" statuses (abandoned, completed, escalated, ended) represent
 * valid session history and should remain visible so users can review them.
 */
const HIDDEN_STATUSES = new Set(['archived']);

/**
 * Match a project agent slug (e.g. "authentication") against a DSL agent name
 * (e.g. "Authentication_Agent"). Normalises both by lowercasing and stripping
 * underscores / spaces / hyphens, then checks for exact match.
 *
 * Previous `includes()` logic caused false positives — e.g. sessions for
 * "order_review" would also appear under "order" because the normalized
 * "orderreview" contains "order".
 */
function agentNameMatches(sessionAgentName: string, projectSlug: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/[_\s-]/g, '');
  return normalize(sessionAgentName) === normalize(projectSlug);
}

interface SessionListResponse {
  success?: boolean;
  sessions: SessionListItem[];
}

interface UseAgentSessionsResult {
  sessions: SessionListItem[];
  isLoading: boolean;
  hasFetched: boolean;
  error: string | null;
  refresh: () => void;
}

export function useAgentSessions(
  projectId: string | null,
  agentName: string | null,
): UseAgentSessionsResult {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const currentSessionId = useSessionStore((s) => s.sessionId);

  const params = projectId ? `?projectId=${encodeURIComponent(projectId)}&limit=100&mine=true` : '';
  const key = isAuthenticated && projectId ? `/api/runtime/sessions${params}` : null;

  const { data, error, isLoading, mutate } = useSWR<SessionListResponse>(key, {
    refreshInterval: (latestData?: SessionListResponse) => {
      const raw = latestData?.sessions ?? [];
      const hasActiveListedSession = raw.some((session) =>
        ['active', 'idle'].includes(session.status),
      );
      const hasCurrentListedSession = currentSessionId
        ? raw.some((session) => session.id === currentSessionId)
        : false;

      return hasActiveListedSession || (Boolean(currentSessionId) && !hasCurrentListedSession)
        ? POLL_INTERVAL_MS
        : 0;
    },
    keepPreviousData: true,
  });

  const sessions = useMemo(() => {
    const raw = data?.sessions ?? [];

    // Only hide explicitly archived sessions; keep ended/completed/abandoned
    // sessions visible as browsable history (consistent with useSessionList).
    const visible = raw.filter((s) => !s.status || !HIDDEN_STATUSES.has(s.status));

    // Filter by agentName client-side
    const filtered = agentName
      ? visible.filter((s) => agentNameMatches(s.agentName, agentName))
      : visible;

    // Sort by lastActivityAt descending
    filtered.sort(
      (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
    );

    return filtered;
  }, [data, agentName]);

  const refresh = useCallback(() => {
    void mutate();
  }, [mutate]);

  return {
    sessions,
    isLoading,
    hasFetched: !isLoading && data !== undefined,
    error: error ? String(error) : null,
    refresh,
  };
}
