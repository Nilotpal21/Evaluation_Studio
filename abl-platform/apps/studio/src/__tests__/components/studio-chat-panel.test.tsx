/**
 * StudioChatPanel Tests
 *
 * Tests that StudioChatPanel renders SDK components within Studio wrapper,
 * handles loading/error/empty states, and wires debug/export/reset actions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

// ---------------------------------------------------------------------------
// Mocks — must be set up before component import
// ---------------------------------------------------------------------------

// Mock useStudioTransport
const mockTransport = {
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  isConnected: vi.fn(() => true),
  send: vi.fn(),
  on: vi.fn(() => () => {}),
  getSessionId: vi.fn(() => 'session-1'),
  capabilities: {
    supportsThoughts: true,
    supportsHandoff: true,
    supportsFileUpload: true,
    supportsVoice: false,
  },
};

vi.mock('../../adapters/useStudioTransport', () => ({
  useStudioTransport: () => mockTransport,
}));

// Mock useSession
const mockUseSession = vi.fn();
vi.mock('../../hooks/useSession', () => ({
  useSession: () => mockUseSession(),
}));

// Mock WebSocketContext
const mockWsSend = vi.fn();
const mockEnsureSessionPersisted = vi.fn().mockResolvedValue(undefined);
vi.mock('../../contexts/WebSocketContext', () => ({
  useWebSocketContext: () => ({
    send: mockWsSend,
    ensureSessionPersisted: mockEnsureSessionPersisted,
    isConnected: true,
    subscribeChatMessage: vi.fn(() => () => {}),
  }),
}));

// Mock session store
const mockSessionStoreState = {
  sessionId: 'session-1',
  messageSnapshotVersion: 0,
  messages: [] as Array<Record<string, unknown>>,
  setError: vi.fn(),
  getState: () => mockSessionStoreState,
};

vi.mock('../../store/session-store', () => {
  return {
    useSessionStore: Object.assign(
      (selector: (s: typeof mockSessionStoreState) => unknown) => selector(mockSessionStoreState),
      {
        getState: () => mockSessionStoreState,
      },
    ),
  };
});

// Mock navigation store
const mockNavigate = vi.fn();
vi.mock('../../store/navigation-store', () => ({
  useNavigationStore: Object.assign(
    (
      selector: (s: {
        subPage: string;
        projectId: string;
        navigate: typeof mockNavigate;
      }) => unknown,
    ) => selector({ subPage: 'my-agent', projectId: 'proj-1', navigate: mockNavigate }),
    { getState: () => ({ subPage: 'my-agent', projectId: 'proj-1', navigate: mockNavigate }) },
  ),
}));

// Mock test context store
vi.mock('../../store/test-context-store', () => ({
  useTestContextStore: (selector: (s: { hasContext: () => boolean }) => unknown) =>
    selector({ hasContext: () => false }),
}));

// Mock observatory store
const mockSetDebugPanelOpen = vi.fn();
const mockSetDebugPanelTab = vi.fn();
vi.mock('../../store/observatory-store', () => ({
  useObservatoryStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        setDebugPanelOpen: mockSetDebugPanelOpen,
        setDebugPanelTab: mockSetDebugPanelTab,
      }),
    {
      getState: () => ({
        setDebugPanelOpen: mockSetDebugPanelOpen,
        setDebugPanelTab: mockSetDebugPanelTab,
        setSelection: vi.fn(),
      }),
    },
  ),
}));

// Mock api-client
vi.mock('../../lib/api-client', () => ({
  apiFetch: vi.fn(),
  authHeaders: () => ({}),
}));

// Mock SDK React components — minimal stubs
const mockChatReplaceTranscript = vi.fn();
let lastChatWidgetProps: Record<string, unknown> | null = null;
const mockUseAgent = vi.fn(() => ({
  chat: null,
  messages: [],
  isTyping: false,
  isConnected: false,
}));

vi.mock('@agent-platform/web-sdk/react', () => ({
  AgentProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="agent-provider">{children}</div>
  ),
  ChatWidget: (props: Record<string, unknown>) => {
    lastChatWidgetProps = props;
    return (
      <div
        data-testid="chat-widget"
        data-has-upload={!!props.onUploadFile}
        data-has-trace={!!props.onViewTrace}
      />
    );
  },
  useAgent: () => mockUseAgent(),
}));

// Mock BatchConsentGate
vi.mock('../../components/auth-profiles/BatchConsentGate', () => ({
  BatchConsentGate: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="batch-consent-gate">{children}</div>
  ),
}));

// Mock SessionHealthBanner
vi.mock('../../components/chat/SessionHealthBanner', () => ({
  SessionHealthBanner: () => <div data-testid="session-health-banner" />,
}));

// Mock AuthChallengeMessage
vi.mock('../../components/chat/AuthChallengeMessage', () => ({
  AuthChallengeMessage: ({ data }: { data: Record<string, unknown> }) => (
    <div data-testid="auth-challenge">{String(data.profileName)}</div>
  ),
  parseAuthChallengeData: (content: string) => {
    try {
      const parsed = JSON.parse(content);
      if (parsed?._type === 'auth_challenge') return parsed;
    } catch {
      // not auth challenge
    }
    return null;
  },
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { StudioChatPanel } from '@/components/chat/StudioChatPanel';
import { apiFetch } from '@/lib/api-client';

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('StudioChatPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionStoreState.sessionId = 'session-1';
    mockSessionStoreState.messageSnapshotVersion = 0;
    mockSessionStoreState.messages = [];
    mockEnsureSessionPersisted.mockResolvedValue(undefined);
    vi.mocked(apiFetch).mockReset();
    lastChatWidgetProps = null;
    mockUseAgent.mockReturnValue({
      chat: null,
      messages: [],
      isTyping: false,
      isConnected: false,
    });
  });

  describe('loading/error/empty states', () => {
    it('renders loading state when isLoading and no agent', () => {
      mockUseSession.mockReturnValue({
        hasAgent: false,
        agent: null,
        messages: [],
        isStreaming: false,
        streamingContent: '',
        error: null,
        isLoading: true,
      });

      render(<StudioChatPanel />);
      expect(screen.getByText('Loading agent...')).toBeInTheDocument();
    });

    it('renders error state with dismiss button', () => {
      mockUseSession.mockReturnValue({
        hasAgent: false,
        agent: null,
        messages: [],
        isStreaming: false,
        streamingContent: '',
        error: 'Agent not found',
        isLoading: false,
      });

      render(<StudioChatPanel />);
      expect(screen.getByText('Failed to load agent')).toBeInTheDocument();
      expect(screen.getByText('Agent not found')).toBeInTheDocument();
      expect(screen.getByText('Dismiss')).toBeInTheDocument();
    });

    it('renders empty state prompting user to start a chat', () => {
      mockUseSession.mockReturnValue({
        hasAgent: false,
        agent: null,
        messages: [],
        isStreaming: false,
        streamingContent: '',
        error: null,
        isLoading: false,
      });

      render(<StudioChatPanel />);
      expect(screen.getByText('Chat with my-agent')).toBeInTheDocument();
    });
  });

  describe('main chat view', () => {
    const defaultSession = {
      hasAgent: true,
      agent: {
        id: 'agent-1',
        name: 'TestBot',
        type: 'agent',
        mode: 'reasoning',
        toolCount: 5,
        gatherFieldCount: 0,
        isSupervisor: false,
      },
      messages: [],
      isStreaming: false,
      streamingContent: '',
      error: null,
      isLoading: false,
    };

    it('renders StudioChatHeader with agent info', () => {
      mockUseSession.mockReturnValue(defaultSession);
      render(<StudioChatPanel />);

      expect(screen.getByText('Test Bot')).toBeInTheDocument();
      expect(screen.getByText('Agent')).toBeInTheDocument();
      expect(screen.getByText('Reasoning')).toBeInTheDocument();
    });

    it('renders supervisor routing capabilities when the supervisor has no direct tools', () => {
      mockUseSession.mockReturnValue({
        ...defaultSession,
        agent: {
          ...defaultSession.agent,
          type: 'supervisor',
          toolCount: 0,
          isSupervisor: true,
          ir: {
            coordination: {
              handoffs: [
                { to: 'DocumentSearchAgent' },
                { to: 'DatabaseQueryAgent' },
                { to: 'HumanEscalationAgent' },
              ],
            },
          },
        },
      });

      render(<StudioChatPanel />);

      expect(screen.getByText('3 routes')).toBeInTheDocument();
      expect(screen.queryByText('0 tools')).not.toBeInTheDocument();
    });

    it('returns from chat to the agent editor', async () => {
      mockUseSession.mockReturnValue(defaultSession);
      render(<StudioChatPanel />);

      await userEvent.click(screen.getByText('Back to Agent'));
      expect(mockNavigate).toHaveBeenCalledWith('/projects/proj-1/agents/my-agent');
    });

    it('renders scripted mode label for scripted agents', () => {
      mockUseSession.mockReturnValue({
        ...defaultSession,
        agent: {
          ...defaultSession.agent,
          type: 'supervisor',
          mode: 'scripted',
          isSupervisor: true,
        },
      });

      render(<StudioChatPanel />);

      expect(screen.getByText('Supervisor')).toBeInTheDocument();
      expect(screen.getByText('Scripted')).toBeInTheDocument();
    });

    it('renders SDK AgentProvider and ChatWidget', () => {
      mockUseSession.mockReturnValue(defaultSession);
      render(<StudioChatPanel />);

      expect(screen.getByTestId('agent-provider')).toBeInTheDocument();
      expect(screen.getByTestId('chat-widget')).toBeInTheDocument();
    });

    it('passes onUploadFile and onViewTrace to ChatWidget', () => {
      mockUseSession.mockReturnValue(defaultSession);
      render(<StudioChatPanel />);

      const widget = screen.getByTestId('chat-widget');
      expect(widget.getAttribute('data-has-upload')).toBe('true');
      expect(widget.getAttribute('data-has-trace')).toBe('true');
    });

    it('persists the active debug session before uploading an attachment', async () => {
      mockUseSession.mockReturnValue(defaultSession);
      vi.mocked(apiFetch).mockResolvedValue(
        new Response(JSON.stringify({ success: true, attachmentId: 'att-1' }), {
          status: 201,
          statusText: 'Created',
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      render(<StudioChatPanel />);

      const onUploadFile = lastChatWidgetProps?.onUploadFile as (file: File) => Promise<string>;
      const attachmentId = await onUploadFile(
        new File(['hello'], 'hello.txt', { type: 'text/plain' }),
      );

      expect(attachmentId).toBe('att-1');
      expect(mockEnsureSessionPersisted).toHaveBeenCalledWith('session-1');
      expect(apiFetch).toHaveBeenCalledWith('/api/projects/proj-1/sessions/session-1/attachments', {
        method: 'POST',
        body: expect.any(FormData),
      });
    });

    it('renders BatchConsentGate and SessionHealthBanner', () => {
      mockUseSession.mockReturnValue(defaultSession);
      render(<StudioChatPanel />);

      expect(screen.getByTestId('batch-consent-gate')).toBeInTheDocument();
      expect(screen.getByTestId('session-health-banner')).toBeInTheDocument();
    });

    it('hydrates stored history as soon as chat becomes available', async () => {
      const contentEnvelope = {
        version: 2,
        format: 'message_envelope',
        text: 'Account summary',
        richContent: { markdown: '| Field | Value |' },
      };

      mockSessionStoreState.messages = [
        {
          id: 'stored-assistant-1',
          role: 'assistant',
          content: 'Account summary',
          contentEnvelope,
          timestamp: new Date('2026-04-20T09:00:00.000Z'),
          traceIds: [],
        },
      ];
      mockUseAgent.mockReturnValue({
        chat: {
          replaceTranscript: mockChatReplaceTranscript,
        },
        messages: [],
        isTyping: false,
        isConnected: true,
      });
      mockUseSession.mockReturnValue(defaultSession);

      render(<StudioChatPanel />);

      await waitFor(() =>
        expect(mockChatReplaceTranscript).toHaveBeenCalledWith([
          expect.objectContaining({
            id: 'stored-assistant-1',
            sessionId: 'session-1',
            role: 'assistant',
            content: 'Account summary',
            contentEnvelope: {
              text: 'Account summary',
              richContent: { markdown: '| Field | Value |' },
            },
            sourceChannel: 'text',
            inputMode: 'system',
          }),
        ]),
      );
    });

    it('does not rehydrate the same session on live store updates', async () => {
      mockSessionStoreState.messages = [
        {
          id: 'stored-user-1',
          role: 'user',
          content: 'Hello',
          timestamp: new Date('2026-04-20T09:00:00.000Z'),
          traceIds: [],
        },
      ];
      mockUseAgent.mockReturnValue({
        chat: {
          replaceTranscript: mockChatReplaceTranscript,
        },
        messages: [],
        isTyping: false,
        isConnected: true,
      });
      mockUseSession.mockReturnValue(defaultSession);

      const { rerender } = render(<StudioChatPanel />);

      await waitFor(() => expect(mockChatReplaceTranscript).toHaveBeenCalledTimes(1));

      mockSessionStoreState.messages = [
        ...mockSessionStoreState.messages,
        {
          id: 'stored-user-2',
          role: 'user',
          content: 'Follow up',
          timestamp: new Date('2026-04-20T09:01:00.000Z'),
          traceIds: [],
        },
      ];

      rerender(<StudioChatPanel />);

      await waitFor(() => expect(mockChatReplaceTranscript).toHaveBeenCalledTimes(1));
    });

    it('rehydrates the SDK from the authoritative snapshot when the same session resumes', async () => {
      mockUseAgent.mockReturnValue({
        chat: {
          replaceTranscript: mockChatReplaceTranscript,
        },
        messages: [],
        isTyping: false,
        isConnected: true,
      });
      mockUseSession.mockReturnValue(defaultSession);

      const { rerender } = render(<StudioChatPanel />);

      await waitFor(() => expect(mockChatReplaceTranscript).toHaveBeenCalledWith([]));

      mockSessionStoreState.messages = [
        {
          id: 'resume-user-1',
          role: 'user',
          content: 'hello',
          timestamp: new Date('2026-04-22T10:00:00.000Z'),
          traceIds: [],
        },
        {
          id: 'resume-assistant-1',
          role: 'assistant',
          content: 'hi there',
          timestamp: new Date('2026-04-22T10:00:01.000Z'),
          traceIds: [],
        },
      ];
      mockSessionStoreState.messageSnapshotVersion = 1;

      rerender(<StudioChatPanel />);

      await waitFor(() =>
        expect(mockChatReplaceTranscript).toHaveBeenCalledWith([
          expect.objectContaining({
            id: 'resume-user-1',
            role: 'user',
            content: 'hello',
          }),
          expect.objectContaining({
            id: 'resume-assistant-1',
            role: 'assistant',
            content: 'hi there',
          }),
        ]),
      );
      expect(mockChatReplaceTranscript).toHaveBeenCalledTimes(2);
    });

    it('renders debug toggle button when onToggleDebug provided', () => {
      mockUseSession.mockReturnValue(defaultSession);
      const onToggleDebug = vi.fn();
      render(<StudioChatPanel onToggleDebug={onToggleDebug} />);

      expect(screen.getByText('Debug')).toBeInTheDocument();
    });
  });

  describe('error banner', () => {
    it('shows error banner when error exists alongside agent', () => {
      mockUseSession.mockReturnValue({
        hasAgent: true,
        agent: {
          id: 'agent-1',
          name: 'TestBot',
          type: 'agent',
          mode: 'reasoning',
          toolCount: 0,
          gatherFieldCount: 0,
          isSupervisor: false,
        },
        messages: [],
        isStreaming: false,
        streamingContent: '',
        error: 'Connection lost',
        isLoading: false,
      });

      render(<StudioChatPanel />);
      expect(screen.getByText('Connection lost')).toBeInTheDocument();
    });
  });
});
