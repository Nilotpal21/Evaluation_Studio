/**
 * AudioCodes WebSocket Connection Manager
 *
 * Manages per-conversation WebSocket connections for delivering bot responses.
 * AudioCodes opens a WebSocket per conversation after the initial HTTP handshake.
 * Bot responses are sent as JSON activities over this WebSocket.
 *
 * Invariants:
 * - One WebSocket per conversationId (new connections replace stale ones)
 * - Max connections bounded (evict oldest on overflow)
 * - TTL-based cleanup for orphaned connections
 * - Thread-safe send (check readyState before write)
 */

import type { WebSocket } from 'ws';
import { createLogger } from '@abl/compiler/platform';
import type { AudioCodesActivity } from '../adapters/audiocodes-adapter.js';

const log = createLogger('audiocodes-ws-manager');

const MAX_CONNECTIONS = 10_000;
const CONNECTION_TTL_MS = 60 * 60 * 1000; // 1 hour

interface ManagedConnection {
  ws: WebSocket;
  conversationId: string;
  connectionId: string;
  createdAt: number;
}

const connections = new Map<string, ManagedConnection>();

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export function registerConnection(
  conversationId: string,
  ws: WebSocket,
  connectionId: string,
): void {
  const existing = connections.get(conversationId);
  if (existing) {
    log.info('Replacing existing WebSocket for conversation', { conversationId });
    try {
      existing.ws.close(1000, 'Replaced by new connection');
    } catch {
      // ignore close errors on stale sockets
    }
  }

  // Evict oldest if at capacity
  if (connections.size >= MAX_CONNECTIONS) {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, conn] of connections) {
      if (conn.createdAt < oldestTime) {
        oldestTime = conn.createdAt;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      const evicted = connections.get(oldestKey);
      if (evicted) {
        try {
          evicted.ws.close(1000, 'Evicted due to capacity');
        } catch {
          // ignore
        }
      }
      connections.delete(oldestKey);
      log.warn('Evicted oldest WebSocket connection due to capacity', {
        evictedConversationId: oldestKey,
      });
    }
  }

  connections.set(conversationId, {
    ws,
    conversationId,
    connectionId,
    createdAt: Date.now(),
  });

  ws.on('close', () => {
    const current = connections.get(conversationId);
    if (current && current.ws === ws) {
      connections.delete(conversationId);
      log.debug('WebSocket closed, removed from registry', { conversationId });
    }
  });

  log.debug('WebSocket registered for conversation', {
    conversationId,
    connectionId,
    totalConnections: connections.size,
  });
}

export function sendActivities(conversationId: string, activities: AudioCodesActivity[]): boolean {
  const conn = connections.get(conversationId);
  if (!conn) {
    log.warn('No WebSocket connection for conversation', { conversationId });
    return false;
  }

  if (conn.ws.readyState !== 1 /* WebSocket.OPEN */) {
    log.warn('WebSocket not open for conversation', {
      conversationId,
      readyState: conn.ws.readyState,
    });
    connections.delete(conversationId);
    return false;
  }

  try {
    const payload = JSON.stringify({ activities });
    conn.ws.send(payload);
    log.debug('Sent activities over WebSocket', {
      conversationId,
      activityCount: activities.length,
    });
    return true;
  } catch (err) {
    log.error('Failed to send activities over WebSocket', {
      conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export function removeConnection(conversationId: string): void {
  const conn = connections.get(conversationId);
  if (conn) {
    try {
      conn.ws.close(1000, 'Conversation ended');
    } catch {
      // ignore
    }
    connections.delete(conversationId);
  }
}

export function hasConnection(conversationId: string): boolean {
  return connections.has(conversationId);
}

export function getConnectionCount(): number {
  return connections.size;
}

export function startCleanup(): void {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, conn] of connections) {
      if (now - conn.createdAt > CONNECTION_TTL_MS) {
        log.info('Cleaning up stale AudioCodes WebSocket', { conversationId: key });
        try {
          conn.ws.close(1000, 'Session expired');
        } catch {
          // ignore
        }
        connections.delete(key);
      }
    }
  }, 60_000);
}

export function stopCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
  for (const [key, conn] of connections) {
    try {
      conn.ws.close(1000, 'Server shutdown');
    } catch {
      // ignore
    }
    connections.delete(key);
  }
}
