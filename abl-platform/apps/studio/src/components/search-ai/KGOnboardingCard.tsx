/**
 * KGOnboardingCard Component
 *
 * Combined onboarding card with two modes:
 * - no-models: Shows value proposition + link to configure models
 * - ready: Intro → delegates to KGTaxonomySetupCard for domain picker + configure + progress
 */

'use client';

import { useState, useCallback } from 'react';
import { clsx } from 'clsx';
import { Network, CheckCircle, Info, Settings } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { useNavigationStore } from '../../store/navigation-store';
import { KGTaxonomySetupCard } from './KGTaxonomySetupCard';

interface KGOnboardingCardProps {
  indexId: string;
  mode: 'no-models' | 'ready';
  autoConfigureModelId: string | null;
  recommendedModelName: string | null;
  siblingConfig: {
    name: string;
    model: string;
  } | null;
  onComplete: () => void;
}

type OnboardingStep = 'intro' | 'taxonomy-setup';

const BENEFITS = [
  'not_deployed_benefit_classify',
  'not_deployed_benefit_extract',
  'not_deployed_benefit_graph',
  'not_deployed_benefit_search',
] as const;

export function KGOnboardingCard({
  indexId,
  mode,
  autoConfigureModelId,
  recommendedModelName,
  siblingConfig,
  onComplete,
}: KGOnboardingCardProps) {
  const t = useTranslations('search_ai.kg');
  const projectId = useNavigationStore((s) => s.projectId);
  const navigate = useNavigationStore((s) => s.navigate);

  const [step, setStep] = useState<OnboardingStep>('intro');

  const handleNavigateToSettings = useCallback(() => {
    if (projectId) {
      navigate(`/projects/${projectId}/settings/models`);
    }
  }, [projectId, navigate]);

  // ── No Models Mode ──────────────────────────────────────────────────────
  if (mode === 'no-models') {
    return (
      <div className="py-12 flex justify-center">
        <Card className="max-w-lg w-full p-8">
          <div className="flex flex-col items-center text-center">
            <div className="w-12 h-12 rounded-xl bg-purple/10 flex items-center justify-center mb-4">
              <Network className="w-6 h-6 text-purple" />
            </div>

            <h3 className="text-lg font-semibold mb-2">{t('onboarding_title')}</h3>
            <p className="text-sm text-muted mb-6">{t('onboarding_description')}</p>

            {/* Info banner */}
            <div className="w-full rounded-lg bg-background-muted p-4 mb-6 text-left">
              <div className="flex items-start gap-3">
                <Info className="w-5 h-5 text-muted shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium mb-1">{t('onboarding_no_models_title')}</p>
                  <p className="text-xs text-muted">{t('onboarding_no_models_description')}</p>
                </div>
              </div>
            </div>

            <button
              onClick={handleNavigateToSettings}
              className={clsx(
                'w-full px-4 py-2.5 text-sm font-medium rounded-md transition-default mb-6',
                'bg-accent text-accent-foreground hover:opacity-90',
              )}
            >
              <Settings className="w-4 h-4 inline mr-2" />
              {t('onboarding_configure_models')}
            </button>

            {/* Benefits */}
            <div className="w-full space-y-3 text-left">
              <p className="text-xs font-medium text-muted uppercase tracking-wider">
                {t('onboarding_what_you_get')}
              </p>
              {BENEFITS.map((key) => (
                <div key={key} className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-success/10 flex items-center justify-center shrink-0">
                    <CheckCircle className="w-4 h-4 text-success" />
                  </div>
                  <span className="text-sm">{t(key)}</span>
                </div>
              ))}
            </div>
          </div>
        </Card>
      </div>
    );
  }

  // ── Ready Mode: Taxonomy Setup (delegate to existing component) ──
  if (step === 'taxonomy-setup') {
    return (
      <KGTaxonomySetupCard
        indexId={indexId}
        onComplete={onComplete}
        autoConfigureModelId={autoConfigureModelId ?? undefined}
      />
    );
  }

  // ── Ready Mode: Intro Step ──────────────────────────────────────────────
  return (
    <div className="py-12 flex justify-center">
      <Card className="max-w-lg w-full p-8">
        <div className="flex flex-col items-center text-center">
          <div className="w-12 h-12 rounded-xl bg-purple/10 flex items-center justify-center mb-4">
            <Network className="w-6 h-6 text-purple" />
          </div>

          <h3 className="text-lg font-semibold mb-2">{t('onboarding_title')}</h3>
          <p className="text-sm text-muted mb-6">{t('onboarding_description')}</p>

          {/* Sibling info banner — model is inherited, user still picks domain */}
          {siblingConfig && (
            <div className="w-full rounded-lg bg-accent/5 border border-accent/20 p-4 mb-6 text-left">
              <div className="flex items-start gap-3">
                <Info className="w-5 h-5 text-accent shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium">
                    {t('onboarding_sibling_banner', { name: siblingConfig.name })}
                  </p>
                  <p className="text-xs text-muted mt-1">
                    {t('onboarding_using_model', { model: siblingConfig.model })}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Model chip */}
          {recommendedModelName && !siblingConfig && (
            <div className="flex items-center gap-2 mb-6">
              <Badge variant="accent">
                {t('onboarding_using_model', { model: recommendedModelName })}
              </Badge>
            </div>
          )}

          {/* Steps list */}
          <div className="w-full text-left mb-6">
            <p className="text-xs font-medium text-muted uppercase tracking-wider mb-3">
              {t('onboarding_steps_title')}
            </p>
            <ol className="space-y-2 list-decimal list-inside text-sm text-muted">
              <li>{t('onboarding_step_1')}</li>
              <li>{t('onboarding_step_2')}</li>
              <li>{t('onboarding_step_3')}</li>
              <li>{t('onboarding_step_4')}</li>
            </ol>
          </div>

          {/* Get Started button */}
          <button
            onClick={() => setStep('taxonomy-setup')}
            className={clsx(
              'w-full px-4 py-2.5 text-sm font-medium rounded-md transition-default',
              'bg-accent text-accent-foreground hover:opacity-90',
            )}
          >
            {t('onboarding_select_domain')}
          </button>
        </div>
      </Card>
    </div>
  );
}
