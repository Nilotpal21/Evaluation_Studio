/**
 * useKnowledgeBase Hook
 *
 * SWR hook for a single knowledge base with its linked index and sources.
 *
 * Update strategy — 100% event-driven, ZERO polling:
 *
 * 1. WebSocket subscription — When KB is processing (rebuilding/indexing),
 *    subscribes to real-time events via Redis pub/sub. Each document_processed
 *    or job_completed event triggers an instant SWR revalidation.
 *
 * 2. Imperative refresh — After user actions (upload, delete, model change),
 *    the calling component calls refresh()/refreshSources() directly.
 *
 * 3. On-focus revalidation — Standard SWR: refetch when user returns to tab.
 *
 * No polling. No intervals. No timers.
 */

import { useMemo, useCallback, useEffect, useRef } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import type { KnowledgeBaseDetail, SearchAISource } from '../api/search-ai';
import { useAuthStore } from '@/store/auth-store';

/** Document statuses that indicate active pipeline processing */
const ACTIVE_STATUSES = new Set(['pending', 'extracting', 'enriching', 'embedding']);

/** Index/KB statuses that indicate rebuilding or processing */
const ACTIVE_KB_STATUSES = new Set(['indexing', 'processing', 'rebuilding']);

/** Check if the KB index status implies active work */
function isKBProcessing(kb: KnowledgeBaseDetail | undefined | null): boolean {
  if (!kb) return false;
  if (ACTIVE_KB_STATUSES.has(kb.status)) return true;
  if (kb.index?.status && ACTIVE_KB_STATUSES.has(kb.index.status)) return true;
  return false;
}

interface KBResponse {
  knowledgeBase: KnowledgeBaseDetail;
}

interface SourcesResponse {
  sources: SearchAISource[];
  total: number;
}

interface UseKnowledgeBaseReturn {
  knowledgeBase: KnowledgeBaseDetail | null;
  sources: SearchAISource[];
  sourceCount: number;
  isLoading: boolean;
  isProcessing: boolean;
  error: string | null;
  refresh: () => void;
  refreshSources: () => void;
}

export function useKnowledgeBase(kbId: string | null): UseKnowledgeBaseReturn {
  const { accessToken } = useAuthStore();
  const { mutate: globalMutate } = useSWRConfig();

  const kbKey = kbId ? `/api/search-ai/knowledge-bases/${kbId}` : null;
  const {
    data: kbData,
    error: kbError,
    isLoading: kbLoading,
    mutate: mutateKB,
  } = useSWR<KBResponse>(kbKey, {
    revalidateOnFocus: true,
  });

  const searchIndexId = kbData?.knowledgeBase?.searchIndexId ?? null;
  const sourcesKey = searchIndexId ? `/api/search-ai/indexes/${searchIndexId}/sources` : null;
  const {
    data: sourcesData,
    error: sourcesError,
    isLoading: sourcesLoading,
    mutate: mutateSources,
  } = useSWR<SourcesResponse>(sourcesKey, {
    revalidateOnFocus: true,
  });

  const knowledgeBase = useMemo(() => kbData?.knowledgeBase ?? null, [kbData]);
  const sources = useMemo(() => sourcesData?.sources ?? [], [sourcesData]);
  const isProcessing = useMemo(
    () =>
      isKBProcessing(kbData?.knowledgeBase) ||
      (sourcesData?.sources?.some((s) => ACTIVE_STATUSES.has(s.status)) ?? false),
    [kbData, sourcesData],
  );

  // Stable callbacks — prevents cascading re-renders
  const refresh = useCallback(() => mutateKB(), [mutateKB]);
  const refreshSources = useCallback(() => mutateSources(), [mutateSources]);

  // ─── WebSocket — Real-Time Event Push ───────────────────────────────────
  // Only connects when KB is actively processing. Backend pushes events on
  // each document completion. We call mutate() on receipt — instant UI update.
  // No timers, no intervals, no polling.
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mutateKBRef = useRef(mutateKB);
  const mutateSourcesRef = useRef(mutateSources);
  const globalMutateRef = useRef(globalMutate);
  mutateKBRef.current = mutateKB;
  mutateSourcesRef.current = mutateSources;
  globalMutateRef.current = globalMutate;

  useEffect(() => {
    // Only connect when actively processing
    if (!searchIndexId || !isProcessing || !accessToken) {
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
      return;
    }

    let reconnectAttempts = 0;
    const MAX_RECONNECT = 3;

    function connect() {
      if (wsRef.current?.readyState === WebSocket.OPEN) return;

      const { protocol, host } = window.location;
      const wsProtocol = protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${wsProtocol}//${host}/api/search-ai/admin/progress/subscribe?jobId=${searchIndexId}&type=indexing&token=${encodeURIComponent(accessToken!)}`;

      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        reconnectAttempts = 0;
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          // Real-time event from backend — revalidate ALL related SWR caches instantly.
          // This covers: KB detail, sources, index stats, document table, status-summary.
          if (
            data.type === 'job_completed' ||
            data.type === 'document_processed' ||
            data.type === 'chunk_created'
          ) {
            mutateKBRef.current();
            // Revalidate all SWR keys related to this index (sources, document table,
            // stats, chunks, vocabulary, etc.). Single-argument form preserves cached
            // data and triggers a background refetch — avoids clearing the cache to
            // undefined which would briefly flip isProcessing to false, tear down the
            // WebSocket, and cause a reconnect→replay→mutate loop (see SWR v2.4.1
            // internalMutate line 277: args.length < 3 skips the cache write).
            globalMutateRef.current(
              (key: unknown) =>
                typeof key === 'string' && key.includes(`/indexes/${searchIndexId}`),
            );
          }
        } catch {
          // Malformed message — ignore
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        // Reconnect with backoff while still processing
        if (reconnectAttempts < MAX_RECONNECT) {
          reconnectAttempts++;
          const delay = Math.min(2000 * 2 ** reconnectAttempts, 15_000);
          reconnectTimeoutRef.current = setTimeout(connect, delay);
        }
      };

      ws.onerror = () => {
        // onclose fires after onerror — reconnect handled there
      };

      wsRef.current = ws;
    }

    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [searchIndexId, isProcessing, accessToken]);

  return {
    knowledgeBase,
    sources,
    sourceCount: sourcesData?.total ?? 0,
    isLoading: kbLoading || sourcesLoading,
    isProcessing,
    error: kbError || sourcesError ? String(kbError || sourcesError) : null,
    refresh,
    refreshSources,
  };
}
