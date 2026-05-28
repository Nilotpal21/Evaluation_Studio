/**
 * Session Sidebar
 *
 * Shows previous sessions for the current agent with a "New Chat" button.
 * Clicking any session binds the websocket to that session; historical sessions
 * also prefetch full detail/traces over HTTP before resuming so the sidebar,
 * transcript, and observatory stay in sync.
 * Per-session delete (X icon on hover). Collapsible via toggle button.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { MessageSquare, Loader2, X, PanelLeftClose, PanelLeftOpen, Plus } from 'lucide-react';
import { useAgentSessions } from '../../hooks/useAgentSessions';
import { useSessionStore } from '../../store/session-store';
import { useNavigationStore } from '../../store/navigation-store';
import { useWebSocketContext } from '../../contexts/WebSocketContext';
import { useObservatoryStore } from '../../store/observatory-store';
import { apiFetch } from '../../lib/api-client';
import { CallerDataEditor } from './CallerDataEditor';
import type { SessionListItem, SessionMessage } from '../../types';

interface SessionSidebarProps {
  onNewChat: () => void;
}

const RECENT_SESSION_LIMIT = 10;

function formatRelativeTime(
  dateStr: string,
  t: (key: string, values?: Record<string, string | number | Date>) => string,
): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60_000);

  if (diffMin < 1) return t('time_just_now');
  if (diffMin < 60) return t('time_minutes_ago', { count: diffMin });

  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return t('time_hours_ago', { count: diffHr });

  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 7) return t('time_days_ago', { count: diffDays });

  return new Date(dateStr).toLocaleDateString();
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function sessionAgentMatches(sessionAgentName: string, currentAgentName: string): boolean {
  const normalize = (value: string) => value.toLowerCase().replace(/[_\s-]/g, '');
  return normalize(sessionAgentName) === normalize(currentAgentName);
}

function countVisibleMessages(messages: SessionMessage[]): number {
  return messages.filter((message) => message.role === 'user' || message.role === 'assistant')
    .length;
}

function buildRecentSessionSnapshot(params: {
  sessionId: string;
  agentName: string;
  createdAt?: string;
  messageCount: number;
}): SessionListItem {
  const now = new Date().toISOString();

  return {
    id: params.sessionId,
    agentId: params.agentName,
    agentName: params.agentName,
    status: 'active',
    durationMs: 0,
    messageCount: params.messageCount,
    traceEventCount: 0,
    tokenCount: 0,
    estimatedCost: 0,
    errorCount: 0,
    disposition: null,
    channel: 'web_debug',
    createdAt: params.createdAt ?? now,
    lastActivityAt: now,
  };
}

function mergeRecentSession(
  sessions: SessionListItem[],
  session: SessionListItem,
): SessionListItem[] {
  return [session, ...sessions.filter((entry) => entry.id !== session.id)].slice(
    0,
    RECENT_SESSION_LIMIT,
  );
}

export function SessionSidebar({ onNewChat }: SessionSidebarProps) {
  const t = useTranslations('chat.sidebar');
  const projectId = useNavigationStore((s) => s.projectId);
  const navAgentName = useNavigationStore((s) => s.subPage);
  const sessionAgent = useSessionStore((s) => s.agent?.name);
  const agentName = navAgentName || sessionAgent || null;
  const currentSessionId = useSessionStore((s) => s.sessionId);
  const messages = useSessionStore((s) => s.messages);
  const clearSession = useSessionStore((s) => s.clearSession);
  const setSessionError = useSessionStore((s) => s.setError);
  const { sessions, isLoading, refresh } = useAgentSessions(projectId, agentName);
  const { isConnected, resumeSession, switchSession } = useWebSocketContext();
  const sidebarOpen = useObservatoryStore((s) => s.sessionSidebarOpen);
  const toggleSidebar = useObservatoryStore((s) => s.toggleSessionSidebar);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [switchingToId, setSwitchingToId] = useState<string | null>(null);
  const [recentSessions, setRecentSessions] = useState<SessionListItem[]>([]);
  const liveSessionSnapshotRef = useRef<SessionListItem | null>(null);

  useEffect(() => {
    setRecentSessions([]);
    liveSessionSnapshotRef.current = null;
  }, [projectId, agentName]);

  useEffect(() => {
    const previousLiveSession = liveSessionSnapshotRef.current;
    if (previousLiveSession && previousLiveSession.id !== currentSessionId) {
      setRecentSessions((prev) => mergeRecentSession(prev, previousLiveSession));
    }

    if (!currentSessionId) {
      liveSessionSnapshotRef.current = null;
    }

    // Clear switching indicator once the session actually changes
    setSwitchingToId(null);
  }, [currentSessionId]);

  useEffect(() => {
    if (!currentSessionId || !agentName) {
      return;
    }

    const existingSnapshot =
      liveSessionSnapshotRef.current?.id === currentSessionId
        ? liveSessionSnapshotRef.current
        : null;
    liveSessionSnapshotRef.current = buildRecentSessionSnapshot({
      sessionId: currentSessionId,
      agentName,
      createdAt: existingSnapshot?.createdAt,
      messageCount: countVisibleMessages(messages),
    });
  }, [agentName, currentSessionId, messages]);

  useEffect(() => {
    if (sessions.length === 0 || recentSessions.length === 0) {
      return;
    }

    const fetchedIds = new Set(sessions.map((session) => session.id));
    setRecentSessions((prev) => prev.filter((session) => !fetchedIds.has(session.id)));
  }, [recentSessions.length, sessions]);

  const displayedSessions = useMemo(() => {
    const fetchedIds = new Set(sessions.map((session) => session.id));
    const scopedRecentSessions = recentSessions.filter(
      (session) =>
        !fetchedIds.has(session.id) &&
        (!agentName || sessionAgentMatches(session.agentName, agentName)),
    );

    return [...sessions, ...scopedRecentSessions].sort(
      (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
    );
  }, [agentName, recentSessions, sessions]);

  useEffect(() => {
    if (!projectId || !currentSessionId) return;
    refresh();
  }, [currentSessionId, projectId, refresh]);

  const isCurrentSession = (session: { id: string; runtimeSessionId?: string }) =>
    session.id === currentSessionId || session.runtimeSessionId === currentSessionId;

  const handleSessionClick = (session: {
    id: string;
    status?: string;
    runtimeSessionId?: string;
  }) => {
    if (isCurrentSession(session)) return;
    if (switchingToId) return;

    const resumeTargetId = session.runtimeSessionId || session.id;
    setSwitchingToId(session.id);

    if (session.status === 'active') {
      resumeSession(resumeTargetId);
    } else {
      void (async () => {
        try {
          await switchSession(session.id);
          resumeSession(resumeTargetId);
        } catch (err) {
          setSwitchingToId(null);
          const message =
            err instanceof Error && err.message.trim().length > 0
              ? err.message
              : t('load_session_failed');
          setSessionError(message);
        }
      })();
    }
  };

  const handleDeleteSession = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    setDeletingIds((prev) => new Set(prev).add(sessionId));
    try {
      await apiFetch(`/api/runtime/sessions/${sessionId}?projectId=${projectId}`, {
        method: 'DELETE',
      });
      if (sessionId === currentSessionId) {
        clearSession();
      }
      refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[SessionSidebar] Failed to delete session:', msg);
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    }
  };

  // Collapsed state: show a thin rail with expand button
  if (!sidebarOpen) {
    return (
      <div className="w-10 flex-shrink-0 flex flex-col items-center border-r border-default bg-background-subtle h-full py-3 gap-2">
        <button
          onClick={toggleSidebar}
          className="p-1.5 rounded-lg text-muted hover:text-foreground hover:bg-background-muted transition-default cursor-pointer"
          title={t('expand_sessions')}
        >
          <PanelLeftOpen className="w-4 h-4" />
        </button>
        <button
          onClick={onNewChat}
          disabled={!isConnected}
          className="p-1.5 rounded-lg text-muted hover:text-foreground hover:bg-background-muted transition-default cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          title={t('new_chat')}
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="w-56 flex-shrink-0 flex flex-col border-r border-default bg-background-subtle h-full">
      {/* Header: New Chat + controls */}
      <div className="flex-shrink-0 p-3 border-b border-default">
        <div className="flex items-center gap-1">
          <button
            onClick={onNewChat}
            disabled={!isConnected}
            className="flex-1 flex items-center gap-2 px-3 py-2 text-sm font-medium text-foreground bg-background hover:bg-background-muted rounded-lg border border-default transition-default btn-press cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Plus className="w-4 h-4" />
            {t('new_chat')}
          </button>
          <CallerDataEditor />
          <button
            onClick={toggleSidebar}
            className="p-2 rounded-lg text-muted hover:text-foreground hover:bg-background-muted transition-default cursor-pointer"
            title={t('collapse_sessions')}
          >
            <PanelLeftClose className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Session list (filtered by search) */}
      <div className="flex-1 overflow-y-auto">
        {isLoading && displayedSessions.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-4 h-4 text-muted animate-spin" />
          </div>
        ) : displayedSessions.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-subtle">
            {t('no_previous_sessions')}
          </div>
        ) : (
          <div className="py-1">
            {displayedSessions.map((session) => {
              const isCurrent = isCurrentSession(session);
              const isActive = session.status === 'active';
              const isDeleting = deletingIds.has(session.id);
              const isSwitching = switchingToId === session.id;

              return (
                <button
                  key={session.id}
                  onClick={() => handleSessionClick(session)}
                  disabled={isDeleting || !!switchingToId}
                  className={`group relative w-full text-left px-3 py-2.5 text-sm transition-default cursor-pointer hover:bg-background-muted ${
                    isCurrent ? 'bg-accent-subtle border-r-2 border-accent' : ''
                  } ${isDeleting || isSwitching ? 'opacity-70' : ''}`}
                >
                  <div className="flex items-center gap-2">
                    {isSwitching ? (
                      <Loader2 className="w-1.5 h-1.5 flex-shrink-0 text-accent animate-spin" />
                    ) : (
                      <span
                        className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                          isActive ? 'bg-success' : 'bg-subtle'
                        }`}
                      />
                    )}
                    <span className="text-xs text-foreground truncate">
                      {formatRelativeTime(session.lastActivityAt, t)}
                    </span>
                    {!isCurrent && (
                      <span
                        role="button"
                        tabIndex={-1}
                        onClick={(e) => handleDeleteSession(e, session.id)}
                        className="ml-auto opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-background text-subtle hover:text-danger transition-default flex-shrink-0 cursor-pointer"
                      >
                        {isDeleting ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <X className="w-3 h-3" />
                        )}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-1 ml-3.5">
                    <MessageSquare className="w-3 h-3 text-subtle flex-shrink-0" />
                    <span className="text-xs text-muted">
                      {t('message_count', { count: session.messageCount })}
                    </span>
                    <span className="font-mono text-xs text-meta ml-auto" title={session.id}>
                      {shortId(session.id)}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
