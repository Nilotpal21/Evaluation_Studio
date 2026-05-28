/**
 * Stage Configuration Slide-Over Panel
 *
 * Side panel for configuring a pipeline stage's provider and settings.
 * Renders provider-specific configuration forms based on JSON Schema
 * from the ProviderRegistry API.
 *
 * RFC-004: "Provider-specific configuration form (dynamic based on provider)"
 *
 * Features:
 * - Stage type dropdown
 * - Provider selection from registered providers
 * - Dynamic provider-specific config form (not raw JSON)
 * - Fallback provider selection
 * - Error handling strategy
 * - Execution condition (CEL) with available variable reference
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { usePipelineStore } from '../../../store/pipeline-store';
import { Skeleton } from '../../ui/Skeleton';
import { fetchProviderSchemas, type ProviderInfo } from '../../../api/pipelines';
import { ProviderConfigForm } from './ProviderConfigForm';

const STAGE_TYPES = ['extraction', 'chunking', 'enrichment', 'embedding', 'multimodal'] as const;

export function StageConfigPanel() {
  const { draft, selectedFlowId, selectedStageId, projectId, closeStageConfig, updateStage } =
    usePipelineStore();

  const t = useTranslations('search_ai.pipeline');
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [schemas, setSchemas] = useState<Record<string, unknown>>({});
  const [loadingProviders, setLoadingProviders] = useState(false);

  // Find the selected stage
  const flow = draft?.flows.find((f) => f.id === selectedFlowId);
  const stage = flow?.stages.find((s) => s.id === selectedStageId);

  // Load provider schemas for the stage type
  useEffect(() => {
    if (!stage?.type || !projectId) return;

    setLoadingProviders(true);
    fetchProviderSchemas(projectId, stage.type)
      .then((result) => {
        setProviders(result.providers);
        setSchemas(result.schemas);
      })
      .catch(() => {
        setProviders([]);
        setSchemas({});
      })
      .finally(() => setLoadingProviders(false));
  }, [stage?.type, projectId]);

  const handleConfigChange = useCallback(
    (newConfig: Record<string, unknown>) => {
      if (!flow || !stage) return;
      updateStage(flow.id, stage.id, { providerConfig: newConfig });
    },
    [flow, stage, updateStage],
  );

  if (!flow || !stage) {
    return null;
  }

  const stageTypeLabels: Record<string, string> = useMemo(
    () => ({
      extraction: t('stage_extraction'),
      chunking: t('stage_chunking'),
      enrichment: t('stage_enrichment'),
      embedding: t('stage_embedding'),
      'knowledge-graph': t('stage_knowledge_graph'),
      multimodal: t('stage_multimodal'),
    }),
    [t],
  );

  const handleTypeChange = (newType: string) => {
    updateStage(flow.id, stage.id, {
      type: newType,
      provider: '',
      providerConfig: {},
      fallbackProvider: undefined,
      fallbackConfig: undefined,
    });
  };

  // Get schema for the currently selected provider
  const providerSchema = stage.provider
    ? (schemas[stage.provider] as Record<string, unknown> | undefined)
    : undefined;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-overlay backdrop-blur-sm" onClick={closeStageConfig} />

      {/* Panel */}
      <div className="relative w-full max-w-lg bg-background border-l border-default shadow-xl overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-background z-10 px-6 py-4 border-b border-default">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold text-foreground">
                {t('stage_config_title', { type: stageTypeLabels[stage.type] || stage.type })}
              </h3>
              <p className="text-xs text-muted mt-0.5">{t('stage_config_description')}</p>
            </div>
            <button
              className="p-1 text-muted hover:text-foreground rounded"
              onClick={closeStageConfig}
            >
              ✕
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {/* Stage name */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              {t('stage_config_name_label')}
            </label>
            <input
              type="text"
              value={stage.name}
              onChange={(e) => updateStage(flow.id, stage.id, { name: e.target.value })}
              className="w-full px-3 py-2 text-sm border border-default rounded-md bg-background-elevated text-foreground"
              placeholder={t('stage_config_name_placeholder')}
            />
          </div>

          {/* Stage type */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              {t('stage_config_type_label')}
            </label>
            <select
              value={stage.type}
              onChange={(e) => handleTypeChange(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-default rounded-md bg-background-elevated text-foreground"
            >
              {STAGE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {stageTypeLabels[type] || type}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted mt-1">{t('stage_config_type_hint')}</p>
          </div>

          {/* Provider selection */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              {t('stage_config_provider_label')}
            </label>
            {loadingProviders ? (
              <div className="space-y-2">
                <Skeleton className="h-10 w-full rounded-md" />
                <div className="flex items-center gap-2">
                  <Skeleton className="h-3 w-3 rounded-full" />
                  <Skeleton className="h-3 w-32" />
                </div>
              </div>
            ) : providers.length === 0 ? (
              <div className="p-3 rounded-md border border-default bg-background-elevated">
                <p className="text-sm text-muted">{t('stage_config_no_providers')}</p>
                <input
                  type="text"
                  value={stage.provider}
                  onChange={(e) => updateStage(flow.id, stage.id, { provider: e.target.value })}
                  className="mt-2 w-full px-3 py-2 text-sm border border-default rounded-md bg-background text-foreground"
                  placeholder={t('stage_config_provider_manual_placeholder')}
                />
              </div>
            ) : (
              <>
                <select
                  value={stage.provider}
                  onChange={(e) =>
                    updateStage(flow.id, stage.id, {
                      provider: e.target.value,
                      providerConfig: {},
                    })
                  }
                  className="w-full px-3 py-2 text-sm border border-default rounded-md bg-background-elevated text-foreground"
                >
                  <option value="">{t('stage_config_provider_placeholder')}</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} (v{p.version})
                    </option>
                  ))}
                </select>
                {stage.provider && providers.find((p) => p.id === stage.provider)?.description && (
                  <p className="text-xs text-muted mt-1">
                    {providers.find((p) => p.id === stage.provider)?.description}
                  </p>
                )}
              </>
            )}
          </div>

          {/* Provider configuration — dynamic form or JSON fallback */}
          {stage.provider && (
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                {t('stage_config_configuration_label')}
              </label>
              {providerSchema && (providerSchema as Record<string, unknown>).properties ? (
                <ProviderConfigForm
                  schema={providerSchema as any}
                  config={(stage.providerConfig as Record<string, unknown>) ?? {}}
                  onChange={handleConfigChange}
                  providerId={stage.provider}
                />
              ) : (
                <textarea
                  value={JSON.stringify(stage.providerConfig, null, 2)}
                  onChange={(e) => {
                    try {
                      const config = JSON.parse(e.target.value);
                      updateStage(flow.id, stage.id, { providerConfig: config });
                    } catch {
                      // Invalid JSON - don't update
                    }
                  }}
                  className="w-full px-3 py-2 text-sm border border-default rounded-md bg-background-elevated text-foreground font-mono"
                  rows={8}
                  placeholder="{}"
                />
              )}
            </div>
          )}

          {/* Fallback provider */}
          {!loadingProviders && providers.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                {t('stage_config_fallback_label')}
                <span className="text-muted font-normal ml-1">({t('stage_config_optional')})</span>
              </label>
              <select
                value={stage.fallbackProvider || ''}
                onChange={(e) =>
                  updateStage(flow.id, stage.id, {
                    fallbackProvider: e.target.value || undefined,
                  })
                }
                className="w-full px-3 py-2 text-sm border border-default rounded-md bg-background-elevated text-foreground"
              >
                <option value="">{t('stage_config_fallback_none')}</option>
                {providers
                  .filter((p) => p.id !== stage.provider)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} (v{p.version})
                    </option>
                  ))}
              </select>
              <p className="text-xs text-muted mt-1">{t('stage_config_fallback_hint')}</p>
            </div>
          )}

          {/* Error handling — always visible */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              {t('stage_config_on_error_label')}
            </label>
            <select
              value={stage.onError || 'fail'}
              onChange={(e) =>
                updateStage(flow.id, stage.id, {
                  onError: e.target.value as 'fail' | 'continue',
                })
              }
              className="w-full px-3 py-2 text-sm border border-default rounded-md bg-background-elevated text-foreground"
            >
              <option value="fail">{t('stage_config_on_error_fail')}</option>
              <option value="continue">{t('stage_config_on_error_continue')}</option>
            </select>
            <p className="text-xs text-muted mt-1">{t('stage_config_on_error_hint')}</p>
          </div>

          {/* Execution condition (CEL expression) with reference */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              {t('stage_config_execution_condition_label')}
              <span className="text-muted font-normal ml-1">({t('stage_config_optional')})</span>
            </label>
            <input
              type="text"
              value={stage.executionCondition || ''}
              onChange={(e) =>
                updateStage(flow.id, stage.id, {
                  executionCondition: e.target.value || undefined,
                })
              }
              className="w-full px-3 py-2 text-sm border border-default rounded-md bg-background-elevated text-foreground font-mono"
              placeholder='document.mimeType == "application/pdf"'
            />
            <p className="text-xs text-muted mt-1">{t('stage_config_execution_condition_hint')}</p>

            {/* Condition reference */}
            <div className="mt-2 p-3 rounded-md border border-default bg-background-muted">
              <p className="text-xs font-medium text-foreground mb-1.5">
                {t('stage_config_condition_variables_title')}
              </p>
              <ul className="text-[11px] text-muted space-y-0.5 font-mono">
                <li>
                  <strong>document.name</strong> — {t('stage_config_condition_var_name')}
                </li>
                <li>
                  <strong>document.mimeType</strong> — {t('stage_config_condition_var_mime')}
                </li>
                <li>
                  <strong>document.extension</strong> — {t('stage_config_condition_var_ext')}
                </li>
                <li>
                  <strong>document.size</strong> — {t('stage_config_condition_var_size')}
                </li>
                <li>
                  <strong>source.connector</strong> — {t('stage_config_condition_var_connector')}
                </li>
              </ul>
              <p className="text-xs font-medium text-foreground mt-2 mb-1.5">
                {t('stage_config_condition_examples_title')}
              </p>
              <ul className="text-[11px] text-muted space-y-0.5 font-mono">
                <li>document.mimeType == &quot;application/pdf&quot;</li>
                <li>document.size &gt; 10000000</li>
                <li>source.connector == &quot;sharepoint&quot;</li>
                <li>
                  document.extension == &quot;html&quot; || document.extension == &quot;htm&quot;
                </li>
              </ul>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 bg-background px-6 py-4 border-t border-default">
          <div className="flex justify-end gap-2">
            <button
              className="px-4 py-2 text-sm text-muted hover:text-foreground"
              onClick={closeStageConfig}
            >
              {t('stage_config_close')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
