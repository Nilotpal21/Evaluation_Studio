/**
 * AudioCodes WebSocket Manager Tests
 *
 * Tests connection registration, activity sending, connection removal,
 * replacement of existing connections, and cleanup on WebSocket close.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  registerConnection,
  sendActivities,
  removeConnection,
  hasConnection,
  stopCleanup,
} from '../../../channels/audiocodes/ws-manager.js';

function createMockWs(readyState = 1): any {
  const listeners: Record<string, Function[]> = {};
  return {
    readyState,
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn((event: string, cb: Function) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
    }),
    _triggerClose: () => {
      for (const cb of listeners['close'] || []) cb();
    },
  };
}

describe('AudioCodes WebSocket Manager', () => {
  afterEach(() => {
    // Clean up all connections between tests
    stopCleanup();
  });

  it('registers and retrieves a connection', () => {
    const ws = createMockWs();
    registerConnection('conv-test-1', ws, 'conn-1');

    expect(hasConnection('conv-test-1')).toBe(true);
  });

  it('sends activities over WebSocket', () => {
    const ws = createMockWs();
    registerConnection('conv-test-2', ws, 'conn-2');

    const activities = [{ type: 'message', text: 'Hello' }];
    const result = sendActivities('conv-test-2', activities as any);

    expect(result).toBe(true);
    expect(ws.send).toHaveBeenCalledOnce();
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ activities }));
  });

  it('returns false when no connection exists', () => {
    const result = sendActivities('conv-test-3-nonexistent', []);
    expect(result).toBe(false);
  });

  it('returns false when WebSocket is not open', () => {
    const ws = createMockWs(3); // CLOSED
    registerConnection('conv-test-4', ws, 'conn-4');

    const result = sendActivities('conv-test-4', [{ type: 'message', text: 'Hi' }] as any);

    expect(result).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('removes connection on removeConnection()', () => {
    const ws = createMockWs();
    registerConnection('conv-test-5', ws, 'conn-5');

    expect(hasConnection('conv-test-5')).toBe(true);

    removeConnection('conv-test-5');

    expect(hasConnection('conv-test-5')).toBe(false);
    expect(ws.close).toHaveBeenCalledWith(1000, 'Conversation ended');
  });

  it('replaces existing connection for same conversationId', () => {
    const oldWs = createMockWs();
    const newWs = createMockWs();

    registerConnection('conv-test-6', oldWs, 'conn-6a');
    registerConnection('conv-test-6', newWs, 'conn-6b');

    expect(oldWs.close).toHaveBeenCalledWith(1000, 'Replaced by new connection');

    const activities = [{ type: 'message', text: 'Test' }];
    sendActivities('conv-test-6', activities as any);

    expect(newWs.send).toHaveBeenCalledOnce();
    expect(oldWs.send).not.toHaveBeenCalled();
  });

  it('removes connection when WebSocket closes', () => {
    const ws = createMockWs();
    registerConnection('conv-test-7', ws, 'conn-7');

    expect(hasConnection('conv-test-7')).toBe(true);

    ws._triggerClose();

    expect(hasConnection('conv-test-7')).toBe(false);
  });
});
