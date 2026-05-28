/**
 * StatisticalSummary -- Confidence intervals and pass rates for eval cells.
 *
 * Computes mean, standard deviation, 95% confidence interval, and pass rate
 * from an array of HeatMapCell data, displayed as a row of compact stat cards.
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { clsx } from 'clsx';
import { BarChart3, Target, Sigma } from 'lucide-react';
import type { HeatMapCell } from '@/hooks/useEvalData';
import { Tooltip } from '../../ui/Tooltip';

interface StatisticalSummaryProps {
  cells: HeatMapCell[];
  className?: string;
}

const Z_95 = 1.96;

interface Stats {
  mean: number;
  stdDev: number;
  ciLow: number;
  ciHigh: number;
  passRate: number;
  totalCells: number;
}

function computeStats(cells: HeatMapCell[]): Stats {
  const n = cells.length;

  if (n === 0) {
    return { mean: 0, stdDev: 0, ciLow: 0, ciHigh: 0, passRate: 0, totalCells: 0 };
  }

  // Mean
  const sum = cells.reduce((acc, c) => acc + c.avgScore, 0);
  const mean = sum / n;

  // Standard deviation
  const squaredDiffs = cells.reduce((acc, c) => acc + (c.avgScore - mean) ** 2, 0);
  const stdDev = n > 1 ? Math.sqrt(squaredDiffs / (n - 1)) : 0;

  // 95% confidence interval
  const stdErr = n > 0 ? stdDev / Math.sqrt(n) : 0;
  const ciLow = mean - Z_95 * stdErr;
  const ciHigh = mean + Z_95 * stdErr;

  // Pass rate — use the judge's own pass/fail signal (eval_scores.passed)
  // averaged per cell, then averaged across all cells. This respects
  // per-evaluator thresholds instead of a hardcoded score cutoff.
  const passRate = (cells.reduce((acc, c) => acc + (c.passRate ?? 0), 0) / n) * 100;

  return { mean, stdDev, ciLow, ciHigh, passRate, totalCells: n };
}

export function StatisticalSummary({ cells, className }: StatisticalSummaryProps) {
  const t = useTranslations('evals');
  const stats = useMemo(() => computeStats(cells), [cells]);

  if (cells.length === 0) {
    return null;
  }

  return (
    <div className={clsx('grid grid-cols-2 md:grid-cols-4 gap-3', className)}>
      {/* Mean +/- StdDev */}
      <Tooltip content={t('stats.mean_stddev_tooltip')} side="top">
        <div className="bg-background-muted rounded-lg p-3 text-center cursor-help">
          <div className="flex items-center justify-center gap-1 mb-1">
            <Sigma className="w-3.5 h-3.5 text-muted" />
          </div>
          <p className="text-lg font-semibold text-foreground">
            {stats.mean.toFixed(2)}{' '}
            <span className="text-sm font-normal text-muted">
              {'\u00B1'} {stats.stdDev.toFixed(2)}
            </span>
          </p>
          <p className="text-xs text-muted">{t('stats.mean_stddev')}</p>
        </div>
      </Tooltip>

      {/* 95% Confidence Interval */}
      <Tooltip content={t('stats.confidence_interval_tooltip')} side="top">
        <div className="bg-background-muted rounded-lg p-3 text-center cursor-help">
          <div className="flex items-center justify-center gap-1 mb-1">
            <BarChart3 className="w-3.5 h-3.5 text-muted" />
          </div>
          <p className="text-lg font-semibold text-foreground">
            [{Math.max(0, stats.ciLow).toFixed(2)}, {Math.min(5, stats.ciHigh).toFixed(2)}]
          </p>
          <p className="text-xs text-muted">{t('stats.confidence_interval')}</p>
        </div>
      </Tooltip>

      {/* Pass Rate */}
      <Tooltip content={t('stats.pass_rate_tooltip')} side="top">
        <div className="bg-background-muted rounded-lg p-3 text-center cursor-help">
          <div className="flex items-center justify-center gap-1 mb-1">
            <Target className="w-3.5 h-3.5 text-muted" />
          </div>
          <p className="text-lg font-semibold text-foreground">{stats.passRate.toFixed(0)}%</p>
          <p className="text-xs text-muted">{t('stats.pass_rate')}</p>
        </div>
      </Tooltip>

      {/* Total Cells */}
      <Tooltip content={t('stats.total_cells_tooltip')} side="top">
        <div className="bg-background-muted rounded-lg p-3 text-center cursor-help">
          <div className="flex items-center justify-center gap-1 mb-1">
            <BarChart3 className="w-3.5 h-3.5 text-muted" />
          </div>
          <p className="text-lg font-semibold text-foreground">{stats.totalCells}</p>
          <p className="text-xs text-muted">{t('stats.total_cells')}</p>
        </div>
      </Tooltip>
    </div>
  );
}
