/**
 * DefinitionEditor Component Tests
 *
 * Tests for the definition (raw DSL) section editor which wraps ABLEditor
 * and syncs editor store changes back to the AgentEditorStore via onChange.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// =============================================================================
// MOCKS
// =============================================================================

// Mock ABLEditor as a simple div with data-testid
vi.mock('../../components/abl/ABLEditor', () => ({
  __esModule: true,
  default: ({ className }: { className?: string }) =>
    React.createElement('div', { 'data-testid': 'abl-editor', className }, 'ABLEditor'),
  ABLEditor: ({ className }: { className?: string }) =>
    React.createElement('div', { 'data-testid': 'abl-editor', className }, 'ABLEditor'),
}));

// Mock useEditorStore — allow tests to control dslContent and isDirty
let mockEditorStoreState = {
  dslContent: 'AGENT test_agent\n  GOAL "Test goal"',
  isDirty: false,
};

vi.mock('../../store/editor-store', () => ({
  useEditorStore: vi.fn((selector: (s: typeof mockEditorStoreState) => unknown) => {
    return selector(mockEditorStoreState);
  }),
}));

// Mock SectionHeader component
vi.mock('../../components/agent-editor/sections/SectionHeader', () => ({
  SectionHeader: ({ onArchClick }: { onArchClick?: () => void }) =>
    onArchClick
      ? React.createElement(
          'button',
          { 'data-testid': 'section-header-arch', onClick: onArchClick },
          'AI Assist',
        )
      : null,
}));

// Static import — mocks are hoisted above
import { DefinitionEditor } from '../../components/agent-editor/sections/DefinitionEditor';

// =============================================================================
// HELPERS
// =============================================================================

function renderDefinitionEditor(
  overrides: {
    onChange?: (data: string) => void;
    onArchClick?: () => void;
  } = {},
) {
  const props = {
    data: 'AGENT test_agent\n  GOAL "Test goal"',
    onChange: overrides.onChange ?? vi.fn(),
    onArchClick: overrides.onArchClick,
  };
  return render(<DefinitionEditor {...props} />);
}

// =============================================================================
// TESTS
// =============================================================================

describe('DefinitionEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEditorStoreState = {
      dslContent: 'AGENT test_agent\n  GOAL "Test goal"',
      isDirty: false,
    };
  });

  it('renders ABLEditor component', () => {
    renderDefinitionEditor();
    expect(screen.getByTestId('abl-editor')).toBeInTheDocument();
  });

  it('does NOT call onChange on initial mount (mountedRef prevents it)', () => {
    const onChange = vi.fn();
    renderDefinitionEditor({ onChange });

    // Even though editorIsDirty is false, the effect runs on mount
    // but mountedRef prevents onChange from being called
    expect(onChange).not.toHaveBeenCalled();
  });

  it('calls onChange when editorIsDirty becomes true and content changes', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <DefinitionEditor data='AGENT test_agent\n  GOAL "Test goal"' onChange={onChange} />,
    );

    // First render — mountedRef becomes true, no onChange called
    expect(onChange).not.toHaveBeenCalled();

    // Simulate editor store update: isDirty=true and new content
    mockEditorStoreState = {
      dslContent: 'AGENT updated_agent\n  GOAL "Updated goal"',
      isDirty: true,
    };

    // Re-render to trigger the useEffect with updated store values
    rerender(<DefinitionEditor data='AGENT test_agent\n  GOAL "Test goal"' onChange={onChange} />);

    // Now onChange should have been called with the new content
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('AGENT updated_agent\n  GOAL "Updated goal"');
  });

  it('does not call onChange when editor is not dirty', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <DefinitionEditor data='AGENT test_agent\n  GOAL "Test goal"' onChange={onChange} />,
    );

    // First render — mount
    expect(onChange).not.toHaveBeenCalled();

    // Update content but keep isDirty=false
    mockEditorStoreState = {
      dslContent: 'AGENT different_agent\n  GOAL "Different goal"',
      isDirty: false,
    };

    rerender(<DefinitionEditor data='AGENT test_agent\n  GOAL "Test goal"' onChange={onChange} />);

    // onChange should NOT be called because isDirty is false
    expect(onChange).not.toHaveBeenCalled();
  });

  it('renders SectionHeader with onArchClick prop', () => {
    const onArchClick = vi.fn();
    renderDefinitionEditor({ onArchClick });

    const archButton = screen.getByTestId('section-header-arch');
    expect(archButton).toBeInTheDocument();
    archButton.click();
    expect(onArchClick).toHaveBeenCalledTimes(1);
  });

  it('does not render SectionHeader when onArchClick is not provided', () => {
    renderDefinitionEditor();
    expect(screen.queryByTestId('section-header-arch')).not.toBeInTheDocument();
  });
});
