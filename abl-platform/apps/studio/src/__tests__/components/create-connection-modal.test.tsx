import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const mockUseAvailableConnectors = vi.fn();
const mockUseAuthProfiles = vi.fn();
const mockCreateConnection = vi.fn();
const mockOAuthFlowDialog = vi.fn();
const mockAuthProfilePicker = vi.fn();

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({
      children,
      ...props
    }: React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }) => (
      <div {...props}>{children}</div>
    ),
  },
}));

vi.mock('@/hooks/useAvailableConnectors', () => ({
  useAvailableConnectors: (...args: unknown[]) => mockUseAvailableConnectors(...args),
}));

vi.mock('@/hooks/useAuthProfiles', () => ({
  useAuthProfiles: (...args: unknown[]) => mockUseAuthProfiles(...args),
}));

vi.mock('@/api/connections', () => ({
  createConnection: (...args: unknown[]) => mockCreateConnection(...args),
}));

vi.mock('@/components/ui/Dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => {
    if (!open) return null;
    return <div role="dialog">{children}</div>;
  },
}));

vi.mock('@/components/connections/ConnectorLogo', () => ({
  ConnectorLogo: ({ name }: { name: string }) => <div data-testid={`logo-${name}`} />,
}));

vi.mock('@/components/connections/OAuthFlowDialog', () => ({
  OAuthFlowDialog: (props: unknown) => {
    mockOAuthFlowDialog(props);
    return null;
  },
}));

// Profiles available to the picker. Tests can mutate this map so a given
// profile resolves with `status: 'active'` etc.
const mockProfilesById: Record<string, { id: string; authType: string; status: string }> = {
  'profile-1': { id: 'profile-1', authType: 'oauth2_app', status: 'pending_authorization' },
  'profile-active': { id: 'profile-active', authType: 'oauth2_app', status: 'active' },
};

vi.mock('@/components/auth-profiles/AuthProfilePicker', () => ({
  AuthProfilePicker: (props: {
    value: string | null;
    onChange: (id: string | null) => void;
    onProfileChange?: (profile: unknown | null) => void;
    [key: string]: unknown;
  }) => {
    mockAuthProfilePicker(props);
    const { value, onChange, onProfileChange } = props;
    return (
      <select
        data-testid="auth-profile-picker"
        value={value ?? ''}
        onChange={(e) => {
          const id = e.target.value || null;
          onChange(id);
          if (onProfileChange) {
            onProfileChange(id ? (mockProfilesById[id] ?? null) : null);
          }
        }}
      >
        <option value="">Select an auth profile...</option>
        <option value="profile-1">Test Profile (pending)</option>
        <option value="profile-active">Active Profile</option>
      </select>
    );
  },
}));

vi.mock('@/components/connections/connector-categories', () => ({
  getConnectorCategory: () => 'crm',
  getCategoryLabel: () => 'CRM',
  CATEGORY_ORDER: ['crm'],
}));

import { CreateConnectionModal } from '@/components/connections/CreateConnectionModal';

describe('CreateConnectionModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAvailableConnectors.mockReturnValue({
      connectors: [
        {
          name: 'salesforce',
          displayName: 'Salesforce',
          authType: 'oauth2',
          actions: [],
          triggers: [],
          oauth2: {
            authorizationUrl:
              'https://${connectionConfig.hostname}/services/oauth2/authorize || https://login.salesforce.com/services/oauth2/authorize',
            tokenUrl:
              'https://${connectionConfig.hostname}/services/oauth2/token || https://login.salesforce.com/services/oauth2/token',
            defaultScopes: ['api'],
            scopeSeparator: ' ',
            pkce: false,
            connectionConfig: {
              hostname: {
                type: 'string',
                title: 'Hostname',
                optional: false,
                description: 'Your Salesforce hostname',
              },
            },
          },
        },
        {
          name: 'smartassist',
          displayName: 'Kore SmartAssist',
          authType: 'api_key',
          actions: [],
          triggers: [],
        },
      ],
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    });
    mockCreateConnection.mockResolvedValue({
      success: true,
      data: { id: 'conn-1' },
    });
    mockUseAuthProfiles.mockReturnValue({
      profiles: [
        {
          id: 'profile-1',
          name: 'Test Profile',
          authType: 'oauth2_app',
          status: 'pending_authorization',
        },
        { id: 'profile-active', name: 'Active Profile', authType: 'oauth2_app', status: 'active' },
      ],
      total: 2,
      nextCursor: null,
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    });
    mockOAuthFlowDialog.mockClear();
    mockAuthProfilePicker.mockClear();
  });

  it('always shows auth profile picker for all connectors (no toggle)', () => {
    render(<CreateConnectionModal open onClose={vi.fn()} projectId="proj-1" onCreated={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /kore smartassist/i }));

    // Auth profile picker is always shown — no toggle
    expect(screen.getByTestId('auth-profile-picker')).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: /use auth profile/i })).not.toBeInTheDocument();
  });

  it('shows "Create Connection" button for OAuth connectors when a non-active profile is selected', () => {
    render(<CreateConnectionModal open onClose={vi.fn()} projectId="proj-1" onCreated={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /salesforce/i }));

    // Select a pending (non-active) auth profile — OAuth flow is still required
    fireEvent.change(screen.getByTestId('auth-profile-picker'), {
      target: { value: 'profile-1' },
    });

    // Fill required OAuth connection config
    const hostnameInput = screen.getByLabelText('Hostname');
    fireEvent.change(hostnameInput, { target: { value: 'acme.my.salesforce.com' } });

    // Button label is now "Create Connection" (was "Authorize with Salesforce");
    // clicking it still enters the OAuth dialog when the profile is non-active.
    const createButton = screen.getByRole('button', { name: /create connection/i });
    expect(createButton).toBeInTheDocument();
    expect(createButton).not.toBeDisabled();
    // Legacy label must no longer be present.
    expect(screen.queryByRole('button', { name: /authorize with salesforce/i })).toBeNull();
  });

  it('disables Create Connection button when no auth profile is selected', () => {
    render(<CreateConnectionModal open onClose={vi.fn()} projectId="proj-1" onCreated={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /salesforce/i }));

    // Select an auth profile — this makes isOAuthConnector true and shows Hostname field
    fireEvent.change(screen.getByTestId('auth-profile-picker'), {
      target: { value: 'profile-1' },
    });

    const createButton = screen.getByRole('button', { name: /create connection/i });
    expect(createButton).toBeDisabled();
  });

  it('disables create button when no auth profile is selected for non-OAuth connectors', () => {
    render(<CreateConnectionModal open onClose={vi.fn()} projectId="proj-1" onCreated={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /kore smartassist/i }));

    const createButton = screen.getByRole('button', { name: /create connection/i });
    expect(createButton).toBeDisabled();
  });

  it('launches OAuth dialog with authProfileId when Create Connection is clicked for a non-active profile', () => {
    render(<CreateConnectionModal open onClose={vi.fn()} projectId="proj-1" onCreated={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /salesforce/i }));

    // Select pending profile — OAuth flow still required
    fireEvent.change(screen.getByTestId('auth-profile-picker'), {
      target: { value: 'profile-1' },
    });

    // Fill required OAuth connection config
    fireEvent.change(screen.getByLabelText('Hostname'), {
      target: { value: 'acme.my.salesforce.com' },
    });

    // Update connection name
    fireEvent.change(screen.getByLabelText('Connection name'), {
      target: { value: 'Acme Salesforce' },
    });

    fireEvent.click(screen.getByRole('button', { name: /create connection/i }));

    expect(mockOAuthFlowDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        connector: expect.objectContaining({
          name: 'salesforce',
          displayName: 'Acme Salesforce',
          connectionConfig: { hostname: 'acme.my.salesforce.com' },
        }),
        projectId: 'proj-1',
        authProfileId: 'profile-1',
      }),
    );
    expect(mockCreateConnection).not.toHaveBeenCalled();
  });

  it('skips the OAuth flow and creates the connection directly when the selected oauth2_app profile is already active', async () => {
    // Regression: when an oauth2_app profile is already authorized at the
    // auth-profile level (status: active), the connection should be created
    // directly — re-authorizing per-connection is wasteful and confusing.
    const onCreated = vi.fn();
    render(
      <CreateConnectionModal open onClose={vi.fn()} projectId="proj-1" onCreated={onCreated} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /salesforce/i }));

    // Selecting the active profile flips isOAuthConnector to false → the
    // OAuth-specific connection-config fields (Hostname) disappear.
    fireEvent.change(screen.getByTestId('auth-profile-picker'), {
      target: { value: 'profile-active' },
    });
    expect(screen.queryByLabelText('Hostname')).toBeNull();

    fireEvent.change(screen.getByLabelText('Connection name'), {
      target: { value: 'Acme Salesforce' },
    });

    const createButton = screen.getByRole('button', { name: /create connection/i });
    expect(createButton).not.toBeDisabled();
    fireEvent.click(createButton);

    // OAuth dialog must NOT open for an active profile.
    expect(mockOAuthFlowDialog).not.toHaveBeenCalledWith(expect.objectContaining({ open: true }));
    // Direct createConnection happens instead.
    await Promise.resolve();
    await Promise.resolve();
    expect(mockCreateConnection).toHaveBeenCalledTimes(1);
    expect(mockCreateConnection).toHaveBeenCalledWith(
      'proj-1',
      expect.objectContaining({
        connectorName: 'salesforce',
        authProfileId: 'profile-active',
      }),
    );
  });

  it('passes raw_connection context to the auth profile picker', () => {
    render(<CreateConnectionModal open onClose={vi.fn()} projectId="proj-1" onCreated={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /kore smartassist/i }));

    expect(mockAuthProfilePicker).toHaveBeenCalledWith(
      expect.objectContaining({
        consumerKind: 'raw_connection',
      }),
    );
    expect(
      screen.getByText(/some auth types, such as AWS IAM signing and mTLS transport auth/i),
    ).toBeInTheDocument();
  });
});
