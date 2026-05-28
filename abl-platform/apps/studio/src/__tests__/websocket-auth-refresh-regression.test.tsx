/**
 * @vitest-environment happy-dom
 */

import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../lib/api-client';
import { cancelTokenRefresh, scheduleTokenRefresh } from '../api/auth';
import { WebSocketProvider, useWebSocketContext } from '../contexts/WebSocketContext';

const {
  mockSWRMutate,
  createInitialAgentStateMock,
  hydrateSessionStoreFromDetailMock,
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
  const signalLogoutMock = vi.fn((reason: string) => {
    window.dispatchEvent(new CustomEvent(logoutSignalEvent, { detail: reason }));
  });

  const sessionStoreState = {
    sessionId: null as string | null,
    resumeHandle: {
      sessionId: null as string | null,
      projectId: null as string | null,
      kind: null as 'web_debug' | null,
      lastSeenTraceEventId: null as string | null,
    },
    agent: null,
    messages: [] as Array<{ role: string; id: string }>,
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
    addMessage: vi.fn(),
    clearMessages: vi.fn(),
    replaceMessages: vi.fn((messages: Array<{ role: string; id: string }>) => {
      sessionStoreState.messages = messages;
    }),
    setLoading: vi.fn(),
    clearSession: vi.fn(),
    restoreSession: vi.fn(),
    updateMessage: vi.fn(),
  };

  const observatoryStoreState = {
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

  return {
    mockSWRMutate: vi.fn(),
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
    hydrateSessionStoreFromDetailMock: vi.fn(),
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
  formatTraceEventLog: vi.fn(() => []),
  replayTraceEventsIntoObservatory: vi.fn(),
  hydrateSessionStoreFromDetail: hydrateSessionStoreFromDetailMock,
}));

vi.mock('../utils/live-trace-event-ingestion', () => ({
  ingestLiveTraceEvent: vi.fn(() => ({
    traceEvent: { id: 'trace-1', type: 'info', timestamp: new Date().toISOString() },
    eventPayload: {},
  })),
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

vi.mock('swr', () => ({
  mutate: (...args: unknown[]) => mockSWRMutate(...args),
}));

vi.mock('@agent-platform/shared/websocket-auth', () => ({
  buildWebDebugWSProtocols: buildWebDebugWSProtocolsMock,
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

function syncAuthStore(partial: Partial<typeof authStoreState>): void {
  Object.assign(authStoreState, partial);
  useAuthStoreMock.setState({
    accessToken: authStoreState.accessToken,
    tenantId: authStoreState.tenantId,
    user: authStoreState.user,
    isSuperAdmin: authStoreState.isSuperAdmin,
    isAuthenticated: authStoreState.isAuthenticated,
    isLoading: authStoreState.isLoading,
  });
}

function resetMockState(): void {
  const resetMockFunctions = (record: Record<string, unknown>) => {
    for (const value of Object.values(record)) {
      if (vi.isMockFunction(value)) {
        value.mockReset();
      }
    }
  };

  syncAuthStore({
    accessToken: 'test-token',
    tenantId: 'tenant-1',
    user: null,
    isSuperAdmin: false,
    isAuthenticated: true,
    isLoading: false,
  });
  Object.assign(sessionStoreState, {
    sessionId: null,
    resumeHandle: {
      sessionId: null,
      projectId: null,
      kind: null,
      lastSeenTraceEventId: null,
    },
    agent: null,
    messages: [],
    state: null,
    lastAction: null,
    isLoading: false,
    isStreaming: false,
    streamingMessageId: null,
    streamingContent: '',
    error: null,
    statusMessage: null,
  });
  resetMockFunctions(authStoreState);
  resetMockFunctions(sessionStoreState);
  resetMockFunctions(observatoryStoreState);
  resetMockFunctions(uiStoreState);
  resetMockFunctions(batchConsentStoreState);
  startProjectAgentSessionMock.mockClear();
  buildWebDebugWSProtocolsMock.mockClear();
  signalLogoutMock.mockClear();
  mockSWRMutate.mockReset();
  hydrateSessionStoreFromDetailMock.mockReset();
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
  sessionStoreState.replaceMessages.mockImplementation(
    (messages: Array<{ role: string; id: string }>) => {
      sessionStoreState.messages = messages;
    },
  );
  authStoreState.setTokens.mockImplementation((accessToken: string) => {
    syncAuthStore({ accessToken });
  });
  authStoreState.clearAuth.mockImplementation(() => {
    syncAuthStore({
      accessToken: null,
      tenantId: null,
      user: null,
      isSuperAdmin: false,
      isAuthenticated: false,
      isLoading: false,
    });
  });
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

describe('ABLP-214 websocket auth refresh regression', () => {
  beforeEach(() => {
    resetMockState();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    cancelTokenRefresh();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps the auth store intact when a background 401 retry fails during an idle API refresh', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }));

    vi.stubGlobal('fetch', fetchMock);

    const response = await apiFetch('/api/debug/logs');

    expect(response.status).toBe(401);
    expect(useAuthStoreMock.getState().accessToken).toBe('test-token');
    expect(useAuthStoreMock.getState().isAuthenticated).toBe(true);
    expect(authStoreState.clearAuth).not.toHaveBeenCalled();
  });

  it('keeps the websocket connected while browsing debug logs if apiFetch hits a background 401 and refresh also fails', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }));

    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(
      <WebSocketProvider url="ws://runtime.test/ws">
        <div>child</div>
      </WebSocketProvider>,
    );

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    const response = await apiFetch('/api/debug/logs');

    act(() => {
      rerender(
        <WebSocketProvider url="ws://runtime.test/ws">
          <div>child</div>
        </WebSocketProvider>,
      );
    });

    expect(response.status).toBe(401);
    expect(useAuthStoreMock.getState().accessToken).toBe('test-token');
    expect(useAuthStoreMock.getState().isAuthenticated).toBe(true);
    expect(authStoreState.clearAuth).not.toHaveBeenCalled();
    expect(MockWebSocket.instances[0]?.close).not.toHaveBeenCalled();
  });

  it('does not clear auth from the scheduled background token refresh path when refresh fails', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401 });

    vi.stubGlobal('fetch', fetchMock);

    scheduleTokenRefresh(120);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/refresh',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
      }),
    );
    expect(useAuthStoreMock.getState().accessToken).toBe('test-token');
    expect(authStoreState.clearAuth).not.toHaveBeenCalled();
  });

  it('retries the scheduled background token refresh after a failure instead of logging the user out', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accessToken: 'retried-token', expiresIn: 120 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    vi.stubGlobal('fetch', fetchMock);

    scheduleTokenRefresh(120);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(authStoreState.clearAuth).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(useAuthStoreMock.getState().accessToken).toBe('retried-token');
    expect(authStoreState.clearAuth).not.toHaveBeenCalled();
  });

  it('keeps an active websocket connected when the scheduled refresh timer hits a background 401', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);

    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(
      <WebSocketProvider url="ws://runtime.test/ws">
        <div>child</div>
      </WebSocketProvider>,
    );

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    vi.useFakeTimers();
    scheduleTokenRefresh(120);
    await vi.advanceTimersByTimeAsync(60_000);

    act(() => {
      rerender(
        <WebSocketProvider url="ws://runtime.test/ws">
          <div>child</div>
        </WebSocketProvider>,
      );
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/refresh',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
      }),
    );
    expect(useAuthStoreMock.getState().accessToken).toBe('test-token');
    expect(useAuthStoreMock.getState().isAuthenticated).toBe(true);
    expect(authStoreState.clearAuth).not.toHaveBeenCalled();
    expect(MockWebSocket.instances[0]?.close).not.toHaveBeenCalled();
  });

  it('does not tear down the websocket when auth briefly flips during a background refresh failure', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);

    const { rerender } = render(
      <WebSocketProvider url="ws://runtime.test/ws">
        <div>child</div>
      </WebSocketProvider>,
    );

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    expect(buildWebDebugWSProtocolsMock).toHaveBeenCalledWith('test-token');

    act(() => {
      useAuthStoreMock.setState({
        isAuthenticated: false,
      });
      rerender(
        <WebSocketProvider url="ws://runtime.test/ws">
          <div>child</div>
        </WebSocketProvider>,
      );
    });

    expect(MockWebSocket.instances[0]?.close).not.toHaveBeenCalled();
  });

  it('tears down the websocket when an explicit logout signal fires', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);

    const { rerender } = render(
      <WebSocketProvider url="ws://runtime.test/ws">
        <div>child</div>
      </WebSocketProvider>,
    );

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    act(() => {
      signalLogoutMock('explicit-logout');
      useAuthStoreMock.setState({
        accessToken: null,
        isAuthenticated: false,
      });
      rerender(
        <WebSocketProvider url="ws://runtime.test/ws">
          <div>child</div>
        </WebSocketProvider>,
      );
    });

    expect(MockWebSocket.instances[0]?.close).toHaveBeenCalledTimes(1);
  });

  it('replaces the local transcript from session_resumed when revisiting another session', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);

    Object.assign(sessionStoreState, {
      sessionId: 'other-session',
      agent: {
        id: 'other-agent',
        name: 'OtherAgent',
      },
      messages: [{ id: 'other-message', role: 'user' }],
      isStreaming: false,
    });

    render(
      <WebSocketProvider url="ws://runtime.test/ws">
        <div>child</div>
      </WebSocketProvider>,
    );

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    act(() => {
      MockWebSocket.instances[0]?.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'session_resumed',
            sessionId: 'session-1',
            state: {
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
            },
            conversationHistory: [{ role: 'user', content: 'What is the weather?' }],
          }),
        }),
      );
    });

    await waitFor(() => {
      expect(sessionStoreState.replaceMessages).toHaveBeenCalledWith([
        expect.objectContaining({
          id: 'resume-session-1-0',
          role: 'user',
          content: 'What is the weather?',
          timestamp: expect.any(Date),
          traceIds: [],
        }),
      ]);
      expect(sessionStoreState.messages).toEqual([
        expect.objectContaining({
          id: 'resume-session-1-0',
          role: 'user',
          content: 'What is the weather?',
          timestamp: expect.any(Date),
          traceIds: [],
        }),
      ]);
      expect(hydrateSessionStoreFromDetailMock).not.toHaveBeenCalled();
      expect(sessionStoreState.rememberResumeHandle).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-1',
          projectId: 'project-1',
          kind: 'web_debug',
        }),
      );
    });
  });

  it('invalidates session list/detail caches when a session_reset event arrives', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
    Object.assign(sessionStoreState, {
      sessionId: 'session-1',
      resumeHandle: {
        sessionId: 'session-1',
        projectId: 'project-1',
        kind: 'web_debug',
        lastSeenTraceEventId: 'evt-1',
      },
      messages: [{ id: 'msg-1', role: 'assistant' }],
      state: {
        context: { customerId: 'cust-1' },
        conversationPhase: 'gathering',
        gatherProgress: { email: true },
        constraintResults: {},
        lastToolResults: {},
        memory: {
          session: {},
          persistentCache: {},
          pendingRemembers: [],
        },
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

    act(() => {
      MockWebSocket.instances[0]?.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'session_reset', sessionId: 'session-1' }),
        }),
      );
    });

    await waitFor(() => {
      expect(sessionStoreState.clearMessages).toHaveBeenCalledTimes(1);
      expect(sessionStoreState.setStatusMessage).toHaveBeenCalledWith(null);
      expect(sessionStoreState.rememberResumeHandle).toHaveBeenCalledWith({
        sessionId: 'session-1',
        projectId: 'project-1',
        kind: 'web_debug',
        lastSeenTraceEventId: null,
      });
      expect(sessionStoreState.state).toMatchObject({
        conversationPhase: 'start',
        context: {},
        gatherProgress: {},
      });
      expect(observatoryStoreState.clearEvents).toHaveBeenCalledTimes(1);
      expect(observatoryStoreState.clearFlow).toHaveBeenCalledTimes(1);
      expect(observatoryStoreState.clearLogs).toHaveBeenCalledTimes(1);
      expect(observatoryStoreState.resetMetrics).toHaveBeenCalledTimes(1);
      expect(batchConsentStoreState.reset).toHaveBeenCalledTimes(1);
    });

    expect(mockSWRMutate).toHaveBeenCalledWith('/api/runtime/sessions?projectId=project-1');
    expect(mockSWRMutate).toHaveBeenCalledWith(
      '/api/runtime/sessions/session-1?projectId=project-1&includeTraces=false',
      expect.any(Function),
      { revalidate: false },
    );
    expect(mockSWRMutate).toHaveBeenCalledWith(
      '/api/runtime/sessions/session-1?projectId=project-1&includeTraces=false',
    );
    expect(mockSWRMutate).toHaveBeenCalledWith(
      '/api/runtime/sessions/session-1/traces?projectId=project-1',
      expect.any(Function),
      { revalidate: false },
    );
    expect(mockSWRMutate).toHaveBeenCalledWith(
      '/api/runtime/sessions/session-1/traces?projectId=project-1',
    );
    expect(mockSWRMutate).toHaveBeenCalledWith(
      '/api/runtime/sessions/session-1/agent-spec?projectId=project-1',
    );
  });

  it('rehydrates session detail when revisiting another session through switchSession', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            session: {
              id: 'session-1',
              agentName: 'WeatherAgent',
              state: {
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
              },
              messages: [
                {
                  id: 'db-msg-1',
                  role: 'user',
                  content: 'What is the weather?',
                  timestamp: '2026-04-23T06:28:00.000Z',
                },
                {
                  id: 'db-msg-2',
                  role: 'assistant',
                  content: 'Sunny.',
                  timestamp: '2026-04-23T06:28:01.000Z',
                },
              ],
              traceEvents: [],
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      ),
    );

    let capturedContext: ReturnType<typeof useWebSocketContext> | null = null;
    function ContextProbe() {
      capturedContext = useWebSocketContext();
      return <div>child</div>;
    }

    Object.assign(sessionStoreState, {
      sessionId: 'other-session',
      agent: {
        id: 'other-agent',
        name: 'OtherAgent',
      },
      messages: [{ id: 'other-message', role: 'user' }],
      isStreaming: false,
    });

    render(
      <WebSocketProvider url="ws://runtime.test/ws">
        <ContextProbe />
      </WebSocketProvider>,
    );

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    await act(async () => {
      await capturedContext?.switchSession('session-1');
    });

    await waitFor(() => {
      expect(hydrateSessionStoreFromDetailMock).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'session-1',
          agentName: 'WeatherAgent',
        }),
        [],
      );
    });
  });
});
