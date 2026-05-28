/**
 * CreateInstanceDialog -- shared dialog for creating new channel instances.
 *
 * Dynamically renders form fields based on channel type definition from the
 * registry. Dispatches to the correct backend API (SDK, Connection, or
 * Webhook Subscription) on submit.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircle, CheckCircle, Globe, Loader2, Server, Shield } from 'lucide-react';
import { toast } from 'sonner';

import {
  createChannel,
  fetchSdkJweCapability,
  type SDKJweCapability,
  type SDKChannelAuthMode,
  type SDKTokenEnvelopePolicy,
} from '../../../api/channels';
import { fetchDeployments, type Deployment } from '../../../api/deployments';
import { createConnection, type CreateConnectionInput } from '../../../api/channel-connections';
import { createSubscription } from '../../../api/http-async-channels';
import { initiateChannelOAuth, exchangeChannelOAuthCode } from '../../../api/channel-oauth';
import type { ChannelOAuthCallbackResult } from '../../../api/channel-oauth';
import { apiFetch } from '../../../lib/api-client';
import { sanitizeError } from '../../../lib/sanitize-error';

import { Dialog } from '../../ui/Dialog';
import { Input } from '../../ui/Input';
import { Select } from '../../ui/Select';
import { Button } from '../../ui/Button';
import { CodeBlock } from '../../ui/CodeBlock';
import { useRuntimeConfig } from '../../../contexts/RuntimeConfigContext';

import { getChannelDef } from './channel-registry';
import type { ChannelTypeId, CredentialFieldDef } from './types';
import {
  buildConnectionBindingCreate,
  buildSdkChannelBindingCreate,
} from './channel-binding-utils';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface CreateInstanceDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  channelType: ChannelTypeId;
  onCreated: () => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  isActive: boolean;
}

// ENVIRONMENT_OPTIONS is defined inside the component to use i18n translations.

/** Map from unified ChannelTypeId to the SDK backend channel type string. */
const SDK_BACKEND_TYPE: Partial<Record<ChannelTypeId, string>> = {
  sdk_web: 'web',
  sdk_api: 'api',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CreateInstanceDialog({
  open,
  onClose,
  projectId,
  channelType,
  onCreated,
}: CreateInstanceDialogProps) {
  const t = useTranslations('channels.create_instance');
  const tEnv = useTranslations('deployments.env_labels');
  const { runtimeUrl } = useRuntimeConfig();
  const def = getChannelDef(channelType);

  const ENVIRONMENT_OPTIONS = [
    { value: '', label: t('environment_working_copy') },
    { value: 'dev', label: tEnv('dev') },
    { value: 'staging', label: tEnv('staging') },
    { value: 'production', label: tEnv('production') },
  ];

  // ── Provider state (for channels with providerOptions like WhatsApp) ────

  const hasProviders = !!(def.providerOptions && def.providerOptions.length > 0);
  const [selectedProvider, setSelectedProvider] = useState(
    hasProviders ? def.providerOptions![0].id : '',
  );
  const [authType, setAuthType] = useState<'api_key' | 'basic'>('api_key');

  // Derive active credential fields from selected provider (or fall back to channel defaults)
  const activeProviderOption = hasProviders
    ? def.providerOptions!.find((p) => p.id === selectedProvider)
    : null;
  const activeCredentialFields: CredentialFieldDef[] = activeProviderOption
    ? activeProviderOption.credentialFields
    : def.credentialFields;

  // ── Form state ──────────────────────────────────────────────────────────

  const [displayName, setDisplayName] = useState('');
  const [externalId, setExternalId] = useState('');
  const [environment, setEnvironment] = useState('');
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [selectedDeploymentId, setSelectedDeploymentId] = useState('');
  const [credValues, setCredValues] = useState<Record<string, string>>({});
  const [callbackUrl, setCallbackUrl] = useState('');
  const [apiKeyId, setApiKeyId] = useState('');
  const [sdkAuthMode, setSdkAuthMode] = useState<SDKChannelAuthMode>('anonymous');
  const [sdkTokenEnvelopePolicy, setSdkTokenEnvelopePolicy] =
    useState<SDKTokenEnvelopePolicy>('inherit');
  const [sdkJweCapability, setSdkJweCapability] = useState<SDKJweCapability | null>(null);
  const [createdServerSecret, setCreatedServerSecret] = useState<string | null>(null);
  const [createdAI4WCredentials, setCreatedAI4WCredentials] = useState<{
    connectionId: string;
    connectionSecret: string;
    endpointUrl: string;
  } | null>(null);
  const [providerVerificationStrength, setProviderVerificationStrength] = useState<
    'weak' | 'strong'
  >('weak');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  // ── OAuth state ─────────────────────────────────────────────────────────

  const [useManualCredentials, setUseManualCredentials] = useState(false);
  const [oauthResult, setOauthResult] = useState<ChannelOAuthCallbackResult | null>(null);
  const [oauthLoading, setOauthLoading] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);

  // ── SDK API keys (only for SDK channels) ────────────────────────────────

  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [loadingKeys, setLoadingKeys] = useState(false);

  const isSDK = def.category === 'sdk';
  const isWebhook = def.category === 'webhook';
  const supportsOAuth = def.capabilities.supportsOAuth === true;

  const loadApiKeys = useCallback(async () => {
    if (!isSDK) return;
    setLoadingKeys(true);
    try {
      const res = await apiFetch(`/api/sdk/keys?projectId=${projectId}`);
      const data = await res.json();
      setApiKeys(data.keys ?? []);
    } catch (err) {
      console.error('[CreateInstanceDialog] Failed to load API keys:', err);
    } finally {
      setLoadingKeys(false);
    }
  }, [projectId, isSDK]);

  useEffect(() => {
    if (open && isSDK) {
      loadApiKeys();
    }
  }, [open, isSDK, loadApiKeys]);

  // ── Load deployments on open ──────────────────────────────────────────

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchDeployments(projectId)
      .then((res) => {
        if (!cancelled) {
          setDeployments(res.deployments.filter((d: Deployment) => d.status === 'active'));
        }
      })
      .catch(() => {
        // Non-blocking — user can still use environment-based selection
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  // ── Reset form on close ─────────────────────────────────────────────────

  useEffect(() => {
    if (!open) {
      setDisplayName('');
      setExternalId('');
      setEnvironment('');
      setSelectedDeploymentId('');
      setCredValues({});
      setCallbackUrl('');
      setApiKeyId('');
      setSdkAuthMode('anonymous');
      setSdkTokenEnvelopePolicy('inherit');
      setSdkJweCapability(null);
      setCreatedServerSecret(null);
      setProviderVerificationStrength('weak');
      setErrors({});
      setSaving(false);
      setUseManualCredentials(false);
      setOauthResult(null);
      setOauthLoading(false);
      setOauthError(null);
      if (hasProviders) {
        setSelectedProvider(def.providerOptions![0].id);
      }
      setAuthType('api_key');
    }
  }, [open, hasProviders, def.providerOptions]);

  // Reset credential values when provider changes
  useEffect(() => {
    setCredValues({});
    setErrors({});
  }, [selectedProvider]);

  useEffect(() => {
    if (!open || !isSDK || sdkAuthMode !== 'hosted_exchange') {
      setSdkJweCapability(null);
      return;
    }

    let cancelled = false;
    fetchSdkJweCapability(projectId)
      .then((capability) => {
        if (!cancelled) {
          setSdkJweCapability(capability);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSdkJweCapability(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isSDK, open, projectId, sdkAuthMode]);

  // ── OAuth flow ──────────────────────────────────────────────────────────

  const OAUTH_MESSAGE_TYPE = 'channel-oauth-callback';
  const POPUP_WIDTH = 600;
  const POPUP_HEIGHT = 700;

  async function handleOAuthConnect() {
    setOauthLoading(true);
    setOauthError(null);
    try {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || window.location.origin;
      const redirectUri = `${appUrl}/oauth/channel-callback`;
      const { authUrl } = await initiateChannelOAuth(channelType, projectId, redirectUri);

      // Open popup
      const left = Math.round(window.screenX + (window.outerWidth - POPUP_WIDTH) / 2);
      const top = Math.round(window.screenY + (window.outerHeight - POPUP_HEIGHT) / 2);
      const popup = window.open(
        authUrl,
        'channel-oauth-popup',
        `width=${POPUP_WIDTH},height=${POPUP_HEIGHT},left=${left},top=${top},toolbar=no,menubar=no,scrollbars=yes,resizable=yes`,
      );

      if (!popup) {
        setOauthError('Popup was blocked by the browser. Please allow popups and try again.');
        setOauthLoading(false);
        return;
      }

      // Listen for postMessage from popup
      const handleMessage = async (event: MessageEvent) => {
        // Accept messages from the current origin OR from the configured app URL
        // (popup may load via tunnel/proxy with a different origin than the parent)
        const allowedOrigins = [window.location.origin];
        if (appUrl && appUrl !== window.location.origin) allowedOrigins.push(appUrl);
        if (!allowedOrigins.includes(event.origin)) return;
        if (!event.data || event.data.type !== OAUTH_MESSAGE_TYPE) return;

        window.removeEventListener('message', handleMessage);
        clearInterval(pollTimer);

        if (event.data.error) {
          setOauthError(
            typeof event.data.error === 'string' ? event.data.error : 'Authorization failed',
          );
          setOauthLoading(false);
          return;
        }

        const { code, state } = event.data;
        if (!code || !state) {
          setOauthError('Missing authorization parameters');
          setOauthLoading(false);
          return;
        }

        try {
          const result = await exchangeChannelOAuthCode(channelType, code, state);
          setOauthResult(result);

          // Pre-fill form fields from OAuth result
          if (result.displayName) setDisplayName(result.displayName);
          if (result.externalIdentifier) setExternalId(result.externalIdentifier);
          if (result.credentials) {
            setCredValues(result.credentials);
          }
          setOauthLoading(false);
        } catch (err) {
          setOauthError(sanitizeError(err, 'Failed to exchange authorization code'));
          setOauthLoading(false);
        }
      };

      window.addEventListener('message', handleMessage);

      // Poll for popup close
      const pollTimer = setInterval(() => {
        if (popup.closed) {
          clearInterval(pollTimer);
          window.removeEventListener('message', handleMessage);
          setOauthLoading((loading) => {
            if (loading) {
              setOauthError('Authorization window was closed');
              return false;
            }
            return loading;
          });
        }
      }, 500);
    } catch (err) {
      setOauthError(sanitizeError(err, 'Failed to start OAuth flow'));
      setOauthLoading(false);
    }
  }

  // ── Validation ──────────────────────────────────────────────────────────

  function validate(): boolean {
    const next: Record<string, string> = {};

    if (!displayName.trim() && !isWebhook) {
      next.displayName = t('name_required');
    }

    if (isWebhook && !callbackUrl.trim()) {
      next.callbackUrl = t('callback_url_required');
    }

    if (isSDK && !apiKeyId) {
      next.apiKeyId = t('api_key_required');
    }

    if (
      !isWebhook &&
      !def.capabilities.autoGenerateIdentifier &&
      def.category === 'messaging' &&
      !externalId.trim()
    ) {
      next.externalId = t('identifier_required', { label: def.externalIdentifierLabel });
    }
    if (
      selectedProvider === 'infobip' &&
      externalId.trim() &&
      !/^\+?\d{6,20}$/.test(externalId.trim())
    ) {
      next.externalId = 'Enter the Infobip sender number as digits only, without spaces';
    }

    // Skip credential validation if OAuth was used successfully
    if (!oauthResult || useManualCredentials) {
      // For Infobip with basic auth, username+password are required; for api_key auth, api_key is required
      const isInfobipBasic = selectedProvider === 'infobip' && authType === 'basic';
      for (const field of activeCredentialFields) {
        // Adjust required-ness based on auth type for Infobip
        let isRequired = field.required;
        if (selectedProvider === 'infobip') {
          if (field.key === 'api_key') isRequired = !isInfobipBasic;
          if (field.key === 'username' || field.key === 'password') isRequired = isInfobipBasic;
        }

        if (isRequired && !credValues[field.key]?.trim()) {
          next[field.key] = t('field_required', { label: field.label });
        }
        if (credValues[field.key]?.trim() && field.validation) {
          const fieldErr = field.validation(credValues[field.key]);
          if (fieldErr) {
            next[field.key] = fieldErr;
          }
        }
      }
    }

    setErrors(next);
    return Object.keys(next).length === 0;
  }

  // ── Submit ──────────────────────────────────────────────────────────────

  async function handleSubmit() {
    if (!validate()) return;

    setSaving(true);
    try {
      if (isSDK) {
        // SDK channel creation
        const sdkType = SDK_BACKEND_TYPE[channelType];
        if (!sdkType) {
          toast.error(t('unsupported_sdk_type', { type: channelType }));
          return;
        }
        const response = await createChannel(projectId, {
          name: displayName.trim(),
          channelType: sdkType,
          publicApiKeyId: apiKeyId,
          config: sdkAuthMode === 'hosted_exchange' ? { sdkTokenEnvelopePolicy } : {},
          auth: { mode: sdkAuthMode },
          ...buildSdkChannelBindingCreate({
            environment,
            followEnvironment: true,
            pinnedDeploymentId: selectedDeploymentId,
          }),
        });
        if (response.serverSecret) {
          onCreated();
          setCreatedServerSecret(response.serverSecret);
          toast.success(t('success'));
          return;
        }
      } else if (isWebhook) {
        // Webhook subscription creation
        await createSubscription({
          callback_url: callbackUrl.trim(),
          project_id: projectId,
          events: ['agent.response'],
          description: displayName.trim() || undefined,
        });
      } else {
        // Messaging channel connection creation
        const credentials: Record<string, unknown> = {};
        for (const field of activeCredentialFields) {
          if (credValues[field.key]?.trim()) {
            credentials[field.key] = credValues[field.key].trim();
          }
        }

        // Build config for channels with provider options
        const config: Record<string, unknown> = {};
        if (hasProviders && selectedProvider) {
          config.provider = selectedProvider;
          // Infobip needs authType in config (not credentials) for the runtime to resolve auth
          if (selectedProvider === 'infobip') {
            config.authType = authType;
          }
        }

        const connResult = await createConnection(projectId, {
          channel_type: channelType as CreateConnectionInput['channel_type'],
          display_name: displayName.trim() || undefined,
          external_identifier: def.capabilities.autoGenerateIdentifier
            ? undefined
            : selectedProvider === 'infobip'
              ? externalId.trim().replace(/^\+/, '') || undefined
              : externalId.trim() || undefined,
          credentials: Object.keys(credentials).length > 0 ? credentials : undefined,
          config: Object.keys(config).length > 0 ? config : undefined,
          identityVerification: {
            providerVerificationStrength,
          },
          ...buildConnectionBindingCreate({
            environment,
            followEnvironment: true,
            pinnedDeploymentId: selectedDeploymentId,
          }),
        });

        // AI4W: capture one-time credentials before closing the dialog
        if (channelType === 'ai4w' && connResult.ai4w) {
          const baseUrl =
            runtimeUrl || (typeof window !== 'undefined' ? window.location.origin : '');
          onCreated();
          setCreatedAI4WCredentials({
            connectionId: connResult.ai4w.connectionId,
            connectionSecret: connResult.ai4w.connectionSecret,
            endpointUrl: `${baseUrl}/api/v1/channels/ai4w/${connResult.ai4w.connectionId}/message`,
          });
          toast.success(t('success'));
          return;
        }
      }

      toast.success(t('success'));
      onCreated();
      onClose();
    } catch (err) {
      toast.error(sanitizeError(err, t('error')));
    } finally {
      setSaving(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────

  const activeKeys = apiKeys.filter((k) => k.isActive);
  const sdkTokenEnvelopeOptions = [
    { value: 'inherit', label: t('sdk_token_envelope_policy_inherit') },
    { value: 'signed', label: t('sdk_token_envelope_policy_signed') },
    { value: 'jwe_preferred', label: t('sdk_token_envelope_policy_jwe_preferred') },
    { value: 'jwe_required', label: t('sdk_token_envelope_policy_jwe_required') },
  ];
  const showSdkJweRequiredWarning =
    sdkAuthMode === 'hosted_exchange' &&
    sdkTokenEnvelopePolicy === 'jwe_required' &&
    sdkJweCapability !== null &&
    (!sdkJweCapability.canIssueBootstrap || !sdkJweCapability.canIssueSession);

  if (isSDK && createdServerSecret) {
    return (
      <Dialog open={open} onClose={onClose} title={t('hosted_secret_title')} maxWidth="lg">
        <div className="space-y-4">
          <div className="rounded-lg border border-success/30 bg-success-subtle p-4">
            <div className="flex items-start gap-2">
              <CheckCircle className="w-4 h-4 text-success shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-foreground">{t('hosted_secret_heading')}</p>
                <p className="text-xs text-muted mt-1">{t('hosted_secret_description')}</p>
              </div>
            </div>
          </div>

          <CodeBlock code={createdServerSecret} language={t('hosted_secret_code_label')} />

          <div className="rounded-lg border border-warning/30 bg-warning-subtle p-3">
            <div className="flex items-start gap-2">
              <Shield className="w-4 h-4 text-warning shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-warning">
                  {t('hosted_secret_warning_title')}
                </p>
                <ul className="list-disc pl-4 mt-2 space-y-1 text-xs text-warning">
                  <li>{t('hosted_secret_warning_reveal')}</li>
                  <li>{t('hosted_secret_warning_storage')}</li>
                  <li>{t('hosted_secret_warning_browser')}</li>
                </ul>
              </div>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-default bg-background p-3">
              <div className="flex items-center gap-2">
                <Server className="w-4 h-4 text-accent" />
                <p className="text-xs font-medium uppercase tracking-wide text-subtle">
                  {t('hosted_secret_server_title')}
                </p>
              </div>
              <p className="text-xs text-muted mt-2">{t('hosted_secret_server_description')}</p>
            </div>
            <div className="rounded-lg border border-default bg-background p-3">
              <div className="flex items-center gap-2">
                <Globe className="w-4 h-4 text-accent" />
                <p className="text-xs font-medium uppercase tracking-wide text-subtle">
                  {t('hosted_secret_browser_title')}
                </p>
              </div>
              <p className="text-xs text-muted mt-2">{t('hosted_secret_browser_description')}</p>
            </div>
          </div>

          <div className="flex justify-end">
            <Button variant="primary" onClick={onClose}>
              {t('hosted_secret_done')}
            </Button>
          </div>
        </div>
      </Dialog>
    );
  }

  // AI4W post-creation credentials reveal
  if (createdAI4WCredentials) {
    return (
      <Dialog open={open} onClose={onClose} title="AIforWork Connection Created" maxWidth="lg">
        <div className="space-y-4">
          <div className="rounded-lg border border-success/30 bg-success-subtle p-4">
            <div className="flex items-start gap-2">
              <CheckCircle className="w-4 h-4 text-success shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-foreground">
                  Connection created successfully
                </p>
                <p className="text-xs text-muted mt-1">
                  Copy the endpoint URL and connection secret below. You will need these to
                  configure the AIforWork integration.
                </p>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-subtle uppercase tracking-wide">
                Endpoint URL
              </label>
              <CodeBlock code={createdAI4WCredentials.endpointUrl} language="Endpoint" />
            </div>
            <div>
              <label className="text-xs font-medium text-subtle uppercase tracking-wide">
                Connection Secret
              </label>
              <CodeBlock code={createdAI4WCredentials.connectionSecret} language="Secret" />
            </div>
          </div>

          <div className="rounded-lg border border-warning/30 bg-warning-subtle p-3">
            <div className="flex items-start gap-2">
              <Shield className="w-4 h-4 text-warning shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-warning">
                  Important
                </p>
                <ul className="list-disc pl-4 mt-2 space-y-1 text-xs text-warning">
                  <li>
                    The connection secret is shown <strong>only once</strong> and cannot be
                    retrieved again.
                  </li>
                  <li>Store the secret securely in your AI4W configuration.</li>
                  <li>Use this endpoint URL and secret for HMAC-signed requests from AIforWork.</li>
                </ul>
              </div>
            </div>
          </div>

          <div className="flex justify-end">
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onClose={onClose} title={t('title', { name: def.name })} maxWidth="lg">
      <div className="space-y-4">
        {/* Display Name */}
        <Input
          label={t('display_name_label')}
          placeholder={t('display_name_placeholder', { name: def.name })}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          error={errors.displayName}
        />

        {/* External Identifier (messaging channels only, not auto-generated) */}
        {!isWebhook && !isSDK && !def.capabilities.autoGenerateIdentifier && (
          <Input
            label={activeProviderOption?.externalIdentifierLabel || def.externalIdentifierLabel}
            placeholder={
              activeProviderOption?.externalIdentifierPlaceholder ||
              def.externalIdentifierPlaceholder
            }
            value={externalId}
            onChange={(e) => setExternalId(e.target.value)}
            error={errors.externalId}
          />
        )}

        {/* Callback URL (webhook only) */}
        {isWebhook && (
          <Input
            label={t('callback_url_label')}
            placeholder={t('callback_url_placeholder')}
            value={callbackUrl}
            onChange={(e) => setCallbackUrl(e.target.value)}
            error={errors.callbackUrl}
          />
        )}

        {/* Provider selector (for channels with multiple providers like WhatsApp) */}
        {hasProviders && (
          <Select
            label={t('provider_label')}
            options={def.providerOptions!.map((p) => ({ value: p.id, label: p.name }))}
            value={selectedProvider}
            onChange={setSelectedProvider}
          />
        )}

        {/* Auth type selector (Infobip-specific) */}
        {selectedProvider === 'infobip' && (
          <Select
            label={t('auth_type_label')}
            options={[
              { value: 'api_key', label: 'API Key' },
              { value: 'basic', label: 'Basic Auth (Username/Password)' },
            ]}
            value={authType}
            onChange={(v) => setAuthType(v as 'api_key' | 'basic')}
          />
        )}

        {/* OAuth connect or manual credentials (messaging channels with OAuth) */}
        {supportsOAuth && !useManualCredentials ? (
          <div className="space-y-3">
            {oauthResult ? (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-success-subtle border border-success/30">
                <CheckCircle className="w-4 h-4 text-success shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    Connected to {oauthResult.displayName || def.name}
                  </p>
                  <p className="text-xs text-muted truncate">{oauthResult.externalIdentifier}</p>
                </div>
              </div>
            ) : (
              <Button
                variant="primary"
                onClick={handleOAuthConnect}
                loading={oauthLoading}
                className="w-full"
              >
                {oauthLoading ? 'Connecting...' : `Add to ${def.name}`}
              </Button>
            )}
            {oauthError && (
              <div className="flex items-start gap-2 p-3 rounded-lg bg-error-subtle border border-error/30">
                <AlertCircle className="w-4 h-4 text-error shrink-0 mt-0.5" />
                <p className="text-xs text-error">{oauthError}</p>
              </div>
            )}
            <button
              type="button"
              onClick={() => setUseManualCredentials(true)}
              className="text-xs text-muted hover:text-foreground underline"
            >
              Enter credentials manually instead
            </button>
          </div>
        ) : (
          <>
            {/* Manual credential fields (filtered by auth type for Infobip) */}
            {activeCredentialFields
              .filter((field) => {
                // For Infobip, show only relevant auth fields
                if (selectedProvider === 'infobip') {
                  if (
                    authType === 'api_key' &&
                    (field.key === 'username' || field.key === 'password')
                  )
                    return false;
                  if (authType === 'basic' && field.key === 'api_key') return false;
                }
                return true;
              })
              .map((field) => (
                <Input
                  key={field.key}
                  label={field.label}
                  placeholder={field.placeholder}
                  type={field.type}
                  value={credValues[field.key] ?? ''}
                  onChange={(e) =>
                    setCredValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                  }
                  error={errors[field.key]}
                />
              ))}
            {supportsOAuth && useManualCredentials && (
              <button
                type="button"
                onClick={() => setUseManualCredentials(false)}
                className="text-xs text-muted hover:text-foreground underline"
              >
                Connect with {def.name} instead
              </button>
            )}
          </>
        )}

        {/* Deployment selector (not for webhooks) */}
        {!isWebhook && (
          <div className="space-y-3">
            <Select
              label="Pin to deployment"
              options={[
                { value: '', label: 'None (use environment / working copy below)' },
                ...deployments.map((d) => ({
                  value: d.id,
                  label: `${d.label || d.endpointSlug || d.id.slice(0, 8)} (${d.environment})`,
                })),
              ]}
              value={selectedDeploymentId}
              onChange={(val) => {
                setSelectedDeploymentId(val);
                if (val) {
                  setEnvironment('');
                }
              }}
            />

            {!selectedDeploymentId && (
              <div className="space-y-1.5">
                <Select
                  label="Environment"
                  options={ENVIRONMENT_OPTIONS}
                  value={environment}
                  onChange={(value) => {
                    setEnvironment(value);
                  }}
                />
                <p className="text-xs text-muted">
                  Choose Working Copy to use the latest draft, or pick an environment to follow its
                  active deployment.
                </p>
              </div>
            )}
          </div>
        )}

        {!isWebhook && !isSDK && (
          <div className="space-y-1.5">
            <Select
              label={t('verification_strength_label')}
              options={[
                { value: 'weak', label: t('verification_strength_weak') },
                { value: 'strong', label: t('verification_strength_strong') },
              ]}
              value={providerVerificationStrength}
              onChange={(value) => setProviderVerificationStrength(value as 'weak' | 'strong')}
            />
            <p className="text-xs text-muted">{t('verification_strength_help')}</p>
          </div>
        )}

        {/* API Key selector (SDK channels only) */}
        {isSDK && (
          <div className="space-y-3">
            <div className="rounded-lg border border-default bg-background-muted p-4">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-accent shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-foreground">{t('auth_mode_title')}</p>
                  <p className="text-xs text-muted mt-1">{t('auth_mode_description')}</p>
                </div>
              </div>

              <div className="mt-3">
                <div className="grid gap-2 md:grid-cols-2">
                  {(
                    [
                      ['anonymous', t('auth_mode_anonymous')],
                      ['hosted_exchange', t('auth_mode_hosted')],
                    ] as const
                  ).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setSdkAuthMode(mode)}
                      className={`rounded-lg border px-3 py-2 text-left text-sm transition-default ${
                        sdkAuthMode === mode
                          ? 'border-accent bg-accent-subtle text-accent'
                          : 'border-default bg-background text-foreground hover:border-muted'
                      }`}
                    >
                      <span className="font-medium">{label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-2 mt-3">
                <div className="rounded-lg border border-default bg-background p-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-subtle">
                    {t('auth_mode_browser_title')}
                  </p>
                  <p className="text-xs text-muted mt-1">
                    {sdkAuthMode === 'hosted_exchange'
                      ? t('auth_mode_browser_hosted_description')
                      : t('auth_mode_browser_description')}
                  </p>
                </div>
                <div className="rounded-lg border border-default bg-background p-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-subtle">
                    {t('auth_mode_server_title')}
                  </p>
                  <p className="text-xs text-muted mt-1">
                    {sdkAuthMode === 'hosted_exchange'
                      ? t('auth_mode_server_hosted_description')
                      : t('auth_mode_server_description')}
                  </p>
                </div>
              </div>

              <div className="mt-3 rounded-lg border border-warning/30 bg-warning-subtle p-3">
                <p className="text-xs font-medium uppercase tracking-wide text-warning">
                  {t('auth_mode_security_title')}
                </p>
                <ul className="list-disc pl-4 mt-2 space-y-1 text-xs text-warning">
                  <li>
                    {sdkAuthMode === 'hosted_exchange'
                      ? t('auth_mode_security_public_hosted')
                      : t('auth_mode_security_public')}
                  </li>
                  <li>
                    {sdkAuthMode === 'hosted_exchange'
                      ? t('auth_mode_security_identity_hosted')
                      : t('auth_mode_security_identity')}
                  </li>
                  <li>{t('auth_mode_security_origins')}</li>
                  {sdkAuthMode === 'hosted_exchange' && (
                    <li>{t('auth_mode_security_secret_reveal')}</li>
                  )}
                </ul>
              </div>

              {sdkAuthMode === 'hosted_exchange' && (
                <div className="mt-3 rounded-lg border border-default bg-background p-3">
                  <Select
                    label={t('sdk_token_envelope_policy_label')}
                    options={sdkTokenEnvelopeOptions}
                    value={sdkTokenEnvelopePolicy}
                    onChange={(value) => setSdkTokenEnvelopePolicy(value as SDKTokenEnvelopePolicy)}
                  />
                  <p className="mt-2 text-xs text-muted">
                    {sdkTokenEnvelopePolicy === 'jwe_required'
                      ? t('sdk_token_envelope_policy_required_hint')
                      : t('sdk_token_envelope_policy_hint')}
                  </p>
                  {showSdkJweRequiredWarning && (
                    <p className="mt-2 text-xs text-warning">
                      {t('sdk_token_envelope_policy_unavailable')}
                    </p>
                  )}
                </div>
              )}
            </div>

            {loadingKeys ? (
              <div className="flex items-center gap-2 py-2">
                <Loader2 className="w-4 h-4 text-muted animate-spin" />
                <span className="text-xs text-muted">{t('loading_api_keys')}</span>
              </div>
            ) : activeKeys.length === 0 ? (
              <div className="flex items-start gap-2 p-3 rounded-lg bg-warning-subtle border border-warning/30">
                <AlertCircle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
                <p className="text-xs text-warning">{t('no_api_keys')}</p>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Select
                  label={t('api_key_label')}
                  options={[
                    { value: '', label: t('api_key_placeholder') },
                    ...activeKeys.map((k) => ({
                      value: k.id,
                      label: `${k.name} (${k.keyPrefix}...)`,
                    })),
                  ]}
                  value={apiKeyId}
                  onChange={setApiKeyId}
                  error={errors.apiKeyId}
                />
                <p className="text-xs text-muted">{t('api_key_help')}</p>
              </div>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3 pt-2">
          <Button variant="secondary" onClick={onClose} className="flex-1">
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            loading={saving}
            disabled={isSDK && activeKeys.length === 0}
            className="flex-1"
          >
            {t('create')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
