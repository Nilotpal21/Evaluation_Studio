'use client';

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Search, X } from 'lucide-react';
import { SlidePanel } from '../ui/SlidePanel';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { ConnectorLogo } from './ConnectorLogo';
import { getAuthTypeShortLabel } from '../auth-profiles/auth-type-metadata';
import type { CatalogConnector } from './CatalogCard';
import type { AuthProfileStatus, AuthProfileSummary } from '../../api/auth-profiles';

interface IntegrationDetailPanelProps {
  connector: CatalogConnector | null;
  authProfiles: AuthProfileSummary[];
  isConfigured: boolean;
  onClose: () => void;
  onConnect: () => void;
  /**
   * Invoked with the full profile so the parent can dispatch on `profile.scope`
   * (workspace-scoped vs project-scoped) and route to the right edit URL.
   */
  onManageProfile: (profile: AuthProfileSummary) => void;
}

const PROFILE_STATUS_LABEL: Record<AuthProfileStatus, string> = {
  active: 'Active',
  pending_authorization: 'Pending',
  expired: 'Expired',
  revoked: 'Revoked',
  invalid: 'Invalid',
};

function profileStatusVariant(
  status: AuthProfileStatus,
): 'success' | 'warning' | 'error' | 'info' | 'default' {
  switch (status) {
    case 'active':
      return 'success';
    case 'pending_authorization':
      return 'info';
    case 'expired':
      return 'warning';
    case 'revoked':
    case 'invalid':
      return 'error';
    default:
      return 'default';
  }
}

interface CapabilityItem {
  name: string;
  displayName: string;
  description?: string;
}

function matchesQuery(item: CapabilityItem, query: string): boolean {
  if (!query) return true;
  const haystack = `${item.displayName} ${item.name} ${item.description ?? ''}`.toLowerCase();
  return haystack.includes(query);
}

export function IntegrationDetailPanel({
  connector,
  authProfiles,
  isConfigured,
  onClose,
  onConnect,
  onManageProfile,
}: IntegrationDetailPanelProps) {
  const [query, setQuery] = useState('');
  const [authProfilesOpen, setAuthProfilesOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [triggersOpen, setTriggersOpen] = useState(false);

  useEffect(() => {
    setQuery('');
    setAuthProfilesOpen(false);
    setActionsOpen(false);
    setTriggersOpen(false);
  }, [connector?.name]);

  const normalizedQuery = query.trim().toLowerCase();

  const filteredActions = useMemo(
    () => (connector?.actions ?? []).filter((action) => matchesQuery(action, normalizedQuery)),
    [connector, normalizedQuery],
  );

  const filteredTriggers = useMemo(
    () => (connector?.triggers ?? []).filter((trigger) => matchesQuery(trigger, normalizedQuery)),
    [connector, normalizedQuery],
  );

  const authSummary =
    connector?.availableAuthTypes && connector.availableAuthTypes.length > 0
      ? connector.availableAuthTypes.map(getAuthTypeShortLabel).join(' • ')
      : null;

  const hasActions = (connector?.actions.length ?? 0) > 0;
  const hasTriggers = (connector?.triggers.length ?? 0) > 0;
  const hasCapabilities = hasActions || hasTriggers;
  // When the user types in the search box, force-expand the capability
  // sections so matches are immediately visible without an extra click.
  const isSearching = normalizedQuery.length > 0;
  const effectiveActionsOpen = actionsOpen || isSearching;
  const effectiveTriggersOpen = triggersOpen || isSearching;

  return (
    <SlidePanel open={connector !== null} onClose={onClose} width="lg" noPadding>
      {connector && (
        <div className="flex h-full flex-col" data-testid="integration-detail-panel">
          {/* Top header: logo + heading + close */}
          <div className="flex items-start gap-3 border-b border-default p-4">
            <ConnectorLogo name={connector.name} className="h-10 w-10 shrink-0" />
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-base font-semibold text-foreground">
                {connector.displayName}
              </h2>
              {connector.description && (
                <p
                  className="mt-0.5 text-xs leading-relaxed text-muted"
                  data-testid="panel-description"
                >
                  {connector.description}
                </p>
              )}
              {authSummary && (
                <p className="mt-0.5 truncate text-xs text-muted">Auth: {authSummary}</p>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close panel"
              className="rounded-lg p-1.5 text-muted transition-default hover:bg-background-muted hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 space-y-6 overflow-y-auto p-6">
            {/* Search + Connect action row */}
            <div className="flex items-center gap-3">
              {hasCapabilities && (
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                  <input
                    type="text"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search actions and triggers..."
                    aria-label="Search actions and triggers"
                    data-testid="capability-search"
                    className="w-full rounded-lg border border-default bg-background py-2 pl-10 pr-4 text-sm text-foreground placeholder:text-muted focus:border-border-focus focus:outline-none focus:ring-1 focus:ring-border-focus"
                  />
                </div>
              )}
              <Button
                variant="primary"
                size="sm"
                onClick={onConnect}
                data-testid="panel-connect-button"
                className={hasCapabilities ? 'shrink-0' : 'ml-auto shrink-0'}
              >
                {isConfigured ? 'Manage' : 'Connect'}
              </Button>
            </div>

            {hasCapabilities ? (
              <>
                {hasActions && (
                  <section data-testid="actions-section">
                    <button
                      type="button"
                      onClick={() => setActionsOpen((open) => !open)}
                      aria-expanded={effectiveActionsOpen}
                      aria-controls="actions-content"
                      data-testid="actions-toggle"
                      className="mb-3 flex w-full items-center gap-2 text-left transition-default hover:text-foreground"
                    >
                      {effectiveActionsOpen ? (
                        <ChevronDown className="h-3.5 w-3.5 text-muted" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 text-muted" />
                      )}
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
                        Actions
                      </h3>
                      <span className="text-xs text-muted">
                        {isSearching
                          ? `${filteredActions.length}/${connector.actions.length}`
                          : connector.actions.length}
                      </span>
                    </button>
                    {effectiveActionsOpen && (
                      <div id="actions-content">
                        {filteredActions.length === 0 ? (
                          <p className="text-xs text-muted">No actions match your search.</p>
                        ) : (
                          <ul className="space-y-2">
                            {filteredActions.map((action) => (
                              <li
                                key={action.name}
                                className="rounded-lg border border-default p-3"
                                data-testid={`action-${action.name}`}
                              >
                                <p className="text-sm font-medium text-foreground">
                                  {action.displayName}
                                </p>
                                {action.description && (
                                  <p className="mt-1 text-xs leading-relaxed text-muted">
                                    {action.description}
                                  </p>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </section>
                )}

                {hasTriggers && (
                  <section data-testid="triggers-section">
                    <button
                      type="button"
                      onClick={() => setTriggersOpen((open) => !open)}
                      aria-expanded={effectiveTriggersOpen}
                      aria-controls="triggers-content"
                      data-testid="triggers-toggle"
                      className="mb-3 flex w-full items-center gap-2 text-left transition-default hover:text-foreground"
                    >
                      {effectiveTriggersOpen ? (
                        <ChevronDown className="h-3.5 w-3.5 text-muted" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 text-muted" />
                      )}
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
                        Triggers
                      </h3>
                      <span className="text-xs text-muted">
                        {isSearching
                          ? `${filteredTriggers.length}/${connector.triggers.length}`
                          : connector.triggers.length}
                      </span>
                    </button>
                    {effectiveTriggersOpen && (
                      <div id="triggers-content">
                        {filteredTriggers.length === 0 ? (
                          <p className="text-xs text-muted">No triggers match your search.</p>
                        ) : (
                          <ul className="space-y-2">
                            {filteredTriggers.map((trigger) => (
                              <li
                                key={trigger.name}
                                className="rounded-lg border border-default p-3"
                                data-testid={`trigger-${trigger.name}`}
                              >
                                <p className="text-sm font-medium text-foreground">
                                  {trigger.displayName}
                                </p>
                                {trigger.description && (
                                  <p className="mt-1 text-xs leading-relaxed text-muted">
                                    {trigger.description}
                                  </p>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </section>
                )}
              </>
            ) : (
              <p
                className="rounded-lg border border-dashed border-default p-4 text-center text-sm text-muted"
                data-testid="no-capabilities"
              >
                No actions or triggers are catalogued for this integration.
              </p>
            )}

            <section data-testid="auth-profiles-section">
              <button
                type="button"
                onClick={() => setAuthProfilesOpen((open) => !open)}
                aria-expanded={authProfilesOpen}
                aria-controls="auth-profiles-content"
                data-testid="auth-profiles-toggle"
                className="mb-3 flex w-full items-center gap-2 text-left transition-default hover:text-foreground"
              >
                {authProfilesOpen ? (
                  <ChevronDown className="h-3.5 w-3.5 text-muted" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 text-muted" />
                )}
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
                  Configured auth profiles
                </h3>
                <span className="text-xs text-muted">{authProfiles.length}</span>
              </button>
              {authProfilesOpen && (
                <div id="auth-profiles-content">
                  {authProfiles.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-default p-3 text-xs text-muted">
                      No auth profiles configured yet. Use{' '}
                      <span className="font-medium text-foreground">
                        {isConfigured ? 'Manage' : 'Connect'}
                      </span>{' '}
                      to add one.
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {authProfiles.map((profile) => (
                        <li
                          key={profile.id}
                          className="flex items-center gap-3 rounded-lg border border-default p-3"
                          data-testid={`auth-profile-${profile.id}`}
                        >
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-foreground">
                              {profile.name}
                            </p>
                            {profile.description && (
                              <p className="truncate text-xs text-muted">{profile.description}</p>
                            )}
                          </div>
                          <Badge
                            variant={profileStatusVariant(profile.status)}
                            appearance="outlined"
                          >
                            {PROFILE_STATUS_LABEL[profile.status]}
                          </Badge>
                          <Button
                            variant="secondary"
                            size="xs"
                            onClick={() => onManageProfile(profile)}
                          >
                            Manage
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </section>
          </div>
        </div>
      )}
    </SlidePanel>
  );
}
