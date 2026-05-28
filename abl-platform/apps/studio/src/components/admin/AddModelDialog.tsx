/**
 * AddModelDialog Component
 *
 * Two modes: browse from the global model catalog or enter a custom model manually.
 * Creates a TenantModel via the proxy API.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Search, ChevronLeft, ChevronRight } from 'lucide-react';
import { clsx } from 'clsx';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { getDefaultHyperParameterValues, HyperParameterForm } from './HyperParameterForm';
import type { HyperParameter, HyperParameterValue } from './HyperParameterForm';
import { apiFetch } from '../../lib/api-client';
import { toast } from 'sonner';
import { extractErrorMessage, sanitizeError } from '../../lib/sanitize-error';
import { getProviderIcon } from '../icons/ProviderIcons';
import { getModelCapabilitiesUrl } from '../../lib/model-capabilities-url';
import {
  MODEL_ROUTING_TIERS,
  type ModelRoutingTier,
} from '@agent-platform/shared-kernel/model-routing';

interface AddModelDialogProps {
  open: boolean;
  onClose: () => void;
  tenantId: string;
  onCreated: () => void;
}

interface CatalogModel {
  modelId: string;
  displayName: string;
  provider: string;
  tier?: string;
  temperature?: number;
  maxTokens?: number;
  rawCapabilities?: string[];
  capabilities?: {
    tools?: boolean;
    supportsTools?: boolean;
    vision?: boolean;
    supportsVision?: boolean;
    streaming?: boolean;
    supportsStreaming?: boolean;
    realtimeVoice?: boolean;
    supportsRealtimeVoice?: boolean;
  };
}

type Provider =
  | 'openai'
  | 'anthropic'
  | 'azure'
  | 'microsoft_foundry_anthropic'
  | 'google'
  | 'gemini'
  | 'google_vertex'
  | 'groq'
  | 'mistral'
  | 'openrouter'
  | 'fireworks'
  | 'togetherai'
  | 'perplexity'
  | 'deepseek'
  | 'xai'
  | 'bedrock'
  | 'cohere'
  | 'ultravox'
  | 'custom';

const PROVIDERS: { value: Provider; label: string }[] = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'azure', label: 'Azure OpenAI' },
  { value: 'microsoft_foundry_anthropic', label: 'Microsoft Foundry Anthropic' },
  { value: 'google', label: 'Google AI' },
  { value: 'google_vertex', label: 'Vertex AI' },
  { value: 'mistral', label: 'Mistral AI' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'groq', label: 'Groq' },
  { value: 'fireworks', label: 'Fireworks' },
  { value: 'togetherai', label: 'Together AI' },
  { value: 'perplexity', label: 'Perplexity' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'xai', label: 'xAI (Grok)' },
  { value: 'bedrock', label: 'AWS Bedrock' },
  { value: 'cohere', label: 'Cohere' },
  { value: 'ultravox', label: 'Ultravox' },
  { value: 'custom', label: 'Custom' },
];

const PROVIDER_BADGE_VARIANT: Record<
  string,
  'accent' | 'success' | 'info' | 'warning' | 'purple' | 'default'
> = {
  openai: 'accent',
  anthropic: 'purple',
  azure: 'info',
  microsoft_foundry_anthropic: 'info',
  google: 'warning',
  gemini: 'warning',
  google_vertex: 'warning',
  mistral: 'warning',
  openrouter: 'info',
  groq: 'success',
  fireworks: 'warning',
  togetherai: 'info',
  perplexity: 'accent',
  deepseek: 'success',
  xai: 'purple',
  bedrock: 'info',
  cohere: 'accent',
  ultravox: 'purple',
};

const MODEL_TIER_LABELS: Record<ModelRoutingTier, string> = {
  fast: 'Fast',
  balanced: 'Balanced',
  powerful: 'Powerful',
  voice: 'Voice',
  embedding: 'Embedding',
};

const MODEL_TIER_OPTIONS = MODEL_ROUTING_TIERS.map((value) => ({
  value,
  label: MODEL_TIER_LABELS[value],
}));

type CatalogConnectionAuthType = 'api_key' | 'azure_ad';

interface CatalogConnectionExtraField {
  key: string;
  label: string;
  placeholder?: string;
  optional?: boolean;
}

interface CatalogConnectionSetupState {
  credentialName: string;
  secret: string;
  endpoint: string;
  authType: CatalogConnectionAuthType;
  extra: Record<string, string>;
}

interface CatalogProviderConnectionSetup {
  provider: Provider;
  credentialNameLabel: string;
  secretLabel: string;
  endpointLabel: string;
  endpointPlaceholder: string;
  authModeLabel: string;
  authOptions: { value: CatalogConnectionAuthType; label: string }[];
  defaultAuthType: CatalogConnectionAuthType;
  extraFields?: CatalogConnectionExtraField[];
  getDefaultCredentialName: (model: CatalogModel) => string;
  buildAuthConfig: (state: CatalogConnectionSetupState) => Record<string, unknown> | undefined;
}

const CATALOG_PROVIDER_CONNECTION_SETUPS: Partial<
  Record<Provider, CatalogProviderConnectionSetup>
> = {
  microsoft_foundry_anthropic: {
    provider: 'microsoft_foundry_anthropic',
    credentialNameLabel: 'Credential Name',
    secretLabel: 'API Key or Bearer Token',
    endpointLabel: 'Foundry Endpoint',
    endpointPlaceholder: 'https://<resource>.services.ai.azure.com/anthropic',
    authModeLabel: 'Auth Mode',
    authOptions: [
      { value: 'api_key', label: 'API key' },
      { value: 'azure_ad', label: 'Microsoft Entra bearer token' },
    ],
    defaultAuthType: 'api_key',
    extraFields: [
      {
        key: 'anthropicVersion',
        label: 'Anthropic Version',
        placeholder: 'e.g. 2023-06-01',
        optional: true,
      },
    ],
    getDefaultCredentialName: (model) => `${model.displayName || model.modelId} Credential`,
    buildAuthConfig: (state) => ({
      apiFormat: 'anthropic_messages',
      ...(state.extra.anthropicVersion?.trim()
        ? { anthropicVersion: state.extra.anthropicVersion.trim() }
        : {}),
    }),
  },
};

function toModelRoutingTier(value: string | undefined): ModelRoutingTier | null {
  return value && (MODEL_ROUTING_TIERS as readonly string[]).includes(value)
    ? (value as ModelRoutingTier)
    : null;
}

function getCatalogProviderConnectionSetup(
  provider: string,
): CatalogProviderConnectionSetup | null {
  return CATALOG_PROVIDER_CONNECTION_SETUPS[provider as Provider] ?? null;
}

function createEmptyCatalogConnectionSetupState(
  authType: CatalogConnectionAuthType = 'api_key',
): CatalogConnectionSetupState {
  return {
    credentialName: '',
    secret: '',
    endpoint: '',
    authType,
    extra: {},
  };
}

function createCatalogConnectionSetupState(
  setup: CatalogProviderConnectionSetup,
  model: CatalogModel,
): CatalogConnectionSetupState {
  return {
    credentialName: setup.getDefaultCredentialName(model),
    secret: '',
    endpoint: '',
    authType: setup.defaultAuthType,
    extra: Object.fromEntries((setup.extraFields ?? []).map((field) => [field.key, ''])),
  };
}

function isCatalogConnectionSetupComplete(
  state: CatalogConnectionSetupState,
  setup: CatalogProviderConnectionSetup | null,
): boolean {
  if (!setup) return true;
  return Boolean(state.credentialName.trim() && state.secret.trim() && state.endpoint.trim());
}

function buildCatalogCredentialBody(
  state: CatalogConnectionSetupState,
  setup: CatalogProviderConnectionSetup,
): Record<string, unknown> {
  const authConfig = setup.buildAuthConfig(state);
  return {
    name: state.credentialName.trim(),
    provider: setup.provider,
    apiKey: state.secret.trim(),
    endpoint: state.endpoint.trim(),
    authType: state.authType,
    ...(authConfig ? { authConfig } : {}),
  };
}

// ── Provider cards for the catalog browse grid ──

interface ProviderCard {
  id: string;
  label: string;
  description: string;
  /** CSS classes for the icon container background and foreground */
  iconBg: string;
  iconText: string;
}

const PROVIDER_CARDS: ProviderCard[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'GPT-4o, GPT-4.1, o3, o4-mini',
    iconBg: 'bg-[hsl(160,45%,92%)]',
    iconText: 'text-[hsl(160,50%,25%)]',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    description: 'Claude Opus, Sonnet, Haiku',
    iconBg: 'bg-[hsl(30,50%,93%)]',
    iconText: 'text-[hsl(30,50%,30%)]',
  },
  {
    id: 'azure',
    label: 'Azure OpenAI',
    description: 'Azure-hosted OpenAI models',
    iconBg: 'bg-[hsl(207,80%,92%)]',
    iconText: 'text-[hsl(207,80%,35%)]',
  },
  {
    id: 'microsoft_foundry_anthropic',
    label: 'Microsoft Foundry Anthropic',
    description: 'Claude via Foundry Anthropic Messages',
    iconBg: 'bg-[hsl(200,72%,92%)]',
    iconText: 'text-[hsl(200,75%,32%)]',
  },
  {
    id: 'google',
    label: 'Google AI',
    description: 'Gemini 2.5 Pro, Flash',
    iconBg: 'bg-[hsl(45,70%,92%)]',
    iconText: 'text-[hsl(45,65%,28%)]',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    description: 'Gemini models via direct API',
    iconBg: 'bg-[hsl(250,60%,93%)]',
    iconText: 'text-[hsl(250,60%,45%)]',
  },
  {
    id: 'groq',
    label: 'Groq',
    description: 'Fast inference: Llama, Mixtral',
    iconBg: 'bg-[hsl(142,45%,92%)]',
    iconText: 'text-[hsl(142,50%,28%)]',
  },
  {
    id: 'cohere',
    label: 'Cohere',
    description: 'Command R+, Aya',
    iconBg: 'bg-[hsl(0,50%,94%)]',
    iconText: 'text-[hsl(0,55%,38%)]',
  },
  {
    id: 'mistral',
    label: 'Mistral AI',
    description: 'Mistral Large, Mixtral',
    iconBg: 'bg-[hsl(25,65%,92%)]',
    iconText: 'text-[hsl(25,70%,30%)]',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    description: 'Routed access to OpenAI-compatible models',
    iconBg: 'bg-[hsl(200,55%,92%)]',
    iconText: 'text-[hsl(200,60%,30%)]',
  },
  {
    id: 'fireworks',
    label: 'Fireworks',
    description: 'Fast inference: Llama, Mixtral, Qwen',
    iconBg: 'bg-[hsl(15,75%,92%)]',
    iconText: 'text-[hsl(15,80%,32%)]',
  },
  {
    id: 'togetherai',
    label: 'Together AI',
    description: 'Open models: Llama, Qwen, Mixtral',
    iconBg: 'bg-[hsl(195,60%,92%)]',
    iconText: 'text-[hsl(195,65%,32%)]',
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    description: 'Sonar with web search',
    iconBg: 'bg-[hsl(220,70%,92%)]',
    iconText: 'text-[hsl(220,75%,35%)]',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    description: 'DeepSeek Chat, Reasoner',
    iconBg: 'bg-[hsl(200,55%,92%)]',
    iconText: 'text-[hsl(200,60%,30%)]',
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    description: 'Grok models from xAI',
    iconBg: 'bg-[hsl(270,55%,92%)]',
    iconText: 'text-[hsl(270,60%,35%)]',
  },
  {
    id: 'bedrock',
    label: 'AWS Bedrock',
    description: 'Claude on AWS infrastructure',
    iconBg: 'bg-[hsl(30,70%,92%)]',
    iconText: 'text-[hsl(30,75%,30%)]',
  },
  {
    id: 'google_vertex',
    label: 'Vertex AI',
    description: 'Google Cloud Vertex models',
    iconBg: 'bg-[hsl(215,55%,93%)]',
    iconText: 'text-[hsl(215,60%,40%)]',
  },
  {
    id: 'ultravox',
    label: 'Ultravox',
    description: 'Realtime voice: Fixie AI Ultravox',
    iconBg: 'bg-[hsl(217,91%,95%)]',
    iconText: 'text-[hsl(217,91%,45%)]',
  },
];

export function AddModelDialog({ open, onClose, tenantId, onCreated }: AddModelDialogProps) {
  const t = useTranslations('admin');
  const [mode, setMode] = useState<'catalog' | 'custom'>('catalog');
  const [catalog, setCatalog] = useState<CatalogModel[]>([]);
  const [isLoadingCatalog, setIsLoadingCatalog] = useState(false);
  const [catalogSearch, setCatalogSearch] = useState('');
  const [selectedCatalog, setSelectedCatalog] = useState<CatalogModel | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);

  // Form fields
  const [formName, setFormName] = useState('');
  const [formModelId, setFormModelId] = useState('');
  const [formProvider, setFormProvider] = useState<Provider>('openai');
  const [formTier, setFormTier] = useState<ModelRoutingTier>('balanced');
  const [formEndpointUrl, setFormEndpointUrl] = useState('');
  const [formIsEmbedding, setFormIsEmbedding] = useState(false);
  const [formEmbeddingDimensions, setFormEmbeddingDimensions] = useState('1536');
  const [isCreating, setIsCreating] = useState(false);
  const [catalogConnectionSetupState, setCatalogConnectionSetupState] =
    useState<CatalogConnectionSetupState>(() => createEmptyCatalogConnectionSetupState());

  // Dynamic hyperparameters
  const [hyperParams, setHyperParams] = useState<HyperParameter[]>([]);
  const [hyperValues, setHyperValues] = useState<Record<string, HyperParameterValue>>({});
  const [isLoadingHyperParams, setIsLoadingHyperParams] = useState(false);

  const loadCatalog = useCallback(async () => {
    setIsLoadingCatalog(true);
    try {
      const res = await apiFetch('/api/model-catalog');
      if (!res.ok) throw new Error('Failed to load');
      const data = await res.json();
      setCatalog(data.models || data.catalog || []);
    } catch {
      toast.error(t('models_page.add_model.catalog_load_failed'));
    } finally {
      setIsLoadingCatalog(false);
    }
  }, []);

  useEffect(() => {
    if (open && mode === 'catalog' && catalog.length === 0) {
      loadCatalog();
    }
  }, [open, mode, catalog.length, loadCatalog]);

  const catalogConnectionSetup = useMemo(
    () => (mode === 'catalog' ? getCatalogProviderConnectionSetup(formProvider) : null),
    [formProvider, mode],
  );
  const isCatalogConnectionReady = isCatalogConnectionSetupComplete(
    catalogConnectionSetupState,
    catalogConnectionSetup,
  );

  const resetForm = () => {
    setFormName('');
    setFormModelId('');
    setFormProvider('openai');
    setFormTier('balanced');
    setFormEndpointUrl('');
    setSelectedCatalog(null);
    setSelectedProvider(null);
    setCatalogSearch('');
    setHyperParams([]);
    setHyperValues({});
    setCatalogConnectionSetupState(createEmptyCatalogConnectionSetupState());
  };

  const handleClose = () => {
    resetForm();
    setMode('catalog');
    onClose();
  };

  const handleSelectCatalog = (model: CatalogModel) => {
    setSelectedCatalog(model);
    setFormName(model.displayName || model.modelId);
    setFormModelId(model.modelId);
    setFormProvider((model.provider as Provider) || 'custom');
    const isVoice = model.capabilities?.realtimeVoice || model.capabilities?.supportsRealtimeVoice;
    setFormTier(isVoice ? 'voice' : (toModelRoutingTier(model.tier) ?? 'balanced'));
    const connectionSetup = getCatalogProviderConnectionSetup(model.provider);
    setCatalogConnectionSetupState(
      connectionSetup
        ? createCatalogConnectionSetupState(connectionSetup, model)
        : createEmptyCatalogConnectionSetupState(),
    );

    // Fetch hyperparameters for the selected model
    setIsLoadingHyperParams(true);
    setHyperParams([]);
    setHyperValues({});
    apiFetch(getModelCapabilitiesUrl(model.modelId))
      .then(async (res) => {
        if (!res.ok) return;
        const data = await res.json();
        if (data.hyperParameters?.length > 0) {
          setHyperParams(data.hyperParameters);
          setHyperValues(getDefaultHyperParameterValues(data.hyperParameters));
        }
        // Store raw capabilities array for embedding detection
        if (data.capabilities && Array.isArray(data.capabilities)) {
          setSelectedCatalog((prev) =>
            prev ? { ...prev, rawCapabilities: data.capabilities } : prev,
          );
        }
      })
      .catch((err: unknown) => {
        console.error('[AddModelDialog] Failed to load hyperparameters', err);
      })
      .finally(() => setIsLoadingHyperParams(false));
  };

  const handleCreate = async () => {
    if (!formName.trim() || !formModelId.trim()) return;
    if (!isCatalogConnectionReady) return;
    setIsCreating(true);
    try {
      // Derive capabilities array from catalog model capabilities
      const caps: string[] = ['text'];
      if (selectedCatalog?.capabilities) {
        const c = selectedCatalog.capabilities;
        if (c.tools || c.supportsTools) caps.push('tools');
        if (c.streaming || c.supportsStreaming) caps.push('streaming');
        if (c.vision || c.supportsVision) caps.push('vision');
        if (c.realtimeVoice || c.supportsRealtimeVoice) caps.push('realtime_voice');
      }

      // Detect embedding models:
      // 1. User selected tier "embedding" in the form
      // 2. From catalog: capabilities array includes 'textToEmbedding'
      // 3. From modelId pattern: contains 'embedding' or starts with 'embed-'
      const catalogCaps = selectedCatalog?.rawCapabilities;
      const isEmbeddingModel =
        formTier === 'embedding' ||
        catalogCaps?.includes('textToEmbedding') ||
        formModelId.includes('embedding') ||
        formModelId.startsWith('embed-');
      if (isEmbeddingModel) {
        caps.push('embedding');
      }

      const isRealtimeVoice = caps.includes('realtime_voice');

      // Extract generation parameters only when the catalog advertises them.
      const tempFromHyper =
        hyperParams.length > 0 ? (hyperValues['temperature'] as number | undefined) : undefined;
      const maxTokFromHyper =
        hyperParams.length > 0
          ? ((hyperValues['max_tokens'] as number | undefined) ??
            (hyperValues['max_completion_tokens'] as number | undefined) ??
            (hyperValues['maxTokens'] as number | undefined) ??
            (hyperValues['maxOutputTokens'] as number | undefined))
          : undefined;

      const body: Record<string, unknown> = {
        displayName: formName.trim(),
        modelId: formModelId.trim(),
        provider: formProvider,
        integrationType: mode === 'custom' && formEndpointUrl.trim() ? 'api' : 'easy',
        tier: isRealtimeVoice ? 'voice' : isEmbeddingModel ? 'embedding' : formTier,
        capabilities: caps,
        hyperParameters: Object.keys(hyperValues).length > 0 ? hyperValues : undefined,
        ...(tempFromHyper != null ? { temperature: tempFromHyper } : {}),
        ...(isEmbeddingModel
          ? { maxTokens: parseInt(formEmbeddingDimensions, 10) || 1024 }
          : maxTokFromHyper != null
            ? { maxTokens: maxTokFromHyper }
            : {}),
        ...(isEmbeddingModel
          ? { embeddingDimensions: parseInt(formEmbeddingDimensions, 10) || 1024 }
          : {}),
      };

      if (isRealtimeVoice) {
        body.realtimeConfig = {
          providerType:
            formProvider === 'openai'
              ? 'openai_realtime'
              : formProvider === 'google' ||
                  formProvider === 'gemini' ||
                  formProvider === 'google_vertex'
                ? 'gemini_live'
                : formProvider === 'ultravox'
                  ? 'ultravox'
                  : formProvider,
        };
      }
      if (formEndpointUrl.trim()) {
        body.endpointUrl = formEndpointUrl.trim();
      }

      const res = await apiFetch('/api/tenant-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(extractErrorMessage(err, 'Failed to create model'));
      }
      const createdModel = await res.json();
      const tenantModelId = createdModel.model?.id ?? createdModel.model?._id ?? createdModel.id;

      if (catalogConnectionSetup) {
        if (!tenantModelId || typeof tenantModelId !== 'string') {
          throw new Error('Model was created but no tenant model id was returned');
        }
        const credentialBody = buildCatalogCredentialBody(
          catalogConnectionSetupState,
          catalogConnectionSetup,
        );
        const credentialRes = await apiFetch('/api/tenant-credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(credentialBody),
        });
        if (!credentialRes.ok) {
          const err = await credentialRes.json().catch(() => ({}));
          throw new Error(extractErrorMessage(err, 'Failed to create credential'));
        }
        const credential = await credentialRes.json();
        const credentialId = credential.credential?.id ?? credential.id;
        if (!credentialId || typeof credentialId !== 'string') {
          throw new Error('Credential was created but no credential id was returned');
        }
        const connectionRes = await apiFetch(
          `/api/tenant-models/${tenantModelId}/connections?tenantId=${tenantId}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ credentialId, isPrimary: true }),
          },
        );
        if (!connectionRes.ok) {
          const err = await connectionRes.json().catch(() => ({}));
          throw new Error(extractErrorMessage(err, 'Failed to connect credential'));
        }
      }
      toast.success(t('models_page.add_model.added'));
      handleClose();
      onCreated();
    } catch (err) {
      toast.error(sanitizeError(err, t('models_page.add_model.add_failed')));
    } finally {
      setIsCreating(false);
    }
  };

  // Compute model counts per provider for the grid
  const providerModelCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const m of catalog) {
      const p = (m.provider || 'custom').toLowerCase();
      counts[p] = (counts[p] || 0) + 1;
    }
    return counts;
  }, [catalog]);

  // Filter models by selected provider + search
  const filteredCatalog = catalog.filter((m) => {
    if (selectedProvider && (m.provider || '').toLowerCase() !== selectedProvider.toLowerCase()) {
      return false;
    }
    if (!catalogSearch) return true;
    const q = catalogSearch.toLowerCase();
    return (m.displayName || '').toLowerCase().includes(q) || m.modelId.toLowerCase().includes(q);
  });

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title={t('models_page.add_model.title')}
      description={t('models_page.add_model.description')}
      maxWidth="lg"
    >
      <div className="space-y-4">
        {/* Mode toggle */}
        <div className="flex gap-1 p-0.5 rounded-lg bg-background-muted w-fit">
          <button
            onClick={() => {
              setMode('catalog');
              resetForm();
            }}
            className={`px-3 py-1.5 text-sm rounded-md transition-default ${
              mode === 'catalog'
                ? 'bg-background-elevated text-foreground shadow-sm font-medium'
                : 'text-muted hover:text-foreground'
            }`}
          >
            {t('models_page.add_model.browse_catalog')}
          </button>
          <button
            onClick={() => {
              setMode('custom');
              resetForm();
            }}
            className={`px-3 py-1.5 text-sm rounded-md transition-default ${
              mode === 'custom'
                ? 'bg-background-elevated text-foreground shadow-sm font-medium'
                : 'text-muted hover:text-foreground'
            }`}
          >
            {t('models_page.add_model.custom_model')}
          </button>
        </div>

        {/* Catalog browse mode */}
        {mode === 'catalog' && (
          <>
            {isLoadingCatalog ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-5 h-5 text-muted animate-spin" />
              </div>
            ) : !selectedProvider && !selectedCatalog ? (
              /* ── Step 1: Provider Grid ── */
              <div>
                <p className="text-sm text-muted mb-3">Choose a provider to browse models</p>
                <div className="grid grid-cols-2 gap-2.5">
                  {PROVIDER_CARDS.map((card) => {
                    const count = providerModelCounts[card.id] || 0;
                    if (count === 0) return null;
                    return (
                      <button
                        key={card.id}
                        onClick={() => {
                          setSelectedProvider(card.id);
                          setCatalogSearch('');
                        }}
                        className="flex items-center gap-3 p-3 rounded-lg border border-default bg-background-elevated text-left transition-default hover:border-accent hover:shadow-sm group"
                      >
                        <div
                          className={clsx(
                            'w-10 h-10 rounded-lg flex items-center justify-center shrink-0',
                            card.iconBg,
                            card.iconText,
                          )}
                        >
                          {(() => {
                            const Icon = getProviderIcon(card.id);
                            return <Icon className="w-5 h-5" />;
                          })()}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-medium text-foreground">
                              {card.label}
                            </span>
                            <ChevronRight className="w-3.5 h-3.5 text-muted group-hover:text-accent transition-default shrink-0" />
                          </div>
                          <p className="text-xs text-muted truncate">{card.description}</p>
                          <p className="text-xs text-muted mt-0.5">
                            {count} model{count !== 1 ? 's' : ''}
                          </p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : !selectedCatalog ? (
              /* ── Step 2: Model list for selected provider ── */
              <div>
                <button
                  onClick={() => {
                    setSelectedProvider(null);
                    setCatalogSearch('');
                  }}
                  className="flex items-center gap-1 text-sm text-muted hover:text-foreground transition-default mb-3"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                  <span>All providers</span>
                </button>

                <div className="flex items-center gap-2 mb-3">
                  {(() => {
                    const card = PROVIDER_CARDS.find((c) => c.id === selectedProvider);
                    const Icon = getProviderIcon(selectedProvider || 'custom');
                    return card ? (
                      <div
                        className={clsx(
                          'w-7 h-7 rounded-md flex items-center justify-center shrink-0',
                          card.iconBg,
                          card.iconText,
                        )}
                      >
                        <Icon className="w-4 h-4" />
                      </div>
                    ) : null;
                  })()}
                  <span className="text-sm font-semibold text-foreground">
                    {PROVIDER_CARDS.find((c) => c.id === selectedProvider)?.label ||
                      selectedProvider}
                  </span>
                  <span className="text-xs text-muted">
                    {filteredCatalog.length} model{filteredCatalog.length !== 1 ? 's' : ''}
                  </span>
                </div>

                <div className="relative mb-3">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
                  <input
                    type="text"
                    placeholder={t('models_page.add_model.catalog_search_placeholder')}
                    value={catalogSearch}
                    onChange={(e) => setCatalogSearch(e.target.value)}
                    className="w-full rounded-lg border border-default bg-background-subtle text-foreground text-sm py-2 pl-9 pr-3 focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
                  />
                </div>

                {filteredCatalog.length === 0 ? (
                  <div className="py-6 text-center text-muted text-sm">
                    {catalogSearch
                      ? t('models_page.add_model.no_catalog_search')
                      : t('models_page.add_model.no_catalog')}
                  </div>
                ) : (
                  <div className="max-h-[260px] overflow-y-auto space-y-1 border border-default rounded-lg p-1.5">
                    {filteredCatalog.map((m) => (
                      <button
                        key={m.modelId}
                        onClick={() => handleSelectCatalog(m)}
                        className="w-full text-left p-2.5 rounded-md transition-default hover:bg-background-muted border border-transparent group"
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-foreground flex-1 truncate">
                            {m.displayName || m.modelId}
                          </span>
                          {(m.capabilities?.tools || m.capabilities?.supportsTools) && (
                            <Badge variant="info">Tools</Badge>
                          )}
                          {(m.capabilities?.vision || m.capabilities?.supportsVision) && (
                            <Badge variant="info">Vision</Badge>
                          )}
                          {(m.capabilities?.realtimeVoice ||
                            m.capabilities?.supportsRealtimeVoice) && (
                            <Badge variant="success">Voice</Badge>
                          )}
                          <ChevronRight className="w-3.5 h-3.5 text-muted group-hover:text-accent transition-default shrink-0" />
                        </div>
                        <p className="text-xs text-muted mt-0.5 font-mono truncate">{m.modelId}</p>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              /* ── Step 3: Configure selected model ── */
              <div className="space-y-4">
                <button
                  onClick={() => {
                    setSelectedCatalog(null);
                    setHyperParams([]);
                    setHyperValues({});
                  }}
                  className="flex items-center gap-1 text-sm text-muted hover:text-foreground transition-default"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                  <span>Back to models</span>
                </button>

                <div className="flex items-center gap-2">
                  <Badge variant={PROVIDER_BADGE_VARIANT[selectedCatalog.provider] || 'default'}>
                    {selectedCatalog.provider}
                  </Badge>
                  <span className="text-sm font-medium text-foreground">
                    {selectedCatalog.displayName || selectedCatalog.modelId}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <Input
                    label={t('models_page.add_model.display_name_label')}
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                  />
                  <Input
                    label={t('models_page.add_model.model_id_label')}
                    value={formModelId}
                    disabled
                  />
                </div>
                <div className="w-40">
                  <Select
                    label={t('models_page.add_model.tier_label')}
                    options={MODEL_TIER_OPTIONS}
                    value={formTier}
                    onChange={(v) => setFormTier(v as ModelRoutingTier)}
                  />
                </div>

                {/* Dynamic Hyperparameters */}
                {isLoadingHyperParams ? (
                  <div className="flex items-center justify-center py-3">
                    <Loader2 className="w-4 h-4 text-muted animate-spin" />
                  </div>
                ) : hyperParams.length > 0 ? (
                  <HyperParameterForm
                    parameters={hyperParams}
                    values={hyperValues}
                    onChange={(name, value) =>
                      setHyperValues((prev) => ({ ...prev, [name]: value }))
                    }
                    compact
                  />
                ) : null}

                {catalogConnectionSetup && (
                  <div className="grid grid-cols-2 gap-4">
                    <Input
                      label={catalogConnectionSetup.credentialNameLabel}
                      value={catalogConnectionSetupState.credentialName}
                      onChange={(e) =>
                        setCatalogConnectionSetupState((prev) => ({
                          ...prev,
                          credentialName: e.target.value,
                        }))
                      }
                      required
                    />
                    <Select
                      label={catalogConnectionSetup.authModeLabel}
                      options={catalogConnectionSetup.authOptions}
                      value={catalogConnectionSetupState.authType}
                      onChange={(v) =>
                        setCatalogConnectionSetupState((prev) => ({
                          ...prev,
                          authType: v as CatalogConnectionAuthType,
                        }))
                      }
                    />
                    <Input
                      label={catalogConnectionSetup.secretLabel}
                      type="password"
                      autoComplete="off"
                      value={catalogConnectionSetupState.secret}
                      onChange={(e) =>
                        setCatalogConnectionSetupState((prev) => ({
                          ...prev,
                          secret: e.target.value,
                        }))
                      }
                      required
                    />
                    <Input
                      label={catalogConnectionSetup.endpointLabel}
                      placeholder={catalogConnectionSetup.endpointPlaceholder}
                      value={catalogConnectionSetupState.endpoint}
                      onChange={(e) =>
                        setCatalogConnectionSetupState((prev) => ({
                          ...prev,
                          endpoint: e.target.value,
                        }))
                      }
                      required
                    />
                    {catalogConnectionSetup.extraFields?.map((field) => (
                      <Input
                        key={field.key}
                        label={field.label}
                        placeholder={field.placeholder}
                        value={catalogConnectionSetupState.extra[field.key] ?? ''}
                        onChange={(e) =>
                          setCatalogConnectionSetupState((prev) => ({
                            ...prev,
                            extra: { ...prev.extra, [field.key]: e.target.value },
                          }))
                        }
                        optional={field.optional}
                        required={!field.optional}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* Custom model mode */}
        {mode === 'custom' && (
          <div className="space-y-4">
            <Input
              label={t('models_page.add_model.display_name_label')}
              placeholder={t('models_page.add_model.display_name_placeholder')}
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
            />

            <Input
              label={t('models_page.add_model.model_id_label')}
              placeholder={t('models_page.add_model.model_id_placeholder')}
              value={formModelId}
              onChange={(e) => setFormModelId(e.target.value)}
            />

            <div className="grid grid-cols-2 gap-4">
              <Select
                label={t('models_page.add_model.provider_label')}
                options={PROVIDERS}
                value={formProvider}
                onChange={(v) => setFormProvider(v as Provider)}
              />
              <Select
                label={t('models_page.add_model.tier_label')}
                options={MODEL_TIER_OPTIONS}
                value={formTier}
                onChange={(v) => setFormTier(v as ModelRoutingTier)}
              />
            </div>

            <Input
              label={t('models_page.add_model.endpoint_url_label')}
              placeholder={t('models_page.add_model.endpoint_url_placeholder')}
              value={formEndpointUrl}
              onChange={(e) => setFormEndpointUrl(e.target.value)}
            />

            {/* Embedding dimensions — shown when tier is "embedding" */}
            {formTier === 'embedding' && (
              <div className="rounded-lg border border-default p-3 space-y-2">
                <Input
                  label="Embedding Dimensions"
                  type="number"
                  placeholder="1536"
                  value={formEmbeddingDimensions}
                  onChange={(e) => setFormEmbeddingDimensions(e.target.value)}
                  min="64"
                  max="4096"
                />
                <p className="text-xs text-muted">
                  This model will appear in the embedding dropdown for knowledge bases.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Actions — shown when model is selected (catalog step 3) or custom mode */}
        {(mode === 'custom' || selectedCatalog) && (
          <div className="flex gap-3 pt-2">
            <Button variant="secondary" onClick={handleClose} className="flex-1">
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleCreate}
              loading={isCreating}
              disabled={!formName.trim() || !formModelId.trim() || !isCatalogConnectionReady}
              className="flex-1"
            >
              {t('models_page.add_model.add_to_workspace')}
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
