import crypto from 'crypto';
import { createLogger } from '@abl/compiler/platform';
import type WebSocket from 'ws';
import { getTraceStore } from '../trace-store.js';
import type { TraceEventWithId } from '../../types/index.js';

const log = createLogger('session-ws-registry');

const sessionToWs = new Map<string, WebSocket>();
const sessionWsTimestamps = new Map<string, number>();

// Tracks which session keys each WS has close-handlers for, so we only
// add one close handler per key regardless of how many times the same key
// is re-registered on the same WS (e.g. agent reloads on a long-lived connection).
const wsRegisteredKeys = new WeakMap<WebSocket, Set<string>>();

const MAX_SESSION_WS_ENTRIES = 10_000;
const SESSION_WS_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

/**
 * Register a WebSocket for a session key.
 * Called by the WS handler when a client loads or resumes a session.
 * The same WebSocket may be registered under multiple keys (e.g. session ID
 * and contactId alias) so the agent-transfer bridge can locate it regardless
 * of which identifier arrives on the inbound webhook.
 */
export function registerSessionWebSocket(sessionId: string, ws: WebSocket): void {
  if (sessionToWs.size >= MAX_SESSION_WS_ENTRIES) {
    evictStaleEntries();

    if (sessionToWs.size >= MAX_SESSION_WS_ENTRIES) {
      forceEvictOldest(Math.max(1, Math.floor(MAX_SESSION_WS_ENTRIES * 0.1)));
    }
  }

  // Detect collision: another open socket already occupies this key.
  // Latest-wins — close the displaced socket so it doesn't linger, and emit
  // a TraceEvent so the supersede is visible in the audit trail.
  const existing = sessionToWs.get(sessionId);
  if (existing && existing !== ws && existing.readyState === existing.OPEN) {
    log.warn('Displacing existing WebSocket for key — closing with code 4000', { sessionId });
    try {
      existing.close(4000, 'superseded');
    } catch {
      // ignore close errors on a socket we're discarding
    }
    try {
      const event: TraceEventWithId = {
        id: crypto.randomUUID(),
        sessionId,
        type: 'warning',
        timestamp: new Date(),
        data: { reason: 'ws_contact_id_superseded', sessionId },
      };
      getTraceStore().addEvent(sessionId, event);
    } catch {
      // trace store may not be initialised in all environments
    }
  }

  sessionToWs.set(sessionId, ws);
  sessionWsTimestamps.set(sessionId, Date.now());

  // Guard against duplicate listeners: only add one close handler per (ws, key) pair.
  // Without this guard, agent reloads and session resumes on the same long-lived WS
  // accumulate listeners and trigger Node.js MaxListenersExceededWarnings.
  let keys = wsRegisteredKeys.get(ws);
  if (!keys) {
    keys = new Set<string>();
    wsRegisteredKeys.set(ws, keys);
  }
  if (!keys.has(sessionId)) {
    keys.add(sessionId);
    ws.on('close', () => {
      // Guard: only evict the key if this socket still owns it.
      // Without the guard, a late-firing close event from a displaced socket
      // deletes the replacement entry that was set by registerSessionWebSocket.
      if (sessionToWs.get(sessionId) === ws) {
        sessionToWs.delete(sessionId);
        sessionWsTimestamps.delete(sessionId);
      }
      keys!.delete(sessionId);
    });
  }
}

/**
 * Remove a session key from the registry.
 * Called on WS disconnect, agent reload, or session resume.
 */
export function unregisterSessionWebSocket(sessionId: string): void {
  sessionToWs.delete(sessionId);
  sessionWsTimestamps.delete(sessionId);
}

/**
 * Look up an open WebSocket by session key.
 * Returns undefined if no entry exists or the WebSocket is no longer open.
 */
export function getSessionWebSocket(sessionId: string): WebSocket | undefined {
  const ws = sessionToWs.get(sessionId);
  if (!ws) return undefined;

  if (ws.readyState !== ws.OPEN) {
    sessionToWs.delete(sessionId);
    sessionWsTimestamps.delete(sessionId);
    return undefined;
  }

  return ws;
}

function evictStaleEntries(): void {
  const now = Date.now();
  for (const [id, ts] of sessionWsTimestamps) {
    if (now - ts > SESSION_WS_TTL_MS) {
      sessionToWs.delete(id);
      sessionWsTimestamps.delete(id);
    }
  }
}

function forceEvictOldest(count: number): void {
  const entries = [...sessionWsTimestamps.entries()].sort((a, b) => a[1] - b[1]).slice(0, count);
  for (const [id] of entries) {
    sessionToWs.delete(id);
    sessionWsTimestamps.delete(id);
  }
  log.info('Force-evicted oldest WebSocket entries', { evicted: entries.length });
}

/** Test helper — reset all registry state. No-op in production. */
export function _resetRegistryForTest(): void {
  if (process.env.NODE_ENV === 'production') return;
  sessionToWs.clear();
  sessionWsTimestamps.clear();
  // wsRegisteredKeys is a WeakMap — entries are GC'd automatically
}
