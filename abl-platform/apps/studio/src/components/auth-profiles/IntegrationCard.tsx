/**
 * IntegrationCard Component
 *
 * Displays a single integration provider as an expandable card in the
 * Integrations catalog grid. Collapsed state shows connector name, auth type
 * badge, and profile count. Expanded state shows the profile list and a
 * "Create New Profile" button.
 */

'use client';

import { useState, useCallback } from 'react';
import { clsx } from 'clsx';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronUp, Plus, Building2, Pencil, ExternalLink } from 'lucide-react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { AuthProfileStatusBadge } from './AuthProfileStatusBadge';
import { ConnectorLogo } from '../connections/ConnectorLogo';
import type { IntegrationProvider, IntegrationProviderProfile } from '../../api/auth-profiles';
import { AUTH_PROFILE_USAGE_MODE_OPTIONS, getAuthTypeShortLabel } from './auth-type-metadata';

// =============================================================================
// TYPES
// =============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TranslationFn = (key: string, values?: Record<string, any>) => string;

interface IntegrationCardProps {
  provider: IntegrationProvider;
  scope: 'project' | 'workspace';
  onCreateProfile: () => void;
  /**
   * Edit handler. Provider is forwarded so the slide-over can pre-populate
   * connector-specific metadata (connectionConfig / apiKeyConfig overrides
   * from `integration-provider-service.ts`) — without it the URL / version
   * fields for Azure DI etc. don't render in edit mode.
   */
  onEditProfile: (profileId: string, provider: IntegrationProvider) => void;
  onAuthorizeProfile: (
    profileId: string,
    connectorName: string,
    connectionConfigFields?: string[],
  ) => void;
  t: TranslationFn;
}

// =============================================================================
// HELPERS
// =============================================================================

function isUnsupported(provider: IntegrationProvider): boolean {
  return provider.availableAuthTypes.length === 0;
}

function ProfileRow({
  profile,
  scope,
  connectorName,
  onEdit,
  onAuthorize,
  t,
}: {
  profile: IntegrationProviderProfile;
  scope: 'project' | 'workspace';
  connectorName: string;
  onEdit: (profileId: string) => void;
  onAuthorize: (
    profileId: string,
    connectorName: string,
    connectionConfigFields?: string[],
  ) => void;
  t: IntegrationCardProps['t'];
}) {
  const isWorkspaceProfile = profile.scope === 'tenant';
  const showWorkspaceBadge = scope === 'project' && isWorkspaceProfile;
  const isOAuth = profile.authType === 'oauth2_app';
  // A profile is editable from the page that owns it. Workspace-scoped profiles
  // are editable on the workspace page but read-only when inherited into a project.
  const isEditable = scope === 'workspace' ? isWorkspaceProfile : !isWorkspaceProfile;
  const usageModeLabel =
    AUTH_PROFILE_USAGE_MODE_OPTIONS[
      profile.usageMode as keyof typeof AUTH_PROFILE_USAGE_MODE_OPTIONS
    ]?.label ?? profile.usageMode;

  return (
    <div className="flex items-center gap-2 py-1.5 text-xs">
      <span className="truncate font-medium text-foreground">{profile.name}</span>
      <AuthProfileStatusBadge status={profile.status} className="shrink-0" />
      <Badge variant="default" className="shrink-0">
        {profile.authType}
      </Badge>
      <Badge variant="info" className="shrink-0">
        {usageModeLabel}
      </Badge>
      {showWorkspaceBadge && (
        <Badge variant="accent" className="shrink-0 gap-1">
          <Building2 className="h-3 w-3" />
          {t('integrations.workspace_badge')}
        </Badge>
      )}
      <div className="ml-auto flex items-center gap-1 shrink-0">
        {isEditable && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onEdit(profile.id);
            }}
            className="p-1 rounded text-muted hover:text-foreground hover:bg-background-muted transition-default"
            aria-label={t('integrations.edit_profile')}
            title={t('integrations.edit_profile')}
          >
            <Pencil className="h-3 w-3" />
          </button>
        )}
        {isOAuth && isEditable && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAuthorize(profile.id, connectorName);
            }}
            className="p-1 rounded text-muted hover:text-foreground hover:bg-background-muted transition-default"
            aria-label={t('integrations.authorize_profile')}
            title={t('integrations.authorize_profile')}
          >
            <ExternalLink className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

export function IntegrationCard({
  provider,
  scope,
  onCreateProfile,
  onEditProfile,
  onAuthorizeProfile,
  t,
}: IntegrationCardProps) {
  const [expanded, setExpanded] = useState(false);

  const unsupported = isUnsupported(provider);

  const handleToggle = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  const handleCreate = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onCreateProfile();
    },
    [onCreateProfile],
  );

  return (
    <div
      className={clsx(
        'rounded-lg border transition-default',
        expanded ? 'border-muted bg-background-muted/30' : 'border-default hover:border-muted',
        unsupported && 'opacity-60',
      )}
    >
      {/* Collapsed header — always visible */}
      <button
        onClick={handleToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
        aria-expanded={expanded}
      >
        <ConnectorLogo name={provider.connectorName} className="h-8 w-8 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">
              {provider.displayName}
            </span>
            {unsupported && <Badge variant="warning">{t('integrations.unsupported_badge')}</Badge>}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-subtle">
            <span>{provider.connectorName}</span>
            {provider.category && (
              <>
                <span className="text-subtle">/</span>
                <span>{provider.category}</span>
              </>
            )}
          </div>
        </div>

        {/* Auth type badges */}
        <div className="flex items-center gap-1.5 shrink-0">
          {provider.availableAuthTypes.slice(0, 2).map((authType) => (
            <Badge key={authType} variant="info">
              {getAuthTypeShortLabel(authType)}
            </Badge>
          ))}
          {provider.availableAuthTypes.length > 2 && (
            <Badge variant="default">+{provider.availableAuthTypes.length - 2}</Badge>
          )}
        </div>

        {/* Profile count */}
        <span className="text-xs text-muted shrink-0">
          {t('integrations.profiles_count', { count: provider.profileCount })}
        </span>

        {/* Expand chevron */}
        {expanded ? (
          <ChevronUp className="h-4 w-4 text-muted shrink-0" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted shrink-0" />
        )}
      </button>

      {/* Expanded section */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="border-t border-default px-4 py-3">
              {/* Profile list */}
              {provider.profiles.length > 0 ? (
                <div className="space-y-0.5">
                  {provider.profiles.map((profile) => (
                    <ProfileRow
                      key={profile.id}
                      profile={profile}
                      scope={scope}
                      connectorName={provider.connectorName}
                      onEdit={(profileId) => onEditProfile(profileId, provider)}
                      onAuthorize={(id, name) =>
                        onAuthorizeProfile(id, name, provider.oauth2?.connectionConfigFields)
                      }
                      t={t}
                    />
                  ))}
                </div>
              ) : (
                <p className="py-1 text-xs text-muted">
                  {t('integrations.profiles_count', { count: 0 })}
                </p>
              )}

              {/* Create button — only for supported connectors */}
              {!unsupported && (
                <div className="mt-3 pt-2 border-t border-default">
                  <Button variant="secondary" size="sm" onClick={handleCreate}>
                    <Plus className="h-3.5 w-3.5" />
                    {t('integrations.create_new_profile')}
                  </Button>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
