import type { ReactNode } from 'react';
import { intentClass, trendIntent } from '@agent-platform/design-tokens';
import { cn } from '../lib/cn';

interface MetricCardProps {
  title: string;
  value: string | number;
  description?: string;
  icon?: ReactNode;
  trend?: {
    value: number;
    label?: string;
  };
  className?: string;
}

export function MetricCard({ title, value, description, icon, trend, className }: MetricCardProps) {
  return (
    <div
      className={cn('rounded-lg border p-6', 'border-border', 'bg-background-subtle', className)}
    >
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <p className="text-sm text-foreground-muted">{title}</p>
          <p className="text-3xl font-bold text-foreground">{value}</p>
        </div>
        {icon && (
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent-subtle">
            <span className="text-accent">{icon}</span>
          </div>
        )}
      </div>
      {(description || trend) && (
        <div className="mt-3 flex items-center gap-2">
          {trend && (
            <span
              className={cn(
                'text-sm font-medium',
                trend.value > 0
                  ? intentClass(trendIntent('positive'), 'text')
                  : trend.value < 0
                    ? intentClass(trendIntent('negative'), 'text')
                    : 'text-foreground-muted',
              )}
            >
              {trend.value > 0 ? '+' : ''}
              {trend.value}%{trend.label ? ` ${trend.label}` : ''}
            </span>
          )}
          {description && <span className="text-sm text-foreground-muted">{description}</span>}
        </div>
      )}
    </div>
  );
}
