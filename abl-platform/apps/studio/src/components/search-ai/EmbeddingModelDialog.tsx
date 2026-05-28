/**
 * Embedding Model Dialog (Redesigned)
 *
 * Dropdown-based model selection:
 * - BGE-M3 always available (self-hosted default)
 * - Workspace embedding models from Admin -> Models
 * - If no workspace models: shows "Configure Models" link
 * - Dimensions: auto-default + override dropdown
 * - Re-index warning preserved
 */

import { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, X, ExternalLink } from 'lucide-react';
import { Skeleton } from '../ui/Skeleton';
import { Select } from '../ui/Select';
import { Button } from '../ui/Button';
import { useNavigationStore } from '../../store/navigation-store';
import type { EmbeddingProviderInfo } from '../../api/pipelines';

interface CurrentEmbeddingConfig {
  provider: string;
  model: string;
  dimensions: number;
  providerConfig?: Record<string, unknown>;
}

interface EmbeddingModelDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (config: {
    provider: string;
    model: string;
    dimensions: number;
    providerConfig?: Record<string, unknown>;
  }) => Promise<void>;
  currentConfig: CurrentEmbeddingConfig;
  embeddingProviders: EmbeddingProviderInfo[] | null;
  loading: boolean;
  error: string | null;
  documentCount?: number;
  projectId?: string;
}

export function EmbeddingModelDialog({
  open,
  onClose,
  onConfirm,
  currentConfig,
  embeddingProviders,
  loading,
  error,
  documentCount = 0,
  projectId,
}: EmbeddingModelDialogProps) {
  const t = useTranslations('search_ai.pipeline');
  const navigate = useNavigationStore((s) => s.navigate);
  const [confirming, setConfirming] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState<string>(currentConfig?.model ?? 'bge-m3');
  const [selectedDimensions, setSelectedDimensions] = useState<number>(
    currentConfig?.dimensions ?? 1024,
  );

  // Build flat list from all providers - only BGE-M3 + workspace (tenant) models
  const availableModels = useMemo(() => {
    if (!embeddingProviders) return [];
    const models: {
      id: string;
      label: string;
      provider: string;
      providerId: string;
      dimensions: number[];
      defaultDimensions: number;
      costPer1MTokens: number;
      selfHosted: boolean;
      hasCredentials: boolean;
      tenantModelId?: string;
    }[] = [];

    for (const provider of embeddingProviders) {
      // Only show BGE-M3 (self-hosted) + tenant workspace models
      const isBgeM3 = provider.id === 'bge-m3';
      const isTenantModel = provider.id.startsWith('tenant:');
      if (!isBgeM3 && !isTenantModel) continue;

      for (const model of provider.models) {
        const isCurrent = model.id === currentConfig?.model;
        const source = isTenantModel ? 'Workspace' : 'Self-hosted';
        models.push({
          id: `${provider.id}::${model.id}`,
          label: `${model.name} - ${source}${isCurrent ? ' (Current)' : ''}`,
          provider: isTenantModel ? (provider as any).provider || provider.id : provider.id,
          providerId: provider.id,
          dimensions: model.dimensions,
          defaultDimensions: model.defaultDimensions,
          costPer1MTokens: model.costPer1MTokens,
          selfHosted: provider.selfHosted,
          hasCredentials: !provider.requiresCredentials || provider.hasCredentials,
          tenantModelId: (provider as any).tenantModelId,
        });
      }
    }
    return models;
  }, [embeddingProviders, currentConfig]);

  const selectedModel = useMemo(
    () => availableModels.find((m) => m.id.endsWith(`::${selectedModelId}`)),
    [availableModels, selectedModelId],
  );

  const hasWorkspaceModels = availableModels.some((m) => m.tenantModelId);

  const isSameAsCurrent =
    selectedModelId === currentConfig?.model && selectedDimensions === currentConfig?.dimensions;

  const canConfirm =
    !isSameAsCurrent &&
    !loading &&
    selectedModelId &&
    selectedDimensions > 0 &&
    selectedModel?.hasCredentials;

  function handleModelChange(value: string) {
    const modelId = value.split('::')[1] || value;
    setSelectedModelId(modelId);
    const model = availableModels.find((m) => m.id === value);
    if (model) {
      setSelectedDimensions(model.defaultDimensions);
    }
  }

  async function handleConfirm() {
    if (!selectedModel) return;
    setConfirming(true);
    try {
      await onConfirm({
        provider: selectedModel.provider,
        model: selectedModelId,
        dimensions: selectedDimensions,
      });
      onClose();
    } catch {
      // Error handled by parent
    } finally {
      setConfirming(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay">
      <div className="bg-background border border-default rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-default">
          <h3 className="text-lg font-semibold text-foreground">{t('embed_change_title')}</h3>
          <button className="p-1 hover:bg-background-muted rounded" onClick={onClose}>
            <X className="w-4 h-4 text-muted" />
          </button>
        </div>

        <div className="px-6 py-4 space-y-5">
          {currentConfig && (
            <div className="text-sm text-muted">
              {t('embed_current_label')}{' '}
              <span className="font-medium text-foreground">
                {currentConfig.model} ({currentConfig.dimensions}d)
              </span>
            </div>
          )}

          {loading && !embeddingProviders && (
            <div className="space-y-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          )}

          {embeddingProviders && availableModels.length > 0 && (
            <Select
              label={t('embed_model_label')}
              options={availableModels.map((m) => ({ value: m.id, label: m.label }))}
              value={selectedModel?.id || ''}
              onChange={handleModelChange}
            />
          )}

          {embeddingProviders && !hasWorkspaceModels && (
            <div className="rounded-lg border border-dashed border-default p-4 text-center">
              <p className="text-sm text-muted mb-2">
                No cloud embedding models configured in your workspace.
              </p>
              <p className="text-xs text-muted mb-3">
                Add embedding models (OpenAI, Cohere, Gemini, or custom) in Admin to use them here.
              </p>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  onClose();
                  navigate(projectId ? `/projects/${projectId}/settings/models` : '/admin/models');
                }}
              >
                Configure Models
                <ExternalLink className="w-3 h-3 ml-1" />
              </Button>
            </div>
          )}

          {/* Always show link to add more models */}
          {embeddingProviders && hasWorkspaceModels && (
            <div className="text-xs text-muted text-center">
              <button
                className="text-accent hover:underline"
                onClick={() => {
                  onClose();
                  navigate(projectId ? `/projects/${projectId}/settings/models` : '/admin/models');
                }}
              >
                Add more embedding models in Workspace Settings
              </button>
            </div>
          )}

          {selectedModel && selectedModel.dimensions.length > 1 && (
            <Select
              label={t('embed_dimensions_label')}
              options={selectedModel.dimensions.map((dim) => ({
                value: String(dim),
                label: `${dim}${dim === selectedModel.defaultDimensions ? ` (${t('embed_default')})` : ''}`,
              }))}
              value={String(selectedDimensions)}
              onChange={(v) => setSelectedDimensions(Number(v))}
            />
          )}

          {selectedModel && selectedModel.dimensions.length === 1 && (
            <div className="text-sm text-muted">
              {t('embed_dimensions_label')}:{' '}
              <span className="font-medium text-foreground">{selectedModel.dimensions[0]}</span>
            </div>
          )}

          {selectedModel && !selectedModel.hasCredentials && (
            <div className="flex items-start gap-2 p-3 text-sm text-warning bg-warning-subtle rounded-md">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <div>
                <p className="font-medium">API key not configured</p>
                <p className="text-xs mt-1">
                  Add credentials in{' '}
                  <button
                    className="underline"
                    onClick={() => {
                      onClose();
                      navigate('/admin/models');
                    }}
                  >
                    Workspace Settings
                  </button>
                </p>
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 p-3 text-sm text-error bg-error-subtle rounded-md">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {!isSameAsCurrent && selectedModel && (
            <div className="flex items-start gap-2 p-3 text-sm text-warning bg-warning-subtle rounded-md">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <div>
                <p className="font-medium">{t('embed_reindex_warning')}</p>
                {documentCount > 0 && (
                  <p className="mt-1 text-xs">
                    {t('embed_reindex_doc_count', { count: documentCount.toLocaleString() })}
                  </p>
                )}
                {selectedModel.costPer1MTokens > 0 && (
                  <p className="mt-1 text-xs">
                    {t('embed_reindex_cost', {
                      cost: selectedModel.costPer1MTokens,
                      provider: selectedModel.provider,
                    })}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-default">
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t('embed_cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleConfirm}
            disabled={!canConfirm || confirming}
            className="bg-warning text-warning-foreground hover:bg-warning/90"
          >
            {confirming ? t('embed_changing') : t('embed_confirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}
