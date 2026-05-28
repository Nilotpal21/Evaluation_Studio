'use client';

import { clsx } from 'clsx';
import { formatDuration, formatCost, formatTimestamp } from '@/components/analytics/shared';
import type { SessionListItem } from './types';

interface SessionCardProps {
  session: SessionListItem;
  selected: boolean;
  onClick: () => void;
}

export function SessionCard({ session, selected, onClick }: SessionCardProps) {
  const borderColor =
    session.errorCount > 0
      ? 'border-l-error'
      : session.lastPhase === 'BUILD'
        ? 'border-l-warning'
        : 'border-l-success';

  return (
    <button
      type="button"
      className={clsx(
        'w-full text-left rounded-md border border-l-4 p-3 transition-colors',
        borderColor,
        selected ? 'bg-accent/10 border-accent' : 'bg-card hover:bg-muted/50 border-border',
      )}
      onClick={onClick}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-mono text-muted-foreground truncate">
          {session.sessionId.slice(0, 12)}…
        </span>
        <span className="text-xs text-muted-foreground">{formatTimestamp(session.startedAt)}</span>
      </div>
      <div className="mt-1.5 flex items-center gap-3 text-xs">
        <span className="text-foreground font-medium">
          {session.turnCount} turn{session.turnCount !== 1 ? 's' : ''}
        </span>
        {session.totalCost > 0 && (
          <span className="text-muted-foreground">{formatCost(session.totalCost)}</span>
        )}
        {session.errorCount > 0 && (
          <span className="text-error font-medium">{session.errorCount} errors</span>
        )}
      </div>
      {session.lastPhase && (
        <div className="mt-1 text-xs text-muted-foreground">Phase: {session.lastPhase}</div>
      )}
    </button>
  );
}
