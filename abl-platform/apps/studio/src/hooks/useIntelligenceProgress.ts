/**
 * Intelligence Progress WebSocket Hook
 *
 * Manages WebSocket connection for real-time intelligence analysis progress updates.
 * Falls back to HTTP polling when WebSocket connection fails (e.g. local dev proxy gap).
 * Based on the useCrawlProgress pattern with intelligence-specific event handling.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { useAuthStore } from '@/store/auth-store';
import type { IntelligenceAnalysisResult } from '@/api/crawl';
import { getIntelligenceStatus } from '@/api/crawl';

export interface IntelligenceProgressEvent {
  type:
    | 'intelligence_started'
    | 'intelligence_phase'
    | 'intelligence_complete'
    | 'intelligence_failed';
  jobId: string;
  timestamp?: string;
  data?: {
    phase?: 'map' | 'understand' | 'build_handler' | 'replay';
    iteration?: number;
    maxIterations?: number;
    phaseDetail?: string;
    result?: IntelligenceAnalysisResult;
    error?: { message: string };
  };
}

interface UseIntelligenceProgressReturn {
  connected: boolean;
  phase: string | null;
  iteration: number;
  events: IntelligenceProgressEvent[];
  result: IntelligenceAnalysisResult | null;
  error: string | null;
  isComplete: boolean;
}

const INTELLIGENCE_EVENT_TYPES = new Set([
  'intelligence_started',
  'intelligence_phase',
  'intelligence_complete',
  'intelligence_failed',
]);

const MAX_EVENTS = 200;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_INTERVAL = 5000;
const POLL_INTERVAL_MS = 3000;

/**
 * Hook for subscribing to real-time intelligence analysis progress via WebSocket.
 * Falls back to HTTP polling when WebSocket fails or cannot connect.
 */
export function useIntelligenceProgress(jobId: string | null): UseIntelligenceProgressReturn {
  const [connected, setConnected] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);
  const [iteration, setIteration] = useState(0);
  const [events, setEvents] = useState<IntelligenceProgressEvent[]>([]);
  const [result, setResult] = useState<IntelligenceAnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isComplete, setIsComplete] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const shouldConnectRef = useRef(true);
  const everOpenedRef = useRef(false);
  const isCompleteRef = useRef(false);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isPollingRef = useRef(false);

  const { accessToken } = useAuthStore();

  // Keep ref in sync with state
  isCompleteRef.current = isComplete;

  // ── Polling fallback ────────────────────────────────────────────────────
  const startPolling = useCallback(
    (targetJobId: string) => {
      if (isPollingRef.current) return;
      isPollingRef.current = true;

      // Clear any previous error from WS failure — polling is taking over
      setError(null);
      setConnected(true);

      pollIntervalRef.current = setInterval(async () => {
        if (isCompleteRef.current || !shouldConnectRef.current) {
          stopPolling();
          return;
        }

        try {
          const resp = await getIntelligenceStatus(targetJobId);
          if (!resp.success) return;

          const { status, result: pollResult } = resp.data;

          // Map status to a synthetic phase for the UI
          if (status === 'running') {
            setPhase((prev) => prev ?? 'map'); // keep WS-reported phase if set
          }

          if (status === 'completed' && pollResult) {
            setResult(pollResult);
            setIsComplete(true);
            stopPolling();
          }

          if (status === 'failed') {
            setError('Analysis failed');
            setIsComplete(true);
            stopPolling();
          }
        } catch {
          // Transient poll failure — will retry on next interval
        }
      }, POLL_INTERVAL_MS);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    isPollingRef.current = false;
  }, []);

  // ── WebSocket connection ────────────────────────────────────────────────
  const connectRef = useRef<(() => void) | undefined>(undefined);
  connectRef.current = () => {
    if (!jobId || !accessToken) return;

    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    // Close any existing connection
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
    }

    const { protocol, host } = window.location;
    const wsProtocol = protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${host}/api/search-ai/admin/progress/subscribe?jobId=${jobId}&type=intelligence&token=${encodeURIComponent(accessToken)}`;

    everOpenedRef.current = false;

    try {
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        everOpenedRef.current = true;
        setConnected(true);
        setError(null);
        reconnectAttemptsRef.current = 0;
        stopPolling();
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as IntelligenceProgressEvent;

          // Filter to intelligence events only
          if (!INTELLIGENCE_EVENT_TYPES.has(data.type)) return;

          setEvents((prev) => {
            const next = [...prev, data];
            return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
          });

          if (data.type === 'intelligence_phase' && data.data?.phase) {
            setPhase(data.data.phase);
            // Backend embeds iteration info in phaseDetail: "iteration N/M"
            const iterMatch = data.data.phaseDetail?.match(/^iteration (\d+)\//);
            if (iterMatch) {
              setIteration(parseInt(iterMatch[1], 10));
            }
          }

          if (data.type === 'intelligence_complete' && data.data?.result) {
            setResult(data.data.result);
            setIsComplete(true);
          }

          if (data.type === 'intelligence_failed') {
            setError(data.data?.error?.message ?? 'Analysis failed');
            setIsComplete(true);
          }
        } catch {
          // Ignore unparseable messages
        }
      };

      ws.onerror = () => {
        // onclose always fires after onerror — handle errors there
      };

      ws.onclose = () => {
        setConnected(false);

        // WS never connected — fall back to HTTP polling
        if (!everOpenedRef.current) {
          if (!isCompleteRef.current && shouldConnectRef.current && jobId) {
            startPolling(jobId);
          }
          return;
        }

        if (isCompleteRef.current || !shouldConnectRef.current) return;

        if (reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttemptsRef.current++;
          const delay = RECONNECT_INTERVAL * reconnectAttemptsRef.current;
          reconnectTimeoutRef.current = setTimeout(() => {
            connectRef.current?.();
          }, delay);
        } else {
          // All reconnect attempts exhausted — fall back to polling
          if (jobId) {
            startPolling(jobId);
          } else {
            setError('Failed to connect after multiple attempts');
          }
        }
      };

      wsRef.current = ws;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
      // WS construction failed — fall back to polling
      if (jobId) {
        startPolling(jobId);
      }
    }
  };

  useEffect(() => {
    if (jobId && accessToken) {
      shouldConnectRef.current = true;
      // Reset state for new job
      setPhase(null);
      setIteration(0);
      setEvents([]);
      setResult(null);
      setError(null);
      setIsComplete(false);
      stopPolling();
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

      stopPolling();
    };
  }, [jobId, accessToken, stopPolling]);

  return {
    connected,
    phase,
    iteration,
    events,
    result,
    error,
    isComplete,
  };
}
