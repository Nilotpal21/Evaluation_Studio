/**
 * CredentialsTab — dynamic credential form based on channel type definition.
 */

'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Shield } from 'lucide-react';
import { Input } from '../../../ui/Input';
import { Button } from '../../../ui/Button';
import { toast } from 'sonner';
import { updateConnection } from '../../../../api/channel-connections';
import { sanitizeError } from '../../../../lib/sanitize-error';
import type { ChannelTabProps, CredentialFieldDef } from '../types';
import { getActiveProviderOption } from '../channel-registry';
import { AuthProfilePicker } from '../../../auth-profiles/AuthProfilePicker';
import { AuthProfileToggle } from '../../../auth-profiles/AuthProfileToggle';

// =============================================================================
// COMPONENT
// =============================================================================

export function CredentialsTab({ projectId, channelDef, instance, onRefresh }: ChannelTabProps) {
  const t = useTranslations('channels.credentials');
  const [credValues, setCredValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [useAuthProfile, setUseAuthProfile] = useState(false);
  const [authProfileId, setAuthProfileId] = useState<string | null>(null);

  // Resolve provider-specific credential fields (e.g. Infobip vs Meta for WhatsApp)
  const providerOption = getActiveProviderOption(channelDef, instance);
  const activeCredentialFields: CredentialFieldDef[] = providerOption
    ? providerOption.credentialFields
    : channelDef.credentialFields;

  // For Infobip, determine auth type from instance config to filter fields
  const instanceAuthType = (instance.config?.authType as string) || 'api_key';
  const isInfobip = (instance.config?.provider as string) === 'infobip';

  const visibleFields = activeCredentialFields.filter((field) => {
    if (isInfobip) {
      if (instanceAuthType === 'api_key' && (field.key === 'username' || field.key === 'password'))
        return false;
      if (instanceAuthType === 'basic' && field.key === 'api_key') return false;
    }
    return true;
  });

  // -- Empty state: no credential fields for this channel type ----------------
  if (visibleFields.length === 0) {
    return <p className="text-sm text-muted">{t('no_credentials_needed')}</p>;
  }

  // -- Validation -------------------------------------------------------------
  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};

    for (const field of visibleFields) {
      const val = credValues[field.key] || '';

      // Required check: only enforce if instance does not already have saved creds
      if (field.required && !val.trim() && !instance.hasCredentials) {
        newErrors[field.key] = 'Required';
      }

      // Run custom validation if value present
      if (val.trim() && field.validation) {
        const err = field.validation(val);
        if (err) newErrors[field.key] = err;
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  // -- Save handler -----------------------------------------------------------
  const handleSave = async () => {
    // When using auth profile, skip manual credential validation
    if (useAuthProfile) {
      if (!authProfileId) {
        toast.error(t('select_auth_profile_required'));
        return;
      }

      if (instance._source !== 'channel_connection') {
        toast.info(t('not_supported'));
        return;
      }

      setSaving(true);
      try {
        await updateConnection(projectId, instance._sourceId, { authProfileId });
        toast.success(t('saved'));
        onRefresh();
      } catch (err) {
        toast.error(sanitizeError(err, t('save_failed')));
      } finally {
        setSaving(false);
      }
      return;
    }

    if (!validate()) return;

    // Build credentials object — only non-empty values
    const credentials: Record<string, string> = {};
    let hasNewCreds = false;
    for (const field of visibleFields) {
      const val = credValues[field.key]?.trim();
      if (val) {
        credentials[field.key] = val;
        hasNewCreds = true;
      }
    }

    if (!hasNewCreds) {
      toast.info(t('no_changes'));
      return;
    }

    // Only channel_connection source supports credential updates
    if (instance._source !== 'channel_connection') {
      toast.info(t('not_supported'));
      return;
    }

    setSaving(true);
    try {
      await updateConnection(projectId, instance._sourceId, { credentials, authProfileId: null });
      toast.success(t('saved'));
      setCredValues({});
      setErrors({});
      onRefresh();
    } catch (err) {
      toast.error(sanitizeError(err, t('save_failed')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* A. Saved indicator */}
      {instance.hasCredentials && (
        <p className="text-xs text-muted flex items-center gap-1.5">
          <Shield className="w-3.5 h-3.5 text-success" />
          {t('saved_encrypted')}
        </p>
      )}

      {/* Auth Profile toggle */}
      <AuthProfileToggle
        enabled={useAuthProfile}
        label={t('use_auth_profile')}
        onToggle={(val) => {
          setUseAuthProfile(val);
          setAuthProfileId(null);
        }}
      />

      {useAuthProfile ? (
        <div className="space-y-4">
          <AuthProfilePicker
            projectId={projectId}
            value={authProfileId}
            onChange={setAuthProfileId}
            filterAuthTypes={['api_key', 'bearer']}
            consumerKind="raw_connection"
            placeholder={t('auth_profile_placeholder')}
          />
          <Button
            variant="primary"
            onClick={handleSave}
            loading={saving}
            disabled={!authProfileId}
            className="w-full"
          >
            {t('save_button')}
          </Button>
        </div>
      ) : (
        <>
          {/* B. Credential fields */}
          {visibleFields.map((field) => (
            <div key={field.key}>
              <Input
                label={field.label}
                placeholder={instance.hasCredentials ? t('saved_placeholder') : field.placeholder}
                type={field.type}
                value={credValues[field.key] || ''}
                onChange={(e) => setCredValues((v) => ({ ...v, [field.key]: e.target.value }))}
              />
              {errors[field.key] && <p className="text-xs text-error mt-1">{errors[field.key]}</p>}
            </div>
          ))}

          {/* C. Save button */}
          <Button variant="primary" onClick={handleSave} loading={saving} className="w-full">
            {t('save_button')}
          </Button>
        </>
      )}
    </div>
  );
}
