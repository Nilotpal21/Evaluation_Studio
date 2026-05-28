/**
 * AgentEditorHeader Component Tests
 *
 * Comprehensive tests for the unified agent editor header bar.
 * Covers rendering, save/discard states, action buttons, and navigation.
 *
 * @vitest-environment happy-dom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// =============================================================================
// MOCKS
// =============================================================================

// Mock Tooltip/TooltipProvider to render children directly (Radix portals
// don't work in happy-dom). Also capture tooltip content for assertion.
// Use React.createElement to avoid JSX in hoisted vi.mock factory.
vi.mock('../../components/ui/Tooltip', () => ({
  Tooltip: ({ children, content }: { children: React.ReactNode; content: string }) =>
    React.createElement('div', { 'data-tooltip-content': content }, children),
  TooltipProvider: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import { AgentEditorHeader } from '../../components/agent-editor/AgentEditorHeader';

// =============================================================================
// HELPERS
// =============================================================================

const defaultProps = {
  agentName: 'booking_agent',
  mode: 'Reasoning',
  isDirty: false,
  isSaving: false,
  onSave: vi.fn(),
  onDiscard: vi.fn(),
};

function renderHeader(overrides: Partial<Parameters<typeof AgentEditorHeader>[0]> = {}) {
  return render(<AgentEditorHeader {...defaultProps} {...overrides} />);
}

/**
 * Finds the save/saving/saved/error button. The button always contains an icon
 * SVG whose <title> matches the button text (e.g., "Save"), so screen.getByText
 * returns multiple elements. This helper finds the button directly via its
 * tooltip wrapper's data attribute (save tooltip always contains a specific phrase).
 */
function getSaveButton(): HTMLButtonElement {
  // The save button is always wrapped by a tooltip div. Find it by looking for
  // the button that is a descendant of a tooltip with specific save-related content.
  const tooltips = document.querySelectorAll('[data-tooltip-content]');
  for (const tooltip of tooltips) {
    const content = tooltip.getAttribute('data-tooltip-content') ?? '';
    if (
      content.includes('Save') ||
      content.includes('Saved') ||
      content.includes('No changes') ||
      content.includes('Save failed')
    ) {
      const btn = tooltip.querySelector('button');
      if (btn) return btn;
    }
  }
  throw new Error('Save button not found');
}

// =============================================================================
// RENDERING
// =============================================================================

describe('AgentEditorHeader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Rendering', () => {
    it('shows agent name', () => {
      renderHeader();
      expect(screen.getByText('booking_agent')).toBeInTheDocument();
    });

    it('shows mode badge with accent styling for Reasoning mode', () => {
      renderHeader({ mode: 'Reasoning' });
      const badge = screen.getByText('Reasoning');
      expect(badge).toBeInTheDocument();
      expect(badge.className).toContain('bg-accent-subtle');
      expect(badge.className).toContain('text-accent');
    });

    it('shows mode badge with purple styling for Mixed mode', () => {
      renderHeader({ mode: 'Mixed' });
      const badge = screen.getByText('Mixed');
      expect(badge).toBeInTheDocument();
      expect(badge.className).toContain('bg-purple-subtle');
      expect(badge.className).toContain('text-purple');
    });

    it('shows mode badge with info styling for Flow mode', () => {
      renderHeader({ mode: 'Flow' });
      const badge = screen.getByText('Flow');
      expect(badge).toBeInTheDocument();
      expect(badge.className).toContain('bg-info-subtle');
      expect(badge.className).toContain('text-info');
    });

    it('shows model name when provided', () => {
      renderHeader({ model: 'gpt-4o' });
      expect(screen.getByText('gpt-4o')).toBeInTheDocument();
    });

    it('does not render model element when model is not provided', () => {
      const { container } = renderHeader({ model: undefined });
      // The font-mono class is unique to the model span
      expect(container.querySelector('.font-mono')).toBeNull();
    });

    it('shows "Unsaved" badge when isDirty is true', () => {
      renderHeader({ isDirty: true });
      expect(screen.getByText('Unsaved')).toBeInTheDocument();
    });

    it('hides "Unsaved" badge when isDirty is false', () => {
      renderHeader({ isDirty: false });
      expect(screen.queryByText('Unsaved')).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // SAVE BUTTON STATES
  // ===========================================================================

  describe('Save button states', () => {
    it('is disabled when !isDirty and !isSaving', () => {
      renderHeader({ isDirty: false, isSaving: false });
      const saveButton = getSaveButton();
      expect(saveButton).toBeDisabled();
    });

    it('is enabled when isDirty and !isSaving', () => {
      renderHeader({ isDirty: true, isSaving: false });
      const saveButton = getSaveButton();
      expect(saveButton).not.toBeDisabled();
    });

    it('shows Loader2 spinner icon when isSaving', () => {
      renderHeader({ isDirty: true, isSaving: true });
      expect(document.querySelector('.lucide-loader2')).toBeInTheDocument();
    });

    it('shows "Saving..." text when isSaving', () => {
      renderHeader({ isDirty: true, isSaving: true });
      const saveButton = getSaveButton();
      // The component uses the unicode ellipsis character
      expect(saveButton.textContent).toContain('Saving\u2026');
    });

    it('is disabled during saving (isDirty=true, isSaving=true)', () => {
      renderHeader({ isDirty: true, isSaving: true });
      const savingButton = getSaveButton();
      expect(savingButton).toBeDisabled();
    });

    it('shows "Saved" text and Check icon when isSaved=true', () => {
      renderHeader({ isDirty: false, isSaving: false, isSaved: true });
      const saveButton = getSaveButton();
      expect(saveButton.textContent).toContain('Saved');
      expect(document.querySelector('.lucide-check')).toBeInTheDocument();
    });

    it('shows green (success) styling when isSaved=true', () => {
      renderHeader({ isDirty: false, isSaving: false, isSaved: true });
      const savedButton = getSaveButton();
      expect(savedButton.className).toContain('bg-success');
      expect(savedButton.className).toContain('text-success-foreground');
    });

    it('shows "Error" text and red styling when saveError is set', () => {
      renderHeader({ isDirty: false, isSaving: false, saveError: 'Network timeout' });
      const errorButton = getSaveButton();
      expect(errorButton.textContent).toContain('Error');
      expect(errorButton.className).toContain('bg-error');
      expect(errorButton.className).toContain('text-error-foreground');
    });

    it('shows save error message in tooltip when saveError is set', () => {
      renderHeader({ isDirty: false, isSaving: false, saveError: 'Network timeout' });
      const errorButton = getSaveButton();
      const tooltipWrapper = errorButton.closest('[data-tooltip-content]');
      expect(tooltipWrapper).toHaveAttribute(
        'data-tooltip-content',
        'Save failed: Network timeout',
      );
    });

    it('shows text-only save action when not saving and not saved', () => {
      renderHeader({ isDirty: true, isSaving: false, isSaved: false });
      expect(getSaveButton().textContent).toContain('Save changes');
      expect(document.querySelector('.lucide-save')).not.toBeInTheDocument();
    });

    it('shows cursor-not-allowed styling when disabled and no error/saved state', () => {
      renderHeader({ isDirty: false, isSaving: false });
      const saveButton = getSaveButton();
      expect(saveButton.className).toContain('cursor-not-allowed');
    });

    it('shows accent styling when isDirty and no error', () => {
      renderHeader({ isDirty: true, isSaving: false });
      const saveButton = getSaveButton();
      expect(saveButton.className).toContain('bg-accent');
      expect(saveButton.className).toContain('text-accent-foreground');
    });
  });

  // ===========================================================================
  // DISCARD BUTTON
  // ===========================================================================

  describe('Discard button', () => {
    it('is visible when isDirty', () => {
      renderHeader({ isDirty: true });
      expect(screen.getByText('Discard')).toBeInTheDocument();
    });

    it('is hidden when not dirty', () => {
      renderHeader({ isDirty: false });
      expect(screen.queryByText('Discard')).not.toBeInTheDocument();
    });

    it('calls onDiscard when clicked', () => {
      const onDiscard = vi.fn();
      renderHeader({ isDirty: true, onDiscard });
      fireEvent.click(screen.getByText('Discard'));
      expect(onDiscard).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // ACTION BUTTONS
  // ===========================================================================

  describe('Action buttons', () => {
    it('renders Chat button when onChat is provided', () => {
      renderHeader({ onChat: vi.fn() });
      expect(screen.getByText('Chat with Agent')).toBeInTheDocument();
    });

    it('does not render Chat button when onChat is not provided', () => {
      renderHeader();
      expect(screen.queryByText('Chat with Agent')).not.toBeInTheDocument();
    });

    it('calls onChat when Chat button is clicked', () => {
      const onChat = vi.fn();
      renderHeader({ onChat });
      fireEvent.click(screen.getByText('Chat with Agent'));
      expect(onChat).toHaveBeenCalledTimes(1);
    });

    it('does not render legacy Arch guidance toggle when callback is provided', () => {
      renderHeader({ archGuidanceEnabled: true, onToggleArchGuidance: vi.fn() });
      expect(screen.queryByLabelText('Disable Arch guidance')).not.toBeInTheDocument();
    });

    it('does not render legacy disabled Arch guidance state', () => {
      renderHeader({ archGuidanceEnabled: false, onToggleArchGuidance: vi.fn() });
      expect(screen.queryByLabelText('Enable Arch guidance')).not.toBeInTheDocument();
    });

    it('does not render Arch guidance toggle without callback', () => {
      renderHeader({ archGuidanceEnabled: true });
      expect(screen.queryByLabelText('Disable Arch guidance')).not.toBeInTheDocument();
    });

    it('does not call onToggleArchGuidance from the compact header', () => {
      const onToggleArchGuidance = vi.fn();
      renderHeader({ archGuidanceEnabled: true, onToggleArchGuidance });
      expect(onToggleArchGuidance).not.toHaveBeenCalled();
    });

    it('renders Versions/History button when onVersions is provided', () => {
      renderHeader({ onVersions: vi.fn() });
      // History icon rendered via lucide (real SVG with class)
      expect(document.querySelector('.lucide-history')).toBeInTheDocument();
      // The button contains the text "History" as visible label
      const historyButtons = screen.getAllByText('History');
      expect(historyButtons.length).toBeGreaterThanOrEqual(1);
    });

    it('does not render Versions button when onVersions is not provided', () => {
      renderHeader();
      expect(document.querySelector('.lucide-history')).not.toBeInTheDocument();
    });

    it('calls onVersions when Versions button is clicked', () => {
      const onVersions = vi.fn();
      renderHeader({ onVersions });
      // Click the button that contains the History icon
      const historyIcon = document.querySelector('.lucide-history')!;
      fireEvent.click(historyIcon.closest('button')!);
      expect(onVersions).toHaveBeenCalledTimes(1);
    });

    it('renders ABL button when onDslOverlay is provided', () => {
      renderHeader({ onDslOverlay: vi.fn() });
      expect(screen.getByText('ABL')).toBeInTheDocument();
    });

    it('does not render ABL button when onDslOverlay is not provided', () => {
      renderHeader();
      expect(screen.queryByText('ABL')).not.toBeInTheDocument();
    });

    it('calls onDslOverlay when ABL button is clicked', () => {
      const onDslOverlay = vi.fn();
      renderHeader({ onDslOverlay });
      fireEvent.click(screen.getByText('ABL'));
      expect(onDslOverlay).toHaveBeenCalledTimes(1);
    });

    it('renders Delete button when onDelete is provided', () => {
      renderHeader({ onDelete: vi.fn() });
      expect(screen.getByLabelText('Delete agent')).toBeInTheDocument();
    });

    it('calls onDelete when Delete button is clicked', () => {
      const onDelete = vi.fn();
      renderHeader({ onDelete });
      fireEvent.click(screen.getByLabelText('Delete agent'));
      expect(onDelete).toHaveBeenCalledTimes(1);
    });

    it('shows separator when at least one action button exists', () => {
      const { container } = renderHeader({ onChat: vi.fn() });
      const separator = container.querySelector('.w-px.h-4.bg-border');
      expect(separator).toBeInTheDocument();
    });

    it('does not show separator when no action buttons exist', () => {
      const { container } = renderHeader();
      const separator = container.querySelector('.w-px.h-4.bg-border');
      expect(separator).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // NAVIGATION
  // ===========================================================================

  describe('Navigation', () => {
    it('does not render legacy Back button when onBack is provided', () => {
      renderHeader({ onBack: vi.fn() });
      expect(screen.queryByLabelText('Back')).not.toBeInTheDocument();
    });

    it('does not render Back button when onBack is not provided', () => {
      renderHeader();
      expect(screen.queryByLabelText('Back')).not.toBeInTheDocument();
    });

    it('does not call onBack from the compact header', () => {
      const onBack = vi.fn();
      renderHeader({ onBack });
      expect(onBack).not.toHaveBeenCalled();
    });

    it('renders Close button when onClose is provided', () => {
      renderHeader({ onClose: vi.fn() });
      expect(screen.getByLabelText('Close')).toBeInTheDocument();
    });

    it('does not render Close button when onClose is not provided', () => {
      renderHeader();
      expect(screen.queryByLabelText('Close')).not.toBeInTheDocument();
    });

    it('calls onClose when Close button is clicked', () => {
      const onClose = vi.fn();
      renderHeader({ onClose });
      fireEvent.click(screen.getByLabelText('Close'));
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // CLICK HANDLERS
  // ===========================================================================

  describe('Click handlers', () => {
    it('calls onSave when save button is clicked', () => {
      const onSave = vi.fn();
      renderHeader({ isDirty: true, onSave });
      fireEvent.click(getSaveButton());
      expect(onSave).toHaveBeenCalledTimes(1);
    });

    it('does not call onSave when button is disabled', () => {
      const onSave = vi.fn();
      renderHeader({ isDirty: false, onSave });
      fireEvent.click(getSaveButton());
      expect(onSave).not.toHaveBeenCalled();
    });

    it('all callbacks are called correctly in a full configuration', () => {
      const onSave = vi.fn();
      const onDiscard = vi.fn();
      const onClose = vi.fn();
      const onBack = vi.fn();
      const onChat = vi.fn();
      const onToggleArchGuidance = vi.fn();
      const onVersions = vi.fn();
      const onDslOverlay = vi.fn();
      const onDelete = vi.fn();

      renderHeader({
        isDirty: true,
        onSave,
        onDiscard,
        onClose,
        onBack,
        onChat,
        archGuidanceEnabled: true,
        onToggleArchGuidance,
        onVersions,
        onDslOverlay,
        onDelete,
      });

      fireEvent.click(getSaveButton());
      fireEvent.click(screen.getByText('Discard'));
      fireEvent.click(screen.getByLabelText('Close'));
      fireEvent.click(screen.getByText('Chat with Agent'));
      fireEvent.click(document.querySelector('.lucide-history')!.closest('button')!);
      fireEvent.click(screen.getByText('ABL'));
      fireEvent.click(screen.getByLabelText('Delete agent'));

      expect(onSave).toHaveBeenCalledTimes(1);
      expect(onDiscard).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onBack).not.toHaveBeenCalled();
      expect(onChat).toHaveBeenCalledTimes(1);
      expect(onToggleArchGuidance).not.toHaveBeenCalled();
      expect(onVersions).toHaveBeenCalledTimes(1);
      expect(onDslOverlay).toHaveBeenCalledTimes(1);
      expect(onDelete).toHaveBeenCalledTimes(1);
    });
  });
});
