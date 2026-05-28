/**
 * Tests for session-related hooks:
 * - useSession
 * - useSessionDetail
 * - useSessionList
 * - useAgentSessions
 * - useTraceExplorer
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mock SWR — must be before hook imports
// ---------------------------------------------------------------------------

const mockMutate = vi.fn();
const mockSwrReturn = {
  data: undefined as unknown,
  error: undefined as unknown,
  isLoading: false,
  isValidating: false,
  mutate: mockMutate,
};

vi.mock('swr', () => ({
  default: vi.fn(() => mockSwrReturn),
}));

// Mock apiFetch used by useSessionDetail's fetcher
vi.mock('../../lib/api-client', () => ({
  apiFetch: vi.fn(),
  authHeaders: vi.fn(() => ({})),
  handleResponse: vi.fn(),
}));

// Mock replay-trace-events side effects, but keep shared augmentation helpers
vi.mock('../../utils/replay-trace-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/replay-trace-events')>();
  return {
    ...actual,
    replayTraceEventsIntoObservatory: vi.fn(),
    hydrateSessionStoreFromDetail: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Zustand store mocks — provide getState + setState so hooks can call them
// ---------------------------------------------------------------------------

const mockSessionStore: Record<string, unknown> = {
  sessionId: null,
  agent: null,
  messages: [],
  state: null,
  lastAction: null,
  isStreaming: false,
  streamingContent: '',
  isLoading: false,
  error: null,
  clearSession: vi.fn(),
};

vi.mock('../../store/session-store', () => ({
  useSessionStore: Object.assign(
    (selector?: (s: Record<string, unknown>) => unknown) =>
      selector ? selector(mockSessionStore) : mockSessionStore,
    {
      getState: () => mockSessionStore,
      setState: (partial: Record<string, unknown>) => Object.assign(mockSessionStore, partial),
    },
  ),
}));

vi.mock('../../store/auth-store', () => ({
  useAuthStore: Object.assign(
    (selector?: (s: Record<string, unknown>) => unknown) => {
      const state = { isAuthenticated: true };
      return selector ? selector(state) : state;
    },
    {
      getState: () => ({ isAuthenticated: true }),
    },
  ),
}));

const mockObservatoryStore: Record<string, unknown> = {
  debugPanelTab: 'overview',
  clearEvents: vi.fn(),
  clearFlow: vi.fn(),
  resetMetrics: vi.fn(),
  clearLogs: vi.fn(),
  clearExecutionState: vi.fn(),
  clearSelection: vi.fn(),
};

vi.mock('../../store/observatory-store', () => ({
  useObservatoryStore: Object.assign(
    (selector?: (s: Record<string, unknown>) => unknown) =>
      selector ? selector(mockObservatoryStore) : mockObservatoryStore,
    {
      getState: () => mockObservatoryStore,
    },
  ),
}));

vi.mock('../../store/ui-store', () => ({
  useUIStore: Object.assign(
    (selector?: (s: Record<string, unknown>) => unknown) => {
      const state = { sessionDetailMode: false, setSessionDetailMode: vi.fn() };
      return selector ? selector(state) : state;
    },
    {
      getState: () => ({ sessionDetailMode: false, setSessionDetailMode: vi.fn() }),
    },
  ),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { useSession } from '../../hooks/useSession';
import { useSessionDetail } from '../../hooks/useSessionDetail';
import { useSessionList } from '../../hooks/useSessionList';
import { useTraceExplorer } from '../../hooks/useTraceExplorer';
import {
  hydrateSessionStoreFromDetail,
  replayTraceEventsIntoObservatory,
} from '../../utils/replay-trace-events';
import { useAgentSessions } from '../../hooks/useAgentSessions';
import { apiFetch } from '../../lib/api-client';
import useSWR from 'swr';

// ===========================================================================
// useSession
// ===========================================================================

describe('useSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock store state
    Object.assign(mockSessionStore, {
      sessionId: null,
      agent: null,
      messages: [],
      state: null,
      lastAction: null,
      isStreaming: false,
      streamingContent: '',
      isLoading: false,
      error: null,
      clearSession: vi.fn(),
    });
  });

  it('should return hasSession false when no session', () => {
    const { result } = renderHook(() => useSession());

    expect(result.current.hasSession).toBe(false);
    expect(result.current.hasAgent).toBe(false);
    expect(result.current.sessionId).toBeNull();
  });

  it('should return hasSession true when session exists', () => {
    Object.assign(mockSessionStore, {
      sessionId: 'session-123',
      agent: {
        id: 'agent-1',
        name: 'TestAgent',
        domain: 'test',
        type: 'agent' as const,
        mode: 'reasoning' as const,
        toolCount: 3,
        gatherFieldCount: 5,
        isSupervisor: false,
        dsl: '',
      },
    });

    const { result } = renderHook(() => useSession());

    expect(result.current.hasSession).toBe(true);
    expect(result.current.hasAgent).toBe(true);
    expect(result.current.sessionId).toBe('session-123');
  });

  it('should compute gatherFields from agent', () => {
    Object.assign(mockSessionStore, {
      agent: {
        id: 'agent-1',
        name: 'TestAgent',
        domain: 'test',
        type: 'agent' as const,
        mode: 'scripted' as const,
        toolCount: 2,
        gatherFieldCount: 4,
        isSupervisor: false,
        dsl: '',
      },
    });

    const { result } = renderHook(() => useSession());

    expect(result.current.gatherFields).toBe(4);
    expect(result.current.toolCount).toBe(2);
  });

  it('should return 0 gatherFields when no agent', () => {
    const { result } = renderHook(() => useSession());

    expect(result.current.gatherFields).toBe(0);
    expect(result.current.toolCount).toBe(0);
  });

  it('should compute gatherPercentage from state', () => {
    Object.assign(mockSessionStore, {
      agent: {
        gatherFieldCount: 4,
        toolCount: 0,
      },
      state: {
        gatherProgress: { name: 'John', email: 'john@example.com' },
        conversationPhase: 'gathering',
      },
    });

    const { result } = renderHook(() => useSession());

    expect(result.current.gatheredCount).toBe(2);
    expect(result.current.gatherPercentage).toBe(50);
    expect(result.current.phase).toBe('gathering');
  });

  it('should compute gatherPercentage as 0 when gatherFields is 0', () => {
    Object.assign(mockSessionStore, {
      agent: { gatherFieldCount: 0, toolCount: 0 },
      state: {
        gatherProgress: { name: 'John' },
        conversationPhase: 'start',
      },
    });

    const { result } = renderHook(() => useSession());

    expect(result.current.gatherPercentage).toBe(0);
  });

  it('should detect complete action', () => {
    Object.assign(mockSessionStore, {
      lastAction: { type: 'complete', message: 'Done' },
    });

    const { result } = renderHook(() => useSession());

    expect(result.current.isComplete).toBe(true);
    expect(result.current.isEscalated).toBe(false);
    expect(result.current.isHandedOff).toBe(false);
  });

  it('should detect escalated action', () => {
    Object.assign(mockSessionStore, {
      lastAction: { type: 'escalate', reason: 'Need human', priority: 'high' },
    });

    const { result } = renderHook(() => useSession());

    expect(result.current.isEscalated).toBe(true);
    expect(result.current.isComplete).toBe(false);
  });

  it('should detect handoff action', () => {
    Object.assign(mockSessionStore, {
      lastAction: {
        type: 'handoff',
        target: 'agent-2',
        context: {},
        returnExpected: true,
      },
    });

    const { result } = renderHook(() => useSession());

    expect(result.current.isHandedOff).toBe(true);
    expect(result.current.isComplete).toBe(false);
  });

  it('should expose clearSession action', () => {
    const clearFn = vi.fn();
    Object.assign(mockSessionStore, { clearSession: clearFn });

    const { result } = renderHook(() => useSession());

    result.current.clearSession();
    expect(clearFn).toHaveBeenCalledOnce();
  });

  it('should expose streaming state', () => {
    Object.assign(mockSessionStore, {
      isStreaming: true,
      streamingContent: 'Partial response...',
    });

    const { result } = renderHook(() => useSession());

    expect(result.current.isStreaming).toBe(true);
    expect(result.current.streamingContent).toBe('Partial response...');
  });

  it('should expose error state', () => {
    Object.assign(mockSessionStore, { error: 'Connection failed' });

    const { result } = renderHook(() => useSession());

    expect(result.current.error).toBe('Connection failed');
  });

  it('should return default phase when no state', () => {
    const { result } = renderHook(() => useSession());

    expect(result.current.phase).toBe('start');
  });
});

// ===========================================================================
// useSessionDetail
// ===========================================================================

describe('useSessionDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mockSwrReturn, {
      data: undefined,
      error: undefined,
      isLoading: false,
      mutate: mockMutate,
    });
    Object.assign(mockObservatoryStore, { debugPanelTab: 'overview' });
  });

  it('should not fetch when sessionId is null', () => {
    renderHook(() => useSessionDetail(null));

    expect(useSWR).toHaveBeenCalledWith(null, expect.any(Function), expect.any(Object));
  });

  it('should construct the correct SWR key for a session', () => {
    renderHook(() => useSessionDetail('sess-abc', 'proj-1'));

    expect(useSWR).toHaveBeenCalledWith(
      '/api/runtime/sessions/sess-abc?projectId=proj-1&includeTraces=false',
      expect.any(Function),
      expect.objectContaining({ revalidateOnFocus: false }),
    );
  });

  it('should return null SWR key when projectId is missing', () => {
    renderHook(() => useSessionDetail('sess-abc'));

    expect(useSWR).toHaveBeenCalledWith(null, expect.any(Function), expect.any(Object));
  });

  it('should return loading state', () => {
    Object.assign(mockSwrReturn, { isLoading: true });

    const { result } = renderHook(() => useSessionDetail('sess-1'));

    expect(result.current.loading).toBe(true);
    expect(result.current.session).toBeNull();
  });

  it('should return session data when loaded', () => {
    const sessionData = {
      id: 'sess-1',
      agentName: 'TestAgent',
      messages: [],
      traceEvents: [],
    };

    Object.assign(mockSwrReturn, { data: sessionData, isLoading: false });

    // Must pass both sessionId and projectId to avoid loading=true fallback
    const { result } = renderHook(() => useSessionDetail('sess-1', 'proj-1'));

    expect(result.current.session).toEqual(expect.objectContaining(sessionData));
    expect(result.current.loading).toBe(false);
  });

  it('should return error string when SWR errors', () => {
    Object.assign(mockSwrReturn, {
      error: new Error('Network failure'),
      isLoading: false,
    });

    const { result } = renderHook(() => useSessionDetail('sess-1'));

    expect(result.current.error).toBe('Network failure');
  });

  it('should compute empty tree when session is null', () => {
    Object.assign(mockSwrReturn, { data: undefined });

    const { result } = renderHook(() => useSessionDetail(null));

    expect(result.current.tree).toEqual([]);
  });

  it('should compute tree from messages and trace events', () => {
    const now = new Date('2025-01-01T10:00:00Z');
    const sessionData = {
      id: 'sess-1',
      agentName: 'TestAgent',
      messages: [
        { id: 'msg-1', role: 'user', content: 'Hello', timestamp: now },
        {
          id: 'msg-2',
          role: 'assistant',
          content: 'Hi there',
          timestamp: new Date('2025-01-01T10:00:01Z'),
        },
      ],
      traceEvents: [
        {
          id: 'ev-1',
          sessionId: 'sess-1',
          type: 'llm_call',
          timestamp: now,
          data: { model: 'claude-3.5-sonnet', tokensIn: 100, tokensOut: 50 },
        },
      ],
    };

    Object.assign(mockSwrReturn, { data: sessionData });

    const { result } = renderHook(() => useSessionDetail('sess-1'));

    expect(result.current.tree.length).toBeGreaterThan(0);
  });

  it('should compute metrics with zero values when no trace events', () => {
    Object.assign(mockSwrReturn, {
      data: {
        id: 'sess-1',
        agentName: 'Test',
        messages: [],
        traceEvents: [],
      },
    });

    const { result } = renderHook(() => useSessionDetail('sess-1'));

    expect(result.current.metrics).toEqual({
      totalTokens: 0,
      totalCost: 0,
      latencyMs: 0,
      llmCalls: 0,
    });
  });

  it('should compute metrics from llm_call events', () => {
    const t1 = new Date('2025-01-01T10:00:00Z');
    const t2 = new Date('2025-01-01T10:00:02Z');

    Object.assign(mockSwrReturn, {
      data: {
        id: 'sess-1',
        agentName: 'Test',
        messages: [],
        traceEvents: [
          {
            id: 'ev-1',
            sessionId: 'sess-1',
            type: 'llm_call',
            timestamp: t1,
            data: { tokensIn: 100, tokensOut: 50 },
          },
          {
            id: 'ev-2',
            sessionId: 'sess-1',
            type: 'llm_call',
            timestamp: t2,
            data: { tokensIn: 200, tokensOut: 100 },
          },
        ],
      },
    });

    const { result } = renderHook(() => useSessionDetail('sess-1'));

    expect(result.current.metrics.llmCalls).toBe(2);
    expect(result.current.metrics.totalTokens).toBe(450);
    expect(result.current.metrics.latencyMs).toBe(2000);
  });

  it('should fall back to DB aggregates when traces are empty', () => {
    Object.assign(mockSwrReturn, {
      data: {
        id: 'sess-1',
        agentName: 'Test',
        messages: [],
        traceEvents: [],
        tokenCount: 500,
        estimatedCost: 0.025,
        createdAt: '2025-01-01T10:00:00Z',
        lastActivityAt: '2025-01-01T10:00:05Z',
      },
    });

    const { result } = renderHook(() => useSessionDetail('sess-1'));

    expect(result.current.metrics.totalTokens).toBe(500);
    expect(result.current.metrics.totalCost).toBe(0.025);
    expect(result.current.metrics.latencyMs).toBe(5000);
  });

  it('should expose refresh function that calls mutate', () => {
    const { result } = renderHook(() => useSessionDetail('sess-1'));

    result.current.refresh();
    expect(mockMutate).toHaveBeenCalled();
  });

  it('should build agent subtree with nested agent_enter/agent_exit', () => {
    const t0 = new Date('2025-01-01T10:00:00Z');

    Object.assign(mockSwrReturn, {
      data: {
        id: 'sess-1',
        agentName: 'Supervisor',
        messages: [],
        traceEvents: [
          {
            id: 'ev-1',
            sessionId: 'sess-1',
            type: 'agent_enter',
            agentName: 'Supervisor',
            timestamp: t0,
            data: { agentName: 'Supervisor', mode: 'supervisor' },
          },
          {
            id: 'ev-2',
            sessionId: 'sess-1',
            type: 'llm_call',
            agentName: 'Supervisor',
            timestamp: new Date('2025-01-01T10:00:01Z'),
            data: {
              agentName: 'Supervisor',
              model: 'claude-3.5-sonnet',
              tokensIn: 50,
              tokensOut: 20,
            },
          },
          {
            id: 'ev-3',
            sessionId: 'sess-1',
            type: 'agent_exit',
            agentName: 'Supervisor',
            timestamp: new Date('2025-01-01T10:00:02Z'),
            data: { agentName: 'Supervisor' },
          },
        ],
      },
    });

    const { result } = renderHook(() => useSessionDetail('sess-1', 'proj-1'));

    // Should have an agent node with nested llm_call child
    expect(result.current.tree.length).toBeGreaterThan(0);
    const agentNode = result.current.tree.find((n) => n.type === 'agent');
    expect(agentNode).toBeDefined();
    expect(agentNode?.label).toBe('Supervisor');
    expect(agentNode?.children.length).toBeGreaterThan(0);
  });

  it('fetches session detail with no-store cache mode', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          session: {
            id: 'sess-1',
            agentName: 'TestAgent',
            agent: { name: 'TestAgent' },
            messages: [],
            traceEvents: [],
          },
        }),
        { status: 200 },
      ),
    );

    renderHook(() => useSessionDetail('sess-1', 'proj-1'));

    const fetcher = vi.mocked(useSWR).mock.calls[0]?.[1] as
      | ((url: string) => Promise<unknown>)
      | undefined;

    expect(fetcher).toBeDefined();
    await fetcher?.('/api/runtime/sessions/sess-1?projectId=proj-1&includeTraces=false');

    expect(apiFetch).toHaveBeenCalledWith(
      '/api/runtime/sessions/sess-1?projectId=proj-1&includeTraces=false',
      { cache: 'no-store' },
    );
  });

  it('drops malformed session detail message and trace array items', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          session: {
            id: 'sess-1',
            agentName: 'TestAgent',
            messages: [
              null,
              'bad-message',
              {
                id: 'msg-1',
                role: 'user',
                content: 'Hello',
                timestamp: '2025-01-01T10:00:00Z',
              },
            ],
            traceEvents: [
              null,
              'bad-trace',
              {
                id: 'ev-1',
                sessionId: 'sess-1',
                type: 'llm_call',
                timestamp: '2025-01-01T10:00:01Z',
                data: { tokensIn: 2, tokensOut: 3 },
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );

    renderHook(() => useSessionDetail('sess-1', 'proj-1'));

    const fetcher = vi.mocked(useSWR).mock.calls[0]?.[1] as
      | ((url: string) => Promise<unknown>)
      | undefined;

    const detail = await fetcher?.('/api/runtime/sessions/sess-1?projectId=proj-1');

    expect(detail).toEqual(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            id: 'msg-1',
            content: 'Hello',
            timestamp: expect.any(Date),
          }),
        ],
        traceEvents: [
          expect.objectContaining({
            id: 'ev-1',
            sessionId: 'sess-1',
            type: 'llm_call',
          }),
        ],
      }),
    );
  });

  it('fetches traces in the background when session detail is loaded without traces', async () => {
    Object.assign(mockSwrReturn, {
      data: {
        id: 'sess-1',
        agentName: 'TestAgent',
        messages: [],
        traceEvents: [],
      },
    });

    vi.mocked(apiFetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          traces: [
            null,
            'bad-trace',
            {
              id: 'ev-1',
              sessionId: 'sess-1',
              type: 'agent_enter',
              timestamp: '2025-01-01T10:00:00Z',
              data: { agentName: 'TestAgent' },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const { result } = renderHook(() => useSessionDetail('sess-1', 'proj-1'));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/runtime/sessions/sess-1/traces?projectId=proj-1',
        {
          cache: 'no-store',
        },
      ),
    );

    await waitFor(() => expect(result.current.session?.traceEvents).toHaveLength(1));
  });

  it('keeps delayed background trace fetches alive after entering loading state', async () => {
    Object.assign(mockSwrReturn, {
      data: {
        id: 'sess-1',
        agentName: 'TestAgent',
        messages: [],
        traceEvents: [],
      },
    });

    let resolveTraceResponse!: (response: Response) => void;
    const traceResponsePromise = new Promise<Response>((resolve) => {
      resolveTraceResponse = resolve;
    });
    vi.mocked(apiFetch).mockReturnValueOnce(traceResponsePromise);

    const { result } = renderHook(() => useSessionDetail('sess-1', 'proj-1'));

    await waitFor(() => expect(result.current.session?.traceLoadStatus).toBe('loading'));

    await act(async () => {
      resolveTraceResponse(
        new Response(
          JSON.stringify({
            _meta: {
              source: 'clickhouse_platform_events',
              available_count: 31,
              loaded_count: 31,
            },
            traces: [
              {
                id: 'ev-1',
                sessionId: 'sess-1',
                type: 'voice_session_start',
                timestamp: '2026-05-12T21:20:49Z',
                data: { agentName: 'CignaRouter' },
              },
            ],
          }),
          { status: 200 },
        ),
      );
      await traceResponsePromise;
    });

    await waitFor(() => {
      expect(result.current.session?.traceLoadStatus).toBe('loaded');
      expect(result.current.session?.traceEvents).toHaveLength(1);
      expect(result.current.session?.traceMeta).toEqual(
        expect.objectContaining({
          source: 'clickhouse_platform_events',
          available_count: 31,
        }),
      );
    });
  });

  it('rehydrates the store when the same session id receives updated detail payload', async () => {
    Object.assign(mockSwrReturn, {
      data: {
        id: 'sess-1',
        agentName: 'TestAgent',
        messages: [],
        traceEvents: [],
      },
    });

    const { rerender } = renderHook(() => useSessionDetail('sess-1', 'proj-1'));

    await waitFor(() =>
      expect(vi.mocked(hydrateSessionStoreFromDetail)).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'sess-1', messages: [] }),
      ),
    );

    vi.mocked(hydrateSessionStoreFromDetail).mockClear();

    Object.assign(mockSwrReturn, {
      data: {
        id: 'sess-1',
        agentName: 'TestAgent',
        messages: [
          {
            id: 'msg-1',
            role: 'assistant',
            content: 'Updated',
            timestamp: new Date('2025-01-01T10:00:00Z'),
          },
        ],
        traceEvents: [],
      },
    });

    rerender();

    await waitFor(() =>
      expect(vi.mocked(hydrateSessionStoreFromDetail)).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'sess-1',
          messages: [
            expect.objectContaining({
              id: 'msg-1',
              content: 'Updated',
            }),
          ],
        }),
      ),
    );
  });

  it('hydrates the store with merged trace-synthesized messages', async () => {
    Object.assign(mockSwrReturn, {
      data: {
        id: 'sess-1',
        agentName: 'TestAgent',
        messages: [],
        traceEvents: [
          {
            id: 'ev-1',
            sessionId: 'sess-1',
            type: 'user_message',
            timestamp: new Date('2025-01-01T10:00:00Z'),
            data: { message: 'hello from trace' },
          },
        ],
      },
    });

    renderHook(() => useSessionDetail('sess-1', 'proj-1'));

    await waitFor(() =>
      expect(vi.mocked(hydrateSessionStoreFromDetail)).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'sess-1',
          messages: [
            expect.objectContaining({
              role: 'user',
              content: 'hello from trace',
              metadata: expect.objectContaining({ synthetic: true }),
            }),
          ],
        }),
      ),
    );
  });

  it('defers agent IR fetches until the IR tab is opened', async () => {
    Object.assign(mockSwrReturn, {
      data: {
        id: 'sess-1',
        agentName: 'TestAgent',
        messages: [],
        traceEvents: [],
      },
    });
    vi.mocked(apiFetch).mockResolvedValue(
      new Response(JSON.stringify({ traces: [] }), { status: 200 }),
    );

    const { rerender } = renderHook(() => useSessionDetail('sess-1', 'proj-1'));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/runtime/sessions/sess-1/traces?projectId=proj-1',
        {
          cache: 'no-store',
        },
      ),
    );
    expect(apiFetch).not.toHaveBeenCalledWith(
      '/api/runtime/sessions/sess-1/agent-spec?projectId=proj-1',
      expect.anything(),
    );

    vi.mocked(apiFetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          agent: {
            id: 'agent-1',
            name: 'TestAgent',
            dsl: 'AGENT TestAgent',
            ir: { mode: 'reasoning' },
          },
        }),
        {
          status: 200,
        },
      ),
    );
    Object.assign(mockObservatoryStore, { debugPanelTab: 'ir' });
    rerender();

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/runtime/sessions/sess-1/agent-spec?projectId=proj-1',
        {
          cache: 'no-store',
        },
      ),
    );
  });

  it('replays observatory traces when background traces are loaded for the same session', async () => {
    Object.assign(mockSwrReturn, {
      data: {
        id: 'sess-1',
        agentName: 'TestAgent',
        messages: [],
        traceEvents: [],
      },
    });

    vi.mocked(apiFetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          traces: [
            {
              id: 'ev-1',
              sessionId: 'sess-1',
              type: 'agent_enter',
              timestamp: '2025-01-01T10:00:00Z',
              data: { agentName: 'TestAgent' },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    renderHook(() => useSessionDetail('sess-1', 'proj-1'));

    await waitFor(() =>
      expect(vi.mocked(replayTraceEventsIntoObservatory)).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            id: 'ev-1',
            sessionId: 'sess-1',
          }),
        ],
        'sess-1',
      ),
    );
  });

  it('fetches full agent spec when session detail only includes a name-only agent object', async () => {
    Object.assign(mockSwrReturn, {
      data: {
        id: 'sess-1',
        agentName: 'TestAgent',
        agent: {
          name: 'TestAgent',
        },
        messages: [],
        traceEvents: [],
      },
    });
    vi.mocked(apiFetch).mockResolvedValue(
      new Response(JSON.stringify({ traces: [] }), { status: 200 }),
    );

    const { result, rerender } = renderHook(() => useSessionDetail('sess-1', 'proj-1'));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/runtime/sessions/sess-1/traces?projectId=proj-1',
        {
          cache: 'no-store',
        },
      ),
    );

    vi.mocked(apiFetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          agent: {
            id: 'agent-1',
            name: 'TestAgent',
            dsl: 'AGENT TestAgent',
            ir: { mode: 'reasoning' },
          },
        }),
        {
          status: 200,
        },
      ),
    );
    Object.assign(mockObservatoryStore, { debugPanelTab: 'ir' });
    rerender();

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/runtime/sessions/sess-1/agent-spec?projectId=proj-1',
        {
          cache: 'no-store',
        },
      ),
    );
    await waitFor(() =>
      expect(result.current.session?.agent).toEqual(
        expect.objectContaining({
          id: 'agent-1',
          dsl: 'AGENT TestAgent',
          ir: { mode: 'reasoning' },
        }),
      ),
    );
  });
});

// ===========================================================================
// useSessionList
// ===========================================================================

describe('useSessionList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mockSwrReturn, {
      data: undefined,
      error: undefined,
      isLoading: false,
      isValidating: false,
      mutate: mockMutate,
    });
  });

  it('should pass null key when not authenticated', () => {
    // Re-mock auth store to be unauthenticated
    vi.mocked(useSWR).mockImplementation((key: unknown) => {
      // Track what key was passed
      return mockSwrReturn as ReturnType<typeof useSWR>;
    });

    renderHook(() => useSessionList());

    // The hook should have been called (useSWR mock receives the key)
    expect(useSWR).toHaveBeenCalled();
  });

  it('should return empty sessions array when no data', () => {
    const { result } = renderHook(() => useSessionList());

    expect(result.current.sessions).toEqual([]);
    expect(result.current.sessionsByAgent).toEqual({});
  });

  it('should return sessions from response data', () => {
    const sessions = [
      {
        id: 'sess-1',
        agentId: 'a1',
        agentName: 'Booking',
        status: 'active',
        durationMs: 5000,
        messageCount: 3,
        traceEventCount: 10,
        tokenCount: 200,
        estimatedCost: 0.01,
        errorCount: 0,
        createdAt: '2025-01-01T10:00:00Z',
        lastActivityAt: '2025-01-01T10:01:00Z',
      },
    ];

    Object.assign(mockSwrReturn, {
      data: { sessions, total: 1 },
    });

    const { result } = renderHook(() => useSessionList());

    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.sessions[0].agentName).toBe('Booking');
  });

  it('should show all sessions including abandoned (voice calls end with abandoned disposition)', () => {
    const sessions = [
      {
        id: 'sess-1',
        agentId: 'a1',
        agentName: 'Booking',
        status: 'active',
        disposition: null,
        durationMs: 5000,
        messageCount: 3,
        traceEventCount: 10,
        tokenCount: 200,
        estimatedCost: 0.01,
        errorCount: 0,
        createdAt: '2025-01-01T10:00:00Z',
        lastActivityAt: '2025-01-01T10:01:00Z',
      },
      {
        id: 'sess-2',
        agentId: 'a1',
        agentName: 'Booking',
        status: 'ended',
        disposition: 'abandoned',
        durationMs: 2000,
        messageCount: 1,
        traceEventCount: 5,
        tokenCount: 100,
        estimatedCost: 0.005,
        errorCount: 0,
        createdAt: '2025-01-01T09:00:00Z',
        lastActivityAt: '2025-01-01T09:01:00Z',
      },
    ];

    Object.assign(mockSwrReturn, { data: { sessions } });

    const { result } = renderHook(() => useSessionList());

    // useSessionList does NOT filter — abandoned sessions are valid voice call history
    expect(result.current.sessions).toHaveLength(2);
    expect(result.current.sessions[0].id).toBe('sess-1');
    expect(result.current.sessions[1].id).toBe('sess-2');
  });

  it('should group sessions by agent name', () => {
    const sessions = [
      {
        id: 'sess-1',
        agentId: 'a1',
        agentName: 'Booking',
        status: 'active',
        durationMs: 5000,
        messageCount: 3,
        traceEventCount: 10,
        tokenCount: 200,
        estimatedCost: 0.01,
        errorCount: 0,
        createdAt: '2025-01-01T10:00:00Z',
        lastActivityAt: '2025-01-01T10:01:00Z',
      },
      {
        id: 'sess-2',
        agentId: 'a2',
        agentName: 'Support',
        status: 'active',
        durationMs: 3000,
        messageCount: 2,
        traceEventCount: 5,
        tokenCount: 100,
        estimatedCost: 0.005,
        errorCount: 0,
        createdAt: '2025-01-01T09:00:00Z',
        lastActivityAt: '2025-01-01T09:01:00Z',
      },
      {
        id: 'sess-3',
        agentId: 'a1',
        agentName: 'Booking',
        status: 'active',
        durationMs: 4000,
        messageCount: 4,
        traceEventCount: 8,
        tokenCount: 150,
        estimatedCost: 0.008,
        errorCount: 0,
        createdAt: '2025-01-01T08:00:00Z',
        lastActivityAt: '2025-01-01T08:05:00Z',
      },
    ];

    Object.assign(mockSwrReturn, { data: { sessions } });

    const { result } = renderHook(() => useSessionList());

    expect(Object.keys(result.current.sessionsByAgent)).toHaveLength(2);
    expect(result.current.sessionsByAgent['Booking']).toHaveLength(2);
    expect(result.current.sessionsByAgent['Support']).toHaveLength(1);
  });

  it('should sort sessions within agent groups by lastActivityAt desc', () => {
    const sessions = [
      {
        id: 'sess-old',
        agentId: 'a1',
        agentName: 'Booking',
        status: 'active',
        durationMs: 5000,
        messageCount: 3,
        traceEventCount: 10,
        tokenCount: 200,
        estimatedCost: 0.01,
        errorCount: 0,
        createdAt: '2025-01-01T08:00:00Z',
        lastActivityAt: '2025-01-01T08:05:00Z',
      },
      {
        id: 'sess-new',
        agentId: 'a1',
        agentName: 'Booking',
        status: 'active',
        durationMs: 5000,
        messageCount: 3,
        traceEventCount: 10,
        tokenCount: 200,
        estimatedCost: 0.01,
        errorCount: 0,
        createdAt: '2025-01-01T10:00:00Z',
        lastActivityAt: '2025-01-01T10:01:00Z',
      },
    ];

    Object.assign(mockSwrReturn, { data: { sessions } });

    const { result } = renderHook(() => useSessionList());

    expect(result.current.sessionsByAgent['Booking'][0].id).toBe('sess-new');
    expect(result.current.sessionsByAgent['Booking'][1].id).toBe('sess-old');
  });

  it('should include projectId in the SWR key', () => {
    renderHook(() => useSessionList('proj-123'));

    expect(useSWR).toHaveBeenCalledWith(
      expect.stringContaining('projectId=proj-123'),
      expect.any(Object),
    );
  });

  it('should poll the broad session list at the reduced cadence', () => {
    renderHook(() => useSessionList('proj-123'));

    const config = vi.mocked(useSWR).mock.calls.at(-1)?.[1] as {
      refreshInterval?: number;
    };

    expect(config.refreshInterval).toBe(15_000);
  });

  it('should return error string when SWR errors', () => {
    Object.assign(mockSwrReturn, { error: new Error('Server error') });

    const { result } = renderHook(() => useSessionList());

    expect(result.current.error).toBe('Error: Server error');
  });

  it('should return null error when no SWR error', () => {
    Object.assign(mockSwrReturn, { error: undefined });

    const { result } = renderHook(() => useSessionList());

    expect(result.current.error).toBeNull();
  });

  it('should expose isValidating state', () => {
    Object.assign(mockSwrReturn, { isValidating: true });

    const { result } = renderHook(() => useSessionList());

    expect(result.current.isValidating).toBe(true);
  });

  it('should expose refresh function', () => {
    const { result } = renderHook(() => useSessionList());

    result.current.refresh();
    expect(mockMutate).toHaveBeenCalled();
  });
});

// ===========================================================================
// useTraceExplorer
// ===========================================================================

describe('useTraceExplorer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mockSwrReturn, {
      data: undefined,
      error: undefined,
      isLoading: false,
      isValidating: false,
      mutate: mockMutate,
    });
  });

  it('normalizes missing or malformed trace rows to an empty list', () => {
    Object.assign(mockSwrReturn, {
      data: {
        traces: [
          null,
          { spanId: 'span-without-session' },
          { sessionId: 'session-without-span' },
          {
            traceId: 'trace-1',
            spanId: 'span-1',
            sessionId: 'session-1',
            agentName: null,
            type: null,
            status: 'ok',
            inputTokens: 'bad',
            outputTokens: null,
            totalTokens: 12,
            estimatedCost: undefined,
            eventCount: 2,
            errorCount: 0,
            warnings: { code: 'not-array' },
            operatorDiagnostics: null,
            preview: null,
          },
        ],
      },
    });

    const { result } = renderHook(() => useTraceExplorer('proj-1'));

    expect(result.current.traces).toEqual([
      expect.objectContaining({
        traceId: 'trace-1',
        spanId: 'span-1',
        sessionId: 'session-1',
        agentName: null,
        type: 'span',
        status: 'ok',
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 12,
        estimatedCost: 0,
        eventCount: 2,
        errorCount: 0,
        warnings: undefined,
        operatorDiagnostics: undefined,
        preview: '',
      }),
    ]);
    expect(result.current.total).toBe(1);
  });
});

// ===========================================================================
// useAgentSessions
// ===========================================================================

describe('useAgentSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mockSwrReturn, {
      data: undefined,
      error: undefined,
      isLoading: false,
      mutate: mockMutate,
    });
  });

  it('should pass null key when projectId is null', () => {
    renderHook(() => useAgentSessions(null, 'TestAgent'));

    expect(useSWR).toHaveBeenCalledWith(null, expect.any(Object));
  });

  it('should pass null key when not authenticated', () => {
    // This test uses the default mock (authenticated=true),
    // but exercises the projectId=null path
    renderHook(() => useAgentSessions(null, null));

    expect(useSWR).toHaveBeenCalledWith(null, expect.any(Object));
  });

  it('should return empty sessions when no data', () => {
    const { result } = renderHook(() => useAgentSessions('proj-1', 'TestAgent'));

    expect(result.current.sessions).toEqual([]);
    // hasFetched is true only when not loading AND data !== undefined
    // With no data returned, data is undefined, so hasFetched should be false
    expect(result.current.hasFetched).toBe(false);
  });

  it('should return isLoading true during fetch', () => {
    Object.assign(mockSwrReturn, { isLoading: true, data: undefined });

    const { result } = renderHook(() => useAgentSessions('proj-1', 'TestAgent'));

    expect(result.current.isLoading).toBe(true);
    expect(result.current.hasFetched).toBe(false);
  });

  it('should filter sessions by agent name (normalized exact match)', () => {
    const sessions = [
      {
        id: 'sess-1',
        agentId: 'a1',
        agentName: 'Booking_Agent',
        status: 'active',
        durationMs: 5000,
        messageCount: 3,
        traceEventCount: 10,
        tokenCount: 200,
        estimatedCost: 0.01,
        errorCount: 0,
        createdAt: '2025-01-01T10:00:00Z',
        lastActivityAt: '2025-01-01T10:01:00Z',
      },
      {
        id: 'sess-2',
        agentId: 'a2',
        agentName: 'Support_Agent',
        status: 'active',
        durationMs: 3000,
        messageCount: 2,
        traceEventCount: 5,
        tokenCount: 100,
        estimatedCost: 0.005,
        errorCount: 0,
        createdAt: '2025-01-01T09:00:00Z',
        lastActivityAt: '2025-01-01T09:01:00Z',
      },
    ];

    Object.assign(mockSwrReturn, { data: { sessions } });

    // agentNameMatches normalizes by lowercasing and stripping underscores/spaces/hyphens,
    // then does exact match: normalize('Booking_Agent') === normalize('booking-agent') === 'bookingagent'
    const { result } = renderHook(() => useAgentSessions('proj-1', 'booking-agent'));

    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.sessions[0].agentName).toBe('Booking_Agent');
  });

  it('should hide archived sessions and keep ended history visible', () => {
    const sessions = [
      {
        id: 'sess-1',
        agentId: 'a1',
        agentName: 'TestAgent',
        status: 'active',
        durationMs: 5000,
        messageCount: 3,
        traceEventCount: 10,
        tokenCount: 200,
        estimatedCost: 0.01,
        errorCount: 0,
        createdAt: '2025-01-01T10:00:00Z',
        lastActivityAt: '2025-01-01T10:01:00Z',
      },
      {
        id: 'sess-2',
        agentId: 'a1',
        agentName: 'TestAgent',
        status: 'archived',
        durationMs: 2000,
        messageCount: 1,
        traceEventCount: 5,
        tokenCount: 100,
        estimatedCost: 0.005,
        errorCount: 0,
        createdAt: '2025-01-01T09:00:00Z',
        lastActivityAt: '2025-01-01T09:01:00Z',
      },
      {
        id: 'sess-3',
        agentId: 'a1',
        agentName: 'TestAgent',
        status: 'abandoned',
        durationMs: 2500,
        messageCount: 2,
        traceEventCount: 6,
        tokenCount: 120,
        estimatedCost: 0.006,
        errorCount: 0,
        createdAt: '2025-01-01T08:00:00Z',
        lastActivityAt: '2025-01-01T08:05:00Z',
      },
      {
        id: 'sess-4',
        agentId: 'a1',
        agentName: 'TestAgent',
        status: 'completed',
        durationMs: 4000,
        messageCount: 4,
        traceEventCount: 8,
        tokenCount: 150,
        estimatedCost: 0.008,
        errorCount: 0,
        createdAt: '2025-01-01T07:00:00Z',
        lastActivityAt: '2025-01-01T07:05:00Z',
      },
      {
        id: 'sess-5',
        agentId: 'a1',
        agentName: 'TestAgent',
        status: 'escalated',
        durationMs: 3000,
        messageCount: 2,
        traceEventCount: 5,
        tokenCount: 100,
        estimatedCost: 0.005,
        errorCount: 0,
        createdAt: '2025-01-01T06:00:00Z',
        lastActivityAt: '2025-01-01T06:01:00Z',
      },
    ];

    Object.assign(mockSwrReturn, { data: { sessions } });

    const { result } = renderHook(() => useAgentSessions('proj-1', 'TestAgent'));

    expect(result.current.sessions).toHaveLength(4);
    expect(result.current.sessions.map((session) => session.id)).toEqual([
      'sess-1',
      'sess-3',
      'sess-4',
      'sess-5',
    ]);
  });

  it('should sort sessions by lastActivityAt desc', () => {
    const sessions = [
      {
        id: 'sess-old',
        agentId: 'a1',
        agentName: 'TestAgent',
        status: 'active',
        durationMs: 5000,
        messageCount: 3,
        traceEventCount: 10,
        tokenCount: 200,
        estimatedCost: 0.01,
        errorCount: 0,
        createdAt: '2025-01-01T08:00:00Z',
        lastActivityAt: '2025-01-01T08:05:00Z',
      },
      {
        id: 'sess-new',
        agentId: 'a1',
        agentName: 'TestAgent',
        status: 'active',
        durationMs: 5000,
        messageCount: 3,
        traceEventCount: 10,
        tokenCount: 200,
        estimatedCost: 0.01,
        errorCount: 0,
        createdAt: '2025-01-01T10:00:00Z',
        lastActivityAt: '2025-01-01T10:01:00Z',
      },
    ];

    Object.assign(mockSwrReturn, { data: { sessions } });

    const { result } = renderHook(() => useAgentSessions('proj-1', 'TestAgent'));

    expect(result.current.sessions[0].id).toBe('sess-new');
    expect(result.current.sessions[1].id).toBe('sess-old');
  });

  it('should return all alive sessions when agentName is null', () => {
    const sessions = [
      {
        id: 'sess-1',
        agentId: 'a1',
        agentName: 'Booking',
        status: 'active',
        durationMs: 5000,
        messageCount: 3,
        traceEventCount: 10,
        tokenCount: 200,
        estimatedCost: 0.01,
        errorCount: 0,
        createdAt: '2025-01-01T10:00:00Z',
        lastActivityAt: '2025-01-01T10:01:00Z',
      },
      {
        id: 'sess-2',
        agentId: 'a2',
        agentName: 'Support',
        status: 'active',
        durationMs: 3000,
        messageCount: 2,
        traceEventCount: 5,
        tokenCount: 100,
        estimatedCost: 0.005,
        errorCount: 0,
        createdAt: '2025-01-01T09:00:00Z',
        lastActivityAt: '2025-01-01T09:01:00Z',
      },
    ];

    Object.assign(mockSwrReturn, { data: { sessions } });

    const { result } = renderHook(() => useAgentSessions('proj-1', null));

    expect(result.current.sessions).toHaveLength(2);
  });

  it('should include sessions with no status', () => {
    const sessions = [
      {
        id: 'sess-1',
        agentId: 'a1',
        agentName: 'TestAgent',
        status: '',
        durationMs: 5000,
        messageCount: 3,
        traceEventCount: 10,
        tokenCount: 200,
        estimatedCost: 0.01,
        errorCount: 0,
        createdAt: '2025-01-01T10:00:00Z',
        lastActivityAt: '2025-01-01T10:01:00Z',
      },
    ];

    Object.assign(mockSwrReturn, { data: { sessions } });

    const { result } = renderHook(() => useAgentSessions('proj-1', 'TestAgent'));

    expect(result.current.sessions).toHaveLength(1);
  });

  it('should return error string', () => {
    Object.assign(mockSwrReturn, { error: 'Failed to fetch' });

    const { result } = renderHook(() => useAgentSessions('proj-1', 'TestAgent'));

    expect(result.current.error).toBe('Failed to fetch');
  });

  it('should stop polling after an empty fetch when there is no current session', () => {
    renderHook(() => useAgentSessions('proj-1', 'TestAgent'));

    const config = vi.mocked(useSWR).mock.calls.at(-1)?.[1] as {
      refreshInterval?: (latestData?: { sessions: unknown[] }) => number;
    };

    expect(config.refreshInterval?.({ sessions: [] })).toBe(0);
  });

  it('should keep polling while the current session is not yet in the list', () => {
    Object.assign(mockSessionStore, { sessionId: 'sess-current' });

    renderHook(() => useAgentSessions('proj-1', 'TestAgent'));

    const config = vi.mocked(useSWR).mock.calls.at(-1)?.[1] as {
      refreshInterval?: (latestData?: {
        sessions: Array<{ id: string; status: string }>;
      }) => number;
    };

    expect(config.refreshInterval?.({ sessions: [] })).toBe(10_000);
  });

  it('should expose refresh function', () => {
    const { result } = renderHook(() => useAgentSessions('proj-1', 'TestAgent'));

    result.current.refresh();
    expect(mockMutate).toHaveBeenCalled();
  });

  it('should match agent name case-insensitively', () => {
    const sessions = [
      {
        id: 'sess-1',
        agentId: 'a1',
        agentName: 'Authentication_Agent',
        status: 'active',
        durationMs: 5000,
        messageCount: 3,
        traceEventCount: 10,
        tokenCount: 200,
        estimatedCost: 0.01,
        errorCount: 0,
        createdAt: '2025-01-01T10:00:00Z',
        lastActivityAt: '2025-01-01T10:01:00Z',
      },
    ];

    Object.assign(mockSwrReturn, { data: { sessions } });

    // Normalized exact match: 'AUTHENTICATION_AGENT' -> 'authenticationagent' === 'authenticationagent'
    const { result } = renderHook(() => useAgentSessions('proj-1', 'AUTHENTICATION_AGENT'));

    expect(result.current.sessions).toHaveLength(1);
  });
});
