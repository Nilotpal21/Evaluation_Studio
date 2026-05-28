/**
 * RulesSection Component Tests
 *
 * Tests for the rules section: collapsed summary with constraint + guardrail
 * counts, expanded view with constraints sub-section (condition + on_fail action)
 * and guardrails sub-section (name, description, check, action), add buttons,
 * and empty state.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RulesSection } from '../../components/agent-detail/RulesSection';
import type {
  RulesSectionData,
  ConstraintData,
  GuardrailData,
} from '../../store/agent-detail-store';

// =============================================================================
// TEST DATA
// =============================================================================

const respondConstraint: ConstraintData = {
  condition: 'message.length > 500',
  onFail: {
    type: 'respond',
    message: 'Please keep your message under 500 characters.',
  },
};

const blockConstraint: ConstraintData = {
  condition: 'user.verified === true',
  onFail: {
    type: 'block',
    message: 'Unverified users are not allowed.',
  },
};

const handoffConstraint: ConstraintData = {
  condition: 'topic !== "billing"',
  onFail: {
    type: 'handoff',
    target: 'billing_agent',
    message: 'Routing to billing specialist.',
  },
};

const escalateConstraint: ConstraintData = {
  condition: 'sentiment.score > 0.3',
  onFail: {
    type: 'escalate',
    reason: 'Negative sentiment detected',
    message: 'Escalating to supervisor.',
  },
};

const piiGuardrail: GuardrailData = {
  name: 'pii_filter',
  description: 'Prevents PII from being exposed in responses',
  check: 'response does not contain SSN, credit card numbers, or passwords',
  action: {
    type: 'block',
    message: 'PII detected in response. Blocked.',
  },
};

const toxicityGuardrail: GuardrailData = {
  name: 'toxicity_check',
  description: 'Ensures responses are not toxic or harmful',
  check: 'response toxicity score < 0.5',
  action: {
    type: 'respond',
    message: 'I cannot provide that kind of response.',
  },
};

const mockRules: RulesSectionData = {
  constraints: [respondConstraint, blockConstraint, handoffConstraint, escalateConstraint],
  guardrails: [piiGuardrail, toxicityGuardrail],
};

const emptyRules: RulesSectionData = {
  constraints: [],
  guardrails: [],
};

// =============================================================================
// TESTS
// =============================================================================

describe('RulesSection', () => {
  it('renders collapsed with constraint + guardrail counts', () => {
    render(
      <RulesSection data={mockRules} isExpanded={false} onToggle={() => {}} onChange={() => {}} />,
    );

    // Title is "Rules"
    expect(screen.getByText('Rules')).toBeInTheDocument();

    // Total count badge shows 6 (4 constraints + 2 guardrails)
    expect(screen.getByText('6')).toBeInTheDocument();

    // Summary text includes constraint and guardrail counts
    expect(screen.getByText(/4 constraints/i)).toBeInTheDocument();
    expect(screen.getByText(/2 guardrails/i)).toBeInTheDocument();
  });

  it('renders expanded with constraints sub-section', () => {
    render(
      <RulesSection data={mockRules} isExpanded={true} onToggle={() => {}} onChange={() => {}} />,
    );

    // Constraints sub-section header
    expect(screen.getByText('Constraints')).toBeInTheDocument();

    // Constraint conditions are displayed (now in <textarea> elements)
    expect(screen.getByDisplayValue('message.length > 500')).toBeInTheDocument();
    expect(screen.getByDisplayValue('user.verified === true')).toBeInTheDocument();
    expect(screen.getByDisplayValue('topic !== "billing"')).toBeInTheDocument();
    expect(screen.getByDisplayValue('sentiment.score > 0.3')).toBeInTheDocument();
  });

  it('shows constraint condition and on_fail action', () => {
    render(
      <RulesSection
        data={{ constraints: [respondConstraint, blockConstraint], guardrails: [] }}
        isExpanded={true}
        onToggle={() => {}}
        onChange={() => {}}
      />,
    );

    // Condition expressions (now in <textarea> elements)
    expect(screen.getByDisplayValue('message.length > 500')).toBeInTheDocument();
    expect(screen.getByDisplayValue('user.verified === true')).toBeInTheDocument();

    // On-fail action type (now in <select> elements)
    expect(screen.getByDisplayValue('respond')).toBeInTheDocument();
    expect(screen.getByDisplayValue('block')).toBeInTheDocument();

    // On-fail messages (now in <input> elements)
    expect(
      screen.getByDisplayValue('Please keep your message under 500 characters.'),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue('Unverified users are not allowed.')).toBeInTheDocument();
  });

  it('renders guardrails sub-section with name and check', () => {
    render(
      <RulesSection
        data={{ constraints: [], guardrails: [piiGuardrail, toxicityGuardrail] }}
        isExpanded={true}
        onToggle={() => {}}
        onChange={() => {}}
      />,
    );

    // Guardrails sub-section header
    expect(screen.getByText('Guardrails')).toBeInTheDocument();

    // Guardrail names (now in <input> elements)
    expect(screen.getByDisplayValue('pii_filter')).toBeInTheDocument();
    expect(screen.getByDisplayValue('toxicity_check')).toBeInTheDocument();

    // Guardrail descriptions (now in <textarea> elements)
    expect(
      screen.getByDisplayValue('Prevents PII from being exposed in responses'),
    ).toBeInTheDocument();
    expect(
      screen.getByDisplayValue('Ensures responses are not toxic or harmful'),
    ).toBeInTheDocument();

    // Guardrail check text (now in <textarea> elements)
    expect(
      screen.getByDisplayValue('response does not contain SSN, credit card numbers, or passwords'),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue('response toxicity score < 0.5')).toBeInTheDocument();

    // Guardrail action type (now in <select> elements)
    expect(screen.getByDisplayValue('block')).toBeInTheDocument();
    expect(screen.getByDisplayValue('respond')).toBeInTheDocument();
  });

  it('shows [+ Add Constraint] and [+ Add Guardrail] buttons', () => {
    render(
      <RulesSection data={mockRules} isExpanded={true} onToggle={() => {}} onChange={() => {}} />,
    );

    const addConstraintBtn = screen.getByRole('button', { name: /add constraint/i });
    expect(addConstraintBtn).toBeInTheDocument();

    const addGuardrailBtn = screen.getByRole('button', { name: /add guardrail/i });
    expect(addGuardrailBtn).toBeInTheDocument();
  });

  it('renders empty state when no rules', () => {
    render(
      <RulesSection data={emptyRules} isExpanded={false} onToggle={() => {}} onChange={() => {}} />,
    );

    // Title still shows
    expect(screen.getByText('Rules')).toBeInTheDocument();

    // SectionCard handles empty state via isEmpty prop
    expect(screen.getByText(/no rules defined/i)).toBeInTheDocument();
  });
});
