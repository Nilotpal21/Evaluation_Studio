import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionSidebar } from '../../components/chat/SessionSidebar';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, string | number | Date>) => {
    if (key === 'message_count') {
      return `${String(values?.count ?? 0)} msgs`;
    }
    if (key === 'time_just_now') {
      return 'just now';
    }
    return key;
  },
}));

const mockSessions = [
  {
    id: 'current-1',
    messageCount: 1,
    lastActivityAt: '2026-04-23T18:00:00.000Z',
    status: 'active',
    agentName: 'Platform_Bridge_Desk',
  },
  {
    id: 'active-s1',
    runtimeSessionId: 'runtime-active-1',
    messageCount: 2,
    lastActivityAt: '2026-04-23T18:01:00.000Z',
    status: 'active',
    agentName: 'Platform_Bridge_Desk',
  },
  {
    id: 'ended-se1',
    messageCount: 4,
    lastActivityAt: '2026-04-23T18:02:00.000Z',
    status: 'ended',
    agentName: 'Platform_Bridge_Desk',
  },
];

vi.mock('../../hooks/useAgentSessions', () => ({
  useAgentSessions: () => ({
    sessions: mockSessions,
    isLoading: false,
    refresh: vi.fn(),
  }),
}));

const mockSessionStoreState = {
  sessionId: 'current-1',
  agent: { name: 'Platform_Bridge_Desk' },
  messages: [],
  clearSession: vi.fn(),
  setError: vi.fn(),
};

vi.mock('../../store/session-store', () => ({
  useSessionStore: Object.assign(
    (selector: (state: typeof mockSessionStoreState) => unknown) => selector(mockSessionStoreState),
    {
      getState: () => mockSessionStoreState,
    },
  ),
}));

const mockResumeSession = vi.fn();
const mockSwitchSession = vi.fn();

vi.mock('../../contexts/WebSocketContext', () => ({
  useWebSocketContext: () => ({
    isConnected: true,
    resumeSession: mockResumeSession,
    switchSession: mockSwitchSession,
  }),
}));

vi.mock('../../store/navigation-store', () => ({
  useNavigationStore: (selector: (state: { projectId: string; subPage: string }) => unknown) =>
    selector({
      projectId: 'project-1',
      subPage: 'Platform_Bridge_Desk',
    }),
}));

const mockToggleSidebar = vi.fn();
vi.mock('../../store/observatory-store', () => ({
  useObservatoryStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      sessionSidebarOpen: true,
      toggleSessionSidebar: mockToggleSidebar,
    }),
}));

vi.mock('../../lib/api-client', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('../../components/chat/CallerDataEditor', () => ({
  CallerDataEditor: () => <div data-testid="caller-data-editor" />,
}));

describe('SessionSidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionStoreState.sessionId = 'current-1';
    mockSwitchSession.mockResolvedValue(undefined);
  });

  it('resumes active sessions directly from the sidebar', async () => {
    const user = userEvent.setup();

    render(<SessionSidebar onNewChat={vi.fn()} />);

    await user.click(screen.getByText('active-s').closest('button')!);

    expect(mockResumeSession).toHaveBeenCalledWith('runtime-active-1');
    expect(mockSwitchSession).not.toHaveBeenCalled();
  });

  it('prefetches and then resumes historical sessions so follow-up sends stay bound', async () => {
    const user = userEvent.setup();

    render(<SessionSidebar onNewChat={vi.fn()} />);

    await user.click(screen.getByText('ended-se').closest('button')!);

    await waitFor(() => {
      expect(mockSwitchSession).toHaveBeenCalledWith('ended-se1');
      expect(mockResumeSession).toHaveBeenCalledWith('ended-se1');
    });

    expect(mockSwitchSession.mock.invocationCallOrder[0]).toBeLessThan(
      mockResumeSession.mock.invocationCallOrder[0],
    );
  });

  it('does not resume historical sessions when detail prefetch fails', async () => {
    const user = userEvent.setup();
    mockSwitchSession.mockRejectedValue(new Error('detail load failed'));

    render(<SessionSidebar onNewChat={vi.fn()} />);

    await user.click(screen.getByText('ended-se').closest('button')!);

    await waitFor(() => {
      expect(mockSwitchSession).toHaveBeenCalledWith('ended-se1');
      expect(mockSessionStoreState.setError).toHaveBeenCalledWith('detail load failed');
    });
    expect(mockResumeSession).not.toHaveBeenCalled();
  });
});
