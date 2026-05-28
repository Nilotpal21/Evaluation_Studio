import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { apiFetchMock, projectStoreState, toastSuccessMock, toastErrorMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  projectStoreState: {
    currentProject: {
      id: 'proj-1',
      name: 'Project One',
    },
  },
  toastSuccessMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock('@/store/project-store', () => ({
  useProjectStore: <T,>(selector: (state: typeof projectStoreState) => T): T =>
    selector(projectStoreState),
}));

vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

import { CreateScenarioDialog } from '@/components/evals/dialogs/CreateScenarioDialog';

describe('CreateScenarioDialog', () => {
  const editScenario = {
    id: 'scenario-1',
    name: 'Escalated billing dispute',
    description: 'Customer disputes a charge and requests a supervisor.',
    category: 'billing',
    difficulty: 'hard',
    entryAgent: 'triage_agent',
    initialMessage: 'I need help with an unexpected charge.',
    expectedOutcome: 'Issue is acknowledged and escalated with the right context.',
    maxTurns: 12,
    tags: ['billing', 'escalation'],
    agentPath: ['triage_agent', 'billing_agent'],
    expectedMilestones: ['Problem identified', 'Escalation triggered'],
    version: 3,
    createdAt: '2026-04-18T00:00:00.000Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });
  });

  it('hydrates lossless scenario fields in edit mode', () => {
    render(
      <CreateScenarioDialog
        open
        onClose={vi.fn()}
        onCreated={vi.fn()}
        editScenario={editScenario}
      />,
    );

    expect(screen.getByLabelText('scenarios.dialog.initial_message_label')).toHaveValue(
      editScenario.initialMessage,
    );
    expect(screen.getByLabelText('scenarios.dialog.expected_outcome_label')).toHaveValue(
      editScenario.expectedOutcome,
    );
    expect(screen.getByLabelText('scenarios.dialog.agent_path_label')).toHaveValue(
      editScenario.agentPath.join(', '),
    );
    expect(screen.getByLabelText('scenarios.dialog.milestones_label')).toHaveValue(
      editScenario.expectedMilestones.join(', '),
    );
  });

  it('preserves hydrated fields in the update payload', async () => {
    render(
      <CreateScenarioDialog
        open
        onClose={vi.fn()}
        onCreated={vi.fn()}
        editScenario={editScenario}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));

    const [, requestInit] = apiFetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(requestInit.body));

    expect(body.initialMessage).toBe(editScenario.initialMessage);
    expect(body.expectedOutcome).toBe(editScenario.expectedOutcome);
    expect(body.agentPath).toEqual(editScenario.agentPath);
    expect(body.expectedMilestones).toEqual(editScenario.expectedMilestones);
  });
});
