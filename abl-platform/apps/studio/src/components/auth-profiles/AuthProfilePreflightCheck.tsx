/**
 * AuthProfilePreflightCheck
 *
 * Shows auth profile status in the deployment pre-check panel.
 * Warns if any referenced profile is not 'active'.
 * Links to the Auth Profiles settings page to fix issues.
 */

'use client';

import { useMemo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { CheckCircle, AlertTriangle } from 'lucide-react';
import { clsx } from 'clsx';
import { useNavigationStore } from '../../store/navigation-store';
import { useAuthProfiles } from '../../hooks/useAuthProfiles';
import { AuthProfileStatusBadge } from './AuthProfileStatusBadge';

interface AuthProfilePreflightCheckProps {
  projectId: string;
  referencedProfileIds: string[];
}

export function AuthProfilePreflightCheck({
  projectId,
  referencedProfileIds,
}: AuthProfilePreflightCheckProps) {
  const t = useTranslations('auth_profiles.preflight');
  const navigate = useNavigationStore((s) => s.navigate);
  const { profiles, isLoading } = useAuthProfiles(projectId);

  const goToAuthProfiles = useCallback(() => {
    navigate(`/projects/${projectId}/settings/auth-profiles`);
  }, [navigate, projectId]);

  const referenced = useMemo(() => {
    const idSet = new Set(referencedProfileIds);
    return profiles.filter((p) => idSet.has(p.id));
  }, [profiles, referencedProfileIds]);

  const nonActive = referenced.filter((p) => p.status !== 'active');
  const allGood = nonActive.length === 0 && referenced.length > 0;

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 p-3 rounded-lg bg-background-muted">
        <div className="w-4 h-4 rounded-full skeleton" />
        <div className="h-3 w-40 rounded skeleton" />
      </div>
    );
  }

  if (referencedProfileIds.length === 0) return null;

  return (
    <div
      className={clsx(
        'p-3 rounded-lg border',
        allGood ? 'border-success/30 bg-success-subtle' : 'border-warning/30 bg-warning-subtle',
      )}
    >
      <div className="flex items-center gap-2 mb-1">
        {allGood ? (
          <>
            <CheckCircle className="w-4 h-4 text-success shrink-0" />
            <span className="text-sm font-medium text-success">{t('all_active')}</span>
          </>
        ) : (
          <>
            <AlertTriangle className="w-4 h-4 text-warning shrink-0" />
            <span className="text-sm font-medium text-warning">
              {t('not_active_count', { count: nonActive.length })}
            </span>
          </>
        )}
      </div>

      {nonActive.length > 0 && (
        <div className="space-y-1.5 mt-2">
          {nonActive.map((profile) => (
            <div key={profile.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="text-foreground">{profile.name}</span>
              <div className="flex items-center gap-2">
                <AuthProfileStatusBadge status={profile.status} />
                <button
                  type="button"
                  onClick={goToAuthProfiles}
                  className="text-info hover:underline text-xs"
                >
                  {t('fix')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
