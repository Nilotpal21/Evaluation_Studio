'use client';

import { useTranslations } from 'next-intl';
import { Check } from 'lucide-react';
import { clsx } from 'clsx';
import type { CrawlFlowState } from './types';

const STEPS: { key: CrawlFlowState; labelKey: string }[] = [
  { key: 'url-entry', labelKey: 'flow_step_url' },
  { key: 'analyzing', labelKey: 'flow_step_review' },
  { key: 'crawling', labelKey: 'flow_step_crawl' },
];

interface FlowStepperProps {
  currentStep: CrawlFlowState;
  onStepClick?: (step: CrawlFlowState) => void;
}

export function FlowStepper({ currentStep, onStepClick }: FlowStepperProps) {
  const t = useTranslations('search_ai.crawl_flow');
  // 'done' means all steps complete — treat as past the last step
  // 'configure' is off-stepper (accessed via Settings) — show Review as current
  const currentIdx =
    currentStep === 'done'
      ? STEPS.length
      : currentStep === 'configure'
        ? STEPS.findIndex((s) => s.key === 'analyzing')
        : currentStep === 'submitting'
          ? STEPS.findIndex((s) => s.key === 'crawling')
          : STEPS.findIndex((s) => s.key === currentStep);

  return (
    <nav className="flex items-center gap-1 text-xs" aria-label="Progress">
      {STEPS.map((step, idx) => {
        const isComplete = idx < currentIdx;
        const isCurrent = idx === currentIdx;
        const isFuture = idx > currentIdx;
        const isClickable = isComplete && onStepClick;

        return (
          <div key={step.key} className="flex items-center gap-1">
            {idx > 0 && (
              <div
                className={clsx(
                  'w-6 h-px',
                  isComplete || isCurrent ? 'bg-accent' : 'bg-border-default',
                )}
              />
            )}
            <button
              onClick={isClickable ? () => onStepClick(step.key) : undefined}
              disabled={!isClickable}
              className={clsx(
                'flex items-center gap-1.5 px-2 py-1 rounded-md transition-default',
                isComplete && 'text-accent hover:bg-accent/10 cursor-pointer',
                isCurrent && 'text-foreground font-semibold bg-accent/10',
                isFuture && 'text-muted cursor-default',
              )}
            >
              {isComplete ? (
                <Check className="w-3 h-3 text-accent" />
              ) : (
                <span
                  className={clsx(
                    'w-4 h-4 rounded-full text-[10px] font-medium flex items-center justify-center',
                    isCurrent
                      ? 'bg-accent text-accent-foreground'
                      : 'bg-background-muted text-muted',
                  )}
                >
                  {idx + 1}
                </span>
              )}
              <span>{t(step.labelKey)}</span>
            </button>
          </div>
        );
      })}
    </nav>
  );
}
