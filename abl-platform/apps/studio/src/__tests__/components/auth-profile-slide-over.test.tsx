import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AuthProfileSlideOver } from '@/components/auth-profiles/AuthProfileSlideOver';

const mockCreateAuthProfile = vi.fn();
const mockUpdateAuthProfile = vi.fn();
const mockCreateWorkspaceAuthProfile = vi.fn();
const mockInitiateOAuth = vi.fn();
const mockInitiateWorkspaceOAuth = vi.fn();
const mockHandleOAuthProfileCallback = vi.fn();
const mockHandleWorkspaceOAuthProfileCallback = vi.fn();
const mockAuthProfileState = {
  profile: null as Record<string, unknown> | null,
  isLoading: false,
  error: null as string | null,
  refresh: vi.fn(),
};

vi.mock('@/hooks/useAuthProfiles', () => ({
  useAuthProfile: () => mockAuthProfileState,
}));

vi.mock('@/api/auth-profiles', () => ({
  createAuthProfile: (...args: unknown[]) => mockCreateAuthProfile(...args),
  updateAuthProfile: (...args: unknown[]) => mockUpdateAuthProfile(...args),
  validateAuthProfile: vi.fn(),
  createWorkspaceAuthProfile: (...args: unknown[]) => mockCreateWorkspaceAuthProfile(...args),
  updateWorkspaceAuthProfile: vi.fn(),
  validateWorkspaceAuthProfile: vi.fn(),
  fetchWorkspaceAuthProfile: vi.fn(),
  initiateOAuth: (...args: unknown[]) => mockInitiateOAuth(...args),
  initiateWorkspaceOAuth: (...args: unknown[]) => mockInitiateWorkspaceOAuth(...args),
  handleOAuthProfileCallback: (...args: unknown[]) => mockHandleOAuthProfileCallback(...args),
  handleWorkspaceOAuthProfileCallback: (...args: unknown[]) =>
    mockHandleWorkspaceOAuthProfileCallback(...args),
}));

vi.mock('@/lib/connection-config-utils', () => ({
  resolveConnectionConfigTemplate: vi.fn((url: string) => url),
  extractConnectionConfigFields: vi.fn(() => []),
}));

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe('AuthProfileSlideOver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
    mockAuthProfileState.profile = null;
    mockAuthProfileState.isLoading = false;
    mockAuthProfileState.error = null;
    mockCreateAuthProfile.mockResolvedValue({
      success: true,
      data: {
        id: 'profile-1',
      },
    });
    mockUpdateAuthProfile.mockResolvedValue({
      success: true,
      data: {
        id: 'profile-1',
      },
    });
    mockCreateWorkspaceAuthProfile.mockResolvedValue({
      success: true,
      data: {
        id: 'ws-profile-1',
      },
    });
    mockInitiateOAuth.mockResolvedValue({
      success: true,
      data: {
        authUrl: 'https://oauth.example.com/authorize?state=test-state',
        state: 'test-state',
      },
    });
    mockInitiateWorkspaceOAuth.mockResolvedValue({
      success: true,
      data: {
        authUrl: 'https://oauth.example.com/authorize?state=test-state',
        state: 'test-state',
      },
    });
    mockHandleOAuthProfileCallback.mockResolvedValue({
      success: true,
      data: { id: 'grant-1' },
    });
    mockHandleWorkspaceOAuthProfileCallback.mockResolvedValue({
      success: true,
      data: { id: 'grant-1' },
    });
  });

  it('includes api_key prefix in the create payload', async () => {
    const onSaved = vi.fn();

    render(
      <AuthProfileSlideOver
        open
        onClose={vi.fn()}
        onSaved={onSaved}
        projectId="proj-1"
        editProfileId={null}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /API Key/i }));

    fireEvent.change(screen.getByPlaceholderText('e.g. API Key - Production'), {
      target: { value: 'Partner API' },
    });
    fireEvent.change(screen.getByLabelText(/Prefix/i), {
      target: { value: 'Token ' },
    });
    fireEvent.change(screen.getByPlaceholderText('Enter your API key'), {
      target: { value: 'sk-test-123' },
    });

    fireEvent.click(screen.getByRole('button', { name: /create profile/i }));

    await waitFor(() =>
      expect(mockCreateAuthProfile).toHaveBeenCalledWith(
        'proj-1',
        expect.objectContaining({
          name: 'Partner API',
          authType: 'api_key',
          usageMode: 'preconfigured',
          config: expect.objectContaining({
            headerName: 'X-API-Key',
            placement: 'header',
            prefix: 'Token ',
          }),
          secrets: {
            apiKey: 'sk-test-123',
          },
        }),
      ),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it('keeps tokenUrl in oauth2_client_credentials create payload', async () => {
    const onSaved = vi.fn();

    render(
      <AuthProfileSlideOver
        open
        onClose={vi.fn()}
        onSaved={onSaved}
        projectId="proj-1"
        editProfileId={null}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Client Credentials/i }));

    fireEvent.change(screen.getByPlaceholderText('e.g. Client Credentials - Production'), {
      target: { value: 'Auth0 CC Profile' },
    });
    fireEvent.change(screen.getByLabelText(/Token URL/i), {
      target: { value: 'https://example.us.auth0.com/oauth/token' },
    });
    fireEvent.change(screen.getByLabelText(/Audience/i), {
      target: { value: 'https://example.us.auth0.com/api/v2/' },
    });
    fireEvent.change(screen.getByPlaceholderText('Enter client ID'), {
      target: { value: 'client-id' },
    });
    fireEvent.change(screen.getByPlaceholderText('Enter client secret'), {
      target: { value: 'client-secret' },
    });

    fireEvent.click(screen.getByRole('button', { name: /create profile/i }));

    await waitFor(() => expect(mockCreateAuthProfile).toHaveBeenCalledTimes(1));

    expect(mockCreateAuthProfile).toHaveBeenCalledWith(
      'proj-1',
      expect.objectContaining({
        authType: 'oauth2_client_credentials',
        config: expect.objectContaining({
          tokenUrl: 'https://example.us.auth0.com/oauth/token',
          audience: 'https://example.us.auth0.com/api/v2/',
        }),
      }),
    );

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it('shows required and optional indicators on custom auth profile fields', async () => {
    render(
      <AuthProfileSlideOver
        open
        onClose={vi.fn()}
        onSaved={vi.fn()}
        projectId="proj-1"
        editProfileId={null}
        preselectedAuthType="oauth2_client_credentials"
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByPlaceholderText('e.g. Client Credentials - Production'),
      ).toBeInTheDocument();
    });

    const profileNameLabel = screen.getByText('Profile Name').closest('label');
    const descriptionLabel = screen.getByText('Description').closest('label');
    const tokenUrlLabel = screen.getByText('Token URL').closest('label');
    const audienceLabel = screen.getByText('Audience').closest('label');
    const clientSecretLabel = screen.getByText('Client Secret').closest('label');

    expect(profileNameLabel).toHaveTextContent('*');
    expect(descriptionLabel).toHaveTextContent('(Optional)');
    expect(tokenUrlLabel).toHaveTextContent('*');
    expect(audienceLabel).toHaveTextContent('(Optional)');
    expect(clientSecretLabel).toHaveTextContent('*');
  });

  it('treats preselected oauth2_token create flows as legacy read-only', async () => {
    render(
      <AuthProfileSlideOver
        open
        onClose={vi.fn()}
        onSaved={vi.fn()}
        projectId="proj-1"
        editProfileId={null}
        preselectedAuthType="oauth2_token"
      />,
    );

    expect(screen.getByText('Legacy OAuth token record')).toBeInTheDocument();
    expect(
      screen.getByText(/oauth2_token profiles can no longer be created manually/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create profile/i })).toBeDisabled();
    expect(mockCreateAuthProfile).not.toHaveBeenCalled();
  });

  it('loads legacy oauth2_token profiles as read-only migration records', async () => {
    mockAuthProfileState.profile = {
      id: 'token-profile-1',
      name: 'GitHub User Token',
      description: 'Existing token profile',
      authType: 'oauth2_token',
      status: 'active',
      environment: null,
      visibility: 'shared',
      usageMode: 'user_token',
      scope: 'project',
      inherited: false,
      linkedConsumerCount: 0,
      lastUsedAt: null,
      createdAt: '2026-04-03T00:00:00.000Z',
      updatedAt: '2026-04-03T00:00:00.000Z',
      createdBy: 'user-1',
      config: {
        provider: 'github',
        tokenType: 'bearer',
      },
      redactedSecrets: {
        accessToken: '••••••1234',
      },
      linkedAppProfileId: 'app-profile-old',
      migration: {
        status: 'legacy_read_only',
        message:
          'Legacy oauth2_token profiles are migration records and cannot be edited, revoked, deleted, or validated. Re-authorize the linked OAuth app instead.',
        replacementAuthProfileId: 'app-profile-old',
        replacementAuthType: 'oauth2_app',
      },
    };

    render(
      <AuthProfileSlideOver
        open
        onClose={vi.fn()}
        onSaved={vi.fn()}
        projectId="proj-1"
        editProfileId="token-profile-1"
      />,
    );

    await waitFor(() => expect(screen.getByLabelText(/Provider/i)).toHaveValue('github'));
    expect(screen.getByLabelText(/OAuth App Profile/i)).toHaveValue('app-profile-old');
    expect(screen.getByText('Legacy OAuth token record')).toBeInTheDocument();
    expect(
      screen.getByText(/cannot be edited, revoked, deleted, or validated/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Provider/i)).toBeDisabled();
    expect(screen.getByLabelText(/OAuth App Profile/i)).toBeDisabled();
    expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
    // ABLP-1123: footer Test button is hidden for OAuth profiles entirely
    // (Authorize / Re-authorize IS the credential test for OAuth) — the
    // legacy "Verify Token" label was retired with the slide-over revamp.
    expect(screen.queryByRole('button', { name: /test credentials/i })).not.toBeInTheDocument();
    expect(mockUpdateAuthProfile).not.toHaveBeenCalled();
  });

  it('lets oauth2_app create flows choose preflight mode', async () => {
    const onSaved = vi.fn();

    render(
      <AuthProfileSlideOver
        open
        onClose={vi.fn()}
        onSaved={onSaved}
        projectId="proj-1"
        editProfileId={null}
        preselectedAuthType="oauth2_app"
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('e.g. OAuth 2.0 App - Production'), {
      target: { value: 'Google Preflight App' },
    });
    fireEvent.click(screen.getByLabelText(/Usage Mode/i));
    fireEvent.click(screen.getByRole('option', { name: 'Preflight' }));
    fireEvent.change(screen.getByLabelText(/Authorization URL/i), {
      target: { value: 'https://accounts.google.com/o/oauth2/auth' },
    });
    fireEvent.change(screen.getByLabelText(/Token URL/i), {
      target: { value: 'https://oauth2.googleapis.com/token' },
    });
    fireEvent.change(screen.getByPlaceholderText('Enter client ID'), {
      target: { value: 'client-id' },
    });
    fireEvent.change(screen.getByPlaceholderText('Enter client secret'), {
      target: { value: 'client-secret' },
    });

    fireEvent.click(screen.getByRole('button', { name: /create profile/i }));

    await waitFor(() => expect(mockCreateAuthProfile).toHaveBeenCalledTimes(1));

    const payload = mockCreateAuthProfile.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload.usageMode).toBe('preflight');
    await waitFor(() => expect(screen.getByText('Authorize Access')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /close dialog/i }));
    await waitFor(() => expect(screen.queryByText('Authorize Access')).not.toBeInTheDocument());
    // ABLP-1123: the slide-over footer no longer has a Cancel button — the
    // OAuth dialog's onClose already fires onSaved (line 2630 in slide-over),
    // so the redundant Cancel click was removed.
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it('captures Additional Authorization Parameters as key-value rows in oauth2_app payload', async () => {
    const onSaved = vi.fn();

    render(
      <AuthProfileSlideOver
        open
        onClose={vi.fn()}
        onSaved={onSaved}
        projectId="proj-1"
        editProfileId={null}
        preselectedAuthType="oauth2_app"
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('e.g. OAuth 2.0 App - Production'), {
      target: { value: 'Google OAuth App' },
    });
    fireEvent.change(screen.getByLabelText(/Authorization URL/i), {
      target: { value: 'https://accounts.google.com/o/oauth2/auth' },
    });
    fireEvent.change(screen.getByLabelText(/Token URL/i), {
      target: { value: 'https://oauth2.googleapis.com/token' },
    });
    fireEvent.change(screen.getByPlaceholderText('Enter client ID'), {
      target: { value: 'client-id' },
    });
    fireEvent.change(screen.getByPlaceholderText('Enter client secret'), {
      target: { value: 'client-secret' },
    });

    fireEvent.click(screen.getByRole('button', { name: /plus add/i }));
    const firstKeyInput = screen.getAllByPlaceholderText('key')[0];
    fireEvent.change(firstKeyInput, { target: { value: 'access_type' } });
    const firstValueInput = screen.getAllByPlaceholderText('value')[0];
    fireEvent.change(firstValueInput, { target: { value: 'offline' } });

    fireEvent.click(screen.getByRole('button', { name: /plus add/i }));
    const keyInputs = screen.getAllByPlaceholderText('key');
    fireEvent.change(keyInputs[1], { target: { value: 'prompt' } });
    const valueInputs = screen.getAllByPlaceholderText('value');
    fireEvent.change(valueInputs[1], { target: { value: 'consent' } });

    fireEvent.click(screen.getByRole('button', { name: /create profile/i }));

    await waitFor(() => expect(mockCreateAuthProfile).toHaveBeenCalledTimes(1));

    const payload = mockCreateAuthProfile.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload.config).toEqual(
      expect.objectContaining({
        authorizationParams: {
          access_type: 'offline',
          prompt: 'consent',
        },
      }),
    );
    await waitFor(() => expect(screen.getByText('Authorize Access')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /close dialog/i }));
    await waitFor(() => expect(screen.queryByText('Authorize Access')).not.toBeInTheDocument());
    // ABLP-1123: the slide-over footer no longer has a Cancel button — the
    // OAuth dialog's onClose already fires onSaved (line 2630 in slide-over),
    // so the redundant Cancel click was removed.
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  describe('integration auth profile features', () => {
    it('shows Authorize action for active oauth2_app edit profiles', async () => {
      mockAuthProfileState.profile = {
        id: 'oauth-app-1',
        name: 'Google OAuth App',
        description: 'Shared OAuth app',
        authType: 'oauth2_app',
        status: 'active',
        environment: null,
        visibility: 'shared',
        connectionMode: 'shared',
        usageMode: 'preconfigured',
        scope: 'project',
        inherited: false,
        linkedConsumerCount: 0,
        lastUsedAt: null,
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:00:00.000Z',
        createdBy: 'user-1',
        config: {
          authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
          tokenUrl: 'https://oauth2.googleapis.com/token',
        },
        redactedSecrets: {
          clientId: '••••••.apps.googleusercontent.com',
          clientSecret: '••••••',
        },
        connector: '',
      };

      render(
        <AuthProfileSlideOver
          open
          onClose={vi.fn()}
          onSaved={vi.fn()}
          projectId="proj-1"
          editProfileId="oauth-app-1"
        />,
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /authorize/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /authorize/i }));

      await waitFor(() => {
        expect(screen.getByText('Authorize Access')).toBeInTheDocument();
      });
    });

    it('shows Authorize action for pending_authorization oauth2_app edit profiles', async () => {
      mockAuthProfileState.profile = {
        id: 'oauth-app-2',
        name: 'Google OAuth App Pending',
        description: 'Pending OAuth app',
        authType: 'oauth2_app',
        status: 'pending_authorization',
        environment: null,
        visibility: 'shared',
        connectionMode: 'shared',
        usageMode: 'preconfigured',
        scope: 'project',
        inherited: false,
        linkedConsumerCount: 0,
        lastUsedAt: null,
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:00:00.000Z',
        createdBy: 'user-1',
        config: {
          authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
          tokenUrl: 'https://oauth2.googleapis.com/token',
        },
        redactedSecrets: {
          clientId: '••••••.apps.googleusercontent.com',
          clientSecret: '••••••',
        },
        connector: '',
      };

      render(
        <AuthProfileSlideOver
          open
          onClose={vi.fn()}
          onSaved={vi.fn()}
          projectId="proj-1"
          editProfileId="oauth-app-2"
        />,
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /authorize/i })).toBeInTheDocument();
      });
    });

    it('UT-4: pre-fills oauth2 fields from preselectedConnector and sets connector in payload', async () => {
      const onSaved = vi.fn();

      render(
        <AuthProfileSlideOver
          open
          onClose={vi.fn()}
          onSaved={onSaved}
          projectId="proj-1"
          editProfileId={null}
          preselectedConnector={{
            connectorName: 'google-drive',
            displayName: 'Google Drive',
            availableAuthTypes: ['oauth2'],
            oauth2: {
              authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
              tokenUrl: 'https://oauth2.googleapis.com/token',
              defaultScopes: ['drive.readonly'],
              pkce: false,
            },
          }}
        />,
      );

      // Should skip type selection and go directly to the form with oauth2_app inferred.
      // Verify pre-filled values are visible in the form inputs.
      await waitFor(() => {
        expect(screen.getByLabelText(/Authorization URL/i)).toHaveValue(
          'https://accounts.google.com/o/oauth2/auth',
        );
      });
      expect(screen.getByLabelText(/Token URL/i)).toHaveValue(
        'https://oauth2.googleapis.com/token',
      );

      // Fill required fields to submit
      fireEvent.change(screen.getByPlaceholderText('e.g. OAuth 2.0 App - Production'), {
        target: { value: 'Google Drive OAuth' },
      });
      fireEvent.change(screen.getByPlaceholderText('Enter client ID'), {
        target: { value: 'gd-client-id' },
      });
      fireEvent.change(screen.getByPlaceholderText('Enter client secret'), {
        target: { value: 'gd-client-secret' },
      });

      fireEvent.click(screen.getByRole('button', { name: /create profile/i }));

      await waitFor(() => expect(mockCreateAuthProfile).toHaveBeenCalledTimes(1));

      const payload = mockCreateAuthProfile.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(payload.authType).toBe('oauth2_app');
      expect(payload.connector).toBe('google-drive');
      expect(payload.config).toEqual(
        expect.objectContaining({
          authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
          tokenUrl: 'https://oauth2.googleapis.com/token',
        }),
      );
      await waitFor(() => expect(screen.getByText('Authorize Access')).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: /close dialog/i }));
      await waitFor(() => expect(screen.queryByText('Authorize Access')).not.toBeInTheDocument());
      // ABLP-1123: the slide-over footer no longer has a Cancel button — the
      // OAuth dialog's onClose already fires onSaved (line 2630 in slide-over),
      // so the redundant Cancel click was removed.
      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    });

    it('UT-4a: maps oauth2 client_credentials connectors to client-credentials auth type', async () => {
      const onSaved = vi.fn();

      render(
        <AuthProfileSlideOver
          open
          onClose={vi.fn()}
          onSaved={onSaved}
          projectId="proj-1"
          editProfileId={null}
          preselectedConnector={{
            connectorName: 'auth0-management',
            displayName: 'Auth0 Management API',
            availableAuthTypes: ['oauth2_client_credentials'],
            oauth2: {
              authorizationUrl: '',
              tokenUrl: 'https://example.us.auth0.com/oauth/token',
              defaultScopes: ['read:users'],
              pkce: false,
              tokenParams: {
                grant_type: 'client_credentials',
                audience: 'https://example.us.auth0.com/api/v2/',
              },
            },
          }}
        />,
      );

      await waitFor(() => {
        expect(
          screen.getByPlaceholderText('e.g. Client Credentials - Production'),
        ).toBeInTheDocument();
      });

      expect(screen.queryByLabelText('Authorization URL')).not.toBeInTheDocument();
      expect(screen.queryByText('Authorized Redirect URI')).not.toBeInTheDocument();
      expect(screen.getByLabelText(/Token URL/i)).toHaveValue(
        'https://example.us.auth0.com/oauth/token',
      );
      expect(screen.getByLabelText(/Audience/i)).toHaveValue(
        'https://example.us.auth0.com/api/v2/',
      );

      fireEvent.change(screen.getByPlaceholderText('e.g. Client Credentials - Production'), {
        target: { value: 'Auth0 M2M' },
      });
      fireEvent.change(screen.getByPlaceholderText('Enter client ID'), {
        target: { value: 'auth0-client-id' },
      });
      fireEvent.change(screen.getByPlaceholderText('Enter client secret'), {
        target: { value: 'auth0-client-secret' },
      });

      fireEvent.click(screen.getByRole('button', { name: /create profile/i }));

      await waitFor(() => expect(mockCreateAuthProfile).toHaveBeenCalledTimes(1));

      const payload = mockCreateAuthProfile.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(payload.authType).toBe('oauth2_client_credentials');
      expect(payload.connector).toBe('auth0-management');
      expect(payload.config).toEqual(
        expect.objectContaining({
          tokenUrl: 'https://example.us.auth0.com/oauth/token',
          audience: 'https://example.us.auth0.com/api/v2/',
          scopes: ['read:users'],
        }),
      );
      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    });

    it('UT-4b: pre-fills api_key connector and infers api_key authType', async () => {
      const onSaved = vi.fn();

      render(
        <AuthProfileSlideOver
          open
          onClose={vi.fn()}
          onSaved={onSaved}
          projectId="proj-1"
          editProfileId={null}
          preselectedConnector={{
            connectorName: 'sendgrid',
            displayName: 'SendGrid',
            availableAuthTypes: ['api_key'],
          }}
        />,
      );

      // Should go directly to the api_key form
      await waitFor(() => {
        expect(screen.getByPlaceholderText('e.g. API Key - Production')).toBeInTheDocument();
      });

      fireEvent.change(screen.getByPlaceholderText('e.g. API Key - Production'), {
        target: { value: 'SendGrid API Key' },
      });
      fireEvent.change(screen.getByPlaceholderText('Enter your API key'), {
        target: { value: 'SG.test-key-123' },
      });

      fireEvent.click(screen.getByRole('button', { name: /create profile/i }));

      await waitFor(() => expect(mockCreateAuthProfile).toHaveBeenCalledTimes(1));

      const payload = mockCreateAuthProfile.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(payload.authType).toBe('api_key');
      expect(payload.connector).toBe('sendgrid');
      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    });

    it('UT-5: renders connection config fields when connectionConfigFields is provided', async () => {
      render(
        <AuthProfileSlideOver
          open
          onClose={vi.fn()}
          onSaved={vi.fn()}
          projectId="proj-1"
          editProfileId={null}
          preselectedConnector={{
            connectorName: 'salesforce',
            displayName: 'Salesforce',
            availableAuthTypes: ['oauth2'],
            oauth2: {
              authorizationUrl:
                'https://${connectionConfig.instance}.salesforce.com/services/oauth2/authorize',
              tokenUrl: 'https://${connectionConfig.instance}.salesforce.com/services/oauth2/token',
              defaultScopes: ['api'],
              pkce: false,
              connectionConfigFields: ['instance'],
            },
          }}
        />,
      );

      // The form should render an input for the "instance" connection config field
      await waitFor(() => {
        expect(screen.getByLabelText(/instance/i)).toBeInTheDocument();
      });

      // Verify the connection config heading is shown
      expect(screen.getByText(/connection config/i)).toBeInTheDocument();

      // User can fill the connection config field
      fireEvent.change(screen.getByLabelText(/instance/i), {
        target: { value: 'mycompany' },
      });
      expect(screen.getByLabelText(/instance/i)).toHaveValue('mycompany');
    });

    it('UT-6: workspace scope excludes jit/preflight modes and shows warning', async () => {
      render(
        <AuthProfileSlideOver
          open
          onClose={vi.fn()}
          onSaved={vi.fn()}
          projectId="_workspace"
          editProfileId={null}
          preselectedAuthType="oauth2_app"
        />,
      );

      // Wait for the form to render with usage mode select
      await waitFor(() => {
        expect(screen.getByLabelText(/Usage Mode/i)).toBeInTheDocument();
      });

      // The usage mode select should be disabled because only "Preconfigured" remains
      // after filtering out jit and preflight for workspace scope (1 option = disabled).
      const usageModeSelect = screen.getByLabelText(/Usage Mode/i);
      expect(usageModeSelect).toBeDisabled();

      // Workspace warning message about JIT/Preflight should be visible
      expect(
        screen.getByText('JIT and Preflight modes require a project-scoped profile.'),
      ).toBeInTheDocument();
    });
  });
});
