/**
 * LLMPerformanceTab Component
 *
 * LLM performance metrics: latency trends, cost breakdown, model comparison table.
 */

import { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Zap } from 'lucide-react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
} from 'recharts';
import { useCostBreakdown, useAggregateMetrics, type TimeRange } from '../../hooks/useAnalytics';
import { Alert } from '../ui/Alert';
import {
  KPICard,
  ChartCard,
  AnalyticsSkeleton,
  ChartTooltip,
  CHART_COLORS,
  formatNumber,
  formatCost,
  formatDuration,
  formatTokens,
  fillTimeGaps,
  PIE_CHART_COLORS,
} from './shared';
import { EmptyState } from '../ui/EmptyState';

// =============================================================================
// TYPES
// =============================================================================

interface LLMPerformanceTabProps {
  projectId: string | null;
  timeRange: TimeRange;
}

interface LatencyDataPoint {
  time: string;
  avg_duration: number;
  p95_duration: number;
  count: number;
  sum_tokens: number;
  sum_cost: number;
}

// Sort state for the model table
type SortKey = 'model' | 'callCount' | 'totalTokens' | 'totalCost';
type SortDir = 'asc' | 'desc';

// =============================================================================
// MODEL COLORS
// =============================================================================

const MODEL_COLORS: Record<string, string> = {
  openai: CHART_COLORS[0],
  anthropic: CHART_COLORS[1],
  google: CHART_COLORS[2],
  litellm: CHART_COLORS[3],
};

function getProviderColor(provider: string): string {
  return MODEL_COLORS[provider.toLowerCase()] || CHART_COLORS[4];
}

// =============================================================================
// COMPONENT
// =============================================================================

const formatTimeTick = (val: string, granularity: 'hour' | 'day') => {
  const d = new Date(val);
  if (isNaN(d.getTime())) return String(val);
  if (granularity === 'day') {
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

export function LLMPerformanceTab({ projectId, timeRange }: LLMPerformanceTabProps) {
  const t = useTranslations('analytics');

  const {
    breakdown,
    isLoading: costLoading,
    error: costError,
  } = useCostBreakdown(projectId, timeRange);

  // Aggregate: latency trend over time
  const fromMs = new Date(timeRange.from).getTime();
  const toMs = new Date(timeRange.to).getTime();
  const hoursDiff = (toMs - fromMs) / (1000 * 60 * 60);
  const latencyGroupBy = hoursDiff <= 48 ? 'hour' : 'day';

  const {
    buckets: latencyBuckets,
    isLoading: latencyLoading,
    error: latencyError,
  } = useAggregateMetrics(projectId, timeRange, {
    groupBy: [latencyGroupBy],
    metrics: ['count', 'avg_duration', 'p95_duration', 'sum_tokens', 'sum_cost'],
    category: 'llm',
  });

  const latencyData = useMemo(() => {
    const raw: LatencyDataPoint[] = latencyBuckets.map((b) => ({
      time: String(b[latencyGroupBy] || ''),
      avg_duration: Number(b.avg_duration || 0),
      p95_duration: Number(b.p95_duration || 0),
      count: Number(b.count || 0),
      sum_tokens: Number(b.sum_tokens || 0),
      sum_cost: Number(b.sum_cost || 0),
    }));
    return fillTimeGaps(raw, 'time', timeRange.from, timeRange.to, latencyGroupBy, {
      avg_duration: 0,
      p95_duration: 0,
      count: 0,
      sum_tokens: 0,
      sum_cost: 0,
    });
  }, [latencyBuckets, timeRange.from, timeRange.to, latencyGroupBy]);

  // Sort state for model table
  const [sortKey, setSortKey] = useState<SortKey>('totalCost');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const sortedBreakdown = useMemo(() => {
    const sorted = [...breakdown];
    sorted.sort((a, b) => {
      const aVal = a[sortKey];
      const bVal = b[sortKey];
      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortDir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }
      return sortDir === 'asc'
        ? (aVal as number) - (bVal as number)
        : (bVal as number) - (aVal as number);
    });
    return sorted;
  }, [breakdown, sortKey, sortDir]);

  // KPI totals
  const kpis = useMemo(() => {
    const totalCalls = breakdown.reduce((s, b) => s + b.callCount, 0);
    const totalTokens = breakdown.reduce((s, b) => s + b.totalTokens, 0);
    const totalCost = breakdown.reduce((s, b) => s + b.totalCost, 0);

    // Compute avg/p95 from latencyData
    const allDurations = latencyData.filter((d) => d.count > 0);
    const weightedAvg =
      allDurations.length > 0
        ? allDurations.reduce((s, d) => s + d.avg_duration * d.count, 0) /
          allDurations.reduce((s, d) => s + d.count, 0)
        : 0;
    const maxP95 =
      allDurations.length > 0 ? Math.max(...allDurations.map((d) => d.p95_duration)) : 0;

    return { totalCalls, avgLatency: weightedAvg, p95Latency: maxP95, totalTokens, totalCost };
  }, [breakdown, latencyData]);

  // Pie chart data — use tokens (always available) with cost overlay when present.
  // Color by model index so models from the same provider get distinct colors.
  const modelPieData = useMemo(() => {
    const hasCost = breakdown.some((b) => b.totalCost > 0);
    return breakdown
      .filter((b) => (hasCost ? b.totalCost > 0 : b.totalTokens > 0))
      .sort((a, b) => (hasCost ? b.totalCost - a.totalCost : b.totalTokens - a.totalTokens))
      .map((b, i) => ({
        name: b.model,
        value: hasCost ? b.totalCost : b.totalTokens,
        color: PIE_CHART_COLORS[i % PIE_CHART_COLORS.length],
      }));
  }, [breakdown]);
  const pieShowsCost = breakdown.some((b) => b.totalCost > 0);

  const isLoading = costLoading || latencyLoading;
  if (isLoading) return <AnalyticsSkeleton />;

  const loadErrors = [costError, latencyError].filter(Boolean);
  const hasData = breakdown.length > 0 || latencyData.some((point) => point.count > 0);
  if (!hasData) {
    return (
      <div className="space-y-4">
        {loadErrors.length > 0 && (
          <Alert variant="warning" title={t('errors.partial_title')}>
            {loadErrors[0]}
          </Alert>
        )}
        <EmptyState
          icon={<Zap className="w-8 h-8" />}
          title={t('empty.title')}
          description={t('empty.description')}
        />
      </div>
    );
  }

  const sortArrow = (key: SortKey) => {
    if (sortKey !== key) return '';
    return sortDir === 'asc' ? ' ↑' : ' ↓';
  };

  return (
    <div className="space-y-6">
      {loadErrors.length > 0 && (
        <Alert variant="warning" title={t('errors.partial_title')}>
          {loadErrors[0]}
        </Alert>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        <KPICard title={t('kpi.llm_calls')} value={formatNumber(kpis.totalCalls)} />
        <KPICard title={t('kpi.avg_latency')} value={formatDuration(kpis.avgLatency)} />
        <KPICard title={t('kpi.p95_latency')} value={formatDuration(kpis.p95Latency)} />
        <KPICard title={t('kpi.tokens')} value={formatTokens(kpis.totalTokens)} />
        <KPICard title={t('kpi.cost')} value={formatCost(kpis.totalCost)} />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Latency Trend */}
        <ChartCard title={t('charts.latency_trend')}>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={latencyData}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border-muted))" />
              <XAxis
                dataKey="time"
                tick={{ fontSize: 11, fill: 'hsl(var(--foreground-subtle))' }}
                tickFormatter={(val) => formatTimeTick(val, latencyGroupBy)}
              />
              <YAxis
                tick={{ fontSize: 11, fill: 'hsl(var(--foreground-subtle))' }}
                tickFormatter={(v) => `${v}ms`}
              />
              <RechartsTooltip content={<ChartTooltip formatter={formatDuration} />} />
              <Line
                type="monotone"
                dataKey="avg_duration"
                name="Avg Latency"
                stroke={CHART_COLORS[0]}
                strokeWidth={2}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="p95_duration"
                name="P95 Latency"
                stroke={CHART_COLORS[2]}
                strokeWidth={2}
                strokeDasharray="4 4"
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Usage by Model — shows cost when available, otherwise tokens */}
        <ChartCard title={pieShowsCost ? t('charts.cost_by_model') : t('charts.tokens_by_model')}>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie
                data={modelPieData}
                cx="50%"
                cy="50%"
                innerRadius={55}
                outerRadius={90}
                dataKey="value"
                nameKey="name"
                paddingAngle={2}
              >
                {modelPieData.map((entry, i) => (
                  <Cell key={i} fill={entry.color} />
                ))}
              </Pie>
              <RechartsTooltip
                content={<ChartTooltip formatter={pieShowsCost ? formatCost : formatTokens} />}
              />
            </PieChart>
          </ResponsiveContainer>
          {modelPieData.length > 0 && (
            <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 mt-2">
              {modelPieData.map((entry, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <span
                    className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                    style={{ backgroundColor: entry.color }}
                  />
                  <span className="text-xs text-muted truncate max-w-[140px]" title={entry.name}>
                    {entry.name}
                  </span>
                </div>
              ))}
            </div>
          )}
        </ChartCard>
      </div>

      {/* Model Performance Table */}
      {sortedBreakdown.length > 0 && (
        <div className="bg-background-elevated border border-default rounded-xl p-4 shadow-sm">
          <h3 className="text-sm font-medium text-foreground mb-4">
            {t('charts.model_performance')}
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-default">
                  <th
                    className="text-left py-2 px-3 text-xs text-muted font-medium cursor-pointer hover:text-foreground"
                    onClick={() => handleSort('model')}
                  >
                    {t('table.model')}
                    {sortArrow('model')}
                  </th>
                  <th className="text-left py-2 px-3 text-xs text-muted font-medium">
                    {t('table.provider')}
                  </th>
                  <th
                    className="text-right py-2 px-3 text-xs text-muted font-medium cursor-pointer hover:text-foreground"
                    onClick={() => handleSort('callCount')}
                  >
                    {t('table.calls')}
                    {sortArrow('callCount')}
                  </th>
                  <th
                    className="text-right py-2 px-3 text-xs text-muted font-medium cursor-pointer hover:text-foreground"
                    onClick={() => handleSort('totalTokens')}
                  >
                    {t('table.tokens')}
                    {sortArrow('totalTokens')}
                  </th>
                  <th
                    className="text-right py-2 px-3 text-xs text-muted font-medium cursor-pointer hover:text-foreground"
                    onClick={() => handleSort('totalCost')}
                  >
                    {t('table.cost')}
                    {sortArrow('totalCost')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedBreakdown.map((row, i) => (
                  <tr key={i} className="border-b border-default last:border-0">
                    <td className="py-2 px-3 text-foreground font-medium">{row.model}</td>
                    <td className="py-2 px-3">
                      <span
                        className="px-1.5 py-0.5 text-xs rounded"
                        style={{
                          backgroundColor: `${getProviderColor(row.provider)}20`,
                          color: getProviderColor(row.provider),
                        }}
                      >
                        {row.provider}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-right text-muted">
                      {formatNumber(row.callCount)}
                    </td>
                    <td className="py-2 px-3 text-right text-muted">
                      {formatTokens(row.totalTokens)}
                    </td>
                    <td className="py-2 px-3 text-right text-foreground font-medium">
                      {formatCost(row.totalCost)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
