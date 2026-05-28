/**
 * AgentPerformancePage Component
 *
 * Workspace-level agent performance analytics. Shows a grid of agent cards
 * with key metrics (sessions, latency, error rate, cost) and a detail view
 * with time-series charts when an agent card is clicked.
 */

import { useState, useMemo, useCallback, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { clsx } from 'clsx';
import {
  Activity,
  Clock,
  AlertTriangle,
  DollarSign,
  ArrowLeft,
  Loader2,
  Bot,
  TrendingUp,
} from 'lucide-react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  BarChart,
  Bar,
} from 'recharts';
import { apiFetch } from '../../lib/api-client';
import { useAuthStore } from '../../store/auth-store';
import {
  KPICard,
  ChartCard,
  ChartTooltip,
  CHART_COLORS,
  GRADIENT_DEFS,
  formatNumber,
  formatDuration,
  formatCost,
  formatChartTick,
} from '../analytics/shared';
import { Badge } from '../ui/Badge';
import { EmptyState } from '../ui/EmptyState';
import { AnalyticsLayout, type AnalyticsContext } from './AnalyticsLayout';

// =============================================================================
// TYPES
// =============================================================================

interface AgentMetrics {
  agentName: string;
  sessionCount: number;
  avgLatencyMs: number;
  errorRate: number;
  totalCost: number;
  totalTokens: number;
}

interface AgentTimeSeries {
  bucket: string;
  sessions: number;
  avgLatencyMs: number;
  errorRate: number;
  cost: number;
}

// =============================================================================
// HELPERS
// =============================================================================

const ERROR_RATE_THRESHOLD = 0.05; // 5%

function getErrorBadgeVariant(rate: number): 'success' | 'warning' | 'error' {
  if (rate >= ERROR_RATE_THRESHOLD) return 'error';
  if (rate >= 0.02) return 'warning';
  return 'success';
}

// =============================================================================
// COMPONENT
// =============================================================================

export function AgentPerformancePage() {
  return (
    <AnalyticsLayout>{(context) => <AgentPerformanceContent context={context} />}</AnalyticsLayout>
  );
}

function AgentPerformanceContent({ context }: { context: AnalyticsContext }) {
  const t = useTranslations('admin');
  const tenantId = useAuthStore((s) => s.tenantId);
  const [agents, setAgents] = useState<AgentMetrics[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [detailData, setDetailData] = useState<AgentTimeSeries[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  const { projectId, timeRange } = context;

  // Fetch agent metrics
  const fetchAgents = useCallback(async () => {
    if (!tenantId) return;
    setIsLoading(true);
    try {
      const params = new URLSearchParams({
        endpoint: 'metrics',
        from: timeRange.from,
        to: timeRange.to,
        groupBy: 'agent_name',
        metrics: 'count,avg_duration,error_rate,total_cost,total_tokens',
      });
      if (projectId) params.set('projectId', projectId);
      else {
        // For tenant-wide, use first project or skip
        const firstProject = context.projects[0];
        if (!firstProject) {
          setAgents([]);
          setIsLoading(false);
          return;
        }
        params.set('projectId', firstProject.id);
      }

      const res = await apiFetch(`/api/runtime/analytics?${params.toString()}`);
      if (!res.ok) {
        setAgents([]);
        return;
      }
      const json = await res.json();
      if (json.success && json.data?.buckets) {
        const mapped: AgentMetrics[] = json.data.buckets
          .filter(
            (b: Record<string, unknown>) => b.agent_name && String(b.agent_name).trim() !== '',
          )
          .map((b: Record<string, unknown>) => ({
            agentName: String(b.agent_name || 'Unknown'),
            sessionCount: Number(b.count || 0),
            avgLatencyMs: Number(b.avg_duration || 0),
            errorRate: Number(b.error_rate || 0),
            totalCost: Number(b.total_cost || 0),
            totalTokens: Number(b.total_tokens || 0),
          }));
        setAgents(mapped.sort((a, b) => b.sessionCount - a.sessionCount));
      } else {
        setAgents([]);
      }
    } catch {
      setAgents([]);
    } finally {
      setIsLoading(false);
    }
  }, [tenantId, projectId, timeRange.from, timeRange.to, context.projects]);

  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  // Fetch detail time series when agent selected
  const fetchDetail = useCallback(
    async (agentName: string) => {
      if (!tenantId) return;
      setDetailLoading(true);
      try {
        const params = new URLSearchParams({
          endpoint: 'metrics',
          from: timeRange.from,
          to: timeRange.to,
          groupBy: 'time',
          metrics: 'count,avg_duration,error_rate,total_cost',
          agentName,
        });
        if (projectId) params.set('projectId', projectId);
        else {
          const firstProject = context.projects[0];
          if (firstProject) params.set('projectId', firstProject.id);
        }

        const res = await apiFetch(`/api/runtime/analytics?${params.toString()}`);
        if (!res.ok) {
          setDetailData([]);
          return;
        }
        const json = await res.json();
        if (json.success && json.data?.buckets) {
          setDetailData(
            json.data.buckets.map((b: Record<string, unknown>) => ({
              bucket: String(b.time || b.bucket || ''),
              sessions: Number(b.count || 0),
              avgLatencyMs: Number(b.avg_duration || 0),
              errorRate: Number(b.error_rate || 0),
              cost: Number(b.total_cost || 0),
            })),
          );
        } else {
          setDetailData([]);
        }
      } catch {
        setDetailData([]);
      } finally {
        setDetailLoading(false);
      }
    },
    [tenantId, projectId, timeRange.from, timeRange.to, context.projects],
  );

  const handleSelectAgent = (agentName: string) => {
    setSelectedAgent(agentName);
    fetchDetail(agentName);
  };

  const handleBack = () => {
    setSelectedAgent(null);
    setDetailData([]);
  };

  // KPI aggregates
  const kpis = useMemo(() => {
    const totalSessions = agents.reduce((s, a) => s + a.sessionCount, 0);
    const avgLatency =
      agents.length > 0 ? agents.reduce((s, a) => s + a.avgLatencyMs, 0) / agents.length : 0;
    const totalCost = agents.reduce((s, a) => s + a.totalCost, 0);
    const avgErrorRate =
      agents.length > 0 ? agents.reduce((s, a) => s + a.errorRate, 0) / agents.length : 0;
    return { totalSessions, avgLatency, totalCost, avgErrorRate };
  }, [agents]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-5 h-5 text-muted animate-spin" />
      </div>
    );
  }

  if (agents.length === 0 && !selectedAgent) {
    return (
      <EmptyState
        icon={<Bot className="w-6 h-6" />}
        title={t('analytics_agents.empty_title')}
        description={t('analytics_agents.empty_description')}
      />
    );
  }

  // Detail view
  if (selectedAgent) {
    const agent = agents.find((a) => a.agentName === selectedAgent);
    return (
      <div className="space-y-6">
        {/* Back button + agent header */}
        <div className="flex items-center gap-3">
          <button
            onClick={handleBack}
            className="p-1.5 text-muted hover:text-foreground rounded-lg transition-default hover:bg-background-muted"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div>
            <h2 className="text-lg font-semibold text-foreground">{selectedAgent}</h2>
            <p className="text-sm text-muted">{t('analytics_agents.detail_subtitle')}</p>
          </div>
        </div>

        {/* Agent KPIs */}
        {agent && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <KPICard
              title={t('analytics_agents.kpi_sessions')}
              value={formatNumber(agent.sessionCount)}
            />
            <KPICard
              title={t('analytics_agents.kpi_avg_latency')}
              value={formatDuration(agent.avgLatencyMs)}
            />
            <KPICard
              title={t('analytics_agents.kpi_error_rate')}
              value={`${(agent.errorRate * 100).toFixed(1)}%`}
            />
            <KPICard
              title={t('analytics_agents.kpi_total_cost')}
              value={formatCost(agent.totalCost)}
            />
          </div>
        )}

        {/* Time series charts */}
        {detailLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-5 h-5 text-muted animate-spin" />
          </div>
        ) : detailData.length > 0 ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Session Volume */}
            <ChartCard title={t('analytics_agents.chart_session_volume')}>
              <BarChart data={detailData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                {GRADIENT_DEFS}
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="bucket"
                  tick={{
                    fontSize: 11,
                    fill: 'hsl(var(--foreground-muted))',
                  }}
                  tickFormatter={formatChartTick}
                />
                <YAxis
                  tick={{
                    fontSize: 11,
                    fill: 'hsl(var(--foreground-muted))',
                  }}
                  width={50}
                />
                <RechartsTooltip
                  content={<ChartTooltip formatter={(v: number) => formatNumber(v)} />}
                />
                <Bar dataKey="sessions" fill={CHART_COLORS[0]} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ChartCard>

            {/* Latency Trend */}
            <ChartCard title={t('analytics_agents.chart_avg_latency')}>
              <AreaChart data={detailData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                {GRADIENT_DEFS}
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="bucket"
                  tick={{
                    fontSize: 11,
                    fill: 'hsl(var(--foreground-muted))',
                  }}
                  tickFormatter={formatChartTick}
                />
                <YAxis
                  tick={{
                    fontSize: 11,
                    fill: 'hsl(var(--foreground-muted))',
                  }}
                  tickFormatter={(v: number) => formatDuration(v)}
                  width={50}
                />
                <RechartsTooltip
                  content={<ChartTooltip formatter={(v: number) => formatDuration(v)} />}
                />
                <Area
                  type="monotone"
                  dataKey="avgLatencyMs"
                  stroke={CHART_COLORS[1]}
                  fill="url(#gradPurple)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ChartCard>

            {/* Error Rate Trend */}
            <ChartCard title={t('analytics_agents.chart_error_rate')}>
              <AreaChart data={detailData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                {GRADIENT_DEFS}
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="bucket"
                  tick={{
                    fontSize: 11,
                    fill: 'hsl(var(--foreground-muted))',
                  }}
                  tickFormatter={formatChartTick}
                />
                <YAxis
                  tick={{
                    fontSize: 11,
                    fill: 'hsl(var(--foreground-muted))',
                  }}
                  tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`}
                  width={50}
                />
                <RechartsTooltip
                  content={<ChartTooltip formatter={(v: number) => `${(v * 100).toFixed(1)}%`} />}
                />
                <Area
                  type="monotone"
                  dataKey="errorRate"
                  stroke={CHART_COLORS[2]}
                  fill="url(#gradError)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ChartCard>

            {/* Cost Trend */}
            <ChartCard title={t('analytics_agents.chart_cost')}>
              <AreaChart data={detailData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                {GRADIENT_DEFS}
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="bucket"
                  tick={{
                    fontSize: 11,
                    fill: 'hsl(var(--foreground-muted))',
                  }}
                  tickFormatter={formatChartTick}
                />
                <YAxis
                  tick={{
                    fontSize: 11,
                    fill: 'hsl(var(--foreground-muted))',
                  }}
                  tickFormatter={(v: number) => formatCost(v)}
                  width={60}
                />
                <RechartsTooltip
                  content={<ChartTooltip formatter={(v: number) => formatCost(v)} />}
                />
                <Area
                  type="monotone"
                  dataKey="cost"
                  stroke={CHART_COLORS[3]}
                  fill="url(#gradSuccess)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ChartCard>
          </div>
        ) : (
          <EmptyState
            icon={<TrendingUp className="w-6 h-6" />}
            title={t('analytics_agents.no_timeseries_title')}
            description={t('analytics_agents.no_timeseries_description')}
          />
        )}
      </div>
    );
  }

  // Grid view
  return (
    <div className="space-y-6">
      {/* Summary KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <KPICard
          title={t('analytics_agents.kpi_total_sessions')}
          value={formatNumber(kpis.totalSessions)}
        />
        <KPICard
          title={t('analytics_agents.kpi_avg_latency')}
          value={formatDuration(kpis.avgLatency)}
        />
        <KPICard
          title={t('analytics_agents.kpi_avg_error_rate')}
          value={`${(kpis.avgErrorRate * 100).toFixed(1)}%`}
        />
        <KPICard title={t('analytics_agents.kpi_total_cost')} value={formatCost(kpis.totalCost)} />
      </div>

      {/* Agent cards grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {agents.map((agent) => (
          <button
            key={agent.agentName}
            onClick={() => handleSelectAgent(agent.agentName)}
            className="text-left bg-background-elevated border border-default rounded-xl p-5 shadow-sm hover:border-accent/50 hover:shadow-md transition-default group"
          >
            {/* Agent name */}
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 rounded-lg bg-accent-subtle flex items-center justify-center shrink-0">
                <Bot className="w-4 h-4 text-accent" />
              </div>
              <h3 className="text-sm font-semibold text-foreground truncate group-hover:text-accent transition-default">
                {agent.agentName}
              </h3>
            </div>

            {/* Metrics grid */}
            <div className="grid grid-cols-2 gap-3">
              <MetricCell
                label={t('analytics_agents.metric_sessions')}
                value={formatNumber(agent.sessionCount)}
              />
              <MetricCell
                label={t('analytics_agents.metric_avg_latency')}
                value={formatDuration(agent.avgLatencyMs)}
              />
              <div>
                <span className="text-xs text-muted uppercase tracking-wider">
                  {t('analytics_agents.metric_error_rate')}
                </span>
                <div className="mt-0.5">
                  <Badge variant={getErrorBadgeVariant(agent.errorRate)}>
                    {(agent.errorRate * 100).toFixed(1)}%
                  </Badge>
                </div>
              </div>
              <MetricCell
                label={t('analytics_agents.metric_total_cost')}
                value={formatCost(agent.totalCost)}
              />
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

function MetricCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-xs text-muted uppercase tracking-wider">{label}</span>
      <p className="text-sm font-medium text-foreground mt-0.5">{value}</p>
    </div>
  );
}
