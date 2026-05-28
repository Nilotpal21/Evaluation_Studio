/**
 * GuardrailProviderForm Component
 *
 * Dialog form for creating/editing guardrail providers.
 * Includes adapter type, endpoint, model, hosting, default category/threshold,
 * circuit breaker config, retry config, and auth profile integration.
 */

import { useState, useCallback, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { clsx } from 'clsx';
import { GuardrailYamlEditor, toYaml, fromYaml } from '../guardrails/GuardrailYamlEditor';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Dialog } from '../ui/Dialog';
import { Toggle } from '../ui/Toggle';
import { AuthProfilePicker } from '../auth-profiles/AuthProfilePicker';
import { AuthProfileToggle } from '../auth-profiles/AuthProfileToggle';
import { toast } from 'sonner';
import { useProjectStore } from '../../store/project-store';
import type {
  GuardrailProvider,
  CreateProviderInput,
  CircuitBreakerConfig,
  RetryConfig,
} from '../../hooks/useGuardrails';

import { IMPLEMENTED_GUARDRAIL_ADAPTER_TYPES } from '@agent-platform/database/constants/guardrail-adapters';

/** Display labels for implemented adapter types (UI concern only). */
const ADAPTER_TYPE_LABELS: Record<string, string> = {
  openai_moderation: 'OpenAI Moderation',
  custom_llm: 'Custom LLM',
  custom_http: 'Custom HTTP',
  custom_webhook: 'Custom Webhook',
};

const ADAPTER_TYPE_OPTIONS = IMPLEMENTED_GUARDRAIL_ADAPTER_TYPES.map((value) => ({
  value,
  label: ADAPTER_TYPE_LABELS[value] ?? value,
}));

const HOSTING_OPTIONS = [
  { value: 'cloud_api', label: 'Cloud API' },
  { value: 'self_hosted', label: 'Self-Hosted' },
  { value: 'managed_service', label: 'Managed Service' },
];

interface GuardrailProviderFormProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: CreateProviderInput) => Promise<void>;
  initial?: GuardrailProvider;
}

type ProviderHosting = 'cloud_api' | 'self_hosted' | 'managed_service';

function parsePositiveInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
  }
  return fallback;
}

function getRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeCircuitBreaker(value: unknown): CircuitBreakerConfig {
  const record = getRecord(value);
  const failMode =
    record.failMode === 'open' || record.failMode === 'closed' ? record.failMode : undefined;
  return {
    failureThreshold: parsePositiveInt(record.failureThreshold ?? record.maxFailures, 5),
    resetTimeoutMs: parsePositiveInt(record.resetTimeoutMs ?? record.resetTimeout, 30_000),
    ...(failMode ? { failMode } : {}),
  };
}

function normalizeRetry(value: unknown): RetryConfig {
  const record = getRecord(value);
  const legacyBackoff = record.backoff;
  return {
    maxRetries: parsePositiveInt(record.maxRetries, 3),
    backoffBaseMs: parsePositiveInt(
      record.backoffBaseMs ?? (typeof legacyBackoff === 'number' ? legacyBackoff : undefined),
      1000,
    ),
  };
}

function advancedProviderFields(source: unknown): Partial<CreateProviderInput> {
  const record = getRecord(source);
  const fields: Partial<CreateProviderInput> = {};
  if (Array.isArray(record.supportedCategories)) {
    fields.supportedCategories = record.supportedCategories
      .filter((category): category is string => typeof category === 'string')
      .map((category) => category.trim())
      .filter(Boolean);
  }
  if (
    record.customMapping &&
    typeof record.customMapping === 'object' &&
    !Array.isArray(record.customMapping)
  ) {
    fields.customMapping = record.customMapping as Record<string, unknown>;
  }
  if (
    record.selfHostedConfig &&
    typeof record.selfHostedConfig === 'object' &&
    !Array.isArray(record.selfHostedConfig)
  ) {
    fields.selfHostedConfig = record.selfHostedConfig as Record<string, unknown>;
  }
  if (typeof record.costPerEvalUsd === 'number' && Number.isFinite(record.costPerEvalUsd)) {
    fields.costPerEvalUsd = record.costPerEvalUsd;
  }
  return fields;
}

function authProfileSubmitValue(
  useAuthProfile: boolean,
  authProfileId: string | null,
  initial?: GuardrailProvider,
): string | null | undefined {
  if (useAuthProfile) {
    return authProfileId || undefined;
  }

  return initial?.authProfileId ? null : undefined;
}

export function GuardrailProviderForm({
  open,
  onClose,
  onSubmit,
  initial,
}: GuardrailProviderFormProps) {
  const t = useTranslations('admin');
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const projects = useProjectStore((s) => s.projects);
  const resolvedProjectId = currentProjectId || projects[0]?.id || null;
  const initialCircuitBreaker = normalizeCircuitBreaker(initial?.circuitBreaker);
  const initialRetry = normalizeRetry(initial?.retry);

  // Basic fields
  const [name, setName] = useState(initial?.name || '');
  const [displayName, setDisplayName] = useState(initial?.displayName || '');
  const [type, setType] = useState(initial?.adapterType || 'openai_moderation');
  const [endpoint, setEndpoint] = useState(initial?.endpoint || '');
  const [model, setModel] = useState(initial?.model || '');
  const [hosting, setHosting] = useState<ProviderHosting>(initial?.hosting || 'cloud_api');
  const [enabled, setEnabled] = useState(initial?.isActive ?? true);

  // Auth profile state
  const [useAuthProfile, setUseAuthProfile] = useState(!!initial?.authProfileId);
  const [authProfileId, setAuthProfileId] = useState<string | null>(initial?.authProfileId || null);

  // Default category & threshold
  const [defaultCategory, setDefaultCategory] = useState(initial?.defaultCategory || '');
  const [defaultThreshold, setDefaultThreshold] = useState<string>(
    initial?.defaultThreshold != null ? String(initial.defaultThreshold) : '0.7',
  );

  // Circuit breaker config
  const [cbMaxFailures, setCbMaxFailures] = useState<string>(
    String(initialCircuitBreaker.failureThreshold),
  );
  const [cbResetTimeout, setCbResetTimeout] = useState<string>(
    String(initialCircuitBreaker.resetTimeoutMs),
  );

  // Retry config
  const [retryMaxRetries, setRetryMaxRetries] = useState<string>(String(initialRetry.maxRetries));
  const [retryBackoffBaseMs, setRetryBackoffBaseMs] = useState<string>(
    String(initialRetry.backoffBaseMs),
  );

  const [saving, setSaving] = useState(false);

  // Form/YAML tab state
  type ProviderFormTab = 'form' | 'yaml';
  const [activeTab, setActiveTab] = useState<ProviderFormTab>('form');
  const [yamlValue, setYamlValue] = useState('');

  useEffect(() => {
    if (!open) return;

    const circuitBreaker = normalizeCircuitBreaker(initial?.circuitBreaker);
    const retry = normalizeRetry(initial?.retry);
    setName(initial?.name || '');
    setDisplayName(initial?.displayName || '');
    setType(initial?.adapterType || 'openai_moderation');
    setEndpoint(initial?.endpoint || '');
    setModel(initial?.model || '');
    setHosting(initial?.hosting || 'cloud_api');
    setEnabled(initial?.isActive ?? true);
    setUseAuthProfile(!!initial?.authProfileId);
    setAuthProfileId(initial?.authProfileId || null);
    setDefaultCategory(initial?.defaultCategory || '');
    setDefaultThreshold(
      initial?.defaultThreshold != null ? String(initial.defaultThreshold) : '0.7',
    );
    setCbMaxFailures(String(circuitBreaker.failureThreshold));
    setCbResetTimeout(String(circuitBreaker.resetTimeoutMs));
    setRetryMaxRetries(String(retry.maxRetries));
    setRetryBackoffBaseMs(String(retry.backoffBaseMs));
    setActiveTab('form');
    setYamlValue('');
  }, [open, initial?._id]);

  const formToObj = useCallback(
    (): Record<string, unknown> => ({
      name: name.trim(),
      displayName: displayName.trim() || undefined,
      adapterType: type,
      endpoint: endpoint.trim() || undefined,
      model: model.trim() || undefined,
      hosting,
      authProfileId: authProfileSubmitValue(useAuthProfile, authProfileId, initial),
      defaultCategory: defaultCategory.trim() || undefined,
      defaultThreshold: defaultThreshold ? parseFloat(defaultThreshold) : undefined,
      circuitBreaker: {
        failureThreshold: parsePositiveInt(cbMaxFailures, 5),
        resetTimeoutMs: parsePositiveInt(cbResetTimeout, 30_000),
        ...(initialCircuitBreaker.failMode ? { failMode: initialCircuitBreaker.failMode } : {}),
      },
      retry: {
        maxRetries: parsePositiveInt(retryMaxRetries, 3),
        backoffBaseMs: parsePositiveInt(retryBackoffBaseMs, 1000),
      },
      ...advancedProviderFields(initial),
      isActive: enabled,
    }),
    [
      name,
      displayName,
      type,
      endpoint,
      model,
      hosting,
      useAuthProfile,
      authProfileId,
      defaultCategory,
      defaultThreshold,
      cbMaxFailures,
      cbResetTimeout,
      retryMaxRetries,
      retryBackoffBaseMs,
      initial,
      initialCircuitBreaker.failMode,
      enabled,
    ],
  );

  const switchToYaml = useCallback(() => {
    setYamlValue(toYaml(formToObj()));
    setActiveTab('yaml');
  }, [formToObj]);

  const switchToForm = useCallback(() => {
    const parsed = fromYaml(yamlValue);
    if (parsed) {
      if (typeof parsed.name === 'string') setName(parsed.name);
      if (typeof parsed.displayName === 'string') setDisplayName(parsed.displayName);
      if (typeof parsed.adapterType === 'string') setType(parsed.adapterType);
      if (typeof parsed.endpoint === 'string') setEndpoint(parsed.endpoint);
      if (typeof parsed.model === 'string') setModel(parsed.model);
      if (typeof parsed.hosting === 'string')
        setHosting(parsed.hosting as 'cloud_api' | 'self_hosted' | 'managed_service');
      if (typeof parsed.defaultCategory === 'string') setDefaultCategory(parsed.defaultCategory);
      if (parsed.defaultThreshold != null) setDefaultThreshold(String(parsed.defaultThreshold));
      if (parsed.circuitBreaker) {
        const circuitBreaker = normalizeCircuitBreaker(parsed.circuitBreaker);
        setCbMaxFailures(String(circuitBreaker.failureThreshold));
        setCbResetTimeout(String(circuitBreaker.resetTimeoutMs));
      }
      if (parsed.retry) {
        const retry = normalizeRetry(parsed.retry);
        setRetryMaxRetries(String(retry.maxRetries));
        setRetryBackoffBaseMs(String(retry.backoffBaseMs));
      }
      if (parsed.isActive != null) setEnabled(Boolean(parsed.isActive));
      if (typeof parsed.authProfileId === 'string') {
        setUseAuthProfile(true);
        setAuthProfileId(parsed.authProfileId);
      }
    }
    setActiveTab('form');
  }, [yamlValue]);

  const handleSubmit = async () => {
    if (!name.trim() && activeTab === 'form') return;
    setSaving(true);
    try {
      let submitInput: CreateProviderInput;

      if (activeTab === 'yaml') {
        const parsed = fromYaml(yamlValue);
        if (!parsed) {
          toast.error('Invalid YAML — please fix parse errors before submitting.');
          setSaving(false);
          return;
        }
        // Extract fields from parsed YAML
        submitInput = {
          name: String(parsed.name ?? '').trim(),
          displayName: parsed.displayName ? String(parsed.displayName).trim() : undefined,
          adapterType: String(parsed.adapterType ?? 'openai_moderation'),
          endpoint: parsed.endpoint ? String(parsed.endpoint).trim() : undefined,
          model: parsed.model ? String(parsed.model).trim() : undefined,
          hosting:
            (parsed.hosting as 'cloud_api' | 'self_hosted' | 'managed_service') || 'cloud_api',
          defaultCategory: parsed.defaultCategory
            ? String(parsed.defaultCategory).trim()
            : undefined,
          defaultThreshold:
            typeof parsed.defaultThreshold === 'number' ? parsed.defaultThreshold : undefined,
          circuitBreaker: normalizeCircuitBreaker(parsed.circuitBreaker),
          retry: normalizeRetry(parsed.retry),
          authProfileId: parsed.authProfileId ? String(parsed.authProfileId).trim() : undefined,
          ...advancedProviderFields(parsed),
          isActive: parsed.isActive != null ? Boolean(parsed.isActive) : true,
        };
      } else {
        // Original form-based submit logic
        const circuitBreaker: CircuitBreakerConfig = {
          failureThreshold: parsePositiveInt(cbMaxFailures, 5),
          resetTimeoutMs: parsePositiveInt(cbResetTimeout, 30_000),
          ...(initialCircuitBreaker.failMode ? { failMode: initialCircuitBreaker.failMode } : {}),
        };
        const retry: RetryConfig = {
          maxRetries: parsePositiveInt(retryMaxRetries, 3),
          backoffBaseMs: parsePositiveInt(retryBackoffBaseMs, 1000),
        };
        submitInput = {
          name: name.trim(),
          displayName: displayName.trim() || undefined,
          adapterType: type,
          endpoint: endpoint.trim() || undefined,
          model: model.trim() || undefined,
          hosting,
          defaultCategory: defaultCategory.trim() || undefined,
          defaultThreshold: defaultThreshold ? parseFloat(defaultThreshold) : undefined,
          circuitBreaker,
          retry,
          authProfileId: authProfileSubmitValue(useAuthProfile, authProfileId, initial),
          ...advancedProviderFields(initial),
          isActive: enabled,
        };
      }

      await onSubmit(submitInput);
      toast.success(initial ? t('guardrails.provider_updated') : t('guardrails.provider_created'));
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('guardrails.provider_save_failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="lg">
      <div className="space-y-5">
        <div>
          <h3 className="text-lg font-semibold text-foreground">
            {initial ? t('guardrails.edit_provider_title') : t('guardrails.add_provider_title')}
          </h3>
          <p className="text-sm text-muted mt-1">{t('guardrails.provider_form_description')}</p>
        </div>

        {/* Form / YAML tabs */}
        <div className="flex border-b border-default">
          <button
            type="button"
            onClick={() => (activeTab === 'yaml' ? switchToForm() : undefined)}
            className={clsx(
              'px-4 py-2 text-sm font-medium transition-default border-b-2 -mb-px',
              activeTab === 'form'
                ? 'border-accent text-accent'
                : 'border-transparent text-muted hover:text-foreground',
            )}
          >
            Form
          </button>
          <button
            type="button"
            onClick={() => (activeTab === 'form' ? switchToYaml() : undefined)}
            className={clsx(
              'px-4 py-2 text-sm font-medium transition-default border-b-2 -mb-px',
              activeTab === 'yaml'
                ? 'border-accent text-accent'
                : 'border-transparent text-muted hover:text-foreground',
            )}
          >
            YAML
          </button>
        </div>

        {activeTab === 'yaml' && (
          <GuardrailYamlEditor value={yamlValue} onChange={setYamlValue} height="400px" />
        )}

        {activeTab === 'form' && (
          <>
            {/* Basic Info */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input
                label={t('guardrails.provider_name_label')}
                placeholder={t('guardrails.provider_name_placeholder')}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <Input
                label={t('guardrails.display_name_label')}
                placeholder={t('guardrails.display_name_placeholder')}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>

            {/* Adapter & Hosting */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Select
                label={t('guardrails.provider_type_label')}
                options={ADAPTER_TYPE_OPTIONS}
                value={type}
                onChange={setType}
              />
              <Select
                label={t('guardrails.hosting_label')}
                options={HOSTING_OPTIONS}
                value={hosting}
                onChange={(v) => setHosting(v as 'cloud_api' | 'self_hosted' | 'managed_service')}
              />
            </div>

            {/* Endpoint & Model */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input
                label={t('guardrails.endpoint_label')}
                placeholder={t('guardrails.endpoint_placeholder')}
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
              />
              <Input
                label={t('guardrails.model_label')}
                placeholder={t('guardrails.model_placeholder')}
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
            </div>

            {/* Authentication: Auth Profile toggle or API Key */}
            <div>
              {resolvedProjectId && (
                <AuthProfileToggle
                  enabled={useAuthProfile}
                  onToggle={(val) => {
                    setUseAuthProfile(val);
                    if (!val) {
                      setAuthProfileId(null);
                    }
                  }}
                  label={t('guardrails.authentication_title')}
                  className="mb-3"
                />
              )}

              {useAuthProfile && resolvedProjectId ? (
                <div>
                  <AuthProfilePicker
                    projectId={resolvedProjectId}
                    value={authProfileId}
                    onChange={setAuthProfileId}
                    filterAuthTypes={['api_key', 'bearer']}
                    filterStatus="active"
                    filterScope="tenant"
                    filterVisibility="shared"
                    consumerKind="http_tool"
                    placeholder={t('guardrails.auth_profile_placeholder')}
                  />
                  <p className="text-xs text-muted mt-1.5">{t('guardrails.auth_profile_hint')}</p>
                </div>
              ) : (
                <p className="rounded-lg border border-default bg-background-subtle px-3 py-2 text-xs text-muted">
                  {t('guardrails.auth_profile_required_hint')}
                </p>
              )}
            </div>

            {/* Default Category & Threshold */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input
                label={t('guardrails.default_category_label')}
                placeholder={t('guardrails.default_category_placeholder')}
                value={defaultCategory}
                onChange={(e) => setDefaultCategory(e.target.value)}
              />
              <Input
                label={t('guardrails.default_threshold_label')}
                placeholder="0.7"
                type="number"
                min="0"
                max="1"
                step="0.01"
                value={defaultThreshold}
                onChange={(e) => setDefaultThreshold(e.target.value)}
              />
            </div>

            {/* Circuit Breaker Config */}
            <div>
              <p className="text-sm font-medium text-foreground mb-2">
                {t('guardrails.circuit_breaker_title')}
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Input
                  label={t('guardrails.cb_max_failures_label')}
                  placeholder="5"
                  type="number"
                  min="1"
                  value={cbMaxFailures}
                  onChange={(e) => setCbMaxFailures(e.target.value)}
                />
                <Input
                  label={t('guardrails.cb_reset_timeout_label')}
                  placeholder="30000"
                  type="number"
                  min="1000"
                  step="1000"
                  value={cbResetTimeout}
                  onChange={(e) => setCbResetTimeout(e.target.value)}
                />
              </div>
            </div>

            {/* Retry Config */}
            <div>
              <p className="text-sm font-medium text-foreground mb-2">
                {t('guardrails.retry_title')}
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Input
                  label={t('guardrails.retry_max_retries_label')}
                  placeholder="3"
                  type="number"
                  min="0"
                  max="10"
                  value={retryMaxRetries}
                  onChange={(e) => setRetryMaxRetries(e.target.value)}
                />
                <Input
                  label={t('guardrails.retry_backoff_label')}
                  placeholder="1000"
                  type="number"
                  min="0"
                  step="100"
                  value={retryBackoffBaseMs}
                  onChange={(e) => setRetryBackoffBaseMs(e.target.value)}
                />
              </div>
            </div>

            {/* Enabled Toggle */}
            <Toggle
              checked={enabled}
              onChange={setEnabled}
              label={t('guardrails.enabled_label')}
              description={t('guardrails.enabled_description')}
            />
          </>
        )}

        {/* Actions */}
        <div className="flex gap-3 pt-2">
          <Button variant="secondary" onClick={onClose} className="flex-1">
            {t('guardrails.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            loading={saving}
            disabled={activeTab === 'form' && !name.trim()}
            className="flex-1"
          >
            {initial ? t('guardrails.update_provider') : t('guardrails.add_provider')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
