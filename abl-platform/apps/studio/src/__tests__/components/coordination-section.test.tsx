/**
 * CoordinationSection Component Tests
 *
 * Tests for the coordination section: collapsed summary with handoff + delegate
 * counts, expanded view with handoffs sub-section (target agent, when condition,
 * summary, returnable toggle), delegates sub-section (target agent, when, purpose),
 * escalation indicator, add buttons, and empty state.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CoordinationSection } from '../../components/agent-detail/CoordinationSection';
import type {
  CoordinationSectionData,
  HandoffData,
  DelegateData,
} from '../../store/agent-detail-store';

// =============================================================================
// TEST DATA
// =============================================================================

const billingHandoff: HandoffData = {
  to: 'billing_agent',
  when: 'topic === "billing"',
  summary: 'Route billing inquiries to specialist',
  returnable: true,
};

const supportHandoff: HandoffData = {
  to: 'support_agent',
  when: 'sentiment.score < -0.5',
  summary: 'Escalate negative interactions to support',
  returnable: false,
};

const researchDelegate: DelegateData = {
  agent: 'research_agent',
  when: 'needs_deep_research === true',
  purpose: 'Perform in-depth research on complex topics',
};

const mockCoordination: CoordinationSectionData = {
  handoffs: [billingHandoff, supportHandoff],
  delegates: [researchDelegate],
  escalation: {
    triggers: [{ when: 'user.wants_human', reason: 'User requested help', priority: 'high' }],
    contextForHuman: [],
    onHumanComplete: [],
  },
};

const emptyCoordination: CoordinationSectionData = {
  handoffs: [],
  delegates: [],
  escalation: { triggers: [], contextForHuman: [], onHumanComplete: [] },
};

// =============================================================================
// TESTS
// =============================================================================

describe('CoordinationSection', () => {
  it('renders collapsed with counts per type', () => {
    render(
      <CoordinationSection
        data={mockCoordination}
        isExpanded={false}
        onToggle={() => {}}
        onChange={() => {}}
      />,
    );

    // Title is "Coordination"
    expect(screen.getByText('Coordination')).toBeInTheDocument();

    // Total count badge shows 3 (2 handoffs + 1 delegate)
    expect(screen.getByText('3')).toBeInTheDocument();

    // Summary text includes handoff and delegate counts
    expect(screen.getByText(/2 handoffs/i)).toBeInTheDocument();
    expect(screen.getByText(/1 delegate/i)).toBeInTheDocument();
  });

  it('renders expanded with handoffs sub-section', () => {
    render(
      <CoordinationSection
        data={mockCoordination}
        isExpanded={true}
        onToggle={() => {}}
        onChange={() => {}}
      />,
    );

    // Handoffs sub-section header
    expect(screen.getByText('Handoffs')).toBeInTheDocument();

    // Target agents are displayed in input elements
    expect(screen.getByDisplayValue('billing_agent')).toBeInTheDocument();
    expect(screen.getByDisplayValue('support_agent')).toBeInTheDocument();
  });

  it('shows handoff details: target agent, when condition, returnable status', () => {
    render(
      <CoordinationSection
        data={{
          handoffs: [billingHandoff],
          delegates: [],
          escalation: { triggers: [], contextForHuman: [], onHumanComplete: [] },
        }}
        isExpanded={true}
        onToggle={() => {}}
        onChange={() => {}}
      />,
    );

    // Target agent (in input)
    expect(screen.getByDisplayValue('billing_agent')).toBeInTheDocument();

    // When condition (in textarea)
    expect(screen.getByDisplayValue('topic === "billing"')).toBeInTheDocument();

    // Summary text (in input)
    expect(screen.getByDisplayValue('Route billing inquiries to specialist')).toBeInTheDocument();

    // Returnable status indicator
    expect(screen.getByText(/returnable/i)).toBeInTheDocument();
  });

  it('renders delegates sub-section', () => {
    render(
      <CoordinationSection
        data={{
          handoffs: [],
          delegates: [researchDelegate],
          escalation: { triggers: [], contextForHuman: [], onHumanComplete: [] },
        }}
        isExpanded={true}
        onToggle={() => {}}
        onChange={() => {}}
      />,
    );

    // Delegates sub-section header
    expect(screen.getByText('Delegates')).toBeInTheDocument();

    // Delegate agent name (in input)
    expect(screen.getByDisplayValue('research_agent')).toBeInTheDocument();

    // Delegate when condition (in textarea)
    expect(screen.getByDisplayValue('needs_deep_research === true')).toBeInTheDocument();

    // Delegate purpose (in input)
    expect(
      screen.getByDisplayValue('Perform in-depth research on complex topics'),
    ).toBeInTheDocument();
  });

  it('shows escalation indicator when escalation triggers exist', () => {
    render(
      <CoordinationSection
        data={{
          handoffs: [],
          delegates: [],
          escalation: {
            triggers: [
              { when: 'user.wants_human', reason: 'User requested help', priority: 'high' },
            ],
            contextForHuman: [],
            onHumanComplete: [],
          },
        }}
        isExpanded={true}
        onToggle={() => {}}
        onChange={() => {}}
      />,
    );

    // Escalation section header
    expect(screen.getByText('Escalation')).toBeInTheDocument();

    // Escalation configured badge
    expect(screen.getByText(/escalation configured/i)).toBeInTheDocument();
  });

  it('shows [+ Add Handoff] and [+ Add Delegate] buttons', () => {
    render(
      <CoordinationSection
        data={mockCoordination}
        isExpanded={true}
        onToggle={() => {}}
        onChange={() => {}}
      />,
    );

    const addHandoffBtn = screen.getByRole('button', { name: /add handoff/i });
    expect(addHandoffBtn).toBeInTheDocument();

    const addDelegateBtn = screen.getByRole('button', { name: /add delegate/i });
    expect(addDelegateBtn).toBeInTheDocument();
  });

  it('renders empty state when no coordination', () => {
    render(
      <CoordinationSection
        data={emptyCoordination}
        isExpanded={false}
        onToggle={() => {}}
        onChange={() => {}}
      />,
    );

    // Title still shows
    expect(screen.getByText('Coordination')).toBeInTheDocument();

    // SectionCard handles empty state via isEmpty prop
    expect(screen.getByText(/no coordination configured/i)).toBeInTheDocument();
  });
});
