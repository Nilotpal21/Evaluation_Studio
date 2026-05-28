/**
 * PublicApiAccessTab Component
 *
 * Project Settings tab for configuring Public API Access (end-user auth).
 * Manages the `publicApiAccess.scopes['search.query']` configuration:
 * - Toggle enable/disable
 * - Auth Profile selection (OIDC-compatible only: oauth2_app, azure_ad)
 * - Allowed Domains (comma-separated tags)
 * - Allowed Origins (comma-separated tags)
 * - Session Token TTL
 * - Rate Limits (per-user, per-project)
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Globe, Loader2, Check, Shield, Clock, Users } from 'lucide-react';
import { Toggle } from '../ui/Toggle';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Section } from '../ui/Section';
import { toast } from 'sonner';
import { useNavigationStore } from '../../store/navigation-store';
import { useAuthProfiles } from '../../hooks/useAuthProfiles';
import { apiFetch } from '../../lib/api-client';

// ─── Types ──────────────────────────────────────────────────────────────

interface PublicApiAccessScopeConfig {
  enabled: boolean;
  authProfileIds: string[];
  allowedDomains: string[];
  allowedOrigins: string[];
  allowedRedirectUris: string[];
  sessionTokenTtlSeconds: number;
  rateLimits: {
    perUserPerMinute: number;
    perProjectPerMinute: number;
  };
}

interface PublicApiAccessSettings {
  scopes: {
    'search.query'?: PublicApiAccessScopeConfig;
  };
}

const DEFAULT_CONFIG: PublicApiAccessScopeConfig = {
  enabled: false,
  authProfileIds: [],
  allowedDomains: [],
  allowedOrigins: [],
  allowedRedirectUris: [],
  sessionTokenTtlSeconds: 900,
  rateLimits: {
    perUserPerMinute: 60,
    perProjectPerMinute: 1000,
  },
};

// ─── Component ──────────────────────────────────────────────────────────

export function PublicApiAccessTab() {
  const t = useTranslations('settings');
  const { projectId } = useNavigationStore();

  const [config, setConfig] = useState<PublicApiAccessScopeConfig>(DEFAULT_CONFIG);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [domainsInput, setDomainsInput] = useState('');
  const [originsInput, setOriginsInput] = useState('');
  const [redirectUrisInput, setRedirectUrisInput] = useState('');

  // Fetch OIDC-compatible auth profiles
  const { profiles, isLoading: profilesLoading } = useAuthProfiles(projectId, {
    authType: ['oauth2_app', 'azure_ad'],
    status: 'active',
  });

  // Load existing settings
  const loadSettings = useCallback(async () => {
    if (!projectId) return;
    setIsLoading(true);
    try {
      const res = await apiFetch(`/api/projects/${projectId}/settings`);
      if (res.ok) {
        const data = await res.json();
        // Runtime returns { success, settings: { publicApiAccess } }
        const publicApiAccess = data?.settings?.publicApiAccess ?? data?.publicApiAccess;
        const scopeConfig = publicApiAccess?.scopes?.['search.query'];
        if (scopeConfig) {
          // Backward compat: convert old authProfileId to authProfileIds[]
          const normalized: PublicApiAccessScopeConfig = {
            ...DEFAULT_CONFIG,
            ...scopeConfig,
            authProfileIds:
              scopeConfig.authProfileIds ??
              (scopeConfig.authProfileId ? [scopeConfig.authProfileId] : []),
            allowedRedirectUris: scopeConfig.allowedRedirectUris ?? [],
          };
          setConfig(normalized);
          setDomainsInput(normalized.allowedDomains?.join(', ') ?? '');
          setOriginsInput(normalized.allowedOrigins?.join(', ') ?? '');
          setRedirectUrisInput(normalized.allowedRedirectUris?.join(', ') ?? '');
        }
      }
    } catch (error) {
      toast.error('Failed to load settings');
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  // Save settings
  const handleSave = async () => {
    if (!projectId) return;

    // Parse comma-separated inputs
    const allowedDomains = domainsInput
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
    const allowedOrigins = originsInput
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
    const allowedRedirectUris = redirectUrisInput
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean);

    const updatedConfig: PublicApiAccessScopeConfig = {
      ...config,
      allowedDomains,
      allowedOrigins,
      allowedRedirectUris,
    };

    const publicApiAccess: PublicApiAccessSettings = {
      scopes: {
        'search.query': updatedConfig,
      },
    };

    setIsSaving(true);
    try {
      const res = await apiFetch(`/api/projects/${projectId}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicApiAccess }),
      });

      if (res.ok) {
        toast.success('Public API access settings saved');
        setConfig(updatedConfig);
      } else {
        const err = await res.json();
        toast.error(err.error?.message ?? 'Failed to save settings');
      }
    } catch (error) {
      toast.error('Failed to save settings');
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Section
        title="Public API Access"
        description="Configure which APIs are accessible to end-users authenticating via their organization's identity provider (Azure AD, Okta, Google)."
        icon={<Globe className="h-5 w-5" />}
      >
        <Section
          title="Query API"
          icon={<Shield className="h-4 w-4" />}
          actions={
            <Toggle
              checked={config.enabled}
              onChange={(enabled) => setConfig((prev) => ({ ...prev, enabled }))}
            />
          }
        >
          {config.enabled && (
            <div className="space-y-4">
              {/* Auth Profile Multi-Select */}
              <Card hoverable={false} padding="md" className="space-y-2">
                <label className="block text-sm font-medium">
                  Identity Providers (Auth Profiles)
                </label>
                <div className="space-y-2 max-h-48 overflow-y-auto border border-default rounded-md p-2">
                  {profilesLoading && <p className="text-xs text-muted">Loading...</p>}
                  {profiles.map((p) => (
                    <label
                      key={p.id}
                      className="flex items-center gap-2 p-1.5 rounded hover:bg-background-muted cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={config.authProfileIds.includes(p.id)}
                        onChange={(e) => {
                          setConfig((prev) => ({
                            ...prev,
                            authProfileIds: e.target.checked
                              ? [...prev.authProfileIds, p.id]
                              : prev.authProfileIds.filter((id) => id !== p.id),
                          }));
                        }}
                        className="rounded border-default"
                      />
                      <span className="text-sm">{p.name}</span>
                      <span className="text-xs px-1.5 py-0.5 rounded bg-background-muted text-muted">
                        {p.authType}
                      </span>
                    </label>
                  ))}
                  {!profilesLoading && profiles.length === 0 && (
                    <p className="text-xs text-muted py-2 text-center">
                      No OIDC-compatible profiles found. Create an OAuth2 App or Azure AD profile
                      first.
                    </p>
                  )}
                </div>
                <p className="text-xs text-muted">
                  Select one or more OIDC-compatible profiles. End-users authenticate via their
                  organization&apos;s IdP.
                </p>
              </Card>

              <Card hoverable={false} padding="md" className="space-y-4">
                {/* Allowed Domains */}
                <div>
                  <label className="block text-sm font-medium mb-1">Allowed Email Domains</label>
                  <input
                    type="text"
                    className="w-full rounded-md border border-default bg-background px-3 py-2 text-sm"
                    placeholder="acme.com, contoso.com"
                    value={domainsInput}
                    onChange={(e) => setDomainsInput(e.target.value)}
                  />
                  <p className="mt-1 text-xs text-muted">
                    Comma-separated. Only users with these email domains can authenticate. Leave
                    empty to allow all domains.
                  </p>
                </div>

                {/* Allowed Origins */}
                <div>
                  <label className="block text-sm font-medium mb-1">Allowed Origins (CORS)</label>
                  <input
                    type="text"
                    className="w-full rounded-md border border-default bg-background px-3 py-2 text-sm"
                    placeholder="https://portal.acme.com, https://search.acme.com"
                    value={originsInput}
                    onChange={(e) => setOriginsInput(e.target.value)}
                  />
                  <p className="mt-1 text-xs text-muted">
                    Comma-separated. Browser origins allowed to make API calls.
                  </p>
                </div>

                {/* Allowed Redirect URIs (Path B) */}
                <div>
                  <label className="block text-sm font-medium mb-1">
                    Allowed Redirect URIs (OAuth Flow)
                  </label>
                  <input
                    type="text"
                    className="w-full rounded-md border border-default bg-background px-3 py-2 text-sm"
                    placeholder="https://portal.acme.com/search/callback, https://app.acme.com/auth/callback"
                    value={redirectUrisInput}
                    onChange={(e) => setRedirectUrisInput(e.target.value)}
                  />
                  <p className="mt-1 text-xs text-muted">
                    Comma-separated. Full URIs where OAuth redirect responses can be sent. Exact
                    match only — no wildcards.
                  </p>
                </div>
              </Card>

              {/* Session Token TTL */}
              <Card hoverable={false} padding="md" className="flex items-center gap-4">
                <Clock className="h-4 w-4 text-muted" />
                <div className="flex-1">
                  <label className="block text-sm font-medium mb-1">
                    Session Token TTL (seconds)
                  </label>
                  <input
                    type="number"
                    className="w-32 rounded-md border border-default bg-background px-3 py-2 text-sm"
                    value={config.sessionTokenTtlSeconds}
                    min={60}
                    max={3600}
                    onChange={(e) =>
                      setConfig((prev) => ({
                        ...prev,
                        sessionTokenTtlSeconds: parseInt(e.target.value, 10) || 900,
                      }))
                    }
                  />
                  <p className="mt-1 text-xs text-muted">
                    How long search session tokens are valid (60–3600 seconds, default: 900 = 15
                    min).
                  </p>
                </div>
              </Card>

              {/* Rate Limits */}
              <Card hoverable={false} padding="md" className="space-y-2">
                <div className="flex items-center gap-2">
                  <Users className="h-4 w-4 text-muted" />
                  <span className="text-sm font-medium">Rate Limits</span>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs text-muted mb-1">Per User (req/min)</label>
                    <input
                      type="number"
                      className="w-full rounded-md border border-default bg-background px-3 py-2 text-sm"
                      value={config.rateLimits.perUserPerMinute}
                      min={1}
                      max={1000}
                      onChange={(e) =>
                        setConfig((prev) => ({
                          ...prev,
                          rateLimits: {
                            ...prev.rateLimits,
                            perUserPerMinute: parseInt(e.target.value, 10) || 60,
                          },
                        }))
                      }
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-muted mb-1">Per Project (req/min)</label>
                    <input
                      type="number"
                      className="w-full rounded-md border border-default bg-background px-3 py-2 text-sm"
                      value={config.rateLimits.perProjectPerMinute}
                      min={1}
                      max={100000}
                      onChange={(e) =>
                        setConfig((prev) => ({
                          ...prev,
                          rateLimits: {
                            ...prev.rateLimits,
                            perProjectPerMinute: parseInt(e.target.value, 10) || 1000,
                          },
                        }))
                      }
                    />
                  </div>
                </div>
              </Card>

              {/* Save — scoped to Query API */}
              <div className="pt-3 border-t border-default flex justify-end">
                <Button onClick={handleSave} disabled={isSaving} size="sm">
                  {isSaving ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Check className="mr-2 h-4 w-4" />
                  )}
                  Save Query API Settings
                </Button>
              </div>
            </div>
          )}
        </Section>
      </Section>
    </div>
  );
}
