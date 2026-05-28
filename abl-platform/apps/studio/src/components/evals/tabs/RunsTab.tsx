/**
 * RunsTab — Main runs view with run selector, summary bar, heat map, and detail panel.
 *
 * Layout: Run selector dropdown at top + run summary + heat map grid below.
 * When a heat map cell is selected, a ScoreDetail panel expands with
 * per-evaluator breakdowns and reasoning.
 */

import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import {
  Play,
  Plus,
  Clock,
  DollarSign,
  BarChart3,
  ChevronDown,
  RefreshCw,
  GitCompare,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { useProjectStore } from '@/store/project-store';
import { useEvalsStore } from '@/store/evals-store';
import {
  useEvalRuns,
  useEvalHeatMap,
  useEvalRunStatus,
  useEvalPersonas,
  useEvalScenarios,
  useEvalEvaluators,
} from '@/hooks/useEvalData';
import { apiFetch } from '@/lib/api-client';
import { Button } from '../../ui/Button';
import { Badge } from '../../ui/Badge';
import { EmptyState } from '../../ui/EmptyState';
import { Skeleton, SkeletonTable } from '../../ui/Skeleton';
import { EvalBadge, StatusBadge } from '../shared/EvalBadge';
import { StartRunDialog } from '../dialogs/StartRunDialog';
import { HeatMap } from '../heatmap/HeatMap';
import { ScoreDetail } from '../heatmap/ScoreDetail';
import { QuickEvalButton } from '../shared/QuickEvalButton';
import { RunComparison } from '../comparison/RunComparison';
import { ScoreTrend } from '../comparison/ScoreTrend';
import { StatisticalSummary } from '../shared/StatisticalSummary';
import { EvalPreflightPanel } from '../EvalPreflightPanel';
import { TooltipProvider } from '../../ui/Tooltip';

// ── Helpers ──────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}

// ── HeatMap loading skeleton ──────────────────────────────────────────

function HeatMapSkeleton() {
  const COLS = 3;
  const ROWS = 3;
  return (
    <div className="overflow-x-auto">
      <table className="border border-default rounded-lg overflow-hidden border-collapse w-full">
        <thead>
          <tr>
            <th className="bg-background-muted border border-default px-4 py-3 min-w-[180px]" />
            {Array.from({ length: COLS }).map((_, i) => (
              <th
                key={i}
                className="bg-background-muted border border-default px-3 py-3 min-w-[120px]"
              >
                <Skeleton className="h-3 w-24 mx-auto rounded" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: ROWS }).map((_, r) => (
            <tr key={r}>
              <td className="bg-background-muted border border-default px-4 py-3">
                <Skeleton className="h-3 w-28 rounded" />
              </td>
              {Array.from({ length: COLS }).map((_, c) => (
                <td key={c} className="border border-default p-0">
                  <Skeleton className="min-w-[120px] h-16 rounded-none" />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Component ────────────────────────────────────────────────────────

export function RunsTab() {
  const t = useTranslations('evals');
  const currentProject = useProjectStore((s) => s.currentProject);
  const projectId = currentProject?.id ?? null;

  const selectedRunId = useEvalsStore((s) => s.selectedRunId);
  const setSelectedRunId = useEvalsStore((s) => s.setSelectedRunId);
  const selectedCell = useEvalsStore((s) => s.selectedCell);
  const setSelectedCell = useEvalsStore((s) => s.setSelectedCell);
  const setCompare = useEvalsStore((s) => s.setCompare);
  const compareBaselineId = useEvalsStore((s) => s.compareBaselineId);
  const compareCurrentId = useEvalsStore((s) => s.compareCurrentId);

  const { runs, isLoading, refresh, hasMore, loadMore, isLoadingMore } = useEvalRuns(projectId);
  const { personas } = useEvalPersonas(projectId);
  const { scenarios } = useEvalScenarios(projectId);
  const { evaluators } = useEvalEvaluators(projectId);

  const [showStartDialog, setShowStartDialog] = useState(false);
  const [showCompareDropdown, setShowCompareDropdown] = useState(false);

  // Auto-select first run if none selected
  const activeRunId = useMemo(() => {
    if (selectedRunId && runs.find((r) => r.id === selectedRunId)) return selectedRunId;
    return runs.length > 0 ? runs[0].id : null;
  }, [selectedRunId, runs]);

  const activeRun = useMemo(
    () => runs.find((r) => r.id === activeRunId) ?? null,
    [runs, activeRunId],
  );

  const isRunning = activeRun?.status === 'running';

  // Poll for status when running
  const runStatus = useEvalRunStatus(projectId, activeRunId, isRunning);

  // Fetch heat map for active run
  const {
    cells: heatMapCells,
    isLoading: heatMapLoading,
    refresh: refreshHeatMap,
  } = useEvalHeatMap(projectId, activeRunId);

  // Name lookup maps (both Map and plain object forms, memoized)
  const personaMap = useMemo(() => new Map(personas.map((p) => [p.id, p.name])), [personas]);
  const scenarioMap = useMemo(() => new Map(scenarios.map((s) => [s.id, s.name])), [scenarios]);
  const evaluatorMap = useMemo(() => new Map(evaluators.map((e) => [e.id, e.name])), [evaluators]);
  const personaNameObj = useMemo(() => Object.fromEntries(personaMap), [personaMap]);
  const scenarioNameObj = useMemo(() => Object.fromEntries(scenarioMap), [scenarioMap]);
  const evaluatorNameObj = useMemo(() => Object.fromEntries(evaluatorMap), [evaluatorMap]);

  const handleRunStarted = useCallback(() => {
    refresh();
  }, [refresh]);

  const handleSelectCompareBaseline = useCallback(
    (baselineRunId: string) => {
      if (!activeRunId) return;
      setCompare(baselineRunId, activeRunId);
      setShowCompareDropdown(false);
      toast.success(t('runs.comparison_enabled'));
    },
    [activeRunId, setCompare, t],
  );

  const handleCancel = useCallback(async () => {
    if (!projectId || !activeRunId) return;
    try {
      const res = await apiFetch(`/api/projects/${projectId}/evals/runs/${activeRunId}/cancel`, {
        method: 'POST',
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || data.errors?.[0]?.msg || 'Cancel failed');
      }
      toast.success(t('runs.cancelled'));
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [projectId, activeRunId, refresh, t]);

  // Determine effective status (polled status overrides)
  const effectiveStatus = runStatus.status ?? activeRun?.status ?? 'pending';

  // Refresh runs list when status transitions to terminal
  const prevStatusRef = useRef(effectiveStatus);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = effectiveStatus;
    if (
      prev === 'running' &&
      (effectiveStatus === 'completed' ||
        effectiveStatus === 'failed' ||
        effectiveStatus === 'cancelled')
    ) {
      refresh();
      refreshHeatMap();
    }
  }, [effectiveStatus, refresh, refreshHeatMap]);

  // ── Loading state ──────────────────────────────────────────────────

  if (isLoading) {
    return <SkeletonTable rows={5} cols={4} />;
  }

  // ── Empty state ────────────────────────────────────────────────────

  if (runs.length === 0) {
    return (
      <>
        <div className="mb-6">
          <EvalPreflightPanel />
        </div>

        <EmptyState
          icon={<Play className="w-6 h-6" />}
          title={t('runs.empty_title')}
          description={t('runs.empty_description')}
          action={
            <div className="flex flex-col items-center gap-4">
              <QuickEvalButton size="sm" onStarted={handleRunStarted} />
              <span className="text-xs text-muted">{t('runs.quick_eval_hint')}</span>
            </div>
          }
        />

        {/* Manual setup guide */}
        <div className="mt-6 border border-default rounded-xl p-5 bg-background-elevated max-w-lg mx-auto">
          <h3 className="text-sm font-medium text-foreground mb-3">{t('runs.manual_hint')}</h3>
          <ol className="space-y-2 text-xs text-muted">
            <li className="flex items-start gap-2">
              <span className="shrink-0 w-5 h-5 rounded-full bg-background-muted flex items-center justify-center text-xs font-medium text-foreground">
                1
              </span>
              <span>
                <button
                  onClick={() => useEvalsStore.getState().setActiveTab('personas')}
                  className="text-info hover:underline"
                >
                  {t('runs.step_personas')}
                </button>{' '}
                — {t('runs.step_personas_desc')}
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="shrink-0 w-5 h-5 rounded-full bg-background-muted flex items-center justify-center text-xs font-medium text-foreground">
                2
              </span>
              <span>
                <button
                  onClick={() => useEvalsStore.getState().setActiveTab('scenarios')}
                  className="text-info hover:underline"
                >
                  {t('runs.step_scenarios')}
                </button>{' '}
                — {t('runs.step_scenarios_desc')}
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="shrink-0 w-5 h-5 rounded-full bg-background-muted flex items-center justify-center text-xs font-medium text-foreground">
                3
              </span>
              <span>
                <button
                  onClick={() => useEvalsStore.getState().setActiveTab('evaluators')}
                  className="text-info hover:underline"
                >
                  {t('runs.step_evaluators')}
                </button>{' '}
                — {t('runs.step_evaluators_desc')}
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="shrink-0 w-5 h-5 rounded-full bg-background-muted flex items-center justify-center text-xs font-medium text-foreground">
                4
              </span>
              <span>
                <button
                  onClick={() => useEvalsStore.getState().setActiveTab('eval-sets')}
                  className="text-info hover:underline"
                >
                  {t('runs.step_eval_set')}
                </button>{' '}
                — {t('runs.step_eval_set_desc')}
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="shrink-0 w-5 h-5 rounded-full bg-background-muted flex items-center justify-center text-xs font-medium text-foreground">
                5
              </span>
              <span>{t('runs.start_hint')}</span>
            </li>
          </ol>
        </div>

        <StartRunDialog
          open={showStartDialog}
          onClose={() => setShowStartDialog(false)}
          onStarted={handleRunStarted}
        />
      </>
    );
  }

  // ── Main view ──────────────────────────────────────────────────────

  return (
    <>
      {/* Header: Run selector + actions */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          {/* Run selector dropdown */}
          <div className="relative">
            <select
              value={activeRunId ?? ''}
              onChange={(e) => setSelectedRunId(e.target.value || null)}
              className="appearance-none rounded-lg border border-default bg-background-subtle text-foreground text-sm py-2 pl-3 pr-8 transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
            >
              {runs.map((run) => (
                <option key={run.id} value={run.id}>
                  {run.name || `Run ${run.id.slice(-6)}`} -{' '}
                  {new Date(run.createdAt).toLocaleDateString()}
                </option>
              ))}
            </select>
            <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted pointer-events-none" />
          </div>

          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              refresh();
              refreshHeatMap();
            }}
            icon={<RefreshCw className="w-3.5 h-3.5" />}
          >
            {t('runs.refresh')}
          </Button>
          {hasMore && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void loadMore()}
              loading={isLoadingMore}
              icon={<ChevronDown className="w-3.5 h-3.5" />}
            >
              {t('load_more')}
            </Button>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Compare button */}
          <div className="relative">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setShowCompareDropdown(!showCompareDropdown)}
              icon={<GitCompare className="w-3.5 h-3.5" />}
              disabled={runs.length < 2}
            >
              {t('runs.compare')}
            </Button>

            {showCompareDropdown && (
              <div className="absolute right-0 top-full mt-1 z-10 w-64 bg-background-elevated border border-default rounded-lg shadow-lg py-1">
                <div className="px-3 py-1.5 text-xs text-muted border-b border-default">
                  {t('runs.select_baseline')}
                </div>
                {runs
                  .filter((r) => r.id !== activeRunId && r.status === 'completed')
                  .map((run) => (
                    <button
                      key={run.id}
                      onClick={() => handleSelectCompareBaseline(run.id)}
                      className="w-full text-left px-3 py-2 text-sm text-foreground hover:bg-background-muted transition-default"
                    >
                      {run.name || `Run ${run.id.slice(-6)}`}
                      <span className="text-xs text-muted ml-2">
                        {new Date(run.createdAt).toLocaleDateString()}
                      </span>
                    </button>
                  ))}
                {runs.filter((r) => r.id !== activeRunId && r.status === 'completed').length ===
                  0 && (
                  <div className="px-3 py-2 text-xs text-muted">{t('runs.no_compare_runs')}</div>
                )}
              </div>
            )}
          </div>

          <QuickEvalButton onStarted={handleRunStarted} />
          <Button
            size="sm"
            onClick={() => setShowStartDialog(true)}
            icon={<Plus className="w-3.5 h-3.5" />}
          >
            {t('runs.new_run')}
          </Button>
        </div>
      </div>

      <div className="mb-6">
        <EvalPreflightPanel />
      </div>

      {/* Run Summary Bar */}
      {activeRun && (
        <div className="flex items-center gap-4 bg-background-elevated border border-default rounded-xl p-4 mb-4">
          <StatusBadge status={effectiveStatus} />

          {/* Progress indicator + cancel for running/pending state */}
          {(effectiveStatus === 'running' || effectiveStatus === 'pending') && (
            <div className="flex items-center gap-2">
              {effectiveStatus === 'running' && (
                <>
                  <div className="w-24 h-1.5 bg-background-muted rounded-full overflow-hidden">
                    <div className="h-full bg-accent rounded-full animate-pulse w-2/3" />
                  </div>
                  <span className="text-xs text-muted">{t('runs.in_progress')}</span>
                </>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={handleCancel}
                icon={<XCircle className="w-3.5 h-3.5" />}
              >
                {t('runs.cancel')}
              </Button>
            </div>
          )}

          {activeRun.summary && (
            <>
              <div className="h-5 w-px bg-background-muted" />

              <div className="flex items-center gap-1.5">
                <BarChart3 className="w-3.5 h-3.5 text-muted" />
                <span className="text-xs text-muted">{t('runs.avg_score')}</span>
                <EvalBadge score={activeRun.summary.avgScore} />
              </div>

              <div className="h-5 w-px bg-background-muted" />

              <div className="flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-muted" />
                <span className="text-xs text-muted">{t('runs.duration')}</span>
                <span className="text-xs font-medium text-foreground">
                  {formatDuration(activeRun.summary.durationMs)}
                </span>
              </div>

              <div className="h-5 w-px bg-background-muted" />

              <div className="flex items-center gap-1.5">
                <DollarSign className="w-3.5 h-3.5 text-muted" />
                <span className="text-xs text-muted">{t('runs.cost')}</span>
                <span className="text-xs font-medium text-foreground">
                  {formatCost(activeRun.summary.estimatedCost)}
                </span>
              </div>

              <div className="h-5 w-px bg-background-muted" />

              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted">{t('runs.evaluations')}</span>
                <Badge variant="default">
                  {activeRun.summary.totalEvaluations.toLocaleString()}
                </Badge>
              </div>
            </>
          )}
        </div>
      )}

      {/* Run Comparison (shown when comparison is active) */}
      {compareBaselineId && compareCurrentId && <RunComparison className="mb-4" />}

      {/* Heat Map + Statistical Summary wrapped in TooltipProvider (HeatMap and StatisticalSummary use Tooltip) */}
      <TooltipProvider>
        <div className="mb-4">
          {heatMapLoading ? (
            <HeatMapSkeleton />
          ) : (
            <HeatMap
              cells={heatMapCells}
              personaNames={personaNameObj}
              scenarioNames={scenarioNameObj}
              selectedCell={selectedCell}
              onCellClick={(personaId, scenarioId) => {
                if (
                  selectedCell?.personaId === personaId &&
                  selectedCell?.scenarioId === scenarioId
                ) {
                  setSelectedCell(null);
                } else {
                  setSelectedCell({ personaId, scenarioId });
                }
              }}
            />
          )}
        </div>

        {/* Statistical Summary (visible for completed runs with heatmap data) */}
        {effectiveStatus === 'completed' && heatMapCells.length > 0 && (
          <StatisticalSummary cells={heatMapCells} className="mb-4" />
        )}

        {/* Score Trend (visible for completed runs) */}
        {effectiveStatus === 'completed' && <ScoreTrend className="mb-4" />}
      </TooltipProvider>

      {/* Score Detail Panel */}
      {selectedCell && activeRunId && (
        <ScoreDetail
          cells={heatMapCells}
          personaId={selectedCell.personaId}
          scenarioId={selectedCell.scenarioId}
          personaName={personaMap.get(selectedCell.personaId) ?? selectedCell.personaId}
          scenarioName={scenarioMap.get(selectedCell.scenarioId) ?? selectedCell.scenarioId}
          evaluatorNames={evaluatorNameObj}
          onClose={() => setSelectedCell(null)}
        />
      )}

      {/* Start Run Dialog */}
      <StartRunDialog
        open={showStartDialog}
        onClose={() => setShowStartDialog(false)}
        onStarted={handleRunStarted}
      />
    </>
  );
}
