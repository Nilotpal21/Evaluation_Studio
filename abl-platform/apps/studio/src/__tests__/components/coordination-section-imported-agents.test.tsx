/**
 * CoordinationSection – Imported Agents Tests
 *
 * @vitest-environment happy-dom
 *
 * Verifies that imported module agents appear as read-only entries
 * with provenance labels, count badges, and lock indicators.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// =============================================================================
// MOCKS
// =============================================================================

// Mock useImportedSymbols hook — must be before component import
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

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import { CoordinationSection } from '../../components/agent-detail/CoordinationSection';
import type { CoordinationSectionData } from '../../store/agent-detail-store';

// =============================================================================
// TEST DATA
// =============================================================================

const emptyCoordination: CoordinationSectionData = {
  handoffs: [],
  delegates: [],
  escalation: { triggers: [], contextForHuman: [], onHumanComplete: [] },
};

const coordinationWithHandoff: CoordinationSectionData = {
  handoffs: [{ to: 'billing_agent', when: 'topic === "billing"', summary: '', returnable: false }],
  delegates: [],
  escalation: { triggers: [], contextForHuman: [], onHumanComplete: [] },
};

// =============================================================================
// HELPERS
// =============================================================================

const defaultProps = {
  data: emptyCoordination,
  isExpanded: true,
  onToggle: vi.fn(),
  onChange: vi.fn(),
};

function renderSection(overrides: Partial<typeof defaultProps> = {}) {
  const props = { ...defaultProps, ...overrides };
  return render(<CoordinationSection {...props} />);
}

// =============================================================================
// TESTS
// =============================================================================

describe('CoordinationSection — Imported Agents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockImportedSymbols.agents = [];
    mockImportedSymbols.tools = [];
    mockImportedSymbols.hasDependencies = false;
  });

  it('renders imported agents with provenance label "from {alias}"', () => {
    mockImportedSymbols.agents = [
      {
        name: 'support_bot',
        alias: 'helpdesk',
        moduleProjectName: 'Helpdesk Module',
        dependencyId: 'dep-1',
      },
    ];
    mockImportedSymbols.hasDependencies = true;

    renderSection();

    // Imported agent appears with alias.name format
    expect(screen.getByText('helpdesk.support_bot')).toBeInTheDocument();

    // Provenance label "from helpdesk" (from modules.badges.fromModule i18n key)
    expect(screen.getByText('from helpdesk')).toBeInTheDocument();
  });

  it('imported agents are marked read-only with lock icon and Imported badge', () => {
    mockImportedSymbols.agents = [
      {
        name: 'analyzer',
        alias: 'analytics',
        moduleProjectName: 'Analytics Module',
        dependencyId: 'dep-2',
      },
    ];
    mockImportedSymbols.hasDependencies = true;

    renderSection();

    // "Imported" badge
    expect(screen.getByText('Imported')).toBeInTheDocument();

    // Lock icon — lucide-react icons render with class "lucide lucide-lock"
    const lockIcons = document.querySelectorAll('.lucide-lock');
    expect(lockIcons.length).toBeGreaterThanOrEqual(1);

    // The imported agent card should not have editable inputs
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('shows imported agents count in the section', () => {
    mockImportedSymbols.agents = [
      {
        name: 'agent_a',
        alias: 'mod_a',
        moduleProjectName: 'Module A',
        dependencyId: 'dep-3',
      },
      {
        name: 'agent_b',
        alias: 'mod_b',
        moduleProjectName: 'Module B',
        dependencyId: 'dep-4',
      },
    ];
    mockImportedSymbols.hasDependencies = true;

    renderSection();

    // The imported agents sub-section header shows the count
    expect(screen.getByText('Imported Agents')).toBeInTheDocument();
    // Count text "(2)" appears
    expect(screen.getByText('(2)')).toBeInTheDocument();
  });

  it('does not render imported agents section when no imported agents', () => {
    mockImportedSymbols.agents = [];
    mockImportedSymbols.hasDependencies = false;

    renderSection();

    // "Imported Agents" sub-section header should not appear
    expect(screen.queryByText('Imported Agents')).not.toBeInTheDocument();
  });

  it('includes imported agents in total coordination count badge', () => {
    mockImportedSymbols.agents = [
      {
        name: 'agent_x',
        alias: 'ext',
        moduleProjectName: 'External Module',
        dependencyId: 'dep-5',
      },
    ];
    mockImportedSymbols.hasDependencies = true;

    // 1 handoff + 1 imported agent = 2 total
    renderSection({ data: coordinationWithHandoff, isExpanded: false });

    // The SectionCard count badge should show "2" (1 handoff + 1 imported)
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('renders multiple imported agents from different modules', () => {
    mockImportedSymbols.agents = [
      {
        name: 'support_bot',
        alias: 'helpdesk',
        moduleProjectName: 'Helpdesk Module',
        dependencyId: 'dep-1',
      },
      {
        name: 'billing_bot',
        alias: 'finance',
        moduleProjectName: 'Finance Module',
        dependencyId: 'dep-6',
      },
    ];
    mockImportedSymbols.hasDependencies = true;

    renderSection();

    expect(screen.getByText('helpdesk.support_bot')).toBeInTheDocument();
    expect(screen.getByText('finance.billing_bot')).toBeInTheDocument();
    expect(screen.getByText('from helpdesk')).toBeInTheDocument();
    expect(screen.getByText('from finance')).toBeInTheDocument();
  });
});
