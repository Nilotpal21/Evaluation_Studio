'use client';

import React, { useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArchDiffEditor, type ArchDiffEditorHandle } from './ArchDiffEditor';
import { MutationUndoAction } from './MutationUndoAction';
import { computeChangedSections } from '@/lib/arch-ai/compute-changed-sections';
import type {
  ModificationProposal,
  ProposedChange,
  ProposalReviewStatus,
  ProposalValidation,
} from '@/lib/arch-ai/types/arch';

// =============================================================================
// IN-PROJECT DIFF CARD — Read-only with status bar
// Confirmation flows through ask_user Confirmation widget in chat, not buttons.
// =============================================================================

interface InProjectDiffCardProps {
  changes: ProposedChange[];
  status: ProposalReviewStatus;
  validation?: ProposalValidation;
  projectId?: string;
  proposal?: ModificationProposal;
}

export type { InProjectDiffCardProps };

/** Status bar label + color for each review state. */
const STATUS_DISPLAY: Record<ProposalReviewStatus, { label: string; className: string }> = {
  pending: {
    label: 'Pending review',
    className: 'text-foreground-muted',
  },
  applying: {
    label: 'Applying...',
    className: 'text-accent animate-pulse',
  },
  applied: {
    label: 'Applied',
    className: 'text-success font-medium',
  },
  rejected: {
    label: 'Rejected',
    className: 'text-error font-medium',
  },
  blocked: {
    label: 'Blocked — compiler errors',
    className: 'text-error font-medium',
  },
};

export function InProjectDiffCard({
  changes,
  status,
  validation,
  projectId,
  proposal,
}: InProjectDiffCardProps) {
  const t = useTranslations('arch_in_project');
  const [renderSideBySide, setRenderSideBySide] = useState(true);
  const diffRef = useRef<ArchDiffEditorHandle>(null);

  // The current data model stores a single 'FULL' change containing the
  // entire before/after; per-section chips are computed client-side.
  const fullChange = changes.find((c) => c.construct === 'FULL') ?? changes[0];
  const before = fullChange?.before ?? '';
  const after = fullChange?.after ?? '';
  const rationale = fullChange?.rationale ?? '';

  const changedSections = useMemo(() => computeChangedSections(before, after), [before, after]);

  // Error markers: only line-anchored, non-dependent errors become gutter markers.
  // Everything else renders in the banner (blocked state).
  const errorMarkers = useMemo(() => {
    if (!validation || status !== 'blocked') return undefined;
    return validation.errors
      .filter((e) => typeof e.line === 'number' && !e.agent)
      .map((e) => ({
        line: e.line as number,
        message: e.message,
        severity: e.severity,
      }));
  }, [validation, status]);

  const handleJump = (afterStartLine: number) => {
    if (afterStartLine > 0) diffRef.current?.jumpToLine(afterStartLine);
  };

  if (changes.length === 0 && status !== 'blocked') {
    return <div className="p-4 text-center text-sm text-foreground-muted">{t('no_changes')}</div>;
  }

  const statusDisplay = STATUS_DISPLAY[status] ?? STATUS_DISPLAY.pending;

  return (
    <div data-widget="DiffCard" className="flex h-full flex-col gap-3">
      {/* Top bar: view-mode toggle */}
      <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-3 pb-2">
        <span className="text-xs font-mono text-foreground-muted">
          {fullChange?.construct ?? ''}
        </span>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => setRenderSideBySide(true)}
            className={`rounded px-2 py-0.5 text-xs transition-colors ${
              renderSideBySide
                ? 'bg-accent text-accent-foreground'
                : 'text-foreground-muted hover:text-foreground'
            }`}
          >
            {t('view_side_by_side')}
          </button>
          <button
            type="button"
            onClick={() => setRenderSideBySide(false)}
            className={`rounded px-2 py-0.5 text-xs transition-colors ${
              !renderSideBySide
                ? 'bg-accent text-accent-foreground'
                : 'text-foreground-muted hover:text-foreground'
            }`}
          >
            {t('view_inline')}
          </button>
        </div>
      </div>

      {/* Section chip bar */}
      {changedSections.length > 0 && (
        <div className="flex flex-shrink-0 flex-wrap items-center gap-1.5 px-3">
          {changedSections.map((s) => (
            <button
              key={s.name}
              type="button"
              onClick={() => handleJump(s.afterStartLine)}
              className="rounded bg-surface-hover px-2 py-0.5 text-[10px] font-semibold uppercase text-accent hover:bg-accent/10 hover:text-accent-foreground"
            >
              {s.name} ↓
            </button>
          ))}
          <span className="ml-2 text-[10px] text-foreground-muted">
            {changedSections.length}{' '}
            {changedSections.length === 1 ? t('section_changed') : t('sections_changed')}
          </span>
        </div>
      )}

      {/* Blocked error banner — lists ALL errors including dependent-agent and line-less ones */}
      {status === 'blocked' && validation && validation.errors.length > 0 && (
        <div
          role="alert"
          className="mx-3 flex-shrink-0 rounded border border-error/30 bg-error/5 p-3 text-xs"
        >
          <div className="mb-1.5 flex items-center gap-2 font-semibold text-error">
            <span aria-hidden="true">⚠</span>
            <span>
              {t('validation_failed_after_retries', { count: validation.repairAttempts })}
            </span>
          </div>
          <ul className="ml-4 list-disc space-y-0.5 text-error/90">
            {validation.errors.map((e, i) => (
              <li key={i}>
                {e.agent ? <strong>[{e.agent}] </strong> : null}
                {typeof e.line === 'number' && !e.agent ? <span>Line {e.line}: </span> : null}
                {e.message}
              </li>
            ))}
          </ul>
          {validation.hint && <p className="mt-2 text-[11px] text-error/70">{validation.hint}</p>}
        </div>
      )}

      {/* Monaco diff */}
      <div className="flex-1 min-h-0">
        <ArchDiffEditor
          ref={diffRef}
          original={before}
          modified={after}
          fileName="agent"
          renderSideBySide={renderSideBySide}
          errorMarkers={errorMarkers}
        />
      </div>

      {/* Rationale */}
      {rationale && (
        <div className="mx-3 flex flex-shrink-0 items-start gap-2 rounded bg-info/5 p-2 text-xs text-info">
          <span>💡</span>
          <span>{rationale}</span>
        </div>
      )}

      {/* Read-only status bar */}
      <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border px-3 pt-3">
        <span className={`text-xs ${statusDisplay.className}`}>{statusDisplay.label}</span>
        {status === 'applied' && proposal && (
          <MutationUndoAction projectId={projectId} proposal={proposal} />
        )}
      </div>
    </div>
  );
}
