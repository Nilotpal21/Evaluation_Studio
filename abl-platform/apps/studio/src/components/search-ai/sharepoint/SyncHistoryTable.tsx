'use client';

/**
 * SyncHistoryTable
 *
 * Paginated sync history table with status badges.
 * Uses DataTable and useSyncHistory hook.
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { DataTable, type Column } from '../../ui/DataTable';
import { Badge, type BadgeVariant } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { useSyncHistory, type SyncHistoryEntry } from '../../../hooks/useSyncHistory';

interface SyncHistoryTableProps {
  indexId: string;
  connectorId: string;
}

const STATUS_BADGE_MAP: Record<SyncHistoryEntry['status'], BadgeVariant> = {
  done: 'success',
  failed: 'error',
  cancelled: 'warning',
};

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return remainMins > 0 ? `${hrs}h ${remainMins}m` : `${hrs}h`;
}

function formatDate(isoDate: string): string {
  return new Date(isoDate).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function SyncHistoryTable({ indexId, connectorId }: SyncHistoryTableProps) {
  const t = useTranslations('search_ai.sharepoint.overview');
  const { history, total, page, isLoading, setPage } = useSyncHistory(indexId, connectorId);

  const columns = useMemo(
    (): Column<SyncHistoryEntry>[] => [
      {
        key: 'date',
        label: t('sync_col_date'),
        sortable: true,
        sortValue: (row) => new Date(row.date).getTime(),
        render: (row) => (
          <span className="text-foreground whitespace-nowrap">{formatDate(row.date)}</span>
        ),
      },
      {
        key: 'type',
        label: t('sync_col_type'),
        render: (row) => (
          <span className="text-foreground">
            {row.type === 'full' ? t('sync_type_full') : t('sync_type_delta')}
          </span>
        ),
      },
      {
        key: 'docs',
        label: t('sync_col_docs'),
        render: (row) => (
          <span className="text-foreground whitespace-nowrap">
            +{row.docsAdded}, -{row.docsRemoved}, ~{row.docsModified}
          </span>
        ),
      },
      {
        key: 'duration',
        label: t('sync_col_duration'),
        sortable: true,
        sortValue: (row) => row.duration,
        render: (row) => <span className="text-muted">{formatDuration(row.duration)}</span>,
      },
      {
        key: 'status',
        label: t('sync_col_status'),
        render: (row) => {
          const statusKey = `sync_status_${row.status}` as const;
          return <Badge variant={STATUS_BADGE_MAP[row.status]}>{t(statusKey)}</Badge>;
        },
      },
    ],
    [t],
  );

  if (isLoading) {
    return (
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-foreground">{t('sync_history_title')}</h3>
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-10 bg-background-muted rounded animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  const totalPages = Math.ceil(total / 20);

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-foreground">{t('sync_history_title')}</h3>

      <DataTable<SyncHistoryEntry>
        columns={columns}
        data={history}
        keyExtractor={(row) => `${row.date}-${row.type}`}
        emptyMessage={t('no_issues')}
      />

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-2">
          <Button
            variant="ghost"
            size="xs"
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
            aria-label="Previous page"
          >
            &larr;
          </Button>
          <span className="text-xs text-muted">
            {page} / {totalPages}
          </span>
          <Button
            variant="ghost"
            size="xs"
            disabled={page >= totalPages}
            onClick={() => setPage(page + 1)}
            aria-label="Next page"
          >
            &rarr;
          </Button>
        </div>
      )}
    </div>
  );
}
