/**
 * RunComparison -- Side-by-side comparison of two eval runs.
 *
 * Shows per-evaluator score deltas between a baseline and current run,
 * with color-coded improvement/regression indicators and an overall summary.
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { clsx } from 'clsx';
import { X, ArrowUpRight, ArrowDownRight, Minus, GitCompare } from 'lucide-react';
import { useEvalsStore } from '@/store/evals-store';
import { useProjectStore } from '@/store/project-store';
import { useEvalComparison, useEvalRuns, useEvalEvaluators } from '@/hooks/useEvalData';
import { Badge } from '../../ui/Badge';
import { EvalBadge } from '../shared/EvalBadge';
import { Button } from '../../ui/Button';

interface RunComparisonProps {
  className?: string;
}

const DELTA_THRESHOLD = 0.01;

export function RunComparison({ className }: RunComparisonProps) {
  const t = useTranslations('evals');
  const { compareBaselineId, compareCurrentId, setCompare } = useEvalsStore();
  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const { runs } = useEvalRuns(projectId);
  const { evaluators } = useEvalEvaluators(projectId);
  const evaluatorNameMap = useMemo(
    () => new Map(evaluators.map((e) => [e.id, e.name])),
    [evaluators],
  );
  const { comparison, isLoading } = useEvalComparison(
    projectId,
    compareBaselineId,
    compareCurrentId,
  );

  const baselineRun = useMemo(
    () => runs.find((r) => r.id === compareBaselineId),
    [runs, compareBaselineId],
  );
  const currentRun = useMemo(
    () => runs.find((r) => r.id === compareCurrentId),
    [runs, compareCurrentId],
  );

  // Build per-evaluator comparison rows
  const evaluatorRows = useMemo(() => {
    if (!comparison) return [];

    return comparison.evaluators.map((ev) => {
      const baselineScore = ev.scores.find((s) => s.runId === compareBaselineId);
      const currentScore = ev.scores.find((s) => s.runId === compareCurrentId);

      const baseAvg = baselineScore?.avgScore ?? 0;
      const currAvg = currentScore?.avgScore ?? 0;
      const delta = currAvg - baseAvg;

      const evalName = evaluatorNameMap.get(ev.evaluatorId) ?? ev.evaluatorId;

      return {
        evaluatorId: ev.evaluatorId,
        name: evalName,
        baselineAvg: baseAvg,
        currentAvg: currAvg,
        delta,
      };
    });
  }, [comparison, compareBaselineId, compareCurrentId, evaluatorNameMap]);

  // Compute summary counts
  const summary = useMemo(() => {
    let improved = 0;
    let regressed = 0;
    let unchanged = 0;

    for (const row of evaluatorRows) {
      if (row.delta > DELTA_THRESHOLD) improved++;
      else if (row.delta < -DELTA_THRESHOLD) regressed++;
      else unchanged++;
    }

    return { improved, regressed, unchanged };
  }, [evaluatorRows]);

  function handleClose() {
    setCompare(null, null);
  }

  function renderDeltaIcon(delta: number) {
    if (delta > DELTA_THRESHOLD) {
      return <ArrowUpRight className="w-4 h-4 text-success" />;
    }
    if (delta < -DELTA_THRESHOLD) {
      return <ArrowDownRight className="w-4 h-4 text-error" />;
    }
    return <Minus className="w-4 h-4 text-muted" />;
  }

  function renderDeltaValue(delta: number) {
    const sign = delta > 0 ? '+' : '';
    const colorClass =
      delta > DELTA_THRESHOLD
        ? 'text-success'
        : delta < -DELTA_THRESHOLD
          ? 'text-error'
          : 'text-muted';

    return (
      <span className={clsx('text-sm font-medium', colorClass)}>
        {sign}
        {delta.toFixed(2)}
      </span>
    );
  }

  // No comparison selected
  if (!compareBaselineId || !compareCurrentId) {
    return (
      <div
        className={clsx('border border-default rounded-xl p-4 bg-background-elevated', className)}
      >
        <div className="flex items-center gap-2 mb-4">
          <GitCompare className="w-4 h-4 text-muted" />
          <span className="text-sm font-medium text-foreground">{t('comparison.title')}</span>
        </div>
        <p className="text-sm text-muted text-center py-8">{t('comparison.select_runs')}</p>
      </div>
    );
  }

  return (
    <div className={clsx('border border-default rounded-xl p-4 bg-background-elevated', className)}>
      {/* Header with run selectors and close button */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <GitCompare className="w-4 h-4 text-muted" />
          <span className="text-sm font-medium text-foreground">{t('comparison.title')}</span>
        </div>
        <Button variant="ghost" size="xs" onClick={handleClose}>
          <X className="w-3.5 h-3.5" />
        </Button>
      </div>

      {/* Run selectors */}
      <div className="flex items-center gap-3 mb-4">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Badge variant="default">{t('comparison.baseline')}</Badge>
          <span className="text-sm text-foreground truncate">
            {baselineRun?.name ?? baselineRun?.id?.slice(0, 8) ?? 'Unknown'}
          </span>
        </div>
        <span className="text-xs text-muted">{t('comparison.vs')}</span>
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Badge variant="accent">{t('comparison.current')}</Badge>
          <span className="text-sm text-foreground truncate">
            {currentRun?.name ?? currentRun?.id?.slice(0, 8) ?? 'Unknown'}
          </span>
        </div>
      </div>

      {/* Loading state */}
      {isLoading && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-10 bg-background-muted rounded-lg animate-pulse" />
          ))}
        </div>
      )}

      {/* Comparison table */}
      {!isLoading && comparison && evaluatorRows.length > 0 && (
        <>
          {/* Table header */}
          <div className="grid grid-cols-[1fr_80px_80px_80px_32px] gap-2 px-2 pb-2 border-b border-default">
            <span className="text-xs text-muted font-medium">
              {t('comparison.column.evaluator')}
            </span>
            <span className="text-xs text-muted font-medium text-right">
              {t('comparison.column.baseline')}
            </span>
            <span className="text-xs text-muted font-medium text-right">
              {t('comparison.column.current')}
            </span>
            <span className="text-xs text-muted font-medium text-right">
              {t('comparison.column.delta')}
            </span>
            <span />
          </div>

          {/* Table rows */}
          <div className="divide-y divide-default">
            {evaluatorRows.map((row) => (
              <div
                key={row.evaluatorId}
                className="grid grid-cols-[1fr_80px_80px_80px_32px] gap-2 px-2 py-2.5 items-center"
              >
                <span className="text-sm text-foreground truncate">{row.name}</span>
                <div className="flex justify-end">
                  <EvalBadge score={row.baselineAvg} />
                </div>
                <div className="flex justify-end">
                  <EvalBadge score={row.currentAvg} />
                </div>
                <div className="flex justify-end">{renderDeltaValue(row.delta)}</div>
                <div className="flex justify-center">{renderDeltaIcon(row.delta)}</div>
              </div>
            ))}
          </div>

          {/* Summary */}
          <div className="mt-4 pt-3 border-t border-default">
            <p className="text-xs text-muted text-center">
              <span className="text-success font-medium">
                {summary.improved} {t('comparison.improved')}
              </span>
              {', '}
              <span className="text-error font-medium">
                {summary.regressed} {t('comparison.regressed')}
              </span>
              {', '}
              <span className="text-muted font-medium">
                {summary.unchanged} {t('comparison.unchanged')}
              </span>
            </p>
          </div>
        </>
      )}

      {/* No data after loading */}
      {!isLoading && comparison && evaluatorRows.length === 0 && (
        <p className="text-sm text-muted text-center py-4">{t('comparison.no_data')}</p>
      )}
    </div>
  );
}
