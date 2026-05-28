'use client';

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, AlertTriangle, Clock, Search, ChevronLeft, ChevronRight } from 'lucide-react';
import { useApi } from '../../../hooks/use-swr-fetch';
import {
  PageHeader,
  MetricCard,
  EmptyState,
  SkeletonCard,
  DateRangePicker,
  formatMs,
  formatDateTime,
} from '@agent-platform/admin-ui';
import type { TraceSearchResponse, TraceSummary } from '../../../types/api';

// ─── Constants ────────────────────────────────────────────────────────────────

const PAGE_SIZE = 25;

const CHANNEL_OPTIONS = [
  { label: 'All Channels', value: '' },
  { label: 'web', value: 'web' },
  { label: 'api', value: 'api' },
  { label: 'voice', value: 'voice' },
  { label: 'chat', value: 'chat' },
  { label: 'sms', value: 'sms' },
  { label: 'email', value: 'email' },
];

const inputClass =
  'h-9 rounded-md border border-border bg-background-subtle px-3 text-sm text-foreground placeholder:text-foreground-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent';

const selectClass =
  'h-9 rounded-md border border-border bg-background-subtle px-3 text-sm text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function truncateId(id: string, maxLen = 12): string {
  if (id.length <= maxLen) return id;
  return `${id.slice(0, maxLen)}...`;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function TracesPage() {
  const router = useRouter();

  const [dateRange, setDateRange] = useState<{ from: string; to: string }>(() => {
    const now = new Date();
    const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    return { from: from.toISOString(), to: now.toISOString() };
  });

  const [tenantFilter, setTenantFilter] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [channelFilter, setChannelFilter] = useState('');
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [minDuration, setMinDuration] = useState('');
  const [offset, setOffset] = useState(0);

  const apiUrl = useMemo(() => {
    const params = new URLSearchParams({
      from: dateRange.from,
      to: dateRange.to,
      limit: String(PAGE_SIZE),
      offset: String(offset),
    });
    if (tenantFilter.trim()) params.set('tenantId', tenantFilter.trim());
    if (agentFilter.trim()) params.set('agentName', agentFilter.trim());
    if (channelFilter) params.set('channel', channelFilter);
    if (errorsOnly) params.set('hasError', 'true');
    if (minDuration && Number(minDuration) > 0) params.set('minDurationMs', minDuration);
    return `/api/traces?${params.toString()}`;
  }, [dateRange, tenantFilter, agentFilter, channelFilter, errorsOnly, minDuration, offset]);

  const { data, loading, error, refetch } = useApi<TraceSearchResponse>(apiUrl);

  const traces = data?.traces ?? [];
  const hasMore = data?.pagination?.hasMore ?? false;

  // Compute summary metrics from current page
  const summaryMetrics = useMemo(() => {
    const total = traces.length;
    const withErrors = traces.filter((t) => t.errorCount > 0).length;
    const avgDuration =
      total > 0 ? traces.reduce((sum, t) => sum + t.totalDurationMs, 0) / total : 0;
    return { total, withErrors, avgDuration };
  }, [traces]);

  function handleSearch() {
    setOffset(0);
    refetch();
  }

  function handleRowClick(trace: TraceSummary) {
    router.push(`/traces/${encodeURIComponent(trace.traceId)}`);
  }

  // ─── Loading State ──────────────────────────────────────────────────────────

  if (loading && !data) {
    return (
      <div>
        <PageHeader title="Trace Inspector" description="Cross-tenant trace search and analysis" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-6">
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
        <PageHeader title="Trace Inspector" description="Cross-tenant trace search and analysis" />
        <EmptyState
          title="Failed to load traces"
          description={error}
          action={
            <button
              onClick={() => refetch()}
              className="px-4 py-2 bg-accent text-accent-foreground rounded-[var(--radius-md)] text-sm btn-press"
            >
              Retry
            </button>
          }
        />
      </div>
    );
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div>
      <PageHeader
        title="Trace Inspector"
        description="Cross-tenant trace search and analysis"
        actions={<DateRangePicker onChange={setDateRange} defaultRange="24h" />}
      />

      {/* Search Filters */}
      <div className="rounded-lg border border-border bg-background-subtle p-4 mt-6">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs font-medium text-foreground-muted mb-1">
              Tenant ID
            </label>
            <input
              type="text"
              value={tenantFilter}
              onChange={(e) => setTenantFilter(e.target.value)}
              placeholder="Filter by tenant..."
              className={`${inputClass} w-48`}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-foreground-muted mb-1">
              Agent Name
            </label>
            <input
              type="text"
              value={agentFilter}
              onChange={(e) => setAgentFilter(e.target.value)}
              placeholder="Filter by agent..."
              className={`${inputClass} w-48`}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-foreground-muted mb-1">Channel</label>
            <select
              value={channelFilter}
              onChange={(e) => setChannelFilter(e.target.value)}
              className={`${selectClass} w-36`}
            >
              {CHANNEL_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-foreground-muted mb-1">
              Min Duration (ms)
            </label>
            <input
              type="number"
              value={minDuration}
              onChange={(e) => setMinDuration(e.target.value)}
              placeholder="0"
              min="0"
              className={`${inputClass} w-32`}
            />
          </div>
          <div className="flex items-center gap-2 pb-0.5">
            <input
              type="checkbox"
              id="errors-only"
              checked={errorsOnly}
              onChange={(e) => setErrorsOnly(e.target.checked)}
              className="h-4 w-4 rounded border-border bg-background-subtle text-accent focus:ring-accent"
            />
            <label htmlFor="errors-only" className="text-sm text-foreground-muted">
              Errors only
            </label>
          </div>
          <button
            type="button"
            onClick={handleSearch}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:opacity-90 transition-colors"
          >
            <Search size={14} />
            Search
          </button>
        </div>
      </div>

      {/* Summary Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-6">
        <MetricCard
          title="Traces Found"
          value={summaryMetrics.total}
          icon={<Activity size={20} />}
          description={hasMore ? 'more results available' : 'in current page'}
        />
        <MetricCard
          title="With Errors"
          value={summaryMetrics.withErrors}
          icon={<AlertTriangle size={20} />}
        />
        <MetricCard
          title="Avg Duration"
          value={summaryMetrics.total > 0 ? formatMs(summaryMetrics.avgDuration) : '--'}
          icon={<Clock size={20} />}
        />
      </div>

      {/* Results Table */}
      <div className="mt-6 overflow-hidden rounded-lg border border-border bg-background-subtle">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-foreground-muted">
                  Trace ID
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-foreground-muted">
                  Tenant
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-foreground-muted">
                  Agent
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-foreground-muted">
                  Channel
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-foreground-muted">
                  Started At
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-foreground-muted">
                  Duration
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-foreground-muted">
                  Events
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-foreground-muted">
                  Errors
                </th>
              </tr>
            </thead>
            <tbody>
              {loading &&
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={`skeleton-${i}`} className="border-b border-border last:border-b-0">
                    {Array.from({ length: 8 }).map((_, j) => (
                      <td key={j} className="px-4 py-3">
                        <div className="h-4 w-3/4 animate-pulse rounded-md bg-background-muted" />
                      </td>
                    ))}
                  </tr>
                ))}
              {!loading && traces.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-sm text-foreground-muted">
                    No traces found matching your filters.
                  </td>
                </tr>
              )}
              {!loading &&
                traces.map((trace) => (
                  <tr
                    key={trace.traceId}
                    onClick={() => handleRowClick(trace)}
                    className="border-b border-border last:border-b-0 cursor-pointer transition-colors duration-150 hover:bg-background-elevated"
                  >
                    <td className="px-4 py-3 text-sm">
                      <span className="font-mono text-accent" title={trace.traceId}>
                        {truncateId(trace.traceId)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-foreground">
                      {trace.tenantName || truncateId(trace.tenantId)}
                    </td>
                    <td className="px-4 py-3 text-sm text-foreground">{trace.agentName || '--'}</td>
                    <td className="px-4 py-3 text-sm">
                      {trace.channel ? (
                        <span className="inline-flex items-center rounded-full border border-border px-2.5 py-0.5 text-xs font-medium text-foreground">
                          {trace.channel}
                        </span>
                      ) : (
                        <span className="text-foreground-muted">--</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-foreground-muted">
                      {formatDateTime(trace.startedAt)}
                    </td>
                    <td className="px-4 py-3 text-sm font-mono text-foreground">
                      {formatMs(trace.totalDurationMs)}
                    </td>
                    <td className="px-4 py-3 text-sm text-foreground-muted">{trace.eventCount}</td>
                    <td className="px-4 py-3 text-sm">
                      {trace.errorCount > 0 ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-error-subtle border border-error px-2.5 py-0.5 text-xs font-medium text-error">
                          {trace.errorCount}
                        </span>
                      ) : (
                        <span className="text-foreground-muted">0</span>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>

        {/* Pagination Footer */}
        {!loading && traces.length > 0 && (
          <div className="flex items-center justify-between border-t border-border px-4 py-3">
            <span className="text-sm text-foreground-muted">
              Showing {offset + 1}-{offset + traces.length}
              {hasMore ? '+' : ''}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
                disabled={offset === 0}
                className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm text-foreground-muted hover:bg-background-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <ChevronLeft className="h-4 w-4" />
                Previous
              </button>
              <button
                type="button"
                onClick={() => setOffset((o) => o + PAGE_SIZE)}
                disabled={!hasMore}
                className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm text-foreground-muted hover:bg-background-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
              >
                Next
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
