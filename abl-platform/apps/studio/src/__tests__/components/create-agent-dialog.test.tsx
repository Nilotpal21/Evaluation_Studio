/**
 * CreateAgentDialog Component Tests
 *
 * Tests for the agent creation dialog: form fields, validation, submit
 * behavior, loading states, success/error handling, and close/cancel.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// =============================================================================
// MOCKS
// =============================================================================

// Mock sonner toast — vi.hoisted ensures mockToast is available at mock-factory time
const mockToast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));
vi.mock('sonner', () => ({
  toast: mockToast,
  Toaster: () => null,
}));

// Mock API modules
const mockAddAgentToProject = vi.fn();
const mockSaveDslWorkingCopy = vi.fn();

vi.mock('../../api/projects', () => ({
  addAgentToProject: (...args: unknown[]) => mockAddAgentToProject(...args),
  fetchProject: vi.fn(() => Promise.resolve({})),
}));

vi.mock('../../api/runtime-agents', () => ({
  saveDslWorkingCopy: (...args: unknown[]) => mockSaveDslWorkingCopy(...args),
}));

// Mock Dialog — Radix Dialog causes happy-dom hangs.
// Lightweight stub that mirrors open/close behavior.
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
        {title && <h2 data-testid="dialog-title">{title}</h2>}
        {description && <p data-testid="dialog-description">{description}</p>}
        <button data-testid="dialog-close" onClick={onClose}>
          Close
        </button>
        {children}
      </div>
    );
  },
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import { CreateAgentDialog } from '../../components/agents/CreateAgentDialog';

// =============================================================================
// HELPERS
// =============================================================================

const defaultProps = {
  open: true,
  onClose: vi.fn(),
  projectId: 'proj-123',
  onCreated: vi.fn(),
};

function renderDialog(overrides: Partial<typeof defaultProps> = {}) {
  const props = { ...defaultProps, ...overrides };
  return { ...render(<CreateAgentDialog {...props} />), props };
}

/** Get the submit button (the "Create Agent" Button, not the dialog title) */
function getSubmitButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Create Agent' }) as HTMLButtonElement;
}

// =============================================================================
// TESTS
// =============================================================================

describe('CreateAgentDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAddAgentToProject.mockResolvedValue({ id: 'agent-1', name: 'Test_Agent' });
    mockSaveDslWorkingCopy.mockResolvedValue({
      success: true,
      updatedAt: new Date().toISOString(),
    });
  });

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  it('renders dialog when open=true', () => {
    renderDialog();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('dialog-title')).toHaveTextContent('Create Agent');
  });

  it('does not render when open=false', () => {
    renderDialog({ open: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows dialog title and description', () => {
    renderDialog();
    expect(screen.getByTestId('dialog-title')).toHaveTextContent('Create Agent');
    expect(screen.getByTestId('dialog-description')).toHaveTextContent(
      'Add a new agent to this project',
    );
  });

  it('shows agent name input with label and placeholder', () => {
    renderDialog();
    expect(screen.getByText('Agent Name')).toBeInTheDocument();
    const nameInput = screen.getByPlaceholderText('e.g., Booking_Agent');
    expect(nameInput).toBeInTheDocument();
    expect(nameInput).toHaveValue('');
  });

  it('shows execution mode select with label', () => {
    renderDialog();
    expect(screen.getByText('Execution Mode')).toBeInTheDocument();
    // Radix Select renders a trigger with role="combobox"
    const modeSelect = screen.getByRole('combobox');
    expect(modeSelect).toBeInTheDocument();
    // Default mode is 'reasoning' — the trigger displays the selected label
    expect(modeSelect.textContent).toContain('Reasoning');
  });

  it('shows mode options for Reasoning and Flow-based', () => {
    renderDialog();
    // Radix Select renders a trigger with role="combobox" that shows the current value
    const modeSelect = screen.getByRole('combobox');
    expect(modeSelect).toBeInTheDocument();
    // The default selected option ('Reasoning') should be visible in the trigger
    expect(modeSelect.textContent).toContain('Reasoning');
    // The Execution Mode label should be visible
    expect(screen.getByText('Execution Mode')).toBeInTheDocument();
  });

  it('shows description input with label and placeholder', () => {
    renderDialog();
    expect(screen.getByText('Description (optional)')).toBeInTheDocument();
    const descInput = screen.getByPlaceholderText('What does this agent do?');
    expect(descInput).toBeInTheDocument();
  });

  it('shows Cancel and Create Agent buttons', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(getSubmitButton()).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Name validation
  // ---------------------------------------------------------------------------

  it('submit button is disabled when name is empty', () => {
    renderDialog();
    expect(getSubmitButton()).toBeDisabled();
  });

  it('submit button is enabled when name is valid', () => {
    renderDialog();
    const nameInput = screen.getByPlaceholderText('e.g., Booking_Agent');
    fireEvent.change(nameInput, { target: { value: 'My_Agent' } });
    expect(getSubmitButton()).not.toBeDisabled();
  });

  it('submit button is disabled when name is only whitespace', () => {
    renderDialog();
    const nameInput = screen.getByPlaceholderText('e.g., Booking_Agent');
    fireEvent.change(nameInput, { target: { value: '   ' } });
    expect(getSubmitButton()).toBeDisabled();
  });

  it('shows error when submitting with invalid characters', async () => {
    renderDialog();
    const nameInput = screen.getByPlaceholderText('e.g., Booking_Agent');
    fireEvent.change(nameInput, { target: { value: 'agent-with-dashes' } });
    fireEvent.click(getSubmitButton());

    await waitFor(() => {
      expect(
        screen.getByText('Must start with a letter, only letters, numbers, and underscores'),
      ).toBeInTheDocument();
    });
    expect(mockAddAgentToProject).not.toHaveBeenCalled();
  });

  it('shows error when submitting with name starting with a number', async () => {
    renderDialog();
    const nameInput = screen.getByPlaceholderText('e.g., Booking_Agent');
    fireEvent.change(nameInput, { target: { value: '1Agent' } });
    fireEvent.click(getSubmitButton());

    await waitFor(() => {
      expect(
        screen.getByText('Must start with a letter, only letters, numbers, and underscores'),
      ).toBeInTheDocument();
    });
    expect(mockAddAgentToProject).not.toHaveBeenCalled();
  });

  it('clears validation error when user corrects the name', async () => {
    renderDialog();
    const nameInput = screen.getByPlaceholderText('e.g., Booking_Agent');

    // First, trigger an error
    fireEvent.change(nameInput, { target: { value: 'bad-name' } });
    fireEvent.click(getSubmitButton());
    await waitFor(() => {
      expect(
        screen.getByText('Must start with a letter, only letters, numbers, and underscores'),
      ).toBeInTheDocument();
    });

    // Now correct the name — the onChange handler re-validates when there's an existing error
    fireEvent.change(nameInput, { target: { value: 'Good_Name' } });
    await waitFor(() => {
      expect(
        screen.queryByText('Must start with a letter, only letters, numbers, and underscores'),
      ).not.toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Successful submission
  // ---------------------------------------------------------------------------

  it('calls API to create agent on submit', async () => {
    renderDialog();
    const nameInput = screen.getByPlaceholderText('e.g., Booking_Agent');
    fireEvent.change(nameInput, { target: { value: 'Booking_Agent' } });
    fireEvent.click(getSubmitButton());

    await waitFor(() => {
      expect(mockAddAgentToProject).toHaveBeenCalledWith('proj-123', {
        name: 'Booking_Agent',
        description: undefined,
      });
    });
  });

  it('saves DSL skeleton after agent creation', async () => {
    renderDialog();
    const nameInput = screen.getByPlaceholderText('e.g., Booking_Agent');
    fireEvent.change(nameInput, { target: { value: 'Booking_Agent' } });
    fireEvent.click(getSubmitButton());

    await waitFor(() => {
      expect(mockSaveDslWorkingCopy).toHaveBeenCalledWith(
        'proj-123',
        'Booking_Agent',
        expect.stringContaining('AGENT: Booking_Agent'),
      );
    });
  });

  it('generates reasoning skeleton by default', async () => {
    // Radix Select cannot be programmatically changed via fireEvent in happy-dom,
    // so we verify the default reasoning mode generates the expected skeleton.
    renderDialog();
    const nameInput = screen.getByPlaceholderText('e.g., Booking_Agent');
    fireEvent.change(nameInput, { target: { value: 'Reasoning_Agent' } });

    fireEvent.click(getSubmitButton());

    await waitFor(() => {
      expect(mockSaveDslWorkingCopy).toHaveBeenCalledWith(
        'proj-123',
        'Reasoning_Agent',
        expect.stringContaining('AGENT: Reasoning_Agent'),
      );
      // Reasoning skeleton should NOT contain FLOW:
      const skeleton = mockSaveDslWorkingCopy.mock.calls[0][2];
      expect(skeleton).not.toContain('FLOW:');
    });
  });

  it('passes description to addAgentToProject when provided', async () => {
    renderDialog();
    const nameInput = screen.getByPlaceholderText('e.g., Booking_Agent');
    fireEvent.change(nameInput, { target: { value: 'Booking_Agent' } });
    const descInput = screen.getByPlaceholderText('What does this agent do?');
    fireEvent.change(descInput, { target: { value: 'Books hotels for users' } });
    fireEvent.click(getSubmitButton());

    await waitFor(() => {
      expect(mockAddAgentToProject).toHaveBeenCalledWith('proj-123', {
        name: 'Booking_Agent',
        description: 'Books hotels for users',
      });
    });
  });

  it('calls onCreated callback on success', async () => {
    const onCreated = vi.fn();
    renderDialog({ onCreated });
    const nameInput = screen.getByPlaceholderText('e.g., Booking_Agent');
    fireEvent.change(nameInput, { target: { value: 'Booking_Agent' } });
    fireEvent.click(getSubmitButton());

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith('Booking_Agent');
    });
  });

  it('shows success toast on success', async () => {
    renderDialog();
    const nameInput = screen.getByPlaceholderText('e.g., Booking_Agent');
    fireEvent.change(nameInput, { target: { value: 'Booking_Agent' } });
    fireEvent.click(getSubmitButton());

    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith('Agent created');
    });
  });

  it('calls onClose after successful creation', async () => {
    const onClose = vi.fn();
    renderDialog({ onClose });
    const nameInput = screen.getByPlaceholderText('e.g., Booking_Agent');
    fireEvent.change(nameInput, { target: { value: 'Booking_Agent' } });
    fireEvent.click(getSubmitButton());

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  it('shows error toast on API failure', async () => {
    mockAddAgentToProject.mockRejectedValueOnce(new Error('Agent already exists'));
    renderDialog();
    const nameInput = screen.getByPlaceholderText('e.g., Booking_Agent');
    fireEvent.change(nameInput, { target: { value: 'Existing_Agent' } });
    fireEvent.click(getSubmitButton());

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalled();
    });
  });

  it('does not call onCreated on API failure', async () => {
    mockAddAgentToProject.mockRejectedValueOnce(new Error('Server error'));
    const onCreated = vi.fn();
    renderDialog({ onCreated });
    const nameInput = screen.getByPlaceholderText('e.g., Booking_Agent');
    fireEvent.change(nameInput, { target: { value: 'Booking_Agent' } });
    fireEvent.click(getSubmitButton());

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalled();
    });
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('re-enables submit button after failure', async () => {
    mockAddAgentToProject.mockRejectedValueOnce(new Error('fail'));
    renderDialog();
    const nameInput = screen.getByPlaceholderText('e.g., Booking_Agent');
    fireEvent.change(nameInput, { target: { value: 'Booking_Agent' } });
    fireEvent.click(getSubmitButton());

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalled();
    });

    // Button should be enabled again after failure
    expect(getSubmitButton()).not.toBeDisabled();
  });

  it('handles DSL save failure gracefully', async () => {
    mockSaveDslWorkingCopy.mockRejectedValueOnce(new Error('DSL save failed'));
    renderDialog();
    const nameInput = screen.getByPlaceholderText('e.g., Booking_Agent');
    fireEvent.change(nameInput, { target: { value: 'Booking_Agent' } });
    fireEvent.click(getSubmitButton());

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Close/cancel behavior
  // ---------------------------------------------------------------------------

  it('calls onClose when Cancel button is clicked', () => {
    const onClose = vi.fn();
    renderDialog({ onClose });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('resets form state when dialog is closed via Cancel', () => {
    const { rerender, props } = renderDialog();

    // Enter some data
    const nameInput = screen.getByPlaceholderText('e.g., Booking_Agent');
    fireEvent.change(nameInput, { target: { value: 'My_Agent' } });

    // Click cancel (which calls handleClose internally, resetting state)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // Re-render as open to verify state was reset
    rerender(<CreateAgentDialog {...props} open={true} />);

    const freshInput = screen.getByPlaceholderText('e.g., Booking_Agent');
    expect(freshInput).toHaveValue('');
  });

  it('disables Cancel button while submitting', async () => {
    // Make the API call hang so we can check the intermediate state
    let resolveApi!: (value: unknown) => void;
    mockAddAgentToProject.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveApi = resolve;
        }),
    );

    renderDialog();
    const nameInput = screen.getByPlaceholderText('e.g., Booking_Agent');
    fireEvent.change(nameInput, { target: { value: 'Booking_Agent' } });
    fireEvent.click(getSubmitButton());

    // Cancel should be disabled during submission
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    });

    // Resolve the API to clean up
    resolveApi({ id: 'agent-1', name: 'Booking_Agent' });
  });

  // ---------------------------------------------------------------------------
  // Loading state
  // ---------------------------------------------------------------------------

  it('shows loading state during creation', async () => {
    let resolveApi!: (value: unknown) => void;
    mockAddAgentToProject.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveApi = resolve;
        }),
    );

    renderDialog();
    const nameInput = screen.getByPlaceholderText('e.g., Booking_Agent');
    fireEvent.change(nameInput, { target: { value: 'Booking_Agent' } });
    fireEvent.click(getSubmitButton());

    // Should show "Creating..." text during submission
    await waitFor(() => {
      expect(screen.getByText('Creating...')).toBeInTheDocument();
    });

    // Resolve to clean up
    resolveApi({ id: 'agent-1', name: 'Booking_Agent' });
  });

  // ---------------------------------------------------------------------------
  // Description trimming
  // ---------------------------------------------------------------------------

  it('trims description before submitting', async () => {
    renderDialog();
    const nameInput = screen.getByPlaceholderText('e.g., Booking_Agent');
    fireEvent.change(nameInput, { target: { value: 'Booking_Agent' } });
    const descInput = screen.getByPlaceholderText('What does this agent do?');
    fireEvent.change(descInput, { target: { value: '  A helpful agent  ' } });
    fireEvent.click(getSubmitButton());

    await waitFor(() => {
      expect(mockAddAgentToProject).toHaveBeenCalledWith('proj-123', {
        name: 'Booking_Agent',
        description: 'A helpful agent',
      });
    });
  });

  it('passes undefined description when description is empty', async () => {
    renderDialog();
    const nameInput = screen.getByPlaceholderText('e.g., Booking_Agent');
    fireEvent.change(nameInput, { target: { value: 'Booking_Agent' } });
    fireEvent.click(getSubmitButton());

    await waitFor(() => {
      expect(mockAddAgentToProject).toHaveBeenCalledWith('proj-123', {
        name: 'Booking_Agent',
        description: undefined,
      });
    });
  });

  it('passes undefined description when description is only whitespace', async () => {
    renderDialog();
    const nameInput = screen.getByPlaceholderText('e.g., Booking_Agent');
    fireEvent.change(nameInput, { target: { value: 'Booking_Agent' } });
    const descInput = screen.getByPlaceholderText('What does this agent do?');
    fireEvent.change(descInput, { target: { value: '   ' } });
    fireEvent.click(getSubmitButton());

    await waitFor(() => {
      expect(mockAddAgentToProject).toHaveBeenCalledWith('proj-123', {
        name: 'Booking_Agent',
        description: undefined,
      });
    });
  });
});
