/**
 * EnterpriseConnectorWizard Component
 *
 * Multi-step wizard for enterprise connectors (SharePoint, etc.):
 * 1. Configure — choose auth method + enter provider-specific credentials
 * 2. Authenticate — flow-specific UX (device code / OAuth redirect / client credentials)
 * 3. Choose setup path (quick vs custom)
 * 4. Discovery progress (auto-discover resources)
 * 5. Review recommendations & accept
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Shield,
  Zap,
  Settings,
  Search,
  CheckCircle2,
  XCircle,
  Loader2,
  ExternalLink,
  Copy,
  Clock,
  ArrowLeft,
  BarChart3,
  HardDrive,
  RefreshCw,
  KeyRound,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { sanitizeError } from '@/lib/sanitize-error';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { toast } from 'sonner';
import type {
  EnterpriseConnectorType,
  AuthMethod,
  AuthInitiateResponse,
  DeviceCodeAuthResponse,
  AuthCodeAuthResponse,
  ConnectorDiscovery,
  ConnectorRecommendation,
  ResourceScore,
} from '../../api/search-ai';
import {
  createEnterpriseConnector,
  initiateConnectorAuth,
  getConnectorAuthStatus,
  exchangeAuthorizationCode,
  triggerConnectorDiscovery,
  getConnectorDiscovery,
  generateConnectorRecommendations,
  getConnectorRecommendation,
  acceptConnectorRecommendation,
  quickSetupConnector,
} from '../../api/search-ai';

type WizardStep = 'configure' | 'auth' | 'setup-path' | 'discovery' | 'review';

interface EnterpriseConnectorWizardProps {
  open: boolean;
  onClose: () => void;
  indexId: string;
  connectorType: EnterpriseConnectorType;
  onSuccess: () => void;
}

const AUTH_POLL_INTERVAL_MS = 3000;
const DISCOVERY_POLL_INTERVAL_MS = 4000;

// ─── Auth Method Definitions ─────────────────────────────────────────────

interface AuthMethodOption {
  value: AuthMethod;
  i18nLabel: string;
  i18nDesc: string;
}

const SHAREPOINT_AUTH_METHODS: AuthMethodOption[] = [
  {
    value: 'device_code',
    i18nLabel: 'enterprise_auth_method_device_code',
    i18nDesc: 'enterprise_auth_method_device_code_desc',
  },
  {
    value: 'authorization_code',
    i18nLabel: 'enterprise_auth_method_auth_code',
    i18nDesc: 'enterprise_auth_method_auth_code_desc',
  },
  {
    value: 'client_credentials',
    i18nLabel: 'enterprise_auth_method_client_credentials',
    i18nDesc: 'enterprise_auth_method_client_credentials_desc',
  },
];

// ─── Connector Config Definitions ───────────────────────────────────────

interface ConfigField {
  key: string;
  i18nLabel: string;
  i18nPlaceholder: string;
  i18nHelp: string;
  required: boolean;
  type: 'text' | 'url' | 'password';
  validate?: (value: string) => string | null;
}

const GUID_VALIDATOR = (value: string) => {
  const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!guidPattern.test(value)) {
    return 'enterprise_config_tenant_id_invalid';
  }
  return null;
};

/** Fields shared across all SharePoint auth methods */
const SHAREPOINT_BASE_FIELDS: ConfigField[] = [
  {
    key: 'clientId',
    i18nLabel: 'enterprise_config_client_id_label',
    i18nPlaceholder: 'enterprise_config_client_id_placeholder',
    i18nHelp: 'enterprise_config_client_id_help',
    required: true,
    type: 'text',
  },
  {
    key: 'tenantId',
    i18nLabel: 'enterprise_config_tenant_id_label',
    i18nPlaceholder: 'enterprise_config_tenant_id_placeholder',
    i18nHelp: 'enterprise_config_tenant_id_help',
    required: true,
    type: 'text',
    validate: GUID_VALIDATOR,
  },
];

/** Extra fields required by Authorization Code flow */
const AUTH_CODE_EXTRA_FIELDS: ConfigField[] = [
  {
    key: 'clientSecret',
    i18nLabel: 'enterprise_config_client_secret_label',
    i18nPlaceholder: 'enterprise_config_client_secret_placeholder',
    i18nHelp: 'enterprise_config_client_secret_help',
    required: true,
    type: 'password',
  },
];

/** Extra fields required by Client Credentials flow */
const CLIENT_CREDENTIALS_EXTRA_FIELDS: ConfigField[] = [
  {
    key: 'clientSecret',
    i18nLabel: 'enterprise_config_client_secret_label',
    i18nPlaceholder: 'enterprise_config_client_secret_placeholder',
    i18nHelp: 'enterprise_config_client_secret_help',
    required: true,
    type: 'password',
  },
];

function getConfigFields(
  connectorType: EnterpriseConnectorType,
  authMethod: AuthMethod,
): ConfigField[] {
  const base = connectorType === 'sharepoint' ? SHAREPOINT_BASE_FIELDS : SHAREPOINT_BASE_FIELDS;

  switch (authMethod) {
    case 'authorization_code':
      return [...base, ...AUTH_CODE_EXTRA_FIELDS];
    case 'client_credentials':
      return [...base, ...CLIENT_CREDENTIALS_EXTRA_FIELDS];
    case 'device_code':
    default:
      return base;
  }
}

function getAuthMethods(connectorType: EnterpriseConnectorType): AuthMethodOption[] {
  switch (connectorType) {
    case 'sharepoint':
      return SHAREPOINT_AUTH_METHODS;
    default:
      return SHAREPOINT_AUTH_METHODS;
  }
}

function getConnectorLabel(connectorType: EnterpriseConnectorType): string {
  switch (connectorType) {
    case 'sharepoint':
      return 'SharePoint';
    default:
      return connectorType;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

// ─── Component ──────────────────────────────────────────────────────────

export function EnterpriseConnectorWizard({
  open,
  onClose,
  indexId,
  connectorType,
  onSuccess,
}: EnterpriseConnectorWizardProps) {
  const t = useTranslations('search_ai.connectors');

  const connectorLabel = getConnectorLabel(connectorType);
  const authMethods = getAuthMethods(connectorType);

  // Wizard state
  const [step, setStep] = useState<WizardStep>('configure');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auth method selection
  const [selectedAuthMethod, setSelectedAuthMethod] = useState<AuthMethod>('device_code');
  const configFields = getConfigFields(connectorType, selectedAuthMethod);

  // Configuration: dynamic field values keyed by field key
  const [configValues, setConfigValues] = useState<Record<string, string>>({});

  // Connector
  const [connectorId, setConnectorId] = useState<string | null>(null);

  // Auth state — supports both device code and authorization code responses
  const [authData, setAuthData] = useState<AuthInitiateResponse | null>(null);
  const [authStatus, setAuthStatus] = useState<
    'idle' | 'waiting' | 'success' | 'expired' | 'error'
  >('idle');
  const authPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Discovery state
  const [discovery, setDiscovery] = useState<ConnectorDiscovery | null>(null);
  const discoveryPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Recommendation state
  const [recommendation, setRecommendation] = useState<ConnectorRecommendation | null>(null);

  // Review step: user-selectable resources and advanced filters
  const [selectedResourceIds, setSelectedResourceIds] = useState<Set<string>>(new Set());
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [filterContentTypes, setFilterContentTypes] = useState<string[]>([]);
  const [filterModifiedSince, setFilterModifiedSince] = useState<string>('');

  // ─── Cleanup ────────────────────────────────────────────────────────────

  const cleanupPolls = useCallback(() => {
    if (authPollRef.current) {
      clearInterval(authPollRef.current);
      authPollRef.current = null;
    }
    if (discoveryPollRef.current) {
      clearInterval(discoveryPollRef.current);
      discoveryPollRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!open) {
      cleanupPolls();
      setStep('configure');
      setLoading(false);
      setError(null);
      setSelectedAuthMethod('device_code');
      setConfigValues({});
      setConnectorId(null);
      setAuthData(null);
      setAuthStatus('idle');
      setOauthPopupOpened(false);
      setDiscovery(null);
      setRecommendation(null);
      setSelectedResourceIds(new Set());
      setShowAdvancedFilters(false);
      setFilterContentTypes([]);
      setFilterModifiedSince('');
    }
    return cleanupPolls;
  }, [open, cleanupPolls]);

  // ─── Config field helpers ───────────────────────────────────────────────

  const setFieldValue = useCallback((key: string, value: string) => {
    setConfigValues((prev) => ({ ...prev, [key]: value }));
    setError(null);
  }, []);

  const getFieldValue = useCallback((key: string) => configValues[key] || '', [configValues]);

  // ─── Step 1: Configure ────────────────────────────────────────────────

  const handleConfigure = useCallback(async () => {
    // Validate all required fields
    for (const field of configFields) {
      const value = (configValues[field.key] || '').trim();
      if (field.required && !value) {
        setError(t('enterprise_config_field_required', { field: t(field.i18nLabel) }));
        return;
      }
      if (value && field.validate) {
        const validationError = field.validate(value);
        if (validationError) {
          setError(t(validationError));
          return;
        }
      }
    }

    setLoading(true);
    setError(null);

    try {
      // Build connectionConfig from field values + auth method
      const connectionConfig: Record<string, string> = {
        authMethod: selectedAuthMethod,
      };
      for (const field of configFields) {
        const value = (configValues[field.key] || '').trim();
        if (value) {
          connectionConfig[field.key] = value;
        }
      }

      // Create connector (or return existing one)
      let cId = connectorId;
      if (!cId) {
        const createResult = await createEnterpriseConnector(indexId, {
          name: `${connectorLabel} Connector`,
          connectorType,
          connectionConfig,
        });
        cId = createResult.data.connector._id;
        setConnectorId(cId);
      }

      setStep('auth');
      setAuthStatus('idle');
    } catch (err) {
      const msg = sanitizeError(err, t('enterprise_error_create_failed'));
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [
    configValues,
    configFields,
    connectorId,
    connectorType,
    connectorLabel,
    selectedAuthMethod,
    indexId,
    t,
  ]);

  // ─── Step 2: Authentication ─────────────────────────────────────────────

  const initiateAuth = useCallback(async () => {
    setLoading(true);
    setError(null);
    setAuthStatus('idle');

    try {
      const cId = connectorId;
      if (!cId) {
        setError('Connector not created yet. Go back to configure.');
        setAuthStatus('error');
        return;
      }

      const result = await initiateConnectorAuth(cId);
      const data = result.data;
      setAuthData(data);

      // Client credentials completes immediately — auto-advance
      if (data.authMethod === 'client_credentials') {
        setAuthStatus('success');
        // Auto-advance after a brief success flash
        setTimeout(() => setStep('setup-path'), 800);
        return;
      }

      // Authorization code flow — user needs to visit a URL and return with a code
      if (data.authMethod === 'authorization_code') {
        setAuthStatus('waiting');
        return;
      }

      // Device code flow — poll for completion
      setAuthStatus('waiting');

      if (authPollRef.current) clearInterval(authPollRef.current);
      authPollRef.current = setInterval(async () => {
        try {
          const statusResult = await getConnectorAuthStatus(cId);
          const status = statusResult.data.status;

          if (status === 'completed') {
            setAuthStatus('success');
            if (authPollRef.current) {
              clearInterval(authPollRef.current);
              authPollRef.current = null;
            }
            // Auto-advance after brief success flash
            setTimeout(() => setStep('setup-path'), 800);
          } else if (status === 'expired') {
            setAuthStatus('expired');
            if (authPollRef.current) {
              clearInterval(authPollRef.current);
              authPollRef.current = null;
            }
          } else if (status === 'error') {
            setAuthStatus('error');
            if (authPollRef.current) {
              clearInterval(authPollRef.current);
              authPollRef.current = null;
            }
          }
        } catch {
          // Ignore poll errors
        }
      }, AUTH_POLL_INTERVAL_MS);
    } catch (err) {
      const msg = sanitizeError(err, t('enterprise_error_auth_failed'));
      setError(msg);
      setAuthStatus('error');
    } finally {
      setLoading(false);
    }
  }, [connectorId, t]);

  useEffect(() => {
    if (open && step === 'auth' && authStatus === 'idle' && !loading) {
      initiateAuth();
    }
  }, [open, step, authStatus, loading, initiateAuth]);

  const handleCopyCode = useCallback(() => {
    if (authData && authData.authMethod === 'device_code' && authData.userCode) {
      navigator.clipboard.writeText(authData.userCode);
      toast.success('Code copied');
    }
  }, [authData]);

  // ─── Authorization Code callback listener ──────────────────────────────

  useEffect(() => {
    if (
      step !== 'auth' ||
      !authData ||
      authData.authMethod !== 'authorization_code' ||
      !connectorId
    ) {
      return;
    }

    const handleMessage = async (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      // Accept messages from the OAuth redirect popup
      if (event.data?.type === 'oauth_callback') {
        if (event.data.error) {
          setError(event.data.error);
          setAuthStatus('error');
          return;
        }
        if (event.data.code && event.data.state) {
          setLoading(true);
          try {
            await exchangeAuthorizationCode(connectorId, {
              code: event.data.code,
              state: event.data.state,
            });
            setAuthStatus('success');
            // Auto-advance after brief success flash
            setTimeout(() => setStep('setup-path'), 800);
          } catch (err) {
            const msg = sanitizeError(err, t('enterprise_error_auth_failed'));
            setError(msg);
            setAuthStatus('error');
          } finally {
            setLoading(false);
          }
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [step, authData, connectorId, t]);

  // ─── Step 3: Setup Path Selection ───────────────────────────────────────

  const handleQuickSetup = useCallback(async () => {
    if (!connectorId) return;
    setStep('discovery');
    setLoading(true);
    setError(null);

    try {
      const result = await quickSetupConnector(connectorId, { startSync: false });
      pollDiscoveryStatus(connectorId);

      setDiscovery({
        _id: result.data.discoveryId,
        connectorId,
        tenantId: '',
        status: 'pending',
        resources: [],
        profiles: [],
        totalResources: 0,
        discoveredAt: null,
        durationMs: null,
        error: null,
        jobId: result.data.jobId,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      const msg = sanitizeError(err, t('enterprise_error_discovery_failed'));
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [connectorId, t]);

  const handleCustomSetup = useCallback(async () => {
    if (!connectorId) return;
    setStep('discovery');
    setLoading(true);
    setError(null);

    try {
      const result = await triggerConnectorDiscovery(connectorId, {
        mode: 'discover_and_profile',
      });

      setDiscovery({
        _id: result.data.discoveryId,
        connectorId,
        tenantId: '',
        status: 'pending',
        resources: [],
        profiles: [],
        totalResources: 0,
        discoveredAt: null,
        durationMs: null,
        error: null,
        jobId: result.data.jobId,
        createdAt: new Date().toISOString(),
      });

      pollDiscoveryStatus(connectorId);
    } catch (err) {
      const msg = sanitizeError(err, t('enterprise_error_discovery_failed'));
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [connectorId, t]);

  // ─── Step 4: Discovery Polling ──────────────────────────────────────────

  const pollDiscoveryStatus = useCallback(
    (cId: string) => {
      if (discoveryPollRef.current) clearInterval(discoveryPollRef.current);

      discoveryPollRef.current = setInterval(async () => {
        try {
          const result = await getConnectorDiscovery(cId);
          setDiscovery(result.data);

          if (result.data.status === 'completed') {
            if (discoveryPollRef.current) {
              clearInterval(discoveryPollRef.current);
              discoveryPollRef.current = null;
            }
            try {
              const recResult = await getConnectorRecommendation(cId);
              setRecommendation(recResult.data);
              // Pre-select recommended resources
              setSelectedResourceIds(
                new Set(
                  recResult.data.resourceScores
                    .filter((s: ResourceScore) => s.recommended)
                    .map((s: ResourceScore) => s.resourceId),
                ),
              );
              setStep('review');
            } catch {
              try {
                const genResult = await generateConnectorRecommendations(cId, result.data._id);
                setRecommendation(genResult.data);
                // Pre-select recommended resources
                setSelectedResourceIds(
                  new Set(
                    genResult.data.resourceScores
                      .filter((s: ResourceScore) => s.recommended)
                      .map((s: ResourceScore) => s.resourceId),
                  ),
                );
                setStep('review');
              } catch (err) {
                const msg = sanitizeError(err, t('enterprise_error_recommendation_failed'));
                setError(msg);
              }
            }
          } else if (result.data.status === 'failed') {
            if (discoveryPollRef.current) {
              clearInterval(discoveryPollRef.current);
              discoveryPollRef.current = null;
            }
            setError(result.data.error || t('enterprise_error_discovery_failed'));
          }
        } catch {
          // Ignore poll errors
        }
      }, DISCOVERY_POLL_INTERVAL_MS);
    },
    [t],
  );

  // ─── Step 5: Accept Recommendation ──────────────────────────────────────

  const handleAccept = useCallback(
    async (startSync: boolean) => {
      if (!connectorId || !recommendation) return;
      setLoading(true);
      setError(null);

      try {
        // Build overrides from user's resource selection and advanced filters
        console.log('[EnterpriseWizard] Building overrides with:', {
          selectedResourceIdsCount: selectedResourceIds.size,
          selectedResourceIds: Array.from(selectedResourceIds),
          discoveryResourcesCount: discovery?.resources.length || 0,
          discoveryResources: discovery?.resources.map((r) => ({
            id: r.id,
            name: r.name,
            type: r.resourceType,
          })),
        });

        const selectedSiteUrls =
          discovery?.resources
            .filter((r) => selectedResourceIds.has(r.id) && r.resourceType === 'site')
            .map((r) => r.url) || [];
        const selectedLibraryNames =
          discovery?.resources
            .filter((r) => selectedResourceIds.has(r.id) && r.resourceType === 'library')
            .map((r) => r.name) || [];

        console.log('[EnterpriseWizard] Filter config:', {
          selectedSiteUrls,
          selectedLibraryNames,
          filterContentTypes,
          filterModifiedSince,
        });

        const overrides: Record<string, unknown> = {
          filterConfig: {
            mode: 'include' as const,
            siteUrls: selectedSiteUrls,
            libraryNames: selectedLibraryNames,
            ...(filterContentTypes.length > 0 ? { contentTypes: filterContentTypes } : {}),
            ...(filterModifiedSince ? { modifiedSince: filterModifiedSince } : {}),
          },
        };

        await acceptConnectorRecommendation(connectorId, recommendation._id, {
          overrides,
          startSync,
        });
        toast.success(
          startSync ? t('enterprise_accept_sync_started') : t('enterprise_accept_success'),
        );
        onSuccess();
        onClose();
      } catch (err) {
        const msg = sanitizeError(err, t('enterprise_error_accept_failed'));
        setError(msg);
        toast.error(msg);
      } finally {
        setLoading(false);
      }
    },
    [
      connectorId,
      recommendation,
      discovery,
      selectedResourceIds,
      filterContentTypes,
      filterModifiedSince,
      onSuccess,
      onClose,
      t,
    ],
  );

  // ─── Renders ────────────────────────────────────────────────────────────

  const renderConfigureStep = () => {
    const requiredFieldsFilled = configFields
      .filter((f) => f.required)
      .every((f) => (configValues[f.key] || '').trim());

    return (
      <div className="space-y-6">
        <div className="text-center space-y-2">
          <KeyRound className="w-10 h-10 text-accent mx-auto" />
          <p className="text-sm font-medium text-foreground">
            {t('enterprise_config_title', { connectorType: connectorLabel })}
          </p>
          <p className="text-xs text-muted">
            {t('enterprise_config_description', { connectorType: connectorLabel })}
          </p>
        </div>

        {/* Prerequisites callout */}
        <details className="group rounded-lg border border-default bg-background-subtle p-3">
          <summary className="text-xs font-medium text-muted cursor-pointer hover:text-foreground flex items-center gap-1.5">
            <Shield className="w-3.5 h-3.5" />
            {t('enterprise_config_prerequisites_title')}
          </summary>
          <div className="mt-2 space-y-1.5 text-xs text-muted">
            <p>{t('enterprise_config_prerequisites_desc')}</p>
            <ul className="list-disc list-inside space-y-1 pl-1">
              <li>{t('enterprise_config_prereq_public_client')}</li>
              <li>{t('enterprise_config_prereq_redirect_uri')}</li>
              <li>{t('enterprise_config_prereq_permissions')}</li>
              <li>{t('enterprise_config_prereq_consent')}</li>
            </ul>
          </div>
        </details>

        {/* Auth method selection */}
        <div className="space-y-2">
          <label className="block text-sm font-medium text-foreground">
            {t('enterprise_config_auth_method_label')}
          </label>
          <div className="grid grid-cols-1 gap-2">
            {authMethods.map((method) => (
              <button
                key={method.value}
                type="button"
                onClick={() => setSelectedAuthMethod(method.value)}
                className={`flex items-start gap-3 p-3 rounded-lg border text-left transition-default ${
                  selectedAuthMethod === method.value
                    ? 'border-accent bg-accent/5 ring-1 ring-accent'
                    : 'border-default bg-background-subtle hover:bg-background-muted'
                }`}
              >
                <div
                  className={`mt-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                    selectedAuthMethod === method.value ? 'border-accent' : 'border-default'
                  }`}
                >
                  {selectedAuthMethod === method.value && (
                    <div className="w-2 h-2 rounded-full bg-accent" />
                  )}
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">{t(method.i18nLabel)}</p>
                  <p className="text-xs text-muted">{t(method.i18nDesc)}</p>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Dynamic credential fields based on selected auth method */}
        <div className="space-y-4">
          {configFields.map((field) => (
            <div key={field.key}>
              <Input
                label={
                  t(field.i18nLabel) +
                  (field.required ? '' : ` (${t('enterprise_config_optional')})`)
                }
                value={getFieldValue(field.key)}
                onChange={(e) => setFieldValue(field.key, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleConfigure();
                }}
                placeholder={t(field.i18nPlaceholder)}
                type={
                  field.type === 'url' ? 'url' : field.type === 'password' ? 'password' : 'text'
                }
              />
              <p className="mt-1 text-xs text-muted">{t(field.i18nHelp)}</p>
            </div>
          ))}
        </div>

        {error && <p className="text-sm text-error">{error}</p>}

        <div className="flex gap-3 pt-2">
          <Button variant="secondary" onClick={onClose} className="flex-1">
            {t('enterprise_cancel')}
          </Button>
          <Button
            onClick={handleConfigure}
            loading={loading}
            disabled={!requiredFieldsFilled}
            className="flex-1"
          >
            {t('enterprise_next')}
          </Button>
        </div>
      </div>
    );
  };

  const renderDeviceCodeWaiting = () => {
    const dcData = authData as DeviceCodeAuthResponse;
    return (
      <div className="space-y-6">
        <div className="text-center space-y-2">
          <Shield className="w-10 h-10 text-accent mx-auto" />
          <p className="text-sm text-muted">
            {t('enterprise_auth_code_instruction', {
              url: dcData.verificationUri,
            })}
          </p>
        </div>

        <div className="flex items-center justify-center gap-3">
          <code className="text-3xl font-bold tracking-[0.3em] text-foreground bg-background-subtle px-6 py-3 rounded-xl border border-default">
            {dcData.userCode}
          </code>
          <button
            onClick={handleCopyCode}
            className="p-2 text-muted hover:text-foreground rounded-lg transition-default"
            title="Copy code"
          >
            <Copy className="w-5 h-5" />
          </button>
        </div>

        <div className="flex justify-center">
          <a
            href={dcData.verificationUri}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-sm text-info hover:text-info/80 transition-default"
          >
            {t('enterprise_auth_open_link')}
            <ExternalLink className="w-4 h-4" />
          </a>
        </div>

        <div className="flex items-center justify-center gap-2 text-sm text-muted">
          <Loader2 className="w-4 h-4 animate-spin" />
          {t('enterprise_auth_waiting')}
        </div>
      </div>
    );
  };

  const [oauthPopupOpened, setOauthPopupOpened] = useState(false);

  const handleOpenOAuthPopup = useCallback(() => {
    if (!authData || authData.authMethod !== 'authorization_code') return;
    const acData = authData as AuthCodeAuthResponse;
    const popup = window.open(
      acData.authorizationUrl,
      'oauth_popup',
      'width=600,height=700,popup=yes',
    );
    if (popup) {
      setOauthPopupOpened(true);
    } else {
      // Popup blocked — fall back to same-window redirect
      // Save wizard state to sessionStorage so we can resume after redirect.
      // Strip sensitive fields to avoid persisting secrets in browser storage.
      const SENSITIVE_KEY_PATTERN = /secret|password|key|token|credential/i;
      const safeConfigValues: Record<string, unknown> = {};
      if (configValues && typeof configValues === 'object') {
        for (const [k, v] of Object.entries(configValues)) {
          safeConfigValues[k] = SENSITIVE_KEY_PATTERN.test(k) ? '[REDACTED]' : v;
        }
      }
      sessionStorage.setItem(
        'connector_oauth_state',
        JSON.stringify({
          connectorId,
          connectorType,
          indexId,
          authMethod: selectedAuthMethod,
          configValues: safeConfigValues,
        }),
      );
      window.location.href = acData.authorizationUrl;
    }
  }, [authData, connectorId, connectorType, indexId, selectedAuthMethod, configValues]);

  const renderAuthCodeWaiting = () => {
    return (
      <div className="space-y-6">
        <div className="text-center space-y-2">
          <Shield className="w-10 h-10 text-accent mx-auto" />
          <p className="text-sm font-medium text-foreground">
            {t('enterprise_auth_code_flow_title')}
          </p>
          <p className="text-sm text-muted">{t('enterprise_auth_code_flow_desc')}</p>
        </div>

        <div className="flex justify-center">
          <Button onClick={handleOpenOAuthPopup} icon={<ExternalLink className="w-4 h-4" />}>
            {t('enterprise_auth_sign_in_microsoft')}
          </Button>
        </div>

        {oauthPopupOpened && (
          <div className="flex items-center justify-center gap-2 text-sm text-muted">
            <Loader2 className="w-4 h-4 animate-spin" />
            {t('enterprise_auth_waiting_redirect')}
          </div>
        )}

        {!oauthPopupOpened && (
          <p className="text-xs text-center text-muted">{t('enterprise_auth_code_click_above')}</p>
        )}
      </div>
    );
  };

  const renderAuthStep = () => (
    <div className="space-y-6">
      {authStatus === 'idle' || (authStatus === 'waiting' && !authData) ? (
        <div className="flex flex-col items-center gap-4 py-8">
          <Loader2 className="w-8 h-8 text-accent animate-spin" />
          <p className="text-sm text-muted">{t('enterprise_auth_initiating')}</p>
        </div>
      ) : authStatus === 'waiting' && authData ? (
        // Render different UIs based on auth method
        authData.authMethod === 'authorization_code' ? (
          renderAuthCodeWaiting()
        ) : (
          renderDeviceCodeWaiting()
        )
      ) : authStatus === 'success' ? (
        <div className="flex flex-col items-center gap-4 py-8">
          <CheckCircle2 className="w-12 h-12 text-success" />
          <p className="text-sm font-medium text-foreground">{t('enterprise_auth_success')}</p>
          <Button onClick={() => setStep('setup-path')}>{t('enterprise_next')}</Button>
        </div>
      ) : authStatus === 'expired' ? (
        <div className="flex flex-col items-center gap-4 py-8">
          <Clock className="w-12 h-12 text-warning" />
          <p className="text-sm text-muted">{t('enterprise_auth_expired')}</p>
          <Button
            onClick={() => {
              setAuthStatus('idle');
              setAuthData(null);
              initiateAuth();
            }}
          >
            {t('enterprise_retry')}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-4 py-8">
          <XCircle className="w-12 h-12 text-error" />
          <p className="text-sm text-muted">{error || t('enterprise_auth_error')}</p>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setStep('configure');
                setAuthStatus('idle');
                setAuthData(null);
                setError(null);
              }}
            >
              {t('enterprise_back')}
            </Button>
            <Button
              onClick={() => {
                setAuthStatus('idle');
                setAuthData(null);
                setError(null);
                initiateAuth();
              }}
            >
              {t('enterprise_retry')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );

  const renderSetupPathStep = () => (
    <div className="space-y-4">
      <button
        onClick={() => setStep('auth')}
        className="flex items-center gap-1.5 text-sm text-muted hover:text-foreground transition-default"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        {t('enterprise_back')}
      </button>

      <p className="text-sm text-muted">{t('enterprise_setup_title')}</p>

      <div className="grid grid-cols-1 gap-3">
        <button
          onClick={handleQuickSetup}
          className="flex items-start gap-4 p-4 rounded-xl border-2 border-accent bg-accent/5 hover:bg-accent/10 transition-default text-left"
        >
          <Zap className="w-6 h-6 text-accent shrink-0 mt-0.5" />
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground">
                {t('enterprise_setup_quick_title')}
              </span>
              <Badge variant="accent">{t('enterprise_setup_recommended')}</Badge>
            </div>
            <p className="text-xs text-muted">{t('enterprise_setup_quick_desc')}</p>
          </div>
        </button>

        <button
          onClick={handleCustomSetup}
          className="flex items-start gap-4 p-4 rounded-xl border border-default bg-background-subtle hover:bg-background-muted transition-default text-left"
        >
          <Settings className="w-6 h-6 text-muted shrink-0 mt-0.5" />
          <div className="space-y-1">
            <span className="text-sm font-medium text-foreground">
              {t('enterprise_setup_custom_title')}
            </span>
            <p className="text-xs text-muted">{t('enterprise_setup_custom_desc')}</p>
          </div>
        </button>
      </div>
    </div>
  );

  const renderDiscoveryStep = () => {
    const status = discovery?.status || 'pending';
    const statusKey = `enterprise_discovery_status_${status}` as const;

    return (
      <div className="space-y-6">
        <div className="flex flex-col items-center gap-4 py-6">
          {status === 'completed' ? (
            <CheckCircle2 className="w-12 h-12 text-success" />
          ) : status === 'failed' ? (
            <XCircle className="w-12 h-12 text-error" />
          ) : (
            <Search className="w-12 h-12 text-accent animate-pulse" />
          )}

          <div className="text-center space-y-2">
            <p className="text-sm font-medium text-foreground">{t('enterprise_discovery_title')}</p>
            <p className="text-xs text-muted">
              {t('enterprise_discovery_description', { connectorType: connectorLabel })}
            </p>
          </div>

          {/* Progress indicator */}
          <div className="w-full max-w-xs space-y-3">
            {(['pending', 'discovering', 'profiling', 'completed'] as const).map((s) => {
              const isActive = s === status;
              const isDone =
                status === 'completed' ||
                (status === 'profiling' && (s === 'pending' || s === 'discovering')) ||
                (status === 'discovering' && s === 'pending');

              return (
                <div key={s} className="flex items-center gap-3">
                  <div
                    className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${
                      isDone
                        ? 'bg-success text-success-foreground'
                        : isActive
                          ? 'bg-accent text-accent-foreground'
                          : 'bg-background-subtle border border-default text-muted'
                    }`}
                  >
                    {isDone ? (
                      <CheckCircle2 className="w-4 h-4" />
                    ) : isActive ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <span className="text-xs">
                        {s === 'pending'
                          ? '1'
                          : s === 'discovering'
                            ? '2'
                            : s === 'profiling'
                              ? '3'
                              : '4'}
                      </span>
                    )}
                  </div>
                  <span
                    className={`text-sm ${isActive ? 'text-foreground font-medium' : isDone ? 'text-muted' : 'text-subtle'}`}
                  >
                    {t(statusKey.replace(status, s) as typeof statusKey)}
                  </span>
                </div>
              );
            })}
          </div>

          {discovery && discovery.totalResources > 0 && (
            <p className="text-xs text-muted">
              {t('enterprise_discovery_resources_found', { count: discovery.totalResources })}
            </p>
          )}

          {status === 'failed' && (
            <div className="space-y-2 text-center">
              {error && <p className="text-sm text-error">{error}</p>}
              <Button
                variant="secondary"
                onClick={() => {
                  setError(null);
                  setStep('setup-path');
                }}
              >
                {t('enterprise_retry')}
              </Button>
            </div>
          )}

          {status === 'completed' && !recommendation && (
            <div className="flex items-center gap-2 text-sm text-muted">
              <Loader2 className="w-4 h-4 animate-spin" />
              {t('enterprise_discovery_generating_recommendations')}
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderResourceScore = (score: ResourceScore) => (
    <div
      key={score.resourceId}
      className="flex items-center justify-between p-3 rounded-lg border border-default bg-background-subtle"
    >
      <div className="space-y-0.5">
        <p className="text-sm font-medium text-foreground">{score.resourceName}</p>
        <p className="text-xs text-muted">
          {t('enterprise_review_score', { score: Math.round(score.overallScore * 100) + '%' })}
          {score.reasoning && ` — ${score.reasoning}`}
        </p>
      </div>
      <Badge variant={score.recommended ? 'success' : 'default'} dot>
        {score.recommended
          ? t('enterprise_review_recommended')
          : t('enterprise_review_not_recommended')}
      </Badge>
    </div>
  );

  const renderReviewStep = () => {
    if (!recommendation) return null;

    const recommendedResources = recommendation.resourceScores.filter((s) => s.recommended);
    const otherResources = recommendation.resourceScores.filter((s) => !s.recommended);

    return (
      <div className="space-y-5">
        <button
          onClick={() => setStep('setup-path')}
          className="flex items-center gap-1.5 text-sm text-muted hover:text-foreground transition-default"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          {t('enterprise_back')}
        </button>

        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">{t('enterprise_review_title')}</p>
          <p className="text-xs text-muted">{t('enterprise_review_description')}</p>
        </div>

        {/* Confidence */}
        <div className="flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-accent" />
          <span className="text-sm text-muted">
            {t('enterprise_review_confidence', {
              value: Math.round(recommendation.overallConfidence * 100) + '%',
            })}
          </span>
        </div>

        {/* Resources */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted uppercase tracking-wide">
            {t('enterprise_review_resources_title')}
          </p>
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {recommendedResources.map(renderResourceScore)}
            {otherResources.length > 0 && (
              <>
                <div className="flex items-center justify-between pt-2 border-t border-default">
                  <span className="text-xs text-muted">
                    {t('enterprise_review_more_available')}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const otherIds = otherResources.map((s) => s.resourceId);
                      const allOtherSelected = otherIds.every((id) => selectedResourceIds.has(id));
                      setSelectedResourceIds((prev) => {
                        const next = new Set(prev);
                        if (allOtherSelected) {
                          otherIds.forEach((id) => next.delete(id));
                        } else {
                          otherIds.forEach((id) => next.add(id));
                        }
                        return next;
                      });
                    }}
                    className="text-xs text-info hover:text-info/80 transition-default"
                  >
                    {otherResources.every((s) => selectedResourceIds.has(s.resourceId))
                      ? t('enterprise_review_deselect_all')
                      : t('enterprise_review_select_all')}
                  </button>
                </div>
                {otherResources.map(renderResourceScore)}
              </>
            )}
          </div>
        </div>

        {/* Advanced Filters */}
        <details
          open={showAdvancedFilters}
          onToggle={(e) => setShowAdvancedFilters((e.target as HTMLDetailsElement).open)}
          className="group rounded-lg border border-default bg-background-subtle"
        >
          <summary className="flex items-center gap-2 p-3 text-xs font-medium text-muted cursor-pointer hover:text-foreground">
            <Settings className="w-3.5 h-3.5" />
            {t('enterprise_review_advanced_filters')}
          </summary>
          <div className="px-3 pb-3 space-y-3">
            {/* Content type filter */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">
                {t('enterprise_review_filter_content_types')}
              </label>
              <div className="flex flex-wrap gap-1.5">
                {['pdf', 'docx', 'pptx', 'xlsx', 'txt', 'html', 'csv'].map((ct) => {
                  const isActive = filterContentTypes.includes(ct);
                  return (
                    <button
                      key={ct}
                      type="button"
                      onClick={() => {
                        setFilterContentTypes((prev) =>
                          isActive ? prev.filter((x) => x !== ct) : [...prev, ct],
                        );
                      }}
                      className={`px-2 py-1 text-xs rounded-md border transition-default ${
                        isActive
                          ? 'border-accent bg-accent/10 text-accent'
                          : 'border-default bg-background text-muted hover:text-foreground'
                      }`}
                    >
                      .{ct}
                    </button>
                  );
                })}
              </div>
              {filterContentTypes.length === 0 && (
                <p className="text-xs text-subtle">{t('enterprise_review_filter_all_types')}</p>
              )}
            </div>

            {/* Modified since filter */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">
                {t('enterprise_review_filter_modified_since')}
              </label>
              <Input
                type="date"
                value={filterModifiedSince}
                onChange={(e) => setFilterModifiedSince(e.target.value)}
                className="text-xs"
              />
              {!filterModifiedSince && (
                <p className="text-xs text-subtle">{t('enterprise_review_filter_no_date')}</p>
              )}
            </div>
          </div>
        </details>

        {/* Sync Strategy */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted uppercase tracking-wide">
            {t('enterprise_review_sync_strategy')}
          </p>
          <div className="flex flex-wrap gap-2">
            <Badge variant="info">
              {t('enterprise_review_sync_mode', {
                mode: recommendation.syncStrategy.syncMode.replace(/_/g, ' '),
              })}
            </Badge>
            {recommendation.syncStrategy.deltaSyncSchedule && (
              <Badge variant="default">
                {t('enterprise_review_delta_schedule', {
                  schedule: recommendation.syncStrategy.deltaSyncSchedule,
                })}
              </Badge>
            )}
            <Badge variant={recommendation.syncStrategy.enableWebhooks ? 'success' : 'default'}>
              {t('enterprise_review_webhooks', {
                status: recommendation.syncStrategy.enableWebhooks ? 'enabled' : 'disabled',
              })}
            </Badge>
          </div>
        </div>

        {/* Cost Estimate */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted uppercase tracking-wide">
            {t('enterprise_review_cost_estimate')}
          </p>
          <div className="grid grid-cols-3 gap-3">
            <div className="flex items-center gap-2 p-2 rounded-lg bg-background-subtle border border-default">
              <HardDrive className="w-4 h-4 text-muted shrink-0" />
              <div>
                <p className="text-xs text-muted">Documents</p>
                <p className="text-sm font-medium text-foreground">
                  {recommendation.costEstimate.estimatedDocuments.toLocaleString()}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 p-2 rounded-lg bg-background-subtle border border-default">
              <HardDrive className="w-4 h-4 text-muted shrink-0" />
              <div>
                <p className="text-xs text-muted">Storage</p>
                <p className="text-sm font-medium text-foreground">
                  {formatBytes(recommendation.costEstimate.estimatedStorageBytes)}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 p-2 rounded-lg bg-background-subtle border border-default">
              <RefreshCw className="w-4 h-4 text-muted shrink-0" />
              <div>
                <p className="text-xs text-muted">Sync time</p>
                <p className="text-sm font-medium text-foreground">
                  {formatDuration(recommendation.costEstimate.estimatedSyncDurationSeconds)}
                </p>
              </div>
            </div>
          </div>
        </div>

        {error && <p className="text-sm text-error">{error}</p>}

        {/* Actions */}
        <div className="flex gap-3 pt-2">
          <Button variant="secondary" onClick={onClose} className="flex-1">
            {t('enterprise_cancel')}
          </Button>
          <Button onClick={() => handleAccept(false)} loading={loading} className="flex-1">
            {t('enterprise_review_accept')}
          </Button>
          <Button
            onClick={() => handleAccept(true)}
            loading={loading}
            icon={<Zap className="w-4 h-4" />}
            className="flex-1"
          >
            {t('enterprise_review_accept_and_sync')}
          </Button>
        </div>
      </div>
    );
  };

  // ─── Step Indicators ────────────────────────────────────────────────────

  const steps: { id: WizardStep; label: string }[] = [
    { id: 'configure', label: t('enterprise_step_configure') },
    { id: 'auth', label: t('enterprise_step_auth') },
    { id: 'setup-path', label: t('enterprise_step_setup') },
    { id: 'discovery', label: t('enterprise_step_discovery') },
    { id: 'review', label: t('enterprise_step_review') },
  ];

  const stepOrder: WizardStep[] = ['configure', 'auth', 'setup-path', 'discovery', 'review'];
  const currentStepIdx = stepOrder.indexOf(step);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('enterprise_wizard_title', { connectorType: connectorLabel })}
      maxWidth="lg"
    >
      {/* Step indicator bar */}
      <div className="flex items-center gap-1 mb-6">
        {steps.map((s, i) => (
          <div key={s.id} className="flex items-center gap-1 flex-1">
            <div
              className={`h-1 flex-1 rounded-full ${
                i <= currentStepIdx ? 'bg-accent' : 'bg-background-muted'
              }`}
            />
          </div>
        ))}
      </div>

      <div className="flex gap-4 mb-4">
        {steps.map((s, i) => (
          <span
            key={s.id}
            className={`text-xs ${i === currentStepIdx ? 'text-accent font-medium' : 'text-subtle'}`}
          >
            {s.label}
          </span>
        ))}
      </div>

      {/* Step content */}
      {step === 'configure' && renderConfigureStep()}
      {step === 'auth' && renderAuthStep()}
      {step === 'setup-path' && renderSetupPathStep()}
      {step === 'discovery' && renderDiscoveryStep()}
      {step === 'review' && renderReviewStep()}
    </Dialog>
  );
}
