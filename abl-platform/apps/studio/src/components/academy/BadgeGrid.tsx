'use client';

import { useTranslations } from 'next-intl';
import { motion } from 'framer-motion';
import type { AcademyBadgeConfig } from '@/store/academy-store';

interface BadgeGridProps {
  /** IDs of badges the user has earned */
  badges: string[];
  /** Full badge configuration array from config */
  allBadges: AcademyBadgeConfig[];
}

/**
 * Displays earned badges as a grid.
 * Earned badges are highlighted; unearned badges appear greyed out.
 */
export function BadgeGrid({ badges, allBadges }: BadgeGridProps) {
  const t = useTranslations('academy');
  const earnedSet = new Set(badges);

  if (allBadges.length === 0) {
    return <p className="text-sm text-muted">{t('no_badges')}</p>;
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
      {allBadges.map((badge, index) => {
        const isEarned = earnedSet.has(badge.id);

        const cardContent = (
          <>
            <span className="text-2xl" role="img" aria-label={badge.title}>
              {badge.icon}
            </span>
            <span
              className={`text-xs font-semibold ${isEarned ? 'text-foreground' : 'text-muted'}`}
            >
              {badge.title}
            </span>
            <span className="text-xs text-muted">{badge.description}</span>
            <span
              className={`mt-0.5 text-xs font-medium uppercase ${
                isEarned ? 'text-accent' : 'text-muted'
              }`}
            >
              {isEarned ? t('badge_earned') : t('badge_locked')}
            </span>
          </>
        );

        if (isEarned) {
          return (
            <motion.div
              key={badge.id}
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{
                delay: index * 0.08,
                type: 'spring',
                stiffness: 300,
                damping: 25,
              }}
              className="hover-lift flex flex-col items-center gap-1.5 rounded-lg border border-accent bg-accent-subtle p-3 text-center transition-colors"
            >
              {cardContent}
            </motion.div>
          );
        }

        return (
          <div
            key={badge.id}
            className="hover-lift flex flex-col items-center gap-1.5 rounded-lg border border-default bg-background-muted p-3 text-center opacity-70 grayscale transition-colors"
          >
            {cardContent}
          </div>
        );
      })}
    </div>
  );
}
