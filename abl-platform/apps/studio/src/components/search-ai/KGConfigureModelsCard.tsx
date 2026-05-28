/**
 * KGConfigureModelsCard Component
 *
 * Displays a warning that no LLM models are configured and guides
 * the user to configure models before enabling Knowledge Graph.
 */

'use client';

import { AlertTriangle, Settings } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { useNavigationStore } from '../../store/navigation-store';

export function KGConfigureModelsCard() {
  const t = useTranslations('knowledgeGraph');
  const { projectId, navigate } = useNavigationStore();

  const handleNavigateToSettings = () => {
    if (projectId) {
      navigate(`/projects/${projectId}/settings/models`);
    }
  };

  return (
    <Card className="p-6">
      <div className="flex items-start gap-4">
        <div className="flex-shrink-0">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-warning/10">
            <AlertTriangle className="h-6 w-6 text-warning" />
          </div>
        </div>

        <div className="flex-1">
          <h3 className="text-lg font-semibold text-foreground mb-2">
            {t('configure_models_title', { defaultValue: 'No LLM Models Configured' })}
          </h3>

          <p className="text-sm text-muted mb-4">
            {t('configure_models_description', {
              defaultValue:
                'Knowledge Graph requires LLM models for entity extraction, domain classification, and relationship mapping. Please configure at least one model to continue.',
            })}
          </p>

          <div className="flex gap-3">
            <Button onClick={handleNavigateToSettings} variant="primary" size="md">
              <Settings className="h-4 w-4 mr-2" />
              {t('configure_models_button', { defaultValue: 'Configure Models' })}
            </Button>
          </div>

          <div className="mt-4 p-3 rounded-lg bg-background-muted">
            <p className="text-xs text-muted">
              <strong className="text-foreground">
                {t('supported_providers', { defaultValue: 'Supported Providers:' })}
              </strong>{' '}
              Anthropic (Claude), OpenAI (GPT-4), and other compatible LLM providers
            </p>
          </div>
        </div>
      </div>
    </Card>
  );
}
