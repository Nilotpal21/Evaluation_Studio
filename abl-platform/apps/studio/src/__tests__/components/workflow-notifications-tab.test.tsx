import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkflowDetail } from '../../api/workflows';

const mockCreateWorkflowNotificationRule = vi.fn();
const mockUpdateWorkflowNotificationRule = vi.fn();
const mockDeleteWorkflowNotificationRule = vi.fn();
const mockRefresh = vi.fn();

vi.mock('../../store/navigation-store', () => ({
  useNavigationStore: vi.fn((selector?: (state: Record<string, unknown>) => unknown) => {
    const state = { projectId: 'proj-1' };
    return selector ? selector(state) : state;
  }),
}));

vi.mock('../../api/workflows', async () => {
  const actual = await vi.importActual<typeof import('../../api/workflows')>('../../api/workflows');
  return {
    ...actual,
    createWorkflowNotificationRule: (...args: unknown[]) =>
      mockCreateWorkflowNotificationRule(...args),
    updateWorkflowNotificationRule: (...args: unknown[]) =>
      mockUpdateWorkflowNotificationRule(...args),
    deleteWorkflowNotificationRule: (...args: unknown[]) =>
      mockDeleteWorkflowNotificationRule(...args),
  };
});

import { WorkflowNotificationsTab } from '../../components/workflows/tabs/WorkflowNotificationsTab';

function getButtonByText(label: string) {
  const button = screen.getByText(label).closest('button');
  expect(button).not.toBeNull();
  return button as HTMLButtonElement;
}

function makeWorkflow(overrides: Partial<WorkflowDetail> = {}): WorkflowDetail {
  return {
    id: 'wf-1',
    name: 'Daily Ops',
    description: 'Workflow description',
    status: 'active',
    stepCount: 0,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-02T00:00:00.000Z',
    steps: [],
    triggers: [],
    notificationRules: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateWorkflowNotificationRule.mockResolvedValue({ success: true });
  mockUpdateWorkflowNotificationRule.mockResolvedValue({ success: true });
  mockDeleteWorkflowNotificationRule.mockResolvedValue({ success: true });
});

describe('WorkflowNotificationsTab', () => {
  it('creates a notification rule from the empty state', async () => {
    const user = userEvent.setup();

    render(<WorkflowNotificationsTab workflow={makeWorkflow()} onRefresh={mockRefresh} />);

    await user.click(getButtonByText('Add Rule'));
    await user.type(screen.getByLabelText('Rule name'), 'Completion email');
    await user.type(screen.getByLabelText('Target'), 'alerts@example.com');
    await user.click(getButtonByText('Create Rule'));

    await waitFor(() => {
      expect(mockCreateWorkflowNotificationRule).toHaveBeenCalledWith('proj-1', 'wf-1', {
        name: 'Completion email',
        events: ['workflow.completed'],
        enabled: true,
        channel: {
          type: 'email',
          connectionId: '',
          target: 'alerts@example.com',
        },
      });
    });
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('edits an existing notification rule', async () => {
    const user = userEvent.setup();

    render(
      <WorkflowNotificationsTab
        workflow={makeWorkflow({
          notificationRules: [
            {
              id: 'rule-1',
              name: 'Ops alert',
              events: ['step.failed'],
              channel: {
                type: 'slack',
                connectionId: '',
                target: '#ops-alerts',
              },
              enabled: true,
            },
          ],
        })}
        onRefresh={mockRefresh}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Edit notification rule' }));

    const nameInput = screen.getByLabelText('Rule name') as HTMLInputElement;
    const targetInput = screen.getByLabelText('Target') as HTMLInputElement;

    expect(nameInput.value).toBe('Ops alert');
    expect(targetInput.value).toBe('#ops-alerts');

    await user.clear(nameInput);
    await user.type(nameInput, 'Critical step failures');
    await user.clear(targetInput);
    await user.type(targetInput, '#critical-alerts');
    await user.click(getButtonByText('Save Changes'));

    await waitFor(() => {
      expect(mockUpdateWorkflowNotificationRule).toHaveBeenCalledWith('proj-1', 'wf-1', 'rule-1', {
        name: 'Critical step failures',
        events: ['step.failed'],
        enabled: true,
        channel: {
          type: 'slack',
          connectionId: '',
          target: '#critical-alerts',
        },
      });
    });
    expect(mockRefresh).toHaveBeenCalled();
  });
});
