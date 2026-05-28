/**
 * CrawledPagesView Component — Crawl-Centric Redesign
 *
 * Shows crawled pages with two-state per-URL status (Crawl + Index),
 * filter bar (All/Indexed/Processing/Error) for pipeline status,
 * merged crawlErrors, and error pagination.
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  CheckCircle2,
  XCircle,
  Search,
  FileText,
  Download,
  Trash2,
  RefreshCw,
  Loader2,
  Eye,
  AlertTriangle,
  Ban,
  MinusCircle,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ChunkExplorerDialog } from './ChunkExplorer';
import {
  getCrawledPages,
  deleteCrawledPage,
  deleteAllCrawledPages,
  submitBatchCrawl,
} from '@/api/crawl';
import type { CrawledPage, CrawlErrorEntry } from '@/api/crawl';
import { ErrorGroupingPanel } from './source-page/ErrorGroupingPanel';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateUrl(url: string, maxLength = 60): string {
  if (url.length <= maxLength) return url;
  return url.slice(0, maxLength) + '\u2026';
}

type StatusFilter = 'all' | 'indexed' | 'processing' | 'error';

// ---------------------------------------------------------------------------
// Crawl Status + Index Status icons
// ---------------------------------------------------------------------------

function CrawlStatusIcon({ status }: { status: 'fetched' | 'failed' | 'blocked' }) {
  switch (status) {
    case 'fetched':
      return (
        <span title="Crawl: Fetched">
          <CheckCircle2 className="w-4 h-4 text-success shrink-0" />
        </span>
      );
    case 'failed':
      return (
        <span title="Crawl: Failed">
          <XCircle className="w-4 h-4 text-error shrink-0" />
        </span>
      );
    case 'blocked':
      return (
        <span title="Crawl: Blocked">
          <Ban className="w-4 h-4 text-warning shrink-0" />
        </span>
      );
  }
}

function IndexStatusIcon({ status }: { status: string | null }) {
  if (status === null)
    return (
      <span title="Index: N/A">
        <MinusCircle className="w-4 h-4 text-muted/40 shrink-0" />
      </span>
    );
  if (status === 'indexed')
    return (
      <span title="Index: Indexed">
        <CheckCircle2 className="w-4 h-4 text-success shrink-0" />
      </span>
    );
  if (status === 'error')
    return (
      <span title="Index: Error">
        <XCircle className="w-4 h-4 text-error shrink-0" />
      </span>
    );
  // Processing states: extracting, enriching, embedding, etc.
  return (
    <span title={`Index: ${status}`}>
      <Loader2 className="w-4 h-4 text-info animate-spin shrink-0" />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Page row
// ---------------------------------------------------------------------------

interface PageRowProps {
  page: CrawledPage;
  isDeleting: boolean;
  onDelete: (page: CrawledPage) => void;
  onRetry: (page: CrawledPage) => void;
  onView: (page: CrawledPage) => void;
  t: ReturnType<typeof useTranslations>;
}

function PageRow({ page, isDeleting, onDelete, onRetry, onView, t }: PageRowProps) {
  return (
    <Card padding="md" hoverable={false} className="flex items-center gap-4">
      {/* Crawl Status */}
      <CrawlStatusIcon status="fetched" />

      {/* Index Status */}
      <IndexStatusIcon status={page.status === 'indexed' ? 'indexed' : page.status} />

      {/* Method icon */}
      {page.method === 'http' && (
        <span
          className="shrink-0 text-sm"
          role="img"
          aria-label={t('method_http')}
          title={t('method_http')}
        >
          {'\u26A1'}
        </span>
      )}
      {page.method === 'playwright' && (
        <span
          className="shrink-0 text-sm"
          role="img"
          aria-label={t('method_playwright')}
          title={t('method_playwright')}
        >
          {'\u{1F50D}'}
        </span>
      )}

      {/* URL */}
      <div className="flex-1 min-w-0">
        <a
          href={page.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-medium text-foreground hover:text-info truncate block"
          title={page.url}
        >
          {truncateUrl(page.url)}
        </a>
        {page.error && <p className="text-xs text-error mt-0.5 truncate">{page.error}</p>}
      </div>

      {/* Quality badge */}
      {page.quality === 'rich' && (
        <Badge variant="success" className="shrink-0">
          {t('quality_rich')}
        </Badge>
      )}
      {page.quality === 'standard' && (
        <Badge variant="warning" className="shrink-0">
          {t('quality_standard')}
        </Badge>
      )}
      {page.quality === 'thin' && (
        <Badge variant="error" className="shrink-0">
          {t('quality_thin')}
        </Badge>
      )}

      {/* Quality score — backend stores 0-1, display as percentage */}
      {page.qualityScore != null && (
        <span className="text-xs text-muted shrink-0" title="Quality score">
          {Math.round(page.qualityScore * 100)}%
        </span>
      )}

      {/* View content — only show when there are chunks to view */}
      {page.documentId && page.chunks > 0 && (
        <button
          type="button"
          onClick={() => onView(page)}
          className="flex items-center gap-1 text-xs text-info hover:underline shrink-0"
          title={page.status === 'error' ? t('view_partial_title') : t('view_page_title')}
        >
          <Eye className="w-3 h-3" />
          {page.status === 'error' ? t('view_partial') : t('view')}
        </button>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-1 shrink-0">
        {page.status === 'error' && (
          <button
            type="button"
            onClick={() => onRetry(page)}
            className="p-1.5 rounded-md text-muted hover:text-accent hover:bg-accent/10 transition-colors"
            title={t('retry_failed_page')}
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={() => onDelete(page)}
          disabled={isDeleting}
          className="p-1.5 rounded-md text-muted hover:text-error hover:bg-error/10 transition-colors disabled:opacity-50"
          title={t('delete_page')}
        >
          {isDeleting ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Trash2 className="w-3.5 h-3.5" />
          )}
        </button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// CrawlError row
// ---------------------------------------------------------------------------

function CrawlErrorRow({
  entry,
  t,
}: {
  entry: CrawlErrorEntry;
  t: ReturnType<typeof useTranslations>;
}) {
  const errorTypeKey = `error_types.${entry.type}` as Parameters<typeof t>[0];
  const errorLabel = t(errorTypeKey);

  return (
    <Card padding="md" hoverable={false} className="flex items-center gap-4">
      {/* Crawl Status: failed or blocked */}
      <CrawlStatusIcon
        status={
          entry.type === 'robots_blocked' ||
          entry.type === 'quality_gated' ||
          entry.type === 'content_filtered'
            ? 'blocked'
            : 'failed'
        }
      />

      {/* Index Status: N/A */}
      <IndexStatusIcon status={null} />

      {/* URL */}
      <div className="flex-1 min-w-0">
        <a
          href={entry.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-medium text-foreground hover:text-info truncate block"
          title={entry.url}
        >
          {truncateUrl(entry.url)}
        </a>
        <p className="text-xs text-error mt-0.5 truncate">{entry.error}</p>
      </div>

      {/* Error type badge */}
      <Badge variant="error" className="shrink-0">
        {errorLabel}
      </Badge>

      {/* Status code */}
      {entry.statusCode && <span className="text-xs text-muted shrink-0">{entry.statusCode}</span>}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface CrawledPagesViewProps {
  jobId: string;
  indexId: string;
  sourceId: string;
  /** SWR refresh interval in ms. Pass 5000 during active crawl, undefined otherwise. */
  refreshInterval?: number;
}

export function CrawledPagesView({
  jobId,
  indexId,
  sourceId,
  refreshInterval,
}: CrawledPagesViewProps) {
  const t = useTranslations('search_ai.crawled_pages');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [errorOffset, setErrorOffset] = useState(0);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [viewingPage, setViewingPage] = useState<CrawledPage | null>(null);
  const [confirmAction, setConfirmAction] = useState<{
    type: string;
    data?: CrawledPage;
  } | null>(null);
  const pageSize = 20;
  const errorPageSize = 50;
  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const { mutate } = useSWRConfig();

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const { data, isLoading, error } = useSWR(
    jobId ? ['crawled-pages', jobId, statusFilter, debouncedSearch, offset, errorOffset] : null,
    () =>
      getCrawledPages(jobId, {
        limit: pageSize,
        offset,
        status: statusFilter,
        search: debouncedSearch || undefined,
        errorLimit: errorPageSize,
        errorOffset,
      }),
    { keepPreviousData: true, refreshInterval },
  );

  const handleSearch = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setSearchQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(value);
      setOffset(0);
      setErrorOffset(0);
    }, 300);
  }, []);

  const handleFilterChange = useCallback((filter: StatusFilter) => {
    setStatusFilter(filter);
    setOffset(0);
    setErrorOffset(0);
  }, []);

  const swrKeyPrefix = 'crawled-pages';

  const mutateCrawledPages = useCallback(() => {
    mutate(
      (key: unknown) => Array.isArray(key) && key[0] === swrKeyPrefix && key[1] === jobId,
      undefined,
      { revalidate: true },
    );
  }, [mutate, jobId]);

  const handleDeletePage = useCallback((page: CrawledPage) => {
    if (!page.documentId) return;
    setConfirmAction({ type: 'delete_page', data: page });
  }, []);

  const executeDeletePage = useCallback(async () => {
    const page = confirmAction?.data;
    if (!page?.documentId) return;
    setConfirmAction(null);
    setDeletingId(page.documentId);
    try {
      await deleteCrawledPage(indexId, page.documentId);
      mutateCrawledPages();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('delete_failed'));
    } finally {
      setDeletingId(null);
    }
  }, [confirmAction, indexId, mutateCrawledPages, t]);

  const handleDeleteAll = useCallback(() => {
    setConfirmAction({ type: 'delete_all' });
  }, []);

  const executeDeleteAll = useCallback(async () => {
    setConfirmAction(null);
    try {
      await deleteAllCrawledPages(jobId);
      mutateCrawledPages();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('delete_all_failed'));
    }
  }, [jobId, mutateCrawledPages, t]);

  const handleRetry = useCallback(
    async (page: CrawledPage) => {
      try {
        await submitBatchCrawl({
          urls: [page.url],
          indexId,
          sourceId,
          strategy: 'single-page',
        });
        toast.success(t('retry_submitted', { url: truncateUrl(page.url, 50) }));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('retry_failed'));
      }
    },
    [indexId, sourceId, t],
  );

  const handleViewPage = useCallback((page: CrawledPage) => {
    if (!page.documentId) return;
    setViewingPage(page);
  }, []);

  // ---------------------------------------------------------------------------
  // Derived data
  // ---------------------------------------------------------------------------

  const pages = data?.pages ?? [];
  const crawlErrors = data?.crawlErrors ?? [];
  const total = data?.pagination?.total ?? 0;
  const totalErrors = data?.totalErrors ?? 0;
  const totalFailed = data?.totalFailed ?? 0;
  const totalBlocked = data?.totalBlocked ?? 0;

  // ---------------------------------------------------------------------------
  // States
  // ---------------------------------------------------------------------------

  if (error) {
    return (
      <div className="text-center py-8 text-sm text-error">
        {error instanceof Error ? error.message : t('load_failed')}
      </div>
    );
  }

  if (
    !isLoading &&
    pages.length === 0 &&
    crawlErrors.length === 0 &&
    offset === 0 &&
    !searchQuery &&
    statusFilter === 'all'
  ) {
    // During active crawl, show a contextual message instead of static empty state
    if (refreshInterval) {
      return (
        <div className="text-center py-8 text-sm text-muted">{t('crawl_in_progress_empty')}</div>
      );
    }
    return (
      <EmptyState
        icon={<FileText className="w-6 h-6" />}
        title={t('empty_title')}
        description={t('empty_description')}
      />
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-4">
      {/* Search + filter bar */}
      <div className="flex items-center gap-3">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
          <input
            type="text"
            placeholder={t('search_placeholder')}
            value={searchQuery}
            onChange={handleSearch}
            className="w-full pl-9 pr-3 py-2 text-sm border border-border rounded-lg bg-background text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-border-focus"
          />
        </div>

        {/* Filter tabs */}
        <div className="flex gap-1">
          {(['all', 'indexed', 'processing', 'error'] as const).map((s) => (
            <Button
              key={s}
              variant={statusFilter === s ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => handleFilterChange(s)}
            >
              {t(`filter_${s}` as Parameters<typeof t>[0])}
            </Button>
          ))}
        </div>

        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            const esc = (str: string) => `"${str.replace(/"/g, '""')}"`;
            const csv = [
              'URL,CrawlStatus,IndexStatus,Chunks,Quality,Error',
              ...pages.map(
                (p) =>
                  `${esc(p.url)},fetched,${esc(p.status)},${p.chunks || 0},${esc(p.quality || '')},${esc(p.error || '')}`,
              ),
              ...crawlErrors.map(
                (e) =>
                  `${esc(e.url)},${e.type.includes('blocked') || e.type.includes('gated') || e.type.includes('filtered') ? 'blocked' : 'failed'},N/A,0,,${esc(e.error)}`,
              ),
            ].join('\n');
            const blob = new Blob([csv], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `crawl-pages-${jobId}.csv`;
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          <Download className="w-3.5 h-3.5 mr-1" />
          {t('export')}
        </Button>

        <Button
          variant="secondary"
          size="sm"
          onClick={handleDeleteAll}
          disabled={total === 0}
          className="text-error hover:bg-error/10"
        >
          <Trash2 className="w-3.5 h-3.5 mr-1" />
          {t('delete_all_pages')}
        </Button>
      </div>

      {/* Pages table */}
      {pages.length > 0 && (
        <div className="space-y-2">
          {pages.map((page, idx) => (
            <PageRow
              key={`page-${page.url}-${idx}`}
              page={page}
              isDeleting={!!(page.documentId && deletingId === page.documentId)}
              onDelete={handleDeletePage}
              onRetry={handleRetry}
              onView={handleViewPage}
              t={t}
            />
          ))}
        </div>
      )}

      {/* No results for active filter/search */}
      {!isLoading &&
        pages.length === 0 &&
        crawlErrors.length === 0 &&
        (statusFilter !== 'all' || searchQuery) && (
          <div className="text-center py-8 text-sm text-muted">{t('no_matching_pages')}</div>
        )}

      {/* Pages pagination */}
      {data?.pagination?.hasMore && (
        <div className="flex justify-center pt-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setOffset((prev) => prev + pageSize)}
            loading={isLoading}
          >
            {t('load_more')}
          </Button>
        </div>
      )}

      {/* Crawl errors section */}
      {crawlErrors.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium text-muted">
            <AlertTriangle className="w-4 h-4" />
            <span>
              {t('crawl_status')} — {totalErrors} {t('filter_failed').toLowerCase()}
            </span>
          </div>
          {crawlErrors.map((entry, idx) => (
            <CrawlErrorRow key={`error-${entry.url}-${idx}`} entry={entry} t={t} />
          ))}
        </div>
      )}

      {/* Error pagination */}
      {data?.errorPagination?.hasMore && (
        <div className="flex justify-center pt-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setErrorOffset((prev) => prev + errorPageSize)}
            loading={isLoading}
          >
            {t('load_more')}
          </Button>
        </div>
      )}

      {/* Error Grouping Panel — separates crawl errors from pipeline errors */}
      <ErrorGroupingPanel
        jobId={jobId}
        indexId={indexId}
        sourceId={sourceId}
        crawlErrors={crawlErrors}
        pipelineErrors={pages.filter((p) => p.status === 'error')}
        totalFailed={totalFailed}
        totalBlocked={totalBlocked}
      />

      {/* Legend */}
      <div className="flex items-center gap-4 text-xs text-muted mt-2 px-2">
        <span>
          {'\u26A1'} {t('method_http')}
        </span>
        <span>
          {'\u{1F50D}'} {t('method_playwright')}
        </span>
        <span className="flex items-center gap-1">
          <CheckCircle2 className="w-3 h-3 text-success" /> {t('crawl_status')}
        </span>
        <span className="flex items-center gap-1">
          <XCircle className="w-3 h-3 text-error" /> {t('filter_failed')}
        </span>
        <span className="flex items-center gap-1">
          <Ban className="w-3 h-3 text-warning" /> {t('filter_blocked')}
        </span>
      </div>

      {/* Loading */}
      {isLoading && <div className="text-center py-4 text-sm text-muted">{t('loading')}</div>}

      {/* Confirm delete page */}
      <ConfirmDialog
        open={confirmAction?.type === 'delete_page'}
        onClose={() => setConfirmAction(null)}
        onConfirm={executeDeletePage}
        title={t('confirm_delete_page_title')}
        description={
          confirmAction?.data
            ? t('confirm_delete_page_description', { url: truncateUrl(confirmAction.data.url, 80) })
            : ''
        }
        confirmLabel={t('confirm_delete')}
        variant="danger"
      />

      {/* Confirm delete all */}
      <ConfirmDialog
        open={confirmAction?.type === 'delete_all'}
        onClose={() => setConfirmAction(null)}
        onConfirm={executeDeleteAll}
        title={t('confirm_delete_all_title')}
        description={t('confirm_delete_all_description')}
        confirmLabel={t('confirm_delete_all')}
        variant="danger"
      />

      {/* Chunk Explorer Dialog */}
      {viewingPage && viewingPage.documentId && (
        <ChunkExplorerDialog
          open={!!viewingPage}
          onClose={() => setViewingPage(null)}
          indexId={indexId}
          documentId={viewingPage.documentId}
          documentTitle={truncateUrl(viewingPage.url, 80)}
          totalChunks={viewingPage.chunks}
        />
      )}
    </div>
  );
}
