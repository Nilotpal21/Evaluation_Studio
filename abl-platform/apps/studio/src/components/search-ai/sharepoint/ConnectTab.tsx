'use client';

/**
 * ConnectTab
 *
 * Entry point for establishing a SharePoint connection. Two experiences:
 * - First-time (0 SharePoint connectors): welcome message, 2 auth method cards.
 * - Returning (1+ existing): compact form with name, Client ID, Tenant ID, auth method.
 *
 * After auth initiation, polls auth status every 3s via SWR.
 */

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import useSWR from 'swr';
import { Loader2, Copy, Check, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { sanitizeError } from '@/lib/sanitize-error';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { Badge } from '../../ui/Badge';
import { useConnector } from '../../../hooks/useConnector';
import {
  createEnterpriseConnector,
  initiateConnectorAuth,
  getConnectorAuthStatus,
  exchangeAuthorizationCode,
  updateConnectorConfig,
} from '../../../api/search-ai';
import type { AuthMethod as ApiAuthMethod, AuthInitiateResponse } from '../../../api/search-ai';
import { AuthMethodSelector, type AuthMethod } from './AuthMethodSelector';
import { ConnectionScopesDisplay } from './ConnectionScopesDisplay';
import { ITAdminGuide } from './ITAdminGuide';
import { SHAREPOINT_PERMISSION_MANIFEST } from './sharepoint-permission-manifest';
import {
  generateClipboardRequest,
  generateSecurityReviewDocument,
  generateShortEmailBody,
} from './security-review-document';

interface ConnectTabProps {
  indexId: string;
  connectorId: string | null;
  onAuthComplete: () => void;
  onConnectorCreated: (connectorId: string) => void;
}

const GUID_VALIDATOR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUTH_POLL_INTERVAL_MS = 3000;

type AuthState =
  | { phase: 'idle' }
  | { phase: 'initiating' }
  | { phase: 'pending_device_code'; userCode: string; verificationUri: string; sessionId: string }
  | { phase: 'pending_redirect'; authorizationUrl: string }
  | { phase: 'completed' }
  | { phase: 'error'; message: string };

export function ConnectTab({
  indexId,
  connectorId,
  onAuthComplete,
  onConnectorCreated,
}: ConnectTabProps) {
  const t = useTranslations('search_ai.sharepoint.connect');

  // Connector data when resuming a draft
  const { connector } = useConnector(indexId, connectorId);

  // Form state
  const [name, setName] = useState('');
  const [clientId, setClientId] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [authMethod, setAuthMethod] = useState<AuthMethod | null>(null);
  const [permissionAwareEnabled, setPermissionAwareEnabled] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [authState, setAuthState] = useState<AuthState>({ phase: 'idle' });
  const [copiedCode, setCopiedCode] = useState(false);
  const [showEditForm, setShowEditForm] = useState(false);
  const createdConnectorIdRef = useRef<string | null>(connectorId);

  // Populate form from saved connector data when resuming a draft
  useEffect(() => {
    if (!connector) return;
    const config = (connector.connectionConfig ?? {}) as Record<string, unknown>;
    if (typeof config.displayName === 'string' && config.displayName && !name) {
      setName(config.displayName);
    }
    if (typeof config.clientId === 'string' && config.clientId && !clientId) {
      setClientId(config.clientId);
    }
    if (typeof config.tenantId === 'string' && config.tenantId && !tenantId) {
      setTenantId(config.tenantId);
    }
    if (typeof config.authMethod === 'string' && config.authMethod && !authMethod) {
      setAuthMethod(config.authMethod as AuthMethod);
    }
    if (config.permissionAwareSearch === false) {
      setPermissionAwareEnabled(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connector]);

  // Validation
  const clientIdError =
    clientId && !GUID_VALIDATOR.test(clientId) ? t('client_id_invalid') : undefined;
  const tenantIdError =
    tenantId && !GUID_VALIDATOR.test(tenantId) ? t('tenant_id_invalid') : undefined;

  // Auth status polling via SWR
  const shouldPoll =
    authState.phase === 'pending_device_code' || authState.phase === 'pending_redirect';
  const pollConnectorId = createdConnectorIdRef.current;

  const { data: authStatusData } = useSWR(
    shouldPoll && pollConnectorId
      ? [`/api/search-ai/connectors/${pollConnectorId}/auth/status`, pollConnectorId]
      : null,
    () => (pollConnectorId ? getConnectorAuthStatus(pollConnectorId) : null),
    { refreshInterval: shouldPoll ? AUTH_POLL_INTERVAL_MS : 0 },
  );

  // React to auth status changes
  useEffect(() => {
    if (!authStatusData?.data) return;
    const status = authStatusData.data.status;
    if (status === 'completed') {
      setAuthState({ phase: 'completed' });
      onAuthComplete();
    } else if (status === 'expired') {
      setAuthState({ phase: 'error', message: t('auth_expired') });
    } else if (status === 'error') {
      setAuthState({ phase: 'error', message: t('auth_error') });
    }
  }, [authStatusData, onAuthComplete, t]);

  // Listen for OAuth popup callback (authorization_code flow)
  useEffect(() => {
    if (authState.phase !== 'pending_redirect') return;
    const cId = createdConnectorIdRef.current;
    if (!cId) return;

    const handleMessage = async (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type !== 'oauth_callback') return;

      if (event.data.error) {
        setAuthState({ phase: 'error', message: event.data.error });
        return;
      }

      if (event.data.code && event.data.state) {
        try {
          await exchangeAuthorizationCode(cId, {
            code: event.data.code,
            state: event.data.state,
          });
          setAuthState({ phase: 'completed' });
          onAuthComplete();
        } catch (err: unknown) {
          const msg = sanitizeError(err, t('auth_error'));
          setAuthState({ phase: 'error', message: msg });
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [authState.phase, onAuthComplete, t]);

  // Handle auth initiation
  const handleConnect = useCallback(async () => {
    if (!authMethod) return;

    setSubmitting(true);
    setAuthState({ phase: 'initiating' });

    try {
      const backendAuthMethod = authMethod as ApiAuthMethod;
      let targetConnectorId = connectorId;

      // Create connector if new (connectorId is 'new' sentinel or null)
      if (!targetConnectorId || targetConnectorId === 'new') {
        const connectionConfig: Record<string, unknown> = {
          authMethod: backendAuthMethod,
          permissionAwareSearch: permissionAwareEnabled,
        };
        if (clientId) connectionConfig.clientId = clientId;
        if (tenantId) connectionConfig.tenantId = tenantId;
        if (clientSecret) connectionConfig.clientSecret = clientSecret;

        const result = await createEnterpriseConnector(indexId, {
          name: name || 'SharePoint',
          connectorType: 'sharepoint',
          connectionConfig,
        });
        targetConnectorId = result.data.connector._id;
        createdConnectorIdRef.current = targetConnectorId;
        onConnectorCreated(targetConnectorId);
      } else {
        // Existing connector — sync current form values to DB before auth
        const updatedConfig: Record<string, unknown> = {
          authMethod: backendAuthMethod,
          permissionAwareSearch: permissionAwareEnabled,
        };
        if (clientId) updatedConfig.clientId = clientId;
        if (tenantId) updatedConfig.tenantId = tenantId;
        if (clientSecret) updatedConfig.clientSecret = clientSecret;
        if (name) updatedConfig.displayName = name;

        await updateConnectorConfig(indexId, targetConnectorId, {
          connectionConfig: updatedConfig,
        });
      }

      // Initiate auth
      const authResult = await initiateConnectorAuth(targetConnectorId);
      const response = authResult.data;

      if (response.authMethod === 'device_code') {
        setAuthState({
          phase: 'pending_device_code',
          userCode: response.userCode,
          verificationUri: response.verificationUri,
          sessionId: response.sessionId,
        });
      } else if (response.authMethod === 'authorization_code') {
        setAuthState({
          phase: 'pending_redirect',
          authorizationUrl: response.authorizationUrl,
        });
        // Open in new tab
        const popup = window.open(response.authorizationUrl, '_blank');
        if (!popup) {
          toast.error('Popup blocked. Please allow popups or use Device Code auth.');
        }
      } else if (response.authMethod === 'client_credentials') {
        setAuthState({ phase: 'completed' });
        onAuthComplete();
      }
    } catch (err: unknown) {
      const message = sanitizeError(err, t('auth_error'));
      setAuthState({ phase: 'error', message });
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }, [
    authMethod,
    connectorId,
    indexId,
    name,
    clientId,
    tenantId,
    clientSecret,
    permissionAwareEnabled,
    onAuthComplete,
    onConnectorCreated,
    t,
  ]);

  const handleCopyCode = useCallback(
    (code: string) => {
      navigator.clipboard.writeText(code).then(
        () => {
          setCopiedCode(true);
          setTimeout(() => setCopiedCode(false), 2000);
        },
        () => {
          toast.error(t('clipboard_failed'));
        },
      );
    },
    [t],
  );

  // ─── Security Review Document & Admin Request ─────────────────────

  const manifestOptions = useMemo(
    () => ({
      permissionAwareEnabled,
      projectName: name || undefined,
    }),
    [permissionAwareEnabled, name],
  );

  const clipboardText = useMemo(
    () => generateClipboardRequest(SHAREPOINT_PERMISSION_MANIFEST, manifestOptions),
    [manifestOptions],
  );

  const handleDownloadSecurityReview = useCallback(() => {
    const markdown = generateSecurityReviewDocument(
      SHAREPOINT_PERMISSION_MANIFEST,
      manifestOptions,
    );
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'sharepoint-connector-security-review.md';
    a.click();
    URL.revokeObjectURL(url);
  }, [manifestOptions]);

  const handleOpenEmail = useCallback(() => {
    const { mailto } = generateShortEmailBody(SHAREPOINT_PERMISSION_MANIFEST, manifestOptions);
    window.open(mailto, '_blank');
  }, [manifestOptions]);

  // Can submit?
  const canSubmit = useMemo(() => {
    if (!authMethod) return false;
    if (authMethod === 'device_code') {
      // Device code: Client ID and Tenant ID optional (backend env vars may provide them)
      if (clientId && !GUID_VALIDATOR.test(clientId)) return false;
      if (tenantId && !GUID_VALIDATOR.test(tenantId)) return false;
      return true;
    }
    if (authMethod === 'client_credentials' || authMethod === 'authorization_code') {
      // Both require Client ID, Tenant ID, and Client Secret
      return (
        GUID_VALIDATOR.test(clientId) &&
        GUID_VALIDATOR.test(tenantId) &&
        clientSecret.trim().length > 0
      );
    }
    return true;
  }, [authMethod, clientId, tenantId, clientSecret]);

  // Auth pending/completed UX
  if (authState.phase === 'pending_device_code') {
    return (
      <div className="p-6 space-y-6">
        <div className="text-center space-y-4">
          <Loader2 className="w-8 h-8 text-accent animate-spin mx-auto" />
          <h3 className="text-base font-semibold text-foreground">{t('auth_pending')}</h3>
          <p className="text-sm text-muted">{t('device_code_instruction')}</p>

          <div className="inline-flex items-center gap-2 bg-background-muted rounded-lg px-4 py-3">
            <code className="text-lg font-mono font-bold text-foreground">
              {authState.userCode}
            </code>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => handleCopyCode(authState.userCode)}
              aria-label={t('device_code_copy')}
            >
              {copiedCode ? (
                <Check className="w-4 h-4 text-success" />
              ) : (
                <Copy className="w-4 h-4" />
              )}
            </Button>
          </div>

          <div>
            <a
              href={authState.verificationUri}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm text-accent hover:underline"
            >
              {authState.verificationUri}
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>

          <p className="text-xs text-muted">{t('admin_consent_note')}</p>
        </div>

        <ConnectionScopesDisplay
          permissionAwareEnabled={permissionAwareEnabled}
          onDisablePermissionAware={() => setPermissionAwareEnabled(false)}
        />

        <p className="text-xs text-muted text-center">{t('configure_before_auth')}</p>

        <div className="flex justify-center pt-2">
          <Button variant="secondary" size="sm" onClick={() => setAuthState({ phase: 'idle' })}>
            {t('btn_cancel')}
          </Button>
        </div>
      </div>
    );
  }

  if (authState.phase === 'pending_redirect') {
    return (
      <div className="p-6 space-y-6">
        <div className="text-center space-y-4">
          <Loader2 className="w-8 h-8 text-accent animate-spin mx-auto" />
          <h3 className="text-base font-semibold text-foreground">{t('auth_pending')}</h3>
          <p className="text-sm text-muted">{t('configure_before_auth')}</p>
        </div>

        <ConnectionScopesDisplay
          permissionAwareEnabled={permissionAwareEnabled}
          onDisablePermissionAware={() => setPermissionAwareEnabled(false)}
        />

        <div className="flex justify-center pt-2">
          <Button variant="secondary" size="sm" onClick={() => setAuthState({ phase: 'idle' })}>
            {t('btn_cancel')}
          </Button>
        </div>
      </div>
    );
  }

  if (authState.phase === 'completed') {
    return (
      <div className="p-6 text-center space-y-4">
        <Badge variant="success" dot>
          {t('auth_completed')}
        </Badge>
      </div>
    );
  }

  if (authState.phase === 'error') {
    return (
      <div className="p-6 space-y-4">
        <Badge variant="error" dot>
          {authState.message}
        </Badge>
        <Button variant="secondary" size="sm" onClick={() => setAuthState({ phase: 'idle' })}>
          {t('btn_cancel')}
        </Button>
      </div>
    );
  }

  // Already connected — show current config with re-auth option
  const isConnected = !!(connector as any)?.oauthTokenId;
  const connConfig = (connector?.connectionConfig ?? {}) as Record<string, unknown>;

  if (isConnected && authState.phase === 'idle' && !showEditForm) {
    return (
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-foreground">{t('connected_title')}</h3>
            <p className="text-sm text-muted mt-1">{t('connected_description')}</p>
          </div>
          <Badge variant="success" dot>
            {t('status_connected')}
          </Badge>
        </div>

        {/* Current configuration */}
        <div className="rounded-lg border border-default bg-background-subtle p-4 space-y-3">
          <h4 className="text-xs font-semibold text-muted uppercase tracking-wider">
            {t('current_config')}
          </h4>
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted">{t('auth_method_label')}</span>
              <span className="text-foreground capitalize">
                {String(connConfig.authMethod ?? 'device_code').replace(/_/g, ' ')}
              </span>
            </div>
            {typeof connConfig.clientId === 'string' && connConfig.clientId && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted">{t('client_id_label')}</span>
                <span className="text-foreground font-mono text-xs">
                  {connConfig.clientId.slice(0, 8)}...{connConfig.clientId.slice(-4)}
                </span>
              </div>
            )}
            {typeof connConfig.tenantId === 'string' && connConfig.tenantId && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted">{t('tenant_id_label')}</span>
                <span className="text-foreground font-mono text-xs">
                  {connConfig.tenantId.slice(0, 8)}...{connConfig.tenantId.slice(-4)}
                </span>
              </div>
            )}
            {typeof connConfig.displayName === 'string' && connConfig.displayName && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted">{t('name_label')}</span>
                <span className="text-foreground">{connConfig.displayName}</span>
              </div>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setShowEditForm(true)}>
            {t('btn_edit_credentials')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              // Pre-fill form with current values
              setClientId(String(connConfig.clientId ?? ''));
              setTenantId(String(connConfig.tenantId ?? ''));
              setAuthMethod((connConfig.authMethod as AuthMethod) ?? 'device_code');
              setName(String(connConfig.displayName ?? ''));
              setShowEditForm(true);
            }}
          >
            {t('btn_reauth')}
          </Button>
        </div>
      </div>
    );
  }

  // Main form — unified for both first-time and returning users
  return (
    <div className="p-6 space-y-6">
      <div>
        <h3 className="text-base font-semibold text-foreground">{t('welcome_title')}</h3>
        <p className="text-sm text-muted mt-1">{t('welcome_description')}</p>
      </div>

      {/* Connection name */}
      <div>
        <Input
          label={t('name_label')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('name_placeholder')}
        />
        <p className="text-xs text-muted mt-1">{t('name_help_first_time')}</p>
      </div>

      {/* Auth method — same 3 options for everyone */}
      <div>
        <h4 className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">
          {t('step_auth_method')}
        </h4>
        <AuthMethodSelector selectedMethod={authMethod} onMethodChange={setAuthMethod} />
      </div>

      {/* Credentials — shown when auth method is selected */}
      {authMethod && (
        <div className="space-y-3">
          <Input
            label={t('client_id_label')}
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            error={clientIdError}
          />
          <Input
            label={t('tenant_id_label')}
            value={tenantId}
            onChange={(e) => setTenantId(e.target.value)}
            error={tenantIdError}
          />
          {/* Client Secret only for authorization_code and client_credentials */}
          {(authMethod === 'client_credentials' || authMethod === 'authorization_code') && (
            <Input
              label={t('client_secret_label')}
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
            />
          )}
        </div>
      )}

      {/* IT Admin guide */}
      <ITAdminGuide
        clipboardText={clipboardText}
        onDownloadSecurityReview={handleDownloadSecurityReview}
        onOpenEmail={handleOpenEmail}
      />

      {/* Connection Scopes */}
      <ConnectionScopesDisplay
        permissionAwareEnabled={permissionAwareEnabled}
        onDisablePermissionAware={() => setPermissionAwareEnabled(false)}
      />

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 pt-2">
        <Button
          onClick={handleConnect}
          disabled={!canSubmit || submitting}
          loading={submitting || authState.phase === 'initiating'}
        >
          {t('btn_connect')}
        </Button>
      </div>
    </div>
  );
}
