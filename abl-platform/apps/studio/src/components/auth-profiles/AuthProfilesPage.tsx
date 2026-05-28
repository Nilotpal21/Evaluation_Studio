'use client';

import { useState, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { clsx } from 'clsx';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import {
  Plus,
  Key,
  Shield,
  Building2,
  UserCheck,
  Server,
  Ban,
  Search,
  RefreshCw,
  MoreVertical,
  Pencil,
  ShieldOff,
  Trash2,
  ChevronDown,
  Puzzle,
} from 'lucide-react';
import { useNavigationStore } from '../../store/navigation-store';
import { useAuthStore } from '../../store/auth-store';
import { useAuthProfiles, useWorkspaceAuthProfiles } from '../../hooks/useAuthProfiles';
import {
  deleteAuthProfile,
  deleteWorkspaceAuthProfile,
  fetchIntegrationProviders,
  fetchWorkspaceIntegrationProviders,
  revokeAuthProfile,
  revokeWorkspaceAuthProfile,
  updateAuthProfile,
  updateWorkspaceAuthProfile,
} from '../../api/auth-profiles';
import useSWR from 'swr';
import { Globe } from 'lucide-react';
import { PageHeader } from '../ui/PageHeader';
import { AuthProfileListHealthPill } from './AuthProfileListHealthPill';
import { AuthProfileSlideOver } from './AuthProfileSlideOver';
import type { PreselectedConnector } from './AuthProfileSlideOver';
import { buildProvidersKey } from './IntegrationAuthTab';
import { AuthProfileOAuthDialog } from './AuthProfileOAuthDialog';
import { AuthProfileImpactModal } from './AuthProfileImpactModal';
import { AUTH_PROFILE_USAGE_MODE_OPTIONS, AUTH_TYPE_METADATA } from './auth-type-metadata';
import { ConnectorLogo } from '../connections/ConnectorLogo';
import { mutate } from 'swr';
import { Badge, type BadgeVariant } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { FilterSelect } from '../ui/FilterSelect';
import { StudioPermission } from '../../lib/permissions';
import { useHasPermission } from '../../hooks/usePermissions';
import type {
  AuthType,
  AuthProfileStatus,
  AuthProfileEnvironment,
  AuthProfileSummary,
  IntegrationProvider,
  ListAuthProfilesParams,
} from '../../api/auth-profiles';

// =============================================================================
// CONSTANTS
// =============================================================================

const AUTH_TYPE_ICONS: Record<string, React.ElementType> = {
  none: Ban,
  api_key: Key,
  bearer: Shield,
  oauth2_app: Building2,
  oauth2_token: UserCheck,
  oauth2_client_credentials: Server,
  azure_ad: Building2,
};

const AUTH_TYPE_KEYS: AuthType[] = [
  'none',
  'api_key',
  'bearer',
  'oauth2_app',
  'oauth2_token',
  'oauth2_client_credentials',
  'azure_ad',
];

type EnvironmentFilter = 'development' | 'staging' | 'production' | '';
type SourceFilter = 'integration' | 'custom' | '';

const ENV_BADGE_VARIANT: Record<string, 'info' | 'warning' | 'success' | 'default'> = {
  development: 'info',
  staging: 'warning',
  production: 'success',
};

const USAGE_MODE_BADGE_VARIANT: Record<string, BadgeVariant> = {
  preconfigured: 'info',
  user_token: 'purple',
  jit: 'accent',
  preflight: 'warning',
};

// Maps profile.status → Badge variant for the status column pill.
// Mirrors the Scope column's outlined pill treatment so both columns read
// as the same visual family — only the color (and dot) communicates state.
const STATUS_BADGE_VARIANT: Record<AuthProfileStatus, BadgeVariant> = {
  active: 'success',
  expired: 'warning',
  revoked: 'error',
  invalid: 'error',
  pending_authorization: 'info',
};

const CARD_CHIP_CLASS = 'whitespace-nowrap px-3 py-1 text-xs font-semibold leading-4';

function isLegacyReadOnlyProfile(profile: AuthProfileSummary): boolean {
  return profile.migration?.status === 'legacy_read_only';
}

function readInitialUrlParam(name: string): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get(name);
}

// =============================================================================
// COMPONENT
// =============================================================================

interface AuthProfilesPageProps {
  /** Defaults to 'project'. Pass 'workspace' to mount as the tenant-scoped admin page. */
  scope?: 'project' | 'workspace';
}

export function AuthProfilesPage({ scope = 'project' }: AuthProfilesPageProps = {}) {
  const isWorkspace = scope === 'workspace';
  const t = useTranslations('auth_profiles');
  const tWorkspace = useTranslations('auth_profiles.workspace');
  const { projectId: navProjectId } = useNavigationStore();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  // Project scope uses the real projectId from navigation; workspace uses a sentinel
  // that downstream routes (SlideOver, SWR keys) recognize as tenant scope.
  const projectId = isWorkspace ? '_workspace' : navProjectId;
  const canWriteAuthProfiles = useHasPermission(StudioPermission.AUTH_PROFILE_WRITE);
  const canValidateProfileHealth = canWriteAuthProfiles;
  const canAuthorizeWorkspaceOAuth = canWriteAuthProfiles;
  const getAuthTypeLabel = useCallback(
    (authType: string) => {
      const translationKey = `auth_type_labels.${authType}`;
      if (t.has(translationKey)) {
        return t(translationKey);
      }
      return AUTH_TYPE_METADATA[authType]?.shortLabel ?? authType;
    },
    [t],
  );
  const [search, setSearch] = useState('');
  // ABLP-913 FR-19: ?authType= and ?connector= pre-filter on first render.
  const [filterType, setFilterType] = useState<AuthType | ''>(
    () => (readInitialUrlParam('authType') as AuthType | null) ?? '',
  );
  const [filterStatus, setFilterStatus] = useState<AuthProfileStatus | ''>('');
  const [filterEnvironment, setFilterEnvironment] = useState<EnvironmentFilter>('');
  const [filterSource, setFilterSource] = useState<SourceFilter>(() =>
    readInitialUrlParam('connector') ? 'integration' : '',
  );
  // V1 quick-status chips: collapses status + enabled into a single one-click axis.
  // Values map to a predicate applied on top of the dropdown filters above.
  const [quickStatus, setQuickStatus] = useState<'all' | 'active' | 'issues' | 'disabled'>('all');
  // Slide-over state — ABLP-1098: ?profileId= auto-opens the edit slide-over.
  const [slideOverOpen, setSlideOverOpen] = useState(
    () => readInitialUrlParam('profileId') !== null,
  );
  const [editProfileId, setEditProfileId] = useState<string | null>(() =>
    readInitialUrlParam('profileId'),
  );
  const [preselectedConnector, setPreselectedConnector] = useState<
    PreselectedConnector | undefined
  >(undefined);

  // Row action menu state
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  // Tab state — ABLP-1098: ?connector= lands users on the Integrations tab so
  // unconfigured connectors don't show a misleading "No auth profiles found".
  const [activeTab, setActiveTab] = useState<'all' | 'integrations'>(() =>
    readInitialUrlParam('connector') ? 'integrations' : 'all',
  );

  // Add Profile dropdown state
  const [addMenuOpen, setAddMenuOpen] = useState(false);

  // New-integration sheet state (connector picker for the create flow)
  const [integrationSheetOpen, setIntegrationSheetOpen] = useState(false);
  // Build the providers key from the resolved `projectId` (which equals
  // '_workspace' or the real project id). Gating on `navProjectId` alone
  // produced a dead-key path on project pages where SWR never subscribed,
  // leaving the integration card empty and "Add Integration Profile"
  // falling through to the custom chooser.
  const providersSwrKey = projectId
    ? buildProvidersKey(isWorkspace ? 'workspace' : 'project', projectId)
    : null;
  const { data: providersData } = useSWR(
    providersSwrKey,
    () =>
      isWorkspace
        ? fetchWorkspaceIntegrationProviders()
        : projectId
          ? fetchIntegrationProviders(projectId)
          : null,
    { revalidateOnFocus: false },
  );
  const integrationProviders = useMemo(() => providersData?.data ?? [], [providersData]);

  // OAuth dialog state (for authorizing from Integrations tab)
  const [oauthDialogState, setOauthDialogState] = useState<{
    open: boolean;
    profileId: string;
    connectorName: string;
    connectionConfigFields?: string[];
  }>({ open: false, profileId: '', connectorName: '' });

  // Revoke confirmation modal state (row-menu revoke action).
  // Workspace scope uses direct API call (no preview endpoint at workspace level).
  const [revokeConfirmProfile, setRevokeConfirmProfile] = useState<AuthProfileSummary | null>(null);
  // Delete confirmation modal state (row-menu delete action).
  const [deleteConfirmProfile, setDeleteConfirmProfile] = useState<AuthProfileSummary | null>(null);
  // Disable confirmation modal (toggle off only — enable is instant).
  const [disableConfirmProfile, setDisableConfirmProfile] = useState<AuthProfileSummary | null>(
    null,
  );
  // Per-row pending state so the toggle disables itself during the PATCH.
  const [togglingProfileId, setTogglingProfileId] = useState<string | null>(null);

  const params: ListAuthProfilesParams = {};
  if (filterType) params.authType = filterType;
  if (filterStatus) params.status = filterStatus;
  if (filterEnvironment) params.environment = filterEnvironment;
  if (search) params.search = search;

  const projectHookResult = useAuthProfiles(isWorkspace ? null : (navProjectId ?? null), params);
  const workspaceHookResult = useWorkspaceAuthProfiles(isWorkspace && isAuthenticated, {
    search: params.search,
    authType: params.authType as AuthType | '' | undefined,
    status: params.status as AuthProfileStatus | '' | undefined,
  });
  const {
    profiles: allProfiles,
    total,
    isLoading,
    error,
    refresh,
  } = isWorkspace ? workspaceHookResult : projectHookResult;

  // Apply client-side source filter (integration vs custom)
  const sourceFilteredProfiles = useMemo(() => {
    if (!filterSource) return allProfiles;
    if (filterSource === 'integration') return allProfiles.filter((p) => !!p.connector);
    return allProfiles.filter((p) => !p.connector);
  }, [allProfiles, filterSource]);

  // Counts for the quick-status chips — computed in a single client-side pass
  // over the source-filtered list (cheap; no API calls). Counts reflect the
  // current source filter so the chip totals match the table content below.
  const statusCounts = useMemo(() => {
    let active = 0;
    let issues = 0;
    let disabled = 0;
    for (const p of sourceFilteredProfiles) {
      if (p.enabled === false) disabled++;
      if (p.status === 'active' && p.enabled !== false) active++;
      if (
        p.status === 'expired' ||
        p.status === 'revoked' ||
        p.status === 'invalid' ||
        p.status === 'pending_authorization'
      ) {
        issues++;
      }
    }
    return { all: sourceFilteredProfiles.length, active, issues, disabled };
  }, [sourceFilteredProfiles]);

  // Apply the quick-status predicate on top of source filtering.
  const profiles = useMemo(() => {
    if (quickStatus === 'all') return sourceFilteredProfiles;
    if (quickStatus === 'active') {
      return sourceFilteredProfiles.filter((p) => p.status === 'active' && p.enabled !== false);
    }
    if (quickStatus === 'disabled') {
      return sourceFilteredProfiles.filter((p) => p.enabled === false);
    }
    // issues
    return sourceFilteredProfiles.filter(
      (p) =>
        p.status === 'expired' ||
        p.status === 'revoked' ||
        p.status === 'invalid' ||
        p.status === 'pending_authorization',
    );
  }, [sourceFilteredProfiles, quickStatus]);

  // =============================================================================
  // HANDLERS
  // =============================================================================

  const handleAddProfile = useCallback(() => {
    setEditProfileId(null);
    setPreselectedConnector(undefined);
    setSlideOverOpen(true);
  }, []);

  const handleEditProfile = useCallback((profileId: string) => {
    setEditProfileId(profileId);
    setSlideOverOpen(true);
    setOpenMenuId(null);
  }, []);

  const handleRowClick = useCallback(
    (profile: AuthProfileSummary) => {
      // Project scope: tenant-inherited rows are read-only. Workspace scope: all
      // rows are tenant-scoped and editable.
      if (!isWorkspace && profile.scope === 'tenant') return;
      setEditProfileId(profile.id);
      setSlideOverOpen(true);
    },
    [isWorkspace],
  );

  const handleSlideOverClose = useCallback(() => {
    setSlideOverOpen(false);
    setPreselectedConnector(undefined);
    setIntegrationSheetOpen(false);
  }, []);

  const handleSlideOverSaved = useCallback(() => {
    setSlideOverOpen(false);
    setPreselectedConnector(undefined);
    setIntegrationSheetOpen(false);
    refresh();
    if (isWorkspace) {
      void mutate(buildProvidersKey('workspace', '_workspace'));
    } else if (navProjectId) {
      void mutate(buildProvidersKey('project', navProjectId));
    }
  }, [refresh, isWorkspace, navProjectId]);

  const handleCreateFromIntegration = useCallback((provider: IntegrationProvider) => {
    setEditProfileId(null);
    setPreselectedConnector({
      connectorName: provider.connectorName,
      displayName: provider.displayName,
      availableAuthTypes: provider.availableAuthTypes,
      oauth2: provider.oauth2,
      connectionConfig: provider.connectionConfig,
      apiKeyConfig: provider.apiKeyConfig,
      authPrefill: provider.authPrefill,
    });
    setSlideOverOpen(true);
  }, []);

  const handleEditFromIntegration = useCallback(
    (profileId: string, provider: IntegrationProvider) => {
      setEditProfileId(profileId);
      // Forward the connector metadata to the slide-over even in edit mode so
      // fields backed by `connectionConfig` (Azure DI's endpoint/apiVersion,
      // etc.) render with their labels/descriptions and the existing values
      // can be edited. Without this the slide-over fell back to a bare api_key
      // form and the saved endpoint/apiVersion were invisible.
      setPreselectedConnector({
        connectorName: provider.connectorName,
        displayName: provider.displayName,
        availableAuthTypes: provider.availableAuthTypes,
        oauth2: provider.oauth2,
        connectionConfig: provider.connectionConfig,
        apiKeyConfig: provider.apiKeyConfig,
        authPrefill: provider.authPrefill,
      });
      setSlideOverOpen(true);
    },
    [],
  );

  const handleAuthorizeFromIntegration = useCallback(
    (profileId: string, connectorName: string, connectionConfigFields?: string[]) => {
      if (isWorkspace) {
        if (!canAuthorizeWorkspaceOAuth) {
          toast.error(t('workspace_oauth_missing_permission'));
          return;
        }
      } else if (!navProjectId) {
        return;
      }
      setOauthDialogState({ open: true, profileId, connectorName, connectionConfigFields });
    },
    [isWorkspace, canAuthorizeWorkspaceOAuth, navProjectId, t],
  );

  const handleRevoke = useCallback(
    async (profile: AuthProfileSummary) => {
      if (!isWorkspace && !navProjectId) return;
      setOpenMenuId(null);
      if (isLegacyReadOnlyProfile(profile)) {
        toast.error(profile.migration?.message ?? t('legacy_readonly'));
        return;
      }
      if (profile.status === 'revoked') {
        toast.error(t('already_revoked'));
        return;
      }
      // Pending-authorization profiles have no token to revoke — guard here
      // and disable the row action so admins don't see a confirm dialog for
      // a no-op (ABLP-2). Row button also has matching disabled={...}.
      if (profile.status === 'pending_authorization') return;
      // Bare confirmation modal for both scopes — the modal itself dispatches
      // to the right API helper based on projectId (null for workspace).
      setRevokeConfirmProfile(profile);
    },
    [isWorkspace, navProjectId, t],
  );

  const handleDelete = useCallback(
    (profile: AuthProfileSummary) => {
      if (!isWorkspace && !navProjectId) return;
      setOpenMenuId(null);
      if (isLegacyReadOnlyProfile(profile)) {
        toast.error(profile.migration?.message ?? t('legacy_readonly'));
        return;
      }
      setDeleteConfirmProfile(profile);
    },
    [isWorkspace, navProjectId, t],
  );

  const handleMenuToggle = useCallback(
    (e: React.MouseEvent, profileId: string) => {
      e.stopPropagation();
      setOpenMenuId(openMenuId === profileId ? null : profileId);
    },
    [openMenuId],
  );

  // Enable/disable toggle. Enabling is instant; disabling shows a confirm
  // dialog because it causes consumers (workflows / agents / MCP tools) to
  // start failing with AUTH_PROFILE_DISABLED.
  const applyEnabled = useCallback(
    async (profile: AuthProfileSummary, nextEnabled: boolean) => {
      setTogglingProfileId(profile.id);
      try {
        if (isWorkspace) {
          await updateWorkspaceAuthProfile(profile.id, { enabled: nextEnabled });
        } else if (navProjectId) {
          await updateAuthProfile(navProjectId, profile.id, { enabled: nextEnabled });
        }
        toast.success(nextEnabled ? t('toggle_enabled_success') : t('toggle_disabled_success'));
        refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('toggle_failed'));
      } finally {
        setTogglingProfileId(null);
      }
    },
    [isWorkspace, navProjectId, refresh, t],
  );

  const handleToggleEnabled = useCallback(
    (profile: AuthProfileSummary) => {
      if (profile.enabled === false) {
        void applyEnabled(profile, true);
      } else {
        setDisableConfirmProfile(profile);
      }
    },
    [applyEnabled],
  );

  if (!projectId) return null;

  // Helper: environment badge for a profile
  const renderEnvironmentBadge = (env: AuthProfileEnvironment) => {
    if (!env) {
      return (
        <Badge variant="default" appearance="outlined" className={CARD_CHIP_CLASS}>
          {t('env_badge_all')}
        </Badge>
      );
    }
    const variant = ENV_BADGE_VARIANT[env] ?? 'default';
    const labelKey = `env_badge_${env}` as const;
    return (
      <Badge variant={variant} appearance="outlined" className={CARD_CHIP_CLASS} dot>
        {t(labelKey)}
      </Badge>
    );
  };

  const renderSourceBadge = (profile: AuthProfileSummary) => {
    if (profile.connector) {
      return (
        <Badge variant="accent" appearance="outlined" className={clsx('gap-1.5', CARD_CHIP_CLASS)}>
          <Puzzle className="h-3 w-3 shrink-0" />
          {profile.connector}
        </Badge>
      );
    }
    return (
      <Badge variant="default" appearance="outlined" className={clsx('gap-1.5', CARD_CHIP_CLASS)}>
        <Key className="h-3 w-3 shrink-0" />
        {t('integrations.custom_badge')}
      </Badge>
    );
  };

  const renderUsageModeBadge = (profile: AuthProfileSummary) => (
    <Badge
      variant={USAGE_MODE_BADGE_VARIANT[profile.usageMode] ?? 'info'}
      appearance="outlined"
      className={CARD_CHIP_CLASS}
    >
      {AUTH_PROFILE_USAGE_MODE_OPTIONS[profile.usageMode]?.label ?? profile.usageMode}
    </Badge>
  );

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-default px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold text-foreground">
            {isWorkspace ? tWorkspace('title') : t('title')}
          </h1>
          <p className="text-sm text-muted">
            {isWorkspace ? tWorkspace('description') : t('description')}
          </p>
        </div>
        <div className="relative">
          <button
            onClick={() => setAddMenuOpen((prev) => !prev)}
            className={clsx(
              'flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium',
              'bg-accent text-accent-foreground hover:opacity-90 transition-default btn-press',
            )}
          >
            <Plus className="h-4 w-4" />
            {t('add_profile')}
            <ChevronDown className="h-3 w-3 ml-1" />
          </button>

          <AnimatePresence>
            {addMenuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setAddMenuOpen(false)} />
                <motion.div
                  initial={{ opacity: 0, scale: 0.95, y: -4 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95, y: -4 }}
                  transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
                  className="absolute right-0 top-full mt-1 z-20 w-52 rounded-lg border border-default bg-background-elevated shadow-xl overflow-hidden origin-top-right"
                >
                  <button
                    onClick={() => {
                      setAddMenuOpen(false);
                      handleAddProfile();
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-foreground hover:bg-background-muted transition-default text-left"
                  >
                    <Key className="w-4 h-4 text-muted" />
                    {t('add_custom_profile')}
                  </button>
                  <button
                    onClick={() => {
                      setAddMenuOpen(false);
                      setEditProfileId(null);
                      setPreselectedConnector(undefined);
                      setIntegrationSheetOpen(true);
                      setSlideOverOpen(true);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-foreground hover:bg-background-muted transition-default text-left"
                  >
                    <Puzzle className="w-4 h-4 text-muted" />
                    {t('add_integration_profile')}
                  </button>
                </motion.div>
              </>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Filters — platform-blended: search + quick-status chips + dropdowns */}
      <div className="flex items-center gap-3 border-b border-default px-6 py-3 flex-wrap">
        <div className="w-72">
          <Input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('search_placeholder')}
            aria-label={t('search_aria_label')}
            icon={<Search className="w-4 h-4" />}
          />
        </div>

        {/* Quick-status chips — segmented control */}
        <div className="inline-flex items-center rounded-lg border border-default bg-background p-0.5">
          {(
            [
              { key: 'all', label: t('quick_status_all'), count: statusCounts.all },
              {
                key: 'active',
                label: t('quick_status_active'),
                count: statusCounts.active,
              },
              {
                key: 'issues',
                label: t('quick_status_issues'),
                count: statusCounts.issues,
              },
              {
                key: 'disabled',
                label: t('quick_status_disabled'),
                count: statusCounts.disabled,
              },
            ] as const
          ).map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={() => setQuickStatus(chip.key)}
              className={clsx(
                'inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm font-medium rounded-md transition-default',
                quickStatus === chip.key
                  ? 'bg-background-muted text-foreground'
                  : 'text-foreground-muted hover:text-foreground',
              )}
            >
              {chip.label}
              <span
                className={clsx(
                  'inline-flex items-center justify-center rounded-full px-1.5 min-w-[1.25rem] h-4 text-xs',
                  quickStatus === chip.key
                    ? 'bg-foreground text-background'
                    : 'bg-background-muted text-foreground-muted',
                )}
              >
                {chip.count}
              </span>
            </button>
          ))}
        </div>

        <FilterSelect
          value={filterType || 'all'}
          onChange={(v) => setFilterType((v === 'all' ? '' : v) as AuthType | '')}
          options={[
            { value: 'all', label: t('filter_all_types') },
            ...AUTH_TYPE_KEYS.map((key) => ({ value: key, label: getAuthTypeLabel(key) })),
          ]}
        />
        <FilterSelect
          value={filterSource || 'all'}
          onChange={(v) => setFilterSource((v === 'all' ? '' : v) as SourceFilter)}
          options={[
            { value: 'all', label: t('filter_all_sources') },
            { value: 'integration', label: t('filter_source_integration') },
            { value: 'custom', label: t('filter_source_custom') },
          ]}
        />

        <button
          onClick={refresh}
          aria-label="Refresh profiles"
          className={clsx(
            'ml-auto flex items-center gap-1.5 px-2.5 py-2 text-sm font-medium whitespace-nowrap',
            'bg-background border border-default rounded-lg',
            'text-foreground-muted hover:text-foreground hover:bg-background-muted transition-default',
            'focus:outline-none focus:ring-1 focus:ring-border-focus',
          )}
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      {/* Profile List — pt-0 so the sticky thead sits flush below the filter
          bar. Vertical padding before the table comes from a margin on the
          wrapper instead, which scrolls together with the rows so it doesn't
          leave a gap behind the sticky header. */}
      <div className="flex-1 overflow-auto px-6 pt-0 pb-4">
        {isLoading && profiles.length === 0 && (
          <div className="flex items-center justify-center py-12 text-subtle">{t('loading')}</div>
        )}

        {error && (
          <div className="rounded-md border border-error/30 bg-error-subtle px-4 py-3 text-sm text-error">
            {error}
          </div>
        )}

        {!isLoading && !error && profiles.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-subtle">
            <Key className="mb-3 h-10 w-10" />
            <p className="text-sm">{t('empty_title')}</p>
            <p className="mt-1 text-xs">{t('empty_description')}</p>
          </div>
        )}

        {profiles.length > 0 && (
          <div className="mt-4 rounded-lg border border-default">
            <table className="w-full table-fixed text-sm">
              <colgroup>
                {/* Name gets the largest share (varies most); the rest balanced. */}
                <col className="w-[24%]" />
                <col className="w-[13%]" />
                <col className="w-[10%]" />
                <col className="w-[18%]" />
                <col className="w-[12%]" />
                <col className="w-[12%]" />
                <col className="w-[11%]" />
              </colgroup>
              <thead className="sticky top-0 z-10 bg-background-muted">
                <tr className="border-b border-default bg-background-muted">
                  <th className="px-4 py-2.5 text-left font-medium text-foreground-muted">
                    {t('column_name')}
                  </th>
                  <th className="px-4 py-2.5 text-left font-medium text-foreground-muted">
                    {t('column_auth_type')}
                  </th>
                  <th className="px-4 py-2.5 text-left font-medium text-foreground-muted">
                    {t('column_scope')}
                  </th>
                  <th className="px-4 py-2.5 text-left font-medium text-foreground-muted">
                    {t('column_owner')}
                  </th>
                  <th className="px-4 py-2.5 text-left font-medium text-foreground-muted">
                    {t('column_created')}
                  </th>
                  <th className="px-4 py-2.5 text-left font-medium text-foreground-muted">
                    {t('column_status')}
                  </th>
                  <th className="px-4 py-2.5 text-right font-medium text-foreground-muted">
                    {t('column_actions')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((profile) => {
                  const Icon = AUTH_TYPE_ICONS[profile.authType] ?? Key;
                  const isInherited = profile.scope === 'tenant';
                  const isLegacyReadOnly = isLegacyReadOnlyProfile(profile);
                  const isDisabled = profile.enabled === false;
                  const isProjectInheritedReadOnly = !isWorkspace && isInherited;
                  const isToggling = togglingProfileId === profile.id;

                  return (
                    <tr
                      key={profile.id}
                      className={clsx(
                        'border-b border-default last:border-0 transition-colors',
                        'hover:bg-background-muted/40',
                      )}
                    >
                      {/* Name + icon */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5 min-w-0">
                          {profile.connector ? (
                            <ConnectorLogo name={profile.connector} className="h-6 w-6 shrink-0" />
                          ) : (
                            <div className="flex h-6 w-6 items-center justify-center rounded bg-background-muted shrink-0">
                              <Icon className="h-3.5 w-3.5 text-muted" />
                            </div>
                          )}
                          <span className="truncate font-medium text-foreground">
                            {profile.name}
                          </span>
                          {isLegacyReadOnly && (
                            <Badge variant="warning" appearance="outlined" className="text-xs">
                              {t('legacy_badge')}
                            </Badge>
                          )}
                        </div>
                      </td>

                      {/* Auth Type */}
                      <td className="px-4 py-3 text-foreground">
                        {getAuthTypeLabel(profile.authType)}
                      </td>

                      {/* Scope */}
                      <td className="px-4 py-3">
                        {profile.scope === 'tenant' ? (
                          <Badge variant="accent" appearance="outlined" className="gap-1 text-xs">
                            <Globe className="h-3 w-3" />
                            {t('scope_workspace')}
                          </Badge>
                        ) : (
                          <Badge variant="default" appearance="outlined" className="text-xs">
                            {t('scope_project')}
                          </Badge>
                        )}
                      </td>

                      {/* Owner — resolved email from the batched user lookup. */}
                      <td
                        className="px-4 py-3 text-foreground-muted truncate"
                        title={profile.createdByEmail ?? profile.createdBy}
                      >
                        {profile.createdByEmail ?? '—'}
                      </td>

                      {/* Created (cheap — already on the doc) */}
                      <td className="px-4 py-3 text-subtle">
                        {profile.createdAt ? new Date(profile.createdAt).toLocaleDateString() : '—'}
                      </td>

                      {/* Status pill — outlined, same family as Scope column.
                        When the profile is disabled, that takes priority over
                        the underlying credential health since runtime will
                        reject with AUTH_PROFILE_DISABLED before any status
                        check matters. */}
                      <td className="px-4 py-3">
                        {isDisabled ? (
                          <Badge variant="default" appearance="outlined" className="text-xs">
                            {t('status_disabled')}
                          </Badge>
                        ) : (
                          <Badge
                            variant={STATUS_BADGE_VARIANT[profile.status] ?? 'default'}
                            appearance="outlined"
                            className="text-xs"
                            pulse={profile.status === 'pending_authorization'}
                          >
                            {t(`status_${profile.status}`)}
                          </Badge>
                        )}
                      </td>

                      {/* Actions: [toggle] [pencil] [⋯] */}
                      <td className="px-4 py-3">
                        <div
                          className="flex items-center justify-end gap-1.5"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {isProjectInheritedReadOnly ? (
                            <a
                              href="/admin/auth-profiles"
                              className="text-xs text-info hover:underline"
                            >
                              {t('manage_in_workspace')}
                            </a>
                          ) : (
                            <>
                              {/* Enable / Disable toggle */}
                              <button
                                role="switch"
                                aria-checked={!isDisabled}
                                aria-label={
                                  isDisabled ? t('toggle_enable_aria') : t('toggle_disable_aria')
                                }
                                disabled={isToggling || isLegacyReadOnly}
                                onClick={() => handleToggleEnabled(profile)}
                                className={clsx(
                                  'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-default',
                                  isDisabled
                                    ? 'bg-background-muted border border-default'
                                    : 'bg-accent',
                                  'disabled:opacity-50 disabled:cursor-not-allowed',
                                )}
                                title={
                                  isDisabled
                                    ? t('toggle_enable_tooltip')
                                    : t('toggle_disable_tooltip')
                                }
                              >
                                <span
                                  className={clsx(
                                    'inline-block h-3.5 w-3.5 rounded-full bg-background-elevated shadow transition-transform',
                                    isDisabled ? 'translate-x-1' : 'translate-x-[1.125rem]',
                                  )}
                                />
                              </button>

                              {/* Edit (pencil) */}
                              <button
                                onClick={() => handleEditProfile(profile.id)}
                                disabled={isLegacyReadOnly}
                                aria-label={t('action_edit_aria', { name: profile.name })}
                                className="p-1.5 text-muted hover:text-foreground hover:bg-background-muted rounded transition-default disabled:opacity-50 disabled:cursor-not-allowed"
                                title={t('action_edit')}
                              >
                                <Pencil className="w-4 h-4" />
                              </button>

                              {/* ⋯ menu */}
                              <div className="relative">
                                <button
                                  onClick={(e) => handleMenuToggle(e, profile.id)}
                                  className="p-1.5 text-muted hover:text-foreground hover:bg-background-muted rounded transition-default"
                                  aria-label={t('action_more_aria', { name: profile.name })}
                                >
                                  <MoreVertical className="w-4 h-4" />
                                </button>

                                <AnimatePresence>
                                  {openMenuId === profile.id && (
                                    <>
                                      <div
                                        className="fixed inset-0 z-10"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setOpenMenuId(null);
                                        }}
                                      />
                                      <motion.div
                                        initial={{ opacity: 0, scale: 0.95, y: -4 }}
                                        animate={{ opacity: 1, scale: 1, y: 0 }}
                                        exit={{ opacity: 0, scale: 0.95, y: -4 }}
                                        transition={{
                                          duration: 0.15,
                                          ease: [0.22, 1, 0.36, 1],
                                        }}
                                        className="absolute right-0 top-full mt-1 z-20 w-40 rounded-lg border border-default bg-background-elevated shadow-xl overflow-hidden origin-top-right"
                                      >
                                        {!isLegacyReadOnly && profile.status !== 'revoked' && (
                                          <button
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              handleRevoke(profile);
                                            }}
                                            disabled={profile.status === 'pending_authorization'}
                                            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-background-muted transition-default text-left disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                                          >
                                            <ShieldOff className="w-4 h-4 text-muted" />
                                            {t('action_revoke')}
                                          </button>
                                        )}
                                        {!isLegacyReadOnly && (
                                          <button
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              handleDelete(profile);
                                            }}
                                            disabled={
                                              profile.status !== 'revoked' &&
                                              profile.status !== 'pending_authorization'
                                            }
                                            title={
                                              profile.status !== 'revoked' &&
                                              profile.status !== 'pending_authorization'
                                                ? t('delete_requires_revoke')
                                                : undefined
                                            }
                                            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-error hover:bg-error-subtle transition-default text-left disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                                          >
                                            <Trash2 className="w-4 h-4 text-error" />
                                            {t('action_delete')}
                                          </button>
                                        )}
                                      </motion.div>
                                    </>
                                  )}
                                </AnimatePresence>
                              </div>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {profiles.length > 0 && total > 0 && (
          <div className="mt-4 text-center text-xs text-subtle">
            {t('showing_count', { shown: profiles.length, total })}
          </div>
        )}
      </div>

      {/* Slide-Over. When opened via "Add Integration Profile" we pass the catalog
          so the slide-over renders the connector picker as step 0; otherwise the
          slide-over starts at the type-selector (custom flow) or directly in the
          form (edit / integration-card create flow). */}
      <AuthProfileSlideOver
        open={slideOverOpen}
        onClose={handleSlideOverClose}
        onSaved={handleSlideOverSaved}
        projectId={projectId}
        editProfileId={editProfileId}
        preselectedConnector={preselectedConnector}
        providers={integrationSheetOpen ? integrationProviders : undefined}
      />

      {/* OAuth Authorization Dialog (from Integrations tab) */}
      {projectId && (
        <AuthProfileOAuthDialog
          open={oauthDialogState.open}
          scope={isWorkspace ? 'workspace' : 'project'}
          {...(isWorkspace ? {} : { projectId })}
          authProfileId={oauthDialogState.profileId}
          connectorName={oauthDialogState.connectorName}
          connectionConfigFields={oauthDialogState.connectionConfigFields}
          onSuccess={() => {
            setOauthDialogState({ open: false, profileId: '', connectorName: '' });
            refresh();
            if (isWorkspace) {
              void mutate(buildProvidersKey('workspace', '_workspace'));
            } else if (navProjectId) {
              void mutate(buildProvidersKey('project', navProjectId));
            }
          }}
          onClose={() => {
            setOauthDialogState({ open: false, profileId: '', connectorName: '' });
          }}
        />
      )}

      {/* Revoke Profile — impact preview + confirm. */}
      {revokeConfirmProfile && (
        <AuthProfileImpactModal
          open
          action="revoke"
          projectId={isWorkspace ? null : (navProjectId ?? null)}
          profileId={revokeConfirmProfile.id}
          profileName={revokeConfirmProfile.name}
          onClose={() => setRevokeConfirmProfile(null)}
          onConfirm={async () => {
            const profile = revokeConfirmProfile;
            if (isWorkspace) {
              await revokeWorkspaceAuthProfile(profile.id);
            } else if (navProjectId) {
              await revokeAuthProfile(navProjectId, profile.id);
            }
            setRevokeConfirmProfile(null);
            toast.success(t('revoked_success', { name: profile.name }));
            refresh();
          }}
        />
      )}

      {/* Disable Profile — impact preview + confirm (toggle off only;
          enabling is instant and does not surface the modal). */}
      {disableConfirmProfile && (
        <AuthProfileImpactModal
          open
          action="disable"
          projectId={isWorkspace ? null : (navProjectId ?? null)}
          profileId={disableConfirmProfile.id}
          profileName={disableConfirmProfile.name}
          onClose={() => setDisableConfirmProfile(null)}
          onConfirm={async () => {
            const profile = disableConfirmProfile;
            setDisableConfirmProfile(null);
            await applyEnabled(profile, false);
          }}
        />
      )}

      {/* Delete Profile — impact preview + confirm. Workspace scope adds a
          type-to-confirm gate inside the modal itself. */}
      {deleteConfirmProfile && (
        <AuthProfileImpactModal
          open
          action="delete"
          projectId={isWorkspace ? null : (navProjectId ?? null)}
          profileId={deleteConfirmProfile.id}
          profileName={deleteConfirmProfile.name}
          onClose={() => setDeleteConfirmProfile(null)}
          onConfirm={async () => {
            const profile = deleteConfirmProfile;
            if (isWorkspace) {
              await deleteWorkspaceAuthProfile(profile.id);
            } else if (navProjectId) {
              await deleteAuthProfile(navProjectId, profile.id);
            }
            setDeleteConfirmProfile(null);
            toast.success(t('deleted_success', { name: profile.name }));
            refresh();
            if (isWorkspace) {
              void mutate(buildProvidersKey('workspace', '_workspace'));
            } else if (navProjectId) {
              void mutate(buildProvidersKey('project', navProjectId));
            }
          }}
        />
      )}
    </div>
  );
}
