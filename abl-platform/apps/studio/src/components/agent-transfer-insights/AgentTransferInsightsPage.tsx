'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { PhoneForwarded, AlertCircle, ChevronLeft, ChevronRight } from 'lucide-react';
import { PageHeader } from '../ui/PageHeader';
import { Skeleton } from '../ui/Skeleton';
import { EmptyState } from '../ui/EmptyState';
import { MetricCard } from '../ui/MetricCard';
import { InsightsDateRangeControl } from '../insights/shared/InsightsDateRangeControl';
import { metricInteger, METRIC_NO_DATA } from '../../lib/format/metric-value';
import {
  useAgentTransferInsights,
  type InsightDateRange,
} from '../../hooks/useAgentTransferInsights';
import { clsx } from 'clsx';

// =============================================================================
// DATE RANGE OPTIONS
// =============================================================================

const DATE_OPTIONS = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: '7d' },
  { id: '30d', label: '30d' },
];

// =============================================================================
// HELPERS
// =============================================================================

function resolveArray(data: unknown): Record<string, unknown>[] | null {
  if (!data || typeof data !== 'object') return null;
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  const obj = data as Record<string, unknown>;
  for (const key of [
    'finalResult',
    'data',
    'queues',
    'queueData',
    'queueList',
    'queueMetrics',
    'agents',
    'agentData',
    'agentList',
    'result',
    'results',
    'rows',
    'items',
    'list',
  ]) {
    if (Array.isArray(obj[key])) return obj[key] as Record<string, unknown>[];
  }
  return null;
}

function resolveNumber(obj: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && !isNaN(Number(v))) return Number(v);
  }
  return undefined;
}

function msToSec(ms: number | undefined): number | undefined {
  return ms != null ? Math.round(ms / 1000) : undefined;
}

function formatDuration(ms: number | undefined): string {
  if (ms == null) return METRIC_NO_DATA;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
}

function formatMetricWithUnit(value: string | number, unit: string): string | number {
  return value === METRIC_NO_DATA ? value : `${value}${unit}`;
}

function formatElapsed(ms: number | undefined): string {
  if (ms == null) return METRIC_NO_DATA;
  const totalSecs = Math.round(ms / 1000);
  const d = Math.floor(totalSecs / 86400);
  const h = Math.floor((totalSecs % 86400) / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return parts.join(' ');
}

// =============================================================================
// PRIMITIVES
// =============================================================================

function SectionError({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-error py-3">
      <AlertCircle className="w-4 h-4 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

function NoData({ t }: { t: ReturnType<typeof useTranslations> }) {
  return <p className="text-sm text-muted py-3">{t('empty.title')}</p>;
}

function SectionHeading({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-3">
      <h2 className="text-xs font-semibold text-muted uppercase tracking-wider shrink-0">
        {title}
      </h2>
      <div className="flex-1 border-t border-default" />
    </div>
  );
}

const PAGE_SIZE = 10;

function Pagination({
  page,
  total,
  onPrev,
  onNext,
}: {
  page: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const from = (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, total);

  return (
    <div className="flex items-center justify-between px-4 py-3 border-t border-default">
      <p className="text-xs text-muted">
        {from}–{to} of {total}
      </p>
      <div className="flex items-center gap-1">
        <button
          onClick={onPrev}
          disabled={page === 1}
          className="inline-flex items-center justify-center w-7 h-7 rounded-md text-muted hover:text-foreground hover:bg-background-elevated disabled:opacity-40 disabled:pointer-events-none transition-colors"
          aria-label="Previous page"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span className="text-xs text-muted px-2">
          {page} / {totalPages}
        </span>
        <button
          onClick={onNext}
          disabled={page >= totalPages}
          className="inline-flex items-center justify-center w-7 h-7 rounded-md text-muted hover:text-foreground hover:bg-background-elevated disabled:opacity-40 disabled:pointer-events-none transition-colors"
          aria-label="Next page"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

// Widget card with header bar and content area
function Widget({
  title,
  isLoading,
  skeletonCount,
  children,
}: {
  title: string;
  isLoading: boolean;
  skeletonCount: number;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-default overflow-hidden">
      <div className="px-5 py-3 bg-background-elevated border-b border-default">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      </div>
      <div className="p-4">
        {isLoading ? (
          <div className="grid grid-cols-2 gap-4">
            {Array.from({ length: skeletonCount }).map((_, i) => (
              <Skeleton key={i} className="h-12 rounded-lg" />
            ))}
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

// =============================================================================
// EFFICIENCY WIDGETS
// =============================================================================

function VoiceWidget({
  data,
  isLoading,
  error,
  t,
}: {
  data: unknown;
  isLoading: boolean;
  error: unknown;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <Widget title={t('widgets.voice')} isLoading={isLoading} skeletonCount={6}>
      {error ? (
        <SectionError message={t('error_loading')} />
      ) : data && typeof data === 'object' && !Array.isArray(data) ? (
        (() => {
          const kpis = data as Record<string, unknown>;
          return (
            <div className="grid grid-cols-2 gap-x-6 gap-y-4">
              <MetricCard
                label={t('kpis.avg_speed_to_answer')}
                value={formatMetricWithUnit(
                  metricInteger(
                    msToSec(resolveNumber(kpis, 'avgSpeedToAnswer', 'asa', 'averageSpeedToAnswer')),
                  ),
                  's',
                )}
              />
              <MetricCard
                label={t('kpis.avg_handle_time')}
                value={formatMetricWithUnit(
                  metricInteger(
                    msToSec(resolveNumber(kpis, 'avgHandleTime', 'aht', 'averageHandleTime')),
                  ),
                  's',
                )}
              />
              <MetricCard
                label={t('kpis.avg_pickup_time')}
                value={formatMetricWithUnit(
                  metricInteger(
                    msToSec(
                      resolveNumber(kpis, 'avgPickupTime', 'pickupTime', 'averagePickupTime'),
                    ),
                  ),
                  's',
                )}
              />
              <MetricCard
                label={t('kpis.avg_engagement_time')}
                value={formatMetricWithUnit(
                  metricInteger(
                    msToSec(
                      resolveNumber(
                        kpis,
                        'avgEngagementTime',
                        'engagementTime',
                        'averageEngagementTime',
                      ),
                    ),
                  ),
                  's',
                )}
              />
              <MetricCard
                label={t('kpis.avg_talk_time')}
                value={formatMetricWithUnit(
                  metricInteger(
                    msToSec(resolveNumber(kpis, 'avgTalkTime', 'talkTime', 'averageTalkTime')),
                  ),
                  's',
                )}
              />
              <MetricCard
                label={t('kpis.avg_mute_hold_time')}
                value={formatMetricWithUnit(
                  metricInteger(
                    msToSec(
                      resolveNumber(
                        kpis,
                        'avgMuteHoldTime',
                        'avgHoldTime',
                        'muteHoldTime',
                        'holdTime',
                      ),
                    ),
                  ),
                  's',
                )}
              />
            </div>
          );
        })()
      ) : (
        <NoData t={t} />
      )}
    </Widget>
  );
}

function ChatWidget({
  data,
  isLoading,
  error,
  t,
}: {
  data: unknown;
  isLoading: boolean;
  error: unknown;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <Widget title={t('widgets.chat')} isLoading={isLoading} skeletonCount={6}>
      {error ? (
        <SectionError message={t('error_loading')} />
      ) : data && typeof data === 'object' && !Array.isArray(data) ? (
        (() => {
          const kpis = data as Record<string, unknown>;
          return (
            <div className="grid grid-cols-2 gap-x-6 gap-y-4">
              <MetricCard
                label={t('kpis.avg_speed_to_answer')}
                value={formatDuration(
                  resolveNumber(kpis, 'avgSpeedToAnswer', 'asa', 'averageSpeedToAnswer'),
                )}
              />
              <MetricCard
                label={t('kpis.avg_handle_time')}
                value={formatDuration(
                  resolveNumber(kpis, 'avgHandleTime', 'aht', 'averageHandleTime'),
                )}
              />
              <MetricCard
                label={t('kpis.avg_first_response_time')}
                value={formatDuration(
                  resolveNumber(kpis, 'averageFirstResponseTime', 'avgFirstResponseTime', 'frt'),
                )}
              />
              <MetricCard
                label={t('kpis.avg_agent_response_time')}
                value={formatDuration(
                  resolveNumber(kpis, 'averageAgentResponseTime', 'avgAgentResponseTime', 'art'),
                )}
              />
              <MetricCard
                label={t('kpis.avg_customer_response_time')}
                value={formatDuration(
                  resolveNumber(
                    kpis,
                    'averageCustomerResponseTime',
                    'avgCustomerResponseTime',
                    'crt',
                  ),
                )}
              />
            </div>
          );
        })()
      ) : (
        <NoData t={t} />
      )}
    </Widget>
  );
}

function TransfersWidget({
  data,
  isLoading,
  error,
  t,
}: {
  data: unknown;
  isLoading: boolean;
  error: unknown;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <Widget title={t('widgets.transfers')} isLoading={isLoading} skeletonCount={4}>
      {error ? (
        <SectionError message={t('error_loading')} />
      ) : data && typeof data === 'object' && !Array.isArray(data) ? (
        (() => {
          const kpis = data as Record<string, unknown>;
          return (
            <div className="grid grid-cols-2 gap-x-6 gap-y-4">
              <MetricCard
                label={t('kpis.transfer_rate')}
                value={metricInteger(
                  resolveNumber(kpis, 'transferRate', 'transferPercent', 'rate'),
                )}
              />
              <MetricCard
                label={t('kpis.total_transfers')}
                value={metricInteger(resolveNumber(kpis, 'totalTransfers', 'total', 'totalCount'))}
              />
              <MetricCard
                label={t('kpis.call_transfers')}
                value={metricInteger(
                  resolveNumber(kpis, 'callTransfers', 'voiceTransfers', 'phoneTransfers'),
                )}
              />
              <MetricCard
                label={t('kpis.chat_transfers')}
                value={metricInteger(
                  resolveNumber(kpis, 'chatTransfers', 'textTransfers', 'messagingTransfers'),
                )}
              />
            </div>
          );
        })()
      ) : (
        <NoData t={t} />
      )}
    </Widget>
  );
}

// =============================================================================
// QUEUE TABLE
// =============================================================================

const QUEUE_COLS = [
  'queue_name',
  'incoming',
  'waiting',
  'active',
  'long_wait_time',
  'answered',
  'abandoned',
  'transferred',
  'terminated',
  'closed',
  'csat',
] as const;

function QueueTable({
  data,
  isLoading,
  error,
  t,
}: {
  data: unknown;
  isLoading: boolean;
  error: unknown;
  t: ReturnType<typeof useTranslations>;
}) {
  const [page, setPage] = useState(1);

  if (error) return <SectionError message={t('error_loading')} />;
  if (isLoading) return <Skeleton className="h-48 rounded-xl" />;

  const allRows = resolveArray(data);
  if (!allRows?.length) return <NoData t={t} />;

  const rows = allRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="rounded-xl border border-default overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-default bg-background-elevated">
              {QUEUE_COLS.map((col) => (
                <th
                  key={col}
                  className="text-left px-4 py-3 text-xs font-semibold text-muted whitespace-nowrap"
                >
                  {t(`queue_table.${col}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((q, i) => (
              <tr
                key={i}
                className={clsx(
                  'border-b border-default last:border-0',
                  i % 2 === 1 && 'bg-background-elevated/40',
                )}
              >
                <td className="px-4 py-3 font-medium text-foreground whitespace-nowrap">
                  {(q.queueName ?? q.name ?? q.queue ?? q.id ?? '—') as string}
                </td>
                <td className="px-4 py-3 text-foreground">
                  {metricInteger(resolveNumber(q, 'incoming'))}
                </td>
                <td className="px-4 py-3 text-foreground">
                  {metricInteger(resolveNumber(q, 'waiting'))}
                </td>
                <td className="px-4 py-3 text-foreground">
                  {metricInteger(resolveNumber(q, 'active'))}
                </td>
                <td className="px-4 py-3 text-foreground whitespace-nowrap">
                  {formatElapsed(resolveNumber(q, 'longWaitTime'))}
                </td>
                <td className="px-4 py-3 text-foreground">
                  {metricInteger(resolveNumber(q, 'answered'))}
                </td>
                <td className="px-4 py-3 text-foreground">
                  {metricInteger(resolveNumber(q, 'abandoned'))}
                </td>
                <td className="px-4 py-3 text-foreground">
                  {metricInteger(resolveNumber(q, 'transferred'))}
                </td>
                <td className="px-4 py-3 text-foreground">
                  {metricInteger(resolveNumber(q, 'terminated'))}
                </td>
                <td className="px-4 py-3 text-foreground">
                  {metricInteger(resolveNumber(q, 'closed'))}
                </td>
                <td className="px-4 py-3 text-foreground">
                  {metricInteger(resolveNumber(q, 'CSAT', 'csat'))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {allRows.length > PAGE_SIZE && (
        <Pagination
          page={page}
          total={allRows.length}
          onPrev={() => setPage((p) => p - 1)}
          onNext={() => setPage((p) => p + 1)}
        />
      )}
    </div>
  );
}

// =============================================================================
// AGENT TABLE
// =============================================================================

const AGENT_COLS = [
  'agent_name',
  'status',
  'offered',
  'answered',
  'unanswered',
  'abandoned',
  'last_duration',
  'transferred',
  'closed_per_hour',
  'aht',
] as const;

function AgentTable({
  data,
  isLoading,
  error,
  t,
}: {
  data: unknown;
  isLoading: boolean;
  error: unknown;
  t: ReturnType<typeof useTranslations>;
}) {
  const [page, setPage] = useState(1);

  if (error) return <SectionError message={t('error_loading')} />;
  if (isLoading) return <Skeleton className="h-48 rounded-xl" />;

  const allRows = resolveArray(data);
  if (!allRows?.length) return <NoData t={t} />;

  const rows = allRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="rounded-xl border border-default overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-default bg-background-elevated">
              {AGENT_COLS.map((col) => (
                <th
                  key={col}
                  className="text-left px-4 py-3 text-xs font-semibold text-muted whitespace-nowrap"
                >
                  {t(`agent_table.${col}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((a, i) => {
              const status = (a.status ?? '') as string;
              const statusLower = status.toLowerCase();
              return (
                <tr
                  key={i}
                  className={clsx(
                    'border-b border-default last:border-0',
                    i % 2 === 1 && 'bg-background-elevated/40',
                  )}
                >
                  <td className="px-4 py-3 font-medium text-foreground whitespace-nowrap">
                    {(a.agentName ?? a.name ?? a.id ?? '—') as string}
                  </td>
                  <td className="px-4 py-3">
                    {status ? (
                      <span
                        className={clsx(
                          'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                          statusLower === 'available' || statusLower === 'online'
                            ? 'bg-success/10 text-success'
                            : statusLower === 'busy'
                              ? 'bg-warning/10 text-warning'
                              : 'bg-background-muted text-muted',
                        )}
                      >
                        {status}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-4 py-3 text-foreground">
                    {metricInteger(resolveNumber(a, 'offered'))}
                  </td>
                  <td className="px-4 py-3 text-foreground">
                    {metricInteger(resolveNumber(a, 'answered'))}
                  </td>
                  <td className="px-4 py-3 text-foreground">
                    {metricInteger(resolveNumber(a, 'unanswered'))}
                  </td>
                  <td className="px-4 py-3 text-foreground">
                    {metricInteger(resolveNumber(a, 'abandoned'))}
                  </td>
                  <td className="px-4 py-3 text-foreground">
                    {formatDuration(resolveNumber(a, 'lastDuration'))}
                  </td>
                  <td className="px-4 py-3 text-foreground">
                    {metricInteger(resolveNumber(a, 'transferred'))}
                  </td>
                  <td className="px-4 py-3 text-foreground">
                    {metricInteger(resolveNumber(a, 'closedPerHour'))}
                  </td>
                  <td className="px-4 py-3 text-foreground">
                    {formatDuration(resolveNumber(a, 'averageHandleTime'))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {allRows.length > PAGE_SIZE && (
        <Pagination
          page={page}
          total={allRows.length}
          onPrev={() => setPage((p) => p - 1)}
          onNext={() => setPage((p) => p + 1)}
        />
      )}
    </div>
  );
}

// =============================================================================
// MAIN PAGE
// =============================================================================

export function AgentTransferInsightsPage() {
  const t = useTranslations('agent_transfer_insights');
  const [dateRange, setDateRange] = useState<InsightDateRange>('7d');

  const { chat, voice, queues, agents, transfers, noConnection, misconfiguredConnection } =
    useAgentTransferInsights(dateRange);

  if (noConnection || misconfiguredConnection) {
    const emptyKey = misconfiguredConnection ? 'misconfigured_connection' : 'no_connection';
    return (
      <div className="flex flex-col h-full">
        <PageHeader title={t('title')} className="px-6 pt-6 pb-0" />
        <div className="flex-1 flex items-center justify-center p-8">
          <EmptyState
            icon={<PhoneForwarded className="w-10 h-10 text-muted" />}
            title={t(`${emptyKey}.title`)}
            description={t(`${emptyKey}.description`)}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title={t('title')}
        className="px-6 pt-6 pb-0"
        actions={
          <InsightsDateRangeControl
            value={dateRange}
            onChange={(v) => setDateRange(v as InsightDateRange)}
            options={DATE_OPTIONS}
          />
        }
      />

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
        {/* Efficiency */}
        <SectionHeading title={t('sections.efficiency')} />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <VoiceWidget data={voice.data} isLoading={voice.isLoading} error={voice.error} t={t} />
          <ChatWidget data={chat.data} isLoading={chat.isLoading} error={chat.error} t={t} />
          <TransfersWidget
            data={transfers.data}
            isLoading={transfers.isLoading}
            error={transfers.error}
            t={t}
          />
        </div>

        {/* Queue Performance */}
        <SectionHeading title={t('sections.queue_performance')} />
        <QueueTable data={queues.data} isLoading={queues.isLoading} error={queues.error} t={t} />

        {/* Agent Performance */}
        <SectionHeading title={t('sections.agent_performance')} />
        <AgentTable data={agents.data} isLoading={agents.isLoading} error={agents.error} t={t} />
      </div>
    </div>
  );
}
