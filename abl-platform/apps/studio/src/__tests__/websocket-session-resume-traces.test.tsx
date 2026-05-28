/**
 * @vitest-environment happy-dom
 */

import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketProvider, useWebSocketContext } from '../contexts/WebSocketContext';

const RESUME_ASSISTANT_METADATA = {
  isLlmGenerated: true,
  responseProvenance: {
    schemaVersion: 1,
    kind: 'llm',
    disclaimerRequired: true,
    usedLlmInternally: true,
  },
} as const;

const {
  createInitialAgentStateMock,
  authStoreState,
  useAuthStoreMock,
  logoutSignalEvent,
  signalLogoutMock,
  sessionStoreState,
  useSessionStoreMock,
  observatoryStoreState,
  useObservatoryStoreMock,
  uiStoreState,
  navigationStoreState,
  batchConsentStoreState,
  startProjectAgentSessionMock,
  buildWebDebugWSProtocolsMock,
  replayTraceEventsIntoObservatoryMock,
  ingestLiveTraceEventMock,
  formatTraceEventLogMock,
  hydrateSessionStoreFromDetailMock,
  apiFetchMock,
} = vi.hoisted(() => {
  function createHookStore<T extends object>(state: T) {
    const useStore = ((selector?: (snapshot: T) => unknown) =>
      selector ? selector(state) : state) as ((selector?: (snapshot: T) => unknown) => unknown) & {
      getState: () => T;
      setState: (partial: Partial<T>) => void;
    };

    useStore.getState = () => state;
    useStore.setState = (partial: Partial<T>) => {
      Object.assign(state, partial);
    };

    return useStore;
  }

  const authStoreState = {
    accessToken: 'test-token',
    tenantId: 'tenant-1',
    user: null,
    isSuperAdmin: false,
    isAuthenticated: true,
    isLoading: false,
    setAuth: vi.fn(),
    setTenantId: vi.fn(),
    setTokens: vi.fn(),
    setUser: vi.fn(),
    clearAuth: vi.fn(),
    setLoading: vi.fn(),
  };

  const logoutSignalEvent = 'studio-auth:logout';
  const signalLogoutMock = vi.fn();

  const sessionStoreState = {
    sessionId: 'session-1' as string | null,
    resumeHandle: {
      sessionId: 'session-1' as string | null,
      projectId: 'project-1' as string | null,
      kind: 'web_debug' as 'web_debug' | null,
      lastSeenTraceEventId: null as string | null,
    },
    agent: null as Record<string, unknown> | null,
    messages: [] as Array<Record<string, unknown>>,
    messageSnapshotVersion: 0,
    state: null as Record<string, unknown> | null,
    lastAction: null as Record<string, unknown> | null,
    isLoading: false,
    isStreaming: false,
    streamingMessageId: null as string | null,
    streamingContent: '',
    error: null as string | null,
    statusMessage: null as string | null,
    setSession: vi.fn(),
    rememberResumeHandle: vi.fn((updates: Record<string, unknown>) => {
      sessionStoreState.resumeHandle = {
        ...sessionStoreState.resumeHandle,
        ...updates,
      };
    }),
    clearResumeHandle: vi.fn(() => {
      sessionStoreState.resumeHandle = {
        sessionId: null,
        projectId: null,
        kind: null,
        lastSeenTraceEventId: null,
      };
    }),
    setState: vi.fn(),
    updateState: vi.fn(),
    setLastAction: vi.fn(),
    startStreaming: vi.fn(),
    appendStreamChunk: vi.fn(),
    endStreaming: vi.fn(),
    setError: vi.fn(),
    setStatusMessage: vi.fn(),
    addMessage: vi.fn((message: Record<string, unknown>) => {
      sessionStoreState.messages.push(message);
    }),
    clearMessages: vi.fn(() => {
      sessionStoreState.messages = [];
    }),
    replaceMessages: vi.fn((messages: Array<Record<string, unknown>>) => {
      sessionStoreState.messages = messages;
      sessionStoreState.messageSnapshotVersion += 1;
    }),
    setLoading: vi.fn(),
    clearSession: vi.fn(),
    restoreSession: vi.fn(),
    updateMessage: vi.fn(),
  };

  const observatoryStoreState = {
    events: [] as Array<Record<string, unknown>>,
    setDebugState: vi.fn(),
    clearEvents: vi.fn(),
    clearFlow: vi.fn(),
    clearLogs: vi.fn(),
    resetMetrics: vi.fn(),
    setStaticGraph: vi.fn(),
    setAppStaticGraph: vi.fn(),
    setGraphViewMode: vi.fn(),
    addEvent: vi.fn(),
    startClientTimer: vi.fn(),
    endClientTimer: vi.fn(),
    addLog: vi.fn(),
  };

  const uiStoreState = {
    setSessionDetailMode: vi.fn(),
  };

  const navigationStoreState = {
    projectId: 'project-1',
    subPage: null as string | null,
  };

  const batchConsentStoreState = {
    reset: vi.fn(),
    markPending: vi.fn(),
    clearPending: vi.fn(),
    markSatisfied: vi.fn(),
    markAllSatisfied: vi.fn(),
  };

  const ingestLiveTraceEventMock = vi.fn(() => ({
    accepted: true,
    traceEvent: { id: 'trace-1', type: 'info', timestamp: new Date().toISOString() },
    eventPayload: {},
  }));
  const formatTraceEventLogMock = vi.fn(
    (
      _type: string,
      _data: Record<string, unknown>,
    ): { level: 'info' | 'warn' | 'error'; message: string } | null => null,
  );

  return {
    createInitialAgentStateMock: vi.fn(() => ({
      context: {},
      conversationPhase: 'start',
      gatherProgress: {},
      constraintResults: {},
      lastToolResults: {},
      memory: {
        session: {},
        persistentCache: {},
        pendingRemembers: [],
      },
    })),
    authStoreState,
    useAuthStoreMock: createHookStore(authStoreState),
    logoutSignalEvent,
    signalLogoutMock,
    sessionStoreState,
    useSessionStoreMock: createHookStore(sessionStoreState),
    observatoryStoreState,
    useObservatoryStoreMock: createHookStore(observatoryStoreState),
    uiStoreState,
    navigationStoreState,
    batchConsentStoreState,
    startProjectAgentSessionMock: vi.fn().mockResolvedValue(false),
    buildWebDebugWSProtocolsMock: vi.fn((token: string) => ['abl-debug', token]),
    replayTraceEventsIntoObservatoryMock: vi.fn(),
    ingestLiveTraceEventMock,
    formatTraceEventLogMock,
    hydrateSessionStoreFromDetailMock: vi.fn(),
    apiFetchMock: vi.fn(),
  };
});

vi.mock('@/store/auth-store', () => ({
  LOGOUT_SIGNAL_EVENT: logoutSignalEvent,
  signalLogout: signalLogoutMock,
  useAuthStore: useAuthStoreMock,
}));

vi.mock('../store/auth-store', () => ({
  LOGOUT_SIGNAL_EVENT: logoutSignalEvent,
  signalLogout: signalLogoutMock,
  useAuthStore: useAuthStoreMock,
}));

vi.mock('../store/session-store', () => ({
  createInitialAgentState: createInitialAgentStateMock,
  useSessionStore: useSessionStoreMock,
}));

vi.mock('../store/observatory-store', () => ({
  useObservatoryStore: useObservatoryStoreMock,
}));

vi.mock('../store/ui-store', () => ({
  useUIStore: {
    getState: () => uiStoreState,
  },
}));

vi.mock('../store/navigation-store', () => ({
  useNavigationStore: {
    getState: () => navigationStoreState,
  },
}));

vi.mock('../lib/api-client', () => ({
  apiFetch: apiFetchMock,
}));

vi.mock('../store/batch-consent-store', () => ({
  useBatchConsentStore: {
    getState: () => batchConsentStoreState,
  },
}));

vi.mock('../hooks/useProjectAgentSessionLauncher', () => ({
  useProjectAgentSessionLauncher: () => ({
    startProjectAgentSession: startProjectAgentSessionMock,
  }),
}));

vi.mock('../utils/graph-generator', () => ({
  generateStaticGraph: vi.fn(() => null),
}));

vi.mock('../utils/replay-trace-events', () => ({
  formatTraceEventLog: formatTraceEventLogMock,
  hydrateSessionStoreFromDetail: hydrateSessionStoreFromDetailMock,
  replayTraceEventsIntoObservatory: replayTraceEventsIntoObservatoryMock,
}));

vi.mock('../utils/live-trace-event-ingestion', () => ({
  ingestLiveTraceEvent: ingestLiveTraceEventMock,
}));

vi.mock('../utils/session-health-events', () => ({
  buildSessionHealthEvents: vi.fn(() => []),
}));

vi.mock('../lib/runtime-chat-notice', () => ({
  buildRuntimeChatNotice: vi.fn(() => null),
  formatQueuedRuntimeNotice: vi.fn(() => null),
}));

vi.mock('../utils/derive-ws-url', () => ({
  deriveDefaultWsUrl: () => 'ws://runtime.test/ws',
}));

vi.mock('@agent-platform/shared/websocket-auth', () => ({
  buildWebDebugWSProtocols: buildWebDebugWSProtocolsMock,
}));

vi.mock('../lib/app-graph-loader', () => ({
  fetchAppStaticGraph: vi.fn().mockResolvedValue(null),
  fetchAvailableAppsList: vi.fn().mockResolvedValue([]),
}));

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: MockWebSocket[] = [];

  readonly url: string;
  readonly protocols: string | string[];
  readyState = MockWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
  });

  constructor(url: string, protocols: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    MockWebSocket.instances.push(this);
  }
}

function makeDeveloperSessionResponse({
  sessionId = 'session-1',
  projectId = 'project-1',
  attachmentStatus = 'detached',
}: {
  sessionId?: string;
  projectId?: string;
  attachmentStatus?: 'attached' | 'detached';
} = {}): Response {
  return new Response(
    JSON.stringify({
      success: true,
      data: {
        clientAttachment: {
          status: attachmentStatus,
        },
        executionSession: {
          sessionId,
          projectId,
          channel: 'web_debug',
        },
        resume: {
          canResume: true,
        },
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function makeDeveloperSessionNotFoundResponse(): Response {
  return new Response(
    JSON.stringify({
      success: false,
      error: {
        code: 'SESSION_NOT_FOUND',
        message: 'Session not found or no longer resumable',
      },
    }),
    { status: 404, headers: { 'Content-Type': 'application/json' } },
  );
}

function resetMockState(): void {
  const resetMockFunctions = (record: Record<string, unknown>) => {
    for (const value of Object.values(record)) {
      if (vi.isMockFunction(value)) {
        value.mockReset();
      }
    }
  };

  Object.assign(authStoreState, {
    accessToken: 'test-token',
    tenantId: 'tenant-1',
    user: null,
    isSuperAdmin: false,
    isAuthenticated: true,
    isLoading: false,
  });
  Object.assign(sessionStoreState, {
    sessionId: 'session-1',
    resumeHandle: {
      sessionId: 'session-1',
      projectId: 'project-1',
      kind: 'web_debug',
      lastSeenTraceEventId: null,
    },
    agent: null,
    messages: [],
    messageSnapshotVersion: 0,
    state: null,
    lastAction: null,
    isLoading: false,
    isStreaming: false,
    streamingMessageId: null,
    streamingContent: '',
    error: null,
    statusMessage: null,
  });
  Object.assign(observatoryStoreState, {
    events: [],
  });

  resetMockFunctions(authStoreState);
  resetMockFunctions(sessionStoreState);
  resetMockFunctions(observatoryStoreState);
  resetMockFunctions(uiStoreState);
  resetMockFunctions(batchConsentStoreState);
  startProjectAgentSessionMock.mockClear();
  buildWebDebugWSProtocolsMock.mockClear();
  replayTraceEventsIntoObservatoryMock.mockClear();
  ingestLiveTraceEventMock.mockReset();
  ingestLiveTraceEventMock.mockReturnValue({
    accepted: true,
    traceEvent: { id: 'trace-1', type: 'info', timestamp: new Date().toISOString() },
    eventPayload: {},
  });
  formatTraceEventLogMock.mockReset();
  formatTraceEventLogMock.mockReturnValue(null);
  hydrateSessionStoreFromDetailMock.mockClear();
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('/api/runtime/sessions/attach?')) {
      const requestBody =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as { sessionId?: string }) : {};
      const sessionId =
        typeof requestBody.sessionId === 'string' && requestBody.sessionId.length > 0
          ? requestBody.sessionId
          : (sessionStoreState.resumeHandle.sessionId ??
            sessionStoreState.sessionId ??
            'session-1');
      return makeDeveloperSessionResponse({
        sessionId,
        projectId: navigationStoreState.projectId ?? 'project-1',
      });
    }

    throw new Error(`Unexpected apiFetch call: ${String(input)}`);
  });
  signalLogoutMock.mockClear();
  MockWebSocket.instances = [];
  sessionStoreState.rememberResumeHandle.mockImplementation((updates: Record<string, unknown>) => {
    sessionStoreState.resumeHandle = {
      ...sessionStoreState.resumeHandle,
      ...updates,
    };
  });
  sessionStoreState.clearResumeHandle.mockImplementation(() => {
    sessionStoreState.resumeHandle = {
      sessionId: null,
      projectId: null,
      kind: null,
      lastSeenTraceEventId: null,
    };
  });
}

function makeExtendedEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-default',
    type: 'llm_call',
    timestamp: new Date('2026-04-22T10:00:00.000Z'),
    traceId: 'trace-1',
    spanId: 'span-1',
    sessionId: 'session-1',
    agentName: 'Booking_Agent',
    data: {},
    ...overrides,
  };
}

function makeTraceEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-default',
    type: 'llm_call',
    timestamp: new Date('2026-04-22T10:00:00.000Z').toISOString(),
    sessionId: 'session-1',
    traceId: 'trace-1',
    spanId: 'span-1',
    agentName: 'Booking_Agent',
    data: {},
    ...overrides,
  };
}

function WebSocketContextHarness({
  onReady,
}: {
  onReady: (context: ReturnType<typeof useWebSocketContext>) => void;
}) {
  const context = useWebSocketContext();
  onReady(context);
  return <div>child</div>;
}

describe('ABLP-396 websocket session resume trace hydration', () => {
  beforeEach(() => {
    resetMockState();
    vi.unstubAllGlobals();
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('includes the last seen trace event id when auto-resuming an active session', async () => {
    render(
      <WebSocketProvider url="ws://runtime.test/ws">
        <div>child</div>
      </WebSocketProvider>,
    );

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    const ws = MockWebSocket.instances[0];

    act(() => {
      ws.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'trace_event',
            sessionId: 'session-1',
            event: makeTraceEvent({ id: 'evt-live' }),
          }),
        }) as MessageEvent<string>,
      );
    });

    act(() => {
      ws.readyState = MockWebSocket.OPEN;
      ws.onopen?.(new Event('open'));
    });

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        '/api/runtime/sessions/attach?projectId=project-1',
        expect.objectContaining({
          method: 'POST',
          cache: 'no-store',
          body: JSON.stringify({
            sessionId: 'session-1',
            channel: 'web_debug',
          }),
        }),
      );
    });

    await waitFor(() => {
      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'resume_session',
          sessionId: 'session-1',
          lastSeenTraceEventId: 'evt-live',
        }),
      );
    });
  });

  it('does not use ClickHouse-only live trace events as resume cursors', async () => {
    render(
      <WebSocketProvider url="ws://runtime.test/ws">
        <div>child</div>
      </WebSocketProvider>,
    );

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    const ws = MockWebSocket.instances[0];

    act(() => {
      ws.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'trace_event',
            sessionId: 'session-1',
            event: makeTraceEvent({
              id: 'evt-channel-only',
              type: 'channel_response_sent',
            }),
          }),
        }) as MessageEvent<string>,
      );
    });

    act(() => {
      ws.readyState = MockWebSocket.OPEN;
      ws.onopen?.(new Event('open'));
    });

    await waitFor(() => {
      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'resume_session',
          sessionId: 'session-1',
        }),
      );
    });

    expect(sessionStoreState.resumeHandle.lastSeenTraceEventId).toBeNull();
    expect(ws.send).not.toHaveBeenCalledWith(
      JSON.stringify({
        type: 'resume_session',
        sessionId: 'session-1',
        lastSeenTraceEventId: 'evt-channel-only',
      }),
    );
  });

  it('clears the resume cursor when hydrated traces are only ClickHouse-backed', async () => {
    let capturedContext: ReturnType<typeof useWebSocketContext> | null = null;
    apiFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          session: {
            id: 'session-2',
            agentName: 'Booking_Agent',
            messages: [],
            traceEvents: [
              null,
              'bad-trace',
              makeTraceEvent({
                id: 'evt-channel-only',
                sessionId: 'session-2',
                type: 'channel.response.sent',
              }),
            ],
            state: { context: {}, conversationPhase: 'start', gatherProgress: {} },
          },
        }),
        { status: 200 },
      ),
    );

    render(
      <WebSocketProvider url="ws://runtime.test/ws">
        <WebSocketContextHarness
          onReady={(context) => {
            capturedContext = context;
          }}
        />
      </WebSocketProvider>,
    );

    await waitFor(() => {
      expect(capturedContext).not.toBeNull();
    });

    await act(async () => {
      await capturedContext?.switchSession('session-2');
    });

    expect(hydrateSessionStoreFromDetailMock).toHaveBeenCalled();
    expect(sessionStoreState.rememberResumeHandle).toHaveBeenCalledWith({
      sessionId: 'session-2',
      projectId: 'project-1',
      kind: 'web_debug',
      lastSeenTraceEventId: null,
    });
    expect(sessionStoreState.rememberResumeHandle).not.toHaveBeenCalledWith(
      expect.objectContaining({
        lastSeenTraceEventId: 'evt-channel-only',
      }),
    );
  });

  it('keeps trace error events in observability without adding a transcript message', async () => {
    ingestLiveTraceEventMock.mockReturnValue({
      accepted: true,
      traceEvent: {
        id: 'evt-trace-error',
        type: 'error',
        timestamp: new Date('2026-04-22T10:00:00.000Z').toISOString(),
      },
      eventPayload: {
        message: 'First tool attempt failed',
      },
    });

    render(
      <WebSocketProvider url="ws://runtime.test/ws">
        <div>child</div>
      </WebSocketProvider>,
    );

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    const ws = MockWebSocket.instances[0];

    act(() => {
      ws.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'trace_event',
            sessionId: 'session-1',
            event: makeTraceEvent({
              id: 'evt-trace-error',
              type: 'error',
              data: {
                message: 'First tool attempt failed',
              },
            }),
          }),
        }) as MessageEvent<string>,
      );
    });

    expect(ingestLiveTraceEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'trace_event',
        sessionId: 'session-1',
      }),
    );
    expect(sessionStoreState.addMessage).not.toHaveBeenCalled();
    expect(sessionStoreState.rememberResumeHandle).toHaveBeenCalledWith(
      expect.objectContaining({
        lastSeenTraceEventId: 'evt-trace-error',
      }),
    );
  });

  it('does not derive logs or transcript messages from duplicate live trace events', async () => {
    ingestLiveTraceEventMock.mockReturnValue({
      accepted: false,
      traceEvent: {
        id: 'evt-duplicate-thought',
        type: 'tool_thought',
        timestamp: new Date('2026-04-22T10:00:00.000Z').toISOString(),
      },
      eventPayload: {
        thought: 'Already rendered thought',
        toolName: 'search',
      },
    });
    formatTraceEventLogMock.mockReturnValue({
      level: 'info',
      message: 'Duplicate log line',
    });

    render(
      <WebSocketProvider url="ws://runtime.test/ws">
        <div>child</div>
      </WebSocketProvider>,
    );

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    const ws = MockWebSocket.instances[0];

    act(() => {
      ws.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'trace_event',
            sessionId: 'session-1',
            event: makeTraceEvent({
              id: 'evt-duplicate-thought',
              type: 'tool_thought',
              data: {
                thought: 'Already rendered thought',
                toolName: 'search',
              },
            }),
          }),
        }) as MessageEvent<string>,
      );
    });

    expect(sessionStoreState.addMessage).not.toHaveBeenCalled();
    expect(observatoryStoreState.addLog).not.toHaveBeenCalled();
    expect(formatTraceEventLogMock).not.toHaveBeenCalled();
    expect(sessionStoreState.rememberResumeHandle).toHaveBeenCalledWith(
      expect.objectContaining({
        lastSeenTraceEventId: 'evt-duplicate-thought',
      }),
    );
  });

  it('reuses the SDK message id for the local user bubble and websocket payload', async () => {
    let capturedContext: ReturnType<typeof useWebSocketContext> | null = null;

    render(
      <WebSocketProvider url="ws://runtime.test/ws">
        <WebSocketContextHarness
          onReady={(context) => {
            capturedContext = context;
          }}
        />
      </WebSocketProvider>,
    );

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(1);
      expect(capturedContext).not.toBeNull();
    });

    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.readyState = MockWebSocket.OPEN;
      ws.onopen?.(new Event('open'));
    });
    ws.send.mockClear();

    act(() => {
      capturedContext?.sendMessage('hello', { messageId: 'sdk-msg-1' });
    });

    expect(sessionStoreState.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'sdk-msg-1',
        role: 'user',
        content: 'hello',
      }),
    );
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'send_message',
        sessionId: 'session-1',
        text: 'hello',
        messageId: 'sdk-msg-1',
      }),
    );
  });

  it('uses text/body fallback fields for agent transfer messages when message is not a string', async () => {
    render(
      <WebSocketProvider url="ws://runtime.test/ws">
        <div>child</div>
      </WebSocketProvider>,
    );

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.readyState = MockWebSocket.OPEN;
      ws.onopen?.(new Event('open'));
    });

    act(() => {
      ws.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'agent_transfer_event',
            sessionId: 'session-1',
            event: {
              type: 'agent:message',
              data: {
                message: { text: 'nested provider payload' },
                text: 'Template text content',
                body: 'Body fallback content',
              },
            },
          }),
        }) as MessageEvent<string>,
      );
    });

    expect(sessionStoreState.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'assistant',
        content: 'Template text content',
      }),
    );
  });

  it('validates a manual resume through attach before sending resume_session', async () => {
    let capturedContext: ReturnType<typeof useWebSocketContext> | null = null;

    render(
      <WebSocketProvider url="ws://runtime.test/ws">
        <WebSocketContextHarness
          onReady={(context) => {
            capturedContext = context;
          }}
        />
      </WebSocketProvider>,
    );

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(1);
      expect(capturedContext).not.toBeNull();
    });

    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.readyState = MockWebSocket.OPEN;
      ws.onopen?.(new Event('open'));
    });

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        '/api/runtime/sessions/attach?projectId=project-1',
        expect.objectContaining({
          body: JSON.stringify({
            sessionId: 'session-1',
            channel: 'web_debug',
          }),
        }),
      );
    });

    ws.send.mockClear();

    act(() => {
      capturedContext?.resumeSession('session-2');
    });

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        '/api/runtime/sessions/attach?projectId=project-1',
        expect.objectContaining({
          method: 'POST',
          cache: 'no-store',
          body: JSON.stringify({
            sessionId: 'session-2',
            channel: 'web_debug',
          }),
        }),
      );
    });

    await waitFor(() => {
      expect(sessionStoreState.rememberResumeHandle).toHaveBeenCalledWith({
        sessionId: 'session-2',
        projectId: 'project-1',
        kind: 'web_debug',
      });
      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'resume_session',
          sessionId: 'session-2',
        }),
      );
    });
  });

  it('discovers the current developer session from the server when local resume state is missing', async () => {
    Object.assign(authStoreState, {
      user: { id: 'user-1', email: 'test@test.com' },
    });
    Object.assign(sessionStoreState, {
      sessionId: null,
      resumeHandle: {
        sessionId: null,
        projectId: null,
        kind: null,
        lastSeenTraceEventId: null,
      },
    });
    apiFetchMock.mockResolvedValueOnce(
      makeDeveloperSessionResponse({
        sessionId: 'server-session-1',
        projectId: 'project-1',
      }),
    );

    render(
      <WebSocketProvider url="ws://runtime.test/ws">
        <div>child</div>
      </WebSocketProvider>,
    );

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.readyState = MockWebSocket.OPEN;
      ws.onopen?.(new Event('open'));
    });

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        '/api/runtime/sessions/current?projectId=project-1&channel=web_debug',
        { cache: 'no-store' },
      );
    });

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        '/api/runtime/sessions/attach?projectId=project-1',
        expect.objectContaining({
          method: 'POST',
          cache: 'no-store',
          body: JSON.stringify({
            sessionId: 'server-session-1',
            channel: 'web_debug',
          }),
        }),
      );
    });

    await waitFor(() => {
      expect(sessionStoreState.rememberResumeHandle).toHaveBeenCalledWith({
        sessionId: 'server-session-1',
        projectId: 'project-1',
        kind: 'web_debug',
      });
      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'resume_session',
          sessionId: 'server-session-1',
        }),
      );
    });
  });

  it('falls back to the current developer session when the saved resume handle is no longer attachable', async () => {
    Object.assign(authStoreState, {
      user: { id: 'user-1', email: 'test@test.com' },
    });
    Object.assign(sessionStoreState, {
      sessionId: 'stale-session',
      resumeHandle: {
        sessionId: 'stale-session',
        projectId: 'project-1',
        kind: 'web_debug',
        lastSeenTraceEventId: 'evt-stale',
      },
    });

    apiFetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      if (typeof input !== 'string') {
        throw new Error(`Unexpected apiFetch call: ${String(input)}`);
      }

      if (input === '/api/runtime/sessions/current?projectId=project-1&channel=web_debug') {
        return makeDeveloperSessionResponse({
          sessionId: 'server-session-1',
          projectId: 'project-1',
        });
      }

      if (input === '/api/runtime/sessions/attach?projectId=project-1') {
        const requestBody =
          typeof init?.body === 'string' ? (JSON.parse(init.body) as { sessionId?: string }) : {};
        if (requestBody.sessionId === 'stale-session') {
          return makeDeveloperSessionNotFoundResponse();
        }

        if (requestBody.sessionId === 'server-session-1') {
          return makeDeveloperSessionResponse({
            sessionId: 'server-session-1',
            projectId: 'project-1',
          });
        }
      }

      throw new Error(`Unexpected apiFetch call: ${input}`);
    });

    render(
      <WebSocketProvider url="ws://runtime.test/ws">
        <div>child</div>
      </WebSocketProvider>,
    );

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.readyState = MockWebSocket.OPEN;
      ws.onopen?.(new Event('open'));
    });

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        '/api/runtime/sessions/attach?projectId=project-1',
        expect.objectContaining({
          body: JSON.stringify({
            sessionId: 'stale-session',
            channel: 'web_debug',
          }),
        }),
      );
    });

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        '/api/runtime/sessions/current?projectId=project-1&channel=web_debug',
        { cache: 'no-store' },
      );
    });

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        '/api/runtime/sessions/attach?projectId=project-1',
        expect.objectContaining({
          body: JSON.stringify({
            sessionId: 'server-session-1',
            channel: 'web_debug',
          }),
        }),
      );
    });

    await waitFor(() => {
      expect(sessionStoreState.clearResumeHandle).toHaveBeenCalledTimes(1);
      expect(sessionStoreState.rememberResumeHandle).toHaveBeenCalledWith({
        sessionId: 'server-session-1',
        projectId: 'project-1',
        kind: 'web_debug',
      });
      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'resume_session',
          sessionId: 'server-session-1',
        }),
      );
    });
  });

  it('ignores discovered developer sessions while a fresh chat launch is still loading', async () => {
    Object.assign(authStoreState, {
      user: { id: 'user-1', email: 'test@test.com' },
    });
    Object.assign(sessionStoreState, {
      sessionId: null,
      resumeHandle: {
        sessionId: null,
        projectId: null,
        kind: null,
        lastSeenTraceEventId: null,
      },
    });

    let resolveFetch: ((response: Response) => void) | null = null;
    apiFetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    render(
      <WebSocketProvider url="ws://runtime.test/ws">
        <div>child</div>
      </WebSocketProvider>,
    );

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.readyState = MockWebSocket.OPEN;
      ws.onopen?.(new Event('open'));
    });

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        '/api/runtime/sessions/current?projectId=project-1&channel=web_debug',
        { cache: 'no-store' },
      );
    });

    sessionStoreState.isLoading = true;

    await act(async () => {
      resolveFetch?.(
        makeDeveloperSessionResponse({
          sessionId: 'server-session-1',
          projectId: 'project-1',
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(ws.send).not.toHaveBeenCalledWith(
      JSON.stringify({
        type: 'resume_session',
        sessionId: 'server-session-1',
      }),
    );
    expect(sessionStoreState.rememberResumeHandle).not.toHaveBeenCalledWith({
      sessionId: 'server-session-1',
      projectId: 'project-1',
      kind: 'web_debug',
    });
  });

  it('ignores discovered developer sessions after a newer session has already bound locally', async () => {
    Object.assign(authStoreState, {
      user: { id: 'user-1', email: 'test@test.com' },
    });
    Object.assign(sessionStoreState, {
      sessionId: null,
      resumeHandle: {
        sessionId: null,
        projectId: null,
        kind: null,
        lastSeenTraceEventId: null,
      },
    });

    let resolveFetch: ((response: Response) => void) | null = null;
    apiFetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    render(
      <WebSocketProvider url="ws://runtime.test/ws">
        <div>child</div>
      </WebSocketProvider>,
    );

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.readyState = MockWebSocket.OPEN;
      ws.onopen?.(new Event('open'));
    });

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        '/api/runtime/sessions/current?projectId=project-1&channel=web_debug',
        { cache: 'no-store' },
      );
    });

    Object.assign(sessionStoreState, {
      sessionId: 'fresh-session',
      resumeHandle: {
        sessionId: 'fresh-session',
        projectId: 'project-1',
        kind: 'web_debug',
        lastSeenTraceEventId: null,
      },
      isLoading: false,
    });

    await act(async () => {
      resolveFetch?.(
        makeDeveloperSessionResponse({
          sessionId: 'server-session-1',
          projectId: 'project-1',
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(ws.send).not.toHaveBeenCalledWith(
      JSON.stringify({
        type: 'resume_session',
        sessionId: 'server-session-1',
      }),
    );
    expect(sessionStoreState.rememberResumeHandle).not.toHaveBeenCalledWith({
      sessionId: 'server-session-1',
      projectId: 'project-1',
      kind: 'web_debug',
    });
  });

  it('applies resume trace_replay incrementally without falling back to REST detail hydration', async () => {
    observatoryStoreState.events = [
      makeExtendedEvent({
        id: 'evt-live',
        timestamp: new Date('2026-04-22T10:00:02.000Z'),
      }),
    ];

    render(
      <WebSocketProvider url="ws://runtime.test/ws">
        <div>child</div>
      </WebSocketProvider>,
    );

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    const ws = MockWebSocket.instances[0];

    act(() => {
      ws.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'session_resumed',
            sessionId: 'session-1',
            state: { context: {}, conversationPhase: 'start', gatherProgress: {} },
            agent: {
              id: 'agent-1',
              name: 'Booking_Agent',
              type: 'agent',
              mode: 'reasoning',
              toolCount: 0,
              gatherFieldCount: 0,
              isSupervisor: false,
              dsl: '',
            },
            conversationHistory: [],
          }),
        }) as MessageEvent<string>,
      );
    });

    await waitFor(() => {
      expect(sessionStoreState.agent).toMatchObject({ name: 'Booking_Agent' });
    });

    act(() => {
      ws.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'trace_replay',
            sessionId: 'session-1',
            source: 'resume',
            afterEventId: 'evt-live',
            snapshotRequired: false,
            totalBuffered: 2,
            events: [
              makeTraceEvent({
                id: 'evt-live-gap',
                timestamp: '2026-04-22T10:00:03.000Z',
                spanId: 'span-2',
              }),
            ],
          }),
        }) as MessageEvent<string>,
      );
    });

    await waitFor(() => {
      expect(observatoryStoreState.addEvent).toHaveBeenCalledTimes(1);
    });

    expect(replayTraceEventsIntoObservatoryMock).not.toHaveBeenCalled();
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(observatoryStoreState.addEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'evt-live-gap',
        sessionId: 'session-1',
        spanId: 'span-2',
      }),
    );
  });

  it('keeps the resumed transcript and hydrates traces separately after cross-session resume', async () => {
    Object.assign(sessionStoreState, {
      sessionId: 'session-2',
      agent: {
        id: 'agent-2',
        name: 'Other_Agent',
        type: 'agent',
        mode: 'reasoning',
        toolCount: 0,
        gatherFieldCount: 0,
        isSupervisor: false,
        dsl: '',
      },
      messages: [{ id: 'msg-existing', role: 'user', content: 'other session' }],
      messageSnapshotVersion: 1,
    });

    apiFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          traces: [
            {
              id: 'evt-history',
              type: 'dsl_respond',
              timestamp: '2026-04-22T10:00:01.000Z',
              sessionId: 'session-1',
              data: { rendered: 'hello there' },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    render(
      <WebSocketProvider url="ws://runtime.test/ws">
        <div>child</div>
      </WebSocketProvider>,
    );

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    const ws = MockWebSocket.instances[0];

    act(() => {
      ws.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'session_resumed',
            sessionId: 'session-1',
            state: { context: {}, conversationPhase: 'start', gatherProgress: {} },
            agent: {
              id: 'agent-1',
              name: 'Booking_Agent',
              type: 'agent',
              mode: 'reasoning',
              toolCount: 0,
              gatherFieldCount: 0,
              isSupervisor: false,
              dsl: '',
            },
            conversationHistory: [
              { id: 'resume-user-1', role: 'user', content: 'first turn' },
              { id: 'resume-assistant-1', role: 'assistant', content: 'first reply' },
              { id: 'resume-user-2', role: 'user', content: 'latest turn' },
              {
                id: 'resume-assistant-2',
                role: 'assistant',
                content: 'latest reply',
                metadata: RESUME_ASSISTANT_METADATA,
              },
            ],
          }),
        }) as MessageEvent<string>,
      );
    });

    await waitFor(() => {
      expect(sessionStoreState.sessionId).toBe('session-1');
    });

    act(() => {
      ws.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'trace_replay',
            sessionId: 'session-1',
            source: 'resume',
            afterEventId: 'evt-live',
            snapshotRequired: false,
            totalBuffered: 1,
            events: [],
          }),
        }) as MessageEvent<string>,
      );
    });

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        '/api/runtime/sessions/session-1/traces?projectId=project-1',
        { cache: 'no-store' },
      );
    });

    expect(hydrateSessionStoreFromDetailMock).not.toHaveBeenCalled();
    expect(sessionStoreState.messages).toEqual([
      {
        id: 'resume-user-1',
        role: 'user',
        content: 'first turn',
        timestamp: expect.any(Date),
        traceIds: [],
      },
      {
        id: 'resume-assistant-1',
        role: 'assistant',
        content: 'first reply',
        timestamp: expect.any(Date),
        traceIds: [],
      },
      {
        id: 'resume-user-2',
        role: 'user',
        content: 'latest turn',
        timestamp: expect.any(Date),
        traceIds: [],
      },
      {
        id: 'resume-assistant-2',
        role: 'assistant',
        content: 'latest reply',
        metadata: RESUME_ASSISTANT_METADATA,
        timestamp: expect.any(Date),
        traceIds: [],
      },
    ]);

    expect(replayTraceEventsIntoObservatoryMock).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          id: 'evt-history',
          timestamp: new Date('2026-04-22T10:00:01.000Z'),
        }),
      ],
      'session-1',
    );
  });

  it('rebuilds traces without replacing the resumed transcript when replay requires a snapshot', async () => {
    Object.assign(sessionStoreState, {
      sessionId: 'session-1',
      messages: [],
      messageSnapshotVersion: 0,
    });

    apiFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          traces: [
            {
              id: 'evt-snapshot',
              type: 'dsl_respond',
              timestamp: '2026-04-22T10:01:00.000Z',
              sessionId: 'session-1',
              data: { rendered: 'snapshot reply' },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    render(
      <WebSocketProvider url="ws://runtime.test/ws">
        <div>child</div>
      </WebSocketProvider>,
    );

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    const ws = MockWebSocket.instances[0];

    act(() => {
      ws.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'session_resumed',
            sessionId: 'session-1',
            state: { context: {}, conversationPhase: 'start', gatherProgress: {} },
            agent: {
              id: 'agent-1',
              name: 'Booking_Agent',
              type: 'agent',
              mode: 'reasoning',
              toolCount: 0,
              gatherFieldCount: 0,
              isSupervisor: false,
              dsl: '',
            },
            conversationHistory: [
              { id: 'resume-user-1', role: 'user', content: 'keep me' },
              { id: 'resume-assistant-1', role: 'assistant', content: 'keep me too' },
            ],
          }),
        }) as MessageEvent<string>,
      );
    });

    act(() => {
      ws.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'trace_replay',
            sessionId: 'session-1',
            source: 'resume',
            afterEventId: 'evt-missing',
            snapshotRequired: true,
            totalBuffered: 1,
            events: [],
          }),
        }) as MessageEvent<string>,
      );
    });

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        '/api/runtime/sessions/session-1/traces?projectId=project-1',
        { cache: 'no-store' },
      );
    });

    expect(hydrateSessionStoreFromDetailMock).not.toHaveBeenCalled();
    expect(sessionStoreState.messages).toEqual([
      {
        id: 'resume-user-1',
        role: 'user',
        content: 'keep me',
        timestamp: expect.any(Date),
        traceIds: [],
      },
      {
        id: 'resume-assistant-1',
        role: 'assistant',
        content: 'keep me too',
        timestamp: expect.any(Date),
        traceIds: [],
      },
    ]);
    expect(replayTraceEventsIntoObservatoryMock).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          id: 'evt-snapshot',
          timestamp: new Date('2026-04-22T10:01:00.000Z'),
        }),
      ],
      'session-1',
    );
  });

  it('reuses server-provided resume message ids when hydrating conversation history', async () => {
    render(
      <WebSocketProvider url="ws://runtime.test/ws">
        <div>child</div>
      </WebSocketProvider>,
    );

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    const ws = MockWebSocket.instances[0];

    act(() => {
      ws.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'session_resumed',
            sessionId: 'session-1',
            state: { context: {}, conversationPhase: 'start', gatherProgress: {} },
            conversationHistory: [
              { id: 'resume-user-1', role: 'user', content: 'hello' },
              { id: 'resume-assistant-1', role: 'assistant', content: 'hi there' },
            ],
          }),
        }) as MessageEvent<string>,
      );
    });

    await waitFor(() => {
      expect(sessionStoreState.messages).toHaveLength(2);
    });

    expect(sessionStoreState.messages.map((message) => message.id)).toEqual([
      'resume-user-1',
      'resume-assistant-1',
    ]);
  });

  it('ignores shorter same-session resume snapshots without rolling state backward', async () => {
    Object.assign(sessionStoreState, {
      sessionId: 'session-1',
      state: {
        context: { phase: 'current' },
        conversationPhase: 'active',
        gatherProgress: { field: true },
      },
      messages: [
        { id: 'local-user-1', role: 'user', content: 'current turn' },
        { id: 'local-assistant-1', role: 'assistant', content: 'current reply' },
      ],
      messageSnapshotVersion: 1,
    });

    render(
      <WebSocketProvider url="ws://runtime.test/ws">
        <div>child</div>
      </WebSocketProvider>,
    );

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    const ws = MockWebSocket.instances[0];

    act(() => {
      ws.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'session_resumed',
            sessionId: 'session-1',
            state: {
              context: { phase: 'stale' },
              conversationPhase: 'start',
              gatherProgress: {},
            },
            conversationHistory: [],
          }),
        }) as MessageEvent<string>,
      );
    });

    expect(sessionStoreState.setState).not.toHaveBeenCalled();
    expect(sessionStoreState.replaceMessages).not.toHaveBeenCalled();
    expect(sessionStoreState.messages).toEqual([
      { id: 'local-user-1', role: 'user', content: 'current turn' },
      { id: 'local-assistant-1', role: 'assistant', content: 'current reply' },
    ]);
  });

  it('falls back to the traces endpoint when switching sessions without embedded trace events', async () => {
    let capturedContext: ReturnType<typeof useWebSocketContext> | null = null;

    apiFetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            session: {
              id: 'session-2',
              agentName: 'Booking_Agent',
              messages: [
                {
                  id: 'msg-1',
                  role: 'assistant',
                  content: 'Historical response',
                  timestamp: '2026-04-22T10:00:00.000Z',
                },
              ],
              traceEvents: [],
              state: { context: {}, conversationPhase: 'start', gatherProgress: {} },
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            traces: [
              makeTraceEvent({
                id: 'trace-historical',
                sessionId: 'session-2',
                timestamp: '2026-04-22T10:00:01.000Z',
              }),
            ],
          }),
          { status: 200 },
        ),
      );

    render(
      <WebSocketProvider url="ws://runtime.test/ws">
        <WebSocketContextHarness
          onReady={(context) => {
            capturedContext = context;
          }}
        />
      </WebSocketProvider>,
    );

    await waitFor(() => {
      expect(capturedContext).not.toBeNull();
    });

    await act(async () => {
      await capturedContext?.switchSession('session-2');
    });

    expect(apiFetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/runtime/sessions/session-2?projectId=project-1',
    );
    expect(apiFetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/runtime/sessions/session-2/traces?projectId=project-1',
      { cache: 'no-store' },
    );
    expect(hydrateSessionStoreFromDetailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'session-2',
        agentName: 'Booking_Agent',
        traceEvents: [],
      }),
      [
        expect.objectContaining({
          id: 'trace-historical',
          sessionId: 'session-2',
          timestamp: expect.any(Date),
        }),
      ],
    );
    expect(replayTraceEventsIntoObservatoryMock).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          id: 'trace-historical',
          sessionId: 'session-2',
          timestamp: expect.any(Date),
        }),
      ],
      'session-2',
    );
    expect(uiStoreState.setSessionDetailMode).toHaveBeenCalledWith(true);
  });

  it('preserves the last seen replay cursor when resume replay has no missed events', async () => {
    render(
      <WebSocketProvider url="ws://runtime.test/ws" reconnectInterval={1}>
        <div>child</div>
      </WebSocketProvider>,
    );

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    const ws = MockWebSocket.instances[0];

    act(() => {
      ws.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'trace_event',
            sessionId: 'session-1',
            event: makeTraceEvent({ id: 'evt-live' }),
          }),
        }) as MessageEvent<string>,
      );
    });

    act(() => {
      ws.readyState = MockWebSocket.OPEN;
      ws.onopen?.(new Event('open'));
    });

    await waitFor(() => {
      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'resume_session',
          sessionId: 'session-1',
          lastSeenTraceEventId: 'evt-live',
        }),
      );
    });

    act(() => {
      ws.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'trace_replay',
            sessionId: 'session-1',
            source: 'resume',
            afterEventId: 'evt-live',
            snapshotRequired: false,
            totalBuffered: 1,
            events: [],
          }),
        }) as MessageEvent<string>,
      );
    });

    act(() => {
      ws.readyState = MockWebSocket.CLOSED;
      ws.onclose?.(new CloseEvent('close'));
    });

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(2);
    });

    const resumedWs = MockWebSocket.instances[1];

    act(() => {
      resumedWs.readyState = MockWebSocket.OPEN;
      resumedWs.onopen?.(new Event('open'));
    });

    await waitFor(() => {
      expect(resumedWs.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'resume_session',
          sessionId: 'session-1',
          lastSeenTraceEventId: 'evt-live',
        }),
      );
    });
  });
});
