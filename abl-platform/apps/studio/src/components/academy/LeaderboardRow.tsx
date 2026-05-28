'use client';

import { useTranslations } from 'next-intl';
import { motion } from 'framer-motion';
import type { LeaderboardEntry } from './LeaderboardPodium';
import { avatarColor } from './leaderboard-utils';

interface LeaderboardRowProps {
  entry: LeaderboardEntry;
  rank: number;
  isCurrentUser: boolean;
}

export function LeaderboardRow({ entry, rank, isCurrentUser }: LeaderboardRowProps) {
  const t = useTranslations('academy');

  const initial = (entry.displayName ?? entry.userId).charAt(0).toUpperCase();
  const bgColor = avatarColor(entry.userId);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        delay: (rank - 4) * 0.05,
        type: 'spring',
        stiffness: 200,
        damping: 20,
      }}
      className={`flex items-center gap-3 rounded-lg border px-4 py-3 hover-lift transition-default ${
        isCurrentUser ? 'border-accent bg-accent-subtle' : 'border-border bg-background-elevated'
      }`}
    >
      {/* Rank number */}
      <span className="w-8 text-center font-mono text-sm font-medium text-foreground-muted">
        {rank}
      </span>

      {/* Avatar */}
      <div
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white ${bgColor}`}
      >
        {initial}
      </div>

      {/* Name */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="truncate text-sm font-medium text-foreground">
          {entry.displayName ?? entry.userId}
        </span>
        {isCurrentUser && (
          <span className="shrink-0 text-xs font-medium text-accent">{t('leaderboard_you')}</span>
        )}
      </div>

      {/* Points */}
      <span className="shrink-0 tabular-nums text-sm font-semibold text-foreground">
        {entry.points}
      </span>

      {/* Badge count */}
      <span className="shrink-0 tabular-nums text-xs text-foreground-muted">
        {entry.badges.length} {t('leaderboard_badges')}
      </span>
    </motion.div>
  );
}
