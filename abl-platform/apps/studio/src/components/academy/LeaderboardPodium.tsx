'use client';

import { useTranslations } from 'next-intl';
import { motion } from 'framer-motion';
import { avatarColor } from './leaderboard-utils';

export interface LeaderboardEntry {
  userId: string;
  displayName: string | null;
  points: number;
  badges: string[];
  selectedPersona: string | null;
}

interface LeaderboardPodiumProps {
  entries: LeaderboardEntry[];
}

const MEDALS = ['\u{1F947}', '\u{1F948}', '\u{1F949}'] as const;

/**
 * Podium display order: #2 (left), #1 (center, taller), #3 (right).
 * If fewer than 3 entries, only the available ones are shown.
 */
function podiumOrder(entries: LeaderboardEntry[]): { entry: LeaderboardEntry; rank: number }[] {
  const ordered: { entry: LeaderboardEntry; rank: number }[] = [];
  if (entries.length >= 2) ordered.push({ entry: entries[1], rank: 2 });
  if (entries.length >= 1) ordered.push({ entry: entries[0], rank: 1 });
  if (entries.length >= 3) ordered.push({ entry: entries[2], rank: 3 });
  return ordered;
}

export function LeaderboardPodium({ entries }: LeaderboardPodiumProps) {
  const t = useTranslations('academy');

  if (entries.length === 0) return null;

  const items = podiumOrder(entries);

  return (
    <div className="mb-8">
      <h3 className="mb-4 text-sm font-semibold text-foreground">{t('leaderboard_top3_title')}</h3>
      <div className="flex items-end justify-center gap-3">
        {items.map(({ entry, rank }, index) => {
          const isFirst = rank === 1;
          const initial = (entry.displayName ?? entry.userId).charAt(0).toUpperCase();
          const bgColor = avatarColor(entry.userId);

          return (
            <motion.div
              key={entry.userId}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                delay: index * 0.1,
                type: 'spring',
                stiffness: 200,
                damping: 20,
              }}
              className={`flex w-full max-w-[180px] flex-col items-center gap-2 rounded-xl p-4 ${
                isFirst
                  ? 'bg-gradient-brand-subtle pb-6 pt-5'
                  : 'border border-border bg-background-elevated'
              }`}
            >
              {/* Medal */}
              <span
                className="text-2xl"
                role="img"
                aria-label={t(`leaderboard_rank_medal_${rank}`)}
              >
                {MEDALS[rank - 1]}
              </span>

              {/* Avatar circle */}
              <div
                className={`flex items-center justify-center rounded-full text-sm font-bold text-white ${bgColor} ${
                  isFirst ? 'h-12 w-12' : 'h-10 w-10'
                }`}
              >
                {initial}
              </div>

              {/* Display name */}
              <p
                className={`w-full truncate text-center font-medium text-foreground ${
                  isFirst ? 'text-sm' : 'text-xs'
                }`}
              >
                {entry.displayName ?? entry.userId}
              </p>

              {/* Points */}
              <p className="tabular-nums text-xs font-semibold text-accent">
                {entry.points} {t('leaderboard_points')}
              </p>

              {/* Badge count */}
              <p className="text-[10px] text-foreground-muted">
                {entry.badges.length} {t('leaderboard_badges')}
              </p>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
