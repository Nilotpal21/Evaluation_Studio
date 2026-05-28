/**
 * AgentListPage entry-agent selector integration tests
 *
 * Uses the real FilterSelect implementation so we exercise the portal-based
 * dropdown interaction end to end from the page surface.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockNavigate = vi.fn();
const mockUpdateProjectStore = vi.fn();
const mockUpdateProjectApi = vi.fn().mockResolvedValue({});
const mockSaveDslWorkingCopy = vi.fn().mockResolvedValue({ success: true, updatedAt: '' });
const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();
const mockMutate = vi.fn();

let swrAgentsReturn: Record<string, unknown> = {};
let swrTopoReturn: Record<string, unknown> = {};

let navStoreState: Record<string, unknown> = {
  projectId: 'proj-1',
  navigate: mockNavigate,
  sidebarCollapsed: false,
  setSidebarCollapsed: vi.fn(),
};

let projectStoreState: Record<string, unknown> = {
  currentProject: {
    id: 'proj-1',
    name: 'Test Project',
    slug: 'test-project',
    entryAgentName: null,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    agentCount: 2,
    sessionCount: 0,
  },
  updateProject: mockUpdateProjectStore,
};

vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (!key) return { data: undefined, error: undefined, isLoading: false, mutate: mockMutate };
    if (key.includes('/topology')) return swrTopoReturn;
    return swrAgentsReturn;
  },
}));

vi.mock('../../store/navigation-store', () => ({
  useNavigationStore: vi.fn((sel?: (s: Record<string, unknown>) => unknown) =>
    sel ? sel(navStoreState) : navStoreState,
  ),
}));

vi.mock('../../store/project-store', () => ({
  useProjectStore: vi.fn((sel?: (s: Record<string, unknown>) => unknown) =>
    sel ? sel(projectStoreState) : projectStoreState,
  ),
}));

vi.mock('../../api/projects', () => ({
  updateProject: (...args: unknown[]) => mockUpdateProjectApi(...args),
  fetchProject: vi.fn(() => Promise.resolve({})),
}));

vi.mock('../../api/runtime-agents', () => ({
  parseActiveVersions: (av: Record<string, string> | string | null | undefined) => {
    if (!av) return {};
    if (typeof av === 'string') {
      try {
        return JSON.parse(av);
      } catch {
        return {};
      }
    }
    return av;
  },
  saveDslWorkingCopy: (...args: unknown[]) => mockSaveDslWorkingCopy(...args),
}));

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

vi.mock('../../components/ui/ListPageShell', () => ({
  ListPageShell: ({ children, secondaryActions, filterBar }: any) => (
    <div data-testid="list-page-shell">
      {secondaryActions && <div data-testid="shell-secondary-actions">{secondaryActions}</div>}
      {filterBar && <div data-testid="shell-filter-bar">{filterBar}</div>}
      <div>{children}</div>
    </div>
  ),
}));

vi.mock('../../components/ui/Button', () => ({
  Button: ({ children, onClick, ...props }: any) => (
    <button onClick={onClick} {...props}>
      {children}
    </button>
  ),
}));

vi.mock('../../components/ui/EmptyState', () => ({
  EmptyState: ({ title }: any) => <div>{title}</div>,
}));

vi.mock('../../components/agents/AgentCard', () => ({
  AgentCard: ({ agent }: any) => <div>{agent.name}</div>,
}));

vi.mock('../../components/agents/AgentMiniTopology', () => ({
  AgentMiniTopology: () => <div data-testid="agent-mini-topology" />,
}));

vi.mock('../../components/agents/TopologySkeleton', () => ({
  TopologySkeleton: () => <div data-testid="topology-skeleton" />,
}));

vi.mock('../../components/agents/AgentCardSkeleton', () => ({
  AgentCardSkeletonGrid: () => <div data-testid="agent-card-skeleton-grid" />,
}));

vi.mock('../../components/agents/CreateAgentDialog', () => ({
  CreateAgentDialog: () => null,
}));

vi.mock('../../components/projects/ImportDialog', () => ({
  ImportDialog: () => null,
}));

vi.mock('../../components/agent-editor', () => ({
  AgentEditorSlider: () => null,
}));

vi.mock('../../components/agent-editor/agent-editor-config', () => ({
  AGENT_EDITOR_CONFIG: {
    containerMode: 'slider' as const,
    listViewMode: 'page' as const,
    canvasViewMode: 'slider' as const,
  },
}));

vi.mock('../../components/canvas/ProjectCanvas', () => ({
  ProjectCanvas: () => <div data-testid="project-canvas" />,
}));

vi.mock('../../lib/agent-canvas/dsl-updater', () => ({
  addHandoff: vi.fn(),
  addDelegate: vi.fn(),
}));

import { AgentListPage } from '../../components/agents/AgentListPage';

function makeAgent(
  name: string,
  overrides: Partial<{
    id: string;
    description: string | null;
    dslContent: string | null;
    activeVersions: Record<string, string> | string;
  }> = {},
) {
  return {
    id: overrides.id ?? name,
    name,
    agentPath: `/agents/${name}`,
    description: overrides.description ?? null,
    dslContent: overrides.dslContent ?? `AGENT: ${name}`,
    activeVersions: overrides.activeVersions ?? {},
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  swrAgentsReturn = {
    data: {
      agents: [makeAgent('draft_agent'), makeAgent('live_agent')],
    },
    error: undefined,
    isLoading: false,
    mutate: mockMutate,
  };
  swrTopoReturn = {
    data: {
      topology: {
        nodes: [],
        edges: [],
      },
      agentSummaries: {},
    },
    isLoading: false,
    mutate: mockMutate,
  };
  projectStoreState = {
    currentProject: {
      id: 'proj-1',
      name: 'Test Project',
      slug: 'test-project',
      entryAgentName: null,
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
      agentCount: 2,
      sessionCount: 0,
    },
    updateProject: mockUpdateProjectStore,
  };
});

describe('AgentListPage entry-agent selector', () => {
  it('updates the project when selecting an entry agent from the real dropdown', async () => {
    const user = userEvent.setup();

    render(<AgentListPage />);

    const toolbar = screen.getByTestId('entry-agent-list-toolbar');
    await user.click(within(toolbar).getByRole('button', { name: /auto-detect/i }));
    await user.click(screen.getByRole('button', { name: /^live agent$/i }));

    await waitFor(() => {
      expect(mockUpdateProjectApi).toHaveBeenCalledWith('proj-1', {
        entryAgentName: 'live_agent',
      });
    });
    expect(mockUpdateProjectStore).toHaveBeenCalledWith('proj-1', {
      entryAgentName: 'live_agent',
    });
    expect(mockToastSuccess).toHaveBeenCalled();
    expect(within(screen.getByTestId('shell-filter-bar')).queryByText('Start Agent')).toBeNull();
  });
});
