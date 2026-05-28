/**
 * AuthProfileAssignment (FR-18)
 *
 * Stepped, type-aware auth profile assignment component.
 * Step 1: Select auth type with categories Common/Enterprise/Advanced (D-15).
 * Step 2: Profile selection via dropdown + prominent "Create Auth Profile" CTA.
 *   - Disabled-row pattern for unauthorized OAuth profiles (D-3)
 *   - Empty state with inline Create CTA
 *   - Inline-Add removed per 2026-05-09 meeting retraction (FR-20)
 *
 * Coexists with existing AuthProfilePicker (D-10) — does NOT replace it.
 */

'use client';

import { useState, useMemo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { clsx } from 'clsx';
import { ArrowLeft, Plus, ChevronDown, Lock } from 'lucide-react';
import { useAuthProfiles } from '../../hooks/useAuthProfiles';
import { AuthProfileStatusBadge } from './AuthProfileStatusBadge';
import { AuthProfileAuthorizationBadge } from './AuthProfileAuthorizationBadge';
import { AUTH_TYPE_METADATA, PHASE_TIER_CATEGORIES, type PhaseTier } from './auth-type-metadata';
import type { AuthType, AuthProfileSummary } from '../../api/auth-profiles';

// =============================================================================
// TYPES
// =============================================================================

export interface AuthProfileAssignmentValue {
  profileId: string | null;
}

interface AuthProfileAssignmentProps {
  projectId: string;
  value: AuthProfileAssignmentValue;
  onChange: (value: AuthProfileAssignmentValue) => void;
  /** Pre-select a specific auth type (skip step 1) */
  preselectedAuthType?: AuthType;
  /** Profile IDs to exclude from the dropdown */
  excludeProfileIds?: Set<string>;
  /** Called when user clicks "Create Auth Profile" CTA */
  onCreateProfile?: (authType: AuthType) => void;
  disabled?: boolean;
  className?: string;
}

// =============================================================================
// HELPERS
// =============================================================================

/** Group auth types by their phaseTier, excluding 'none' and system types */
function getTypesByTier(): Map<
  PhaseTier,
  { type: string; meta: (typeof AUTH_TYPE_METADATA)[string] }[]
> {
  const grouped = new Map<
    PhaseTier,
    { type: string; meta: (typeof AUTH_TYPE_METADATA)[string] }[]
  >();

  for (const tier of PHASE_TIER_CATEGORIES) {
    grouped.set(tier.key, []);
  }

  for (const [type, meta] of Object.entries(AUTH_TYPE_METADATA)) {
    if (type === 'none') continue; // 'none' is not assignable
    const tier = meta.phaseTier;
    const list = grouped.get(tier);
    if (list) {
      list.push({ type, meta });
    }
  }

  return grouped;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function AuthProfileAssignment({
  projectId,
  value,
  onChange,
  preselectedAuthType,
  excludeProfileIds,
  onCreateProfile,
  disabled,
  className,
}: AuthProfileAssignmentProps) {
  const t = useTranslations('auth_profiles.assignment');
  const [selectedAuthType, setSelectedAuthType] = useState<AuthType | null>(
    preselectedAuthType ?? null,
  );
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const step: 'select-type' | 'select-profile' =
    selectedAuthType !== null ? 'select-profile' : 'select-type';

  // Fetch profiles filtered by selected auth type
  const { profiles, isLoading } = useAuthProfiles(
    selectedAuthType ? projectId : null,
    selectedAuthType ? { authType: selectedAuthType, status: 'active' } : {},
  );

  const filteredProfiles = useMemo(() => {
    if (!excludeProfileIds || excludeProfileIds.size === 0) return profiles;
    return profiles.filter((p) => !excludeProfileIds.has(p.id));
  }, [profiles, excludeProfileIds]);

  const selectedProfile = profiles.find((p) => p.id === value.profileId);

  const typesByTier = useMemo(getTypesByTier, []);

  const handleTypeSelect = useCallback(
    (type: AuthType) => {
      setSelectedAuthType(type);
      onChange({ profileId: null });
    },
    [onChange],
  );

  const handleProfileSelect = useCallback(
    (profile: AuthProfileSummary) => {
      onChange({ profileId: profile.id });
      setDropdownOpen(false);
    },
    [onChange],
  );

  const handleBackToType = useCallback(() => {
    if (preselectedAuthType) return; // Can't go back if type is pre-selected
    setSelectedAuthType(null);
    onChange({ profileId: null });
  }, [preselectedAuthType, onChange]);

  // =============================================================================
  // STEP 1: Type Selector
  // =============================================================================

  if (step === 'select-type') {
    return (
      <div className={clsx('space-y-4', className)}>
        <div>
          <p className="text-sm font-medium text-foreground">{t('step1_title')}</p>
          <p className="mt-0.5 text-xs text-muted">{t('step1_description')}</p>
        </div>

        {PHASE_TIER_CATEGORIES.map((tier) => {
          const types = typesByTier.get(tier.key);
          if (!types || types.length === 0) return null;

          const isAdvanced = tier.key === 'advanced';

          return (
            <div key={tier.key}>
              <h4
                className={clsx(
                  'text-xs font-medium uppercase tracking-wider mb-1.5',
                  isAdvanced ? 'text-subtle' : 'text-muted',
                )}
              >
                {t(
                  `category_${tier.key}` as
                    | 'category_common'
                    | 'category_enterprise'
                    | 'category_advanced',
                )}
              </h4>
              {isAdvanced && <p className="text-xs text-subtle mb-1.5">{t('advanced_note')}</p>}
              <div className="space-y-1">
                {types.map(({ type, meta }) => {
                  const Icon = meta.icon;
                  return (
                    <button
                      key={type}
                      type="button"
                      disabled={disabled}
                      onClick={() => handleTypeSelect(type as AuthType)}
                      className={clsx(
                        'w-full flex items-center gap-3 p-2.5 rounded-lg border border-default text-left',
                        'hover:border-accent hover:bg-accent-subtle/30 transition-default btn-press',
                        isAdvanced && 'opacity-60 hover:opacity-80',
                        disabled && 'cursor-not-allowed opacity-50',
                      )}
                    >
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-background-muted shrink-0">
                        <Icon className="h-3.5 w-3.5 text-muted" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-foreground">{meta.label}</p>
                        <p className="text-xs text-muted truncate">{meta.description}</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // =============================================================================
  // STEP 2: Profile Selection
  // =============================================================================

  const meta = selectedAuthType ? AUTH_TYPE_METADATA[selectedAuthType] : null;

  return (
    <div className={clsx('space-y-3', className)}>
      {/* Header with back button */}
      <div className="flex items-center gap-2">
        {!preselectedAuthType && (
          <button
            type="button"
            onClick={handleBackToType}
            className="p-1 rounded-md text-muted hover:text-foreground hover:bg-background-muted transition-default btn-press"
            aria-label={t('back_to_type')}
          >
            <ArrowLeft className="w-3.5 h-3.5" />
          </button>
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground">{t('step2_title')}</p>
          {meta && <p className="text-xs text-muted">{meta.label}</p>}
        </div>
        {preselectedAuthType === undefined && selectedAuthType && (
          <button
            type="button"
            onClick={handleBackToType}
            className="text-xs text-accent hover:underline"
          >
            {t('change_type')}
          </button>
        )}
      </div>

      {/* Profile Dropdown */}
      <div className="relative">
        <button
          type="button"
          disabled={disabled}
          onClick={() => setDropdownOpen(!dropdownOpen)}
          className={clsx(
            'flex w-full items-center justify-between rounded-lg border px-3 py-2 text-sm transition-default',
            'border-default bg-background-muted text-foreground',
            'hover:border-border-focus/50 focus:outline-none focus:ring-1 focus:ring-border-focus',
            disabled && 'cursor-not-allowed opacity-50',
          )}
        >
          <span className="truncate">
            {selectedProfile ? (
              <span className="flex items-center gap-1.5">
                {selectedProfile.name}
                <AuthProfileStatusBadge status={selectedProfile.status} />
                {(selectedProfile.authType === 'oauth2_app' ||
                  selectedProfile.authType === 'oauth2_client_credentials') && (
                  <AuthProfileAuthorizationBadge
                    isAuthorized={
                      selectedProfile.isAuthorized ??
                      selectedProfile.status !== 'pending_authorization'
                    }
                  />
                )}
              </span>
            ) : (
              <span className="text-subtle">{t('select_profile_placeholder')}</span>
            )}
          </span>
          <ChevronDown className="h-4 w-4 text-muted shrink-0" />
        </button>

        {dropdownOpen && !disabled && (
          <div className="absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-xl border border-default bg-background-elevated shadow-xl animate-fade-in-scale">
            {isLoading && <div className="px-3 py-2 text-sm text-subtle">Loading...</div>}

            {/* Profile list */}
            {filteredProfiles.map((profile) => {
              // D-3: disabled-row for unauthorized OAuth profiles
              const isUnauthorized =
                profile.authType === 'oauth2_app' && profile.isAuthorized === false;
              const isSelectable = !isUnauthorized;

              return (
                <button
                  key={profile.id}
                  type="button"
                  role="option"
                  aria-selected={value.profileId === profile.id}
                  disabled={!isSelectable}
                  className={clsx(
                    'flex w-full items-center gap-2 px-3 py-2 text-sm transition-default',
                    isSelectable
                      ? 'hover:bg-background-muted text-foreground'
                      : 'cursor-not-allowed opacity-50 text-muted',
                    value.profileId === profile.id && 'bg-accent-subtle',
                  )}
                  onClick={() => isSelectable && handleProfileSelect(profile)}
                  title={isUnauthorized ? t('unauthorized_tooltip') : undefined}
                >
                  <div className="flex-1 truncate text-left">
                    <span>{profile.name}</span>
                  </div>
                  {isUnauthorized && <Lock className="h-3.5 w-3.5 text-muted shrink-0" />}
                  {profile.isAuthorized !== undefined && (
                    <AuthProfileAuthorizationBadge isAuthorized={profile.isAuthorized ?? false} />
                  )}
                  <AuthProfileStatusBadge status={profile.status} />
                </button>
              );
            })}

            {/* Create Auth Profile CTA — always visible, prominent */}
            {onCreateProfile && selectedAuthType && (
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-sm font-medium text-accent hover:bg-background-muted transition-default border-t border-default"
                onClick={() => {
                  onCreateProfile(selectedAuthType);
                  setDropdownOpen(false);
                }}
              >
                <Plus className="h-3.5 w-3.5" />
                {t('create_profile_cta')}
              </button>
            )}

            {/* Empty state */}
            {!isLoading && filteredProfiles.length === 0 && (
              <div className="px-3 py-4 text-center">
                <p className="text-sm text-muted">{t('empty_state')}</p>
                {onCreateProfile && selectedAuthType && (
                  <button
                    type="button"
                    className="mt-1 text-xs text-accent hover:underline"
                    onClick={() => {
                      onCreateProfile(selectedAuthType);
                      setDropdownOpen(false);
                    }}
                  >
                    {t('empty_state_cta')}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Clear selection */}
      {value.profileId && (
        <button
          type="button"
          className="text-xs text-muted hover:text-foreground transition-default"
          onClick={() => onChange({ profileId: null })}
        >
          {t('clear_selection')}
        </button>
      )}
    </div>
  );
}
