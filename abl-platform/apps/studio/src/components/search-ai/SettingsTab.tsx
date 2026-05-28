/**
 * SettingsTab Component
 *
 * LLM Features configuration tab for Knowledge Base settings.
 * Displays all available LLM features with status tracking, model info,
 * inline model cards with Change button, and actionable guidance.
 */

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Settings, AlertCircle, CheckCircle2 } from 'lucide-react';
import { sanitizeError } from '@/lib/sanitize-error';
import { apiFetch } from '@/lib/api-client';
import { useNavigationStore } from '../../store/navigation-store';
import { FeatureCard } from './FeatureCard';
import { QueryPipelineLLMSection } from './QueryPipelineLLMSection';
import { EmbeddingModelSection } from './EmbeddingModelSection';
import { Button } from '../ui/Button';
import { Alert } from '../ui/Alert';
import { Card } from '../ui/Card';

// ─── Types ───────────────────────────────────────────────────────────────

interface EnhancedLLMConfig {
  tenantId: string;
  indexId: string;
  enabled: boolean;
  embeddingModel: string;
  embeddingDimensions: number;
  useCases: Record<string, any>;
  policy?: {
    monthlyTokenBudget: number;
    dailyTokenBudget: number;
    maxRequestsPerMinute: number;
    allowedProviders: string[];
  };
}

interface AvailableModel {
  id: string;
  displayName: string;
  provider: string;
  modelId: string;
  tier: string;
  supportsTools?: boolean;
}

interface SettingsTabProps {
  indexId: string;
  projectId: string;
}

// ─── Feature Metadata ───────────────────────────────────────────────────
// Mirrors backend USE_CASE_METADATA for proper display names, descriptions, and icons.

const FEATURE_META: Record<string, { displayName: string; description: string; icon: string }> = {
  progressiveSummarization: {
    displayName: 'Progressive Summarization',
    description:
      'Generate concise 2-3 sentence summaries per chunk with context from previous chunks',
    icon: 'FileText',
  },
  questionSynthesis: {
    displayName: 'Question Synthesis',
    description: 'Generate 3-5 answerable questions per chunk for improved retrieval',
    icon: 'HelpCircle',
  },
  knowledgeGraph: {
    displayName: 'Knowledge Graph Extraction',
    description: 'Extract entities and relationships to build knowledge graph',
    icon: 'Network',
  },
  scopeClassification: {
    displayName: 'Scope Classification',
    description: 'Classify content scope (chunk-level, document-level, global)',
    icon: 'Layers',
  },
  mapping_suggestion: {
    displayName: 'Field Mapping Suggestions',
    description: 'Suggest field mappings from connector schema to canonical schema',
    icon: 'ArrowRightLeft',
  },
  vocabularyGeneration: {
    displayName: 'Domain Vocabulary Generation',
    description: 'Enrich domain vocabulary with aliases, descriptions, and capabilities',
    icon: 'BookOpen',
  },
  treeBuilder: {
    displayName: 'Tree Builder',
    description: 'Hierarchical document tree structure for intelligent chunking',
    icon: 'GitBranch',
  },
  vision: {
    displayName: 'Vision Analysis',
    description: 'Analyze page screenshots and images for visual content understanding',
    icon: 'Eye',
  },
  multimodal: {
    displayName: 'Multimodal Deep Analysis',
    description: 'Deep analysis of images, tables, and charts with data extraction',
    icon: 'Scan',
  },
};

// ─── Feature Categories ──────────────────────────────────────────────────

const FEATURE_CATEGORY_KEYS = ['enrichment', 'advanced'] as const;

// ─── Component ───────────────────────────────────────────────────────────

export function SettingsTab({ indexId, projectId }: SettingsTabProps) {
  const t = useTranslations('search_ai.settings');
  const navigate = useNavigationStore((s) => s.navigate);
  const modelsSettingsPath = `/projects/${projectId}/settings/models`;
  const [config, setConfig] = useState<EnhancedLLMConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);

  // Load enhanced LLM config + available models
  useEffect(() => {
    loadConfig();
    loadAvailableModels();
  }, [indexId]);

  async function loadConfig() {
    if (!indexId) return;

    try {
      setLoading(true);
      setError(null);

      const response = await apiFetch(`/api/search-ai/indexes/${indexId}/llm-config`);

      if (!response.ok) {
        throw new Error(t('error_load_failed'));
      }

      const data = await response.json();
      setConfig(data.enhancedConfig);
    } catch (err) {
      setError(sanitizeError(err, t('error_loading')));
    } finally {
      setLoading(false);
    }
  }

  async function loadAvailableModels() {
    if (!indexId) return;

    try {
      const response = await apiFetch(`/api/search-ai/indexes/${indexId}/query-llm-status`);
      if (!response.ok) return;
      const data = await response.json();
      if (data.availableModels) {
        setAvailableModels(data.availableModels);
      }
    } catch {
      // Non-critical — feature cards still work without model selector
    }
  }

  async function saveConfig() {
    if (!indexId) return;
    if (!config) return;

    try {
      setSaving(true);
      setError(null);

      // Build update payload with only user-configurable fields
      const payload: any = {
        enabled: config.enabled,
        useCases: {},
      };

      // Extract user overrides from each use case
      Object.entries(config.useCases).forEach(([useCase, useCaseConfig]: [string, any]) => {
        payload.useCases[useCase] = {
          enabled: useCaseConfig.enabled,
          modelTier: useCaseConfig.modelTier,
          // Include use-case specific params (filter out internal fields)
          ...Object.fromEntries(
            Object.entries(useCaseConfig).filter(
              ([key]) =>
                ![
                  'useCase',
                  'status',
                  'model',
                  'provider',
                  'apiKey',
                  'resolution',
                  'actionRequired',
                  'estimatedCost',
                ].includes(key),
            ),
          ),
        };
      });

      const response = await apiFetch(`/api/search-ai/indexes/${indexId}/llm-config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(t('error_save_failed'));
      }

      const data = await response.json();
      setConfig(data.enhancedConfig);
      setHasChanges(false);
    } catch (err) {
      setError(sanitizeError(err, t('error_saving')));
    } finally {
      setSaving(false);
    }
  }

  function updateUseCase(useCase: string, updates: Record<string, any>) {
    if (!config) return;

    setConfig({
      ...config,
      useCases: {
        ...config.useCases,
        [useCase]: {
          ...config.useCases[useCase],
          ...updates,
        },
      },
    });
    setHasChanges(true);
  }

  // Get features by category
  // Core + Enrichment are merged into a single "Enrichment Features" category
  function getFeaturesByCategory(category: string) {
    if (!config) return [];

    return Object.entries(config.useCases)
      .map(([key, value]: [string, any]) => ({ key, ...value }))
      .filter((feature: any) => {
        if (category === 'enrichment') {
          return ['knowledgeGraph', 'mapping_suggestion', 'vocabularyGeneration'].includes(
            feature.key,
          );
        }
        if (category === 'advanced') {
          return ['vision', 'multimodal'].includes(feature.key);
        }
        return false;
      });
  }

  // Count features by status
  const statusCounts = config
    ? Object.values(config.useCases).reduce((acc: any, feature: any) => {
        acc[feature.status] = (acc[feature.status] || 0) + 1;
        return acc;
      }, {})
    : {};

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-sm text-muted">{t('loading')}</div>
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="error">
        <AlertCircle className="w-4 h-4" />
        <div>
          <div className="font-medium">{t('error_loading')}</div>
          <div className="text-sm mt-1">{error}</div>
          <Button size="sm" variant="secondary" onClick={loadConfig} className="mt-2">
            {t('retry')}
          </Button>
        </div>
      </Alert>
    );
  }

  if (!config) {
    return (
      <Alert variant="warning">
        <AlertCircle className="w-4 h-4" />
        <div>{t('no_config')}</div>
      </Alert>
    );
  }

  const hasPendingFeatures = statusCounts.pending > 0;

  return (
    <div className="space-y-6">
      {/* ── Section 1: LLM Features ────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground mb-1">{t('title')}</h2>
          <p className="text-sm text-muted">{t('description')}</p>
        </div>

        {hasChanges && (
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                loadConfig();
                setHasChanges(false);
              }}
            >
              {t('cancel')}
            </Button>
            <Button variant="primary" size="sm" onClick={saveConfig} disabled={saving}>
              {saving ? t('saving') : t('save_changes')}
            </Button>
          </div>
        )}
      </div>

      {/* Tenant Models — minimal header with configure button */}
      {config.policy && (
        <Card className="p-4 bg-background-subtle" hoverable={false}>
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground">{t('tenant_models')}</h3>
            <Button variant="secondary" onClick={() => navigate(modelsSettingsPath)}>
              {t('configure_models')}
            </Button>
          </div>
        </Card>
      )}

      {/* Pending Features Alert */}
      {hasPendingFeatures && (
        <Alert variant="warning">
          <AlertCircle className="w-4 h-4" />
          <div>
            <div className="font-medium">{t('features_need_config')}</div>
            <div className="text-sm mt-1">
              {t('features_pending_description', {
                count: statusCounts.pending,
              })}{' '}
              <button
                onClick={() => navigate(modelsSettingsPath)}
                className="underline hover:text-foreground"
              >
                {t('configure_models')}
              </button>
            </div>
          </div>
        </Alert>
      )}

      {/* Embedding Models */}
      <EmbeddingModelSection indexId={indexId} projectId={projectId} />

      {/* Feature Categories (Enrichment + Advanced) */}
      {FEATURE_CATEGORY_KEYS.map((categoryId) => {
        const features = getFeaturesByCategory(categoryId);

        if (features.length === 0) return null;

        return (
          <div key={categoryId} className="space-y-3">
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                {t(`category_${categoryId}_label`)}
              </h3>
              <p className="text-xs text-muted mt-0.5">{t(`category_${categoryId}_description`)}</p>
            </div>

            <div className="space-y-3">
              {features.map((feature: any) => {
                const meta = FEATURE_META[feature.key];
                return (
                  <FeatureCard
                    key={feature.key}
                    feature={feature.key}
                    displayName={meta?.displayName || feature.useCase || feature.key}
                    description={meta?.description || ''}
                    icon={meta?.icon || 'Sparkles'}
                    status={feature.status}
                    enabled={feature.enabled}
                    modelTier={feature.modelTier}
                    model={feature.model}
                    resolution={feature.resolution}
                    actionRequired={feature.actionRequired}
                    estimatedCost={feature.estimatedCost}
                    params={feature}
                    availableModels={availableModels}
                    projectId={projectId}
                    onToggle={(enabled) => updateUseCase(feature.key, { enabled })}
                    onChange={(params) => updateUseCase(feature.key, params)}
                    onModelChange={async (modelId, autoSelect) => {
                      // Immediate save — user expects instant effect when selecting a model
                      const updates = {
                        modelTier: autoSelect ? 'fast' : undefined,
                        ...(modelId ? { preferredModelId: modelId } : {}),
                      };
                      updateUseCase(feature.key, updates);
                      // Auto-save immediately (don't wait for Save button)
                      try {
                        const payload: any = { useCases: {} };
                        const updatedConfig = {
                          ...config!.useCases,
                          [feature.key]: { ...config!.useCases[feature.key], ...updates },
                        };
                        Object.entries(updatedConfig).forEach(([uc, ucConfig]: [string, any]) => {
                          payload.useCases[uc] = {
                            enabled: ucConfig.enabled,
                            modelTier: ucConfig.modelTier,
                            ...Object.fromEntries(
                              Object.entries(ucConfig).filter(
                                ([k]) =>
                                  ![
                                    'useCase',
                                    'status',
                                    'model',
                                    'provider',
                                    'apiKey',
                                    'resolution',
                                    'actionRequired',
                                    'estimatedCost',
                                  ].includes(k),
                              ),
                            ),
                          };
                        });
                        const res = await apiFetch(`/api/search-ai/indexes/${indexId}/llm-config`, {
                          method: 'PATCH',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify(payload),
                        });
                        if (res.ok) {
                          const data = await res.json();
                          setConfig(data.enhancedConfig);
                          setHasChanges(false);
                        }
                      } catch {
                        // Silently fail — user can retry
                      }
                    }}
                  />
                );
              })}
            </div>
          </div>
        );
      })}

      <div className="border-t border-border" />

      {/* ── Section 2: Query Pipeline LLM (bottom) ─────────────────── */}
      <QueryPipelineLLMSection indexId={indexId} projectId={projectId} />
    </div>
  );
}
