'use client';

import { memo } from 'react';
import { clsx } from 'clsx';
import type { DocProcessingCardEvent } from '@agent-platform/arch-ai';

interface DocProcessingCardProps {
  event: DocProcessingCardEvent;
}

function DocProcessingCardImpl({ event }: DocProcessingCardProps) {
  const { statusBreakdown: s } = event;
  const total = s.ready + s.processing + s.extracting + s.errored + s.pending;

  return (
    <div className="w-full rounded-lg border border-border bg-card p-4 animate-fade-in-up">
      <div className="flex items-center gap-2 mb-3">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-primary text-xs">
          📊
        </span>
        <div>
          <h3 className="text-sm font-semibold text-foreground">{event.kbName} — Documents</h3>
          <p className="text-xs text-foreground-muted">{total} total</p>
        </div>
      </div>

      <div className="space-y-1.5 mb-3">
        <StatusRow label="Ready" count={s.ready} total={total} color="bg-success" />
        <StatusRow label="Processing" count={s.processing} total={total} color="bg-primary" />
        <StatusRow label="Extracting" count={s.extracting} total={total} color="bg-warning" />
        <StatusRow label="Pending" count={s.pending} total={total} color="bg-muted-foreground" />
        <StatusRow label="Errored" count={s.errored} total={total} color="bg-destructive" />
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

function StatusRow({
  label,
  count,
  total,
  color,
}: {
  label: string;
  count: number;
  total: number;
  color: string;
}) {
  if (count === 0) return null;
  const pct = total > 0 ? (count / total) * 100 : 0;

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-foreground-muted w-20">{label}</span>
      <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className={clsx('h-full rounded-full transition-all', color)}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs text-foreground-muted w-8 text-right">{count}</span>
    </div>
  );
}

export const DocProcessingCard = memo(DocProcessingCardImpl);
