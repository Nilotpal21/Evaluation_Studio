import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { WebSocket } from 'ws';
import { WebSocketConnectionManager } from '../../websocket/connection-manager.js';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

class MockWebSocket extends EventEmitter {
  readyState = 1;
  close = vi.fn();
}

function toWebSocket(ws: MockWebSocket): WebSocket {
  return ws as unknown as WebSocket;
}

describe('WebSocketConnectionManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-24T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('sweeps an idle connection that never reports activity', () => {
    const manager = new WebSocketConnectionManager<{ lastActivity: number }>({
      label: 'test',
      staleTtlMs: 1000,
      sweepIntervalMs: 100,
    });
    const ws = new MockWebSocket();

    manager.add(toWebSocket(ws), { lastActivity: 0 });

    vi.advanceTimersByTime(1100);

    expect(ws.close).toHaveBeenCalledWith(1001, 'Connection idle timeout');
    expect(manager.size).toBe(0);

    manager.shutdown();
  });

  test('refreshes lastActivity on pong so healthy idle connections are not swept', () => {
    const manager = new WebSocketConnectionManager<{ lastActivity: number }>({
      label: 'test',
      staleTtlMs: 1000,
      sweepIntervalMs: 100,
    });
    const ws = new MockWebSocket();

    manager.add(toWebSocket(ws), { lastActivity: 0 });
    const initialActivity = manager.get(toWebSocket(ws))?.lastActivity;

    vi.advanceTimersByTime(900);
    ws.emit('pong');

    const refreshedActivity = manager.get(toWebSocket(ws))?.lastActivity;

    vi.advanceTimersByTime(200);

    expect(refreshedActivity).toBeGreaterThan(initialActivity ?? 0);
    expect(ws.close).not.toHaveBeenCalled();
    expect(manager.size).toBe(1);

    manager.shutdown();
  });
});
