/**
 * Customer Insights Page
 *
 * Intent-centric analytics dashboard showing what customers are asking about
 * and their sentiment patterns. Uses data from intent_classification and
 * sentiment_analysis pipelines.
 *
 * Layout: Dashboard grid
 *   Row 1: 4 KPI cards
 *   Row 2: Intent donut chart (left) + Sentiment trajectory (right)
 *   Row 3: Trends over time (full width)
 *   Row 4: Top intents table (full width)
 */

'use client';

import { useState } from 'react';
import { clsx } from 'clsx';
import { ChevronDown, ChevronUp, Info } from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { PageHeader } from '../ui/PageHeader';
import { Skeleton } from '../ui/Skeleton';
import { InsightsDateRangeControl } from './shared/InsightsDateRangeControl';
import { Tooltip, TooltipProvider } from '../ui/Tooltip';
import { InsightKPICard } from './shared/InsightKPICard';
import { EmptyState } from '../ui/EmptyState';
import {
  useCustomerInsights,
  type IntentDistributionItem,
  type SentimentTrajectory,
  type DailyTrendPoint,
  type TopIntentRow,
} from '../../hooks/useCustomerInsights';
import { SEMANTIC_CHART_COLORS, CHART_COLOR_PALETTE } from '@agent-platform/design-tokens';
import { usePersistedSurfaceFilters } from '../../hooks/usePersistedSurfaceFilters';

// ── Types ───────────────────────────────────────────────────────────────────

type DateRange = '7d' | '30d' | '90d';
type IntentSortKey =
  | 'intent'
  | 'volume'
  | 'confidence'
  | 'evaluatedCount'
  | 'resolutionRate'
  | 'partialRate';

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

// ── Helpers ─────────────────────────────────────────────────────────────────

export function kpiStatus(
  value: number,
  goodThreshold: number,
  warnThreshold: number,
  inverse = false,
) {
  if (inverse) {
    if (value <= goodThreshold) return 'healthy' as const;
    if (value <= warnThreshold) return 'warning' as const;
    return 'critical' as const;
  }
  if (value >= goodThreshold) return 'healthy' as const;
  if (value >= warnThreshold) return 'warning' as const;
  return 'critical' as const;
}

export function formatPercent(count: number, total: number): string {
  if (total === 0) return '0%';
  return `${((count / total) * 100).toFixed(1)}%`;
}

/** Format snake_case intent labels to Title Case (e.g. "billing_inquiry" → "Billing Inquiry"). */
function formatIntentLabel(intent: string): string {
  return intent.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Insights Summary Banner ────────────────────────────────────────────────

const SENTIMENT_BANNERS: Record<string, string> = {
  healthy: 'from-success/10 to-success/5',
  warning: 'from-warning/10 to-warning/5',
  critical: 'from-error/10 to-error/5',
};

function InsightsSummaryBanner({
  totalConversations,
  intentConversationCount,
  sentimentConversationCount,
  uniqueIntents,
  avgSentiment,
  frustrationRate,
}: {
  totalConversations: number;
  intentConversationCount: number;
  sentimentConversationCount: number;
  uniqueIntents: number;
  avgSentiment: number;
  frustrationRate: number;
}) {
  const sentimentStatus = kpiStatus(avgSentiment, 0.3, 0);
  const frustrationStatus = kpiStatus(frustrationRate, 10, 25, true);
  const overallStatus =
    sentimentStatus === 'critical' || frustrationStatus === 'critical'
      ? 'critical'
      : sentimentStatus === 'warning' || frustrationStatus === 'warning'
        ? 'warning'
        : 'healthy';
  const gradient = SENTIMENT_BANNERS[overallStatus];

  const statusLabels: Record<string, string> = {
    healthy: 'Positive',
    warning: 'Mixed',
    critical: 'Negative',
  };
  const statusColors: Record<string, string> = {
    healthy: 'text-success',
    warning: 'text-warning',
    critical: 'text-error',
  };
  const dotColors: Record<string, string> = {
    healthy: 'bg-success',
    warning: 'bg-warning',
    critical: 'bg-error',
  };

  return (
    <div className={clsx('rounded-xl p-4 bg-gradient-to-br border border-default', gradient)}>
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Customer Sentiment</h3>
          <p className="text-xs text-muted mt-0.5">
            {totalConversations.toLocaleString()} analyzed conversations &middot;{' '}
            {intentConversationCount.toLocaleString()} intent-classified &middot;{' '}
            {sentimentConversationCount.toLocaleString()} sentiment-scored &middot; {uniqueIntents}{' '}
            intents detected
            {frustrationRate > 0 && (
              <span className={frustrationRate > 15 ? 'text-error' : 'text-warning'}>
                {' '}
                &middot; {frustrationRate.toFixed(1)}% frustration
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-1.5 text-xs font-medium">
          <span className={clsx('w-2 h-2 rounded-full', dotColors[sentimentStatus])} />
          <span className={statusColors[sentimentStatus]}>
            {statusLabels[sentimentStatus]} Sentiment
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Horizontal Bar Row (shared pattern for both cards) ─────────────────────

function HorizontalBarRow({
  label,
  count,
  pct,
  maxPct,
  color,
  extra,
}: {
  label: string;
  count: number;
  pct: number;
  maxPct: number;
  color: string;
  extra?: React.ReactNode;
}) {
  const barWidth = maxPct > 0 ? (pct / maxPct) * 100 : 0;
  return (
    <div className="group flex items-center gap-3 py-1.5">
      <span className="text-xs font-medium text-muted w-[140px] shrink-0 truncate">{label}</span>
      <div className="flex-1 h-6 rounded bg-background-muted/50 overflow-hidden">
        <div
          className="h-full rounded transition-all duration-500 ease-out"
          style={{ width: `${Math.max(barWidth, 2)}%`, backgroundColor: color }}
        />
      </div>
      <span className="text-xs font-semibold text-foreground tabular-nums w-8 shrink-0 text-right">
        {count}
      </span>
      <span className="text-xs text-subtle tabular-nums w-10 text-right shrink-0">
        {pct.toFixed(0)}%
      </span>
      {extra}
    </div>
  );
}

// ── Intent Distribution ────────────────────────────────────────────────────

const MAX_VISIBLE_INTENTS = 7;

function IntentDistributionBar({ data }: { data: IntentDistributionItem[] }) {
  if (data.length === 0) {
    return <InsightsEmptyState title="No intent data available yet." />;
  }

  const sorted = [...data].sort((a, b) => b.count - a.count);
  const top = sorted.slice(0, MAX_VISIBLE_INTENTS);
  const restCount = sorted.slice(MAX_VISIBLE_INTENTS).reduce((sum, item) => sum + item.count, 0);
  const chartData: Array<{ intent: string; count: number; confidence: number }> =
    restCount > 0 ? [...top, { intent: 'Other', count: restCount, confidence: 0 }] : [...top];

  const total = chartData.reduce((sum, item) => sum + item.count, 0);
  const maxPct = Math.max(...chartData.map((item) => (total > 0 ? (item.count / total) * 100 : 0)));

  return (
    <div className="space-y-1">
      {chartData.map((item, i) => {
        const pct = total > 0 ? (item.count / total) * 100 : 0;
        return (
          <HorizontalBarRow
            key={item.intent}
            label={formatIntentLabel(item.intent)}
            count={item.count}
            pct={pct}
            maxPct={maxPct}
            color={
              item.intent === 'Other'
                ? SEMANTIC_CHART_COLORS.muted
                : CHART_COLOR_PALETTE[i % CHART_COLOR_PALETTE.length]
            }
          />
        );
      })}
      <p className="text-xs text-subtle pt-2">
        {total} classified intent assignment{total !== 1 ? 's' : ''} across {sorted.length} intent
        {sorted.length !== 1 ? 's' : ''}
        {sorted.length > MAX_VISIBLE_INTENTS &&
          ` · ${sorted.length - MAX_VISIBLE_INTENTS} low-volume intents (${restCount}) grouped as Other`}
      </p>
    </div>
  );
}

// ── Sentiment Trajectory ───────────────────────────────────────────────────

function SentimentTrajectoryCard({ trajectory }: { trajectory: SentimentTrajectory }) {
  const { improving, stable, declining, total } = trajectory;

  if (total === 0) {
    return <InsightsEmptyState title="No sentiment trajectory data yet." />;
  }

  const segments = [
    { label: 'Improving', count: improving, color: SEMANTIC_CHART_COLORS.success },
    { label: 'Stable', count: stable, color: SEMANTIC_CHART_COLORS.muted },
    { label: 'Declining', count: declining, color: SEMANTIC_CHART_COLORS.warning },
  ];

  const maxPct = Math.max(...segments.map((s) => (total > 0 ? (s.count / total) * 100 : 0)));

  return (
    <div className="space-y-1">
      {segments.map((seg) => {
        const pct = total > 0 ? (seg.count / total) * 100 : 0;
        return (
          <HorizontalBarRow
            key={seg.label}
            label={seg.label}
            count={seg.count}
            pct={pct}
            maxPct={maxPct}
            color={seg.color}
          />
        );
      })}
      <p className="text-xs text-subtle pt-2">
        Based on {total} conversation{total !== 1 ? 's' : ''} with sentiment data
      </p>
    </div>
  );
}

// ── Top Intents Table ───────────────────────────────────────────────────────

function TopIntentsTable({ data }: { data: TopIntentRow[] }) {
  const [sortKey, setSortKey] = useState<IntentSortKey>('volume');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  if (data.length === 0) {
    return <InsightsEmptyState title="No intent classification data yet." />;
  }

  const handleSort = (key: IntentSortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const sorted = [...data].sort((a, b) => {
    const aVal = a[sortKey];
    const bVal = b[sortKey];
    if (typeof aVal === 'string' && typeof bVal === 'string') {
      return sortDir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    }
    // Treat null (resolutionRate not yet evaluated) as -1 so unevaluated rows
    // sort to the bottom on desc and to the top on asc.
    const aNum = aVal == null ? -1 : (aVal as number);
    const bNum = bVal == null ? -1 : (bVal as number);
    return sortDir === 'asc' ? aNum - bNum : bNum - aNum;
  });

  const SortIcon = sortDir === 'asc' ? ChevronUp : ChevronDown;

  const columns: { key: IntentSortKey; label: string; align: string; tooltip?: string }[] = [
    { key: 'intent', label: 'Intent', align: 'text-left' },
    {
      key: 'volume',
      label: 'Total Sessions',
      align: 'text-center',
      tooltip: 'Total conversations classified with this intent in the selected period',
    },
    {
      key: 'confidence',
      label: 'Confidence',
      align: 'text-center',
      tooltip:
        'Average classification confidence (0-100%). How certain the AI is about this intent detection',
    },
    {
      key: 'evaluatedCount',
      label: 'Evaluated',
      align: 'text-center',
      tooltip: 'Conversations evaluated for resolution status in the selected period.',
    },
    {
      key: 'resolutionRate',
      label: 'Resolution Rate',
      align: 'text-center',
      tooltip: 'Percentage of evaluated conversations where this intent was fully resolved.',
    },
    {
      key: 'partialRate',
      label: 'Partial Rate',
      align: 'text-center',
      tooltip:
        'Percentage of evaluated conversations where this intent was acknowledged with partial action (e.g., escalation, callback promised, processing time given) but not fully resolved.',
    },
  ];

  return (
    <TooltipProvider>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="text-xs text-muted border-b border-default">
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={clsx(
                    'px-4 py-3 font-medium cursor-pointer hover:text-foreground transition-default select-none',
                    col.align,
                  )}
                  onClick={() => handleSort(col.key)}
                >
                  <span className="inline-flex items-center gap-1">
                    {col.label}
                    {col.tooltip && (
                      <Tooltip content={col.tooltip} side="top">
                        <button
                          type="button"
                          className="text-subtle hover:text-muted transition-default"
                          aria-label={`About ${col.label}`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Info className="w-3 h-3" />
                        </button>
                      </Tooltip>
                    )}
                    {sortKey === col.key && <SortIcon className="w-3 h-3" />}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => {
              const resolutionPct = row.resolutionRate != null ? row.resolutionRate * 100 : null;
              const partialPct = row.partialRate != null ? row.partialRate * 100 : null;
              const resolutionColor =
                resolutionPct == null
                  ? 'text-subtle'
                  : resolutionPct >= 70
                    ? 'text-success'
                    : resolutionPct >= 50
                      ? 'text-warning'
                      : 'text-error';

              const confidencePct = row.confidence > 0 ? row.confidence * 100 : null;

              return (
                <tr key={row.intent} className="border-b border-muted transition-default">
                  <td className="px-4 py-3 text-sm font-medium text-foreground">
                    {formatIntentLabel(row.intent)}
                  </td>
                  <td className="px-4 py-3 text-sm text-center text-muted tabular-nums">
                    {row.volume.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-sm text-center text-muted tabular-nums">
                    {confidencePct == null ? '—' : `${confidencePct.toFixed(1)}%`}
                  </td>
                  <td className="px-4 py-3 text-sm text-center text-muted tabular-nums">
                    {row.evaluatedCount > 0 ? row.evaluatedCount.toLocaleString() : '—'}
                  </td>
                  <td
                    className={clsx(
                      'px-4 py-3 text-sm text-center font-medium tabular-nums',
                      resolutionColor,
                    )}
                  >
                    {resolutionPct == null ? '—' : `${resolutionPct.toFixed(0)}%`}
                  </td>
                  <td className="px-4 py-3 text-sm text-center text-muted tabular-nums">
                    {partialPct == null ? '—' : `${partialPct.toFixed(0)}%`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </TooltipProvider>
  );
}

// ── Trends Section ──────────────────────────────────────────────────────────

function TrendsSection({ dailyTrend }: { dailyTrend: DailyTrendPoint[] }) {
  if (dailyTrend.length === 0) {
    return <InsightsEmptyState title="No trend data available yet." />;
  }

  const trendData = dailyTrend.map((point) => ({
    ...point,
    sentimentIndex: ((point.avgSentiment + 1) / 2) * 100,
    confidenceRate: point.avgConfidence * 100,
  }));

  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={trendData} margin={{ top: 5, right: 16, bottom: 5, left: 0 }}>
        <defs>
          <linearGradient id="customer-insights-conversations" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={SEMANTIC_CHART_COLORS.muted} stopOpacity={0.28} />
            <stop offset="95%" stopColor={SEMANTIC_CHART_COLORS.muted} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis dataKey="day" tick={{ fontSize: 11, fill: 'hsl(var(--foreground-muted))' }} />
        <YAxis
          yAxisId="volume"
          tick={{ fontSize: 11, fill: 'hsl(var(--foreground-muted))' }}
          allowDecimals={false}
        />
        <YAxis
          yAxisId="rate"
          orientation="right"
          domain={[0, 100]}
          tick={{ fontSize: 11, fill: 'hsl(var(--foreground-muted))' }}
          tickFormatter={(value) => `${value}%`}
        />
        <RechartsTooltip
          contentStyle={{
            background: 'hsl(var(--background-elevated))',
            border: '1px solid hsl(var(--border))',
            borderRadius: '8px',
            fontSize: '12px',
          }}
          formatter={(value, name) => {
            if (typeof value !== 'number') return [value, name];
            if (name === 'Intent Classified' || name === 'Sentiment Scored') {
              return [value.toLocaleString(), name];
            }
            return [`${value.toFixed(1)}%`, name];
          }}
        />
        <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '8px' }} />
        <Area
          yAxisId="volume"
          type="monotone"
          dataKey="intentConversations"
          name="Intent Classified"
          stroke={SEMANTIC_CHART_COLORS.muted}
          fill="url(#customer-insights-conversations)"
          strokeWidth={2}
        />
        <Area
          yAxisId="volume"
          type="monotone"
          dataKey="sentimentConversations"
          name="Sentiment Scored"
          stroke={SEMANTIC_CHART_COLORS.success}
          fillOpacity={0}
          strokeWidth={2}
        />
        <Line
          yAxisId="rate"
          type="monotone"
          dataKey="sentimentIndex"
          name="Sentiment Index"
          stroke={SEMANTIC_CHART_COLORS.warning}
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4, strokeWidth: 0 }}
        />
        <Line
          yAxisId="rate"
          type="monotone"
          dataKey="confidenceRate"
          name="Confidence"
          stroke={SEMANTIC_CHART_COLORS.purple}
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4, strokeWidth: 0 }}
        />
        <Line
          yAxisId="rate"
          type="monotone"
          dataKey="resolutionRate"
          name="Resolution Rate"
          stroke={SEMANTIC_CHART_COLORS.info}
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4, strokeWidth: 0 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ── Main Page ───────────────────────────────────────────────────────────────

export function CustomerInsightsPage() {
  const { state: customerInsightsFilters, updateState } =
    usePersistedSurfaceFilters('customerInsights');
  const dateRange = customerInsightsFilters.dateRange as DateRange;

  const {
    totalConversations,
    intentConversationCount,
    sentimentConversationCount,
    uniqueIntents,
    avgSentiment,
    frustrationRate,
    resolutionRate,
    evaluatedCount,
    intentDistribution,
    sentimentTrajectory,
    dailyTrend,
    topIntents,
    isLoading,
    error,
    projectId,
  } = useCustomerInsights(dateRange);

  if (!projectId) {
    return (
      <div className="flex items-center justify-center h-64 text-muted">
        Select a project to view customer insights
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

  return (
    <div className="h-full overflow-y-auto bg-noise">
      <div className="max-w-7xl mx-auto px-6 py-8 space-y-6">
        {/* Header */}
        <PageHeader
          title="Customer Insights"
          description="Understand what customers are asking about and how they feel"
          actions={<div className="flex items-center gap-2">{dateRangeControl}</div>}
        />

        {/* Error state */}
        {error && (
          <div className="rounded-lg border border-error/30 bg-error-subtle p-4 text-sm text-error">
            Failed to load some analytics data. Showing available metrics.
          </div>
        )}

        {/* Summary Banner */}
        {!isLoading && totalConversations > 0 && (
          <InsightsSummaryBanner
            totalConversations={totalConversations}
            intentConversationCount={intentConversationCount}
            sentimentConversationCount={sentimentConversationCount}
            uniqueIntents={uniqueIntents}
            avgSentiment={avgSentiment}
            frustrationRate={frustrationRate}
          />
        )}

        {/* Row 1: KPI Cards */}
        {isLoading ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </div>
        ) : (
          <TooltipProvider>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
              <InsightKPICard
                title="Analyzed Conversations"
                value={totalConversations.toLocaleString()}
                subtitle={`${intentConversationCount.toLocaleString()} intent · ${sentimentConversationCount.toLocaleString()} sentiment`}
                tooltip="Highest analyzed conversation count across the intent and sentiment pipelines in the selected period"
                status={totalConversations > 0 ? 'healthy' : 'warning'}
              />
              <InsightKPICard
                title="Unique Intents"
                value={uniqueIntents.toString()}
                tooltip="Number of distinct customer intents detected by the classification pipeline"
                status={uniqueIntents > 0 ? 'healthy' : 'warning'}
              />
              <InsightKPICard
                title="Avg Sentiment"
                value={sentimentConversationCount > 0 ? avgSentiment.toFixed(2) : '\u2014'}
                tooltip="Average customer sentiment score (-1 to +1). Positive values indicate satisfied customers"
                status={kpiStatus(avgSentiment, 0.3, 0)}
              />
              <InsightKPICard
                title="Frustration Rate"
                value={sentimentConversationCount > 0 ? `${frustrationRate.toFixed(1)}%` : '\u2014'}
                tooltip="Percentage of conversations where customer frustration was detected (raised voice, repeated questions, negative language)"
                status={kpiStatus(frustrationRate, 10, 25, true)}
              />
              <InsightKPICard
                title="Resolution Rate"
                value={resolutionRate != null ? `${resolutionRate.toFixed(1)}%` : '\u2014'}
                subtitle={
                  evaluatedCount > 0
                    ? `${evaluatedCount.toLocaleString()} conversations evaluated`
                    : undefined
                }
                tooltip="Percentage of conversations where the primary intent was fully resolved."
                status={resolutionRate != null ? kpiStatus(resolutionRate, 70, 50) : 'warning'}
              />
            </div>
          </TooltipProvider>
        )}

        {/* Row 2: Donut + Trajectory */}
        {isLoading ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Skeleton className="h-72 rounded-xl" />
            <Skeleton className="h-72 rounded-xl" />
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Intent Distribution Donut */}
            <div className="bg-background-elevated rounded-xl border border-default p-6">
              <h3 className="text-sm font-semibold text-foreground mb-4">Intent Distribution</h3>
              <IntentDistributionBar data={intentDistribution} />
            </div>

            {/* Sentiment Trajectory */}
            <div className="bg-background-elevated rounded-xl border border-default p-6">
              <h3 className="text-sm font-semibold text-foreground mb-4">Sentiment Trajectory</h3>
              <SentimentTrajectoryCard trajectory={sentimentTrajectory} />
            </div>
          </div>
        )}

        {/* Row 3: Trends Over Time */}
        <div className="bg-background-elevated rounded-xl border border-default p-6">
          <h3 className="text-sm font-semibold text-foreground mb-4">Trends Over Time</h3>
          {isLoading ? (
            <Skeleton className="h-72 rounded-lg" />
          ) : (
            <>
              <TrendsSection dailyTrend={dailyTrend} />
              {evaluatedCount > 0 && evaluatedCount < intentConversationCount && (
                <p className="text-xs text-subtle pt-3 mt-3 border-t border-muted">
                  Resolution rate based on {evaluatedCount.toLocaleString()} of{' '}
                  {intentConversationCount.toLocaleString()} intent-classified conversations
                  evaluated.
                </p>
              )}
            </>
          )}
        </div>

        {/* Row 4: Top Intents Table */}
        <div className="bg-background-elevated rounded-xl border border-default overflow-hidden">
          <div className="px-6 py-4 border-b border-default">
            <h3 className="text-sm font-semibold text-foreground">Intent Performance</h3>
            <p className="text-xs text-muted mt-0.5">
              Classification confidence and resolution outcomes per intent for the selected period
            </p>
          </div>
          {isLoading ? (
            <div className="p-6">
              <Skeleton className="h-48 rounded-lg" />
            </div>
          ) : (
            <TopIntentsTable data={topIntents} />
          )}
        </div>
      </div>
    </div>
  );
}
