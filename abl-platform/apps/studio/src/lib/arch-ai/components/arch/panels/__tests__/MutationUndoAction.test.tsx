import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MutationUndoAction } from '../MutationUndoAction';
import type { ModificationProposal } from '@/lib/arch-ai/types/arch';
import {
  __resetAppliedMutationHistoryForTests,
  recordAppliedMutationForUndo,
} from '@/lib/arch-ai/ui/proposal-artifacts';
import { useArchAIStore } from '@/lib/arch-ai/store/arch-ai-store';

vi.mock('@/lib/api-client', () => ({
  authHeaders: () => ({ Authorization: 'Bearer test-token' }),
}));

const baseProposal: ModificationProposal = {
  agentName: 'FlowStep',
  reviewStatus: 'applied',
  change: 'Update delegate handling',
  currentCode: 'AGENT: FlowStep\nGOAL: old',
  proposedCode: 'AGENT: FlowStep\nGOAL: new',
  changes: [
    {
      construct: 'FULL',
      before: 'AGENT: FlowStep\nGOAL: old',
      after: 'AGENT: FlowStep\nGOAL: new',
      rationale: 'Update delegate handling',
    },
  ],
};

describe('MutationUndoAction', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-05-11T10:00:00.000Z'));
    __resetAppliedMutationHistoryForTests();
    useArchAIStore.setState({ lastAgentEditTimestamp: null });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    __resetAppliedMutationHistoryForTests();
  });

  it('writes the previous DSL through the agent DSL API', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true })));
    vi.stubGlobal('fetch', fetchMock);

    render(<MutationUndoAction projectId="proj-1" proposal={baseProposal} />);

    fireEvent.click(screen.getByTestId('arch-undo-button'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/proj-1/agents/FlowStep/dsl', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ dslContent: 'AGENT: FlowStep\nGOAL: old' }),
    });
    expect(screen.getByRole('button', { name: /undone/i })).toBeTruthy();
    expect(useArchAIStore.getState().lastAgentEditTimestamp).toBeTypeOf('number');
  });

  it('blocks undo when a later local mutation touched the same agent', () => {
    recordAppliedMutationForUndo(baseProposal, 'first');
    vi.setSystemTime(new Date('2026-05-11T10:01:00.000Z'));
    recordAppliedMutationForUndo(
      {
        ...baseProposal,
        currentCode: 'AGENT: FlowStep\nGOAL: new',
        proposedCode: 'AGENT: FlowStep\nGOAL: newer',
      },
      'second',
    );

    render(<MutationUndoAction projectId="proj-1" proposal={baseProposal} />);

    expect(screen.getByTestId('arch-undo-button')).toBeDisabled();
    expect(screen.getByText('A later edit touched this agent.')).toBeTruthy();
  });
});
