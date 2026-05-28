/**
 * GatherSection Component Tests
 *
 * Tests for the gather fields section: collapsed summary with field count and
 * name pills (filled=required, outlined=optional), expanded table with field
 * details, and the add field button.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GatherSection } from '../../components/agent-detail/GatherSection';
import type { GatherFieldData } from '../../store/agent-detail-store';

// =============================================================================
// TEST DATA
// =============================================================================

const requiredField: GatherFieldData = {
  name: 'destination',
  prompt: 'Where would you like to travel?',
  type: 'string',
  required: true,
  extractionHints: ['city name', 'country'],
};

const optionalFieldWithDefault: GatherFieldData = {
  name: 'budget',
  prompt: 'What is your budget?',
  type: 'number',
  required: false,
  defaultValue: 500,
};

const requiredFieldWithValidation: GatherFieldData = {
  name: 'email',
  prompt: 'Please provide your email address',
  type: 'string',
  required: true,
  validation: {
    type: 'regex',
    rule: '^[\\w.-]+@[\\w.-]+\\.\\w+$',
    errorMessage: 'Please enter a valid email',
  },
};

const optionalFieldNoDefault: GatherFieldData = {
  name: 'notes',
  prompt: 'Any special requests?',
  type: 'string',
  required: false,
};

const mockFields: GatherFieldData[] = [
  requiredField,
  optionalFieldWithDefault,
  requiredFieldWithValidation,
  optionalFieldNoDefault,
];

// =============================================================================
// TESTS
// =============================================================================

describe('GatherSection', () => {
  it('renders collapsed with field count and name pills', () => {
    render(
      <GatherSection
        data={mockFields}
        isExpanded={false}
        onToggle={() => {}}
        onChange={() => {}}
      />,
    );

    // Title is "Gather Fields"
    expect(screen.getByText('Gather Fields')).toBeInTheDocument();

    // Count badge shows "4"
    expect(screen.getByText('4')).toBeInTheDocument();

    // Field name pills visible when collapsed
    expect(screen.getByText('destination')).toBeInTheDocument();
    expect(screen.getByText('budget')).toBeInTheDocument();
    expect(screen.getByText('email')).toBeInTheDocument();
    expect(screen.getByText('notes')).toBeInTheDocument();
  });

  it('shows required fields as filled badges and optional as outlined', () => {
    render(
      <GatherSection
        data={mockFields}
        isExpanded={false}
        onToggle={() => {}}
        onChange={() => {}}
      />,
    );

    // Required fields should have filled style (bg-accent-subtle)
    const destinationPill = screen.getByText('destination');
    expect(destinationPill.className).toContain('bg-accent-subtle');
    expect(destinationPill.className).toContain('text-accent');

    const emailPill = screen.getByText('email');
    expect(emailPill.className).toContain('bg-accent-subtle');
    expect(emailPill.className).toContain('text-accent');

    // Optional fields should have outlined style (border)
    const budgetPill = screen.getByText('budget');
    expect(budgetPill.className).toContain('border');
    expect(budgetPill.className).toContain('text-muted');

    const notesPill = screen.getByText('notes');
    expect(notesPill.className).toContain('border');
    expect(notesPill.className).toContain('text-muted');
  });

  it('renders expanded with field values in inputs', () => {
    render(
      <GatherSection data={mockFields} isExpanded={true} onToggle={() => {}} onChange={() => {}} />,
    );

    // Field names in input elements
    expect(screen.getByDisplayValue('destination')).toBeInTheDocument();
    expect(screen.getByDisplayValue('budget')).toBeInTheDocument();
    expect(screen.getByDisplayValue('email')).toBeInTheDocument();
    expect(screen.getByDisplayValue('notes')).toBeInTheDocument();
  });

  it('shows field data in editable inputs', () => {
    render(
      <GatherSection
        data={[requiredField, optionalFieldWithDefault]}
        isExpanded={true}
        onToggle={() => {}}
        onChange={() => {}}
      />,
    );

    // Field names in input elements
    expect(screen.getByDisplayValue('destination')).toBeInTheDocument();
    expect(screen.getByDisplayValue('budget')).toBeInTheDocument();

    // Types in select elements
    expect(screen.getByDisplayValue('string')).toBeInTheDocument();
    expect(screen.getByDisplayValue('number')).toBeInTheDocument();

    // Prompt text in textarea elements
    expect(screen.getByDisplayValue('Where would you like to travel?')).toBeInTheDocument();
    expect(screen.getByDisplayValue('What is your budget?')).toBeInTheDocument();

    // Default value for budget field in input element
    expect(screen.getByDisplayValue('500')).toBeInTheDocument();
  });

  it('shows [+ Add Field] button in expanded state', () => {
    render(
      <GatherSection data={mockFields} isExpanded={true} onToggle={() => {}} onChange={() => {}} />,
    );

    const addButton = screen.getByRole('button', { name: /add field/i });
    expect(addButton).toBeInTheDocument();
  });

  it('renders empty state when no fields', () => {
    render(<GatherSection data={[]} isExpanded={false} onToggle={() => {}} onChange={() => {}} />);

    // Title still shows
    expect(screen.getByText('Gather Fields')).toBeInTheDocument();

    // SectionCard handles empty state via isEmpty prop
    expect(screen.getByText(/no gather fields defined/i)).toBeInTheDocument();
  });
});
