import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArchSession } from '@agent-platform/arch-ai/types';
import { useArchChat } from '@/lib/arch-ai/ui/hook';
import { useArchUIStore } from '@/lib/arch-ai/ui/store';
import { useArchAIStore } from '@/lib/arch-ai/store/arch-ai-store';
import { useAuthStore } from '@/store/auth-store';

const { createSessionMock, fetchCurrentSessionMock, postMessageMock } = vi.hoisted(() => ({
  createSessionMock: vi.fn(),
  fetchCurrentSessionMock: vi.fn(),
  postMessageMock: vi.fn(),
}));

vi.mock('@/lib/arch-ai/ui/session-api', () => ({
  postMessage: (...args: unknown[]) => postMessageMock(...args),
  fetchCurrentSession: (...args: unknown[]) => fetchCurrentSessionMock(...args),
  createSession: (...args: unknown[]) => createSessionMock(...args),
  archiveSession: vi.fn(),
  cancelTurn: vi.fn(),
}));

function makeInProjectSession(
  metadata?: Partial<ArchSession['metadata']>,
  id = 'sess-in-project-1',
): ArchSession {
  return {
    id,
    tenantId: 'tenant-1',
    userId: 'user-1',
    state: 'IDLE',
    metadata: {
      phase: 'IN_PROJECT',
      mode: 'IN_PROJECT',
      projectId: 'proj-123',
      specification: {
        version: 1,
        projectName: '',
        description: null,
        channels: [],
        language: 'English',
        uploadedFiles: [],
        conversationNotes: [],
      },
      pendingInteraction: null,
      pendingMutation: null,
      activeSpecialist: null,
      topology: null,
      messages: [],
      files: {},
      ...metadata,
    },
    createdAt: '2026-04-20T08:00:00.000Z',
    updatedAt: '2026-04-20T08:00:00.000Z',
  } as ArchSession;
}

function makeOnboardingSession(metadata?: Partial<ArchSession['metadata']>): ArchSession {
  return {
    ...makeInProjectSession(metadata, 'sess-onboarding-1'),
    metadata: {
      ...makeInProjectSession(metadata).metadata,
      mode: 'ONBOARDING',
      phase: 'INTERVIEW',
      projectId: undefined,
      ...metadata,
    },
  } as ArchSession;
}

function makePendingMutationSession(): ArchSession {
  return {
    ...makeInProjectSession(),
    state: 'ACTIVE',
    metadata: {
      ...makeInProjectSession().metadata,
      phase: 'INTERVIEW',
      pendingInteraction: {
        kind: 'widget',
        id: 'tool-confirm-1',
        payload: {
          widgetType: 'Confirmation',
          question: 'Ready to apply these changes?',
        },
        createdAt: '2026-04-20T08:01:00.000Z',
      },
      pendingMutation: {
        tool: 'apply_modification',
        target: 'LeadIntake',
        scope: 'SMALL',
        isNew: false,
        before: 'AGENT: LeadIntake\nGOAL: "Close qualified leads fast"',
        after: 'AGENT: LeadIntake\nGOAL: "Book qualified demos fast"',
        changeSummary: 'Update the LeadIntake goal',
        reviewStatus: 'pending',
      },
      messages: [
        {
          id: 'user-msg-1',
          role: 'user',
          content: 'Update LeadIntake and ask for confirmation before applying.',
          timestamp: '2026-04-20T08:00:55.000Z',
        },
        {
          id: 'assistant-msg-1',
          role: 'assistant',
          content: 'Here is the proposal. Ready to apply these changes?',
          timestamp: '2026-04-20T08:01:00.000Z',
        },
      ],
    },
  } as ArchSession;
}

function makeAnsweredMutationSession(): ArchSession {
  return {
    ...makeInProjectSession(),
    metadata: {
      ...makeInProjectSession().metadata,
      pendingInteraction: null,
      messages: [
        {
          id: 'assistant-msg-answered-1',
          role: 'assistant',
          content: 'Ready to apply these changes?',
          timestamp: '2026-04-20T08:01:00.000Z',
          toolCalls: [
            {
              toolCallId: 'tool-confirm-1',
              toolName: 'ask_user',
              input: {
                widgetType: 'Confirmation',
                question: 'Ready to apply these changes?',
              },
              result: true,
            },
          ],
        },
      ],
    },
  } as ArchSession;
}

function makePendingGateSession(): ArchSession {
  return {
    ...makeInProjectSession(),
    state: 'ACTIVE',
    metadata: {
      ...makeInProjectSession().metadata,
      pendingInteraction: {
        kind: 'widget',
        id: 'gate-tool-generation-1',
        payload: {
          widgetType: 'GateRequest',
          gateType: 'tool_generation',
          title: 'Tool Generation',
          question: 'Generate the recommended tools now?',
          actions: [
            { value: 'accept', label: 'Generate Tools', tone: 'primary' },
            { value: 'modify', label: 'Adjust Tools', requiresFeedback: true },
            { value: 'reject', label: 'Skip Tools', tone: 'danger' },
          ],
        },
        createdAt: '2026-04-20T08:02:00.000Z',
      },
    },
  } as ArchSession;
}

function makeTurnEventFrame(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function makeInteractiveToolResponse(): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          makeTurnEventFrame('interactive_tool', {
            eventId: 'evt-interactive-1',
            schemaVersion: 2,
            sessionId: 'sess-in-project-1',
            turnId: 'turn-1',
            seq: 0,
            timestamp: Date.now(),
            tool: 'ask_user',
            toolCallId: 'tool-confirm-1',
            kind: 'tool',
            payload: {
              widgetType: 'Confirmation',
              question: 'Ready to apply these changes?',
            },
          }),
        ),
      );
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function makeReplayInteractiveToolResponse(): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          makeTurnEventFrame('interactive_tool', {
            eventId: 'evt-interactive-replay-1',
            schemaVersion: 2,
            sessionId: 'sess-in-project-1',
            turnId: 'turn-replay-widget-1',
            seq: 1,
            replaySeq: 1,
            timestamp: Date.now(),
            tool: 'ask_user',
            toolCallId: 'tool-confirm-1',
            kind: 'tool',
            payload: {
              widgetType: 'Confirmation',
              question: 'Ready to apply these changes?',
            },
          }),
        ),
      );
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function makeOutOfOrderHealthStreamResponse(): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          makeTurnEventFrame('turn_started', {
            eventId: 'evt-turn-start',
            schemaVersion: 2,
            sessionId: 'sess-in-project-1',
            turnId: 'turn-health-1',
            seq: 0,
            timestamp: Date.now(),
            userMessageId: 'user-health-1',
            specialist: 'diagnostician',
          }),
        ),
      );
      controller.enqueue(
        encoder.encode(
          makeTurnEventFrame('text_delta', {
            eventId: 'evt-text-5',
            schemaVersion: 2,
            sessionId: 'sess-in-project-1',
            turnId: 'turn-health-1',
            seq: 5,
            timestamp: Date.now(),
            delta: 'Health check complete.',
            specialist: 'diagnostician',
          }),
        ),
      );
      controller.enqueue(
        encoder.encode(
          makeTurnEventFrame('artifact_updated', {
            eventId: 'evt-health-artifact',
            schemaVersion: 2,
            sessionId: 'sess-in-project-1',
            turnId: 'turn-health-1',
            seq: 3,
            replaySeq: 4,
            timestamp: Date.now(),
            update: {
              artifact: 'health',
              payload: {
                overall: 'Critical',
                agents: [],
                summary: '1 agent checked',
                semanticFindings: [],
                crossAgentFindings: [],
                score: {
                  percent: 42,
                  totalAgents: 1,
                  healthyAgents: 0,
                  warningAgents: 0,
                  failingAgents: 1,
                  totalChecks: 6,
                  passedChecks: 3,
                  warningChecks: 2,
                  failedChecks: 1,
                  projectErrors: 0,
                  projectWarnings: 4,
                  projectInfos: 0,
                  blockingFindings: 1,
                  deployReady: false,
                },
              },
            },
          }),
        ),
      );
      controller.enqueue(
        encoder.encode(
          makeTurnEventFrame('turn_ended', {
            eventId: 'evt-turn-ended',
            schemaVersion: 2,
            sessionId: 'sess-in-project-1',
            turnId: 'turn-health-1',
            seq: 6,
            timestamp: Date.now(),
            reason: 'natural',
            suggestions: [],
          }),
        ),
      );
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function makeTopologyReplayResponse(): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          makeTurnEventFrame('artifact_updated', {
            type: 'artifact_updated',
            eventId: 'evt-artifact-1',
            schemaVersion: 2,
            sessionId: 'sess-in-project-1',
            turnId: 'turn-replay-1',
            seq: 1,
            replaySeq: 1,
            timestamp: Date.now(),
            update: {
              artifact: 'topology',
              payload: {
                agents: [{ name: 'LeadIntake', mode: 'reasoning', isEntryPoint: false, tools: [] }],
                edges: [],
                agentCount: 1,
                edgeCount: 0,
              },
            },
          }),
        ),
      );
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('useArchChat v4 session scope', () => {
  beforeEach(() => {
    createSessionMock.mockReset();
    fetchCurrentSessionMock.mockReset();
    fetchCurrentSessionMock.mockResolvedValue({ session: null, resume: null });
    postMessageMock.mockReset();
    postMessageMock.mockResolvedValue(new Response('', { status: 200 }));
    useArchUIStore.getState().clear();
    useArchAIStore.getState().reset();
    useAuthStore.getState().clearAuth();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/arch-ai/sessions/sess-in-project-1/events')) {
          return new Response(null, { status: 409 });
        }

        return new Response(null, { status: 200 });
      }),
    );
  });

  it('preserves IN_PROJECT scope when reconnect falls back to /sessions/current', async () => {
    const { unmount } = renderHook(() => useArchChat());

    act(() => {
      useArchUIStore.setState({
        session: makeInProjectSession() as never,
        phase: 'IN_PROJECT',
      });
    });

    await waitFor(() => {
      expect(fetchCurrentSessionMock).toHaveBeenCalledWith('IN_PROJECT', 'proj-123', undefined);
    });

    unmount();
  });

  it('preserves agent editor thread scope when reconnect falls back to /sessions/current', async () => {
    const { unmount } = renderHook(() => useArchChat());

    act(() => {
      useArchUIStore.setState({
        session: makeInProjectSession({
          surface: 'agent-editor',
          agentName: 'BookingRequestAgent',
          threadId: 'thread-editor-1',
        }) as never,
        phase: 'IN_PROJECT',
      });
    });

    await waitFor(() => {
      expect(fetchCurrentSessionMock).toHaveBeenCalledWith('IN_PROJECT', 'proj-123', {
        surface: 'agent-editor',
        agentName: 'BookingRequestAgent',
        threadId: 'thread-editor-1',
      });
    });

    unmount();
  });

  it('starts a fresh onboarding session without a client-generated thread id', async () => {
    createSessionMock.mockResolvedValueOnce(
      makeOnboardingSession({ threadId: 'thread-server-generated' }),
    );

    const { result, unmount } = renderHook(() => useArchChat());

    await act(async () => {
      await result.current.startFresh();
    });

    expect(createSessionMock).toHaveBeenCalledWith({ mode: 'ONBOARDING', force: true });
    expect(useArchUIStore.getState().session?.metadata.threadId).toBe('thread-server-generated');

    unmount();
  });

  it('refreshes an agent editor DSL session with its current thread scope', async () => {
    fetchCurrentSessionMock.mockResolvedValueOnce({
      session: makeInProjectSession({
        surface: 'agent-editor',
        agentName: 'BookingRequestAgent',
        threadId: 'thread-editor-1',
      }),
      resume: null,
    });
    const { result, unmount } = renderHook(() => useArchChat());

    act(() => {
      useArchUIStore.setState({
        session: makeInProjectSession({
          surface: 'agent-editor',
          agentName: 'BookingRequestAgent',
          threadId: 'thread-editor-1',
        }) as never,
        phase: 'IN_PROJECT',
      });
      fetchCurrentSessionMock.mockClear();
    });

    await act(async () => {
      await result.current.refreshSession('IN_PROJECT', 'proj-123');
    });

    expect(fetchCurrentSessionMock).toHaveBeenCalledWith('IN_PROJECT', 'proj-123', {
      surface: 'agent-editor',
      agentName: 'BookingRequestAgent',
      threadId: 'thread-editor-1',
    });

    unmount();
  });

  it('reconciles a pending in-project confirmation from the fresh session snapshot when the live diff artifact is missing', async () => {
    postMessageMock.mockResolvedValueOnce(makeInteractiveToolResponse());
    fetchCurrentSessionMock.mockResolvedValueOnce({
      session: makePendingMutationSession(),
      resume: {
        status: 'resume_available',
        reason: 'pending',
        pending: {
          kind: 'widget',
          interaction: makePendingMutationSession().metadata.pendingInteraction!,
        },
      },
    });

    const { result, unmount } = renderHook(() => useArchChat());

    act(() => {
      useArchUIStore.setState({
        session: makeInProjectSession() as never,
        phase: 'INTERVIEW',
      });
    });

    await act(async () => {
      await result.current.send('Update LeadIntake and ask for confirmation before applying.');
    });

    await waitFor(() => {
      expect(fetchCurrentSessionMock).toHaveBeenCalledWith('IN_PROJECT', 'proj-123', undefined);
    });

    const diffTab = useArchAIStore.getState().artifactTabs.find((tab) => tab.type === 'diff');
    expect(diffTab?.label).toBe('Changes');
    expect(useArchAIStore.getState().overlayState).toBe('artifacts');
    expect(useArchUIStore.getState().state).toBe('widget_pending');
    expect(
      (useArchUIStore.getState().session?.metadata.pendingMutation as { target?: string } | null)
        ?.target,
    ).toBe('LeadIntake');

    unmount();
  });

  it('restores pending gate request widgets with the gate response tool name', async () => {
    const pendingGateSession = makePendingGateSession();
    fetchCurrentSessionMock.mockResolvedValueOnce({
      session: pendingGateSession,
      resume: {
        status: 'resume_available',
        reason: 'pending',
        pending: {
          kind: 'widget',
          interaction: pendingGateSession.metadata.pendingInteraction!,
        },
      },
    });

    const { unmount } = renderHook(() => useArchChat());

    act(() => {
      useArchUIStore.setState({
        session: makeInProjectSession() as never,
        phase: 'INTERVIEW',
      });
    });

    await waitFor(() => {
      expect(useArchUIStore.getState().state).toBe('widget_pending');
    });

    expect(useArchUIStore.getState().messages.at(-1)?.toolCall).toMatchObject({
      toolCallId: 'gate-tool-generation-1',
      toolName: 'gate_request',
      input: {
        widgetType: 'GateRequest',
        gateType: 'tool_generation',
      },
    });

    unmount();
  });

  it('replays durable topology artifacts on cold session load instead of forcing snapshot fallback', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/arch-ai/sessions/sess-in-project-1/events?lastSeenSeq=0')) {
          return makeTopologyReplayResponse();
        }
        if (url.includes('/api/arch-ai/sessions/sess-in-project-1/events')) {
          return new Response(null, { status: 409 });
        }

        return new Response(null, { status: 200 });
      }),
    );

    const { unmount } = renderHook(() => useArchChat());

    act(() => {
      useArchUIStore.setState({
        session: makeInProjectSession() as never,
        phase: 'INTERVIEW',
      });
    });

    await waitFor(() => {
      const topologyTab = useArchAIStore
        .getState()
        .artifactTabs.find((tab) => tab.type === 'topology');
      expect(topologyTab?.label).toBe('Topology');
    });

    expect(useArchAIStore.getState().overlayState).toBe('artifacts');

    unmount();
  });

  it('preserves live artifact updates when a durable event arrives after higher text seq values', async () => {
    postMessageMock.mockResolvedValueOnce(makeOutOfOrderHealthStreamResponse());

    const { result, unmount } = renderHook(() => useArchChat());

    act(() => {
      useArchUIStore.setState({
        session: makeInProjectSession() as never,
        phase: 'INTERVIEW',
      });
    });

    await act(async () => {
      await result.current.send('Run a health check on all agents.');
    });

    await waitFor(() => {
      const healthTab = useArchAIStore.getState().artifactTabs.find((tab) => tab.type === 'health');
      expect(healthTab?.label).toBe('Health');
    });

    expect(useArchAIStore.getState().overlayState).toBe('artifacts');

    unmount();
  });

  it('preserves the replay cursor across same-session snapshot refreshes', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/arch-ai/sessions/sess-in-project-1/events?lastSeenSeq=0')) {
        return makeReplayInteractiveToolResponse();
      }
      if (url.includes('/api/arch-ai/sessions/sess-in-project-1/events?lastSeenSeq=1')) {
        return new Response(null, { status: 200 });
      }

      return new Response(null, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    fetchCurrentSessionMock.mockResolvedValueOnce({
      session: makeAnsweredMutationSession(),
      resume: null,
    });

    const { result, unmount } = renderHook(() => useArchChat());

    act(() => {
      useArchUIStore.setState({
        session: makeInProjectSession() as never,
        phase: 'INTERVIEW',
      });
    });

    await waitFor(() => {
      expect(useArchUIStore.getState().state).toBe('widget_pending');
    });

    await act(async () => {
      await result.current.refreshSession('IN_PROJECT', 'proj-123');
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('lastSeenSeq=1'),
        expect.any(Object),
      );
    });

    expect(useArchUIStore.getState().state).toBe('idle');
    expect(
      useArchUIStore
        .getState()
        .messages.filter((message) => message.toolCall?.toolCallId === 'tool-confirm-1'),
    ).toHaveLength(1);

    unmount();
  });
});
