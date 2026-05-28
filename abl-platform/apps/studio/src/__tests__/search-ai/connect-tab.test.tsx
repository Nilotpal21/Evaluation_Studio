/**
 * Tests for ConnectTab — unified SharePoint connection flow, auth method
 * selection, and submit gating.
 *
 * The global setup.tsx mock loads real English translations from studio.json.
 * Tests query by the resolved English text.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Real English translations (resolved by setup.tsx from studio.json)
const TEXT = {
  welcomeTitle: 'Let us get you connected to SharePoint',
  nameLabel: 'Connector name',
  nameHelpFirstTime: 'Optional now — system will suggest after discovery',
  clientIdLabel: 'Client ID (Application ID)',
  tenantIdLabel: 'Tenant ID (Directory ID)',
  btnConnect: 'Connect',
};

// ─── Mock lucide-react (CRITICAL) ──────────────────────────────────────
vi.mock('lucide-react', () => {
  const n = () => null;
  return {
    Loader2: n,
    Copy: n,
    Check: n,
    ExternalLink: n,
    Building2: n,
    LogIn: n,
    MonitorSmartphone: n,
    Globe: n,
    Key: n,
    Shield: n,
    AlertTriangle: n,
    Info: n,
    ChevronDown: n,
    Lock: n,
    Plus: n,
    X: n,
  };
});

// ─── Mock SWR ──────────────────────────────────────────────────────────
const mockMutate = vi.fn();
let mockSwrReturn: Record<string, unknown> = {
  data: undefined,
  error: undefined,
  isLoading: false,
  isValidating: false,
  mutate: mockMutate,
};

vi.mock('swr', () => ({
  default: vi.fn(() => mockSwrReturn),
}));

// ─── Mock sanitize-error ───────────────────────────────────────────────
vi.mock('@/lib/sanitize-error', () => ({
  sanitizeError: (_e: unknown, fallback: string) => fallback,
}));

// ─── Mock sonner toast ─────────────────────────────────────────────────
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

// ─── Mock API ──────────────────────────────────────────────────────────
vi.mock('../../api/search-ai', () => ({
  createEnterpriseConnector: vi.fn(),
  initiateConnectorAuth: vi.fn(),
  getConnectorAuthStatus: vi.fn(),
  generateAdminEmail: vi.fn(),
  renameSource: vi.fn(),
  updateCitationConfig: vi.fn().mockResolvedValue({}),
}));

// ─── Mock sub-components to avoid their dependency chains ──────────────
vi.mock('../../components/search-ai/sharepoint/AuthMethodSelector', () => ({
  AuthMethodSelector: ({
    selectedMethod,
    onMethodChange,
  }: {
    selectedMethod: string | null;
    onMethodChange: (method: string) => void;
  }) => (
    <div data-testid="auth-method-selector">
      <button onClick={() => onMethodChange('device_code')}>Select Device Code</button>
      <button onClick={() => onMethodChange('authorization_code')}>Select Browser Login</button>
      <button onClick={() => onMethodChange('client_credentials')}>
        Select Client Credentials
      </button>
      {selectedMethod && <span data-testid="selected-method">{selectedMethod}</span>}
    </div>
  ),
}));

vi.mock('../../components/search-ai/sharepoint/ConnectionScopesDisplay', () => ({
  ConnectionScopesDisplay: () => <div data-testid="connection-scopes">Scopes</div>,
}));

vi.mock('../../components/search-ai/sharepoint/ITAdminGuide', () => ({
  ITAdminGuide: () => <div data-testid="it-admin-guide">ITAdminGuide</div>,
}));

// ─── Mock hooks ────────────────────────────────────────────────────────
vi.mock('../../hooks/useConnector', () => ({
  useConnector: () => ({
    connector: null,
    isLoading: false,
    error: null,
    mutate: vi.fn(),
  }),
}));

import { ConnectTab } from '../../components/search-ai/sharepoint/ConnectTab';

describe('ConnectTab', () => {
  const defaultProps = {
    indexId: 'idx-1',
    connectorId: null,
    onAuthComplete: vi.fn(),
    onConnectorCreated: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSwrReturn = {
      data: undefined,
      error: undefined,
      isLoading: false,
      isValidating: false,
      mutate: mockMutate,
    };
  });

  // ─── Unified layout ──────────────────────────────────────────────────

  it('renders the unified SharePoint connection flow', () => {
    render(<ConnectTab {...defaultProps} />);

    expect(screen.getByText(TEXT.welcomeTitle)).toBeInTheDocument();
    expect(screen.getByText(TEXT.nameLabel)).toBeInTheDocument();
    expect(screen.getByText(TEXT.nameHelpFirstTime)).toBeInTheDocument();
    expect(screen.getByTestId('auth-method-selector')).toBeInTheDocument();
  });

  it('does not pass a first-time or returning variant to the auth selector anymore', () => {
    render(<ConnectTab {...defaultProps} />);

    expect(screen.getByTestId('auth-method-selector')).not.toHaveAttribute('data-variant');
  });

  // ─── Auth method selector renders ────────────────────────────────────

  it('renders auth method selector', () => {
    render(<ConnectTab {...defaultProps} />);
    expect(screen.getByTestId('auth-method-selector')).toBeInTheDocument();
  });

  it('renders Connection Scopes display', () => {
    render(<ConnectTab {...defaultProps} />);
    expect(screen.getByTestId('connection-scopes')).toBeInTheDocument();
  });

  // ─── Name input ──────────────────────────────────────────────────────

  it('renders name input for first-time user', () => {
    render(<ConnectTab {...defaultProps} />);
    // Name label is rendered
    expect(screen.getByText(TEXT.nameLabel)).toBeInTheDocument();
  });

  it('renders name input with the current discovery-first helper text', () => {
    render(<ConnectTab {...defaultProps} />);

    expect(screen.getByText(TEXT.nameLabel)).toBeInTheDocument();
    expect(screen.getByText(TEXT.nameHelpFirstTime)).toBeInTheDocument();
  });

  // ─── Client ID / Tenant ID fields ───────────────────────────────────

  it('shows Client ID/Tenant ID fields only after selecting an auth method', () => {
    render(<ConnectTab {...defaultProps} />);

    expect(screen.queryByText(TEXT.clientIdLabel)).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Select Device Code'));

    expect(screen.getByText(TEXT.clientIdLabel)).toBeInTheDocument();
    expect(screen.getByText(TEXT.tenantIdLabel)).toBeInTheDocument();
  });

  // ─── Button state ────────────────────────────────────────────────────

  it('shows Connect button for the unified flow', () => {
    render(<ConnectTab {...defaultProps} />);
    expect(screen.getByText(TEXT.btnConnect)).toBeInTheDocument();
  });

  it('Connect button is disabled when no auth method selected', () => {
    render(<ConnectTab {...defaultProps} />);
    const btn = screen.getByText(TEXT.btnConnect).closest('button');
    expect(btn).toBeDisabled();
  });

  it('Connect button is enabled after selecting device code auth', () => {
    render(<ConnectTab {...defaultProps} />);

    fireEvent.click(screen.getByText('Select Device Code'));

    const btn = screen.getByText(TEXT.btnConnect).closest('button');
    expect(btn).not.toBeDisabled();
  });

  // ─── IT Admin Guide ──────────────────────────────────────────────────

  it('shows IT Admin Guide in the unified flow', () => {
    render(<ConnectTab {...defaultProps} />);
    expect(screen.getByTestId('it-admin-guide')).toBeInTheDocument();
  });
});
