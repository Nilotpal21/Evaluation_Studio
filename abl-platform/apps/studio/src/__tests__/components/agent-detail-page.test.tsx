/**
 * AgentDetailPage (redesigned) Tests
 *
 * Tests for the single scrollable page layout that replaces the old tabbed view.
 * Covers header rendering, section visibility based on IR data, and action buttons.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { SWRConfig } from 'swr';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn();
const mockExpandSection = vi.fn();
const mockCollapseSection = vi.fn();
const mockRemoveAgentFromProject = vi.fn().mockResolvedValue(undefined);
const mockUpdateProjectAgent = vi.fn();
const mockFetchRuntimeAgent = vi.fn();
const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();
const mockApiFetch = vi.fn().mockResolvedValue({
  ok: false,
  status: 404,
  json: () => Promise.resolve({}),
});

const mockProjectStore = {
  currentProject: {
    id: 'proj-1',
    entryAgentName: 'booking_agent',
  },
};

const defaultTopologyPayload = {
  topology: {
    nodes: [{ id: 'booking_agent', name: 'booking_agent', isEntry: true }],
    edges: [],
  },
};

function makeUseAgentIRResult(overrides: Record<string, unknown> = {}) {
  return {
    ir: {
      metadata: { name: 'booking_agent' },
      execution: { mode: 'reasoning', model: 'claude-sonnet-4-6' },
      identity: { goal: 'Help users book hotels', persona: 'Friendly assistant', limitations: [] },
      tools: [
        {
          name: 'search_hotels',
          description: 'Search',
          parameters: [],
          returns: { type: 'object' },
          hints: {},
        },
      ],
      gather: {
        fields: [{ name: 'destination', type: 'string', required: true, prompt: 'Where?' }],
      },
      constraints: { constraints: [], guardrails: [] },
      coordination: { delegates: [], handoffs: [] },
      completion: { conditions: [] },
      error_handling: {
        handlers: [],
        default_handler: { type: 'default', then: 'continue' },
      },
      memory: { session: [], persistent: [], remember: [], recall: [] },
    },
    dsl: 'AGENT: booking_agent',
    compileErrors: [],
    compileWarnings: [],
    isLoading: false,
    error: null,
    reload: vi.fn(),
    ...overrides,
  };
}

const mockUseAgentIR = vi.fn(() => makeUseAgentIRResult());

vi.mock('../../hooks/useSectionEdit', () => ({
  useSectionEdit: () => ({ editSection: vi.fn(), editSections: vi.fn() }),
}));

vi.mock('../../lib/abl-serializers', () => ({
  serializeIdentityToABL: vi.fn(() => []),
  serializeToolsToABL: vi.fn(() => []),
  serializeGatherToABL: vi.fn(() => []),
  serializeFlowToABL: vi.fn(() => []),
  serializeRulesToABL: vi.fn(() => []),
  serializeCoordinationToABL: vi.fn(() => []),
  serializeConversationBehaviorToABL: vi.fn(() => []),
  serializeBehaviorRefsToABL: vi.fn(() => []),
  serializeLifecycleToABL: vi.fn(() => []),
}));

vi.mock('../../lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('../../lib/sanitize-error', () => ({
  sanitizeError: (_error: unknown, fallback: string) => fallback,
}));

vi.mock('../../api/projects', () => ({
  removeAgentFromProject: (...args: unknown[]) => mockRemoveAgentFromProject(...args),
  updateProjectAgent: (...args: unknown[]) => mockUpdateProjectAgent(...args),
  fetchProject: vi.fn(() => Promise.resolve({})),
}));

vi.mock('../../api/runtime-agents', () => ({
  fetchRuntimeAgent: (...args: unknown[]) => mockFetchRuntimeAgent(...args),
}));

vi.mock('../../store/project-store', () => ({
  useProjectStore: vi.fn((selector?: (state: typeof mockProjectStore) => unknown) =>
    selector ? selector(mockProjectStore) : mockProjectStore,
  ),
}));

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

vi.mock('../../hooks/useAgentIR', () => ({
  useAgentIR: (...args: unknown[]) => mockUseAgentIR(...args),
}));

vi.mock('../../hooks/useStaleToolCheck', () => ({
  getStaleToolCheckKey: vi.fn((projectId: string | null, agentName: string | null) =>
    projectId && agentName ? ['stale-tool-check', projectId, agentName] : null,
  ),
  revalidateStaleToolCheck: vi.fn().mockResolvedValue(undefined),
  useStaleToolCheck: () => ({
    staleTools: [],
    deletedTools: [],
    newTools: [],
    isLoading: false,
    error: null,
  }),
}));

vi.mock('../../hooks/useAgentVersions', () => ({
  useAgentVersions: () => ({
    create: vi.fn(),
    versions: [],
    total: 0,
    isLoading: false,
    error: null,
    reload: vi.fn(),
    promote: vi.fn(),
    diffVersionA: null,
    diffVersionB: null,
    showDiff: false,
    setDiffVersions: vi.fn(),
    setShowDiff: vi.fn(),
  }),
}));

vi.mock('../../store/navigation-store', () => ({
  useNavigationStore: vi.fn((sel?: (s: Record<string, unknown>) => unknown) => {
    const state = { projectId: 'proj-1', subPage: 'booking_agent', navigate: mockNavigate };
    return sel ? sel(state) : state;
  }),
}));

// Agent detail store mock — supports selector pattern
const detailStoreState = {
  sections: {
    identity: {
      mode: 'reasoning',
      goal: 'Help users book hotels',
      persona: 'Friendly assistant',
      limitations: [],
      model: 'claude-sonnet-4-6',
    },
    tools: [
      {
        name: 'search_hotels',
        description: 'Search',
        parameters: [],
        returns: { type: 'object' },
        hints: {},
      },
    ],
    gather: [{ name: 'destination', type: 'string', required: true, prompt: 'Where?' }],
    flow: null,
    rules: { constraints: [], guardrails: [] },
    coordination: {
      delegates: [],
      handoffs: [],
      escalation: { triggers: [], contextForHuman: [], onHumanComplete: [] },
    },
    behavior: {
      conversationBehavior: undefined,
      profiles: [],
    },
    lifecycle: {
      hasOnStart: false,
      hasHooks: false,
      hooks: [],
      errorHandlers: [],
      completionConditions: [],
      memoryConfig: {
        sessionVars: [],
        persistentPaths: [],
        rememberTriggers: 0,
        recallInstructions: 0,
      },
    },
  },
  visibleSections: ['IDENTITY', 'TOOLS', 'GATHER'],
  expandedSection: null,
  saveStatus: 'idle',
  agentName: 'booking_agent',
  expandSection: mockExpandSection,
  collapseSection: mockCollapseSection,
  loadFromIR: vi.fn(),
  reset: vi.fn(),
  updateSection: vi.fn(),
};

vi.mock('../../store/agent-detail-store', () => {
  const actual = vi.importActual('../../store/agent-detail-store');
  return {
    ...actual,
    useAgentDetailStore: Object.assign(
      vi.fn((selector?: (s: typeof detailStoreState) => unknown) => {
        if (selector) return selector(detailStoreState);
        return detailStoreState;
      }),
      { getState: () => detailStoreState },
    ),
  };
});

// Mock section components to keep tests focused on page composition
vi.mock('../../components/agent-detail', () => ({
  SectionCard: () => null,
  IdentitySection: () => <div data-testid="identity-section">Identity</div>,
  ToolsSection: () => <div data-testid="tools-section">Tools</div>,
  GatherSection: () => <div data-testid="gather-section">Gather Fields</div>,
  FlowSection: () => <div data-testid="flow-section">Flow</div>,
  RulesSection: () => <div data-testid="rules-section">Rules</div>,
  CoordinationSection: () => <div data-testid="coordination-section">Coordination</div>,
  LifecycleSection: () => <div data-testid="lifecycle-section">Lifecycle</div>,
  VersionsSlideOver: () => null,
  DslEditorOverlay: () => null,
  StaleToolBanner: () => null,
}));

vi.mock('../../components/ui/ConfirmDialog', () => ({
  ConfirmDialog: ({ open, title, description, onConfirm, onClose, confirmLabel, children }: any) =>
    open ? (
      <div data-testid="confirm-dialog">
        <div>{title}</div>
        <div>{description}</div>
        {children}
        <button onClick={onClose}>Cancel</button>
        <button onClick={onConfirm}>{confirmLabel}</button>
      </div>
    ) : null,
}));

// Mock framer-motion
vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
      <div {...props}>{children}</div>
    ),
  },
  AnimatePresence: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { AgentDetailPage } from '../../components/agents/AgentDetailPage';

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <AgentDetailPage />
    </SWRConfig>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentDetailPage (redesigned)', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockExpandSection.mockClear();
    mockCollapseSection.mockClear();
    mockRemoveAgentFromProject.mockClear();
    mockUpdateProjectAgent.mockReset();
    mockFetchRuntimeAgent.mockReset();
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
    mockApiFetch.mockClear();
    mockUseAgentIR.mockReset();
    mockUseAgentIR.mockReturnValue(makeUseAgentIRResult());
    mockProjectStore.currentProject = {
      id: 'proj-1',
      entryAgentName: 'booking_agent',
    };
    mockApiFetch.mockImplementation((input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/projects/proj-1/topology') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(defaultTopologyPayload),
        });
      }

      if (url === '/api/projects/proj-1/agents/booking_agent/lock' && init?.method === 'POST') {
        return Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({}),
        });
      }

      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}),
      });
    });
    mockFetchRuntimeAgent.mockResolvedValue({
      agent: {
        id: 'agent-1',
        projectId: 'proj-1',
        name: 'booking_agent',
        agentPath: 'proj-1/default/booking_agent',
        description: 'Books hotels for travelers',
        dslContent: 'AGENT: booking_agent',
        activeVersions: {},
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
      },
    });
  });

  it('renders agent name in header', () => {
    renderPage();
    expect(screen.getByText('booking_agent')).toBeInTheDocument();
  });

  it('renders Identity section (always visible)', () => {
    renderPage();
    expect(screen.getByText('Identity')).toBeInTheDocument();
  });

  it('renders Tools section when tools exist', () => {
    renderPage();
    expect(screen.getByText('Tools')).toBeInTheDocument();
  });

  it('renders Gather section when fields exist', () => {
    renderPage();
    expect(screen.getByText('Gather Fields')).toBeInTheDocument();
  });

  it('does not render Flow section for reasoning agents', () => {
    renderPage();
    expect(screen.queryByText('Flow')).not.toBeInTheDocument();
  });

  it('renders header actions: Versions, ABL, Chat, Delete', () => {
    renderPage();
    expect(screen.getByText('Versions')).toBeInTheDocument();
    expect(screen.getByText('ABL')).toBeInTheDocument();
    expect(screen.getByText('Chat')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  it('renders mode badge in header', () => {
    renderPage();
    expect(screen.getByText('reasoning')).toBeInTheDocument();
  });

  it('renders model in header metadata', () => {
    renderPage();
    expect(screen.getByText('Model: claude-sonnet-4-6')).toBeInTheDocument();
  });

  it('renders back button with label', () => {
    renderPage();
    expect(screen.getByText('Agents')).toBeInTheDocument();
  });

  it('renders compile failures as errors instead of warnings when IR is unavailable', () => {
    mockUseAgentIR.mockReturnValue(
      makeUseAgentIRResult({
        ir: null,
        compileErrors: ['booking_agent: Unknown delegate target'],
      }),
    );

    renderPage();

    expect(screen.getByRole('heading', { name: 'Compilation Failed' })).toBeInTheDocument();
    expect(screen.getByText('booking_agent: Unknown delegate target')).toBeInTheDocument();
    expect(screen.queryByText('Compilation warnings')).not.toBeInTheDocument();
  });

  it('deletes the agent after confirmation from the detail page', async () => {
    renderPage();

    fireEvent.click(screen.getByText('Delete'));

    const dialog = screen.getByTestId('confirm-dialog');
    expect(dialog).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(mockRemoveAgentFromProject).toHaveBeenCalledWith('proj-1', 'booking_agent');
    });

    expect(mockToastSuccess).toHaveBeenCalledWith('Agent deleted');
    expect(mockNavigate).toHaveBeenCalledWith('/projects/proj-1/agents');
  });

  it('shows an error toast when agent deletion fails', async () => {
    mockRemoveAgentFromProject.mockRejectedValueOnce(new Error('Delete failed'));
    renderPage();

    fireEvent.click(screen.getByText('Delete'));
    fireEvent.click(
      within(screen.getByTestId('confirm-dialog')).getByRole('button', { name: 'Delete' }),
    );

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Failed to delete agent');
    });
  });

  it('renders server-owned path as read-only with editable description', async () => {
    renderPage();

    const pathInput = await screen.findByLabelText('Agent Path');
    expect(pathInput).toHaveValue('proj-1/default/booking_agent');
    expect(pathInput).toBeDisabled();
    await waitFor(() => {
      expect(screen.getByLabelText('Description')).toHaveValue('Books hotels for travelers');
    });
  });

  it('saves updated metadata from the detail page', async () => {
    mockFetchRuntimeAgent
      .mockResolvedValueOnce({
        agent: {
          id: 'agent-1',
          projectId: 'proj-1',
          name: 'booking_agent',
          agentPath: 'proj-1/default/booking_agent',
          description: 'Books hotels for travelers',
          dslContent: 'AGENT: booking_agent',
          activeVersions: {},
          createdAt: '2026-04-01T00:00:00.000Z',
          updatedAt: '2026-04-01T00:00:00.000Z',
        },
      })
      .mockResolvedValueOnce({
        agent: {
          id: 'agent-1',
          projectId: 'proj-1',
          name: 'booking_agent',
          agentPath: 'proj-1/ops/booking_agent',
          description: 'Handles premium travel bookings',
          dslContent: 'AGENT: booking_agent',
          activeVersions: {},
          createdAt: '2026-04-01T00:00:00.000Z',
          updatedAt: '2026-04-01T00:00:01.000Z',
        },
      });
    mockUpdateProjectAgent.mockResolvedValue({
      id: 'agent-1',
      projectId: 'proj-1',
      name: 'booking_agent',
      agentPath: 'proj-1/ops/booking_agent',
      description: 'Handles premium travel bookings',
    });

    renderPage();

    await screen.findByLabelText('Agent Path');
    const descriptionInput = screen.getByLabelText('Description');

    fireEvent.change(descriptionInput, {
      target: { value: 'Handles premium travel bookings' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(mockUpdateProjectAgent).toHaveBeenCalledWith('proj-1', 'booking_agent', {
        description: 'Handles premium travel bookings',
      });
    });

    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledWith('Agent updated');
    });

    await waitFor(() => {
      expect(screen.getByLabelText('Agent Path')).toHaveValue('proj-1/ops/booking_agent');
    });
  });

  it('shows an error toast when metadata save fails', async () => {
    mockUpdateProjectAgent.mockRejectedValueOnce(new Error('Update failed'));
    renderPage();

    await screen.findByLabelText('Agent Path');
    const descriptionInput = screen.getByLabelText('Description');

    fireEvent.change(descriptionInput, { target: { value: 'Updated description' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Failed to update agent');
    });
  });

  it('shows delete impact warnings for entry-agent and incoming references', async () => {
    mockApiFetch.mockImplementation((input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/projects/proj-1/topology') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              topology: {
                nodes: [{ id: 'booking_agent', name: 'booking_agent', isEntry: true }],
                edges: [
                  { from: 'supervisor_agent', to: 'booking_agent', type: 'handoff' },
                  { from: 'qa_agent', to: 'booking_agent', type: 'delegate' },
                ],
              },
            }),
        });
      }

      if (url === '/api/projects/proj-1/agents/booking_agent/lock' && init?.method === 'POST') {
        return Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({}),
        });
      }

      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}),
      });
    });

    renderPage();

    fireEvent.click(screen.getByText('Delete'));

    const dialog = screen.getByTestId('confirm-dialog');
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText('Current entry agent')).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        "Deleting this agent will clear the project's entry agent selection.",
      ),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(within(dialog).getByText('Other agents still route here')).toBeInTheDocument();
    });
    expect(within(dialog).getByText('supervisor_agent')).toBeInTheDocument();
    expect(within(dialog).getByText('qa_agent')).toBeInTheDocument();
    expect(within(dialog).getByText('handoff')).toBeInTheDocument();
    expect(within(dialog).getByText('delegate')).toBeInTheDocument();
  });
});
