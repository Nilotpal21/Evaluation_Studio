/**
 * AgentCard Component Tests
 *
 * Tests for the rich agent card displayed in the agents grid.
 * Verifies name rendering, status badges, execution mode, description,
 * session count, time display, and click handlers.
 *
 * @vitest-environment happy-dom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// =============================================================================
// MOCKS
// =============================================================================

// Mock the runtime-agents module — parseActiveVersions is used by AgentCard
vi.mock('../../api/runtime-agents', async () => {
  const actual = await vi.importActual<typeof import('../../api/runtime-agents')>(
    '../../api/runtime-agents',
  );
  return {
    ...actual,
    parseActiveVersions: actual.parseActiveVersions,
  };
});

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import { AgentCard, type AgentSummary } from '../../components/agents/AgentCard';
import type { RuntimeAgent } from '../../api/runtime-agents';

// =============================================================================
// TEST DATA
// =============================================================================

function createAgent(overrides: Partial<RuntimeAgent> = {}): RuntimeAgent {
  return {
    id: 'agent-1',
    name: 'booking_agent',
    agentPath: 'project/booking_agent',
    description: 'Handles booking requests',
    dslContent: 'AGENT booking_agent {}',
    versionCount: 3,
    activeVersions: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createSummary(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    toolsCount: 5,
    gatherFieldsCount: 2,
    executionMode: 'reasoning',
    goal: 'Help users book appointments',
    description: 'A sophisticated booking assistant',
    ...overrides,
  };
}

const defaultProps = {
  agent: createAgent(),
  summary: createSummary(),
  isStart: false,
  supervisor: false,
  onOpen: vi.fn(),
  onChat: vi.fn(),
};

// =============================================================================
// TESTS
// =============================================================================

describe('AgentCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Name rendering
  // ---------------------------------------------------------------------------

  it('renders agent name with underscores replaced by spaces', () => {
    render(<AgentCard {...defaultProps} />);
    // "booking_agent" should render using the shared title-case display formatter.
    expect(screen.getByText('Booking Agent')).toBeInTheDocument();
  });

  it('renders agent name without underscores when name has none', () => {
    render(<AgentCard {...defaultProps} agent={createAgent({ name: 'concierge' })} />);
    expect(screen.getByText('Concierge')).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Status badge
  // ---------------------------------------------------------------------------

  it('shows live status with green indicator', () => {
    render(<AgentCard {...defaultProps} status="live" />);
    expect(screen.getByText('Live')).toBeInTheDocument();

    // The status dot should have bg-success class
    const statusDot = screen.getByText('Live').previousElementSibling;
    expect(statusDot?.className).toContain('bg-success');
  });

  it('shows draft status with gray indicator', () => {
    render(<AgentCard {...defaultProps} status="draft" />);
    expect(screen.getByText('Draft')).toBeInTheDocument();

    const statusDot = screen.getByText('Draft').previousElementSibling;
    expect(statusDot?.className).toContain('bg-foreground-subtle/30');
  });

  it('shows error status with red indicator', () => {
    render(<AgentCard {...defaultProps} status="error" />);
    expect(screen.getByText('Error')).toBeInTheDocument();

    const statusDot = screen.getByText('Error').previousElementSibling;
    expect(statusDot?.className).toContain('bg-error');
  });

  it('defaults to draft status when no status provided', () => {
    render(<AgentCard {...defaultProps} status={undefined} />);
    expect(screen.getByText('Draft')).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Role badges
  // ---------------------------------------------------------------------------

  it('shows "Start" badge when isStart=true', () => {
    render(<AgentCard {...defaultProps} isStart={true} />);
    expect(screen.getByText('Start')).toBeInTheDocument();
  });

  it('does not show "Start" badge when isStart=false', () => {
    render(<AgentCard {...defaultProps} isStart={false} />);
    expect(screen.queryByText('Start')).not.toBeInTheDocument();
  });

  it('shows "Supervisor" badge when supervisor=true', () => {
    render(<AgentCard {...defaultProps} supervisor={true} />);
    expect(screen.getByText('Supervisor')).toBeInTheDocument();
  });

  it('does not show "Supervisor" badge when supervisor=false', () => {
    render(<AgentCard {...defaultProps} supervisor={false} />);
    expect(screen.queryByText('Supervisor')).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Execution mode badge
  // ---------------------------------------------------------------------------

  it('shows "Reasoning" badge when executionMode is reasoning', () => {
    render(<AgentCard {...defaultProps} summary={createSummary({ executionMode: 'reasoning' })} />);
    expect(screen.getByText('Reasoning')).toBeInTheDocument();
  });

  it('shows "Flow" badge when executionMode is flow', () => {
    render(<AgentCard {...defaultProps} summary={createSummary({ executionMode: 'flow' })} />);
    expect(screen.getByText('Flow')).toBeInTheDocument();
  });

  it('shows "Mixed" badge when executionMode is hybrid', () => {
    render(<AgentCard {...defaultProps} summary={createSummary({ executionMode: 'hybrid' })} />);
    expect(screen.getByText('Mixed')).toBeInTheDocument();
  });

  it('does not show execution mode badge when summary is null', () => {
    render(<AgentCard {...defaultProps} summary={null} />);
    expect(screen.queryByText('Reasoning')).not.toBeInTheDocument();
    expect(screen.queryByText('Flow')).not.toBeInTheDocument();
    expect(screen.queryByText('Mixed')).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Description / goal text
  // ---------------------------------------------------------------------------

  it('shows description text from summary', () => {
    render(<AgentCard {...defaultProps} />);
    expect(screen.getByText('A sophisticated booking assistant')).toBeInTheDocument();
  });

  it('falls back to goal when description is null', () => {
    render(
      <AgentCard
        {...defaultProps}
        summary={createSummary({ description: null, goal: 'Help users book appointments' })}
      />,
    );
    expect(screen.getByText('Help users book appointments')).toBeInTheDocument();
  });

  it('falls back to agent.description when summary description and goal are null', () => {
    render(
      <AgentCard
        {...defaultProps}
        agent={createAgent({ description: 'Agent-level description' })}
        summary={createSummary({ description: null, goal: null })}
      />,
    );
    expect(screen.getByText('Agent-level description')).toBeInTheDocument();
  });

  it('shows "No description" when all description sources are null', () => {
    render(
      <AgentCard
        {...defaultProps}
        agent={createAgent({ description: null })}
        summary={createSummary({ description: null, goal: null })}
      />,
    );
    expect(screen.getByText('No description')).toBeInTheDocument();
  });

  it('description has line-clamp-2 for truncation', () => {
    render(<AgentCard {...defaultProps} />);
    const descriptionEl = screen.getByText('A sophisticated booking assistant');
    expect(descriptionEl.className).toContain('line-clamp-2');
  });

  // ---------------------------------------------------------------------------
  // Session count
  // ---------------------------------------------------------------------------

  it('shows session count', () => {
    render(<AgentCard {...defaultProps} sessionCount={42} />);
    expect(screen.getByText(/42\s+sessions/)).toBeInTheDocument();
  });

  it('shows 0 sessions when sessionCount is not provided', () => {
    render(<AgentCard {...defaultProps} sessionCount={undefined} />);
    expect(screen.getByText(/0\s+sessions/)).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Updated time
  // ---------------------------------------------------------------------------

  it('shows relative time for recently updated agent', () => {
    const recentDate = new Date(Date.now() - 10 * 1000).toISOString(); // 10 seconds ago
    render(<AgentCard {...defaultProps} agent={createAgent({ updatedAt: recentDate })} />);
    expect(screen.getByText('just now')).toBeInTheDocument();
  });

  it('shows minutes ago for agent updated minutes ago', () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    render(<AgentCard {...defaultProps} agent={createAgent({ updatedAt: fiveMinutesAgo })} />);
    expect(screen.getByText('5m ago')).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Click handlers
  // ---------------------------------------------------------------------------

  it('calls onOpen when card is clicked', () => {
    const onOpen = vi.fn();
    render(<AgentCard {...defaultProps} onOpen={onOpen} />);

    // The card root is a div with role="button"
    const card = screen.getByRole('button', { name: /booking agent/i });
    fireEvent.click(card);

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('calls onOpen on Enter key press', () => {
    const onOpen = vi.fn();
    render(<AgentCard {...defaultProps} onOpen={onOpen} />);

    const card = screen.getByRole('button', { name: /booking agent/i });
    fireEvent.keyDown(card, { key: 'Enter' });

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('calls onChat when chat button is clicked', () => {
    const onChat = vi.fn();
    const onOpen = vi.fn();
    render(<AgentCard {...defaultProps} onOpen={onOpen} onChat={onChat} />);

    // The chat button has text "Chat"
    const chatButton = screen.getByText('Chat').closest('button')!;
    fireEvent.click(chatButton);

    expect(onChat).toHaveBeenCalledTimes(1);
    // onOpen should NOT be called because the click event is stopped
    expect(onOpen).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Version / active badge
  // ---------------------------------------------------------------------------

  it('shows "Active" badge when agent has active production version', () => {
    render(
      <AgentCard
        {...defaultProps}
        agent={createAgent({ activeVersions: { production: 'v1.2.0' } })}
      />,
    );
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('shows "Active" badge when agent has active staging version', () => {
    render(
      <AgentCard
        {...defaultProps}
        agent={createAgent({ activeVersions: { staging: 'v0.5.0' } })}
      />,
    );
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('does not show "Active" badge when activeVersions is empty', () => {
    render(<AgentCard {...defaultProps} agent={createAgent({ activeVersions: {} })} />);
    expect(screen.queryByText('Active')).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Tools count in footer
  // ---------------------------------------------------------------------------

  it('shows tool count when toolsCount > 0', () => {
    render(<AgentCard {...defaultProps} summary={createSummary({ toolsCount: 5 })} />);
    // The tools count is rendered as just the number next to the Wrench icon inside a span
    expect(screen.getByText('5')).toBeInTheDocument();
    // Verify the span containing the count also has an SVG (the icon)
    const countEl = screen.getByText('5');
    const parentSpan = countEl.closest('span.flex');
    expect(parentSpan).toBeTruthy();
    expect(parentSpan!.querySelector('svg')).toBeTruthy();
  });

  it('does not show tool count when toolsCount is 0', () => {
    const { container } = render(
      <AgentCard {...defaultProps} summary={createSummary({ toolsCount: 0 })} />,
    );
    // When toolsCount is 0, the wrench icon span is not rendered.
    // Verify no Wrench SVG exists in the footer metadata area.
    const footerMetadata = container.querySelector('.text-xs.text-subtle');
    const wrenchSvgs = footerMetadata?.querySelectorAll('svg.lucide-wrench') ?? [];
    expect(wrenchSvgs.length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Handoff count in footer
  // ---------------------------------------------------------------------------

  it('shows handoff count when handoffCount > 0', () => {
    render(<AgentCard {...defaultProps} handoffCount={3} />);
    expect(screen.getByText('3')).toBeInTheDocument();
    // Verify the span containing the count also has an SVG (the icon)
    const countEl = screen.getByText('3');
    const parentSpan = countEl.closest('span.flex');
    expect(parentSpan).toBeTruthy();
    expect(parentSpan!.querySelector('svg')).toBeTruthy();
  });

  it('does not show handoff count when handoffCount is 0', () => {
    const { container } = render(<AgentCard {...defaultProps} handoffCount={0} />);
    // When handoffCount is 0, the ArrowRightLeft icon span is not rendered.
    const footerMetadata = container.querySelector('.text-xs.text-subtle');
    const arrowSvgs = footerMetadata?.querySelectorAll('svg.lucide-arrow-right-left') ?? [];
    expect(arrowSvgs.length).toBe(0);
  });
});
