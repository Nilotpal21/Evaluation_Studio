import { beforeEach, describe, expect, test, vi } from 'vitest';

type MockSocketInstance = {
  url: string;
  protocols?: string | string[];
  emit: (event: string, ...args: unknown[]) => void;
};

const websocketInstances = vi.hoisted(() => [] as MockSocketInstance[]);

vi.mock('ws', () => {
  class MockWebSocket {
    static readonly OPEN = 1;

    public readonly url: string;
    public readonly protocols?: string | string[];
    public readyState = 0;
    private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

    constructor(url: string, protocols?: string | string[]) {
      this.url = url;
      this.protocols = protocols;
      websocketInstances.push(this);
    }

    on(event: string, handler: (...args: unknown[]) => void): void {
      const existing = this.listeners.get(event) ?? new Set();
      existing.add(handler);
      this.listeners.set(event, existing);
    }

    removeAllListeners(): void {
      this.listeners.clear();
    }

    close(): void {
      this.readyState = 3;
    }

    emit(event: string, ...args: unknown[]): void {
      if (event === 'open') {
        this.readyState = MockWebSocket.OPEN;
      }
      for (const handler of this.listeners.get(event) ?? []) {
        handler(...args);
      }
    }
  }

  return {
    default: MockWebSocket,
  };
});

import { WebSocketClient } from '../client/websocket-client.js';

describe('WebSocketClient', () => {
  beforeEach(() => {
    websocketInstances.length = 0;
  });

  test('uses the web-debug subprotocol transport when an auth token is present', async () => {
    const client = new WebSocketClient({ url: 'ws://localhost:3112/ws' });
    client.setAuthToken('jwt-token');

    const connectPromise = client.connect();
    const ws = websocketInstances.at(-1);

    expect(ws?.url).toBe('ws://localhost:3112/ws');
    expect(ws?.protocols).toEqual(['web-debug-auth', 'jwt-token']);

    ws?.emit('open');
    await expect(connectPromise).resolves.toBeUndefined();
  });

  test('rejects internal websocket connections when no auth token is configured', async () => {
    const client = new WebSocketClient({ url: 'ws://localhost:3112/ws' });

    await expect(client.connect()).rejects.toThrow(
      'Internal runtime WebSocket connections require setAuthToken() before connect().',
    );
    expect(websocketInstances).toHaveLength(0);
  });
});
