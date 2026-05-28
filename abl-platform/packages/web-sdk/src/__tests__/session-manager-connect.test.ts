import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AgentSDK } from '../core/AgentSDK.js';
import { SessionManager } from '../core/SessionManager.js';
import { TokenManager } from '../core/TokenManager.js';
import type {
  SDKConfig,
  WSServerMessage,
  WebSocketConstructor,
  WebSocketCloseEventLike,
  WebSocketLike,
} from '../core/types.js';

class FakeWebSocket implements WebSocketLike {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: WebSocketCloseEventLike) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  readonly url: string;
  readonly protocols: string | string[] | undefined;
  readonly sentFrames: string[] = [];

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sentFrames.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === FakeWebSocket.CLOSED) {
      return;
    }
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  serverOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({});
  }

  serverMessage(message: WSServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

function createConfig(): SDKConfig {
  return {
    projectId: 'project-1',
    apiKey: 'pk_test',
    endpoint: 'http://localhost:3112',
    webSocketConstructor: FakeWebSocket as unknown as WebSocketConstructor,
  };
}

function createSdkSessionResponse(
  overrides: Partial<{
    token: string;
    expiresIn: number;
    tenantId: string;
    projectId: string;
    deploymentId?: string;
    channelId: string;
    permissions: string[];
    showActivityUpdates: boolean;
  }> = {},
): Response {
  return {
    ok: true,
    json: async () => ({
      token: 'sdk_token_1',
      expiresIn: 300,
      tenantId: 'tenant-1',
      projectId: 'project-1',
      channelId: 'channel-1',
      permissions: ['session:send_message'],
      showActivityUpdates: false,
      ...overrides,
    }),
    text: async () => '',
  } as Response;
}

function readRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof input === 'object' && input !== null && 'url' in input) {
    return String(input.url);
  }
  return String(input);
}

function createFetchMock(
  options: {
    sessionResponses?: Array<
      Partial<{
        token: string;
        expiresIn: number;
        tenantId: string;
        projectId: string;
        deploymentId?: string;
        channelId: string;
        permissions: string[];
        showActivityUpdates: boolean;
      }>
    >;
    ticketResponse?: Response;
  } = {},
) {
  let callCount = 0;
  let sessionIndex = 0;
  return vi.fn(async (input: RequestInfo | URL) => {
    callCount += 1;
    const url = readRequestUrl(input);
    const isTicketRequest = url.includes('/api/v1/sdk/ws-ticket') || callCount % 2 === 0;
    if (isTicketRequest) {
      return (
        options.ticketResponse ??
        ({
          ok: false,
          status: 404,
          json: async () => ({}),
          text: async () => '',
        } as Response)
      );
    }

    const sessionResponse = options.sessionResponses?.[sessionIndex] ?? {};
    sessionIndex += 1;
    return createSdkSessionResponse(sessionResponse);
  });
}

async function flushAsyncWork(iterations = 32): Promise<void> {
  for (let index = 0; index < iterations; index++) {
    await Promise.resolve();
  }
}

describe('SessionManager connect readiness', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('fetch', createFetchMock());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test('connect resolves only after session_start, not raw websocket open', async () => {
    const config = createConfig();
    const manager = new SessionManager(config, new TokenManager(config));
    const connectedHandler = vi.fn();
    manager.on('connected', connectedHandler);

    const connectPromise = manager.connect();
    let resolved = false;
    connectPromise.then(() => {
      resolved = true;
    });

    await flushAsyncWork();
    expect(FakeWebSocket.instances).toHaveLength(1);
    const socket = FakeWebSocket.instances[0];

    socket.serverOpen();
    await Promise.resolve();

    expect(resolved).toBe(false);
    expect(connectedHandler).toHaveBeenCalledTimes(0);
    expect(manager.isConnected()).toBe(false);

    socket.serverMessage({
      type: 'session_start',
      sessionId: 'session-1',
    });

    await connectPromise;

    expect(resolved).toBe(true);
    expect(connectedHandler).toHaveBeenCalledTimes(1);
    expect(manager.isConnected()).toBe(true);
    expect(manager.getSessionId()).toBe('session-1');
  });

  test('connect uses one-time websocket ticket when Runtime supports ticket minting', async () => {
    const fetchMock = createFetchMock({
      ticketResponse: {
        ok: true,
        json: async () => ({ ticket: 'ws-ticket-1', expiresIn: 60 }),
        text: async () => '',
      } as Response,
    });
    vi.stubGlobal('fetch', fetchMock);

    const config = createConfig();
    const manager = new SessionManager(config, new TokenManager(config));
    const connectPromise = manager.connect();

    await flushAsyncWork();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].protocols).toEqual(['sdk-ticket', 'ws-ticket-1']);

    FakeWebSocket.instances[0].serverMessage({
      type: 'session_start',
      sessionId: 'session-ticket',
    });
    await connectPromise;
  });

  test('connect falls back to deprecated session-token websocket auth when ticket minting is unavailable', async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    const config = createConfig();
    const manager = new SessionManager(config, new TokenManager(config));
    const connectPromise = manager.connect();

    await flushAsyncWork();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].protocols).toEqual(['sdk-auth', 'sdk_token_1']);

    FakeWebSocket.instances[0].serverMessage({
      type: 'session_start',
      sessionId: 'session-legacy',
    });
    await connectPromise;
  });

  test('connect rejects instead of falling back when ticket minting fails operationally', async () => {
    const fetchMock = createFetchMock({
      ticketResponse: {
        ok: false,
        status: 503,
        json: async () => ({}),
        text: async () => '',
      } as Response,
    });
    vi.stubGlobal('fetch', fetchMock);

    const config = createConfig();
    const manager = new SessionManager(config, new TokenManager(config));

    await expect(manager.connect()).rejects.toThrow(
      'WebSocket ticket request failed with status 503',
    );
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  test('connect rejects when session_start never arrives (timeout)', async () => {
    vi.useFakeTimers();

    const config = createConfig();
    const manager = new SessionManager(config, new TokenManager(config));

    const connectPromise = manager.connect();
    const handledRejection = connectPromise.then(
      () => ({ status: 'resolved' as const }),
      (error) => ({ status: 'rejected' as const, error }),
    );

    await flushAsyncWork();
    expect(FakeWebSocket.instances).toHaveLength(1);

    const socket = FakeWebSocket.instances[0];
    socket.serverOpen();

    await vi.advanceTimersByTimeAsync(10_000);

    const result = await handledRejection;
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toContain('Timed out waiting for session_start');
    }
    manager.disconnect();
  });

  test('reconnect emits connected only after the next session_start', async () => {
    vi.useFakeTimers();

    const config = createConfig();
    const manager = new SessionManager(config, new TokenManager(config));
    const connectedHandler = vi.fn();
    const disconnectedHandler = vi.fn();
    manager.on('connected', connectedHandler);
    manager.on('disconnected', disconnectedHandler);

    const firstConnect = manager.connect();
    await flushAsyncWork();
    const firstSocket = FakeWebSocket.instances[0];
    firstSocket.serverOpen();
    firstSocket.serverMessage({
      type: 'session_start',
      sessionId: 'session-1',
    });
    await firstConnect;

    expect(connectedHandler).toHaveBeenCalledTimes(1);

    firstSocket.close(1006, 'transport drop');
    expect(disconnectedHandler).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await flushAsyncWork();
    expect(FakeWebSocket.instances).toHaveLength(2);

    const reconnectSocket = FakeWebSocket.instances[1];
    reconnectSocket.serverOpen();
    await Promise.resolve();
    expect(connectedHandler).toHaveBeenCalledTimes(1);

    reconnectSocket.serverMessage({
      type: 'session_start',
      sessionId: 'session-2',
    });
    await Promise.resolve();

    expect(connectedHandler).toHaveBeenCalledTimes(2);
    expect(manager.getSessionId()).toBe('session-2');

    manager.disconnect();
  });

  test('session_start does not begin a JSON heartbeat timer', async () => {
    vi.useFakeTimers();

    const config = createConfig();
    const manager = new SessionManager(config, new TokenManager(config));

    const connectPromise = manager.connect();
    await flushAsyncWork();
    expect(FakeWebSocket.instances).toHaveLength(1);

    const socket = FakeWebSocket.instances[0];
    socket.serverOpen();
    socket.serverMessage({
      type: 'session_start',
      sessionId: 'session-no-heartbeat',
    });

    await connectPromise;
    expect(socket.sentFrames).toEqual([]);

    await vi.advanceTimersByTimeAsync(31_000);
    expect(socket.sentFrames).toEqual([]);

    manager.disconnect();
  });

  test('uses Runtime-issued channel scope after bootstrap when the project matches SDK config', async () => {
    vi.stubGlobal(
      'fetch',
      createFetchMock({
        sessionResponses: [
          {
            token: 'sdk_token_scope',
            channelId: 'channel-bound',
          },
        ],
      }),
    );

    const config = createConfig();
    const manager = new SessionManager(config, new TokenManager(config));

    const connectPromise = manager.connect();
    await flushAsyncWork();
    expect(FakeWebSocket.instances).toHaveLength(1);
    const socket = FakeWebSocket.instances[0];
    socket.serverOpen();
    socket.serverMessage({
      type: 'session_start',
      sessionId: 'session-bound',
      projectId: 'project-1',
      channelId: 'channel-bound',
    });

    await connectPromise;

    expect(manager.getProjectId()).toBe('project-1');
    expect(manager.getChannelId()).toBe('channel-bound');
    expect(manager.getScope()).toEqual({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      channelId: 'channel-bound',
      deploymentId: undefined,
      permissions: ['session:send_message'],
      showActivityUpdates: false,
    });
    manager.disconnect();
  });

  test('disconnect clears resolved session scope instead of leaking the prior session values', async () => {
    vi.stubGlobal(
      'fetch',
      createFetchMock({
        sessionResponses: [
          {
            token: 'sdk_token_scope',
            channelId: 'channel-from-token',
          },
        ],
      }),
    );

    const config = createConfig();
    const manager = new SessionManager(config, new TokenManager(config));

    const connectPromise = manager.connect();
    await flushAsyncWork();
    expect(FakeWebSocket.instances).toHaveLength(1);
    const socket = FakeWebSocket.instances[0];
    socket.serverOpen();
    socket.serverMessage({
      type: 'session_start',
      sessionId: 'session-live',
      projectId: 'project-from-session',
      channelId: 'channel-from-session',
    });

    await connectPromise;

    expect(manager.getProjectId()).toBe('project-from-session');
    expect(manager.getChannelId()).toBe('channel-from-session');

    manager.disconnect();

    expect(manager.getSessionId()).toBeNull();
    expect(manager.getProjectId()).toBe('project-1');
    expect(manager.getChannelId()).toBeNull();
  });

  test('auth-close invalidates cached token before reconnecting', async () => {
    vi.useFakeTimers();

    const fetchMock = createFetchMock({
      sessionResponses: [{}, { token: 'sdk_token_2' }],
    });
    vi.stubGlobal('fetch', fetchMock);

    const config = createConfig();
    const manager = new SessionManager(config, new TokenManager(config));

    const firstConnect = manager.connect();
    await flushAsyncWork();
    const firstSocket = FakeWebSocket.instances[0];
    firstSocket.serverOpen();
    firstSocket.serverMessage({
      type: 'session_start',
      sessionId: 'session-1',
      projectId: 'project-from-session',
      channelId: 'channel-from-session',
    });
    await firstConnect;

    expect(firstSocket.protocols).toEqual(['sdk-auth', 'sdk_token_1']);
    expect(manager.getProjectId()).toBe('project-from-session');
    expect(manager.getChannelId()).toBe('channel-from-session');

    firstSocket.close(4003, 'Invalid or expired session token');

    expect(manager.getSessionId()).toBeNull();
    expect(manager.getProjectId()).toBe('project-1');
    expect(manager.getChannelId()).toBeNull();

    await vi.advanceTimersByTimeAsync(1_000);
    await flushAsyncWork();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(FakeWebSocket.instances).toHaveLength(2);

    const reconnectSocket = FakeWebSocket.instances[1];
    expect(reconnectSocket.protocols).toEqual(['sdk-auth', 'sdk_token_2']);

    reconnectSocket.serverOpen();
    reconnectSocket.serverMessage({
      type: 'session_start',
      sessionId: 'session-2',
      projectId: 'project-1',
      channelId: 'channel-1',
    });
    await flushAsyncWork();

    manager.disconnect();
  });
});

describe('AgentSDK session start compatibility', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('fetch', createFetchMock());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test('emits sessionStart using canonical sessionId only', async () => {
    const sdk = new AgentSDK(createConfig());
    const sessionStartHandler = vi.fn();
    const sessionEndHandler = vi.fn();
    sdk.on('sessionStart', sessionStartHandler);
    sdk.on('sessionEnd', sessionEndHandler);

    const connectPromise = sdk.connect();
    await flushAsyncWork();
    expect(FakeWebSocket.instances).toHaveLength(1);

    const socket = FakeWebSocket.instances[0];
    socket.serverOpen();
    socket.serverMessage({
      type: 'session_start',
      sessionId: 'session-sdk-1',
      projectId: 'project-1',
      channelId: 'channel-1',
    });

    await connectPromise;
    socket.serverMessage({
      type: 'session_ended',
      sessionId: 'session-sdk-1',
    });

    expect(sessionStartHandler).toHaveBeenCalledWith({
      sessionId: 'session-sdk-1',
      projectId: 'project-1',
      channelId: 'channel-1',
    });
    expect(sessionEndHandler).toHaveBeenCalledTimes(1);

    sdk.disconnect();
  });

  test('disconnects the websocket after configured browser idle timeout', async () => {
    vi.useFakeTimers();
    const sdk = new AgentSDK({
      ...createConfig(),
      idleDisconnect: {
        timeoutMs: 1_000,
      },
    });
    const idleTimeoutHandler = vi.fn();
    sdk.on('idleTimeout', idleTimeoutHandler);

    const connectPromise = sdk.connect();
    await flushAsyncWork();
    expect(FakeWebSocket.instances).toHaveLength(1);

    const socket = FakeWebSocket.instances[0];
    socket.serverOpen();
    socket.serverMessage({
      type: 'session_start',
      sessionId: 'session-idle-disconnect',
      projectId: 'project-1',
      channelId: 'channel-1',
    });

    await connectPromise;

    await vi.advanceTimersByTimeAsync(999);
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);

    globalThis.dispatchEvent(new Event('mousemove'));
    await vi.advanceTimersByTimeAsync(999);
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);

    await vi.advanceTimersByTimeAsync(1);

    expect(idleTimeoutHandler).toHaveBeenCalledWith({
      timeoutMs: 1_000,
      behavior: 'disconnect',
    });
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
  });

  test('counts outbound SDK messages as browser activity for idle disconnect', async () => {
    vi.useFakeTimers();
    const sdk = new AgentSDK({
      ...createConfig(),
      idleDisconnect: {
        timeoutMs: 1_000,
      },
    });

    const connectPromise = sdk.connect();
    await flushAsyncWork();
    expect(FakeWebSocket.instances).toHaveLength(1);

    const socket = FakeWebSocket.instances[0];
    socket.serverOpen();
    socket.serverMessage({
      type: 'session_start',
      sessionId: 'session-idle-outbound-activity',
      projectId: 'project-1',
      channelId: 'channel-1',
    });

    await connectPromise;

    await vi.advanceTimersByTimeAsync(999);
    await sdk.chat().send('Still here');

    await vi.advanceTimersByTimeAsync(999);
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);

    await vi.advanceTimersByTimeAsync(1);
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
  });

  test('can ask Runtime to end the session after browser idle timeout', async () => {
    vi.useFakeTimers();
    const sdk = new AgentSDK({
      ...createConfig(),
      idleDisconnect: {
        timeoutMs: 1_000,
        behavior: 'end_session',
      },
    });

    const connectPromise = sdk.connect();
    await flushAsyncWork();
    expect(FakeWebSocket.instances).toHaveLength(1);

    const socket = FakeWebSocket.instances[0];
    socket.serverOpen();
    socket.serverMessage({
      type: 'session_start',
      sessionId: 'session-idle-end',
      projectId: 'project-1',
      channelId: 'channel-1',
    });

    await connectPromise;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(socket.sentFrames).toContain(JSON.stringify({ type: 'end_session' }));
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
  });
});
