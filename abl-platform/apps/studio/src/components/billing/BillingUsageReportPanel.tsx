import { useId, type ComponentProps, type ComponentType } from 'react';
import { useTranslations } from 'next-intl';
import { clsx } from 'clsx';
import { Zap, Clock, BarChart3, MessageSquare, Sparkles } from 'lucide-react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
} from 'recharts';
import { EmptyState } from '../ui/EmptyState';
import { Select } from '../ui/Select';
import { InsightsDateRangeControl } from '../insights/shared/InsightsDateRangeControl';
import type { TenantBillingUsageReport } from '../../hooks/useBilling';

export type BillingDateRange = '7d' | '30d' | '90d';

export const BILLING_DATE_RANGES: BillingDateRange[] = ['7d', '30d', '90d'];

export function getBillingDateRange(range: BillingDateRange): {
  windowStart: string;
  windowEnd: string;
} {
  const now = new Date();
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0),
  );
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return {
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
  };
}

function formatNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

function formatWindowLabel(value: string): string {
  const date = new Date(value);
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
}

function SummaryCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: ComponentType<{ className?: string }>;
}) {
  return (
    <div className="bg-background-elevated border border-default rounded-xl p-4 shadow-sm">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-muted">{label}</span>
        <Icon className="w-4 h-4 text-muted" />
      </div>
      <span className="text-2xl font-semibold text-foreground">{value}</span>
    </div>
  );
}

function SkeletonCards() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {Array.from({ length: 4 }).map((_, index) => (
        <div
          key={index}
          className="bg-background-elevated border border-default rounded-xl p-4 shadow-sm"
        >
          <div className="skeleton h-3 w-20 mb-3 rounded" />
          <div className="skeleton h-7 w-28 rounded" />
        </div>
      ))}
    </div>
  );
}

function SkeletonChart() {
  return (
    <div className="bg-background-elevated border border-default rounded-xl p-6">
      <div className="skeleton h-4 w-32 mb-4 rounded" />
      <div className="skeleton h-64 w-full rounded" />
    </div>
  );
}

interface ProjectFilterOption {
  value: string;
  label: string;
}

interface BillingUsageReportPanelProps {
  report: TenantBillingUsageReport | null;
  isLoading: boolean;
  error: string | null;
  dateRange: BillingDateRange;
  onDateRangeChange: (range: BillingDateRange) => void;
  selectedProjectId?: string | null;
  projectNameMap?: Map<string, string>;
  showTopDivider?: boolean;
  projectFilter?: {
    options: ProjectFilterOption[];
    value: string;
    onChange: (value: string) => void;
  };
}

export function BillingUsageReportPanel({
  report,
  isLoading,
  error,
  dateRange,
  onDateRangeChange,
  selectedProjectId = null,
  projectNameMap,
  showTopDivider = false,
  projectFilter,
}: BillingUsageReportPanelProps) {
  const t = useTranslations('admin');
  const gradientIdPrefix = useId().replace(/:/g, '');
  const billingUnitsGradientId = `${gradientIdPrefix}-billingUnits`;
  const includedSessionsGradientId = `${gradientIdPrefix}-includedSessions`;
  const isEmpty = report && report.totals.examinedSessionCount === 0;
  const tooltipFormatter: NonNullable<ComponentProps<typeof RechartsTooltip>['formatter']> = (
    value,
    name,
  ) => {
    const scalarValue = Array.isArray(value) ? value[0] : value;
    const numericValue = Number(scalarValue ?? 0);

    if (name === 'includedSessionCount') {
      return [formatNumber(numericValue), t('billing.legend_included_sessions')];
    }

    return [formatNumber(numericValue), t('billing.legend_billing_units')];
  };

  return (
    <>
      <div className={clsx(showTopDivider && 'border-t border-default pt-6')}>
        <h3 className="text-sm font-semibold text-foreground mb-4">
          {t('billing.llm_usage_title')}
        </h3>
      </div>

      <div className="flex items-center justify-between gap-4 flex-wrap">
        <InsightsDateRangeControl
          ariaLabel={t('billing.llm_usage_title')}
          options={BILLING_DATE_RANGES.map((range) => ({
            id: range,
            label:
              range === '7d'
                ? t('billing.date_range_7d')
                : range === '30d'
                  ? t('billing.date_range_30d')
                  : t('billing.date_range_90d'),
          }))}
          value={dateRange}
          onChange={(value) => onDateRangeChange(value as BillingDateRange)}
        />

        {projectFilter ? (
          <Select
            options={projectFilter.options}
            value={projectFilter.value}
            onChange={projectFilter.onChange}
          />
        ) : null}
      </div>

      {isLoading ? (
        <>
          <SkeletonCards />
          <SkeletonChart />
        </>
      ) : null}

      {!isLoading && error && !report ? (
        <EmptyState
          icon={<BarChart3 className="w-6 h-6" />}
          title={t('billing.load_usage_error_title')}
          description={t('billing.load_usage_error_description', { error })}
        />
      ) : null}

      {!isLoading && report && isEmpty ? (
        <EmptyState
          icon={<BarChart3 className="w-6 h-6" />}
          title={t('billing.no_usage_title')}
          description={t('billing.no_usage_description')}
        />
      ) : null}

      {!isLoading && report && !isEmpty ? (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <SummaryCard
              label={t('billing.summary_included_sessions')}
              value={formatNumber(report.totals.includedSessionCount)}
              icon={MessageSquare}
            />
            <SummaryCard
              label={t('billing.summary_billing_units')}
              value={formatNumber(report.totals.totalUnits)}
              icon={Zap}
            />
            <SummaryCard
              label={t('billing.summary_llm_calls')}
              value={formatNumber(report.totals.llmCallCount)}
              icon={Sparkles}
            />
            <SummaryCard
              label={t('billing.summary_interactive_turns')}
              value={formatNumber(report.totals.interactiveTurnCount)}
              icon={Clock}
            />
          </div>

          {report.windows.length > 0 ? (
            <div className="bg-background-elevated border border-default rounded-xl p-6 bg-noise">
              <h3 className="text-sm font-semibold text-foreground mb-4">
                {t('billing.daily_trend_title')}
              </h3>
              <ResponsiveContainer width="100%" height={280}>
                <AreaChart data={report.windows} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                  <defs>
                    <linearGradient id={billingUnitsGradientId} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--accent))" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="hsl(var(--accent))" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id={includedSessionsGradientId} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--purple))" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="hsl(var(--purple))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis
                    dataKey="windowStart"
                    tick={{ fontSize: 11, fill: 'hsl(var(--foreground-muted))' }}
                    tickFormatter={formatWindowLabel}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: 'hsl(var(--foreground-muted))' }}
                    tickFormatter={formatNumber}
                    width={60}
                  />
                  <RechartsTooltip
                    contentStyle={{
                      backgroundColor: 'hsl(var(--background-elevated))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    labelStyle={{ color: 'hsl(var(--foreground))' }}
                    formatter={tooltipFormatter}
                  />
                  <Area
                    type="monotone"
                    dataKey="totalUnits"
                    stroke="hsl(var(--accent))"
                    fill={`url(#${billingUnitsGradientId})`}
                    strokeWidth={2}
                  />
                  <Area
                    type="monotone"
                    dataKey="includedSessionCount"
                    stroke="hsl(var(--purple))"
                    fill={`url(#${includedSessionsGradientId})`}
                    strokeWidth={2}
                  />
                </AreaChart>
              </ResponsiveContainer>
              <div className="flex items-center gap-4 mt-2 text-xs text-muted">
                <div className="flex items-center gap-1.5">
                  <span className="w-3 h-0.5 rounded bg-accent" />
                  <span>{t('billing.legend_billing_units')}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-3 h-0.5 rounded bg-purple" />
                  <span>{t('billing.legend_included_sessions')}</span>
                </div>
              </div>
            </div>
          ) : null}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {!selectedProjectId && report.projectBreakdown.length > 0 ? (
              <div className="bg-background-elevated border border-default rounded-xl p-6">
                <h3 className="text-sm font-semibold text-foreground mb-4">
                  {t('billing.project_breakdown_title')}
                </h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-default">
                        <th className="text-left text-xs font-medium text-muted uppercase tracking-wider py-2 pr-4">
                          {t('billing.col_project')}
                        </th>
                        <th className="text-right text-xs font-medium text-muted uppercase tracking-wider py-2 pr-4">
                          {t('billing.col_sessions')}
                        </th>
                        <th className="text-right text-xs font-medium text-muted uppercase tracking-wider py-2 pr-4">
                          {t('billing.col_units')}
                        </th>
                        <th className="text-right text-xs font-medium text-muted uppercase tracking-wider py-2">
                          {t('billing.col_llm_calls')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.projectBreakdown.map((projectRow) => (
                        <tr
                          key={projectRow.projectId}
                          className="border-b border-default last:border-0"
                        >
                          <td className="py-2 pr-4 text-foreground font-medium">
                            {projectNameMap?.get(projectRow.projectId) ?? projectRow.projectId}
                          </td>
                          <td className="py-2 pr-4 text-right text-muted">
                            {formatNumber(projectRow.includedSessionCount)}
                          </td>
                          <td className="py-2 pr-4 text-right text-muted">
                            {formatNumber(projectRow.totalUnits)}
                          </td>
                          <td className="py-2 text-right font-medium text-foreground">
                            {formatNumber(projectRow.llmCallCount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}

            {report.channelBreakdown.length > 0 ? (
              <div className="bg-background-elevated border border-default rounded-xl p-6">
                <h3 className="text-sm font-semibold text-foreground mb-4">
                  {t('billing.channel_breakdown_title')}
                </h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-default">
                        <th className="text-left text-xs font-medium text-muted uppercase tracking-wider py-2 pr-4">
                          {t('billing.col_channel')}
                        </th>
                        <th className="text-right text-xs font-medium text-muted uppercase tracking-wider py-2 pr-4">
                          {t('billing.col_sessions')}
                        </th>
                        <th className="text-right text-xs font-medium text-muted uppercase tracking-wider py-2 pr-4">
                          {t('billing.col_units')}
                        </th>
                        <th className="text-right text-xs font-medium text-muted uppercase tracking-wider py-2">
                          {t('billing.col_llm_calls')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.channelBreakdown.map((channelRow) => (
                        <tr
                          key={channelRow.channel}
                          className="border-b border-default last:border-0"
                        >
                          <td className="py-2 pr-4 text-foreground font-medium">
                            {channelRow.channel}
                          </td>
                          <td className="py-2 pr-4 text-right text-muted">
                            {formatNumber(channelRow.includedSessionCount)}
                          </td>
                          <td className="py-2 pr-4 text-right text-muted">
                            {formatNumber(channelRow.totalUnits)}
                          </td>
                          <td className="py-2 text-right font-medium text-foreground">
                            {formatNumber(channelRow.llmCallCount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </>
  );
}
