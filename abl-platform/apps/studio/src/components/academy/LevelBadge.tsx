'use client';

import { Badge, type BadgeVariant } from '@/components/ui/Badge';

interface LevelBadgeProps {
  level: string;
}

/**
 * Map a level string to a Badge variant.
 * Mixed levels (e.g. "beginner-intermediate") use the higher level's variant.
 */
function getLevelVariant(level: string): BadgeVariant {
  const normalized = level.toLowerCase();

  if (normalized === 'advanced' || normalized === 'intermediate-advanced') {
    return 'purple';
  }

  if (normalized === 'intermediate' || normalized === 'beginner-intermediate') {
    return 'warning';
  }

  // Default: beginner
  return 'success';
}

function formatLevel(level: string): string {
  return level
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('-');
}

export function LevelBadge({ level }: LevelBadgeProps) {
  return (
    <Badge variant={getLevelVariant(level)} className="text-xs">
      {formatLevel(level)}
    </Badge>
  );
}
