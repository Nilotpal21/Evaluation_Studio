/**
 * VoiceServicesPage Component
 *
 * Admin page for managing tenant-scoped voice service credentials.
 * Provider cards are sourced from the Studio voice-provider registry.
 */

import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, CheckCircle2, Loader2, Eye, EyeOff, XCircle } from 'lucide-react';
import { PageHeader } from '../ui/PageHeader';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { SearchableSelect } from '../ui/SearchableSelect';
import { Textarea } from '../ui/Textarea';
import { Checkbox } from '../ui/Checkbox';
import { TTSPreview } from '../voice/TTSPreview';
import { AuthProfilePicker } from '../auth-profiles/AuthProfilePicker';
import { AuthProfileToggle } from '../auth-profiles/AuthProfileToggle';
import { toast } from 'sonner';
import { sanitizeError } from '../../lib/sanitize-error';
import { useAuthStore } from '../../store/auth-store';
import { useProjectStore } from '../../store/project-store';
import { apiFetch } from '../../lib/api-client';
import { fetchSpeechOptions } from '../../api/speech-providers';
import { getSpeechProviderRole } from '@agent-platform/config/constants/voice-providers';
import {
  ADMIN_STT_SERVICE_TYPES,
  ADMIN_TTS_SERVICE_TYPES,
  VOICE_SERVICE_CARD_CONFIGS,
  isTtsPreviewProvider,
  validateVoiceServiceConfig,
  type VoiceServiceCardConfig,
} from '../voice/voice-provider-registry';

// =============================================================================
// TYPES
// =============================================================================

interface ServiceInstance {
  id: string;
  _id?: string;
  tenantId: string;
  displayName: string;
  serviceType: string;
  authProfileId?: string | null;
  isDefault: boolean;
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
  config?: Record<string, unknown>;
}

interface CredentialTestStatus {
  status: string;
  reason?: string;
}

interface CredentialTestResult {
  tts: CredentialTestStatus;
  stt: CredentialTestStatus;
}

function serializeVoiceServiceFieldValue(
  field: VoiceServiceCardConfig['fields'][number],
  value: string | undefined,
): unknown {
  if (field.type === 'range') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : Number(field.defaultValue ?? 0);
  }

  if (field.type === 'toggle') {
    return value === 'true';
  }

  return value;
}

const DEFAULT_CREDENTIAL_TEST_RESULT: CredentialTestResult = {
  stt: { status: 'not tested' },
  tts: { status: 'not tested' },
};

function normalizeCredentialTestStatus(value: unknown): CredentialTestStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { status: 'not tested' };
  }

  const record = value as Record<string, unknown>;
  const status = typeof record.status === 'string' ? record.status : 'not tested';
  const reason = typeof record.reason === 'string' ? record.reason : undefined;
  return reason ? { status, reason } : { status };
}

function normalizeCredentialTestResult(value: unknown): CredentialTestResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return DEFAULT_CREDENTIAL_TEST_RESULT;
  }

  const record = value as Record<string, unknown>;
  return {
    stt: normalizeCredentialTestStatus(record.stt),
    tts: normalizeCredentialTestStatus(record.tts),
  };
}

function getResponseErrorMessage(data: unknown, fallback: string): string {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return fallback;
  }

  const record = data as Record<string, unknown>;
  if (typeof record.error === 'string') {
    return record.error;
  }

  if (
    record.error &&
    typeof record.error === 'object' &&
    !Array.isArray(record.error) &&
    typeof (record.error as Record<string, unknown>).message === 'string'
  ) {
    return String((record.error as Record<string, unknown>).message);
  }

  return fallback;
}

type CredentialTestState = 'untested' | 'valid' | 'invalid' | 'tested';

const credentialTestButtonStyles: Record<CredentialTestState, string> = {
  untested: 'text-muted hover:text-foreground',
  valid:
    'border border-success/40 bg-success-subtle text-success hover:bg-success-subtle hover:text-success',
  invalid:
    'border border-error/40 bg-error-subtle text-error hover:bg-error-subtle hover:text-error',
  tested: 'border border-default bg-background-muted text-foreground hover:bg-background-elevated',
};

function isSuccessfulCredentialStatus(status: string): boolean {
  return status === 'ok' || status === 'success';
}

function isCredentialDirectionTested(status: string): boolean {
  return status !== 'not tested';
}

function getRelevantCredentialStatuses(
  result: CredentialTestResult | null,
  supportsStt: boolean,
  supportsTts: boolean,
): string[] {
  if (!result) {
    return [];
  }

  return [supportsStt ? result.stt.status : null, supportsTts ? result.tts.status : null].filter(
    (status): status is string => typeof status === 'string',
  );
}

function getCredentialTestState(
  result: CredentialTestResult | null,
  supportsStt: boolean,
  supportsTts: boolean,
): CredentialTestState {
  const testedStatuses = getRelevantCredentialStatuses(result, supportsStt, supportsTts).filter(
    isCredentialDirectionTested,
  );

  if (testedStatuses.length === 0) {
    return 'untested';
  }

  if (testedStatuses.includes('fail')) {
    return 'invalid';
  }

  if (testedStatuses.some(isSuccessfulCredentialStatus)) {
    return 'valid';
  }

  return 'tested';
}

function getCredentialTestButtonLabel(state: CredentialTestState): string {
  if (state === 'valid') {
    return 'Tested';
  }

  if (state === 'invalid') {
    return 'Failed';
  }

  return 'Test';
}

function getCredentialTestButtonIcon(state: CredentialTestState): ReactNode {
  if (state === 'valid') {
    return <CheckCircle2 className="w-3.5 h-3.5" />;
  }

  if (state === 'invalid') {
    return <XCircle className="w-3.5 h-3.5" />;
  }

  return <CheckCircle2 className="w-3.5 h-3.5" />;
}

function getCredentialTestFailureReasons(
  result: CredentialTestResult | null,
  supportsStt: boolean,
  supportsTts: boolean,
): string[] {
  if (!result) {
    return [];
  }

  return [
    supportsStt && result.stt.reason ? result.stt.reason : null,
    supportsTts && result.tts.reason ? result.tts.reason : null,
  ].filter((reason): reason is string => typeof reason === 'string');
}

function ServiceCard({
  config,
  instance,
  tenantId,
  onUpdated,
}: {
  config: VoiceServiceCardConfig;
  instance: ServiceInstance | null;
  tenantId: string;
  onUpdated: () => void;
}) {
  const t = useTranslations('admin');
  const [showDialog, setShowDialog] = useState(false);
  const [showTestDialog, setShowTestDialog] = useState(false);
  const [testingCredentials, setTestingCredentials] = useState(false);
  const [credentialTestResult, setCredentialTestResult] = useState<CredentialTestResult | null>(
    null,
  );
  const validationRequestRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef(true);
  const isConfigured = instance != null;
  const instanceId = instance?.id || instance?._id || null;
  const instanceUpdatedAt = instance?.updatedAt ?? null;
  const canPreview = isConfigured && isTtsPreviewProvider(config.serviceType);
  const speechRole = getSpeechProviderRole(config.serviceType);
  const supportsCredentialTestStt = speechRole?.useForStt === true;
  const supportsCredentialTestTts = speechRole?.useForTts === true;
  const canTestCredentials =
    isConfigured && (supportsCredentialTestStt || supportsCredentialTestTts);
  const credentialTestState = getCredentialTestState(
    credentialTestResult,
    supportsCredentialTestStt,
    supportsCredentialTestTts,
  );
  const credentialTestFailureReasons = getCredentialTestFailureReasons(
    credentialTestResult,
    supportsCredentialTestStt,
    supportsCredentialTestTts,
  );

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      validationRequestRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    setCredentialTestResult(null);
    validationRequestRef.current?.abort();
    if (isMountedRef.current) {
      setTestingCredentials(false);
    }
  }, [config.serviceType, instanceId, instanceUpdatedAt]);

  const handleTestCredentials = async () => {
    if (!instanceId) return;

    validationRequestRef.current?.abort();
    const controller = new AbortController();
    validationRequestRef.current = controller;
    setTestingCredentials(true);
    try {
      const res = await apiFetch(
        `/api/service-instances/${encodeURIComponent(instanceId)}/test?tenantId=${tenantId}`,
        { method: 'POST', signal: controller.signal },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(getResponseErrorMessage(data, 'Failed to test credentials'));
      }

      if (!isMountedRef.current || controller.signal.aborted) {
        return;
      }

      const result = normalizeCredentialTestResult((data as { result?: unknown }).result);
      setCredentialTestResult(result);
      const relevantStatuses = getRelevantCredentialStatuses(
        result,
        supportsCredentialTestStt,
        supportsCredentialTestTts,
      );
      if (relevantStatuses.includes('fail')) {
        toast.error('Credential test failed');
      } else if (relevantStatuses.some(isSuccessfulCredentialStatus)) {
        toast.success('Credential test passed');
      } else {
        toast.success('Credential test completed');
      }
    } catch (err) {
      if (controller.signal.aborted) {
        return;
      }
      toast.error(sanitizeError(err, 'Failed to test credentials'));
    } finally {
      if (validationRequestRef.current === controller) {
        validationRequestRef.current = null;
      }
      if (isMountedRef.current && !controller.signal.aborted) {
        setTestingCredentials(false);
      }
    }
  };

  return (
    <>
      <div className="p-5 rounded-lg border border-default bg-background-elevated">
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-background-muted flex items-center justify-center text-muted shrink-0">
              {config.icon}
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">{config.label}</h3>
              <p className="text-xs text-muted mt-0.5">{config.description}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Badge variant={isConfigured ? 'success' : 'warning'} dot>
              {isConfigured ? t('voice.configured') : t('voice.not_configured')}
            </Badge>
            {canTestCredentials && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleTestCredentials}
                loading={testingCredentials}
                icon={getCredentialTestButtonIcon(credentialTestState)}
                className={credentialTestButtonStyles[credentialTestState]}
              >
                {testingCredentials ? 'Testing' : getCredentialTestButtonLabel(credentialTestState)}
              </Button>
            )}
            {canPreview && (
              <Button variant="ghost" size="sm" onClick={() => setShowTestDialog(true)}>
                Preview
              </Button>
            )}
            <Button
              variant={isConfigured ? 'secondary' : 'primary'}
              size="sm"
              onClick={() => setShowDialog(true)}
            >
              {isConfigured ? t('voice.edit') : t('voice.configure')}
            </Button>
          </div>
        </div>
        {isConfigured && instance && (
          <div className="mt-3 pt-3 border-t border-default flex flex-wrap items-center gap-4 text-xs text-muted">
            <span>Name: {instance.displayName}</span>
            {instance.isDefault && <Badge variant="accent">Default</Badge>}
            {instance.updatedAt && (
              <span>Updated {new Date(instance.updatedAt).toLocaleDateString()}</span>
            )}
          </div>
        )}
        {credentialTestFailureReasons.length > 0 && (
          <div className="mt-2 text-xs text-error space-y-1">
            {credentialTestFailureReasons.map((reason, index) => (
              <p key={`${reason}-${index}`}>{reason}</p>
            ))}
          </div>
        )}
      </div>

      <ConfigureDialog
        open={showDialog}
        onClose={() => setShowDialog(false)}
        config={config}
        instance={instance}
        tenantId={tenantId}
        onSaved={() => {
          setShowDialog(false);
          onUpdated();
        }}
      />

      {canPreview && instance && (
        <Dialog
          open={showTestDialog}
          onClose={() => setShowTestDialog(false)}
          title={`Preview ${config.label}`}
          maxWidth="md"
        >
          <TTSPreview
            provider={config.serviceType}
            serviceInstanceId={instance.id}
            voice={
              typeof instance.config?.voiceId === 'string' ? instance.config.voiceId : undefined
            }
            model={typeof instance.config?.model === 'string' ? instance.config.model : undefined}
            allowVoiceOverride
          />
        </Dialog>
      )}
    </>
  );
}

// =============================================================================
// CONFIGURE DIALOG
// =============================================================================

function ConfigureDialog({
  open,
  onClose,
  config,
  instance,
  tenantId,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  config: VoiceServiceCardConfig;
  instance: ServiceInstance | null;
  tenantId: string;
  onSaved: () => void;
}) {
  const t = useTranslations('admin');
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const projects = useProjectStore((s) => s.projects);
  const resolvedProjectId = currentProjectId || projects[0]?.id || null;

  const [values, setValues] = useState<Record<string, string>>({});
  const [displayName, setDisplayName] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showSensitiveValues, setShowSensitiveValues] = useState(false);
  const [useAuthProfile, setUseAuthProfile] = useState(false);
  const [authProfileId, setAuthProfileId] = useState<string | null>(null);
  const [voiceOptions, setVoiceOptions] = useState<Array<{ value: string; label: string }>>([]);
  const [voiceOptionsLoading, setVoiceOptionsLoading] = useState(false);
  const [voiceOptionsError, setVoiceOptionsError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const primaryCredentialField = config.fields.find((field) => field.storage === 'apiKey') ?? null;

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      const initial: Record<string, string> = {};
      config.fields.forEach((f) => {
        if (f.storage === 'config' && !f.sensitive) {
          const savedValue = instance?.config?.[f.key];
          initial[f.key] = savedValue != null ? String(savedValue) : f.defaultValue || '';
        } else {
          initial[f.key] = '';
        }
      });
      setValues(initial);
      setDisplayName(instance?.displayName || `${config.label} Credentials`);
      setShowSensitiveValues(false);
      setFieldErrors({});
      const initialAuthProfileId =
        primaryCredentialField?.authProfileEligible && typeof instance?.authProfileId === 'string'
          ? instance.authProfileId
          : null;
      setUseAuthProfile(Boolean(initialAuthProfileId));
      setAuthProfileId(initialAuthProfileId);
    }
  }, [open, config, instance, primaryCredentialField?.authProfileEligible]);

  useEffect(() => {
    if (!open || !isTtsPreviewProvider(config.serviceType)) {
      setVoiceOptions([]);
      setVoiceOptionsLoading(false);
      setVoiceOptionsError(null);
      return;
    }

    let cancelled = false;

    async function loadVoiceOptions() {
      setVoiceOptionsLoading(true);
      setVoiceOptionsError(null);

      try {
        const options = await fetchSpeechOptions(config.serviceType);
        if (cancelled) return;

        const seen = new Set<string>();
        const nextOptions: Array<{ value: string; label: string }> = [];

        for (const languageEntry of options.tts) {
          for (const voiceEntry of languageEntry.voices ?? []) {
            if (seen.has(voiceEntry.value)) continue;
            seen.add(voiceEntry.value);
            nextOptions.push({
              value: voiceEntry.value,
              label: voiceEntry.name,
            });
          }
        }

        setVoiceOptions(nextOptions);
      } catch {
        if (cancelled) return;
        setVoiceOptions([]);
        setVoiceOptionsError('Failed to load voices');
      } finally {
        if (!cancelled) {
          setVoiceOptionsLoading(false);
        }
      }
    }

    void loadVoiceOptions();

    return () => {
      cancelled = true;
    };
  }, [open, config.serviceType]);

  const handleSave = async () => {
    const apiKeyValue = primaryCredentialField ? values[primaryCredentialField.key] || '' : '';

    // For new instances, either API key or auth profile is required
    if (!instance && !useAuthProfile && !apiKeyValue) {
      toast.error(t('voice.api_key_required'));
      return;
    }
    if (useAuthProfile && primaryCredentialField?.authProfileEligible && !authProfileId) {
      toast.error(t('voice.auth_profile_required'));
      return;
    }

    if (
      instance?.authProfileId &&
      primaryCredentialField?.authProfileEligible &&
      !useAuthProfile &&
      !apiKeyValue
    ) {
      toast.error(t('voice.api_key_required'));
      return;
    }

    setSaving(true);
    try {
      // Build config object from config-backed fields
      const configPayload: Record<string, unknown> = {};
      config.fields.forEach((f) => {
        if (f.storage === 'config' && (f.sensitive ? values[f.key] : values[f.key] !== undefined)) {
          configPayload[f.key] = serializeVoiceServiceFieldValue(f, values[f.key]);
        }
      });
      const validation = validateVoiceServiceConfig(config.serviceType, configPayload);
      if (!validation.isValid) {
        setFieldErrors(validation.fieldErrors);
        toast.error(Object.values(validation.fieldErrors)[0] || t('voice.save_failed'));
        return;
      }
      setFieldErrors({});

      if (instance) {
        // Update existing
        const body: Record<string, unknown> = { displayName };
        if (primaryCredentialField?.authProfileEligible && useAuthProfile && authProfileId) {
          body.authProfileId = authProfileId;
        } else if (primaryCredentialField?.authProfileEligible) {
          body.authProfileId = null;
          if (primaryCredentialField && apiKeyValue) {
            body.apiKey = apiKeyValue;
          }
        } else if (primaryCredentialField && apiKeyValue) {
          body.apiKey = apiKeyValue;
        }
        if (Object.keys(configPayload).length > 0) {
          body.config = configPayload;
        }

        const res = await apiFetch(
          `/api/service-instances/${instance.id || instance._id}?tenantId=${tenantId}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
        );
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'Failed to update');
        }
        toast.success(t('voice.credentials_updated', { service: config.label }));
      } else {
        // Create new
        const body: Record<string, unknown> = {
          displayName,
          serviceType: config.serviceType,
          isDefault: true,
        };
        if (primaryCredentialField?.authProfileEligible && useAuthProfile && authProfileId) {
          body.authProfileId = authProfileId;
        } else {
          body.apiKey = apiKeyValue;
        }
        if (Object.keys(configPayload).length > 0) {
          body.config = configPayload;
        }

        const res = await apiFetch(`/api/service-instances?tenantId=${tenantId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'Failed to create');
        }
        toast.success(t('voice.credentials_saved', { service: config.label }));
      }
      onSaved();
    } catch (err) {
      toast.error(sanitizeError(err, t('voice.save_failed')));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!instance) return;
    setDeleting(true);
    try {
      const res = await apiFetch(
        `/api/service-instances/${instance.id || instance._id}?tenantId=${tenantId}`,
        { method: 'DELETE' },
      );
      if (!res.ok) throw new Error('Failed to delete');
      toast.success(t('voice.credentials_removed', { service: config.label }));
      onSaved();
    } catch (err) {
      toast.error(sanitizeError(err, t('voice.delete_failed')));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={instance ? `Edit ${config.label}` : `${t('voice.configure')} ${config.label}`}
      description={instance ? t('voice.update_credentials') : t('voice.enter_credentials')}
      maxWidth="md"
    >
      <div className="space-y-4">
        <Input
          label={t('voice.display_name_label')}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder={`${config.label} Credentials`}
        />

        {config.fields.map((field) => {
          const fieldValue = values[field.key] || '';
          const fieldError = fieldErrors[field.key];
          const showLeaveBlankHint = Boolean(
            instance && (field.storage === 'apiKey' || field.sensitive),
          );
          const setFieldValue = (value: string) => {
            setValues((v) => ({ ...v, [field.key]: value }));
            setFieldErrors((errors) => {
              if (!errors[field.key]) {
                return errors;
              }
              const next = { ...errors };
              delete next[field.key];
              return next;
            });
          };
          const canUseAuthProfile =
            primaryCredentialField?.key === field.key &&
            field.authProfileEligible &&
            resolvedProjectId != null;

          const renderStandardField = () => {
            if (field.key === 'voiceId' && voiceOptions.length > 0) {
              return (
                <div>
                  <SearchableSelect
                    label={field.label}
                    options={voiceOptions}
                    value={fieldValue || field.defaultValue || ''}
                    onChange={setFieldValue}
                    disabled={voiceOptionsLoading}
                    placeholder={field.placeholder}
                    error={fieldError || voiceOptionsError || undefined}
                  />
                  {voiceOptionsLoading && (
                    <p className="text-xs text-muted mt-1.5">Loading voices...</p>
                  )}
                  {field.hint && <p className="text-xs text-muted mt-1.5">{field.hint}</p>}
                </div>
              );
            }

            if (field.type === 'select' && field.options) {
              return (
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1.5">
                    {field.label}
                    {showLeaveBlankHint && (
                      <span className="text-xs text-muted ml-2">{t('voice.leave_blank')}</span>
                    )}
                  </label>
                  <select
                    value={fieldValue || field.defaultValue || ''}
                    onChange={(e) => setFieldValue(e.target.value)}
                    className="w-full rounded-lg border border-default bg-background-subtle text-foreground text-sm py-2 px-3 focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
                  >
                    {field.options.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  {field.hint && <p className="text-xs text-muted mt-1.5">{field.hint}</p>}
                </div>
              );
            }

            if (field.type === 'textarea') {
              return (
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1.5">
                    {field.label}
                    {showLeaveBlankHint && (
                      <span className="text-xs text-muted ml-2">{t('voice.leave_blank')}</span>
                    )}
                  </label>
                  <Textarea
                    value={fieldValue}
                    onChange={(e) => setFieldValue(e.target.value)}
                    placeholder={field.placeholder}
                    rows={field.rows ?? 6}
                  />
                  {fieldError && <p className="text-xs text-error mt-1.5">{fieldError}</p>}
                  {field.hint && <p className="text-xs text-muted mt-1.5">{field.hint}</p>}
                </div>
              );
            }

            if (field.type === 'range') {
              const value = fieldValue || field.defaultValue || String(field.min ?? 0);
              return (
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1.5">
                    {field.label}: {value}
                  </label>
                  <input
                    type="range"
                    min={field.min}
                    max={field.max}
                    step={field.step}
                    value={value}
                    onChange={(e) => setFieldValue(e.target.value)}
                    className="w-full accent-accent"
                    aria-label={field.label}
                  />
                  <div className="flex justify-between text-xs text-muted mt-1">
                    <span>{field.min}</span>
                    <span>{field.max}</span>
                  </div>
                  {field.hint && <p className="text-xs text-muted mt-1.5">{field.hint}</p>}
                </div>
              );
            }

            if (field.type === 'toggle') {
              const checked = (fieldValue || field.defaultValue) === 'true';
              return (
                <Checkbox
                  checked={checked}
                  onChange={(nextChecked) => setFieldValue(String(nextChecked))}
                  label={field.label}
                  description={typeof field.hint === 'string' ? field.hint : undefined}
                />
              );
            }

            if (field.sensitive) {
              return (
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1.5">
                    {field.label}
                    {showLeaveBlankHint && (
                      <span className="text-xs text-muted ml-2">{t('voice.leave_blank')}</span>
                    )}
                  </label>
                  <div className="relative">
                    <input
                      type={showSensitiveValues ? 'text' : 'password'}
                      value={fieldValue}
                      onChange={(e) => setFieldValue(e.target.value)}
                      placeholder={instance ? '********' : field.placeholder}
                      className="w-full rounded-lg border border-default bg-background-subtle text-foreground text-sm py-2 px-3 pr-10 focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      onClick={() => setShowSensitiveValues(!showSensitiveValues)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted hover:text-foreground transition-default"
                    >
                      {showSensitiveValues ? (
                        <EyeOff className="w-4 h-4" />
                      ) : (
                        <Eye className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                  {fieldError && <p className="text-xs text-error mt-1.5">{fieldError}</p>}
                  {field.hint && <p className="text-xs text-muted mt-1.5">{field.hint}</p>}
                </div>
              );
            }

            return (
              <div>
                <Input
                  label={field.label}
                  value={fieldValue}
                  onChange={(e) => setFieldValue(e.target.value)}
                  placeholder={field.placeholder}
                  error={fieldError}
                />
                {showLeaveBlankHint && (
                  <p className="text-xs text-muted mt-1.5">{t('voice.leave_blank')}</p>
                )}
                {field.key === 'voiceId' && voiceOptionsError && (
                  <p className="text-xs text-muted mt-1.5">
                    Failed to load voices. Enter a voice ID manually.
                  </p>
                )}
                {field.hint && <p className="text-xs text-muted mt-1.5">{field.hint}</p>}
              </div>
            );
          };

          return (
            <div key={field.key}>
              {canUseAuthProfile ? (
                <div>
                  {resolvedProjectId && (
                    <AuthProfileToggle
                      enabled={useAuthProfile}
                      onToggle={(val) => {
                        setUseAuthProfile(val);
                        if (val) {
                          setValues((v) => ({ ...v, [field.key]: '' }));
                        } else {
                          setAuthProfileId(null);
                        }
                      }}
                      label={t('voice.authentication')}
                      className="mb-2"
                    />
                  )}

                  {useAuthProfile && resolvedProjectId ? (
                    <div>
                      <AuthProfilePicker
                        projectId={resolvedProjectId}
                        value={authProfileId}
                        onChange={setAuthProfileId}
                        filterAuthTypes={['api_key', 'bearer']}
                        consumerKind="http_tool"
                        placeholder={t('voice.auth_profile_placeholder')}
                      />
                      <p className="text-xs text-muted mt-1.5">{t('voice.auth_profile_hint')}</p>
                    </div>
                  ) : (
                    renderStandardField()
                  )}
                </div>
              ) : (
                renderStandardField()
              )}
            </div>
          );
        })}

        <div className="flex items-center justify-between pt-4 border-t border-default">
          {instance ? (
            <Button variant="danger" size="sm" onClick={handleDelete} loading={deleting}>
              {t('voice.remove_credentials')}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>
              {t('voice.cancel')}
            </Button>
            <Button variant="primary" size="sm" onClick={handleSave} loading={saving}>
              {instance ? t('voice.update') : t('voice.save')}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

// =============================================================================
// MAIN PAGE
// =============================================================================

export function VoiceServicesPage() {
  const t = useTranslations('admin');
  const tenantId = useAuthStore((s) => s.tenantId);
  const [instances, setInstances] = useState<ServiceInstance[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(async () => {
    if (!tenantId) return;
    setIsLoading(true);
    try {
      const res = await apiFetch(`/api/service-instances?tenantId=${tenantId}`);
      if (!res.ok) throw new Error('Failed to load');
      const data = await res.json();
      setInstances(data.instances || data.serviceInstances || []);
    } catch {
      toast.error(t('voice.load_failed'));
    } finally {
      setIsLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    load();
  }, [load]);

  const findInstance = (serviceType: string) =>
    instances.find((i) => i.serviceType === serviceType && i.isActive) || null;

  const sttConfigured = ADMIN_STT_SERVICE_TYPES.some(
    (serviceType) => findInstance(serviceType) != null,
  );
  const ttsConfigured = ADMIN_TTS_SERVICE_TYPES.some(
    (serviceType) => findInstance(serviceType) != null,
  );
  const voiceReady = sttConfigured && ttsConfigured;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto px-6 py-8">
        <PageHeader title={t('voice.title')} description={t('voice.description')} />

        {/* Warning banner */}
        {!isLoading && !voiceReady && (
          <div className="mt-6 p-4 rounded-lg border border-warning/30 bg-warning-subtle">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
              <div>
                <h4 className="text-sm font-medium text-foreground">{t('voice.warning_title')}</h4>
                <p className="text-xs text-muted mt-1">{t('voice.warning_description')}</p>
              </div>
            </div>
          </div>
        )}

        {/* Status summary */}
        {!isLoading && voiceReady && (
          <div className="mt-6 p-4 rounded-lg border border-success/30 bg-success-subtle">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-success shrink-0 mt-0.5" />
              <div>
                <h4 className="text-sm font-medium text-foreground">{t('voice.ready_title')}</h4>
                <p className="text-xs text-muted mt-1">{t('voice.ready_description')}</p>
              </div>
            </div>
          </div>
        )}

        {/* Service cards */}
        <div className="mt-6 space-y-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-5 h-5 text-muted animate-spin" />
            </div>
          ) : (
            VOICE_SERVICE_CARD_CONFIGS.map((cardConfig) => (
              <ServiceCard
                key={cardConfig.serviceType}
                config={cardConfig}
                instance={findInstance(cardConfig.serviceType)}
                tenantId={tenantId!}
                onUpdated={load}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
