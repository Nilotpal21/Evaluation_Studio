/**
 * EditConnectionDialog Component Tests
 *
 * Tests the auth-profile-aware agent desktop edit flow, including provider
 * metadata updates and auth profile replacement when the auth type changes.
 */

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockCreateAuthProfile = vi.fn();
const mockDeleteAuthProfile = vi.fn();
const mockFetchAuthProfile = vi.fn();
const mockUpdateAuthProfile = vi.fn();

vi.mock('../api/auth-profiles', () => ({
  createAuthProfile: (...args: unknown[]) => mockCreateAuthProfile(...args),
  deleteAuthProfile: (...args: unknown[]) => mockDeleteAuthProfile(...args),
  fetchAuthProfile: (...args: unknown[]) => mockFetchAuthProfile(...args),
  updateAuthProfile: (...args: unknown[]) => mockUpdateAuthProfile(...args),
  // ABLP-1123: stub auth-profile-page surface so mock-export-drift stays green.
  // These exports are pulled in transitively by AuthProfilesPage /
  // DeleteProfileConfirm / RevokeProfileConfirm / useAuthProfiles but never
  // invoked from this test's render tree.
  deleteWorkspaceAuthProfile: vi.fn(),
  revokeWorkspaceAuthProfile: vi.fn(),
  fetchIntegrationProviders: vi.fn(),
  fetchWorkspaceIntegrationProviders: vi.fn(),
  fetchWorkspaceAuthProfiles: vi.fn(),
  // ABLP-1123 lifecycle UI: AuthProfileImpactModal pulls the consumer
  // fetchers; AuthProfilesPage pulls the workspace update for disable.
  fetchAuthProfileConsumers: vi.fn(),
  fetchWorkspaceAuthProfileConsumers: vi.fn(),
  updateWorkspaceAuthProfile: vi.fn(),
}));

const mockGetConnection = vi.fn();
const mockUpdateConnection = vi.fn();

vi.mock('../api/connections', () => ({
  getConnection: (...args: unknown[]) => mockGetConnection(...args),
  updateConnection: (...args: unknown[]) => mockUpdateConnection(...args),
}));

const smartassistProvider = {
  id: 'smartassist',
  label: 'SmartAssist',
  Icon: () => null,
  fields: [
    { key: 'baseUrl', label: 'Base URL', required: true, type: 'url' as const },
    { key: 'apiKey', label: 'API Key', required: false, type: 'password' as const },
    { key: 'appId', label: 'App ID', required: true, type: 'text' as const },
    { key: 'orgId', label: 'Organization ID', required: false, type: 'text' as const },
  ],
};

const mockGetProviderDef = vi.fn();

vi.mock('../components/connections/agent-desktop-registry', () => ({
  getProviderDef: (...args: unknown[]) => mockGetProviderDef(...args),
}));

vi.mock('../lib/sanitize-error', () => ({
  sanitizeError: () => 'Something went wrong',
}));

vi.mock('../components/ui/Dialog', () => ({
  Dialog: ({
    children,
    onClose,
    open,
  }: {
    children: React.ReactNode;
    onClose: () => void;
    open: boolean;
  }) => {
    if (!open) return null;
    return (
      <div data-testid="dialog">
        <button aria-label="Close dialog" onClick={onClose} type="button">
          Close
        </button>
        {children}
      </div>
    );
  },
}));

vi.mock('../components/ui/Button', () => ({
  Button: ({
    children,
    disabled,
    loading,
    onClick,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    loading?: boolean;
    onClick?: () => void;
  }) => (
    <button
      data-loading={loading ? 'true' : undefined}
      disabled={disabled || loading}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  ),
}));

vi.mock('../components/ui/Input', () => ({
  Input: ({
    label,
    onChange,
    placeholder,
    type,
    value,
  }: {
    label?: string;
    onChange?: (event: React.ChangeEvent<HTMLInputElement>) => void;
    placeholder?: string;
    type?: string;
    value?: string;
  }) => (
    <div>
      {label && <label>{label}</label>}
      <input
        aria-label={label}
        onChange={onChange}
        placeholder={placeholder}
        type={type}
        value={value ?? ''}
      />
    </div>
  ),
}));

import { EditConnectionDialog } from '../components/connections/EditConnectionDialog';

const defaultProps = {
  open: true,
  onClose: vi.fn(),
  onSaved: vi.fn(),
  projectId: 'proj-1',
  connectionId: 'conn-1',
  providerId: 'smartassist',
};

function mockLoadedSmartAssistConnection() {
  mockGetConnection.mockResolvedValue({
    success: true,
    data: {
      id: 'conn-1',
      connectorName: 'smartassist',
      displayName: 'Existing SmartAssist',
      scope: 'tenant',
      authProfileId: 'ap-1',
      metadata: {
        baseUrl: 'https://smartassist.example.com',
        appId: 'app-123',
        orgId: 'org-1',
      },
      status: 'active',
      createdAt: '2026-04-14T00:00:00.000Z',
      updatedAt: '2026-04-14T00:00:00.000Z',
    },
  });
}

describe('EditConnectionDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProviderDef.mockImplementation((providerId: string) =>
      providerId === 'smartassist' ? smartassistProvider : null,
    );
    mockLoadedSmartAssistConnection();
    mockFetchAuthProfile.mockResolvedValue({
      success: true,
      data: {
        id: 'ap-1',
        name: 'Existing SmartAssist Credentials',
        authType: 'api_key',
        config: {
          headerName: 'X-API-Key',
          placement: 'header',
        },
        redactedSecrets: {
          apiKey: '[REDACTED]',
        },
      },
    });
    mockCreateAuthProfile.mockResolvedValue({
      success: true,
      data: { id: 'ap-2' },
    });
    mockDeleteAuthProfile.mockResolvedValue({ success: true });
    mockUpdateAuthProfile.mockResolvedValue({ success: true, data: {} });
    mockUpdateConnection.mockResolvedValue({ success: true, data: {} });
  });

  it('renders nothing when provider not found', () => {
    mockGetProviderDef.mockReturnValue(null);

    const { container } = render(<EditConnectionDialog {...defaultProps} providerId="unknown" />);

    expect(container.innerHTML).toBe('');
  });

  it('loads and renders the existing provider metadata', async () => {
    render(<EditConnectionDialog {...defaultProps} />);

    expect(screen.getByText('Loading connection...')).toBeInTheDocument();

    await waitFor(() => {
      expect(mockGetConnection).toHaveBeenCalledWith('proj-1', 'conn-1');
    });

    expect(screen.getByText('Edit SmartAssist Connection')).toBeInTheDocument();
    expect(screen.getByLabelText('Display Name')).toHaveValue('Existing SmartAssist');
    expect(screen.getByLabelText('Base URL')).toHaveValue('https://smartassist.example.com');
    expect(screen.getByLabelText('App ID')).toHaveValue('app-123');
    expect(screen.getByLabelText('Organization ID (optional)')).toHaveValue('org-1');
    expect(screen.getByLabelText('API Key (optional)')).toHaveValue('');
  });

  it('updates the linked auth profile and connection metadata when auth type is unchanged', async () => {
    const onClose = vi.fn();
    const onSaved = vi.fn();

    render(<EditConnectionDialog {...defaultProps} onClose={onClose} onSaved={onSaved} />);

    await waitFor(() => {
      expect(screen.getByLabelText('Display Name')).toHaveValue('Existing SmartAssist');
    });

    fireEvent.change(screen.getByLabelText('Display Name'), {
      target: { value: 'Updated SmartAssist' },
    });
    fireEvent.change(screen.getByLabelText('Base URL'), {
      target: { value: 'https://updated.smartassist.example.com' },
    });
    fireEvent.click(screen.getByText('Save Changes'));

    await waitFor(() => {
      expect(mockUpdateAuthProfile).toHaveBeenCalledWith(
        'proj-1',
        'ap-1',
        expect.objectContaining({
          name: 'Updated SmartAssist Credentials',
          config: {
            headerName: 'X-API-Key',
            placement: 'header',
          },
          connector: 'smartassist',
          category: 'agent_desktop',
        }),
      );
    });

    expect(mockUpdateConnection).toHaveBeenCalledWith('proj-1', 'conn-1', {
      displayName: 'Updated SmartAssist',
      authProfileId: 'ap-1',
      metadata: {
        baseUrl: 'https://updated.smartassist.example.com',
        appId: 'app-123',
        orgId: 'org-1',
      },
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('creates a replacement auth profile when the provider auth type changes', async () => {
    mockFetchAuthProfile.mockResolvedValueOnce({
      success: true,
      data: {
        id: 'ap-1',
        name: 'Existing SmartAssist Credentials',
        authType: 'none',
        config: {},
        redactedSecrets: {},
      },
    });

    render(<EditConnectionDialog {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByLabelText('Display Name')).toHaveValue('Existing SmartAssist');
    });

    fireEvent.change(screen.getByLabelText('API Key (optional)'), {
      target: { value: 'new-api-key' },
    });
    fireEvent.click(screen.getByText('Save Changes'));

    await waitFor(() => {
      expect(mockCreateAuthProfile).toHaveBeenCalledWith(
        'proj-1',
        expect.objectContaining({
          name: 'Existing SmartAssist Credentials',
          authType: 'api_key',
          config: {
            headerName: 'X-API-Key',
            placement: 'header',
          },
          secrets: {
            apiKey: 'new-api-key',
          },
          connector: 'smartassist',
          category: 'agent_desktop',
        }),
      );
    });

    expect(mockUpdateAuthProfile).not.toHaveBeenCalled();
    expect(mockUpdateConnection).toHaveBeenCalledWith('proj-1', 'conn-1', {
      displayName: 'Existing SmartAssist',
      authProfileId: 'ap-2',
      metadata: {
        baseUrl: 'https://smartassist.example.com',
        appId: 'app-123',
        orgId: 'org-1',
      },
    });
  });

  it('cleans up a replacement auth profile when the connection update fails', async () => {
    mockFetchAuthProfile.mockResolvedValueOnce({
      success: true,
      data: {
        id: 'ap-1',
        name: 'Existing SmartAssist Credentials',
        authType: 'none',
        config: {},
        redactedSecrets: {},
      },
    });
    mockUpdateConnection.mockRejectedValueOnce(new Error('Update failed'));

    render(<EditConnectionDialog {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByLabelText('Display Name')).toHaveValue('Existing SmartAssist');
    });

    fireEvent.change(screen.getByLabelText('API Key (optional)'), {
      target: { value: 'new-api-key' },
    });
    fireEvent.click(screen.getByText('Save Changes'));

    await waitFor(() => {
      expect(mockDeleteAuthProfile).toHaveBeenCalledWith('proj-1', 'ap-2');
    });
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });
});
