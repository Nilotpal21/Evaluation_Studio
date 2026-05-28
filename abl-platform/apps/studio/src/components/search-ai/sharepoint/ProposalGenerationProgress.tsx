'use client';

/**
 * ProposalGenerationProgress
 *
 * Animated 9-step checklist showing real-time generation progress.
 * Each step displays a status icon and status text.
 */

import { useTranslations } from 'next-intl';
import { Loader2, Check, Clock, X, Circle } from 'lucide-react';

interface ProposalGenerationProgressProps {
  steps: Array<{
    id: string;
    label: string;
    status: 'pending' | 'in_progress' | 'done' | 'waiting' | 'failed';
    statusText: string;
  }>;
}

function StepIcon({ status }: { status: ProposalGenerationProgressProps['steps'][0]['status'] }) {
  switch (status) {
    case 'in_progress':
      return <Loader2 className="w-4 h-4 text-accent animate-spin flex-shrink-0" />;
    case 'done':
      return <Check className="w-4 h-4 text-success flex-shrink-0" />;
    case 'waiting':
      return <Clock className="w-4 h-4 text-muted flex-shrink-0" />;
    case 'failed':
      return <X className="w-4 h-4 text-error flex-shrink-0" />;
    case 'pending':
    default:
      return <Circle className="w-4 h-4 text-subtle flex-shrink-0" />;
  }
}

/** IDs of sections removed from the proposal UI — hide them from generation progress too.
 * Scope and Filters moved to the Scope+Filters tab. */
const HIDDEN_STEP_IDS = new Set([
  'sample-preview',
  'security-gate',
  'sample_preview',
  'security_gate',
  'scope',
  'filters',
]);

export function ProposalGenerationProgress({ steps }: ProposalGenerationProgressProps) {
  const t = useTranslations('search_ai.sharepoint.proposal');

  const visibleSteps = steps.filter((s) => !HIDDEN_STEP_IDS.has(s.id));

  return (
    <div className="p-6 space-y-6">
      <div className="text-center space-y-2">
        <Loader2 className="w-8 h-8 text-accent animate-spin mx-auto" />
        <h3 className="text-base font-semibold text-foreground">{t('generating_title')}</h3>
        <p className="text-sm text-muted">{t('generating_description')}</p>
      </div>

      <div className="space-y-2">
        {visibleSteps.map((step) => (
          <div
            key={step.id}
            className="flex items-center gap-3 px-3 py-2 rounded-lg bg-background-subtle"
          >
            <StepIcon status={step.status} />
            <span className="text-sm font-medium text-foreground flex-1">{step.label}</span>
            {step.statusText && <span className="text-xs text-muted">{step.statusText}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
