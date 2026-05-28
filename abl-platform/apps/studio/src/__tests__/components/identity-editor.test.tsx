import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  IdentityEditor,
  buildPromptRefPayload,
  mergePromptRefPresentation,
} from '../../components/agent-editor/sections/IdentityEditor';
import type { IdentitySectionData } from '../../components/agent-editor/types';

const mockApiFetch = vi.fn();
const mockHandleResponse = vi.fn();
const mockToastError = vi.fn();
const mockAgentEditorState = {
  projectId: null as string | null,
  agentName: null as string | null,
};

vi.mock('../../lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  handleResponse: (...args: unknown[]) => mockHandleResponse(...args),
}));

vi.mock('../../components/agent-editor/hooks/useAgentEditorStore', () => ({
  useAgentEditorStore: (selector: (state: typeof mockAgentEditorState) => unknown) =>
    selector(mockAgentEditorState),
}));

vi.mock('../../components/prompt-library/PromptPickerModal', () => ({
  PromptPickerModal: ({
    onConfirm,
  }: {
    onConfirm: (selection: {
      promptId: string;
      versionId: string;
      promptName: string;
      versionNumber: number;
    }) => void;
  }) => (
    <button
      type="button"
      onClick={() =>
        onConfirm({
          promptId: 'prompt-1',
          versionId: 'version-1',
          promptName: 'Support Prompt',
          versionNumber: 7,
        })
      }
    >
      Confirm prompt selection
    </button>
  ),
}));

vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

const mockData: IdentitySectionData = {
  mode: 'reasoning',
  goal: 'Help users book hotels',
  persona: 'You are a friendly hotel booking assistant.',
  limitations: ['Cannot process payments', 'No refunds'],
  model: 'claude-sonnet-4-6',
  temperature: 0.7,
  maxTokens: 4096,
};

describe('IdentityEditor', () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockHandleResponse.mockReset();
    mockToastError.mockReset();
    mockAgentEditorState.projectId = null;
    mockAgentEditorState.agentName = null;
  });

  it('prefills the limitation input when editing a chip', () => {
    render(<IdentityEditor data={mockData} onChange={() => {}} />);

    fireEvent.click(screen.getByLabelText('Edit limitation: No refunds'));

    expect(screen.getByPlaceholderText('Add a limitation...')).toHaveValue('No refunds');
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('calls onChange when a limitation is edited and saved', () => {
    const onChange = vi.fn();
    render(<IdentityEditor data={mockData} onChange={onChange} />);

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
    render(<IdentityEditor data={mockData} onChange={onChange} />);

    fireEvent.click(screen.getByLabelText('Edit limitation: No refunds'));
    fireEvent.change(screen.getByPlaceholderText('Add a limitation...'), {
      target: { value: 'Updated refund policy' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByPlaceholderText('Add a limitation...')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('preserves prompt companion metadata when re-saving the same prompt selection', () => {
    const payload = buildPromptRefPayload(
      {
        promptId: 'prompt-1',
        versionId: 'version-1',
        promptName: 'Support Prompt',
        versionNumber: 7,
      },
      {
        promptId: 'prompt-1',
        versionId: 'version-1',
        resolvedHash: 'resolved-hash-1',
        promptName: 'Support Prompt',
        versionNumber: 7,
      },
    );

    expect(payload).toEqual({
      promptId: 'prompt-1',
      versionId: 'version-1',
      resolvedHash: 'resolved-hash-1',
    });
  });

  it('restores picker presentation while keeping persisted companion metadata', () => {
    const merged = mergePromptRefPresentation(
      {
        promptId: 'prompt-1',
        versionId: 'version-1',
        resolvedHash: 'resolved-hash-1',
      },
      {
        promptId: 'prompt-1',
        versionId: 'version-1',
        promptName: 'Support Prompt',
        versionNumber: 7,
      },
      null,
    );

    expect(merged).toEqual({
      promptId: 'prompt-1',
      versionId: 'version-1',
      resolvedHash: 'resolved-hash-1',
      promptName: 'Support Prompt',
      versionNumber: 7,
    });
  });
});
