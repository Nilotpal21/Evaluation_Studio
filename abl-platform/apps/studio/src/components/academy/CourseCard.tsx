'use client';

import { useTranslations } from 'next-intl';
import { motion } from 'framer-motion';
import { LevelBadge } from './LevelBadge';
import { ProgressBar } from './ProgressBar';

export interface CourseCardData {
  id: string;
  title: string;
  description: string;
  modules: string[];
}

export interface CourseModuleProgress {
  contentRead: boolean;
  quizPassed: boolean;
}

interface CourseCardProps {
  course: CourseCardData;
  /** Map of moduleId -> progress, or null if no progress loaded yet */
  progress: Map<string, CourseModuleProgress> | null;
  onClick: (courseId: string) => void;
  level?: string;
  estimatedMinutes?: number;
  isFastTrack?: boolean;
}

function formatTime(minutes: number): string {
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  if (remaining === 0) {
    return `${hours}h`;
  }
  return `${hours}h ${remaining}m`;
}

export function CourseCard({
  course,
  progress,
  onClick,
  level,
  estimatedMinutes,
  isFastTrack,
}: CourseCardProps) {
  const t = useTranslations('academy');

  const totalModules = course.modules.length;
  let passedModules = 0;
  let readOnlyModules = 0;

  if (progress) {
    for (const modId of course.modules) {
      const mp = progress.get(modId);
      if (mp?.quizPassed) {
        passedModules++;
      } else if (mp?.contentRead) {
        readOnlyModules++;
      }
    }
  }

  // Combined progress: passed=100%, read-only=50%, not started=0%
  const progressPercent =
    totalModules > 0 ? Math.round((passedModules * 100 + readOnlyModules * 50) / totalModules) : 0;

  return (
    <motion.button
      type="button"
      onClick={() => onClick(course.id)}
      aria-label={t('course_card_aria', { name: course.title })}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 200, damping: 20 }}
      className="focus-ring flex w-full flex-col gap-2 rounded-xl border border-border bg-background-elevated p-4 text-left transition-all hover:-translate-y-0.5 hover:border-foreground-subtle hover:bg-background-muted hover:shadow-lg"
    >
      {/* Header: title + level badge */}
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">{course.title}</h3>
        <div className="flex shrink-0 items-center gap-1.5">
          {level && <LevelBadge level={level} />}
          {isFastTrack && (
            <span className="inline-flex items-center rounded-full bg-accent-subtle px-2 py-0.5 text-xs font-medium text-accent">
              {t('fast_track')}
            </span>
          )}
        </div>
      </div>

      <p className="line-clamp-2 text-xs leading-relaxed text-foreground-subtle">
        {course.description}
      </p>

      {/* Meta info row */}
      <div className="flex items-center gap-2 text-xs text-foreground-muted">
        <span>{t('module_count', { count: totalModules })}</span>
        {estimatedMinutes !== undefined && (
          <>
            <span className="text-foreground-subtle">&middot;</span>
            <span>{formatTime(estimatedMinutes)}</span>
          </>
        )}
        {progress && (
          <>
            <span className="text-foreground-subtle">&middot;</span>
            <span>
              {t('modules_passed', {
                passed: passedModules,
                total: totalModules,
              })}
            </span>
          </>
        )}
      </div>

      {/* Progress bar with completion info */}
      {progress && (
        <div className="flex flex-col gap-1">
          <ProgressBar value={progressPercent} label={`${progressPercent}%`} />
          <p className="text-xs text-foreground-muted">
            {passedModules}/{totalModules} {t('complete_label')} &middot; {progressPercent}%
          </p>
        </div>
      )}
    </motion.button>
  );
}
