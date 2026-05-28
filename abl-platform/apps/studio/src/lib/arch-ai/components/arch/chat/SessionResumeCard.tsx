'use client';

/**
 * SessionResumeCard — inline session resume prompt shown in the Arch entry state.
 * Replaces the full-screen ResumeDialog modal gate.
 */

import { clsx } from 'clsx';
import { CornerDownLeft } from 'lucide-react';
import type { ArchSession } from '@agent-platform/arch-ai';

const PHASE_BADGE_CLASSES: Record<string, string> = {
  INTERVIEW: 'border-warning/30 bg-warning-subtle text-warning',
  BLUEPRINT: 'border-info/30 bg-info-subtle text-info',
  BUILD: 'border-success/30 bg-success-subtle text-success',
  CREATE: 'border-purple/30 bg-purple-subtle text-purple',
};

interface SessionResumeCardProps {
  session: ArchSession;
  onContinue: () => void;
  onDismiss: () => void;
  error?: string | null;
}

function formatTimeAgo(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function SessionResumeCard({
  session,
  onContinue,
  onDismiss,
  error,
}: SessionResumeCardProps) {
  const phase = session.metadata.phase as string | undefined;
  const projectName = (session.metadata.specification as Record<string, unknown> | undefined)
    ?.projectName as string | undefined;
  const messageCount = (session.metadata.messages as unknown[])?.length ?? 0;
  const timeAgo = formatTimeAgo(session.updatedAt);
  const badgeClass = phase ? PHASE_BADGE_CLASSES[phase] : '';

  return (
    <div className="rounded-xl border border-border bg-background-subtle px-5 py-4 shadow-sm">
      {/* Label */}
      <div className="mb-3 flex items-center gap-1.5">
        <CornerDownLeft className="h-3 w-3 text-foreground/50" />
        <span className="font-mono text-[10px] uppercase tracking-widest text-foreground/60">
          In progress
        </span>
      </div>

      {/* Project row */}
      <div className="flex items-center justify-between gap-3">
        <span className="truncate text-sm font-semibold text-foreground">
          {projectName || 'Untitled project'}
        </span>
        {phase && (
          <span
            className={clsx(
              'shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide',
              badgeClass,
            )}
          >
            {phase}
          </span>
        )}
      </div>

      {/* Meta */}
      <p className="mt-1 text-xs text-foreground/60">
        {messageCount} {messageCount === 1 ? 'message' : 'messages'} · Last active {timeAgo}
      </p>

      {/* Error */}
      {error && (
        <div className="mt-3 rounded-md border border-error/30 bg-error/5 px-3 py-2 text-xs text-error">
          {error}
        </div>
      )}

      {/* Actions */}
      <div className="mt-4 flex gap-2">
        <button
          onClick={onContinue}
          className="rounded-lg bg-accent px-5 py-2 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90"
        >
          Continue
        </button>
        <button
          onClick={onDismiss}
          className="rounded-lg border border-border px-5 py-2 text-sm font-medium text-foreground/60 transition-colors hover:bg-background hover:text-foreground"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
