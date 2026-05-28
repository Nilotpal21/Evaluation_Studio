import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArchSession } from '@agent-platform/arch-ai/types';
import { useArchChat } from '@/lib/arch-ai/ui/hook';
import { useArchUIStore } from '@/lib/arch-ai/ui/store';
import { useArchAIStore } from '@/lib/arch-ai/store/arch-ai-store';
import { useAuthStore } from '@/store/auth-store';

const { fetchCurrentSessionMock, postMessageMock } = vi.hoisted(() => ({
  fetchCurrentSessionMock: vi.fn(),
  postMessageMock: vi.fn(),
}));

vi.mock('@/lib/arch-ai/ui/session-api', () => ({
  postMessage: (...args: unknown[]) => postMessageMock(...args),
  fetchCurrentSession: (...args: unknown[]) => fetchCurrentSessionMock(...args),
  createSession: vi.fn(),
  archiveSession: vi.fn(),
  cancelTurn: vi.fn(),
}));

function makeSession(): ArchSession {
  return {
    id: 'sess-ui-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    state: 'IDLE',
    metadata: {
      phase: 'INTERVIEW',
      mode: 'ONBOARDING',
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
    },
    createdAt: '2026-04-20T08:00:00.000Z',
    updatedAt: '2026-04-20T08:00:00.000Z',
  } as ArchSession;
}

describe('useArchChat v4 send behavior', () => {
  beforeEach(() => {
    fetchCurrentSessionMock.mockReset();
    fetchCurrentSessionMock.mockResolvedValue({ session: null, resume: null });
    postMessageMock.mockReset();
    postMessageMock.mockResolvedValue(new Response('', { status: 200 }));
    useArchUIStore.getState().clear();
    useArchAIStore.getState().reset();
    useAuthStore.getState().clearAuth();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
  });

  it('uses the latest store session when a stale send callback fires after session creation', async () => {
    const { result, unmount } = renderHook(() => useArchChat());
    const staleSend = result.current.send;

    act(() => {
      useArchUIStore.setState({
        session: makeSession() as never,
        phase: 'INTERVIEW',
      });
    });

    await act(async () => {
      await staleSend('Build an e-commerce support agent');
    });

    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-ui-1',
        type: 'message',
        text: 'Build an e-commerce support agent',
      }),
    );
    expect(useArchUIStore.getState().messages.at(-1)?.content).toBe(
      'Build an e-commerce support agent',
    );

    unmount();
  });

  it('restores blueprint and topology tabs from session metadata on reload', async () => {
    const blueprintSession = {
      ...makeSession(),
      metadata: {
        ...makeSession().metadata,
        phase: 'BLUEPRINT',
        blueprintStage: 'draft_ready',
        topologyApproved: false,
        specification: {
          ...makeSession().metadata.specification,
          projectName: 'Claims Concierge',
          description: 'Insurance claim intake and triage.',
          channels: ['web_chat'],
        },
        topology: {
          entryPoint: 'ClaimsRouter',
          agents: [
            {
              name: 'ClaimsRouter',
              role: 'Entry triage',
              executionMode: 'hybrid',
              description: 'Routes claim requests.',
            },
            {
              name: 'PolicySpecialist',
              role: 'Policy answer specialist',
              executionMode: 'reasoning',
              description: 'Answers policy questions.',
            },
          ],
          edges: [
            {
              from: 'ClaimsRouter',
              to: 'PolicySpecialist',
              type: 'delegate',
              condition: 'issue_type == "policy"',
            },
          ],
        },
        draftTopology: {
          entryPoint: 'ClaimsRouter',
          agents: [
            {
              name: 'ClaimsRouter',
              role: 'Entry triage',
              executionMode: 'hybrid',
              description: 'Routes claim requests.',
            },
            {
              name: 'PolicySpecialist',
              role: 'Policy answer specialist',
              executionMode: 'reasoning',
              description: 'Answers policy questions.',
            },
          ],
          edges: [
            {
              from: 'ClaimsRouter',
              to: 'PolicySpecialist',
              type: 'delegate',
              condition: 'issue_type == "policy"',
            },
          ],
        },
      },
    } as ArchSession;
    fetchCurrentSessionMock.mockResolvedValue({
      session: blueprintSession,
      resume: {
        phase: 'BLUEPRINT',
        state: 'IDLE',
        canSendMessage: true,
        pending: null,
        nextAction: {
          type: 'continue_phase',
          phase: 'BLUEPRINT',
          reason: 'Review the draft blueprint.',
        },
        interruption: {
          wasInterrupted: false,
          lastDurableCheckpoint: 'phase_transition',
          canContinueByMessage: true,
        },
        artifacts: {
          topology: {
            exists: true,
            approved: false,
            locked: false,
            stage: 'draft_ready',
            agentCount: 2,
            edgeCount: 1,
            entryPoint: 'ClaimsRouter',
          },
          files: { count: 0, names: [], mockFileCount: 0, mockFilePaths: [] },
          buildProgress: null,
          pendingMutation: null,
          pendingPlan: null,
          integrationDraft: null,
        },
      },
    });

    const { result, unmount } = renderHook(() => useArchChat());

    await act(async () => {
      await result.current.loadSession('ONBOARDING');
    });

    const tabs = useArchAIStore.getState().artifactTabs;
    expect(tabs.some((tab) => tab.type === 'topology')).toBe(true);
    const blueprintTab = tabs.find((tab) => tab.type === 'blueprint-document');
    expect(blueprintTab).toBeDefined();
    expect(blueprintTab?.data).toMatchObject({
      status: 'draft',
      agentCount: 2,
      handoffCount: 1,
    });
    expect(useArchAIStore.getState().activeTabId).toBe(blueprintTab?.id);

    unmount();
  });

  it('shows widget submissions inline on the widget instead of appending a duplicate user bubble', async () => {
    useArchUIStore.setState({
      session: {
        ...makeSession(),
        metadata: {
          ...makeSession().metadata,
          pendingInteraction: {
            kind: 'widget',
            id: 'tool-1',
            payload: {
              widgetType: 'TextInput',
              question: 'What should the agent handle?',
              multiline: true,
            },
            createdAt: '2026-04-20T08:00:01.000Z',
          },
        },
      } as never,
      state: 'widget_pending',
      messages: [
        {
          id: 'assistant-widget-1',
          role: 'assistant',
          content: '',
          timestamp: '2026-04-20T08:00:01.000Z',
          toolCall: {
            toolCallId: 'tool-1',
            toolName: 'ask_user',
            input: {
              widgetType: 'TextInput',
              question: 'What should the agent handle?',
              multiline: true,
            },
          },
        },
      ] as never,
    });

    const { result, unmount } = renderHook(() => useArchChat());

    await act(async () => {
      await result.current.sendToolAnswer(
        'tool-1',
        'Handle order status, returns, shipping, and escalation flows.',
      );
    });

    const messages = useArchUIStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('assistant');
    expect(messages[0]?.toolCall?.result).toBe(
      'Handle order status, returns, shipping, and escalation flows.',
    );

    unmount();
  });

  it('ignores duplicate BuildComplete create answers while a stream request is in flight', async () => {
    let resolvePost: (response: Response) => void = () => {};
    postMessageMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        resolvePost = resolve;
      }),
    );

    useArchUIStore.setState({
      session: {
        ...makeSession(),
        metadata: {
          ...makeSession().metadata,
          phase: 'CREATE',
          pendingInteraction: {
            kind: 'widget',
            id: 'build-complete-1',
            payload: {
              widgetType: 'BuildComplete',
              question: 'Ready to create?',
              options: [{ label: 'Create project', value: 'create' }],
            },
            createdAt: '2026-04-20T08:00:01.000Z',
          },
        },
      } as never,
      state: 'widget_pending',
    });

    const { result, unmount } = renderHook(() => useArchChat());

    let firstSend!: Promise<void>;
    let secondSend!: Promise<void>;
    await act(async () => {
      firstSend = result.current.sendToolAnswer('build-complete-1', 'create');
      secondSend = result.current.sendToolAnswer('build-complete-1', 'create');
      await secondSend;
    });

    expect(postMessageMock).toHaveBeenCalledTimes(1);
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tool_answer',
        toolCallId: 'build-complete-1',
        answer: 'create',
      }),
    );

    await act(async () => {
      resolvePost(new Response('', { status: 200 }));
      await firstSend;
    });

    unmount();
  });

  it('uses the compat status message id expected by the /arch page filter', () => {
    useArchUIStore.setState({
      statusMessage: 'Updating specification...',
    });

    const { result, unmount } = renderHook(() => useArchChat());

    expect(result.current.statusMessages).toEqual([
      expect.objectContaining({
        id: 'v2-status',
        text: 'Updating specification...',
        type: 'info',
      }),
    ]);

    unmount();
  });

  it('keeps attachment refs on the optimistic user message for retry', async () => {
    useArchUIStore.setState({
      session: makeSession() as never,
      phase: 'INTERVIEW',
    });

    const { result, unmount } = renderHook(() => useArchChat());

    await act(async () => {
      await result.current.send('Build a project using the attached SOPs', undefined, [
        { blobId: 'blob-sop-1', name: 'support-sop.pdf', type: 'application/pdf' },
      ]);
    });

    const userMessage = useArchUIStore
      .getState()
      .messages.find((message) => message.role === 'user');
    expect(userMessage?.rawContent).toEqual([
      { type: 'text', text: 'Build a project using the attached SOPs' },
      {
        type: 'file_ref',
        blobId: 'blob-sop-1',
        name: 'support-sop.pdf',
        mediaType: 'application/pdf',
        tokenCost: 0,
      },
    ]);

    unmount();
  });

  it('retries the last user message with its original attachments', async () => {
    useArchUIStore.setState({
      session: makeSession() as never,
      phase: 'INTERVIEW',
      error: {
        message: 'Model failed',
        type: 'generic',
        recoverable: true,
      },
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Build a project using the attached SOPs',
          timestamp: '2026-04-20T08:00:01.000Z',
          rawContent: [
            { type: 'text', text: 'Build a project using the attached SOPs' },
            {
              type: 'file_ref',
              blobId: 'blob-sop-1',
              name: 'support-sop.pdf',
              mediaType: 'application/pdf',
              tokenCost: 0,
            },
          ],
        },
      ] as never,
    });

    const { result, unmount } = renderHook(() => useArchChat());

    await act(async () => {
      await result.current.retry();
    });

    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-ui-1',
        type: 'message',
        text: 'Build a project using the attached SOPs',
        fileRefs: [{ blobId: 'blob-sop-1', name: 'support-sop.pdf', type: 'application/pdf' }],
      }),
    );

    unmount();
  });
});
