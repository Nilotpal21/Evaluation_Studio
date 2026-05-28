/**
 * IdentitySection Component Tests
 *
 * Tests for the agent identity section editor: mode, goal, persona, and limitations.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { IdentitySection } from '../../components/agent-detail/IdentitySection';
import type { IdentitySectionData } from '../../store/agent-detail-store';

const mockData: IdentitySectionData = {
  mode: 'reasoning',
  model: 'claude-sonnet-4-6',
  temperature: 0.7,
  maxTokens: 4096,
  goal: 'Help users book hotels',
  persona: 'You are a friendly hotel booking assistant.',
  limitations: ['Cannot process payments', 'No refunds'],
};

describe('IdentitySection', () => {
  it('renders collapsed summary with mode badge, model name, goal preview', () => {
    render(
      <IdentitySection
        data={mockData}
        isExpanded={false}
        onToggle={() => {}}
        onChange={() => {}}
      />,
    );

    expect(screen.getByText('Identity')).toBeInTheDocument();
    expect(screen.getByText(/reasoning/i)).toBeInTheDocument();
  });

  it('renders expanded form with goal textarea', () => {
    render(
      <IdentitySection data={mockData} isExpanded={true} onToggle={() => {}} onChange={() => {}} />,
    );

    const goalTextarea = screen.getByLabelText('Goal');
    expect(goalTextarea).toBeInTheDocument();
    expect(goalTextarea).toHaveValue('Help users book hotels');
  });

  it('calls onChange when goal is edited', () => {
    const onChange = vi.fn();
    render(
      <IdentitySection data={mockData} isExpanded={true} onToggle={() => {}} onChange={onChange} />,
    );

    const goalTextarea = screen.getByLabelText('Goal');
    fireEvent.change(goalTextarea, { target: { value: 'Help users book flights' } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ goal: 'Help users book flights' }),
    );
  });

  it('renders mode dropdown in expanded state', () => {
    render(
      <IdentitySection data={mockData} isExpanded={true} onToggle={() => {}} onChange={() => {}} />,
    );

    expect(screen.getByLabelText('Execution Mode')).toBeInTheDocument();
  });

  it('renders limitations as removable tags', () => {
    render(
      <IdentitySection data={mockData} isExpanded={true} onToggle={() => {}} onChange={() => {}} />,
    );

    expect(screen.getByText('Cannot process payments')).toBeInTheDocument();
    expect(screen.getByText('No refunds')).toBeInTheDocument();
    expect(screen.getByLabelText('Edit limitation: Cannot process payments')).toBeInTheDocument();
  });

  it('calls onChange when a limitation is removed', () => {
    const onChange = vi.fn();
    render(
      <IdentitySection data={mockData} isExpanded={true} onToggle={() => {}} onChange={onChange} />,
    );

    // Each limitation tag has a remove button with aria-label
    const removeButtons = screen.getAllByLabelText(/Remove limitation/i);
    fireEvent.click(removeButtons[0]);

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        limitations: ['No refunds'],
      }),
    );
  });

  it('prefills the limitation input when editing a chip', () => {
    render(
      <IdentitySection data={mockData} isExpanded={true} onToggle={() => {}} onChange={() => {}} />,
    );

    fireEvent.click(screen.getByLabelText('Edit limitation: No refunds'));

    expect(screen.getByPlaceholderText('Add a limitation...')).toHaveValue('No refunds');
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('calls onChange when a limitation is edited and saved', () => {
    const onChange = vi.fn();
    render(
      <IdentitySection data={mockData} isExpanded={true} onToggle={() => {}} onChange={onChange} />,
    );

    fireEvent.click(screen.getByLabelText('Edit limitation: Cannot process payments'));
    fireEvent.change(screen.getByPlaceholderText('Add a limitation...'), {
      target: { value: 'Do not approve transactions above $5000 without review' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        limitations: ['Do not approve transactions above $5000 without review', 'No refunds'],
      }),
    );
  });

  it('cancels limitation editing without calling onChange', () => {
    const onChange = vi.fn();
    render(
      <IdentitySection data={mockData} isExpanded={true} onToggle={() => {}} onChange={onChange} />,
    );

    fireEvent.click(screen.getByLabelText('Edit limitation: No refunds'));
    fireEvent.change(screen.getByPlaceholderText('Add a limitation...'), {
      target: { value: 'Updated refund policy' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByPlaceholderText('Add a limitation...')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('renders persona textarea in expanded state', () => {
    render(
      <IdentitySection data={mockData} isExpanded={true} onToggle={() => {}} onChange={() => {}} />,
    );

    const personaTextarea = screen.getByLabelText('Persona');
    expect(personaTextarea).toBeInTheDocument();
    expect(personaTextarea).toHaveValue('You are a friendly hotel booking assistant.');
  });

  it('calls onChange when persona is edited', () => {
    const onChange = vi.fn();
    render(
      <IdentitySection data={mockData} isExpanded={true} onToggle={() => {}} onChange={onChange} />,
    );

    const personaTextarea = screen.getByLabelText('Persona');
    fireEvent.change(personaTextarea, { target: { value: 'A professional assistant.' } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ persona: 'A professional assistant.' }),
    );
  });

  it('does not render model hyperparameter controls in the identity editor', () => {
    render(
      <IdentitySection data={mockData} isExpanded={true} onToggle={() => {}} onChange={() => {}} />,
    );

    expect(screen.queryByLabelText('Model')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Temperature')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Max Tokens')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Enable Thinking')).not.toBeInTheDocument();
  });

  it('does not render form fields when collapsed', () => {
    render(
      <IdentitySection
        data={mockData}
        isExpanded={false}
        onToggle={() => {}}
        onChange={() => {}}
      />,
    );

    expect(screen.queryByLabelText('Goal')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Persona')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Execution Mode')).not.toBeInTheDocument();
  });
});
