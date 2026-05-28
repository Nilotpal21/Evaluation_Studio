/**
 * IntegrationDetailPanel tests
 *
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

import { IntegrationDetailPanel } from '../IntegrationDetailPanel';
import type { CatalogConnector } from '../CatalogCard';
import type { AuthProfileSummary } from '../../../api/auth-profiles';

function buildConnector(overrides: Partial<CatalogConnector> = {}): CatalogConnector {
  return {
    name: 'github',
    displayName: 'GitHub',
    description: 'Developer platform',
    category: 'ai_dev',
    authType: 'oauth2',
    availableAuthTypes: ['oauth2'],
    actions: [
      { name: 'create_issue', displayName: 'Create Issue', description: 'Open a new issue' },
      { name: 'lock_issue', displayName: 'Lock Issue', description: 'Lock an issue thread' },
    ],
    triggers: [{ name: 'on_push', displayName: 'On Push', description: 'When code is pushed' }],
    ...overrides,
  };
}

function buildProfile(overrides: Partial<AuthProfileSummary> = {}): AuthProfileSummary {
  return {
    id: 'profile_1',
    name: 'GitHub Production',
    description: 'Org-wide token',
    authType: 'oauth2',
    usageMode: 'preconfigured',
    status: 'active',
    environment: 'production',
    visibility: 'shared',
    connectionMode: 'shared',
    scope: 'project',
    profileType: 'integration',
    connector: 'github',
    category: 'ai_dev',
    tags: [],
    linkedConsumerCount: 0,
    lastUsedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    createdBy: 'user_1',
    ...overrides,
  };
}

describe('IntegrationDetailPanel', () => {
  it('renders nothing when no connector is selected', () => {
    render(
      <IntegrationDetailPanel
        connector={null}
        authProfiles={[]}
        isConfigured={false}
        onClose={vi.fn()}
        onConnect={vi.fn()}
        onManageProfile={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('integration-detail-panel')).toBeNull();
  });

  it('renders actions and triggers in collapsible sections, default closed', () => {
    render(
      <IntegrationDetailPanel
        connector={buildConnector()}
        authProfiles={[]}
        isConfigured={false}
        onClose={vi.fn()}
        onConnect={vi.fn()}
        onManageProfile={vi.fn()}
      />,
    );

    // Default collapsed
    expect(screen.queryByTestId('action-create_issue')).toBeNull();
    expect(screen.queryByTestId('trigger-on_push')).toBeNull();
    expect(screen.getByTestId('actions-toggle')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('triggers-toggle')).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(screen.getByTestId('actions-toggle'));
    const actions = screen.getByTestId('actions-section');
    expect(within(actions).getByText('Create Issue')).toBeInTheDocument();
    expect(within(actions).getByText('Open a new issue')).toBeInTheDocument();
    expect(within(actions).getByText('Lock Issue')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('triggers-toggle'));
    const triggers = screen.getByTestId('triggers-section');
    expect(within(triggers).getByText('On Push')).toBeInTheDocument();
    expect(within(triggers).getByText('When code is pushed')).toBeInTheDocument();
    // Triggers section should NOT contain action names — segregation check
    expect(within(triggers).queryByText('Create Issue')).toBeNull();
  });

  it('search filters both actions and triggers independently', () => {
    render(
      <IntegrationDetailPanel
        connector={buildConnector()}
        authProfiles={[]}
        isConfigured={false}
        onClose={vi.fn()}
        onConnect={vi.fn()}
        onManageProfile={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByTestId('capability-search'), { target: { value: 'lock' } });

    const actions = screen.getByTestId('actions-section');
    expect(within(actions).getByText('Lock Issue')).toBeInTheDocument();
    expect(within(actions).queryByText('Create Issue')).toBeNull();

    const triggers = screen.getByTestId('triggers-section');
    expect(within(triggers).getByText('No triggers match your search.')).toBeInTheDocument();
  });

  it('shows configured auth profiles with status badge and Manage button (after expanding)', () => {
    const onManageProfile = vi.fn();
    render(
      <IntegrationDetailPanel
        connector={buildConnector()}
        authProfiles={[
          buildProfile(),
          buildProfile({ id: 'profile_2', name: 'Sandbox', status: 'expired' }),
        ]}
        isConfigured
        onClose={vi.fn()}
        onConnect={vi.fn()}
        onManageProfile={onManageProfile}
      />,
    );

    // Section is collapsed by default — content is hidden until toggled.
    expect(screen.queryByTestId('auth-profile-profile_1')).toBeNull();
    fireEvent.click(screen.getByTestId('auth-profiles-toggle'));

    const section = screen.getByTestId('auth-profiles-section');
    expect(within(section).getByText('GitHub Production')).toBeInTheDocument();
    expect(within(section).getByText('Sandbox')).toBeInTheDocument();
    expect(within(section).getByText('Active')).toBeInTheDocument();
    expect(within(section).getByText('Expired')).toBeInTheDocument();

    const firstRow = screen.getByTestId('auth-profile-profile_1');
    fireEvent.click(within(firstRow).getByRole('button', { name: /manage/i }));
    expect(onManageProfile).toHaveBeenCalledTimes(1);
    expect(onManageProfile.mock.calls[0][0]).toMatchObject({ id: 'profile_1', scope: 'project' });
  });

  it('shows empty state when no auth profiles are configured (after expanding)', () => {
    render(
      <IntegrationDetailPanel
        connector={buildConnector()}
        authProfiles={[]}
        isConfigured={false}
        onClose={vi.fn()}
        onConnect={vi.fn()}
        onManageProfile={vi.fn()}
      />,
    );

    // Collapsed by default — expand first.
    fireEvent.click(screen.getByTestId('auth-profiles-toggle'));
    const section = screen.getByTestId('auth-profiles-section');
    expect(within(section).getByText(/no auth profiles configured/i)).toBeInTheDocument();
  });

  it('renders no-capabilities placeholder when actions and triggers are both empty', () => {
    render(
      <IntegrationDetailPanel
        connector={buildConnector({ actions: [], triggers: [] })}
        authProfiles={[]}
        isConfigured={false}
        onClose={vi.fn()}
        onConnect={vi.fn()}
        onManageProfile={vi.fn()}
      />,
    );

    expect(screen.getByTestId('no-capabilities')).toBeInTheDocument();
    expect(screen.queryByTestId('actions-section')).toBeNull();
    expect(screen.queryByTestId('triggers-section')).toBeNull();
    expect(screen.queryByTestId('capability-search')).toBeNull();
  });

  it('renders connector description in the header', () => {
    render(
      <IntegrationDetailPanel
        connector={buildConnector({ description: 'Instant messaging and VoIP social platform' })}
        authProfiles={[]}
        isConfigured={false}
        onClose={vi.fn()}
        onConnect={vi.fn()}
        onManageProfile={vi.fn()}
      />,
    );

    expect(screen.getByTestId('panel-description')).toHaveTextContent(
      /instant messaging and voip social platform/i,
    );
  });

  it('collapses and re-expands the auth profiles section', () => {
    render(
      <IntegrationDetailPanel
        connector={buildConnector()}
        authProfiles={[buildProfile()]}
        isConfigured
        onClose={vi.fn()}
        onConnect={vi.fn()}
        onManageProfile={vi.fn()}
      />,
    );

    // Default collapsed: profile row not rendered
    expect(screen.queryByTestId('auth-profile-profile_1')).toBeNull();
    expect(screen.getByTestId('auth-profiles-toggle')).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(screen.getByTestId('auth-profiles-toggle'));
    expect(screen.getByTestId('auth-profile-profile_1')).toBeInTheDocument();
    expect(screen.getByTestId('auth-profiles-toggle')).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(screen.getByTestId('auth-profiles-toggle'));
    expect(screen.queryByTestId('auth-profile-profile_1')).toBeNull();
    expect(screen.getByTestId('auth-profiles-toggle')).toHaveAttribute('aria-expanded', 'false');
  });

  it('Connect button in panel header triggers onConnect', () => {
    const onConnect = vi.fn();
    render(
      <IntegrationDetailPanel
        connector={buildConnector()}
        authProfiles={[]}
        isConfigured={false}
        onClose={vi.fn()}
        onConnect={onConnect}
        onManageProfile={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('panel-connect-button'));
    expect(onConnect).toHaveBeenCalledTimes(1);
  });
});
