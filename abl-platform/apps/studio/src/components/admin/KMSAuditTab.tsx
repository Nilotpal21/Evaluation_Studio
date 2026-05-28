'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  CheckCircle2,
  Gauge,
  KeyRound,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { Input } from '../ui/Input';
import { MetricCard } from '../ui/MetricCard';
import { Pagination } from '../ui/Pagination';
import { Select } from '../ui/Select';
import { type KMSAuditEntry, useKMSAudit } from '../../hooks/useKMS';
import { humanizeProvider, providerVariant, formatTimestamp } from './kms-utils';

const DEFAULT_PAGE_SIZE = 25;
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

function humanizeOperation(operation: string): string {
  return operation
    .split('_')
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

function resultVariant(entry: KMSAuditEntry): 'success' | 'error' {
  return entry.success === 1 || entry.success === true ? 'success' : 'error';
}

function AuditRow({ entry }: { entry: KMSAuditEntry }) {
  const t = useTranslations('admin');
  const isFailed = entry.success !== 1 && entry.success !== true;

  return (
    <tr className="align-top transition-default hover:bg-background-muted">
      <td className="px-4 py-3">
        <div className="space-y-1">
          <Badge variant="accent">{humanizeOperation(entry.operation)}</Badge>
          <p className="text-xs text-muted">{entry.operation}</p>
        </div>
      </td>
      <td className="px-4 py-3">
        <Badge variant={resultVariant(entry)} dot>
          {isFailed ? t('kms.audit_result_failure') : t('kms.audit_result_success')}
        </Badge>
      </td>
      <td className="px-4 py-3">
        <div className="space-y-1">
          <Badge variant={providerVariant(entry.provider_type)}>
            {humanizeProvider(entry.provider_type)}
          </Badge>
          {entry.key_id ? (
            <code className="inline-block rounded bg-background-muted px-1.5 py-0.5 text-xs text-foreground">
              {entry.key_id}
            </code>
          ) : (
            <p className="text-xs text-muted">--</p>
          )}
        </div>
      </td>
      <td className="px-4 py-3">
        <div className="space-y-1 text-sm text-foreground">
          <p>{entry.actor_id || t('kms.audit_actor_system')}</p>
          <p className="text-xs text-muted">
            {[entry.actor_type || t('kms.audit_actor_unknown'), entry.actor_ip || null]
              .filter(Boolean)
              .join(' · ') || '--'}
          </p>
        </div>
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-muted">
        {entry.latency_ms != null ? `${entry.latency_ms}ms` : '--'}
      </td>
      <td className="px-4 py-3">
        <div className="space-y-1">
          <p className="whitespace-nowrap text-muted">{formatTimestamp(entry.timestamp)}</p>
          {isFailed && entry.error_message && (
            <p className="text-xs text-error">{entry.error_message}</p>
          )}
        </div>
      </td>
    </tr>
  );
}

export function KMSAuditTab() {
  const t = useTranslations('admin');
  const [operation, setOperation] = useState('');
  const [result, setResult] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  const offset = (page - 1) * pageSize;
  const successFilter = result === '' ? undefined : result === 'success' ? true : false;

  const { entries, total, hasMore, summary, operations, message, error, isLoading, mutate } =
    useKMSAudit({
      operation: operation || undefined,
      success: successFilter,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      limit: pageSize,
      offset,
    });

  const totalPages = Math.max(1, Math.ceil(Math.max(total, 1) / pageSize));
  const hasActiveFilters = Boolean(operation || result || startDate || endDate);

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  const operationOptions = useMemo(
    () => [
      { value: '', label: t('kms.audit_operation_all') },
      ...operations.map((facet) => ({
        value: facet.operation,
        label: `${humanizeOperation(facet.operation)} (${facet.count})`,
      })),
    ],
    [operations, t],
  );

  const successRate =
    summary.total > 0 ? `${Math.round((summary.successCount / summary.total) * 100)}%` : '--';

  const summaryCards = useMemo(
    () => [
      {
        label: t('kms.audit_successful'),
        value: summary.successCount,
        context: successRate,
        icon: <CheckCircle2 className="h-4 w-4" />,
      },
      {
        label: t('kms.audit_failed'),
        value: summary.failureCount,
        context: t('kms.audit_unique_actors_inline', { count: summary.uniqueActors }),
        icon: <XCircle className="h-4 w-4" />,
      },
      {
        label: t('kms.audit_avg_latency'),
        value: summary.avgLatencyMs == null ? '--' : `${Math.round(summary.avgLatencyMs)}ms`,
        context: summary.lastEventAt
          ? t('kms.audit_last_event_inline', { value: formatTimestamp(summary.lastEventAt) })
          : undefined,
        icon: <Gauge className="h-4 w-4" />,
      },
      {
        label: t('kms.audit_unique_keys'),
        value: summary.uniqueKeys,
        context: t('kms.audit_operations_inline', { count: operations.length }),
        icon: <KeyRound className="h-4 w-4" />,
      },
    ],
    [operations.length, successRate, summary, t],
  );

  const handleReset = () => {
    setOperation('');
    setResult('');
    setStartDate('');
    setEndDate('');
    setPage(1);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold text-foreground">{t('kms.tabs.audit')}</h2>
          <p className="text-sm text-muted">{t('kms.audit_subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          {hasActiveFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleReset}
              icon={<RotateCcw className="h-3.5 w-3.5" />}
            >
              {t('kms.audit_reset')}
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => mutate()}
            disabled={isLoading}
            icon={<RefreshCw className="h-3.5 w-3.5" />}
          >
            {t('kms.audit_refresh')}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 grid-cols-2 xl:grid-cols-4">
        {summaryCards.map((card) => (
          <MetricCard
            key={card.label}
            label={card.label}
            value={card.value}
            context={card.context}
            icon={card.icon}
          />
        ))}
      </div>

      <div className="grid gap-3 rounded-xl border border-default bg-background-elevated p-4 md:grid-cols-2 xl:grid-cols-5">
        <Select
          label={t('kms.audit_operation')}
          value={operation}
          onChange={(value) => {
            setOperation(value);
            setPage(1);
          }}
          options={operationOptions}
        />
        <Select
          label={t('kms.audit_result')}
          value={result}
          onChange={(value) => {
            setResult(value);
            setPage(1);
          }}
          options={[
            { value: '', label: t('kms.audit_result_all') },
            { value: 'success', label: t('kms.audit_result_success') },
            { value: 'failure', label: t('kms.audit_result_failure') },
          ]}
        />
        <Input
          label={t('kms.audit_from')}
          type="date"
          value={startDate}
          onChange={(event) => {
            setStartDate(event.target.value);
            setPage(1);
          }}
        />
        <Input
          label={t('kms.audit_to')}
          type="date"
          value={endDate}
          onChange={(event) => {
            setEndDate(event.target.value);
            setPage(1);
          }}
        />
        <div className="flex items-end">
          <div className="w-full rounded-lg border border-dashed border-default bg-background-subtle px-3 py-2 text-xs text-muted">
            {hasActiveFilters ? t('kms.audit_filters_active') : t('kms.audit_filters_idle')}
          </div>
        </div>
      </div>

      {message && (
        <div className="flex items-start gap-3 rounded-xl border border-default bg-background-muted p-4">
          <AlertTriangle className="mt-0.5 h-4 w-4 text-warning" />
          <p className="text-sm text-foreground">{message}</p>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-3 rounded-xl border border-error/30 bg-error/5 p-4">
          <AlertTriangle className="mt-0.5 h-4 w-4 text-error" />
          <p className="text-sm text-error">{error}</p>
        </div>
      )}

      {isLoading && entries.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted" />
        </div>
      ) : entries.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck className="h-6 w-6" />}
          title={t('kms.audit_empty_title')}
          description={t('kms.audit_empty_description')}
        />
      ) : (
        <div className="space-y-4">
          <div className="overflow-x-auto rounded-xl border border-default">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-default bg-background-muted">
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted">
                    {t('kms.audit_col_action')}
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted">
                    {t('kms.audit_col_result')}
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted">
                    {t('kms.audit_col_provider')}
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted">
                    {t('kms.audit_col_actor')}
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted">
                    {t('kms.audit_col_latency')}
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted">
                    {t('kms.audit_col_timestamp')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-default">
                {entries.map((entry, index) => (
                  <AuditRow
                    key={entry.event_id || `${entry.timestamp}-${entry.operation}-${index}`}
                    entry={entry}
                  />
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted">
              {t('kms.audit_page_summary', {
                shown: entries.length,
                total,
              })}
            </p>
            <Pagination
              page={page}
              totalPages={totalPages}
              onPageChange={setPage}
              showPageSize
              pageSize={pageSize}
              pageSizeOptions={PAGE_SIZE_OPTIONS}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
            />
          </div>
          {!hasMore && total > 0 && page === totalPages && (
            <p className="text-xs text-muted">{t('kms.audit_end_of_results')}</p>
          )}
        </div>
      )}
    </div>
  );
}
