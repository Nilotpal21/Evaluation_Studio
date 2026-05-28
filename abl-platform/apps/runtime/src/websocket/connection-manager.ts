import { createLogger } from '@abl/compiler/platform';
import type { WebSocket } from 'ws';

const log = createLogger('ws-connection-manager');

export interface ManagedClientState {
  lastActivity: number;
  tenantId?: string;
  // Additional fields will be set by the specific handler
  [key: string]: unknown;
}

export interface ConnectionManagerConfig {
  maxConnections: number;
  staleTtlMs: number;
  sweepIntervalMs: number;
  label: string; // 'internal' or 'sdk' — for metrics/logging
}

const DEFAULT_CONFIG: ConnectionManagerConfig = {
  maxConnections: 10_000,
  staleTtlMs: 5 * 60 * 1000, // 5 minutes
  sweepIntervalMs: 60 * 1000, // 60 seconds
  label: 'unknown',
};

export class WebSocketConnectionManager<T extends ManagedClientState> {
  private readonly clients = new Map<WebSocket, T>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly config: ConnectionManagerConfig;

  constructor(config: Partial<ConnectionManagerConfig> & { label: string }) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.startSweep();
  }

  get size(): number {
    return this.clients.size;
  }

  add(ws: WebSocket, state: T): boolean {
    if (this.clients.size >= this.config.maxConnections) {
      log.warn('Connection rejected: at capacity', {
        label: this.config.label,
        current: this.clients.size,
        max: this.config.maxConnections,
      });
      return false; // Caller should close with 1013
    }
    state.lastActivity = Date.now();
    this.clients.set(ws, state);
    // Treat protocol-level pong frames as liveness for stale-sweep purposes.
    // Without this, healthy idle browser tabs get swept even while heartbeat
    // proves the socket is still alive.
    ws.on('pong', () => {
      this.touch(ws);
    });
    return true;
  }

  remove(ws: WebSocket): boolean {
    return this.clients.delete(ws);
  }

  /**
   * Alias for `remove()` — preserves Map-like API for callers that
   * import the manager as a drop-in replacement.
   */
  delete(ws: WebSocket): boolean {
    return this.remove(ws);
  }

  get(ws: WebSocket): T | undefined {
    return this.clients.get(ws);
  }

  has(ws: WebSocket): boolean {
    return this.clients.has(ws);
  }

  touch(ws: WebSocket): void {
    const state = this.clients.get(ws);
    if (state) state.lastActivity = Date.now();
  }

  forEach(fn: (state: T, ws: WebSocket) => void): void {
    this.clients.forEach((state, ws) => fn(state, ws));
  }

  /**
   * Iterate over all clients. Supports `for (const [ws, state] of manager)`.
   */
  [Symbol.iterator](): IterableIterator<[WebSocket, T]> {
    return this.clients.entries();
  }

  /**
   * Remove all entries from the manager without closing sockets.
   */
  clear(): void {
    this.clients.clear();
  }

  private startSweep(): void {
    this.sweepTimer = setInterval(() => {
      const now = Date.now();
      const staleThreshold = now - this.config.staleTtlMs;
      let swept = 0;
      for (const [ws, state] of this.clients) {
        if (state.lastActivity < staleThreshold || ws.readyState > 1) {
          ws.close(1001, 'Connection idle timeout');
          this.clients.delete(ws);
          swept++;
        }
      }
      if (swept > 0) {
        log.info('Stale connections swept', {
          label: this.config.label,
          swept,
          remaining: this.clients.size,
        });
      }
    }, this.config.sweepIntervalMs);
    this.sweepTimer.unref();
  }

  /**
   * Broadcast a JSON message to all WebSocket connections associated with a session.
   * Linear scan — bounded by maxConnections (10k max), <1ms typical.
   * When tenantId is provided, only connections matching that tenant are included (defense-in-depth).
   * Returns the number of messages sent.
   */
  broadcastToSession(sessionId: string, event: string, data: unknown, tenantId?: string): number {
    let count = 0;
    for (const [ws, state] of this.clients) {
      if ((state.sessionId as string | undefined) !== sessionId) continue;
      if (tenantId && state.tenantId && state.tenantId !== tenantId) continue;
      if (ws.readyState !== 1) continue;
      try {
        ws.send(JSON.stringify({ event, data }));
        count++;
      } catch (err) {
        log.debug('Failed to send to WS during broadcast', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return count;
  }

  shutdown(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const [ws] of this.clients) {
      ws.close(1001, 'Server shutting down');
    }
    this.clients.clear();
  }
}
