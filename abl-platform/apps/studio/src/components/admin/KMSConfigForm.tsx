import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Layers3, Loader2, Shield, Trash2, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '../ui/Alert';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Section } from '../ui/Section';
import { Toggle } from '../ui/Toggle';
import {
  type KMSConfigData,
  type KMSComplianceLevel,
  type KMSConfigUpdateInput,
  type KMSEffectiveScopeStep,
  type KMSEnvironmentOverride,
  type KMSFailurePolicy,
  type KMSProjectOverride,
  type KMSProviderAuthMethod,
  type KMSProviderInput,
  type KMSProviderRef,
  type KMSProviderType,
  type KMSValidateResult,
  deleteProjectEnvironmentKMSConfig,
  deleteProjectKMSConfig,
  deleteTenantEnvironmentKMSConfig,
  updateKMSConfig,
  updateProjectEnvironmentKMSConfig,
  updateProjectKMSConfig,
  updateTenantEnvironmentKMSConfig,
  useKMSConfig,
  useKMSEffectiveConfig,
  validateExternalKMS,
} from '../../hooks/useKMS';
import { ProviderConfigFields, type ProviderFieldsState } from './ProviderConfigFields';
import { getSupportedAuthMethods, parseAuthConfig } from './kms-utils';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_DEK_EPOCH_INTERVAL_HOURS = 24;
const DEFAULT_DEK_MAX_USAGE_COUNT = 2 ** 30;
const DEFAULT_KEK_ROTATION_DAYS = 365;
const DEFAULT_DEK_RETENTION_DAYS = 90;
const DEFAULT_REENCRYPTION_CONCURRENCY = 1;
const DEFAULT_REENCRYPTION_BATCH_SIZE = 50;
const DEFAULT_REENCRYPTION_MAX_RETRIES = 3;
const DEFAULT_EXTERNAL_MAX_LATENCY_MS = 2_000;
const DEFAULT_LOCAL_KEY_ID = 'platform-default';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ScopeType = 'tenant-environment' | 'project' | 'project-environment';

type FormState = {
  providerType: KMSProviderType;
  keyId: string;
  region: string;
  vaultUrl: string;
  externalEndpoint: string;
  authMethod: KMSProviderAuthMethod | '';
  authConfigJson: string;
  failurePolicy: KMSFailurePolicy;
  complianceLevel: KMSComplianceLevel;
  dekEpochIntervalHours: number;
  dekMaxUsageCount: number;
  destroyRetiredDeks: boolean;
  dekRetentionDays: number;
  kekRotationPeriodDays: number;
  reencryptionEnabled: boolean;
  reencryptionConcurrency: number;
  reencryptionBatchSize: number;
  reencryptionMaxRetries: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseInteger(value: string, fallback: number, min = 1): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    return fallback;
  }
  return parsed;
}

function buildInitialForm(config: KMSConfigData | null): FormState {
  const provider = config?.defaultProvider;
  return {
    providerType: provider?.providerType ?? 'local',
    keyId: provider?.keyId ?? '',
    region: provider?.region ?? '',
    vaultUrl: provider?.vaultUrl ?? '',
    externalEndpoint: provider?.externalEndpoint ?? '',
    authMethod: provider?.authMethod ?? '',
    authConfigJson: '',
    failurePolicy: config?.failurePolicy ?? 'fail-closed',
    complianceLevel: config?.complianceLevel ?? 'standard',
    dekEpochIntervalHours: config?.dekEpochIntervalHours ?? DEFAULT_DEK_EPOCH_INTERVAL_HOURS,
    dekMaxUsageCount: config?.dekMaxUsageCount ?? DEFAULT_DEK_MAX_USAGE_COUNT,
    destroyRetiredDeks: config?.dekRetentionDays != null,
    dekRetentionDays: config?.dekRetentionDays ?? DEFAULT_DEK_RETENTION_DAYS,
    kekRotationPeriodDays: config?.kekRotationPeriodDays ?? DEFAULT_KEK_ROTATION_DAYS,
    reencryptionEnabled: config?.reencryption?.enabled ?? true,
    reencryptionConcurrency: config?.reencryption?.concurrency ?? DEFAULT_REENCRYPTION_CONCURRENCY,
    reencryptionBatchSize: config?.reencryption?.batchSize ?? DEFAULT_REENCRYPTION_BATCH_SIZE,
    reencryptionMaxRetries: config?.reencryption?.maxRetries ?? DEFAULT_REENCRYPTION_MAX_RETRIES,
  };
}

type Translator = ReturnType<typeof useTranslations>;

function providerToScopeForm(provider: KMSProviderRef | null | undefined): ProviderFieldsState {
  if (!provider) {
    return {
      providerType: 'local',
      keyId: DEFAULT_LOCAL_KEY_ID,
      region: '',
      vaultUrl: '',
      externalEndpoint: '',
      authMethod: '',
      authConfigJson: '',
    };
  }
  return {
    providerType: provider.providerType,
    keyId: provider.keyId || DEFAULT_LOCAL_KEY_ID,
    region: provider.region ?? '',
    vaultUrl: provider.vaultUrl ?? '',
    externalEndpoint: provider.externalEndpoint ?? '',
    authMethod: provider.authMethod ?? '',
    authConfigJson: '',
  };
}

function findProjectOverride(
  config: KMSConfigData | null,
  projectId: string,
): KMSProjectOverride | null {
  return (config?.projects ?? []).find((entry) => entry.projectId === projectId) ?? null;
}

function findTenantEnvironmentOverride(
  config: KMSConfigData | null,
  environment: string,
): KMSEnvironmentOverride | null {
  return (config?.environments ?? []).find((entry) => entry.environment === environment) ?? null;
}

function findProjectEnvironmentOverride(
  config: KMSConfigData | null,
  projectId: string,
  environment: string,
): KMSEnvironmentOverride | null {
  return (
    findProjectOverride(config, projectId)?.environments.find(
      (entry) => entry.environment === environment,
    ) ?? null
  );
}

function getScopeFormState(
  config: KMSConfigData | null,
  scopeType: ScopeType,
  projectId: string,
  environment: string,
): ProviderFieldsState {
  if (scopeType === 'tenant-environment') {
    const tenantEnv = findTenantEnvironmentOverride(config, environment);
    return providerToScopeForm(tenantEnv?.provider);
  }
  if (scopeType === 'project') {
    const project = findProjectOverride(config, projectId);
    return providerToScopeForm(project?.defaultProvider ?? null);
  }
  const projectEnv = findProjectEnvironmentOverride(config, projectId, environment);
  return providerToScopeForm(projectEnv?.provider);
}

function buildScopeProviderInput(state: ProviderFieldsState, t: Translator): KMSProviderInput {
  const { parsed, error } = parseAuthConfig(state.authConfigJson);
  if (error) {
    throw new Error(error);
  }
  const authConfig = parsed as Record<string, string> | null;
  const provider: KMSProviderInput = {
    providerType: state.providerType,
    keyId: state.keyId.trim() || DEFAULT_LOCAL_KEY_ID,
    region: state.region.trim() || null,
    vaultUrl: state.vaultUrl.trim() || null,
    externalEndpoint: state.externalEndpoint.trim() || null,
    authMethod: (state.authMethod || null) as KMSProviderAuthMethod | null,
    authConfig,
  };

  if (provider.providerType !== 'local' && !provider.keyId.trim()) {
    throw new Error(t('kms.validation_key_id_required'));
  }
  if (provider.providerType === 'aws-kms' && !provider.region) {
    throw new Error(t('kms.validation_region_required'));
  }
  if (
    (provider.providerType === 'azure-keyvault' || provider.providerType === 'azure-managed-hsm') &&
    !provider.vaultUrl
  ) {
    throw new Error(t('kms.validation_vault_url_required'));
  }
  if (provider.providerType === 'external') {
    if (!provider.externalEndpoint) {
      throw new Error(t('kms.validation_external_endpoint_required'));
    }
    if (!provider.authMethod) {
      throw new Error(t('kms.validation_auth_method_required'));
    }
  }

  return provider;
}

function humanizeProviderLocal(
  providerType: KMSProviderType | string | undefined,
  t: Translator,
): string {
  switch (providerType) {
    case 'aws-kms':
      return t('kms.provider_aws_kms');
    case 'azure-keyvault':
      return t('kms.provider_azure_keyvault');
    case 'azure-managed-hsm':
      return t('kms.provider_azure_managed_hsm');
    case 'gcp-cloud-kms':
      return t('kms.provider_gcp_kms');
    case 'external':
      return t('kms.provider_external');
    case 'local':
      return t('kms.provider_local');
    default:
      return t('kms.scopes_platform_default');
  }
}

function providerSummaryLabel(provider: KMSProviderRef | null | undefined, t: Translator): string {
  if (!provider) {
    return t('kms.scopes_inherit_parent');
  }
  return `${humanizeProviderLocal(provider.providerType, t)} · ${provider.keyId}`;
}

function resolveSourceLabel(
  source: KMSEffectiveScopeStep['source'] | undefined,
  t: Translator,
): string {
  switch (source) {
    case 'tenant_default':
      return t('kms.scopes_source_tenant_default');
    case 'tenant_environment':
      return t('kms.scopes_source_tenant_environment');
    case 'project_default':
      return t('kms.scopes_source_project_default');
    case 'project_environment':
      return t('kms.scopes_source_project_environment');
    default:
      return t('kms.scopes_source_platform_default');
  }
}

function effectiveChainDetail(step: KMSEffectiveScopeStep, t: Translator): string {
  if (step.source === 'platform_default') {
    return t('kms.scopes_chain_platform_detail');
  }
  if (!step.provider) {
    return t('kms.scopes_chain_none');
  }
  if (step.projectId && step.environment) {
    return `${step.projectId}/${step.environment} · ${providerSummaryLabel(step.provider, t)}`;
  }
  if (step.projectId) {
    return `${step.projectId} · ${providerSummaryLabel(step.provider, t)}`;
  }
  if (step.environment) {
    return `${step.environment} · ${providerSummaryLabel(step.provider, t)}`;
  }
  return providerSummaryLabel(step.provider, t);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function KMSConfigForm() {
  const t = useTranslations('admin');
  const { config, isLoading, mutate } = useKMSConfig();
  const [form, setForm] = useState<FormState>(buildInitialForm(null));
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<KMSValidateResult | null>(null);

  // Scope override state
  const [scopeType, setScopeType] = useState<ScopeType>('tenant-environment');
  const [scopeProjectId, setScopeProjectId] = useState('');
  const [scopeEnvironment, setScopeEnvironment] = useState('');
  const [scopeForm, setScopeForm] = useState<ProviderFieldsState>(providerToScopeForm(null));
  const [scopeSaving, setScopeSaving] = useState(false);

  useEffect(() => {
    setForm(buildInitialForm(config));
  }, [config]);

  useEffect(() => {
    setScopeForm(getScopeFormState(config, scopeType, scopeProjectId, scopeEnvironment));
  }, [config, scopeType, scopeProjectId, scopeEnvironment]);

  // Effective config for scope preview
  const effectiveScopeProjectId =
    scopeType === 'tenant-environment' ? '_tenant' : scopeProjectId.trim() || '_tenant';
  const effectiveScopeEnvironment =
    scopeType === 'project' ? '_shared' : scopeEnvironment.trim() || '_shared';

  const { effectiveConfig, isLoading: isResolvingEffective } = useKMSEffectiveConfig({
    projectId: effectiveScopeProjectId,
    environment: effectiveScopeEnvironment,
  });

  // Provider fields state derived from main form
  const providerFieldsState: ProviderFieldsState = useMemo(
    () => ({
      providerType: form.providerType,
      externalEndpoint: form.externalEndpoint,
      vaultUrl: form.vaultUrl,
      region: form.region,
      keyId: form.keyId,
      authMethod: form.authMethod,
      authConfigJson: form.authConfigJson,
    }),
    [
      form.providerType,
      form.externalEndpoint,
      form.vaultUrl,
      form.region,
      form.keyId,
      form.authMethod,
      form.authConfigJson,
    ],
  );

  const handleProviderFieldChange = <K extends keyof ProviderFieldsState>(
    key: K,
    value: ProviderFieldsState[K],
  ) => {
    setValidationResult(null);
    if (key === 'providerType') {
      const providerType = value as KMSProviderType;
      const supportedAuthMethods = getSupportedAuthMethods(providerType);
      setForm((current) => ({
        ...current,
        providerType,
        authMethod: supportedAuthMethods.includes(current.authMethod as KMSProviderAuthMethod)
          ? current.authMethod
          : '',
        externalEndpoint: providerType === 'external' ? current.externalEndpoint : '',
        vaultUrl:
          providerType === 'azure-keyvault' || providerType === 'azure-managed-hsm'
            ? current.vaultUrl
            : '',
        region:
          providerType === 'aws-kms' || providerType === 'gcp-cloud-kms' ? current.region : '',
      }));
    } else {
      setForm((current) => ({ ...current, [key]: value }));
    }
  };

  const failurePolicyOptions = useMemo(
    () => [
      { value: 'fail-closed', label: t('kms.failure_policy_fail_closed') },
      { value: 'graceful-degradation', label: t('kms.failure_policy_graceful_degradation') },
    ],
    [t],
  );

  const complianceOptions = useMemo(
    () => [
      { value: 'standard', label: t('kms.compliance_standard') },
      { value: 'pci-dss', label: t('kms.compliance_pci_dss') },
      { value: 'hipaa', label: t('kms.compliance_hipaa') },
      { value: 'fips-140-3', label: t('kms.compliance_fips_140_3') },
    ],
    [t],
  );

  const canValidateExternal =
    form.providerType === 'external' &&
    Boolean(form.externalEndpoint.trim()) &&
    Boolean(form.keyId.trim()) &&
    Boolean(form.authMethod);

  const updateForm = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const buildProviderInput = (): KMSProviderInput | null => {
    if (form.providerType === 'local') {
      return null;
    }

    if (!form.keyId.trim()) {
      throw new Error(t('kms.validation_key_id_required'));
    }

    const { parsed, error } = parseAuthConfig(form.authConfigJson);
    if (error) {
      throw new Error(error);
    }
    const authConfig = parsed as Record<string, string> | null;

    const provider: KMSProviderInput = {
      providerType: form.providerType,
      keyId: form.keyId.trim(),
      region: form.region.trim() || null,
      vaultUrl: form.vaultUrl.trim() || null,
      externalEndpoint: form.externalEndpoint.trim() || null,
      authMethod: (form.authMethod || null) as KMSProviderAuthMethod | null,
      authConfig,
    };

    if (provider.providerType === 'aws-kms' && !provider.region) {
      throw new Error(t('kms.validation_region_required'));
    }

    if (
      (provider.providerType === 'azure-keyvault' ||
        provider.providerType === 'azure-managed-hsm') &&
      !provider.vaultUrl
    ) {
      throw new Error(t('kms.validation_vault_url_required'));
    }

    if (provider.providerType === 'external') {
      if (!provider.externalEndpoint) {
        throw new Error(t('kms.validation_external_endpoint_required'));
      }
      if (!provider.authMethod) {
        throw new Error(t('kms.validation_auth_method_required'));
      }
    }

    return provider;
  };

  const handleValidate = async () => {
    try {
      const provider = buildProviderInput();
      if (!provider || provider.providerType !== 'external') {
        return;
      }

      const { parsed } = parseAuthConfig(form.authConfigJson);
      const authConfig = (parsed as Record<string, string>) ?? {};
      setValidating(true);
      const result = await validateExternalKMS({
        endpoint: provider.externalEndpoint ?? '',
        authMethod: provider.authMethod ?? 'api-key',
        testKeyId: provider.keyId,
        maxLatencyMs: DEFAULT_EXTERNAL_MAX_LATENCY_MS,
        ...authConfig,
      });
      setValidationResult(result);

      if (result.valid) {
        toast.success(
          t('kms.external_validation_success', {
            latency: result.latencyMs ?? 0,
          }),
        );
      } else {
        toast.error(result.errors[0] || t('kms.external_validation_failed'));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : t('kms.external_validation_failed');
      toast.error(message);
      setValidationResult({
        valid: false,
        errors: [message],
        warnings: [],
      });
    } finally {
      setValidating(false);
    }
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      const defaultProvider = buildProviderInput();
      const payload: KMSConfigUpdateInput = {
        defaultProvider,
        dekRetentionDays: form.destroyRetiredDeks ? form.dekRetentionDays : null,
        dekEpochIntervalHours: form.dekEpochIntervalHours,
        dekMaxUsageCount: form.dekMaxUsageCount,
        kekRotationPeriodDays: form.kekRotationPeriodDays,
        reencryption: {
          enabled: form.reencryptionEnabled,
          concurrency: form.reencryptionConcurrency,
          batchSize: form.reencryptionBatchSize,
          maxRetries: form.reencryptionMaxRetries,
        },
        byokEnabled: form.providerType !== 'local' && form.providerType !== 'external',
        byopEnabled: form.providerType === 'external',
        complianceLevel: form.complianceLevel,
        failurePolicy: form.failurePolicy,
      };

      const result = await updateKMSConfig(payload);
      toast.success(t('kms.config_saved'));
      if (result?.propagationWarning) {
        toast.warning(result.propagationWarning);
      }
      await mutate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('kms.config_save_failed'));
    } finally {
      setSaving(false);
    }
  };

  // --- Scope override handlers ---

  const overrideCount =
    (config?.environments ?? []).length +
    (config?.projects ?? []).reduce((sum, project) => sum + 1 + project.environments.length, 0);

  const projectOptions = useMemo(
    () =>
      Array.from(new Set((config?.projects ?? []).map((entry) => entry.projectId)))
        .sort((left, right) => left.localeCompare(right))
        .map((value) => ({ value, label: value })),
    [config],
  );

  const environmentOptions = useMemo(
    () =>
      Array.from(
        new Set([
          ...(config?.environments ?? []).map((entry) => entry.environment),
          ...(config?.projects ?? []).flatMap((entry) =>
            entry.environments.map((environmentEntry) => environmentEntry.environment),
          ),
        ]),
      )
        .sort((left, right) => left.localeCompare(right))
        .map((value) => ({ value, label: value })),
    [config],
  );

  const selectedProject = findProjectOverride(config, scopeProjectId);
  const selectedTenantEnvironment = findTenantEnvironmentOverride(config, scopeEnvironment);
  const selectedProjectEnvironment = findProjectEnvironmentOverride(
    config,
    scopeProjectId,
    scopeEnvironment,
  );

  const canSaveScope =
    scopeType === 'tenant-environment'
      ? Boolean(scopeEnvironment.trim())
      : scopeType === 'project'
        ? Boolean(scopeProjectId.trim())
        : Boolean(scopeProjectId.trim() && scopeEnvironment.trim());

  const canClearScope =
    scopeType === 'tenant-environment'
      ? Boolean(selectedTenantEnvironment)
      : scopeType === 'project'
        ? Boolean(selectedProject)
        : Boolean(selectedProjectEnvironment);

  const handleScopeFieldChange = <K extends keyof ProviderFieldsState>(
    key: K,
    value: ProviderFieldsState[K],
  ) => {
    setScopeForm((current) => ({ ...current, [key]: value }));
  };

  const editScope = (nextScopeType: ScopeType, nextProjectId: string, nextEnvironment: string) => {
    setScopeType(nextScopeType);
    setScopeProjectId(nextProjectId);
    setScopeEnvironment(nextEnvironment);
  };

  const handleScopeSave = async () => {
    if (!canSaveScope) {
      toast.error(t('kms.scopes_save_missing_scope'));
      return;
    }

    try {
      setScopeSaving(true);
      const provider = buildScopeProviderInput(scopeForm, t);

      if (scopeType === 'tenant-environment') {
        const result = await updateTenantEnvironmentKMSConfig(scopeEnvironment.trim(), {
          provider,
        });
        toast.success(
          t('kms.scopes_save_tenant_environment_success', {
            environment: scopeEnvironment.trim(),
          }),
        );
        if (result?.propagationWarning) {
          toast.warning(result.propagationWarning);
        }
      } else if (scopeType === 'project') {
        const result = await updateProjectKMSConfig(scopeProjectId.trim(), {
          defaultProvider: provider,
        });
        toast.success(t('kms.scopes_save_project_success', { projectId: scopeProjectId.trim() }));
        if (result?.propagationWarning) {
          toast.warning(result.propagationWarning);
        }
      } else {
        const result = await updateProjectEnvironmentKMSConfig(
          scopeProjectId.trim(),
          scopeEnvironment.trim(),
          { provider },
        );
        toast.success(
          t('kms.scopes_save_project_environment_success', {
            projectId: scopeProjectId.trim(),
            environment: scopeEnvironment.trim(),
          }),
        );
        if (result?.propagationWarning) {
          toast.warning(result.propagationWarning);
        }
      }

      await mutate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('kms.scopes_save_failed'));
    } finally {
      setScopeSaving(false);
    }
  };

  const handleScopeClear = async () => {
    if (!canClearScope) {
      return;
    }

    try {
      setScopeSaving(true);
      if (scopeType === 'tenant-environment') {
        const result = await deleteTenantEnvironmentKMSConfig(scopeEnvironment.trim());
        toast.success(
          t('kms.scopes_clear_tenant_environment_success', {
            environment: scopeEnvironment.trim(),
          }),
        );
        if (result?.propagationWarning) {
          toast.warning(result.propagationWarning);
        }
      } else if (scopeType === 'project') {
        const hasNestedEnvironments = Boolean(selectedProject?.environments.length);
        const result = hasNestedEnvironments
          ? await updateProjectKMSConfig(scopeProjectId.trim(), { defaultProvider: null })
          : await deleteProjectKMSConfig(scopeProjectId.trim());
        toast.success(
          hasNestedEnvironments
            ? t('kms.scopes_clear_project_default_success', {
                projectId: scopeProjectId.trim(),
              })
            : t('kms.scopes_clear_project_success', { projectId: scopeProjectId.trim() }),
        );
        if (result?.propagationWarning) {
          toast.warning(result.propagationWarning);
        }
      } else {
        const result = await deleteProjectEnvironmentKMSConfig(
          scopeProjectId.trim(),
          scopeEnvironment.trim(),
        );
        toast.success(
          t('kms.scopes_clear_project_environment_success', {
            projectId: scopeProjectId.trim(),
            environment: scopeEnvironment.trim(),
          }),
        );
        if (result?.propagationWarning) {
          toast.warning(result.propagationWarning);
        }
      }

      await mutate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('kms.scopes_clear_failed'));
    } finally {
      setScopeSaving(false);
    }
  };

  // --- Render ---

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Provider Configuration */}
      <Section
        title={t('kms.provider_config')}
        description={t('kms.provider_config_description')}
        icon={<Shield className="h-4 w-4" />}
        variant="elevated"
      >
        <ProviderConfigFields
          state={providerFieldsState}
          onChange={handleProviderFieldChange}
          validation={{
            canValidate: canValidateExternal,
            onValidate: handleValidate,
            validating,
            validationResult,
            hasEncryptedAuthConfig: Boolean(config?.defaultProvider?.authConfigEncrypted),
          }}
        />
      </Section>

      {/* Policies */}
      <Section
        title={t('kms.policies_title')}
        description={t('kms.policies_description')}
        collapsible
      >
        <div className="space-y-5">
          <Select
            label={t('kms.failure_policy_label')}
            options={failurePolicyOptions}
            value={form.failurePolicy}
            onChange={(value) => updateForm('failurePolicy', value as KMSFailurePolicy)}
          />

          <Select
            label={t('kms.compliance_level_label')}
            options={complianceOptions}
            value={form.complianceLevel}
            onChange={(value) => updateForm('complianceLevel', value as KMSComplianceLevel)}
          />
        </div>
      </Section>

      {/* Rotation */}
      <Section
        title={t('kms.rotation_title')}
        description={t('kms.rotation_description')}
        collapsible
      >
        <div className="space-y-5">
          <div className="grid gap-4 md:grid-cols-2">
            <Input
              label={t('kms.dek_epoch_interval_hours_label')}
              type="number"
              min={12}
              max={8760}
              value={form.dekEpochIntervalHours}
              onChange={(event) =>
                updateForm(
                  'dekEpochIntervalHours',
                  parseInteger(event.target.value, DEFAULT_DEK_EPOCH_INTERVAL_HOURS, 12),
                )
              }
            />
            <Input
              label={t('kms.dek_max_usage_count_label')}
              type="number"
              min={1}
              value={form.dekMaxUsageCount}
              onChange={(event) =>
                updateForm(
                  'dekMaxUsageCount',
                  parseInteger(event.target.value, DEFAULT_DEK_MAX_USAGE_COUNT),
                )
              }
            />
          </div>

          <Toggle
            checked={form.destroyRetiredDeks}
            onChange={(checked) => updateForm('destroyRetiredDeks', checked)}
            label={t('kms.destroy_retired_deks_label')}
            description={t('kms.destroy_retired_deks_description')}
          />

          {form.destroyRetiredDeks && (
            <Input
              label={t('kms.dek_retention_days_label')}
              type="number"
              min={1}
              max={3650}
              value={form.dekRetentionDays}
              onChange={(event) =>
                updateForm(
                  'dekRetentionDays',
                  parseInteger(event.target.value, DEFAULT_DEK_RETENTION_DAYS),
                )
              }
            />
          )}

          <Input
            label={t('kms.kek_rotation_period_label')}
            type="number"
            min={1}
            max={3650}
            value={form.kekRotationPeriodDays}
            onChange={(event) =>
              updateForm(
                'kekRotationPeriodDays',
                parseInteger(event.target.value, DEFAULT_KEK_ROTATION_DAYS),
              )
            }
          />

          <Toggle
            checked={form.reencryptionEnabled}
            onChange={(checked) => updateForm('reencryptionEnabled', checked)}
            label={t('kms.reencryption_enabled_label')}
            description={t('kms.reencryption_enabled_description')}
          />

          {form.reencryptionEnabled && (
            <div className="grid gap-4 md:grid-cols-3">
              <Input
                label={t('kms.reencryption_concurrency_label')}
                type="number"
                min={1}
                max={10}
                value={form.reencryptionConcurrency}
                onChange={(event) =>
                  updateForm(
                    'reencryptionConcurrency',
                    parseInteger(event.target.value, DEFAULT_REENCRYPTION_CONCURRENCY),
                  )
                }
              />
              <Input
                label={t('kms.reencryption_batch_size_label')}
                type="number"
                min={1}
                max={1000}
                value={form.reencryptionBatchSize}
                onChange={(event) =>
                  updateForm(
                    'reencryptionBatchSize',
                    parseInteger(event.target.value, DEFAULT_REENCRYPTION_BATCH_SIZE),
                  )
                }
              />
              <Input
                label={t('kms.reencryption_max_retries_label')}
                type="number"
                min={0}
                max={10}
                value={form.reencryptionMaxRetries}
                onChange={(event) =>
                  updateForm(
                    'reencryptionMaxRetries',
                    parseInteger(event.target.value, DEFAULT_REENCRYPTION_MAX_RETRIES, 0),
                  )
                }
              />
            </div>
          )}
        </div>
      </Section>

      {/* Scope Overrides */}
      <Section
        title={t('kms.scopes_title')}
        description={t('kms.scopes_description')}
        icon={<Layers3 className="h-4 w-4" />}
        collapsible
        defaultCollapsed
        actions={
          <Badge variant="info">
            {t('kms.scopes_project_env_count', { count: overrideCount })}
          </Badge>
        }
      >
        <div className="space-y-4">
          <Alert variant="info" title={t('kms.scopes_inheritance_title')}>
            {t('kms.scopes_inheritance_description')}
          </Alert>

          <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
            {/* Scope editor */}
            <div className="space-y-4 rounded-xl border border-default bg-background-muted p-4">
              <div className="grid gap-4 md:grid-cols-3">
                <Select
                  label={t('kms.scopes_scope_type_label')}
                  value={scopeType}
                  onChange={(value) => setScopeType(value as ScopeType)}
                  options={[
                    {
                      value: 'tenant-environment',
                      label: t('kms.scopes_scope_tenant_environment'),
                    },
                    { value: 'project', label: t('kms.scopes_scope_project') },
                    {
                      value: 'project-environment',
                      label: t('kms.scopes_scope_project_environment'),
                    },
                  ]}
                />

                {(scopeType === 'project' || scopeType === 'project-environment') && (
                  <Input
                    label={t('kms.keys_project_filter')}
                    list="kms-scope-project-id-options"
                    placeholder={t('kms.scopes_project_placeholder')}
                    value={scopeProjectId}
                    onChange={(event) => setScopeProjectId(event.target.value)}
                  />
                )}

                {(scopeType === 'tenant-environment' || scopeType === 'project-environment') && (
                  <Input
                    label={t('kms.keys_environment_filter')}
                    list="kms-scope-environment-options"
                    placeholder={t('kms.scopes_environment_placeholder')}
                    value={scopeEnvironment}
                    onChange={(event) => setScopeEnvironment(event.target.value)}
                  />
                )}
              </div>

              <datalist id="kms-scope-project-id-options">
                {projectOptions.map((option) => (
                  <option key={option.value} value={option.value} />
                ))}
              </datalist>
              <datalist id="kms-scope-environment-options">
                {environmentOptions.map((option) => (
                  <option key={option.value} value={option.value} />
                ))}
              </datalist>

              <ProviderConfigFields state={scopeForm} onChange={handleScopeFieldChange} />

              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={handleScopeSave}
                  loading={scopeSaving}
                  disabled={!canSaveScope}
                  icon={<Check className="h-3.5 w-3.5" />}
                >
                  {t('kms.scopes_save_override')}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    setScopeForm(
                      getScopeFormState(config, scopeType, scopeProjectId, scopeEnvironment),
                    )
                  }
                  disabled={scopeSaving}
                  icon={<Wand2 className="h-3.5 w-3.5" />}
                >
                  {t('kms.scopes_reset_form')}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={handleScopeClear}
                  disabled={!canClearScope || scopeSaving}
                  icon={<Trash2 className="h-3.5 w-3.5" />}
                >
                  {scopeType === 'project' && selectedProject?.environments.length
                    ? t('kms.scopes_clear_project_default')
                    : t('kms.scopes_clear_override')}
                </Button>
              </div>
            </div>

            {/* Effective config preview */}
            <div className="space-y-4 rounded-xl border border-default bg-background-muted p-4">
              <div className="space-y-1">
                <p className="text-sm font-semibold text-foreground">
                  {t('kms.scopes_effective_title')}
                </p>
                <p className="text-sm text-muted">
                  {scopeProjectId || scopeEnvironment
                    ? t('kms.scopes_effective_preview', {
                        scope: `${scopeProjectId || t('kms.scopes_preview_tenant')}${scopeEnvironment ? ` / ${scopeEnvironment}` : ''}`,
                      })
                    : t('kms.scopes_effective_empty')}
                </p>
              </div>

              {isResolvingEffective ? (
                <div className="flex items-center justify-center py-10">
                  <Loader2 className="h-5 w-5 animate-spin text-muted" />
                </div>
              ) : (
                <>
                  <div className="rounded-xl border border-default bg-background-elevated p-4">
                    <div className="space-y-1">
                      <p className="text-sm font-semibold text-foreground">
                        {resolveSourceLabel(effectiveConfig?.source, t)}
                      </p>
                      <p className="text-sm text-muted">
                        {providerSummaryLabel(effectiveConfig?.provider, t)}
                      </p>
                    </div>
                  </div>

                  <div className="space-y-2">
                    {(effectiveConfig?.chain ?? []).map((entry) => (
                      <div
                        key={entry.source}
                        className="flex items-start justify-between gap-3 rounded-lg border border-default bg-background-elevated p-3"
                      >
                        <div className="space-y-1">
                          <p className="text-sm font-medium text-foreground">
                            {resolveSourceLabel(entry.source, t)}
                          </p>
                          <p className="text-xs text-muted">{effectiveChainDetail(entry, t)}</p>
                        </div>
                        <Badge variant={entry.matched ? 'success' : 'default'}>
                          {entry.matched
                            ? t('kms.scopes_chain_active')
                            : t('kms.scopes_chain_bypassed')}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Existing overrides list */}
          <div className="space-y-6">
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-foreground">
                  {t('kms.scopes_tenant_environment_list_title')}
                </p>
                <Badge variant="info">{(config?.environments ?? []).length}</Badge>
              </div>
              {(config?.environments ?? []).length === 0 ? (
                <p className="text-sm text-muted">{t('kms.scopes_tenant_environment_empty')}</p>
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  {(config?.environments ?? []).map((entry) => (
                    <button
                      key={`tenant-env-${entry.environment}`}
                      type="button"
                      onClick={() => editScope('tenant-environment', '', entry.environment)}
                      className="rounded-xl border border-default bg-background-subtle p-4 text-left transition-default hover:bg-background-elevated"
                    >
                      <div className="space-y-1">
                        <p className="text-sm font-semibold text-foreground">{entry.environment}</p>
                        <p className="text-sm text-muted">
                          {providerSummaryLabel(entry.provider, t)}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-foreground">
                  {t('kms.scopes_project_list_title')}
                </p>
                <Badge variant="info">{(config?.projects ?? []).length}</Badge>
              </div>
              {(config?.projects ?? []).length === 0 ? (
                <p className="text-sm text-muted">{t('kms.scopes_project_empty')}</p>
              ) : (
                <div className="space-y-4">
                  {(config?.projects ?? []).map((project) => (
                    <div
                      key={`project-${project.projectId}`}
                      className="rounded-xl border border-default bg-background-subtle p-4"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="space-y-1">
                          <p className="text-sm font-semibold text-foreground">
                            {project.projectId}
                          </p>
                          <p className="text-sm text-muted">
                            {providerSummaryLabel(project.defaultProvider, t)}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Badge variant="accent">
                            {t('kms.scopes_project_env_count', {
                              count: project.environments.length,
                            })}
                          </Badge>
                          <Button
                            size="xs"
                            variant="secondary"
                            onClick={() => editScope('project', project.projectId, '')}
                          >
                            {t('kms.scopes_edit_project_default')}
                          </Button>
                        </div>
                      </div>

                      {project.environments.length > 0 && (
                        <div className="mt-4 grid gap-3 md:grid-cols-2">
                          {project.environments.map((environmentEntry) => (
                            <button
                              key={`${project.projectId}-${environmentEntry.environment}`}
                              type="button"
                              onClick={() =>
                                editScope(
                                  'project-environment',
                                  project.projectId,
                                  environmentEntry.environment,
                                )
                              }
                              className="rounded-lg border border-default bg-background-elevated p-3 text-left transition-default hover:bg-background-subtle"
                            >
                              <div className="space-y-1">
                                <p className="text-sm font-medium text-foreground">
                                  {environmentEntry.environment}
                                </p>
                                <p className="text-xs text-muted">
                                  {providerSummaryLabel(environmentEntry.provider, t)}
                                </p>
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </Section>

      <div className="flex justify-end">
        <Button
          variant="primary"
          size="sm"
          onClick={handleSave}
          loading={saving}
          icon={<Check className="h-3.5 w-3.5" />}
        >
          {t('kms.save_config')}
        </Button>
      </div>
    </div>
  );
}
