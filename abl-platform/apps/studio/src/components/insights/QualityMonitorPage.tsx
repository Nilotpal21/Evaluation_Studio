/**
 * Quality Monitor Page
 *
 * System-wide quality dashboard showing health across 5 quality dimensions:
 *   quality_evaluation, hallucination_detection, knowledge_gap,
 *   guardrail_analysis, context_preservation
 *
 * Layout:
 *   Row 1: 5 KPI cards (one per dimension)
 *   Row 2: Quality Trend chart (5 overlaid lines)
 *   Row 3: Dimension Deep-Dive cards (expandable)
 *   Row 4: Flagged conversations table
 */

'use client';

import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { ChevronDown, ChevronRight, AlertTriangle, Filter } from 'lucide-react';
import { PageHeader } from '../ui/PageHeader';
import { Skeleton } from '../ui/Skeleton';
import { FilterSelect } from '../ui/FilterSelect';
import { useNavigationStore } from '../../store/navigation-store';
import { InsightKPICard } from './shared/InsightKPICard';
import { InsightsDateRangeControl } from './shared/InsightsDateRangeControl';
import { metricPercent } from '../../lib/format/metric-value';
import { formatAgentName } from '../../lib/format/agent-name';
import { TimeSeriesChart } from './shared/TimeSeriesChart';
import { EmptyState } from '../ui/EmptyState';
import {
  useQualityMonitor,
  type DimensionStats,
  type DailyQualityPoint,
  type ConversationRow,
} from '../../hooks/useQualityMonitor';
import { SEMANTIC_CHART_COLORS, CHART_COLOR_PALETTE } from '@agent-platform/design-tokens';
import { TooltipProvider } from '../ui/Tooltip';
import { usePersistedSurfaceFilters } from '../../hooks/usePersistedSurfaceFilters';
import { ResetFiltersButton } from '../shared/ResetFiltersButton';

// ── Types ───────────────────────────────────────────────────────────────────

type DateRange = '7d' | '30d' | '90d';

const STATUS_COLORS: Record<string, { text: string; bg: string; border: string; rowBg: string }> = {
  healthy: { text: 'text-success', bg: 'bg-success/10', border: 'border-l-success', rowBg: '' },
  warning: {
    text: 'text-warning',
    bg: 'bg-warning/10',
    border: 'border-l-warning',
    rowBg: 'bg-warning/5',
  },
  critical: {
    text: 'text-error',
    bg: 'bg-error/10',
    border: 'border-l-error',
    rowBg: 'bg-error/5',
  },
};

const BANNER_GRADIENTS: Record<string, string> = {
  healthy: 'from-success/10 to-success/5',
  warning: 'from-warning/10 to-warning/5',
  critical: 'from-error/10 to-error/5',
};

const DIMENSION_COLORS: Record<string, string> = {
  quality_evaluation: CHART_COLOR_PALETTE[0],
  hallucination_detection: CHART_COLOR_PALETTE[1],
  knowledge_gap: CHART_COLOR_PALETTE[2],
  guardrail_analysis: CHART_COLOR_PALETTE[3],
  context_preservation: CHART_COLOR_PALETTE[4],
};

const PAGE_SIZE = 25;
const EMPTY_STATE_DESCRIPTION = 'Run conversations with pipelines enabled to generate data.';

function InsightsEmptyState({ title }: { title: string }) {
  return (
    <EmptyState
      icon={<AlertTriangle className="w-6 h-6" />}
      title={title}
      description={EMPTY_STATE_DESCRIPTION}
      className="h-64 py-0"
    />
  );
}

// ── Quality Health Banner ──────────────────────────────────────────────────

function QualityHealthBanner({
  overallScore,
  totalEvaluated,
  flaggedCount,
  dimensions,
}: {
  overallScore: number;
  totalEvaluated: number;
  flaggedCount: number;
  dimensions: DimensionStats[];
}) {
  const criticalDims = dimensions.filter((d) => d.status === 'critical');
  const warningDims = dimensions.filter((d) => d.status === 'warning');
  const overallStatus =
    criticalDims.length > 0 ? 'critical' : warningDims.length > 0 ? 'warning' : 'healthy';
  const gradient = BANNER_GRADIENTS[overallStatus];

  return (
    <div className={clsx('rounded-xl p-4 bg-gradient-to-br border border-default', gradient)}>
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Quality Health</h3>
          <p className="text-xs text-muted mt-0.5">
            {totalEvaluated.toLocaleString()} evaluated &middot; Score{' '}
            <span className={clsx('font-medium', STATUS_COLORS[overallStatus].text)}>
              {overallScore.toFixed(2)}
            </span>
            {flaggedCount > 0 && (
              <span className="text-warning"> &middot; {flaggedCount} issue flags</span>
            )}
          </p>
        </div>
        <div className="flex gap-4 text-xs font-medium">
          {criticalDims.length > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-error" />
              <span className="text-error">{criticalDims.length} Critical</span>
            </span>
          )}
          {warningDims.length > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-warning" />
              <span className="text-warning">{warningDims.length} Warning</span>
            </span>
          )}
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-success" />
            <span className="text-success">
              {dimensions.length - criticalDims.length - warningDims.length} Healthy
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Dimension Deep-Dive Card ────────────────────────────────────────────────

function DimensionCard({ dim }: { dim: DimensionStats }) {
  const [expanded, setExpanded] = useState(false);
  // No evaluations yet → render the card with neutral chrome and a "No data" pill
  // instead of a red Critical state.
  const colors = dim.hasData
    ? STATUS_COLORS[dim.status]
    : { text: 'text-muted', bg: 'bg-background-muted', border: 'border-l-muted', rowBg: '' };
  const statusLabel = dim.hasData
    ? dim.status.charAt(0).toUpperCase() + dim.status.slice(1)
    : 'No data';

  return (
    <div
      className={clsx(
        'bg-background-elevated rounded-xl border border-default border-l-[3px] overflow-hidden',
        colors.border,
        colors.rowBg,
      )}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-4 text-left hover:bg-background-muted/50 transition-default"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span
            className="w-3 h-3 rounded-full shrink-0"
            style={{ background: DIMENSION_COLORS[dim.pipeline] }}
          />
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground truncate">{dim.label}</p>
            <p className="text-xs text-muted mt-0.5">
              Score:{' '}
              <span className={clsx('font-medium', colors.text)}>
                {dim.hasData ? dim.score.toFixed(2) : '—'}
              </span>
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {dim.flaggedCount > 0 && (
            <span
              className={clsx(
                'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium',
                colors.bg,
                colors.text,
              )}
            >
              <AlertTriangle className="w-3 h-3" />
              {dim.flaggedCount}
            </span>
          )}
          <span
            className={clsx(
              'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium',
              colors.bg,
              colors.text,
            )}
          >
            {statusLabel}
          </span>
          {expanded ? (
            <ChevronDown className="w-4 h-4 text-muted" />
          ) : (
            <ChevronRight className="w-4 h-4 text-muted" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-4 border-t border-default pt-3 space-y-3">
          {dim.subMetrics.length === 0 ? (
            <p className="text-xs text-muted">No sub-metric data available.</p>
          ) : (
            dim.subMetrics.map((sub) => (
              <div key={sub.key} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted">{sub.key.replace(/_/g, ' ')}</span>
                  <span className="font-medium text-foreground">
                    {sub.kind === 'count' ? sub.value.toLocaleString() : sub.value.toFixed(2)}
                  </span>
                </div>
                {sub.kind === 'score' && (
                  <div className="h-1.5 bg-background-muted rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-300"
                      style={{
                        width: `${Math.min(Math.max(sub.value * 100, 0), 100)}%`,
                        background: DIMENSION_COLORS[dim.pipeline],
                      }}
                    />
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ── Flagged Conversations Table ─────────────────────────────────────────────

/** Build dimension filter options dynamically from actual flag_reasons in conversation data. */
function buildFlagReasonOptions(conversations: ConversationRow[]) {
  const reasons = new Set<string>();
  for (const conv of conversations) {
    for (const r of conv.flaggedDimensions) {
      if (r) reasons.add(r);
    }
  }
  return [
    { value: 'all', label: 'All Reasons' },
    ...Array.from(reasons)
      .sort()
      .map((r) => ({ value: r, label: r })),
  ];
}

const SCORE_FILTER_OPTIONS = [
  { value: 'all', label: 'All Scores' },
  { value: 'critical', label: 'Critical (<0.5)' },
  { value: 'warning', label: 'Warning (0.5-0.7)' },
  { value: 'healthy', label: 'Healthy (>0.7)' },
];

function formatRubricLabel(key: string) {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function FlaggedConversationsTable({
  conversations,
  projectId,
  dimensionFilter,
  onDimensionFilterChange,
  scoreFilter,
  onScoreFilterChange,
}: {
  conversations: ConversationRow[];
  projectId: string | null;
  dimensionFilter: string;
  onDimensionFilterChange: (nextDimensionFilter: string) => void;
  scoreFilter: 'all' | 'critical' | 'warning' | 'healthy';
  onScoreFilterChange: (nextScoreFilter: 'all' | 'critical' | 'warning' | 'healthy') => void;
}) {
  const [currentPage, setCurrentPage] = useState(0);
  const navigate = useNavigationStore((s) => s.navigate);
  const flagReasonOptions = buildFlagReasonOptions(conversations);
  const effectiveDimensionFilter = flagReasonOptions.some(
    (option) => option.value === dimensionFilter,
  )
    ? dimensionFilter
    : 'all';

  useEffect(() => {
    if (dimensionFilter !== effectiveDimensionFilter) {
      onDimensionFilterChange(effectiveDimensionFilter);
      setCurrentPage(0);
    }
  }, [dimensionFilter, effectiveDimensionFilter, onDimensionFilterChange]);

  const filtered = conversations.filter((conv) => {
    if (effectiveDimensionFilter !== 'all') {
      if (!conv.flaggedDimensions.includes(effectiveDimensionFilter)) return false;
    }
    if (scoreFilter === 'critical' && conv.qualityScore >= 0.5) return false;
    if (scoreFilter === 'warning' && (conv.qualityScore < 0.5 || conv.qualityScore > 0.7))
      return false;
    if (scoreFilter === 'healthy' && conv.qualityScore <= 0.7) return false;
    return true;
  });

  if (conversations.length === 0) {
    return <InsightsEmptyState title="No flagged conversations found." />;
  }

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  return (
    <div>
      {/* Filters */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-default">
        <Filter className="w-3.5 h-3.5 text-muted" />
        <FilterSelect
          value={effectiveDimensionFilter}
          onChange={(value) => {
            onDimensionFilterChange(value);
            setCurrentPage(0);
          }}
          options={flagReasonOptions}
        />
        <FilterSelect
          value={scoreFilter}
          onChange={(value) => {
            onScoreFilterChange(value as 'all' | 'critical' | 'warning' | 'healthy');
            setCurrentPage(0);
          }}
          options={SCORE_FILTER_OPTIONS}
        />
        {(effectiveDimensionFilter !== 'all' || scoreFilter !== 'all') && (
          <button
            onClick={() => {
              onDimensionFilterChange('all');
              onScoreFilterChange('all');
              setCurrentPage(0);
            }}
            className="text-xs text-accent hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="text-xs text-muted border-b border-default">
              <th className="px-4 py-3 text-left font-medium">Date</th>
              <th className="px-4 py-3 text-left font-medium">Agent</th>
              <th className="px-4 py-3 text-right font-medium">Health Score</th>
              <th className="px-4 py-3 text-left font-medium">Flag Reasons</th>
              <th className="px-4 py-3 text-left font-medium">Rubric Scores</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-sm text-muted">
                  No conversations match the selected filters.
                </td>
              </tr>
            ) : (
              visible.map((conv, idx) => {
                const scoreStatus =
                  conv.qualityScore > 0.7
                    ? 'healthy'
                    : conv.qualityScore > 0.5
                      ? 'warning'
                      : 'critical';
                const scoreColor = STATUS_COLORS[scoreStatus].text;

                return (
                  <tr
                    key={`${conv.sessionId}-${idx}`}
                    className={clsx(
                      'border-b border-muted transition-default hover:bg-background-muted cursor-pointer',
                      STATUS_COLORS[scoreStatus].rowBg,
                    )}
                    onClick={() => {
                      if (projectId && conv.sessionId) {
                        navigate(`/projects/${projectId}/sessions/${conv.sessionId}`);
                      }
                    }}
                  >
                    <td
                      className={clsx(
                        'px-4 py-3 text-sm text-muted border-l-2',
                        STATUS_COLORS[scoreStatus].border,
                      )}
                    >
                      {conv.date
                        ? new Date(conv.date).toLocaleDateString(undefined, {
                            month: 'short',
                            day: 'numeric',
                          })
                        : '\u2014'}
                    </td>
                    <td className="px-4 py-3 text-sm font-medium text-foreground">
                      {formatAgentName(conv.agentName)}
                    </td>
                    <td className={clsx('px-4 py-3 text-sm text-right font-medium', scoreColor)}>
                      {conv.qualityScore.toFixed(2)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {conv.flaggedDimensions.map((dim) => (
                          <span
                            key={dim}
                            className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-error/10 text-error"
                          >
                            {dim.replace(/_/g, ' ')}
                          </span>
                        ))}
                        {conv.flaggedDimensions.length === 0 && (
                          <span className="text-xs text-muted">N/A</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {Object.keys(conv.rubricScores).length > 0 ? (
                        <div className="flex flex-wrap gap-1.5">
                          {Object.entries(conv.rubricScores).map(([key, value]) => {
                            const isCustom = key in conv.customDimensions;
                            return (
                              <span
                                key={key}
                                className={clsx(
                                  'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium',
                                  isCustom
                                    ? 'bg-accent/10 text-accent'
                                    : 'bg-background-muted text-muted',
                                )}
                              >
                                <span>{formatRubricLabel(key)}</span>
                                <span>{value.toFixed(2)}</span>
                              </span>
                            );
                          })}
                        </div>
                      ) : (
                        <span className="text-sm text-muted">{'\u2014'}</span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-default">
          <p className="text-xs text-muted">
            Showing {currentPage * PAGE_SIZE + 1}-
            {Math.min((currentPage + 1) * PAGE_SIZE, filtered.length)} of {filtered.length}
          </p>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setCurrentPage(Math.max(0, currentPage - 1))}
              disabled={currentPage === 0}
              className="px-2.5 py-1 text-xs rounded-md border border-default text-muted hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition-default"
            >
              Prev
            </button>
            <button
              onClick={() => setCurrentPage(Math.min(totalPages - 1, currentPage + 1))}
              disabled={currentPage >= totalPages - 1}
              className="px-2.5 py-1 text-xs rounded-md border border-default text-muted hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition-default"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Quality Trend Section ───────────────────────────────────────────────────

function QualityTrendSection({ data }: { data: DailyQualityPoint[] }) {
  if (data.length === 0) {
    return <InsightsEmptyState title="No trend data available yet." />;
  }

  return (
    <TimeSeriesChart
      data={data}
      dateKey="day"
      metrics={[
        { key: 'quality_evaluation', label: 'Quality', color: DIMENSION_COLORS.quality_evaluation },
        {
          key: 'hallucination_detection',
          label: 'Hallucination',
          color: DIMENSION_COLORS.hallucination_detection,
        },
        { key: 'knowledge_gap', label: 'Knowledge Gap', color: DIMENSION_COLORS.knowledge_gap },
        {
          key: 'guardrail_analysis',
          label: 'Guardrails',
          color: DIMENSION_COLORS.guardrail_analysis,
        },
        {
          key: 'context_preservation',
          label: 'Context',
          color: DIMENSION_COLORS.context_preservation,
        },
      ]}
      height={300}
      yAxisFormatter={(v) => v.toFixed(1)}
    />
  );
}

// ── Main Page ───────────────────────────────────────────────────────────────

export function QualityMonitorPage() {
  const {
    state: persistedFilters,
    updateState,
    reset,
    nonDefaultCount,
  } = usePersistedSurfaceFilters('qualityMonitor');
  const dateRange = persistedFilters.dateRange as DateRange;

  const {
    overallQualityScore,
    totalEvaluated,
    flaggedCount,
    dimensions,
    dailyTrend,
    flaggedConversations,
    isLoading,
    error,
    projectId,
  } = useQualityMonitor(dateRange);

  if (!projectId) {
    return (
      <div className="flex items-center justify-center h-64 text-muted">
        Select a project to view quality monitoring
      </div>
    );
  }

  const dateRangeControl = (
    <InsightsDateRangeControl
      preset="day"
      value={dateRange}
      onChange={(value) => updateState({ dateRange: value as DateRange })}
    />
  );

  // Get dimension data for KPI cards
  const qualDim = dimensions.find((d) => d.pipeline === 'quality_evaluation');
  const halDim = dimensions.find((d) => d.pipeline === 'hallucination_detection');
  const kgDim = dimensions.find((d) => d.pipeline === 'knowledge_gap');
  const grDim = dimensions.find((d) => d.pipeline === 'guardrail_analysis');
  const ctxDim = dimensions.find((d) => d.pipeline === 'context_preservation');

  // No evaluations across any pipeline → render neutral "no data" cards
  // (em-dash values, warning status), hide the banner, and let inner
  // sections show their existing empty states.
  const hasAnyData = dimensions.some((d) => d.hasData);
  const formatPercentValue = (value: number | null) =>
    hasAnyData && value != null ? metricPercent(value * 100, 0) : '—';
  const dimKpiStatus = (dim: DimensionStats | undefined) =>
    dim && dim.hasData ? dim.status : 'warning';

  return (
    <div className="h-full overflow-y-auto bg-noise">
      <div className="max-w-7xl mx-auto px-6 py-8 space-y-6">
        {/* Header */}
        <PageHeader
          title="Quality Monitor"
          description="Monitor quality health across all evaluation dimensions"
          beforeActions={<ResetFiltersButton count={nonDefaultCount} onClick={reset} />}
          actions={dateRangeControl}
        />

        {/* Error state */}
        {error && (
          <div className="rounded-lg border border-error/30 bg-error-subtle p-4 text-sm text-error">
            Failed to load some quality data. Showing available metrics.
          </div>
        )}

        {/* Health Banner — hidden when no data; inner sections show their own empty states */}
        {!isLoading && hasAnyData && (
          <QualityHealthBanner
            overallScore={overallQualityScore}
            totalEvaluated={totalEvaluated}
            flaggedCount={flaggedCount}
            dimensions={dimensions}
          />
        )}

        {/* Row 1: KPI Cards */}
        {isLoading ? (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </div>
        ) : (
          <TooltipProvider>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              <InsightKPICard
                title="Overall Quality"
                value={hasAnyData ? metricPercent(overallQualityScore * 100, 0) : '—'}
                subtitle={`${totalEvaluated} evaluated`}
                tooltip="Weighted average across all 5 quality dimensions: quality (30%), hallucination (25%), guardrails (20%), knowledge gaps (15%), context (10%)"
                sparkline={qualDim?.sparkline}
                status={
                  !hasAnyData
                    ? 'warning'
                    : overallQualityScore > 0.7
                      ? 'healthy'
                      : overallQualityScore > 0.5
                        ? 'warning'
                        : 'critical'
                }
              />
              <InsightKPICard
                title="Faithfulness Score"
                value={formatPercentValue(halDim?.hasData ? halDim.score : null)}
                subtitle={
                  halDim?.flaggedCount ? `${halDim.flaggedCount} flagged` : 'higher is better'
                }
                tooltip="How well the AI avoids unsupported or contradictory statements. Higher scores indicate stronger faithfulness"
                sparkline={halDim?.sparkline}
                status={dimKpiStatus(halDim)}
              />
              <InsightKPICard
                title="Knowledge Coverage"
                value={formatPercentValue(kgDim?.hasData ? kgDim.score : null)}
                subtitle={
                  kgDim?.flaggedCount ? `${kgDim.flaggedCount} gaps found` : 'higher is better'
                }
                tooltip="How well retrieved knowledge supports answers. Higher scores reflect stronger retrieval precision and citation coverage"
                sparkline={kgDim?.sparkline}
                status={dimKpiStatus(kgDim)}
              />
              <InsightKPICard
                title="Safety Score"
                value={formatPercentValue(grDim?.hasData ? grDim.score : null)}
                subtitle={
                  grDim?.flaggedCount ? `${grDim.flaggedCount} violations` : 'guardrail pass'
                }
                tooltip="How well the AI stays within safety guardrails. Tracks false positives, false negatives, and bypass attempts"
                sparkline={grDim?.sparkline}
                status={dimKpiStatus(grDim)}
              />
              <InsightKPICard
                title="Context Preservation"
                value={formatPercentValue(ctxDim?.hasData ? ctxDim.score : null)}
                subtitle={
                  ctxDim?.flaggedCount ? `${ctxDim.flaggedCount} flagged` : 'higher is better'
                }
                tooltip="How well the AI maintains conversation context across turns. Tracks context retention, duplication, and handoff quality"
                sparkline={ctxDim?.sparkline}
                status={dimKpiStatus(ctxDim)}
              />
            </div>
          </TooltipProvider>
        )}

        {/* Row 2: Quality Trend Chart */}
        <div className="bg-background-elevated rounded-xl border border-default p-6">
          <h3 className="text-sm font-semibold text-foreground mb-4">Quality Trend</h3>
          {isLoading ? (
            <Skeleton className="h-72 rounded-lg" />
          ) : (
            <QualityTrendSection data={dailyTrend} />
          )}
        </div>

        {/* Row 3: Dimension Deep-Dive Cards */}
        <div>
          <h3 className="text-sm font-semibold text-foreground mb-3">Dimension Details</h3>
          {isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-16 rounded-xl" />
              ))}
            </div>
          ) : (
            <div className="space-y-3">
              {dimensions.map((dim) => (
                <DimensionCard key={dim.pipeline} dim={dim} />
              ))}
            </div>
          )}
        </div>

        {/* Row 4: Flagged Conversations Table */}
        <div className="bg-background-elevated rounded-xl border border-default overflow-hidden">
          <div className="px-6 py-4 border-b border-default">
            <h3 className="text-sm font-semibold text-foreground">Flagged Conversations</h3>
            <p className="text-xs text-muted mt-0.5">
              Conversations with flags across any quality dimension
            </p>
          </div>
          {isLoading ? (
            <div className="p-6">
              <Skeleton className="h-48 rounded-lg" />
            </div>
          ) : (
            <FlaggedConversationsTable
              conversations={flaggedConversations}
              projectId={projectId}
              dimensionFilter={persistedFilters.dimensionFilter}
              onDimensionFilterChange={(nextDimensionFilter) =>
                updateState({ dimensionFilter: nextDimensionFilter })
              }
              scoreFilter={persistedFilters.scoreFilter}
              onScoreFilterChange={(nextScoreFilter) =>
                updateState({ scoreFilter: nextScoreFilter })
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}
