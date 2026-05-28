/**
 * VoiceAnalyticsPage
 *
 * Aggregated voice metrics dashboard using materialized view data.
 * Shows hourly trends, KPIs, and quality metrics for voice sessions.
 *
 * Located at: /projects/:projectId/voice-analytics
 * Navigation: INSIGHTS → Voice Analytics
 */

'use client';

import { useTranslations } from 'next-intl';
import { Phone, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { useVoiceAnalytics, type DateRange } from '../../hooks/useVoiceAnalytics';
import { InsightsDateRangeControl } from '../insights/shared/InsightsDateRangeControl';
import { metricInteger, metricNumber, METRIC_NO_DATA } from '../../lib/format/metric-value';
import { PageHeader } from '../ui/PageHeader';
import { Skeleton } from '../ui/Skeleton';
import { TooltipProvider } from '../ui/Tooltip';
import { clsx } from 'clsx';
import { NetworkQualityWidget } from './NetworkQualityWidget';
import { SpeechQualityWidget } from './SpeechQualityWidget';
import { ResponsePerformanceWidget } from './ResponsePerformanceWidget';
import { UserExperienceWidget } from './UserExperienceWidget';
import { usePersistedSurfaceFilters } from '../../hooks/usePersistedSurfaceFilters';

// =============================================================================
// SUBCOMPONENTS
// =============================================================================

interface MetricCardProps {
  label: string;
  value: string | number;
  unit?: string;
  change?: number;
  trend?: 'up' | 'down' | 'neutral';
}

function MetricCard({ label, value, unit, change, trend }: MetricCardProps) {
  const TrendIcon =
    trend === 'neutral' || !trend ? Minus : trend === 'up' ? TrendingUp : TrendingDown;
  const trendColor =
    trend === 'neutral' || !trend ? 'text-muted' : trend === 'up' ? 'text-success' : 'text-error';

  // Suppress unit suffix when the value is the em-dash "no data" marker —
  // "— ms" or "— %" reads as broken.
  const showUnit = unit && value !== METRIC_NO_DATA;

  return (
    <div className="flex-1 min-w-[140px] p-4 bg-background-elevated rounded-xl border border-default">
      <p className="text-xs font-medium text-muted">{label}</p>
      <div className="flex items-baseline gap-2 mt-1">
        <p className="text-2xl font-semibold text-foreground">{value}</p>
        {showUnit && <span className="text-sm text-muted">{unit}</span>}
      </div>
      {change !== undefined && (
        <div className={clsx('flex items-center gap-1 mt-1 text-xs', trendColor)}>
          <TrendIcon className="w-3 h-3" />
          <span>
            {change > 0 ? '+' : ''}
            {change.toFixed(1)}%
          </span>
        </div>
      )}
    </div>
  );
}

function MetricCardSkeleton() {
  return <Skeleton className="h-24 rounded-xl" />;
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function VoiceAnalyticsPage() {
  const t = useTranslations('voice_analytics');
  const { state: voiceAnalyticsFilters, updateState } =
    usePersistedSurfaceFilters('voiceAnalytics');
  const dateRange = voiceAnalyticsFilters.dateRange as DateRange;
  const { summary, hourlyData, isLoading, error } = useVoiceAnalytics(dateRange);

  // Format hour for display in table
  const formatHour = (hour: string) => {
    const date = new Date(hour);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <TooltipProvider>
      <div className="h-full overflow-y-auto bg-noise">
        <div className="max-w-7xl mx-auto px-6 py-8 space-y-6">
          {/* Header */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <PageHeader title={t('title')} description={t('description')} />
            <InsightsDateRangeControl
              preset="voice"
              value={dateRange}
              onChange={(value) => updateState({ dateRange: value as DateRange })}
            />
          </div>

          {/* Error State */}
          {error && (
            <div className="rounded-lg border border-error/30 bg-error-subtle p-4 text-sm text-error">
              {t('error_loading')}
            </div>
          )}

          {/* KPI Cards */}
          {isLoading ? (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <MetricCardSkeleton key={i} />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
              <MetricCard
                label={t('metrics.total_calls')}
                value={metricInteger(summary?.total_calls)}
              />
              <MetricCard
                label={t('metrics.avg_mos')}
                value={metricNumber(summary?.overall_avg_inbound_mos, 2)}
              />
              <MetricCard
                label={t('metrics.asr_quality')}
                value={metricNumber(summary?.overall_asr_score, 0)}
              />
              <MetricCard
                label={t('metrics.e2e_latency')}
                value={metricNumber(summary?.overall_avg_latency_ms, 0)}
                unit="ms"
              />
              <MetricCard
                label={t('metrics.barge_in_rate')}
                value={metricNumber(summary?.overall_barge_in_rate, 1)}
                unit="%"
              />
              <MetricCard
                label={t('metrics.dtmf_fallback')}
                value={metricNumber(summary?.overall_dtmf_fallback_rate, 1)}
                unit="%"
              />
            </div>
          )}

          {/* Chart Widgets Grid */}
          {!isLoading && hourlyData.length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Network Quality & Volume */}
              <NetworkQualityWidget data={hourlyData} />

              {/* Speech Recognition Quality */}
              <SpeechQualityWidget data={hourlyData} />

              {/* Response Performance */}
              <ResponsePerformanceWidget data={hourlyData} />

              {/* User Experience */}
              <UserExperienceWidget data={hourlyData} />
            </div>
          )}

          {/* Empty State */}
          {!isLoading && hourlyData.length === 0 && (
            <div className="bg-background-elevated rounded-xl border border-default p-12 text-center">
              <Phone className="w-12 h-12 text-muted mx-auto mb-4" />
              <p className="text-foreground font-medium mb-2">{t('empty.title')}</p>
              <p className="text-sm text-muted">{t('empty.description')}</p>
            </div>
          )}

          {/* Hourly Breakdown Table */}
          {!isLoading && hourlyData.length > 0 && (
            <div className="bg-background-elevated rounded-xl border border-default overflow-hidden">
              <div className="px-6 py-4 border-b border-default">
                <h3 className="text-sm font-semibold">{t('table.title')}</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-background-muted">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-muted uppercase tracking-wider">
                        {t('table.hour')}
                      </th>
                      <th className="px-6 py-3 text-right text-xs font-medium text-muted uppercase tracking-wider">
                        {t('table.calls')}
                      </th>
                      <th className="px-6 py-3 text-right text-xs font-medium text-muted uppercase tracking-wider">
                        {t('table.avg_mos')}
                      </th>
                      <th className="px-6 py-3 text-right text-xs font-medium text-muted uppercase tracking-wider">
                        {t('table.latency')}
                      </th>
                      <th className="px-6 py-3 text-right text-xs font-medium text-muted uppercase tracking-wider">
                        {t('table.barge_in')}
                      </th>
                      <th className="px-6 py-3 text-right text-xs font-medium text-muted uppercase tracking-wider">
                        {t('table.asr_score')}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-default/50">
                    {hourlyData.map((row, idx) => (
                      <tr key={idx} className="hover:bg-background-muted/30 transition-colors">
                        <td className="px-6 py-3 text-sm text-foreground whitespace-nowrap">
                          {formatHour(row.hour)}
                        </td>
                        <td className="px-6 py-3 text-sm text-right text-foreground">
                          {row.session_count}
                        </td>
                        <td className="px-6 py-3 text-sm text-right text-foreground">
                          {row.avg_inbound_mos ? row.avg_inbound_mos.toFixed(2) : '—'}
                        </td>
                        <td className="px-6 py-3 text-sm text-right text-foreground">
                          {row.avg_e2e_latency_ms ? `${row.avg_e2e_latency_ms.toFixed(0)}ms` : '—'}
                        </td>
                        <td className="px-6 py-3 text-sm text-right text-foreground">
                          {row.avg_barge_in_rate ? `${row.avg_barge_in_rate.toFixed(1)}%` : '—'}
                        </td>
                        <td className="px-6 py-3 text-sm text-right text-foreground">
                          {row.avg_asr_score ? row.avg_asr_score.toFixed(0) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
