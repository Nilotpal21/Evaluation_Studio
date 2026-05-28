'use client';

import { clsx } from 'clsx';
import { CornerDownLeft, FileStack, History } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ArchSession } from '@/lib/arch-ai/ui/types';
import type { ResumeSnapshot } from '@agent-platform/arch-ai/types';
import {
  formatRelativeTime,
  getResumeNextActionTone,
  getSessionMessageCount,
} from './session-resume';

const PHASE_BADGE_CLASSES: Record<string, string> = {
  INTERVIEW: 'border-warning/30 bg-warning-subtle text-warning',
  BLUEPRINT: 'border-info/30 bg-info-subtle text-info',
  BUILD: 'border-success/30 bg-success-subtle text-success',
  CREATE: 'border-purple/30 bg-purple-subtle text-purple',
};

interface InProjectSessionResumeCardProps {
  session: ArchSession;
  resume: ResumeSnapshot | null;
  onResume: () => void;
  onStartNew: () => void;
  disabled?: boolean;
  error?: string | null;
}

export function InProjectSessionResumeCard({
  session,
  resume,
  onResume,
  onStartNew,
  disabled = false,
  error,
}: InProjectSessionResumeCardProps) {
  const t = useTranslations('arch_in_project');
  const mode = session.metadata.mode as string | undefined;
  const rawPhase = session.metadata.phase as string | undefined;
  const phase = mode === 'IN_PROJECT' ? undefined : rawPhase;
  const projectName = (session.metadata.specification as Record<string, unknown> | undefined)
    ?.projectName as string | undefined;
  const badgeClass = phase ? PHASE_BADGE_CLASSES[phase] : '';
  const messageCount = getSessionMessageCount(session);
  const fileCount = resume?.artifacts.files.count ?? 0;
  const timeAgo = formatRelativeTime(session.updatedAt);
  const nextActionTone = getResumeNextActionTone(resume);

  const nextActionLabel = (() => {
    switch (nextActionTone) {
      case 'waiting_review':
        return t('resume_card_waiting_review');
      case 'waiting_file':
        return t('resume_card_waiting_file');
      case 'waiting_secret':
        return t('resume_card_waiting_secret');
      case 'continue_phase':
        return t('resume_card_continue_phase');
      case 'continue_conversation':
        return t('resume_card_continue_conversation');
      case 'continue_create':
        return t('resume_card_continue_create');
      case 'resume_available':
        return t('resume_card_ready');
      case 'waiting_response':
      default:
        return t('resume_card_waiting_response');
    }
  })();

  return (
    <div className="rounded-2xl border border-border bg-background-subtle px-5 py-4 shadow-sm">
      <div className="mb-3 flex items-center gap-1.5">
        <CornerDownLeft className="h-3.5 w-3.5 text-foreground/50" />
        <span className="font-mono text-[10px] uppercase tracking-widest text-foreground/60">
          {t('resume_card_label')}
        </span>
      </div>

      <div className="flex items-center justify-between gap-3">
        <span className="truncate text-sm font-semibold text-foreground">
          {projectName || t('resume_card_untitled_project')}
        </span>
        {phase ? (
          <span
            className={clsx(
              'shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide',
              badgeClass,
            )}
          >
            {phase}
          </span>
        ) : null}
      </div>

      <p className="mt-1 text-sm text-foreground/70">{nextActionLabel}</p>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-foreground/60">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-foreground/[0.04] px-2.5 py-1">
          <History className="h-3 w-3" />
          {t('resume_card_messages', { count: messageCount })}
        </span>
        {fileCount > 0 ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-foreground/[0.04] px-2.5 py-1">
            <FileStack className="h-3 w-3" />
            {t('resume_card_files', { count: fileCount })}
          </span>
        ) : null}
        <span>{t('resume_card_last_active', { timeAgo })}</span>
      </div>

      <p className="mt-3 text-xs leading-relaxed text-foreground/55">{t('resume_card_note')}</p>

      {error ? (
        <div className="mt-3 rounded-md border border-error/30 bg-error/5 px-3 py-2 text-xs text-error">
          {error}
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          onClick={onResume}
          disabled={disabled}
          className={clsx(
            'rounded-lg px-4 py-2 text-sm font-medium transition-opacity',
            'bg-accent text-accent-foreground',
            disabled ? 'cursor-not-allowed opacity-50' : 'hover:opacity-90',
          )}
        >
          {t('resume_card_resume')}
        </button>
        <button
          onClick={onStartNew}
          disabled={disabled}
          className={clsx(
            'rounded-lg border px-4 py-2 text-sm font-medium transition-colors',
            'border-border text-foreground/70',
            disabled
              ? 'cursor-not-allowed opacity-50'
              : 'hover:bg-background hover:text-foreground',
          )}
        >
          {t('resume_card_start_new')}
        </button>
      </div>
    </div>
  );
}
