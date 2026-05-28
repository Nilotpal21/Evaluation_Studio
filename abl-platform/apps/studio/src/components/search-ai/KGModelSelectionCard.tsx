/**
 * KGModelSelectionCard Component
 *
 * Shows available tenant models with capability scores and recommendations
 * for Knowledge Graph workloads. Allows user to select a model to configure.
 */

'use client';

import { useState } from 'react';
import { Sparkles, Check, ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { clsx } from 'clsx';

import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';

interface ModelCapabilities {
  score: number;
  reasoning: string;
}

interface AssessedModel {
  id: string;
  displayName: string;
  provider: string | null;
  tier: string;
  capabilities: {
    knowledgeGraph: ModelCapabilities;
  };
}

interface ModelRecommendation {
  modelId: string;
  reason: string;
}

interface KGModelSelectionCardProps {
  models: AssessedModel[];
  recommendation: ModelRecommendation | null;
  onSelect: (modelId: string) => void;
  isConfiguring?: boolean;
}

/**
 * Get provider display color
 */
function getProviderColor(provider: string | null): string {
  if (!provider) return 'bg-muted';
  const p = provider.toLowerCase();
  if (p === 'anthropic') return 'bg-purple';
  if (p === 'openai') return 'bg-success';
  return 'bg-accent';
}

/**
 * Get score color based on capability score
 */
function getScoreColor(score: number): string {
  if (score >= 0.95) return 'text-success';
  if (score >= 0.85) return 'text-accent';
  return 'text-warning';
}

export function KGModelSelectionCard({
  models,
  recommendation,
  onSelect,
  isConfiguring = false,
}: KGModelSelectionCardProps) {
  const t = useTranslations('knowledgeGraph');
  const [selectedModelId, setSelectedModelId] = useState<string | null>(
    recommendation?.modelId || null,
  );

  const handleSelect = (modelId: string) => {
    setSelectedModelId(modelId);
  };

  const handleConfigure = () => {
    if (selectedModelId) {
      onSelect(selectedModelId);
    }
  };

  return (
    <Card className="p-6">
      <div className="mb-6">
        <h3 className="text-lg font-semibold text-foreground mb-2">
          {t('select_model_title', { defaultValue: 'Select Model for Knowledge Graph' })}
        </h3>
        <p className="text-sm text-muted">
          {t('select_model_description', {
            defaultValue:
              'Choose an LLM model to power Knowledge Graph features including entity extraction, classification, and relationship mapping.',
          })}
        </p>
      </div>

      {/* Recommendation Banner */}
      {recommendation && (
        <div className="mb-4 p-3 rounded-lg bg-accent/10 border border-accent/20">
          <div className="flex items-start gap-2">
            <Sparkles className="h-4 w-4 text-accent mt-0.5 flex-shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-medium text-accent mb-1">
                {t('recommended', { defaultValue: 'Recommended' })}
              </p>
              <p className="text-xs text-muted">{recommendation.reason}</p>
            </div>
          </div>
        </div>
      )}

      {/* Model List */}
      <div className="space-y-3 mb-6">
        {models.map((model) => {
          const isRecommended = recommendation?.modelId === model.id;
          const isSelected = selectedModelId === model.id;
          const score = model.capabilities.knowledgeGraph.score;

          return (
            <button
              key={model.id}
              onClick={() => handleSelect(model.id)}
              disabled={isConfiguring}
              className={clsx(
                'w-full text-left p-4 rounded-lg border-2 transition-all',
                isSelected
                  ? 'border-accent bg-accent/5'
                  : 'border-default hover:border-accent/50 bg-background',
                isConfiguring && 'opacity-50 cursor-not-allowed',
              )}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-sm font-medium text-foreground">{model.displayName}</span>

                    {model.provider && (
                      <Badge variant="default">
                        <div
                          className={clsx(
                            'w-2 h-2 rounded-full mr-1',
                            getProviderColor(model.provider),
                          )}
                        />
                        {model.provider}
                      </Badge>
                    )}

                    {isRecommended && (
                      <Badge variant="success">
                        <Sparkles className="h-3 w-3 mr-1" />
                        {t('best_for_kg', { defaultValue: 'Best for KG' })}
                      </Badge>
                    )}
                  </div>

                  <p className="text-xs text-muted mb-2">
                    {model.capabilities.knowledgeGraph.reasoning}
                  </p>

                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted">
                      {t('capability_score', { defaultValue: 'Capability Score:' })}
                    </span>
                    <span className={clsx('text-xs font-mono font-semibold', getScoreColor(score))}>
                      {(score * 100).toFixed(0)}%
                    </span>
                  </div>
                </div>

                <div className="flex-shrink-0 ml-4">
                  <div
                    className={clsx(
                      'w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all',
                      isSelected
                        ? 'border-accent bg-accent'
                        : 'border-default group-hover:border-accent/50',
                    )}
                  >
                    {isSelected && <Check className="h-3 w-3 text-accent-foreground" />}
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Configure Button */}
      <div className="flex justify-end">
        <Button
          onClick={handleConfigure}
          disabled={!selectedModelId || isConfiguring}
          variant="primary"
          size="md"
        >
          {isConfiguring ? (
            <>
              <div className="h-4 w-4 mr-2 border-2 border-current border-t-transparent rounded-full animate-spin" />
              {t('configuring', { defaultValue: 'Configuring...' })}
            </>
          ) : (
            <>
              {t('configure_and_continue', { defaultValue: 'Configure & Continue' })}
              <ChevronRight className="h-4 w-4 ml-2" />
            </>
          )}
        </Button>
      </div>
    </Card>
  );
}
