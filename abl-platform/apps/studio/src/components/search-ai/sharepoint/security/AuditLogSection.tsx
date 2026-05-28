/**
 * AuditLogSection Component
 *
 * DataTable of audit log entries with category filter and pagination.
 */

import { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { History } from 'lucide-react';
import { DataTable, type Column } from '../../../ui/DataTable';
import { Badge } from '../../../ui/Badge';
import { Button } from '../../../ui/Button';
import { useAuditLog, type AuditLogEntry } from '../../../../hooks/useAuditLog';

interface AuditLogSectionProps {
  indexId: string;
  connectorId: string;
}

const CATEGORIES = ['auth', 'config', 'sync', 'permission', 'lifecycle'] as const;
const PAGE_SIZE = 10;

export function AuditLogSection({ indexId, connectorId }: AuditLogSectionProps) {
  const t = useTranslations('search_ai.sharepoint.security');

  const [category, setCategory] = useState<string | undefined>(undefined);
  const [page, setPage] = useState(1);

  const { entries, total, isLoading } = useAuditLog(indexId, connectorId, {
    category,
    page,
    limit: PAGE_SIZE,
  });

  const totalPages = Math.ceil(total / PAGE_SIZE);

  const columns: Column<AuditLogEntry>[] = useMemo(
    () => [
      {
        key: 'timestamp',
        label: t('audit_col_time'),
        render: (row) => (
          <span className="text-xs text-muted">
            {new Date(row.createdAt).toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        ),
      },
      {
        key: 'actor',
        label: t('audit_col_actor'),
        render: (row) => <span className="text-sm text-foreground">{row.actor}</span>,
      },
      {
        key: 'event',
        label: t('audit_col_event'),
        render: (row) => <span className="text-sm font-mono text-foreground">{row.event}</span>,
      },
      {
        key: 'category',
        label: t('audit_col_category'),
        render: (row) => <Badge variant="default">{row.category}</Badge>,
      },
    ],
    [t],
  );

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
        <History className="w-4 h-4 text-muted" />
        {t('audit_title')}
      </h3>

      {/* Category filter */}
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => {
            setCategory(undefined);
            setPage(1);
          }}
          className={`text-xs px-2 py-1 rounded-md ${
            category === undefined
              ? 'bg-accent text-accent-foreground'
              : 'text-muted hover:text-foreground'
          }`}
        >
          {t('audit_filter_all')}
        </button>
        {CATEGORIES.map((cat) => (
          <button
            key={cat}
            onClick={() => {
              setCategory(cat);
              setPage(1);
            }}
            className={`text-xs px-2 py-1 rounded-md capitalize ${
              category === cat
                ? 'bg-accent text-accent-foreground'
                : 'text-muted hover:text-foreground'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="rounded-xl border border-default bg-background-elevated overflow-hidden">
        <DataTable
          columns={columns}
          data={entries}
          keyExtractor={(row) => row._id}
          emptyMessage={isLoading ? t('audit_loading') : t('audit_empty')}
        />
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted">
            {t('audit_page_info', { page, total: totalPages })}
          </span>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
            >
              {t('audit_prev')}
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
            >
              {t('audit_next')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
