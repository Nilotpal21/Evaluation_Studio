import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useModuleStore } from '../../store/module-store';

const mockNavigate = vi.fn();
const mockSetTools = vi.fn();
const mockSetLoading = vi.fn();
const mockSetError = vi.fn();
const mockSetSearchQuery = vi.fn();
const mockSetServers = vi.fn();
const mockSetServersLoading = vi.fn();
const mockSetServersError = vi.fn();
const mockFetchTools = vi.fn();
const mockImportTool = vi.fn();
const mockFetchMcpServers = vi.fn();
const mockFetchVariableNamespaces = vi.fn();
const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();

const toolStoreState = {
  tools: [
    {
      id: 'tool-1',
      name: 'weather_tool',
      slug: 'weather_tool',
      toolType: 'http' as const,
      description: 'Weather lookup',
      dslContent: 'weather_tool() -> object\n  type: http',
      sourceHash: 'hash',
      variableNamespaceIds: [],
      projectId: 'proj-1',
      createdBy: 'Test User',
      lastEditedBy: 'Test User',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    },
  ],
  isLoading: false,
  error: null,
  pagination: { page: 1, limit: 12, total: 1, hasMore: false },
  searchQuery: '',
  httpCount: 1,
  sandboxCount: 0,
  mcpCount: 0,
  searchaiCount: 0,
  setTools: mockSetTools,
  setLoading: mockSetLoading,
  setError: mockSetError,
  setSearchQuery: mockSetSearchQuery,
};

const mcpServerStoreState = {
  servers: [],
  setServers: mockSetServers,
  setLoading: mockSetServersLoading,
  setError: mockSetServersError,
};

vi.mock('../../store/project-store', () => ({
  useProjectStore: vi.fn((selector?: (state: Record<string, unknown>) => unknown) => {
    const state = {
      currentProject: {
        id: 'proj-1',
        name: 'Test Project',
      },
    };
    return selector ? selector(state) : state;
  }),
}));

vi.mock('../../store/navigation-store', () => ({
  useNavigationStore: vi.fn((selector?: (state: Record<string, unknown>) => unknown) => {
    const state = { navigate: mockNavigate };
    return selector ? selector(state) : state;
  }),
}));

vi.mock('../../store/tool-store', () => ({
  useToolStore: vi.fn((selector?: (state: typeof toolStoreState) => unknown) =>
    selector ? selector(toolStoreState) : toolStoreState,
  ),
}));

vi.mock('../../store/mcp-server-store', () => ({
  useMcpServerStore: vi.fn((selector?: (state: typeof mcpServerStoreState) => unknown) =>
    selector ? selector(mcpServerStoreState) : mcpServerStoreState,
  ),
}));

vi.mock('../../api/tools', () => ({
  fetchTools: (...args: unknown[]) => mockFetchTools(...args),
  deleteTool: vi.fn(),
  duplicateTool: vi.fn(),
  importTool: (...args: unknown[]) => mockImportTool(...args),
  testTool: vi.fn(),
}));

vi.mock('../../api/mcp-servers', () => ({
  fetchMcpServers: (...args: unknown[]) => mockFetchMcpServers(...args),
  deleteMcpServer: vi.fn(),
  testMcpServerConnection: vi.fn(),
}));

vi.mock('../../api/variable-namespaces', () => ({
  fetchVariableNamespaces: (...args: unknown[]) => mockFetchVariableNamespaces(...args),
}));

vi.mock('../../hooks/use-features', () => ({
  useFeatures: () => ({ hasCodeTools: true }),
}));

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

vi.mock('../../components/ui/ListPageShell', () => ({
  ListPageShell: ({
    children,
    secondaryActions,
    primaryAction,
  }: {
    children: ReactNode;
    secondaryActions?: ReactNode;
    primaryAction?: ReactNode;
  }) => (
    <div data-testid="list-page-shell">
      <div data-testid="shell-secondary-actions">{secondaryActions}</div>
      <div data-testid="shell-primary-action">{primaryAction}</div>
      <div>{children}</div>
    </div>
  ),
}));

vi.mock('../../components/ui/Button', () => ({
  Button: ({
    children,
    onClick,
    loading: _loading,
    ...props
  }: {
    children: ReactNode;
    onClick?: () => void;
    loading?: boolean;
  }) => (
    <button onClick={onClick} {...props}>
      {children}
    </button>
  ),
}));

vi.mock('../../components/ui/Tabs', () => ({
  Tabs: () => <div data-testid="tabs" />,
}));

vi.mock('../../components/ui/EmptyState', () => ({
  EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
}));

vi.mock('../../components/ui/ErrorAlert', () => ({
  ErrorAlert: ({ error }: { error: string | string[] | null }) =>
    error ? <div>{Array.isArray(error) ? error.join(', ') : error}</div> : null,
}));

vi.mock('../../components/tools/ToolCard', () => ({
  ToolCard: ({ tool }: { tool: { name: string } }) => <div>{tool.name}</div>,
}));

vi.mock('../../components/tools/ToolPreviewDialog', () => ({
  ToolPreviewDialog: () => null,
}));

vi.mock('../../components/tools/TestToolDialog', () => ({
  TestToolDialog: () => null,
}));

vi.mock('../../components/tools/NewToolDropdown', () => ({
  NewToolDropdown: () => <button>New Tool</button>,
}));

vi.mock('../../components/mcp-servers/McpServerCard', () => ({
  McpServerCard: () => null,
}));

vi.mock('../../components/mcp-servers/McpServerCreateDialog', () => ({
  McpServerCreateDialog: ({
    onClose,
    onCreated,
  }: {
    onClose: () => void;
    onCreated: (server: { id: string; name: string }) => void;
  }) => (
    <div>
      <button onClick={onClose}>Cancel MCP server creation</button>
      <button onClick={() => onCreated({ id: 'server-1', name: 'Weather MCP' })}>
        Register mocked MCP server
      </button>
    </div>
  ),
}));

import { ToolsListPage } from '../../components/tools/ToolsListPage';

beforeEach(() => {
  vi.clearAllMocks();
  window.history.pushState({}, '', '/projects/proj-1/tools');
  useModuleStore.getState().reset();
  mockFetchTools.mockResolvedValue({
    success: true,
    data: toolStoreState.tools,
    pagination: toolStoreState.pagination,
  });
  mockFetchMcpServers.mockResolvedValue({ servers: [] });
  mockFetchVariableNamespaces.mockResolvedValue({ namespaces: [] });
});

afterEach(() => {
  useModuleStore.getState().reset();
});

function makeJsonFile(content: string, name = 'tool-export.json') {
  const file = new File(['placeholder'], name, { type: 'application/json' });
  Object.defineProperty(file, 'text', {
    configurable: true,
    value: () => Promise.resolve(content),
  });
  return file;
}

describe('ToolsListPage import action', () => {
  it('keeps imported module tools out of the standard inventory page', async () => {
    useModuleStore.setState({
      dependencies: [
        {
          id: 'dep-helpdesk',
          alias: 'helpdesk',
          moduleProjectId: 'module-helpdesk',
          moduleProjectName: 'Helpdesk Module',
          selector: { type: 'version', value: '2.1.0' },
          resolvedReleaseId: 'rel-helpdesk-1',
          resolvedVersion: '2.1.0',
          configOverrides: {},
          contractSnapshot: {
            providedAgents: [{ name: 'triage_agent' }],
            providedTools: [{ name: 'search_docs' }],
          },
          createdAt: '2026-04-15T00:00:00.000Z',
          createdBy: 'user-1',
        },
      ],
    });

    render(<ToolsListPage />);

    await waitFor(() => expect(mockFetchTools).toHaveBeenCalled());

    expect(screen.getByText('weather_tool')).toBeInTheDocument();
    expect(screen.getByText('helpdesk.search_docs')).toBeInTheDocument();
  });

  it('shows a toast and console error when variable namespace loading fails', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const variableNamespaceError = new Error('variable namespace fetch failed');
    mockFetchVariableNamespaces.mockRejectedValueOnce(variableNamespaceError);

    render(<ToolsListPage />);

    await waitFor(() => {
      expect(mockFetchVariableNamespaces).toHaveBeenCalledWith('proj-1');
    });

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Failed to load variable namespaces');
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Failed to load variable namespaces:',
      variableNamespaceError,
    );
  });

  it('imports a tool export file and navigates to the imported tool', async () => {
    mockImportTool.mockResolvedValue({
      success: true,
      tool: {
        ...toolStoreState.tools[0],
        id: 'tool-2',
        name: 'imported_weather_tool',
        slug: 'imported_weather_tool',
      },
    });

    render(<ToolsListPage />);

    await waitFor(() => expect(mockFetchTools).toHaveBeenCalled());
    vi.clearAllMocks();

    const payload = {
      tool: {
        name: 'imported_weather_tool',
        toolType: 'http',
        dslContent: 'imported_weather_tool() -> object\n  type: http',
      },
    };

    fireEvent.change(screen.getByTestId('tool-import-input'), {
      target: { files: [makeJsonFile(JSON.stringify(payload))] },
    });

    await waitFor(() => {
      expect(mockImportTool).toHaveBeenCalledWith('proj-1', payload);
    });
    expect(mockNavigate).toHaveBeenCalledWith('/projects/proj-1/tools/tool-2');
    expect(mockToastSuccess).toHaveBeenCalledWith('"imported_weather_tool" imported');
  });

  it('shows a user-friendly error when the uploaded file is not valid JSON', async () => {
    render(<ToolsListPage />);

    await waitFor(() => expect(mockFetchTools).toHaveBeenCalled());
    vi.clearAllMocks();

    fireEvent.change(screen.getByTestId('tool-import-input'), {
      target: { files: [makeJsonFile('not-json')] },
    });

    await waitFor(() => {
      expect(mockSetError).toHaveBeenLastCalledWith([
        'Invalid tool export file. Upload a JSON export from Studio.',
      ]);
    });
    expect(mockImportTool).not.toHaveBeenCalled();
  });
});

describe('ToolsListPage agent Tools return navigation (ABLP-839)', () => {
  const agentToolsReturnPath = '/projects/proj-1/agents/ShopAssist_Supervisor#tools';

  it('returns to the originating agent Tools section when MCP server creation is cancelled', async () => {
    window.history.pushState(
      {},
      '',
      `/projects/proj-1/tools?tab=mcp&returnTo=${encodeURIComponent(agentToolsReturnPath)}`,
    );

    render(<ToolsListPage />);

    fireEvent.click(await screen.findByRole('button', { name: /register server/i }));
    fireEvent.click(screen.getByRole('button', { name: /cancel mcp server creation/i }));

    expect(mockNavigate).toHaveBeenCalledWith(agentToolsReturnPath, { replace: true });
  });

  it('returns to the originating agent Tools section after MCP server creation succeeds', async () => {
    window.history.pushState(
      {},
      '',
      `/projects/proj-1/tools?tab=mcp&returnTo=${encodeURIComponent(agentToolsReturnPath)}`,
    );

    render(<ToolsListPage />);

    fireEvent.click(await screen.findByRole('button', { name: /register server/i }));
    fireEvent.click(screen.getByRole('button', { name: /register mocked mcp server/i }));

    expect(mockNavigate).toHaveBeenCalledWith(agentToolsReturnPath, { replace: true });
  });

  it('falls back to the MCP server detail when the return target is cross-project', async () => {
    window.history.pushState(
      {},
      '',
      `/projects/proj-1/tools?tab=mcp&returnTo=${encodeURIComponent(
        '/projects/proj-2/agents/ShopAssist_Supervisor#tools',
      )}`,
    );

    render(<ToolsListPage />);

    fireEvent.click(await screen.findByRole('button', { name: /register server/i }));
    fireEvent.click(screen.getByRole('button', { name: /register mocked mcp server/i }));

    expect(mockNavigate).toHaveBeenCalledWith('/projects/proj-1/mcp-servers/server-1');
  });
});
