'use client';

import { memo } from 'react';
import { clsx } from 'clsx';
import type { UploadProgressCardEvent } from '@agent-platform/arch-ai';

interface UploadProgressCardProps {
  event: UploadProgressCardEvent;
}

function fileStatusIcon(status: string): { icon: string; color: string } {
  switch (status) {
    case 'complete':
    case 'ready':
      return { icon: '✓', color: 'text-success' };
    case 'processing':
    case 'extracting':
    case 'embedding':
      return { icon: '⟳', color: 'text-warning' };
    case 'error':
    case 'failed':
      return { icon: '✕', color: 'text-destructive' };
    case 'queued':
    case 'pending':
      return { icon: '○', color: 'text-foreground-muted' };
    default:
      return { icon: '·', color: 'text-foreground-muted' };
  }
}

function UploadProgressCardImpl({ event }: UploadProgressCardProps) {
  const completedCount = event.files.filter(
    (f) => f.status === 'complete' || f.status === 'ready',
  ).length;
  const allDone = completedCount === event.files.length;

  return (
    <div
      className={clsx(
        'w-full rounded-lg border p-4 animate-fade-in-up',
        allDone ? 'border-success/30 bg-success/5' : 'border-border bg-card',
      )}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-primary text-xs">
            📄
          </span>
          <div>
            <h3 className="text-sm font-semibold text-foreground">Uploading to {event.kbName}</h3>
            <p className="text-xs text-foreground-muted">
              {completedCount} / {event.files.length} files
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-1.5 mb-3 max-h-40 overflow-y-auto">
        {event.files.map((f, i) => {
          const { icon, color } = fileStatusIcon(f.status);
          return (
            <div key={i} className="flex items-center gap-2 rounded-md bg-muted/50 px-2.5 py-1.5">
              <span className={clsx('text-xs', color)}>{icon}</span>
              <span className="text-xs text-foreground truncate flex-1">{f.name}</span>
              <div className="flex items-center gap-1.5">
                {f.stage && (
                  <span className="text-[10px] text-foreground-muted capitalize">{f.stage}</span>
                )}
                {f.progress != null && f.progress < 100 && (
                  <div className="w-12 h-1 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-primary transition-all"
                      style={{ width: `${f.progress}%` }}
                    />
                  </div>
                )}
              </div>
            </div>
          );
        })}
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

export const UploadProgressCard = memo(UploadProgressCardImpl);
