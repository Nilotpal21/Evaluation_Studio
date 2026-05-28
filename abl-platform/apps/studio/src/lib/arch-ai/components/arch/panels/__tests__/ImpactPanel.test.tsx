import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImpactPanel } from '../ImpactPanel';
import type { ModificationProposal } from '@/lib/arch-ai/types/arch';

const mocks = vi.hoisted(() => ({
  markDiffResolutionInFlight: vi.fn(),
  sendProposal: vi.fn<() => Promise<void>>(),
  updateDiffTabStatus: vi.fn(),
}));

vi.mock('@/lib/arch-ai/ui/hook', () => ({
  useArchChatController: () => ({
    sendProposal: mocks.sendProposal,
  }),
}));

vi.mock('@/lib/arch-ai/ui/proposal-artifacts', () => ({
  markDiffResolutionInFlight: mocks.markDiffResolutionInFlight,
  updateDiffTabStatus: mocks.updateDiffTabStatus,
}));

const proposal: ModificationProposal = {
  agentName: 'FlowStep',
  reviewStatus: 'pending',
  change: 'Improve delegate handling',
  changes: [
    {
      construct: 'DELEGATE',
      before: 'DELEGATE: OldWorker',
      after: 'DELEGATE: BetterWorker',
      rationale: 'Route delegation through the specialist worker.',
    },
  ],
  validation: {
    valid: true,
    errors: [],
    warnings: [],
    repairAttempts: 1,
  },
  impact: {
    runtimeReady: true,
    summary: 'Updates the delegation path and dependent references.',
    changedAgent: 'FlowStep',
    declaredAgentName: 'FlowStep',
    impactedAgents: ['Supervisor', 'BetterWorker'],
    topology: {
      addedEdges: [{ from: 'FlowStep', to: 'BetterWorker', type: 'delegate' }],
      removedEdges: [{ from: 'FlowStep', to: 'OldWorker', type: 'delegate' }],
    },
    tools: {
      added: ['handoff_tracker'],
      removed: [],
      unresolved: [],
    },
    nextActions: ['Approve after reviewing topology impact.'],
  },
};

describe('ImpactPanel', () => {
  afterEach(() => {
    vi.clearAllMocks();
    mocks.sendProposal.mockResolvedValue(undefined);
  });

  it('summarizes proposal impact before showing the diff', () => {
    const onViewDiff = vi.fn();

    render(<ImpactPanel proposal={proposal} onViewDiff={onViewDiff} />);

    expect(screen.getByTestId('arch-impact-panel')).toBeTruthy();
    expect(screen.getByTestId('arch-impact-runtime-status')).toHaveTextContent('Ready');
    expect(screen.getByText('Updates the delegation path and dependent references.')).toBeTruthy();
    expect(screen.getByText('Supervisor')).toBeTruthy();
    expect(screen.getByText('BetterWorker')).toBeTruthy();
    expect(screen.getByText('handoff_tracker')).toBeTruthy();

    fireEvent.click(screen.getByTestId('arch-impact-view-diff'));
    expect(onViewDiff).toHaveBeenCalledTimes(1);
  });

  it('marks a pending proposal in flight before approving it', async () => {
    mocks.sendProposal.mockResolvedValue(undefined);

    render(<ImpactPanel proposal={proposal} onViewDiff={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    await waitFor(() => {
      expect(mocks.markDiffResolutionInFlight).toHaveBeenCalledTimes(1);
      expect(mocks.sendProposal).toHaveBeenCalledWith('accept', undefined);
    });
  });

  it('sends cancel and revision actions from the explain-first controls', async () => {
    mocks.sendProposal.mockResolvedValue(undefined);

    const { rerender } = render(<ImpactPanel proposal={proposal} onViewDiff={vi.fn()} />);

    fireEvent.click(screen.getByTestId('arch-impact-cancel'));

    await waitFor(() => {
      expect(mocks.sendProposal).toHaveBeenCalledWith('reject', undefined);
    });

    vi.clearAllMocks();
    rerender(<ImpactPanel proposal={proposal} onViewDiff={vi.fn()} />);

    fireEvent.click(screen.getByTestId('arch-impact-revise'));
    fireEvent.change(screen.getByPlaceholderText('What should Arch change before applying this?'), {
      target: { value: 'Check downstream delegate references first.' },
    });
    fireEvent.click(screen.getByTestId('arch-impact-send-revision'));

    await waitFor(() => {
      expect(mocks.sendProposal).toHaveBeenCalledWith(
        'modify',
        'Check downstream delegate references first.',
      );
    });
  });
});
