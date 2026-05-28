import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockClearContext = vi.fn();
const mockGetContextPayload = vi.fn(() => ({}));
const mockSetSkipOnStart = vi.fn();
const mockSetStartAtStep = vi.fn();
const mockUpdateSessionVariable = vi.fn();
const mockRemoveSessionVariable = vi.fn();
const mockStartProjectAgentSession = vi.fn();

let mockWsContext: {
  startProjectAgentSession: typeof mockStartProjectAgentSession;
  isConnected: boolean;
} | null = null;

const mockTestContextState = {
  hasContext: () => false,
  clearContext: mockClearContext,
  getContextPayload: mockGetContextPayload,
  skipOnStart: false,
  setSkipOnStart: mockSetSkipOnStart,
  startAtStep: '',
  setStartAtStep: mockSetStartAtStep,
  sessionVariables: {} as Record<string, unknown>,
  updateSessionVariable: mockUpdateSessionVariable,
  removeSessionVariable: mockRemoveSessionVariable,
};

const mockSessionState = {
  agent: {
    name: 'historical-agent',
    ir: {
      flow: {
        steps: ['entry'],
      },
    },
  },
};

const mockNavigationState = {
  projectId: 'project-1',
  subPage: 'session-123',
};

vi.mock('next-intl', () => ({
  useTranslations: (namespace: string) => {
    const translations: Record<string, Record<string, string>> = {
      test_context: {
        gather_fields: 'Gather Fields',
        session_variables: 'Session Variables',
        tool_mocks: 'Tool Mocks',
        caller_context: 'Caller Context',
        options: 'Options',
        value_placeholder: 'value',
      },
      'test_context.panel': {
        start_with_context: 'Start with Context',
        start_chat: 'Start Chat',
        clear_all_context: 'Clear all context',
        skip_on_start: 'Skip ON_START',
        start_at_step: 'Start at step',
        default_entry_point: 'Default (entry point)',
        live_chat_required:
          'Open this agent in live chat to start a new test session with this context.',
      },
    };

    return (key: string) => translations[namespace]?.[key] ?? key;
  },
}));

vi.mock('../../contexts/WebSocketContext', () => ({
  useOptionalWebSocketContext: () => mockWsContext,
}));

vi.mock('../../store/test-context-store', () => ({
  useTestContextStore: (selector: (state: typeof mockTestContextState) => unknown) =>
    selector(mockTestContextState),
}));

vi.mock('../../store/session-store', () => ({
  useSessionStore: (selector: (state: typeof mockSessionState) => unknown) =>
    selector(mockSessionState),
}));

vi.mock('../../store/navigation-store', () => ({
  useNavigationStore: (selector: (state: typeof mockNavigationState) => unknown) =>
    selector(mockNavigationState),
}));

vi.mock('../../components/test-context/GatherFieldEditor', () => ({
  GatherFieldEditor: () => <div data-testid="gather-field-editor" />,
}));

vi.mock('../../components/test-context/VariableEditor', () => ({
  VariableEditor: () => <div data-testid="variable-editor" />,
}));

vi.mock('../../components/test-context/ToolMockEditor', () => ({
  ToolMockEditor: () => <div data-testid="tool-mock-editor" />,
}));

vi.mock('../../components/test-context/CallerContextEditor', () => ({
  CallerContextEditor: () => <div data-testid="caller-context-editor" />,
}));

vi.mock('../../components/test-context/ScenarioSelector', () => ({
  ScenarioSelector: ({ agentPath, projectId }: { agentPath: string; projectId?: string }) => (
    <div
      data-testid="scenario-selector"
      data-agent-path={agentPath}
      data-project-id={projectId ?? ''}
    />
  ),
}));

import { TestContextPanel } from '@/components/test-context/TestContextPanel';

describe('TestContextPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWsContext = null;
  });

  it('renders without crashing outside the websocket provider in session detail', () => {
    render(<TestContextPanel />);

    expect(
      screen.getByText(
        'Open this agent in live chat to start a new test session with this context.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Start Chat/ })).toBeDisabled();
    expect(screen.getByTestId('scenario-selector')).toHaveAttribute(
      'data-agent-path',
      'historical-agent',
    );
  });

  it('starts a live test session with the loaded agent name instead of the session id', async () => {
    mockWsContext = {
      startProjectAgentSession: mockStartProjectAgentSession,
      isConnected: true,
    };

    render(<TestContextPanel />);

    await userEvent.click(screen.getByRole('button', { name: /Start Chat/ }));

    expect(mockStartProjectAgentSession).toHaveBeenCalledWith('historical-agent', 'project-1', {});
  });
});
