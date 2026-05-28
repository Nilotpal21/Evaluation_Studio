import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PropsWithChildren } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkflowDetail } from '../../api/workflows';

const mockApiFetch = vi.fn();
const mockHandleResponse = vi.fn();
const mockMutate = vi.fn();
const mockRefresh = vi.fn();
const mockToastSuccess = vi.fn();

let swrTriggerRegistrations: Record<string, unknown> = {};

vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (!key) {
      return { data: undefined, error: undefined, isLoading: false, mutate: mockMutate };
    }

    if (key.includes('/workflows/triggers?')) {
      return swrTriggerRegistrations;
    }

    return { data: undefined, error: undefined, isLoading: false, mutate: mockMutate };
  },
}));

vi.mock('../../store/navigation-store', () => ({
  useNavigationStore: vi.fn((selector?: (state: Record<string, unknown>) => unknown) => {
    const state = { projectId: 'proj-1' };
    return selector ? selector(state) : state;
  }),
}));

vi.mock('../../lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  handleResponse: (...args: unknown[]) => mockHandleResponse(...args),
}));

vi.mock('../../components/ui/ConfirmDialog', () => ({
  ConfirmDialog: ({
    open,
    title,
    description,
    onConfirm,
    onClose,
    confirmLabel,
  }: PropsWithChildren<{
    open: boolean;
    title: string;
    description: string;
    onConfirm: () => void;
    onClose: () => void;
    confirmLabel?: string;
  }>) =>
    open ? (
      <div data-testid="confirm-dialog">
        <div>{title}</div>
        <div>{description}</div>
        <button onClick={onClose}>Cancel</button>
        <button onClick={onConfirm}>{confirmLabel ?? 'Confirm'}</button>
      </div>
    ) : null,
}));

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: vi.fn(),
  },
}));

import { WorkflowTriggersTab } from '../../components/workflows/tabs/WorkflowTriggersTab';

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
  swrTriggerRegistrations = {
    data: {
      data: [
        {
          id: 'trigger-1',
          type: 'cron',
          status: 'active',
          config: { cronExpression: '0 9 * * 1-5' },
        },
      ],
    },
    error: undefined,
    isLoading: false,
    mutate: mockMutate,
  };
  mockApiFetch.mockResolvedValue({ ok: true });
  mockHandleResponse.mockResolvedValue({ success: true });
});

describe('WorkflowTriggersTab', () => {
  it('fires a trigger from the lifecycle action row', async () => {
    const user = userEvent.setup();

    render(<WorkflowTriggersTab workflow={makeWorkflow()} onRefresh={mockRefresh} />);

    await user.click(getButtonByText('Fire Now'));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/projects/proj-1/workflows/triggers/trigger-1/fire',
        { method: 'POST' },
      );
    });
    expect(mockMutate).toHaveBeenCalled();
    expect(mockRefresh).toHaveBeenCalled();
    expect(mockToastSuccess).toHaveBeenCalledWith('Trigger fired');
  });

  it('deletes a trigger after confirmation', async () => {
    const user = userEvent.setup();

    render(<WorkflowTriggersTab workflow={makeWorkflow()} onRefresh={mockRefresh} />);

    await user.click(screen.getByRole('button', { name: 'Delete trigger' }));
    await screen.findByText('Delete Trigger?');
    await user.click(screen.getByRole('button', { name: 'Delete Trigger' }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/projects/proj-1/workflows/triggers/trigger-1',
        { method: 'DELETE' },
      );
    });
    expect(mockMutate).toHaveBeenCalled();
    expect(mockRefresh).toHaveBeenCalled();
    expect(mockToastSuccess).toHaveBeenCalledWith('Trigger deleted');
  });

  it('keeps pause/resume working from the unified action row', async () => {
    const user = userEvent.setup();

    render(<WorkflowTriggersTab workflow={makeWorkflow()} onRefresh={mockRefresh} />);

    await user.click(screen.getByRole('button', { name: 'Pause trigger' }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/projects/proj-1/workflows/triggers/trigger-1/pause',
        { method: 'POST' },
      );
    });
    expect(mockMutate).toHaveBeenCalled();
    expect(mockRefresh).toHaveBeenCalled();
    expect(mockToastSuccess).toHaveBeenCalledWith('Trigger paused');
  });
});
