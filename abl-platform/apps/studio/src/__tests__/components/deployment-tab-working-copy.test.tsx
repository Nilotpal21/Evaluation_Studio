import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFetchDeployments = vi.fn();
const mockUpdateChannel = vi.fn();
const mockUpdateConnection = vi.fn();
const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();

vi.mock('../../api/deployments', () => ({
  fetchDeployments: (...args: unknown[]) => mockFetchDeployments(...args),
}));

vi.mock('../../api/channels', () => ({
  updateChannel: (...args: unknown[]) => mockUpdateChannel(...args),
}));

vi.mock('../../api/channel-connections', () => ({
  updateConnection: (...args: unknown[]) => mockUpdateConnection(...args),
}));

vi.mock('../../lib/sanitize-error', () => ({
  sanitizeError: (err: unknown, fallback: string) =>
    err instanceof Error && err.message ? err.message : fallback,
}));

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

vi.mock('../../components/ui/Select', () => ({
  Select: ({ label, value, onChange, options }: any) => (
    <label>
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option: any) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  ),
}));

vi.mock('../../components/ui/Button', () => ({
  Button: ({ children, onClick, loading, disabled, ...props }: any) => (
    <button onClick={onClick} disabled={disabled || loading} {...props}>
      {children}
    </button>
  ),
}));

vi.mock('../../components/ui/Badge', () => ({
  Badge: ({ children }: any) => <span>{children}</span>,
}));

vi.mock('../../components/ui/Checkbox', () => ({
  Checkbox: ({ label, checked, onChange }: any) => (
    <label>
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  ),
}));

import { DeploymentTab } from '../../components/deployments/channels/tabs/DeploymentTab';
import type {
  ChannelInstance,
  ChannelTabProps,
  ChannelTypeDef,
} from '../../components/deployments/channels/types';

const channelDef: ChannelTypeDef = {
  id: 'voice_pipeline',
  name: 'Voice Pipeline',
  description: 'Voice channel',
  icon: null,
  available: true,
  category: 'voice',
  capabilities: {
    multiConnection: false,
    hasCredentials: true,
    hasWebhookUrl: false,
    supportsTest: false,
    supportsDeliveryLog: false,
    autoGenerateIdentifier: false,
    supportsPauseResume: false,
  },
  credentialFields: [],
  setupInstructions: null,
  webhookPath: null,
  externalIdentifierLabel: 'Phone number',
  externalIdentifierPlaceholder: '+15551230000',
};

function makeInstance(overrides: Partial<ChannelInstance> = {}): ChannelInstance {
  return {
    id: 'instance-1',
    channelType: 'voice_pipeline',
    displayName: 'Support Voice',
    status: 'active',
    environment: 'dev',
    deploymentId: 'dep-dev',
    followEnvironment: true,
    externalIdentifier: '+15551230000',
    hasCredentials: true,
    config: {},
    createdAt: '2026-04-21T12:00:00.000Z',
    updatedAt: '2026-04-21T12:00:00.000Z',
    _source: 'sdk_channel',
    _sourceId: 'source-1',
    ...overrides,
  };
}

function renderDeploymentTab(instance: ChannelInstance, onRefresh = vi.fn()) {
  const props: ChannelTabProps = {
    projectId: 'proj-1',
    channelType: instance.channelType,
    channelDef,
    instance,
    onRefresh,
  };
  return render(<DeploymentTab {...props} />);
}

describe('DeploymentTab working copy handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchDeployments.mockResolvedValue({
      deployments: [
        {
          id: 'dep-dev',
          status: 'active',
          environment: 'dev',
          createdAt: '2026-04-21T10:00:00.000Z',
          label: 'Dev Build',
          endpointSlug: 'dev-build',
        },
      ],
    });
    mockUpdateChannel.mockResolvedValue({ success: true });
    mockUpdateConnection.mockResolvedValue({ success: true });
  });

  it('clears the pinned SDK deployment when switching to working copy', async () => {
    const onRefresh = vi.fn();

    renderDeploymentTab(
      makeInstance({
        _source: 'sdk_channel',
        deploymentId: 'dep-dev',
        environment: 'dev',
        followEnvironment: true,
      }),
      onRefresh,
    );

    await waitFor(() => expect(mockFetchDeployments).toHaveBeenCalledWith('proj-1'));

    fireEvent.change(screen.getByLabelText('Pin to deployment'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Environment'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() =>
      expect(mockUpdateChannel).toHaveBeenCalledWith('proj-1', 'source-1', {
        deploymentId: null,
        environment: null,
        followEnvironment: false,
      }),
    );
    expect(onRefresh).toHaveBeenCalled();
  });

  it('clears the pinned channel connection deployment when switching to working copy', async () => {
    renderDeploymentTab(
      makeInstance({
        _source: 'channel_connection',
        deploymentId: 'dep-dev',
        environment: 'dev',
      }),
    );

    await waitFor(() => expect(mockFetchDeployments).toHaveBeenCalledWith('proj-1'));

    fireEvent.change(screen.getByLabelText('Pin to deployment'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Environment'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() =>
      expect(mockUpdateConnection).toHaveBeenCalledWith('proj-1', 'source-1', {
        deployment_id: null,
        environment: null,
      }),
    );
  });

  it('syncs its local binding state from refreshed instance props', async () => {
    const { rerender } = renderDeploymentTab(
      makeInstance({
        deploymentId: null,
        environment: 'dev',
        followEnvironment: true,
      }),
    );

    expect(screen.getByLabelText('Environment')).toHaveValue('dev');

    rerender(
      <DeploymentTab
        projectId="proj-1"
        channelType="voice_pipeline"
        channelDef={channelDef}
        instance={makeInstance({
          deploymentId: null,
          environment: null,
          followEnvironment: false,
          updatedAt: '2026-04-22T09:30:00.000Z',
        })}
        onRefresh={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByLabelText('Environment')).toHaveValue(''));
    expect(screen.getAllByText('Working Copy (draft)').length).toBeGreaterThan(0);
  });
});
