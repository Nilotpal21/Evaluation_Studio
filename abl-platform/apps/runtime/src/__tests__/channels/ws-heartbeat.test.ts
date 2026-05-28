/**
 * WebSocket Heartbeat Tests
 *
 * Tests the protocol-level ping/pong heartbeat that keeps connections alive
 * through proxies (Azure AppGW, NGINX, load balancers) and detects dead clients.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// =============================================================================
// MOCKS
// =============================================================================

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Import after mocks
import {
  startHeartbeat,
  stopHeartbeat,
  trackConnection,
  _wsAlive,
} from '../../websocket/heartbeat.js';

// =============================================================================
// HELPERS
// =============================================================================

/** Minimal WebSocket mock that supports EventEmitter pattern + ping/terminate */
class MockWebSocket extends EventEmitter {
  OPEN = 1 as const;
  readyState = 1;
  ping = vi.fn();
  terminate = vi.fn();
  send = vi.fn();
  close = vi.fn();
}

/** Create a mock WebSocketServer with a clients Set */
function createMockServer(clients: MockWebSocket[] = []): any {
  return {
    clients: new Set(clients),
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('WebSocket Heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    stopHeartbeat();
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // trackConnection
  // ---------------------------------------------------------------------------

  describe('trackConnection', () => {
    test('marks connection as alive on registration', () => {
      const ws = new MockWebSocket();
      trackConnection(ws as any);

      expect(_wsAlive.get(ws as any)).toBe(true);
    });

    test('registers pong handler that marks connection alive', () => {
      const ws = new MockWebSocket();
      trackConnection(ws as any);

      // Simulate the heartbeat marking it as pending (false)
      _wsAlive.set(ws as any, false);
      expect(_wsAlive.get(ws as any)).toBe(false);

      // Simulate pong response
      ws.emit('pong');
      expect(_wsAlive.get(ws as any)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // startHeartbeat
  // ---------------------------------------------------------------------------

  describe('startHeartbeat', () => {
    test('sends ping to all connected clients at configured interval', () => {
      const ws1 = new MockWebSocket();
      const ws2 = new MockWebSocket();
      const server = createMockServer([ws1, ws2]);

      trackConnection(ws1 as any);
      trackConnection(ws2 as any);

      startHeartbeat([server], 5000);

      // No pings sent yet
      expect(ws1.ping).not.toHaveBeenCalled();
      expect(ws2.ping).not.toHaveBeenCalled();

      // Advance past the interval
      vi.advanceTimersByTime(5000);

      expect(ws1.ping).toHaveBeenCalledTimes(1);
      expect(ws2.ping).toHaveBeenCalledTimes(1);
    });

    test('marks clients as pending (false) before sending ping', () => {
      const ws = new MockWebSocket();
      const server = createMockServer([ws]);
      trackConnection(ws as any);

      expect(_wsAlive.get(ws as any)).toBe(true);

      startHeartbeat([server], 5000);
      vi.advanceTimersByTime(5000);

      // After ping cycle, ws should be marked as pending (false)
      expect(_wsAlive.get(ws as any)).toBe(false);
      expect(ws.ping).toHaveBeenCalledTimes(1);
    });

    test('terminates client that missed previous pong', () => {
      const ws = new MockWebSocket();
      const server = createMockServer([ws]);
      trackConnection(ws as any);

      startHeartbeat([server], 5000);

      // First cycle: marks pending and sends ping
      vi.advanceTimersByTime(5000);
      expect(ws.ping).toHaveBeenCalledTimes(1);
      expect(ws.terminate).not.toHaveBeenCalled();

      // Client does NOT respond with pong — wsAlive stays false

      // Second cycle: detects missed pong and terminates
      vi.advanceTimersByTime(5000);
      expect(ws.terminate).toHaveBeenCalledTimes(1);
    });

    test('does not terminate client that responded with pong', () => {
      const ws = new MockWebSocket();
      const server = createMockServer([ws]);
      trackConnection(ws as any);

      startHeartbeat([server], 5000);

      // First cycle: marks pending and sends ping
      vi.advanceTimersByTime(5000);
      expect(ws.ping).toHaveBeenCalledTimes(1);

      // Client responds with pong
      ws.emit('pong');
      expect(_wsAlive.get(ws as any)).toBe(true);

      // Second cycle: client is alive, should ping again (not terminate)
      vi.advanceTimersByTime(5000);
      expect(ws.terminate).not.toHaveBeenCalled();
      expect(ws.ping).toHaveBeenCalledTimes(2);
    });

    test('handles multiple servers', () => {
      const ws1 = new MockWebSocket();
      const ws2 = new MockWebSocket();
      const server1 = createMockServer([ws1]);
      const server2 = createMockServer([ws2]);

      trackConnection(ws1 as any);
      trackConnection(ws2 as any);

      startHeartbeat([server1, server2], 5000);
      vi.advanceTimersByTime(5000);

      expect(ws1.ping).toHaveBeenCalledTimes(1);
      expect(ws2.ping).toHaveBeenCalledTimes(1);
    });

    test('pings repeatedly at the configured interval', () => {
      const ws = new MockWebSocket();
      const server = createMockServer([ws]);
      trackConnection(ws as any);

      startHeartbeat([server], 3000);

      // Respond with pong each cycle to stay alive
      for (let i = 1; i <= 5; i++) {
        vi.advanceTimersByTime(3000);
        expect(ws.ping).toHaveBeenCalledTimes(i);
        ws.emit('pong'); // Stay alive
      }

      expect(ws.terminate).not.toHaveBeenCalled();
    });

    test('handles empty server (no clients)', () => {
      const server = createMockServer([]);

      startHeartbeat([server], 5000);

      // Should not throw
      vi.advanceTimersByTime(5000);
    });

    test('handles client added after heartbeat started', () => {
      const server = createMockServer([]);

      startHeartbeat([server], 5000);

      // Add client after heartbeat is running
      const ws = new MockWebSocket();
      trackConnection(ws as any);
      (server.clients as Set<MockWebSocket>).add(ws);

      vi.advanceTimersByTime(5000);

      expect(ws.ping).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // stopHeartbeat
  // ---------------------------------------------------------------------------

  describe('stopHeartbeat', () => {
    test('stops the heartbeat interval', () => {
      const ws = new MockWebSocket();
      const server = createMockServer([ws]);
      trackConnection(ws as any);

      startHeartbeat([server], 5000);

      // First tick fires
      vi.advanceTimersByTime(5000);
      expect(ws.ping).toHaveBeenCalledTimes(1);

      stopHeartbeat();

      // Further ticks should not send pings
      vi.advanceTimersByTime(15000);
      expect(ws.ping).toHaveBeenCalledTimes(1);
    });

    test('is safe to call when no heartbeat is running', () => {
      // Should not throw
      stopHeartbeat();
      stopHeartbeat();
    });

    test('can restart heartbeat after stopping', () => {
      const ws = new MockWebSocket();
      const server = createMockServer([ws]);
      trackConnection(ws as any);

      startHeartbeat([server], 5000);
      vi.advanceTimersByTime(5000);
      expect(ws.ping).toHaveBeenCalledTimes(1);

      stopHeartbeat();

      // Respond to first ping to stay alive
      ws.emit('pong');

      startHeartbeat([server], 5000);
      vi.advanceTimersByTime(5000);
      expect(ws.ping).toHaveBeenCalledTimes(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    test('untracked client in server.clients gets marked pending and pinged', () => {
      // Client added to server.clients but trackConnection was never called
      const ws = new MockWebSocket();
      const server = createMockServer([ws]);

      startHeartbeat([server], 5000);
      vi.advanceTimersByTime(5000);

      // wsAlive.get(ws) returns undefined (not false), so it should ping, not terminate
      expect(ws.terminate).not.toHaveBeenCalled();
      expect(ws.ping).toHaveBeenCalledTimes(1);
      expect(_wsAlive.get(ws as any)).toBe(false);

      // Second cycle: now wsAlive is false and no pong → terminate
      vi.advanceTimersByTime(5000);
      expect(ws.terminate).toHaveBeenCalledTimes(1);
    });

    test('client removed from server after termination is not pinged again', () => {
      const ws = new MockWebSocket();
      const server = createMockServer([ws]);
      trackConnection(ws as any);

      // Mock terminate to remove from clients set (real ws behavior)
      ws.terminate.mockImplementation(() => {
        (server.clients as Set<MockWebSocket>).delete(ws);
      });

      startHeartbeat([server], 5000);

      // First cycle: ping
      vi.advanceTimersByTime(5000);
      expect(ws.ping).toHaveBeenCalledTimes(1);

      // No pong → second cycle terminates
      vi.advanceTimersByTime(5000);
      expect(ws.terminate).toHaveBeenCalledTimes(1);

      // Third cycle: client is gone from set, no more pings
      vi.advanceTimersByTime(5000);
      expect(ws.ping).toHaveBeenCalledTimes(1); // still 1, not incremented
    });
  });
});
