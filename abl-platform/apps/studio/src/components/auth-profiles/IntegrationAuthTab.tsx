/**
 * IntegrationAuthTab Component
 *
 * The "Integrations" tab content for auth profile pages. Shows a browsable
 * catalog grid of integration providers with search and category filtering.
 */

'use client';

import { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { clsx } from 'clsx';
import useSWR from 'swr';
import { Search, Puzzle, Loader2 } from 'lucide-react';
import { IntegrationCard } from './IntegrationCard';
import {
  fetchIntegrationProviders,
  fetchWorkspaceIntegrationProviders,
} from '../../api/auth-profiles';
import type { IntegrationProvider } from '../../api/auth-profiles';
import {
  getConnectorCategory,
  getCategoryLabel,
  CATEGORY_ORDER,
} from '../connections/connector-categories';
import { FilterSelect } from '../ui/FilterSelect';

// =============================================================================
// TYPES
// =============================================================================

interface IntegrationAuthTabProps {
  scope: 'project' | 'workspace';
  projectId: string;
  onCreateProfile: (provider: IntegrationProvider) => void;
  /**
   * Provider is forwarded alongside the profileId so the slide-over can
   * pre-populate connector metadata (connectionConfig / apiKeyConfig)
   * when editing an existing integration profile. Without this, fields
   * like Azure DI's endpoint/apiVersion stay hidden in edit mode.
   */
  onEditProfile: (profileId: string, provider: IntegrationProvider) => void;
  onAuthorizeProfile: (
    profileId: string,
    connectorName: string,
    connectionConfigFields?: string[],
  ) => void;
}

interface ProvidersResponse {
  success: boolean;
  data: IntegrationProvider[];
}

// Connectors excluded from the Integrations tab:
// - http/postgres: generic utilities, not integration-specific
// - smartassist/five9: agent-desktop providers with their own connection modal
const EXCLUDED_CONNECTORS = new Set(['http', 'postgres', 'smartassist', 'five9']);

function isVisibleIntegrationProvider(provider: IntegrationProvider): boolean {
  if (EXCLUDED_CONNECTORS.has(provider.connectorName)) {
    return false;
  }
  return provider.availableAuthTypes.length > 0 || provider.profileCount > 0;
}

// =============================================================================
// SWR KEY BUILDERS (exported for cache invalidation)
// =============================================================================

export function buildProvidersKey(
  scope: 'project' | 'workspace',
  projectId: string,
): string | null {
  if (scope === 'workspace') {
    return '/api/auth-profiles/providers';
  }
  if (!projectId) return null;
  return `/api/projects/${encodeURIComponent(projectId)}/auth-profiles/providers`;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function IntegrationAuthTab({
  scope,
  projectId,
  onCreateProfile,
  onEditProfile,
  onAuthorizeProfile,
}: IntegrationAuthTabProps) {
  const t = useTranslations('auth_profiles');

  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');

  // Stable SWR key for targeted invalidation
  const swrKey = buildProvidersKey(scope, projectId);

  const { data, error, isLoading } = useSWR<ProvidersResponse>(swrKey, () =>
    scope === 'workspace'
      ? fetchWorkspaceIntegrationProviders()
      : fetchIntegrationProviders(projectId),
  );

  const providers = data?.data ?? [];

  // Apply search and category filters, then group by category
  const filteredProviders = useMemo(() => {
    let result = providers.filter(isVisibleIntegrationProvider);

    if (search) {
      const lowerSearch = search.toLowerCase();
      result = result.filter(
        (p) =>
          p.displayName.toLowerCase().includes(lowerSearch) ||
          p.connectorName.toLowerCase().includes(lowerSearch),
      );
    }

    if (categoryFilter) {
      result = result.filter((p) => getConnectorCategory(p.connectorName) === categoryFilter);
    }

    return result;
  }, [providers, search, categoryFilter]);

  // Group filtered providers by category (same ordering as Connector Catalog)
  const groupedProviders = useMemo(() => {
    const groups = new Map<string, IntegrationProvider[]>();
    for (const p of filteredProviders) {
      const cat = getConnectorCategory(p.connectorName);
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push(p);
    }
    return CATEGORY_ORDER.filter((cat) => groups.has(cat)).map((cat) => ({
      category: cat,
      label: getCategoryLabel(cat),
      providers: groups.get(cat)!,
    }));
  }, [filteredProviders]);

  // Extract unique categories for the filter dropdown
  const categories = useMemo(() => {
    const cats = new Set<string>();
    for (const p of providers.filter(isVisibleIntegrationProvider)) {
      cats.add(getConnectorCategory(p.connectorName));
    }
    return CATEGORY_ORDER.filter((cat) => cats.has(cat));
  }, [providers]);

  const categoryOptions = useMemo(
    () => [
      { value: '', label: t('integrations.category_all') },
      ...categories.map((cat) => ({ value: cat, label: getCategoryLabel(cat) })),
    ],
    [categories, t],
  );

  return (
    <div className="flex h-full flex-col">
      {/* Search and category filter */}
      <div className="flex items-center gap-3 border-b border-default px-6 py-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
          <input
            type="text"
            placeholder={t('integrations.search_placeholder')}
            aria-label={t('integrations.search_placeholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={clsx(
              'w-full rounded-md border border-default bg-background-muted py-2 pl-9 pr-3 text-sm text-foreground',
              'placeholder-subtle focus:outline-none focus:ring-1 focus:ring-foreground/20 focus:border-foreground/30',
            )}
          />
        </div>
        <FilterSelect
          options={categoryOptions}
          value={categoryFilter}
          onChange={setCategoryFilter}
        />
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto px-6 py-4">
        {/* Loading state */}
        {isLoading && (
          <div className="flex items-center justify-center py-12 text-subtle">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t('loading')}
          </div>
        )}

        {/* Error state */}
        {error && !isLoading && (
          <div className="rounded-md border border-error/30 bg-error-subtle px-4 py-3 text-sm text-error">
            {error instanceof Error ? error.message : String(error)}
          </div>
        )}

        {/* Empty state */}
        {!isLoading && !error && filteredProviders.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-subtle">
            <Puzzle className="mb-3 h-10 w-10" />
            <p className="text-sm">{t('integrations.empty_state_title')}</p>
            <p className="mt-1 text-xs">{t('integrations.empty_state_description')}</p>
          </div>
        )}

        {/* Catalog grid grouped by category */}
        {!isLoading && !error && groupedProviders.length > 0 && (
          <section>
            {groupedProviders.map(({ category, label, providers: groupItems }) => (
              <div key={category} className="mb-5">
                <div className="mb-3 flex items-center gap-2">
                  <span className="text-xs font-medium text-muted">{label}</span>
                  <div className="h-px flex-1 bg-border" />
                </div>
                <div className="grid gap-3 sm:grid-cols-1 md:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3">
                  {groupItems.map((provider) => (
                    <IntegrationCard
                      key={provider.connectorName}
                      provider={provider}
                      scope={scope}
                      onCreateProfile={() => onCreateProfile(provider)}
                      onEditProfile={onEditProfile}
                      onAuthorizeProfile={onAuthorizeProfile}
                      t={t}
                    />
                  ))}
                </div>
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
