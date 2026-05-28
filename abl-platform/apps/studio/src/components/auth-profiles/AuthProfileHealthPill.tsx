'use client';

/**
 * AuthProfileHealthPill — Operational status pill for an auth profile.
 *
 * Renders a single colored pill plus a short reason line so users can tell at
 * a glance whether a profile will actually authenticate when invoked. Drives
 * off the AuthProfileHealth struct returned by the validate route.
 *
 * Used in:
 *   - AuthProfileSlideOver (header — edit mode only)
 *   - AuthProfilesPage list cards (Phase A.9; both project + workspace scope)
 *   - IntegrationCard summary
 *
 * The pill style is deliberately minimal — semantic-token colors only, no
 * hardcoded palette values, following the design-token enforcement rule.
 */

import { clsx } from 'clsx';
import {
  CheckCircle,
  AlertTriangle,
  AlertCircle,
  CircleSlash,
  ShieldQuestion,
  Loader2,
  type LucideIcon,
} from 'lucide-react';

export type AuthProfileHealthState =
  | 'connected'
  | 'connected_no_auto_renew'
  | 'reauth_required'
  | 'not_authorized'
  | 'requires_user_authorization'
  | 'verified'
  | 'untested'
  | 'configuration_error'
  | 'lifecycle_blocked';

export interface AuthProfileHealthShape {
  state: AuthProfileHealthState;
  reason: string;
  lastVerifiedAt?: string;
  refreshTokenStored?: boolean;
}

interface AuthProfileHealthPillProps {
  /** When undefined, renders a "Loading…" placeholder. */
  health: AuthProfileHealthShape | undefined;
  /** When true, renders the inline reason line below the pill. */
  showReason?: boolean;
  /** Optional fallback when health is undefined and not loading (e.g. fetch failed). */
  fallbackLabel?: string;
  /** When true, render with smaller padding/font for use in dense list cards. */
  compact?: boolean;
  className?: string;
}

interface PillStyle {
  label: string;
  /** Tailwind classes built from semantic design tokens — no raw palette colors */
  pill: string;
  icon: LucideIcon;
}

const STYLES: Record<AuthProfileHealthState, PillStyle> = {
  connected: {
    label: 'Connected',
    pill: 'border-success/40 bg-success-subtle text-success',
    icon: CheckCircle,
  },
  connected_no_auto_renew: {
    label: 'Connected (no auto-refresh)',
    pill: 'border-warning/40 bg-warning-subtle text-warning',
    icon: AlertTriangle,
  },
  reauth_required: {
    label: 'Re-authorization required',
    pill: 'border-error/40 bg-error-subtle text-error',
    icon: AlertCircle,
  },
  not_authorized: {
    label: 'Not authorized',
    pill: 'border-default bg-background-muted text-muted',
    icon: ShieldQuestion,
  },
  requires_user_authorization: {
    label: 'User-authorized at runtime',
    pill: 'border-info/40 bg-info-subtle text-info',
    icon: ShieldQuestion,
  },
  verified: {
    label: 'Verified',
    pill: 'border-success/40 bg-success-subtle text-success',
    icon: CheckCircle,
  },
  untested: {
    label: 'Untested',
    pill: 'border-default bg-background-muted text-muted',
    icon: ShieldQuestion,
  },
  configuration_error: {
    label: 'Configuration error',
    pill: 'border-error/40 bg-error-subtle text-error',
    icon: AlertCircle,
  },
  lifecycle_blocked: {
    label: 'Inactive',
    pill: 'border-default bg-background-muted text-muted',
    icon: CircleSlash,
  },
};

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const deltaMs = Date.now() - then;
  if (deltaMs < 0) return 'just now';
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function AuthProfileHealthPill({
  health,
  showReason = false,
  fallbackLabel,
  compact = false,
  className,
}: AuthProfileHealthPillProps) {
  if (health === undefined) {
    return (
      <span
        className={clsx(
          'inline-flex items-center gap-1.5 rounded-full border border-default bg-background-muted text-muted whitespace-nowrap',
          compact ? 'px-2.5 py-1 text-[11px] leading-4' : 'px-3 py-1 text-xs leading-4',
          className,
        )}
      >
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
        {fallbackLabel ?? 'Checking…'}
      </span>
    );
  }

  const style = STYLES[health.state];
  const Icon = style.icon;

  const pill = (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full border font-medium whitespace-nowrap',
        style.pill,
        compact ? 'px-2.5 py-1 text-[11px] leading-4' : 'px-3 py-1 text-xs leading-4',
        className,
      )}
      aria-label={`${style.label}: ${health.reason}`}
    >
      <Icon className="h-3 w-3 shrink-0" aria-hidden />
      {style.label}
    </span>
  );

  if (!showReason) return pill;

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        {pill}
        {health.lastVerifiedAt && (
          <span className="text-xs text-muted">
            Verified {formatRelativeTime(health.lastVerifiedAt)}
          </span>
        )}
      </div>
      <p className="text-xs text-muted">{health.reason}</p>
    </div>
  );
}
