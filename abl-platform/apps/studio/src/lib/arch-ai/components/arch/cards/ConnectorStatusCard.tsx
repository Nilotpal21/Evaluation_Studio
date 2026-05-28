'use client';

import { memo } from 'react';
import { clsx } from 'clsx';
import type { ConnectorStatusCardEvent } from '@agent-platform/arch-ai';

interface ConnectorStatusCardProps {
  event: ConnectorStatusCardEvent;
}

function authStatusIcon(status: string): { icon: string; color: string } {
  switch (status) {
    case 'authenticated':
    case 'connected':
      return { icon: '🔗', color: 'text-success' };
    case 'pending':
    case 'awaiting_auth':
      return { icon: '🔑', color: 'text-warning' };
    case 'expired':
    case 'revoked':
      return { icon: '🔒', color: 'text-destructive' };
    default:
      return { icon: '⚙', color: 'text-foreground-muted' };
  }
}

function ConnectorStatusCardImpl({ event }: ConnectorStatusCardProps) {
  const auth = authStatusIcon(event.authStatus);

  return (
    <div className="w-full rounded-lg border border-border bg-card p-4 animate-fade-in-up">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-sm">{auth.icon}</span>
          <div>
            <h3 className="text-sm font-semibold text-foreground capitalize">
              {event.connectorType}
            </h3>
            <p className="text-xs text-foreground-muted">{event.kbName}</p>
          </div>
        </div>
        <span className={clsx('text-xs font-medium capitalize', auth.color)}>
          {event.authStatus}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 mb-3">
        <div className="rounded-md bg-muted/50 px-2.5 py-1.5">
          <div className="text-xs text-foreground-muted">Sync Status</div>
          <div className="text-xs font-medium text-foreground capitalize">{event.syncStatus}</div>
        </div>
        {event.lastSyncAt && (
          <div className="rounded-md bg-muted/50 px-2.5 py-1.5">
            <div className="text-xs text-foreground-muted">Last Sync</div>
            <div className="text-xs font-medium text-foreground">
              {new Date(event.lastSyncAt).toLocaleDateString()}
            </div>
          </div>
        )}
      </div>

      {event.syncProgress && (
        <div className="mb-3">
          <div className="flex justify-between text-xs text-foreground-muted mb-1">
            <span>
              {event.syncProgress.processed} / {event.syncProgress.total}
            </span>
            {event.syncProgress.failed > 0 && (
              <span className="text-destructive">{event.syncProgress.failed} failed</span>
            )}
          </div>
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{
                width: `${event.syncProgress.total > 0 ? (event.syncProgress.processed / event.syncProgress.total) * 100 : 0}%`,
              }}
            />
          </div>
        </div>
      )}

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

export const ConnectorStatusCard = memo(ConnectorStatusCardImpl);
