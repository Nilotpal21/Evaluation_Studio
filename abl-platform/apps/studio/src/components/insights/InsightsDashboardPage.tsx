/**
 * InsightsDashboardPage
 *
 * Executive overview of the AI agent program. Displays 5 KPI metric cards,
 * a conversation volume + containment trend area chart (Recharts), and a
 * cost breakdown table grouped by agent.
 *
 * Data comes from useInsightsDashboard which fetches existing analytics
 * endpoints via SWR.
 */

'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useInsightsDashboard } from '../../hooks/useInsightsDashboard';
import { PageHeader } from '../ui/PageHeader';
import { Skeleton } from '../ui/Skeleton';
import { DataTable, type Column } from '../ui/DataTable';
import { InsightKPICard } from './shared/InsightKPICard';
import { InsightsDateRangeControl } from './shared/InsightsDateRangeControl';
import { TimeSeriesChart } from './shared/TimeSeriesChart';

// =============================================================================
// TYPES
// =============================================================================

type DateRange = '7d' | '30d' | '90d';

function MetricCardSkeleton() {
  return <Skeleton className="h-24 rounded-xl" />;
}

const KPI_CARD_COUNT = 5;

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function InsightsDashboardPage() {
  const t = useTranslations('insights');
  const [dateRange, setDateRange] = useState<DateRange>('30d');
  const { summary, trends, costBreakdown, isLoading, error, projectId } =
    useInsightsDashboard(dateRange);
  const costColumns: Column<(typeof costBreakdown)[number]>[] = [
    {
      key: 'agent',
      label: t('cost_breakdown.agent'),
      render: (row) => <span className="text-sm font-medium text-foreground">{row.agentName}</span>,
      sortable: true,
      sortValue: (row) => row.agentName,
    },
    {
      key: 'conversations',
      label: t('cost_breakdown.conversations'),
      render: (row) => (
        <span className="block text-sm text-muted text-right">
          {row.conversations.toLocaleString()}
        </span>
      ),
      sortable: true,
      sortValue: (row) => row.conversations,
    },
    {
      key: 'cost',
      label: t('cost_breakdown.cost'),
      render: (row) => (
        <span className="block text-sm text-muted text-right">${row.cost.toFixed(2)}</span>
      ),
      sortable: true,
      sortValue: (row) => row.cost,
    },
    {
      key: 'containment',
      label: t('cost_breakdown.containment'),
      render: (row) => (
        <span className="block text-sm text-muted text-right">
          {(row.containmentRate * 100).toFixed(1)}%
        </span>
      ),
      sortable: true,
      sortValue: (row) => row.containmentRate,
    },
  ];

  if (!projectId) {
    return (
      <div className="flex items-center justify-center h-64 text-muted">
        {t('select_project') || 'Select a project to view insights'}
      </div>
    );
  }

  const dateRangeControl = (
    <InsightsDateRangeControl
      preset="day"
      value={dateRange}
      onChange={(value) => setDateRange(value as DateRange)}
    />
  );

  return (
    <div className="h-full overflow-y-auto bg-noise">
      <div className="max-w-7xl mx-auto px-6 py-8 space-y-6">
        {/* Header */}
        <PageHeader title={t('title')} description={t('subtitle')} actions={dateRangeControl} />

        {/* Error state */}
        {error && (
          <div className="rounded-lg border border-error/30 bg-error-subtle p-4 text-sm text-error">
            {t('error_loading')}
          </div>
        )}

        {/* KPI Cards */}
        {isLoading ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
            {Array.from({ length: KPI_CARD_COUNT }).map((_, i) => (
              <MetricCardSkeleton key={i} />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
            <InsightKPICard
              title={t('metrics.conversations')}
              value={summary.totalConversations.toLocaleString()}
            />
            <InsightKPICard
              title={t('metrics.containment_rate')}
              value={`${Math.min(100, Math.max(0, summary.containmentRate * 100)).toFixed(1)}%`}
            />
            <InsightKPICard
              title={t('metrics.cost_savings')}
              value={`$${summary.estimatedCostSavings.toLocaleString()}`}
            />
            <InsightKPICard
              title={t('metrics.csat')}
              value={summary.avgCSAT !== null ? summary.avgCSAT.toFixed(1) : '\u2014'}
            />
            <InsightKPICard
              title={t('metrics.escalation_rate')}
              value={`${Math.min(100, Math.max(0, summary.escalationRate * 100)).toFixed(1)}%`}
            />
          </div>
        )}

        {/* Trend Chart */}
        <div className="bg-background-elevated rounded-xl border border-default p-6">
          <h2 className="text-sm font-semibold text-foreground mb-4">{t('chart_title')}</h2>
          {isLoading ? (
            <Skeleton className="h-64 rounded" />
          ) : trends.length > 0 ? (
            <TimeSeriesChart
              data={trends}
              height={280}
              metrics={[{ key: 'conversations', label: t('metrics.conversations'), type: 'area' }]}
            />
          ) : (
            <div className="h-64 flex items-center justify-center text-sm text-muted">
              {t('no_trend_data')}
            </div>
          )}
        </div>

        {/* Cost Breakdown Table */}
        <div className="bg-background-elevated rounded-xl border border-default overflow-hidden">
          <div className="px-6 py-4 border-b border-default">
            <h2 className="text-sm font-semibold text-foreground">{t('cost_breakdown.title')}</h2>
          </div>
          {isLoading ? (
            <div className="p-6 space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-8 rounded" />
              ))}
            </div>
          ) : costBreakdown.length > 0 ? (
            <DataTable
              columns={costColumns}
              data={costBreakdown}
              keyExtractor={(row) => row.agentName}
            />
          ) : (
            <div className="px-6 py-12 text-center text-sm text-muted">
              {t('cost_breakdown.empty')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
