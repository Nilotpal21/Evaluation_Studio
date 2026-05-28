/**
 * AuthProfileAssignment (FR-15, FR-18, FR-20) — Unit Tests
 *
 * Tests type categorization rendering, profile selection, selectable=false
 * disabled rows for unauthorized OAuth, inline-Add removal, empty state, and
 * Create CTA behavior.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import {
  AuthProfileAssignment,
  type AuthProfileAssignmentValue,
} from '@/components/auth-profiles/AuthProfileAssignment';
import type { AuthProfileSummary } from '@/api/auth-profiles';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockProfiles: (AuthProfileSummary & { isAuthorized?: boolean })[] = [];
let mockIsLoading = false;

vi.mock('@/hooks/useAuthProfiles', () => ({
  useAuthProfiles: () => ({
    profiles: mockProfiles,
    total: mockProfiles.length,
    nextCursor: null,
    isLoading: mockIsLoading,
    error: null,
    refresh: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProfile(
  overrides: Partial<AuthProfileSummary & { isAuthorized?: boolean }> = {},
): AuthProfileSummary & { isAuthorized?: boolean } {
  return {
    id: 'prof-1',
    name: 'Test Profile',
    authType: 'api_key',
    usageMode: 'preconfigured',
    status: 'active',
    environment: null,
    visibility: 'shared',
    connectionMode: 'shared',
    scope: 'project',
    linkedConsumerCount: 0,
    lastUsedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    createdBy: 'user-1',
    ...overrides,
  };
}

const defaultProps = {
  projectId: 'proj-1',
  value: { profileId: null } as AuthProfileAssignmentValue,
  onChange: vi.fn(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AuthProfileAssignment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProfiles.length = 0;
    mockIsLoading = false;
  });

  // =========================================================================
  // Step 1 — Type Selector
  // =========================================================================

  describe('Step 1 — Type Selector', () => {
    it('renders tier categories: Common, Enterprise, Advanced', () => {
      render(<AuthProfileAssignment {...defaultProps} />);

      expect(screen.getByText('Common')).toBeInTheDocument();
      expect(screen.getByText('Enterprise')).toBeInTheDocument();
      expect(screen.getByText('Advanced')).toBeInTheDocument();
    });

    it('renders common auth types under Common category', () => {
      render(<AuthProfileAssignment {...defaultProps} />);

      expect(screen.getByText('API Key')).toBeInTheDocument();
      expect(screen.getByText('Bearer Token')).toBeInTheDocument();
      expect(screen.getByText('Basic Auth')).toBeInTheDocument();
      expect(screen.getByText('Custom Header')).toBeInTheDocument();
      expect(screen.getByText('OAuth 2.0 App')).toBeInTheDocument();
      expect(screen.getByText('Client Credentials')).toBeInTheDocument();
      expect(screen.getByText('Azure AD')).toBeInTheDocument();
      expect(screen.getByText('AWS IAM (SigV4)')).toBeInTheDocument();
      expect(screen.getByText('mTLS')).toBeInTheDocument();
    });

    it('renders enterprise types under Enterprise category', () => {
      render(<AuthProfileAssignment {...defaultProps} />);

      expect(screen.getByText('OAuth 2.0 Token')).toBeInTheDocument();
      expect(screen.getByText('SSH Key')).toBeInTheDocument();
    });

    it('renders advanced types under Advanced category', () => {
      render(<AuthProfileAssignment {...defaultProps} />);

      expect(screen.getByText('Digest Auth')).toBeInTheDocument();
      expect(screen.getByText('Kerberos')).toBeInTheDocument();
      expect(screen.getByText('SAML')).toBeInTheDocument();
      expect(screen.getByText('HAWK')).toBeInTheDocument();
      expect(screen.getByText('WS-Security')).toBeInTheDocument();
    });

    it('excludes "none" from the selectable types', () => {
      render(<AuthProfileAssignment {...defaultProps} />);

      expect(screen.queryByText('No Auth')).not.toBeInTheDocument();
    });

    it('clicking a type transitions to step 2 and calls onChange', () => {
      const onChange = vi.fn();
      render(<AuthProfileAssignment {...defaultProps} onChange={onChange} />);

      fireEvent.click(screen.getByText('API Key'));

      // Should call onChange resetting profileId
      expect(onChange).toHaveBeenCalledWith({ profileId: null });
    });

    it('disables type buttons when disabled prop is true', () => {
      render(<AuthProfileAssignment {...defaultProps} disabled />);

      const apiKeyButton = screen.getByText('API Key').closest('button');
      expect(apiKeyButton).toBeDisabled();
    });
  });

  // =========================================================================
  // Step 2 — Profile Selection (pre-selected type)
  // =========================================================================

  describe('Step 2 — Profile Selection', () => {
    it('shows profile dropdown when type is pre-selected', () => {
      render(<AuthProfileAssignment {...defaultProps} preselectedAuthType="api_key" />);

      // Should show step 2 content (profile selector header)
      expect(screen.getByText('Select Profile')).toBeInTheDocument();
      expect(screen.getByText('API Key')).toBeInTheDocument();
    });

    it('shows back button when type is not pre-selected but selected via step 1', () => {
      const onChange = vi.fn();
      const { rerender } = render(<AuthProfileAssignment {...defaultProps} onChange={onChange} />);

      // Click a type to go to step 2
      fireEvent.click(screen.getByText('Bearer Token'));

      // Rerender with the new value (simulating parent state update)
      // The component manages selectedAuthType internally, so it already moved
      // to step 2. Verify the back button exists.
      const backButton = screen.queryByRole('button', {
        name: /back/i,
      });
      expect(backButton).toBeInTheDocument();
    });

    it('hides back button when preselectedAuthType is provided', () => {
      render(<AuthProfileAssignment {...defaultProps} preselectedAuthType="api_key" />);

      const backButton = screen.queryByRole('button', {
        name: /back/i,
      });
      expect(backButton).not.toBeInTheDocument();
    });

    it('displays profiles in dropdown when clicked', () => {
      mockProfiles.push(
        makeProfile({ id: 'p1', name: 'My API Key', authType: 'api_key' }),
        makeProfile({ id: 'p2', name: 'Secondary Key', authType: 'api_key' }),
      );

      render(<AuthProfileAssignment {...defaultProps} preselectedAuthType="api_key" />);

      // Open dropdown
      const dropdownButton = screen.getByText('Select a profile...').closest('button')!;
      fireEvent.click(dropdownButton);

      expect(screen.getByText('My API Key')).toBeInTheDocument();
      expect(screen.getByText('Secondary Key')).toBeInTheDocument();
    });

    it('selects a profile on click', () => {
      const onChange = vi.fn();
      mockProfiles.push(makeProfile({ id: 'p1', name: 'My API Key', authType: 'api_key' }));

      render(
        <AuthProfileAssignment
          {...defaultProps}
          onChange={onChange}
          preselectedAuthType="api_key"
        />,
      );

      // Open dropdown
      const dropdownButton = screen.getByText('Select a profile...').closest('button')!;
      fireEvent.click(dropdownButton);

      // Click profile
      fireEvent.click(screen.getByText('My API Key'));

      expect(onChange).toHaveBeenCalledWith({ profileId: 'p1' });
    });

    it('excludes profiles by excludeProfileIds', () => {
      mockProfiles.push(
        makeProfile({ id: 'p1', name: 'Included Profile', authType: 'api_key' }),
        makeProfile({ id: 'p2', name: 'Excluded Profile', authType: 'api_key' }),
      );

      render(
        <AuthProfileAssignment
          {...defaultProps}
          preselectedAuthType="api_key"
          excludeProfileIds={new Set(['p2'])}
        />,
      );

      // Open dropdown
      const dropdownButton = screen.getByText('Select a profile...').closest('button')!;
      fireEvent.click(dropdownButton);

      expect(screen.getByText('Included Profile')).toBeInTheDocument();
      expect(screen.queryByText('Excluded Profile')).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // FR-15 — Disabled-row for unauthorized OAuth
  // =========================================================================

  describe('FR-15 — selectable=false for unauthorized OAuth', () => {
    it('disables unauthorized oauth2_app profiles with Lock icon and tooltip', () => {
      mockProfiles.push(
        makeProfile({
          id: 'p-auth',
          name: 'Authorized OAuth',
          authType: 'oauth2_app',
          isAuthorized: true,
        }),
        makeProfile({
          id: 'p-unauth',
          name: 'Unauthorized OAuth',
          authType: 'oauth2_app',
          isAuthorized: false,
        }),
      );

      render(<AuthProfileAssignment {...defaultProps} preselectedAuthType="oauth2_app" />);

      // Open dropdown
      const dropdownButton = screen.getByText('Select a profile...').closest('button')!;
      fireEvent.click(dropdownButton);

      const authorizedOption = screen.getByText('Authorized OAuth').closest('button');
      const unauthorizedOption = screen.getByText('Unauthorized OAuth').closest('button');

      expect(authorizedOption).not.toBeDisabled();
      expect(unauthorizedOption).toBeDisabled();

      // Lock icon should be on unauthorized option
      const lockIcon = within(unauthorizedOption!).queryByTestId('icon-lock');
      expect(lockIcon).toBeInTheDocument();
    });
  });

  // =========================================================================
  // FR-20 — Inline-Add removed
  // =========================================================================

  describe('FR-20 — Inline-Add removal', () => {
    it('does NOT show inline-add option for simple auth types (api_key)', () => {
      mockProfiles.push(makeProfile({ id: 'p1', name: 'Existing Key', authType: 'api_key' }));

      render(<AuthProfileAssignment {...defaultProps} preselectedAuthType="api_key" />);

      const dropdownButton = screen.getByText('Select a profile...').closest('button')!;
      fireEvent.click(dropdownButton);

      expect(screen.queryByText('Add value inline')).not.toBeInTheDocument();
    });

    it('does NOT show inline-add option for complex types (oauth2_app)', () => {
      mockProfiles.push(makeProfile({ id: 'p1', name: 'OAuth App', authType: 'oauth2_app' }));

      render(<AuthProfileAssignment {...defaultProps} preselectedAuthType="oauth2_app" />);

      const dropdownButton = screen.getByText('Select a profile...').closest('button')!;
      fireEvent.click(dropdownButton);

      expect(screen.queryByText('Add value inline')).not.toBeInTheDocument();
    });

    it.each(['bearer', 'basic', 'custom_header'] as const)(
      'does NOT show inline-add for %s',
      (authType) => {
        render(<AuthProfileAssignment {...defaultProps} preselectedAuthType={authType} />);

        const dropdownButton = screen.getByText('Select a profile...').closest('button')!;
        fireEvent.click(dropdownButton);

        expect(screen.queryByText('Add value inline')).not.toBeInTheDocument();
      },
    );
  });

  // =========================================================================
  // Create CTA
  // =========================================================================

  describe('Create Profile CTA', () => {
    it('shows Create CTA when onCreateProfile is provided', () => {
      render(
        <AuthProfileAssignment
          {...defaultProps}
          preselectedAuthType="api_key"
          onCreateProfile={vi.fn()}
        />,
      );

      const dropdownButton = screen.getByText('Select a profile...').closest('button')!;
      fireEvent.click(dropdownButton);

      expect(screen.getByText('Create Auth Profile')).toBeInTheDocument();
    });

    it('calls onCreateProfile with the selected auth type', () => {
      const onCreateProfile = vi.fn();

      render(
        <AuthProfileAssignment
          {...defaultProps}
          preselectedAuthType="api_key"
          onCreateProfile={onCreateProfile}
        />,
      );

      const dropdownButton = screen.getByText('Select a profile...').closest('button')!;
      fireEvent.click(dropdownButton);

      fireEvent.click(screen.getByText('Create Auth Profile'));

      expect(onCreateProfile).toHaveBeenCalledWith('api_key');
    });

    it('does NOT show Create CTA when onCreateProfile is not provided', () => {
      render(<AuthProfileAssignment {...defaultProps} preselectedAuthType="api_key" />);

      const dropdownButton = screen.getByText('Select a profile...').closest('button')!;
      fireEvent.click(dropdownButton);

      expect(screen.queryByText('Create Auth Profile')).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // Empty state
  // =========================================================================

  describe('Empty state', () => {
    it('shows empty state message when no profiles match the type', () => {
      // No profiles in mock
      render(
        <AuthProfileAssignment
          {...defaultProps}
          preselectedAuthType="api_key"
          onCreateProfile={vi.fn()}
        />,
      );

      const dropdownButton = screen.getByText('Select a profile...').closest('button')!;
      fireEvent.click(dropdownButton);

      expect(screen.getByText('No profiles found for this auth type')).toBeInTheDocument();
      expect(screen.getByText('Create one now')).toBeInTheDocument();
    });

    it('calls onCreateProfile from the empty state CTA', () => {
      const onCreateProfile = vi.fn();

      render(
        <AuthProfileAssignment
          {...defaultProps}
          preselectedAuthType="bearer"
          onCreateProfile={onCreateProfile}
        />,
      );

      const dropdownButton = screen.getByText('Select a profile...').closest('button')!;
      fireEvent.click(dropdownButton);

      fireEvent.click(screen.getByText('Create one now'));

      expect(onCreateProfile).toHaveBeenCalledWith('bearer');
    });
  });

  // =========================================================================
  // Clear selection
  // =========================================================================

  describe('Clear selection', () => {
    it('shows clear selection link when a profile is selected', () => {
      mockProfiles.push(makeProfile({ id: 'p1', name: 'My Profile', authType: 'api_key' }));

      render(
        <AuthProfileAssignment
          {...defaultProps}
          preselectedAuthType="api_key"
          value={{ profileId: 'p1' }}
        />,
      );

      expect(screen.getByText('Clear selection')).toBeInTheDocument();
    });

    it('calls onChange with null profileId when clear is clicked', () => {
      const onChange = vi.fn();
      mockProfiles.push(makeProfile({ id: 'p1', name: 'My Profile', authType: 'api_key' }));

      render(
        <AuthProfileAssignment
          {...defaultProps}
          onChange={onChange}
          preselectedAuthType="api_key"
          value={{ profileId: 'p1' }}
        />,
      );

      fireEvent.click(screen.getByText('Clear selection'));

      expect(onChange).toHaveBeenCalledWith({ profileId: null });
    });
  });
});
