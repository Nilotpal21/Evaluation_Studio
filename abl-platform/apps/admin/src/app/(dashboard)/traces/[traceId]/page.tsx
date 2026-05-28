'use client';

import { useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, AlertTriangle } from 'lucide-react';
import { useApi } from '../../../../hooks/use-swr-fetch';
import {
  PageHeader,
  MetricCard,
  EmptyState,
  SkeletonCard,
  SkeletonTable,
  DataTable,
  Tabs,
  StatusBadge,
  formatMs,
  formatDateTime,
  formatNumber,
  type Column,
} from '@agent-platform/admin-ui';
import { traceEventIntent, getBadgeIntentStyles } from '@agent-platform/design-tokens';
import type {
  TraceDetailResponse,
  TraceTimelineEvent,
  TracePerformanceResponse,
  STIPathEntry,
  TraceCostResponse,
  LLMCallEntry,
} from '../../../../types/api';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function truncateId(id: string, maxLen = 16): string {
  if (!id) return '--';
  if (id.length <= maxLen) return id;
  return `${id.slice(0, maxLen)}...`;
}

function formatCost(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

// ─── Event Type Badge Colors ─────────────────────────────────────────────────

function getEventTypeColor(eventType: string): string {
  return getBadgeIntentStyles(traceEventIntent(eventType)).badge;
}

// ─── Timeline Tab ─────────────────────────────────────────────────────────────

function TimelineTab({ events }: { events: TraceTimelineEvent[] }) {
  const columns: Column<TraceTimelineEvent>[] = useMemo(
    () => [
      {
        key: 'timestamp',
        header: 'Time',
        render: (row) => (
          <span className="text-foreground-muted font-mono text-xs">
            {formatDateTime(row.timestamp)}
          </span>
        ),
        width: '180px',
      },
      {
        key: 'eventType',
        header: 'Event Type',
        render: (row) => (
          <span
            className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${getEventTypeColor(row.eventType)}`}
          >
            {row.eventType}
          </span>
        ),
        width: '160px',
      },
      {
        key: 'agentName',
        header: 'Agent',
        render: (row) => <span className="text-sm text-foreground">{row.agentName || '--'}</span>,
      },
      {
        key: 'durationMs',
        header: 'Duration',
        render: (row) => (
          <span className="text-sm font-mono text-foreground">
            {row.durationMs > 0 ? formatMs(row.durationMs) : '--'}
          </span>
        ),
        width: '100px',
        sortable: true,
        sortFn: (a, b) => a.durationMs - b.durationMs,
      },
      {
        key: 'channel',
        header: 'Channel',
        render: (row) => (
          <span className="text-sm text-foreground-muted">{row.channel || '--'}</span>
        ),
        width: '100px',
      },
      {
        key: 'hasError',
        header: 'Error',
        render: (row) =>
          row.hasError ? (
            <span className="inline-flex items-center gap-1 text-error">
              <AlertTriangle size={12} />
              <span className="text-xs">{row.errorType || 'Error'}</span>
            </span>
          ) : (
            <span className="text-foreground-muted text-xs">--</span>
          ),
        width: '120px',
      },
    ],
    [],
  );

  if (events.length === 0) {
    return (
      <EmptyState
        title="No timeline events"
        description="No events have been recorded for this trace."
      />
    );
  }

  return (
    <DataTable
      columns={columns}
      data={events}
      rowKey={(row) => row.eventId}
      pageSize={50}
      emptyMessage="No events found"
    />
  );
}

// ─── Performance Tab ──────────────────────────────────────────────────────────

function PerformanceTab({ traceId }: { traceId: string }) {
  const { data, loading, error, refetch } = useApi<TracePerformanceResponse>(
    `/api/traces/${encodeURIComponent(traceId)}/performance`,
  );

  const columns: Column<STIPathEntry>[] = useMemo(
    () => [
      {
        key: 'stiPath',
        header: 'STI Path',
        render: (row) => (
          <span className="text-sm font-mono text-foreground" title={row.stiPath}>
            {row.stiPath.length > 40 ? `${row.stiPath.slice(0, 40)}...` : row.stiPath}
          </span>
        ),
      },
      {
        key: 'durationMs',
        header: 'Duration',
        render: (row) => (
          <span className="text-sm font-mono text-foreground">{formatMs(row.durationMs)}</span>
        ),
        width: '100px',
        sortable: true,
        sortFn: (a, b) => a.durationMs - b.durationMs,
      },
      {
        key: 'totalTokens',
        header: 'Tokens',
        render: (row) => (
          <span className="text-sm text-foreground-muted">
            {row.totalTokens > 0 ? formatNumber(row.totalTokens) : '--'}
          </span>
        ),
        width: '100px',
      },
      {
        key: 'modelId',
        header: 'Model',
        render: (row) => (
          <span className="text-xs text-foreground-muted font-mono">{row.modelId || '--'}</span>
        ),
        width: '160px',
      },
      {
        key: 'toolName',
        header: 'Tool',
        render: (row) => (
          <span className="text-sm text-foreground-muted">{row.toolName || '--'}</span>
        ),
        width: '140px',
      },
      {
        key: 'hasError',
        header: 'Error',
        render: (row) =>
          row.hasError ? (
            <span className="inline-flex items-center gap-1 text-error">
              <AlertTriangle size={12} />
              <span className="text-xs">{row.errorType || 'Error'}</span>
            </span>
          ) : (
            <span className="text-foreground-muted text-xs">--</span>
          ),
        width: '120px',
      },
    ],
    [],
  );

  if (loading && !data) {
    return <SkeletonTable rows={5} />;
  }

  if (error && !data) {
    return (
      <EmptyState
        title="Failed to load performance data"
        description={error}
        action={
          <button
            onClick={refetch}
            className="px-4 py-2 bg-accent text-accent-foreground rounded-[var(--radius-md)] text-sm hover:opacity-90 transition-colors"
          >
            Retry
          </button>
        }
      />
    );
  }

  const paths = data?.paths ?? [];
  const totals = data?.totals;

  return (
    <div className="space-y-6">
      {/* Performance Totals */}
      {totals && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="rounded-lg border border-border bg-background-subtle p-4">
            <p className="text-xs text-foreground-muted">Total Duration</p>
            <p className="text-lg font-bold text-foreground mt-1">
              {formatMs(totals.totalDurationMs)}
            </p>
          </div>
          <div className="rounded-lg border border-border bg-background-subtle p-4">
            <p className="text-xs text-foreground-muted">Total Tokens</p>
            <p className="text-lg font-bold text-foreground mt-1">
              {formatNumber(totals.totalTokens)}
            </p>
          </div>
          <div className="rounded-lg border border-border bg-background-subtle p-4">
            <p className="text-xs text-foreground-muted">Total Paths</p>
            <p className="text-lg font-bold text-foreground mt-1">{totals.totalPaths}</p>
          </div>
          <div className="rounded-lg border border-border bg-background-subtle p-4">
            <p className="text-xs text-foreground-muted">Error Paths</p>
            <p className="text-lg font-bold text-foreground mt-1">
              {totals.errorPaths > 0 ? (
                <span className="text-error">{totals.errorPaths}</span>
              ) : (
                '0'
              )}
            </p>
          </div>
        </div>
      )}

      {/* Model Breakdown */}
      {totals?.modelBreakdown && totals.modelBreakdown.length > 0 && (
        <div className="rounded-lg border border-border bg-background-subtle p-5">
          <h3 className="text-sm font-medium text-foreground-muted mb-3">Model Breakdown</h3>
          <div className="space-y-2">
            {totals.modelBreakdown.map((entry) => (
              <div key={entry.modelId} className="flex items-center justify-between text-sm">
                <span className="font-mono text-foreground">{entry.modelId}</span>
                <div className="flex items-center gap-4">
                  <span className="text-foreground-muted">{formatNumber(entry.tokens)} tokens</span>
                  <span className="text-foreground-muted">{entry.count} calls</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Paths Table */}
      {paths.length > 0 ? (
        <DataTable
          columns={columns}
          data={paths}
          rowKey={(row) => row.spanId}
          pageSize={50}
          emptyMessage="No STI paths found"
        />
      ) : (
        <EmptyState
          title="No performance paths"
          description="No STI path data available for this trace."
        />
      )}
    </div>
  );
}

// ─── Cost Tab ─────────────────────────────────────────────────────────────────

function CostTab({ traceId }: { traceId: string }) {
  const { data, loading, error, refetch } = useApi<TraceCostResponse>(
    `/api/traces/${encodeURIComponent(traceId)}/cost`,
  );

  const columns: Column<LLMCallEntry>[] = useMemo(
    () => [
      {
        key: 'timestamp',
        header: 'Time',
        render: (row) => (
          <span className="text-foreground-muted font-mono text-xs">
            {formatDateTime(row.timestamp)}
          </span>
        ),
        width: '180px',
      },
      {
        key: 'modelId',
        header: 'Model',
        render: (row) => <span className="text-sm font-mono text-foreground">{row.modelId}</span>,
      },
      {
        key: 'provider',
        header: 'Provider',
        render: (row) => (
          <span className="text-sm text-foreground-muted">{row.provider || '--'}</span>
        ),
        width: '120px',
      },
      {
        key: 'totalTokens',
        header: 'Tokens',
        render: (row) => (
          <div className="text-sm">
            <span className="text-foreground">{formatNumber(row.totalTokens)}</span>
            <span className="text-foreground-muted text-xs ml-1">
              ({formatNumber(row.inputTokens)} in / {formatNumber(row.outputTokens)} out)
            </span>
          </div>
        ),
        width: '200px',
      },
      {
        key: 'estimatedCost',
        header: 'Cost',
        render: (row) => (
          <span className="text-sm font-medium text-foreground">
            {formatCost(row.estimatedCost)}
          </span>
        ),
        width: '100px',
        sortable: true,
        sortFn: (a, b) => a.estimatedCost - b.estimatedCost,
      },
      {
        key: 'latencyMs',
        header: 'Latency',
        render: (row) => (
          <span className="text-sm font-mono text-foreground-muted">
            {row.latencyMs > 0 ? formatMs(row.latencyMs) : '--'}
          </span>
        ),
        width: '100px',
      },
      {
        key: 'success',
        header: 'Status',
        render: (row) =>
          row.success ? (
            <StatusBadge status="healthy" label="OK" />
          ) : (
            <StatusBadge status="down" label="Failed" />
          ),
        width: '100px',
      },
    ],
    [],
  );

  if (loading && !data) {
    return <SkeletonTable rows={5} />;
  }

  if (error && !data) {
    return (
      <EmptyState
        title="Failed to load cost data"
        description={error}
        action={
          <button
            onClick={refetch}
            className="px-4 py-2 bg-accent text-accent-foreground rounded-[var(--radius-md)] text-sm hover:opacity-90 transition-colors"
          >
            Retry
          </button>
        }
      />
    );
  }

  const calls = data?.calls ?? [];
  const totals = data?.totals;

  return (
    <div className="space-y-6">
      {/* Cost Totals */}
      {totals && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="rounded-lg border border-border bg-background-subtle p-4">
            <p className="text-xs text-foreground-muted">Total Cost</p>
            <p className="text-lg font-bold text-foreground mt-1">{formatCost(totals.totalCost)}</p>
          </div>
          <div className="rounded-lg border border-border bg-background-subtle p-4">
            <p className="text-xs text-foreground-muted">Total Tokens</p>
            <p className="text-lg font-bold text-foreground mt-1">
              {formatNumber(totals.totalTokens)}
            </p>
          </div>
          <div className="rounded-lg border border-border bg-background-subtle p-4">
            <p className="text-xs text-foreground-muted">LLM Calls</p>
            <p className="text-lg font-bold text-foreground mt-1">{totals.callCount}</p>
          </div>
        </div>
      )}

      {/* Per-Model Cost Breakdown */}
      {totals?.byModel && totals.byModel.length > 0 && (
        <div className="rounded-lg border border-border bg-background-subtle p-5">
          <h3 className="text-sm font-medium text-foreground-muted mb-3">Cost by Model</h3>
          <div className="space-y-2">
            {totals.byModel.map((entry) => (
              <div key={entry.model} className="flex items-center justify-between text-sm">
                <span className="font-mono text-foreground">{entry.model}</span>
                <div className="flex items-center gap-4">
                  <span className="text-foreground-muted">{formatNumber(entry.tokens)} tokens</span>
                  <span className="text-foreground-muted">{entry.count} calls</span>
                  <span className="font-medium text-foreground">{formatCost(entry.cost)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* LLM Calls Table */}
      {calls.length > 0 ? (
        <DataTable
          columns={columns}
          data={calls}
          rowKey={(row) => `${row.timestamp}-${row.modelId}`}
          pageSize={50}
          emptyMessage="No LLM calls found"
        />
      ) : (
        <EmptyState title="No LLM calls" description="No LLM call data available for this trace." />
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function TraceDetailPage() {
  const params = useParams();
  const router = useRouter();
  const traceId = params.traceId as string;

  const { data, loading, error, refetch } = useApi<TraceDetailResponse>(
    `/api/traces/${encodeURIComponent(traceId)}`,
  );

  // ─── Loading State ──────────────────────────────────────────────────────────

  if (loading && !data) {
    return (
      <div>
        <div className="mb-6">
          <button
            type="button"
            onClick={() => router.push('/traces')}
            className="flex items-center gap-1.5 text-sm text-foreground-muted hover:text-foreground transition-colors mb-4"
          >
            <ArrowLeft size={16} />
            Back to Traces
          </button>
          <PageHeader title="Trace Detail" description="Loading..." />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </div>
    );
  }

  // ─── Error State ────────────────────────────────────────────────────────────

  if (error && !data) {
    return (
      <div>
        <div className="mb-6">
          <button
            type="button"
            onClick={() => router.push('/traces')}
            className="flex items-center gap-1.5 text-sm text-foreground-muted hover:text-foreground transition-colors mb-4"
          >
            <ArrowLeft size={16} />
            Back to Traces
          </button>
          <PageHeader title="Trace Detail" description={`Trace ${traceId}`} />
        </div>
        <EmptyState
          title="Failed to load trace"
          description={error}
          action={
            <button
              onClick={refetch}
              className="px-4 py-2 bg-accent text-accent-foreground rounded-[var(--radius-md)] text-sm hover:opacity-90 transition-colors"
            >
              Retry
            </button>
          }
        />
      </div>
    );
  }

  if (!data?.trace) return null;

  const trace = data.trace;
  const timeline = data.timeline ?? [];

  const tabs = [
    {
      id: 'timeline',
      label: `Timeline (${timeline.length})`,
      content: <TimelineTab events={timeline} />,
    },
    {
      id: 'performance',
      label: 'Performance',
      content: <PerformanceTab traceId={traceId} />,
    },
    {
      id: 'cost',
      label: 'Cost',
      content: <CostTab traceId={traceId} />,
    },
  ];

  return (
    <div>
      {/* Back Navigation */}
      <div className="mb-6">
        <button
          type="button"
          onClick={() => router.push('/traces')}
          className="flex items-center gap-1.5 text-sm text-foreground-muted hover:text-foreground transition-colors mb-4"
        >
          <ArrowLeft size={16} />
          Back to Traces
        </button>
        <PageHeader title="Trace Detail" description={`Trace ${truncateId(traceId, 24)}`} />
      </div>

      {/* Trace Summary Header */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
        <div className="rounded-lg border border-border bg-background-subtle p-5">
          <h3 className="text-sm font-medium text-foreground-muted mb-3">Trace Info</h3>
          <dl className="space-y-3">
            <div className="flex justify-between">
              <dt className="text-sm text-foreground-muted">Trace ID</dt>
              <dd className="text-sm font-mono text-foreground" title={trace.traceId}>
                {truncateId(trace.traceId, 24)}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-sm text-foreground-muted">Tenant</dt>
              <dd className="text-sm text-foreground">
                {trace.tenantName || truncateId(trace.tenantId)}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-sm text-foreground-muted">Project ID</dt>
              <dd className="text-sm font-mono text-foreground">{truncateId(trace.projectId)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-sm text-foreground-muted">Session ID</dt>
              <dd className="text-sm font-mono text-foreground">{truncateId(trace.sessionId)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-sm text-foreground-muted">Channel</dt>
              <dd className="text-sm text-foreground">{trace.channel || '--'}</dd>
            </div>
          </dl>
        </div>

        <div className="rounded-lg border border-border bg-background-subtle p-5">
          <h3 className="text-sm font-medium text-foreground-muted mb-3">Metrics</h3>
          <dl className="space-y-3">
            <div className="flex justify-between">
              <dt className="text-sm text-foreground-muted">Started</dt>
              <dd className="text-sm text-foreground">{formatDateTime(trace.startedAt)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-sm text-foreground-muted">Ended</dt>
              <dd className="text-sm text-foreground">
                {trace.endedAt ? formatDateTime(trace.endedAt) : '--'}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-sm text-foreground-muted">Duration</dt>
              <dd className="text-sm font-mono font-medium text-foreground">
                {formatMs(trace.totalDurationMs)}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-sm text-foreground-muted">Events</dt>
              <dd className="text-sm text-foreground">{trace.totalEvents}</dd>
            </div>
            <div className="flex justify-between items-center">
              <dt className="text-sm text-foreground-muted">Errors</dt>
              <dd>
                {trace.errorCount > 0 ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-error-subtle border border-error px-2.5 py-0.5 text-xs font-medium text-error">
                    <AlertTriangle size={10} />
                    {trace.errorCount} errors
                  </span>
                ) : (
                  <StatusBadge status="healthy" label="No errors" />
                )}
              </dd>
            </div>
          </dl>
        </div>
      </div>

      {/* Tabs */}
      <Tabs tabs={tabs} defaultValue="timeline" />
    </div>
  );
}
