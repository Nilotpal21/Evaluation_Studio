'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { clsx } from 'clsx';
import { AlertTriangle, ChevronDown, Loader2 } from 'lucide-react';
import type { AuthProfileConsumerKind } from '@agent-platform/shared/validation';
import {
  getAuthProfileSupportDecision,
  isPhase2CoreAuthType,
} from '@agent-platform/shared/validation';
import { useAuthProfiles, useAuthProfile } from '../../hooks/useAuthProfiles';
import { AuthProfileStatusBadge } from './AuthProfileStatusBadge';
import type { AuthProfileProfileType, AuthProfileSummary, AuthType } from '../../api/auth-profiles';
import { AUTH_TYPE_METADATA } from './auth-type-metadata';

interface AuthProfilePickerProps {
  projectId: string;
  value: string | null;
  onChange: (profileId: string | null) => void;
  /** Filter to specific auth types */
  filterAuthTypes?: AuthType[];
  filterStatus?: 'active' | 'expired' | 'revoked' | 'invalid';
  filterScope?: AuthProfileSummary['scope'];
  filterVisibility?: AuthProfileSummary['visibility'];
  /**
   * ABLP-913: restrict to integration- or custom-typed profiles. HTTP tools,
   * MCP servers, and A2A servers must pass 'custom' so vendor-bound
   * Integration profiles do not appear in their pickers.
   */
  filterProfileType?: AuthProfileProfileType;
  /** When set, groups profiles: connector-matched first, then general */
  connectorName?: string;
  /** When true with connectorName, hides the "general" (non-connector) profile group */
  strictConnectorMatch?: boolean;
  /** Profile IDs to exclude from the list (e.g. already used) */
  excludeProfileIds?: Set<string>;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  consumerKind?: AuthProfileConsumerKind;
  /**
   * Profile name that couldn't be resolved to an ID (e.g. because it was
   * revoked/expired and the name→ID lookup against active profiles failed).
   * When set and value is null, the picker shows a warning state.
   */
  staleRefName?: string;
}

interface ProfileGroup {
  label: string;
  profiles: Array<AuthProfileSummary & { isInUse?: boolean }>;
}

export function AuthProfilePicker({
  projectId,
  value,
  onChange,
  filterAuthTypes,
  filterStatus = 'active',
  filterScope,
  filterVisibility,
  filterProfileType,
  connectorName,
  strictConnectorMatch,
  excludeProfileIds,
  placeholder,
  className,
  disabled,
  consumerKind,
  staleRefName,
}: AuthProfilePickerProps) {
  const t = useTranslations('auth_profiles.picker');
  const resolvedPlaceholder = placeholder ?? t('placeholder');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close dropdown on click outside or Escape key
  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const { profiles, isLoading } = useAuthProfiles(projectId, {
    status: filterStatus,
    authType: filterAuthTypes,
    scope: filterScope,
    visibility: filterVisibility,
    profileType: filterProfileType,
    limit: 100,
  });

  // Annotate profiles with isInUse rather than dropping them — the picker
  // renders excluded entries as disabled with an "In use" badge so the user
  // can see why their profile isn't selectable (e.g. already bridged to
  // another connection for the same connector).
  const annotatedProfiles = useMemo(() => {
    if (!excludeProfileIds || excludeProfileIds.size === 0) {
      return profiles.map((p) => ({ ...p, isInUse: false }));
    }
    return profiles.map((p) => ({ ...p, isInUse: excludeProfileIds.has(p.id) }));
  }, [profiles, excludeProfileIds]);

  // Group profiles: connector-matched first, then general (no connector)
  const groups = useMemo((): ProfileGroup[] => {
    if (!connectorName) {
      return [{ label: '', profiles: annotatedProfiles }];
    }

    const connectorProfiles: Array<AuthProfileSummary & { isInUse?: boolean }> = [];
    const generalProfiles: Array<AuthProfileSummary & { isInUse?: boolean }> = [];

    for (const p of annotatedProfiles) {
      if (p.connector === connectorName) {
        connectorProfiles.push(p);
      } else if (!p.connector) {
        generalProfiles.push(p);
      }
    }

    const result: ProfileGroup[] = [];
    if (connectorProfiles.length > 0) {
      const displayName = connectorName.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      result.push({ label: `${displayName} Profiles`, profiles: connectorProfiles });
    }
    if (!strictConnectorMatch && generalProfiles.length > 0) {
      result.push({ label: 'General Profiles', profiles: generalProfiles });
    }
    return result;
  }, [annotatedProfiles, connectorName, strictConnectorMatch]);

  // Find selected across all profiles (including excluded, for display)
  const selected = profiles.find((p) => p.id === value);
  const SelectedIcon = selected ? AUTH_TYPE_METADATA[selected.authType]?.icon : null;

  // When value (ID) is set but not in the filtered list, the profile may have
  // been revoked/expired after it was bound. Fetch it individually to display
  // its name + a warning badge instead of silently showing an empty picker.
  const shouldFetchStale = !!value && !selected && !isLoading;
  const { profile: fetchedStaleProfile } = useAuthProfile(
    shouldFetchStale ? projectId : null,
    shouldFetchStale ? value : null,
  );
  const isStaleSelection = !selected && (!!fetchedStaleProfile || !!staleRefName);
  const staleDisplayName = fetchedStaleProfile?.name ?? staleRefName;
  const staleStatus = fetchedStaleProfile?.status;

  const selectedSupportDecision = useMemo(() => {
    if (!selected || !consumerKind || !isPhase2CoreAuthType(selected.authType)) {
      return null;
    }

    return getAuthProfileSupportDecision(selected.authType, consumerKind);
  }, [selected, consumerKind]);

  const totalAvailable = groups.reduce(
    (sum, g) => sum + g.profiles.filter((p) => !p.isInUse).length,
    0,
  );
  const totalListed = groups.reduce((sum, g) => sum + g.profiles.length, 0);

  return (
    <div ref={containerRef} className={clsx('relative', className)}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={clsx(
          'flex w-full items-center justify-between rounded-lg border px-3 py-2 text-sm transition-default',
          'border-default bg-background-muted text-foreground',
          'hover:border-border-focus/50 focus:outline-none focus:ring-1 focus:ring-border-focus',
          disabled && 'cursor-not-allowed opacity-50',
        )}
      >
        <span className="flex items-center gap-2 truncate">
          {isLoading && !selected && !isStaleSelection && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted" />
          )}
          {!isLoading && SelectedIcon && <SelectedIcon className="h-4 w-4 text-muted" />}
          {selected ? (
            <span className="flex items-center gap-1.5">
              {selected.name}
              {selected.connector && (
                <span className="rounded bg-accent-subtle px-1 py-0.5 text-[10px] text-accent">
                  {selected.connector}
                </span>
              )}
              {selected.scope === 'tenant' && (
                <span className="rounded bg-background-muted px-1 py-0.5 text-[10px] text-muted">
                  Workspace
                </span>
              )}
            </span>
          ) : isStaleSelection && staleDisplayName ? (
            <span className="flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" />
              <span className="truncate">{staleDisplayName}</span>
              {staleStatus && staleStatus !== 'active' && (
                <AuthProfileStatusBadge status={staleStatus} />
              )}
              {!staleStatus && (
                <span className="rounded-full border border-warning/40 bg-warning-subtle px-2 py-0.5 text-[10px] font-semibold text-warning">
                  {t('stale_badge_unavailable')}
                </span>
              )}
            </span>
          ) : (
            <span className="text-subtle">{isLoading ? t('loading') : resolvedPlaceholder}</span>
          )}
        </span>
        <ChevronDown className="h-4 w-4 text-muted" />
      </button>

      {open && !disabled && (
        <div
          role="listbox"
          className="absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-xl border border-default bg-background-elevated shadow-xl animate-fade-in-scale"
        >
          {isLoading && <div className="px-3 py-2 text-sm text-subtle">{t('loading')}</div>}

          {(value || isStaleSelection) && (
            <button
              type="button"
              role="option"
              aria-selected={false}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-subtle transition-default hover:bg-background-muted border-b border-default"
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
            >
              <span className="flex-1 truncate text-left">{t('no_auth_profile')}</span>
            </button>
          )}

          {groups.map((group, gi) => (
            <div key={gi}>
              {group.label && (
                <div className="sticky top-0 z-10 bg-background-elevated px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted border-b border-default">
                  {group.label}
                </div>
              )}
              {group.profiles.map((profile) => {
                const Icon = AUTH_TYPE_METADATA[profile.authType]?.icon;
                const supportDecision =
                  consumerKind && isPhase2CoreAuthType(profile.authType)
                    ? getAuthProfileSupportDecision(profile.authType, consumerKind)
                    : null;
                return (
                  <button
                    key={profile.id}
                    type="button"
                    role="option"
                    aria-selected={value === profile.id}
                    aria-disabled={profile.isInUse}
                    disabled={profile.isInUse}
                    title={
                      profile.isInUse
                        ? 'Already bound to another connection for this connector — auth profiles can only back one connection per connector at a time.'
                        : undefined
                    }
                    className={clsx(
                      'flex w-full items-center gap-2 px-3 py-2 text-sm transition-default',
                      profile.isInUse
                        ? 'cursor-not-allowed text-muted'
                        : 'text-foreground hover:bg-background-muted',
                      value === profile.id && !profile.isInUse && 'bg-accent-subtle',
                    )}
                    onClick={() => {
                      if (profile.isInUse) return;
                      onChange(profile.id);
                      setOpen(false);
                    }}
                  >
                    {Icon && <Icon className="h-4 w-4 shrink-0 text-muted" />}
                    <span className="flex-1 truncate text-left">{profile.name}</span>
                    {profile.isInUse && (
                      <span className="rounded bg-background-muted px-1 py-0.5 text-[10px] text-muted">
                        In use
                      </span>
                    )}
                    {supportDecision?.level === 'attach_only' && (
                      <span className="rounded bg-warning-subtle px-1 py-0.5 text-[10px] text-warning">
                        Attach only
                      </span>
                    )}
                    {profile.scope === 'tenant' && (
                      <span className="rounded bg-background-muted px-1 py-0.5 text-[10px] text-muted">
                        Workspace
                      </span>
                    )}
                    <AuthProfileStatusBadge status={profile.status} />
                  </button>
                );
              })}
            </div>
          ))}

          {!isLoading && totalListed === 0 && (
            <div className="px-3 py-3 text-sm text-subtle text-center">
              {connectorName ? `No auth profiles available for this connector` : t('empty')}
            </div>
          )}
          {!isLoading && totalListed > 0 && totalAvailable === 0 && (
            <div className="border-t border-default px-3 py-2 text-xs text-muted">
              All matching profiles are already bound to another connection. Create a new auth
              profile to add another connection for this connector.
            </div>
          )}
        </div>
      )}

      {isStaleSelection && (
        <div className="mt-2 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-subtle px-3 py-2 text-xs text-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <p>
            {t('stale_warning', {
              status:
                staleStatus === 'revoked'
                  ? t('stale_status_revoked')
                  : staleStatus === 'expired'
                    ? t('stale_status_expired')
                    : staleStatus === 'invalid'
                      ? t('stale_status_invalid')
                      : t('stale_status_unavailable'),
            })}
          </p>
        </div>
      )}

      {selectedSupportDecision?.level === 'attach_only' && (
        <div className="mt-2 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-subtle px-3 py-2 text-xs text-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <p>{selectedSupportDecision.message}</p>
        </div>
      )}
    </div>
  );
}
