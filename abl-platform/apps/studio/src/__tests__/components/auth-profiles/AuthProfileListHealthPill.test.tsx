import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AuthProfileSummary } from '@/api/auth-profiles';
import { validateAuthProfile, validateWorkspaceAuthProfile } from '@/api/auth-profiles';
import { AuthProfileListHealthPill } from '@/components/auth-profiles/AuthProfileListHealthPill';

vi.mock('@/api/auth-profiles', async () => {
  const actual = await vi.importActual<typeof import('@/api/auth-profiles')>('@/api/auth-profiles');
  return {
    ...actual,
    validateAuthProfile: vi.fn(),
    validateWorkspaceAuthProfile: vi.fn(),
  };
});

function makeProfile(overrides: Partial<AuthProfileSummary> = {}): AuthProfileSummary {
  return {
    id: 'ap-1',
    name: 'Profile One',
    authType: 'api_key',
    usageMode: 'preconfigured',
    status: 'active',
    environment: 'development',
    visibility: 'shared',
    connectionMode: 'shared',
    scope: 'project',
    linkedConsumerCount: 0,
    lastUsedAt: null,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-06T00:00:00.000Z',
    createdBy: 'user-1',
    ...overrides,
  };
}

describe('AuthProfileListHealthPill', () => {
  beforeEach(() => {
    vi.mocked(validateAuthProfile).mockReset();
    vi.mocked(validateWorkspaceAuthProfile).mockReset();
  });

  it('renders a permission fallback pill and does not expose verify action', () => {
    render(
      <AuthProfileListHealthPill
        profile={makeProfile()}
        scope="project"
        projectId="project-1"
        canValidate={false}
      />,
    );

    expect(screen.getByText('Untested')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /verify auth profile/i })).not.toBeInTheDocument();
    expect(validateAuthProfile).not.toHaveBeenCalled();
  });

  it('does not run live validation on initial render', () => {
    render(
      <AuthProfileListHealthPill
        profile={makeProfile()}
        scope="project"
        projectId="project-1"
        canValidate
      />,
    );

    expect(screen.getByRole('button', { name: /verify auth profile/i })).toBeInTheDocument();
    expect(validateAuthProfile).not.toHaveBeenCalled();
  });

  it('runs project validation only when verify is clicked', async () => {
    vi.mocked(validateAuthProfile).mockResolvedValue({
      success: true,
      data: {
        valid: true,
        health: {
          state: 'verified',
          reason: 'Live verification succeeded.',
        },
      },
    });

    render(
      <AuthProfileListHealthPill
        profile={makeProfile()}
        scope="project"
        projectId="project-1"
        canValidate
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /verify auth profile/i }));

    expect(screen.getByText(/Checking/i)).toBeInTheDocument();
    await waitFor(() => expect(validateAuthProfile).toHaveBeenCalledWith('project-1', 'ap-1'));
    expect(await screen.findByText('Verified')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reverify auth profile/i })).toBeInTheDocument();
  });

  it('runs workspace validation when verify is clicked in workspace scope', async () => {
    vi.mocked(validateWorkspaceAuthProfile).mockResolvedValue({
      success: true,
      data: {
        valid: true,
        health: {
          state: 'connected',
          reason: 'Connected.',
        },
      },
    });

    render(
      <AuthProfileListHealthPill
        profile={makeProfile({ scope: 'tenant' })}
        scope="workspace"
        canValidate
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /verify auth profile/i }));

    await waitFor(() => expect(validateWorkspaceAuthProfile).toHaveBeenCalledWith('ap-1'));
    expect(await screen.findByText('Connected')).toBeInTheDocument();
  });

  it('renders lifecycle-blocked fallback and hides verify for inactive profiles', () => {
    render(
      <AuthProfileListHealthPill
        profile={makeProfile({
          status: 'revoked',
        })}
        scope="workspace"
        canValidate
      />,
    );

    expect(screen.getByText('Inactive')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /verify auth profile/i })).not.toBeInTheDocument();
  });

  it('clears stale validation state when profile status changes after authorization', async () => {
    vi.mocked(validateAuthProfile).mockResolvedValue({
      success: true,
      data: {
        valid: false,
        health: {
          state: 'reauth_required',
          reason: 'Token expired.',
        },
      },
    });

    const initialProfile = makeProfile({
      authType: 'oauth2_app',
      usageMode: 'preconfigured',
      status: 'pending_authorization',
      updatedAt: '2026-05-06T00:00:00.000Z',
    });

    const { rerender } = render(
      <AuthProfileListHealthPill
        profile={initialProfile}
        scope="project"
        projectId="project-1"
        canValidate
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /verify auth profile/i }));
    await waitFor(() => expect(validateAuthProfile).toHaveBeenCalledWith('project-1', 'ap-1'));
    expect(await screen.findByText('Re-authorization required')).toBeInTheDocument();

    rerender(
      <AuthProfileListHealthPill
        profile={{
          ...initialProfile,
          status: 'active',
          updatedAt: '2026-05-07T00:00:00.000Z',
        }}
        scope="project"
        projectId="project-1"
        canValidate
      />,
    );

    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(screen.queryByText('Re-authorization required')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /verify auth profile/i })).toBeInTheDocument();
  });
});
