'use client';

import { clsx } from 'clsx';
import { AlertTriangle, Info } from 'lucide-react';
import { LineChart, Line, ResponsiveContainer } from 'recharts';
import { SEMANTIC_CHART_COLORS } from '@agent-platform/design-tokens';
import { Tooltip as UITooltip } from '../../ui/Tooltip';
import { METRIC_NUMBER_CLASS } from '../../../lib/format/metric-style';
import { STATUS_ROW_TINT_CLASS } from '../../../lib/status-style';

interface InsightKPICardProps {
  title: string;
  value: string | number;
  subtitle?: string; // e.g. "14 evaluated", "1 of 14 evaluated"
  tooltip?: string; // hover tooltip explaining the metric
  trend?: {
    value: number; // +5.2 or -3.1
    period: string; // "vs last month"
    favorable: 'up' | 'down'; // is up good or bad?
  };
  sparkline?: number[];
  status?: 'healthy' | 'warning' | 'critical';
  onClick?: () => void;
  className?: string;
}

const STATUS_BORDER: Record<string, string> = {
  healthy: 'border-l-success',
  warning: 'border-l-warning',
  critical: 'border-l-error',
};

const STATUS_GLOW: Record<string, string> = {
  healthy: 'hover:shadow-success/5',
  warning: 'hover:shadow-warning/5',
  critical: 'hover:shadow-error/5',
};

const STATUS_VALUE_COLOR: Record<string, string> = {
  healthy: 'text-foreground',
  warning: 'text-warning',
  critical: 'text-error',
};

export function InsightKPICard({
  title,
  value,
  subtitle,
  tooltip,
  trend,
  sparkline,
  status = 'healthy',
  onClick,
  className,
}: InsightKPICardProps) {
  const trendIsPositive = trend ? trend.value > 0 : undefined;
  const trendIsFavorable = trend
    ? (trend.favorable === 'up' && trend.value > 0) ||
      (trend.favorable === 'down' && trend.value < 0)
    : undefined;

  const trendColor =
    trendIsFavorable === undefined
      ? 'text-subtle'
      : trendIsFavorable
        ? 'text-success'
        : 'text-error';

  const sparkData = sparkline?.map((v, i) => ({ i, v }));

  const card = (
    <div
      onClick={onClick}
      className={clsx(
        'relative bg-background-elevated rounded-xl border border-default border-l-[3px] p-4',
        'transition-all duration-200',
        onClick && 'cursor-pointer hover:shadow-lg',
        STATUS_BORDER[status],
        STATUS_GLOW[status],
        STATUS_ROW_TINT_CLASS[status],
        className,
      )}
    >
      <div className="flex items-center gap-1 mb-1">
        <p className="text-xs font-medium text-muted">{title}</p>
        {tooltip && (
          <UITooltip content={tooltip} side="top">
            <button
              type="button"
              className="text-subtle hover:text-muted transition-default"
              aria-label={`About ${title}`}
            >
              <Info className="w-3 h-3" />
            </button>
          </UITooltip>
        )}
      </div>

      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <p
              className={clsx(
                'text-2xl font-semibold truncate',
                METRIC_NUMBER_CLASS,
                STATUS_VALUE_COLOR[status],
              )}
            >
              {value}
            </p>
            {status === 'critical' && (
              <AlertTriangle
                className="w-4 h-4 shrink-0 text-error"
                aria-label="Critical threshold"
              />
            )}
          </div>
          {subtitle && <p className="text-xs text-subtle mt-0.5">{subtitle}</p>}

          {trend && (
            <div className="flex items-center gap-1.5 mt-1">
              <span className={clsx('text-xs font-medium', trendColor)}>
                {trendIsPositive ? '\u2191' : trend.value === 0 ? '\u2192' : '\u2193'}{' '}
                {Math.abs(trend.value).toFixed(1)}%
              </span>
              <span className="text-xs text-subtle">{trend.period}</span>
            </div>
          )}
        </div>

        {sparkData && sparkData.length > 0 && (
          <div className="w-20 h-8 shrink-0">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={sparkData}>
                <Line
                  type="monotone"
                  dataKey="v"
                  stroke={
                    status === 'critical'
                      ? SEMANTIC_CHART_COLORS.error
                      : status === 'warning'
                        ? SEMANTIC_CHART_COLORS.warning
                        : SEMANTIC_CHART_COLORS.success
                  }
                  strokeWidth={1.5}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </div>
  );

  return card;
}
