/**
 * QuickFilterPills Component
 *
 * Horizontal row of clickable status count pills for quick filtering.
 * Each pill shows the status name and count; clicking toggles the filter.
 */

import { useTranslations } from 'next-intl';
import { Badge, type BadgeVariant } from '../../ui/Badge';

interface QuickFilterPillsProps {
  statusCounts: Record<string, number>;
  activeStatus: string | null;
  onStatusClick: (status: string | null) => void;
}

const pillVariant: Record<string, BadgeVariant> = {
  active: 'success',
  syncing: 'info',
  crawling: 'info',
  error: 'error',
  auth_failed: 'error',
  awaiting_auth: 'warning',
  partial: 'warning',
  pending: 'default',
  disabled: 'default',
  draft: 'default',
};

export function QuickFilterPills({
  statusCounts,
  activeStatus,
  onStatusClick,
}: QuickFilterPillsProps) {
  const t = useTranslations('search_ai.sources_table.toolbar');

  const statuses = Object.entries(statusCounts).filter(([, count]) => count > 0);

  if (statuses.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
      <button
        onClick={() => onStatusClick(null)}
        className={`shrink-0 transition-default ${
          activeStatus === null ? 'ring-2 ring-accent ring-offset-1 rounded-full' : ''
        }`}
        aria-label={t('filter_all')}
      >
        <Badge variant="default">{t('filter_all')}</Badge>
      </button>
      {statuses.map(([status, count]) => (
        <button
          key={status}
          onClick={() => onStatusClick(activeStatus === status ? null : status)}
          className={`shrink-0 transition-default ${
            activeStatus === status ? 'ring-2 ring-accent ring-offset-1 rounded-full' : ''
          }`}
          aria-label={`${status}: ${count}`}
        >
          <Badge variant={pillVariant[status] ?? 'default'} dot>
            {status} ({count})
          </Badge>
        </button>
      ))}
    </div>
  );
}
