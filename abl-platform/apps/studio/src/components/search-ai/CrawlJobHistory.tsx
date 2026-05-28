/**
 * CrawlJobHistory Component
 *
 * Cursor-paginated table of past crawl jobs, using the custom DataTable
 * component pattern from the studio design system.
 */

import { useState, useCallback } from 'react';
import useSWR from 'swr';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Clock, FileText, ChevronRight, Search, RotateCw, Trash2, Loader2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Badge, type BadgeVariant } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { getCrawlHistory, deleteCrawlJob } from '@/api/crawl';
import type { CrawlJob } from '@/api/crawl';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_VARIANT: Record<string, BadgeVariant> = {
  completed: 'success',
  failed: 'error',
  cancelled: 'error',
  queued: 'default',
  crawling: 'accent',
  ingesting: 'info',
  indexing: 'info',
};

function relativeTime(
  dateString: string,
  t: (key: string, params?: Record<string, string | number | Date>) => string,
): string {
  const diff = Date.now() - new Date(dateString).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return t('just_now');
  if (minutes < 60) return t('minutes_ago', { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('hours_ago', { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t('days_ago', { n: days });
  return new Date(dateString).toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Job row
// ---------------------------------------------------------------------------

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);

function JobRow({
  job,
  onClick,
  onRecrawl,
  onDelete,
  isDeleting,
  t,
}: {
  job: CrawlJob;
  onClick?: () => void;
  onRecrawl?: () => void;
  onDelete?: () => void;
  isDeleting?: boolean;
  t: (key: string, params?: Record<string, string | number | Date>) => string;
}) {
  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      <Card
        padding="md"
        hoverable={!!onClick}
        className={`flex items-center gap-4${onClick ? ' cursor-pointer' : ''}`}
      >
        {/* Status */}
        <Badge variant={STATUS_VARIANT[job.status] ?? 'default'} dot>
          {job.status}
        </Badge>

        {/* URLs */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground truncate">
            {job.urls.original[0]}
            {job.urls.original.length > 1 && (
              <span className="text-muted"> +{job.urls.original.length - 1}</span>
            )}
          </p>
          <p className="text-xs text-muted mt-0.5">
            {t('crawled_count', { count: job.urls.crawled })}
            {job.urls.failed > 0 && (
              <span className="text-error"> / {t('failed_count', { count: job.urls.failed })}</span>
            )}
          </p>
        </div>

        {/* Results */}
        <div className="text-right shrink-0">
          <p className="text-sm font-medium text-foreground">
            {t('docs_count', { count: job.results.documentsCreated })}
          </p>
          <p className="text-xs text-muted">
            {t('chunks_count', { count: job.results.chunksCreated })}
          </p>
        </div>

        {/* Strategy */}
        <Badge variant={job.strategy === 'intelligence' ? 'info' : 'default'} className="shrink-0">
          {job.strategy === 'intelligence' ? '⚡' : '⚙️'}{' '}
          {t(
            job.strategy === 'intelligence' ? 'strategy_badge_intelligence' : 'strategy_badge_bulk',
          )}
        </Badge>

        {/* Time */}
        <span className="text-xs text-muted shrink-0 w-16 text-right">
          {relativeTime(job.timeline.submittedAt, t)}
        </span>

        {/* Re-crawl */}
        {onRecrawl && ['completed', 'failed'].includes(job.status) && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRecrawl();
            }}
            className="p-1 rounded text-muted hover:text-accent shrink-0"
            title={t('recrawl_title')}
          >
            <RotateCw className="w-3.5 h-3.5" />
          </button>
        )}

        {/* Delete */}
        {onDelete && TERMINAL_STATES.has(job.status) && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            disabled={isDeleting}
            className="p-1 rounded text-muted hover:text-error shrink-0 disabled:opacity-50"
            title={t('delete_job_title')}
          >
            {isDeleting ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Trash2 className="w-3.5 h-3.5" />
            )}
          </button>
        )}

        {/* Click indicator */}
        {onClick && <ChevronRight className="w-4 h-4 text-muted shrink-0" />}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface CrawlJobHistoryProps {
  indexId: string;
  /** When provided, skip SWR fetch and use this pre-filtered list */
  externalJobs?: CrawlJob[];
  onSelectJob?: (jobId: string) => void;
  onRecrawl?: (urls: string[], strategy?: string) => void;
  onDeleteJob?: () => void;
}

export function CrawlJobHistory({
  indexId,
  externalJobs,
  onSelectJob,
  onRecrawl,
  onDeleteJob,
}: CrawlJobHistoryProps) {
  const t = useTranslations('search_ai.crawl_history');

  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<{ type: string; id?: string } | null>(null);
  const currentCursor = cursors[cursors.length - 1];

  const { data, isLoading, error, mutate } = useSWR(
    indexId && !externalJobs ? ['crawl-history', indexId, currentCursor] : null,
    () => getCrawlHistory(indexId, 20, currentCursor),
    { keepPreviousData: true },
  );

  const loadMore = useCallback(() => {
    if (data?.cursor) {
      setCursors((prev) => [...prev, data.cursor!]);
    }
  }, [data?.cursor]);

  const handleDelete = useCallback(
    async (jobId: string) => {
      setDeletingId(jobId);
      try {
        await deleteCrawlJob(jobId);
        await mutate();
        onDeleteJob?.();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('delete_failed'));
      } finally {
        setDeletingId(null);
      }
    },
    [mutate, onDeleteJob, t],
  );

  // ---------------------------------------------------------------------------
  // States
  // ---------------------------------------------------------------------------

  const isExternalMode = externalJobs !== undefined;
  const jobs = externalJobs ?? data?.jobs ?? [];

  if (error && !isExternalMode) {
    return (
      <div className="text-center py-8 text-sm text-error">
        {error instanceof Error ? error.message : t('load_history_failed')}
      </div>
    );
  }

  if (!isLoading && jobs.length === 0 && (isExternalMode || cursors.length === 1)) {
    return (
      <EmptyState
        icon={<FileText className="w-6 h-6" />}
        title={t('empty_title')}
        description={t('empty_description')}
      />
    );
  }

  // Client-side filtering
  const filteredJobs = jobs.filter((job) => {
    if (statusFilter !== 'all' && job.status !== statusFilter) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return job.urls.original.some((u: string) => u.toLowerCase().includes(q));
    }
    return true;
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-3">
      {/* Search and filters */}
      {!isExternalMode && (
        <div className="flex items-center gap-3">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
            <input
              type="text"
              placeholder={t('search_placeholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-sm border border-border rounded-lg bg-background text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-border-focus"
            />
          </div>
          <div className="flex gap-1">
            {(['all', 'completed', 'failed', 'crawling'] as const).map((s) => (
              <Button
                key={s}
                variant={statusFilter === s ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => setStatusFilter(s)}
              >
                {s === 'all'
                  ? t('filter_all')
                  : s === 'completed'
                    ? t('filter_completed')
                    : s === 'failed'
                      ? t('filter_failed')
                      : t('filter_crawling')}
              </Button>
            ))}
          </div>
        </div>
      )}

      {/* Column headers */}
      <div className="flex items-center gap-4 px-4 text-xs font-medium text-muted">
        <span className="w-20">{t('col_status')}</span>
        <span className="flex-1">{t('col_url')}</span>
        <span className="w-20 text-right">{t('col_results')}</span>
        <span className="w-16">{t('col_strategy')}</span>
        <span className="w-16 text-right">{t('col_when')}</span>
      </div>

      {/* Job rows */}
      {filteredJobs.map((job) => (
        <JobRow
          key={job._id}
          job={job}
          onClick={onSelectJob ? () => onSelectJob(job._id) : undefined}
          onRecrawl={onRecrawl ? () => onRecrawl(job.urls.original, job.strategy) : undefined}
          onDelete={() => setConfirmAction({ type: 'delete', id: job._id })}
          isDeleting={deletingId === job._id}
          t={t}
        />
      ))}

      {/* No results for filters */}
      {filteredJobs.length === 0 && jobs.length > 0 && (
        <div className="text-center py-8 text-sm text-muted">{t('no_matching_jobs')}</div>
      )}

      {/* Loading */}
      {isLoading && <div className="text-center py-4 text-sm text-muted">{t('loading')}</div>}

      {/* Load more */}
      {!isExternalMode && data?.hasMore && (
        <div className="flex justify-center pt-2">
          <Button variant="secondary" size="sm" onClick={loadMore} loading={isLoading}>
            {t('load_more')}
          </Button>
        </div>
      )}

      {/* Confirm delete dialog */}
      <ConfirmDialog
        open={confirmAction?.type === 'delete'}
        onClose={() => setConfirmAction(null)}
        onConfirm={() => {
          if (confirmAction?.id) {
            handleDelete(confirmAction.id);
          }
          setConfirmAction(null);
        }}
        title={t('confirm_delete_title')}
        description={t('confirm_delete_desc')}
        variant="danger"
        loading={deletingId != null}
      />
    </div>
  );
}
