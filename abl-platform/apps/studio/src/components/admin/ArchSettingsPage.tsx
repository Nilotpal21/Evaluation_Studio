/**
 * ArchSettingsPage Component
 *
 * Admin settings page for the Arch AI Assistant.
 * Three credential modes: Platform Credits, Direct API key,
 * or Model Hub (pick a pre-configured TenantModel).
 * Generation parameters are always shown.
 */

'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
  Sparkles,
  Check,
  AlertCircle,
  AlertTriangle,
  Eye,
  EyeOff,
  Loader2,
  ShieldCheck,
  ShieldX,
  ShieldQuestion,
  Zap,
  Link2,
  ExternalLink,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useArchConfigStore } from '../../lib/arch-ai/store/arch-config-store';
import type { ModelOption, HyperParameter } from '../../lib/arch-ai/store/arch-config-store';
import { getProviderIcon } from '../icons/ProviderIcons';
import { Select } from '../ui/Select';
import { ProviderSelect } from '../ui/ProviderSelect';
import { getDefaultHyperParameterValues, HyperParameterForm } from './HyperParameterForm';
import type { HyperParameterValue } from './HyperParameterForm';
import { SessionInspector } from './session-inspector/SessionInspector';
import { apiFetch } from '../../lib/api-client';
import { sanitizeError } from '../../lib/sanitize-error';
import { formatModelOptionLabel } from '../../lib/model-display';

// =============================================================================
// TYPES
// =============================================================================

type CredentialSource = 'platform' | 'model_hub' | 'direct_api_key';

interface TenantModelOption {
  id: string;
  displayName: string;
  provider: string | null;
  modelId: string | null;
  supportsTools: boolean;
  tier: string;
  isActive: boolean;
  capabilities: string[];
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Display metadata for known providers. */
const PROVIDER_META: Record<string, { name: string; description: string }> = {
  anthropic: { name: 'Anthropic', description: 'Claude models' },
  openai: { name: 'OpenAI', description: 'GPT & o-series models' },
  google: { name: 'Google', description: 'Gemini models' },
  azure: { name: 'Azure', description: 'Azure OpenAI models' },
  microsoft_foundry_anthropic: {
    name: 'Microsoft Foundry Anthropic',
    description: 'Claude via Foundry Anthropic Messages',
  },
  cohere: { name: 'Cohere', description: 'Command models' },
  google_vertex: { name: 'Vertex AI', description: 'Google Vertex AI' },
  groq: { name: 'Groq', description: 'Groq inference' },
  bedrock: { name: 'Bedrock', description: 'AWS Bedrock' },
};

/** Preferred ordering for provider cards. */
const PROVIDER_ORDER = [
  'anthropic',
  'openai',
  'google',
  'azure',
  'microsoft_foundry_anthropic',
  'cohere',
  'google_vertex',
  'groq',
  'bedrock',
];

/** Minimum context window for a model to be considered suitable for Arch. */
const MIN_CONTEXT_WINDOW = 32_000;

// =============================================================================
// HELPERS
// =============================================================================

function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000)
    return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}k`;
  return String(tokens);
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  return `${diffDays}d ago`;
}

/** Check model suitability for Arch and return warning keys. */
function getModelWarnings(
  model: { supportsTools?: boolean; contextWindow?: number; recommended?: boolean } | undefined,
  found: boolean,
): string[] {
  if (!found) return ['model_warning_unknown'];
  if (!model) return [];
  const warnings: string[] = [];
  if (model.supportsTools === false) warnings.push('model_warning_no_tools');
  if (model.contextWindow !== undefined && model.contextWindow < MIN_CONTEXT_WINDOW)
    warnings.push('model_warning_small_context');
  if (!model.recommended && warnings.length === 0) warnings.push('model_warning_not_tested');
  return warnings;
}

function providerLabel(provider: string | null): string {
  if (!provider) return 'Unknown';
  return PROVIDER_META[provider]?.name ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

function ProviderBadge({ provider }: { provider: string }) {
  const Icon = getProviderIcon(provider);
  return (
    <span className="flex items-center gap-1">
      <Icon className="w-3 h-3" />
      {providerLabel(provider)}
    </span>
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

export function ArchSettingsPage() {
  const t = useTranslations('admin');
  const {
    config,
    status: archStatus,
    models,
    isLoading,
    error,
    keyValidation,
    isValidatingKey,
    fetchConfig,
    fetchStatus,
    fetchModels,
    updateConfig,
    validateApiKey,
  } = useArchConfigStore();

  // Local form state (initialized from server config)
  const [formState, setFormState] = useState({
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-20250514',
    apiKey: '',
  });
  const [credentialSource, setCredentialSource] = useState<CredentialSource>('platform');
  const [tenantModels, setTenantModels] = useState<TenantModelOption[]>([]);
  const [tenantModelsLoading, setTenantModelsLoading] = useState(false);
  const [selectedTenantModelId, setSelectedTenantModelId] = useState<string | null>(null);
  const [hyperValues, setHyperValues] = useState<Record<string, HyperParameterValue>>({});
  const [showApiKey, setShowApiKey] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [activeTab, setActiveTab] = useState<'settings' | 'audit-logs'>('settings');

  // Fetch config and models on mount
  useEffect(() => {
    fetchConfig();
    fetchStatus();
    fetchModels();
  }, [fetchConfig, fetchModels, fetchStatus]);

  // Fetch tenant models for Model Hub mode
  useEffect(() => {
    setTenantModelsLoading(true);
    apiFetch('/api/tenant-models')
      .then((res) => res.json())
      .then((json) => {
        const items = json.models ?? json.data ?? [];
        setTenantModels(
          items
            .filter((m: TenantModelOption) => m.isActive)
            .map((m: Record<string, unknown>) => ({
              id: m.id as string,
              displayName: (m.displayName ?? m.name ?? 'Unknown') as string,
              provider: (m.provider ?? null) as string | null,
              modelId: (m.modelId ?? null) as string | null,
              supportsTools: Boolean(m.supportsTools),
              tier: (m.tier ?? 'balanced') as string,
              isActive: Boolean(m.isActive),
              capabilities: (m.capabilities ?? []) as string[],
            })),
        );
      })
      .catch((err) => {
        console.error(
          '[ArchSettings] Failed to fetch tenant models:',
          sanitizeError(err, 'Failed to fetch tenant models'),
        );
        setTenantModels([]);
      })
      .finally(() => setTenantModelsLoading(false));
  }, []);

  // Sync server config to local form state
  useEffect(() => {
    if (config) {
      setFormState((prev) => ({
        ...prev,
        provider: config.provider,
        modelId: config.modelId,
      }));
      // Determine credential source from config
      if (config.tenantModelId) {
        setCredentialSource('model_hub');
        setSelectedTenantModelId(config.tenantModelId);
      } else if (config.usePlatformCredits) {
        setCredentialSource('platform');
      } else {
        setCredentialSource('direct_api_key');
      }
      // Initialize hyperparameter values from saved config
      const saved = config.hyperParameters ?? {};
      const initial: Record<string, HyperParameterValue> = {};
      if (config.temperature !== undefined) initial['temperature'] = config.temperature;
      if (config.maxTokensChat !== undefined) {
        initial['max_tokens'] = config.maxTokensChat;
        initial['max_completion_tokens'] = config.maxTokensChat;
        initial['maxOutputTokens'] = config.maxTokensChat;
      }
      for (const [k, v] of Object.entries(saved)) {
        if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') {
          initial[k] = v;
        }
      }
      setHyperValues(initial);
    }
  }, [config]);

  useEffect(() => {
    if (
      credentialSource === 'model_hub' &&
      !selectedTenantModelId &&
      !config?.tenantModelId &&
      tenantModels.length > 0
    ) {
      const preferredModel = tenantModels.find((model) => model.supportsTools) ?? tenantModels[0];
      setSelectedTenantModelId(preferredModel.id);
    }
  }, [config?.tenantModelId, credentialSource, selectedTenantModelId, tenantModels]);

  // Derive providers from the models data
  const providers = useMemo(() => {
    if (!models) return [];
    const allModels = [...models.recommended, ...models.other];
    const providerSet = new Set(allModels.map((m) => m.provider));
    const list = [...providerSet].map((id) => {
      const meta = PROVIDER_META[id];
      const label = meta?.name ?? id.charAt(0).toUpperCase() + id.slice(1).replace(/_/g, ' ');
      const description = meta?.description ?? `${label} models`;
      return { value: id, label, description };
    });
    list.sort((a, b) => {
      const ai = PROVIDER_ORDER.indexOf(a.value);
      const bi = PROVIDER_ORDER.indexOf(b.value);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });
    return list;
  }, [models]);

  // Filter models by selected provider
  const providerModels = useMemo(() => {
    if (!models) return [];
    const all = [...models.recommended, ...models.other];
    return all.filter((m) => m.provider === formState.provider);
  }, [models, formState.provider]);

  // Get selected model entry (for Platform Credits mode)
  const selectedModel: ModelOption | undefined = useMemo(() => {
    return providerModels.find((m) => m.modelId === formState.modelId);
  }, [providerModels, formState.modelId]);

  // Get all models flat (for cross-referencing Model Hub selections)
  const allRegistryModels = useMemo(() => {
    if (!models) return [];
    return [...models.recommended, ...models.other];
  }, [models]);

  // Get selected tenant model entry
  const selectedTenantModel = useMemo(() => {
    return tenantModels.find((m) => m.id === selectedTenantModelId);
  }, [tenantModels, selectedTenantModelId]);

  const selectedTenantRegistryModel = useMemo(() => {
    if (!selectedTenantModel) return undefined;
    // Match on modelId only — MODEL_REGISTRY is keyed by modelId so the same
    // tenantId-scoped TenantModel resolves to the same capability entry
    // regardless of transport (e.g. Foundry-served claude-opus-4-7 vs native).
    return allRegistryModels.find((m) => m.modelId === selectedTenantModel.modelId);
  }, [allRegistryModels, selectedTenantModel]);

  // Model warnings for Platform Credits mode
  const platformModelWarnings = useMemo(() => {
    if (!selectedModel) return [];
    return getModelWarnings(selectedModel, true);
  }, [selectedModel]);

  // Model warnings for Model Hub mode
  const hubModelWarnings = useMemo(() => {
    if (!selectedTenantModel) return [];
    if (!selectedTenantRegistryModel) return getModelWarnings(undefined, false);
    return getModelWarnings(selectedTenantRegistryModel, true);
  }, [selectedTenantModel, selectedTenantRegistryModel]);

  // Is the selected Model Hub model recommended?
  const hubModelRecommended = useMemo(() => {
    return Boolean(selectedTenantRegistryModel?.recommended);
  }, [selectedTenantRegistryModel]);

  const activeModel =
    credentialSource === 'model_hub' ? selectedTenantRegistryModel : selectedModel;

  // Get hyperparameters for the selected model
  const modelHyperParams: HyperParameter[] = useMemo(() => {
    return activeModel?.hyperParameters ?? [];
  }, [activeModel]);

  // When model changes, initialize hyperValues from model defaults
  const initHyperValuesForModel = useCallback(
    (model: ModelOption | undefined) => {
      if (!model?.hyperParameters?.length) {
        setHyperValues({});
        return;
      }
      const saved = config?.hyperParameters ?? {};
      const initial = getDefaultHyperParameterValues(model.hyperParameters, saved);
      setHyperValues(initial);
    },
    [config],
  );

  const handleSave = useCallback(async () => {
    setSaveStatus('saving');

    const temperature =
      typeof hyperValues['temperature'] === 'number' ? hyperValues['temperature'] : undefined;
    const maxTokensChat =
      typeof hyperValues['max_tokens'] === 'number'
        ? hyperValues['max_tokens']
        : typeof hyperValues['max_completion_tokens'] === 'number'
          ? hyperValues['max_completion_tokens']
          : undefined;

    const updates: Record<string, unknown> = {
      hyperParameters: hyperValues,
    };

    if (credentialSource === 'model_hub') {
      updates.usePlatformCredits = false;
      updates.tenantModelId = selectedTenantModelId;
      updates.authProfileId = null;
      // Derive provider/model from selected TenantModel
      if (selectedTenantModel) {
        if (selectedTenantModel.provider) updates.provider = selectedTenantModel.provider;
        if (selectedTenantModel.modelId) updates.modelId = selectedTenantModel.modelId;
      }
    } else {
      updates.provider = formState.provider;
      updates.modelId = formState.modelId;
      updates.tenantModelId = null;
      updates.authProfileId = null;
      updates.usePlatformCredits = credentialSource === 'platform';
      if (credentialSource === 'direct_api_key' && formState.apiKey) {
        updates.apiKey = formState.apiKey;
      }
    }

    if (temperature !== undefined) updates.temperature = temperature;
    if (maxTokensChat !== undefined) updates.maxTokensChat = maxTokensChat;

    const success = await updateConfig(updates as Parameters<typeof updateConfig>[0]);
    setSaveStatus(success ? 'saved' : 'error');
    if (success) {
      setFormState((prev) => ({ ...prev, apiKey: '' }));
      fetchConfig();
      fetchStatus();
      setTimeout(() => setSaveStatus('idle'), 2000);
    }
  }, [
    formState,
    hyperValues,
    credentialSource,
    selectedTenantModelId,
    selectedTenantModel,
    config,
    updateConfig,
    fetchConfig,
    fetchStatus,
  ]);

  useEffect(() => {
    if (credentialSource === 'model_hub') {
      initHyperValuesForModel(activeModel);
    }
  }, [activeModel, credentialSource, initHyperValuesForModel]);

  const handleValidateKey = useCallback(async () => {
    if (!formState.apiKey) return;
    await validateApiKey(formState.provider, formState.apiKey);
  }, [formState.provider, formState.apiKey, validateApiKey]);

  const handleHyperParamChange = useCallback((name: string, value: HyperParameterValue) => {
    setHyperValues((prev) => ({ ...prev, [name]: value }));
  }, []);

  const updateField = <K extends keyof typeof formState>(key: K, value: (typeof formState)[K]) => {
    setFormState((prev) => ({ ...prev, [key]: value }));
  };

  const handleProviderChange = (providerId: string) => {
    updateField('provider', providerId);
    if (models) {
      const all = [...models.recommended, ...models.other];
      const forProvider = all.filter((m) => m.provider === providerId);
      const firstModel = forProvider[0];
      if (firstModel) {
        updateField('modelId', firstModel.modelId);
        initHyperValuesForModel(firstModel);
      } else {
        setHyperValues({});
      }
    }
  };

  const handleModelChange = (modelId: string) => {
    updateField('modelId', modelId);
    const model = providerModels.find((m) => m.modelId === modelId);
    initHyperValuesForModel(model);
  };

  const effectiveSourceLabel = useMemo(() => {
    switch (archStatus?.resolutionPath) {
      case 'model_hub':
      case 'auto_model_hub':
        return t('arch_settings.source_model_hub');
      case 'direct_api_key':
        return t('arch_settings.source_direct_api_key');
      case 'auth_profile':
        return t('arch_settings.source_auth_profile');
      case 'platform':
      case 'auto_platform':
        return t('arch_settings.source_platform');
      default:
        return t('arch_settings.source_not_ready');
    }
  }, [archStatus?.resolutionPath, t]);

  const requestedSourceLabel = useMemo(() => {
    switch (archStatus?.requestedSource) {
      case 'model_hub':
        return t('arch_settings.source_model_hub');
      case 'direct_api_key':
        return t('arch_settings.source_direct_api_key');
      case 'auth_profile':
        return t('arch_settings.source_auth_profile');
      case 'platform':
        return t('arch_settings.source_platform');
      default:
        return null;
    }
  }, [archStatus?.requestedSource, t]);

  const statusCardTone = archStatus?.configured
    ? archStatus.usedFallback
      ? 'warning'
      : 'success'
    : 'warning';

  const statusMessage = useMemo(() => {
    if (!archStatus) return null;
    if (!archStatus.configured) {
      return archStatus.error ?? t('arch_settings.status_setup_hint');
    }
    if (archStatus.usedFallback && requestedSourceLabel) {
      return t('arch_settings.status_fallback_message', {
        requestedSource: requestedSourceLabel,
        source: effectiveSourceLabel,
      });
    }
    return t('arch_settings.status_ready_message', {
      source: effectiveSourceLabel,
    });
  }, [archStatus, effectiveSourceLabel, requestedSourceLabel, t]);

  const canSave = useMemo(() => {
    if (credentialSource === 'model_hub') {
      return Boolean(selectedTenantModelId);
    }
    if (credentialSource === 'direct_api_key') {
      return Boolean(formState.apiKey || config?.hasApiKey);
    }
    return true;
  }, [config?.hasApiKey, credentialSource, formState.apiKey, selectedTenantModelId]);

  const saveDisabledMessage = useMemo(() => {
    if (credentialSource === 'model_hub' && !selectedTenantModelId) {
      return t('arch_settings.select_tenant_model_required');
    }
    if (credentialSource === 'direct_api_key' && !formState.apiKey && !config?.hasApiKey) {
      return t('arch_settings.direct_api_key_required');
    }
    return null;
  }, [config?.hasApiKey, credentialSource, formState.apiKey, selectedTenantModelId, t]);

  if (isLoading && !config) {
    return (
      <div className="h-full overflow-y-auto bg-noise">
        <div className="max-w-3xl mx-auto px-6 py-8">
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-5 h-5 text-muted animate-spin" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-noise">
      {/* Full-width header */}
      <div className="flex-shrink-0 border-b border-border/50 px-6 pt-6 pb-0">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-foreground">{t('arch_settings.title')}</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">{t('arch_settings.description')}</p>
          </div>
          <div className="w-10 h-10 rounded-xl bg-purple-subtle flex items-center justify-center">
            <Sparkles className="w-5 h-5 text-purple" />
          </div>
        </div>

        {/* Tab navigation — full width */}
        <div className="mt-4 flex gap-1">
          <button
            onClick={() => setActiveTab('settings')}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-default ${
              activeTab === 'settings'
                ? 'border-foreground text-foreground'
                : 'border-transparent text-foreground-muted hover:text-foreground'
            }`}
          >
            Settings
          </button>
          <button
            onClick={() => setActiveTab('audit-logs')}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-default ${
              activeTab === 'audit-logs'
                ? 'border-foreground text-foreground'
                : 'border-transparent text-foreground-muted hover:text-foreground'
            }`}
          >
            Audit Logs
          </button>
        </div>
      </div>

      {/* Tab content: Audit Logs — full width, fills remaining height */}
      {activeTab === 'audit-logs' && (
        <div className="flex-1 min-h-0">
          <SessionInspector />
        </div>
      )}

      {/* Tab content: Settings — narrow centered column with padding */}
      {activeTab === 'settings' && (
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-6 py-6">
            {/* Error banner */}
            {error && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-error-subtle border border-error/20 text-sm text-error">
                <AlertCircle className="w-4 h-4 shrink-0" />
                {error}
              </div>
            )}

            {archStatus && statusMessage && (
              <section
                className={clsx(
                  'mt-4 rounded-xl border p-4',
                  statusCardTone === 'success' &&
                    'border-success/20 bg-success-subtle text-success',
                  statusCardTone === 'warning' &&
                    'border-warning/20 bg-warning-subtle text-warning',
                )}
              >
                <div className="flex items-start gap-3">
                  {archStatus.configured ? (
                    <Check className="mt-0.5 h-4 w-4 shrink-0" />
                  ) : (
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  )}
                  <div className="space-y-1">
                    <p className="text-xs font-medium uppercase tracking-[0.12em] opacity-80">
                      {t('arch_settings.status_current_source')}
                    </p>
                    <p className="text-sm font-medium">{statusMessage}</p>
                    {archStatus.provider && archStatus.model && (
                      <p className="text-xs opacity-80">
                        {t('arch_settings.status_model_line', {
                          provider: providerLabel(archStatus.provider),
                          model: archStatus.model,
                        })}
                      </p>
                    )}
                  </div>
                </div>
              </section>
            )}

            {/* ─── Credential Source ─── */}
            <section className="mt-8">
              <h2 className="text-lg font-semibold text-foreground">
                {t('arch_settings.credential_source_title')}
              </h2>
              <p className="text-sm text-muted mt-1">
                {t('arch_settings.credential_source_description')}
              </p>

              <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
                {/* Platform Credits card */}
                <button
                  type="button"
                  onClick={() => setCredentialSource('platform')}
                  className={clsx(
                    'flex flex-col items-start gap-2 p-4 rounded-lg border-2 text-left transition-default',
                    credentialSource === 'platform'
                      ? 'border-accent bg-accent/5'
                      : 'border-default bg-background-elevated hover:border-accent/30',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Zap
                      className={clsx(
                        'w-4 h-4',
                        credentialSource === 'platform' ? 'text-accent' : 'text-muted',
                      )}
                    />
                    <span className="text-sm font-medium text-foreground">
                      {t('arch_settings.source_platform')}
                    </span>
                  </div>
                  <p className="text-xs text-muted">{t('arch_settings.source_platform_desc')}</p>
                </button>

                {/* Direct API key card */}
                <button
                  type="button"
                  onClick={() => setCredentialSource('direct_api_key')}
                  className={clsx(
                    'flex flex-col items-start gap-2 p-4 rounded-lg border-2 text-left transition-default',
                    credentialSource === 'direct_api_key'
                      ? 'border-accent bg-accent/5'
                      : 'border-default bg-background-elevated hover:border-accent/30',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <ShieldCheck
                      className={clsx(
                        'w-4 h-4',
                        credentialSource === 'direct_api_key' ? 'text-accent' : 'text-muted',
                      )}
                    />
                    <span className="text-sm font-medium text-foreground">
                      {t('arch_settings.source_direct_api_key')}
                    </span>
                  </div>
                  <p className="text-xs text-muted">
                    {t('arch_settings.source_direct_api_key_desc')}
                  </p>
                </button>

                {/* Model Hub card */}
                <button
                  type="button"
                  onClick={() => setCredentialSource('model_hub')}
                  className={clsx(
                    'flex flex-col items-start gap-2 p-4 rounded-lg border-2 text-left transition-default',
                    credentialSource === 'model_hub'
                      ? 'border-accent bg-accent/5'
                      : 'border-default bg-background-elevated hover:border-accent/30',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Link2
                      className={clsx(
                        'w-4 h-4',
                        credentialSource === 'model_hub' ? 'text-accent' : 'text-muted',
                      )}
                    />
                    <span className="text-sm font-medium text-foreground">
                      {t('arch_settings.source_model_hub')}
                    </span>
                  </div>
                  <p className="text-xs text-muted">{t('arch_settings.source_model_hub_desc')}</p>
                </button>
              </div>
            </section>

            {/* ─── Model Guidance ─── */}
            <div className="mt-4 p-3 rounded-lg bg-background-muted text-xs text-muted">
              {t('arch_settings.model_guidance')}
            </div>

            {/* ─── Platform Credits Mode ─── */}
            {credentialSource !== 'model_hub' && (
              <>
                {/* Provider Selection */}
                <section className="mt-6">
                  <h2 className="text-lg font-semibold text-foreground">
                    {t('arch_settings.provider_title')}
                  </h2>
                  <p className="text-sm text-muted mt-1">
                    {t('arch_settings.provider_description')}
                  </p>
                  <div className="mt-4">
                    <ProviderSelect
                      providers={providers}
                      value={formState.provider}
                      onChange={handleProviderChange}
                      size="lg"
                    />
                  </div>
                </section>

                {/* Model Selection */}
                <section className="mt-6">
                  <h2 className="text-lg font-semibold text-foreground">
                    {t('arch_settings.model_title')}
                  </h2>
                  <p className="text-sm text-muted mt-1">{t('arch_settings.model_description')}</p>
                  <div className="mt-4">
                    <Select
                      options={[
                        ...providerModels
                          .filter((m) => m.recommended)
                          .map((m) => ({
                            value: m.modelId,
                            label: `${m.displayName} · ${formatContextWindow(m.contextWindow)} ctx${m.supportsTools ? ' · Tools' : ''} (Recommended)`,
                          })),
                        ...providerModels
                          .filter((m) => !m.recommended)
                          .map((m) => ({
                            value: m.modelId,
                            label: `${m.displayName} · ${formatContextWindow(m.contextWindow)} ctx${m.supportsTools ? ' · Tools' : ''}`,
                          })),
                      ]}
                      value={formState.modelId}
                      onChange={handleModelChange}
                      placeholder={
                        providerModels.length === 0
                          ? t('arch_settings.no_models_for_provider')
                          : undefined
                      }
                    />

                    {/* Model info badge */}
                    {selectedModel && (
                      <div className="flex items-center gap-3 mt-2 text-xs text-muted">
                        <span>{formatContextWindow(selectedModel.contextWindow)} context</span>
                        {selectedModel.maxOutputTokens && (
                          <span>
                            {formatContextWindow(selectedModel.maxOutputTokens)} max output
                          </span>
                        )}
                        {selectedModel.supportsTools && (
                          <span className="inline-flex items-center gap-0.5 text-accent">
                            <Zap className="w-3 h-3" /> Tools
                          </span>
                        )}
                        <span className="capitalize">{selectedModel.tier}</span>
                        {selectedModel.recommended && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-success-subtle text-success text-xs font-medium">
                            <Check className="w-2.5 h-2.5" />
                            {t('arch_settings.model_recommended')}
                          </span>
                        )}
                      </div>
                    )}

                    {/* Model suitability warning */}
                    {selectedModel && platformModelWarnings.length > 0 && (
                      <div className="mt-3 flex items-start gap-2 p-3 rounded-lg bg-warning-subtle border border-warning/20 text-sm text-warning">
                        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                        <div className="space-y-1">
                          {platformModelWarnings.map((key) => (
                            <p key={key}>{t(`arch_settings.${key}`)}</p>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Recommended model confirmation */}
                    {selectedModel?.recommended && platformModelWarnings.length === 0 && (
                      <p className="mt-2 text-xs text-success">
                        {t('arch_settings.model_suitable')}
                      </p>
                    )}
                  </div>
                </section>

                {/* API Key Section */}
                {credentialSource === 'direct_api_key' && (
                  <section className="mt-6">
                    <h2 className="text-lg font-semibold text-foreground">
                      {t('arch_settings.api_key_title')}
                    </h2>
                    <p className="text-sm text-muted mt-1">
                      {t('arch_settings.api_key_description')}
                    </p>
                    <div className="mt-4 space-y-3">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-muted">
                          {t('arch_settings.api_key_status')}
                        </span>
                        {config?.hasApiKey ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-success-subtle text-success">
                            <Check className="w-3 h-3" />
                            {t('arch_settings.api_key_configured')}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-error-subtle text-error">
                            <AlertCircle className="w-3 h-3" />
                            {t('arch_settings.api_key_not_set')}
                          </span>
                        )}
                        {config?.lastValidatedAt && (
                          <span className="text-xs text-muted">
                            ·{' '}
                            {t('arch_settings.validated_ago', {
                              time: formatRelativeTime(config.lastValidatedAt),
                            })}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="relative flex-1">
                          <input
                            type={showApiKey ? 'text' : 'password'}
                            value={formState.apiKey}
                            onChange={(e) => updateField('apiKey', e.target.value)}
                            placeholder={
                              config?.hasApiKey
                                ? t('arch_settings.api_key_replace_placeholder')
                                : t('arch_settings.api_key_placeholder')
                            }
                            className="w-full rounded-lg border border-default bg-background-subtle text-foreground transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus text-sm py-2.5 pl-3 pr-10"
                          />
                          <button
                            type="button"
                            onClick={() => setShowApiKey(!showApiKey)}
                            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-foreground transition-default"
                          >
                            {showApiKey ? (
                              <EyeOff className="w-4 h-4" />
                            ) : (
                              <Eye className="w-4 h-4" />
                            )}
                          </button>
                        </div>
                        <button
                          type="button"
                          onClick={handleValidateKey}
                          disabled={!formState.apiKey || isValidatingKey}
                          className={clsx(
                            'inline-flex items-center gap-1.5 px-3 py-2.5 rounded-lg text-sm font-medium border transition-default whitespace-nowrap',
                            !formState.apiKey || isValidatingKey
                              ? 'border-default bg-background-muted text-muted cursor-not-allowed'
                              : 'border-default bg-background-elevated text-foreground hover:border-accent/50 hover:bg-background-muted',
                          )}
                        >
                          {isValidatingKey ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <ShieldCheck className="w-4 h-4" />
                          )}
                          {t('arch_settings.test_key')}
                        </button>
                      </div>
                      {keyValidation && (
                        <div
                          className={clsx(
                            'flex items-center gap-2 p-2.5 rounded-lg text-sm',
                            keyValidation.valid === true && 'bg-success-subtle text-success',
                            keyValidation.valid === false && 'bg-error-subtle text-error',
                            keyValidation.valid === null && 'bg-warning-subtle text-warning',
                          )}
                        >
                          {keyValidation.valid === true && (
                            <ShieldCheck className="w-4 h-4 shrink-0" />
                          )}
                          {keyValidation.valid === false && (
                            <ShieldX className="w-4 h-4 shrink-0" />
                          )}
                          {keyValidation.valid === null && (
                            <ShieldQuestion className="w-4 h-4 shrink-0" />
                          )}
                          {keyValidation.message}
                        </div>
                      )}
                      <p className="text-xs text-muted">{t('arch_settings.api_key_help')}</p>
                    </div>
                  </section>
                )}
              </>
            )}

            {/* ─── Model Hub Mode ─── */}
            {credentialSource === 'model_hub' && (
              <section className="mt-6">
                <h2 className="text-lg font-semibold text-foreground">
                  {t('arch_settings.select_tenant_model')}
                </h2>
                <div className="mt-4">
                  {tenantModelsLoading ? (
                    <div className="flex items-center gap-2 p-4 rounded-lg border border-default bg-background-elevated text-sm text-muted">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      {t('arch_settings.loading_models')}
                    </div>
                  ) : tenantModels.length === 0 ? (
                    <div className="p-4 rounded-lg border border-default bg-background-elevated text-sm space-y-2">
                      <p className="font-medium text-foreground">
                        {t('arch_settings.no_tenant_models_title')}
                      </p>
                      <p className="text-muted">{t('arch_settings.no_tenant_models')}</p>
                      <a
                        href="/admin/models"
                        className="inline-flex items-center gap-1 text-xs text-info hover:underline"
                      >
                        {t('arch_settings.open_model_hub')} <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                  ) : (
                    <>
                      <Select
                        options={[
                          { value: '', label: `${t('arch_settings.select_tenant_model')}...` },
                          ...tenantModels.map((m) => ({
                            value: m.id,
                            label: formatModelOptionLabel(m),
                          })),
                        ]}
                        value={selectedTenantModelId ?? ''}
                        onChange={(v) => setSelectedTenantModelId(v || null)}
                      />

                      {/* Selected model info */}
                      {selectedTenantModel && (
                        <div className="flex items-center gap-3 mt-2 text-xs text-muted">
                          {selectedTenantModel.provider && (
                            <ProviderBadge provider={selectedTenantModel.provider} />
                          )}
                          {selectedTenantModel.modelId && (
                            <span>{selectedTenantModel.modelId}</span>
                          )}
                          {selectedTenantModel.supportsTools && (
                            <span className="inline-flex items-center gap-0.5 text-accent">
                              <Zap className="w-3 h-3" /> Tools
                            </span>
                          )}
                          <span className="capitalize">{selectedTenantModel.tier}</span>
                          {hubModelRecommended && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-success-subtle text-success text-xs font-medium">
                              <Check className="w-2.5 h-2.5" />
                              {t('arch_settings.model_recommended')}
                            </span>
                          )}
                        </div>
                      )}

                      {/* Model Hub suitability warning */}
                      {selectedTenantModel && hubModelWarnings.length > 0 && (
                        <div className="mt-3 flex items-start gap-2 p-3 rounded-lg bg-warning-subtle border border-warning/20 text-sm text-warning">
                          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                          <div className="space-y-1">
                            {hubModelWarnings.map((key) => (
                              <p key={key}>{t(`arch_settings.${key}`)}</p>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Recommended confirmation */}
                      {selectedTenantModel &&
                        hubModelRecommended &&
                        hubModelWarnings.length === 0 && (
                          <p className="mt-2 text-xs text-success">
                            {t('arch_settings.model_suitable')}
                          </p>
                        )}
                    </>
                  )}
                </div>
              </section>
            )}

            {/* ─── Parameters Section ─── */}
            <section className="mt-8">
              <h2 className="text-lg font-semibold text-foreground">
                {t('arch_settings.parameters_title')}
              </h2>
              <p className="text-sm text-muted mt-1">{t('arch_settings.parameters_description')}</p>
              <div className="mt-4">
                {modelHyperParams.length > 0 ? (
                  <HyperParameterForm
                    parameters={modelHyperParams}
                    values={hyperValues}
                    onChange={handleHyperParamChange}
                  />
                ) : (
                  <div className="p-4 rounded-lg border border-default bg-background-elevated text-sm text-muted">
                    {t('arch_settings.no_configurable_parameters')}
                  </div>
                )}
              </div>
            </section>

            {/* ─── Save Button ─── */}
            <section className="mt-8 pb-8">
              <div className="flex items-center gap-3">
                <button
                  onClick={handleSave}
                  disabled={saveStatus === 'saving' || !canSave}
                  className={clsx(
                    'inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-default',
                    saveStatus === 'saving'
                      ? 'bg-accent/70 text-accent-foreground cursor-wait'
                      : !canSave
                        ? 'bg-background-muted text-muted cursor-not-allowed'
                        : saveStatus === 'saved'
                          ? 'bg-success text-success-foreground'
                          : 'bg-accent text-accent-foreground hover:opacity-90 btn-press',
                  )}
                >
                  {saveStatus === 'saving' && <Loader2 className="w-4 h-4 animate-spin" />}
                  {saveStatus === 'saved' && <Check className="w-4 h-4" />}
                  {saveStatus === 'saved'
                    ? t('arch_settings.saved')
                    : t('arch_settings.save_changes')}
                </button>
                {saveStatus === 'error' && (
                  <span className="text-sm text-error flex items-center gap-1">
                    <AlertCircle className="w-4 h-4" />
                    {t('arch_settings.save_failed')}
                  </span>
                )}
                {saveStatus !== 'error' && saveDisabledMessage && (
                  <span className="text-sm text-muted">{saveDisabledMessage}</span>
                )}
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
