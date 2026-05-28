/**
 * OverviewTab Component
 *
 * Analytics overview: KPI cards, event volume chart, category breakdown, recent errors.
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Activity, AlertTriangle, BarChart3, PieChart as PieChartIcon } from 'lucide-react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
} from 'recharts';
import {
  useEventCounts,
  useSessionMetrics,
  useCostBreakdown,
  useAnalyticsEvents,
  useAggregateMetrics,
  type TimeRange,
} from '../../hooks/useAnalytics';
import {
  KPICard,
  ChartCard,
  AnalyticsSkeleton,
  ChartTooltip,
  CHART_COLORS,
  CATEGORY_COLORS,
  GRADIENT_DEFS,
  formatNumber,
  formatCost,
  formatTokens,
  formatTimestamp,
  fillTimeGaps,
} from './shared';
import { EmptyState } from '../ui/EmptyState';
import { Alert } from '../ui/Alert';

// =============================================================================
// TYPES
// =============================================================================

interface OverviewTabProps {
  projectId: string | null;
  timeRange: TimeRange;
}

interface VolumeDataPoint {
  time: string;
  count: number;
}

function OverviewCardEmptyState({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="flex min-h-[240px] items-center justify-center">
      <EmptyState icon={icon} title={title} description={description} className="px-4 py-10" />
    </div>
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

const formatTimeTick = (val: string) => {
  const d = new Date(val);
  if (isNaN(d.getTime())) return String(val);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

export function OverviewTab({ projectId, timeRange }: OverviewTabProps) {
  const t = useTranslations('analytics');

  const {
    counts,
    isLoading: countsLoading,
    error: countsError,
  } = useEventCounts(projectId, timeRange);
  const {
    metrics: sessionMetrics,
    isLoading: sessionsLoading,
    error: sessionsError,
  } = useSessionMetrics(projectId, timeRange);
  const {
    breakdown,
    isLoading: costLoading,
    error: costError,
  } = useCostBreakdown(projectId, timeRange);
  const {
    events: recentErrors,
    isLoading: errorsLoading,
    error: recentErrorsError,
  } = useAnalyticsEvents(projectId, timeRange, { hasError: true, limit: 10 });

  // Aggregate: event volume over time
  const fromMs = new Date(timeRange.from).getTime();
  const toMs = new Date(timeRange.to).getTime();
  const hoursDiff = (toMs - fromMs) / (1000 * 60 * 60);
  const volumeGroupBy = hoursDiff <= 48 ? 'hour' : 'day';

  const {
    buckets: volumeBuckets,
    isLoading: volumeLoading,
    error: volumeError,
  } = useAggregateMetrics(projectId, timeRange, {
    groupBy: [volumeGroupBy],
    metrics: ['count'],
  });

  const volumeData = useMemo(() => {
    const raw: VolumeDataPoint[] = volumeBuckets.map((b) => ({
      time: String(b[volumeGroupBy] || ''),
      count: Number(b.count || 0),
    }));
    return fillTimeGaps(raw, 'time', timeRange.from, timeRange.to, volumeGroupBy, { count: 0 });
  }, [volumeBuckets, timeRange.from, timeRange.to, volumeGroupBy]);

  // Derived KPI values
  const kpis = useMemo(() => {
    const findCount = (key: string) => counts.find((c) => c.key === key)?.count ?? 0;
    const totalErrors = counts.reduce((sum, c) => sum + c.errorCount, 0);
    const totalTokens = breakdown.reduce((sum, b) => sum + b.totalTokens, 0);
    const totalCost = breakdown.reduce((sum, b) => sum + b.totalCost, 0);

    return {
      sessions: sessionMetrics?.totalSessions ?? findCount('session'),
      messages: findCount('message'),
      llmCalls: findCount('llm'),
      errors: totalErrors,
      tokens: totalTokens,
      cost: totalCost,
    };
  }, [counts, sessionMetrics, breakdown]);

  // Pie chart data from event counts
  const categoryPieData = useMemo(() => {
    return counts
      .filter((c) => c.count > 0)
      .map((c) => ({
        name: c.key,
        value: c.count,
        color: CATEGORY_COLORS[c.key] || CATEGORY_COLORS.other,
      }))
      .sort((a, b) => b.value - a.value);
  }, [counts]);
  const totalCategoryEvents = useMemo(
    () => categoryPieData.reduce((sum, entry) => sum + entry.value, 0),
    [categoryPieData],
  );
  const hasVolumeData = volumeData.some((point) => point.count > 0);
  const hasCategoryData = categoryPieData.length > 0;

  const isLoading = countsLoading || sessionsLoading || costLoading;

  if (isLoading) return <AnalyticsSkeleton />;

  const loadErrors = [countsError, sessionsError, costError, recentErrorsError, volumeError].filter(
    Boolean,
  );
  const hasData = counts.length > 0 || (sessionMetrics && sessionMetrics.totalSessions > 0);
  if (!hasData) {
    return (
      <div className="space-y-4">
        {loadErrors.length > 0 && (
          <Alert variant="warning" title={t('errors.partial_title')}>
            {loadErrors[0]}
          </Alert>
        )}
        <EmptyState
          icon={<Activity className="w-8 h-8" />}
          title={t('empty.title')}
          description={t('empty.description')}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {loadErrors.length > 0 && (
        <Alert variant="warning" title={t('errors.partial_title')}>
          {loadErrors[0]}
        </Alert>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        <KPICard title={t('kpi.sessions')} value={formatNumber(kpis.sessions)} />
        <KPICard title={t('kpi.messages')} value={formatNumber(kpis.messages)} />
        <KPICard title={t('kpi.llm_calls')} value={formatNumber(kpis.llmCalls)} />
        <KPICard title={t('kpi.errors')} value={formatNumber(kpis.errors)} />
        <KPICard title={t('kpi.tokens')} value={formatTokens(kpis.tokens)} />
        <KPICard title={t('kpi.cost')} value={formatCost(kpis.cost)} />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Event Volume Over Time */}
        <ChartCard title={t('charts.event_volume')}>
          {volumeLoading ? (
            <div className="h-[240px] animate-pulse rounded-lg bg-background-muted" />
          ) : hasVolumeData ? (
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={volumeData}>
                {GRADIENT_DEFS}
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border-muted))" />
                <XAxis
                  dataKey="time"
                  tick={{ fontSize: 11, fill: 'hsl(var(--foreground-subtle))' }}
                  tickFormatter={formatTimeTick}
                />
                <YAxis tick={{ fontSize: 11, fill: 'hsl(var(--foreground-subtle))' }} />
                <RechartsTooltip content={<ChartTooltip />} />
                <Area
                  type="monotone"
                  dataKey="count"
                  name="Events"
                  stroke={CHART_COLORS[0]}
                  fill="url(#gradient-0)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <OverviewCardEmptyState
              icon={<BarChart3 className="w-8 h-8" />}
              title="No event volume in this window"
              description="Choose a broader time range or wait for new activity to see traffic trends."
            />
          )}
        </ChartCard>

        {/* Events by Category */}
        <ChartCard title={t('charts.events_by_category')}>
          {hasCategoryData ? (
            <div className="space-y-4">
              <ResponsiveContainer width="100%" height={240}>
                <PieChart>
                  <Pie
                    data={categoryPieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={100}
                    dataKey="value"
                    nameKey="name"
                    paddingAngle={2}
                  >
                    {categoryPieData.map((entry, i) => (
                      <Cell key={i} fill={entry.color} />
                    ))}
                  </Pie>
                  <RechartsTooltip content={<ChartTooltip />} />
                </PieChart>
              </ResponsiveContainer>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {categoryPieData.slice(0, 4).map((entry) => (
                  <div
                    key={entry.name}
                    className="flex items-center justify-between rounded-lg border border-default bg-background-subtle px-3 py-2 text-xs"
                  >
                    <span className="flex items-center gap-2 text-muted">
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ background: entry.color }}
                      />
                      <span className="capitalize">{entry.name.replace(/_/g, ' ')}</span>
                    </span>
                    <span className="font-medium text-foreground">
                      {formatNumber(entry.value)}
                      {totalCategoryEvents > 0 && (
                        <span className="ml-1 text-muted">
                          ({Math.round((entry.value / totalCategoryEvents) * 100)}%)
                        </span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <OverviewCardEmptyState
              icon={<PieChartIcon className="w-8 h-8" />}
              title="No categorized events yet"
              description="Event categories will appear here once the platform records traffic in the selected range."
            />
          )}
        </ChartCard>
      </div>

      {/* Recent Errors Table */}
      <div className="bg-background-elevated border border-default rounded-xl p-4 shadow-sm">
        <h3 className="text-sm font-medium text-foreground mb-4">{t('charts.recent_errors')}</h3>
        {errorsLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="h-10 animate-pulse rounded-lg bg-background-muted" />
            ))}
          </div>
        ) : recentErrors.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-default">
                  <th className="text-left py-2 px-3 text-xs text-muted font-medium">
                    {t('table.time')}
                  </th>
                  <th className="text-left py-2 px-3 text-xs text-muted font-medium">
                    {t('table.event_type')}
                  </th>
                  <th className="text-left py-2 px-3 text-xs text-muted font-medium">
                    {t('table.agent')}
                  </th>
                  <th className="text-left py-2 px-3 text-xs text-muted font-medium">
                    {t('table.message')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {recentErrors.map((evt, i) => (
                  <tr key={i} className="border-b border-default last:border-0">
                    <td className="py-2 px-3 text-subtle whitespace-nowrap">
                      {formatTimestamp(String(evt.timestamp))}
                    </td>
                    <td className="py-2 px-3">
                      <span className="px-1.5 py-0.5 bg-error/10 text-error text-xs rounded">
                        {String(evt.event_type || '')}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-foreground">{String(evt.agent_name || '-')}</td>
                    <td className="py-2 px-3 text-muted truncate max-w-[300px]">
                      {String(evt.error_message || evt.error_type || '-')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={<AlertTriangle className="w-8 h-8" />}
            title="No recent errors"
            description="Operational issues will appear here once the platform records failing events."
            className="px-4 py-10"
          />
        )}
      </div>
    </div>
  );
}
