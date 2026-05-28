/**
 * Multi-Page Intelligence Crawl Progress WebSocket Hook
 *
 * Manages WebSocket connection for real-time V4 multi-page intelligence
 * crawl progress updates. Based on the useIntelligenceProgress pattern
 * with multi-page-specific event handling.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { useAuthStore } from '@/store/auth-store';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PageProgress {
  url: string;
  status: 'queued' | 'analyzing' | 'reused' | 'completed' | 'failed' | 'saved';
  handlerReused: boolean;
  llmCalls: number;
  title?: string;
  quality?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  method?: 'http' | 'playwright'; // V6 — crawl method used
  qualityScore?: number; // V6 — numeric quality score
  interactiveFlags?: string[]; // V7 — A8 interactive element flags
  jsonLdUsed?: boolean; // V7 — A12 JSON-LD extraction used
}

export interface CrawlSummary {
  totalPages: number;
  completed: number;
  failed: number;
  reused: number;
  llmCallsTotal: number;
  tokensTotal: number;
  fastCount?: number; // V6 — pages crawled via HTTP
  aiCount?: number; // V6 — pages crawled via Playwright
  blockedCount?: number; // V6 — pages excluded
}

export interface MultiPageProgressState {
  connected: boolean;
  discovering: boolean;
  totalPages: number;
  reusablePages: number;
  maxLlmCalls: number;
  pages: Record<string, PageProgress>;
  currentUrl: string | null;
  currentPhase: string | null;
  currentIteration: number | null;
  summary: CrawlSummary | null;
  isComplete: boolean;
  isFailed: boolean;
  error: string | null;
  // V6 — method + blocked tracking
  fastCount: number;
  aiCount: number;
  blockedCount: number;
  blockedPages: string[];
  groupProgress: Record<string, { completed: number; total: number; method: string }>;
  jsonLdCount: number; // V7 — count of pages where JSON-LD was used
}

interface MultiPageEvent {
  type: string;
  jobId: string;
  timestamp?: string;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MULTI_PAGE_EVENT_TYPES = new Set([
  'intelligence_crawl_discovering',
  'intelligence_crawl_started',
  'intelligence_page_started',
  'intelligence_page_phase',
  'intelligence_page_complete',
  'intelligence_page_failed',
  'intelligence_page_saved',
  'intelligence_crawl_complete',
  'intelligence_crawl_failed',
  'intelligence_page_blocked',
  'intelligence_group_progress',
]);

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_INTERVAL = 5000;

const INITIAL_STATE: MultiPageProgressState = {
  connected: false,
  discovering: false,
  totalPages: 0,
  reusablePages: 0,
  maxLlmCalls: 0,
  pages: {},
  currentUrl: null,
  currentPhase: null,
  currentIteration: null,
  summary: null,
  isComplete: false,
  isFailed: false,
  error: null,
  fastCount: 0,
  aiCount: 0,
  blockedCount: 0,
  blockedPages: [],
  groupProgress: {},
  jsonLdCount: 0,
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Hook for subscribing to real-time multi-page intelligence crawl progress
 * via WebSocket.
 *
 * Connects to the progress WebSocket endpoint with `type=crawler` since V4
 * multi-page jobs are stored as CrawlJobs in the backend.
 */
export function useMultiPageProgress(jobId: string | null): MultiPageProgressState {
  const [state, setState] = useState<MultiPageProgressState>(INITIAL_STATE);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const shouldConnectRef = useRef(true);
  const everOpenedRef = useRef(false);
  const isTerminalRef = useRef(false);

  const { accessToken } = useAuthStore();

  // Keep ref in sync with terminal state to avoid stale closures
  isTerminalRef.current = state.isComplete || state.isFailed;

  // -- Event handler --------------------------------------------------------

  const handleEvent = useCallback((event: MultiPageEvent) => {
    if (!MULTI_PAGE_EVENT_TYPES.has(event.type)) return;

    const d = event.data ?? {};

    setState((prev) => {
      switch (event.type) {
        case 'intelligence_crawl_discovering':
          return { ...prev, discovering: true };

        case 'intelligence_crawl_started':
          return {
            ...prev,
            discovering: false,
            totalPages: typeof d.totalPages === 'number' ? d.totalPages : prev.totalPages,
            reusablePages:
              typeof d.reusablePages === 'number' ? d.reusablePages : prev.reusablePages,
            maxLlmCalls: typeof d.maxLlmCalls === 'number' ? d.maxLlmCalls : prev.maxLlmCalls,
          };

        case 'intelligence_page_started': {
          const url = typeof d.url === 'string' ? d.url : '';
          if (!url) return prev;
          const page: PageProgress = {
            url,
            status: 'analyzing',
            handlerReused: d.handlerReused === true,
            llmCalls: 0,
            startedAt: typeof d.timestamp === 'string' ? d.timestamp : event.timestamp,
          };
          return {
            ...prev,
            currentUrl: url,
            pages: { ...prev.pages, [url]: page },
          };
        }

        case 'intelligence_page_phase':
          return {
            ...prev,
            currentPhase: typeof d.phase === 'string' ? d.phase : prev.currentPhase,
            currentIteration: typeof d.iteration === 'number' ? d.iteration : prev.currentIteration,
          };

        case 'intelligence_page_complete': {
          const url = typeof d.url === 'string' ? d.url : '';
          if (!url || !prev.pages[url]) return prev;
          const existing = prev.pages[url];
          const method =
            d.method === 'http' || d.method === 'playwright'
              ? (d.method as 'http' | 'playwright')
              : undefined;
          const qualityScore = typeof d.qualityScore === 'number' ? d.qualityScore : undefined;
          const interactiveFlags = Array.isArray(d.interactiveFlags)
            ? (d.interactiveFlags as string[])
            : undefined;
          const jsonLdUsed = typeof d.jsonLdUsed === 'boolean' ? d.jsonLdUsed : undefined;
          const updated: PageProgress = {
            ...existing,
            status: d.handlerReused === true ? 'reused' : 'completed',
            handlerReused: d.handlerReused === true,
            llmCalls: typeof d.llmCalls === 'number' ? d.llmCalls : existing.llmCalls,
            title: typeof d.title === 'string' ? d.title : existing.title,
            quality: typeof d.quality === 'string' ? d.quality : existing.quality,
            completedAt: typeof d.completedAt === 'string' ? d.completedAt : event.timestamp,
            method,
            qualityScore,
            interactiveFlags,
            jsonLdUsed,
          };
          // Track fast vs AI counts based on method
          const fastDelta = method === 'http' ? 1 : 0;
          const aiDelta = method === 'playwright' ? 1 : 0;
          const jsonLdDelta = jsonLdUsed === true ? 1 : 0;
          return {
            ...prev,
            fastCount: prev.fastCount + fastDelta,
            aiCount: prev.aiCount + aiDelta,
            jsonLdCount: prev.jsonLdCount + jsonLdDelta,
            pages: { ...prev.pages, [url]: updated },
          };
        }

        case 'intelligence_page_failed': {
          const url = typeof d.url === 'string' ? d.url : '';
          if (!url || !prev.pages[url]) return prev;
          const existing = prev.pages[url];
          const updated: PageProgress = {
            ...existing,
            status: 'failed',
            error:
              typeof d.error === 'string'
                ? d.error
                : d.error && typeof d.error === 'object' && 'message' in d.error
                  ? String((d.error as { message: unknown }).message)
                  : undefined,
            completedAt: event.timestamp,
          };
          return {
            ...prev,
            pages: { ...prev.pages, [url]: updated },
          };
        }

        case 'intelligence_page_saved': {
          const url = typeof d.url === 'string' ? d.url : '';
          if (!url || !prev.pages[url]) return prev;
          const existing = prev.pages[url];
          return {
            ...prev,
            pages: { ...prev.pages, [url]: { ...existing, status: 'saved' } },
          };
        }

        case 'intelligence_page_blocked': {
          const url = typeof d.url === 'string' ? d.url : '';
          if (!url) return prev;
          return {
            ...prev,
            blockedCount: prev.blockedCount + 1,
            blockedPages: [...prev.blockedPages, url],
            pages: {
              ...prev.pages,
              [url]: {
                ...prev.pages[url],
                url,
                status: 'failed' as const,
                error: typeof d.reason === 'string' ? d.reason : 'Content quality too low',
                qualityScore: typeof d.qualityScore === 'number' ? d.qualityScore : undefined,
                handlerReused: prev.pages[url]?.handlerReused ?? false,
                llmCalls: prev.pages[url]?.llmCalls ?? 0,
              },
            },
          };
        }

        case 'intelligence_group_progress': {
          const pattern = typeof d.groupPattern === 'string' ? d.groupPattern : '';
          if (!pattern) return prev;
          return {
            ...prev,
            groupProgress: {
              ...prev.groupProgress,
              [pattern]: {
                completed: typeof d.completed === 'number' ? d.completed : 0,
                total: typeof d.total === 'number' ? d.total : 0,
                method: typeof d.method === 'string' ? d.method : 'http',
              },
            },
          };
        }

        case 'intelligence_crawl_complete': {
          const summary =
            d.summary && typeof d.summary === 'object'
              ? (d.summary as CrawlSummary)
              : ({
                  totalPages: typeof d.totalPages === 'number' ? d.totalPages : prev.totalPages,
                  completed: typeof d.pagesCompleted === 'number' ? d.pagesCompleted : 0,
                  failed: 0,
                  reused: 0,
                  llmCallsTotal: typeof d.llmCalls === 'number' ? d.llmCalls : 0,
                  tokensTotal: 0,
                } satisfies CrawlSummary);

          return {
            ...prev,
            isComplete: true,
            summary,
          };
        }

        case 'intelligence_crawl_failed': {
          const errorMsg =
            typeof d.error === 'string'
              ? d.error
              : d.error && typeof d.error === 'object' && 'message' in d.error
                ? String((d.error as { message: unknown }).message)
                : 'CRAWL_FAILED';
          return {
            ...prev,
            isFailed: true,
            error: errorMsg,
          };
        }

        default:
          return prev;
      }
    });
  }, []);

  // -- WebSocket connection -------------------------------------------------

  const connectRef = useRef<(() => void) | undefined>(undefined);
  connectRef.current = () => {
    if (!jobId) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    // Close any existing connection
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
    }

    const { protocol, host } = window.location;
    const wsProtocol = protocol === 'https:' ? 'wss:' : 'ws:';
    const devWsUrl = process.env.NEXT_PUBLIC_SEARCH_AI_WS_URL;
    const wsUrl = devWsUrl
      ? `${devWsUrl}?jobId=${jobId}&type=crawler&token=${accessToken}`
      : `${wsProtocol}//${host}/api/search-ai/admin/progress/subscribe?jobId=${jobId}&type=crawler&token=${accessToken}`;

    everOpenedRef.current = false;

    try {
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        everOpenedRef.current = true;
        setState((prev) => ({ ...prev, connected: true, error: null }));
        reconnectAttemptsRef.current = 0;
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as MultiPageEvent;
          handleEvent(data);
        } catch {
          // Ignore unparseable messages
        }
      };

      ws.onerror = () => {
        // onclose always fires after onerror — handle errors there
      };

      ws.onclose = () => {
        setState((prev) => ({ ...prev, connected: false }));

        if (!everOpenedRef.current) {
          setState((prev) => ({ ...prev, error: 'WS_CONNECTION_FAILED' }));
          return;
        }

        if (isTerminalRef.current || !shouldConnectRef.current) return;

        if (reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttemptsRef.current++;
          const delay = RECONNECT_INTERVAL * reconnectAttemptsRef.current;
          reconnectTimeoutRef.current = setTimeout(() => {
            connectRef.current?.();
          }, delay);
        } else {
          setState((prev) => ({
            ...prev,
            error: 'WS_MAX_RETRIES_EXCEEDED',
          }));
        }
      };

      wsRef.current = ws;
    } catch (err) {
      setState((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : 'WS_CONNECTION_ERROR',
      }));
    }
  };

  // -- Lifecycle ------------------------------------------------------------

  useEffect(() => {
    if (jobId && accessToken) {
      shouldConnectRef.current = true;
      setState(INITIAL_STATE);
      connectRef.current?.();
    }

    return () => {
      shouldConnectRef.current = false;

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
  }, [jobId, accessToken]);

  return state;
}
