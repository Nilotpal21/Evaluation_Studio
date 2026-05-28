/**
 * WebSocket Heartbeat
 *
 * Protocol-level ping/pong heartbeat to keep connections alive through
 * proxies (Azure AppGW, NGINX, load balancers) and detect dead clients.
 *
 * Pattern: every heartbeatIntervalMs, iterate all connections:
 *   - If a client missed the previous pong → terminate (dead connection)
 *   - Otherwise mark as pending and send a ping frame
 * Clients automatically respond with pong (handled by the WebSocket protocol).
 */

import type { WebSocketServer, WebSocket as WsWebSocket } from 'ws';
import { createLogger } from '@abl/compiler/platform';

const wsAlive = new WeakMap<WsWebSocket, boolean>();
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
const heartbeatLog = createLogger('ws-heartbeat');

export function startHeartbeat(servers: WebSocketServer[], intervalMs: number): void {
  heartbeatLog.info('WebSocket heartbeat started', { intervalMs });

  heartbeatInterval = setInterval(() => {
    for (const wsServer of servers) {
      wsServer.clients.forEach((ws) => {
        if (wsAlive.get(ws) === false) {
          heartbeatLog.warn('Terminating unresponsive WebSocket client');
          ws.terminate();
          return;
        }
        wsAlive.set(ws, false);
        ws.ping();
      });
    }
  }, intervalMs);
}

export function stopHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

/** Register pong handler for a new WebSocket connection */
export function trackConnection(ws: WsWebSocket): void {
  wsAlive.set(ws, true);
  ws.on('pong', () => {
    wsAlive.set(ws, true);
  });
}

// Exported for testing only
export { wsAlive as _wsAlive };
