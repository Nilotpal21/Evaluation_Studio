'use client';

import { clsx } from 'clsx';
import { ShieldCheck, ShieldAlert, ShieldOff, ShieldX, Hourglass } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { AUTH_STATUS_COLORS } from './auth-type-metadata';
import type { AuthProfileStatus } from '../../api/auth-profiles';

// Icon + color for the icon-only variant. Shield family fits the auth domain;
// distinct shapes per state stay readable without relying solely on color.
const AUTH_STATUS_ICONS: Record<AuthProfileStatus, { Icon: LucideIcon; className: string }> = {
  active: { Icon: ShieldCheck, className: 'text-success' },
  expired: { Icon: ShieldAlert, className: 'text-warning' },
  revoked: { Icon: ShieldOff, className: 'text-error' },
  invalid: { Icon: ShieldX, className: 'text-error' },
  pending_authorization: { Icon: Hourglass, className: 'text-info' },
};

interface AuthProfileStatusBadgeProps {
  status: AuthProfileStatus;
  className?: string;
  /**
   * Render as a compact icon-only dot (used in the dense table view).
   * The full text label is exposed via the title attribute for tooltips and
   * remains in the DOM for screen readers.
   */
  iconOnly?: boolean;
}

const AUTH_STATUS_LABELS: Record<AuthProfileStatus, string> = {
  active: 'Active',
  pending_authorization: 'Awaiting authorization',
  expired: 'Expired',
  revoked: 'Revoked',
  invalid: 'Invalid',
};

export function AuthProfileStatusBadge({
  status,
  className,
  iconOnly = false,
}: AuthProfileStatusBadgeProps) {
  const colors = AUTH_STATUS_COLORS[status] ?? AUTH_STATUS_COLORS.invalid;
  const label = AUTH_STATUS_LABELS[status] ?? status;

  if (iconOnly) {
    const { Icon, className: iconClassName } =
      AUTH_STATUS_ICONS[status] ?? AUTH_STATUS_ICONS.invalid;
    return (
      <span title={label} aria-label={label} className="inline-flex">
        <Icon className={clsx('h-4 w-4', iconClassName, className)} />
      </span>
    );
  }

  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full border whitespace-nowrap px-3 py-1 text-xs font-semibold leading-4',
        colors,
        className,
      )}
    >
      {label}
    </span>
  );
}
