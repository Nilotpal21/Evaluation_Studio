/**
 * useDiscovery — SSE hook for BFS site discovery lifecycle.
 *
 * Manages starting, streaming, stopping, and exploring discovery sessions
 * via Server-Sent Events. Uses ref-based callbacks to avoid stale closures
 * and implements exponential backoff for reconnection.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { BfsSSEEvent, DiscoverMoreRequest, StartDiscoveryRequest } from '@/api/discovery';
import {
  connectDiscoveryStream,
  discoverMore,
  startDiscovery,
  stopDiscovery,
} from '@/api/discovery';

// =============================================================================
// TYPES
// =============================================================================

export type DiscoveryStatus = 'idle' | 'starting' | 'running' | 'complete' | 'error';

export interface DiscoveryProgress {
  totalUrls: number;
  totalVisited: number;
  currentPhase: string;
  currentPhaseLabel: string;
  durationMs: number;
  stoppedBy?: string;
}

export interface UseDiscoveryOptions {
  onEvent?: (event: BfsSSEEvent) => void;
  onTreeSnapshot?: (event: Extract<BfsSSEEvent, { type: 'tree-snapshot' }>) => void;
  onProgress?: (event: Extract<BfsSSEEvent, { type: 'progress' }>) => void;
  onPhaseChange?: (event: Extract<BfsSSEEvent, { type: 'phase' }>) => void;
  onActivity?: (event: Extract<BfsSSEEvent, { type: 'activity' }>) => void;
  onComplete?: (event: Extract<BfsSSEEvent, { type: 'complete' }>) => void;
  onError?: (event: Extract<BfsSSEEvent, { type: 'error' }>) => void;
  maxRetries?: number;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const DEFAULT_MAX_RETRIES = 3;
const MAX_BACKOFF_MS = 8000;

const INITIAL_PROGRESS: DiscoveryProgress = {
  totalUrls: 0,
  totalVisited: 0,
  currentPhase: '',
  currentPhaseLabel: '',
  durationMs: 0,
};

/** All named SSE event types emitted by the BFS engine. */
const SSE_EVENT_TYPES = [
  'phase',
  'tree-snapshot',
  'progress',
  'activity',
  'complete',
  'error',
] as const;

// =============================================================================
// HOOK
// =============================================================================

export function useDiscovery(options: UseDiscoveryOptions = {}) {
  // --- State ---
  const [status, setStatus] = useState<DiscoveryStatus>('idle');
  const [discoveryId, setDiscoveryId] = useState<string | null>(null);
  const [progress, setProgress] = useState<DiscoveryProgress>(INITIAL_PROGRESS);
  const [error, setError] = useState<string | null>(null);

  // --- Refs (mutable, no re-renders) ---
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const terminalRef = useRef(false);
  const retryCountRef = useRef(0);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const discoveryIdRef = useRef<string | null>(null);

  // Keep discoveryIdRef in sync for use in non-React callbacks
  discoveryIdRef.current = discoveryId;

  // --- Helpers ---

  const closeEventSource = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  const clearRetryTimeout = useCallback(() => {
    if (retryTimeoutRef.current !== null) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
  }, []);

  /**
   * Parse an SSE MessageEvent into a typed BfsSSEEvent.
   * Returns null for non-JSON payloads (e.g. heartbeat pings).
   */
  const parseEvent = useCallback((event: Event): BfsSSEEvent | null => {
    try {
      const data = (event as MessageEvent).data as string;
      return JSON.parse(data) as BfsSSEEvent;
    } catch {
      return null;
    }
  }, []);

  /**
   * Connect to the SSE stream for a given discovery ID.
   * Registers named event listeners for all BFS event types.
   */
  const connectStream = useCallback(
    (id: string) => {
      closeEventSource();

      const es = connectDiscoveryStream(id);
      eventSourceRef.current = es;

      /** Dispatch a parsed event to the appropriate callback. */
      const handleParsedEvent = (parsed: BfsSSEEvent) => {
        // Always fire the generic onEvent callback
        optionsRef.current.onEvent?.(parsed);

        switch (parsed.type) {
          case 'tree-snapshot':
            setProgress((prev) => ({
              ...prev,
              totalUrls: parsed.totalUrls,
              totalVisited: parsed.totalVisited,
            }));
            optionsRef.current.onTreeSnapshot?.(parsed);
            break;

          case 'progress':
            setProgress((prev) => ({
              ...prev,
              totalUrls: parsed.totalUrls,
              totalVisited: parsed.totalVisited,
            }));
            optionsRef.current.onProgress?.(parsed);
            break;

          case 'phase':
            setProgress((prev) => ({
              ...prev,
              currentPhase: String(parsed.phase),
              currentPhaseLabel: parsed.label,
            }));
            optionsRef.current.onPhaseChange?.(parsed);
            break;

          case 'activity':
            optionsRef.current.onActivity?.(parsed);
            break;

          case 'complete':
            terminalRef.current = true;
            setStatus('complete');
            setProgress((prev) => ({
              ...prev,
              totalUrls: parsed.totalUrls,
              totalVisited: parsed.totalVisited,
              durationMs: parsed.durationMs,
              stoppedBy: parsed.stoppedBy,
            }));
            optionsRef.current.onComplete?.(parsed);
            closeEventSource();
            break;

          case 'error':
            terminalRef.current = true;
            setStatus('error');
            setError(parsed.message);
            optionsRef.current.onError?.(parsed);
            closeEventSource();
            break;
        }
      };

      // Register a named listener for each SSE event type
      for (const eventType of SSE_EVENT_TYPES) {
        es.addEventListener(eventType, (event: Event) => {
          const parsed = parseEvent(event);
          if (parsed) {
            handleParsedEvent(parsed);
          }
        });
      }

      // Handle SSE transport errors with exponential backoff
      es.onerror = () => {
        closeEventSource();

        if (terminalRef.current) return;

        const maxRetries = optionsRef.current.maxRetries ?? DEFAULT_MAX_RETRIES;
        if (retryCountRef.current >= maxRetries) {
          terminalRef.current = true;
          setStatus('error');
          setError('Connection lost after maximum retries');
          return;
        }

        const delay = Math.min(1000 * Math.pow(2, retryCountRef.current), MAX_BACKOFF_MS);
        retryCountRef.current += 1;

        retryTimeoutRef.current = setTimeout(() => {
          if (!terminalRef.current) {
            connectStream(id);
          }
        }, delay);
      };
    },
    [closeEventSource, parseEvent],
  );

  // --- Public API ---

  const start = useCallback(
    async (req: StartDiscoveryRequest): Promise<void> => {
      // Guard against double-start
      if (status === 'starting' || status === 'running') return;

      // Close any existing connection
      closeEventSource();
      clearRetryTimeout();

      // Reset state
      terminalRef.current = false;
      retryCountRef.current = 0;
      setError(null);
      setProgress(INITIAL_PROGRESS);
      setStatus('starting');

      try {
        const response = await startDiscovery(req);
        setDiscoveryId(response.discoveryId);
        discoveryIdRef.current = response.discoveryId;
        setStatus('running');
        connectStream(response.discoveryId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setStatus('error');
        setError(message);
      }
    },
    [status, closeEventSource, clearRetryTimeout, connectStream],
  );

  const stop = useCallback(async (): Promise<void> => {
    terminalRef.current = true;
    closeEventSource();
    clearRetryTimeout();

    const currentId = discoveryIdRef.current;
    if (currentId) {
      try {
        await stopDiscovery(currentId);
      } catch (err) {
        // Best effort — log but do not throw
        const message = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.warn('[useDiscovery] stop failed:', message);
      }
    }

    setStatus('complete');
  }, [closeEventSource, clearRetryTimeout]);

  const exploreBranch = useCallback(async (url: string) => {
    const currentId = discoveryIdRef.current;
    if (!currentId) {
      throw new Error('No active discovery session');
    }
    const req: DiscoverMoreRequest = { type: 'explore-branch', url };
    return discoverMore(currentId, req);
  }, []);

  const exploreAll = useCallback(async (url: string) => {
    const currentId = discoveryIdRef.current;
    if (!currentId) {
      throw new Error('No active discovery session');
    }
    const req: DiscoverMoreRequest = { type: 'explore-all', url };
    return discoverMore(currentId, req);
  }, []);

  // --- Cleanup on unmount ---
  useEffect(() => {
    return () => {
      terminalRef.current = true;
      clearRetryTimeout();
      closeEventSource();
    };
  }, [clearRetryTimeout, closeEventSource]);

  return {
    status,
    discoveryId,
    progress,
    error,
    start,
    stop,
    exploreBranch,
    exploreAll,
  };
}
