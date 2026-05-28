/**
 * Tests for TypeToConfirmInput component.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Mock lucide-react to avoid happy-dom hangs
vi.mock('lucide-react', () => {
  const n = () => null;
  return { Loader2: n };
});

import { TypeToConfirmInput } from '../../components/ui/TypeToConfirmInput';

describe('TypeToConfirmInput', () => {
  const defaultProps = {
    confirmText: 'DELETE',
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    warningMessage: 'This action is irreversible.',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Rendering ───────────────────────────────────────────────────────

  it('renders warning message', () => {
    render(<TypeToConfirmInput {...defaultProps} />);
    expect(screen.getByText('This action is irreversible.')).toBeInTheDocument();
  });

  it('renders confirm and cancel buttons with default labels', () => {
    render(<TypeToConfirmInput {...defaultProps} />);
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('renders custom confirm and cancel labels', () => {
    render(
      <TypeToConfirmInput {...defaultProps} confirmLabel="Yes, Delete" cancelLabel="Go Back" />,
    );
    expect(screen.getByRole('button', { name: 'Yes, Delete' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go Back' })).toBeInTheDocument();
  });

  it('renders consequences list', () => {
    render(
      <TypeToConfirmInput
        {...defaultProps}
        consequences={['All data will be lost', 'Cannot be undone']}
      />,
    );
    expect(screen.getByText('All data will be lost')).toBeInTheDocument();
    expect(screen.getByText('Cannot be undone')).toBeInTheDocument();
  });

  it('renders input with placeholder showing confirmText', () => {
    render(<TypeToConfirmInput {...defaultProps} />);
    const input = screen.getByRole('textbox');
    expect(input).toHaveAttribute('placeholder', 'Type "DELETE" to confirm');
  });

  // ─── Confirm button disabled state ───────────────────────────────────

  it('confirm button is disabled by default (empty input)', () => {
    render(<TypeToConfirmInput {...defaultProps} />);
    const confirmBtn = screen.getByRole('button', { name: 'Confirm' });
    expect(confirmBtn).toBeDisabled();
  });

  it('confirm button is disabled when input does not match', () => {
    render(<TypeToConfirmInput {...defaultProps} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'DELE' } });

    const confirmBtn = screen.getByRole('button', { name: 'Confirm' });
    expect(confirmBtn).toBeDisabled();
  });

  it('confirm button is enabled when input matches (case-insensitive)', () => {
    render(<TypeToConfirmInput {...defaultProps} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'delete' } });

    const confirmBtn = screen.getByRole('button', { name: 'Confirm' });
    expect(confirmBtn).not.toBeDisabled();
  });

  it('confirm button is enabled with exact case match', () => {
    render(<TypeToConfirmInput {...defaultProps} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'DELETE' } });

    const confirmBtn = screen.getByRole('button', { name: 'Confirm' });
    expect(confirmBtn).not.toBeDisabled();
  });

  // ─── Interactions ────────────────────────────────────────────────────

  it('calls onConfirm when text matches and confirm is clicked', () => {
    const onConfirm = vi.fn();
    render(<TypeToConfirmInput {...defaultProps} onConfirm={onConfirm} />);

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'DELETE' } });

    const confirmBtn = screen.getByRole('button', { name: 'Confirm' });
    fireEvent.click(confirmBtn);

    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('calls onCancel when cancel button is clicked', () => {
    const onCancel = vi.fn();
    render(<TypeToConfirmInput {...defaultProps} onCancel={onCancel} />);

    const cancelBtn = screen.getByRole('button', { name: 'Cancel' });
    fireEvent.click(cancelBtn);

    expect(onCancel).toHaveBeenCalledOnce();
  });

  // ─── Loading state ───────────────────────────────────────────────────

  it('disables both buttons when loading', () => {
    render(<TypeToConfirmInput {...defaultProps} loading />);

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'DELETE' } });

    const confirmBtn = screen.getByRole('button', { name: 'Confirm' });
    const cancelBtn = screen.getByRole('button', { name: 'Cancel' });

    expect(confirmBtn).toBeDisabled();
    expect(cancelBtn).toBeDisabled();
  });

  it('does not call onConfirm when loading even if text matches', () => {
    const onConfirm = vi.fn();
    render(<TypeToConfirmInput {...defaultProps} onConfirm={onConfirm} loading />);

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'DELETE' } });

    const confirmBtn = screen.getByRole('button', { name: 'Confirm' });
    fireEvent.click(confirmBtn);

    expect(onConfirm).not.toHaveBeenCalled();
  });

  // ─── Variant styling ────────────────────────────────────────────────

  it('applies danger border by default', () => {
    const { container } = render(<TypeToConfirmInput {...defaultProps} />);
    const warningBlock = container.querySelector('.border-error');
    expect(warningBlock).toBeInTheDocument();
  });

  it('applies warning border for warning variant', () => {
    const { container } = render(<TypeToConfirmInput {...defaultProps} variant="warning" />);
    const warningBlock = container.querySelector('.border-warning');
    expect(warningBlock).toBeInTheDocument();
  });
});
