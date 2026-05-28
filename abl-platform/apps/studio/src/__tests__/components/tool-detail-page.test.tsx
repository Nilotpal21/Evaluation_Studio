import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PropsWithChildren } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockNavigate = vi.fn();
const mockSetCurrentTool = vi.fn();
const mockRemoveTool = vi.fn();
const mockFetchTool = vi.fn();
const mockDeleteTool = vi.fn();
const mockExportTool = vi.fn();
const mockTestTool = vi.fn();
const mockFetchVariableNamespaces = vi.fn();
const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();

const baseTool = {
  id: 'tool-1',
  name: 'weather_tool',
  slug: 'weather_tool',
  toolType: 'http' as const,
  description: 'Weather lookup',
  dslContent:
    'weather_tool() -> object\n  type: http\n  endpoint: "https://api.example.com/weather"',
  sourceHash: 'hash',
  variableNamespaceIds: [],
  projectId: 'proj-1',
  createdBy: 'Test User',
  lastEditedBy: 'Test User',
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-02T00:00:00.000Z',
};

const toolStoreState = {
  currentTool: baseTool,
  setCurrentTool: mockSetCurrentTool,
  removeTool: mockRemoveTool,
  updateToolInList: vi.fn(),
};

vi.mock('../../store/project-store', () => ({
  useProjectStore: () => ({
    currentProject: { id: 'proj-1' },
  }),
}));

vi.mock('../../store/navigation-store', () => ({
  useNavigationStore: () => ({
    navigate: mockNavigate,
    subPage: 'tool-1',
  }),
}));

vi.mock('../../store/tool-store', () => ({
  useToolStore: Object.assign(() => toolStoreState, {
    getState: () => toolStoreState,
  }),
}));

vi.mock('../../api/tools', () => ({
  fetchTool: (...args: unknown[]) => mockFetchTool(...args),
  updateTool: vi.fn(),
  deleteTool: (...args: unknown[]) => mockDeleteTool(...args),
  exportTool: (...args: unknown[]) => mockExportTool(...args),
  testTool: (...args: unknown[]) => mockTestTool(...args),
}));

vi.mock('../../api/variable-namespaces', () => ({
  fetchVariableNamespaces: (...args: unknown[]) => mockFetchVariableNamespaces(...args),
}));

vi.mock('../../hooks/use-features', () => ({
  useFeatures: () => ({ hasCodeTools: true }),
}));

vi.mock('../../components/tools/sections/ToolTestingSection', () => ({
  ToolTestingSection: () => <div data-testid="tool-testing-section" />,
}));

vi.mock('../../components/tools/TestToolDialog', () => ({
  TestToolDialog: () => null,
}));

vi.mock('../../components/tools/HttpConfigForm', () => ({
  HttpConfigForm: () => <div data-testid="http-config-form" />,
  validateHttpConfig: vi.fn(() => ({})),
}));

vi.mock('../../components/tools/SandboxConfigForm', () => ({
  SandboxConfigForm: () => <div data-testid="sandbox-config-form" />,
  validateSandboxConfig: vi.fn(() => ({})),
}));

vi.mock('../../components/tools/McpConfigForm', () => ({
  McpConfigForm: () => <div data-testid="mcp-config-form" />,
  validateMcpConfig: vi.fn(() => ({})),
}));

vi.mock('../../components/tools/form-adapters', () => ({
  toolFormToHttpConfig: vi.fn(() => ({ endpoint: 'https://api.example.com/weather' })),
  toolFormToSandboxConfig: vi.fn(() => ({ runtime: 'javascript' })),
  toolFormToMcpConfig: vi.fn(() => ({ server: 'server-1' })),
  httpConfigToToolForm: vi.fn(),
  sandboxConfigToToolForm: vi.fn(),
  mcpConfigToToolForm: vi.fn(),
}));

vi.mock('../../components/tools/tool-utils', () => ({
  buildInputSchemaFromTool: vi.fn(() => ({ type: 'object', properties: {} })),
}));

vi.mock('../../components/ui/SegmentedControl', () => ({
  SegmentedControl: () => <div data-testid="segmented-control" />,
}));

vi.mock('../../components/ui/ConfirmDialog', () => ({
  ConfirmDialog: ({
    open,
    title,
    description,
    onConfirm,
    onClose,
    confirmLabel,
    children,
  }: PropsWithChildren<{
    open: boolean;
    title: string;
    description: string;
    onConfirm: () => void;
    onClose: () => void;
    confirmLabel?: string;
  }>) =>
    open ? (
      <div data-testid="confirm-dialog">
        <div>{title}</div>
        <div>{description}</div>
        {children}
        <button onClick={onClose}>Cancel</button>
        <button onClick={onConfirm}>{confirmLabel ?? 'Confirm'}</button>
      </div>
    ) : null,
}));

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

vi.mock('@agent-platform/shared/tools', () => ({
  parseDslToToolForm: vi.fn(() => ({
    toolType: 'http',
    name: 'weather_tool',
    description: 'Weather lookup',
  })),
  parseDslProperties: vi.fn(() => ({})),
  serializeToolFormToDsl: vi.fn(() => 'weather_tool() -> object\n  type: http'),
}));

vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => (
      <div {...props}>{children}</div>
    ),
  },
  AnimatePresence: ({ children }: PropsWithChildren) => <>{children}</>,
}));

import { ToolDetailPage } from '../../components/tools/ToolDetailPage';

function getButtonByText(label: string) {
  const button = screen.getByText(label).closest('button');
  expect(button).not.toBeNull();
  return button as HTMLButtonElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  toolStoreState.currentTool = baseTool;
  mockFetchTool.mockResolvedValue({ success: true, tool: baseTool });
  mockFetchVariableNamespaces.mockResolvedValue({ namespaces: [] });
  mockTestTool.mockResolvedValue({ result: { output: { ok: true }, latencyMs: 10, logs: [] } });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn() },
  });
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:tool-export'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ToolDetailPage', () => {
  it('surfaces variable namespace loading failures instead of swallowing them', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetchVariableNamespaces.mockRejectedValueOnce(new Error('variable namespace fetch failed'));

    render(<ToolDetailPage />);

    await waitFor(() => {
      expect(mockFetchVariableNamespaces).toHaveBeenCalledWith('proj-1');
    });

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalled();
    });
    expect(mockToastError).toHaveBeenCalledWith(expect.any(String));
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('exports the current tool from the detail header', async () => {
    const user = userEvent.setup();
    mockExportTool.mockResolvedValue({
      success: true,
      export: {
        exportVersion: 2,
        tool: { name: 'weather_tool', toolType: 'http' },
      },
    });

    const anchor = document.createElement('a');
    const clickSpy = vi.spyOn(anchor, 'click').mockImplementation(() => {});
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) =>
      tagName === 'a' ? anchor : originalCreateElement(tagName),
    );
    const appendSpy = vi.spyOn(document.body, 'appendChild');
    const removeSpy = vi.spyOn(document.body, 'removeChild');

    render(<ToolDetailPage />);

    await screen.findByText('Export');
    await user.click(getButtonByText('Export'));

    await waitFor(() => {
      expect(mockExportTool).toHaveBeenCalledWith('proj-1', 'tool-1');
    });
    expect(anchor.download).toBe('weather_tool.tool.json');
    expect(clickSpy).toHaveBeenCalled();
    expect(appendSpy).toHaveBeenCalledWith(anchor);
    expect(removeSpy).toHaveBeenCalledWith(anchor);
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:tool-export');
    expect(mockToastSuccess).toHaveBeenCalledWith('Tool export downloaded');
  });

  it('masks HTTP auth secrets in the raw DSL preview', async () => {
    const user = userEvent.setup();
    const exposedApiKey = 'sk-live-super-secret-api-key-1234567890';
    const sensitiveDsl = [
      'weather_tool() -> object',
      '  type: http',
      '  endpoint: "https://api.example.com/weather"',
      '  auth: api_key',
      '  auth_config:',
      '    header_name: "X-API-Key"',
      `    api_key: "${exposedApiKey}"`,
    ].join('\n');
    const sensitiveTool = {
      ...baseTool,
      dslContent: sensitiveDsl,
    };
    toolStoreState.currentTool = sensitiveTool;
    mockFetchTool.mockResolvedValueOnce({ success: true, tool: sensitiveTool });

    render(<ToolDetailPage />);

    await screen.findByText('View Raw ABL');
    await user.click(screen.getByText('View Raw ABL'));

    expect(screen.getByText(/api_key:/)).toBeInTheDocument();
    expect(screen.queryByText(exposedApiKey, { exact: false })).not.toBeInTheDocument();
    expect(screen.getByText(/\*{3}REDACTED\*{3}|••••••/)).toBeInTheDocument();
  });

  it('offers a force-delete confirmation when agent references block deletion', async () => {
    const user = userEvent.setup();
    mockDeleteTool
      .mockRejectedValueOnce(
        Object.assign(
          new Error(
            'Cannot delete tool "weather_tool" — it is used by 2 agent(s): booking_agent, billing_agent. Use ?force=true to delete anyway.',
          ),
          { statusCode: 409 },
        ),
      )
      .mockResolvedValueOnce(undefined);

    render(<ToolDetailPage />);

    await screen.findByText('Delete');
    await user.click(getButtonByText('Delete'));
    await user.click(
      within(screen.getByTestId('confirm-dialog')).getByRole('button', { name: 'Delete Tool' }),
    );

    await screen.findByText('Delete Tool Anyway?');
    const forceDeleteDialog = screen.getByTestId('confirm-dialog');
    expect(within(forceDeleteDialog).getByText('Delete Tool Anyway?')).toBeInTheDocument();
    expect(within(forceDeleteDialog).getByText('booking_agent')).toBeInTheDocument();
    expect(within(forceDeleteDialog).getByText('billing_agent')).toBeInTheDocument();

    await user.click(within(forceDeleteDialog).getByRole('button', { name: 'Delete Anyway' }));

    await waitFor(() => {
      expect(mockDeleteTool).toHaveBeenNthCalledWith(1, 'proj-1', 'tool-1', undefined);
      expect(mockDeleteTool).toHaveBeenNthCalledWith(2, 'proj-1', 'tool-1', { force: true });
    });
    expect(mockRemoveTool).toHaveBeenCalledWith('tool-1');
    expect(mockNavigate).toHaveBeenCalledWith('/projects/proj-1/tools');
    expect(mockToastSuccess).toHaveBeenCalledWith('Tool deleted');
  });
});
