// apps/studio/src/components/insights/AgentPerformancePage.tsx
'use client';

import { useState, useMemo } from 'react';
import { Search, ArrowUpDown, Info, Activity, ArrowLeftRight } from 'lucide-react';
import { clsx } from 'clsx';
import { PageHeader } from '../ui/PageHeader';
import { Input } from '../ui/Input';
import { Skeleton } from '../ui/Skeleton';
import { EmptyState } from '../ui/EmptyState';
import { InsightsDateRangeControl } from './shared/InsightsDateRangeControl';
import { Tooltip, TooltipProvider } from '../ui/Tooltip';
import { InsightKPICard } from './shared/InsightKPICard';
import { TimeSeriesChart } from './shared/TimeSeriesChart';
import { SEMANTIC_CHART_COLORS } from '@agent-platform/design-tokens';
import {
  useAgentPerformance,
  classifyAgentPerformanceMetric,
  type AgentRow,
  type AgentStatus,
} from '../../hooks/useAgentPerformance';
import { usePersistedSurfaceFilters } from '../../hooks/usePersistedSurfaceFilters';
import { ResetFiltersButton } from '../shared/ResetFiltersButton';

type DateRange = '7d' | '30d' | '90d';
type SortKey =
  | 'status'
  | 'conversations'
  | 'quality'
  | 'hallucinationRate'
  | 'knowledgeGaps'
  | 'safetyScore'
  | 'contextScore';
type StatusFilter = 'all' | 'critical' | 'warning';

const STATUS_PRIORITY: Record<AgentStatus, number> = {
  critical: 0,
  warning: 1,
  healthy: 2,
};

const STATUS_COLORS: Record<AgentStatus, { bg: string; text: string; border: string }> = {
  critical: { bg: 'bg-error/10', text: 'text-error', border: 'border-l-error' },
  warning: { bg: 'bg-warning/10', text: 'text-warning', border: 'border-l-warning' },
  healthy: { bg: '', text: 'text-success', border: 'border-l-transparent' },
};

const BANNER_GRADIENTS: Record<AgentStatus, string> = {
  healthy: 'from-success/10 to-success/5',
  warning: 'from-warning/10 to-warning/5',
  critical: 'from-error/10 to-error/5',
};

// ── HealthBanner ───────────────────────────────────────────────────────────

function HealthBanner({
  healthy,
  warning,
  critical,
  totalAgents,
  totalConversations,
  conversationsDelta,
}: {
  healthy: number;
  warning: number;
  critical: number;
  totalAgents: number;
  totalConversations: number;
  conversationsDelta: number | null;
}) {
  const overallStatus: AgentStatus =
    critical > 0 ? 'critical' : warning > 0 ? 'warning' : 'healthy';
  const gradient = BANNER_GRADIENTS[overallStatus];

  return (
    <div className={clsx('rounded-xl p-4 bg-gradient-to-br border border-default', gradient)}>
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Agent Health</h3>
          <p className="text-xs text-muted mt-0.5">
            {totalAgents} agent{totalAgents !== 1 ? 's' : ''} &middot;{' '}
            {totalConversations.toLocaleString()} conversations
            {conversationsDelta !== null && conversationsDelta !== 0 && (
              <span className={conversationsDelta > 0 ? 'text-success' : 'text-error'}>
                {' '}
                ({conversationsDelta > 0 ? '+' : ''}
                {conversationsDelta.toLocaleString()} vs prev)
              </span>
            )}
          </p>
        </div>
        <div className="flex gap-4 text-xs font-medium">
          {critical > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-error" />
              <span className="text-error">{critical} Critical</span>
            </span>
          )}
          {warning > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-warning" />
              <span className="text-warning">{warning} Warning</span>
            </span>
          )}
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-success" />
            <span className="text-success">{healthy} Healthy</span>
          </span>
        </div>
      </div>
    </div>
  );
}

// ── AgentTable ─────────────────────────────────────────────────────────────

const PAGE_SIZE = 10;

function StatusBadge({ status }: { status: AgentStatus }) {
  const labels: Record<AgentStatus, string> = {
    critical: 'Critical',
    warning: 'Warning',
    healthy: 'Healthy',
  };
  return (
    <span
      className={clsx(
        'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium',
        STATUS_COLORS[status].bg,
        STATUS_COLORS[status].text,
      )}
    >
      {labels[status]}
    </span>
  );
}

function AgentTable({
  agents,
  search,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  healthSummary,
}: {
  agents: AgentRow[];
  search: string;
  onSearchChange: (v: string) => void;
  statusFilter: StatusFilter;
  onStatusFilterChange: (v: StatusFilter) => void;
  healthSummary: { healthy: number; warning: number; critical: number; totalAgents: number };
}) {
  const [sortKey, setSortKey] = useState<SortKey>('status');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [showAll, setShowAll] = useState(false);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir(key === 'status' ? 'asc' : 'desc');
    }
  };

  const filtered = useMemo(() => {
    let rows = agents;
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter((a) => a.agentName.toLowerCase().includes(q));
    }
    if (statusFilter !== 'all') {
      rows = rows.filter((a) => a.status === statusFilter);
    }
    return rows;
  }, [agents, search, statusFilter]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      if (sortKey === 'status') {
        const diff = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status];
        return sortDir === 'asc' ? diff : -diff;
      }
      const aVal = a[sortKey] ?? -Infinity;
      const bVal = b[sortKey] ?? -Infinity;
      return sortDir === 'asc'
        ? (aVal as number) - (bVal as number)
        : (bVal as number) - (aVal as number);
    });
  }, [filtered, sortKey, sortDir]);

  const visible = showAll ? sorted : sorted.slice(0, PAGE_SIZE);

  const columns: { key: SortKey; label: string; tooltip?: string }[] = [
    { key: 'status', label: 'Status' },
    {
      key: 'conversations',
      label: 'Conversations',
      tooltip: 'Total conversations handled by this agent',
    },
    {
      key: 'quality',
      label: 'Quality',
      tooltip: 'Average quality score (0-5) from LLM evaluation pipeline',
    },
    {
      key: 'hallucinationRate',
      label: 'Hallucination',
      tooltip: 'Percentage of responses flagged as containing inaccurate or fabricated information',
    },
    {
      key: 'knowledgeGaps',
      label: 'Knowledge Gaps',
      tooltip: 'Number of conversations where the agent lacked sufficient knowledge',
    },
    {
      key: 'safetyScore',
      label: 'Safety',
      tooltip: 'Guardrail pass rate — percentage of conversations meeting safety policies',
    },
    {
      key: 'contextScore',
      label: 'Context',
      tooltip: 'Context preservation score (0-5) — how well conversation context is maintained',
    },
  ];

  return (
    <TooltipProvider>
      <div className="bg-background-elevated rounded-xl border border-default">
        {/* Toolbar */}
        <div className="flex items-center gap-3 p-3 border-b border-default flex-wrap">
          <div className="relative flex-1 min-w-48">
            <Input
              type="text"
              icon={<Search className="w-3.5 h-3.5" />}
              placeholder="Search agents..."
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              className="py-1.5 text-xs"
            />
          </div>
          <div className="flex gap-1.5">
            {healthSummary.critical > 0 && (
              <button
                onClick={() =>
                  onStatusFilterChange(statusFilter === 'critical' ? 'all' : 'critical')
                }
                className={clsx(
                  'px-2.5 py-1 rounded-full text-xs font-medium transition-colors',
                  statusFilter === 'critical'
                    ? 'bg-error/20 text-error'
                    : 'bg-background text-muted hover:text-foreground',
                )}
              >
                Critical ({healthSummary.critical})
              </button>
            )}
            {healthSummary.warning > 0 && (
              <button
                onClick={() => onStatusFilterChange(statusFilter === 'warning' ? 'all' : 'warning')}
                className={clsx(
                  'px-2.5 py-1 rounded-full text-xs font-medium transition-colors',
                  statusFilter === 'warning'
                    ? 'bg-warning/20 text-warning'
                    : 'bg-background text-muted hover:text-foreground',
                )}
              >
                Warning ({healthSummary.warning})
              </button>
            )}
            <button
              onClick={() => onStatusFilterChange('all')}
              className={clsx(
                'px-2.5 py-1 rounded-full text-xs font-medium transition-colors',
                statusFilter === 'all'
                  ? 'bg-accent/20 text-accent-foreground'
                  : 'bg-background text-muted hover:text-foreground',
              )}
            >
              All ({healthSummary.totalAgents})
            </button>
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-xs text-muted uppercase tracking-wider">
                <th className="px-4 py-2.5 text-left font-medium">Agent</th>
                {columns.map((col) => (
                  <th
                    key={col.key}
                    className="px-3 py-2.5 text-center font-medium cursor-pointer hover:text-foreground transition-colors select-none"
                    onClick={() => handleSort(col.key)}
                  >
                    <span className="inline-flex items-center gap-0.5">
                      {col.label}
                      {sortKey === col.key && <ArrowUpDown className="w-2.5 h-2.5" />}
                      {col.tooltip && (
                        <Tooltip content={col.tooltip} side="top">
                          <button
                            type="button"
                            className="text-subtle hover:text-muted transition-default"
                            aria-label={`About ${col.label}`}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Info className="w-2.5 h-2.5" />
                          </button>
                        </Tooltip>
                      )}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((agent) => (
                <tr
                  key={agent.agentName}
                  className={clsx(
                    'border-t border-default text-xs transition-colors',
                    agent.status === 'critical' && 'bg-error/5',
                    agent.status === 'warning' && 'bg-warning/5',
                  )}
                >
                  <td
                    className={clsx(
                      'px-4 py-2.5 font-medium text-foreground border-l-2',
                      STATUS_COLORS[agent.status].border,
                    )}
                  >
                    {agent.agentName}
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    <StatusBadge status={agent.status} />
                  </td>
                  <td className="px-3 py-2.5 text-center text-muted">
                    {agent.conversations.toLocaleString()}
                  </td>
                  <td className="px-3 py-2.5 text-center font-medium">
                    <span
                      className={
                        agent.quality !== null
                          ? STATUS_COLORS[classifyAgentPerformanceMetric(agent.quality, 'quality')]
                              .text
                          : 'text-muted'
                      }
                    >
                      {agent.quality !== null && agent.quality > 0
                        ? agent.quality.toFixed(1)
                        : '\u2014'}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-center font-medium">
                    <span
                      className={
                        agent.hallucinationRate !== null
                          ? STATUS_COLORS[
                              classifyAgentPerformanceMetric(
                                agent.hallucinationRate,
                                'hallucinationRate',
                              )
                            ].text
                          : 'text-muted'
                      }
                    >
                      {agent.hallucinationRate !== null
                        ? `${agent.hallucinationRate.toFixed(1)}%`
                        : '\u2014'}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-center font-medium">
                    <span
                      className={
                        agent.knowledgeGaps !== null
                          ? STATUS_COLORS[
                              classifyAgentPerformanceMetric(agent.knowledgeGaps, 'knowledgeGaps')
                            ].text
                          : 'text-muted'
                      }
                    >
                      {agent.knowledgeGaps !== null ? agent.knowledgeGaps : '\u2014'}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-center font-medium">
                    <span
                      className={
                        agent.safetyScore !== null
                          ? STATUS_COLORS[
                              classifyAgentPerformanceMetric(agent.safetyScore, 'safetyScore')
                            ].text
                          : 'text-muted'
                      }
                    >
                      {agent.safetyScore !== null ? `${agent.safetyScore.toFixed(0)}%` : '\u2014'}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-center font-medium">
                    <span
                      className={
                        agent.contextScore !== null
                          ? STATUS_COLORS[
                              classifyAgentPerformanceMetric(agent.contextScore, 'contextScore')
                            ].text
                          : 'text-muted'
                      }
                    >
                      {agent.contextScore !== null && agent.contextScore > 0
                        ? agent.contextScore.toFixed(1)
                        : '\u2014'}
                    </span>
                  </td>
                </tr>
              ))}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-sm text-muted">
                    No agents found
                    {search ? ' matching your search' : ' in the selected period'}.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {sorted.length > PAGE_SIZE && !showAll && (
          <div className="px-4 py-2.5 border-t border-default text-center">
            <button
              onClick={() => setShowAll(true)}
              className="text-xs text-accent-foreground hover:opacity-80 font-medium"
            >
              Show all {sorted.length} agents
            </button>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────

export function AgentPerformancePage() {
  const {
    state: persistedFilters,
    updateState,
    reset,
    nonDefaultCount,
  } = usePersistedSurfaceFilters('agentPerformance');
  const dateRange = persistedFilters.dateRange as DateRange;
  const compareEnabled = persistedFilters.compareEnabled;
  const search = persistedFilters.search;
  const statusFilter = persistedFilters.statusFilter as StatusFilter;

  const { kpis, agents, healthSummary, dailyTrend, isLoading, error, projectId } =
    useAgentPerformance(dateRange, compareEnabled);

  const trendMetrics = [
    { key: 'avgQuality', label: 'Avg Quality', color: SEMANTIC_CHART_COLORS.success },
    {
      key: 'flaggedCount',
      label: 'Flagged',
      color: SEMANTIC_CHART_COLORS.error,
      type: 'area' as const,
    },
  ];

  if (!projectId) {
    return (
      <div className="flex items-center justify-center h-64 text-muted">
        Select a project to view agent performance
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="h-full overflow-y-auto bg-noise">
        <div className="max-w-7xl mx-auto px-6 py-8 space-y-6">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-20 w-full rounded-xl" />
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      </div>
    );
  }

  // Empty state: no data at all
  if (healthSummary.totalAgents === 0 && healthSummary.totalConversations === 0) {
    return (
      <div className="h-full overflow-y-auto bg-noise">
        <div className="max-w-7xl mx-auto px-6 py-8 space-y-6">
          <PageHeader
            title="Agent Performance"
            description="Monitor and compare agent quality across all evaluation dimensions"
            beforeActions={<ResetFiltersButton count={nonDefaultCount} onClick={reset} />}
            actions={
              <InsightsDateRangeControl
                preset="day"
                value={dateRange}
                onChange={(value) => updateState({ dateRange: value as DateRange })}
              />
            }
          />
          <EmptyState
            icon={<Activity className="w-6 h-6" />}
            title="No agent performance data yet"
            description="Enable analytics pipelines in Settings to start tracking agent quality, hallucination rates, knowledge gaps, and more."
          />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-noise">
      <div className="max-w-7xl mx-auto px-6 py-8 space-y-6">
        {/* Header */}
        <PageHeader
          title="Agent Performance"
          description="Monitor and compare agent quality across all evaluation dimensions"
          beforeActions={<ResetFiltersButton count={nonDefaultCount} onClick={reset} />}
          actions={
            <div className="flex items-center gap-2">
              <button
                onClick={() => updateState({ compareEnabled: !compareEnabled })}
                className={clsx(
                  'inline-flex items-center gap-2 px-3 py-2 text-sm rounded-lg border transition-colors',
                  compareEnabled
                    ? 'bg-accent/10 border-accent text-accent-foreground'
                    : 'border-default text-muted hover:text-foreground',
                )}
              >
                <ArrowLeftRight className="h-4 w-4" aria-hidden="true" />
                Compare
              </button>
              <InsightsDateRangeControl
                preset="day"
                value={dateRange}
                onChange={(value) => updateState({ dateRange: value as DateRange })}
              />
            </div>
          }
        />

        {/* Error state */}
        {error && (
          <div className="rounded-lg border border-error/30 bg-error-subtle p-4 text-sm text-error">
            Failed to load some agent performance data. Showing available metrics.
          </div>
        )}

        {/* Health Banner */}
        <HealthBanner
          healthy={healthSummary.healthy}
          warning={healthSummary.warning}
          critical={healthSummary.critical}
          totalAgents={healthSummary.totalAgents}
          totalConversations={healthSummary.totalConversations}
          conversationsDelta={compareEnabled ? healthSummary.conversationsDelta : null}
        />

        {/* KPI Sparklines */}
        <TooltipProvider>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <InsightKPICard
              title="Quality"
              value={
                kpis.quality.value !== null && kpis.quality.value > 0
                  ? kpis.quality.value.toFixed(1)
                  : '\u2014'
              }
              subtitle="avg score (0-5)"
              tooltip="Average quality score (0-5) from LLM evaluation. Measures response helpfulness, accuracy, and relevance"
              trend={
                kpis.quality.delta !== null
                  ? { value: kpis.quality.delta * 20, period: 'vs prev', favorable: 'up' }
                  : undefined
              }
              sparkline={kpis.quality.sparkline}
              status={kpis.quality.status}
            />
            <InsightKPICard
              title="Hallucination Rate"
              value={
                kpis.hallucination.value !== null
                  ? `${kpis.hallucination.value.toFixed(1)}%`
                  : '\u2014'
              }
              subtitle="flagged rate"
              tooltip="Percentage of conversations flagged for containing fabricated or inaccurate information"
              trend={
                kpis.hallucination.delta !== null
                  ? { value: kpis.hallucination.delta, period: 'vs prev', favorable: 'down' }
                  : undefined
              }
              status={kpis.hallucination.status}
            />
            <InsightKPICard
              title="Knowledge Gaps"
              value={
                kpis.knowledgeGaps.value !== null ? Math.round(kpis.knowledgeGaps.value) : '\u2014'
              }
              subtitle="gaps detected"
              tooltip="Number of conversations where the agent lacked sufficient knowledge to answer correctly"
              trend={
                kpis.knowledgeGaps.delta !== null
                  ? { value: kpis.knowledgeGaps.delta, period: 'vs prev', favorable: 'down' }
                  : undefined
              }
              status={kpis.knowledgeGaps.status}
            />
            <InsightKPICard
              title="Safety Score"
              value={kpis.safety.value !== null ? `${kpis.safety.value.toFixed(0)}%` : '\u2014'}
              subtitle="guardrail pass rate"
              tooltip="Percentage of conversations passing guardrail checks. Measures compliance with safety policies"
              trend={
                kpis.safety.delta !== null
                  ? { value: kpis.safety.delta, period: 'vs prev', favorable: 'up' }
                  : undefined
              }
              status={kpis.safety.status}
            />
            <InsightKPICard
              title="Context Score"
              value={
                kpis.context.value !== null && kpis.context.value > 0
                  ? kpis.context.value.toFixed(1)
                  : '\u2014'
              }
              subtitle="avg score (0-5)"
              tooltip="Average context preservation score (0-5). Measures how well the agent maintains conversation context across turns"
              trend={
                kpis.context.delta !== null
                  ? { value: kpis.context.delta * 20, period: 'vs prev', favorable: 'up' }
                  : undefined
              }
              status={kpis.context.status}
            />
          </div>
        </TooltipProvider>

        {/* Agent Table */}
        <AgentTable
          agents={agents}
          search={search}
          onSearchChange={(value) => updateState({ search: value })}
          statusFilter={statusFilter}
          onStatusFilterChange={(value) => updateState({ statusFilter: value })}
          healthSummary={healthSummary}
        />

        {/* Quality Trend Chart */}
        {dailyTrend.length > 0 && (
          <div className="bg-background-elevated rounded-xl border border-default p-6">
            <h3 className="text-sm font-semibold text-foreground mb-4">Quality Trend</h3>
            <TimeSeriesChart data={dailyTrend} metrics={trendMetrics} dateKey="day" height={250} />
          </div>
        )}
      </div>
    </div>
  );
}
