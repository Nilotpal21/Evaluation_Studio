/**
 * ModelsPage Component
 *
 * Unified model management: credentials, model catalog with expandable rows,
 * inline connections wiring, settings editing, and model catalog browse.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import {
  Brain,
  Plus,
  Key,
  Loader2,
  Shield,
  Trash2,
  Power,
  PowerOff,
  ChevronRight,
  ChevronDown,
  Search,
  Link2,
  CheckCircle2,
  Settings2,
  AlertTriangle,
  Star,
  Info,
  Layers,
  LayoutList,
} from 'lucide-react';
import { clsx } from 'clsx';
import { areLlmProvidersPolicyEquivalent } from '@agent-platform/shared-kernel/llm-provider-identity';
import { Tooltip, TooltipProvider } from '../ui/Tooltip';
import { apiFetch } from '../../lib/api-client';
import { sanitizeServerError } from '../../lib/sanitize-error';
import { useAuthStore } from '../../store/auth-store';
import { PageHeader } from '../ui/PageHeader';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { Input } from '../ui/Input';
import { Badge } from '../ui/Badge';
import { Tabs } from '../ui/Tabs';
import { EmptyState } from '../ui/EmptyState';
import { Dialog } from '../ui/Dialog';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { AddConnectionDialog } from './AddConnectionDialog';
import { AddModelDialog } from './AddModelDialog';
import { LLMPolicySection } from './LLMPolicySection';
import { getDefaultHyperParameterValues, HyperParameterForm } from './HyperParameterForm';
import type { HyperParameter, HyperParameterValue } from './HyperParameterForm';
import { toast } from 'sonner';
import { Select } from '../ui/Select';
import { RadioGroup } from '../ui/RadioGroup';
import { ProviderSelect } from '../ui/ProviderSelect';
import { getModelCapabilitiesUrl } from '../../lib/model-capabilities-url';

// Sentinel value for IAM role (ambient) mode — must match BEDROCK_AMBIENT_SENTINEL in packages/llm
const BEDROCK_AMBIENT_SENTINEL = '__iam_role__' as const;
const BEDROCK_BLOCKED_CUSTOM_HEADER_NAMES = new Set(['authorization', 'x-api-key']);

// =============================================================================
// TYPES
// =============================================================================

type Provider =
  | 'openai'
  | 'anthropic'
  | 'azure'
  | 'microsoft_foundry_anthropic'
  | 'google'
  | 'groq'
  | 'ultravox'
  | 'mistral'
  | 'openrouter'
  | 'fireworks'
  | 'togetherai'
  | 'perplexity'
  | 'deepseek'
  | 'xai'
  | 'bedrock'
  | 'cohere'
  | 'custom';

interface Credential {
  id: string;
  name: string;
  provider: Provider;
  status: 'active' | 'inactive' | 'error';
  endpoint?: string;
  createdAt: string;
}

interface TenantModelItem {
  id: string;
  displayName: string;
  integrationType: 'easy' | 'api';
  modelId: string | null;
  provider: string | null;
  endpointUrl: string | null;
  tier: 'fast' | 'balanced' | 'powerful' | 'voice';
  temperature: number;
  maxTokens: number;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsStreaming: boolean;
  useResponsesApi?: boolean | null;
  useStreaming?: boolean | null;
  hyperParameters?: Record<string, unknown>;
  isDefault: boolean;
  isActive: boolean;
  inferenceEnabled: boolean;
  capabilities?: string[];
  realtimeConfig?: Record<string, unknown> | null;
  _count?: { connections: number; projectBindings: number };
}

interface ModelConnection {
  id: string;
  connectionName: string;
  credentialId?: string;
  authType: string;
  isPrimary: boolean;
  isActive: boolean;
  lastValidatedAt?: string;
  validationStatus?: 'valid' | 'invalid' | 'unknown';
  lastHealthCheck?: string | null;
  healthStatus?: 'healthy' | 'unhealthy' | 'unknown' | 'unchecked';
  healthMessage?: string | null;
  createdAt: string;
}

interface ImpactedProject {
  projectId: string;
  projectName: string;
  tier: string;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const TABS = [
  { id: 'credentials', label: 'Credentials', icon: <Key className="w-3.5 h-3.5" /> },
  { id: 'models', label: 'Model Catalog', icon: <Brain className="w-3.5 h-3.5" /> },
  { id: 'policy', label: 'Policy', icon: <Shield className="w-3.5 h-3.5" /> },
];

const PROVIDERS: { value: Provider; label: string }[] = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'azure', label: 'Azure OpenAI' },
  { value: 'microsoft_foundry_anthropic', label: 'Microsoft Foundry Anthropic' },
  { value: 'google', label: 'Google AI' },
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
  Provider,
  'accent' | 'success' | 'info' | 'warning' | 'purple' | 'default'
> = {
  openai: 'accent',
  anthropic: 'purple',
  azure: 'info',
  microsoft_foundry_anthropic: 'info',
  google: 'warning',
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
  custom: 'default',
};

const PROVIDER_LABEL: Record<Provider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  azure: 'Azure',
  microsoft_foundry_anthropic: 'Microsoft Foundry',
  google: 'Google',
  mistral: 'Mistral',
  openrouter: 'OpenRouter',
  groq: 'Groq',
  fireworks: 'Fireworks',
  togetherai: 'Together AI',
  perplexity: 'Perplexity',
  deepseek: 'DeepSeek',
  xai: 'xAI',
  bedrock: 'Bedrock',
  cohere: 'Cohere',
  ultravox: 'Ultravox',
  custom: 'Custom',
};

const STATUS_VARIANT: Record<string, 'success' | 'error' | 'default'> = {
  active: 'success',
  inactive: 'default',
  error: 'error',
};

const TIER_VARIANT: Record<string, 'info' | 'warning' | 'success' | 'purple'> = {
  fast: 'info',
  balanced: 'warning',
  powerful: 'success',
  voice: 'purple',
};

const HEALTH_DOT_COLOR: Record<string, string> = {
  healthy: 'bg-success',
  unhealthy: 'bg-error',
  unknown: 'bg-warning',
  unchecked: 'bg-foreground/20',
};

function formatRelativeTime(dateStr: string | null | undefined): string {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

const TIER_ORDER = ['fast', 'balanced', 'powerful', 'voice'] as const;
const PRIMARY_DEFAULT_TIER_ORDER = ['balanced', 'powerful', 'fast', 'voice'] as const;
const TIER_INFO: Record<string, { label: string; description: string; operations: string[] }> = {
  fast: {
    label: 'Fast Tier',
    description: 'Quick, cost-effective operations',
    operations: ['extraction', 'validation', 'tool_selection'],
  },
  balanced: {
    label: 'Balanced Tier',
    description: 'Default for most operations',
    operations: ['response_gen', 'summarization'],
  },
  powerful: {
    label: 'Powerful Tier',
    description: 'Complex reasoning tasks',
    operations: ['reasoning', 'coordination'],
  },
  voice: {
    label: 'Voice Tier',
    description: 'Realtime voice interactions',
    operations: ['realtime_voice'],
  },
};

function getPrimaryDefaultTierRank(tier: string | null | undefined): number {
  const rank = PRIMARY_DEFAULT_TIER_ORDER.indexOf(
    tier as (typeof PRIMARY_DEFAULT_TIER_ORDER)[number],
  );
  return rank === -1 ? PRIMARY_DEFAULT_TIER_ORDER.length : rank;
}

function pickPrimaryDefaultModel<T extends { isDefault: boolean; tier?: string | null }>(
  modelList: T[],
): T | null {
  return (
    modelList.reduce<T | null>((selected, candidate) => {
      if (!candidate.isDefault) return selected;
      if (!selected) return candidate;
      return getPrimaryDefaultTierRank(candidate.tier) < getPrimaryDefaultTierRank(selected.tier)
        ? candidate
        : selected;
    }, null) ?? null
  );
}

function parseBedrockCustomHeaders(raw: string): Record<string, string> | null {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string' || BEDROCK_BLOCKED_CUSTOM_HEADER_NAMES.has(key.toLowerCase())) {
      return null;
    }
    headers[key] = value;
  }
  return headers;
}

// =============================================================================
// CREDENTIALS TAB (kept from original)
// =============================================================================

function CredentialsTab() {
  const t = useTranslations('admin');
  const tenantId = useAuthStore((s) => s.tenantId);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [models, setModels] = useState<TenantModelItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Credential | null>(null);
  const [deleteImpact, setDeleteImpact] = useState<
    { modelId: string; displayName: string; provider: string | null }[]
  >([]);
  const [isDeleting, setIsDeleting] = useState(false);
  const [groupByProvider, setGroupByProvider] = useState(true);

  const [formName, setFormName] = useState('');
  const [formProvider, setFormProvider] = useState<Provider>('openai');
  const [formApiKey, setFormApiKey] = useState('');
  const [formEndpoint, setFormEndpoint] = useState('');
  const [formCustomHeaders, setFormCustomHeaders] = useState('');
  // Azure-specific
  const [formResourceName, setFormResourceName] = useState('');
  const [formApiVersion, setFormApiVersion] = useState('');
  const [formDeploymentId, setFormDeploymentId] = useState('');
  // Microsoft Foundry Anthropic-specific
  const [formFoundryAuthType, setFormFoundryAuthType] = useState<'api_key' | 'azure_ad'>('api_key');
  const [formFoundryAnthropicVersion, setFormFoundryAnthropicVersion] = useState('');
  // Custom provider-specific
  const [formCustomApiFormat, setFormCustomApiFormat] = useState<
    'openai_compatible' | 'anthropic_messages'
  >('openai_compatible');
  // Bedrock-specific
  const [formBedrockMode, setFormBedrockMode] = useState<'explicit' | 'iam_role'>('iam_role');
  const [formAwsRegion, setFormAwsRegion] = useState('us-east-1');
  const [formAwsAccessKeyId, setFormAwsAccessKeyId] = useState('');
  const [formAwsSecretKey, setFormAwsSecretKey] = useState('');
  const [formAwsSessionToken, setFormAwsSessionToken] = useState('');
  const [formAwsRoleArn, setFormAwsRoleArn] = useState('');
  const [formAwsStsEndpoint, setFormAwsStsEndpoint] = useState('');
  const [formAwsResourceArn, setFormAwsResourceArn] = useState('');
  const [formAwsEndpoint, setFormAwsEndpoint] = useState('');
  const [formAwsCustomHeaders, setFormAwsCustomHeaders] = useState('');

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const [credRes, modelRes] = await Promise.all([
        apiFetch('/api/tenant-credentials'),
        tenantId ? apiFetch(`/api/tenant-models?tenantId=${tenantId}`) : Promise.resolve(null),
      ]);
      if (!credRes.ok) throw new Error('Failed to load');
      const credData = await credRes.json();
      setCredentials(credData.credentials || []);
      if (modelRes?.ok) {
        const modelData = await modelRes.json();
        setModels(modelData.models || []);
      }
    } catch {
      toast.error('Failed to load credentials');
    } finally {
      setIsLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    load();
  }, [load]);

  const resetForm = () => {
    setFormName('');
    setFormProvider('openai');
    setFormApiKey('');
    setFormEndpoint('');
    setFormCustomHeaders('');
    setFormResourceName('');
    setFormApiVersion('');
    setFormDeploymentId('');
    setFormFoundryAuthType('api_key');
    setFormFoundryAnthropicVersion('');
    setFormCustomApiFormat('openai_compatible');
    setFormBedrockMode('iam_role');
    setFormAwsRegion('us-east-1');
    setFormAwsAccessKeyId('');
    setFormAwsSecretKey('');
    setFormAwsSessionToken('');
    setFormAwsRoleArn('');
    setFormAwsStsEndpoint('');
    setFormAwsResourceArn('');
    setFormAwsEndpoint('');
    setFormAwsCustomHeaders('');
  };

  const handleCreate = async () => {
    const isBedrock = formProvider === 'bedrock';
    const isFoundryAnthropic = formProvider === 'microsoft_foundry_anthropic';
    const isCustomAnthropic =
      formProvider === 'custom' && formCustomApiFormat === 'anthropic_messages';
    // Bedrock requires AWS credentials instead of API key
    if (!formName.trim()) return;
    if (isBedrock) {
      if (formBedrockMode === 'explicit') {
        if (!formAwsAccessKeyId.trim() || !formAwsSecretKey.trim()) return;
      } else {
        if (!formAwsRoleArn.trim() || !formAwsStsEndpoint.trim() || !formAwsResourceArn.trim())
          return;
      }
    } else {
      if (!formApiKey.trim()) return;
    }
    if ((isFoundryAnthropic || isCustomAnthropic) && !formEndpoint.trim()) return;
    setIsCreating(true);
    try {
      const body: Record<string, unknown> = {
        name: formName.trim(),
        provider: formProvider,
        apiKey: isBedrock
          ? formBedrockMode === 'explicit'
            ? formAwsAccessKeyId.trim()
            : BEDROCK_AMBIENT_SENTINEL
          : formApiKey.trim(),
      };
      if (formEndpoint.trim()) {
        body.endpoint = formEndpoint.trim();
      }
      if (formCustomHeaders.trim()) {
        try {
          body.customHeaders = JSON.parse(formCustomHeaders.trim());
        } catch {
          toast.error('Custom headers must be valid JSON');
          setIsCreating(false);
          return;
        }
      }
      // Azure-specific: store resourceName, apiVersion, deploymentId in authConfig
      if (formProvider === 'azure') {
        body.authConfig = {
          ...(formResourceName.trim() ? { resourceName: formResourceName.trim() } : {}),
          ...(formApiVersion.trim() ? { apiVersion: formApiVersion.trim() } : {}),
          ...(formDeploymentId.trim() ? { deploymentId: formDeploymentId.trim() } : {}),
        };
      }
      if (isFoundryAnthropic) {
        body.authType = formFoundryAuthType;
        body.authConfig = {
          apiFormat: 'anthropic_messages',
          ...(formFoundryAnthropicVersion.trim()
            ? { anthropicVersion: formFoundryAnthropicVersion.trim() }
            : {}),
        };
      }
      if (isCustomAnthropic) {
        body.authConfig = { apiFormat: 'anthropic_messages' };
      }
      // Bedrock-specific: store AWS credentials in authConfig
      if (isBedrock) {
        body.authType = 'aws_iam';
        if (formBedrockMode === 'iam_role') {
          body.apiKey = BEDROCK_AMBIENT_SENTINEL;
          let parsedHeaders: Record<string, string> | undefined;
          if (formAwsCustomHeaders.trim()) {
            try {
              parsedHeaders = parseBedrockCustomHeaders(formAwsCustomHeaders.trim()) ?? undefined;
              if (!parsedHeaders) throw new Error('Invalid Bedrock custom headers');
            } catch {
              toast.error('Custom headers must be valid JSON');
              setIsCreating(false);
              return;
            }
          }
          body.authConfig = {
            region: formAwsRegion || 'us-east-1',
            useAmbientCredentials: true,
            roleArn: formAwsRoleArn.trim(),
            stsEndpoint: formAwsStsEndpoint.trim(),
            resourceArn: formAwsResourceArn.trim(),
            ...(formAwsEndpoint.trim() ? { bedrockEndpoint: formAwsEndpoint.trim() } : {}),
            ...(parsedHeaders && Object.keys(parsedHeaders).length > 0
              ? { customHeaders: parsedHeaders }
              : {}),
          };
        } else {
          body.apiKey = formAwsAccessKeyId.trim();
          body.authConfig = {
            region: formAwsRegion,
            accessKeyId: formAwsAccessKeyId.trim(),
            secretAccessKey: formAwsSecretKey.trim(),
            ...(formAwsSessionToken.trim() ? { sessionToken: formAwsSessionToken.trim() } : {}),
          };
        }
      }
      const res = await apiFetch('/api/tenant-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('Failed to create');
      toast.success(t('models_page.credentials.created'));
      setShowCreate(false);
      resetForm();
      await load();
    } catch {
      toast.error(t('models_page.credentials.create_failed'));
    } finally {
      setIsCreating(false);
    }
  };

  // Fetch impact when delete target changes
  useEffect(() => {
    if (!deleteTarget) {
      setDeleteImpact([]);
      return;
    }
    apiFetch(`/api/tenant-credentials/${deleteTarget.id}/impact`)
      .then((res) => res.json())
      .then((data) => {
        if (data.success && data.impactedModels) setDeleteImpact(data.impactedModels);
      })
      .catch(() => setDeleteImpact([]));
  }, [deleteTarget]);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      const res = await apiFetch(`/api/tenant-credentials/${deleteTarget.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Failed to delete');
      toast.success(t('models_page.credentials.deleted'));
      setDeleteTarget(null);
      await load();
    } catch {
      toast.error(t('models_page.credentials.delete_failed'));
    } finally {
      setIsDeleting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-5 h-5 text-muted animate-spin" />
      </div>
    );
  }

  // Build provider → model count map
  const providerModelCount: Record<string, number> = {};
  for (const m of models) {
    if (m.provider) {
      providerModelCount[m.provider] = (providerModelCount[m.provider] || 0) + 1;
    }
  }

  // Group credentials by provider
  const credentialsByProvider: Record<string, Credential[]> = {};
  for (const cred of credentials) {
    const key = cred.provider;
    if (!credentialsByProvider[key]) credentialsByProvider[key] = [];
    credentialsByProvider[key].push(cred);
  }

  const renderCredentialCard = (cred: Credential) => {
    const modelCount = providerModelCount[cred.provider] || 0;
    return (
      <div key={cred.id} className="p-4 rounded-lg bg-background-elevated border border-default">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <div className="mt-0.5 w-8 h-8 rounded-lg bg-background-muted flex items-center justify-center shrink-0">
              <Shield className="w-4 h-4 text-muted" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <h4 className="text-sm font-medium text-foreground truncate">{cred.name}</h4>
                <Badge variant={STATUS_VARIANT[cred.status] || 'default'} dot>
                  {cred.status}
                </Badge>
              </div>
              <div className="flex items-center gap-3 text-sm text-muted">
                <Badge variant={PROVIDER_BADGE_VARIANT[cred.provider] || 'default'}>
                  {PROVIDER_LABEL[cred.provider] || cred.provider}
                </Badge>
                {cred.endpoint && (
                  <span className="font-mono truncate max-w-[200px]" title={cred.endpoint}>
                    {cred.endpoint}
                  </span>
                )}
                <span>Created {new Date(cred.createdAt).toLocaleDateString()}</span>
              </div>
              {modelCount > 0 && (
                <div className="flex items-center gap-1.5 mt-1.5 text-xs text-muted">
                  <Brain className="w-3 h-3" />
                  <span>
                    {modelCount} model{modelCount !== 1 ? 's' : ''} on this provider
                  </span>
                </div>
              )}
            </div>
          </div>
          <button
            onClick={() => setDeleteTarget(cred)}
            className="p-1.5 text-muted hover:text-error rounded transition-default shrink-0"
            title="Delete credential"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">
          {t('models_page.credentials.count', { count: credentials.length })}
        </p>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 border border-default rounded-lg p-0.5">
            <button
              onClick={() => setGroupByProvider(true)}
              className={clsx(
                'p-1.5 rounded transition-default',
                groupByProvider
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted hover:text-foreground',
              )}
              title="Group by provider"
            >
              <Layers className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setGroupByProvider(false)}
              className={clsx(
                'p-1.5 rounded transition-default',
                !groupByProvider
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted hover:text-foreground',
              )}
              title="Flat list"
            >
              <LayoutList className="w-3.5 h-3.5" />
            </button>
          </div>
          <Button
            variant="primary"
            size="sm"
            icon={<Plus className="w-3.5 h-3.5" />}
            onClick={() => setShowCreate(true)}
          >
            {t('models_page.credentials.add')}
          </Button>
        </div>
      </div>

      {credentials.length === 0 ? (
        <EmptyState
          icon={<Key className="w-6 h-6" />}
          title={t('models_page.credentials.empty_title')}
          description={t('models_page.credentials.empty_description')}
          action={
            <Button
              variant="primary"
              size="sm"
              icon={<Plus className="w-3.5 h-3.5" />}
              onClick={() => setShowCreate(true)}
            >
              {t('models_page.credentials.add')}
            </Button>
          }
        />
      ) : groupByProvider ? (
        <div className="space-y-4">
          {Object.entries(credentialsByProvider).map(([provider, creds]) => (
            <div key={provider}>
              <div className="flex items-center gap-2 mb-2">
                <Badge variant={PROVIDER_BADGE_VARIANT[provider as Provider] || 'default'}>
                  {PROVIDER_LABEL[provider as Provider] || provider}
                </Badge>
                <span className="text-xs text-muted">
                  {creds.length} credential{creds.length !== 1 ? 's' : ''}
                </span>
              </div>
              <div className="grid gap-3">{creds.map(renderCredentialCard)}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid gap-3">{credentials.map(renderCredentialCard)}</div>
      )}

      <Dialog
        open={showCreate}
        onClose={() => {
          setShowCreate(false);
          resetForm();
        }}
        title={t('models_page.credentials.dialog_title')}
        description={t('models_page.credentials.dialog_description')}
        maxWidth="md"
      >
        <div className="space-y-4">
          <Input
            label={t('models_page.credentials.name_label')}
            placeholder={t('models_page.credentials.name_placeholder')}
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
          />
          <ProviderSelect
            id="provider-select"
            label={t('models_page.credentials.provider_label')}
            providers={PROVIDERS}
            value={formProvider}
            onChange={(v) => setFormProvider(v as Provider)}
          />
          {/* --- Bedrock: credential mode toggle + fields --- */}
          {formProvider === 'bedrock' ? (
            <>
              <RadioGroup
                label={t('models_page.add_connection.bedrock_credential_mode')}
                value={formBedrockMode}
                onChange={(v) => setFormBedrockMode(v as 'explicit' | 'iam_role')}
                options={[
                  {
                    value: 'iam_role',
                    label: t('models_page.add_connection.bedrock_iam_role'),
                    description: t('models_page.add_connection.bedrock_iam_role_description'),
                  },
                  {
                    value: 'explicit',
                    label: t('models_page.add_connection.bedrock_explicit_creds'),
                  },
                ]}
              />
              <Input
                label={t('models_page.add_connection.bedrock_aws_region_label')}
                placeholder={t('models_page.add_connection.bedrock_aws_region_placeholder')}
                value={formAwsRegion}
                onChange={(e) => setFormAwsRegion(e.target.value)}
              />
              {formBedrockMode === 'iam_role' && (
                <>
                  <div>
                    <Input
                      label={t('models_page.add_connection.bedrock_role_arn_label')}
                      placeholder={t('models_page.add_connection.bedrock_role_arn_placeholder')}
                      value={formAwsRoleArn}
                      onChange={(e) => setFormAwsRoleArn(e.target.value)}
                      required
                    />
                    <p className="text-xs text-muted mt-1">
                      {t('models_page.add_connection.bedrock_role_arn_description')}
                    </p>
                  </div>
                  <div>
                    <Input
                      label={t('models_page.add_connection.bedrock_sts_endpoint_label')}
                      placeholder={t('models_page.add_connection.bedrock_sts_endpoint_placeholder')}
                      value={formAwsStsEndpoint}
                      onChange={(e) => setFormAwsStsEndpoint(e.target.value)}
                      required
                    />
                    <p className="text-xs text-muted mt-1">
                      {t('models_page.add_connection.bedrock_sts_endpoint_description')}
                    </p>
                  </div>
                  <div>
                    <Input
                      label={t('models_page.add_connection.bedrock_resource_arn_label')}
                      placeholder={t('models_page.add_connection.bedrock_resource_arn_placeholder')}
                      value={formAwsResourceArn}
                      onChange={(e) => setFormAwsResourceArn(e.target.value)}
                      required
                    />
                    <p className="text-xs text-muted mt-1">
                      {t('models_page.add_connection.bedrock_resource_arn_description')}
                    </p>
                  </div>
                  <div>
                    <Input
                      label={t('models_page.add_connection.bedrock_endpoint_label')}
                      placeholder={t('models_page.add_connection.bedrock_endpoint_placeholder')}
                      value={formAwsEndpoint}
                      onChange={(e) => setFormAwsEndpoint(e.target.value)}
                    />
                    <p className="text-xs text-muted mt-1">
                      {t('models_page.add_connection.bedrock_endpoint_description')}
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <label
                      htmlFor="bedrock-headers"
                      className="block text-sm font-medium text-foreground"
                    >
                      {t('models_page.add_connection.bedrock_custom_headers_label')}
                    </label>
                    <p className="text-xs text-muted">
                      {t('models_page.add_connection.bedrock_custom_headers_description')}
                    </p>
                    <textarea
                      id="bedrock-headers"
                      placeholder={'{\n  "x-custom-header": "value"\n}'}
                      value={formAwsCustomHeaders}
                      onChange={(e) => setFormAwsCustomHeaders(e.target.value)}
                      rows={3}
                      className="w-full rounded-md border border-default bg-background-subtle text-foreground text-sm py-2 px-3 font-mono focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus transition-default resize-y"
                    />
                  </div>
                </>
              )}
              {formBedrockMode === 'explicit' && (
                <>
                  <Input
                    label={t('models_page.add_connection.bedrock_access_key_id_label')}
                    placeholder={t('models_page.add_connection.bedrock_access_key_id_placeholder')}
                    value={formAwsAccessKeyId}
                    onChange={(e) => setFormAwsAccessKeyId(e.target.value)}
                  />
                  <Input
                    label={t('models_page.add_connection.bedrock_secret_access_key_label')}
                    type="password"
                    autoComplete="off"
                    showToggle
                    placeholder={t(
                      'models_page.add_connection.bedrock_secret_access_key_placeholder',
                    )}
                    value={formAwsSecretKey}
                    onChange={(e) => setFormAwsSecretKey(e.target.value)}
                  />
                  <Input
                    label={t('models_page.add_connection.bedrock_session_token_label')}
                    type="password"
                    autoComplete="off"
                    showToggle
                    placeholder={t('models_page.add_connection.bedrock_session_token_placeholder')}
                    value={formAwsSessionToken}
                    onChange={(e) => setFormAwsSessionToken(e.target.value)}
                  />
                </>
              )}
            </>
          ) : (
            <>
              <Input
                label={t('models_page.credentials.api_key_label')}
                type="password"
                autoComplete="off"
                showToggle
                placeholder={t('models_page.credentials.api_key_placeholder')}
                value={formApiKey}
                onChange={(e) => setFormApiKey(e.target.value)}
              />
            </>
          )}
          {formProvider === 'microsoft_foundry_anthropic' && (
            <>
              <Select
                label="Auth Mode"
                options={[
                  { value: 'api_key', label: 'API key' },
                  { value: 'azure_ad', label: 'Microsoft Entra bearer token' },
                ]}
                value={formFoundryAuthType}
                onChange={(v) => setFormFoundryAuthType(v as 'api_key' | 'azure_ad')}
              />
              <Input
                label={t('models_page.credentials.endpoint_label')}
                placeholder="https://<resource>.services.ai.azure.com/anthropic"
                value={formEndpoint}
                onChange={(e) => setFormEndpoint(e.target.value)}
              />
              <Input
                label="Anthropic Version"
                placeholder="e.g. 2023-06-01"
                value={formFoundryAnthropicVersion}
                onChange={(e) => setFormFoundryAnthropicVersion(e.target.value)}
              />
            </>
          )}
          {/* --- Azure: Resource Name + Deployment ID + API Version --- */}
          {formProvider === 'azure' && (
            <>
              <Input
                label="Resource Name"
                placeholder="e.g. gale-qa"
                value={formResourceName}
                onChange={(e) => setFormResourceName(e.target.value)}
              />
              <p className="text-xs text-muted -mt-1">your_resource_name from Azure portal</p>
              <Input
                label="Deployment ID"
                placeholder="e.g. gpt-4.1"
                value={formDeploymentId}
                onChange={(e) => setFormDeploymentId(e.target.value)}
              />
              <p className="text-xs text-muted -mt-1">
                deployment_id of the model in your Azure resource
              </p>
              <Input
                label="API Version"
                placeholder="e.g. 2024-02-15-preview"
                value={formApiVersion}
                onChange={(e) => setFormApiVersion(e.target.value)}
              />
              <p className="text-xs text-muted -mt-1">api_version for the Azure OpenAI API</p>
            </>
          )}
          {/* --- Custom: Endpoint + Headers --- */}
          {formProvider === 'custom' && (
            <>
              <Select
                label="API Format"
                options={[
                  { value: 'openai_compatible', label: 'OpenAI compatible' },
                  { value: 'anthropic_messages', label: 'Anthropic Messages' },
                ]}
                value={formCustomApiFormat}
                onChange={(v) =>
                  setFormCustomApiFormat(v as 'openai_compatible' | 'anthropic_messages')
                }
              />
              <Input
                label={t('models_page.credentials.endpoint_label')}
                placeholder={
                  formCustomApiFormat === 'anthropic_messages'
                    ? 'https://proxy.example.com/anthropic'
                    : t('models_page.credentials.endpoint_placeholder')
                }
                value={formEndpoint}
                onChange={(e) => setFormEndpoint(e.target.value)}
              />
              <div className="space-y-1.5">
                <label
                  htmlFor="custom-headers"
                  className="block text-sm font-medium text-foreground"
                >
                  Custom Headers <span className="text-muted font-normal">(optional)</span>
                </label>
                <textarea
                  id="custom-headers"
                  placeholder={'{\n  "x-custom-header": "value"\n}'}
                  value={formCustomHeaders}
                  onChange={(e) => setFormCustomHeaders(e.target.value)}
                  rows={3}
                  className="w-full rounded-md border border-default bg-background-subtle text-foreground text-sm py-2 px-3 font-mono focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus transition-default resize-y"
                />
                <p className="text-xs text-muted">
                  JSON object of key-value pairs sent with every request
                </p>
              </div>
            </>
          )}
          <div className="flex gap-3 pt-2">
            <Button
              variant="secondary"
              onClick={() => {
                setShowCreate(false);
                resetForm();
              }}
              className="flex-1"
            >
              {t('models_page.credentials.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={handleCreate}
              loading={isCreating}
              disabled={
                !formName.trim() ||
                (formProvider === 'bedrock'
                  ? formBedrockMode === 'explicit'
                    ? !formAwsAccessKeyId.trim() || !formAwsSecretKey.trim()
                    : !formAwsRoleArn.trim() ||
                      !formAwsStsEndpoint.trim() ||
                      !formAwsResourceArn.trim()
                  : !formApiKey.trim()) ||
                ((formProvider === 'microsoft_foundry_anthropic' ||
                  (formProvider === 'custom' && formCustomApiFormat === 'anthropic_messages')) &&
                  !formEndpoint.trim())
              }
              className="flex-1"
            >
              {t('models_page.credentials.add')}
            </Button>
          </div>
        </div>
      </Dialog>

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title={t('models_page.credentials.delete_title')}
        description={
          deleteImpact.length > 0
            ? t('models_page.credentials.delete_description_with_models', {
                name: deleteTarget?.name ?? '',
                count: deleteImpact.length,
              })
            : t('models_page.credentials.delete_description', {
                name: deleteTarget?.name ?? '',
              })
        }
        confirmLabel={t('models_page.credentials.confirm_delete_label')}
        variant="danger"
        loading={isDeleting}
      >
        {deleteImpact.length > 0 && (
          <div className="mt-3 w-full">
            <div className="flex items-center gap-1.5 mb-2 text-left">
              <AlertTriangle className="w-3.5 h-3.5 text-warning shrink-0" />
              <span className="text-xs font-medium text-warning">
                {t('models_page.credentials.affected_models')}
              </span>
            </div>
            <div className="max-h-40 overflow-y-auto rounded-lg border border-warning/30 bg-warning-subtle/30 p-2 space-y-1">
              {deleteImpact.map((m) => (
                <div key={m.modelId} className="flex items-center gap-2 text-xs text-foreground">
                  <Link2 className="w-3 h-3 text-muted shrink-0" />
                  <span className="truncate">{m.displayName}</span>
                  {m.provider && <span className="text-muted">({m.provider})</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}

// =============================================================================
// MODEL DETAIL PANEL — CONNECTIONS + SETTINGS
// =============================================================================

function ModelDetailPanel({
  model,
  tenantId,
  onModelUpdated,
}: {
  model: TenantModelItem;
  tenantId: string;
  onModelUpdated: () => void;
}) {
  const t = useTranslations('admin');
  const [connections, setConnections] = useState<ModelConnection[]>([]);
  const [isLoadingConns, setIsLoadingConns] = useState(true);
  const [showAddConn, setShowAddConn] = useState(false);
  const [validatingId, setValidatingId] = useState<string | null>(null);
  const [deletingConnId, setDeletingConnId] = useState<string | null>(null);

  // Settings form
  const [editTier, setEditTier] = useState(model.tier);
  const [editDefault, setEditDefault] = useState(model.isDefault);
  const [editTools, setEditTools] = useState(model.supportsTools);
  const [editVision, setEditVision] = useState(model.supportsVision);
  const [editStreaming, setEditStreaming] = useState(model.supportsStreaming);
  const [editUseResponsesApi, setEditUseResponsesApi] = useState<boolean | null>(
    model.useResponsesApi ?? null,
  );
  const [editUseStreaming, setEditUseStreaming] = useState<boolean | null>(
    model.useStreaming ?? null,
  );
  const [editRealtimeVoice, setEditRealtimeVoice] = useState(
    model.capabilities?.includes('realtime_voice') ?? false,
  );
  const [isSaving, setIsSaving] = useState(false);
  const [modelSupportsResponsesApi, setModelSupportsResponsesApi] = useState(false);

  // Dynamic hyperparameters
  const [hyperParams, setHyperParams] = useState<HyperParameter[]>([]);
  const [hyperValues, setHyperValues] = useState<Record<string, HyperParameterValue>>({});
  const [isLoadingHyperParams, setIsLoadingHyperParams] = useState(false);
  const [showDeactivate, setShowDeactivate] = useState(false);
  const [isDeactivating, setIsDeactivating] = useState(false);
  const [deactivateImpact, setDeactivateImpact] = useState<ImpactedProject[]>([]);
  const [isCheckingDeactivateImpact, setIsCheckingDeactivateImpact] = useState(false);

  useEffect(() => {
    setEditTier(model.tier);
    setEditDefault(model.isDefault);
    setEditTools(model.supportsTools);
    setEditVision(model.supportsVision);
    setEditStreaming(model.supportsStreaming);
    setEditUseResponsesApi(model.useResponsesApi ?? null);
    setEditUseStreaming(model.useStreaming ?? null);
    setEditRealtimeVoice(model.capabilities?.includes('realtime_voice') ?? false);
  }, [
    model.id,
    model.tier,
    model.isDefault,
    model.supportsTools,
    model.supportsVision,
    model.supportsStreaming,
    model.useResponsesApi,
    model.useStreaming,
    model.capabilities,
  ]);

  const loadConnections = useCallback(async () => {
    setIsLoadingConns(true);
    try {
      const [connRes, credRes] = await Promise.all([
        apiFetch(`/api/tenant-models/${model.id}/connections?tenantId=${tenantId}`),
        apiFetch('/api/tenant-credentials'),
      ]);
      if (!connRes.ok) throw new Error('Failed to load');
      const connData = await connRes.json();
      const rawConns: any[] = connData.connections || [];

      // Build credential name lookup
      const credMap = new Map<string, string>();
      if (credRes.ok) {
        const credData = await credRes.json();
        for (const c of credData.credentials || []) {
          credMap.set(c.id, c.name);
        }
      }

      // Enrich connections with credential name
      const enriched: ModelConnection[] = rawConns.map((c) => ({
        ...c,
        connectionName:
          c.connectionName || credMap.get(c.credentialId) || c.credentialId || 'Unknown',
        authType: c.authType || c.connectionType || 'api_key',
      }));
      setConnections(enriched);
    } catch {
      // Will show empty connections
    } finally {
      setIsLoadingConns(false);
    }
  }, [model.id, tenantId]);

  useEffect(() => {
    loadConnections();
  }, [loadConnections]);

  // Fetch hyperparameters and capabilities for this model
  useEffect(() => {
    setHyperParams([]);
    setHyperValues({});
    setModelSupportsResponsesApi(false);
    if (!model.modelId) return;
    setIsLoadingHyperParams(true);
    apiFetch(getModelCapabilitiesUrl(model.modelId))
      .then(async (res) => {
        if (!res.ok) return;
        const data = await res.json();
        if (data.hyperParameters?.length > 0) {
          setHyperParams(data.hyperParameters);
          // Initialize values from model's stored hyperParameters or defaults
          const stored = model.hyperParameters ?? {};
          const initial = getDefaultHyperParameterValues(data.hyperParameters, {
            ...stored,
            temperature: model.temperature,
            maxTokens: model.maxTokens,
            max_tokens: model.maxTokens,
            max_completion_tokens: model.maxTokens,
            maxOutputTokens: model.maxTokens,
          });
          setHyperValues(initial);
        }
        // Auto-set capability checkboxes from registry data
        if (data.success) {
          if (typeof data.supportsTools === 'boolean') setEditTools(data.supportsTools);
          if (typeof data.supportsVision === 'boolean') setEditVision(data.supportsVision);
          if (typeof data.supportsStreaming === 'boolean') setEditStreaming(data.supportsStreaming);
          if (typeof data.supportsRealtimeVoice === 'boolean')
            setEditRealtimeVoice(data.supportsRealtimeVoice);
          if (typeof data.supportsResponsesApi === 'boolean')
            setModelSupportsResponsesApi(data.supportsResponsesApi);
        }
      })
      .catch(() => {
        /* non-critical */
      })
      .finally(() => setIsLoadingHyperParams(false));
  }, [model.hyperParameters, model.maxTokens, model.modelId, model.temperature]);

  const handleValidate = async (connId: string) => {
    setValidatingId(connId);
    try {
      const res = await apiFetch(
        `/api/tenant-models/${model.id}/connections/${connId}/validate?tenantId=${tenantId}`,
        { method: 'POST' },
      );
      const data = await res.json();
      if (data.valid === true) {
        toast.success(data.message || 'Connection is valid');
      } else if (data.valid === false) {
        toast.error(sanitizeServerError(data.message, 'Validation failed'));
      } else {
        toast.info(data.message || 'Could not determine validity');
      }
      await loadConnections();
    } catch {
      toast.error(t('models_page.detail.validate_failed'));
    } finally {
      setValidatingId(null);
    }
  };

  const handleDeleteConnection = async (connId: string) => {
    setDeletingConnId(connId);
    try {
      const res = await apiFetch(
        `/api/tenant-models/${model.id}/connections/${connId}?tenantId=${tenantId}`,
        { method: 'DELETE' },
      );
      if (!res.ok) throw new Error('Failed to delete');
      toast.success(t('models_page.detail.connection_removed'));
      await loadConnections();
    } catch {
      toast.error(t('models_page.detail.remove_failed'));
    } finally {
      setDeletingConnId(null);
    }
  };

  const handleSaveSettings = async () => {
    setIsSaving(true);
    try {
      const caps: string[] = ['text'];
      if (editTools) caps.push('tools');
      if (editStreaming) caps.push('streaming');
      if (editVision) caps.push('vision');
      if (editRealtimeVoice) caps.push('realtime_voice');

      // Extract temperature/maxTokens from hyperValues if present, else from form fields
      const tempFromHyper =
        hyperParams.length > 0 ? (hyperValues['temperature'] as number | undefined) : undefined;
      const maxTokFromHyper =
        hyperParams.length > 0
          ? ((hyperValues['max_tokens'] as number | undefined) ??
            (hyperValues['max_completion_tokens'] as number | undefined) ??
            (hyperValues['maxTokens'] as number | undefined) ??
            (hyperValues['maxOutputTokens'] as number | undefined))
          : undefined;

      const patch: Record<string, unknown> = {
        tier: editRealtimeVoice ? 'voice' : editTier,
        isDefault: editDefault,
        supportsTools: editTools,
        supportsVision: editVision,
        supportsStreaming: editStreaming,
        useResponsesApi: editUseResponsesApi,
        useStreaming: editUseStreaming,
        capabilities: caps,
        ...(hyperParams.length > 0
          ? {
              hyperParameters: hyperValues,
              ...(tempFromHyper != null ? { temperature: tempFromHyper } : {}),
              ...(maxTokFromHyper != null ? { maxTokens: maxTokFromHyper } : {}),
            }
          : {}),
      };
      if (editRealtimeVoice) {
        const provider = model.provider?.toLowerCase();
        patch.realtimeConfig = {
          providerType:
            provider === 'openai'
              ? 'openai_realtime'
              : provider === 'google' || provider === 'gemini'
                ? 'gemini_live'
                : provider === 'ultravox'
                  ? 'ultravox'
                  : provider,
        };
      } else {
        patch.realtimeConfig = null;
      }

      const res = await apiFetch(`/api/tenant-models/${model.id}?tenantId=${tenantId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error('Failed to save');
      toast.success(t('models_page.detail.settings_saved'));
      onModelUpdated();
    } catch {
      toast.error(t('models_page.detail.settings_failed'));
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    setIsDeactivating(true);
    try {
      const res = await apiFetch(`/api/tenant-models/${model.id}?tenantId=${tenantId}`, {
        method: 'DELETE',
      });
      if (res.status === 409) {
        // Server blocked: projects still reference this model
        const data = await res.json();
        setDeactivateImpact(data.impactedProjects || []);
        return;
      }
      if (!res.ok) throw new Error('Failed to delete');
      toast.success(t('models_page.detail.deleted'));
      setShowDeactivate(false);
      onModelUpdated();
    } catch {
      toast.error(t('models_page.detail.delete_failed'));
    } finally {
      setIsDeactivating(false);
    }
  };

  const isProvisioned = !!(model as any).provisionedBy;

  return (
    <TooltipProvider>
      <div className="border-t border-default bg-background-muted/50 px-4 py-4 space-y-5">
        {/* Platform Managed info banner */}
        {isProvisioned && (
          <div className="flex items-start gap-3 p-3 rounded-lg bg-purple-subtle/30 border border-purple/20">
            <Info className="w-4 h-4 text-purple shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="text-foreground font-medium">
                {t('models_page.detail.provisioned_title')}
              </p>
              <p className="text-muted mt-0.5">{t('models_page.detail.provisioned_description')}</p>
              {(model as any).provisioningNote && (
                <p className="text-muted mt-1 italic">{(model as any).provisioningNote}</p>
              )}
            </div>
          </div>
        )}

        {/* Connections Section */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Link2 className="w-3.5 h-3.5 text-muted" />
              <h5 className="text-xs font-semibold uppercase tracking-wider text-muted">
                {t('models_page.detail.connections_title')}
              </h5>
            </div>
            <Button
              variant="secondary"
              size="sm"
              icon={<Plus className="w-3 h-3" />}
              onClick={() => setShowAddConn(true)}
            >
              {t('models_page.detail.add_key')}
            </Button>
          </div>

          {isLoadingConns ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="w-4 h-4 text-muted animate-spin" />
            </div>
          ) : connections.length === 0 ? (
            <div className="py-4 px-3 rounded-lg border border-dashed border-default text-center">
              <p className="text-sm text-muted">{t('models_page.detail.no_keys')}</p>
              <p className="text-xs text-muted mt-1">
                {t('models_page.detail.no_keys_description')}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {connections.map((conn) => (
                <div
                  key={conn.id}
                  className="flex items-center justify-between p-3 rounded-lg border border-default bg-background-elevated"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Key className="w-3.5 h-3.5 text-muted shrink-0" />
                    <span className="text-sm font-medium text-foreground truncate">
                      {conn.connectionName}
                    </span>
                    <Badge variant="default">{conn.authType}</Badge>
                    {conn.isPrimary && (
                      <Badge variant="accent">{t('models_page.detail.primary')}</Badge>
                    )}
                    <Tooltip
                      content={
                        conn.healthStatus && conn.healthStatus !== 'unchecked'
                          ? `${conn.healthStatus}${conn.healthMessage ? ` — ${conn.healthMessage}` : ''}${conn.lastHealthCheck ? ` (checked ${formatRelativeTime(conn.lastHealthCheck)})` : ''}`
                          : 'Not tested yet'
                      }
                      side="top"
                    >
                      <span
                        className={clsx(
                          'w-2.5 h-2.5 rounded-full shrink-0',
                          HEALTH_DOT_COLOR[conn.healthStatus || 'unchecked'],
                        )}
                      />
                    </Tooltip>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => handleValidate(conn.id)}
                      disabled={validatingId === conn.id}
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs text-muted hover:text-accent rounded transition-default"
                      title={t('models_page.detail.validate')}
                    >
                      {validatingId === conn.id ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <CheckCircle2 className="w-3.5 h-3.5" />
                      )}
                      <span>Test</span>
                    </button>
                    <button
                      onClick={() => handleDeleteConnection(conn.id)}
                      disabled={deletingConnId === conn.id}
                      className="p-1.5 text-muted hover:text-error rounded transition-default"
                      title={t('models_page.detail.remove')}
                    >
                      {deletingConnId === conn.id ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Settings Section */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Settings2 className="w-3.5 h-3.5 text-muted" />
            <h5 className="text-xs font-semibold uppercase tracking-wider text-muted">
              {t('models_page.detail.settings_title')}
            </h5>
          </div>

          {/* Dynamic Hyperparameters */}
          {isLoadingHyperParams ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="w-4 h-4 text-muted animate-spin" />
            </div>
          ) : (
            <HyperParameterForm
              parameters={hyperParams}
              values={hyperValues}
              onChange={(name, value) => setHyperValues((prev) => ({ ...prev, [name]: value }))}
              compact
            />
          )}

          <div className="w-40 mt-3">
            <Select
              label={t('models_page.detail.tier_label')}
              options={[
                { value: 'fast', label: t('models_page.detail.tier_fast') },
                { value: 'balanced', label: t('models_page.detail.tier_balanced') },
                { value: 'powerful', label: t('models_page.detail.tier_powerful') },
                { value: 'voice', label: 'Voice' },
              ]}
              value={editTier}
              onChange={(v) => setEditTier(v as 'fast' | 'balanced' | 'powerful' | 'voice')}
            />
          </div>

          {/* OpenAI API Mode — only for models that support the Responses API */}
          {modelSupportsResponsesApi && (
            <div className="w-52 mt-3">
              <Select
                label={t('models_page.detail.responses_api_label')}
                options={[
                  { value: 'true', label: t('models_page.detail.responses_api_enabled') },
                  { value: 'false', label: t('models_page.detail.responses_api_disabled') },
                ]}
                value={editUseResponsesApi === false ? 'false' : 'true'}
                onChange={(v) => setEditUseResponsesApi(v === 'true')}
              />
            </div>
          )}

          {/* Response Mode — only for models that support streaming */}
          {editStreaming && (
            <div className="w-52 mt-3">
              <Select
                label={t('models_page.detail.streaming_label')}
                options={[
                  { value: 'true', label: t('models_page.detail.streaming_enabled') },
                  { value: 'false', label: t('models_page.detail.streaming_disabled') },
                ]}
                value={editUseStreaming === false ? 'false' : 'true'}
                onChange={(v) => setEditUseStreaming(v === 'true')}
              />
            </div>
          )}

          <div className="flex items-center gap-4 mt-3">
            <Checkbox
              checked={editDefault}
              onChange={(checked) => setEditDefault(checked)}
              label={t('models_page.detail.default_for_tier')}
            />
            <span className="w-px h-4 bg-border-default" />
            {/* Capabilities: read-only badges for provisioned, checkboxes for tenant-managed */}
            {/* Capability indicators — auto-populated from model registry */}
            {isLoadingHyperParams ? (
              <span className="text-xs text-muted">
                {t('models_page.detail.loading_capabilities')}
              </span>
            ) : (
              <>
                <Checkbox
                  checked={editTools}
                  onChange={() => {}}
                  disabled
                  label={t('models_page.detail.tools')}
                />
                <Checkbox
                  checked={editVision}
                  onChange={() => {}}
                  disabled
                  label={t('models_page.detail.vision')}
                />
                <Checkbox
                  checked={editStreaming}
                  onChange={() => {}}
                  disabled
                  label={t('models_page.detail.streaming')}
                />
                <Checkbox
                  checked={editRealtimeVoice}
                  onChange={() => {}}
                  disabled
                  label={t('models_page.detail.realtime_voice')}
                />
              </>
            )}
          </div>

          <div className="flex items-center gap-3 mt-4">
            <Button variant="primary" size="sm" onClick={handleSaveSettings} loading={isSaving}>
              {t('models_page.detail.save')}
            </Button>
            {!isProvisioned && (
              <Button
                variant="danger"
                size="sm"
                loading={isCheckingDeactivateImpact}
                onClick={async () => {
                  setIsCheckingDeactivateImpact(true);
                  try {
                    const res = await apiFetch(
                      `/api/tenant-models/${model.id}/impact?tenantId=${tenantId}`,
                    );
                    if (res.ok) {
                      const data = await res.json();
                      setDeactivateImpact(data.impactedProjects || []);
                    }
                  } catch {
                    setDeactivateImpact([]);
                  } finally {
                    setIsCheckingDeactivateImpact(false);
                    setShowDeactivate(true);
                  }
                }}
              >
                {t('models_page.detail.delete')}
              </Button>
            )}
          </div>
        </div>

        <AddConnectionDialog
          open={showAddConn}
          onClose={() => setShowAddConn(false)}
          modelId={model.id}
          modelDisplayName={model.displayName}
          canonicalModelId={model.modelId}
          tenantId={tenantId}
          provider={model.provider || 'custom'}
          onCreated={() => {
            setShowAddConn(false);
            loadConnections();
          }}
        />

        {deactivateImpact.length > 0 ? (
          <Dialog
            open={showDeactivate}
            onClose={() => {
              setShowDeactivate(false);
              setDeactivateImpact([]);
            }}
            maxWidth="sm"
          >
            <div className="flex flex-col items-center text-center">
              <div className="w-12 h-12 rounded-full flex items-center justify-center mb-4 bg-error-subtle">
                <AlertTriangle className="w-6 h-6 text-error" />
              </div>
              <h3 className="text-lg font-semibold text-foreground mb-1">
                {t('models_page.detail.delete_blocked_title')}
              </h3>
              <p className="text-sm text-muted mb-4">
                {t('models_page.detail.delete_blocked_description', {
                  name: model.displayName,
                  count: deactivateImpact.length,
                })}
              </p>
              <div className="w-full">
                <div className="flex items-center gap-1.5 mb-2 text-left">
                  <AlertTriangle className="w-3.5 h-3.5 text-warning shrink-0" />
                  <span className="text-xs font-medium text-warning">
                    {t('models_page.detail.affected_projects')}
                  </span>
                </div>
                <div className="max-h-40 overflow-y-auto rounded-lg border border-warning/30 bg-warning-subtle/30 p-2 space-y-1">
                  {deactivateImpact.map((p) => (
                    <div
                      key={p.projectId}
                      className="flex items-center justify-between text-sm px-2 py-1.5 rounded-md bg-background-elevated/50"
                    >
                      <span className="text-foreground font-medium truncate">{p.projectName}</span>
                      <Badge variant={TIER_VARIANT[p.tier] || 'default'}>{p.tier}</Badge>
                    </div>
                  ))}
                </div>
              </div>
              <Button
                variant="secondary"
                className="w-full mt-4"
                onClick={() => {
                  setShowDeactivate(false);
                  setDeactivateImpact([]);
                }}
              >
                {t('models_page.detail.close')}
              </Button>
            </div>
          </Dialog>
        ) : (
          <ConfirmDialog
            open={showDeactivate}
            onClose={() => setShowDeactivate(false)}
            onConfirm={handleDelete}
            title={t('models_page.detail.delete_title')}
            description={t('models_page.detail.delete_description', { name: model.displayName })}
            confirmLabel={t('models_page.detail.confirm_delete')}
            variant="danger"
            loading={isDeactivating}
          />
        )}
      </div>
    </TooltipProvider>
  );
}

// =============================================================================
// DEFAULT MODEL HERO
// =============================================================================

function DefaultModelHero({
  defaultModel,
  onChangeDefault,
}: {
  defaultModel: TenantModelItem | null;
  onChangeDefault: () => void;
}) {
  if (!defaultModel) {
    return (
      <div className="rounded-lg border border-dashed border-default p-6 text-center bg-background-elevated">
        <Brain className="w-8 h-8 text-muted mx-auto mb-2" />
        <p className="text-sm font-medium text-foreground mb-1">No default model configured</p>
        <p className="text-xs text-muted mb-3">Select one from the list below.</p>
        <Button variant="secondary" size="sm" onClick={onChangeDefault}>
          Choose Default
        </Button>
      </div>
    );
  }

  const connCount = defaultModel._count?.connections ?? 0;
  const hasConnections = connCount > 0;

  return (
    <div className="rounded-lg border border-default bg-background-elevated p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-4 min-w-0">
          <div className="w-10 h-10 rounded-lg bg-warning/10 flex items-center justify-center shrink-0">
            <Star className="w-5 h-5 text-warning fill-warning" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-medium text-muted uppercase tracking-wider">
                Default Model
              </span>
            </div>
            <div className="flex items-center gap-2 mb-1">
              <Badge
                variant={PROVIDER_BADGE_VARIANT[defaultModel.provider as Provider] || 'default'}
              >
                {PROVIDER_LABEL[defaultModel.provider as Provider] ||
                  defaultModel.provider ||
                  'custom'}
              </Badge>
              <h3 className="text-base font-semibold text-foreground truncate">
                {defaultModel.displayName}
              </h3>
            </div>
            <p className="text-xs font-mono text-muted truncate mb-2">
              {defaultModel.modelId || defaultModel.endpointUrl || '--'}
            </p>
            <div className="flex items-center gap-3">
              {hasConnections ? (
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-success shrink-0" />
                  <span className="text-xs font-medium text-success">Ready</span>
                  <span className="text-xs text-muted">
                    ({connCount} connection{connCount !== 1 ? 's' : ''})
                  </span>
                </span>
              ) : (
                <span className="flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 text-warning shrink-0" />
                  <span className="text-xs font-medium text-warning">No Credentials</span>
                </span>
              )}
            </div>
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={onChangeDefault}>
          Change Default
        </Button>
      </div>
    </div>
  );
}

// =============================================================================
// MODELS TAB (redesigned with hero, flat list, and collapsed advanced)
// =============================================================================

function ModelsTab() {
  const t = useTranslations('admin');
  const tenantId = useAuthStore((s) => s.tenantId);
  const [models, setModels] = useState<TenantModelItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState<string>('all');
  const [showAddModel, setShowAddModel] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [impactDialogModel, setImpactDialogModel] = useState<TenantModelItem | null>(null);
  const [impactedProjects, setImpactedProjects] = useState<ImpactedProject[]>([]);
  const [isCheckingImpact, setIsCheckingImpact] = useState(false);
  const [settingDefaultId, setSettingDefaultId] = useState<string | null>(null);
  const modelListRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!tenantId) return;
    setIsLoading(true);
    try {
      const res = await apiFetch(`/api/tenant-models?tenantId=${tenantId}`);
      if (!res.ok) throw new Error('Failed to load');
      const data = await res.json();
      setModels(data.models || []);
    } catch {
      toast.error(t('models_page.catalog.load_failed'));
    } finally {
      setIsLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleToggleInference = async (model: TenantModelItem) => {
    if (!tenantId) return;

    // If disabling, check impact first
    if (model.inferenceEnabled) {
      setIsCheckingImpact(true);
      setTogglingId(model.id);
      try {
        const impactRes = await apiFetch(
          `/api/tenant-models/${model.id}/impact?tenantId=${tenantId}`,
        );
        if (impactRes.ok) {
          const impactData = await impactRes.json();
          if (impactData.impactedProjects?.length > 0) {
            setImpactedProjects(impactData.impactedProjects);
            setImpactDialogModel(model);
            setIsCheckingImpact(false);
            setTogglingId(null);
            return;
          }
        }
      } catch {
        // If impact check fails, proceed without blocking
      } finally {
        setIsCheckingImpact(false);
      }
    }

    await executeToggleInference(model);
  };

  const executeToggleInference = async (model: TenantModelItem) => {
    if (!tenantId) return;
    setTogglingId(model.id);
    try {
      const res = await apiFetch(
        `/api/tenant-models/${model.id}/toggle-inference?tenantId=${tenantId}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ inferenceEnabled: !model.inferenceEnabled }),
        },
      );
      if (!res.ok) throw new Error('Failed to toggle');
      await load();
    } catch {
      toast.error(t('models_page.catalog.toggle_failed'));
    } finally {
      setTogglingId(null);
      setImpactDialogModel(null);
      setImpactedProjects([]);
    }
  };

  const handleSetDefault = async (model: TenantModelItem) => {
    if (!tenantId || model.isDefault) return;
    setSettingDefaultId(model.id);
    try {
      const res = await apiFetch(`/api/tenant-models/${model.id}?tenantId=${tenantId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isDefault: true }),
      });
      if (!res.ok) throw new Error('Failed to set default');
      toast.success(`${model.displayName} is now the default model`);
      await load();
    } catch {
      toast.error('Failed to set default model');
    } finally {
      setSettingDefaultId(null);
    }
  };

  const scrollToModelList = () => {
    modelListRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const filteredModels = models.filter((m) => {
    if (
      providerFilter !== 'all' &&
      (!m.provider || !areLlmProvidersPolicyEquivalent(providerFilter, m.provider))
    ) {
      return false;
    }
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      m.displayName.toLowerCase().includes(q) ||
      (m.modelId || '').toLowerCase().includes(q) ||
      (m.provider || '').toLowerCase().includes(q)
    );
  });

  const defaultModel = pickPrimaryDefaultModel(models);
  const defaultConnCount = defaultModel?._count?.connections ?? 0;
  const activeModelCount = models.filter((m) => m.inferenceEnabled).length;

  if (!tenantId) {
    return (
      <EmptyState
        icon={<Brain className="w-6 h-6" />}
        title={t('models_page.catalog.no_workspace')}
        description={t('models_page.catalog.no_workspace_description')}
      />
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-5 h-5 text-muted animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Warning Banner: default model has 0 connections */}
      {defaultModel && defaultConnCount === 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-warning/30 bg-warning-subtle/30 px-4 py-3">
          <AlertTriangle className="w-4 h-4 text-warning shrink-0" />
          <p className="text-sm text-warning flex-1">
            Your default model &quot;{defaultModel.displayName}&quot; has no active connections.
            Agents won&apos;t be able to generate responses.
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setExpandedId(defaultModel.id);
              scrollToModelList();
            }}
          >
            Add Connection
          </Button>
        </div>
      )}

      {/* Hero Default Model Card */}
      <DefaultModelHero defaultModel={defaultModel} onChangeDefault={scrollToModelList} />

      {/* Header: search + filter + add button */}
      <div ref={modelListRef} className="flex items-center gap-3 pt-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-foreground-subtle" />
          <input
            type="text"
            placeholder={t('models_page.catalog.search_placeholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-lg border border-default bg-background text-foreground text-sm py-1.5 pl-8 pr-3 placeholder:text-foreground-subtle focus:outline-none focus:border-[hsl(var(--border-focus))] focus:ring-1 focus:ring-[hsl(var(--border-focus))] transition-colors"
          />
        </div>
        <Select
          options={[
            { value: 'all', label: t('models_page.catalog.all_providers') },
            ...PROVIDERS.map((p) => ({ value: p.value, label: p.label })),
          ]}
          value={providerFilter}
          onChange={setProviderFilter}
        />
        <Button
          variant="primary"
          size="sm"
          icon={<Plus className="w-3.5 h-3.5" />}
          onClick={() => setShowAddModel(true)}
        >
          {t('models_page.catalog.add_model')}
        </Button>
      </div>

      {/* Model list (flat) */}
      {models.length === 0 ? (
        <div className="rounded-lg border border-dashed border-default p-8 text-center bg-background-elevated">
          <Brain className="w-10 h-10 text-muted mx-auto mb-3" />
          <h3 className="text-base font-semibold text-foreground mb-2">Set up your first model</h3>
          <ol className="text-sm text-muted space-y-1 mb-4 text-left max-w-xs mx-auto list-decimal list-inside">
            <li>Add a credential (API key) in the Credentials tab</li>
            <li>Add a model from the catalog</li>
            <li>It becomes your default — done!</li>
          </ol>
          <Button
            variant="primary"
            size="sm"
            icon={<Plus className="w-3.5 h-3.5" />}
            onClick={() => setShowAddModel(true)}
          >
            Browse Catalog
          </Button>
        </div>
      ) : filteredModels.length === 0 ? (
        <div className="py-8 text-center text-muted text-sm">
          {t('models_page.catalog.no_search_match')}
        </div>
      ) : (
        <div className="rounded-lg border border-default overflow-hidden">
          {/* Table header */}
          <div className="grid grid-cols-[2rem_1fr_1.5fr_2rem_6rem_5rem] gap-2 px-4 py-2.5 bg-background-muted border-b border-default">
            <span />
            <span className="text-xs font-medium text-muted uppercase tracking-wider">
              {t('models_page.catalog.provider_header')}
            </span>
            <span className="text-xs font-medium text-muted uppercase tracking-wider">
              {t('models_page.catalog.model_header')}
            </span>
            <span />
            <span className="text-xs font-medium text-muted uppercase tracking-wider">
              {t('models_page.catalog.connections_header')}
            </span>
            <span className="text-xs font-medium text-muted uppercase tracking-wider">
              {t('models_page.catalog.status_header')}
            </span>
          </div>

          {/* Rows */}
          {filteredModels.map((model) => {
            const isExpanded = expandedId === model.id;
            const connCount = model._count?.connections ?? 0;
            const hasConnections = connCount > 0;

            return (
              <div key={model.id} className="border-b border-default last:border-0">
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setExpandedId(isExpanded ? null : model.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setExpandedId(isExpanded ? null : model.id);
                    }
                  }}
                  className="w-full grid grid-cols-[2rem_1fr_1.5fr_2rem_6rem_5rem] gap-2 px-4 py-3 text-left transition-default hover:bg-background-muted items-center cursor-pointer"
                >
                  <span className="text-muted">
                    {isExpanded ? (
                      <ChevronDown className="w-4 h-4" />
                    ) : (
                      <ChevronRight className="w-4 h-4" />
                    )}
                  </span>
                  <span>
                    <Badge
                      variant={PROVIDER_BADGE_VARIANT[model.provider as Provider] || 'default'}
                    >
                      {PROVIDER_LABEL[model.provider as Provider] || model.provider || 'custom'}
                    </Badge>
                  </span>
                  <span className="min-w-0 flex items-center gap-1.5">
                    <span className="min-w-0">
                      <span className="text-sm font-medium text-foreground block truncate">
                        {model.displayName}
                      </span>
                      {(model as any).provisionedBy && (
                        <span title={(model as any).provisioningNote || undefined}>
                          <Badge variant="accent">
                            {t('models_page.catalog.platform_managed')}
                          </Badge>
                        </span>
                      )}
                      <span className="text-xs font-mono text-muted block truncate">
                        {model.modelId || model.endpointUrl || '--'}
                      </span>
                    </span>
                  </span>
                  {/* Default star indicator */}
                  <span className="flex items-center justify-center">
                    {settingDefaultId === model.id ? (
                      <Loader2 className="w-4 h-4 animate-spin text-muted" />
                    ) : (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleSetDefault(model);
                        }}
                        className="p-0.5 rounded hover:bg-background-elevated transition-default"
                        title={model.isDefault ? 'Default model' : 'Set as default'}
                      >
                        {model.isDefault ? (
                          <Star className="w-4 h-4 text-warning fill-warning" />
                        ) : (
                          <Star className="w-4 h-4 text-muted" />
                        )}
                      </button>
                    )}
                  </span>
                  <span className="flex items-center gap-1.5">
                    {hasConnections ? (
                      <>
                        <span className="w-2 h-2 rounded-full bg-success shrink-0" />
                        <span className="text-xs text-foreground">Ready</span>
                      </>
                    ) : (
                      <>
                        <AlertTriangle className="w-3.5 h-3.5 text-warning shrink-0" />
                        <span className="text-xs text-warning">No Keys</span>
                      </>
                    )}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleToggleInference(model);
                    }}
                    className="inline-flex items-center gap-1 p-1 rounded hover:bg-background-elevated transition-default"
                    title={
                      model.inferenceEnabled
                        ? t('models_page.catalog.disable_inference')
                        : t('models_page.catalog.enable_inference')
                    }
                  >
                    {togglingId === model.id ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-muted" />
                    ) : model.inferenceEnabled ? (
                      <Power className="w-3.5 h-3.5 text-success" />
                    ) : (
                      <PowerOff className="w-3.5 h-3.5 text-muted" />
                    )}
                  </button>
                </div>
                {isExpanded && (
                  <ModelDetailPanel model={model} tenantId={tenantId} onModelUpdated={load} />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Collapsed Advanced: Operation Routing */}
      {activeModelCount >= 2 && (
        <details className="mt-6">
          <summary className="cursor-pointer text-sm font-medium text-muted hover:text-foreground transition-default flex items-center gap-2 select-none">
            <ChevronRight className="w-4 h-4" /> Routing Tiers
          </summary>
          <p className="mt-2 text-xs text-muted">
            Projects use the workspace default model unless operation routing is enabled in project
            model settings. These tiers are the available routing targets.
          </p>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
            {TIER_ORDER.map((tier) => {
              const info = TIER_INFO[tier];
              return (
                <div
                  key={tier}
                  className="rounded-lg border border-default bg-background-elevated p-4"
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <Badge variant={TIER_VARIANT[tier] || 'default'}>{info?.label || tier}</Badge>
                  </div>
                  <p className="text-xs text-muted mb-2">{info?.description}</p>
                  <div className="flex flex-wrap gap-1">
                    {info?.operations.map((op) => (
                      <span
                        key={op}
                        className="inline-block text-xs font-mono px-1.5 py-0.5 rounded bg-background-muted text-muted"
                      >
                        {op}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </details>
      )}

      <AddModelDialog
        open={showAddModel}
        onClose={() => setShowAddModel(false)}
        tenantId={tenantId}
        onCreated={() => {
          setShowAddModel(false);
          load();
        }}
      />

      <ConfirmDialog
        open={!!impactDialogModel}
        onClose={() => {
          setImpactDialogModel(null);
          setImpactedProjects([]);
        }}
        onConfirm={() => {
          if (impactDialogModel) executeToggleInference(impactDialogModel);
        }}
        title={t('models_page.catalog.disable_title')}
        description={t('models_page.catalog.disable_description', {
          name: impactDialogModel?.displayName ?? '',
          count: impactedProjects.length,
        })}
        confirmLabel={t('models_page.catalog.disable_confirm')}
        variant="danger"
      >
        <div className="mt-2 w-full">
          <div className="flex items-center gap-1.5 mb-2 text-left">
            <AlertTriangle className="w-3.5 h-3.5 text-warning shrink-0" />
            <span className="text-xs font-medium text-warning">
              {t('models_page.detail.affected_projects')}
            </span>
          </div>
          <div className="max-h-40 overflow-y-auto rounded-lg border border-warning/30 bg-warning-subtle/30 p-2 space-y-1">
            {impactedProjects.map((p) => (
              <div
                key={p.projectId}
                className="flex items-center justify-between text-sm px-2 py-1.5 rounded-md bg-background-elevated/50"
              >
                <span className="text-foreground font-medium truncate">{p.projectName}</span>
                <Badge variant={TIER_VARIANT[p.tier] || 'default'}>{p.tier}</Badge>
              </div>
            ))}
          </div>
        </div>
      </ConfirmDialog>
    </div>
  );
}

// =============================================================================
// MAIN PAGE
// =============================================================================

export function ModelsPage() {
  const t = useTranslations('admin');
  const [activeTab, setActiveTab] = useState('models');

  const tabs = [
    {
      id: 'credentials',
      label: t('models_page.tabs.credentials'),
      icon: <Key className="w-3.5 h-3.5" />,
    },
    { id: 'models', label: t('models_page.tabs.models'), icon: <Brain className="w-3.5 h-3.5" /> },
    { id: 'policy', label: 'Policy', icon: <Shield className="w-3.5 h-3.5" /> },
  ];

  return (
    <div className="h-full overflow-y-auto bg-noise">
      <div className="max-w-5xl mx-auto px-6 py-8">
        <PageHeader title={t('models_page.title')} description={t('models_page.description')} />

        <div className="mt-6">
          <Tabs
            tabs={tabs}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            layoutId="models-page-tabs"
          />
        </div>

        <div className="mt-6">
          {activeTab === 'credentials' && <CredentialsTab />}
          {activeTab === 'models' && <ModelsTab />}
          {activeTab === 'policy' && <LLMPolicySection />}
        </div>
      </div>
    </div>
  );
}
