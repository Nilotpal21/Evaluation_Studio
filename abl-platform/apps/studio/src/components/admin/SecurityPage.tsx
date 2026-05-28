/**
 * SecurityPage Component
 *
 * Tenant-level admin page for MFA, SSO configuration, and Audit Logs.
 * Three tabs: MFA | SSO | Audit Logs.
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Shield, Lock, FileText, Loader2, Check, X } from 'lucide-react';
import { apiFetch } from '../../lib/api-client';
import { useNavigationStore } from '../../store/navigation-store';
import { PageHeader } from '../ui/PageHeader';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Badge } from '../ui/Badge';
import { Tabs } from '../ui/Tabs';
import { Toggle } from '../ui/Toggle';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MfaStatus {
  enabled: boolean;
  confirmedAt?: string;
}

interface MfaSetupResponse {
  secret: string;
  otpauthUrl: string;
  recoveryCodes: string[];
}

interface SsoConfig {
  protocol: 'saml' | 'oidc';
  forceSso: boolean;
  allowGoogleFallback: boolean;
  saml?: {
    entryPoint: string;
    issuer: string;
    cert: string;
  };
  oidc?: {
    clientId: string;
    clientSecret: string;
    discoveryUrl: string;
  };
}

interface DomainStatus {
  domain: string;
  verified: boolean;
  verifiedAt?: string;
}

// ---------------------------------------------------------------------------
// Tab definitions
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// MFA Tab
// ---------------------------------------------------------------------------

function MfaTab() {
  const t = useTranslations('admin');
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [setupData, setSetupData] = useState<MfaSetupResponse | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [confirmError, setConfirmError] = useState('');
  const [disableLoading, setDisableLoading] = useState(false);
  const [setupLoading, setSetupLoading] = useState(false);
  const [showRecoveryCodes, setShowRecoveryCodes] = useState(false);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/mfa/status');
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const handleSetup = async () => {
    setSetupLoading(true);
    setConfirmError('');
    try {
      const res = await apiFetch('/api/mfa/setup', { method: 'POST' });
      if (res.ok) {
        const data: MfaSetupResponse = await res.json();
        setSetupData(data);
        setShowRecoveryCodes(true);
      }
    } catch {
      setConfirmError(t('security.mfa.setup_failed'));
    } finally {
      setSetupLoading(false);
    }
  };

  const handleConfirm = async () => {
    if (!totpCode.trim()) return;
    setConfirmLoading(true);
    setConfirmError('');
    try {
      const res = await apiFetch('/api/mfa/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: totpCode.trim() }),
      });
      if (res.ok) {
        setSetupData(null);
        setTotpCode('');
        setShowRecoveryCodes(false);
        await loadStatus();
      } else {
        const err = await res.json().catch(() => ({}));
        setConfirmError((err as { message?: string }).message || t('security.mfa.invalid_code'));
      }
    } catch {
      setConfirmError(t('security.mfa.confirm_failed'));
    } finally {
      setConfirmLoading(false);
    }
  };

  const handleDisable = async () => {
    setDisableLoading(true);
    try {
      const res = await apiFetch('/api/mfa/disable', { method: 'DELETE' });
      if (res.ok) {
        await loadStatus();
      }
    } catch {
      // ignore
    } finally {
      setDisableLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-5 h-5 text-muted animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Status card */}
      <div className="p-5 rounded-xl border border-default bg-background-elevated bg-noise">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-background-muted flex items-center justify-center">
              <Shield className="w-5 h-5 text-muted" />
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">{t('security.mfa.title')}</p>
              <p className="text-xs text-muted mt-0.5">
                {status?.enabled
                  ? t('security.mfa.enabled_description')
                  : t('security.mfa.disabled_description')}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Badge variant={status?.enabled ? 'success' : 'default'} dot>
              {status?.enabled ? t('security.mfa.enabled') : t('security.mfa.disabled')}
            </Badge>
            {status?.enabled ? (
              <Button variant="danger" size="sm" onClick={handleDisable} loading={disableLoading}>
                {t('security.mfa.disable')}
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                onClick={handleSetup}
                loading={setupLoading}
                disabled={!!setupData}
              >
                {t('security.mfa.enable')}
              </Button>
            )}
          </div>
        </div>
        {status?.enabled && status.confirmedAt && (
          <p className="text-xs text-muted mt-3">
            {t('security.mfa.enabled_on', {
              date: new Date(status.confirmedAt).toLocaleDateString(),
            })}
          </p>
        )}
      </div>

      {/* Setup flow */}
      {setupData && (
        <div className="p-5 rounded-xl border border-default bg-background-elevated space-y-5 bg-noise">
          <h3 className="text-sm font-semibold text-foreground">{t('security.mfa.setup_title')}</h3>

          {/* Step 1: QR / manual key */}
          <div className="space-y-3">
            <p className="text-sm text-muted">{t('security.mfa.setup_instructions')}</p>
            <div className="p-4 rounded-lg bg-background-muted border border-default">
              <p className="text-xs text-muted mb-2">{t('security.mfa.otp_auth_url')}</p>
              <p className="text-sm font-mono text-foreground break-all">{setupData.otpauthUrl}</p>
            </div>
            <div className="p-4 rounded-lg bg-background-muted border border-default">
              <p className="text-xs text-muted mb-2">{t('security.mfa.secret_key')}</p>
              <p className="text-sm font-mono text-foreground tracking-wide">{setupData.secret}</p>
            </div>
          </div>

          {/* Recovery codes */}
          {showRecoveryCodes && setupData.recoveryCodes.length > 0 && (
            <div className="space-y-3">
              <p className="text-sm font-medium text-foreground">
                {t('security.mfa.recovery_codes_title')}
              </p>
              <p className="text-xs text-muted">{t('security.mfa.recovery_codes_description')}</p>
              <div className="grid grid-cols-2 gap-2 p-4 rounded-lg bg-background-muted border border-default">
                {setupData.recoveryCodes.map((code, i) => (
                  <span key={i} className="text-sm font-mono text-foreground">
                    {code}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Step 2: Confirm with TOTP code */}
          <div className="space-y-3">
            <Input
              label={t('security.mfa.verification_code_label')}
              placeholder={t('security.mfa.verification_code_placeholder')}
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
              error={confirmError}
            />
            <div className="flex gap-3">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setSetupData(null);
                  setTotpCode('');
                  setConfirmError('');
                  setShowRecoveryCodes(false);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleConfirm}
                loading={confirmLoading}
                disabled={!totpCode.trim()}
                icon={<Check className="w-3.5 h-3.5" />}
              >
                {t('security.mfa.verify_enable')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SSO Tab
// ---------------------------------------------------------------------------

function SsoTab() {
  const t = useTranslations('admin');
  const [protocol, setProtocol] = useState<'saml' | 'oidc'>('saml');
  const [forceSso, setForceSso] = useState(false);
  const [allowGoogleFallback, setAllowGoogleFallback] = useState(true);

  // SAML fields
  const [samlEntryPoint, setSamlEntryPoint] = useState('');
  const [samlIssuer, setSamlIssuer] = useState('');
  const [samlCert, setSamlCert] = useState('');

  // OIDC fields
  const [oidcClientId, setOidcClientId] = useState('');
  const [oidcClientSecret, setOidcClientSecret] = useState('');
  const [oidcDiscoveryUrl, setOidcDiscoveryUrl] = useState('');

  // Domain
  const [domain, setDomain] = useState('');
  const [domainStatus, setDomainStatus] = useState<DomainStatus | null>(null);
  const [domainLoading, setDomainLoading] = useState(false);
  const [domainError, setDomainError] = useState('');

  // Save state
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState('');

  const handleSaveConfig = async () => {
    setSaving(true);
    setSaveError('');
    setSaveSuccess(false);
    try {
      const config: SsoConfig = {
        protocol,
        forceSso,
        allowGoogleFallback,
      };
      if (protocol === 'saml') {
        config.saml = {
          entryPoint: samlEntryPoint,
          issuer: samlIssuer,
          cert: samlCert,
        };
      } else {
        config.oidc = {
          clientId: oidcClientId,
          clientSecret: oidcClientSecret,
          discoveryUrl: oidcDiscoveryUrl,
        };
      }

      const res = await apiFetch('/api/sso/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      if (res.ok) {
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 3000);
      } else {
        const err = await res.json().catch(() => ({}));
        setSaveError((err as { message?: string }).message || t('security.sso.save_failed'));
      }
    } catch {
      setSaveError(t('security.sso.save_failed'));
    } finally {
      setSaving(false);
    }
  };

  const handleClaimDomain = async () => {
    if (!domain.trim()) return;
    setDomainLoading(true);
    setDomainError('');
    try {
      const res = await apiFetch('/api/sso/domains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: domain.trim() }),
      });
      if (res.ok) {
        const data: DomainStatus = await res.json();
        setDomainStatus(data);
      } else {
        const err = await res.json().catch(() => ({}));
        setDomainError((err as { message?: string }).message || t('security.sso.claim_failed'));
      }
    } catch {
      setDomainError(t('security.sso.claim_failed'));
    } finally {
      setDomainLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Protocol selector */}
      <div className="p-5 rounded-xl border border-default bg-background-elevated space-y-5 bg-noise">
        <h3 className="text-sm font-semibold text-foreground">
          {t('security.sso.protocol_title')}
        </h3>
        <div className="flex gap-3">
          <button
            onClick={() => setProtocol('saml')}
            className={`flex-1 p-4 rounded-lg border text-left transition-default ${
              protocol === 'saml'
                ? 'border-accent bg-accent-subtle'
                : 'border-default bg-background-subtle hover:bg-background-muted'
            }`}
          >
            <p className="text-sm font-medium text-foreground">{t('security.sso.saml_title')}</p>
            <p className="text-xs text-muted mt-1">{t('security.sso.saml_description')}</p>
          </button>
          <button
            onClick={() => setProtocol('oidc')}
            className={`flex-1 p-4 rounded-lg border text-left transition-default ${
              protocol === 'oidc'
                ? 'border-accent bg-accent-subtle'
                : 'border-default bg-background-subtle hover:bg-background-muted'
            }`}
          >
            <p className="text-sm font-medium text-foreground">{t('security.sso.oidc_title')}</p>
            <p className="text-xs text-muted mt-1">{t('security.sso.oidc_description')}</p>
          </button>
        </div>

        {/* Toggles */}
        <div className="space-y-4">
          <Toggle
            checked={forceSso}
            onChange={setForceSso}
            label={t('security.sso.force_sso')}
            description={t('security.sso.force_sso_description')}
          />
          <Toggle
            checked={allowGoogleFallback}
            onChange={setAllowGoogleFallback}
            label={t('security.sso.google_fallback')}
            description={t('security.sso.google_fallback_description')}
          />
        </div>
      </div>

      {/* Protocol-specific fields */}
      <div className="p-5 rounded-xl border border-default bg-background-elevated space-y-4 bg-noise">
        <h3 className="text-sm font-semibold text-foreground">
          {protocol === 'saml'
            ? t('security.sso.saml_config_title')
            : t('security.sso.oidc_config_title')}
        </h3>

        {protocol === 'saml' ? (
          <>
            <Input
              label={t('security.sso.entry_point_label')}
              placeholder={t('security.sso.entry_point_placeholder')}
              value={samlEntryPoint}
              onChange={(e) => setSamlEntryPoint(e.target.value)}
            />
            <Input
              label={t('security.sso.issuer_label')}
              placeholder={t('security.sso.issuer_placeholder')}
              value={samlIssuer}
              onChange={(e) => setSamlIssuer(e.target.value)}
            />
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-foreground">
                {t('security.sso.certificate_label')}
              </label>
              <textarea
                value={samlCert}
                onChange={(e) => setSamlCert(e.target.value)}
                placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
                rows={5}
                className="w-full rounded-lg border border-default bg-background-subtle text-foreground placeholder:text-subtle transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus text-sm py-2 px-3 font-mono resize-none"
              />
            </div>
          </>
        ) : (
          <>
            <Input
              label={t('security.sso.client_id_label')}
              placeholder={t('security.sso.client_id_placeholder')}
              value={oidcClientId}
              onChange={(e) => setOidcClientId(e.target.value)}
            />
            <Input
              label={t('security.sso.client_secret_label')}
              type="password"
              placeholder={t('security.sso.client_secret_placeholder')}
              value={oidcClientSecret}
              onChange={(e) => setOidcClientSecret(e.target.value)}
            />
            <Input
              label={t('security.sso.discovery_url_label')}
              placeholder={t('security.sso.discovery_url_placeholder')}
              value={oidcDiscoveryUrl}
              onChange={(e) => setOidcDiscoveryUrl(e.target.value)}
            />
          </>
        )}

        {saveError && (
          <div className="flex items-center gap-2 text-sm text-error">
            <X className="w-4 h-4 shrink-0" />
            <span>{saveError}</span>
          </div>
        )}

        {saveSuccess && (
          <div className="flex items-center gap-2 text-sm text-success">
            <Check className="w-4 h-4 shrink-0" />
            <span>{t('security.sso.save_success')}</span>
          </div>
        )}

        <Button
          variant="primary"
          size="sm"
          onClick={handleSaveConfig}
          loading={saving}
          icon={<Check className="w-3.5 h-3.5" />}
        >
          {t('security.sso.save_config')}
        </Button>
      </div>

      {/* Domain verification */}
      <div className="p-5 rounded-xl border border-default bg-background-elevated space-y-4 bg-noise">
        <h3 className="text-sm font-semibold text-foreground">{t('security.sso.domain_title')}</h3>
        <p className="text-xs text-muted">{t('security.sso.domain_description')}</p>
        <div className="flex gap-3">
          <div className="flex-1">
            <Input
              placeholder={t('security.sso.domain_placeholder')}
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              error={domainError}
            />
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleClaimDomain}
            loading={domainLoading}
            disabled={!domain.trim()}
            className="self-start mt-px"
          >
            {t('security.sso.claim_domain')}
          </Button>
        </div>

        {domainStatus && (
          <div className="flex items-center gap-3 p-3 rounded-lg bg-background-muted border border-default">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground">{domainStatus.domain}</p>
              {domainStatus.verifiedAt && (
                <p className="text-xs text-muted">
                  {t('security.sso.verified_on', {
                    date: new Date(domainStatus.verifiedAt).toLocaleDateString(),
                  })}
                </p>
              )}
            </div>
            <Badge variant={domainStatus.verified ? 'success' : 'warning'} dot>
              {domainStatus.verified ? t('security.sso.verified') : t('security.sso.pending')}
            </Badge>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Audit Logs Tab
// ---------------------------------------------------------------------------

function AuditLogsTab() {
  const t = useTranslations('admin');
  const navigate = useNavigationStore((s) => s.navigate);

  return (
    <div className="rounded-xl border border-default bg-background-subtle p-5 space-y-4">
      <div>
        <h3 className="text-base font-semibold text-foreground">
          {t('security.audit.workspace_cta_title')}
        </h3>
        <p className="mt-1 text-sm text-muted">{t('security.audit.workspace_cta_description')}</p>
      </div>
      <Button
        variant="secondary"
        size="sm"
        icon={<FileText className="w-4 h-4" />}
        onClick={() => navigate('/admin/audit-logs')}
      >
        {t('security.audit.open_workspace_audit')}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SecurityPage (exported)
// ---------------------------------------------------------------------------

export function SecurityPage() {
  const t = useTranslations('admin');
  const [activeTab, setActiveTab] = useState('mfa');

  const tabs = [
    { id: 'mfa', label: t('security.tabs.mfa'), icon: <Shield className="w-4 h-4" /> },
    { id: 'sso', label: t('security.tabs.sso'), icon: <Lock className="w-4 h-4" /> },
    { id: 'audit', label: t('security.tabs.audit'), icon: <FileText className="w-4 h-4" /> },
  ];

  return (
    <div className="h-full overflow-y-auto bg-noise">
      <div className="max-w-4xl mx-auto px-6 py-8">
        <PageHeader title={t('security.title')} description={t('security.description')} />

        <div className="mt-6">
          <Tabs
            tabs={tabs}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            layoutId="security-tabs"
          />
        </div>

        <div className="mt-6">
          {activeTab === 'mfa' && <MfaTab />}
          {activeTab === 'sso' && <SsoTab />}
          {activeTab === 'audit' && <AuditLogsTab />}
        </div>
      </div>
    </div>
  );
}
