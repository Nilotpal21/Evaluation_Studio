/**
 * Project dashboard create-modal regressions.
 *
 * @vitest-environment happy-dom
 */

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppError } from '@agent-platform/shared/errors';
import { PROJECT_NAME_ERROR_MESSAGE } from '../../lib/project-name-validation';

const mockNavigate = vi.hoisted(() => vi.fn());
const mockCreateAndAddProject = vi.hoisted(() => vi.fn());
const mockLoadProjects = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockProjectStore = vi.hoisted(() => ({
  projects: [],
  isLoading: false,
}));
const mockAuthStore = vi.hoisted(() => ({
  isAuthenticated: true,
}));
const mockPreferencesStore = vi.hoisted(() => ({
  pinnedProjectIds: [],
  togglePin: vi.fn(),
  isPinned: vi.fn(() => false),
  loadPreferences: vi.fn(),
}));

vi.mock('../../store/project-store', () => ({
  useProjectStore: Object.assign(
    vi.fn((selector?: (state: typeof mockProjectStore) => unknown) =>
      selector ? selector(mockProjectStore) : mockProjectStore,
    ),
    {
      getState: () => mockProjectStore,
      setState: vi.fn(),
      subscribe: vi.fn(),
    },
  ),
}));

vi.mock('../../store/auth-store', () => ({
  useAuthStore: Object.assign(
    vi.fn((selector?: (state: typeof mockAuthStore) => unknown) =>
      selector ? selector(mockAuthStore) : mockAuthStore,
    ),
    {
      getState: () => mockAuthStore,
      setState: vi.fn(),
      subscribe: vi.fn(),
    },
  ),
}));

vi.mock('../../store/navigation-store', () => ({
  useNavigationStore: Object.assign(
    vi.fn((selector?: (state: { navigate: typeof mockNavigate }) => unknown) =>
      selector ? selector({ navigate: mockNavigate }) : { navigate: mockNavigate },
    ),
    {
      getState: () => ({ navigate: mockNavigate }),
      setState: vi.fn(),
      subscribe: vi.fn(),
    },
  ),
}));

vi.mock('../../store/preferences-store', () => ({
  usePreferencesStore: Object.assign(
    vi.fn((selector?: (state: typeof mockPreferencesStore) => unknown) =>
      selector ? selector(mockPreferencesStore) : mockPreferencesStore,
    ),
    {
      getState: () => mockPreferencesStore,
      setState: vi.fn(),
      subscribe: vi.fn(),
    },
  ),
}));

vi.mock('../../api/projects', () => ({
  createAndAddProject: (...args: unknown[]) => mockCreateAndAddProject(...args),
  loadProjects: (...args: unknown[]) => mockLoadProjects(...args),
  fetchProject: vi.fn(() => Promise.resolve({})),
}));

vi.mock('../../components/ui/PageHeader', () => ({
  PageHeader: ({ title, actions }: { title: string; actions?: React.ReactNode }) => (
    <div>
      <h1>{title}</h1>
      {actions}
    </div>
  ),
}));

vi.mock('../../components/ui/EmptyState', () => ({
  EmptyState: ({
    title,
    description,
    action,
  }: {
    title: string;
    description: string;
    action?: React.ReactNode;
  }) => (
    <div>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  ),
}));

vi.mock('../../components/ui/Button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    className,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" onClick={onClick} disabled={disabled} className={className} {...props}>
      {children}
    </button>
  ),
}));

vi.mock('../../components/creation/NewProjectDropdown', () => ({
  NewProjectDropdown: ({
    onBlankProject,
  }: {
    onStartWithArch?: () => void;
    onBlankProject?: () => void;
    onFromTemplate?: () => void;
  }) => <button onClick={onBlankProject}>New Project</button>,
}));

vi.mock('../../components/projects/ArchBar', () => ({
  ArchBar: () => <div data-testid="arch-bar" />,
}));

vi.mock('../../components/projects/PinnedProjectsRow', () => ({
  PinnedProjectsRow: () => null,
}));

vi.mock('../../lib/project-colors', () => ({
  getProjectColor: () => ({ bg: 'bg-blue-100', text: 'text-blue-600' }),
}));

import { ProjectDashboard } from '../../components/projects/ProjectDashboard';

function getCreateProjectDialog(): HTMLElement {
  return screen.getByRole('dialog', { name: 'Create Project' });
}

function getDialogCreateButton(dialog: HTMLElement): HTMLButtonElement {
  return within(dialog).getByRole('button', { name: 'Create Project' }) as HTMLButtonElement;
}

describe('ProjectDashboard create modal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectStore.projects = [];
    mockProjectStore.isLoading = false;
    mockAuthStore.isAuthenticated = true;
  });

  it('shows a client-side validation error for unsupported project name characters', async () => {
    const user = userEvent.setup();

    render(<ProjectDashboard />);

    await user.click(screen.getByRole('button', { name: 'Create Project' }));
    const dialog = getCreateProjectDialog();
    await user.type(within(dialog).getByPlaceholderText('e.g. Customer Support'), 'Bad & Name');

    expect(screen.getAllByRole('button', { name: 'Create Project' }).length).toBeGreaterThan(1);
    expect(within(dialog).getByText(PROJECT_NAME_ERROR_MESSAGE)).toBeInTheDocument();
    expect(getDialogCreateButton(dialog)).toBeDisabled();

    await user.click(getDialogCreateButton(dialog));
    expect(mockCreateAndAddProject).not.toHaveBeenCalled();
  });

  it('surfaces a safe create-project error inside the modal', async () => {
    mockCreateAndAddProject.mockRejectedValueOnce(
      new AppError('Project name already exists', {
        code: 'NAME_CONFLICT',
        statusCode: 409,
      }),
    );

    const user = userEvent.setup();
    render(<ProjectDashboard />);

    await user.click(screen.getByRole('button', { name: 'Create Project' }));
    const dialog = getCreateProjectDialog();
    await user.type(within(dialog).getByPlaceholderText('e.g. Customer Support'), 'Valid Project');
    await user.click(getDialogCreateButton(dialog));

    await waitFor(() => {
      expect(mockCreateAndAddProject).toHaveBeenCalledWith({
        name: 'Valid Project',
        description: undefined,
      });
    });
    expect(within(dialog).getByText('Project name already exists')).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('joins structured AppError validation messages inside the modal', async () => {
    mockCreateAndAddProject.mockRejectedValueOnce(
      new AppError('Validation error', {
        code: 'VALIDATION_ERROR',
        statusCode: 400,
        messages: [PROJECT_NAME_ERROR_MESSAGE, 'Description must be 500 characters or less'],
      }),
    );

    const user = userEvent.setup();
    render(<ProjectDashboard />);

    await user.click(screen.getByRole('button', { name: 'Create Project' }));
    const dialog = getCreateProjectDialog();
    await user.type(within(dialog).getByPlaceholderText('e.g. Customer Support'), 'Valid Project');
    await user.type(within(dialog).getByPlaceholderText('What is this project about?'), 'x');
    await user.click(getDialogCreateButton(dialog));

    await waitFor(() => {
      expect(mockCreateAndAddProject).toHaveBeenCalledWith({
        name: 'Valid Project',
        description: 'x',
      });
    });
    expect(
      within(dialog).getByText(
        `${PROJECT_NAME_ERROR_MESSAGE}. Description must be 500 characters or less`,
      ),
    ).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
