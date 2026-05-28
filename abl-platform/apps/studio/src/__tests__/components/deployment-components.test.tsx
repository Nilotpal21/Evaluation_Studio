/**
 * Deployment Components Tests
 *
 * Tests for DeploymentsPage, ChannelCard, EnvironmentsTab,
 * EmbedCodeDialog, and CreateDeploymentDialog.
 */

import React from 'react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import studioMessages from '../../../../../packages/i18n/locales/en/studio.json';

// =============================================================================
// MOCKS
// =============================================================================

const mockNavigationStore = {
  projectId: 'proj-123' as string | null,
  navigate: vi.fn(),
  page: 'deployments',
  tab: null as string | null,
  setTab: vi.fn(),
};

vi.mock('../../store/navigation-store', () => ({
  useNavigationStore: () => mockNavigationStore,
}));

vi.mock('../../store/auth-store', () => ({
  useAuthStore: Object.assign(
    (selector?: (s: any) => any) => {
      const state = {
        accessToken: 'test-token',
        isAuthenticated: true,
        user: { id: 'u1', email: 'test@test.com', name: 'Test User' },
      };
      return selector ? selector(state) : state;
    },
    { getState: () => ({ accessToken: 'test-token', isAuthenticated: true }) },
  ),
}));

// Mock apiFetch
const mockApiFetch = vi.fn().mockResolvedValue({
  json: () => Promise.resolve({ keys: [], snippet: '<script>test</script>', models: [] }),
  ok: true,
});

vi.mock('../../lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('../../lib/sanitize-error', () => ({
  sanitizeError: (err: unknown, fallback: string) =>
    err instanceof Error && err.message ? err.message : fallback,
}));

// Mock deployment API
const mockFetchDeployments = vi.fn().mockResolvedValue({ deployments: [] });
const mockCreateDeployment = vi.fn().mockResolvedValue({});
const mockRetireDeployment = vi.fn().mockResolvedValue({});
const mockRollbackDeployment = vi.fn().mockResolvedValue({});

vi.mock('../../api/deployments', () => ({
  fetchDeployments: (...args: unknown[]) => mockFetchDeployments(...args),
  createDeployment: (...args: unknown[]) => mockCreateDeployment(...args),
  retireDeployment: (...args: unknown[]) => mockRetireDeployment(...args),
  rollbackDeployment: (...args: unknown[]) => mockRollbackDeployment(...args),
}));

// Mock channel API
vi.mock('../../api/channels', () => ({
  fetchChannels: vi.fn().mockResolvedValue({ channels: [] }),
}));

// Mock sonner toast
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

// Mock lucide-react
vi.mock('lucide-react', () => {
  const icon = ({ className, ...props }: Record<string, unknown>) => (
    <span data-testid="icon" className={className as string} {...props} />
  );
  return {
    Rocket: icon,
    Radio: icon,
    Key: icon,
    Plus: icon,
    Loader2: icon,
    Eye: icon,
    Code: icon,
    Settings: icon,
    Trash2: icon,
    Globe: icon,
    Smartphone: icon,
    Phone: icon,
    Server: icon,
    Copy: icon,
    Check: icon,
    AlertTriangle: icon,
    ChevronDown: icon,
    ChevronRight: icon,
    Search: icon,
    Layers: icon,
    Zap: icon,
    X: icon,
  };
});

// Mock UI components
vi.mock('../../components/ui/Button', () => ({
  Button: ({ children, onClick, disabled, loading, ...props }: any) => (
    <button onClick={onClick} disabled={disabled || loading} {...props}>
      {props.icon}
      {children}
    </button>
  ),
}));

vi.mock('../../components/ui/Badge', () => ({
  Badge: ({ children, ...props }: any) => <span {...props}>{children}</span>,
}));

vi.mock('../../components/ui/PageHeader', () => ({
  PageHeader: ({ title, description }: any) => (
    <div data-testid="page-header">
      <h1>{title}</h1>
      {description && <p>{description}</p>}
    </div>
  ),
}));

vi.mock('../../components/ui/EmptyState', () => ({
  EmptyState: ({ title, description, action }: any) => (
    <div data-testid="empty-state">
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  ),
}));

vi.mock('../../components/ui/ListPageShell', () => ({
  ListPageShell: ({ title, description, children }: any) => (
    <div data-testid="list-page-shell">
      <h1>{title}</h1>
      {description && <p>{description}</p>}
      {children}
    </div>
  ),
}));

vi.mock('../../components/ui/Tabs', () => ({
  Tabs: ({ tabs, activeTab, onTabChange }: any) => (
    <div data-testid="tabs">
      {tabs.map((tab: any) => (
        <button key={tab.id} onClick={() => onTabChange(tab.id)} data-active={activeTab === tab.id}>
          {tab.label}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('../../components/ui/Dialog', () => ({
  Dialog: ({ open, onClose, title, children }: any) => {
    if (!open) return null;
    return (
      <div data-testid="dialog">
        <h2>{title}</h2>
        <button data-testid="dialog-close" onClick={onClose}>
          X
        </button>
        {children}
      </div>
    );
  },
}));

vi.mock('../../components/ui/ConfirmDialog', () => ({
  ConfirmDialog: ({ open, onClose, onConfirm, title, description, confirmLabel }: any) => {
    if (!open) return null;
    return (
      <div data-testid="confirm-dialog">
        <h2>{title}</h2>
        <p>{description}</p>
        <button onClick={onConfirm}>{confirmLabel}</button>
        <button onClick={onClose}>Cancel</button>
      </div>
    );
  },
}));

vi.mock('../../components/ui/Input', () => ({
  Input: ({ label, value, onChange, placeholder }: any) => (
    <div>
      {label && <label>{label}</label>}
      <input value={value} onChange={onChange} placeholder={placeholder} />
    </div>
  ),
}));

vi.mock('../../components/ui/Select', () => ({
  Select: ({ label, value, onChange, options }: any) => (
    <div>
      {label && <label>{label}</label>}
      <select value={value} onChange={onChange}>
        {options?.map((opt: any) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  ),
}));

// Mock sub-components used by DeploymentsPage
vi.mock('../../components/deployments/ChannelsTab', () => ({
  ChannelsTab: ({ projectId }: any) => (
    <div data-testid="channels-tab">Channels for {projectId}</div>
  ),
}));

vi.mock('../../components/deployments/DeploymentCard', () => ({
  DeploymentCard: ({ deployment }: any) => (
    <div data-testid="deployment-card">
      {deployment.environment} - {deployment.status}
    </div>
  ),
}));

vi.mock('../../components/deployments/PromoteDeploymentDialog', () => ({
  PromoteDeploymentDialog: () => null,
}));

vi.mock('../../components/settings/ApiKeysTab', () => ({
  ApiKeysTab: () => <div data-testid="api-keys-tab">API Keys Content</div>,
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import { DeploymentsPage } from '../../components/deployments/DeploymentsPage';
import { ChannelCard } from '../../components/deployments/ChannelCard';
import { EnvironmentsTab } from '../../components/deployments/EnvironmentsTab';
import { EmbedCodeDialog } from '../../components/deployments/EmbedCodeDialog';
import { CreateDeploymentDialog } from '../../components/deployments/CreateDeploymentDialog';

// =============================================================================
// DEPLOYMENTSPAGE TESTS
// =============================================================================

describe('DeploymentsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigationStore.projectId = 'proj-123';
  });

  test('renders page header with "Deployments" title', () => {
    render(<DeploymentsPage />);
    expect(screen.getByText('Deployments')).toBeInTheDocument();
  });

  test('shows "No project selected" when projectId is null', () => {
    mockNavigationStore.projectId = null;
    render(<DeploymentsPage />);
    expect(screen.getByText('No project selected')).toBeInTheDocument();
  });

  test('shows description text when project is selected', () => {
    render(<DeploymentsPage />);
    expect(screen.getByText('Manage environments, channels, and API keys')).toBeInTheDocument();
  });

  test('renders tabs for Environments, Channels, API Keys', () => {
    render(<DeploymentsPage />);
    expect(screen.getByText('Environments')).toBeInTheDocument();
    expect(screen.getByText('Channels')).toBeInTheDocument();
    expect(screen.getByText('API Keys')).toBeInTheDocument();
  });

  test('clicking Channels tab shows ChannelsTab content', () => {
    render(<DeploymentsPage />);
    fireEvent.click(screen.getByText('Channels'));
    expect(screen.getByTestId('channels-tab')).toBeInTheDocument();
  });

  test('clicking API Keys tab shows ApiKeysTab content', () => {
    render(<DeploymentsPage />);
    fireEvent.click(screen.getByText('API Keys'));
    expect(screen.getByTestId('api-keys-tab')).toBeInTheDocument();
  });
});

// =============================================================================
// CHANNELCARD TESTS
// =============================================================================

describe('ChannelCard', () => {
  const baseChannel = {
    id: 'ch-1',
    tenantId: 'tenant-1',
    name: 'Main Web Chat',
    channelType: 'web' as const,
    isActive: true,
    projectId: 'proj-1',
    deploymentId: 'deploy-1',
    publicApiKeyId: 'key-1',
    config: { chatEnabled: true, voiceEnabled: false },
    environment: 'development',
    followEnvironment: false,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('renders channel name', () => {
    render(<ChannelCard channel={baseChannel} />);
    expect(screen.getByText('Main Web Chat')).toBeInTheDocument();
  });

  test('shows Active badge when channel is active', () => {
    render(<ChannelCard channel={baseChannel} />);
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  test('shows Inactive badge when channel is not active', () => {
    render(<ChannelCard channel={{ ...baseChannel, isActive: false }} />);
    expect(screen.getByText('Inactive')).toBeInTheDocument();
  });

  test('shows "Chat Only" config summary for chat-only channels', () => {
    render(<ChannelCard channel={baseChannel} />);
    expect(screen.getByText('Chat Only')).toBeInTheDocument();
  });

  test('shows "Chat + Voice" for unified mode', () => {
    const channel = {
      ...baseChannel,
      config: { chatEnabled: true, voiceEnabled: true },
    };
    render(<ChannelCard channel={channel} />);
    expect(screen.getByText('Chat + Voice')).toBeInTheDocument();
  });

  test('shows Preview button for web channel type', () => {
    const onPreview = vi.fn();
    render(<ChannelCard channel={baseChannel} onPreview={onPreview} />);
    expect(screen.getByText('Preview')).toBeInTheDocument();
  });

  test('shows Embed button for web channel type', () => {
    const onEmbedCode = vi.fn();
    render(<ChannelCard channel={baseChannel} onEmbedCode={onEmbedCode} />);
    expect(screen.getByText('Embed')).toBeInTheDocument();
  });

  test('shows Configure button when onConfigure provided', () => {
    const onConfigure = vi.fn();
    render(<ChannelCard channel={baseChannel} onConfigure={onConfigure} />);
    expect(screen.getByText('Configure')).toBeInTheDocument();
  });

  test('clicking Configure calls onConfigure', () => {
    const onConfigure = vi.fn();
    render(<ChannelCard channel={baseChannel} onConfigure={onConfigure} />);
    fireEvent.click(screen.getByText('Configure'));
    expect(onConfigure).toHaveBeenCalled();
  });

  test('shows delete button when onDelete provided', () => {
    const onDelete = vi.fn();
    render(<ChannelCard channel={baseChannel} onDelete={onDelete} />);
    const deleteBtn = screen.getByTitle('Delete channel');
    expect(deleteBtn).toBeInTheDocument();
  });

  test('clicking delete calls onDelete', () => {
    const onDelete = vi.fn();
    render(<ChannelCard channel={baseChannel} onDelete={onDelete} />);
    fireEvent.click(screen.getByTitle('Delete channel'));
    expect(onDelete).toHaveBeenCalled();
  });

  test('clicking the card calls onSelect', () => {
    const onSelect = vi.fn();
    render(<ChannelCard channel={baseChannel} onSelect={onSelect} />);
    // Click the card container
    const card = screen.getByText('Main Web Chat').closest('div[class*="rounded-lg"]');
    fireEvent.click(card!);
    expect(onSelect).toHaveBeenCalled();
  });

  test('shows deployment label when provided', () => {
    render(<ChannelCard channel={baseChannel} deploymentLabel="v1.0.0" />);
    expect(screen.getByText('v1.0.0')).toBeInTheDocument();
  });

  test('shows API key prefix when provided', () => {
    render(<ChannelCard channel={baseChannel} apiKeyPrefix="pk_live_abc" />);
    expect(screen.getByText('pk_live_abc...')).toBeInTheDocument();
  });

  test('shows environment badge when channel has environment', () => {
    const channel = { ...baseChannel, environment: 'production' };
    render(<ChannelCard channel={channel} />);
    expect(screen.getByText('production')).toBeInTheDocument();
  });

  test('does not show Preview for API channel type', () => {
    const channel = { ...baseChannel, channelType: 'api' as const };
    const onPreview = vi.fn();
    render(<ChannelCard channel={channel} onPreview={onPreview} />);
    expect(screen.queryByText('Preview')).not.toBeInTheDocument();
  });

  test('does not show Embed for API channel type', () => {
    const channel = { ...baseChannel, channelType: 'api' as const };
    const onEmbedCode = vi.fn();
    render(<ChannelCard channel={channel} onEmbedCode={onEmbedCode} />);
    expect(screen.queryByText('Embed')).not.toBeInTheDocument();
  });
});

// =============================================================================
// ENVIRONMENTSTAB TESTS
// =============================================================================

describe('EnvironmentsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchDeployments.mockResolvedValue({ deployments: [] });
  });

  test('shows loading spinner initially', () => {
    // Make the fetch never resolve
    mockFetchDeployments.mockReturnValue(new Promise(() => {}));
    const { container } = render(<EnvironmentsTab projectId="proj-123" />);
    // Loader2 icon is rendered
    expect(container.querySelector('[data-testid="icon"]')).toBeInTheDocument();
  });

  test('shows empty state when no deployments', async () => {
    mockFetchDeployments.mockResolvedValue({ deployments: [] });
    render(<EnvironmentsTab projectId="proj-123" />);

    await waitFor(() => {
      expect(screen.getByText('No deployments yet')).toBeInTheDocument();
    });
  });

  test('shows environment cards after loading', async () => {
    mockFetchDeployments.mockResolvedValue({ deployments: [] });
    render(<EnvironmentsTab projectId="proj-123" />);

    await waitFor(() => {
      expect(screen.getByText('Development')).toBeInTheDocument();
      expect(screen.getByText('Staging')).toBeInTheDocument();
      expect(screen.getByText('Production')).toBeInTheDocument();
    });
  });

  test('shows "No active deployment" for environments without deployments', async () => {
    mockFetchDeployments.mockResolvedValue({ deployments: [] });
    render(<EnvironmentsTab projectId="proj-123" />);

    await waitFor(() => {
      const noActiveTexts = screen.getAllByText('No active deployment');
      expect(noActiveTexts.length).toBe(3);
    });
  });

  test('shows active deployment count text', async () => {
    mockFetchDeployments.mockResolvedValue({
      deployments: [
        {
          id: 'd1',
          environment: 'dev',
          status: 'active',
          agentVersionManifest: {},
          createdAt: '2025-01-01',
        },
      ],
    });
    render(<EnvironmentsTab projectId="proj-123" />);

    await waitFor(() => {
      expect(screen.getByText('1 active deployment')).toBeInTheDocument();
    });
  });

  test('shows plural "deployments" for multiple active', async () => {
    mockFetchDeployments.mockResolvedValue({
      deployments: [
        {
          id: 'd1',
          environment: 'dev',
          status: 'active',
          agentVersionManifest: {},
          createdAt: '2025-01-01',
        },
        {
          id: 'd2',
          environment: 'staging',
          status: 'active',
          agentVersionManifest: {},
          createdAt: '2025-01-02',
        },
      ],
    });
    render(<EnvironmentsTab projectId="proj-123" />);

    await waitFor(() => {
      expect(screen.getByText('2 active deployments')).toBeInTheDocument();
    });
  });

  test('New Deploy button is present', async () => {
    mockFetchDeployments.mockResolvedValue({ deployments: [] });
    render(<EnvironmentsTab projectId="proj-123" />);

    await waitFor(() => {
      expect(screen.getByText('New Deploy')).toBeInTheDocument();
    });
  });

  test('Deploy Now button shown for environments without active deployment', async () => {
    mockFetchDeployments.mockResolvedValue({ deployments: [] });
    render(<EnvironmentsTab projectId="proj-123" />);

    await waitFor(() => {
      const deployButtons = screen.getAllByText('Deploy Now');
      expect(deployButtons.length).toBe(3);
    });
  });
});

// =============================================================================
// EMBEDCODEDIALOG TESTS
// =============================================================================

describe('EmbedCodeDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiFetch.mockResolvedValue({
      json: () => Promise.resolve({ snippet: '<script src="sdk.js"></script>' }),
      ok: true,
    });
  });

  test('does not render when open is false', () => {
    render(<EmbedCodeDialog open={false} onClose={vi.fn()} projectId="proj-1" />);
    expect(screen.queryByText('Embed Code')).not.toBeInTheDocument();
  });

  test('renders dialog with title when open', () => {
    render(<EmbedCodeDialog open={true} onClose={vi.fn()} projectId="proj-1" />);
    expect(screen.getByText('Embed Code')).toBeInTheDocument();
  });

  test('renders with channel name in title when provided', () => {
    render(
      <EmbedCodeDialog open={true} onClose={vi.fn()} projectId="proj-1" channelName="Main Chat" />,
    );
    expect(screen.getByText('Embed Code: Main Chat')).toBeInTheDocument();
  });

  test('shows loading state initially', () => {
    mockApiFetch.mockReturnValue(new Promise(() => {}));
    render(<EmbedCodeDialog open={true} onClose={vi.fn()} projectId="proj-1" />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  test('shows embed code after loading', async () => {
    render(<EmbedCodeDialog open={true} onClose={vi.fn()} projectId="proj-1" />);

    await waitFor(() => {
      expect(screen.getByText('<script src="sdk.js"></script>')).toBeInTheDocument();
    });
  });

  test('shows Quick Start instructions', async () => {
    render(<EmbedCodeDialog open={true} onClose={vi.fn()} projectId="proj-1" />);

    await waitFor(() => {
      expect(screen.getByText('Quick Start')).toBeInTheDocument();
      expect(screen.getByText('1. Copy the embed code above')).toBeInTheDocument();
    });
  });

  test('copy button copies embed code to clipboard', async () => {
    render(<EmbedCodeDialog open={true} onClose={vi.fn()} projectId="proj-1" />);

    await waitFor(() => {
      const copyBtn = screen.getByTitle('Copy to clipboard');
      fireEvent.click(copyBtn);
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('<script src="sdk.js"></script>');
  });

  test('Close button calls onClose', async () => {
    const onClose = vi.fn();
    render(<EmbedCodeDialog open={true} onClose={onClose} projectId="proj-1" />);

    await waitFor(() => {
      fireEvent.click(screen.getByText('Close'));
    });

    expect(onClose).toHaveBeenCalled();
  });

  test('shows error message when fetch fails', async () => {
    mockApiFetch.mockResolvedValue({
      ok: false,
      json: () =>
        Promise.resolve({
          error:
            'Runtime URL must be an absolute http:// or https:// URL without a trailing slash.',
        }),
    });
    render(<EmbedCodeDialog open={true} onClose={vi.fn()} projectId="proj-1" />);

    await waitFor(() => {
      expect(
        screen.getByText(
          'Runtime URL must be an absolute http:// or https:// URL without a trailing slash.',
        ),
      ).toBeInTheDocument();
    });
  });
});

// =============================================================================
// CREATEDEPLOYMENTDIALOG TESTS
// =============================================================================

describe('CreateDeploymentDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiFetch.mockResolvedValue({
      json: () => Promise.resolve({ agents: [], versions: [], models: [] }),
      ok: true,
    });
  });

  test('does not render when open is false', () => {
    render(
      <CreateDeploymentDialog
        open={false}
        onClose={vi.fn()}
        projectId="proj-1"
        onCreated={vi.fn()}
      />,
    );
    expect(screen.queryByText('Create Deployment')).not.toBeInTheDocument();
  });

  test('renders dialog with title when open', () => {
    render(
      <CreateDeploymentDialog
        open={true}
        onClose={vi.fn()}
        projectId="proj-1"
        onCreated={vi.fn()}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Create Deployment' })).toBeInTheDocument();
  });

  test('shows Environment and Label fields', () => {
    render(
      <CreateDeploymentDialog
        open={true}
        onClose={vi.fn()}
        projectId="proj-1"
        onCreated={vi.fn()}
      />,
    );
    expect(screen.getByText('Environment')).toBeInTheDocument();
    expect(screen.getByText('Label')).toBeInTheDocument();
  });

  test('shows Description textarea', () => {
    render(
      <CreateDeploymentDialog
        open={true}
        onClose={vi.fn()}
        projectId="proj-1"
        onCreated={vi.fn()}
      />,
    );
    expect(screen.getByText('Description')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Optional deployment notes')).toBeInTheDocument();
  });

  test('Cancel button calls onClose', () => {
    const onClose = vi.fn();
    render(
      <CreateDeploymentDialog
        open={true}
        onClose={onClose}
        projectId="proj-1"
        onCreated={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();
  });

  test('shows loading state while fetching agents', () => {
    mockApiFetch.mockReturnValue(new Promise(() => {}));
    render(
      <CreateDeploymentDialog
        open={true}
        onClose={vi.fn()}
        projectId="proj-1"
        onCreated={vi.fn()}
      />,
    );
    expect(screen.getByText('Loading agents and versions...')).toBeInTheDocument();
  });

  test('shows empty state when no agents found', async () => {
    mockApiFetch.mockResolvedValue({
      json: () => Promise.resolve({ agents: [], versions: [], models: [] }),
      ok: true,
    });

    render(
      <CreateDeploymentDialog
        open={true}
        onClose={vi.fn()}
        projectId="proj-1"
        onCreated={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByText('No agents found in this project. Create agents first.'),
      ).toBeInTheDocument();
    });
  });

  test('Deploy button is disabled when no agents', async () => {
    render(
      <CreateDeploymentDialog
        open={true}
        onClose={vi.fn()}
        projectId="proj-1"
        onCreated={vi.fn()}
      />,
    );

    await waitFor(() => {
      const deployBtn = screen.getByRole('button', { name: 'Create Deployment' });
      expect(deployBtn).toBeDisabled();
    });
  });

  test('shows the selected version status in warnings instead of the raw {status} placeholder', async () => {
    mockApiFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('/agents/entry_agent/versions')) {
        return {
          ok: true,
          json: () =>
            Promise.resolve({
              versions: [{ version: '1.0.0', status: 'testing' }],
            }),
        };
      }

      if (url.includes('/agents')) {
        return {
          ok: true,
          json: () =>
            Promise.resolve({
              agents: [{ id: 'agent-1', name: 'entry_agent', versionCount: 1 }],
            }),
        };
      }

      if (url.includes('/env-vars/validate')) {
        return {
          ok: true,
          json: () => Promise.resolve({ success: true, missing: [], defined: [] }),
        };
      }

      return {
        ok: true,
        json: () => Promise.resolve({ models: [] }),
      };
    });

    render(
      <CreateDeploymentDialog
        open={true}
        onClose={vi.fn()}
        projectId="proj-1"
        onCreated={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('entry_agent v1.0.0 is in testing status')).toBeInTheDocument();
    });
    expect(screen.queryByText(/\{status\}/)).not.toBeInTheDocument();
  });

  test('keeps the create deployment version warning status placeholder interpolatable', () => {
    const warning = studioMessages.deployments.create_dialog.version_warning;

    expect(warning).toContain('{status}');
    expect(warning).not.toContain("'{status}'");
  });
});
