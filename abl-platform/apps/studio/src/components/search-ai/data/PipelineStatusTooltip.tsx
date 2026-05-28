/**
 * PipelineStatusTooltip Component
 *
 * Wraps the existing status Badge with a hover popover showing the
 * document's position in the 5-step pipeline. Shows completed steps
 * with checkmarks, active step highlighted, and pending steps dimmed.
 * For failed documents, shows which step failed with a red marker.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { MiniPipelineIndicator } from './MiniPipelineIndicator';
import {
  STAGE_ORDER,
  STAGE_META,
  getStageFromStatus,
  getStageIndex,
  type PipelineStage,
} from '../../../lib/search-ai-pipeline-stages';

interface PipelineStatusTooltipProps {
  status: string;
  processingError?: string | null;
  onClick?: () => void | Promise<void>;
}

type StepState = 'done' | 'active' | 'pending' | 'failed';

function inferFailedStageIndex(processingError?: string | null): number {
  if (!processingError) return 1;
  const lower = processingError.toLowerCase();
  if (lower.startsWith('embedding failed') || lower.includes('no chunks found')) return 3;
  if (lower.startsWith('enrichment failed') || lower.startsWith('canonical mapping failed'))
    return 2;
  return 1;
}

function getStepStates(status: string, processingError?: string | null): StepState[] {
  const stage = getStageFromStatus(status);

  if (stage === 'searchable') {
    return STAGE_ORDER.map(() => 'done');
  }

  if (stage === 'failed') {
    const failIdx = inferFailedStageIndex(processingError);
    return STAGE_ORDER.map((_, i) => {
      if (i < failIdx) return 'done';
      if (i === failIdx) return 'failed';
      return 'pending';
    });
  }

  const activeIdx = getStageIndex(stage as PipelineStage);
  return STAGE_ORDER.map((_, i) => {
    if (i < activeIdx) return 'done';
    if (i === activeIdx) return 'active';
    return 'pending';
  });
}

const dotStyles: Record<StepState, string> = {
  done: 'bg-success text-white',
  active: 'bg-info text-white shadow-[0_0_0_3px_hsl(187_40%_15%)]',
  pending: 'bg-background-muted text-muted border border-dashed border-muted',
  failed: 'bg-error text-white',
};

const textStyles: Record<StepState, string> = {
  done: 'text-success',
  active: 'text-info font-semibold',
  pending: 'text-muted',
  failed: 'text-error',
};

const lineStyles: Record<StepState, string> = {
  done: 'bg-success',
  active: 'bg-gradient-status-active',
  pending: 'bg-background-muted',
  failed: 'bg-error',
};

export function PipelineStatusTooltip({
  status,
  processingError,
  onClick,
}: PipelineStatusTooltipProps) {
  const t = useTranslations('search_ai.progress');
  const [isOpen, setIsOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const stage = getStageFromStatus(status);
  const stepStates = getStepStates(status, processingError);
  const failIdx = inferFailedStageIndex(processingError);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleEnter = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 8, left: rect.left + rect.width / 2 });
    }
    setIsOpen(true);
  }, []);

  const handleLeave = useCallback(() => {
    timeoutRef.current = setTimeout(() => setIsOpen(false), 150);
  }, []);

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!onClick) return;
      event.preventDefault();
      event.stopPropagation();
      void onClick();
    },
    [onClick],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!onClick) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      void onClick();
    },
    [onClick],
  );

  return (
    <div
      ref={triggerRef}
      className={clsx(
        'inline-block rounded-sm',
        onClick &&
          'cursor-pointer transition-default hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
      )}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      onClick={onClick ? handleClick : undefined}
      onKeyDown={onClick ? handleKeyDown : undefined}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      <MiniPipelineIndicator status={status} processingError={processingError} />

      {isOpen &&
        pos &&
        createPortal(
          <div
            className="fixed w-[240px] p-4 rounded-xl bg-background-elevated border border-default shadow-lg z-[9999]"
            style={{ top: pos.top, left: pos.left, transform: 'translateX(-50%)' }}
            onMouseEnter={handleEnter}
            onMouseLeave={handleLeave}
          >
            {/* Title */}
            <p
              className={clsx(
                'text-xs font-semibold mb-3',
                stage === 'failed' ? 'text-error' : 'text-muted',
              )}
            >
              {stage === 'searchable'
                ? t('tooltip_complete')
                : stage === 'failed'
                  ? t('tooltip_failed', { step: failIdx + 1 })
                  : t('tooltip_progress', { step: getStageIndex(stage as PipelineStage) + 1 })}
            </p>

            {/* Steps */}
            <ul className="space-y-0">
              {STAGE_ORDER.map((stageKey, idx) => {
                const state = stepStates[idx];
                const meta = STAGE_META[stageKey];
                const isLast = idx === STAGE_ORDER.length - 1;

                return (
                  <li key={stageKey} className="relative flex items-start gap-2.5 pb-1">
                    {/* Connecting line */}
                    {!isLast && (
                      <div
                        className={clsx(
                          'absolute left-[9px] top-5 bottom-0 w-0.5',
                          lineStyles[state],
                        )}
                      />
                    )}

                    {/* Dot */}
                    <div
                      className={clsx(
                        'w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 z-[1]',
                        dotStyles[state],
                      )}
                    >
                      {state === 'done' ? (
                        <Check className="w-3 h-3" />
                      ) : state === 'failed' ? (
                        '!'
                      ) : (
                        idx + 1
                      )}
                    </div>

                    {/* Text */}
                    <div className="pt-0.5 pb-2">
                      <span className={clsx('text-xs', textStyles[state])}>{t(meta.labelKey)}</span>
                      {state === 'active' && (
                        <span className="block text-[11px] text-muted mt-0.5">
                          {t(meta.descriptionKey)}
                        </span>
                      )}
                      {state === 'failed' && (
                        <span className="block text-[11px] text-error mt-0.5">
                          {t('tooltip_processing_failed')}
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>

            {/* Footer */}
            <p
              className={clsx(
                'text-[11px] mt-2 pt-2.5 border-t border-default leading-relaxed',
                stage === 'failed' ? 'text-error' : 'text-muted',
              )}
            >
              {stage === 'searchable'
                ? t('tooltip_footer_complete')
                : stage === 'failed'
                  ? t('tooltip_footer_failed')
                  : t('tooltip_footer_active')}
            </p>
          </div>,
          document.body,
        )}
    </div>
  );
}
