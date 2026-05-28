'use client';

import { clsx } from 'clsx';

interface TokenBudgetGaugeProps {
  used: number; // tokens used by files
  total: number; // total budget
}

/**
 * TokenBudgetGauge — compact progress bar showing file context token usage.
 * Colors: green (<70%), amber (70-90%), red (>90%).
 */
export function TokenBudgetGauge({ used, total }: TokenBudgetGaugeProps) {
  const pct = total > 0 ? Math.min((used / total) * 100, 100) : 0;
  const usedK = (used / 1000).toFixed(1);
  const totalK = (total / 1000).toFixed(0);

  const severity: 'success' | 'warning' | 'error' =
    pct > 90 ? 'error' : pct > 70 ? 'warning' : 'success';

  return (
    <div className="flex flex-col gap-1">
      <div
        className={clsx(
          'h-1.5 w-full overflow-hidden rounded-full',
          severity === 'success' && 'bg-success/20',
          severity === 'warning' && 'bg-warning/20',
          severity === 'error' && 'bg-error/20',
        )}
      >
        <div
          className={clsx(
            'h-full rounded-full transition-all duration-300',
            severity === 'success' && 'bg-success',
            severity === 'warning' && 'bg-warning',
            severity === 'error' && 'bg-error',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] text-foreground-muted">
        File context: {usedK}K / {totalK}K tokens
      </span>
    </div>
  );
}
