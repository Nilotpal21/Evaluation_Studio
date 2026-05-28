/**
 * MiniPipelineIndicator Component
 *
 * Compact 5-dot pipeline indicator for document table rows.
 * Shows pipeline progress inline: filled dots for completed stages,
 * pulsing dot for active stage, dashed dots for pending, red for failed.
 */

import { clsx } from 'clsx';
import {
  STAGE_ORDER,
  getStageFromStatus,
  getStageIndex,
  type PipelineStage,
} from '../../../lib/search-ai-pipeline-stages';

interface MiniPipelineIndicatorProps {
  status: string;
  processingError?: string | null;
}

type DotState = 'done' | 'active' | 'pending' | 'failed';

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatStatusLabel(status: string): string {
  return status
    .split('_')
    .filter(Boolean)
    .map((part) => capitalize(part))
    .join(' ');
}

function inferFailedStageIndex(processingError?: string | null): number {
  if (!processingError) return 1;
  const lower = processingError.toLowerCase();
  if (lower.startsWith('embedding failed') || lower.includes('no chunks found')) return 3;
  if (lower.startsWith('enrichment failed') || lower.startsWith('canonical mapping failed'))
    return 2;
  return 1;
}

function getDotStates(
  status: string,
  processingError?: string | null,
): { dots: DotState[]; label: string; labelState: DotState } {
  const stage = getStageFromStatus(status);
  const label = formatStatusLabel(status);

  if (stage === 'failed') {
    const rawIdx = inferFailedStageIndex(processingError);
    const dots: DotState[] = STAGE_ORDER.map((_, i) => {
      if (i < rawIdx) return 'done';
      if (i === rawIdx) return 'failed';
      return 'pending';
    });
    return { dots, label, labelState: 'failed' };
  }

  if (stage === 'searchable') {
    return {
      dots: STAGE_ORDER.map(() => 'done' as DotState),
      label,
      labelState: 'done',
    };
  }

  const activeIdx = getStageIndex(stage as PipelineStage);
  const dots: DotState[] = STAGE_ORDER.map((_, i) => {
    if (i < activeIdx) return 'done';
    if (i === activeIdx) return 'active';
    return 'pending';
  });

  const labelState =
    stage === 'uploaded' || status === 'pending_field_selection' ? 'pending' : 'active';

  return { dots, label, labelState };
}

const dotClass: Record<DotState, string> = {
  done: 'bg-success',
  active: 'bg-info animate-pulse',
  pending: 'bg-background-muted border border-dashed border-muted',
  failed: 'bg-error',
};

const lineClass: Record<DotState, string> = {
  done: 'bg-success',
  active: 'bg-gradient-status-progress',
  pending: 'bg-background-muted',
  failed: 'bg-error',
};

const labelClass: Record<DotState, string> = {
  done: 'text-success',
  active: 'text-info',
  pending: 'text-muted',
  failed: 'text-error',
};

export function MiniPipelineIndicator({ status, processingError }: MiniPipelineIndicatorProps) {
  const { dots, label, labelState } = getDotStates(status, processingError);

  return (
    <div className="flex items-center gap-0">
      {dots.map((state, i) => (
        <div key={i} className="flex items-center">
          <div className={clsx('w-2.5 h-2.5 rounded-full shrink-0', dotClass[state])} aria-hidden />
          {i < dots.length - 1 && (
            <div
              className={clsx(
                'w-2 h-0.5 shrink-0',
                lineClass[
                  state === 'done' && dots[i + 1] !== 'pending'
                    ? 'done'
                    : state === 'done' && dots[i + 1] === 'active'
                      ? 'active'
                      : state === 'done'
                        ? 'done'
                        : state
                ],
              )}
              aria-hidden
            />
          )}
        </div>
      ))}
      <span className={clsx('ml-2 text-xs font-medium whitespace-nowrap', labelClass[labelState])}>
        {label}
      </span>
    </div>
  );
}
