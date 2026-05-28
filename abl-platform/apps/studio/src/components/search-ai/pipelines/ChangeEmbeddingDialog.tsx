/**
 * Change Embedding Model Dialog
 *
 * Modal for selecting a new embedding provider/model/dimensions.
 * Shows provider list with credential status, cost estimates,
 * and reindex warning before confirming.
 *
 * Reference: docs/searchai/pipelines/design/frontend/WIREMOCK-EMBEDDING-CONFIGURATION.md
 */

import { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, X, Check, Lock, ExternalLink } from 'lucide-react';
import { usePipelineStore } from '../../../store/pipeline-store';
import { Skeleton } from '../../ui/Skeleton';
import { Select } from '../../ui/Select';
import type { EmbeddingProviderInfo, EmbeddingModelInfo } from '../../../api/pipelines';

export function ChangeEmbeddingDialog() {
  const {
    draft,
    embeddingProviders,
    embeddingDialogLoading,
    embeddingDialogError,
    closeEmbeddingDialog,
    changeEmbeddingConfig,
  } = usePipelineStore();
  const t = useTranslations('search_ai.pipeline');

  const currentConfig = draft?.activeEmbeddingConfig;

  const [selectedProvider, setSelectedProvider] = useState<string>(
    currentConfig?.provider ?? 'bge-m3',
  );
  const [selectedModel, setSelectedModel] = useState<string>(currentConfig?.model ?? 'bge-m3');
  const [selectedDimensions, setSelectedDimensions] = useState<number>(
    currentConfig?.dimensions ?? 1024,
  );

  // Custom endpoint fields
  const [customBaseUrl, setCustomBaseUrl] = useState<string>(
    (currentConfig?.providerConfig?.baseUrl as string) ?? '',
  );

  // Azure OpenAI fields
  const [azureResourceName, setAzureResourceName] = useState<string>(
    (currentConfig?.providerConfig?.resourceName as string) ?? '',
  );
  const [azureDeploymentId, setAzureDeploymentId] = useState<string>(
    (currentConfig?.providerConfig?.deploymentId as string) ?? '',
  );
  const [azureApiVersion, setAzureApiVersion] = useState<string>(
    (currentConfig?.providerConfig?.apiVersion as string) ?? '2024-10-21',
  );

  const providerInfo = useMemo(
    () => embeddingProviders?.find((p) => p.id === selectedProvider),
    [embeddingProviders, selectedProvider],
  );

  const selectedModelInfo = useMemo(
    () => providerInfo?.models.find((m) => m.id === selectedModel),
    [providerInfo, selectedModel],
  );

  const isSameAsCurrentConfig =
    selectedProvider === currentConfig?.provider &&
    selectedModel === currentConfig?.model &&
    selectedDimensions === currentConfig?.dimensions;

  const canConfirm =
    !isSameAsCurrentConfig &&
    !embeddingDialogLoading &&
    selectedProvider &&
    selectedModel &&
    selectedDimensions > 0 &&
    (providerInfo ? !providerInfo.requiresCredentials || providerInfo.hasCredentials : true);

  const documentCount = draft ? ((draft as any).documentCount ?? 0) : 0;

  function handleProviderChange(providerId: string) {
    setSelectedProvider(providerId);
    const provider = embeddingProviders?.find((p) => p.id === providerId);
    if (provider && provider.models.length > 0) {
      setSelectedModel(provider.models[0].id);
      setSelectedDimensions(provider.models[0].defaultDimensions);
    } else if (providerId === 'custom') {
      setSelectedModel('');
      setSelectedDimensions(1024);
    }
  }

  function handleModelChange(modelId: string) {
    setSelectedModel(modelId);
    const model = providerInfo?.models.find((m) => m.id === modelId);
    if (model) {
      setSelectedDimensions(model.defaultDimensions);
    }
  }

  async function handleConfirm() {
    const providerConfig: Record<string, unknown> = {};
    if (selectedProvider === 'custom' && customBaseUrl) {
      providerConfig.baseUrl = customBaseUrl;
    }
    if (selectedProvider === 'azure') {
      if (azureResourceName) providerConfig.resourceName = azureResourceName;
      if (azureDeploymentId) providerConfig.deploymentId = azureDeploymentId;
      if (azureApiVersion) providerConfig.apiVersion = azureApiVersion;
    }

    await changeEmbeddingConfig({
      provider: selectedProvider,
      model: selectedModel,
      dimensions: selectedDimensions,
      ...(Object.keys(providerConfig).length > 0 ? { providerConfig } : {}),
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay">
      <div className="bg-background border border-default rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-default">
          <h3 className="text-lg font-semibold text-foreground">{t('embed_change_title')}</h3>
          <button className="p-1 hover:bg-background-muted rounded" onClick={closeEmbeddingDialog}>
            <X className="w-4 h-4 text-muted" />
          </button>
        </div>

        {/* Content */}
        <div className="px-6 py-4 space-y-5">
          {/* Current config */}
          {currentConfig && (
            <div className="text-sm text-muted">
              {t('embed_current_label')}{' '}
              <span className="font-medium text-foreground">
                {currentConfig.provider} ({currentConfig.model},{' '}
                {t('embed_dimensions_short', { count: currentConfig.dimensions })})
              </span>
            </div>
          )}

          {/* Loading state — skeleton provider list */}
          {embeddingDialogLoading && !embeddingProviders && (
            <div className="space-y-1">
              <Skeleton className="h-4 w-28 mb-2" />
              <div className="border border-default rounded-md divide-y divide-default">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="flex items-start gap-3 px-4 py-3">
                    <Skeleton className="h-4 w-4 rounded-full mt-0.5 shrink-0" />
                    <div className="flex-1">
                      <div className="flex items-center justify-between mb-1">
                        <Skeleton className="h-4 w-28" />
                        <Skeleton className="h-3 w-24" />
                      </div>
                      <Skeleton className="h-3 w-full" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Provider list */}
          {embeddingProviders && (
            <div className="space-y-1">
              <label className="text-sm font-medium text-foreground">
                {t('embed_select_provider')}
              </label>
              <div className="border border-default rounded-md divide-y divide-default">
                {embeddingProviders.map((provider) => (
                  <ProviderOption
                    key={provider.id}
                    provider={provider}
                    selected={selectedProvider === provider.id}
                    onSelect={() => handleProviderChange(provider.id)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Model selector (when provider has models) */}
          {providerInfo && providerInfo.models.length > 0 && (
            <div className="space-y-1">
              <Select
                label={t('embed_model_label')}
                options={providerInfo.models.map((model) => ({
                  value: model.id,
                  label: model.name,
                }))}
                value={selectedModel}
                onChange={handleModelChange}
              />
            </div>
          )}

          {/* Dimensions selector */}
          {selectedModelInfo && selectedModelInfo.dimensions.length > 1 && (
            <div className="space-y-1">
              <Select
                label={t('embed_dimensions_label')}
                options={selectedModelInfo.dimensions.map((dim) => ({
                  value: String(dim),
                  label: `${dim}${dim === selectedModelInfo.defaultDimensions ? ` (${t('embed_default')})` : ''}`,
                }))}
                value={String(selectedDimensions)}
                onChange={(v) => setSelectedDimensions(Number(v))}
              />
            </div>
          )}

          {/* Custom endpoint fields */}
          {selectedProvider === 'custom' && (
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-sm font-medium text-foreground">
                  {t('embed_custom_model_id')}
                </label>
                <input
                  type="text"
                  className="w-full px-3 py-2 text-sm border border-default rounded-md bg-background text-foreground"
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  placeholder="my-embedding-model"
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium text-foreground">
                  {t('embed_dimensions_label')}
                </label>
                <input
                  type="number"
                  className="w-full px-3 py-2 text-sm border border-default rounded-md bg-background text-foreground"
                  value={selectedDimensions}
                  onChange={(e) => setSelectedDimensions(Number(e.target.value))}
                  placeholder="1024"
                  min={1}
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium text-foreground">
                  {t('embed_custom_endpoint')}
                </label>
                <input
                  type="text"
                  className="w-full px-3 py-2 text-sm border border-default rounded-md bg-background text-foreground"
                  value={customBaseUrl}
                  onChange={(e) => setCustomBaseUrl(e.target.value)}
                  placeholder="http://my-service:8000"
                />
                <p className="text-xs text-muted">{t('embed_custom_endpoint_hint')}</p>
              </div>
            </div>
          )}

          {/* Azure OpenAI fields */}
          {selectedProvider === 'azure' && (
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-sm font-medium text-foreground">
                  {t('embed_azure_resource_name')}
                </label>
                <input
                  type="text"
                  className="w-full px-3 py-2 text-sm border border-default rounded-md bg-background text-foreground"
                  value={azureResourceName}
                  onChange={(e) => setAzureResourceName(e.target.value)}
                  placeholder="my-openai-resource"
                />
                <p className="text-xs text-muted">{t('embed_azure_resource_hint')}</p>
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium text-foreground">
                  {t('embed_azure_deployment_id')}
                </label>
                <input
                  type="text"
                  className="w-full px-3 py-2 text-sm border border-default rounded-md bg-background text-foreground"
                  value={azureDeploymentId}
                  onChange={(e) => setAzureDeploymentId(e.target.value)}
                  placeholder="text-embedding-3-small"
                />
                <p className="text-xs text-muted">{t('embed_azure_deployment_hint')}</p>
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium text-foreground">
                  {t('embed_azure_api_version')}
                </label>
                <input
                  type="text"
                  className="w-full px-3 py-2 text-sm border border-default rounded-md bg-background text-foreground"
                  value={azureApiVersion}
                  onChange={(e) => setAzureApiVersion(e.target.value)}
                  placeholder="2024-10-21"
                />
              </div>
            </div>
          )}

          {/* Error */}
          {embeddingDialogError && (
            <div className="flex items-start gap-2 p-3 text-sm text-error bg-error-subtle rounded-md">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{embeddingDialogError}</span>
            </div>
          )}

          {/* Reindex warning */}
          {!isSameAsCurrentConfig && selectedProvider && (
            <div className="flex items-start gap-2 p-3 text-sm text-warning bg-warning-subtle rounded-md">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <div>
                <p className="font-medium">{t('embed_reindex_warning')}</p>
                {documentCount > 0 && (
                  <p className="mt-1 text-xs">
                    {t('embed_reindex_doc_count', { count: documentCount.toLocaleString() })}
                  </p>
                )}
                {selectedModelInfo && selectedModelInfo.costPer1MTokens > 0 && (
                  <p className="mt-1 text-xs">
                    {t('embed_reindex_cost', {
                      cost: selectedModelInfo.costPer1MTokens,
                      provider: providerInfo?.name ?? '',
                    })}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-default">
          <button
            className="px-4 py-2 text-sm border border-default rounded-md hover:bg-background-muted"
            onClick={closeEmbeddingDialog}
          >
            {t('embed_cancel')}
          </button>
          <button
            className="px-4 py-2 text-sm bg-warning text-warning-foreground rounded-md hover:bg-warning/90 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleConfirm}
            disabled={!canConfirm}
            title={
              isSameAsCurrentConfig
                ? t('embed_title_same_config')
                : !canConfirm
                  ? t('embed_title_no_credentials')
                  : t('embed_title_confirm')
            }
          >
            {embeddingDialogLoading ? t('embed_changing') : t('embed_confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Provider Option ──────────────────────────────────────────────────────

function ProviderOption({
  provider,
  selected,
  onSelect,
}: {
  provider: EmbeddingProviderInfo;
  selected: boolean;
  onSelect: () => void;
}) {
  const t = useTranslations('search_ai.pipeline');
  const costLabel = provider.selfHosted
    ? t('embed_provider_free')
    : provider.models[0]
      ? `$${provider.models[0].costPer1MTokens}/1M tokens`
      : '';

  return (
    <label
      className={`flex items-start gap-3 px-4 py-3 cursor-pointer hover:bg-background-muted/50 transition-colors ${
        selected ? 'bg-background-muted/70' : ''
      }`}
    >
      <input
        type="radio"
        name="embedding-provider"
        checked={selected}
        onChange={onSelect}
        className="mt-1 accent-accent"
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-foreground">{provider.name}</span>
          <span className="text-xs text-muted">
            {provider.selfHosted ? t('embed_hosted_self') : t('embed_hosted_cloud')} | {costLabel}
          </span>
        </div>
        <p className="text-xs text-muted mt-0.5">{provider.description}</p>
        {provider.requiresCredentials && !provider.hasCredentials && (
          <div className="flex items-center gap-1 mt-1 text-xs text-warning">
            <Lock className="w-3 h-3" />
            <span>{t('embed_provider_no_key')}</span>
          </div>
        )}
        {provider.requiresCredentials && provider.hasCredentials && (
          <div className="flex items-center gap-1 mt-1 text-xs text-success">
            <Check className="w-3 h-3" />
            <span>{t('embed_provider_key_ok')}</span>
          </div>
        )}
      </div>
    </label>
  );
}
