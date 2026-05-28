/**
 * useFeedback Hook
 *
 * Fetches the project's recent feedback page from `/api/runtime/feedback`
 * with optional filter parameters. Cursor-based pagination — returns
 * `loadMore()` plus the accumulated items.
 *
 * Backs the Studio Insights → Feedback viewer (ABLP-1084).
 *
 * The hook is intentionally quiet: SWR auto-revalidation (focus, reconnect,
 * stale, retry, interval) is fully disabled. A fetch fires only when:
 *   • the component mounts
 *   • the filter selection changes
 *   • the user clicks "Load more" (cursor advances)
 *   • the caller invokes `refresh()`
 *
 * The date range is computed once per `dateRange` selection and explicit
 * refresh (via useMemo) so the SWR key stays stable across ordinary renders
 * while still advancing `to=now` when the user refreshes.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { useNavigationStore } from '../store/navigation-store';

// =============================================================================
// TYPES
// =============================================================================

export interface FeedbackFilters {
  dateRange?: '7d' | '30d' | '90d';
  agentName?: string;
  channel?: string;
  ratingType?: 'thumbs' | 'star' | 'text';
  ratingValue?: number;
  hasText?: boolean;
  sessionId?: string;
  messageId?: string;
}

export interface FeedbackItem {
  feedbackId: string;
  timestamp: string;
  sessionId: string;
  messageId: string;
  agentName: string;
  channel: string;
  ratingType: 'thumbs' | 'star' | 'text';
  ratingValue: number;
  feedbackText: string;
  hasText: boolean;
  source: string;
  ingress: string;
}

interface FeedbackResponse {
  success: boolean;
  data?: { items: FeedbackItem[]; nextCursor: string | null };
  error?: { code: string; message: string };
}

const DEFAULT_PAGE_SIZE = 50;

function computeDateRangeBounds(range: FeedbackFilters['dateRange']): {
  from?: string;
  to?: string;
} {
  if (!range) return {};
  const days = range === '7d' ? 7 : range === '90d' ? 90 : 30;
  const now = new Date();
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: now.toISOString() };
}

// =============================================================================
// HOOK
// =============================================================================

export function useFeedback(filters: FeedbackFilters, limit: number = DEFAULT_PAGE_SIZE) {
  const { projectId } = useNavigationStore();
  const [cursor, setCursor] = useState<string | null>(null);
  const [items, setItems] = useState<FeedbackItem[]>([]);
  // Bumped on every refresh()/filter-change to force SWR to refetch even when
  // the natural key would otherwise be identical (no other param changed).
  const [revalidationToken, setRevalidationToken] = useState(0);

  // Stable bounds per dateRange selection and explicit refresh — re-computed
  // when the user changes the range or clicks refresh, NOT on every render.
  const dateBounds = useMemo(
    () => computeDateRangeBounds(filters.dateRange),
    [filters.dateRange, revalidationToken],
  );

  // Hash of every filter dimension we send. Memoized so identity is stable
  // unless an actual filter changed.
  const filterSignature = useMemo(
    () =>
      JSON.stringify({
        agentName: filters.agentName ?? '',
        channel: filters.channel ?? '',
        ratingType: filters.ratingType ?? '',
        ratingValue: typeof filters.ratingValue === 'number' ? filters.ratingValue : null,
        hasText: typeof filters.hasText === 'boolean' ? filters.hasText : null,
        sessionId: filters.sessionId ?? '',
        messageId: filters.messageId ?? '',
        dateRange: filters.dateRange ?? '',
        limit,
      }),
    [
      filters.agentName,
      filters.channel,
      filters.ratingType,
      filters.ratingValue,
      filters.hasText,
      filters.sessionId,
      filters.messageId,
      filters.dateRange,
      limit,
    ],
  );

  // Reset cursor + accumulated items whenever the filter shape changes. Doing
  // this in an effect (not in render) avoids the setState-during-render trap
  // that previously caused an infinite key-change → fetch → setState loop.
  useEffect(() => {
    setCursor(null);
    setItems([]);
  }, [filterSignature]);

  const swrKey = useMemo(() => {
    if (!projectId) return null;
    const params = new URLSearchParams();
    params.set('projectId', projectId);
    params.set('limit', String(limit));
    if (dateBounds.from) params.set('from', dateBounds.from);
    if (dateBounds.to) params.set('to', dateBounds.to);
    if (filters.agentName) params.set('agentName', filters.agentName);
    if (filters.channel) params.set('channel', filters.channel);
    if (filters.ratingType) params.set('ratingType', filters.ratingType);
    if (typeof filters.ratingValue === 'number') {
      params.set('ratingValue', String(filters.ratingValue));
    }
    if (typeof filters.hasText === 'boolean') {
      params.set('hasText', filters.hasText ? 'true' : 'false');
    }
    if (filters.sessionId) params.set('sessionId', filters.sessionId);
    if (filters.messageId) params.set('messageId', filters.messageId);
    if (cursor) params.set('cursor', cursor);
    // Token is appended only to force re-fetch on explicit refresh — server
    // ignores unknown params.
    if (revalidationToken > 0) params.set('_t', String(revalidationToken));
    return `/api/runtime/feedback?${params.toString()}`;
  }, [
    projectId,
    limit,
    dateBounds.from,
    dateBounds.to,
    filters.agentName,
    filters.channel,
    filters.ratingType,
    filters.ratingValue,
    filters.hasText,
    filters.sessionId,
    filters.messageId,
    cursor,
    revalidationToken,
  ]);

  const { data, error, isLoading, isValidating } = useSWR<FeedbackResponse>(swrKey, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    revalidateIfStale: false,
    refreshInterval: 0,
    shouldRetryOnError: false,
    keepPreviousData: true,
  });

  // Drive item accumulation off the latest response. Using an effect keeps
  // the state-mutation OUT of the SWR onSuccess callback (which fires on
  // every render that uses the cached value and was the previous loop's
  // engine).
  useEffect(() => {
    if (!data?.data) return;
    if (cursor === null) {
      setItems(data.data.items);
    } else {
      setItems((prev) => prev.concat(data.data!.items));
    }
    // We intentionally exclude `cursor` from deps — the effect should fire
    // when a NEW response arrives, and at that moment `cursor` already
    // matches whatever the response was fetched against.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const nextCursor = data?.data?.nextCursor ?? null;
  const hasMore = !!nextCursor;

  const loadMore = useCallback(() => {
    if (nextCursor) setCursor(nextCursor);
  }, [nextCursor]);

  const refresh = useCallback(() => {
    setCursor(null);
    setItems([]);
    setRevalidationToken((t) => t + 1);
  }, []);

  const errorMessage = error
    ? String(error)
    : data && data.success === false
      ? (data.error?.message ?? 'Unknown error')
      : null;

  return {
    items,
    isLoading,
    isValidating,
    error: errorMessage,
    hasMore,
    loadMore,
    refresh,
    projectId,
  };
}
