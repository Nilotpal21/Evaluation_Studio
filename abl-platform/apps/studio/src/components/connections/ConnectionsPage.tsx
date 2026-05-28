/**
 * ConnectionsPage — Integrations (informational catalog)
 *
 * Per 2026-05-09 Auth Profile review meeting (ABLP-913):
 *   - "My Connections" tab REMOVED — connections concept is deprecated.
 *   - Page is now a single informational view of available integrations.
 *   - Each catalog card carries a "Configure" CTA that soft-links to the
 *     auth-profiles page pre-filtered to that vendor (?connector=<name>).
 *   - No "Connect" / "New connection" CTAs — credential setup happens in
 *     the auth-profiles page only.
 *
 * The legacy hooks/components (useConnections, ConnectionCard, ExpandPanel,
 * CreateConnectionModal) remain in the codebase for migration neutrality
 * but are not imported or rendered here.
 */

'use client';

import { useState, useMemo, useCallback } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useTranslations } from 'next-intl';
import { Diamond, Search } from 'lucide-react';
import { useNavigationStore } from '../../store/navigation-store';
import { useConnections } from '../../hooks/useConnections';
import { useAvailableConnectors } from '../../hooks/useAvailableConnectors';
import { useAuthProfiles } from '../../hooks/useAuthProfiles';
import type { AuthProfileStatus, AuthProfileSummary } from '../../api/auth-profiles';
import { useRegisterPageHeader } from '../../contexts/PageHeaderContext';
import { ConnectionStatusBar } from './ConnectionStatusBar';
import { CatalogCard } from './CatalogCard';
import type { CatalogConnector } from './CatalogCard';
import { IntegrationDetailPanel } from './IntegrationDetailPanel';
import { EmptyState } from '../ui/EmptyState';
import { Button } from '../ui/Button';
import { PageHeader } from '../ui/PageHeader';
import { getConnectorCategory, getCategoryLabel, CATEGORY_ORDER } from './connector-categories';
import type { ConnectionSummary } from '../../api/connections';
import { AgentDesktopConnectionDialog } from './AgentDesktopConnectionDialog';
import { IntegrationManagerDialog } from './IntegrationManagerDialog';
import {
  CONNECTION_BACKED_AGENT_DESKTOP_PROVIDERS,
  type AgentDesktopProvider,
} from './agent-desktop-registry';

// Connectors that surface a custom manager dialog from the catalog tile
// (instead of routing to the auth-profiles page). Docling has `auth.type=none`
// so the auth-profiles redirect lands the user on an empty integration view
// — the manager dialog gives them somewhere meaningful to land
// (rate-limit info + Enable/Disable).
//
// Azure DI used to be in this set with a usage / cost-cap admin panel
// attached. Removed per product call — credentials live on the auth profile,
// the catalog tile's Manage CTA routes to the standard auth-profiles page,
// no separate ops surface needed.
const SPECIAL_INTEGRATION_MANAGER_NAMES = new Set<string>(['docling']);

// =============================================================================
// CONSTANTS
// =============================================================================

const SKELETON_CARD_COUNT = 6;

// =============================================================================
// SKELETON
// =============================================================================

function ConnectionCardSkeleton() {
  return (
    <div className="rounded-xl border border-default bg-background-elevated p-4">
      <div className="flex items-start gap-3">
        <div className="h-8 w-8 rounded-lg skeleton" />
        <div className="flex-1 space-y-2">
          <div className="h-4 w-32 rounded skeleton" />
          <div className="h-3 w-20 rounded skeleton" />
        </div>
        <div className="h-2 w-2 rounded-full skeleton" />
      </div>
      <div className="mt-3 h-3 w-28 rounded skeleton" />
    </div>
  );
}

function ConnectionSkeletonGrid() {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: SKELETON_CARD_COUNT }, (_, i) => (
        <ConnectionCardSkeleton key={i} />
      ))}
    </div>
  );
}

// =============================================================================
// HELPERS
// =============================================================================

type ConnectionDisplayCategory = 'agent_desktop' | (typeof CATEGORY_ORDER)[number];
type CatalogDisplayCategory = 'agent_desktop' | (typeof CATEGORY_ORDER)[number];

const CONNECTION_CATEGORY_ORDER: ConnectionDisplayCategory[] = ['agent_desktop', ...CATEGORY_ORDER];
const CATALOG_CATEGORY_ORDER: CatalogDisplayCategory[] = ['agent_desktop', ...CATEGORY_ORDER];

const AGENT_DESKTOP_PROVIDER_IDS = new Set<string>(
  CONNECTION_BACKED_AGENT_DESKTOP_PROVIDERS.map((provider) => provider.id),
);

const AGENT_DESKTOP_CATALOG_CONNECTORS: CatalogConnector[] =
  CONNECTION_BACKED_AGENT_DESKTOP_PROVIDERS.map((provider) => ({
    name: provider.id,
    displayName: provider.label,
    description: provider.description,
    category: 'agent_desktop',
    authType: provider.authType,
    actions: [],
    triggers: [],
  }));

function getConnectionDisplayCategory(connection: ConnectionSummary): ConnectionDisplayCategory {
  if (connection.category === 'agent_desktop') {
    return 'agent_desktop';
  }

  return getConnectorCategory(connection.connectorName);
}

function getConnectionCategoryLabel(category: ConnectionDisplayCategory): string {
  if (category === 'agent_desktop') {
    return 'Agent Desktop';
  }

  return getCategoryLabel(category);
}

function getCatalogDisplayCategory(connector: CatalogConnector): CatalogDisplayCategory {
  if (connector.category === 'agent_desktop') {
    return 'agent_desktop';
  }

  return getConnectorCategory(connector.name);
}

function getCatalogCategoryLabel(category: CatalogDisplayCategory): string {
  if (category === 'agent_desktop') {
    return 'Agent Desktop';
  }

  return getCategoryLabel(category);
}

function groupConnectionsByCategory(
  items: ConnectionSummary[],
): { category: string; label: string; items: ConnectionSummary[] }[] {
  const groups = new Map<ConnectionDisplayCategory, ConnectionSummary[]>();

  for (const item of items) {
    const category = getConnectionDisplayCategory(item);
    if (!groups.has(category)) {
      groups.set(category, []);
    }
    groups.get(category)!.push(item);
  }

  return CONNECTION_CATEGORY_ORDER.filter((category) => groups.has(category)).map((category) => ({
    category,
    label: getConnectionCategoryLabel(category),
    items: groups.get(category)!,
  }));
}

function groupCatalogByCategory(
  items: CatalogConnector[],
): { category: string; label: string; items: CatalogConnector[] }[] {
  const groups = new Map<CatalogDisplayCategory, CatalogConnector[]>();

  for (const item of items) {
    const category = getCatalogDisplayCategory(item);
    if (!groups.has(category)) {
      groups.set(category, []);
    }
    groups.get(category)!.push(item);
  }

  return CATALOG_CATEGORY_ORDER.filter((category) => groups.has(category)).map((category) => ({
    category,
    label: getCatalogCategoryLabel(category),
    items: groups.get(category)!,
  }));
}

// =============================================================================
// COMPONENT
// =============================================================================

export function ConnectionsPage() {
  const t = useTranslations('nav');
  const { projectId, navigate } = useNavigationStore();
  const { connections, isLoading, error, refresh } = useConnections(projectId);
  const { connectors: catalogConnectors, isLoading: catalogLoading } =
    useAvailableConnectors(projectId);
  // Fetch all auth profiles (no status filter) so we can detect missing/unhealthy profiles
  const { profiles: allAuthProfiles } = useAuthProfiles(projectId, { limit: 500 });
  const [agentDesktopCreateOpen, setAgentDesktopCreateOpen] = useState(false);
  const [agentDesktopPreselect, setAgentDesktopPreselect] = useState<AgentDesktopProvider | null>(
    null,
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [detailConnector, setDetailConnector] = useState<CatalogConnector | null>(null);
  const [managerConnector, setManagerConnector] = useState<{
    name: string;
    displayName: string;
  } | null>(null);

  // Page is an informational catalog only — credential setup happens in
  // auth-profiles per ABLP-913, so no header actions are registered here.
  useRegisterPageHeader(t('integrations'));

  const mergedCatalogConnectors = useMemo(() => {
    const existingCatalogNames = new Set(catalogConnectors.map((connector) => connector.name));
    const agentDesktopConnectors = AGENT_DESKTOP_CATALOG_CONNECTORS.filter(
      (connector) => !existingCatalogNames.has(connector.name),
    );

    return [...agentDesktopConnectors, ...(catalogConnectors as CatalogConnector[])];
  }, [catalogConnectors]);

  // ABLP-913: badge state on the catalog tile reflects auth profiles, not the
  // legacy connection collection. A connector is "configured" when at least
  // one auth profile binds to it via the `connector` field.
  const profileCountByConnector = useMemo(() => {
    const map = new Map<string, number>();
    for (const profile of allAuthProfiles) {
      if (!profile.connector) continue;
      map.set(profile.connector, (map.get(profile.connector) ?? 0) + 1);
    }
    return map;
  }, [allAuthProfiles]);
  const configuredConnectorNames = useMemo(
    () => new Set(profileCountByConnector.keys()),
    [profileCountByConnector],
  );

  // Map auth profile ID → status (null = profile not found)
  const authProfileStatusMap = useMemo(() => {
    const map = new Map<string, AuthProfileStatus | null>();
    for (const conn of connections) {
      if (!conn.authProfileId) {
        map.set(conn.id, null);
        continue;
      }
      const profile = allAuthProfiles.find((p) => p.id === conn.authProfileId);
      map.set(conn.id, profile?.status ?? null);
    }
    return map;
  }, [connections, allAuthProfiles]);

  // Map connection ID → auth profile name
  const authProfileNameMap = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const conn of connections) {
      if (!conn.authProfileId) {
        map.set(conn.id, null);
        continue;
      }
      const profile = allAuthProfiles.find((p) => p.id === conn.authProfileId);
      map.set(conn.id, profile?.name ?? null);
    }
    return map;
  }, [connections, allAuthProfiles]);

  // Filter catalog by search
  const filteredCatalog = useMemo(
    () =>
      mergedCatalogConnectors.filter(
        (c) =>
          !searchQuery ||
          c.displayName.toLowerCase().includes(searchQuery.toLowerCase()) ||
          c.name.toLowerCase().includes(searchQuery.toLowerCase()),
      ),
    [mergedCatalogConnectors, searchQuery],
  );

  // Group catalog by category
  const catalogGroups = useMemo(() => groupCatalogByCategory(filteredCatalog), [filteredCatalog]);

  // Per 2026-05-09 meeting (ABLP-913): "Connect" CTA in the catalog now soft-links
  // to the auth-profiles page pre-filtered to the vendor. Credentials are no longer
  // configured from this page — the auth-profile page is the only credential surface.
  // Exception: SmartAssist and Five9 (agent-desktop providers) open their dedicated
  // configuration modal since they are agent-transfer connectors, not auth-profile based.
  const handleCatalogConnect = useCallback(
    (connectorName: string) => {
      if (!projectId) return;

      if (AGENT_DESKTOP_PROVIDER_IDS.has(connectorName)) {
        setAgentDesktopPreselect(connectorName as AgentDesktopProvider);
        setAgentDesktopCreateOpen(true);
        return;
      }

      // Document-extraction connectors (Docling + Azure DI) open a dedicated
      // manager dialog from the catalog tile. Docling has no auth profile so
      // routing to /settings/auth-profiles is meaningless; Azure DI also
      // needs an operational view (usage + cost-cap) that doesn't fit the
      // auth-profile UI.
      if (SPECIAL_INTEGRATION_MANAGER_NAMES.has(connectorName)) {
        let displayName = connectorName;
        for (const c of mergedCatalogConnectors) {
          if (c.name === connectorName) {
            displayName = c.displayName;
            break;
          }
        }
        setManagerConnector({ name: connectorName, displayName });
        return;
      }

      const path = `/projects/${projectId}/settings/auth-profiles?connector=${encodeURIComponent(connectorName)}`;
      navigate(path);
    },
    [navigate, projectId, mergedCatalogConnectors],
  );

  function handleAgentDesktopModalClose() {
    setAgentDesktopCreateOpen(false);
    setAgentDesktopPreselect(null);
  }

  const detailAuthProfiles = useMemo(() => {
    if (!detailConnector) return [];
    return allAuthProfiles.filter((profile) => profile.connector === detailConnector.name);
  }, [allAuthProfiles, detailConnector]);

  const handleManageProfileFromPanel = useCallback(
    (profile: AuthProfileSummary) => {
      // Workspace-scoped profiles live under /admin/auth-profiles; project-scoped
      // ones under the project settings. The deep-link param is the same on both.
      const path =
        profile.scope === 'tenant'
          ? `/admin/auth-profiles?profileId=${encodeURIComponent(profile.id)}`
          : projectId
            ? `/projects/${projectId}/settings/auth-profiles?profileId=${encodeURIComponent(
                profile.id,
              )}`
            : null;
      if (!path) {
        // Unreachable: project-scoped profiles only appear when projectId is set
        // (the !projectId early return above prevents reaching this handler).
        return;
      }
      navigate(path);
      setDetailConnector(null);
    },
    [navigate, projectId],
  );

  const handleConnectFromPanel = useCallback(() => {
    if (!detailConnector) return;
    handleCatalogConnect(detailConnector.name);
    setDetailConnector(null);
  }, [detailConnector, handleCatalogConnect]);

  if (!projectId) {
    return (
      <EmptyState
        icon={<Diamond className="h-6 w-6" />}
        title="No project selected"
        description="Select a project to view its connections."
      />
    );
  }

  // Loading skeleton
  if ((isLoading || catalogLoading) && connections.length === 0 && catalogConnectors.length === 0) {
    return (
      <div className="space-y-6 p-6">
        <div className="flex items-center justify-between py-2">
          <div className="h-4 w-40 rounded skeleton" />
          <div className="h-8 w-36 rounded skeleton" />
        </div>
        <ConnectionSkeletonGrid />
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<Diamond className="h-6 w-6" />}
          title="Failed to load connections"
          description={error}
          action={
            <Button variant="secondary" onClick={refresh}>
              Retry
            </Button>
          }
        />
      </div>
    );
  }

  // Full empty state — no connections, show popular + catalog
  const hasConnections = connections.length > 0;

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Integrations"
        description="Connect Studio to the tools, data sources, and channels your agents rely on."
      />
      <ConnectionStatusBar
        connections={connections}
        catalogCount={mergedCatalogConnectors.length}
      />

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
        <input
          type="text"
          placeholder="Search integrations..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full max-w-sm rounded-lg border border-default bg-background py-2 pl-10 pr-4 text-sm text-foreground placeholder:text-muted focus:border-border-focus focus:outline-none focus:ring-1 focus:ring-border-focus"
        />
      </div>

      {/*
        MY CONNECTIONS TAB REMOVED per 2026-05-09 meeting (ABLP-913).
        Connections concept deprecated; credentials live exclusively on the auth-profiles page.
        The unused branch (and supporting hooks/components: useConnections, ConnectionCard,
        ConnectionExpandPanel, CreateConnectionModal) remain in the codebase for migration
        neutrality — full removal is tracked as a follow-up ticket per FR-33 / GAP-21.
      */}

      {/* Integrations catalog */}
      {searchQuery && filteredCatalog.length === 0 && (
        <EmptyState
          icon={<Search className="h-6 w-6" />}
          title="No results"
          description={`Nothing matches "${searchQuery}"`}
        />
      )}

      <section>
        {catalogGroups.map(({ category, label, items }) => (
          <div key={category} className="mb-5">
            <div className="mb-3 flex items-center gap-2">
              <span className="text-xs font-medium text-muted">{label}</span>
              <div className="h-px flex-1 bg-border" />
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {items.map((connector) => (
                <CatalogCard
                  key={connector.name}
                  connector={connector}
                  isConfigured={configuredConnectorNames.has(connector.name)}
                  profileCount={profileCountByConnector.get(connector.name) ?? 0}
                  onConnect={() => handleCatalogConnect(connector.name)}
                  onOpenDetails={() => setDetailConnector(connector)}
                />
              ))}
            </div>
          </div>
        ))}
      </section>

      <IntegrationDetailPanel
        connector={detailConnector}
        authProfiles={detailAuthProfiles}
        isConfigured={detailConnector ? configuredConnectorNames.has(detailConnector.name) : false}
        onClose={() => setDetailConnector(null)}
        onConnect={handleConnectFromPanel}
        onManageProfile={handleManageProfileFromPanel}
      />

      {/* AgentDesktopConnectionDialog for SmartAssist / Five9 */}
      {projectId && (
        <AgentDesktopConnectionDialog
          open={agentDesktopCreateOpen}
          onClose={handleAgentDesktopModalClose}
          projectId={projectId}
          preselectedProviderId={agentDesktopPreselect}
          onCreated={() => {
            refresh();
          }}
        />
      )}

      {/* IntegrationManagerDialog for Docling + Azure DI (operational admin) */}
      {projectId && (
        <IntegrationManagerDialog
          open={managerConnector !== null}
          onClose={() => setManagerConnector(null)}
          projectId={projectId}
          connectorName={managerConnector?.name ?? null}
          connectorDisplayName={managerConnector?.displayName}
          onChanged={refresh}
        />
      )}
    </div>
  );
}
