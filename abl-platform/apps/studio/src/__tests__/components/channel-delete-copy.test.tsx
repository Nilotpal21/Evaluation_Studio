/**
 * Channel delete copy regressions.
 *
 * @vitest-environment happy-dom
 */

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ChannelConnectionSummary } from '../../api/channel-connections';
import type { ChannelConnection } from '../../hooks/useConnectors';

const translations: Record<string, string> = {
  'channels.instance_list.deactivate': 'Deactivate connection',
  'channels.instance_list.deactivate_dialog_title': 'Deactivate Connection',
  'channels.instance_list.deactivate_dialog_description':
    'This will deactivate "{name}". Delete it again later to remove it permanently.',
  'channels.instance_list.deactivate_confirm': 'Deactivate',
  'channels.instance_list.deactivate_success': 'Connection deactivated',
  'channels.instance_list.delete': 'Delete connection',
  'channels.instance_list.delete_dialog_title': 'Delete Connection',
  'channels.instance_list.delete_dialog_description':
    'This will permanently delete "{name}". Any integrations using this connection will stop working.',
  'channels.instance_list.delete_confirm': 'Delete',
  'channels.instance_list.delete_success': 'Connection deleted',
  'channels.instance_list.load_failed': 'Failed to load Slack connections',
  'channels.instance_list.delete_failed': 'Failed to delete connection',
  'channels.instance_list.status_active': 'Active',
  'channels.instance_list.status_inactive': 'Inactive',
  'channels.instance_list.status_paused': 'Paused',
  'channels.instance_list.status_error': 'Error',
  'channels.instance_config.deactivate': 'Deactivate channel instance',
  'channels.instance_config.deactivate_dialog_title': 'Deactivate Channel Instance',
  'channels.instance_config.deactivate_dialog_description':
    'This will deactivate "{name}". Delete it again later to remove it permanently.',
  'channels.instance_config.deactivate_confirm': 'Deactivate',
  'channels.instance_config.deactivate_success': 'Channel instance deactivated.',
  'channels.instance_config.delete': 'Delete channel instance',
  'channels.instance_config.delete_dialog_title': 'Delete Channel Instance',
  'channels.instance_config.delete_dialog_description':
    'This will permanently delete "{name}". Any integrations relying on this channel will stop working.',
  'channels.instance_config.delete_confirm': 'Delete',
  'channels.instance_config.delete_success': 'Channel instance deleted.',
  'channels.instance_config.delete_failed': 'Failed to delete channel instance.',
  'channels.instance_config.error_load_failed': 'Failed to load channel instance.',
  'channels.instance_config.error_not_found_default': 'Channel instance could not be loaded.',
  'channels.instance_config.error_not_found_title': 'Instance Not Found',
  'channels.instance_config.back_to_list': 'Back to List',
  'channels.instance_config.pause': 'Pause',
  'channels.instance_config.resume': 'Resume',
  'channels.instance_config.tab_overview': 'Overview',
  'channels.instance_config.tab_credentials': 'Credentials',
  'channels.instance_config.tab_configuration': 'Configuration',
  'channels.instance_config.tab_deployment': 'Deployment',
  'channels.instance_config.tab_testing': 'Testing',
  'channels.instance_config.tab_activity': 'Activity',
  'admin.connectors.title': 'Connectors & Channels',
  'admin.connectors.description': 'Manage channel connections and SDK channel integrations.',
  'admin.connectors.tabs.connections': 'Channel Connections',
  'admin.connectors.tabs.sdk_channels': 'SDK Channels',
  'admin.connectors.connection_count': '{count} connections',
  'admin.connectors.connections_empty_title': 'No channel connections',
  'admin.connectors.connections_empty_description':
    'Channel connections will appear here when configured.',
  'admin.connectors.connection_deactivated': 'Channel connection deactivated',
  'admin.connectors.connection_deleted': 'Channel connection deleted',
  'admin.connectors.connection_delete_failed': 'Failed to delete channel connection',
  'admin.connectors.deactivate_connection_title': 'Deactivate Channel Connection',
  'admin.connectors.deactivate_connection_description':
    'This will deactivate "{name}". Delete it again later to remove it permanently.',
  'admin.connectors.delete_connection_title': 'Delete Channel Connection',
  'admin.connectors.delete_connection_description':
    'This will permanently remove "{name}". This action cannot be undone.',
  'admin.connectors.deactivate_confirm': 'Deactivate',
  'admin.connectors.delete_confirm': 'Delete',
  'admin.connectors.add_connection_button': 'Add Connection',
  'admin.connectors.copied_to_clipboard': 'Copied to clipboard',
  'admin.connectors.created_on': 'Created on {date}',
  'admin.connectors.last_active': 'Last active {date}',
};

function interpolate(template: string, values?: Record<string, unknown>): string {
  let result = template;
  for (const [key, value] of Object.entries(values ?? {})) {
    result = result.replaceAll(`{${key}}`, String(value));
  }
  return result;
}

vi.mock('next-intl', () => ({
  useTranslations: (namespace: string) => {
    const translate = (key: string, values?: Record<string, unknown>) =>
      interpolate(translations[`${namespace}.${key}`] ?? `${namespace}.${key}`, values);
    return Object.assign(translate, {
      has: (key: string) => `${namespace}.${key}` in translations,
    });
  },
}));

vi.mock('lucide-react', () => {
  const Icon = (props: React.HTMLAttributes<HTMLSpanElement>) => <span {...props} />;
  return {
    AlertTriangle: Icon,
    ArrowLeft: Icon,
    Code: Icon,
    Copy: Icon,
    Eye: Icon,
    EyeOff: Icon,
    Link: Icon,
    Loader2: Icon,
    Pause: Icon,
    Pencil: Icon,
    Play: Icon,
    Plus: Icon,
    Plug: Icon,
    RefreshCw: Icon,
    Trash2: Icon,
    Wifi: Icon,
    WifiOff: Icon,
  };
});

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: {
    div: ({
      children,
      ...props
    }: React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }) => (
      <div {...props}>{children}</div>
    ),
  },
}));

vi.mock('../../lib/animation', () => ({
  transitions: { backdrop: {} },
}));

vi.mock('../../lib/sanitize-error', () => ({
  sanitizeError: (_error: unknown, fallback: string) => fallback,
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const mockFetchChannels = vi.fn();
const mockDeleteChannel = vi.fn();
const mockUpdateChannel = vi.fn();

vi.mock('../../api/channels', () => ({
  fetchChannels: (...args: unknown[]) => mockFetchChannels(...args),
  deleteChannel: (...args: unknown[]) => mockDeleteChannel(...args),
  updateChannel: (...args: unknown[]) => mockUpdateChannel(...args),
}));

const mockFetchConnections = vi.fn();
const mockFetchConnection = vi.fn();
const mockDeleteConnection = vi.fn();
const mockUpdateConnection = vi.fn();

vi.mock('../../api/channel-connections', () => ({
  fetchConnections: (...args: unknown[]) => mockFetchConnections(...args),
  fetchConnection: (...args: unknown[]) => mockFetchConnection(...args),
  deleteConnection: (...args: unknown[]) => mockDeleteConnection(...args),
  updateConnection: (...args: unknown[]) => mockUpdateConnection(...args),
  createConnection: vi.fn(),
}));

const mockFetchSubscriptions = vi.fn();
const mockDeleteSubscription = vi.fn();
const mockUpdateSubscription = vi.fn();
const mockNormalizeSDKChannel = vi.fn();
const mockNormalizeSubscription = vi.fn();

vi.mock('../../api/http-async-channels', () => ({
  fetchSubscriptions: (...args: unknown[]) => mockFetchSubscriptions(...args),
  deleteSubscription: (...args: unknown[]) => mockDeleteSubscription(...args),
  updateSubscription: (...args: unknown[]) => mockUpdateSubscription(...args),
  createSubscription: vi.fn(),
}));

const mockUseChannelConnections = vi.fn();
const mockUseSDKChannels = vi.fn();

vi.mock('../../hooks/useConnectors', () => ({
  useChannelConnections: () => mockUseChannelConnections(),
  useSDKChannels: () => mockUseSDKChannels(),
}));

vi.mock('../../store/project-store', () => ({
  useProjectStore: (selector?: (state: { projects: Array<Record<string, string>> }) => unknown) => {
    const state = { projects: [] as Array<Record<string, string>> };
    return selector ? selector(state) : state;
  },
}));

vi.mock('../../components/ui/Button', () => ({
  Button: ({
    children,
    icon,
    loading,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    children?: React.ReactNode;
    icon?: React.ReactNode;
    loading?: boolean;
  }) => (
    <button {...props} disabled={props.disabled || loading}>
      {icon}
      {children}
    </button>
  ),
}));

vi.mock('../../components/ui/Badge', () => ({
  Badge: ({
    children,
    ...props
  }: React.HTMLAttributes<HTMLSpanElement> & { children?: React.ReactNode }) => (
    <span {...props}>{children}</span>
  ),
}));

type MockTableRow = {
  id: string;
  displayName?: string;
};

type MockTableColumn<Row> = {
  key: string;
  render?: (row: Row) => React.ReactNode;
};

vi.mock('../../components/ui/DataTable', () => ({
  DataTable: ({
    data,
    columns,
    onRowClick,
  }: {
    data: MockTableRow[];
    columns: MockTableColumn<MockTableRow>[];
    onRowClick?: (row: MockTableRow) => void;
  }) => {
    const actionColumn = columns.find((column) => column.key === 'actions');
    return (
      <div data-testid="data-table">
        {data.map((row) => (
          <div key={row.id}>
            <button onClick={() => onRowClick?.(row)}>{row.displayName ?? row.id}</button>
            {actionColumn?.render ? actionColumn.render(row) : null}
          </div>
        ))}
      </div>
    );
  },
}));

vi.mock('../../components/ui/EmptyState', () => ({
  EmptyState: ({ title, description }: { title: string; description: string }) => (
    <div>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  ),
}));

vi.mock('../../components/ui/ConfirmDialog', () => ({
  ConfirmDialog: ({
    open,
    onClose,
    onConfirm,
    title,
    description,
    confirmLabel,
  }: {
    open: boolean;
    onClose: () => void;
    onConfirm: () => void;
    title: string;
    description: string;
    confirmLabel?: string;
  }) =>
    open ? (
      <div data-testid="confirm-dialog">
        <h2 data-testid="confirm-dialog-title">{title}</h2>
        <p data-testid="confirm-dialog-description">{description}</p>
        <button data-testid="confirm-dialog-confirm" onClick={onConfirm}>
          {confirmLabel}
        </button>
        <button data-testid="confirm-dialog-cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    ) : null,
}));

vi.mock('../../components/ui/Dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children?: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
}));

vi.mock('../../components/ui/Input', () => ({
  Input: ({
    label,
    ...props
  }: React.InputHTMLAttributes<HTMLInputElement> & { label?: string }) => (
    <input aria-label={label} {...props} />
  ),
}));

vi.mock('../../components/ui/Select', () => ({
  Select: ({
    label,
    options,
    value,
    onChange,
  }: {
    label?: string;
    options?: Array<{ value: string; label: string }>;
    value?: string;
    onChange?: (value: string) => void;
  }) => (
    <select aria-label={label} value={value} onChange={(event) => onChange?.(event.target.value)}>
      {options?.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

vi.mock('../../components/ui/PageHeader', () => ({
  PageHeader: ({ title, description }: { title: string; description?: string }) => (
    <div>
      <h1>{title}</h1>
      {description ? <p>{description}</p> : null}
    </div>
  ),
}));

vi.mock('../../components/ui/Tabs', () => ({
  Tabs: ({
    tabs,
    activeTab,
    onTabChange,
  }: {
    tabs: Array<{ id: string; label: string }>;
    activeTab: string;
    onTabChange: (tabId: string) => void;
  }) => (
    <div>
      {tabs.map((tab) => (
        <button key={tab.id} data-active={tab.id === activeTab} onClick={() => onTabChange(tab.id)}>
          {tab.label}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('../../components/ui/Skeleton', () => ({
  Skeleton: (props: React.HTMLAttributes<HTMLDivElement>) => <div {...props} />,
}));

vi.mock('../../components/deployments/channels/CreateInstanceDialog', () => ({
  CreateInstanceDialog: () => null,
}));

vi.mock('../../components/deployments/channels/channel-registry', () => ({
  getChannelDef: () => ({
    id: 'slack',
    name: 'Slack',
    description: 'Slack workspace',
    icon: <span>Slack</span>,
    available: true,
    category: 'messaging',
    capabilities: {
      multiConnection: true,
      hasCredentials: true,
      hasWebhookUrl: true,
      supportsTest: true,
      supportsDeliveryLog: true,
      autoGenerateIdentifier: false,
      supportsPauseResume: true,
    },
    credentialFields: [],
    setupInstructions: null,
    webhookPath: null,
    externalIdentifierLabel: 'Workspace',
    externalIdentifierPlaceholder: 'T123:A456',
  }),
}));

function normalizeStatus(status: string): 'active' | 'inactive' | 'error' {
  if (status === 'inactive') {
    return 'inactive';
  }
  if (status === 'error') {
    return 'error';
  }
  return 'active';
}

vi.mock('../../components/deployments/channels/channel-normalizer', () => ({
  normalizeConnection: (connection: ChannelConnectionSummary) => ({
    id: `conn_${connection.id}`,
    channelType: 'slack',
    displayName: connection.displayName ?? 'Slack',
    status: normalizeStatus(connection.status),
    environment: connection.environment,
    deploymentId: connection.deploymentId,
    externalIdentifier: connection.externalIdentifier,
    hasCredentials: connection.hasCredentials,
    config: connection.config,
    identityVerification: connection.identityVerification,
    webhookUrl: connection.webhookUrl,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
    _source: 'channel_connection',
    _sourceId: connection.id,
  }),
  normalizeSDKChannel: (...args: unknown[]) => mockNormalizeSDKChannel(...args),
  normalizeSubscription: (...args: unknown[]) => mockNormalizeSubscription(...args),
}));

vi.mock('../../components/deployments/channels/tabs/OverviewTab', () => ({
  OverviewTab: () => <div>Overview</div>,
}));

vi.mock('../../components/deployments/channels/tabs/CredentialsTab', () => ({
  CredentialsTab: () => <div>Credentials</div>,
}));

vi.mock('../../components/deployments/channels/tabs/ConfigurationTab', () => ({
  ConfigurationTab: () => <div>Configuration</div>,
}));

vi.mock('../../components/deployments/channels/tabs/DeploymentTab', () => ({
  DeploymentTab: () => <div>Deployment</div>,
}));

vi.mock('../../components/deployments/channels/tabs/TestingTab', () => ({
  TestingTab: () => <div>Testing</div>,
}));

vi.mock('../../components/deployments/channels/tabs/ActivityTab', () => ({
  ActivityTab: () => <div>Activity</div>,
}));

import { toast } from 'sonner';
import { ChannelInstanceConfig } from '../../components/deployments/channels/ChannelInstanceConfig';
import { ChannelInstanceList } from '../../components/deployments/channels/ChannelInstanceList';
import { ConnectorsPage } from '../../components/admin/ConnectorsPage';

function makeConnectionSummary(
  overrides: Partial<ChannelConnectionSummary> = {},
): ChannelConnectionSummary {
  return {
    id: 'conn-1',
    projectId: 'proj-1',
    channelType: 'slack',
    displayName: 'Support Slack',
    externalIdentifier: 'T12345ABC:A67890XYZ',
    hasCredentials: true,
    config: {},
    identityVerification: { providerVerificationStrength: 'weak' },
    status: 'active',
    deploymentId: null,
    environment: null,
    webhookUrl: null,
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeAdminConnection(overrides: Partial<ChannelConnection> = {}): ChannelConnection {
  return {
    id: 'conn-1',
    name: 'Support Slack',
    type: 'slack',
    status: 'active',
    config: {},
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
  };
}

async function renderInstanceList(status: 'active' | 'inactive') {
  mockFetchConnections.mockResolvedValue({
    connections: [makeConnectionSummary({ status })],
  });
  render(
    <ChannelInstanceList
      projectId="proj-1"
      channelType="slack"
      onBack={vi.fn()}
      onSelectInstance={vi.fn()}
    />,
  );
  await screen.findByTestId('data-table');
}

async function renderInstanceConfig(status: 'active' | 'inactive') {
  mockFetchConnection.mockResolvedValue({
    connection: makeConnectionSummary({ status }),
  });
  render(
    <ChannelInstanceConfig
      projectId="proj-1"
      channelType="slack"
      instanceId="conn_conn-1"
      onBack={vi.fn()}
    />,
  );
  await screen.findByText('Support Slack');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchChannels.mockResolvedValue({ channels: [] });
  mockFetchSubscriptions.mockResolvedValue({ subscriptions: [] });
  mockFetchConnections.mockResolvedValue({ connections: [] });
  mockFetchConnection.mockResolvedValue({ connection: makeConnectionSummary() });
  mockDeleteConnection.mockResolvedValue({ success: true, outcome: 'deleted' });
  mockNormalizeSDKChannel.mockReset();
  mockNormalizeSubscription.mockReset();
  mockUseSDKChannels.mockReturnValue({
    channels: [],
    isLoading: false,
    mutate: vi.fn(),
    createChannel: vi.fn(),
    updateChannel: vi.fn(),
    deleteChannel: vi.fn(),
  });
  mockUseChannelConnections.mockReturnValue({
    connections: [],
    isLoading: false,
    mutate: vi.fn(),
    createConnection: vi.fn(),
    deleteConnection: vi.fn().mockResolvedValue({ success: true, outcome: 'deleted' }),
  });
});

describe('ChannelInstanceList delete copy', () => {
  it('uses deactivate copy and toast for active channel connections', async () => {
    mockDeleteConnection.mockResolvedValue({ success: true, outcome: 'deactivated' });
    await renderInstanceList('active');

    fireEvent.click(await screen.findByLabelText('Deactivate connection'));

    expect(screen.getByTestId('confirm-dialog-title')).toHaveTextContent('Deactivate Connection');
    expect(screen.getByTestId('confirm-dialog-description')).toHaveTextContent(
      'This will deactivate "Support Slack". Delete it again later to remove it permanently.',
    );

    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));

    await waitFor(() => {
      expect(mockDeleteConnection).toHaveBeenCalledWith('proj-1', 'conn-1');
    });
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Connection deactivated');
  });

  it('uses permanent-delete copy and toast for inactive channel connections', async () => {
    mockDeleteConnection.mockResolvedValue({ success: true, outcome: 'deleted' });
    await renderInstanceList('inactive');

    fireEvent.click(await screen.findByLabelText('Delete connection'));

    expect(screen.getByTestId('confirm-dialog-title')).toHaveTextContent('Delete Connection');
    expect(screen.getByTestId('confirm-dialog-description')).toHaveTextContent(
      'This will permanently delete "Support Slack". Any integrations using this connection will stop working.',
    );

    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));

    await waitFor(() => {
      expect(mockDeleteConnection).toHaveBeenCalledWith('proj-1', 'conn-1');
    });
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Connection deleted');
  });
});

describe('ChannelInstanceConfig delete copy', () => {
  it('uses deactivate copy and toast for active channel connections', async () => {
    mockDeleteConnection.mockResolvedValue({ success: true, outcome: 'deactivated' });
    await renderInstanceConfig('active');

    fireEvent.click(await screen.findByLabelText('Deactivate channel instance'));

    expect(screen.getByTestId('confirm-dialog-title')).toHaveTextContent(
      'Deactivate Channel Instance',
    );
    expect(screen.getByTestId('confirm-dialog-description')).toHaveTextContent(
      'This will deactivate "Support Slack". Delete it again later to remove it permanently.',
    );

    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));

    await waitFor(() => {
      expect(mockDeleteConnection).toHaveBeenCalledWith('proj-1', 'conn-1');
    });
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Channel instance deactivated.');
  });

  it('uses permanent-delete copy for inactive channel connections', async () => {
    await renderInstanceConfig('inactive');

    fireEvent.click(await screen.findByLabelText('Delete channel instance'));

    expect(screen.getByTestId('confirm-dialog-title')).toHaveTextContent('Delete Channel Instance');
    expect(screen.getByTestId('confirm-dialog-description')).toHaveTextContent(
      'This will permanently delete "Support Slack". Any integrations relying on this channel will stop working.',
    );
  });

  it('keeps the configuration tab reachable for sdk_api channels', async () => {
    mockFetchChannels.mockResolvedValue({
      channels: [{ id: 'sdk-api-1' }],
    });
    mockNormalizeSDKChannel.mockReturnValue({
      id: 'sdk_sdk-api-1',
      channelType: 'sdk_api',
      displayName: 'Server SDK',
      status: 'active',
      environment: null,
      deploymentId: null,
      externalIdentifier: null,
      hasCredentials: true,
      config: {},
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:00:00.000Z',
      _source: 'sdk_channel',
      _sourceId: 'sdk-api-1',
    });

    render(
      <ChannelInstanceConfig
        projectId="proj-1"
        channelType="sdk_api"
        instanceId="sdk_sdk-api-1"
        onBack={vi.fn()}
      />,
    );

    await screen.findByText('Server SDK');
    fireEvent.click(screen.getByRole('button', { name: 'Configuration' }));

    expect(screen.getAllByText('Configuration')).toHaveLength(2);
  });
});

describe('ConnectorsPage delete copy', () => {
  it('uses deactivate copy and toast for active channel connections', async () => {
    const deleteConnection = vi.fn().mockResolvedValue({ success: true, outcome: 'deactivated' });
    mockUseChannelConnections.mockReturnValue({
      connections: [makeAdminConnection({ status: 'active' })],
      isLoading: false,
      mutate: vi.fn(),
      createConnection: vi.fn(),
      deleteConnection,
    });

    render(<ConnectorsPage />);

    fireEvent.click(screen.getByTitle('Deactivate'));

    expect(screen.getByTestId('confirm-dialog-title')).toHaveTextContent(
      'Deactivate Channel Connection',
    );
    expect(screen.getByTestId('confirm-dialog-description')).toHaveTextContent(
      'This will deactivate "Support Slack". Delete it again later to remove it permanently.',
    );

    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));

    await waitFor(() => {
      expect(deleteConnection).toHaveBeenCalledWith('conn-1');
    });
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Channel connection deactivated');
  });

  it('uses permanent-delete copy for inactive channel connections', () => {
    mockUseChannelConnections.mockReturnValue({
      connections: [makeAdminConnection({ status: 'inactive' })],
      isLoading: false,
      mutate: vi.fn(),
      createConnection: vi.fn(),
      deleteConnection: vi.fn().mockResolvedValue({ success: true, outcome: 'deleted' }),
    });

    render(<ConnectorsPage />);

    fireEvent.click(screen.getByTitle('Delete'));

    expect(screen.getByTestId('confirm-dialog-title')).toHaveTextContent(
      'Delete Channel Connection',
    );
    expect(screen.getByTestId('confirm-dialog-description')).toHaveTextContent(
      'This will permanently remove "Support Slack". This action cannot be undone.',
    );
  });
});
