/**
 * ModelConfigTab Component
 *
 * Project model configuration: list, add from tenant catalog, set default, remove,
 * and inline-edit model settings including auth profile assignment.
 * Uses studio API at /api/models and /api/tenant-models.
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import {
  Brain,
  Loader2,
  RefreshCw,
  Plus,
  Trash2,
  Star,
  Search,
  AlertTriangle,
  Info,
  Check,
  CheckCircle2,
  Pencil,
  X,
  Key,
  Shield,
} from 'lucide-react';
import { clsx } from 'clsx';
import {
  DEFAULT_OPERATION_TIERS,
  MODEL_ROUTING_OPERATIONS,
  TEXT_MODEL_ROUTING_TIERS,
  type ModelRoutingOperation,
} from '@agent-platform/shared-kernel/model-routing';
import { useNavigationStore } from '../../store/navigation-store';
import { useAuthStore } from '../../store/auth-store';
import { apiFetch } from '../../lib/api-client';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Dialog } from '../ui/Dialog';
import { EmptyState } from '../ui/EmptyState';
import { SkeletonFormSection } from '../ui/Skeleton';
import { Select } from '../ui/Select';
import { Tooltip, TooltipProvider } from '../ui/Tooltip';
import { AuthProfilePicker } from '../auth-profiles/AuthProfilePicker';
import { getDefaultHyperParameterValues, HyperParameterForm } from '../admin/HyperParameterForm';
import type { HyperParameter, HyperParameterValue } from '../admin/HyperParameterForm';
import { toast } from 'sonner';
import { sanitizeError } from '../../lib/sanitize-error';
import type { AuthType } from '../../api/auth-profiles';
import { formatModelIdentityLine, getModelPrimaryName } from '../../lib/model-display';
import { getModelCapabilitiesUrl } from '../../lib/model-capabilities-url';

interface ModelConfig {
  id: string;
  name: string;
  modelId: string;
  provider: string;
  tier: 'fast' | 'balanced' | 'powerful' | 'voice';
  temperature: number;
  maxTokens: number;
  hyperParameters?: Record<string, unknown> | null;
  inputCostPer1k: number | null;
  outputCostPer1k: number | null;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsStreaming: boolean;
  contextWindow: number;
  useResponsesApi?: boolean | null;
  useStreaming?: boolean | null;
  isDefault: boolean;
  tenantModelId?: string | null;
  credentialId?: string | null;
  authProfileId?: string | null;
}

interface TenantModel {
  id: string;
  displayName: string;
  modelId: string | null;
  provider: string | null;
  tier: string;
  temperature: number;
  maxTokens: number;
  hyperParameters?: Record<string, unknown> | null;
  isDefault: boolean;
  supportsTools?: boolean;
  supportsVision?: boolean;
  supportsStreaming?: boolean;
  contextWindow?: number;
  capabilities?: string[] | string;
  _count?: { connections: number };
}

type RuntimePolicyMode = 'inherit' | 'enabled' | 'disabled';

/** Editable fields for inline model editing */
interface ModelEditState {
  name: string;
  hyperParameters: Record<string, HyperParameterValue>;
  responsesApiMode: RuntimePolicyMode;
  streamingMode: RuntimePolicyMode;
  credentialSource: 'legacy' | 'auth_profile';
  authProfileId: string | null;
}

const TIER_VARIANT: Record<string, 'info' | 'warning' | 'success' | 'purple'> = {
  fast: 'info',
  balanced: 'warning',
  powerful: 'success',
  voice: 'purple',
};

const PROVIDER_BADGE_VARIANT: Record<
  string,
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

/** Auth types relevant to model credential configuration */
const MODEL_AUTH_TYPES: AuthType[] = ['api_key', 'bearer'];
const PRIMARY_DEFAULT_TIER_ORDER = ['balanced', 'powerful', 'fast', 'voice'] as const;

// =============================================================================
// Operation-Tier Mapping Constants
// =============================================================================

const OPERATION_LABELS: Record<ModelRoutingOperation, string> = {
  extraction: 'Extraction',
  validation: 'Validation',
  tool_selection: 'Tool Selection',
  response_gen: 'Response Generation',
  summarization: 'Summarization',
  reasoning: 'Reasoning',
  coordination: 'Coordination',
  realtime_voice: 'Realtime Voice',
};

const OPERATIONS = MODEL_ROUTING_OPERATIONS.map((value) => ({
  value,
  label: OPERATION_LABELS[value],
  defaultTier: DEFAULT_OPERATION_TIERS[value],
}));

function buildOperationTierOverrides(overrides: Record<string, string>): Record<string, string> {
  return OPERATIONS.reduce<Record<string, string>>((acc, op) => {
    acc[op.value] = overrides[op.value] || op.defaultTier;
    return acc;
  }, {});
}

function getOperationTierOptions(operation: ModelRoutingOperation): readonly string[] {
  return operation === 'realtime_voice' ? ['voice'] : TEXT_MODEL_ROUTING_TIERS;
}

function getProjectModelId(tenantModel: TenantModel): string {
  const modelId = tenantModel.modelId?.trim();
  return modelId || `tenant:${tenantModel.id}`;
}

function getTenantModelDisplayName(tenantModel: TenantModel): string {
  return getModelPrimaryName(tenantModel);
}

function getTenantModelProvider(tenantModel: TenantModel): string {
  return tenantModel.provider?.trim() || 'custom';
}

function isTenantModelAlreadyAdded(models: ModelConfig[], tenantModel: TenantModel): boolean {
  const projectModelId = getProjectModelId(tenantModel);
  return models.some(
    (model) =>
      model.tenantModelId === tenantModel.id ||
      (!model.tenantModelId && model.modelId === projectModelId),
  );
}

function booleanToPolicyMode(value: boolean | null | undefined): RuntimePolicyMode {
  if (value === true) return 'enabled';
  if (value === false) return 'disabled';
  return 'inherit';
}

function policyModeToBoolean(mode: RuntimePolicyMode): boolean | null {
  if (mode === 'inherit') return null;
  return mode === 'enabled';
}

function getPrimaryDefaultTierRank(tier: string | undefined): number {
  const rank = PRIMARY_DEFAULT_TIER_ORDER.indexOf(
    tier as (typeof PRIMARY_DEFAULT_TIER_ORDER)[number],
  );
  return rank === -1 ? PRIMARY_DEFAULT_TIER_ORDER.length : rank;
}

function pickPrimaryDefaultModel<T extends { isDefault: boolean; tier?: string }>(
  modelList: T[],
): T | undefined {
  return modelList.reduce<T | undefined>((selected, candidate) => {
    if (!candidate.isDefault) return selected;
    if (!selected) return candidate;
    return getPrimaryDefaultTierRank(candidate.tier) < getPrimaryDefaultTierRank(selected.tier)
      ? candidate
      : selected;
  }, undefined);
}

function getHyperParameterFormValueKey(param: HyperParameter): string {
  if (param.unifiedParam === 'thinking.enabled') return 'enableThinking';
  if (param.unifiedParam === 'thinking.budget_tokens') return 'thinkingBudget';
  return param.name;
}

function walkHyperParameters(
  params: HyperParameter[],
  visitor: (param: HyperParameter) => void,
): void {
  for (const param of params) {
    visitor(param);
    if (param.options) walkHyperParameters(param.options, visitor);
    if (param.hyperParameters) walkHyperParameters(param.hyperParameters, visitor);
  }
}

function extractProjectScalarFromHyperValues(
  params: HyperParameter[],
  values: Record<string, HyperParameterValue>,
  names: readonly string[],
): number | undefined {
  let result: number | undefined;
  walkHyperParameters(params, (param) => {
    if (result !== undefined) return;
    if (!names.includes(param.name) && !names.includes(param.unifiedParam)) return;
    const value = values[getHyperParameterFormValueKey(param)];
    if (typeof value === 'number' && Number.isFinite(value)) {
      result = value;
    }
  });
  return result;
}

// =============================================================================
// Credential Status Indicator Sub-Component
// =============================================================================

function CredentialStatusIndicator({
  model,
  connectionStatus,
}: {
  model: ModelConfig;
  connectionStatus: boolean | null;
}) {
  const t = useTranslations('settings.models');
  if (model.authProfileId) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-info shrink-0">
        <Shield className="w-3 h-3" />
        <span className="hidden sm:inline">{t('edit_auth_profile')}</span>
      </span>
    );
  }
  if (model.credentialId) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted shrink-0">
        <Key className="w-3 h-3" />
        <span className="hidden sm:inline">{t('edit_legacy_credential')}</span>
      </span>
    );
  }
  if (connectionStatus !== false) {
    return null;
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-warning shrink-0">
      <AlertTriangle className="w-3 h-3" />
      <span className="hidden sm:inline">{t('edit_no_credentials')}</span>
    </span>
  );
}

// =============================================================================
// Inline Model Edit Panel Sub-Component
// =============================================================================

function ModelEditPanel({
  model,
  projectId,
  onSave,
  onCancel,
}: {
  model: ModelConfig;
  projectId: string;
  onSave: (id: string, updates: Partial<ModelConfig>) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useTranslations('settings.models');
  const [editState, setEditState] = useState<ModelEditState>(() => ({
    name: model.name,
    hyperParameters: {},
    responsesApiMode: booleanToPolicyMode(model.useResponsesApi),
    streamingMode: booleanToPolicyMode(model.useStreaming),
    credentialSource: model.authProfileId ? 'auth_profile' : 'legacy',
    authProfileId: model.authProfileId ?? null,
  }));
  const [hyperParams, setHyperParams] = useState<HyperParameter[]>([]);
  const [capabilitiesLoaded, setCapabilitiesLoaded] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadCapabilities() {
      setCapabilitiesLoaded(false);
      setHyperParams([]);
      try {
        const res = await apiFetch(getModelCapabilitiesUrl(model.modelId));
        if (!res.ok) return;
        const data = await res.json();
        const parameters = Array.isArray(data.hyperParameters)
          ? (data.hyperParameters as HyperParameter[])
          : [];
        if (cancelled) return;
        setHyperParams(parameters);
        setEditState((current) => ({
          ...current,
          hyperParameters: getDefaultHyperParameterValues(parameters, {
            ...(model.hyperParameters ?? {}),
            temperature: model.temperature,
            maxTokens: model.maxTokens,
            max_tokens: model.maxTokens,
            max_completion_tokens: model.maxTokens,
            maxOutputTokens: model.maxTokens,
          }),
        }));
      } catch {
        // Keep the rest of the editor usable if the capability lookup fails.
      } finally {
        if (!cancelled) setCapabilitiesLoaded(true);
      }
    }

    loadCapabilities();

    return () => {
      cancelled = true;
    };
  }, [model.hyperParameters, model.maxTokens, model.modelId, model.temperature]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const updates: Record<string, unknown> = {
        name: editState.name,
        useResponsesApi: policyModeToBoolean(editState.responsesApiMode),
        useStreaming: policyModeToBoolean(editState.streamingMode),
      };

      if (capabilitiesLoaded && hyperParams.length > 0) {
        updates.hyperParameters = { ...editState.hyperParameters };
        const temperature = extractProjectScalarFromHyperValues(
          hyperParams,
          editState.hyperParameters,
          ['temperature'],
        );
        const maxTokens = extractProjectScalarFromHyperValues(
          hyperParams,
          editState.hyperParameters,
          ['maxTokens', 'max_tokens', 'max_completion_tokens', 'maxOutputTokens'],
        );
        if (temperature !== undefined) updates.temperature = temperature;
        if (maxTokens !== undefined) updates.maxTokens = maxTokens;
      }

      if (editState.credentialSource === 'auth_profile') {
        updates.authProfileId = editState.authProfileId;
        // Clear legacy credential when switching to auth profile
        updates.credentialId = null;
      } else {
        // Clear auth profile when switching to legacy
        updates.authProfileId = null;
      }

      await onSave(model.id, updates as Partial<ModelConfig>);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="px-4 py-4 bg-background-muted border-t border-default space-y-4">
      {/* Model Name */}
      <Input
        label={t('edit_model_name')}
        type="text"
        value={editState.name}
        onChange={(e) => setEditState((s) => ({ ...s, name: e.target.value }))}
      />

      {capabilitiesLoaded && hyperParams.length > 0 && (
        <div className="space-y-3">
          <label className="block text-xs font-medium text-muted">
            {t('hyper_parameters_label')}
          </label>
          <HyperParameterForm
            parameters={hyperParams}
            values={editState.hyperParameters}
            onChange={(name, value) =>
              setEditState((s) => ({
                ...s,
                hyperParameters: { ...s.hyperParameters, [name]: value },
              }))
            }
            compact
          />
        </div>
      )}

      {/* Runtime policy overrides */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Select
          label={t('edit_responses_api')}
          value={editState.responsesApiMode}
          onChange={(value) =>
            setEditState((s) => ({ ...s, responsesApiMode: value as RuntimePolicyMode }))
          }
          options={[
            { value: 'inherit', label: t('edit_policy_inherit') },
            { value: 'enabled', label: t('edit_policy_enabled') },
            { value: 'disabled', label: t('edit_policy_disabled') },
          ]}
        />
        <Select
          label={t('edit_streaming')}
          value={editState.streamingMode}
          onChange={(value) =>
            setEditState((s) => ({ ...s, streamingMode: value as RuntimePolicyMode }))
          }
          options={[
            { value: 'inherit', label: t('edit_policy_inherit') },
            { value: 'enabled', label: t('edit_streaming_enabled') },
            { value: 'disabled', label: t('edit_streaming_disabled') },
          ]}
        />
      </div>
      <p className="text-xs text-muted">{t('edit_runtime_policy_hint')}</p>

      {/* Credential Source Toggle */}
      <div>
        <label className="block text-xs font-medium text-muted mb-2">
          {t('edit_credential_source')}
        </label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setEditState((s) => ({ ...s, credentialSource: 'legacy' }))}
            className={clsx(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm transition-default',
              editState.credentialSource === 'legacy'
                ? 'border-accent bg-accent-subtle text-foreground font-medium'
                : 'border-default bg-background-subtle text-muted hover:text-foreground',
            )}
          >
            <Key className="w-3.5 h-3.5" />
            {t('edit_legacy_credential')}
          </button>
          <button
            type="button"
            onClick={() => setEditState((s) => ({ ...s, credentialSource: 'auth_profile' }))}
            className={clsx(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm transition-default',
              editState.credentialSource === 'auth_profile'
                ? 'border-accent bg-accent-subtle text-foreground font-medium'
                : 'border-default bg-background-subtle text-muted hover:text-foreground',
            )}
          >
            <Shield className="w-3.5 h-3.5" />
            {t('edit_auth_profile')}
          </button>
        </div>
      </div>

      {/* Auth Profile Picker (shown when auth_profile source is selected) */}
      {editState.credentialSource === 'auth_profile' && (
        <div>
          <label className="block text-xs font-medium text-muted mb-1">
            {t('edit_auth_profile_label')}
          </label>
          <AuthProfilePicker
            projectId={projectId}
            value={editState.authProfileId}
            onChange={(profileId) => setEditState((s) => ({ ...s, authProfileId: profileId }))}
            filterAuthTypes={MODEL_AUTH_TYPES}
            consumerKind="http_tool"
            placeholder={t('edit_auth_profile_placeholder')}
          />
          <p className="text-xs text-muted mt-1">{t('edit_auth_profile_hint')}</p>
        </div>
      )}

      {/* Save / Cancel */}
      <div className="flex items-center justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={isSaving}>
          {t('edit_cancel')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          icon={<Check className="w-3.5 h-3.5" />}
          onClick={handleSave}
          loading={isSaving}
          disabled={!editState.name.trim()}
        >
          {t('edit_save_changes')}
        </Button>
      </div>
    </div>
  );
}

// =============================================================================
// Operation-Tier Mapping Sub-Component
// =============================================================================

function OperationTierSection({ projectId }: { projectId: string }) {
  const t = useTranslations('settings.operation_tiers');
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [routingEnabled, setRoutingEnabled] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/projects/${projectId}/llm-config`);
      if (!res.ok) return;
      const data = await res.json();
      const loadedOverrides = data.config?.operationTierOverrides || {};
      setOverrides(loadedOverrides);
      setRoutingEnabled(Object.keys(loadedOverrides).length > 0);
    } catch {
      // Silent — use empty defaults
    } finally {
      setIsLoaded(true);
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const operationTierOverrides = routingEnabled ? buildOperationTierOverrides(overrides) : {};
      const res = await apiFetch(`/api/projects/${projectId}/llm-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationTierOverrides }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || t('save_failed'));
      }
      setOverrides(operationTierOverrides);
      setRoutingEnabled(Object.keys(operationTierOverrides).length > 0);
      toast.success(t('saved'));
    } catch (error: unknown) {
      toast.error(sanitizeError(error, t('save_failed')));
    } finally {
      setIsSaving(false);
    }
  };

  if (!isLoaded) return null;

  const activeOverrides = routingEnabled ? buildOperationTierOverrides(overrides) : {};
  const overrideCount = Object.keys(activeOverrides).length;

  return (
    <section className="mt-8 pt-6 border-t border-default">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">{t('title')}</h3>
          <Tooltip content={t('tooltip')} side="right">
            <button
              type="button"
              className="inline-flex items-center justify-center p-0.5 text-muted hover:text-foreground transition-default rounded"
            >
              <Info className="w-3.5 h-3.5" />
            </button>
          </Tooltip>
        </div>
        <label className="inline-flex items-center gap-2 text-sm text-foreground cursor-pointer">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-default"
            checked={routingEnabled}
            onChange={(event) => {
              const enabled = event.target.checked;
              setRoutingEnabled(enabled);
              setOverrides(enabled ? buildOperationTierOverrides(overrides) : {});
            }}
          />
          {t('enable_label')}
        </label>
      </div>
      <p className="text-xs text-muted mb-3">
        {routingEnabled ? t('status_enabled') : t('status_disabled')}
      </p>
      <div className="rounded-lg border border-default overflow-hidden">
        <div className="grid grid-cols-[1fr_10rem] gap-2 px-4 py-2 bg-background-muted border-b border-default">
          <span className="text-xs font-medium text-muted uppercase tracking-wider">
            {t('header_operation')}
          </span>
          <span className="text-xs font-medium text-muted uppercase tracking-wider">
            {t('header_tier')}
          </span>
        </div>
        {OPERATIONS.map((op) => {
          const selected = activeOverrides[op.value] || op.defaultTier;
          return (
            <div
              key={op.value}
              className="grid grid-cols-[1fr_10rem] gap-2 px-4 py-2.5 border-b border-default last:border-0 items-center"
            >
              <span className="text-sm text-foreground">{op.label}</span>
              <div>
                <Select
                  value={selected}
                  disabled={!routingEnabled}
                  onChange={(v) => {
                    setOverrides((prev) => {
                      const next = buildOperationTierOverrides(prev);
                      next[op.value] = v;
                      return next;
                    });
                  }}
                  options={getOperationTierOptions(op.value).map((tier) => ({
                    value: tier,
                    label: tier.charAt(0).toUpperCase() + tier.slice(1),
                  }))}
                />
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between mt-3">
        <p className="text-xs text-muted">
          {overrideCount === 0 ? t('no_overrides') : t('override_count', { count: overrideCount })}
        </p>
        <Button
          variant="primary"
          size="sm"
          icon={<Check className="w-3.5 h-3.5" />}
          onClick={handleSave}
          loading={isSaving}
        >
          {t('save')}
        </Button>
      </div>
    </section>
  );
}

export function ModelConfigTab() {
  const t = useTranslations('settings');
  const { projectId, navigate } = useNavigationStore();
  const tenantId = useAuthStore((s) => s.tenantId);
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [tenantModels, setTenantModels] = useState<TenantModel[]>([]);
  const [loadingTenant, setLoadingTenant] = useState(false);
  const [catalogSearch, setCatalogSearch] = useState('');
  const [editingModelId, setEditingModelId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    setIsLoading(true);
    try {
      const res = await apiFetch(`/api/models?projectId=${projectId}`);
      const data = await res.json();
      setModels(data.models || []);
    } catch {
      // Will show empty state
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const loadTenantModels = useCallback(async () => {
    if (!tenantId) return;
    setLoadingTenant(true);
    try {
      const res = await apiFetch('/api/tenant-models');
      const data = await res.json();
      setTenantModels(data.models || []);
    } catch {
      toast.error(t('models.load_failed'));
    } finally {
      setLoadingTenant(false);
    }
  }, [tenantId]);

  // Load tenant models on mount for connection status in hero card
  useEffect(() => {
    loadTenantModels();
  }, [loadTenantModels]);

  const handleOpenAdd = () => {
    setShowAddDialog(true);
    setCatalogSearch('');
    loadTenantModels();
  };

  const handleAddModel = async (tm: TenantModel) => {
    if (!projectId) return;
    if (isTenantModelAlreadyAdded(models, tm)) {
      toast.error(t('models.already_added'));
      return;
    }
    const projectModelId = getProjectModelId(tm);
    const displayName = getTenantModelDisplayName(tm);
    const provider = getTenantModelProvider(tm);
    try {
      const capList = Array.isArray(tm.capabilities)
        ? tm.capabilities
        : tm.capabilities
          ? tm.capabilities.split(',')
          : [];
      await apiFetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          name: displayName,
          modelId: projectModelId,
          provider,
          tier: tm.tier || 'balanced',
          temperature: tm.temperature ?? 0.7,
          maxTokens: tm.maxTokens ?? 4096,
          hyperParameters: tm.hyperParameters ?? {},
          supportsTools: tm.supportsTools ?? capList.includes('tools'),
          supportsVision: tm.supportsVision ?? capList.includes('vision'),
          supportsStreaming: tm.supportsStreaming ?? capList.includes('streaming'),
          contextWindow: tm.contextWindow ?? 128000,
          isDefault: models.length === 0,
          tenantModelId: tm.id,
        }),
      });
      toast.success(`Added ${displayName}`);
      setShowAddDialog(false);
      load();
    } catch (err) {
      toast.error(sanitizeError(err, t('models.remove_failed')));
    }
  };

  const handleSetDefault = async (id: string) => {
    try {
      await apiFetch(`/api/models/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isDefault: true }),
      });
      setModels((prev) => {
        const target = prev.find((m) => m.id === id);
        return prev.map((m) => ({
          ...m,
          isDefault: m.id === id ? true : target && m.tier === target.tier ? false : m.isDefault,
        }));
      });
      toast.success(t('models.default_updated'));
    } catch {
      toast.error(t('models.update_failed'));
    }
  };

  const handleRemove = async (id: string) => {
    try {
      await apiFetch(`/api/models/${id}`, { method: 'DELETE' });
      setModels((prev) => prev.filter((m) => m.id !== id));
      if (editingModelId === id) setEditingModelId(null);
      toast.success(t('models.removed'));
    } catch {
      toast.error(t('models.remove_failed'));
    }
  };

  const handleSaveModel = async (id: string, updates: Partial<ModelConfig>) => {
    try {
      await apiFetch(`/api/models/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      // Update local state to reflect changes
      setModels((prev) => prev.map((m) => (m.id === id ? { ...m, ...updates } : m)));
      setEditingModelId(null);
      toast.success(t('models.settings_updated'));
    } catch (err) {
      toast.error(sanitizeError(err, t('models.update_failed')));
    }
  };

  const filteredTenantModels = tenantModels.filter((tm) => {
    if (!catalogSearch) return true;
    const q = catalogSearch.toLowerCase();
    return (
      (tm.displayName || '').toLowerCase().includes(q) ||
      (tm.modelId || '').toLowerCase().includes(q) ||
      tm.id.toLowerCase().includes(q) ||
      (tm.provider || '').toLowerCase().includes(q)
    );
  });

  if (isLoading) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-6">
        <SkeletonFormSection sections={3} />
      </div>
    );
  }

  // Derive hero card state
  const defaultModel = pickPrimaryDefaultModel(models);
  const tenantDefault = pickPrimaryDefaultModel(tenantModels);
  const defaultTenantModel = defaultModel?.tenantModelId
    ? tenantModels.find((tm) => tm.id === defaultModel.tenantModelId)
    : null;
  const tenantModelsLoaded = tenantModels.length > 0 || !loadingTenant;
  const defaultHasConnections = defaultModel?.authProfileId
    ? true // Auth profile assigned — credentials are managed via auth profile
    : defaultModel?.credentialId
      ? true // Legacy credential assigned
      : defaultTenantModel
        ? (defaultTenantModel._count?.connections ?? 0) > 0
        : !tenantModelsLoaded; // unknown while loading -> hide warning; once loaded and not found -> warn

  /** Look up connection count for a project model via its tenantModelId.
   * Returns true (has connections), false (no connections), or null (still loading). */
  const getConnectionStatus = (model: ModelConfig): boolean | null => {
    // Auth profile or legacy credential assigned at project level
    if (model.authProfileId || model.credentialId) return true;
    if (!model.tenantModelId) return tenantModelsLoaded ? false : null;
    const tm = tenantModels.find((t2) => t2.id === model.tenantModelId);
    if (!tm) return tenantModelsLoaded ? false : null;
    return (tm._count?.connections ?? 0) > 0;
  };

  const isEmptyStateShown = models.length === 0;

  return (
    <TooltipProvider>
      <div className="space-y-6 max-w-4xl mx-auto px-6 py-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-foreground">{t('models.page_title')}</h2>
            <p className="text-sm text-muted mt-1">{t('models.page_description')}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              icon={<RefreshCw className="w-3.5 h-3.5" />}
              onClick={() => {
                load();
                loadTenantModels();
              }}
            >
              {t('models.refresh')}
            </Button>
            {!isEmptyStateShown && (
              <Button
                variant="primary"
                size="sm"
                icon={<Plus className="w-3.5 h-3.5" />}
                onClick={handleOpenAdd}
              >
                {t('models.add_model')}
              </Button>
            )}
          </div>
        </div>

        {/* Warning Banner: default model has no credentials */}
        {defaultModel && !defaultHasConnections && (
          <div className="flex items-start gap-3 p-3 rounded-lg border border-warning/30 bg-warning-subtle">
            <AlertTriangle className="w-4 h-4 text-warning mt-0.5 shrink-0" />
            <div className="text-sm text-foreground">
              Your default model &quot;{defaultModel.name}&quot; may not have active credentials.
              Check workspace model settings.{' '}
              <button
                onClick={() => navigate('/admin/models')}
                className="text-info hover:underline font-medium"
              >
                Go to Workspace Models &rarr;
              </button>
            </div>
          </div>
        )}

        {models.length === 0 ? (
          /* Enhanced Empty State */
          <EmptyState
            icon={<Brain className="w-6 h-6" />}
            title="Add models to your project"
            description="Select models from your workspace catalog to use in this project. The first model you add becomes the default."
            action={
              <div className="flex items-center gap-3">
                <Button
                  variant="primary"
                  size="sm"
                  icon={<Plus className="w-3.5 h-3.5" />}
                  onClick={handleOpenAdd}
                >
                  Add from Catalog
                </Button>
                <button
                  onClick={() => navigate('/admin/models')}
                  className="text-sm text-info hover:underline"
                >
                  Configure Workspace &rarr;
                </button>
              </div>
            }
          />
        ) : (
          <>
            {/* Hero Default Model Card */}
            <div className="rounded-xl border border-default bg-background-elevated p-5">
              {defaultModel ? (
                <div className="flex items-start justify-between">
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Brain className="w-5 h-5 text-accent" />
                      <h3 className="text-base font-semibold text-foreground">
                        {defaultModel.name}
                      </h3>
                      <Badge variant="success">Default</Badge>
                      {defaultHasConnections ? (
                        <span className="inline-flex items-center gap-1 text-xs text-success">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          Ready
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs text-warning">
                          <AlertTriangle className="w-3.5 h-3.5" />
                          No credentials
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-sm text-muted">
                      <Badge
                        variant={
                          PROVIDER_BADGE_VARIANT[defaultModel.provider.toLowerCase()] || 'default'
                        }
                      >
                        {defaultModel.provider}
                      </Badge>
                      <span className="font-mono text-xs">{defaultModel.modelId}</span>
                    </div>
                  </div>
                </div>
              ) : tenantDefault ? (
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <Brain className="w-5 h-5 text-muted" />
                      <h3 className="text-sm font-medium text-muted">
                        Using workspace default:{' '}
                        <span className="text-foreground font-semibold">
                          {getTenantModelDisplayName(tenantDefault)}
                        </span>
                      </h3>
                    </div>
                    <p className="text-xs text-muted ml-7">
                      No project-level default set. The workspace default will be used.
                    </p>
                  </div>
                  <Button variant="secondary" size="sm" onClick={handleOpenAdd}>
                    Set Project Override
                  </Button>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Brain className="w-5 h-5 text-muted" />
                    <p className="text-sm text-muted">
                      No default model configured. Add one from the workspace catalog.
                    </p>
                  </div>
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<Plus className="w-3.5 h-3.5" />}
                    onClick={handleOpenAdd}
                  >
                    {t('models.add_model')}
                  </Button>
                </div>
              )}
            </div>

            {/* Model List with Inline Editing */}
            <div>
              <p className="text-sm text-muted mb-2">
                {t('models.count', { count: models.length })}
              </p>
              <div className="rounded-lg border border-default overflow-hidden divide-y divide-default">
                {models.map((model) => {
                  const connStatus = getConnectionStatus(model);
                  const isEditing = editingModelId === model.id;
                  return (
                    <div key={model.id}>
                      <div
                        className={clsx(
                          'flex items-center gap-3 px-4 py-3 bg-background-elevated hover:bg-background-muted transition-default',
                          isEditing && 'bg-background-muted',
                        )}
                      >
                        {/* Star toggle */}
                        <button
                          onClick={() => !model.isDefault && handleSetDefault(model.id)}
                          className={clsx(
                            'shrink-0 p-0.5 rounded transition-default',
                            model.isDefault
                              ? 'text-warning cursor-default'
                              : 'text-muted hover:text-warning cursor-pointer',
                          )}
                          title={
                            model.isDefault ? t('models.default_label') : t('models.set_default')
                          }
                        >
                          <Star
                            className="w-4 h-4"
                            fill={model.isDefault ? 'currentColor' : 'none'}
                          />
                        </button>

                        {/* Model info */}
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <span className="text-sm font-medium text-foreground truncate">
                            {model.name}
                          </span>
                          <Badge
                            variant={
                              PROVIDER_BADGE_VARIANT[model.provider.toLowerCase()] || 'default'
                            }
                            className="text-xs px-1.5 py-0"
                          >
                            {model.provider}
                          </Badge>
                          <span className="text-xs text-muted font-mono truncate hidden sm:inline">
                            {model.modelId}
                          </span>
                        </div>

                        {/* Auth profile / credential status */}
                        <CredentialStatusIndicator model={model} connectionStatus={connStatus} />

                        {/* Connection status */}
                        {connStatus !== null && (
                          <span
                            className={clsx(
                              'inline-flex items-center gap-1 text-xs shrink-0',
                              connStatus ? 'text-success' : 'text-warning',
                            )}
                          >
                            {connStatus ? (
                              <CheckCircle2 className="w-3 h-3" />
                            ) : (
                              <AlertTriangle className="w-3 h-3" />
                            )}
                            <span className="hidden sm:inline">
                              {connStatus ? 'Ready' : 'No keys'}
                            </span>
                          </span>
                        )}

                        {/* Capability badges */}
                        {model.supportsTools && (
                          <Badge variant="info" className="text-xs px-1.5 py-0">
                            Tools
                          </Badge>
                        )}
                        {model.supportsVision && (
                          <Badge variant="info" className="text-xs px-1.5 py-0">
                            Vision
                          </Badge>
                        )}

                        {/* Edit toggle button */}
                        <button
                          onClick={() => setEditingModelId(isEditing ? null : model.id)}
                          className={clsx(
                            'shrink-0 p-1.5 rounded transition-default',
                            isEditing
                              ? 'text-accent bg-accent-subtle'
                              : 'text-muted hover:text-foreground',
                          )}
                          title={isEditing ? 'Close editor' : 'Edit model settings'}
                        >
                          {isEditing ? (
                            <X className="w-3.5 h-3.5" />
                          ) : (
                            <Pencil className="w-3.5 h-3.5" />
                          )}
                        </button>

                        {/* Remove button */}
                        <button
                          onClick={() => handleRemove(model.id)}
                          className="shrink-0 p-1.5 text-muted hover:text-error rounded transition-default"
                          title={t('models.remove')}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      {/* Inline Edit Panel */}
                      {isEditing && projectId && (
                        <ModelEditPanel
                          model={model}
                          projectId={projectId}
                          onSave={handleSaveModel}
                          onCancel={() => setEditingModelId(null)}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}

        {/* Collapsible Operation Tier Section */}
        {projectId && (
          <details className="mt-6 pt-6 border-t border-default">
            <summary className="cursor-pointer text-sm font-medium text-muted hover:text-foreground transition-default">
              Advanced: Operation Routing
            </summary>
            <div className="mt-4">
              <OperationTierSection projectId={projectId} />
            </div>
          </details>
        )}

        {/* Add Model from Tenant Catalog Dialog */}
        <Dialog
          open={showAddDialog}
          onClose={() => setShowAddDialog(false)}
          title={t('models.add_dialog_title')}
          maxWidth="lg"
        >
          <div className="space-y-3">
            <p className="text-sm text-muted">{t('models.add_dialog_description')}</p>

            {/* Search input */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
              <input
                type="text"
                placeholder={t('models.search_placeholder')}
                value={catalogSearch}
                onChange={(e) => setCatalogSearch(e.target.value)}
                className="w-full rounded-lg border border-default bg-background-subtle text-foreground text-sm py-2 pl-9 pr-3 focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
              />
            </div>

            {loadingTenant ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-5 h-5 text-muted animate-spin" />
              </div>
            ) : tenantModels.length === 0 ? (
              <div className="py-8 text-center text-sm">
                <p className="text-muted">{t('models.no_tenant_catalog')}</p>
                <button
                  onClick={() => {
                    setShowAddDialog(false);
                    navigate('/admin/models');
                  }}
                  className="text-info hover:underline mt-1 inline-block"
                >
                  {t('models.configure_workspace')}
                </button>
              </div>
            ) : filteredTenantModels.length === 0 ? (
              <div className="py-8 text-center text-muted text-sm">
                {t('models.no_search_match')}
              </div>
            ) : (
              <div className="space-y-2 max-h-[400px] overflow-y-auto">
                {filteredTenantModels.map((tm) => {
                  const alreadyAdded = isTenantModelAlreadyAdded(models, tm);
                  const connCount = tm._count?.connections ?? 0;
                  const hasConnections = connCount > 0;
                  return (
                    <div
                      key={tm.id}
                      className="p-3 rounded-lg border border-default bg-background-subtle flex items-center justify-between"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-foreground truncate">
                            {getTenantModelDisplayName(tm)}
                          </span>
                          <Badge variant={TIER_VARIANT[tm.tier] || 'default'}>{tm.tier}</Badge>
                          {hasConnections ? (
                            <span className="inline-flex items-center gap-1">
                              <span className="w-1.5 h-1.5 rounded-full bg-success" />
                              <span className="text-xs text-muted">{connCount} conn</span>
                            </span>
                          ) : (
                            <span
                              className="inline-flex items-center gap-1"
                              title={t('models.no_credentials_warning')}
                            >
                              <AlertTriangle className="w-3 h-3 text-warning" />
                              <span className="text-xs text-warning">{t('models.no_keys')}</span>
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-muted mt-0.5">
                          {formatModelIdentityLine(tm) || tm.id}
                        </div>
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => handleAddModel(tm)}
                        disabled={alreadyAdded}
                      >
                        {alreadyAdded ? t('models.added') : t('models.add')}
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Dialog>
      </div>
    </TooltipProvider>
  );
}
