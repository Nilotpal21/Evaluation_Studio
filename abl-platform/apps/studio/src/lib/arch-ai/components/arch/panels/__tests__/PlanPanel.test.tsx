import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlanPanel } from '../PlanPanel';
import type { PendingPlan } from '@agent-platform/arch-ai/types';

const mocks = vi.hoisted(() => ({
  sendProposal: vi.fn<() => Promise<void>>(),
}));

vi.mock('@/lib/arch-ai/ui/hook', () => ({
  useArchChatController: () => ({
    sendProposal: mocks.sendProposal,
  }),
}));

const plan: PendingPlan = {
  id: 'plan-1',
  projectId: 'project-1',
  status: 'proposed',
  title: 'Fix delegate flow handling',
  goal: 'Make FlowStep delegate to the right specialist without breaking dependents.',
  summary: 'Updates delegation and validates downstream references.',
  architecturalPattern: 'Supervisor delegates to specialist agents.',
  evidence: ['Read FlowStep, Supervisor, and BetterWorker.'],
  affectedAgents: ['FlowStep', 'Supervisor', 'BetterWorker'],
  sectionsToChange: [
    {
      agentName: 'FlowStep',
      construct: 'HANDOFF',
      operation: 'modify',
      reason: 'Delegate path currently points at the old worker.',
    },
  ],
  dependentsAnalysis: {
    summary: 'Supervisor and BetterWorker depend on this path.',
    referencesFound: [
      {
        kind: 'agent',
        sourceAgent: 'FlowStep',
        targetAgent: 'BetterWorker',
        detail: 'Delegate target',
      },
    ],
  },
  alternativesConsidered: [
    {
      option: 'Edit only FlowStep',
      rejectedBecause: 'It would miss the supervisor reference.',
    },
  ],
  citations: [
    {
      sourceType: 'construct_spec',
      reference: 'construct_spec:HANDOFF',
      relevance: 'Defines the supported delegation shape.',
    },
  ],
  plannedMutations: [
    {
      sourceTool: 'propose_modification',
      sourceAction: 'modify',
      targetKind: 'agent_dsl',
      operation: 'modify',
      agentName: 'FlowStep',
      rationale: 'Update the delegate target.',
    },
  ],
  risks: [
    {
      severity: 'medium',
      description: 'A stale downstream reference could remain.',
      mitigation: 'Run reference analysis before applying.',
    },
  ],
  questionsForUser: ['Should BetterWorker own returns escalation?'],
  validationNotes: ['Knowledge Spine check completed.'],
  createdAt: '2026-05-11T00:00:00.000Z',
  updatedAt: '2026-05-11T00:00:00.000Z',
};

describe('PlanPanel', () => {
  afterEach(() => {
    vi.clearAllMocks();
    mocks.sendProposal.mockResolvedValue(undefined);
  });

  it('renders an explain-first plan with stable review controls', () => {
    render(<PlanPanel data={plan} />);

    expect(screen.getByTestId('arch-plan-panel')).toBeTruthy();
    expect(screen.getByTestId('arch-plan-status')).toHaveTextContent('proposed');
    expect(screen.getByText('Fix delegate flow handling')).toBeTruthy();
    expect(screen.getByText('Supervisor and BetterWorker depend on this path.')).toBeTruthy();
    expect(screen.getByTestId('arch-plan-approve')).toBeEnabled();
    expect(screen.getByTestId('arch-plan-refine')).toBeEnabled();
    expect(screen.getByTestId('arch-plan-cancel')).toBeEnabled();
  });

  it('sends approve, cancel, and refinement responses through the proposal contract', async () => {
    const { rerender } = render(<PlanPanel data={plan} />);

    fireEvent.click(screen.getByTestId('arch-plan-approve'));

    await waitFor(() => {
      expect(mocks.sendProposal).toHaveBeenCalledWith('accept', undefined);
    });

    vi.clearAllMocks();
    rerender(<PlanPanel data={plan} />);
    fireEvent.click(screen.getByTestId('arch-plan-cancel'));

    await waitFor(() => {
      expect(mocks.sendProposal).toHaveBeenCalledWith('reject', undefined);
    });

    vi.clearAllMocks();
    rerender(<PlanPanel data={plan} />);
    fireEvent.click(screen.getByTestId('arch-plan-refine'));
    fireEvent.change(screen.getByPlaceholderText('What should Arch change in this plan?'), {
      target: { value: 'Add a citation for the dependent supervisor reference.' },
    });
    fireEvent.click(screen.getByTestId('arch-plan-send-refinement'));

    await waitFor(() => {
      expect(mocks.sendProposal).toHaveBeenCalledWith(
        'modify',
        'Add a citation for the dependent supervisor reference.',
      );
    });
  });
});
