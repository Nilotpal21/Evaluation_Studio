/**
 * AddConnectionDialog Component
 *
 * Dialog for wiring tenant credentials to a tenant model via connections.
 * Uses a credential-picker dropdown that fetches from the tenant credential store,
 * with an inline "create new credential" option.
 * When a projectId is provided, offers an "Auth Profile" mode that delegates
 * credential resolution to an auth profile instead of inline credentials.
 * After creation, offers a "Test Connection" button that calls the validate endpoint.
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { CheckCircle2, XCircle, AlertTriangle, Loader2, Key, Plus, Shield } from 'lucide-react';
import { clsx } from 'clsx';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { RadioGroup } from '../ui/RadioGroup';
import { apiFetch } from '../../lib/api-client';
import { toast } from 'sonner';
import { extractErrorMessage, sanitizeError } from '../../lib/sanitize-error';
import { ProviderSelect } from '../ui/ProviderSelect';
import { AuthProfilePicker } from '../auth-profiles/AuthProfilePicker';
import type { AuthType } from '../../api/auth-profiles';

// Sentinel value stored in encryptedApiKey for IAM role (ambient) Bedrock connections.
// Must match BEDROCK_AMBIENT_SENTINEL in packages/llm/src/provider-factory.ts.
const BEDROCK_AMBIENT_SENTINEL = '__iam_role__' as const;
const BEDROCK_BLOCKED_CUSTOM_HEADER_NAMES = new Set(['authorization', 'x-api-key']);

interface AddConnectionDialogProps {
  open: boolean;
  onClose: () => void;
  modelId: string;
  modelDisplayName: string;
  canonicalModelId?: string | null;
  tenantId: string;
  provider: string;
  onCreated: () => void;
  /** When provided, enables the "Use Auth Profile" toggle */
  projectId?: string;
}

interface TenantCredential {
  id: string;
  name: string;
  provider: string;
  status: string;
  endpoint?: string;
  createdAt: string;
}

type TestResult = {
  valid: boolean | null;
  message: string;
};

type CredentialMode = 'manual' | 'auth_profile';

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

const PROVIDERS = [
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

const CREATE_NEW_VALUE = '__create_new__';

/**
 * Returns the auth types to filter by based on the LLM provider.
 */
function getAuthTypesForProvider(provider: string): AuthType[] {
  const normalized = provider.toLowerCase();
  switch (normalized) {
    case 'bedrock':
      return ['api_key', 'bearer', 'aws_iam'];
    case 'azure':
    case 'microsoft_foundry_anthropic':
      return ['api_key', 'bearer', 'azure_ad'];
    default:
      return ['api_key', 'bearer'];
  }
}

export function AddConnectionDialog({
  open,
  onClose,
  modelId,
  modelDisplayName,
  canonicalModelId,
  tenantId,
  provider,
  onCreated,
  projectId,
}: AddConnectionDialogProps) {
  const t = useTranslations('admin');
  const supportedModelId = canonicalModelId?.trim() || null;

  // Credential mode toggle (only relevant when projectId is available)
  const [credentialMode, setCredentialMode] = useState<CredentialMode>('manual');

  // Auth profile selection
  const [selectedAuthProfileId, setSelectedAuthProfileId] = useState<string | null>(null);

  // Credential selection
  const [credentials, setCredentials] = useState<TenantCredential[]>([]);
  const [isLoadingCreds, setIsLoadingCreds] = useState(false);
  const [selectedCredentialId, setSelectedCredentialId] = useState('');
  const [isPrimary, setIsPrimary] = useState(true);
  const [isCreating, setIsCreating] = useState(false);

  // Inline credential creation form
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newCredName, setNewCredName] = useState('');
  const [newCredProvider, setNewCredProvider] = useState(provider);
  const [newCredApiKey, setNewCredApiKey] = useState('');
  const [newCredEndpoint, setNewCredEndpoint] = useState('');
  const [newCredCustomHeaders, setNewCredCustomHeaders] = useState('');
  const [isCreatingCred, setIsCreatingCred] = useState(false);
  // Azure-specific
  const [newCredResourceName, setNewCredResourceName] = useState('');
  const [newCredApiVersion, setNewCredApiVersion] = useState('');
  const [newCredDeploymentId, setNewCredDeploymentId] = useState('');
  // Microsoft Foundry Anthropic-specific
  const [newCredFoundryAuthType, setNewCredFoundryAuthType] = useState<'api_key' | 'azure_ad'>(
    'api_key',
  );
  const [newCredFoundryAnthropicVersion, setNewCredFoundryAnthropicVersion] = useState('');
  // Custom provider-specific
  const [newCredCustomApiFormat, setNewCredCustomApiFormat] = useState<
    'openai_compatible' | 'anthropic_messages'
  >('openai_compatible');
  // Bedrock-specific
  const [newCredBedrockMode, setNewCredBedrockMode] = useState<'explicit' | 'iam_role'>('iam_role');
  const [newCredAwsRegion, setNewCredAwsRegion] = useState('us-east-1');
  const [newCredAwsAccessKeyId, setNewCredAwsAccessKeyId] = useState('');
  const [newCredAwsSecretKey, setNewCredAwsSecretKey] = useState('');
  const [newCredAwsSessionToken, setNewCredAwsSessionToken] = useState('');
  const [newCredAwsRoleArn, setNewCredAwsRoleArn] = useState('');
  const [newCredAwsStsEndpoint, setNewCredAwsStsEndpoint] = useState('');
  const [newCredAwsResourceArn, setNewCredAwsResourceArn] = useState('');
  const [newCredAwsEndpoint, setNewCredAwsEndpoint] = useState('');
  const [newCredAwsCustomHeaders, setNewCredAwsCustomHeaders] = useState('');

  // Post-creation state
  const [createdConnId, setCreatedConnId] = useState<string | null>(null);
  const [createdConnName, setCreatedConnName] = useState('');
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const loadCredentials = useCallback(async () => {
    setIsLoadingCreds(true);
    try {
      const res = await apiFetch('/api/tenant-credentials');
      if (!res.ok) throw new Error('Failed to load credentials');
      const data = await res.json();
      const all: TenantCredential[] = data.credentials || [];
      // Filter by provider (case-insensitive)
      const filtered = all.filter((c) => c.provider.toLowerCase() === provider.toLowerCase());
      setCredentials(filtered);
    } catch {
      toast.error(t('models_page.add_connection.load_failed'));
    } finally {
      setIsLoadingCreds(false);
    }
  }, [provider]);

  useEffect(() => {
    if (open) {
      loadCredentials();
    }
  }, [open, loadCredentials]);

  const reset = () => {
    setCredentialMode('manual');
    setSelectedAuthProfileId(null);
    setSelectedCredentialId('');
    setIsPrimary(true);
    setShowCreateForm(false);
    setNewCredName('');
    setNewCredProvider(provider);
    setNewCredApiKey('');
    setNewCredEndpoint('');
    setNewCredCustomHeaders('');
    setNewCredResourceName('');
    setNewCredApiVersion('');
    setNewCredDeploymentId('');
    setNewCredFoundryAuthType('api_key');
    setNewCredFoundryAnthropicVersion('');
    setNewCredCustomApiFormat('openai_compatible');
    setNewCredBedrockMode('iam_role');
    setNewCredAwsRegion('us-east-1');
    setNewCredAwsAccessKeyId('');
    setNewCredAwsSecretKey('');
    setNewCredAwsSessionToken('');
    setNewCredAwsRoleArn('');
    setNewCredAwsStsEndpoint('');
    setNewCredAwsResourceArn('');
    setNewCredAwsEndpoint('');
    setNewCredAwsCustomHeaders('');
    setCreatedConnId(null);
    setCreatedConnName('');
    setIsTesting(false);
    setTestResult(null);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleDone = () => {
    reset();
    onCreated();
  };

  const handleDropdownChange = (value: string) => {
    if (value === CREATE_NEW_VALUE) {
      setSelectedCredentialId('');
      setShowCreateForm(true);
    } else {
      setSelectedCredentialId(value);
      setShowCreateForm(false);
    }
  };

  const handleCreateCredential = async () => {
    const isBedrock = newCredProvider === 'bedrock';
    const isFoundryAnthropic = newCredProvider === 'microsoft_foundry_anthropic';
    const isCustomAnthropic =
      newCredProvider === 'custom' && newCredCustomApiFormat === 'anthropic_messages';
    if (!newCredName.trim()) return;
    if (isBedrock) {
      if (newCredBedrockMode === 'explicit') {
        if (!newCredAwsAccessKeyId.trim() || !newCredAwsSecretKey.trim()) return;
      } else {
        if (
          !newCredAwsRoleArn.trim() ||
          !newCredAwsStsEndpoint.trim() ||
          !newCredAwsResourceArn.trim()
        )
          return;
      }
    } else {
      if (!newCredApiKey.trim()) return;
    }
    if ((isFoundryAnthropic || isCustomAnthropic) && !newCredEndpoint.trim()) return;
    setIsCreatingCred(true);
    try {
      const body: Record<string, unknown> = {
        name: newCredName.trim(),
        provider: newCredProvider,
        apiKey: isBedrock
          ? newCredBedrockMode === 'explicit'
            ? newCredAwsAccessKeyId.trim()
            : BEDROCK_AMBIENT_SENTINEL
          : newCredApiKey.trim(),
      };
      if (newCredEndpoint.trim()) {
        body.endpoint = newCredEndpoint.trim();
      }
      if (newCredCustomHeaders.trim()) {
        try {
          body.customHeaders = JSON.parse(newCredCustomHeaders.trim());
        } catch {
          toast.error(t('models_page.add_connection.custom_headers_invalid'));
          setIsCreatingCred(false);
          return;
        }
      }
      // Azure-specific: resource name + api version + deployment id
      if (newCredProvider === 'azure') {
        body.authConfig = {
          ...(newCredResourceName.trim() ? { resourceName: newCredResourceName.trim() } : {}),
          ...(newCredApiVersion.trim() ? { apiVersion: newCredApiVersion.trim() } : {}),
          ...(newCredDeploymentId.trim() ? { deploymentId: newCredDeploymentId.trim() } : {}),
        };
      }
      if (isFoundryAnthropic) {
        body.authType = newCredFoundryAuthType;
        body.authConfig = {
          apiFormat: 'anthropic_messages',
          ...(newCredFoundryAnthropicVersion.trim()
            ? { anthropicVersion: newCredFoundryAnthropicVersion.trim() }
            : {}),
        };
      }
      if (isCustomAnthropic) {
        body.authConfig = { apiFormat: 'anthropic_messages' };
      }
      // Bedrock-specific
      if (isBedrock) {
        body.authType = 'aws_iam';
        if (newCredBedrockMode === 'iam_role') {
          body.apiKey = BEDROCK_AMBIENT_SENTINEL;
          let parsedHeaders: Record<string, string> | undefined;
          if (newCredAwsCustomHeaders.trim()) {
            try {
              parsedHeaders =
                parseBedrockCustomHeaders(newCredAwsCustomHeaders.trim()) ?? undefined;
              if (!parsedHeaders) throw new Error('Invalid Bedrock custom headers');
            } catch {
              toast.error(t('models_page.add_connection.custom_headers_invalid'));
              setIsCreatingCred(false);
              return;
            }
          }
          body.authConfig = {
            region: newCredAwsRegion || 'us-east-1',
            useAmbientCredentials: true,
            roleArn: newCredAwsRoleArn.trim(),
            stsEndpoint: newCredAwsStsEndpoint.trim(),
            resourceArn: newCredAwsResourceArn.trim(),
            ...(newCredAwsEndpoint.trim() ? { bedrockEndpoint: newCredAwsEndpoint.trim() } : {}),
            ...(parsedHeaders && Object.keys(parsedHeaders).length > 0
              ? { customHeaders: parsedHeaders }
              : {}),
          };
        } else {
          body.apiKey = newCredAwsAccessKeyId.trim();
          body.authConfig = {
            region: newCredAwsRegion,
            accessKeyId: newCredAwsAccessKeyId.trim(),
            secretAccessKey: newCredAwsSecretKey.trim(),
            ...(newCredAwsSessionToken.trim()
              ? { sessionToken: newCredAwsSessionToken.trim() }
              : {}),
          };
        }
      }
      const res = await apiFetch('/api/tenant-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(extractErrorMessage(err, 'Failed to create credential'));
      }
      const data = await res.json();
      const newId = data.credential?.id ?? data.id;
      toast.success(
        t('models_page.add_connection.credential_created', { name: newCredName.trim() }),
      );

      // Reload credentials and auto-select the new one
      await loadCredentials();
      if (newId) {
        setSelectedCredentialId(newId);
      }
      setShowCreateForm(false);
      setNewCredName('');
      setNewCredApiKey('');
      setNewCredEndpoint('');
      setNewCredCustomHeaders('');
    } catch (err) {
      toast.error(sanitizeError(err, t('models_page.add_connection.credential_create_failed')));
    } finally {
      setIsCreatingCred(false);
    }
  };

  const handleCreateConnection = async () => {
    const isAuthProfileMode = credentialMode === 'auth_profile';

    // Validate: must have either a credential or an auth profile selected
    if (isAuthProfileMode && !selectedAuthProfileId) return;
    if (!isAuthProfileMode && !selectedCredentialId) return;

    setIsCreating(true);
    try {
      const selectedCred = !isAuthProfileMode
        ? credentials.find((c) => c.id === selectedCredentialId)
        : null;

      const payload: Record<string, unknown> = {
        isPrimary,
      };

      if (isAuthProfileMode) {
        payload.authProfileId = selectedAuthProfileId;
      } else {
        payload.credentialId = selectedCredentialId;
      }

      const res = await apiFetch(`/api/tenant-models/${modelId}/connections?tenantId=${tenantId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(extractErrorMessage(err, 'Failed to create connection'));
      }
      const data = await res.json();
      const connId = data.connection?.id;
      setCreatedConnId(connId || null);
      setCreatedConnName(
        isAuthProfileMode ? 'Auth Profile Connection' : selectedCred?.name || 'Connection',
      );
      toast.success(t('models_page.add_connection.connection_created'));
    } catch (err) {
      toast.error(sanitizeError(err, t('models_page.add_connection.create_failed')));
    } finally {
      setIsCreating(false);
    }
  };

  const handleTest = async () => {
    if (!createdConnId) return;
    setIsTesting(true);
    setTestResult(null);
    try {
      const res = await apiFetch(
        `/api/tenant-models/${modelId}/connections/${createdConnId}/validate?tenantId=${tenantId}`,
        { method: 'POST' },
      );
      const data = await res.json();
      setTestResult({ valid: data.valid ?? null, message: data.message || 'Unknown result' });
    } catch {
      setTestResult({
        valid: null,
        message: t('models_page.add_connection.test_network_error'),
      });
    } finally {
      setIsTesting(false);
    }
  };

  // Derived state
  const isAuthProfileMode = credentialMode === 'auth_profile';
  const canUseAuthProfile = Boolean(projectId);
  const authTypesForProvider = getAuthTypesForProvider(provider);
  const canCreate = isAuthProfileMode
    ? Boolean(selectedAuthProfileId)
    : Boolean(selectedCredentialId);

  // Post-creation view
  if (createdConnId) {
    return (
      <Dialog
        open={open}
        onClose={handleDone}
        title={t('models_page.add_connection.connection_created_title')}
        description={t('models_page.add_connection.connection_created_description', {
          name: createdConnName,
          model: modelDisplayName,
        })}
        maxWidth="md"
      >
        <div className="space-y-4">
          <div className="flex items-center gap-3 p-3 rounded-lg bg-success-subtle border border-success/20">
            <CheckCircle2 className="w-5 h-5 text-success shrink-0" />
            <p className="text-sm text-foreground">
              {t('models_page.add_connection.connection_created_message')}
            </p>
          </div>

          {/* Test result */}
          {testResult && (
            <div
              className={clsx(
                'flex items-start gap-3 p-3 rounded-lg border',
                testResult.valid === true && 'bg-success-subtle border-success/20',
                testResult.valid === false && 'bg-error-subtle border-error/20',
                testResult.valid === null && 'bg-warning-subtle border-warning/20',
              )}
            >
              {testResult.valid === true && (
                <CheckCircle2 className="w-5 h-5 text-success shrink-0 mt-0.5" />
              )}
              {testResult.valid === false && (
                <XCircle className="w-5 h-5 text-error shrink-0 mt-0.5" />
              )}
              {testResult.valid === null && (
                <AlertTriangle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
              )}
              <p className="text-sm text-foreground">{testResult.message}</p>
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <Button variant="secondary" onClick={handleTest} loading={isTesting} className="flex-1">
              {isTesting
                ? t('models_page.add_connection.testing')
                : t('models_page.add_connection.test_connection')}
            </Button>
            <Button variant="primary" onClick={handleDone} className="flex-1">
              {t('models_page.add_connection.done')}
            </Button>
          </div>
        </div>
      </Dialog>
    );
  }

  const isBedrockProvider = newCredProvider === 'bedrock';
  const requiresEndpoint =
    newCredProvider === 'microsoft_foundry_anthropic' ||
    (newCredProvider === 'custom' && newCredCustomApiFormat === 'anthropic_messages');

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title={t('models_page.add_connection.title')}
      description={t('models_page.add_connection.description', { name: modelDisplayName })}
      maxWidth="md"
    >
      <div className="space-y-4">
        {/* Credential mode toggle — only shown when projectId is available */}
        {canUseAuthProfile && (
          <div className="flex rounded-lg border border-default bg-background-muted p-1 gap-1">
            <button
              type="button"
              onClick={() => {
                setCredentialMode('manual');
                setSelectedAuthProfileId(null);
              }}
              className={clsx(
                'flex-1 flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-default',
                !isAuthProfileMode
                  ? 'bg-background-elevated text-foreground shadow-sm'
                  : 'text-muted hover:text-foreground',
              )}
            >
              <Key className="h-4 w-4" />
              {t('models_page.add_connection.manual_credentials')}
            </button>
            <button
              type="button"
              onClick={() => {
                setCredentialMode('auth_profile');
                setSelectedCredentialId('');
                setShowCreateForm(false);
              }}
              className={clsx(
                'flex-1 flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-default',
                isAuthProfileMode
                  ? 'bg-background-elevated text-foreground shadow-sm'
                  : 'text-muted hover:text-foreground',
              )}
            >
              <Shield className="h-4 w-4" />
              {t('models_page.add_connection.use_auth_profile')}
            </button>
          </div>
        )}

        {/* Auth Profile picker mode */}
        {isAuthProfileMode && projectId && (
          <div className="space-y-2">
            <label className="block text-sm font-medium text-foreground">
              {t('models_page.add_connection.select_auth_profile')}
            </label>
            <AuthProfilePicker
              projectId={projectId}
              value={selectedAuthProfileId}
              onChange={(profileId) => setSelectedAuthProfileId(profileId)}
              filterAuthTypes={authTypesForProvider}
              filterStatus="active"
              consumerKind="http_tool"
              placeholder={t('models_page.add_connection.auth_profile_placeholder')}
            />
            <p className="text-xs text-muted">
              {t('models_page.add_connection.auth_profile_helper')}
            </p>
          </div>
        )}

        {/* Manual credential mode */}
        {!isAuthProfileMode && (
          <>
            {/* Credential picker */}
            <div className="space-y-1.5">
              <label
                htmlFor="credential-select"
                className="block text-sm font-medium text-foreground"
              >
                {t('models_page.add_connection.credential_label')}
              </label>
              {isLoadingCreds ? (
                <div className="flex items-center gap-2 py-2">
                  <Loader2 className="w-4 h-4 text-muted animate-spin" />
                  <span className="text-sm text-muted">
                    {t('models_page.add_connection.loading_credentials')}
                  </span>
                </div>
              ) : (
                <Select
                  id="credential-select"
                  options={[
                    ...credentials.map((cred) => ({
                      value: cred.id,
                      label: `${cred.name}${cred.endpoint ? ` (${cred.endpoint})` : ''}`,
                    })),
                    {
                      value: CREATE_NEW_VALUE,
                      label: t('models_page.add_connection.create_new_credential'),
                    },
                  ]}
                  value={showCreateForm ? CREATE_NEW_VALUE : selectedCredentialId}
                  onChange={handleDropdownChange}
                  placeholder={t('models_page.add_connection.select_credential')}
                />
              )}
              {credentials.length === 0 && !isLoadingCreds && !showCreateForm && (
                <p className="text-xs text-muted">
                  {t('models_page.add_connection.no_credentials')}
                </p>
              )}
            </div>

            {/* Inline credential creation form */}
            {showCreateForm && (
              <div className="rounded-lg border border-default bg-background-muted p-4 space-y-3">
                <div className="flex items-center gap-2 mb-1">
                  <Plus className="w-4 h-4 text-accent" />
                  <h4 className="text-sm font-medium text-foreground">
                    {t('models_page.add_connection.new_credential_heading')}
                  </h4>
                </div>

                <Input
                  label={t('models_page.add_connection.credential_name_label')}
                  placeholder={t('models_page.add_connection.credential_name_placeholder')}
                  value={newCredName}
                  onChange={(e) => setNewCredName(e.target.value)}
                />

                <ProviderSelect
                  id="new-cred-provider"
                  label={t('models_page.add_connection.provider_label')}
                  providers={PROVIDERS}
                  value={newCredProvider}
                  onChange={(v) => setNewCredProvider(v)}
                />

                {/* --- Bedrock: credential mode toggle + fields --- */}
                {newCredProvider === 'bedrock' ? (
                  <>
                    <RadioGroup
                      label={t('models_page.add_connection.bedrock_credential_mode')}
                      value={newCredBedrockMode}
                      onChange={(v) => setNewCredBedrockMode(v as 'explicit' | 'iam_role')}
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
                      value={newCredAwsRegion}
                      onChange={(e) => setNewCredAwsRegion(e.target.value)}
                    />
                    {newCredBedrockMode === 'iam_role' && (
                      <>
                        <div>
                          <Input
                            label={t('models_page.add_connection.bedrock_role_arn_label')}
                            placeholder={t(
                              'models_page.add_connection.bedrock_role_arn_placeholder',
                            )}
                            value={newCredAwsRoleArn}
                            onChange={(e) => setNewCredAwsRoleArn(e.target.value)}
                            required
                          />
                          <p className="text-xs text-muted mt-1">
                            {t('models_page.add_connection.bedrock_role_arn_description')}
                          </p>
                        </div>
                        <div>
                          <Input
                            label={t('models_page.add_connection.bedrock_sts_endpoint_label')}
                            placeholder={t(
                              'models_page.add_connection.bedrock_sts_endpoint_placeholder',
                            )}
                            value={newCredAwsStsEndpoint}
                            onChange={(e) => setNewCredAwsStsEndpoint(e.target.value)}
                            required
                          />
                          <p className="text-xs text-muted mt-1">
                            {t('models_page.add_connection.bedrock_sts_endpoint_description')}
                          </p>
                        </div>
                        <div>
                          <Input
                            label={t('models_page.add_connection.bedrock_resource_arn_label')}
                            placeholder={t(
                              'models_page.add_connection.bedrock_resource_arn_placeholder',
                            )}
                            value={newCredAwsResourceArn}
                            onChange={(e) => setNewCredAwsResourceArn(e.target.value)}
                            required
                          />
                          <p className="text-xs text-muted mt-1">
                            {t('models_page.add_connection.bedrock_resource_arn_description')}
                          </p>
                        </div>
                        <div>
                          <Input
                            label={t('models_page.add_connection.bedrock_endpoint_label')}
                            placeholder={t(
                              'models_page.add_connection.bedrock_endpoint_placeholder',
                            )}
                            value={newCredAwsEndpoint}
                            onChange={(e) => setNewCredAwsEndpoint(e.target.value)}
                          />
                          <p className="text-xs text-muted mt-1">
                            {t('models_page.add_connection.bedrock_endpoint_description')}
                          </p>
                        </div>
                        <div className="space-y-1.5">
                          <label
                            htmlFor="bedrock-conn-headers"
                            className="block text-sm font-medium text-foreground"
                          >
                            {t('models_page.add_connection.bedrock_custom_headers_label')}
                          </label>
                          <p className="text-xs text-muted">
                            {t('models_page.add_connection.bedrock_custom_headers_description')}
                          </p>
                          <textarea
                            id="bedrock-conn-headers"
                            placeholder={'{\n  "x-custom-header": "value"\n}'}
                            value={newCredAwsCustomHeaders}
                            onChange={(e) => setNewCredAwsCustomHeaders(e.target.value)}
                            rows={3}
                            className="w-full rounded-md border border-default bg-background-subtle text-foreground text-sm py-2 px-3 font-mono focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus transition-default resize-y"
                          />
                        </div>
                      </>
                    )}
                    {newCredBedrockMode === 'explicit' && (
                      <>
                        <Input
                          label={t('models_page.add_connection.bedrock_access_key_id_label')}
                          placeholder={t(
                            'models_page.add_connection.bedrock_access_key_id_placeholder',
                          )}
                          value={newCredAwsAccessKeyId}
                          onChange={(e) => setNewCredAwsAccessKeyId(e.target.value)}
                        />
                        <Input
                          label={t('models_page.add_connection.bedrock_secret_access_key_label')}
                          type="password"
                          autoComplete="off"
                          showToggle
                          placeholder={t(
                            'models_page.add_connection.bedrock_secret_access_key_placeholder',
                          )}
                          value={newCredAwsSecretKey}
                          onChange={(e) => setNewCredAwsSecretKey(e.target.value)}
                        />
                        <Input
                          label={t('models_page.add_connection.bedrock_session_token_label')}
                          type="password"
                          autoComplete="off"
                          showToggle
                          placeholder={t(
                            'models_page.add_connection.bedrock_session_token_placeholder',
                          )}
                          value={newCredAwsSessionToken}
                          onChange={(e) => setNewCredAwsSessionToken(e.target.value)}
                        />
                      </>
                    )}
                  </>
                ) : (
                  <Input
                    label={t('models_page.add_connection.api_key_label')}
                    type="password"
                    autoComplete="off"
                    showToggle
                    placeholder={t('models_page.add_connection.api_key_placeholder')}
                    value={newCredApiKey}
                    onChange={(e) => setNewCredApiKey(e.target.value)}
                  />
                )}
                {newCredProvider === 'microsoft_foundry_anthropic' && (
                  <>
                    <Select
                      label="Auth Mode"
                      options={[
                        { value: 'api_key', label: 'API key' },
                        { value: 'azure_ad', label: 'Microsoft Entra bearer token' },
                      ]}
                      value={newCredFoundryAuthType}
                      onChange={(v) => setNewCredFoundryAuthType(v as 'api_key' | 'azure_ad')}
                    />
                    <Input
                      label={t('models_page.add_connection.endpoint_label')}
                      placeholder="https://<resource>.services.ai.azure.com/anthropic"
                      value={newCredEndpoint}
                      onChange={(e) => setNewCredEndpoint(e.target.value)}
                    />
                    <Input
                      label="Anthropic Version"
                      placeholder="e.g. 2023-06-01"
                      value={newCredFoundryAnthropicVersion}
                      onChange={(e) => setNewCredFoundryAnthropicVersion(e.target.value)}
                    />
                  </>
                )}
                {/* --- Azure: Resource Name + Endpoint --- */}
                {newCredProvider === 'azure' && (
                  <>
                    <Input
                      label="Resource Name"
                      placeholder="e.g. gale-qa"
                      value={newCredResourceName}
                      onChange={(e) => setNewCredResourceName(e.target.value)}
                    />
                    <p className="text-xs text-muted -mt-1">your_resource_name from Azure portal</p>
                    <Input
                      label="Deployment ID"
                      placeholder={supportedModelId || 'e.g. custom-deployment-name'}
                      value={newCredDeploymentId}
                      onChange={(e) => setNewCredDeploymentId(e.target.value)}
                    />
                    <p className="text-xs text-muted -mt-1">
                      {supportedModelId
                        ? `Optional. Leave blank when the Azure deployment name matches the supported model ID (${supportedModelId}); set this only if your Azure deployment uses a custom name.`
                        : 'Optional. Set this only if your Azure deployment uses a custom name.'}
                    </p>
                    <Input
                      label="API Version"
                      placeholder="e.g. 2024-02-15-preview"
                      value={newCredApiVersion}
                      onChange={(e) => setNewCredApiVersion(e.target.value)}
                    />
                    <p className="text-xs text-muted -mt-1">api_version for the Azure OpenAI API</p>
                  </>
                )}
                {/* --- Custom: Endpoint + Headers --- */}
                {newCredProvider === 'custom' && (
                  <>
                    <Select
                      label="API Format"
                      options={[
                        { value: 'openai_compatible', label: 'OpenAI compatible' },
                        { value: 'anthropic_messages', label: 'Anthropic Messages' },
                      ]}
                      value={newCredCustomApiFormat}
                      onChange={(v) =>
                        setNewCredCustomApiFormat(v as 'openai_compatible' | 'anthropic_messages')
                      }
                    />
                    <Input
                      label={t('models_page.add_connection.endpoint_label')}
                      placeholder={
                        newCredCustomApiFormat === 'anthropic_messages'
                          ? 'https://proxy.example.com/anthropic'
                          : t('models_page.add_connection.endpoint_placeholder')
                      }
                      value={newCredEndpoint}
                      onChange={(e) => setNewCredEndpoint(e.target.value)}
                    />
                    <div className="space-y-1.5">
                      <label
                        htmlFor="new-cred-headers"
                        className="block text-sm font-medium text-foreground"
                      >
                        {t('models_page.add_connection.custom_headers_label')}{' '}
                        <span className="text-muted font-normal">
                          {t('models_page.add_connection.custom_headers_optional')}
                        </span>
                      </label>
                      <textarea
                        id="new-cred-headers"
                        placeholder={'{\n  "x-custom-header": "value"\n}'}
                        value={newCredCustomHeaders}
                        onChange={(e) => setNewCredCustomHeaders(e.target.value)}
                        rows={3}
                        className="w-full rounded-md border border-default bg-background-subtle text-foreground text-sm py-2 px-3 font-mono focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus transition-default resize-y"
                      />
                      <p className="text-xs text-muted">
                        {t('models_page.add_connection.custom_headers_placeholder')}
                      </p>
                    </div>
                  </>
                )}

                <div className="flex gap-2 pt-1">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      reset();
                    }}
                  >
                    {t('models_page.add_connection.cancel')}
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleCreateCredential}
                    loading={isCreatingCred}
                    disabled={
                      !newCredName.trim() ||
                      (requiresEndpoint && !newCredEndpoint.trim()) ||
                      (isBedrockProvider
                        ? newCredBedrockMode === 'explicit'
                          ? !newCredAwsAccessKeyId.trim() || !newCredAwsSecretKey.trim()
                          : !newCredAwsRoleArn.trim() ||
                            !newCredAwsStsEndpoint.trim() ||
                            !newCredAwsResourceArn.trim()
                        : !newCredApiKey.trim())
                    }
                  >
                    {t('models_page.add_connection.create_credential')}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}

        {/* Set as primary */}
        <Checkbox
          checked={isPrimary}
          onChange={(checked) => setIsPrimary(checked)}
          label={t('models_page.add_connection.set_primary')}
        />

        <div className="flex gap-3 pt-2">
          <Button variant="secondary" onClick={handleClose} className="flex-1">
            {t('models_page.add_connection.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleCreateConnection}
            loading={isCreating}
            disabled={!canCreate}
            className="flex-1"
          >
            {t('models_page.add_connection.create')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
