'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Activity, MessageSquare, Users, Zap } from 'lucide-react';
import { useApi } from '../../../hooks/use-swr-fetch';
import {
  PageHeader,
  EmptyState,
  MetricCard,
  SkeletonCard,
  ChartCard,
  ChartTooltip,
  CHART_COLORS,
  GRADIENT_DEFS,
  DateRangePicker,
} from '@agent-platform/admin-ui';
import type {
  BillingUsagePlatformPublicationVisibilityResponse,
  UsageResponse,
} from '../../../types/api';
import { buildTenantUsageDetailHref } from '../../../lib/tenant-detail-tabs';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';

const PIE_COLORS = [
  CHART_COLORS.accent,
  CHART_COLORS.purple,
  CHART_COLORS.success,
  CHART_COLORS.warning,
  CHART_COLORS.error,
  CHART_COLORS.info,
  CHART_COLORS.muted,
];

const ZERO_METRICS = {
  examinedSessionCount: 0,
  includedSessionCount: 0,
  excludedSessionCount: 0,
  durationSeconds: 0,
  userMessageCount: 0,
  assistantMessageCount: 0,
  toolMessageCount: 0,
  interactiveTurnCount: 0,
  engagedSeconds: 0,
  llmCallCount: 0,
  toolCallCount: 0,
  baseUnits: 0,
  llmAddonUnits: 0,
  toolAddonUnits: 0,
  totalUnits: 0,
};

function formatCompactNumber(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

function formatWindowLabel(value: string): string {
  const date = new Date(value);
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
}

function formatDateTime(value: string | null): string {
  if (!value) return 'Not yet';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export default function UsageAnalyticsPage() {
  const [dateRange, setDateRange] = useState<{ from: string; to: string }>(() => {
    const now = new Date();
    const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    return { from: from.toISOString(), to: now.toISOString() };
  });

  const apiUrl = useMemo(() => {
    const params = new URLSearchParams({
      windowStart: dateRange.from,
      windowEnd: dateRange.to,
      granularity: 'day',
    });
    return `/api/usage?${params.toString()}`;
  }, [dateRange]);
  const publicationStatusUrl = useMemo(() => '/api/usage/publication-status?limit=10', []);

  const { data, loading, error, refetch } = useApi<UsageResponse>(apiUrl);
  const {
    data: publicationStatus,
    loading: publicationLoading,
    error: publicationError,
  } = useApi<BillingUsagePlatformPublicationVisibilityResponse>(publicationStatusUrl);

  if (loading && !data) {
    return (
      <div>
        <PageHeader
          title="Usage & Billing Units"
          description="Platform-wide billing-unit analytics from published usage reports"
        />
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mt-6">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <PageHeader
          title="Usage & Billing Units"
          description="Platform-wide billing-unit analytics from published usage reports"
        />
        <EmptyState
          title="Failed to load usage data"
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

  const totals = data?.totals ?? ZERO_METRICS;
  const windows = data?.windows ?? [];
  const topTenants = (data?.tenantBreakdown ?? []).slice(0, 10);
  const channelBreakdown = data?.channelBreakdown ?? [];
  const activeTenants = data?.tenantBreakdown.length ?? 0;
  const publicationSummary = publicationStatus?.visibility.summary ?? null;
  const publicationTenants = publicationStatus?.visibility.tenants ?? [];

  return (
    <div>
      <PageHeader
        title="Usage & Billing Units"
        description="Platform-wide billing-unit analytics from published usage reports"
        actions={<DateRangePicker onChange={setDateRange} defaultRange="7d" />}
      />

      <div className="rounded-lg border border-border bg-background-subtle p-5 space-y-4 mt-6">
        <div>
          <h3 className="text-sm font-medium text-foreground">Publication Visibility</h3>
          <p className="text-xs text-foreground-muted mt-1">
            Completed billing materialization batches do not reach platform reports until they are
            published into usage-report rows.
          </p>
        </div>

        {publicationError ? (
          <EmptyState title="Unable to load publication state" description={publicationError} />
        ) : publicationLoading && !publicationSummary ? (
          <div className="text-sm text-foreground-muted">Loading publication state…</div>
        ) : publicationSummary ? (
          <>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <MetricCard
                title="Pending Publication"
                value={publicationSummary.pendingPublicationCount.toLocaleString()}
              />
              <MetricCard
                title="Published Batches"
                value={publicationSummary.publishedBatchCount.toLocaleString()}
              />
              <MetricCard
                title="Last Materialized"
                value={publicationSummary.lastMaterializedAt ? 'Ready' : 'Never'}
                description={formatDateTime(publicationSummary.lastMaterializedAt)}
              />
              <MetricCard
                title="Last Published"
                value={publicationSummary.lastPublishedAt ? 'Visible' : 'Not yet'}
                description={formatDateTime(publicationSummary.lastPublishedAt)}
              />
            </div>

            {publicationTenants.length > 0 && (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-foreground-muted">
                      <th className="py-2 pr-3">Tenant</th>
                      <th className="py-2 pr-3">Pending</th>
                      <th className="py-2 pr-3">Published</th>
                      <th className="py-2 pr-3">Running</th>
                      <th className="py-2 pr-3">Failed</th>
                      <th className="py-2 pr-3">Last Materialized</th>
                      <th className="py-2">Last Published</th>
                    </tr>
                  </thead>
                  <tbody>
                    {publicationTenants.map((tenant) => (
                      <tr key={tenant.tenantId} className="border-b border-border/60 align-top">
                        <td className="py-3 pr-3">
                          <Link
                            href={buildTenantUsageDetailHref(tenant.tenantId)}
                            className="font-medium text-foreground hover:text-accent transition-colors"
                          >
                            {tenant.tenantName ?? tenant.tenantId}
                          </Link>
                          <div className="text-xs text-foreground-muted font-mono mt-1">
                            {tenant.tenantId}
                          </div>
                        </td>
                        <td className="py-3 pr-3 text-foreground">
                          {tenant.pendingPublicationCount.toLocaleString()}
                        </td>
                        <td className="py-3 pr-3 text-foreground-muted">
                          {tenant.publishedBatchCount.toLocaleString()}
                        </td>
                        <td className="py-3 pr-3 text-foreground-muted">
                          {tenant.runningBatchCount.toLocaleString()}
                        </td>
                        <td className="py-3 pr-3 text-foreground-muted">
                          {tenant.failedBatchCount.toLocaleString()}
                        </td>
                        <td className="py-3 pr-3 text-foreground-muted">
                          {formatDateTime(tenant.lastMaterializedAt)}
                        </td>
                        <td className="py-3 text-foreground-muted">
                          {formatDateTime(tenant.lastPublishedAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : (
          <EmptyState
            title="No materialization batches yet"
            description="No billing materialization batches have been created across the platform."
          />
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mt-6">
        <MetricCard
          title="Included Sessions"
          value={totals.includedSessionCount.toLocaleString()}
          icon={<MessageSquare size={20} />}
        />
        <MetricCard
          title="Billing Units"
          value={formatCompactNumber(totals.totalUnits)}
          icon={<Zap size={20} />}
        />
        <MetricCard
          title="LLM Calls"
          value={formatCompactNumber(totals.llmCallCount)}
          icon={<Activity size={20} />}
        />
        <MetricCard title="Active Tenants" value={activeTenants} icon={<Users size={20} />} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
        <ChartCard title="Daily Billing Units Trend" className="lg:col-span-2">
          <AreaChart data={windows}>
            {GRADIENT_DEFS}
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border,0 0% 14.9%))" />
            <XAxis
              dataKey="windowStart"
              stroke="hsl(var(--foreground-muted,0 0% 63.9%))"
              tick={{ fontSize: 12 }}
              tickFormatter={formatWindowLabel}
            />
            <YAxis
              stroke="hsl(var(--foreground-muted,0 0% 63.9%))"
              tick={{ fontSize: 12 }}
              tickFormatter={formatCompactNumber}
            />
            <Tooltip
              content={<ChartTooltip formatter={(value: number) => formatCompactNumber(value)} />}
            />
            <Area
              type="monotone"
              dataKey="totalUnits"
              name="Billing Units"
              stroke={CHART_COLORS.accent}
              fill="url(#gradAccent)"
              strokeWidth={2}
            />
          </AreaChart>
        </ChartCard>

        <ChartCard title="Top Tenants by Billing Units">
          <BarChart data={topTenants}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border,0 0% 14.9%))" />
            <XAxis
              dataKey="tenantName"
              stroke="hsl(var(--foreground-muted,0 0% 63.9%))"
              tick={{ fontSize: 11 }}
              interval={0}
              angle={-25}
              textAnchor="end"
              height={60}
            />
            <YAxis
              stroke="hsl(var(--foreground-muted,0 0% 63.9%))"
              tick={{ fontSize: 12 }}
              tickFormatter={formatCompactNumber}
            />
            <Tooltip
              content={<ChartTooltip formatter={(value: number) => formatCompactNumber(value)} />}
            />
            <Bar
              dataKey="totalUnits"
              name="Billing Units"
              fill={CHART_COLORS.purple}
              radius={[4, 4, 0, 0]}
            />
          </BarChart>
        </ChartCard>

        <ChartCard title="Channel Breakdown">
          <PieChart>
            <Pie
              data={channelBreakdown}
              dataKey="totalUnits"
              nameKey="channel"
              cx="50%"
              cy="50%"
              outerRadius={100}
              label={({ channel }: { channel: string }) => channel}
              labelLine
            >
              {channelBreakdown.map((_entry, index) => (
                <Cell key={`cell-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip
              content={<ChartTooltip formatter={(value: number) => formatCompactNumber(value)} />}
            />
          </PieChart>
        </ChartCard>
      </div>

      {!loading && totals.examinedSessionCount === 0 && (
        <div className="mt-6">
          <EmptyState
            title="No billing usage data"
            description="No published billing usage fell inside the selected reporting window."
          />
        </div>
      )}
    </div>
  );
}
