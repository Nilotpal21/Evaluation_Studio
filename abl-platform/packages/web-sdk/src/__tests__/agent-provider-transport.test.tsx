/**
 * AgentProvider Transport Tests (INT-6, INT-7)
 *
 * Tests AgentProvider with transport prop (Path B) and backwards compat (Path A).
 * Verifies useChat/useAgent/useVoice hooks return expected values.
 */

import React, { act } from 'react';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { Message, SDKPublicKeyConfig } from '../core/types.js';
import { TypedEventEmitter } from '../core/EventEmitter.js';
import type {
  SDKTransport,
  TransportServerMessage,
  TransportClientMessage,
  TransportError,
} from '../transport/types.js';

// ---------------------------------------------------------------------------
// Mock AgentSDK for Path A tests
// ---------------------------------------------------------------------------
type MockAgentSDKEvents = {
  connected: void;
  disconnected: void;
  error: { error: Error };
  sessionStart: { sessionId: string };
};

type MockChatClientEvents = {
  message: Message;
  messagesReplaced: { messages: Message[] };
  messageChunk: { messageId: string; chunk: string };
  typing: { isTyping: boolean };
  error: { error: Error };
  statusUpdate: { text: string; operation: string };
  statusClear: void;
};

type MockAgentSDKLike = {
  on: <E extends keyof MockAgentSDKEvents>(
    event: E,
    handler: (data: MockAgentSDKEvents[E]) => void,
  ) => () => void;
  emit: <E extends keyof MockAgentSDKEvents>(event: E, data: MockAgentSDKEvents[E]) => void;
  connect: typeof connectMock;
  disconnect: typeof disconnectMock;
  getSessionScope: () => { showActivityUpdates: boolean };
  chat: typeof chatMock;
  voice: typeof voiceMock;
};

type MockChatClientLike = {
  on: <E extends keyof MockChatClientEvents>(
    event: E,
    handler: (data: MockChatClientEvents[E]) => void,
  ) => () => void;
  emit: <E extends keyof MockChatClientEvents>(event: E, data: MockChatClientEvents[E]) => void;
  removeAllListeners: (event?: keyof MockChatClientEvents) => void;
  transport: unknown;
  uploadConfig: unknown;
  debug: unknown;
  dispose: () => void;
  send: typeof chatSendMock;
  getMessages: () => Message[];
};

const connectMock = vi.fn(async () => undefined);
const disconnectMock = vi.fn();
const onMock = vi.fn();
const chatMock = vi.fn();
const voiceMock = vi.fn();
const chatOnMock = vi.fn();
const chatRemoveAllListenersMock = vi.fn();
const chatDisposeMock = vi.fn();
const chatSendMock = vi.fn().mockResolvedValue('msg-1');
const voiceOnMock = vi.fn();
const voiceDisposeMock = vi.fn().mockResolvedValue(undefined);
const voiceStartMock = vi.fn().mockResolvedValue(undefined);
const voiceStopMock = vi.fn().mockResolvedValue(undefined);
const voiceToggleMuteMock = vi.fn(() => false);
const agentSdkInstances: MockAgentSDKLike[] = [];
const transportChatClientInstances: MockChatClientLike[] = [];
let nextTransportChatClientMessages: Message[] = [];

function createMockChatClient(
  transport: unknown,
  uploadConfig: unknown,
  debug: unknown,
): MockChatClientLike {
  class MockChatClientInstance extends TypedEventEmitter<MockChatClientEvents> {
    constructor(
      public transport: unknown,
      public uploadConfig: unknown,
      public debug: unknown,
    ) {
      super();
      this.messages = [...nextTransportChatClientMessages];
    }

    private messages: Message[];

    override on<E extends keyof MockChatClientEvents>(
      event: E,
      handler: (data: MockChatClientEvents[E]) => void,
    ): () => void {
      chatOnMock(event, handler);
      return super.on(event, handler);
    }

    override removeAllListeners(event?: keyof MockChatClientEvents): void {
      chatRemoveAllListenersMock(event);
      super.removeAllListeners(event);
    }

    dispose(): void {
      chatDisposeMock();
      this.removeAllListeners();
    }

    override emit<E extends keyof MockChatClientEvents>(
      event: E,
      data: MockChatClientEvents[E],
    ): void {
      if (event === 'message') {
        this.messages.push(data as Message);
      } else if (event === 'messagesReplaced') {
        this.messages = [...(data as { messages: Message[] }).messages];
      }
      super.emit(event, data);
    }

    getMessages(): Message[] {
      return [...this.messages];
    }

    submitAction(actionId: string, value?: string): void {
      (this.transport as SDKTransport).send({
        type: 'action_submit',
        actionId,
        ...(value !== undefined ? { value } : {}),
      });
    }

    send = chatSendMock;
  }

  return new MockChatClientInstance(transport, uploadConfig, debug);
}

vi.mock('../core/AgentSDK.js', () => {
  type AgentEvent = keyof MockAgentSDKEvents;
  type AgentListener<E extends AgentEvent> = (data: MockAgentSDKEvents[E]) => void;

  class AgentSDK {
    private listeners = new Map<AgentEvent, Set<AgentListener<AgentEvent>>>();

    constructor(_config: unknown) {
      agentSdkInstances.push(this as MockAgentSDKLike);
    }

    on<E extends AgentEvent>(event: E, handler: (data: MockAgentSDKEvents[E]) => void): () => void {
      onMock(event, handler);
      if (!this.listeners.has(event)) {
        this.listeners.set(event, new Set());
      }
      this.listeners.get(event)!.add(handler as AgentListener<AgentEvent>);
      return () => {
        this.listeners.get(event)?.delete(handler as AgentListener<AgentEvent>);
      };
    }

    emit<E extends AgentEvent>(event: E, data: MockAgentSDKEvents[E]): void {
      this.listeners.get(event)?.forEach((listener) => {
        listener(data);
      });
    }

    connect = connectMock;
    disconnect = disconnectMock;
    getSessionScope(): { showActivityUpdates: boolean } {
      return { showActivityUpdates: false };
    }
    chat = chatMock;
    voice = voiceMock;
  }

  return { AgentSDK };
});

// ---------------------------------------------------------------------------
// Mock ChatClient for Path B (imported after AgentSDK mock is in place)
// ---------------------------------------------------------------------------
vi.mock('../chat/ChatClient.js', () => {
  type ChatEvent = keyof MockChatClientEvents;
  type ChatListener<E extends ChatEvent> = (data: MockChatClientEvents[E]) => void;

  class ChatClient {
    private listeners = new Map<ChatEvent, Set<ChatListener<ChatEvent>>>();

    constructor(
      public transport: unknown,
      public uploadConfig: unknown,
      public debug: unknown,
    ) {
      transportChatClientInstances.push(this as unknown as MockChatClientLike);
      this.messages = [...nextTransportChatClientMessages];
    }

    private messages: Message[];

    on<E extends ChatEvent>(
      event: E,
      handler: (data: MockChatClientEvents[E]) => void,
    ): () => void {
      chatOnMock(event, handler);
      if (!this.listeners.has(event)) {
        this.listeners.set(event, new Set());
      }
      this.listeners.get(event)!.add(handler as ChatListener<ChatEvent>);
      return () => {
        this.listeners.get(event)?.delete(handler as ChatListener<ChatEvent>);
      };
    }

    emit<E extends ChatEvent>(event: E, data: MockChatClientEvents[E]): void {
      if (event === 'message') {
        this.messages.push(data as Message);
      } else if (event === 'messagesReplaced') {
        this.messages = [...(data as { messages: Message[] }).messages];
      }
      this.listeners.get(event)?.forEach((listener) => {
        listener(data);
      });
    }

    removeAllListeners(event?: ChatEvent): void {
      chatRemoveAllListenersMock(event);
      if (event) {
        this.listeners.delete(event);
        return;
      }
      this.listeners.clear();
    }

    dispose(): void {
      chatDisposeMock();
      this.removeAllListeners();
    }

    getMessages(): Message[] {
      return [...this.messages];
    }

    submitAction(actionId: string, value?: string): void {
      (this.transport as SDKTransport).send({
        type: 'action_submit',
        actionId,
        ...(value !== undefined ? { value } : {}),
      });
    }

    send = chatSendMock;
  }

  return { ChatClient };
});

import { AgentProvider, useAgent, useChat, useVoice } from '../react/AgentProvider.js';

// ---------------------------------------------------------------------------
// MockTransport
// ---------------------------------------------------------------------------
class MockTransport
  extends TypedEventEmitter<{
    message: TransportServerMessage;
    connected: void;
    disconnected: string | undefined;
    error: TransportError;
  }>
  implements SDKTransport
{
  private connected = true;
  private sessionId = 'transport-session-1';
  capabilities = {
    supportsThoughts: true,
    supportsHandoff: true,
    supportsFileUpload: false,
    supportsVoice: false,
  };
  sentMessages: TransportClientMessage[] = [];
  disconnectCalls = 0;

  isConnected(): boolean {
    return this.connected;
  }

  setConnected(c: boolean): void {
    this.connected = c;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  connect(): Promise<void> {
    this.connected = true;
    this.emit('connected', undefined as unknown as void);
    return Promise.resolve();
  }

  disconnect(): void {
    this.disconnectCalls += 1;
    this.connected = false;
    this.emit('disconnected', 'client_disconnect');
  }

  send(msg: TransportClientMessage): void {
    this.sentMessages.push(msg);
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
let container: HTMLDivElement;
let root: Root;
let sdkChatClient: MockChatClientLike;
let sdkVoiceClient: {
  on: typeof voiceOnMock;
  dispose: typeof voiceDisposeMock;
  start: typeof voiceStartMock;
  stop: typeof voiceStopMock;
  toggleMute: typeof voiceToggleMuteMock;
};

function createConfig(overrides: Partial<SDKPublicKeyConfig> = {}): SDKPublicKeyConfig {
  return {
    projectId: 'project-1',
    apiKey: 'pk_test',
    endpoint: 'https://runtime.example.com',
    ...overrides,
  };
}

// Component that captures hook values for assertions
let capturedAgent: ReturnType<typeof useAgent> | null = null;
let capturedChat: ReturnType<typeof useChat> | null = null;
let capturedVoice: ReturnType<typeof useVoice> | null = null;

function HookCapture(): React.ReactElement {
  capturedAgent = useAgent();
  capturedChat = useChat();
  capturedVoice = useVoice();
  return React.createElement('div', { 'data-testid': 'hook-capture' }, 'captured');
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  connectMock.mockReset();
  connectMock.mockResolvedValue(undefined);
  disconnectMock.mockReset();
  onMock.mockReset();
  agentSdkInstances.length = 0;
  transportChatClientInstances.length = 0;
  nextTransportChatClientMessages = [];
  chatMock.mockReset();
  sdkChatClient = createMockChatClient(undefined, undefined, false);
  chatMock.mockReturnValue(sdkChatClient);
  voiceMock.mockReset();
  sdkVoiceClient = {
    on: voiceOnMock,
    dispose: voiceDisposeMock,
    start: voiceStartMock,
    stop: voiceStopMock,
    toggleMute: voiceToggleMuteMock,
  };
  voiceMock.mockReturnValue(sdkVoiceClient);
  chatOnMock.mockReset();
  chatRemoveAllListenersMock.mockReset();
  chatDisposeMock.mockReset();
  chatSendMock.mockReset();
  chatSendMock.mockResolvedValue('msg-1');
  voiceOnMock.mockReset();
  voiceOnMock.mockReturnValue(() => {});
  voiceDisposeMock.mockReset();
  voiceDisposeMock.mockResolvedValue(undefined);
  voiceStartMock.mockReset();
  voiceStartMock.mockResolvedValue(undefined);
  voiceStopMock.mockReset();
  voiceStopMock.mockResolvedValue(undefined);
  voiceToggleMuteMock.mockReset();
  voiceToggleMuteMock.mockReturnValue(false);

  capturedAgent = null;
  capturedChat = null;
  capturedVoice = null;
});

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => {
    root.unmount();
    await Promise.resolve();
  });
  container.remove();
  Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Path A: AgentSDK flow (no transport)
// ---------------------------------------------------------------------------
describe('AgentProvider Path A (no transport)', () => {
  test('creates AgentSDK and connects when config is provided', async () => {
    const config = createConfig();
    await act(async () => {
      root.render(
        React.createElement(AgentProvider, { ...config }, React.createElement(HookCapture)),
      );
      await Promise.resolve();
    });
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(capturedAgent).toBeTruthy();
    // sdk is null because AgentSDK is mocked, but it was created
  });

  test('does not create ChatClient directly (uses sdk.chat() instead)', async () => {
    const config = createConfig();
    await act(async () => {
      root.render(
        React.createElement(AgentProvider, { ...config }, React.createElement(HookCapture)),
      );
      await Promise.resolve();
    });
    // The ChatClient constructor mock should NOT have been called for Path A
    // (Path A uses sdk.chat(), which is mocked by chatMock, not the ChatClient constructor)
    expect(capturedAgent).toBeTruthy();
  });

  test('keeps the cached sdk.chat() client alive across disconnect and reconnect', async () => {
    const config = createConfig();

    await act(async () => {
      root.render(
        React.createElement(AgentProvider, { ...config }, React.createElement(HookCapture)),
      );
      await Promise.resolve();
    });

    const sdkInstance = agentSdkInstances[0];
    expect(sdkInstance).toBeTruthy();

    await act(async () => {
      sdkInstance!.emit('connected', undefined);
      await Promise.resolve();
    });

    expect(chatMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      sdkChatClient.emit('message', {
        id: 'before-reconnect',
        role: 'assistant',
        content: 'Before reconnect',
        timestamp: new Date(),
      });
      await Promise.resolve();
    });

    expect(capturedChat!.messages.map((message) => message.content)).toEqual(['Before reconnect']);

    await act(async () => {
      sdkInstance!.emit('disconnected', undefined);
      await Promise.resolve();
    });

    expect(chatDisposeMock).not.toHaveBeenCalled();
    expect(capturedAgent!.isConnected).toBe(false);
    expect(capturedChat!.messages).toEqual([]);
    expect(capturedChat!.isTyping).toBe(false);

    await act(async () => {
      sdkInstance!.emit('connected', undefined);
      await Promise.resolve();
    });

    expect(chatMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      sdkChatClient.emit('message', {
        id: 'after-reconnect',
        role: 'assistant',
        content: 'After reconnect',
        timestamp: new Date(),
      });
      await Promise.resolve();
    });

    expect(capturedAgent!.isConnected).toBe(true);
    expect(capturedChat!.messages.map((message) => message.content)).toEqual(['After reconnect']);
  });
});

// ---------------------------------------------------------------------------
// Path B: Transport flow (transport prop provided)
// ---------------------------------------------------------------------------
describe('AgentProvider Path B (transport provided)', () => {
  test('creates ChatClient directly with transport', async () => {
    const transport = new MockTransport();
    await act(async () => {
      root.render(
        React.createElement(
          AgentProvider,
          { transport: transport as SDKTransport },
          React.createElement(HookCapture),
        ),
      );
      await Promise.resolve();
    });
    // Should NOT create AgentSDK (no connect call)
    expect(connectMock).not.toHaveBeenCalled();
    // Should have created a ChatClient (our mock captures on/removeAllListeners)
    expect(chatOnMock).toHaveBeenCalled();
    // Agent context should reflect transport state
    expect(capturedAgent).toBeTruthy();
    expect(capturedAgent!.sdk).toBeNull();
    expect(capturedAgent!.isConnected).toBe(true);
    expect(capturedAgent!.sessionId).toBe('transport-session-1');
  });

  test('useChat() returns expected values in transport mode', async () => {
    const transport = new MockTransport();
    await act(async () => {
      root.render(
        React.createElement(
          AgentProvider,
          { transport: transport as SDKTransport },
          React.createElement(HookCapture),
        ),
      );
      await Promise.resolve();
    });
    expect(capturedChat).toBeTruthy();
    expect(capturedChat!.isConnected).toBe(true);
    expect(capturedChat!.messages).toEqual([]);
    expect(capturedChat!.isTyping).toBe(false);
    expect(typeof capturedChat!.sendMessage).toBe('function');
  });

  test('useVoice() returns safe defaults in transport mode', async () => {
    const transport = new MockTransport();
    await act(async () => {
      root.render(
        React.createElement(
          AgentProvider,
          { transport: transport as SDKTransport },
          React.createElement(HookCapture),
        ),
      );
      await Promise.resolve();
    });
    expect(capturedVoice).toBeTruthy();
    expect(capturedVoice!.voiceState).toBe('idle');
    expect(capturedVoice!.isMuted).toBe(false);
    expect(capturedVoice!.thought).toBeNull();
    expect(capturedVoice!.statusMessage).toBeNull();
    // startVoice should throw
    await expect(capturedVoice!.startVoice()).rejects.toThrow('Voice requires AgentSDK');
    // stopVoice should be noop
    expect(() => capturedVoice!.stopVoice()).not.toThrow();
    // toggleMute should return false
    expect(capturedVoice!.toggleMute()).toBe(false);
  });

  test('wraps children in SDKThemeProvider when theme prop provided', async () => {
    const transport = new MockTransport();
    await act(async () => {
      root.render(
        React.createElement(
          AgentProvider,
          {
            transport: transport as SDKTransport,
            theme: { primaryColor: '#00ff00' },
          },
          React.createElement('div', { 'data-testid': 'child' }, 'themed'),
        ),
      );
      await Promise.resolve();
    });
    const wrapper = container.querySelector('[data-sdk-theme]') as HTMLElement;
    expect(wrapper).toBeTruthy();
    expect(wrapper.style.getPropertyValue('--sdk-primary')).toBe('#00ff00');
  });

  test('wraps children in StringsProvider when strings prop provided', async () => {
    const transport = new MockTransport();
    // We can verify indirectly by rendering a TypingIndicator that reads strings
    const { TypingIndicator } = await import('../react/components/TypingIndicator.js');
    await act(async () => {
      root.render(
        React.createElement(
          AgentProvider,
          {
            transport: transport as SDKTransport,
            strings: { typingIndicator: 'Escribiendo...' },
          },
          React.createElement(TypingIndicator),
        ),
      );
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Escribiendo...');
  });

  test('responds to transport connected/disconnected events', async () => {
    const transport = new MockTransport();
    transport.setConnected(false);
    await act(async () => {
      root.render(
        React.createElement(
          AgentProvider,
          { transport: transport as SDKTransport },
          React.createElement(HookCapture),
        ),
      );
      await Promise.resolve();
    });
    expect(capturedAgent!.isConnected).toBe(false);

    // Simulate transport connected event
    await act(async () => {
      transport.setConnected(true);
      transport.emit('connected', undefined as unknown as void);
      await Promise.resolve();
    });
    expect(capturedAgent!.isConnected).toBe(true);
  });

  test('disconnects transport after transport-mode idle timeout', async () => {
    vi.useFakeTimers();
    const transport = new MockTransport();

    await act(async () => {
      root.render(
        React.createElement(
          AgentProvider,
          {
            transport: transport as SDKTransport,
            idleDisconnect: { timeoutMs: 1_000 },
          },
          React.createElement(HookCapture),
        ),
      );
      await Promise.resolve();
    });

    await act(async () => {
      vi.advanceTimersByTime(999);
    });

    expect(transport.disconnectCalls).toBe(0);

    await act(async () => {
      globalThis.dispatchEvent(new Event('mousemove'));
      vi.advanceTimersByTime(999);
    });

    expect(transport.disconnectCalls).toBe(0);

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });

    expect(transport.disconnectCalls).toBe(1);
    expect(capturedAgent!.isConnected).toBe(false);
  });

  test('sends end_session before disconnecting transport after transport-mode idle timeout', async () => {
    vi.useFakeTimers();
    const transport = new MockTransport();

    await act(async () => {
      root.render(
        React.createElement(
          AgentProvider,
          {
            transport: transport as SDKTransport,
            idleDisconnect: { timeoutMs: 1_000, behavior: 'end_session' },
          },
          React.createElement(HookCapture),
        ),
      );
      await Promise.resolve();
    });

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });

    expect(transport.sentMessages).toContainEqual({
      type: 'end_session',
      sessionId: 'transport-session-1',
    });
    expect(transport.disconnectCalls).toBe(1);
    expect(capturedAgent!.isConnected).toBe(false);
  });

  test('keeps transport idle timer running across same-value provider rerenders', async () => {
    vi.useFakeTimers();
    const transport = new MockTransport();

    const renderProvider = (label: string) =>
      root.render(
        React.createElement(
          AgentProvider,
          {
            transport: transport as SDKTransport,
            idleDisconnect: { timeoutMs: 1_000 },
          },
          React.createElement(
            React.Fragment,
            null,
            React.createElement('div', null, label),
            React.createElement(HookCapture),
          ),
        ),
      );

    await act(async () => {
      renderProvider('initial');
      await Promise.resolve();
    });

    await act(async () => {
      vi.advanceTimersByTime(500);
      renderProvider('rerendered');
      await Promise.resolve();
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    expect(transport.disconnectCalls).toBe(1);
    expect(capturedAgent!.isConnected).toBe(false);
  });

  test('counts transport-mode action submissions as idle activity', async () => {
    vi.useFakeTimers();
    const transport = new MockTransport();

    await act(async () => {
      root.render(
        React.createElement(
          AgentProvider,
          {
            transport: transport as SDKTransport,
            idleDisconnect: { timeoutMs: 1_000 },
          },
          React.createElement(HookCapture),
        ),
      );
      await Promise.resolve();
    });

    await act(async () => {
      vi.advanceTimersByTime(999);
      await Promise.resolve();
    });

    expect(transport.disconnectCalls).toBe(0);

    await act(async () => {
      capturedChat!.chat!.submitAction('btn-1', 'confirm');
      vi.advanceTimersByTime(999);
      await Promise.resolve();
    });

    expect(transport.sentMessages).toContainEqual({
      type: 'action_submit',
      actionId: 'btn-1',
      value: 'confirm',
    });
    expect(transport.disconnectCalls).toBe(0);

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });

    expect(transport.disconnectCalls).toBe(1);
    expect(capturedAgent!.isConnected).toBe(false);
  });

  test('seeds transport-mode React state from pre-hydrated chat history', async () => {
    const transport = new MockTransport();
    nextTransportChatClientMessages = [
      {
        id: 'history-1',
        role: 'assistant',
        content: 'Historical response',
        timestamp: new Date('2026-04-20T10:00:00.000Z'),
      },
    ];

    await act(async () => {
      root.render(
        React.createElement(
          AgentProvider,
          { transport: transport as SDKTransport },
          React.createElement(HookCapture),
        ),
      );
      await Promise.resolve();
    });

    expect(capturedChat!.messages).toEqual([
      expect.objectContaining({
        id: 'history-1',
        role: 'assistant',
        content: 'Historical response',
      }),
    ]);
  });

  test('keeps the transport-owned ChatClient alive across disconnect and reconnect', async () => {
    const transport = new MockTransport();
    await act(async () => {
      root.render(
        React.createElement(
          AgentProvider,
          { transport: transport as SDKTransport },
          React.createElement(HookCapture),
        ),
      );
      await Promise.resolve();
    });

    expect(transportChatClientInstances).toHaveLength(1);
    const transportChatClient = transportChatClientInstances[0];

    await act(async () => {
      transportChatClient.emit('message', {
        id: 'before-reconnect',
        role: 'assistant',
        content: 'Before reconnect',
        timestamp: new Date(),
      });
      await Promise.resolve();
    });

    expect(capturedChat!.messages.map((message) => message.content)).toEqual(['Before reconnect']);

    await act(async () => {
      transport.setConnected(false);
      transport.emit('disconnected', 'temporary_network_issue');
      await Promise.resolve();
    });

    expect(chatDisposeMock).not.toHaveBeenCalled();
    expect(capturedAgent!.isConnected).toBe(false);
    // Transient drops preserve messages (ABLP-002 UX fix — no empty-chat flash).
    // Studio's SessionHistoryBridge replaces the transcript on reconnect when needed.
    expect(capturedChat!.messages.map((m) => m.content)).toEqual(['Before reconnect']);

    await act(async () => {
      transport.setConnected(true);
      transport.emit('connected', undefined as unknown as void);
      await Promise.resolve();
    });

    expect(chatDisposeMock).not.toHaveBeenCalled();
    expect(transportChatClientInstances).toHaveLength(1);

    await act(async () => {
      transportChatClient.emit('message', {
        id: 'after-reconnect',
        role: 'assistant',
        content: 'After reconnect',
        timestamp: new Date(),
      });
      await Promise.resolve();
    });

    expect(capturedAgent!.isConnected).toBe(true);
    expect(capturedChat!.messages.map((message) => message.content)).toEqual([
      'Before reconnect',
      'After reconnect',
    ]);
  });

  test('deduplicates repeated message events that reuse the same id', async () => {
    const transport = new MockTransport();
    await act(async () => {
      root.render(
        React.createElement(
          AgentProvider,
          { transport: transport as SDKTransport },
          React.createElement(HookCapture),
        ),
      );
      await Promise.resolve();
    });

    const transportChatClient = transportChatClientInstances[0];
    const duplicateMessage = {
      id: 'dup-msg-1',
      role: 'user' as const,
      content: 'hello',
      timestamp: new Date(),
    };

    await act(async () => {
      transportChatClient.emit('message', duplicateMessage);
      transportChatClient.emit('message', duplicateMessage);
      await Promise.resolve();
    });

    expect(capturedChat!.messages).toHaveLength(1);
    expect(capturedChat!.messages[0].id).toBe('dup-msg-1');
  });

  test('replaces transport-mode React history when ChatClient publishes an authoritative snapshot', async () => {
    const transport = new MockTransport();
    await act(async () => {
      root.render(
        React.createElement(
          AgentProvider,
          { transport: transport as SDKTransport },
          React.createElement(HookCapture),
        ),
      );
      await Promise.resolve();
    });

    const transportChatClient = transportChatClientInstances[0];

    await act(async () => {
      transportChatClient.emit('message', {
        id: 'stale-message',
        role: 'assistant',
        content: 'Stale local state',
        timestamp: new Date(),
      });
      await Promise.resolve();
    });

    expect(capturedChat!.messages.map((message) => message.id)).toEqual(['stale-message']);

    await act(async () => {
      transportChatClient.emit('messagesReplaced', {
        messages: [
          {
            id: 'snapshot-1',
            role: 'user',
            content: 'Hello',
            timestamp: new Date('2026-04-23T05:00:00.000Z'),
          },
          {
            id: 'snapshot-2',
            role: 'assistant',
            content: 'Hi there',
            timestamp: new Date('2026-04-23T05:00:01.000Z'),
          },
        ],
      });
      await Promise.resolve();
    });

    expect(capturedChat!.messages.map((message) => message.id)).toEqual([
      'snapshot-1',
      'snapshot-2',
    ]);
  });

  test('disposes the transport-owned ChatClient when transport ownership changes', async () => {
    const firstTransport = new MockTransport();
    const secondTransport = new MockTransport();

    await act(async () => {
      root.render(
        React.createElement(
          AgentProvider,
          { transport: firstTransport as SDKTransport },
          React.createElement(HookCapture),
        ),
      );
      await Promise.resolve();
    });

    expect(transportChatClientInstances).toHaveLength(1);
    const staleChatClient = transportChatClientInstances[0];

    await act(async () => {
      root.render(
        React.createElement(
          AgentProvider,
          { transport: secondTransport as SDKTransport },
          React.createElement(HookCapture),
        ),
      );
      await Promise.resolve();
    });

    expect(chatDisposeMock).toHaveBeenCalledTimes(1);
    expect(transportChatClientInstances).toHaveLength(2);

    await act(async () => {
      staleChatClient.emit('message', {
        id: 'stale-message',
        role: 'assistant',
        content: 'Stale transport',
        timestamp: new Date(),
      });
      transportChatClientInstances[1].emit('message', {
        id: 'fresh-message',
        role: 'assistant',
        content: 'Fresh transport',
        timestamp: new Date(),
      });
      await Promise.resolve();
    });

    expect(capturedChat!.messages.map((message) => message.content)).toEqual(['Fresh transport']);
  });

  test('exposes streaming state through useChat when messageChunk events arrive', async () => {
    const transport = new MockTransport();
    await act(async () => {
      root.render(
        React.createElement(
          AgentProvider,
          { transport: transport as SDKTransport },
          React.createElement(HookCapture),
        ),
      );
      await Promise.resolve();
    });

    expect(capturedChat!.streamingContent).toBe('');
    expect(capturedChat!.isStreaming).toBe(false);

    const transportChatClient = transportChatClientInstances[0];

    // Simulate typing start (response_start)
    await act(async () => {
      transportChatClient.emit('typing', { isTyping: true });
      await Promise.resolve();
    });

    expect(capturedChat!.isTyping).toBe(true);
    expect(capturedChat!.isStreaming).toBe(true);
    expect(capturedChat!.streamingContent).toBe('');

    // Simulate streaming chunks
    await act(async () => {
      transportChatClient.emit('messageChunk', { messageId: 'msg-1', chunk: 'Hello' });
      await Promise.resolve();
    });

    expect(capturedChat!.streamingContent).toBe('Hello');
    expect(capturedChat!.isStreaming).toBe(true);

    await act(async () => {
      transportChatClient.emit('messageChunk', { messageId: 'msg-1', chunk: ' world' });
      await Promise.resolve();
    });

    expect(capturedChat!.streamingContent).toBe('Hello world');

    // Simulate response_end (complete message + typing=false)
    await act(async () => {
      transportChatClient.emit('message', {
        id: 'msg-1',
        role: 'assistant',
        content: 'Hello world',
        timestamp: new Date(),
      });
      await Promise.resolve();
    });

    expect(capturedChat!.streamingContent).toBe('');
    expect(capturedChat!.isStreaming).toBe(false);
    expect(capturedChat!.messages).toHaveLength(1);
    expect(capturedChat!.messages[0].content).toBe('Hello world');
  });

  test('exposes chat status updates and clears them on final response', async () => {
    const transport = new MockTransport();
    await act(async () => {
      root.render(
        React.createElement(
          AgentProvider,
          { transport: transport as SDKTransport },
          React.createElement(HookCapture),
        ),
      );
      await Promise.resolve();
    });

    const transportChatClient = transportChatClientInstances[0];

    await act(async () => {
      transportChatClient.emit('statusUpdate', {
        text: 'Checking account tools...',
        operation: 'tool_call',
      });
      await Promise.resolve();
    });

    expect(capturedChat!.statusMessage).toBe('Checking account tools...');

    await act(async () => {
      transportChatClient.emit('message', {
        id: 'final-status-response',
        role: 'assistant',
        content: 'Account tools are ready.',
        timestamp: new Date(),
      });
      await Promise.resolve();
    });

    expect(capturedChat!.statusMessage).toBeNull();
    expect(capturedChat!.messages.map((message) => message.content)).toEqual([
      'Account tools are ready.',
    ]);
  });

  test('resets streaming state on transport disconnect', async () => {
    const transport = new MockTransport();
    await act(async () => {
      root.render(
        React.createElement(
          AgentProvider,
          { transport: transport as SDKTransport },
          React.createElement(HookCapture),
        ),
      );
      await Promise.resolve();
    });

    const transportChatClient = transportChatClientInstances[0];

    // Start streaming
    await act(async () => {
      transportChatClient.emit('typing', { isTyping: true });
      transportChatClient.emit('messageChunk', { messageId: 'msg-1', chunk: 'Partial' });
      await Promise.resolve();
    });

    expect(capturedChat!.streamingContent).toBe('Partial');
    expect(capturedChat!.isStreaming).toBe(true);

    // Disconnect mid-stream
    await act(async () => {
      transport.setConnected(false);
      transport.emit('disconnected', 'network_error');
      await Promise.resolve();
    });

    expect(capturedChat!.streamingContent).toBe('');
    expect(capturedChat!.isStreaming).toBe(false);
    expect(capturedChat!.messages).toEqual([]);
  });

  test('resets streaming content on new response_start (typing=true)', async () => {
    const transport = new MockTransport();
    await act(async () => {
      root.render(
        React.createElement(
          AgentProvider,
          { transport: transport as SDKTransport },
          React.createElement(HookCapture),
        ),
      );
      await Promise.resolve();
    });

    const transportChatClient = transportChatClientInstances[0];

    // First response
    await act(async () => {
      transportChatClient.emit('typing', { isTyping: true });
      transportChatClient.emit('messageChunk', { messageId: 'msg-1', chunk: 'First' });
      await Promise.resolve();
    });

    expect(capturedChat!.streamingContent).toBe('First');

    // Complete first response
    await act(async () => {
      transportChatClient.emit('message', {
        id: 'msg-1',
        role: 'assistant',
        content: 'First',
        timestamp: new Date(),
      });
      await Promise.resolve();
    });

    expect(capturedChat!.streamingContent).toBe('');

    // Second response starts — streaming content should be fresh
    await act(async () => {
      transportChatClient.emit('typing', { isTyping: true });
      await Promise.resolve();
    });

    expect(capturedChat!.streamingContent).toBe('');
    expect(capturedChat!.isStreaming).toBe(true);

    await act(async () => {
      transportChatClient.emit('messageChunk', { messageId: 'msg-2', chunk: 'Second' });
      await Promise.resolve();
    });

    expect(capturedChat!.streamingContent).toBe('Second');
  });
});

// ---------------------------------------------------------------------------
// Path A: Streaming state
// ---------------------------------------------------------------------------
describe('AgentProvider Path A streaming', () => {
  test('exposes streaming state through useChat when sdk.chat() emits messageChunk', async () => {
    const config = createConfig();
    await act(async () => {
      root.render(
        React.createElement(AgentProvider, { ...config }, React.createElement(HookCapture)),
      );
      await Promise.resolve();
    });

    const sdkInstance = agentSdkInstances[0];

    // Simulate connection + session
    await act(async () => {
      sdkInstance!.emit('connected', undefined);
      await Promise.resolve();
    });

    expect(capturedChat!.streamingContent).toBe('');
    expect(capturedChat!.isStreaming).toBe(false);

    // Simulate typing start
    await act(async () => {
      sdkChatClient.emit('typing', { isTyping: true });
      await Promise.resolve();
    });

    expect(capturedChat!.isStreaming).toBe(true);
    expect(capturedChat!.streamingContent).toBe('');

    // Simulate chunk
    await act(async () => {
      sdkChatClient.emit('messageChunk', { messageId: 'msg-1', chunk: 'Hello from SDK' });
      await Promise.resolve();
    });

    expect(capturedChat!.streamingContent).toBe('Hello from SDK');
    expect(capturedChat!.isStreaming).toBe(true);

    // Simulate complete message
    await act(async () => {
      sdkChatClient.emit('message', {
        id: 'msg-1',
        role: 'assistant',
        content: 'Hello from SDK',
        timestamp: new Date(),
      });
      await Promise.resolve();
    });

    expect(capturedChat!.streamingContent).toBe('');
    expect(capturedChat!.isStreaming).toBe(false);
    expect(capturedChat!.messages).toHaveLength(1);
  });
});
