'use client';

import { useTranslations } from 'next-intl';
import { Shield } from 'lucide-react';

interface RankBadgeProps {
  /** Current rank title (e.g. "Explorer", "Architect") */
  rankTitle: string | null;
  /** Total accumulated points */
  points: number;
  /** Current rank level (1-based) for visual coloring */
  rankLevel?: number;
}

/**
 * Displays the user's current rank with a visual indicator.
 */
export function RankBadge({ rankTitle, points, rankLevel }: RankBadgeProps) {
  const t = useTranslations('academy');

  // Derive icon circle colors from rank level
  let circleBg = 'bg-background-muted';
  let iconColor = 'text-muted';
  if (rankLevel !== undefined) {
    if (rankLevel >= 5) {
      circleBg = 'bg-purple-subtle';
      iconColor = 'text-purple';
    } else if (rankLevel >= 3) {
      circleBg = 'bg-accent-subtle';
      iconColor = 'text-accent';
    }
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border border-default bg-background-muted px-4 py-3">
      <div
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${circleBg}`}
      >
        <Shield className={`h-5 w-5 ${iconColor}`} />
      </div>
      <div className="flex flex-col">
        <span className="text-xs font-medium uppercase text-muted">
          {t('rank_label', { rank: rankTitle ?? t('no_rank') })}
        </span>
        <span className="text-sm font-semibold text-foreground">{rankTitle ?? t('no_rank')}</span>
        <span className="text-xs text-muted">
          {points} {t('points_label').toLowerCase()}
        </span>
      </div>
    </div>
  );
}
