'use client';

import { useTranslations } from 'next-intl';
import { BookOpen, Check } from 'lucide-react';

export interface ModuleCardData {
  id: string;
  title: string;
  lessons: Array<{ id: string; title: string }>;
}

export interface ModuleCardProgress {
  contentRead: boolean;
  quizPassed: boolean;
  bestScore: number;
}

interface ModuleCardProps {
  module: ModuleCardData;
  progress: ModuleCardProgress | null;
  onClick: (moduleId: string) => void;
  /** Optional 0-based index — when provided, displays a 1-indexed sequence number */
  index?: number;
  /** Show a vertical connector line above this card (for course detail timeline) */
  showConnector?: boolean;
}

export function ModuleCard({ module, progress, onClick, index, showConnector }: ModuleCardProps) {
  const t = useTranslations('academy');

  const lessonCount = module.lessons.length;
  const isRead = progress?.contentRead ?? false;
  const isPassed = progress?.quizPassed ?? false;

  const statusLabel = isPassed
    ? t('quiz_passed_label')
    : isRead
      ? t('content_read_label')
      : t('module_not_started');

  return (
    <div className="relative flex flex-col items-center">
      {showConnector && <div className="absolute -top-3 left-8 h-3 w-0.5 bg-border" />}
      <button
        type="button"
        onClick={() => onClick(module.id)}
        aria-label={t('module_card_aria', { name: module.title })}
        className="focus-ring flex w-full items-center gap-4 rounded-lg border border-border bg-background-elevated p-4 text-left transition-all hover:border-foreground-subtle hover:bg-background-muted"
      >
        <div className="flex shrink-0 items-center justify-center rounded-lg bg-background-muted p-2.5">
          {index !== undefined ? (
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-foreground">
              {index + 1}
            </span>
          ) : (
            <BookOpen className="h-4 w-4 text-foreground-muted" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <h4 className="truncate text-sm font-medium text-foreground">{module.title}</h4>
          <p className="text-xs text-foreground-muted">
            {t('lesson_count', { count: lessonCount })}
          </p>
          {isPassed && progress?.bestScore !== undefined && progress.bestScore > 0 && (
            <p className="text-xs text-foreground-subtle">
              {t('best_score', { score: progress.bestScore })}
            </p>
          )}
        </div>

        {/* Status icon circle */}
        <div className="shrink-0" aria-label={statusLabel}>
          {isPassed ? (
            <div
              className="flex h-6 w-6 items-center justify-center rounded-full bg-success"
              title={statusLabel}
            >
              <Check className="h-3.5 w-3.5 text-success-foreground" />
            </div>
          ) : isRead ? (
            <div className="h-6 w-6 rounded-full bg-accent" title={statusLabel} />
          ) : (
            <div
              className="h-6 w-6 rounded-full border-2 border-foreground-subtle/30"
              title={statusLabel}
            />
          )}
        </div>
      </button>
    </div>
  );
}
