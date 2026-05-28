/**
 * AgentModelTab Component
 *
 * Per-agent model selection from project's available pool.
 * Persists to AgentModelConfig via runtime API.
 * Shows all hyperparameters from model capabilities + Responses API dropdown.
 */

import { useState, useEffect, useCallback } from 'react';
import { Brain, Loader2, RotateCcw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import clsx from 'clsx';
import { apiFetch } from '../../lib/api-client';
import { useNavigationStore } from '../../store/navigation-store';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import { Checkbox } from '../ui/Checkbox';
import { EmptyState } from '../ui/EmptyState';
import { getDefaultHyperParameterValues, HyperParameterForm } from '../admin/HyperParameterForm';
import type { HyperParameter, HyperParameterValue } from '../admin/HyperParameterForm';
import { toast } from 'sonner';
import { sanitizeError } from '../../lib/sanitize-error';
import { formatModelOptionLabel } from '../../lib/model-display';
import { getModelCapabilitiesUrl } from '../../lib/model-capabilities-url';

interface ProjectModel {
  id: string;
  name: string;
  modelId: string;
  provider: string;
  tier?: string;
  isDefault: boolean;
  temperature?: number;
  maxTokens?: number;
}

interface AgentModelConfig {
  defaultModel: string | null;
  operationModels: Record<string, string>;
  temperature: number | null;
  maxTokens: number | null;
  hyperParameters: Record<string, unknown> | null;
  useResponsesApi: boolean | null;
  useStreaming: boolean | null;
}

interface AgentModelTabProps {
  projectId: string;
  agentName: string;
  embedded?: boolean;
  modelLabel?: string;
  modelDescription?: string;
}

const TEXT_DEFAULT_TIER_ORDER = ['balanced', 'powerful', 'fast'] as const;

function selectPrimaryTextProjectModel(projectModels: ProjectModel[]): ProjectModel | null {
  const textDefaults = projectModels.filter((model) => model.isDefault && model.tier !== 'voice');
  for (const tier of TEXT_DEFAULT_TIER_ORDER) {
    const match = textDefaults.find((model) => model.tier === tier);
    if (match) return match;
  }
  return (
    textDefaults[0] ??
    projectModels.find((model) => model.tier !== 'voice') ??
    projectModels[0] ??
    null
  );
}

export function AgentModelTab({
  projectId,
  agentName,
  embedded = false,
  modelLabel,
  modelDescription,
}: AgentModelTabProps) {
  const t = useTranslations('agents.model_tab');
  const tCommon = useTranslations('common');
  const { navigate } = useNavigationStore();
  const [projectModels, setProjectModels] = useState<ProjectModel[]>([]);
  const [config, setConfig] = useState<AgentModelConfig>({
    defaultModel: null,
    operationModels: {},
    temperature: null,
    maxTokens: null,
    hyperParameters: null,
    useResponsesApi: null,
    useStreaming: null,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);

  // Hyperparameter state
  const [hyperParams, setHyperParams] = useState<HyperParameter[]>([]);
  const [hyperValues, setHyperValues] = useState<Record<string, HyperParameterValue>>({});
  const [overrideHyperParams, setOverrideHyperParams] = useState(false);

  // Responses API state
  const [supportsResponsesApi, setSupportsResponsesApi] = useState(false);
  const [overrideResponsesApi, setOverrideResponsesApi] = useState(false);
  const [editUseResponsesApi, setEditUseResponsesApi] = useState(true);

  // Streaming mode state
  const [supportsStreamingMode, setSupportsStreamingMode] = useState(false);
  const [overrideStreaming, setOverrideStreaming] = useState(false);
  const [editUseStreaming, setEditUseStreaming] = useState(true);

  // Resolve the effective model ID for capability lookup
  const getEffectiveModelId = useCallback((): string | null => {
    if (config.defaultModel) return config.defaultModel;
    return selectPrimaryTextProjectModel(projectModels)?.modelId ?? null;
  }, [config.defaultModel, projectModels]);

  // Fetch model capabilities when model changes
  const fetchCapabilities = useCallback(async (modelId: string, savedConfig: AgentModelConfig) => {
    try {
      const res = await apiFetch(getModelCapabilitiesUrl(modelId));
      if (!res.ok) return;
      const data = await res.json();

      if (data.hyperParameters?.length > 0) {
        setHyperParams(data.hyperParameters);
        // Initialize values from saved config or defaults
        const stored = (savedConfig.hyperParameters as Record<string, unknown>) ?? {};
        const initial = getDefaultHyperParameterValues(data.hyperParameters as HyperParameter[], {
          ...stored,
          ...(savedConfig.temperature != null ? { temperature: savedConfig.temperature } : {}),
          ...(savedConfig.maxTokens != null
            ? {
                maxTokens: savedConfig.maxTokens,
                max_tokens: savedConfig.maxTokens,
                max_completion_tokens: savedConfig.maxTokens,
                maxOutputTokens: savedConfig.maxTokens,
              }
            : {}),
        });
        setHyperValues(initial);
        // If saved config had hyperParameters or temperature/maxTokens, mark as overriding
        const hasStoredOverrides =
          savedConfig.hyperParameters != null ||
          savedConfig.temperature != null ||
          savedConfig.maxTokens != null;
        setOverrideHyperParams(hasStoredOverrides);
      } else {
        setHyperParams([]);
      }

      if (typeof data.supportsResponsesApi === 'boolean') {
        setSupportsResponsesApi(data.supportsResponsesApi);
        if (savedConfig.useResponsesApi != null) {
          setOverrideResponsesApi(true);
          setEditUseResponsesApi(savedConfig.useResponsesApi);
        } else {
          setOverrideResponsesApi(false);
          setEditUseResponsesApi(true); // default for supported models
        }
      } else {
        setSupportsResponsesApi(false);
      }

      if (typeof data.supportsStreaming === 'boolean') {
        setSupportsStreamingMode(data.supportsStreaming);
        if (savedConfig.useStreaming != null) {
          setOverrideStreaming(true);
          setEditUseStreaming(savedConfig.useStreaming);
        } else {
          setOverrideStreaming(false);
          setEditUseStreaming(true); // default for streaming-capable models
        }
      } else {
        setSupportsStreamingMode(false);
      }
    } catch {
      // Capabilities fetch failed — keep defaults
    }
  }, []);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      // Fetch models and agent config independently so a config 404 doesn't hide models
      const modelsRes = await apiFetch(`/api/models?projectId=${projectId}`);
      const modelsData = await modelsRes.json();
      const models: ProjectModel[] = modelsData.models || [];
      setProjectModels(models);

      let savedConfig: AgentModelConfig = {
        defaultModel: null,
        operationModels: {},
        temperature: null,
        maxTokens: null,
        hyperParameters: null,
        useResponsesApi: null,
        useStreaming: null,
      };

      try {
        const configRes = await apiFetch(
          `/api/projects/${projectId}/agents/${agentName}/model-config`,
        );
        const configData = await configRes.json();
        if (configData.config) {
          savedConfig = {
            defaultModel: configData.config.defaultModel || null,
            operationModels: configData.config.operationModels || {},
            temperature: configData.config.temperature ?? null,
            maxTokens: configData.config.maxTokens ?? null,
            hyperParameters: configData.config.hyperParameters ?? null,
            useResponsesApi: configData.config.useResponsesApi ?? null,
            useStreaming: configData.config.useStreaming ?? null,
          };
          setConfig(savedConfig);
        }
      } catch {
        // Agent config not found — keep defaults, models still show
      }

      // Determine effective model and fetch capabilities
      const effectiveModelId =
        savedConfig.defaultModel || selectPrimaryTextProjectModel(models)?.modelId;
      if (effectiveModelId) {
        await fetchCapabilities(effectiveModelId, savedConfig);
      }

      setIsDirty(false);
    } catch {
      // Models fetch failed — show empty state
    } finally {
      setIsLoading(false);
    }
  }, [projectId, agentName, fetchCapabilities]);

  useEffect(() => {
    load();
  }, [load]);

  // When model selection changes, re-fetch capabilities
  const handleModelChange = useCallback(
    (modelId: string | null) => {
      setConfig((prev) => ({ ...prev, defaultModel: modelId }));
      setIsDirty(true);
      // Reset hyperparameter override state
      setOverrideHyperParams(false);
      setOverrideResponsesApi(false);
      setSupportsResponsesApi(false);
      setOverrideStreaming(false);
      setSupportsStreamingMode(false);
      setHyperParams([]);
      setHyperValues({});
      // Fetch capabilities for new model
      const resolvedId = modelId || selectPrimaryTextProjectModel(projectModels)?.modelId;
      if (resolvedId) {
        fetchCapabilities(resolvedId, {
          defaultModel: modelId,
          operationModels: config.operationModels,
          temperature: null,
          maxTokens: null,
          hyperParameters: null,
          useResponsesApi: null,
          useStreaming: null,
        });
      }
    },
    [projectModels, config.operationModels, fetchCapabilities],
  );

  const projectDefault = selectPrimaryTextProjectModel(projectModels);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      // Extract temperature and maxTokens from hyperValues if overriding
      let temperature: number | null = null;
      let maxTokens: number | null = null;
      let hyperParametersToSave: Record<string, unknown> | null = null;

      if (overrideHyperParams && hyperParams.length > 0) {
        hyperParametersToSave = { ...hyperValues };
        // Also extract temperature/maxTokens for the dedicated fields
        for (const hp of hyperParams) {
          if (hp.name === 'temperature' || hp.unifiedParam === 'temperature') {
            temperature =
              typeof hyperValues[hp.name] === 'number' ? (hyperValues[hp.name] as number) : null;
          }
          if (
            hp.name === 'maxTokens' ||
            hp.name === 'max_tokens' ||
            hp.name === 'max_completion_tokens' ||
            hp.unifiedParam === 'max_tokens' ||
            hp.unifiedParam === 'max_completion_tokens'
          ) {
            maxTokens =
              typeof hyperValues[hp.name] === 'number' ? (hyperValues[hp.name] as number) : null;
          }
        }
      }

      await apiFetch(`/api/projects/${projectId}/agents/${agentName}/model-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...config,
          temperature,
          maxTokens,
          hyperParameters: hyperParametersToSave,
          useResponsesApi: overrideResponsesApi ? editUseResponsesApi : null,
          useStreaming: overrideStreaming ? editUseStreaming : null,
        }),
      });
      toast.success(t('saved'));
      setIsDirty(false);
    } catch (err) {
      toast.error(sanitizeError(err, 'Failed to save'));
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = () => {
    setConfig({
      defaultModel: null,
      operationModels: {},
      temperature: null,
      maxTokens: null,
      hyperParameters: null,
      useResponsesApi: null,
      useStreaming: null,
    });
    setOverrideHyperParams(false);
    setOverrideResponsesApi(false);
    setOverrideStreaming(false);
    // Reset hyperValues to defaults
    setHyperValues(getDefaultHyperParameterValues(hyperParams));
    setIsDirty(true);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-5 h-5 text-muted animate-spin" />
      </div>
    );
  }

  if (projectModels.length === 0) {
    return (
      <div className="py-8">
        <EmptyState
          icon={<Brain className="w-6 h-6" />}
          title={t('no_models_title')}
          description={t('no_models_description')}
          action={
            <button
              onClick={() => navigate(`/projects/${projectId}/settings/models`)}
              className="text-sm text-info hover:underline"
            >
              {t('go_to_settings')}
            </button>
          }
        />
      </div>
    );
  }

  return (
    <div className={clsx(embedded ? 'space-y-6' : 'max-w-xl py-6 space-y-6')}>
      {/* Default Model */}
      <div>
        <Select
          label={modelLabel ?? t('default_model_label')}
          value={config.defaultModel || ''}
          onChange={(v) => handleModelChange(v || null)}
          options={[
            {
              value: '',
              label: projectDefault
                ? t('use_project_default_with_name', { name: projectDefault.name })
                : t('use_project_default'),
            },
            ...projectModels.map((m) => ({
              value: m.modelId,
              label: formatModelOptionLabel(m),
            })),
          ]}
        />
        <p className="text-xs text-muted mt-1">{modelDescription ?? t('override_description')}</p>
      </div>

      {/* Hyperparameters with override checkbox */}
      {hyperParams.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <label className="block text-sm font-medium text-foreground">
              {t('hyper_parameters_label')}
            </label>
            <Checkbox
              checked={overrideHyperParams}
              onChange={(checked) => {
                setOverrideHyperParams(checked);
                if (!checked) {
                  // Reset to defaults
                  setHyperValues(getDefaultHyperParameterValues(hyperParams));
                }
                setIsDirty(true);
              }}
              label={t('override')}
            />
          </div>
          <div className={clsx(!overrideHyperParams && 'opacity-40 pointer-events-none')}>
            <HyperParameterForm
              parameters={hyperParams}
              values={hyperValues}
              onChange={(name, value) => {
                setHyperValues((prev) => ({ ...prev, [name]: value }));
                setIsDirty(true);
              }}
              disabled={!overrideHyperParams}
              compact
            />
          </div>
          <p className="text-xs text-muted mt-2">
            {overrideHyperParams
              ? t('hyper_parameters_overriding')
              : t('hyper_parameters_inheriting')}
          </p>
        </div>
      )}

      {/* Responses API override (OpenAI models that support it) */}
      {supportsResponsesApi && (
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="block text-sm font-medium text-foreground">
              {t('responses_api_label')}
            </label>
            <Checkbox
              checked={overrideResponsesApi}
              onChange={(checked) => {
                setOverrideResponsesApi(checked);
                if (!checked) {
                  setEditUseResponsesApi(true);
                }
                setIsDirty(true);
              }}
              label={t('override')}
            />
          </div>
          <div
            className={clsx(
              'relative w-52',
              !overrideResponsesApi && 'opacity-40 pointer-events-none',
            )}
          >
            <select
              value={editUseResponsesApi ? 'true' : 'false'}
              onChange={(e) => {
                setEditUseResponsesApi(e.target.value === 'true');
                setIsDirty(true);
              }}
              disabled={!overrideResponsesApi}
              className="w-full appearance-none rounded-lg border border-default bg-background-subtle text-foreground text-sm py-1.5 pl-2.5 pr-7 focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
            >
              <option value="true">{t('responses_api_enabled')}</option>
              <option value="false">{t('responses_api_disabled')}</option>
            </select>
            <svg
              className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-foreground-subtle pointer-events-none"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </div>
          <p className="text-xs text-muted mt-1">
            {overrideResponsesApi ? t('responses_api_overriding') : t('responses_api_inheriting')}
          </p>
        </div>
      )}

      {/* Streaming mode override (models that support streaming) */}
      {supportsStreamingMode && (
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="block text-sm font-medium text-foreground">
              {t('streaming_label')}
            </label>
            <Checkbox
              checked={overrideStreaming}
              onChange={(checked) => {
                setOverrideStreaming(checked);
                if (!checked) {
                  setEditUseStreaming(true);
                }
                setIsDirty(true);
              }}
              label={t('override')}
            />
          </div>
          <div
            className={clsx(
              'relative w-52',
              !overrideStreaming && 'opacity-40 pointer-events-none',
            )}
          >
            <select
              value={editUseStreaming ? 'true' : 'false'}
              onChange={(e) => {
                setEditUseStreaming(e.target.value === 'true');
                setIsDirty(true);
              }}
              disabled={!overrideStreaming}
              className="w-full appearance-none rounded-lg border border-default bg-background-subtle text-foreground text-sm py-1.5 pl-2.5 pr-7 focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
            >
              <option value="true">{t('streaming_enabled')}</option>
              <option value="false">{t('streaming_disabled')}</option>
            </select>
            <svg
              className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-foreground-subtle pointer-events-none"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </div>
          <p className="text-xs text-muted mt-1">
            {overrideStreaming ? t('streaming_overriding') : t('streaming_inheriting')}
          </p>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-3 pt-2">
        <Button variant="primary" onClick={handleSave} loading={isSaving} disabled={!isDirty}>
          {t('save')}
        </Button>
        <Button variant="ghost" icon={<RotateCcw className="w-3.5 h-3.5" />} onClick={handleReset}>
          {t('reset_to_default')}
        </Button>
      </div>
    </div>
  );
}
