/**
 * IntegrationCard Component Tests
 *
 * Tests for the expandable connector card — collapsed/expanded states,
 * profile rows, workspace badge, unsupported badge, and create button.
 *
 * NOTE: This is a UNIT test for a component whose name happens to contain
 * "integration". vi.mock() is appropriate here — we mock framer-motion
 * animation wrappers, not codebase services.
 *
 * @vitest-environment happy-dom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// =============================================================================
// MOCKS
// =============================================================================

vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
      <div {...props}>{children}</div>
    ),
  },
  AnimatePresence: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import { IntegrationCard } from '@/components/auth-profiles/IntegrationCard';
import type { IntegrationProvider } from '@/api/auth-profiles';

// =============================================================================
// HELPERS
// =============================================================================

const t = (key: string, values?: Record<string, unknown>) => {
  if (values) return `${key}:${JSON.stringify(values)}`;
  return key;
};

function makeProvider(overrides: Partial<IntegrationProvider> = {}): IntegrationProvider {
  return {
    connectorName: 'gmail',
    displayName: 'Gmail',
    description: 'Email service',
    category: 'communication',
    availableAuthTypes: ['oauth2'],
    oauth2: {
      authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      defaultScopes: ['gmail.send'],
      pkce: false,
    },
    profileCount: 0,
    profiles: [],
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('IntegrationCard', () => {
  const defaultProps = {
    scope: 'project' as const,
    onCreateProfile: vi.fn(),
    t,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders connector name, auth type badge, and profile count in collapsed state', () => {
    const provider = makeProvider({ profileCount: 3 });

    render(<IntegrationCard {...defaultProps} provider={provider} />);

    expect(screen.getByText('Gmail')).toBeInTheDocument();
    expect(screen.getByText('gmail')).toBeInTheDocument();
    expect(screen.getByText('oauth2')).toBeInTheDocument();
    expect(screen.getByText('integrations.profiles_count:{"count":3}')).toBeInTheDocument();
  });

  it('expands on click to show profile rows and create button', () => {
    const provider = makeProvider({
      profiles: [
        {
          id: 'p1',
          name: 'Gmail-Shared',
          scope: 'project',
          usageMode: 'preconfigured',
          authType: 'oauth2_app',
          status: 'active',
        },
      ],
      profileCount: 1,
    });

    render(<IntegrationCard {...defaultProps} provider={provider} />);

    // Expand
    const toggleButton = screen.getByRole('button', { expanded: false });
    fireEvent.click(toggleButton);

    // Profile row visible
    expect(screen.getByText('Gmail-Shared')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('oauth2_app')).toBeInTheDocument();

    // Create button visible
    expect(screen.getByText('integrations.create_new_profile')).toBeInTheDocument();
  });

  it('calls onCreateProfile when create button is clicked', () => {
    const onCreateProfile = vi.fn();
    const provider = makeProvider();

    render(
      <IntegrationCard {...defaultProps} provider={provider} onCreateProfile={onCreateProfile} />,
    );

    // Expand
    fireEvent.click(screen.getByRole('button', { expanded: false }));

    // Click create
    fireEvent.click(screen.getByText('integrations.create_new_profile'));

    expect(onCreateProfile).toHaveBeenCalledTimes(1);
  });

  it('shows unsupported badge and hides create button for unsupported connectors', () => {
    const provider = makeProvider({
      connectorName: 'postgres',
      displayName: 'Postgres',
      availableAuthTypes: [],
      oauth2: undefined,
    });

    render(<IntegrationCard {...defaultProps} provider={provider} />);

    // Unsupported badge visible
    expect(screen.getByText('integrations.unsupported_badge')).toBeInTheDocument();

    // Expand
    fireEvent.click(screen.getByRole('button'));

    // No create button
    expect(screen.queryByText('integrations.create_new_profile')).not.toBeInTheDocument();
  });

  it('shows workspace badge for tenant-scoped profiles at project scope', () => {
    const provider = makeProvider({
      profiles: [
        {
          id: 'p1',
          name: 'Gmail-Workspace',
          scope: 'tenant',
          usageMode: 'preconfigured',
          authType: 'oauth2_app',
          status: 'active',
        },
      ],
      profileCount: 1,
    });

    render(<IntegrationCard {...defaultProps} scope="project" provider={provider} />);

    // Expand
    fireEvent.click(screen.getByRole('button', { expanded: false }));

    // Workspace badge visible
    expect(screen.getByText('integrations.workspace_badge')).toBeInTheDocument();
  });

  it('does NOT show workspace badge for tenant-scoped profiles at workspace scope', () => {
    const provider = makeProvider({
      profiles: [
        {
          id: 'p1',
          name: 'Gmail-Workspace',
          scope: 'tenant',
          usageMode: 'preconfigured',
          authType: 'oauth2_app',
          status: 'active',
        },
      ],
      profileCount: 1,
    });

    render(<IntegrationCard {...defaultProps} scope="workspace" provider={provider} />);

    // Expand
    fireEvent.click(screen.getByRole('button', { expanded: false }));

    // No workspace badge
    expect(screen.queryByText('integrations.workspace_badge')).not.toBeInTheDocument();
  });

  it('renders multiple auth type badges when connector supports multiple types', () => {
    const provider = makeProvider({
      availableAuthTypes: ['oauth2', 'oauth2_client_credentials', 'api_key'],
    });

    render(<IntegrationCard {...defaultProps} provider={provider} />);

    expect(screen.getByText('oauth2')).toBeInTheDocument();
    expect(screen.getByText('Client Creds')).toBeInTheDocument();
    expect(screen.getByText('+1')).toBeInTheDocument();
  });
});
