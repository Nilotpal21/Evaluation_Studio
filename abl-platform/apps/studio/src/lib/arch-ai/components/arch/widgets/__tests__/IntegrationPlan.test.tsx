import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { IntegrationPlan, type IntegrationPlanInput } from '../IntegrationPlan';

const baseInput: IntegrationPlanInput = {
  widgetType: 'IntegrationPlan',
  rationale: 'Connect Slack so the agent can post updates.',
  steps: [
    { id: 's1', description: 'Authorize Slack workspace' },
    { id: 's2', description: 'Pick a default channel' },
    { id: 's3', description: 'Send a test message' },
  ],
};

describe('IntegrationPlan widget', () => {
  it('renders rationale and numbered steps', () => {
    render(<IntegrationPlan input={baseInput} onSubmit={vi.fn()} />);

    expect(screen.getByText(/connect slack so the agent/i)).toBeTruthy();
    expect(screen.getByText('1.')).toBeTruthy();
    expect(screen.getByText('2.')).toBeTruthy();
    expect(screen.getByText('3.')).toBeTruthy();
    expect(screen.getByText(/authorize slack workspace/i)).toBeTruthy();
    expect(screen.getByText(/pick a default channel/i)).toBeTruthy();
    expect(screen.getByText(/send a test message/i)).toBeTruthy();
  });

  it('submits approve with the original steps when Approve is clicked', () => {
    const onSubmit = vi.fn();
    render(<IntegrationPlan input={baseInput} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      action: 'approve',
      editedSteps: baseInput.steps,
    });
  });

  it('allows editing a step and submits the edited text on Edit & continue', () => {
    const onSubmit = vi.fn();
    render(<IntegrationPlan input={baseInput} onSubmit={onSubmit} />);

    // Click the first step to enter edit mode
    fireEvent.click(screen.getByRole('button', { name: /authorize slack workspace/i }));

    const editor = screen.getByLabelText('Step 1 description') as HTMLInputElement;
    fireEvent.change(editor, { target: { value: 'Authorize Slack via OAuth' } });

    fireEvent.click(screen.getByRole('button', { name: /edit & continue/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const arg = onSubmit.mock.calls[0][0];
    expect(arg.action).toBe('edit');
    expect(arg.editedSteps).toEqual([
      { id: 's1', description: 'Authorize Slack via OAuth' },
      { id: 's2', description: 'Pick a default channel' },
      { id: 's3', description: 'Send a test message' },
    ]);
  });

  it('submits reject with feedback when Reject is clicked', () => {
    const onSubmit = vi.fn();
    render(<IntegrationPlan input={baseInput} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText('Optional feedback'), {
      target: { value: 'Not now' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^reject$/i }));

    expect(onSubmit).toHaveBeenCalledWith({ action: 'reject', feedback: 'Not now' });
  });

  it('only submits once even if a button is clicked multiple times', () => {
    const onSubmit = vi.fn();
    render(<IntegrationPlan input={baseInput} onSubmit={onSubmit} />);

    const approve = screen.getByRole('button', { name: /^approve$/i });
    fireEvent.click(approve);
    fireEvent.click(approve);

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
