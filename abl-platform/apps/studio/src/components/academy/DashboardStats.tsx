'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { AcademyBadgeConfig, AcademyRankConfig } from '@/store/academy-store';
import { BadgeGrid } from './BadgeGrid';
import { RankBadge } from './RankBadge';
import { StreakIndicator } from './StreakIndicator';

interface DashboardStatsProps {
  /** User's total points */
  points: number;
  /** Array of earned badge IDs */
  badges: string[];
  /** Array of streak day strings (YYYY-MM-DD) */
  streakDays: string[];
  /** Last active date string or null */
  lastActiveDate: string | null;
  /** Full badge configuration from academy config */
  allBadges: AcademyBadgeConfig[];
  /** Rank configuration from academy config */
  ranks: AcademyRankConfig[];
}

/**
 * Derives the current rank from points and rank config.
 * Ranks are sorted by minPoints descending; the first match is the current rank.
 * Returns both title and level for visual coloring.
 */
function deriveRank(
  points: number,
  ranks: AcademyRankConfig[],
): { title: string; level: number } | null {
  const sorted = [...ranks].sort((a, b) => b.minPoints - a.minPoints);
  for (const rank of sorted) {
    if (points >= rank.minPoints) {
      return { title: rank.title, level: rank.level };
    }
  }
  return null;
}

/**
 * Dashboard stats widget that combines all gamification indicators:
 * rank badge, streak indicator, and a collapsible badge section.
 *
 * Badges default to collapsed to keep courses as the primary content.
 */
export function DashboardStats({
  points,
  badges,
  streakDays,
  lastActiveDate,
  allBadges,
  ranks,
}: DashboardStatsProps) {
  const t = useTranslations('academy');
  const [badgesExpanded, setBadgesExpanded] = useState(false);

  const rank = useMemo(() => deriveRank(points, ranks), [points, ranks]);

  const earnedBadges = useMemo(() => {
    const earnedSet = new Set(badges);
    return allBadges.filter((b) => earnedSet.has(b.id));
  }, [badges, allBadges]);

  return (
    <div className="animate-fade-in-up space-y-4">
      <h3 className="text-sm font-semibold text-foreground">{t('stats_title')}</h3>

      {/* Rank and streak side by side */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <RankBadge rankTitle={rank?.title ?? null} points={points} rankLevel={rank?.level} />
        <StreakIndicator streakDays={streakDays} lastActiveDate={lastActiveDate} />
      </div>

      {/* Badges — compact summary with expandable full grid */}
      <div>
        <button
          type="button"
          onClick={() => setBadgesExpanded((v) => !v)}
          className="flex w-full items-center justify-between rounded-lg border border-border bg-background-elevated px-4 py-3 text-left transition-default hover:bg-background-muted"
        >
          <div className="flex items-center gap-3">
            <span className="text-xs font-semibold uppercase text-muted">{t('badges')}</span>
            <span className="text-xs text-foreground-muted">
              {badges.length} / {allBadges.length}
            </span>
            {/* Show earned badge icons inline */}
            {earnedBadges.length > 0 && (
              <div className="flex items-center gap-1">
                {earnedBadges.slice(0, 6).map((badge) => (
                  <span key={badge.id} className="text-sm" title={badge.title}>
                    {badge.icon}
                  </span>
                ))}
                {earnedBadges.length > 6 && (
                  <span className="text-xs text-foreground-muted">+{earnedBadges.length - 6}</span>
                )}
              </div>
            )}
          </div>
          {badgesExpanded ? (
            <ChevronUp className="h-4 w-4 text-foreground-muted" />
          ) : (
            <ChevronDown className="h-4 w-4 text-foreground-muted" />
          )}
        </button>

        {badgesExpanded && (
          <div className="mt-3">
            <BadgeGrid badges={badges} allBadges={allBadges} />
          </div>
        )}
      </div>
    </div>
  );
}
