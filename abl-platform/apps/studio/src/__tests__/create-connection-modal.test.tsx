/**
 * CreateConnectionModal Component Tests
 *
 * Tests for the three-step modal: pick connector, configure, success.
 * Verifies search/filter, category grouping, connector selection,
 * auth profile picker, API creation, error handling, and preselection.
 *
 * Auth is always delegated to auth profiles — no inline credential fields.
 *
 * @vitest-environment happy-dom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

// =============================================================================
// MOCKS — UI components are stubbed to isolate modal logic.
// Only external third-party libs + leaf UI components are mocked.
// =============================================================================

// lucide-react and framer-motion are mocked globally in setup.tsx

// SWR: configurable return (third-party)
const mockMutate = vi.fn();
let mockSwrReturn: {
  data: unknown;
  error: unknown;
  isLoading: boolean;
  mutate: typeof mockMutate;
} = {
  data: undefined,
  error: undefined,
  isLoading: false,
  mutate: mockMutate,
};
vi.mock('swr', () => ({
  default: vi.fn(() => mockSwrReturn),
}));

// API: createConnection
const mockCreateConnection = vi.fn();
vi.mock('../api/connections', () => ({
  createConnection: (...args: unknown[]) => mockCreateConnection(...args),
}));

// useAvailableConnectors: mutable return value
let mockConnectors: import('../hooks/useAvailableConnectors').ConnectorSummary[] = [];
vi.mock('../hooks/useAvailableConnectors', () => ({
  useAvailableConnectors: () => ({
    connectors: mockConnectors,
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

let mockSelectableProfiles: Array<{ id: string; authType: string }> = [];
vi.mock('../hooks/useAuthProfiles', () => ({
  useAuthProfile: () => ({
    profile: null,
    isLoading: false,
    error: null,
    errorStatus: null,
    refresh: vi.fn(),
  }),
  useAuthProfiles: () => ({
    profiles: mockSelectableProfiles,
    total: mockSelectableProfiles.length,
    nextCursor: null,
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  }),
  // ABLP-1123: workspace-surface stubs for mock-export-drift guard
  useWorkspaceAuthProfiles: () => ({
    profiles: [],
    total: 0,
    nextCursor: null,
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  }),
  buildWorkspaceAuthProfilesKey: vi.fn(),
}));

// connector-categories: simplified mock for grouping
vi.mock('../components/connections/connector-categories', () => ({
  CATEGORY_ORDER: ['communication', 'productivity', 'custom'],
  getConnectorCategory: (name: string) => {
    const map: Record<string, string> = {
      slack: 'communication',
      gmail: 'communication',
      notion: 'productivity',
    };
    return map[name] ?? 'custom';
  },
  getCategoryLabel: (cat: string) => {
    const labels: Record<string, string> = {
      communication: 'Communication',
      productivity: 'Productivity',
      custom: 'Custom',
    };
    return labels[cat] ?? cat;
  },
}));

// ConnectorLogo: null stub
vi.mock('../components/connections/ConnectorLogo', () => ({
  ConnectorLogo: () => null,
}));

// OAuthFlowDialog: stub with data-testid
vi.mock('../components/connections/OAuthFlowDialog', () => ({
  OAuthFlowDialog: (props: { open: boolean }) =>
    props.open ? <div data-testid="oauth-flow-dialog">OAuthFlowDialog</div> : null,
}));

// AuthProfilePicker: stub that captures onChange for simulating selection
let mockAuthProfilePickerOnChange: ((id: string | null) => void) | null = null;
vi.mock('../components/auth-profiles/AuthProfilePicker', () => ({
  AuthProfilePicker: (props: {
    value: string | null;
    onChange: (id: string | null) => void;
    connectorName?: string;
    excludeProfileIds?: Set<string>;
  }) => {
    mockAuthProfilePickerOnChange = props.onChange;
    return (
      <div data-testid="auth-profile-picker" data-connector={props.connectorName ?? ''}>
        <span data-testid="picker-value">{props.value ?? 'none'}</span>
        <span data-testid="picker-excluded">{props.excludeProfileIds?.size ?? 0}</span>
      </div>
    );
  },
}));

// Dialog: renders children when open
vi.mock('../components/ui/Dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
}));

// Button: renders children in real button
vi.mock('../components/ui/Button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    loading,
    ...rest
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    loading?: boolean;
    variant?: string;
    size?: string;
    className?: string;
  }) => (
    <button onClick={onClick} disabled={disabled || loading} data-loading={loading} {...rest}>
      {children}
    </button>
  ),
}));

// Input: renders label + input
vi.mock('../components/ui/Input', () => ({
  Input: ({
    label,
    value,
    onChange,
    type,
    placeholder,
  }: {
    label?: string;
    value?: string;
    onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
    type?: string;
    placeholder?: string;
  }) => (
    <div>
      {label && <label>{label}</label>}
      <input value={value ?? ''} onChange={onChange} type={type} placeholder={placeholder} />
    </div>
  ),
}));

// sanitize-error: returns fallback
vi.mock('../lib/sanitize-error', () => ({
  sanitizeError: (_err: unknown, fallback: string) => fallback,
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import { CreateConnectionModal } from '../components/connections/CreateConnectionModal';
import { type ConnectorSummary } from '../hooks/useAvailableConnectors';

// =============================================================================
// TEST DATA
// =============================================================================

function makeConnector(overrides: Partial<ConnectorSummary> = {}): ConnectorSummary {
  return {
    name: 'test-connector',
    displayName: 'Test Connector',
    description: 'A test connector',
    authType: 'api_key',
    actions: [{ name: 'echo', displayName: 'Echo', description: 'Echo action' }],
    triggers: [],
    ...overrides,
  };
}

/** Select auth profile via the captured onChange callback, wrapped in act() */
function selectAuthProfile(profileId: string) {
  act(() => {
    mockAuthProfilePickerOnChange?.(profileId);
  });
}

// =============================================================================
// SHARED SETUP
// =============================================================================

const defaultProps = {
  open: true,
  onClose: vi.fn(),
  projectId: 'proj-1',
  onCreated: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockConnectors = [];
  mockSelectableProfiles = [];
  mockAuthProfilePickerOnChange = null;
  mockSwrReturn = {
    data: undefined,
    error: undefined,
    isLoading: false,
    mutate: mockMutate,
  };
});

// =============================================================================
// TESTS
// =============================================================================

describe('CreateConnectionModal', () => {
  // -------------------------------------------------------------------------
  // Step 1: Picker
  // -------------------------------------------------------------------------

  it('renders picker with heading and search input when open', () => {
    mockConnectors = [makeConnector()];
    render(<CreateConnectionModal {...defaultProps} />);

    expect(screen.getByText('New Connection')).toBeDefined();
    expect(screen.getByPlaceholderText('Search connectors...')).toBeDefined();
  });

  it('groups connectors by category', () => {
    mockConnectors = [
      makeConnector({ name: 'slack', displayName: 'Slack' }),
      makeConnector({ name: 'gmail', displayName: 'Gmail' }),
      makeConnector({ name: 'notion', displayName: 'Notion' }),
    ];
    render(<CreateConnectionModal {...defaultProps} />);

    expect(screen.getByText('Communication')).toBeDefined();
    expect(screen.getByText('Productivity')).toBeDefined();
    expect(screen.getByText('Slack')).toBeDefined();
    expect(screen.getByText('Gmail')).toBeDefined();
    expect(screen.getByText('Notion')).toBeDefined();
  });

  it('filters connectors based on search input', () => {
    mockConnectors = [
      makeConnector({ name: 'slack', displayName: 'Slack' }),
      makeConnector({ name: 'notion', displayName: 'Notion' }),
    ];
    render(<CreateConnectionModal {...defaultProps} />);

    const searchInput = screen.getByPlaceholderText('Search connectors...');
    fireEvent.change(searchInput, { target: { value: 'slack' } });

    expect(screen.getByText('Slack')).toBeDefined();
    expect(screen.queryByText('Notion')).toBeNull();
  });

  it('shows no-results message for non-matching search', () => {
    mockConnectors = [makeConnector({ name: 'slack', displayName: 'Slack' })];
    render(<CreateConnectionModal {...defaultProps} />);

    const searchInput = screen.getByPlaceholderText('Search connectors...');
    fireEvent.change(searchInput, { target: { value: 'nonexistent' } });

    expect(screen.getByText(/No connectors match/)).toBeDefined();
  });

  it('selects a connector and advances to step 2', () => {
    mockConnectors = [makeConnector({ name: 'slack', displayName: 'Slack' })];
    render(<CreateConnectionModal {...defaultProps} />);

    fireEvent.click(screen.getByText('Slack'));
    expect(screen.getByText('Connect Slack')).toBeDefined();
  });

  it('keeps multi-auth connectors on Create Connection when a non-oauth profile is selected', () => {
    mockConnectors = [
      makeConnector({
        name: 'shopify',
        displayName: 'Shopify',
        authType: 'oauth2',
        availableAuthTypes: ['oauth2', 'oauth2_client_credentials', 'api_key'],
        oauth2: {
          authorizationUrl: 'https://shopify.example/auth',
          tokenUrl: 'https://shopify.example/token',
          defaultScopes: [],
          scopeSeparator: ' ',
          pkce: false,
        },
      }),
    ];
    mockSelectableProfiles = [{ id: 'profile-cc', authType: 'oauth2_client_credentials' }];

    render(<CreateConnectionModal {...defaultProps} />);

    fireEvent.click(screen.getByText('Shopify'));
    selectAuthProfile('profile-cc');

    expect(screen.getByText('Create Connection')).toBeDefined();
    expect(screen.queryByText('Authorize with Shopify')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Step 2: Configure — Auth Profile Only
  // -------------------------------------------------------------------------

  it('shows connection name and auth profile picker after selecting', () => {
    mockConnectors = [makeConnector({ name: 'slack', displayName: 'Slack' })];
    render(<CreateConnectionModal {...defaultProps} />);

    fireEvent.click(screen.getByText('Slack'));

    expect(screen.getByText('Connection name')).toBeDefined();
    expect(screen.getByDisplayValue('My Slack')).toBeDefined();
    expect(screen.getByTestId('auth-profile-picker')).toBeDefined();
    expect(screen.getByText('Auth Profile')).toBeDefined();
    // No inline API Key field
    expect(screen.queryByText('API Key')).toBeNull();
  });

  it('returns to picker when back button is clicked', () => {
    mockConnectors = [makeConnector({ name: 'slack', displayName: 'Slack' })];
    render(<CreateConnectionModal {...defaultProps} />);

    fireEvent.click(screen.getByText('Slack'));
    expect(screen.getByText('Connect Slack')).toBeDefined();

    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[0]);

    expect(screen.getByText('New Connection')).toBeDefined();
  });

  it('passes connectorName to AuthProfilePicker for grouped display', () => {
    mockConnectors = [makeConnector({ name: 'slack', displayName: 'Slack' })];
    render(<CreateConnectionModal {...defaultProps} />);

    fireEvent.click(screen.getByText('Slack'));

    const picker = screen.getByTestId('auth-profile-picker');
    expect(picker.getAttribute('data-connector')).toBe('slack');
  });

  it('disables create button when no auth profile selected', () => {
    mockConnectors = [makeConnector({ name: 'slack', displayName: 'Slack' })];
    render(<CreateConnectionModal {...defaultProps} />);

    fireEvent.click(screen.getByText('Slack'));

    const createBtn = screen.getByText('Create Connection');
    expect(createBtn.hasAttribute('disabled')).toBe(true);
  });

  it('enables create button when auth profile is selected', () => {
    mockConnectors = [makeConnector({ name: 'slack', displayName: 'Slack' })];
    render(<CreateConnectionModal {...defaultProps} />);

    fireEvent.click(screen.getByText('Slack'));
    selectAuthProfile('ap-1');

    const createBtn = screen.getByText('Create Connection');
    expect(createBtn.hasAttribute('disabled')).toBe(false);
  });

  it('calls createConnection API with authProfileId on create', async () => {
    mockCreateConnection.mockResolvedValue({
      success: true,
      data: { id: 'conn-1', connectorName: 'test-connector', displayName: 'My Test Connector' },
    });
    mockConnectors = [makeConnector({ name: 'test-connector', displayName: 'Test Connector' })];
    render(<CreateConnectionModal {...defaultProps} />);

    fireEvent.click(screen.getByText('Test Connector'));
    selectAuthProfile('ap-1');
    fireEvent.click(screen.getByText('Create Connection'));

    await vi.waitFor(() => {
      expect(mockCreateConnection).toHaveBeenCalledWith('proj-1', {
        connectorName: 'test-connector',
        displayName: 'My Test Connector',
        authProfileId: 'ap-1',
      });
    });
  });

  it('shows success step after successful creation', async () => {
    mockCreateConnection.mockResolvedValue({ success: true, data: { id: 'conn-1' } });
    mockConnectors = [makeConnector({ name: 'slack', displayName: 'Slack' })];
    render(<CreateConnectionModal {...defaultProps} />);

    fireEvent.click(screen.getByText('Slack'));
    selectAuthProfile('ap-1');
    fireEvent.click(screen.getByText('Create Connection'));

    await vi.waitFor(() => {
      expect(screen.getByText('Slack connected')).toBeDefined();
    });
    expect(screen.getByText('Done')).toBeDefined();
  });

  it('displays error message when createConnection rejects', async () => {
    mockCreateConnection.mockRejectedValue(new Error('Network error'));
    mockConnectors = [makeConnector({ name: 'slack', displayName: 'Slack' })];
    render(<CreateConnectionModal {...defaultProps} />);

    fireEvent.click(screen.getByText('Slack'));
    selectAuthProfile('ap-1');
    fireEvent.click(screen.getByText('Create Connection'));

    await vi.waitFor(() => {
      expect(screen.getByText('Failed to create connection')).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Duplicate auth profile prevention
  // -------------------------------------------------------------------------

  it('computes excludeProfileIds from existing connections for same connector', () => {
    mockConnectors = [makeConnector({ name: 'slack', displayName: 'Slack' })];
    const existingConnections = [
      {
        id: 'conn-1',
        connectorName: 'slack',
        displayName: 'Slack Team',
        scope: 'tenant' as const,
        authProfileId: 'ap-existing',
        status: 'active' as const,
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
      },
      {
        id: 'conn-2',
        connectorName: 'gmail',
        displayName: 'Gmail',
        scope: 'tenant' as const,
        authProfileId: 'ap-gmail',
        status: 'active' as const,
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
      },
    ];
    render(<CreateConnectionModal {...defaultProps} existingConnections={existingConnections} />);

    fireEvent.click(screen.getByText('Slack'));

    // Only slack connection's profile excluded, not gmail's
    const excluded = screen.getByTestId('picker-excluded');
    expect(excluded.textContent).toBe('1');
  });

  // -------------------------------------------------------------------------
  // Preselection
  // -------------------------------------------------------------------------

  it('skips to step 2 when preselectedConnector prop is provided', () => {
    mockConnectors = [makeConnector({ name: 'slack', displayName: 'Slack' })];
    render(<CreateConnectionModal {...defaultProps} preselectedConnector="slack" />);

    expect(screen.getByText('Connect Slack')).toBeDefined();
    expect(screen.queryByText('New Connection')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // OAuth — auth profile required before authorize
  // -------------------------------------------------------------------------

  it('shows disabled create button for oauth2 connector until an auth profile is selected', () => {
    mockConnectors = [
      makeConnector({
        name: 'google-drive',
        displayName: 'Google Drive',
        authType: 'oauth2',
        oauth2: {
          authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
          tokenUrl: 'https://oauth2.googleapis.com/token',
          defaultScopes: ['drive.readonly'],
          scopeSeparator: ' ',
          pkce: false,
        },
      }),
    ];
    mockSelectableProfiles = [{ id: 'ap-oauth', authType: 'oauth2_app' }];
    render(<CreateConnectionModal {...defaultProps} />);

    fireEvent.click(screen.getByText('Google Drive'));

    expect(screen.getByTestId('auth-profile-picker')).toBeDefined();
    const createBtn = screen.getByText('Create Connection');
    expect(createBtn.hasAttribute('disabled')).toBe(true);
  });

  it('enables create connection button when auth profile is selected for oauth', () => {
    mockConnectors = [
      makeConnector({
        name: 'google-drive',
        displayName: 'Google Drive',
        authType: 'oauth2',
        oauth2: {
          authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
          tokenUrl: 'https://oauth2.googleapis.com/token',
          defaultScopes: ['drive.readonly'],
          scopeSeparator: ' ',
          pkce: false,
        },
      }),
    ];
    mockSelectableProfiles = [{ id: 'ap-oauth', authType: 'oauth2_app' }];
    render(<CreateConnectionModal {...defaultProps} />);

    fireEvent.click(screen.getByText('Google Drive'));
    selectAuthProfile('ap-oauth');

    const createBtn = screen.getByText('Create Connection');
    expect(createBtn.hasAttribute('disabled')).toBe(false);
  });
});
