/**
 * TestingTab — send test messages, preview widget, verify delivery.
 *
 * Strategy pattern: different testing UI per channel source type.
 * SDK Web channels get: secure preview links (chat + voice) + embed code.
 */

'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
  Send,
  ExternalLink,
  Lock,
  Plus,
  Copy,
  Check,
  Mic,
  Loader2,
  AlertTriangle,
} from 'lucide-react';
import { toast } from 'sonner';
import { Input } from '../../../ui/Input';
import { Button } from '../../../ui/Button';
import { EmptyState } from '../../../ui/EmptyState';
import { CodeBlock } from '../../../ui/CodeBlock';
import { sendTestMessage } from '../../../../api/http-async-channels';
import { apiFetch } from '../../../../lib/api-client';
import { fetchSdkEmbedCode, SDK_EMBED_FETCH_ERROR } from '../../../../lib/sdk-embed';
import { useAuthStore } from '../../../../store/auth-store';
import { useNavigationStore } from '../../../../store/navigation-store';
import { sanitizeError } from '../../../../lib/sanitize-error';
import type { ChannelTabProps, ChannelTypeDef, ChannelInstance } from '../types';

// =============================================================================
// CONSTANTS
// =============================================================================

const DEFAULT_TEST_MESSAGE = 'Hello from Studio!';
const SHARE_LINK_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SHARE_LINK_STORAGE_PREFIX = 'studio:sdk-share-link';

// =============================================================================
// HELPERS
// =============================================================================

function parseSDKConfig(config: Record<string, unknown> | undefined | null) {
  const c = config || {};
  return {
    voiceEnabled: !!c.voiceEnabled,
    mode: (c.mode as string) || 'chat',
    voicePipeline: (c.voicePipeline as string) || 'pipeline',
    asrVendor: (c.asrVendor as string) || 'deepgram',
    asrServiceInstanceId: c.asrServiceInstanceId as string | undefined,
    ttsVendor: (c.ttsVendor as string) || 'elevenlabs',
    ttsServiceInstanceId: c.ttsServiceInstanceId as string | undefined,
  };
}

async function copyText(text: string, onCopied: (v: boolean) => void) {
  try {
    await navigator.clipboard.writeText(text);
    onCopied(true);
    setTimeout(() => onCopied(false), 2000);
  } catch (err) {
    console.warn('[TestingTab] Clipboard write failed:', err);
  }
}

interface StoredShareLink {
  url: string;
  expiresAt: string;
}

function buildShareLinkStorageKey(projectId: string, channelId: string, mode: 'chat' | 'voice') {
  return `${SHARE_LINK_STORAGE_PREFIX}:${projectId}:${channelId}:${mode}`;
}

function readStoredShareLink(key: string): StoredShareLink | null {
  if (typeof window === 'undefined') return null;

  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredShareLink>;
    if (typeof parsed.url !== 'string' || typeof parsed.expiresAt !== 'string') {
      window.sessionStorage.removeItem(key);
      return null;
    }
    if (Number.isNaN(Date.parse(parsed.expiresAt)) || Date.parse(parsed.expiresAt) <= Date.now()) {
      window.sessionStorage.removeItem(key);
      return null;
    }
    return { url: parsed.url, expiresAt: parsed.expiresAt };
  } catch {
    window.sessionStorage.removeItem(key);
    return null;
  }
}

function writeStoredShareLink(key: string, value: StoredShareLink): void {
  if (typeof window === 'undefined') return;

  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.warn('[TestingTab] Failed to persist preview link:', err);
  }
}

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

interface TestResult {
  message_id: string;
  status: string;
}

function WebhookTestingPanel({ instance }: { instance: ChannelInstance }) {
  const t = useTranslations('channels.testing');
  const [message, setMessage] = useState(DEFAULT_TEST_MESSAGE);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);

  const handleSend = useCallback(async () => {
    if (!message.trim()) return;
    setSending(true);
    setResult(null);

    try {
      const response = await sendTestMessage({
        subscription_id: instance._sourceId,
        message: message.trim(),
      });
      setResult({ message_id: response.message_id, status: response.status });
      toast.success(t('success_sent'));
    } catch (err) {
      toast.error(sanitizeError(err, t('send_failed')));
    } finally {
      setSending(false);
    }
  }, [message, instance._sourceId]);

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <Input
          label={t('message_label')}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={t('message_placeholder')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !sending) {
              handleSend().catch((err) => console.warn('[TestingTab] Send failed:', err));
            }
          }}
        />
        <Button
          variant="primary"
          size="md"
          loading={sending}
          icon={<Send className="w-4 h-4" />}
          onClick={() => {
            handleSend().catch((err) => console.warn('[TestingTab] Send failed:', err));
          }}
          disabled={!message.trim()}
        >
          {t('send_test_message')}
        </Button>
      </div>

      {result && (
        <div className="p-3 rounded-lg bg-success-subtle border border-success/20">
          <p className="text-sm font-medium text-success mb-1">{t('message_sent_title')}</p>
          <div className="space-y-0.5 text-xs text-success">
            <p>
              <span className="font-medium">{t('message_id_label')}</span>{' '}
              <span className="font-mono">{result.message_id}</span>
            </p>
            <p>
              <span className="font-medium">{t('status_label')}</span> {result.status}
            </p>
          </div>
        </div>
      )}

      <p className="text-xs text-muted">{t('webhook_hint')}</p>
    </div>
  );
}

// =============================================================================
// SDK WEB TESTING PANEL — Preview Links + Embed Code
// =============================================================================

function SdkWebTestingPanel({
  projectId,
  instance,
}: {
  projectId: string;
  instance: ChannelInstance;
}) {
  const t = useTranslations('channels.testing');
  const tenantId = useAuthStore((s) => s.tenantId);
  const { navigate } = useNavigationStore();
  const savedConfig = useMemo(() => parseSDKConfig(instance.config), [instance.config]);
  const chatShareStorageKey = useMemo(
    () => buildShareLinkStorageKey(projectId, instance._sourceId, 'chat'),
    [instance._sourceId, projectId],
  );
  const voiceShareStorageKey = useMemo(
    () => buildShareLinkStorageKey(projectId, instance._sourceId, 'voice'),
    [instance._sourceId, projectId],
  );

  // ── Chat preview link state ─────────────────────────────────────────────
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareExpiry, setShareExpiry] = useState<string | null>(null);
  const [generatingLink, setGeneratingLink] = useState(false);
  const [previewCopied, setPreviewCopied] = useState(false);

  // ── Voice preview link state ────────────────────────────────────────────
  const [voiceShareUrl, setVoiceShareUrl] = useState<string | null>(null);
  const [voiceShareExpiry, setVoiceShareExpiry] = useState<string | null>(null);
  const [generatingVoiceLink, setGeneratingVoiceLink] = useState(false);
  const [voicePreviewCopied, setVoicePreviewCopied] = useState(false);

  // ── Voice capability checks ─────────────────────────────────────────────
  const [livekitAvailable, setLivekitAvailable] = useState<boolean | null>(null);
  const [hasSTTCreds, setHasSTTCreds] = useState<boolean | null>(null);
  const [hasTTSCreds, setHasTTSCreds] = useState<boolean | null>(null);
  const [hasRealtimeModel, setHasRealtimeModel] = useState<boolean | null>(null);
  const [voiceCredsLoading, setVoiceCredsLoading] = useState(false);
  const [realtimeModelLoading, setRealtimeModelLoading] = useState(false);

  // ── Embed code state ────────────────────────────────────────────────────
  const [embedCode, setEmbedCode] = useState('');
  const [embedError, setEmbedError] = useState<string | null>(null);
  const [embedLoading, setEmbedLoading] = useState(false);

  // ── Derived flags ───────────────────────────────────────────────────────
  const savedVoiceEnabled =
    savedConfig.voiceEnabled || savedConfig.mode === 'voice' || savedConfig.mode === 'unified';
  const savedIsRealtimeMode = savedConfig.voicePipeline === 'realtime';
  const voiceCredsMissing =
    savedVoiceEnabled && !savedIsRealtimeMode && (hasSTTCreds === false || hasTTSCreds === false);
  const realtimeModelMissing =
    savedVoiceEnabled && savedIsRealtimeMode && hasRealtimeModel === false;

  // ── Fetch embed code on mount ───────────────────────────────────────────
  useEffect(() => {
    setEmbedLoading(true);
    setEmbedError(null);
    fetchSdkEmbedCode(projectId, instance._sourceId)
      .then((snippet) => setEmbedCode(snippet))
      .catch((err) => {
        console.warn('[TestingTab] Failed to load embed code:', err);
        setEmbedCode('');
        setEmbedError(sanitizeError(err, SDK_EMBED_FETCH_ERROR));
      })
      .finally(() => setEmbedLoading(false));
  }, [instance._sourceId, instance.config, projectId]);

  // ── Restore generated share links when returning to the Testing tab ─────
  useEffect(() => {
    const storedChatLink = readStoredShareLink(chatShareStorageKey);
    setShareUrl(storedChatLink?.url ?? null);
    setShareExpiry(storedChatLink?.expiresAt ?? null);

    const storedVoiceLink = readStoredShareLink(voiceShareStorageKey);
    setVoiceShareUrl(storedVoiceLink?.url ?? null);
    setVoiceShareExpiry(storedVoiceLink?.expiresAt ?? null);
  }, [chatShareStorageKey, voiceShareStorageKey]);

  // ── Check LiveKit for voice-enabled channels ────────────────────────────
  useEffect(() => {
    if (!savedVoiceEnabled) return;
    apiFetch('/api/livekit/capabilities')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setLivekitAvailable(data?.configured ?? false))
      .catch((err) => {
        console.warn('[TestingTab] Failed to check LiveKit capabilities:', err);
        setLivekitAvailable(false);
      });
  }, [savedVoiceEnabled]);

  // ── Check voice service credentials ─────────────────────────────────────
  useEffect(() => {
    if (!savedVoiceEnabled || !tenantId) return;
    setVoiceCredsLoading(true);
    const sttServiceType = savedConfig.asrVendor || 'deepgram';
    const ttsServiceType = savedConfig.ttsVendor || 'elevenlabs';
    const sttServiceInstanceId = savedConfig.asrServiceInstanceId as string | undefined;
    const ttsServiceInstanceId = savedConfig.ttsServiceInstanceId as string | undefined;

    Promise.all([
      apiFetch(
        sttServiceInstanceId
          ? `/api/service-instances/${encodeURIComponent(sttServiceInstanceId)}?tenantId=${tenantId}`
          : `/api/service-instances?tenantId=${tenantId}&serviceType=${encodeURIComponent(sttServiceType)}`,
      )
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (sttServiceInstanceId) {
            setHasSTTCreds(Boolean(data?.instance));
            return;
          }
          const items = data?.instances || data?.serviceInstances || [];
          setHasSTTCreds(items.length > 0);
        })
        .catch((err) => {
          console.warn('[TestingTab] Failed to check STT credentials:', err);
          setHasSTTCreds(false);
        }),
      apiFetch(
        ttsServiceInstanceId
          ? `/api/service-instances/${encodeURIComponent(ttsServiceInstanceId)}?tenantId=${tenantId}`
          : `/api/service-instances?tenantId=${tenantId}&serviceType=${encodeURIComponent(ttsServiceType)}`,
      )
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (ttsServiceInstanceId) {
            setHasTTSCreds(Boolean(data?.instance));
            return;
          }
          const items = data?.instances || data?.serviceInstances || [];
          setHasTTSCreds(items.length > 0);
        })
        .catch((err) => {
          console.warn('[TestingTab] Failed to check TTS credentials:', err);
          setHasTTSCreds(false);
        }),
    ]).finally(() => setVoiceCredsLoading(false));
  }, [
    savedConfig.asrServiceInstanceId,
    savedConfig.asrVendor,
    savedConfig.ttsServiceInstanceId,
    savedConfig.ttsVendor,
    savedVoiceEnabled,
    tenantId,
  ]);

  // ── Check for realtime-voice-capable models ─────────────────────────────
  useEffect(() => {
    if (!savedVoiceEnabled || !tenantId) return;
    setRealtimeModelLoading(true);
    apiFetch(`/api/tenant-models?tenantId=${tenantId}&isActive=true`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const models = data?.models || [];
        const hasRealtime = models.some(
          (m: any) =>
            m.isActive &&
            Array.isArray(m.capabilities) &&
            m.capabilities.includes('realtime_voice'),
        );
        setHasRealtimeModel(hasRealtime);
      })
      .catch((err) => {
        console.warn('[TestingTab] Failed to check realtime model availability:', err);
        setHasRealtimeModel(false);
      })
      .finally(() => setRealtimeModelLoading(false));
  }, [savedVoiceEnabled, tenantId]);

  // ── Generate chat preview link ──────────────────────────────────────────
  const generateSecureLink = async () => {
    setGeneratingLink(true);
    try {
      const response = await apiFetch('/api/sdk/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          channelId: instance._sourceId,
          expiresIn: SHARE_LINK_EXPIRY_MS,
        }),
      });
      if (response.ok) {
        const data = await response.json();
        setShareUrl(data.shareUrl);
        setShareExpiry(data.expiresAt);
        writeStoredShareLink(chatShareStorageKey, {
          url: data.shareUrl,
          expiresAt: data.expiresAt,
        });
      } else {
        toast.error(t('error_preview'));
      }
    } catch {
      toast.error(t('error_preview'));
    } finally {
      setGeneratingLink(false);
    }
  };

  // ── Generate voice preview link ─────────────────────────────────────────
  const generateVoiceShareLink = async () => {
    setGeneratingVoiceLink(true);
    try {
      const response = await apiFetch('/api/sdk/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          channelId: instance._sourceId,
          expiresIn: SHARE_LINK_EXPIRY_MS,
        }),
      });
      if (response.ok) {
        const data = await response.json();
        const url = new URL(data.shareUrl);
        url.pathname = savedIsRealtimeMode ? '/preview' : '/preview-livekit';
        url.searchParams.set('mode', 'voice');
        const voiceUrl = url.toString();
        setVoiceShareUrl(voiceUrl);
        setVoiceShareExpiry(data.expiresAt);
        writeStoredShareLink(voiceShareStorageKey, {
          url: voiceUrl,
          expiresAt: data.expiresAt,
        });
      } else {
        toast.error(t('error_voice_preview'));
      }
    } catch {
      toast.error(t('error_voice_preview'));
    } finally {
      setGeneratingVoiceLink(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* ── Secure Preview Link (Chat) ─────────────────────────────────── */}
      <div className="p-4 bg-info-subtle border border-info rounded-lg">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Lock className="w-4 h-4 text-info" />
            <h4 className="text-sm font-medium text-info">{t('secure_preview_title')}</h4>
          </div>
          {!shareUrl ? (
            <Button
              variant="primary"
              size="sm"
              onClick={generateSecureLink}
              loading={generatingLink}
              icon={generatingLink ? undefined : <Plus className="w-3 h-3" />}
              className="bg-accent hover:bg-accent"
            >
              {t('generate_link')}
            </Button>
          ) : (
            <button
              onClick={() => copyText(shareUrl, setPreviewCopied)}
              className="flex items-center gap-2 px-3 py-1.5 bg-info-subtle text-info text-xs font-medium rounded-lg hover:bg-info-subtle transition-default"
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
              <code className="flex-1 px-3 py-2 bg-background border border-default rounded-lg text-sm text-info font-mono truncate">
                {shareUrl}
              </code>
              <a
                href={shareUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="p-2 bg-background-subtle text-muted rounded-lg hover:bg-background-muted transition-default"
                title={t('open_preview')}
              >
                <ExternalLink className="w-4 h-4" />
              </a>
            </div>
            <button
              onClick={generateSecureLink}
              className="mt-2 text-xs text-info hover:text-info transition-colors"
            >
              {t('generate_new_link')}
            </button>
          </>
        )}
      </div>

      {/* ── Voice Preview ──────────────────────────────────────────────── */}
      {savedVoiceEnabled && !savedIsRealtimeMode && livekitAvailable === null && (
        <div className="p-4 flex items-center gap-2 text-muted">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-xs">{t('checking_livekit')}</span>
        </div>
      )}
      {savedVoiceEnabled && !savedIsRealtimeMode && livekitAvailable === false && (
        <div className="p-4 bg-background-muted/50 border border-default/50 rounded-lg">
          <div className="flex items-center gap-2 mb-2">
            <Mic className="w-4 h-4 text-muted" />
            <h4 className="text-sm font-medium text-muted">{t('voice_preview_title')}</h4>
          </div>
          <p className="text-xs text-muted">{t('livekit_not_configured')}</p>
        </div>
      )}
      {savedVoiceEnabled && (savedIsRealtimeMode || livekitAvailable === true) && (
        <div className="p-4 bg-success-subtle border border-success rounded-lg">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Mic className="w-4 h-4 text-success" />
              <h4 className="text-sm font-medium text-success">
                {savedIsRealtimeMode ? t('voice_preview_realtime') : t('voice_preview_pipeline')}
              </h4>
            </div>
            {!voiceShareUrl ? (
              <Button
                variant="primary"
                size="sm"
                onClick={generateVoiceShareLink}
                loading={generatingVoiceLink}
                disabled={savedIsRealtimeMode ? hasRealtimeModel === false : !!voiceCredsMissing}
                icon={generatingVoiceLink ? undefined : <Plus className="w-3 h-3" />}
                className="bg-success hover:bg-success"
                title={
                  savedIsRealtimeMode && hasRealtimeModel === false
                    ? t('realtime_model_required_tooltip')
                    : voiceCredsMissing
                      ? t('voice_creds_required_tooltip')
                      : undefined
                }
              >
                {t('generate_link')}
              </Button>
            ) : (
              <button
                onClick={() => copyText(voiceShareUrl, setVoicePreviewCopied)}
                className="flex items-center gap-2 px-3 py-1.5 bg-success-subtle text-success text-xs font-medium rounded-lg hover:bg-success-subtle transition-default"
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
          {!savedIsRealtimeMode && voiceCredsMissing && (
            <p className="text-xs text-warning mb-2">
              {t('voice_creds_required')}{' '}
              <button
                onClick={() => navigate('/admin/voice')}
                className="underline hover:no-underline"
              >
                {t('configure_now')}
              </button>
            </p>
          )}
          {savedIsRealtimeMode && hasRealtimeModel === false && (
            <p className="text-xs text-warning mb-2">
              {t('realtime_model_required')}{' '}
              <button
                onClick={() => navigate('/admin/models')}
                className="underline hover:no-underline"
              >
                {t('configure_now')}
              </button>
            </p>
          )}
          {!voiceShareUrl ? (
            <p className="text-xs text-muted">{t('voice_preview_description')}</p>
          ) : (
            <>
              <p className="text-xs text-muted mb-2">
                {t('preview_expires', { date: new Date(voiceShareExpiry!).toLocaleDateString() })}
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 px-3 py-2 bg-background border border-default rounded-lg text-sm text-success font-mono truncate">
                  {voiceShareUrl}
                </code>
                <a
                  href={voiceShareUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="p-2 bg-background-subtle text-muted rounded-lg hover:bg-background-muted transition-default"
                  title={t('open_voice_preview')}
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
      )}

      {/* ── Embed Code ─────────────────────────────────────────────────── */}
      <div className="bg-background-elevated border border-default rounded-lg p-4">
        <h4 className="text-sm font-semibold text-foreground mb-4">{t('embed_code_title')}</h4>

        {embedLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 text-muted animate-spin" />
          </div>
        ) : embedError ? (
          <div className="flex items-start gap-3 rounded-lg border border-warning bg-warning-subtle p-4">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <p className="text-sm text-warning">{embedError}</p>
          </div>
        ) : (
          <>
            <CodeBlock code={embedCode} language="html" />
            <div className="mt-4 p-3 rounded-lg bg-accent-subtle border border-accent/20">
              <h4 className="text-sm font-medium text-foreground mb-1">{t('quick_start_title')}</h4>
              <ol className="space-y-0.5 text-xs text-muted">
                <li>{t('quick_start_step1')}</li>
                <li>{t('quick_start_step2')}</li>
                <li>
                  {t('quick_start_step3_prefix')} <code className="text-muted">&lt;/body&gt;</code>{' '}
                  {t('quick_start_step3_suffix')}
                </li>
                <li>{t('quick_start_step4')}</li>
              </ol>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SdkPlaceholderPanel() {
  const t = useTranslations('channels.testing');
  return (
    <EmptyState
      icon={<Send className="w-6 h-6" />}
      title={t('not_available_title')}
      description={t('not_available_sdk')}
    />
  );
}

function ChannelConnectionPlaceholder({ channelDef }: { channelDef: ChannelTypeDef }) {
  const t = useTranslations('channels.testing');
  return (
    <EmptyState
      icon={<Send className="w-6 h-6" />}
      title={t('coming_soon_title')}
      description={t('coming_soon_description', { name: channelDef.name })}
    />
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

export function TestingTab({ projectId, channelType, channelDef, instance }: ChannelTabProps) {
  if (instance._source === 'webhook_subscription') {
    return <WebhookTestingPanel instance={instance} />;
  }

  if (instance._source === 'sdk_channel') {
    if (channelType === 'sdk_web') {
      return <SdkWebTestingPanel projectId={projectId} instance={instance} />;
    }
    return <SdkPlaceholderPanel />;
  }

  if (instance._source === 'channel_connection') {
    return <ChannelConnectionPlaceholder channelDef={channelDef} />;
  }

  return <TestingNotAvailable />;
}

function TestingNotAvailable() {
  const t = useTranslations('channels.testing');
  return (
    <EmptyState
      icon={<Send className="w-6 h-6" />}
      title={t('not_available_title')}
      description={t('not_available_generic')}
    />
  );
}
