/**
 * AuthProfileAuthorizationBadge (FR-14)
 *
 * Renders "To be Authorized" or "Authorized as user@x" based on per-user
 * computed `isAuthorized` field. Orthogonal to lifecycle status badge.
 */

'use client';

import { useTranslations } from 'next-intl';
import { clsx } from 'clsx';
import { ShieldCheck, ShieldAlert } from 'lucide-react';

interface AuthProfileAuthorizationBadgeProps {
  isAuthorized: boolean;
  /** Email of the user who authorized (shown when authorized) */
  authorizedEmail?: string | null;
  className?: string;
}

export function AuthProfileAuthorizationBadge({
  isAuthorized,
  authorizedEmail,
  className,
}: AuthProfileAuthorizationBadgeProps) {
  const t = useTranslations('auth_profiles.authorization');

  if (isAuthorized) {
    const label = authorizedEmail
      ? t('authorized_as', { email: authorizedEmail })
      : t('authorized');

    return (
      <span
        className={clsx(
          'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
          'bg-success-subtle text-success border-success-muted',
          className,
        )}
      >
        <ShieldCheck className="h-3 w-3 shrink-0" />
        {label}
      </span>
    );
  }

  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
        'bg-warning-subtle text-warning border-warning',
        className,
      )}
    >
      <ShieldAlert className="h-3 w-3 shrink-0" />
      {t('to_be_authorized')}
    </span>
  );
}
