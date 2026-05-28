/**
 * Component tests for ConnectionCard, CatalogCard, and ConnectionStatusBar.
 *
 * These are small, presentational connection-management components that
 * render connector info, health status, and catalog availability.
 *
 * @vitest-environment happy-dom
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ConnectionSummary } from '../api/connections';
import type { CatalogConnector } from '../components/connections/CatalogCard';

// ---------------------------------------------------------------------------
// Mocks — ConnectorLogo is a visual-only component, stub it out.
// Button is mocked to a minimal <button> so we can test click handlers.
// The global setup.tsx already mocks lucide-react, framer-motion, and
// next-intl, so we do NOT re-mock those here.
// ---------------------------------------------------------------------------

// Mock the API module to break the import chain:
// ../../api/connections -> ../lib/api-client -> auth-store -> zustand (hangs)
vi.mock('../api/connections', () => ({}));

vi.mock('../components/connections/ConnectorLogo', () => ({
  ConnectorLogo: () => null,
}));

vi.mock('../components/ui/Button', () => ({
  Button: ({
    children,
    onClick,
    ...rest
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    children?: React.ReactNode;
  }) => (
    <button onClick={onClick} {...rest}>
      {children}
    </button>
  ),
}));

// ---------------------------------------------------------------------------
// Imports — after mocks so vi.mock hoisting picks them up
// ---------------------------------------------------------------------------
import { ConnectionCard } from '../components/connections/ConnectionCard';
import { CatalogCard } from '../components/connections/CatalogCard';
import { ConnectionStatusBar } from '../components/connections/ConnectionStatusBar';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeConnection(overrides: Partial<ConnectionSummary> = {}): ConnectionSummary {
  return {
    id: 'conn-1',
    connectorName: 'slack',
    displayName: 'My Slack',
    scope: 'tenant',
    authProfileId: 'ap-1',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeCatalogConnector(overrides: Partial<CatalogConnector> = {}): CatalogConnector {
  return {
    name: 'slack',
    displayName: 'Slack',
    description: 'Slack connector',
    category: 'communication',
    authType: 'oauth2',
    availableAuthTypes: ['oauth2'],
    actions: [{ name: 'send', displayName: 'Send Message', description: 'Send a message' }],
    triggers: [],
    ...overrides,
  };
}

// =============================================================================
// ConnectionCard
// =============================================================================

describe('ConnectionCard', () => {
  it('renders display name and connector name', () => {
    render(
      <ConnectionCard
        connection={makeConnection({ displayName: 'My Slack', connectorName: 'slack' })}
        isExpanded={false}
        onClick={vi.fn()}
      />,
    );

    expect(screen.getByText('My Slack')).toBeInTheDocument();
    expect(screen.getByText('slack')).toBeInTheDocument();
  });

  it('active connection shows green health dot', () => {
    const { container } = render(
      <ConnectionCard
        connection={makeConnection({ status: 'active' })}
        isExpanded={false}
        onClick={vi.fn()}
      />,
    );

    const dot = container.querySelector('.bg-success');
    expect(dot).toBeInTheDocument();
  });

  it('revoked connection shows red health dot', () => {
    const { container } = render(
      <ConnectionCard
        connection={makeConnection({ status: 'revoked' })}
        isExpanded={false}
        onClick={vi.fn()}
      />,
    );

    const dot = container.querySelector('.bg-error');
    expect(dot).toBeInTheDocument();
  });

  it('expired connection shows red health dot', () => {
    const { container } = render(
      <ConnectionCard
        connection={makeConnection({ status: 'expired' })}
        isExpanded={false}
        onClick={vi.fn()}
      />,
    );

    const dot = container.querySelector('.bg-muted');
    expect(dot).toBeInTheDocument();
  });

  it('shows relative time', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    render(
      <ConnectionCard
        connection={makeConnection({ updatedAt: fiveMinAgo })}
        isExpanded={false}
        onClick={vi.fn()}
      />,
    );

    expect(screen.getByText(/5m ago/)).toBeInTheDocument();
  });

  it('shows agent count', () => {
    render(
      <ConnectionCard
        connection={makeConnection()}
        isExpanded={false}
        onClick={vi.fn()}
        agentCount={3}
      />,
    );

    expect(screen.getByText(/3 agents/)).toBeInTheDocument();
  });

  it('shows "No agents" when count is 0', () => {
    render(<ConnectionCard connection={makeConnection()} isExpanded={false} onClick={vi.fn()} />);

    expect(screen.getByText(/No agents/)).toBeInTheDocument();
  });

  it('click handler fires', () => {
    const onClick = vi.fn();
    render(<ConnectionCard connection={makeConnection()} isExpanded={false} onClick={onClick} />);

    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('expanded state applies different border class', () => {
    const { container } = render(
      <ConnectionCard connection={makeConnection()} isExpanded={true} onClick={vi.fn()} />,
    );

    const button = container.querySelector('.border-accent');
    expect(button).toBeInTheDocument();
  });
});

// =============================================================================
// CatalogCard
// =============================================================================

describe('CatalogCard', () => {
  it('renders connector name and action count', () => {
    const connector = makeCatalogConnector({
      displayName: 'Slack',
      actions: [
        { name: 'send', displayName: 'Send Message', description: 'Send a message' },
        { name: 'list', displayName: 'List Channels', description: 'List channels' },
      ],
    });

    render(<CatalogCard connector={connector} isConfigured={false} onConnect={vi.fn()} />);

    expect(screen.getByText('Slack')).toBeInTheDocument();
    expect(screen.getByText(/2 actions/)).toBeInTheDocument();
    // 'oauth2' has no entry in AUTH_TYPE_METADATA, so the short label falls back to the raw key.
    expect(screen.getByText('oauth2')).toBeInTheDocument();
  });

  it('not configured leaves the card body as the connect entry point', () => {
    render(
      <CatalogCard
        connector={makeCatalogConnector()}
        isConfigured={false}
        onConnect={vi.fn()}
        onOpenDetails={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: /^connect$/i })).toBeNull();
    expect(screen.getByRole('button', { name: /view slack details/i })).toBeInTheDocument();
  });

  it('configured shows auth-profile count and Manage button', () => {
    render(
      <CatalogCard
        connector={makeCatalogConnector()}
        isConfigured={true}
        profileCount={2}
        onConnect={vi.fn()}
      />,
    );

    expect(screen.getByText('2 profiles')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /manage/i })).toBeInTheDocument();
  });

  it('unconfigured card opens details without firing manage', () => {
    const onOpenDetails = vi.fn();
    const onConnect = vi.fn();
    render(
      <CatalogCard
        connector={makeCatalogConnector()}
        isConfigured={false}
        onConnect={onConnect}
        onOpenDetails={onOpenDetails}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /view slack details/i }));
    expect(onOpenDetails).toHaveBeenCalledTimes(1);
    expect(onConnect).not.toHaveBeenCalled();
  });

  it('shows trigger count when triggers exist', () => {
    const connector = makeCatalogConnector({
      triggers: [{ name: 'msg', displayName: 'New Message', description: 'A new message' }],
    });

    render(<CatalogCard connector={connector} isConfigured={false} onConnect={vi.fn()} />);

    expect(screen.getByText(/1 trigger/)).toBeInTheDocument();
  });

  it('shows multiple auth types when a connector supports more than one', () => {
    const connector = makeCatalogConnector({
      availableAuthTypes: ['oauth2_app', 'oauth2_client_credentials', 'api_key'],
    });

    render(<CatalogCard connector={connector} isConfigured={false} onConnect={vi.fn()} />);

    expect(screen.getByText('OAuth App')).toBeInTheDocument();
    expect(screen.getByText('Client Creds')).toBeInTheDocument();
    expect(screen.getByText('API Key')).toBeInTheDocument();
  });
});

// =============================================================================
// ConnectionStatusBar
// =============================================================================

describe('ConnectionStatusBar', () => {
  // ABLP-913: status bar is informational only — the "New Connection" CTA was
  // removed when credential setup moved exclusively to the auth-profiles page.

  it('shows connected count', () => {
    const connections = [
      makeConnection({ id: 'c1', status: 'active' }),
      makeConnection({ id: 'c2', status: 'active' }),
    ];

    render(<ConnectionStatusBar connections={connections} catalogCount={5} />);

    expect(screen.getByText(/2 connected/)).toBeInTheDocument();
  });

  it('shows connected and available counts together', () => {
    const connections = [
      makeConnection({ id: 'c1', status: 'active' }),
      makeConnection({ id: 'c2', status: 'active' }),
    ];

    render(<ConnectionStatusBar connections={connections} catalogCount={5} />);

    expect(screen.getByText(/2 connected/)).toBeInTheDocument();
    expect(screen.getByText(/5 available/)).toBeInTheDocument();
  });

  it('shows failed count', () => {
    const connections = [makeConnection({ id: 'c1', status: 'revoked' })];

    render(<ConnectionStatusBar connections={connections} catalogCount={5} />);

    expect(screen.getByText(/1 failed/)).toBeInTheDocument();
  });

  it('shows available count', () => {
    render(<ConnectionStatusBar connections={[]} catalogCount={10} />);

    expect(screen.getByText(/10 available/)).toBeInTheDocument();
  });
});
