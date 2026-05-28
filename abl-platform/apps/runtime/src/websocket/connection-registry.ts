/**
 * WebSocketConnectionRegistry — pod-local registry mapping connection IDs
 * and session IDs to live WebSocket objects.
 *
 * Used by ChannelDispatcher to deliver async results to connected clients.
 * Each pod maintains its own registry; cross-pod delivery uses Redis Pub/Sub.
 *
 * Multi-connection + multi-session support (Phase 2 — omnichannel live sync):
 * - sessionToConnections: Map<sessionId, Set<connectionId>> — all connections
 * - connectionToSessions: Map<connectionId, Set<sessionId>> — all sessions for a socket
 * - sessionToConnection: Map<sessionId, connectionId> — primary (first registered)
 * - getConnectionsForSession(): returns ALL WebSocket connections for a session
 * - getConnectionForSession(): returns the primary connection (backward compat)
 * - Max connections per session: OMNICHANNEL_MAX_CONNECTIONS_PER_SESSION
 * - Stale connection sweep every 60s removes closed WebSocket objects
 */

import type { WebSocket } from 'ws';
import { OMNICHANNEL_MAX_CONNECTIONS_PER_SESSION } from '@agent-platform/config/constants';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('ws-connection-registry');
const MAX_REGISTRY_SIZE = 10_000;
const STALE_SWEEP_INTERVAL_MS = 60_000;

export class WebSocketConnectionRegistry {
  private connections = new Map<string, WebSocket>();
  private sessionToConnection = new Map<string, string>();
  private connectionToSessions = new Map<string, Set<string>>();
  /** Multi-connection: all connection IDs for a session */
  private sessionToConnections = new Map<string, Set<string>>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.startStaleSweep();
  }

  register(connectionId: string, sessionId: string, ws: WebSocket): void {
    const isNewConnection = !this.connections.has(connectionId);
    const existingSessions = this.connectionToSessions.get(connectionId);
    const alreadyRegisteredForSession = existingSessions?.has(sessionId) ?? false;

    // Evict oldest if at capacity
    if (isNewConnection && this.connections.size >= MAX_REGISTRY_SIZE) {
      const oldest = this.connections.keys().next().value;
      if (oldest) this.unregister(oldest);
    }

    // Check per-session connection limit
    const existing = this.sessionToConnections.get(sessionId);
    if (
      !alreadyRegisteredForSession &&
      existing &&
      existing.size >= OMNICHANNEL_MAX_CONNECTIONS_PER_SESSION
    ) {
      log.warn('Max connections per session reached, rejecting', {
        sessionId,
        limit: OMNICHANNEL_MAX_CONNECTIONS_PER_SESSION,
      });
      return;
    }

    this.connections.set(connectionId, ws);

    const connectionSessions = existingSessions ?? new Set<string>();
    if (!existingSessions) {
      this.connectionToSessions.set(connectionId, connectionSessions);
    }

    if (alreadyRegisteredForSession) {
      if (!this.sessionToConnection.has(sessionId)) {
        this.sessionToConnection.set(sessionId, connectionId);
      }
      return;
    }

    connectionSessions.add(sessionId);

    // Primary connection: only set if this is the first connection for the session
    if (!this.sessionToConnection.has(sessionId)) {
      this.sessionToConnection.set(sessionId, connectionId);
    }

    // Multi-connection: add to the set
    if (!existing) {
      this.sessionToConnections.set(sessionId, new Set([connectionId]));
    } else {
      existing.add(connectionId);
    }
  }

  unregister(connectionId: string, sessionId?: string): void {
    const sessionIds = this.connectionToSessions.get(connectionId);

    if (!sessionIds || sessionIds.size === 0) {
      this.connections.delete(connectionId);
      return;
    }

    if (sessionId) {
      if (!sessionIds.has(sessionId)) {
        return;
      }
      this.removeSessionRegistration(connectionId, sessionId);
      if (sessionIds.size === 0) {
        this.connectionToSessions.delete(connectionId);
        this.connections.delete(connectionId);
      }
      return;
    }

    for (const registeredSessionId of [...sessionIds]) {
      this.removeSessionRegistration(connectionId, registeredSessionId);
    }

    this.connectionToSessions.delete(connectionId);
    this.connections.delete(connectionId);
  }

  getConnection(connectionId: string): WebSocket | undefined {
    return this.connections.get(connectionId);
  }

  /**
   * Get the primary (first-registered) connection for a session.
   * Used by ChannelDispatcher and existing code — backward compatible.
   */
  getConnectionForSession(sessionId: string): WebSocket | undefined {
    const connId = this.sessionToConnection.get(sessionId);
    return connId ? this.connections.get(connId) : undefined;
  }

  getConnectionIdForSession(sessionId: string): string | undefined {
    return this.sessionToConnection.get(sessionId);
  }

  /**
   * Get ALL connections for a session (multi-connection support).
   * Returns an array of open WebSocket objects.
   * Used by omnichannel fan-out to deliver transcript items to all participants.
   */
  getConnectionsForSession(sessionId: string): WebSocket[] {
    const connSet = this.sessionToConnections.get(sessionId);
    if (!connSet) return [];

    const result: WebSocket[] = [];
    for (const connId of connSet) {
      const ws = this.connections.get(connId);
      if (ws) {
        result.push(ws);
      }
    }
    return result;
  }

  /**
   * Get all connection IDs for a session.
   */
  getConnectionIdsForSession(sessionId: string): string[] {
    const connSet = this.sessionToConnections.get(sessionId);
    return connSet ? [...connSet] : [];
  }

  /**
   * Get the count of connections for a session.
   */
  getConnectionCountForSession(sessionId: string): number {
    return this.sessionToConnections.get(sessionId)?.size ?? 0;
  }

  get size(): number {
    return this.connections.size;
  }

  /**
   * Start a periodic sweep to remove stale (closed) WebSocket connections.
   * Runs every 60 seconds.
   */
  private startStaleSweep(): void {
    this.sweepTimer = setInterval(() => {
      let swept = 0;
      for (const [connId, ws] of this.connections) {
        // WebSocket.OPEN = 1, anything else is stale
        if (ws.readyState !== 1) {
          this.unregister(connId);
          swept++;
        }
      }
      if (swept > 0) {
        log.info('Stale connection sweep', { swept, remaining: this.connections.size });
      }
    }, STALE_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  /**
   * Stop the stale connection sweep (for graceful shutdown / testing).
   */
  stopStaleSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private removeSessionRegistration(connectionId: string, sessionId: string): void {
    const connectionSessions = this.connectionToSessions.get(connectionId);
    connectionSessions?.delete(sessionId);

    const connSet = this.sessionToConnections.get(sessionId);
    if (connSet) {
      connSet.delete(connectionId);
      if (connSet.size === 0) {
        this.sessionToConnections.delete(sessionId);
        this.sessionToConnection.delete(sessionId);
      } else if (this.sessionToConnection.get(sessionId) === connectionId) {
        const next = connSet.values().next().value;
        if (next !== undefined) {
          this.sessionToConnection.set(sessionId, next);
        } else {
          this.sessionToConnection.delete(sessionId);
        }
      }
      return;
    }

    if (this.sessionToConnection.get(sessionId) === connectionId) {
      this.sessionToConnection.delete(sessionId);
    }
  }
}
