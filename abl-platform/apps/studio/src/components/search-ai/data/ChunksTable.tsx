/**
 * ChunksTable Component
 *
 * Paginated table showing all chunks across all documents for an index.
 * Supports status filtering, content search, and opens ChunkExplorerDialog on row click.
 */

import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Layers, Search, ChevronLeft, ChevronRight } from 'lucide-react';
import useSWR from 'swr';
import { Badge, type BadgeVariant } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { DataTable, type Column } from '../../ui/DataTable';
import { EmptyState } from '../../ui/EmptyState';
import { Input } from '../../ui/Input';
import { ChunkExplorerDialog } from '../ChunkExplorer';
import { fetchAllChunks } from '../../../api/search-ai';
import type { SearchAIChunk } from '../../../api/search-ai';

/** Extract a readable name from a title that may be a URL or source name. */
function displayDocTitle(title: string | undefined | null): string {
  if (!title) return '\u2014';
  if (title.startsWith('http://') || title.startsWith('https://')) {
    try {
      const pathname = new URL(title).pathname;
      const lastSegment = pathname.split('/').filter(Boolean).pop();
      if (lastSegment) return decodeURIComponent(lastSegment);
    } catch {
      // fall through
    }
  }
  return title;
}

interface ChunksTableProps {
  indexId: string;
}

const PAGE_SIZE = 20;

const CHUNK_STATUSES = ['pending', 'embedded', 'indexed', 'filtered', 'error'] as const;

const statusVariant: Record<string, BadgeVariant> = {
  pending: 'default',
  embedded: 'info',
  indexed: 'success',
  filtered: 'warning',
  error: 'error',
};

function formatDate(iso: string | null): string {
  if (!iso) return '\u2014';
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function truncate(text: string | undefined, maxLen: number): string {
  if (!text) return '\u2014';
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '\u2026';
}

export function ChunksTable({ indexId }: ChunksTableProps) {
  const t = useTranslations('search_ai.chunks_table');

  const [offset, setOffset] = useState(0);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ChunkExplorer dialog state
  const [explorerState, setExplorerState] = useState<{
    open: boolean;
    documentId: string;
    documentTitle: string;
  }>({ open: false, documentId: '', documentTitle: '' });

  // Reset all state when indexId changes
  const [prevIndexId, setPrevIndexId] = useState(indexId);
  if (indexId !== prevIndexId) {
    setPrevIndexId(indexId);
    setOffset(0);
    setStatusFilter(null);
    setSearchInput('');
    setDebouncedSearch('');
    setExplorerState({ open: false, documentId: '', documentTitle: '' });
  }

  // Reset offset on filter change
  const filterKey = `${statusFilter ?? 'all'}-${debouncedSearch}`;
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
  if (filterKey !== prevFilterKey) {
    setPrevFilterKey(filterKey);
    setOffset(0);
  }

  // Debounce search with proper cleanup
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(value);
    }, 300);
  }, []);

  const swrKey = useMemo(
    () =>
      `/api/search-ai/indexes/${indexId}/chunks?limit=${PAGE_SIZE}&offset=${offset}` +
      `${statusFilter ? `&status=${statusFilter}` : ''}` +
      `${debouncedSearch ? `&search=${encodeURIComponent(debouncedSearch)}` : ''}`,
    [indexId, offset, statusFilter, debouncedSearch],
  );

  const { data, isLoading, error, mutate } = useSWR(indexId ? swrKey : null, () =>
    fetchAllChunks(indexId, {
      limit: PAGE_SIZE,
      offset,
      status: statusFilter ? [statusFilter] : undefined,
      search: debouncedSearch || undefined,
      includeContent: true,
    }),
  );

  const chunks = data?.chunks ?? [];
  const pagination = data?.pagination;
  const total = pagination?.total ?? 0;
  const hasMore = pagination?.hasMore ?? false;

  const showingStart = total > 0 ? offset + 1 : 0;
  const showingEnd = Math.min(offset + PAGE_SIZE, total);

  // Use server-side status counts (aggregated across all chunks, not just current page)
  const statusCounts = data?.statusCounts ?? {};

  const handleRowClick = useCallback((row: SearchAIChunk) => {
    if (row.documentId) {
      setExplorerState({
        open: true,
        documentId: row.documentId,
        documentTitle: row.documentTitle ?? '',
      });
    }
  }, []);

  const columns: Column<SearchAIChunk>[] = useMemo(
    () => [
      {
        key: 'chunkIndex',
        label: t('col_index'),
        width: 'w-16',
        sortable: true,
        sortValue: (row) => row.chunkIndex,
        render: (row) => <span className="text-xs text-muted font-mono">{row.chunkIndex}</span>,
      },
      {
        key: 'document',
        label: t('col_document'),
        render: (row) => (
          <span className="font-medium text-foreground text-sm">
            {displayDocTitle(row.documentTitle)}
          </span>
        ),
      },
      {
        key: 'status',
        label: t('col_status'),
        render: (row) => (
          <Badge variant={statusVariant[row.status] ?? 'default'} dot>
            {row.status}
          </Badge>
        ),
      },
      {
        key: 'tokens',
        label: t('col_tokens'),
        width: 'w-20',
        sortable: true,
        sortValue: (row) => row.tokenCount,
        render: (row) => (
          <span className="text-xs text-muted font-mono">{row.tokenCount.toLocaleString()}</span>
        ),
      },
      {
        key: 'content',
        label: t('col_content'),
        render: (row) => <span className="text-xs text-muted">{truncate(row.content, 80)}</span>,
      },
      {
        key: 'created',
        label: t('col_created'),
        render: (row) => <span className="text-xs text-muted">{formatDate(row.createdAt)}</span>,
      },
    ],
    [t],
  );

  // Error state
  if (error) {
    return (
      <div className="rounded-xl border border-error/30 bg-error/10 p-6 text-center">
        <p className="text-sm text-error">{t('error_loading')}</p>
        <Button variant="ghost" size="sm" onClick={() => mutate()} className="mt-2">
          {t('retry')}
        </Button>
      </div>
    );
  }

  // Loading state
  if (isLoading) {
    return (
      <div className="rounded-xl border border-default bg-background-elevated overflow-hidden">
        <div className="animate-pulse space-y-0">
          <div className="grid grid-cols-6 gap-4 px-4 py-3 border-b border-default bg-background-muted">
            {['w-8', 'w-24', 'w-14', 'w-12', 'w-32', 'w-20'].map((w, i) => (
              <div key={i} className={`h-3 ${w} bg-background-elevated rounded`} />
            ))}
          </div>
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="grid grid-cols-6 gap-4 px-4 py-3 border-b border-default last:border-0"
            >
              <div className="h-3 w-6 bg-background-muted rounded" />
              <div className="h-3 w-32 bg-background-muted rounded" />
              <div className="h-5 w-14 bg-background-muted rounded-full" />
              <div className="h-3 w-10 bg-background-muted rounded" />
              <div className="h-3 w-40 bg-background-muted rounded" />
              <div className="h-3 w-16 bg-background-muted rounded" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Empty state
  if (chunks.length === 0 && !debouncedSearch && !statusFilter) {
    return (
      <EmptyState
        icon={<Layers className="w-6 h-6" />}
        title={t('empty_title')}
        description={t('empty_description')}
      />
    );
  }

  return (
    <div className="space-y-3">
      {/* Stats bar — all counts are server-side aggregates */}
      <div className="flex items-center gap-4 text-xs text-muted px-1">
        <span>{t('stats_total', { count: total })}</span>
        {statusCounts['indexed'] ? (
          <span className="text-success">
            {t('stats_indexed', { count: statusCounts['indexed'] })}
          </span>
        ) : null}
        {statusCounts['embedded'] ? (
          <span className="text-info">
            {t('stats_embedded', { count: statusCounts['embedded'] })}
          </span>
        ) : null}
        {statusCounts['pending'] ? (
          <span>{t('stats_pending', { count: statusCounts['pending'] })}</span>
        ) : null}
        {statusCounts['error'] ? (
          <span className="text-error">{t('stats_error', { count: statusCounts['error'] })}</span>
        ) : null}
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-3">
        {/* Status filter chips */}
        <div
          className="flex items-center gap-1.5"
          role="group"
          aria-label={t('filter_group_label')}
        >
          <button
            onClick={() => setStatusFilter(null)}
            aria-pressed={statusFilter === null}
            className={`px-2.5 py-1 rounded-full text-xs font-medium transition-default ${
              statusFilter === null
                ? 'bg-accent text-accent-foreground'
                : 'bg-background-muted text-muted hover:text-foreground'
            }`}
          >
            {t('filter_all_statuses')}
          </button>
          {CHUNK_STATUSES.map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(statusFilter === s ? null : s)}
              aria-pressed={statusFilter === s}
              aria-label={t('filter_by_status', { status: s })}
              className={`px-2.5 py-1 rounded-full text-xs font-medium transition-default ${
                statusFilter === s
                  ? 'bg-accent text-accent-foreground'
                  : 'bg-background-muted text-muted hover:text-foreground'
              }`}
            >
              {s}
            </button>
          ))}
        </div>

        {/* Search input */}
        <div className="ml-auto w-64">
          <Input
            icon={<Search className="w-4 h-4" />}
            placeholder={t('search_placeholder')}
            value={searchInput}
            onChange={(e) => handleSearchChange(e.target.value)}
          />
        </div>
      </div>

      {/* Table */}
      {chunks.length === 0 ? (
        <EmptyState
          icon={<Layers className="w-6 h-6" />}
          title={t('empty_title')}
          description={t('empty_description')}
        />
      ) : (
        <div className="rounded-xl border border-default bg-background-elevated overflow-hidden">
          <DataTable
            columns={columns}
            data={chunks}
            keyExtractor={(row) => row.id}
            onRowClick={handleRowClick}
          />
        </div>
      )}

      {/* Pagination */}
      {total > 0 && (
        <div className="flex items-center justify-between px-1">
          <span className="text-xs text-muted">
            {t('page_info', { from: showingStart, to: showingEnd, total })}
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="xs"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              aria-label={t('prev_page')}
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="xs"
              disabled={!hasMore}
              onClick={() => setOffset(offset + PAGE_SIZE)}
              aria-label={t('next_page')}
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Chunk Explorer Dialog */}
      <ChunkExplorerDialog
        open={explorerState.open}
        onClose={() => setExplorerState({ open: false, documentId: '', documentTitle: '' })}
        indexId={indexId}
        documentId={explorerState.documentId}
        documentTitle={explorerState.documentTitle}
        totalChunks={0}
      />
    </div>
  );
}
