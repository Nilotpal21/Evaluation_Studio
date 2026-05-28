'use client';

import { useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { useSessionInspectorStore } from '@/store/session-inspector-store';
import { SessionCard } from './SessionCard';

export function SessionListPanel() {
  const {
    sessions,
    total,
    loading,
    selectedSessionId,
    filters,
    fetchSessions,
    selectSession,
    setFilters,
  } = useSessionInspectorStore();

  const filterKey = JSON.stringify(filters);
  useEffect(() => {
    fetchSessions();
  }, [fetchSessions, filterKey]);

  return (
    <div className="flex h-full flex-col border-r border-border">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <h3 className="text-sm font-medium text-foreground">Sessions</h3>
        <span className="text-xs text-muted-foreground">({total})</span>
      </div>

      <div className="flex flex-wrap gap-1.5 border-b border-border px-3 py-2">
        <button
          type="button"
          className={`rounded-full px-2.5 py-0.5 text-xs transition-colors ${
            filters.hasErrors
              ? 'bg-error/10 text-error'
              : 'bg-muted text-muted-foreground hover:bg-muted/80'
          }`}
          onClick={() => setFilters({ hasErrors: !filters.hasErrors })}
        >
          Has Errors
        </button>
        <button
          type="button"
          className={`rounded-full px-2.5 py-0.5 text-xs transition-colors ${
            filters.from
              ? 'bg-accent/10 text-accent-foreground'
              : 'bg-muted text-muted-foreground hover:bg-muted/80'
          }`}
          onClick={() => {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            setFilters({
              from: filters.from ? undefined : today.toISOString(),
            });
          }}
        >
          Today
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {loading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}
        {!loading && sessions.length === 0 && (
          <div className="py-8 text-center text-sm text-muted-foreground">No sessions found</div>
        )}
        {!loading &&
          sessions.map((session) => (
            <SessionCard
              key={session.sessionId}
              session={session}
              selected={selectedSessionId === session.sessionId}
              onClick={() => selectSession(session.sessionId)}
            />
          ))}
      </div>
    </div>
  );
}
