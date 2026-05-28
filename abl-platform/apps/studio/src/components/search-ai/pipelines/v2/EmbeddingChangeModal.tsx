/**
 * EmbeddingChangeModal — Warning modal for embedding provider changes.
 *
 * Shows a danger warning about full reindex, lets the user pick a provider
 * and model, and confirms the change.
 */

'use client';

import { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';

import { Dialog } from '../../../ui/Dialog';
import { Button } from '../../../ui/Button';
import { Select } from '../../../ui/Select';
import type { EmbeddingProviderInfo, ActiveEmbeddingConfig } from '../../../../api/pipelines';

export interface EmbeddingChangeModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (config: { provider: string; model: string; dimensions: number }) => void;
  isLoading: boolean;
  providers: EmbeddingProviderInfo[] | null;
  currentConfig?: ActiveEmbeddingConfig;
}

export function EmbeddingChangeModal({
  open,
  onClose,
  onConfirm,
  isLoading,
  providers,
  currentConfig,
}: EmbeddingChangeModalProps) {
  const t = useTranslations('search_ai.pipeline');

  const [selectedProviderId, setSelectedProviderId] = useState<string>(
    currentConfig?.provider ?? '',
  );
  const [selectedModelId, setSelectedModelId] = useState<string>(currentConfig?.model ?? '');

  const selectedProvider = useMemo(
    () => providers?.find((p) => p.id === selectedProviderId) ?? null,
    [providers, selectedProviderId],
  );

  const selectedModel = useMemo(
    () => selectedProvider?.models.find((m) => m.id === selectedModelId) ?? null,
    [selectedProvider, selectedModelId],
  );

  const providerOptions = useMemo(
    () => (providers ?? []).map((p) => ({ value: p.id, label: p.name })),
    [providers],
  );

  const modelOptions = useMemo(
    () => (selectedProvider?.models ?? []).map((m) => ({ value: m.id, label: m.name })),
    [selectedProvider],
  );

  const dimensions = selectedModel?.defaultDimensions ?? currentConfig?.dimensions ?? 0;

  const handleProviderChange = (value: string) => {
    setSelectedProviderId(value);
    const provider = providers?.find((p) => p.id === value);
    if (provider?.models[0]) {
      setSelectedModelId(provider.models[0].id);
    } else {
      setSelectedModelId('');
    }
  };

  const handleConfirm = () => {
    if (!selectedProviderId || !selectedModelId) return;
    onConfirm({
      provider: selectedProviderId,
      model: selectedModelId,
      dimensions,
    });
  };

  const canConfirm = selectedProviderId.length > 0 && selectedModelId.length > 0 && !isLoading;

  return (
    <Dialog open={open} onClose={onClose} title={t('v2_embedding_change_title')}>
      <div className="space-y-4">
        {/* Danger warning */}
        <div className="flex items-start gap-2 rounded-lg border border-error-subtle bg-error-subtle/30 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-error" />
          <p className="text-sm text-error">{t('v2_embedding_change_warning')}</p>
        </div>

        {/* Provider selector */}
        <Select
          label={t('v2_embedding_change_provider')}
          options={providerOptions}
          value={selectedProviderId}
          onChange={handleProviderChange}
          disabled={isLoading}
        />

        {/* Model selector */}
        <Select
          label={t('v2_embedding_change_model')}
          options={modelOptions}
          value={selectedModelId}
          onChange={setSelectedModelId}
          disabled={isLoading || !selectedProviderId}
        />

        {/* Dimensions display */}
        {dimensions > 0 && (
          <div className="space-y-1.5">
            <span className="block text-sm font-medium text-foreground">
              {t('v2_embedding_change_dimensions')}
            </span>
            <span className="text-sm text-muted">{dimensions}</span>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={isLoading}>
            {t('v2_deploy_cancel')}
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={handleConfirm}
            loading={isLoading}
            disabled={!canConfirm}
          >
            {t('v2_embedding_change_confirm')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
