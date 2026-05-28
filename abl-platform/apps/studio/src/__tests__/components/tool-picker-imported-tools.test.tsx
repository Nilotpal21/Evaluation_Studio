/**
 * ToolPickerDialog – Imported Tools Tests
 *
 * @vitest-environment happy-dom
 *
 * Verifies that imported module tools appear in the tool picker with
 * "Imported" badge, module provenance, and are selectable via Insert.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// =============================================================================
// MOCKS
// =============================================================================

// Mock fetchTools API
const mockFetchTools = vi.fn();
vi.mock('../../api/tools', () => ({
  fetchTools: (...args: unknown[]) => mockFetchTools(...args),
}));

// Mock useImportedSymbols hook
const mockImportedSymbols = vi.hoisted(() => ({
  agents: [] as Array<{
    name: string;
    alias: string;
    moduleProjectName: string;
    dependencyId: string;
  }>,
  tools: [] as Array<{
    name: string;
    alias: string;
    moduleProjectName: string;
    dependencyId: string;
  }>,
  hasDependencies: false,
}));

vi.mock('../../hooks/useImportedSymbols', () => ({
  useImportedSymbols: () => mockImportedSymbols,
}));

// Mock Dialog — Radix Dialog causes happy-dom hangs.
vi.mock('../../components/ui/Dialog', () => ({
  Dialog: ({
    open,
    onClose,
    title,
    description,
    children,
  }: {
    open: boolean;
    onClose: () => void;
    title?: string;
    description?: string;
    children: React.ReactNode;
  }) => {
    if (!open) return null;
    return (
      <div data-testid="dialog" role="dialog">
        {title && <h2>{title}</h2>}
        {description && <p>{description}</p>}
        <button data-testid="dialog-close" onClick={onClose}>
          Close
        </button>
        {children}
      </div>
    );
  },
}));

// Mock ToolTypeBadge (renders inner Badge which uses i18n)
vi.mock('../../components/tools/ToolTypeBadge', () => ({
  ToolTypeBadge: ({ type }: { type: string }) => <span data-testid="tool-type-badge">{type}</span>,
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import { ToolPickerDialog } from '../../components/abl/ToolPickerDialog';

// =============================================================================
// HELPERS
// =============================================================================

const defaultProps = {
  open: true,
  onClose: vi.fn(),
  projectId: 'proj-123',
  onInsert: vi.fn(),
};

function renderPicker(overrides: Partial<typeof defaultProps> = {}) {
  const props = { ...defaultProps, ...overrides };
  return { ...render(<ToolPickerDialog {...props} />), props };
}

// =============================================================================
// TESTS
// =============================================================================

describe('ToolPickerDialog — Imported Tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no project tools, no imported tools
    mockFetchTools.mockResolvedValue({ data: [] });
    mockImportedSymbols.tools = [];
    mockImportedSymbols.agents = [];
    mockImportedSymbols.hasDependencies = false;
  });

  it('renders imported tools with "Imported" badge when useImportedSymbols returns tools', async () => {
    mockImportedSymbols.tools = [
      {
        name: 'search_docs',
        alias: 'helpdesk',
        moduleProjectName: 'Helpdesk Module',
        dependencyId: 'dep-1',
      },
      {
        name: 'create_ticket',
        alias: 'helpdesk',
        moduleProjectName: 'Helpdesk Module',
        dependencyId: 'dep-1',
      },
    ];
    mockImportedSymbols.hasDependencies = true;

    renderPicker();

    // Wait for tools to load (fetchTools resolves)
    await screen.findByRole('dialog');

    // Imported tools should show with alias.name format
    expect(screen.getByText('helpdesk.search_docs')).toBeInTheDocument();
    expect(screen.getByText('helpdesk.create_ticket')).toBeInTheDocument();

    // "Imported" text appears: 1 section header + 1 badge per tool = 3 total
    const importedBadges = screen.getAllByText('Imported');
    expect(importedBadges.length).toBe(3);
  });

  it('shows module provenance (project name) for imported tools', async () => {
    mockImportedSymbols.tools = [
      {
        name: 'fetch_data',
        alias: 'analytics',
        moduleProjectName: 'Analytics Module',
        dependencyId: 'dep-2',
      },
    ];
    mockImportedSymbols.hasDependencies = true;

    renderPicker();
    await screen.findByRole('dialog');

    // Module project name is shown as sub-text
    expect(screen.getByText('Analytics Module')).toBeInTheDocument();
  });

  it('imported tools are selectable via Insert button', async () => {
    mockImportedSymbols.tools = [
      {
        name: 'run_query',
        alias: 'db_mod',
        moduleProjectName: 'DB Module',
        dependencyId: 'dep-3',
      },
    ];
    mockImportedSymbols.hasDependencies = true;

    const { props } = renderPicker();
    await screen.findByRole('dialog');

    // Find the Insert button next to the imported tool
    const insertButtons = screen.getAllByRole('button', { name: /insert/i });
    // The last one should be for the imported tool
    fireEvent.click(insertButtons[insertButtons.length - 1]);

    // onInsert uses the runtime-mounted module symbol name.
    expect(props.onInsert).toHaveBeenCalledWith('  db_mod__run_query()');
    // Dialog should close
    expect(props.onClose).toHaveBeenCalled();
  });

  it('does not render imported tools section when no imported symbols', async () => {
    mockImportedSymbols.tools = [];
    mockImportedSymbols.hasDependencies = false;

    // Provide a regular project tool so there's some content
    mockFetchTools.mockResolvedValue({
      data: [
        {
          id: 'tool-1',
          name: 'my_tool',
          description: 'A regular tool',
          toolType: 'http',
        },
      ],
    });

    renderPicker();
    await screen.findByRole('dialog');

    // Regular tool shows
    expect(screen.getByText('my_tool')).toBeInTheDocument();

    // "Imported" badge should NOT appear
    expect(screen.queryByText('Imported')).not.toBeInTheDocument();
  });

  it('filters imported tools by search query', async () => {
    mockImportedSymbols.tools = [
      {
        name: 'search_docs',
        alias: 'helpdesk',
        moduleProjectName: 'Helpdesk Module',
        dependencyId: 'dep-1',
      },
      {
        name: 'create_ticket',
        alias: 'support',
        moduleProjectName: 'Support Module',
        dependencyId: 'dep-4',
      },
    ];
    mockImportedSymbols.hasDependencies = true;

    renderPicker();
    await screen.findByRole('dialog');

    // Both tools visible initially
    expect(screen.getByText('helpdesk.search_docs')).toBeInTheDocument();
    expect(screen.getByText('support.create_ticket')).toBeInTheDocument();

    // Type a search query
    const searchInput = screen.getByPlaceholderText(/search tools/i);
    fireEvent.change(searchInput, { target: { value: 'ticket' } });

    // Only matching tool should be visible
    expect(screen.queryByText('helpdesk.search_docs')).not.toBeInTheDocument();
    expect(screen.getByText('support.create_ticket')).toBeInTheDocument();
  });
});
