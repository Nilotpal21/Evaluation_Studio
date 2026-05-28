/**
 * ConnectionsPage Tests
 *
 * Tests covering loading, error, empty, grouped connections/catalog,
 * search filtering, and modal interactions.
 *
 * @vitest-environment happy-dom
 */

import React, { createElement } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ConnectionSummary } from '../api/connections';

// =============================================================================
// MOCKS
// =============================================================================

// lucide-react and framer-motion are mocked globally in setup.tsx — no local override needed.

// SWR — override the global mock (setup.tsx does not mock SWR)
const mockMutate = vi.fn();
let mockSwrReturn = {
  data: undefined as unknown,
  error: undefined as unknown,
  isLoading: false,
  mutate: mockMutate,
};
vi.mock('swr', () => ({
  default: vi.fn(() => mockSwrReturn),
}));

// --- Child component stubs ---

vi.mock('../components/connections/ConnectionStatusBar', () => ({
  ConnectionStatusBar: () => createElement('div', { 'data-testid': 'status-bar' }),
}));

vi.mock('../components/connections/ConnectionCard', () => ({
  ConnectionCard: ({
    connection,
  }: {
    connection: ConnectionSummary;
    isExpanded: boolean;
    onClick: () => void;
  }) => createElement('div', { 'data-testid': `card-${connection.id}` }, connection.displayName),
}));

vi.mock('../components/connections/ConnectionExpandPanel', () => ({
  ConnectionExpandPanel: () => createElement('div', { 'data-testid': 'expand-panel' }),
}));

vi.mock('../components/connections/CatalogCard', () => ({
  CatalogCard: ({
    connector,
    onConnect,
  }: {
    connector: { name: string; displayName: string };
    isConnected: boolean;
    onConnect: () => void;
  }) =>
    createElement(
      'div',
      { 'data-testid': `catalog-${connector.name}` },
      connector.displayName,
      createElement(
        'button',
        { 'data-testid': `connect-${connector.name}`, onClick: onConnect },
        'Connect',
      ),
    ),
}));

// CreateConnectionModal mock removed — ConnectionsPage no longer renders it
// (ABLP-913: credential setup moved exclusively to the auth-profiles page).

vi.mock('../components/connections/AgentDesktopConnectionDialog', () => ({
  AgentDesktopConnectionDialog: ({
    open,
    preselectedProviderId,
  }: {
    open: boolean;
    onClose: () => void;
    projectId: string;
    onCreated: () => void;
    preselectedProviderId?: string | null;
  }) =>
    open
      ? createElement(
          'div',
          { 'data-testid': 'agent-desktop-modal' },
          preselectedProviderId
            ? `agent-desktop:${preselectedProviderId}`
            : 'agent-desktop-connection-modal',
        )
      : null,
}));

vi.mock('../components/connections/ConnectorLogo', () => ({
  ConnectorLogo: () => null,
}));

vi.mock('../components/ui/EmptyState', () => ({
  EmptyState: ({
    title,
    description,
    action,
  }: {
    title: string;
    description?: string;
    action?: React.ReactNode;
  }) =>
    createElement(
      'div',
      { 'data-testid': 'empty-state' },
      createElement('span', null, title),
      description ? createElement('span', null, description) : null,
      action ?? null,
    ),
}));

vi.mock('../components/ui/Button', () => ({
  Button: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    variant?: string;
    size?: string;
  }) => createElement('button', { onClick }, children),
}));

// Navigation store — navigate is observable so tests can assert routing.
const mockNavigate = vi.fn();
let navStoreState: Record<string, unknown> = { projectId: 'proj-1', navigate: mockNavigate };
vi.mock('../store/navigation-store', () => ({
  useNavigationStore: vi.fn((sel?: (s: Record<string, unknown>) => unknown) =>
    sel ? sel(navStoreState) : navStoreState,
  ),
}));

// Connections hook
let mockConnectionsReturn = {
  connections: [] as ConnectionSummary[],
  isLoading: false,
  error: null as string | null,
  refresh: vi.fn(),
};
vi.mock('../hooks/useConnections', () => ({
  useConnections: () => mockConnectionsReturn,
}));

// Available connectors hook
let mockConnectorsReturn = {
  connectors: [] as Array<Record<string, unknown>>,
  isLoading: false,
  error: null as string | null,
  refresh: vi.fn(),
};
vi.mock('../hooks/useAvailableConnectors', () => ({
  useAvailableConnectors: () => mockConnectorsReturn,
}));

// Auth profiles hook (used by ConnectionsPage for auth profile status map)
vi.mock('../hooks/useAuthProfiles', () => ({
  useAuthProfile: () => ({
    profile: null,
    isLoading: false,
    error: null,
    errorStatus: null,
    refresh: vi.fn(),
  }),
  useAuthProfiles: () => ({
    profiles: [],
    total: 0,
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  }),
  // ABLP-1123: workspace-surface stubs for mock-export-drift guard
  useWorkspaceAuthProfiles: () => ({
    profiles: [],
    total: 0,
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  }),
  buildWorkspaceAuthProfilesKey: vi.fn(),
}));

// Sanitize error
vi.mock('../lib/sanitize-error', () => ({
  sanitizeError: (err: unknown, fallback: string) =>
    err instanceof Error ? err.message : typeof err === 'string' ? err : fallback,
  sanitizeErrors: (err: unknown, fallback: string) => [
    err instanceof Error ? err.message : typeof err === 'string' ? err : fallback,
  ],
  sanitizeServerError: (msg: string | undefined, fallback: string) => msg ?? fallback,
}));

// =============================================================================
// FACTORIES
// =============================================================================

function makeCatalogConnector(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: 'slack',
    displayName: 'Slack',
    description: 'Slack integration',
    category: 'communication',
    authType: 'oauth2',
    actions: [{ name: 'send_message', displayName: 'Send Message', description: 'Send a message' }],
    triggers: [],
    ...overrides,
  };
}

// =============================================================================
// IMPORT UNDER TEST (must come after mocks)
// =============================================================================

import { ConnectionsPage } from '../components/connections/ConnectionsPage';

// =============================================================================
// TESTS
// =============================================================================

describe('ConnectionsPage', () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    navStoreState = { projectId: 'proj-1', navigate: mockNavigate };
    mockConnectionsReturn = {
      connections: [],
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    };
    mockConnectorsReturn = {
      connectors: [],
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    };
    mockSwrReturn = {
      data: undefined,
      error: undefined,
      isLoading: false,
      mutate: mockMutate,
    };
  });

  // -------------------------------------------------------------------------
  // 1. Loading state
  // -------------------------------------------------------------------------
  it('shows skeleton cards when both hooks are loading', () => {
    mockConnectionsReturn = {
      connections: [],
      isLoading: true,
      error: null,
      refresh: vi.fn(),
    };
    mockConnectorsReturn = {
      connectors: [],
      isLoading: true,
      error: null,
      refresh: vi.fn(),
    };

    const { container } = render(<ConnectionsPage />);
    const skeletons = container.querySelectorAll('.skeleton');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 2. Error state
  // -------------------------------------------------------------------------
  it('shows error state with Retry button when useConnections returns error', () => {
    mockConnectionsReturn = {
      connections: [],
      isLoading: false,
      error: 'Network error',
      refresh: vi.fn(),
    };
    mockConnectorsReturn = {
      connectors: [makeCatalogConnector()],
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    };

    render(<ConnectionsPage />);

    expect(screen.getByText('Failed to load connections')).toBeTruthy();
    expect(screen.getByText('Retry')).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // 3. Catalog renders even when there are no configured connections.
  //    ABLP-913: the page is now an informational catalog only — there is no
  //    separate "connections" section and no inline "No connections yet" CTA.
  // -------------------------------------------------------------------------
  it('renders the catalog when there are no configured connections', () => {
    mockConnectionsReturn = {
      connections: [],
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    };
    mockConnectorsReturn = {
      connectors: [makeCatalogConnector({ name: 'slack', displayName: 'Slack' })],
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    };

    render(<ConnectionsPage />);

    // Catalog card for Slack is rendered (from the CatalogCard stub).
    expect(screen.getByTestId('catalog-slack')).toBeTruthy();
    expect(screen.getByText('Slack')).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // 4. Catalog grouped by category — connection cards are no longer rendered,
  //    so the previous "connections grouped by category" cases are obsolete.
  // -------------------------------------------------------------------------
  it('renders catalog connectors grouped by category', () => {
    const slackCatalog = makeCatalogConnector({
      name: 'slack',
      displayName: 'Slack',
      category: 'communication',
    });
    const hubspotCatalog = makeCatalogConnector({
      name: 'hubspot',
      displayName: 'HubSpot',
      category: 'crm',
    });

    mockConnectorsReturn = {
      connectors: [slackCatalog, hubspotCatalog],
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    };

    render(<ConnectionsPage />);

    expect(screen.getByText('Slack')).toBeTruthy();
    expect(screen.getByText('HubSpot')).toBeTruthy();
    expect(screen.getByText('Communication')).toBeTruthy();
    expect(screen.getByText('CRM & Sales')).toBeTruthy();
  });

  it('renders agent desktop providers in the catalog under a dedicated section', () => {
    mockConnectorsReturn = {
      connectors: [],
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    };

    render(<ConnectionsPage />);

    expect(screen.getByText('Agent Desktop')).toBeTruthy();
    expect(screen.getByText('Kore SmartAssist')).toBeTruthy();
    expect(screen.getByText('Five9')).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // 5. Search filters catalog cards (the connections section was removed).
  // -------------------------------------------------------------------------
  it('filters catalog by search query', () => {
    const slackCatalog = makeCatalogConnector({
      name: 'slack',
      displayName: 'Slack',
      category: 'communication',
    });
    const hubspotCatalog = makeCatalogConnector({
      name: 'hubspot',
      displayName: 'HubSpot',
      category: 'crm',
    });

    mockConnectorsReturn = {
      connectors: [slackCatalog, hubspotCatalog],
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    };

    render(<ConnectionsPage />);

    // Both displayed before search
    expect(screen.getByText('Slack')).toBeTruthy();
    expect(screen.getByText('HubSpot')).toBeTruthy();

    const searchInput = screen.getByPlaceholderText('Search integrations...');
    fireEvent.change(searchInput, { target: { value: 'slack' } });

    // Slack should remain, HubSpot should be filtered out
    expect(screen.getByText('Slack')).toBeTruthy();
    expect(screen.queryByText('HubSpot')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 6. Catalog Connect navigates to the auth-profiles page.
  //    ABLP-913: clicking Connect on a regular catalog card soft-links to
  //    auth-profiles pre-filtered to that vendor (no modal is opened here).
  // -------------------------------------------------------------------------
  it('navigates to auth-profiles when catalog Connect is clicked', () => {
    const githubCatalog = makeCatalogConnector({
      name: 'github',
      displayName: 'GitHub',
      category: 'ai_dev',
    });

    mockConnectorsReturn = {
      connectors: [githubCatalog],
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    };

    render(<ConnectionsPage />);

    // Click Connect on the catalog card
    fireEvent.click(screen.getByTestId('connect-github'));

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith(
      '/projects/proj-1/settings/auth-profiles?connector=github',
    );
  });

  // -------------------------------------------------------------------------
  // 7. Agent-desktop catalog click opens the dedicated modal (not navigation).
  // -------------------------------------------------------------------------
  it('opens the agent desktop dialog when an agent desktop catalog card is clicked', () => {
    mockConnectorsReturn = {
      connectors: [],
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    };

    render(<ConnectionsPage />);

    expect(screen.queryByTestId('agent-desktop-modal')).toBeNull();

    fireEvent.click(screen.getByTestId('connect-smartassist'));

    const modal = screen.getByTestId('agent-desktop-modal');
    expect(modal).toBeTruthy();
    expect(modal.textContent).toContain('agent-desktop:smartassist');
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
