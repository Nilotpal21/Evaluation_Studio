'use client';

import { memo } from 'react';
import { clsx } from 'clsx';
import type { KBStatusCardEvent } from '@agent-platform/arch-ai';

interface KBStatusCardProps {
  event: KBStatusCardEvent;
}

function statusColor(status: string): string {
  switch (status) {
    case 'active':
    case 'ready':
      return 'text-success';
    case 'building':
    case 'indexing':
      return 'text-warning';
    case 'error':
      return 'text-destructive';
    default:
      return 'text-foreground-muted';
  }
}

function KBStatusCardImpl({ event }: KBStatusCardProps) {
  return (
    <div className="w-full rounded-lg border border-border bg-card p-4 animate-fade-in-up">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-primary text-sm">
            KB
          </span>
          <h3 className="text-sm font-semibold text-foreground truncate">{event.kbName}</h3>
        </div>
        <span className={clsx('text-xs font-medium capitalize', statusColor(event.status))}>
          {event.status}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 mb-3">
        <StatCell label="Documents" value={event.stats.documentCount} />
        <StatCell label="Chunks" value={event.stats.chunkCount} />
        <StatCell label="Sources" value={event.stats.sourceCount} />
        <StatCell label="Connectors" value={event.stats.connectorCount} />
      </div>

      {event.actions.length > 0 && (
        <div className="flex gap-2 border-t border-border pt-2">
          {event.actions.map((a) => (
            <button
              key={a.action}
              className={clsx(
                'rounded-md px-2.5 py-1 text-xs transition-colors',
                a.variant === 'primary'
                  ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                  : 'bg-muted text-foreground hover:bg-muted/80',
              )}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function StatCell({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-muted/50 px-2.5 py-1.5">
      <div className="text-xs text-foreground-muted">{label}</div>
      <div className="text-sm font-semibold text-foreground">{value.toLocaleString()}</div>
    </div>
  );
}

export const KBStatusCard = memo(KBStatusCardImpl);
