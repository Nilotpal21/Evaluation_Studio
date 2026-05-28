/**
 * ScoreTrend -- Score trend visualization across recent runs.
 *
 * Renders the last 10 runs as horizontal CSS bars proportional to their
 * average score (out of 5), with status badges and regression indicators.
 * No external charting library required.
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { clsx } from 'clsx';
import { TrendingUp, TrendingDown } from 'lucide-react';
import { useProjectStore } from '@/store/project-store';
import { useEvalRuns } from '@/hooks/useEvalData';
import { Badge } from '../../ui/Badge';

interface ScoreTrendProps {
  className?: string;
}

const MAX_RUNS = 10;
const MAX_SCORE = 5;

function scoreBarColor(score: number): string {
  if (score >= 4) return 'bg-success';
  if (score >= 3) return 'bg-accent';
  if (score >= 2) return 'bg-warning';
  return 'bg-error';
}

function formatRunDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return 'Unknown';
  }
}

export function ScoreTrend({ className }: ScoreTrendProps) {
  const t = useTranslations('evals');
  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const { runs, isLoading } = useEvalRuns(projectId);

  // Get last N completed runs sorted by createdAt descending
  const recentRuns = useMemo(() => {
    return [...runs]
      .filter((r) => r.status === 'completed' && r.summary)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, MAX_RUNS)
      .reverse(); // Oldest first so trend reads left-to-right / top-to-bottom
  }, [runs]);

  // Detect overall trend direction
  const trendDirection = useMemo(() => {
    if (recentRuns.length < 2) return 'neutral';
    const first = recentRuns[0]?.summary?.avgScore ?? 0;
    const last = recentRuns[recentRuns.length - 1]?.summary?.avgScore ?? 0;
    if (last - first > 0.1) return 'up';
    if (first - last > 0.1) return 'down';
    return 'neutral';
  }, [recentRuns]);

  if (isLoading) {
    return (
      <div
        className={clsx('border border-default rounded-xl p-4 bg-background-elevated', className)}
      >
        <div className="flex items-center gap-2 mb-4">
          <TrendingUp className="w-4 h-4 text-muted" />
          <span className="text-sm font-medium text-foreground">{t('trend.title')}</span>
        </div>
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-6 bg-background-muted rounded animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={clsx('border border-default rounded-xl p-4 bg-background-elevated', className)}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          {trendDirection === 'down' ? (
            <TrendingDown className="w-4 h-4 text-error" />
          ) : (
            <TrendingUp className="w-4 h-4 text-success" />
          )}
          <span className="text-sm font-medium text-foreground">{t('trend.title')}</span>
        </div>
        {recentRuns.length > 0 && (
          <Badge variant="default">{t('trend.run_count', { count: recentRuns.length })}</Badge>
        )}
      </div>

      {/* Empty state */}
      {recentRuns.length === 0 && (
        <p className="text-sm text-muted text-center py-6">{t('trend.empty')}</p>
      )}

      {/* Run list with bars */}
      {recentRuns.length > 0 && (
        <div className="space-y-1">
          {recentRuns.map((run) => {
            const score = run.summary?.avgScore ?? 0;
            const widthPercent = Math.max((score / MAX_SCORE) * 100, 2);
            const statusVariant =
              run.status === 'completed'
                ? 'success'
                : run.status === 'failed'
                  ? 'error'
                  : 'default';

            return (
              <div key={run.id} className="flex items-center gap-3 py-2">
                {/* Run name / date */}
                <div className="w-24 shrink-0 truncate">
                  <span className="text-xs text-foreground">
                    {run.name ?? formatRunDate(run.createdAt)}
                  </span>
                </div>

                {/* Status badge */}
                <Badge variant={statusVariant} className="shrink-0 text-xs">
                  {run.status}
                </Badge>

                {/* Score bar */}
                <div className="flex-1 min-w-0">
                  <div className="w-full bg-background-muted rounded-full h-2">
                    <div
                      className={clsx(
                        'h-2 rounded-full transition-all duration-300',
                        scoreBarColor(score),
                      )}
                      style={{ width: `${widthPercent}%` }}
                    />
                  </div>
                </div>

                {/* Score value */}
                <span className="text-xs font-medium text-foreground w-8 text-right shrink-0">
                  {score.toFixed(1)}
                </span>

                {/* Regression indicator */}
                <div className="w-4 shrink-0 flex justify-center">
                  {run.regressionDetected && <TrendingDown className="w-3.5 h-3.5 text-error" />}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
