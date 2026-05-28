/**
 * ProfileCard Component
 *
 * Card display for a single behavior profile in the list view.
 * Shows name, priority, WHEN expression, usage count, and override categories.
 */

import { clsx } from 'clsx';
import { Clock, Users } from 'lucide-react';
import { Badge } from '../ui/Badge';
import type { ProfileSummary } from '../../store/profile-store';
import { getCategoryVariant } from './constants';

// =============================================================================
// TYPES
// =============================================================================

interface ProfileCardProps {
  profile: ProfileSummary;
  onClick: () => void;
}

// =============================================================================
// HELPERS
// =============================================================================

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffDay > 30) return date.toLocaleDateString();
  if (diffDay > 0) return `${diffDay}d ago`;
  if (diffHr > 0) return `${diffHr}h ago`;
  if (diffMin > 0) return `${diffMin}m ago`;
  return 'just now';
}

// =============================================================================
// COMPONENT
// =============================================================================

export function ProfileCard({ profile, onClick }: ProfileCardProps) {
  return (
    <div
      onClick={onClick}
      className={clsx(
        'p-4 rounded-xl border border-default bg-background-muted',
        'shadow-sm cursor-pointer card-hover transition-default',
        'flex flex-col gap-3',
      )}
    >
      {/* Header: name + priority */}
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-lg font-semibold text-foreground truncate">
          {profile.name.replace(/_/g, ' ')}
        </h3>
        <Badge variant="accent" className="shrink-0">
          P{profile.priority}
        </Badge>
      </div>

      {/* WHEN expression */}
      <p className="font-mono text-xs text-muted line-clamp-2 min-h-[2.5em]">
        WHEN {profile.whenExpression}
      </p>

      {/* Override category chips */}
      {profile.overrideCategories.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {profile.overrideCategories.map((cat) => (
            <Badge key={cat} variant={getCategoryVariant(cat)} className="text-xs">
              {cat}
            </Badge>
          ))}
        </div>
      )}

      {/* Footer: usage + updated */}
      <div className="flex items-center justify-between text-xs text-muted pt-1 border-t border-default/50">
        <span className="flex items-center gap-1">
          <Users className="w-3 h-3" />
          Used by {profile.usedByAgents.length} agent{profile.usedByAgents.length !== 1 ? 's' : ''}
        </span>
        <span className="flex items-center gap-1">
          <Clock className="w-3 h-3" />
          {formatRelativeTime(profile.updatedAt)}
        </span>
      </div>
    </div>
  );
}
