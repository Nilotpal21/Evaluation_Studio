/**
 * Shared utilities and constants for the channel system.
 */

import type { BadgeVariant } from '../../ui/Badge';
import type { InstanceStatus } from './types';

// =============================================================================
// STATUS MAPS
// =============================================================================

export const STATUS_BADGE_VARIANT: Record<InstanceStatus, BadgeVariant> = {
  active: 'success',
  inactive: 'default',
  paused: 'warning',
  error: 'error',
};

export const STATUS_LABEL: Record<InstanceStatus, string> = {
  active: 'Active',
  inactive: 'Inactive',
  paused: 'Paused',
  error: 'Error',
};

export const STATUS_DOT_COLOR: Record<InstanceStatus, string> = {
  active: 'bg-success',
  inactive: 'bg-muted',
  paused: 'bg-warning',
  error: 'bg-error',
};

// =============================================================================
// DATE FORMATTING
// =============================================================================

export function formatDate(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function timeAgo(date: string | null): string {
  if (!date) return '\u2014';
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// =============================================================================
// ENVIRONMENT OPTIONS
// =============================================================================

export const WORKING_COPY_LABEL = 'Working Copy (draft)';
export const AUTO_RESOLVE_DEPLOYMENT_LABEL = 'None (use environment auto-resolve)';

export const ENVIRONMENT_OPTIONS = [
  { value: '', label: WORKING_COPY_LABEL },
  { value: 'dev', label: 'Development' },
  { value: 'staging', label: 'Staging' },
  { value: 'production', label: 'Production' },
];
