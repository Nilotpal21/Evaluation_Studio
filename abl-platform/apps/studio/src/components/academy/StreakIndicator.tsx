'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Flame } from 'lucide-react';

interface StreakIndicatorProps {
  /** Array of date strings (YYYY-MM-DD) representing streak days */
  streakDays: string[];
  /** Last active date string or null */
  lastActiveDate: string | null;
}

/**
 * Builds an array of the last 7 calendar dates (today + 6 days back) as YYYY-MM-DD strings.
 */
function getLast7Days(): string[] {
  const days: string[] = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

/**
 * Shows the user's current streak length with a flame icon.
 * Highlights when the user is active today.
 * Includes a 7-day visual history bar.
 */
export function StreakIndicator({ streakDays, lastActiveDate }: StreakIndicatorProps) {
  const t = useTranslations('academy');

  const today = new Date().toISOString().slice(0, 10);
  const isActiveToday = lastActiveDate === today;
  const streakLength = streakDays.length;

  const last7Days = useMemo(() => getLast7Days(), []);
  const streakSet = useMemo(() => new Set(streakDays), [streakDays]);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-default bg-background-muted px-4 py-3">
      <div className="flex items-center gap-3">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
            isActiveToday ? 'bg-accent-subtle' : 'bg-background-muted'
          }`}
        >
          <Flame className={`h-5 w-5 ${isActiveToday ? 'text-accent' : 'text-muted'}`} />
        </div>
        <div className="flex flex-col">
          <span className="text-xs font-medium uppercase text-muted">{t('streak_label')}</span>
          <span className="text-sm font-semibold text-foreground">
            {t('streak_days', { count: streakLength })}
          </span>
          <span className={`text-xs ${isActiveToday ? 'text-accent' : 'text-muted'}`}>
            {isActiveToday ? t('streak_active_today') : t('streak_inactive')}
          </span>
        </div>
      </div>

      {/* 7-day visual history */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-foreground-subtle">{t('streak_history')}</span>
        <div className="flex items-center gap-1.5">
          {last7Days.map((day) => (
            <div
              key={day}
              className={`h-2.5 w-2.5 rounded-full ${
                streakSet.has(day) ? 'bg-accent' : 'border border-border bg-background-elevated'
              }`}
              title={day}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
