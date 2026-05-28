'use client';

/**
 * WaterfallPanel Component
 *
 * Summary shell for waterfall-style views. Callers provide the span summaries
 * used for totals and the rendered body content.
 */

import { memo, type ReactNode } from 'react';
import { Clock, DollarSign, Layers, AlertTriangle, Zap, Radio } from 'lucide-react';
import { useTranslations } from 'next-intl';
import clsx from 'clsx';
import { summarizeSpanSummaries, type SpanSummary } from '../../features/observatory/metrics';
import { formatDuration, formatCost } from '../analytics/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WaterfallMode = 'live' | 'historical';
export type { SpanSummary } from '../../features/observatory/metrics';

interface WaterfallPanelProps {
  spans: SpanSummary[];
  children: ReactNode;
  mode: WaterfallMode;
  className?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WaterfallPanel({ spans, children, mode, className }: WaterfallPanelProps) {
  const t = useTranslations('observability');
  const totals = summarizeSpanSummaries(spans);

  return (
    <div className={clsx('flex flex-col h-full', className)}>
      {/* Summary bar */}
      <div className="flex items-center gap-4 px-4 py-3 border-b border-default bg-background-subtle shrink-0">
        {/* Live indicator */}
        {mode === 'live' && (
          <span className="flex items-center gap-1.5 text-xs font-medium text-success">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-success" />
            </span>
            {t('live')}
          </span>
        )}

        {mode === 'historical' && (
          <span className="flex items-center gap-1.5 text-xs font-medium text-muted">
            <Radio className="w-3.5 h-3.5" />
            Historical
          </span>
        )}

        <div className="h-4 w-px bg-default" />

        {/* Metrics */}
        <MetricPill
          icon={<Layers className="w-3 h-3" />}
          label="Spans"
          value={String(totals.spanCount)}
        />
        <MetricPill
          icon={<Clock className="w-3 h-3" />}
          label={t('metrics.duration')}
          value={formatDuration(totals.totalDuration)}
        />
        <MetricPill
          icon={<Zap className="w-3 h-3" />}
          label={t('metrics.tokens')}
          value={totals.totalTokens.toLocaleString()}
        />
        <MetricPill
          icon={<DollarSign className="w-3 h-3" />}
          label={t('metrics.cost')}
          value={formatCost(totals.totalCost)}
          valueClassName={
            totals.totalCost >= 0.1
              ? 'text-error'
              : totals.totalCost >= 0.01
                ? 'text-warning'
                : 'text-success'
          }
        />
        {totals.errorCount > 0 && (
          <MetricPill
            icon={<AlertTriangle className="w-3 h-3" />}
            label="Errors"
            value={String(totals.errorCount)}
            valueClassName="text-error"
          />
        )}
      </div>

      {/* Caller-owned waterfall body */}
      <div className="flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MetricPill
// ---------------------------------------------------------------------------

const MetricPill = memo(function MetricPill({
  icon,
  label,
  value,
  valueClassName,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <span className="text-muted">{icon}</span>
      <span className="text-subtle">{label}</span>
      <span className={clsx('font-medium text-foreground', valueClassName)}>{value}</span>
    </div>
  );
});
