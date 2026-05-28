'use client';

/**
 * WorkflowMonitorTab Component
 *
 * Execution history table with status badges, KPI summary bar,
 * and a right-side slider panel for execution details.
 * Uses useWorkflowExecutions() hook with 5-second polling for live updates.
 * Filterable by execution status.
 */

import { useState, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
  Loader2,
  Activity,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Ban,
  Filter,
  TrendingUp,
  BarChart3,
  ChevronRight,
} from 'lucide-react';
import clsx from 'clsx';
import { useWorkflowExecutions } from '../../../hooks/useWorkflowDetail';
import { useWorkflowStore, type ExecutionFilter } from '../../../store/workflow-store';
import type { WorkflowExecution } from '../../../api/workflows';
import { Badge, type BadgeVariant } from '../../ui/Badge';
import { EmptyState } from '../../ui/EmptyState';
import { MetricCard } from '../../ui/MetricCard';
import { SlidePanel } from '../../ui/SlidePanel';
import { WorkflowDebugPanel } from '../canvas/panels/WorkflowDebugPanel';

// =============================================================================
// CONSTANTS
// =============================================================================

// Static trigger-type badge mapping for the run row. Variants match the
// triggers-tab header badge (webhook=info, cron=accent, event=accent) so the
// same trigger is visually consistent between the Triggers tab and a row in
// Monitor. `app` is rendered as a purple badge because the triggerType enum
// doesn't carry that tier — we derive it from `triggerMetadata.connectorName`
// at render time (see getTriggerBadge below).
const TRIGGER_TYPE_CONFIG: Record<string, { label: string; variant: BadgeVariant }> = {
  webhook: { label: 'Webhook', variant: 'info' },
  cron: { label: 'Schedule', variant: 'accent' },
  event: { label: 'Event', variant: 'accent' },
  workflow: { label: 'Workflow', variant: 'accent' },
};

/**
 * Resolve the badge label + variant for an execution's trigger source.
 * Connector-backed (app) triggers surface the connector name (e.g. "gmail")
 * because that's the signal an operator scanning the list cares about —
 * "event" alone doesn't tell them whether the run came from Gmail or Slack.
 */
function getTriggerBadge(execution: WorkflowExecution): { label: string; variant: BadgeVariant } {
  const connectorName =
    typeof execution.triggerMetadata?.connectorName === 'string'
      ? execution.triggerMetadata.connectorName
      : undefined;
  if (connectorName) {
    return { label: connectorName, variant: 'purple' };
  }
  return (
    TRIGGER_TYPE_CONFIG[execution.triggerType] ?? {
      label: execution.triggerType,
      variant: 'default',
    }
  );
}

const EXECUTION_STATUS_CONFIG: Record<
  string,
  { label: string; variant: BadgeVariant; icon: React.ReactNode }
> = {
  running: {
    label: 'Running',
    variant: 'accent',
    icon: <Loader2 className="w-3 h-3 animate-spin" />,
  },
  completed: { label: 'Completed', variant: 'success', icon: <CheckCircle2 className="w-3 h-3" /> },
  failed: { label: 'Failed', variant: 'error', icon: <XCircle className="w-3 h-3" /> },
  waiting_human: {
    label: 'Awaiting Human',
    variant: 'warning',
    icon: <AlertTriangle className="w-3 h-3" />,
  },
  waiting_approval: {
    label: 'Awaiting Approval',
    variant: 'warning',
    icon: <AlertTriangle className="w-3 h-3" />,
  },
  waiting_callback: {
    label: 'Awaiting Callback',
    variant: 'warning',
    icon: <Loader2 className="w-3 h-3 animate-spin" />,
  },
  cancelled: { label: 'Cancelled', variant: 'default', icon: <Ban className="w-3 h-3" /> },
  rejected: { label: 'Rejected', variant: 'error', icon: <XCircle className="w-3 h-3" /> },
};

const FILTER_OPTIONS: { value: ExecutionFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'running', label: 'Running' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'waiting_human', label: 'Awaiting Human' },
  { value: 'waiting_approval', label: 'Awaiting Approval' },
  { value: 'waiting_callback', label: 'Awaiting Callback' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'rejected', label: 'Rejected' },
];

// =============================================================================
// HELPERS
// =============================================================================

function formatTimestamp(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function computeDuration(startedAt: string, completedAt?: string): string {
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const durationMs = end - start;

  if (durationMs < 1000) return `${durationMs}ms`;
  if (durationMs < 60000) return `${(durationMs / 1000).toFixed(1)}s`;
  const minutes = Math.floor(durationMs / 60000);
  const seconds = Math.round((durationMs % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function computeDurationMs(startedAt: string, completedAt?: string): number {
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  return end - start;
}

function countCompletedSteps(execution: WorkflowExecution): string {
  const ctx = execution.context as Record<string, unknown> | undefined;
  const contextSteps = ctx?.steps;
  if (!contextSteps || typeof contextSteps !== 'object') return '0/0';
  const entries = Object.entries(contextSteps as Record<string, unknown>);
  const total = entries.length;
  const completed = entries.filter(
    ([, s]) => (s as Record<string, unknown>)?.status === 'completed',
  ).length;
  return `${completed}/${total}`;
}

/** Compute percentile from a sorted array of numbers */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

// =============================================================================
// KPI BAR
// =============================================================================

function KpiSummaryBar({ executions }: { executions: WorkflowExecution[] }) {
  const stats = useMemo(() => {
    const total = executions.length;
    const inProgress = executions.filter(
      (e) => e.status === 'running' || e.status === 'waiting_human',
    ).length;
    const failed = executions.filter((e) => e.status === 'failed').length;
    const failureRate = total > 0 ? ((failed / total) * 100).toFixed(1) : '0';

    // Duration percentiles from completed executions
    const completedDurations = executions
      .filter((e) => e.completedAt)
      .map((e) => computeDurationMs(e.startedAt, e.completedAt))
      .sort((a, b) => a - b);

    const p90 = percentile(completedDurations, 90);
    const p99 = percentile(completedDurations, 99);

    return { total, inProgress, failureRate, p90, p99 };
  }, [executions]);

  return (
    <div className="grid grid-cols-4 gap-3" data-testid="monitor-kpi-bar">
      <MetricCard label="Total Runs" value={stats.total} icon={<BarChart3 className="w-4 h-4" />} />
      <MetricCard
        label="In Progress"
        value={stats.inProgress}
        icon={<Activity className="w-4 h-4" />}
      />
      <MetricCard
        label="Response Time"
        value={`P90: ${formatMs(stats.p90)}`}
        context={`P99: ${formatMs(stats.p99)}`}
        icon={<TrendingUp className="w-4 h-4" />}
      />
      <MetricCard
        label="Failure Rate"
        value={`${stats.failureRate}%`}
        icon={<XCircle className="w-4 h-4" />}
      />
    </div>
  );
}

// =============================================================================
// PROPS
// =============================================================================

interface WorkflowMonitorTabProps {
  projectId: string;
  workflowId: string;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function WorkflowMonitorTab({ projectId, workflowId }: WorkflowMonitorTabProps) {
  const t = useTranslations('workflows.monitor');
  const { executions, isLoading, error } = useWorkflowExecutions(projectId, workflowId);
  const executionFilter = useWorkflowStore((s) => s.executionFilter);
  const setExecutionFilter = useWorkflowStore((s) => s.setExecutionFilter);
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(null);
  const [jsonPanelOpen, setJsonPanelOpen] = useState(false);

  const translatedFilterOptions = useMemo(
    () =>
      FILTER_OPTIONS.map((opt) => ({
        ...opt,
        label: t(
          `filter_${opt.value}` as
            | 'filter_all'
            | 'filter_running'
            | 'filter_completed'
            | 'filter_failed'
            | 'filter_waiting_human'
            | 'filter_waiting_approval'
            | 'filter_waiting_callback'
            | 'filter_cancelled'
            | 'filter_rejected',
        ),
      })),
    [t],
  );

  const translatedStatusLabels: Record<string, string> = {
    running: t('status.running'),
    completed: t('status.completed'),
    failed: t('status.failed'),
    waiting_human: t('status.waiting_human'),
    waiting_approval: t('status.waiting_approval'),
    waiting_callback: t('status.waiting_callback'),
    cancelled: t('status.cancelled'),
    rejected: t('status.rejected'),
  };

  const filteredExecutions = useMemo(() => {
    if (executionFilter === 'all') return executions;
    return executions.filter((e) => e.status === executionFilter);
  }, [executions, executionFilter]);

  const selectedExecution = useMemo(
    () => executions.find((e) => e.id === selectedExecutionId) ?? null,
    [executions, selectedExecutionId],
  );

  const handleRowClick = useCallback((executionId: string) => {
    setSelectedExecutionId((prev) => (prev === executionId ? null : executionId));
  }, []);

  const handleSliderClose = useCallback(() => {
    setSelectedExecutionId(null);
    setJsonPanelOpen(false);
  }, []);

  if (isLoading && executions.length === 0) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 text-muted animate-spin" />
      </div>
    );
  }

  if (error && executions.length === 0) {
    return (
      <EmptyState
        icon={<AlertTriangle className="w-6 h-6" />}
        title="Failed to load executions"
        description={error}
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* KPI Summary Bar */}
      {executions.length > 0 && <KpiSummaryBar executions={executions} />}

      {/* Header with filter */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">Execution History</h2>

        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-muted" />
          <select
            data-testid="monitor-status-filter"
            value={executionFilter}
            onChange={(e) => setExecutionFilter(e.target.value as ExecutionFilter)}
            className={clsx(
              'text-sm px-2 py-1 rounded-md',
              'bg-background border border-default text-foreground',
              'focus:outline-none focus:border-border-focus',
              'transition-default',
            )}
          >
            {translatedFilterOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Table header — widths mirror the body row exactly, including a
          trailing spacer matching the ChevronRight (w-4) so every column
          aligns regardless of how long the execution IDs are. */}
      {filteredExecutions.length > 0 && (
        <div className="flex items-center gap-4 px-4 py-2 text-xs font-medium text-muted uppercase tracking-wider">
          <div className="w-32 shrink-0">ID</div>
          <div className="w-36 shrink-0">Status</div>
          <div className="w-28 shrink-0">Trigger</div>
          <div className="flex-1 min-w-0">Started</div>
          <div className="w-24 shrink-0 text-right">Duration</div>
          <div className="w-20 shrink-0 text-right">Steps</div>
          <div className="w-4 shrink-0" aria-hidden="true" />
        </div>
      )}

      {/* Execution rows */}
      {filteredExecutions.length > 0 ? (
        <div className="space-y-2">
          {filteredExecutions.map((execution) => {
            const statusConfig =
              EXECUTION_STATUS_CONFIG[execution.status] ?? EXECUTION_STATUS_CONFIG.cancelled;
            const triggerBadge = getTriggerBadge(execution);
            const isSelected = execution.id === selectedExecutionId;

            return (
              <button
                key={execution.id}
                type="button"
                data-testid={`monitor-execution-row-${execution.id.slice(0, 8)}`}
                onClick={() => handleRowClick(execution.id)}
                className={clsx(
                  'w-full flex items-center gap-4 px-4 py-3 text-left transition-colors rounded-lg border',
                  'bg-background-elevated hover:bg-background-muted',
                  isSelected ? 'border-accent ring-1 ring-accent/20' : 'border-default',
                )}
              >
                <div className="min-w-0 w-32 shrink-0">
                  <span className="text-xs font-mono text-muted truncate block">
                    {execution.id.slice(0, 8)}
                  </span>
                </div>
                <div className="w-36 shrink-0">
                  <Badge variant={statusConfig.variant} dot>
                    {translatedStatusLabels[execution.status] ?? statusConfig.label}
                  </Badge>
                </div>
                <div className="w-28 shrink-0 min-w-0">
                  <Badge
                    variant={triggerBadge.variant}
                    testid={`monitor-trigger-badge-${execution.id.slice(0, 8)}`}
                    className="truncate max-w-full"
                  >
                    {triggerBadge.label}
                  </Badge>
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-xs text-muted">{formatTimestamp(execution.startedAt)}</span>
                </div>
                <div className="w-24 shrink-0 text-right">
                  <span className="text-xs font-mono text-muted">
                    {computeDuration(execution.startedAt, execution.completedAt)}
                  </span>
                </div>
                <div className="w-20 shrink-0 text-right">
                  <span className="text-xs text-muted">{countCompletedSteps(execution)}</span>
                </div>
                <ChevronRight className="w-4 h-4 shrink-0 text-subtle" aria-hidden="true" />
              </button>
            );
          })}
        </div>
      ) : (
        <EmptyState
          icon={<Activity className="w-6 h-6" />}
          title={executionFilter === 'all' ? 'No executions yet' : 'No matching executions'}
          description={
            executionFilter === 'all'
              ? 'Run this workflow to see execution history here.'
              : `No executions with status "${executionFilter}" found.`
          }
        />
      )}

      {/* Live polling indicator */}
      {executions.some((e) => e.status === 'running' || e.status === 'waiting_human') && (
        <div className="flex items-center justify-center gap-2 py-2">
          <div className="w-2 h-2 rounded-full bg-accent animate-pulse" />
          <span className="text-xs text-muted">Live updates every 5 seconds</span>
        </div>
      )}

      {/* Slider with Debug Panel */}
      <SlidePanel
        open={selectedExecution !== null}
        onClose={handleSliderClose}
        width={jsonPanelOpen ? '4xl' : 'lg'}
        noPadding
      >
        {selectedExecution && (
          <WorkflowDebugPanel
            execution={selectedExecution}
            mode="monitor"
            onClose={handleSliderClose}
            onRawJsonToggle={setJsonPanelOpen}
          />
        )}
      </SlidePanel>
    </div>
  );
}
