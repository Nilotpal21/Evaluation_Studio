'use client';

import { memo } from 'react';
import { clsx } from 'clsx';
import type { KBHealthCardEvent } from '@agent-platform/arch-ai';

interface KBHealthCardProps {
  event: KBHealthCardEvent;
}

const STATUS_STYLES = {
  healthy: {
    border: 'border-success/30',
    bg: 'bg-success/5',
    icon: '✓',
    iconBg: 'bg-success/10 text-success',
  },
  warning: {
    border: 'border-warning/30',
    bg: 'bg-warning/5',
    icon: '⚠',
    iconBg: 'bg-warning/10 text-warning',
  },
  error: {
    border: 'border-destructive/30',
    bg: 'bg-destructive/5',
    icon: '✕',
    iconBg: 'bg-destructive/10 text-destructive',
  },
} as const;

function KBHealthCardImpl({ event }: KBHealthCardProps) {
  const style = STATUS_STYLES[event.overallStatus];

  return (
    <div
      className={clsx('w-full rounded-lg border p-4 animate-fade-in-up', style.border, style.bg)}
    >
      <div className="flex items-center gap-2 mb-3">
        <span
          className={clsx(
            'flex h-6 w-6 items-center justify-center rounded-full text-sm',
            style.iconBg,
          )}
        >
          {style.icon}
        </span>
        <h3 className="text-sm font-semibold text-foreground">{event.kbName} — Health</h3>
      </div>

      <div className="grid grid-cols-2 gap-2 mb-3">
        <HealthSection
          label="Sources"
          items={[
            { label: 'Total', value: event.sections.sources.total },
            { label: 'Healthy', value: event.sections.sources.healthy, color: 'text-success' },
            { label: 'Syncing', value: event.sections.sources.syncing, color: 'text-warning' },
          ]}
        />
        <HealthSection
          label="Documents"
          items={[
            { label: 'Total', value: event.sections.documents.total },
            {
              label: 'Errored',
              value: event.sections.documents.errored,
              color: 'text-destructive',
            },
            {
              label: 'Processing',
              value: event.sections.documents.processing,
              color: 'text-warning',
            },
          ]}
        />
        <div className="rounded-md bg-background/50 px-2.5 py-1.5">
          <div className="text-xs text-foreground-muted">Pipeline</div>
          <div className="text-xs font-medium text-foreground capitalize">
            {event.sections.pipeline.status}
          </div>
        </div>
        <div className="rounded-md bg-background/50 px-2.5 py-1.5">
          <div className="text-xs text-foreground-muted">LLM</div>
          <div
            className={clsx(
              'text-xs font-medium',
              event.sections.llm.configured ? 'text-success' : 'text-destructive',
            )}
          >
            {event.sections.llm.configured ? 'Configured' : 'Not configured'}
          </div>
        </div>
      </div>

      {event.errorSummary && (
        <div className="rounded-md bg-destructive/10 px-2.5 py-1.5 mb-3 text-xs text-destructive">
          {event.errorSummary}
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

function HealthSection({
  label,
  items,
}: {
  label: string;
  items: Array<{ label: string; value: number; color?: string }>;
}) {
  return (
    <div className="rounded-md bg-background/50 px-2.5 py-1.5">
      <div className="text-xs text-foreground-muted mb-1">{label}</div>
      <div className="space-y-0.5">
        {items.map((item) => (
          <div key={item.label} className="flex justify-between text-xs">
            <span className="text-foreground-muted">{item.label}</span>
            <span className={clsx('font-medium', item.color ?? 'text-foreground')}>
              {item.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export const KBHealthCard = memo(KBHealthCardImpl);
