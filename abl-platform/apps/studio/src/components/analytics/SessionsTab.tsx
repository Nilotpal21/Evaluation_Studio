/**
 * SessionsTab Component
 *
 * Session analytics: completion rate, duration, cost, sessions over time, top agents.
 */

import { useState, useEffect, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Activity } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip } from 'recharts';
import { useSessionMetrics, fetchAggregate, type TimeRange } from '../../hooks/useAnalytics';
import {
  KPICard,
  ChartCard,
  AnalyticsSkeleton,
  ChartTooltip,
  CHART_COLORS,
  formatNumber,
  formatCost,
  formatDuration,
  formatPercent,
  formatChartTick,
} from './shared';
import { EmptyState } from '../ui/EmptyState';

// =============================================================================
// TYPES
// =============================================================================

interface SessionsTabProps {
  projectId: string | null;
  timeRange: TimeRange;
}

interface SessionVolumePoint {
  time: string;
  count: number;
}

interface AgentVolumePoint {
  agent: string;
  count: number;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function SessionsTab({ projectId, timeRange }: SessionsTabProps) {
  const t = useTranslations('analytics');

  const { metrics, isLoading: metricsLoading } = useSessionMetrics(projectId, timeRange);

  // Sessions over time
  const [sessionVolume, setSessionVolume] = useState<SessionVolumePoint[]>([]);
  const [volumeLoading, setVolumeLoading] = useState(true);

  // Top agents
  const [agentVolume, setAgentVolume] = useState<AgentVolumePoint[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);

  useEffect(() => {
    if (!projectId) return;

    const from = new Date(timeRange.from);
    const to = new Date(timeRange.to);
    const hoursDiff = (to.getTime() - from.getTime()) / (1000 * 60 * 60);
    const groupBy = hoursDiff <= 48 ? 'hour' : 'day';

    // Sessions over time
    setVolumeLoading(true);
    fetchAggregate(projectId, {
      timeRange,
      groupBy: [groupBy],
      metrics: ['count'],
      filters: { eventTypes: ['session.started'] },
    })
      .then((res) => {
        if (res.success && res.data?.buckets) {
          setSessionVolume(
            res.data.buckets.map((b: Record<string, unknown>) => ({
              time: String(b[groupBy] || ''),
              count: Number(b.count || 0),
            })),
          );
        }
      })
      .catch((_err: unknown) => {
        // Analytics fetch failure — UI shows empty state via loading flags
      })
      .finally(() => setVolumeLoading(false));

    // Top agents
    setAgentsLoading(true);
    fetchAggregate(projectId, {
      timeRange,
      groupBy: ['agent_name'],
      metrics: ['count'],
    })
      .then((res) => {
        if (res.success && res.data?.buckets) {
          const agents = res.data.buckets
            .map((b: Record<string, unknown>) => ({
              agent: String(b.agent_name || 'unknown'),
              count: Number(b.count || 0),
            }))
            .filter((a: AgentVolumePoint) => a.agent !== 'unknown' && a.count > 0)
            .sort((a: AgentVolumePoint, b: AgentVolumePoint) => b.count - a.count)
            .slice(0, 10);
          setAgentVolume(agents);
        }
      })
      .catch((_err: unknown) => {
        // Analytics fetch failure — UI shows empty state via loading flags
      })
      .finally(() => setAgentsLoading(false));
  }, [projectId, timeRange.from, timeRange.to]);

  const isLoading = metricsLoading && volumeLoading && agentsLoading;
  if (isLoading) return <AnalyticsSkeleton />;

  const hasData = metrics && metrics.totalSessions > 0;
  if (!hasData) {
    return (
      <EmptyState
        icon={<Activity className="w-8 h-8" />}
        title={t('empty.title')}
        description={t('empty.description')}
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <KPICard title={t('kpi.sessions')} value={formatNumber(metrics.totalSessions)} />
        <KPICard title={t('kpi.completed')} value={formatPercent(metrics.completionRate)} />
        <KPICard title={t('kpi.avg_duration')} value={formatDuration(metrics.avgDurationMs)} />
        <KPICard title={t('kpi.avg_cost')} value={formatCost(metrics.avgCost)} />
      </div>

      {/* Sessions Over Time */}
      <ChartCard title={t('charts.sessions_over_time')}>
        <BarChart data={sessionVolume}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border-muted))" />
          <XAxis
            dataKey="time"
            tick={{ fontSize: 11, fill: 'hsl(var(--foreground-subtle))' }}
            tickFormatter={formatChartTick}
          />
          <YAxis tick={{ fontSize: 11, fill: 'hsl(var(--foreground-subtle))' }} />
          <RechartsTooltip content={<ChartTooltip />} />
          <Bar dataKey="count" name="Sessions" fill={CHART_COLORS[0]} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ChartCard>

      {/* Top Agents */}
      {agentVolume.length > 0 && (
        <ChartCard title={t('charts.top_agents')}>
          <BarChart data={agentVolume} layout="vertical">
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border-muted))" />
            <XAxis type="number" tick={{ fontSize: 11, fill: 'hsl(var(--foreground-subtle))' }} />
            <YAxis
              type="category"
              dataKey="agent"
              width={140}
              tick={{ fontSize: 11, fill: 'hsl(var(--foreground-subtle))' }}
            />
            <RechartsTooltip content={<ChartTooltip />} />
            <Bar dataKey="count" name="Events" fill={CHART_COLORS[1]} radius={[0, 4, 4, 0]} />
          </BarChart>
        </ChartCard>
      )}
    </div>
  );
}
