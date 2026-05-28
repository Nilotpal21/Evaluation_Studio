/**
 * Project members tab RBAC regressions
 *
 * @vitest-environment happy-dom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const mockApiFetch = vi.fn();
const mockUseSWR = vi.fn();
const mockMutateMembers = vi.fn();

const mockNavigationStore = {
  projectId: 'proj-1',
};

const mockAuthStore = {
  tenantId: 'tenant-1',
  user: {
    id: 'owner-1',
    email: 'owner@test.com',
    name: 'Owner User',
  },
};

const translations: Record<string, string> = {
  'settings.members.title': 'Project Members',
  'settings.members.description': 'View and manage who has access to this project.',
  'settings.members.empty_title': 'No members yet',
  'settings.members.empty_description':
    'Add workspace members to this project to start collaborating.',
  'settings.members.add_member': 'Add Member',
  'settings.members.refresh': 'Refresh',
  'settings.members.member_header': 'Member',
  'settings.members.role_header': 'Role',
  'settings.members.joined_header': 'Joined',
  'settings.members.actions_header': 'Actions',
  'settings.members.role_label': 'Role',
  'settings.members.user_label': 'Workspace member',
  'settings.members.user_placeholder': 'Select a workspace member',
  'settings.members.user_search_placeholder': 'Search workspace members by name or email',
  'settings.members.add': 'Add',
  'settings.members.cancel': 'Cancel',
  'settings.members.remove': 'Remove',
  'settings.members.dismiss': 'Dismiss',
  'settings.members.add_member_title': 'Add project member',
  'settings.members.add_member_description': 'Select a workspace member and assign a project role.',
  'settings.members.member_added': 'Member added to project',
  'settings.members.member_removed': 'Member removed from project',
  'settings.members.role_changed': 'Role updated to {role}',
  'settings.members.add_failed': 'Failed to add member',
  'settings.members.remove_failed': 'Failed to remove member',
  'settings.members.role_change_failed': 'Failed to update role',
  'settings.members.available_load_failed': 'Failed to load available workspace members',
  'settings.members.remove_confirm_title': 'Remove member',
  'settings.members.remove_confirm_description':
    'Are you sure you want to remove {name} from this project?',
  'settings.members.remove_confirm': 'Remove member',
  'settings.members.already_member': 'This user is already a project member',
  'settings.members.load_failed': 'Failed to load project members',
  'settings.members.no_available_members':
    'No additional active workspace members are available to add.',
  'settings.members.no_matching_members': 'No workspace members match your search.',
};

const translators = new Map<string, (key: string, values?: Record<string, string>) => string>();

vi.mock('next-intl', () => ({
  useTranslations: (namespace: string) => {
    const existing = translators.get(namespace);
    if (existing) return existing;

    const translator = (key: string, values?: Record<string, string>) => {
      const template = translations[`${namespace}.${key}`] ?? `${namespace}.${key}`;
      return Object.entries(values ?? {}).reduce(
        (message, [name, value]) => message.replace(`{${name}}`, value),
        template,
      );
    };

    translators.set(namespace, translator);
    return translator;
  },
}));

vi.mock('swr', () => ({
  default: (...args: unknown[]) => mockUseSWR(...args),
}));

vi.mock('../../lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('../../store/navigation-store', () => ({
  useNavigationStore: (selector?: (state: typeof mockNavigationStore) => unknown) =>
    selector ? selector(mockNavigationStore) : mockNavigationStore,
}));

vi.mock('../../store/auth-store', () => ({
  useAuthStore: (selector?: (state: typeof mockAuthStore) => unknown) =>
    selector ? selector(mockAuthStore) : mockAuthStore,
}));

vi.mock('../../components/ui/Button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    type = 'button',
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    type?: 'button' | 'submit' | 'reset';
  }) => (
    <button type={type} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

vi.mock('../../components/ui/Select', () => ({
  Select: ({
    label,
    options,
    value = '',
    onChange,
    placeholder,
    disabled,
  }: {
    label?: string;
    options: Array<{ value: string; label: string }>;
    value?: string;
    onChange?: (value: string) => void;
    placeholder?: string;
    disabled?: boolean;
  }) => (
    <label>
      <span>{label}</span>
      <select
        aria-label={label ?? placeholder ?? 'select'}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange?.(event.target.value)}
      >
        <option value="">{placeholder ?? 'Select...'}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  ),
}));

vi.mock('../../components/ui/Badge', () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock('../../components/ui/EmptyState', () => ({
  EmptyState: ({
    title,
    description,
    action,
  }: {
    title: string;
    description?: string;
    action?: ReactNode;
  }) => (
    <div>
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
      {action}
    </div>
  ),
}));

vi.mock('../../components/ui/Dialog', () => ({
  Dialog: ({
    open,
    title,
    description,
    children,
  }: {
    open: boolean;
    title?: string;
    description?: string;
    children: ReactNode;
  }) =>
    open ? (
      <div role="dialog">
        {title ? <h3>{title}</h3> : null}
        {description ? <p>{description}</p> : null}
        {children}
      </div>
    ) : null,
}));

import { ProjectMembersTab } from '../../components/settings/ProjectMembersTab';

describe('ProjectMembersTab RBAC regressions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseSWR.mockReturnValue({
      data: {
        members: [
          {
            id: 'pm-1',
            userId: 'dev-1',
            email: 'dev@test.com',
            name: 'Developer User',
            role: 'developer',
            customRoleId: null,
            joinedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        canManageMembers: false,
      },
      error: null,
      isLoading: false,
      isValidating: false,
      mutate: mockMutateMembers,
    });
  });

  it('hides project member mutation controls for read-only members', () => {
    render(<ProjectMembersTab />);

    expect(screen.queryByRole('button', { name: 'Add Member' })).not.toBeInTheDocument();
    expect(screen.queryByText('Actions')).not.toBeInTheDocument();
    expect(screen.queryByText('Remove')).not.toBeInTheDocument();
  });

  it('loads addable members from the project-scoped available-members endpoint', async () => {
    mockUseSWR.mockReturnValue({
      data: {
        members: [
          {
            id: 'pm-1',
            userId: 'dev-1',
            email: 'dev@test.com',
            name: 'Developer User',
            role: 'developer',
            customRoleId: null,
            joinedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        canManageMembers: true,
      },
      error: null,
      isLoading: false,
      isValidating: false,
      mutate: mockMutateMembers,
    });
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        success: true,
        members: [
          {
            id: 'tm-available',
            userId: 'available-1',
            email: 'available@test.com',
            name: 'Available User',
            workspaceRole: 'MEMBER',
            status: 'active',
            joinedAt: '2026-01-02T00:00:00.000Z',
          },
        ],
      }),
    });

    render(<ProjectMembersTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Add Member' }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/projects/proj-1/members/available');
    });

    expect(mockApiFetch).not.toHaveBeenCalledWith('/api/workspaces/tenant-1/members');
    expect(await screen.findByText('Available User')).toBeInTheDocument();
    expect(screen.getByText('available@test.com')).toBeInTheDocument();
  });

  it('filters addable users from the visible member search field', async () => {
    mockUseSWR.mockReturnValue({
      data: {
        members: [
          {
            id: 'pm-1',
            userId: 'dev-1',
            email: 'dev@test.com',
            name: 'Developer User',
            role: 'developer',
            customRoleId: null,
            joinedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        canManageMembers: true,
      },
      error: null,
      isLoading: false,
      isValidating: false,
      mutate: mockMutateMembers,
    });
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        success: true,
        members: [
          {
            id: 'tm-alpha',
            userId: 'alpha-1',
            email: 'alpha@test.com',
            name: 'Alpha User',
            workspaceRole: 'MEMBER',
            status: 'active',
            joinedAt: '2026-01-02T00:00:00.000Z',
          },
          {
            id: 'tm-beta',
            userId: 'beta-1',
            email: 'beta@test.com',
            name: 'Beta User',
            workspaceRole: 'MEMBER',
            status: 'active',
            joinedAt: '2026-01-02T00:00:00.000Z',
          },
        ],
      }),
    });

    render(<ProjectMembersTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Add Member' }));

    expect(await screen.findByText('Alpha User')).toBeInTheDocument();
    expect(screen.getByText('Beta User')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Search workspace members by name or email'), {
      target: { value: 'beta' },
    });

    expect(screen.queryByText('Alpha User')).not.toBeInTheDocument();
    expect(screen.getByText('Beta User')).toBeInTheDocument();
  });
});
