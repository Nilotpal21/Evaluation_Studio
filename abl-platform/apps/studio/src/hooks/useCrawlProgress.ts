/**
 * Crawl Progress WebSocket Hook
 *
 * Manages WebSocket connection for real-time crawl job progress updates
 * with authentication and automatic reconnection.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { useAuthStore } from '@/store/auth-store';

export interface CrawlProgressEvent {
  type:
    | 'job_started'
    | 'url_fetched'
    | 'document_processed'
    | 'chunk_created'
    | 'job_completed'
    | 'job_failed'
    | 'error'
    | 'connected'
    // V4 multi-page intelligence crawl events
    | 'intelligence_crawl_discovering'
    | 'intelligence_crawl_started'
    | 'intelligence_page_started'
    | 'intelligence_page_phase'
    | 'intelligence_page_complete'
    | 'intelligence_page_failed'
    | 'intelligence_page_saved'
    | 'intelligence_crawl_complete'
    | 'intelligence_crawl_failed'
    | 'url_skipped';
  jobId: string;
  timestamp: string;
  data?: {
    url?: string;
    documentId?: string;
    chunkId?: string;
    progress?: {
      total: number;
      completed: number;
      failed: number;
      percentage: number;
    };
    sections?: Array<{ sectionId: string; name: string; count: number }>;
    summary?: Record<string, unknown>;
    skipReason?: string;
    reason?: string;
    error?: {
      message: string;
      code?: string;
    };
  };
}

interface UseCrawlProgressOptions {
  /**
   * Maximum number of reconnection attempts
   * @default 5
   */
  maxReconnectAttempts?: number;
  /**
   * Delay between reconnection attempts in milliseconds
   * @default 5000
   */
  reconnectInterval?: number;
  /**
   * Whether to automatically connect on mount
   * @default true
   */
  autoConnect?: boolean;
}

interface UseCrawlProgressReturn {
  /** Whether WebSocket is currently connected */
  connected: boolean;
  /** Latest progress event received */
  lastEvent: CrawlProgressEvent | null;
  /** All accumulated events (capped at 200) */
  events: CrawlProgressEvent[];
  /** Current error message if any */
  error: string | null;
  /** Whether currently attempting to reconnect */
  isReconnecting: boolean;
  /** Manually connect to WebSocket */
  connect: () => void;
  /** Manually disconnect from WebSocket */
  disconnect: () => void;
}

/**
 * Hook for subscribing to real-time crawl job progress updates via WebSocket.
 *
 * @example
 * ```tsx
 * function CrawlProgress({ jobId }: { jobId: string }) {
 *   const { connected, lastEvent, error } = useCrawlProgress(jobId);
 *
 *   if (error) return <div>Error: {error}</div>;
 *   if (!connected) return <div>Connecting...</div>;
 *
 *   return (
 *     <div>
 *       Status: {lastEvent?.type}
 *       Progress: {lastEvent?.data?.progress?.percentage}%
 *     </div>
 *   );
 * }
 * ```
 */
export function useCrawlProgress(
  jobId: string | null,
  options: UseCrawlProgressOptions = {},
): UseCrawlProgressReturn {
  const { maxReconnectAttempts = 5, reconnectInterval = 5000, autoConnect = true } = options;

  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<CrawlProgressEvent | null>(null);
  const [events, setEvents] = useState<CrawlProgressEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isReconnecting, setIsReconnecting] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const shouldConnectRef = useRef(autoConnect);
  const lastEventRef = useRef<CrawlProgressEvent | null>(null);
  const everOpenedRef = useRef(false);

  const { accessToken } = useAuthStore();

  // Keep ref in sync with state (avoids stale closure in onclose callback)
  lastEventRef.current = lastEvent;

  /**
   * Stable connect function — uses refs instead of state to avoid re-creation.
   * The useEffect that calls this only depends on [jobId, accessToken].
   */
  const connectRef = useRef<(() => void) | undefined>(undefined);
  connectRef.current = () => {
    if (!jobId) {
      setError('Missing jobId');
      return;
    }

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    // Close any existing connection before opening a new one
    if (wsRef.current) {
      wsRef.current.onclose = null; // prevent reconnect from old socket
      wsRef.current.close();
      wsRef.current = null;
    }

    // Same-origin WebSocket URL — NGINX ingress matches /api/search-ai/ prefix,
    // rewrites to /api/, and forwards to search-ai service (supports WS upgrade).
    const { protocol, host } = window.location;
    const wsProtocol = protocol === 'https:' ? 'wss:' : 'ws:';
    const devWsUrl = process.env.NEXT_PUBLIC_SEARCH_AI_WS_URL;
    const wsUrl = devWsUrl
      ? `${devWsUrl}?jobId=${jobId}&token=${accessToken}`
      : `${wsProtocol}//${host}/api/search-ai/admin/progress/subscribe?jobId=${jobId}&token=${accessToken}`;

    console.log('[useCrawlProgress] Connecting to', wsUrl);
    everOpenedRef.current = false;

    try {
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        console.log('[useCrawlProgress] Connected to job:', jobId);
        everOpenedRef.current = true;
        setConnected(true);
        setIsReconnecting(false);
        setError(null);
        reconnectAttemptsRef.current = 0;
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as CrawlProgressEvent;
          console.log('[useCrawlProgress] Event:', data.type, data.data);
          setLastEvent(data);
          if (data.type !== 'connected') {
            setEvents((prev) => {
              const next = [...prev, data];
              return next.length > 200 ? next.slice(-200) : next;
            });
          }
        } catch (err) {
          console.error('[useCrawlProgress] Failed to parse message:', err);
        }
      };

      ws.onerror = (err) => {
        console.error('[useCrawlProgress] WebSocket error:', err);
        // Don't call setError here — onclose always fires after onerror.
        // Setting error here triggers a re-render that can cascade.
      };

      ws.onclose = (event) => {
        console.log('[useCrawlProgress] Disconnected, code:', event.code);
        setConnected(false);

        // If the WebSocket never opened, it's an infrastructure issue (e.g. missing
        // ingress upgrade headers). Stop immediately to prevent a reconnect loop
        // that cascades into React error #310 (too many re-renders).
        if (!everOpenedRef.current) {
          console.warn(
            '[useCrawlProgress] WebSocket closed before opening — not retrying (infrastructure issue)',
          );
          setError('WebSocket connection failed — server may not support upgrade');
          setIsReconnecting(false);
          return;
        }

        // Use ref to get current lastEvent (avoids stale closure)
        const currentLastEvent = lastEventRef.current;

        if (
          currentLastEvent?.type === 'job_completed' ||
          currentLastEvent?.type === 'job_failed' ||
          currentLastEvent?.type === 'error' ||
          !shouldConnectRef.current
        ) {
          console.log('[useCrawlProgress] Not reconnecting (job finished or manual disconnect)');
          return;
        }

        if (reconnectAttemptsRef.current < maxReconnectAttempts) {
          setIsReconnecting(true);
          reconnectAttemptsRef.current++;
          const delay = reconnectInterval * reconnectAttemptsRef.current;

          console.log(
            `[useCrawlProgress] Reconnecting in ${delay}ms (${reconnectAttemptsRef.current}/${maxReconnectAttempts})...`,
          );

          reconnectTimeoutRef.current = setTimeout(() => {
            connectRef.current?.();
          }, delay);
        } else {
          setError('Failed to connect after multiple attempts');
          setIsReconnecting(false);
        }
      };

      wsRef.current = ws;
    } catch (err) {
      console.error('[useCrawlProgress] Failed to create WebSocket:', err);
      setError(err instanceof Error ? err.message : 'Connection failed');
    }
  };

  const connect = useCallback(() => {
    connectRef.current?.();
  }, []);

  const disconnect = useCallback(() => {
    console.log('[useCrawlProgress] Manually disconnecting');
    shouldConnectRef.current = false;

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (wsRef.current) {
      wsRef.current.onclose = null; // prevent reconnect on manual disconnect
      wsRef.current.close();
      wsRef.current = null;
    }

    setConnected(false);
    setIsReconnecting(false);
  }, []);

  /**
   * Auto-connect when jobId or accessToken changes.
   * connect/disconnect are stable refs — no infinite loop.
   */
  useEffect(() => {
    if (autoConnect && jobId && accessToken) {
      shouldConnectRef.current = true;
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
  }, [jobId, accessToken, autoConnect]);

  return {
    connected,
    lastEvent,
    events,
    error,
    isReconnecting,
    connect,
    disconnect,
  };
}
