/**
 * Add Stage Modal
 *
 * Displays a catalog of all available stage types and their registered providers.
 * Users pick a type + provider combination, then the stage is created pre-configured.
 *
 * Flow:
 * 1. On open, fetches providers for ALL stage types in parallel
 * 2. Displays grouped catalog: type → providers list
 * 3. User selects a provider card
 * 4. Clicks "Add Stage" → stage created with selected type + provider
 * 5. StageConfigPanel opens for fine-tuning
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { fetchProviderSchemas, type ProviderInfo } from '../../../api/pipelines';
import { Skeleton } from '../../ui/Skeleton';

const STAGE_TYPES = ['extraction', 'chunking', 'enrichment', 'embedding', 'multimodal'] as const;

type StageType = (typeof STAGE_TYPES)[number];

interface StageTypeProviders {
  type: StageType;
  providers: ProviderInfo[];
  loading: boolean;
  error: string | null;
}

interface AddStageModalProps {
  projectId: string;
  onAdd: (type: string, provider: string, providerDescription: string) => void;
  onClose: () => void;
}

export function AddStageModal({ projectId, onAdd, onClose }: AddStageModalProps) {
  const t = useTranslations('search_ai.pipeline');
  const [catalog, setCatalog] = useState<StageTypeProviders[]>(
    STAGE_TYPES.map((type) => ({ type, providers: [], loading: true, error: null })),
  );
  const [selectedType, setSelectedType] = useState<StageType | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);

  // Fetch providers for all stage types in parallel on mount
  useEffect(() => {
    let cancelled = false;

    async function loadAllProviders() {
      const results = await Promise.allSettled(
        STAGE_TYPES.map(async (type) => {
          const result = await fetchProviderSchemas(projectId, type);
          return { type, providers: result.providers };
        }),
      );

      if (cancelled) return;

      setCatalog(
        STAGE_TYPES.map((type, i) => {
          const result = results[i];
          if (result.status === 'fulfilled') {
            return {
              type,
              providers: result.value.providers,
              loading: false,
              error: null,
            };
          }
          return {
            type,
            providers: [],
            loading: false,
            error: result.reason instanceof Error ? result.reason.message : 'Failed to load',
          };
        }),
      );
    }

    loadAllProviders();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const stageTypeLabels: Record<string, string> = {
    extraction: t('stage_extraction'),
    chunking: t('stage_chunking'),
    enrichment: t('stage_enrichment'),
    embedding: t('stage_embedding'),
    multimodal: t('stage_multimodal'),
  };

  const stageTypeDescriptions: Record<string, string> = {
    extraction: t('add_stage_extraction_desc'),
    chunking: t('add_stage_chunking_desc'),
    enrichment: t('add_stage_enrichment_desc'),
    embedding: t('add_stage_embedding_desc'),
    multimodal: t('add_stage_multimodal_desc'),
  };

  const handleProviderSelect = useCallback(
    (type: StageType, providerId: string) => {
      if (selectedType === type && selectedProvider === providerId) {
        // Deselect
        setSelectedType(null);
        setSelectedProvider(null);
      } else {
        setSelectedType(type);
        setSelectedProvider(providerId);
      }
    },
    [selectedType, selectedProvider],
  );

  const handleAdd = useCallback(() => {
    if (!selectedType || !selectedProvider) return;

    const entry = catalog.find((c) => c.type === selectedType);
    const provider = entry?.providers.find((p) => p.id === selectedProvider);

    onAdd(selectedType, selectedProvider, provider?.description || '');
  }, [selectedType, selectedProvider, catalog, onAdd]);

  const isLoading = catalog.some((c) => c.loading);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-overlay backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="relative w-full max-w-2xl max-h-[80vh] bg-background border border-default rounded-xl shadow-xl flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-default flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-foreground">{t('add_stage_title')}</h2>
            <p className="text-sm text-muted mt-0.5">{t('add_stage_description')}</p>
          </div>
          <button className="p-1 text-muted hover:text-foreground rounded" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* Catalog */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {isLoading ? (
            <div className="space-y-6">
              {[1, 2, 3, 4].map((i) => (
                <div key={i}>
                  <Skeleton className="h-5 w-32 mb-3" />
                  <div className="grid grid-cols-2 gap-3">
                    <Skeleton className="h-24 rounded-lg" />
                    <Skeleton className="h-24 rounded-lg" />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            catalog.map((entry) => (
              <div key={entry.type}>
                {/* Stage type header */}
                <div className="mb-3">
                  <h3 className="text-sm font-semibold text-foreground">
                    {stageTypeLabels[entry.type] || entry.type}
                  </h3>
                  <p className="text-xs text-muted mt-0.5">
                    {stageTypeDescriptions[entry.type] || ''}
                  </p>
                </div>

                {/* Provider cards */}
                {entry.error ? (
                  <div className="p-3 rounded-lg border border-error bg-error-subtle">
                    <p className="text-xs text-error">{entry.error}</p>
                  </div>
                ) : entry.providers.length === 0 ? (
                  <div className="p-3 rounded-lg border border-dashed border-default">
                    <p className="text-xs text-muted">{t('add_stage_no_providers')}</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    {entry.providers.map((provider) => {
                      const isSelected =
                        selectedType === entry.type && selectedProvider === provider.id;

                      return (
                        <button
                          key={provider.id}
                          className={`text-left p-4 rounded-lg border transition-all ${
                            isSelected
                              ? 'border-accent bg-accent/5 ring-1 ring-accent'
                              : 'border-default bg-background-elevated hover:bg-background-muted hover:border-foreground/20'
                          }`}
                          onClick={() => handleProviderSelect(entry.type, provider.id)}
                        >
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-sm font-medium text-foreground">
                              {provider.name}
                            </span>
                            <span className="text-[10px] text-muted">v{provider.version}</span>
                          </div>
                          {provider.description && (
                            <p className="text-xs text-muted leading-relaxed line-clamp-2">
                              {provider.description}
                            </p>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-default flex items-center justify-between shrink-0">
          <div className="text-sm text-muted">
            {selectedType && selectedProvider ? (
              <span>
                {t('add_stage_selected', {
                  type: stageTypeLabels[selectedType] || selectedType,
                  provider:
                    catalog
                      .find((c) => c.type === selectedType)
                      ?.providers.find((p) => p.id === selectedProvider)?.name || selectedProvider,
                })}
              </span>
            ) : (
              <span>{t('add_stage_select_prompt')}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              className="px-4 py-2 text-sm text-muted hover:text-foreground"
              onClick={onClose}
            >
              {t('add_stage_cancel')}
            </button>
            <button
              className="px-4 py-2 text-sm font-medium bg-interactive-enabled text-interactive-foreground rounded-lg hover:bg-interactive-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={!selectedType || !selectedProvider}
              onClick={handleAdd}
            >
              {t('add_stage_confirm')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
