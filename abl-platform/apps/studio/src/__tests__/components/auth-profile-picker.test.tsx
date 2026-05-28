import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const mockUseAuthProfiles = vi.fn();

vi.mock('@/hooks/useAuthProfiles', () => ({
  useAuthProfiles: (...args: unknown[]) => mockUseAuthProfiles(...args),
}));

import { AuthProfilePicker } from '@/components/auth-profiles/AuthProfilePicker';

describe('AuthProfilePicker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows attach-only messaging for raw_connection AWS IAM profiles', () => {
    mockUseAuthProfiles.mockReturnValue({
      profiles: [
        {
          id: 'profile-aws',
          name: 'AWS Raw Profile',
          authType: 'aws_iam',
          usageMode: 'preconfigured',
          status: 'active',
          environment: null,
          visibility: 'shared',
          connectionMode: 'shared',
          scope: 'project',
          linkedConsumerCount: 0,
          lastUsedAt: null,
          createdAt: '2026-04-23T00:00:00.000Z',
          updatedAt: '2026-04-23T00:00:00.000Z',
          createdBy: 'user-1',
        },
      ],
      isLoading: false,
    });

    render(
      <AuthProfilePicker
        projectId="proj-1"
        value="profile-aws"
        onChange={vi.fn()}
        consumerKind="raw_connection"
      />,
    );

    expect(screen.getByText(/does not guarantee request signing/i)).toBeInTheDocument();
  });

  it('does not show attach-only messaging for supported raw_connection basic profiles', () => {
    mockUseAuthProfiles.mockReturnValue({
      profiles: [
        {
          id: 'profile-basic',
          name: 'Basic Raw Profile',
          authType: 'basic',
          usageMode: 'preconfigured',
          status: 'active',
          environment: null,
          visibility: 'shared',
          connectionMode: 'shared',
          scope: 'project',
          linkedConsumerCount: 0,
          lastUsedAt: null,
          createdAt: '2026-04-23T00:00:00.000Z',
          updatedAt: '2026-04-23T00:00:00.000Z',
          createdBy: 'user-1',
        },
      ],
      isLoading: false,
    });

    render(
      <AuthProfilePicker
        projectId="proj-1"
        value="profile-basic"
        onChange={vi.fn()}
        consumerKind="raw_connection"
      />,
    );

    expect(screen.queryByText(/does not guarantee request signing/i)).not.toBeInTheDocument();
  });

  it('passes scope and visibility filters through to the auth profile hook', () => {
    mockUseAuthProfiles.mockReturnValue({
      profiles: [],
      isLoading: false,
    });

    render(
      <AuthProfilePicker
        projectId="proj-1"
        value={null}
        onChange={vi.fn()}
        filterScope="tenant"
        filterVisibility="shared"
      />,
    );

    expect(mockUseAuthProfiles).toHaveBeenCalledWith(
      'proj-1',
      expect.objectContaining({
        scope: 'tenant',
        visibility: 'shared',
      }),
    );
  });
});
