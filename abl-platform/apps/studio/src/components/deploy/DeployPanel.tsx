/**
 * Deploy Panel - Configure and deploy agent widgets
 *
 * Provides UI for:
 * - Creating and managing public API keys
 * - Configuring widget settings (mode, position, theme)
 * - Generating embed code
 */

'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Code,
  Key,
  Copy,
  Check,
  RefreshCw,
  Trash2,
  Plus,
  Settings,
  Mic,
  MessageSquare,
  Globe,
  Lock,
  ExternalLink,
  Eye,
  EyeOff,
  AlertCircle,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAuthStore } from '../../store/auth-store';
import { sanitizeError } from '../../lib/sanitize-error';
import { Checkbox } from '../ui/Checkbox';
import { Select } from '../ui/Select';
import { Toggle } from '../ui/Toggle';

// =============================================================================
// TYPES
// =============================================================================

interface PublicApiKey {
  id: string;
  keyPrefix: string;
  name: string;
  allowedOrigins: string[] | null;
  permissions: { chat: boolean; voice: boolean };
  isActive: boolean;
  lastUsedAt: string | null;
  createdAt: string;
  expiresAt: string | null;
}

interface WidgetConfig {
  channelId?: string | null;
  channelName?: string | null;
  mode: 'chat' | 'voice' | 'unified';
  position: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  welcomeMessage?: string | null;
  placeholderText?: string | null;
  voiceEnabled: boolean;
  chatEnabled: boolean;
  showActivityUpdates: boolean;
  theme: Record<string, string>;
}

interface DeployPanelProps {
  projectId: string;
  projectName: string;
}

interface WidgetConfigResponse extends WidgetConfig {
  channelId: string | null;
}

interface RuntimeSdkChannelSummary {
  id: string;
  name: string;
  isActive?: boolean;
}

function filterActivePublicApiKeys(keys: PublicApiKey[]): PublicApiKey[] {
  return keys.filter((key) => key.isActive);
}

// =============================================================================
// DEPLOY PANEL COMPONENT
// =============================================================================

export function DeployPanel({ projectId, projectName }: DeployPanelProps) {
  const t = useTranslations('deploy.panel');
  const accessToken = useAuthStore((s) => s.accessToken);
  const [activeTab, setActiveTab] = useState<'embed' | 'keys' | 'settings'>('embed');
  const [keys, setKeys] = useState<PublicApiKey[]>([]);
  const [embedCode, setEmbedCode] = useState<string>('');
  const [embedError, setEmbedError] = useState<string | null>(null);
  const [config, setConfig] = useState<WidgetConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showCreateKey, setShowCreateKey] = useState(false);
  const [newKeyData, setNewKeyData] = useState<{ key: string; name: string } | null>(null);

  const tabs = useMemo(
    () => [
      { id: 'embed', label: t('tab_embed'), icon: Code },
      { id: 'keys', label: t('tab_keys'), icon: Key },
      { id: 'settings', label: t('tab_settings'), icon: Settings },
    ],
    [t],
  );

  // Fetch keys and embed code
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    setEmbedError(null);

    try {
      const headers = { Authorization: `Bearer ${accessToken}` };

      const [keysRes, widgetRes, embedRes] = await Promise.all([
        fetch(`/api/sdk/keys?projectId=${projectId}`, { headers }),
        fetch(`/api/sdk/widget/${projectId}`, { headers }),
        fetch(`/api/sdk/embed/${projectId}`, { headers }),
      ]);

      if (keysRes.ok) {
        const data = (await keysRes.json()) as { keys?: PublicApiKey[] };
        setKeys(filterActivePublicApiKeys(data.keys ?? []));
      }

      if (!widgetRes.ok) {
        throw new Error(t('load_widget_error'));
      }

      const widgetData = (await widgetRes.json()) as WidgetConfigResponse;
      setConfig(widgetData);

      if (embedRes.ok) {
        const data = await embedRes.json();
        setEmbedCode(data.snippet || '');
      } else {
        const embedPayload = (await embedRes.json().catch(() => null)) as { error?: string } | null;
        setEmbedCode('');
        setEmbedError(embedPayload?.error || t('fetch_embed_error'));
      }
    } catch (err) {
      setError(sanitizeError(err, t('load_widget_error')));
    } finally {
      setLoading(false);
    }
  }, [projectId, accessToken, t]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Copy to clipboard
  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <div className="bg-background rounded-2xl border border-default overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-default bg-gradient-surface-accent">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-accent-subtle rounded-lg">
            <Code className="w-5 h-5 text-accent" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
            <p className="text-sm text-muted">{t('subtitle', { projectName })}</p>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-default">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as typeof activeTab)}
            className={`flex items-center gap-2 px-5 py-3 text-sm font-medium transition-all ${
              activeTab === tab.id
                ? 'text-accent border-b-2 border-accent bg-accent/5'
                : 'text-muted hover:text-foreground hover:bg-background-muted'
            }`}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="p-6">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <RefreshCw className="w-6 h-6 text-accent animate-spin" />
          </div>
        ) : error ? (
          <div className="flex items-center gap-3 p-4 bg-error-subtle border border-error rounded-xl">
            <AlertCircle className="w-5 h-5 text-error" />
            <span className="text-error">{error}</span>
          </div>
        ) : (
          <>
            {activeTab === 'embed' && (
              <EmbedCodeTab
                embedCode={embedCode}
                embedError={embedError}
                config={config}
                keys={keys}
                projectId={projectId}
                onCopy={copyToClipboard}
                copied={copied}
                onCreateKey={() => setShowCreateKey(true)}
              />
            )}
            {activeTab === 'keys' && (
              <ApiKeysTab
                keys={keys}
                projectId={projectId}
                onRefresh={fetchData}
                onCopy={copyToClipboard}
                copied={copied}
                showCreateModal={showCreateKey}
                onShowCreateModal={setShowCreateKey}
                newKeyData={newKeyData}
                onNewKeyData={setNewKeyData}
              />
            )}
            {activeTab === 'settings' && (
              <SettingsTab config={config} projectId={projectId} onRefresh={fetchData} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// EMBED CODE TAB
// =============================================================================

interface EmbedCodeTabProps {
  embedCode: string;
  embedError: string | null;
  config: WidgetConfig | null;
  keys: PublicApiKey[];
  projectId: string;
  onCopy: (text: string) => void;
  copied: boolean;
  onCreateKey: () => void;
}

interface PublicKeyGuidanceCardProps {
  title: string;
  description: string;
  browserTitle: string;
  browserDescription: string;
  serverTitle: string;
  serverDescription: string;
  securityTitle: string;
  securityItems: string[];
}

function PublicKeyGuidanceCard({
  title,
  description,
  browserTitle,
  browserDescription,
  serverTitle,
  serverDescription,
  securityTitle,
  securityItems,
}: PublicKeyGuidanceCardProps) {
  return (
    <div className="rounded-xl border border-default bg-background-muted p-4">
      <div className="flex items-start gap-3">
        <div className="p-2 rounded-lg bg-accent-subtle">
          <Globe className="w-4 h-4 text-accent" />
        </div>
        <div>
          <h4 className="text-sm font-medium text-foreground">{title}</h4>
          <p className="text-xs text-muted mt-1">{description}</p>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 mt-4">
        <div className="rounded-lg border border-default bg-background p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-subtle">{browserTitle}</p>
          <p className="text-xs text-muted mt-1">{browserDescription}</p>
        </div>
        <div className="rounded-lg border border-default bg-background p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-subtle">{serverTitle}</p>
          <p className="text-xs text-muted mt-1">{serverDescription}</p>
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-warning/30 bg-warning-subtle p-3">
        <div className="flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-warning">
              {securityTitle}
            </p>
            <ul className="list-disc pl-4 mt-2 space-y-1 text-xs text-warning">
              {securityItems.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

function EmbedCodeTab({
  embedCode,
  embedError,
  config,
  keys,
  projectId,
  onCopy,
  copied,
  onCreateKey,
}: EmbedCodeTabProps) {
  const t = useTranslations('deploy.embed_tab');
  const accessToken = useAuthStore((s) => s.accessToken);
  const hasActiveKey = keys.some((k) => k.isActive);
  const [previewCopied, setPreviewCopied] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareExpiry, setShareExpiry] = useState<string | null>(null);
  const [generatingLink, setGeneratingLink] = useState(false);

  // Voice preview state
  const [livekitAvailable, setLivekitAvailable] = useState<boolean | null>(null);
  const [voiceShareUrl, setVoiceShareUrl] = useState<string | null>(null);
  const [voiceShareExpiry, setVoiceShareExpiry] = useState<string | null>(null);
  const [generatingVoiceLink, setGeneratingVoiceLink] = useState(false);
  const [voicePreviewCopied, setVoicePreviewCopied] = useState(false);

  const generateSecureLink = async () => {
    setGeneratingLink(true);
    try {
      const response = await fetch('/api/sdk/share', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          projectId,
          expiresIn: 7 * 24 * 60 * 60 * 1000, // 7 days
        }),
      });

      if (response.ok) {
        const data = await response.json();
        setShareUrl(data.shareUrl);
        setShareExpiry(data.expiresAt);
      } else {
        console.error('Failed to generate share link');
      }
    } catch (err) {
      console.error('Failed to generate share link:', err);
    } finally {
      setGeneratingLink(false);
    }
  };

  // Check LiveKit capabilities on mount
  useEffect(() => {
    fetch('/api/livekit/capabilities', {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setLivekitAvailable(data?.configured ?? false))
      .catch(() => setLivekitAvailable(false));
  }, [accessToken]);

  const generateVoiceShareLink = async () => {
    setGeneratingVoiceLink(true);
    try {
      const response = await fetch('/api/sdk/share', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          projectId,
          expiresIn: 7 * 24 * 60 * 60 * 1000, // 7 days
        }),
      });

      if (response.ok) {
        const data = await response.json();
        const url = new URL(data.shareUrl);
        url.pathname = '/preview-livekit';
        setVoiceShareUrl(url.toString());
        setVoiceShareExpiry(data.expiresAt);
      }
    } catch (err) {
      console.error('Failed to generate voice share link:', err);
    } finally {
      setGeneratingVoiceLink(false);
    }
  };

  const copyVoicePreviewLink = async () => {
    if (!voiceShareUrl) return;
    try {
      await navigator.clipboard.writeText(voiceShareUrl);
      setVoicePreviewCopied(true);
      setTimeout(() => setVoicePreviewCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const copyPreviewLink = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setPreviewCopied(true);
      setTimeout(() => setPreviewCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  if (!hasActiveKey) {
    return (
      <div className="text-center py-8">
        <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-warning-subtle flex items-center justify-center">
          <Key className="w-8 h-8 text-warning" />
        </div>
        <h3 className="text-lg font-medium text-foreground mb-2">{t('no_key_title')}</h3>
        <p className="text-muted text-sm mb-6">{t('no_key_description')}</p>
        <button
          onClick={onCreateKey}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-accent text-accent-foreground text-sm font-medium rounded-xl hover:bg-accent/90 transition-all"
        >
          <Plus className="w-4 h-4" />
          {t('create_api_key')}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Quick info */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="p-4 bg-background-muted rounded-xl">
          <div className="flex items-center gap-2 text-muted text-xs mb-1">
            <MessageSquare className="w-3 h-3" />
            {t('chat_label')}
          </div>
          <span
            className={`text-sm font-medium ${config?.chatEnabled ? 'text-success' : 'text-subtle'}`}
          >
            {config?.chatEnabled ? t('enabled') : t('disabled')}
          </span>
        </div>
        <div className="p-4 bg-background-muted rounded-xl">
          <div className="flex items-center gap-2 text-muted text-xs mb-1">
            <Mic className="w-3 h-3" />
            {t('voice_label')}
          </div>
          <span
            className={`text-sm font-medium ${config?.voiceEnabled ? 'text-success' : 'text-subtle'}`}
          >
            {config?.voiceEnabled ? t('enabled') : t('disabled')}
          </span>
        </div>
        <div className="p-4 bg-background-muted rounded-xl">
          <div className="flex items-center gap-2 text-muted text-xs mb-1">{t('mode_label')}</div>
          <span className="text-sm font-medium text-foreground capitalize">
            {config?.mode || t('mode_chat')}
          </span>
        </div>
        <div className="p-4 bg-background-muted rounded-xl">
          <div className="flex items-center gap-2 text-muted text-xs mb-1">
            {t('position_label')}
          </div>
          <span className="text-sm font-medium text-foreground capitalize">
            {config?.position?.replace('-', ' ') || t('position_bottom_right')}
          </span>
        </div>
      </div>

      {/* Embed code */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-foreground">{t('embed_code_title')}</h3>
          <button
            onClick={() => onCopy(embedCode)}
            disabled={!embedCode}
            className="flex items-center gap-2 px-3 py-1.5 bg-background-subtle text-muted text-xs font-medium rounded-lg hover:bg-background-muted transition-all disabled:opacity-50"
          >
            {copied ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
            {copied ? t('copied') : t('copy')}
          </button>
        </div>
        {embedError ? (
          <div className="p-4 bg-warning-subtle border border-warning rounded-xl">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-4 h-4 text-warning mt-0.5" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-warning">{embedError}</p>
                <p className="text-xs text-muted">{t('embed_channel_binding_help')}</p>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="relative">
              <pre className="p-4 bg-background border border-default rounded-xl overflow-x-auto text-sm text-muted font-mono">
                <code>{embedCode}</code>
              </pre>
            </div>
            <p className="text-xs text-subtle mt-2">{t('replace_key_hint')}</p>
          </>
        )}
      </div>

      {/* Instructions */}
      <div className="p-4 bg-accent-subtle border border-accent/30 rounded-xl">
        <h4 className="text-sm font-medium text-accent mb-2">{t('quick_start_title')}</h4>
        <ol className="space-y-1 text-sm text-muted">
          <li>{t('quick_start_step1')}</li>
          <li>{t('quick_start_step2')}</li>
          <li>
            {t('quick_start_step3_prefix')} <code className="text-muted">&lt;/body&gt;</code>{' '}
            {t('quick_start_step3_suffix')}
          </li>
          <li>{t('quick_start_step4')}</li>
        </ol>
      </div>

      <PublicKeyGuidanceCard
        title={t('auth_model_title')}
        description={t('auth_model_description')}
        browserTitle={t('browser_storage_title')}
        browserDescription={t('browser_storage_description')}
        serverTitle={t('server_storage_title')}
        serverDescription={t('server_storage_description')}
        securityTitle={t('security_title')}
        securityItems={[t('security_public'), t('security_identity'), t('security_origins')]}
      />

      {/* Secure Preview Link */}
      <div className="p-4 bg-purple-subtle border border-purple rounded-xl">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Lock className="w-4 h-4 text-purple" />
            <h4 className="text-sm font-medium text-purple">{t('secure_preview_title')}</h4>
          </div>
          {!shareUrl ? (
            <button
              onClick={generateSecureLink}
              disabled={generatingLink}
              className="flex items-center gap-2 px-3 py-1.5 bg-purple text-purple-foreground text-xs font-medium rounded-lg hover:bg-purple/80 transition-all disabled:opacity-50"
            >
              {generatingLink ? (
                <RefreshCw className="w-3 h-3 animate-spin" />
              ) : (
                <Plus className="w-3 h-3" />
              )}
              {generatingLink ? t('generating') : t('generate_link')}
            </button>
          ) : (
            <button
              onClick={copyPreviewLink}
              className="flex items-center gap-2 px-3 py-1.5 bg-purple/20 text-purple text-xs font-medium rounded-lg hover:bg-purple/30 transition-all"
            >
              {previewCopied ? (
                <Check className="w-3 h-3 text-success" />
              ) : (
                <Copy className="w-3 h-3" />
              )}
              {previewCopied ? t('copied') : t('copy_link')}
            </button>
          )}
        </div>

        {!shareUrl ? (
          <p className="text-xs text-muted">{t('preview_description')}</p>
        ) : (
          <>
            <p className="text-xs text-muted mb-2">
              {t('preview_expires', { date: new Date(shareExpiry!).toLocaleDateString() })}
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 px-3 py-2 bg-background border border-default rounded-lg text-sm text-purple font-mono truncate">
                {shareUrl}
              </code>
              <a
                href={shareUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="p-2 bg-background-subtle text-muted rounded-lg hover:bg-background-muted transition-all"
                title={t('secure_preview_title')}
              >
                <ExternalLink className="w-4 h-4" />
              </a>
            </div>
            <button
              onClick={generateSecureLink}
              className="mt-2 text-xs text-purple hover:text-purple transition-colors"
            >
              {t('generate_new_link')}
            </button>
          </>
        )}
      </div>

      {/* Voice Preview (LiveKit) */}
      {livekitAvailable === false ? (
        <div className="p-4 bg-background-muted/50 border border-default/50 rounded-xl">
          <div className="flex items-center gap-2 mb-2">
            <Mic className="w-4 h-4 text-subtle" />
            <h4 className="text-sm font-medium text-subtle">{t('voice_preview_title')}</h4>
          </div>
          <p className="text-xs text-subtle">{t('livekit_not_configured')}</p>
        </div>
      ) : livekitAvailable ? (
        <div className="p-4 bg-gradient-status-success border border-success rounded-xl">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Mic className="w-4 h-4 text-success" />
              <h4 className="text-sm font-medium text-success">{t('voice_preview_title')}</h4>
            </div>
            {!voiceShareUrl ? (
              <button
                onClick={generateVoiceShareLink}
                disabled={generatingVoiceLink}
                className="flex items-center gap-2 px-3 py-1.5 bg-success text-success-foreground text-xs font-medium rounded-lg hover:bg-success-muted transition-all disabled:opacity-50"
              >
                {generatingVoiceLink ? (
                  <RefreshCw className="w-3 h-3 animate-spin" />
                ) : (
                  <Plus className="w-3 h-3" />
                )}
                {generatingVoiceLink ? t('generating') : t('generate_link')}
              </button>
            ) : (
              <button
                onClick={copyVoicePreviewLink}
                className="flex items-center gap-2 px-3 py-1.5 bg-success-subtle text-success text-xs font-medium rounded-lg hover:bg-success-muted transition-all"
              >
                {voicePreviewCopied ? (
                  <Check className="w-3 h-3 text-success" />
                ) : (
                  <Copy className="w-3 h-3" />
                )}
                {voicePreviewCopied ? t('copied') : t('copy_link')}
              </button>
            )}
          </div>

          {!voiceShareUrl ? (
            <p className="text-xs text-muted">{t('voice_preview_description')}</p>
          ) : (
            <>
              <p className="text-xs text-muted mb-2">
                {t('voice_preview_expires', {
                  date: new Date(voiceShareExpiry!).toLocaleDateString(),
                })}
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 px-3 py-2 bg-background border border-default rounded-lg text-sm text-success font-mono truncate">
                  {voiceShareUrl}
                </code>
                <a
                  href={voiceShareUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="p-2 bg-background-subtle text-muted rounded-lg hover:bg-background-muted transition-all"
                  title={t('voice_preview_title')}
                >
                  <ExternalLink className="w-4 h-4" />
                </a>
              </div>
              <button
                onClick={generateVoiceShareLink}
                className="mt-2 text-xs text-success hover:text-success transition-colors"
              >
                {t('generate_new_link')}
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

// =============================================================================
// API KEYS TAB
// =============================================================================

interface ApiKeysTabProps {
  keys: PublicApiKey[];
  projectId: string;
  onRefresh: () => void;
  onCopy: (text: string) => void;
  copied: boolean;
  showCreateModal: boolean;
  onShowCreateModal: (show: boolean) => void;
  newKeyData: { key: string; name: string } | null;
  onNewKeyData: (data: { key: string; name: string } | null) => void;
}

function ApiKeysTab({
  keys,
  projectId,
  onRefresh,
  onCopy,
  copied,
  showCreateModal,
  onShowCreateModal,
  newKeyData,
  onNewKeyData,
}: ApiKeysTabProps) {
  const t = useTranslations('deploy.keys_tab');
  const accessToken = useAuthStore((s) => s.accessToken);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [showKey, setShowKey] = useState<string | null>(null);

  const handleDelete = async (keyId: string) => {
    if (!confirm(t('delete_confirm'))) {
      return;
    }

    setDeleting(keyId);
    try {
      await fetch(`/api/sdk/keys/${keyId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      onRefresh();
    } catch (err) {
      console.error('Failed to delete key:', err);
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="space-y-6">
      <PublicKeyGuidanceCard
        title={t('public_key_setup_title')}
        description={t('public_key_setup_description')}
        browserTitle={t('browser_storage_title')}
        browserDescription={t('browser_storage_description')}
        serverTitle={t('server_storage_title')}
        serverDescription={t('server_storage_description')}
        securityTitle={t('security_title')}
        securityItems={[t('security_public'), t('security_identity'), t('security_origins')]}
      />

      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">{t('key_count', { count: keys.length })}</p>
        <button
          onClick={() => onShowCreateModal(true)}
          className="flex items-center gap-2 px-4 py-2 bg-accent text-accent-foreground text-sm font-medium rounded-xl hover:bg-accent/90 transition-all"
        >
          <Plus className="w-4 h-4" />
          {t('new_key')}
        </button>
      </div>

      {/* New key notification */}
      {newKeyData && (
        <div className="p-4 bg-gradient-status-success border border-success rounded-xl">
          <div className="flex items-start gap-3">
            <Check className="w-5 h-5 text-success mt-0.5" />
            <div className="flex-1">
              <h4 className="text-sm font-medium text-success mb-1">
                {t('key_created_title', { name: newKeyData.name })}
              </h4>
              <p className="text-xs text-muted mb-3">{t('key_created_warning')}</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 px-3 py-2 bg-background border border-default rounded-lg text-sm text-warning font-mono">
                  {newKeyData.key}
                </code>
                <button
                  onClick={() => {
                    onCopy(newKeyData.key);
                    setTimeout(() => onNewKeyData(null), 2000);
                  }}
                  className="px-3 py-2 bg-background-subtle text-foreground text-sm rounded-lg hover:bg-background-muted transition-all"
                >
                  {copied ? (
                    <Check className="w-4 h-4 text-success" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Keys list */}
      {keys.length === 0 ? (
        <div className="text-center py-8">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-background-subtle flex items-center justify-center">
            <Key className="w-8 h-8 text-subtle" />
          </div>
          <h3 className="text-lg font-medium text-muted mb-2">{t('no_keys_title')}</h3>
          <p className="text-subtle text-sm">{t('no_keys_description')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {keys.map((key) => (
            <div
              key={key.id}
              className="p-4 bg-background-muted border border-default rounded-xl hover:border-default transition-all"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div
                    className={`p-2 rounded-lg ${key.isActive ? 'bg-success-subtle' : 'bg-background-elevated'}`}
                  >
                    <Key className={`w-4 h-4 ${key.isActive ? 'text-success' : 'text-subtle'}`} />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{key.name}</span>
                      {!key.isActive && (
                        <span className="text-xs px-2 py-0.5 bg-error-subtle text-error rounded-md">
                          {t('inactive')}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-xs text-subtle">
                      <span className="font-mono">{key.keyPrefix}...</span>
                      <span>
                        {t('created_date', { date: new Date(key.createdAt).toLocaleDateString() })}
                      </span>
                      {key.lastUsedAt && (
                        <span>
                          {t('last_used_date', {
                            date: new Date(key.lastUsedAt).toLocaleDateString(),
                          })}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {/* Permissions */}
                  <div className="flex items-center gap-1">
                    {key.permissions.chat && (
                      <span
                        className="p-1.5 bg-background-elevated rounded-md"
                        title={t('chat_label')}
                      >
                        <MessageSquare className="w-3 h-3 text-muted" />
                      </span>
                    )}
                    {key.permissions.voice && (
                      <span
                        className="p-1.5 bg-background-elevated rounded-md"
                        title={t('voice_label')}
                      >
                        <Mic className="w-3 h-3 text-muted" />
                      </span>
                    )}
                    {key.allowedOrigins && key.allowedOrigins.length > 0 && (
                      <span
                        className="p-1.5 bg-background-elevated rounded-md"
                        title={t('origins_title', { origins: key.allowedOrigins.join(', ') })}
                      >
                        <Lock className="w-3 h-3 text-muted" />
                      </span>
                    )}
                  </div>

                  <button
                    onClick={() => handleDelete(key.id)}
                    disabled={deleting === key.id}
                    className="p-2 text-subtle hover:text-error hover:bg-error-subtle rounded-lg transition-all"
                    title={t('delete_key')}
                  >
                    {deleting === key.id ? (
                      <RefreshCw className="w-4 h-4 animate-spin" />
                    ) : (
                      <Trash2 className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create key modal */}
      {showCreateModal && (
        <CreateKeyModal
          projectId={projectId}
          onClose={() => onShowCreateModal(false)}
          onCreated={(key, name) => {
            onNewKeyData({ key, name });
            onShowCreateModal(false);
            onRefresh();
          }}
        />
      )}
    </div>
  );
}

// =============================================================================
// CREATE KEY MODAL
// =============================================================================

interface CreateKeyModalProps {
  projectId: string;
  onClose: () => void;
  onCreated: (key: string, name: string) => void;
}

function CreateKeyModal({ projectId, onClose, onCreated }: CreateKeyModalProps) {
  const t = useTranslations('deploy.create_key_modal');
  const accessToken = useAuthStore((s) => s.accessToken);
  const [name, setName] = useState('');
  const [chatEnabled, setChatEnabled] = useState(true);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [originsText, setOriginsText] = useState('');
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    if (!name.trim()) return;

    setCreating(true);
    try {
      const origins = originsText
        .split('\n')
        .map((o) => o.trim())
        .filter((o) => o);

      const response = await fetch('/api/sdk/keys', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          projectId,
          name: name.trim(),
          permissions: { chat: chatEnabled, voice: voiceEnabled },
          allowedOrigins: origins.length > 0 ? origins : undefined,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        onCreated(data.key, data.name);
      } else {
        const error = await response.json();
        alert(error.error || t('create_failed'));
      }
    } catch (err) {
      console.error('Failed to create key:', err);
      alert(t('create_failed'));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-overlay backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-background border border-default rounded-2xl p-6 w-full max-w-md shadow-2xl">
        <h3 className="text-lg font-semibold text-foreground mb-6">{t('title')}</h3>

        <div className="space-y-4">
          <PublicKeyGuidanceCard
            title={t('security_title')}
            description={t('security_description')}
            browserTitle={t('browser_storage_title')}
            browserDescription={t('browser_storage_description')}
            serverTitle={t('server_storage_title')}
            serverDescription={t('server_storage_description')}
            securityTitle={t('security_warning_title')}
            securityItems={[
              t('security_warning_public'),
              t('security_warning_identity'),
              t('security_warning_origins'),
            ]}
          />

          <div>
            <label className="block text-sm font-medium text-muted mb-2">{t('name_label')}</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('name_placeholder')}
              className="w-full px-4 py-3 bg-background-subtle border border-default rounded-xl text-foreground placeholder-subtle focus:outline-none focus:border-border-focus"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-muted mb-3">
              {t('permissions_label')}
            </label>
            <div className="space-y-2">
              <div className="flex items-center gap-3 p-3 bg-background-subtle rounded-lg">
                <Checkbox
                  checked={chatEnabled}
                  onChange={(checked) => setChatEnabled(checked)}
                  label={t('chat_label')}
                />
              </div>
              <div className="flex items-center gap-3 p-3 bg-background-subtle rounded-lg">
                <Checkbox
                  checked={voiceEnabled}
                  onChange={(checked) => setVoiceEnabled(checked)}
                  label={t('voice_label')}
                />
              </div>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-muted mb-2">
              {t('allowed_origins_label')}{' '}
              <span className="text-subtle font-normal">{t('allowed_origins_optional')}</span>
            </label>
            <textarea
              value={originsText}
              onChange={(e) => setOriginsText(e.target.value)}
              placeholder={t('origins_placeholder')}
              rows={3}
              className="w-full px-4 py-3 bg-background-subtle border border-default rounded-xl text-foreground placeholder-subtle focus:outline-none focus:border-border-focus resize-none font-mono text-sm"
            />
            <p className="text-xs text-subtle mt-1">{t('origins_hint')}</p>
          </div>
        </div>

        <div className="flex gap-3 mt-6">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-3 text-sm font-medium text-muted hover:text-foreground bg-background-subtle hover:bg-background-muted rounded-xl transition-all"
          >
            {t('cancel')}
          </button>
          <button
            onClick={handleCreate}
            disabled={!name.trim() || creating}
            className="flex-1 px-4 py-3 bg-accent hover:bg-accent/90 text-foreground text-sm font-medium rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {creating ? t('creating') : t('create_key')}
          </button>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// SETTINGS TAB
// =============================================================================

interface SettingsTabProps {
  config: WidgetConfig | null;
  projectId: string;
  onRefresh: () => void;
}

function SettingsTab({ config, projectId, onRefresh }: SettingsTabProps) {
  const t = useTranslations('deploy.settings_tab');
  const accessToken = useAuthStore((s) => s.accessToken);
  const [availableChannels, setAvailableChannels] = useState<RuntimeSdkChannelSummary[]>([]);
  const [channelsLoading, setChannelsLoading] = useState(true);
  const [mode, setMode] = useState(config?.mode || 'chat');
  const [position, setPosition] = useState(config?.position || 'bottom-right');
  const [selectedChannelId, setSelectedChannelId] = useState(config?.channelId || '');
  const [chatEnabled, setChatEnabled] = useState(config?.chatEnabled !== false);
  const [voiceEnabled, setVoiceEnabled] = useState(config?.voiceEnabled || false);
  const [welcomeMessage, setWelcomeMessage] = useState(config?.welcomeMessage || '');
  const [placeholderText, setPlaceholderText] = useState(config?.placeholderText || '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const modeOptions = useMemo(
    () => [
      { id: 'chat', label: t('mode_chat_only'), icon: MessageSquare },
      { id: 'voice', label: t('mode_voice_only'), icon: Mic },
      { id: 'unified', label: t('mode_chat_voice'), icon: Globe },
    ],
    [t],
  );

  const positionOptions = useMemo(
    () => [
      { id: 'bottom-right', label: t('position_bottom_right') },
      { id: 'bottom-left', label: t('position_bottom_left') },
      { id: 'top-right', label: t('position_top_right') },
      { id: 'top-left', label: t('position_top_left') },
    ],
    [t],
  );

  useEffect(() => {
    let cancelled = false;

    const loadChannels = async () => {
      setChannelsLoading(true);
      try {
        const response = await fetch(
          `/api/runtime/sdk-channels?projectId=${encodeURIComponent(projectId)}`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
          },
        );

        if (!response.ok) {
          throw new Error(t('load_channels_failed'));
        }

        const data = (await response.json()) as { channels?: RuntimeSdkChannelSummary[] };
        if (cancelled) {
          return;
        }

        setAvailableChannels((data.channels || []).filter((channel) => channel.isActive !== false));
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to load SDK channels for widget settings:', error);
          setAvailableChannels([]);
        }
      } finally {
        if (!cancelled) {
          setChannelsLoading(false);
        }
      }
    };

    void loadChannels();

    return () => {
      cancelled = true;
    };
  }, [accessToken, projectId, t]);

  useEffect(() => {
    if (channelsLoading || !selectedChannelId) {
      return;
    }

    const channelStillAvailable = availableChannels.some(
      (channel) => channel.id === selectedChannelId,
    );
    if (!channelStillAvailable) {
      setSelectedChannelId('');
    }
  }, [availableChannels, channelsLoading, selectedChannelId]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const response = await fetch(`/api/sdk/widget/${projectId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          channelId: selectedChannelId || null,
          mode,
          position,
          chatEnabled,
          voiceEnabled,
          welcomeMessage: welcomeMessage || null,
          placeholderText: placeholderText || null,
        }),
      });

      if (response.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
        onRefresh();
      } else {
        const error = await response.json();
        alert(error.error || t('save_failed'));
      }
    } catch (err) {
      console.error('Failed to save settings:', err);
      alert(t('save_failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Mode */}
      <div>
        <label className="block text-sm font-medium text-muted mb-3">
          {t('widget_mode_label')}
        </label>
        <div className="grid grid-cols-3 gap-3">
          {modeOptions.map((opt) => (
            <button
              key={opt.id}
              onClick={() => setMode(opt.id as typeof mode)}
              className={`flex flex-col items-center gap-2 p-4 rounded-xl border transition-all ${
                mode === opt.id
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-default bg-background-muted text-muted hover:border-default'
              }`}
            >
              <opt.icon className="w-5 h-5" />
              <span className="text-xs font-medium">{opt.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Position */}
      <div>
        <label className="block text-sm font-medium text-muted mb-3">{t('position_label')}</label>
        <div className="grid grid-cols-2 gap-3">
          {positionOptions.map((opt) => (
            <button
              key={opt.id}
              onClick={() => setPosition(opt.id as typeof position)}
              className={`px-4 py-3 rounded-xl border text-sm font-medium transition-all ${
                position === opt.id
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-default bg-background-muted text-muted hover:border-default'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <Select
          label={t('default_channel_label')}
          value={selectedChannelId}
          onChange={setSelectedChannelId}
          disabled={channelsLoading || availableChannels.length === 0}
          placeholder={channelsLoading ? t('loading_channels') : t('default_channel_placeholder')}
          options={[
            { value: '', label: t('default_channel_none') },
            ...availableChannels.map((channel) => ({
              value: channel.id,
              label: channel.name,
            })),
          ]}
        />
        <p className="mt-2 text-xs text-subtle">
          {channelsLoading
            ? t('loading_channels')
            : availableChannels.length === 0
              ? t('no_sdk_channels_help')
              : t('default_channel_help')}
        </p>
      </div>

      {/* Features */}
      <div>
        <label className="block text-sm font-medium text-muted mb-3">{t('features_label')}</label>
        <div className="space-y-2">
          <div className="p-3 bg-background-muted rounded-xl">
            <Toggle
              checked={chatEnabled}
              onChange={(checked) => setChatEnabled(checked)}
              label={t('enable_chat')}
            />
          </div>
          <div className="p-3 bg-background-muted rounded-xl">
            <Toggle
              checked={voiceEnabled}
              onChange={(checked) => setVoiceEnabled(checked)}
              label={t('enable_voice')}
            />
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-muted mb-2">
            {t('welcome_message_label')}
          </label>
          <input
            type="text"
            value={welcomeMessage}
            onChange={(e) => setWelcomeMessage(e.target.value)}
            placeholder={t('welcome_message_placeholder')}
            className="w-full px-4 py-3 bg-background-subtle border border-default rounded-xl text-foreground placeholder-subtle focus:outline-none focus:border-border-focus"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-muted mb-2">
            {t('input_placeholder_label')}
          </label>
          <input
            type="text"
            value={placeholderText}
            onChange={(e) => setPlaceholderText(e.target.value)}
            placeholder={t('input_placeholder_value')}
            className="w-full px-4 py-3 bg-background-subtle border border-default rounded-xl text-foreground placeholder-subtle focus:outline-none focus:border-border-focus"
          />
        </div>
      </div>

      {/* Save button */}
      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 px-5 py-2.5 bg-accent hover:bg-accent/90 text-foreground text-sm font-medium rounded-xl transition-all disabled:opacity-50"
        >
          {saving ? (
            <RefreshCw className="w-4 h-4 animate-spin" />
          ) : saved ? (
            <Check className="w-4 h-4" />
          ) : null}
          {saved ? t('saved') : saving ? t('saving') : t('save_settings')}
        </button>
      </div>
    </div>
  );
}

export default DeployPanel;
