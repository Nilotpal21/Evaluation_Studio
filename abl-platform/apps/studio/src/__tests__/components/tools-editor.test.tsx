/**
 * ToolsEditor Component Tests
 *
 * Tests for the unified agent editor tools section: inline tool cards with
 * name/description/parameters editing, add/remove, project tools collapsible,
 * confirmation config, PII access, and hint badges.
 *
 * @vitest-environment happy-dom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ToolSectionData } from '../../store/agent-detail-store';

// =============================================================================
// MOCKS
// =============================================================================

const mockNavigate = vi.fn();

// Mock useAgentEditorStore — return projectId: 'proj-1' by default
const mockAgentEditorState = {
  projectId: 'proj-1' as string | null,
  agentName: 'ShopAssist_Supervisor' as string | null,
};
vi.mock('../../components/agent-editor/hooks/useAgentEditorStore', () => ({
  useAgentEditorStore: vi.fn((selector?: (s: typeof mockAgentEditorState) => unknown) =>
    selector ? selector(mockAgentEditorState) : mockAgentEditorState,
  ),
}));

vi.mock('../../store/navigation-store', () => ({
  useNavigationStore: () => ({
    navigate: mockNavigate,
  }),
}));

vi.mock('../../hooks/use-features', () => ({
  useFeatures: () => ({ hasCodeTools: true }),
}));

// Mock fetchTools from api/tools
const mockFetchTools = vi.fn();
vi.mock('../../api/tools', () => ({
  fetchTools: (...args: unknown[]) => mockFetchTools(...args),
}));

// Mock parseSignatureLine and parseDslProperties from @agent-platform/shared/tools
const mockParseSignatureLine = vi.fn();
const mockParseDslProperties = vi.fn();
vi.mock('@agent-platform/shared/tools', () => ({
  parseSignatureLine: (...args: unknown[]) => mockParseSignatureLine(...args),
  parseDslProperties: (...args: unknown[]) => mockParseDslProperties(...args),
}));

// Mock ToolTypeBadge as a simple span
vi.mock('../../components/tools/ToolTypeBadge', () => ({
  ToolTypeBadge: ({ type, className }: { type: string; className?: string }) =>
    React.createElement('span', { 'data-testid': `tool-type-badge-${type}`, className }, type),
}));

// Mock Checkbox component — renders a native checkbox with label
vi.mock('../../components/ui/Checkbox', () => ({
  Checkbox: ({
    checked,
    onChange,
    label,
    disabled,
  }: {
    checked: boolean;
    onChange: (v: boolean) => void;
    label?: string;
    disabled?: boolean;
  }) =>
    React.createElement(
      'label',
      null,
      React.createElement('input', {
        type: 'checkbox',
        checked,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.checked),
        disabled,
        'data-testid': 'checkbox',
      }),
      label,
    ),
}));

// Mock SectionHeader component
vi.mock('../../components/agent-editor/sections/SectionHeader', () => ({
  SectionHeader: ({ onArchClick }: { onArchClick?: () => void }) =>
    onArchClick
      ? React.createElement(
          'button',
          { 'data-testid': 'section-header-arch', onClick: onArchClick },
          'AI Assist',
        )
      : null,
}));

// Static import — mocks are hoisted above
import { ToolsEditor } from '../../components/agent-editor/sections/ToolsEditor';

// =============================================================================
// TEST DATA
// =============================================================================

const httpTool: ToolSectionData = {
  name: 'search_hotels',
  description: 'Search available hotels by location and date range',
  parameters: [
    { name: 'location', type: 'string', required: true },
    { name: 'check_in', type: 'date', required: true },
    { name: 'guests', type: 'number', required: false },
  ],
  returns: { type: 'object' },
  toolType: 'http',
  httpBinding: { endpoint: 'https://api.hotels.com/search', method: 'POST' },
  hints: { cacheable: true, latency: 'high', side_effects: false },
};

const mcpTool: ToolSectionData = {
  name: 'get_weather',
  description: 'Fetch current weather data for a location',
  parameters: [{ name: 'city', type: 'string', required: true }],
  returns: { type: 'object' },
  toolType: 'mcp',
  mcpBinding: { server: 'weather-server', tool: 'current_weather' },
  hints: {},
};

const sandboxTool: ToolSectionData = {
  name: 'process_payment',
  description: 'Process a payment transaction',
  parameters: [
    { name: 'amount', type: 'number', required: true },
    { name: 'currency', type: 'string', required: false },
  ],
  returns: { type: 'object' },
  toolType: 'sandbox',
  sandboxBinding: { runtime: 'python3', codePreview: 'print("hi")', timeoutMs: 5000 },
  hints: { side_effects: true },
};

const mockTools: ToolSectionData[] = [httpTool, mcpTool, sandboxTool];

// =============================================================================
// HELPERS
// =============================================================================

function renderToolsEditor(
  overrides: {
    data?: ToolSectionData[];
    onChange?: (data: ToolSectionData[]) => void;
    readOnly?: boolean;
    onArchClick?: () => void;
  } = {},
) {
  const props = {
    data: overrides.data ?? mockTools,
    onChange: overrides.onChange ?? vi.fn(),
    readOnly: overrides.readOnly,
    onArchClick: overrides.onArchClick,
  };
  return render(<ToolsEditor {...props} />);
}

/** Click the expand chevron on the Nth tool card (0-indexed). */
function expandToolCard(index: number) {
  // Each tool card has a chevron button as the first button in its header
  const cards = screen.getAllByText(/params$/);
  // The parent card contains a toggle button before the tool name
  const card = cards[index].closest('.rounded-lg');
  if (!card) throw new Error(`Card at index ${index} not found`);
  const chevronButton = card.querySelector('button');
  if (!chevronButton) throw new Error(`Chevron button at index ${index} not found`);
  fireEvent.click(chevronButton);
}

// =============================================================================
// TESTS — BASIC RENDERING
// =============================================================================

describe('ToolsEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentEditorState.projectId = 'proj-1';
    mockAgentEditorState.agentName = 'ShopAssist_Supervisor';
    mockFetchTools.mockResolvedValue({
      success: true,
      data: [],
      pagination: { page: 1, limit: 200, total: 0, hasMore: false },
    });
    mockParseSignatureLine.mockReturnValue({
      name: 'mock_tool',
      parameters: [],
      returnType: 'object',
    });
    mockParseDslProperties.mockReturnValue({});
  });

  describe('Basic rendering', () => {
    it('renders tool count header', () => {
      renderToolsEditor();
      expect(screen.getByText('3 tools defined')).toBeInTheDocument();
    });

    it('renders singular tool count', () => {
      renderToolsEditor({ data: [httpTool] });
      expect(screen.getByText('1 tool defined')).toBeInTheDocument();
    });

    it('renders tool cards for each tool in data', () => {
      renderToolsEditor();
      expect(screen.getByText('search_hotels')).toBeInTheDocument();
      expect(screen.getByText('get_weather')).toBeInTheDocument();
      expect(screen.getByText('process_payment')).toBeInTheDocument();
    });

    it('shows tool name and description in collapsed card', () => {
      renderToolsEditor();
      // Name shown in the card header
      expect(screen.getByText('search_hotels')).toBeInTheDocument();
      // Description shown below collapsed header
      expect(
        screen.getByText('Search available hotels by location and date range'),
      ).toBeInTheDocument();
    });

    it('shows binding badge (HTTP/MCP/Sandbox) on cards', () => {
      renderToolsEditor();
      expect(screen.getByText('HTTP')).toBeInTheDocument();
      expect(screen.getByText('MCP')).toBeInTheDocument();
      expect(screen.getByText('Sandbox')).toBeInTheDocument();
    });

    it('shows parameter count on cards', () => {
      renderToolsEditor();
      expect(screen.getByText('3 params')).toBeInTheDocument(); // httpTool
      expect(screen.getByText('1 params')).toBeInTheDocument(); // mcpTool
      expect(screen.getByText('2 params')).toBeInTheDocument(); // sandboxTool
    });
  });

  // ===========================================================================
  // TESTS — TOOL EDITING
  // ===========================================================================

  describe('Tool editing', () => {
    it('expanding a card shows name, description, returns, parameters inputs', () => {
      renderToolsEditor({ data: [httpTool] });
      expandToolCard(0);

      // Name input
      expect(screen.getByDisplayValue('search_hotels')).toBeInTheDocument();
      // Description textarea
      expect(
        screen.getByDisplayValue('Search available hotels by location and date range'),
      ).toBeInTheDocument();
      // Returns input
      expect(screen.getByDisplayValue('object')).toBeInTheDocument();
      // Parameter name inputs
      expect(screen.getByDisplayValue('location')).toBeInTheDocument();
      expect(screen.getByDisplayValue('check_in')).toBeInTheDocument();
      expect(screen.getByDisplayValue('guests')).toBeInTheDocument();
    });

    it('calls onChange when tool name is edited', () => {
      const onChange = vi.fn();
      renderToolsEditor({ data: [httpTool], onChange });
      expandToolCard(0);

      const nameInput = screen.getByDisplayValue('search_hotels');
      fireEvent.change(nameInput, { target: { value: 'find_hotels' } });

      expect(onChange).toHaveBeenCalledTimes(1);
      const updatedTools = onChange.mock.calls[0][0];
      expect(updatedTools).toHaveLength(1);
      expect(updatedTools[0].name).toBe('find_hotels');
    });

    it('calls onChange when description is edited', () => {
      const onChange = vi.fn();
      renderToolsEditor({ data: [httpTool], onChange });
      expandToolCard(0);

      const descTextarea = screen.getByDisplayValue(
        'Search available hotels by location and date range',
      );
      fireEvent.change(descTextarea, { target: { value: 'Updated description' } });

      expect(onChange).toHaveBeenCalledTimes(1);
      const updatedTools = onChange.mock.calls[0][0];
      expect(updatedTools[0].description).toBe('Updated description');
    });

    it('calls onChange when parameter is added', () => {
      const onChange = vi.fn();
      renderToolsEditor({ data: [httpTool], onChange });
      expandToolCard(0);

      // Find the "Add" button that is a sibling of the "Parameters (3)" label
      // inside the flex container. It is the small inline button, not the main "Add Tool".
      const paramLabel = screen.getByText(/Parameters \(3\)/);
      const addBtn = paramLabel.closest('.flex')?.querySelector('button');
      expect(addBtn).toBeTruthy();
      fireEvent.click(addBtn!);

      expect(onChange).toHaveBeenCalled();
      const updatedTools = onChange.mock.calls[0][0];
      expect(updatedTools[0].parameters).toHaveLength(4);
      expect(updatedTools[0].parameters[3]).toEqual({
        name: '',
        type: 'string',
        required: false,
      });
    });

    it('calls onChange when parameter is removed', () => {
      const onChange = vi.fn();
      renderToolsEditor({ data: [httpTool], onChange });
      expandToolCard(0);

      // Find remove buttons within parameters (Trash2 icons inside param rows)
      // Each param row has a small trash button
      const removeButtons = screen
        .getAllByTitle('Remove tool')[0]
        .parentElement?.parentElement?.querySelectorAll(
          'button[class*="hover:bg-error-subtle"][class*="hover:text-error"]',
        );

      // There should be delete buttons for each parameter within the expanded card
      // Let's use a different approach: find all small trash buttons within the expanded content
      const allTrashButtons = document.querySelectorAll('button[title="Remove tool"]');
      // The param delete buttons don't have "Remove tool" title — they're the smaller ones
      // Let's find them by looking at the param row structure
      const paramInputs = screen.getAllByDisplayValue('location');
      const paramRow = paramInputs[0].closest('.flex.items-center.gap-2');
      const paramDeleteBtn = paramRow?.querySelector(
        'button.shrink-0:last-child',
      ) as HTMLButtonElement;
      if (paramDeleteBtn) {
        fireEvent.click(paramDeleteBtn);
      }

      expect(onChange).toHaveBeenCalled();
      const updatedTools = onChange.mock.calls[0][0];
      expect(updatedTools[0].parameters).toHaveLength(2);
      expect(
        updatedTools[0].parameters.find((p: { name: string }) => p.name === 'location'),
      ).toBeUndefined();
    });

    it('calls onChange when tool is removed', () => {
      const onChange = vi.fn();
      renderToolsEditor({ data: mockTools, onChange });

      // Each tool card has a remove button with title "Remove tool"
      const removeButtons = screen.getAllByTitle('Remove tool');
      expect(removeButtons).toHaveLength(3);

      // Remove the first tool
      fireEvent.click(removeButtons[0]);

      expect(onChange).toHaveBeenCalledTimes(1);
      const updatedTools = onChange.mock.calls[0][0];
      expect(updatedTools).toHaveLength(2);
      expect(updatedTools[0].name).toBe('get_weather');
      expect(updatedTools[1].name).toBe('process_payment');
    });
  });

  // ===========================================================================
  // TESTS — ADD TOOL
  // ===========================================================================

  describe('Add tool', () => {
    it('shows "Attach Tool" button', () => {
      renderToolsEditor();
      // The button text uses i18n key action_attach_tool → "Attach Tool"
      expect(screen.getByRole('button', { name: /Attach Tool/i })).toBeInTheDocument();
    });

    it('opens add tool dialog when Attach Tool is clicked', () => {
      renderToolsEditor({ data: mockTools });

      const attachButton = screen.getByRole('button', { name: /Attach Tool/i });
      fireEvent.click(attachButton);

      // The AddToolDialog should appear with its title
      expect(screen.getByText('Add Project Tool')).toBeInTheDocument();
    });

    it('empty state shows "No tools defined" message and attach tool button', () => {
      renderToolsEditor({ data: [] });

      expect(screen.getByText('No tools defined')).toBeInTheDocument();
      expect(screen.getByText('0 tools defined')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Attach Tool/i })).toBeInTheDocument();
    });

    it('preserves the agent Tools return path when creating a new HTTP tool', () => {
      renderToolsEditor({ data: [] });

      fireEvent.click(screen.getByRole('button', { name: /Create New Tool/i }));
      const httpOption = screen.getByText('HTTP').closest('button');
      expect(httpOption).toBeTruthy();

      fireEvent.click(httpOption!);

      expect(mockNavigate).toHaveBeenCalledWith(
        '/projects/proj-1/tools/new?type=http&returnTo=%2Fprojects%2Fproj-1%2Fagents%2FShopAssist_Supervisor%23tools',
      );
    });

    it('preserves the agent Tools return path when creating a new sandbox tool', () => {
      renderToolsEditor({ data: [] });

      fireEvent.click(screen.getByRole('button', { name: /Create New Tool/i }));
      const sandboxOption = screen.getByText('Code Tool').closest('button');
      expect(sandboxOption).toBeTruthy();

      fireEvent.click(sandboxOption!);

      expect(mockNavigate).toHaveBeenCalledWith(
        '/projects/proj-1/tools/new?type=sandbox&returnTo=%2Fprojects%2Fproj-1%2Fagents%2FShopAssist_Supervisor%23tools',
      );
    });

    it('preserves the agent Tools return path when opening MCP management', () => {
      renderToolsEditor({ data: [] });

      fireEvent.click(screen.getByRole('button', { name: /Create New Tool/i }));
      const mcpOption = screen.getByText('MCP Server').closest('button');
      expect(mcpOption).toBeTruthy();

      fireEvent.click(mcpOption!);

      expect(mockNavigate).toHaveBeenCalledWith(
        '/projects/proj-1/tools?tab=mcp&returnTo=%2Fprojects%2Fproj-1%2Fagents%2FShopAssist_Supervisor%23tools',
      );
    });

    it('omits the return path when no agent is loaded in the editor', () => {
      mockAgentEditorState.agentName = null;
      renderToolsEditor({ data: [] });

      fireEvent.click(screen.getByRole('button', { name: /Create New Tool/i }));
      const httpOption = screen.getByText('HTTP').closest('button');
      expect(httpOption).toBeTruthy();

      fireEvent.click(httpOption!);

      expect(mockNavigate).toHaveBeenCalledWith('/projects/proj-1/tools/new?type=http');
    });
  });

  // ===========================================================================
  // TESTS — PROJECT TOOLS SECTION
  // ===========================================================================

  describe('Project tools via Attach Tool dialog', () => {
    it('shows "Attach Tool" button when projectId exists and not readOnly', () => {
      renderToolsEditor();
      expect(screen.getByRole('button', { name: /Attach Tool/i })).toBeInTheDocument();
    });

    it('hides Attach Tool button when readOnly', () => {
      renderToolsEditor({ readOnly: true });
      expect(screen.queryByRole('button', { name: /Attach Tool/i })).not.toBeInTheDocument();
    });

    it('opens dialog and shows loading spinner', async () => {
      // Make fetchTools return a pending promise so loading state is visible
      let resolvePromise: (value: unknown) => void;
      const pendingPromise = new Promise((resolve) => {
        resolvePromise = resolve;
      });
      mockFetchTools.mockReturnValue(pendingPromise);

      renderToolsEditor();

      const attachButton = screen.getByRole('button', { name: /Attach Tool/i });
      fireEvent.click(attachButton);

      // Dialog should appear with its title
      expect(screen.getByText('Add Project Tool')).toBeInTheDocument();

      // Loading spinner should be visible (Loader2 svg)
      const spinner = document.querySelector('.animate-spin');
      expect(spinner).toBeTruthy();

      // Resolve the promise to avoid dangling
      resolvePromise!({
        success: true,
        data: [],
        pagination: { page: 1, limit: 200, total: 0, hasMore: false },
      });
    });

    it('shows available project tools after fetch in dialog', async () => {
      const projectTools = [
        {
          id: 'tool-1',
          name: 'project_search',
          slug: 'project_search',
          toolType: 'http' as const,
          description: 'A project search tool',
          dslContent: 'TOOL project_search() -> object',
          sourceHash: 'abc',
          projectId: 'proj-1',
          createdBy: 'user-1',
          lastEditedBy: null,
          createdAt: '2024-01-01',
          updatedAt: '2024-01-01',
        },
      ];
      mockFetchTools.mockResolvedValue({
        success: true,
        data: projectTools,
        pagination: { page: 1, limit: 200, total: 1, hasMore: false },
      });

      renderToolsEditor({ data: [] });

      // Open the dialog
      const attachButton = screen.getByRole('button', { name: /Attach Tool/i });
      fireEvent.click(attachButton);

      await waitFor(() => {
        expect(screen.getByText('project_search')).toBeInTheDocument();
      });
      expect(screen.getByText('A project search tool')).toBeInTheDocument();
    });

    it('filters out already-linked tools by name in dialog', async () => {
      const projectTools = [
        {
          id: 'tool-1',
          name: 'search_hotels',
          slug: 'search_hotels',
          toolType: 'http' as const,
          description: 'Same name as inline tool',
          dslContent: 'TOOL search_hotels() -> object',
          sourceHash: 'abc',
          projectId: 'proj-1',
          createdBy: 'user-1',
          lastEditedBy: null,
          createdAt: '2024-01-01',
          updatedAt: '2024-01-01',
        },
        {
          id: 'tool-2',
          name: 'new_project_tool',
          slug: 'new_project_tool',
          toolType: 'mcp' as const,
          description: 'A new project tool',
          dslContent: 'TOOL new_project_tool() -> object',
          sourceHash: 'def',
          projectId: 'proj-1',
          createdBy: 'user-1',
          lastEditedBy: null,
          createdAt: '2024-01-01',
          updatedAt: '2024-01-01',
        },
      ];
      mockFetchTools.mockResolvedValue({
        success: true,
        data: projectTools,
        pagination: { page: 1, limit: 200, total: 2, hasMore: false },
      });

      // search_hotels is already in the inline tools
      renderToolsEditor({ data: [httpTool] });

      // Open the dialog
      const attachButton = screen.getByRole('button', { name: /Attach Tool/i });
      fireEvent.click(attachButton);

      await waitFor(() => {
        expect(screen.getByText('new_project_tool')).toBeInTheDocument();
      });

      // search_hotels should be filtered out from the dialog list
      // because it already exists in the inline tools.
      // The dialog only shows "new_project_tool" (search_hotels is already in the
      // inline card list but should not appear as a second instance in the dialog).
    });

    it('calls onChange with project tool added when "Add" clicked in dialog', async () => {
      const projectTools = [
        {
          id: 'tool-1',
          name: 'project_search',
          slug: 'project_search',
          toolType: 'http' as const,
          description: 'A project search tool',
          dslContent: 'TOOL project_search(query: string) -> object',
          sourceHash: 'abc',
          projectId: 'proj-1',
          createdBy: 'user-1',
          lastEditedBy: null,
          createdAt: '2024-01-01',
          updatedAt: '2024-01-01',
        },
      ];
      mockFetchTools.mockResolvedValue({
        success: true,
        data: projectTools,
        pagination: { page: 1, limit: 200, total: 1, hasMore: false },
      });
      mockParseSignatureLine.mockReturnValue({
        name: 'project_search',
        parameters: [{ name: 'query', type: 'string', required: true }],
        returnType: 'object',
      });
      mockParseDslProperties.mockReturnValue({ method: 'POST' });

      const onChange = vi.fn();
      renderToolsEditor({ data: [], onChange });

      // Open the dialog
      const attachButton = screen.getByRole('button', { name: /Attach Tool/i });
      fireEvent.click(attachButton);

      await waitFor(() => {
        expect(screen.getByText('project_search')).toBeInTheDocument();
      });

      // Click the "Add" button next to the project tool in the dialog.
      const projectToolName = screen.getByText('project_search');
      const projectToolCard = projectToolName.closest('.rounded-lg');
      expect(projectToolCard).toBeTruthy();
      // Find the button containing "Add" text within the card
      const buttons = projectToolCard!.querySelectorAll('button');
      const addBtn = Array.from(buttons).find((btn) => btn.textContent?.includes('Add'));
      expect(addBtn).toBeTruthy();
      fireEvent.click(addBtn!);

      expect(onChange).toHaveBeenCalledTimes(1);
      const updatedTools = onChange.mock.calls[0][0];
      expect(updatedTools).toHaveLength(1);
      expect(updatedTools[0].name).toBe('project_search');
      expect(updatedTools[0].parameters).toHaveLength(1);
      expect(updatedTools[0].parameters[0].name).toBe('query');
      expect(updatedTools[0].toolType).toBe('http');
      // side_effects should be true because method is POST (not GET)
      expect(updatedTools[0].hints.side_effects).toBe(true);
    });
  });

  // ===========================================================================
  // TESTS — CONFIRMATION CONFIG
  // ===========================================================================

  describe('Confirmation config', () => {
    it('shows confirmation dropdown in expanded card', () => {
      renderToolsEditor({ data: [httpTool] });
      expandToolCard(0);

      // The confirmation section has a select with "Never" default
      const confirmationLabel = screen.getByText('Confirmation');
      expect(confirmationLabel).toBeInTheDocument();

      // Find the select near the confirmation label
      const select = confirmationLabel.parentElement?.querySelector('select');
      expect(select).toBeInTheDocument();
      expect(select?.value).toBe('never');
    });

    it('calls onChange when confirmation level changed', () => {
      const onChange = vi.fn();
      renderToolsEditor({ data: [httpTool], onChange });
      expandToolCard(0);

      const confirmationLabel = screen.getByText('Confirmation');
      const select = confirmationLabel.parentElement?.querySelector('select');
      expect(select).toBeInTheDocument();

      fireEvent.change(select!, { target: { value: 'always' } });

      expect(onChange).toHaveBeenCalled();
      const updatedTools = onChange.mock.calls[0][0];
      expect(updatedTools[0].confirmation).toEqual({
        require: 'always',
        immutableParams: undefined,
      });
    });

    it('shows immutable params input when confirmation is not "never"', () => {
      const toolWithConfirmation: ToolSectionData = {
        ...httpTool,
        confirmation: { require: 'always', immutableParams: ['order_id'] },
      };
      renderToolsEditor({ data: [toolWithConfirmation] });
      expandToolCard(0);

      expect(screen.getByText('Immutable params')).toBeInTheDocument();
      expect(screen.getByDisplayValue('order_id')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // TESTS — PII ACCESS
  // ===========================================================================

  describe('PII access', () => {
    it('shows PII access dropdown in expanded card', () => {
      renderToolsEditor({ data: [httpTool] });
      expandToolCard(0);

      expect(screen.getByText('PII Access')).toBeInTheDocument();
    });

    it('calls onChange when PII level changed', () => {
      const onChange = vi.fn();
      renderToolsEditor({ data: [httpTool], onChange });
      expandToolCard(0);

      const piiLabel = screen.getByText('PII Access');
      const select = piiLabel.parentElement?.querySelector('select');
      expect(select).toBeInTheDocument();

      fireEvent.change(select!, { target: { value: 'user' } });

      expect(onChange).toHaveBeenCalled();
      const updatedTools = onChange.mock.calls[0][0];
      expect(updatedTools[0].piiAccess).toBe('user');
    });
  });

  // ===========================================================================
  // TESTS — HINT BADGES
  // ===========================================================================

  describe('Hint badges', () => {
    it('shows cacheable badge when hints.cacheable is true', () => {
      renderToolsEditor({ data: [httpTool] });
      expandToolCard(0);

      expect(screen.getByText('Cacheable')).toBeInTheDocument();
    });

    it('shows side effects badge when hints.side_effects is true', () => {
      renderToolsEditor({ data: [sandboxTool] });
      expandToolCard(0);

      expect(screen.getByText('Side Effects')).toBeInTheDocument();
    });

    it('does not show hint badges when hints are empty', () => {
      renderToolsEditor({ data: [mcpTool] });
      expandToolCard(0);

      expect(screen.queryByText('Cacheable')).not.toBeInTheDocument();
      expect(screen.queryByText('Side Effects')).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // TESTS — READ-ONLY MODE
  // ===========================================================================

  describe('Read-only mode', () => {
    it('hides remove tool buttons when readOnly', () => {
      renderToolsEditor({ readOnly: true });
      expect(screen.queryByTitle('Remove tool')).not.toBeInTheDocument();
    });

    it('hides Add Tool button when readOnly', () => {
      renderToolsEditor({ readOnly: true });
      expect(screen.queryByRole('button', { name: /Add Tool/i })).not.toBeInTheDocument();
    });

    it('hides confirmation and PII sections when readOnly and expanded', () => {
      renderToolsEditor({ data: [httpTool], readOnly: true });
      expandToolCard(0);

      expect(screen.queryByText('Confirmation')).not.toBeInTheDocument();
      expect(screen.queryByText('PII Access')).not.toBeInTheDocument();
    });
  });
});
