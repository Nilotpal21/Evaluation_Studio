/**
 * DraftBanner Component
 *
 * Info banner for draft connectors showing progress steps and a CTA
 * to navigate to the next incomplete setup step.
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Info, ChevronRight } from 'lucide-react';
import { Button } from '../../ui/Button';

interface DraftBannerProps {
  connectorId: string;
  currentStep:
    | 'auth'
    | 'scope'
    | 'scope-filters'
    | 'filters'
    | 'field-mapping'
    | 'preview'
    | 'ready';
  onNavigateToStep: (step: string) => void;
}

const STEPS = ['auth', 'scope-filters', 'field-mapping', 'preview', 'ready'] as const;

const STEP_TAB_MAP: Record<string, string> = {
  auth: 'connect',
  'scope-filters': 'scope-filters',
  'field-mapping': 'field-mapping',
  preview: 'preview',
  ready: 'overview',
};

export function DraftBanner({ connectorId, currentStep, onNavigateToStep }: DraftBannerProps) {
  const t = useTranslations('search_ai.sharepoint.draft');

  // Map legacy step names to the new merged steps
  const normalizedStep =
    currentStep === 'scope' || currentStep === 'filters' ? 'scope-filters' : currentStep;
  const currentStepIndex = STEPS.indexOf(normalizedStep as (typeof STEPS)[number]);

  const STEP_LABEL_KEYS: Record<string, string> = {
    auth: 'step_auth',
    'scope-filters': 'step_scope_filters',
    'field-mapping': 'step_field_mapping',
    preview: 'step_preview',
    ready: 'step_ready',
  };

  const steps = useMemo(
    () =>
      STEPS.map((step, i) => ({
        id: step,
        label: t(STEP_LABEL_KEYS[step]),
        completed: i < currentStepIndex,
        current: i === currentStepIndex,
      })),
    [t, currentStepIndex],
  );

  const handleCompleteSetup = () => {
    const tab = STEP_TAB_MAP[normalizedStep] ?? 'connect';
    onNavigateToStep(tab);
  };

  if (normalizedStep === 'ready') return null;

  return (
    <div className="mx-6 mt-4 p-4 rounded-lg bg-info/10 border border-info/20">
      <div className="flex items-start gap-3">
        <Info className="w-5 h-5 text-info shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground">{t('title')}</p>
          <p className="text-xs text-muted mt-1">{t('description')}</p>

          {/* Step progress indicators */}
          <div className="flex items-center gap-2 mt-3">
            {steps.map((step, i) => (
              <div key={step.id} className="flex items-center gap-1">
                <div
                  className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                    step.completed
                      ? 'bg-success text-success-foreground'
                      : step.current
                        ? 'bg-info text-info-foreground'
                        : 'bg-muted/20 text-muted'
                  }`}
                >
                  {i + 1}
                </div>
                <span
                  className={`text-xs ${step.current ? 'text-foreground font-medium' : 'text-muted'}`}
                >
                  {step.label}
                </span>
                {i < steps.length - 1 && <ChevronRight className="w-3 h-3 text-muted" />}
              </div>
            ))}
          </div>
        </div>

        <Button variant="primary" size="sm" onClick={handleCompleteSetup}>
          {t('complete_setup')}
        </Button>
      </div>
    </div>
  );
}
