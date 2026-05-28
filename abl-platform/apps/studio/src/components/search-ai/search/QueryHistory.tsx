/**
 * QueryHistory Component
 *
 * Displays recent search queries with performance metrics.
 * Each row shows query text, type badge, result count, latency, and timestamp.
 * Supports selection for side-by-side comparison.
 */

'use client';

import { useState, useCallback } from 'react';
import { Clock, Loader2, RefreshCw, Zap } from 'lucide-react';
import { useTranslations } from 'next-intl';
import useSWR from 'swr';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { fetchQueryHistory } from '../../../api/search-ai';
import type { QueryHistoryItem } from '../../../api/search-ai';

interface QueryHistoryProps {
  indexId: string;
  onSelectQuery?: (query: QueryHistoryItem) => void;
  selectedIds?: Set<string>;
}

const PAGE_SIZE = 10;

const TYPE_VARIANT: Record<string, 'accent' | 'info' | 'purple'> = {
  hybrid: 'accent',
  vector: 'info',
  structured: 'purple',
};

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export function QueryHistory({ indexId, onSelectQuery, selectedIds }: QueryHistoryProps) {
  const t = useTranslations('search_ai.query_history');
  const [allQueries, setAllQueries] = useState<QueryHistoryItem[]>([]);
  const [offset, setOffset] = useState(0);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);

  const swrKey = `/api/search-ai/indexes/${indexId}/query-history?limit=${PAGE_SIZE}&offset=0`;

  const { data, error, isLoading, mutate } = useSWR(
    swrKey,
    () => fetchQueryHistory(indexId, { limit: PAGE_SIZE, offset: 0 }),
    { revalidateOnFocus: false },
  );

  const handleLoadMore = useCallback(async () => {
    const nextOffset = offset + PAGE_SIZE;
    setIsLoadingMore(true);
    setLoadMoreError(false);
    try {
      const moreData = await fetchQueryHistory(indexId, { limit: PAGE_SIZE, offset: nextOffset });
      const current = allQueries.length > 0 ? allQueries : (data?.queries ?? []);
      setAllQueries([...current, ...moreData.queries]);
      setOffset(nextOffset);
    } catch (_err) {
      setLoadMoreError(true);
    } finally {
      setIsLoadingMore(false);
    }
  }, [offset, indexId, allQueries, data?.queries]);

  const handleRefresh = useCallback(() => {
    setOffset(0);
    setAllQueries([]);
    mutate();
  }, [mutate]);

  // Error state
  if (error && !data) {
    return (
      <div className="text-sm text-error bg-error-subtle rounded-lg px-4 py-3">{t('error')}</div>
    );
  }

  // Loading state
  if (isLoading && !data) {
    return (
      <div className="flex items-center justify-center py-8 text-muted">
        <Loader2 className="w-4 h-4 animate-spin mr-2" />
        <span className="text-sm">{t('title')}</span>
      </div>
    );
  }

  const queries = allQueries.length > 0 ? allQueries : (data?.queries ?? []);
  const hasMore =
    allQueries.length > 0 ? offset + PAGE_SIZE < (data?.total ?? 0) : (data?.hasMore ?? false);

  // Empty state
  if (queries.length === 0 && offset === 0) {
    return <div className="text-sm text-muted py-6 text-center">{t('empty')}</div>;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-medium text-foreground">{t('title')}</h4>
          {data && <span className="text-xs text-muted">({data.total})</span>}
        </div>
        <Button
          variant="ghost"
          size="xs"
          onClick={handleRefresh}
          icon={<RefreshCw className="w-3 h-3" />}
          aria-label={t('refresh')}
        >
          {null}
        </Button>
      </div>

      <div className="space-y-1">
        {queries.map((q) => {
          const isSelected = selectedIds?.has(q.queryId);
          return (
            <button
              key={q.queryId}
              type="button"
              onClick={() => onSelectQuery?.(q)}
              className={`w-full text-left rounded-lg px-3 py-2 transition-default text-sm ${
                isSelected ? 'bg-accent-subtle ring-1 ring-accent' : 'hover:bg-background-elevated'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium text-foreground flex-1 min-w-0">
                  {q.queryText}
                </span>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge variant={TYPE_VARIANT[q.queryType] ?? 'default'}>{q.queryType}</Badge>
                  {q.cacheHit && (
                    <Badge variant="success">
                      <Zap className="w-3 h-3" />
                      {t('cache_hit')}
                    </Badge>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3 mt-1 text-xs text-muted">
                <span>{t('result_count', { count: q.resultCount })}</span>
                <span>{t('latency', { ms: q.totalLatencyMs })}</span>
                <span className="flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {formatTimestamp(q.timestamp)}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {loadMoreError && <p className="text-xs text-error text-center py-1">{t('error')}</p>}
      {hasMore && (
        <div className="pt-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleLoadMore}
            className="w-full"
            disabled={isLoadingMore}
            loading={isLoadingMore}
          >
            {t('load_more')}
          </Button>
        </div>
      )}
    </div>
  );
}
