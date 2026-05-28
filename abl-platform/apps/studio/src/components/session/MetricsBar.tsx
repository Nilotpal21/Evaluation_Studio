// apps/studio/src/components/session/MetricsBar.tsx
'use client';

import type { ReactNode } from 'react';
import { DollarSign, Coins, Clock, Calendar } from 'lucide-react';

interface MetricsBarProps {
  cost: number;
  tokens: number;
  latencyMs: number;
  finishedAt?: string | Date;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

function formatTimestamp(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function MetricsBar({ cost, tokens, latencyMs, finishedAt }: MetricsBarProps) {
  return (
    <div className="border-b border-default bg-background-subtle px-3 py-2">
      <div className="flex flex-wrap items-center gap-4 text-xs text-muted">
        <MetricStat
          icon={<DollarSign className="h-3.5 w-3.5 text-success" />}
          label="Cost"
          value={cost > 0 ? `$${cost.toFixed(6)}` : '—'}
        />
        <MetricStat
          icon={<Coins className="h-3.5 w-3.5 text-warning" />}
          label="Tokens"
          value={tokens > 0 ? tokens.toLocaleString() : '—'}
        />
        <MetricStat
          icon={<Clock className="h-3.5 w-3.5 text-info" />}
          label="Session Duration"
          value={latencyMs > 0 ? formatDuration(latencyMs) : '—'}
        />
        <MetricStat
          icon={<Calendar className="h-3.5 w-3.5 text-accent" />}
          label="Finished"
          value={finishedAt ? formatTimestamp(finishedAt) : '—'}
        />
      </div>
    </div>
  );
}

interface MetricStatProps {
  icon: ReactNode;
  label: string;
  value: string | number;
}

function MetricStat({ icon, label, value }: MetricStatProps) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="shrink-0">{icon}</span>
      <span className="text-foreground-subtle">{label}:</span>
      <span className="font-semibold text-foreground">{value}</span>
    </div>
  );
}
