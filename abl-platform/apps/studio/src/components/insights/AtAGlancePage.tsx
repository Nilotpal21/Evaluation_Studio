/**
 * At a Glance — Executive Insights Dashboard
 *
 * Shows 6 KPI cards, multi-metric trend charts, outcome distribution,
 * agent breakdown table, ROI summary with configurable cost settings,
 * and a conversations explorer.
 *
 * Uses real data from useAtAGlance hook:
 *   - KPI cards: session-metrics + pipeline-analytics (quality, sentiment)
 *   - Timeseries: /insights/timeseries (raw table queries, bypasses broken MVs)
 *   - Outcomes: /insights/outcomes
 *   - Breakdown: pipeline-analytics agent breakdown (intent_classification grouped by agent_name)
 *   - ROI: computed from cost-breakdown + outcomes + configurable cost settings
 *   - Conversations: pipeline-analytics quality_evaluation conversations
 */

'use client';

import { useEffect, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronLeft, ChevronRight, Info, Settings } from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { clsx } from 'clsx';
import { PageHeader } from '../ui/PageHeader';
import { Tabs } from '../ui/Tabs';
import { Skeleton } from '../ui/Skeleton';
import { InsightsDateRangeControl } from './shared/InsightsDateRangeControl';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { FilterSelect } from '../ui/FilterSelect';
import { InsightKPICard } from './shared/InsightKPICard';
import { TooltipProvider } from '../ui/Tooltip';
import { TimeSeriesChart } from './shared/TimeSeriesChart';
import { BreakdownTable } from './shared/BreakdownTable';
import { EmptyState } from '../ui/EmptyState';
import { OutcomeDistribution } from './shared/OutcomeDistribution';
import { useNavigationStore } from '../../store/navigation-store';
import { usePersistedSurfaceFilters } from '../../hooks/usePersistedSurfaceFilters';
import {
  useAtAGlance,
  type DailyPoint,
  type BreakdownRow,
  type ComputedROI,
  type ROIConfig,
  type ConversationRow,
} from '../../hooks/useAtAGlance';
import { SEMANTIC_CHART_COLORS, CHART_COLOR_PALETTE } from '@agent-platform/design-tokens';
import { ResetFiltersButton } from '../shared/ResetFiltersButton';

// ── Types ───────────────────────────────────────────────────────────────────

type DateRange = '7d' | '30d' | '90d';
type TabId = 'overview' | 'trends' | 'roi' | 'conversations';

const TAB_IDS: TabId[] = ['overview', 'trends', 'roi', 'conversations'];

const EMPTY_STATE_DESCRIPTION = 'Run conversations with pipelines enabled to generate data.';

function InsightsEmptyState({ title }: { title: string }) {
  return (
    <EmptyState
      icon={<Info className="w-6 h-6" />}
      title={title}
      description={EMPTY_STATE_DESCRIPTION}
      className="h-64 py-0"
    />
  );
}

// ── Custom tooltip ──────────────────────────────────────────────────────────

function ChartTooltipContent({
  active,
  payload,
  label,
}: {
  active?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: any[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-default bg-background-elevated px-3 py-2 shadow-lg text-xs">
      {label && <p className="text-muted mb-1 font-medium">{label}</p>}
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2">
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ background: p.fill || p.color }}
          />
          <span className="text-muted">{p.name}:</span>
          <span className="text-foreground font-medium">
            {typeof p.value === 'number'
              ? p.dataKey === 'aiCost' || p.dataKey === 'humanCost'
                ? `$${p.value.toFixed(2)}`
                : p.value.toLocaleString()
              : p.value}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Tab Content: Overview ───────────────────────────────────────────────────

function OverviewTab({
  daily,
  outcomesList,
  agentBreakdown,
}: {
  daily: DailyPoint[];
  outcomesList: { outcome: string; count: number }[];
  agentBreakdown: BreakdownRow[];
}) {
  const hasTimeseries = daily.length > 0;
  const hasOutcomes = outcomesList.length > 0;
  const hasBreakdown = agentBreakdown.length > 0;

  return (
    <div className="space-y-6">
      {/* Volume + Containment trend */}
      <div className="bg-background-elevated rounded-xl border border-default p-6">
        <h3 className="text-sm font-semibold text-foreground mb-4">
          Conversation Volume & Containment Rate
        </h3>
        {hasTimeseries ? (
          <TimeSeriesChart
            data={daily}
            dateKey="day"
            metrics={[
              { key: 'conversations', label: 'Conversations', type: 'area' },
              { key: 'containment', label: 'Containment %', color: SEMANTIC_CHART_COLORS.success },
            ]}
            height={300}
          />
        ) : (
          <InsightsEmptyState title="No timeseries data available yet." />
        )}
      </div>

      {/* Outcome distribution */}
      <div className="bg-background-elevated rounded-xl border border-default p-6">
        <h3 className="text-sm font-semibold text-foreground mb-4">Outcome Distribution</h3>
        {hasOutcomes ? (
          <OutcomeDistribution outcomes={outcomesList} />
        ) : (
          <InsightsEmptyState title="No outcome data available yet." />
        )}
      </div>

      {/* Intent breakdown */}
      <div className="bg-background-elevated rounded-xl border border-default overflow-hidden">
        <div className="px-6 py-4 border-b border-default">
          <h3 className="text-sm font-semibold text-foreground">What&apos;s Driving the Metrics</h3>
          <p className="text-xs text-muted mt-0.5">Agent breakdown by conversation volume</p>
        </div>
        {hasBreakdown ? (
          <BreakdownTable data={agentBreakdown} />
        ) : (
          <InsightsEmptyState title="No agent breakdown data available yet." />
        )}
      </div>
    </div>
  );
}

// ── Tab Content: Trends ─────────────────────────────────────────────────────

function TrendsTab({ daily }: { daily: DailyPoint[] }) {
  if (daily.length === 0) {
    return <InsightsEmptyState title="No trend data available yet." />;
  }

  return (
    <div className="space-y-6">
      <div className="bg-background-elevated rounded-xl border border-default p-6">
        <h3 className="text-sm font-semibold text-foreground mb-4">Multi-Metric Trends</h3>
        <TimeSeriesChart
          data={daily}
          dateKey="day"
          metrics={[
            { key: 'containment', label: 'Containment %', color: SEMANTIC_CHART_COLORS.success },
            { key: 'escalation', label: 'Escalation %', color: SEMANTIC_CHART_COLORS.warning },
            { key: 'quality', label: 'Quality Score', color: CHART_COLOR_PALETTE[0] },
          ]}
          height={350}
        />
      </div>

      <div className="bg-background-elevated rounded-xl border border-default p-6">
        <h3 className="text-sm font-semibold text-foreground mb-4">
          Sentiment & Quality Over Time
        </h3>
        <TimeSeriesChart
          data={daily}
          dateKey="day"
          metrics={[
            { key: 'sentiment', label: 'Avg Sentiment', color: CHART_COLOR_PALETTE[1] },
            { key: 'quality', label: 'Avg Quality', color: CHART_COLOR_PALETTE[2] },
          ]}
          height={300}
        />
      </div>

      {/* Daily outcomes stacked bar */}
      {daily.some((d) => d.resolved > 0 || d.escalated > 0 || d.other > 0) && (
        <div className="bg-background-elevated rounded-xl border border-default p-6">
          <h3 className="text-sm font-semibold text-foreground mb-4">Daily Outcome Distribution</h3>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={daily} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="day" tick={{ fontSize: 11, fill: 'hsl(var(--foreground-muted))' }} />
              <YAxis tick={{ fontSize: 11, fill: 'hsl(var(--foreground-muted))' }} />
              <Tooltip content={<ChartTooltipContent />} cursor={{ fill: 'transparent' }} />
              <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '8px' }} />
              <Bar
                dataKey="resolved"
                name="Resolved"
                stackId="outcome"
                fill={SEMANTIC_CHART_COLORS.success}
                activeBar={false}
              />
              <Bar
                dataKey="escalated"
                name="Escalated"
                stackId="outcome"
                fill={SEMANTIC_CHART_COLORS.warning}
                activeBar={false}
              />
              <Bar
                dataKey="other"
                name="Other"
                stackId="outcome"
                fill={SEMANTIC_CHART_COLORS.muted}
                radius={[2, 2, 0, 0]}
                activeBar={false}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

// ── Tab Content: ROI ────────────────────────────────────────────────────────

/** Adaptive Y-axis formatter: $0.XX for < $1, $X for $1-$999, $X.Xk for >= $1000 */
function formatDollarAxis(v: number): string {
  if (v < 1) return `$${v.toFixed(2)}`;
  if (v < 1000) return `$${Math.round(v)}`;
  return `$${(v / 1000).toFixed(1)}k`;
}

function ROITab({
  computedROI,
  roiConfig,
  daily,
}: {
  computedROI: ComputedROI;
  roiConfig: ROIConfig;
  daily: DailyPoint[];
}) {
  // Build cost comparison data from daily timeseries
  const costComparisonData = daily.map((d) => ({
    day: d.day,
    aiCost: computedROI.costPerResolution * d.conversations,
    humanCost: d.conversations * roiConfig.humanCostPerConversation,
  }));

  const costSourceSubtitle = computedROI.isEstimatedCost
    ? `Based on $${roiConfig.humanCostPerConversation}/conversation human cost and $${roiConfig.estimatedAiCostPerConversation}/conversation estimated AI cost`
    : `Based on $${roiConfig.humanCostPerConversation}/conversation human cost and actual LLM usage costs`;

  // No conversations to derive ROI from → render neutral "—" cards instead of
  // a misleading "0% critical" state.
  const hasRoiData = daily.some((d) => d.conversations > 0);

  return (
    <div className="space-y-6">
      {/* KPI cards with tooltips */}
      <TooltipProvider>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <InsightKPICard
            title="Monthly Savings"
            value={
              hasRoiData
                ? `$${computedROI.monthlySavings.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                : '—'
            }
            tooltip="Cost avoided by AI handling conversations instead of humans: (contained conversations x human cost) minus total AI cost"
            status={
              hasRoiData ? (computedROI.monthlySavings >= 0 ? 'healthy' : 'critical') : 'warning'
            }
          />
          <InsightKPICard
            title="Annual ROI"
            value={hasRoiData ? `${computedROI.annualROI.toFixed(0)}%` : '—'}
            tooltip="Return on investment: (monthly savings / total AI cost) x 100"
            status={
              !hasRoiData
                ? 'warning'
                : computedROI.annualROI > 100
                  ? 'healthy'
                  : computedROI.annualROI > 0
                    ? 'warning'
                    : 'critical'
            }
          />
          <InsightKPICard
            title="FTE Equivalent"
            value={
              !hasRoiData
                ? '—'
                : computedROI.fteEquivalent >= 0.1
                  ? computedROI.fteEquivalent.toFixed(1)
                  : computedROI.fteEquivalent > 0
                    ? '< 0.1'
                    : '0'
            }
            tooltip="Full-time human agents the AI replaces, based on avg handle time and contained conversation volume"
            status={hasRoiData && computedROI.fteEquivalent > 0 ? 'healthy' : 'warning'}
          />
          <InsightKPICard
            title="Cost / Resolution"
            value={hasRoiData ? `$${computedROI.costPerResolution.toFixed(2)}` : '—'}
            tooltip="Average AI cost per conversation. Uses LLM cost data when available, otherwise the estimated cost from Settings"
            status={
              !hasRoiData
                ? 'warning'
                : computedROI.costPerResolution < roiConfig.humanCostPerConversation
                  ? 'healthy'
                  : 'critical'
            }
          />
        </div>
      </TooltipProvider>

      {/* Cost comparison chart */}
      <div className="bg-background-elevated rounded-xl border border-default p-6">
        <h3 className="text-sm font-semibold text-foreground mb-1">
          AI Cost vs Estimated Human Cost
        </h3>
        <p className="text-xs text-muted mb-4">{costSourceSubtitle}</p>
        {costComparisonData.length > 0 ? (
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={costComparisonData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="day" tick={{ fontSize: 11, fill: 'hsl(var(--foreground-muted))' }} />
              <YAxis
                tick={{ fontSize: 11, fill: 'hsl(var(--foreground-muted))' }}
                tickFormatter={formatDollarAxis}
              />
              <Tooltip content={<ChartTooltipContent />} cursor={{ fill: 'transparent' }} />
              <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '8px' }} />
              <Bar
                dataKey="aiCost"
                name="AI Cost"
                fill={SEMANTIC_CHART_COLORS.accent}
                radius={[4, 4, 0, 0]}
                activeBar={false}
              />
              <Bar
                dataKey="humanCost"
                name="Est. Human Cost"
                fill={SEMANTIC_CHART_COLORS.warning}
                radius={[4, 4, 0, 0]}
                activeBar={false}
              />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <InsightsEmptyState title="No daily data available for cost comparison." />
        )}
      </div>
    </div>
  );
}

// ── Outcome badge helper ───────────────────────────────────────────────────

function OutcomeBadge({ flagged }: { flagged: number }) {
  if (flagged) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-error-subtle text-error">
        Flagged
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-success-subtle text-success">
      OK
    </span>
  );
}

// ── Tab Content: Conversations ──────────────────────────────────────────────

const FILTER_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'flagged:true', label: 'Flagged' },
  { value: 'score_lt:3.0', label: 'Low Quality (<3.0)' },
  { value: 'score_gt:4.0', label: 'High Quality (>4.0)' },
];

function ConversationsTab({
  conversations,
  total,
  hasMore,
  page,
  onPageChange,
  filter,
  onFilterChange,
  projectId,
}: {
  conversations: ConversationRow[];
  total: number;
  hasMore: boolean;
  page: number;
  onPageChange: (page: number) => void;
  filter: string;
  onFilterChange: (filter: string) => void;
  projectId: string | null;
}) {
  const navigate = useNavigationStore((s) => s.navigate);
  const pageSize = 25;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex items-center gap-3">
        <FilterSelect
          value={filter}
          onChange={(value) => {
            onFilterChange(value);
            onPageChange(0);
          }}
          options={FILTER_OPTIONS}
        />
        <span className="text-xs text-muted">
          {total} conversation{total !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Table */}
      <div className="bg-background-elevated rounded-xl border border-default overflow-hidden">
        {conversations.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-xs text-muted border-b border-default">
                  <th className="px-4 py-3 font-medium text-left">Date</th>
                  <th className="px-4 py-3 font-medium text-left">Agent</th>
                  <th className="px-4 py-3 font-medium text-center">Status</th>
                  <th className="px-4 py-3 font-medium text-right">Quality Score</th>
                  <th className="px-4 py-3 font-medium text-right">Helpfulness</th>
                  <th className="px-4 py-3 font-medium text-right">Accuracy</th>
                </tr>
              </thead>
              <tbody>
                {conversations.map((conv) => (
                  <tr
                    key={conv.session_id}
                    className="border-b border-muted hover:bg-background-muted transition-default cursor-pointer"
                    onClick={() => {
                      if (projectId && conv.session_id) {
                        navigate(`/projects/${projectId}/sessions/${conv.session_id}`);
                      }
                    }}
                  >
                    <td className="px-4 py-3 text-sm text-muted">
                      {conv.session_started_at
                        ? new Date(conv.session_started_at).toLocaleDateString(undefined, {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : '\u2014'}
                    </td>
                    <td className="px-4 py-3 text-sm font-medium text-foreground">
                      {conv.agent_name}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <OutcomeBadge flagged={conv.flagged} />
                    </td>
                    <td
                      className={clsx(
                        'px-4 py-3 text-sm text-right font-medium',
                        conv.overall_score >= 3.5
                          ? 'text-success'
                          : conv.overall_score >= 2.5
                            ? 'text-foreground'
                            : 'text-error',
                      )}
                    >
                      {conv.overall_score > 0 ? conv.overall_score.toFixed(1) : '\u2014'}
                    </td>
                    <td className="px-4 py-3 text-sm text-right text-muted">
                      {conv.helpfulness > 0 ? conv.helpfulness.toFixed(1) : '\u2014'}
                    </td>
                    <td className="px-4 py-3 text-sm text-right text-muted">
                      {conv.accuracy > 0 ? conv.accuracy.toFixed(1) : '\u2014'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <InsightsEmptyState title="No conversations found matching the current filters." />
        )}
      </div>

      {/* Pagination */}
      {total > pageSize && (
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted">
            Page {page + 1} of {totalPages}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => onPageChange(Math.max(0, page - 1))}
              disabled={page === 0}
              className="p-1.5 rounded-lg text-muted hover:text-foreground hover:bg-background-muted disabled:opacity-40 disabled:cursor-not-allowed transition-default"
              aria-label="Previous page"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              onClick={() => onPageChange(page + 1)}
              disabled={!hasMore}
              className="p-1.5 rounded-lg text-muted hover:text-foreground hover:bg-background-muted disabled:opacity-40 disabled:cursor-not-allowed transition-default"
              aria-label="Next page"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── KPI status helper ───────────────────────────────────────────────────────

function kpiStatus(value: number, goodThreshold: number, warnThreshold: number, inverse = false) {
  if (inverse) {
    if (value <= goodThreshold) return 'healthy' as const;
    if (value <= warnThreshold) return 'warning' as const;
    return 'critical' as const;
  }
  if (value >= goodThreshold) return 'healthy' as const;
  if (value >= warnThreshold) return 'warning' as const;
  return 'critical' as const;
}

// ── Main Page ───────────────────────────────────────────────────────────────

export function AtAGlancePage() {
  const t = useTranslations('insights.atAGlance');
  const {
    state: persistedFilters,
    updateState,
    reset,
    nonDefaultCount,
  } = usePersistedSurfaceFilters('atAGlance');
  const dateRange = persistedFilters.dateRange as DateRange;
  const activeTab = persistedFilters.activeTab as TabId;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editConfig, setEditConfig] = useState<ROIConfig | null>(null);
  const [conversationPage, setConversationPage] = useState(0);
  const tabs = TAB_IDS.map((id) => ({ id, label: t(`tabs.${id}`) }));

  const {
    kpis,
    daily,
    outcomesList,
    agentBreakdown,
    evaluatedCount,
    resolvedCount,
    escalatedCount,
    sentimentConversationCount,
    computedROI,
    roiConfig,
    updateRoiConfig,
    conversations,
    conversationsTotal,
    conversationsHasMore,
    isLoading,
    error,
    projectId,
  } = useAtAGlance({
    dateRange,
    conversationFilter: persistedFilters.conversationFilter,
    conversationPage,
  });

  useEffect(() => {
    setConversationPage(0);
  }, [projectId, dateRange]);

  if (!projectId) {
    return (
      <div className="flex items-center justify-center h-64 text-muted">
        Select a project to view insights
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

  const containmentPct = (kpis.containmentRate * 100).toFixed(1);
  const escalationPct = (kpis.escalationRate * 100).toFixed(1);
  // No conversations evaluated yet → KPI cards should show "—" with a neutral
  // warning status, not red "critical" derived from a 0% score.
  const hasAnyData = kpis.totalConversations > 0;
  const hasEvaluations = evaluatedCount > 0;

  return (
    <div className="h-full overflow-y-auto bg-noise">
      <div className="max-w-7xl mx-auto px-6 py-8 space-y-6">
        {/* Header */}
        <PageHeader
          title="At a Glance"
          description="Executive overview of your AI agent program"
          beforeActions={<ResetFiltersButton count={nonDefaultCount} onClick={reset} />}
          actions={
            <div className="flex w-full items-center justify-start sm:w-auto lg:justify-end">
              {dateRangeControl}
            </div>
          }
        />

        {/* Error state */}
        {error && (
          <div className="rounded-lg border border-error/30 bg-error-subtle p-4 text-sm text-error">
            Failed to load some analytics data. Showing available metrics.
          </div>
        )}

        {/* KPI Cards */}
        {isLoading ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </div>
        ) : (
          <TooltipProvider>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
              <InsightKPICard
                title="Conversations"
                value={kpis.totalConversations.toLocaleString()}
                subtitle={evaluatedCount > 0 ? `${evaluatedCount} evaluated` : undefined}
                tooltip="Total conversation sessions with your AI agents in the selected period"
                status={kpis.totalConversations > 0 ? 'healthy' : 'warning'}
              />
              <InsightKPICard
                title="Containment Rate"
                value={hasEvaluations ? `${containmentPct}%` : '—'}
                subtitle={
                  evaluatedCount > 0 ? `${resolvedCount} of ${evaluatedCount} resolved` : undefined
                }
                tooltip="Percentage of conversations fully resolved by AI without human escalation"
                status={hasEvaluations ? kpiStatus(kpis.containmentRate, 0.7, 0.5) : 'warning'}
              />
              <InsightKPICard
                title="Quality Score"
                value={kpis.qualityScore > 0 ? kpis.qualityScore.toFixed(1) : '\u2014'}
                tooltip="Average quality score (1-5) from the LLM evaluation pipeline. Requires quality_evaluation pipeline to be enabled"
                status={kpis.qualityScore > 0 ? kpiStatus(kpis.qualityScore, 3.5, 2.5) : 'warning'}
              />
              <InsightKPICard
                title="Avg Sentiment"
                value={sentimentConversationCount > 0 ? kpis.avgSentiment.toFixed(2) : '\u2014'}
                tooltip="Average customer sentiment (-1 to +1) from sentiment analysis pipeline. Positive values indicate satisfied customers"
                status={
                  sentimentConversationCount > 0 ? kpiStatus(kpis.avgSentiment, 0.5, 0) : 'warning'
                }
              />
              <InsightKPICard
                title="Cost Savings"
                value={
                  hasAnyData
                    ? `$${computedROI.monthlySavings.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                    : '—'
                }
                tooltip="Estimated monthly savings vs human agents based on contained conversations and cost settings. Configure in ROI tab → Cost Settings"
                status={
                  hasAnyData ? (computedROI.monthlySavings > 0 ? 'healthy' : 'warning') : 'warning'
                }
              />
              <InsightKPICard
                title="Escalation Rate"
                value={hasEvaluations ? `${escalationPct}%` : '—'}
                subtitle={
                  evaluatedCount > 0
                    ? `${escalatedCount} of ${evaluatedCount} evaluated`
                    : undefined
                }
                tooltip="Percentage of conversations that were transferred to a human agent"
                status={
                  hasEvaluations ? kpiStatus(kpis.escalationRate, 0.15, 0.25, true) : 'warning'
                }
              />
            </div>
          </TooltipProvider>
        )}

        {/* Tabs + contextual action */}
        <div className="flex items-center justify-between">
          <Tabs
            tabs={tabs}
            activeTab={activeTab}
            onTabChange={(id) => updateState({ activeTab: id as TabId })}
            layoutId="at-a-glance-tabs"
            className="flex-1"
          />
          {activeTab === 'roi' && (
            <div className="flex items-center gap-3 ml-4 shrink-0">
              {computedROI.isEstimatedCost && (
                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium bg-warning/10 text-warning">
                  <Info className="w-3 h-3" />
                  Estimated AI costs
                </span>
              )}
              <button
                onClick={() => {
                  setEditConfig({ ...roiConfig });
                  setSettingsOpen(true);
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted hover:text-foreground bg-background-muted hover:bg-background-elevated rounded-lg border border-default transition-default"
                aria-label="ROI cost settings"
              >
                <Settings className="w-3.5 h-3.5" />
                Cost Settings
              </button>
            </div>
          )}
        </div>

        {/* Tab content */}
        {activeTab === 'overview' && (
          <OverviewTab daily={daily} outcomesList={outcomesList} agentBreakdown={agentBreakdown} />
        )}
        {activeTab === 'trends' && <TrendsTab daily={daily} />}
        {activeTab === 'roi' && (
          <ROITab computedROI={computedROI} roiConfig={roiConfig} daily={daily} />
        )}
        {activeTab === 'conversations' && (
          <ConversationsTab
            conversations={conversations}
            total={conversationsTotal}
            hasMore={conversationsHasMore}
            page={conversationPage}
            onPageChange={setConversationPage}
            filter={persistedFilters.conversationFilter}
            onFilterChange={(filter) => {
              updateState({ conversationFilter: filter });
              setConversationPage(0);
            }}
            projectId={projectId}
          />
        )}

        {/* ROI Cost Settings dialog (rendered at page level) */}
        {editConfig && (
          <Dialog
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            title="ROI Cost Settings"
            maxWidth="sm"
          >
            <div className="space-y-4">
              <Input
                label="Human Cost per Conversation ($)"
                type="number"
                step="0.50"
                min="0"
                value={editConfig.humanCostPerConversation}
                onChange={(e) =>
                  setEditConfig((prev) =>
                    prev
                      ? { ...prev, humanCostPerConversation: Number(e.target.value) || 0 }
                      : prev,
                  )
                }
              />
              <Input
                label="Human FTE Monthly Cost ($)"
                type="number"
                step="100"
                min="0"
                value={editConfig.humanFteCost}
                onChange={(e) =>
                  setEditConfig((prev) =>
                    prev ? { ...prev, humanFteCost: Number(e.target.value) || 0 } : prev,
                  )
                }
              />
              <Input
                label="Avg Human Handle Time (minutes)"
                type="number"
                step="1"
                min="0"
                value={editConfig.avgHumanHandleTime}
                onChange={(e) =>
                  setEditConfig((prev) =>
                    prev ? { ...prev, avgHumanHandleTime: Number(e.target.value) || 0 } : prev,
                  )
                }
              />
              <Input
                label="Estimated AI Cost per Conversation ($)"
                type="number"
                step="0.01"
                min="0"
                value={editConfig.estimatedAiCostPerConversation}
                onChange={(e) =>
                  setEditConfig((prev) =>
                    prev
                      ? { ...prev, estimatedAiCostPerConversation: Number(e.target.value) || 0 }
                      : prev,
                  )
                }
              />
              <p className="text-xs text-muted -mt-2">
                Fallback value used when actual LLM cost tracking data is unavailable
              </p>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="secondary" size="sm" onClick={() => setSettingsOpen(false)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    if (editConfig) updateRoiConfig(editConfig);
                    setSettingsOpen(false);
                  }}
                >
                  Save
                </Button>
              </div>
            </div>
          </Dialog>
        )}
      </div>
    </div>
  );
}
