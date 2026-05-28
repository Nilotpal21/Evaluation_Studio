/**
 * Git setup dialog scenario regressions for ABLP-976.
 *
 * This component-level scenario covers the UI picker contract that route tests
 * cannot see: auth profile selection must expose only the Git auth types that
 * provider credential resolution supports end to end.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { GitIntegrationTab } from '../../components/settings/GitIntegrationTab';

const mockFetchGitIntegration = vi.fn();
const mockCreateGitIntegration = vi.fn();
const mockDeleteGitIntegration = vi.fn();
const mockFetchGitStatus = vi.fn();
const mockPushToGit = vi.fn();
const mockPullFromGit = vi.fn();
const mockFetchGitHistory = vi.fn();

vi.mock('../../api/project-io', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/project-io')>();
  return {
    ...actual,
    fetchGitIntegration: (...args: unknown[]) => mockFetchGitIntegration(...args),
    createGitIntegration: (...args: unknown[]) => mockCreateGitIntegration(...args),
    deleteGitIntegration: (...args: unknown[]) => mockDeleteGitIntegration(...args),
    fetchGitStatus: (...args: unknown[]) => mockFetchGitStatus(...args),
    pushToGit: (...args: unknown[]) => mockPushToGit(...args),
    pullFromGit: (...args: unknown[]) => mockPullFromGit(...args),
    fetchGitHistory: (...args: unknown[]) => mockFetchGitHistory(...args),
  };
});

vi.mock('../../store/navigation-store', () => ({
  useNavigationStore: () => ({ projectId: 'project-1' }),
}));

vi.mock('../../components/auth-profiles/AuthProfilePicker', () => ({
  AuthProfilePicker: (props: {
    filterAuthTypes?: string[];
    value?: string | null;
    onChange: (profileId: string | null) => void;
  }) => (
    <div data-testid="git-auth-profile-picker">
      {(props.filterAuthTypes ?? []).join(',') || 'all'}
      <span data-testid="selected-auth-profile">{props.value ?? 'none'}</span>
      <button type="button" onClick={() => props.onChange('auth-profile-token-1')}>
        Select Token Profile
      </button>
    </div>
  ),
}));

const messages = {
  settings: {
    git: {
      page_title: 'Git Integration',
      page_description: 'Connect a repository.',
      empty: 'No repository connected',
      empty_description: 'Connect a repository to sync project files.',
      connect_repo: 'Connect Repository',
      setup_dialog_title: 'Connect Repository',
      provider_label: 'Provider',
      repo_url_label: 'Repository URL',
      repo_url_placeholder: 'https://github.com/acme/repo',
      branch_label: 'Default Branch',
      sync_path_label: 'Sync Path',
      auth_profile_placeholder: 'Select an auth profile',
      conflict_strategy_label: 'Conflict Strategy',
      cancel: 'Cancel',
      connect: 'Connect',
      connected: 'Connected',
      connect_failed: 'Failed to connect',
      url_required: 'Repository URL is required',
      select_auth_profile_required: 'Select an auth profile',
    },
  },
};

function renderTab() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <GitIntegrationTab />
    </NextIntlClientProvider>,
  );
}

describe('Git setup dialog auth profile scenarios', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchGitIntegration.mockResolvedValue({ integration: null });
    mockCreateGitIntegration.mockResolvedValue({ integration: null });
    mockDeleteGitIntegration.mockResolvedValue({ success: true });
    mockFetchGitStatus.mockResolvedValue({});
    mockPushToGit.mockResolvedValue({});
    mockPullFromGit.mockResolvedValue({});
    mockFetchGitHistory.mockResolvedValue({ history: [], total: 0 });
  });

  it('filters Git setup auth profiles to supported token-compatible types', async () => {
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByRole('button', { name: /Connect Repository/ }));

    await waitFor(() => {
      expect(screen.getByTestId('git-auth-profile-picker')).toBeDefined();
    });
    expect(screen.getByTestId('git-auth-profile-picker').textContent).toContain(
      'bearer,api_key,oauth2_token',
    );
    expect(screen.getByTestId('git-auth-profile-picker').textContent).not.toContain('ssh_key');
  });

  it('submits selected auth profiles as the only credential source', async () => {
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByRole('button', { name: /Connect Repository/ }));
    fireEvent.change(screen.getByLabelText('Repository URL'), {
      target: { value: 'https://github.com/acme/support' },
    });
    await user.click(screen.getByRole('button', { name: 'Select Token Profile' }));
    await user.click(screen.getByRole('button', { name: /Connect/ }));

    await waitFor(() => {
      expect(mockCreateGitIntegration).toHaveBeenCalled();
    });
    expect(mockCreateGitIntegration).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({
        authProfileId: 'auth-profile-token-1',
      }),
    );
    expect(mockCreateGitIntegration.mock.calls[0]?.[1]).not.toHaveProperty('credentials');
  });

  it('does not submit until an auth profile is selected', async () => {
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByRole('button', { name: /Connect Repository/ }));
    await user.type(screen.getByLabelText('Repository URL'), 'https://github.com/acme/support');
    await user.click(screen.getByRole('button', { name: /Connect/ }));

    await waitFor(() => {
      expect(mockCreateGitIntegration).not.toHaveBeenCalled();
    });
  });

  it('keeps setup form values available for retry after provider validation fails', async () => {
    const user = userEvent.setup();
    mockCreateGitIntegration.mockRejectedValueOnce(new Error('Invalid credentials'));
    renderTab();

    await user.click(await screen.findByRole('button', { name: /Connect Repository/ }));
    fireEvent.change(screen.getByLabelText('Repository URL'), {
      target: { value: 'https://github.com/acme/support' },
    });
    await user.click(screen.getByRole('button', { name: 'Select Token Profile' }));
    await user.click(screen.getByRole('button', { name: /Connect/ }));

    await waitFor(() => {
      expect(mockCreateGitIntegration).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByLabelText('Repository URL')).toHaveValue('https://github.com/acme/support');

    await user.click(screen.getByRole('button', { name: /Connect/ }));

    await waitFor(() => {
      expect(mockCreateGitIntegration).toHaveBeenCalledTimes(2);
    });
  });

  it('coalesces rapid duplicate setup clicks into a single create request', async () => {
    const user = userEvent.setup();
    let resolveCreate: (value: unknown) => void = () => undefined;
    mockCreateGitIntegration.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    renderTab();

    await user.click(await screen.findByRole('button', { name: /Connect Repository/ }));
    await user.type(screen.getByLabelText('Repository URL'), 'https://github.com/acme/support');
    await user.click(screen.getByRole('button', { name: 'Select Token Profile' }));
    await user.dblClick(screen.getByRole('button', { name: /Connect/ }));

    expect(mockCreateGitIntegration).toHaveBeenCalledTimes(1);
    resolveCreate({ integration: null });
  });
});
