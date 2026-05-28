/**
 * ProviderConfigFields — Shared provider configuration form fields for KMS.
 *
 * Renders provider-specific inputs (endpoint, vault URL, region, key ID,
 * auth method, auth config JSON) based on the selected KMS provider type.
 * Used by both the Configuration tab and Scope Override forms.
 */

'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, CheckCircle2, TestTube2 } from 'lucide-react';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Textarea } from '../ui/Textarea';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import type { KMSProviderAuthMethod, KMSProviderType, KMSValidateResult } from '../../hooks/useKMS';
import { getSupportedAuthMethods } from './kms-utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProviderFieldsState {
  providerType: KMSProviderType;
  externalEndpoint: string;
  vaultUrl: string;
  region: string;
  keyId: string;
  authMethod: KMSProviderAuthMethod | '';
  authConfigJson: string;
}

export interface ValidationProps {
  /** Whether the validate button should be enabled. */
  canValidate: boolean;
  /** Fires when the user clicks the validate button. */
  onValidate: () => void;
  /** True while validation is in progress. */
  validating: boolean;
  /** The result from the last validation attempt, if any. */
  validationResult: KMSValidateResult | null;
  /** Optional hint when existing auth config is encrypted (not editable). */
  hasEncryptedAuthConfig?: boolean;
}

export interface ProviderConfigFieldsProps {
  state: ProviderFieldsState;
  onChange: <K extends keyof ProviderFieldsState>(key: K, value: ProviderFieldsState[K]) => void;
  /** When provided, renders the external-provider validation section. */
  validation?: ValidationProps;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getAuthMethodLabel(
  authMethod: KMSProviderAuthMethod | '',
  t: ReturnType<typeof useTranslations>,
): string {
  switch (authMethod) {
    case 'default-credentials':
      return t('kms.auth_method_default_credentials');
    case 'service-account':
      return t('kms.auth_method_service_account');
    case 'managed-identity':
      return t('kms.auth_method_managed_identity');
    case 'api-key':
      return t('kms.auth_method_api_key');
    case 'mtls':
      return t('kms.auth_method_mtls');
    case 'oauth2':
      return t('kms.auth_method_oauth2');
    case 'hmac-sha256':
      return t('kms.auth_method_hmac_sha256');
    default:
      return '';
  }
}

interface ProviderMeta {
  needsRegion: boolean;
  needsVaultUrl: boolean;
  needsExternalEndpoint: boolean;
  needsAuthMethod: boolean;
  endpointLabel: string;
  endpointPlaceholder: string;
  regionLabel: string;
  regionPlaceholder: string;
  keyIdLabel: string;
  keyIdPlaceholder: string;
}

function getProviderMeta(
  providerType: KMSProviderType,
  t: ReturnType<typeof useTranslations>,
): ProviderMeta {
  switch (providerType) {
    case 'aws-kms':
      return {
        needsRegion: true,
        needsVaultUrl: false,
        needsExternalEndpoint: false,
        needsAuthMethod: false,
        endpointLabel: '',
        endpointPlaceholder: '',
        regionLabel: t('kms.aws_kms_region_label'),
        regionPlaceholder: t('kms.aws_kms_region_placeholder'),
        keyIdLabel: t('kms.aws_kms_key_id_label'),
        keyIdPlaceholder: t('kms.aws_kms_key_id_placeholder'),
      };
    case 'azure-keyvault':
      return {
        needsRegion: false,
        needsVaultUrl: true,
        needsExternalEndpoint: false,
        needsAuthMethod: true,
        endpointLabel: t('kms.azure_keyvault_endpoint_label'),
        endpointPlaceholder: t('kms.azure_keyvault_endpoint_placeholder'),
        regionLabel: '',
        regionPlaceholder: '',
        keyIdLabel: t('kms.azure_keyvault_key_id_label'),
        keyIdPlaceholder: t('kms.azure_keyvault_key_id_placeholder'),
      };
    case 'azure-managed-hsm':
      return {
        needsRegion: false,
        needsVaultUrl: true,
        needsExternalEndpoint: false,
        needsAuthMethod: true,
        endpointLabel: t('kms.azure_managed_hsm_endpoint_label'),
        endpointPlaceholder: t('kms.azure_managed_hsm_endpoint_placeholder'),
        regionLabel: '',
        regionPlaceholder: '',
        keyIdLabel: t('kms.azure_managed_hsm_key_id_label'),
        keyIdPlaceholder: t('kms.azure_managed_hsm_key_id_placeholder'),
      };
    case 'gcp-cloud-kms':
      return {
        needsRegion: true,
        needsVaultUrl: false,
        needsExternalEndpoint: false,
        needsAuthMethod: true,
        endpointLabel: '',
        endpointPlaceholder: '',
        regionLabel: t('kms.gcp_kms_region_label'),
        regionPlaceholder: t('kms.gcp_kms_region_placeholder'),
        keyIdLabel: t('kms.gcp_kms_key_id_label'),
        keyIdPlaceholder: t('kms.gcp_kms_key_id_placeholder'),
      };
    case 'external':
      return {
        needsRegion: false,
        needsVaultUrl: false,
        needsExternalEndpoint: true,
        needsAuthMethod: true,
        endpointLabel: t('kms.external_endpoint_label'),
        endpointPlaceholder: t('kms.external_endpoint_placeholder'),
        regionLabel: '',
        regionPlaceholder: '',
        keyIdLabel: t('kms.external_key_id_label'),
        keyIdPlaceholder: t('kms.external_key_id_placeholder'),
      };
    default:
      return {
        needsRegion: false,
        needsVaultUrl: false,
        needsExternalEndpoint: false,
        needsAuthMethod: false,
        endpointLabel: '',
        endpointPlaceholder: '',
        regionLabel: '',
        regionPlaceholder: '',
        keyIdLabel: t('kms.key_id_label'),
        keyIdPlaceholder: t('kms.key_id_placeholder'),
      };
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ProviderConfigFields({ state, onChange, validation }: ProviderConfigFieldsProps) {
  const t = useTranslations('admin');

  const providerOptions = useMemo(
    () => [
      { value: 'local', label: t('kms.provider_local') },
      { value: 'aws-kms', label: t('kms.provider_aws_kms') },
      { value: 'azure-keyvault', label: t('kms.provider_azure_keyvault') },
      { value: 'azure-managed-hsm', label: t('kms.provider_azure_managed_hsm') },
      { value: 'gcp-cloud-kms', label: t('kms.provider_gcp_kms') },
      { value: 'external', label: t('kms.provider_external') },
    ],
    [t],
  );

  const meta = useMemo(() => getProviderMeta(state.providerType, t), [state.providerType, t]);

  const authMethodOptions = useMemo(() => {
    return getSupportedAuthMethods(state.providerType).map((value) => ({
      value,
      label: getAuthMethodLabel(value, t),
    }));
  }, [state.providerType, t]);

  const handleProviderChange = (value: string) => {
    const providerType = value as KMSProviderType;
    const supportedAuthMethods = getSupportedAuthMethods(providerType);
    onChange('providerType', providerType);

    // Reset fields that are irrelevant for the newly selected provider
    if (providerType !== 'external') {
      onChange('externalEndpoint', '');
    }
    if (providerType !== 'azure-keyvault' && providerType !== 'azure-managed-hsm') {
      onChange('vaultUrl', '');
    }
    if (providerType !== 'aws-kms' && providerType !== 'gcp-cloud-kms') {
      onChange('region', '');
    }
    if (!supportedAuthMethods.includes(state.authMethod as KMSProviderAuthMethod)) {
      onChange('authMethod', '');
    }
  };

  return (
    <div className="space-y-5">
      <Select
        label={t('kms.provider_label')}
        options={providerOptions}
        value={state.providerType}
        onChange={handleProviderChange}
      />

      {state.providerType === 'local' ? (
        <div className="rounded-xl border border-default bg-background-muted p-4 text-sm text-muted">
          {t('kms.local_provider_help')}
        </div>
      ) : (
        <>
          {meta.needsExternalEndpoint && (
            <Input
              label={meta.endpointLabel}
              placeholder={meta.endpointPlaceholder}
              value={state.externalEndpoint}
              onChange={(event) => onChange('externalEndpoint', event.target.value)}
            />
          )}

          {meta.needsVaultUrl && (
            <Input
              label={meta.endpointLabel}
              placeholder={meta.endpointPlaceholder}
              value={state.vaultUrl}
              onChange={(event) => onChange('vaultUrl', event.target.value)}
            />
          )}

          {meta.needsRegion && (
            <Input
              label={meta.regionLabel}
              placeholder={meta.regionPlaceholder}
              value={state.region}
              onChange={(event) => onChange('region', event.target.value)}
            />
          )}

          <Input
            label={meta.keyIdLabel}
            placeholder={meta.keyIdPlaceholder}
            value={state.keyId}
            onChange={(event) => onChange('keyId', event.target.value)}
          />

          {meta.needsAuthMethod && (
            <Select
              label={t('kms.auth_method_label')}
              options={authMethodOptions}
              value={state.authMethod}
              onChange={(value) => onChange('authMethod', value as KMSProviderAuthMethod)}
              placeholder={t('kms.auth_method_placeholder')}
            />
          )}

          <Textarea
            label={t('kms.auth_config_label')}
            placeholder={t('kms.auth_config_placeholder')}
            rows={8}
            value={state.authConfigJson}
            onChange={(event) => onChange('authConfigJson', event.target.value)}
          />

          {validation?.hasEncryptedAuthConfig && !state.authConfigJson.trim() && (
            <div className="rounded-xl border border-default bg-background-muted p-3 text-sm text-muted">
              {t('kms.auth_config_encrypted_hint')}
            </div>
          )}

          {validation && state.providerType === 'external' && (
            <div className="space-y-3 rounded-xl border border-default bg-background-muted p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-foreground">
                    {t('kms.external_validation_title')}
                  </p>
                  <p className="text-sm text-muted">{t('kms.external_validation_description')}</p>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={validation.onValidate}
                  loading={validation.validating}
                  disabled={!validation.canValidate}
                  icon={<TestTube2 className="h-3.5 w-3.5" />}
                >
                  {t('kms.validate_endpoint')}
                </Button>
              </div>

              {!validation.canValidate && (
                <p className="text-xs text-muted">{t('kms.external_validation_hint')}</p>
              )}

              {validation.validationResult && (
                <div className="space-y-3 rounded-lg border border-default bg-background-subtle p-4">
                  <div className="flex items-center gap-2">
                    {validation.validationResult.valid ? (
                      <CheckCircle2 className="h-4 w-4 text-success" />
                    ) : (
                      <AlertTriangle className="h-4 w-4 text-error" />
                    )}
                    <span className="text-sm font-medium text-foreground">
                      {validation.validationResult.valid
                        ? t('kms.external_validation_passed')
                        : t('kms.external_validation_failed')}
                    </span>
                    {typeof validation.validationResult.latencyMs === 'number' && (
                      <Badge variant="info">{`${validation.validationResult.latencyMs}ms`}</Badge>
                    )}
                  </div>

                  {validation.validationResult.errors.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-xs font-semibold uppercase tracking-wide text-error">
                        {t('kms.validation_errors')}
                      </p>
                      {validation.validationResult.errors.map((error) => (
                        <p key={error} className="text-sm text-foreground">
                          {error}
                        </p>
                      ))}
                    </div>
                  )}

                  {validation.validationResult.warnings.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-xs font-semibold uppercase tracking-wide text-warning">
                        {t('kms.validation_warnings')}
                      </p>
                      {validation.validationResult.warnings.map((warning) => (
                        <p key={warning} className="text-sm text-foreground">
                          {warning}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
