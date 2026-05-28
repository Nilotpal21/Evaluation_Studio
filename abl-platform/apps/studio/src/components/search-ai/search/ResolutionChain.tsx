/**
 * ResolutionChain Component
 *
 * Horizontal pipeline visualization showing 6 query resolution stages
 * as connected steps with duration and status indicators.
 */

import { useTranslations } from 'next-intl';
import { clsx } from 'clsx';
import { STAGE_KEYS, STAGE_I18N_MAP, type StageKey, type PipelineDebugTrace } from './debug-types';

interface ResolutionChainProps {
  debugTrace: PipelineDebugTrace;
  activeStage?: string | null;
  onStageClick?: (stageName: string) => void;
}

export function ResolutionChain({ debugTrace, activeStage, onStageClick }: ResolutionChainProps) {
  const t = useTranslations('search_ai.debug');

  return (
    <div className="space-y-3">
      {/* Stage chain */}
      <div className="flex items-center gap-0 overflow-x-auto pb-2">
        {STAGE_KEYS.map((key, idx) => {
          const stage = debugTrace.stages[key];
          if (!stage) return null;
          const isActive = activeStage === key;
          const stageName = t(STAGE_I18N_MAP[key]);

          return (
            <div key={key} className="flex items-center shrink-0">
              {/* Connector line */}
              {idx > 0 && (
                <div
                  className={clsx('w-6 h-0.5', stage.applied ? 'bg-success' : 'bg-border-default')}
                />
              )}

              {/* Stage node */}
              <button
                type="button"
                onClick={() => onStageClick?.(key)}
                aria-pressed={isActive}
                aria-label={stageName}
                className={clsx(
                  'flex flex-col items-center gap-1 px-3 py-2 rounded-lg border transition-colors min-w-[120px]',
                  isActive
                    ? 'border-accent bg-accent-subtle'
                    : 'border-default bg-background hover:bg-background-muted',
                )}
              >
                {/* Status dot + name */}
                <div className="flex items-center gap-1.5">
                  <span
                    className={clsx(
                      'w-2 h-2 rounded-full shrink-0',
                      stage.applied ? 'bg-success' : 'bg-muted',
                    )}
                  />
                  <span className="text-xs font-medium text-foreground whitespace-nowrap">
                    {t(STAGE_I18N_MAP[key])}
                  </span>
                </div>

                {/* Duration */}
                <span className="text-[10px] font-mono text-muted">
                  {t('duration_ms', { ms: stage.durationMs })}
                </span>

                {/* Applied/Skipped badge */}
                <span
                  className={clsx(
                    'text-[10px] px-1.5 py-0.5 rounded-full',
                    stage.applied
                      ? 'bg-success-subtle text-success'
                      : 'bg-background-muted text-muted',
                  )}
                >
                  {stage.applied ? t('applied') : t('skipped')}
                </span>
              </button>
            </div>
          );
        })}
      </div>

      {/* Total duration */}
      <div className="text-xs font-mono text-muted text-right">
        {t('total_duration', { ms: debugTrace.totalDurationMs })}
      </div>
    </div>
  );
}
